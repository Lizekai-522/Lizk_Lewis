/* Spoken text and local voice options, shared by the UI and tests. */
(function (root) {
  "use strict";
  const voices = [
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-XiaoyiNeural",
    "zh-CN-YunxiNeural",
  ];
  function options(settings = {}) {
    const rate = Number(settings.speechRate ?? 6),
      pitch = Number(settings.speechPitch ?? 0);
    if (
      !Number.isInteger(rate) ||
      rate < -25 ||
      rate > 30 ||
      !Number.isInteger(pitch) ||
      pitch < -20 ||
      pitch > 20
    )
      throw Error("语速应在 -25 到 30 之间，音调应在 -20 到 20 之间。");
    const signed = (number) => (number >= 0 ? "+" : "") + number;
    return {
      voice: voices.includes(settings.speechVoice)
        ? settings.speechVoice
        : voices[0],
      rate: signed(rate) + "%",
      pitch: signed(pitch) + "Hz",
    };
  }
  function chunks(text, limit = 240) {
    const clean = String(text)
      .replace(/```[\s\S]*?```/g, "代码我放在屏幕上了。")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/[^\s<>]+/g, "链接请看屏幕")
      .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, "")
      .replace(/^[ \t]*(?:#{1,6}\s*|[-*+]\s+|\d+[.)、]\s*)/gm, "")
      .replace(/[*#`|]/g, " ")
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/[ \t]+/g, " ")
      .trim();
    const result = [];
    let part = "";
    for (const sentence of clean.match(/[^。！？!?；;\n]+[。！？!?；;\n]*/gu) ||
      []) {
      if (part && part.length + sentence.length > limit) {
        result.push(part.trim());
        part = "";
      }
      for (let i = 0; i < sentence.length; i += limit) {
        const piece = sentence.slice(i, i + limit);
        if (i + limit < sentence.length) result.push(piece.trim());
        else part += piece;
      }
    }
    if (part.trim()) result.push(part.trim());
    return result;
  }
  const api = { options, chunks, voices };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.lewisSpeech = api;
})(typeof window === "object" ? window : globalThis);
