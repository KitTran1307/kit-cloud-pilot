#!/usr/bin/env node
// cloud-pilot channel signing keys (Ed25519).
//   keygen [--force]   new key pair: the private key in <key dir>/ed25519-private.pem (mode 0600 where the OS supports it),
//                      the public key beside it as ed25519-public.pem
//   fingerprint        SPKI sha256 of the public key
//
// The key dir is env CLOUD_PILOT_KEY_DIR, default ~/.cloud-pilot/keys. CLOUD_PILOT_PRIVATE_KEY points at one PEM file
// instead (a key you already have stays where it is; its public key is read from ed25519-public.pem next to it, or
// derived from it). keygen refuses to write a private key inside any git working tree or inside this repository, and
// loading a key from such a place is refused too, so it can never be committed or copied into a project by accident.
// keygen also refuses while CLOUD_PILOT_PRIVATE_KEY is set. Prints paths and the public fingerprint only, never key
// material.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setting } from '../hub/lib/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The kit-cloud-pilot repository this file lives in (also refused for private keys when it has no .git, e.g. a zip download).
export const PILOT_ROOT = path.resolve(HERE, '..');
export const PRIVATE_KEY_NAME = 'ed25519-private.pem';
export const PUBLIC_KEY_NAME = 'ed25519-public.pem';

export const KEYGEN_HELP = [
  'usage: keygen [--force]',
  '  Creates an Ed25519 key pair. The private key goes to <key dir>/ed25519-private.pem, the public key beside it.',
  '  Key dir: env CLOUD_PILOT_KEY_DIR, default ~/.cloud-pilot/keys. Env CLOUD_PILOT_PRIVATE_KEY names one private PEM file instead.',
  '  Refuses to replace an existing key without --force, and refuses any place inside a git working tree or this repository.',
  '  Refuses while CLOUD_PILOT_PRIVATE_KEY is set (it points at a key you already have): unset it first. A key inside a git working tree is refused when loading it too.',
].join('\n');

export const FINGERPRINT_HELP = [
  'usage: fingerprint',
  '  Prints the SPKI sha256 (hex) of your public key: the value `channel setup` pins in every repository it sets up.',
].join('\n');

export function defaultKeyDir() {
  return path.join(os.homedir(), '.cloud-pilot', 'keys');
}

export function keyDir(env = process.env) {
  const dir = setting('KEY_DIR', env);
  return path.resolve(dir || defaultKeyDir());
}

// Where the private key lives: CLOUD_PILOT_PRIVATE_KEY when set, else <key dir>/ed25519-private.pem.
export function privateKeyPath(env = process.env) {
  const file = setting('PRIVATE_KEY', env);
  return file ? path.resolve(file) : path.join(keyDir(env), PRIVATE_KEY_NAME);
}

export function publicKeyPath(env = process.env) {
  return path.join(path.dirname(privateKeyPath(env)), PUBLIC_KEY_NAME);
}

const caseless = process.platform === 'win32' || process.platform === 'darwin';

// An absolute path with the symlinks of its deepest existing part resolved (the rest may not exist yet).
function realish(p) {
  let abs = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(abs), ...rest.reverse());
    } catch {
      const up = path.dirname(abs);
      if (up === abs) return path.resolve(p);
      rest.push(path.basename(abs));
      abs = up;
    }
  }
}

const norm = (p) => (caseless ? p.toLowerCase() : p);

// Is `target` the same as or below `root`? Both are made real (symlinks resolved) first; case-insensitive where the OS is.
export function isInside(target, root) {
  return isInsideReal(realish(target), realish(root));
}

