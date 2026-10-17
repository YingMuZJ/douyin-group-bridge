import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GroupMessageEvent } from 'douyin-im';
import { validateConfig } from '../../src/douyin/config.mjs';
import { normalizeGroupMessage } from '../../src/douyin/adapter.mjs';
import { Store, acquireLock } from '../../src/douyin/store.mjs';
import { GroupBridge } from '../../src/douyin/bridge.mjs';

const groupId = '7423010390826582565';
const otherGroup = '7423010390826582566';
const uid = '3138463854771706';
const bot = '1150530166719210';
const now = 1800000000000;
let counter = 0;

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-bridge-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = validateConfig({ douyin: { groups: [groupId, otherGroup], owners: [uid], ...overrides } }, root);
  const store = new Store(config.stateDir);
  const calls = [], sends = [], resets = [];
  const agent = {
    reply: async (key, prompt) => { calls.push({ key, prompt }); return '你好'; },
    reset: async (key) => { resets.push(key); store.setSession(key, null); },
  };
  const bridge = new GroupBridge({ config, store, agent, now: () => now, log: () => {} });
  const message = (extra = {}) => ({
    accountId: bot, groupId, senderId: uid, messageId: `m-${++counter}`, timestamp: now,
    text: '你好', nickname: '用户', mentioned: true, send: async (text) => sends.push(text), ...extra,
  });
  return { config, store, root, agent, bridge, calls, sends, resets, message };
}

test('SDK 1.1.0 真实事件类：解析群聊 @，保留 int64 并发送回原群', async () => {
  const sends = [];
  const group = {
    groupId, name: '测试群', pickMember: () => undefined,
    ensureMember: () => ({ nickname: '小明' }),
    sendMsg: async (text) => { sends.push(text); return { statusCode: 0, statusMsg: '' }; },
  };
  const account = { uid: bot, imUid: '999', bindGroup: () => group };
  const event = GroupMessageEvent.fromInbound({
    raw: {}, threadId: groupId, conversationShortId: groupId, conversationType: 2,
    senderUid: uid, serverMessageId: '8000000000000000001', createTime: String(now / 1000),
    text: '@机器人 你好', messageType: 7,
    rawContent: JSON.stringify({ aweType: 700, type: 0, text: '@机器人 你好', richTextInfos: [
      { infoType: 1, location: 0, length: 4, info: { uid: '999' } },
    ] }),
  }, account);
  const normalized = normalizeGroupMessage(event, now);
  assert.equal(normalized.groupId, groupId);
  assert.equal(normalized.mentioned, true);
  assert.equal(normalized.text, '你好');
  assert.equal(normalized.timestamp, now);
  await normalized.send('回答');
  assert.deepEqual(sends, ['回答']);
  assert.equal(normalizeGroupMessage({ ...event, senderUid: '999' }, now), null);
  assert.equal(normalizeGroupMessage({ ...event, type: 'message.private' }, now), null);
  assert.equal(normalizeGroupMessage({ ...event, content: { kind: 'image' } }, now), null);
  assert.equal(normalizeGroupMessage({ ...event, createTime: undefined }, now), null);
  await assert.rejects(() => normalizeGroupMessage({ ...event, reply: async () => ({ statusCode: 5 }) }, now).send('x'));
});

test('拒绝数字 ID、远程 DSH 和未配对的模型字段', () => {
  assert.throws(() => validateConfig({ douyin: { groups: [Number(groupId)] } }, '.'), /字符串/);
  assert.throws(() => validateConfig({ dsh: { baseUrl: 'https://example.com' } }, '.'), /本机/);
  assert.throws(() => validateConfig({ dsh: { model: 'example' } }, '.'), /同时/);
});

test('只有白名单群和协议 @/命令前缀触发，昵称文字不算 @', async (t) => {
  const f = fixture(t);
  assert.equal(await f.bridge.handle(f.message({ groupId: '12' })), false);
  assert.equal(await f.bridge.handle(f.message({ mentioned: false, text: '@机器人 你好' })), false);
  assert.equal(await f.bridge.handle(f.message({ mentioned: false, text: '/aim 不应触发' })), false);
  await f.bridge.handle(f.message({ mentioned: false, text: '/ai 请问今天如何' }));
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].prompt.includes('请问今天如何'));
});

test('prefix 模式忽略仅 @ 的消息，all 模式处理普通消息', async (t) => {
  const a = fixture(t, { trigger: 'prefix' });
  assert.equal(await a.bridge.handle(a.message()), false);
  const b = fixture(t, { trigger: 'all' });
  await b.bridge.handle(b.message({ mentioned: false }));
  assert.equal(b.calls.length, 1);
});

test('过滤初次同步历史、陈旧消息和缺失时间的 SDK 事件', async (t) => {
  const f = fixture(t);
  await f.bridge.handle(f.message({ timestamp: now - 10000 }));
  assert.equal(f.calls.length, 0);
});

test('去重在重启后继续生效，失败发送不自动重发', async (t) => {
  const f = fixture(t);
  const message = f.message();
  await f.bridge.handle(message);
  await f.bridge.handle(message);
  const store = new Store(f.config.stateDir);
  const bridge = new GroupBridge({ config: f.config, store, agent: f.agent, now: () => now });
  await bridge.handle(message);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sends.length, 1);
});

