"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { spawn } = require("node:child_process");
function createDafeiyuPet({ app, onTask, onOpen, onUnavailable }) {
  let child,
    ready = false,
    starting,
    timer;
  const root = app.isPackaged
    ? path.join(process.resourcesPath, "dafeiyu")
    : __dirname.includes("app.asar")
      ? path.resolve(__dirname, "../..", "dafeiyu")
      : path.join(__dirname, "..");
  const candidates = [
    process.env.LEWIS_PET_PYTHON,
    process.env.LOCALAPPDATA &&
      path.join(
        process.env.LOCALAPPDATA,
        "Lewis",
        "pet-runtime",
        "Scripts",
        "python.exe",
      ),
    path.join(
      app.getPath("home"),
      "lewis",
      ".pet-venv",
      "Scripts",
      "python.exe",
    ),
    path.join(root, ".pet-venv", "Scripts", "python.exe"),
  ].filter(Boolean);
  const python = candidates.find((file) => fs.existsSync(file));
  function send(data) {
    if (child?.stdin.writable) child.stdin.write(JSON.stringify(data) + "\n");
  }
  function start() {
    if (ready) return Promise.resolve(true);
    if (starting) return starting;
    if (!python) return Promise.resolve(false);
    starting = new Promise((resolve) => {
      const settle = (result) => {
        clearTimeout(timer);
        starting = null;
        resolve(result);
      };
      child = spawn(
        python,
        ["-u", path.join(root, "pet-service", "bridge.py")],
        {
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            PYTHONIOENCODING: "utf-8",
            LEWIS_PET_DATA: path.join(app.getPath("userData"), "dafeiyu"),
          },
        },
      );
      let buffer = "";
      timer = setTimeout(() => {
        child?.kill();
        settle(false);
      }, 20000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > 64000) {
          child?.kill();
          return;
        }
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("LEWIS_PET ")) continue;
          try {
            const data = JSON.parse(line.slice(10));
            if (data.type === "ready") {
              ready = true;
              settle(true);
            } else if (
              data.type === "task" &&
              typeof data.text === "string" &&
              data.text.length <= 2000
            )
              onTask(data.text);
            else if (data.type === "open-main") onOpen();
          } catch {}
        }
      });
      child.stdin.on("error", () => {});
      child.stderr.resume();
      child.once("error", () => settle(false));
      child.once("exit", () => {
        const wasReady = ready;
        ready = false;
        child = null;
        settle(false);
        if (wasReady) onUnavailable?.();
      });
    });
    return starting;
  }
  return {
    start,
    send,
    active: () => ready,
    stop: () => {
      send({ type: "shutdown" });
      const current = child;
      setTimeout(() => {
        if (current && current.exitCode === null) current.kill();
      }, 1500).unref();
    },
  };
}
module.exports = { createDafeiyuPet };
