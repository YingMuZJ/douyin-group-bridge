import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createCipheriv, randomBytes } from 'node:crypto';
import { GroupMessageEvent } from 'douyin-im';
import { validateConfig } from '../../src/douyin/config.mjs';
import { Store } from '../../src/douyin/store.mjs';
import { GroupBridge } from '../../src/douyin/bridge.mjs';
import { FeatureTools, parseReply } from '../../src/douyin/tools.mjs';
import { SocialMemory, socialClock } from '../../src/douyin/social.mjs';
import {
  Vision,
  Voice,
  mediaUrl,
  publicAddress,
} from '../../src/douyin/media.mjs';
import { normalizeGroupMessage } from '../../src/douyin/adapter.mjs';
import { visionKey } from '../../src/douyin/credentials.mjs';
import { ImService } from 'douyin-im/protocol';

const bot = '10001',
  group = '20001',
  user = '30001',
  other = '30002';
let sequence = 0;
test('复用DSH官方Key不复制到配置，禁止向第三方地址发送该Key', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-key-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, '.credentials.yaml'),
    'version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-key-only\n',
  );
  const config = {
    baseUrl: 'https://api.deepseek.com',
    apiKeySource: 'dsh-deepseek',
    apiKeyEnv: 'DOUYIN_VISION_API_KEY',
  };
  assert.equal(visionKey(config, { home: dir, env: {} }), 'fixture-key-only');
  assert.equal(
    visionKey({ ...config, apiKeySource: 'env' }, { home: dir, env: {} }),
    '',
  );
  assert.throws(() =>
    visionKey(
      { ...config, baseUrl: 'https://other.example/v1' },
      { home: dir, env: {} },
    ),
  );
  assert.throws(() =>
    validateConfig(
      {
        features: {
          vision: {
            baseUrl: 'https://other.example/v1',
            apiKeySource: 'dsh-deepseek',
          },
        },
      },
      '.',
    ),
  );
});
function fixture(t, features = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-features-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-17T06:00:00Z');
  const config = validateConfig(
    {
      douyin: { groups: [group, '20002'], owners: [user] },
      features: {
        voice: { enabled: true },
        slang: { enabled: false },
        ...features,
      },
      ...options,
    },
    root,
  );
  const store = new Store(config.stateDir),
    sends = [],
    actions = [],
    calls = [];
  const agent = {
    reply: async (key, prompt) => {
      calls.push({ key, prompt });
      return JSON.stringify({ text: '你好', action: null });
    },
    reset: async (key) => store.setSession(key, null),
  };
  const voice = new Voice(config.features.voice, {
    synthesize: async (text) => Buffer.from('RIFF-' + text),
  });
  const tools = new FeatureTools({ config, voice });
  const bridge = new GroupBridge({
    config,
    store,
    agent,
    tools,
    now: () => time,
    log: () => {},
  });
  t.after(() => bridge.close());
  const msg = (extra = {}) => ({
    accountId: bot,
    groupId: group,
    senderId: user,
    messageId: String(++sequence),
    timestamp: time,
    text: '你好',
    nickname: '群友',
    mentioned: true,
    send: async (text) => sends.push(text),
    react: async (emoji) => actions.push({ type: 'reaction', emoji }),
    listStickers: async () => [{ id: '8000000000000000001', name: '开心' }],
    sendSticker: async (id) => actions.push({ type: 'sticker', id }),
    sendFile: async (file) => actions.push({ type: 'file', ...file }),
    collectSticker: async (a) => actions.push({ type: 'collect', a }),
    ...extra,
  });
  return {
    root,
    config,
    store,
    agent,
    tools,
    bridge,
    sends,
    actions,
    calls,
    msg,
    room: `${bot}:${group}`,
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

test('新功能配置拒绝非布尔开关、非法时区、未配视觉模型和凭据URL', () => {
  assert.throws(
    () => validateConfig({ features: { social: { enabled: 'true' } } }, '.'),
    /true/,
  );
  assert.throws(
    () => validateConfig({ features: { vision: { enabled: true } } }, '.'),
    /配置/,
  );
  assert.throws(
    () =>
      validateConfig(
        { features: { vision: { baseUrl: 'https://user:pass@example.com' } } },
        '.',
      ),
    /HTTPS/,
  );
  assert.throws(
    () =>
      validateConfig({ features: { social: { quietHours: [24, 8] } } }, '.'),
    /0~23/,
  );
  assert.throws(() =>
    validateConfig(
      { features: { social: { timezone: 'not-a-timezone' } } },
      '.',
    ),
  );
});

test('默认关闭语音，帮助菜单和模型动作不再提供语音入口', async (t) => {
  assert.equal(validateConfig({}, '.').features.voice.enabled, false);
  const f = fixture(t, { voice: { enabled: false } });
  f.tools.voice.prepare = async () => assert.fail('关闭的语音不能合成');
  await f.bridge.handle(f.msg({ text: '/ai /help' }));
  assert.ok(!f.sends[0].includes('/voice'));
  await f.bridge.handle(f.msg({ text: '/ai /voice 测试' }));
  assert.equal(f.sends[1], '语音功能已关闭。');
  const directive = await f.tools.directive(f.msg());
  assert.ok(!directive.includes('{"type":"voice"'));
  await assert.rejects(() =>
    f.tools.prepare(f.msg(), { type: 'voice', text: '不应合成' }),
  );
});

test('真实 SDK 类：群媒体接收、收藏表情、音频文件及表态发回来源群', async () => {
  const sent = [],
    reactions = [];
  const sticker = { id: '8000000000000000001', name: '开心' };
  const account = {
    uid: bot,
    imUid: '999',
    getCollectedEmojis: async () => ({
      statusCode: 0,
      page: { stickers: [sticker] },
    }),
    getCachedCollectedEmojis: () => undefined,
    collectEmoji: async () => ({ statusCode: 0, successItems: [sticker] }),
  };
  const contact = {
    groupId: group,
    name: '测试群',
    pickMember: () => undefined,
    ensureMember: () => ({ nickname: '用户' }),
    sendMsg: async (m) => {
      sent.push(m);
      return { statusCode: 0 };
    },
    reactMsg: async (id, emoji) => {
      reactions.push({ id, emoji });
      return { statusCode: 0 };
    },
  };
  account.bindGroup = () => contact;
  const event = GroupMessageEvent.fromInbound(
    {
      raw: {},
      threadId: group,
      conversationShortId: group,
      conversationType: 2,
      senderUid: user,
      serverMessageId: '90001',
      createTime: '1800000000',
      messageType: 5,
      rawContent: JSON.stringify({
        aweType: 507,
        url: {
          uri: 'tos/sticker',
          url_list: ['https://p.example.douyinpic.com/emoji.png'],
        },
      }),
      text: '',
    },
    account,
  );
  const message = normalizeGroupMessage(event, 1800000000000);
  assert.equal(message.kind, 'emoji');
  assert.equal(message.attachment.uri, 'tos/sticker');
  assert.equal(
    message.attachment.url,
    'https://p.example.douyinpic.com/emoji.png',
  );
  await message.sendSticker(sticker.id);
  await message.sendFile({ data: Buffer.from('audio'), name: 'voice.wav' });
  await message.react('👋');
  assert.equal(sent[0].type, 'sticker');
  assert.equal(sent[0].sticker.id, sticker.id);
  assert.equal(sent[1].type, 'file-upload');
  assert.equal(sent[1].name, 'voice.wav');
  assert.deepEqual(reactions, [{ id: '90001', emoji: '👋' }]);
  await assert.rejects(() => message.sendSticker('99999'));
});

test('互动命令和模型动作共用来源群限制、去重和每分钟限额', async (t) => {
  const f = fixture(t, {}, { maxRepliesPerMinute: 2 });
  await f.bridge.handle(f.msg({ text: '/ai /poke' }));
  f.agent.reply = async () =>
    JSON.stringify({
      text: '',
      action: { type: 'sticker', id: '8000000000000000001' },
    });
  const m = f.msg();
  await f.bridge.handle(m);
  await f.bridge.handle(m);
  await f.bridge.handle(f.msg({ text: '/ai /voice 你好' }));
  await f.bridge.handle(f.msg({ groupId: '99999', text: '/ai /poke' }));
  assert.deepEqual(
    f.actions.map((a) => a.type),
    ['reaction', 'sticker'],
  );
  assert.equal(f.sends.length, 0);
});

test('抖音真实SDK发出的表态属性使用平台键，紧凑前缀仍可识别', async (t) => {
  const f = fixture(t);
  const service = new ImService(
    {},
    { deviceId: 'fixture-device', platformUid: bot },
  );
  let body;
  service.transport.sendCookieProto = async (
    _command,
    _inbox,
    _route,
    payload,
  ) => {
    body = payload;
    return {
      statusCode: 0,
      body: { modifyMessagePropertyBody: { status: 0 } },
    };
  };
  await f.bridge.handle(
    f.msg({
      text: '/ai/poke',
      mentioned: false,
      react: (emoji) =>
        service.modifyMessageReaction({
          threadId: group,
          conversationShortId: group,
          conversationType: 2,
          serverMessageId: '90001',
          operatorUid: bot,
          emoji,
          enabled: true,
        }),
    }),
  );
  assert.equal(
    body.modifyMessagePropertyBody.propertyList.modifyPropertyContent[0].key,
    'se:[爱心]',
  );
  assert.equal(
    await f.bridge.handle(
      f.msg({ text: '/aim 不应触发', mentioned: false, senderId: other }),
    ),
    false,
  );
});

test('加密HEIC原图自动退到加密PNG预览，视觉API只调用一次', async (t) => {
  const key = randomBytes(32),
    iv = randomBytes(12);
  const encrypt = (data) => {
    const c = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()]);
  };
  const heic = encrypt(Buffer.from('0000001c667479706865696300000000', 'hex'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN5sAAAAASUVORK5CYII=',
    'base64',
  );
  const preview = encrypt(png),
    downloads = [];
  let calls = 0,
    payload;
  const env = 'DOUYIN_TEST_PREVIEW_KEY',
    prior = process.env[env];
  process.env[env] = 'fixture-preview-key';
  t.after(() => {
    if (prior === undefined) delete process.env[env];
    else process.env[env] = prior;
  });
  const config = {
    enabled: true,
    baseUrl: 'https://vision.example/v1',
    model: 'fixture',
    apiKeyEnv: env,
    maxBytes: 10000,
    timeoutMs: 1000,
  };
  const vision = new Vision(config, {
    download: async (url) => {
      downloads.push(url);
      return url.endsWith('original') ? heic : preview;
    },
    fetcher: async (_url, init) => {
      calls++;
      payload = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '预览图内容' } }] }),
      );
    },
  });
  const answer = await vision.describe(
    {
      url: 'https://p.douyinpic.com/original',
      urls: [
        'https://p.douyinpic.com/original',
        'https://p.douyinpic.com/preview',
      ],
      skey: key.toString('hex'),
    },
    '看图',
  );
  assert.equal(answer, '预览图内容');
  assert.equal(downloads.length, 2);
  assert.equal(calls, 1);
  assert.equal(
    payload.messages[1].content[1].image_url.url,
    'data:image/png;base64,' + png.toString('base64'),
  );
});

