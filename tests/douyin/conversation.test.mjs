import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateConfig } from '../../src/douyin/config.mjs';
import { Store } from '../../src/douyin/store.mjs';
import { GroupBridge } from '../../src/douyin/bridge.mjs';
import { socialReply } from '../../src/douyin/conversation.mjs';
import { GroupMessageEvent } from 'douyin-im';
import { normalizeGroupMessage } from '../../src/douyin/adapter.mjs';

let seq = 0;
test('引用方向按真实SDK的referenceInfo.hint读取', () => {
  const contact = {
    groupId: '20001',
    pickMember: () => undefined,
    ensureMember: () => ({ nickname: '群友' }),
  };
  const account = { uid: '10001', imUid: '10002', bindGroup: () => contact };
  const inbound = {
    raw: {},
    threadId: '20001',
    conversationShortId: '20001',
    conversationType: 2,
    senderUid: '30001',
    serverMessageId: '90001',
    createTime: '1800000000',
    messageType: 7,
    rawContent: JSON.stringify({ aweType: 700, text: '接着说' }),
    text: '接着说',
  };
  const mine = normalizeGroupMessage(
    GroupMessageEvent.fromInbound(
      {
        ...inbound,
        referenceInfo: {
          refMessageId: '80001',
          hint: JSON.stringify({ refmsg_uid: '10002' }),
        },
      },
      account,
    ),
    1800000000000,
  );
  const other = normalizeGroupMessage(
    GroupMessageEvent.fromInbound(
      {
        ...inbound,
        referenceInfo: {
          refMessageId: '80002',
          hint: JSON.stringify({ refmsg_uid: '40001' }),
        },
      },
      account,
    ),
    1800000000000,
  );
  assert.equal(mine.repliedToBot, true);
  assert.equal(mine.repliedToOther, false);
  assert.equal(other.repliedToOther, true);
});
function fixture(t, social = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-conversation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-18T06:00:00Z');
  const config = validateConfig(
    {
      douyin: {
        groups: ['20001', '20002'],
        owners: ['30001'],
        trigger: 'social',
      },
      role: '你叫小木，轻松嘴贫但有分寸。每次最多20字。',
      features: {
        slang: { enabled: false },
        social: {
          enabled: true,
          batchWindowMs: 100,
          replyCooldownMs: 1000,
          replyProbability: 1,
          maxChecksPerHour: 2,
          replyMaxChars: 20,
          minMessages: 2,
          idleMs: 1000,
          cooldownMs: 1000,
          ...social,
        },
      },
      ...options,
    },
    root,
  );
  const store = new Store(config.stateDir),
    calls = [],
    sends = [];
  const agent = {
    reply: async (key, prompt) => {
      calls.push({ key, prompt });
      return JSON.stringify({ text: '这话我还真接得上', action: null });
    },
    reset: async (key) => store.setSession(key, null),
  };
  const bridge = new GroupBridge({
    config,
    store,
    agent,
    now: () => time,
    random: () => 0,
    log: () => {},
  });
  t.after(() => bridge.close());
  const msg = (extra = {}) => ({
    accountId: '10001',
    groupId: '20001',
    senderId: '30001',
    nickname: '群友',
    messageId: String(++seq),
    timestamp: time,
    text: '今天打算去骑车',
    mentioned: false,
    send: async (text) => {
      sends.push({ groupId: extra.groupId ?? '20001', text });
      return { statusCode: 0 };
    },
    ...extra,
  });
  return {
    root,
    config,
    store,
    calls,
    sends,
    agent,
    bridge,
    msg,
    room: '10001:20001',
    advance: (ms) => {
      time += ms;
    },
    now: () => time,
  };
}

