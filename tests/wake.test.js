const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function voiceFixture() {
  const runtime = {
    window: {},
    Date,
    Blob,
    AbortController,
    AbortSignal,
    navigator: {},
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../public/js/voice.js"), "utf8"),
    runtime,
  );
  const events = [],
    states = [];
  const voice = new runtime.window.LewisVoice({
    getSettings: () => ({}),
    onWake: () => events.push("wake"),
    onText: (text) => events.push(text),
    onState: (...state) => states.push(state),
  });
  voice.context = { sampleRate: 16000 };
  voice.mode = "wake";
  voice.wakeEnabled = true;
  voice.releaseMic = async () => {};
  const segment = () => {
    voice.hasSpeech = true;
    voice.samples = 16000;
    voice.chunks = [new Float32Array(16000).fill(0.1)];
  };
  return { voice, events, states, segment };
}

test("轻量预检测命中时录音不中断；整句任务只提交一次，保留微信正文标点", async () => {
  const { voice, events, segment } = voiceFixture();
  segment();
  const endpoints = [];
  voice.upload = async (endpoint) => {
    endpoints.push(endpoint);
    return endpoint === "wake-probe"
      ? { available: true, detected: true }
      : { text: "李维斯，微信给张三发消息 Hello World，金额12.50元。" };
  };
  await voice.probeWake();
  assert.deepEqual(events, ["wake"]);
  assert.equal(voice.processing, false);
  assert.equal(voice.hasSpeech, true);
  assert.equal(voice.samples, 16000);
  voice.capture(new Float32Array(1600).fill(0.1));
  assert.equal(voice.samples, 17600);
  await voice.submit("wake-word");
  assert.deepEqual(endpoints, ["wake-probe", "asr"]);
  assert.deepEqual(events, [
    "wake",
    "微信给张三发消息 Hello World，金额12.50元。",
  ]);
  assert.equal(voice.mode, "conversation");
});

test("关闭/切换监听后迟到的预检测结果不能再唤醒", async () => {
  for (const cancel of [
    (voice) => voice.toggleWake(false),
    (voice) => voice.setBusy(true),
    (voice) => voice.resetSegment(),
  ]) {
    const { voice, events, segment } = voiceFixture();
    segment();
    let resolve;
    voice.upload = () =>
      new Promise((done) => {
        resolve = done;
      });
    const pending = voice.probeWake();
    await cancel(voice);
    resolve({ available: true, detected: true });
    await pending;
    assert.deepEqual(events, []);
  }
});

test("预检测失败降级完整语句唤醒；检测窗口最多三秒", async () => {
  const { voice, events, segment } = voiceFixture();
  segment();
  voice.chunks = [new Float32Array(160000)];
  voice.samples = 160000;
  const endpoints = [];
  voice.upload = async (endpoint, blob) => {
    endpoints.push(endpoint);
    if (endpoint === "wake-probe") {
      assert.equal(blob.size, 44 + 3 * 16000 * 2);
      throw new Error("旧版语音服务不存在接口");
    }
    return { detected: true, text: "李维斯，打开计算器" };
  };
  await voice.probeWake();
  assert.equal(voice.probeAvailable, false);
  assert.equal(voice.wakeEnabled, true);
  await voice.submit("wake-word");
  assert.deepEqual(events, ["wake", "打开计算器"]);
  assert.deepEqual(endpoints, ["wake-probe", "wake-word"]);
});

test("预检测最多一条请求在途，期间持续保留录音", async () => {
  const { voice, events } = voiceFixture();
  let resolve,
    count = 0;
  voice.upload = () => {
    count++;
    return new Promise((done) => {
      resolve = done;
    });
  };
  for (let i = 0; i < 20; i++) voice.capture(new Float32Array(1600).fill(0.1));
  assert.equal(count, 1);
  assert.equal(voice.samples, 32000);
  resolve({ available: true, detected: false });
  await new Promise((done) => setImmediate(done));
  assert.equal(voice.probeRequest, null);
  assert.deepEqual(events, []);
});

