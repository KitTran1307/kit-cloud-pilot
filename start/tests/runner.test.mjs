import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { StartError } from '../lib.mjs';
import { canPty, findPython, helperFailure, preparePython, pythonCandidates } from '../runner.mjs';
import { cleanup, tmp } from './helpers.mjs';

after(cleanup);

// A stand-in for execFileSync: `script(cmd, args)` returns the text to print, or throws.
function fakeExec(script) {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    return script(cmd, args, opts);
  };
  exec.calls = calls;
  return exec;
}
const isProbe = (args) => args.includes('-c');
const isCheck = (args) => args.includes('--check');
const refuse = () => { throw Object.assign(new Error('Command failed'), { stderr: 'not found' }); };

describe('finding Python', () => {
  test('the candidates: python3, python, and on Windows also py -3', () => {
    assert.deepEqual(pythonCandidates({}, 'linux'), [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }]);
    assert.deepEqual(pythonCandidates({}, 'win32').map((c) => [c.cmd, ...c.args].join(' ')), ['python3', 'python', 'py -3']);
  });
  test('CLOUD_PILOT_PYTHON replaces the list', () => {
    assert.deepEqual(pythonCandidates({ CLOUD_PILOT_PYTHON: '/opt/py' }, 'linux'), [{ cmd: '/opt/py', args: [] }]);
  });
  test('the first that answers with a version of 3.7 or newer', () => {
    const exec = fakeExec((cmd) => { if (cmd === 'python3') refuse(); return '3.11\n'; });
    assert.deepEqual(findPython({ env: {}, platform: 'linux', exec }), { cmd: 'python', args: [], version: '3.11' });
  });
  test('a too old Python, a Store stub and a failing Python are skipped', () => {
    const answers = { python3: '3.6\n', python: 'Python was not found; run without arguments to install from the Microsoft Store\n' };
    const exec = fakeExec((cmd, args) => { if (cmd === 'py') { assert.deepEqual(args.slice(0, 1), ['-3']); return '3.12\n'; } return answers[cmd]; });
    assert.equal(findPython({ env: {}, platform: 'win32', exec }).cmd, 'py');
    assert.equal(findPython({ env: {}, platform: 'linux', exec: fakeExec(refuse) }), null);
    assert.equal(findPython({ env: {}, platform: 'linux', exec: fakeExec(() => '2.7\n') }), null);
  });
  test('every probe runs Python isolated', () => {
    const exec = fakeExec(() => '3.12\n');
    findPython({ env: {}, platform: 'linux', exec });
    assert.ok(exec.calls[0].includes('-I'));
  });
});

