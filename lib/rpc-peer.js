"use strict";
const { randomUUID } = require("node:crypto");
function createRpcPeer({ send, listen, handlers = {}, timeout = 60000 }) {
  const pending = new Map();
  const running = new Map();
  let closed = false;
  listen(async (message) => {
    if (closed || !message || typeof message !== "object") return;
    if (message.type === "response") {
      const job = pending.get(message.id);
      if (!job) return;
      pending.delete(message.id);
      job.cleanup();
      message.error
        ? job.reject(Error(message.error))
        : job.resolve(message.value);
      return;
    }
    if (message.type === "cancel") {
      running.get(message.id)?.abort();
      return;
    }
    if (message.type !== "request" || typeof message.id !== "string") return;
    const handler = handlers[message.name];
    const controller = new AbortController();
    running.set(message.id, controller);
    try {
      if (typeof handler !== "function") throw Error("IPC 方法未授权");
      const value = await handler(message.params, controller.signal);
      if (!closed) send({ type: "response", id: message.id, value });
    } catch (error) {
      if (!closed)
        send({ type: "response", id: message.id, error: error.message });
    } finally {
      running.delete(message.id);
    }
  });
  function call(name, params, signal) {
    if (closed) return Promise.reject(Error("工具服务已断开"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        pending.delete(id);
        cleanup();
        try {
          send({ type: "cancel", id });
        } catch {}
        reject(signal?.reason || Error("IPC 请求超时"));
      };
      const timer = setTimeout(abort, timeout);
      timer.unref();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      pending.set(id, { resolve, reject, cleanup });
      try {
        send({ type: "request", id, name, params });
      } catch (error) {
        pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }
  return {
    call,
    close() {
      closed = true;
      for (const job of pending.values()) {
        job.cleanup();
        job.reject(Error("工具服务退出，当前操作未确认；不会自动重发"));
      }
      pending.clear();
      for (const controller of running.values()) controller.abort();
      running.clear();
    },
  };
}
module.exports = { createRpcPeer };
