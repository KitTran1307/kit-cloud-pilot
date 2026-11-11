// keys.mjs: Ed25519 key generation, where keys live, and the refusal to put a private key in a repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  keygen, fingerprint, assertSafePrivatePath, findGitRoot, keyDir, privateKeyPath, publicKeyPath, defaultKeyDir, loadLocalPrivateKey,
  localPublicKeyPem, runKeygen, runFingerprint, PILOT_ROOT, PRIVATE_KEY_NAME, PUBLIC_KEY_NAME,
} from '../keys.mjs';
import { loadPublicKey } from '../cloud/channel.mjs';
import { tmpDir, fakeRepo, capture, KEYS, publicPem, PILOT_ROOT as HELPER_PILOT_ROOT } from './helpers.mjs';

const privatePem = (key = KEYS.privateKey) => key.export({ type: 'pkcs8', format: 'pem' });

test('keygen creates a pair, the public half verifies the private half, and a second run refuses to overwrite', () => {
  const dir = path.join(tmpDir(), 'keys');
  const env = { CLOUD_PILOT_KEY_DIR: dir };
  const r = keygen({ env });
  assert.equal(r.privatePath, path.join(dir, PRIVATE_KEY_NAME));
  assert.equal(r.publicPath, path.join(dir, PUBLIC_KEY_NAME));
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(r.fingerprint, fingerprint(fs.readFileSync(r.publicPath)));
  const sig = crypto.sign(null, Buffer.from('x'), loadLocalPrivateKey(env));
  assert.equal(crypto.verify(null, Buffer.from('x'), loadPublicKey(r.publicPath), sig), true);
  const before = fs.readFileSync(r.privatePath, 'utf8');
  assert.throws(() => keygen({ env }), /already exists/);
  assert.equal(fs.readFileSync(r.privatePath, 'utf8'), before, 'a refused run leaves the key untouched');
  fs.rmSync(r.publicPath);
  assert.throws(() => keygen({ env }), /already exists/, 'an existing private key alone is enough to refuse');
  assert.equal(fs.readFileSync(r.privatePath, 'utf8'), before);
  assert.notEqual(keygen({ env, force: true }).fingerprint, r.fingerprint, '--force makes a new pair');
});

test('the private key is a PKCS8 PEM Ed25519 key and the public key an SPKI PEM; neither holds the other', () => {
  const env = { CLOUD_PILOT_KEY_DIR: path.join(tmpDir(), 'k') };
  const r = keygen({ env });
  const priv = fs.readFileSync(r.privatePath, 'utf8');
  const pub = fs.readFileSync(r.publicPath, 'utf8');
  assert.match(priv, /^-----BEGIN PRIVATE KEY-----/);
  assert.match(pub, /^-----BEGIN PUBLIC KEY-----/);
  assert.doesNotMatch(pub, /PRIVATE/);
  assert.equal(crypto.createPrivateKey(priv).asymmetricKeyType, 'ed25519');
  assert.equal(crypto.createPublicKey(pub).asymmetricKeyType, 'ed25519');
});

test('keygen writes the private key with mode 0600 where the OS supports it', { skip: process.platform === 'win32' ? 'Windows has no POSIX modes' : false }, () => {
  const env = { CLOUD_PILOT_KEY_DIR: path.join(tmpDir(), 'k') };
  const r = keygen({ env });
  assert.equal(fs.statSync(r.privatePath).mode & 0o777, 0o600);
  fs.chmodSync(r.privatePath, 0o644);
  keygen({ env, force: true });
  assert.equal(fs.statSync(r.privatePath).mode & 0o777, 0o600, '--force tightens an existing file too');
});

