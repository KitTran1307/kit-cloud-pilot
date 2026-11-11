#!/usr/bin/env node
// Starts a Claude Code cloud session from a shell that has no terminal, waits for its URL, closes the local client
// (the cloud session keeps running), registers the session with the cloud-pilot hub, and prints one JSON line.
//
//   node start/index.mjs [--cwd <repo>] (--brief-file <file> | --brief "<text>") [--branch claude/<slug>]
//                        [--title "<text>"] [--timeout <sec>] [--permission-mode <m>]
//                        [--model <m>] [--effort <e>] [--no-track] [--help]
//
// `claude --cloud <brief>` takes the brief as a command-line argument, so it is visible in the process list while the
// client runs: never put secrets in a brief.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addTrack, ensureHub, caller, accountName } from '../hub/hub.mjs';
import { paths, hubDir } from '../hub/lib/store.mjs';
import { setting } from '../hub/lib/config.mjs';
import {
  MAX_BRIEF, StartError, USAGE, analyze, checkBranch, checkBrief, checkDenied, checkEffort, checkMode, checkModel, claudeArgv, detectBranch, isLocalOnly, makeTitle,
  parseArgs, promptError, resolveClaude, tailOf,
} from './lib.mjs';
import { childExit, helperFailure, preparePython, startPty } from './runner.mjs';

const RAW_CAP = 400_000; // characters of terminal output kept for scanning
const SETTLE_MS = 400; // a session link at the very end of the output counts once nothing follows it for this long

// Waits for the first decisive thing claude prints. Resolves to { kind: 'url' | 'prompt' | 'timeout' | 'exit', ... }.
function collect(handle, { brief, timeoutMs, settleMs }) {
  return new Promise((resolvePromise) => {
    let raw = '';
    let done = false;
    let settleTimer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(settleTimer);
      clearTimeout(deadline);
      resolvePromise({ ...result, text: analyze(raw, { brief }).text });
    };
    // true while a link ends the output and more of it may still come
    const look = (settled) => {
      const a = analyze(raw, { brief, settled });
      if (a.kind === 'url' || a.kind === 'prompt') { finish(a); return false; }
      return a.settling;
    };
    const deadline = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    handle.onData((chunk) => {
      if (done) return;
      raw = (raw + chunk).slice(-RAW_CAP);
      clearTimeout(settleTimer);
      if (look(false)) settleTimer = setTimeout(() => look(true), settleMs);
    });
    handle.onClose((info) => {
      if (done) return;
      clearTimeout(settleTimer);
      look(true);
      finish({ kind: 'exit', info });
    });
  });
}

async function defaultStart({ argv, cwd, env }) {
  const python = preparePython({ env, dataDir: hubDir(env) });
  const handle = startPty({ python, argv, cwd, env });
  handle.explain = (info) => helperFailure(info, python);
  return handle;
}

function readBrief(args) {
  if (args.brief !== undefined) return checkBrief(args.brief);
  const file = resolve(args.briefFile);
  let text;
  try {
    if (statSync(file).size > MAX_BRIEF * 4 + 3) throw new StartError(`the brief file is larger than ${MAX_BRIEF} characters; keep the brief shorter (point at repository files instead of pasting them)`);
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof StartError) throw err;
    throw new StartError(`cannot read the brief file ${file}: ${err.code || err.message}`);
  }
  return checkBrief(text);
}

