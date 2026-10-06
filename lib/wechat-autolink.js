"use strict";
// Built-in connection discovery, read-only. Sending stays in the serialized task service.
class WechatAutoLink {
  constructor({
    service,
    reader,
    allowed,
    platform = process.platform,
    interval = 10000,
  }) {
    Object.assign(this, { service, reader, allowed, platform, interval });
    this.state = { running: false, connected: false, checkedAt: null };
  }
  snapshot() {
    const allowed = this.allowed(),
      reader = this.reader.publicConfig();
    const connected = allowed && this.state.connected;
    const background = allowed && reader.hasToken && reader.connected;
    return {
      ...this.state,
      connected,
      allowed,
      builtin: true,
      autoReply: false,
      mode: !allowed
        ? "disabled"
        : background
          ? "background"
          : connected
            ? "screen"
            : "waiting",
      monitoring: Boolean(background && reader.monitor),
      analyzing: Boolean(background && reader.monitor && reader.autoAnalyze),
      text: !allowed
        ? "微信权限已关闭"
        : background
          ? "微信后台已连接 · 自动读取与分析"
          : connected
            ? "微信已连接 · 语音任务可用"
            : this.state.running
              ? "等待微信登录或主窗口"
              : "等待打开电脑微信",
      readScope: background
        ? "已连接数据服务中可读取的新消息"
        : "当前界面可见消息",
    };
  }
  async tick() {
    if (this.pending) return this.pending;
    if (!this.allowed() || this.platform !== "win32") return this.snapshot();
    this.controller = new AbortController();
    this.pending = (async () => {
      try {
        const result = await Promise.resolve().then(() =>
          this.service.execute(
            { action: "connection" },
            { signal: this.controller.signal },
          ),
        );
        this.state = {
          running: Boolean(result.running),
          connected: Boolean(result.connected),
          checkedAt: Date.now(),
        };
      } catch {
        this.state = {
          running: false,
          connected: false,
          checkedAt: Date.now(),
        };
      } finally {
        this.pending = null;
      }
      return this.snapshot();
    })();
    return this.pending;
  }
  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.interval);
    this.timer.unref?.();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
  }
}
module.exports = { WechatAutoLink };
