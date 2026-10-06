// 隐藏窗口测试真实 Electron 主进程/预加载/页面，硬件输入由 Chromium 假设备提供。
const { app, BrowserWindow, dialog, Menu, screen } = require("electron");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const profile =
  process.env.LEWIS_UI_TEST_PROFILE || path.join(__dirname, ".ui-profile");
const traceFile =
  process.env.LEWIS_UI_TEST_LOG || path.join(profile, "ui-test.log");
fs.mkdirSync(profile, { recursive: true });
const trace = (text) => fs.appendFileSync(traceFile, text + "\n");
dialog.showErrorBox = (title, message) => {
  trace("STARTUP FAILED: " + title + ": " + message);
  app.exit(1);
};
app.setPath("userData", profile);
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
process.env.LEWIS_HEADLESS = "1";
process.env.LEWIS_EXTERNAL_VOICE = "1";
process.env.PORT = "0";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let errors = [];
let requests = [];
const menus = [];
const buildMenu = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (template) => {
  const menu = buildMenu(template);
  menus.push(menu);
  return menu;
};
function moveCursor(point) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class LewisTestCursor { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); }'; [LewisTestCursor]::SetCursorPos(${point.x},${point.y}) | Out-Null`,
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
}
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push(req.url);
  if (req.url.endsWith("/chat/completions")) {
    res.setHeader("Content-Type", "text/event-stream");
    const content = Buffer.from(
      'data: {"choices":[{"delta":{"content":"集成测试回复"}}]}\n\ndata: [DONE]\n\n',
    );
    for (let i = 0; i < content.length; i += 5) {
      res.write(content.subarray(i, i + 5));
      await delay(1);
    }
    res.end();
  } else {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        text: "录音测试成功",
        has_voice: true,
        detected: true,
        command: "唤醒测试成功",
        success: true,
      }),
    );
  }
});
const hardTimeout = setTimeout(() => {
  console.error("UI test timeout");
  app.exit(1);
}, 90000);
async function run() {
  trace("begin");
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${mock.address().port}`;
  require(process.env.LEWIS_UI_TEST_ENTRY || "../electron/main.js");
  await app.whenReady();
  let main, pet;
  for (let i = 0; i < 200; i++) {
    const windows = BrowserWindow.getAllWindows();
    main = windows.find((w) => w.webContents.getURL().endsWith("/"));
    pet = windows.find((w) => w.webContents.getURL().endsWith("/pet"));
    if (
      main &&
      pet &&
      !main.webContents.isLoading() &&
      !pet.webContents.isLoading()
    )
      break;
    await delay(100);
  }
  assert.ok(main && pet, "主界面和透明桌宠已创建");
  trace("windows-ready");
  for (const window of [main, pet])
    window.webContents.on("console-message", (details) => {
      if (details.level === "error" || details.level === 3)
        errors.push(details.message);
    });
  const js = async (code) => {
    try {
      return await main.webContents.executeJavaScript(code);
    } catch (error) {
      trace("JavaScript failed: " + code + "\n" + String(error));
      throw error;
    }
  };
  for (let i = 0; i < 100 && !(await js("Boolean(sessionReady && voice)")); i++)
    await delay(100);
  assert.equal(
    await js("Boolean(sessionReady && voice)"),
    true,
    "凭据恢复和页面初始化已完成",
  );
  await js(
    `sessionReady.then(async () => { settings.apiBaseUrl = ${JSON.stringify(url + "/v1")}; settings.apiKey='test'; settings.modelName='mock'; settings.voiceServiceUrl=${JSON.stringify(url)}; settings.autoTts=false; settings.autoMic=false; settings.autoCamera=false; settings.visionEnabled=false; await voice.toggleContinuous(false); window.lewisVision?.stop(); writeStorage('lewis_settings', settings); });`,
  );
  const initialCount = await js('document.querySelectorAll(".message").length');
  trace("chat-start");
  await js('sendSuggestion("界面测试")');
  assert.equal(
    await js(
      'document.querySelector(".message:last-child .message-bubble").textContent',
    ),
    "集成测试回复",
  );
  if (process.env.LEWIS_UI_QT_PET === "1") {
    const style = await js('window.electronAPI.setPetStyle("dafeiyu")');
    assert.equal(style.style, "dafeiyu");
    await js('receivePetAction({type:"pet-task",text:"桌宠复用模型测试"})');
    for (let i = 0; i < 100 && (await js("isSending")); i++) await delay(30);
    assert.equal(
      await js(
        'document.querySelector(".message:last-child .message-bubble").textContent',
      ),
      "集成测试回复",
    );
    await js(
      'window.electronAPI.hidePet(); window.electronAPI.setPetStyle("classic")',
    );
    trace("Qt-pet-connected-task-routed");
  }
  const id = await js("sessionId");
  await main.webContents.reload();
  await delay(700);
  assert.equal(await js("sessionReady.then(() => sessionId)"), id);
  assert.equal(
    await js('document.querySelectorAll(".message").length'),
    initialCount + (process.env.LEWIS_UI_QT_PET === "1" ? 4 : 2),
  );
  await js(
    `settings.apiBaseUrl=${JSON.stringify(url + "/v1")}; settings.apiKey='test'; settings.voiceServiceUrl=${JSON.stringify(url)}; settings.autoTts=false;`,
  );
  await js("voice.toggleManual()");
  trace("voice-start");
  await delay(450);
  assert.equal(await js("voice.context.state"), "running");
  await js(
    'voice.capture(new Float32Array(48000).fill(0.1)); voice.submit("asr")',
  );
  assert.ok(requests.includes("/api/asr"));
  assert.ok(
    await js(
      'Array.from(document.querySelectorAll(".message.user .message-bubble")).some(el=>el.textContent==="录音测试成功")',
    ),
  );
  await js("voice.toggleWake(true)");
  await delay(450);
  await js(
    'voice.capture(new Float32Array(48000).fill(0.1)); voice.submit("wake-word")',
  );
  assert.ok(requests.includes("/api/wake-word"));
  assert.ok(
    await js(
      'Array.from(document.querySelectorAll(".message.user .message-bubble")).some(el=>el.textContent==="唤醒测试成功")',
    ),
  );
  await js("voice.toggleWake(false)");
  assert.equal(await js("voice.stream"), null);
  const dataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF+0AAAAASUVORK5CYII=";
  await js(`publish({type:'avatar',url:${JSON.stringify(dataUrl)}})`);
  await delay(100);
  assert.equal(
    await pet.webContents.executeJavaScript(
      'document.querySelector(".pet-avatar img").hidden',
    ),
    false,
  );
  assert.equal(pet.isAlwaysOnTop(), true);
  const cursor = screen.getCursorScreenPoint(),
    originalPosition = pet.getPosition();
  try {
    pet.setPosition(300, 300);
    pet.showInactive();
    moveCursor({ x: 420, y: 465 });
    await pet.webContents.executeJavaScript(
      "window.electronAPI.petDragging(true)",
    );
    await delay(100);
    moveCursor({ x: 480, y: 505 });
    await delay(150);
    assert.deepEqual(
      pet.getPosition(),
      [360, 340],
      "实际系统光标移动能拖动桌宠窗口",
    );
    await pet.webContents.executeJavaScript(
      "window.electronAPI.petDragging(false); window.electronAPI.petMenu()",
    );
    await delay(100);
    const menu = menus.findLast((item) =>
      item.items.some((entry) => entry.label === "恢复桌宠位置"),
    );
    assert.ok(menu, "桌宠右键打开原生菜单");
    menu.closePopup(pet);
    await delay(100);
    assert.equal(
      await pet.webContents.executeJavaScript(
        'document.getElementById("pet").classList.contains("dragging")',
      ),
      false,
    );
  } finally {
    moveCursor(cursor);
    pet.setPosition(...originalPosition);
  }
  pet.show();
  await js("window.electronAPI.hidePet()");
  await delay(100);
  assert.equal(pet.isVisible(), false);
  // 此机 Chromium 假摄像头会立即 ended；用持续绘制的本地 Canvas 流验证真实视频/Worker 链路。
  await js(`(() => {
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
    const context=canvas.getContext('2d');let counter=0;
    window.__cameraPaint=setInterval(()=>{context.fillStyle=counter++%2?'#315269':'#31536a';context.fillRect(0,0,640,480);},50);
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=constraints=>constraints.video?Promise.resolve(canvas.captureStream(20)):original(constraints);
  })()`);
  const cameraStarted = await js(
    "window.lewisVision.start().then(() => true).catch(error => ({ name: error.name, message: error.message }))",
  );
  assert.equal(cameraStarted, true, JSON.stringify(cameraStarted));
  trace("camera-start");
  let gestureStatus;
  for (let i = 0; i < 450; i++) {
    gestureStatus = await js(
      'document.getElementById("gestureStatus").textContent',
    );
    if (/手势模型就绪|未检测到手|检测到/.test(gestureStatus)) break;
    if (/失败|超时/.test(gestureStatus)) throw new Error(gestureStatus);
    await delay(100);
  }
  assert.match(gestureStatus, /手势模型就绪|未检测到手|检测到/);
  assert.equal(
    await js('document.getElementById("cameraPreview").readyState >= 2'),
    true,
  );
  await js("window.lewisVision.stop(); clearInterval(window.__cameraPaint)");
  assert.equal(
    await js('document.getElementById("cameraPreview").srcObject'),
    null,
  );
  assert.deepEqual(
    errors.filter(
      (error) => !error.includes("favicon") && !error.includes("net::ERR"),
    ),
    [],
  );
  assert.equal(Menu.getApplicationMenu(), null);
  await js('window.electronAPI.openGestureStudio("")');
  const studio = BrowserWindow.getAllWindows().find((window) =>
    window.webContents.getURL().includes("/gestures"),
  );
  assert.ok(studio);
  assert.equal(
    await studio.webContents.executeJavaScript(
      'document.getElementById("configureStage").hidden',
    ),
    true,
  );
  await assert.rejects(
    studio.webContents.executeJavaScript("window.electronAPI.credentialsGet()"),
    /来源无效/,
  );
  await studio.webContents.executeJavaScript(
    "window.electronAPI.closeGestureStudio()",
  );
  await delay(150);
  assert.equal(studio.isDestroyed(), true);
  assert.equal(main.isDestroyed(), false);
  console.log(
    "UI PASS: 页面聊天、刷新历史、AudioWorklet录音、唤醒、麦克风释放、头像IPC、实际光标拖动/原生右键关闭、置顶/隐藏、MediaPipe加载与摄像头开关（Canvas画面）",
  );
}
run()
  .then(() => {
    trace("PASS");
    clearTimeout(hardTimeout);
    mock.close();
    app.exit(0);
  })
  .catch((error) => {
    trace(error.stack || error.message);
    console.error(error);
    clearTimeout(hardTimeout);
    mock.close();
    app.exit(1);
  });
