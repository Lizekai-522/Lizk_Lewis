/* Local landmark templates: pose normalization and short motion comparison. No video is stored. */
(function (root) {
  "use strict";
  const fingerpose =
    typeof module === "object" && module.exports
      ? require("fingerpose")
      : root.fp;
  const fingerEstimator = fingerpose
    ? new fingerpose.GestureEstimator([]).estimator
    : null;
  const descriptors = new WeakMap();
  function curls(pose) {
    return fingerEstimator?.estimate(
      Array.from({ length: 21 }, (_, i) => pose.slice(i * 3, i * 3 + 3)),
    ).curls;
  }
  function learnedShapeMatches(pose, item) {
    if (!fingerEstimator) return true;
    let descriptor = descriptors.get(item);
    if (!descriptor) {
      descriptor = new fingerpose.GestureDescription(item.id);
      const samples = item.frames.map((f) => curls(f.pose));
      for (let finger = 0; finger < 5; finger++) {
        const counts = new Map();
        for (const sample of samples)
          counts.set(sample[finger], (counts.get(sample[finger]) || 0) + 1);
        const maximum = Math.max(...counts.values());
        for (const [curl, count] of counts)
          if (count >= maximum * 0.3)
            descriptor.addCurl(finger, curl, count / maximum);
      }
      descriptors.set(item, descriptor);
    }
    return descriptor.matchAgainst(curls(pose), []) >= 8;
  }
  function frame(hand) {
    if (
      !Array.isArray(hand) ||
      hand.length !== 21 ||
      hand.some(
        (p) =>
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          !Number.isFinite(p.z || 0),
      )
    )
      return null;
    const wrist = hand[0],
      dx = hand[9].x - wrist.x,
      dy = hand[9].y - wrist.y;
    const scale = Math.hypot(dx, dy);
    if (scale < 0.015) return null;
    const x = dy / scale,
      y = -dx / scale;
    const pose = hand.flatMap((p) => [
      ((p.x - wrist.x) * x + (p.y - wrist.y) * y) / scale,
      ((p.x - wrist.x) * -y + (p.y - wrist.y) * x) / scale,
      ((p.z || 0) - (wrist.z || 0)) / scale,
    ]);
    return { pose, position: [wrist.x, wrist.y], scale };
  }
  function sanitize(items) {
    return (Array.isArray(items) ? items : [])
      .slice(0, 16)
      .filter(
        (item) =>
          item &&
          /^g_[a-z0-9_-]{1,32}$/.test(item.id) &&
          typeof item.name === "string" &&
          item.name.length <= 40 &&
          ["pose", "motion"].includes(item.mode) &&
          typeof item.enabled === "boolean" &&
          [
            "stop-speech",
            "hide-pet",
            "show-pet",
            "pause-mic",
            "resume-mic",
            "command",
          ].includes(item.action) &&
          typeof item.command === "string" &&
          item.command.length <= 500 &&
          Array.isArray(item.frames) &&
          item.frames.length >= 12 &&
          item.frames.length <= 40 &&
          item.frames.every(
            (f) =>
              f &&
              Array.isArray(f.pose) &&
              f.pose.length === 63 &&
              f.pose.every((n) => Number.isFinite(n) && Math.abs(n) < 20) &&
              Array.isArray(f.position) &&
              f.position.length === 2 &&
              f.position.every((n) => Number.isFinite(n) && Math.abs(n) <= 2) &&
              Number.isFinite(f.scale) &&
              f.scale >= 0.015 &&
              f.scale <= 2,
          ),
      )
      .map((item) => ({
        id: item.id,
        name: item.name,
        mode: item.mode,
        enabled: item.enabled,
        action: item.action,
        command: item.command,
        frames: item.frames,
      }));
  }
  const rms = (a, b) =>
    Math.sqrt(a.reduce((sum, n, i) => sum + (n - b[i]) ** 2, 0) / a.length);
  const average = (frames) =>
    frames[0].pose.map(
      (_, i) => frames.reduce((sum, f) => sum + f.pose[i], 0) / frames.length,
    );
  function resample(frames, count = 12) {
    return Array.from({ length: count }, (_, i) => {
      const index = (i * (frames.length - 1)) / (count - 1),
        left = frames[Math.floor(index)],
        right = frames[Math.ceil(index)],
        t = index % 1;
      return {
        pose: left.pose.map((n, k) => n + (right.pose[k] - n) * t),
        position: left.position.map((n, k) => n + (right.position[k] - n) * t),
      };
    });
  }
  function motionDistance(a, b) {
    const left = resample(a),
      right = resample(b);
    const sizeA = a.reduce((n, f) => n + f.scale, 0) / a.length,
      sizeB = b.reduce((n, f) => n + f.scale, 0) / b.length;
    const amplitude = (frames, scale) =>
      Math.max(
        ...frames.map((f) =>
          Math.hypot(
            f.position[0] - frames[0].position[0],
            f.position[1] - frames[0].position[1],
          ),
        ),
      ) / scale;
    if (amplitude(a, sizeA) < amplitude(b, sizeB) * 0.4) return Infinity;
    return (
      left.reduce(
        (sum, f, i) =>
          sum +
          rms(f.pose, right[i].pose) +
          0.35 *
            rms(
              f.position.map((n, k) => (n - left[0].position[k]) / sizeA),
              right[i].position.map(
                (n, k) => (n - right[0].position[k]) / sizeB,
              ),
            ),
        0,
      ) / left.length
    );
  }
  function match(history, templates) {
    if (history.length < 5) return null;
    const candidates = [];
    for (const item of templates) {
      if (!item.enabled) continue;
      let distance;
      if (item.mode === "pose") {
        const live = average(history.slice(-5));
        if (!learnedShapeMatches(live, item)) continue;
        distance = rms(live, average(item.frames));
      } else {
        const origin = item.frames[0].position;
        if (
          Math.max(
            ...item.frames.map((f) =>
              Math.hypot(...f.position.map((n, k) => n - origin[k])),
            ),
          ) < 0.04
        )
          continue;
        distance = Math.min(
          ...[0.75, 1, 1.25].map((speed) => {
            const count = Math.round(item.frames.length * speed);
            return history.length >= count
              ? motionDistance(history.slice(-count), item.frames)
              : Infinity;
          }),
        );
      }
      if (distance < (item.mode === "pose" ? 0.16 : 0.22))
        candidates.push({ item, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    // Similar templates must be re-recorded rather than silently executing the wrong command.
    if (
      candidates[1] &&
      candidates[1].distance - candidates[0].distance < 0.025
    )
      return null;
    return candidates[0]?.item || null;
  }
  const api = {
    frame,
    sanitize,
    match,
    motionDistance,
    learnedShapeMatches,
    engine: fingerpose
      ? "Fingerpose + landmark templates"
      : "landmark templates",
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.lewisCustomGestures = api;
})(typeof window === "object" ? window : globalThis);