test('视觉服务报错后不重新调用模型，也不继续换图重复计费', async (t) => {
  const env = 'DOUYIN_TEST_API_FAILURE_KEY',
    prior = process.env[env];
  process.env[env] = 'fixture-only';
  t.after(() => {
    if (prior === undefined) delete process.env[env];
    else process.env[env] = prior;
  });
  let downloads = 0,
    calls = 0;
  const vision = new Vision(
    {
      enabled: true,
      baseUrl: 'https://vision.example/v1',
      model: 'fixture',
      apiKeyEnv: env,
      maxBytes: 10000,
      timeoutMs: 1000,
    },
    {
      download: async () => {
        downloads++;
        return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      },
      fetcher: async () => {
        calls++;
        return new Response('', { status: 503 });
      },
    },
  );
  await assert.rejects(
    () =>
      vision.describe(
        {
          url: 'https://p.douyinpic.com/a',
          urls: ['https://p.douyinpic.com/b'],
        },
        '看图',
      ),
    (e) => e.code === 'VISION_HTTP' && e.statusCode === 503,
  );
  assert.equal(downloads, 1);
  assert.equal(calls, 1);
});

test('模型不能指定任意目标、文件路径或未知动作，语音精确密钥不外发', async (t) => {
  assert.throws(() =>
    parseReply('{"text":"x","action":{"type":"poke","groupId":"999"}}'),
  );
  assert.throws(() =>
    parseReply('{"text":"x","action":{"type":"shell","text":"echo"}}'),
  );
  assert.throws(() =>
    parseReply('{"text":"x","action":{"type":"voice","id":"../../file"}}'),
  );
  const f = fixture(t, {}, { dsh: { authToken: 'local-test-known-token' } });
  f.agent.reply = async () =>
    JSON.stringify({
      text: '',
      action: { type: 'voice', text: 'local-test-known-token' },
    });
  await f.bridge.handle(f.msg());
  assert.equal(f.actions.length, 0);
  assert.match(f.sends[0], /准备失败/);
});

