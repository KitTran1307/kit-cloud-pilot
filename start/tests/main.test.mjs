import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../index.mjs';
import { isAlive, paths } from '../../hub/lib/store.mjs';
import {
  FAKE_CLAUDE, cleanEnv, cleanup, hasGit, makeRepo, pipeStart, readJsonFile, run, samePath, tmp, waitFor,
} from './helpers.mjs';

after(cleanup);

const ORIGIN = 'https://github.com/acme/widgets.git';
const BRIEF = [
  'Add a pricing table to the landing page',
  '',
  'Work on branch claude/pricing-table and open a PR from it.',
  'BODY-SECRET-LINE: the discount code lives in the vault.',
  'Done = the table renders.',
].join('\n');

// One start: a fresh hub folder, a repo, a record file for what the fake claude received.
function setup({ origin = ORIGIN, mode = 'ok', env = {} } = {}) {
  const dir = tmp('hub');
  const record = join(dir, 'fake-record.json');
  const repo = makeRepo(origin);
  const spawned = [];
  const opts = {
    env: cleanEnv({ CLOUD_PILOT_DIR: dir, CLOUD_PILOT_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_RECORD: record, CLAUDE_CONFIG_DIR: join(dir, '.claude-work'), ...env }),
    start: pipeStart,
    spawnHub: (p) => spawned.push(p.dir),
    settleMs: 50,
  };
  return { dir, record, repo, spawned, opts, p: paths(dir) };
}
const started = (s) => readJsonFile(s.record);
const sessions = (s) => (existsSync(join(s.dir, 'sessions.jsonl')) ? readFileSync(join(s.dir, 'sessions.jsonl'), 'utf8').split('\n').filter(Boolean) : []);

