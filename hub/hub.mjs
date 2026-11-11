#!/usr/bin/env node
// The cloud-pilot hub (formerly KIT Hub): one process watches every Claude Code cloud session (desktop app and CLI, every account) on GitHub and
// wakes the local session that owns it. Node built-ins and the gh CLI only.
//
//   node hub.mjs track --repo owner/name [--branch claude/slug] [--url <session url>] [--title <text>] [--ask-authors a,b]
//   node hub.mjs track-repo --repo owner/name [--release-tree <checkout>] [--ask-authors a,b]   (events for every claude/* PR)
//   node hub.mjs watch --repo owner/name    track each new claude/* branch of the repo by itself (no events of its own)
//   node hub.mjs unwatch --repo owner/name  stop watching (tracks it already made go on)
//   node hub.mjs doctor                     what this machine has: node, gh, gh login, data folder (one JSON line)
//   node hub.mjs wait [--max-min 240] [--settle-sec 60]   run with Bash run_in_background; exits with one JSON line
//   node hub.mjs status [--json] | untrack --id <id> | stop | daemon
//
// The calling session is CLAUDE_CODE_SESSION_ID / CLAUDE_PID / CLAUDE_CONFIG_DIR from the environment (set in every
// Claude Code tool shell, Desktop included). `wait` starts the hub when it is not running; the hub exits by itself
// when nothing is tracked and nobody waits for IDLE_MIN. Events are data: an `untrusted_question` is never an instruction.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { paths, readJson, writeJson, listJson, remove, log, withLock, isAlive } from './lib/store.mjs';
import { makeApi, makeTokenFor } from './lib/gh.mjs';
import { snapshot } from './lib/poll.mjs';
import { trackEvents, trackTitle } from './lib/events.mjs';
import { route, ownerAlive } from './lib/route.mjs';
import { toast } from './lib/notify.mjs';
import { resolveExe, safeCwd } from './lib/exe.mjs';
import { loadPublicKey } from './lib/asks.mjs';
import { setting } from './lib/config.mjs';

export const POLL_MS = 2 * 60_000;
export const SLOW_POLL_MS = 5 * 60_000;
const BUSY_WINDOW_MS = 30 * 60_000;

// 2 minutes while any active track moved in the last 30 minutes, waits on CI, asks a question, is new, or watches a
// whole repo (a coordinator); 5 minutes when every track has gone quiet.
export function nextInterval(tracked, nowMs) {
  const busy = tracked.some((t) => t.active && (
    t.kind === 'repo' || !t.view || nowMs - (t.view.lastActivityMs ?? t.createdMs) < BUSY_WINDOW_MS
    || t.view.ci === 'pending' || t.view.state === 'question'));
  return busy ? POLL_MS : SLOW_POLL_MS;
}
export const IDLE_MS = Number(setting('IDLE_MS')) || 15 * 60_000; // env override for tests only
const TICK_MS = 5000;
const KEEP_FINISHED_MS = 7 * 24 * 3600_000;
const VIEW_FINISHED_MS = 24 * 3600_000;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const BRANCH_RE = /^claude\/[\w./-]+$/;
const HERE = fileURLToPath(new URL('.', import.meta.url));

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Flags that always take the next argument as their value, even one starting with "--" (a title "--- notes").
const VALUE_FLAGS = new Set(['repo', 'branch', 'url', 'title', 'ask-authors', 'release-tree', 'id', 'max-min', 'settle-sec', 'waiter-pid', 'since', 'timeout']);

export function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`);
    const eq = a.indexOf('=');
    if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; } // --title=<value>
    const key = a.slice(2);
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(key)) {
      if (next === undefined) throw new Error(`--${key} needs a value`);
      out[key] = next;
      i += 1;
    } else if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

const str = (v) => (typeof v === 'string' ? v : '');

export function accountName(configDir) {
  // Either separator on every OS: the same name whether the path came from Windows or POSIX.
  const base = String(configDir || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  return base.startsWith('.claude-') ? base.slice('.claude-'.length) : 'default';
}

// `cwd` is the repository to ask (git -C); the git process itself starts in the home folder and is found on PATH
// without looking in the current folder, so a checkout cannot supply its own git.
function git(cwd, args) {
  try {
    return execFileSync(resolveExe('git'), ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10000, cwd: safeCwd() }).trim();
  } catch {
    return '';
  }
}

export function ghSlug(remote) {
  const m = String(remote).match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  return m ? m[1] : '';
}

export function caller(env = process.env, cwd = process.cwd()) {
  const repoRoot = git(cwd, ['rev-parse', '--show-toplevel']) || cwd;
  return {
    sessionId: env.CLAUDE_CODE_SESSION_ID || `manual-${process.ppid}`,
    pid: Number(env.CLAUDE_PID) || process.ppid,
    account: accountName(env.CLAUDE_CONFIG_DIR),
    repoRoot,
    gh: ghSlug(git(cwd, ['remote', 'get-url', 'origin'])),
  };
}

// Unique even for two tracks made in the same millisecond.
const trackId = (repo, branch, ms) => createHash('sha1').update(`${repo}#${branch}#${ms}#${randomUUID()}`).digest('hex').slice(0, 10);

