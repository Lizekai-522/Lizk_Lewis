const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { SessionStore } = require("../lib/session-store");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lewis-api-"));
process.env.LEWIS_DATA_DIR = directory;
process.env.LLM_API_KEY = "";
let upstream, server, base, settings, lastModelRequest, voiceRequest;
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
const jsonPost = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
test("网页任务采用文字行动模型，小上下文仍提供点击工具并注入真实页面/播放结果", async () => {
  const backend = require("../server");
  const opened = [],
    plays = [];
  backend.setDesktopActions({
    openWebsite: async (url) => opened.push(url),
    readBrowser: async () => ({
      mode: "browser",
      title: "实际页面",
      url: opened.at(-1),
      text: "实际页面的视频内容",
      links: [
        { title: "热门视频", url: "https://www.bilibili.com/video/BVfixture/" },
      ],
      snapshotId: "actual-snapshot",
      targets: [{ ref: "e1", text: "播放", role: "button", type: "" }],
    }),
    browserAction: async (args) => {
      plays.push(args.kind);
      return { playing: true, text: "实际播放器开始播放" };
    },
  });
  try {
    const response = await jsonPost(base + "/api/chat", {
      message: "帮我打开bilibili播放一个热门视频",
      settings: {
        ...settings,
        contextWindow: 4096,
        visionEnabled: true,
        visionApiBaseUrl: settings.apiBaseUrl,
        visionApiKey: "vision-test",
        visionModelName: "qwen3-vl-plus",
      },
      image: "data:image/jpeg;base64,/9j/2Q==",
    });
    const body = await response.text();
    assert.doesNotMatch(body, /"error":/);
    assert.equal(lastModelRequest.model, "test-model");
    assert.ok(
      lastModelRequest.tools.some((tool) => tool.function.name === "web_click"),
    );
    assert.ok(
      lastModelRequest.tools.some(
        (tool) => tool.function.name === "web_play_video",
      ),
    );
    assert.match(JSON.stringify(lastModelRequest.messages), /actual-snapshot/);
    assert.equal(plays[0], "play");
    assert.equal(opened.at(-1), "https://www.bilibili.com/video/BVfixture/");
  } finally {
    backend.setDesktopActions({});
  }
});
before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.url.startsWith("/html/")) {
      res.setHeader("Content-Type", "text/html");
      res.end("<!DOCTYPE html><html>Wrong service</html>");
      return;
    }
    if (req.url.endsWith("/chat/completions")) {
      lastModelRequest = JSON.parse(body);
      if (
        lastModelRequest.messages[0].content.startsWith(
          "你是 Lewis 摄像头观察器",
        )
      ) {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    content: JSON.stringify({
                      description: "画面中的人嘴角上扬，手里拿着杯子",
                      shouldSpeak: true,
                      comment: "看到你拿起杯子了，休息一会儿？",
                    }),
                  },
                },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
        return;
      }
      if (
        lastModelRequest.messages.at(-1).content ===
        "微信给张三发消息通知今晚聚餐取消，语气客气一点"
      ) {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "send-task-1",
                        function: {
                          name: "wechat_send_message",
                          arguments: JSON.stringify({
                            recipient: "张三",
                            text: "不好意思，今晚聚餐取消，感谢理解。",
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
        return;
      }
      if (lastModelRequest.messages.at(-1).content === "工具打开网站") {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "open-1",
                        function: {
                          name: "open_website",
                          arguments: '{"url":"https://example.com/"}',
                        },
                      },
                    ],
                  },
                },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
        return;
      }
      if (lastModelRequest.messages.at(-1).content === "失败") {
        res.writeHead(401);
        res.end("secret should never be exposed");
        return;
      }
      res.setHeader("Content-Type", "text/event-stream");
      const sse = Buffer.from(
        'data: {"choices":[{"delta":{"content":"您好，主人。"}}]}\n\ndata: {"usage":{"prompt_tokens":18,"completion_tokens":6}}\n\ndata: [DONE]\n\n',
      );
      for (let i = 0; i < sse.length; i += 7) {
        res.write(sse.subarray(i, i + 7));
        await new Promise((resolve) => setImmediate(resolve));
      }
      res.end();
    } else if (req.url === "/api/tts") {
      voiceRequest = JSON.parse(body);
      res.setHeader("Content-Type", "audio/mpeg");
      res.end(Buffer.from([0x49, 0x44, 0x33]));
    } else {
      voiceRequest = { bytes: body, type: req.headers["content-type"] };
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ text: "真实转发", detected: true, success: true }),
      );
    }
  });
  await listen(upstream);
  const port = upstream.address().port;
  process.env.VOICE_SERVICE_URL = `http://127.0.0.1:${port}`;
  const backend = require("../server");
  server = await backend.start(0);
  base = `http://127.0.0.1:${server.address().port}`;
  settings = {
    apiBaseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-key",
    modelName: "test-model",
    contextWindow: 4096,
  };
});
after(async () => {
  await close(server);
  await close(upstream);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("微信自动云端分析使用已配置模型且不提供动作工具，图像未取到时不称已看到", async () => {
  const { wechatReader } = require("../server");
  const message = {
    id: "test",
    timestamp: 100,
    sender: "好友",
    type: "图片",
    text: "",
    transcript: "",
    media: { type: "image", available: true, url: "/api/v1/media/test" },
    contentStatus: "image-needs-fetch",
  };
  const result = await wechatReader.analyze(
    { contact: { name: "测试会话" }, messages: [message] },
    settings,
    {
      image: async () => {
        throw Error("图片不存在");
      },
    },
    new AbortController().signal,
  );
  assert.match(result, /您好/);
  assert.equal(lastModelRequest.model, "test-model");
  assert.equal(lastModelRequest.tools, undefined);
  assert.equal(lastModelRequest.tool_choice, undefined);
  const facts = JSON.parse(lastModelRequest.messages.at(-1).content[0].text);
  assert.equal(facts.messages[0].imageIncluded, false);
  assert.match(facts.messages[0].imageStatus, /获取失败/);
  assert.doesNotMatch(JSON.stringify(lastModelRequest), /\/api\/v1\/media/);
});

test("设置传到模型，完整回复落盘，下一轮带上历史", async () => {
  const id = (await (await jsonPost(base + "/api/session", {})).json())
    .sessionId;
  const response = await jsonPost(base + "/api/chat", {
    sessionId: id,
    message: "你好",
    settings,
  });
  const sse = await response.text();
  assert.match(sse, /您好，主人/);
  assert.match(sse, /prompt_tokens/);
  assert.ok(sse.endsWith("data: [DONE]\n\n"));
  assert.equal(lastModelRequest.model, "test-model");
  assert.match(lastModelRequest.messages[0].content, /用户已允许口语脏话/);
  assert.deepEqual(
    new SessionStore(directory).get(id).messages.map((m) => m.role),
    ["user", "assistant"],
  );
  await (
    await jsonPost(base + "/api/chat", {
      sessionId: id,
      message: "接着聊",
      settings,
    })
  ).text();
  assert.equal(lastModelRequest.messages.length, 4);
  assert.equal(lastModelRequest.messages[2].content, "您好，主人。");
  const history = await (await fetch(`${base}/api/history/${id}`)).json();
  assert.equal(history.messages.length, 4);
});

test("当前网页 DOM 与截图分析接口使用桌面会话，截图仅发视觉模型且不写历史", async () => {
  const backend = require("../server");
  const reads = [];
  const image =
    "data:image/jpeg;base64," +
    Buffer.from([255, 216, 255, 217]).toString("base64");
  backend.setDesktopActions({
    readBrowser: async (options) => {
      reads.push(options);
      return {
        title: "会员统计页",
        url: "https://example.com/account",
        source: "https://example.com/account",
        text: "动态渲染的统计图",
        ...(options.screenshot ? { image, capture: "viewport" } : {}),
        mode: "browser",
      };
    },
  });
  try {
    const read = await jsonPost(base + "/api/web/read", { mode: "current" });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).text, "动态渲染的统计图");
    assert.equal(reads[0].url, undefined);
    const visual = {
      ...settings,
      contextWindow: 16384,
      visionApiBaseUrl: settings.apiBaseUrl,
      visionApiKey: "vision-key",
      visionModelName: "qwen3-vl-plus",
    };
    const result = await (
      await jsonPost(base + "/api/web/analyze", {
        question: "图里的趋势如何？",
        settings: visual,
      })
    ).json();
    assert.equal(result.model, "qwen3-vl-plus");
    assert.equal(result.image, undefined);
    assert.equal(reads[1].screenshot, true);
    assert.equal(lastModelRequest.model, "qwen3-vl-plus");
    assert.equal(lastModelRequest.tools, undefined);
    assert.equal(
      lastModelRequest.messages.at(-1).content[1].image_url.url,
      image,
    );
    assert.match(lastModelRequest.messages.at(-1).content[0].text, /趋势/);
    const beforeMissing = reads.length;
    assert.equal(
      (await jsonPost(base + "/api/web/analyze", { settings: {} })).ok,
      false,
    );
    assert.equal(reads.length, beforeMissing);
  } finally {
    backend.setDesktopActions({});
  }
});
test("失败的模型请求不写入孤立 user 消息，也不泄露上游内容", async () => {
  const id = (await (await jsonPost(base + "/api/session", {})).json())
    .sessionId;
  const response = await jsonPost(base + "/api/chat", {
    sessionId: id,
    message: "失败",
    settings,
  });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret/);
  assert.equal(new SessionStore(directory).get(id).messages.length, 0);
});