describe('a successful start', () => {
  test('prints one JSON line, exit 0, and gives claude the brief as one argument', { skip: !hasGit && 'git is not installed' }, async () => {
    const s = setup();
    const r = await run(main, ['--cwd', s.repo, '--brief', BRIEF], s.opts);
    assert.equal(r.code, 0);
    assert.equal(r.lines.length, 1);
    assert.deepEqual(Object.keys(r.json), ['ok', 'session_id', 'url', 'account_dir', 'account', 'repo', 'branch', 'hub']);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.session_id, 'session_TEST123');
    assert.equal(r.json.url, 'https://claude.ai/code/session_TEST123');
    assert.equal(r.json.account_dir, join(s.dir, '.claude-work'));
    assert.equal(r.json.account, 'work');
    assert.equal(r.json.repo, 'acme/widgets');
    assert.equal(r.json.branch, 'claude/pricing-table');
    assert.deepEqual(started(s).args, ['--cloud', BRIEF]);
  });

  test('permission mode: the flag, else CLOUD_PILOT_PERMISSION_MODE, else none', { skip: !hasGit && 'git is not installed' }, async () => {
    const s = setup({ env: { CLOUD_PILOT_PERMISSION_MODE: 'auto' } });
    assert.equal((await run(main, ['--cwd', s.repo, '--brief', 'Do it'], s.opts)).code, 0);
    assert.deepEqual(started(s).args, ['--permission-mode', 'auto', '--cloud', 'Do it']);
    const s2 = setup({ env: { CLOUD_PILOT_PERMISSION_MODE: 'auto' } });
    await run(main, ['--cwd', s2.repo, '--brief', 'Do it', '--permission-mode', 'plan'], s2.opts);
    assert.deepEqual(started(s2).args, ['--permission-mode', 'plan', '--cloud', 'Do it']);
    const s3 = setup({ env: { CLOUD_PILOT_PERMISSION_MODE: 'bypassPermissions' } });
    const r3 = await run(main, ['--cwd', s3.repo, '--brief', 'Do it'], s3.opts);
    assert.equal(r3.code, 1);
    assert.match(r3.json.error, /no bypass mode/);
  });

  test('model and effort: the flags, else CLOUD_PILOT_MODEL / CLOUD_PILOT_EFFORT; CLOUD_PILOT_DENY_MODELS refuses', { skip: !hasGit && 'git is not installed' }, async () => {
    const env = { CLOUD_PILOT_MODEL: 'sonnet', CLOUD_PILOT_EFFORT: 'high', CLOUD_PILOT_DENY_MODELS: 'opus,fable' };
    const s = setup({ env });
    assert.equal((await run(main, ['--cwd', s.repo, '--brief', 'Do it'], s.opts)).code, 0);
    assert.deepEqual(started(s).args, ['--model', 'sonnet', '--effort', 'high', '--cloud', 'Do it']);
    const s2 = setup({ env });
    await run(main, ['--cwd', s2.repo, '--brief', 'Do it', '--model', 'haiku', '--effort', 'medium'], s2.opts);
    assert.deepEqual(started(s2).args, ['--model', 'haiku', '--effort', 'medium', '--cloud', 'Do it']);
    const s3 = setup({ env });
    const r3 = await run(main, ['--cwd', s3.repo, '--brief', 'Do it', '--model', 'opus'], s3.opts);
    assert.equal(r3.code, 1);
    assert.match(r3.json.error, /denied/);
    const s4 = setup({ env: { CLOUD_PILOT_DENY_MODELS: 'opus' } });
    const r4 = await run(main, ['--cwd', s4.repo, '--brief', 'Do it'], s4.opts);
    assert.equal(r4.code, 1);
    assert.match(r4.json.error, /give the session a model/);
  });

  test('claude runs in --cwd, with the caller environment', { skip: !hasGit && 'git is not installed' }, async () => {
    const s = setup();
    await run(main, ['--cwd', s.repo, '--brief', 'Do it'], s.opts);
    const rec = started(s);
    assert.ok(samePath(rec.cwd, s.repo), `${rec.cwd} is not ${s.repo}`);
    assert.equal(rec.config, join(s.dir, '.claude-work'));
  });

  test('the local client is closed afterwards', async () => {
    const s = setup({ origin: '' });
    await run(main, ['--cwd', s.repo, '--brief', 'Do it'], s.opts);
    const { pid } = started(s);
    assert.ok(await waitFor(() => !isAlive(pid)), `the fake claude (pid ${pid}) is still running`);
  });

  test('registers the session with the hub in-process, and starts no daemon', { skip: !hasGit && 'git is not installed' }, async () => {
    const s = setup();
    const r = await run(main, ['--cwd', s.repo, '--brief', BRIEF], s.opts);
    assert.equal(typeof r.json.hub.id, 'string');
    const tracked = readJsonFile(s.p.tracked, []);
    assert.equal(tracked.length, 1);
    const t = tracked[0];
    assert.equal(t.id, r.json.hub.id);
    assert.equal(t.kind, 'branch');
    assert.equal(t.repo, 'acme/widgets');
    assert.equal(t.branch, 'claude/pricing-table');
    assert.equal(t.url, 'https://claude.ai/code/session_TEST123');
    assert.equal(t.title, 'Add a pricing table to the landing page');
    assert.equal(t.owner.account, 'work');
    assert.equal(t.active, true);
    assert.deepEqual(s.spawned, [s.dir]); // ensureHub asked for the hub once, through the stub
    assert.equal(existsSync(s.p.pid), false); // nothing really ran
  });

  test('--branch and --title win over detection', { skip: !hasGit && 'git is not installed' }, async () => {
    const s = setup();
    const r = await run(main, ['--cwd', s.repo, '--brief', BRIEF, '--branch', 'claude/other', '--title', 'My title'], s.opts);
    assert.equal(r.json.branch, 'claude/other');
    const t = readJsonFile(s.p.tracked, [])[0];
    assert.equal(t.branch, 'claude/other');
    assert.equal(t.title, 'My title');
  });

  test('no branch line in the brief: the track has no branch', { skip: !hasGit && 'git is not installed' }, async () => {
    const s = setup();
    const r = await run(main, ['--cwd', s.repo, '--brief', 'Just do the thing\nsee claude/not-on-a-branch-line'], s.opts);
    assert.equal(r.json.branch, '');
    assert.equal(readJsonFile(s.p.tracked, [])[0].branch, '');
  });

  test('--no-track registers nothing', { skip: !hasGit && 'git is not installed' }, async () => {
    const s = setup();
    const r = await run(main, ['--cwd', s.repo, '--brief', BRIEF, '--no-track'], s.opts);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.hub, 'skipped: --no-track');
    assert.equal(existsSync(s.p.tracked), false);
    assert.deepEqual(s.spawned, []);
    assert.equal(sessions(s).length, 1); // still logged
  });

  test('a repository without a GitHub origin starts, and is not tracked', async () => {
    for (const origin of ['', 'https://gitlab.com/acme/widgets.git']) {
      const s = setup({ origin });
      const r = await run(main, ['--cwd', s.repo, '--brief', BRIEF], s.opts);
      assert.equal(r.json.ok, true, origin);
      assert.equal(r.json.hub, 'skipped: no GitHub origin');
      assert.equal(r.json.repo, '');
      assert.equal(existsSync(s.p.tracked), false);
      assert.deepEqual(s.spawned, []);
    }
  });

  test('a folder that is not a git repository starts, and is not tracked', async () => {
    const s = setup();
    const plain = tmp('plain');
    const r = await run(main, ['--cwd', plain, '--brief', 'Do it'], s.opts);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.hub, 'skipped: no GitHub origin');
  });

  test('the default --cwd is the current directory', async () => {
    const s = setup({ origin: '' });
    const r = await run(main, ['--brief', 'Do it'], s.opts);
    assert.equal(r.json.ok, true);
    assert.ok(samePath(started(s).cwd, process.cwd()));
  });

  test('a hub problem never fails a start that already succeeded', { skip: !hasGit && 'git is not installed' }, async () => {
    const s = setup();
    const daemon = await run(main, ['--cwd', s.repo, '--brief', BRIEF], { ...s.opts, spawnHub: () => { throw new Error('boom'); } });
    assert.equal(daemon.code, 0);
    assert.equal(daemon.json.hub.daemon, 'not started: boom');
    assert.equal(typeof daemon.json.hub.id, 'string');

    const blocked = tmp('blocked');
    const notADir = join(blocked, 'file');
    writeFileSync(notADir, 'x');
    const s2 = setup();
    const broken = await run(main, ['--cwd', s2.repo, '--brief', BRIEF], { ...s2.opts, env: { ...s2.opts.env, CLOUD_PILOT_DIR: join(notADir, 'sub') } });
    assert.equal(broken.code, 0);
    assert.equal(broken.json.ok, true);
    assert.match(broken.json.hub, /^failed: /);
  });
});

