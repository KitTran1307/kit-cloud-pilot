// index.mjs: the `channel` command dispatcher, run in process and as a real command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, HELP } from '../index.mjs';
import * as hub from '../../hub/lib/asks.mjs';
import { questionSha256 } from '../cloud/channel.mjs';
import { T0, MIN, REPO, PR, ID, QUESTION, CHANNEL_DIR, tmpDir, fakeRepo, askC, fakeGithub, clockDeps, capture, iso, walk } from './helpers.mjs';

const keyEnv = () => ({ CLOUD_PILOT_KEY_DIR: path.join(tmpDir('cloudpilot-keys-'), 'keys') });
const idArgs = ['--repo', REPO, '--pr', String(PR), '--id', ID];

test('main is an async function taking argv and returning a number', async () => {
  assert.equal(typeof main, 'function');
  const result = main(['--help'], { out: () => {} });
  assert.ok(result instanceof Promise);
  assert.equal(typeof (await result), 'number');
});

test('--help lists every command and the settings; no arguments prints it too, with exit 1', async () => {
  const cap = capture();
  assert.equal(await main(['--help'], { out: cap.out }), 0);
  assert.equal(cap.lines.join('\n'), HELP);
  for (const verb of ['keygen', 'fingerprint', 'setup', 'ask', 'wait', 'answer']) assert.match(HELP, new RegExp(`\\n  ${verb}`), verb);
  for (const name of ['CLOUD_PILOT_KEY_DIR', 'CLOUD_PILOT_PRIVATE_KEY', 'CLOUD_PILOT_ASK_AUTHORS']) assert.match(HELP, new RegExp(name), name);
  const none = capture();
  assert.equal(await main([], { out: none.out }), 1);
  assert.equal(none.lines.join('\n'), HELP);
  assert.equal(await main(['help'], { out: capture().out }), 0);
  assert.equal(await main(['-h'], { out: capture().out }), 0);
});

test('every command answers --help with its own usage and exit 0', async () => {
  const expected = { keygen: /^usage: keygen/, fingerprint: /^usage: fingerprint/, setup: /^usage: setup/, ask: /^usage: channel\.mjs/, wait: /^usage: channel\.mjs/, answer: /^usage: answer/ };
  for (const [verb, re] of Object.entries(expected)) {
    const cap = capture();
    assert.equal(await main([verb, '--help'], { out: cap.out }), 0, verb);
    assert.match(cap.lines[0], re, verb);
  }
});

test('an unknown command prints one JSON usage line and exits 1; a leading "channel" is accepted', async () => {
  const cap = capture();
  assert.equal(await main(['frobnicate'], { out: cap.out }), 1);
  assert.equal(cap.json()[0].status, 'usage');
  assert.match(cap.json()[0].message, /unknown command "frobnicate"/);
  const withPrefix = capture();
  assert.equal(await main(['channel', '--help'], { out: withPrefix.out }), 0);
  assert.equal(withPrefix.lines.join('\n'), HELP);
  const fp = capture();
  assert.equal(await main(['channel', 'fingerprint'], { env: keyEnv(), out: fp.out }), 1, 'dispatches past the prefix (no key here, so an error)');
  assert.match(fp.json()[0].message, /no key found/);
});

test('keygen, fingerprint and setup work end to end through main', async () => {
  const env = keyEnv();
  const generated = capture();
  assert.equal(await main(['keygen'], { env, out: generated.out }), 0);
  const [g] = generated.json();
  assert.equal(g.status, 'created');
  const printed = capture();
  assert.equal(await main(['fingerprint'], { env, out: printed.out }), 0);
  assert.equal(printed.json()[0].public_fingerprint_sha256, g.public_fingerprint_sha256);
  const repo = fakeRepo();
  const dry = capture();
  assert.equal(await main(['setup', repo], { env, out: dry.out }), 0);
  assert.equal(dry.json()[0].status, 'dry-run');
  assert.equal(fs.existsSync(path.join(repo, '.claude')), false);
  const wrote = capture();
  assert.equal(await main(['setup', repo, '--write'], { env, out: wrote.out }), 0);
  assert.equal(wrote.json()[0].status, 'written');
  assert.equal(wrote.json()[0].fingerprint, g.public_fingerprint_sha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'cloud', 'channel.json'), 'utf8')), { fingerprint: g.public_fingerprint_sha256 });
});

