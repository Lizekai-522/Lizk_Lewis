const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { visionSettings } = require('../public/js/vision-config');
function factory() {
  const window = { lewisVisionSettings: visionSettings };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/vision-observer.js'), 'utf8'), { window, document: { addEventListener() {} }, AbortController, Date });
  return window.createLewisVisionObserver;
}
test('未配置视觉不调用云端；空闲时自动观察，表情变化主动搭话，遵守间隔与手势安静', async () => {
  let clock = 0, configured = false, active = true, busy = false, description = '微笑', calls = 0;
  const said = [], labels = [];
  const observer = factory()({ now: () => clock, getSettings: () => ({ visionEnabled: true, visionApiBaseUrl: configured ? 'https://example.com/v1' : '', visionApiKey: configured ? 'test' : '' }), getVision: () => ({ isActive: () => active, snapshot: () => 'current-image' }), isBusy: () => busy,
    request: async body => { assert.equal(body.image, 'current-image'); calls++; return { description, shouldSpeak: true, comment: '看见你笑了', model: 'qwen3-vl-plus' }; }, say: async text => { said.push(text); return true; }, status: text => labels.push(text) });
  await observer.tick(); assert.equal(calls, 0); assert.match(labels.at(-1), /尚未看到/);
  configured = true; await observer.tick(); assert.equal(calls, 1); assert.equal(said.length, 1);
  await observer.tick(); assert.equal(said.length, 1);
  description = '拿起杯子'; clock = 10000; await observer.tick(); assert.equal(said.length, 1);
  description = '拿起书'; clock = 60001; await observer.tick(); assert.equal(said.length, 2);
  observer.quiet(); description = '又微笑'; clock = 80000; await observer.tick(); assert.equal(said.length, 2);
  busy = true; const before = calls; clock = 200000; await observer.tick(); assert.equal(calls, before);
  busy = false; active = false; await observer.tick(); assert.equal(calls, before);
});
test('关闭摄像头或视觉会取消分析，迟到结果不搭话，失败退避防止持续请求', async () => {
  let resolve, active = true, enabled = true, clock = 0, called = 0, spoken = 0;
  const observer = factory()({ now: () => clock, getSettings: () => ({ visionEnabled: enabled, visionApiBaseUrl: 'https://example.com/v1', visionApiKey: 'test' }), getVision: () => ({ isActive: () => active, snapshot: () => 'image' }), isBusy: () => false, status() {}, say: async () => { spoken++; return true; }, request: async () => { called++; return new Promise(r => { resolve = r; }); } });
  const pending = observer.tick(); await Promise.resolve(); active = false; observer.suspend(); resolve({ description: '微笑', comment: '你好', shouldSpeak: true, model: 'test' }); await pending; assert.equal(spoken, 0);
  enabled = false; active = true; await observer.tick(); assert.equal(called, 1);
  let failures = 0;
  const failing = factory()({ now: () => clock, getSettings: () => ({ visionEnabled: true, visionApiBaseUrl: 'https://example.com/v1', visionApiKey: 'test' }), getVision: () => ({ isActive: () => true, snapshot: () => 'image' }), isBusy: () => false, status() {}, say() {}, request: async () => { failures++; throw Error('网络断开'); } });
  await failing.tick(); clock = 10000; await failing.tick(); assert.equal(failures, 1); clock = 61000; await failing.tick(); assert.equal(failures, 2);
});
