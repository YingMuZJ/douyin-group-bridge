import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'js-yaml';
import { installPreset } from '../../scripts/setup-douyin-dsh.mjs';
import { apply } from '../../plugins/douyin-agent-presets/tool-restrict.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('安装幂等，保留现有 DSH bundle，备份原配置', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-setup-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(dir, { recursive: true });
  const pkg = { private: true, dependencies: { example: '1' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  assert.equal(installPreset({ home, root }).changed, true);
  assert.equal(installPreset({ home, root }).changed, false);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
  assert.deepEqual(after.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'douyin-agent-presets']);
  assert.equal(after.dependencies.example, '1');
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.bak-douyin-')).length, 1);
  assert.equal(fs.realpathSync(path.join(dir, 'node_modules', 'douyin-agent-presets')), fs.realpathSync(path.join(root, 'plugins', 'douyin-agent-presets')));
  assert.throws(() => installPreset({ home, root, profile: '../evil' }), /无效/);
});

test('损坏 profile 不创建链接或覆盖文件', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-bad-setup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), 'null');
  assert.throws(() => installPreset({ home, root }), /无效/);
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), 'null');
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
});

test('群聊预设没有本地工具或 QQ 工具；执行期拒绝所有工具', () => {
  const patch = YAML.load(fs.readFileSync(path.join(root, 'plugins/douyin-agent-presets/preset.patch.yml'), 'utf8'));
  const preset = patch[0].insert[0].config;
  assert.equal(preset.id, 'douyin-group-chat');
  assert.deepEqual(preset.plugins.map((p) => p.name), [
    '@deepseek-ai/dsh-persona', 'douyin-agent-presets/tool-restrict.mjs', 'cordis:group',
  ]);
  assert.equal(preset.plugins[2].isolate.compaction, true);
  assert.deepEqual(preset.plugins[2].config.map(p => p.name), [
    '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact', '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ]);
  let guard;
  const denied = [];
  apply({ tools: { restrict: (rule) => denied.push(...rule.deny), guard: (fn) => { guard = fn; } } });
  assert.ok(denied.includes('pwsh'));
  assert.ok(denied.includes('read_mcp_resource'));
  for (const name of ['pwsh', 'read', 'mcp__snowluma__qq_send_group_message', 'future_tool']) assert.ok(guard({ name }));
});
