"use strict";
const {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} = require("node:crypto");
const fs = require("node:fs");
const { Database } = require("./database");
const path = require("node:path");
let master;
function setSecretKey(value) {
  if (value === null) return;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) throw Error("凭据主密钥格式无效");
  master = bytes;
}
function seal(value) {
  if (!master) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master, iv);
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    $lewisSecret: Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString(
      "base64",
    ),
  };
}
function unseal(value) {
  if (!master)
    throw Error("凭据已加密，请通过 Lewis 桌面版或同一 Windows 用户启动");
  const bytes = Buffer.from(value.$lewisSecret, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    master,
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
function transform(value, encrypt, key = "") {
  if (
    value &&
    typeof value === "object" &&
    typeof value.$lewisSecret === "string"
  )
    return encrypt
      ? value
      : value.$lewisJSON
        ? JSON.parse(unseal(value))
        : unseal(value);
  if (
    encrypt &&
    master &&
    key === "config" &&
    value &&
    typeof value === "object"
  )
    return { ...seal(JSON.stringify(value)), $lewisJSON: true };
  if (Array.isArray(value))
    return value.map((item) => transform(item, encrypt));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        transform(item, encrypt, name),
      ]),
    );
  if (
    encrypt &&
    typeof value === "string" &&
    value &&
    /(?:api[_-]?key|token|secret|password|authorization|credential)$/i.test(key)
  )
    return seal(value);
  return value;
}
function writeSettings(file, value) {
  const stored = transform(value, true);
  const db = new Database(path.dirname(file));
  db.set(path.basename(file), stored);
  if (fs.existsSync(file)) {
    fs.writeFileSync(file + ".tmp", JSON.stringify(stored));
    fs.renameSync(file + ".tmp", file);
  }
  return value;
}
function readSettings(file, fallback) {
  const db = new Database(path.dirname(file));
  let stored = db.get(path.basename(file), null);
  if (stored === null) {
    stored = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : fallback;
    const value = transform(stored, false);
    writeSettings(file, value);
    return value;
  }
  const value = transform(stored, false);
  if (master) writeSettings(file, value);
  return value;
}
module.exports = { setSecretKey, seal, unseal, readSettings, writeSettings };
