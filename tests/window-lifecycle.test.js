'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { liveContents, isTrustedSender, sendToWindow } = require('../electron/window-lifecycle');
const { createWebPanel } = require('../electron/web-panel');

test('销毁窗口和销毁 frame 的 getter 不会破坏活窗口 IPC，外部来源仍被拒绝', () => {
  const sender = { id: 1, isDestroyed: () => false, send() {} };
  const live = { isDestroyed: () => false, webContents: sender };
  const dead = { isDestroyed: () => true, get webContents() { throw Error('Object has been destroyed'); } };
  const event = { sender, senderFrame: { url: 'http://localhost:3000/' } };
  assert.equal(isTrustedSender(event, [live, dead], 'http://localhost:3000'), true);
  assert.equal(liveContents(dead), null); assert.equal(sendToWindow(dead, 'test', {}), false);
  assert.equal(isTrustedSender({ ...event, get senderFrame() { throw Error('Frame disposed'); } }, [live], 'http://localhost:3000'), false);
  assert.equal(isTrustedSender({ ...event, senderFrame: { url: 'https://example.com/' } }, [live], 'http://localhost:3000'), false);
  assert.equal(isTrustedSender({ ...event, sender: { isDestroyed: () => true, get id() { throw Error('Destroyed'); } } }, [live], 'http://localhost:3000'), false);
});

test('网页加载中关闭窗口取消等待；迟到回调、重复销毁和布局通知均不触碰已销毁对象', async () => {
  const window = new EventEmitter(); let dead = false, view, messages = 0;
  const contents = { isDestroyed: () => dead, send() { messages++; } };
  Object.assign(window, { isDestroyed: () => dead, isVisible: () => true, getContentSize: () => [1180, 840], contentView: { addChildView(value) { view = value; } } });
  Object.defineProperty(window, 'webContents', { get() { if (dead) throw Error('Object has been destroyed'); return contents; } });
  const isolated = new EventEmitter();
  Object.assign(isolated, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } });
  class View {
    constructor() {
      this.webContents = new EventEmitter(); let closed = false;
      Object.assign(this.webContents, { isDestroyed: () => closed, close() { closed = true; }, setAudioMuted() {}, setWindowOpenHandler() {}, loadURL: () => new Promise(() => {}), stop() { if (closed) throw Error('Destroyed contents'); }, getURL() { throw Error('Late URL access'); }, getTitle() { throw Error('Late title access'); } });
    }
    setVisible() {} setBounds() {}
  }
  const panel = createWebPanel({ window, WebContentsView: View, session: { fromPartition: () => isolated }, allowed: () => true });
  const loading = panel.open('https://example.com/');
  const rejected = assert.rejects(loading, /窗口已关闭/);
  const beforeClose = messages;
  dead = true; window.emit('closed');
  await rejected;
  assert.doesNotThrow(() => view.webContents.emit('did-finish-load'));
  assert.doesNotThrow(() => { panel.setLayout({ visible: true, x: 0, y: 0, width: 100, height: 100 }); window.emit('resize'); panel.destroy(); });
  assert.equal(messages, beforeClose);
  await assert.rejects(panel.open('https://example.com/'), /窗口已关闭/);
  await assert.rejects(panel.control('reload'), /窗口已关闭/);
});
