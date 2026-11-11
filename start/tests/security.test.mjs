// Regression tests for the findings of the independent security review (start side): the claude lookup on Windows,
// the pinned pywinpty and the venv lock.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StartError, resolveClaude } from '../lib.mjs';
import { PYWINPTY_SPEC, VENV_LOCK_STALE_MS, preparePython, withVenvLock } from '../runner.mjs';
import { cleanup, tmp } from './helpers.mjs';

after(cleanup);

const HERE = dirname(fileURLToPath(import.meta.url));
const exists = (...files) => (f) => files.includes(f);
const native = (dir) => `${dir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;

describe('5: the claude lookup on Windows searches every PATH folder', () => {
  const win = { platform: 'win32' };
  test('a claude.exe in a later folder wins over a claude.cmd shim in an earlier one', () => {
    const r = resolveClaude({ PATH: 'C:\\npm;C:\\Users\\me\\bin' }, { ...win, exists: exists('C:\\npm\\claude.cmd', 'C:\\Users\\me\\bin\\claude.exe') });
    assert.deepEqual(r, { path: 'C:\\Users\\me\\bin\\claude.exe', prefix: ['C:\\Users\\me\\bin\\claude.exe'] });
  });
  test('the native exe of the npm package is taken from whichever claude.cmd has one, not only the first', () => {
    const r = resolveClaude({ PATH: 'C:\\old;C:\\npm' }, { ...win, exists: exists('C:\\old\\claude.cmd', 'C:\\npm\\claude.cmd', native('C:\\npm')) });
    assert.deepEqual(r, { path: native('C:\\npm'), prefix: [native('C:\\npm')] });
  });
  test('a real claude.exe anywhere on PATH is preferred to the npm package\'s native exe next to a shim', () => {
    const r = resolveClaude({ PATH: 'C:\\npm;C:\\bin' }, { ...win, exists: exists('C:\\npm\\claude.cmd', native('C:\\npm'), 'C:\\bin\\claude.exe') });
    assert.equal(r.path, 'C:\\bin\\claude.exe');
  });
  test('only shims and no native exe: refused, naming the first shim', () => {
    const r = resolveClaude({ PATH: 'C:\\a;C:\\b' }, { ...win, exists: exists('C:\\a\\claude.cmd', 'C:\\b\\claude.bat') });
    assert.match(r.error, /found C:\\a\\claude\.cmd, a cmd\.exe shim/);
    assert.match(r.error, /CLOUD_PILOT_CLAUDE_BIN/);
  });
  test('empty and relative PATH entries are never searched (a claude.exe in the current folder is not claude)', () => {
    const r = resolveClaude({ PATH: ';.;tools;C:\\bin' }, { ...win, exists: exists('claude.exe', '.\\claude.exe', 'tools\\claude.exe') });
    assert.match(r.error, /claude not found/);
    const posix = resolveClaude({ PATH: ':.:bin:/usr/bin' }, { platform: 'linux', exists: exists('claude', './claude', 'bin/claude') });
    assert.match(posix.error, /claude not found/);
  });
  test('a name in CLOUD_PILOT_CLAUDE_BIN is searched the same way', () => {
    const r = resolveClaude({ CLOUD_PILOT_CLAUDE_BIN: 'claude-beta', PATH: 'C:\\npm;C:\\bin' }, { ...win, exists: exists('C:\\npm\\claude-beta.cmd', 'C:\\bin\\claude-beta.exe') });
    assert.equal(r.path, 'C:\\bin\\claude-beta.exe');
  });
  test('the ordinary cases still work (exe first in a folder, shim with native exe, nothing found)', () => {
    assert.equal(resolveClaude({ PATH: 'C:\\bin' }, { ...win, exists: exists('C:\\bin\\claude.cmd', 'C:\\bin\\claude.exe') }).path, 'C:\\bin\\claude.exe');
    assert.equal(resolveClaude({ PATH: 'C:\\npm' }, { ...win, exists: exists('C:\\npm\\claude.cmd', native('C:\\npm')) }).path, native('C:\\npm'));
    assert.match(resolveClaude({ PATH: 'C:\\npm' }, { ...win, exists: () => false }).error, /claude not found/);
  });
});

describe('6: pywinpty is pinned', () => {
  test('the pin is an exact version and the README names the same one', () => {
    assert.match(PYWINPTY_SPEC, /^pywinpty==\d+\.\d+\.\d+$/);
    assert.equal(PYWINPTY_SPEC, 'pywinpty==3.1.2');
    const readme = readFileSync(join(HERE, '..', 'README.md'), 'utf8');
    assert.ok(readme.includes(PYWINPTY_SPEC), 'start/README.md shows the pinned version');
  });
  test('pip is given the pinned spec, and so is the by-hand advice', () => {
    const dir = tmp('pin');
    const vpy = join(dir, 'venv', 'Scripts', 'python.exe');
    const calls = [];
    let created = false;
    let installed = false;
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes('-c')) return '3.12\n';
      if (args.includes('venv')) { created = true; return ''; }
      if (args.includes('pip')) { installed = true; return ''; }
      if (args.includes('--check') && !(cmd === vpy && installed)) throw new Error('no pty');
      return '';
    };
    preparePython({ env: {}, platform: 'win32', dataDir: dir, exec, exists: (f) => created && f === vpy });
    const pip = calls.find((c) => c.includes('pip'));
    assert.equal(pip.at(-1), PYWINPTY_SPEC);
    assert.ok(!pip.includes('pywinpty'), 'never the bare, unpinned name');
    const failing = (cmd, args) => { if (args.includes('-c')) return '3.12\n'; if (args.includes('venv')) return ''; throw Object.assign(new Error('x'), { stderr: 'boom' }); };
    assert.throws(() => preparePython({ env: {}, platform: 'win32', dataDir: tmp('pin2'), exec: failing, exists: () => false }), (e) => e.message.includes(`-m pip install ${PYWINPTY_SPEC}`));
  });
});

describe('7: the venv lock', () => {
  const noSleep = () => {};
  const ageLock = (lock, minutes) => { const t = new Date(Date.now() - minutes * 60_000); utimesSync(lock, t, t); };

  test('it is stale after 15 minutes, longer than creating the venv (2 min) plus pip (10 min)', () => {
    assert.equal(VENV_LOCK_STALE_MS, 15 * 60_000);
    assert.ok(VENV_LOCK_STALE_MS > 2 * 60_000 + 10 * 60_000);
    const dir = tmp('lock');
    const lock = join(dir, 'venv.lock');
    mkdirSync(lock);
    ageLock(lock, 12); // past the old 10-minute limit, within the real work of a slow setup
    assert.throws(() => withVenvLock(dir, () => 'ran', { waitMs: 50, sleep: noSleep }), StartError, 'a 12-minute-old lock is a live setup: not taken over');
    assert.ok(existsSync(lock));
    ageLock(lock, 16);
    assert.equal(withVenvLock(dir, () => 'ran', { waitMs: 50, sleep: noSleep }), 'ran', 'a 16-minute-old lock is dead: taken over');
    assert.equal(existsSync(lock), false, 'released after the work');
  });

  test('the holder can renew the lock\'s timestamp', () => {
    const dir = tmp('touch');
    const lock = join(dir, 'venv.lock');
    withVenvLock(dir, (touch) => {
      ageLock(lock, 12);
      assert.ok(Date.now() - statSync(lock).mtimeMs > 11 * 60_000);
      touch();
      assert.ok(Date.now() - statSync(lock).mtimeMs < 60_000, 'renewed');
    });
  });

  test('a setup renews the lock between its steps, so a slow step never makes it look dead', () => {
    const dir = tmp('steps');
    const lock = join(dir, 'venv.lock');
    const vpy = join(dir, 'venv', 'Scripts', 'python.exe');
    const ageSeen = {};
    let created = false;
    let installed = false;
    const age = () => Date.now() - statSync(lock).mtimeMs;
    const exec = (cmd, args) => {
      if (args.includes('-c')) return '3.12\n';
      if (args.includes('venv')) { ageLock(lock, 12); created = true; return ''; } // creating took very long
      if (args.includes('pip')) { ageSeen.beforePip = age(); ageLock(lock, 12); installed = true; return ''; } // and so did pip
      if (args.includes('--check')) {
        if (cmd === vpy && installed) { ageSeen.afterPip = age(); return ''; }
        throw new Error('no pty');
      }
      return '';
    };
    preparePython({ env: {}, platform: 'win32', dataDir: dir, exec, exists: (f) => created && f === vpy });
    assert.ok(ageSeen.beforePip < 60_000, `renewed after the venv step (${ageSeen.beforePip} ms old)`);
    assert.ok(ageSeen.afterPip < 60_000, `renewed after the pip step (${ageSeen.afterPip} ms old)`);
    assert.equal(existsSync(lock), false);
  });
});
