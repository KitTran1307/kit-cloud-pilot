// The real terminal path: pty_run.py with a fake claude. macOS and Linux need only Python 3; Windows needs a Python
// that has pywinpty (or CLOUD_PILOT_PYTHON pointing at one), otherwise these tests are skipped and say why.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../index.mjs';
import { cleanOutput } from '../lib.mjs';
import { PTY_SCRIPT, canPty, findPython } from '../runner.mjs';
import { isAlive } from '../../hub/lib/store.mjs';
import { FAKE_CLAUDE, cleanEnv, cleanup, run, samePath, tmp, waitFor } from './helpers.mjs';

const helpers = [];
after(async () => {
  for (const h of helpers) h.closeStdin(); // a helper that is still running stops its command when its stdin closes
  await Promise.all(helpers.map((h) => Promise.race([h.done, new Promise((r) => setTimeout(r, 5000))])));
  cleanup();
});

const FORCED_PYTHON = process.env.CLOUD_PILOT_PYTHON;
const baseEnv = (extra = {}) => cleanEnv({ ...(FORCED_PYTHON ? { CLOUD_PILOT_PYTHON: FORCED_PYTHON } : {}), ...extra });
const python = findPython({ env: baseEnv() });
const skip = !python
  ? 'no Python 3.7 or newer found'
  : !canPty(python)
    ? (process.platform === 'win32' ? 'pywinpty is not installed for this Python: run "python -m pip install pywinpty" (or set CLOUD_PILOT_PYTHON)' : 'this Python has no pty module')
    : false;

// Runs pty_run.py by hand: returns { stdout, stderr, code, send(), closeStdin(), done }.
function helper(request, { env = baseEnv() } = {}) {
  const child = spawn(python.cmd, [...python.args, '-I', PTY_SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const h = { stdout: '', stderr: '', code: null };
  child.stdout.setEncoding('utf8').on('data', (t) => { h.stdout += t; });
  child.stderr.setEncoding('utf8').on('data', (t) => { h.stderr += t; });
  h.done = new Promise((resolve) => child.on('close', (code) => { h.code = code; resolve(h); }));
  h.closeStdin = () => child.stdin.end();
  h.kill = () => child.kill();
  child.stdin.on('error', () => {});
  child.stdin.write(typeof request === 'string' ? request : `${JSON.stringify(request)}\n`);
  helpers.push(h);
  return h;
}
const withTimeout = (promise, ms, what) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms))]);

describe('pty_run.py', { skip }, () => {
  test('--check says the backend is there', async () => {
    const child = spawn(python.cmd, [...python.args, '-I', PTY_SCRIPT, '--check'], { stdio: 'ignore', windowsHide: true });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
  });

  test('gives the command a terminal and relays its output', async () => {
    const h = helper({ argv: [process.execPath, '-e', "console.log('tty=' + process.stdout.isTTY + ' hello-from-pty')"], cwd: tmp('cwd'), rows: 40, cols: 120 });
    await withTimeout(h.done, 20000, 'the helper to end');
    assert.equal(h.code, 0);
    assert.match(h.stdout, /tty=true hello-from-pty/);
    assert.match(h.stderr, /pty_run: child exited with code 0/);
  });

  test('runs the command in the given folder', async () => {
    const cwd = tmp('cwd');
    const h = helper({ argv: [process.execPath, '-e', "console.log('cwd=' + process.cwd())"], cwd });
    await withTimeout(h.done, 20000, 'the helper to end');
    const got = /cwd=(.*)/.exec(h.stdout)?.[1]?.trim();
    assert.ok(samePath(got, cwd), `${got} is not ${cwd}`);
  });

  test('closing stdin stops a command that keeps running', async () => {
    const record = join(tmp('rec'), 'r.json');
    const h = helper({ argv: [process.execPath, FAKE_CLAUDE, '--cloud', 'x'], cwd: tmp('cwd') }, { env: baseEnv({ FAKE_CLAUDE_MODE: 'silent', FAKE_CLAUDE_RECORD: record }) });
    assert.ok(await waitFor(() => cleanOutput(h.stdout).includes('Claude Code (fake)'), 15000), `no banner, got ${JSON.stringify(h.stdout)}`);
    const { pid } = JSON.parse(readFileSync(record, 'utf8'));
    assert.ok(isAlive(pid));
    h.closeStdin();
    await withTimeout(h.done, 20000, 'the helper to end after stdin closed');
    assert.equal(h.code, 0);
    assert.ok(await waitFor(() => !isAlive(pid), 8000), 'the command is still running');
  });

  test('a bad request exits with 2', async () => {
    const h = helper('this is not json\n');
    await withTimeout(h.done, 20000, 'the helper to end');
    assert.equal(h.code, 2);
    assert.match(h.stderr, /^pty_run: bad request/);
    const h2 = helper({ argv: [], cwd: '.' });
    await withTimeout(h2.done, 20000, 'the helper to end');
    assert.equal(h2.code, 2);
  });

  test('a command or folder that does not exist exits with 4', async () => {
    const missing = helper({ argv: [join(tmp('none'), 'no-such-command')], cwd: tmp('cwd') });
    await withTimeout(missing.done, 20000, 'the helper to end');
    assert.equal(missing.code, 4);
    assert.match(missing.stderr, /pty_run: cannot start .*not found/);
    const noDir = helper({ argv: [process.execPath, '-e', '0'], cwd: join(tmp('none'), 'no-such-dir') });
    await withTimeout(noDir.done, 20000, 'the helper to end');
    assert.equal(noDir.code, 4);
    assert.match(noDir.stderr, /directory not found/);
  });

  test('the brief reaches the command as one untouched argument', async () => {
    const record = join(tmp('rec'), 'r.json');
    const brief = 'Fix "quotes", $HOME, `ticks`, %PATH%, a & b | c > d\nsecond line with \u00e9\u00e8 and \u4e2d\u6587';
    const h = helper({ argv: [process.execPath, FAKE_CLAUDE, '--cloud', brief], cwd: tmp('cwd') }, { env: baseEnv({ FAKE_CLAUDE_MODE: 'exit1', FAKE_CLAUDE_RECORD: record }) });
    await withTimeout(h.done, 20000, 'the helper to end');
    assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')).args, ['--cloud', brief]);
  });
});

