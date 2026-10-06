// 摄像头先显示；推理在 Worker 进行，避免卡住录音和聊天界面。
let stream,
  worker,
  timer,
  loadTimer,
  loading,
  cameraPending,
  generation = 0,
  inFlight = false,
  lastVideoTime = -1;
let inferenceReady = false;
const panel = document.getElementById("visionPanel");
const video = document.getElementById("cameraPreview");
const overlay = document.getElementById("handOverlay");
const label = document.getElementById("gestureStatus");
const gate = new window.lewisGestures.GestureGate();
const edges = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];
function showResult(result) {
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const detected = result.landmarks?.length || 0;
  const custom = window.lewisGestureRecorder?.observe(result);
  const { gesture, score, source } = custom?.suppress
    ? { gesture: "", source: "" }
    : custom || window.lewisGestures.selectGesture(result);
  for (let i = 0; i < detected; i++) {
    const hand = result.landmarks[i];
    ctx.strokeStyle = "#00e5ff";
    ctx.lineWidth = 2;
    for (const [a, b] of edges) {
      ctx.beginPath();
      ctx.moveTo(hand[a].x * overlay.width, hand[a].y * overlay.height);
      ctx.lineTo(hand[b].x * overlay.width, hand[b].y * overlay.height);
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    for (const p of hand) {
      ctx.beginPath();
      ctx.arc(p.x * overlay.width, p.y * overlay.height, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const names = {
    Open_Palm: "张开手掌",
    Closed_Fist: "握拳",
    Pointing_Up: "食指朝上",
    Thumb_Down: "拇指朝下",
    Thumb_Up: "竖拇指",
    Victory: "胜利手势",
    ILoveYou: "爱心手势",
  };
  label.textContent = detected
    ? `检测到 ${detected} 只手 · ${custom?.name || names[gesture] || "请展示已录制的手势"}${gesture ? (source === "model" ? ` · 模型置信度 ${Math.round(score * 100)}%` : source === "recorded" ? " · 自定义录制" : " · 关键点辅助判定") : ""} · 请保持半秒`
    : "摄像头在线 · 未检测到手，请把整只手放入画面，距离约 30–80 厘米。";
  const action = gate.update(gesture, performance.now());
  if (action) {
    const command = window.lewisGestureActions?.run(action);
    window.dispatchEvent(
      new CustomEvent("lewis-gesture", {
        detail: { gesture: action, action: command },
      }),
    );
  }
}
function start() {
  if (cameraPending) return cameraPending;
  if (
    stream &&
    (stream.getVideoTracks?.() || []).some(
      (track) => track.readyState === "ended",
    )
  )
    stop();
  if (stream) {
    panel.hidden = false;
    return Promise.resolve();
  }
  const pending = openCamera();
  cameraPending = pending;
  return pending.finally(() => {
    if (cameraPending === pending) cameraPending = null;
  });
}
async function openCamera() {
  const current = ++generation;
  loading = true;
  panel.hidden = false;
  label.textContent = "正在开启摄像头…";
  try {
    const opened = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    if (generation !== current) {
      opened.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = opened;
    for (const track of opened.getVideoTracks?.() || [])
      track.addEventListener?.(
        "ended",
        () => {
          if (generation !== current) return;
          stop();
          panel.hidden = false;
          label.textContent = "摄像头连接已结束，请重新开启摄像头。";
        },
        { once: true },
      );
    video.srcObject = stream;
    await video.play();
    if (generation !== current) return;
    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 480;
    label.textContent = "摄像头已开启，正在加载本地手势模型…";
    // MediaPipe 的 WASM loader 需要经典 Worker 的 importScripts 全局作用域。
    const localWorker = new Worker("/js/vision-worker.js");
    worker = localWorker;
    loadTimer = setTimeout(() => {
      if (generation === current && !inferenceReady) {
        localWorker.terminate();
        label.textContent =
          "摄像头在线，但手势模型加载超时；请关闭摄像头后重试。";
      }
    }, 45000);
    localWorker.onerror = (event) => {
      if (generation !== current) return;
      clearTimeout(loadTimer);
      inferenceReady = false;
      inFlight = false;
      localWorker.terminate();
      console.error("手势模块加载", event.message);
      label.textContent = "摄像头在线，手势模块未能加载；请改用CPU并重启手势。";
    };
    localWorker.onmessage = ({ data }) => {
      if (generation !== current) return;
      if (data.type === "ready") {
        clearTimeout(loadTimer);
        inferenceReady = true;
        label.textContent = `手势模型就绪（${data.delegate}），请展示手掌或握拳并保持半秒。`;
      }
      if (data.type === "result") {
        inFlight = false;
        showResult(data.result);
      }
      if (data.type === "error") {
        clearTimeout(loadTimer);
        inFlight = false;
        inferenceReady = false;
        localWorker.terminate();
        console.error("手势识别", data.error);
        label.textContent =
          "摄像头在线，手势识别暂时停止；请改用CPU并重启手势。";
      }
    };
    localWorker.postMessage({
      type: "init",
      delegate: document.getElementById("gestureDelegate").value,
      confidence: Number(document.getElementById("gestureConfidence").value),
    });
    gate.reset();
    lastVideoTime = -1;
    timer = setInterval(async () => {
      if (
        !inferenceReady ||
        inFlight ||
        video.readyState < 2 ||
        video.currentTime === lastVideoTime
      )
        return;
      inFlight = true;
      lastVideoTime = video.currentTime;
      try {
        const bitmap = await createImageBitmap(video);
        if (generation !== current) {
          bitmap.close();
          return;
        }
        localWorker.postMessage(
          { type: "frame", bitmap, timestamp: performance.now() },
          [bitmap],
        );
      } catch (error) {
        inFlight = false;
        console.error("摄像头帧读取", error);
        label.textContent = "摄像头画面未能读取，请重新开启摄像头。";
      }
    }, 100);
  } catch (error) {
    if (generation === current) {
      stop();
      panel.hidden = false;
      console.error("摄像头开启", error);
      label.textContent =
        window.lewisFriendlyError?.(error, "摄像头开启") ||
        "摄像头无法开启，请检查Windows摄像头权限或其他程序占用。";
    }
    throw error;
  } finally {
    if (generation === current) {
      loading = false;
      window.dispatchEvent(new Event("lewis-camera-state"));
    }
  }
}
function stop() {
  generation++;
  loading = false;
  cameraPending = null;
  clearInterval(timer);
  clearTimeout(loadTimer);
  timer = null;
  worker?.terminate();
  worker = null;
  inferenceReady = false;
  inFlight = false;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  panel.hidden = true;
  gate.reset();
  window.dispatchEvent(new Event("lewis-camera-state"));
}
function snapshot() {
  if (
    !stream ||
    video.readyState < 2 ||
    !video.videoWidth ||
    !video.videoHeight ||
    stream.getVideoTracks?.().some((track) => track.readyState === "ended")
  )
    return null;
  const canvas = document.createElement("canvas");
  const width = Math.min(640, video.videoWidth);
  canvas.width = width;
  canvas.height = Math.round((width * video.videoHeight) / video.videoWidth);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7);
}
async function capture({ startCamera = false } = {}) {
  if (startCamera) await start();
  else if (cameraPending) await cameraPending;
  if (!stream) return null;
  const current = generation;
  if (video.readyState < 2 || !video.videoWidth) {
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timeout);
        video.removeEventListener("loadeddata", done);
        resolve();
      };
      const timeout = setTimeout(done, 5000);
      video.addEventListener("loadeddata", done, { once: true });
    });
  }
  return current === generation ? snapshot() : null;
}
window.lewisVision = {
  start,
  stop,
  capture,
  snapshot,
  waitForGestures: () =>
    new Promise((resolve, reject) => {
      const begun = Date.now();
      const check = () => {
        if (inferenceReady) return resolve();
        if (!stream || Date.now() - begun > 45000)
          return reject(
            Error("手势模型尚未准备好，请检查摄像头状态，或改用CPU后重试"),
          );
        setTimeout(check, 100);
      };
      check();
    }),
  isActive: () =>
    Boolean(stream) &&
    !(stream.getVideoTracks?.() || []).some(
      (track) => track.readyState === "ended",
    ),
  toggle: () => (stream || loading ? Promise.resolve(stop()) : start()),
};
window.dispatchEvent(new Event("lewis-vision-ready"));
document.getElementById("stopCameraBtn").addEventListener("click", stop);
document.getElementById("restartGesturesBtn").addEventListener("click", () => {
  stop();
  start().catch(() => {});
});