// ---- client commands ------------------------------------------------------------------------------------------------

// CLOUD_PILOT_DELETE_MERGED=1 in the environment of whoever registers a track: delete its claude/* branch once its PR
// merged (only while the tip is still the merged head). Stored on the track, so a hub already running follows each
// track's own setting and a later change applies to tracks registered after it.
export const deleteMergedEnabled = (env = process.env) => setting('DELETE_MERGED', env) === '1';
export const notifyEnabled = (env = process.env) => !(setting('NOTIFY', env) === '0' || setting('NO_TOAST', env) === '1');

export function addTrack(p, spec, owner, nowMs = Date.now(), env = process.env) {
  // Discovered branches belong to whoever pushed them (maybe a teammate): never deleted, whatever the watcher set.
  const prefs = { deleteMerged: spec.discoveredBy ? false : (spec.deleteMerged ?? deleteMergedEnabled(env)), notify: spec.notify ?? notifyEnabled(env) };
  if (!REPO_RE.test(spec.repo ?? '')) throw new Error('--repo must look like owner/name');
  if (spec.kind === 'branch' && spec.branch && (!BRANCH_RE.test(spec.branch) || spec.branch.includes('..'))) throw new Error('--branch must be claude/<slug>');
  return withLock(p, () => {
    const list = readJson(p.tracked, []);
    const same = list.find((t) => t.active && t.kind === spec.kind && t.repo.toLowerCase() === spec.repo.toLowerCase()
      && (spec.kind === 'repo' ? Boolean(t.discover) === Boolean(spec.discover) && (!spec.discover || (t.owner?.account ?? '') === (owner?.account ?? ''))
        : (spec.branch ? t.branch === spec.branch : t.url && t.url === spec.url)));
    if (same) {
      Object.assign(same, { owner, ...(same.discoveredBy ? {} : prefs), url: spec.url || same.url, title: spec.title || same.title, releaseTree: spec.releaseTree || same.releaseTree, askAuthors: spec.askAuthors ?? same.askAuthors });
      if (same.discoveredBy && spec.title && !spec.discoveredBy) same.localTitle = true; // a title the local session gave: shown as it is
      writeJson(p.tracked, list, { backup: true });
      return { ...same, updated: true };
    }
    const t = {
      id: trackId(spec.repo, spec.branch || (spec.discover ? 'watch' : spec.kind), nowMs), kind: spec.kind, repo: spec.repo, branch: spec.branch || '',
      url: spec.url || '', title: (spec.title || '').slice(0, 200), releaseTree: spec.releaseTree || '', askAuthors: spec.askAuthors ?? null,
      ...(spec.discover ? { discover: true } : {}), ...(spec.discoveredBy ? { discoveredBy: spec.discoveredBy } : {}), ...prefs,
      owner, createdMs: nowMs, active: true, memo: {}, view: null,
    };
    list.push(t);
    writeJson(p.tracked, list, { backup: true });
    return t;
  });
}

export function untrack(p, id) {
  return withLock(p, () => {
    const list = readJson(p.tracked, []);
    const t = list.find((x) => x.id === id);
    if (!t) return false;
    t.active = false;
    t.endedMs = Date.now();
    t.view = { ...(t.view ?? {}), state: 'untracked', detail: 'untracked' };
    writeJson(p.tracked, list, { backup: true });
    return true;
  });
}

// Every track the session owns gets its current pid (a resumed session keeps its id, not its pid).
export function refreshOwnerPid(p, me) {
  withLock(p, () => {
    const list = readJson(p.tracked, []);
    let changed = false;
    for (const t of list) {
      if (t.active && t.owner?.sessionId === me.sessionId && t.owner.pid !== me.pid) { t.owner = { ...t.owner, pid: me.pid }; changed = true; }
    }
    if (changed) writeJson(p.tracked, list, { backup: true });
  });
}

export const HEARTBEAT_MS = 30_000;
// Longer than any single poll step (a gh call times out at 60 s, the release git fetch at 120 s); the daemon also beats
// between gh calls, so a slow poll never looks like a dead hub and never lets a second one start.
export const HUB_STALE_MS = 10 * HEARTBEAT_MS;
// The hub counts as running only while its pid lives AND it wrote a heartbeat lately: a pid left by a crash or a
// reboot may now belong to another process.
export function hubAlive(p, { nowMs = Date.now(), aliveFn = isAlive } = {}) {
  const rec = readJson(p.pid, null);
  if (!rec || !aliveFn(rec.pid)) return null;
  return nowMs - (rec.heartbeatMs ?? rec.startedMs ?? 0) < HUB_STALE_MS ? rec : null;
}

export function ensureHub(p, { spawnHub = defaultSpawn } = {}) {
  if (hubAlive(p)) return false;
  spawnHub(p);
  return true;
}

function defaultSpawn(p) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon'], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CLOUD_PILOT_DIR: p.dir },
    cwd: safeCwd(), // the daemon never runs inside a repository: every tool it starts is looked up from the home folder
  });
  child.unref();
}

function queueFile(p, sessionId) {
  return `${p.queues}/${sessionId.replace(/[^\w.-]/g, '_')}.json`;
}

const QUEUE_MAX = 500;

