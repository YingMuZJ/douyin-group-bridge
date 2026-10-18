# 抖音群聊 ↔ DeepSeek Harness 桥接

基于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 改装。保留原项目的 DSH 会话客户端、Cookie 鉴权、消息事件收集与回复过滤，新增抖音群聊传输层。默认启动入口已经切换为抖音，不需要 QQ、SnowLuma 或 OneBot 服务。

```text
抖音群友 @机器人 / 发送 /ai 问题
    → douyin-im（登录账号的群聊收发）
    → 群白名单、去重、触发判断、会话路由
    → 本机 DeepSeek Harness 的独立聊天会话
    → 回复发送回来源群
```

**当前交付状态：50 项自动测试通过；文字桥接已完成真实抖音扫码登录、DeepSeek 调用与群内收发验收。** 本机已验证 Windows TTS、真实 Flash 识图及 DSH 互动 JSON；实际手机 HEIC 图片已通过预览图回退识别，描述发送获得群消息成功回执。音频附件实测遇到平台审核码 `10502`，不能承诺送达或播放；表态显示和自动聊天仍需接收端验收。抖音收发使用社区 SDK [douyin-im@1.1.0](https://github.com/zhinjs/douyin-im)，协议、验证及账号状态会影响实际可用性。

## 已有功能

- 抖音扫码登录、本机保存登录态、查询群 ID 和群成员 UID。
- 只处理群白名单，默认 @ 机器人或 `/ai 问题` 触发；可选仅前缀或全部文字消息。
- 每群一个持久 DSH 会话；可配置按群和用户隔离。不同群不会共享会话。
- 同一会话串行处理，跨群并发；重复消息过滤、历史同步过滤、回复限速、队列上限。
- 管理员 `/reset`、`/silent`、`/active`、`/role`、`/status`。
- 收藏表情的查询、发送及管理员收藏；模型可从当前收藏列表选择一个表情。
- 指定语音库与 Windows 文本转语音，以音频文件附件发送。
- 图片接收、AES-GCM 解密和兼容 OpenAI 格式的视觉模型接口；可关联同一发送者两分钟内的图片。
- 按群自动学习黑话，保留可核对证据、候选/采用/拒绝状态和管理员控制。
- 可开启自然风格的主动聊天：群空闲、日限额、冷却和夜间静默；保持 AI 身份。
- `/poke` 消息表态，作为 QQ 戳一戳的替代交互。
- DSH 断线重连及正在处理回合的快照恢复，防止历史回复重发。
- 专用 `douyin-group-chat` 预设。群聊不开放本地执行、文件读写、QQ 发送或其他 MCP 工具。

抖音 SDK 没有原生戳一戳或语音气泡发送接口，`/poke` 使用平台 `[爱心]` 消息表态，语音使用文件附件；不伪造未公开协议。语音转文字、视频理解、QQ 控制台及远程工具审批尚未移植。上游源码保留供继续开发，原说明保存在 [docs/upstream](docs/upstream/)，其中 QQ 的安装命令不适用于本改装版。详细设置与验收见 [扩展功能说明](docs/DOUYIN_FEATURES.md)。

## Windows 安装与首次启动

准备 Node.js 22.13+（建议 Node.js 24 LTS）、已能正常使用的 DeepSeek Harness，以及用于登录机器人的抖音账号。请先把该账号加入目标群。用另一个账号发送测试消息，机器人会忽略自己发送的消息。

已安装 DSH 桌面版时，可以复用其安装目录下的 `resources/runtime/cli/bin/dsh.cmd`，无需重复安装 npm 全局版本。本机安装过程另外生成了 `start-dsh-local.bat` 作为当前电脑的启动器，该文件含本机路径，不进入源码包。

### 1. 安装依赖并生成配置

在本项目目录打开 PowerShell：

```powershell
npm ci
npm run init
```

也可以双击 `setup.bat`。本步骤只安装本项目依赖，不安装或启动 DSH。

### 2. 扫码并查群 ID

```powershell
npm run groups
```

终端会提示二维码图片位置 `state/douyin/login.png`。打开图片，用抖音 App 扫码并确认。如平台要求验证，按终端或打开的官方验证页面完成。登录态保存在 `state/douyin/sdk/`。登录成功后，命令输出群名称和完整 ID，然后退出；不发送群消息。

用显示的完整 ID 查询群成员，以找到你用于管理机器人的那个账号的 UID：

```powershell
npm run members -- 你的完整群ID
```

### 3. 编辑 config.douyin.json

填写 `douyin.groups` 和 `douyin.owners`。例如下面是结构示例，数字必须换成刚才查询的真实 ID：

```json
"douyin": {
  "groups": ["7423010390826582565"],
  "owners": ["3138463854771706"],
  "trigger": "mention",
  "prefix": "/ai",
  "sessionScope": "group"
}
```

**ID 必须使用字符串并保留双引号**，不是昵称、抖音号或邀请链接。空群白名单不启动；空管理员名单不开放管理命令。管理员 UID 来自群成员列表，通常不是机器人登录账号的 UID。

`dsh.provider` 与 `dsh.model` 同时留空，使用 DSH 默认模型。在 DSH 自己的界面配置 DeepSeek 服务和 API Key；本桥接不需要再次保存模型 Key。若想指定模型，两个字段必须同时填写 DSH 实际可用的 provider ID 和 model ID。

### 4. 安装 DSH 专用预设

先确认 DSH 已安装，并运行过 `dsh web` 创建 `web` profile。然后在项目目录执行：

```powershell
npm run setup:dsh
dsh plugin --profile web install
```

重启 DSH Web 服务（默认 `http://127.0.0.1:3080`），并在其界面选择可用的 DeepSeek 模型。安装脚本保留已有 bundle，仅增加 `douyin-agent-presets`，修改前备份 profile 的 `package.json`，可重复运行。它不安装上游 QQ MCP、不添加 QQ 机器人配置。

如果使用其他 DSH profile，运行 `npm run setup:dsh -- profile名`，随后对同一个 profile 执行插件安装和重启。`DSH_HOME` 应与 DSH 服务保持一致。

如需指定 DSH 目录（仅为 PowerShell 写法示例）：

```powershell
$env:DSH_HOME = 'D:\my-dsh-home'
npm run setup:dsh
```

DSH 鉴权默认沿用上游本机 Cookie 方式，`dsh.authToken` 通常留空。若本机自动鉴权不适用，可在当前终端设置 DSH 提供的启动 token：`$env:DSH_LAUNCH_TOKEN = '你的启动token'`，随后启动桥接。不要把 token 发进群聊。

### 5. 检查并启动

```powershell
npm run doctor
npm start
```

`doctor` 检查本机 DSH 连接、鉴权、事件流和专用预设，不登录抖音、不发送群消息。启动也可以双击 `start.bat`。退出使用 Ctrl+C；不需要循环重启脚本。

用另一个账号在白名单群内真正 @ 机器人并提问，或者发送 `/ai 你好`。群里的显示昵称中输入一个普通 `@名字` 不等于平台的真实 @；`/ai` 前缀不受此区别影响。

## 管理与配置

管理员在群内 @ 机器人后输入以下命令，或用 `/ai /命令`：

- `/status`：查看当前群的运行/静默状态。
- `/reset`：清除本群会话映射，下次建立新的 DSH 会话；不会删除 DSH 的历史档案。
- `/silent`、`/active`：暂停或恢复当前群 AI 回复。
- `/role 你是一个耐心的编程老师`：修改当前群角色并重置会话。
- `/role off`：恢复配置文件中的默认角色。
- `/help`：查看帮助（所有已放行群用户均可触发）。
- `/poke`、`/voice`、`/sticker`、`/image`：消息表态、音频附件、表情包与看图，详见扩展说明。
- `/slang list`：查看本群黑话；管理员可用 `on`、`off`、`clear`、`approve 词条`、`reject 词条`。
- `/social on|off|status`：管理员控制本群主动聊天，默认关闭。

`douyin.trigger` 支持 `mention`（@ 或前缀）、`prefix`（仅前缀）和 `all`（白名单群全部新文字消息）。`sessionScope` 支持 `group` 和 `group-user`。`maxRepliesPerMinute` 是每群的每分钟发送上限，`maxQueuePerGroup` 是每个隔离会话的排队上限，`maxActiveGroups` 是并发隔离会话上限；超限消息会被丢弃并记本机日志。配置文件更改后重启桥接。

默认单条回复至多 500 个 Unicode 字符，超过部分以省略号截断。遇到不明确的发送结果不自动重发；模型超时也不自动重新投递。请发送一条新消息再次提问。

## 测试与实际验收

```powershell
npm test
npm run test:upstream
```

新增测试使用 SDK 真实事件类、本机 HTTP/WebSocket 模拟 DSH，以及临时状态目录。不读取真实抖音登录态、不使用模型额度、不向群发送消息。上游回归覆盖 DSH inbox 解析、会话重订阅和文字格式转换。

真实验收需要运行 `groups` 完成登录、配置白名单和 DSH，再用第二个账号在目标群触发机器人，并确认消息确实到达接收端。测试通过不能代替这一步；`douyin-im` 使用社区实现的个人账号协议，实际可用性仍需测试。

常见问题：

- 找不到 `dsh`：先按 [DeepSeek Harness 官方项目](https://github.com/deepseek-ai/deepseek-harness) 安装并配置 DSH；本项目提供的是消息桥接。
- `doctor` 提示预设缺失：重新运行 `setup:dsh`、`dsh plugin --profile web install`，并重启正确 profile 的 DSH。
- 启动提示群白名单为空：先运行 `groups`，把完整字符串 ID 写入 `config.douyin.json`。
- 看起来在线但不回复：先用 `/ai 你好` 排除 @ 格式问题；核对群 ID、静默状态和限速，再运行 `doctor`。
- 一个账号自己测试没有反应：自身消息被忽略，需用另一个账号在群里触发。
- 协议或 SDK 登录失败：保留错误类别和版本信息排查；不要把 `state/`、Cookie 或 DSH 凭据发到 Issue。

## 来源与许可

原项目：[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，基线提交 `9df6a7e7fc5abcb36793337f778483bd442a3d2d`。群聊 SDK：[zhinjs/douyin-im](https://github.com/zhinjs/douyin-im)，锁定版本 `1.1.0`。保留原 MIT 许可及作者声明，见 [LICENSE](LICENSE)。实现结构与移植范围见 [docs/DOUYIN_MIGRATION.md](docs/DOUYIN_MIGRATION.md)。
