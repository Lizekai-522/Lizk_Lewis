(function (root) {
  "use strict";
  function parseDesktopCommand(input) {
    if (typeof input !== "string") return null;
    let text = input
      .trim()
      .replace(/^(?:李维斯|利维斯|lewis|levis)[\s，,。！!：:]*/iu, "")
      .replace(
        /^(?:(?:请你|请|麻烦你|麻烦|帮我|给我|能不能|可不可以)[\s，,]*){1,4}/u,
        "",
      )
      .replace(/[。！!？?]+$/u, "");
    if (/qq\s*音乐|qq\s*music/iu.test(text)) {
      if (/^(?:暂停|停止)(?:一下)?\s*(?:qq\s*音乐|qq\s*music)$/iu.test(text))
        return { skill: "music-control", action: "pause" };
      if (
        /(?:qq\s*音乐|qq\s*music).*(?:下一首|切歌)|^(?:下一首|切歌).*qq/iu.test(
          text,
        )
      )
        return { skill: "music-control", action: "next" };
      if (/^(?:继续|恢复)(?:播放)?\s*(?:qq\s*音乐|qq\s*music)$/iu.test(text))
        return { skill: "music-control", action: "play" };
      if (
        /播放|放歌|听歌|听音乐|来点音乐|推荐.*歌|(?:我想|想|我要|要)听/iu.test(
          text,
        )
      ) {
        const match = text.match(
          /(?:qq\s*音乐|qq\s*music)[\s，,]*(?:(?:帮我|给我|我想|我要|我想要|想|要|自动|随机)[\s，,]*)*(?:播放|放一首|放|听)\s*(.+)$/iu,
        );
        let query = match
          ? match[1]
              .trim()
              .replace(/^(?:一首|一下|歌曲|歌)\s*/u, "")
              .replace(/^《|》$/g, "")
          : "";
        if (
          /^(?:歌|音乐|听歌|推荐(?:的)?(?:歌曲|音乐)?|随机(?:歌曲|音乐)?|一首歌)$/u.test(
            query,
          )
        )
          query = "";
        return { skill: "music-play", query };
      }
    }
    const match = text.match(
      /^(?:打开|启动|运行|开一下)(?:一下)?\s*(.+?)\s*(?:这个|这个软件|应用|软件|程序)?$/u,
    );
    if (
      !match ||
      match[1].length > 120 ||
      /然后|并且|并|帮我|给我|播放|听歌|网页|网站|https?:|[\\/:<>|]/iu.test(
        match[1],
      )
    )
      return null;
    return { skill: "open-app", app: match[1].trim() };
  }
  if (typeof module === "object" && module.exports)
    module.exports = { parseDesktopCommand };
  else root.parseDesktopCommand = parseDesktopCommand;
})(typeof window === "object" ? window : globalThis);
