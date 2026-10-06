"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createPublicWebProxy } = require("./public-web-proxy");
const {
  PAGE_READ_SCRIPT,
  normalizeObservation,
} = require("./page-observation");

class BrowserReader {
  constructor({ allowed, launch, proxyFactory = createPublicWebProxy } = {}) {
    this.allowed = allowed || (() => true);
    this.launch = launch;
    this.proxyFactory = proxyFactory;
    this.queue = Promise.resolve();
    this.closed = false;
  }
  async read({ url, screenshot = false, signal } = {}) {
    const operation = this.queue
      .catch(() => {})
      .then(() => this.perform({ url, screenshot, signal }));
    this.queue = operation;
    return operation;
  }
  async perform({ url, screenshot, signal }) {
    const check = () => {
      if (signal?.aborted) throw signal.reason;
      if (this.closed || !this.allowed()) throw new Error("网页权限已关闭");
    };
    check();
    const proxy = this.proxyFactory({
      allowed: () => !this.closed && this.allowed(),
    });
    this.proxy = proxy;
    let browser;
    const abort = () => {
      proxy.close();
      void browser?.close().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const proxyAddress = await proxy.start();
      check();
      const candidates = [
        process.env.LEWIS_BROWSER,
        path.join(
          process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
          "Microsoft/Edge/Application/msedge.exe",
        ),
        path.join(
          process.env.ProgramFiles || "C:/Program Files",
          "Google/Chrome/Application/chrome.exe",
        ),
      ];
      const executablePath = candidates.find(
        (file) => file && fs.existsSync(file),
      );
      if (!executablePath && !this.launch)
        throw new Error("动态读取需要本机 Edge/Chrome 或 Electron 桌面版");
      browser = await (this.launch || require("puppeteer-core").launch)({
        executablePath,
        headless: true,
        args: [
          "--proxy-server=http://" + proxyAddress,
          "--proxy-bypass-list=<-loopback>",
          "--disable-quic",
        ],
        timeout: 20000,
      });
      this.browser = browser;
      check();
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      let observation,
        previous = "",
        stable = 0;
      for (let index = 0; index < 10; index++) {
        check();
        observation = await page.evaluate(PAGE_READ_SCRIPT);
        stable =
          observation.text && observation.text === previous ? stable + 1 : 0;
        previous = observation.text;
        if (index >= 4 && stable >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      check();
      const result = normalizeObservation(observation, page.url());
      if (screenshot) {
        const bytes = await page.screenshot({ type: "jpeg", quality: 60 });
        check();
        if (bytes.length > 512 * 1024) throw new Error("网页截图过大");
        result.image =
          "data:image/jpeg;base64," + Buffer.from(bytes).toString("base64");
        result.capture = "viewport";
      }
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
      await browser?.close().catch(() => {});
      proxy.close();
      this.browser = null;
      this.proxy = null;
    }
  }
  close() {
    this.closed = true;
    this.proxy?.close();
    void this.browser?.close().catch(() => {});
  }
}
module.exports = { BrowserReader };
