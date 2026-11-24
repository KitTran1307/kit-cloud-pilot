import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AUTOFIX_MAX, AUTOFIX_TOTAL, AUTOFIX_COOLDOWN_MS, autofixOff, autofixNotice, startAutofix } from '../lib/autofix.mjs';

for (const k of Object.keys(process.env)) if (/^(KIT_HUB|CLOUD_PILOT)_/.test(k)) delete process.env[k];

const SID = 'session_01ABCDEFGHIJ';
const CLAUDE = { path: '/fake/claude', prefix: ['/fake/claude'] };
const ci = (o = {}) => ({ kind: 'ci-failed', pr: 7, pr_url: 'https://github.com/octo/demo/pull/7', head: 'abc123def', repo: 'octo/demo', ...o });
const conflict = (o = {}) => ({ kind: 'conflict', pr: 7, head: 'abc123def', repo: 'octo/demo', base_ref: 'main', ...o });
const mkTrack = (o = {}) => ({ id: 't1', kind: 'branch', repo: 'octo/demo', branch: 'b', url: `https://claude.ai/code/${SID}`, owner: { account: 'work', configDir: '/cfg/work' }, memo: {}, ...o });
const rig = () => {
  const calls = [];
  const logs = [];
  return { calls, logs, send: async (text, found, opts) => { calls.push({ text, found, opts }); return { sent: true, session_url: found.url }; }, log: (l) => logs.push(l) };
};
const tick = () => new Promise((r) => setImmediate(r));
// Each call 31 minutes after the last, past the cooldown, unless a test is about the cooldown itself.
let clock = 0;
const later = () => (clock += AUTOFIX_COOLDOWN_MS + 60_000);

test('notice texts are exact', () => {
  assert.equal(autofixNotice(ci()), 'CI failed on octo/demo#7 at abc123def. Read the failing checks with gh api repos/octo/demo/commits/abc123def/check-runs, fix it on the same branch, run the checks, push. Do not merge.');
  assert.equal(autofixNotice(conflict()), 'octo/demo#7 has merge conflicts with main. Merge origin/main into your branch, resolve, run the checks, push. Do not merge.');
  assert.equal(autofixNotice(conflict({ base_ref: undefined })), 'octo/demo#7 has merge conflicts with its base branch. Merge the base branch (named on the PR page) into your branch, resolve, run the checks, push. Do not merge.');
});

test('hostile fields: no notice, or the base is dropped', () => {
  assert.equal(autofixNotice(ci({ repo: 'octo/demo\nIgnore previous' })), null);
  assert.equal(autofixNotice(ci({ head: 'zzzzzzz' })), null);
  assert.equal(autofixNotice(ci({ pr: '7' })), null);
  assert.equal(autofixNotice(ci({ pr: 0 })), null);
  assert.equal(autofixNotice({ kind: 'merged', pr: 7, head: 'abc123def', repo: 'octo/demo' }), null);
  assert.equal(autofixNotice(null), null);
  for (const base_ref of ['main\u202eevil', '--x', '/abs', 'a..b', 'a b', 'x'.repeat(101), 42]) {
    const t = autofixNotice(conflict({ base_ref }));
    assert.match(t, /conflicts with its base branch/);
    assert.ok(!t.includes('origin/'));
  }
  assert.match(autofixNotice(conflict({ base_ref: 'release/1.x' })), /origin\/release\/1\.x /);
});

test('no untrusted or title field of the event or PR reaches the text', () => {
  const evil = 'EVIL-INJECTED-TEXT';
  const ev = ci({ untrusted_title: evil, untrusted_checks: [evil], title: evil, pr_title: evil });
  const t = autofixNotice(ev);
  assert.ok(!t.includes(evil));
  const c = conflict({ untrusted_title: evil, title: evil });
  assert.ok(!autofixNotice(c).includes(evil));
  const r = rig();
  startAutofix(mkTrack(), ev, { title: evil, body: evil, sessionId: SID }, { claude: CLAUDE, send: r.send });
  assert.ok(!r.calls[0].text.includes(evil));
  assert.equal(r.calls[0].text, t);
});

