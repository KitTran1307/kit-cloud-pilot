// Compatibility with the protocol as it already runs in repositories (the previous script) and with the hub's read side.
//   - A fixture signed by the previous implementation (throwaway key; tests/fixtures/legacy-signed.json) must verify with the
//     new cloud script, and the new code must produce the very same payload bytes for the same inputs, so answers signed by
//     the new `answer` verify under the previous script too (same bytes, same Ed25519 signature).
//   - hub/lib/asks.mjs (the hub's copy of the read side) must treat answers signed by the new `answer` as answered, and parse
//     the new asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as channel from '../cloud/channel.mjs';
import * as hub from '../../hub/lib/asks.mjs';
import { answer } from '../answer.mjs';
import {
  T0, MIN, HOUR, REPO, PR, ID, HEAD, QUESTION, KEYS, FIXTURES, iso, tmpDir, comment, askC, answerC, fakeGithub, publicPem, walk,
} from './helpers.mjs';

const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'legacy-signed.json'), 'utf8'));
const fixtureKey = crypto.createPublicKey(fixture.public_key_pem);
const fixtureCtx = (over = {}) => ({ repo: fixture.repo, pr: fixture.pr, nowMs: Date.parse(fixture.now), publicKey: fixtureKey, headSha: fixture.head_sha, ...over });
const fixtureComments = () => [fixture.ask_comment, fixture.answer_comment];
const fixtureAsk = () => channel.listAsks([fixture.ask_comment])[0];
const LEGACY_LABEL = 'CH\u{1EDC} B\u{1EA0}N';

// ---- the fixture signed by the previous implementation ----

test('the fixture is what it claims: throwaway public key, a legacy-labelled ask and a legacy-displayed answer', () => {
  assert.equal(fixtureKey.asymmetricKeyType, 'ed25519');
  assert.equal(fixture.public_key_pem.includes('PRIVATE'), false);
  assert.ok(fixture.ask_comment.body.includes(`${LEGACY_LABEL} (${fixture.id}): `), 'the ask uses the legacy label');
  assert.ok(fixture.answer_comment.body.includes('KIT-CHANNEL ANSWER (deploy-ok).'), 'the answer carries the legacy display label');
  assert.ok(fixture.question.includes('\u{EF}'), 'the question has a non-ASCII letter, so the UTF-8 hash is exercised');
});

test('the NEW cloud script verifies an answer signed by the previous implementation', () => {
  const hit = channel.findVerifiedAnswer(fixtureComments(), fixtureAsk(), fixtureCtx());
  assert.equal(hit.answer, fixture.answer_text);
  assert.equal(hit.authority, 'local-session');
  assert.equal(hit.commentId, fixture.answer_comment.id);
  assert.equal(hit.issuedAt, fixture.issued_at);
});

test('the NEW parser reads the legacy ask to the same id, text and hash', () => {
  const ask = fixtureAsk();
  assert.equal(ask.id, fixture.id);
  assert.equal(ask.text, fixture.question);
  assert.equal(ask.questionSha256, crypto.createHash('sha256').update(fixture.question, 'utf8').digest('hex'));
  assert.equal(ask.questionSha256, fixture.payload.question_sha256, 'the previous signer hashed the same text');
  assert.equal(ask.commentId, fixture.payload.ask_comment_id);
});

