const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const speech = require("../public/js/speech");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("播报文本保留正文和顺序，代码链接留在屏幕；参数校验支持负语速", () => {
  assert.deepEqual(speech.options({ speechRate: -10, speechPitch: 4 }), {
    voice: "zh-CN-XiaoxiaoNeural",
    rate: "-10%",
    pitch: "+4Hz",
  });
  assert.throws(() => speech.options({ speechPitch: 99 }), /音调/);
  const spoken = speech
    .chunks(
      "## 好的\n**先看这里。**\n[文档](https://example.com)\n```js\nthrow Error();\n```",
    )
    .join("");
  assert.match(spoken, /好的.*先看这里。.*文档.*代码我放在屏幕上了/s);
  assert.doesNotMatch(spoken, /throw|https|\*|#/);
  const text = "第一句。" + "接着说".repeat(200) + "最后一句。";
  const parts = speech.chunks(text);
  assert.ok(parts.every((part) => part.length <= 240));
  assert.equal(parts.join(""), text);
});

test("唤醒一次可继续交谈，长回复后重新计时，空闲才恢复后台唤醒监听", async () => {
  let now = 100000,
    wakes = 0;
  const submitted = [],
    uploads = [];
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  const runtime = {
    window: {},
    Date: Clock,
    Blob,
    AbortController,
    AbortSignal,
    navigator: {},
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../public/js/voice.js"), "utf8"),
    runtime,
  );
  const voice = new runtime.window.LewisVoice({
    getSettings: () => ({ wakeConversationSeconds: 30 }),
    onWake: () => wakes++,
    onState() {},
    onText: (text) => submitted.push(text),
  });
  voice.ensureMic = async () => {
    voice.context = { sampleRate: 16000 };
  };
  voice.releaseMic = async () => {};
  await voice.toggleWake(true);
  const segment = () => {
    voice.hasSpeech = true;
    voice.samples = 5000;
    voice.chunks = [new Float32Array(5000)];
  };
  voice.upload = async (endpoint) => {
    uploads.push(endpoint);
    return endpoint === "wake-word"
      ? { detected: true, text: "李维斯" }
      : endpoint === "vad"
        ? { has_voice: true }
        : { text: "打开计算器" };
  };
  segment();
  await voice.submit("wake-word");
  assert.equal(voice.mode, "conversation");
  assert.equal(wakes, 1);
  segment();
  await voice.submit("asr");
  assert.deepEqual(submitted, ["打开计算器"]);
  assert.deepEqual(uploads, ["wake-word", "vad", "asr"]);
  voice.setBusy(true);
  now += 90000;
  voice.setBusy(false);
  assert.equal(voice.mode, "conversation");
  now += 20000;
  voice.capture(new Float32Array(160));
  assert.equal(voice.mode, "conversation");
  now += 11000;
  voice.capture(new Float32Array(160));
  assert.equal(voice.mode, "wake");
  assert.equal(wakes, 1);
  await voice.toggleWake(false);
  assert.equal(voice.awakeUntil, 0);
  assert.equal(voice.mode, "off");
});

test("顶部播报关闭立即打断并取消预取，持久保存，后续文字回复继续且不开麦克风开关", async () => {
  const window = new JSDOM(
    fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8"),
    {
      url: "http://localhost:3000",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  ).window;
  let audio,
    pause = 0,
    tts = 0,
    prefetchedAbort = false,
    chat = 0,
    micToggles = 0;
  const id = "11111111-1111-4111-8111-111111111111";
  window.AbortController = AbortController;
  window.AbortSignal = AbortSignal;
  window.TextDecoder = TextDecoder;
  window.URL.createObjectURL = () => "blob:test";
  window.URL.revokeObjectURL = () => {};
  window.Audio = class {
    constructor() {
      audio = this;
    }
    async play() {}
    pause() {
      pause++;
    }
  };
  window.LewisVoice = class {
    setBusy(value) {
      this.busy = value;
    }
    pauseMic() {}
    async setInterruptListening(value) {
      this.interruptListening = value;
    }
    async toggleWake() {
      micToggles++;
    }
    async toggleContinuous() {
      micToggles++;
    }
  };
  const json = (data) =>
    new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  window.fetch = async (url, request) => {
    if (url === "/api/health") return json({ apiVersion: 2 });
    if (url === "/api/session") return json({ sessionId: id });
    if (url === "/api/sessions") return json({ sessions: [] });
    if (url.startsWith("/api/history/")) return json({ messages: [] });
    if (url === "/api/capabilities") return json({});
    if (url === "/api/skills") return json({ skills: [] });
    if (url === "/api/chat") {
      chat++;
      return new Response(
        "data: " +
          JSON.stringify({
            content: "第一段。".repeat(45) + "第二段。".repeat(30),
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    }
    if (url === "/api/tts") {
      tts++;
      assert.equal(JSON.parse(request.body).rate, "+6%");
      if (tts === 1) return new Response("audio");
      return new Promise((resolve, reject) =>
        request.signal.addEventListener(
          "abort",
          () => {
            prefetchedAbort = true;
            reject(new DOMException("stop", "AbortError"));
          },
          { once: true },
        ),
      );
    }
    throw Error("Unexpected URL " + url);
  };
  window.localStorage.setItem(
    "lewis_settings",
    JSON.stringify({
      autoMic: false,
      autoCamera: false,
      autoTts: true,
      apiKey: "test",
    }),
  );
  try {
    for (const name of ["appearance", "http", "speech", "app"])
      window.eval(
        fs.readFileSync(
          path.join(__dirname, "../public/js", name + ".js"),
          "utf8",
        ) +
          (name === "app"
            ? "\nwindow.testApi = { ready: () => sessionReady, send: sendSuggestion };"
            : ""),
      );
    for (let i = 0; i < 30 && !window.testApi.ready(); i++) await delay(10);
    await window.testApi.ready();
    const sending = window.testApi.send("先回复我");
    for (let i = 0; i < 50 && !audio; i++) await delay(10);
    assert.ok(audio);
    assert.equal(tts, 2);
    window.document.getElementById("speechToggle").click();
    await sending;
    assert.ok(pause > 0);
    assert.equal(prefetchedAbort, true);
    assert.equal(
      JSON.parse(window.localStorage.getItem("lewis_settings")).autoTts,
      false,
    );
    assert.equal(window.document.getElementById("autoTts").checked, false);
    assert.equal(
      window.document
        .getElementById("speechToggle")
        .getAttribute("aria-pressed"),
      "false",
    );
    await window.testApi.send("继续文字回复");
    assert.equal(chat, 2);
    assert.equal(tts, 2);
    assert.equal(micToggles, 0);
  } finally {
    window.close();
  }
});
