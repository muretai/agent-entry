#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The door's `track` answer: the customer comes back with its ref and collects the decision.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). AT-28 skeleton item 4 of 6 (intake
// 20261010T051834Z-2) of the parent design record 20261004T022919Z, section "Collecting it". The
// receipts store section is item 1 (landed); `decide`, `pending`, declineReceipt and the store-writing
// of issued receipts are other items and are not pinned or used here. The implementer may not edit
// this file. It is not wired into `npm test` until it is green; run it as `node conformance/track.mjs`.
//
// Every receipt below is SEEDED straight into the store through putReceipt, in the record's row shape
// {ref, offer, partyB, issued_ts, pending_text, decision}, decision null or {status, text, decided_ts}:
// the pending text is one this door's key signed (minted on a scratch door), the confirmed text is the
// landed confirmReceipt's, and the declined text is a fixture.
//
// What it pins: `message/send` with metadata.offer "track" and text {"ref": "<ref>"} (the JSON after
// optional words, as checkout fields are read), signed by the receipt's partyB, is answered signed by
// the door with
//   - an undecided row: the AT-12 shape for verb track, exactly {verb: "track", of: <the original
//     offer's of>, customer_did: partyB, request: <this message's text>, status:
//     "pending_confirmation"}, no deal;
//   - a decided row (confirmed, and declined): the stored decision text, byte for byte, which the
//     customer's own knock (checkedBookingReceipt) reads as its booking;
//   - a door whose declaration declares no `track` offer answers it all the same;
//   - answering writes no receipt row and changes none.
// Refusals, each -32602, none saying whether the ref exists, none writing a receipt row:
//   - a ref no receipt carries (including __proto__ and constructor);
//   - a signer other than partyB, on an undecided and on a decided ref (the decision never leaks);
//   - the anonymous lane;
//   - any other text: a bare ref, JSON without ref, a ref that is not a string, an empty ref, malformed
//     JSON; and the error for an unknown ref equals the error for a wrong signer.
// Fixtures only: nothing here dials out.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const {
  AGENT_CARD_PATH, confirmReceipt, createAgentEntry, createMemoryStore, didFromSeedHex, knockAgentEntry,
  signEnvelope, verifyEnvelope,
} = door;

const DOOR_SEED = 'a7'.repeat(32);
const CUSTOMER_SEED = '3c'.repeat(32);
const STRANGER_SEED = '4d'.repeat(32);
const CUSTOMER = didFromSeedHex(CUSTOMER_SEED);
const STRANGER = didFromSeedHex(STRANGER_SEED);
const SHOP_BASE = 'https://shop.example';
const HOLD_TEXT = 'hold item {"id":101}';
const DECLINE_NOTE = 'Sorry, that lamp sold this morning.';
const TRACK_KEYS = ['customer_did', 'of', 'request', 'status', 'verb'];

// The shop declares a receipt-bearing hold and NO track offer: track needs none.
const DECLARATION = {
  v: 1,
  entry: { name: 'Harbor Lamp', baseUrl: SHOP_BASE },
  offers: [
    { verb: 'hold', of: 'item', about: 'Hold one item for pickup; the shop confirms it.',
      input: { id: 'integer' }, door: { reply: 'pending' } },
  ],
};

const scratch = [];
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const clone = (v) => JSON.parse(JSON.stringify(v));
const nowS = () => Math.floor(Date.now() / 1000);

