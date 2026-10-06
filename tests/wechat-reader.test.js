const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WechatReader, localBase, cleanMessage } = require('../lib/wechat-reader');
const { checkUserAction, toolsFor } = require('../lib/tools');
const { GestureGate, selectGesture } = require('../public/js/gestures');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lewis-reader-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture(name, options = {}) {
  const requests = []; let clock = 100000;
  const messages = options.messages || [{ id: '1', type: '文本', content: '明天开会', createTime: 101, name: '好友' }];
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const reader = new WechatReader(path.join(root, name), { now: () => clock, ...options, fetchImpl: async (input, init) => {
    const url = new URL(input); requests.push({ url, init });
    if (url.pathname === '/api/v1/health') return json({ ready: true });
    assert.equal(init.headers.Authorization, 'Bearer local-token');
    if (url.pathname === '/api/v1/contact') return json({ contacts: options.contacts || [{ m_nsUsrName: 'wxid-a', m_nsNickName: '好友', type: 'user' }] });
    if (url.pathname === '/api/v1/chatlog') return json({ contact: { m_nsNickName: '好友' }, messages });
    throw Error('Unexpected write/media endpoint ' + url.pathname);
  } });
  reader.configure({ baseUrl: 'http://127.0.0.1:6131', token: 'local-token', monitor: true, autoAnalyze: true });
  return { reader, requests, messages, time: value => { clock = value; } };
}
test('Reader 仅接受本机地址、合法 Token，公开配置不泄漏凭据', () => {
  for (const base of ['https://example.com', 'http://127.0.0.1:6131/evil', 'http://user:password@localhost', 'http://localhost/?token=secret']) assert.throws(() => localBase(base));
  const { reader } = fixture('validation');
  assert.doesNotMatch(JSON.stringify(reader.publicConfig()), /local-token/);
  assert.throws(() => reader.configure({ monitor: true, autoAnalyze: true, token: '中文' }), /Token/);
});
test('后台历史定位唯一会话，区分数据库计数和返回截断，不携带 XML/密钥到模型', async () => {
  const { reader, requests } = fixture('history', { messages: [{ id: '1', type: '文本', content: '历史文字', createTime: 10, contentData: { aeskey: 'NEVER_UPLOAD' } }, { id: '2', type: '文件', content: '<xml>文件正文不是这个</xml>', createTime: 20 }] });
  const result = await reader.history('好友', { limit: 1 });
  assert.equal(result.count, 2); assert.equal(result.truncated, true); assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].contentStatus, 'content-unavailable'); assert.equal(result.messages[0].text, '');
  assert.doesNotMatch(JSON.stringify(result), /NEVER_UPLOAD|<xml>/);
  assert.equal(requests.at(-1).url.searchParams.get('talker'), 'wxid-a');
  await assert.rejects(reader.history('不匹配'), /准确匹配/);
  const duplicate = fixture('ambiguous', { contacts: [{ m_nsUsrName: 'a', m_nsNickName: '重名' }, { m_nsUsrName: 'b', m_nsNickName: '重名' }] });
  await assert.rejects(duplicate.reader.history('重名'), /多个会话/);
});
test('监听跨轮去重、重启继续，模型失败保留待处理消息，仅处理启用后的消息', async () => {
  let calls = 0, fail = true; const payloads = [];
  const { reader, messages, time } = fixture('monitor', { analyze: async batch => { calls++; payloads.push(batch); if (fail) throw Error('模型离线'); return '需要留意明天会议'; } });
  messages.unshift({ id: 'old', type: '文本', content: '旧历史不自动上传', createTime: 90 }); time(102000);
  await reader.tick(); assert.equal(calls, 1); assert.equal(reader.state.pending.length, 1); assert.equal(payloads[0].messages.length, 1);
  fail = false; time(103000); await reader.tick(); assert.equal(calls, 2); assert.equal(reader.state.pending.length, 0); assert.equal(reader.state.analyses.length, 1);
  await reader.tick(); assert.equal(calls, 2);
  const restored = new WechatReader(path.join(root, 'monitor'), { fetchImpl: reader.fetch, analyze: async () => { throw Error('重复分析'); }, now: () => 104000 });
  await restored.tick(); assert.equal(restored.state.pending.length, 0); assert.equal(restored.state.analyses.length, 1);
});
test('监听轮询超过8个会话会继续扫余下会话，关闭权限立即停止', async () => {
  let allowed = true; const contacts = Array.from({ length: 10 }, (_, i) => ({ m_nsUsrName: 'id-' + i, m_nsNickName: '好友' + i }));
  const { reader, requests } = fixture('all-chats', { contacts, allowed: () => allowed });
  await reader.tick(); await reader.tick();
  const ids = new Set(requests.filter(r => r.url.pathname === '/api/v1/chatlog').map(r => r.url.searchParams.get('talker')));
  assert.equal(ids.size, 10); const before = requests.length; allowed = false; await reader.tick(); assert.equal(requests.length, before);
  await assert.rejects(reader.history('id-0'), /权限已关闭/);
});
test('新消息分析开启不授予发送权限，未配置 Reader 不暴露历史工具', () => {
  assert.doesNotThrow(() => checkUserAction({ skill: 'wechat-history' }, '查看昨天的安排', true));
  assert.throws(() => checkUserAction({ skill: 'wechat-send', recipient: '好友', text: '收到' }, '查看昨天的安排', true), /没有授权/);
  const c = { value: { wechat: true, computer: true } };
  assert.equal(toolsFor(c).some(t => t.function.name === 'wechat_read_history'), false);
  assert.equal(toolsFor(c, true).some(t => t.function.name === 'wechat_read_history'), true);
});
test('分析期间关闭读取权限不提交结果，待处理消息留在本地', async () => {
  let allowed = true;
  const { reader, time } = fixture('revoke', { allowed: () => allowed, analyze: async () => { allowed = false; return '不应提交'; } });
  time(102000); await reader.tick();
  assert.equal(reader.state.analyses.length, 0); assert.equal(reader.state.pending.length, 1);
});
test('媒体必须来自本机读取路由，禁止任意地址和写入接口，HTML 响应给出明确诊断', async () => {
  const { reader } = fixture('media');
  await assert.rejects(reader.image('https://external.example/image'), /读取列表/);
  await assert.rejects(reader.request('/api/v1/agent/send'), /读取列表/);
  reader.fetch = async () => new Response('<!DOCTYPE html>', { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(reader.contacts(), /JSON/);
  await assert.rejects(reader.image('/api/v1/media/image-id'), /有效 JPEG/);
});
test('图片/语音缺少内容时保留不可读状态，不把媒体占位文字当作正文', () => {
  assert.equal(cleanMessage({ type: '语音', content: '[语音]', voiceTranscript: '转写结果' }).transcript, '转写结果');
  assert.equal(cleanMessage({ type: '图片', content: '不要猜测', media: { type: 'image', available: true, url: 'https://evil.example/image' } }).media, undefined);
});
test('手势短暂漏检仍能触发，持续同一手势只触发一次，重新开启摄像头不保留冷却', () => {
  const gate = new GestureGate();
  for (const now of [0,100,200]) assert.equal(gate.update('Open_Palm', now), '');
  assert.equal(gate.update('', 300), ''); assert.equal(gate.update('Open_Palm', 400), ''); assert.equal(gate.update('Open_Palm', 500), 'Open_Palm');
  gate.update('', 600); assert.equal(gate.update('Open_Palm', 700), '');
  gate.reset(); gate.update('Closed_Fist', 800); assert.equal(gate.update('Closed_Fist', 1250), 'Closed_Fist');
});
test('双手冲突优先暂停播报，几何辅助不冒充模型置信度', () => {
  const hand = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
  const result = selectGesture({ landmarks: [hand, hand], gestures: [[{ categoryName: 'Closed_Fist', score: 0.9 }], [{ categoryName: 'Open_Palm', score: 0.8 }]] });
  assert.equal(result.gesture, 'Open_Palm'); assert.equal(result.source, 'model');
  for (const tip of [8,12,16,20]) { hand[tip-2] = { x: 0, y: 1 }; hand[tip] = { x: 0, y: 1.5 }; }
  assert.equal(selectGesture({ landmarks: [hand], gestures: [[{ categoryName: 'None', score: 0.99 }]] }).score, null);
});
