import { identifier } from './config.mjs';

export function normalizeGroupMessage(event, now = Date.now()) {
  if (event?.type !== 'message.group' || event.content?.kind !== 'text') return null;
  const accountId = identifier(event.account.uid, '账号 ID');
  const ownIds = new Set([accountId, event.account.imUid].filter(Boolean));
  if (ownIds.has(event.senderUid)) return null;
  const senderId = identifier(event.senderUid, '发送者 ID');
  const groupId = identifier(event.group.groupId, '群 ID');
  const messageId = event.serverMessageId || event.clientMessageId;
  if (typeof messageId !== 'string' || !messageId) return null;
  const rawTime = Number(event.createTime);
  if (!Number.isFinite(rawTime) || rawTime <= 0) return null;
  const timestamp = rawTime < 1e12 ? rawTime * 1000 : rawTime;
  if (timestamp > now + 60000) return null;
  let text = String(event.text ?? '');
  // Remove only protocol-authenticated mentions of the logged-in account.
  // Offsets are UTF-16 positions, matching the SDK's TextMention definition.
  for (const mention of [...(event.mentions ?? [])].sort((a, b) => b.location - a.location)) {
    if (ownIds.has(mention.uid) && Number.isInteger(mention.location) && Number.isInteger(mention.length)
        && mention.location >= 0 && mention.length > 0) {
      text = text.slice(0, mention.location) + text.slice(mention.location + mention.length);
    }
  }
  return {
    accountId, groupId, senderId, messageId, timestamp,
    text: text.trim().slice(0, 12000),
    nickname: String(event.member?.alias || event.member?.nickname || senderId).slice(0, 80),
    mentioned: event.isMentionMe === true,
    groupName: String(event.group.name || groupId).slice(0, 80),
    async send(text) {
      const response = await event.reply(text);
      if (!response || response.statusCode !== 0) throw new Error('抖音未确认发送成功');
      return response;
    },
  };
}

export function stripPrefix(text, prefix) {
  if (text === prefix) return '';
  if (text.startsWith(prefix) && /\s/.test(text.charAt(prefix.length))) return text.slice(prefix.length).trim();
  return null;
}
