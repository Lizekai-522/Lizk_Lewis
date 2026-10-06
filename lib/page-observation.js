"use strict";

// 仅运行固定的读取脚本；模型和网页都不能传入任意 JavaScript。
function collectPage() {
  const root =
    document.querySelector('main, [role="main"], article') || document.body;
  if (!root)
    return {
      title: document.title,
      url: location.href,
      text: "",
      truncated: false,
      links: [],
      images: [],
    };
  const visible = (element) =>
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "",
    node;
  while ((node = walker.nextNode()) && text.length < 20000) {
    const parent = node.parentElement;
    if (
      !parent ||
      parent.closest(
        'script, style, noscript, input, textarea, select, [contenteditable], [hidden], [aria-hidden="true"]',
      ) ||
      !visible(parent)
    )
      continue;
    const value = node.textContent.replace(/\s+/g, " ").trim();
    if (value) text += value + "\n";
  }
  const cleanURL = (value) => {
    try {
      const url = new URL(value, location.href);
      return ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
        ? url.href.slice(0, 2048)
        : "";
    } catch {
      return "";
    }
  };
  const links = Array.from(root.querySelectorAll("a[href]"))
    .filter(visible)
    .slice(0, 30)
    .map((a) => ({
      title: (a.innerText || a.textContent || "").trim().slice(0, 150),
      url: cleanURL(a.href),
    }))
    .filter((a) => a.url && a.title);
  const images = Array.from(root.querySelectorAll("img"))
    .filter(visible)
    .slice(0, 12)
    .map((img) => ({
      alt: img.alt.slice(0, 200),
      url: cleanURL(img.currentSrc || img.src),
    }));
  const snapshotId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
  const elements = Array.from(
    document.querySelectorAll(
      'a[href], button, input, textarea, select, [role="button"], [contenteditable="true"]',
    ),
  )
    .filter(visible)
    .slice(0, 60);
  globalThis.__lewisSnapshot = { id: snapshotId, elements };
  const targets = elements.map((element, index) => ({
    ref: "e" + (index + 1),
    role: element.getAttribute("role") || element.tagName.toLowerCase(),
    text: (
      element.getAttribute("aria-label") ||
      element.innerText ||
      element.textContent ||
      element.getAttribute("placeholder") ||
      ""
    )
      .trim()
      .slice(0, 150),
    type: element.getAttribute("type") || "",
    disabled: Boolean(element.disabled),
  }));
  return {
    title: document.title.slice(0, 150),
    url: location.href,
    text: text.trim().slice(0, 6000),
    truncated: text.length > 6000,
    links,
    images,
    snapshotId,
    targets,
  };
}

function normalizeObservation(value, expectedURL) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.text !== "string" ||
    typeof value.url !== "string"
  )
    throw new Error("网页没有返回可读取的正文");
  if (value.url !== expectedURL)
    throw new Error("读取期间页面发生跳转，请重新读取当前页面");
  const links = Array.isArray(value.links)
    ? value.links
        .slice(0, 30)
        .filter(
          (item) =>
            item &&
            typeof item.url === "string" &&
            /^https?:\/\//i.test(item.url),
        )
        .map((item) => ({
          title: String(item.title || "").slice(0, 150),
          url: item.url.slice(0, 2048),
        }))
    : [];
  const images = Array.isArray(value.images)
    ? value.images
        .slice(0, 12)
        .map((item) => ({
          alt: String(item?.alt || "").slice(0, 200),
          url: String(item?.url || "").slice(0, 2048),
        }))
    : [];
  const targets = Array.isArray(value.targets)
    ? value.targets
        .slice(0, 60)
        .map((item) => ({
          ref: String(item?.ref || "").slice(0, 10),
          role: String(item?.role || "").slice(0, 30),
          text: String(item?.text || "").slice(0, 150),
          type: String(item?.type || "").slice(0, 30),
          disabled: Boolean(item?.disabled),
        }))
    : [];
  return {
    title: String(value.title || "").slice(0, 150),
    url: expectedURL,
    source: expectedURL,
    text: value.text.slice(0, 6000),
    truncated: Boolean(value.truncated || value.text.length > 6000),
    links,
    images,
    snapshotId: String(value.snapshotId || "").slice(0, 80),
    targets,
    mode: "browser",
    observedAt: new Date().toISOString(),
  };
}

function preparePageAction(action) {
  const snapshot = globalThis.__lewisSnapshot;
  if (!snapshot || snapshot.id !== action.snapshotId)
    throw new Error("页面快照已过期，请先重新读取页面");
  const element = snapshot.elements[Number(action.ref.slice(1)) - 1];
  if (!element?.isConnected || element.disabled)
    throw new Error("页面元素不可用，请重新读取页面");
  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  const x = rect.x + rect.width / 2,
    y = rect.y + rect.height / 2;
  if (
    !rect.width ||
    !rect.height ||
    getComputedStyle(element).visibility === "hidden"
  )
    throw new Error("页面元素不可见");
  const hit = document.elementFromPoint(x, y);
  if (!hit || !element.contains(hit)) throw new Error("页面元素被其他内容遮挡");
  if (action.kind === "type") {
    if (element.type === "password" || element.type === "file")
      throw new Error("请在网页中手动填写密码或上传文件");
    if (!(element.matches("input, textarea") || element.isContentEditable))
      throw new Error("目标不是可编辑输入框");
    element.focus();
    if (typeof element.select === "function") element.select();
    else {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  return {
    x,
    y,
    label: (
      element.getAttribute("aria-label") ||
      element.innerText ||
      element.textContent ||
      ""
    )
      .trim()
      .slice(0, 120),
    url: location.href,
  };
}

module.exports = {
  collectPage,
  normalizeObservation,
  preparePageAction,
  PAGE_READ_SCRIPT: "(" + collectPage.toString() + ")()",
};