test('the key dir comes from CLOUD_PILOT_KEY_DIR, else the older KIT_HUB_KEY_DIR, else ~/.cloud-pilot/keys', () => {
  const a = tmpDir();
  const b = tmpDir();
  assert.equal(keyDir({ CLOUD_PILOT_KEY_DIR: a }), a);
  assert.equal(keyDir({ CLOUD_PILOT_KEY_DIR: a, KIT_HUB_KEY_DIR: b }), a, 'the new name wins');
  assert.equal(keyDir({ KIT_HUB_KEY_DIR: b }), b);
  assert.equal(keyDir({ CLOUD_PILOT_KEY_DIR: '' }), defaultKeyDir(), 'empty means unset');
  assert.equal(keyDir({}), path.join(os.homedir(), '.cloud-pilot', 'keys'));
  assert.equal(privateKeyPath({ CLOUD_PILOT_KEY_DIR: a }), path.join(a, 'ed25519-private.pem'));
  assert.equal(publicKeyPath({ CLOUD_PILOT_KEY_DIR: a }), path.join(a, 'ed25519-public.pem'));
});

test('a relative CLOUD_PILOT_KEY_DIR is made absolute', () => {
  const dir = keyDir({ CLOUD_PILOT_KEY_DIR: 'some-keys' });
  assert.ok(path.isAbsolute(dir));
  assert.equal(dir, path.resolve('some-keys'));
});

test('CLOUD_PILOT_PRIVATE_KEY wins over the key dir, and the public key is looked up beside it', () => {
  const where = tmpDir();
  const mine = path.join(where, 'my-key.pem');
  const env = { CLOUD_PILOT_PRIVATE_KEY: mine, CLOUD_PILOT_KEY_DIR: tmpDir() };
  assert.equal(privateKeyPath(env), mine);
  assert.equal(publicKeyPath(env), path.join(where, PUBLIC_KEY_NAME));
});

test('an existing key named by CLOUD_PILOT_PRIVATE_KEY stays where it is: its public key is derived, never moved or rewritten', () => {
  const where = tmpDir();
  const mine = path.join(where, 'my-key.pem');
  fs.writeFileSync(mine, privatePem());
  const before = fs.readFileSync(mine, 'utf8');
  const env = { CLOUD_PILOT_PRIVATE_KEY: mine };
  assert.equal(fingerprint(localPublicKeyPem(env)), fingerprint(KEYS.publicKey));
  assert.equal(loadLocalPrivateKey(env).asymmetricKeyType, 'ed25519');
  assert.equal(fs.readFileSync(mine, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(where), ['my-key.pem'], 'nothing was written beside it');
});

test('a public key file beside the private key is used when it matches, and refused when it belongs to another key', () => {
  const where = tmpDir();
  fs.writeFileSync(path.join(where, PRIVATE_KEY_NAME), privatePem());
  fs.writeFileSync(path.join(where, PUBLIC_KEY_NAME), publicPem());
  const env = { CLOUD_PILOT_KEY_DIR: where };
  assert.equal(fingerprint(localPublicKeyPem(env)), fingerprint(KEYS.publicKey));
  fs.writeFileSync(path.join(where, PUBLIC_KEY_NAME), publicPem(crypto.generateKeyPairSync('ed25519').publicKey));
  assert.throws(() => localPublicKeyPem(env), /does not belong to the private key/);
});

test('a public key file alone (no private key here) is enough to print a fingerprint and to set a repo up', () => {
  const where = tmpDir();
  fs.writeFileSync(path.join(where, PUBLIC_KEY_NAME), publicPem());
  assert.equal(fingerprint(localPublicKeyPem({ CLOUD_PILOT_KEY_DIR: where })), fingerprint(KEYS.publicKey));
  assert.throws(() => localPublicKeyPem({ CLOUD_PILOT_KEY_DIR: tmpDir() }), /no key found/);
});

test('the public key helper always returns a public PEM, even when the file beside it holds a private key', () => {
  const where = tmpDir();
  fs.writeFileSync(path.join(where, PUBLIC_KEY_NAME), privatePem());
  const pem = localPublicKeyPem({ CLOUD_PILOT_KEY_DIR: where });
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----/);
  assert.doesNotMatch(pem, /PRIVATE/);
});

