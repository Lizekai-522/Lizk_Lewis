/* 页面与后端共用视觉配置，防止摄像头画面误发给文字模型。 */
(function (root) {
  "use strict";
  function visionSettings(settings = {}, defaults = {}) {
    const primaryIsVision = /^qwen3-vl-/i.test(
      settings.modelName || defaults.model || "",
    );
    const dedicated = Boolean(
      settings.visionApiBaseUrl ||
        settings.visionApiKey ||
        defaults.visionBase ||
        defaults.visionKey,
    );
    return {
      baseUrl:
        settings.visionApiBaseUrl ||
        defaults.visionBase ||
        (!dedicated && primaryIsVision
          ? settings.apiBaseUrl || defaults.baseUrl
          : ""),
      apiKey:
        settings.visionApiKey ||
        defaults.visionKey ||
        (!dedicated && primaryIsVision
          ? settings.apiKey || defaults.apiKey
          : ""),
      model:
        !dedicated && primaryIsVision
          ? settings.modelName || defaults.model
          : settings.visionModelName || "qwen3-vl-plus",
    };
  }
  function isVisionRequest(text) {
    return /(?:看[到见]我|看看我|看一下我|我(?:手里|手上|穿的|穿着).*(?:什么|啥|颜色)|(?:摄像头|镜头|画面).*(?:描述|看到|看见|什么)|根据当前摄像头画面)/u.test(
      text,
    );
  }
  if (typeof module !== "undefined" && module.exports)
    module.exports = { visionSettings, isVisionRequest };
  else {
    root.lewisVisionSettings = visionSettings;
    root.lewisIsVisionRequest = isVisionRequest;
  }
})(typeof window !== "undefined" ? window : globalThis);
