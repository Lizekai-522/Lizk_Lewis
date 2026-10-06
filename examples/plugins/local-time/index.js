"use strict";
module.exports = {
  tools: [
    {
      name: "get_time",
      description: "读取电脑当前本地时间",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => ({
        text: new Date().toLocaleString("zh-CN"),
        source: "本机时钟",
      }),
    },
  ],
};
