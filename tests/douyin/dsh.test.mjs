import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { NodeApiClient } from '../../src/dsh-client.js';
import { validateConfig } from '../../src/douyin/config.mjs';
import { Store } from '../../src/douyin/store.mjs';
import { DshAgent } from '../../src/douyin/dsh-agent.mjs';
import { GroupBridge } from '../../src/douyin/bridge.mjs';

async function serverFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-dsh-wire-test-'));
  const records = new Map(), follows = new Map(), requests = [], sockets = new Set();
  const settings = { missingPreset: false, noReply: false, disconnectOnPrompt: false, denyPrompt: false };
  let n = 0, seq = 0;
  const event = (sid, item) => {
    const record = { ...item, seq: ++seq };
    records.get(sid).push(record);
    const follow = follows.get(sid);
    if (follow?.socket.readyState === WebSocket.OPEN) follow.socket.send(JSON.stringify({ type: 'item', streamId: follow.id, value: { type: 'event', event: record } }));
    return record;
  };
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    requests.push({ url: req.url, body, cookie: req.headers.cookie });
    const arg = body.payload?.args?.request;
    let value = {};
    if (req.url === '/api/agentPresets/list') value = { presets: settings.missingPreset ? [] : [{ id: 'douyin-group-chat' }] };
    if (req.url === '/api/workspace/create') value = { created: true, workspace: { workspaceId: 'workspace-test' } };
    if (req.url === '/api/session/create') {
      value = { sessionId: `session-${++n}` };
      records.set(value.sessionId, []);
    }
    if (req.url === '/api/session/prompt' && !settings.noReply && !settings.denyPrompt) {
      const sid = arg.sessionId, turn = `turn-${++seq}`;
      const emit = () => {
        event(sid, { type: 'turn/start', data: { turn } });
        const text = `回答 ${turn}`;
        if (settings.disconnectOnPrompt) {
          const socket = follows.get(sid).socket;
          socket.close();
          // Model completes while the transport is down; reconnect snapshot
          // must recover this result exactly once.
          follows.delete(sid);
        }
        event(sid, { type: 'assistant/chunk', data: { turn, text: '不应重复拼接' } });
        event(sid, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } });
        event(sid, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
      };
      setTimeout(emit, 10);
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      type: 'server-response', rpcId: body.rpcId,
      result: req.url === '/api/session/prompt' && settings.denyPrompt
        ? { ok: false, error: { code: 'test/rejected', message: '拒绝测试' } }
        : { ok: true, value },
    }));
  });
  const wss = new WebSocketServer({ server, path: '/api/remote.mux' });
  wss.on('connection', (socket, request) => {
    assert.equal(request.headers.cookie, 'test-cookie=1');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.endpoint === '$events') socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId: 'client-test' } }));
      if (frame.endpoint === 'session/follow') {
        const sid = frame.payload.args.request.address.sessionId;
        follows.set(sid, { socket, id: frame.streamId });
        socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'snapshot', records: records.get(sid) ?? [] } }));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const config = validateConfig({ douyin: { groups: ['7423010390826582565'] }, dsh: { baseUrl } }, root);
  const store = new Store(config.stateDir);
  const api = new NodeApiClient(baseUrl, 1000, { token: 'test-token', tokenExplicit: true, WebSocket });
  // Authentication has dedicated upstream regression tests. Wire tests use an
  // isolated fixed cookie and never read the user's DSH credentials.
  api.ensureAuth = async () => { api.cookie = 'test-cookie=1'; return api.cookie; };
  const stopped = [];
  api.stopSessionWork = async (sid) => { stopped.push(sid); };
  const agent = new DshAgent({ config, store, api, log: () => {} });
  t.after(async () => {
    await agent.close();
    for (const socket of sockets) socket.terminate();
    await new Promise((r) => wss.close(r));
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { config, store, agent, requests, records, settings, stopped };
}

test('真实 HTTP + WebSocket 协议：同群复用会话，多轮回答不会重复拼接', async (t) => {
  const f = await serverFixture(t);
  await f.agent.start();
  const first = await f.agent.reply('account:group', '第一条');
  const second = await f.agent.reply('account:group', '第二条');
  assert.match(first, /^回答 turn-/);
  assert.match(second, /^回答 turn-/);
  assert.notEqual(first, second);
  assert.equal(f.requests.filter((r) => r.url === '/api/session/create').length, 1);
  assert.equal(f.requests.find((r) => r.url === '/api/session/create').body.payload.args.request.agentPreset, 'douyin-group-chat');
  assert.ok(f.requests.every((r) => r.cookie === 'test-cookie=1'));
});

test('端到端：群消息进入原项目 DSH 客户端，最终只回原群一次', async (t) => {
  const f = await serverFixture(t);
  await f.agent.start();
  const bridge = new GroupBridge({ config: f.config, store: f.store, agent: f.agent, log: () => {} });
  const sent = [];
  const message = {
    accountId: '111', groupId: '7423010390826582565', senderId: '222', messageId: 'int64-message-1',
    timestamp: Date.now(), text: '你好', nickname: '小明', mentioned: true,
    send: async (text) => sent.push(text),
  };
  await bridge.handle(message);
  await bridge.handle(message);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^回答 turn-/);
});

