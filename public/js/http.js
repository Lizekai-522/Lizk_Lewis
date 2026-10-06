// 浏览器和 Node 共用响应检查，避免 HTML 错误页被当作 JSON。
(function (root) {
  // Bearer 请求头只能使用有效的 ASCII Key，不能把中文占位文本发给 fetch。
  function normalizeApiKey(value, required = true) {
    let message;
    if (typeof value !== "string")
      message = "API Key 必须是文本，请在设置中重新填写。";
    else {
      const key = value.trim();
      if (!key && !required) return "";
      if (!key)
        message =
          "请先在设置中填写服务商提供的真实 API Key，保存后再发送消息。";
      else if (!/^[\x21-\x7e]+$/.test(key))
        message =
          "API Key 不能包含中文、空格或换行，请粘贴服务商提供的真实 Key。";
      else if (
        /^(?:sk-)?(?:your[-_]?api[-_]?key|your[-_]?key|x{6,})$/i.test(key)
      )
        message = "API Key 仍是占位文本，请填写服务商提供的真实 Key。";
      else return key;
    }
    const error = new Error(message);
    error.status = 400;
    throw error;
  }
  async function readJSONResponse(response, endpoint = "接口") {
    const type = response.headers.get("content-type") || "";
    const text = await response.text();
    if (!/application\/(?:[\w.-]+\+)?json\b/i.test(type)) {
      const format =
        /text\/html/i.test(type) || /^\s*</.test(text)
          ? "HTML 页面"
          : "非 JSON 内容";
      throw new Error(
        `${endpoint} 返回了${format}（HTTP ${response.status}）。请检查服务地址，并关闭旧服务后重启新版李维斯。`,
      );
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `${endpoint} 返回了无效 JSON（HTTP ${response.status}），请检查后端服务。`,
      );
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error(`${endpoint} 返回的数据格式不正确。`);
    return data;
  }
  if (typeof module === "object" && module.exports)
    module.exports = { readJSONResponse, normalizeApiKey };
  else {
    root.readJSONResponse = readJSONResponse;
    root.normalizeApiKey = normalizeApiKey;
  }
})(typeof window === "object" ? window : globalThis);