test('媒体发送超时不会重试，也不会接着发送正文或错误消息', async (t) => {
  const f = fixture(t);
  let count = 0;
  f.agent.reply = async () =>
    JSON.stringify({
      text: '已经发送',
      action: { type: 'sticker', id: '8000000000000000001' },
    });
  const m = f.msg({
    sendSticker: async () => {
      count++;
      throw new Error('uncertain send');
    },
  });
  await assert.rejects(() => f.bridge.handle(m));
  await f.bridge.handle(m);
  assert.equal(count, 1);
  assert.equal(f.sends.length, 0);
});

test('平台返回审核码10502时不当作送达，也不自动重发音频', async (t) => {
  const f = fixture(t);
  let sends = 0;
  const notices = [];
  const groupContact = {
    groupId: group,
    name: '测试群',
    pickMember: () => undefined,
    ensureMember: () => ({ nickname: '用户' }),
    sendMsg: async (message) => {
      if (typeof message === 'string') {
        notices.push(message);
        return { statusCode: 0 };
      }
      sends++;
      return { statusCode: 0, checkCode: 10502 };
    },
  };
  const account = { uid: bot, imUid: '999', bindGroup: () => groupContact };
  const event = GroupMessageEvent.fromInbound(
    {
      raw: {},
      threadId: group,
      conversationShortId: group,
      conversationType: 2,
      senderUid: user,
      serverMessageId: '90002',
      createTime: String(f.now() / 1000),
      messageType: 7,
      rawContent: JSON.stringify({
        aweType: 700,
        type: 0,
        text: '/ai /voice 测试',
      }),
      text: '/ai /voice 测试',
    },
    account,
  );
  const m = normalizeGroupMessage(event, f.now());
  await f.bridge.handle(m);
  await f.bridge.handle(m);
  assert.equal(sends, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /平台审核/);
  assert.equal(f.store.room(f.room).mediaDelivery.voice.state, 'review');
  await f.bridge.handle(f.msg({ text: '/ai /poke' }));
  await f.bridge.handle(f.msg({ text: '/ai /voice status' }));
  assert.match(f.sends[0], /平台审核/);
});

