# 扩展功能设置与验收

收藏表情、语音库/语音合成、图片理解接口、按群黑话学习和主动聊天都沿用群白名单、来源群限制、管理员 UID、去重和每分钟发送上限。QQ 戳一戳改为抖音消息表态。

## 升级

退出桥接，更新代码并运行 `npm ci`。现有 `config.douyin.json` 保留，新字段参考 `config.douyin.example.json`。

运行 `npm run setup:dsh`，对同一 DSH profile 执行 `dsh plugin --profile web install`，重启该 profile 的 DSH 服务，再启动桥接。新版预设允许模型选择受限互动 JSON，但所有本地工具和 MCP 仍被拒绝；旧版“只支持文字”的预设提示需要重载。会话策略版本变化后，旧会话会被退役并重建。

`features.poke.enabled`、`features.stickers.enabled`、`features.voice.enabled`、`features.slang.enabled` 默认开启。视觉服务默认未配置，主动聊天默认关闭；每群管理员可以单独开启主动聊天和关闭黑话学习。

## 戳一戳适配

`/ai /poke` 对这条消息添加 👋 表态；模型也可选择此动作。它不是 QQ 原生戳一戳，没有个人资料窗口的戳一戳动画，也不监听不存在的 QQ 事件。当前抖音 SDK 只提供消息表态接口。

## 表情包

- `/ai /sticker list`：列出账号已收藏表情的 ID 和名称，读取第一页最多 50 条（SDK 缓存合并后最多选取 100 条），聊天里最多展示 15 条。
- `/ai /sticker 收藏ID`：发送该收藏表情。
- 管理员先在群发送一个表情包，再于两分钟内输入 `/ai /sticker collect`，将自己的最近表情提交到账号收藏。
- 自然语言也可请求发送表情；模型只能选择当前收藏 ID，不能提供网络 URL 或发送到别的群。

SDK 会检查账号是否允许群聊使用收藏表情。平台拒绝或账号无权限时不能绕过；可先在抖音 App 中收藏并核对可发送性。收藏记录可能没有名称，此时显示“收藏表情”。

## 语音

- `/ai /voice 你好，大家下午好`：Windows 本机合成语音，无需额外 API Key。
- 把允许机器人发送的 `.wav`、`.mp3`、`.ogg`、`.m4a` 放入 `audio/douyin/`。
- `/ai /voice list` 列出语音库 ID；`/ai /voice play ID` 发送文件。
- 模型可选择库中 ID，或在 Windows 请求至多 300 字的语音合成。

**发送形式是音频文件附件。** SDK 没有原生语音气泡发送接口；不保证所有客户端能内联播放文件。本版不做收到语音的自动转写。语音库单文件不超过 8 MiB，最多列出 100 个，不允许模型指定任意路径或库外文件。语音库被 Git 忽略。

Windows 使用 `System.Speech` 的默认已安装声音。本机已验证生成有效 WAV，其他机器还需验证系统语音。Linux/macOS 把 `features.voice.tts` 设为 `none`，仍可使用语音库。合成临时文件读完即删除；取消、静默或会话重置会阻止尚未发送的音频。

## 图片理解

