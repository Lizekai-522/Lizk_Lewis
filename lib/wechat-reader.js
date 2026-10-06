"use strict";
const { readSettings, writeSettings } = require("./secret-codec");
// 对接 TraceMemo 的公开 Reader API；这里不访问它的发送、定时任务或数据库密钥接口。
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { createHash } = require("node:crypto");
function localBase(value) {
  const url = new URL(value || "http://127.0.0.1:6131");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/api/v1", "/api/v1/"].includes(url.pathname)
  )
    throw new Error("微信数据服务请填写本机地址，例如 http://127.0.0.1:6131");
  return url.origin;
}
function cleanMessage(item) {
  // 仅向模型提供消息事实，丢弃原始 XML、密钥、头像地址和磁盘路径。
  const type = String(item.type || "未知");
  const readable = /^(文本|文字|text|引用|系统|链接)$/i.test(type);
  return {
    id: String(item.serverId || item.id || item.localId || ""),
    timestamp: Number(item.createTime || 0),
    datetime: String(item.datetime || ""),
    sender: String(
      item.name || item.senderId || (item.isSender ? "我" : "对方"),
    ).slice(0, 100),
    fromSelf: Boolean(item.isSender),
    type,
    text: readable ? String(item.content || "").slice(0, 4000) : "",
    transcript:
      typeof item.voiceTranscript === "string"
        ? item.voiceTranscript.slice(0, 4000)
        : "",
    media:
      item.media?.type === "image" &&
      /^\/api\/v1\/media\/[^/?#]+$/.test(item.media.url || "")
        ? {
            type: "image",
            url: item.media.url,
            available: Boolean(item.media.available),
          }
        : undefined,
    contentStatus: readable
      ? "text"
      : item.voiceTranscript
        ? "transcript"
        : item.media?.type === "image"
          ? "image-needs-fetch"
          : "content-unavailable",
  };
}
function messageKey(talker, item) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        talker,
        item.id,
        item.timestamp,
        item.sender,
        item.type,
        item.text,
        item.transcript,
      ]),
    )
    .digest("hex");
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(value));
  fs.renameSync(file + ".tmp", file);
}
class WechatReader extends EventEmitter {
  constructor(
    directory,
    {
      fetchImpl = fetch,
      allowed = () => true,
      analyze,
      describeImage,
      now = Date.now,
    } = {},
  ) {
    super();
    this.file = path.join(directory, "wechat-reader.json");
    this.stateFile = path.join(directory, "wechat-monitor.json");
    this.fetch = fetchImpl;
    this.allowed = allowed;
    this.analyze = analyze;
    this.describeImage = describeImage;
    this.now = now;
    this.config = {
      baseUrl: "http://127.0.0.1:6131",
      token: "",
      monitor: true,
      autoAnalyze: true,
    };
    Object.assign(this.config, readSettings(this.file, this.config));
    this.state = {
      startedAt: Math.floor(now() / 1000),
      cursors: {},
      seen: [],
      pending: [],
      analyses: [],
    };
    if (fs.existsSync(this.stateFile))
      Object.assign(
        this.state,
        JSON.parse(fs.readFileSync(this.stateFile, "utf8")),
      );
    this.status = {
      connected: false,
      error: "",
      scanned: 0,
      contacts: 0,
      lastPoll: null,
    };
    this.settings = {};
    this.index = 0;
  }
  configured() {
    return Boolean(this.config.token);
  }
  publicConfig() {
    return {
      ...this.config,
      token: undefined,
      hasToken: this.configured(),
      scope: "本机数据库中可读取的历史及新消息",
      ...this.status,
      pending: this.state.pending.length,
      analyses: this.state.analyses.slice(-10),
      mediaSupport: { image: true, voice: "仅后端提供的转写文字", file: false },
    };
  }
  configure(value) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.monitor !== "boolean" ||
      typeof value.autoAnalyze !== "boolean"
    )
      throw new Error("微信监听设置无效");
    const token =
      value.token === undefined || value.token === ""
        ? this.config.token
        : value.token;
    if (typeof token !== "string" || !/^[\x21-\x7e]{0,512}$/.test(token))
      throw new Error("微信 Token 应从 TraceMemo API Center 复制");
    const baseUrl = localBase(value.baseUrl);
    if (baseUrl !== this.config.baseUrl || token !== this.config.token) {
      // 更换账号/服务时清理游标与待分析项，不能把两个账号的数据混起来。
      this.controller?.abort();
      this.state = {
        startedAt: Math.floor(this.now() / 1000),
        cursors: {},
        seen: [],
        pending: [],
        analyses: [],
      };
      atomic(this.stateFile, this.state);
      this.index = 0;
    }
    this.config = {
      baseUrl,
      token,
      monitor: value.monitor,
      autoAnalyze: value.autoAnalyze,
    };
    if (!value.monitor || !value.autoAnalyze) this.controller?.abort();
    writeSettings(this.file, this.config);
    return this.publicConfig();
  }
  require() {
    if (!this.allowed()) throw new Error("微信权限已关闭");
    if (!this.configured())
      throw new Error(
        "请先连接 TraceMemo 数据库，并在 Lewis 微信后台读取设置中填写 API Token",
      );
  }
  async request(
    endpoint,
    params = {},
    { image = false, publicHealth = false, signal } = {},
  ) {
    if (!publicHealth) this.require();
    const url = new URL(endpoint, localBase(this.config.baseUrl));
    if (
      url.origin !== localBase(this.config.baseUrl) ||
      !/^\/api\/v1\/(?:health|contact|resolve|chatlog|media\/[^/?#]+)$/.test(
        url.pathname,
      )
    )
      throw new Error("微信数据接口不在读取列表中");
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && value !== "")
        url.searchParams.set(key, String(value));
    let response;
    try {
      response = await this.fetch(url.href, {
        redirect: "error",
        headers: publicHealth
          ? {}
          : { Authorization: `Bearer ${this.config.token}` },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      });
    } catch {
      if (signal?.aborted) throw new Error("微信读取已停止");
      throw new Error("无法连接本机微信数据服务，请启动 TraceMemo 的 API 服务");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 401
          ? "微信 Token 无效，请从 TraceMemo API Center 复制最新 Token"
          : response.status === 503
            ? "TraceMemo 尚未连接微信数据库"
            : `微信数据服务返回 HTTP ${response.status}`,
      );
    }
    const limit = image ? 5 * 1024 * 1024 : 8 * 1024 * 1024;
    const parts = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) {
        await response.body.cancel().catch(() => {});
        throw new Error("微信结果过大，请缩小日期范围");
      }
      parts.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(parts);
    if (image) {
      const mime = (response.headers.get("content-type") || "").split(";")[0];
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8,
        png = bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (!((mime === "image/jpeg" && jpeg) || (mime === "image/png" && png)))
        throw new Error("微信图片接口没有返回有效 JPEG/PNG");
      return `data:${mime};base64,${bytes.toString("base64")}`;
    }
    if (!/application\/json/i.test(response.headers.get("content-type") || ""))
      throw new Error("微信数据服务未返回 JSON，请检查端口和地址");
    try {
      return JSON.parse(bytes);
    } catch {
      throw new Error("微信数据服务 JSON 无效");
    }
  }
  async health(signal) {
    const data = await this.request(
      "/api/v1/health",
      {},
      { publicHealth: true, signal },
    );
    if (data.ready !== true) throw new Error("TraceMemo 尚未连接微信数据库");
    return { ready: true, service: String(data.service || "TraceMemo") };
  }
  async contacts(signal) {
    const data = await this.request("/api/v1/contact", {}, { signal });
    if (!Array.isArray(data.contacts)) throw new Error("微信联系人响应无效");
    return data.contacts
      .map((c) => ({
        id: String(c.m_nsUsrName || c.md5 || ""),
        name: String(c.remark || c.m_nsNickName || c.m_nsUsrName || ""),
        type: c.type,
      }))
      .filter((c) => c.id);
  }
  async history(
    talker,
    { startTime, endTime, signal, limit = 80, knownContacts } = {},
  ) {
    if (typeof talker !== "string" || !talker.trim() || talker.length > 200)
      throw new Error("请指定微信联系人或群聊");
    for (const time of [startTime, endTime])
      if (time !== undefined && (!Number.isInteger(time) || time < 0))
        throw new Error("时间应为 Unix 秒级时间戳");
    if (startTime !== undefined && endTime !== undefined && startTime > endTime)
      throw new Error("开始时间不能晚于结束时间");
    const contacts = knownContacts || (await this.contacts(signal));
    const exact = contacts.filter((c) => c.id === talker || c.name === talker);
    if (exact.length !== 1)
      throw new Error(
        exact.length
          ? "微信名称对应多个会话，请使用联系人列表中的唯一标识"
          : "没有找到准确匹配的微信会话，请先查询联系人列表",
      );
    const data = await this.request(
      "/api/v1/chatlog",
      { talker: exact[0].id, startTime, endTime },
      { signal },
    );
    if (!Array.isArray(data.messages)) throw new Error("微信聊天响应无效");
    const all = data.messages
      .map(cleanMessage)
      .sort((a, b) => a.timestamp - b.timestamp);
    const messages = all.slice(-limit);
    return {
      text:
        `读取 ${String(data.contact?.m_nsNickName || talker)} 的数据库历史：本次范围 ${all.length} 条，返回最近 ${Math.min(limit, all.length)} 条。图片需另行读取；语音和文件缺少内容时仅报告类型。\n` +
        messages
          .slice(-20)
          .map(
            (m) =>
              `${m.datetime} ${m.sender} [${m.type}] ${m.text || m.transcript || "内容不可读"}`,
          )
          .join("\n")
          .slice(0, 4500),
      source: "TraceMemo 本机数据库",
      count: all.length,
      truncated: all.length > limit,
      messages,
    };
  }
  async image(url, signal) {
    return this.request(url, {}, { image: true, signal });
  }
  async describe(
    url,
    question,
    { signal = new AbortController().signal, settings = this.settings } = {},
  ) {
    this.require();
    if (
      typeof question !== "string" ||
      question.length > 500 ||
      !this.describeImage
    )
      throw new Error("请提供500字符内的图片问题，并配置视觉模型");
    return {
      text: await this.describeImage({ url, question }, settings, this, signal),
      source: "微信原图 + 已配置视觉模型",
    };
  }
  async tick() {
    if (
      this.running ||
      !this.configured() ||
      !this.config.monitor ||
      !this.allowed()
    )
      return;
    this.running = true;
    const controller = new AbortController();
    this.controller = controller;
    const check = () => {
      if (controller.signal.aborted || !this.allowed() || !this.config.monitor)
        throw new Error("微信监听已暂停");
    };
    try {
      await this.health(controller.signal);
      check();
      const contacts = await this.contacts(controller.signal);
      check();
      this.status.contacts = contacts.length;
      const seen = new Set(this.state.seen);
      // 每轮最多扫 8 个会话，轮询覆盖全部会话，不占用或切换微信窗口。
      for (let scanned = 0; scanned < Math.min(8, contacts.length); scanned++) {
        const contact = contacts[this.index++ % contacts.length];
        const end = Math.floor(this.now() / 1000),
          start = this.state.cursors[contact.id] ?? this.state.startedAt;
        const history = await this.history(contact.id, {
          startTime: Math.max(0, start - 120),
          endTime: end,
          limit: 100000,
          signal: controller.signal,
          knownContacts: contacts,
        });
        check();
        const fresh = history.messages.filter((item) => {
          const key = messageKey(contact.id, item);
          if (item.timestamp < this.state.startedAt || seen.has(key))
            return false;
          seen.add(key);
          this.state.seen.push(key);
          return true;
        });
        if (fresh.length) {
          this.state.pending.push({ contact, messages: fresh, at: this.now() });
          this.emit("update", {
            type: "messages",
            contact: contact.name,
            count: fresh.length,
            at: this.now(),
          });
        }
        // 先持久化待处理消息再推进游标；模型失败不丢掉消息，也不会再次发送。
        this.state.cursors[contact.id] = end;
        this.state.seen = this.state.seen.slice(-100000);
        atomic(this.stateFile, this.state);
        this.status.scanned++;
      }
      this.status.connected = true;
      this.status.lastPoll = this.now();
      this.status.error = "";
      if (
        this.config.autoAnalyze &&
        this.analyze &&
        this.state.pending.length
      ) {
        check();
        const batch = this.state.pending[0];
        const messages = batch.messages.slice(0, 5);
        const text = await this.analyze(
          { contact: batch.contact, messages },
          this.settings,
          this,
          controller.signal,
        );
        check();
        if (!this.config.autoAnalyze) throw new Error("自动分析已暂停");
        this.emit("update", {
          type: "analysis",
          contact: batch.contact.name,
          at: this.now(),
          text,
        });
        this.state.analyses.push({
          contact: batch.contact.name,
          at: this.now(),
          text,
        });
        this.state.analyses = this.state.analyses.slice(-50);
        batch.messages.splice(0, messages.length);
        if (!batch.messages.length) this.state.pending.shift();
        atomic(this.stateFile, this.state);
      }
    } catch (error) {
      this.status.error = error.message;
      this.status.connected = false;
    } finally {
      if (this.controller === controller) this.controller = null;
      this.running = false;
    }
  }
  start() {
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), 10000);
      this.timer.unref();
    }
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
  }
}
module.exports = { WechatReader, localBase, cleanMessage, messageKey };
