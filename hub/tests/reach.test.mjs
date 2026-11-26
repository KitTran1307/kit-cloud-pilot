// A question from a cloud session always reaches someone (2026-11-26: a question on a branch a repo watch found sat
// unread for 28 hours): questions wake the session holding them even for watch-found branches, an owner that leaves
// its news unread counts as gone, a question is never held back by the hourly toast limit, and a question still open
// is told again (question_waiting). Sends run as the right account ("default" = no CLAUDE_CONFIG_DIR) and try the
// other known accounts when the session is not this one's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { askReminder, ASK_REMIND_FIRST_MS, ASK_REMIND_EVERY_MS, ASK_REMIND_MAX } from '../lib/events.mjs';
import { route } from '../lib/route.mjs';
import { paths, readJson, writeJson, withLock } from '../lib/store.mjs';
import { sendCommand, sendToSession, sendToSessionAsync, alternatesOf, failure } from '../lib/send.mjs';
import { addTrack, enqueue, moveQueue, takeOwn, pollOnce, ownerDeaf, DEAF_MS } from '../hub.mjs';

for (const k of Object.keys(process.env)) if (/^(KIT_HUB|CLOUD_PILOT)_/.test(k)) delete process.env[k];

const T0 = Date.parse('2026-11-25T04:00:00Z');
const MIN = 60_000;
const REPO = 'octo/demo';
const iso = (ms) => new Date(ms).toISOString();

function tmpHub() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-hub-reach-'));
  return { p: paths(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeApi(routes) {
  return {
    get(path) {
      if (/^repos\/[^/]+\/[^/]+$/.test(path) && !(path in routes)) return { default_branch: 'main' };
      for (const [prefix, value] of Object.entries(routes)) if (path.startsWith(prefix)) return typeof value === 'function' ? value(path) : value;
      return null;
    },
    del() {},
    flush() {},
  };
}

const SAME_REPO = { owner: { login: 'octo' }, full_name: REPO };
const ghPr = (updated) => ({
  number: 11, state: 'open', merged_at: null, merge_commit_sha: null, html_url: `https://github.com/${REPO}/pull/11`, title: 'Redesign',
  body: 'WORKING', user: { login: 'octo' }, head: { ref: 'claude/redesign', sha: 'abc123def456', repo: SAME_REPO }, base: { ref: 'main' },
  created_at: iso(T0), updated_at: iso(updated),
});
const askBody = '<!-- kit-channel:ask {"v":1,"id":"main-has-own","asked_at":"2026-11-25T04:22:45Z"} -->\nWAITING FOR YOU (main-has-own): A, B or C?';
const askApi = () => fakeApi({
  [`repos/${REPO}/pulls?state=all&per_page=50`]: [ghPr(T0 + 22 * MIN)],
  [`repos/${REPO}/issues/11/comments`]: [{ id: 5, body: askBody, user: { login: 'octo' }, created_at: iso(T0 + 22 * MIN), updated_at: iso(T0 + 22 * MIN) }],
  [`repos/${REPO}/pulls/11/files`]: [{ filename: 'src/a.js' }],
  [`repos/${REPO}/branches/`]: { commit: { sha: 'abc123def456', commit: { committer: { date: iso(T0 + 20 * MIN) } } } },
  [`repos/${REPO}/commits/`]: { check_runs: [] },
});
const owner = { sessionId: 'S1', pid: 11, account: 'acc2', repoRoot: '/w', gh: REPO };

test('take: a question on a branch a watch found wakes the session holding it; other news of that branch stays', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  writeJson(p.tracked, [{ id: 'found', kind: 'branch', repo: REPO, branch: 'claude/redesign', discoveredBy: 'r1', active: true, owner }]);
  withLock(p, () => enqueue(p, 'S1', [
    { kind: 'conflict', urgent: true, trackId: 'found', at: T0 },
    { kind: 'question', urgent: true, trackId: 'found', at: T0, id: 'main-has-own' },
  ]));
  assert.deepEqual(takeOwn(p, 'S1', { nowMs: T0 + MIN }).events.map((e) => e.kind), ['question']);
  assert.deepEqual(readJson(`${p.queues}/S1.json`, []).map((e) => e.kind), ['conflict'], 'kept for hub-wait');
});

test('deaf owner: an urgent own event unread for 15 min; watch-found non-questions do not count', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  const tr = { id: 'own', kind: 'branch', repo: REPO, branch: 'claude/a', active: true, owner };
  writeJson(p.tracked, [tr, { id: 'found', kind: 'branch', repo: REPO, branch: 'claude/b', discoveredBy: 'r1', active: true, owner }]);
  withLock(p, () => enqueue(p, 'S1', [{ kind: 'merged', urgent: true, trackId: 'found', at: T0 }]));
  assert.equal(ownerDeaf(p, tr, T0 + 2 * DEAF_MS), false, 'left there on purpose');
  withLock(p, () => enqueue(p, 'S1', [{ kind: 'question', urgent: true, trackId: 'found', at: T0 + MIN }]));
  assert.equal(ownerDeaf(p, tr, T0 + MIN + DEAF_MS - 1), false);
  assert.equal(ownerDeaf(p, tr, T0 + MIN + DEAF_MS), true);
  // route: a deaf owner is passed over for a live waiter on the same repo and account, else the track is orphaned.
  const alive = () => true;
  const heir = { sessionId: 'S2', pid: 22, waiterPid: 23, account: 'acc2', gh: REPO, since: T0 };
  assert.equal(route(tr, [heir], alive).to, 'S1', 'not deaf: the owner keeps it');
  assert.equal(route(tr, [heir], alive, { deaf: true }).to, 'S2');
  assert.equal(route(tr, [], alive, { deaf: true }).orphaned, true);
});

