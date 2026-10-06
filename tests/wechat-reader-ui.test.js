const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
test('后台读取面板保存 Token 不写入 localStorage，历史按钮读取数据库且不发送消息', async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { url: 'http://localhost:3000', runScripts: 'outside-only' });
  const w = dom.window, requests = [];
  const config = { baseUrl: 'http://127.0.0.1:6131', hasToken: true, monitor: true, autoAnalyze: true, contacts: 1, scanned: 0, analyses: [], pending: 0 };
  w.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined; requests.push({ url, body });
    let data = config;
    if (url.endsWith('/check')) data = { ready: true, contacts: [{ id: 'wxid-1', name: '好友', type: 'user' }] };
    if (url.endsWith('/history')) data = { text: '数据库历史', messages: [{ datetime: '今天', sender: '好友', type: '文本', text: '新的安排' }] };
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  const script = file => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');
  const waitFor = async predicate => { for (let i = 0; i < 30 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate()); };
  try {
    w.eval(script('http.js')); w.eval(script('wechat-reader.js'));
    await waitFor(() => w.document.getElementById('wechatReaderToken').placeholder.includes('已保存'));
    w.document.getElementById('wechatReaderToken').value = 'LOCAL_SECRET'; w.document.getElementById('wechatReaderSave').click();
    await waitFor(() => w.document.getElementById('wechatReaderToken').value === '');
    assert.ok(requests.some(r => r.body?.token === 'LOCAL_SECRET')); assert.equal(w.localStorage.length, 0);
    w.document.getElementById('wechatReaderCheck').click(); await waitFor(() => w.document.getElementById('wechatHistoryTarget').value === 'wxid-1');
    w.document.getElementById('wechatHistoryRead').click(); await waitFor(() => w.document.getElementById('wechatHistoryResult').textContent.includes('新的安排'));
    assert.equal(requests.at(-1).body.recipient, 'wxid-1'); assert.ok(requests.every(r => !/send|skills/.test(r.url)));
    await w.lewisWechatReader.syncModel({ modelName: 'configured-model' }); assert.equal(requests.at(-1).body.settings.modelName, 'configured-model');
  } finally { w.close(); }
});
