// AudioWorklet 在音频线程收集 PCM，不依赖浏览器在线语音识别服务。
class PCMRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (channels?.length && channels[0].length) {
      const mono = new Float32Array(channels[0].length);
      for (const channel of channels)
        for (let i = 0; i < mono.length; i++)
          mono[i] += channel[i] / channels.length;
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-recorder", PCMRecorder);