test('叫名字无需@；接着对话无需再次叫名字', async (t) => {
  const f = fixture(t, { replyProbability: 0 });
  await f.bridge.handle(f.msg({ text: '小木，今天你咋看' }));
  await f.bridge.conversation.flush(f.room);
  assert.equal(f.sends.length, 1);
  assert.match(f.calls[0].prompt, /叫名字/);
  f.advance(1000);
  await f.bridge.handle(f.msg({ text: '那你说说为啥' }));
  await f.bridge.conversation.flush(f.room);
  assert.equal(f.sends.length, 2);
  assert.match(f.calls[1].prompt, /连续聊天/);
});

test('普通群聊合并成一次检查，提示词包含未@的真实上下文', async (t) => {
  const f = fixture(t);
  await f.bridge.handle(f.msg({ text: '今天骑车有点累' }));
  await f.bridge.handle(f.msg({ senderId: '30002', text: '主要是那个大坡' }));
  await f.bridge.conversation.flush(f.room);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].prompt.includes('今天骑车有点累'));
  assert.ok(f.calls[0].prompt.includes('主要是那个大坡'));
  assert.match(f.calls[0].prompt, /观望接话/);
});

test('非目标群不观察不接话；引用别人的消息不抢答', async (t) => {
  const f = fixture(t);
  assert.equal(
    await f.bridge.handle(f.msg({ groupId: '99999', text: '小木你好' })),
    false,
  );
  assert.equal(await f.bridge.handle(f.msg({ repliedToOther: true })), false);
  assert.equal(f.bridge.memory.rooms.has('10001:99999'), false);
  assert.equal(f.calls.length, 0);
  await f.bridge.handle(f.msg({ repliedToBot: true }));
  await f.bridge.conversation.flush(f.room);
  assert.equal(f.calls.length, 1);
});

test('重复入站不安排第二次自然接话', async (t) => {
  const f = fixture(t);
  const m = f.msg({ text: '小木你来评评' });
  await f.bridge.handle(m);
  await f.bridge.conversation.flush(f.room);
  await f.bridge.handle(m);
  await f.bridge.conversation.flush(f.room);
  assert.equal(f.sends.length, 1);
});

test('旁听检查有持久每小时预算，点名和@不被随机过滤', async (t) => {
  const f = fixture(t, { maxChecksPerHour: 1 });
  await f.bridge.handle(f.msg());
  await f.bridge.conversation.flush(f.room);
  f.advance(2000);
  await f.bridge.handle(f.msg({ senderId: '30002', text: '另一条普通群聊' }));
  await f.bridge.conversation.flush(f.room);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.room(f.room).conversationChecks.length, 1);
  await f.bridge.handle(f.msg({ senderId: '30002', text: '小木说两句' }));
  await f.bridge.conversation.flush(f.room);
  assert.equal(f.calls.length, 2);
  await f.bridge.handle(f.msg({ mentioned: true, text: '直接提问' }));
  assert.equal(f.calls.length, 3);
});

test('普通群聊可选择沉默，不把SILENT发出', async (t) => {
  const f = fixture(t);
  f.agent.reply = async () => '{"text":"[SILENT]","action":null}';
  await f.bridge.handle(f.msg());
  await f.bridge.conversation.flush(f.room);
  assert.equal(f.sends.length, 0);
});

test('旁听生成期间有新话会丢弃旧回答；显式点名不会被无关新消息取消', async (t) => {
  const f = fixture(t);
  let release, enter;
  let ready = new Promise((r) => {
    enter = r;
  });
  f.agent.reply = async () => {
    enter();
    return new Promise((r) => {
      release = r;
    });
  };
  await f.bridge.handle(f.msg());
  const task = f.bridge.conversation.flush(f.room);
  await ready;
  await f.bridge.handle(f.msg({ senderId: '30002', text: '话题已经变了' }));
  release('{"text":"过时回答","action":null}');
  await task;
  assert.equal(f.sends.length, 0);
  ready = new Promise((r) => {
    enter = r;
  });
  await f.bridge.handle(f.msg({ text: '小木你来' }));
  const direct = f.bridge.conversation.flush(f.room);
  await ready;
  await f.bridge.handle(f.msg({ senderId: '30002', text: '别人还在聊' }));
  release('{"text":"我在呢","action":null}');
  await direct;
  assert.equal(f.sends.length, 1);
});