function isDirectory(dir) {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

// Registers the session with the hub. The session is already running, so nothing here may fail the start.
function track({ args, env, cwd, me, url, title, branch, p, spawnHub }) {
  if (!args.track) return 'skipped: --no-track';
  if (!me.gh) return 'skipped: no GitHub origin';
  try {
    const t = addTrack(p, { kind: 'branch', repo: me.gh, branch, url, title }, me, Date.now(), env);
    const hub = { id: t.id };
    try { ensureHub(p, { spawnHub }); } catch (err) { hub.daemon = `not started: ${String(err?.message ?? err).slice(0, 200)}`; }
    return hub;
  } catch (err) {
    return `failed: ${String(err?.message ?? err).slice(0, 200)}`;
  }
}

// One line per start, never the brief.
function logStart(p, row) {
  try {
    mkdirSync(p.dir, { recursive: true });
    appendFileSync(join(p.dir, 'sessions.jsonl'), `${JSON.stringify(row)}\n`);
  } catch { /* the log never breaks a start */ }
}

// opts (tests): env, out(line), start({ argv, cwd, env }) -> handle, spawnHub(p), settleMs.
// A handle is { onData(fn), onClose(fn), stop(), explain?(info) }, see startPty in runner.mjs.
export async function main(argv, opts = {}) {
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((line) => { process.stdout.write(`${line}\n`); });
  const say = (obj) => out(JSON.stringify(obj));
  let handle = null;
  try {
    const args = parseArgs(argv);
    if (args.help) { out(USAGE.trimEnd()); return 0; }

    const account = accountName(env.CLAUDE_CONFIG_DIR);
    if (isLocalOnly(account, setting('LOCAL_ONLY', env))) throw new StartError(`account ${account} is local-only (CLOUD_PILOT_LOCAL_ONLY)`);

    const brief = readBrief(args);
    const cwd = resolve(args.cwd ?? process.cwd());
    if (!isDirectory(cwd)) throw new StartError(`cwd not found: ${cwd}`);
    const branch = args.branch !== undefined ? checkBranch(args.branch) : detectBranch(brief);
    const title = makeTitle(args.title, brief);
    const claude = resolveClaude(env);
    if (claude.error) throw new StartError(claude.error);
    const envMode = setting('PERMISSION_MODE', env);
    const mode = args.permissionMode ?? (envMode ? checkMode(envMode) : undefined);
    const envModel = setting('MODEL', env);
    const model = checkDenied(args.model ?? (envModel ? checkModel(envModel) : undefined), setting('DENY_MODELS', env));
    const envEffort = setting('EFFORT', env);
    const effort = args.effort ?? (envEffort ? checkEffort(envEffort) : undefined);

    handle = await (opts.start ?? defaultStart)({ argv: claudeArgv(claude.prefix, brief, mode, { model, effort }), cwd, env });
    const res = await collect(handle, { brief, timeoutMs: args.timeoutSec * 1000, settleMs: opts.settleMs ?? SETTLE_MS });
    const explain = handle.explain;
    await handle.stop();
    handle = null;

    if (res.kind === 'prompt') throw new StartError(promptError(res.prompt, cwd), { prompt: res.prompt, tail: tailOf(res.text) });
    if (res.kind === 'timeout') throw new StartError(`no cloud session URL within ${args.timeoutSec}s`, { tail: tailOf(res.text) });
    if (res.kind === 'exit') {
      const why = explain ? explain(res.info) : '';
      const code = childExit(res.info);
      throw new StartError(why || `claude ended before it created a cloud session${code === null ? '' : ` (exit code ${code})`}`, { tail: tailOf(res.text) });
    }

    const me = caller(env, cwd);
    const p = paths(hubDir(env));
    const hub = track({ args, env, cwd, me, url: res.url, title, branch, p, spawnHub: opts.spawnHub });
    logStart(p, { time: new Date().toISOString(), account, repo: me.gh, branch, title, session_id: res.sessionId, url: res.url });
    say({ ok: true, session_id: res.sessionId, url: res.url, account_dir: env.CLAUDE_CONFIG_DIR ?? '', account, repo: me.gh, branch, hub });
    return 0;
  } catch (err) {
    if (handle) { try { await handle.stop(); } catch { /* already gone */ } }
    const extra = err instanceof StartError ? err.extra : {};
    const error = err instanceof StartError ? err.message : `unexpected error: ${err?.message ?? err}`;
    say({ ok: false, error, ...(extra.prompt ? { prompt: extra.prompt } : {}), ...(extra.tail ? { tail: extra.tail } : {}) });
    return 1;
  }
}

// Run as a script (also through a symlink, a relative path or another drive-letter case on Windows).
function isMain() {
  if (!process.argv[1]) return false;
  const norm = (f) => { let x = resolve(f); try { x = realpathSync(x); } catch { /* keep the resolved path */ } return process.platform === 'win32' ? x.toLowerCase() : x; };
  return norm(fileURLToPath(import.meta.url)) === norm(process.argv[1]);
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
