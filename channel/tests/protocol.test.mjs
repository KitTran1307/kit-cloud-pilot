// The wire protocol: ask and answer comments, payload v3, verification, parsing, key pinning, agent-config paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildAskBody, parseAsk, listAsks, buildAnswerPayload, buildAnswerBody, parseAnswerBlocks, verifyBlock,
  hasValidAnswer, pendingQuestions, loadPublicKey, loadTrustedKey, readPin, SKEW_MS, questionSha256, stripHidden, isAgentConfigPath,
  listCompareFiles, publicKeyFingerprint, ASK_LABEL, LEGACY_ASK_LABEL, run, prInfo, forkRefusal,
} from '../cloud/channel.mjs';
import {
  T0, MIN, HOUR, REPO, PR, ID, ASK_ID, HEAD, QUESTION, KEYS, iso, tmpDir, comment, askC, fields, answerC, rawAnswerC, ctx, verified,
  capture, publicPem,
} from './helpers.mjs';

// ---- sign / verify ----

test('sign/verify round trip: a signed answer for this repo, PR, ask comment and question is accepted, with its authority', () => {
  const comments = [askC(), answerC(101, T0 + 2 * MIN)];
  const hit = verified(comments);
  assert.equal(hit.answer, 'yes, deploy');
  assert.equal(hit.authority, 'local-session');
  assert.equal(hit.ownerQuote, undefined);
  assert.equal(hit.commentId, 101);
});

test('the owner-chat authority is gone: no builder and no verifier accepts it', () => {
  assert.throws(() => buildAnswerPayload({ ...fields({ authority: 'owner-chat', ownerQuote: 'ok, deploy it now' }), issuedAt: iso(T0), validHours: 1 }), /authority/);
  const base = buildAnswerPayload({ ...fields(), issuedAt: iso(T0 + MIN), validHours: 24 });
  assert.equal(verified([askC(), rawAnswerC(101, T0 + MIN, { ...base, authority: 'owner-chat', owner_quote: 'ok, deploy it now' })]), null);
  assert.equal(verified([askC(), rawAnswerC(101, T0 + MIN, { ...base, authority: 'owner-chat' })]), null);
});

test('payload v3 carries the binding, the PR head and the fixed local-session authority', () => {
  const p = buildAnswerPayload({ ...fields(), issuedAt: iso(T0), validHours: 2 });
  assert.deepEqual(Object.keys(p), ['v', 'repo', 'pr', 'id', 'ask_comment_id', 'question_sha256', 'head_sha', 'answer', 'authority', 'issued_at', 'expires_at']);
  assert.equal(p.v, 3);
  assert.equal(p.authority, 'local-session');
  assert.equal(p.head_sha, HEAD);
  assert.equal(p.ask_comment_id, ASK_ID);
  assert.equal(p.question_sha256, crypto.createHash('sha256').update(QUESTION, 'utf8').digest('hex'));
  assert.equal(p.expires_at, iso(T0 + 2 * HOUR));
  assert.equal(buildAnswerPayload({ ...fields({ authority: 'local-session' }), issuedAt: iso(T0), validHours: 2 }).authority, 'local-session');
});

test('buildAnswerPayload refuses any other authority, an owner quote, a bad hash and a bad head sha', () => {
  const build = (over) => buildAnswerPayload({ ...fields(over), issuedAt: iso(T0), validHours: 1 });
  assert.throws(() => build({ authority: 'owner-local-session' }), /authority/);
  assert.throws(() => build({ authority: 'owner-chat' }), /authority/);
  assert.throws(() => build({ ownerQuote: 'I said so' }), /owner quote/);
  assert.throws(() => build({ questionSha256: 'abc' }), /question/);
  assert.throws(() => build({ askCommentId: 0 }), /ask comment/);
  for (const headSha of [undefined, 'abc', 'z'.repeat(40), HEAD.toUpperCase(), `${HEAD}0`]) assert.throws(() => build({ headSha }), /head/, String(headSha));
});

test('a tampered payload is rejected (signature no longer matches)', () => {
  const [good] = parseAnswerBlocks(answerC(101, T0 + MIN).body);
  const payload = JSON.parse(Buffer.from(good.payloadB64, 'base64url').toString());
  const forged = Buffer.from(JSON.stringify({ ...payload, head_sha: 'b2'.repeat(20) })).toString('base64url');
  const body = `<!-- kit-channel:answer ${forged}.${good.sigB64} -->`;
  assert.equal(verified([askC(), comment(101, T0 + MIN, body)]), null);
});

test('an answer signed by another key is rejected', () => {
  const stranger = crypto.generateKeyPairSync('ed25519');
  assert.equal(verified([askC(), answerC(101, T0 + MIN, { key: stranger.privateKey })]), null);
  assert.equal(verified([askC(), answerC(101, T0 + MIN)], T0 + 10 * MIN, stranger.publicKey), null);
});

