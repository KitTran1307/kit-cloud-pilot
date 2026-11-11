// answer.mjs, the local side: it re-reads the ask, refuses agent-config PRs, signs and posts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { questionSha256, parseAnswerBlocks } from '../cloud/channel.mjs';
import { answer, parseArgs as parseAnswerArgs, runAnswer, questions, runQuestions } from '../answer.mjs';
import {
  T0, MIN, HOUR, REPO, PR, ID, HEAD, QUESTION, KEYS, iso, tmpDir, fakeRepo, askC, fakeGithub, verified, capture,
} from './helpers.mjs';

const SHA = questionSha256(QUESTION);
const answerArgs = (...extra) => ['--repo', REPO, '--pr', '7', '--id', ID, '--answer', 'yes, deploy', '--question-sha256', SHA, ...extra];
const answerOpts = (over = {}) => ({
  repo: REPO, pr: 7, id: ID, answer: 'yes, deploy', questionSha256: SHA, validHours: 24, dryRun: false, askAuthors: null, ...over,
});

test('answer.mjs signs for the ask id, posts one comment, and its output verifies with the public key', async () => {
  const gh = fakeGithub([askC(100, T0, ID, QUESTION)]);
  const opts = parseAnswerArgs(answerArgs('--valid-hours', '2'), {});
  const r = await answer(opts, { api: gh.api, privateKey: KEYS.privateKey, now: () => T0 + MIN });
  assert.equal(r.status, 'posted');
  assert.equal(r.untrusted_question, QUESTION);
  assert.equal(r.authority, 'local-session');
  assert.equal(r.head_sha, HEAD);
  assert.equal(r.ask_comment_id, 100);
  assert.equal(r.question_sha256, SHA);
  assert.equal(gh.posts.length, 1);
  const hit = verified(gh.comments.map((c) => (c.id === 100 ? c : { ...c, created_at: iso(T0 + MIN) })), T0 + 5 * MIN);
  assert.equal(hit.answer, 'yes, deploy');
  assert.ok(gh.state.calls.includes(`repos/${REPO}/pulls/${PR}`), 'the PR head is read through gh');
  assert.equal(hit.authority, 'local-session');
  assert.equal(hit.expiresAt, iso(T0 + MIN + 2 * HOUR));
});

test('answer.mjs has no --authority and no --owner-quote (owner-chat is gone)', () => {
  assert.throws(() => parseAnswerArgs([...answerArgs(), '--authority', 'local-session'], {}), /unknown option --authority/);
  assert.throws(() => parseAnswerArgs([...answerArgs(), '--authority', 'owner-chat', '--owner-quote', 'ok'], {}), /unknown option/);
  assert.throws(() => parseAnswerArgs([...answerArgs(), '--owner-quote', 'I said so'], {}), /unknown option --owner-quote/);
  const opts = parseAnswerArgs(answerArgs(), {});
  assert.equal('authority' in opts, false);
  assert.equal('ownerQuote' in opts, false);
});

test('H2: answer.mjs requires --question-sha256 as 64 hex characters', () => {
  assert.throws(() => parseAnswerArgs(answerArgs().filter((a, i, all) => a !== '--question-sha256' && all[i - 1] !== '--question-sha256'), {}), /--question-sha256/);
  assert.throws(() => parseAnswerArgs(answerArgs().map((a) => (a === SHA ? 'abc123' : a)), {}), /--question-sha256/);
  assert.equal(parseAnswerArgs(answerArgs().map((a) => (a === SHA ? SHA.toUpperCase() : a)), {}).questionSha256, SHA);
});

