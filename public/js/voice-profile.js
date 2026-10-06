(() => {
  const $ = (id) => document.getElementById(id);
  const status = (text) => ($("voiceProfileStatus").textContent = text);
  async function api(endpoint, body) {
    const response = await fetch(
      "/api/" + endpoint,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {},
    );
    const data = await window.readJSONResponse(response, "语音配置");
    if (!response.ok) throw Error(data.error);
    return data;
  }
  const run = (operation) => async () => {
    try {
      status(JSON.stringify(await operation()));
    } catch (error) {
      status(error.message);
    }
  };
  api("voice-profile")
    .then((data) => {
      for (const key of ["asrMode", "ttsMode"]) $(key).value = data[key];
      $("voiceCloudBase").value = data.baseUrl;
      $("voiceCloudAsr").value = data.asrModel;
      $("voiceCloudTts").value = data.ttsModel;
      $("voiceCloudVoice").value = data.voice;
    })
    .catch((error) => status(error.message));
  $("voiceRuntimeCheck").onclick = run(() => api("voice-runtime"));
  $("voiceRuntimeSave").onclick = run(() =>
    api("voice-runtime", {
      wake_engine: $("wakeEngine").value,
      idle_seconds: Number($("asrIdleSeconds").value),
      asr_model: $("localAsrModel").value,
    }),
  );
  $("voiceProfileSave").onclick = run(async () => {
    const data = await api("voice-profile", {
      asrMode: $("asrMode").value,
      ttsMode: $("ttsMode").value,
      baseUrl: $("voiceCloudBase").value.trim(),
      apiKey: $("voiceCloudKey").value.trim(),
      asrModel: $("voiceCloudAsr").value.trim(),
      ttsModel: $("voiceCloudTts").value.trim(),
      voice: $("voiceCloudVoice").value.trim(),
    });
    $("voiceCloudKey").value = "";
    return data;
  });
})();
