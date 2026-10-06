"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
function createCredentialVault(directory, safeStorage) {
  const file = path.join(directory, "credentials.dat");
  let value;
  let queue = Promise.resolve();
  async function initialize() {
    const available = safeStorage?.isAsyncEncryptionAvailable
      ? await safeStorage.isAsyncEncryptionAvailable()
      : safeStorage?.isEncryptionAvailable();
    if (!available) throw Error("Windows 凭据加密不可用，未保存明文 Key");
    if (fs.existsSync(file)) {
      const encrypted = Buffer.from(
        JSON.parse(fs.readFileSync(file, "utf8")).ciphertext,
        "base64",
      );
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      // 新版 Electron 返回 { result, shouldReEncrypt }；保留旧接口兼容。
      const plain =
        typeof decrypted === "string" ? decrypted : decrypted.result;
      value = JSON.parse(plain);
      if (decrypted.shouldReEncrypt) await persist();
    } else {
      value = { master: randomBytes(32).toString("base64"), credentials: {} };
      await persist();
    }
    return true;
  }
  async function persist() {
    const snapshot = JSON.stringify(value);
    const write = queue
      .catch(() => {})
      .then(async () => {
        const bytes = await safeStorage.encryptStringAsync(snapshot);
        fs.mkdirSync(directory, { recursive: true });
        await fs.promises.writeFile(
          file + ".tmp",
          JSON.stringify({
            schemaVersion: 1,
            ciphertext: bytes.toString("base64"),
          }),
        );
        await fs.promises.rename(file + ".tmp", file);
      });
    queue = write;
    return write;
  }
  async function set(credentials) {
    for (const [key, text] of Object.entries(credentials)) {
      if (
        !["apiKey", "visionApiKey"].includes(key) ||
        typeof text !== "string" ||
        text.length > 512 ||
        (text && !/^[\x21-\x7e]+$/.test(text))
      )
        throw Error("本机 Key 格式无效");
    }
    value.credentials = { ...value.credentials, ...credentials };
    await persist();
    return true;
  }
  return {
    initialize,
    set,
    get: () => ({ ...value.credentials }),
    getMaster: () => value.master,
  };
}
module.exports = { createCredentialVault };
