const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { friendlyError } = require("../public/js/friendly-errors");
test("网站搜索不按站点名或口语用词拦截；复合网页任务识别目标", () => {
  const {
    parseSearchCommand,
    parseBrowserTask,
  } = require("../public/js/website-command");
  assert.equal(parseSearchCommand("Lewis，帮我搜索Pornhub").query, "Pornhub");
  assert.equal(
    parseSearchCommand("请搜索这破网站怎么这么慢").query,
    "这破网站怎么这么慢",
  );
  assert.equal(parseSearchCommand("不要搜索网站"), null);
  assert.equal(parseSearchCommand("搜哔哩哔哩").query, "哔哩哔哩");
  assert.equal(parseSearchCommand("搜索哔哩哔哩然后播放一个热门视频"), null);
  assert.equal(
    parseBrowserTask("帮我打开bilibili播放一个热门视频").url,
    "https://www.bilibili.com/v/popular/all",
  );
  assert.equal(parseBrowserTask("不要打开bilibili播放一个视频"), null);
});
test("小上下文保留网页读取/点击/播放工具，撤权后无工具；英文异常显示中文且未知发送不重试", () => {
  const { selectConversationTools } = require("../lib/conversation-tools"),
    { toolsFor } = require("../lib/tools");
  const selected = selectConversationTools(
    toolsFor({ value: { web: true, computer: true, wechat: false } }),
    "打开网站播放视频",
    4096,
  ).map((tool) => tool.function.name);
  assert.ok(selected.includes("web_get_text"));
  assert.ok(selected.includes("web_click"));
  assert.ok(selected.includes("web_play_video"));
  assert.equal(
    selectConversationTools(
      toolsFor({ value: { web: false, computer: false, wechat: false } }),
      "播放视频",
      4096,
    ).length,
    0,
  );
  assert.match(friendlyError("net::ERR_NAME_NOT_RESOLVED"), /找不到/);
  assert.doesNotMatch(
    friendlyError("TypeError: Cannot read property"),
    /TypeError/,
  );
  assert.match(friendlyError("发送状态未确认，可能已经发送"), /不会自动重发/);
});
test("视频上拉收起、语音下拉收起及点击恢复，折叠状态持久化且不关闭设备", () => {
  const dom = new JSDOM(
      fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8"),
      { url: "http://localhost:3000", runScripts: "outside-only" },
    ),
    w = dom.window;
  w.eval(
    fs.readFileSync(
      path.join(__dirname, "../public/js/panel-folds.js"),
      "utf8",
    ),
  );
  const handle = w.document.getElementById("cameraFold"),
    camera = w.document.getElementById("visionPanel"),
    voiceHandle = w.document.getElementById("voiceControlsFold");
  handle.dispatchEvent(
    new w.MouseEvent("pointerdown", { button: 0, clientY: 100 }),
  );
  handle.dispatchEvent(new w.MouseEvent("pointerup", { clientY: 40 }));
  handle.click();
  assert.equal(camera.classList.contains("collapsed"), true);
  handle.click();
  assert.equal(camera.classList.contains("collapsed"), false);
  voiceHandle.click();
  assert.equal(
    w.document.querySelector(".lewis-toolbar").classList.contains("collapsed"),
    true,
  );
  assert.equal(
    JSON.parse(w.localStorage.getItem("lewis_panel_folds")).voice,
    true,
  );
  assert.equal(w.document.querySelector('[title="视觉"]'), null);
  assert.equal(w.document.querySelector('[title="语音"]'), null);
  w.close();
});
test("第二次搜索替换旧网站，旧导航失败不盖过新查询", async () => {
  const dom = new JSDOM(
      fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8"),
      {
        url: "http://localhost:3000",
        runScripts: "outside-only",
        pretendToBeVisual: true,
      },
    ),
    w = dom.window;
  const opened = [];
  let rejectFirst;
  w.electronAPI = {
    webOpen: (url) => {
      opened.push(url);
      return opened.length === 1
        ? new Promise((_, reject) => {
            rejectFirst = reject;
          })
        : Promise.resolve();
    },
    webLayout() {},
    webControl: async () => {},
    onWebState() {},
  };
  w.lewisFriendlyError = friendlyError;
  w.eval(
    fs.readFileSync(path.join(__dirname, "../public/js/web-panel.js"), "utf8"),
  );
  w.lewisWebPanel.activity({
    name: "web_search",
    state: "running",
    args: { query: "Pornhub" },
  });
  w.lewisWebPanel.activity({
    name: "web_search",
    state: "running",
    args: { query: "哔哩哔哩" },
  });
  rejectFirst(Error("ERR_CONNECTION_REFUSED"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(opened.length, 2);
  assert.match(
    w.document.getElementById("webAddress").value,
    new RegExp(encodeURIComponent("哔哩哔哩")),
  );
  assert.doesNotMatch(
    w.document.getElementById("webPageStatus").textContent,
    /ERR_|连接上/,
  );
  w.close();
});
