import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { alertKinds, alertLink, alertEnv, runNotifyCommand, postNtfy, alertEvents } from '../lib/alerts.mjs';

for (const k of Object.keys(process.env)) if (/^(KIT_HUB|CLOUD_PILOT)_/.test(k)) delete process.env[k];

const MARK = 'ZXQ-SECRET-MARKER';
const PAYLOAD = `${MARK}"; rm -rf / #\`id\` $(id)\n`;
const goodEv = () => ({ kind: 'ci-failed', urgent: true, repo: 'octo/demo', branch: 'claude/fix-x', url: 'https://claude.ai/code/session_1', pr: 7, pr_url: 'https://github.com/octo/demo/pull/7' });

function fakeSpawn() {
  const calls = [];
  const kills = [];
  const children = [];
  const spawn = (cmd, opts) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.kill = (...a) => kills.push(a);
    child.unref = () => { child.unrefed = true; };
    calls.push({ cmd, opts });
    children.push(child);
    return child;
  };
  return { spawn, calls, kills, children };
}

function fakeFetch(res = { ok: true, status: 200 }) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); if (res instanceof Error) throw res; return res; };
  return { fetch, calls };
}

test('alertKinds: default list, custom list, bad tokens dropped', () => {
  assert.deepEqual([...alertKinds({})], ['question', 'question_stale', 'question_waiting', 'ci-failed', 'conflict', 'no-push', 'merged', 'abandoned']);
  assert.deepEqual([...alertKinds({ CLOUD_PILOT_NOTIFY_KINDS: ' Merged , ci-failed ' })], ['merged', 'ci-failed']);
  assert.deepEqual([...alertKinds({ CLOUD_PILOT_NOTIFY_KINDS: 'merged,bad kind,$(x),,a'.concat(',', 'x'.repeat(41)) })], ['merged', 'a']);
  assert.ok(!alertKinds({}).has('pr-opened'));
});

test('alertLink: session link, else PR link, only when plain https', () => {
  assert.equal(alertLink(goodEv()), 'https://claude.ai/code/session_1');
  assert.equal(alertLink({ pr_url: 'https://github.com/o/r/pull/1' }), 'https://github.com/o/r/pull/1');
  assert.equal(alertLink({ url: 'javascript:alert(1)', pr_url: 'https://github.com/o/r/pull/1' }), 'https://github.com/o/r/pull/1');
  assert.equal(alertLink({ url: 'http://x.example/a', pr_url: 'ftp://x' }), '');
  for (const bad of ['https://a.example/a b', 'https://a.example/\nx', 'https://a.example/\u202ex', 'https://a.example/\u2066x', 'https://a.example/\u0085x', `https://a.example/${'a'.repeat(501)}`]) {
    assert.equal(alertLink({ url: bad }), '', JSON.stringify(bad));
  }
  assert.equal(alertLink({}), '');
});

test('alertEnv: exactly the six event variables, stale ones overwritten', () => {
  const env = alertEnv(goodEv(), { PATH: '/bin', CLOUD_PILOT_EVENT_STALE: 'old', CLOUD_PILOT_EVENT_REPO: 'stale/stale' });
  const keys = Object.keys(env).filter((k) => k.startsWith('CLOUD_PILOT_EVENT_')).sort();
  assert.deepEqual(keys, ['CLOUD_PILOT_EVENT_BRANCH', 'CLOUD_PILOT_EVENT_KIND', 'CLOUD_PILOT_EVENT_PR', 'CLOUD_PILOT_EVENT_REPO', 'CLOUD_PILOT_EVENT_URGENT', 'CLOUD_PILOT_EVENT_URL']);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CLOUD_PILOT_EVENT_KIND, 'ci-failed');
  assert.equal(env.CLOUD_PILOT_EVENT_REPO, 'octo/demo');
  assert.equal(env.CLOUD_PILOT_EVENT_BRANCH, 'claude/fix-x');
  assert.equal(env.CLOUD_PILOT_EVENT_PR, '7');
  assert.equal(env.CLOUD_PILOT_EVENT_URL, 'https://claude.ai/code/session_1');
  assert.equal(env.CLOUD_PILOT_EVENT_URGENT, '1');
  assert.equal(alertEnv({ ...goodEv(), urgent: 'yes' }, {}).CLOUD_PILOT_EVENT_URGENT, '0');
});