test('only an Ed25519 public key can verify: an EC or RSA key is refused outright', () => {
  const comments = [askC(), answerC(101, T0 + MIN)];
  for (const type of ['ec', 'rsa']) {
    const other = type === 'ec' ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }) : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const [block] = parseAnswerBlocks(comments[1].body);
    const res = verifyBlock(block, listAsks(comments)[0], { ...ctx(), id: ID, publicKey: other.publicKey });
    assert.deepEqual(res, { ok: false, reason: 'key type' }, type);
  }
});

test('an expired answer is rejected', () => {
  const comments = [askC(), answerC(101, T0 + MIN, { validHours: 1 })];
  assert.ok(verified(comments, T0 + 59 * MIN));
  assert.equal(verified(comments, T0 + 61 * MIN), null);
});

test('N3: hasValidAnswer counts any properly signed answer bound to the ask, expired or issued for another head; not forged or edited ones', () => {
  const asks = (c) => listAsks(c)[0];
  const has = (c, over = {}) => hasValidAnswer(c, asks(c), { repo: REPO, pr: PR, nowMs: T0 + 999 * HOUR, publicKey: KEYS.publicKey, ...over });
  assert.equal(has([askC(), answerC(101, T0 + MIN, { validHours: 1 })]), true, 'expired');
  assert.equal(has([askC(), answerC(101, T0 + MIN, { headSha: 'b2'.repeat(20) })]), true, 'other head');
  assert.equal(has([askC(), answerC(101, T0 + MIN)], { headSha: 'c3'.repeat(20) }), true, 'a head in ctx is ignored');
  assert.equal(has([askC()]), false);
  assert.equal(has([askC(), answerC(101, T0 + MIN, { key: crypto.generateKeyPairSync('ed25519').privateKey })]), false, 'forged');
  assert.equal(has([askC(), answerC(101, T0 + MIN, { askCommentId: 55 })]), false, 'other ask');
  assert.equal(has([askC(), answerC(101, T0 + MIN, { over: { v: 2 } })]), false, 'old version');
  assert.equal(has([askC(), answerC(101, T0 + MIN, { over: { authority: 'owner-chat' } })]), false);
  assert.equal(has([askC(ASK_ID, T0, ID, QUESTION, { updatedMs: T0 + MIN }), answerC(101, T0 + 2 * MIN)]), false, 'edited ask');
  assert.equal(has([answerC(99, T0 - MIN, { issuedMs: T0 + MIN }), askC(100, T0)]), false, 'before the ask');
});

test('wrong repo, PR, id, version, authority or answer are rejected', () => {
  const cases = [
    { repo: 'acme/other' }, { pr: 8 }, { id: 'another-id' }, { v: 1 }, { v: 2 }, { v: 4 }, { answer: '' }, { answer: 7 },
    { authority: 'owner-local-session' }, { authority: 'owner' }, { authority: 'owner-chat' }, { authority: undefined },
  ];
  for (const over of cases) {
    assert.equal(verified([askC(), answerC(101, T0 + MIN, { over })]), null, JSON.stringify(over));
  }
  assert.ok(verified([askC(), answerC(101, T0 + MIN, { over: { repo: 'ACME/APP' } })]), 'repo compares case-insensitively like GitHub');
});

test('a v1 answer signed under the old format (no authority, no binding) is rejected', () => {
  const old = { v: 1, repo: REPO, pr: PR, id: ID, answer: 'yes', decided_by: 'owner-local-session', issued_at: iso(T0 + MIN), expires_at: iso(T0 + 25 * HOUR) };
  assert.equal(verified([askC(), rawAnswerC(101, T0 + MIN, old)]), null);
});

test('a v2 answer (the old format with owner-chat) is rejected even with a good signature', () => {
  const v2 = { v: 2, repo: REPO, pr: PR, id: ID, ask_comment_id: ASK_ID, question_sha256: questionSha256(QUESTION), answer: 'yes', authority: 'local-session', issued_at: iso(T0 + MIN), expires_at: iso(T0 + 25 * HOUR) };
  assert.equal(verified([askC(), rawAnswerC(101, T0 + MIN, v2)]), null);
  assert.equal(verified([askC(), rawAnswerC(101, T0 + MIN, { ...v2, authority: 'owner-chat', owner_quote: 'ok' })]), null);
});

test('N6: an answer is bound to the PR head: another sha, a missing sha or no known head all fail closed', () => {
  const comments = [askC(), answerC(101, T0 + MIN)];
  assert.ok(verified(comments));
  const [block] = parseAnswerBlocks(comments[1].body);
  const check = (headSha) => verifyBlock(block, listAsks(comments)[0], { ...ctx(), id: ID, headSha });
  assert.equal(check(HEAD).ok, true);
  assert.deepEqual(check('b2'.repeat(20)), { ok: false, reason: 'head' });
  assert.deepEqual(check(undefined), { ok: false, reason: 'head' });
  assert.deepEqual(check(''), { ok: false, reason: 'head' });
  assert.equal(check(HEAD.toUpperCase()).ok, true, 'sha compares case-insensitively');
  assert.equal(verified([askC(), answerC(101, T0 + MIN, { over: { head_sha: undefined } })]), null, 'payload without head_sha');
  assert.equal(verified([askC(), answerC(101, T0 + MIN, { over: { head_sha: 'main' } })]), null, 'not a sha');
});

