/* Camera folds upward, voice controls downward. Folding keeps devices running. */
(() => {
  "use strict";
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("lewis_panel_folds") || "{}");
  } catch {}
  function bind(id, panel, key, direction, label) {
    const handle = document.getElementById(id);
    let start,
      dragged = false;
    function apply(value) {
      panel.classList.toggle("collapsed", value);
      saved[key] = value;
      handle.setAttribute("aria-expanded", String(!value));
      handle.textContent = value
        ? `展开${label} ${direction < 0 ? "▾" : "▴"}`
        : `收起${label} ${direction < 0 ? "▴" : "▾"}`;
      try {
        localStorage.setItem("lewis_panel_folds", JSON.stringify(saved));
      } catch {}
      window.dispatchEvent(new Event("resize"));
    }
    apply(saved[key] === true);
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      start = event.clientY;
      dragged = false;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {}
    });
    handle.addEventListener("pointerup", (event) => {
      if (start === undefined) return;
      const delta = event.clientY - start;
      start = undefined;
      if (Math.abs(delta) > 25) {
        dragged = true;
        apply(delta * direction > 0);
      }
    });
    handle.addEventListener("pointercancel", () => {
      start = undefined;
    });
    handle.addEventListener("click", () => {
      if (dragged) {
        dragged = false;
        return;
      }
      apply(!panel.classList.contains("collapsed"));
    });
  }
  bind(
    "cameraFold",
    document.getElementById("visionPanel"),
    "camera",
    -1,
    "摄像头",
  );
  bind(
    "voiceControlsFold",
    document.querySelector(".lewis-toolbar"),
    "voice",
    1,
    "语音控制",
  );
})();