test('answer.mjs signs a v3 payload: fixed local-session authority, no owner quote, ask binding and the current PR head', async () => {
  const gh = fakeGithub([askC(100, T0)], { headSha: 'c3'.repeat(20) });
  await answer(answerOpts(), { api: gh.api, privateKey: KEYS.privateKey, now: () => T0 + MIN });
  const [block] = parseAnswerBlocks(gh.posts[0].body.body);
  const payload = JSON.parse(Buffer.from(block.payloadB64, 'base64url').toString());
  assert.equal(payload.v, 3);
  assert.equal(payload.authority, 'local-session');
  assert.equal('owner_quote' in payload, false);
  assert.equal(payload.ask_comment_id, 100);
  assert.equal(payload.question_sha256, SHA);
  assert.equal(payload.head_sha, 'c3'.repeat(20));
  assert.deepEqual(Object.keys(payload), ['v', 'repo', 'pr', 'id', 'ask_comment_id', 'question_sha256', 'head_sha', 'answer', 'authority', 'issued_at', 'expires_at']);
});

test('N6: answer.mjs refuses when the PR head cannot be read or is not a sha; a dry run shows the head', async () => {
  const noHead = fakeGithub([askC(100, T0)], { headSha: null });
  await assert.rejects(answer(answerOpts(), { api: noHead.api, privateKey: KEYS.privateKey }), /head/);
  assert.equal(noHead.posts.length, 0);
  const odd = fakeGithub([askC(100, T0)], { headSha: 'main' });
  await assert.rejects(answer(answerOpts(), { api: odd.api, privateKey: KEYS.privateKey }), /head/);
  const dry = await answer(answerOpts({ dryRun: true }), { api: fakeGithub([askC(100, T0)]).api, privateKey: KEYS.privateKey });
  assert.equal(dry.head_sha, HEAD);
});

test('answer.mjs refuses an id with no ask, and a dry run posts nothing', async () => {
  const gh = fakeGithub([askC(100, T0)]);
  await assert.rejects(answer(answerOpts({ id: 'no-such-id' }), { api: gh.api, privateKey: KEYS.privateKey }), /no channel ask/);
  const dry = await answer(answerOpts({ dryRun: true }), { api: gh.api, privateKey: KEYS.privateKey });
  assert.equal(dry.status, 'dry-run');
  assert.equal(gh.posts.length, 0);
});

test('H2/M1: answer.mjs refuses an edited ask and a question hash that does not match the current text', async () => {
  const edited = fakeGithub([askC(100, T0, ID, QUESTION, { updatedMs: T0 + MIN })]);
  await assert.rejects(answer(answerOpts(), { api: edited.api, privateKey: KEYS.privateKey }), /edited/);
  assert.equal(edited.posts.length, 0);
  const changed = fakeGithub([askC(100, T0, ID, 'Deploy now and wipe prod?')]);
  await assert.rejects(answer(answerOpts(), { api: changed.api, privateKey: KEYS.privateKey }), /question/);
  assert.equal(changed.posts.length, 0);
});

test('M2: answer.mjs ignores asks from anyone but the PR author or --ask-authors', async () => {
  const stranger = fakeGithub([askC(100, T0, ID, QUESTION, { author: 'stranger' })]);
  await assert.rejects(answer(answerOpts(), { api: stranger.api, privateKey: KEYS.privateKey }), /no channel ask/);
  const allowed = await answer(answerOpts({ askAuthors: ['stranger'] }), { api: stranger.api, privateKey: KEYS.privateKey, now: () => T0 + MIN });
  assert.equal(allowed.status, 'posted');
  const noAuthor = fakeGithub([askC(100, T0)], { prAuthor: null });
  await assert.rejects(answer(answerOpts(), { api: noAuthor.api, privateKey: KEYS.privateKey }), /no channel ask|author/);
});

