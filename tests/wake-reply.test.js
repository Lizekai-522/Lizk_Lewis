const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { JSDOM } = require("jsdom");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(tts, saved = {}) {
  const window = new JSDOM(
    fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8"),
    {
      url: "http://localhost:3000",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  ).window;
  const metrics = { tts: 0, chat: 0, audio: null, paused: 0 };
  window.AbortController = AbortController;
  window.AbortSignal = AbortSignal;
  window.Blob = Blob;
  window.TextDecoder = TextDecoder;
  window.URL.createObjectURL = () => "blob:wake";
  window.URL.revokeObjectURL = () => {};
  window.Audio = class {
    constructor() {
      metrics.audio = this;
    }
    async play() {}
    pause() {
      metrics.paused++;
    }
  };
  const id = "11111111-1111-4111-8111-111111111111";
  const json = (data) =>
    new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  window.fetch = async (url, request) => {
    if (url === "/api/tts") {
      metrics.tts++;
      assert.equal(JSON.parse(request.body).text, "嗯，我在，你说。");
      return tts(request);
    }
    if (url === "/api/chat") {
      metrics.chat++;
      return new Response(
        'data: {"content":"好呀，我们接着聊。"}\n\ndata: [DONE]\n\n',
      );
    }
    if (url === "/api/health") return json({ apiVersion: 2 });
    if (url === "/api/session") return json({ sessionId: id });
    if (url === "/api/sessions") return json({ sessions: [] });
    if (url.startsWith("/api/history/")) return json({ messages: [] });
    if (url === "/api/capabilities") return json({});
    if (url === "/api/skills") return json({ skills: [] });
    throw Error("Unexpected URL " + url);
  };
  window.localStorage.setItem(
    "lewis_settings",
    JSON.stringify({
      autoMic: false,
      autoCamera: false,
      autoTts: true,
      apiKey: "test",
      wakeConversationSeconds: 60,
      ...saved,
    }),
  );
  for (const name of ["appearance", "http", "speech", "voice", "app"])
    window.eval(
      fs.readFileSync(
        path.join(__dirname, "../public/js/" + name + ".js"),
        "utf8",
      ) +
        (name === "app"
          ? "\nwindow.testApi={ready:()=>sessionReady,voice:()=>voice,enable:value=>settings.autoTts=value,settings:()=>settings};"
          : ""),
    );
  for (let i = 0; i < 50 && !window.testApi.ready(); i++) await delay(10);
  await window.testApi.ready();
  const voice = window.testApi.voice();
  voice.wakeEnabled = true;
  voice.keepAwake();
  voice.mode = "conversation";
  const track = { enabled: true, stop() {} };
  voice.stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  voice.context = {
    sampleRate: 16000,
    state: "running",
    resume: async () => {},
    close: async () => {},
  };
  return { window, voice, metrics, track };
}
test("只喊名字播放应答，随后恢复持续聆听；无需模型请求，播报关闭仍保持聆听", async () => {
  const { window, voice, metrics, track } = await fixture(
    () => new Response("audio"),
  );
  try {
    assert.equal(
      window.testApi.settings().wakeConversationSeconds,
      0,
      "旧版默认一分钟迁移为持续交谈",
    );
    const greeting = voice.onWakeReady();
    for (let i = 0; i < 50 && !metrics.audio; i++) await delay(10);
    assert.ok(metrics.audio);
    assert.equal(metrics.tts, 1);
    assert.equal(metrics.chat, 0);
    assert.equal(voice.interruptListening, true);
    metrics.audio.onended();
    await greeting;
    assert.equal(voice.interruptListening, false);
    assert.equal(track.enabled, true);
    assert.equal(voice.awakeUntil, Infinity);
    window.document.getElementById("speechToggle").click();
    await voice.onWakeReady();
    assert.equal(metrics.tts, 1);
    assert.equal(voice.idleMode(), "conversation");
    // 接着说第二句，任务仍经原对话路径处理；不需要再次唤醒。
    voice.upload = async (endpoint) =>
      endpoint === "vad" ? { has_voice: true } : { text: "接着聊聊吧" };
    voice.hasSpeech = true;
    voice.samples = 5000;
    voice.chunks = [new Float32Array(5000)];
    await voice.submit("asr");
    assert.equal(metrics.chat, 1);
    assert.equal(voice.idleMode(), "conversation");
  } finally {
    window.close();
  }
});
test("生成应答期间继续录音，用户开始说话取消应答且保留指令音频", async () => {
  let aborted = false;
  const { window, voice, metrics, track } = await fixture(
    (request) =>
      new Promise((resolve, reject) =>
        request.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("stop", "AbortError"));
          },
          { once: true },
        ),
      ),
  );
  try {
    const greeting = voice.onWakeReady();
    await delay(10);
    assert.equal(track.enabled, true);
    assert.equal(voice.interruptListening, undefined);
    voice.capture(new Float32Array(1600).fill(0.1));
    await greeting;
    assert.equal(aborted, true);
    assert.equal(metrics.audio, null);
    assert.equal(voice.samples, 1600);
    assert.equal(voice.hasSpeech, true);
    assert.equal(track.enabled, true);
  } finally {
    window.close();
  }
});
test("应答合成失败保持聆听，提示中文；之后的时长选择不被再次迁移", async () => {
  const { window, voice, metrics, track } = await fixture(
    () =>
      new Response(JSON.stringify({ error: "fetch failed" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    { wakeConversationConfigured: true, wakeConversationSeconds: 30 },
  );
  try {
    await voice.onWakeReady();
    assert.equal(metrics.audio, null);
    assert.equal(track.enabled, true);
    assert.equal(voice.wakeEnabled, true);
    assert.match(
      window.document.getElementById("voiceStatus").textContent,
      /仍在听/,
    );
    assert.doesNotMatch(
      window.document.getElementById("voiceStatus").textContent,
      /fetch failed/,
    );
    assert.equal(window.testApi.settings().wakeConversationSeconds, 30);
  } finally {
    window.close();
  }
});
