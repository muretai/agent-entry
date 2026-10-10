#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The owner declines a pending receipt: declineReceipt (confirmReceipt's twin) and
// `agent-entry decide <ref> decline [--note <text>] --store <file>`.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). AT-28 skeleton item 3 of 6 (intake
// 20261010T051834Z), parent design record 20261004T022919Z, part 2 "The decision". It comes after
// item 2 (`decide <ref> approve`, intake 20261010T051833Z) and pins only what item 3 adds: the
// `receipts` store section, pending storage on issue and `decide approve` are item 2's (and item
// 1's) and are used here as the fixtures' starting state only. Push delivery is not pinned. The
// implementer may not edit this file. It is not wired into `npm test` until it is green; run it as
// `node conformance/decline.mjs`.
//
// What it pins:
//   - declineReceipt(seedHex, receiptText, note?) is exported beside confirmReceipt. On a pending
//     text it returns confirmReceipt's fields with status "declined": verb, of, customer_did and
//     request kept; a deal keeping type, partyA, partyB, termsHash, salt, ref and contextId, with a
//     fresh ts (never before the hold's) and a fresh sigA by the door's key over the same seven
//     signed fields. Without a note, at one fixed clock, its bytes are confirmReceipt's with only
//     the status word changed (the deal and its sigA are one). With a note, `note` is the one key
//     added, carrying the shop's words exactly; without one there is no `note` key at all.
//   - A pinned pending text, built here from a fixed seed, salt and ts, and its decline under a fixed
//     clock: the vector.
//   - `decide <ref> decline --note <text> --store <file>` looks the ref up in the store's `receipts`
//     section, stores decision {status: "declined", text, decided_ts} under it and prints the text.
//     A second identical call prints the stored decision, exits 0 and leaves the store byte for byte.
// Refusals (declineReceipt throws naming the cause; the CLI exits 1, names the cause, and the store
// file is byte for byte as it was):
//   - a note of 501 characters (500 is accepted);
//   - a note carrying a control character: newline, tab, NUL, DEL;
//   - a receipt whose sigA does not verify under the door's key, checked FIRST: before the shape,
//     and before the note;
//   - a receipt that is not pending (already confirmed, already declined);
//   - an unknown ref;
//   - a ref decided with the other verdict: approve then decline, and decline then approve.
// Invariants kept: no new signed field (the deal's keys are DealReceipt's nine, sigA over the same
// seven), and SINK_FIELDS unchanged, so no DID or receipt text enters any sink.
//
// The seed reaches the child as AGENT_ENTRY_SEED_HEX in its environment, as `decide` reads it on
// main today; the record names `--seed <...>` without fixing its form, so this file does not pin it.
// THE CLI NEVER DIALS: every child runs with fixtures/cli/no-dial.mjs preloaded.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const {
  canonicalBytes, confirmReceipt, createAgentEntry, createFileStore, didFromSeedHex, publicKeyHexFromDid,
  signBytes, signEnvelope, verifyBytes,
} = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'muretai-agent-entry.mjs');
const NO_DIAL = pathToFileURL(join(HERE, 'fixtures', 'cli', 'no-dial.mjs')).href;
const FIXED_CLOCK = pathToFileURL(join(HERE, 'fixtures', 'cli', 'fixed-clock.mjs')).href;

const SHOP_SEED = '5a'.repeat(32);
const CUSTOMER_SEED = '6c'.repeat(32);
const STRANGER_SEED = '7e'.repeat(32);
const SHOP_DID = didFromSeedHex(SHOP_SEED);
const CUSTOMER_DID = didFromSeedHex(CUSTOMER_SEED);
const SHOP_BASE = 'https://shop.example';
const HOLD_TEXT = 'hold item {"id":101}';
const NOTE = 'Sorry, that lamp sold this morning. We restock on Friday.';
const DEAL_KEYS = ['contextId', 'partyA', 'partyB', 'ref', 'salt', 'sigA', 'termsHash', 'ts', 'type'];
const REPLY_KEYS = ['customer_did', 'deal', 'of', 'request', 'status', 'verb'];

