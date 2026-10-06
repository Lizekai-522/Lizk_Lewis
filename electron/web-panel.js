"use strict";
const { validateWebURL, publicAddress } = require("../lib/web");
const net = require("node:net");
const { liveContents, sendToWindow } = require("./window-lifecycle");
const {
  PAGE_READ_SCRIPT,
  normalizeObservation,
  preparePageAction,
} = require("../lib/page-observation");

function publicURL(value) {
  const url = validateWebURL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    /\.(?:localhost|local)$/i.test(host) ||
    (net.isIP(host) && !publicAddress(host))
  )
    throw new Error("请使用公开网站地址");
  return url.href;
}

// 外部网页使用独立 Chromium 视图；不加载助手 preload，不提供电脑和微信 IPC。
function createWebPanel({
  window,
  WebContentsView,
  session,
  allowed,
  proxyAddress,
}) {
  let view,
    bounds,
    visible = false,
    defaultMuted = true,
    url = "",
    state = "idle",
    error = "",
    navigation = 0;
  let destroyed = false;
  const pending = new Set();
  let proxyReady = Promise.resolve(),
    loading;
  const send = (extra) => {
    if (!destroyed)
      sendToWindow(window, "lewis:web-state", { url, state, error, ...extra });
  };
  function layout() {
    if (
      destroyed ||
      !view ||
      view.webContents.isDestroyed() ||
      !liveContents(window)
    )
      return;
    view.setVisible(visible && Boolean(bounds) && window.isVisible());
    if (!bounds) return;
    const [width, height] = window.getContentSize();
    const x = Math.max(0, Math.min(width - 1, Math.round(bounds.x)));
    const y = Math.max(0, Math.min(height - 1, Math.round(bounds.y)));
    view.setBounds({
      x,
      y,
      width: Math.max(1, Math.min(width - x, Math.round(bounds.width))),
      height: Math.max(1, Math.min(height - y, Math.round(bounds.height))),
    });
  }
  function ensure() {
    if (destroyed || !liveContents(window)) throw new Error("网页窗口已关闭");
    if (view) return view;
    const isolated = session.fromPartition("persist:lewis-web");
    if (proxyAddress)
      proxyReady = (async () => {
        await isolated.closeAllConnections();
        await isolated.setProxy({
          mode: "fixed_servers",
          proxyRules: "http://" + proxyAddress,
          proxyBypassRules: "<-loopback>",
        });
        if (destroyed) throw new Error("网页窗口已关闭");
      })();
    isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    isolated.setPermissionCheckHandler(() => false);
    isolated.on("will-download", (event) => event.preventDefault());
    isolated.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (details, callback) => {
        try {
          publicURL(details.url);
          callback({ cancel: !allowed() });
        } catch {
          callback({ cancel: true });
        }
      },
    );
    view = new WebContentsView({
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    view.setVisible(false);
    window.contentView.addChildView(view);
    const contents = view.webContents;
    contents.setAudioMuted(defaultMuted);
    const navigate = (event, next) => {
      const target = typeof next === "string" ? next : next.url;
      try {
        if (!allowed()) throw new Error("电脑操作权限已关闭");
        publicURL(target);
      } catch (failure) {
        event.preventDefault();
        error = failure.message;
        send();
      }
    };
    contents.on("will-navigate", navigate);
    contents.on("will-redirect", navigate);
    contents.setWindowOpenHandler(({ url: target }) => {
      void open(target).catch((failure) =>
        send({ error: failure.message, state: "error" }),
      );
      return { action: "deny" };
    });
    contents.on("did-start-loading", () => {
      state = "loading";
      error = "";
      send();
    });
    contents.on("did-navigate", (_event, target) => {
      url = target;
      send();
    });
    contents.on("did-navigate-in-page", (_event, target, main) => {
      if (main) {
        url = target;
        send();
      }
    });
    contents.on("did-finish-load", () => {
      if (destroyed || contents.isDestroyed()) return;
      state = "ready";
      url = contents.getURL();
      error = "";
      send({ title: contents.getTitle() });
    });
    contents.on("did-fail-load", (_event, code, description, target, main) => {
      if (main && code !== -3) {
        state = "error";
        error = `网页加载失败：${description} (${code})`;
        url = target;
        send();
      }
    });
    layout();
    return view;
  }
  async function open(target) {
    if (!allowed()) throw new Error("电脑操作权限已关闭");
    const next = publicURL(target);
    const contents = ensure().webContents;
    await proxyReady;
    if (destroyed || contents.isDestroyed()) throw new Error("网页窗口已关闭");
    const attempt = ++navigation;
    url = next;
    error = "";
    state = "loading";
    send({ reveal: true });
    let timer, cancel;
    try {
      // 销毁时主动取消等待并清除超时，避免超时回调调用已销毁的 contents.stop()。
      const cancelled = new Promise((_resolve, reject) => {
        cancel = () => reject(new Error("网页窗口已关闭"));
        pending.add(cancel);
      });
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          if (attempt === navigation && !contents.isDestroyed())
            contents.stop();
          reject(new Error("网页加载超时，请检查网络或重新打开"));
        }, 30000);
      });
      loading = Promise.race([contents.loadURL(next), timeout, cancelled]);
      await loading;
    } catch (failure) {
      if (attempt === navigation) {
        state = "error";
        error =
          failure.code === "ERR_ABORTED"
            ? "网页加载已停止或已切换"
            : failure.message;
        send();
      }
      throw failure;
    } finally {
      clearTimeout(timer);
      pending.delete(cancel);
    }
  }
  function bounded(operation, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(value);
      };
      const cancel = () => finish(new Error("网页窗口已关闭"));
      const abort = () => finish(signal.reason || new Error("网页操作已取消"));
      const timer = setTimeout(
        () => finish(new Error("网页操作超时，请停止加载后重试")),
        15000,
      );
      pending.add(cancel);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      Promise.resolve(operation).then(
        (value) => finish(null, value),
        (error) => finish(error),
      );
    });
  }
  async function read({ url: target, screenshot = false, signal } = {}) {
    if (!allowed()) throw new Error("网页权限已关闭");
    if (signal?.aborted) throw signal.reason;
    if (target) {
      const next = publicURL(target);
      if (
        !view ||
        view.webContents.isDestroyed() ||
        view.webContents.getURL() !== next
      )
        await open(next);
    }
    if (loading && state === "loading") await loading;
    if (
      destroyed ||
      !liveContents(window) ||
      !view ||
      view.webContents.isDestroyed()
    )
      throw new Error("请先在网页面板打开页面");
    const contents = view.webContents;
    const expected = publicURL(contents.getURL());
    const attempt = navigation;
    const check = () => {
      if (signal?.aborted) throw signal.reason;
      if (destroyed || contents.isDestroyed())
        throw new Error("网页窗口已关闭");
      if (!allowed()) throw new Error("网页权限已关闭");
      if (navigation !== attempt || contents.getURL() !== expected)
        throw new Error("读取期间页面发生跳转，请重新读取当前页面");
    };
    // SPA 首屏与延迟加载有时间形成；持续更新的页面也有明确的等待上限。
    let observation,
      previous = "",
      stable = 0;
    for (let index = 0; index < 8; index++) {
      check();
      observation = await bounded(
        contents.executeJavaScriptInIsolatedWorld(1010, [
          { code: PAGE_READ_SCRIPT },
        ]),
        signal,
      );
      check();
      const text = observation?.text || "";
      stable = text && text === previous ? stable + 1 : 0;
      previous = text;
      if (index >= 3 && stable >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    check();
    const result = normalizeObservation(observation, expected);
    if (screenshot) {
      const image = await bounded(
        contents.capturePage(undefined, { stayHidden: true, stayAwake: true }),
        signal,
      );
      check();
      if (image.isEmpty()) throw new Error("网页截图为空，请展开网页面板再试");
      let resized = image.resize({
        width: Math.min(1280, image.getSize().width),
      });
      let bytes = resized.toJPEG(75);
      if (bytes.length > 512 * 1024) {
        resized = resized.resize({ width: 800 });
        bytes = resized.toJPEG(55);
      }
      if (bytes.length > 512 * 1024)
        throw new Error("网页截图过大，请缩小页面后重试");
      result.image = "data:image/jpeg;base64," + bytes.toString("base64");
      result.capture = "viewport";
    }
    send({
      observation: {
        title: result.title,
        text: result.text,
        url: result.url,
        mode: result.mode,
        links: result.links,
      },
    });
    return result;
  }
  async function act({ kind, ref, snapshotId, text, amount, signal } = {}) {
    if (!["click", "type", "scroll", "play"].includes(kind))
      throw new Error("网页操作无效");
    if (destroyed || !view || view.webContents.isDestroyed() || !allowed())
      throw new Error("网页窗口或权限不可用");
    if (signal?.aborted) throw signal.reason;
    const contents = view.webContents;
    if (kind === "play") {
      const playback = await bounded(
        contents.executeJavaScriptInIsolatedWorld(
          1010,
          [
            {
              code: `(async () => {
        const videos = [...document.querySelectorAll('video')].filter(video => video.getClientRects().length && getComputedStyle(video).visibility !== 'hidden').sort((a,b) => b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight);
        const video = videos[0]; if(!video) throw Error('当前页面没有可播放的视频，请先进入视频详情');
        await video.play(); return {playing: !video.paused, currentTime: video.currentTime};
      })()`,
            },
          ],
          true,
        ),
        signal,
      );
      if (!playback.playing)
        throw Error("视频没有开始播放，请检查登录或网站播放器");
      contents.setAudioMuted(false);
      send({ muted: false });
      return {
        ...playback,
        url: contents.getURL(),
        text: "网页视频已开始播放",
        source: "内置网页实际播放器",
      };
    }
    const expected = publicURL(contents.getURL());
    const check = () => {
      if (signal?.aborted) throw signal.reason;
      if (destroyed || contents.isDestroyed() || !allowed())
        throw new Error("网页操作已停止");
      if (contents.getURL() !== expected)
        throw new Error("操作期间页面发生跳转，请重新读取页面");
    };
    if (kind === "scroll") {
      if (!Number.isInteger(amount) || Math.abs(amount) > 1600 || !amount)
        throw new Error("每次滚动范围为 -1600 到 1600 像素");
      await contents.executeJavaScriptInIsolatedWorld(1010, [
        { code: `window.scrollBy({top:${amount},behavior:'instant'}); true` },
      ]);
    } else {
      if (
        !/^e[1-9][0-9]?$/.test(ref || "") ||
        typeof snapshotId !== "string" ||
        snapshotId.length > 80
      )
        throw new Error("请使用最近网页快照中的元素编号");
      if (kind === "type" && (typeof text !== "string" || text.length > 2000))
        throw new Error("网页输入文本应在 2000 字符以内");
      const position = await contents.executeJavaScriptInIsolatedWorld(1010, [
        {
          code:
            "(" +
            preparePageAction.toString() +
            ")(" +
            JSON.stringify({ kind, ref, snapshotId }) +
            ")",
        },
      ]);
      check();
      const debuggerAPI = contents.debugger;
      if (!debuggerAPI.isAttached()) debuggerAPI.attach("1.3");
      if (kind === "type")
        await debuggerAPI.sendCommand("Input.insertText", { text });
      else {
        await debuggerAPI.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: position.x,
          y: position.y,
          button: "left",
          clickCount: 1,
        });
        await debuggerAPI.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: position.x,
          y: position.y,
          button: "left",
          clickCount: 1,
        });
      }
    }
    // 操作后重新读取，以实际网页状态为依据；不移动系统鼠标或切换桌面焦点。
    await new Promise((resolve) => setTimeout(resolve, 350));
    return read({ signal });
  }
  function setLayout(data) {
    if (!data || typeof data.visible !== "boolean") return;
    visible = data.visible;
    if (
      ["x", "y", "width", "height"].every((key) =>
        Number.isFinite(data[key]),
      ) &&
      data.width > 0 &&
      data.height > 0
    )
      bounds = data;
    layout();
  }
  async function control(action) {
    if (destroyed || !liveContents(window)) throw new Error("网页窗口已关闭");
    if (action === "mute-on" || action === "mute-off") {
      defaultMuted = action === "mute-on";
      if (view && !view.webContents.isDestroyed()) {
        view.webContents.setAudioMuted(defaultMuted);
        send({ muted: defaultMuted });
      }
      return;
    }
    if (action === "external") {
      if (!url) throw new Error("尚未打开网页");
      return publicURL(url);
    }
    if (!view || view.webContents.isDestroyed()) return;
    const contents = view.webContents;
    if (action === "reload") {
      if (!allowed()) throw new Error("电脑操作权限已关闭");
      contents.reload();
    } else if (action === "back" && contents.navigationHistory.canGoBack())
      contents.navigationHistory.goBack();
    else if (action === "forward" && contents.navigationHistory.canGoForward())
      contents.navigationHistory.goForward();
    else if (action === "stop") contents.stop();
    else if (action === "mute") {
      contents.setAudioMuted(!contents.isAudioMuted());
      send({ muted: contents.isAudioMuted() });
    } else if (action === "suspend") {
      contents.stop();
      contents.setAudioMuted(true);
      visible = false;
      layout();
    }
  }
  window.on("resize", layout);
  window.on("show", layout);
  window.on("hide", layout);
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    navigation++;
    window.removeListener("resize", layout);
    window.removeListener("show", layout);
    window.removeListener("hide", layout);
    for (const cancel of pending) cancel();
    pending.clear();
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    view = null;
  }
  window.on("closed", destroy);
  return { open, read, act, control, setLayout, destroy };
}
module.exports = { createWebPanel, publicURL };
