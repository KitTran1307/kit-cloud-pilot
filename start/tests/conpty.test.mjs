// The Windows terminal path with nothing to install: conpty.ps1 under Windows PowerShell, driven through startPty as
// `start` drives it. Skipped off Windows, and where ConPTY is unavailable (it then says why).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { canConpty, conptyHelper, helperFailure, prepareHelper, startPty, PTY_SCRIPT } from '../runner.mjs';
import { cleanEnv, cleanup, tmp } from './helpers.mjs';

after(cleanup);

const skip = process.platform !== 'win32'
  ? 'ConPTY is Windows only'
  : !canConpty()
    ? 'ConPTY is unavailable here (Windows older than 10 1809, or PowerShell cannot compile its helper)'
    : false;

// Runs argv through the ConPTY helper; resolves { out, info } once the helper ends, stopping it after `stopAfterMs`.
function runPty(argv, { stopAfterMs = null } = {}) {
  const h = startPty({ helper: conptyHelper(), argv, cwd: tmp('cwd'), env: cleanEnv(), rows: 40, cols: 120 });
  let out = '';
  h.onData((t) => { out += t; });
  if (stopAfterMs !== null) setTimeout(() => { void h.stop(); }, stopAfterMs);
  return new Promise((resolve) => h.onClose((info) => resolve({ out, info })));
}

describe('conpty.ps1', { skip }, () => {
  test('gives the command a terminal and relays its output and exit code', async () => {
    const { out, info } = await runPty([process.execPath, '-e', "console.log('tty=' + process.stdout.isTTY + ' hello-from-conpty'); process.exit(3)"]);
    assert.equal(info.code, 0);
    assert.match(out, /tty=true hello-from-conpty/);
    assert.match(info.stderr, /pty_run: child exited with code 3/);
    assert.doesNotMatch(info.stderr, /CLIXML/);
  });

  test('closing stdin stops a command that keeps running', async () => {
    const started = Date.now();
    const { out, info } = await runPty([process.execPath, '-e', "console.log('running'); setInterval(() => {}, 1000)"], { stopAfterMs: 2500 });
    assert.equal(info.code, 0);
    assert.match(out, /running/);
    assert.ok(Date.now() - started < 15000, 'stopped promptly');
    assert.doesNotMatch(info.stderr, /child exited/);
  });

  test('a missing program is exit 4 with a plain reason', async () => {
    const { info } = await runPty(['no-such-program-kit-cloud-pilot']);
    assert.equal(info.code, 4);
    assert.match(helperFailure(info, conptyHelper()), /^claude could not be started: cannot start no-such-program-kit-cloud-pilot: not found/);
  });

  test('an argument with spaces and quotes arrives whole', async () => {
    const { out } = await runPty([process.execPath, '-e', 'console.log(JSON.stringify(process.argv[1]))', 'a b "c"']);
    assert.match(out, /"a b \\"c\\""/);
  });
});

describe('prepareHelper', () => {
  const ok = () => '';
  const refuse = () => { throw new Error('no'); };

  test('Windows uses ConPTY when it works: no Python is looked for', () => {
    const calls = [];
    const h = prepareHelper({ env: {}, platform: 'win32', dataDir: tmp('d'), exec: (cmd, args) => { calls.push(cmd); return ok(); } });
    assert.equal(h.cmd, 'powershell.exe');
    assert.ok(h.args.includes('-EncodedCommand'));
    assert.deepEqual(calls, ['powershell.exe']);
  });

  test('Windows falls back to Python when ConPTY is unavailable', () => {
    const exec = (cmd, args) => (cmd === 'powershell.exe' ? refuse() : args.includes('--check') ? '' : '3.12\n');
    const h = prepareHelper({ env: {}, platform: 'win32', dataDir: tmp('d'), exec });
    assert.equal(h.cmd, 'python3');
    assert.equal(h.args.at(-1), PTY_SCRIPT);
  });

  test('CLOUD_PILOT_PYTHON keeps Python on Windows; macOS and Linux use Python', () => {
    const exec = (cmd, args) => (cmd === 'powershell.exe' ? assert.fail('ConPTY not asked') : args.includes('--check') ? '' : '3.12\n');
    assert.equal(prepareHelper({ env: { CLOUD_PILOT_PYTHON: 'C:/py/python.exe' }, platform: 'win32', dataDir: tmp('d'), exec }).cmd, 'C:/py/python.exe');
    assert.equal(prepareHelper({ env: {}, platform: 'linux', dataDir: tmp('d'), exec }).cmd, 'python3');
  });
});