test('the wire format is unchanged: the new payload builder gives the very same JSON bytes as the previous one', () => {
  const p = fixture.payload;
  const rebuilt = channel.buildAnswerPayload({
    repo: p.repo, pr: p.pr, id: p.id, askCommentId: p.ask_comment_id, questionSha256: p.question_sha256, headSha: p.head_sha, answer: p.answer,
    issuedAt: p.issued_at, validHours: fixture.valid_hours,
  });
  assert.equal(JSON.stringify(rebuilt), JSON.stringify(p));
  assert.equal(JSON.stringify(rebuilt), Buffer.from(fixture.payload_b64, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(rebuilt), ['v', 'repo', 'pr', 'id', 'ask_comment_id', 'question_sha256', 'head_sha', 'answer', 'authority', 'issued_at', 'expires_at']);
  assert.equal(rebuilt.v, 3);
  assert.equal(rebuilt.authority, 'local-session');
});

test('the previous signature is valid over the bytes the new code produces, so a new signature over them is the same signature', () => {
  const bytes = Buffer.from(fixture.payload_b64, 'base64url');
  assert.equal(crypto.verify(null, bytes, fixtureKey, Buffer.from(fixture.signature_b64, 'base64url')), true);
  // The new signing function wraps exactly this operation; Ed25519 is deterministic, so for any key the output format is fixed.
  const k = crypto.generateKeyPairSync('ed25519');
  const signed = channel.signAnswer(k.privateKey, fixture.payload);
  const [b64, sig] = signed.split('.');
  assert.equal(b64, fixture.payload_b64);
  assert.equal(sig, crypto.sign(null, bytes, k.privateKey).toString('base64url'));
  assert.equal(crypto.verify(null, bytes, k.publicKey, Buffer.from(sig, 'base64url')), true);
});

test('the new ask body differs from the legacy one only in the label word', () => {
  const meta = JSON.parse(/<!-- kit-channel:ask (\{.*?\}) -->/.exec(fixture.ask_comment.body)[1]);
  const made = channel.buildAskBody({ id: meta.id, text: fixture.question, askedAt: meta.asked_at });
  assert.equal(made.replace('WAITING FOR YOU', LEGACY_LABEL), fixture.ask_comment.body);
});

test('the legacy display label is never parsed: replacing it with the new label, or anything, still verifies', () => {
  const marker = fixture.answer_comment.body.slice(0, fixture.answer_comment.body.indexOf('-->') + 3);
  for (const visible of ['CLOUD-PILOT ANSWER (deploy-ok). Display only', 'KIT-CHANNEL ANSWER (deploy-ok).', '']) {
    const swapped = { ...fixture.answer_comment, body: `${marker}\n${visible}` };
    const hit = channel.findVerifiedAnswer([fixture.ask_comment, swapped], fixtureAsk(), fixtureCtx());
    assert.equal(hit.answer, fixture.answer_text, JSON.stringify(visible));
  }
});

test('the fixture still fails closed on every binding: other key, head, repo, PR, expiry, edited ask', () => {
  const run = (ctx, comments = fixtureComments()) => channel.findVerifiedAnswer(comments, channel.listAsks([comments[0]])[0], ctx);
  assert.ok(run(fixtureCtx()));
  assert.equal(run(fixtureCtx({ publicKey: KEYS.publicKey })), null, 'another key');
  assert.equal(run(fixtureCtx({ headSha: 'b2'.repeat(20) })), null, 'a moved PR head');
  assert.equal(run(fixtureCtx({ repo: 'acme/other' })), null, 'another repo');
  assert.equal(run(fixtureCtx({ pr: fixture.pr + 1 })), null, 'another PR');
  assert.equal(run(fixtureCtx({ nowMs: Date.parse(fixture.issued_at) + (fixture.valid_hours + 1) * HOUR })), null, 'expired');
  const edited = { ...fixture.ask_comment, updated_at: iso(Date.parse(fixture.ask_comment.created_at) + MIN) };
  assert.equal(run(fixtureCtx(), [edited, fixture.answer_comment]), null, 'an edited ask');
});

test('the hub treats the legacy-signed answer as answered, and the ask as pending without it', () => {
  const ctx = fixtureCtx();
  assert.deepEqual(hub.pendingQuestions(fixtureComments(), ctx), []);
  assert.equal(hub.pendingQuestions([fixture.ask_comment], ctx).length, 1);
  assert.equal(hub.findVerifiedAnswer(fixtureComments(), hub.listAsks([fixture.ask_comment])[0], ctx).answer, fixture.answer_text);
});

// ---- the NEW answer.mjs signing code, read by the hub ----

// Answers `question` with the new answer() against a fake GitHub holding `askComment`; returns the posted comment and the comment list.
async function newAnswerTo(askComment, question, key = KEYS.privateKey) {
  const gh = fakeGithub([askComment]);
  await answer(
    { repo: REPO, pr: PR, id: ID, answer: 'yes, deploy', questionSha256: channel.questionSha256(question), validHours: 24, dryRun: false, askAuthors: null },
    { api: gh.api, privateKey: key, now: () => T0 + 2 * MIN },
  );
  const posted = { ...gh.comments[1], created_at: iso(T0 + 2 * MIN), updated_at: iso(T0 + 2 * MIN) };
  return { posted, comments: [askComment, posted], body: gh.posts[0].body.body };
}
const hubCtx = (over = {}) => ({ repo: REPO, pr: PR, nowMs: T0 + 5 * MIN, publicKey: KEYS.publicKey, headSha: HEAD, ...over });

test('hub pendingQuestions treats an answer signed by the new answer.mjs as answered, for an ask with the English label', async () => {
  const ask = askC(100, T0);
  assert.ok(ask.body.includes('WAITING FOR YOU (deploy-ok): '));
  const { comments } = await newAnswerTo(ask, QUESTION);
  assert.deepEqual(hub.pendingQuestions(comments, hubCtx()), []);
  assert.equal(hub.pendingQuestions([ask], hubCtx()).length, 1, 'pending without the answer');
  assert.equal(hub.findVerifiedAnswer(comments, hub.listAsks([ask])[0], hubCtx()).answer, 'yes, deploy');
});

test('hub pendingQuestions treats an answer signed by the new answer.mjs as answered, for an ask with the legacy label', async () => {
  const ask = comment(100, T0, `<!-- kit-channel:ask {"v":1,"id":"${ID}","asked_at":"${iso(T0)}"} -->\n${LEGACY_LABEL} (${ID}): ${QUESTION}`);
  const { comments } = await newAnswerTo(ask, QUESTION);
  assert.deepEqual(hub.pendingQuestions(comments, hubCtx()), []);
});

test('the hub ignores an answer signed by another key; an answer for an earlier PR head still counts as handled', async () => {
  const ask = askC(100, T0);
  const { comments } = await newAnswerTo(ask, QUESTION);
  const stranger = crypto.generateKeyPairSync('ed25519');
  assert.equal(hub.pendingQuestions(comments, hubCtx({ publicKey: stranger.publicKey })).length, 1, 'another key does not answer it');
  assert.deepEqual(hub.pendingQuestions(comments, hubCtx({ headSha: 'b2'.repeat(20) })), [], 'a moved head: handled, though not valid for the cloud');
});

test('hub and channel agree: the same ask parsing, answer verification and agent-config paths', async () => {
  const bodies = [
    `<!-- kit-channel:ask {"v":1,"id":"${ID}","asked_at":"${iso(T0)}"} -->\nWAITING FOR YOU (${ID}): ${QUESTION}`,
    `<!-- kit-channel:ask {"v":1,"id":"${ID}","asked_at":"${iso(T0)}"} -->\n${LEGACY_LABEL} (${ID}): ${QUESTION}`,
    `<!-- kit-channel:ask {"v":1,"id":"${ID}","asked_at":"${iso(T0)}"} -->\nno label, just text`,
    `<!-- kit-channel:ask {"v":1,"id":"${ID}","asked_at":"${iso(T0)}"} -->\nWAITING FOR YOU (other-id): ${QUESTION}`,
    `<!-- kit-channel:ask {"v":1,"id":"${ID}","asked_at":"${iso(T0)}"} -->\nWAITING FOR YOU (${ID}): a\nmulti-line\n${LEGACY_LABEL} (${ID}): inner`,
    '<!-- kit-channel:ask {"v":2,"id":"abcd","asked_at":"2026-11-05T10:00:00Z"} -->', 'plain comment', '',
  ];
  for (const body of bodies) assert.deepEqual(channel.parseAsk(body), hub.parseAsk(body), body);
  for (const p of ['.claude/a', 'CLAUDE.md', 'src/a.ts', '.mcp.json', 'x/.husky/y', 'docs/CLAUDE-notes.md', '.vscode\\tasks.json']) {
    assert.equal(channel.isAgentConfigPath(p), hub.isAgentConfigPath(p), p);
  }
  assert.equal(channel.stripHidden('a\u{202E}b\u{E0041}c'), hub.stripHidden('a\u{202E}b\u{E0041}c'));
  const ask = askC(100, T0);
  const variants = [
    answerC(101, T0 + MIN), answerC(101, T0 + MIN, { over: { repo: 'acme/other' } }), answerC(101, T0 + MIN, { validHours: 1 }),
    answerC(101, T0 + MIN, { headSha: 'b2'.repeat(20) }), answerC(101, T0 + MIN, { over: { v: 2 } }), answerC(101, T0 + MIN, { over: { owner_quote: 'x' } }),
    answerC(101, T0 + MIN, { issuedMs: T0 - HOUR }), answerC(101, T0 + MIN, { key: crypto.generateKeyPairSync('ed25519').privateKey }),
    answerC(101, T0 + MIN, { answer: 'x'.repeat(4001) }), answerC(101, T0 + MIN, { validHours: 24 * 8 }),
  ];
  for (const nowMs of [T0 + 5 * MIN, T0 + 3 * HOUR]) {
    for (const c of variants) {
      const [block] = channel.parseAnswerBlocks(c.body);
      const entry = channel.listAsks([ask])[0];
      const args = [block, entry, { ...hubCtx({ nowMs }), id: ID }];
      assert.deepEqual(hub.verifyBlock(...args), channel.verifyBlock(...args));
    }
  }
});

test('hub and channel share the protocol constants', () => {
  for (const name of ['ID_RE', 'AUTHORITIES', 'PAYLOAD_VERSION', 'SKEW_MS', 'MAX_ANSWER_CHARS', 'MAX_QUESTION_CHARS', 'MAX_VALID_MS', 'PR_FILES_PAGE', 'PR_FILES_PAGES']) {
    assert.deepEqual(channel[name], hub[name], name);
  }
  assert.equal(channel.PAYLOAD_VERSION, 3);
  assert.deepEqual(channel.AUTHORITIES, ['local-session']);
  assert.equal(channel.MAX_VALID_MS, 7 * 24 * HOUR);
  assert.equal(channel.SKEW_MS, 5 * MIN);
});

test('the hub loads the public key file setup ships with the pin setup writes, and refuses a different pin', () => {
  const pem = path.join(tmpDir(), 'channel-public.pem');
  fs.writeFileSync(pem, publicPem());
  const fp = channel.publicKeyFingerprint(KEYS.publicKey);
  assert.equal(hub.loadPublicKey(pem, { fingerprint: fp }).asymmetricKeyType, 'ed25519');
  assert.equal(hub.publicKeyFingerprint(hub.loadPublicKey(pem, { fingerprint: null })), fp);
  assert.throws(() => hub.loadPublicKey(pem, { fingerprint: '0'.repeat(64) }), /fingerprint/);
});

test('the fixtures folder holds only throwaway public data: no private key anywhere', () => {
  for (const file of walk(FIXTURES)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /PRIVATE KEY/, file);
    assert.doesNotMatch(text, /[^\x00-\x7F]/, `${file} is plain ASCII (non-ASCII letters appear as escapes)`);
  }
});