const DECLARATION = {
  v: 1,
  entry: { name: 'Harbor Lamp', baseUrl: SHOP_BASE },
  offers: [{ verb: 'hold', of: 'item', about: 'Hold one item for pickup; the shop confirms it.',
    input: { id: 'integer' }, door: { reply: 'pending' } }],
};

const scratch = [];
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const clone = (v) => JSON.parse(JSON.stringify(v));
const sortedKeys = (o) => Object.keys(o).sort();
const dealPayload = (d) => canonicalBytes({ type: d.type, partyA: d.partyA, partyB: d.partyB, termsHash: d.termsHash,
  contextId: d.contextId, ref: d.ref, ts: d.ts });
const sigAVerifies = (d) => {
  const sig = Buffer.from(String(d.sigA), 'base64');
  return sig.length === 64 && verifyBytes(Buffer.from(publicKeyHexFromDid(SHOP_DID), 'hex'), sig, dealPayload(d));
};

/** Run `fn` with Date.now answering `ms`. */
function atClock(ms, fn) {
  const realNow = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = realNow; }
}

function decline(...args) {
  assert.equal(typeof door.declineReceipt, 'function', 'declineReceipt is exported beside confirmReceipt');
  return door.declineReceipt(...args);
}

/** declineReceipt's refusal: it throws, and the message names `cause`. */
function assertDeclineRefused(args, cause, what) {
  assert.equal(typeof door.declineReceipt, 'function', 'declineReceipt is exported beside confirmReceipt');
  let thrown = null;
  let out;
  try { out = door.declineReceipt(...args); } catch (e) { thrown = e; }
  assert.ok(thrown, `${what} is refused, not declined: ${String(out).slice(0, 200)}`);
  assert.match(String(thrown.message), cause, `${what}: the refusal names its cause: ${thrown.message}`);
  assert.ok(!String(thrown.message).includes(SHOP_SEED), `${what}: the seed is never in the message`);
}

// ---------------------------------------------------------------- the pinned pending text

const VECTOR_TS = 1760000000;
const VECTOR_SALT = Buffer.alloc(16, 0x2b).toString('base64');
const VECTOR_REF = 'at28-vector-hold-1';

/** A pending reply as the door signs one, from fixed parts: the vector both helpers start from. */
function pinnedPending({ seed = SHOP_SEED, ref = VECTOR_REF } = {}) {
  const terms = { verb: 'hold', of: 'item', customer_did: CUSTOMER_DID, request: HOLD_TEXT, status: 'pending_confirmation' };
  const termsHash = createHash('sha256')
    .update(Buffer.concat([canonicalBytes({ terms }), Buffer.from(VECTOR_SALT, 'base64')])).digest('hex');
  const signed = { type: 'DealReceipt', partyA: didFromSeedHex(seed), partyB: CUSTOMER_DID, termsHash,
    contextId: null, ref, ts: VECTOR_TS };
  const deal = { ...signed, salt: VECTOR_SALT, sigA: signBytes(seed, canonicalBytes(signed)).toString('base64') };
  return JSON.stringify({ ...terms, deal });
}

const PENDING = pinnedPending();
const PENDING_DEAL = JSON.parse(PENDING).deal;
const FIXED_MS = (VECTOR_TS + 3600) * 1000;

// ---------------------------------------------------------------- the shop's store, through its own door

