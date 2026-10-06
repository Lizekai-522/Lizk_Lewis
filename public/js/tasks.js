(() => {
  const $ = (id) => document.getElementById(id);
  const friendly = (error) =>
    window.lewisFriendlyError?.(error, "任务") || "任务没有完成，请重试。";
  const states = {
    running: "正在执行",
    paused: "已暂停",
    scheduled: "等待提醒",
    finished: "已完成",
    completed: "已完成",
    failed: "未完成",
    cancelled: "已取消",
    canceled: "已取消",
    pending: "等待执行",
  };
  async function request(url, body) {
    const response = await fetch(
      url,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {},
    );
    const data = await window.readJSONResponse(response, "任务");
    if (!response.ok) throw Error(data.error);
    return data;
  }
  async function refresh() {
    const data = await request("/api/tasks");
    $("tasksList").replaceChildren();
    for (const task of data.tasks.slice(0, 20)) {
      const row = document.createElement("div");
      row.textContent = `${task.message} · ${states[task.state] || "状态已更新"} ${task.error ? friendly(task.error) : ""}`;
      for (const action of task.state === "running"
        ? ["pause", "cancel"]
        : task.state === "paused"
          ? ["resume", "cancel"]
          : task.state === "scheduled"
            ? ["cancel"]
            : []) {
        const button = document.createElement("button");
        button.textContent = { pause: "暂停", resume: "继续", cancel: "取消" }[
          action
        ];
        button.onclick = async () => {
          try {
            await request("/api/tasks/" + task.id + "/control", { action });
            await refresh();
          } catch (error) {
            $("tasksStatus").textContent = friendly(error);
          }
        };
        row.append(button);
      }
      if (task.canRetry) {
        const button = document.createElement("button");
        button.textContent = "重新执行只读任务";
        button.onclick = () => {
          $("messageInput").value = task.message;
          $("sendBtn").click();
        };
        row.append(button);
      }
      $("tasksList").append(row);
    }
  }
  $("reminderAdd").onclick = async () => {
    try {
      await request("/api/reminders", {
        text: $("reminderText").value,
        dueAt: new Date($("reminderTime").value).getTime(),
      });
      await refresh();
    } catch (error) {
      $("tasksStatus").textContent = friendly(error);
    }
  };
  const events = new EventSource("/api/tasks/events");
  events.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "reminder") {
      $("tasksStatus").textContent = "提醒：" + data.task.message;
      await window.lewisProactiveSay?.("提醒：" + data.task.message, {
        label: "定时提醒",
      });
    }
    if (!$("skillPanel").hidden) refresh().catch(() => {});
  };
  window.addEventListener("pagehide", () => events.close());
  refresh().catch((error) => ($("tasksStatus").textContent = friendly(error)));
})();
