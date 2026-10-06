"use strict";
const { getEncoding } = require("js-tiktoken");
let encoding;
const tokenCache = new Map();
function countText(text, model = "") {
  if (!encoding) encoding = getEncoding("cl100k_base");
  const value = String(text ?? "");
  let count = 0;
  // Bound the JS tokenizer's quadratic work on repeated strings; chunk boundaries conservatively overcount.
  for (let offset = 0; offset < value.length; offset += 512) {
    const part = value.slice(offset, offset + 512);
    let tokens = tokenCache.get(part);
    if (tokens === undefined) {
      tokens = encoding.encode(part, [], []).length;
      tokenCache.set(part, tokens);
      if (tokenCache.size > 256)
        tokenCache.delete(tokenCache.keys().next().value);
    }
    count += tokens;
  }
  return /^gpt-(?:4|3\.5)/.test(model) ? count : Math.ceil(count * 1.25);
}
function jpegSize(url) {
  if (typeof url !== "string" || !url.startsWith("data:image/jpeg;base64,"))
    return null;
  const data = Buffer.from(url.split(",")[1], "base64");
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 255) return null;
    const marker = data[offset + 1];
    if (marker === 217 || marker === 218) return null;
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) return null;
    if (
      [
        192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
      ].includes(marker)
    )
      return {
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7),
      };
    offset += length + 2;
  }
  return null;
}
function imageTokens(url, model = "") {
  const size = jpegSize(url);
  if (!size) return 2048;
  if (/^qwen3-vl/i.test(model))
    return (
      Math.max(256, Math.ceil(size.width / 32) * Math.ceil(size.height / 32)) +
      96
    );
  return (
    Math.max(
      1024,
      Math.ceil(size.width / 512) * Math.ceil(size.height / 512) * 256,
    ) + 96
  );
}
function countMessages(messages, model = "") {
  let images = 0;
  const serialized = JSON.stringify(messages, (key, value) => {
    if (key === "image_url") {
      images += imageTokens(value?.url, model);
      return { url: "[image]" };
    }
    return value;
  });
  return countText(serialized, model) + images + messages.length * 8;
}
module.exports = { countText, countMessages, jpegSize, imageTokens };