test('fingerprint is the sha256 of the SPKI DER of the public key', () => {
  const der = KEYS.publicKey.export({ type: 'spki', format: 'der' });
  const expected = crypto.createHash('sha256').update(der).digest('hex');
  assert.equal(fingerprint(KEYS.publicKey), expected);
  assert.equal(fingerprint(publicPem()), expected);
  assert.equal(fingerprint(Buffer.from(publicPem())), expected);
});

// ---- never inside a git working tree or the repository itself ----

test('keygen refuses a private key path inside a git working tree (a .git folder at any ancestor)', () => {
  const repo = fakeRepo();
  for (const sub of ['keys', path.join('a', 'b', 'c', 'keys')]) {
    const env = { CLOUD_PILOT_KEY_DIR: path.join(repo, sub) };
    assert.throws(() => keygen({ env }), /inside a git working tree/, sub);
    assert.equal(fs.existsSync(path.join(repo, sub)), false, 'nothing is created');
  }
  assert.throws(() => keygen({ env: { CLOUD_PILOT_KEY_DIR: repo } }), /inside a git working tree/);
  assert.throws(() => keygen({ env: { CLOUD_PILOT_KEY_DIR: path.join(repo, 'k') }, force: true }), /inside a git working tree/);
  assert.deepEqual(fs.readdirSync(repo), ['.git']);
});

test('keygen (also with --force) refuses while CLOUD_PILOT_PRIVATE_KEY is set: it points at a key you already have', () => {
  const where = tmpDir();
  const mine = path.join(where, 'my-key.pem');
  fs.writeFileSync(mine, privatePem());
  const before = fs.readFileSync(mine, 'utf8');
  for (const env of [{ CLOUD_PILOT_PRIVATE_KEY: mine }, { KIT_HUB_PRIVATE_KEY: mine }, { CLOUD_PILOT_PRIVATE_KEY: mine, CLOUD_PILOT_KEY_DIR: path.join(where, 'keys') }]) {
    for (const force of [false, true]) {
      assert.throws(() => keygen({ env, force }), /CLOUD_PILOT_PRIVATE_KEY is set: unset it to generate a new key \(it points at a key you already have\)/, `${JSON.stringify(Object.keys(env))} force=${force}`);
    }
  }
  assert.equal(fs.readFileSync(mine, 'utf8'), before, 'the existing key is untouched');
  assert.deepEqual(fs.readdirSync(where), ['my-key.pem'], 'nothing was written beside it');
  assert.equal(keygen({ env: { CLOUD_PILOT_PRIVATE_KEY: '', CLOUD_PILOT_KEY_DIR: path.join(where, 'keys') } }).privatePath, path.join(where, 'keys', PRIVATE_KEY_NAME), 'an empty value means unset');
});

test('runKeygen reports the CLOUD_PILOT_PRIVATE_KEY refusal as one JSON error line, also with --force', async () => {
  const where = tmpDir();
  const mine = path.join(where, 'my-key.pem');
  fs.writeFileSync(mine, privatePem());
  for (const args of [[], ['--force']]) {
    const cap = capture();
    assert.equal(await runKeygen(args, { env: { CLOUD_PILOT_PRIVATE_KEY: mine }, out: cap.out }), 1);
    assert.equal(cap.json()[0].status, 'error');
    assert.match(cap.json()[0].message, /unset it to generate a new key/);
  }
  assert.deepEqual(fs.readdirSync(where), ['my-key.pem']);
});

