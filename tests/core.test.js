const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { buildContext } = require('../lib/context');
const { consumeSSE } = require('../lib/sse');
const { SessionStore } = require('../lib/session-store');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lewis-core-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('上下文按完整轮次截断，保留系统提示和当前问题，且不修改历史', () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '中'.repeat(200) }));
  const before = JSON.stringify(history);
  const result = buildContext('系统提示', history, '最新问题', 4096, 2000);
  assert.ok(result.estimatedTokens <= result.budget);
  assert.ok(result.droppedMessages > 0);
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages.at(-1).content, '最新问题');
  assert.equal(result.messages.length % 2, 0);
  assert.equal(JSON.stringify(history), before);
  assert.throws(() => buildContext('系统', [], '中'.repeat(5000), 4096), /消息过长/);
});
test('SSE 逐字节分块仍保留中文、usage 和结束标记', async () => {
  const input = Buffer.from('data: {"choices":[{"delta":{"content":"李维斯"}}]}\r\n\r\ndata: {"usage":{"prompt_tokens":12}}\n\ndata: [DONE]\n\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of input) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const events = []; await consumeSSE(stream, event => events.push(event));
  assert.equal(events[0].choices[0].delta.content, '李维斯'); assert.equal(events[1].usage.prompt_tokens, 12);
});
test('SSE 中途断开明确报错', async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('data: {"x":1}\n\n')); controller.close(); } });
  await assert.rejects(consumeSSE(stream, () => {}), /提前结束/);
});
test('会话并行保存后重载，最后快照包含全部消息', async () => {
  const store = new SessionStore(temp); const session = store.get('test');
  session.messages.push({ role: 'user', content: '你好' }); const first = store.save();
  session.messages.push({ role: 'assistant', content: '主人您好' }); const second = store.save();
  await Promise.all([first, second]); assert.equal(new SessionStore(temp).get('test').messages.length, 2);
});