test('M3: answer.mjs refuses a PR that touches agent config, or whose file list cannot be read', async () => {
  for (const files of [['src/a.ts', '.claude/settings.json'], ['website/CLAUDE.md'], ['.github/workflows/x.yml'], ['.githooks/pre-commit'], ['.agents/x'], ['.codex/x'],
    ['.mcp.json'], ['a/.mcp.json'], ['.husky/pre-commit'], ['.vscode/tasks.json'], ['.devcontainer/devcontainer.json'], ['.cursor/rules/x.mdc'], ['GEMINI.md'], ['pkg/GEMINI.md']]) {
    const gh = fakeGithub([askC(100, T0)], { files });
    await assert.rejects(answer(answerOpts(), { api: gh.api, privateKey: KEYS.privateKey }), /agent|automation/, files.join());
    assert.equal(gh.posts.length, 0);
  }
  const broken = fakeGithub([askC(100, T0)], { filesError: true });
  await assert.rejects(answer(answerOpts(), { api: broken.api, privateKey: KEYS.privateKey }), /files/);
  const fine = fakeGithub([askC(100, T0)], { files: ['src/a.ts', 'docs/CLAUDE-notes.md'] });
  assert.equal((await answer(answerOpts(), { api: fine.api, privateKey: KEYS.privateKey, now: () => T0 + MIN })).status, 'posted');
});

test('answer.mjs refuses a PR with more files than GitHub will list (the list may hide agent config)', async () => {
  const gh = fakeGithub([askC(100, T0)], { files: Array.from({ length: 3001 }, (_, i) => `src/f${i}.ts`) });
  await assert.rejects(answer(answerOpts(), { api: gh.api, privateKey: KEYS.privateKey }), /too many files/);
  assert.equal(gh.posts.length, 0);
});

test('answer.mjs reads the PR head first and lists the changed files against the repository default branch, not the PR base branch', async () => {
  const OTHER_HEAD = 'b2'.repeat(20);
  // a PR whose own base branch already carries an agent-config change: only the default-branch comparison still shows it
  const stacked = fakeGithub([askC(100, T0)], { files: ['src/a.ts', '.claude/cloud/channel.mjs'], defaultBranch: 'release/9', baseRef: 'feature-x', headSha: OTHER_HEAD });
  await assert.rejects(answer(answerOpts(), { api: stacked.api, privateKey: KEYS.privateKey }), /agent|automation/);
  assert.equal(stacked.posts.length, 0);
  assert.equal(stacked.state.calls[0], `repos/${REPO}/pulls/${PR}`, 'the PR head is the first thing read');
  assert.ok(stacked.state.calls.includes(`repos/${REPO}/compare/release/9...${OTHER_HEAD}?per_page=100&page=1`), stacked.state.calls.join('\n'));
  assert.equal(stacked.state.calls.some((c) => c.includes('/pulls/7/files') || c.includes('feature-x')), false, 'never the PR files or the PR base branch');
  const clean = fakeGithub([askC(100, T0)], { files: ['src/a.ts'], defaultBranch: 'release/9', baseRef: 'feature-x' });
  assert.equal((await answer(answerOpts(), { api: clean.api, privateKey: KEYS.privateKey, now: () => T0 + MIN })).status, 'posted');
  const order = clean.state.calls;
  assert.ok(order.indexOf(`repos/${REPO}/pulls/${PR}`) < order.findIndex((c) => c.includes('/compare/')), 'head read before the file list');
  assert.ok(order.findIndex((c) => c.includes('/compare/')) < order.findIndex((c) => c.includes('/comments?')), 'file list before the comments');
});

test('answer.mjs refuses a PR whose default branch cannot be read (the comparison would be against nothing)', async () => {
  const gh = fakeGithub([askC(100, T0)], { defaultBranch: null });
  await assert.rejects(answer(answerOpts(), { api: gh.api, privateKey: KEYS.privateKey }), /default branch/);
  assert.equal(gh.posts.length, 0);
});

