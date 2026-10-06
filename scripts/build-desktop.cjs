"use strict";
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const framework = path.join(
  process.env.WINDIR || "C:/Windows",
  "Microsoft.NET/Framework64/v4.0.30319",
);
const args = [
  "/nologo",
  "/target:exe",
  "/platform:x64",
  "/optimize+",
  "/out:" + path.join(root, "native/DesktopBridge.exe"),
  "/reference:System.Web.Extensions.dll",
  "/reference:System.Drawing.dll",
  "/reference:Accessibility.dll",
  ...["UIAutomationClient.dll", "UIAutomationTypes.dll", "WindowsBase.dll"].map(
    (name) => "/reference:" + path.join(framework, "WPF", name),
  ),
  path.join(root, "native/DesktopBridge.cs"),
];
const result = spawnSync(path.join(framework, "csc.exe"), args, {
  stdio: "inherit",
  windowsHide: true,
  shell: false,
});
if (result.error) throw result.error;
process.exitCode = result.status || 0;