let sequence = 0;
/** One signed `hold` knock at `entry`, in process: the reply text exactly as the door signed it. */
async function hold(entry, seed = CUSTOMER_SEED) {
  const from = didFromSeedHex(seed);
  const messageId = `decline-hold-${++sequence}-${process.pid}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signEnvelope(seed, { from, to: entry.did, messageId, contextId: null, timestamp, text: HOLD_TEXT });
  const body = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text: HOLD_TEXT }],
      metadata: { from, to: entry.did, timestamp, sig, offer: 'hold' } } },
  }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
    { remoteAddress: '127.0.0.1' });
  const replyText = JSON.parse(Buffer.from(out.body).toString('utf8')).result.parts[0].text;
  const reply = JSON.parse(replyText);
  assert.equal(reply.status, 'pending_confirmation', `the fixture door answers the hold pending: ${replyText.slice(0, 300)}`);
  return { replyText, reply, ref: reply.deal.ref };
}

const state = { home: null, project: null };

/** A fresh store file holding `count` undecided receipts the shop's door issued (item 1/2's state). */
async function shopStore(count = 1) {
  const dir = tmp('ae-decline-store-');
  const path = join(dir, 'state.json');
  const entry = createAgentEntry({ seedHex: SHOP_SEED, name: DECLARATION.entry.name, baseUrl: SHOP_BASE,
    declaration: DECLARATION, store: createFileStore(path) });
  const holds = [];
  for (let i = 0; i < count; i += 1) holds.push(await hold(entry));
  const store = createFileStore(path);
  for (const h of holds) {
    const row = await store.getReceipt(h.ref);
    assert.ok(row && row.decision === null, `fixture: the hold ${h.ref} waits undecided in the store`);
    assert.equal(row.pending_text, h.replyText, 'fixture: the row keeps the pending text as signed');
  }
  return { path, holds };
}

const readRow = (path, ref) => createFileStore(path).getReceipt(ref);

// ---------------------------------------------------------------- the CLI child

function runDecide(args, { fixedNowMs = null, seed = SHOP_SEED } = {}) {
  const log = join(tmp('ae-decline-dial-'), 'dial.jsonl');
  const env = { HOME: state.home, AE_NO_DIAL_LOG: log };
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k];
  if (seed !== null) env.AGENT_ENTRY_SEED_HEX = seed;
  if (fixedNowMs !== null) env.AE_FIXED_NOW_MS = String(fixedNowMs);
  const imports = ['--import', NO_DIAL, ...(fixedNowMs !== null ? ['--import', FIXED_CLOCK] : [])];
  const run = spawnSync(process.execPath, [...imports, BIN, 'decide', ...args],
    { cwd: state.project, env, encoding: 'utf8', timeout: 60000 });
  let dial = [];
  try { dial = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
  return { code: run.status, stdout: run.stdout || '', stderr: run.stderr || '', timedOut: run.error?.code === 'ETIMEDOUT', dial };
}

const said = (run) => `exit ${run.code}; stdout ${JSON.stringify(run.stdout.slice(0, 400))}; stderr ${JSON.stringify(run.stderr.slice(0, 400))}`;

function assertNeverDialled(run, what) {
  assert.ok(!run.timedOut, `${what}: timed out`);
  assert.ok(run.dial.some((r) => r.kind === 'loaded'), `${what}: the no-dial guard did not load`);
  assert.deepEqual(run.dial.filter((r) => r.kind !== 'loaded'), [], `${what}: tried to reach the network`);
}

/** A CLI refusal: exit 1, the cause named on stderr, nothing on stdout, the store file untouched. */
function assertCliRefused(run, { storePath, before: bytes, cause, what }) {
  assertNeverDialled(run, what);
  assert.equal(run.code, 1, `${what} is refused: ${said(run)}`);
  assert.equal(run.stdout.trim(), '', `${what}: a refusal prints no follow-up: ${said(run)}`);
  assert.match(run.stderr, cause, `${what}: the refusal names its cause: ${said(run)}`);
  assert.ok(!`${run.stdout}${run.stderr}`.includes(SHOP_SEED), `${what}: the seed is never printed`);
  assert.equal(readFileSync(storePath, 'utf8'), bytes, `${what}: nothing is written to the store`);
}

/** The declined follow-up `text` is the door's decline of `pendingText`. */
function assertDeclinedOf(text, pendingText, note) {
  const out = JSON.parse(text);
  const pending = JSON.parse(pendingText);
  assert.equal(out.status, 'declined', 'the follow-up reads declined');
  for (const k of ['verb', 'of', 'customer_did', 'request']) assert.equal(out[k], pending[k], `keeps the receipt's ${k}`);
  for (const k of ['type', 'partyA', 'partyB', 'termsHash', 'salt', 'ref', 'contextId']) {
    assert.equal(out.deal[k], pending.deal[k], `the deal keeps the receipt's ${k}`);
  }
  assert.ok(Number.isSafeInteger(out.deal.ts) && out.deal.ts >= pending.deal.ts, 'a fresh ts, never before the hold\'s');
  assert.ok(sigAVerifies(out.deal), 'a fresh sigA that verifies under the door\'s key');
  if (note === undefined) assert.ok(!Object.hasOwn(out, 'note'), 'no note given: no note key');
  else assert.equal(out.note, note, 'the shop\'s note, exactly');
}