test('answer.mjs re-reads the PR head right before signing and refuses with "run again" when it moved; a dry run signs nothing', async () => {
  const gh = fakeGithub([askC(100, T0)]);
  let prReads = 0;
  const moving = async (p, body) => {
    const result = await gh.api(p, body);
    if (p === `repos/${REPO}/pulls/${PR}`) { prReads += 1; if (prReads === 1) gh.state.headSha = 'b2'.repeat(20); }
    return result;
  };
  await assert.rejects(answer(answerOpts(), { api: moving, privateKey: KEYS.privateKey, now: () => T0 + MIN }), /PR changed while answering; run again/);
  assert.equal(prReads, 2, 'the head is read again before signing');
  assert.equal(gh.posts.length, 0, 'nothing signed or posted');
  assert.ok(gh.state.calls.some((c) => c.includes(`compare/main...${HEAD}`)), 'the files were listed for the head that was read first');
  const still = fakeGithub([askC(100, T0)]);
  assert.equal((await answer(answerOpts(), { api: still.api, privateKey: KEYS.privateKey, now: () => T0 + MIN })).status, 'posted');
});

test('answer.mjs refuses fork PRs: a head repository that is null or differs (ignoring case) from the base repository', async () => {
  for (const headRepo of ['mallory/app', 'acme/app-fork', null]) {
    const gh = fakeGithub([askC(100, T0)], { headRepo });
    await assert.rejects(answer(answerOpts(), { api: gh.api, privateKey: KEYS.privateKey }), /fork/, String(headRepo));
    await assert.rejects(answer(answerOpts({ dryRun: true }), { api: gh.api }), /fork/, `dry run ${headRepo}`);
    assert.equal(gh.posts.length, 0);
  }
  const same = fakeGithub([askC(100, T0)], { headRepo: 'ACME/App' });
  assert.equal((await answer(answerOpts(), { api: same.api, privateKey: KEYS.privateKey, now: () => T0 + MIN })).status, 'posted');
});

test('answer.mjs bad arguments fail', () => {
  assert.throws(() => parseAnswerArgs(answerArgs('--valid-hours', '500'), {}), /valid-hours/);
  assert.throws(() => parseAnswerArgs(answerArgs('--valid-hours', '0'), {}), /valid-hours/);
  assert.throws(() => parseAnswerArgs(answerArgs().map((a) => (a === 'yes, deploy' ? '' : a)), {}), /--answer/);
  assert.throws(() => parseAnswerArgs(answerArgs().map((a) => (a === 'yes, deploy' ? 'x'.repeat(4001) : a)), {}), /--answer/);
  assert.throws(() => parseAnswerArgs(answerArgs('--bogus', '1'), {}), /unknown option/);
  assert.equal(parseAnswerArgs(answerArgs(), {}).validHours, 24);
  assert.equal(parseAnswerArgs(answerArgs(), {}).askAuthors, null);
  assert.deepEqual(parseAnswerArgs(answerArgs('--ask-authors', 'Bot-1'), {}).askAuthors, ['bot-1']);
  assert.deepEqual(parseAnswerArgs(answerArgs(), { CLOUD_PILOT_ASK_AUTHORS: 'x1,y2' }).askAuthors, ['x1', 'y2']);
  assert.deepEqual(parseAnswerArgs(answerArgs(), { KIT_CHANNEL_ASK_AUTHORS: 'x1,y2' }).askAuthors, ['x1', 'y2']);
  assert.equal(parseAnswerArgs(answerArgs('--dry-run'), {}).dryRun, true);
});

// ---- the private key: key dir, CLOUD_PILOT_PRIVATE_KEY, never printed ----

const privatePem = () => KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' });
const keyBody = () => privatePem().split('\n').filter((l) => l && !l.startsWith('-----')).join('');
const cliDeps = (gh, env, cap) => ({ env, out: cap.out, errOut: () => {}, api: gh.api, now: () => T0 + MIN, account: () => 'tester' });

test('runAnswer loads the private key from CLOUD_PILOT_KEY_DIR, posts a verifiable answer and never prints the key', async () => {
  const dir = tmpDir('cloudpilot-keys-');
  fs.writeFileSync(path.join(dir, 'ed25519-private.pem'), privatePem());
  const gh = fakeGithub([askC(100, T0)]);
  const cap = capture();
  const code = await runAnswer(answerArgs(), cliDeps(gh, { CLOUD_PILOT_KEY_DIR: dir }, cap));
  assert.equal(code, 0);
  assert.equal(cap.json()[0].status, 'posted');
  assert.equal(verified(gh.comments.map((c) => (c.id === 100 ? c : { ...c, created_at: iso(T0 + MIN) })), T0 + 5 * MIN).answer, 'yes, deploy');
  const everything = cap.lines.join('\n') + gh.posts.map((p) => p.body.body).join('\n');
  assert.equal(everything.includes(keyBody()), false);
  assert.doesNotMatch(everything, /PRIVATE KEY/);
});

