"use strict";
const { setTimeout: delay } = require("node:timers/promises");
const readOnly = new Set([
  "web-search",
  "read-webpage",
  "read-current-page",
  "weather",
  "wechat-contacts",
  "wechat-history",
  "wechat-image",
]);
async function executeWithRetry(
  command,
  execute,
  signal,
  onRetry = () => {},
  wait = delay,
) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await execute(command, signal);
    } catch (error) {
      if (
        signal?.aborted ||
        attempt >= 2 ||
        !readOnly.has(command.skill) ||
        !/HTTP (?:429|5\d\d)|fetch failed|ECONN|ETIMEDOUT|timeout|超时/i.test(
          error.message,
        )
      )
        throw error;
      onRetry(attempt + 1);
      await wait(300 * 2 ** attempt, undefined, { signal });
    }
  }
}
function isComplexTask(message) {
  return /然后|再(?:去|把|帮|打开|读取)|先.{2,}再|逐步|分别|整理.{0,20}发送|对比.{0,30}总结/u.test(
    message,
  );
}
function normalizePlan(text) {
  const value = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const steps = Array.isArray(value) ? value : value.steps;
  if (
    !Array.isArray(steps) ||
    !steps.length ||
    steps.length > 8 ||
    steps.some(
      (step) => typeof step !== "string" || !step.trim() || step.length > 180,
    )
  )
    throw Error("任务计划格式无效");
  return steps;
}
module.exports = { executeWithRetry, isComplexTask, normalizePlan };
