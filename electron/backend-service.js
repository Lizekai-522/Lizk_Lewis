"use strict";
const path = require("node:path");
const { createRpcPeer } = require("../lib/rpc-peer");
function createBackendService({
  fork,
  getMaster = () => null,
  onExit = () => {},
  log = () => {},
}) {
  let child,
    peer,
    address,
    stopped = false;
  let actions = {};
  const capabilities = {
    value: { web: false, computer: false, wechat: false },
  };
  async function start(port) {
    stopped = false;
    child = fork(path.join(__dirname, "tool-service.cjs"), [], {
      env: { ...process.env },
      stdio: "pipe",
      serviceName: "Lewis 工具服务",
    });
    child.stdout?.on("data", (chunk) => log("info", String(chunk)));
    child.stderr?.on("data", (chunk) => log("warn", String(chunk)));
    child.on("message", (message) => {
      if (message.type === "capabilities") capabilities.value = message.value;
    });
    const instance = child;
    peer = createRpcPeer({
      send: (message) => instance.postMessage(message),
      listen: (handler) => instance.on("message", handler),
      handlers: {
        secureKey: () => getMaster(),
        openWebsite: ({ url }) => actions.openWebsite(url),
        readBrowser: (options, signal) =>
          actions.readBrowser({ ...options, signal }),
        browserAction: (options, signal) =>
          actions.browserAction({ ...options, signal }),
      },
      timeout: 120000,
    });
    const instancePeer = peer;
    child.on("exit", (code) => {
      instancePeer.close();
      if (child !== instance) return;
      capabilities.value = { web: false, computer: false, wechat: false };
      if (!stopped) onExit(code);
    });
    child.on("error", (error) =>
      log("error", error?.message || "工具服务异常"),
    );
    const result = await peer.call("start", { port });
    address = { port: result.port };
    return { address: () => address, close };
  }
  async function close() {
    stopped = true;
    const target = child;
    const targetPeer = peer;
    try {
      await Promise.race([
        targetPeer?.call("stop", {}),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 2000);
          timer.unref();
        }),
      ]);
    } catch {
    } finally {
      targetPeer?.close();
      target?.kill();
    }
  }
  return {
    capabilities,
    setDesktopActions: (value) => (actions = value),
    start,
    close,
  };
}
module.exports = { createBackendService };
