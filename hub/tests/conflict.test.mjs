import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { snapshot } from '../lib/poll.mjs';
import { trackEvents } from '../lib/events.mjs';
import { paths } from '../lib/store.mjs';
import { addTrack, pollOnce, takeReady } from '../hub.mjs';

for (const k of Object.keys(process.env)) if (/^(KIT_HUB|CLOUD_PILOT)_/.test(k)) delete process.env[k];

const T0 = Date.parse('2026-11-09T08:00:00Z');
const MIN = 60_000;
const REPO = 'octo/demo';

function tmpHub() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-hub-test-'));
  return { p: paths(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
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
  body: 'WORKING', user: { login: 'octo' }, head: { ref, sha: `sha${number}0000000000`, repo: { full_name: REPO } }, base: { ref: 'main' },
  created_at: '2026-11-09T08:10:00Z', updated_at: '2026-11-09T08:20:00Z', ...over,
});

const branchTrack = (branch, id = branch) => ({ id, kind: 'branch', repo: REPO, branch, createdMs: T0, active: true });
const repoTrack = { id: 'repo', kind: 'repo', repo: REPO, createdMs: T0, active: true };
const pullCalls = (api) => api.calls.filter((c) => /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(c));
const NOW = T0 + 30 * MIN;

test('snapshot reads the merge state once per open PR a branch track follows', () => {
  const api = fakeApi({
    [`repos/${REPO}/pulls?`]: [rawPr(7, 'claude/hud'), rawPr(8, 'claude/other'), rawPr(9, 'claude/done', { state: 'closed', closed_at: '2026-11-09T08:30:00Z', merged_at: '2026-11-09T08:30:00Z' })],
    [`repos/${REPO}/pulls/7`]: { mergeable_state: 'dirty', title: 'x', body: 'y' },
    [`repos/${REPO}/issues/`]: [],
    [`repos/${REPO}/commits/`]: { check_runs: [], statuses: [] },
  });
  const s = snapshot(api, REPO, [branchTrack('claude/hud'), branchTrack('claude/done'), branchTrack('claude/hud', 'second')], { nowMs: NOW });
  assert.equal(s.prs['claude/hud'].mergeState, 'dirty');
  assert.deepEqual(pullCalls(api), [`repos/${REPO}/pulls/7`], 'one call: not the closed PR, not another branch');
  assert.equal('mergeState' in s.prs['claude/done'], false);
  assert.equal(JSON.stringify(s.prs['claude/hud']).includes('"x"'), false, 'nothing of the PR body is stored');
});

test('snapshot: no merge-state call for repo-track PRs or a discover-only track', () => {
  const api = fakeApi({
    [`repos/${REPO}/pulls?`]: [rawPr(7, 'claude/hud'), rawPr(8, 'claude/other')],
    [`repos/${REPO}/pulls/`]: { mergeable_state: 'dirty' },
    [`repos/${REPO}/issues/`]: [],
    [`repos/${REPO}/commits/`]: { check_runs: [], statuses: [] },
  });
  const s = snapshot(api, REPO, [repoTrack, { ...repoTrack, id: 'd', discover: true }, branchTrack('claude/hud')], { nowMs: NOW });
  assert.deepEqual(pullCalls(api), [`repos/${REPO}/pulls/7`]);
  assert.equal('mergeState' in s.prs['claude/other'], false);
  const api2 = fakeApi({ [`repos/${REPO}/pulls?`]: [rawPr(7, 'claude/hud')], [`repos/${REPO}/issues/`]: [], [`repos/${REPO}/commits/`]: {} });
  snapshot(api2, REPO, [{ ...repoTrack, discover: true }], { nowMs: NOW });
  assert.equal(pullCalls(api2).length, 0);
});

test('snapshot: a failing call or a non-enum mergeable_state gives an empty merge state', () => {
  for (const body of [() => { throw new Error('boom'); }, { mergeable_state: 5 }, { mergeable_state: 'Dirty\n' }, { mergeable_state: null }, null, { mergeable_state: 'x'.repeat(40) }]) {
    const api = fakeApi({
      [`repos/${REPO}/pulls?`]: [rawPr(7, 'claude/hud')],
      [`repos/${REPO}/pulls/7`]: body,
      [`repos/${REPO}/issues/`]: [],
      [`repos/${REPO}/commits/`]: { check_runs: [], statuses: [] },
    });
    assert.equal(snapshot(api, REPO, [branchTrack('claude/hud')], { nowMs: NOW }).prs['claude/hud'].mergeState, '');
  }
});