// Call inside withLock. Past QUEUE_MAX the oldest non-urgent events go; urgent ones (questions, merges) never do.
export function enqueue(p, sessionId, events) {
  if (!events.length) return;
  const file = queueFile(p, sessionId);
  const q = [...readJson(file, [], { cache: true }), ...events];
  let extra = q.length - QUEUE_MAX;
  const kept = extra > 0 ? q.filter((e) => (extra > 0 && !e.urgent ? (extra -= 1, false) : true)) : q;
  writeJson(file, kept);
}

// Call inside withLock: an heir takes over what was queued for the dead owner.
export function moveQueue(p, fromSession, toSession) {
  if (!fromSession || fromSession === toSession) return 0;
  const from = queueFile(p, fromSession);
  const old = readJson(from, [], { cache: true });
  if (!old.length) return 0;
  enqueue(p, toSession, old.map((e) => ({ ...e, handed_over: true })));
  writeJson(from, []);
  return old.length;
}

// One check of the caller's queue: { events } to report now, { settleMs } still settling, or null (empty).
export function peekQueue(p, sessionId, { nowMs = Date.now(), settleMs = 60_000 } = {}) {
  return withLock(p, () => {
    const file = queueFile(p, sessionId);
    const q = readJson(file, [], { cache: true });
    if (!q.length) return null;
    const oldest = Math.min(...q.map((e) => e.at ?? nowMs));
    const left = settleMs - (nowMs - oldest);
    if (!q.some((e) => e.urgent) && left > 0) return { settleMs: left };
    writeJson(file, []);
    return { events: q };
  });
}

export function takeReady(p, sessionId, opts = {}) {
  return peekQueue(p, sessionId, opts)?.events ?? null;
}

export function ownsActive(p, sessionId) {
  return readJson(p.tracked, []).some((t) => t.active && t.owner?.sessionId === sessionId);
}

function cmdWait(p, flags, { now = Date.now, nap = sleep, out = console.log } = {}) {
  const me = caller();
  const maxMs = Math.min(Number(flags['max-min'] ?? 240), 1440) * 60_000;
  const settleMs = Math.min(Number(flags['settle-sec'] ?? 60), 600) * 1000;
  const waiterFile = waiterFileOf(p, me.sessionId, process.pid);
  writeJson(waiterFile, { ...me, waiterPid: process.pid, since: now() });
  markWaiting(p, me.sessionId, true);
  ensureHub(p);
  const start = now();
  let lastEnsure = start;
  try {
    for (;;) {
      const ready = takeReady(p, me.sessionId, { nowMs: now(), settleMs });
      if (ready) { out(JSON.stringify({ status: 'events', count: ready.length, events: ready })); return; }
      if (now() - start > 10_000 && !ownsActive(p, me.sessionId)) { out(JSON.stringify({ status: 'nothing-tracked' })); return; }
      if (now() - start >= maxMs) { out(JSON.stringify({ status: 'timeout', waited_min: Math.round(maxMs / 60000) })); return; }
      if (now() - lastEnsure > 60_000) { ensureHub(p); lastEnsure = now(); }
      nap(2000);
    }
  } finally {
    remove(waiterFile);
    if (!liveWaiters(p).some((w) => w.sessionId === me.sessionId)) markWaiting(p, me.sessionId, false);
  }
}

// The light waiter (hub-wait.sh) keeps a bash loop alive (a few MB) and calls node only to begin, to take events once
// its queue file holds some, and to end. These three are its steps.
function waiterFileOf(p, sessionId, waiterPid) {
  return `${p.waiters}/${sessionId.replace(/[^\w.-]/g, '_')}.${waiterPid}.json`;
}

// state.json's `waiting` list follows a waiter at once (the hub rewrites the whole file only on its next poll).
export function markWaiting(p, sessionId, on) {
  try { withLock(p, () => {
    const st = readJson(p.state, null);
    if (!st || !Array.isArray(st.waiting)) return;
    const set = new Set(st.waiting);
    if (on) set.add(sessionId); else set.delete(sessionId);
    writeJson(p.state, { ...st, waiting: [...set] });
  }); } catch { /* the next poll writes the list anyway */ }
}

function cmdWaitBegin(p, flags) {
  const me = caller();
  const waiterPid = Number(flags['waiter-pid']);
  if (!Number.isInteger(waiterPid) || waiterPid <= 0) throw new Error('--waiter-pid must be the waiting process id');
  writeJson(waiterFileOf(p, me.sessionId, waiterPid), { ...me, waiterPid, since: Date.now() });
  markWaiting(p, me.sessionId, true);
  refreshOwnerPid(p, me);
  ensureHub(p);
  console.log(queueFile(p, me.sessionId));
}

// Prints one JSON line: events / settling (with how long to sleep) / nothing-tracked; prints nothing when idle.
function cmdWaitTake(p, flags) {
  const me = caller();
  const settleMs = Math.min(Number(flags['settle-sec'] ?? 60), 600) * 1000;
  const since = Number(flags.since ?? 0) * 1000;
  ensureHub(p);
  const got = peekQueue(p, me.sessionId, { settleMs });
  if (got?.events) { console.log(JSON.stringify({ status: 'events', count: got.events.length, events: got.events })); return; }
  if (got?.settleMs) { console.log(JSON.stringify({ status: 'settling', retry_sec: Math.max(1, Math.ceil(got.settleMs / 1000)) })); return; }
  if (since && Date.now() - since > 10_000 && !ownsActive(p, me.sessionId)) {
    console.log(JSON.stringify({ status: 'nothing-tracked' }));
  }
}

