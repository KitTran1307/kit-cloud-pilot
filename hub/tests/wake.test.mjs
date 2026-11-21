// A started session that never pushes is reported early (no-push), and a plugin can take its own session's events
// without waiting (take), leaving those of branches a watch found by itself for a waiter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { trackEvents, NO_PUSH_MS, QUIET_MS } from '../lib/events.mjs';
import { paths, readJson, writeJson, withLock } from '../lib/store.mjs';
import { addTrack, enqueue, main, takeOwn, takeReady, writeState } from '../hub.mjs';

for (const k of Object.keys(process.env)) if (/^(KIT_HUB|CLOUD_PILOT)_/.test(k)) delete process.env[k];

const T0 = Date.parse('2026-11-21T08:00:00Z');
const MIN = 60_000;
const REPO = 'octo/demo';
const track = (over = {}) => ({ id: 't1', kind: 'branch', repo: REPO, branch: 'claude/hud', url: 'https://claude.ai/code/session_A', title: 'HUD', createdMs: T0, active: true, memo: {}, owner: { sessionId: 'S1', pid: 11, account: 'work' }, ...over });
const snap = (prs = {}, branches = {}) => ({ at: T0, prs, branches, release: null });
const kinds = (r) => r.events.map((e) => e.kind);

test('no-push: once, urgent, 20 min after a started session pushed nothing', () => {
  assert.deepEqual(kinds(trackEvents(track(), null, snap(), T0 + NO_PUSH_MS - MIN)), []);
  const r = trackEvents(track(), null, snap(), T0 + NO_PUSH_MS + MIN);
  assert.deepEqual(kinds(r), ['no-push']);
  const e = r.events[0];
  assert.equal(e.urgent, true);
  assert.equal(e.minutes, 21);
  assert.equal(e.url, 'https://claude.ai/code/session_A');
  assert.match(e.note, /GitHub connection/);
  assert.equal(r.view.state, 'working');
  // Never twice; stalled still comes at the hour, as before.
  assert.deepEqual(kinds(trackEvents(track({ memo: r.memo }), null, snap(), T0 + 40 * MIN)), []);
  assert.deepEqual(kinds(trackEvents(track({ memo: r.memo }), null, snap(), T0 + QUIET_MS + MIN)), ['stalled']);
});

test('no-push: not for a session that pushed, a watch-found branch, a track with no session link, or an open PR', () => {
  const at = T0 + NO_PUSH_MS + MIN;
  assert.deepEqual(kinds(trackEvents(track(), null, snap({}, { 'claude/hud': { exists: true, tipMs: T0 + 2 * MIN } }), at)), []);
  assert.deepEqual(kinds(trackEvents(track({ memo: { sawBranch: true } }), null, snap({}, { 'claude/hud': { exists: true, tipMs: T0 } }), at)), []);
  assert.deepEqual(kinds(trackEvents(track({ discoveredBy: 'r1' }), null, snap(), at)), []);
  assert.deepEqual(kinds(trackEvents(track({ url: '' }), null, snap(), at)), []);
  const pr = { number: 7, state: 'open', merged: false, url: 'u7', title: 'Fix', flag: '', author: 'octo', headSha: 'abc123def456', updatedMs: T0 + 5 * MIN, comments: 0, asks: [], ci: '' };
  assert.deepEqual(kinds(trackEvents(track({ memo: { pr: 7 } }), null, snap({ 'claude/hud': pr }), at)), []);
});

