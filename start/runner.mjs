// The process side of `start`: find Python, set up pywinpty on Windows, run pty_run.py and relay its output.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { setting } from '../hub/lib/config.mjs';
import { resolveExe, safeCwd } from '../hub/lib/exe.mjs';
import { StartError } from './lib.mjs';

export const PTY_SCRIPT = fileURLToPath(new URL('./pty_run.py', import.meta.url));
const PROBE = "import sys; print(str(sys.version_info[0]) + '.' + str(sys.version_info[1]))";
const MIN_PYTHON = [3, 7];

// The pywinpty release installed into the Windows venv. Pinned (not "latest"): this is the version the terminal helper
// was tested with, so a later release cannot change how claude is started. To move to a newer one: install it in a
// scratch venv, run `CLOUD_PILOT_PYTHON=<that venv>\Scripts\python.exe node --test start/tests/pty.test.mjs` until it
// passes, then change this line and the version in start/README.md. (pip's --require-hashes could pin the files too;
// not done, since the hashes differ per Python version and platform.)
export const PYWINPTY_SPEC = 'pywinpty==3.1.2';

// Programs are started by full path (found on PATH without looking in the current folder) and from the home folder, so a
// repository that holds a python.exe or py.exe cannot supply the interpreter.
const defaultExec = (cmd, args, opts = {}) => execFileSync(resolveExe(cmd), args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000, cwd: safeCwd(), ...opts,
});

const quote = (s) => (/[\s"]/.test(s) ? `"${s}"` : s);
const shown = (python) => [python.cmd, ...python.args].map(quote).join(' ');

// The Pythons to try, in order. CLOUD_PILOT_PYTHON replaces the list.
export function pythonCandidates(env = process.env, platform = process.platform) {
  const forced = setting('PYTHON', env);
  if (forced) return [{ cmd: forced, args: [] }];
  const list = [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }];
  if (platform === 'win32') list.push({ cmd: 'py', args: ['-3'] });
  return list;
}

// The first candidate that runs and is Python 3.7 or newer: { cmd, args, version } or null. A Windows Store stub
// ("python was not found") prints no version, so it never counts.
export function findPython({ env = process.env, platform = process.platform, exec = defaultExec } = {}) {
  for (const c of pythonCandidates(env, platform)) {
    try {
      const m = /^(\d+)\.(\d+)/.exec(String(exec(c.cmd, [...c.args, '-I', '-c', PROBE])).trim());
      if (m && (Number(m[1]) > MIN_PYTHON[0] || (Number(m[1]) === MIN_PYTHON[0] && Number(m[2]) >= MIN_PYTHON[1]))) return { ...c, version: `${m[1]}.${m[2]}` };
    } catch { /* not this one */ }
  }
  return null;
}

// Whether this Python can open a pseudo-terminal (on Windows: has pywinpty).
export function canPty(python, exec = defaultExec) {
  try {
    exec(python.cmd, [...python.args, '-I', PTY_SCRIPT, '--check']);
    return true;
  } catch {
    return false;
  }
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A lock nobody has touched for this long belongs to a dead process. The holder touches it before and after each step
// (see below), and one step (creating the venv 2 min, pip 10 min) never runs longer than 10 minutes.
export const VENV_LOCK_STALE_MS = 15 * 60_000;
export const VENV_LOCK_WAIT_MS = 5 * 60_000;

// One process at a time sets up the venv; the others wait for it, then find it ready. `fn(touch)` gets a function that
// renews the lock's timestamp: call it between steps so a slow setup is not taken for a dead one.
export function withVenvLock(dir, fn, { staleMs = VENV_LOCK_STALE_MS, waitMs = VENV_LOCK_WAIT_MS, sleep = sleepMs } = {}) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'venv.lock');
  const started = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ }
      if (Date.now() - started > waitMs) throw new StartError(`another process has been setting up pywinpty for ${Math.round(waitMs / 60_000)} minutes; delete ${lock} if it is stale and retry`);
      sleep(500);
    }
  }
  const touch = () => { try { const now = new Date(); utimesSync(lock, now, now); } catch { /* the lock is gone: nothing to renew */ } };
  try { return fn(touch); } finally { rmSync(lock, { recursive: true, force: true }); }
}

