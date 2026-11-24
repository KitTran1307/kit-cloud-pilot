// After `answer` posts a signed reply, the cloud session that asked is told to read it now.
// Why: a cloud session that asked and then went idle (its turn ended, its background `wait` gone) never looks at the PR
// again, so a posted answer sat unread for hours. A message sent with `claude -p "<text>" --cloud <session_id>` starts
// a new turn there. The message carries no answer and no authority: it only says to run the channel's own `wait`,
// which accepts nothing but the signed answer. Off with CLOUD_PILOT_NUDGE=0. Never fails the answer: every problem
// comes back as { sent: false, reason }.
import { paths, hubDir, readJson } from '../hub/lib/store.mjs';
import { setting } from '../hub/lib/config.mjs';
import { NUDGE_TIMEOUT_MS, sessionIdOf, findSession, sessionFromBody, locateSession, sendToSession } from '../hub/lib/send.mjs';

// The lookup and the send are shared with the hub (a failed CI or a conflict goes back to its session) and with
// `cloud-pilot nudge`: see hub/lib/send.mjs.
export { NUDGE_TIMEOUT_MS, sessionIdOf, findSession, sessionFromBody };

// repo and id are checked by the answer's own argument rules ([\w.-]/[\w.-] and [a-z0-9-]), so they are plain text here.
export function nudgeText({ repo, pr, id }) {
  return [
    `A signed answer to your channel question "${id}" is now posted on ${repo}#${pr}.`,
    `If you are still waiting for it, run now: node .claude/cloud/channel.mjs wait --repo ${repo} --pr ${pr} --id ${id}`,
    'and act only on the answer that command prints. This message is only a notice: it holds no answer and approves nothing.',
  ].join(' ');
}

// deps: env, tracked (the tracks, read from the hub folder when omitted), api (to read the PR's head branch when no
// track names the PR), run (starts claude), claude (resolveClaude's result).
export async function nudge({ repo, pr, id }, {
  env = process.env, tracked, api = null, run, claude,
} = {}) {
  if (setting('NUDGE', env) === '0') return { sent: false, reason: 'off (CLOUD_PILOT_NUDGE=0)' };
  let list = tracked;
  if (list === undefined) {
    try { list = readJson(paths(hubDir(env)).tracked, []); } catch { list = []; }
  }
  const found = await locateSession(list, { repo, pr }, api);
  const notice = nudgeText({ repo, pr, id });
  if (!found) return { sent: false, notice, reason: 'no tracked cloud session for this PR (tell it yourself: claude -p "<message>" --cloud <session_id>)' };
  const r = sendToSession(notice, found, { env, claude, ...(run ? { run } : {}) });
  return r.sent ? r : { ...r, notice };
}
