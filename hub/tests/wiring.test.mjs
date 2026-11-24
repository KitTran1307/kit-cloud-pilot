import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { paths } from '../lib/store.mjs';
import { addTrack, pollOnce, takeReady } from '../hub.mjs';

for (const k of Object.keys(process.env)) if (/^(KIT_HUB|CLOUD_PILOT)_/.test(k)) delete process.env[k];

const T0 = Date.parse('2026-11-09T08:00:00Z');
const MIN = 60_000;
const NOW = T0 + 30 * MIN;
const REPO = 'octo/demo';
const SESSION = 'session_01AbCdEfGh12345678';
const SESSION_URL = `https://claude.ai/code/${SESSION}`;

function tmpHub() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-hub-test-'));
  const p = paths(dir);
  return { p, done: () => rmSync(dir, { recursive: true, force: true }), hubLog: () => (existsSync(p.log) ? readFileSync(p.log, 'utf8') : '') };
}

function fakeApi(routes) {
  const calls = [];
  return {
    calls,
    get(path) {
      calls.push(path);
      for (const [prefix, value] of Object.entries(routes)) if (path.startsWith(prefix)) return typeof value === 'function' ? value(path) : value;
      return null;
    },
    del() {},
    flush() {},
  };
}

const rawPr = (number, ref, over = {}) => ({
  number, state: 'open', merged_at: null, merge_commit_sha: null, html_url: `https://github.com/${REPO}/pull/${number}`, title: 'Secret title',
  body: 'WORKING', user: { login: 'octo' }, head: { ref, sha: `abc${number}0000000000`, repo: { full_name: REPO } }, base: { ref: 'main' },
  created_at: '2026-11-09T08:10:00Z', updated_at: '2026-11-09T08:20:00Z', ...over,
});

const failingApi = (prOver = {}, extra = {}) => fakeApi({
  [`repos/${REPO}/pulls?`]: [rawPr(7, 'claude/hud', prOver)],
  [`repos/${REPO}/issues/7/comments`]: [],
  [`repos/${REPO}/commits/`]: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure' }], statuses: [] },
  ...extra,
});
const conflictApi = (state) => fakeApi({
  [`repos/${REPO}/pulls?`]: [rawPr(7, 'claude/hud')],
  [`repos/${REPO}/pulls/7`]: { mergeable_state: state },
  [`repos/${REPO}/issues/7/comments`]: [],
  [`repos/${REPO}/commits/`]: { check_runs: [], statuses: [] },
});

const OWNER = { sessionId: 'S1', pid: 11, account: 'work', repoRoot: '/work/demo' };
const alive = (pid) => pid === 11;
const kinds = (q, k) => q.filter((e) => e.kind === k);
const run = (p, api, nowMs, extra = {}) => pollOnce(p, { api, nowMs, aliveFn: alive, notify() {}, cleanup: true, ...extra });
const drain = (p, at) => takeReady(p, 'S1', { nowMs: at });

test('branch track, failing CI: autofix called once per head, result rides on the event', () => {
  const { p, done } = tmpHub();
  addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/hud', url: SESSION_URL }, OWNER, T0);
  const calls = [];
  const autofix = (...args) => { calls.push(args); return { sent: true, reason: 'fake' }; };
  const api = failingApi({ body: `Work done\n\n${SESSION_URL}` });
  run(p, api, NOW, { autofix, alert() {} });
  run(p, api, NOW + 5 * MIN, { autofix, alert() {} });
  run(p, api, NOW + 10 * MIN, { autofix, alert() {} });
  assert.equal(calls.length, 1, 'once per head');
  const [track, event, pr, opts] = calls[0];
  assert.equal(track.kind, 'branch');
  assert.equal(track.branch, 'claude/hud');
  assert.equal(event.kind, 'ci-failed');
  assert.equal(pr.sessionId, SESSION);
  assert.equal(typeof opts.log, 'function');
  assert.ok(opts.env);
  const q = drain(p, NOW + 20 * MIN);
  const ev = kinds(q, 'ci-failed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].autofix.sent, true);
  assert.equal(ev[0].autofix.reason, 'fake');
  done();
});

test('branch track, conflict: one event with autofix across two polls; clean gives none', () => {
  const { p, done } = tmpHub();
  addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/hud', url: SESSION_URL }, OWNER, T0);
  const calls = [];
  const autofix = (t, e) => { calls.push(e.kind); return { sent: true, reason: 'fake' }; };
  const api = conflictApi('dirty');
  run(p, api, NOW, { autofix, alert() {} });
  run(p, api, NOW + 5 * MIN, { autofix, alert() {} });
  assert.deepEqual(calls, ['conflict']);
  const c = kinds(drain(p, NOW + 20 * MIN), 'conflict');
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].autofix, { sent: true, reason: 'fake' });
  done();

  const h = tmpHub();
  addTrack(h.p, { kind: 'branch', repo: REPO, branch: 'claude/hud', url: SESSION_URL }, OWNER, T0);
  const calls2 = [];
  const clean = conflictApi('clean');
  run(h.p, clean, NOW, { autofix: (t, e) => { calls2.push(e.kind); return { sent: true }; }, alert() {} });
  assert.equal(calls2.includes('conflict'), false);
  assert.equal(kinds(drain(h.p, NOW + 20 * MIN), 'conflict').length, 0);
  h.done();
});

