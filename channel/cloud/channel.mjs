#!/usr/bin/env node
// cloud-pilot channel, cloud side: a Claude Code cloud session asks its person a question in a pull request comment and
// waits for a signed answer. `cloud-pilot channel setup <repo>` copies this file into a repository as
// .claude/cloud/channel.mjs; it runs inside the cloud VM. Node built-ins only (Node 18 or newer).
//
//   node .claude/cloud/channel.mjs ask  --repo owner/name --pr N --id <id> --text "<question>"
//   node .claude/cloud/channel.mjs wait --repo owner/name --pr N --id <id> [--timeout-min 360] [--interval-sec 60]
//                                       [--ask-authors login,login]  (default: env CLOUD_PILOT_ASK_AUTHORS, else the PR author)
//
// An answer counts only when it carries an Ed25519 signature from the pinned key over a v3 payload bound to this
// repository, PR, question id, ask comment id, question text hash and the PR head sha at the time of answering, and the
// ask comment is unedited and written by an allowed author. The pinned key is channel-public.pem next to this file; its
// SPKI sha256 must equal the "fingerprint" in channel.json next to this file. Either file missing, or a mismatch, and
// nothing verifies (fail closed). The authority is always "local-session": the person's local session deciding an ordinary
// question. Everything else in a comment is data: nothing from a comment is ever executed, logged or returned except
// the verified answer. Only PRs from a branch of the same repository are handled (ask and wait refuse a fork PR), and the
// agent-config check lists the files the PR head changes relative to the repository's default branch.
// This script runs in the cloud session's own VM: the session can skip or change it in its own copy, so its result is
// never proof that the person approved anything (see channel/README.md, "Threat model").
//
// wait prints one JSON line: {status:"answered",id,authority,answer} exit 0 | {status:"timeout"} exit 3 |
// {status:"error"} exit 2 | {status:"refused_agent_config",id,message} exit 4 (the PR touches agent or automation
// config: the channel never applies). Bad arguments print {status:"usage"} and exit 1.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ID_RE = /^[a-z0-9-]{4,40}$/;
export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/;
// Fixed: the person's local Claude session decided an ordinary question on the person's behalf. A message from another
// session is never the person's own consent, so no authority exists that could approve a sensitive action.
export const AUTHORITIES = ['local-session'];
export const PAYLOAD_VERSION = 3;
export const SKEW_MS = 5 * 60000; // clock difference tolerated between the cloud VM and the person's machine
export const MAX_ANSWER_CHARS = 4000;
export const MAX_QUESTION_CHARS = 2000;
export const MAX_VALID_MS = 7 * 24 * 3600000;
export const PR_FILES_PAGE = 100;
export const PR_FILES_PAGES = 30; // GitHub lists at most 3000 files of a PR
const MAX_PAYLOAD_BYTES = 24 * 1024;
const PAGE = 100;
const MAX_PAGES = 20;
const ERROR_TICKS = 3;
const AGENT_CONFIG_DIRS = new Set(['.claude', '.agents', '.codex', '.githooks', '.github', '.husky', '.vscode', '.devcontainer', '.cursor']);
const AGENT_CONFIG_FILE_RE = /^(?:(?:claude|agents|claude\.local|gemini)\.md|\.mcp\.json)$/i;
// Bidi controls, zero-width characters, variation selectors, tag characters, fillers, line/paragraph separators and other
// invisible/control characters (kept: newline, tab, CR).
const HIDDEN_RE = /[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{7F}-\u{9F}\u{AD}\u{34F}\u{61C}\u{180E}\u{200B}-\u{200F}\u{2028}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{3164}\u{FE00}-\u{FE0F}\u{FEFF}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const ASK_RE = /<!--[ \t]*kit-channel:ask[ \t]+(\{[^\n]*?\})[ \t]*-->/;
const ANSWER_RE = /<!--[ \t]*kit-channel:answer[ \t]+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)[ \t]*-->/g;
const SHA_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-fA-F]{40}$/;
// The word before "(<id>):" in front of the question text. New asks use the English one; the second is the protocol's
// original label, still accepted so asks written by older copies of this script keep working.
export const ASK_LABEL = 'WAITING FOR YOU';
export const LEGACY_ASK_LABEL = 'CH\u{1EDC} B\u{1EA0}N';
const ASK_LABELS = [ASK_LABEL, LEGACY_ASK_LABEL];

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_KEY_FILE = path.join(HERE, 'channel-public.pem');
export const PIN_FILE = path.join(HERE, 'channel.json');

