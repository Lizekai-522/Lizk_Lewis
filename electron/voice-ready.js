"use strict";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Python 导入模型依赖可能慢于页面加载，监听启动前等待真实服务，避免后台静默失败。
async function waitForVoiceService({
  checkHealth,
  startService,
  isStopped = () => false,
  sleep = delay,
  attempts = 60,
}) {
  const healthy = async () => {
    try {
      return await checkHealth();
    } catch {
      return false;
    }
  };
  if (await healthy()) return true;
  if (isStopped()) throw new Error("监听启动已取消");
  startService();
  for (let i = 0; i < attempts; i++) {
    await sleep(2000);
    if (isStopped()) throw new Error("监听启动已取消");
    if (await healthy()) return true;
  }
  throw new Error("语音服务启动超时，请从托盘检查 Python 环境和语音服务日志");
}
module.exports = { waitForVoiceService };
