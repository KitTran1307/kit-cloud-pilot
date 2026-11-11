// Pure: what changed for one track between two repo snapshots, plus the row the status views show.
// A track: { id, kind: 'branch' | 'repo', repo, branch, url, title, createdMs, active, memo }.
// Text that comes from GitHub (PR titles, bodies, comments, questions, the names of a PR's files) travels only in
// `untrusted_*` fields: it is data for the waking session to weigh, never an instruction.
import { currentPr } from './poll.mjs';

export const QUIET_MS = 60 * 60_000; // branch track: no push/PR activity this long -> "stalled" (once per activity time)
export const REPO_QUIET_MS = 45 * 60_000; // repo track: an open PR idle this long -> "quiet"
export const ABANDON_MS = 4 * 3600_000; // no PR open and no activity this long -> "abandoned", the track stops
export const OPEN_PR_ABANDON_MS = 72 * 3600_000; // an open PR waiting (review, a question) is watched this long
export const FRESH_MS = 15 * 60_000; // a track with no branch counts as working this long, then is dropped
// A PR status line that needs the person: English words, or the protocol's original Vietnamese ones.
const URGENT_TEXT = /WAITING FOR YOU|BLOCKED|CH\u1edc B\u1ea0N|K\u1eb8T/;

// An answer signed for an earlier head of the PR is reported once the current head has stood this long: a session that
// is still working keeps pushing (it read its answer before), one that waits on an answer it cannot accept does not.
export const STALE_SETTLE_MS = 5 * 60_000;

const max = (...xs) => Math.max(...xs.filter(Number.isFinite));

// The title an event and the status table show. A discovered track found its branch on GitHub, so its title is the
// branch name (the PR title is the PR author's text: it only travels as `untrusted_title`); a title given by the
// local session (`track --title`, `start`) is kept as `title` (addTrack marks it `localTitle`).
export const trackTitle = (t) => (t.discoveredBy && !t.localTitle ? t.branch : t.title) || undefined;

function ev(track, kind, extra = {}, urgent = false) {
  return { kind, urgent, repo: track.repo, branch: track.branch || undefined, url: track.url || undefined, title: trackTitle(track), trackId: track.id, ...extra };
}

// The asks of a PR whose answers are for an older head and that have had time to be read (see STALE_SETTLE_MS).
const staleNow = (pr, nowMs) => (nowMs - (pr.headSeenMs ?? nowMs) >= STALE_SETTLE_MS ? (pr.staleAsks ?? []) : []);

// What a person (or session) deciding on an ask needs next to the question itself.
const askContext = (pr) => ({
  touches_agent_config: pr.touches_agent_config ?? true,
  ...(pr.agent_config_files ? { untrusted_agent_config_files: pr.agent_config_files } : {}),
  ...(pr.agent_config_check ? { agent_config_check: pr.agent_config_check } : {}),
});

