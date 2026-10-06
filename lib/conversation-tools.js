"use strict";
function pageTask(message) {
  return /网页|网站|页面|浏览器|播放.*视频|点击|bilibili|哔哩哔哩|B站|youtube|pornhub/i.test(
    message,
  );
}
function selectConversationTools(tools, message, window) {
  if (window >= 8192) return tools;
  const names = pageTask(message)
    ? [
        "open_website",
        "web_get_text",
        "web_click",
        "web_type",
        "web_scroll",
        "web_play_video",
        "web_search",
      ]
    : /天气/.test(message)
      ? ["weather"]
      : /音量|声音/.test(message)
        ? ["set_volume"]
        : /音乐|听歌|歌曲|切歌/.test(message)
          ? [
              "music_play",
              "music_control",
              "open_app",
              "list_apps",
              "desktop_get_window",
              "desktop_click",
              "desktop_type",
            ]
          : /打开|启动|应用|软件|程序/.test(message)
            ? [
                "open_app",
                "list_apps",
                "desktop_get_window",
                "desktop_click",
                "desktop_type",
              ]
            : ["web_search", "weather"];
  return tools
    .filter(
      (tool) =>
        names.includes(tool.function.name) ||
        (tool.function.name.startsWith("plugin_") &&
          tool.function.name.endsWith("_instructions")),
    )
    .slice(0, 9);
}
module.exports = { pageTask, selectConversationTools };
