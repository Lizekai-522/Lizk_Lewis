const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { WechatAutoLink } = require("../lib/wechat-autolink");
test("微信自动连接只探测，权限关闭后立即隐藏托管状态，不发送消息", async () => {
  let allowed = true,
    calls = [];
  const reader = {
    publicConfig: () => ({
      hasToken: true,
      connected: true,
      monitor: true,
      autoAnalyze: true,
    }),
  };
  const link = new WechatAutoLink({
    platform: "win32",
    reader,
    allowed: () => allowed,
    service: {
      execute: async (request) => {
        calls.push(request);
        return { running: true, connected: true };
      },
    },
  });
  const status = await link.tick();
  assert.equal(status.builtin, true);
  assert.equal(status.mode, "background");
  assert.equal(status.autoReply, false);
  assert.equal(status.analyzing, true);
  assert.deepEqual(calls, [{ action: "connection" }]);
  allowed = false;
  assert.equal(link.snapshot().mode, "disabled");
  await link.tick();
  assert.equal(calls.length, 1);
  link.stop();
});
test("探测失败后仍能在微信打开时重新连接，不能把屏幕读取称为后台全消息", async () => {
  let calls = 0;
  const link = new WechatAutoLink({
    platform: "win32",
    reader: { publicConfig: () => ({ hasToken: false, connected: false }) },
    allowed: () => true,
    service: {
      execute: () => {
        if (!calls++) throw Error("closed");
        return Promise.resolve({ running: true, connected: true });
      },
    },
  });
  assert.equal((await link.tick()).connected, false);
  const next = await link.tick();
  assert.equal(next.mode, "screen");
  assert.equal(next.monitoring, false);
  assert.equal(next.autoReply, false);
  assert.match(next.readScope, /可见/);
  link.stop();
});