export function publicKeyFingerprint(key) {
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

// The pinned fingerprint from a channel.json file. Throws when the file is missing, unreadable or holds no valid pin.
export function readPin(file = PIN_FILE) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(err?.code === 'ENOENT'
      ? `${path.basename(file)} (the key pin) not found next to the script; refusing to verify`
      : `${path.basename(file)} is not valid JSON; refusing to verify`);
  }
  const pin = data?.fingerprint;
  if (typeof pin !== 'string' || !/^[0-9a-fA-F]{64}$/.test(pin)) throw new Error(`${path.basename(file)} holds no valid "fingerprint" (64 hex characters); refusing to verify`);
  return pin.toLowerCase();
}

// Always Ed25519. `fingerprint` (SPKI sha256, hex) pins the key when given; null or undefined means unpinned.
export function loadPublicKey(file, { fingerprint = null } = {}) {
  const key = crypto.createPublicKey(fs.readFileSync(file));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('public key is not an ed25519 key');
  if (fingerprint && publicKeyFingerprint(key) !== String(fingerprint).toLowerCase()) throw new Error('public key fingerprint does not match the pinned one; refusing to verify');
  return key;
}

// The key this script trusts: channel-public.pem and the pin in channel.json, both from `dir` (default: next to this file).
// Fails closed: a missing key file, a missing or malformed pin, or a pin that does not match all throw.
export function loadTrustedKey(dir = HERE) {
  const keyFile = path.join(dir, 'channel-public.pem');
  if (!fs.existsSync(keyFile)) throw new Error('channel-public.pem not found next to the script; refusing to verify');
  const pin = readPin(path.join(dir, 'channel.json'));
  return loadPublicKey(keyFile, { fingerprint: pin });
}

export function loadPrivateKey(file) {
  return crypto.createPrivateKey(fs.readFileSync(file));
}

const toMs = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN);

export const questionSha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

// For display to a person or model only: invisible and bidi characters removed. Never hash or compare this.
export const stripHidden = (text) => String(text).replace(HIDDEN_RE, '');

// ---- agent / automation config -----------------------------------------------------------------------------------

// .claude/ .agents/ .codex/ .githooks/ .github/ .husky/ .vscode/ .devcontainer/ .cursor/ at any depth, and CLAUDE.md /
// AGENTS.md / CLAUDE.local.md / GEMINI.md / .mcp.json anywhere.
export function isAgentConfigPath(file) {
  if (typeof file !== 'string' || !file) return false;
  const parts = file.replace(/\\/g, '/').split('/');
  const base = parts.pop();
  return parts.some((dir) => AGENT_CONFIG_DIRS.has(dir.toLowerCase())) || AGENT_CONFIG_FILE_RE.test(base);
}

// Every name a PR file row can stand for (new and renamed-from).
export function fileNames(rows) {
  if (!Array.isArray(rows)) throw new Error('unexpected files response');
  return rows.flatMap((row) => [row?.filename, row?.previous_filename].filter((n) => typeof n === 'string'));
}

export const COMPARE_FILES_MAX = 300; // GitHub compare lists at most 300 files, all on its first page