test('reminder: none before 20 min, then hourly, at most 8, forgotten once the question is answered', () => {
  const tr = { id: 't', kind: 'branch', repo: REPO, branch: 'claude/redesign', active: true, memo: {}, view: { state: 'question', pr: 11, prUrl: 'https://github.com/octo/demo/pull/11' } };
  assert.equal(askReminder(tr, T0), null);
  assert.equal(askReminder(tr, T0 + ASK_REMIND_FIRST_MS - 1), null);
  const first = askReminder(tr, T0 + ASK_REMIND_FIRST_MS);
  assert.equal(first.kind, 'question_waiting');
  assert.equal(first.urgent, true);
  assert.deepEqual([first.pr, first.waiting_min, first.reminder], [11, 20, 1]);
  assert.match(first.note, /cloud-pilot questions --repo octo\/demo --pr 11/);
  assert.equal(askReminder(tr, T0 + ASK_REMIND_FIRST_MS + ASK_REMIND_EVERY_MS - 1), null);
  let n = 1;
  for (let i = 1; i < 20; i += 1) if (askReminder(tr, T0 + ASK_REMIND_FIRST_MS + i * ASK_REMIND_EVERY_MS)) n += 1;
  assert.equal(n, ASK_REMIND_MAX);
  tr.view = { state: 'pr', pr: 11 };
  assert.equal(askReminder(tr, T0 + 30 * 3600_000), null);
  assert.equal(tr.memo.askSinceMs, undefined, 'a later question starts over');
  assert.equal(askReminder({ ...tr, kind: 'repo', view: { state: 'question' } }, T0), null);
});

