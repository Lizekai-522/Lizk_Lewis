"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const os = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
function resource(name) {
  return [
    process.resourcesPath && path.join(process.resourcesPath, "native", name),
    path.join(__dirname, "../native", name),
  ]
    .filter(Boolean)
    .find((file) => fs.existsSync(file));
}
function runJSON(executable, args, input, { signal, timeout = 20000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => {
      child.kill();
      finish(Error("桌面操作已取消"));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(Error("应用响应较慢，本次操作未完成，请稍后再试"));
    }, timeout);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 8000000) {
        child.kill();
        finish(Error("应用信息过多，请缩小查询范围"));
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () =>
      finish(Error("桌面操作组件未能启动，请重启 Lewis")),
    );
    child.once("close", (code) => {
      if (done) return;
      try {
        if (code !== 0) throw Error("应用检测没有完成，请重试");
        const result = JSON.parse(output.replace(/^\uFEFF/, "").trim());
        if (result.ok === false) {
          const error = Error(result.error);
          error.details = result.details;
          throw error;
        }
        finish(null, result);
      } catch (error) {
        finish(error);
      }
    });
    child.stdin.end(input ? JSON.stringify(input) : "");
  });
}
function normalized(value) {
  return String(value)
    .toLowerCase()
    .replace(/[\s·._-]/g, "")
    .replace(/(?:电脑版|客户端|desktop|application)$/i, "");
}
const aliases = {
  qq音乐: "qqmusic",
  qqmusic: "qqmusic",
  qq: "qq",
  网易云音乐: "cloudmusic",
  网易云: "cloudmusic",
  微信: "wechat",
  weixin: "wechat",
};
const blocked =
  /^(?:cmd|powershell|pwsh|wscript|cscript|rundll32|mshta|regedit|uninstall|unins\d*)\.exe$/i;