需要一个**支持图片输入、兼容 `/chat/completions` 的视觉模型服务**。当前 [DeepSeek Flash 官方接口](https://api-docs.deepseek.com/guides/vision/) 已支持图片输入，可继续使用现有 DeepSeek API Key；不需要额外购买另一家服务。图片先由视觉接口生成观察结果，再由现有 DSH 会话组织回答。

在 `config.douyin.json` 填实际服务地址与模型 ID：

```json
"features": {
  "vision": {
    "enabled": true,
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-flash",
    "apiKeySource": "dsh-deepseek",
    "apiKeyEnv": "DOUYIN_VISION_API_KEY"
  }
}
```

上述配置使用 `apiKeySource=dsh-deepseek`，只在内存中读取 DSH 本机 `.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`，不复制或打印 Key，并且仅允许发送给 `https://api.deepseek.com`。`DSH_HOME` 可指定 DSH 目录；缺少或格式不兼容时明确失败，不读取其他凭据。

其他兼容服务请填其地址/模型，并使用 `apiKeySource=env`。复制 `.env.example` 为 `.env.local`，仅在本机填 `DOUYIN_VISION_API_KEY`；也可在启动终端设置同名变量（环境变量优先）。`.env.local` 被 Git 忽略，Key 不写进群聊配置或提示词。更新后重启桥接。

先发图，再由**同一账号、同一个群**在两分钟内发送 `/ai /image 图里是什么`；也可发送 `/ai 看图，这是什么`。`trigger=all` 直接处理新图片；默认只缓存未触发的图片，不主动调用视觉服务。

支持 SDK 的 AES-256-GCM 加密图片，仅从指定抖音 CDN 的公网 HTTPS 下载，检查 DNS、固定连接地址并逐跳校验重定向，大小不超过 8 MiB。解密后只把图片本体以 Base64 发送给配置的视觉服务，不携带抖音 Cookie。支持 PNG、JPEG、GIF、WebP；其他格式明确失败，不让文字模型猜图。

未配置时明确提示。本机已使用现有 Key 实测 `deepseek-flash`，成功把纯红测试图识别为“红色”。其他服务仍需独立验收；HTTP 测试不能证明任意第三方模型已可用。

## 黑话自动学习

读取白名单群的**新文字消息**，无需每条都 @。每群内存保留至多 50 条、每条至多 500 字。默认积累 12 条后学习，同群至少间隔 5 分钟，全局同时最多一项；会产生额外模型调用费用。

独立 DSH 学习会话输出词条、语境含义和来源消息 ID。仅接纳原文真实出现的词；默认至少两条消息、两个不同发送者的证据才自动采用，否则保留为候选。模型推断的含义**没有联网核实**。复用上游词条规范化和黑话上下文，每群最多保存 200 条，仅将采用状态的词注入本群回答。

- `/ai /slang list` 查看词条和状态。
- 管理员 `/slang on`、`/slang off` 开启/关闭本群学习。
- 管理员 `/slang approve 词条`、`/slang reject 词条` 人工采用/拒绝。
- 管理员 `/slang clear` 清空本群词库。

词条及少量截断证据保存在 `state/douyin/bridge.json`，不提交 Git。群间隔离；拒绝的词不会被下次学习自动采用。清空、开关、角色重置和静默会使挂起结果失效。

## 仿真群友风格与主动发言

管理员 `/social on` 开启本群主动聊天，`/social off` 关闭，`/social status` 查看。也可设置 `features.social.enabled`，但每群持久开关优先。AI 可使用自然群聊语气，会保持 AI 身份，不冒充真人。

默认限制：

- 进程启动后至少收到 6 条新普通文字消息。
- 群空闲 15 分钟，距上次主动尝试至少 30 分钟。
- 每群每日最多 3 次尝试，包括生成失败或选择沉默。尝试先落盘，重启不清额度。
- 按 `Asia/Shanghai` 时区，23:00 至次日 08:00 不主动发言。
- 两小时以前的话题不重提；忙碌队列不插入。
- 生成过程中群友重新发言、管理员静默/关闭主动聊天或重置，会抑制旧的主动回复。

主动聊天共用群限速。模型可选择 `[SILENT]` 不发言，最多选择一个受限表情/语音/表态动作，不能选择任意发送目标。

## 验证与群内验收

`npm test`：46 项通过，包括真实 SDK 事件类配合模拟发送、实际 HTTP 视觉请求、图片加解密、Key 来源限制、发送不确定性、学习证据与管理并发、跨重启额度和主动回复失效。`npm run test:upstream` 覆盖保留的 DSH/文字工具。新增测试不读取真实登录态、不向真实群发消息。

本机已合成有效 WAV、实际调用 DeepSeek Flash 识图和 DSH 互动 JSON；文字桥接先前已由接收端确认。新增功能应在实际群依次检查：`/ai /poke` 的表态显示、`/ai /sticker list` 后发一个收藏、`/ai /voice 测试` 的文件显示/播放，再发图并 `/ai /image 图里是什么`，最后管理员开启学习/主动聊天并观察。SDK 的成功回执不等于接收端播放或渲染成功。
