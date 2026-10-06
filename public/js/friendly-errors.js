(function (root) {
  "use strict";
  function friendlyError(error, action = "操作") {
    const text = String(error?.message || error || "");
    if (/发送状态.*(?:未知|未确认)|可能已经发送|无法确认.*发送/.test(text))
      return "微信发送结果暂时无法确认，请查看微信；为避免重复，不会自动重发。";
    if (/AbortError|aborted|cancelled|canceled|已取消|已停止/i.test(text))
      return "操作已取消。";
    if (/401|Unauthorized|invalid.*(?:key|token)/i.test(text))
      return "服务验证失败（401），请检查设置中的API Key。";
    if (/403|Forbidden/i.test(text))
      return "服务拒绝了访问（403），请检查账号权限或在网页中登录。";
    if (/429|rate.?limit|Too Many Requests/i.test(text))
      return "服务请求太频繁，请稍等一会儿再试。";
    if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(text))
      return "找不到这个网站，请检查网址和网络连接。";
    if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(text))
      return "服务没有连接上，请确认服务已启动。";
    if (/timeout|timed out|ETIMEDOUT|超时/i.test(text))
      return "等待时间过长，本次操作未完成；请检查网络后重试。";
    if (/NotAllowedError|Permission denied|permission.*denied/i.test(text))
      return "设备权限被拒绝，请在Windows设置中允许摄像头或麦克风访问。";
    if (/NotFoundError|Requested device not found/i.test(text))
      return "没有找到摄像头或麦克风，请检查设备连接。";
    if (/NotReadableError|could not start video|play\(\) request was interrupted|new load request/i.test(text))
      return "摄像头画面暂时中断，请重新开启摄像头后再试。";
    if (/snapshot|过期|页面发生跳转|元素.*不存在/i.test(text))
      return "页面已经变化，正在使用的页面位置失效；请重新读取后再操作。";
    if (/NotSupportedError|no supported source|没有.*视频|不能播放/i.test(text))
      return "当前页面没有可播放的视频，或视频需要登录后才能播放。";
    if (/ERR_CERT|SSL|certificate/i.test(text))
      return "网站的安全连接未通过，请检查网络或换一个来源。";
    if (
      /fetch failed|Failed to fetch|NetworkError|ERR_CONNECTION|ERR_TUNNEL|ECONNRESET/i.test(
        text,
      )
    )
      return "网络连接失败，本次操作未完成；请检查网络，或换一个网站再试。";
    if (/HTTP 5\d\d|status.*5\d\d/i.test(text))
      return "对方服务暂时不可用，请稍后再试。";
    if (
      /[\u4e00-\u9fff]/.test(text) &&
      !/\bat\s|node_modules|[A-Z]:\\|TypeError|Error:|[A-Za-z_]{25}/.test(text)
    )
      return text.slice(0, 180);
    return `${action}没有完成。可以重试，或从设置中导出诊断日志。`;
  }
  if (typeof module === "object" && module.exports)
    module.exports = { friendlyError };
  else root.lewisFriendlyError = friendlyError;
})(typeof window === "object" ? window : globalThis);
