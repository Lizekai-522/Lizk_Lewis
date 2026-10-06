"use strict";
// Minimal read-only MCP stdio example. stdout is reserved for JSON-RPC.
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  let result, error;
  if (request.method === "initialize")
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "local-clock", version: "1.0.0" },
    };
  else if (request.method === "tools/list")
    result = {
      tools: [
        {
          name: "get_local_time",
          description: "读取本机当前时间",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    };
  else if (
    request.method === "tools/call" &&
    request.params.name === "get_local_time"
  )
    result = {
      content: [{ type: "text", text: new Date().toLocaleString("zh-CN") }],
    };
  else if (request.method === "ping") result = {};
  else error = { code: -32601, message: "Method not found" };
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      ...(error ? { error } : { result }),
    }) + "\n",
  );
});
