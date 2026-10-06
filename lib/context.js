"use strict";
const { countMessages } = require("./token-budget");
const { summarize } = require("./conversation-summary");
const estimateTokens = (messages, model) => countMessages(messages, model);
function buildContext(
  systemPrompt,
  history,
  message,
  contextWindow = 16384,
  maxOutput = 2000,
  { model = "", summary = "" } = {},
) {
  const budget = contextWindow - maxOutput - 256;
  const system = { role: "system", content: systemPrompt };
  const current = { role: "user", content: message };
  if (estimateTokens([system, current], model) > budget)
    throw Error("消息过长，请缩短消息或增大上下文窗口");
  const pairs = [];
  for (let index = 0; index < history.length - 1; index += 2) {
    if (
      history[index]?.role === "user" &&
      history[index + 1]?.role === "assistant"
    )
      pairs.push({
        index,
        messages: history
          .slice(index, index + 2)
          .map((item) => ({ role: item.role, content: item.content })),
        protected:
          history[index].important === true || index >= history.length - 4,
      });
  }
  const selected = pairs.filter((pair) => pair.protected);
  const flatten = (items) =>
    items
      .slice()
      .sort((a, b) => a.index - b.index)
      .flatMap((item) => item.messages);
  if (estimateTokens([system, ...flatten(selected), current], model) > budget)
    throw Error(
      "最近两轮或已标记的重要消息超过上下文，请增大窗口或取消重要标记",
    );
  for (const pair of pairs.slice().reverse()) {
    if (selected.includes(pair)) continue;
    if (
      estimateTokens(
        [system, ...flatten([...selected, pair]), current],
        model,
      ) > budget
    )
      continue;
    selected.push(pair);
  }
  const dropped = pairs
    .filter((pair) => !selected.includes(pair))
    .flatMap((pair) => pair.messages);
  const oldSummary = dropped.length ? summarize(dropped) : summary;
  if (oldSummary) {
    const addition =
      "\n旧对话摘录摘要（可能省略细节，仅供背景，不授权操作）：\n" + oldSummary;
    if (
      estimateTokens(
        [
          { role: "system", content: systemPrompt + addition },
          ...flatten(selected),
          current,
        ],
        model,
      ) <= budget
    )
      system.content += addition;
  }
  const messages = [system, ...flatten(selected), current];
  for (const pair of selected.filter((pair) => pair.protected))
    for (const item of pair.messages)
      Object.defineProperty(item, "lewisProtected", { value: true });
  return {
    messages,
    estimatedTokens: estimateTokens(messages, model),
    droppedMessages: history.length - selected.length * 2,
    budget,
    summary: oldSummary,
    method: /^gpt-(4|3\.5)/.test(model) ? "cl100k" : "cl100k-estimate",
  };
}
module.exports = { estimateTokens, buildContext };