before(() => {
  state.home = tmp('ae-decline-home-');
  state.project = tmp('ae-decline-shop-');
  writeFileSync(join(state.project, 'agent-entry.json'), `${JSON.stringify(DECLARATION, null, 2)}\n`);
});

// ================================================================ declineReceipt: functional

test('fixture: the pinned pending text is a pending reply confirmReceipt accepts', () => {
  const confirmed = JSON.parse(atClock(FIXED_MS, () => confirmReceipt(SHOP_SEED, PENDING)));
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.deal.termsHash, PENDING_DEAL.termsHash);
});

test('declineReceipt is exported beside confirmReceipt', () => {
  assert.equal(typeof door.declineReceipt, 'function', 'declineReceipt is exported');
  assert.equal(typeof door.confirmReceipt, 'function', 'confirmReceipt stays exported');
});

test('declineReceipt without a note: the declined shape, the deal chained on the same termsHash, no note key', () => {
  const text = atClock(FIXED_MS, () => decline(SHOP_SEED, PENDING));
  assert.equal(typeof text, 'string', 'declineReceipt returns the follow-up text');
  const out = JSON.parse(text);
  assert.deepEqual(sortedKeys(out), REPLY_KEYS, 'exactly confirmReceipt\'s fields: nothing added without a note');
  assert.deepEqual(sortedKeys(out.deal), DEAL_KEYS, 'the deal is DealReceipt\'s nine keys: no new signed field');
  assertDeclinedOf(text, PENDING, undefined);
  assert.equal(out.deal.ts, VECTOR_TS + 3600, 'the fresh ts is the clock\'s second');
});

test('vector: at one fixed clock and no note, the decline is confirmReceipt\'s bytes with only the status changed', () => {
  const confirmed = atClock(FIXED_MS, () => confirmReceipt(SHOP_SEED, PENDING));
  const declined = atClock(FIXED_MS, () => decline(SHOP_SEED, PENDING));
  assert.ok(confirmed.includes('"status":"confirmed"'), 'fixture: confirmReceipt\'s text carries its status');
  assert.equal(declined, confirmed.replace('"status":"confirmed"', '"status":"declined"'),
    'same fields in the same order, the same deal and sigA (Ed25519 is deterministic); only the status differs');
  const next = { type: 'DealReceipt', partyA: SHOP_DID, partyB: CUSTOMER_DID, termsHash: PENDING_DEAL.termsHash,
    contextId: null, ref: VECTOR_REF, ts: VECTOR_TS + 3600 };
  assert.equal(JSON.parse(declined).deal.sigA, signBytes(SHOP_SEED, canonicalBytes(next)).toString('base64'),
    'the vector sigA: the door key over the seven signed fields at the fixed ts');
});

test('declineReceipt with a note: the note is the one key added, the shop\'s words exactly', () => {
  const text = atClock(FIXED_MS, () => decline(SHOP_SEED, PENDING, NOTE));
  const out = JSON.parse(text);
  assert.deepEqual(sortedKeys(out), [...REPLY_KEYS, 'note'].sort(), 'confirmReceipt\'s fields and note');
  assertDeclinedOf(text, PENDING, NOTE);
  const without = JSON.parse(atClock(FIXED_MS, () => decline(SHOP_SEED, PENDING)));
  const { note, ...rest } = out;
  assert.deepEqual(rest, without, 'with the note taken out, the same declined reply as without one');
});