describe('main through the real terminal path', { skip }, () => {
  function setup(mode, extra = {}) {
    const dir = tmp('hub');
    const record = join(dir, 'rec.json');
    const env = baseEnv({ CLOUD_PILOT_DIR: dir, CLOUD_PILOT_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_RECORD: record, ...extra });
    return { dir, record, env, cwd: tmp('repo') };
  }

  test('starts, reads the session link, closes the client, logs the start', async () => {
    const config = join(tmp('acct'), '.claude-work');
    const s = setup('ok', { CLAUDE_CONFIG_DIR: config });
    const r = await run(main, ['--cwd', s.cwd, '--brief', 'Do the login page', '--no-track'], { env: s.env });
    assert.equal(r.code, 0, r.lines[0]);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.session_id, 'session_TEST123');
    assert.equal(r.json.url, 'https://claude.ai/code/session_TEST123');
    assert.equal(r.json.hub, 'skipped: --no-track');
    const { pid, args, config: seen } = JSON.parse(readFileSync(s.record, 'utf8'));
    assert.deepEqual(args, ['--cloud', 'Do the login page']);
    assert.equal(seen, config); // the caller's account reaches claude through the helper
    assert.equal(r.json.account, 'work');
    assert.ok(await waitFor(() => !isAlive(pid), 8000), 'the fake claude is still running');
    assert.equal(readFileSync(join(s.dir, 'sessions.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
  });

  test('a link in two pieces and a brief with the word login', async () => {
    const s = setup('partial-url');
    const r = await run(main, ['--cwd', s.cwd, '--brief', 'Not logged in? Fix the login flow.\nPlease run /login first.', '--no-track'], { env: s.env });
    assert.equal(r.json.session_id, 'session_TEST123', r.lines[0]);
  });

  test('a trust prompt fails and names itself', async () => {
    const s = setup('trust');
    const r = await run(main, ['--cwd', s.cwd, '--brief', 'Do it'], { env: s.env });
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.prompt, 'trust');
    assert.match(r.json.tail, /Do you trust the files in this folder\?/);
    const { pid } = JSON.parse(readFileSync(s.record, 'utf8'));
    assert.ok(await waitFor(() => !isAlive(pid), 8000), 'the fake claude is still running');
  });

  test('a login prompt fails and names itself', async () => {
    const s = setup('login');
    const r = await run(main, ['--cwd', s.cwd, '--brief', 'Do it'], { env: s.env });
    assert.equal(r.json.prompt, 'login');
  });

  test('silence ends in a timeout with the tail', async () => {
    const s = setup('silent');
    const r = await run(main, ['--cwd', s.cwd, '--brief', 'Do it', '--timeout', '3'], { env: s.env });
    assert.equal(r.code, 1);
    assert.equal(r.json.error, 'no cloud session URL within 3s');
    assert.match(r.json.tail, /Claude Code \(fake\)/);
    const { pid } = JSON.parse(readFileSync(s.record, 'utf8'));
    assert.ok(await waitFor(() => !isAlive(pid), 8000), 'the fake claude is still running');
  });

  test('claude ending early is reported with its exit code', async () => {
    const s = setup('exit1');
    const r = await run(main, ['--cwd', s.cwd, '--brief', 'Do it'], { env: s.env });
    assert.equal(r.code, 1);
    assert.match(r.json.error, /claude ended before it created a cloud session \(exit code 1\)/);
    assert.match(r.json.tail, /error: something went wrong/);
  });

  test('no data folder is left behind except the log and the (Windows) venv', async () => {
    const s = setup('ok');
    await run(main, ['--cwd', s.cwd, '--brief', 'Do it', '--no-track'], { env: s.env });
    assert.equal(existsSync(join(s.dir, 'hub.pid')), false);
    assert.equal(existsSync(join(s.dir, 'tracked.json')), false);
  });
});

describe('main with a Python that is not usable', () => {
  test('says so in JSON', async () => {
    const dir = tmp('hub');
    const env = cleanEnv({ CLOUD_PILOT_DIR: dir, CLOUD_PILOT_CLAUDE_BIN: FAKE_CLAUDE, CLOUD_PILOT_PYTHON: join(dir, 'no-python') });
    const r = await run(main, ['--cwd', tmp('repo'), '--brief', 'Do it'], { env });
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /CLOUD_PILOT_PYTHON is set to ".*no-python", which is not a working Python/);
  });
});
