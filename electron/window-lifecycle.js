"use strict";

// BrowserWindow.webContents 和 senderFrame 的 getter 在销毁期间也可能抛错。
// 先检查存活状态；只在生命周期边界读取原生对象，失效对象不再参与 IPC。
function liveContents(window) {
  try {
    if (!window || window.isDestroyed()) return null;
    const contents = window.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  } catch {
    return null;
  }
}

function isWindowSender(event, window) {
  try {
    const contents = liveContents(window);
    return Boolean(
      contents &&
        event?.sender &&
        !event.sender.isDestroyed() &&
        event.sender.id === contents.id,
    );
  } catch {
    return false;
  }
}

function isTrustedSender(event, windows, origin) {
  try {
    return Boolean(
      origin &&
        windows.some((window) => isWindowSender(event, window)) &&
        event.senderFrame?.url.startsWith(origin + "/"),
    );
  } catch {
    return false;
  }
}

function sendToWindow(window, channel, data) {
  const contents = liveContents(window);
  if (!contents) return false;
  contents.send(channel, data);
  return true;
}

module.exports = {
  liveContents,
  isWindowSender,
  isTrustedSender,
  sendToWindow,
};