test('H2: an answer for another ask comment or another question text is rejected', () => {
  assert.equal(verified([askC(), answerC(101, T0 + MIN, { askCommentId: 99 })]), null, 'other ask comment id');
  assert.equal(verified([askC(), answerC(101, T0 + MIN, { questionSha256: questionSha256('Delete the database?') })]), null, 'other question text');
  const edited = askC(ASK_ID, T0, ID, 'Deploy now? (also wipe prod)');
  assert.equal(verified([edited, answerC(101, T0 + MIN)]), null, 'answer signed for different text than the ask holds');
  assert.equal(verified([askC(), answerC(101, T0 + MIN, { over: { ask_comment_id: String(ASK_ID) } })]), null, 'id must be a number');
});

test('a local-session payload carrying an owner_quote is rejected by the verifier', () => {
  const base = { ...buildAnswerPayload({ ...fields(), issuedAt: iso(T0 + MIN), validHours: 24 }) };
  assert.ok(verified([askC(), rawAnswerC(101, T0 + MIN, base)]));
  assert.equal(verified([askC(), rawAnswerC(101, T0 + MIN, { ...base, owner_quote: 'sneaky' })]), null);
  assert.equal(verified([askC(), rawAnswerC(101, T0 + MIN, { ...base, owner_quote: '' })]), null);
});

test('an answer issued before the ask (beyond 5 min skew) is rejected; within the skew it is accepted', () => {
  assert.equal(SKEW_MS, 5 * MIN);
  assert.equal(verified([askC(), answerC(101, T0 + MIN, { issuedMs: T0 - 6 * MIN })]), null);
  assert.ok(verified([askC(), answerC(101, T0 + MIN, { issuedMs: T0 - SKEW_MS + 1000 })]));
});

test('M1: the ask comment created_at is the time base, not the self-reported asked_at', () => {
  // The ask body claims it was asked 10 hours earlier; GitHub says it was created at T0.
  const backdated = comment(ASK_ID, T0, buildAskBody({ id: ID, text: QUESTION, askedAt: iso(T0 - 10 * HOUR) }));
  assert.equal(verified([backdated, answerC(101, T0 + MIN, { issuedMs: T0 - HOUR })]), null);
  assert.ok(verified([backdated, answerC(101, T0 + MIN, { issuedMs: T0 - MIN })]));
});

test('an answer issued far in the future is rejected', () => {
  assert.equal(verified([askC(), answerC(101, T0 + MIN, { issuedMs: T0 + 60 * MIN })]), null);
});

test('a validity window over 7 days is rejected', () => {
  assert.equal(verified([askC(), answerC(101, T0 + MIN, { validHours: 24 * 8 })]), null);
  assert.ok(verified([askC(), answerC(101, T0 + MIN, { validHours: 24 * 7 })]), 'exactly 7 days is still fine');
});

test('a valid signed comment posted BEFORE the ask comment does not count (replay of an old answer)', () => {
  const comments = [answerC(99, T0 - MIN, { issuedMs: T0 + MIN }), askC(100, T0)];
  assert.equal(verified(comments), null);
});

test('a comment with a lower id but a later timestamp, or the reverse, does not count', () => {
  assert.equal(verified([askC(100, T0), answerC(99, T0 + MIN, { issuedMs: T0 + MIN })]), null);
  assert.equal(verified([askC(100, T0), answerC(101, T0 - MIN, { issuedMs: T0 + MIN })]), null);
});

test('the first valid answer wins, and invalid blocks around it are ignored', () => {
  const stranger = crypto.generateKeyPairSync('ed25519');
  const comments = [
    askC(), answerC(101, T0 + MIN, { key: stranger.privateKey }),
    answerC(102, T0 + 2 * MIN, { answer: 'first' }), answerC(103, T0 + 3 * MIN, { answer: 'second' }),
  ];
  assert.equal(verified(comments).answer, 'first');
});

// ---- parsing ----

