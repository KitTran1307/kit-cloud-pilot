// Shared builders for the channel tests: fake GitHub comments, signed answers, a fake GitHub API. Not a test file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAskBody, buildAnswerPayload, buildAnswerBody, signAnswer, questionSha256, findVerifiedAnswer, listAsks } from '../cloud/channel.mjs';

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CHANNEL_DIR = path.resolve(TESTS_DIR, '..');
export const PILOT_ROOT = path.resolve(CHANNEL_DIR, '..');
export const FIXTURES = path.join(TESTS_DIR, 'fixtures');

export const MIN = 60000;
export const HOUR = 3600000;
export const T0 = Date.parse('2026-11-05T10:00:00Z');
export const REPO = 'acme/app';
export const PR = 7;
export const ID = 'deploy-ok';
export const AUTHOR = 'cloud-bot';
export const QUESTION = 'Deploy now?';
export const ASK_ID = 100;
export const HEAD = 'a1'.repeat(20);
export const KEYS = crypto.generateKeyPairSync('ed25519');
export const iso = (ms) => new Date(ms).toISOString();

// Temp folders live until the test process exits (works the same on every Node version that has node:test).
const made = [];
process.on('exit', () => {
  for (const dir of made) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
export function tmpDir(prefix = 'cloudpilot-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

// An empty folder that looks like the root of a git working tree (a .git folder is all the tools look for).
export function fakeRepo(prefix = 'cloudpilot-repo-') {
  const dir = tmpDir(prefix);
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

// A GitHub issue comment as the REST API returns it. `updatedMs` differs from the creation time when edited.
export const comment = (id, atMs, body, { author = AUTHOR, updatedMs = atMs } = {}) => ({
  id, created_at: iso(atMs), updated_at: iso(updatedMs), user: { login: author },
  html_url: `https://github.com/${REPO}/pull/${PR}#c${id}`, body,
});
export const askC = (id = ASK_ID, atMs = T0, qid = ID, text = QUESTION, extra = {}) => comment(id, atMs, buildAskBody({ id: qid, text, askedAt: iso(atMs) }), extra);
export const fields = (over = {}) => ({
  repo: REPO, pr: PR, id: ID, askCommentId: ASK_ID, questionSha256: questionSha256(QUESTION), headSha: HEAD, answer: 'yes, deploy', ...over,
});
// A signed answer comment; `over` overrides payload fields, `key` the signing key.
export function answerC(id, atMs, { over = {}, key = KEYS.privateKey, issuedMs = atMs, validHours = 24, ...rest } = {}) {
  const payload = { ...buildAnswerPayload({ ...fields(rest), issuedAt: iso(issuedMs), validHours }), ...over };
  return comment(id, atMs, buildAnswerBody({ privateKey: key, payload }), { author: 'owner' });
}
// A comment holding a signed payload exactly as given (bypasses the builder's own checks).
export const rawAnswerC = (id, atMs, payload, key = KEYS.privateKey) => comment(id, atMs, `<!-- kit-channel:answer ${signAnswer(key, payload)} -->`, { author: 'owner' });
export const ctx = (nowMs = T0 + 10 * MIN, publicKey = KEYS.publicKey, headSha = HEAD) => ({ repo: REPO, pr: PR, nowMs, publicKey, headSha });
export const verified = (comments, nowMs, publicKey) => findVerifiedAnswer(comments, listAsks(comments)[0], ctx(nowMs, publicKey));

// A fake GitHub API over a comment list: reads comments, the PR (author, head sha, head and base repository, default branch)
// and the files the head changes against the default branch (the compare endpoint, `files`); POSTs add a comment.
// `headRepo` is the PR's head repository (null: unknown, like a deleted fork); `baseRef` the PR's own base branch.
export function fakeGithub(initial, {
  prAuthor = AUTHOR, files = [], filesError = false, headSha = HEAD, headRepo = REPO, defaultBranch = 'main', baseRef = 'main',
} = {}) {
  const comments = [...initial];
  const posts = [];
  const state = { headSha, files, headRepo, defaultBranch, baseRef, calls: [] };
  const api = async (p, body) => {
    state.calls.push(p);
    if (body) {
      posts.push({ path: p, body });
      // an ask is posted by the cloud session (the PR author's account), an answer by the person ('owner')
      const login = body.body.includes('kit-channel:ask') ? prAuthor : 'owner';
      const posted = { id: 1000 + posts.length, html_url: 'https://github.com/x', created_at: iso(T0), updated_at: iso(T0), user: { login }, body: body.body };
      comments.push(posted);
      return posted;
    }
    if (p.includes('/comments?')) {
      const page = Number(/&page=(\d+)/.exec(p)[1]);
      return comments.slice((page - 1) * 100, page * 100);
    }
    if (p === `repos/${REPO}/pulls/${PR}`) {
      return {
        number: PR, user: { login: prAuthor }, changed_files: state.files.length,
        head: { ...(state.headSha === null ? {} : { sha: state.headSha }), repo: state.headRepo === null ? null : { full_name: state.headRepo } },
        base: { ref: state.baseRef, repo: { full_name: REPO, default_branch: state.defaultBranch } },
      };
    }
    // Like GitHub: compare lists at most 300 files, on page 1 only; the PR's own list pages up to 3000.
    if (p.startsWith(`repos/${REPO}/compare/`)) {
      if (filesError) throw new Error('files unavailable');
      const page = Number(/&page=(\d+)/.exec(p)[1]);
      return page === 1 ? { files: state.files.slice(0, 300).map((filename) => ({ filename })) } : { commits: [] };
    }
    if (p.startsWith(`repos/${REPO}/pulls/${PR}/files?`)) {
      const page = Number(/&page=(\d+)/.exec(p)[1]);
      return page > 30 ? [] : state.files.slice(0, 3000).slice((page - 1) * 100, page * 100).map((filename) => ({ filename }));
    }
    throw new Error(`unexpected ${p}`);
  };
  return { api, comments, posts, state };
}
export const waitOpts = (over = {}) => ({ repo: REPO, pr: PR, id: ID, timeoutMin: 10, intervalSec: 60, askAuthors: null, ...over });
export const clockDeps = (gh, startMs) => { let clock = startMs; return { api: gh.api, now: () => clock, sleep: async (ms) => { clock += ms; } }; };

// Collects the lines a command prints.
export function capture() {
  const lines = [];
  return { lines, out: (line) => lines.push(line), json: () => lines.map((l) => JSON.parse(l)) };
}

export const publicPem = (key = KEYS.publicKey) => key.export({ type: 'spki', format: 'pem' });

// Every file below `dir`, as absolute paths (skips nothing).
export function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