test('declineReceipt accepts a note of exactly 500 characters, and one with non-ASCII words', () => {
  const at500 = 'n'.repeat(500);
  assertDeclinedOf(atClock(FIXED_MS, () => decline(SHOP_SEED, PENDING, at500)), PENDING, at500);
  const words = 'Désolé, plus en stock. 申し訳ありません。';
  assertDeclinedOf(atClock(FIXED_MS, () => decline(SHOP_SEED, PENDING, words)), PENDING, words);
});

test('declineReceipt on a pending reply the door issued live: declined, chained to the customer\'s receipt', async () => {
  const entry = createAgentEntry({ seedHex: SHOP_SEED, name: DECLARATION.entry.name, baseUrl: SHOP_BASE, declaration: DECLARATION });
  const { replyText } = await hold(entry);
  assertDeclinedOf(decline(SHOP_SEED, replyText, NOTE), replyText, NOTE);
});

test('the fresh ts never runs before the hold\'s, even on a clock behind it', () => {
  const out = JSON.parse(atClock((VECTOR_TS - 600) * 1000, () => decline(SHOP_SEED, PENDING)));
  assert.equal(out.deal.ts, VECTOR_TS, 'ts is the hold\'s, never earlier');
  assert.ok(sigAVerifies(out.deal));
});

// ================================================================ declineReceipt: refusals

test('refused: a note of 501 characters', () => {
  assertDeclineRefused([SHOP_SEED, PENDING, 'n'.repeat(501)], /note/i, 'a 501-character note');
});

test('refused: a note carrying a control character (newline, tab, NUL, DEL, CR, ESC)', () => {
  for (const [name, ch] of [['newline', '\n'], ['tab', '\t'], ['NUL', '\u0000'], ['DEL', '\u007f'],
    ['carriage return', '\r'], ['escape', '\u001b']]) {
    assertDeclineRefused([SHOP_SEED, PENDING, `We are closed.${ch}Sorry.`], /note/i, `a note with ${name}`);
  }
});

test('refused: a note that is not a string', () => {
  for (const bad of [42, { text: 'no' }, ['no']]) {
    assertDeclineRefused([SHOP_SEED, PENDING, bad], /note/i, `a note of ${JSON.stringify(bad)}`);
  }
});

test('refused: a receipt another key signed (self-consistent under that key)', () => {
  assertDeclineRefused([SHOP_SEED, pinnedPending({ seed: STRANGER_SEED })], /not signed by this key|sign/i, 'another door\'s receipt');
});

test('refused: a receipt whose sigA does not verify (a deal field or the signature edited)', () => {
  const editedRef = JSON.parse(PENDING);
  editedRef.deal.ref = 'someone-elses-ref';
  assertDeclineRefused([SHOP_SEED, JSON.stringify(editedRef)], /sign/i, 'an edited deal ref');
  const flipped = JSON.parse(PENDING);
  const sig = Buffer.from(flipped.deal.sigA, 'base64');
  sig[0] ^= 0x01;
  flipped.deal.sigA = sig.toString('base64');
  assertDeclineRefused([SHOP_SEED, JSON.stringify(flipped)], /sign/i, 'a flipped sigA bit');
  const noSig = JSON.parse(PENDING);
  delete noSig.deal.sigA;
  assertDeclineRefused([SHOP_SEED, JSON.stringify(noSig)], /sign/i, 'a deal with no sigA');
});

test('the door\'s signature is verified FIRST: before the receipt\'s shape and before the note', () => {
  const stranger = JSON.parse(pinnedPending({ seed: STRANGER_SEED }));
  stranger.extra = 'not the pending shape';
  stranger.status = 'confirmed';
  assertDeclineRefused([SHOP_SEED, JSON.stringify(stranger)], /not signed by this key|sign/i,
    'another key\'s receipt that is also not pending');
  assertDeclineRefused([SHOP_SEED, pinnedPending({ seed: STRANGER_SEED }), 'bad\nnote'], /sign/i,
    'another key\'s receipt with a bad note: the signature is the cause named');
});

