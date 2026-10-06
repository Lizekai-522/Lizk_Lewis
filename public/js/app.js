"use strict";
let sessionId = null;
let isSending = false;
let chatController;
let voice;
let sessionReady;
let settings = {};
let restoredCredentials = {};
let lastReply = "";
let playbackController;
let listeningRequest = 0;
const channel =
  !window.electronAPI && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("lewis-pet")
    : null;
const $ = (id) => document.getElementById(id);

function publish(data) {
  channel?.postMessage(data);
  window.electronAPI?.publish(data);
}
function status(text, state = "idle", recording = false) {
  if (
    /ERR_|fetch failed|Failed to fetch|TypeError|\bat\s.*\(|ECONN|ETIMEDOUT|NotAllowedError/i.test(
      text,
    )
  )
    text = window.lewisFriendlyError?.(text) || text;
  $("voiceStatus").textContent = text;
  $("voiceBtn").classList.toggle("recording", recording);
  $("voiceVisualizer").classList.toggle("active", recording);
  $("wakeEnabled").checked = Boolean(voice?.wakeEnabled);
  $("continuousEnabled").checked = Boolean(voice?.continuousEnabled);
  publish({ type: "state", state, label: text });
}
function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeStorage(key, value) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify(
        key === "lewis_settings"
          ? { ...value, apiKey: undefined, visionApiKey: undefined }
          : value,
      ),
    );
  } catch {
    status("本地设置存储不可用；历史仍保存在服务器");
  }
}
function loadSettings() {
  settings = {
    apiBaseUrl: "https://api.deepseek.com/v1",
    modelName: "deepseek-chat",
    voiceServiceUrl: "http://localhost:5001",
    autoTts: true,
    speechVoice: "zh-CN-XiaoxiaoNeural",
    speechRate: 6,
    speechPitch: 0,
    wakeConversationSeconds: 0,
    contextWindow: 16384,
    micThreshold: 0.012,
    autoMic: true,
    autoCamera: true,
    visionEnabled: true,
    visionApiBaseUrl: "",
    visionApiKey: "",
    visionModelName: "qwen3-vl-plus",
    autoTools: true,
    browserAutoReveal: true,
    browserMuted: true,
    browserShowActivity: false,
    theme: "tech",
    petStyle: "dafeiyu",
    ...readStorage("lewis_settings", {}),
    ...restoredCredentials,
  };
  window.lewisGestureActions?.render(settings.gestureActions);
  settings.startupVoiceMode =
    settings.startupVoiceMode === "wake" ? "wake" : "continuous";
  // 本次需求将桌面版切换为后台唤醒；只迁移一次，随后保留用户自行修改的设置。
  if (window.electronAPI && !settings.desktopWakeConfigured) {
    settings.autoMic = true;
    settings.startupVoiceMode = "wake";
    settings.desktopWakeConfigured = true;
    writeStorage("lewis_settings", settings);
  }
  // 本次明确要求唤醒后持续交谈；迁移一次，之后保留用户手动选择的时长。
  if (!settings.wakeConversationConfigured) {
    settings.wakeConversationSeconds = 0;
    settings.wakeConversationConfigured = true;
    writeStorage("lewis_settings", settings);
  }
  for (const key of [
    "apiBaseUrl",
    "apiKey",
    "modelName",
    "voiceServiceUrl",
    "contextWindow",
    "micThreshold",
    "visionApiBaseUrl",
    "visionApiKey",
    "visionModelName",
    "startupVoiceMode",
    "speechVoice",
    "speechRate",
    "speechPitch",
    "wakeConversationSeconds",
  ])
    if (settings[key] !== undefined) $(key).value = settings[key];
  for (const key of [
    "autoMic",
    "autoCamera",
    "visionEnabled",
    "autoTools",
    "browserAutoReveal",
    "browserMuted",
    "browserShowActivity",
  ])
    $(key).checked = Boolean(settings[key]);
  $("autoTts").checked = settings.autoTts;
  syncSpeechControls();
  settings.theme = window.lewisAppearance.resolveTheme(settings);
  if (!settings.techPaletteConfigured) {
    settings.techPaletteConfigured = true;
    writeStorage("lewis_settings", settings);
  }
  $("themeChoice").value = settings.theme;
  $("petStyle").value = settings.petStyle === "classic" ? "classic" : "dafeiyu";
  applyPetStyle($("petStyle").value);
}
async function saveSettings() {
  const candidate = { ...settings };
  for (const key of [
    "apiBaseUrl",
    "apiKey",
    "modelName",
    "voiceServiceUrl",
    "visionApiBaseUrl",
    "visionApiKey",
    "visionModelName",
  ])
    candidate[key] = $(key).value.trim();
  for (const key of [
    "autoMic",
    "autoCamera",
    "visionEnabled",
    "autoTools",
    "browserAutoReveal",
    "browserMuted",
    "browserShowActivity",
  ])
    candidate[key] = $(key).checked;
  candidate.theme = $("themeChoice").value;
  candidate.petStyle = $("petStyle").value;
  applyPetStyle(candidate.petStyle);
  candidate.startupVoiceMode =
    $("startupVoiceMode").value === "wake" ? "wake" : "continuous";
  candidate.contextWindow = Number($("contextWindow").value);
  candidate.micThreshold = Number($("micThreshold").value);
  candidate.autoTts = $("autoTts").checked;
  candidate.speechVoice = $("speechVoice").value;
  candidate.speechRate = Number($("speechRate").value);
  candidate.speechPitch = Number($("speechPitch").value);
  candidate.wakeConversationSeconds = Number(
    $("wakeConversationSeconds").value,
  );
  try {
    window.lewisSpeech.options(candidate);
    if (![0, 30, 60, 120].includes(candidate.wakeConversationSeconds))
      throw Error("请选择唤醒后的交谈时长。");
  } catch (error) {
    status(error.message);
    return;
  }
  if (
    !Number.isInteger(candidate.contextWindow) ||
    candidate.contextWindow < 4096 ||
    candidate.contextWindow > 1000000 ||
    !Number.isFinite(candidate.micThreshold) ||
    candidate.micThreshold < 0.001 ||
    candidate.micThreshold > 0.2
  ) {
    status("请检查上下文窗口和麦克风阈值");
    return;
  }
  try {
    for (const key of ["apiBaseUrl", "voiceServiceUrl", "visionApiBaseUrl"]) {
      if (key === "visionApiBaseUrl" && !candidate[key]) continue;
      const url = new URL(candidate[key]);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
      candidate[key] = url.href.replace(/\/+$/, "");
    }
  } catch {
    status("服务地址必须是完整 HTTP/HTTPS 地址");
    return;
  }
  try {
    candidate.apiKey = normalizeApiKey(candidate.apiKey, false);
    candidate.visionApiKey = normalizeApiKey(candidate.visionApiKey, false);
  } catch (error) {
    status(error.message);
    return;
  }
  try {
    const response = await fetch("/api/capabilities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        web: $("allowWeb").checked,
        computer: $("allowComputer").checked,
        wechat: $("allowWechat").checked,
      }),
    });
    const result = await readJSONResponse(response, "/api/capabilities");
    if (!response.ok) throw new Error(result.error || "权限保存失败");
  } catch (error) {
    status(`设置未保存：${error.message}`);
    return;
  }
  candidate.gestureActions = window.lewisGestureActions?.read();
  try {
    if (window.electronAPI?.credentialsSet)
      await window.electronAPI.credentialsSet({
        apiKey: candidate.apiKey,
        visionApiKey: candidate.visionApiKey,
      });
  } catch (error) {
    status("Key 未保存：" + error.message);
    return;
  }
  settings = candidate;
  syncSpeechControls();
  if (!settings.autoTts) stopSpeech();
  await window.lewisWechatReader?.syncModel(settings);
  writeStorage("lewis_settings", settings);
  closeSettings();
  status("设置已保存，立即生效");
  window.dispatchEvent(new Event("lewis-settings-changed"));
}
function applyPetStyle(style) {
  if (!window.electronAPI?.setPetStyle) {
    $("petRuntimeStatus").textContent = "桌宠在 Electron 桌面版可用";
    return;
  }
  window.electronAPI
    .setPetStyle(style)
    .then((result) => {
      $("petRuntimeStatus").textContent =
        result.text ||
        (result.style === "dafeiyu"
          ? "大肥鱼已连接 · 复用 Lewis 模型与语音"
          : "原桌宠已启用");
    })
    .catch(() => {
      $("petRuntimeStatus").textContent = "桌宠组件暂未就绪，请重试";
    });
}
function closeSettings() {
  $("settingsPanel").classList.remove("open");
  $("overlay").classList.remove("active");
}
function showVisionSettings(reason) {
  window.lewisSettingsCategory?.("vision");
  $("settingsPanel").classList.add("open");
  $("overlay").classList.add("active");
  $("visionSettingsGroup")?.scrollIntoView?.({ block: "center" });
  $("visionChatStatus").textContent = reason;
}
async function createSession(fresh = false) {
  const healthResponse = await fetch("/api/health", { cache: "no-store" });
  const health = await readJSONResponse(healthResponse, "/api/health");
  if (!healthResponse.ok) throw new Error(health.error || "主服务不可用");
  if (health.apiVersion !== 2)
    throw new Error(
      `正在连接旧版后端 ${health.version || "未知版本"}。请关闭旧 node server.js，再启动新版；浏览器请打开 http://127.0.0.1:3000。`,
    );
  const previous = fresh ? null : readStorage("lewis_session", null);
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: previous }),
  });
  const data = await readJSONResponse(response, "/api/session");
  if (!response.ok) throw new Error(data.error || "创建会话失败");
  sessionId = data.sessionId;
  writeStorage("lewis_session", sessionId);
  if (!fresh) {
    const historyResponse = await fetch(`/api/history/${sessionId}`);
    const history = await readJSONResponse(historyResponse, "/api/history");
    if (!historyResponse.ok) throw new Error(history.error || "读取历史失败");
    for (const message of history.messages) {
      addMessage(
        message.content,
        message.role === "assistant" ? "ai" : "user",
        {
          images: (message.attachments || []).map((item) => ({
            image: "/api/media/" + item.id,
            label: item.label,
          })),
        },
      );
      if (message.role === "assistant") lastReply = message.content;
    }
    if (history.messages.length) $("welcome").style.display = "none";
  }
  await loadSessionList();
  const permissions = await readJSONResponse(
    await fetch("/api/capabilities"),
    "/api/capabilities",
  );
  $("allowWeb").checked = permissions.web;
  $("allowComputer").checked = permissions.computer;
  $("allowWechat").checked = Boolean(permissions.wechat);
  await window.lewisWechatReader?.syncModel(settings);
  const available = await readJSONResponse(
    await fetch("/api/skills"),
    "/api/skills",
  );
  $("installedApps").textContent =
    "已检测到程序：" +
    (available.skills
      .find((item) => item.id === "open-app")
      ?.apps.filter((item) => item.installed)
      .map((item) => item.name)
      .join("、") || "暂无；记事本、计算器及浏览器会按安装路径检查");
}
async function loadSessionList() {
  const response = await fetch("/api/sessions");
  const data = await readJSONResponse(response, "/api/sessions");
  if (!response.ok) throw new Error(data.error || "读取对话列表失败");
  const select = $("historySessions");
  select.replaceChildren(new Option("历史对话", ""));
  for (const item of data.sessions) select.add(new Option(item.title, item.id));
  select.value = data.sessions.some((s) => s.id === sessionId) ? sessionId : "";
}

