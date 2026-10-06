const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DesktopApps } = require("../lib/desktop-apps");
const { MusicService } = require("../lib/music");
const { parseDesktopCommand } = require("../public/js/desktop-command");
const { toolsFor, parseTool, checkUserAction } = require("../lib/tools");
const { selectConversationTools } = require("../lib/conversation-tools");
const { executeSkill } = require("../lib/skills");
const entries = [
  { name: "QQ音乐", executable: "C:\\Apps\\QQMusic.exe" },
  { name: "QQ Music", executable: "C:\\Apps\\QQMusic.exe" },
  { name: "测试软件", executable: "C:\\Apps\\Example.exe" },
  { name: "命令提示符", executable: "C:\\Windows\\System32\\cmd.exe" },
];
const native = {
  windowId: "123",
  controls: [
    {
      path: "m/1",
      name: "搜索",
      role: 42,
      x: 10,
      y: 10,
      width: 100,
      height: 20,
      source: "msaa",
    },
    {
      path: "m/2",
      name: "播放",
      role: 43,
      x: 20,
      y: 40,
      width: 40,
      height: 25,
      source: "msaa",
    },
  ],
};
test("语音打开应用和QQ音乐任务不需要标点，歌曲名、暂停和继续保留", () => {
  assert.deepEqual(parseDesktopCommand("lewis帮我打开qq音乐我想听歌"), {
    skill: "music-play",
    query: "",
  });
  assert.deepEqual(parseDesktopCommand("请打开QQ音乐，我想听周杰伦的晴天"), {
    skill: "music-play",
    query: "周杰伦的晴天",
  });
  assert.deepEqual(parseDesktopCommand("用QQ音乐播放《晴天》"), {
    skill: "music-play",
    query: "晴天",
  });
  assert.deepEqual(parseDesktopCommand("打开QQ音乐"), {
    skill: "open-app",
    app: "QQ音乐",
  });
  assert.deepEqual(parseDesktopCommand("帮我打开网易云音乐软件"), {
    skill: "open-app",
    app: "网易云音乐",
  });
  assert.deepEqual(parseDesktopCommand("暂停QQ音乐"), {
    skill: "music-control",
    action: "pause",
  });
  assert.deepEqual(parseDesktopCommand("继续播放QQ音乐"), {
    skill: "music-control",
    action: "play",
  });
  assert.equal(parseDesktopCommand("打开计算器然后整理文件"), null);
  assert.equal(parseDesktopCommand("打开C:\\Windows\\cmd.exe"), null);
});
test("本机应用目录合并同一软件别名，支持名称与ID，不能把用户输入当成程序路径", async () => {
  let discoveries = 0;
  const desktop = new DesktopApps({
    discover: async () => {
      discoveries++;
      return entries;
    },
  });
  assert.equal((await desktop.list()).total, 2);
  const app = await desktop.resolve("qq music");
  assert.equal(
    (await desktop.resolve(app.id)).executable,
    "C:\\Apps\\QQMusic.exe",
  );
  assert.equal((await desktop.resolve("QQ音乐")).id, app.id);
  assert.equal(discoveries, 1);
  const launched = [];
  await desktop.open("测试软件", {
    launchApp: async (...args) => launched.push(args),
  });
  assert.deepEqual(launched, [
    ["C:\\Apps\\Example.exe", [], { visible: true }],
  ]);
  await assert.rejects(desktop.resolve("C:\\Apps\\Example.exe"), /应用名称/);
  await assert.rejects(desktop.resolve("cmd.exe"), /没有找到/);
  await assert.rejects(desktop.resolve("不存在的软件"), /没有找到/);
});
test("同名应用不猜测；检测期间取消不会启动应用", async () => {
  const desktop = new DesktopApps({
    discover: async () => [
      { name: "测试", executable: "C:\\A.exe" },
      { name: "测试", executable: "C:\\B.exe" },
    ],
  });
  await assert.rejects(desktop.resolve("测试"), /多个应用/);
  const controller = new AbortController();
  let launched = false;
  const cancelled = new DesktopApps({
    discover: async () => {
      controller.abort();
      return entries;
    },
  });
  await assert.rejects(
    cancelled.open("QQ音乐", {
      signal: controller.signal,
      launchApp: async () => {
        launched = true;
      },
    }),
    /abort/i,
  );
  assert.equal(launched, false);
});
test("应用操作绑定本轮真实窗口和控件，快照过期、伪造编号和复用均停止", async () => {
  let now = 1000;
  const requests = [];
  const desktop = new DesktopApps({
    discover: async () => entries,
    now: () => now,
    runner: async (request) => {
      requests.push(request);
      return request.action === "read" ? native : { ok: true, performed: true };
    },
  });
  let snapshot = await desktop.read("QQ音乐");
  await assert.rejects(
    desktop.action({
      snapshotId: snapshot.snapshotId,
      ref: "1e0",
      kind: "click",
    }),
    /失效/,
  );
  await desktop.action({
    snapshotId: snapshot.snapshotId,
    ref: "2",
    kind: "click",
  });
  assert.equal(requests.at(-1).windowId, "123");
  assert.equal(requests.at(-1).path, "m/2");
  assert.equal(requests.at(-1).name, "播放");
  await assert.rejects(
    desktop.action({
      snapshotId: snapshot.snapshotId,
      ref: "2",
      kind: "click",
    }),
    /失效/,
  );
  snapshot = await desktop.read("QQ音乐");
  now += 120001;
  await assert.rejects(
    desktop.action({
      snapshotId: snapshot.snapshotId,
      ref: "1",
      kind: "type",
      text: "hello",
    }),
    /失效/,
  );
  snapshot = await desktop.read("QQ音乐");
  await assert.rejects(
    desktop.action({
      snapshotId: snapshot.snapshotId,
      ref: "1",
      kind: "type",
      text: "hello\n",
    }),
    /控制字符/,
  );
});
test("QQ音乐推荐播放由真实媒体状态确认，点击后没有新播放不能宣称完成", async () => {
  const clicks = [];
  const desktop = {
    snapshots: {
      get: () => ({
        controls: [
          {},
          { x: 30, y: 100, width: 40, height: 30 },
          { x: 30, y: 200, width: 200, height: 20 },
        ],
      }),
    },
    open: async () => {},
    read: async (_name, options) =>
      options.ocr
        ? {
            snapshotId: "rec",
            targets: [
              { ref: "2", name: "图像播放按钮", source: "ocr" },
              { ref: "3", name: "猎你喜欢一沉浸刷歌", source: "ocr" },
            ],
          }
        : {
            snapshotId: "home",
            targets: [
              { ref: "1", name: "推荐", role: 16 },
              { ref: "4", name: "随机播放", role: 43 },
            ],
          },
    action: async (request) => clicks.push(request),
  };
  let reads = 0;
  const music = new MusicService({
    desktop,
    wait: async () => {},
    media: async () =>
      ++reads === 1
        ? { available: true, playing: true, title: "原歌曲", position: 12 }
        : {
            available: true,
            playing: true,
            title: "推荐歌曲",
            artist: "歌手",
            position: 1,
          },
  });
  const result = await music.play("");
  assert.equal(result.playing, true);
  assert.equal(result.mode, "recommend");
  assert.match(result.text, /推荐歌曲/);
  assert.deepEqual(
    clicks.map((c) => c.ref),
    ["1", "2"],
  );
  const failed = new MusicService({
    desktop,
    wait: async () => {},
    media: async () => ({
      available: true,
      playing: true,
      title: "原歌曲",
      position: 12,
    }),
  });
  await assert.rejects(failed.play(""), /没有确认开始播放/);
});
test("QQ音乐页面变化只重新读取未执行的点击；取消立即停止；权限关闭不操作", async () => {
  let clicks = 0;
  const desktop = {
    snapshots: {
      get: () => ({
        controls: [
          {},
          { x: 30, y: 100, width: 40, height: 30 },
          { x: 30, y: 200, width: 200, height: 20 },
        ],
      }),
    },
    open: async () => {},
    read: async (_name, options) =>
      options.ocr
        ? {
            snapshotId: "rec",
            targets: [
              { ref: "2", name: "图像播放按钮", source: "ocr" },
              { ref: "3", name: "猜你喜欢", source: "ocr" },
            ],
          }
        : {
            snapshotId: "home",
            targets: [
              { ref: "1", name: "推荐", role: 16 },
              { ref: "4", name: "随机播放", role: 43 },
            ],
          },
    action: async (request) => {
      if (request.ref === "2" && ++clicks === 1)
        throw Error("应用内容已变化，请重新读取后操作");
    },
  };
  let reads = 0;
  const music = new MusicService({
    desktop,
    wait: async () => {},
    media: async () => ({
      available: true,
      playing: ++reads > 1,
      title: reads > 1 ? "新歌曲" : "旧歌曲",
      position: 0,
    }),
  });
  assert.equal((await music.play("")).playing, true);
  assert.equal(clicks, 2);
  await assert.rejects(
    executeSkill({ skill: "music-play" }, "", {
      capabilities: {
        require() {
          throw Error("电脑权限关闭");
        },
      },
      desktop,
    }),
    /权限关闭/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(music.play("", { signal: controller.signal }), /abort/i);
});
test("电脑操作关闭时工具全部撤销，小上下文仍给QQ音乐和桌面工具", () => {
  const caps = { value: { computer: true, web: false, wechat: false } };
  const tools = toolsFor(caps);
  assert.equal(
    tools.find((t) => t.function.name === "open_app").function.parameters
      .properties.app.enum,
    undefined,
  );
  const selected = selectConversationTools(
    tools,
    "打开QQ音乐我想听歌",
    4096,
  ).map((t) => t.function.name);
  for (const name of [
    "music_play",
    "music_control",
    "desktop_get_window",
    "desktop_click",
    "list_apps",
  ])
    assert.ok(selected.includes(name));
  assert.equal(
    toolsFor({ value: { computer: false, web: false, wechat: false } }).length,
    0,
  );
  assert.deepEqual(
    parseTool({ function: { name: "music_play", arguments: "{}" } }),
    { skill: "music-play" },
  );
  assert.throws(
    () => checkUserAction({ skill: "desktop-click" }, "今天心情怎么样"),
    /没有要求/,
  );
});