// { names, truncated }: the files a PR head changes relative to the repository's DEFAULT branch (GitHub compare
// default...head), not relative to the PR's own base branch: a PR opened against a branch that already carries an
// agent-config change still lists that change. Compare lists at most COMPARE_FILES_MAX files (only on page 1; later pages
// hold commits, no files). A longer list is read from the PR's own file list (up to 3000 files) when the PR's base is the
// default branch (the same three-dot diff) and that list holds every changed file; otherwise truncated (may be incomplete).
// `pr` (optional): { number, baseRef, changedFiles } from prInfo.
export async function listCompareFiles(api, repo, defaultBranch, headSha, pr = null) {
  const basehead = `${String(defaultBranch).split('/').map(encodeURIComponent).join('/')}...${headSha}`;
  const rows = (await api(`repos/${repo}/compare/${basehead}?per_page=${PR_FILES_PAGE}&page=1`))?.files;
  const names = fileNames(rows);
  if (rows.length < COMPARE_FILES_MAX) return { names, truncated: false };
  if (!pr || !Number.isInteger(pr.number) || pr.baseRef !== defaultBranch || !Number.isInteger(pr.changedFiles)) return { names, truncated: true };
  const all = [];
  let count = 0;
  for (let page = 1; page <= PR_FILES_PAGES; page += 1) {
    const prRows = await api(`repos/${repo}/pulls/${pr.number}/files?per_page=${PR_FILES_PAGE}&page=${page}`);
    all.push(...fileNames(prRows));
    count += prRows.length;
    if (prRows.length < PR_FILES_PAGE) break;
  }
  return { names: [...new Set([...names, ...all])], truncated: count < pr.changedFiles };
}

// "a, B" -> ['a','b']; undefined or blank -> null (not given). Throws on anything that is not a GitHub login.
export function parseAuthorList(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const logins = raw.split(',').map((x) => x.trim()).filter(Boolean);
  if (!logins.length || !logins.every((l) => LOGIN_RE.test(l))) throw new Error('--ask-authors must be a comma list of GitHub logins');
  return logins.map((l) => l.toLowerCase());
}

// The allowed-asker list from the environment: CLOUD_PILOT_ASK_AUTHORS, else the older KIT_CHANNEL_ASK_AUTHORS; null when unset.
export function askAuthorsFromEnv(env = process.env) {
  const raw = [env.CLOUD_PILOT_ASK_AUTHORS, env.KIT_CHANNEL_ASK_AUTHORS].find((v) => typeof v === 'string' && v.trim());
  return parseAuthorList(raw);
}

// ---- ask comment -------------------------------------------------------------------------------------------------

export function buildAskBody({ id, text, askedAt }) {
  if (!ID_RE.test(id)) throw new Error('--id must match [a-z0-9-]{4,40}');
  if (typeof text !== 'string' || !text.trim()) throw new Error('--text is empty');
  const meta = JSON.stringify({ v: 1, id, asked_at: askedAt });
  return `<!-- kit-channel:ask ${meta} -->\n${ASK_LABEL} (${id}): ${text.trim().slice(0, MAX_QUESTION_CHARS)}`;
}

// The first well-formed ask block of a comment body, or null. Never throws. The text is what follows the first label
// found (either spelling), or everything after the block when there is no label.
export function parseAsk(body) {
  const match = typeof body === 'string' ? body.match(ASK_RE) : null;
  if (!match) return null;
  let meta;
  try { meta = JSON.parse(match[1]); } catch { return null; }
  if (!meta || meta.v !== 1 || typeof meta.id !== 'string' || !ID_RE.test(meta.id)) return null;
  const askedAtMs = toMs(meta.asked_at);
  if (!Number.isFinite(askedAtMs)) return null;
  let tail = body.slice(match.index + match[0].length);
  for (const word of ASK_LABELS) {
    const label = `${word} (${meta.id}):`;
    const at = tail.indexOf(label);
    if (at !== -1) { tail = tail.slice(at + label.length); break; }
  }
  return { id: meta.id, askedAtMs, text: tail.trim().slice(0, MAX_QUESTION_CHARS) };
}