test('静默和social off取消待发接话，关闭后不会晚发', async (t) => {
  const f = fixture(t);
  await f.bridge.handle(f.msg({ text: '小木你好' }));
  await f.bridge.handle(f.msg({ text: '/silent' }));
  await f.bridge.conversation.flush(f.room);
  assert.equal(f.calls.length, 0);
  await f.bridge.handle(f.msg({ text: '/active' }));
  await f.bridge.handle(f.msg({ text: '小木你好呀' }));
  await f.bridge.handle(f.msg({ text: '/social off' }));
  await f.bridge.conversation.flush(f.room);
  assert.equal(f.calls.length, 0);
  await f.bridge.handle(f.msg({ mentioned: true, text: '手动提问仍可用' }));
  assert.equal(f.calls.length, 1);
});

test('连续聊天窗口到期后不会无限追着同一个人说', async (t) => {
  const f = fixture(t, { replyProbability: 0, followupWindowMs: 1000 });
  await f.bridge.handle(f.msg({ mentioned: true }));
  f.advance(1500);
  await f.bridge.handle(f.msg({ text: '很晚才接着聊' }));
  await f.bridge.conversation.flush(f.room);
  assert.equal(f.calls.length, 1);
});

test('聊天回复硬限制20字、去emoji和不可打印字符，管理员帮助不截断', async (t) => {
  const f = fixture(t);
  f.agent.reply = async () =>
    JSON.stringify({
      text: '哈哈😀\u200b这是一段故意超过二十个字的测试回复不能一直说下去',
      action: null,
    });
  await f.bridge.handle(f.msg({ mentioned: true }));
  assert.ok([...f.sends[0].text].length <= 20);
  assert.ok(!/[\p{Extended_Pictographic}\p{Cf}]/u.test(f.sends[0].text));
  await f.bridge.handle(f.msg({ text: '/help' }));
  assert.ok(f.sends.at(-1).text.includes('/social'));
  assert.equal(
    socialReply('hello\u0000😀', { allowEmoji: false, replyMaxChars: 20 }),
    'hello',
  );
});

test('敏感内容在20字截断前拦截，不能泄露密钥前缀', async (t) => {
  const secret = 'fixture-private-secret-that-is-longer-than-twenty';
  const f = fixture(t, {}, { dsh: { authToken: secret } });
  f.agent.reply = async () => JSON.stringify({ text: secret, action: null });
  await f.bridge.handle(f.msg({ mentioned: true }));
  assert.ok(!f.sends[0].text.includes(secret.slice(0, 12)));
});

test('正常接话后仍能在空闲时主动开话题，不能自言自语循环', async (t) => {
  const f = fixture(t);
  await f.bridge.handle(f.msg({ text: '小木今天想骑车' }));
  await f.bridge.conversation.flush(f.room);
  f.advance(500);
  await f.bridge.handle(f.msg({ text: '但是那个坡太大' }));
  await f.bridge.conversation.flush(f.room);
  f.advance(1500);
  await f.bridge.tick();
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[2].prompt, /主动聊天/);
  f.advance(1500);
  await f.bridge.tick();
  assert.equal(f.calls.length, 3);
});

test('人设文件只允许roles内Markdown，文本注入实际生效', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'roles'));
  fs.writeFileSync(
    path.join(f.root, 'roles', '小木.md'),
    '我是小木。每次二十字。',
  );
  assert.equal(
    validateConfig({ roleFile: '小木.md' }, f.root).role,
    '我是小木。每次二十字。',
  );
  assert.throws(() => validateConfig({ roleFile: '../config.json' }, f.root));
  assert.throws(() =>
    validateConfig({ features: { social: { replyProbability: 2 } } }, f.root),
  );
});
