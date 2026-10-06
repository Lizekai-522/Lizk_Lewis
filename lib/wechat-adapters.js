"use strict";
const { readSettings, writeSettings } = require("./secret-codec");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

// Official accounts have their own recipient IDs. Never substitute them for personal WeChat chats.
class WechatAdapters {
  constructor(directory, { fetchImpl = fetch, now = Date.now } = {}) {
    this.file = path.join(directory, "wechat-adapters.json");
    this.fetch = fetchImpl;
    this.now = now;
    this.config = readSettings(this.file, {
      confirmSend: false,
      enterprise: {},
      publicAccount: {},
    });
    this.tokens = new Map();
    this.pending = new Map();
    this.sends = new Map();
  }
  publicConfig() {
    const redact = (value) => ({
      id: value.id || "",
      agentId: value.agentId || "",
      configured: Boolean(value.id && value.secret),
      hasSecret: Boolean(value.secret),
    });
    return {
      confirmSend: this.config.confirmSend,
      enterprise: redact(this.config.enterprise),
      publicAccount: redact(this.config.publicAccount),
      personal: {
        read: ["database", "screen"],
        send: "screen",
        notifications: "database-poll-to-sse",
      },
    };
  }
  configure(value) {
    if (typeof value?.confirmSend !== "boolean")
      throw new Error("发送确认设置无效");
    const config = { confirmSend: value.confirmSend };
    for (const name of ["enterprise", "publicAccount"]) {
      const item = value[name] || {};
      const old = this.config[name] || {};
      if (
        typeof item.id !== "string" ||
        !/^[A-Za-z0-9_-]{0,100}$/.test(item.id) ||
        (item.secret !== undefined &&
          (typeof item.secret !== "string" ||
            !/^[\x21-\x7e]{0,256}$/.test(item.secret)))
      )
        throw new Error("微信官方接口凭据格式无效");
      if (
        name === "enterprise" &&
        item.agentId &&
        !/^\d{1,12}$/.test(String(item.agentId))
      )
        throw new Error("企业微信 AgentId 应为数字");
      config[name] = {
        id: item.id,
        secret: item.secret || old.secret || "",
        ...(name === "enterprise"
          ? { agentId: String(item.agentId || "") }
          : {}),
      };
    }
    writeSettings(this.file, config);
    this.config = config;
    this.tokens.clear();
    return this.publicConfig();
  }
  async request(url, body, signal) {
    const response = await this.fetch(url, {
      method: body ? "POST" : "GET",
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
      redirect: "error",
      signal: AbortSignal.any([
        signal || new AbortController().signal,
        AbortSignal.timeout(20000),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("微信官方接口 HTTP " + response.status);
    }
    const text = await response.text();
    if (text.length > 500000) throw new Error("微信官方结果过大");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("微信官方接口返回非 JSON");
    }
    if (data.errcode)
      throw new Error(
        `微信官方接口错误 ${data.errcode}；请核对权限、账号及收件人 ID`,
      );
    return data;
  }
  async token(adapter, signal) {
    const cached = this.tokens.get(adapter);
    if (cached && cached.expires > this.now()) return cached.value;
    const item = this.config[adapter];
    if (!item?.id || !item.secret) throw new Error("请先配置该微信官方账号");
    const url = new URL(
      adapter === "enterprise"
        ? "https://qyapi.weixin.qq.com/cgi-bin/gettoken"
        : "https://api.weixin.qq.com/cgi-bin/token",
    );
    url.search = new URLSearchParams(
      adapter === "enterprise"
        ? { corpid: item.id, corpsecret: item.secret }
        : {
            grant_type: "client_credential",
            appid: item.id,
            secret: item.secret,
          },
    ).toString();
    const data = await this.request(url.href, null, signal);
    if (typeof data.access_token !== "string")
      throw new Error("微信没有返回有效 access_token");
    this.tokens.set(adapter, {
      value: data.access_token,
      expires:
        this.now() + Math.max(0, Number(data.expires_in || 7200) - 120) * 1000,
    });
    return data.access_token;
  }
  approve(request, confirmationId) {
    const hash = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    if (confirmationId) {
      const pending = this.pending.get(confirmationId);
      this.pending.delete(confirmationId);
      if (!pending || pending.hash !== hash || pending.expires < this.now())
        throw new Error("发送确认已过期或正文发生变化");
      return;
    }
    if (this.config.confirmSend) {
      const id = randomUUID();
      this.pending.set(id, { hash, expires: this.now() + 120000 });
      return {
        confirmationRequired: true,
        confirmationId: id,
        recipient: request.recipient,
        text: request.text,
        sent: false,
      };
    }
  }
  async send(
    { adapter, recipient, text, confirmationId, operationId = randomUUID() },
    { signal } = {},
  ) {
    if (
      !["enterprise", "publicAccount"].includes(adapter) ||
      typeof recipient !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(recipient) ||
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 2048
    )
      throw new Error("请提供单个官方收件人 ID 和 2048 字节内正文");
    const request = { adapter, recipient, text };
    const approval = this.approve(request, confirmationId);
    if (approval) return approval;
    const key = JSON.stringify([operationId, request]);
    if (this.sends.has(key)) return this.sends.get(key);
    const send = (async () => {
      const token = await this.token(adapter, signal);
      const url = new URL(
        adapter === "enterprise"
          ? "https://qyapi.weixin.qq.com/cgi-bin/message/send"
          : "https://api.weixin.qq.com/cgi-bin/message/custom/send",
      );
      url.searchParams.set("access_token", token);
      const body =
        adapter === "enterprise"
          ? {
              touser: recipient,
              agentid: Number(this.config.enterprise.agentId),
              msgtype: "text",
              text: { content: text },
              enable_duplicate_check: 1,
              duplicate_check_interval: 600,
            }
          : { touser: recipient, msgtype: "text", text: { content: text } };
      if (adapter === "enterprise" && !body.agentid)
        throw new Error("请配置企业微信 AgentId");
      const result = await this.request(url.href, body, signal);
      if (result.invaliduser || result.unlicenseduser)
        throw new Error("企业微信未接受指定收件人");
      return {
        sent: true,
        text: "微信官方接口已接受发送请求",
        adapter,
        recipient,
        messageId: result.msgid,
      };
    })();
    this.sends.set(key, send);
    if (this.sends.size > 1000)
      this.sends.delete(this.sends.keys().next().value);
    return send;
  }
}
module.exports = { WechatAdapters };