/** The door's memory store, with every putReceipt call recorded. */
function recordingStore() {
  const inner = createMemoryStore();
  const puts = [];
  return new Proxy(inner, {
    get(target, key) {
      if (key === 'puts') return puts;
      if (key === 'putReceipt') return (ref, row) => { puts.push([ref, clone(row)]); return target.putReceipt(ref, row); };
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function makeDoor(store, extra = {}) {
  return createAgentEntry({ seedHex: DOOR_SEED, name: DECLARATION.entry.name, baseUrl: SHOP_BASE,
    declaration: clone(DECLARATION), signedRatePerMin: 0, signedRatePerMinTotal: 0,
    responder: () => 'ok', store, ...extra });
}

let sequence = 0;
/** One message/send at `entry`, in process. `signed: false` takes the anonymous lane. */
async function send(entry, { offer = 'track', text, seed = CUSTOMER_SEED, signed = true } = {}) {
  const from = didFromSeedHex(seed);
  const id = `track-msg-${++sequence}`;
  const timestamp = nowS();
  const metadata = { offer };
  if (signed) {
    const sig = signEnvelope(seed, { from, to: entry.did, messageId: id, contextId: null, timestamp, text });
    Object.assign(metadata, { from, to: entry.did, timestamp, sig });
  }
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId: id, contextId: null, parts: [{ kind: 'text', text }], metadata } } }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
    { remoteAddress: '127.0.0.1' });
  const raw = Buffer.from(out.body || '').toString('utf8');
  let parsed = null; try { parsed = JSON.parse(raw); } catch { /* not json */ }
  const message = parsed?.result;
  const replyText = message?.parts?.[0]?.text;
  let reply = null; try { reply = JSON.parse(replyText); } catch { /* not json */ }
  const verified = Boolean(message) && signed && verifyEnvelope({ from: message.metadata?.from, to: message.metadata?.to,
    messageId: message.messageId, contextId: message.contextId ?? null, timestamp: message.metadata?.timestamp,
    text: replyText, sig: message.metadata?.sig }, { recipientDid: from, signerDid: entry.did });
  return { messageId: id, text, raw, parsed, replyText, reply, verified };
}

const trackText = (ref) => JSON.stringify({ ref });

// ---------------------------------------------------------------- fixtures: seeded receipts

/** A pending hold text this door's key signed, for `seed`'s customer: minted on a scratch door. */
async function mintPendingText(seed = CUSTOMER_SEED, text = HOLD_TEXT) {
  const mint = makeDoor(createMemoryStore());
  const k = await send(mint, { offer: 'hold', text, seed });
  assert.ok(k.verified, `the scratch door answers the hold: ${k.raw.slice(0, 300)}`);
  assert.equal(k.reply?.status, 'pending_confirmation');
  assert.ok(k.reply?.deal && k.reply.deal.ref === k.messageId, 'the pending reply carries a deal');
  return { ref: k.messageId, pendingText: k.replyText, pending: k.reply };
}

/** A declined decision text, a fixture: the confirm shape, status declined, the shop's note. */
function declinedText(pendingText) {
  const v = JSON.parse(confirmReceipt(DOOR_SEED, pendingText));
  return JSON.stringify({ verb: v.verb, of: v.of, customer_did: v.customer_did, request: v.request,
    status: 'declined', note: DECLINE_NOTE, deal: v.deal });
}

/** Seed one row of each kind straight into `store`; returns the three refs and their texts. */
async function seed(store) {
  const undecided = await mintPendingText();
  const confirmed = await mintPendingText(CUSTOMER_SEED, 'hold item {"id":202}');
  const declined = await mintPendingText(CUSTOMER_SEED, 'hold item {"id":303}');
  const base = (m) => ({ ref: m.ref, offer: 'hold', partyB: CUSTOMER, issued_ts: nowS() - 60, pending_text: m.pendingText });
  const confirmedText = confirmReceipt(DOOR_SEED, confirmed.pendingText);
  const declinedTxt = declinedText(declined.pendingText);
  await store.putReceipt(undecided.ref, { ...base(undecided), decision: null });
  await store.putReceipt(confirmed.ref, { ...base(confirmed),
    decision: { status: 'confirmed', text: confirmedText, decided_ts: nowS() - 30 } });
  await store.putReceipt(declined.ref, { ...base(declined),
    decision: { status: 'declined', text: declinedTxt, decided_ts: nowS() - 20 } });
  if (Array.isArray(store.puts)) store.puts.length = 0;
  return { undecided, confirmed, declined, confirmedText, declinedText: declinedTxt };
}

async function snapshot(store, refs) {
  const rows = {};
  for (const r of refs) rows[r] = clone(await store.getReceipt(r));
  return { rows, undecided: clone(await store.listUndecidedReceipts()) };
}

/** Nothing was written to the receipts section, and every seeded row is as it was. */
async function assertNothingWritten(store, before, refs, what) {
  assert.deepEqual(store.puts, [], `${what}: no putReceipt call`);
  assert.deepEqual(await snapshot(store, refs), before, `${what}: every receipt row unchanged`);
}