test('正常投递回执8101不会被误判为审核失败', async () => {
  const contact = {
    groupId: group,
    pickMember: () => undefined,
    ensureMember: () => ({ nickname: '用户' }),
    sendMsg: async () => ({ statusCode: 0, checkCode: 8101 }),
  };
  const event = GroupMessageEvent.fromInbound(
    {
      raw: {},
      threadId: group,
      conversationShortId: group,
      conversationType: 2,
      senderUid: user,
      serverMessageId: '90003',
      createTime: '1800000000',
      messageType: 7,
      rawContent: JSON.stringify({ aweType: 700, text: '你好' }),
      text: '你好',
    },
    { uid: bot, bindGroup: () => contact },
  );
  const response = await normalizeGroupMessage(event, 1800000000000).send(
    '回复',
  );
  assert.equal(response.checkCode, 8101);
});

test('模型选择沉默时不执行附带的表情动作', async (t) => {
  const f = fixture(t);
  f.agent.reply = async () =>
    JSON.stringify({ text: '[SILENT]', action: { type: 'poke' } });
  await f.bridge.handle(f.msg());
  assert.equal(f.actions.length, 0);
  assert.equal(f.sends.length, 0);
});

test('语音异步合成期间静默/关闭会阻止晚到音频外发', async (t) => {
  const f = fixture(
    t,
    {},
    { douyin: { groups: [group], owners: [user], sessionScope: 'group-user' } },
  );
  let release, entered;
  const ready = new Promise((r) => {
    entered = r;
  });
  f.tools.voice.synthesize = async () => {
    entered();
    return new Promise((r) => {
      release = r;
    });
  };
  const task = f.bridge.handle(
    f.msg({ senderId: other, text: '/ai /voice 你好' }),
  );
  await ready;
  await f.bridge.handle(f.msg({ text: '/silent' }));
  release(Buffer.from('RIFFaudio'));
  await task;
  assert.equal(f.actions.length, 0);
});