function isInsideReal(target, root) {
  const rel = path.relative(norm(root), norm(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// The nearest folder at or above `start` that holds a .git entry (a folder, or a file for worktrees and submodules), or null.
export function findGitRoot(start) {
  let dir = realish(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Throws when a private key at `file` would sit inside a git working tree or inside the kit-cloud-pilot repository.
// `use: true` words the message for a key that already exists (loading it) instead of one about to be created.
export function assertSafePrivatePath(file, { pilotRoot = PILOT_ROOT, use = false } = {}) {
  const target = realish(file);
  const root = realish(pilotRoot);
  if (isInsideReal(target, root)) {
    throw new Error(use
      ? `refusing to use the private key at ${file}: it sits inside the kit-cloud-pilot repository (${root}); move it to a folder outside any repository`
      : `refusing to put the private key inside the kit-cloud-pilot repository (${root}); use a folder outside any repository`);
  }
  const git = findGitRoot(path.dirname(target));
  if (git) {
    throw new Error(use
      ? `refusing to use the private key at ${file}: it sits inside a git working tree (${git}); move it to a folder outside any repository (CLOUD_PILOT_KEY_DIR or CLOUD_PILOT_PRIVATE_KEY)`
      : `refusing to put the private key inside a git working tree (${git}); set CLOUD_PILOT_KEY_DIR to a folder outside any repository`);
  }
}

export function fingerprint(publicKey) {
  const key = typeof publicKey === 'object' && publicKey?.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

export function keygen({ env = process.env, force = false, pilotRoot = PILOT_ROOT } = {}) {
  // CLOUD_PILOT_PRIVATE_KEY names a key you already have: keygen would write a second private key (or, with --force, over it).
  if (setting('PRIVATE_KEY', env)) throw new Error('CLOUD_PILOT_PRIVATE_KEY is set: unset it to generate a new key (it points at a key you already have)');
  const privatePath = privateKeyPath(env);
  const publicPath = publicKeyPath(env);
  assertSafePrivatePath(privatePath, { pilotRoot });
  for (const file of [privatePath, publicPath]) {
    if (fs.existsSync(file) && !force) throw new Error(`${file} already exists; pass --force to replace the key pair`);
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  fs.mkdirSync(path.dirname(privatePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
  try { fs.chmodSync(privatePath, 0o600); } catch { /* the OS has no POSIX modes */ }
  fs.writeFileSync(publicPath, publicPem);
  return { privatePath, publicPath, fingerprint: fingerprint(publicPem) };
}

// The local private key as a KeyObject. Errors name the file, never its content. A key inside a git working tree or inside the
// kit-cloud-pilot repository is refused, the same rule keygen applies to a key it would create.
export function loadLocalPrivateKey(env = process.env, { pilotRoot = PILOT_ROOT } = {}) {
  const file = privateKeyPath(env);
  assertSafePrivatePath(file, { pilotRoot, use: true });
  let pem;
  try {
    pem = fs.readFileSync(file);
  } catch (err) {
    throw new Error(err?.code === 'ENOENT'
      ? `no private key at ${file}; run "cloud-pilot channel keygen" first, or set CLOUD_PILOT_PRIVATE_KEY to your PEM file`
      : `cannot read the private key at ${file}`);
  }
  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch {
    throw new Error(`${file} is not a readable unencrypted private key in PEM form`);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is not an Ed25519 key`);
  return key;
}

function toPublicPem(source, label) {
  let key;
  try {
    key = crypto.createPublicKey(source);
  } catch {
    throw new Error(`${label} is not a readable public key in PEM form`);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${label} is not an Ed25519 key`);
  // Always re-exported as SPKI public PEM, so private key material can never ride along.
  return key.export({ type: 'spki', format: 'pem' });
}

// The public key PEM that belongs to the local private key: the file beside it when there is one (it must match the private
// key when both exist), else derived from the private key. Throws when neither exists.
export function localPublicKeyPem(env = process.env) {
  const pubFile = publicKeyPath(env);
  const privFile = privateKeyPath(env);
  const fromFile = fs.existsSync(pubFile) ? toPublicPem(fs.readFileSync(pubFile), pubFile) : null;
  const derived = fs.existsSync(privFile) ? toPublicPem(loadLocalPrivateKey(env), privFile) : null;
  if (fromFile && derived && fingerprint(fromFile) !== fingerprint(derived)) throw new Error(`${pubFile} does not belong to the private key ${privFile}`);
  const pem = fromFile ?? derived;
  if (!pem) throw new Error(`no key found at ${privFile}; run "cloud-pilot channel keygen" first`);
  return pem;
}

const defaultOut = (line) => console.log(line);

export async function runKeygen(args, { env = process.env, out = defaultOut } = {}) {
  if (args.includes('--help') || args.includes('-h')) { out(KEYGEN_HELP); return 0; }
  try {
    if (!args.every((a) => a === '--force')) throw new Error('usage: keygen [--force]');
    const r = keygen({ env, force: args.includes('--force') });
    out(JSON.stringify({ status: 'created', private_key: r.privatePath, public_key: r.publicPath, public_fingerprint_sha256: r.fingerprint }));
    return 0;
  } catch (err) {
    out(JSON.stringify({ status: 'error', message: err.message }));
    return 1;
  }
}

export async function runFingerprint(args, { env = process.env, out = defaultOut } = {}) {
  if (args.includes('--help') || args.includes('-h')) { out(FINGERPRINT_HELP); return 0; }
  try {
    if (args.length) throw new Error('usage: fingerprint');
    const pubFile = publicKeyPath(env);
    out(JSON.stringify({
      status: 'ok', public_key: fs.existsSync(pubFile) ? pubFile : null, public_fingerprint_sha256: fingerprint(localPublicKeyPem(env)),
    }));
    return 0;
  } catch (err) {
    out(JSON.stringify({ status: 'error', message: err.message }));
    return 1;
  }
}

export async function runKeys(argv, deps) {
  const [verb, ...rest] = argv;
  if (verb === 'keygen') return runKeygen(rest, deps);
  if (verb === 'fingerprint') return runFingerprint(rest, deps);
  (deps?.out ?? defaultOut)(JSON.stringify({ status: 'error', message: 'usage: keys.mjs keygen [--force] | fingerprint' }));
  return 1;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = await runKeys(process.argv.slice(2));