function cmdWaitEnd(p, flags) {
  const me = caller();
  remove(waiterFileOf(p, me.sessionId, Number(flags['waiter-pid'])));
  if (!liveWaiters(p).some((w) => w.sessionId === me.sessionId)) markWaiting(p, me.sessionId, false);
  if (flags.timeout) console.log(JSON.stringify({ status: 'timeout', waited_min: Number(flags.timeout) }));
}

function cmdStatus(p, flags) {
  const state = readJson(p.state, { rows: [] }, { cache: true });
  const hub = hubAlive(p);
  if (flags.json) { console.log(JSON.stringify({ hub, ...state })); return; }
  console.log(`cloud-pilot hub: ${hub ? `running (pid ${hub.pid})` : 'not running'} · updated ${state.updatedMs ? new Date(state.updatedMs).toLocaleTimeString() : '-'}`);
  if (state.errors && Object.keys(state.errors).length) console.log(`Errors: ${JSON.stringify(state.errors)}`);
  for (const r of state.rows ?? []) {
    console.log(`${r.active ? '*' : '-'} ${String(r.account).padEnd(7)} ${r.repo.padEnd(34)} ${(r.branch || (r.kind === 'repo' ? '(whole repo)' : '(no branch)')).padEnd(30)} ${r.detail ?? ''}  ${r.url ?? ''}`);
  }
  if (!(state.rows ?? []).length) console.log('No cloud sessions are tracked.');
}

// ---- the daemon -----------------------------------------------------------------------------------------------------

// Waiters whose waiting process still runs. Files of dead waiters are removed.
function liveWaiters(p, aliveFn = isAlive) {
  const out = [];
  for (const f of listJson(p.waiters)) {
    const w = readJson(f, null, { cache: true });
    if (w && aliveFn(w.waiterPid)) out.push(w);
    else remove(f);
  }
  return out;
}

export function writeState(p, extra = {}, nowMs = Date.now(), aliveFn = isAlive) {
  const rows = readJson(p.tracked, [])
    .filter((t) => t.active || nowMs - (t.endedMs ?? t.createdMs) < VIEW_FINISHED_MS)
    .map((t) => ({
      id: t.id, kind: t.kind, repo: t.repo, branch: t.branch, url: t.url, title: trackTitle(t) ?? t.title, active: t.active,
      ...(t.discover ? { discover: true } : {}), ...(t.discoveredBy ? { discovered: true } : {}),
      account: t.owner?.account, ownerSessionId: t.owner?.sessionId, repoRoot: t.owner?.repoRoot, createdMs: t.createdMs,
      ...(t.view ?? { state: 'working', detail: 'waiting for the first check', lastActivityMs: t.createdMs }),
    }))
    .sort((a, b) => b.createdMs - a.createdMs);
  // Who still listens, and what waits unread per owner: a band can warn a session that owns live tracks but whose
  // waiter died (killed for memory, closed). Its queue is kept until a new waiter takes it.
  const owners = [...new Set(rows.filter((r) => r.active && r.ownerSessionId).map((r) => r.ownerSessionId))];
  const queued = Object.fromEntries(owners.map((sid) => [sid, readJson(queueFile(p, sid), [], { cache: true }).length]).filter(([, n]) => n > 0));
  const waiting = [...new Set(liveWaiters(p, aliveFn).map((w) => w.sessionId))];
  writeJson(p.state, { updatedMs: nowMs, rows, waiting, queued, ...extra });
}

export const ERROR_STREAK = 3; // consecutive failed polls of a repo before its owners get an "error" event
export const ERROR_GIVE_UP_MS = 24 * 3600_000; // continuous errors this long end the track
export const TOAST_EVERY_MS = 3600_000; // at most one toast per track per hour
export const PARK_REPO_AFTER_MS = 12 * 3600_000; // a repo track with nobody alive this long stops (no endless polling)

// Call inside withLock: deliver a track's events (owner, heir, or orphaned + a rate-limited toast).
function deliver(p, t, events, waiters, { nowMs, aliveFn, notify }) {
  const dest = route(t, waiters, aliveFn);
  const handed = dest.newOwner && dest.newOwner.sessionId !== t.owner?.sessionId;
  if (handed) {
    log(p, `track ${t.id} handed from ${t.owner?.sessionId} to ${dest.newOwner.sessionId}`);
    moveQueue(p, t.owner?.sessionId, dest.newOwner.sessionId);
  }
  if (dest.newOwner) t.owner = dest.newOwner;
  enqueue(p, dest.to, events.map((e) => ({ ...e, at: nowMs, account: t.owner?.account, ...(handed ? { handed_over: true } : {}) })));
  log(p, `events ${t.id} -> ${dest.to}: ${events.map((e) => e.kind).join(',')}`);
  if (dest.orphaned) {
    t.orphanedSinceMs ??= nowMs;
    const urgent = events.some((e) => e.urgent);
    if (urgent && t.notify !== false && nowMs - (t.lastToastMs ?? 0) >= TOAST_EVERY_MS) {
      t.lastToastMs = nowMs;
      const first = events.find((e) => e.urgent) ?? events[0];
      notify('cloud-pilot', `${t.repo} ${t.branch || ''}: ${first.kind}${events.length > 1 ? ` (+${events.length - 1})` : ''} - its local session has ended; open Claude to handle it`);
    }
  } else delete t.orphanedSinceMs;
}