/** A signed refusal: -32602, no result, and none of `secrets` anywhere in the body. */
function assertRefused(k, what, secrets = []) {
  assert.ok(!k.parsed?.result, `${what}: no answer is given: ${k.raw.slice(0, 300)}`);
  assert.equal(k.parsed?.error?.code, -32602, `${what}: refused -32602: ${k.raw.slice(0, 300)}`);
  for (const s of secrets) assert.ok(!k.raw.includes(s), `${what}: the refusal does not carry ${JSON.stringify(s.slice(0, 40))}`);
}

/** The error a refusal carries, without the request id that differs per message. */
const errorOf = (k) => clone({ code: k.parsed?.error?.code, message: k.parsed?.error?.message, data: k.parsed?.error?.data ?? null });

/** Before any refusal is trusted: the same door answers partyB on the undecided ref. */
async function assertAnswersPartyB(entry, ref) {
  const ok = await send(entry, { text: trackText(ref) });
  assert.ok(ok.verified, `the door answers track for the receipt's partyB: ${ok.raw.slice(0, 300)}`);
  assert.equal(ok.reply?.status, 'pending_confirmation', `pending for partyB: ${String(ok.replyText).slice(0, 300)}`);
}

// ---------------------------------------------------------------- functional

test('an undecided receipt: the signed AT-12 track shape, pending_confirmation, no deal', async () => {
  const store = recordingStore();
  const entry = makeDoor(store);
  const s = await seed(store);
  const k = await send(entry, { text: trackText(s.undecided.ref) });
  assert.ok(k.verified, `the door answers track, signed, to partyB: ${k.raw.slice(0, 300)}`);
  assert.ok(k.reply && typeof k.reply === 'object', `the reply is JSON: ${String(k.replyText).slice(0, 300)}`);
  assert.deepEqual(Object.keys(k.reply).sort(), TRACK_KEYS, 'exactly verb, of, customer_did, request, status: no deal');
  assert.equal(k.reply.verb, 'track');
  assert.equal(k.reply.of, s.undecided.pending.of, 'of is the original offer\'s of');
  assert.equal(k.reply.of, 'item');
  assert.equal(k.reply.customer_did, CUSTOMER, 'filed under partyB');
  assert.equal(k.reply.request, k.text, 'request is this message\'s text');
  assert.equal(k.reply.status, 'pending_confirmation');
  assert.equal(k.parsed.result.metadata?.to, CUSTOMER, 'addressed to partyB');
  assert.equal(k.parsed.result.metadata?.from, entry.did, 'signed by the door');
});

test('a confirmed receipt: the reply text is the stored decision text, byte for byte', async () => {
  const store = recordingStore();
  const entry = makeDoor(store);
  const s = await seed(store);
  const k = await send(entry, { text: trackText(s.confirmed.ref) });
  assert.ok(k.verified, `the door answers track, signed, to partyB: ${k.raw.slice(0, 300)}`);
  assert.equal(k.replyText, s.confirmedText, 'the track reply IS the stored decision text; it wraps nothing');
  assert.equal(k.reply.status, 'confirmed');
  assert.equal(k.reply.deal.termsHash, s.confirmed.pending.deal.termsHash, 'on the receipt\'s termsHash');
});

test('a declined receipt: the reply text is the stored decision text, byte for byte', async () => {
  const store = recordingStore();
  const entry = makeDoor(store);
  const s = await seed(store);
  const k = await send(entry, { text: trackText(s.declined.ref) });
  assert.ok(k.verified, `the door answers track, signed, to partyB: ${k.raw.slice(0, 300)}`);
  assert.equal(k.replyText, s.declinedText, 'the track reply IS the stored decision text; it wraps nothing');
  assert.equal(k.reply.status, 'declined');
  assert.equal(k.reply.note, DECLINE_NOTE);
});

test('the JSON may follow plain words, as checkout fields are read', async () => {
  const store = recordingStore();
  const entry = makeDoor(store);
  const s = await seed(store);
  const pend = await send(entry, { text: `track my hold ${trackText(s.undecided.ref)}` });
  assert.ok(pend.verified, `answered: ${pend.raw.slice(0, 300)}`);
  assert.equal(pend.reply?.status, 'pending_confirmation');
  assert.equal(pend.reply?.request, pend.text, 'request is the whole text, words included');
  const done = await send(entry, { text: `where is my lamp? {"ref": ${JSON.stringify(s.confirmed.ref)}}` });
  assert.ok(done.verified, `answered: ${done.raw.slice(0, 300)}`);
  assert.equal(done.replyText, s.confirmedText, 'still the decision text verbatim');
});

