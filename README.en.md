# Douyin group chat bridge for DeepSeek Harness

Adapted from [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge).
The default entrypoint uses `douyin-im@1.1.0` for group text, images, collected stickers, message reactions and audio file attachments, with the upstream DSH client for persistent conversations.

50 local tests pass. Real login and group text delivery were verified on the installation machine. Windows TTS, real Flash vision and DSH action JSON were tested. A real encrypted HEIC photo was recognized using its supported preview; the group description received a successful send receipt. Audio-file delivery returned platform review code `10502`, so delivery/playback are unconfirmed. Reaction rendering and autonomous conversation still need receiving-client acceptance. This is a community SDK integration, not an official Douyin bot API.

See [README.md](README.md) for setup, configuration, limitations and acceptance steps.

Quick commands: `npm ci`, `npm run init`, `npm run groups`, `npm run members -- GROUP_ID`, `npm run setup:dsh`, `npm run doctor`, `npm start`.
Configure string-valued group IDs and owner UIDs in `config.douyin.json`. Install the dedicated DSH preset and restart the DSH profile before starting the bridge.

Added per-group slang learning and opt-in proactive conversation, constrained sticker/voice/reaction actions and an optional OpenAI-compatible vision service. `/poke` uses a message reaction; voice is sent as an audio file, not a native voice bubble. Native poke/voice sending are not exposed by this SDK. Incoming speech transcription, video understanding, QQ console and remote approvals remain unavailable. Agents cannot execute local or MCP tools; the bridge validates a small JSON action schema. See [feature setup](docs/DOUYIN_FEATURES.md). Original QQ documentation is archived under `docs/upstream/`.

MIT; original attribution is retained in [LICENSE](LICENSE).
