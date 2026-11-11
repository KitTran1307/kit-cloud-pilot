// GitHub REST GETs through the gh CLI with ETag caching: an unchanged resource answers 304, which GitHub does not
// count against the rate limit. The cache keeps the last body per path, so a 304 returns it.
import { execFileSync } from 'node:child_process';
import { readJson, writeJson } from './store.mjs';
import { resolveExe, safeCwd } from './exe.mjs';

export function parseInclude(raw) {
  // `gh api -i` prints the status line and headers, a blank line, then the body.
  const text = String(raw).replace(/\r/g, '');
  const cut = text.indexOf('\n\n');
  const head = cut >= 0 ? text.slice(0, cut) : text;
  const body = cut >= 0 ? text.slice(cut + 2) : '';
  const status = Number((head.match(/^HTTP\/[\d.]+ (\d{3})/) || [])[1] || 0);
  const etag = (head.match(/^etag:\s*(.+)$/im) || [])[1]?.trim() || '';
  return { status, etag, body };
}

function runGh(args, token) {
  try {
    const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
    return { out: execFileSync(resolveExe('gh'), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, windowsHide: true, maxBuffer: 1 << 26, env, cwd: safeCwd() }) };
  } catch (err) {
    return { out: String(err.stdout ?? ''), err: String(err.stderr || err.message) };
  }
}

// The repo owner's own gh login when it is one of the logged-in accounts (gh can hold several), else the active one.
// The token stays in this process (passed to gh as GH_TOKEN), never written or logged.
const TOKEN_MISS_RETRY_MS = 10 * 60_000; // a login added later is picked up within this

export function makeTokenFor({ exec = execFileSync, now = Date.now } = {}) {
  const cache = new Map();
  return (owner) => {
    if (!owner) return null;
    const key = owner.toLowerCase();
    const hit = cache.get(key);
    if (!hit || (hit.token === null && now() - hit.at > TOKEN_MISS_RETRY_MS)) {
      let token = null;
      try {
        token = String(exec(resolveExe('gh'), ['auth', 'token', '--user', owner], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15000, cwd: safeCwd() })).trim() || null;
      } catch { /* not a logged-in account: the active one is used */ }
      cache.set(key, { token, at: now() });
    }
    return cache.get(key).token;
  };
}

const ownerOf = (path) => (String(path).match(/^repos\/([^/]+)\//) || [])[1] || '';
export const ETAG_KEEP_MS = 3 * 24 * 3600_000; // cache entries unused this long are dropped at flush

// makeApi(etagFile) -> { get(path, { notFound }) -> parsed JSON, stats }. A 404 answers null, or throws with
// { notFound: 'throw' } (a repo-level read: 404 there means no access, never "nothing there"). Other failures throw.
export function makeApi(etagFile, { run = runGh, save = true, tokenFor = () => null, now = Date.now, onCall = () => {} } = {}) {
  const cache = readJson(etagFile, {}, { cache: true });
  const stats = { calls: 0, notModified: 0, fetched: 0 };
  let dirty = false;
  return {
    stats,
    get(path, { notFound = 'null' } = {}) {
      stats.calls += 1;
      onCall();
      const hit = cache[path];
      const args = ['api', '-i', path];
      if (hit?.etag) args.push('-H', `If-None-Match: ${hit.etag}`);
      const { out, err } = run(args, tokenFor(ownerOf(path)));
      const res = parseInclude(out);
      if (res.status === 304 && hit) {
        stats.notModified += 1;
        if (now() - (hit.used ?? 0) > 3600_000) { hit.used = now(); dirty = true; } // coarse: no rewrite on every 304
        return hit.body;
      }
      if (res.status === 404) {
        if (notFound === 'throw') throw new Error(`gh api ${path}: 404 (no access with the ${ownerOf(path)} login, or the repo is gone)`);
        return null;
      }
      if (res.status >= 200 && res.status < 300) {
        stats.fetched += 1;
        const body = res.body.trim() ? JSON.parse(res.body) : null;
        if (res.etag) { cache[path] = { etag: res.etag, body, used: now() }; dirty = true; }
        return body;
      }
      throw new Error(`gh api ${path} failed: ${(err || `HTTP ${res.status}`).trim().split('\n')[0]}`);
    },
    // Non-cached write (only the merged-branch cleanup uses it).
    del(path) {
      const { err } = run(["api", "-X", "DELETE", path], tokenFor(ownerOf(path)));
      if (err && !/HTTP 422|HTTP 404/.test(err)) throw new Error(`gh api DELETE ${path} failed: ${err.trim().split('\n')[0]}`);
    },
    flush() {
      const cut = now() - ETAG_KEEP_MS;
      for (const [k, v] of Object.entries(cache)) if ((v.used ?? 0) < cut) { delete cache[k]; dirty = true; }
      if (dirty && save) writeJson(etagFile, cache);
      dirty = false;
    },
    // Read a branch tip sha without the cache (right before a delete).
    tipSha(repo, branch) {
      const { out } = run(['api', `repos/${repo}/branches/${branch.split('/').map(encodeURIComponent).join('%2F')}`, '--jq', '.commit.sha'], tokenFor(ownerOf(`repos/${repo}/`)));
      const sha = String(out ?? '').trim();
      return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : ''; // a deleted branch prints an error body or "null"
    },
  };
}
