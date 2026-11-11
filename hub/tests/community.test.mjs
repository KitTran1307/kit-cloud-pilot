// Behaviour added for general use: watch (branch discovery), opt-in branch deletion, cross-platform notifications,
// doctor, the default data folder and the CLI entry check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { notifyCommand, notificationsOff, toast } from '../lib/notify.mjs';
import { hubDir, paths, readJson, writeJson } from '../lib/store.mjs';
import { snapshot, releaseSettings } from '../lib/poll.mjs';
import { trackEvents } from '../lib/events.mjs';
import { parseAsk, loadPublicKey } from '../lib/asks.mjs';
import { addTrack, pollOnce, deleteMergedEnabled, doctor, discover, enqueue, takeReady } from '../hub.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

// The hub reads these from the environment of whoever registers a track; tests set them explicitly.
for (const k of Object.keys(process.env)) if (/^(KIT_HUB|CLOUD_PILOT)_/.test(k)) delete process.env[k];

const T0 = Date.parse('2026-11-09T08:00:00Z');
const MIN = 60_000;
const REPO = 'octo/demo';
const owner = { sessionId: 'S1', pid: 11, account: 'default', repoRoot: '/work/demo' };

function tmpHub() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-hub-community-'));
  return { p: paths(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeApi(routes) {
  const calls = [];
  const deleted = [];
  return {
    calls, deleted,
    get(path) {
      calls.push(path);
      for (const [prefix, value] of Object.entries(routes)) if (path.startsWith(prefix)) return typeof value === 'function' ? value(path) : value;
      return null;
    },
    del(path) { deleted.push(path); },
    tipSha() { return 'abc123def456'; },
    flush() {},
  };
}

const pr = (over = {}) => ({
  number: 7, state: 'open', merged_at: null, merge_commit_sha: null, html_url: `https://github.com/${REPO}/pull/7`, title: 'Fix the parser',
  body: 'WORKING', user: { login: 'octo' }, head: { ref: 'claude/parser', sha: 'abc123def456', repo: { owner: { login: 'octo' }, full_name: 'octo/demo' } },
  created_at: '2026-11-09T07:00:00Z', updated_at: '2026-11-09T07:30:00Z', ...over,
});
const ref = (branch) => ({ ref: `refs/heads/${branch}`, object: { sha: `${branch.length}`.padEnd(40, 'a') } });

test('notifications: one command per platform, text escaped, unknown platforms and off switches do nothing', () => {
  const [winFile, winArgs] = notifyCommand('cloud-pilot', 'a <b> & "c"', 'win32');
  assert.equal(winFile, 'powershell.exe');
  assert.ok(!winArgs.join(' ').includes('<b>'), 'the text travels base64-encoded');
  const [macFile, macArgs] = notifyCommand('T"1', 'say "hi"\nnext \\ line', 'darwin');
  assert.equal(macFile, 'osascript');
  assert.equal(macArgs[1], 'display notification "say \\"hi\\" next \\\\ line" with title "T\\"1"');
  const [linFile, linArgs] = notifyCommand('T', '-rf', 'linux');
  assert.equal(linFile, 'notify-send');
  assert.deepEqual(linArgs.slice(-3), ['--', 'T', '-rf'], 'text after -- is never read as an option');
  assert.equal(notifyCommand('T', 'x', 'aix'), null);
  assert.equal(notifyCommand('T', 'x'.repeat(5000), 'linux')[1].at(-1).length, 400);
  assert.equal(notificationsOff({ KIT_HUB_NOTIFY: '0' }), true);
  assert.equal(notificationsOff({ KIT_HUB_NO_TOAST: '1' }), true);
  assert.equal(notificationsOff({}), false);
  const runs = [];
  assert.equal(toast('T', 'x', { dryRun: false, platform: 'linux', run: (...a) => { runs.push(a); return { on() {}, unref() {} }; } }), true);
  assert.equal(runs.length, 1);
  assert.equal(toast('T', 'x', { dryRun: false, platform: 'linux', run: () => { throw new Error('ENOENT'); } }), false);
  assert.equal(toast('T', 'x', { dryRun: true }), false);
});

test('merged branches are kept unless KIT_HUB_DELETE_MERGED=1', () => {
  assert.equal(deleteMergedEnabled({}), false);
  assert.equal(deleteMergedEnabled({ KIT_HUB_DELETE_MERGED: '1' }), true);
  const { p, done } = tmpHub();
  addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/parser', url: 'u1' }, owner, T0);
  let merged = false;
  const api = fakeApi({
    [`repos/${REPO}/pulls?`]: () => [pr({ created_at: '2026-11-09T08:10:00Z', state: merged ? 'closed' : 'open', merged_at: merged ? '2026-11-09T09:00:00Z' : null })],
    [`repos/${REPO}/issues/7/comments`]: [],
    [`repos/${REPO}/commits/`]: { check_runs: [], statuses: [] },
  });
  pollOnce(p, { api, nowMs: T0 + 30 * MIN, aliveFn: () => true, notify: () => {} });
  merged = true;
  pollOnce(p, { api, nowMs: T0 + 70 * MIN, aliveFn: () => true, notify: () => {} });
  assert.deepEqual(api.deleted, [], 'default: nothing deleted');
  assert.equal(readJson(p.tracked, []).find((t) => t.branch === 'claude/parser').active, false, 'the track still ends');
  done();
});

test('watch: the first look adopts branches with an open PR, later looks every new claude/* branch; nothing twice', () => {
  const { p, done } = tmpHub();
  const w = addTrack(p, { kind: 'repo', repo: REPO, discover: true }, owner, T0);
  const coordinator = addTrack(p, { kind: 'repo', repo: REPO }, owner, T0);
  assert.notEqual(w.id, coordinator.id, 'a watch never merges into a coordinator track');
  assert.equal(addTrack(p, { kind: 'repo', repo: REPO, discover: true }, { ...owner, sessionId: 'S2' }, T0 + 1).id, w.id, 'watching again only renews the owner');
  let refs = [ref('claude/parser'), ref('claude/old-done')];
  const api = fakeApi({
    [`repos/${REPO}/pulls?`]: [pr()],
    [`repos/${REPO}/issues/7/comments`]: [],
    [`repos/${REPO}/commits/`]: { check_runs: [], statuses: [] },
    [`repos/${REPO}/git/matching-refs/heads/claude/`]: () => refs,
    [`repos/${REPO}/branches/`]: { commit: { sha: 'abc123def456', commit: { committer: { date: '2026-11-09T07:30:00Z' } } } },
  });
  pollOnce(p, { api, nowMs: T0 + 2 * MIN, aliveFn: () => true, notify: () => {} });
  let branches = readJson(p.tracked, []).filter((t) => t.kind === 'branch').map((t) => t.branch);
  assert.deepEqual(branches, ['claude/parser'], 'an old branch with no open PR is history');
  const adopted = readJson(p.tracked, []).find((t) => t.branch === 'claude/parser');
  assert.equal(adopted.owner.sessionId, 'S2');
  assert.equal(adopted.title, 'claude/parser', 'a discovered track is titled with its branch name, never the PR title');
  assert.equal(adopted.discoveredBy, w.id);
  refs = [...refs, ref('claude/new-work'), { ref: 'refs/heads/claude/../evil', object: { sha: 'x' } }];
  pollOnce(p, { api, nowMs: T0 + 4 * MIN, aliveFn: () => true, notify: () => {} });
  pollOnce(p, { api, nowMs: T0 + 6 * MIN, aliveFn: () => true, notify: () => {} });
  branches = readJson(p.tracked, []).filter((t) => t.kind === 'branch').map((t) => t.branch).sort();
  assert.deepEqual(branches, ['claude/new-work', 'claude/parser'], 'new branch tracked once, a bad name never');
  assert.equal(api.calls.filter((c) => c.includes('matching-refs')).length, 3, 'one refs call per poll');
  done();
});

test('a watch-only repo track reports no events of its own; a coordinator track still does', () => {
  const now = { at: T0, prs: { 'claude/x': { state: 'open', number: 1, flag: '', title: 't' } }, branches: {}, current: {} };
  const watch = trackEvents({ kind: 'repo', discover: true, memo: {} }, { prs: {} }, now, T0);
  assert.deepEqual(watch.events, []);
  assert.match(watch.view.detail, /^watching · 1 open claude\/\* PR$/);
  const coord = trackEvents({ kind: 'repo', memo: { baselined: true } }, { prs: {} }, now, T0);
  assert.deepEqual(coord.events.map((e) => e.kind), ['opened']);
});

test('snapshot lists claude/* refs only for a watch, and tolerates odd answers', () => {
  const api = fakeApi({ [`repos/${REPO}/pulls?`]: [], [`repos/${REPO}/git/matching-refs/`]: [ref('claude/a'), { ref: 'refs/heads/main' }, null] });
  assert.equal(snapshot(api, REPO, [{ kind: 'repo', discover: true }], { nowMs: T0 }).refs.map((r) => r.branch).join(), 'claude/a');
  assert.equal(snapshot(api, REPO, [{ kind: 'repo' }], { nowMs: T0 }).refs, undefined);
  const odd = fakeApi({ [`repos/${REPO}/pulls?`]: [], [`repos/${REPO}/git/matching-refs/`]: { message: 'weird' } });
  assert.deepEqual(snapshot(odd, REPO, [{ kind: 'repo', discover: true }], { nowMs: T0 }).refs, []);
});

test('doctor names what is missing and never fails', () => {
  const { p, done } = tmpHub();
  const ok = doctor(p, { version: 'v20.1.0', exec: (_f, args) => (args[0] === '--version' ? 'gh version 2.60.1 (2024-10-01)\n' : 'Logged in') });
  assert.deepEqual([ok.ok, ok.gh, ok.ghSignedIn, ok.problems], [true, '2.60.1', true, []]);
  const noGh = doctor(p, { version: 'v20.1.0', exec: () => { const e = new Error('spawn gh ENOENT'); e.code = 'ENOENT'; throw e; } });
  assert.equal(noGh.ok, false);
  assert.match(noGh.problems.join(), /not installed/);
  const noLogin = doctor(p, { version: 'v16.0.0', exec: (_f, args) => { if (args[0] === '--version') return 'gh version 2.1.0'; throw new Error('not logged in'); } });
  assert.match(noLogin.problems.join(' | '), /too old.*\| gh is not signed in/);
  done();
});

test('defaults: data folder under ~/.claude/cloud-pilot unless CLOUD_PILOT_DIR (or the old KIT_HUB_DIR); the old ask label still parses', () => {
  assert.equal(hubDir({}), join(homedir(), '.claude', 'cloud-pilot'));
  assert.equal(hubDir({ CLOUD_PILOT_DIR: '/x/y' }), '/x/y');
  assert.equal(hubDir({ KIT_HUB_DIR: '/old' }), '/old');
  assert.equal(hubDir({ CLOUD_PILOT_DIR: '/new', KIT_HUB_DIR: '/old' }), '/new');
  const meta = '<!-- kit-channel:ask {"v":1,"id":"q-001","asked_at":"2026-11-09T08:00:00Z"} -->';
  assert.equal(parseAsk(`${meta}\nWAITING FOR YOU (q-001): Which port?`).text, 'Which port?');
  assert.equal(parseAsk(`${meta}\nCHỜ BẠN (q-001): Which port?`).text, 'Which port?');
  assert.equal(loadPublicKey(undefined), null, 'no key configured: no answer verifies');
});

test('the CLI runs through a relative path and answers usage errors as one JSON line', () => {
  const hub = fileURLToPath(new URL('../hub.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'kit-hub-cli-'));
  try {
    let out = '';
    try {
      execFileSync(process.execPath, [hub, 'bogus'], { encoding: 'utf8', env: { ...process.env, KIT_HUB_DIR: dir } });
    } catch (err) { out = String(err.stdout); }
    assert.equal(JSON.parse(out).status, 'usage');
    const status = execFileSync(process.execPath, ['hub.mjs', 'status', '--json'], { encoding: 'utf8', cwd: join(hub, '..'), env: { ...process.env, KIT_HUB_DIR: dir } });
    assert.equal(JSON.parse(status).hub, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings live on each track: delete and notify follow the registering session, discovered branches never delete', () => {
  const { p, done } = tmpHub();
  const on = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/parser', url: 'u1' }, owner, T0, { KIT_HUB_DELETE_MERGED: '1', KIT_HUB_NOTIFY: '0' });
  assert.deepEqual([on.deleteMerged, on.notify], [true, false]);
  const off = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/other', url: 'u2' }, owner, T0, {});
  assert.deepEqual([off.deleteMerged, off.notify], [false, true]);
  const found = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/teammate', discoveredBy: 'w1' }, owner, T0, { KIT_HUB_DELETE_MERGED: '1' });
  assert.equal(found.deleteMerged, false);
  let merged = false;
  const api = fakeApi({
    [`repos/${REPO}/pulls?`]: () => [pr({ created_at: '2026-11-09T08:10:00Z', state: merged ? 'closed' : 'open', merged_at: merged ? '2026-11-09T09:00:00Z' : null })],
    [`repos/${REPO}/issues/7/comments`]: [],
    [`repos/${REPO}/commits/`]: { check_runs: [], statuses: [] },
    [`repos/${REPO}/branches/`]: null,
  });
  const toasts = [];
  pollOnce(p, { api, nowMs: T0 + 30 * MIN, aliveFn: () => false, notify: (a, b) => toasts.push(b) });
  merged = true;
  pollOnce(p, { api, nowMs: T0 + 70 * MIN, aliveFn: () => false, notify: (a, b) => toasts.push(b) });
  assert.deepEqual(api.deleted, [`repos/${REPO}/git/refs/heads/claude/parser`], 'the opted-in track only');
  assert.equal(toasts.length, 0, 'its session turned notifications off');
  done();
});

test('watches are per account; a watch that comes back starts from a fresh look; old snapshots go', () => {
  const { p, done } = tmpHub();
  const a = addTrack(p, { kind: 'repo', repo: REPO, discover: true }, owner, T0);
  const b = addTrack(p, { kind: 'repo', repo: REPO, discover: true }, { ...owner, sessionId: 'S9', account: 'home' }, T0);
  assert.notEqual(a.id, b.id);
  assert.equal(readJson(p.tracked, []).find((t) => t.id === a.id).owner.account, 'default', 'never taken over by another account');
  const watcher = { ...a, createdMs: T0 + 60 * MIN };
  const old = { at: T0, refs: [{ branch: 'claude/parser' }] };
  const now = { at: T0 + 61 * MIN, prs: {}, refs: [{ branch: 'claude/parser' }, { branch: 'claude/merged-long-ago' }] };
  assert.deepEqual(discover(p, REPO, [watcher], old, now, T0 + 61 * MIN), [], 'a look older than the watch is not "before"');
  const fresh = { at: T0 + 61 * MIN, refs: now.refs };
  const later = { at: T0 + 63 * MIN, prs: {}, refs: [...now.refs, { branch: 'claude/new' }] };
  assert.equal(discover(p, REPO, [watcher], fresh, later, T0 + 63 * MIN).length, 1);
  writeJson(p.snapshots, { 'gone/repo': { at: T0 } });
  const api = fakeApi({ [`repos/${REPO}/pulls?`]: [], [`repos/${REPO}/git/matching-refs/`]: [] });
  pollOnce(p, { api, nowMs: T0 + 64 * MIN, aliveFn: () => true, notify: () => {} });
  assert.deepEqual(Object.keys(readJson(p.snapshots, {})), [REPO]);
  done();
});

test('a damaged queue file never stops delivery', () => {
  const { p, done } = tmpHub();
  mkdirSync(p.queues, { recursive: true });
  writeFileSync(`${p.queues}/S1.json`, '');
  enqueue(p, 'S1', [{ kind: 'merged', urgent: true, at: T0 }]);
  assert.deepEqual(takeReady(p, 'S1', { nowMs: T0 }).map((e) => e.kind), ['merged']);
  done();
});

test('release check settings: branch names and paths come from the environment, safely', () => {
  assert.deepEqual({ ...releaseSettings({}), paths: null }, { main: 'main', release: 'release', paths: null });
  const s = releaseSettings({ KIT_HUB_RELEASE_BRANCHES: 'develop:prod', KIT_HUB_RELEASE_PATHS: '^web/' });
  assert.deepEqual([s.main, s.release, s.paths.test('web/a.ts'), s.paths.test('docs/x')], ['develop', 'prod', true, false]);
  const bad = releaseSettings({ KIT_HUB_RELEASE_BRANCHES: '--upload-pack=x:../y', KIT_HUB_RELEASE_PATHS: '(' });
  assert.deepEqual([bad.main, bad.release, bad.paths], ['main', 'release', null]);
});
