// One look at one repo for every track on it: claude/* PRs (one cached list call), branch tips for tracked branches
// with no PR yet, CI of open PR heads, pending kit-channel asks, and (repo tracks with a release tree) main vs release.
import { execFileSync } from 'node:child_process';
import { setting } from './config.mjs';
import { resolveExe, safeCwd } from './exe.mjs';
import {
  pendingQuestions, staleQuestions, stripHidden, fileNames, isAgentConfigPath, PR_FILES_PAGE, PR_FILES_PAGES,
} from './asks.mjs';

const toMs = (iso) => (iso ? Date.parse(iso) : NaN);

export function ciOf(checkRuns, status) {
  const runs = checkRuns?.check_runs ?? [];
  const states = status?.statuses ?? [];
  if (!runs.length && !states.length) return '';
  if (runs.some((r) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(r.conclusion))
    || states.some((s) => ['failure', 'error'].includes(s.state))) return 'failure';
  if (runs.some((r) => r.status !== 'completed') || states.some((s) => s.state === 'pending')) return 'pending';
  return 'success';
}

function prComments(api, repo, number) {
  const all = [];
  for (let page = 1; page <= 20; page += 1) {
    const rows = api.get(`repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`) ?? [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

function agentConfigCheck(api, repo, number) {
  try {
    const names = [];
    let truncated = true;
    for (let page = 1; page <= PR_FILES_PAGES; page += 1) {
      const rows = api.get(`repos/${repo}/pulls/${number}/files?per_page=${PR_FILES_PAGE}&page=${page}`) ?? [];
      names.push(...fileNames(rows));
      if (rows.length < PR_FILES_PAGE) { truncated = false; break; }
    }
    const hits = names.filter(isAgentConfigPath).slice(0, 5).map((n) => stripHidden(n).slice(0, 200));
    return { touches_agent_config: truncated || hits.length > 0, ...(hits.length ? { agent_config_files: hits } : {}), ...(truncated ? { agent_config_check: 'truncated' } : {}) };
  } catch {
    return { touches_agent_config: true, agent_config_check: 'failed' };
  }
}

// Release check of a coordinator track (track-repo --release-tree): is the main branch ahead of the release branch
// with changes that need a release? CLOUD_PILOT_RELEASE_BRANCHES="main:release" names the two branches,
// CLOUD_PILOT_RELEASE_PATHS a regular expression of the paths that count (default: every path).
export function releaseSettings(env = process.env) {
  const [main = 'main', release = 'release'] = String(setting('RELEASE_BRANCHES', env) || 'main:release').split(':');
  const ok = (b) => /^[\w.\/-]+$/.test(b) && !b.startsWith('-') && !b.includes('..');
  let paths = null;
  try { const re = setting('RELEASE_PATHS', env); paths = re ? new RegExp(re) : null; } catch { paths = null; }
  return { main: ok(main) ? main : 'main', release: ok(release) ? release : 'release', paths };
}

function releaseState(tree, env = process.env) {
  const run = (args) => execFileSync(resolveExe('git'), ['-C', tree, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, cwd: safeCwd() }).trim();
  const cfg = releaseSettings(env);
  try {
    run(['fetch', '-q', 'origin', cfg.main, cfg.release]);
    const ahead = Number(run(['rev-list', '--count', `origin/${cfg.release}..origin/${cfg.main}`]));
    const files = ahead ? run(['diff', '--name-only', `origin/${cfg.release}`, `origin/${cfg.main}`]).split('\n').filter(Boolean) : [];
    return {
      main: run(['rev-parse', '--short=9', `origin/${cfg.main}`]),
      release: run(['rev-parse', '--short=9', `origin/${cfg.release}`]),
      ahead,
      buildsApps: files.some((f) => (cfg.paths ? cfg.paths.test(f) : true)),
    };
  } catch (e) {
    return { error: String(e.message).slice(0, 200) };
  }
}

export const CI_SETTLE_MS = 30 * 60_000; // a head with no checks this long after it was first seen has no CI
export const RELEASE_EVERY_MS = 10 * 60_000; // git fetch of the release tree at most this often
export const BY_NAME_EVERY_MS = 10 * 60_000; // a tracked branch's PR looked up by name at most this often
// Which PR of a tracked branch belongs to this track's session. A PR opened after the track registered (minus
// TRACK_GRACE_MS) does; so does an open PR (the session's, tracked late). An older closed/merged PR does only when the
// branch tip is still its head (tracked late, nothing pushed since) or, with the branch gone, when it closed within
// LATE_CLOSE_MS of registering. Otherwise it is an old PR of a reused branch name: it must not end the new track, and
// must never get the new work's branch deleted (cleanup re-checks the tip anyway).
export const TRACK_GRACE_MS = 10 * 60_000;
export const LATE_CLOSE_MS = 24 * 3600_000;

export function currentPr(pr, track, tipSha) {
  if (!pr) return null;
  if (toMs(pr.createdAt) >= (track.createdMs ?? 0) - TRACK_GRACE_MS) return pr;
  if (pr.state === 'open') return pr;
  if (tipSha) return tipSha === pr.headSha ? pr : null;
  return (track.createdMs ?? 0) - toMs(pr.closedAt) <= LATE_CLOSE_MS ? pr : null;
}

function prFact(p) {
  return {
    number: p.number, state: p.state, merged: Boolean(p.merged_at), mergedSha: p.merge_commit_sha ?? null,
    url: p.html_url, title: stripHidden(String(p.title ?? '')).slice(0, 200),
    flag: stripHidden(String(p.body ?? '').split('\n').find((l) => l.trim()) ?? '').slice(0, 300),
    author: p.user?.login ?? '', headSha: p.head?.sha ?? '', createdAt: p.created_at, closedAt: p.closed_at ?? null,
    updatedMs: toMs(p.updated_at), headRepo: headRepoOf(p), baseRef: typeof p.base?.ref === 'string' ? p.base.ref : '',
  };
}

// A PR closed without GitHub's merge whose head commit is already in its base branch (merged locally and pushed, the
// branch deleted first) counts as merged: `landed`. Read while the close is recent (CLOSE_GRACE_MS: the push to the base
// branch often comes right after the close) and at most LATE_CLOSE_MS after it; then the answer is kept.
export const CLOSE_GRACE_MS = 15 * 60_000;
export function landedCheck(api, repo, pr, before, nowMs) {
  if (pr.state !== 'closed' || pr.merged || !pr.headSha || !pr.baseRef) return;
  const same = before && before.number === pr.number && before.closedAt === pr.closedAt;
  if (same && (before.landed || before.landedFinal)) { pr.landed = Boolean(before.landed); pr.landedFinal = true; return; }
  const since = nowMs - toMs(pr.closedAt);
  if (!(since <= LATE_CLOSE_MS)) { pr.landedFinal = true; return; }
  try {
    const cmp = api.get(`repos/${repo}/compare/${encodeURIComponent(pr.baseRef)}...${pr.headSha}?per_page=1`);
    pr.landed = cmp?.status === 'behind' || cmp?.status === 'identical';
  } catch { pr.landed = false; }
  pr.landedFinal = pr.landed || since > CLOSE_GRACE_MS;
  if (pr.landed) { pr.merged = true; pr.mergedSha = null; }
}

// The repository the PR's head branch lives in, lowercase "owner/name"; '' when GitHub gives none (a deleted fork).
const headRepoOf = (p) => (typeof p?.head?.repo?.full_name === 'string' ? p.head.repo.full_name.toLowerCase() : '');
const OUT_OF_WINDOW_KEEP_MS = 7 * 24 * 3600_000; // a repo track forgets closed PRs this long out of the window

// tracks: the active tracks of this repo. publicKey: kit-channel key (null = no answer verifies).
// prev: this repo's previous snapshot (reused for PRs that did not change).
export function snapshot(api, repo, tracks, { nowMs = Date.now(), publicKey = null, release = releaseState, prev = null } = {}) {
  const repoKey = repo.toLowerCase();
  // 404 here means no access (wrong login, private repo, renamed): an error, never "no PRs".
  const pulls = api.get(`repos/${repo}/pulls?state=all&per_page=50&sort=updated&direction=desc`, { notFound: 'throw' }) ?? [];
  const branchTracks = tracks.filter((t) => t.kind === 'branch' && t.branch);
  const watchedBranches = new Set(branchTracks.map((t) => t.branch));
  const wholeRepo = tracks.some((t) => t.kind === 'repo');
  const discover = tracks.some((t) => t.kind === 'repo' && t.discover);
  const askAuthors = tracks.find((t) => t.askAuthors?.length)?.askAuthors ?? null;
  const prs = {};
  // Used for the PR list, the by-name lookups and so for discovery too: a PR counts only when its head branch is in
  // this very repository. A fork never does, and neither does a PR whose head repository is gone (GitHub answers
  // head.repo null for a deleted fork): that one cannot be told from a stranger's.
  const take = (p) => {
    const ref = p.head?.ref ?? '';
    if (!ref.startsWith('claude/') || headRepoOf(p) !== repoKey) return;
    if (prs[ref] && toMs(prs[ref].createdAt) > toMs(p.created_at)) return; // newest PR of the branch
    prs[ref] = prFact(p);
  };
  for (const p of pulls) {
    if (wholeRepo || watchedBranches.has(p.head?.ref)) take(p);
  }
  // A repo track keeps the PRs that slid out of the window (unchanged), so they are not "opened" again later.
  if (wholeRepo) {
    for (const [ref, p] of Object.entries(prev?.prs ?? {})) {
      if (prs[ref] || p.viaName) continue;
      if (p.headRepo !== repoKey) continue; // kept from a look made before the head repository was recorded, or not ours
      if (p.state !== 'open' && nowMs - (p.updatedMs ?? 0) > OUT_OF_WINDOW_KEEP_MS) continue; // bounded growth
      prs[ref] = { ...p, outOfWindow: true };
    }
  }
  // Per branch track: its branch tip (always read: cheap, and it decides which PR is the session's) and whether
  // the PR on that branch is its current one (snapshot.current[track.id]).
  const branches = {};
  const current = {};
  const byNameAt = { ...(prev?.byNameAt ?? {}) };
  for (const t of branchTracks) {
    if (!branches[t.branch]) {
      const head = api.get(`repos/${repo}/branches/${encodeURIComponent(t.branch)}`);
      branches[t.branch] = { exists: Boolean(head), tipMs: toMs(head?.commit?.commit?.committer?.date), sha: head?.commit?.sha ?? '' };
    }
    const tip = branches[t.branch].sha;
    // Its PR may sit outside the 50 most recently updated: ask for it by name when none is current in the window and
    // (the branch just vanished, the last look found it by name, or BY_NAME_EVERY_MS passed). Cached: usually a 304.
    if (!currentPr(prs[t.branch], t, tip)) {
      const vanished = !branches[t.branch].exists && prev?.branches?.[t.branch]?.exists;
      if (vanished || prev?.prs?.[t.branch]?.viaName || nowMs - (byNameAt[t.branch] ?? 0) >= BY_NAME_EVERY_MS) {
        byNameAt[t.branch] = nowMs;
        const byName = api.get(`repos/${repo}/pulls?state=all&per_page=5&head=${encodeURIComponent(`${repo.split('/')[0]}:${t.branch}`)}`) ?? [];
        for (const p of byName) take(p);
        if (prs[t.branch] && !pulls.some((p) => p.number === prs[t.branch].number)) prs[t.branch].viaName = true;
      }
    }
    current[t.id] = Boolean(currentPr(prs[t.branch], t, tip));
    if (prs[t.branch]) delete prs[t.branch].outOfWindow;
  }
  for (const [ref, pr] of Object.entries(prs)) {
    if (!pr.outOfWindow) landedCheck(api, repo, pr, prev?.prs?.[ref], nowMs);
    if (pr.state !== 'open' || pr.outOfWindow) continue;
    const before = prev?.prs?.[ref];
    // A comment (or an edit, or a push) moves the PR's updated_at, so an unchanged PR keeps its comment facts and
    // costs no call. CI does not move updated_at: it is read again while it may still change (new head, pending,
    // or no checks yet within CI_SETTLE_MS of the head first being seen).
    // While an ask is pending its comment is re-read every poll (304 when unchanged): an edit to a comment may not
    // move the PR's updated_at, and an edited ask must be reported as unanswerable.
    const same = before && before.number === pr.number && before.updatedMs === pr.updatedMs && before.headSha === pr.headSha
      && 'comments' in before && !(before.asks ?? []).length;
    if (same) {
      for (const k of ['comments', 'lastComment', 'lastCommentAuthor', 'asks', 'staleAsks', 'touches_agent_config', 'agent_config_files', 'agent_config_check']) if (k in before) pr[k] = before[k];
    } else {
      const comments = prComments(api, repo, pr.number);
      pr.comments = comments.length;
      pr.lastComment = stripHidden(String(comments.at(-1)?.body ?? '')).slice(0, 300);
      pr.lastCommentAuthor = comments.at(-1)?.user?.login ?? '';
      const authors = askAuthors ?? (pr.author ? [pr.author.toLowerCase()] : []);
      pr.asks = pendingQuestions(comments, { repo, pr: pr.number, publicKey, nowMs, authors }).map((a) => ({
        id: a.id, commentId: a.commentId, sha: a.questionSha256, author: a.author, edited: a.edited, text: stripHidden(a.text).slice(0, 2000),
      }));
      // An answer signed for an earlier head of the PR: the cloud side will not accept it (see staleQuestions).
      pr.staleAsks = staleQuestions(comments, { repo, pr: pr.number, publicKey, nowMs, headSha: pr.headSha, authors }).map((a) => ({
        id: a.id, commentId: a.commentId, sha: a.questionSha256, author: a.author, answeredHead: a.answeredHead, text: stripHidden(a.text).slice(0, 2000),
      }));
      if (pr.asks.length || pr.staleAsks.length) Object.assign(pr, agentConfigCheck(api, repo, pr.number));
    }
    pr.headSeenMs = before?.headSha === pr.headSha && before?.headSeenMs ? before.headSeenMs : nowMs;
    // success is final for a head; failure is read again (a rerun can fix it; the cache answers 304 meanwhile).
    const ciSettled = before?.headSha === pr.headSha && (before.ci === 'success'
      || (before.ci === '' && nowMs - pr.headSeenMs > CI_SETTLE_MS));
    if (ciSettled) pr.ci = before.ci;
    else if (pr.headSha) pr.ci = ciOf(api.get(`repos/${repo}/commits/${pr.headSha}/check-runs?per_page=100`), api.get(`repos/${repo}/commits/${pr.headSha}/status`));
  }
  const tree = tracks.find((t) => t.kind === 'repo' && t.releaseTree)?.releaseTree;
  let rel = null;
  if (tree) {
    const old = prev?.release;
    rel = old && !old.error && nowMs - (old.fetchedMs ?? 0) < RELEASE_EVERY_MS ? old : { ...release(tree), fetchedMs: nowMs };
  }
  // A watched repo lists its claude/* branches (one cached call) so new cloud sessions are picked up by themselves.
  let refs;
  if (discover) {
    const rows = api.get(`repos/${repo}/git/matching-refs/heads/claude/`) ?? [];
    refs = (Array.isArray(rows) ? rows : [])
      .map((r) => ({ branch: String(r?.ref ?? '').replace(/^refs\/heads\//, ''), sha: String(r?.object?.sha ?? '') }))
      .filter((r) => r.branch.startsWith('claude/'));
  }
  return { at: nowMs, prs, branches, current, release: rel, byNameAt, ...(refs ? { refs } : {}) };
}
