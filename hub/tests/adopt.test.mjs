// A cloud session told claude/<slug> pushes claude/<slug>-<random>: the track started for it follows that branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { paths, readJson, writeJson } from '../lib/store.mjs';
import { addTrack, pollOnce, takeReady, adoptBranches, discover, ADOPT_WINDOW_MS } from '../hub.mjs';

for (const k of Object.keys(process.env)) if (/^(KIT_HUB|CLOUD_PILOT)_/.test(k)) delete process.env[k];

const T0 = Date.parse('2026-11-10T10:00:00Z');
const MIN = 60_000;
const REPO = 'octo/demo';
const owner = { sessionId: 'S1', pid: 11, account: 'work', repoRoot: '/work/demo' };
const iso = (ms) => new Date(ms).toISOString();

function tmpHub() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-hub-adopt-'));
  return { p: paths(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
}

// refs: branch -> tip time (ms). pulls: PR list.
function gh({ refs, pulls = () => [] }) {
  const calls = [];
  const deleted = [];
  return {
    calls, deleted,
    get(path) {
      calls.push(path);
      const m = path.match(/git\/matching-refs\/heads\/(.*)$/);
      if (m) {
        const prefix = m[1].split('/').map(decodeURIComponent).join('/');
        return Object.keys(refs).filter((b) => b.startsWith(prefix)).map((b) => ({ ref: `refs/heads/${b}`, object: { sha: `sha-${b}` } }));
      }
      const b = path.match(/\/branches\/([^?]+)$/);
      if (b) {
        const name = decodeURIComponent(b[1]);
        return name in refs ? { commit: { sha: `sha-${name}`, commit: { committer: { date: iso(refs[name]) } } } } : null;
      }
      if (path.includes('/pulls?')) return pulls();
      if (path.includes('/comments')) return [];
      if (path.includes('/commits/')) return { check_runs: [], statuses: [] };
      return null;
    },
    del(path) { deleted.push(path); },
    flush() {},
  };
}

const prOf = (ref, over = {}) => ({
  number: 65, state: 'open', merged_at: null, merge_commit_sha: null, html_url: `https://github.com/${REPO}/pull/65`, title: 't',
  body: '', user: { login: 'octo' }, head: { ref, sha: `sha-${ref}`, repo: { owner: { login: 'octo' }, full_name: REPO } },
  created_at: iso(T0 + 20 * MIN), updated_at: iso(T0 + 20 * MIN), ...over,
});

test('a started track follows claude/<slug>-<random>: no false stalled, merged branch deleted with the track setting', () => {
  const { p, done } = tmpHub();
  const t = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/fix-login', url: 'u', deleteMerged: true }, owner, T0);
  const refs = { 'claude/fix-login-a1-968lrs': T0 + 5 * MIN, 'claude/other-x1': T0 };
  let merged = false;
  const api = gh({ refs, pulls: () => [prOf('claude/fix-login-a1-968lrs', merged ? { state: 'closed', merged_at: iso(T0 + 100 * MIN), updated_at: iso(T0 + 100 * MIN) } : {})] });
  pollOnce(p, { api: api, nowMs: T0 + 10 * MIN, aliveFn: (pid) => pid === 11, notify: () => {} });
  let tr = readJson(p.tracked, []).find((x) => x.id === t.id);
  assert.equal(tr.branch, 'claude/fix-login-a1-968lrs');
  assert.equal(tr.requestedBranch, 'claude/fix-login');
  assert.equal(tr.deleteMerged, true);
  assert.deepEqual(takeReady(p, 'S1', { nowMs: T0 + 12 * MIN }).map((e) => e.kind), ['pr-opened']);
  // pushes keep coming: no stalled at +70 min
  refs['claude/fix-login-a1-968lrs'] = T0 + 60 * MIN;
  pollOnce(p, { api: api, nowMs: T0 + 70 * MIN, aliveFn: (pid) => pid === 11, notify: () => {} });
  assert.equal(takeReady(p, 'S1', { nowMs: T0 + 72 * MIN }), null, 'no stalled while the real branch moves');
  merged = true;
  pollOnce(p, { api: api, nowMs: T0 + 101 * MIN, aliveFn: (pid) => pid === 11, notify: () => {} });
  assert.deepEqual(takeReady(p, 'S1', { nowMs: T0 + 101 * MIN }).map((e) => e.kind), ['merged']);
  assert.deepEqual(api.deleted, [`repos/${REPO}/git/refs/heads/claude/fix-login-a1-968lrs`]);
  tr = readJson(p.tracked, []).find((x) => x.id === t.id);
  assert.equal(tr.active, false);
  done();
});

test('adoption skips: its own branch exists, an older session\'s branch, a longer slug\'s branch, a branch another track owns', () => {
  const { p, done } = tmpHub();
  const own = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/own' }, owner, T0);
  const old = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/old' }, owner, T0);
  const email = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/email' }, owner, T0);
  const tpl = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/email-templates' }, owner, T0);
  addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/hand-abc123' }, owner, T0);
  const hand = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/hand' }, owner, T0);
  const refs = {
    'claude/own': T0 + MIN, 'claude/own-zz11': T0 + 2 * MIN,
    'claude/old-aaa111': T0 - 3 * 3600_000,
    'claude/email-templates-b1-soao3a': T0 + 3 * MIN,
    'claude/hand-abc123': T0 + 3 * MIN,
  };
  const tracks = readJson(p.tracked, []);
  const ids = adoptBranches(p, gh({ refs }), REPO, tracks, T0 + 5 * MIN);
  assert.deepEqual(ids, [tpl.id]);
  const by = (id) => readJson(p.tracked, []).find((x) => x.id === id);
  assert.equal(by(tpl.id).branch, 'claude/email-templates-b1-soao3a');
  for (const id of [own.id, old.id, email.id, hand.id]) assert.equal(by(id).requestedBranch, undefined);
  // past the window nothing is looked up
  const api = gh({ refs: { 'claude/old-new1': T0 + ADOPT_WINDOW_MS } });
  assert.deepEqual(adoptBranches(p, api, REPO, readJson(p.tracked, []), T0 + ADOPT_WINDOW_MS + MIN), []);
  assert.equal(api.calls.length, 0);
  done();
});

test('a track the watcher already made for the real branch is merged into the started one (memo kept, no duplicate events)', () => {
  const { p, done } = tmpHub();
  const w = addTrack(p, { kind: 'repo', repo: REPO, discover: true }, owner, T0 - 60 * MIN);
  const t = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/add-search', deleteMerged: true }, owner, T0);
  const refs = { 'claude/add-search-erdgmv': T0 + 5 * MIN };
  const now = { refs: [{ branch: 'claude/add-search-erdgmv' }], prs: {} };
  const [found] = discover(p, REPO, readJson(p.tracked, []), { at: T0, refs: [] }, now, T0 + 6 * MIN);
  const list = readJson(p.tracked, []);
  const twin = list.find((x) => x.id === found);
  twin.memo = { pr: 66, sawBranch: true };
  writeJson(p.tracked, list);
  adoptBranches(p, gh({ refs }), REPO, readJson(p.tracked, []), T0 + 8 * MIN);
  const after = readJson(p.tracked, []);
  const me = after.find((x) => x.id === t.id);
  assert.equal(me.branch, 'claude/add-search-erdgmv');
  assert.equal(me.memo.pr, 66);
  assert.equal(me.deleteMerged, true);
  assert.equal(after.find((x) => x.id === found).active, false);
  assert.ok(after.find((x) => x.id === w.id).active);
  done();
});