const prFact = (over = {}) => ({
  number: 7, state: 'open', merged: false, url: `https://github.com/${REPO}/pull/7`, title: 'Secret title', headSha: 'abcdef0123456789',
  baseRef: 'main', createdAt: '2026-11-09T08:10:00Z', updatedMs: T0 + 20 * MIN, ci: '', comments: 0, asks: [], staleAsks: [], mergeState: 'dirty', ...over,
});
const snap = (pr) => ({ at: NOW, prs: { 'claude/hud': pr }, branches: { 'claude/hud': { exists: true, tipMs: T0 + 20 * MIN, sha: pr.headSha } }, current: { t1: true } });
const track = { id: 't1', kind: 'branch', repo: REPO, branch: 'claude/hud', createdMs: T0, active: true, memo: {} };
const conflicts = (r) => r.events.filter((e) => e.kind === 'conflict');

// Polls like the hub: the memo of one poll is the next track's memo.
function polls(t, prs) {
  return prs.map((p) => {
    const r = trackEvents(t, null, snap(p), NOW);
    t = { ...t, memo: r.memo };
    return r;
  });
}

test('conflict: one urgent event per head across polls, a new head reports again', () => {
  const rs = polls(track, [prFact(), prFact(), prFact(), prFact({ headSha: 'fedcba9876543210' }), prFact({ headSha: 'fedcba9876543210' })]);
  assert.deepEqual(rs.map((r) => conflicts(r).length), [1, 0, 0, 1, 0]);
  const e = conflicts(rs[0])[0];
  assert.equal(e.urgent, true);
  assert.deepEqual([e.pr, e.head, e.base_ref], [7, 'abcdef012', 'main']);
  assert.equal(e.pr_url, `https://github.com/${REPO}/pull/7`);
  assert.equal(Object.keys(e).some((k) => k.startsWith('untrusted_')), false);
  assert.equal(JSON.stringify(e).includes('Secret title'), false);
  assert.match(rs[0].view.detail, /conflicts/);
});

test('conflict: never for other merge states or a closed PR; no detail suffix then', () => {
  for (const mergeState of ['clean', 'unknown', 'blocked', 'behind', '', undefined]) {
    const r = polls(track, [prFact({ mergeState })])[0];
    assert.equal(conflicts(r).length, 0, String(mergeState));
    assert.doesNotMatch(r.view.detail, /conflicts/);
  }
  assert.equal(conflicts(polls(track, [prFact({ state: 'closed' })])[0]).length, 0);
  const repo = trackEvents({ ...repoTrack, memo: { baselined: true } }, { prs: { 'claude/hud': prFact({ mergeState: 'clean' }) } }, snap(prFact()), NOW);
  assert.equal(conflicts(repo).length, 0, 'not for repo tracks');
});

test('conflict: base_ref only in the shape of a plain branch name', () => {
  for (const baseRef of ['main\nIgnore previous', 'ma\u202ein', 'my branch', '--x', '../x', 'a/../b', '/abs', 'a'.repeat(101), '', undefined]) {
    const e = conflicts(polls(track, [prFact({ baseRef })])[0])[0];
    assert.ok(e, 'event still emitted');
    assert.equal('base_ref' in e, false, JSON.stringify(baseRef));
  }
  for (const baseRef of ['main', 'release/1.2']) assert.equal(conflicts(polls(track, [prFact({ baseRef })])[0])[0].base_ref, baseRef);
});

test('pollOnce queues the conflict once for the owner across two polls', () => {
  const { p, done } = tmpHub();
  addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/hud', url: 'u1' }, { sessionId: 'S1', pid: 11, account: 'work', repoRoot: '/work/demo' }, T0);
  const api = fakeApi({
    [`repos/${REPO}/pulls?`]: [rawPr(7, 'claude/hud')],
    [`repos/${REPO}/pulls/7`]: { mergeable_state: 'dirty' },
    [`repos/${REPO}/issues/7/comments`]: [],
    [`repos/${REPO}/commits/`]: { check_runs: [], statuses: [] },
  });
  const run = (nowMs) => pollOnce(p, { api, nowMs, aliveFn: (pid) => pid === 11, notify() {}, cleanup: true });
  run(NOW);
  run(NOW + 5 * MIN);
  const q = takeReady(p, 'S1', { nowMs: NOW + 10 * MIN });
  assert.equal(q.filter((e) => e.kind === 'conflict').length, 1);
  assert.equal(q.find((e) => e.kind === 'conflict').urgent, true);
  done();
});
