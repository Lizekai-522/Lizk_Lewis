const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPetInteraction } = require("../electron/pet-interaction");
const { JSDOM } = require("jsdom");
const fs = require("node:fs");
const path = require("node:path");
test("桌宠主进程拖动跟随系统光标，释放/重置恢复透明穿透", () => {
  let cursor = { x: 150, y: 150 };
  let position = { x: 100, y: 100 };
  const changes = [];
  const window = {
    isDestroyed: () => false,
    isVisible: () => true,
    getContentBounds: () => ({ ...position, width: 240, height: 260 }),
    setPosition: (x, y) => {
      position = { x, y };
    },
    setIgnoreMouseEvents: (ignored) => changes.push(ignored),
  };
  const interaction = createPetInteraction(window, {
    getCursorScreenPoint: () => cursor,
  });
  try {
    interaction.setDragging(true);
    cursor = { x: 320, y: 210 };
    interaction.refresh();
    assert.deepEqual(position, { x: 270, y: 160 });
    interaction.setDragging(false);
    interaction.reset();
    assert.equal(changes.at(-1), true);
  } finally {
    interaction.destroy();
  }
});

test("桌宠透明空白、圆形四角和气泡不挡点击；头像、菜单及拖动仍接收鼠标", () => {
  let cursor = { x: 10, y: 10 },
    visible = true;
  const changes = [];
  const window = {
    isDestroyed: () => false,
    isVisible: () => visible,
    getContentBounds: () => ({ x: 0, y: 0, width: 240, height: 260 }),
    setIgnoreMouseEvents: (value) => changes.push(value),
  };
  const interaction = createPetInteraction(window, {
    getCursorScreenPoint: () => cursor,
  });
  try {
    interaction.report([
      { kind: "circle", x: 82, y: 127, width: 76, height: 76 },
    ]);
    assert.equal(changes.at(-1), true);
    cursor = { x: 120, y: 165 };
    interaction.refresh();
    assert.equal(changes.at(-1), false);
    cursor = { x: 83, y: 128 };
    interaction.refresh();
    assert.equal(changes.at(-1), true);
    cursor = { x: 120, y: 80 };
    interaction.refresh();
    assert.equal(changes.at(-1), true);
    interaction.report([
      { kind: "circle", x: 82, y: 127, width: 76, height: 76 },
      { kind: "rect", x: 20, y: 10, width: 160, height: 90 },
    ]);
    assert.equal(changes.at(-1), false);
    cursor = { x: 230, y: 240 };
    interaction.setDragging(true);
    assert.equal(changes.at(-1), false);
    interaction.setDragging(false);
    assert.equal(changes.at(-1), true);
    cursor = { x: 120, y: 165 };
    interaction.refresh();
    visible = false;
    interaction.refresh();
    assert.equal(changes.at(-1), true);
  } finally {
    interaction.destroy();
  }
});

test("无效桌宠区域不能把整个窗口改为可点击", () => {
  const changes = [];
  const interaction = createPetInteraction(
    {
      isDestroyed: () => false,
      isVisible: () => true,
      getContentBounds: () => ({ x: 0, y: 0, width: 240, height: 260 }),
      setIgnoreMouseEvents: (value) => changes.push(value),
    },
    { getCursorScreenPoint: () => ({ x: 10, y: 10 }) },
  );
  try {
    interaction.report([
      { kind: "rect", x: 0, y: 0, width: Infinity, height: 260 },
    ]);
    assert.deepEqual(changes, [true]);
  } finally {
    interaction.destroy();
  }
});

test("桌宠页面报告圆形头像与展开菜单，唤醒消息恢复隐藏头像", () => {
  const dom = new JSDOM(
    fs.readFileSync(path.join(__dirname, "../public/pet.html"), "utf8"),
    { url: "http://localhost:3000/pet", runScripts: "outside-only" },
  );
  const window = dom.window;
  const reports = [];
  window.electronAPI = {
    petHitRegions: (regions) => reports.push(regions),
    onMessage: (callback) => {
      window.receivePet = callback;
    },
    publish: () => {},
    petDragging: () => {},
  };
  window.document.querySelector(".pet-avatar").getBoundingClientRect = () => ({
    x: 82,
    y: 127,
    width: 76,
    height: 76,
  });
  window.document.getElementById("contextMenu").getBoundingClientRect = () => ({
    x: 10,
    y: 10,
    width: 140,
    height: 190,
  });
  window.eval(window.document.querySelector("script").textContent);
  assert.equal(reports[0].length, 1);
  assert.equal(reports[0][0].kind, "circle");
  window.document
    .querySelector(".pet-avatar")
    .dispatchEvent(
      new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  assert.equal(reports.at(-1).length, 2);
  assert.equal(reports.at(-1)[1].kind, "rect");
  window.document.getElementById("pet").hidden = true;
  window.receivePet({ type: "wake" });
  assert.equal(window.document.getElementById("pet").hidden, false);
  assert.match(
    window.document.getElementById("speechBubble").textContent,
    /我在/,
  );
  window.close();
});
