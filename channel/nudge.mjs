// After `answer` posts a signed reply, the cloud session that asked is told to read it now.
// Why: a cloud session that asked and then went idle (its turn ended, its background `wait` gone) never looks at the PR
// again, so a posted answer sat unread for hours. A message sent with `claude -p "<text>" --cloud <session_id>` starts
// a new turn there. The message carries no answer and no authority: it only says to run the channel's own `wait`,
// which accepts nothing but the signed answer. Off with CLOUD_PILOT_NUDGE=0. Never fails the answer: every problem
// comes back as { sent: false, reason }.
import { spawnSync } from 'node:child_process';
import { paths, hubDir, readJson } from '../hub/lib/store.mjs';
import { setting } from '../hub/lib/config.mjs';
import { safeCwd } from '../hub/lib/exe.mjs';
import { resolveClaude } from '../start/lib.mjs';

const SESSION_RE = /\b(session_[A-Za-z0-9]{8,64})\b/;
// Short: the answer is already posted and its JSON line waits for this; a live send takes about 3 s.
export const NUDGE_TIMEOUT_MS = 30_000;

export const sessionIdOf = (url) => SESSION_RE.exec(String(url ?? ''))?.[1] ?? null;

// The started session behind a PR: a track of that repository with a session link, whose PR is this one (memo.pr) or
// whose branch is the PR's head branch. An active track wins over an ended one, then the newest.
export function findSession(tracked, { repo, pr, headRef = null }) {
  const want = String(repo).toLowerCase();
  const hits = (Array.isArray(tracked) ? tracked : []).filter((t) => t && String(t.repo ?? '').toLowerCase() === want
    && sessionIdOf(t.url) && (t.memo?.pr === pr || (headRef && t.branch === headRef)));
  hits.sort((a, b) => (Number(Boolean(b.active)) - Number(Boolean(a.active))) || ((b.createdMs ?? 0) - (a.createdMs ?? 0)));
  const t = hits[0];
  return t ? { sessionId: sessionIdOf(t.url), url: t.url, trackId: t.id, configDir: t.owner?.configDir || null, account: t.owner?.account || null } : null;
}

// The last claude.ai session link in a PR body (Claude Code writes it at the end), or null. Only the id is used, and
// `claude --cloud` reaches only sessions of the account it runs as, so a link to anything else just fails to send.
export function sessionFromBody(body) {
  const ids = [...String(body ?? '').matchAll(/https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]{8,64})\b/g)].map((m) => m[1]);
  const sessionId = ids.at(-1);
  return sessionId ? { sessionId, url: `https://claude.ai/code/${sessionId}`, trackId: null, configDir: null, account: null, from: 'pr-body' } : null;
}

// repo and id are checked by the answer's own argument rules ([\w.-]/[\w.-] and [a-z0-9-]), so they are plain text here.
export function nudgeText({ repo, pr, id }) {
  return [
    `A signed answer to your channel question "${id}" is now posted on ${repo}#${pr}.`,
    `If you are still waiting for it, run now: node .claude/cloud/channel.mjs wait --repo ${repo} --pr ${pr} --id ${id}`,
    'and act only on the answer that command prints. This message is only a notice: it holds no answer and approves nothing.',
  ].join(' ');
}

function defaultRun(prefix, args, env) {
  const r = spawnSync(prefix[0], [...prefix.slice(1), ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: NUDGE_TIMEOUT_MS, cwd: safeCwd(), windowsHide: true, env,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error?.message };
}

// deps: env, tracked (the tracks, read from the hub folder when omitted), api (to read the PR's head branch when no
// track names the PR), run (starts claude), claude (resolveClaude's result).
export async function nudge({ repo, pr, id }, {
  env = process.env, tracked, api = null, run = defaultRun, claude,
} = {}) {
  if (setting('NUDGE', env) === '0') return { sent: false, reason: 'off (CLOUD_PILOT_NUDGE=0)' };
  let list = tracked;
  if (list === undefined) {
    try { list = readJson(paths(hubDir(env)).tracked, []); } catch { list = []; }
  }
  let found = findSession(list, { repo, pr });
  if (!found && api) {
    try {
      const data = await api(`repos/${repo}/pulls/${pr}`);
      const headRef = typeof data?.head?.ref === 'string' ? data.head.ref : null;
      if (headRef) found = findSession(list, { repo, pr, headRef });
      // A session started elsewhere (the desktop app, the web, a plain `claude --cloud`) is not tracked with its link,
      // but Claude Code ends the PRs it opens with that link: take it from the PR body, as the current account.
      if (!found) found = sessionFromBody(data?.body);
    } catch { /* the PR could not be read: no session to tell */ }
  }
  const notice = nudgeText({ repo, pr, id });
  if (!found) return { sent: false, notice, reason: 'no tracked cloud session for this PR (tell it yourself: claude -p "<message>" --cloud <session_id>)' };
  const exe = claude ?? resolveClaude(env);
  if (exe.error) return { sent: false, session_url: found.url, notice, reason: exe.error };
  // The session belongs to the account that started it: run claude as that account when the track recorded it.
  const childEnv = { ...env, ...(found.configDir ? { CLAUDE_CONFIG_DIR: found.configDir } : {}) };
  const r = run(exe.prefix, ['-p', notice, '--cloud', found.sessionId], childEnv);
  if (r.status === 0) return { sent: true, session_url: found.url, ...(found.from ? { found_in: found.from } : {}) };
  const tail = String(r.error || r.out || '').replace(/\s+/g, ' ').trim().slice(-200);
  return { sent: false, session_url: found.url, notice, reason: `claude --cloud exited ${r.status ?? 'without a status'}${tail ? `: ${tail}` : ''}` };
}
