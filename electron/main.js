"use strict";
const {
  app,
  BrowserWindow,
  WebContentsView,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  dialog,
  session,
  screen,
  shell,
  desktopCapturer,
  utilityProcess,
  crashReporter,
  safeStorage,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { palettes } = require("../public/js/appearance");
const { spawn } = require("node:child_process");
const {
  liveContents,
  isWindowSender,
  isTrustedSender,
  sendToWindow,
} = require("./window-lifecycle");
// 保留 localhost 来源下的原设置，同时将 Chromium 的 localhost 解析固定为 IPv4。
// 避免旧服务监听 ::1:3000 时，桌面页面误连旧后端。
app.commandLine.appendSwitch("host-resolver-rules", "MAP localhost 127.0.0.1");
let mainWindow,
  gestureWindow,
  petWindow,
  petInteraction,
  webPanel,
  webProxy,
  tray,
  nodeServer,
  voiceChild;
let dafeiyuPet,
  petStyle = "classic";
let quitting = false;
let origin;
let voiceConfig = {};
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMain());
  app
    .whenReady()
    .then(boot)
    .catch((error) => {
      dialog.showErrorBox("Lewis 启动失败", error.message);
      app.quit();
    });
}
function trusted(event) {
  return !quitting && isTrustedSender(event, [mainWindow, petWindow], origin);
}
function showMain() {
  if (!quitting && liveContents(mainWindow)) {
    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
    mainWindow.focus();
  }
}
function showPet() {
  if (!quitting && petStyle === "dafeiyu" && dafeiyuPet?.active()) {
    dafeiyuPet.send({ type: "show" });
    return;
  }
  if (quitting || !liveContents(petWindow)) return;
  // 唤醒仅显示不参与焦点切换的桌宠；重复唤醒不重新显示窗口。
  if (!petWindow.isVisible()) petWindow.showInactive();
  petInteraction?.refresh();
}
function enterBackground() {
  if (quitting) return;
  if (liveContents(mainWindow)) mainWindow.hide();
  if (liveContents(petWindow)) petWindow.hide();
  sendToWindow(mainWindow, "lewis:message", { type: "background-listen" });
  dafeiyuPet?.send({ type: "hide" });
}
function voiceRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "voice-service")
    : path.join(__dirname, "../voice-service");
}
function launchVoice() {
  if (voiceChild) return;
  const interpreter =
    process.env.LEWIS_PYTHON ||
    voiceConfig.python ||
    (!app.isPackaged
      ? path.join(__dirname, "../.venv/Scripts/python.exe")
      : "");
  if (!interpreter || !fs.existsSync(interpreter)) return;
  const logs = path.join(app.getPath("userData"), "voice-service.log");
  const modelData = app.isPackaged
    ? app.getPath("userData")
    : path.join(__dirname, "../data");
  const fd = fs.openSync(logs, "a");
  voiceChild = spawn(interpreter, [path.join(voiceRoot(), "app.py")], {
    cwd: voiceRoot(),
    windowsHide: true,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      LEWIS_WAKE_MODEL: app.isPackaged
        ? path.join(process.resourcesPath, "wake-models")
        : path.join(__dirname, "../models/wake"),
      LEWIS_VOICE_DATA: modelData,
      MODELSCOPE_CACHE:
        process.env.MODELSCOPE_CACHE || path.join(modelData, "models"),
      MODELSCOPE_HOME:
        process.env.MODELSCOPE_HOME ||
        path.join(modelData, "modelscope-config"),
      HF_HOME: process.env.HF_HOME || path.join(modelData, "huggingface"),
      VOICE_PORT: "5001",
    },
  });
  fs.closeSync(fd);
  voiceChild.once("error", (error) => {
    voiceChild = null;
    dialog.showErrorBox("语音服务启动失败", error.message);
  });
  voiceChild.once("exit", (code) => {
    voiceChild = null;
    if (!quitting && code && code !== 0)
      tray?.displayBalloon({
        title: "语音服务未启动",
        content:
          "请从托盘配置安装了 requirements.txt 的 Python 环境。诊断信息保存在 voice-service.log。",
      });
  });
}
async function configurePython() {
  const selected = await dialog.showOpenDialog({
    title: "选择已安装语音依赖的 python.exe",
    properties: ["openFile"],
    filters: [{ name: "Python", extensions: ["exe"] }],
  });
  if (selected.canceled) return;
  if (path.basename(selected.filePaths[0]).toLowerCase() !== "python.exe") {
    dialog.showErrorBox(
      "请选择 Python",
      "需要安装了 voice-service/requirements.txt 的 python.exe",
    );
    return;
  }
  voiceConfig.python = selected.filePaths[0];
  fs.writeFileSync(
    path.join(app.getPath("userData"), "voice-config.json"),
    JSON.stringify(voiceConfig),
  );
  if (voiceChild) {
    voiceChild.once("exit", launchVoice);
    voiceChild.kill();
  } else launchVoice();
}
async function boot() {
  Menu.setApplicationMenu(null);
  process.env.LEWIS_DATA_DIR = path.join(app.getPath("userData"), "history");
  const mainLogger = new (require("../lib/logger").Logger)(
    path.join(app.getPath("userData"), "logs"),
  );
  mainLogger.install();
  crashReporter?.start({
    productName: "Lewis",
    companyName: "Lewis",
    uploadToServer: false,
    submitURL: "https://invalid.local/disabled",
  });
  const configPath = path.join(app.getPath("userData"), "voice-config.json");
  if (fs.existsSync(configPath))
    voiceConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const credentials = utilityProcess
    ? require("./credential-vault").createCredentialVault(
        app.getPath("userData"),
        safeStorage,
      )
    : null;
  if (credentials) await credentials.initialize();
  const backend = utilityProcess
    ? require("./backend-service").createBackendService({
        fork: (...args) => utilityProcess.fork(...args),
        getMaster: () => credentials.getMaster(),
        onExit: (code) => {
          if (!quitting) {
            sendToWindow(mainWindow, "lewis:message", {
              type: "backend-failed",
              text:
                "工具服务已停止（" +
                code +
                "），当前操作不会自动重发。请从托盘重启。",
            });
            tray?.displayBalloon({
              title: "Lewis 工具服务停止",
              content: "界面与语音窗口仍在运行；可从托盘重启工具服务。",
            });
          }
        },
        log: (level, text) => mainLogger.write(level, "工具服务", { text }),
      })
    : require("../server");
  backend.setDesktopActions({
    openWebsite: (url) => webPanel.open(url),
    readBrowser: (options) => webPanel.read(options),
    browserAction: (options) => webPanel.act(options),
  });
  // Electron 使用固定端口保留 localStorage；端口冲突明确报错，不接管未知服务。
  nodeServer = await backend.start(Number(process.env.PORT || 3000));
  origin = `http://localhost:${nodeServer.address().port}`;
  webProxy = require("../lib/public-web-proxy").createPublicWebProxy({
    allowed: () =>
      backend.capabilities.value.web && backend.capabilities.value.computer,
  });
  const proxyAddress = await webProxy.start();
  session.defaultSession.setPermissionRequestHandler(
    (contents, permission, callback) => {
      let permitted = false;
      try {
        permitted =
          !quitting &&
          permission === "media" &&
          (isWindowSender({ sender: contents }, mainWindow) ||
            isWindowSender({ sender: contents }, gestureWindow)) &&
          contents.getURL().startsWith(origin + "/");
      } catch {
        /* 已关闭的摄像头/麦克风请求必须拒绝。 */
      }
      callback(permitted);
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin) => {
      try {
        return (
          !quitting &&
          permission === "media" &&
          (isWindowSender({ sender: contents }, mainWindow) ||
            isWindowSender({ sender: contents }, gestureWindow)) &&
          new URL(requestingOrigin).origin === origin
        );
      } catch {
        return false;
      }
    },
  );
  const preferences = {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
    autoplayPolicy: "no-user-gesture-required",
  };
  // 隐藏窗口仍持有录音与会话；保留托盘入口，关闭界面不结束监听。
  mainWindow = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 1180,
    height: 840,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: "#070f1c",
    titleBarStyle: "hidden",
    titleBarOverlay: palettes.tech,
    title: "李维斯 Lewis",
    webPreferences: preferences,
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    mainLogger.write("error", "界面进程退出", details);
    if (!quitting)
      tray?.displayBalloon({
        title: "Lewis 界面停止",
        content: "后台服务独立运行。请从托盘重新打开或重启 Lewis。",
      });
  });
  mainWindow.on("hide", () => {
    if (liveContents(mainWindow)) mainWindow.setSkipTaskbar(true);
  });
  webPanel = require("./web-panel").createWebPanel({
    window: mainWindow,
    WebContentsView,
    session,
    proxyAddress,
    allowed: () =>
      backend.capabilities.value.web && backend.capabilities.value.computer,
  });
  const mainSender = (event) =>
    trusted(event) && isWindowSender(event, mainWindow);
  dafeiyuPet = require("./dafeiyu-pet").createDafeiyuPet({
    app,
    onTask: (text) =>
      sendToWindow(mainWindow, "lewis:message", { type: "pet-task", text }),
    onOpen: showMain,
    onUnavailable: () => {
      petStyle = "classic";
      showPet();
    },
  });
  ipcMain.handle("lewis:pet-style", async (event, style) => {
    if (!mainSender(event) || !["classic", "dafeiyu"].includes(style))
      throw Error("桌宠样式无效");
    if (style === "classic") {
      petStyle = style;
      dafeiyuPet.send({ type: "hide" });
      return { style };
    }
    if (
      process.env.LEWIS_DISABLE_DAFEIYU === "1" ||
      !(await dafeiyuPet.start())
    )
      return { style: "classic", text: "大肥鱼组件尚未就绪，已保留原桌宠" };
    petStyle = style;
    if (liveContents(petWindow)) petWindow.hide();
    return { style };
  });
  ipcMain.handle("lewis:open-gestures", async (event, id) => {
    if (!mainSender(event)) throw Error("来源无效");
    if (typeof id !== "string" || (id && !/^g_[a-z0-9_-]{1,32}$/.test(id)))
      throw Error("手势编号无效");
    if (!liveContents(gestureWindow)) {
      gestureWindow = new BrowserWindow({
        width: 980,
        height: 780,
        minWidth: 700,
        minHeight: 600,
        title: "Lewis · 手势工作室",
        titleBarStyle: "hidden",
        titleBarOverlay: palettes.tech,
        webPreferences: preferences,
      });
      gestureWindow.setMenu(null);
      gestureWindow.webContents.setWindowOpenHandler(() => ({
        action: "deny",
      }));
      gestureWindow.webContents.on("will-navigate", (event, url) => {
        if (new URL(url).origin !== origin) event.preventDefault();
      });
      gestureWindow.on("closed", () => {
        gestureWindow = null;
      });
    }
    await gestureWindow.loadURL(
      origin + "/gestures" + (id ? "?id=" + encodeURIComponent(id) : ""),
    );
    gestureWindow.show();
    gestureWindow.focus();
    return true;
  });
  const studioSender = (event) =>
    !quitting && isTrustedSender(event, [gestureWindow], origin);
  ipcMain.on("lewis:close-gestures", (event) => {
    if (studioSender(event)) gestureWindow.close();
  });
  ipcMain.on("lewis:appearance", (event, theme) => {
    if (!mainSender(event) && !studioSender(event)) return;
    if (!Object.hasOwn(palettes, theme)) return;
    const window = isWindowSender(event, mainWindow)
      ? mainWindow
      : gestureWindow;
    window.setTitleBarOverlay(palettes[theme]);
  });
  const updateManager = utilityProcess
    ? require("./update-manager").createUpdateManager({
        app,
        updater: require("electron-updater").autoUpdater,
        directory: app.getPath("userData"),
        portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
        logger: mainLogger,
        notify: (data) => sendToWindow(mainWindow, "lewis:update", data),
      })
    : null;
  ipcMain.handle("lewis:update", (event, action, value) => {
    if (!mainSender(event) || !updateManager) throw Error("更新仅在桌面版可用");
    return updateManager.action(action, value);
  });
  ipcMain.handle("lewis:credentials-get", (event) => {
    if (!mainSender(event)) throw Error("来源无效");
    return credentials?.get() || {};
  });
  ipcMain.handle("lewis:credentials-set", (event, value) => {
    if (!mainSender(event) || !credentials) throw Error("本机凭据保护不可用");
    return credentials.set(value);
  });
  ipcMain.handle("lewis:capture-screen", async (event) => {
    if (!mainSender(event) || !backend.capabilities.value.computer)
      throw new Error("屏幕截图权限未开启");
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1280, height: 720 },
    });
    if (!mainSender(event)) throw new Error("窗口已关闭");
    const primary = String(screen.getPrimaryDisplay().id);
    let image = (
      sources.find((item) => item.display_id === primary) || sources[0]
    )?.thumbnail;
    if (!image || image.isEmpty()) throw new Error("无法获取屏幕");
    let bytes = image.toJPEG(65);
    if (bytes.length > 256 * 1024)
      bytes = image.resize({ width: 800 }).toJPEG(50);
    if (bytes.length > 256 * 1024) throw new Error("截图过大");
    return "data:image/jpeg;base64," + bytes.toString("base64");
  });
  ipcMain.handle("lewis:web-open", (event, url) => {
    if (!mainSender(event)) throw new Error("来源无效");
    return webPanel.open(url);
  });
  ipcMain.on("lewis:web-layout", (event, data) => {
    if (mainSender(event)) webPanel.setLayout(data);
  });
  ipcMain.handle("lewis:web-control", async (event, action) => {
    if (!mainSender(event)) throw new Error("来源无效");
    if (
      ![
        "back",
        "forward",
        "reload",
        "stop",
        "mute",
        "mute-on",
        "mute-off",
        "external",
        "suspend",
      ].includes(action)
    )
      throw new Error("未知网页操作");
    if (action === "external") {
      backend.capabilities.require("computer");
      return shell.openExternal(await webPanel.control(action));
    }
    return webPanel.control(action);
  });
  const area = screen.getPrimaryDisplay().workArea;
  petWindow = new BrowserWindow({
    show: false,
    width: 240,
    height: 260,
    x: area.x + area.width - 260,
    y: area.y + area.height - 290,
    transparent: true,
    frame: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    backgroundColor: "#00000000",
    webPreferences: preferences,
  });
  petInteraction = require("./pet-interaction").createPetInteraction(
    petWindow,
    screen,
  );
  petWindow.on("hide", () => petInteraction.setDragging(false));
  // 页面加载前注册，确保首次上报的鼠标区域与启动唤醒不会丢失。
  // 主界面显隐由启动/托盘控制；唤醒不能隐藏正在使用的界面或切换前台应用。
  ipcMain.on("lewis:show-pet", (event) => {
    if (mainSender(event)) showPet();
  });
  ipcMain.on("lewis:pet-hit-regions", (event, regions) => {
    if (trusted(event) && isWindowSender(event, petWindow))
      petInteraction.report(regions);
  });
  ipcMain.on("lewis:pet-dragging", (event, dragging) => {
    if (trusted(event) && isWindowSender(event, petWindow))
      petInteraction.setDragging(dragging);
  });
  ipcMain.on("lewis:pet-menu", (event) => {
    if (
      !trusted(event) ||
      !isWindowSender(event, petWindow) ||
      !liveContents(petWindow)
    )
      return;
    petInteraction.setDragging(false);
    const menu = Menu.buildFromTemplate([
      { label: "打开主界面", click: showMain },
      {
        label: "开始 / 停止聆听",
        click: () => {
          if (liveContents(mainWindow))
            mainWindow.webContents.send("lewis:message", { type: "listen" });
        },
      },
      {
        label: "逗我开心",
        click: () => {
          if (liveContents(petWindow))
            petWindow.webContents.send("lewis:message", { type: "pet-happy" });
        },
      },
      { type: "separator" },
      {
        label: "恢复桌宠位置",
        click: () => {
          if (liveContents(petWindow)) {
            const area = screen.getPrimaryDisplay().workArea;
            petWindow.setPosition(
              area.x + area.width - 260,
              area.y + area.height - 290,
            );
          }
        },
      },
      {
        label: "隐藏桌宠（托盘或唤醒可恢复）",
        click: () => {
          if (liveContents(petWindow)) petWindow.hide();
        },
      },
    ]);
    menu.popup({
      window: petWindow,
      callback: () => {
        petInteraction.reset();
        if (liveContents(petWindow))
          petWindow.webContents.send("lewis:message", { type: "pet-reset" });
      },
    });
  });
  ipcMain.on("lewis:voice-status", (event, data) => {
    if (
      !mainSender(event) ||
      !["wake", "conversation", "off"].includes(data?.mode) ||
      typeof data.label !== "string"
    )
      return;
    tray?.setToolTip(
      "李维斯 Lewis · " +
        (data.mode === "wake"
          ? "后台唤醒监听"
          : data.mode === "conversation"
            ? "持续对话"
            : "麦克风暂停"),
    );
    if (data.mode === "off" && data.label.startsWith("⚠️"))
      tray?.displayBalloon({
        title: "后台监听未开启",
        content: data.label.slice(0, 180) + "；右键托盘打开主界面检查设置。",
      });
  });
  let voiceReady;
  ipcMain.handle("lewis:voice-ready", (event) => {
    if (!mainSender(event)) throw new Error("来源无效");
    if (process.env.LEWIS_EXTERNAL_VOICE === "1") return true;
    if (!voiceReady) {
      voiceReady = require("./voice-ready")
        .waitForVoiceService({
          checkHealth: async () => {
            const response = await fetch("http://127.0.0.1:5001/api/health", {
              signal: AbortSignal.timeout(2500),
            });
            return (
              response.ok &&
              (await response.json()).service === "Lewis Voice Service"
            );
          },
          startService: () => {
            launchVoice();
            if (!voiceChild)
              throw new Error("请从托盘配置语音 Python 环境，或先启动语音服务");
          },
          isStopped: () => quitting || !liveContents(mainWindow),
        })
        .finally(() => {
          voiceReady = null;
        });
    }
    return voiceReady;
  });
  for (const window of [mainWindow, petWindow]) {
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(origin + "/")) event.preventDefault();
    });
    window.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        window.hide();
      }
    });
  }
  // 小型原生托盘图标，无外部图片依赖。
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let y = 1; y < 15; y++)
    for (let x = 1; x < 15; x++) {
      if (x <= 4 || y >= 11 || x === 1 || y === 1 || x === 14 || y === 14) {
        const index = (y * 16 + x) * 4;
        pixels[index] = 255;
        pixels[index + 1] = 230;
        pixels[index + 2] = 0;
        pixels[index + 3] = 255;
      }
    }
  tray = new Tray(
    nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }),
  );
  tray.setToolTip("李维斯 Lewis");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开主界面", click: showMain },
      { label: "显示桌宠", click: showPet },
      {
        label: "隐藏桌宠",
        click: () => {
          if (!quitting && liveContents(petWindow)) petWindow.hide();
          dafeiyuPet?.send({ type: "hide" });
        },
      },
      {
        label: "桌宠置顶",
        type: "checkbox",
        checked: true,
        click: (item) => {
          dafeiyuPet?.send({ type: "topmost", value: item.checked });
          if (!quitting && liveContents(petWindow))
            petWindow.setAlwaysOnTop(item.checked);
        },
      },
      { label: "进入后台唤醒（隐藏界面）", click: enterBackground },
      {
        label: "暂停麦克风",
        click: () => {
          if (!quitting)
            sendToWindow(mainWindow, "lewis:message", {
              type: "pause-listening",
            });
        },
      },
      {
        label: "重启工具服务",
        click: async () => {
          if (quitting) return;
          try {
            await backend.close?.();
            nodeServer = await backend.start(Number(process.env.PORT || 3000));
            sendToWindow(mainWindow, "lewis:message", {
              type: "backend-restored",
            });
          } catch (error) {
            dialog.showErrorBox("工具服务重启失败", error.message);
          }
        },
      },
      { label: "配置语音 Python 环境…", click: configurePython },
      { type: "separator" },
      { label: "退出 Lewis", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", showMain);
  ipcMain.on("lewis:open-main", (event) => {
    if (trusted(event)) showMain();
  });
  ipcMain.on("lewis:hide-pet", (event) => {
    if (trusted(event)) {
      dafeiyuPet?.send({ type: "hide" });
      if (liveContents(petWindow)) petWindow.hide();
    }
  });
  ipcMain.on("lewis:move-pet", (event, delta) => {
    if (
      !trusted(event) ||
      !isWindowSender(event, petWindow) ||
      !Number.isFinite(delta?.x) ||
      !Number.isFinite(delta?.y)
    )
      return;
    const [x, y] = petWindow.getPosition();
    petWindow.setPosition(
      x + Math.round(Math.max(-200, Math.min(200, delta.x))),
      y + Math.round(Math.max(-200, Math.min(200, delta.y))),
    );
  });
  ipcMain.on("lewis:message", (event, data) => {
    if (
      !trusted(event) ||
      !data ||
      typeof data !== "object" ||
      !["state", "say", "avatar", "listen", "ready", "wake"].includes(data.type)
    )
      return;
    // 浏览器 BroadcastChannel 和 Electron IPC 二选一，避免监听动作重复切换。
    if (["say", "state"].includes(data.type) && petStyle === "dafeiyu")
      dafeiyuPet?.send(data);
    for (const target of [mainWindow, petWindow])
      if (liveContents(target) && !isWindowSender(event, target))
        sendToWindow(target, "lewis:message", data);
  });
  await petWindow.loadURL(origin + "/pet");
  await mainWindow.loadURL(origin);
  if (process.env.LEWIS_EXTERNAL_VOICE === "1") return;
  try {
    const response = await fetch("http://127.0.0.1:5001/api/health", {
      signal: AbortSignal.timeout(1500),
    });
    if (
      !response.ok ||
      (await response.json()).service !== "Lewis Voice Service"
    )
      throw new Error("未启动");
  } catch {
    launchVoice();
  }
  if (
    app.isPackaged &&
    !voiceChild &&
    !voiceConfig.python &&
    !process.env.LEWIS_PYTHON
  )
    tray.displayBalloon({
      title: "Lewis 语音环境",
      content: "如语音服务尚未启动，请右键托盘选择“配置语音 Python 环境”。",
    });
}
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  quitting = true;
  webPanel?.destroy();
  webProxy?.close();
  petInteraction?.destroy();
  voiceChild?.kill();
  dafeiyuPet?.stop();
  nodeServer?.close();
});