test('alertEnv: hostile values are blanked', () => {
  const env = alertEnv({ kind: 'ci failed\n', repo: 'o/r\nx', branch: 'claude/a/../b', url: 'javascript:alert(1)', pr: -3, pr_url: 'https://x.example/a b' }, {});
  assert.equal(env.CLOUD_PILOT_EVENT_KIND, '');
  assert.equal(env.CLOUD_PILOT_EVENT_REPO, '');
  assert.equal(env.CLOUD_PILOT_EVENT_BRANCH, '');
  assert.equal(env.CLOUD_PILOT_EVENT_PR, '');
  assert.equal(env.CLOUD_PILOT_EVENT_URL, '');
  assert.equal(env.CLOUD_PILOT_EVENT_URGENT, '0');
  for (const branch of ['main', 'claude/x y', 'claude/x\n', 'claude/\u202ex']) assert.equal(alertEnv({ branch }, {}).CLOUD_PILOT_EVENT_BRANCH, '', JSON.stringify(branch));
  for (const pr of [1.5, '7', 0, NaN]) assert.equal(alertEnv({ pr }, {}).CLOUD_PILOT_EVENT_PR, '', String(pr));
  assert.equal(alertEnv({ repo: 'a b/c' }, {}).CLOUD_PILOT_EVENT_REPO, '');
});

test('runNotifyCommand: spawn options, and untrusted text never reaches the command', () => {
  const { spawn, calls } = fakeSpawn();
  const ev = { ...goodEv(), title: PAYLOAD, untrusted_title: PAYLOAD, untrusted_question: PAYLOAD, untrusted_text: PAYLOAD };
  runNotifyCommand(ev, { env: { CLOUD_PILOT_NOTIFY_CMD: 'my-notify --flag', PATH: '/bin' }, spawn, log: () => {} });
  assert.equal(calls.length, 1);
  const { cmd, opts } = calls[0];
  assert.equal(cmd, 'my-notify --flag');
  assert.equal(opts.shell, true);
  assert.equal(opts.detached, process.platform !== 'win32', 'detached except on Windows (a console window would show)');
  assert.equal(opts.stdio, 'ignore');
  assert.equal(opts.windowsHide, true);
  assert.equal(typeof opts.cwd, 'string');
  assert.ok(!JSON.stringify(calls).includes(MARK));
  assert.ok(!Object.values(opts.env).some((v) => String(v).includes(MARK)));
  assert.ok(!Object.keys(opts.env).some((k) => k.includes('TITLE') || k.includes('QUESTION') || k.includes('TEXT')));
});

test('runNotifyCommand: not configured means no spawn; the child is unref-ed', () => {
  const a = fakeSpawn();
  runNotifyCommand(goodEv(), { env: {}, spawn: a.spawn });
  runNotifyCommand(goodEv(), { env: { CLOUD_PILOT_NOTIFY_CMD: '' }, spawn: a.spawn });
  assert.equal(a.calls.length, 0);
  runNotifyCommand(goodEv(), { env: { KIT_HUB_NOTIFY_CMD: 'x' }, spawn: a.spawn });
  assert.equal(a.calls.length, 1);
  assert.equal(a.children[0].unrefed, true);
});

test('runNotifyCommand: a hung command is killed after the timeout and logged', async () => {
  const { spawn, kills, children, calls } = fakeSpawn();
  const lines = [];
  const realKill = process.kill;
  const groupKills = [];
  process.kill = (pid, sig) => { groupKills.push([pid, sig]); };
  try {
    runNotifyCommand(goodEv(), { env: { CLOUD_PILOT_NOTIFY_CMD: 'sleep 99' }, spawn, log: (l) => lines.push(l), timeoutMs: 10 });
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    process.kill = realKill;
  }
  if (process.platform === 'win32') assert.ok(calls.some((c) => c.cmd === 'taskkill'), 'the whole tree is ended with taskkill /T /F');
  else assert.deepEqual(groupKills, [[-4242, undefined]]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^alert command failed: timed out/);
  children[0].emit('exit', null, 'SIGTERM'); // the kill's exit is not logged a second time
  assert.equal(lines.length, 1);
});

test('runNotifyCommand: a command that exits in time cancels the timer; kill errors are swallowed', async () => {
  const { spawn, children } = fakeSpawn();
  const lines = [];
  const realKill = process.kill;
  let killed = 0;
  process.kill = () => { killed++; throw new Error('ESRCH'); };
  try {
    runNotifyCommand(goodEv(), { env: { CLOUD_PILOT_NOTIFY_CMD: 'ok' }, spawn, log: (l) => lines.push(l), timeoutMs: 10 });
    children[0].emit('exit', 0, null);
    runNotifyCommand(goodEv(), { env: { CLOUD_PILOT_NOTIFY_CMD: 'hang' }, spawn, log: (l) => lines.push(l), timeoutMs: 10 });
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    process.kill = realKill;
  }
  assert.equal(lines.length, 1); // only the hung one, and the throwing kill did not escape
  if (process.platform !== 'win32') assert.equal(killed, 1);
});

