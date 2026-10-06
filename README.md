# Lewis 1.7.6

Lewis 是 Windows 桌面 AI 助手，支持语音唤醒、持续对话、透明桌宠、摄像头视觉、网页工具、插件与本机应用操作。

## 本版更新

- 从开始菜单、桌面快捷方式、安装注册信息和商店应用列表识别本机软件，按名称启动。
- 读取应用窗口、点击真实控件、填写输入框；自绘窗口可使用 Windows 本机 OCR 辅助识别。
- “打开 QQ 音乐，我想听歌”进入推荐播放，并通过 Windows 媒体会话核对实际歌曲和播放状态。
- 支持 QQ 音乐暂停、继续、下一首及指定歌曲搜索。
- 移除唤醒后的聆听浮窗，保留桌宠、语音应答和持续对话。

## 环境

Windows x64、Node.js 24.15 或更新版本，以及 Python 语音环境。语音依赖以 `voice-service/requirements.txt` 为准；本版使用 FunASR 1.4.16、PyTorch/torchaudio 2.8.0、Silero VAD、sherpa-onnx 和 Edge-TTS。

安装包包含 Electron 应用、语音服务源码、手势及小型唤醒模型，不包含 Python 解释器、PyTorch 环境或完整 FunASR 模型缓存。首次使用需要安装语音依赖，识别模型首次加载可能联网下载。

## 使用安装包

1. 退出旧版 Lewis 后运行 `Lewis-1.7.6-Setup-x64.exe`；免安装运行可使用 `Lewis-1.7.6-Windows-x64.exe`。
2. 创建语音 Python 环境并安装 requirements。托盘中选择“配置语音 Python 环境”，选择该环境的 `python.exe`；也可通过 `LEWIS_PYTHON` 环境变量指定。
3. 在本机设置中填写模型 API 地址、Key 和模型名。视觉理解需要支持图片输入的模型及相应配置，例如 Qwen3-VL。
4. 开启所需的麦克风、摄像头与电脑操作能力；喊“李维斯”，再说下一句任务。

## 从源码运行

解压源码，进入包含 package.json 的目录，在 PowerShell 中运行：

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File .\scripts\setup-voice.ps1
npm run desktop
```

网页模式需要两个终端，均位于源码目录：

```powershell
# 终端一
powershell -ExecutionPolicy Bypass -File .\scripts\start-voice.ps1
# 终端二
npm start
```

访问 `http://127.0.0.1:3000`。语音服务默认端口 5001；桌面模式会管理后台服务。避免同时启动多个主服务。

## 构建和测试

```powershell
npm run build:wechat
npm run build:desktop
npm test
npm run build
```

输出位于 `dist/`。原生组件使用 Windows .NET Framework 编译器。测试需要先安装 Node 依赖；语音测试还需要 Python 环境。

本次原项目的 Node 回归测试为 152 项通过；实际 Windows 控件和 QQ 音乐已验证。发布整理只替换通用说明、添加忽略规则并移除旧版本说明，运行代码和模型保持原始字节。逐项使用方式见 `RELEASE-1.7.6.md`，详细验证范围见 Release 附件。

## 数据与配置

发布源码和安装包不携带开发者的 API Key、聊天历史、微信数据库、浏览器登录资料、摄像头照片、录音或个人配置。用户在自己的电脑上填写配置，运行时数据保存在本机数据目录。

配置云端模型后，相关对话或启用的图像/微信分析内容会按所选功能发往该服务商；本机窗口 OCR 不上传窗口画面。电脑操作使用当前 Windows 用户权限，部分管理员窗口或不可识别界面可能无法操作。

## 第三方组件

第三方来源与许可见 `THIRD-PARTY-1.7.md`，唤醒模型来源与许可见 `models/wake/`，桌宠上游 MIT 许可保留在 `vendor/dafeiyu-pet/LICENSE`。上游作者署名和公开项目地址予以保留。
