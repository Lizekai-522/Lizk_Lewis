"use strict";
(function () {
  const byId = (id) => document.getElementById(id);
  let loaded = false;
  async function api(endpoint, body) {
    const response = await fetch(
      "/api/wechat-reader" + endpoint,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const result = await window.readJSONResponse(response, "微信后台读取");
    if (!response.ok) throw new Error(result.error || "微信后台读取失败");
    return result;
  }
  async function refresh() {
    try {
      const data = await api("");
      if (!loaded) {
        byId("wechatReaderBase").value = data.baseUrl;
        byId("wechatMonitor").checked = data.monitor;
        byId("wechatAutoAnalyze").checked = data.autoAnalyze;
        byId("wechatReaderToken").placeholder = data.hasToken
          ? "已保存；留空保留现有 Token"
          : "从 TraceMemo → API Center 复制";
        loaded = true;
      }
      byId("wechatReaderStatus").textContent = !data.hasToken
        ? "完整后台读取：在这里连接 TraceMemo 数据服务。界面读取和语音发送无需配置此项。"
        : `${data.connected ? "后台读取在线" : "后台读取等待连接"} · ${data.contacts} 个会话 · 已扫描 ${data.scanned} 次 · 待分析 ${data.pending} 批${data.error ? " · " + data.error : ""}`;
      byId("wechatAnalysis").textContent =
        (data.analyses || [])
          .map(
            (item) =>
              `${new Date(item.at).toLocaleString()} · ${item.contact}\n${item.text}`,
          )
          .join("\n\n") ||
        "新消息分析会显示在这里。监听从启用后的新消息开始，历史可按联系人查询。";
    } catch (error) {
      byId("wechatReaderStatus").textContent = error.message;
    }
  }
  async function syncModel(value) {
    try {
      await api("/model", { settings: value });
    } catch (error) {
      byId("wechatReaderStatus").textContent = error.message;
    }
  }
  byId("wechatReaderSave").addEventListener("click", async () => {
    try {
      await api("", {
        baseUrl: byId("wechatReaderBase").value.trim(),
        token: byId("wechatReaderToken").value.trim(),
        monitor: byId("wechatMonitor").checked,
        autoAnalyze: byId("wechatAutoAnalyze").checked,
      });
      byId("wechatReaderToken").value = "";
      loaded = false;
      await refresh();
    } catch (error) {
      byId("wechatReaderStatus").textContent = error.message;
    }
  });
  byId("wechatReaderCheck").addEventListener("click", async () => {
    try {
      const data = await api("/check", {});
      const select = byId("wechatHistoryTarget");
      select.replaceChildren();
      for (const c of data.contacts)
        select.add(
          new Option(
            `${c.name} (${c.type === "group" ? "群聊" : "联系人"})`,
            c.id,
          ),
        );
      byId("wechatReaderStatus").textContent =
        `连接成功，可读取 ${data.contacts.length} 个会话；历史范围以本机数据库为准。`;
    } catch (error) {
      byId("wechatReaderStatus").textContent = error.message;
    }
  });
  byId("wechatHistoryRead").addEventListener("click", async () => {
    try {
      const body = { recipient: byId("wechatHistoryTarget").value };
      if (byId("wechatHistoryStart").value)
        body.startTime = Math.floor(
          new Date(byId("wechatHistoryStart").value + "T00:00:00").getTime() /
            1000,
        );
      if (byId("wechatHistoryEnd").value)
        body.endTime = Math.floor(
          new Date(byId("wechatHistoryEnd").value + "T23:59:59").getTime() /
            1000,
        );
      const data = await api("/history", body);
      byId("wechatHistoryResult").textContent =
        data.text +
        "\n" +
        data.messages
          .map(
            (m) =>
              `${m.datetime} ${m.sender} [${m.type}] ${m.text || m.transcript || "内容需媒体解析；当前不可读"}`,
          )
          .join("\n");
      const images = byId("wechatHistoryImage");
      images.replaceChildren();
      for (const m of data.messages.filter((m) => m.media?.available))
        images.add(new Option(`${m.datetime} ${m.sender} [图片]`, m.media.url));
      byId("wechatImageRead").disabled = !images.options.length;
    } catch (error) {
      byId("wechatHistoryResult").textContent = error.message;
    }
  });
  byId("wechatImageRead").addEventListener("click", async () => {
    byId("wechatImageResult").textContent = "正在读取微信原图并分析…";
    try {
      const data = await api("/image", {
        url: byId("wechatHistoryImage").value,
        question: byId("wechatImageQuestion").value || "描述这张图片",
      });
      byId("wechatImageResult").textContent = data.text;
    } catch (error) {
      byId("wechatImageResult").textContent = error.message;
    }
  });
  window.lewisWechatReader = { refresh, syncModel };
  if (typeof EventSource !== "undefined") {
    const events = new EventSource("/api/wechat/events");
    events.onmessage = () => refresh();
    window.addEventListener("pagehide", () => events.close());
  }
  refresh();
  setInterval(() => {
    if (document.querySelector('[data-settings-page="wechat"]')?.hidden === false && byId("settingsPanel").classList.contains("open")) refresh();
  }, 10000);
})();
