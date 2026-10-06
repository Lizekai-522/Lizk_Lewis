"use strict";
(() => {
  let stopped = false,
    timer;
  async function refresh() {
    try {
      const response = await fetch("/api/wechat/status");
      const data = await window.readJSONResponse(response, "微信连接");
      if (!response.ok) throw Error();
      for (const id of ["wechatAutoStatus", "wechatSettingsStatus"])
        document.getElementById(id).textContent = data.text;
      document.getElementById("wechatSettingsStatus").title = data.readScope;
    } catch {
      document.getElementById("wechatAutoStatus").textContent =
        "正在等待微信连接服务";
    }
    if (!stopped) timer = setTimeout(refresh, 10000);
  }
  // Connection refresh does not insert a chat message or require selecting a chat.
  const button = document.getElementById("wechatStatusBtn");
  button.addEventListener(
    "click",
    (event) => {
      event.stopImmediatePropagation();
      clearTimeout(timer);
      void refresh();
    },
    true,
  );
  window.addEventListener("pagehide", () => {
    stopped = true;
    clearTimeout(timer);
  });
  void refresh();
})();
