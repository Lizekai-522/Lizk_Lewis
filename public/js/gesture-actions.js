"use strict";
(() => {
  const gestures = {
    Open_Palm: "张开手掌",
    Closed_Fist: "握拳",
    Pointing_Up: "食指朝上",
    Thumb_Down: "拇指朝下",
    Thumb_Up: "竖拇指",
    Victory: "胜利手势",
    ILoveYou: "爱心手势",
  };
  const actions = {
    none: "无动作",
    "stop-speech": "停止播报",
    "hide-pet": "隐藏桌宠",
    "show-pet": "显示桌宠",
    "pause-mic": "暂停麦克风",
    "resume-mic": "恢复麦克风",
  };
  const defaults = { Open_Palm: "stop-speech", Closed_Fist: "hide-pet" };
  const sanitize = (mapping) =>
    Object.fromEntries(
      Object.keys(gestures).map((key) => [
        key,
        Object.hasOwn(actions, mapping?.[key])
          ? mapping[key]
          : defaults[key] || "none",
      ]),
    );
  function render(mapping) {
    const host = document.getElementById("gestureActions");
    host.replaceChildren();
    for (const [key, value] of Object.entries(sanitize(mapping))) {
      const label = document.createElement("label");
      label.textContent = gestures[key] + " ";
      const select = document.createElement("select");
      select.dataset.gesture = key;
      for (const [id, text] of Object.entries(actions))
        select.add(new Option(text, id));
      select.value = value;
      label.append(select);
      host.append(label, document.createElement("br"));
    }
  }
  const read = () =>
    Object.fromEntries(
      [...document.querySelectorAll("[data-gesture]")].map((select) => [
        select.dataset.gesture,
        select.value,
      ]),
    );
  function runAction(action) {
    if (action === "stop-speech") window.lewisStopSpeech?.();
    if (action === "hide-pet") window.lewisHidePet?.();
    if (action === "show-pet") window.electronAPI?.showPet();
    if (action === "pause-mic") window.lewisSetMicrophone?.(false);
    if (action === "resume-mic") window.lewisSetMicrophone?.(true);
    return action;
  }
  function run(gesture) {
    if (gesture.startsWith("custom:"))
      return window.lewisGestureRecorder?.run(gesture) || "none";
    return runAction(
      sanitize(window.lewisGetSettings?.().gestureActions)[gesture] || "none",
    );
  }
  window.lewisGestureActions = { render, read, run, runAction, sanitize };
})();
