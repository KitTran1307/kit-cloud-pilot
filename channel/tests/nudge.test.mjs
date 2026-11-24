// nudge.mjs: after a posted answer, the cloud session that asked is told to read it (best effort, no authority).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findSession, nudge, nudgeText, sessionIdOf, sessionFromBody } from '../nudge.mjs';
import { runAnswer } from '../answer.mjs';
import { questionSha256 } from '../cloud/channel.mjs';
import { T0, MIN, REPO, PR, ID, QUESTION, KEYS, tmpDir, askC, fakeGithub, capture } from './helpers.mjs';

const S1 = 'session_01AbCdEfGh12345678';
const S2 = 'session_01ZyXwVuTs98765432';
const track = (over) => ({ id: 't1', kind: 'branch', repo: REPO, branch: 'claude/x', url: `https://claude.ai/code/${S1}?from=cli`, active: true, createdMs: 1, memo: { pr: PR }, owner: { account: 'a2', configDir: 'cfg-dir-a2' }, ...over });
const okRun = (calls) => (prefix, args, env) => { calls.push({ prefix, args, env }); return { status: 0, out: 'View: x' }; };
const claude = { prefix: ['claude'] };

test('sessionIdOf reads the id from a session link and nothing else', () => {
  assert.equal(sessionIdOf(`https://claude.ai/code/${S1}?from=cli&m=0`), S1);
  assert.equal(sessionIdOf('https://github.com/o/r/pull/1'), null);
  assert.equal(sessionIdOf(undefined), null);
});

test('findSession matches the repo (any case) and the PR, else the head branch; active and newest win', () => {
  const list = [
    track({ id: 'old', createdMs: 1 }),
    track({ id: 'new', createdMs: 5, url: `https://claude.ai/code/${S2}` }),
    track({ id: 'ended', createdMs: 9, active: false }),
    track({ id: 'other-repo', repo: 'x/y', createdMs: 99 }),
    track({ id: 'no-link', url: undefined, createdMs: 99 }),
  ];
  assert.equal(findSession(list, { repo: REPO.toUpperCase(), pr: PR }).trackId, 'new');
  const byBranch = [track({ memo: {}, branch: 'claude/y' })];
  assert.equal(findSession(byBranch, { repo: REPO, pr: PR }), null);
  assert.equal(findSession(byBranch, { repo: REPO, pr: PR, headRef: 'claude/y' }).sessionId, S1);
  assert.equal(findSession('not a list', { repo: REPO, pr: PR }), null);
});

test('nudge runs claude -p <notice> --cloud <session> as the account that started it', async () => {
  const calls = [];
  const r = await nudge({ repo: REPO, pr: PR, id: ID }, { env: { PATH: 'p' }, tracked: [track()], run: okRun(calls), claude });
  assert.deepEqual(r, { sent: true, session_url: track().url });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['-p', nudgeText({ repo: REPO, pr: PR, id: ID }), '--cloud', S1]);
  assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, 'cfg-dir-a2');
  assert.equal(calls[0].env.PATH, 'p');
});

test('the notice holds no answer and points only at the signed wait', () => {
  const t = nudgeText({ repo: REPO, pr: PR, id: ID });
  assert.match(t, new RegExp(`channel.mjs wait --repo ${REPO} --pr ${PR} --id ${ID}`));
  assert.match(t, /holds no answer and approves nothing/);
});

test('nudge finds the session through the PR head branch when no track names the PR', async () => {
  const calls = [];
  const api = async (p) => (p === `repos/${REPO}/pulls/${PR}` ? { head: { ref: 'claude/z' } } : null);
  const r = await nudge({ repo: REPO, pr: PR, id: ID }, { env: {}, tracked: [track({ memo: {}, branch: 'claude/z' })], api, run: okRun(calls), claude });
  assert.equal(r.sent, true);
});

test('nudge never throws: off, no session, no claude, claude failing', async () => {
  const calls = [];
  assert.match((await nudge({ repo: REPO, pr: PR, id: ID }, { env: { CLOUD_PILOT_NUDGE: '0' }, tracked: [track()], run: okRun(calls), claude })).reason, /off/);
  assert.match((await nudge({ repo: REPO, pr: PR, id: ID }, { env: {}, tracked: [], run: okRun(calls), claude })).reason, /no tracked cloud session/);
  const api = async () => { throw new Error('down'); };
  assert.equal((await nudge({ repo: REPO, pr: PR, id: ID }, { env: {}, tracked: [], api, run: okRun(calls), claude })).sent, false);
  assert.match((await nudge({ repo: REPO, pr: PR, id: ID }, { env: {}, tracked: [track()], run: okRun(calls), claude: { error: 'claude not found' } })).reason, /claude not found/);
  assert.equal(calls.length, 0);
  const bad = await nudge({ repo: REPO, pr: PR, id: ID }, { env: {}, tracked: [track()], run: () => ({ status: 1, out: 'Error: no such session\n' }), claude });
  assert.deepEqual([bad.sent, /exited 1: Error: no such session/.test(bad.reason)], [false, true]);
  assert.equal(bad.notice, nudgeText({ repo: REPO, pr: PR, id: ID }), 'the notice comes back so Claude can send it itself');
});

