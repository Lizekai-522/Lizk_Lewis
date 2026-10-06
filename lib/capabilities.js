"use strict";
const { readSettings, writeSettings } = require("./secret-codec");
const fs = require("node:fs");
const path = require("node:path");
class Capabilities {
  constructor(directory) {
    this.file = path.join(directory, "capabilities.json");
    // 用户已明确授权微信读写；提供独立开关，并保留随后保存的关闭状态。
    this.value = { web: true, computer: true, wechat: true };
    const saved = readSettings(this.file, this.value);
    for (const key of Object.keys(this.value))
      if (typeof saved[key] === "boolean") this.value[key] = saved[key];
  }
  set(value) {
    if (
      !value ||
      ["web", "computer"].some((key) => typeof value[key] !== "boolean")
    )
      throw new Error("权限设置必须包含 web、computer 布尔值");
    if (value.wechat !== undefined && typeof value.wechat !== "boolean")
      throw new Error("微信权限必须是布尔值");
    const next = {
      web: value.web,
      computer: value.computer,
      wechat: value.wechat ?? this.value.wechat,
    };
    writeSettings(this.file, next);
    this.value = next;
    return { ...this.value };
  }
  require(name) {
    if (!this.value[name])
      throw new Error(
        `已关闭${name === "web" ? "联网" : name === "wechat" ? "微信" : "电脑操作"}权限，请在设置中开启`,
      );
  }
}
module.exports = { Capabilities };