describe('what is parsed from claude output', () => {
  test('a link split in two pieces is read whole', async () => {
    const s = setup({ origin: '', mode: 'partial-url' });
    // the default settle time (400 ms) is longer than the 100 ms between the two pieces
    const r = await run(main, ['--cwd', s.repo, '--brief', 'Do it'], { ...s.opts, settleMs: undefined });
    assert.equal(r.json.session_id, 'session_TEST123');
  });

  test('a link that is the last thing printed counts once the output is quiet', async () => {
    const s = setup({ origin: '', mode: 'url-at-end' });
    const r = await run(main, ['--cwd', s.repo, '--brief', 'Do it'], s.opts);
    assert.equal(r.json.session_id, 'session_TEST123');
  });

  test('a session link inside the brief is not mistaken for the new session', async () => {
    const s = setup({ origin: '' });
    const r = await run(main, ['--cwd', s.repo, '--brief', 'Continue what https://claude.ai/code/session_OLD999 started'], s.opts);
    assert.equal(r.json.session_id, 'session_TEST123');
  });

  test('a brief full of the words login, trust and (y/n) is not taken for a prompt', async () => {
    const s = setup({ origin: '' });
    const brief = [
      'Fix the login page: when the user is not logged in, show the form.',
      'Not logged in \u00b7 Please run /login',
      'Do you trust the files in this folder?',
      'Ask the user (y/n) before they log in again.',
      'Select an environment',
    ].join('\n');
    const r = await run(main, ['--cwd', s.repo, '--brief', brief], s.opts);
    assert.equal(r.json.ok, true, r.lines[0]);
    assert.deepEqual(started(s).args, ['--cloud', brief]);
  });

  test('a brief that starts with a dash reaches claude as a value', async () => {
    const s = setup({ origin: '' });
    await run(main, ['--cwd', s.repo, '--brief', '--- notes\nbody'], s.opts);
    assert.equal(started(s).args[0], '--cloud');
    assert.equal(started(s).args[1], ' --- notes\nbody');
  });
});

