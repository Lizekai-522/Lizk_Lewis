"use strict";
const http = require("node:http");
const net = require("node:net");
const dns = require("node:dns/promises");
const { validateWebURL, publicAddress } = require("./web");

async function resolvePublicTarget(value, lookup = dns.lookup) {
  const url = validateWebURL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || /\.(?:localhost|local)$/i.test(host))
    throw new Error("禁止访问本机或内网");
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await lookup(host, { all: true });
  if (
    !addresses.length ||
    addresses.some((item) => !publicAddress(item.address))
  )
    throw new Error("禁止访问本机、内网或保留地址");
  return { url, address: addresses[0].address, family: addresses[0].family };
}

// Chromium 经此代理连接已经核验的 IP，不再自行重新解析域名，防止 DNS 重绑定。
// 只绑定回环地址；HTTPS 通过隧道保留浏览器的证书核验，不解密或保存登录数据。
function createPublicWebProxy({
  allowed = () => true,
  lookup = dns.lookup,
  request = http.request,
  connect = net.connect,
} = {}) {
  const sockets = new Set();
  let closed = false;
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    return socket;
  };
  const requireAllowed = () => {
    if (closed || !allowed()) throw new Error("网页权限已关闭");
  };
  const server = http.createServer(async (req, res) => {
    let upstream;
    try {
      requireAllowed();
      if (
        !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
          req.method,
        )
      )
        throw new Error("不支持此请求方式");
      const { url, address, family } = await resolvePublicTarget(
        req.url,
        lookup,
      );
      requireAllowed();
      if (req.destroyed || res.destroyed) return;
      if (url.protocol !== "http:") throw new Error("HTTPS 必须使用安全隧道");
      const headers = { ...req.headers, host: url.host, connection: "close" };
      for (const name of ["proxy-authorization", "proxy-connection", "upgrade"])
        delete headers[name];
      upstream = request(
        {
          hostname: address,
          family,
          port: 80,
          path: url.pathname + url.search,
          method: req.method,
          headers,
        },
        (response) => {
          if (closed || !allowed()) {
            response.destroy();
            if (!res.headersSent) res.writeHead(403);
            res.end();
            return;
          }
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("socket", track);
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("网页连接失败");
      });
      upstream.setTimeout(60000, () => upstream.destroy());
      res.once("close", () => upstream.destroy());
      let uploaded = 0;
      req.on("data", (chunk) => {
        uploaded += chunk.length;
        if (uploaded > 1024 * 1024) {
          upstream.destroy();
          if (!res.headersSent) res.writeHead(413);
          res.end("请求过大");
        }
      });
      req.pipe(upstream);
    } catch {
      if (!res.headersSent) res.writeHead(403);
      res.end("网页地址或权限不允许");
    }
  });
  server.on("connection", track);
  server.on("connect", async (req, client, head) => {
    let upstream;
    try {
      requireAllowed();
      // CONNECT 只接受明确的 HTTPS 标准端口，避免借隧道访问其他服务。
      if (!/^(?:\[[0-9a-f:]+\]|[^:/?#\s]+):443$/i.test(req.url))
        throw new Error("隧道地址无效");
      const { address, family } = await resolvePublicTarget(
        "https://" + req.url + "/",
        lookup,
      );
      requireAllowed();
      if (client.destroyed) return;
      upstream = track(connect({ host: address, family, port: 443 }));
      upstream.setTimeout(60000, () => upstream.destroy());
      upstream.once("connect", () => {
        if (closed || !allowed() || client.destroyed) {
          upstream.destroy();
          client.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => client.destroy());
      upstream.once("close", () => client.destroy());
      client.once("close", () => upstream.destroy());
    } catch {
      if (!client.destroyed)
        client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  return {
    async start() {
      if (closed) throw new Error("网页代理已关闭");
      if (!server.listening)
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
      return `127.0.0.1:${server.address().port}`;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
module.exports = { createPublicWebProxy, resolvePublicTarget };