test('parsing ignores malformed ask and answer blocks and never throws', () => {
  const junk = [
    '<!-- kit-channel:ask {not json} -->', '<!-- kit-channel:ask {"v":2,"id":"abcd","asked_at":"2026-11-05T10:00:00Z"} -->',
    '<!-- kit-channel:ask {"v":1,"id":"BAD ID","asked_at":"2026-11-05T10:00:00Z"} -->', '<!-- kit-channel:ask {"v":1,"id":"abcd","asked_at":"nope"} -->',
    '<!-- kit-channel:ask -->', `${LEGACY_ASK_LABEL} (abcd): no block`, `${ASK_LABEL} (abcd): no block`, null, undefined, 42, '',
  ];
  for (const body of junk) assert.equal(parseAsk(body), null, String(body));
  for (const body of ['<!-- kit-channel:answer nodot -->', '<!-- kit-channel:answer a.b.c -->', '<!-- kit-channel:answer !!!.??? -->', null, undefined, 3]) {
    assert.deepEqual(parseAnswerBlocks(body), [], String(body));
  }
  const garbage = { payloadB64: '%%%', sigB64: '%%%' };
  const askEntry = { commentId: ASK_ID, createdMs: T0, questionSha256: questionSha256(QUESTION) };
  assert.equal(verifyBlock(garbage, askEntry, { ...ctx(), id: ID }).ok, false);
  assert.equal(verifyBlock({ payloadB64: 'e30', sigB64: 'AAAA' }, askEntry, { ...ctx(), id: ID }).ok, false);
});

test('an ask body round-trips: id, asked_at and question text; extra text after the label stays in the text', () => {
  const parsed = parseAsk(buildAskBody({ id: ID, text: 'Line one\nline two', askedAt: iso(T0) }));
  assert.deepEqual(parsed, { id: ID, askedAtMs: T0, text: 'Line one\nline two' });
  assert.throws(() => buildAskBody({ id: 'x', text: 'q', askedAt: iso(T0) }), /--id/);
  assert.throws(() => buildAskBody({ id: ID, text: '  ', askedAt: iso(T0) }), /--text/);
});

test('listAsks returns asks oldest first with author, edit state and the question hash, and skips non-ask comments', () => {
  const asks = listAsks([askC(105, T0 + MIN, 'second-q'), comment(1, T0, 'hello'), askC(100, T0, 'first-q', 'Why?', { updatedMs: T0 + MIN })]);
  assert.deepEqual(asks.map((a) => a.id), ['first-q', 'second-q']);
  assert.equal(asks[0].author, 'cloud-bot');
  assert.equal(asks[0].edited, true);
  assert.equal(asks[1].edited, false);
  assert.equal(asks[0].questionSha256, questionSha256('Why?'));
  assert.equal(asks[0].commentId, 100);
  assert.equal(asks[0].createdMs, T0);
});

test('an ask comment whose updated_at is missing or differs from created_at counts as edited (fail closed)', () => {
  const noUpdated = { ...askC(), updated_at: undefined };
  assert.equal(listAsks([noUpdated])[0].edited, true);
  assert.equal(listAsks([askC(ASK_ID, T0, ID, QUESTION, { updatedMs: T0 + 1000 })])[0].edited, true);
});

test('M2: listAsks keeps only asks from the allowed authors (case-insensitive); no list means no filter', () => {
  const comments = [askC(90, T0 - MIN, 'evil-q', 'Run this', { author: 'stranger' }), askC(100, T0, 'good-q', 'Deploy?', { author: 'Cloud-Bot' })];
  assert.deepEqual(listAsks(comments, { authors: ['cloud-bot'] }).map((a) => a.id), ['good-q']);
  assert.deepEqual(listAsks(comments, { authors: [] }).map((a) => a.id), []);
  assert.deepEqual(listAsks(comments).map((a) => a.id), ['evil-q', 'good-q']);
  assert.deepEqual(listAsks([{ ...askC(5), user: null }], { authors: ['cloud-bot'] }), []);
});