describe('the brief', () => {
  test('from a file or from the flag: the same argument', async () => {
    const s = setup({ origin: '' });
    const file = join(s.dir, 'brief.md');
    writeFileSync(file, `\uFEFF${BRIEF}`); // with a byte-order mark
    const a = await run(main, ['--cwd', s.repo, '--brief-file', file], s.opts);
    assert.equal(a.json.ok, true);
    const fromFile = started(s).args;
    const b = await run(main, ['--cwd', s.repo, '--brief', BRIEF], s.opts);
    assert.equal(b.json.ok, true);
    assert.deepEqual(started(s).args, fromFile);
    assert.equal(fromFile[1], BRIEF);
  });

  test('a brief file that does not exist', async () => {
    const s = setup({ origin: '' });
    const r = await run(main, ['--cwd', s.repo, '--brief-file', join(s.dir, 'nope.md')], s.opts);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /cannot read the brief file/);
  });

  test('too long: refused before claude starts; exactly the limit is fine', async () => {
    const s = setup({ origin: '' });
    const r = await run(main, ['--cwd', s.repo, '--brief', 'x'.repeat(24001)], s.opts);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /24001 characters; keep it under 24000/);
    assert.equal(existsSync(s.record), false);
    const file = join(s.dir, 'long.md');
    writeFileSync(file, 'x'.repeat(24001));
    const f = await run(main, ['--cwd', s.repo, '--brief-file', file], s.opts);
    assert.match(f.json.error, /24000/);
    assert.equal(existsSync(s.record), false);
    const ok = await run(main, ['--cwd', s.repo, '--brief', 'x'.repeat(24000)], s.opts);
    assert.equal(ok.json.ok, true);
  });

  test('empty, missing, both: usage errors', async () => {
    const s = setup({ origin: '' });
    for (const [argv, re] of [
      [['--brief', '  '], /empty/],
      [[], /brief is required/],
      [['--brief', 'a', '--brief-file', 'b'], /not both/],
      [['--brief', 'a', '--bogus'], /unknown option/],
      [['--brief', 'a', '--timeout', 'soon'], /--timeout/],
      [['--brief', 'a', '--branch', 'main'], /claude\/<slug>/],
    ]) {
      const r = await run(main, argv, s.opts);
      assert.equal(r.code, 1, argv.join(' '));
      assert.equal(r.json.ok, false);
      assert.match(r.json.error, re);
    }
    assert.equal(existsSync(s.record), false);
  });
});

