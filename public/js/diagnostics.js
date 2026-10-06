(() => {
  const $ = (id) => document.getElementById(id);
  async function post(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await window.readJSONResponse(response, "数据管理");
    if (!response.ok) throw Error(data.error);
    return data;
  }
  const run = (operation) => async () => {
    try {
      $("dataStatus").textContent = JSON.stringify(await operation());
    } catch (error) {
      $("dataStatus").textContent = error.message;
    }
  };
  $("dataBackup").onclick = run(() => post("/api/data/backup", {}));
  $("dataImport").onclick = run(async () => {
    const file = $("dataImportFile").files[0];
    if (!file || file.size > 12 * 1024 * 1024)
      throw Error("请选择12MB内的导出JSON");
    return post("/api/data/import", JSON.parse(await file.text()));
  });
  window.addEventListener("error", (event) => {
    void post("/api/diagnostics", {
      level: "error",
      message: String(event.message).slice(0, 4000),
    }).catch(() => {});
  });
  window.addEventListener("unhandledrejection", (event) => {
    void post("/api/diagnostics", {
      level: "error",
      message: String(event.reason?.message || event.reason).slice(0, 4000),
    }).catch(() => {});
  });
})();
