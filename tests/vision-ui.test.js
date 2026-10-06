const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = name => fs.readFileSync(path.join(__dirname, '../public/js', name + '.js'), 'utf8');

test('自动摄像头/持续聆听启动，视觉配置每轮附图；关闭摄像头后不发旧画面', async () => {
  const dom = new JSDOM(html, { url: 'http://localhost:3000', runScripts: 'outside-only' }); const window = dom.window;
  const actions = [], posted = []; let camera = false;
  const id = '11111111-1111-4111-8111-111111111111';
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, options) => {
    if (url === '/api/health') return json({ apiVersion: 2, version: '1.2.0' });
    if (url === '/api/session') return json({ sessionId: id });
    if (url === '/api/sessions') return json({ sessions: [] });
    if (url === '/api/history/' + id) return json({ messages: [] });
    if (url === '/api/capabilities') return json({ web: true, computer: true });
    if (url === '/api/skills') return json({ skills: [] });
    if (url === '/api/chat') { posted.push(JSON.parse(options.body)); return new Response('data: {"content":"视觉回复"}\n\ndata: [DONE]\n\n'); }
    throw new Error('Unexpected URL ' + url);
  };
  window.TextDecoder = TextDecoder;
  window.LewisVoice = class { constructor() { this.continuousEnabled = false; } async toggleContinuous(enabled) { this.continuousEnabled = enabled; actions.push('mic'); } setBusy() {} async destroy() {} };
  window.lewisVision = { start: async () => { camera = true; actions.push('camera'); }, stop: () => { camera = false; }, snapshot: () => camera ? 'data:image/jpeg;base64,/9j/2Q==' : null };
  window.localStorage.setItem('lewis_settings', JSON.stringify({ autoTts: false, visionApiBaseUrl: 'https://example.com/v1', visionApiKey: 'vision-test-key' }));
  window.eval(script('appearance')); window.eval(script('speech')); window.eval(script('http')); window.eval(script('app') + '\nwindow.testApi = { ready: () => sessionReady, send: sendSuggestion };');
  for (let i = 0; i < 30 && !window.testApi.ready(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  await window.testApi.ready(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(actions, ['camera','mic']);
  await window.testApi.send('看我手里有什么'); assert.equal(posted[0].image, 'data:image/jpeg;base64,/9j/2Q==');
  window.lewisVision.stop(); await window.testApi.send('摄像头关闭了'); assert.equal(posted[1].image, undefined);
  window.close();
});

test('摄像头权限等待期间关闭，迟到的流被释放，不再开启画面', async () => {
  const dom = new JSDOM(html, { url: 'http://localhost:3000', runScripts: 'outside-only' }); const window = dom.window;
  let resolve, stopped = 0;
  Object.defineProperty(window.navigator, 'mediaDevices', { value: { getUserMedia: () => new Promise(r => { resolve = r; }) } });
  window.eval(script('gestures')); window.eval(script('vision'));
  const pending = window.lewisVision.start(); window.lewisVision.stop();
  resolve({ getTracks: () => [{ stop: () => { stopped++; } }] }); await pending;
  assert.equal(stopped, 1); assert.equal(window.lewisVision.isActive(), false); assert.equal(window.document.getElementById('visionPanel').hidden, true);
  window.close();
});

test('桌面后台唤醒迁移、等待服务时暂停、托盘恢复与保存后保留自选模式', async () => {
  const dom = new JSDOM(html, { url: 'http://localhost:3000', runScripts: 'outside-only' }); const window = dom.window;
  const actions = []; let voice, receive, ready;
  const preparation = new Promise(resolve => { ready = resolve; });
  const id = '11111111-1111-4111-8111-111111111111';
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async url => {
    if (url === '/api/health') return json({ apiVersion: 2 });
    if (url === '/api/session') return json({ sessionId: id });
    if (url === '/api/sessions') return json({ sessions: [] });
    if (url === '/api/history/' + id) return json({ messages: [] });
    if (url === '/api/capabilities') return json({ web: true, computer: true });
    if (url === '/api/skills') return json({ skills: [] });
    throw new Error('Unexpected URL ' + url);
  };
  window.LewisVoice = class {
    constructor(options) { voice = this; this.options = options; }
    async toggleWake(enabled) { actions.push(['wake', enabled]); }
    async toggleContinuous(enabled) { actions.push(['continuous', enabled]); }
    async destroy() {}
  };
  window.electronAPI = { voiceReady: () => preparation, onMessage: callback => { receive = callback; }, showPet: () => actions.push('show'), publish: data => { if (data.type === 'wake') actions.push('wake-message'); } };
  window.localStorage.setItem('lewis_settings', JSON.stringify({ autoMic: false, autoCamera: false, startupVoiceMode: 'continuous' }));
  try {
    window.eval(script('appearance')); window.eval(script('speech')); window.eval(script('http')); window.eval(script('app') + '\nwindow.testApi = { ready: () => sessionReady, save: saveSettings, load: loadSettings };');
    for (let i = 0; i < 30 && !window.testApi.ready(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    await window.testApi.ready(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(actions, []);
    assert.equal(JSON.parse(window.localStorage.getItem('lewis_settings')).desktopWakeConfigured, true);
    await receive({ type: 'pause-listening' }); ready(true); await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(actions, [['wake', false]]); // 迟到的服务就绪不会重新开启麦克风。
    await receive({ type: 'background-listen' }); assert.deepEqual(actions.at(-1), ['wake', true]);
    voice.options.onWake(); assert.deepEqual(actions.slice(-2), ['show', 'wake-message']);
    assert.equal(window.document.getElementById('startupVoiceMode').value, 'wake');
    window.document.getElementById('startupVoiceMode').value = 'continuous'; await window.testApi.save();
    assert.equal(JSON.parse(window.localStorage.getItem('lewis_settings')).startupVoiceMode, 'continuous');
    window.testApi.load(); assert.equal(window.document.getElementById('startupVoiceMode').value, 'continuous');
  } finally { window.close(); }
});

test('问能否看见我时，视觉未配置直接定位设置，不请求文字模型；配置后自动等待最新画面', async () => {
  const dom = new JSDOM(html, { url: 'http://localhost:3000', runScripts: 'outside-only' }); const window = dom.window;
  const posted = []; let releaseFrame;
  const id = '11111111-1111-4111-8111-111111111111'; const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, options) => {
    if (url === '/api/health') return json({ apiVersion: 2 });
    if (url === '/api/session') return json({ sessionId: id });
    if (url === '/api/sessions') return json({ sessions: [] });
    if (url === '/api/history/' + id) return json({ messages: [] });
    if (url === '/api/capabilities') return json({ web: true, computer: true });
    if (url === '/api/skills') return json({ skills: [] });
    if (url === '/api/chat') { posted.push(JSON.parse(options.body)); return new Response('data: {"content":"我看到了当前画面"}\n\ndata: [DONE]\n\n'); }
    throw Error('Unexpected URL ' + url);
  };
  window.TextDecoder = TextDecoder;
  window.LewisVoice = class { setBusy() {} };
  window.localStorage.setItem('lewis_settings', JSON.stringify({ autoMic: false, autoCamera: false, autoTts: false, apiKey: 'text-key' }));
  try {
    window.eval(script('appearance')); window.eval(script('speech')); window.eval(script('http')); window.eval(script('vision-config')); window.eval(script('app') + '\nwindow.testApi = { ready: () => sessionReady, send: sendSuggestion, load: loadSettings, save: saveSettings };');
    for (let i = 0; i < 30 && !window.testApi.ready(); i++) await new Promise(resolve => setTimeout(resolve, 10)); await window.testApi.ready();
    await window.testApi.send('你能看到我吗'); assert.equal(posted.length, 0); assert.equal(window.document.getElementById('settingsPanel').classList.contains('open'), true);
    assert.match(window.document.getElementById('visionChatStatus').textContent, /AI 视觉未配置/);
    assert.equal(window.document.getElementById('seeMeBtn'), null);
    window.document.getElementById('visionApiBaseUrl').value='https://example.com/v1'; window.document.getElementById('visionApiKey').value='vision-key'; await window.testApi.save();
    window.lewisVision = { capture: async options => { assert.equal(options.startCamera, true); return new Promise(resolve => { releaseFrame = resolve; }); } };
    const pending = window.testApi.send('你能看到我吗');
    for (let i = 0; i < 20 && !releaseFrame; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(posted.length, 0);
    releaseFrame('data:image/jpeg;base64,/9j/2Q=='); await pending; assert.equal(posted[0].image, 'data:image/jpeg;base64,/9j/2Q==');
  } finally { window.close(); }
});