describe('local-only accounts', () => {
  test('refused with the documented message, before anything starts', async () => {
    const s = setup({ env: { CLOUD_PILOT_LOCAL_ONLY: 'other, work' } });
    const r = await run(main, ['--brief', 'Do it'], s.opts);
    assert.equal(r.code, 1);
    assert.deepEqual(r.json, { ok: false, error: 'account work is local-only (CLOUD_PILOT_LOCAL_ONLY)' });
    assert.equal(existsSync(s.record), false);
    assert.equal(sessions(s).length, 0);
  });

  test('the account is "default" without CLAUDE_CONFIG_DIR, and other accounts are allowed', async () => {
    const a = setup({ origin: '', env: { CLOUD_PILOT_LOCAL_ONLY: 'default', CLAUDE_CONFIG_DIR: '' } });
    const refused = await run(main, ['--brief', 'Do it'], a.opts);
    assert.equal(refused.json.error, 'account default is local-only (CLOUD_PILOT_LOCAL_ONLY)');
    const b = setup({ origin: '', env: { CLOUD_PILOT_LOCAL_ONLY: 'work' } });
    const allowed = await run(main, ['--brief', 'Do it'], { ...b.opts, env: { ...b.opts.env, CLAUDE_CONFIG_DIR: join(b.dir, '.claude-personal') } });
    assert.equal(allowed.json.ok, true);
    assert.equal(allowed.json.account, 'personal');
  });

  test('the older KIT_HUB_LOCAL_ONLY name works too', async () => {
    const s = setup({ env: { KIT_HUB_LOCAL_ONLY: 'work' } });
    const r = await run(main, ['--brief', 'Do it'], s.opts);
    assert.match(r.json.error, /account work is local-only/);
  });
});