test('CLOUD_PILOT_PRIVATE_KEY points at an existing PEM anywhere, and beats the key dir', async () => {
  const where = tmpDir('cloudpilot-mykey-');
  const mine = path.join(where, 'my-existing-key.pem');
  fs.writeFileSync(mine, privatePem());
  const emptyDir = tmpDir('cloudpilot-keys-');
  const gh = fakeGithub([askC(100, T0)]);
  const cap = capture();
  const code = await runAnswer(answerArgs(), cliDeps(gh, { CLOUD_PILOT_PRIVATE_KEY: mine, CLOUD_PILOT_KEY_DIR: emptyDir }, cap));
  assert.equal(code, 0, cap.lines.join('\n'));
  assert.equal(cap.json()[0].status, 'posted');
  assert.equal(verified(gh.comments.map((c) => (c.id === 100 ? c : { ...c, created_at: iso(T0 + MIN) })), T0 + 5 * MIN).answer, 'yes, deploy');
});

test('runAnswer without a private key says where it looked, posts nothing and prints no key', async () => {
  const dir = tmpDir('cloudpilot-keys-');
  const gh = fakeGithub([askC(100, T0)]);
  const cap = capture();
  const code = await runAnswer(answerArgs(), cliDeps(gh, { CLOUD_PILOT_KEY_DIR: dir }, cap));
  assert.equal(code, 1);
  const [line] = cap.json();
  assert.equal(line.status, 'error');
  assert.match(line.message, /no private key at/);
  assert.ok(line.message.includes(path.join(dir, 'ed25519-private.pem')));
  assert.equal(gh.posts.length, 0);
});

test('runAnswer refuses a key file that is not an Ed25519 private key, without echoing its content', async () => {
  const dir = tmpDir('cloudpilot-keys-');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(path.join(dir, 'ed25519-private.pem'), rsa);
  const cap = capture();
  assert.equal(await runAnswer(answerArgs(), cliDeps(fakeGithub([askC(100, T0)]), { CLOUD_PILOT_KEY_DIR: dir }, cap)), 1);
  assert.match(cap.json()[0].message, /not an Ed25519 key/);
  fs.writeFileSync(path.join(dir, 'ed25519-private.pem'), 'this is not a key');
  const cap2 = capture();
  assert.equal(await runAnswer(answerArgs(), cliDeps(fakeGithub([askC(100, T0)]), { CLOUD_PILOT_KEY_DIR: dir }, cap2)), 1);
  assert.match(cap2.json()[0].message, /not a readable/);
  assert.equal(cap2.lines.join('\n').includes('this is not a key'), false);
});

test('runAnswer refuses a private key that sits inside a git working tree, says so, signs and posts nothing', async () => {
  const repo = fakeRepo();
  const inside = path.join(repo, 'key.pem');
  fs.writeFileSync(inside, privatePem());
  const gh = fakeGithub([askC(100, T0)]);
  const cap = capture();
  assert.equal(await runAnswer(answerArgs(), cliDeps(gh, { CLOUD_PILOT_PRIVATE_KEY: inside }, cap)), 1);
  const [line] = cap.json();
  assert.equal(line.status, 'error');
  assert.match(line.message, /refusing to use the private key at .*inside a git working tree/);
  assert.equal(cap.lines.join('\n').includes(keyBody()), false);
  assert.equal(gh.posts.length, 0);
});

