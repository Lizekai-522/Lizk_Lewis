"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
function validateRequest({ action, recipient, text }) {
  if (!["connection", "status", "read", "send"].includes(action))
    throw new Error("未知微信操作");
  if (
    !["status", "connection"].includes(action) &&
    (typeof recipient !== "string" ||
      !recipient.trim() ||
      recipient.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(recipient))
  )
    throw new Error("请指定完整微信聊天名称，最多80字符");
  if (
    action === "send" &&
    (typeof text !== "string" ||
      !text.trim() ||
      text.length > 2000 ||
      text.includes("\0"))
  )
    throw new Error("发送内容应为1–2000字符");
}
function runBridge(request, { signal } = {}) {
  if (process.platform !== "win32") throw new Error("微信接入仅支持 Windows");
  const executable = [
    process.resourcesPath &&
      path.join(process.resourcesPath, "native/WeChatBridge.exe"),
    path.join(__dirname, "../native/WeChatBridge.exe"),
  ]
    .filter(Boolean)
    .find((file) => fs.existsSync(file));
  if (!executable)
    throw new Error("微信组件未构建，请运行 node scripts/build-wechat.cjs");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(data);
    };
    const abort = () => {
      child.kill();
      finish(
        new Error(
          request.action === "send"
            ? "微信操作中断，发送状态可能未确认；请查看微信，本请求不会重发"
            : "微信操作已取消",
        ),
      );
    };
    const timer = setTimeout(abort, 40000);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 100000) abort();
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", (error) =>
      finish(new Error("微信组件启动失败：" + error.message)),
    );
    child.once("close", (code) => {
      try {
        if (code !== 0) throw new Error("微信组件异常结束");
        const data = JSON.parse(output.replace(/^\uFEFF/, "").trim());
        if (!data.ok) throw new Error(data.error || "微信操作失败");
        finish(null, data);
      } catch (error) {
        finish(error);
      }
    });
    child.stdin.end(JSON.stringify(request), "utf8");
  });
}
// Serialize desktop operations. Cache the entire send promise, including unknown/failure outcomes.
// A model retry or duplicate HTTP request within the same operation must not send twice.
class WeChatService {
  constructor(runner = runBridge) {
    this.runner = runner;
    this.pending = Promise.resolve();
    this.sends = new Map();
  }
  execute(request, { operationId, signal } = {}) {
    validateRequest(request);
    if (signal?.aborted) throw new Error("微信操作已取消");
    let key;
    if (request.action === "send") {
      if (
        typeof operationId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(operationId)
      )
        throw new Error("发送请求缺少有效操作 ID");
      key = operationId;
      const previous = this.sends.get(key);
      if (previous) {
        if (previous.signature !== JSON.stringify(request))
          throw new Error("该发送操作 ID 已用于其他内容");
        return previous.task;
      }
      if (this.sends.size >= 500)
        throw new Error("本次运行微信发送记录已满，请重启李维斯再操作");
    }
    const task = this.pending.then(async () => {
      if (signal?.aborted) throw new Error("微信操作已取消");
      const result = await this.runner(request, { signal });
      if (request.action === "send" && result?.sent !== true)
        throw new Error(
          "微信未返回发送确认，不能报告已发送；请查看微信，本请求不会自动重发",
        );
      return result;
    });
    this.pending = task.catch(() => {});
    if (key) this.sends.set(key, { signature: JSON.stringify(request), task });
    return task;
  }
}
module.exports = { WeChatService, validateRequest, runBridge };