class DesktopApps {
  constructor({ discover, runner, wait = delay, now = Date.now } = {}) {
    this.discover =
      discover ||
      (() => {
        const script = resource("list-apps.ps1");
        if (!script) throw Error("应用检测组件缺失，请更新 Lewis");
        return runJSON(
          path.join(
            process.env.SystemRoot || "C:/Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
          ),
          ["-NoProfile", "-NonInteractive", "-File", script],
          null,
        );
      });
    this.runner =
      runner ||
      ((request, options) => {
        const executable = resource("DesktopBridge.exe");
        if (!executable) throw Error("桌面操作组件缺失，请更新 Lewis");
        return runJSON(executable, [], request, options);
      });
    this.wait = wait;
    this.now = now;
    this.entries = [];
    this.loadedAt = 0;
    this.loading = null;
    this.snapshots = new Map();
    this.pending = Promise.resolve();
  }
  async catalog(seeds = {}) {
    if (!this.loadedAt || this.now() - this.loadedAt > 60000) {
      if (!this.loading)
        this.loading = Promise.resolve()
          .then(() => this.discover())
          .then((items) => {
            const entries = [];
            for (const item of items) {
              if (
                !item?.name ||
                item.name.length > 120 ||
                (!item.appId && !item.executable)
              )
                continue;
              if (
                item.executable &&
                blocked.test(path.win32.basename(item.executable))
              )
                continue;
              const identity = (item.executable || item.appId).toLowerCase();
              const same = entries.find(
                (e) => (e.executable || e.appId).toLowerCase() === identity,
              );
              if (same) {
                same.names.push(item.name);
                continue;
              }
              entries.push({
                ...item,
                id:
                  "app_" +
                  createHash("sha256")
                    .update(identity)
                    .digest("hex")
                    .slice(0, 16),
                names: [item.name],
              });
            }
            this.entries = entries;
            this.loadedAt = this.now();
          })
          .finally(() => {
            this.loading = null;
          });
      await this.loading;
    }
    const entries = this.entries.map((item) => ({
      ...item,
      names: [...item.names],
    }));
    for (const [id, item] of Object.entries(seeds)) {
      const executable = item.paths.find((file) => fs.existsSync(file));
      if (!executable) continue;
      const same = entries.find(
        (e) => e.executable?.toLowerCase() === executable.toLowerCase(),
      );
      if (same) same.names.push(id, item.name);
      else
        entries.push({
          id,
          name: item.name,
          names: [id, item.name],
          executable,
        });
    }
    return entries;
  }
  async resolve(name, seeds = {}) {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 120 ||
      /[\\/:<>|"\u0000-\u001f]/.test(name)
    )
      throw Error("请说出应用名称，例如 QQ 音乐或记事本");
    const entries = await this.catalog(seeds),
      key = normalized(name),
      alias = aliases[key] || key;
    const exact = entries.filter(
      (e) =>
        e.id === name ||
        e.names.some((n) => normalized(n) === key || normalized(n) === alias) ||
        (e.executable &&
          normalized(path.win32.basename(e.executable, ".exe")) === alias),
    );
    const matches = exact.length
      ? exact
      : entries.filter((e) => e.names.some((n) => normalized(n).includes(key)));
    if (matches.length !== 1)
      throw Error(
        matches.length
          ? `找到多个应用：${matches
              .slice(0, 5)
              .map((e) => e.name)
              .join("、")}，请说完整名称`
          : `没有找到已安装的“${name}”，请检查是否已安装或在开始菜单添加快捷方式`,
      );
    return matches[0];
  }
  async list(query = "", seeds = {}) {
    if (typeof query !== "string" || query.length > 120)
      throw Error("应用搜索名称过长");
    const entries = await this.catalog(seeds),
      key = normalized(query);
    const matches = entries.filter(
      (e) => !key || e.names.some((n) => normalized(n).includes(key)),
    );
    return {
      apps: matches.slice(0, 40).map((e) => ({ id: e.id, name: e.name })),
      total: matches.length,
      text: matches.length
        ? `找到 ${matches.length} 个已安装应用`
        : `没有找到“${query}”`,
    };
  }
  async open(name, { seeds, launchApp, signal, requireComputer } = {}) {
    requireComputer?.();
    signal?.throwIfAborted();
    const app = await this.resolve(name, seeds);
    requireComputer?.();
    signal?.throwIfAborted();
    if (app.appId)
      await launchApp(
        path.join(process.env.SystemRoot || "C:/Windows", "explorer.exe"),
        ["shell:AppsFolder\\" + app.appId],
      );
    else if (app.shortcut)
      await launchApp(
        path.join(process.env.SystemRoot || "C:/Windows", "explorer.exe"),
        [app.shortcut],
      );
    else await launchApp(app.executable, [], { visible: true });
    return { appId: app.id, name: app.name, text: `已启动${app.name}` };
  }
  serialize(task) {
    const result = this.pending.then(task);
    this.pending = result.catch(() => {});
    return result;
  }
  async read(name, { seeds, signal, ocr = false, requireComputer } = {}) {
    requireComputer?.();
    const app = await this.resolve(name, seeds);
    if (!app.executable) throw Error("这个商店应用暂不能读取窗口，已支持打开");
    const result = await this.runner(
      { action: "read", executable: app.executable, capture: ocr },
      { signal },
    );
    signal?.throwIfAborted();
    if (ocr && result.image) {
      result.controls.push(...(result.visualControls || []));
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lewis-app-")),
        file = path.join(directory, "window.png");
      try {
        fs.writeFileSync(file, Buffer.from(result.image, "base64"));
        const words = await runJSON(
          path.join(
            process.env.SystemRoot || "C:/Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
          ),
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            resource("desktop-ocr.ps1"),
            "-ImagePath",
            file,
          ],
          null,
          { signal },
        );
        for (const [i, c] of words.entries())
          result.controls.push({
            ...c,
            x: c.x + result.left,
            y: c.y + result.top,
            path: "ocr/" + i,
            source: "ocr",
            role: 41,
          });
      } finally {
        fs.unlinkSync(file);
        fs.rmdirSync(directory);
      }
    }
    requireComputer?.();
    const snapshotId = randomUUID(),
      targets = result.controls.map((c, i) => ({
        ref: String(i + 1),
        name: c.name || "输入框",
        role: c.role,
        source: c.source,
      }));
    this.snapshots.clear();
    this.snapshots.set(snapshotId, {
      app,
      at: this.now(),
      windowId: result.windowId,
      controls: result.controls,
    });
    return {
      appId: app.id,
      name: app.name,
      snapshotId,
      targets,
      text: result.controls
        .map((c) => c.name)
        .filter(Boolean)
        .join("\n")
        .slice(0, 9000),
    };
  }
  async action(
    { snapshotId, ref, kind, text, enter = false },
    { signal, requireComputer } = {},
  ) {
    requireComputer?.();
    const snapshot = this.snapshots.get(snapshotId),
      index = Number(ref) - 1;
    if (
      !snapshot ||
      this.now() - snapshot.at > 120000 ||
      !Number.isInteger(index) ||
      String(index + 1) !== String(ref) ||
      !snapshot.controls[index]
    )
      throw Error("应用界面快照已失效，请重新读取窗口");
    if (!["click", "double-click", "type"].includes(kind))
      throw Error("未知应用操作");
    if (
      kind === "type" &&
      (typeof text !== "string" ||
        text.length > 500 ||
        /[\u0000-\u001f]/.test(text))
    )
      throw Error("请输入500字以内的内容，不含控制字符");
    const control = snapshot.controls[index];
    this.snapshots.delete(snapshotId);
    const result = await this.runner(
      {
        action: kind,
        executable: snapshot.app.executable,
        windowId: snapshot.windowId,
        ...control,
        text,
        enter,
      },
      { signal },
    );
    return {
      ...result,
      text: kind === "type" ? "已在应用输入内容" : "已操作应用控件",
    };
  }
}
const desktopApps = new DesktopApps();
module.exports = { DesktopApps, desktopApps, runJSON, normalized };
