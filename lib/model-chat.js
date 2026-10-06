"use strict";
const { consumeSSE } = require("./sse");
const { parseTool } = require("./tools");
const { executeWithRetry, normalizePlan } = require("./tool-execution");
function fitMessages(messages, tools, contextWindow, model = "") {
  const { countMessages, countText } = require("./token-budget");
  const estimate = () =>
    countMessages(messages, model) + countText(JSON.stringify(tools));
  const budget = contextWindow - Math.min(2300, Math.floor(contextWindow / 4));
  while (estimate() > budget) {
    const index = messages.findIndex(
      (item, index) =>
        index > 0 &&
        item.role === "user" &&
        !item.lewisProtected &&
        messages[index + 1]?.role === "assistant" &&
        !messages[index + 1].tool_calls &&
        !messages[index + 1].lewisProtected,
    );
    if (index < 0) break;
    messages.splice(index, 2);
  }
  while (estimate() > budget) {
    const candidates = messages
      .filter((item) => item.role === "tool" && item.content.length > 300)
      .sort((a, b) => b.content.length - a.content.length);
    if (!candidates.length)
      throw new Error(
        "本轮图像或工具结果超过上下文容量，请在设置中增大上下文窗口",
      );
    const largest = candidates[0];
    let value;
    try {
      value = JSON.parse(largest.content);
    } catch {}
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (typeof value.text === "string" && value.text.length > 120)
        value.text = value.text.slice(
          0,
          Math.max(120, Math.floor(value.text.length / 2)),
        );
      else if (value.targets?.length > 3)
        value.targets = value.targets.slice(
          0,
          Math.ceil(value.targets.length / 2),
        );
      else if (value.results?.length > 1)
        value.results = value.results.slice(
          0,
          Math.ceil(value.results.length / 2),
        );
      else throw Error("受保护的工具快照超过上下文容量，请增大窗口");
      value.truncated = true;
      largest.content = JSON.stringify(value);
    } else
      largest.content =
        largest.content.slice(
          0,
          Math.max(250, Math.floor(largest.content.length / 2)),
        ) + "（结果已截断）";
  }
}
function toolResultText(result) {
  if (result?.mode === "browser") {
    // 给页面元素留出空间，避免长正文把 snapshotId 与操作目标挤掉。
    const value = {
      ...result,
      image: undefined,
      text: result.text?.slice(0, 1800),
      links: result.links?.slice(0, 8),
      images: result.images?.slice(0, 3),
      targets: result.targets
        ?.slice(0, 25)
        .map((item) => ({ ...item, text: item.text.slice(0, 60) })),
    };
    while (JSON.stringify(value).length > 6000 && value.targets?.length)
      value.targets.pop();
    return JSON.stringify(value).slice(0, 6000);
  }
  return JSON.stringify(result).slice(0, 6000);
}
async function streamConversation({
  config,
  messages,
  tools = [],
  signal,
  onEvent,
  execute,
  parseCall = parseTool,
  plan = false,
  getSteering = () => [],
  beforeStep = async () => {},
  fetchImpl = fetch,
}) {
  let fullContent = "",
    toolCount = 0;
  if (plan && tools.length) {
    try {
      const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          stream: true,
          max_tokens: 600,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content:
                '将用户任务分成最多8个简短步骤。只输出JSON对象 {"steps":["步骤"]}。步骤是计划，不是完成声明；不要执行任何操作。可用工具：' +
                tools.map((tool) => tool.function.name).join(","),
            },
            {
              role: "user",
              content: JSON.stringify(messages.at(-1).content).slice(0, 3000),
            },
          ],
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error("计划服务不可用");
      }
      let text = "";
      await consumeSSE(response.body, (data) => {
        text += data.choices?.[0]?.delta?.content || "";
      });
      const steps = normalizePlan(text);
      onEvent({ plan: { steps, phase: "planned" } });
      messages[0] = {
        ...messages[0],
        content:
          messages[0].content +
          "\n本轮执行计划：" +
          JSON.stringify(steps) +
          "。按实际工具结果推进，失败时修正计划，不能声称未执行的步骤已完成。",
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      onEvent({
        plan: { steps: [], phase: "fallback", reason: error.message },
      });
    }
  }
  const maxRounds = plan ? 12 : 5;
  const maxTools = plan ? 20 : 6;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (let round = 0; round < maxRounds; round++) {
    signal?.throwIfAborted();
    await beforeStep();
    for (const text of getSteering())
      messages.push({
        role: "user",
        content: "用户补充指令（从现在起生效）：" + text,
      });
    fitMessages(messages, tools, config.contextWindow, config.model);
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: Math.min(2000, Math.floor(config.contextWindow / 4)),
        stream_options: { include_usage: true },
        ...(/^qwen3-vl-(?:plus|flash)(?:-|$)/.test(config.model)
          ? { enable_thinking: false }
          : {}),
        ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `模型请求失败（HTTP ${response.status}），请检查 API 地址、Key、模型及工具调用支持`,
      );
    }
    if (/text\/html/i.test(response.headers.get("content-type") || "")) {
      await response.body?.cancel();
      throw new Error(
        "模型 API 返回了 HTML 页面，请填写模型的 API 地址，而不是网页地址",
      );
    }
    const calls = new Map();
    let content = "",
      finishReason;
    await consumeSSE(response.body, (data) => {
      if (data.error) throw new Error(data.error.message || "模型返回错误");
      const choice = data.choices?.[0];
      const delta = choice?.delta;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (delta?.content) {
        content += delta.content;
        fullContent += delta.content;
        onEvent({ content: delta.content });
      }
      for (const part of delta?.tool_calls || []) {
        if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 6)
          throw new Error("模型工具调用数量无效");
        const call = calls.get(part.index) || {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments)
          call.function.arguments += part.function.arguments;
        if (call.function.arguments.length > 16000)
          throw new Error("工具参数过长");
        calls.set(part.index, call);
      }
      if (data.usage) {
        for (const key of Object.keys(usage))
          usage[key] += Number(data.usage[key] || 0);
        onEvent({ usage: { ...usage } });
      }
    });
    if (finishReason === "length")
      throw new Error("模型回复过长而被截断，请缩小本次任务");
    if (!calls.size) {
      if (!fullContent.trim())
        throw new Error("模型未返回文字，请检查模型是否支持聊天");
      onEvent({ plan: { phase: "finished", toolCount } });
      return fullContent;
    }
    if (
      !tools.length ||
      round === maxRounds - 1 ||
      toolCount + calls.size > maxTools
    )
      throw new Error("工具调用达到本轮上限，请把任务拆成更小的步骤");
    const ordered = [...calls.values()];
    for (const call of ordered)
      if (!call.id || call.id.length > 128)
        throw new Error("模型工具调用 ID 无效");
    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: ordered,
    });
    for (const call of ordered) {
      toolCount++;
      let result;
      try {
        if (!tools.some((tool) => tool.function.name === call.function.name))
          throw new Error("该工具权限已关闭");
        await beforeStep();
        const command = parseCall(call);
        const web = [
          "web-search",
          "read-webpage",
          "read-current-page",
          "open-website",
          "web-click",
          "web-type",
          "web-scroll",
          "web-browse",
          "web-screenshot",
          "web-play-video",
        ].includes(command.skill);
        onEvent({
          tool: {
            name: call.function.name,
            state: "running",
            ...(web
              ? { args: { url: command.url, query: command.query } }
              : {}),
          },
        });
        result = await executeWithRetry(command, execute, signal, (retry) =>
          onEvent({
            tool: { name: call.function.name, state: "retrying", retry },
          }),
        );
        onEvent({
          tool: {
            name: call.function.name,
            state: "done",
            source: result.source || result.url,
            ...(web
              ? {
                  result: {
                    text: result.text?.slice(0, 6000),
                    url: result.url,
                    title: result.title,
                    results: result.results,
                  },
                }
              : {}),
          },
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        result = {
          error: error.message,
          correction:
            "核对参数与当前工具定义；重新读取页面获取新 snapshotId/ref。发送状态未知时不可重发。",
          parameters: tools.find(
            (tool) => tool.function.name === call.function.name,
          )?.function.parameters,
        };
        onEvent({
          tool: {
            name: call.function.name,
            state: "error",
            error: error.message,
          },
        });
      }
      // 模型只读取有限的工具文本，网页中的程序指令不会由本服务直接执行。
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolResultText(result),
      });
    }
    if (content) {
      fullContent += "\n";
      onEvent({ content: "\n" });
    }
  }
}
module.exports = { streamConversation, fitMessages, toolResultText };
