import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export class Store {
  constructor(dir) {
    this.file = path.join(dir, 'bridge.json');
    this.data = { version: 1, sessions: {}, rooms: {}, seen: [] };
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (this.data.version !== 1 || !this.data.sessions || !this.data.rooms || !Array.isArray(this.data.seen)) {
        throw new Error('state/douyin/bridge.json 格式无效，请先备份并检查');
      }
    }
    this.seen = new Set(this.data.seen);
  }
  save() { atomicJson(this.file, this.data); }
  claim(key) {
    if (this.seen.has(key)) return false;
    // Claim before any external side effect. An uncertain send is never retried.
    this.seen.add(key);
    this.data.seen.push(key);
    while (this.data.seen.length > 5000) this.seen.delete(this.data.seen.shift());
    this.save();
    return true;
  }
  room(key) { return this.data.rooms[key] ?? {}; }
  updateRoom(key, patch) {
    this.data.rooms[key] = { ...this.room(key), ...patch };
    this.save();
  }
  session(key) { return this.data.sessions[key]; }
  setSession(key, value) {
    if (value === null) delete this.data.sessions[key];
    else this.data.sessions[key] = value;
    this.save();
  }
}

export function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'process.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('进程锁损坏，请确认无其他实例后删除 process.lock');
      try { process.kill(pid, 0); }
      catch (check) {
        if (check.code === 'ESRCH') { fs.unlinkSync(file); continue; }
        throw check;
      }
      throw new Error('已有实例使用此登录态，请先关闭它');
    }
  }
  throw new Error('无法获取进程锁');
}