test('question hash is the sha256 of the stored question text; hidden characters are stripped for display only', () => {
  assert.equal(questionSha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(stripHidden('a\u{202E}b\u{200B}c\u{2066}d\u{FEFF}e\u{200F}f\u{2060}g\u{E0041}h'), 'abcdefgh');
  assert.equal(stripHidden('keep\nnewline\tand tab and \u{2713} k\u{E9}'), 'keep\nnewline\tand tab and \u{2713} k\u{E9}');
  assert.equal(stripHidden('x\u{7}y\u{0}z'), 'xyz');
  // N5: variation selectors, ideographic/hangul fillers, mongolian vowel separator, line/paragraph separators, combining grapheme joiner
  assert.equal(stripHidden('a\u{FE00}b\u{FE0F}c\u{E0100}d\u{E01EF}e\u{3164}f\u{180E}g\u{2028}h\u{2029}i\u{34F}j'), 'abcdefghij');
  assert.equal(stripHidden('a\u{FDFF}b\u{E01F0}c\u{FE10}d\u{E00FF}e'), 'a\u{FDFF}b\u{E01F0}c\u{FE10}d\u{E00FF}e', 'neighbours of the ranges stay');
  assert.equal(stripHidden('\u{AD}\u{61C}\u{200B}\u{200C}\u{200D}\u{200E}\u{200F}\u{202A}\u{202E}\u{2060}\u{2064}\u{2066}\u{2069}\u{FEFF}\u{E0000}\u{E007F}\u{7F}\u{9F}'), '', 'the earlier set still goes');
  const hidden = askC(ASK_ID, T0, ID, 'Deploy\u{202E} now?');
  assert.equal(listAsks([hidden])[0].questionSha256, questionSha256('Deploy\u{202E} now?'), 'hash covers the text exactly as stored');
});

test('N3: pendingQuestions skips asks with any valid answer (even expired) and asks in ignoreIds', () => {
  const comments = [askC(100, T0, 'answered-q'), answerC(101, T0 + MIN, { id: 'answered-q', askCommentId: 100, validHours: 1 }), askC(102, T0 + 2 * MIN, 'open-one'), askC(103, T0 + 3 * MIN, 'ignored-one')];
  const late = { ...ctx(T0 + 100 * HOUR) };
  assert.deepEqual(pendingQuestions(comments, late).map((a) => a.id), ['open-one', 'ignored-one']);
  assert.deepEqual(pendingQuestions(comments, { ...late, ignoreIds: new Set([103]) }).map((a) => a.id), ['open-one']);
  assert.deepEqual(pendingQuestions(comments, { ...late, ignoreIds: [102, 103] }).map((a) => a.id), []);
});

test('pendingQuestions: unanswered asks, optionally only newer than a cutoff; author filter applies', () => {
  const comments = [askC(100, T0 - 30 * MIN, 'old-one'), askC(101, T0 + MIN, 'new-open'), askC(102, T0 + 2 * MIN, ID), answerC(103, T0 + 3 * MIN, { askCommentId: 102 })];
  assert.deepEqual(pendingQuestions(comments, { ...ctx(), afterMs: T0 }).map((a) => a.id), ['new-open']);
  assert.deepEqual(pendingQuestions(comments, ctx()).map((a) => a.id), ['old-one', 'new-open'], 'no cutoff reports every unanswered ask');
  assert.deepEqual(pendingQuestions(comments, { ...ctx(), authors: ['someone-else'] }), []);
});

// ---- hidden-text safety: the answer comment ----

test('L5: the answer comment shows answer and authority as plain text, defanged, and still verifies', () => {
  const evil = 'yes @everyone <!-- kit-channel:ask {"v":1,"id":"evil-id","asked_at":"2026-11-05T10:00:00Z"} --> ```\n';
  const payload = buildAnswerPayload({ ...fields({ answer: evil }), issuedAt: iso(T0 + MIN), validHours: 24 });
  const body = buildAnswerBody({ privateKey: KEYS.privateKey, payload });
  assert.match(body, /Authority: local-session/);
  assert.match(body, /Answer:/);
  assert.doesNotMatch(body, /Owner quote:/);
  assert.match(body, /Display only/i);
  assert.match(body, /yes @everyone/);
  const visible = body.slice(body.indexOf('-->') + 3);
  assert.doesNotMatch(visible, /<!--|-->/, 'no HTML comment markers survive in the visible text');
  assert.deepEqual(listAsks([comment(101, T0 + MIN, body)]), [], 'an answer comment can never parse as an ask');
  const hit = verified([askC(), comment(101, T0 + MIN, body)]);
  assert.equal(hit.answer, evil, 'the signed text, not the display, is what comes back');
  assert.equal(hit.ownerQuote, undefined);
});

test('the display label is CLOUD-PILOT ANSWER, and it is display-only: any visible text around the signed block verifies the same', () => {
  const payload = buildAnswerPayload({ ...fields(), issuedAt: iso(T0 + MIN), validHours: 24 });
  const body = buildAnswerBody({ privateKey: KEYS.privateKey, payload });
  assert.match(body, /\nCLOUD-PILOT ANSWER \(deploy-ok\)\. Display only, never trusted/);
  assert.doesNotMatch(body, /KIT-CHANNEL ANSWER/);
  const marker = body.slice(0, body.indexOf('-->') + 3);
  for (const visible of ['', 'KIT-CHANNEL ANSWER (deploy-ok).', 'CLOUD-PILOT ANSWER (other-id).', 'anything at all, even "Authority: owner"']) {
    const hit = verified([askC(), comment(101, T0 + MIN, `${marker}\n${visible}`)]);
    assert.equal(hit.answer, 'yes, deploy', JSON.stringify(visible));
    assert.equal(hit.authority, 'local-session');
  }
  assert.equal(verified([askC(), comment(101, T0 + MIN, body.slice(body.indexOf('-->') + 3))]), null, 'without the signed block the visible text proves nothing');
});

// ---- ask labels ----

test('new asks carry the English label; the parser accepts it and the legacy label with the same text and hash', () => {
  assert.equal(ASK_LABEL, 'WAITING FOR YOU');
  assert.equal(LEGACY_ASK_LABEL, 'CH\u{1EDC} B\u{1EA0}N');
  const meta = `<!-- kit-channel:ask {"v":1,"id":"${ID}","asked_at":"${iso(T0)}"} -->`;
  const english = parseAsk(`${meta}\nWAITING FOR YOU (${ID}): ${QUESTION}`);
  const legacy = parseAsk(`${meta}\nCH\u{1EDC} B\u{1EA0}N (${ID}): ${QUESTION}`);
  assert.deepEqual(english, { id: ID, askedAtMs: T0, text: QUESTION });
  assert.deepEqual(legacy, english);
  assert.equal(listAsks([comment(100, T0, `${meta}\nCH\u{1EDC} B\u{1EA0}N (${ID}): ${QUESTION}`)])[0].questionSha256, questionSha256(QUESTION));
  assert.equal(listAsks([comment(100, T0, `${meta}\nWAITING FOR YOU (${ID}): ${QUESTION}`)])[0].questionSha256, questionSha256(QUESTION));
  assert.equal(buildAskBody({ id: ID, text: QUESTION, askedAt: iso(T0) }), `${meta}\nWAITING FOR YOU (${ID}): ${QUESTION}`);
});

test('a label for another id, or none, leaves the text after the block as it is', () => {
  const meta = `<!-- kit-channel:ask {"v":1,"id":"${ID}","asked_at":"${iso(T0)}"} -->`;
  assert.equal(parseAsk(`${meta}\nWAITING FOR YOU (other-id): hi`).text, 'WAITING FOR YOU (other-id): hi');
  assert.equal(parseAsk(`${meta}\nno label here`).text, 'no label here');
  assert.equal(parseAsk(`${meta}\nWAITING FOR YOU (${ID}):   spaced   `).text, 'spaced');
});

test('an answer to an ask written with either label verifies', () => {
  const legacyAsk = comment(ASK_ID, T0, `<!-- kit-channel:ask {"v":1,"id":"${ID}","asked_at":"${iso(T0)}"} -->\nCH\u{1EDC} B\u{1EA0}N (${ID}): ${QUESTION}`);
  assert.equal(verified([legacyAsk, answerC(101, T0 + MIN)]).answer, 'yes, deploy');
  assert.equal(verified([askC(), answerC(101, T0 + MIN)]).answer, 'yes, deploy');
});

// ---- public key pinning ----

// A folder with channel-public.pem for `key` and, unless `pin` is null, channel.json holding `pin` (default: the key's own fingerprint).
function trustDir(t, { key = KEYS.publicKey, pin = publicKeyFingerprint(key), json } = {}) {
  const dir = tmpDir('cloudpilot-trust-');
  fs.writeFileSync(path.join(dir, 'channel-public.pem'), publicPem(key));
  if (json !== undefined) fs.writeFileSync(path.join(dir, 'channel.json'), json);
  else if (pin !== null) fs.writeFileSync(path.join(dir, 'channel.json'), JSON.stringify({ fingerprint: pin }));
  return dir;
}

test('L2: a pinned key loads; a different pin, a different key or another key type fails closed', (t) => {
  const dir = tmpDir();
  const file = path.join(dir, 'k.pem');
  fs.writeFileSync(file, publicPem());
  const fp = publicKeyFingerprint(KEYS.publicKey);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(loadPublicKey(file).asymmetricKeyType, 'ed25519', 'unpinned unless a pin is given');
  assert.equal(loadPublicKey(file, { fingerprint: fp }).asymmetricKeyType, 'ed25519');
  assert.equal(loadPublicKey(file, { fingerprint: fp.toUpperCase() }).asymmetricKeyType, 'ed25519', 'the pin compares case-insensitively');
  assert.throws(() => loadPublicKey(file, { fingerprint: '0'.repeat(64) }), /fingerprint/);
  const ec = path.join(dir, 'ec.pem');
  fs.writeFileSync(ec, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }));
  assert.throws(() => loadPublicKey(ec), /ed25519/);
});

