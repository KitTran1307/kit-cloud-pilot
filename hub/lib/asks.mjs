// Read side of the kit-channel question protocol: a cloud session asks its person a question in a PR comment, and the
// person's local session answers with an Ed25519-signed comment. The hub only reads: it lists asks that have no signed
// answer yet, so the person can be told. Nothing in a comment is ever executed; question text is data.
//
// Ask comment:    <!-- kit-channel:ask {"v":1,"id":"<id>","asked_at":"<ISO>"} -->\nWAITING FOR YOU (<id>): <question>
// Answer comment: <!-- kit-channel:answer <payload base64url>.<signature base64url> -->  (v3 payload, see verifyBlock)
//
// Answers are checked against the public key named by CLOUD_PILOT_ASK_PUBLIC_KEY (a PEM file), optionally pinned by
// its SPKI sha256 in CLOUD_PILOT_ASK_KEY_FINGERPRINT (KIT_HUB_ names too). With no key, no answer verifies, so every ask counts as pending.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { setting } from './config.mjs';

export const ID_RE = /^[a-z0-9-]{4,40}$/;
export const AUTHORITIES = ['local-session'];
export const PAYLOAD_VERSION = 3;
export const SKEW_MS = 5 * 60000; // clock difference tolerated between the cloud VM and the person's machine
export const MAX_ANSWER_CHARS = 4000;
export const MAX_QUESTION_CHARS = 2000;
export const MAX_VALID_MS = 7 * 24 * 3600000;
export const PR_FILES_PAGE = 100;
export const PR_FILES_PAGES = 30; // GitHub lists at most 3000 files of a PR
const MAX_PAYLOAD_BYTES = 24 * 1024;
const AGENT_CONFIG_DIRS = new Set(['.claude', '.agents', '.codex', '.githooks', '.github', '.husky', '.vscode', '.devcontainer', '.cursor']);
const AGENT_CONFIG_FILE_RE = /^(?:(?:claude|agents|claude\.local|gemini)\.md|\.mcp\.json)$/i;
// Bidi controls, zero-width characters, variation selectors, tag characters, fillers, line/paragraph separators and other
// invisible/control characters (kept: newline, tab, CR).
const HIDDEN_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const ASK_RE = /<!--[ \t]*kit-channel:ask[ \t]+(\{[^\n]*?\})[ \t]*-->/;
const ANSWER_RE = /<!--[ \t]*kit-channel:answer[ \t]+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)[ \t]*-->/g;
const GIT_SHA_RE = /^[0-9a-fA-F]{40}$/;
// The label before the question text. The second spelling is the protocol's original (Vietnamese) one, still accepted.
const ASK_LABELS = ['WAITING FOR YOU', 'CHỜ BẠN'];

export function publicKeyFingerprint(key) {
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

/** The Ed25519 key that signs answers, or null when none is configured. Throws on a wrong or mismatching key. */
export function loadPublicKey(file = setting('ASK_PUBLIC_KEY'), { fingerprint = setting('ASK_KEY_FINGERPRINT') } = {}) {
  if (!file) return null;
  const key = crypto.createPublicKey(fs.readFileSync(file));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('public key is not an ed25519 key');
  if (fingerprint && publicKeyFingerprint(key) !== String(fingerprint).toLowerCase()) {
    throw new Error('public key fingerprint does not match the pinned one; refusing to verify');
  }
  return key;
}

const toMs = (iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN);

export const questionSha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

// For display to a person or model only: invisible and bidi characters removed. Never hash or compare this.
export const stripHidden = (text) => String(text).replace(HIDDEN_RE, '');

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

// The first well-formed ask block of a comment body, or null. Never throws.
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

// Every ask in a list of issue comments, oldest first. With `authors` (lowercase logins) only asks written by them
// count. The time base is GitHub's created_at; asked_at inside the body is self-reported and unused.
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

const sameSha = (a, b) => typeof a === 'string' && typeof b === 'string' && GIT_SHA_RE.test(a) && GIT_SHA_RE.test(b) && a.toLowerCase() === b.toLowerCase();

export function parseAnswerBlocks(body) {
  if (typeof body !== 'string') return [];
  return [...body.matchAll(ANSWER_RE)].map((m) => ({ payloadB64: m[1], sigB64: m[2] }));
}

// Checks one block against the key and the exact ask it must answer: { ok:true, answer, ... } or { ok:false, reason }.
// ctx: { repo, pr, id, nowMs, publicKey, headSha, ignoreHead?, ignoreExpiry? }.
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

// Every verified answer to `ask` among later comments, oldest first. An edited ask is never answered.
function* verifiedAnswers(comments, ask, ctx) {
  if (ask.edited) return;
  const sorted = [...(comments ?? [])].filter((c) => Number.isFinite(c?.id)).sort((a, b) => a.id - b.id);
  for (const c of sorted) {
    if (c.id <= ask.commentId) continue;
    const createdMs = toMs(c.created_at);
    if (!Number.isFinite(createdMs) || createdMs < ask.createdMs) continue;
    for (const block of parseAnswerBlocks(c.body)) {
      const res = verifyBlock(block, ask, { ...ctx, id: ask.id });
      if (res.ok) yield { ...res, commentId: c.id };
    }
  }
}

// First verified answer to `ask` among later comments, or null. An edited ask is never answered.
export function findVerifiedAnswer(comments, ask, ctx) {
  for (const answer of verifiedAnswers(comments, ask, ctx)) return answer;
  return null;
}

// Has the ask any properly signed answer, still valid or not (expired, or for an earlier PR head)?
export function hasValidAnswer(comments, ask, ctx) {
  return findVerifiedAnswer(comments, ask, { ...ctx, ignoreHead: true, ignoreExpiry: true }) !== null;
}

// The newest ask (by authors, if given) when it has properly signed answers and none of them is for `headSha`, the PR
// head now: the cloud side accepts an answer only for the head it sees, so the session cannot use these and waits on.
// [{ ...ask, answeredHead }] (answeredHead: the head of the newest answer), else []. Only the newest ask counts: a
// session asks one thing at a time, so an older ask was already read (a session that moved on to a later ask, or to
// more commits, is not waiting for it). An unknown or malformed head never makes an answer stale.
export function staleQuestions(comments, { repo, pr, publicKey, nowMs, headSha, authors }) {
  if (typeof headSha !== 'string' || !GIT_SHA_RE.test(headSha)) return [];
  const newest = listAsks(comments, { authors }).at(-1);
  if (!newest) return [];
  const heads = [...verifiedAnswers(comments, newest, { repo, pr, nowMs, publicKey, ignoreHead: true, ignoreExpiry: true })].map((a) => a.headSha);
  if (!heads.length || heads.some((h) => sameSha(h, headSha))) return [];
  return [{ ...newest, answeredHead: heads.at(-1) }];
}

// Asks with no signed answer at all (optionally only from `authors`, created after `afterMs`, not in `ignoreIds`).
// An edited ask is listed too (it can never be answered): the caller flags it.
export function pendingQuestions(comments, { repo, pr, publicKey, nowMs, afterMs = -Infinity, authors, ignoreIds }) {
  const ignored = new Set(ignoreIds ?? []);
  return listAsks(comments, { authors })
    .filter((ask) => ask.createdMs > afterMs && !ignored.has(ask.commentId))
    .filter((ask) => !hasValidAnswer(comments, ask, { repo, pr, nowMs, publicKey }));
}
