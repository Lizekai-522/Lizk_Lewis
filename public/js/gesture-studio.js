/* Two-stage, local-only capture; saved templates are shared with the Lewis window. */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id),
    core = window.lewisCustomGestures,
    key = "lewis_custom_gestures_v1";
  let stream,
    worker,
    ready = false,
    flight = false,
    loop,
    recording = false,
    frames = [],
    draft,
    attempt = 0,
    editId = new URL(location.href).searchParams.get("id");
  const read = () => {
    try {
      return core.sanitize(JSON.parse(localStorage.getItem(key) || "[]"));
    } catch {
      return [];
    }
  };
  let existing = read().find((t) => t.id === editId);
  const status = (text) => ($("studioStatus").textContent = text);
  try {
    document.documentElement.dataset.theme =
      window.lewisAppearance.resolveTheme(
        JSON.parse(localStorage.getItem("lewis_settings") || "{}"),
      );
  } catch {
    document.documentElement.dataset.theme = "tech";
  }
  if (window.electronAPI) {
    document.body.classList.add("desktop");
    document.querySelector(".desktop-titlebar").hidden = false;
    window.electronAPI.setAppearance?.(document.documentElement.dataset.theme);
  }
  function configure() {
    $("captureStage").hidden = true;
    $("configureStage").hidden = false;
    $("stepCapture").removeAttribute("aria-current");
    $("stepConfigure").setAttribute("aria-current", "step");
    $("studioCaptureSummary").textContent =
      `已采集 ${draft.frames.length} 帧 · ${draft.mode === "pose" ? "静态手形" : "短动作"}。保存后立即应用。`;
    $("studioName").value = existing?.name || "";
    $("studioAction").value = existing?.action || "command";
    $("studioCommand").value = existing?.command || "";
    actionChanged();
    $("studioName").focus();
  }
  function actionChanged() {
    const command = $("studioAction").value === "command";
    $("studioCommandLabel").hidden = !command;
    $("studioCommand").required = command;
  }
  $("studioAction").onchange = actionChanged;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function draw(hand) {
    const c = $("studioOverlay"),
      v = $("studioVideo");
    c.width = v.videoWidth || 640;
    c.height = v.videoHeight || 480;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    if (!hand) return;
    ctx.fillStyle = "#91e3b3";
    for (const p of hand) {
      ctx.beginPath();
      ctx.arc(p.x * c.width, p.y * c.height, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  async function prepare() {
    if (ready) return;
    if (worker) throw Error("模型正在准备，请稍候");
    status("正在开启摄像头并加载本机手势模型…");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });
      $("studioVideo").srcObject = stream;
      await $("studioVideo").play();
      worker = new Worker("/js/vision-worker.js");
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error("模型加载较慢，请重试")),
          60000,
        );
        worker.onerror = () => {
          clearTimeout(timeout);
          reject(Error("手势模型未能启动"));
        };
        worker.onmessage = ({ data }) => {
          if (data.type === "ready") {
            clearTimeout(timeout);
            ready = true;
            resolve();
          } else if (data.type === "error") {
            clearTimeout(timeout);
            reject(Error("手势模型未能启动"));
          }
        };
        worker.postMessage({ type: "init", delegate: "CPU", confidence: 0.3 });
      });
      worker.onmessage = ({ data }) => {
        flight = false;
        if (data.type !== "result") return;
        const hand =
          data.result.landmarks?.length === 1 ? data.result.landmarks[0] : null;
        draw(hand);
        $("studioCameraStatus").textContent = hand
          ? "已检测到一只手"
          : "请把一只完整的手放入画面";
        if (recording) {
          const frame = hand ? core.frame(hand) : null;
          if (frame && frames.length < 40) frames.push(frame);
          status("录制中 · " + frames.length + " 帧");
        }
      };
      loop = setInterval(async () => {
        if (!ready || flight || $("studioVideo").readyState < 2) return;
        flight = true;
        try {
          const bitmap = await createImageBitmap($("studioVideo"));
          if (!worker) {
            bitmap.close();
            flight = false;
            return;
          }
          worker.postMessage(
            { type: "frame", bitmap, timestamp: performance.now() },
            [bitmap],
          );
        } catch {
          flight = false;
        }
      }, 100);
      $("studioRecord").disabled = false;
      $("studioPrepare").disabled = true;
      status("摄像头已就绪。点击开始录制。");
    } catch (error) {
      cleanup();
      status(
        error.name === "NotAllowedError"
          ? "请允许摄像头访问后重试"
          : "摄像头或手势模型未准备好，请关闭其他占用摄像头的软件后重试",
      );
      throw error;
    }
  }
  function cleanup() {
    clearInterval(loop);
    worker?.terminate();
    worker = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    ready = false;
    flight = false;
  }
  function cancel() {
    attempt++;
    recording = false;
    frames = [];
    $("studioCountdown").hidden = true;
    $("studioCancel").hidden = true;
    $("studioRecord").disabled = !ready;
    status("录制已取消");
  }
  $("studioPrepare").onclick = () => prepare().catch(() => {});
  $("studioRecord").onclick = async () => {
    const current = ++attempt;
    frames = [];
    $("studioRecord").disabled = true;
    $("studioCancel").hidden = false;
    $("studioCountdown").hidden = false;
    for (let n = 3; n > 0; n--) {
      $("studioCountdown").textContent = n;
      await pause(1000);
      if (current !== attempt) return;
    }
    $("studioCountdown").hidden = true;
    recording = true;
    status("录制中，保持手形或完整做一次动作");
    await pause(3000);
    if (current !== attempt) return;
    recording = false;
    $("studioCancel").hidden = true;
    $("studioRecord").disabled = false;
    if (frames.length < 12) {
      status("采集不足，请保持整只手在画面里，再录一次");
      return;
    }
    const mode = $("studioMode").value;
    if (
      mode === "motion" &&
      Math.max(
        ...frames.map((f) =>
          Math.hypot(
            f.position[0] - frames[0].position[0],
            f.position[1] - frames[0].position[1],
          ),
        ),
      ) < 0.04
    ) {
      status("短动作需要移动手腕；保持手形请选择静态模式");
      return;
    }
    draft = { mode, frames: [...frames] };
    const preview = document.createElement("canvas");
    preview.width = $("studioVideo").videoWidth;
    preview.height = $("studioVideo").videoHeight;
    preview.getContext("2d").drawImage($("studioVideo"), 0, 0);
    $("studioVideo").poster = preview.toDataURL("image/jpeg", 0.7);
    $("studioVideo").srcObject = null;
    cleanup();
    configure();
    status("录制成功。现在填写名称和动作。");
  };
  $("studioCancel").onclick = cancel;
  $("studioAgain").onclick = () => {
    cancel();
    draft = null;
    $("captureStage").hidden = false;
    $("configureStage").hidden = true;
    $("studioPrepare").disabled = false;
    $("studioRecord").disabled = true;
    $("stepConfigure").removeAttribute("aria-current");
    $("stepCapture").setAttribute("aria-current", "step");
  };
  $("configureStage").onsubmit = (event) => {
    event.preventDefault();
    if (!draft) return;
    const name = $("studioName").value.trim(),
      action = $("studioAction").value,
      command = $("studioCommand").value.trim();
    if (!name || (action === "command" && !command)) {
      status("请填写手势名称和任务指令");
      return;
    }
    const latest = read();
    if (!editId && latest.length >= 16) {
      status("最多保存16个手势，请先删除一个");
      return;
    }
    const item = core.sanitize([
      {
        id: editId || "g_" + crypto.randomUUID().slice(0, 12),
        name,
        action,
        command,
        enabled: existing?.enabled ?? true,
        ...draft,
      },
    ])[0];
    if (!item) {
      status("录制数据无效，请重新录制");
      return;
    }
    const conflict = core.match(
      item.frames,
      latest.filter((t) => t.id !== item.id && t.mode === item.mode),
    );
    if (conflict) {
      status("这个手势与“" + conflict.name + "”相似，请录制区别更明显的手势");
      return;
    }
    try {
      localStorage.setItem(
        key,
        JSON.stringify([...latest.filter((t) => t.id !== item.id), item]),
      );
      editId = item.id;
      existing = item;
      $("studioApply").textContent = "已保存 · 再次应用";
      status("“" + name + "”已保存并应用，返回 Lewis 后先放下手，再试一次。");
    } catch {
      status("未能保存，请检查本机存储空间");
    }
  };
  $("studioClose").onclick = () => {
    cleanup();
    if (window.electronAPI?.closeGestureStudio)
      window.electronAPI.closeGestureStudio();
    else window.close();
  };
  window.addEventListener("pagehide", () => {
    attempt++;
    cleanup();
  });
  if (existing) {
    draft = { mode: existing.mode, frames: existing.frames };
    $("studioMode").value = existing.mode;
    configure();
  }
})();