test('runNotifyCommand: spawn error, non-zero exit and a throwing spawn are logged, never thrown', () => {
  const { spawn, children } = fakeSpawn();
  const lines = [];
  runNotifyCommand(goodEv(), { env: { CLOUD_PILOT_NOTIFY_CMD: 'x' }, spawn, log: (l) => lines.push(l) });
  children[0].emit('error', Object.assign(new Error('boom'), { code: 'ENOENT' }));
  assert.deepEqual(lines, ['alert command failed: ENOENT']);
  runNotifyCommand(goodEv(), { env: { CLOUD_PILOT_NOTIFY_CMD: 'x' }, spawn, log: (l) => lines.push(l) });
  children[1].emit('exit', 3, null);
  assert.equal(lines[1], 'alert command failed: exit 3 (ci-failed)');
  runNotifyCommand(goodEv(), { env: { CLOUD_PILOT_NOTIFY_CMD: 'x' }, spawn, log: (l) => lines.push(l) });
  children[2].emit('exit', 0, null);
  assert.equal(lines.length, 2);
  assert.doesNotThrow(() => runNotifyCommand(goodEv(), { env: { CLOUD_PILOT_NOTIFY_CMD: 'x' }, spawn: () => { throw new Error('nope'); }, log: (l) => lines.push(l) }));
  assert.equal(lines[2], 'alert command failed: nope');
  assert.ok(!lines.join('\n').includes('octo/demo'));
});

test('postNtfy: URL, body and headers exactly', async () => {
  const { fetch, calls } = fakeFetch();
  await postNtfy(goodEv(), { env: { CLOUD_PILOT_NTFY_TOPIC: 'my_topic-1' }, fetch });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ntfy.sh/my_topic-1');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, 'ci-failed · octo/demo#7');
  assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'text/plain; charset=utf-8', Click: 'https://claude.ai/code/session_1' });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('postNtfy: no Click without a link, no #pr without a pr, no repo part without a safe repo', async () => {
  const { fetch, calls } = fakeFetch();
  const env = { CLOUD_PILOT_NTFY_TOPIC: 't' };
  await postNtfy({ kind: 'merged', repo: 'o/r', url: 'javascript:x' }, { env, fetch });
  assert.equal(calls[0].init.body, 'merged · o/r');
  assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'text/plain; charset=utf-8' });
  await postNtfy({ kind: 'merged', repo: 'bad repo', pr: 3 }, { env, fetch });
  assert.equal(calls[1].init.body, 'merged');
  assert.ok(!JSON.stringify(calls).includes(MARK));
  await postNtfy({ ...goodEv(), title: PAYLOAD, untrusted_text: PAYLOAD }, { env, fetch });
  assert.ok(!JSON.stringify(calls[2]).includes(MARK));
});

test('postNtfy: custom url with trailing slashes, invalid url, invalid topic', async () => {
  const { fetch, calls } = fakeFetch();
  const lines = [];
  const log = (l) => lines.push(l);
  await postNtfy(goodEv(), { env: { CLOUD_PILOT_NTFY_TOPIC: 't', CLOUD_PILOT_NTFY_URL: 'http://ntfy.local:8080//' }, fetch, log });
  assert.equal(calls[0].url, 'http://ntfy.local:8080/t');
  await postNtfy(goodEv(), { env: { CLOUD_PILOT_NTFY_TOPIC: 't', CLOUD_PILOT_NTFY_URL: 'ftp://x.example' }, fetch, log });
  await postNtfy(goodEv(), { env: { CLOUD_PILOT_NTFY_TOPIC: 't', CLOUD_PILOT_NTFY_URL: 'not a url' }, fetch, log });
  assert.equal(calls.length, 1);
  assert.equal(lines.length, 2);
  for (const topic of ['a/b', 'a b', 'x'.repeat(65), 'a\nb']) await postNtfy(goodEv(), { env: { CLOUD_PILOT_NTFY_TOPIC: topic }, fetch, log });
  assert.equal(calls.length, 1);
  assert.equal(lines.length, 6);
  assert.equal(lines[2], 'ntfy topic ignored: use letters, digits, - and _ (up to 64)');
});

