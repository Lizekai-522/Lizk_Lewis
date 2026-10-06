const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readJSONResponse, normalizeApiKey } = require('../public/js/http');

test('中文占位 Key 复现 ByteString 错误，校验提前给出中文提示且不泄露 Key', () => {
  assert.throws(() => new Headers({ Authorization: 'Bearer sk-你的APIKey' }), /index 10.*20320/);
  for (const key of ['sk-你的APIKey', 'secret-中文', 'key\nInjected', 'key with spaces', 'sk-xxxxxxxxxx', 123]) {
    assert.throws(() => normalizeApiKey(key), error => {
      assert.equal(error.status, 400); assert.match(error.message, /API Key/);
      assert.doesNotMatch(error.message, /ByteString|secret|Injected/); return true;
    });
  }
});

test('Key 去除复制时的首尾空白；必填空 Key 被拒绝，环境变量回退允许前端留空', () => {
  assert.equal(normalizeApiKey('  test-key_123  '), 'test-key_123');
  assert.throws(() => normalizeApiKey(''), /真实 API Key/);
  assert.equal(normalizeApiKey('', false), '');
});

test('HTML 404 和 HTML 200 都返回接口诊断，不暴露原始 JSON 解析错误', async () => {
  for (const status of [200, 404]) {
    await assert.rejects(readJSONResponse(new Response('<!DOCTYPE html><html>Error</html>', { status, headers: { 'Content-Type': 'text/html' } }), '/api/sessions'), error => {
      assert.match(error.message, /\/api\/sessions/); assert.match(error.message, /HTML 页面/); assert.doesNotMatch(error.message, /Unexpected token/); return true;
    });
  }
});
test('JSON HTTP 错误保留后端信息，无效 JSON 返回可理解提示', async () => {
  const error = await readJSONResponse(new Response('{"error":"会话不存在"}', { status: 404, headers: { 'Content-Type': 'application/problem+json' } }), '/api/history');
  assert.equal(error.error, '会话不存在');
  await assert.rejects(readJSONResponse(new Response('broken', { headers: { 'Content-Type': 'application/json' } }), '/api/history'), /无效 JSON/);
});
