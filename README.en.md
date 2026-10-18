# Douyin group chat bridge for DeepSeek Harness

Adapted from [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge).
The default entrypoint uses `douyin-im@1.1.0` for group text, images, collected stickers, message reactions and audio file attachments, with the upstream DSH client for persistent conversations.

66 local tests pass. The receiving user confirmed text replies, the description of a real phone photo, the heart reaction and short follow-up conversations without @. Encrypted HEIC originals fall back to supported previews. Audio-file delivery returned review code `10502` and the user received no audio; voice is now disabled by default and absent from help/model actions. Experimental code is retained behind an explicit flag. Idle proactive conversation still needs receiving-client acceptance. This is a community SDK integration, not an official Douyin bot API.

See [README.md](README.md) for setup, configuration, limitations and acceptance steps.

Quick commands: `npm ci`, `npm run init`, `npm run groups`, `npm run members -- GROUP_ID`, `npm run setup:dsh`, `npm run doctor`, `npm start`.
Configure string-valued group IDs and owner UIDs in `config.douyin.json`. Install the dedicated DSH preset and restart the DSH profile before starting the bridge.

For conversational participation, start with `config.social.example.json`, fill in your own IDs and model settings, then restart the bridge. It enables `trigger=social` and the editable `roles/小木.md` persona: colloquial replies capped at 20 Unicode characters, without emoji. Calling its configured name or replying to its message works without @; follow-ups from the same speaker stay active for 3 minutes, up to 6 turns. Other messages are batched and considered selectively (24 ambient model checks per hour). After 2 new human messages and 2 idle minutes, it may follow up on the recent topic, at most 8 attempts per day, 10 minutes apart, silent from 23:00 to 08:00 Shanghai time. `/social off` disables autonomous participation while explicit @ or `/ai` still works. It does not repeatedly introduce itself and answers identity questions truthfully.

Added per-group slang learning and opt-in proactive conversation, constrained sticker/voice/reaction actions and an optional OpenAI-compatible vision service. `/poke` uses a message reaction; voice is sent as an audio file, not a native voice bubble. Native poke/voice sending are not exposed by this SDK. Incoming speech transcription, video understanding, QQ console and remote approvals remain unavailable. Agents cannot execute local or MCP tools; the bridge validates a small JSON action schema. See [feature setup](docs/DOUYIN_FEATURES.md). Original QQ documentation is archived under `docs/upstream/`.

The upstream DeepSeek “Little Whale” persona and second-generation social style are available through `config.whale.example.json` and `roles/小鲸鱼-抖音.md`: quick, teasing, stubborn but considerate, usually 1–10 characters, capped at 20 without emoji. Existing installations can select that role file and add its aliases, keeping their own IDs and model settings. Reset any per-group `/role` override and restart the bridge. This adapts the persona to the existing Douyin scheduler; it does not expose QQ MCP or add unavailable web, memory-editing or self-image tools. The original QQ role card is retained for reference.

MIT; original attribution is retained in [LICENSE](LICENSE).