test('poll: an orphaned question is toasted even right after another toast, and reminded until answered', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  const tr = addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/redesign', title: 'Redesign' }, { ...owner, pid: 999 }, T0);
  withLock(p, () => { const list = readJson(p.tracked, []); list[0].lastToastMs = T0 + 20 * MIN; writeJson(p.tracked, list); });
  const toasts = [];
  const poll = (at) => pollOnce(p, { api: askApi(), nowMs: at, aliveFn: () => false, notify: (a, b) => toasts.push(b), alert: () => {}, autofix: () => ({ sent: false }) });
  poll(T0 + 23 * MIN);
  assert.equal(toasts.length, 1, 'the question is not held back by the toast 3 min earlier');
  assert.match(toasts[0], /question .* its local session has ended/);
  poll(T0 + 30 * MIN);
  assert.equal(toasts.length, 1, 'nothing new yet');
  poll(T0 + 23 * MIN + ASK_REMIND_FIRST_MS);
  assert.equal(toasts.length, 2);
  assert.match(toasts[1], /a question has waited 20 min for an answer \(PR #11\)/);
  const q = readJson(`${p.queues}/S1.json`, []).map((e) => e.kind);
  assert.deepEqual(q, ['pr-opened', 'question', 'question_waiting']);
  assert.equal(readJson(p.tracked, []).find((x) => x.id === tr.id).memo.askReminded, 1);
});

test('poll: a live owner gets the reminder as an event and the person a toast', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/redesign', title: 'Redesign' }, owner, T0);
  const toasts = [];
  const poll = (at) => pollOnce(p, { api: askApi(), nowMs: at, aliveFn: () => true, notify: (a, b) => toasts.push(b), alert: () => {}, autofix: () => ({ sent: false }) });
  poll(T0 + 23 * MIN);
  assert.equal(toasts.length, 0, 'the live session handles the first question');
  takeOwn(p, 'S1', { nowMs: T0 + 24 * MIN }); // the session read it
  poll(T0 + 23 * MIN + ASK_REMIND_FIRST_MS);
  assert.equal(toasts.length, 1);
  assert.deepEqual(readJson(`${p.queues}/S1.json`, []).map((e) => e.kind), ['question_waiting']);
});

test('poll: a question left unread by a running owner for 15 min is toasted as not read', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  addTrack(p, { kind: 'branch', repo: REPO, branch: 'claude/redesign', title: 'Redesign' }, owner, T0);
  const toasts = [];
  const poll = (at) => pollOnce(p, { api: askApi(), nowMs: at, aliveFn: () => true, notify: (a, b) => toasts.push(b), alert: () => {}, autofix: () => ({ sent: false }) });
  poll(T0 + 23 * MIN);
  poll(T0 + 23 * MIN + ASK_REMIND_FIRST_MS); // the reminder finds the first question still queued: the owner is deaf
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /is not reading cloud news/);
});

test('handover from a deaf owner: the heir gets the events as new, so it is not judged deaf for them', (t) => {
  const { p, done } = tmpHub();
  t.after(done);
  const tr = { id: 'own', kind: 'branch', repo: REPO, branch: 'claude/a', active: true, owner };
  writeJson(p.tracked, [tr]);
  withLock(p, () => enqueue(p, 'S1', [{ kind: 'question', urgent: true, trackId: 'own', at: T0 }]));
  const at = T0 + DEAF_MS + MIN;
  assert.equal(ownerDeaf(p, tr, at), true);
  const heir = { sessionId: 'S2', pid: 22, waiterPid: 23, account: 'acc2', gh: REPO, since: T0 };
  const dest = route(tr, [heir], () => true, { deaf: true });
  assert.equal(dest.to, 'S2');
  withLock(p, () => moveQueue(p, 'S1', dest.to, at)); // as deliver does
  const moved = { ...tr, owner: dest.newOwner };
  assert.deepEqual(readJson(`${p.queues}/S2.json`, []).map((e) => [e.at, e.handed_over]), [[at, true]]);
  assert.equal(ownerDeaf(p, moved, at + DEAF_MS - 1), false, 'the heir has its own 15 min');
  assert.equal(ownerDeaf(p, moved, at + DEAF_MS), true);
});

// ---- sends -------------------------------------------------------------------------------------------------------------