test('postNtfy: no topic or no fetch is quiet; non-2xx and thrown errors are logged', async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  const { fetch, calls } = fakeFetch();
  await postNtfy(goodEv(), { env: {}, fetch, log });
  await postNtfy(goodEv(), { env: { CLOUD_PILOT_NTFY_TOPIC: 't' }, fetch: null, log });
  assert.equal(calls.length, 0);
  assert.deepEqual(lines, []);
  await postNtfy(goodEv(), { env: { CLOUD_PILOT_NTFY_TOPIC: 't' }, fetch: fakeFetch({ ok: false, status: 503 }).fetch, log });
  assert.deepEqual(lines, ['ntfy failed: 503']);
  await postNtfy(goodEv(), { env: { CLOUD_PILOT_NTFY_TOPIC: 't' }, fetch: fakeFetch(new Error('x'.repeat(300))).fetch, log });
  assert.equal(lines[1], `ntfy failed: ${'x'.repeat(120)}`);
});

test('alertEvents: nothing configured means no spawn and no fetch', async () => {
  const s = fakeSpawn();
  const f = fakeFetch();
  const lines = [];
  await alertEvents([goodEv()], { env: { PATH: '/bin' }, spawn: s.spawn, fetch: f.fetch, log: (l) => lines.push(l) });
  assert.equal(s.calls.length + f.calls.length + lines.length, 0);
});

test('alertEvents: kinds filter applies to both channels', async () => {
  const s = fakeSpawn();
  const f = fakeFetch();
  const env = { CLOUD_PILOT_NOTIFY_CMD: 'n', CLOUD_PILOT_NTFY_TOPIC: 't' };
  await alertEvents([goodEv(), { ...goodEv(), kind: 'pr-opened' }, { ...goodEv(), kind: 'merged' }], { env, spawn: s.spawn, fetch: f.fetch });
  assert.deepEqual(s.calls.map((c) => c.opts.env.CLOUD_PILOT_EVENT_KIND), ['ci-failed', 'merged']);
  assert.deepEqual(f.calls.map((c) => c.init.body.split(' ')[0]), ['ci-failed', 'merged']);

  const s2 = fakeSpawn();
  await alertEvents([goodEv(), { ...goodEv(), kind: 'merged' }], { env: { ...env, CLOUD_PILOT_NOTIFY_KINDS: 'merged,pr-opened' }, spawn: s2.spawn, fetch: fakeFetch().fetch });
  assert.deepEqual(s2.calls.map((c) => c.opts.env.CLOUD_PILOT_EVENT_KIND), ['merged']);
});

test('alertEvents: only the configured channel runs, and it never throws', async () => {
  const s = fakeSpawn();
  const f = fakeFetch();
  await alertEvents([goodEv()], { env: { CLOUD_PILOT_NOTIFY_CMD: 'n' }, spawn: s.spawn, fetch: f.fetch });
  assert.equal(s.calls.length, 1);
  assert.equal(f.calls.length, 0);
  await alertEvents([goodEv()], { env: { CLOUD_PILOT_NTFY_TOPIC: 't' }, spawn: s.spawn, fetch: f.fetch });
  assert.equal(s.calls.length, 1);
  assert.equal(f.calls.length, 1);
  await assert.doesNotReject(alertEvents(null, { env: { CLOUD_PILOT_NOTIFY_CMD: 'n' } }));
  await assert.doesNotReject(alertEvents([null, undefined, 5], { env: { CLOUD_PILOT_NOTIFY_CMD: 'n', CLOUD_PILOT_NTFY_TOPIC: 't' }, spawn: s.spawn, fetch: f.fetch }));
  await assert.doesNotReject(alertEvents([goodEv()], { env: { CLOUD_PILOT_NOTIFY_CMD: 'n', CLOUD_PILOT_NTFY_TOPIC: 't' }, spawn: () => { throw new Error('x'); }, fetch: fakeFetch(new Error('y')).fetch }));
});

test('alert link: shell metacharacters never pass (cmd.exe would run what follows &)', async () => {
  const { alertLink } = await import('../lib/alerts.mjs');
  assert.equal(alertLink({ url: 'https://claude.ai/code/session_01ABC?from=cli&m=0' }), 'https://claude.ai/code/session_01ABC', 'the query is dropped');
  assert.equal(alertLink({ url: 'https://a.b/&echo PWNED', pr_url: 'https://github.com/o/r/pull/7' }), 'https://github.com/o/r/pull/7');
  for (const bad of ['https://a.b/%PATH%', 'https://a.b/|x', 'https://a.b/^x', 'https://a.b/"x', 'https://a.b/$x', 'https://a.b/`x`', 'https://a.b/<x>']) assert.equal(alertLink({ url: bad }), '');
  assert.equal(alertLink({ url: 'https://claude.ai/code/session_01ABC' }), 'https://claude.ai/code/session_01ABC');
});
