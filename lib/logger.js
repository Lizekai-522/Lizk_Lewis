"use strict";
const fs = require("node:fs");
const path = require("node:path");
function redact(value) {
  return String(value)
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(
      /(api[_-]?key|(?:access[_-]?)?token|secret|password)(["'\s:=]+)[^\s,;}]+/gi,
      "$1$2[redacted]",
    )
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .slice(0, 8000);
}
class Logger {
  constructor(
    directory,
    { maxBytes = 1024 * 1024, keep = 4, level = "info" } = {},
  ) {
    this.directory = directory;
    this.file = path.join(directory, "lewis.log");
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.level = level;
    fs.mkdirSync(directory, { recursive: true });
  }
  write(level, message, details) {
    const ranks = { debug: 0, info: 1, warn: 2, error: 3 };
    if (!(level in ranks) || ranks[level] < ranks[this.level]) return;
    const entry = {
      at: new Date().toISOString(),
      level,
      message: redact(message),
      ...(details
        ? {
            details: JSON.parse(
              JSON.stringify(details, (key, value) =>
                /key|token|secret|password|authorization/i.test(key)
                  ? "[redacted]"
                  : typeof value === "string"
                    ? redact(value)
                    : value,
              ),
            ),
          }
        : {}),
    };
    const line = JSON.stringify(entry) + "\n";
    if (
      fs.existsSync(this.file) &&
      fs.statSync(this.file).size + Buffer.byteLength(line) > this.maxBytes
    ) {
      for (let index = this.keep; index >= 1; index--) {
        const old = index === 1 ? this.file : this.file + "." + (index - 1);
        const target = this.file + "." + index;
        if (fs.existsSync(target)) fs.unlinkSync(target);
        if (fs.existsSync(old)) fs.renameSync(old, target);
      }
    }
    fs.appendFileSync(this.file, line);
  }
  tail(maxBytes = 256 * 1024) {
    if (!fs.existsSync(this.file)) return "";
    const data = fs.readFileSync(this.file);
    return redact(
      data.subarray(Math.max(0, data.length - maxBytes)).toString("utf8"),
    );
  }
  install() {
    const exception = (error) =>
      this.write("error", "uncaughtException", {
        message: error.message,
        stack: error.stack,
      });
    process.on("uncaughtExceptionMonitor", exception);
    return () => process.off("uncaughtExceptionMonitor", exception);
  }
}
module.exports = { Logger, redact };
