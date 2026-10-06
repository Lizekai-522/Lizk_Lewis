"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");
function windowsMaster(directory) {
  if (process.platform !== "win32") return null;
  const file = path.join(directory, "windows-master.dat");
  const encrypted = fs.existsSync(file);
  const payload = encrypted
    ? fs.readFileSync(file, "utf8")
    : randomBytes(32).toString("base64");
  const script = `Add-Type -AssemblyName System.Security; $data=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser; $result=[System.Security.Cryptography.ProtectedData]::${encrypted ? "Unprotect" : "Protect"}($data,$null,$scope); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  const executable = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = spawnSync(
    executable,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: payload,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 15000,
    },
  );
  if (result.status !== 0 || !result.stdout.trim())
    throw Error("Windows 凭据保护不可用，请从桌面版启动 Lewis；未保存明文密钥");
  if (encrypted) return result.stdout.trim();
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, result.stdout.trim());
  return payload;
}
module.exports = { windowsMaster };
