const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { createCredentialVault } = require("../electron/credential-vault");
const {
  setSecretKey,
  readSettings,
  writeSettings,
  seal,
  unseal,
} = require("../lib/secret-codec");
const { Database } = require("../lib/database");
test("Electron 44 异步解密对象能恢复主密钥，密钥轮换后重新加密", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "lewis-async-vault-"),
  );
  let encryptions = 0;
  const storage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (text) => {
      encryptions++;
      return Buffer.from(text);
    },
    decryptStringAsync: async (bytes) => ({
      result: bytes.toString(),
      shouldReEncrypt: true,
    }),
  };
  try {
    const vault = createCredentialVault(directory, storage);
    await vault.initialize();
    await vault.set({ apiKey: "fixture-only" });
    const master = vault.getMaster();
    const restored = createCredentialVault(directory, storage);
    await restored.initialize();
    assert.equal(restored.getMaster(), master);
    assert.equal(restored.get().apiKey, "fixture-only");
    assert.equal(encryptions, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("本机主密钥由系统加密接口保护，设置中密钥密文保存，篡改不能解密", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "lewis-credentials-"),
  );
  const calls = [];
  const key = randomBytes(32).toString("base64");
  setSecretKey(key);
  try {
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptStringAsync: async (value) => {
        calls.push("encrypt");
        return Buffer.from(value).map((byte) => byte ^ 93);
      },
      decryptStringAsync: async (value) => {
        calls.push("decrypt");
        return Buffer.from(value)
          .map((byte) => byte ^ 93)
          .toString();
      },
    };
    const vault = createCredentialVault(directory, safeStorage);
    await vault.initialize();
    await vault.set({ apiKey: "unique-api-secret" });
    assert.doesNotMatch(
      fs.readFileSync(path.join(directory, "credentials.dat"), "utf8"),
      /unique-api-secret/,
    );
    const next = createCredentialVault(directory, safeStorage);
    await next.initialize();
    assert.equal(next.get().apiKey, "unique-api-secret");
    assert.equal(calls.includes("decrypt"), true);
    const file = path.join(directory, "voice-profile.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ apiKey: "legacy-secret", model: "test" }),
    );
    assert.equal(readSettings(file, {}).apiKey, "legacy-secret");
    writeSettings(file, { apiKey: "new-secret" });
    assert.doesNotMatch(
      fs.readFileSync(file, "utf8"),
      /new-secret|legacy-secret/,
    );
    assert.doesNotMatch(
      JSON.stringify(new Database(directory).get("voice-profile.json", {})),
      /new-secret/,
    );
    assert.equal(readSettings(file, {}).apiKey, "new-secret");
    const data = seal("text");
    const bytes = Buffer.from(data.$lewisSecret, "base64");
    bytes[28] ^= 1;
    assert.throws(() => unseal({ $lewisSecret: bytes.toString("base64") }));
    await assert.rejects(vault.set({ unknown: "value" }), /格式/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
