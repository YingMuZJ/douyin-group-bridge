#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createClient, configureLogger } from 'douyin-im';
import { identifier, loadConfig } from './config.mjs';
import { Store, acquireLock } from './store.mjs';
import { normalizeGroupMessage } from './adapter.mjs';
import { GroupBridge } from './bridge.mjs';
import { DshAgent } from './dsh-agent.mjs';
import { protectStateDir } from './permissions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Keys stay in an ignored local file/environment, never in group config/prompts.
if(fs.existsSync(path.join(root,'.env.local')))process.loadEnvFile(path.join(root,'.env.local'));
const command = process.argv[2] ?? 'start';
const configFile = path.join(root, 'config.douyin.json');
const log = (text) => console.log(`[抖音群聊桥接] ${text}`);

async function main() {
  if (!['start', 'init', 'login', 'groups', 'members', 'doctor', 'help'].includes(command)) throw new Error('未知命令，运行 npm start -- help 查看用法');
  if (command === 'help') {
    console.log('npm run init / login / groups / members -- 群ID / doctor / setup:dsh / start / test');
    return;
  }
  if (command === 'init') {
    if (fs.existsSync(configFile)) { log('配置已存在，保留原内容。'); return; }
    fs.copyFileSync(path.join(root, 'config.douyin.example.json'), configFile, fs.constants.COPYFILE_EXCL);
    log('已生成 config.douyin.json。先运行 npm run groups 登录并查询群 ID，再填写 groups 和 owners。');
    return;
  }
  const config = loadConfig(configFile, root);
  if (command === 'start' && config.douyin.groups.length === 0) throw new Error('群白名单为空：先运行 npm run groups，再把目标群完整 ID 写入 douyin.groups');
  const store = new Store(config.stateDir);
  const unlock = acquireLock(config.stateDir);
  let client, agent, bridge, terminal, lockReleased = false;
  let stopping;
  const cleanup = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      bridge?.close();
      // Cancel pending model work before releasing the single-instance lock.
      try { await agent?.close(); } catch {}
      try { await client?.logout(); } catch { log('退出抖音连接失败，请确认进程已关闭。'); }
      terminal?.close();
      unlock(); lockReleased = true;
    })();
    return stopping;
  };
  const stop = () => { void cleanup().then(() => { process.exitCode = 0; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    protectStateDir(config.stateDir);
    if (command === 'doctor' || command === 'start') {
      agent = new DshAgent({ config, store, log });
      await agent.start();
      log('DSH 鉴权、事件流及专用群聊预设检查通过。');
      if (command === 'doctor') {
        log(`Node ${process.versions.node}；群白名单 ${config.douyin.groups.length} 个；管理员 ${config.douyin.owners.length} 个。`);
        return;
      }
    }
    configureLogger({ level: 'warn', color: stdout.isTTY, maskSensitive: true });
    // A single saved account avoids accidental cross-account replies.
    const dataDir = path.join(config.stateDir, 'sdk');
    const accountDir = path.join(dataDir, 'accounts');
    const saved = fs.existsSync(accountDir) ? fs.readdirSync(accountDir).filter((n) => /^[1-9]\d*$/.test(n)) : [];
    if (saved.length > 1) throw new Error('检测到多个已保存账号，请使用独立项目副本隔离各账号');
    client = createClient({ dataDir });
    terminal = createInterface({ input: stdin, output: stdout });
    terminal.once('SIGINT', stop);
    const qrFile = path.join(config.stateDir, 'login.png');
    client.on('system.login.qrcode', async ({ account, qrcodeBase64 }) => {
      fs.writeFileSync(qrFile, Buffer.from(qrcodeBase64, 'base64'), { mode: 0o600 });
      log(`二维码已保存：${qrFile}；用抖音 App 扫码并确认。`);
      await account.continueLogin();
    });
    client.on('system.login.qrcode.status', ({ status }) => {
      const hint = {
        new: '等待手机扫码。', '1': '等待手机扫码。',
        scanned: '二维码已扫描，请在手机上确认登录。', '2': '二维码已扫描，请在手机上确认登录。',
        confirmed: '手机已确认，正在建立连接。', '3': '手机已确认，正在建立连接。',
        expired: '二维码已过期，正在等待刷新。', '4': '二维码已过期，正在等待刷新。',
      }[status];
      if (hint) log(hint);
    });
    const sms = async ({ account }) => {
      const code = (await terminal.question('请输入手机验证码：')).trim();
      if (!/^\d{4,8}$/.test(code)) throw new Error('验证码格式无效');
      await account.continueLoginWithSms(code);
    };
    client.on('system.login.sms', sms);
    client.on('system.login.voice', sms);
    client.on('system.login.verification', async ({ verification }) => {
      log('抖音要求身份验证，正在打开官方验证页面。');
      await verification.open();
    });
    client.on('system.action.verification', async ({ verification }) => { await verification.open(); });
    client.on('system.login.error', () => log('抖音登录失败，请查看网络连接或重新扫码。'));
    client.on('system.handler.error', ({ event }) => log(`SDK 事件处理失败：${event}`));
    if (command === 'start') {
      bridge = new GroupBridge({ config, store, agent, log });
      client.on('message.group', async (event) => {
        try { await bridge.handle(normalizeGroupMessage(event)); }
        catch (error) { log(`群消息未完成（${error.code || error.name || 'Error'}），本条不自动重试。`); }
      });
    }
    await client.login();
    if (stopping) return;
    fs.rmSync(qrFile, { force: true });
    for (const account of client.accounts.values()) {
      log(`已登录：${account.nickname || '抖音账号'}，用户 ID：${account.uid}`);
      if (command === 'groups') {
        const groups = await account.getGroupList(true);
        if (!groups.length) log('没有找到群聊，请先在抖音 App 中加入目标群。');
        for (const group of groups) console.log(JSON.stringify({ id: group.groupId, name: group.name ?? '' }));
      }
      if (command === 'members') {
        const groupId = identifier(process.argv[3], '群 ID');
        await account.getGroupList(true);
        const group = account.pickGroup(groupId);
        if (!group) throw new Error('未找到此群，请先运行 npm run groups 核对 ID');
        const members = await group.getMemberList(true);
        for (const member of members.values()) console.log(JSON.stringify({ uid: member.uid, nickname: member.alias || member.nickname || '' }));
      }
    }
    if (command !== 'start') return;
    log('群聊桥接已启动。白名单群的文字、媒体和互动路由已就绪；主动聊天按配置/群开关控制，按 Ctrl+C 退出。');
    await new Promise((resolve) => {
      const tick = setInterval(() => { if (stopping) { clearInterval(tick); resolve(); } }, 200);
    });
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    await cleanup();
    if (!lockReleased) unlock();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch((error) => {
  // Do not dump upstream HTTP errors: they can include tokens or cookies.
  const known = /^(缺少|群白名单|已有实例|配置|DSH |检测到多个|未知命令|无法获取|进程锁)/.test(error.message);
  console.error(`[抖音群聊桥接] ${known ? error.message : `启动失败（${error.code || error.name || 'Error'}），请检查配置、依赖及 DSH 是否运行。`}`);
  process.exitCode = 1;
});
