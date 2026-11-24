// Send one message to a tracked cloud session: `claude -p "<text>" --cloud <session_id>`, run as the account that
// started it (the track's owner.configDir). Shared by the channel (a posted answer wakes the session that asked), the
// hub (a failed CI or a merge conflict goes back to the session that made it) and `cloud-pilot nudge`.
// The text is always written by this plugin or typed by the person: never text from GitHub. Every problem comes back
// as { sent: false, reason }; nothing here throws for a missing claude, a missing session or a failed send.
import { spawn, spawnSync } from 'node:child_process';
import { safeCwd } from './exe.mjs';
import { resolveClaude } from '../../start/lib.mjs';

const SESSION_RE = /\b(session_[A-Za-z0-9]{8,64})\b/;
// Short: a live send takes about 3 s; the answer that triggers one is already posted.
export const NUDGE_TIMEOUT_MS = 30_000;
// A message is one argument of claude -p. One that starts with "-" would read as an option, so it gets a lead-in.
const MAX_TEXT = 4000;

export const sessionIdOf = (url) => SESSION_RE.exec(String(url ?? ''))?.[1] ?? null;

const foundOf = (t) => ({ sessionId: sessionIdOf(t.url), url: t.url, trackId: t.id, configDir: t.owner?.configDir || null, account: t.owner?.account || null });

// The session link of one track (its own url), or null.
export function sessionOfTrack(t) {
  return t && sessionIdOf(t.url) ? foundOf(t) : null;
}

// The started session behind a PR: a track of that repository with a session link, whose PR is this one (memo.pr) or
// whose branch is the PR's head branch. An active track wins over an ended one, then the newest.
export function findSession(tracked, { repo, pr, headRef = null }) {
  const want = String(repo).toLowerCase();
  const hits = (Array.isArray(tracked) ? tracked : []).filter((t) => t && String(t.repo ?? '').toLowerCase() === want
    && sessionIdOf(t.url) && (t.memo?.pr === pr || (headRef && t.branch === headRef)));
  hits.sort((a, b) => (Number(Boolean(b.active)) - Number(Boolean(a.active))) || ((b.createdMs ?? 0) - (a.createdMs ?? 0)));
  return hits[0] ? foundOf(hits[0]) : null;
}

// The last claude.ai session link in a PR body (Claude Code writes it at the end), or null. Only the id is used, and
// `claude --cloud` reaches only sessions of the account it runs as, so a link to anything else just fails to send.
export function sessionFromBody(body) {
  const ids = [...String(body ?? '').matchAll(/https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]{8,64})\b/g)].map((m) => m[1]);
  const sessionId = ids.at(-1);
  return sessionId ? { sessionId, url: `https://claude.ai/code/${sessionId}`, trackId: null, configDir: null, account: null, from: 'pr-body' } : null;
}

// The session of a PR: from the tracks, else (when `api` can read the PR) through the PR's head branch, else from the
// link at the end of the PR body. `api(path)` is async and returns parsed JSON. Never throws.
export async function locateSession(tracked, { repo, pr }, api = null) {
  let found = findSession(tracked, { repo, pr });
  if (!found && api) {
    try {
      const data = await api(`repos/${repo}/pulls/${pr}`);
      const headRef = typeof data?.head?.ref === 'string' ? data.head.ref : null;
      if (headRef) found = findSession(tracked, { repo, pr, headRef });
      // A session started elsewhere (the desktop app, the web, a plain `claude --cloud`) is not tracked with its link,
      // but Claude Code ends the PRs it opens with that link: take it from the PR body, as the current account.
      if (!found) found = sessionFromBody(data?.body);
    } catch { /* the PR could not be read: no session to tell */ }
  }
  return found;
}

// What to run: { prefix, args, env } or { error }. claude comes from resolveClaude unless the caller already has it.
export function sendCommand(text, found, { env = process.env, claude } = {}) {
  const exe = claude ?? resolveClaude(env);
  if (exe.error) return { error: exe.error };
  let msg = String(text ?? '').replace(/\u0000/g, '').trim().slice(0, MAX_TEXT);
  if (!msg) return { error: 'nothing to send: the message is empty' };
  if (msg.startsWith('-')) msg = `Message: ${msg}`;
  // The session belongs to the account that started it: run claude as that account when the track recorded it.
  const childEnv = { ...env, ...(found.configDir ? { CLAUDE_CONFIG_DIR: found.configDir } : {}) };
  return { prefix: exe.prefix, args: ['-p', msg, '--cloud', found.sessionId], env: childEnv };
}

function result(found, r) {
  if (r.status === 0) return { sent: true, session_url: found.url, ...(found.from ? { found_in: found.from } : {}) };
  const tail = String(r.error || r.out || '').replace(/\s+/g, ' ').trim().slice(-200);
  return { sent: false, session_url: found.url, reason: `claude --cloud exited ${r.status ?? 'without a status'}${tail ? `: ${tail}` : ''}` };
}

function defaultRun(prefix, args, env) {
  const r = spawnSync(prefix[0], [...prefix.slice(1), ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: NUDGE_TIMEOUT_MS, cwd: safeCwd(), windowsHide: true, env,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error?.message };
}

// Same, without blocking the caller: the hub polls on one thread and must not wait for a send.
function defaultRunAsync(prefix, args, env) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      child = spawn(prefix[0], [...prefix.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'], cwd: safeCwd(), windowsHide: true, env });
    } catch (err) { resolve({ status: null, out: '', error: err.message }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ status: null, out, error: `timed out after ${NUDGE_TIMEOUT_MS / 1000} s` }); }, NUDGE_TIMEOUT_MS);
    timer.unref?.();
    for (const s of [child.stdout, child.stderr]) s?.on('data', (d) => { out = (out + d).slice(-2000); });
    child.on('error', (err) => finish({ status: null, out, error: err.message }));
    child.on('close', (status) => finish({ status, out }));
  });
}

// deps: env, claude (resolveClaude's result), run (sync: (prefix, args, env) => { status, out, error }).
export function sendToSession(text, found, { env = process.env, claude, run = defaultRun } = {}) {
  const cmd = sendCommand(text, found, { env, claude });
  if (cmd.error) return { sent: false, session_url: found.url, reason: cmd.error };
  return result(found, run(cmd.prefix, cmd.args, cmd.env));
}

// deps: as above, but run may return a promise (default: a non-blocking child process with its own timeout).
export async function sendToSessionAsync(text, found, { env = process.env, claude, run = defaultRunAsync } = {}) {
  const cmd = sendCommand(text, found, { env, claude });
  if (cmd.error) return { sent: false, session_url: found.url, reason: cmd.error };
  try { return result(found, await run(cmd.prefix, cmd.args, cmd.env)); } catch (err) { return { sent: false, session_url: found.url, reason: String(err?.message ?? err).slice(0, 200) }; }
}