// 保留网络尾部，直到完整 SSE 事件到达；不丢弃跨块 JSON。
async function readEvents(response, onEvent) {
  if (/text\/html/i.test(response.headers.get("content-type") || ""))
    throw new Error("/api/chat 返回了 HTML 页面，请重启新版后端");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = false;
  const dispatch = (event) => {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      complete = true;
      return;
    }
    const parsed = JSON.parse(data);
    if (parsed.error) throw new Error(parsed.error);
    onEvent(parsed);
  };
  try {
    while (!complete) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        dispatch(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        if (complete) break;
      }
      if (done) {
        if (buffer.trim()) dispatch(buffer);
        break;
      }
    }
    if (!complete) throw new Error("响应中断，请重试");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function sendSuggestion(text, options) {
  $("messageInput").value = text;
  return sendMessage(options);
}
async function sendMessage({
  restoreInputFocus = true,
  forceVision = false,
} = {}) {
  const input = $("messageInput");
  const attachments = window.lewisAttachments?.peek() || [];
  const text =
    input.value.trim() || (attachments.length ? "请描述这些图片" : "");
  if (!text || isSending) return;
  isSending = true;
  chatController = new AbortController();
  $("sendBtn").disabled = true;
  stopSpeech();
  voice.setBusy(true);
  status("正在思考…", "thinking");
  let thinkingId;
  let replyElement;
  let fullText = "";
  try {
    await sessionReady;
    const command = attachments.length
      ? null
      : window.lewisPluginCommand?.(text) || parseSkillCommand(text);
    // 空 Key 可由服务器环境变量提供；无效的已保存 Key 在发送之前拦截。
    const visual = window.lewisVisionSettings?.(settings) || {
      baseUrl: settings.visionApiBaseUrl,
      apiKey: settings.visionApiKey,
      model: settings.visionModelName,
    };
    const visualConfigured =
      settings.visionEnabled && visual.baseUrl && visual.apiKey;
    const visionRequired =
      !command &&
      (attachments.length > 0 ||
        forceVision ||
        window.lewisIsVisionRequest?.(text));
    if (
      visionRequired &&
      !(attachments.length ? visual.baseUrl && visual.apiKey : visualConfigured)
    ) {
      const reason = !settings.visionEnabled
        ? "请先开启“每轮模型对话附当前摄像头画面”"
        : "摄像头可以预览，但 AI 视觉未配置；请填写视觉 API 地址和百炼 Key";
      showVisionSettings(reason);
      throw new Error(reason);
    }
    if (!command)
      normalizeApiKey(
        visualConfigured ? visual.apiKey : (settings.apiKey ?? ""),
        false,
      );
    $("welcome").style.display = "none";
    addMessage(text, "user", { images: attachments });
    input.value = "";
    input.style.height = "auto";
    thinkingId = addThinking();
    if (command) {
      const name = {
        "web-search": "web_search",
        "read-webpage": "read_webpage",
        "read-current-page": "read_current_page",
        "open-website": "open_website",
      }[command.skill];
      if (name)
        window.lewisWebPanel?.activity({
          name,
          state: "running",
          args: command,
        });
      const response = await fetch("/api/skills", {
        signal: chatController.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...command,
          settings,
          voiceServiceUrl: settings.voiceServiceUrl,
          userMessage: text,
          operationId: crypto.randomUUID(),
        }),
      });
      const data = await readJSONResponse(response, "/api/skills");
      if (name)
        window.lewisWebPanel?.activity({
          name,
          state: response.ok ? "done" : "error",
          result: data,
          error: data.error,
        });
      if (!response.ok) throw new Error(data.error);
      fullText = data.text + (data.source ? "\n来源：" + data.source : "");
      removeMessage(thinkingId);
      addMessage(fullText, "ai");
      // 技能结果也保存成独立历史轮次。
      const saved = await fetch(`/api/history/${sessionId}/skill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, reply: fullText }),
      });
      if (!saved.ok) throw new Error("技能已执行，但历史保存失败");
    } else {
      let image = null;
      if (visualConfigured && !attachments.length) {
        if (visionRequired && !window.lewisVision)
          throw new Error("摄像头模块未加载，请重启新版 Lewis");
        image = window.lewisVision?.capture
          ? await window.lewisVision.capture({
              startCamera: Boolean(visionRequired),
            })
          : window.lewisVision?.snapshot();
      }
      if (visionRequired && !attachments.length && !image)
        throw new Error(
          "本轮未取得摄像头画面，请开启摄像头并检查 Windows 摄像头权限",
        );
      $("visionChatStatus").textContent = image
        ? "本轮附摄像头画面 → " + visual.model
        : settings.visionEnabled && !visualConfigured
          ? "视觉未配置：请在设置中填写视觉 API 地址和 Key"
          : "本轮未附图";
      const response = await fetch("/api/chat", {
        signal: chatController.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId,
          settings,
          operationId: crypto.randomUUID(),
          ...(attachments.length
            ? { images: attachments.map((item) => item.image) }
            : image
              ? { image }
              : {}),
        }),
      });
      if (!response.ok) {
        const data = await readJSONResponse(response, "/api/chat");
        throw new Error(data.error || "请求失败");
      }
      removeMessage(thinkingId);
      const msgId = addMessage("", "ai");
      replyElement = $(msgId).querySelector(".message-bubble");
      await readEvents(response, (data) => {
        if (data.plan)
          $("taskProgress").textContent = data.plan.steps?.length
            ? "执行计划：" + data.plan.steps.join(" → ")
            : data.plan.phase === "finished"
              ? "本轮执行结束"
              : "正在执行";
        if (data.tool) window.lewisWebPanel?.activity(data.tool);
        if (data.vision)
          $("visionChatStatus").textContent =
            `本轮${data.vision.attached ? { attachment: "已附上传图片", history: "引用近期上传图片", camera: "已附摄像头画面" }[data.vision.source] || "已附图" : "未附图"} · ${data.vision.model}`;
        if (data.tool) {
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
            web_play_video: "播放网页视频",
            weather: "查询天气",
            open_app: "打开程序",
            list_apps: "查找应用",
            desktop_get_window: "读取应用窗口",
            desktop_click: "操作应用",
            desktop_type: "输入内容",
            music_play: "播放音乐",
            music_control: "控制音乐",
            open_website: "打开网站",
            set_volume: "调整音量",
            wechat_read_chat: "读取微信",
            wechat_send_message: "发送微信",
          };
          $("toolStatus").textContent =
            `${names[data.tool.name] || "执行扩展技能"}：${data.tool.state === "running" ? "正在执行" : data.tool.state === "done" ? "完成" : data.tool.state === "retrying" ? "正在重试" : window.lewisFriendlyError?.(data.tool.error) || "操作未完成"}`;
        }
        if (data.content) {
          fullText += data.content;
          replyElement.textContent = fullText;
          scrollToBottom();
        }
        if (data.context)
          $("contextStatus").textContent =
            `上下文估算 ${data.context.estimatedTokens} tokens · 已截断 ${data.context.droppedMessages} 条旧消息`;
        if (data.usage)
          $("contextStatus").textContent =
            `模型实际使用：${data.usage.prompt_tokens ?? "?"} 输入 / ${data.usage.completion_tokens ?? "?"} 输出 tokens`;
      });
    }
    window.lewisAttachments?.clear();
    lastReply = fullText;
    publish({ type: "say", text: fullText.slice(0, 200), duration: 8000 });
    if (settings.autoTts) {
      try {
        await speakText(fullText);
      } catch (error) {
        addMessage(
          `⚠️ 回复已保存，播报失败：${window.lewisFriendlyError?.(error, "播报") || "播报暂时不可用"}；可点“重播回复”`,
          "ai",
        );
      }
    }
  } catch (error) {
    if (thinkingId) removeMessage(thinkingId);
    const explanation = window.lewisFriendlyError?.(error) || error.message;
    if (replyElement && fullText)
      replyElement.textContent = `${fullText}\n回复中断：${explanation}`;
    else addMessage(explanation, "ai");
  } finally {
    isSending = false;
    $("sendBtn").disabled = false;
    voice.setBusy(false);
    // 后台语音和迟到回复不能向隐藏窗口请求输入焦点，避免打断全屏应用。
    if (restoreInputFocus && !document.hidden && document.hasFocus())
      input.focus({ preventScroll: true });
    loadSessionList().catch((error) => status(error.message));
  }
}

function stopSpeech() {
  playbackController?.abort();
  if (voice?.interruptListening) void voice.setInterruptListening(false);
}
function syncSpeechControls() {
  const enabled = Boolean(settings.autoTts),
    button = $("speechToggle");
  $("autoTts").checked = enabled;
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute(
    "aria-label",
    enabled ? "关闭Lewis播报" : "开启Lewis播报",
  );
  button.title = enabled ? "关闭播报，麦克风仍继续监听" : "开启Lewis播报";
  button.querySelector("span").textContent = enabled ? "播报开" : "播报关";
  button.querySelector("i").className =
    "ph " + (enabled ? "ph-speaker-high" : "ph-speaker-slash");
}
function setSpeechEnabled(enabled) {
  settings.autoTts = Boolean(enabled);
  syncSpeechControls();
  writeStorage("lewis_settings", settings);
  if (!settings.autoTts) stopSpeech();
}
async function speakText(text, { speechOptions, wakeGreeting = false } = {}) {
  if (!settings.autoTts) return;
  const parts = window.lewisSpeech.chunks(text);
  const options = speechOptions || window.lewisSpeech.options(settings);
  stopSpeech();
  const controller = new AbortController();
  controller.wakeGreeting = wakeGreeting;
  const greetingGeneration = voice.generation;
  let greetingStarted = false;
  playbackController = controller;
  if (!wakeGreeting) voice.pauseMic(true);
  status(
    wakeGreeting ? "我在，你说。" : "正在生成语音…",
    wakeGreeting ? "listening" : "thinking",
  );
  try {
    if (!wakeGreeting) await voice.setInterruptListening?.(true);
    const synthesize = async (part) => {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: part,
          voiceServiceUrl: settings.voiceServiceUrl,
          ...options,
        }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(120000),
        ]),
      });
      if (!response.ok) {
        const data = await readJSONResponse(response, "/api/tts");
        throw new Error(data.error || "TTS 请求失败");
      }
      return response.blob();
    };
    let pending = parts.length ? synthesize(parts[0]) : null;
    pending?.catch(() => {});
    for (let index = 0; index < parts.length; index++) {
      if (controller.signal.aborted) break;
      const blob = await pending;
      if (controller.signal.aborted || !settings.autoTts) break;
      if (wakeGreeting && !greetingStarted) {
        // 合成期间继续录音。用户已经开始说话/提交任务时，不再插入应答。
        if (
          voice.hasSpeech ||
          voice.processing ||
          isSending ||
          voice.generation !== greetingGeneration ||
          voice.idleMode?.() === "off"
        )
          break;
        greetingStarted = true;
        controller.greetingStarted = true;
        voice.pauseMic(true);
        await voice.setInterruptListening?.(true);
        if (controller.signal.aborted) break;
      }
      pending = index + 1 < parts.length ? synthesize(parts[index + 1]) : null;
      pending?.catch(() => {}); // A cancelled next chunk must not become an unhandled rejection.
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      status("正在播报… · 可说“Lewis 停下”", "speaking");
      try {
        await new Promise((resolve, reject) => {
          const abort = () => {
            audio.pause();
            resolve();
          };
          controller.signal.addEventListener("abort", abort, { once: true });
          audio.onended = () => {
            controller.signal.removeEventListener("abort", abort);
            resolve();
          };
          audio.onerror = () => {
            controller.signal.removeEventListener("abort", abort);
            reject(new Error("音频播放失败"));
          };
          if (controller.signal.aborted) {
            abort();
            return;
          }
          audio.play().catch((error) => {
            controller.signal.removeEventListener("abort", abort);
            reject(
              new Error(
                error.name === "NotAllowedError"
                  ? "浏览器阻止自动播放，请点“重播回复”"
                  : error.message,
              ),
            );
          });
        });
      } finally {
        audio.pause();
        URL.revokeObjectURL(url);
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    if (playbackController === controller) {
      controller.abort(); // Cancel an unused prefetched chunk after playback failure or interruption.
      playbackController = null;
      if (!wakeGreeting || greetingStarted) {
        await voice.setInterruptListening?.(false);
        if (!isSending) voice.setBusy(false);
      }
    }
  }
}
async function acknowledgeWake() {
  if (isSending || playbackController || voice.hasSpeech || voice.processing)
    return;
  const text = "嗯，我在，你说。";
  publish({ type: "say", text, duration: 3000 });
  if (!settings.autoTts) return;
  try {
    await speakText(text, { wakeGreeting: true });
  } catch (error) {
    status("唤醒应答暂时播不出来，我仍在听；请检查语音服务。", "listening");
  }
}
function parseSkillCommand(text) {
  if (window.parseWechatSendIntent?.(text)?.mode === "compose") return null;
  const wechat = window.parseWechatCommand?.(text);
  if (wechat && !(wechat.skill === "wechat-read" && /总结微信/u.test(text)))
    return wechat;
  const site = window.parseWebsiteCommand?.(text);
  if (site) return site;
  const search = window.parseSearchCommand?.(text);
  if (search) return search;
  const desktop = window.parseDesktopCommand?.(text);
  if (desktop) return desktop;
  const read = text.match(
    /^(?:(静态)读取网页|读取网页|阅读网页)\s*(https?:\/\/\S+)$/,
  );
  if (read)
    return {
      skill: "read-webpage",
      url: read[2],
      mode: read[1] ? "static" : "auto",
    };
  if (/^(?:读取|阅读)(?:当前|这个)(?:网页|页面)[。！!]?$/u.test(text))
    return { skill: "read-current-page" };
  const website = text.match(/^打开(?:网站|网页)\s*(https?:\/\/\S+)$/);
  if (website) return { skill: "open-website", url: website[1] };
  const names = {
    记事本: "notepad",
    计算器: "calculator",
    文件资源管理器: "explorer",
    资源管理器: "explorer",
    Edge: "edge",
    edge: "edge",
    Chrome: "chrome",
    chrome: "chrome",
    "VS Code": "vscode",
    vscode: "vscode",
    微信: "wechat",
  };
  const open = text.match(/^(?:打开|启动)\s*(.+?)[。！!]?$/);
  if (open && names[open[1]]) return { skill: "open-app", app: names[open[1]] };
  if (/^打开\s*记事本[。！!]?$/u.test(text))
    return { skill: "open-app", app: "notepad" };
  if (/^打开\s*计算器[。！!]?$/u.test(text))
    return { skill: "open-app", app: "calculator" };
  const volume = text.match(
    /^(?:设置|调整)?(?:电脑)?音量(?:到|为)?\s*(\d{1,3})\s*[%％]?[。！!]?$/u,
  );
  if (volume) return { skill: "volume", value: Number(volume[1]) };
  const weather = text.match(/^(?:查|查询)\s*(.+?)\s*(?:的)?天气[。？?]?$/u);
  if (weather) return { skill: "weather", city: weather[1] };
  return null;
}

function bindEvents() {
  $("cancelTask").onclick = async () => {
    chatController?.abort();
    stopSpeech();
    await fetch("/api/chat/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
    status("已请求取消当前任务");
  };
  $("steerTask").onclick = async () => {
    const response = await fetch("/api/chat/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, text: $("taskSteering").value }),
    });
    const data = await readJSONResponse(response, "任务补充");
    status(data.error || data.text);
    if (response.ok) $("taskSteering").value = "";
  };
  $("sendBtn").addEventListener("click", sendMessage);
  $("messageInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  });
  $("messageInput").addEventListener("input", () => {
    $("messageInput").style.height = "auto";
    $("messageInput").style.height =
      Math.min($("messageInput").scrollHeight, 150) + "px";
  });
  $("voiceBtn").addEventListener("click", () => {
    if (!isSending)
      voice.toggleManual().catch((error) => status(`⚠️ ${error.message}`));
  });
  $("wakeEnabled").addEventListener("change", () => {
    if ($("wakeEnabled").checked) void startListening("wake");
    else {
      listeningRequest++;
      void voice.toggleWake(false);
    }
  });
  $("continuousEnabled").addEventListener("change", () => {
    if ($("continuousEnabled").checked) void startListening("continuous");
    else {
      listeningRequest++;
      void voice.toggleContinuous(false);
    }
  });
  $("autoTts").addEventListener("change", () => {
    setSpeechEnabled($("autoTts").checked);
  });
  $("speechToggle").addEventListener("click", () =>
    setSpeechEnabled(!settings.autoTts),
  );
  $("speechPreview").addEventListener("click", async () => {
    if (!settings.autoTts) {
      $("speechPreviewStatus").textContent = "播报已关闭，请先在顶部开启播报。";
      return;
    }
    if (isSending || playbackController) {
      $("speechPreviewStatus").textContent = "等这轮回复结束后再试听。";
      return;
    }
    try {
      const speechOptions = window.lewisSpeech.options({
        speechVoice: $("speechVoice").value,
        speechRate: Number($("speechRate").value),
        speechPitch: Number($("speechPitch").value),
      });
      $("speechPreviewStatus").textContent = "正在试听…";
      await speakText("嗯，我在。你接着说，我听着呢。", { speechOptions });
      $("speechPreviewStatus").textContent = "试听结束，喜欢的话可以保存设置。";
    } catch (error) {
      $("speechPreviewStatus").textContent =
        window.lewisFriendlyError?.(error, "试听") ||
        "试听暂时不可用，请检查语音服务。";
    }
  });
  $("stopSpeechBtn").addEventListener("click", stopSpeech);
  $("replayBtn").addEventListener("click", async () => {
    if (!lastReply || isSending || !settings.autoTts) return;
    voice.setBusy(true);
    try {
      await speakText(lastReply);
    } catch (error) {
      status(error.message);
    }
  });
  $("newChatBtn").addEventListener("click", () => {
    if (isSending) return;
    stopSpeech();
    document
      .querySelectorAll(".message")
      .forEach((element) => element.remove());
    $("welcome").style.display = "";
    sessionReady = createSession(true);
    sessionReady.catch((error) => status(error.message));
  });
  $("historySessions").addEventListener("change", () => {
    const selected = $("historySessions").value;
    if (isSending || !selected) {
      $("historySessions").value = sessionId || "";
      return;
    }
    stopSpeech();
    writeStorage("lewis_session", selected);
    lastReply = "";
    document
      .querySelectorAll(".message")
      .forEach((element) => element.remove());
    $("welcome").style.display = "";
    sessionReady = createSession();
    sessionReady.catch((error) => status(error.message));
  });
  $("settingsBtn").addEventListener("click", () => {
    $("settingsPanel").classList.add("open");
    $("overlay").classList.add("active");
  });
  $("settingsClose").addEventListener("click", closeSettings);
  $("overlay").addEventListener("click", closeSettings);
  $("saveSettingsBtn").addEventListener("click", saveSettings);
  $("voiceHealthBtn").addEventListener("click", async () => {
    try {
      const response = await fetch("/api/voice/health", {
        headers: { "X-Voice-Service": settings.voiceServiceUrl },
      });
      const data = await readJSONResponse(response, "/api/voice/health");
      if (!response.ok) throw new Error(data.error);
      status(
        `语音服务在线 · ASR ${data.asr_loaded ? "已加载" : "首次使用时加载"} · VAD ${data.vad}`,
      );
    } catch (error) {
      status(`⚠️ ${error.message}`);
    }
  });
  document.querySelector('[title="技能"]').addEventListener("click", () => {
    if (document.body.dataset.page === "plugins") window.lewisNavigate();
    $("skillPanel").hidden = !$("skillPanel").hidden;
  });
  $("weatherBtn").addEventListener("click", () =>
    sendSuggestion(`查询${$("weatherCity").value}天气`),
  );
  $("notepadBtn").addEventListener("click", () => sendSuggestion("打开记事本"));
  $("calculatorBtn").addEventListener("click", () =>
    sendSuggestion("打开计算器"),
  );
  $("volumeBtn").addEventListener("click", () =>
    sendSuggestion(`音量${$("volumeValue").value}%`),
  );
  $("wechatStatusBtn").addEventListener("click", () =>
    sendSuggestion("检查微信"),
  );
  $("wechatReadBtn").addEventListener("click", () =>
    sendSuggestion(`读取微信${$("wechatRecipient").value.trim()}聊天`),
  );
  $("wechatSendBtn").addEventListener("click", () =>
    sendSuggestion(
      `微信给${$("wechatRecipient").value.trim()}发消息说${$("wechatText").value}`,
    ),
  );
  $("webSearchBtn").addEventListener("click", () =>
    sendSuggestion(`搜索${$("webQuery").value}`),
  );
  $("readWebBtn").addEventListener("click", () =>
    sendSuggestion(
      `${$("webReadMode").value === "static" ? "静态" : ""}读取网页 ${$("webURL").value}`,
    ),
  );
  $("openWebBtn").addEventListener("click", () =>
    sendSuggestion(`打开网站 ${$("webURL").value}`),
  );
  $("avatarInput").addEventListener("change", async () => {
    const file = $("avatarInput").files[0];
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 1024 * 1024
    ) {
      status("头像支持 1MB 内 PNG/JPEG/WebP");
      return;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    settings.avatar = dataUrl;
    writeStorage("lewis_settings", settings);
    publish({ type: "avatar", url: dataUrl });
    status("桌宠头像已更新");
  });
  $("resetAvatarBtn").addEventListener("click", () => {
    delete settings.avatar;
    writeStorage("lewis_settings", settings);
    publish({ type: "avatar", url: "" });
  });
}
async function startListening(mode) {
  const request = ++listeningRequest;
  try {
    if (window.electronAPI?.voiceReady) {
      status("正在准备后台语音服务…");
      await window.electronAPI.voiceReady();
    }
    if (request !== listeningRequest) return;
    if (mode === "wake") {
      await voice.toggleWake(true);
      void voice.warmWakeDetector?.();
    } else await voice.toggleContinuous(true);
  } catch (error) {
    if (request !== listeningRequest) return;
    const label = `⚠️ ${error.message}；检查语音服务后重新开启监听`;
    status(label);
    window.electronAPI?.voiceStatus?.({ mode: "off", label });
  }
}
async function receivePetAction(data) {
  if (data?.type === "stop-speech") {
    stopSpeech();
    return;
  }
  if (data?.type === "pet-task" && typeof data.text === "string") {
    await sessionReady;
    if (!isSending) void sendSuggestion(data.text);
    else publish({ type: "say", text: "正在处理当前任务，请稍后再试。" });
    return;
  }
  if (data?.type === "backend-failed") {
    status(data.text);
    return;
  }
  if (data?.type === "backend-restored") {
    sessionReady = createSession();
    sessionReady.catch((error) => status(error.message));
    return;
  }
  if (data?.type === "background-listen") {
    settings.autoMic = true;
    settings.startupVoiceMode = "wake";
    writeStorage("lewis_settings", settings);
    $("autoMic").checked = true;
    $("startupVoiceMode").value = "wake";
    await startListening("wake");
    return;
  }
  if (data?.type === "pause-listening") {
    listeningRequest++;
    await voice.toggleWake(false);
    return;
  }
  if (data?.type === "listen") {
    $("continuousEnabled").checked = !voice.continuousEnabled;
    $("continuousEnabled").dispatchEvent(new Event("change"));
  }
  if (data?.type === "ready")
    publish({ type: "avatar", url: settings.avatar || "" });
}
document.addEventListener("DOMContentLoaded", async () => {
  const legacy = readStorage("lewis_settings", {});
  try {
    if (window.electronAPI?.credentialsGet) {
      const saved = await window.electronAPI.credentialsGet();
      const migrate = {};
      for (const key of ["apiKey", "visionApiKey"])
        if (
          typeof legacy[key] === "string" &&
          /^[\x21-\x7e]{1,512}$/.test(legacy[key])
        )
          migrate[key] = legacy[key];
      if (Object.keys(migrate).length)
        await window.electronAPI.credentialsSet(migrate);
      restoredCredentials = { ...saved, ...migrate };
    } else
      restoredCredentials = {
        apiKey: legacy.apiKey,
        visionApiKey: legacy.visionApiKey,
      };
    writeStorage("lewis_settings", legacy);
  } catch (error) {
    status("凭据恢复失败：" + error.message);
  }
  loadSettings();
  voice = new LewisVoice({
    getSettings: () => settings,
    onState: (...args) => {
      status(...args);
      window.electronAPI?.voiceStatus?.({
        mode:
          voice?.idleMode?.() ||
          (voice?.continuousEnabled
            ? "conversation"
            : voice?.wakeEnabled
              ? "wake"
              : "off"),
        label: args[0],
      });
    },
    onText: (text) => {
      return sendSuggestion(text, { restoreInputFocus: false });
    },
    onWakeReady: acknowledgeWake,
    onSpeechStart: () => {
      if (
        playbackController?.wakeGreeting &&
        !playbackController.greetingStarted
      )
        stopSpeech();
    },
    onInterrupt: () => {
      window.lewisVisionObserver?.quiet();
      stopSpeech();
      status("已停止播报", "idle");
    },
    onWake: () => {
      window.electronAPI?.showPet();
      publish({ type: "wake" });
    },
  });
  bindEvents();
  sessionReady = createSession();
  sessionReady.catch((error) => status(`⚠️ ${error.message}`));
  if (channel) channel.onmessage = (event) => receivePetAction(event.data);
  window.electronAPI?.onMessage(receivePetAction);
  publish({ type: "avatar", url: settings.avatar || "" });
  window.lewisSetMicrophone = async (enabled) => {
    if (enabled) await startListening("continuous");
    else {
      listeningRequest++;
      await voice.toggleWake(false);
      await voice.toggleContinuous(false);
    }
  };
  window.lewisStopSpeech = stopSpeech;
  window.lewisHidePet = () => {
    window.electronAPI?.hidePet();
    channel?.postMessage({ type: "hide" });
  };
  window.lewisStatus = status;
  window.lewisGetSettings = () => ({ ...settings });
  window.lewisRunGestureTask = (text) =>
    sendSuggestion(text, { restoreInputFocus: false });
  window.lewisIsBusy = () =>
    isSending || Boolean(playbackController) || Boolean(voice?.processing);
  window.lewisProactiveSay = async (text, { label = "视觉观察" } = {}) => {
    if (isSending || playbackController || voice?.processing) return false;
    isSending = true;
    $("sendBtn").disabled = true;
    voice.setBusy(true);
    try {
      addMessage(text, "ai", { label });
      lastReply = text;
      publish({ type: "say", text, duration: 8000 });
      if (settings.autoTts) await speakText(text);
      return true;
    } catch (error) {
      status(`主动播报失败：${error.message}`);
      return true;
    } finally {
      isSending = false;
      $("sendBtn").disabled = false;
      voice.setBusy(false);
    }
  };
  sessionReady
    .then(async () => {
      if (settings.autoCamera) {
        if (window.lewisVision) void window.lewisVision.start().catch(() => {});
        else
          window.addEventListener(
            "lewis-vision-ready",
            () => void window.lewisVision.start().catch(() => {}),
            { once: true },
          );
      }
      if (settings.autoMic) await startListening(settings.startupVoiceMode);
    })
    .catch(() => {});
});
window.addEventListener("pagehide", () => {
  listeningRequest++;
  stopSpeech();
  void voice?.destroy();
  window.lewisVision?.stop();
  channel?.close();
});

// 添加消息
function addMessage(text, role, { images = [], label } = {}) {
  const chatArea = document.getElementById("chatArea");
  const id = "msg-" + crypto.randomUUID();

  const msgDiv = document.createElement("div");
  msgDiv.id = id;
  msgDiv.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "ai" ? "L" : "我";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = text;
  if (label) {
    const badge = document.createElement("small");
    badge.className = "observation-label";
    badge.textContent = label;
    msgDiv.append(badge);
  }
  for (const item of images) {
    const img = document.createElement("img");
    img.src = item.image;
    img.alt = item.label || "附件图片";
    img.style.cssText = "max-width:180px;max-height:140px;display:block";
    bubble.append(img);
  }

  if (role === "ai") {
    msgDiv.appendChild(avatar);
    msgDiv.appendChild(bubble);
  } else {
    msgDiv.appendChild(bubble);
    msgDiv.appendChild(avatar);
  }

  chatArea.appendChild(msgDiv);
  scrollToBottom();

  return id;
}

// 添加思考中
function addThinking() {
  const chatArea = document.getElementById("chatArea");
  const id = "thinking-" + Date.now();

  const msgDiv = document.createElement("div");
  msgDiv.id = id;
  msgDiv.className = "message ai";

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = "L";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  const thinking = document.createElement("div");
  thinking.className = "thinking";
  thinking.innerHTML =
    '<div class="thinking-dot"></div><div class="thinking-dot"></div><div class="thinking-dot"></div>';

  bubble.appendChild(thinking);
  msgDiv.appendChild(avatar);
  msgDiv.appendChild(bubble);
  chatArea.appendChild(msgDiv);
  scrollToBottom();

  return id;
}

// 移除消息
function removeMessage(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// 滚动到底部
function scrollToBottom() {
  const chatArea = document.getElementById("chatArea");
  chatArea.scrollTop = chatArea.scrollHeight;
}
