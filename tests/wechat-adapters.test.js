const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { WechatAdapters } = require('../lib/wechat-adapters');
const { executeSkill } = require('../lib/skills');
test('官方微信发送缓存 Token 和发送结果，确认绑定收件人与正文，不将拒绝当成功', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lewis-adapters-')); const calls = []; let reject = false;
  const adapter = new WechatAdapters(directory, { fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(url.includes('gettoken') ? { access_token: 'secret-token', expires_in: 7200 } : reject ? { errcode: 0, invaliduser: 'not-found' } : { errcode: 0, msgid: 'one' })); } });
  try {
    adapter.configure({ confirmSend: true, enterprise: { id: 'corp', secret: 'secret', agentId: '123' }, publicAccount: { id: '' } });
    assert.equal(JSON.stringify(adapter.publicConfig()).includes('secret-token'), false);
    const request = { adapter: 'enterprise', recipient: 'user1', text: '测试', operationId: 'test-op' };
    const pending = await adapter.send(request); assert.equal(calls.length, 0); assert.equal(pending.sent, false);
    await assert.rejects(adapter.send({ ...request, text: '不同正文', confirmationId: pending.confirmationId }), /正文/);
    const next = await adapter.send(request); const result = await adapter.send({ ...request, confirmationId: next.confirmationId }); assert.equal(result.sent, true); assert.equal(calls.length, 2);
    adapter.config.confirmSend = false; await adapter.send(request); assert.equal(calls.length, 2);
    reject = true; await assert.rejects(adapter.send({ ...request, operationId: 'other' }), /未接受/); assert.equal(calls.length, 3);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('数据库读取不可用时降级屏幕读取，权限仍检查，取消后不启动降级', async () => {
  let reads = 0; let permitted = true;
  const context = { capabilities: { require: () => { if (!permitted) throw Error('权限关闭'); } }, wechatReader: { configured: () => true, history: async () => { throw Error('数据库升级'); } }, wechat: { execute: async () => { reads++; return { text: '可见消息' }; } } };
  const result = await executeSkill({ skill: 'wechat-read', recipient: '张三' }, '', context); assert.equal(result.degraded, true); assert.equal(reads, 1);
  permitted = false; await assert.rejects(executeSkill({ skill: 'wechat-read', recipient: '张三' }, '', context), /权限/); assert.equal(reads, 1);
});