test('nudge reads the tracks from the hub folder (CLOUD_PILOT_DIR)', async () => {
  const dir = tmpDir('cloudpilot-hub-');
  fs.writeFileSync(path.join(dir, 'tracked.json'), JSON.stringify([track()]));
  const calls = [];
  const r = await nudge({ repo: REPO, pr: PR, id: ID }, { env: { CLOUD_PILOT_DIR: dir }, run: okRun(calls), claude });
  assert.equal(r.sent, true);
});

test('runAnswer reports the nudge with the posted answer, and a failing nudge never fails the answer', async () => {
  const dir = tmpDir('cloudpilot-keys-');
  fs.writeFileSync(path.join(dir, 'ed25519-private.pem'), KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const args = ['--repo', REPO, '--pr', String(PR), '--id', ID, '--answer', 'yes', '--question-sha256', questionSha256(QUESTION)];
  for (const [nudgeFn, want] of [
    [async () => ({ sent: true, session_url: 'u' }), { sent: true, session_url: 'u' }],
    [async () => { throw new Error('boom'); }, { sent: false, reason: 'boom' }],
  ]) {
    const gh = fakeGithub([askC(100, T0)]);
    const cap = capture();
    const code = await runAnswer(args, { env: { CLOUD_PILOT_KEY_DIR: dir }, out: cap.out, errOut: () => {}, api: gh.api, now: () => T0 + MIN, account: () => 't', nudge: nudgeFn });
    assert.equal(code, 0);
    assert.equal(cap.json()[0].status, 'posted');
    assert.deepEqual(cap.json()[0].nudge, want);
  }
  // a dry run posts nothing and tells no one
  const gh = fakeGithub([askC(100, T0)]);
  const cap = capture();
  let told = 0;
  await runAnswer([...args, '--dry-run'], { env: {}, out: cap.out, errOut: () => {}, api: gh.api, now: () => T0 + MIN, account: () => 't', nudge: async () => { told += 1; return {}; } });
  assert.equal(told, 0);
  assert.equal('nudge' in cap.json()[0], false);
});

test('a handed-over track keeps the Claude config it runs as', async () => {
  const { route } = await import('../../hub/lib/route.mjs');
  const owner = { sessionId: 'dead', pid: 1, account: 'a2', configDir: 'cfg-dir-a2' };
  const t = { kind: 'branch', repo: 'o/r', owner };
  const alive = (pid) => pid === 2 || pid === 3;
  const heir = { sessionId: 'heir', pid: 2, waiterPid: 3, gh: 'o/r', account: 'a2', repoRoot: 'r', since: 1 };
  const old = route(t, [heir], alive);
  assert.equal(old.newOwner.configDir, 'cfg-dir-a2', 'an heir without one keeps the same account\'s');
  assert.equal(old.newOwner.sessionId, 'heir');
  assert.equal(route(t, [{ ...heir, configDir: 'cfg-dir-new' }], alive).newOwner.configDir, 'cfg-dir-new');
  // A repo track may pass to another account; that heir never borrows the old owner's config.
  assert.equal('configDir' in route({ ...t, kind: 'repo' }, [{ ...heir, account: 'other' }], alive).newOwner, false);
});

test('caller() records the Claude config the session runs as', async () => {
  const { caller } = await import('../../hub/hub.mjs');
  assert.equal(caller({ CLAUDE_CONFIG_DIR: 'cfg-dir-a2', CLAUDE_CODE_SESSION_ID: 's' }, tmpDir('cloudpilot-cwd-')).configDir, 'cfg-dir-a2');
  assert.equal('configDir' in caller({ CLAUDE_CODE_SESSION_ID: 's' }, tmpDir('cloudpilot-cwd-')), false);
});

test('an untracked session (started in the desktop app or on the web) is found through the link Claude Code puts in its PR', async () => {
  const body = `Summary\n\nhttps://claude.ai/code/${S2}\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`;
  assert.equal(sessionFromBody(body).sessionId, S2);
  assert.equal(sessionFromBody('see https://claude.ai/code/session_x and https://example.com/code/session_01AbCdEfGh12345678'), null);
  assert.equal(sessionFromBody(`old https://claude.ai/code/${S1} new https://claude.ai/code/${S2}`).sessionId, S2, 'the last link wins');
  assert.equal(sessionFromBody(undefined), null);
  const calls = [];
  const api = async () => ({ head: { ref: 'claude/untracked' }, body });
  const r = await nudge({ repo: REPO, pr: PR, id: ID }, { env: { CLAUDE_CONFIG_DIR: 'cfg-dir-me' }, tracked: [], api, run: okRun(calls), claude });
  assert.deepEqual([r.sent, r.found_in], [true, 'pr-body']);
  assert.equal(calls[0].args.at(-1), S2);
  assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, 'cfg-dir-me', 'runs as the current account');
});

test('one account and no CLAUDE_CONFIG_DIR: the nudge runs claude with the environment as it is', async () => {
  const calls = [];
  const r = await nudge({ repo: REPO, pr: PR, id: ID }, { env: { HOME: 'h' }, tracked: [track({ owner: { account: 'default' } })], run: okRun(calls), claude });
  assert.equal(r.sent, true);
  assert.equal('CLAUDE_CONFIG_DIR' in calls[0].env, false);
});
