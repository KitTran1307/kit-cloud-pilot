// Accounts set aside: a cloud session started from the account pushed nothing to GitHub in its first minutes (no-push),
// which most often means the account's GitHub connection on claude.ai lapsed. `cloud-pilot start` refuses such an
// account, so no new cloud session is sent where it cannot push. It is cleared by evidence (a session of that account
// pushes after all) or by the person after reconnecting GitHub (`cloud-pilot account --ok <name>`).
import { readJson, writeJson, withLock } from './store.mjs';

export const RECONNECT_URL = 'https://claude.ai/connect-github';

export function setAsideAccounts(p) {
  const all = readJson(p.accounts, {}, { cache: true });
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}

export function setAsideOf(p, account) {
  return (account && setAsideAccounts(p)[account]) || null;
}

// Call inside withLock. Keeps the first time and session that showed it.
export function setAside(p, account, info, nowMs = Date.now()) {
  if (!account) return false;
  const all = setAsideAccounts(p);
  if (all[account]) return false;
  all[account] = { sinceMs: nowMs, reason: 'no-push', ...info };
  writeJson(p.accounts, all);
  return true;
}

// Call inside withLock.
export function clearAside(p, account) {
  const all = setAsideAccounts(p);
  if (!account || !all[account]) return false;
  delete all[account];
  writeJson(p.accounts, all);
  return true;
}

// For the person's `account --ok`: also drops the account from state.json at once, so the band stops saying it even
// when no hub is running to rewrite that file.
export function clearAsideLocked(p, account) {
  return withLock(p, () => {
    const cleared = clearAside(p, account);
    const st = readJson(p.state, null, { cache: true });
    if (st && st.accounts && st.accounts[account]) {
      const accounts = { ...st.accounts };
      delete accounts[account];
      writeJson(p.state, { ...st, accounts });
    }
    return cleared;
  });
}

export function asideMessage(account, entry) {
  const when = entry?.sinceMs ? new Date(entry.sinceMs).toISOString() : 'earlier';
  return `account ${account} is set aside for cloud sessions: its session ${entry?.url || entry?.branch || ''}${entry?.repo ? ` on ${entry.repo}` : ''} pushed nothing to GitHub (${when}), so its GitHub connection has probably lapsed (or the Claude GitHub App is missing on that repository). Do the work locally instead. Once GitHub is reconnected for this account (${RECONNECT_URL}, or /web-setup in that account), run: cloud-pilot account --ok ${account}`;
}
