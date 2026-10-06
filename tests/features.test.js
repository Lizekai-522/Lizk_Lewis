const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyHand, GestureGate } = require('../public/js/gestures');
const { publicAddress, fetchPage, pageText, validateWebURL } = require('../lib/web');
const { toolsFor, parseTool, checkUserAction } = require('../lib/tools');
const { streamConversation } = require('../lib/model-chat');
const { executeSkill } = require('../lib/skills');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('手势后台使用经典脚本/WASM 加载，GPU 初始化失败时回退 CPU，帧处理释放位图', async () => {
  const delegates = [], messages = [], imports = []; let closed = 0;
  const sandbox = { self: { postMessage: data => messages.push(data) }, importScripts: url => imports.push(url), Vision: {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    GestureRecognizer: { createFromOptions: async (_files, options) => { delegates.push(options.baseOptions.delegate); if (options.baseOptions.delegate === 'GPU') throw new Error('No GPU'); return { recognizeForVideo: () => ({ landmarks: [], gestures: [] }) }; } },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/vision-worker.js'), 'utf8'), sandbox);
  await sandbox.self.onmessage({ data: { type: 'init' } }); assert.deepEqual(imports, ['/vendor/vision/vision_bundle.js']); assert.deepEqual(delegates, ['GPU','CPU']); assert.equal(messages[0].delegate, 'CPU');
  await sandbox.self.onmessage({ data: { type: 'frame', timestamp: 1, bitmap: { close: () => { closed++; } } } }); assert.equal(messages[1].type, 'result'); assert.equal(closed, 1);
});

test('左右旋转的手掌/握拳几何判定与无手过滤', () => {
  const make = (ratio, rotated) => {
    const points = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
    for (const tip of [8,12,16,20]) { points[tip - 2] = { x: rotated ? 1 : 0, y: rotated ? 0 : 1 }; points[tip] = { x: rotated ? ratio : 0, y: rotated ? 0 : ratio }; }
    return points;
  };
  for (const rotated of [true, false]) {
    assert.equal(classifyHand(make(1.5, rotated)), 'Open_Palm'); assert.equal(classifyHand(make(0.7, rotated)), 'Closed_Fist'); assert.equal(classifyHand(make(1.1, rotated)), '');
  }
  assert.equal(classifyHand([], { categoryName: 'Open_Palm', score: 1 }), '');
});

test('手势稳定半秒触发一次，持续举手不会反复执行', () => {
  const gate = new GestureGate();
  assert.equal(gate.update('Open_Palm', 0), ''); assert.equal(gate.update('Open_Palm', 450), 'Open_Palm');
  assert.equal(gate.update('Open_Palm', 3000), ''); gate.update('', 3100);
  assert.equal(gate.update('Closed_Fist', 3200), ''); assert.equal(gate.update('Closed_Fist', 3650), 'Closed_Fist');
});

test('保留模型识别出的竖拇指和其他互动手势，不让几何辅助覆盖为握拳/停止', () => {
  const { selectGesture } = require('../public/js/gestures');
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  for (const tip of [8, 12, 16, 20]) { points[tip - 2] = { x: 0.5, y: 0.8, z: 0 }; points[tip] = { x: 0.5, y: 0.6, z: 0 }; }
  for (const categoryName of ['Thumb_Up', 'Thumb_Down', 'Pointing_Up', 'Victory', 'ILoveYou']) {
    assert.equal(classifyHand(points, { categoryName, score: 0.9 }), categoryName);
    assert.deepEqual(selectGesture({ landmarks: [points], gestures: [[{ categoryName, score: 0.9 }]] }), { gesture: categoryName, score: 0.9, source: 'model' });
  }
});

test('公开网页限制拒绝私网、映射 IPv6、文件协议及转向本机的重定向', async () => {
  for (const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1']) assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  for (const url of ['file:///C:/test.txt','https://user:pass@example.com','http://example.com:5001']) assert.throws(() => validateWebURL(url));
  let fetched = 0;
  await assert.rejects(fetchPage('https://example.com', {
    lookup: async host => [{ address: host === '127.0.0.1' ? host : '8.8.8.8', family: 4 }],
    fetchImpl: async () => { fetched++; return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/' } }); },
  }), /内网/);
  assert.equal(fetched, 1);
});

test('网页正文去掉脚本/导航，超过容量返回截断标记', () => {
  const result = pageText('<title>标题</title><nav>导航</nav><main>正文<script>evil()</script>继续</main>', 3);
  assert.equal(result.title, '标题'); assert.equal(result.text, '正文继'); assert.equal(result.truncated, true);
});

test('工具参数和用户动作授权拒绝网页诱导的电脑操作，关闭权限阻止直接技能', async () => {
  assert.throws(() => parseTool({ function: { name: 'run_shell', arguments: '{}' } }), /未授权/);
  assert.throws(() => parseTool({ function: { name: 'open_app', arguments: '{"app":"notepad","cmd":"danger"}' } }), /参数/);
  assert.throws(() => checkUserAction({ skill: 'open-app' }, '搜索今天新闻'), /没有要求/);
  checkUserAction({ skill: 'open-app' }, '请打开记事本');
  const capabilities = { value: { web: false, computer: false }, require: () => { throw new Error('权限关闭'); } };
  assert.equal(toolsFor(capabilities).length, 0);
  await assert.rejects(executeSkill({ skill: 'open-app', app: 'notepad' }, '', { capabilities, launchApp: () => { throw new Error('不应启动'); } }), /权限关闭/);
});

test('跨块工具调用 → 执行 → 再次请求模型，回复包含最终结果与累计 usage', async () => {
  const requests = [], events = [], executed = [];
  const capabilities = { value: { web: true, computer: true } };
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'web_search', arguments: '{"query":"Media' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Pipe"}' } }] } }] },
    { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ];
  const output = await streamConversation({ config: { baseUrl: 'https://example.com', apiKey: 'fixture-key', model: 'test', contextWindow: 16384 }, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '搜索MediaPipe' }], tools: toolsFor(capabilities), signal: new AbortController().signal, onEvent: event => events.push(event), execute: async command => { executed.push(command); return { text: '官方资料', source: 'https://example.com/source' }; }, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const data = requests.length === 1 ? chunks : [{ choices: [{ delta: { content: '根据官方资料，找到结果。' } }] }, { usage: { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19 } }];
    return new Response(data.map(item => 'data: ' + JSON.stringify(item) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  assert.equal(output, '根据官方资料，找到结果。'); assert.equal(requests.length, 2);
  assert.deepEqual(executed, [{ query: 'MediaPipe', skill: 'web-search' }]); assert.equal(requests[1].messages.at(-1).role, 'tool');
  assert.equal(events.filter(event => event.usage).at(-1).usage.total_tokens, 31);
  assert.ok(events.some(event => event.tool?.state === 'done'));
});

test('重复请求工具达到回合上限即停止，避免无限循环', async () => {
  let count = 0;
  await assert.rejects(streamConversation({ config: { baseUrl: 'https://example.com', apiKey: 'fixture-key', model: 'test', contextWindow: 16384 }, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '搜索资料' }], tools: toolsFor({ value: { web: true } }), signal: new AbortController().signal, onEvent: () => {}, execute: async () => ({ text: 'fixture' }), fetchImpl: async () => { count++; return new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-' + count, function: { name: 'web_search', arguments: '{"query":"test"}' } }] } }] }) + '\n\ndata: [DONE]\n\n'); } }), /上限/);
  assert.equal(count, 5);
});