test('refused: a receipt that is not pending (already confirmed, already declined)', () => {
  const confirmed = atClock(FIXED_MS, () => confirmReceipt(SHOP_SEED, PENDING));
  assertDeclineRefused([SHOP_SEED, confirmed], /pending/i, 'a confirmed reply');
  const declined = atClock(FIXED_MS, () => decline(SHOP_SEED, PENDING));
  assertDeclineRefused([SHOP_SEED, declined], /pending/i, 'a declined reply');
});

test('refused: a receipt whose terms were edited after signing (termsHash no longer commits)', () => {
  const edited = JSON.parse(PENDING);
  edited.request = 'hold item {"id":999}';
  assertDeclineRefused([SHOP_SEED, JSON.stringify(edited)], /terms|changed/i, 'edited terms');
});

test('refused: a bad seed or a receipt that is not JSON', () => {
  assertDeclineRefused(['zz', PENDING], /seed/i, 'a seed that is not 64 hex');
  assertDeclineRefused([SHOP_SEED, 'not json'], /JSON/i, 'a receipt that is not JSON');
});

// ================================================================ decide <ref> decline: functional

test('decide <ref> decline --note: stores decision declined, prints the follow-up text', async () => {
  const { path, holds } = await shopStore();
  const { ref, replyText } = holds[0];
  const rowBefore = clone(await readRow(path, ref));
  const fixedNowMs = (Math.floor(Date.now() / 1000) + 5) * 1000;
  const run = runDecide([ref, 'decline', '--note', NOTE, '--store', path], { fixedNowMs });
  assertNeverDialled(run, 'decide decline');
  assert.equal(run.code, 0, `decide <ref> decline succeeds: ${said(run)}`);
  assert.ok(!`${run.stdout}${run.stderr}`.includes(SHOP_SEED), 'the seed is never printed');

  const row = await readRow(path, ref);
  assert.ok(row && row.decision && typeof row.decision === 'object', `a decision is stored under the ref: ${JSON.stringify(row).slice(0, 300)}`);
  assert.deepEqual(sortedKeys(row.decision), ['decided_ts', 'status', 'text'], 'decision is {status, text, decided_ts}');
  assert.equal(row.decision.status, 'declined');
  assert.ok(Number.isSafeInteger(row.decision.decided_ts), 'decided_ts is an epoch second');
  assert.equal(row.decision.decided_ts, fixedNowMs / 1000, 'decided_ts is the decision\'s second');
  assertDeclinedOf(row.decision.text, replyText, NOTE);
  const expected = atClock(fixedNowMs, () => decline(SHOP_SEED, replyText, NOTE));
  assert.equal(row.decision.text, expected, 'the stored text is declineReceipt(seed, pending_text, note), byte for byte');
  assert.ok(run.stdout.includes(row.decision.text), `the follow-up text is printed: ${said(run)}`);
  for (const k of ['ref', 'offer', 'partyB', 'issued_ts', 'pending_text']) {
    assert.deepEqual(row[k], rowBefore[k], `the row keeps its ${k}`);
  }
});

test('decide <ref> decline with no note: declined, no note key', async () => {
  const { path, holds } = await shopStore();
  const run = runDecide([holds[0].ref, 'decline', '--store', path]);
  assertNeverDialled(run, 'decide decline (no note)');
  assert.equal(run.code, 0, `decide <ref> decline with no --note succeeds: ${said(run)}`);
  const row = await readRow(path, holds[0].ref);
  assert.equal(row?.decision?.status, 'declined');
  assertDeclinedOf(row.decision.text, holds[0].replyText, undefined);
  assert.ok(run.stdout.includes(row.decision.text), 'the follow-up text is printed');
});

