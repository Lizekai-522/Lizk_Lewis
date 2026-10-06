"use strict";
(() => {
  const items = [];
  const status = (text) =>
    (document.getElementById("attachmentStatus").textContent = text);
  function render() {
    const preview = document.getElementById("attachmentPreview");
    preview.replaceChildren();
    items.forEach((item, index) => {
      const box = document.createElement("span");
      const img = document.createElement("img");
      img.src = item.image;
      img.alt = item.label;
      img.style.cssText = "width:72px;height:54px;object-fit:cover";
      const remove = document.createElement("button");
      remove.textContent = "移除";
      remove.setAttribute("aria-label", "移除" + item.label);
      remove.onclick = () => {
        items.splice(index, 1);
        render();
      };
      box.append(img, remove);
      preview.append(box);
    });
    status(items.length ? `${items.length}/3 张图片 · 发送后交给视觉模型` : "");
  }
  function add(image, label) {
    if (items.length >= 3) throw new Error("每轮最多 3 张图片");
    items.push({ image, label });
    render();
  }
  async function encode(file) {
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 10 * 1024 * 1024
    )
      throw new Error("请选择 10MB 内的 JPG、PNG 或 WebP");
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement("canvas");
      let result;
      for (const width of [1280, 800, 500]) {
        const ratio = Math.min(
          1,
          width / Math.max(bitmap.width, bitmap.height),
        );
        canvas.width = Math.round(bitmap.width * ratio);
        canvas.height = Math.round(bitmap.height * ratio);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        result = canvas.toDataURL("image/jpeg", 0.7);
        if (result.length < 349000) return result;
      }
      throw new Error("图片压缩后仍过大");
    } finally {
      bitmap.close();
    }
  }
  const report = (operation) => async () => {
    try {
      await operation();
    } catch (error) {
      status(window.lewisFriendlyError?.(error, "附件操作") || "未能添加附件，请重试");
    }
  };
  document.getElementById("attachImage").onclick = () =>
    document.getElementById("chatImages").click();
  document.getElementById("chatImages").onchange = report(async () => {
    const input = document.getElementById("chatImages");
    try {
      for (const file of input.files) add(await encode(file), file.name);
    } finally {
      input.value = "";
    }
  });
  document.getElementById("attachPhoto").onclick = report(async () => {
    const image = await window.lewisVision?.capture({ startCamera: true });
    if (!image) throw new Error("摄像头未取得画面");
    add(image, "摄像头照片");
  });
  document.getElementById("attachScreen").disabled =
    !window.electronAPI?.captureDesktop;
  document.getElementById("attachScreen").onclick = report(async () =>
    add(await window.electronAPI.captureDesktop(), "屏幕截图"),
  );
  window.lewisAttachments = {
    peek: () => items.map((item) => ({ ...item })),
    clear: () => {
      items.length = 0;
      render();
    },
  };
})();
