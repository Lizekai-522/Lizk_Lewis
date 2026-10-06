/* 网页操作记录与桌面原生网页视图；浏览器版仍显示实际工具结果。 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const friendly = (error) =>
    window.lewisFriendlyError?.(error, "网页操作") ||
    error?.message ||
    String(error);
  let current = "",
    openedPreview = "",
    scheduled;
  const names = {
    web_search: "搜索网页",
    read_webpage: "读取网页",
    read_current_page: "读取当前页面",
    web_get_text: "读取页面",
    web_click: "点击网页",
    web_type: "填写网页",
    web_scroll: "滚动网页",
    web_screenshot: "分析网页截图",
    web_browse: "浏览网页",
    open_website: "打开网站",
    web_play_video: "播放网页视频",
  };
  function preferences() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem("lewis_settings") || "{}") || {};
    } catch {
      /* Use defaults if local settings are unavailable. */
    }
    const values = { ...saved, ...(window.lewisGetSettings?.() || {}) };
    return {
      autoReveal: values.browserAutoReveal !== false,
      showActivity: values.browserShowActivity === true,
      muted: values.browserMuted !== false,
    };
  }
  function applyPreferences() {
    const value = preferences();
    $("webObservation").open = value.showActivity;
    void window.electronAPI
      ?.webControl(value.muted ? "mute-on" : "mute-off")
      .catch((error) => {
        $("webPageStatus").textContent = friendly(error);
      });
    schedule();
  }
  function layout() {
    if (!window.electronAPI?.webLayout) return;
    const rect = $("webViewport").getBoundingClientRect();
    const visible =
      !$("webPanel").hidden &&
      document.body.dataset.page !== "plugins" &&
      !$("settingsPanel").classList.contains("open") &&
      $("skillPanel").hidden &&
      !document.querySelector(".browser-more")?.open &&
      !document.querySelector(".desktop-titlebar details[open]") &&
      !document.hidden;
    window.electronAPI.webLayout({
      visible,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }
  function schedule() {
    cancelAnimationFrame(scheduled);
    scheduled = requestAnimationFrame(layout);
  }
  function reveal() {
    $("webPanel").hidden = false;
    document.body.classList.add("web-panel-open");
    schedule();
  }
  function addLog(text) {
    const item = document.createElement("li");
    item.textContent = new Date().toLocaleTimeString() + " " + text;
    $("webActivity").prepend(item);
    while ($("webActivity").children.length > 20)
      $("webActivity").lastChild.remove();
  }
  async function preview(url) {
    current = url;
    $("webAddress").value = url;
    if (!window.electronAPI?.webOpen || openedPreview === url) return;
    const requested = url;
    openedPreview = url;
    try {
      await window.electronAPI.webOpen(url);
    } catch (error) {
      if (current !== requested) return;
      openedPreview = "";
      $("webPageStatus").textContent = friendly(error);
      addLog(friendly(error));
    }
  }
  function activity(tool) {
    if (!names[tool.name]) return;
    if (preferences().autoReveal) reveal();
    const args = tool.args || {};
    const label =
      names[tool.name] +
      (args.query ? "：" + args.query : args.url ? "：" + args.url : "");
    addLog(
      label +
        " · " +
        (tool.state === "running"
          ? "正在执行"
          : tool.state === "done"
            ? "完成"
            : friendly(tool.error)),
    );
    if (tool.state === "running" && tool.name === "web_search" && args.query) {
      void preview(
        "https://www.bing.com/search?q=" +
          encodeURIComponent(args.query) +
          "&adlt=off",
      );
    }
    // 读取时由后端导航；前端不得重复打开同一页面，否则会打断登录和 DOM 读取。
    if (tool.state === "done") {
      const result = tool.result || {};
      if (tool.name === "web_search") {
        const query = result.query || args.query;
        const source = query
          ? "https://www.bing.com/search?q=" +
            encodeURIComponent(query) +
            "&adlt=off"
          : result.source;
        if (source) void preview(source);
      }
      $("webResult").textContent = result.text || "";
      $("webSources").replaceChildren();
      const sources =
        result.results ||
        (result.url
          ? [{ title: result.title || result.url, url: result.url }]
          : []);
      for (const source of sources) {
        try {
          const url = new URL(source.url);
          if (!["http:", "https:"].includes(url.protocol)) continue;
          const button = document.createElement("button");
          button.textContent = source.title || url.hostname;
          button.addEventListener("click", () => void preview(url.href));
          $("webSources").append(button);
        } catch {
          /* 忽略无效来源，不生成可执行链接。 */
        }
      }
      if (tool.name === "open_website") {
        current = result.url || tool.source || args.url || current;
        $("webAddress").value = current;
        openedPreview = current;
      }
    }
  }
  document.addEventListener("DOMContentLoaded", () => {
    applyPreferences();
    window.addEventListener("lewis-settings-changed", applyPreferences);
    document
      .querySelector(".browser-more")
      ?.addEventListener("toggle", schedule);
    document
      .querySelectorAll(".desktop-titlebar details")
      .forEach((menu) => menu.addEventListener("toggle", schedule));
    $("webObservation").addEventListener("toggle", schedule);
    $("webPreferences").addEventListener("click", () => {
      $("settingsBtn").click();
      window.lewisSettingsCategory?.("browser");
    });
    $("openBrowserSettings").addEventListener("click", () => {
      $("settingsClose").click();
      reveal();
    });
    $("webPanelBtn").addEventListener("click", reveal);
    $("webClose").addEventListener("click", () => {
      $("webPanel").hidden = true;
      document.body.classList.remove("web-panel-open");
      schedule();
    });
    $("webNavigate").addEventListener("submit", (event) => {
      event.preventDefault();
      let url = $("webAddress").value.trim();
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      try {
        const target = new URL(url);
        if (!["http:", "https:"].includes(target.protocol))
          throw Error("请输入 HTTP/HTTPS 地址");
        void preview(target.href);
      } catch (error) {
        $("webPageStatus").textContent = friendly(error);
      }
    });
    for (const [id, action] of [
      ["webBack", "back"],
      ["webForward", "forward"],
      ["webReload", "reload"],
      ["webStop", "stop"],
      ["webMute", "mute"],
    ]) {
      $(id).disabled = !window.electronAPI?.webControl;
      $(id).addEventListener(
        "click",
        () =>
          void window.electronAPI?.webControl(action).catch((error) => {
            $("webPageStatus").textContent = friendly(error);
          }),
      );
    }
    $("webExternal").addEventListener("click", () => {
      if (window.electronAPI?.webControl)
        void window.electronAPI.webControl("external").catch((error) => {
          $("webPageStatus").textContent = friendly(error);
        });
      else if (current && /^https?:\/\//i.test(current))
        window.open(current, "_blank", "noopener,noreferrer");
    });
    window.electronAPI?.onWebState((data) => {
      if (data.reveal && preferences().autoReveal) reveal();
      current = data.url || current;
      if (data.url) openedPreview = data.url;
      $("webAddress").value = current;
      $("webPageStatus").textContent =
        (data.error ? friendly(data.error) : "") ||
        (data.state === "loading" ? "网页加载中…" : data.title || "网页已就绪");
      if (data.muted !== undefined)
        $("webMute").textContent = data.muted ? "开启网页声音" : "静音网页";
      if (data.observation)
        activity({
          name: "read_current_page",
          state: "done",
          result: data.observation,
        });
      schedule();
    });
    const hint = $("webViewport").querySelector("small");
    if (hint && !window.electronAPI?.webOpen)
      hint.textContent =
        "完整网页需要桌面版；浏览器版可显示搜索来源与读取结果。";
    if (window.ResizeObserver)
      new ResizeObserver(schedule).observe($("webViewport"));
    new MutationObserver(schedule).observe($("settingsPanel"), {
      attributes: true,
      attributeFilter: ["class"],
    });
    for (const id of ["visionPanel", "skillPanel"])
      new MutationObserver(schedule).observe($(id), {
        attributes: true,
        attributeFilter: ["hidden"],
      });
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
  });
  window.lewisWebPanel = {
    activity,
    reveal,
    suspend: () => window.electronAPI?.webControl("suspend"),
  };
})();
