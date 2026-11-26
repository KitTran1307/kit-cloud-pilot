// Opt-in alerts to a phone or anywhere else, OFF unless the person sets CLOUD_PILOT_NOTIFY_CMD (a command of their
// own) and/or CLOUD_PILOT_NTFY_TOPIC (an ntfy topic). Nothing from GitHub that a stranger can write (PR titles, the
// untrusted_* fields, questions) ever reaches an alert: only a few fields that are checked against a strict pattern.
import { spawn as nodeSpawn } from 'node:child_process';
import { setting } from './config.mjs';
import { safeCwd } from './exe.mjs';

const DEFAULT_KINDS = 'question,question_stale,question_waiting,ci-failed,conflict,no-push,merged,abandoned';
const TOKEN = /^[a-z_-]{1,40}$/;
// A plain https link: no spaces, no control characters, no bidi characters that could disguise where it goes.
// No shell metacharacters either (& | ^ " < > $ ` and %): the person's command runs in a shell (cmd.exe expands %VAR%).
const PLAIN_URL = /^https:\/\/[\w.~:/?#=+@-]{1,500}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^claude\/[\w./-]+$/;
const TOPIC = /^[A-Za-z0-9_-]{1,64}$/;
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) : String(s));

/** The event kinds that alert: CLOUD_PILOT_NOTIFY_KINDS (comma separated; bad tokens dropped) or the default list. */
export function alertKinds(env = process.env) {
  const raw = setting('NOTIFY_KINDS', env);
  const list = typeof raw === 'string' && raw.trim() !== '' ? raw : DEFAULT_KINDS;
  return new Set(list.split(',').map((t) => t.trim().toLowerCase()).filter((t) => TOKEN.test(t)));
}

/** The link to open from the alert: the session, else the PR, else nothing. Plain https only. */
export function alertLink(ev) {
  // The query is dropped (a session link ends in ?from=cli&m=0, and & is a shell metacharacter).
  for (const raw of [ev?.url, ev?.pr_url]) {
    const u = typeof raw === 'string' ? raw.split('?')[0] : '';
    if (PLAIN_URL.test(u)) return u;
  }
  return '';
}

// The few event fields an alert may carry, each blanked unless it matches a strict pattern.
function safeFields(ev) {
  const kind = typeof ev?.kind === 'string' && TOKEN.test(ev.kind) ? ev.kind : '';
  const repo = typeof ev?.repo === 'string' && REPO.test(ev.repo) ? ev.repo : '';
  const branch = typeof ev?.branch === 'string' && BRANCH.test(ev.branch) && !ev.branch.includes('..') ? ev.branch : '';
  const pr = Number.isInteger(ev?.pr) && ev.pr > 0 ? String(ev.pr) : '';
  return { kind, repo, branch, pr, url: alertLink(ev), urgent: ev?.urgent === true ? '1' : '0' };
}

/** The environment for the person's command: env plus the checked event fields, nothing else from the event. */
export function alertEnv(ev, env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (k.startsWith('CLOUD_PILOT_EVENT_')) delete out[k]; // nothing stale leaks in
  const f = safeFields(ev);
  out.CLOUD_PILOT_EVENT_KIND = f.kind;
  out.CLOUD_PILOT_EVENT_REPO = f.repo;
  out.CLOUD_PILOT_EVENT_BRANCH = f.branch;
  out.CLOUD_PILOT_EVENT_PR = f.pr;
  out.CLOUD_PILOT_EVENT_URL = f.url;
  out.CLOUD_PILOT_EVENT_URGENT = f.urgent;
  return out;
}

/** Run CLOUD_PILOT_NOTIFY_CMD (the person's own command, from their environment only) without waiting for it. */
export function runNotifyCommand(ev, { env = process.env, spawn = nodeSpawn, log = () => {}, timeoutMs = 15000 } = {}) {
  try {
    const cmd = setting('NOTIFY_CMD', env);
    if (typeof cmd !== 'string' || cmd === '') return;
    const kind = safeFields(ev).kind;
    // Windows: not detached (a detached console process would show a window), and a timeout ends the whole tree.
    const win = process.platform === 'win32';
    const child = spawn(cmd, { shell: true, detached: !win, stdio: 'ignore', windowsHide: true, cwd: safeCwd(), env: alertEnv(ev, env) });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`alert command failed: timed out (${kind || 'event'})`);
      try {
        if (!win && child.pid) process.kill(-child.pid); // the whole group: the shell and its children
        else if (win && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, cwd: safeCwd() });
        else child.kill();
      } catch { /* already gone */ }
    }, timeoutMs);
    timer.unref?.();
    child.on?.('error', (err) => {
      clearTimeout(timer);
      log(`alert command failed: ${clip(err?.code ?? err?.message ?? 'error', 120)}`);
    });
    child.on?.('exit', (code, signal) => {
      clearTimeout(timer);
      if (!timedOut && code !== 0) log(`alert command failed: exit ${code ?? signal} (${kind || 'event'})`);
    });
    child.unref?.();
  } catch (err) {
    try { log(`alert command failed: ${clip(err?.message ?? 'error', 120)}`); } catch { /* logging must not throw either */ }
  }
}

/** POST a short plain-text message to an ntfy topic. Always resolves. */
export async function postNtfy(ev, { env = process.env, fetch = globalThis.fetch, log = () => {}, timeoutMs = 15000 } = {}) {
  try {
    const topic = setting('NTFY_TOPIC', env);
    if (typeof topic !== 'string' || topic === '') return;
    if (!TOPIC.test(topic)) return log('ntfy topic ignored: use letters, digits, - and _ (up to 64)');
    let base = setting('NTFY_URL', env);
    if (typeof base !== 'string' || base === '') base = 'https://ntfy.sh';
    let u;
    try { u = new URL(base); } catch { u = null; }
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return log('ntfy url ignored: use an http or https address');
    if (typeof fetch !== 'function') return; // older Node: no fetch, no alert
    const f = safeFields(ev);
    const body = (f.kind || 'event') + (f.repo ? ` · ${f.repo}${f.pr ? `#${f.pr}` : ''}` : '');
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (/^[\x21-\x7e]+$/.test(f.url)) headers.Click = f.url; // a header value is ASCII; a link with other characters is left out
    const res = await fetch(`${base.replace(/\/+$/, '')}/${topic}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) log(`ntfy failed: ${res.status}`);
  } catch (err) {
    try { log(`ntfy failed: ${clip(err?.message ?? 'error', 120)}`); } catch { /* logging must not throw either */ }
  }
}

/** Alert for every event whose kind the person asked for. Resolves when the ntfy posts are done (tests await it). */
export async function alertEvents(events, { env = process.env, log, spawn, fetch } = {}) {
  try {
    const cmd = setting('NOTIFY_CMD', env);
    const topic = setting('NTFY_TOPIC', env);
    const hasCmd = typeof cmd === 'string' && cmd !== '';
    const hasNtfy = typeof topic === 'string' && topic !== '';
    if (!hasCmd && !hasNtfy) return;
    const kinds = alertKinds(env);
    const posts = [];
    for (const ev of events ?? []) {
      if (!kinds.has(ev?.kind)) continue;
      if (hasCmd) runNotifyCommand(ev, { env, spawn, log });
      if (hasNtfy) posts.push(postNtfy(ev, { env, fetch, log }));
    }
    await Promise.all(posts);
  } catch { /* an alert never breaks the hub */ }
}