test('a dry run needs no private key and posts nothing', async () => {
  const dir = tmpDir('cloudpilot-keys-');
  const gh = fakeGithub([askC(100, T0)]);
  const cap = capture();
  const code = await runAnswer(answerArgs('--dry-run'), cliDeps(gh, { CLOUD_PILOT_KEY_DIR: dir }, cap));
  assert.equal(code, 0);
  assert.equal(cap.json()[0].status, 'dry-run');
  assert.equal(gh.posts.length, 0);
});

test('answer without a key never posts an unsigned comment', async () => {
  const gh = fakeGithub([askC(100, T0)]);
  await assert.rejects(answer(answerOpts(), { api: gh.api }), /no private key/);
  assert.equal(gh.posts.length, 0);
});

test('runAnswer reports bad arguments as one JSON error line with exit 1; --help prints the usage', async () => {
  const cap = capture();
  assert.equal(await runAnswer(['--repo', 'bad'], { out: cap.out, errOut: () => {}, account: () => 'tester' }), 1);
  assert.equal(cap.json()[0].status, 'error');
  const help = capture();
  assert.equal(await runAnswer(['--help'], { out: help.out }), 0);
  assert.match(help.lines[0], /^usage: answer /);
});

test('runAnswer shows which gh account is in use on stderr', async () => {
  const dir = tmpDir('cloudpilot-keys-');
  fs.writeFileSync(path.join(dir, 'ed25519-private.pem'), privatePem());
  const seen = [];
  const deps = { ...cliDeps(fakeGithub([askC(100, T0)]), { CLOUD_PILOT_KEY_DIR: dir }, capture()), errOut: (l) => seen.push(l) };
  await runAnswer(answerArgs(), deps);
  assert.deepEqual(seen, ['gh account in use: tester (repo owner: acme)']);
});

test('questions lists the open asks with the hash answer needs; --all also the answered ones; a wrong hash points to it', async () => {
  const gh = fakeGithub([askC(100, T0, ID, QUESTION), askC(101, T0 + MIN, 'pick-db', 'Postgres or SQLite?')]);
  await answer(answerOpts(), { api: gh.api, privateKey: KEYS.privateKey, now: () => T0 + 2 * MIN });
  const open = await questions({ repo: REPO, pr: 7, all: false, askAuthors: null }, { api: gh.api, publicKey: KEYS.publicKey, now: () => T0 + 3 * MIN });
  assert.deepEqual(open.questions.map((q) => [q.id, q.answered]), [['pick-db', false]]);
  assert.equal(open.questions[0].question_sha256, questionSha256('Postgres or SQLite?'));
  assert.equal(open.questions[0].untrusted_question, 'Postgres or SQLite?');
  const all = await questions({ repo: REPO, pr: 7, all: true, askAuthors: null }, { api: gh.api, publicKey: KEYS.publicKey, now: () => T0 + 3 * MIN });
  assert.deepEqual(all.questions.map((q) => [q.id, q.answered]), [[ID, true], ['pick-db', false]]);
  const noKey = await questions({ repo: REPO, pr: 7, all: false, askAuthors: null }, { api: gh.api, now: () => T0 + 3 * MIN });
  assert.equal(noKey.questions.length, 2);
  assert.equal(noKey.questions[0].answered, null);
  assert.equal(gh.posts.length, 1, 'questions posts nothing');
  await assert.rejects(answer(answerOpts({ questionSha256: 'f'.repeat(64) }), { api: gh.api, privateKey: KEYS.privateKey, now: () => T0 + 4 * MIN }),
    /cloud-pilot questions --repo acme\/app --pr 7/);
  const lines = [];
  assert.equal(await runQuestions(['--repo', REPO, '--pr', '7'], { api: gh.api, out: (l) => lines.push(l), loadPublicKey: () => KEYS.publicKey, now: () => T0 + 3 * MIN }), 0);
  assert.equal(JSON.parse(lines[0]).questions.length, 1);
  assert.equal(await runQuestions(['--repo', REPO], { out: (l) => lines.push(l) }), 1);
});
