"use strict";
const dns = require("node:dns/promises");
const { Agent, fetch } = require("undici");
const { publicAddress, validateWebURL } = require("./web");
async function downloadPublic(
  value,
  {
    signal,
    limit = 20 * 1024 * 1024,
    lookup = dns.lookup,
    fetchImpl = fetch,
  } = {},
) {
  let url = validateWebURL(value);
  for (let hop = 0; hop < 6; hop++) {
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), {
      all: true,
    });
    if (
      !addresses.length ||
      addresses.some((item) => !publicAddress(item.address))
    )
      throw Error("下载地址不能指向本机或内网");
    const dispatcher = new Agent({
      connect: {
        lookup: (_host, options, callback) => {
          const selected = addresses.filter(
            (item) => !options.family || options.family === item.family,
          );
          if (!selected.length) return callback(Error("没有可用的公网地址"));
          options.all
            ? callback(null, selected)
            : callback(null, selected[0].address, selected[0].family);
        },
      },
    });
    try {
      const response = await fetchImpl(url, {
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.any([
          signal || new AbortController().signal,
          AbortSignal.timeout(45000),
        ]),
        headers: { "User-Agent": "Lewis-Plugin-Market", Accept: "*/*" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw Error("下载跳转地址缺失");
        url = validateWebURL(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw Error(`下载服务 HTTP ${response.status}`);
      }
      if (Number(response.headers.get("content-length")) > limit) {
        await response.body?.cancel();
        throw Error("下载包太大，最多20MB");
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > limit) throw Error("下载包超过大小限制");
        chunks.push(Buffer.from(chunk));
      }
      return { bytes: Buffer.concat(chunks), url: url.href };
    } finally {
      await dispatcher.close();
    }
  }
  throw Error("下载跳转次数过多");
}
module.exports = { downloadPublic };