test('语音库只公开稳定ID，拒绝库外路径及超大文件', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.config.features.voice.libraryDir, { recursive: true });
  fs.writeFileSync(
    path.join(f.config.features.voice.libraryDir, '你好.wav'),
    'RIFFaudio',
  );
  const voice = f.tools.voice,
    list = voice.list();
  assert.equal(list.length, 1);
  assert.match(list[0].id, /^[a-f0-9]{12}$/);
  const file = await voice.prepare({ id: list[0].id });
  assert.equal(file.name, 'voice.wav');
  await assert.rejects(() => voice.prepare({ id: '../../secret' }));
  await assert.rejects(() => voice.prepare({ text: 'a'.repeat(301) }));
  await f.bridge.handle(f.msg({ text: '/ai /voice list' }));
  assert.ok(!f.sends[0].includes(f.root));
});

test('未触发的媒体只缓存；看图限于同群同发送者两分钟内的图片', async (t) => {
  const f = fixture(t, {
    vision: {
      enabled: true,
      model: 'test-vision',
      baseUrl: 'http://127.0.0.1:1234/v1',
    },
  });
  const seen = [];
  f.tools.vision = {
    describe: async (a, q) => {
      seen.push({ a, q });
      return '一只猫';
    },
  };
  const a = {
    kind: 'image',
    url: 'https://p.example.douyinpic.com/x',
    skey: 'not-for-prompts',
  };
  assert.equal(
    await f.bridge.handle(f.msg({ text: '', mentioned: false, attachment: a })),
    false,
  );
  await f.bridge.handle(f.msg({ senderId: other, text: '/ai /image 是什么' }));
  assert.equal(seen.length, 0);
  assert.match(f.sends[0], /先发送图片/);
  await f.bridge.handle(f.msg({ text: '/ai /image 是什么' }));
  assert.equal(seen.length, 1);
  assert.match(f.calls[0].prompt, /一只猫/);
  assert.ok(!f.calls[0].prompt.includes('not-for-prompts'));
  assert.ok(!f.calls[0].prompt.includes(a.url));
  f.advance(121000);
  await f.bridge.handle(f.msg({ text: '/ai /image 是什么' }));
  assert.equal(seen.length, 1);
});

test('视觉模型未配置时明确提示，不调用文字模型捏造图片', async (t) => {
  const f = fixture(t);
  await f.bridge.handle(
    f.msg({
      text: '',
      attachment: { kind: 'image', url: 'https://p.example.douyinpic.com/x' },
    }),
  );
  assert.equal(f.calls.length, 0);
  assert.match(f.sends[0], /未启用/);
});

test('媒体下载拒绝伪装CDN、非HTTPS、本机/IP及私有DNS地址', () => {
  for (const u of [
    'http://p.douyinpic.com/a',
    'https://douyinpic.com.attacker.test/a',
    'https://127.0.0.1/a',
    'https://user:pass@p.douyinpic.com/a',
    'https://p.douyinpic.com:444/a',
  ])
    assert.throws(() => mediaUrl(u));
  assert.equal(
    mediaUrl('https://p.douyinpic.com/a').hostname,
    'p.douyinpic.com',
  );
  for (const a of [
    '127.0.0.1',
    '10.0.0.2',
    '172.16.1.2',
    '192.168.0.1',
    '169.254.1.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
  ])
    assert.equal(publicAddress(a), false);
  assert.equal(publicAddress('8.8.8.8'), true);
});

