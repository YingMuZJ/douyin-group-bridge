#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson } from '../src/douyin/store.mjs';

export function installPreset({ home, root, profile = 'web' }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(profile) || profile === 'node_modules') throw new Error('profile 名称无效');
  const file = path.join(home, 'profiles', profile, 'package.json');
  if (!fs.existsSync(file)) throw new Error('请先安装 DeepSeek Harness 并运行一次 dsh web，创建 web profile');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)
      || !Array.isArray(pkg.dsh?.profile?.bundles)) throw new Error('DSH profile 配置格式无效，未修改');
  if (pkg.dependencies !== undefined && (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies))) {
    throw new Error('DSH dependencies 格式无效，未修改');
  }
  const name = 'douyin-agent-presets';
  const source = path.join(root, 'plugins', name);
  const link = path.join(home, 'profiles', profile, 'node_modules', name);
  let matchingLink = false;
  try {
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink()) throw new Error('bundle 安装位置已被实际目录占用，未覆盖');
    matchingLink = fs.realpathSync(link).toLowerCase() === fs.realpathSync(source).toLowerCase();
    if (!matchingLink) throw new Error('bundle 已指向其他项目，请先卸载旧的 douyin-agent-presets');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const updated = structuredClone(pkg);
  updated.dependencies ??= {};
  updated.dependencies[name] = `link:${source.replaceAll('\\', '/')}`;
  if (!updated.dsh.profile.bundles.includes(name)) updated.dsh.profile.bundles.push(name);
  const changed = JSON.stringify(pkg) !== JSON.stringify(updated);
  if (changed) {
    const backup = `${file}.bak-douyin-${Date.now()}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  }
  if (!matchingLink) {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  if (changed) atomicJson(file, updated);
  return { changed, profile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const { changed, profile } = installPreset({ home, root, profile: process.argv[2] || 'web' });
    console.log(changed ? '专用群聊预设已注册，原配置已备份。' : '专用群聊预设已注册，无需重复修改。');
    console.log(`接下来运行：dsh plugin --profile ${profile} install`);
    console.log('然后重启对应 profile 的 DSH Web 服务，再运行 npm run doctor。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
