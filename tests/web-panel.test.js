const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { parseWebsiteCommand } = require("../public/js/website-command");
const { createWebPanel } = require("../electron/web-panel");

test("网站口语解析支持网站名与无协议域名，不把否定或网页引用当作打开命令", () => {
  assert.deepEqual(parseWebsiteCommand("Lewis，帮我打开Pornhub。"), {
    skill: "open-website",
    url: "https://www.pornhub.com/",
  });
  assert.equal(
    parseWebsiteCommand("请打开网站 example.com/path?q=1").url,
    "https://example.com/path?q=1",
  );
  for (const text of [
    "打开Pornhub给我看",
    "我想看 Pornhub",
    "播放pornhub网站",
    "帮我把pornhub打开",
    "请你打开 Porn hub 让我看",
    "用内置浏览器打开Pornhub给我看看",
  ])
    assert.equal(
      parseWebsiteCommand(text).url,
      "https://www.pornhub.com/",
      text,
    );
  for (const text of [
    "不要打开Pornhub",
    "网页说打开Pornhub",
    "如果打开Pornhub",
    "打开记事本",
    "打开 javascript:alert(1)",
  ])
    assert.equal(parseWebsiteCommand(text), null);
});

test("原生侧边网页真实导航、限制视图边界、隔离助手能力，加载错误不报成功", async () => {
  const window = new EventEmitter();
  let visible = true,
    allowed = true,
    external,
    requestPermission,
    checkPermission,
    download;
  const views = [],
    messages = [];
  Object.assign(window, {
    isDestroyed: () => false,
    isVisible: () => visible,
    getContentSize: () => [1180, 840],
    contentView: { addChildView: (view) => views.push(view) },
    webContents: {
      isDestroyed: () => false,
      send: (_name, data) => messages.push(data),
    },
  });
  const isolated = new EventEmitter();
  Object.assign(isolated, {
    setPermissionRequestHandler: (handler) => {
      requestPermission = handler;
    },
    setPermissionCheckHandler: (handler) => {
      checkPermission = handler;
    },
    webRequest: {
      onBeforeRequest: (_filter, handler) => {
        external = handler;
      },
    },
  });
  isolated.on("will-download", (event) => {
    download = event;
  });
  class View {
    constructor(options) {
      this.options = options;
      this.webContents = new EventEmitter();
      const contents = this.webContents;
      let url, muted;
      Object.assign(contents, {
        setAudioMuted: (value) => {
          muted = value;
        },
        isAudioMuted: () => muted,
        getURL: () => url,
        getTitle: () => "测试网页",
        setWindowOpenHandler: (handler) => {
          this.popup = handler;
        },
        stop() {},
        isDestroyed: () => false,
        close: () => {
          this.closed = true;
        },
        loadURL: async (target) => {
          url = target;
          contents.emit("did-start-loading");
          contents.emit("did-navigate", {}, target);
          if (target.includes("failed")) throw Error("ERR_CONNECTION_REFUSED");
          contents.emit("did-finish-load");
        },
      });
    }
    setVisible(value) {
      this.visible = value;
    }
    setBounds(value) {
      this.bounds = value;
    }
  }
  const panel = createWebPanel({
    window,
    WebContentsView: View,
    session: {
      fromPartition: (name) => {
        assert.equal(name, "persist:lewis-web");
        return isolated;
      },
    },
    allowed: () => allowed,
  });
  panel.setLayout({ visible: true, x: 700, y: 160, width: 900, height: 900 });
  await panel.control("mute-off");
  await panel.open("https://example.com/");
  const view = views[0];
  assert.equal(view.options.webPreferences.preload, undefined);
  assert.equal(view.options.webPreferences.nodeIntegration, false);
  assert.equal(view.options.webPreferences.sandbox, true);
  assert.deepEqual(view.bounds, { x: 700, y: 160, width: 480, height: 680 });
  assert.equal(view.visible, true);
  assert.equal(view.webContents.isAudioMuted(), false);
  assert.equal(messages.at(-1).title, "测试网页");
  assert.equal(messages.at(-1).state, "ready");
  await panel.control("mute-on");
  assert.equal(view.webContents.isAudioMuted(), true);
  await panel.control("mute");
  assert.equal(view.webContents.isAudioMuted(), false);
  let grant;
  requestPermission({}, "media", (value) => {
    grant = value;
  });
  assert.equal(grant, false);
  assert.equal(checkPermission(), false);
  let cancel;
  external({ url: "http://localhost:3000/api/skills" }, (result) => {
    cancel = result.cancel;
  });
  assert.equal(cancel, true);
  external({ url: "https://example.com/" }, (result) => {
    cancel = result.cancel;
  });
  assert.equal(cancel, false);
  const event = {
    preventDefault() {
      this.prevented = true;
    },
  };
  isolated.emit("will-download", event);
  assert.equal(download.prevented, true);
  visible = false;
  window.emit("hide");
  assert.equal(view.visible, false);
  visible = true;
  window.emit("show");
  assert.equal(view.visible, true);
  panel.setLayout({ visible: false });
  assert.equal(view.visible, false);
  await assert.rejects(
    panel.open("https://failed.example/"),
    /ERR_CONNECTION_REFUSED/,
  );
  assert.equal(messages.at(-1).state, "error");
  allowed = false;
  await assert.rejects(panel.open("https://example.com"), /权限/);
  panel.destroy();
  assert.equal(view.closed, true);
});