// One poll of every repo with active tracks. Injected for tests: api, publicKey, nowMs, notify, aliveFn, cleanup.
export function pollOnce(p, { api, publicKey = null, nowMs = Date.now(), notify = toast, aliveFn = isAlive, cleanup } = {}) {
  const active = readJson(p.tracked, []).filter((t) => t.active);
  const snaps = readJson(p.snapshots, {}, { cache: true });
  const errors = {};
  const waiters = liveWaiters(p, aliveFn);
  const ctx = { nowMs, aliveFn, notify };
  for (const repo of [...new Set(active.map((t) => t.repo))]) {
    let tracks = active.filter((t) => t.repo === repo);
    try {
      if (adoptBranches(p, api, repo, tracks, nowMs).length) tracks = readJson(p.tracked, []).filter((t) => t.active && t.repo === repo);
    } catch (err) { log(p, `adopt ${repo} failed: ${String(err.message).slice(0, 200)}`); }
    let now;
    try {
      now = snapshot(api, repo, tracks, { nowMs, publicKey, prev: snaps[repo] });
    } catch (err) {
      errors[repo] = String(err.message).slice(0, 300);
      log(p, `poll ${repo} failed: ${errors[repo]}`);
      withLock(p, () => { // after ERROR_STREAK failures in a row the owners hear it once
        const list = readJson(p.tracked, []);
        for (const t of list.filter((x) => x.active && x.repo === repo)) {
          t.memo = { ...(t.memo ?? {}), errStreak: (t.memo?.errStreak ?? 0) + 1, errSinceMs: t.memo?.errSinceMs ?? nowMs };
          if (t.memo.errStreak === ERROR_STREAK) deliver(p, t, [{ kind: 'error', urgent: true, repo, branch: t.branch || undefined, url: t.url || undefined, trackId: t.id, message: errors[repo] }], waiters, ctx);
          if (nowMs - t.memo.errSinceMs >= ERROR_GIVE_UP_MS) { // a deleted repo is not polled forever
            t.active = false; t.endedMs = nowMs;
            t.view = { ...(t.view ?? {}), state: 'error', detail: `stopped: GitHub unreadable for ${Math.round(ERROR_GIVE_UP_MS / 3600000)} h` };
            deliver(p, t, [{ kind: 'error', urgent: true, final: true, repo, branch: t.branch || undefined, url: t.url || undefined, trackId: t.id, message: `${errors[repo]} (tracking stopped)` }], waiters, ctx);
          }
        }
        writeJson(p.tracked, list, { backup: true });
      });
      continue;
    }
    for (const t0 of tracks) {
      const r = trackEvents(t0, snaps[repo], now, nowMs);
      let mergedOk = false;
      withLock(p, () => {
        const list = readJson(p.tracked, []);
        const t = list.find((x) => x.id === t0.id);
        if (!t || !t.active) return; // untracked meanwhile
        t.memo = { ...r.memo, errStreak: 0, errSinceMs: null };
        t.view = r.view;
        t.lastPolledMs = nowMs;
        if (!r.active) { t.active = false; t.endedMs = nowMs; }
        if (r.events.length) {
          try { deliver(p, t, r.events, waiters, ctx); } catch (err) { log(p, `deliver ${t.id} failed: ${err.message}`); }
        }
        else if (!ownerAlive(t, waiters, aliveFn)) t.orphanedSinceMs ??= nowMs;
        else delete t.orphanedSinceMs;
        if (t.kind === 'repo' && t.orphanedSinceMs && nowMs - t.orphanedSinceMs >= PARK_REPO_AFTER_MS) {
          t.active = false; t.endedMs = nowMs;
          t.view = { ...(t.view ?? {}), state: 'parked', detail: 'stopped: no local session is watching' };
          log(p, `repo track ${t.id} parked: no live session for ${Math.round(PARK_REPO_AFTER_MS / 3600000)} h`);
        }
        mergedOk = r.events.some((e) => e.kind === 'merged');
        writeJson(p.tracked, list, { backup: true });
      });
      if ((cleanup ?? t0.deleteMerged === true) && mergedOk && t0.kind === 'branch' && t0.branch) cleanupBranch(p, api, repo, t0.branch, r.events.find((e) => e.kind === 'merged'));
    }
    discover(p, repo, tracks, snaps[repo], now, nowMs);
    snaps[repo] = now;
    writeJson(p.snapshots, snaps); // per repo: a crash later in the loop does not replay this repo's events
  }
  const live = new Set(active.map((t) => t.repo));
  if (Object.keys(snaps).some((repo) => !live.has(repo))) {
    for (const repo of Object.keys(snaps)) if (!live.has(repo)) delete snaps[repo];
    writeJson(p.snapshots, snaps);
  }
  api.flush?.();
  return { errors, waiters: waiters.length, active: active.length };
}