describe('preparePython', () => {
  test('no Python at all: says what to install', () => {
    assert.throws(() => preparePython({ env: {}, platform: 'linux', dataDir: tmp('d'), exec: fakeExec(refuse) }), (e) => e instanceof StartError && /Python 3\.7 or newer is required/.test(e.message) && /python\.org/.test(e.message) && /CLOUD_PILOT_PYTHON/.test(e.message));
  });
  test('a CLOUD_PILOT_PYTHON that does not work is named', () => {
    assert.throws(() => preparePython({ env: { CLOUD_PILOT_PYTHON: '/no/py' }, platform: 'linux', dataDir: tmp('d'), exec: fakeExec(refuse) }), /CLOUD_PILOT_PYTHON is set to "\/no\/py"/);
  });
  test('macOS and Linux use the Python as it is: no venv, no install', () => {
    const exec = fakeExec((cmd, args) => (isProbe(args) ? '3.12\n' : ''));
    const py = preparePython({ env: {}, platform: 'linux', dataDir: tmp('d'), exec });
    assert.equal(py.cmd, 'python3');
    assert.ok(!exec.calls.some((c) => c.includes('venv') || c.includes('pip')));
  });
  test('macOS and Linux: a Python without the pty module is refused', () => {
    const exec = fakeExec((cmd, args) => { if (isCheck(args)) refuse(); return '3.12\n'; });
    assert.throws(() => preparePython({ env: {}, platform: 'linux', dataDir: tmp('d'), exec }), /no "pty" module/);
  });
  test('Windows: a Python that already has pywinpty is used as it is', () => {
    const exec = fakeExec((cmd, args) => (isProbe(args) ? '3.12\n' : ''));
    const py = preparePython({ env: {}, platform: 'win32', dataDir: tmp('d'), exec });
    assert.equal(py.cmd, 'python3');
    assert.ok(!exec.calls.some((c) => c.includes('venv') || c.includes('pip')));
  });
  test('Windows: an existing venv with pywinpty is reused', () => {
    const dir = tmp('d');
    const vpy = join(dir, 'venv', 'Scripts', 'python.exe');
    const exec = fakeExec((cmd, args) => { if (isProbe(args)) return '3.12\n'; if (isCheck(args) && cmd !== vpy) refuse(); return ''; });
    const py = preparePython({ env: {}, platform: 'win32', dataDir: dir, exec, exists: (f) => f === vpy });
    assert.equal(py.cmd, vpy);
    assert.ok(!exec.calls.some((c) => c.includes('venv') || c.includes('pip')));
  });
  test('Windows: first use creates the venv under the data folder, installs pywinpty, then checks it', () => {
    const dir = tmp('d');
    const vpy = join(dir, 'venv', 'Scripts', 'python.exe');
    let created = false;
    let installed = false;
    const exec = fakeExec((cmd, args) => {
      if (isProbe(args)) return '3.12\n';
      if (args.includes('venv')) { created = true; return ''; }
      if (args.includes('pip')) { assert.equal(cmd, vpy); installed = true; return ''; }
      if (isCheck(args)) { if (cmd === vpy && installed) return ''; refuse(); }
      return '';
    });
    const py = preparePython({ env: {}, platform: 'win32', dataDir: dir, exec, exists: (f) => created && f === vpy });
    assert.equal(py.cmd, vpy);
    const flat = exec.calls.map((c) => c.join(' '));
    const venvCall = flat.find((c) => c.includes('-m venv'));
    assert.ok(venvCall.includes(join(dir, 'venv')));
    const pip = flat.find((c) => c.includes('pip'));
    assert.match(pip, /-m pip install --disable-pip-version-check --quiet pywinpty==3\.1\.2$/);
    assert.ok(flat.indexOf(venvCall) < flat.indexOf(pip));
    assert.equal(existsSync(join(dir, 'venv.lock')), false); // the lock is released
  });
  test('Windows: a failing install says what to run by hand', () => {
    const dir = tmp('d');
    const vpy = join(dir, 'venv', 'Scripts', 'python.exe');
    let created = false;
    const exec = fakeExec((cmd, args) => {
      if (isProbe(args)) return '3.12\n';
      if (args.includes('venv')) { created = true; return ''; }
      if (args.includes('pip')) throw Object.assign(new Error('x'), { stderr: 'ERROR: No matching distribution found for pywinpty' });
      refuse();
    });
    assert.throws(() => preparePython({ env: {}, platform: 'win32', dataDir: dir, exec, exists: (f) => created && f === vpy }), (e) => {
      assert.ok(e instanceof StartError);
      assert.match(e.message, /installing pywinpty failed: .*No matching distribution/);
      assert.match(e.message, /Run these once, then retry:/);
      assert.match(e.message, /-m venv /);
      assert.match(e.message, /-m pip install pywinpty==3\.1\.2/);
      return true;
    });
    assert.equal(existsSync(join(dir, 'venv.lock')), false);
  });
  test('Windows: a venv that cannot be created is reported', () => {
    const exec = fakeExec((cmd, args) => { if (isProbe(args)) return '3.12\n'; refuse(); });
    assert.throws(() => preparePython({ env: {}, platform: 'win32', dataDir: tmp('d'), exec, exists: () => false }), /creating the virtual environment failed/);
  });
});

describe('the helper and its failures', () => {
  test('canPty runs the helper with --check, isolated', () => {
    const exec = fakeExec(() => '');
    assert.equal(canPty({ cmd: 'py', args: ['-3'] }, exec), true);
    assert.deepEqual(exec.calls[0].slice(0, 3), ['py', '-3', '-I']);
    assert.ok(exec.calls[0].at(-1) === '--check');
    assert.equal(canPty({ cmd: 'py', args: [] }, fakeExec(refuse)), false);
  });
  test('exit status 3, 4 and other failures are explained', () => {
    const py = { cmd: 'python3', args: [] };
    assert.match(helperFailure({ code: 3, stderr: 'pty_run: pseudo-terminal backend missing (x)' }, py), /no pseudo-terminal available: pseudo-terminal backend missing/);
    assert.match(helperFailure({ code: 4, stderr: 'pty_run: cannot start /x/claude: not found' }, py), /^claude could not be started: cannot start \/x\/claude: not found/);
    assert.match(helperFailure({ code: 9, stderr: 'Traceback' }, py), /terminal helper failed \(exit 9\)/);
    assert.equal(helperFailure({ code: 0, stderr: '' }, py), '');
  });
});
