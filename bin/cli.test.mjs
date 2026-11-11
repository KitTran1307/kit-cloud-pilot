// The cloud-pilot command: dispatch, usage, version, errors as one JSON line, a hub verb end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const k of Object.keys(process.env)) if (/^(KIT_HUB|CLOUD_PILOT)_/.test(k)) delete process.env[k];

const CLI = fileURLToPath(new URL('./cloud-pilot.mjs', import.meta.url));

function run(args, env = {}) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }) };
  } catch (err) {
    return { code: err.status ?? 1, out: String(err.stdout ?? '') };
  }
}

test('version and help', () => {
  const v = JSON.parse(run(['version']).out);
  assert.equal(v.ok, true);
  assert.match(v.version, /^\d+\.\d+\.\d+$/);
  const help = run(['help']);
  assert.equal(help.code, 0);
  for (const verb of ['start', 'track', 'watch', 'wait', 'status', 'channel', 'answer']) assert.match(help.out, new RegExp(`cloud-pilot ${verb}\\b`));
  assert.equal(run([]).code, 1, 'no command: usage and a failing exit');
});

test('an unknown command and a bad hub flag answer one JSON line with a failing exit', () => {
  const bad = run(['frobnicate']);
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.out).status, 'usage');
  const dir = mkdtempSync(join(tmpdir(), 'cloud-pilot-cli-'));
  try {
    const r = run(['track', '--repo', 'not-a-repo'], { CLOUD_PILOT_DIR: dir });
    assert.equal(r.code, 1);
    assert.match(JSON.parse(r.out.trim().split('\n').pop()).message, /owner\/name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status and doctor go to the hub, in the folder CLOUD_PILOT_DIR names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-pilot-cli-'));
  try {
    const status = JSON.parse(run(['status', '--json'], { CLOUD_PILOT_DIR: dir }).out);
    assert.equal(status.hub, null);
    const doc = JSON.parse(run(['doctor'], { CLOUD_PILOT_DIR: dir }).out);
    assert.equal(doc.dir, dir);
    assert.ok(Array.isArray(doc.problems));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
