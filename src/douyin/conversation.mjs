import { randomUUID } from 'node:crypto';
import { socialClock } from './social.mjs';

export class Conversation {
  constructor({
    config,
    store,
    memory,
    deliver,
    isBusy = () => false,
    now = Date.now,
    random = Math.random,
    log = () => {},
  }) {
    Object.assign(this, {
      config,
      store,
      memory,
      deliver,
      isBusy,
      now,
      random,
      log,
    });
    this.pending = new Map();
    this.active = new Map();
    this.closed = false;
  }
  enabled(room) {
    return (
      !this.closed &&
      !this.store.room(room).silent &&
      (this.store.room(room).socialEnabled ??
        this.config.features.social.enabled)
    );
  }
  offer(message) {
    if (
      this.config.douyin.trigger !== 'social' ||
      this.closed ||
      message.attachment ||
      !message.text.trim() ||
      message.text.trim().startsWith('/')
    )
      return false;
    const room = `${message.accountId}:${message.groupId}`,
      cfg = this.config.features.social;
    if (!this.enabled(room)) return false;
    const named = cfg.aliases.some((name) =>
      message.text.toLowerCase().includes(name.toLowerCase()),
    );
    if (message.repliedToOther && !named) return false;
    const state = this.active.get(room);
    const followup =
      state &&
      this.now() - state.lastBotAt <= cfg.followupWindowMs &&
      this.now() - state.startedAt <= cfg.activeDurationMs &&
      state.remaining > 0 &&
      (!state.speaker || state.speaker === message.senderId);
    const kind =
      named || message.repliedToBot
        ? 'addressed'
        : followup
          ? 'followup'
          : 'ambient';
    if (
      kind === 'ambient' &&
      (socialClock(this.now(), cfg).quiet ||
        !/[\p{L}\p{N}]{2}/u.test(message.text))
    )
      return false;
    const saved = this.store.room(room);
    if (
      kind === 'ambient' &&
      this.now() - (saved.lastConversationCheckAt ?? 0) < cfg.replyCooldownMs
    )
      return false;
    const existing = this.pending.get(room),
      rank = { ambient: 0, followup: 1, addressed: 2 };
    if (existing && rank[existing.kind] > rank[kind]) return true;
    if (existing) clearTimeout(existing.timer);
    const item = { message, kind };
    item.timer = setTimeout(() => {
      void this.flush(room).catch((e) =>
        this.log(`群聊接话未完成（${e.code || e.name}）`),
      );
    }, cfg.batchWindowMs);
    item.timer.unref();
    this.pending.set(room, item);
    return true;
  }
  async flush(room) {
    const pending = this.pending.get(room);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(room);
    if (!this.enabled(room)) return false;
    const { message, kind } = pending,
      cfg = this.config.features.social;
    if (kind === 'ambient') {
      if (this.isBusy(room) || socialClock(this.now(), cfg).quiet) return false;
      const saved = this.store.room(room);
      if (
        this.now() - (saved.lastConversationCheckAt ?? 0) <
        cfg.replyCooldownMs
      )
        return false;
      this.store.updateRoom(room, { lastConversationCheckAt: this.now() });
      if (this.random() >= cfg.replyProbability) return false;
      const checks = (saved.conversationChecks ?? []).filter(
        (t) => t > this.now() - 3600000,
      );
      if (checks.length >= cfg.maxChecksPerHour) return false;
      checks.push(this.now());
      this.store.updateRoom(room, { conversationChecks: checks });
    }
    const version = this.memory.rooms.get(room)?.version;
    const current = () =>
      this.enabled(room) &&
      (kind !== 'ambient' || this.memory.rooms.get(room)?.version === version);
    if (!current()) return false;
    return this.deliver({
      ...message,
      messageId: `conversation-${randomUUID()}`,
      timestamp: this.now(),
      conversation: true,
      conversationKind: kind,
      isCurrent: current,
    });
  }
  replied(message, text) {
    if (this.closed || this.config.douyin.trigger !== 'social') return;
    const room = `${message.accountId}:${message.groupId}`,
      cfg = this.config.features.social,
      prior = this.active.get(room);
    const continuation = message.conversationKind === 'followup' && prior;
    this.active.set(room, {
      startedAt: continuation ? prior.startedAt : this.now(),
      lastBotAt: this.now(),
      speaker: message.proactive ? null : message.senderId,
      remaining: continuation
        ? Math.max(0, prior.remaining - 1)
        : cfg.followupMaxTurns,
    });
    this.memory.recordReply(room, text);
  }
  cancel(room) {
    const p = this.pending.get(room);
    if (p) clearTimeout(p.timer);
    this.pending.delete(room);
    this.active.delete(room);
  }
  close() {
    this.closed = true;
    for (const room of this.pending.keys()) this.cancel(room);
    this.active.clear();
  }
}

export function socialReply(text, config) {
  let value = String(text ?? '');
  if (!config.allowEmoji)
    value = value.replace(
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D\u20E3]/gu,
      '',
    );
  value = value
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
  return [...value].slice(0, config.replyMaxChars).join('');
}
