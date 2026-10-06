"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
class Database {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, "lewis.sqlite");
    this.media = path.join(directory, "media");
    fs.mkdirSync(directory, { recursive: true });
    this.withDB((db) =>
      db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings(namespace TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,created_at INTEGER,updated_at INTEGER,summary TEXT);
    CREATE TABLE IF NOT EXISTS messages(session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,seq INTEGER,role TEXT,content TEXT,important INTEGER,attachments TEXT,PRIMARY KEY(session_id,seq));
    CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,category TEXT,text TEXT,updated_at INTEGER,payload TEXT);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,kind TEXT,state TEXT,message TEXT,due_at INTEGER,updated_at INTEGER,payload TEXT);
    CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,seq);CREATE INDEX IF NOT EXISTS memories_category ON memories(category);CREATE INDEX IF NOT EXISTS tasks_state_due ON tasks(state,due_at);`),
    );
  }
  withDB(operation) {
    const db = new DatabaseSync(this.file, { timeout: 5000 });
    try {
      db.exec("PRAGMA foreign_keys=ON;");
      return operation(db);
    } finally {
      db.close();
    }
  }
  transaction(operation) {
    return this.withDB((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  get(namespace, fallback) {
    return this.withDB((db) => {
      const row = db
        .prepare("SELECT value FROM settings WHERE namespace=?")
        .get(namespace);
      return row ? JSON.parse(row.value) : fallback;
    });
  }
  set(namespace, value) {
    return this.withDB((db) =>
      db
        .prepare(
          "INSERT INTO settings VALUES(?,?) ON CONFLICT(namespace) DO UPDATE SET value=excluded.value",
        )
        .run(namespace, JSON.stringify(value)),
    );
  }
  migrate(namespace, file, fallback) {
    const current = this.get(namespace, null);
    if (current !== null) return current;
    const value = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : fallback;
    this.set(namespace, value);
    return value;
  }
  rows(table) {
    if (!["memories", "tasks"].includes(table)) throw Error("表名无效");
    return this.withDB((db) =>
      db
        .prepare("SELECT payload FROM " + table)
        .all()
        .map((row) => JSON.parse(row.payload)),
    );
  }
  saveRows(table, items) {
    if (!["memories", "tasks"].includes(table)) throw Error("表名无效");
    return this.transaction((db) => {
      db.exec("DELETE FROM " + table);
      const statement = db.prepare(
        table === "memories"
          ? "INSERT INTO memories VALUES(?,?,?,?,?)"
          : "INSERT INTO tasks VALUES(?,?,?,?,?,?,?)",
      );
      for (const item of items)
        if (table === "memories")
          statement.run(
            item.id,
            item.category,
            item.text,
            item.updatedAt || 0,
            JSON.stringify(item),
          );
        else
          statement.run(
            item.id,
            item.kind,
            item.state,
            item.message,
            item.dueAt || null,
            item.updatedAt || 0,
            JSON.stringify(item),
          );
    });
  }
  saveMedia(image) {
    const bytes = Buffer.from(image.split(",")[1], "base64");
    const id = createHash("sha256").update(bytes).digest("hex");
    fs.mkdirSync(this.media, { recursive: true });
    const file = path.join(this.media, id + ".jpg");
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
    return id;
  }
  backup({ fresh = false } = {}) {
    const directory = path.join(this.directory, "backups");
    fs.mkdirSync(directory, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(
      directory,
      `lewis-${date}${fresh ? "-" + Date.now() : ""}.sqlite`,
    );
    if (!fs.existsSync(file)) {
      this.withDB((db) => db.prepare("VACUUM INTO ?").run(file));
      if (fs.existsSync(this.media))
        fs.cpSync(this.media, file.replace(/\.sqlite$/, "-media"), {
          recursive: true,
        });
    }
    return file;
  }
  export({ includeMedia = true } = {}) {
    const sessions = this.withDB((db) =>
      db
        .prepare("SELECT * FROM sessions")
        .all()
        .map((item) => ({
          id: item.id,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          summary: item.summary,
          messages: db
            .prepare(
              "SELECT role,content,important,attachments FROM messages WHERE session_id=? ORDER BY seq",
            )
            .all(item.id)
            .map((message) => ({
              role: message.role,
              content: message.content,
              important: Boolean(message.important),
              attachments: JSON.parse(message.attachments || "[]"),
            })),
        })),
    );
    const assets = {};
    let total = 0;
    if (includeMedia)
      for (const id of new Set(
        sessions.flatMap((item) =>
          item.messages.flatMap((message) =>
            (message.attachments || []).map((image) => image.id),
          ),
        ),
      )) {
        if (!/^[a-f0-9]{64}$/.test(id)) continue;
        const file = path.join(this.media, id + ".jpg");
        if (!fs.existsSync(file)) continue;
        const bytes = fs.readFileSync(file);
        total += bytes.length;
        if (total > 40 * 1024 * 1024)
          throw Error("附件超过单次导出40MB限制，请使用数据库与图片备份");
        assets[id] = bytes.toString("base64");
      }
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      sessions,
      memories: this.rows("memories"),
      tasks: this.rows("tasks"),
      assets,
    };
  }
  mergeImport(data) {
    // Validate the complete payload before changing tables. Imported scheduled tasks stay inactive.
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
    const invalid = () => {
      throw Error("导入数据格式或容量无效");
    };
    if (
      data?.schemaVersion !== 1 ||
      !["sessions", "memories", "tasks"].every(
        (key) => Array.isArray(data[key]) && data[key].length <= 1000,
      )
    )
      invalid();
    const assets = new Map();
    let total = 0;
    for (const [id, value] of Object.entries(data.assets || {})) {
      if (
        !/^[a-f0-9]{64}$/.test(id) ||
        typeof value !== "string" ||
        value.length > 512000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
      )
        invalid();
      const bytes = Buffer.from(value, "base64");
      total += bytes.length;
      if (
        total > 40 * 1024 * 1024 ||
        bytes[0] !== 255 ||
        bytes[1] !== 216 ||
        createHash("sha256").update(bytes).digest("hex") !== id
      )
        invalid();
      assets.set(id, bytes);
    }
    const sessions = data.sessions.map((item) => {
      if (
        !uuid.test(item.id) ||
        !Array.isArray(item.messages) ||
        item.messages.length > 10000 ||
        typeof (item.summary || "") !== "string"
      )
        invalid();
      const messages = item.messages.map((message) => {
        if (
          !["user", "assistant"].includes(message.role) ||
          typeof message.content !== "string" ||
          message.content.length > 1000000 ||
          !Array.isArray(message.attachments || []) ||
          (message.attachments || []).length > 3
        )
          invalid();
        const attachments = (message.attachments || []).map((image) => {
          if (
            !/^[a-f0-9]{64}$/.test(image.id) ||
            (!assets.has(image.id) &&
              !fs.existsSync(path.join(this.media, image.id + ".jpg")))
          )
            invalid();
          return {
            id: image.id,
            label: String(image.label || "图片").slice(0, 200),
          };
        });
        return {
          role: message.role,
          content: message.content,
          important: Boolean(message.important),
          attachments,
        };
      });
      return {
        id: item.id,
        createdAt: Number(item.createdAt) || Date.now(),
        updatedAt: Number(item.updatedAt) || Date.now(),
        summary: (item.summary || "").slice(0, 10000),
        messages,
      };
    });
    const memories = data.memories.map((item) => {
      if (
        !uuid.test(item.id) ||
        !["personal", "preference", "knowledge", "task"].includes(
          item.category,
        ) ||
        typeof item.text !== "string" ||
        !item.text.trim() ||
        item.text.length > 800
      )
        invalid();
      return {
        id: item.id,
        category: item.category,
        text: item.text.trim(),
        source: "import",
        updatedAt: Number(item.updatedAt) || Date.now(),
      };
    });
    const tasks = data.tasks.map((item) => {
      if (
        !uuid.test(item.id) ||
        !["chat", "reminder"].includes(item.kind) ||
        typeof item.message !== "string" ||
        item.message.length > 2000
      )
        invalid();
      return {
        id: item.id,
        kind: item.kind,
        message: item.message,
        state: "interrupted",
        error: "导入的历史任务不自动执行",
        steps: [],
        tools: [],
        sideEffects: true,
        createdAt: Number(item.createdAt) || Date.now(),
        updatedAt: Date.now(),
      };
    });
    this.backup({ fresh: true });
    fs.mkdirSync(this.media, { recursive: true });
    for (const [id, bytes] of assets) {
      const file = path.join(this.media, id + ".jpg");
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { flag: "wx" });
    }
    this.transaction((db) => {
      const sessionSQL = db.prepare(
          "INSERT OR IGNORE INTO sessions VALUES(?,?,?,?)",
        ),
        messageSQL = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?)");
      for (const item of sessions)
        if (
          sessionSQL.run(item.id, item.createdAt, item.updatedAt, item.summary)
            .changes
        )
          for (const [index, message] of item.messages.entries())
            messageSQL.run(
              item.id,
              index,
              message.role,
              message.content,
              message.important ? 1 : 0,
              JSON.stringify(message.attachments),
            );
      for (const item of memories)
        db.prepare("INSERT OR IGNORE INTO memories VALUES(?,?,?,?,?)").run(
          item.id,
          item.category,
          item.text,
          item.updatedAt,
          JSON.stringify(item),
        );
      for (const item of tasks)
        db.prepare("INSERT OR IGNORE INTO tasks VALUES(?,?,?,?,?,?,?)").run(
          item.id,
          item.kind,
          item.state,
          item.message,
          null,
          item.updatedAt,
          JSON.stringify(item),
        );
      if (
        db.prepare("SELECT count(*) AS n FROM memories").get().n > 1000 ||
        db.prepare("SELECT count(*) AS n FROM tasks").get().n > 1000
      )
        throw Error("合并后记忆或任务超过1000条");
    });
    return {
      imported: true,
      text: "已合并新会话、记忆及图片；导入的历史任务保持中断状态，不自动执行",
    };
  }
}
module.exports = { Database };
