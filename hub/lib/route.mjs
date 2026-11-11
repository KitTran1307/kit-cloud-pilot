// Pure: who gets a track's events. The owner session while it lives; else a live waiting session on the same repo
// (and account, for a branch track), which then becomes the owner; else the owner's queue keeps them and the owner
// (the person) is told.
//
// "Alive" for a session: its CLAUDE_PID runs, or one of its waiters runs with a live session pid. A resumed session
// keeps its session id but gets a new pid; its waiter carries the new one, so it stays the owner.

export function sameRepo(waiter, track) {
  if (waiter.gh && track.repo) return waiter.gh.toLowerCase() === track.repo.toLowerCase();
  return false;
}

const liveWaiter = (w, isAlive) => isAlive(w.waiterPid) && isAlive(w.pid);

export function ownerAlive(track, waiters, isAlive) {
  const owner = track.owner ?? {};
  if (!owner.sessionId) return null;
  const w = waiters.find((x) => x.sessionId === owner.sessionId && liveWaiter(x, isAlive));
  if (w) return { ...owner, pid: w.pid };
  return isAlive(owner.pid) ? owner : null;
}

export function pickHeir(track, waiters, isAlive) {
  const live = waiters.filter((w) => liveWaiter(w, isAlive) && w.sessionId !== track.owner?.sessionId && sameRepo(w, track));
  const sameAccount = live.filter((w) => !track.owner?.account || w.account === track.owner.account);
  const pool = track.kind === 'branch' ? sameAccount : (sameAccount.length ? sameAccount : live);
  return pool.sort((a, b) => (b.since ?? 0) - (a.since ?? 0))[0] ?? null;
}

// -> { to: sessionId, newOwner: owner | null, orphaned: boolean }
export function route(track, waiters, isAlive) {
  const owner = track.owner ?? {};
  const alive = ownerAlive(track, waiters, isAlive);
  if (alive) return { to: owner.sessionId, newOwner: alive.pid !== owner.pid ? alive : null, orphaned: false };
  const heir = pickHeir(track, waiters, isAlive);
  if (heir) {
    return { to: heir.sessionId, newOwner: { sessionId: heir.sessionId, pid: heir.pid, account: heir.account, repoRoot: heir.repoRoot }, orphaned: false };
  }
  return { to: owner.sessionId || 'unowned', newOwner: null, orphaned: true };
}
