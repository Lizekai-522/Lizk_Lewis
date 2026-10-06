// 手势判定与防抖独立于摄像头，跟踪到手后才做几何辅助判断。
(function (root) {
  const distance = (a, b) =>
    Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
  function classifyHand(landmarks, category) {
    if (!landmarks || landmarks.length !== 21) return "";
    if (landmarks.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
      return "";
    // 可信的其他手势必须保留，不能用“四指弯曲”把竖拇指覆盖为握拳。
    if (
      category?.score >= 0.55 &&
      [
        "Open_Palm",
        "Closed_Fist",
        "Pointing_Up",
        "Thumb_Down",
        "Thumb_Up",
        "Victory",
        "ILoveYou",
      ].includes(category.categoryName)
    )
      return category.categoryName;
    const ratios = [8, 12, 16, 20].map(
      (tip) =>
        distance(landmarks[tip], landmarks[0]) /
        Math.max(0.001, distance(landmarks[tip - 2], landmarks[0])),
    );
    if (ratios.every((ratio) => ratio > 1.25)) return "Open_Palm";
    if (ratios.every((ratio) => ratio < 0.95)) return "Closed_Fist";
    return "";
  }
  class GestureGate {
    constructor() {
      this.reset();
    }
    reset() {
      this.gesture = "";
      this.since = 0;
      this.fired = false;
      this.lastAction = -Infinity;
      this.lastPositive = -Infinity;
    }
    update(gesture, now) {
      // 10FPS 下短暂漏检一两帧不重置；长时间无手才重新允许触发。
      if (!gesture) {
        if (now - this.lastPositive > 250) {
          this.gesture = "";
          this.fired = false;
        }
        return "";
      }
      if (gesture !== this.gesture) {
        this.gesture = gesture;
        this.since = now;
        this.fired = false;
      }
      this.lastPositive = now;
      if (
        !gesture ||
        this.fired ||
        now - this.since < 450 ||
        now - this.lastAction < 1500
      )
        return "";
      this.fired = true;
      this.lastAction = now;
      return gesture;
    }
  }
  function selectGesture(result) {
    const candidates = (result.landmarks || [])
      .map((hand, index) => {
        const category = result.gestures?.[index]?.[0];
        const gesture = classifyHand(hand, category);
        const model =
          category?.categoryName === gesture && category.score >= 0.55;
        return {
          gesture,
          score: model ? category.score : null,
          source: model ? "model" : "geometry",
        };
      })
      .filter((item) => item.gesture);
    // 先采用可信模型；两手冲突时，暂停播报优先，避免无意隐藏窗口。
    candidates.sort(
      (a, b) =>
        Number(b.source === "model") - Number(a.source === "model") ||
        Number(b.gesture === "Open_Palm") - Number(a.gesture === "Open_Palm"),
    );
    return candidates[0] || { gesture: "", score: null, source: "" };
  }
  if (typeof module === "object" && module.exports)
    module.exports = { classifyHand, GestureGate, selectGesture };
  else root.lewisGestures = { classifyHand, GestureGate, selectGesture };
})(typeof window === "object" ? window : globalThis);
