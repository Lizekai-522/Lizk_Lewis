"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const yauzl = require("yauzl");
const { downloadPublic } = require("./download-public");
const featured = [
  {
    name: "Anthropic 官方 Skills",
    source: "https://github.com/anthropics/skills",
    description: "文档、设计与工作流指令技能；选择具体 SKILL.md 安装。",
  },
  {
    name: "Vercel Agent Skills",
    source: "https://github.com/vercel-labs/agent-skills",
    description: "前端与工程实践指令技能。",
  },
];
function safeName(name) {
  if (
    !name ||
    name.includes("\\") ||
    name.includes("//") ||
    name.startsWith("/") ||
    name.length > 350 ||
    name
      .split("/")
      .some(
        (part) =>
          part === ".." ||
          part === "." ||
          /[<>:"|?*\x00-\x1f]/.test(part) ||
          /[ .]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw Error("压缩包包含不安全的路径");
  return name;
}
async function unzip(bytes) {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error) return reject(Error("无法读取ZIP压缩包"));
        const files = new Map(),
          names = new Set();
        let total = 0,
          count = 0,
          finished = false;
        const fail = (error) => {
          if (finished) return;
          finished = true;
          zip.close();
          reject(error);
        };
        zip.on("error", fail);
        zip.on("end", () => {
          if (!finished) {
            finished = true;
            resolve(files);
          }
        });
        zip.on("entry", async (entry) => {
          try {
            const name = safeName(entry.fileName),
              canonical = name.toLowerCase();
            if (++count > 8000 || names.has(canonical))
              throw Error("压缩包文件过多或存在重名路径");
            names.add(canonical);
            if (entry.generalPurposeBitFlag & 1)
              throw Error("不支持加密压缩包");
            // GitHub 技能仓库常用链接共享文档；不落盘链接，也不跟随链接读取。
            if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) {
              zip.readEntry();
              return;
            }
            if (name.endsWith("/")) {
              zip.readEntry();
              return;
            }
            total += entry.uncompressedSize;
            if (
              entry.uncompressedSize > 4 * 1024 * 1024 ||
              total > 60 * 1024 * 1024
            )
              throw Error("技能包解压大小超过限制");
            if (
              name
                .split("/")
                .some((part) =>
                  [".git", "node_modules", ".venv"].includes(part),
                )
            ) {
              zip.readEntry();
              return;
            }
            const stream = await new Promise((resolve, reject) =>
              zip.openReadStream(entry, (error, stream) =>
                error ? reject(error) : resolve(stream),
              ),
            );
            const chunks = [];
            let length = 0;
            for await (const chunk of stream) {
              length += chunk.length;
              if (length > entry.uncompressedSize)
                throw Error("压缩包长度异常");
              chunks.push(chunk);
            }
            files.set(name, Buffer.concat(chunks));
            zip.readEntry();
          } catch (error) {
            fail(error);
          }
        });
        zip.readEntry();
      },
    ),
  );
}
function metadata(text, fallback) {
  const field = (key) =>
    new RegExp(`^${key}:\\s*(.+)$`, "mi")
      .exec(text)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/g, "");
  return {
    name: (field("name") || fallback).slice(0, 100),
    description: (field("description") || "Markdown 指令技能").slice(0, 600),
  };
}
function githubSource(value, ref) {
  const source = new URL(value);
  if (source.hostname !== "github.com")
    return { url: source.href, selected: "" };
  const parts = source.pathname.split("/").filter(Boolean);
  if (
    parts.length < 2 ||
    !parts.slice(0, 2).every((part) => /^[\w.-]+$/.test(part))
  )
    throw Error("请填写GitHub仓库或技能目录地址");
  if (parts[2] === "archive") return { url: source.href, selected: "" };
  const branch =
    ref || (["tree", "blob"].includes(parts[2]) ? parts[3] : "HEAD");
  const selected = ["tree", "blob"].includes(parts[2])
    ? parts
        .slice(4)
        .join("/")
        .replace(/\/SKILL\.md$/i, "")
    : "";
  return {
    url: `https://api.github.com/repos/${parts[0]}/${parts[1].replace(/\.git$/, "")}/zipball/${encodeURIComponent(branch)}`,
    selected,
  };
}
class PluginMarket {
  constructor(registry, { download = downloadPublic } = {}) {
    this.registry = registry;
    this.download = download;
    this.previews = new Map();
    this.installPending = Promise.resolve();
  }
  async catalog(query = "", signal) {
    if (!query.trim()) return { items: featured, source: "精选公开仓库" };
    if (query.length > 100) throw Error("搜索词太长");
    const response = await this.download(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query.trim() + " skill")}&per_page=10`,
      { signal, limit: 1024 * 1024 },
    );
    const data = JSON.parse(response.bytes.toString("utf8"));
    return {
      items: (data.items || []).map((item) => ({
        name: item.full_name,
        source: item.html_url,
        description: String(item.description || "").slice(0, 300),
        stars: item.stargazers_count,
      })),
      source: "GitHub实时仓库搜索",
    };
  }
  async preview(source, ref = "", signal) {
    if (
      typeof source !== "string" ||
      typeof ref !== "string" ||
      ref.length > 100
    )
      throw Error("技能来源格式无效");
    const resolved = githubSource(source, ref);
    const response = await this.download(resolved.url, { signal });
    const files =
      response.bytes.subarray(0, 2).toString() === "PK"
        ? await unzip(response.bytes)
        : new Map([["SKILL.md", response.bytes]]);
    const candidates = [];
    for (const [name, bytes] of files) {
      if (/\/SKILL\.md$|^SKILL\.md$/i.test(name)) {
        if (bytes.length > 100000) continue;
        const text = bytes.toString("utf8");
        if (!text.trim() || /^\s*<(?:!doctype|html)/i.test(text)) continue;
        const dir = path.posix.dirname(name),
          relative = dir.split("/").slice(1).join("/");
        if (
          resolved.selected &&
          relative !== resolved.selected &&
          !relative.startsWith(resolved.selected + "/")
        )
          continue;
        candidates.push({
          file: name,
          kind: "skill",
          ...metadata(text, path.posix.basename(dir)),
          preview: text.slice(0, 2500),
        });
      } else if (/\/lewis\.plugin\.json$|^lewis\.plugin\.json$/.test(name)) {
        let manifest;
        try {
          manifest = JSON.parse(bytes);
        } catch {
          continue;
        }
        if (
          !/^[a-z][a-z0-9_-]{0,23}$/.test(manifest.id) ||
          !files.has(path.posix.join(path.posix.dirname(name), "index.js"))
        )
          continue;
        candidates.push({
          file: name,
          kind: "plugin",
          name: manifest.name || manifest.id,
          description: "Lewis代码插件",
          preview: JSON.stringify(manifest, null, 2).slice(0, 2500),
        });
      }
      if (candidates.length >= 150) break;
    }
    if (!candidates.length)
      throw Error("没有找到SKILL.md或Lewis插件；请检查仓库、分支或ZIP地址");
    for (const [id, item] of this.previews)
      if (Date.now() - item.created > 600000) this.previews.delete(id);
    while (this.previews.size >= 3)
      this.previews.delete(this.previews.keys().next().value);
    const id = crypto.randomUUID();
    this.previews.set(id, { source, files, candidates, created: Date.now() });
    return { id, source, candidates };
  }
  install(previewId, file, enabled = true) {
    const job = this.installPending
      .catch(() => {})
      .then(async () => {
        const preview = this.previews.get(previewId),
          candidate = preview?.candidates.find((item) => item.file === file);
        if (
          !candidate ||
          Date.now() - preview.created > 600000 ||
          typeof enabled !== "boolean"
        )
          throw Error("下载预览已失效，请重新获取");
        const root = path.posix.dirname(file),
          manifest =
            candidate.kind === "plugin"
              ? JSON.parse(preview.files.get(file))
              : null;
        const slug =
          candidate.name
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "")
            .slice(0, 12) || "skill";
        const id =
          manifest?.id ||
          "s_" +
            slug +
            "_" +
            crypto
              .createHash("sha256")
              .update(preview.source + file)
              .digest("hex")
              .slice(0, 6);
        const folder = path.join(this.registry.root, id);
        if (fs.existsSync(folder))
          throw Error("此技能已安装，可在已安装列表启用；重装请先卸载");
        const staging = fs.mkdtempSync(
          path.join(path.dirname(this.registry.root), "plugin-staging-"),
        );
        try {
          for (const [name, bytes] of preview.files) {
            if (root !== "." && !name.startsWith(root + "/")) continue;
            const relative = root === "." ? name : name.slice(root.length + 1);
            safeName(relative);
            const target = path.join(staging, ...relative.split("/"));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, bytes);
          }
          if (!manifest)
            fs.writeFileSync(
              path.join(staging, "lewis.plugin.json"),
              JSON.stringify(
                {
                  id,
                  name: candidate.name,
                  description: candidate.description,
                  type: "skill",
                  permissions: [],
                  source: preview.source,
                },
                null,
                2,
              ),
            );
          fs.writeFileSync(
            path.join(staging, "lewis-source.json"),
            JSON.stringify({
              source: preview.source,
              installedAt: new Date().toISOString(),
              type: candidate.kind,
            }),
          );
          fs.renameSync(staging, folder);
          await this.registry.reload();
          const result = await this.registry.configure({
            kind: "plugin",
            id,
            enabled,
          });
          return {
            ...result,
            installed: { id, name: candidate.name, kind: candidate.kind },
          };
        } finally {
          if (fs.existsSync(staging)) {
            if (
              path.dirname(path.resolve(staging)) !==
              path.resolve(path.dirname(this.registry.root))
            )
              throw Error("暂存路径越界");
            fs.rmSync(staging, { recursive: true, force: true });
          }
        }
      });
    this.installPending = job;
    return job;
  }
}
module.exports = { PluginMarket, unzip, safeName, githubSource, metadata };
