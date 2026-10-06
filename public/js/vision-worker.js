importScripts("/vendor/vision/vision_bundle.js");
const { GestureRecognizer, FilesetResolver } = Vision;
let recognizer;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      const files = await FilesetResolver.forVisionTasks("/vendor/vision/wasm");
      // 与 MediaPipe 官方示例一致，可选择 CPU 和检测/跟踪阈值，方便适配摄像头及显卡。
      let delegate = data.delegate === "CPU" ? "CPU" : "GPU";
      const confidence =
        Number.isFinite(data.confidence) &&
        data.confidence >= 0.3 &&
        data.confidence <= 0.8
          ? data.confidence
          : 0.45;
      const options = {
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: confidence,
        minHandPresenceConfidence: confidence,
        minTrackingConfidence: confidence,
      };
      try {
        recognizer = await GestureRecognizer.createFromOptions(files, {
          ...options,
          baseOptions: {
            modelAssetPath: "/models/gesture_recognizer.task",
            delegate,
          },
        });
      } catch {
        delegate = "CPU";
        recognizer = await GestureRecognizer.createFromOptions(files, {
          ...options,
          baseOptions: {
            modelAssetPath: "/models/gesture_recognizer.task",
            delegate,
          },
        });
      }
      self.postMessage({ type: "ready", delegate });
    } else if (data.type === "frame") {
      try {
        self.postMessage({
          type: "result",
          result: recognizer.recognizeForVideo(data.bitmap, data.timestamp),
        });
      } finally {
        data.bitmap.close();
      }
    }
  } catch (error) {
    self.postMessage({ type: "error", error: error.message });
  }
};
