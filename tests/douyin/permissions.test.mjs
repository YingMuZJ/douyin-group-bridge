import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { protectStateDir } from '../../src/douyin/permissions.mjs';

test('实机权限设置可重复执行，现有文件及后续 SDK 子目录保持可写', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-acl-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const existing = path.join(dir, 'existing.json');
  fs.writeFileSync(existing, '{}');
  protectStateDir(dir);
  const child = path.join(dir, 'sdk', 'accounts');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(child, 'test.json'), '{"ok":true}');
  protectStateDir(dir);
  fs.writeFileSync(existing, '{"updated":true}');
  fs.writeFileSync(path.join(child, 'test.json'), '{"ok":true}');
  assert.equal(JSON.parse(fs.readFileSync(existing)).updated, true);
});