test("缺失、中文和其他无效 Key 返回 400，不调用模型或写入历史", async () => {
  const id = (await (await jsonPost(base + "/api/session", {})).json())
    .sessionId;
  const previousRequest = lastModelRequest;
  for (const apiKey of [
    "",
    "sk-你的APIKey",
    "secret-中文",
    "key\nInjected",
    123,
  ]) {
    const response = await jsonPost(base + "/api/chat", {
      sessionId: id,
      message: "测试配置",
      settings: { ...settings, apiKey },
    });
    assert.equal(response.status, 400);
    const data = await response.json();
    assert.match(data.error, /API Key/);
    assert.doesNotMatch(data.error, /ByteString|secret|Injected/);
    assert.strictEqual(lastModelRequest, previousRequest);
  }
  assert.equal(new SessionStore(directory).get(id).messages.length, 0);
});
test("ASR/VAD/唤醒的 multipart 音频和 boundary 原样代理", async () => {
  for (const endpoint of ["asr", "vad", "wake-word", "wake-probe"]) {
    const form = new FormData();
    form.append(
      "audio",
      new Blob(["RIFFtest"], { type: "audio/wav" }),
      "sample.wav",
    );
    const response = await fetch(`${base}/api/${endpoint}`, {
      method: "POST",
      body: form,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).text, "真实转发");
    assert.match(voiceRequest.type, /multipart\/form-data; boundary=/);
    assert.match(voiceRequest.bytes.toString(), /name="audio"/);
    assert.match(voiceRequest.bytes.toString(), /RIFFtest/);
  }
});
test("TTS 使用 JSON 请求并返回 MP3，缺少录音返回 400", async () => {
  const response = await jsonPost(base + "/api/tts", {
    text: "主人您好",
    voice: "zh-CN-XiaoyiNeural",
    rate: "+6%",
    pitch: "-2Hz",
  });
  assert.match(response.headers.get("content-type"), /audio\/mpeg/);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "ID3");
  assert.equal(voiceRequest.text, "主人您好");
  assert.equal(voiceRequest.rate, "+6%");
  assert.equal(voiceRequest.pitch, "-2Hz");
  assert.equal(voiceRequest.voice, "zh-CN-XiaoyiNeural");
  assert.equal((await jsonPost(base + "/api/asr", {})).status, 400);
});
test("外部网页不能调用电脑技能", async () => {
  const response = await fetch(base + "/api/skills", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ skill: "open-app", app: "notepad" }),
  });
  assert.equal(response.status, 403);
});
test("技能参数严格校验，拒绝任意程序和超范围音量", async () => {
  assert.equal(
    (
      await jsonPost(base + "/api/skills", {
        skill: "open-app",
        app: "cmd.exe",
      })
    ).status,
    400,
  );
  assert.equal(
    (await jsonPost(base + "/api/skills", { skill: "volume", value: 101 }))
      .status,
    400,
  );
});
test("未知 API 始终返回 JSON，语音地址返回 HTML 时提供明确诊断", async () => {
  const unknown = await fetch(base + "/api/does-not-exist");
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get("content-type"), /application\/json/);
  assert.match((await unknown.json()).error, /接口不存在/);
  const form = new FormData();
  form.append("audio", new Blob(["RIFFtest"]), "test.wav");
  const response = await fetch(base + "/api/asr", {
    method: "POST",
    headers: {
      "X-Voice-Service": `http://127.0.0.1:${upstream.address().port}/html`,
    },
    body: form,
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /HTML 页面/);
});