test('decide decline is idempotent by ref: a second call prints the stored decision, exits 0, store unchanged', async () => {
  const { path, holds } = await shopStore();
  const first = runDecide([holds[0].ref, 'decline', '--note', NOTE, '--store', path]);
  assert.equal(first.code, 0, `the first decline: ${said(first)}`);
  const bytes = readFileSync(path, 'utf8');
  const stored = (await readRow(path, holds[0].ref)).decision;
  // A later second: a re-decline would sign a fresh ts; the stored decision must come back instead.
  const second = runDecide([holds[0].ref, 'decline', '--note', NOTE, '--store', path],
    { fixedNowMs: (stored.decided_ts + 120) * 1000 });
  assertNeverDialled(second, 'the second decline');
  assert.equal(second.code, 0, `a second decline on the same ref exits 0: ${said(second)}`);
  assert.ok(second.stdout.includes(stored.text), `it prints the stored decision: ${said(second)}`);
  assert.equal(readFileSync(path, 'utf8'), bytes, 'the store is byte for byte as it was');
});

test('decide decline touches only its own ref: another undecided row stays undecided', async () => {
  const { path, holds } = await shopStore(2);
  const run = runDecide([holds[0].ref, 'decline', '--store', path]);
  assert.equal(run.code, 0, `decide decline: ${said(run)}`);
  const other = await readRow(path, holds[1].ref);
  assert.equal(other.decision, null, 'the other receipt still waits');
  assert.equal(other.pending_text, holds[1].replyText);
  const undecided = (await createFileStore(path).listUndecidedReceipts()).map((r) => r.ref);
  assert.deepEqual(undecided, [holds[1].ref], 'only the declined ref left the pending list');
});

// ================================================================ decide <ref> decline: refusals

test('refused by the CLI: a --note of 501 characters (500 accepted)', async () => {
  const { path, holds } = await shopStore(2);
  const before = readFileSync(path, 'utf8');
  assertCliRefused(runDecide([holds[0].ref, 'decline', '--note', 'n'.repeat(501), '--store', path]),
    { storePath: path, before, cause: /note/i, what: 'a 501-character --note' });
  const ok = runDecide([holds[1].ref, 'decline', '--note', 'n'.repeat(500), '--store', path]);
  assert.equal(ok.code, 0, `a 500-character --note is accepted: ${said(ok)}`);
  assert.equal(JSON.parse((await readRow(path, holds[1].ref)).decision.text).note, 'n'.repeat(500));
});

test('refused by the CLI: a --note carrying a control character', async () => {
  const { path, holds } = await shopStore();
  const before = readFileSync(path, 'utf8');
  for (const [name, ch] of [['newline', '\n'], ['tab', '\t'], ['DEL', '\u007f'], ['escape', '\u001b']]) {
    assertCliRefused(runDecide([holds[0].ref, 'decline', '--note', `closed${ch}sorry`, '--store', path]),
      { storePath: path, before, cause: /note/i, what: `a --note with ${name}` });
  }
});

test('refused by the CLI: a stored receipt whose sigA does not verify', async () => {
  const { path, holds } = await shopStore();
  const { ref } = holds[0];
  const store = createFileStore(path);
  const row = clone(await store.getReceipt(ref));
  const pending = JSON.parse(row.pending_text);
  const sig = Buffer.from(pending.deal.sigA, 'base64');
  sig[5] ^= 0x10;
  pending.deal.sigA = sig.toString('base64');
  row.pending_text = JSON.stringify(pending);
  await store.putReceipt(ref, row);
  const before = readFileSync(path, 'utf8');
  assertCliRefused(runDecide([ref, 'decline', '--note', NOTE, '--store', path]),
    { storePath: path, before, cause: /sign/i, what: 'a tampered receipt' });
});

test('refused by the CLI: a stored receipt under another seed (not this door\'s)', async () => {
  const { path, holds } = await shopStore();
  const before = readFileSync(path, 'utf8');
  assertCliRefused(runDecide([holds[0].ref, 'decline', '--store', path], { seed: STRANGER_SEED }),
    { storePath: path, before, cause: /sign/i, what: 'decide under a key that did not sign the receipt' });
});