test('loading a private key applies the same safe-path rule as keygen: a key inside a git working tree is refused, never read', () => {
  const repo = fakeRepo();
  const inside = path.join(repo, 'secrets', 'k.pem');
  fs.mkdirSync(path.dirname(inside));
  fs.writeFileSync(inside, privatePem());
  for (const env of [{ CLOUD_PILOT_PRIVATE_KEY: inside }, { CLOUD_PILOT_KEY_DIR: path.dirname(inside) }]) {
    const file = privateKeyPath(env);
    if (file !== inside) fs.copyFileSync(inside, file);
    assert.throws(() => loadLocalPrivateKey(env), (err) => /refusing to use the private key at .*inside a git working tree.*outside any repository/s.test(err.message) && err.message.includes(file), JSON.stringify(Object.keys(env)));
    assert.throws(() => localPublicKeyPem(env), /inside a git working tree/);
  }
  const body = privatePem().split('\n').filter((l) => l && !l.startsWith('-----')).join('');
  try { loadLocalPrivateKey({ CLOUD_PILOT_PRIVATE_KEY: inside }); } catch (err) { assert.equal(err.message.includes(body), false, 'the message never holds key material'); }
  // outside any repository it loads as before
  const fine = path.join(tmpDir(), 'k.pem');
  fs.writeFileSync(fine, privatePem());
  assert.equal(loadLocalPrivateKey({ CLOUD_PILOT_PRIVATE_KEY: fine }).asymmetricKeyType, 'ed25519');
});

test('loading a private key from inside the kit-cloud-pilot repository is refused too, even without a .git folder', () => {
  const fakePilot = tmpDir('cloudpilot-zip-');
  const inside = path.join(fakePilot, 'k.pem');
  fs.writeFileSync(inside, privatePem());
  assert.throws(() => loadLocalPrivateKey({ CLOUD_PILOT_PRIVATE_KEY: inside }, { pilotRoot: fakePilot }), /refusing to use the private key at .*kit-cloud-pilot repository/);
  assert.equal(loadLocalPrivateKey({ CLOUD_PILOT_PRIVATE_KEY: inside }, { pilotRoot: tmpDir('cloudpilot-other-') }).asymmetricKeyType, 'ed25519');
});

test('a .git file (worktrees and submodules) counts as a git working tree too', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /somewhere/else\n');
  assert.throws(() => keygen({ env: { CLOUD_PILOT_KEY_DIR: path.join(dir, 'k') } }), /inside a git working tree/);
  // Real paths on both sides: Windows may hand out a short (8.3) temp path, e.g. RUNNER~1.
  assert.equal(findGitRoot(path.join(dir, 'x', 'y')), fs.realpathSync.native(dir));
});

test('findGitRoot finds the nearest .git upward, and null when there is none; .gitignore alone is not a repo', () => {
  const repo = fakeRepo();
  const deep = path.join(repo, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findGitRoot(deep), fs.realpathSync.native(repo));
  assert.equal(findGitRoot(repo), fs.realpathSync.native(repo));
  const plain = tmpDir();
  fs.writeFileSync(path.join(plain, '.gitignore'), '*\n');
  assert.equal(findGitRoot(path.join(plain, 'k')), null);
  assert.doesNotThrow(() => assertSafePrivatePath(path.join(plain, 'k', PRIVATE_KEY_NAME)));
});

test('keygen refuses the kit-cloud-pilot repository itself, even without a .git folder (a zip download)', () => {
  assert.equal(PILOT_ROOT, HELPER_PILOT_ROOT);
  const fakePilot = tmpDir('cloudpilot-zip-');
  assert.throws(() => assertSafePrivatePath(path.join(fakePilot, 'channel', 'k.pem'), { pilotRoot: fakePilot }), /kit-cloud-pilot repository/);
  assert.throws(() => assertSafePrivatePath(fakePilot, { pilotRoot: fakePilot }), /kit-cloud-pilot repository/);
  assert.throws(() => keygen({ env: { CLOUD_PILOT_KEY_DIR: path.join(fakePilot, 'keys') }, pilotRoot: fakePilot }), /kit-cloud-pilot repository/);
  assert.equal(fs.readdirSync(fakePilot).length, 0, 'nothing was written');
  assert.doesNotThrow(() => assertSafePrivatePath(path.join(tmpDir(), 'k.pem'), { pilotRoot: fakePilot }));
  assert.throws(() => assertSafePrivatePath(path.join(PILOT_ROOT, 'channel', 'tests', 'k.pem')), /kit-cloud-pilot repository|git working tree/);
});