test("视觉对话使用独立视觉模型和当前画面，历史不保存图像", async () => {
  const id = (await (await jsonPost(base + "/api/session", {})).json())
    .sessionId;
  const image = "data:image/jpeg;base64,/9j/2Q==";
  const visual = {
    ...settings,
    apiKey: "",
    visionEnabled: true,
    visionApiBaseUrl: settings.apiBaseUrl,
    visionApiKey: "vision-test-key",
    visionModelName: "qwen3-vl-plus",
    contextWindow: 16384,
  };
  const response = await jsonPost(base + "/api/chat", {
    sessionId: id,
    message: "我拿着什么",
    settings: visual,
    image,
  });
  const result = await response.text();
  assert.match(result, /"attached":true/);
  assert.equal(lastModelRequest.model, "qwen3-vl-plus");
  assert.equal(
    lastModelRequest.messages.at(-1).content[1].image_url.url,
    image,
  );
  const history = new SessionStore(directory).get(id).messages;
  assert.equal(history[0].content, "我拿着什么");
  assert.doesNotMatch(JSON.stringify(history), /data:image/);
  assert.equal(
    (
      await jsonPost(base + "/api/chat", {
        message: "test",
        settings: { ...visual, visionEnabled: false },
        image,
      })
    ).status,
    400,
  );
});

