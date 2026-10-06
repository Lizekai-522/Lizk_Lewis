const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
  PluginMarket,
  unzip,
  safeName,
  githubSource,
} = require("../lib/plugin-market");
const { PluginRegistry } = require("../lib/plugin-registry");
function zipFiles(files, symlinks = []) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(text),
      filename = Buffer.from(name);
    let crc = -1;
    for (const n of bytes) {
      crc ^= n;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ -1) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    if (symlinks.includes(name)) central.writeUInt32LE(0xa1ff0000, 38);
    locals.push(header, filename, bytes);
    centrals.push(central, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const c = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(c.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, c, end]);
}
test("GitHub目录、分支和公网ZIP来源转换；ZIP路径越界/设备名被拒绝", async () => {
  const value = githubSource(
    "https://github.com/org/repo/tree/main/skills/weather",
  );
  assert.equal(value.url, "https://api.github.com/repos/org/repo/zipball/main");
  assert.equal(value.selected, "skills/weather");
  assert.equal(
    githubSource("https://example.com/skills.zip").url,
    "https://example.com/skills.zip",
  );
  for (const name of [
    "../outside",
    "root/../../x",
    "root/CON.txt",
    "C:/bad",
    "root\\bad",
  ])
    assert.throws(() => safeName(name));
  await assert.rejects(unzip(zipFiles({ "../outside": "no" })));
  const ordinary = await unzip(
    zipFiles({ "repo/SKILL.md": "说明", "repo/link": "../other" }, [
      "repo/link",
    ]),
  );
  assert.equal(ordinary.has("repo/SKILL.md"), true);
  assert.equal(ordinary.has("repo/link"), false);
});
test("从ZIP选择技能安装、支持文件读取、启停、卸载；不会运行Markdown中的脚本", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lewis-market-"));
  const registry = new PluginRegistry(directory, {
    capabilities: { require() {} },
  });
  const bytes = zipFiles({
    "repo/skills/weather/SKILL.md":
      "---\nname: weather\ndescription: 查天气的步骤\n---\n请先搜索天气来源。",
    "repo/skills/weather/references/guide.md": "准确注明时间",
    "repo/skills/weather/scripts/run.js": 'throw Error("do not run")',
    "repo/skills/other/SKILL.md": "---\nname: other\n---\n另一技能",
  });
  const market = new PluginMarket(registry, {
    download: async () => ({ bytes }),
  });
  try {
    const preview = await market.preview(
      "https://github.com/org/repo/tree/main/skills/weather",
    );
    assert.equal(preview.candidates.length, 1);
    const installed = await market.install(
      preview.id,
      preview.candidates[0].file,
      true,
    );
    assert.equal(installed.installed.kind, "skill");
    const tool = registry.tools()[0].function.name;
    assert.match(
      (await registry.execute({ name: tool, args: {} })).text,
      /请先搜索/,
    );
    assert.match(
      (
        await registry.execute({
          name: tool,
          args: { file: "references/guide.md" },
        })
      ).text,
      /注明时间/,
    );
    await assert.rejects(
      registry.execute({ name: tool, args: { file: "../plugins.json" } }),
    );
    assert.match(registry.instructions(), /weather/);
    await registry.configure({
      kind: "plugin",
      id: installed.installed.id,
      enabled: false,
    });
    assert.equal(registry.tools().length, 0);
    await registry.uninstall("plugin", installed.installed.id);
    assert.equal(registry.list().plugins.length, 0);
  } finally {
    await registry.close();
    assert.ok(directory.startsWith(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("直接SKILL.md安装应用与重复安装/失效预览处理", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lewis-rawskill-"));
  const registry = new PluginRegistry(directory);
  const market = new PluginMarket(registry, {
    download: async () => ({
      bytes: Buffer.from(
        "---\nname: concise\ndescription: 简短回答\n---\n尽量简短。",
      ),
    }),
  });
  try {
    const preview = await market.preview("https://example.com/SKILL.md");
    const result = await market.install(preview.id, preview.candidates[0].file);
    assert.equal(result.plugins[0].enabled, true);
    assert.match(registry.instructions(), /concise/);
    await assert.rejects(
      market.install(preview.id, preview.candidates[0].file),
      /已安装/,
    );
    await assert.rejects(market.install("invalid", "SKILL.md"), /失效/);
  } finally {
    await registry.close();
    assert.ok(directory.startsWith(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("技能下载检查每次跳转、拒绝私网和过大响应", async () => {
  const { downloadPublic } = require("../lib/download-public");
  let calls = 0;
  await assert.rejects(
    downloadPublic("https://public.test/a", {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      fetchImpl: () => {
        calls++;
      },
    }),
    /内网/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    downloadPublic("https://public.test/a", {
      lookup: async (host) => [
        {
          address: host === "public.test" ? "8.8.8.8" : "127.0.0.1",
          family: 4,
        },
      ],
      fetchImpl: async () =>
        new Response("", {
          status: 302,
          headers: { Location: "https://private.test/x" },
        }),
    }),
    /内网/,
  );
  await assert.rejects(
    downloadPublic("https://public.test/a", {
      limit: 4,
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetchImpl: async () => new Response("too big"),
    }),
    /大小限制/,
  );
});
