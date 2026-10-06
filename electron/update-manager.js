"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const semver = require("semver");
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;
function createUpdateManager({
  app,
  updater,
  directory,
  portable = false,
  notify = () => {},
  logger,
  launch = runInstaller,
}) {
  const file = path.join(directory, "update-config.json");
  const cache = path.join(directory, "update-installers");
  fs.mkdirSync(cache, { recursive: true });
  let config = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { url: "", channel: "stable", autoCheck: true };
  let state = {
    phase: "idle",
    version: app.getVersion(),
    supported: Boolean(app.isPackaged && !portable),
    configured: Boolean(config.url),
  };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  const publish = (values) => {
    state = { ...state, ...values };
    notify(state);
  };
  const bind = () => {
    if (config.url)
      updater.setFeedURL({ provider: "generic", url: config.url });
    updater.channel = config.channel === "beta" ? "beta" : "latest";
    updater.allowPrerelease = config.channel === "beta";
  };
  bind();
  updater.on("error", (error) => {
    logger?.write("error", "更新失败", { message: error.message });
    publish({ phase: "error", error: error.message });
  });
  updater.on("checking-for-update", () =>
    publish({ phase: "checking", error: "" }),
  );
  updater.on("update-not-available", () => publish({ phase: "current" }));
  updater.on("update-available", (info) =>
    publish({
      phase: "available",
      nextVersion: info.version,
      notes:
        typeof info.releaseNotes === "string"
          ? info.releaseNotes
          : JSON.stringify(info.releaseNotes || []),
    }),
  );
  updater.on("download-progress", (progress) =>
    publish({ phase: "downloading", percent: Math.round(progress.percent) }),
  );
  updater.on("update-downloaded", (info) => {
    try {
      if (
        !versionPattern.test(info.version) ||
        typeof info.downloadedFile !== "string"
      )
        throw Error("更新缓存信息无效");
      const target = path.join(cache, info.version + ".exe");
      fs.copyFileSync(info.downloadedFile, target);
      const sha512 = createHash("sha512")
        .update(fs.readFileSync(target))
        .digest("base64");
      fs.writeFileSync(
        path.join(cache, info.version + ".json"),
        JSON.stringify({ version: info.version, sha512, at: Date.now() }),
      );
      publish({ phase: "ready", nextVersion: info.version });
    } catch (error) {
      publish({ phase: "error", error: error.message });
    }
  });
  const requireSupport = () => {
    if (!state.supported)
      throw Error("自动安装仅支持安装版；便携版请使用新版安装包");
    if (!config.url)
      throw Error("尚未配置发布源，请填入实际发布服务器的 HTTPS 地址");
  };
  function listRollbacks() {
    return fs
      .readdirSync(cache)
      .filter((name) => name.endsWith(".json"))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(cache, name), "utf8")),
      )
      .filter(
        (item) =>
          versionPattern.test(item.version) &&
          semver.lt(item.version, app.getVersion()),
      )
      .sort((a, b) => b.at - a.at)
      .map((item) => ({ version: item.version, at: item.at }));
  }
  async function action(kind, value) {
    if (kind === "status")
      return { ...state, config, rollbacks: listRollbacks() };
    if (kind === "configure") {
      if (
        !["stable", "beta"].includes(value?.channel) ||
        typeof value.autoCheck !== "boolean"
      )
        throw Error("更新通道设置无效");
      if (value.url) {
        const url = new URL(value.url);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw Error("发布源须为完整 HTTPS 目录地址");
      }
      config = {
        url: value.url || "",
        channel: value.channel,
        autoCheck: value.autoCheck,
      };
      fs.writeFileSync(file, JSON.stringify(config));
      bind();
      publish({ configured: Boolean(config.url) });
      return action("status");
    }
    requireSupport();
    if (kind === "check") {
      await updater.checkForUpdates();
      return action("status");
    }
    if (kind === "download") {
      if (state.phase !== "available") throw Error("请先检查新版本");
      await updater.downloadUpdate();
      return action("status");
    }
    if (kind === "install") {
      if (state.phase !== "ready") throw Error("更新尚未下载");
      updater.quitAndInstall(false, true);
      return { installing: true };
    }
    if (kind === "rollback") {
      if (
        !versionPattern.test(value?.version) ||
        !semver.lt(value.version, app.getVersion())
      )
        throw Error("请选择比当前版本更旧的缓存版本");
      const target = path.join(cache, value.version + ".exe");
      const record = JSON.parse(
        fs.readFileSync(path.join(cache, value.version + ".json"), "utf8"),
      );
      const hash = createHash("sha512")
        .update(fs.readFileSync(target))
        .digest("base64");
      if (hash !== record.sha512) throw Error("旧安装包校验失败，未执行");
      await launch(target);
      app.quit();
      return { installing: true };
    }
    throw Error("未知更新动作");
  }
  if (state.supported && config.url && config.autoCheck) {
    const timer = setTimeout(
      () =>
        action("check").catch((error) =>
          publish({ phase: "error", error: error.message }),
        ),
      30000,
    );
    timer.unref();
  }
  return { action };
}
function runInstaller(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [], {
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
module.exports = { createUpdateManager };
