"use strict";
const { Database } = require("./database");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
class TaskStore extends EventEmitter {
  constructor(directory, { now = Date.now } = {}) {
    super();
    this.file = path.join(directory, "tasks.json");
    this.now = now;
    this.database = new Database(directory);
    this.items = this.database.get("tasks-migrated", false)
      ? this.database.rows("tasks")
      : fs.existsSync(this.file)
        ? JSON.parse(fs.readFileSync(this.file, "utf8"))
        : [];
    this.database.set("tasks-migrated", true);
    this.runtime = new Map();
    for (const task of this.items)
      if (
        ["running", "paused", "queued"].includes(task.state) &&
        task.kind !== "reminder"
      ) {
        task.state = "interrupted";
        task.error = "上次运行中断，未自动重发操作";
      }
    this.save();
  }
  save() {
    this.database.saveRows("tasks", this.items);
  }
  list() {
    return this.items
      .slice(-100)
      .reverse()
      .map((item) => ({
        ...item,
        canRetry:
          ["failed", "interrupted"].includes(item.state) && !item.sideEffects,
      }));
  }
  create(message, sessionId, controller) {
    const task = {
      id: randomUUID(),
      kind: "chat",
      message: message.slice(0, 2000),
      sessionId,
      state: "running",
      steps: [],
      tools: [],
      createdAt: this.now(),
      updatedAt: this.now(),
      sideEffects: false,
    };
    this.items.push(task);
    if (this.items.length > 1000) this.items = this.items.slice(-1000);
    this.runtime.set(task.id, { controller, paused: false, resume: [] });
    this.save();
    this.emit("update", task);
    return task;
  }
  update(id, values) {
    const task = this.items.find((item) => item.id === id);
    if (!task) return;
    Object.assign(task, values, { updatedAt: this.now() });
    this.save();
    this.emit("update", task);
    return task;
  }
  event(id, event) {
    const task = this.items.find((item) => item.id === id);
    if (!task) return;
    if (event.plan?.steps) this.update(id, { steps: event.plan.steps });
    if (event.tool) {
      const tool = event.tool;
      const items = task.tools.slice();
      if (tool.state === "running")
        items.push({ name: tool.name, state: "running" });
      else {
        const current = items.findLast(
          (item) => item.name === tool.name && item.state === "running",
        );
        if (current)
          Object.assign(current, { state: tool.state, error: tool.error });
      }
      this.update(id, { tools: items });
    }
  }
  async gate(id, signal) {
    const runtime = this.runtime.get(id);
    signal?.throwIfAborted();
    if (!runtime?.paused) return;
    await new Promise((resolve, reject) => {
      const abort = () => {
        signal?.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      const done = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      runtime.resume.push(done);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
  }
  control(id, action) {
    const runtime = this.runtime.get(id);
    const task = this.items.find((item) => item.id === id);
    if (!task) throw Error("任务不存在");
    if (action === "cancel") {
      runtime?.controller.abort();
      if (runtime) for (const done of runtime.resume.splice(0)) done();
      return this.update(id, { state: "cancelled" });
    }
    if (!runtime || !["pause", "resume"].includes(action))
      throw Error("任务已结束或动作无效");
    runtime.paused = action === "pause";
    if (!runtime.paused) for (const done of runtime.resume.splice(0)) done();
    return this.update(id, { state: runtime.paused ? "paused" : "running" });
  }
  finish(id, state, error = "") {
    const task = this.items.find((item) => item.id === id);
    this.runtime.delete(id);
    if (task?.state === "cancelled") return;
    return this.update(id, { state, error });
  }
  reminder(text, dueAt) {
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 500 ||
      !Number.isFinite(dueAt) ||
      dueAt <= this.now()
    )
      throw Error("提醒内容或时间无效");
    const task = {
      id: randomUUID(),
      kind: "reminder",
      message: text.trim(),
      dueAt,
      state: "scheduled",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.items.push(task);
    this.save();
    return task;
  }
  tick() {
    for (const task of this.items)
      if (
        task.kind === "reminder" &&
        task.state === "scheduled" &&
        task.dueAt <= this.now()
      ) {
        this.update(task.id, { state: "notified" });
        this.emit("reminder", task);
      }
  }
  start() {
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), 1000);
      this.timer.unref();
      this.tick();
    }
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const runtime of this.runtime.values()) runtime.controller.abort();
  }
}
module.exports = { TaskStore };