test('同群串行、不同群可并行，回答始终发回来源群', async (t) => {
  const f = fixture(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const order = [];
  f.agent.reply = async (key, prompt) => {
    order.push(key);
    if (key.endsWith(groupId) && order.filter((k) => k.endsWith(groupId)).length === 1) await gate;
    return prompt.includes('第二条') ? '第二条回答' : '第一条回答';
  };
  const a = f.bridge.handle(f.message());
  const b = f.bridge.handle(f.message({ text: '第二条' }));
  const other = [];
  await f.bridge.handle(f.message({ groupId: otherGroup, send: async (text) => other.push(text) }));
  assert.equal(order.length, 2);
  assert.deepEqual(other, ['第一条回答']);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(f.sends, ['第一条回答', '第二条回答']);
});

test('按用户隔离时使用完整账号/群/用户键', async (t) => {
  const f = fixture(t, { sessionScope: 'group-user' });
  await f.bridge.handle(f.message());
  await f.bridge.handle(f.message({ senderId: '222' }));
  assert.deepEqual(f.calls.map((c) => c.key), [`${bot}:${groupId}:${uid}`, `${bot}:${groupId}:222`]);
});

test('管理员静默只影响当前群，非管理员无法恢复或改角色', async (t) => {
  const f = fixture(t);
  await f.bridge.handle(f.message({ text: '/silent' }));
  await f.bridge.handle(f.message({ text: 'hello' }));
  assert.equal(f.calls.length, 0);
  await f.bridge.handle(f.message({ text: '/active', senderId: '222' }));
  assert.equal(f.store.room(`${bot}:${groupId}`).silent, true);
  await f.bridge.handle(f.message({ groupId: otherGroup }));
  assert.equal(f.calls.length, 1);
  await f.bridge.handle(f.message({ text: '/active' }));
  await f.bridge.handle(f.message());
  assert.equal(f.calls.length, 2);
});

test('角色更新重置所有本群用户会话，其他群不受影响', async (t) => {
  const f = fixture(t, { sessionScope: 'group-user' });
  f.store.setSession(`${bot}:${groupId}:111`, { sessionId: 'a' });
  f.store.setSession(`${bot}:${groupId}:222`, { sessionId: 'b' });
  f.store.setSession(`${bot}:${otherGroup}:111`, { sessionId: 'c' });
  await f.bridge.handle(f.message({ text: '/role 活泼的助手' }));
  assert.equal(f.resets.length, 2);
  assert.equal(f.store.room(`${bot}:${groupId}`).role, '活泼的助手');
  assert.ok(f.store.session(`${bot}:${otherGroup}:111`));
});

test('路径和已知凭据不外发；Unicode 长回复按字符截断；每分钟限额', async (t) => {
  const f = fixture(t);
  f.agent.reply = async () => '文件在 C:\\Users\\private\\secret.txt';
  await f.bridge.handle(f.message());
  assert.deepEqual(f.sends, ['这条回复包含敏感信息，已拦截。']);
  f.config.maxMessageChars = 50;
  f.agent.reply = async () => '🐳'.repeat(100);
  await f.bridge.handle(f.message());
  assert.equal([...f.sends[1]].length, 50);
  f.config.maxRepliesPerMinute = 2;
  await f.bridge.handle(f.message());
  assert.equal(f.sends.length, 2);
});

test('服务异常给出可重试提示，不泄露 HTTP 凭据', async (t) => {
  const f = fixture(t);
  f.agent.reply = async () => { throw new Error('Authorization: Bearer SECRET'); };
  await f.bridge.handle(f.message());
  assert.equal(f.sends.length, 1);
  assert.ok(!f.sends[0].includes('SECRET'));
});

test('关闭后不再发送晚到的回答；进程锁阻止重复启动', async (t) => {
  const f = fixture(t);
  const unlock = acquireLock(f.config.stateDir);
  assert.throws(() => acquireLock(f.config.stateDir), /已有实例/);
  unlock();
  const unlock2 = acquireLock(f.config.stateDir); unlock2();
  f.bridge.close();
  assert.equal(await f.bridge.handle(f.message()), false);
});

test('按用户隔离时，管理员重置会阻止其他用户的旧回答外发', async (t) => {
  const f = fixture(t, { sessionScope: 'group-user' });
  let release;
  f.agent.reply = async (key) => {
    f.store.setSession(key, { sessionId: 'old' });
    return new Promise((r) => { release = () => r('过期回答'); });
  };
  const pending = f.bridge.handle(f.message({ senderId: '222' }));
  await new Promise((r) => setImmediate(r));
  await f.bridge.handle(f.message({ text: '/reset' }));
  release();
  await pending;
  assert.deepEqual(f.sends, ['本群会话已重置。']);
});

test('队列上限只处理已接纳的消息', async (t) => {
  const f = fixture(t);
  f.config.maxQueuePerGroup = 1;
  let release;
  f.agent.reply = async () => new Promise((r) => { release = () => r('done'); });
  const pending = f.bridge.handle(f.message());
  await new Promise((r) => setImmediate(r));
  assert.equal(await f.bridge.handle(f.message()), false);
  release();
  await pending;
  assert.deepEqual(f.sends, ['done']);
});

test('抖音发送超时不重发，也不追加可能重复的错误消息', async (t) => {
  const f = fixture(t);
  let attempts = 0;
  const message = f.message({ send: async () => { attempts++; throw new Error('发送结果不确定'); } });
  await assert.rejects(() => f.bridge.handle(message), /不确定/);
  await f.bridge.handle(message);
  assert.equal(attempts, 1);
});
