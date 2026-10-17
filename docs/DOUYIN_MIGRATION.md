# 改装记录与验证范围

基于上游提交 `9df6a7e7fc5abcb36793337f778483bd442a3d2d`。

## 当前结构

- `src/douyin/main.mjs`：命令入口，登录生命周期，群/成员查询，配置初始化与本机 DSH 检查。
- `src/douyin/adapter.mjs`：对接 douyin-im 1.1.0 的公开群事件，转换身份、时间、协议 @ 和发送回执。
- `src/douyin/bridge.mjs`：白名单、触发、管理员命令、并发/队列、限速、上下文和出站审计。
- `src/douyin/dsh-agent.mjs`：复用上游客户端，建立独立持久会话，消费事件、恢复快照，停止/退役异常回合。
- `src/douyin/store.mjs`：原子状态写入、跨重启去重与单实例锁。
- `src/douyin/config.mjs`：字符串 ID 与配置边界校验。
- `src/douyin/features-config.mjs`：扩展功能开关及主动发言限制。
- `src/douyin/media.mjs`：受限图片下载/解密、视觉接口、语音库和 Windows TTS。
- `src/douyin/tools.mjs`：严格 JSON 动作解析及当前群媒体动作准备。
- `src/douyin/social.mjs`：按群黑话学习、媒体关联和主动发言调度。
- `plugins/douyin-agent-presets/`：DSH 专用聊天预设和执行守卫。
- `scripts/setup-douyin-dsh.mjs`：幂等注册 bundle，保留并备份现有 DSH profile。
- `tests/douyin/`：路由/权限、SDK 契约、状态/去重、真实 HTTP/WebSocket 模拟 DSH、安装测试。

上游 `src/dsh-client.js`、`src/md-to-plain.js`、`src/sensitive.js` 被复用。DSH 客户端只增加可注入 WebSocket 类（Node 内置 WebSocket 的附加请求头行为存在版本差异），以及 stream/error 的 sessionId 归属。上游工具隐藏名单被专用守卫引用，但上游允许 QQ MCP 的执行守卫不用于抖音。

Windows 实机安装发现上游 ACL 脚本会先移除继承权限，再按账户显示名授权，可能留下不可写目录。新入口改用 `src/douyin/permissions.mjs`：按当前用户、SYSTEM、Administrators 的 SID 在内存构造完整 DACL，一次性提交。补充实机权限回归，验证反复设置权限后，现有文件与 SDK 子目录均可写。

在本机桌面版 DSH 0.2.1-rc.2 上，已验证真实 Cookie 鉴权、事件流连接、专用 preset 列表、工作区和群聊会话创建、会话停止与归档。实际创建会话发现 compaction 服务必须显式隔离，已按上游预设结构增加 Cordis 隔离组后通过。随后 DeepSeek 真实调用返回预期测试文本；用户在目标群触发机器人，运行日志记录发送成功，用户确认群内收到回复。

其他 QQ 代码保留作移植参考，没有从新的默认入口加载。默认依赖已移除 SnowLuma 和 QQ MCP，原 QQ 启动/测试命令不再作为当前 npm 脚本提供。

## 验证方式

新增自动测试全程离线于真实抖音和真实 DSH，只使用本机临时服务。它们验证 SDK 事件的实际字段、原 DSH 客户端发送的 RPC 格式和 Cookie WebSocket 请求头、两轮回复、白名单、管理员权限、群间隔离、发送不确定性去重、重连快照恢复、超时退役和预设安装。

模拟 DSH 不是完整 DSH 运行时。专用 preset 的结构与执行守卫做了自动检查，并补充本机真实 DSH 的装载、会话生命周期和模型调用验收。媒体互动通过桥接限定 JSON 动作实现，主动聊天使用独立按群调度，不移植允许任意收发的旧 QQ MCP。复用上游黑话词条规范化和上下文构造，另加来源消息证据校验与按群持久化。扩展配置与验收边界见 [DOUYIN_FEATURES.md](DOUYIN_FEATURES.md)。

本机已完成真实抖音扫码登录、群列表、群成员 UID 查询，以及 DSH profile 装载、专用会话创建与归档、DeepSeek API Key 配置和真实模型调用。群内使用 `/ai` 前缀触发已通过，运行日志和用户实际接收确认一致。协议 @、图片/语音和其他机器环境未做本次实测，不应扩展宣称为已验证。

## 发布与搬迁

源码 ZIP 不包含 `.git`、`node_modules`、`state`、`config.douyin.json` 或任何凭据。解压后运行 `npm ci` 和 `npm run init`。如果安装后移动项目目录，需要重新运行 `setup:dsh` 更新 bundle 链接；脚本遇到指向其他目录的同名链接会停止，先核实后移除旧链接再安装。

DSH 预设只引用本项目内文件，不复制用户凭据。`state/douyin/sdk` 是本机登录态；需要重新授权时，先退出桥接，再备份该目录后重新登录。
