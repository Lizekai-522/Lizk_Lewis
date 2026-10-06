"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const {
  searchWeb,
  readWebpage,
  validateWebURL,
  publicAddress,
} = require("./web");
const { readJSONResponse } = require("../public/js/http");
const { WeChatService } = require("./wechat");
const {
  parseWechatCommand,
  parseWechatSendIntent,
  authorizeWechatCommand,
} = require("../public/js/wechat-command");
const wechatService = new WeChatService();
const { desktopApps } = require("./desktop-apps");
const { musicService } = require("./music");
const systemRoot = process.env.SystemRoot || "C:\\Windows";
const apps = {
  qqmusic: {
    name: "QQ 音乐",
    paths: [
      path.join(
        process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
        "Tencent/QQMusic/QQMusic.exe",
      ),
      path.join(
        process.env.ProgramFiles || "C:/Program Files",
        "Tencent/QQMusic/QQMusic.exe",
      ),
    ],
  },
  notepad: {
    name: "记事本",
    paths: [path.join(systemRoot, "System32/notepad.exe")],
  },
  calculator: {
    name: "计算器",
    paths: [path.join(systemRoot, "System32/calc.exe")],
  },
  explorer: {
    name: "文件资源管理器",
    paths: [path.join(systemRoot, "explorer.exe")],
  },
  edge: {
    name: "Edge 浏览器",
    paths: [
      path.join(
        process.env["ProgramFiles(x86)"] || "",
        "Microsoft/Edge/Application/msedge.exe",
      ),
      path.join(
        process.env.ProgramFiles || "",
        "Microsoft/Edge/Application/msedge.exe",
      ),
    ],
  },
  chrome: {
    name: "Chrome 浏览器",
    paths: [
      path.join(
        process.env.ProgramFiles || "",
        "Google/Chrome/Application/chrome.exe",
      ),
      path.join(
        process.env.LOCALAPPDATA || "",
        "Google/Chrome/Application/chrome.exe",
      ),
    ],
  },
  vscode: {
    name: "VS Code",
    paths: [
      path.join(
        process.env.LOCALAPPDATA || "",
        "Programs/Microsoft VS Code/Code.exe",
      ),
      path.join(process.env.ProgramFiles || "", "Microsoft VS Code/Code.exe"),
    ],
  },
  wechat: {
    name: "微信",
    paths: [
      path.join(
        process.env.ProgramFiles || "C:/Program Files",
        "Tencent/Weixin/Weixin.exe",
      ),
      path.join(
        process.env["ProgramFiles(x86)"] || "",
        "Tencent/WeChat/WeChat.exe",
      ),
      path.join(process.env.ProgramFiles || "", "Tencent/WeChat/WeChat.exe"),
    ],
  },
};
async function launch(executable, args = [], { visible = false } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: !visible,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
function listSkills() {
  return [
    { id: "weather", name: "查询天气", input: "城市名" },
    {
      id: "open-app",
      name: "打开软件",
      apps: Object.entries(apps).map(([id, item]) => ({
        id,
        name: item.name,
        installed: item.paths.some((file) => fs.existsSync(file)),
      })),
    },
    { id: "volume", name: "电脑音量", input: "0–100" },
    { id: "list-apps", name: "查找已安装应用", input: "应用名称" },
    {
      id: "music-play",
      name: "QQ音乐播放",
      input: "歌曲名称；留空播放推荐歌曲",
    },
    { id: "web-search", name: "搜索网页", input: "搜索内容" },
    { id: "read-webpage", name: "读取网页", input: "公开网页 URL" },
    { id: "open-website", name: "打开网站", input: "HTTP/HTTPS URL" },
    { id: "wechat-status", name: "检查微信连接" },
    { id: "wechat-read", name: "读取微信当前聊天", input: "完整聊天名称" },
    {
      id: "wechat-send",
      name: "向微信当前聊天发送",
      input: "完整聊天名称及明确消息内容",
    },
  ];
}
async function executeSkill(
  {
    skill,
    city,
    app,
    value,
    query,
    url,
    recipient,
    text,
    question,
    startTime,
    endTime,
    mode = "auto",
    visual = false,
    ref,
    snapshotId,
    amount,
    goal,
    action,
    enter = false,
  },
  voiceBase,
  {
    capabilities,
    signal,
    launchApp = launch,
    openWebsite,
    readBrowser,
    browserAction,
    browserReader,
    describeWeb,
    wechat = wechatService,
    wechatReader,
    modelSettings,
    userMessage,
    operationId,
    desktop = desktopApps,
    music = musicService,
  } = {},
) {
  if (
    [
      "list-apps",
      "desktop-read",
      "desktop-click",
      "desktop-type",
      "music-play",
      "music-control",
    ].includes(skill)
  ) {
    capabilities?.require("computer");
    if (process.platform !== "win32") throw Error("桌面应用操作仅支持 Windows");
    const options = {
      seeds: apps,
      launchApp,
      signal,
      requireComputer: () => capabilities?.require("computer"),
    };
    return desktop.serialize(async () => {
      signal?.throwIfAborted();
      capabilities?.require("computer");
      if (skill === "list-apps") return desktop.list(query || "", apps);
      if (skill === "desktop-read")
        return desktop.read(app, { ...options, ocr: visual });
      if (skill === "desktop-click")
        return desktop.action(
          {
            snapshotId,
            ref,
            kind: action === "double-click" ? "double-click" : "click",
          },
          options,
        );
      if (skill === "desktop-type")
        return desktop.action(
          { snapshotId, ref, kind: "type", text, enter },
          options,
        );
      if (skill === "music-control") return music.control(action, options);
      return music.play(query || "", options);
    });
  }
  if (skill === "web-play-video") {
    capabilities?.require("web");
    capabilities?.require("computer");
    if (!browserAction) throw Error("播放网页视频需要桌面版");
    return browserAction({ kind: "play", signal });
  }
  if (
    typeof skill === "string" &&
    skill.startsWith("web-") &&
    ["web-click", "web-type", "web-scroll"].includes(skill)
  ) {
    capabilities?.require("web");
    capabilities?.require("computer");
    if (!browserAction) throw new Error("网页交互需要 Electron 桌面版");
    return browserAction({
      kind: skill.slice(4),
      ref,
      snapshotId,
      amount,
      text,
      signal,
    });
  }
  if (skill === "web-screenshot")
    return executeSkill(
      { skill: "read-current-page", visual: true, question },
      voiceBase,
      {
        capabilities,
        signal,
        readBrowser,
        browserReader,
        describeWeb,
        modelSettings,
      },
    );
  if (skill === "web-browse") {
    if (typeof goal !== "string" || goal.length > 500)
      throw new Error("浏览目标应在 500 字符以内");
    return executeSkill(
      { skill: "read-webpage", url, mode: "browser" },
      voiceBase,
      {
        capabilities,
        signal,
        readBrowser,
        browserReader,
        describeWeb,
        modelSettings,
      },
    );
  }
  if (
    ["weather", "web-search", "read-webpage", "read-current-page"].includes(
      skill,
    )
  )
    capabilities?.require("web");
  if (["open-app", "open-website", "volume"].includes(skill))
    capabilities?.require("computer");
  if (signal?.aborted) throw signal.reason;
  if (
    ["wechat-contacts", "wechat-history", "wechat-image"].includes(skill) ||
    (skill === "wechat-read" && wechatReader?.configured())
  ) {
    capabilities?.require("computer");
    capabilities?.require("wechat");
    if (!wechatReader) throw new Error("微信后台数据服务未配置");
    if (skill === "wechat-image")
      return wechatReader.describe(url, question, {
        signal,
        settings: modelSettings || wechatReader.settings,
      });
    if (skill === "wechat-contacts")
      return {
        contacts: await wechatReader.contacts(signal),
        timestamp: Math.floor(Date.now() / 1000),
      };
    try {
      return await wechatReader.history(recipient, {
        startTime,
        endTime,
        signal,
      });
    } catch (error) {
      if (skill !== "wechat-read" || signal?.aborted) throw error;
      capabilities?.require("computer");
      capabilities?.require("wechat");
      const result = await wechat.execute(
        { action: "read", recipient },
        { signal },
      );
      return {
        ...result,
        source: "微信屏幕可见消息（数据库读取不可用）",
        degraded: true,
        warning: error.message,
      };
    }
  }
  if (["wechat-status", "wechat-read", "wechat-send"].includes(skill)) {
    capabilities?.require("computer");
    capabilities?.require("wechat");
    if (skill !== "wechat-status") {
      const requested =
        skill === "wechat-send"
          ? parseWechatSendIntent(userMessage)
          : parseWechatCommand(userMessage);
      if (!authorizeWechatCommand(userMessage, { skill, recipient, text }))
        throw new Error("请在本轮明确指令中指定微信好友和发送内容或撰写任务");
      recipient = requested.recipient;
      if (skill === "wechat-send" && requested.mode === "verbatim")
        text = requested.text;
    }
    return wechat.execute(
      {
        action:
          skill === "wechat-status"
            ? "status"
            : skill === "wechat-read"
              ? "read"
              : "send",
        ...(recipient !== undefined ? { recipient } : {}),
        ...(text !== undefined ? { text } : {}),
      },
      { operationId, signal },
    );
  }
  if (skill === "web-search") return searchWeb(query, { signal, readBrowser });
  if (["read-webpage", "read-current-page"].includes(skill)) {
    if (
      !["auto", "static", "browser"].includes(mode) ||
      typeof visual !== "boolean" ||
      (question !== undefined &&
        (typeof question !== "string" || question.length > 500))
    )
      throw new Error("网页读取参数无效");
    if (skill === "read-webpage" && mode === "static")
      return { ...(await readWebpage(url, { signal })), mode: "static" };
    capabilities?.require("computer");
    if (skill === "read-current-page" && !readBrowser)
      throw new Error(
        "当前页面读取需要 Electron 桌面版，请在内置网页面板打开页面",
      );
    const reader = readBrowser || ((options) => browserReader?.read(options));
    if (!readBrowser && !browserReader)
      throw new Error("动态网页读取服务不可用");
    const target =
      skill === "read-current-page" ? undefined : validateWebURL(url).href;
    const result = await reader({ url: target, screenshot: visual, signal });
    if (visual) {
      if (!describeWeb) throw new Error("页面截图分析服务未配置");
      return describeWeb(result, modelSettings, question, signal);
    }
    return result;
  }
  if (skill === "open-website") {
    const target = validateWebURL(url);
    const host = target.hostname.replace(/^\[|\]$/g, "");
    if (
      host === "localhost" ||
      /\.(?:localhost|local)$/i.test(host) ||
      (require("node:net").isIP(host) && !publicAddress(host))
    )
      throw new Error("只支持公开网站地址");
    if (openWebsite) await openWebsite(target.href);
    else {
      if (process.platform !== "win32")
        throw new Error("打开网站仅支持桌面版或 Windows");
      await launchApp(path.join(systemRoot, "System32/rundll32.exe"), [
        "url.dll,FileProtocolHandler",
        target.href,
      ]);
    }
    return { text: `已打开网站：${target.href}`, url: target.href };
  }
  if (skill === "open-app") {
    if (process.platform !== "win32") throw new Error("打开软件仅支持 Windows");
    return desktop.open(app, { seeds: apps, launchApp, signal });
  }
  if (skill === "volume") {
    if (!Number.isInteger(value) || value < 0 || value > 100)
      throw new Error("音量必须是 0–100 的整数");
    const response = await fetch(`${voiceBase}/api/volume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await readJSONResponse(response, "电脑音量接口");
    if (!response.ok) throw new Error(data.error || "设置音量失败");
    return { text: `电脑音量已设为 ${value}%` };
  }
  if (skill === "weather") {
    if (typeof city !== "string" || !city.trim() || city.length > 100)
      throw new Error("请输入城市名称");
    const response = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city.trim())}&count=1&language=zh&format=json`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw new Error("城市查询服务暂时不可用");
    const place = (await readJSONResponse(response, "城市查询接口"))
      .results?.[0];
    if (!place) throw new Error("未找到城市，请尝试城市英文名，例如 Shanghai");
    const weather = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m&timezone=auto`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!weather.ok) throw new Error("天气服务暂时不可用");
    const data = await readJSONResponse(weather, "天气接口");
    const current = data.current;
    return {
      text: `${place.name}（${place.admin1 || place.country}）${current.time}：气温 ${current.temperature_2m}°C，湿度 ${current.relative_humidity_2m}%，风速 ${current.wind_speed_10m} km/h。`,
      source: "https://open-meteo.com/",
    };
  }
  throw new Error("未知技能");
}
module.exports = { executeSkill, listSkills, wechatService };
