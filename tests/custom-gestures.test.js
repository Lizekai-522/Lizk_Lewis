const { test } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../public/js/custom-gestures");
function hand(x = 0.3, y = 0.7, scale = 0.1, angle = 0) {
  const points = Array.from({ length: 21 }, (_, i) => ({
    x: ((i % 4) - 1) * 0.2,
    y: -(Math.floor(i / 4) + 1) * 0.2,
    z: 0,
  }));
  points[0] = { x: 0, y: 0, z: 0 };
  points[9] = { x: 0, y: -1, z: 0 };
  return points.map((p) => ({
    x: x + scale * (p.x * Math.cos(angle) - p.y * Math.sin(angle)),
    y: y + scale * (p.x * Math.sin(angle) + p.y * Math.cos(angle)),
    z: 0,
  }));
}
const template = (frames, extra = {}) => ({
  id: "g_test",
  name: "我的手势",
  mode: "pose",
  action: "command",
  command: "搜索今天新闻",
  enabled: true,
  frames,
  ...extra,
});
test("录制手形对位移、距离和旋转归一化；不把不同手形混为同一命令", () => {
  const recording = Array.from({ length: 20 }, () => core.frame(hand()));
  const live = Array.from({ length: 6 }, () =>
    core.frame(hand(0.5, 0.5, 0.2, 0.6)),
  );
  assert.equal(core.match(live, [template(recording)]).id, "g_test");
  const changed = hand();
  changed[8].y += 0.4;
  assert.equal(
    core.match(Array(6).fill(core.frame(changed)), [template(recording)]),
    null,
  );
  assert.equal(core.frame([]), null);
});
test("动作录制匹配完整移动轨迹，静止不误触；重复模板拒绝歧义", () => {
  const frames = Array.from({ length: 20 }, (_, i) =>
    core.frame(hand(0.3 + Math.sin((i / 19) * Math.PI) * 0.15)),
  );
  const item = template(frames, { mode: "motion" });
  assert.equal(core.match(frames, [item]).id, "g_test");
  assert.equal(core.match(Array(20).fill(frames[0]), [item]), null);
  assert.equal(core.match(frames, [item, { ...item, id: "g_other" }]), null);
  assert.equal(core.match(frames, [{ ...item, enabled: false }]), null);
  assert.equal(
    core.sanitize([{ ...item, frames: [{ pose: [NaN] }] }]).length,
    0,
  );
});
test("独立录制工作室保存后，主界面立即加载并执行；删除和重载同步", async () => {
  const fs = require("node:fs"),
    { JSDOM } = require("jsdom");
  const dom = new JSDOM(
    fs.readFileSync(
      require("node:path").join(__dirname, "../public/index.html"),
      "utf8",
    ),
    { url: "http://localhost:3000", runScripts: "outside-only" },
  );
  const w = dom.window,
    commands = [];
  w.lewisCustomGestures = core;
  w.lewisRunGestureTask = (text) => commands.push(text);
  w.lewisIsBusy = () => false;
  w.eval(
    fs.readFileSync(
      require("node:path").join(__dirname, "../public/js/gesture-recorder.js"),
      "utf8",
    ),
  );
  assert.equal(w.document.getElementById("gestureRecordName"), null);
  const saved = template(Array.from({ length: 20 }, () => core.frame(hand())));
  w.localStorage.setItem("lewis_custom_gestures_v1", JSON.stringify([saved]));
  w.dispatchEvent(
    new w.StorageEvent("storage", { key: "lewis_custom_gestures_v1" }),
  );
  assert.equal(w.lewisGestureRecorder.templates().length, 1);
  for (let i = 0; i < 6; i++)
    w.lewisGestureRecorder.observe({ landmarks: [hand()] });
  assert.deepEqual(commands, []);
  w.lewisGestureRecorder.run("custom:g_test");
  assert.deepEqual(commands, ["搜索今天新闻"]);
  w.localStorage.setItem("lewis_custom_gestures_v1", "[]");
  w.dispatchEvent(
    new w.StorageEvent("storage", { key: "lewis_custom_gestures_v1" }),
  );
  assert.equal(w.lewisGestureRecorder.run("custom:g_test"), "none");
  w.close();
});
