/* 明确打开网站的口语命令直接执行，不需要模型决定是否打开。 */
(function (root) {
  "use strict";
  const aliases = {
    pornhub: "https://www.pornhub.com/",
    github: "https://github.com/",
    youtube: "https://www.youtube.com/",
    bilibili: "https://www.bilibili.com/",
    哔哩哔哩: "https://www.bilibili.com/",
    b站: "https://www.bilibili.com/",
  };
  function parseWebsiteCommand(input) {
    if (typeof input !== "string") return null;
    let text = input
      .trim()
      .replace(/^(?:李维斯|lewis|levis)[\s，,。！!：:]*/iu, "");
    text = text.replace(
      /^(?:(?:我想请你|我想让你|我希望你|我想要|我想|我希望|请你|请|麻烦你|麻烦|帮我|给我|能不能|可不可以)[\s，,]*){1,4}/u,
      "",
    );
    text = text.replace(
      /^(?:用|通过|在)(?:你的|内置的?|默认的?)?(?:浏览器|网页面板)(?:里|中)?[\s，,]*/u,
      "",
    );
    const match =
      text.match(
        /^(?:打开|访问|进入|浏览|播放|看看|看)(?:一下)?\s*(?:网站|网页)?\s*([\s\S]+?)[。！!？?]?$/u,
      ) ||
      text.match(
        /^(?:把)?\s*([\s\S]+?)\s*(?:打开|播放)(?:一下)?(?:给我看|让我看)?[。！!？?]?$/u,
      );
    if (!match) return null;
    const rest = match[1].trim();
    const known = rest.match(
      /^(porn\s*hub|github|youtube|bilibili|哔哩哔哩|b站)(?:(?:这个|的)?(?:网站|网页))?(?:[\s，,]*(?:给我看看|让我看看|给我看|让我看|给我播放|播放一下|看看|看一下|播放|给我打开|打开))?$/iu,
    );
    let target = known
      ? aliases[known[1].replace(/\s+/g, "").toLowerCase()]
      : rest;
    if (/\s/u.test(target)) return null;
    if (!/^https?:\/\//i.test(target)) {
      if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#].*)?$/i.test(target))
        return null;
      target = "https://" + target;
    }
    try {
      const url = new URL(target);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return null;
      return { skill: "open-website", url: url.href };
    } catch {
      return null;
    }
  }
  function parseSearchCommand(input) {
    if (typeof input !== "string") return null;
    const text = input
      .trim()
      .replace(/^(?:李维斯|lewis|levis)[\s，,。！!：:]*/iu, "")
      .replace(
        /^(?:(?:我想请你|我想让你|我想要|我想|我希望你|我希望|请你|请|麻烦你|麻烦|帮我|给我|能不能|可不可以)[\s，,]*){1,4}/u,
        "",
      );
    const match = text.match(
      /^(?:上网搜索|联网搜索|搜索|搜一下|查找|搜一搜|搜)(?:一下)?\s*(.+)$/u,
    );
    // 带后续操作的搜索交给工具对话继续执行，不能只把整句当关键词。
    if (
      match &&
      /(?:然后|并且|并|再|顺便)(?:帮我|给我)?(?:打开|点击|播放|读取|查看|填写|滚动)/u.test(
        match[1],
      )
    )
      return null;
    return match ? { skill: "web-search", query: match[1].trim() } : null;
  }
  function parseBrowserTask(input) {
    if (typeof input !== "string" || parseWebsiteCommand(input)) return null;
    const text = input
      .replace(/^(?:李维斯|lewis|levis)[\s，,]*/iu, "")
      .replace(/^(?:(?:请你|请|帮我|麻烦你|麻烦)[\s，,]*)+/u, "");
    const match = text.match(
      /^(?:打开|访问|浏览)(?:一下)?\s*(?:网站)?\s*(bilibili|哔哩哔哩|b站|youtube|github|pornhub)(.*)$/iu,
    );
    if (!match || !match[2].trim()) return null;
    const name = match[1].toLowerCase();
    return {
      url:
        /bilibili|哔哩哔哩|b站/i.test(name) && /热门|流行/.test(match[2])
          ? "https://www.bilibili.com/v/popular/all"
          : aliases[name],
      play: /播放|放一个|看一个|看个/.test(match[2]),
    };
  }
  if (typeof module !== "undefined" && module.exports)
    module.exports = {
      parseWebsiteCommand,
      parseSearchCommand,
      parseBrowserTask,
    };
  else {
    root.parseWebsiteCommand = parseWebsiteCommand;
    root.parseSearchCommand = parseSearchCommand;
    root.parseBrowserTask = parseBrowserTask;
  }
})(typeof window !== "undefined" ? window : globalThis);
