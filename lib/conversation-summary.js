"use strict";
// Extracts retain provenance; they are not newly inferred facts or instructions.
function summarize(messages, maxLength = 1200) {
  const textMessages = messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join(" ")
      : message.content,
  }));
  const turns = textMessages.filter(
    (message) => typeof message.content === "string",
  );
  const sampled =
    turns.length > 12 ? [...turns.slice(0, 4), ...turns.slice(-8)] : turns;
  return sampled
    .map(
      (message) =>
        `${message.role === "user" ? "用户" : "助手"}：${message.content.replace(/\s+/g, " ").slice(0, 140)}`,
    )
    .join("\n")
    .slice(0, maxLength);
}
module.exports = { summarize };
