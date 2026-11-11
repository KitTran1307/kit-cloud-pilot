// The channel folder is public and portable: no machine-specific paths, no personal data, no hard-coded key, plain ASCII,
// and the cloud script stays standalone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CHANNEL_DIR, walk } from './helpers.mjs';

const rel = (file) => path.relative(CHANNEL_DIR, file).split(path.sep).join('/');
const files = () => walk(CHANNEL_DIR);
const text = (file) => fs.readFileSync(file, 'utf8');
const sources = () => files().filter((f) => f.endsWith('.mjs'));

// Built from pieces so that this file does not contain the very strings it forbids.
const FORBIDDEN = [
  [['EXPECTED', 'FINGERPRINT'].join('_'), 'a hard-coded pin'],
  [['kit-channel', 'public'].join('-'), 'the old public key file name'],
];
// An absolute Windows drive path (one drive letter standing alone, a colon, then a slash or backslash: "https://" is not one) and a
// home folder path (a top-level Users or home folder followed by a user name, not the tail of a relative path): neither belongs
// in a portable public folder.
const DRIVE_PATH = /(?<![A-Za-z0-9_.-])[A-Za-z]:[\\/]/;
const HOME_PATH = /(?<![A-Za-z0-9_.~-])\/(?:Users|home)\/[^\s/\\'"`]+/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
const OWNER_NOTE = /owner[^\n]{0,12}20\d\d-\d\d/i;
// Test fixtures are recorded data; every other file is checked.
const checked = () => files().filter((f) => !rel(f).startsWith('tests/fixtures/'));

test('no file under channel/ holds an absolute drive path, a home folder path, an old pin name or a hard-coded pin', () => {
  assert.ok(files().length > 10);
  for (const file of checked()) {
    const body = text(file);
    for (const [needle, what] of FORBIDDEN) assert.equal(body.includes(needle), false, `${rel(file)} contains ${what}`);
    assert.doesNotMatch(body, DRIVE_PATH, `${rel(file)} contains an absolute drive path`);
    assert.doesNotMatch(body, HOME_PATH, `${rel(file)} contains a home folder path`);
  }
});

test('the path patterns catch drive and home paths in any spelling, and leave URLs and ordinary text alone', () => {
  // samples are assembled from pieces so this file does not contain them either
  const bad = [['Z:', 'work', 'app'].join('\\'), ['q:', 'tmp'].join('/'), `x = '${['C:', 'temp'].join('\\\\')}'`, ['', 'Users', 'someone', 'app'].join('/'), ['', 'home', 'someone'].join('/')];
  for (const sample of bad) assert.ok(DRIVE_PATH.test(sample) || HOME_PATH.test(sample), sample);
  const fine = ['https://github.com/acme/app', 'Answer:\\n', 'key: value', 'a:b', 'src/home/page.ts', 'see ~/.cloud-pilot/keys', 'users/home dir', 'file:///x'];
  for (const sample of fine) assert.equal(DRIVE_PATH.test(sample) || HOME_PATH.test(sample), false, sample);
});

test('no file under channel/ holds an email address or a dated "owner" note', () => {
  for (const file of files()) {
    const body = text(file);
    assert.doesNotMatch(body, EMAIL, rel(file));
    assert.doesNotMatch(body, OWNER_NOTE, rel(file));
  }
});

test('every file under channel/ is plain ASCII: the legacy ask label exists only as unicode escapes', () => {
  for (const file of files()) {
    const bytes = fs.readFileSync(file);
    const bad = bytes.findIndex((b) => b > 0x7f);
    assert.equal(bad, -1, `${rel(file)} has a non-ASCII byte at ${bad}`);
  }
  const body = text(path.join(CHANNEL_DIR, 'cloud', 'channel.mjs'));
  assert.match(body, /LEGACY_ASK_LABEL = 'CH\\u\{1EDC\} B\\u\{1EA0\}N'/);
});

test('channel/legacy is gone', () => {
  assert.equal(fs.existsSync(path.join(CHANNEL_DIR, 'legacy')), false);
});

test('the cloud script is standalone: Node built-ins only, no key file names, no 64-hex literal', () => {
  const file = path.join(CHANNEL_DIR, 'cloud', 'channel.mjs');
  const body = text(file);
  const specs = [...body.matchAll(/^import[^\n]*?from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(specs.length >= 5);
  for (const spec of specs) assert.match(spec, /^node:/, spec);
  assert.doesNotMatch(body, /\bimport\(/, 'no dynamic imports');
  assert.doesNotMatch(body, /\b[0-9a-fA-F]{64}\b/, 'no hard-coded fingerprint');
  assert.doesNotMatch(body, /ed25519-private|PRIVATE KEY/);
  assert.match(body, /channel-public\.pem/);
  assert.match(body, /channel\.json/);
});

test('sources avoid APIs newer than Node 18, so the suite and the tools run there', () => {
  const newer = [/import\.meta\.(dirname|filename)/, /\.toSorted\(/, /\.toReversed\(/, /\.toSpliced\(/, /Object\.groupBy/, /Map\.groupBy/, /Promise\.withResolvers/,
    /Array\.fromAsync/, /\.isWellFormed\(/, /\bt\.after\(/, /\bt\.before\(/, /with \{ type: 'json' \}/, /assert \{ type: 'json' \}/];
  for (const file of sources()) {
    const body = text(file);
    for (const re of newer) assert.doesNotMatch(body, re, `${rel(file)} uses ${re}`);
  }
});

test('README documents the protocol, the threat model, setup and every command', () => {
  const readme = text(path.join(CHANNEL_DIR, 'README.md'));
  for (const heading of [/^# /m, /^## .*protocol/im, /^## .*threat model/im, /^## .*setup/im, /^## .*commands/im]) assert.match(readme, heading, String(heading));
  for (const verb of ['keygen', 'fingerprint', 'setup', 'ask', 'wait', 'answer']) assert.match(readme, new RegExp(`channel ${verb}`), verb);
  for (const name of ['CLOUD_PILOT_KEY_DIR', 'CLOUD_PILOT_PRIVATE_KEY', 'CLOUD_PILOT_ASK_AUTHORS', 'channel.json', 'channel-public.pem', 'ed25519-private.pem']) {
    assert.ok(readme.includes(name), name);
  }
  // the agent-config refusal names the paths it covers
  for (const p of ['.claude', '.agents', '.codex', '.githooks', '.github', '.husky', '.vscode', '.devcontainer', '.cursor', 'CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', 'GEMINI.md', '.mcp.json']) {
    assert.ok(readme.includes(p), p);
  }
  for (const word of ['local-session', 'WAITING FOR YOU', 'CLOUD-PILOT ANSWER', 'kit-channel:ask', 'kit-channel:answer', 'head_sha', 'question_sha256']) assert.ok(readme.includes(word), word);
  assert.match(readme, /money/i);
  assert.match(readme, /production/i);
  assert.match(readme, /does not prove/i);
});