test("HUD 侧边显示真实搜索/读取结果，安全呈现文本，收起和设置遮罩隐藏原生网页", async () => {
  const dom = new JSDOM(
    fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8"),
    {
      url: "http://localhost:3000",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const window = dom.window;
  const opened = [],
    layouts = [];
  let notify;
  window.electronAPI = {
    webOpen: async (url) => opened.push(url),
    webLayout: (data) => layouts.push(data),
    webControl: async () => {},
    onWebState: (fn) => {
      notify = fn;
    },
  };
  window.eval(
    fs.readFileSync(path.join(__dirname, "../public/js/web-panel.js"), "utf8"),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  const $ = (id) => window.document.getElementById(id);
  window.lewisWebPanel.activity({
    name: "web_search",
    state: "running",
    args: { query: "测试网页" },
  });
  window.lewisWebPanel.activity({
    name: "web_search",
    state: "done",
    result: {
      text: "<script>danger()</script>这是实际搜索结果",
      results: [{ title: "测试来源", url: "https://example.com/" }],
    },
  });
  assert.equal($("webPanel").hidden, false);
  assert.equal(
    opened[0],
    "https://www.bing.com/search?q=" +
      encodeURIComponent("测试网页") +
      "&adlt=off",
  );
  assert.match($("webResult").textContent, /实际搜索结果/);
  assert.equal($("webResult").querySelector("script"), null);
  $("webSources").firstChild.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(opened[1], "https://example.com/");
  $("settingsPanel").classList.add("open");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(layouts.at(-1).visible, false);
  $("settingsPanel").classList.remove("open");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(layouts.at(-1).visible, true);
  const menu = window.document.querySelector(".desktop-titlebar details");
  menu.open = true;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(layouts.at(-1).visible, false, "顶栏菜单不会被原生网页盖住");
  menu.open = false;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(layouts.at(-1).visible, true);
  $("visionPanel").hidden = false;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(layouts.at(-1).visible, true);
  assert.equal($("visionPanel").parentElement.classList.contains("main"), true);
  assert.equal(
    window.document
      .querySelector(".lewis-toolbar")
      .parentElement.classList.contains("main"),
    true,
  );
  assert.equal(
    window.getComputedStyle(window.document.querySelector(".lewis-toolbar"))
      .position,
    "static",
  );
  assert.equal(window.getComputedStyle($("visionPanel")).position, "static");
  notify({
    reveal: true,
    url: "https://example.com/",
    title: "测试网页",
    state: "ready",
  });
  assert.equal($("webAddress").value, "https://example.com/");
  $("webClose").click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(layouts.at(-1).visible, false);
  assert.equal($("webPanel").hidden, true);
  window.close();
});