const claude = { prefix: ['claude'] };
const found = (over = {}) => ({ sessionId: 'session_ABCDEFGH12', url: 'https://claude.ai/code/session_ABCDEFGH12', trackId: 't', configDir: null, account: null, ...over });

test('send: "default" runs with no CLAUDE_CONFIG_DIR; a recorded folder is used; anything else inherits', () => {
  const env = { CLAUDE_CONFIG_DIR: 'C:/Users/u/.claude-acc4', PATH: 'x' };
  assert.equal('CLAUDE_CONFIG_DIR' in sendCommand('hi', found({ account: 'default' }), { env, claude }).env, false);
  assert.equal(sendCommand('hi', found({ configDir: 'C:/Users/u/.claude-acc2', account: 'acc2' }), { env, claude }).env.CLAUDE_CONFIG_DIR, 'C:/Users/u/.claude-acc2');
  assert.equal(sendCommand('hi', found({ account: 'acc9' }), { env, claude }).env.CLAUDE_CONFIG_DIR, 'C:/Users/u/.claude-acc4');
});

test('send: failures say what to do (not found: another account; expired login: sign in again)', () => {
  const nf = failure(found({ configDir: 'C:/Users/u/.claude-acc4' }), { status: 1, out: 'Error: Session not found: session_ABCDEFGH12' });
  assert.equal(nf.why, 'not-found');
  assert.match(nf.reason, /not one of acc4's: .*desktop app/);
  const lg = failure(found({ account: 'default' }), { status: 1, out: 'Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login`' });
  assert.equal(lg.why, 'login');
  assert.match(lg.reason, /login of default has expired: sign in again with claude auth login with no CLAUDE_CONFIG_DIR set/);
  assert.equal(failure(found(), { status: 1, out: 'boom' }).why, 'other');
});

test('send: tries the other known accounts when the session is not this one\'s, and stops at another error', async () => {
  const tracked = [{ owner: { configDir: 'C:/u/.claude-acc2' } }, { owner: { configDir: 'C:/u/.claude-acc4' } }, { owner: { configDir: 'C:/u/.claude-acc2' } }, { owner: {} }];
  const f = found({ configDir: 'C:/u/.claude-acc4', account: 'acc4' });
  const alts = alternatesOf(tracked, f);
  assert.deepEqual(alts.map((a) => [a.configDir, a.account]), [['C:/u/.claude-acc2', 'acc2'], [null, 'default']]);
  const seen = [];
  const run = (prefix, args, env) => { seen.push(env.CLAUDE_CONFIG_DIR ?? 'none'); return env.CLAUDE_CONFIG_DIR ? { status: 1, out: 'Session not found' } : { status: 0, out: '' }; };
  const r = sendToSession('hi', f, { env: {}, claude, run, alternates: alts });
  assert.deepEqual([r.sent, r.as_account], [true, 'default']);
  assert.deepEqual(seen, ['C:/u/.claude-acc4', 'C:/u/.claude-acc2', 'none']);
  const other = await sendToSessionAsync('hi', f, { env: {}, claude, run: async () => ({ status: 1, out: 'network down' }), alternates: alts });
  assert.equal(other.sent, false);
  assert.match(other.reason, /network down/);
  const none = sendToSession('hi', f, { env: {}, claude, run: () => ({ status: 1, out: 'Session not found' }), alternates: alts });
  assert.equal(none.sent, false);
  assert.equal(none.reason.split(' | ').length, 3, 'every try is in the reason');
  assert.deepEqual(alternatesOf([], found({ account: 'default' })), [], '"default" was the one tried');
  const spelled = [{ owner: { configDir: 'C:\\u\\.claude-ACC4\\' } }, { owner: { configDir: 'C:/u/.claude' } }, { owner: { configDir: 'C:/u/.claude-acc5' } }];
  assert.deepEqual(alternatesOf(spelled, f).map((a) => a.account), ['acc5', 'default'], 'one try per account, ~/.claude is default');
});
