"use strict";

// 网络分块可以切在 JSON 或 UTF-8 字符中间；保留尾部直到拿到完整 SSE 事件。
async function consumeSSE(body, onEvent) {
  if (!body) throw new Error("模型没有返回响应流");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  const dispatch = (event) => {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      ended = true;
      return;
    }
    onEvent(JSON.parse(data));
  };
  try {
    while (!ended) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        dispatch(event);
        if (ended) break;
      }
      if (done) {
        if (buffer.trim()) dispatch(buffer);
        break;
      }
    }
    if (!ended) throw new Error("模型响应提前结束，请重试");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
module.exports = { consumeSSE };
