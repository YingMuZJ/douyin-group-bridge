import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { NodeApiClient, unwrap, createTurnCollector } from '../dsh-client.js';

function deferred(timeoutMs, label) {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A rejection handler is attached immediately; RPC failure may precede await.
  promise.catch(() => {});
  const timer = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs);
  return {
    promise,
    resolve(value) {
      clearTimeout(timer);
      resolve(value);
    },
    reject(error) {
      clearTimeout(timer);
      reject(error);
    },
  };
}

export class DshAgent {
  constructor({ config, store, api, log = console.log }) {
    Object.assign(this, { config, store, log });
    this.api =
      api ??
      new NodeApiClient(config.dsh.baseUrl, 15000, {
        token: config.dsh.authToken,
        tokenExplicit: Boolean(config.dsh.authToken),
        WebSocket,
      });
    this.abort = new AbortController();
    this.pending = new Map();
    this.snapshotWaiters = new Map();
    this.snapshots = new Map();
    this.ready = false;
    this.policy = createHash('sha256')
      .update(
        JSON.stringify({
          base: config.dsh.baseUrl,
          preset: config.dsh.preset,
          provider: config.dsh.provider,
          model: config.dsh.model,
          reasoningEffort: config.dsh.reasoningEffort,
          guardVersion: 3,
          conversationPolicy:
            config.douyin.trigger === 'social'
              ? {
                  role: config.role,
                  replyMaxChars: config.features.social.replyMaxChars,
                  allowEmoji: config.features.social.allowEmoji,
                }
              : null,
        }),
      )
      .digest('hex');
  }
  async start() {
    if (!this.pumpTask) this.pumpTask = this.pump();
    await this.waitReady();
    await this.checkPreset();
  }
  async waitReady() {
    const until = Date.now() + 15000;
    while (!this.ready) {
      this.abort.signal.throwIfAborted();
      if (Date.now() > until)
        throw new Error('DSH 事件流未就绪，请确认已运行 dsh web');
      await delay(50, undefined, { signal: this.abort.signal });
    }
  }
  async checkPreset() {
    const { presets } = unwrap(
      await this.api.agentPresets.list({}),
      'agentPresets.list',
    );
    if (
      !Array.isArray(presets) ||
      !presets.some((p) => p.id === this.config.dsh.preset)
    ) {
      throw new Error(
        'DSH 缺少 douyin-group-chat 预设，请运行 npm run setup:dsh 并重启 DSH',
      );
    }
  }
  async pump() {
    while (!this.abort.signal.aborted) {
      try {
        for await (const envelope of this.api.events.mux(
          {},
          this.abort.signal,
          () => {
            this.ready = true;
          },
        )) {
          await this.acceptFrame(envelope.payload);
        }
      } catch (error) {
        if (!this.abort.signal.aborted)
          this.log(
            `DSH 连接中断，正在重连（${error.code || error.name || 'Error'}）`,
          );
      }
      this.ready = false;
      this.snapshots.clear();
      if (!this.abort.signal.aborted)
        await delay(1000, undefined, { signal: this.abort.signal }).catch(
          () => {},
        );
    }
  }
  async acceptFrame(frame) {
    const sid = frame?.sessionId;
    if (frame?.type === 'session/snapshot') {
      this.snapshots.set(sid, frame.snapshot);
      this.snapshotWaiters.get(sid)?.resolve(frame.snapshot);
      this.snapshotWaiters.delete(sid);
      const pending = this.pending.get(sid);
      // Replay only the pending turn, never historical completed replies.
      if (pending?.submitted) {
        for (const entry of frame.snapshot.records ?? [])
          this.acceptEvent(sid, entry.type === 'event' ? entry.event : entry);
      }
    } else if (frame?.type === 'session/event') {
      this.acceptEvent(sid, frame.event);
    } else if (frame?.type === 'stream/error' && sid) {
      this.snapshotWaiters.get(sid)?.reject(new Error('DSH 会话订阅失败'));
      this.pending.get(sid)?.waiter.reject(new Error('DSH 会话订阅失败'));
    } else if (
      ['approval/requested', 'question/requested'].includes(frame?.type) &&
      this.pending.has(sid)
    ) {
      // The group preset has no interactive or execution tools. Never let a
      // public chat approve local actions, nor expose a tool's arguments there.
      await this.api.respond({
        clientId: frame.clientId,
        eventId: frame.eventId,
        outcome: {
          kind: 'result',
          value:
            frame.type === 'approval/requested' ? 'rejected' : { answers: [] },
        },
      });
    }
  }
  acceptEvent(sid, event) {
    const pending = this.pending.get(sid);
    if (
      !pending?.submitted ||
      !event?.data?.turn ||
      pending.oldTurns.has(event.data.turn)
    )
      return;
    pending.turns.add(event.data.turn);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(event))
      .digest('hex');
    if (pending.events.has(fingerprint)) return;
    pending.events.add(fingerprint);
    const ended = pending.collector.push(event);
    if (ended) {
      const kind =
        typeof ended.reason === 'string' ? ended.reason : ended.reason?.kind;
      if (kind === 'completed') pending.waiter.resolve(ended.text);
      else pending.waiter.reject(new Error('DSH 回合未正常完成'));
    }
  }
  async snapshot(sid) {
    if (this.snapshots.has(sid)) return this.snapshots.get(sid);
    const waiter = deferred(15000, 'DSH 会话订阅');
    this.snapshotWaiters.set(sid, waiter);
    this.api.events.follow(sid);
    try {
      return await waiter.promise;
    } finally {
      this.snapshotWaiters.delete(sid);
    }
  }
  async ensureSession(key) {
    let record = this.store.session(key);
    if (record && record.policy !== this.policy) {
      await this.reset(key);
      record = null;
    }
    if (!record) {
      const dir = path.join(this.config.stateDir, 'workspace');
      fs.mkdirSync(dir, { recursive: true });
      const ws = unwrap(
        await this.api.workspace.create({ path: dir }),
        'workspace.create',
      );
      const session = unwrap(
        await this.api.sessions.create({
          workspaceId: ws.workspace.workspaceId,
          agentPreset: this.config.dsh.preset,
        }),
        'session.create',
      );
      const sid = session.sessionId;
      if (typeof sid !== 'string' || !sid) throw new Error('DSH 未返回会话 ID');
      if (this.config.dsh.provider && this.config.dsh.model) {
        unwrap(
          await this.api.sessions.selectModel({
            sessionId: sid,
            provider: this.config.dsh.provider,
            model: this.config.dsh.model,
            reasoningEffort: this.config.dsh.reasoningEffort,
          }),
          'session.selectModel',
        );
      }
      record = { sessionId: sid, policy: this.policy };
      this.store.setSession(key, record);
    }
    await this.snapshot(record.sessionId);
    return record.sessionId;
  }
  async reply(key, text) {
    await this.waitReady();
    await this.checkPreset();
    let sid;
    try {
      sid = await this.ensureSession(key);
    } catch (error) {
      // Preserve a visible failure, but don't pin a deleted session forever.
      if (this.store.session(key)) await this.reset(key).catch(() => {});
      throw error;
    }
    if (this.pending.has(sid)) throw new Error('同一 DSH 会话存在并行回合');
    const oldTurns = new Set(
      (this.snapshots.get(sid)?.records ?? [])
        .map((r) => (r.type === 'event' ? r.event : r)?.data?.turn)
        .filter(Boolean),
    );
    const waiter = deferred(this.config.dsh.timeoutMs, 'AI 回复');
    const pending = {
      waiter,
      oldTurns,
      turns: new Set(oldTurns),
      events: new Set(),
      collector: createTurnCollector(),
      submitted: true,
    };
    this.pending.set(sid, pending);
    try {
      const accepted = unwrap(
        await this.api.sessions.prompt({
          sessionId: sid,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }),
        'session.prompt',
      );
      if (accepted.command) {
        waiter.resolve(accepted.command.text ?? '');
      }
      return await waiter.promise;
    } catch (error) {
      waiter.reject(error);
      await this.api.stopSessionWork(sid, { timeoutMs: 3000 }).catch(() => {});
      // An ambiguous/incomplete turn is retired; it cannot contaminate the next.
      if (this.store.session(key)?.sessionId === sid)
        this.store.setSession(key, null);
      this.api.events.forget(sid);
      throw error;
    } finally {
      this.pending.delete(sid);
      // Follow remains open between turns. Keep the observed turn IDs so a
      // reconnect snapshot cannot replay an earlier answer as the next reply.
      if (this.store.session(key)?.sessionId === sid) {
        this.snapshots.set(sid, {
          records: [...pending.turns]
            .slice(-500)
            .map((turn) => ({ type: 'turn/end', data: { turn } })),
        });
      } else this.snapshots.delete(sid);
    }
  }
  async reset(key) {
    const record = this.store.session(key);
    if (!record) return;
    this.store.setSession(key, null);
    this.pending.get(record.sessionId)?.waiter.reject(new Error('会话已重置'));
    this.snapshots.delete(record.sessionId);
    this.api.events.forget(record.sessionId);
    await this.api.stopSessionWork(record.sessionId, { timeoutMs: 3000 });
    unwrap(
      await this.api.workspace.archiveSession({ sessionId: record.sessionId }),
      'workspace.archiveSession',
    );
  }
  async close() {
    this.abort.abort();
    for (const { waiter } of this.pending.values())
      waiter.reject(new Error('桥接已关闭'));
    for (const waiter of this.snapshotWaiters.values())
      waiter.reject(new Error('桥接已关闭'));
    await this.pumpTask;
  }
}