test('the trusted key is channel-public.pem with the pin from channel.json beside it', (t) => {
  const dir = trustDir(t);
  const key = loadTrustedKey(dir);
  assert.equal(key.asymmetricKeyType, 'ed25519');
  assert.equal(publicKeyFingerprint(key), publicKeyFingerprint(KEYS.publicKey));
  assert.equal(readPin(path.join(dir, 'channel.json')), publicKeyFingerprint(KEYS.publicKey));
});

test('a missing pin fails closed: no channel.json, an unreadable one, or one without a fingerprint', (t) => {
  assert.throws(() => loadTrustedKey(trustDir(t, { pin: null })), /pin.*not found|not found.*pin/i);
  assert.throws(() => loadTrustedKey(trustDir(t, { json: '{not json' })), /not valid JSON/);
  assert.throws(() => loadTrustedKey(trustDir(t, { json: '{}' })), /fingerprint/);
  assert.throws(() => loadTrustedKey(trustDir(t, { json: JSON.stringify({ fingerprint: 'abc' }) })), /fingerprint/);
  assert.throws(() => loadTrustedKey(trustDir(t, { json: JSON.stringify({ fingerprint: 42 }) })), /fingerprint/);
  assert.throws(() => loadTrustedKey(trustDir(t, { json: 'null' })), /fingerprint/);
});

