/* 持续摄像头观察：云端只分析画面；搭话由本地忙碌、手势及间隔控制。 */
(function () {
  "use strict";
  function createObserver({
    getSettings,
    getVision,
    isBusy,
    request,
    say,
    status,
    now = Date.now,
  }) {
    let controller,
      running = false,
      previous = "",
      lastSpoken = -Infinity,
      quietUntil = 0,
      retryAfter = 0,
      generation = 0;
    function suspend() {
      generation++;
      controller?.abort();
      previous = "";
      retryAfter = 0;
    }
    function quiet() {
      quietUntil = now() + 60000;
      generation++;
      controller?.abort();
    }
    async function tick() {
      const settings = getSettings(),
        vision = getVision();
      if (!settings.visionEnabled || !vision?.isActive()) {
        suspend();
        status(
          settings.visionEnabled
            ? "摄像头未开启 · 持续观察暂停"
            : "视觉理解已关闭",
        );
        return;
      }
      const config = window.lewisVisionSettings(settings);
      if (!config.baseUrl || !config.apiKey) {
        suspend();
        status(
          "本地摄像头在线 · AI 尚未看到画面：请在设置填写视觉 API 地址和百炼 Key",
        );
        return;
      }
      if (running || isBusy() || now() < retryAfter) return;
      const current = generation;
      running = true;
      controller = new AbortController();
      try {
        const image = vision.capture
          ? await vision.capture()
          : vision.snapshot();
        if (!image || current !== generation) return;
        const result = await request(
          { settings, image, previous },
          controller.signal,
        );
        if (
          current !== generation ||
          !getSettings().visionEnabled ||
          !getVision()?.isActive()
        )
          return;
        status(
          "持续观察已连接 · " +
            result.model +
            " · " +
            new Date(now()).toLocaleTimeString() +
            " 已分析画面",
        );
        const changed = result.description.trim() !== previous.trim();
        previous = result.description;
        if (
          result.shouldSpeak &&
          changed &&
          result.comment &&
          now() >= quietUntil &&
          now() - lastSpoken >= 60000 &&
          !isBusy()
        ) {
          if (await say(result.comment)) lastSpoken = now();
        }
      } catch (error) {
        if (current !== generation || error.name === "AbortError") return;
        retryAfter = now() + 60000;
        status("AI 画面分析失败：" + error.message + "；一分钟后重试");
      } finally {
        running = false;
        controller = null;
      }
    }
    return { tick, suspend, quiet };
  }
  document.addEventListener("DOMContentLoaded", () => {
    const observer = createObserver({
      getSettings: () => window.lewisGetSettings?.() || {},
      getVision: () => window.lewisVision,
      isBusy: () => window.lewisIsBusy?.() ?? true,
      status: (text) => {
        document.getElementById("cameraAIStatus").textContent = text;
        if (!window.lewisIsBusy?.())
          document.getElementById("visionChatStatus").textContent = text;
      },
      say: (text) => window.lewisProactiveSay?.(text),
      request: async (body, signal) => {
        const response = await fetch("/api/vision/observe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        });
        const data = await window.readJSONResponse(response, "持续视觉分析");
        if (!response.ok) throw new Error(data.error || "视觉服务失败");
        return data;
      },
    });
    const timer = setInterval(() => void observer.tick(), 10000);
    window.addEventListener("lewis-camera-state", () => {
      observer.suspend();
      void observer.tick();
    });
    window.addEventListener("lewis-settings-changed", () => {
      observer.suspend();
      void observer.tick();
    });
    window.addEventListener("lewis-gesture", (event) => {
      if (
        event.detail?.action
          ? ["stop-speech", "hide-pet"].includes(event.detail.action)
          : ["Open_Palm", "Closed_Fist"].includes(event.detail?.gesture)
      )
        observer.quiet();
    });
    document
      .getElementById("stopSpeechBtn")
      .addEventListener("click", () => observer.quiet());
    window.addEventListener(
      "pagehide",
      () => {
        clearInterval(timer);
        observer.suspend();
      },
      { once: true },
    );
    window.lewisVisionObserver = observer;
  });
  window.createLewisVisionObserver = createObserver;
})();