// Every ask in a list of issue comments, oldest first. With `authors` (lowercase logins) only asks written by them count.
// { id, askedAtMs, text, commentId, createdMs, edited, author, url, questionSha256 }. The time base is GitHub's created_at;
// asked_at inside the body is self-reported and unused. edited: updated_at is not exactly created_at (or missing).
export function listAsks(comments, { authors } = {}) {
  const allowed = authors ? new Set(authors.map((a) => String(a).toLowerCase())) : null;
  const out = [];
  for (const c of comments ?? []) {
    const ask = parseAsk(c?.body);
    const createdMs = toMs(c?.created_at);
    if (!ask || !Number.isFinite(createdMs) || !Number.isFinite(c.id)) continue;
    const author = typeof c.user?.login === 'string' ? c.user.login : null;
    if (allowed && !(author && allowed.has(author.toLowerCase()))) continue;
    out.push({
      ...ask, commentId: c.id, createdMs, edited: typeof c.updated_at !== 'string' || c.updated_at !== c.created_at, author,
      url: c.html_url ?? null, questionSha256: questionSha256(ask.text),
    });
  }
  return out.sort((a, b) => a.commentId - b.commentId);
}

// ---- signed answer -----------------------------------------------------------------------------------------------

export function signAnswer(privateKey, payload) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.sign(null, bytes, privateKey);
  return `${bytes.toString('base64url')}.${sig.toString('base64url')}`;
}

const sameSha = (a, b) => typeof a === 'string' && typeof b === 'string' && GIT_SHA_RE.test(a) && GIT_SHA_RE.test(b) && a.toLowerCase() === b.toLowerCase();

// `authority` and `ownerQuote` are accepted only to refuse anything but the fixed local-session authority.
export function buildAnswerPayload({ repo, pr, id, askCommentId, questionSha256: sha, headSha, answer, authority = 'local-session', ownerQuote, issuedAt, validHours }) {
  if (authority !== 'local-session') throw new Error('authority must be local-session');
  if (ownerQuote !== undefined) throw new Error('an owner quote is not allowed: channel answers carry no consent of the person');
  if (!Number.isInteger(askCommentId) || askCommentId < 1) throw new Error('ask comment id must be a positive integer');
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new Error('question hash must be 64 lowercase hex characters');
  if (typeof headSha !== 'string' || !GIT_SHA_RE.test(headSha) || headSha !== headSha.toLowerCase()) throw new Error('PR head sha must be 40 lowercase hex characters');
  const issuedMs = Date.parse(issuedAt);
  return {
    v: PAYLOAD_VERSION, repo, pr, id, ask_comment_id: askCommentId, question_sha256: sha, head_sha: headSha, answer, authority,
    issued_at: issuedAt, expires_at: new Date(issuedMs + validHours * 3600000).toISOString(),
  };
}