test('whole-repo track: autofix is not called for a failing CI PR', () => {
  const { p, done } = tmpHub();
  addTrack(p, { kind: 'repo', repo: REPO }, OWNER, T0);
  let called = 0;
  const api = failingApi();
  run(p, api, NOW, { autofix: () => { called++; return { sent: true }; }, alert() {} });
  run(p, api, NOW + 5 * MIN, { autofix: () => { called++; return { sent: true }; }, alert() {} });
  assert.equal(called, 0);
  assert.ok(kinds(drain(p, NOW + 20 * MIN), 'ci-failed').every((e) => !('autofix' in e)));
  done();
});

test('alert: called with delivered events per delivering poll, not when nothing is delivered', () => {
  const { p, done } = tmpHub();
  addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/hud', url: SESSION_URL }, OWNER, T0);
  const batches = [];
  const alert = (events, opts) => { batches.push({ events, opts }); };
  const api = failingApi();
  run(p, api, NOW, { autofix: () => ({ sent: false, reason: 'x' }), alert });
  assert.equal(batches.length, 1);
  assert.ok(batches[0].events.some((e) => e.kind === 'ci-failed'));
  assert.equal(typeof batches[0].opts.log, 'function');
  assert.ok(batches[0].opts.env);
  run(p, api, NOW + 5 * MIN, { autofix: () => ({ sent: false, reason: 'x' }), alert });
  assert.equal(batches.length, 1, 'quiet poll: no alert call');

  // a new head delivers again
  const api2 = fakeApi({
    [`repos/${REPO}/pulls?`]: [rawPr(7, 'claude/hud', { head: { ref: 'claude/hud', sha: 'def70000000000', repo: { full_name: REPO } } })],
    [`repos/${REPO}/issues/7/comments`]: [],
    [`repos/${REPO}/commits/`]: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure' }], statuses: [] },
  });
  run(p, api2, NOW + 10 * MIN, { autofix: () => ({ sent: false, reason: 'x' }), alert });
  assert.equal(batches.length, 2);
  assert.ok(batches[1].events.some((e) => e.kind === 'ci-failed'));
  done();
});

test('a throwing alert never stops delivery and is logged', () => {
  {
    const { p, done, hubLog } = tmpHub();
    addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/hud', url: SESSION_URL }, OWNER, T0);
    run(p, failingApi(), NOW, { autofix: () => ({ sent: false, reason: 'x' }), alert() { throw new Error('alert boom'); } });
    assert.equal(kinds(drain(p, NOW + 20 * MIN), 'ci-failed').length, 1);
    assert.match(hubLog(), /alert failed: alert boom/);
    done();
  }
});

test('a throwing autofix never stops delivery and is logged', () => {
  {
    const { p, done, hubLog } = tmpHub();
    addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/hud', url: SESSION_URL }, OWNER, T0);
    let alerted = 0;
    run(p, failingApi(), NOW, { autofix() { throw new Error('autofix boom'); }, alert() { alerted++; } });
    const q = drain(p, NOW + 20 * MIN);
    assert.equal(kinds(q, 'ci-failed').length, 1, 'event still queued');
    assert.match(hubLog(), /autofix boom/);
    done();
  }
});

test('real startAutofix through pollOnce: off, and no session link', () => {
  {
    const { p, done } = tmpHub();
    addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/hud', url: SESSION_URL }, OWNER, T0);
    run(p, failingApi(), NOW, { env: { CLOUD_PILOT_AUTOFIX: '0' }, alert() {} });
    const ev = kinds(drain(p, NOW + 20 * MIN), 'ci-failed');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].autofix.sent, false);
    assert.match(ev[0].autofix.reason, /off/);
    done();
  }
  {
    const { p, done } = tmpHub();
    addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/hud' }, OWNER, T0);
    run(p, failingApi(), NOW, { env: { CLOUD_PILOT_AUTOFIX: '1' }, alert() {} });
    const ev = kinds(drain(p, NOW + 20 * MIN), 'ci-failed');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].autofix.sent, false);
    assert.match(ev[0].autofix.reason, /no session link/);
    done();
  }
});
