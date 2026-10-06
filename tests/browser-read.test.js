'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { resolvePublicTarget, createPublicWebProxy } = require('../lib/public-web-proxy');
const { PAGE_READ_SCRIPT } = require('../lib/page-observation');
const { createWebPanel } = require('../electron/web-panel');

test('动态浏览拒绝私网 DNS、混合 DNS 与保留地址；实际连接固定已核验 IP', async () => {
  for (const url of ['http://localhost/', 'https://10.0.0.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'http://169.254.169.254/', 'http://example.com:3000/']) await assert.rejects(resolvePublicTarget(url));
  await assert.rejects(resolvePublicTarget('https://public.test/', async () => [{ address: '8.8.8.8', family: 4 }, { address: '192.168.1.1', family: 4 }]));
  let permitted = true, calls = 0, forwarded = 0;
  const fixture = http.createServer((req, res) => { assert.equal(req.headers.host, 'public.test'); res.end('renderable'); });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const proxy = createPublicWebProxy({ allowed: () => permitted, lookup: async () => [{ address: ++calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }], request: (options, callback) => { forwarded++; assert.equal(options.hostname, '8.8.8.8'); return http.request({ ...options, hostname: '127.0.0.1', port: fixture.address().port }, callback); } });
  const address = await proxy.start();
  const through = path => new Promise((resolve, reject) => { const req = http.get({ hostname: '127.0.0.1', port: Number(address.split(':')[1]), path }, res => { let text = ''; res.on('data', part => { text += part; }); res.on('end', () => resolve({ code: res.statusCode, text })); }); req.on('error', reject); });
  try {
    assert.deepEqual(await through('http://public.test/'), { code: 200, text: 'renderable' });
    assert.equal((await through('http://public.test/')).code, 403); assert.equal(forwarded, 1);
    permitted = false; assert.equal((await through('http://another.test/')).code, 403); assert.equal(calls, 2);
  } finally { proxy.close(); await new Promise(resolve => fixture.close(resolve)); }
});

test('DOM 读取返回动态正文和来源，排除脚本、隐藏内容、密码及编辑输入', () => {
  const dom = new JSDOM('<title>JS页面</title><main><p id="dynamic"></p><div hidden>秘密隐藏数据</div><input type="password" value="password-secret"><textarea>draft-secret</textarea><script>secret-script</script><a href="/video/1">热门视频</a><img src="/chart.png" alt="月度图表"></main>', { url: 'https://public.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.Element.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}]; };
  dom.window.document.getElementById('dynamic').textContent = '由 JavaScript 加载的热门列表';
  const result = dom.window.eval(PAGE_READ_SCRIPT);
  assert.match(result.text, /JavaScript/); assert.doesNotMatch(result.text, /secret|秘密/);
  assert.equal(result.links[0].url, 'https://public.test/video/1'); assert.equal(result.images[0].alt, '月度图表'); dom.window.close();
});

test('当前已登录页面原位读取，不重新导航；截图是当前网页而非摄像头，权限关闭立即取消', async () => {
  const window = new EventEmitter(); let allowed = true, loads = 0, captures = 0, imageOptions;
  Object.assign(window, { isDestroyed: () => false, isVisible: () => true, getContentSize: () => [1280, 800], contentView: { addChildView() {} }, webContents: { isDestroyed: () => false, send() {} } });
  const isolated = new EventEmitter(); Object.assign(isolated, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } });
  let contents;
  class View {
    constructor() {
      contents = this.webContents = new EventEmitter(); let url = '';
      const image = { isEmpty: () => false, getSize: () => ({ width: 1280 }), resize() { return this; }, toJPEG: () => Buffer.from([255,216,255,217]) };
      Object.assign(contents, { isDestroyed: () => false, close() {}, setAudioMuted() {}, setWindowOpenHandler() {}, getURL: () => url, getTitle: () => '已登录网页', loadURL: async target => { loads++; url = target; contents.emit('did-finish-load'); }, executeJavaScriptInIsolatedWorld: async (world, scripts) => { assert.equal(world, 1010); assert.equal(scripts[0].code, PAGE_READ_SCRIPT); return { title: '已登录网页', url, text: 'JS 渲染的会员页面', links: [], images: [] }; }, capturePage: async (_rect, options) => { captures++; imageOptions = options; return image; } });
    }
    setVisible() {} setBounds() {}
  }
  const panel = createWebPanel({ window, WebContentsView: View, session: { fromPartition: () => isolated }, allowed: () => allowed });
  try {
    await panel.open('https://public.test/');
    const read = await panel.read({ screenshot: true });
    assert.equal(loads, 1); assert.equal(captures, 1); assert.equal(imageOptions.stayHidden, true); assert.match(read.text, /会员/); assert.match(read.image, /^data:image\/jpeg;base64,/);
    const next = panel.read(); allowed = false; await assert.rejects(next, /权限/);
  } finally { panel.destroy(); }
});