function voiceRuntime() {
  const sandbox = { window: {}, Blob, AbortController, AbortSignal, setTimeout, clearTimeout, Date, navigator: {}, AudioContext: function () {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/voice.js'), 'utf8'), sandbox);
  return sandbox;
}

test('播报时麦克风可识别停止指令，其他识别内容不提交模型，停播后恢复原监听模式', async () => {
  const runtime = voiceRuntime(); const track = { enabled: true }; let stopped = 0, submitted = 0, woken = 0;
  const voice = new runtime.window.LewisVoice({ getSettings: () => ({ autoMic: true }), onState() {}, onText: () => submitted++, onWake: () => woken++, onInterrupt: () => stopped++ });
  voice.ensureMic = async () => { voice.context = { sampleRate: 16000 }; voice.stream = { getAudioTracks: () => [track] }; };
  await voice.toggleWake(true); voice.setBusy(true); assert.equal(track.enabled, false);
  await voice.setInterruptListening(true); assert.equal(track.enabled, true);
  for (const text of ['扬声器中的普通回复', '他说 Lewis 停下', 'Lewis 停下。', '李维斯，停止播报！', '不要让Lewis停下']) {
    voice.hasSpeech = true; voice.samples = 5000; voice.chunks = [new Float32Array(5000)];
    voice.upload = async endpoint => { assert.equal(endpoint, 'asr'); return { text }; };
    await voice.submit('asr');
  }
  assert.equal(stopped, 2); assert.equal(submitted, 0); assert.equal(woken, 0);
  await voice.setInterruptListening(false); assert.equal(track.enabled, false);
  voice.setBusy(false); assert.equal(track.enabled, true); assert.equal(voice.mode, 'wake');
});

test('关闭麦克风或停播会取消迟到的停止识别；拒绝权限不影响按钮停止', async () => {
  const runtime = voiceRuntime(); let resolve, stopped = 0;
  const voice = new runtime.window.LewisVoice({ getSettings: () => ({ autoMic: true }), onState() {}, onInterrupt: () => stopped++ });
  voice.ensureMic = async () => { voice.context = { sampleRate: 16000 }; };
  voice.releaseMic = async () => {};
  voice.wakeEnabled = true; voice.setBusy(true); await voice.setInterruptListening(true);
  voice.hasSpeech = true; voice.samples = 5000; voice.chunks = [new Float32Array(5000)];
  voice.upload = async () => new Promise(r => { resolve = r; }); const pending = voice.submit('asr');
  await voice.toggleWake(false); resolve({ text: 'Lewis 停下' }); await pending;
  assert.equal(stopped, 0); assert.equal(voice.interruptListening, false); assert.equal(voice.processing, false);
  voice.ensureMic = async () => { throw Error('麦克风权限拒绝'); };
  await voice.setInterruptListening(true); assert.equal(voice.interruptListening, false);
});

test('持续对话完成两轮后自动恢复聆听，不需要重复唤醒；暂停会释放麦克风', async () => {
  const runtime = voiceRuntime(); const recognized = [], endpoints = []; const track = { enabled: true, stop() {} };
  let released = 0, voice;
  voice = new runtime.window.LewisVoice({ getSettings: () => ({}), onState: () => {}, onText: async text => { recognized.push(text); voice.setBusy(true); assert.equal(track.enabled, false); voice.setBusy(false); } });
  voice.ensureMic = async () => { voice.context = { sampleRate: 16000 }; voice.stream = { getAudioTracks: () => [track] }; };
  voice.releaseMic = async () => { released++; voice.stream = null; };
  voice.upload = async endpoint => { endpoints.push(endpoint); return endpoint === 'vad' ? { has_voice: true } : { text: '第' + (recognized.length + 1) + '句话' }; };
  await voice.toggleContinuous(true);
  for (let i = 0; i < 2; i++) { voice.chunks = [new Float32Array(5000).fill(0.1)]; voice.samples = 5000; voice.hasSpeech = true; await voice.submit('asr'); assert.equal(voice.mode, 'conversation'); assert.equal(voice.continuousEnabled, true); assert.equal(track.enabled, true); }
  assert.deepEqual(recognized, ['第1句话','第2句话']); assert.deepEqual(endpoints, ['vad','asr','vad','asr']);
  await voice.toggleContinuous(false); assert.equal(voice.mode, 'off'); assert.equal(released, 1);
});

test('持续对话的 VAD 排除环境音后继续等待，不提交 ASR', async () => {
  const runtime = voiceRuntime(); const endpoints = [];
  const voice = new runtime.window.LewisVoice({ getSettings: () => ({}), onState: () => {}, onText: () => { throw new Error('不应提交'); } });
  voice.context = { sampleRate: 16000 }; voice.continuousEnabled = true; voice.mode = 'conversation';
  voice.chunks = [new Float32Array(5000)]; voice.samples = 5000; voice.hasSpeech = true;
  voice.upload = async endpoint => { endpoints.push(endpoint); return { has_voice: false }; };
  await voice.submit('asr'); assert.deepEqual(endpoints, ['vad']); assert.equal(voice.mode, 'conversation'); assert.equal(voice.processing, false);
});

test('等待麦克风权限时暂停持续对话，迟到授权不会恢复监听', async () => {
  const runtime = voiceRuntime(); let resolve;
  const voice = new runtime.window.LewisVoice({ getSettings: () => ({}), onState: () => {} });
  voice.ensureMic = () => new Promise(r => { resolve = r; }); voice.releaseMic = async () => {};
  const pending = voice.toggleContinuous(true); await voice.toggleContinuous(false); resolve(); await pending;
  assert.equal(voice.continuousEnabled, false); assert.equal(voice.mode, 'off');
});
test('浏览器 WAV 包含正确采样率、单声道 PCM16 和饱和限幅', async () => {
  const runtime = voiceRuntime(); const blob = runtime.window.encodeLewisWav([Float32Array.of(-2, -0.5, 0, 0.5, 2)], 48000);
  const view = new DataView(await blob.arrayBuffer());
  assert.equal(view.getUint32(24, true), 48000); assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(40, true), 10); assert.equal(view.getInt16(44, true), -32768); assert.equal(view.getInt16(52, true), 32767);
});
test('关闭唤醒后，迟到的识别结果不会发起对话', async () => {
  const runtime = voiceRuntime(); let submitted = 0; let woken = 0; let resolve;
  const voice = new runtime.window.LewisVoice({ onText: () => { submitted++; }, onWake: () => { woken++; }, onState: () => {}, getSettings: () => ({}) });
  voice.context = { sampleRate: 16000, state: 'running', close: async () => {} };
  voice.mode = 'wake'; voice.wakeEnabled = true; voice.hasSpeech = true; voice.samples = 16000; voice.chunks = [new Float32Array(16000)];
  voice.upload = () => new Promise(r => { resolve = r; }); const request = voice.submit('wake-word');
  await voice.toggleWake(false); resolve({ detected: true, command: '打开计算器' }); await request;
  assert.equal(submitted, 0); assert.equal(woken, 0); assert.equal(voice.mode, 'off'); assert.equal(voice.processing, false);
});

test('唤醒词先呼出桌宠，再发送同句指令；只说名字进入等候', async () => {
  const runtime = voiceRuntime(); const events = [];
  const voice = new runtime.window.LewisVoice({ onWake: () => events.push('wake'), onText: text => events.push(text), onState: () => {}, getSettings: () => ({}) });
  voice.context = { sampleRate: 16000 }; voice.wakeEnabled = true; voice.mode = 'wake';
  for (const command of ['', '打开记事本']) {
    voice.hasSpeech = true; voice.samples = 5000; voice.chunks = [new Float32Array(5000)];
    voice.upload = async () => ({ detected: true, command }); await voice.submit('wake-word');
    if (!command) assert.equal(voice.mode, 'conversation');
  }
  assert.deepEqual(events, ['wake','wake','打开记事本']);
});

test('持续对话说名字也呼出桌宠，不请求模型，下一句正常发送', async () => {
  const runtime = voiceRuntime(); const events = [];
  const voice = new runtime.window.LewisVoice({ onWake: () => events.push('wake'), onText: text => events.push(text), onState: () => {}, getSettings: () => ({}) });
  voice.context = { sampleRate: 16000 }; voice.continuousEnabled = true; voice.mode = 'conversation';
  for (const text of ['李维斯。', '李维斯，打开计算器。', '继续说话']) {
    voice.hasSpeech = true; voice.samples = 5000; voice.chunks = [new Float32Array(5000)];
    voice.upload = async endpoint => endpoint === 'vad' ? { has_voice: true } : { text }; await voice.submit('asr');
  }
  assert.deepEqual(events, ['wake','wake','打开计算器。','继续说话']); assert.equal(voice.mode, 'conversation');
});
test('唤醒同句微信指令从原始识别保留正文空格、标点和大小写', async () => {
  const runtime = voiceRuntime(); const recognized = [];
  const voice = new runtime.window.LewisVoice({ onWake() {}, onText: text => recognized.push(text), onState() {}, getSettings: () => ({}) });
  voice.context = { sampleRate: 16000 }; voice.wakeEnabled = true; voice.mode = 'wake';
  voice.hasSpeech = true; voice.samples = 5000; voice.chunks = [new Float32Array(5000)];
  voice.upload = async () => ({ detected: true, text: '李维斯，微信给文件传输助手发消息说Hello World，明天见。', command: '微信给文件传输助手发消息说helloworld明天见' });
  await voice.submit('wake-word');
  assert.deepEqual(recognized, ['微信给文件传输助手发消息说Hello World，明天见。']);
});

test('忙碌状态暂停麦克风且不收集播报音频', () => {
  const runtime = voiceRuntime(); const track = { enabled: true };
  const voice = new runtime.window.LewisVoice({ onState: () => {}, getSettings: () => ({}) });
  voice.stream = { getAudioTracks: () => [track] }; voice.wakeEnabled = true;
  voice.setBusy(true); voice.capture(Float32Array.of(0.8, 0.8));
  assert.equal(track.enabled, false); assert.equal(voice.chunks.length, 0);
  voice.setBusy(false); assert.equal(track.enabled, true); assert.equal(voice.mode, 'wake');
});
test('取消麦克风权限等待后不会重新开启唤醒', async () => {
  const runtime = voiceRuntime(); let resolve; let releases = 0;
  const voice = new runtime.window.LewisVoice({ onState: () => {}, getSettings: () => ({}) });
  voice.ensureMic = () => new Promise(r => { resolve = r; }); voice.releaseMic = async () => { releases++; };
  const pending = voice.toggleWake(true); await voice.toggleWake(false); resolve(); await pending;
  assert.equal(voice.wakeEnabled, false); assert.equal(voice.mode, 'off'); assert.ok(releases >= 1);
});
