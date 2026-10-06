(() => {
  const $ = (id) => document.getElementById(id);
  if (!window.electronAPI?.update) {
    $("updateStatus").textContent = "更新功能在 Electron 安装版中可用";
    return;
  }
  function render(data) {
    $("updateStatus").textContent =
      (!data.supported ? "便携版不支持自动安装；请使用安装版。 " : "") +
      (data.error || data.phase);
    $("updateNotes").textContent = data.notes || "";
    if (data.config) {
      $("updateURL").value = data.config.url;
      $("updateChannel").value = data.config.channel;
      $("updateAutoCheck").checked = data.config.autoCheck;
    }
    if (data.rollbacks) {
      $("updateRollbackVersion").replaceChildren();
      for (const item of data.rollbacks)
        $("updateRollbackVersion").add(new Option(item.version, item.version));
    }
  }
  const run = (action, value) => async () => {
    try {
      render(
        await window.electronAPI.update(
          action,
          typeof value === "function" ? value() : value,
        ),
      );
    } catch (error) {
      $("updateStatus").textContent = error.message;
    }
  };
  $("updateSave").onclick = run("configure", () => ({
    url: $("updateURL").value.trim(),
    channel: $("updateChannel").value,
    autoCheck: $("updateAutoCheck").checked,
  }));
  $("updateCheck").onclick = run("check");
  $("updateDownload").onclick = run("download");
  $("updateInstall").onclick = run("install");
  $("updateRollback").onclick = run("rollback", () => ({
    version: $("updateRollbackVersion").value,
  }));
  const off = window.electronAPI.onUpdate(render);
  window.addEventListener("pagehide", off);
  run("status")();
})();
