import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNudge, DEFAULT_TEXT } from '../nudge.mjs';

const SID = 'session_01ABCDEFGH12345678';
const URL_ = `https://claude.ai/code/${SID}`;
const track = (o = {}) => ({ id: 'abc123', kind: 'cloud', repo: 'o/r', branch: 'claude/x', url: URL_, active: true, memo: { pr: 7 }, owner: { account: 'me', configDir: '/cfg/me' }, ...o });

// Runs the command with fakes; never touches the real hub folder, claude or gh.
async function go(argv, { tracked = [track()], api, claude = { prefix: ['claude'] }, status = 0 } = {}) {
  const lines = [];
  const calls = [];
  const run = (prefix, args, env) => { calls.push({ prefix, args, env }); return { status, out: status ? 'boom' : '' }; };
  const code = await runNudge(argv, {
    env: { CLOUD_PILOT_DIR: mkdtempSync(join(tmpdir(), 'nudge-')) }, out: (l) => lines.push(l), tracked, api: api ?? (async () => { throw new Error('no network'); }), run, claude,
  });
  assert.equal(lines.length, 1, 'exactly one output line');
  return { code, json: JSON.parse(lines[0]), calls };
}

test('--id sends the default text to the track session as its account', async () => {
  const { code, json, calls } = await go(['--id', 'abc123']);
  assert.equal(code, 0);
  assert.deepEqual(json, { sent: true, session_url: URL_ });
  assert.deepEqual(calls[0].args, ['-p', DEFAULT_TEXT, '--cloud', SID]);
  assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, '/cfg/me');
});

test('--text is sent as given', async () => {
  const { json, calls } = await go(['--id', 'abc123', '--text', 'please rebase']);
  assert.equal(json.sent, true);
  assert.deepEqual(calls[0].args, ['-p', 'please rebase', '--cloud', SID]);
});

test('tracks are read from the hub folder when not injected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-'));
  try {
    writeFileSync(join(dir, 'tracked.json'), JSON.stringify([track()]));
    const lines = [];
    const run = () => ({ status: 0, out: '' });
    const code = await runNudge(['--id', 'abc123'], { env: { CLOUD_PILOT_DIR: dir }, out: (l) => lines.push(l), run, claude: { prefix: ['claude'] } });
    assert.equal(code, 0);
    assert.equal(JSON.parse(lines[0]).sent, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing tracked.json degrades to sent:false', async () => {
  const lines = [];
  const code = await runNudge(['--id', 'abc123'], { env: { CLOUD_PILOT_DIR: mkdtempSync(join(tmpdir(), 'nudge-')) }, out: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.equal(JSON.parse(lines[0]).sent, false);
});

test('unknown id: sent:false, exit 0', async () => {
  const { code, json } = await go(['--id', 'nope']);
  assert.equal(code, 0);
  assert.equal(json.sent, false);
  assert.match(json.reason, /no track with that id/);
  assert.equal('session_url' in json, false);
});

test('track without a link and without a PR: no session, sent:false', async () => {
  const { code, json, calls } = await go(['--id', 'abc123'], { tracked: [track({ url: '', memo: {} })] });
  assert.equal(code, 0);
  assert.equal(json.sent, false);
  assert.match(json.reason, /no session link/);
  assert.equal('session_url' in json, false);
  assert.equal(calls.length, 0);
});

test('--id without a link falls back to the PR body link', async () => {
  const api = async () => ({ head: { ref: 'other' }, body: `done\nhttps://claude.ai/code/${SID}` });
  const { json, calls } = await go(['--id', 'abc123'], { tracked: [track({ url: '' })], api });
  assert.deepEqual(json, { sent: true, session_url: URL_ });
  assert.deepEqual(calls[0].args, ['-p', DEFAULT_TEXT, '--cloud', SID]);
});

test('claude missing: sent:false with the reason', async () => {
  const { code, json, calls } = await go(['--id', 'abc123'], { claude: { error: 'claude is not installed' } });
  assert.equal(code, 0);
  assert.equal(json.sent, false);
  assert.equal(json.session_url, URL_);
  assert.match(json.reason, /not installed/);
  assert.equal(calls.length, 0);
});

test('claude exits 3: sent:false, exit 0', async () => {
  const { code, json } = await go(['--id', 'abc123'], { status: 3 });
  assert.equal(code, 0);
  assert.equal(json.sent, false);
  assert.match(json.reason, /exited 3/);
});

test('--repo/--pr finds the tracked session', async () => {
  const { json, calls } = await go(['--repo', 'o/r', '--pr', '7']);
  assert.deepEqual(json, { sent: true, session_url: URL_ });
  assert.equal(calls[0].args[3], SID);
});

test('--repo/--pr uses the PR head branch, then the PR body link', async () => {
  const byBranch = await go(['--repo', 'o/r', '--pr', '9'], { tracked: [track({ memo: {} })], api: async () => ({ head: { ref: 'claude/x' }, body: '' }) });
  assert.equal(byBranch.json.sent, true);
  const byBody = await go(['--repo', 'o/r', '--pr', '9'], { tracked: [], api: async () => ({ head: { ref: 'z' }, body: `see https://claude.ai/code/${SID}` }) });
  assert.deepEqual(byBody.json, { sent: true, session_url: URL_ });
  assert.equal(byBody.calls[0].env.CLAUDE_CONFIG_DIR, undefined);
});

test('--repo/--pr with nothing found (PR unreadable): sent:false, exit 0', async () => {
  const { code, json } = await go(['--repo', 'o/r', '--pr', '9'], { tracked: [] });
  assert.equal(code, 0);
  assert.equal(json.sent, false);
});

test('bad arguments: exit 1 with the usage JSON', async () => {
  const bad = [
    [], ['--id', 'a', '--repo', 'o/r'], ['--id', 'a', '--pr', '3'], ['--repo', 'o/r'], ['--pr', '3'],
    ['--repo', 'nope', '--pr', '3'], ['--repo', 'o/r', '--pr', '0'], ['--repo', 'o/r', '--pr', 'x'], ['--repo', 'o/r', '--pr', '-2'], ['--repo', 'o/r', '--pr', '1.5'],
    ['--id', 'bad id!'], ['--id', 'x'.repeat(65)], ['--id', 'abc', '--bogus', '1'], ['--id', 'abc', '--text', ''], ['--id', 'abc', '--text', '   '],
    ['--id', 'abc', '--text', 'a'.repeat(2001)], ['--id'], ['abc'],
  ];
  for (const argv of bad) {
    const { code, json, calls } = await go(argv);
    assert.equal(code, 1, JSON.stringify(argv));
    assert.equal(json.status, 'usage', JSON.stringify(argv));
    assert.equal(typeof json.message, 'string');
    assert.equal(calls.length, 0);
  }
});

test('--help prints usage and exits 0', async () => {
  const lines = [];
  const code = await runNudge(['--help'], { out: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /cloud-pilot nudge/);
});