// A cloud session is told its branch (claude/<slug>) but usually pushes claude/<slug>-<random> (claude/fix-login-a1-968lrs
// for claude/fix-login). A branch track whose own branch never showed up adopts such a branch: the newest one whose tip is
// not older than the track, that no other track owns and that no longer registered slug claims. The track keeps its id, owner
// and settings (deleteMerged included); a track the repo watcher made for that branch meanwhile ends and hands over its memo.
export const ADOPT_WINDOW_MS = 4 * 3600_000; // a track looks for its real branch this long after it was made
const ADOPT_SLACK_MS = 10 * 60_000; // a tip this much older than the track still counts (the session pushed before the track)
const toMsOf = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN);

export function adoptBranches(p, api, repo, tracks, nowMs = Date.now()) {
  const lower = repo.toLowerCase();
  const want = tracks.filter((t) => t.active && t.kind === 'branch' && t.branch && !t.requestedBranch && !t.discoveredBy
    && !t.memo?.sawBranch && nowMs - t.createdMs < ADOPT_WINDOW_MS);
  if (!want.length) return [];
  const adopted = [];
  for (const t of want) {
    const rows = api.get(`repos/${repo}/git/matching-refs/heads/${t.branch.split('/').map(encodeURIComponent).join('/')}`) ?? [];
    const names = (Array.isArray(rows) ? rows : []).map((r) => String(r?.ref ?? '').replace(/^refs\/heads\//, ''));
    if (names.includes(t.branch)) continue; // its own branch exists: nothing to adopt
    const all = readJson(p.tracked, []).filter((x) => x.active && x.kind === 'branch' && x.repo.toLowerCase() === lower);
    const claims = (x, b) => b === x.branch || b.startsWith(`${x.requestedBranch || x.branch}-`);
    const cands = names.filter((b) => b.startsWith(`${t.branch}-`) && BRANCH_RE.test(b) && !b.includes('..')
      // a longer registered slug (claude/email-templates beside claude/email) or a track already on it wins
      && !all.some((x) => x.id !== t.id && !x.discoveredBy && (x.branch === b || (claims(x, b) && (x.requestedBranch || x.branch).length > t.branch.length))));
    let best = null;
    for (const b of cands) {
      const head = api.get(`repos/${repo}/branches/${encodeURIComponent(b)}`);
      const tipMs = toMsOf(head?.commit?.commit?.committer?.date);
      if (!Number.isFinite(tipMs) || tipMs < t.createdMs - ADOPT_SLACK_MS) continue; // an older session's branch
      if (!best || tipMs > best.tipMs) best = { branch: b, tipMs };
    }
    if (!best) continue;
    withLock(p, () => {
      const list = readJson(p.tracked, []);
      const me = list.find((x) => x.id === t.id);
      if (!me || !me.active || me.requestedBranch) return;
      const twin = list.find((x) => x.active && x.id !== me.id && x.kind === 'branch' && x.repo.toLowerCase() === lower && x.branch === best.branch);
      if (twin && !twin.discoveredBy) return; // someone tracks it by hand meanwhile
      me.requestedBranch = me.branch;
      me.branch = best.branch;
      if (twin) { // the watcher's track for the same branch: its events were already sent, keep its memo
        me.memo = { ...(me.memo ?? {}), ...(twin.memo ?? {}) };
        twin.active = false; twin.endedMs = nowMs;
        twin.view = { ...(twin.view ?? {}), state: 'adopted', detail: `followed by track ${me.id}` };
      }
      writeJson(p.tracked, list, { backup: true });
      adopted.push(me.id);
      log(p, `track ${me.id}: ${me.requestedBranch} is pushed as ${me.branch}; following it${twin ? ` (track ${twin.id} merged in)` : ''}`);
    });
  }
  return adopted;
}

// Watch-only repo tracks: each claude/* branch that appeared since the last look becomes a branch track owned by the
// watching session. The first look takes only branches with an open PR (older branches are history, not sessions).
export function discover(p, repo, tracks, prev, now, nowMs = Date.now()) {
  const watcher = tracks.find((t) => t.kind === 'repo' && t.discover);
  if (!watcher || !now.refs) return [];
  // Only a look made while this watch existed counts as "before": an older one (a watch that parked and came back)
  // would make every branch pushed since look new.
  const before = prev?.refs && (prev.at ?? 0) >= watcher.createdMs ? new Set(prev.refs.map((r) => r.branch)) : null;
  const fresh = now.refs.filter((r) => (before ? !before.has(r.branch) : now.prs[r.branch]?.state === 'open'));
  if (!fresh.length) return [];
  const added = [];
  for (const r of fresh.slice(0, 20)) { // a burst of branches never floods the tracker
    if (!BRANCH_RE.test(r.branch) || r.branch.includes('..')) continue;
    const taken = readJson(p.tracked, []).some((t) => t.active && t.kind === 'branch' && t.repo.toLowerCase() === repo.toLowerCase() && t.branch === r.branch);
    if (taken) continue;
    // The title is the branch name: a PR title is the PR author's text and never becomes a title (events carry it as untrusted_title).
    const t = addTrack(p, { kind: 'branch', repo, branch: r.branch, url: '', title: r.branch, discoveredBy: watcher.id, notify: watcher.notify }, watcher.owner, nowMs);
    added.push(t.id);
    log(p, `watch ${repo}: tracking new branch ${r.branch} as ${t.id}`);
  }
  return added;
}

// Delete a merged claude/* branch only when its tip is still the merged PR's head: new work pushed after the merge
// (or a reused branch name) is never deleted.
function cleanupBranch(p, api, repo, branch, merged) {
  try {
    if (!/^claude\//.test(branch)) return;
    const tip = api.tipSha ? api.tipSha(repo, branch) : merged?.head_sha;
    if (!tip) { log(p, `branch ${repo}:${branch} already gone`); return; }
    if (!merged?.head_sha || tip !== merged.head_sha) { log(p, `branch ${repo}:${branch} kept: tip ${tip.slice(0, 9)} is not the merged head ${String(merged?.head_sha).slice(0, 9)}`); return; }
    api.del(`repos/${repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
    log(p, `deleted merged branch ${repo}:${branch}`);
  } catch (err) {
    log(p, `branch cleanup ${repo}:${branch} failed: ${err.message}`);
  }
}

function prune(p, nowMs = Date.now(), aliveFn = isAlive) {
  withLock(p, () => {
    const list = readJson(p.tracked, []);
    const kept = list.filter((t) => t.active || nowMs - (t.endedMs ?? t.createdMs) < KEEP_FINISHED_MS);
    if (kept.length !== list.length) writeJson(p.tracked, kept, { backup: true });
    // Drained queues of sessions that own nothing and wait nowhere are deleted.
    const owners = new Set(kept.filter((t) => t.active).map((t) => t.owner?.sessionId));
    const waiting = new Set(liveWaiters(p, aliveFn).map((w) => w.sessionId.replace(/[^\w.-]/g, '_')));
    for (const f of listJson(p.queues)) {
      const sid = f.split(/[\\/]/).pop().replace(/\.json$/, '');
      if (!owners.has(sid) && !waiting.has(sid) && !readJson(f, [], { cache: true }).length) remove(f);
    }
  });
}

function heartbeat(p, startedMs, nowMs = Date.now()) {
  writeJson(p.pid, { pid: process.pid, startedMs, heartbeatMs: nowMs, script: fileURLToPath(import.meta.url) });
}

function cmdDaemon(p) {
  if (hubAlive(p)) return;
  const startedMs = Date.now();
  heartbeat(p, startedMs);
  // Two starts at once both wrote the pid file: the last writer wins, the other leaves before doing anything.
  sleep(200 + Math.floor(Math.random() * 300));
  if (readJson(p.pid, null)?.pid !== process.pid) return;
  log(p, `hub started pid ${process.pid}`);
  let publicKey = null;
  try { publicKey = loadPublicKey(); } catch { /* no key: every ask counts as pending */ }
  const tokenFor = makeTokenFor(); // each repo read with its owner's gh login when gh holds it
  let nextPoll = 0;
  let idleSince = null;
  let trackedMtime = 0;
  let lastBeat = startedMs;
  const beat = () => { const t = Date.now(); if (t - lastBeat >= HEARTBEAT_MS) { heartbeat(p, startedMs, t); lastBeat = t; } };
  try {
    for (;;) {
      try {
        const mine = readJson(p.pid, null);
        if (!mine || mine.pid !== process.pid) { log(p, 'pid file taken over: exiting'); return; }
        const stop = readJson(`${p.dir}/stop`, null);
        if (stop) {
          remove(`${p.dir}/stop`);
          if ((stop.at ?? 0) >= startedMs) { log(p, 'stop requested'); return; } // an old stop file never kills a new hub
        }
        const nowMs = Date.now();
        if (nowMs - lastBeat >= HEARTBEAT_MS) { heartbeat(p, startedMs, nowMs); lastBeat = nowMs; }
        const active = readJson(p.tracked, []).filter((t) => t.active);
        const waiters = liveWaiters(p);
        if (!active.length && !waiters.length) {
          idleSince ??= nowMs;
          if (nowMs - idleSince >= IDLE_MS) { log(p, 'idle: exiting'); return; }
        } else idleSince = null;
        const mtime = existsSync(p.tracked) ? statSync(p.tracked).mtimeMs : 0;
        if (mtime !== trackedMtime && active.some((t) => !t.lastPolledMs)) nextPoll = Math.min(nextPoll, nowMs + 3000); // a new track: look soon
        trackedMtime = mtime;
        if (active.length && nowMs >= nextPoll) {
          const api = makeApi(p.etags, { tokenFor, onCall: beat });
          const res = pollOnce(p, { api, publicKey, nowMs });
          const interval = nextInterval(readJson(p.tracked, []), nowMs);
          writeState(p, { hub: { pid: process.pid, polledMs: nowMs, intervalMs: interval, api: api.stats, waiters: res.waiters }, errors: res.errors });
          nextPoll = nowMs + interval;
          prune(p, nowMs);
        } else if (!active.length && nowMs >= nextPoll) {
          writeState(p, { hub: { pid: process.pid, polledMs: nowMs, waiters: waiters.length }, errors: {} });
          nextPoll = nowMs + POLL_MS;
        }
      } catch (err) {
        // One bad pass (a busy lock, a file a scanner holds) never kills the hub: log it and go on.
        log(p, `loop error: ${String(err.stack || err).split('\n').slice(0, 4).join(' | ')}`);
        nextPoll = Date.now() + 30_000;
      }
      sleep(TICK_MS);
    }
  } finally {
    try {
      if (readJson(p.pid, null)?.pid === process.pid) remove(p.pid);
    } catch { /* leaving anyway */ }
  }
}

// ---- entry ----------------------------------------------------------------------------------------------------------

export function main(argv, p = paths()) {
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  const authors = typeof flags['ask-authors'] === 'string' ? flags['ask-authors'].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
  switch (cmd) {
    case 'track': {
      const t = addTrack(p, { kind: 'branch', repo: str(flags.repo), branch: str(flags.branch), url: str(flags.url), title: str(flags.title), askAuthors: authors }, caller());
      ensureHub(p);
      console.log(JSON.stringify({ ok: true, id: t.id, updated: Boolean(t.updated) }));
      return;
    }
    case 'track-repo': {
      // An absolute path: the hub runs from the home folder, so a relative one would no longer mean the same folder.
      const t = addTrack(p, { kind: 'repo', repo: flags.repo, releaseTree: flags['release-tree'] ? resolve(String(flags['release-tree'])) : undefined, askAuthors: authors }, caller());
      ensureHub(p);
      console.log(JSON.stringify({ ok: true, id: t.id, updated: Boolean(t.updated) }));
      return;
    }
    case 'watch': {
      const t = addTrack(p, { kind: 'repo', repo: str(flags.repo), discover: true }, caller());
      ensureHub(p);
      console.log(JSON.stringify({ ok: true, id: t.id, updated: Boolean(t.updated) }));
      return;
    }
    case 'unwatch': {
      const repo = str(flags.repo).toLowerCase();
      const ids = readJson(p.tracked, []).filter((t) => t.active && t.kind === 'repo' && t.discover && t.repo.toLowerCase() === repo).map((t) => t.id);
      for (const id of ids) untrack(p, id);
      console.log(JSON.stringify({ ok: true, stopped: ids.length }));
      return;
    }
    case 'doctor':
      console.log(JSON.stringify(doctor(p)));
      return;
    case 'untrack':
      console.log(JSON.stringify({ ok: untrack(p, String(flags.id ?? '')) }));
      return;
    case 'wait':
      cmdWait(p, flags);
      return;
    case 'wait-begin':
      cmdWaitBegin(p, flags);
      return;
    case 'wait-take':
      cmdWaitTake(p, flags);
      return;
    case 'wait-end':
      cmdWaitEnd(p, flags);
      return;
    case 'status':
      cmdStatus(p, flags);
      return;
    case 'stop':
      if (hubAlive(p)) writeJson(`${p.dir}/stop`, { at: Date.now() }); // no hub: no stop file left to kill the next one
      console.log(JSON.stringify({ ok: true, wasRunning: Boolean(hubAlive(p)) }));
      return;
    case 'daemon':
      cmdDaemon(p);
      return;
    default:
      throw new Error('usage: hub.mjs track|track-repo|watch|unwatch|untrack|wait|status|stop|doctor|daemon (see the header)');
  }
}

// What this machine has for the hub: Node 18+, the gh CLI and a gh login. Never prints a token.
export function doctor(p, { exec = execFileSync, version = process.version } = {}) {
  const major = Number(/^v(\d+)/.exec(version)?.[1] ?? 0);
  const run = (args) => { try { return { ok: true, out: String(exec(resolveExe('gh'), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000, cwd: safeCwd() })) }; } catch (err) { return { ok: false, out: String(err?.stdout ?? '') + String(err?.stderr ?? ''), missing: err?.code === 'ENOENT' }; } };
  const ver = run(['--version']);
  const auth = ver.ok ? run(['auth', 'status']) : { ok: false };
  const problems = [];
  if (major < 18) problems.push(`Node ${version} is too old: install Node 18 or newer`);
  if (!ver.ok) problems.push('the GitHub CLI (gh) is not installed: https://cli.github.com');
  else if (!auth.ok) problems.push('gh is not signed in: run gh auth login');
  return { ok: problems.length === 0, node: version, gh: ver.ok ? (/gh version ([\w.-]+)/.exec(ver.out)?.[1] ?? 'unknown') : null, ghSignedIn: Boolean(auth.ok), dir: p.dir, running: Boolean(hubAlive(p)), problems };
}

// Run as a script (also through a symlink, a relative path or another drive-letter case on Windows).
function isMain() {
  if (!process.argv[1]) return false;
  const norm = (f) => { let x = resolve(f); try { x = realpathSync(x); } catch { /* keep the resolved path */ } return process.platform === 'win32' ? x.toLowerCase() : x; };
  return norm(fileURLToPath(import.meta.url)) === norm(process.argv[1]);
}

if (isMain()) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.log(JSON.stringify({ status: 'usage', message: err.message }));
    process.exitCode = 1;
  }
}
void HERE;
