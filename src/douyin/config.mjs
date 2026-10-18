import fs from 'node:fs';
import path from 'node:path';
import { featureConfig } from './features-config.mjs';

export function identifier(value, label = 'ID') {
  // SDK IDs are int64 strings. Accepting a JS number would lose precision.
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new TypeError(`${label} 必须是非零数字字符串，请用双引号包住完整 ID`);
  }
  return value;
}

function integer(value, fallback, min, max, label) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max)
    throw new TypeError(`${label} 范围为 ${min}~${max}`);
  return n;
}

export function validateConfig(raw, root) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new TypeError('配置顶层必须是对象');
  const ids = (value, label) => {
    if (!Array.isArray(value)) throw new TypeError(`${label} 必须是数组`);
    return [...new Set(value.map((v) => identifier(v, label)))];
  };
  const groups = ids(raw.douyin?.groups ?? [], 'douyin.groups');
  const owners = ids(raw.douyin?.owners ?? [], 'douyin.owners');
  const trigger = raw.douyin?.trigger ?? 'mention';
  if (!['mention', 'prefix', 'all', 'social'].includes(trigger))
    throw new TypeError('trigger 只能是 mention / prefix / all / social');
  const prefix = raw.douyin?.prefix ?? '/ai';
  if (typeof prefix !== 'string' || !prefix.trim() || prefix.length > 40)
    throw new TypeError('prefix 必须是 1~40 字符');
  const sessionScope = raw.douyin?.sessionScope ?? 'group';
  if (!['group', 'group-user'].includes(sessionScope))
    throw new TypeError('sessionScope 只能是 group / group-user');
  const baseUrl = new URL(raw.dsh?.baseUrl ?? 'http://127.0.0.1:3080');
  if (
    !['http:', 'https:'].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password
  )
    throw new TypeError('DSH 地址无效');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname);
  if (!local) throw new TypeError('此群聊改装版仅连接本机 DSH，请使用回环地址');
  const provider = raw.dsh?.provider ?? '';
  const model = raw.dsh?.model ?? '';
  if (
    typeof provider !== 'string' ||
    typeof model !== 'string' ||
    Boolean(provider) !== Boolean(model)
  ) {
    throw new TypeError(
      'dsh.provider 和 model 必须同时填写，或同时留空使用 DSH 默认模型',
    );
  }
  let role = raw.role ?? '你是抖音群里的 AI 助手。用简短、自然的中文回答。';
  const roleFile = raw.roleFile ?? '';
  if (typeof roleFile !== 'string')
    throw new TypeError('roleFile 必须是 Markdown 文件名字符串');
  if (roleFile) {
    if (typeof roleFile !== 'string' || !/^[^\\/.:]{1,80}\.md$/u.test(roleFile))
      throw new TypeError('roleFile 必须是 roles 内的 Markdown 文件名');
    const roleDir = fs.realpathSync(path.join(root, 'roles')),
      file = fs.realpathSync(path.join(roleDir, roleFile));
    if (path.dirname(file) !== roleDir || fs.statSync(file).size > 24000)
      throw new TypeError('人设文件路径或大小无效');
    role = fs
      .readFileSync(file, 'utf8')
      .replace(/^\uFEFF/, '')
      .trim();
  }
  if (typeof role !== 'string' || role.length > 6000)
    throw new TypeError('role 必须是至多 6000 字符的字符串');
  return {
    stateDir: path.join(root, 'state', 'douyin'),
    douyin: { groups, owners, trigger, prefix, sessionScope },
    dsh: {
      baseUrl: baseUrl.origin,
      authToken: process.env.DSH_LAUNCH_TOKEN || raw.dsh?.authToken || '',
      provider,
      model,
      reasoningEffort: raw.dsh?.reasoningEffort ?? 'high',
      preset: 'douyin-group-chat',
      timeoutMs: integer(
        raw.dsh?.timeoutMs,
        180000,
        1000,
        600000,
        'dsh.timeoutMs',
      ),
    },
    role,
    roleFile,
    features: featureConfig(raw.features, root),
    maxMessageChars: integer(
      raw.maxMessageChars,
      500,
      50,
      1000,
      'maxMessageChars',
    ),
    maxRepliesPerMinute: integer(
      raw.maxRepliesPerMinute,
      6,
      1,
      30,
      'maxRepliesPerMinute',
    ),
    maxQueuePerGroup: integer(
      raw.maxQueuePerGroup,
      8,
      1,
      30,
      'maxQueuePerGroup',
    ),
    maxActiveGroups: integer(raw.maxActiveGroups, 8, 1, 30, 'maxActiveGroups'),
    contextWindow: integer(raw.contextWindow, 12, 0, 50, 'contextWindow'),
    maxMessageAgeSeconds: integer(
      raw.maxMessageAgeSeconds,
      300,
      10,
      3600,
      'maxMessageAgeSeconds',
    ),
  };
}

export function loadConfig(file, root) {
  if (!fs.existsSync(file))
    throw new Error('缺少 config.douyin.json，请先运行 npm run init');
  return validateConfig(
    JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')),
    root,
  );
}
