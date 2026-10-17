import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';

export function visionKey(
  config,
  {
    env = process.env,
    home = env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  } = {},
) {
  if (env[config.apiKeyEnv]) return env[config.apiKeyEnv];
  if (config.apiKeySource !== 'dsh-deepseek') return '';
  // A saved official DeepSeek key is never forwarded to a third-party origin.
  if (new URL(config.baseUrl).origin !== 'https://api.deepseek.com')
    throw new Error('DSH DeepSeek Key 仅用于官方 DeepSeek API');
  try {
    const data = yaml.load(
      fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8'),
    );
    const value = data?.refs?.DEEPSEEK_API_KEY;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}