test('answering track writes no receipt row and changes none', async () => {
  const store = recordingStore();
  const entry = makeDoor(store);
  const s = await seed(store);
  const refs = [s.undecided.ref, s.confirmed.ref, s.declined.ref];
  const before = await snapshot(store, refs);
  for (const ref of refs) {
    const k = await send(entry, { text: trackText(ref) });
    assert.ok(k.verified, `answered: ${k.raw.slice(0, 300)}`);
    assert.equal(await store.getReceipt(k.messageId), null, 'the track message files no row of its own');
  }
  await assertNothingWritten(store, before, refs, 'track answered three times');
});

test('the customer\'s knock reads the decision through checkedBookingReceipt: confirmed and declined', async () => {
  const store = recordingStore();
  const entry = makeDoor(store);
  const s = await seed(store);
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const out = await entry.handleRequestAsync(init.method || 'GET', u.pathname + u.search, init.headers || {},
      Buffer.from(init.body || ''), { remoteAddress: '127.0.0.1' });
    return new Response(out.body, { status: out.status, headers: out.headers });
  };
  const keyPath = join(tmp('ae-track-knock-'), 'knock-seed');
  writeFileSync(keyPath, `${CUSTOMER_SEED}\n`, { mode: 0o600 });
  for (const [label, m, text, status] of [['confirmed', s.confirmed, s.confirmedText, 'confirmed'],
    ['declined', s.declined, s.declinedText, 'declined']]) {
    const result = await knockAgentEntry(`${SHOP_BASE}${AGENT_CARD_PATH}`,
      { keyPath, text: trackText(m.ref), offer: 'track', fetchImpl });
    assert.ok(result.ok, `${label}: the knock verifies the track reply: ${JSON.stringify(result).slice(0, 300)}`);
    assert.equal(result.reply?.result?.parts?.[0]?.text, text, `${label}: the signed wire carries the decision text verbatim`);
    assert.ok(result.booking, `${label}: checkedBookingReceipt reads a booking: ${String(result.text).slice(0, 300)}`);
    assert.equal(result.booking.customer_did, CUSTOMER, `${label}: filed under the customer`);
    assert.equal(result.booking.status, status, `${label}: the booking reads ${status}`);
    assert.equal(result.booking.deal?.termsHash, m.pending.deal.termsHash, `${label}: on the receipt's termsHash`);
  }
});

// ---------------------------------------------------------------- refusals

test('refused: a ref no receipt carries, -32602, nothing written', async () => {
  const store = recordingStore();
  const entry = makeDoor(store);
  const s = await seed(store);
  await assertAnswersPartyB(entry, s.undecided.ref);
  const refs = [s.undecided.ref, s.confirmed.ref, s.declined.ref];
  const before = await snapshot(store, refs);
  for (const ref of ['no-such-ref', `${s.undecided.ref}x`, s.undecided.ref.toUpperCase(), '__proto__', 'constructor', 'hasOwnProperty']) {
    const k = await send(entry, { text: trackText(ref) });
    assertRefused(k, `unknown ref ${ref}`, [s.undecided.pendingText, s.confirmedText]);
  }
  await assertNothingWritten(store, before, refs, 'unknown refs');
  assert.equal(({}).decision, undefined, 'Object.prototype untouched');
});

test('refused: a signer other than partyB, on an undecided and on a decided ref; the decision never leaks', async () => {
  const store = recordingStore();
  const entry = makeDoor(store);
  const s = await seed(store);
  await assertAnswersPartyB(entry, s.undecided.ref);
  const refs = [s.undecided.ref, s.confirmed.ref, s.declined.ref];
  const before = await snapshot(store, refs);
  const secrets = (m, text) => [CUSTOMER, m.pending.deal.termsHash, m.pending.deal.sigA, ...(text ? [text, JSON.parse(text).deal.sigA] : [])];
  const u = await send(entry, { text: trackText(s.undecided.ref), seed: STRANGER_SEED });
  assertRefused(u, 'stranger on the undecided ref', [...secrets(s.undecided), s.undecided.pendingText]);
  const c = await send(entry, { text: trackText(s.confirmed.ref), seed: STRANGER_SEED });
  assertRefused(c, 'stranger on the confirmed ref', secrets(s.confirmed, s.confirmedText));
  const d = await send(entry, { text: trackText(s.declined.ref), seed: STRANGER_SEED });
  assertRefused(d, 'stranger on the declined ref', [...secrets(s.declined, s.declinedText), DECLINE_NOTE]);
  // The door's own key is not partyB either.
  const self = await send(entry, { text: trackText(s.confirmed.ref), seed: DOOR_SEED });
  assertRefused(self, 'the door\'s own key on the confirmed ref', [s.confirmedText]);
  await assertNothingWritten(store, before, refs, 'wrong signers');
});