test('真实 HTTP 视觉接口：图片解密和Base64输入，密钥留在请求头', async (t) => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN5sAAAAASUVORK5CYII=',
    'base64',
  );
  const key = randomBytes(32),
    iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    iv,
    cipher.update(png),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  let received;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received = {
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
      url: req.url,
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ choices: [{ message: { content: '测试图片' } }] }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => server.close(r)));
  const env = 'DOUYIN_TEST_VISION_KEY';
  const prev = process.env[env];
  process.env[env] = 'test-key-in-header';
  t.after(() => {
    if (prev === undefined) delete process.env[env];
    else process.env[env] = prev;
  });
  const config = {
    enabled: true,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'fixture-vision',
    apiKeyEnv: env,
    maxBytes: 10000,
    timeoutMs: 1000,
  };
  const vision = new Vision(config, { download: async () => encrypted });
  const answer = await vision.describe(
    { url: 'https://p.douyinpic.com/x', skey: key.toString('hex') },
    '这是什么',
  );
  assert.equal(answer, '测试图片');
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.headers.authorization, 'Bearer test-key-in-header');
  assert.equal(received.headers.cookie, undefined);
  assert.equal(
    received.body.messages[1].content[1].image_url.url,
    `data:image/png;base64,${png.toString('base64')}`,
  );
  assert.ok(!JSON.stringify(received.body).includes(process.env[env]));
});

test('黑话从未触发的新消息学习，证据必须真实，按群隔离且不假称联网', async (t) => {
  const f = fixture(t, {
    slang: { enabled: true, minMessages: 2, intervalMs: 1000 },
  });
  f.agent.reply = async (key, prompt) => {
    f.calls.push({ key, prompt });
    const sample = JSON.parse(prompt.split('\n').at(-1));
    return JSON.stringify([
      { content: '绝绝子', meaning: '很棒', source_id: sample[0].id },
      { content: '编造词', meaning: '不存在', source_id: sample[0].id },
    ]);
  };
  await f.bridge.handle(f.msg({ text: '今天这个绝绝子', mentioned: false }));
  await f.bridge.handle(
    f.msg({ text: '确实绝绝子', mentioned: false, senderId: other }),
  );
  await f.bridge.memory.learning;
  const entries = f.store.room(f.room).slang;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'confirmed');
  assert.equal(entries[0].count, 2);
  assert.equal(f.sends.length, 0);
  assert.match(f.bridge.memory.context(f.room), /绝绝子/);
  assert.equal(f.bridge.memory.context(`${bot}:20002`), '');
  assert.ok(f.calls[0].key.endsWith(':slang'));
  assert.match(f.calls[0].prompt, /不要声称联网确认/);
  const reloaded = new Store(f.config.stateDir);
  assert.equal(reloaded.room(f.room).slang.length, 1);
});

test('黑话学习去重，管理员可以拒绝，非管理员无法关停或清空', async (t) => {
  const f = fixture(t, {
    slang: { enabled: true, minMessages: 2, intervalMs: 1000 },
  });
  const memory = f.bridge.memory;
  const m = f.msg({ text: '绝绝子', mentioned: false });
  await f.bridge.handle(m);
  await f.bridge.handle(m);
  assert.equal(memory.rooms.get(f.room).messages.length, 1);
  f.store.updateRoom(f.room, {
    slang: [
      { content: '绝绝子', meaning: '很棒', status: 'confirmed', count: 2 },
    ],
  });
  assert.match(memory.command(f.room, 'clear', false), /管理员/);
  memory.command(f.room, 'reject 绝绝子', true);
  assert.equal(memory.context(f.room), '');
  memory.command(f.room, 'off', true);
  assert.equal(f.store.room(f.room).slangEnabled, false);
});