// Each ask once; an ask edited after it was reported is reported again (as unanswerable). An ask answered for an older
// PR head is reported once per current head (as stale): it needs a new answer.
function askEvents(track, pr, memo, nowMs) {
  const out = [];
  const seen = new Set((memo.asks ?? []).map((k) => (typeof k === 'number' ? `${k}:o` : k))); // older memos held bare ids
  for (const a of pr.asks ?? []) {
    const key = `${a.commentId}:${a.edited ? 'e' : 'o'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev(track, a.edited ? 'question_unanswerable' : 'question', {
      pr: pr.number, pr_url: pr.url, id: a.id, ask_comment_id: a.commentId, question_sha256: a.sha, ask_author: a.author,
      untrusted_question: a.text, ...askContext(pr),
    }, true));
  }
  memo.asks = [...seen].slice(-400);
  const staleSeen = new Set(memo.staleAsks ?? []);
  for (const a of staleNow(pr, nowMs)) {
    const key = `${a.id}:${a.commentId}:${pr.headSha}`;
    if (staleSeen.has(key)) continue;
    staleSeen.add(key);
    out.push(ev(track, 'question_stale', {
      pr: pr.number, pr_url: pr.url, id: a.id, ask_comment_id: a.commentId, question_sha256: a.sha, ask_author: a.author,
      untrusted_question: a.text, head: pr.headSha.slice(0, 9), answered_head: String(a.answeredHead ?? '').slice(0, 9),
      note: 'The answer already given was signed for an earlier commit of the PR, and the cloud session accepts an answer only for the PR head it sees: it cannot use that one. If it is still waiting, answer again for the current head.',
      ...askContext(pr),
    }, true));
  }
  if (staleSeen.size) memo.staleAsks = [...staleSeen].slice(-400);
  return out;
}

function ciEvent(track, pr, memo) {
  const key = `${pr.headSha}:${pr.ci}`;
  if (pr.state !== 'open' || pr.ci !== 'failure' || memo.ci === key) { if (pr.ci) memo.ci = key; return []; }
  memo.ci = key;
  return [ev(track, 'ci-failed', { pr: pr.number, pr_url: pr.url, head: pr.headSha.slice(0, 9) }, true)];
}

function branchTrack(track, now, nowMs) {
  const memo = { ...(track.memo ?? {}) };
  const events = [];
  if (!track.branch) {
    const fresh = nowMs - track.createdMs < FRESH_MS;
    return { events, memo, active: fresh, view: { state: fresh ? 'working' : 'untracked', detail: fresh ? 'just started' : 'no branch to watch', lastActivityMs: track.createdMs } };
  }
  // The snapshot decided which PR is this track's (snapshot.current); hand-built snapshots fall back to currentPr.
  const cand = now.prs[track.branch];
  const pr = now.current && track.id in now.current ? (now.current[track.id] ? cand : null) : currentPr(cand, track, now.branches?.[track.branch]?.sha);
  const br = now.branches[track.branch];
  if (br?.exists || pr) memo.sawBranch = true;
  const last = max(track.createdMs, br?.tipMs, pr?.updatedMs);
  let active = true;
  let view;
  if (pr && memo.pr !== pr.number) {
    memo.pr = pr.number;
    events.push(ev(track, 'pr-opened', { pr: pr.number, pr_url: pr.url, ...(pr.title ? { untrusted_title: pr.title } : {}) }));
  }
  if (pr?.merged) {
    events.push(ev(track, 'merged', { pr: pr.number, pr_url: pr.url, merged_sha: pr.mergedSha, head_sha: pr.headSha }, true));
    active = false;
    view = { state: 'done', detail: `merged #${pr.number}` };
  } else if (pr && pr.state === 'closed') {
    events.push(ev(track, 'closed', { pr: pr.number, pr_url: pr.url }, true));
    active = false;
    view = { state: 'closed', detail: `PR #${pr.number} closed unmerged` };
  } else if (memo.sawBranch && !br?.exists && !pr) {
    events.push(ev(track, 'gone', {}, true));
    active = false;
    view = { state: 'gone', detail: 'branch deleted' };
  } else {
    if (pr) events.push(...askEvents(track, pr, memo, nowMs), ...ciEvent(track, pr, memo));
    const idle = nowMs - last;
    const limit = pr ? OPEN_PR_ABANDON_MS : ABANDON_MS;
    if (idle >= limit) {
      events.push(ev(track, 'abandoned', { idle_min: Math.round(idle / 60000), pr_url: pr?.url }, true));
      active = false;
      view = { state: 'abandoned', detail: `abandoned (${Math.round(idle / 3600000)} h idle)` };
    } else if (idle >= QUIET_MS && memo.stalledAt !== last) {
      memo.stalledAt = last;
      events.push(ev(track, 'stalled', { idle_min: Math.round(idle / 60000), pr_url: pr?.url }));
    }
    if (!view) {
      const mins = Math.round(idle / 60000);
      if (pr && (pr.asks ?? []).length) view = { state: 'question', detail: `PR #${pr.number} · asking` };
      else if (pr && pr.state === 'open' && staleNow(pr, nowMs).length) view = { state: 'question', detail: `PR #${pr.number} · answer is for an older commit` };
      else if (pr) view = { state: 'pr', detail: `PR #${pr.number}${pr.ci === 'pending' ? ' · CI running' : pr.ci === 'failure' ? ' · CI failed' : pr.ci === 'success' ? ' · CI passed' : ''}` };
      else if (idle >= 30 * 60_000) view = { state: 'silent', detail: br?.exists ? `silent ${mins} min` : `silent ${mins} min (nothing pushed)` };
      else view = { state: 'working', detail: br?.exists ? `pushed ${mins} min ago` : 'just started' };
    }
  }
  return { events, memo, active, view: { ...view, lastActivityMs: last, pr: pr?.number, prUrl: pr?.url, ci: pr?.ci } };
}

