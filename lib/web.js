"use strict";
const dns = require("node:dns/promises");
const ipaddr = require("ipaddr.js");
const { Agent, fetch: webFetch } = require("undici");
const { XMLParser } = require("fast-xml-parser");
const cheerio = require("cheerio");
function publicAddress(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress())
      parsed = parsed.toIPv4Address();
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}
function validateWebURL(value) {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("网页地址无效");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("仅支持公开 HTTP/HTTPS 网页");
  if (url.port && !["80", "443"].includes(url.port))
    throw new Error("仅支持标准网页端口");
  return url;
}
// 固定 DNS 解析；重定向重新验证，网页读取不能访问本机或内网。
async function fetchPage(
  value,
  { signal, lookup = dns.lookup, fetchImpl = webFetch } = {},
) {
  let url = validateWebURL(value);
  for (let hop = 0; hop <= 4; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(host, { all: true });
    if (
      !addresses.length ||
      addresses.some((item) => !publicAddress(item.address))
    )
      throw new Error("网页访问不允许本机、内网或保留地址");
    const dispatcher = new Agent({
      connect: {
        lookup: (_host, options, callback) => {
          const selected = addresses.filter(
            (item) => !options.family || item.family === options.family,
          );
          if (!selected.length) return callback(new Error("无可用公网地址"));
          if (options.all) callback(null, selected);
          else callback(null, selected[0].address, selected[0].family);
        },
      },
    });
    try {
      const response = await fetchImpl(url, {
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.any([
          signal || new AbortController().signal,
          AbortSignal.timeout(20000),
        ]),
        headers: {
          "User-Agent": "Lewis/1.2 (+personal desktop assistant)",
          Accept:
            "text/html,application/xhtml+xml,application/rss+xml,application/xml,text/plain",
          // Personal desktop search preference, scoped to Bing only (never forwarded to redirects).
          ...(url.hostname === "www.bing.com" && url.pathname === "/search" ? { Cookie: "ADLT=OFF" } : {}),
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("网页重定向缺少地址");
        url = validateWebURL(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`网页服务 HTTP ${response.status}`);
      }
      const type = response.headers.get("content-type") || "";
      if (!/text\/|(?:xhtml|rss|xml)/i.test(type)) {
        await response.body?.cancel();
        throw new Error("只支持文本网页，不能读取下载文件");
      }
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 1024 * 1024) throw new Error("网页内容过大（最多 1MB）");
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks);
      const charset =
        /charset\s*=\s*["']?([\w-]+)/i.exec(type)?.[1] ||
        /charset\s*=\s*["']?([\w-]+)/i.exec(
          bytes.subarray(0, 2048).toString(),
        )?.[1] ||
        "utf-8";
      let text;
      try {
        text = new TextDecoder(charset).decode(bytes);
      } catch {
        text = bytes.toString("utf8");
      }
      return { url: url.href, text };
    } finally {
      await dispatcher.close();
    }
  }
  throw new Error("网页重定向次数过多");
}
function pageText(html, limit = 4000) {
  const $ = cheerio.load(html);
  $("script,style,noscript,nav,footer,iframe,form").remove();
  const content = $("article").first().length
    ? $("article").first()
    : $("main").first().length
      ? $("main").first()
      : $("body");
  const text = content.text().replace(/\s+/g, " ").trim();
  return {
    title: $("title").text().trim().slice(0, 150),
    text: text.slice(0, limit),
    truncated: text.length > limit,
  };
}
async function searchWeb(query, options = {}) {
  if (typeof query !== "string" || !query.trim() || query.length > 300)
    throw new Error("搜索内容应为 1–300 字符");
  try {
    return await rssSearch(query, options);
  } catch (error) {
    if (options.signal?.aborted || !options.readBrowser) throw error;
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query.trim())}&adlt=off`;
    const page = await options.readBrowser({ url, signal: options.signal });
    const results = (page.links || [])
      .filter(
        (link) =>
          link.title &&
          /^https?:\/\//i.test(link.url) &&
          !/\/(?:search|images|videos|maps)\?/i.test(link.url),
      )
      .slice(0, 6);
    if (!results.length && (!page.text?.trim() || /verify you are human|captcha|验证.*身份|异常流量/i.test(page.text)))
      throw Error("搜索暂时没有取得结果，请换一个关键词或检查网络");
    return {
      query: query.trim(),
      results,
      text:
        page.text?.slice(0, 5000) ||
        results.map((item) => item.title + "\n" + item.url).join("\n\n"),
      source: page.url || url,
      mode: "browser",
      degraded: true,
    };
  }
}
async function rssSearch(query, options) {
  if (typeof query !== "string" || !query.trim() || query.length > 300)
    throw new Error("搜索内容应为 1–300 字符");
  const page = await fetchPage(
    `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query.trim())}&adlt=off`,
    options,
  );
  const parsed = new XMLParser({ processEntities: false }).parse(page.text);
  const items = parsed.rss?.channel?.item;
  if (!items) throw new Error("搜索服务没有返回结果，请稍后重试");
  const list = Array.isArray(items) ? items : [items];
  const results = list.slice(0, 6).map((item) => ({
    title: pageText(String(item.title || "")).text.slice(0, 150),
    url: String(item.link || ""),
    snippet: pageText(String(item.description || "")).text.slice(0, 300),
  }));
  return {
    query: query.trim(),
    results,
    source: page.url,
    text: results
      .map((item, i) => `${i + 1}. ${item.title}\n${item.snippet}\n${item.url}`)
      .join("\n\n"),
  };
}
async function readWebpage(url, options) {
  const page = await fetchPage(url, options);
  const result = pageText(page.text);
  return { ...result, url: page.url, source: page.url };
}
module.exports = {
  publicAddress,
  validateWebURL,
  fetchPage,
  pageText,
  searchWeb,
  readWebpage,
};