function tmpHub() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-hub-wake-'));
  return { p: paths(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('take: own events only, settling for non-urgent ones, watch-found ones stay queued for a waiter', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  writeJson(p.tracked, [track({ id: 'own' }), track({ id: 'found', branch: 'claude/other', discoveredBy: 'r1', url: '' })]);
  assert.equal(takeOwn(p, 'S1', { nowMs: T0 }), null, 'empty queue');
  withLock(p, () => enqueue(p, 'S1', [
    { kind: 'pr-opened', urgent: false, trackId: 'found', at: T0 },
    { kind: 'stalled', urgent: false, trackId: 'own', at: T0 },
  ]));
  assert.deepEqual(takeOwn(p, 'S1', { nowMs: T0 + 10_000 }), { settleMs: 50_000 });
  const got = takeOwn(p, 'S1', { nowMs: T0 + 61_000 });
  assert.deepEqual(got.events.map((e) => e.trackId), ['own']);
  assert.equal(takeOwn(p, 'S1', { nowMs: T0 + 62_000 }), null, 'only the watch-found event is left');
  // An urgent own event goes at once; the watch-found one is still there for hub-wait.
  withLock(p, () => enqueue(p, 'S1', [{ kind: 'merged', urgent: true, trackId: 'own', at: T0 + 70_000 }]));
  assert.deepEqual(takeOwn(p, 'S1', { nowMs: T0 + 70_001 }).events.map((e) => e.kind), ['merged']);
  assert.deepEqual(takeReady(p, 'S1', { nowMs: T0 + 200_000 }).map((e) => e.trackId), ['found']);
  assert.deepEqual(readJson(`${p.queues}/S1.json`, null), []);
});

test('take: a queue whose only events are watch-found reports nothing and keeps them', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  writeJson(p.tracked, [track({ id: 'found', discoveredBy: 'r1' })]);
  withLock(p, () => enqueue(p, 'S1', [{ kind: 'merged', urgent: true, trackId: 'found', at: T0 }]));
  assert.equal(takeOwn(p, 'S1', { nowMs: T0 + MIN }), null);
  assert.equal(readJson(`${p.queues}/S1.json`, []).length, 1);
});

test('take: a watch-found branch tracked by hand becomes the session\'s own (take, the band), still never deleted', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  const owner = { sessionId: 'S1', pid: 11, account: 'work', repoRoot: '/w', gh: REPO };
  const found = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/hud', discoveredBy: 'r1' }, owner, T0, {});
  withLock(p, () => enqueue(p, 'S1', [{ kind: 'merged', urgent: true, trackId: found.id, at: T0 }]));
  assert.equal(takeOwn(p, 'S1', { nowMs: T0 + MIN }), null);
  const mine = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/hud', url: 'https://claude.ai/code/session_B' }, owner, T0, { CLOUD_PILOT_DELETE_MERGED: '1' });
  assert.equal(mine.id, found.id);
  assert.equal(mine.deleteMerged, false, 'someone else may have pushed it');
  assert.deepEqual(takeOwn(p, 'S1', { nowMs: T0 + MIN }).events.map((e) => e.kind), ['merged']);
  writeState(p, {}, T0 + MIN, () => true);
  assert.equal(readJson(p.state, {}).rows.find((r) => r.id === found.id).discovered, undefined);
});

test('take command: one JSON line as this session, refreshing its pid; empty when nothing is queued', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  const saved = { sid: process.env.CLAUDE_CODE_SESSION_ID, pid: process.env.CLAUDE_PID, log: console.log };
  t.after(() => {
    for (const [k, v] of [['CLAUDE_CODE_SESSION_ID', saved.sid], ['CLAUDE_PID', saved.pid]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    console.log = saved.log;
  });
  process.env.CLAUDE_CODE_SESSION_ID = 'S1';
  process.env.CLAUDE_PID = '4242';
  writeJson(p.tracked, [track({ id: 'own', owner: { sessionId: 'S1', pid: 11, account: 'work' } })]);
  const lines = [];
  console.log = (s) => lines.push(String(s));
  main(['take'], p);
  withLock(p, () => enqueue(p, 'S1', [{ kind: 'question', urgent: true, trackId: 'own', at: Date.now() }]));
  main(['take'], p);
  console.log = saved.log;
  assert.deepEqual(lines.map((l) => JSON.parse(l).status), ['empty', 'events']);
  assert.equal(JSON.parse(lines[1]).events[0].kind, 'question');
  assert.equal(readJson(p.tracked, [])[0].owner.pid, 4242, 'a resumed session keeps its tracks');
});