test('a pin that does not match the key fails closed', (t) => {
  const other = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => loadTrustedKey(trustDir(t, { pin: publicKeyFingerprint(other.publicKey) })), /does not match the pinned/);
});

test('a missing channel-public.pem fails closed, even with a pin', (t) => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'channel.json'), JSON.stringify({ fingerprint: publicKeyFingerprint(KEYS.publicKey) }));
  assert.throws(() => loadTrustedKey(dir), /channel-public\.pem not found/);
});

test('the pin must be of an Ed25519 key: an EC key with its own correct pin is still refused', () => {
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'channel-public.pem'), ec.publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(path.join(dir, 'channel.json'), JSON.stringify({ fingerprint: publicKeyFingerprint(ec.publicKey) }));
  assert.throws(() => loadTrustedKey(dir), /ed25519/);
});

test('wait with a missing or wrong pin prints an error and exit code 2 before it asks GitHub anything', async (t) => {
  const argv = ['wait', '--repo', REPO, '--pr', String(PR), '--id', ID];
  const api = async () => { throw new Error('the network must not be touched'); };
  const other = crypto.generateKeyPairSync('ed25519');
  for (const dir of [trustDir(t, { pin: null }), trustDir(t, { pin: publicKeyFingerprint(other.publicKey) })]) {
    const cap = capture();
    const code = await run(argv, { out: cap.out, api, loadKey: () => loadTrustedKey(dir) });
    assert.equal(code, 2);
    const [line] = cap.json();
    assert.equal(line.status, 'error');
    assert.equal(line.id, ID);
    assert.match(line.message, /refusing to verify|does not match/);
  }
});

// ---- agent-config paths ----

test('M3: isAgentConfigPath covers agent and automation config at any depth', () => {
  for (const p of ['.claude/settings.json', '.claude/hooks/x.mjs', '.agents/a.md', '.codex/config.toml', '.githooks/pre-commit', '.github/workflows/ci.yml',
    'CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', 'website/CLAUDE.md', 'a/b/AGENTS.md', 'website/.claude/skills/x/SKILL.md', 'pkg/.github/dependabot.yml', 'claude.md',
    // N4
    '.mcp.json', 'apps/web/.mcp.json', '.MCP.json', '.husky/pre-commit', 'pkg/.husky/_/husky.sh', '.vscode/tasks.json', 'a/.vscode/settings.json',
    '.devcontainer/devcontainer.json', 'x/.devcontainer/Dockerfile', '.cursor/rules/a.mdc', 'web/.cursor/mcp.json', 'GEMINI.md', 'gemini.md', 'a/b/GEMINI.md', '.vscode\\tasks.json']) {
    assert.equal(isAgentConfigPath(p), true, p);
  }
  for (const p of ['src/claude.ts', 'docs/CLAUDE-notes.md', 'README.md', 'src/.claudex/a', 'github/workflows/x.yml', 'agents/a.md', 'a/CLAUDE.md.bak', '',
    'src/mcp.json', '.mcp.json.bak', 'a/.mcp.jsonc', 'husky/pre-commit', 'src/.huskyrc', 'vscode/a.json', '.vscodex/a', 'devcontainer/a', '.cursorrules', 'cursor/a.md', 'GEMINI-notes.md', 'GEMINI.md.bak', 'docs/gemini.txt']) {
    assert.equal(isAgentConfigPath(p), false, p);
  }
  assert.equal(isAgentConfigPath(undefined), false);
});

test('listCompareFiles reads compare page 1 only (GitHub lists files there, at most 300), includes renamed-from names, and refuses a bad response', async () => {
  const rows = Array.from({ length: 230 }, (_, i) => ({ filename: `src/f${i}.ts`, ...(i === 5 ? { previous_filename: '.claude/old.md' } : {}) }));
  const calls = [];
  const api = async (p) => { calls.push(p); return { files: rows }; };
  const r = await listCompareFiles(api, REPO, 'main', HEAD);
  assert.equal(r.truncated, false);
  assert.equal(r.names.length, 231);
  assert.ok(r.names.includes('.claude/old.md'));
  assert.deepEqual(calls, [`repos/${REPO}/compare/main...${HEAD}?per_page=100&page=1`]);
  await assert.rejects(listCompareFiles(async () => ({}), REPO, 'main', HEAD), /unexpected/);
  await assert.rejects(listCompareFiles(async () => null, REPO, 'main', HEAD), /unexpected/);
});