// Plain-text copy for people reading the PR. Display only: never parsed, never trusted. HTML comment markers are defanged
// and the text sits in a code fence, so it can neither mention anyone nor look like a channel block.
const defang = (s) => String(s).replace(/<!--/g, '<!- -').replace(/-->/g, '- ->');
function fenced(text) {
  const safe = defang(text);
  const longest = Math.max(0, ...(safe.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${safe}\n${fence}`;
}

export function buildAnswerBody({ privateKey, payload }) {
  const authority = AUTHORITIES.includes(payload.authority) ? payload.authority : 'unknown';
  return [
    `<!-- kit-channel:answer ${signAnswer(privateKey, payload)} -->`,
    `CLOUD-PILOT ANSWER (${String(payload.id).replace(/[^a-z0-9-]/g, '')}). Display only, never trusted: just the signed block above counts.`,
    `Authority: ${authority}`,
    'Answer:', fenced(payload.answer),
  ].join('\n');
}

// All signature-shaped blocks of a comment body: [{ payloadB64, sigB64 }]. Malformed blocks simply do not match.
export function parseAnswerBlocks(body) {
  if (typeof body !== 'string') return [];
  return [...body.matchAll(ANSWER_RE)].map((m) => ({ payloadB64: m[1], sigB64: m[2] }));
}

// Checks one block against the key and the exact ask it must answer. Returns { ok:true, answer, authority, issuedAt, expiresAt, headSha }
// or { ok:false, reason }. `ask` is an entry of listAsks() ({ commentId, createdMs, questionSha256 }); `ctx` is
// { repo, pr, id, nowMs, publicKey, headSha } where headSha is the PR head right now (required: no known head fails closed).
// ctx.ignoreHead / ctx.ignoreExpiry skip those two checks (only for "was this ask handled at all", never to accept an answer).
// Only the signed payload is read: the visible text around a block never matters.
export function verifyBlock(block, ask, ctx) {
  const bad = (reason) => ({ ok: false, reason });
  if (ctx.publicKey?.asymmetricKeyType !== 'ed25519') return bad('key type');
  const bytes = Buffer.from(block.payloadB64, 'base64url');
  const sig = Buffer.from(block.sigB64, 'base64url');
  if (bytes.length === 0 || bytes.length > MAX_PAYLOAD_BYTES || sig.length !== 64) return bad('shape');
  let valid = false;
  try { valid = crypto.verify(null, bytes, ctx.publicKey, sig); } catch { valid = false; }
  if (!valid) return bad('signature');
  let p;
  try { p = JSON.parse(bytes.toString('utf8')); } catch { return bad('json'); }
  if (!p || typeof p !== 'object' || p.v !== PAYLOAD_VERSION) return bad('version');
  if (typeof p.repo !== 'string' || p.repo.toLowerCase() !== ctx.repo.toLowerCase()) return bad('repo');
  if (p.pr !== Number(ctx.pr)) return bad('pr');
  if (p.id !== ctx.id) return bad('id');
  if (p.ask_comment_id !== ask.commentId) return bad('ask comment');
  if (p.question_sha256 !== ask.questionSha256) return bad('question text');
  if (!AUTHORITIES.includes(p.authority)) return bad('authority');
  if ('owner_quote' in p) return bad('owner_quote');
  if (!ctx.ignoreHead && !(sameSha(p.head_sha, ctx.headSha))) return bad('head');
  if (ctx.ignoreHead && !(typeof p.head_sha === 'string' && GIT_SHA_RE.test(p.head_sha))) return bad('head');
  if (typeof p.answer !== 'string' || !p.answer.trim() || p.answer.length > MAX_ANSWER_CHARS) return bad('answer');
  const issued = toMs(p.issued_at);
  const expires = toMs(p.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > MAX_VALID_MS) return bad('dates');
  if (!ctx.ignoreExpiry && !(ctx.nowMs < expires)) return bad('expired');
  if (issued > ctx.nowMs + SKEW_MS) return bad('from the future');
  if (issued < ask.createdMs - SKEW_MS) return bad('older than the ask');
  return { ok: true, answer: p.answer, authority: p.authority, issuedAt: p.issued_at, expiresAt: p.expires_at, headSha: p.head_sha };
}

// First verified answer to `ask` among the comments, or null. Only comments created after the ask comment count, and an
// edited ask is never answered. `ask` is an entry of listAsks(); `ctx` is { repo, pr, nowMs, publicKey } (the id comes from the ask).
export function findVerifiedAnswer(comments, ask, ctx) {
  if (ask.edited) return null;
  const sorted = [...(comments ?? [])].filter((c) => Number.isFinite(c?.id)).sort((a, b) => a.id - b.id);
  for (const c of sorted) {
    if (c.id <= ask.commentId) continue;
    const createdMs = toMs(c.created_at);
    if (!Number.isFinite(createdMs) || createdMs < ask.createdMs) continue;
    for (const block of parseAnswerBlocks(c.body)) {
      const res = verifyBlock(block, ask, { ...ctx, id: ask.id });
      if (res.ok) return { ...res, commentId: c.id };
    }
  }
  return null;
}

// Has the ask any properly signed answer, whether or not it is still valid for the cloud (expired, or given for an earlier PR head)?
// Lets a watcher avoid reporting an ask the local session already handled. An edited ask has none.
export function hasValidAnswer(comments, ask, ctx) {
  return findVerifiedAnswer(comments, ask, { ...ctx, ignoreHead: true, ignoreExpiry: true }) !== null;
}

// Asks (optionally only from `authors`, only created after `afterMs`, never those whose comment id is in `ignoreIds`) that have no
// signed answer at all. An edited ask is listed too (it can never be answered): the caller flags it.
export function pendingQuestions(comments, { repo, pr, publicKey, nowMs, afterMs = -Infinity, authors, ignoreIds }) {
  const ignored = new Set(ignoreIds ?? []);
  return listAsks(comments, { authors })
    .filter((ask) => ask.createdMs > afterMs && !ignored.has(ask.commentId))
    .filter((ask) => !hasValidAnswer(comments, ask, { repo, pr, nowMs, publicKey }));
}

// ---- GitHub access -----------------------------------------------------------------------------------------------

// gh when installed, otherwise fetch with GH_TOKEN. `body` (object) makes it a POST. Never puts the token in a message.
export async function ghApi(path_, body) {
  try {
    const args = ['api', path_, ...(body ? ['-X', 'POST', '--input', '-'] : [])];
    const out = execFileSync('gh', args, {
      encoding: 'utf8', input: body ? JSON.stringify(body) : undefined,
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 64 * 1024 * 1024,
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new Error(`gh api failed: ${String(err.stderr || err.message).trim().split('\n')[0].slice(0, 200)}`);
  }
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('gh is not installed and GH_TOKEN is not set');
  const res = await fetch(`https://api.github.com/${path_}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'cloud-pilot-channel',
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`github api HTTP ${res.status}`);
  return res.json();
}

export async function listComments(api, repo, pr) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await api(`repos/${repo}/issues/${pr}/comments?per_page=${PAGE}&page=${page}`);
    if (!Array.isArray(rows)) throw new Error('unexpected comments response');
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

// The PR author's login as the default allowed asker ([] when unknown, which accepts no ask).
export async function prAuthors(api, repo, pr) {
  const login = (await api(`repos/${repo}/pulls/${pr}`))?.user?.login;
  return typeof login === 'string' && login ? [login.toLowerCase()] : [];
}

// The PR as one read: { authors: [login] | [], headSha, headRepo, baseRepo, defaultBranch }. headSha is null when GitHub gave no valid
// head sha; headRepo is null when the head repository is unknown (a deleted fork); defaultBranch is the base repository's default branch.
export async function prInfo(api, repo, pr) {
  const data = await api(`repos/${repo}/pulls/${pr}`);
  const login = data?.user?.login;
  const sha = data?.head?.sha;
  const text = (v) => (typeof v === 'string' && v ? v : null);
  return {
    authors: typeof login === 'string' && login ? [login.toLowerCase()] : [],
    headSha: typeof sha === 'string' && GIT_SHA_RE.test(sha) ? sha.toLowerCase() : null,
    headRepo: text(data?.head?.repo?.full_name),
    baseRepo: text(data?.base?.repo?.full_name),
    defaultBranch: text(data?.base?.repo?.default_branch),
    number: Number.isInteger(data?.number) ? data.number : null,
    baseRef: text(data?.base?.ref),
    changedFiles: Number.isInteger(data?.changed_files) ? data.changed_files : null,
  };
}

// Message for a PR that does not come from a branch of the base repository (a fork, or a head repository that is null), else null.
// The channel only applies to PRs inside the repository: a fork's commits and its author are outside what the pin and the file check cover.
export function forkRefusal(info, repo) {
  const base = info.baseRepo ?? repo;
  if (typeof info.headRepo === 'string' && info.headRepo.toLowerCase() === String(base).toLowerCase()) return null;
  return 'the PR comes from a fork (or its head repository is unknown); the channel only works on PRs from a branch of the same repository';
}

// Message for a PR whose changed files (against the default branch, at the head read in `info`) include agent or automation config
// (null when none), or when the list is too long to check.
export async function agentConfigRefusal(api, repo, info) {
  if (!info.defaultBranch) throw new Error('could not read the default branch of the repository');
  const { names, truncated } = await listCompareFiles(api, repo, info.defaultBranch, info.headSha, info);
  const hits = names.filter(isAgentConfigPath);
  if (hits.length) return `the PR touches agent or automation config (${stripHidden(hits.slice(0, 3).join(', '))}); the channel can never approve such a PR`;
  if (truncated) return 'the PR has too many files to check for agent or automation config; the channel refuses';
  return null;
}

// ---- commands ----------------------------------------------------------------------------------------------------

export async function ask(opts, { api = ghApi, now = Date.now } = {}) {
  const body = buildAskBody({ id: opts.id, text: opts.text, askedAt: new Date(now()).toISOString() });
  const info = await prInfo(api, opts.repo, opts.pr);
  const fork = forkRefusal(info, opts.repo);
  if (fork) throw new Error(fork);
  const existing = await listComments(api, opts.repo, opts.pr);
  // Only asks from allowed authors (the same rule wait uses) block an id: a stranger's comment cannot burn an id.
  const authors = opts.askAuthors ?? info.authors;
  if (listAsks(existing, { authors }).some((a) => a.id === opts.id)) throw new Error(`id "${opts.id}" was already asked on this PR; use a new id`);
  const posted = await api(`repos/${opts.repo}/issues/${opts.pr}/comments`, { body });
  return { status: 'asked', id: opts.id, comment_url: posted?.html_url ?? null };
}

const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function wait(opts, publicKey, { api = ghApi, now = Date.now, sleep = realSleep } = {}) {
  const deadline = now() + opts.timeoutMin * 60000;
  let authors = opts.askAuthors ?? null;
  let errors = 0;
  for (;;) {
    try {
      const comments = await listComments(api, opts.repo, opts.pr);
      const info = await prInfo(api, opts.repo, opts.pr);
      if (!info.headSha) throw new Error('GitHub gave no PR head sha');
      const fork = forkRefusal(info, opts.repo);
      if (fork) return { status: 'error', id: opts.id, message: fork };
      authors ??= info.authors;
      const refusal = await agentConfigRefusal(api, opts.repo, info);
      if (refusal) return { status: 'refused_agent_config', id: opts.id, message: refusal.slice(0, 300) };
      const askEntry = listAsks(comments, { authors }).find((a) => a.id === opts.id);
      if (!askEntry) throw new Error(`ask "${opts.id}" not found on the PR (from an allowed author)`);
      errors = 0;
      if (askEntry.edited) return { status: 'error', id: opts.id, message: 'the ask comment was edited; no answer to it can be trusted' };
      const hit = findVerifiedAnswer(comments, askEntry, { repo: opts.repo, pr: opts.pr, nowMs: now(), publicKey, headSha: info.headSha });
      if (hit) return { status: 'answered', id: opts.id, authority: hit.authority, answer: hit.answer };
    } catch (err) {
      errors += 1;
      if (errors >= ERROR_TICKS) return { status: 'error', id: opts.id, message: String(err.message).slice(0, 200) };
    }
    const left = deadline - now();
    if (left <= 0) return { status: 'timeout', id: opts.id };
    await sleep(Math.min(opts.intervalSec * 1000, left));
  }
}

const FLAGS = { ask: ['repo', 'pr', 'id', 'text'], wait: ['repo', 'pr', 'id', 'timeout-min', 'interval-sec', 'ask-authors'] };

export const USAGE = [
  'usage: channel.mjs ask|wait --repo owner/name --pr N --id <id> ...',
  '  ask  --repo owner/name --pr N --id <id> --text "<question>"        post a question on the PR (id: [a-z0-9-], 4 to 40 characters)',
  '  wait --repo owner/name --pr N --id <id> [--timeout-min 360] [--interval-sec 60] [--ask-authors login,login]',
  '       poll the PR until a signed answer arrives; prints one JSON line',
  '       exit 0 answered, 3 timeout, 2 error, 4 refused_agent_config, 1 bad arguments',
  'The key is read from channel-public.pem and channel.json (its pin) next to this script.',
].join('\n');

export function parseArgs(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (!FLAGS[command]) throw new Error('usage: channel.mjs ask|wait --repo owner/name --pr N --id <id> ...');
  const raw = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined) throw new Error(`bad argument near "${rest[i] ?? ''}"`);
    const key = rest[i].slice(2);
    if (!FLAGS[command].includes(key)) throw new Error(`unknown option --${key}`);
    raw[key] = rest[i + 1];
  }
  if (!REPO_RE.test(raw.repo ?? '')) throw new Error('--repo must look like owner/name');
  if (!/^[1-9]\d{0,8}$/.test(raw.pr ?? '')) throw new Error('--pr must be a PR number');
  if (!ID_RE.test(raw.id ?? '')) throw new Error('--id must match [a-z0-9-]{4,40}');
  const out = { command, repo: raw.repo, pr: Number(raw.pr), id: raw.id };
  if (command === 'ask') {
    if (!raw.text?.trim()) throw new Error('--text is required');
    out.text = raw.text;
    out.askAuthors = askAuthorsFromEnv(env); // only for the duplicate-id check: the same allowed askers wait uses
  } else {
    const timeoutMin = raw['timeout-min'] === undefined ? 360 : Number(raw['timeout-min']);
    const intervalSec = raw['interval-sec'] === undefined ? 60 : Number(raw['interval-sec']);
    if (!(timeoutMin >= 1 && timeoutMin <= 1440)) throw new Error('--timeout-min must be 1 to 1440');
    if (!(intervalSec >= 5 && intervalSec <= 600)) throw new Error('--interval-sec must be 5 to 600');
    Object.assign(out, { timeoutMin, intervalSec, askAuthors: raw['ask-authors'] === undefined ? askAuthorsFromEnv(env) : parseAuthorList(raw['ask-authors']) });
  }
  return out;
}