test('refused: unknown ref and wrong signer carry the identical error, so neither says whether the ref exists', async () => {
  const store = recordingStore();
  const entry = makeDoor(store);
  const s = await seed(store);
  await assertAnswersPartyB(entry, s.undecided.ref);
  const unknownByOwner = await send(entry, { text: trackText('no-such-ref') });
  const unknownByStranger = await send(entry, { text: trackText('no-such-ref'), seed: STRANGER_SEED });
  const undecidedByStranger = await send(entry, { text: trackText(s.undecided.ref), seed: STRANGER_SEED });
  const decidedByStranger = await send(entry, { text: trackText(s.confirmed.ref), seed: STRANGER_SEED });
  for (const k of [unknownByOwner, unknownByStranger, undecidedByStranger, decidedByStranger]) assertRefused(k, k.text);
  const want = errorOf(unknownByOwner);
  assert.deepEqual(errorOf(unknownByStranger), want, 'unknown ref, either signer: the same error');
  assert.deepEqual(errorOf(undecidedByStranger), want, 'wrong signer on an undecided ref: the unknown-ref error');
  assert.deepEqual(errorOf(decidedByStranger), want, 'wrong signer on a decided ref: the unknown-ref error');
});

test('refused: the anonymous lane, on an existing and an unknown ref alike, nothing written', async () => {
  const store = recordingStore();
  const entry = makeDoor(store, { anonymousLane: true });
  const s = await seed(store);
  await assertAnswersPartyB(entry, s.undecided.ref);
  const refs = [s.undecided.ref, s.confirmed.ref, s.declined.ref];
  const before = await snapshot(store, refs);
  const errors = [];
  for (const ref of [s.undecided.ref, s.confirmed.ref, s.declined.ref, 'no-such-ref']) {
    const k = await send(entry, { text: trackText(ref), signed: false });
    assertRefused(k, `anonymous on ${ref}`, [CUSTOMER, s.confirmedText, s.declinedText, s.undecided.pendingText, DECLINE_NOTE]);
    errors.push(errorOf(k));
  }
  for (const e of errors.slice(1)) assert.deepEqual(e, errors[0], 'the anonymous refusal does not vary with the ref');
  await assertNothingWritten(store, before, refs, 'the anonymous lane');
});

test('refused: every other text shape, -32602, nothing written', async () => {
  const store = recordingStore();
  const entry = makeDoor(store);
  const s = await seed(store);
  await assertAnswersPartyB(entry, s.undecided.ref);
  const refs = [s.undecided.ref, s.confirmed.ref, s.declined.ref];
  const before = await snapshot(store, refs);
  const ref = s.confirmed.ref;
  const cases = [
    ['bare ref', ref],
    ['bare ref after words', `track ${ref}`],
    ['JSON without ref', JSON.stringify({ id: ref })],
    ['empty object', '{}'],
    ['ref a number', '{"ref": 101}'],
    ['ref null', '{"ref": null}'],
    ['ref an array', JSON.stringify({ ref: [ref] })],
    ['ref an object', JSON.stringify({ ref: { ref } })],
    ['ref true', '{"ref": true}'],
    ['empty ref', '{"ref": ""}'],
    ['malformed JSON', `{"ref": ${JSON.stringify(ref)}`],
    ['malformed JSON after words', `track {"ref": ${JSON.stringify(ref)},}`],
    ['a JSON array', JSON.stringify([{ ref }])],
    ['a JSON string', JSON.stringify(ref)],
  ];
  for (const [label, text] of cases) {
    const k = await send(entry, { text });
    assertRefused(k, label, [s.confirmedText, JSON.parse(s.confirmedText).deal.sigA]);
  }
  await assertNothingWritten(store, before, refs, 'other shapes');
});
