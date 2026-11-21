// An account whose started session pushed nothing is set aside: start refuses it until a session of it pushes or the
// person says GitHub is reconnected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { paths, readJson } from '../lib/store.mjs';
import { setAsideOf, asideMessage } from '../lib/accounts.mjs';
import { addTrack, pollOnce, takeReady, main, noPushMsOf, writeState } from '../hub.mjs';

for (const k of Object.keys(process.env)) if (/^(KIT_HUB|CLOUD_PILOT)_/.test(k)) delete process.env[k];

const T0 = Date.parse('2026-11-21T08:00:00Z');
const MIN = 60_000;
const REPO = 'octo/demo';
const owner = { sessionId: 'S1', pid: 11, account: 'acc2', repoRoot: '/work/demo' };
const iso = (ms) => new Date(ms).toISOString();

function tmpHub() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-hub-aside-'));
  return { p: paths(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function gh(refs) {
  return {
    get(path) {
      if (/^repos\/[^/]+\/[^/]+$/.test(path)) return { default_branch: 'main' };
      if (path.includes('/git/matching-refs/heads/')) return Object.keys(refs).map((b) => ({ ref: `refs/heads/${b}`, object: { sha: `sha-${b}` } }));
      const b = path.match(/\/branches\/([^?]+)$/);
      if (b) { const name = decodeURIComponent(b[1]); return name in refs ? { commit: { sha: `sha-${name}`, commit: { committer: { date: iso(refs[name]) } } } } : null; }
      if (path.includes('/pulls?')) return [];
      return null;
    },
    del() {}, flush() {},
  };
}

test('no-push sets the account aside, with the brief for a local takeover; a later push by its session brings it back', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  const tr = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/studio', url: 'https://claude.ai/code/session_X', title: 'Studio', briefFile: '/hub/briefs/session_X.md' }, owner, T0, { CLOUD_PILOT_NO_PUSH_MIN: '12' });
  assert.equal(tr.noPushMs, 12 * MIN);
  const refs = {};
  pollOnce(p, { api: gh(refs), nowMs: T0 + 11 * MIN, aliveFn: () => true, notify: () => {} });
  assert.equal(setAsideOf(p, 'acc2'), null, 'not before its time');
  pollOnce(p, { api: gh(refs), nowMs: T0 + 13 * MIN, aliveFn: () => true, notify: () => {} });
  const ev = takeReady(p, 'S1', { nowMs: T0 + 13 * MIN })[0];
  assert.equal(ev.kind, 'no-push');
  assert.equal(ev.account, 'acc2');
  assert.equal(ev.account_set_aside, true);
  assert.match(ev.note, /Do not start this task in the cloud again/);
  assert.equal(ev.brief_file, '/hub/briefs/session_X.md');
  assert.match(ev.note, /cloud-pilot account --ok acc2/);
  const aside = setAsideOf(p, 'acc2');
  assert.equal(aside.url, 'https://claude.ai/code/session_X');
  assert.equal(aside.sinceMs, T0 + 13 * MIN);
  assert.match(asideMessage('acc2', aside), /Do the work locally/);
  // Another account is not touched.
  assert.equal(setAsideOf(p, 'acc4'), null);
  // The session pushes after all: its account is back.
  refs['claude/studio'] = T0 + 14 * MIN;
  pollOnce(p, { api: gh(refs), nowMs: T0 + 15 * MIN, aliveFn: () => true, notify: () => {} });
  assert.equal(setAsideOf(p, 'acc2'), null);
});

test('account command lists and clears; the setting is clamped', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/a', url: 'https://claude.ai/code/session_Y' }, owner, T0, {});
  pollOnce(p, { api: gh({}), nowMs: T0 + 21 * MIN, aliveFn: () => true, notify: () => {} });
  writeState(p, {}, T0 + 21 * MIN, () => true);
  assert.ok(readJson(p.state, {}).accounts.acc2);
  const lines = [];
  const log = console.log;
  console.log = (s) => lines.push(JSON.parse(String(s)));
  try {
    main(['account'], p);
    main(['account', '--ok'], p);
    main(['account', '--ok', 'acc2'], p);
    main(['account', '--ok', 'acc2'], p);
  } finally { console.log = log; process.exitCode = 0; }
  assert.deepEqual(Object.keys(lines[0].set_aside), ['acc2']);
  assert.equal(lines[1].ok, false, 'no name: nothing cleared, said plainly');
  assert.deepEqual([lines[2].cleared, lines[3].cleared], [true, false]);
  assert.match(lines[3].note, /was not set aside/);
  assert.deepEqual(readJson(p.accounts, null), {});
  assert.equal(readJson(p.state, {}).accounts?.acc2, undefined, 'the band stops saying it at once');
  assert.equal(noPushMsOf({}), undefined);
  assert.equal(noPushMsOf({ CLOUD_PILOT_NO_PUSH_MIN: '1' }), 5 * MIN);
  assert.equal(noPushMsOf({ CLOUD_PILOT_NO_PUSH_MIN: '999' }), 120 * MIN);
  assert.equal(noPushMsOf({ CLOUD_PILOT_NO_PUSH_MIN: 'soon' }), undefined);
});

test('no aside when another session of the account pushed since this one started; any later push clears it', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  const refs = { 'claude/fast': T0 + 4 * MIN };
  addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/fast', url: 'https://claude.ai/code/session_F' }, owner, T0, {});
  addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/slow', url: 'https://claude.ai/code/session_S' }, owner, T0 + MIN, {});
  pollOnce(p, { api: gh(refs), nowMs: T0 + 5 * MIN, aliveFn: () => true, notify: () => {} });
  pollOnce(p, { api: gh(refs), nowMs: T0 + 22 * MIN, aliveFn: () => true, notify: () => {} });
  const ev = takeReady(p, 'S1', { nowMs: T0 + 22 * MIN }).find((e) => e.kind === 'no-push');
  assert.equal(ev.branch, 'claude/slow');
  assert.equal(ev.account_set_aside, false, 'claude/fast proved the account reaches GitHub');
  assert.equal(setAsideOf(p, 'acc2'), null);
});

test('a session that had pushed before the aside clears it when it pushes again (level, not edge)', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  const refs = { 'claude/early': T0 - 30 * MIN };
  addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/early', url: 'https://claude.ai/code/session_E' }, owner, T0 - 40 * MIN, {});
  pollOnce(p, { api: gh(refs), nowMs: T0, aliveFn: () => true, notify: () => {} });
  addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/new', url: 'https://claude.ai/code/session_N' }, owner, T0, {});
  pollOnce(p, { api: gh(refs), nowMs: T0 + 21 * MIN, aliveFn: () => true, notify: () => {} });
  assert.ok(setAsideOf(p, 'acc2'), 'claude/early pushed only before claude/new started: no proof');
  refs['claude/early'] = T0 + 25 * MIN;
  pollOnce(p, { api: gh(refs), nowMs: T0 + 26 * MIN, aliveFn: () => true, notify: () => {} });
  assert.equal(setAsideOf(p, 'acc2'), null);
});
