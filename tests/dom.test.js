const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('真实 HUD DOM 绑定、跨块中文回复、历史列表与失败恢复', async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { url: 'http://localhost:3000', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;
  const id = '11111111-1111-4111-8111-111111111111';
  let history = [{ role: 'user', content: '之前的问题' }, { role: 'assistant', content: '之前的回复' }];
  let posted;
  let fail = false;
  const result = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, options) => {
    if (url === '/api/health') return result({ status: 'ok', version: '1.2.0', apiVersion: 2 });
    if (url === '/api/capabilities') return result({ web: true, computer: true });
    if (url === '/api/skills') return result({ skills: [] });
    if (url === '/api/session') return result({ sessionId: id });
    if (url === '/api/sessions') return result({ sessions: [{ id, title: '之前的问题' }] });
    if (url === '/api/history/' + id) return result({ messages: history });
    if (url === '/api/chat') {
      posted = JSON.parse(options.body);
      const bytes = Buffer.from(fail ? 'data: {"error":"模型服务离线"}\n\ndata: [DONE]\n\n' : 'data: {"content":"中文跨块回复"}\n\ndata: [DONE]\n\n');
      if (!fail) history.push({ role: 'user', content: posted.message }, { role: 'assistant', content: '中文跨块回复' });
      return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
    }
    throw new Error('Unexpected URL: ' + url);
  };
  window.TextDecoder = TextDecoder; window.AbortSignal = AbortSignal; window.AbortController = AbortController;
  window.localStorage.setItem('lewis_settings', JSON.stringify({ autoTts: false, autoMic: false, autoCamera: false, visionEnabled: false, apiKey: 'ui-key', modelName: 'ui-model' }));
  window.eval(fs.readFileSync(path.join(__dirname, '../public/js/appearance.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../public/js/http.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../public/js/voice.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../public/js/speech.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8') + '\nwindow.testApi = { ready: () => sessionReady, send: sendSuggestion, voiceText: text => voice.onText(text), getId: () => sessionId, getSending: () => isSending, getKey: () => settings.apiKey, setKey: key => { settings.apiKey = key; } };');
  for (let i = 0; i < 20 && !window.testApi.ready(); i++) await delay(10);
  await window.testApi.ready();
  assert.equal(window.document.querySelectorAll('.message').length, 2);
  assert.equal(window.document.getElementById('historySessions').value, id);
  await window.testApi.send('新问题');
  assert.equal(window.document.querySelector('.message:last-child .message-bubble').textContent, '中文跨块回复');
  assert.equal(posted.settings.apiKey, 'ui-key'); assert.equal(posted.settings.modelName, 'ui-model');
  assert.equal(window.testApi.getSending(), false);
  // 语音不请求焦点；键盘回复也只在页面仍持有焦点且可见时恢复输入。
  let focusCalls = 0;
  const input = window.document.getElementById('messageInput'); input.focus = () => { focusCalls++; };
  Object.defineProperty(window.document, 'hidden', { configurable: true, value: false });
  window.document.hasFocus = () => true;
  await window.testApi.voiceText('李维斯，继续说话'); assert.equal(focusCalls, 0);
  await window.testApi.send('前台键盘回复'); assert.equal(focusCalls, 1);
  window.document.hasFocus = () => false;
  await window.testApi.send('等待回复时切换到别的应用'); assert.equal(focusCalls, 1);
  window.document.hasFocus = () => true;
  Object.defineProperty(window.document, 'hidden', { configurable: true, value: true });
  await window.testApi.send('窗口已隐藏'); assert.equal(focusCalls, 1);
  // 保存无效 Key 时保持已有设置，防止一次失败保存污染后续请求。
  const savedSettings = window.localStorage.getItem('lewis_settings');
  window.document.getElementById('apiKey').value = 'sk-你的APIKey';
  window.document.getElementById('saveSettingsBtn').click();
  assert.match(window.document.getElementById('voiceStatus').textContent, /API Key.*中文/);
  assert.equal(window.localStorage.getItem('lewis_settings'), savedSettings);
  assert.equal(window.testApi.getKey(), 'ui-key');
  // 模拟旧版本缓存的占位值：发送前拦截，保留输入并恢复按钮。
  window.testApi.setKey('sk-你的APIKey');
  const previousPost = posted;
  await window.testApi.send('配置修复后再发');
  assert.strictEqual(posted, previousPost);
  assert.equal(window.document.getElementById('messageInput').value, '配置修复后再发');
  assert.match(window.document.querySelector('.message:last-child .message-bubble').textContent, /API Key/);
  assert.equal(window.document.getElementById('sendBtn').disabled, false);
  window.testApi.setKey('ui-key');
  fail = true; await window.testApi.send('测试离线');
  assert.match(window.document.querySelector('.message:last-child .message-bubble').textContent, /模型服务离线/);
  assert.equal(window.document.getElementById('sendBtn').disabled, false);
  assert.equal(window.document.querySelectorAll('.thinking').length, 0);
  window.document.getElementById('newChatBtn').click(); await window.testApi.ready();
  assert.equal(window.document.querySelectorAll('.message').length, 0);
  await delay(10); window.close();
});
test('旧后端启动时显示明确版本提示，不继续创建会话或解析 HTML 404', async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { url: 'http://localhost:3000', runScripts: 'outside-only' });
  const window = dom.window; const requests = [];
  window.fetch = async url => { requests.push(url); return new Response(JSON.stringify({ version: '1.0.0' }), { headers: { 'Content-Type': 'application/json' } }); };
  for (const name of ['appearance', 'http', 'voice', 'speech', 'app']) window.eval(fs.readFileSync(path.join(__dirname, `../public/js/${name}.js`), 'utf8') + (name === 'app' ? '\nwindow.startupReady = () => sessionReady;' : ''));
  for (let i = 0; i < 20 && !window.startupReady(); i++) await delay(10);
  await assert.rejects(window.startupReady(), /旧版后端 1.0.0/);
  assert.deepEqual(requests, ['/api/health']);
  assert.match(window.document.getElementById('voiceStatus').textContent, /关闭旧/);
  window.close();
});