test('refused by the CLI: an unknown ref', async () => {
  const { path } = await shopStore();
  const before = readFileSync(path, 'utf8');
  for (const ref of ['no-such-ref', '__proto__', 'constructor']) {
    assertCliRefused(runDecide([ref, 'decline', '--note', NOTE, '--store', path]),
      { storePath: path, before, cause: /ref|unknown|no receipt/i, what: `unknown ref ${ref}` });
  }
});

test('refused by the CLI: approve then decline on one ref (exit 1, the approval stands)', async () => {
  const { path, holds } = await shopStore();
  const { ref } = holds[0];
  const approve = runDecide([ref, 'approve', '--store', path]);
  assert.equal(approve.code, 0, `fixture: item 2's decide approve: ${said(approve)}`);
  const approved = (await readRow(path, ref)).decision;
  assert.ok(approved && JSON.parse(approved.text).status === 'confirmed', 'fixture: the ref is approved');
  const before = readFileSync(path, 'utf8');
  assertCliRefused(runDecide([ref, 'decline', '--note', NOTE, '--store', path]),
    { storePath: path, before, cause: /decided|approved|confirmed/i, what: 'decline after approve' });
});

test('refused by the CLI: decline then approve on one ref (exit 1, the decline stands)', async () => {
  const { path, holds } = await shopStore();
  const { ref } = holds[0];
  const declined = runDecide([ref, 'decline', '--note', NOTE, '--store', path]);
  assert.equal(declined.code, 0, `decide decline: ${said(declined)}`);
  const before = readFileSync(path, 'utf8');
  assertCliRefused(runDecide([ref, 'approve', '--store', path]),
    { storePath: path, before, cause: /decided|declined/i, what: 'approve after decline' });
  assert.equal((await readRow(path, ref)).decision.status, 'declined', 'the decline stands');
});

test('refused by the CLI: a second decline with a different note does not rewrite the decision', async () => {
  const { path, holds } = await shopStore();
  const { ref } = holds[0];
  assert.equal(runDecide([ref, 'decline', '--note', NOTE, '--store', path]).code, 0);
  const bytes = readFileSync(path, 'utf8');
  const stored = (await readRow(path, ref)).decision;
  const again = runDecide([ref, 'decline', '--note', 'Different words.', '--store', path]);
  assert.ok(again.code === 0 || again.code === 1, `a second decline never crashes: ${said(again)}`);
  if (again.code === 0) assert.ok(again.stdout.includes(stored.text), 'exit 0 prints the stored decision');
  assert.equal(readFileSync(path, 'utf8'), bytes, 'the stored decision and note are unchanged');
});

// ================================================================ invariants

test('invariant: SINK_FIELDS is unchanged, so no DID, note or receipt text enters any sink', () => {
  const source = readFileSync(BIN, 'utf8');
  const m = source.match(/const SINK_FIELDS = (\[[^\]]*\]);/);
  assert.ok(m, 'SINK_FIELDS is still one literal');
  const fields = JSON.parse(m[1].replace(/'/g, '"').replace(/\s+/g, ' '));
  assert.deepEqual(fields, ['stage', 'event', 'offer', 'engine', 'ms', 'reply', 'receipt', 'identified',
    'verified', 'ua_family', 'client_class', 'ip_vendor', 'country', 'signature_agent', 'refused',
    'first_contact'], 'SINK_FIELDS as on main before AT-28 item 3');
});

test('invariant: no new signed field: the declined deal is signed over the same seven fields as the pending one', () => {
  const out = JSON.parse(atClock(FIXED_MS, () => decline(SHOP_SEED, PENDING, NOTE)));
  assert.deepEqual(sortedKeys(out.deal), DEAL_KEYS, 'the deal\'s keys are DealReceipt\'s nine');
  assert.ok(sigAVerifies(out.deal), 'sigA verifies over type, partyA, partyB, termsHash, contextId, ref, ts');
  assert.ok(!Object.hasOwn(out.deal, 'note') && !Object.hasOwn(out.deal, 'status'), 'neither note nor status rides in the deal');
});