describe('sessions.jsonl', () => {
  test('one line per start, with no brief text', { skip: !hasGit && 'git is not installed' }, async () => {
    const s = setup();
    await run(main, ['--cwd', s.repo, '--brief', BRIEF], s.opts);
    await run(main, ['--cwd', s.repo, '--brief', BRIEF, '--no-track'], s.opts);
    const file = readFileSync(join(s.dir, 'sessions.jsonl'), 'utf8');
    const rows = file.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.deepEqual(Object.keys(rows[0]), ['time', 'account', 'repo', 'branch', 'title', 'session_id', 'url']);
    assert.match(rows[0].time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
    assert.equal(rows[0].account, 'work');
    assert.equal(rows[0].repo, 'acme/widgets');
    assert.equal(rows[0].branch, 'claude/pricing-table');
    assert.equal(rows[0].title, 'Add a pricing table to the landing page');
    assert.equal(rows[0].session_id, 'session_TEST123');
    assert.equal(rows[0].url, 'https://claude.ai/code/session_TEST123');
    assert.ok(!file.includes('BODY-SECRET-LINE'));
    assert.ok(!file.includes('discount code'));
    assert.ok(!file.includes('open a PR'));
  });

  test('a failed start writes nothing', async () => {
    const s = setup({ origin: '', mode: 'trust' });
    await run(main, ['--cwd', s.repo, '--brief', 'Do it'], s.opts);
    assert.deepEqual(sessions(s), []);
  });

  test('the default title is the first non-empty line, at most 200 characters', async () => {
    const s = setup({ origin: '' });
    await run(main, ['--cwd', s.repo, '--brief', `\n\n${'T'.repeat(300)}\nbody`], s.opts);
    assert.equal(JSON.parse(sessions(s)[0]).title, 'T'.repeat(200));
  });
});

describe('failures', () => {
  const FAIL_SHAPE = (r) => {
    assert.equal(r.code, 1);
    assert.equal(r.lines.length, 1);
    assert.equal(r.json.ok, false);
    assert.equal(typeof r.json.error, 'string');
    for (const key of Object.keys(r.json)) assert.ok(['ok', 'error', 'tail', 'prompt'].includes(key), key);
  };

  for (const [mode, prompt, line] of [
    ['trust', 'trust', /Do you trust the files in this folder\?/],
    ['login', 'login', /Not logged in/],
    ['picker', 'picker', /Select an environment/],
    ['confirm', 'confirm', /\(y\/n\)/],
  ]) {
    test(`a ${prompt} prompt fails with which one, never answers, and closes claude`, async () => {
      const s = setup({ origin: '', mode });
      const r = await run(main, ['--cwd', s.repo, '--brief', 'Do it'], s.opts);
      FAIL_SHAPE(r);
      assert.equal(r.json.prompt, prompt);
      assert.match(r.json.error, new RegExp(`${prompt} prompt`));
      assert.match(r.json.tail, line);
      assert.ok(await waitFor(() => !isAlive(started(s).pid)));
    });
  }

  test('timeout: the error says how long, the tail is clean text', async () => {
    const s = setup({ origin: '', mode: 'silent' });
    const t0 = Date.now();
    const r = await run(main, ['--cwd', s.repo, '--brief', 'Do it', '--timeout', '1'], s.opts);
    FAIL_SHAPE(r);
    assert.equal(r.json.error, 'no cloud session URL within 1s');
    assert.match(r.json.tail, /Claude Code \(fake\)/);
    assert.match(r.json.tail, /> Do it/);
    assert.ok(!r.json.tail.includes('\x1b'));
    assert.ok(Date.now() - t0 < 6000);
    assert.ok(await waitFor(() => !isAlive(started(s).pid)));
  });

  test('the tail is at most 2000 characters', async () => {
    const s = setup({ origin: '', mode: 'silent' });
    const long = Array.from({ length: 400 }, (_, i) => `step ${i}`).join('\n'); // echoed by the fake claude
    const r = await run(main, ['--cwd', s.repo, '--brief', long, '--timeout', '1'], s.opts);
    assert.equal(r.json.tail.length, 2000);
    assert.ok(r.json.tail.endsWith('step 399'));
  });

  test('claude ends before it creates a session', async () => {
    const s = setup({ origin: '', mode: 'exit1' });
    const r = await run(main, ['--cwd', s.repo, '--brief', 'Do it'], s.opts);
    FAIL_SHAPE(r);
    assert.match(r.json.error, /claude ended before it created a cloud session/);
    assert.match(r.json.tail, /error: something went wrong/);
    assert.deepEqual(sessions(s), []);
  });

  test('claude not found', async () => {
    const s = setup({ origin: '', env: { CLOUD_PILOT_CLAUDE_BIN: join(tmp('none'), 'claude-missing.mjs') } });
    const r = await run(main, ['--cwd', s.repo, '--brief', 'Do it'], s.opts);
    FAIL_SHAPE(r);
    assert.match(r.json.error, /claude not found: CLOUD_PILOT_CLAUDE_BIN is set to/);
    const bare = setup({ origin: '', env: { CLOUD_PILOT_CLAUDE_BIN: '', PATH: tmp('emptypath'), Path: tmp('emptypath') } });
    const r2 = await run(main, ['--cwd', bare.repo, '--brief', 'Do it'], bare.opts);
    assert.match(r2.json.error, /claude not found: install Claude Code/);
  });

  test('cwd that does not exist', async () => {
    const s = setup({ origin: '' });
    const r = await run(main, ['--cwd', join(s.dir, 'missing'), '--brief', 'Do it'], s.opts);
    FAIL_SHAPE(r);
    assert.match(r.json.error, /^cwd not found: /);
    assert.equal(existsSync(s.record), false);
  });

  test('an unexpected error is reported as JSON too', async () => {
    const s = setup({ origin: '' });
    const r = await run(main, ['--cwd', s.repo, '--brief', 'Do it'], { ...s.opts, start: async () => { throw new TypeError('kaput'); } });
    FAIL_SHAPE(r);
    assert.equal(r.json.error, 'unexpected error: kaput');
  });
});

describe('--help', () => {
  test('prints the usage and returns 0', async () => {
    const lines = [];
    const code = await main(['--help'], { out: (l) => lines.push(l), env: cleanEnv() });
    assert.equal(code, 0);
    const text = lines.join('\n');
    assert.match(text, /Usage: node start\/index\.mjs/);
    for (const flag of ['--cwd', '--brief-file', '--brief', '--branch', '--title', '--timeout', '--no-track', '--help']) assert.ok(text.includes(flag), flag);
  });
});