test('语音停下会取消正在播放的回复，恢复发送按钮和监听，未把停下作为新问题', async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'), { url: 'http://localhost:3000', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window; let callbacks, paused = 0, chatRequests = 0, playing = false; const mic = [];
  const id = '11111111-1111-4111-8111-111111111111';
  window.AbortController = AbortController; window.AbortSignal = AbortSignal;
  window.TextDecoder = TextDecoder; window.TextEncoder = TextEncoder;
  window.URL.createObjectURL = () => 'blob:test'; window.URL.revokeObjectURL = () => {};
  window.Audio = class { async play() { playing = true; } pause() { paused++; } };
  window.LewisVoice = class {
    constructor(options) { callbacks = options; }
    setBusy(value) { this.busy = value; }
    pauseMic() {}
    async setInterruptListening(value) { this.interruptListening = value; mic.push(value); }
  };
  const result = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async url => {
    if (url === '/api/health') return result({ apiVersion: 2 });
    if (url === '/api/session') return result({ sessionId: id });
    if (url === '/api/sessions') return result({ sessions: [] });
    if (url === '/api/history/' + id) return result({ messages: [] });
    if (url === '/api/capabilities') return result({ web: true, computer: true });
    if (url === '/api/skills') return result({ skills: [] });
    if (url === '/api/chat') { chatRequests++; return new Response('data: {"content":"这一段播报会等待用户喊停。"}\n\ndata: [DONE]\n\n'); }
    if (url === '/api/tts') return new Response('audio', { headers: { 'Content-Type': 'audio/mpeg' } });
    throw Error('意外请求 ' + url);
  };
  window.localStorage.setItem('lewis_settings', JSON.stringify({ autoMic: false, autoCamera: false, autoTts: true, apiKey: 'test' }));
  try {
    for (const name of ['appearance', 'http', 'speech', 'app']) window.eval(fs.readFileSync(path.join(__dirname, '../public/js', name + '.js'), 'utf8') + (name === 'app' ? '\nwindow.testApi = { ready: () => sessionReady, sending: () => isSending };' : ''));
    for (let i = 0; i < 20 && !window.testApi.ready(); i++) await delay(10); await window.testApi.ready();
    window.document.getElementById('messageInput').value = '开始回复'; window.document.getElementById('sendBtn').click();
    for (let i = 0; i < 50 && !playing; i++) await delay(10); assert.equal(playing, true); assert.equal(window.testApi.sending(), true);
    callbacks.onInterrupt();
    for (let i = 0; i < 50 && window.testApi.sending(); i++) await delay(10);
    assert.equal(window.testApi.sending(), false); assert.equal(window.document.getElementById('sendBtn').disabled, false);
    assert.ok(paused > 0); assert.equal(mic[0], true); assert.equal(mic.at(-1), false); assert.equal(chatRequests, 1);
    playing = false;
    const proactive = window.lewisProactiveSay('我看到你拿起杯子了，休息一会儿？');
    for (let i = 0; i < 50 && !playing; i++) await delay(10); assert.equal(playing, true);
    assert.match(window.document.querySelector('.message:last-child .message-bubble').textContent, /拿起杯子/);
    callbacks.onInterrupt(); assert.equal(await proactive, true);
    assert.equal(window.testApi.sending(), false); assert.equal(chatRequests, 1); assert.equal(mic.at(-1), false);
  } finally { window.close(); }
});