const EXIT = { answered: 0, timeout: 3, error: 2, refused_agent_config: 4 };

// The command line: argv is ['ask'|'wait', ...flags]. Prints JSON lines through `out` and returns the exit code.
// deps: env, out, loadKey (returns the trusted public key; default reads the files next to this script), api, now, sleep.
export async function run(argv, { env = process.env, out = (line) => console.log(line), loadKey = () => loadTrustedKey(), api = ghApi, now = Date.now, sleep = realSleep } = {}) {
  // Help only as the first argument or right after the verb, so a question text of "--help" is never mistaken for it.
  if (argv.length === 0 || ['--help', '-h', 'help'].includes(argv[0]) || ['--help', '-h'].includes(argv[1])) {
    out(USAGE);
    return argv.length === 0 ? 1 : 0;
  }
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (err) {
    out(JSON.stringify({ status: 'usage', message: err.message }));
    return 1;
  }
  try {
    if (opts.command === 'ask') {
      out(JSON.stringify(await ask(opts, { api, now })));
      return 0;
    }
    const result = await wait(opts, loadKey(), { api, now, sleep });
    out(JSON.stringify(result));
    return EXIT[result.status];
  } catch (err) {
    out(JSON.stringify({ status: 'error', id: opts.id, message: String(err.message).slice(0, 200) }));
    return 2;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = await run(process.argv.slice(2));
