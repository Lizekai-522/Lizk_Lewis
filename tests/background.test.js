const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { waitForVoiceService } = require("../electron/voice-ready");

test("现有语音服务在线直接监听；冷启动等到服务就绪后再继续", async () => {
  let starts = 0,
    checks = 0;
  await waitForVoiceService({
    checkHealth: async () => true,
    startService: () => starts++,
  });
  assert.equal(starts, 0);
  await waitForVoiceService({
    checkHealth: async () => {
      if (++checks < 3) throw new Error("正在启动");
      return true;
    },
    startService: () => starts++,
    sleep: async () => {},
  });
  assert.equal(starts, 1);
  assert.equal(checks, 3);
});

test("语音准备取消与超时不会宣布监听已启动", async () => {
  let stopped = false;
  await assert.rejects(
    waitForVoiceService({
      checkHealth: async () => false,
      startService() {},
      sleep: async () => {
        stopped = true;
      },
      isStopped: () => stopped,
    }),
    /取消/,
  );
  await assert.rejects(
    waitForVoiceService({
      checkHealth: async () => false,
      startService() {},
      sleep: async () => {},
      attempts: 2,
    }),
    /超时/,
  );
});

test("桌面启动隐藏双窗口，唤醒只显示桌宠，托盘恢复和暂停不会退出服务", async () => {
  const windows = [],
    handlers = new Map();
  let menu, tooltip;
  const errors = [];
  const app = new EventEmitter();
  Object.assign(app, {
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getPath: () => "test-profile",
    quit() {},
  });
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = options.show;
      this.messages = [];
      this.url = "";
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        id: windows.length + 1,
        isDestroyed: () => Boolean(this.destroyed),
        setWindowOpenHandler() {},
        getURL: () => this.url,
        send: (name, data) => this.messages.push([name, data]),
      });
      windows.push(this);
    }
    async loadURL(url) {
      this.url = new URL(url).href;
    }
    isDestroyed() {
      return Boolean(this.destroyed);
    }
    show() {
      this.visible = true;
      this.shows = (this.shows || 0) + 1;
    }
    showInactive() {
      this.visible = true;
      this.inactiveShows = (this.inactiveShows || 0) + 1;
    }
    isVisible() {
      return this.visible;
    }
    hide() {
      this.visible = false;
      this.hides = (this.hides || 0) + 1;
      this.emit("hide");
    }
    focus() {
      this.focused = true;
    }
    setSkipTaskbar(value) {
      this.skipTaskbar = value;
    }
  }
  const electron = {
    app,
    BrowserWindow: Window,
    screen: {
      getPrimaryDisplay: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler(fn) {
          this.request = fn;
        },
        setPermissionCheckHandler(fn) {
          this.check = fn;
        },
      },
    },
    ipcMain: {
      on: (name, fn) => handlers.set(name, fn),
      handle: (name, fn) => handlers.set(name, fn),
    },
    Menu: { setApplicationMenu() {}, buildFromTemplate: (items) => items },
    nativeImage: { createFromBitmap() {} },
    shell: {},
    Tray: class extends EventEmitter {
      setToolTip(value) {
        tooltip = value;
      }
      setContextMenu(value) {
        menu = value;
      }
      displayBalloon() {}
    },
    dialog: { showErrorBox: (...args) => errors.push(args) },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8"),
    {
      Buffer,
      process: { env: { LEWIS_EXTERNAL_VOICE: "1" } },
      __dirname: path.join(__dirname, "../electron"),
      require: (name) =>
        name === "electron"
          ? electron
          : name === "node:fs"
            ? { existsSync: () => false }
            : name === "../server"
              ? {
                  capabilities: { value: { computer: true } },
                  setDesktopActions() {},
                  start: async () => ({
                    address: () => ({ port: 3000 }),
                    close() {},
                  }),
                }
              : name === "./window-lifecycle"
                ? require("../electron/window-lifecycle")
                : name === "./web-panel"
                  ? require("../electron/web-panel")
                  : name === "./dafeiyu-pet"
                    ? require("../electron/dafeiyu-pet")
                    : name === "./pet-interaction"
                      ? {
                          createPetInteraction: () => ({
                            refresh() {},
                            setDragging() {},
                            report() {},
                            destroy() {},
                          }),
                        }
                      : require(name),
    },
  );
  for (let i = 0; i < 10 && (!menu || !windows[0]?.url); i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, []);
  assert.equal(windows.length, 2);
  const [main, pet] = windows;
  const event = { sender: main.webContents, senderFrame: { url: main.url } };
  assert.equal(main.visible, false);
  assert.equal(pet.visible, false);
  assert.equal(main.options.webPreferences.backgroundThrottling, false);
  assert.equal(main.options.skipTaskbar, true);
  handlers.get("lewis:show-pet")({
    ...event,
    senderFrame: { url: "https://untrusted.example/" },
  });
  assert.equal(pet.visible, false);
  handlers.get("lewis:show-pet")(event);
  assert.equal(pet.visible, true);
  assert.equal(main.visible, false);
  assert.equal(main.focused, undefined);
  assert.equal(pet.options.focusable, false);
  assert.equal(pet.shows, undefined);
  assert.equal(pet.inactiveShows, 1);
  assert.equal(pet.focused, undefined);
  menu.find((item) => item.label === "打开主界面").click();
  assert.equal(main.visible, true);
  assert.equal(main.skipTaskbar, false);
  handlers.get("lewis:show-pet")(event);
  assert.equal(pet.visible, true);
  assert.equal(main.visible, true);
  assert.equal(main.skipTaskbar, false);
  assert.equal(main.hides, undefined);
  assert.equal(pet.inactiveShows, 1); // 不隐藏主界面，也不重复显示桌宠。
  menu.find((item) => item.label.startsWith("进入后台")).click();
  assert.equal(main.visible, false);
  assert.equal(pet.visible, false);
  assert.equal(main.skipTaskbar, true);
  assert.equal(main.messages.at(-1)[1].type, "background-listen");
  menu.find((item) => item.label === "暂停麦克风").click();
  assert.equal(main.messages.at(-1)[1].type, "pause-listening");
  handlers.get("lewis:voice-status")(event, {
    mode: "wake",
    label: "等待唤醒",
  });
  assert.match(tooltip, /后台唤醒监听/);

  // 复现真实 Electron 的 getter：窗口销毁后读取 webContents 即抛错。
  const petContents = pet.webContents;
  const petEvent = { sender: petContents, senderFrame: { url: pet.url } };
  pet.destroyed = true;
  Object.defineProperty(pet, "webContents", {
    get() {
      throw new TypeError("Object has been destroyed");
    },
  });
  assert.doesNotThrow(() =>
    handlers.get("lewis:web-layout")(event, { visible: false }),
  );
  assert.equal(handlers.get("lewis:voice-ready")(event), true); // 活着的主窗口仍可调用。
  assert.doesNotThrow(() =>
    handlers.get("lewis:message")(event, { type: "state" }),
  );
  assert.doesNotThrow(() => handlers.get("lewis:hide-pet")(event));
  assert.doesNotThrow(() =>
    handlers.get("lewis:pet-hit-regions")(petEvent, []),
  );
  assert.doesNotThrow(() =>
    menu.find((item) => item.label.startsWith("进入后台")).click(),
  );
  main.destroyed = true;
  Object.defineProperty(main, "webContents", {
    get() {
      throw new TypeError("Object has been destroyed");
    },
  });
  assert.doesNotThrow(() =>
    handlers.get("lewis:web-layout")(event, { visible: true }),
  );
  assert.throws(
    () => handlers.get("lewis:web-open")(event, "https://example.com/"),
    /来源无效/,
  );
  const permissions = electron.session.defaultSession;
  let granted;
  assert.doesNotThrow(() =>
    permissions.request(event.sender, "media", (value) => {
      granted = value;
    }),
  );
  assert.equal(granted, false);
  assert.equal(permissions.check(event.sender, "media", main.url), false);
  app.emit("before-quit");
  assert.doesNotThrow(() => handlers.get("lewis:show-pet")(event));
  assert.doesNotThrow(() =>
    handlers.get("lewis:voice-status")(event, {
      mode: "wake",
      label: "等待唤醒",
    }),
  );
});
