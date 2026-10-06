"use strict";
const { readSettings, writeSettings } = require("./secret-codec");
const fs = require("node:fs");
const path = require("node:path");
class VoiceProfile {
  constructor(directory, fetchImpl = fetch) {
    this.file = path.join(directory, "voice-profile.json");
    this.fetch = fetchImpl;
    this.value = readSettings(this.file, {
      asrMode: "local",
      ttsMode: "local",
      baseUrl: "",
      apiKey: "",
      asrModel: "whisper-1",
      ttsModel: "tts-1",
      voice: "alloy",
    });
  }
  publicConfig() {
    return {
      ...this.value,
      apiKey: undefined,
      hasKey: Boolean(this.value.apiKey),
    };
  }
  configure(value) {
    if (
      !value ||
      !["local", "cloud"].includes(value.asrMode) ||
      !["local", "cloud"].includes(value.ttsMode)
    )
      throw Error("语音模式无效");
    const candidate = {
      ...this.value,
      ...value,
      apiKey: value.apiKey || this.value.apiKey,
    };
    if (candidate.asrMode === "cloud" || candidate.ttsMode === "cloud") {
      const url = new URL(candidate.baseUrl);
      if (
        url.username ||
        url.password ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "localhost"].includes(url.hostname))
        ) ||
        !/^[\x21-\x7e]{1,512}$/.test(candidate.apiKey)
      )
        throw Error("云端语音需完整兼容 API 地址和有效 Key");
      candidate.baseUrl = url.href.replace(/\/+$/, "");
    }
    for (const name of ["asrModel", "ttsModel", "voice"])
      if (
        typeof candidate[name] !== "string" ||
        !candidate[name].trim() ||
        candidate[name].length > 100
      )
        throw Error("云端语音模型与声音不能为空");
    writeSettings(this.file, candidate);
    this.value = candidate;
    return this.publicConfig();
  }
  async asr(bytes, contentType, signal) {
    const formRequest = new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: bytes,
    });
    const original = await formRequest.formData();
    const audio = original.get("audio");
    if (!(audio instanceof Blob)) throw Error("请上传 audio WAV");
    const form = new FormData();
    form.append("file", audio, "recording.wav");
    form.append("model", this.value.asrModel);
    const response = await this.fetch(
      this.value.baseUrl + "/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + this.value.apiKey },
        body: form,
        redirect: "error",
        signal: AbortSignal.any([
          signal || new AbortController().signal,
          AbortSignal.timeout(120000),
        ]),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw Error("云端 ASR HTTP " + response.status);
    }
    const data = await response.json();
    if (typeof data.text !== "string" || data.text.length > 20000)
      throw Error("云端 ASR 没有有效文本");
    return { text: data.text, success: true, engine: "cloud" };
  }
  async tts(text, signal) {
    const response = await this.fetch(this.value.baseUrl + "/audio/speech", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.value.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.value.ttsModel,
        voice: this.value.voice,
        input: text,
        response_format: "mp3",
      }),
      redirect: "error",
      signal: AbortSignal.any([
        signal || new AbortController().signal,
        AbortSignal.timeout(120000),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error("云端 TTS HTTP " + response.status);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 10 * 1024 * 1024)
      throw Error("云端 TTS 音频大小无效");
    return bytes;
  }
}
module.exports = { VoiceProfile };
