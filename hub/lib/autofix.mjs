// Tell the cloud session that made a PR to fix its own failed CI or merge conflict: one short notice, at most
// AUTOFIX_MAX per event kind and commit. The text is built here from four re-validated plain fields; nothing that came
// from GitHub text (titles, check names, branch descriptions) ever reaches it.
import { setting } from './config.mjs';
import { sendToSessionAsync, sessionOfTrack } from './send.mjs';
import { resolveClaude } from '../../start/lib.mjs';

export const AUTOFIX_MAX = 2;
// Across commits too: a check the session cannot fix (a missing secret) fails again on every push, so a track gets at
// most AUTOFIX_TOTAL notices in all, and none within AUTOFIX_COOLDOWN_MS of the last one.
export const AUTOFIX_TOTAL = 4;
export const AUTOFIX_COOLDOWN_MS = 30 * 60_000;
const KEEP = 50;

export const autofixOff = (env = process.env) => setting('AUTOFIX', env) === '0';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const HEAD_RE = /^[0-9a-f]{7,40}$/i;
const safeBranch = (b) => typeof b === 'string' && b.length <= 100 && /^[\w./-]+$/.test(b) && !b.includes('..') && !/^[-/]/.test(b);

// The notice for a ci-failed or conflict event, or null (other kind, or a field that is not what it should be).
export function autofixNotice(ev) {
  if (ev?.kind !== 'ci-failed' && ev?.kind !== 'conflict') return null;
  const { repo, pr, head, base_ref: base } = ev;
  if (typeof repo !== 'string' || !REPO_RE.test(repo) || !Number.isSafeInteger(pr) || pr < 1 || typeof head !== 'string' || !HEAD_RE.test(head)) return null;
  if (ev.kind === 'ci-failed') {
    return `CI failed on ${repo}#${pr} at ${head}. Read the failing checks with gh api repos/${repo}/commits/${head}/check-runs, fix it on the same branch, run the checks, push. Do not merge.`;
  }
  return safeBranch(base)
    ? `${repo}#${pr} has merge conflicts with ${base}. Merge origin/${base} into your branch, resolve, run the checks, push. Do not merge.`
    : `${repo}#${pr} has merge conflicts with its base branch. Merge the base branch (named on the PR page) into your branch, resolve, run the checks, push. Do not merge.`;
}

// Decides now and returns { sent, reason }; the send itself runs in the background and its outcome goes to `log`.
export function startAutofix(track, ev, pr, { env = process.env, send = sendToSessionAsync, claude, log = () => {}, nowMs = Date.now() } = {}) {
  try {
    const text = autofixNotice(ev);
    if (!text) return { sent: false, reason: 'not an autofix event' };
    if (autofixOff(env)) return { sent: false, reason: 'off (CLOUD_PILOT_AUTOFIX=0)' };
    const id = pr?.sessionId;
    const found = sessionOfTrack(track) ?? (id ? {
      sessionId: id, url: `https://claude.ai/code/${id}`, trackId: track.id, configDir: track.owner?.configDir || null, account: track.owner?.account || null, from: 'pr-body',
    } : null);
    if (!found) return { sent: false, reason: 'no session link on the track or in the PR body' };
    const key = `${ev.kind}:${ev.head}`;
    const memo = track.memo && typeof track.memo === 'object' ? track.memo : (track.memo = {});
    const counts = memo.autofix && typeof memo.autofix === 'object' ? memo.autofix : {};
    if ((counts[key] ?? 0) >= AUTOFIX_MAX) return { sent: false, reason: `limit reached: ${AUTOFIX_MAX} notices already sent for this commit` };
    if ((memo.autofixTotal ?? 0) >= AUTOFIX_TOTAL) return { sent: false, reason: `limit reached: ${AUTOFIX_TOTAL} notices already sent for this session; the person decides now` };
    if (Number.isFinite(memo.autofixLastMs) && nowMs - memo.autofixLastMs < AUTOFIX_COOLDOWN_MS) return { sent: false, reason: 'a notice went to this session less than 30 minutes ago' };
    const exe = claude ?? resolveClaude(env);
    if (exe.error) return { sent: false, reason: exe.error };
    const n = (counts[key] ?? 0) + 1;
    delete counts[key];
    counts[key] = n; // re-added last: object keys keep insertion order, so the newest are at the end
    memo.autofix = Object.fromEntries(Object.entries(counts).slice(-KEEP));
    memo.autofixTotal = (memo.autofixTotal ?? 0) + 1;
    memo.autofixLastMs = nowMs;
    const what = `autofix ${ev.kind} ${ev.repo}#${ev.pr}`;
    new Promise((resolve) => resolve(send(text, found, { env, claude: exe })))
      .then((r) => log(`${what}: ${r?.sent ? 'sent' : `not sent: ${r?.reason ?? 'unknown'}`}`))
      .catch((err) => log(`${what}: not sent: ${String(err?.message ?? err).slice(0, 200)}`));
    return { sent: true, reason: 'notice dispatched; the result is in hub.log' };
  } catch (err) {
    return { sent: false, reason: String(err?.message ?? err).slice(0, 200) };
  }
}
