/* Saved gesture library and live matching. Capture lives in a dedicated studio. */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id),
    core = window.lewisCustomGestures;
  const key = "lewis_custom_gestures_v1";
  let templates = [],
    history = [],
    motionLatch;
  const names = {
    command: "任务指令",
    "stop-speech": "停止播报",
    "hide-pet": "隐藏桌宠",
    "show-pet": "显示桌宠",
    "pause-mic": "暂停麦克风",
    "resume-mic": "恢复麦克风",
  };
  function open(id) {
    if (window.electronAPI?.openGestureStudio)
      window.electronAPI
        .openGestureStudio(id || "")
        .catch(
          () =>
            ($("gestureRecordStatus").textContent =
              "手势工作室暂时未能打开，请重试"),
        );
    else
      window.open(
        "/gestures" + (id ? "?id=" + encodeURIComponent(id) : ""),
        "lewis-gesture-studio",
        "width=960,height=760",
      );
  }
  function load() {
    try {
      templates = core.sanitize(JSON.parse(localStorage.getItem(key) || "[]"));
    } catch {
      templates = [];
    }
    history = [];
    motionLatch = null;
    render();
  }
  function save() {
    localStorage.setItem(key, JSON.stringify(templates));
    load();
  }
  function render() {
    $("customGestureList").replaceChildren();
    for (const item of templates) {
      const row = document.createElement("div"),
        label = document.createElement("label"),
        enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = item.enabled;
      enabled.onchange = () => {
        load();
        const latest = templates.find((t) => t.id === item.id);
        if (latest) {
          latest.enabled = enabled.checked;
          save();
        }
      };
      label.append(
        enabled,
        document.createTextNode(
          item.name +
            " · " +
            (item.action === "command" ? item.command : names[item.action]),
        ),
      );
      const edit = document.createElement("button"),
        remove = document.createElement("button");
      edit.textContent = "编辑";
      edit.onclick = () => open(item.id);
      remove.textContent = "删除";
      remove.onclick = () => {
        load();
        templates = templates.filter((t) => t.id !== item.id);
        save();
      };
      row.append(label, edit, remove);
      $("customGestureList").append(row);
    }
    $("gestureRecordStatus").textContent = templates.length
      ? "已保存 " + templates.length + " 个手势 · 本机识别"
      : "还没有自定义手势";
  }
  $("gestureRecordNew").onclick = () => open();
  $("gestureStudioBtn").onclick = () => open();
  window.addEventListener("storage", (e) => {
    if (e.key === key) load();
  });
  window.addEventListener("lewis-camera-state", () => {
    history = [];
    motionLatch = null;
  });
  window.lewisGestureRecorder = {
    observe(result) {
      const now = performance.now(),
        hand =
          result.landmarks?.length === 1
            ? core.frame(result.landmarks[0])
            : null;
      if (!hand) {
        history = [];
        motionLatch = null;
        return null;
      }
      history.push(hand);
      if (history.length > 40) history.shift();
      const matched = core.match(history, templates);
      if (matched?.mode === "motion")
        motionLatch = { item: matched, expires: now + 700 };
      const item =
        matched || (motionLatch?.expires > now ? motionLatch.item : null);
      return item
        ? { gesture: "custom:" + item.id, name: item.name, source: "recorded" }
        : null;
    },
    run(id) {
      const item = templates.find((t) => "custom:" + t.id === id && t.enabled);
      if (!item) return "none";
      if (item.action === "command") {
        if (window.lewisIsBusy?.()) return "none";
        window.lewisRunGestureTask?.(item.command);
        return "command";
      }
      return window.lewisGestureActions.runAction(item.action);
    },
    templates: () => templates,
  };
  load();
})();
