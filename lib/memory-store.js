"use strict";
const { Database } = require("./database");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const categories = new Set(["personal", "preference", "knowledge", "task"]);
class MemoryStore {
  constructor(directory) {
    this.file = path.join(directory, "memories.json");
    this.database = new Database(directory);
    this.value = this.database.migrate("memory-config", this.file, {
      enabled: true,
      items: [],
    });
    const rows = this.database.rows("memories");
    if (rows.length) this.value.items = rows;
    else if (this.value.items.length)
      this.database.saveRows("memories", this.value.items);
  }
  save() {
    this.database.set("memory-config", {
      enabled: this.value.enabled,
      items: [],
    });
    this.database.saveRows("memories", this.value.items);
  }
  list() {
    return { enabled: this.value.enabled, items: this.value.items };
  }
  put({ id, category, text, key, source = "manual" }) {
    if (
      !categories.has(category) ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 800
    )
      throw Error("记忆类别或正文无效（最多800字符）");
    const old = id
      ? this.value.items.find((item) => item.id === id)
      : key
        ? this.value.items.find((item) => item.key === key)
        : this.value.items.find(
            (item) => item.category === category && item.text === text.trim(),
          );
    if (id && !old) throw Error("记忆不存在");
    const item = {
      id: old?.id || randomUUID(),
      category,
      text: text.trim(),
      key: key || old?.key,
      source,
      updatedAt: Date.now(),
    };
    if (old) this.value.items.splice(this.value.items.indexOf(old), 1, item);
    else {
      if (this.value.items.length >= 1000)
        throw Error("记忆已达1000条，请清理后添加");
      this.value.items.push(item);
    }
    this.save();
    return item;
  }
  remove(id) {
    this.value.items = this.value.items.filter((item) => item.id !== id);
    this.save();
  }
  enabled(value) {
    if (typeof value !== "boolean") throw Error("记忆开关无效");
    this.value.enabled = value;
    this.save();
  }
  extract(text) {
    if (
      !this.value.enabled ||
      typeof text !== "string" ||
      /假如|假设|例如|引用|转发|他说|她说/.test(text)
    )
      return [];
    const candidates = [];
    for (const [pattern, category, key] of [
      [/(?:我的名字是|我叫)([^，。！？\n]{1,30})/u, "personal", "name"],
      [/(?:我喜欢|我偏好|我更喜欢)([^。！？\n]{1,120})/u, "preference", null],
      [/(?:我不喜欢|我讨厌)([^。！？\n]{1,120})/u, "preference", null],
      [/记住[：:，,\s]+([^。！？\n]{1,200})/u, "knowledge", null],
    ]) {
      const match = text.match(pattern);
      if (match)
        candidates.push(
          this.put({ category, text: match[0], key, source: "user-statement" }),
        );
    }
    return candidates;
  }
  retrieve(query, limit = 6) {
    if (!this.value.enabled) return [];
    const tokens = [
      ...new Intl.Segmenter("zh", { granularity: "word" }).segment(query),
    ]
      .filter((item) => item.isWordLike)
      .map((item) => item.segment.toLowerCase());
    return this.value.items
      .map((item) => ({
        item,
        score: tokens.reduce(
          (sum, token) =>
            sum + (item.text.toLowerCase().includes(token) ? 2 : 0),
          item.category === "personal"
            ? 3
            : item.category === "preference"
              ? 1
              : 0,
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
      .slice(0, limit)
      .map(({ item }) => ({ category: item.category, text: item.text }));
  }
}
module.exports = { MemoryStore };
