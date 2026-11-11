// Shared by the start tests: temp folders, a clean environment, a throwaway git repository, and a runner that starts
// the fake claude through plain pipes (no terminal), so the logic of `main` is tested the same way on every OS.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

export const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

const made = [];
export function tmp(name = 'x') {
  const dir = mkdtempSync(join(tmpdir(), `cloud-pilot-start-${name}-`));
  made.push(dir);
  return dir;
}
// Best effort: on Windows a folder that a process still uses cannot be removed, and that must not fail a test run.
export function cleanup() {
  for (const dir of made.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* left in the temp folder */ }
  }
}

// The real environment minus everything that could change how the tool behaves, plus `extra`.
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLOUD_PILOT_|KIT_HUB_|CLAUDE_|FAKE_CLAUDE_|CCR_)/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

export const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// A git repository; with `origin` it gets that remote (nothing is fetched or pushed).
export function makeRepo(origin) {
  const dir = tmp('repo');
  if (hasGit) {
    execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
    if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin], { stdio: 'ignore' });
  }
  return dir;
}

// The same folder, whatever the spelling: symlinked temp folders (macOS), 8.3 short names and drive-letter case (Windows).
export function samePath(a, b) {
  const norm = (p) => { let x = String(p); try { x = realpathSync.native(x); } catch { /* keep as given */ } return x.replace(/\\/g, '/').toLowerCase(); };
  return norm(a) === norm(b);
}

export const readJsonFile = (file, fallback = null) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);

// Starts argv in a child process on pipes and returns the handle `main` expects (see startPty in runner.mjs).
export function pipeStart({ argv, cwd, env }) {
  const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const decoder = new StringDecoder('utf8');
  const dataFns = [];
  const closeFns = [];
  let closed = false;
  let info = null;
  const relay = (buf) => { const t = decoder.write(buf); if (t) for (const fn of dataFns) fn(t); };
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);
  const ended = new Promise((resolve) => {
    child.on('close', (code) => { closed = true; info = { code, stderr: '' }; for (const fn of closeFns) fn(info); resolve(); });
  });
  child.on('error', () => {});
  return {
    onData: (fn) => { dataFns.push(fn); },
    onClose: (fn) => { if (closed) fn(info); else closeFns.push(fn); },
    async stop() { if (!closed) { child.kill(); await ended; } },
  };
}

// Runs main with its output captured: { code, lines, json } (json = the single JSON line, parsed).
export async function run(main, argv, opts) {
  const lines = [];
  const code = await main(argv, { ...opts, out: (l) => lines.push(l) });
  let json = null;
  if (lines.length === 1) { try { json = JSON.parse(lines[0]); } catch { /* not JSON */ } }
  return { code, lines, json };
}

export async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return Boolean(fn());
}