test('管理员清空黑话时，挂起学习结果不能重新写回', async (t) => {
  const f = fixture(t, {
    slang: { enabled: true, minMessages: 2, intervalMs: 1000 },
  });
  let resolve;
  f.agent.reply = async () =>
    new Promise((r) => {
      resolve = r;
    });
  const a = f.msg({ text: '绝绝子', mentioned: false });
  await f.bridge.handle(a);
  await f.bridge.handle(
    f.msg({ text: '绝绝子', mentioned: false, senderId: other }),
  );
  f.bridge.memory.command(f.room, 'clear', true);
  resolve(
    JSON.stringify([
      { content: '绝绝子', meaning: '很好', source_id: a.messageId },
    ]),
  );
  await f.bridge.memory.learning;
  assert.deepEqual(f.store.room(f.room).slang, []);
});

test('主动发言默认关闭；开启后只在空闲时发，遵守冷却和每日持久上限', async (t) => {
  const f = fixture(t, {
    social: { idleMs: 1000, cooldownMs: 1000, minMessages: 2, maxPerDay: 1 },
  });
  await f.bridge.handle(f.msg({ text: '今天在聊跑步', mentioned: false }));
  await f.bridge.handle(
    f.msg({ text: '可以周末试试', mentioned: false, senderId: other }),
  );
  f.advance(1500);
  await f.bridge.tick();
  assert.equal(f.sends.length, 0);
  assert.match(f.bridge.memory.socialCommand(f.room, 'on', false), /管理员/);
  f.bridge.memory.socialCommand(f.room, 'on', true);
  await f.bridge.tick();
  assert.equal(f.sends.length, 1);
  assert.match(f.calls[0].prompt, /主动聊天/);
  assert.equal(f.store.room(f.room).socialAttempts, 1);
  await f.bridge.handle(f.msg({ text: '新内容一', mentioned: false }));
  await f.bridge.handle(f.msg({ text: '新内容二', mentioned: false }));
  f.advance(1500);
  await f.bridge.tick();
  assert.equal(f.sends.length, 1);
  const memory = new SocialMemory({
    config: f.config,
    store: new Store(f.config.stateDir),
    agent: f.agent,
    now: f.now,
  });
  memory.observe(f.msg({ text: '第三句' }));
  memory.observe(f.msg({ text: '第四句' }));
  f.advance(1500);
  await memory.tick(() => assert.fail('跨重启不能突破日限额'));
  memory.close();
});

test('主动生成期间群友重新说话，会丢弃旧的主动回复', async (t) => {
  const f = fixture(t, {
    social: { enabled: true, idleMs: 1000, cooldownMs: 1000, minMessages: 2 },
  });
  await f.bridge.handle(f.msg({ text: '聊点音乐', mentioned: false }));
  await f.bridge.handle(f.msg({ text: '今天听了歌', mentioned: false }));
  let release, enter;
  const ready = new Promise((r) => {
    enter = r;
  });
  f.agent.reply = async () => {
    enter();
    return new Promise((r) => {
      release = r;
    });
  };
  f.advance(1500);
  const task = f.bridge.tick();
  await ready;
  await f.bridge.handle(f.msg({ text: '现在正在说话', mentioned: false }));
  release('{"text":"过时主动回复","action":null}');
  await task;
  assert.equal(f.sends.length, 0);
});

test('主动发言遵循北京时间跨午夜静默，禁用后不发送，旧话题不重提', async (t) => {
  const f = fixture(t, {
    social: {
      enabled: true,
      idleMs: 1000,
      cooldownMs: 1000,
      minMessages: 2,
      maxContextAgeMs: 60000,
    },
  });
  const cfg = f.config.features.social;
  assert.equal(
    socialClock(Date.parse('2026-10-17T16:00:00Z'), cfg).quiet,
    true,
  );
  assert.equal(
    socialClock(Date.parse('2026-10-17T00:00:00Z'), cfg).quiet,
    false,
  );
  await f.bridge.handle(f.msg({ text: '话题一', mentioned: false }));
  await f.bridge.handle(f.msg({ text: '话题二', mentioned: false }));
  f.advance(61000);
  await f.bridge.tick();
  assert.equal(f.sends.length, 0);
  f.bridge.memory.socialCommand(f.room, 'off', true);
  assert.equal(f.store.room(f.room).socialEnabled, false);
});
