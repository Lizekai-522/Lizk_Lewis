(function (root) {
  "use strict";
  const pause = "[\\s，,。.!！?？、：:]*";
  const action =
    "(?:发送|发)(?:一下)?(?:一条|条|一则|则|一段|段|个)?(?:微信(?:消息)?|消息|信息)";
  const platform = "(?:(?:用|通过|在)?微信(?:上)?)";

  // 只剥掉句首的称呼、礼貌词和口语停顿，不在正文中搜索命令。
  function commandStart(input) {
    let text = input.trim();
    text = text.replace(
      new RegExp(
        "^(?:(?:嘿|你好)" + pause + ")?(?:李维斯|lewis|levis)" + pause,
        "iu",
      ),
      "",
    );
    for (let i = 0; i < 4; i++) {
      const next = text.replace(
        new RegExp(
          "^(?:我想请你|我想让你|能不能|可不可以|可以|麻烦你|麻烦|请你|请|你帮我|帮我|帮忙)" +
            pause,
          "u",
        ),
        "",
      );
      if (next === text) break;
      text = next;
    }
    return text;
  }

  function sendCommand(recipient, verb, rest, stripMarker = true) {
    recipient = recipient.replace(/[\s，,。.!！?？、：:]+$/u, "").trim();
    if (
      !recipient ||
      recipient.length > 80 ||
      /[\u0000-\u001f]/u.test(recipient) ||
      new RegExp("^" + action + "$", "u").test(recipient)
    )
      return null;
    // “发微信/发消息”已能划分正文，无需“说”或冒号；裸“发”仍需一个明确分隔。
    const explicit = new RegExp(
      "^(?:[\\s，,：:]|就说|说|内容(?:是|为)|消息内容(?:是|为)|告诉(?:他|她|对方))",
      "u",
    ).test(rest);
    if (!/微信|消息|信息/u.test(verb) && !explicit) return null;
    const body = (
      stripMarker
        ? rest.replace(
            new RegExp(
              "^" +
                pause +
                "(?:(?:消息)?内容(?:是|为)|就说|说|告诉(?:他|她|对方))?" +
                pause,
              "u",
            ),
            "",
          )
        : rest
    ).trim();
    return body ? { skill: "wechat-send", recipient, text: body } : null;
  }

  function parseWechatCommand(input) {
    if (typeof input !== "string") return null;
    const text = commandStart(input);
    if (/^(?:检查|连接)微信[。！!]?$/u.test(text))
      return { skill: "wechat-status" };
    const patterns = [
      // 用微信给张三发消息我十分钟到 / 微信给张三发消息说你好。
      new RegExp(
        "^" +
          platform +
          pause +
          "(?:给|向)" +
          pause +
          "(.{1,80}?)" +
          pause +
          "(" +
          action +
          ")([\\s\\S]+)$",
        "u",
      ),
      // 给张三发个微信我十分钟到。
      new RegExp(
        "^(?:给|向)" +
          pause +
          "(.{1,80}?)" +
          pause +
          "((?:发送|发)(?:一下)?(?:一条|条|一则|则|个)?微信(?:消息)?)([\\s\\S]+)$",
        "u",
      ),
      // 给张三用微信发消息我十分钟到。
      new RegExp(
        "^(?:给|向)" +
          pause +
          "(.{1,80}?)" +
          pause +
          platform +
          pause +
          "(" +
          action +
          ")([\\s\\S]+)$",
        "u",
      ),
      // 保留原来的“微信给张三发：你好”，裸“发/发送”需“说”、空白或标点。
      new RegExp(
        "^" +
          platform +
          pause +
          "(?:给|向)" +
          pause +
          "(.{1,80}?)" +
          pause +
          "(发送|发)((?:[\\s，,：:]|说|就说|内容(?:是|为))[\\s\\S]+)$",
        "u",
      ),
    ];
    for (const pattern of patterns) {
      const send = text.match(pattern);
      if (send) return sendCommand(send[1], send[2], send[3]);
    }
    const tell = text.match(
      new RegExp(
        "^" +
          platform +
          pause +
          "(?:跟|和|给)" +
          pause +
          "(.{1,80}?)" +
          pause +
          "(?:说一声|说一下|说)" +
          pause +
          "([\\s\\S]+)$",
        "u",
      ),
    );
    if (tell) return sendCommand(tell[1], "发微信", tell[2], false);
    const reverse = text.match(
      new RegExp(
        "^(?:发送|发)(?:一下)?(?:一条|条|个)?微信(?:消息)?" +
          pause +
          "(?:给|向)" +
          pause +
          "(.{1,80}?)(?:" +
          pause +
          "(?:说|就说|内容(?:是|为))" +
          pause +
          "|[\\s，,：:]+)([\\s\\S]+)$",
        "u",
      ),
    );
    if (reverse) return sendCommand(reverse[1], "发微信", reverse[2], false);
    const read = text.match(
      /^(?:读取|查看|总结)微信\s*(.{1,80}?)\s*(?:的)?(?:最近消息|聊天记录|聊天)[。！!]?$/u,
    );
    if (read) return { skill: "wechat-read", recipient: read[1].trim() };
    return null;
  }

  function comparableText(input) {
    if (typeof input !== "string") return null;
    // 允许 ASR 与模型在空白、普通句读上的差异；保留数字中的标点、金额符号、URL 等。
    return input
      .trim()
      .replace(/\s+/gu, "")
      .replace(/[，。！？、；,!?;：:]/gu, (char, index, text) => {
        if (
          /[0-9]/u.test(text[index - 1] || "") &&
          /[0-9]/u.test(text[index + 1] || "")
        )
          return char;
        if (char === ":" && text.slice(index + 1, index + 3) === "//")
          return char;
        return "";
      })
      .replace(/\.(?=$|[^0-9A-Za-z])/gu, "");
  }
  function matchesWechatCommand(requested, command) {
    return Boolean(
      requested &&
        requested.skill === command.skill &&
        requested.recipient === command.recipient &&
        (command.skill !== "wechat-send" ||
          (typeof command.text === "string" &&
            comparableText(requested.text) === comparableText(command.text))),
    );
  }
  // 区分“发送原话”和“按任务撰写后发送”，撰写任务不能直接作为正文发出。
  function parseWechatSendIntent(input) {
    if (typeof input !== "string") return null;
    const generic = commandStart(input).match(
      new RegExp(
        "^(?:给|向)" +
          pause +
          "(.{1,80}?)" +
          pause +
          "(" +
          action +
          ")([\\s\\S]+)$",
        "u",
      ),
    );
    const command =
      parseWechatCommand(input) ||
      (generic && sendCommand(generic[1], generic[2], generic[3]));
    if (command?.skill === "wechat-send") {
      const body = command.text;
      const quoted = /^(?:“[\s\S]*”|「[\s\S]*」|"[\s\S]*")\s*[。！!]?$/u.test(
        body,
      );
      const compose =
        !quoted &&
        (/^(?:帮我|请你|请)?(?:整理|组织|润色|拟|写|编写|通知|回复|说明|解释|询问|问一下|问问|转达)/u.test(
          body,
        ) ||
          /(?:[，,；;]|并且|然后|顺便)\s*(?:请|帮我)?(?:把)?(?:语气|措辞|表达|内容|正文|文字|消息)(?:[\s\S]*)(?:客气|礼貌|委婉|整理|润色|组织|简洁|正式|自然)/u.test(
            body,
          ) ||
          /[，,；;]\s*(?:请你|请|帮我)?(?:整理|润色|组织|改写|优化)(?:一下|正文|文字|消息|内容|措辞)/u.test(
            body,
          ));
      return {
        recipient: command.recipient,
        mode: compose ? "compose" : "verbatim",
        ...(compose ? { task: body } : { text: body }),
      };
    }
    const text = commandStart(input);
    const match =
      text.match(
        /^(?:用|通过|在)?微信(?:上)?\s*(?:回复|通知)\s*(.{1,80}?)[，,：:\s]+([\s\S]+)$/u,
      ) ||
      text.match(
        /^(?:写|整理|拟)(?:一条|条)?微信(?:消息)?给\s*(.{1,80}?)[，,：:\s]+([\s\S]+?)(?:并|然后|直接)(?:帮我)?发送[。！!]?$/u,
      );
    if (!match || !match[1].trim() || !match[2].trim()) return null;
    return {
      recipient: match[1].trim(),
      mode: "compose",
      task: match[2].trim(),
    };
  }
  function authorizeWechatCommand(message, command) {
    if (command.skill !== "wechat-send")
      return matchesWechatCommand(parseWechatCommand(message), command);
    const intent = parseWechatSendIntent(message);
    if (
      !intent ||
      intent.recipient !== command.recipient ||
      typeof command.text !== "string" ||
      !command.text.trim() ||
      command.text.length > 2000
    )
      return false;
    return (
      intent.mode === "compose" ||
      comparableText(intent.text) === comparableText(command.text)
    );
  }
  if (typeof module !== "undefined" && module.exports)
    module.exports = {
      parseWechatCommand,
      matchesWechatCommand,
      parseWechatSendIntent,
      authorizeWechatCommand,
    };
  else {
    root.parseWechatCommand = parseWechatCommand;
    root.parseWechatSendIntent = parseWechatSendIntent;
  }
})(typeof window !== "undefined" ? window : globalThis);