test("模型电脑工具经后端执行，关闭权限后拒绝并持久化", async () => {
  const backend = require("../server");
  const opened = [];
  backend.setDesktopActions({ openWebsite: async (url) => opened.push(url) });
  try {
    const response = await jsonPost(base + "/api/chat", {
      message: "工具打开网站",
      settings: { ...settings, contextWindow: 16384 },
    });
    assert.match(await response.text(), /"state":"done"/);
    assert.deepEqual(opened, ["https://example.com/"]);
    const saved = await jsonPost(base + "/api/capabilities", {
      web: false,
      computer: false,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(
      new (require("../lib/capabilities").Capabilities)(directory).value,
      { web: false, computer: false, wechat: true },
    );
    assert.equal(
      (
        await jsonPost(base + "/api/skills", {
          skill: "open-website",
          url: "https://example.com/",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await jsonPost(base + "/api/skills", {
          skill: "web-search",
          query: "test",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await jsonPost(base + "/api/capabilities", {
          web: "yes",
          computer: true,
        })
      ).status,
      400,
    );
    assert.equal(opened.length, 1);
  } finally {
    await jsonPost(base + "/api/capabilities", { web: true, computer: true });
    backend.setDesktopActions({});
  }
});

test("微信 API 保留独立权限、核对用户对象与全文，重复请求不重复代发", async () => {
  const backend = require("../server");
  const { WeChatService } = require("../lib/wechat");
  let calls = 0;
  backend.setDesktopActions({
    wechat: new WeChatService(async (request) => {
      calls++;
      return {
        ok: true,
        text: "测试微信发送",
        recipient: request.recipient,
        sent: true,
      };
    }),
  });
  const request = {
    skill: "wechat-send",
    recipient: "文件传输助手",
    text: "你好",
    userMessage: "微信给文件传输助手发消息说你好",
    operationId: require("node:crypto").randomUUID(),
  };
  try {
    assert.equal((await jsonPost(base + "/api/skills", request)).status, 200);
    assert.equal((await jsonPost(base + "/api/skills", request)).status, 200);
    assert.equal(calls, 1);
    assert.equal(
      (await jsonPost(base + "/api/skills", { ...request, recipient: "李四" }))
        .status,
      400,
    );
    assert.equal(calls, 1);
    await jsonPost(base + "/api/capabilities", {
      web: true,
      computer: true,
      wechat: false,
    });
    assert.equal((await jsonPost(base + "/api/skills", request)).status, 400);
    assert.equal(calls, 1);
    assert.equal(
      new (require("../lib/capabilities").Capabilities)(directory).value.wechat,
      false,
    );
  } finally {
    await jsonPost(base + "/api/capabilities", {
      web: true,
      computer: true,
      wechat: true,
    });
    backend.setDesktopActions({});
  }
});

test("聊天接口直接执行口语微信，不依赖模型或 Key；API 重试共用原文去重", async () => {
  const backend = require("../server");
  const { WeChatService } = require("../lib/wechat");
  const received = [];
  backend.setDesktopActions({
    wechat: new WeChatService(async (request) => {
      received.push(request);
      return { ok: true, text: "测试微信发送", sent: true };
    }),
  });
  const operationId = require("node:crypto").randomUUID();
  const userMessage = "请用微信给文件传输助手发消息Hello World，十分钟后到。";
  try {
    const previousModelRequest = lastModelRequest;
    const response = await jsonPost(base + "/api/chat", {
      message: userMessage,
      operationId,
      settings: { ...settings, apiKey: "", autoTools: false },
    });
    assert.equal(response.status, 200);
    const sse = await response.text();
    assert.match(sse, /"state":"done"/);
    assert.doesNotMatch(sse, /"state":"error"/);
    assert.strictEqual(lastModelRequest, previousModelRequest);
    assert.deepEqual(received, [
      {
        action: "send",
        recipient: "文件传输助手",
        text: "Hello World，十分钟后到。",
      },
    ]);
    const retry = await jsonPost(base + "/api/skills", {
      skill: "wechat-send",
      recipient: "文件传输助手",
      text: "Hello World十分钟后到！",
      userMessage,
      operationId,
    });
    assert.equal(retry.status, 200);
    assert.equal(received.length, 1);
  } finally {
    backend.setDesktopActions({});
  }
});

test("微信发送组件没有明确确认或报错时，聊天接口不输出已完成，也不保存成功历史", async () => {
  const backend = require("../server");
  const id = (await (await jsonPost(base + "/api/session", {})).json())
    .sessionId;
  try {
    for (const fake of [
      async () => ({ ok: true, text: "已经发出" }),
      async () => {
        throw new Error("发送按钮未启用，文字留在输入框");
      },
    ]) {
      backend.setDesktopActions({ wechat: { execute: fake } });
      const response = await jsonPost(base + "/api/chat", {
        sessionId: id,
        message: "微信给文件传输助手发消息，说我是李维斯。",
        settings: { apiKey: "" },
      });
      const sse = await response.text();
      assert.match(sse, /"error":/);
      assert.doesNotMatch(sse, /"state":"done"|"content":"已经发出"/);
      assert.equal(new SessionStore(directory).get(id).messages.length, 0);
    }
  } finally {
    backend.setDesktopActions({});
  }
});

test("明确打开指定网站直接执行且无需模型 Key，不按网站名称拒绝", async () => {
  const backend = require("../server");
  const opened = [];
  const previousModel = lastModelRequest;
  backend.setDesktopActions({ openWebsite: async (url) => opened.push(url) });
  try {
    for (const message of [
      "Lewis，帮我打开Pornhub",
      "打开网站 example.com",
      "我想看pornhub",
      "打开pornhub给我看",
    ]) {
      const response = await jsonPost(base + "/api/chat", {
        message,
        settings: { apiKey: "", autoTools: false },
      });
      const sse = await response.text();
      assert.match(sse, /"state":"done"/);
      assert.match(sse, /"result":/);
    }
    assert.deepEqual(opened, [
      "https://www.pornhub.com/",
      "https://example.com/",
      "https://www.pornhub.com/",
      "https://www.pornhub.com/",
    ]);
    assert.strictEqual(lastModelRequest, previousModel);
  } finally {
    backend.setDesktopActions({});
  }
});

test("持续摄像头分析使用真正附图的视觉模型且无电脑工具，不保存照片或聊天历史", async () => {
  const visual = {
    ...settings,
    visionEnabled: true,
    visionApiBaseUrl: settings.apiBaseUrl,
    visionApiKey: "vision-fixture",
    visionModelName: "qwen3-vl-plus",
    contextWindow: 16384,
  };
  const image = "data:image/jpeg;base64,/9j/2Q==";
  const result = await jsonPost(base + "/api/vision/observe", {
    settings: visual,
    image,
    previous: "没有人",
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).shouldSpeak, true);
  assert.equal(lastModelRequest.model, "qwen3-vl-plus");
  assert.equal(
    lastModelRequest.messages.at(-1).content[1].image_url.url,
    image,
  );
  assert.equal(lastModelRequest.tools, undefined);
  assert.equal(lastModelRequest.tool_choice, undefined);
  assert.equal(
    (
      await jsonPost(base + "/api/vision/observe", {
        settings: { ...visual, visionEnabled: false },
        image,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await jsonPost(base + "/api/vision/observe", {
        settings: visual,
        image: "data:image/jpeg;base64,AAAA",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await jsonPost(base + "/api/vision/observe", {
        settings: { ...visual, visionApiKey: "" },
        image,
      })
    ).status,
    400,
  );
});

test("文字对话不会误选视觉模型，主模型是 Qwen3-VL 时附图可复用主配置", async () => {
  const image = "data:image/jpeg;base64,/9j/2Q==";
  const visual = {
    ...settings,
    contextWindow: 16384,
    visionEnabled: true,
    visionApiBaseUrl: settings.apiBaseUrl,
    visionApiKey: "visual",
    visionModelName: "qwen3-vl-plus",
  };
  await (
    await jsonPost(base + "/api/chat", {
      message: "普通文字",
      settings: visual,
    })
  ).text();
  assert.equal(lastModelRequest.model, "test-model");
  await (
    await jsonPost(base + "/api/chat", {
      message: "你看到我了吗",
      image,
      settings: {
        ...settings,
        contextWindow: 16384,
        visionEnabled: true,
        modelName: "qwen3-vl-plus",
      },
    })
  ).text();
  assert.equal(lastModelRequest.model, "qwen3-vl-plus");
  assert.match(
    lastModelRequest.messages[0].content,
    /本轮已附用户图片或当前摄像头照片/,
  );
});

test("微信任务经模型整理后实际调用发送，失败或只口头回答不能写成功历史", async () => {
  const backend = require("../server");
  const { WeChatService } = require("../lib/wechat");
  const received = [];
  const request = {
    message: "微信给张三发消息通知今晚聚餐取消，语气客气一点",
    settings: { ...settings, contextWindow: 16384, autoTools: false },
  };
  try {
    backend.setDesktopActions({
      wechat: new WeChatService(async (item) => {
        received.push(item);
        return { sent: true, text: "已发送微信" };
      }),
    });
    const response = await jsonPost(base + "/api/chat", request);
    assert.match(await response.text(), /"state":"done"/);
    assert.equal(received.length, 1);
    assert.equal(received[0].text, "不好意思，今晚聚餐取消，感谢理解。");
    const id = (await (await jsonPost(base + "/api/session", {})).json())
      .sessionId;
    backend.setDesktopActions({
      wechat: {
        execute: async () => {
          throw Error("微信未打开指定好友");
        },
      },
    });
    const failure = await jsonPost(base + "/api/chat", {
      ...request,
      sessionId: id,
    });
    assert.match(await failure.text(), /微信未打开指定好友/);
    assert.equal(new SessionStore(directory).get(id).messages.length, 0);
    const onlyTalk = await jsonPost(base + "/api/chat", {
      ...request,
      sessionId: id,
      message: "微信给张三发消息通知明天会议取消",
    });
    assert.match(await onlyTalk.text(), /没有实际调用微信发送工具/);
    assert.equal(new SessionStore(directory).get(id).messages.length, 0);
  } finally {
    backend.setDesktopActions({});
  }
});

test("手动图片附件可独立于摄像头开关走视觉模型，拒绝伪图和超额图片", async () => {
  const image =
    "data:image/jpeg;base64," +
    Buffer.from([255, 216, 255, 217]).toString("base64");
  const visual = {
    ...settings,
    contextWindow: 16384,
    visionEnabled: false,
    visionApiBaseUrl: settings.apiBaseUrl,
    visionApiKey: "vision-key",
    visionModelName: "qwen3-vl-plus",
  };
  const response = await jsonPost(base + "/api/chat", {
    message: "比较图片",
    settings: visual,
    images: [image, image],
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(lastModelRequest.model, "qwen3-vl-plus");
  assert.equal(lastModelRequest.messages.at(-1).content.length, 3);
  for (const images of [
    [image, image, image, image],
    ["data:image/jpeg;base64,aGVsbG8="],
  ])
    assert.equal(
      (
        await jsonPost(base + "/api/chat", {
          message: "图片",
          settings: visual,
          images,
        })
      ).status,
      400,
    );
});

test("上传图片后的追问保留近期图片，不把历史照片当作当前摄像头", async () => {
  const id = (await (await jsonPost(base + "/api/session", {})).json())
    .sessionId;
  const visual = {
    ...settings,
    contextWindow: 16384,
    visionEnabled: false,
    visionApiBaseUrl: settings.apiBaseUrl,
    visionApiKey: "vision-test",
    visionModelName: "qwen3-vl-plus",
  };
  const image = "data:image/jpeg;base64,/9j/2Q==";
  await (
    await jsonPost(base + "/api/chat", {
      sessionId: id,
      message: "描述这张图",
      images: [image],
      settings: visual,
    })
  ).text();
  const response = await jsonPost(base + "/api/chat", {
    sessionId: id,
    message: "图左边是什么",
    settings: visual,
  });
  const events = await response.text();
  assert.match(events, /'history'|"history"/);
  assert.equal(lastModelRequest.model, "qwen3-vl-plus");
  const previous = lastModelRequest.messages.find((message) =>
    Array.isArray(message.content),
  );
  assert.ok(previous.content.some((part) => part.type === "image_url"));
  assert.match(previous.content[0].text, /历史上传/);
  assert.equal(lastModelRequest.messages.at(-1).content, "图左边是什么");
});

test("直接网页技能请求断开会取消后端读取，不继续挂起", async () => {
  const backend = require("../server");
  let ready, aborted;
  const started = new Promise((resolve) => (ready = resolve)),
    stopped = new Promise((resolve) => (aborted = resolve));
  backend.setDesktopActions({
    readBrowser: ({ signal }) =>
      new Promise((_resolve, reject) => {
        ready();
        signal.addEventListener(
          "abort",
          () => {
            aborted();
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });
  const controller = new AbortController();
  try {
    const request = fetch(base + "/api/skills", {
      signal: controller.signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill: "read-current-page" }),
    });
    await started;
    controller.abort();
    await assert.rejects(request, { name: "AbortError" });
    await Promise.race([
      stopped,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error("读取没有取消")), 1000);
        timer.unref();
      }),
    ]);
  } finally {
    backend.setDesktopActions({});
  }
});
