"use strict";
const { createRpcPeer } = require("../lib/rpc-peer");
const send = (message) =>
  process.parentPort
    ? process.parentPort.postMessage(message)
    : process.send(message);
const listen = (handler) =>
  process.parentPort
    ? process.parentPort.on("message", (event) => handler(event.data))
    : process.on("message", handler);
let backend;
const peer = createRpcPeer({
  send,
  listen,
  handlers: {
    start: async ({ port }) => {
      if (backend) throw Error("工具服务已启动");
      require("../lib/secret-codec").setSecretKey(
        await peer.call("secureKey", {}),
      );
      backend = require("../server");
      backend.setDesktopActions({
        openWebsite: (url) => peer.call("openWebsite", { url }),
        readBrowser: ({ signal, ...options }) =>
          peer.call("readBrowser", options, signal),
        browserAction: ({ signal, ...options }) =>
          peer.call("browserAction", options, signal),
      });
      const set = backend.capabilities.set.bind(backend.capabilities);
      backend.capabilities.set = (value) => {
        const result = set(value);
        send({ type: "capabilities", value: result });
        return result;
      };
      const server = await backend.start(port);
      send({ type: "capabilities", value: backend.capabilities.value });
      return { port: server.address().port };
    },
    stop: async () => {
      if (backend) {
        backend.server.close();
        backend.server.closeAllConnections();
      }
      return true;
    },
  },
});
process.on("disconnect", () => {
  peer.close();
  if (backend) {
    backend.server.close();
    backend.server.closeAllConnections();
  }
  process.exit();
});