test('缺少专用 preset 时拒绝启动，绝不回落到 standard', async (t) => {
  const f = await serverFixture(t);
  f.settings.missingPreset = true;
  await assert.rejects(() => f.agent.start(), /缺少.*预设/);
  assert.equal(f.requests.filter((r) => r.url === '/api/session/create').length, 0);
});

test('断线期间完成的回合由重连快照恢复，历史回答不重发', async (t) => {
  const f = await serverFixture(t);
  await f.agent.start();
  const first = await f.agent.reply('room', '第一次');
  f.settings.disconnectOnPrompt = true;
  const second = await f.agent.reply('room', '断线中的第二次');
  assert.notEqual(second, first);
  assert.match(second, /^回答 turn-/);
});

test('超时退役会话，下一条消息不会接到上一条残留回答', async (t) => {
  const f = await serverFixture(t);
  await f.agent.start();
  f.config.dsh.timeoutMs = 60;
  f.settings.noReply = true;
  await assert.rejects(() => f.agent.reply('room', 'timeout'), /超时/);
  assert.equal(f.store.session('room'), undefined);
  assert.deepEqual(f.stopped, ['session-1']);
  f.settings.noReply = false;
  assert.match(await f.agent.reply('room', 'new'), /^回答 turn-/);
  assert.equal(f.requests.filter((r) => r.url === '/api/session/create').length, 2);
});

test('拒收提示词时取消对应回合，不自动重复投递', async (t) => {
  const f = await serverFixture(t);
  await f.agent.start();
  f.settings.denyPrompt = true;
  await assert.rejects(() => f.agent.reply('room', 'no'), /test\/rejected/);
  assert.equal(f.requests.filter((r) => r.url === '/api/session/prompt').length, 1);
  assert.equal(f.store.session('room'), undefined);
});

test('只处理自己群聊会话的审批；一律拒绝，其他会话不受影响', async (t) => {
  const f = await serverFixture(t);
  const respond = [];
  f.agent.api.respond = async (msg) => respond.push(msg);
  f.agent.pending.set('ours', { waiter: { reject() {} } });
  await f.agent.acceptFrame({ type: 'approval/requested', sessionId: 'other', clientId: 'c', eventId: 'e' });
  await f.agent.acceptFrame({ type: 'approval/requested', sessionId: 'ours', clientId: 'c', eventId: 'e' });
  assert.equal(respond.length, 1);
  assert.equal(respond[0].outcome.value, 'rejected');
  f.agent.pending.clear();
});