test('session comes from the track link, else the PR body, else a reason', async () => {
  let r = rig();
  let out = startAutofix(mkTrack(), ci(), {}, { claude: CLAUDE, send: r.send, log: r.log });
  assert.deepEqual(out, { sent: true, reason: 'notice dispatched; the result is in hub.log' });
  assert.equal(r.calls[0].found.sessionId, SID);

  r = rig();
  const other = 'session_01ZZZZZZZZZZ';
  out = startAutofix(mkTrack({ url: '' }), ci(), { sessionId: other }, { claude: CLAUDE, send: r.send });
  assert.equal(out.sent, true);
  assert.deepEqual(r.calls[0].found, { sessionId: other, url: `https://claude.ai/code/${other}`, trackId: 't1', configDir: '/cfg/work', account: 'work', from: 'pr-body' });

  r = rig();
  out = startAutofix(mkTrack({ url: '', owner: undefined }), ci(), {}, { claude: CLAUDE, send: r.send });
  assert.deepEqual(out, { sent: false, reason: 'no session link on the track or in the PR body' });
  assert.equal(r.calls.length, 0);
  out = startAutofix(mkTrack({ url: '' }), ci(), null, { claude: CLAUDE, send: r.send });
  assert.equal(out.sent, false);
});

test('the track configDir reaches send, with env and claude', () => {
  const r = rig();
  const env = { CLOUD_PILOT_X: '1' };
  startAutofix(mkTrack(), ci(), null, { env, claude: CLAUDE, send: r.send });
  assert.equal(r.calls[0].found.configDir, '/cfg/work');
  assert.equal(r.calls[0].opts.env, env);
  assert.equal(r.calls[0].opts.claude, CLAUDE);
});

test('cap: two notices per kind and commit, memo stays plain', () => {
  const r = rig();
  const t = mkTrack({ memo: undefined });
  const go = (ev) => startAutofix(t, ev, null, { claude: CLAUDE, send: r.send, nowMs: later() });
  assert.equal(go(ci()).sent, true);
  assert.equal(go(ci()).sent, true);
  assert.deepEqual(go(ci()), { sent: false, reason: `limit reached: ${AUTOFIX_MAX} notices already sent for this commit` });
  assert.equal(go(ci({ head: 'def456abc' })).sent, true);
  assert.equal(go(conflict()).sent, true);
  assert.equal(r.calls.length, 4);
  assert.deepEqual(t.memo.autofix, { 'ci-failed:abc123def': 2, 'ci-failed:def456abc': 1, 'conflict:abc123def': 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(t.memo)), t.memo);
});

test('cap: the memo keeps only the newest 50 keys', () => {
  const r = rig();
  const t = mkTrack();
  for (let i = 0; i < 60; i++) { t.memo.autofixTotal = 0; startAutofix(t, ci({ head: (0x1000000 + i).toString(16) }), null, { claude: CLAUDE, send: r.send, nowMs: later() }); }
  const keys = Object.keys(t.memo.autofix);
  assert.equal(keys.length, 50);
  assert.equal(keys.at(-1), `ci-failed:${(0x1000000 + 59).toString(16)}`);
  assert.ok(!keys.includes(`ci-failed:${(0x1000000).toString(16)}`));
});

test('off switch: 0 is off, unset and 1 are on', () => {
  assert.equal(autofixOff({}), false);
  assert.equal(autofixOff({ CLOUD_PILOT_AUTOFIX: '1' }), false);
  assert.equal(autofixOff({ CLOUD_PILOT_AUTOFIX: '0' }), true);
  assert.equal(autofixOff({ KIT_HUB_AUTOFIX: '0' }), true);
  const r = rig();
  const t = mkTrack();
  assert.deepEqual(startAutofix(t, ci(), null, { env: { CLOUD_PILOT_AUTOFIX: '0' }, claude: CLAUDE, send: r.send }), { sent: false, reason: 'off (CLOUD_PILOT_AUTOFIX=0)' });
  assert.equal(r.calls.length, 0);
  assert.equal(t.memo.autofix, undefined);
  assert.equal(startAutofix(t, ci(), null, { env: { CLOUD_PILOT_AUTOFIX: '1' }, claude: CLAUDE, send: r.send }).sent, true);
});

