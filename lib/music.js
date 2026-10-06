"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { runJSON, desktopApps } = require("./desktop-apps");
const { setTimeout: delay } = require("node:timers/promises");
function mediaSession(action = "read", options = {}) {
  options.requireComputer?.();
  const script = [
    process.resourcesPath &&
      path.join(process.resourcesPath, "native/music-session.ps1"),
    path.join(__dirname, "../native/music-session.ps1"),
  ]
    .filter(Boolean)
    .find((file) => fs.existsSync(file));
  if (!script) throw Error("音乐控制组件缺失，请更新 Lewis");
  return runJSON(
    path.join(
      process.env.SystemRoot || "C:/Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-File", script, "-Action", action],
    null,
    options,
  );
}
class MusicService {
  constructor({
    desktop = desktopApps,
    media = mediaSession,
    wait = delay,
  } = {}) {
    this.desktop = desktop;
    this.media = media;
    this.wait = wait;
  }
  async ready(options) {
    for (let attempt = 0; attempt < 8; attempt++) {
      options.signal?.throwIfAborted();
      try {
        const snapshot = await this.desktop.read("qqmusic", options);
        if (snapshot.targets.length) return snapshot;
      } catch (error) {
        if (!/窗口还没准备好/.test(error.message)) throw error;
      }
      await this.wait(700, undefined, { signal: options.signal });
    }
    throw Error("QQ音乐窗口还没准备好，请稍后再试");
  }
  async click(snapshot, target, options, kind = "click") {
    return this.desktop.action(
      { snapshotId: snapshot.snapshotId, ref: target.ref, kind },
      options,
    );
  }
  recommendationTarget(snapshot) {
    const label = snapshot.targets.find(
      (t) =>
        t.source === "ocr" && /猜你喜欢|[猜猎].*喜欢|沉浸刷歌/.test(t.name),
    );
    if (!label) return null;
    const state = this.desktop.snapshots.get(snapshot.snapshotId),
      anchor = state.controls[Number(label.ref) - 1];
    return snapshot.targets
      .filter((t) => t.name === "图像播放按钮")
      .find((t) => {
        const button = state.controls[Number(t.ref) - 1];
        return (
          button.x >= anchor.x - 15 &&
          button.x <= anchor.x + anchor.width + 200 &&
          button.y < anchor.y &&
          button.y > anchor.y - 300
        );
      });
  }
  async ensureRandom(options) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = await this.desktop.read("qqmusic", options);
      const mode = snapshot.targets.find(
        (t) =>
          t.role === 43 &&
          /^(?:随机播放|雷达播放|列表循环|顺序播放|单曲循环)$/.test(t.name),
      );
      if (!mode) {
        if (attempt === 3) return false;
        await this.wait(500, undefined, { signal: options.signal });
        continue;
      }
      if (mode.name === "随机播放" || mode.name === "雷达播放") return true;
      if (attempt === 3) return false;
      await this.click(snapshot, mode, options);
    }
    return false;
  }
  async play(query = "", options = {}) {
    if (
      typeof query !== "string" ||
      query.length > 100 ||
      /[\u0000-\u001f]/.test(query)
    )
      throw Error("请说出100字以内的歌曲或歌手名称");
    await this.desktop.open("qqmusic", options);
    let snapshot = await this.ready(options);
    const before = await this.media("read", options);
    if (!query.trim()) {
      const recommend =
        snapshot.targets.find((t) => t.name === "推荐" && t.role === 16) ||
        snapshot.targets.find((t) => t.name === "推荐");
      if (!recommend)
        throw Error("QQ音乐推荐入口暂时没有显示，请先关闭软件里的弹窗后再试");
      await this.click(snapshot, recommend, options);
      let recommendation;
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.wait(1200, undefined, { signal: options.signal });
        snapshot = await this.desktop.read("qqmusic", {
          ...options,
          ocr: true,
        });
        recommendation = this.recommendationTarget(snapshot);
        if (recommendation) break;
      }
      if (!recommendation)
        throw Error("QQ音乐推荐内容尚未加载出来，请检查网络或登录后再试");
      for (let attempt = 0; ; attempt++) {
        try {
          await this.click(snapshot, recommendation, options);
          break;
        } catch (error) {
          if (attempt >= 2 || !/应用(?:内容|界面)已变化/.test(error.message))
            throw error;
          snapshot = await this.desktop.read("qqmusic", {
            ...options,
            ocr: true,
          });
          recommendation = this.recommendationTarget(snapshot);
          if (!recommendation)
            throw Error("QQ音乐推荐页变化了，请等内容加载后再试");
        }
      }
    } else {
      const state = this.desktop.snapshots.get(snapshot.snapshotId);
      // The global search field is the uppermost accessible edit, not a hidden playlist search.
      const search = snapshot.targets
        .filter((t) => t.role === 42)
        .sort(
          (a, b) =>
            state.controls[Number(a.ref) - 1].y -
            state.controls[Number(b.ref) - 1].y,
        )[0];
      if (!search)
        throw Error("QQ音乐搜索框没有显示，请先关闭软件里的弹窗后再试");
      await this.desktop.action(
        {
          snapshotId: snapshot.snapshotId,
          ref: search.ref,
          kind: "type",
          text: query.trim(),
          enter: true,
        },
        options,
      );
      await this.wait(1800, undefined, { signal: options.signal });
      snapshot = await this.desktop.read("qqmusic", { ...options, ocr: true });
      const raw = this.desktop.snapshots.get(snapshot.snapshotId),
        key = query.replace(/[\s的《》“”"']/g, "").toLowerCase();
      const entry = snapshot.targets.find(
        (t) =>
          (t.source === "msaa" || t.source === "ocr") &&
          t.name
            .replace(/[\s《》“”"']/g, "")
            .toLowerCase()
            .includes(key) &&
          raw.controls[Number(t.ref) - 1].y >
            raw.controls.find((c) => c.role === 42)?.y + 80,
      );
      if (!entry)
        throw Error(
          `QQ音乐搜索结果里没有找到“${query}”的可播放条目，请换一个明确的歌曲名`,
        );
      await this.click(snapshot, entry, options, "double-click");
    }
    const random = query ? undefined : await this.ensureRandom(options);
    // A successful click is not a successful playback. Check the application's Windows media session.
    for (let attempt = 0; attempt < 10; attempt++) {
      await this.wait(600, undefined, { signal: options.signal });
      const result = await this.media("read", options);
      const changed =
        result.title !== before.title ||
        !before.playing ||
        result.position + 2 < before.position;
      const requestedTrack =
        !query ||
        `${result.title || ""}${result.artist || ""}`
          .replace(/[\s《》“”"']/g, "")
          .toLowerCase()
          .includes(query.replace(/[\s的《》“”"']/g, "").toLowerCase());
      if (
        result.available &&
        result.playing &&
        result.title &&
        changed &&
        requestedTrack
      )
        return {
          ...result,
          mode: query ? "search" : "recommend",
          random,
          text: `正在播放${query ? "" : "QQ音乐为你推荐的"}《${result.title}》${result.artist ? `，${result.artist}` : ""}`,
        };
    }
    throw Error(
      "QQ音乐已打开，但还没有确认开始播放；请检查是否需要登录、开通会员或关闭软件里的提示",
    );
  }
  async control(action, options = {}) {
    if (!["pause", "play", "next"].includes(action))
      throw Error("未知音乐操作");
    const before = await this.media("read", options);
    if (!before.available)
      throw Error("QQ音乐尚未开始播放，请先说“打开QQ音乐，我想听歌”");
    let result = await this.media(action, options);
    const accepted = result.accepted;
    if (action === "next" && accepted) {
      for (
        let attempt = 0;
        attempt < 4 && result.title === before.title;
        attempt++
      ) {
        await this.wait(500, undefined, { signal: options.signal });
        result = await this.media("read", options);
      }
    }
    if (
      !accepted ||
      (action === "pause"
        ? result.playing
        : action === "play" && !result.playing) ||
      (action === "next" && result.title === before.title)
    )
      throw Error("QQ音乐暂未确认这个操作，请查看音乐软件后再试");
    return {
      ...result,
      text:
        action === "pause"
          ? "已暂停QQ音乐"
          : `${result.playing ? "正在播放" : "已切换到"}《${result.title}》${result.artist ? `，${result.artist}` : ""}`,
    };
  }
}
const musicService = new MusicService();
module.exports = { MusicService, musicService, mediaSession };