function repoTrack(track, prev, now, nowMs) {
  const memo = { ...(track.memo ?? {}) };
  const events = [];
  if (!memo.baselined || !prev) {
    // The first look records the PRs as they are (reporting every one as new would flood the session),
    // but questions already waiting are reported now.
    memo.baselined = true;
    for (const [ref, p] of Object.entries(now.prs)) {
      if (p.state === 'open' && !p.outOfWindow) events.push(...askEvents(track, p, memo, nowMs).map((e) => ({ ...e, branch: ref })));
    }
    return { events, memo, active: true, view: repoView(now) };
  }
  for (const [ref, p] of Object.entries(now.prs)) {
    if (p.outOfWindow) continue;
    const b = prev.prs?.[ref];
    const base = { pr: p.number, branch: ref, pr_url: p.url };
    if (!b || b.number !== p.number) {
      events.push(ev(track, 'opened', { ...base, untrusted_title: p.title, untrusted_text: p.flag }, URGENT_TEXT.test(p.flag)));
      continue;
    }
    if (p.merged && !b.merged) events.push(ev(track, 'merged', base));
    else if (p.state !== b.state) events.push(ev(track, p.state === 'closed' ? 'closed' : 'reopened', base, p.state === 'closed'));
    if ((p.comments ?? 0) > (b.comments ?? 0)) {
      // Only the PR author (or the track's ask authors) can make a comment urgent or have its text passed on.
      const who = String(p.lastCommentAuthor ?? '').toLowerCase();
      const trusted = who !== '' && (track.askAuthors?.length ? track.askAuthors : [String(p.author ?? '').toLowerCase()]).includes(who);
      events.push(ev(track, 'comment', { ...base, comment_author: p.lastCommentAuthor ?? '', ...(trusted ? { untrusted_text: p.lastComment } : {}) }, trusted && URGENT_TEXT.test(p.lastComment ?? '')));
    }
    if (p.flag !== b.flag) events.push(ev(track, 'status-line', { ...base, untrusted_text: p.flag }, URGENT_TEXT.test(p.flag)));
    if (p.state === 'open' && p.headSha !== b.headSha) events.push(ev(track, 'pushed', { ...base, head: p.headSha.slice(0, 9) }));
    if (p.state === 'open') {
      events.push(...askEvents(track, p, memo, nowMs).map((e) => ({ ...e, branch: ref })));
      memo.ciByRef = { ...(memo.ciByRef ?? {}) };
      const ciMemo = { ci: memo.ciByRef[ref] };
      events.push(...ciEvent(track, p, ciMemo).map((e) => ({ ...e, branch: ref })));
      if (ciMemo.ci) memo.ciByRef[ref] = ciMemo.ci;
      const idle = nowMs - p.updatedMs;
      memo.quiet = { ...(memo.quiet ?? {}) };
      if (idle > REPO_QUIET_MS && memo.quiet[ref] !== p.updatedMs) {
        memo.quiet[ref] = p.updatedMs;
        events.push(ev(track, 'quiet', { ...base, minutes: Math.round(idle / 60000), untrusted_text: p.flag }));
      }
    }
  }
  const r = now.release;
  const br = prev.release;
  if (r && !r.error && r.ahead > 0 && r.buildsApps && (!br || br.main !== r.main)) {
    events.push(ev(track, 'needs-release', { main: r.main, release: r.release, ahead: r.ahead }, true));
  }
  return { events, memo, active: true, view: repoView(now) };
}

function repoView(now) {
  const open = Object.values(now.prs).filter((p) => p.state === 'open').length;
  return { state: 'repo', detail: `${open} open claude/* PR${open === 1 ? '' : 's'}`, lastActivityMs: now.at };
}

export function trackEvents(track, prev, now, nowMs) {
  // A watch-only repo track finds branches (hub.mjs discover); it reports nothing itself.
  if (track.kind === 'repo' && track.discover) {
    return { events: [], memo: { ...(track.memo ?? {}), baselined: true }, active: true, view: { ...repoView(now), detail: `watching · ${repoView(now).detail}` } };
  }
  return track.kind === 'repo' ? repoTrack(track, prev, now, nowMs) : branchTrack(track, now, nowMs);
}