// The Python that will run pty_run.py. macOS and Linux: any Python 3. Windows: one that has pywinpty, else a venv
// under <data dir>/venv, created once and reused.
export function preparePython({ env = process.env, platform = process.platform, dataDir, exec = defaultExec, exists = existsSync } = {}) {
  const base = findPython({ env, platform, exec });
  if (!base) {
    throw new StartError(setting('PYTHON', env)
      ? `CLOUD_PILOT_PYTHON is set to "${setting('PYTHON', env)}", which is not a working Python 3.7 or newer`
      : 'Python 3.7 or newer is required to give claude a terminal, and none was found: install it from https://www.python.org/downloads/ (python3, python or "py -3" must run), or set CLOUD_PILOT_PYTHON to a Python 3 executable');
  }
  if (platform !== 'win32') {
    if (!canPty(base, exec)) throw new StartError(`this Python (${shown(base)}) has no "pty" module: use a standard Python 3 build for macOS or Linux, or set CLOUD_PILOT_PYTHON`);
    return base;
  }
  if (canPty(base, exec)) return base; // pywinpty is already there
  const venv = join(dataDir, 'venv');
  const venvPython = { cmd: join(venv, 'Scripts', 'python.exe'), args: [] };
  const ready = () => exists(venvPython.cmd) && canPty(venvPython, exec);
  if (ready()) return venvPython;
  const manual = `Run these once, then retry:\n  ${shown(base)} -m venv "${venv}"\n  "${venvPython.cmd}" -m pip install ${PYWINPTY_SPEC}`;
  withVenvLock(dataDir, (touch) => {
    if (ready()) return;
    const step = (what, cmd, args, timeout) => {
      touch(); // the lock is renewed before and after each step: only a lock nobody has touched for VENV_LOCK_STALE_MS is stale
      try { exec(cmd, args, { timeout }); } catch (err) {
        const detail = String(err?.stderr || err?.message || err).trim().split('\n').slice(-3).join(' | ').slice(0, 400);
        throw new StartError(`could not set up pywinpty, which Windows needs to give claude a terminal (${what} failed: ${detail}). ${manual}`);
      }
      touch();
    };
    if (!exists(venvPython.cmd)) step('creating the virtual environment', base.cmd, [...base.args, '-m', 'venv', '--clear', venv], 120000);
    step('installing pywinpty', venvPython.cmd, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', PYWINPTY_SPEC], 600000);
    if (!canPty(venvPython, exec)) throw new StartError(`pywinpty was installed but cannot be imported. ${manual}`);
  });
  return venvPython;
}

// Starts `argv` inside a terminal through pty_run.py. Returns a handle:
//   onData(fn)   fn(text) for each piece of output
//   onClose(fn)  fn({ code, stderr }) once the helper has ended
//   stop()       close the terminal and the command; resolves when the helper has exited
export function startPty({ python, argv, cwd, env = process.env, rows = 50, cols = 200 }) {
  // The helper starts in the home folder (the folder claude runs in travels in the request, not as the helper's own).
  const child = spawn(resolveExe(python.cmd), [...python.args, '-I', PTY_SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: safeCwd() });
  const decoder = new StringDecoder('utf8');
  const dataFns = [];
  const closeFns = [];
  let stderr = '';
  let closed = false;
  let result = null;
  child.stdout.on('data', (buf) => { const text = decoder.write(buf); if (text) for (const fn of dataFns) fn(text); });
  child.stderr.on('data', (buf) => { stderr = (stderr + buf).slice(-4000); });
  child.stdin.on('error', () => { /* the helper already ended */ });
  child.on('error', (err) => { stderr += `\n${err.message}`; });
  const ended = new Promise((resolve) => {
    child.on('close', (code) => {
      closed = true;
      result = { code, stderr: stderr.trim() };
      for (const fn of closeFns) fn(result);
      resolve();
    });
  });
  child.stdin.write(`${JSON.stringify({ argv, cwd, rows, cols })}\n`);
  return {
    onData: (fn) => { dataFns.push(fn); },
    onClose: (fn) => { if (closed) fn(result); else closeFns.push(fn); },
    async stop() {
      if (!closed) {
        try { child.stdin.end(); } catch { /* already closed */ }
        const killer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 6000);
        await ended;
        clearTimeout(killer);
      }
    },
  };
}

// What pty_run.py's exit status and messages mean for the person running the tool.
export function helperFailure(info, python) {
  const msg = String(info.stderr || '').split('\n').filter((l) => l.startsWith('pty_run:')).map((l) => l.slice(8).trim()).join('; ');
  if (info.code === 3) return `no pseudo-terminal available: ${msg || 'pywinpty is missing'} (python: ${shown(python)})`;
  if (info.code === 4) return `claude could not be started: ${msg}`;
  if (info.code && info.code !== 0) return `the terminal helper failed (exit ${info.code}): ${msg || String(info.stderr || '').slice(-300)}`;
  return '';
}

export function childExit(info) {
  const m = /child exited with code (-?\d+)/.exec(info?.stderr ?? '');
  return m ? Number(m[1]) : null;
}
