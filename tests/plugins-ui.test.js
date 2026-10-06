const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

async function fixture() {
  const dom = new JSDOM(
    fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8"),
    { url: "http://localhost:3000", runScripts: "outside-only" },
  );
  const window = dom.window,
    posted = [];
  const state = {
    directory: "test-plugins",
    plugins: [
      {
        id: "notes",
        name: "笔记工具",
        enabled: true,
        config: { folder: "keep-this-folder" },
        voiceCommands: [],
        ui: [],
      },
    ],
    mcp: [
      {
        id: "existing",
        name: "天气助手",
        enabled: true,
        connected: true,
        url: "https://example.com/mcp",
        permissions: ["web"],
        hasToken: true,
      },
    ],
  };
  window.fetch = async (_url, options) => {
    if (options.body) posted.push(JSON.parse(options.body));
    return new Response(JSON.stringify(state), {
      headers: { "Content-Type": "application/json" },
    });
  };
  for (const script of ["http", "friendly-errors", "plugins"])
    window.eval(
      fs.readFileSync(
        path.join(__dirname, "../public/js", script + ".js"),
        "utf8",
      ),
    );
  await new Promise((resolve) => setTimeout(resolve, 10));
  return {
    window,
    dom,
    posted,
    state,
    $: (id) => window.document.getElementById(id),
  };
}

test("插件列表以中文状态呈现，编辑配置默认折叠；启停不会误用未保存的配置文本", async () => {
  const f = await fixture();
  try {
    assert.doesNotMatch(
      f.$("pluginsPage").textContent,
      /nullnull|添加 MCP（JSON）/,
    );
    assert.match(f.$("pluginsList").textContent, /天气助手[\s\S]*已连接/);
    const row = f.$("pluginsList").firstElementChild;
    assert.equal(row.querySelector("details").open, false);
    row.querySelector("textarea").value = "unsaved invalid text";
    const checkbox = row.querySelector("input");
    checkbox.checked = false;
    await checkbox.onchange();
    assert.deepEqual(f.posted[0].config, { folder: "keep-this-folder" });
    assert.equal(f.posted[0].enabled, false);
    assert.equal(f.$("mcpConfig").closest("details").open, false);
    assert.equal(
      f.$("mcpForm").closest("[data-plugin-page]").dataset.pluginPage,
      "mcp",
    );
  } finally {
    f.dom.window.close();
  }
});

test("普通连接表单支持中文名称和本机逐行参数；修改连接保留服务编号与已有密钥", async () => {
  const f = await fixture();
  try {
    f.$("mcpName").value = "我的天气工具";
    f.$("mcpUrl").value = "https://example.com/mcp";
    f.$("mcpEnabled").checked = false;
    await f.$("mcpForm").onsubmit({ preventDefault() {} });
    assert.match(f.posted[0].id, /^[a-z][a-z0-9_-]{0,23}$/);
    assert.equal(f.posted[0].server.name, "我的天气工具");
    assert.equal(f.posted[0].server.url, "https://example.com/mcp");
    assert.equal(f.posted[0].enabled, false);
    f.$("mcpName").value = "本机工具";
    f.$("mcpTransport").value = "local";
    f.$("mcpTransport").onchange();
    f.$("mcpCommand").value = "C:\\Program Files\\nodejs\\node.exe";
    f.$("mcpArgs").value = "--flag\nC:\\My Tools\\service.js";
    await f.$("mcpForm").onsubmit({ preventDefault() {} });
    assert.deepEqual(f.posted[1].server.args, [
      "--flag",
      "C:\\My Tools\\service.js",
    ]);
    assert.equal(f.posted[1].server.url, undefined);
    [...f.$("pluginsList").querySelectorAll("button")]
      .find((button) => button.textContent === "修改连接")
      .click();
    assert.equal(f.$("mcpName").value, "天气助手");
    assert.match(f.$("mcpToken").placeholder, /已保存/);
    await f.$("mcpForm").onsubmit({ preventDefault() {} });
    assert.equal(f.posted[2].id, "existing");
    assert.equal(f.posted[2].server.token, undefined);
    assert.deepEqual(f.posted[2].server.permissions, ["web"]);
  } finally {
    f.dom.window.close();
  }
});

test("连接地址与导入文本错误显示中文说明，不发送无效请求", async () => {
  const f = await fixture();
  try {
    f.$("mcpName").value = "天气";
    f.$("mcpUrl").value = "wrong address";
    await f.$("mcpForm").onsubmit({ preventDefault() {} });
    assert.match(f.$("pluginsStatus").textContent, /完整服务地址/);
    assert.equal(f.$("mcpConnect").disabled, false);
    f.$("mcpConfig").value = "{ broken";
    await f.$("mcpSave").onclick();
    assert.match(f.$("pluginsStatus").textContent, /配置文本不完整/);
    assert.equal(f.posted.length, 0);
  } finally {
    f.dom.window.close();
  }
});
