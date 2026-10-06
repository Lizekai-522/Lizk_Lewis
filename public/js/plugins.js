"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  let commands = [];
  let marketPreview;
  let editingConnection = "";
  function connectionMode() {
    const local = $("mcpTransport").value === "local";
    $("mcpLocalFields").hidden = !local;
    $("mcpRemoteFields").hidden = local;
  }
  function resetConnection() {
    editingConnection = "";
    $("mcpForm").reset();
    $("mcpToken").placeholder = "仅在工具要求时填写";
    $("mcpCancelEdit").hidden = true;
    $("mcpConnect").textContent = "保存并连接";
    connectionMode();
  }
  function editConnection(item) {
    editingConnection = item.id;
    $("mcpName").value = item.name || "外部工具";
    $("mcpTransport").value = item.url ? "remote" : "local";
    $("mcpUrl").value = item.url || "";
    $("mcpCommand").value = item.command || "";
    $("mcpArgs").value = (item.args || []).join("\n");
    $("mcpToken").value = "";
    $("mcpToken").placeholder = item.hasToken
      ? "已保存密钥；留空保留"
      : "仅在工具要求时填写";
    $("mcpEnabled").checked = item.enabled;
    for (const box of document.querySelectorAll("[data-mcp-permission]"))
      box.checked = (item.permissions || []).includes(
        box.dataset.mcpPermission,
      );
    $("mcpCancelEdit").hidden = false;
    $("mcpConnect").textContent = "保存修改";
    connectionMode();
    document.querySelector('[data-plugin-tab="mcp"]').click();
    $("mcpName").focus();
  }
  function connectionRequest() {
    const name = $("mcpName").value.trim();
    if (!name) throw Error("请先给这个工具取个名称。");
    const server = {
      name,
      permissions: [
        ...document.querySelectorAll("[data-mcp-permission]:checked"),
      ].map((box) => box.dataset.mcpPermission),
    };
    if ($("mcpTransport").value === "remote") {
      let url;
      try {
        url = new URL($("mcpUrl").value.trim());
      } catch {
        throw Error("请填写工具提供的完整服务地址。");
      }
      if (
        url.username ||
        url.password ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        )
      )
        throw Error("服务地址请使用安全连接；本机服务可使用本机地址。");
      server.url = url.href;
      const token = $("mcpToken").value.trim();
      if (token) server.token = token;
    } else {
      server.command = $("mcpCommand").value.trim();
      if (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(server.command))
        throw Error("请填写程序的完整路径。");
      server.args = $("mcpArgs")
        .value.split(/\r?\n/)
        .map((arg) => arg.trim())
        .filter(Boolean);
    }
    return {
      kind: "mcp",
      id:
        editingConnection ||
        "external_" + crypto.randomUUID().replaceAll("-", "").slice(0, 14),
      enabled: $("mcpEnabled").checked,
      server,
    };
  }
  async function api(endpoint = "", body) {
    const response = await fetch(
      "/api/plugins" + endpoint,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {},
    );
    const data = await window.readJSONResponse(response, "插件管理");
    if (!response.ok) throw Error(data.error);
    return data;
  }
  function render(data) {
    $("pluginsDirectory").textContent = data.directory || "暂无本机安装目录";
    $("pluginsList").replaceChildren();
    $("pluginCards").replaceChildren();
    commands = [];
    for (const [kind, items] of [
      ["plugin", data.plugins || []],
      ["mcp", data.mcp || []],
    ])
      for (const item of items) {
        const row = document.createElement("div");
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = item.enabled;
        label.append(
          checkbox,
          document.createTextNode(
            item.name || (kind === "mcp" ? "外部工具" : item.id),
          ),
        );
        const config = document.createElement("textarea");
        config.value = JSON.stringify(item.config || {}, null, 2);
        config.hidden = kind === "mcp";
        config.setAttribute("aria-label", "高级配置文本");
        const save = document.createElement("button");
        save.textContent = "保存";
        const update = (enabled, value = item.config || {}) =>
          api("", {
            kind,
            id: item.id,
            enabled,
            config: value,
            ...(kind === "mcp"
              ? {
                  server: {
                    name: item.name,
                    url: item.url,
                    command: item.command,
                    args: item.args,
                    permissions: item.permissions,
                  },
                }
              : {}),
          });
        save.onclick = () =>
          run(() => {
            let value;
            try {
              value = JSON.parse(config.value);
            } catch {
              throw Error("配置文本不完整，请检查后再保存。");
            }
            return update(checkbox.checked, value);
          });
        const remove = document.createElement("button");
        remove.textContent = kind === "mcp" ? "移除" : "卸载";
        remove.onclick = () =>
          run(() => api("/uninstall", { kind, id: item.id }));
        checkbox.setAttribute("aria-label", "启用" + (item.name || "工具"));
        checkbox.onchange = () => run(() => update(checkbox.checked));
        const advanced = document.createElement("details"),
          summary = document.createElement("summary");
        summary.textContent = "高级配置";
        if (kind === "plugin" && item.type !== "skill")
          advanced.append(summary, config, save);
        const description = document.createElement("p");
        description.className = "plugin-state";
        description.textContent =
          (kind === "mcp"
            ? "外部工具"
            : item.type === "skill"
              ? "指令技能"
              : "扩展插件") +
          " · " +
          (!item.enabled
            ? "已停用"
            : item.error
              ? "暂时不可用"
              : kind === "mcp"
                ? item.connected
                  ? "已连接"
                  : "未连接"
                : "已启用");
        row.append(label, description);
        if (item.error && item.enabled) {
          const problem = document.createElement("p");
          problem.textContent =
            window.lewisFriendlyError?.(item.error, "工具连接") ||
            "工具暂时不可用，请检查连接设置。";
          row.append(problem);
        }
        const actions = document.createElement("div");
        actions.className = "plugin-actions";
        if (kind === "mcp") {
          const edit = document.createElement("button");
          edit.textContent = "修改连接";
          edit.onclick = () => editConnection(item);
          actions.append(edit);
        }
        if (advanced.children.length) row.append(advanced);
        actions.append(remove);
        row.append(actions);
        $("pluginsList").append(row);
        if (kind === "plugin" && item.enabled && !item.error) {
          for (const command of item.voiceCommands || [])
            if (typeof command.phrase === "string")
              commands.push({ ...command, owner: item.id });
          for (const card of item.ui || []) {
            const host = document.createElement("p");
            host.textContent =
              String(card.title || "") + " · " + String(card.text || "");
            $("pluginCards").append(host);
          }
        }
      }
    if (!$("pluginsList").children.length) {
      const empty = document.createElement("p");
      empty.textContent = "还没有安装技能或添加工具。可以先去广场看看。";
      $("pluginsList").append(empty);
    }
  }
  async function run(operation) {
    try {
      render(await operation());
      $("pluginsStatus").textContent = "插件状态已更新";
      return true;
    } catch (error) {
      $("pluginsStatus").textContent =
        window.lewisFriendlyError?.(error, "插件操作") || error.message;
      return false;
    }
  }
  $("pluginsReload").onclick = () => run(() => api("/reload", {}));
  $("mcpTransport").onchange = connectionMode;
  $("mcpCancelEdit").onclick = resetConnection;
  $("mcpForm").onsubmit = async (event) => {
    event.preventDefault();
    $("mcpConnect").disabled = true;
    $("pluginsStatus").textContent = "正在保存工具连接…";
    let saved, request;
    await run(async () => {
      request = connectionRequest();
      const data = await api("", request);
      saved = data.mcp?.find((item) => item.id === request.id);
      resetConnection();
      return data;
    });
    if (saved)
      $("pluginsStatus").textContent = !request.enabled
        ? "连接信息已保存，工具已停用。"
        : saved.connected
          ? "工具已连接，Lewis 可以使用它了。"
          : "配置已保存，暂时未能连接。" +
            (window.lewisFriendlyError?.(saved.error, "工具连接") ||
              "请检查连接信息后重试。");
    $("mcpConnect").disabled = false;
  };
  $("mcpSave").onclick = () =>
    run(() => {
      let body;
      try {
        body = JSON.parse($("mcpConfig").value);
      } catch {
        throw Error("配置文本不完整，请粘贴工具提供的完整内容。");
      }
      return api("", body);
    });
  async function marketRun(operation) {
    $("marketStatus").textContent = "正在处理，请稍候…";
    try {
      await operation();
    } catch (error) {
      $("marketStatus").textContent =
        window.lewisFriendlyError?.(error, "技能下载") || error.message;
    }
  }
  async function catalog() {
    const data = await api(
      "/catalog?q=" + encodeURIComponent($("marketQuery").value),
    );
    $("marketCatalog").replaceChildren();
    for (const item of data.items) {
      const card = document.createElement("article"),
        title = document.createElement("strong"),
        description = document.createElement("p"),
        source = document.createElement("a"),
        preview = document.createElement("button");
      title.textContent = item.name;
      description.textContent = item.description;
      source.textContent = "查看来源";
      source.href = item.source;
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      preview.textContent = "查看技能";
      preview.onclick = () => {
        $("marketImport").open = true;
        $("marketSource").value = item.source;
        $("marketRef").value = "";
        previewSource();
      };
      card.append(title, description, source, preview);
      $("marketCatalog").append(card);
    }
    $("marketStatus").textContent = data.items.length
      ? data.source
      : "没有找到相关仓库，换个关键词试试。";
  }
  function showCandidate() {
    const candidate = marketPreview?.candidates.find(
      (item) => item.file === $("marketCandidates").value,
    );
    $("marketPreviewText").textContent = candidate?.preview || "";
    $("marketInstall").disabled = !candidate;
  }
  function previewSource() {
    marketPreview = null;
    $("marketCandidates").replaceChildren();
    showCandidate();
    return marketRun(async () => {
      marketPreview = await api("/preview", {
        source: $("marketSource").value.trim(),
        ref: $("marketRef").value.trim(),
      });
      for (const candidate of marketPreview.candidates)
        $("marketCandidates").add(
          new Option(
            `${candidate.name} · ${candidate.kind === "skill" ? "指令技能" : "代码插件"}`,
            candidate.file,
          ),
        );
      showCandidate();
      $("marketStatus").textContent =
        `找到${marketPreview.candidates.length}个技能，选中后可安装并应用。`;
    });
  }
  $("marketCandidates").onchange = showCandidate;
  $("marketSearch").onclick = () => marketRun(catalog);
  $("marketPreview").onclick = previewSource;
  $("marketInstall").onclick = () =>
    marketRun(async () => {
      $("marketInstall").disabled = true;
      try {
        const data = await api("/install", {
          previewId: marketPreview.id,
          file: $("marketCandidates").value,
          enabled: true,
        });
        render(data);
        const item = data.plugins.find((item) => item.id === data.installed.id);
        $("marketStatus").textContent = item?.error
          ? `已安装，但未能启用：${item.error}`
          : `“${data.installed.name}”已安装并应用，后续相关对话会使用此技能。`;
      } finally {
        showCandidate();
      }
    });
  $("pluginMarketBtn").onclick = () => {
    window.lewisNavigate("plugins");
    $("pluginMarketPanel").open = true;
    marketRun(catalog);
  };
  window.lewisPluginCommand = (text) => {
    const match = commands.find((item) => item.phrase === text.trim());
    return match
      ? {
          skill: "extension",
          name: `plugin_${match.owner}_${match.tool}`,
          args: match.args || {},
        }
      : null;
  };
  run(() => api());
})();
