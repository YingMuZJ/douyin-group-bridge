# Douyin group chat bridge for DeepSeek Harness

Adapted from [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge).
The default entrypoint uses `douyin-im@1.1.0` for group text messages, with the upstream DSH Web API client for authentication and persistent agent conversations.

27 local tests pass. Real Douyin login, group/member listing, DSH session lifecycle, live DeepSeek generation and group delivery have been verified on the installation machine. The user confirmed receiving the group reply. This is a community SDK integration, not an official Douyin bot API.

See [README.md](README.md) for setup, configuration, limitations and acceptance steps.

Quick commands: `npm ci`, `npm run init`, `npm run groups`, `npm run members -- GROUP_ID`, `npm run setup:dsh`, `npm run doctor`, `npm start`.
Configure string-valued group IDs and owner UIDs in `config.douyin.json`. Install the dedicated DSH preset and restart the DSH profile before starting the bridge.

The QQ console, autonomous social modes, image/voice tools and remote approvals have not been ported. Group agents cannot execute tools. Original QQ documentation is archived under `docs/upstream/`.

MIT; original attribution is retained in [LICENSE](LICENSE).
