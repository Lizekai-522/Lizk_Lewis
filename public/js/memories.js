(() => {
  const $ = (id) => document.getElementById(id);
  async function api(path = "", body, method = "POST") {
    const response = await fetch(
      "/api/memories" + path,
      body === undefined
        ? {}
        : {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const data = await window.readJSONResponse(response, "长期记忆");
    if (!response.ok) throw Error(data.error);
    return data;
  }
  async function refresh() {
    const data = await api();
    $("memoryEnabled").checked = data.enabled;
    $("memoryList").replaceChildren();
    for (const item of data.items) {
      const row = document.createElement("div");
      const input = document.createElement("input");
      input.value = item.text;
      input.setAttribute("aria-label", "编辑记忆");
      const save = document.createElement("button");
      save.textContent = "保存";
      save.onclick = () =>
        run(() =>
          api("", { id: item.id, category: item.category, text: input.value }),
        );
      const remove = document.createElement("button");
      remove.textContent = "删除";
      remove.onclick = () => run(() => api("/" + item.id, {}, "DELETE"));
      row.append(
        document.createTextNode(item.category + " "),
        input,
        save,
        remove,
      );
      $("memoryList").append(row);
    }
  }
  async function run(operation) {
    try {
      await operation();
      await refresh();
      $("memoryStatus").textContent = "记忆已更新";
    } catch (error) {
      $("memoryStatus").textContent = error.message;
    }
  }
  $("memoryAdd").onclick = () =>
    run(() =>
      api("", {
        category: $("memoryCategory").value,
        text: $("memoryText").value,
      }),
    );
  $("memoryEnabled").onchange = () =>
    run(() => api("/config", { enabled: $("memoryEnabled").checked }));
  refresh().catch((error) => ($("memoryStatus").textContent = error.message));
})();
