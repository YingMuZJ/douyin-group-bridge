import { identifier } from './config.mjs';
import { segment } from 'douyin-im';
import { mediaUrl } from './media.mjs';

const stickerCaches = new WeakMap();
function confirmed(response) {
  if (
    !response ||
    response.statusCode !== 0 ||
    (Number.isFinite(response.checkCode) &&
      ![0, 8101].includes(response.checkCode))
  )
    throw Object.assign(new Error('抖音未确认发送成功'), {
      code: response?.checkCode === 10502 ? 'DOUYIN_REVIEW' : undefined,
      statusCode: Number.isInteger(response?.statusCode)
        ? response.statusCode
        : undefined,
      checkCode: Number.isInteger(response?.checkCode)
        ? response.checkCode
        : undefined,
    });
  return response;
}
async function stickers(account) {
  let cached = stickerCaches.get(account);
  if (!cached || Date.now() - cached.at > 60000) {
    const response = await account.getCollectedEmojis({ firstPage: true });
    confirmed(response);
    const items = (
      account.getCachedCollectedEmojis()?.stickers ??
      response.page?.stickers ??
      []
    )
      .slice(0, 100)
      .filter(
        (s) =>
          (typeof s.id === 'string' && /^\d+$/.test(s.id)) ||
          (typeof s.id === 'number' && Number.isSafeInteger(s.id)),
      );
    cached = { at: Date.now(), items };
    stickerCaches.set(account, cached);
  }
  return cached.items;
}

export function normalizeGroupMessage(event, now = Date.now()) {
  if (
    event?.type !== 'message.group' ||
    !['text', 'image', 'emoji', 'audio'].includes(event.content?.kind)
  )
    return null;
  const kind = event.content.kind;
  let attachment;
  if (kind === 'image') {
    const image = event.content.image;
    const urls = [
      ...new Set(
        [
          ...(image?.originUrls ?? []),
          ...(image?.largeUrls ?? []),
          ...(image?.mediumUrls ?? []),
          ...(image?.thumbUrls ?? []),
        ].filter((u) => typeof u === 'string' && u),
      ),
    ].slice(0, 6);
    if (!urls.length) return null;
    attachment = { kind, url: urls[0], urls, skey: image.skey };
  } else if (kind === 'emoji') {
    if (!event.content.url) return null;
    let payload;
    try {
      payload = JSON.parse(event.rawContent);
    } catch {}
    const uri = payload?.url?.uri;
    const url =
      (payload?.url?.url_list ?? []).find(
        (u) => typeof u === 'string' && u.startsWith('https://'),
      ) ||
      (event.content.url.startsWith('https://') ? event.content.url : null);
    attachment = {
      kind,
      url,
      uri: typeof uri === 'string' && uri.length <= 1024 ? uri : undefined,
    };
  } else if (kind === 'audio') attachment = { kind };
  const accountId = identifier(event.account.uid, '账号 ID');
  const ownIds = new Set([accountId, event.account.imUid].filter(Boolean));
  let referencedUid = event.referenceInfo?.refMessageId
    ? event.group.getCachedMessage?.(event.referenceInfo.refMessageId)
        ?.senderUid
    : undefined;
  if (
    !referencedUid &&
    typeof event.referenceInfo?.hint === 'string' &&
    event.referenceInfo.hint.length < 8192
  ) {
    try {
      const hint = JSON.parse(event.referenceInfo.hint);
      if (typeof hint?.refmsg_uid === 'string') referencedUid = hint.refmsg_uid;
    } catch {}
  }
  if (ownIds.has(event.senderUid)) return null;
  const senderId = identifier(event.senderUid, '发送者 ID');
  const groupId = identifier(event.group.groupId, '群 ID');
  const messageId = event.serverMessageId || event.clientMessageId;
  if (typeof messageId !== 'string' || !messageId) return null;
  const rawTime = Number(event.createTime);
  if (!Number.isFinite(rawTime) || rawTime <= 0) return null;
  const timestamp = rawTime < 1e12 ? rawTime * 1000 : rawTime;
  if (timestamp > now + 60000) return null;
  let text = kind === 'text' ? String(event.text ?? '') : '';
  // Remove only protocol-authenticated mentions of the logged-in account.
  // Offsets are UTF-16 positions, matching the SDK's TextMention definition.
  for (const mention of [...(event.mentions ?? [])].sort(
    (a, b) => b.location - a.location,
  )) {
    if (
      ownIds.has(mention.uid) &&
      Number.isInteger(mention.location) &&
      Number.isInteger(mention.length) &&
      mention.location >= 0 &&
      mention.length > 0
    ) {
      text =
        text.slice(0, mention.location) +
        text.slice(mention.location + mention.length);
    }
  }
  return {
    accountId,
    groupId,
    senderId,
    messageId,
    timestamp,
    text: text.trim().slice(0, 12000),
    nickname: String(
      event.member?.alias || event.member?.nickname || senderId,
    ).slice(0, 80),
    mentioned: event.isMentionMe === true,
    repliedToBot: !!referencedUid && ownIds.has(referencedUid),
    repliedToOther: !!referencedUid && !ownIds.has(referencedUid),
    groupName: String(event.group.name || groupId).slice(0, 80),
    kind,
    attachment,
    async send(text) {
      return confirmed(await event.reply(text));
    },
    async react(emoji) {
      return confirmed(await event.react(emoji));
    },
    async listStickers() {
      return (await stickers(event.account)).map((s) => ({
        id: String(s.id),
        name: String(s.display_name || s.name || s.desc || '收藏表情').slice(
          0,
          40,
        ),
      }));
    },
    async sendSticker(id) {
      const item = (await stickers(event.account)).find(
        (s) => String(s.id) === id,
      );
      if (!item) throw new Error('收藏列表没有此表情');
      return confirmed(await event.reply(segment.sticker(item)));
    },
    async collectSticker(attachment) {
      if (attachment?.kind !== 'emoji') throw new Error('请先发送一张表情包');
      if (attachment.url) mediaUrl(attachment.url);
      if (!attachment.url && !attachment.uri)
        throw new Error('表情没有可收藏的资源');
      const result = confirmed(
        await event.account.collectEmoji({
          ...(attachment.url ? { stickerUrl: attachment.url } : {}),
          ...(attachment.uri ? { stickerUri: attachment.uri } : {}),
          stickerType: 1,
        }),
      );
      stickerCaches.delete(event.account);
      return result;
    },
    async sendFile({ data, name }) {
      return confirmed(await event.reply(segment.file(data, name)));
    },
  };
}

export function stripPrefix(text, prefix) {
  if (text === prefix) return '';
  if (text.startsWith(prefix) && /\s/.test(text.charAt(prefix.length)))
    return text.slice(prefix.length).trim();
  if (
    text.startsWith(prefix + '/') &&
    /^\/[a-z]+(?:\s|$)/i.test(text.slice(prefix.length))
  )
    return text.slice(prefix.length).trim();
  return null;
}
