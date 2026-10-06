"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Database } = require("./database");

class SessionStore {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, "sessions.json");
    this.sessions = new Map();
    this.queue = Promise.resolve();
    fs.mkdirSync(directory, { recursive: true });
    this.database = new Database(directory);
    const migrated = this.database.get("sessions-migrated", false);
    let entries;
    if (!migrated && fs.existsSync(this.file)) {
      entries = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } else entries = this.database.export({ includeMedia: false }).sessions;
    for (const session of entries) {
      if (typeof session.id !== "string" || !Array.isArray(session.messages))
        throw Error("历史文件格式错误");
      this.sessions.set(session.id, session);
    }
    if (!migrated) {
      this.write([...this.sessions.values()]);
      this.database.set("sessions-migrated", true);
    }
  }
  get(id) {
    if (!this.sessions.has(id))
      this.sessions.set(id, { id, messages: [], createdAt: Date.now() });
    return this.sessions.get(id);
  }
  write(sessions) {
    this.database.transaction((db) => {
      db.exec("DELETE FROM messages;DELETE FROM sessions;");
      const sessionStatement = db.prepare(
        "INSERT INTO sessions VALUES(?,?,?,?)",
      );
      const messageStatement = db.prepare(
        "INSERT INTO messages VALUES(?,?,?,?,?,?)",
      );
      for (const session of sessions) {
        sessionStatement.run(
          session.id,
          session.createdAt || Date.now(),
          session.updatedAt || session.createdAt || Date.now(),
          session.summary || "",
        );
        for (const [index, message] of session.messages.entries())
          messageStatement.run(
            session.id,
            index,
            message.role,
            message.content,
            message.important ? 1 : 0,
            JSON.stringify(message.attachments || []),
          );
      }
    });
  }
  save() {
    const snapshot = JSON.parse(JSON.stringify([...this.sessions.values()]));
    const write = this.queue.catch(() => {}).then(() => this.write(snapshot));
    this.queue = write;
    return write;
  }
}
module.exports = { SessionStore };
