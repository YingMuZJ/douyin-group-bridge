import path from 'node:path';

function flag(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean')
    throw new TypeError(`${label} 必须为 true / false`);
  return value;
}
function count(value, fallback, min, max, label) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max)
    throw new TypeError(`${label} 范围为 ${min}~${max}`);
  return n;
}

export function featureConfig(raw = {}, root) {
  const v = raw.vision ?? {},
    s = raw.social ?? {},
    l = raw.slang ?? {},
    a = raw.voice ?? {};
  const base = new URL(v.baseUrl ?? 'https://api.example.com/v1');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new TypeError(
      'vision.baseUrl 需要 HTTPS 地址或本机 HTTP 地址，不含凭据/查询参数',
    );
  }
  const model = v.model ?? '',
    apiKeyEnv = v.apiKeyEnv ?? 'DOUYIN_VISION_API_KEY';
  if (
    typeof model !== 'string' ||
    model.length > 200 ||
    !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)
  )
    throw new TypeError('视觉模型或 API Key 环境变量名无效');
  const visionEnabled = flag(v.enabled, false, 'vision.enabled');
  const apiKeySource = v.apiKeySource ?? 'env';
  if (!['env', 'dsh-deepseek'].includes(apiKeySource))
    throw new TypeError('vision.apiKeySource 只能为 env / dsh-deepseek');
  if (
    apiKeySource === 'dsh-deepseek' &&
    base.origin !== 'https://api.deepseek.com'
  )
    throw new TypeError('DSH DeepSeek Key 只能用于官方 DeepSeek API');
  if (visionEnabled && (!model || base.hostname === 'api.example.com'))
    throw new TypeError('先配置视觉模型 baseUrl 和 model，再启用 vision');
  const quiet = s.quietHours ?? [23, 8];
  if (
    !Array.isArray(quiet) ||
    quiet.length !== 2 ||
    quiet.some((n) => !Number.isInteger(n) || n < 0 || n > 23)
  )
    throw new TypeError('social.quietHours 需要两个 0~23 的整数');
  const timezone = s.timezone ?? 'Asia/Shanghai';
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  const engine = a.tts ?? (process.platform === 'win32' ? 'windows' : 'none');
  if (!['windows', 'none'].includes(engine))
    throw new TypeError('voice.tts 只能是 windows / none');
  return {
    poke: {
      enabled: flag(raw.poke?.enabled, true, 'poke.enabled'),
      emoji: '[爱心]',
    },
    stickers: {
      enabled: flag(raw.stickers?.enabled, true, 'stickers.enabled'),
    },
    voice: {
      enabled: flag(a.enabled, false, 'voice.enabled'),
      tts: engine,
      libraryDir: path.join(root, 'audio', 'douyin'),
      maxBytes: 8 * 1024 * 1024,
      maxChars: 300,
    },
    vision: {
      enabled: visionEnabled,
      baseUrl: base.href.replace(/\/$/, ''),
      model,
      apiKeyEnv,
      apiKeySource,
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 60000,
    },
    slang: {
      enabled: flag(l.enabled, true, 'slang.enabled'),
      minMessages: count(l.minMessages, 12, 2, 100, 'slang.minMessages'),
      intervalMs: count(
        l.intervalMs,
        300000,
        1000,
        86400000,
        'slang.intervalMs',
      ),
      confirmations: count(l.confirmations, 2, 2, 20, 'slang.confirmations'),
    },
    social: {
      enabled: flag(s.enabled, false, 'social.enabled'),
      idleMs: count(s.idleMs, 900000, 1000, 86400000, 'social.idleMs'),
      cooldownMs: count(
        s.cooldownMs,
        1800000,
        1000,
        86400000,
        'social.cooldownMs',
      ),
      minMessages: count(s.minMessages, 6, 2, 100, 'social.minMessages'),
      maxPerDay: count(s.maxPerDay, 3, 1, 24, 'social.maxPerDay'),
      maxContextAgeMs: count(
        s.maxContextAgeMs,
        7200000,
        60000,
        86400000,
        'social.maxContextAgeMs',
      ),
      quietHours: quiet,
      timezone,
    },
  };
}
