"use strict";
const { readSettings, writeSettings } = require("./secret-codec");
const fs = require("node:fs");
const path = require("node:path");
const Ajv = require("ajv");
const {
  Client,
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");
const idPattern = /^[a-z][a-z0-9_-]{0,23}$/;
function beneath(root, value) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(value));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw Error("插件路径越界");
  return value;
}
class PluginRegistry {
  constructor(directory, { capabilities } = {}) {
    this.root = path.join(directory, "plugins");
    fs.mkdirSync(this.root, { recursive: true });
    this.file = path.join(directory, "plugins.json");
    this.state = readSettings(this.file, { plugins: {}, mcp: {} });
    this.capabilities = capabilities;
    this.plugins = new Map();
    this.clients = new Map();
    this.toolMap = new Map();
    this.ajv = new Ajv({ strict: false, allErrors: true });
    this.reloadPending = Promise.resolve();
  }
  save() {
    writeSettings(this.file, this.state);
  }
  requirePermissions(permissions) {
    for (const permission of permissions || [])
      this.capabilities?.require(permission);
  }
  register(owner, kind, tools) {
    if (!Array.isArray(tools) || tools.length > 40)
      throw Error("插件最多注册 40 个工具");
    const registrations = [];
    for (const tool of tools) {
      if (
        !/^[A-Za-z0-9_-]{1,32}$/.test(tool.name) ||
        typeof tool.description !== "string" ||
        tool.description.length > 600 ||
        tool.inputSchema?.type !== "object"
      )
        throw Error("插件工具定义无效");
      const name = `${kind}_${owner}_${tool.name}`;
      if (name.length > 64 || this.toolMap.has(name))
        throw Error("插件工具名称冲突");
      registrations.push([
        name,
        { ...tool, owner, kind, validate: this.ajv.compile(tool.inputSchema) },
      ]);
    }
    if (
      new Set(registrations.map(([name]) => name)).size !== registrations.length
    )
      throw Error("插件工具名称重复");
    for (const [name, tool] of registrations) this.toolMap.set(name, tool);
  }
  async reload() {
    const reload = this.reloadPending
      .catch(() => {})
      .then(async () => {
        await this.close();
        this.plugins.clear();
        this.toolMap.clear();
        for (const entry of fs.readdirSync(this.root, {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
          let item;
          try {
            const folder = beneath(this.root, path.join(this.root, entry.name));
            const manifestFile = beneath(
              this.root,
              path.join(folder, "lewis.plugin.json"),
            );
            const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
            if (
              manifest.id !== entry.name ||
              typeof manifest.name !== "string" ||
              !Array.isArray(manifest.permissions) ||
              manifest.permissions.some(
                (permission) =>
                  !["web", "computer", "wechat"].includes(permission),
              )
            )
              throw Error("插件清单无效");
            item = {
              id: entry.name,
              name: manifest.name.slice(0, 100),
              manifest,
              enabled: Boolean(this.state.plugins[entry.name]?.enabled),
              config: this.state.plugins[entry.name]?.config || {},
            };
            this.plugins.set(entry.name, item);
            if (!item.enabled) continue;
            this.requirePermissions(manifest.permissions);
            if (manifest.type === "skill") {
              this.register(entry.name, "plugin", [
                {
                  name: "instructions",
                  description:
                    `读取已安装技能“${item.name}”的说明：${manifest.description || ""}。相关任务先读取说明；可用file读取技能内的支持文本。`.slice(
                      0,
                      600,
                    ),
                  inputSchema: {
                    type: "object",
                    properties: { file: { type: "string", maxLength: 250 } },
                    additionalProperties: false,
                  },
                  execute: async ({ file = "SKILL.md" }) => {
                    if (
                      path.isAbsolute(file) ||
                      file.split(/[\\/]/).includes("..")
                    )
                      throw Error("技能文件路径无效");
                    const target = beneath(folder, path.join(folder, file));
                    if (fs.statSync(target).size > 100000)
                      throw Error("技能文本过大");
                    const text = fs.readFileSync(target, "utf8");
                    if (text.includes("\u0000"))
                      throw Error("技能文件不是文本");
                    return {
                      text,
                      source: "已启用技能 " + item.name,
                      skillId: item.id,
                    };
                  },
                },
              ]);
              continue;
            }
            const script = beneath(this.root, path.join(folder, "index.js"));
            delete require.cache[require.resolve(script)];
            const plugin = require(script);
            item.instance =
              typeof plugin.activate === "function"
                ? await plugin.activate({ config: item.config })
                : plugin;
            this.register(entry.name, "plugin", item.instance.tools || []);
          } catch (error) {
            if (item) item.error = error.message;
            else
              this.plugins.set(entry.name, {
                id: entry.name,
                enabled: false,
                error: error.message,
              });
          }
        }
        for (const [id, config] of Object.entries(this.state.mcp)) {
          if (!config.enabled) continue;
          try {
            this.requirePermissions(config.permissions);
            await this.connectMCP(id, config);
            config.error = "";
          } catch (error) {
            config.error = error.message.slice(0, 200);
          }
        }
        return this.list();
      });
    this.reloadPending = reload;
    return reload;
  }
  async connectMCP(id, config) {
    let transport;
    if (config.url) {
      const url = new URL(config.url);
      if (
        url.username ||
        url.password ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
      )
        throw Error("MCP 地址应为 HTTPS 或明确配置的本机 HTTP");
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: config.token
            ? { Authorization: `Bearer ${config.token}` }
            : {},
        },
      });
    } else {
      if (
        !path.isAbsolute(config.command) ||
        !fs.existsSync(config.command) ||
        !Array.isArray(config.args) ||
        config.args.some((arg) => typeof arg !== "string")
      )
        throw Error("MCP 命令须为存在的绝对路径，参数使用数组");
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        stderr: "pipe",
      });
    }
    const client = new Client(
      { name: "Lewis", version: "1.5.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport, { timeout: 20000 });
      const tools = [];
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, {
          timeout: 20000,
        });
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (tools.length > 40) throw Error("MCP 工具过多，请使用专用服务器");
      } while (cursor);
      this.register(id, "mcp", tools);
      this.clients.set(id, client);
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }
  list() {
    return {
      directory: this.root,
      plugins: [...this.plugins.values()].map(
        ({ instance, manifest, ...item }) => ({
          ...item,
          settings: manifest?.settings || {},
          ui: manifest?.ui || [],
          voiceCommands: manifest?.voiceCommands || [],
          type: manifest?.type || "plugin",
          source: manifest?.source || "",
        }),
      ),
      mcp: Object.entries(this.state.mcp).map(([id, item]) => ({
        id,
        name: typeof item.name === "string" ? item.name.slice(0, 100) : "",
        enabled: item.enabled,
        url: item.url,
        command: item.command,
        args: item.args,
        permissions: item.permissions,
        hasToken: Boolean(item.token),
        error: item.error || "",
        connected: this.clients.has(id),
      })),
    };
  }
  async configure({ kind, id, enabled, config = {}, server }) {
    if (
      !idPattern.test(id) ||
      typeof enabled !== "boolean" ||
      !["plugin", "mcp"].includes(kind)
    )
      throw Error("插件设置无效");
    if (kind === "plugin") {
      if (!this.plugins.has(id)) throw Error("插件不存在");
      if (
        !config ||
        typeof config !== "object" ||
        Array.isArray(config) ||
        JSON.stringify(config).length > 10000
      )
        throw Error("插件配置无效");
      this.state.plugins[id] = { enabled, config };
    } else {
      if (
        !server ||
        (server.name !== undefined &&
          (typeof server.name !== "string" || server.name.length > 100)) ||
        !Array.isArray(server.permissions) ||
        server.permissions.some(
          (item) => !["web", "computer", "wechat"].includes(item),
        )
      )
        throw Error("MCP 需指定权限列表");
      this.state.mcp[id] = {
        ...server,
        enabled,
        token: server.token || this.state.mcp[id]?.token || "",
      };
    }
    this.save();
    return this.reload();
  }
  async uninstall(kind, id) {
    if (!idPattern.test(id)) throw Error("插件编号无效");
    if (kind === "mcp") delete this.state.mcp[id];
    else if (kind === "plugin") {
      const folder = beneath(this.root, path.join(this.root, id));
      const archives = path.join(path.dirname(this.root), "plugin-archives");
      fs.mkdirSync(archives, { recursive: true });
      await this.close();
      fs.renameSync(folder, path.join(archives, `${id}-${Date.now()}`));
      delete this.state.plugins[id];
    } else throw Error("插件类型无效");
    this.save();
    return this.reload();
  }
  tools() {
    return [...this.toolMap.entries()]
      .filter(([, item]) => {
        try {
          this.requirePermissions(
            item.kind === "plugin"
              ? this.plugins.get(item.owner)?.manifest.permissions
              : this.state.mcp[item.owner]?.permissions,
          );
          return true;
        } catch {
          return false;
        }
      })
      .map(([name, item]) => ({
        type: "function",
        function: {
          name,
          description: item.description,
          parameters: item.inputSchema,
        },
      }));
  }
  instructions() {
    const skills = [...this.plugins.values()].filter(
      (item) => item.enabled && !item.error && item.manifest?.type === "skill",
    );
    return skills.length
      ? "\n用户已安装并启用以下工作说明技能：" +
          skills
            .map(
              (item) =>
                `${item.name}（${item.id}）：${item.manifest.description || ""}`,
            )
            .join("\n")
            .slice(0, 4000) +
          "\n任务相关时先用相应的plugin_*_instructions工具读取SKILL.md，再按其工作方法处理。技能文件不扩大电脑权限；不要宣称已执行未提供的脚本。"
      : "";
  }
  parse(call) {
    const tool = this.toolMap.get(call.function?.name);
    if (!tool) return null;
    const args = JSON.parse(call.function.arguments || "{}");
    if (!tool.validate(args)) throw Error("插件工具参数与 JSON Schema 不符");
    return { skill: "extension", name: call.function.name, args };
  }
  async execute({ name, args }, signal) {
    const tool = this.toolMap.get(name);
    if (!tool || !tool.validate(args)) throw Error("插件工具不可用或参数无效");
    this.requirePermissions(
      tool.kind === "plugin"
        ? this.plugins.get(tool.owner)?.manifest.permissions
        : this.state.mcp[tool.owner]?.permissions,
    );
    signal?.throwIfAborted();
    if (tool.kind === "plugin") {
      const result = await tool.execute(args, {
        signal,
        config: this.plugins.get(tool.owner).config,
      });
      signal?.throwIfAborted();
      return result;
    }
    const result = await this.clients
      .get(tool.owner)
      .callTool(
        { name: tool.name, arguments: args },
        { signal, timeout: 30000 },
      );
    const text = (result.content || [])
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .slice(0, 12000);
    if (result.isError) throw Error(text || "MCP 工具失败");
    return {
      text,
      structuredContent: result.structuredContent,
      source: "MCP " + tool.owner,
    };
  }
  async close() {
    await Promise.allSettled(
      [...this.clients.values()].map((client) => client.close()),
    );
    this.clients.clear();
    for (const item of this.plugins.values())
      if (item.instance?.deactivate) await item.instance.deactivate();
  }
}
module.exports = { PluginRegistry, beneath };