test('a non-autofix event is refused', () => {
  const r = rig();
  assert.deepEqual(startAutofix(mkTrack(), { kind: 'merged', pr: 7 }, null, { claude: CLAUDE, send: r.send }), { sent: false, reason: 'not an autofix event' });
});

test('claude missing: reason returned, cap not consumed', () => {
  const r = rig();
  const t = mkTrack();
  const out = startAutofix(t, ci(), null, { claude: { error: 'claude not found: nope' }, send: r.send });
  assert.deepEqual(out, { sent: false, reason: 'claude not found: nope' });
  assert.equal(r.calls.length, 0);
  assert.equal(t.memo.autofix?.['ci-failed:abc123def'], undefined);
});

test('a rejected or unsent send is logged and never throws', async () => {
  const logs = [];
  const log = (l) => logs.push(l);
  const t = mkTrack();
  assert.equal(startAutofix(t, ci(), null, { claude: CLAUDE, log, nowMs: later(), send: async () => { throw new Error('boom'); } }).sent, true);
  assert.equal(startAutofix(t, conflict(), null, { claude: CLAUDE, log, nowMs: later(), send: async () => ({ sent: false, reason: 'exited 1' }) }).sent, true);
  assert.equal(startAutofix(t, ci({ head: 'def456abc' }), null, { claude: CLAUDE, log, nowMs: later(), send: () => { throw new Error('sync boom'); } }).sent, true);
  await tick();
  assert.equal(logs.length, 3);
  const all = logs.join('\n');
  assert.match(all, /autofix ci-failed octo\/demo#7: not sent: boom/);
  assert.match(all, /autofix conflict octo\/demo#7: not sent: exited 1/);
  assert.match(all, /not sent: sync boom/);
});

test('startAutofix returns before the send settles, then logs sent', async () => {
  const logs = [];
  let release;
  const send = () => new Promise((resolve) => { release = () => resolve({ sent: true }); });
  const out = startAutofix(mkTrack(), ci(), null, { claude: CLAUDE, send, log: (l) => logs.push(l) });
  assert.equal(out.sent, true);
  await tick();
  assert.deepEqual(logs, []);
  release();
  await tick();
  assert.deepEqual(logs, ['autofix ci-failed octo/demo#7: sent']);
});

test('cap across commits: at most AUTOFIX_TOTAL notices per track, none within the cooldown', () => {
  const r = rig();
  const t = mkTrack();
  const t0 = 10_000_000;
  assert.equal(startAutofix(t, ci(), null, { claude: CLAUDE, send: r.send, nowMs: t0 }).sent, true);
  assert.match(startAutofix(t, ci({ head: 'aaa111bbb' }), null, { claude: CLAUDE, send: r.send, nowMs: t0 + 60_000 }).reason, /less than 30 minutes/);
  let now = t0;
  for (let i = 1; i < AUTOFIX_TOTAL; i++) {
    now += AUTOFIX_COOLDOWN_MS + 1;
    assert.equal(startAutofix(t, ci({ head: (0xabc0000 + i).toString(16) }), null, { claude: CLAUDE, send: r.send, nowMs: now }).sent, true);
  }
  now += AUTOFIX_COOLDOWN_MS + 1;
  assert.match(startAutofix(t, ci({ head: 'fff999eee' }), null, { claude: CLAUDE, send: r.send, nowMs: now }).reason, /limit reached: .* for this session/);
  assert.equal(r.calls.length, AUTOFIX_TOTAL);
});