test("只喊名字在识别清理完成后应答一次；提前唤醒和持续对话也有应答", async () => {
  for (const variant of ["wake-word", "early", "continuous"]) {
    const { voice, events, segment } = voiceFixture();
    const replies = [];
    voice.onWakeReady = () => {
      assert.equal(voice.processing, false);
      assert.equal(voice.request, null);
      assert.equal(voice.mode, "conversation");
      replies.push("我在");
    };
    if (variant === "early") {
      voice.wakeAnnounced = true;
      voice.keepAwake();
    }
    if (variant === "continuous") {
      voice.continuousEnabled = true;
      voice.wakeEnabled = false;
      voice.mode = "conversation";
    }
    segment();
    voice.upload = async (endpoint) =>
      endpoint === "vad"
        ? { has_voice: true }
        : {
            detected: true,
            text: variant === "continuous" ? "Lewis。" : "李维斯。",
          };
    await voice.submit(variant === "continuous" ? "asr" : "wake-word");
    assert.deepEqual(replies, ["我在"]);
    assert.equal(events.filter((event) => event !== "wake").length, 0);
  }
});

test("唤醒词后带任务不会插入应答；未命中、关闭后迟到识别不会应答", async () => {
  const { voice, segment } = voiceFixture();
  let replies = 0;
  voice.onWakeReady = () => replies++;
  segment();
  voice.upload = async () => ({ detected: true, text: "李维斯，打开计算器。" });
  await voice.submit("wake-word");
  assert.equal(replies, 0);
  voice.mode = "wake";
  segment();
  voice.upload = async () => ({ detected: false, text: "路过说话" });
  await voice.submit("wake-word");
  assert.equal(replies, 0);
  segment();
  let resolve;
  voice.upload = () => new Promise((done) => (resolve = done));
  const pending = voice.submit("wake-word");
  await voice.toggleWake(false);
  resolve({ detected: true, text: "李维斯。" });
  await pending;
  assert.equal(replies, 0);
});

test("默认唤醒后持续交谈，空闲十分钟仍可说；停播不退出，结束对话才回到待命", async () => {
  const { voice, events, segment } = voiceFixture();
  let interrupts = 0;
  voice.onInterrupt = () => interrupts++;
  voice.keepAwake();
  voice.mode = "conversation";
  assert.equal(voice.awakeUntil, Infinity);
  // 超过旧的一分钟限制；无限期限仍不会触发回到 wake 的条件。
  voice.startedAt = Date.now() - 600000;
  voice.capture(new Float32Array(160));
  assert.equal(voice.mode, "conversation");
  let text = "Lewis 停下。";
  voice.upload = async (endpoint) =>
    endpoint === "vad" ? { has_voice: true } : { text };
  segment();
  await voice.submit("asr");
  assert.equal(interrupts, 1);
  assert.equal(voice.idleMode(), "conversation");
  text = "继续陪我聊聊";
  segment();
  await voice.submit("asr");
  assert.deepEqual(events, [text]);
  text = "李维斯，结束对话。";
  segment();
  await voice.submit("asr");
  assert.equal(interrupts, 2);
  assert.equal(voice.mode, "wake");
  assert.equal(voice.awakeUntil, 0);
  assert.equal(voice.wakeEnabled, true);
  assert.deepEqual(events, ["继续陪我聊聊"]);
  assert.equal(voice.isEndConversation("帮我写一段结束对话的代码"), false);
});

test("预热只加载检测器，不触发唤醒；关闭麦克风会取消预热", async () => {
  const { voice, events } = voiceFixture();
  let resolve, signal;
  voice.upload = (endpoint, blob, value) => {
    assert.equal(endpoint, "wake-probe");
    assert.equal(blob.size, 44 + 2400 * 2);
    signal = value;
    return new Promise((done) => {
      resolve = done;
    });
  };
  const pending = voice.warmWakeDetector();
  assert.ok(voice.warmRequest);
  await voice.toggleWake(false);
  assert.equal(signal.aborted, true);
  resolve({ available: true, detected: true });
  await pending;
  assert.deepEqual(events, []);
  assert.equal(voice.warmRequest, null);
  assert.equal(voice.mode, "off");
});
