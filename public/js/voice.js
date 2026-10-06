/* 录音 → WAV → Node 代理 → FunASR；唤醒、对话、播报共用一个麦克风状态机。 */
(function () {
  function encodeWav(chunks, sampleRate) {
    const length = chunks.reduce((sum, c) => sum + c.length, 0);
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);
    const ascii = (offset, text) =>
      [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    ascii(0, "RIFF");
    view.setUint32(4, 36 + length * 2, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, length * 2, true);
    let offset = 44;
    for (const chunk of chunks)
      for (const sample of chunk) {
        const value = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, value * (value < 0 ? 32768 : 32767), true);
        offset += 2;
      }
    return new Blob([buffer], { type: "audio/wav" });
  }

  class LewisVoice {
    constructor({
      onText,
      onState,
      onWake,
      onInterrupt,
      onWakeReady,
      onSpeechStart,
      getSettings,
    }) {
      this.onText = onText;
      this.onState = onState;
      this.onWake = onWake;
      this.onInterrupt = onInterrupt;
      this.onWakeReady = onWakeReady;
      this.onSpeechStart = onSpeechStart;
      this.getSettings = getSettings;
      this.mode = "off";
      this.wakeEnabled = false;
      this.continuousEnabled = false;
      this.awakeUntil = 0;
      this.busy = false;
      this.processing = false;
      this.generation = 0;
      this.resetSegment();
    }
    idleMode() {
      return this.continuousEnabled ||
        (this.wakeEnabled && Date.now() < this.awakeUntil)
        ? "conversation"
        : this.wakeEnabled
          ? "wake"
          : "off";
    }
    idleLabel() {
      if (!this.continuousEnabled && this.idleMode() === "conversation")
        return "我在听，接着说就好";
      return this.continuousEnabled
        ? "持续对话：请直接说话"
        : this.wakeEnabled
          ? "等待“李维斯”唤醒"
          : "语音就绪";
    }
    state(label, pet = "idle") {
      this.onState(
        label,
        pet,
        ["manual", "command", "conversation"].includes(this.mode) &&
          !this.busy &&
          !this.processing,
      );
    }
    keepAwake() {
      if (this.wakeEnabled) {
        const seconds = Number(this.getSettings().wakeConversationSeconds ?? 0);
        this.awakeUntil =
          seconds === 0
            ? Infinity
            : Date.now() + Math.max(30, Math.min(120, seconds || 60)) * 1000;
      }
    }
    resetSegment() {
      this.probeRequest?.abort();
      this.probeRequest = null;
      this.segmentSerial = (this.segmentSerial || 0) + 1;
      this.wakeAnnounced = false;
      this.probeSamples = 0;
      this.chunks = [];
      this.preRoll = [];
      this.samples = 0;
      this.silentSamples = 0;
      this.hasSpeech = false;
      this.startedAt = Date.now();
    }
    async ensureMic() {
      if (this.micPending) return this.micPending;
      const pending = this.openMic();
      this.micPending = pending;
      try {
        await pending;
      } finally {
        if (this.micPending === pending) this.micPending = null;
      }
    }
    async openMic() {
      if (this.stream) {
        await this.context.resume();
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("麦克风需要 localhost 或 HTTPS");
      // 同一来源只允许一个页面录音，避免多个标签页重复提交。
      if (navigator.locks && !this.releaseMicLock) {
        let ready;
        const acquired = new Promise((resolve) => {
          ready = resolve;
        });
        this.micLock = navigator.locks.request(
          "lewis-microphone",
          { ifAvailable: true },
          async (lock) => {
            ready(Boolean(lock));
            if (lock)
              await new Promise((resolve) => {
                this.releaseMicLock = resolve;
              });
          },
        );
        if (!(await acquired))
          throw new Error("另一个 Lewis 窗口正在使用麦克风，请先关闭其聆听");
      }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        this.context = new AudioContext();
        await this.context.audioWorklet.addModule("/js/pcm-worklet.js");
        this.source = this.context.createMediaStreamSource(this.stream);
        this.processor = new AudioWorkletNode(this.context, "pcm-recorder");
        const mute = this.context.createGain();
        mute.gain.value = 0;
        this.source
          .connect(this.processor)
          .connect(mute)
          .connect(this.context.destination);
        this.processor.port.onmessage = (event) => this.capture(event.data);
        await this.context.resume();
      } catch (error) {
        await this.releaseMic();
        throw error;
      }
    }
    async releaseMic() {
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.processor?.disconnect();
      this.source?.disconnect();
      const context = this.context;
      this.context = null;
      this.releaseMicLock?.();
      this.releaseMicLock = null;
      if (context && context.state !== "closed") await context.close();
    }
    pauseMic(paused) {
      this.stream?.getAudioTracks().forEach((track) => {
        track.enabled = !paused;
      });
      this.resetSegment();
    }
    async setInterruptListening(enabled) {
      // 说话期间仅处理带称呼的停止指令，不把回声或其他语句提交给模型。
      this.interruptListening = Boolean(enabled);
      this.generation++;
      this.request?.abort();
      this.processing = false;
      const generation = this.generation;
      if (enabled && (this.stream || this.idleMode() !== "off")) {
        try {
          await this.ensureMic();
        } catch (error) {
          if (generation === this.generation) {
            this.interruptListening = false;
            this.onState(`语音打断暂不可用：${error.message}；仍可点停止播报`);
          }
          return;
        }
        if (generation !== this.generation) return;
        this.resumeAfter = 0;
        this.pauseMic(false);
      } else {
        this.interruptListening = false;
        this.pauseMic(this.busy);
      }
    }
    isStopCommand(text) {
      return /^(?:(?:嘿|你好|hey|hi)[\s，,！!]*)?(?:李[\s，,。]*维[\s，,。]*斯|lewis|levis)[\s，,。.!！?？、：:]*(?:请)?(?:停下|停止(?:播报|说话)?|别说了|不要说了|暂停(?:播报)?)[\s，,。.!！?？]*$/iu.test(
        text.trim(),
      );
    }
    isEndConversation(text) {
      return /^(?:(?:嘿|你好|hey|hi)[\s，,！!]*)?(?:(?:李[\s，,。]*维[\s，,。]*斯|lewis|levis)[\s，,。.!！?？、：:]*)?(?:请)?(?:结束对话|退出持续对话|回到待机|进入待机|先休息(?:吧)?)[\s，,。.!！?？]*$/iu.test(
        text.trim(),
      );
    }
    returnToStandby() {
      this.onInterrupt?.();
      this.generation++;
      this.request?.abort();
      this.processing = false;
      this.request = null;
      this.interruptListening = false;
      this.continuousEnabled = false;
      this.wakeEnabled = true;
      this.awakeUntil = 0;
      this.mode = "wake";
      this.pauseMic(this.busy);
      this.state("对话已结束，等待“李维斯”唤醒");
    }
    setBusy(busy) {
      this.busy = busy;
      if (busy) {
        this.generation++;
        this.request?.abort();
        this.processing = false;
        this.mode = this.idleMode();
      }
      this.pauseMic(busy && !this.interruptListening);
      if (!busy) {
        if (this.awakeUntil) this.keepAwake();
        this.resumeAfter = Date.now() + 400; // 等待扬声器尾音消失，避免回复被当成下一句。
        this.mode = this.idleMode();
        this.state(
          this.idleLabel(),
          this.mode === "conversation" ? "listening" : "idle",
        );
        if (this.mode === "off") void this.releaseMic();
      }
    }
    async toggleContinuous(enabled) {
      this.warmRequest?.abort();
      this.awakeUntil = 0;
      this.continuousEnabled = Boolean(enabled);
      this.wakeEnabled = false;
      this.generation++;
      this.request?.abort();
      this.processing = false;
      const generation = this.generation;
      if (!enabled) {
        this.interruptListening = false;
        this.mode = "off";
        this.resetSegment();
        await this.releaseMic();
        this.state("持续对话已暂停");
        return;
      }
      try {
        await this.ensureMic();
        if (generation !== this.generation) {
          if (this.idleMode() === "off") await this.releaseMic();
          else this.pauseMic(this.busy);
          return;
        }
        this.mode = "conversation";
        this.pauseMic(this.busy);
        this.state(
          this.busy ? "正在回复，麦克风暂停" : this.idleLabel(),
          "listening",
        );
      } catch (error) {
        this.continuousEnabled = false;
        this.mode = "off";
        throw error;
      }
    }
    async toggleWake(enabled) {
      this.warmRequest?.abort();
      this.probeAvailable = true;
      this.awakeUntil = 0;
      this.continuousEnabled = false;
      this.wakeEnabled = enabled;
      this.generation++;
      this.request?.abort();
      this.processing = false;
      const generation = this.generation;
      if (!enabled) {
        this.interruptListening = false;
        this.mode = "off";
        this.resetSegment();
        await this.releaseMic();
        this.state("唤醒监听已关闭");
        return;
      }
      try {
        await this.ensureMic();
        if (generation !== this.generation) {
          if (this.idleMode() === "off") await this.releaseMic();
          else this.pauseMic(this.busy);
          return;
        }
        this.mode = "wake";
        this.pauseMic(this.busy);
        this.state(this.busy ? "正在回复，唤醒监听暂停" : "等待“李维斯”唤醒");
      } catch (error) {
        this.wakeEnabled = false;
        this.mode = "off";
        throw error;
      }
    }
    async toggleManual() {
      if (this.busy || this.processing || this.micPending) return;
      if (["manual", "command"].includes(this.mode)) {
        await this.submit("asr");
        return;
      }
      this.generation++;
      const generation = this.generation;
      await this.ensureMic();
      if (generation !== this.generation) {
        if (this.idleMode() === "off") await this.releaseMic();
        else this.pauseMic(this.busy);
        return;
      }
      this.mode = "manual";
      this.pauseMic(false);
      this.state("正在录音，再点麦克风结束", "listening");
    }
    capture(chunk) {
      if (
        !this.context ||
        ((this.busy || this.mode === "off") && !this.interruptListening) ||
        this.processing ||
        Date.now() < (this.resumeAfter || 0)
      )
        return;
      const sr = this.context.sampleRate;
      // 空闲才回到唤醒监听，讲话和回复期间不会截断连续交谈。
      if (
        this.mode === "conversation" &&
        !this.hasSpeech &&
        this.idleMode() === "wake"
      ) {
        this.awakeUntil = 0;
        this.mode = "wake";
        this.resetSegment();
        this.state(this.idleLabel());
      }
      const rms = Math.sqrt(
        chunk.reduce((sum, sample) => sum + sample * sample, 0) / chunk.length,
      );
      // 本地能量门只负责分段和减少上传；人声判断由服务端 Silero 完成。
      const threshold = Number(this.getSettings().micThreshold || 0.012);
      const speech = rms > threshold;
      if (!this.hasSpeech) {
        this.preRoll.push(chunk);
        while (this.preRoll.length > Math.ceil((sr * 0.3) / chunk.length))
          this.preRoll.shift();
        if (speech) {
          this.onSpeechStart?.();
          this.hasSpeech = true;
          this.chunks = this.preRoll.slice();
          this.samples = this.chunks.reduce((sum, c) => sum + c.length, 0);
        } else if (
          ["manual", "command"].includes(this.mode) &&
          Date.now() - this.startedAt > 10000
        ) {
          void this.finishEmpty();
        }
        return;
      }
      this.chunks.push(chunk);
      this.samples += chunk.length;
      this.silentSamples = speech ? 0 : this.silentSamples + chunk.length;
      // 不暂停录音，不切分整句任务；浮现只等待小模型命中名字。
      if (
        !this.interruptListening &&
        this.mode === "wake" &&
        !this.wakeAnnounced &&
        this.probeAvailable !== false &&
        !this.probeRequest &&
        !this.warmRequest &&
        this.samples >= sr * 0.8 &&
        this.samples - this.probeSamples >= sr * 0.5
      )
        void this.probeWake();
      if (
        this.silentSamples >
          sr * (this.interruptListening || this.mode === "wake" ? 0.35 : 0.7) ||
        this.samples > sr * (this.interruptListening ? 5 : 20)
      )
        void this.submit(
          !this.interruptListening && this.mode === "wake"
            ? "wake-word"
            : "asr",
        );
    }
    async finishEmpty() {
      if (this.interruptListening) {
        this.resetSegment();
        return;
      }
      this.mode = this.idleMode();
      this.resetSegment();
      this.state(
        this.mode === "conversation" ? this.idleLabel() : "没有听到讲话",
      );
      if (this.mode === "off") await this.releaseMic();
    }
    async probeWake() {
      if (this.probeRequest || !this.context) return;
      const generation = this.generation,
        serial = this.segmentSerial;
      const controller = new AbortController();
      this.probeRequest = controller;
      this.probeSamples = this.samples;
      // 最近三秒的重叠窗口覆盖跨上传边界的唤醒词，内存与请求量有界。
      const chunks = [];
      let samples = 0;
      for (let index = this.chunks.length - 1; index >= 0; index--) {
        const remaining = this.context.sampleRate * 3 - samples;
        if (remaining <= 0) break;
        const chunk = this.chunks[index];
        const part =
          chunk.length > remaining
            ? chunk.subarray(chunk.length - remaining)
            : chunk;
        chunks.unshift(part);
        samples += part.length;
      }
      try {
        const data = await this.upload(
          "wake-probe",
          encodeWav(chunks, this.context.sampleRate),
          AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]),
        );
        if (
          generation !== this.generation ||
          serial !== this.segmentSerial ||
          this.processing ||
          this.busy ||
          this.mode !== "wake"
        )
          return;
        if (data.available === false) this.probeAvailable = false;
        else if (data.detected) {
          this.wakeAnnounced = true;
          this.keepAwake();
          this.onWake?.();
          this.state("我在听，接着说就好", "listening");
        }
      } catch (error) {
        if (
          !controller.signal.aborted &&
          generation === this.generation &&
          serial === this.segmentSerial
        )
          this.probeAvailable = false; // 服务旧版/检测失败：保留整句唤醒链路。
      } finally {
        if (this.probeRequest === controller) this.probeRequest = null;
      }
    }
    async warmWakeDetector() {
      if (!this.wakeEnabled || !this.context || this.warmRequest) return;
      const controller = new AbortController(),
        generation = this.generation;
      this.warmRequest = controller;
      try {
        const silence = new Float32Array(
          Math.round(this.context.sampleRate * 0.15),
        );
        const data = await this.upload(
          "wake-probe",
          encodeWav([silence], this.context.sampleRate),
          AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        );
        if (generation === this.generation && data.available === false)
          this.probeAvailable = false;
      } catch {
        if (generation === this.generation && !controller.signal.aborted)
          this.probeAvailable = false;
      } finally {
        if (this.warmRequest === controller) this.warmRequest = null;
      }
    }
    async upload(endpoint, blob, signal) {
      const form = new FormData();
      form.append("audio", blob, "recording.wav");
      const response = await fetch(`/api/${endpoint}`, {
        method: "POST",
        headers: {
          "X-Voice-Service":
            this.getSettings().voiceServiceUrl || "http://localhost:5001",
        },
        body: form,
        signal,
      });
      const data = await window.readJSONResponse(response, `/api/${endpoint}`);
      if (!response.ok || data.success === false)
        throw new Error(data.error || "语音识别失败");
      return data;
    }
    async submit(endpoint) {
      if (this.processing || (this.busy && !this.interruptListening)) return;
      if (!this.hasSpeech || this.samples < this.context.sampleRate * 0.2) {
        await this.finishEmpty();
        return;
      }
      const announced = this.wakeAnnounced;
      if (endpoint === "wake-word" && announced) endpoint = "asr";
      const blob = encodeWav(this.chunks, this.context.sampleRate);
      const generation = this.generation;
      const interruptOnly = this.interruptListening;
      let wakeOnly = false;
      this.processing = true;
      this.pauseMic(true);
      if (!interruptOnly)
        this.state(
          endpoint === "asr" ? "FunASR 正在识别…" : "正在检测唤醒词…",
          "thinking",
        );
      this.request = new AbortController();
      try {
        // 持续对话过滤背景噪声，避免静音/环境音被 ASR 编造为文字。
        if (
          endpoint === "asr" &&
          this.mode === "conversation" &&
          !interruptOnly
        ) {
          const vad = await this.upload(
            "vad",
            blob,
            AbortSignal.any([this.request.signal, AbortSignal.timeout(300000)]),
          );
          if (generation !== this.generation) return;
          if (!vad.has_voice) {
            await this.finishEmpty();
            return;
          }
        }
        const data = await this.upload(
          endpoint,
          blob,
          AbortSignal.any([this.request.signal, AbortSignal.timeout(300000)]),
        );
        if (generation !== this.generation) return;
        if (announced) this.mode = this.idleMode();
        if (this.isEndConversation(data.text || data.command || "")) {
          this.returnToStandby();
          return;
        }
        if (this.isStopCommand(data.text || "")) {
          this.onInterrupt?.();
          return;
        }
        if (interruptOnly) return;
        if (endpoint === "wake-word") {
          if (data.detected) {
            this.keepAwake();
            this.mode = this.idleMode();
            this.onWake?.();
            // 旧服务的 command 去掉了标点和空格；微信代发必须保留原始 ASR 正文。
            const original = typeof data.text === "string" ? data.text : "";
            const wake = original.match(
              /(?:李[\s，。！？、,.!?]*维[\s，。！？、,.!?]*斯|lewis)[\s，。！？、,.!?：:]*/i,
            );
            const command = wake
              ? original.slice(wake.index + wake[0].length).trim()
              : data.command?.trim();
            if (command) await this.onText(command);
            else {
              wakeOnly = true;
              this.mode =
                this.idleMode() === "conversation" ? "conversation" : "command";
              this.state("我在听，接着说就好", "listening");
            }
          } else {
            this.mode = "wake";
            this.state("等待“李维斯”唤醒");
          }
        } else if (data.text?.trim()) {
          const text = data.text.trim();
          // 持续对话也能呼出隐藏的桌宠；只说名字时不请求大模型。
          const wake = text.match(
            /^(?:(?:嘿|你好|hey|hi)[\s，,！!]*)?(?:李[\s，,。]*维[\s，,。]*斯|利维斯|黎维斯|李威斯|路易斯|刘易斯|lewis|levis)[\s，,。.!！?？、：:]*/i,
          );
          if (wake) {
            this.keepAwake();
            if (!announced) this.onWake?.();
          }
          const command = wake ? text.slice(wake[0].length).trim() : text;
          if (command) {
            this.keepAwake();
            await this.onText(command);
          } else {
            wakeOnly = Boolean(wake || announced);
            this.mode =
              this.idleMode() === "conversation" ? "conversation" : "command";
            this.state("我在听，接着说就好", "listening");
          }
        } else {
          await this.finishEmpty();
        }
      } catch (error) {
        if (generation !== this.generation || error.name === "AbortError")
          return;
        if (interruptOnly) {
          this.onState(`语音打断识别失败：${error.message}；可点停止播报`);
          this.resumeAfter = Date.now() + 1500;
          return;
        }
        this.wakeEnabled = false;
        this.continuousEnabled = false;
        this.awakeUntil = 0;
        this.mode = "off";
        await this.releaseMic();
        this.state(`⚠️ ${error.message}；检查语音服务后重新开启`);
      } finally {
        if (generation === this.generation) {
          this.processing = false;
          this.request = null;
          this.pauseMic(this.busy && !this.interruptListening);
          if (this.idleMode() === "off" && !this.busy) {
            this.mode = "off";
            await this.releaseMic();
          } else if (!this.busy && this.mode === "conversation")
            this.state(this.idleLabel(), "listening");
        }
      }
      // 应答会调整播报/麦克风状态，必须等当前识别请求完成清理再调用。
      if (
        wakeOnly &&
        generation === this.generation &&
        !this.busy &&
        this.idleMode() !== "off"
      )
        await this.onWakeReady?.();
    }
    async destroy() {
      this.generation++;
      this.request?.abort();
      this.probeRequest?.abort();
      this.warmRequest?.abort();
      this.interruptListening = false;
      this.wakeEnabled = false;
      this.continuousEnabled = false;
      this.awakeUntil = 0;
      this.mode = "off";
      await this.releaseMic();
    }
  }
  window.LewisVoice = LewisVoice;
  window.encodeLewisWav = encodeWav;
})();