test('the whole loop through main: keygen, a cloud ask, a local answer, a wait that sees it, and the hub agrees', async () => {
  const env = keyEnv();
  assert.equal(await main(['keygen'], { env, out: () => {} }), 0);
  const gh = fakeGithub([]);
  // the cloud session asks
  const asked = capture();
  assert.equal(await main(['ask', ...idArgs, '--text', QUESTION], { env, out: asked.out, api: gh.api, now: () => T0 }), 0);
  assert.equal(asked.json()[0].status, 'asked');
  const askComment = { ...gh.comments[0], id: 100, created_at: iso(T0), updated_at: iso(T0), user: { login: 'cloud-bot' } };
  gh.comments[0] = askComment;
  // the local session answers
  const answered = capture();
  const code = await main(
    ['answer', ...idArgs, '--question-sha256', questionSha256(QUESTION), '--answer', 'ship it'],
    { env, out: answered.out, errOut: () => {}, api: gh.api, now: () => T0 + MIN, account: () => 'tester' },
  );
  assert.equal(code, 0, answered.lines.join('\n'));
  assert.equal(answered.json()[0].status, 'posted');
  gh.comments[1] = { ...gh.comments[1], created_at: iso(T0 + MIN), updated_at: iso(T0 + MIN) };
  // the cloud session's wait sees it (here with the local public key; in the cloud it is the shipped key and pin)
  const waited = capture();
  assert.equal(await main(['wait', ...idArgs], { env, out: waited.out, ...clockDeps(gh, T0 + 5 * MIN) }), 0);
  assert.deepEqual(waited.json()[0], { status: 'answered', id: ID, authority: 'local-session', answer: 'ship it' });
  // the hub's read side counts it as answered with the same public key
  const publicKey = crypto.createPublicKey(fs.readFileSync(path.join(env.CLOUD_PILOT_KEY_DIR, 'ed25519-public.pem')));
  assert.deepEqual(hub.pendingQuestions(gh.comments, { repo: REPO, pr: PR, publicKey, nowMs: T0 + 5 * MIN }), []);
  assert.equal(hub.pendingQuestions([askComment], { repo: REPO, pr: PR, publicKey, nowMs: T0 + 5 * MIN }).length, 1);
});

test('wait through main without a key at all prints a clear error and exit 2', async () => {
  const waited = capture();
  const gh = fakeGithub([askC(100, T0)]);
  assert.equal(await main(['wait', ...idArgs], { env: keyEnv(), out: waited.out, ...clockDeps(gh, T0 + MIN) }), 2);
  assert.match(waited.json()[0].message, /no key found/);
});

test('answer through main --dry-run needs no key and posts nothing', async () => {
  const gh = fakeGithub([askC(100, T0)]);
  const cap = capture();
  const code = await main(
    ['answer', ...idArgs, '--question-sha256', questionSha256(QUESTION), '--answer', 'yes', '--dry-run'],
    { env: keyEnv(), out: cap.out, errOut: () => {}, api: gh.api, account: () => 'tester' },
  );
  assert.equal(code, 0);
  assert.equal(cap.json()[0].status, 'dry-run');
  assert.equal(gh.posts.length, 0);
});

// ---- as real commands ----

const node = (script, args, env = {}) => spawnSync(process.execPath, [path.join(CHANNEL_DIR, script), ...args], {
  encoding: 'utf8', env: { ...process.env, CLOUD_PILOT_PRIVATE_KEY: '', CLOUD_PILOT_KEY_DIR: '', KIT_HUB_KEY_DIR: '', ...env },
});

test('node channel/index.mjs runs the dispatcher: help on stdout, exit codes as returned', () => {
  const help = node('index.mjs', ['--help']);
  assert.equal(help.status, 0);
  assert.equal(help.stdout.trim(), HELP);
  const unknown = node('index.mjs', ['nope']);
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stdout).status, 'usage');
});

test('keygen and fingerprint as real commands: one JSON line, the key lands in CLOUD_PILOT_KEY_DIR, no key material on stdout or stderr', () => {
  const dir = path.join(tmpDir(), 'keys');
  const env = { CLOUD_PILOT_KEY_DIR: dir };
  const made = node('index.mjs', ['keygen'], env);
  assert.equal(made.status, 0, made.stderr);
  const created = JSON.parse(made.stdout);
  assert.equal(created.private_key, path.join(dir, 'ed25519-private.pem'));
  assert.ok(fs.existsSync(created.private_key));
  assert.doesNotMatch(made.stdout + made.stderr, /BEGIN|PRIVATE KEY/);
  const fp = node('index.mjs', ['fingerprint'], env);
  assert.equal(fp.status, 0);
  assert.equal(JSON.parse(fp.stdout).public_fingerprint_sha256, created.public_fingerprint_sha256);
  const again = node('index.mjs', ['keygen'], env);
  assert.equal(again.status, 1);
  assert.match(JSON.parse(again.stdout).message, /already exists/);
});

test('the other entry points also run directly: keys.mjs, setup.mjs, answer.mjs', () => {
  const dir = path.join(tmpDir(), 'keys');
  const env = { CLOUD_PILOT_KEY_DIR: dir };
  assert.equal(node('keys.mjs', ['keygen'], env).status, 0);
  assert.equal(node('keys.mjs', ['fingerprint'], env).status, 0);
  const repo = fakeRepo();
  const dry = node('setup.mjs', [repo], env);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).status, 'dry-run');
  const help = node('answer.mjs', ['--help'], env);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: answer /);
  assert.equal(node('keys.mjs', ['bogus'], env).status, 1);
});

test('no stray files: the channel folder holds exactly the documented layout', () => {
  const rel = walk(CHANNEL_DIR).map((f) => path.relative(CHANNEL_DIR, f).split(path.sep).join('/')).sort();
  for (const file of ['README.md', 'answer.mjs', 'cloud/channel.mjs', 'index.mjs', 'keys.mjs', 'setup.mjs', 'tests/fixtures/legacy-signed.json']) assert.ok(rel.includes(file), file);
  assert.equal(rel.some((f) => f.startsWith('legacy/')), false, 'the legacy copies are gone');
  assert.equal(rel.some((f) => /\.pem$/.test(f)), false, 'no key files in the repository');
});