test('a sibling folder whose name merely starts like the repository folder is not the repository', () => {
  const parent = tmpDir();
  const pilot = path.join(parent, 'pilot');
  const sibling = path.join(parent, 'pilot-keys');
  fs.mkdirSync(pilot);
  fs.mkdirSync(sibling);
  assert.doesNotThrow(() => assertSafePrivatePath(path.join(sibling, 'k.pem'), { pilotRoot: pilot }));
});

// ---- the command line ----

test('runKeygen prints one JSON line with paths and the public fingerprint, and no key material', async () => {
  const dir = path.join(tmpDir(), 'keys');
  const cap = capture();
  assert.equal(await runKeygen([], { env: { CLOUD_PILOT_KEY_DIR: dir }, out: cap.out }), 0);
  const [line] = cap.json();
  assert.equal(line.status, 'created');
  assert.equal(line.private_key, path.join(dir, PRIVATE_KEY_NAME));
  assert.equal(line.public_key, path.join(dir, PUBLIC_KEY_NAME));
  assert.equal(line.public_fingerprint_sha256, fingerprint(fs.readFileSync(line.public_key)));
  assert.doesNotMatch(cap.lines.join('\n'), /PRIVATE KEY|BEGIN/);
  const again = capture();
  assert.equal(await runKeygen([], { env: { CLOUD_PILOT_KEY_DIR: dir }, out: again.out }), 1);
  assert.match(again.json()[0].message, /already exists; pass --force/);
  assert.equal(await runKeygen(['--force'], { env: { CLOUD_PILOT_KEY_DIR: dir }, out: capture().out }), 0);
});

test('runKeygen refuses unknown flags, and a git working tree, with one JSON error line', async () => {
  const cap = capture();
  assert.equal(await runKeygen(['--nope'], { env: { CLOUD_PILOT_KEY_DIR: tmpDir() }, out: cap.out }), 1);
  assert.match(cap.json()[0].message, /usage: keygen/);
  const repo = fakeRepo();
  const cap2 = capture();
  assert.equal(await runKeygen([], { env: { CLOUD_PILOT_KEY_DIR: path.join(repo, 'k') }, out: cap2.out }), 1);
  assert.equal(cap2.json()[0].status, 'error');
  assert.match(cap2.json()[0].message, /git working tree/);
});

test('runFingerprint prints the public fingerprint; without any key it says so', async () => {
  const dir = path.join(tmpDir(), 'keys');
  const made = keygen({ env: { CLOUD_PILOT_KEY_DIR: dir } });
  const cap = capture();
  assert.equal(await runFingerprint([], { env: { CLOUD_PILOT_KEY_DIR: dir }, out: cap.out }), 0);
  const [line] = cap.json();
  assert.equal(line.public_fingerprint_sha256, made.fingerprint);
  assert.equal(line.public_key, made.publicPath);
  const none = capture();
  assert.equal(await runFingerprint([], { env: { CLOUD_PILOT_KEY_DIR: tmpDir() }, out: none.out }), 1);
  assert.match(none.json()[0].message, /no key found/);
  assert.equal(await runFingerprint(['extra'], { env: { CLOUD_PILOT_KEY_DIR: dir }, out: capture().out }), 1);
});

test('--help of keygen and fingerprint explains the key dir and exits 0', async () => {
  const a = capture();
  assert.equal(await runKeygen(['--help'], { out: a.out }), 0);
  assert.match(a.lines[0], /^usage: keygen/);
  assert.match(a.lines.join('\n'), /CLOUD_PILOT_KEY_DIR/);
  const b = capture();
  assert.equal(await runFingerprint(['--help'], { out: b.out }), 0);
  assert.match(b.lines[0], /^usage: fingerprint/);
});