// GitHub as it is: compare holds the first 300 files on page 1 and no files on later pages; the PR list pages up to 3000.
function bigPr(total, { baseRef = 'main', agentAt = -1 } = {}) {
  const files = Array.from({ length: total }, (_, i) => (i === agentAt ? '.claude/settings.json' : `img/p${i}.jpg`));
  const calls = [];
  const api = async (p) => {
    calls.push(p);
    if (p.includes('/compare/')) return /&page=1$/.test(p) ? { files: files.slice(0, 300).map((filename) => ({ filename })) } : { commits: [] };
    const page = Number(/&page=(\d+)/.exec(p)[1]);
    return files.slice(0, 3000).slice((page - 1) * 100, page * 100).map((filename) => ({ filename }));
  };
  return { api, calls, pr: { number: 69, baseRef, changedFiles: total } };
}

test('listCompareFiles: a PR of 466 files on the default branch is read in full from its own file list', async () => {
  const g = bigPr(466, { agentAt: 400 });
  const r = await listCompareFiles(g.api, REPO, 'main', HEAD, g.pr);
  assert.equal(r.truncated, false);
  assert.equal(r.names.length, 466);
  assert.ok(r.names.includes('.claude/settings.json'), 'a file past the first 300 is still checked');
  assert.equal(g.calls.filter((c) => c.includes('/compare/')).length, 1, 'compare is never paged');
  assert.equal(g.calls.filter((c) => c.includes('/pulls/69/files')).length, 5);
});

test('listCompareFiles: past 3000 files, on another base branch, or with no PR facts the list counts as truncated', async () => {
  const huge = bigPr(3500);
  const r = await listCompareFiles(huge.api, REPO, 'main', HEAD, huge.pr);
  assert.equal(r.truncated, true);
  assert.equal(huge.calls.filter((c) => c.includes('/pulls/69/files')).length, 30, 'stops at the 3000 GitHub lists');
  const stacked = bigPr(466, { baseRef: 'release' });
  assert.equal((await listCompareFiles(stacked.api, REPO, 'main', HEAD, stacked.pr)).truncated, true);
  assert.equal(stacked.calls.length, 1, 'a PR on another base is not read through its own list');
  const bare = bigPr(466);
  assert.equal((await listCompareFiles(bare.api, REPO, 'main', HEAD)).truncated, true);
  const exact = bigPr(300);
  assert.equal((await listCompareFiles(exact.api, REPO, 'main', HEAD, exact.pr)).truncated, false, '300 exactly: read through the PR list');
});

test('listCompareFiles keeps the slashes of a default branch name and encodes everything else that would break the URL', async () => {
  const calls = [];
  const api = async (p) => { calls.push(p); return { files: [] }; };
  await listCompareFiles(api, REPO, 'release/2026 #1', HEAD);
  assert.equal(calls[0], `repos/${REPO}/compare/release/2026%20%231...${HEAD}?per_page=100&page=1`);
});

test('prInfo reads the head and base repository names and the default branch; missing parts are null, never guessed', async () => {
  const full = await prInfo(async () => ({
    user: { login: 'Cloud-Bot' }, head: { sha: HEAD.toUpperCase(), repo: { full_name: 'Acme/App' } }, base: { repo: { full_name: 'acme/app', default_branch: 'trunk' } },
  }), REPO, PR);
  assert.deepEqual(full, { authors: ['cloud-bot'], headSha: HEAD, headRepo: 'Acme/App', baseRepo: 'acme/app', defaultBranch: 'trunk', number: null, baseRef: null, changedFiles: null });
  const bare = await prInfo(async () => ({ head: { sha: 'main', repo: null } }), REPO, PR);
  assert.deepEqual(bare, { authors: [], headSha: null, headRepo: null, baseRepo: null, defaultBranch: null, number: null, baseRef: null, changedFiles: null });
});

test('forkRefusal accepts only a head repository equal (ignoring case) to the base repository', () => {
  assert.equal(forkRefusal({ headRepo: 'acme/app', baseRepo: 'acme/app' }, REPO), null);
  assert.equal(forkRefusal({ headRepo: 'ACME/App', baseRepo: 'acme/app' }, REPO), null);
  assert.equal(forkRefusal({ headRepo: 'ACME/App', baseRepo: null }, REPO), null, 'without a base name the requested repository is the base');
  assert.match(forkRefusal({ headRepo: 'mallory/app', baseRepo: 'acme/app' }, REPO), /fork/);
  assert.match(forkRefusal({ headRepo: null, baseRepo: 'acme/app' }, REPO), /fork/);
  assert.match(forkRefusal({ baseRepo: 'acme/app' }, REPO), /fork/);
  assert.match(forkRefusal({ headRepo: 'acme/app-fork', baseRepo: 'acme/app' }, REPO), /fork/, 'a longer name is not the same repository');
});
