#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Quote terms on a confirmed reply: the door signs a priced acceptance of a quote.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). Mac A ruling 20261108T120925Z, intake
// 20261108T211317Z, whole item. The implementer may not edit this file. Run it as
// `node conformance/quote-terms.mjs`.
//
// The interface this file pins (the requirement left the spelling to the test author):
//   - confirmReceipt(seedHex, receiptText, terms?) -- terms is the third argument. Without it the
//     bytes are what they are today. With it, on a pending `quote` reply, the confirmed reply carries
//     a top-level `terms` key holding the object exactly as given:
//       { price, currency, leadTime, validUntil, note? }
//     price      a decimal string ("120.00", "45"); never a JSON number, no sign, no exponent;
//     currency   three upper-case letters (ISO 4217 shape);
//     leadTime   an ISO 8601 duration ("P3D", "PT48H", "P2W", "P1DT12H");
//     validUntil an ISO 8601 date-time with a zone (Z or +hh:mm), strictly after the decision's
//                deal.ts (the decision time, which is never before the hold's ts);
//     note       optional, a string of at most 500 characters, no control character (the decline
//                note's rule).
//     No other key. Every key but note is required.
//   - The terms are committed by what the door signs: how is the implementer's (a new signed deal
//     field, say), but the deal keeps the pending termsHash, partyA, partyB, ref and contextId, so it
//     still chains to the receipt the visitor holds; the existing fields keep their meaning.
//   - checkDecision (through knockAgentEntry and `knock --offer track`) accepts terms only on a
//     confirmed quote decision whose terms the door signed; a terms field altered, added or removed
//     after signing, terms pasted onto a hold or a decline, are refused and never reported.
//   - `agent-entry decide <ref> approve --terms <file.json> --store <file>` reads the terms object
//     from a JSON file; `--note` alone stays decline-only; `--terms` goes with approve only.
//   - The track answer and the visitor's booking carry the terms exactly as signed.
//   - README.md and spec/v1.md describe the terms object; CHANGELOG's newest section records it and
//     the 1.13.0 follow-up line naming negotiation on quote as not built is gone.
// Refusals from confirmReceipt throw a TypeError whose message names the field or the cause.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const {
  AGENT_CARD_PATH, canonicalBytes, confirmReceipt, createAgentEntry, createFileStore, createMemoryStore,
  declineReceipt, didFromSeedHex, knockAgentEntry, signBytes, signEnvelope,
} = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'muretai-agent-entry.mjs');
const NO_DIAL = pathToFileURL(join(HERE, 'fixtures', 'cli', 'no-dial.mjs')).href;
const FIXED_CLOCK = pathToFileURL(join(HERE, 'fixtures', 'cli', 'fixed-clock.mjs')).href;
const LOOPBACK = pathToFileURL(join(HERE, 'fixtures', 'cli', 'loopback-only.mjs')).href;

const SHOP_SEED = '3d'.repeat(32);
const CUSTOMER_SEED = '6c'.repeat(32);
const STRANGER_SEED = '7e'.repeat(32);
const SHOP_DID = didFromSeedHex(SHOP_SEED);
const CUSTOMER_DID = didFromSeedHex(CUSTOMER_SEED);
const SHOP_BASE = 'https://repair.example';
const QUOTE_TEXT = 'quote repair {"item":"desk lamp","problem":"flickers when warm"}';
const HOLD_TEXT = 'hold item {"id":101}';
const REPLY_KEYS = ['customer_did', 'deal', 'of', 'request', 'status', 'verb'];

const DECLARATION = {
  v: 1,
  entry: { name: 'Bench Repair', baseUrl: SHOP_BASE },
  offers: [
    { verb: 'quote', of: 'repair', about: 'Get a price for a repair before you commit.',
      input: { item: 'string', problem: 'string' }, door: { reply: 'pending' } },
    { verb: 'hold', of: 'item', about: 'Hold one item for pickup; the shop confirms it.',
      input: { id: 'integer' }, door: { reply: 'pending' } },
    { verb: 'book', of: 'repair', about: 'Request a repair slot.',
      input: { item: 'string', when: 'string' }, door: { reply: 'pending' } },
  ],
};

const scratch = [];
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const sortedKeys = (o) => Object.keys(o).sort();
const nowS = () => Math.floor(Date.now() / 1000);
const isoAt = (epochS) => new Date(epochS * 1000).toISOString().replace(/\.000Z$/, 'Z');

/** Run `fn` with Date.now answering `ms`. */
function atClock(ms, fn) {
  const realNow = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = realNow; }
}

// ---------------------------------------------------------------- pinned pending texts

const VECTOR_TS = 1760000000; // 2025-10-09T08:53:20Z
const VECTOR_SALT = Buffer.alloc(16, 0x2b).toString('base64');
const FIXED_S = VECTOR_TS + 3600; // the decision second at the fixed clock
const FIXED_MS = FIXED_S * 1000;

/** A pending reply as the door signs one, from fixed parts. */
function pinnedPending({ seed = SHOP_SEED, verb = 'quote', of = 'repair', request = QUOTE_TEXT, ref = `vector-${verb}-1` } = {}) {
  const terms = { verb, of, customer_did: CUSTOMER_DID, request, status: 'pending_confirmation' };
  const termsHash = createHash('sha256')
    .update(Buffer.concat([canonicalBytes({ terms }), Buffer.from(VECTOR_SALT, 'base64')])).digest('hex');
  const signed = { type: 'DealReceipt', partyA: didFromSeedHex(seed), partyB: CUSTOMER_DID, termsHash,
    contextId: null, ref, ts: VECTOR_TS };
  const deal = { ...signed, salt: VECTOR_SALT, sigA: signBytes(seed, canonicalBytes(signed)).toString('base64') };
  return JSON.stringify({ ...terms, deal });
}

const QUOTE_PENDING = pinnedPending();
const HOLD_PENDING = pinnedPending({ verb: 'hold', of: 'item', request: HOLD_TEXT });
const BOOK_PENDING = pinnedPending({ verb: 'book', of: 'repair', request: 'book repair {"item":"lamp","when":"Friday"}' });

/** Terms valid at the fixed clock: a week after the decision second. */
const TERMS = Object.freeze({
  price: '120.00',
  currency: 'EUR',
  leadTime: 'P3D',
  validUntil: isoAt(FIXED_S + 7 * 86400),
  note: 'Parts in stock. Drop it off any weekday.',
});
const TERMS_NO_NOTE = Object.freeze((({ note, ...rest }) => rest)(TERMS));

function confirmWith(pending, terms, ms = FIXED_MS) {
  return atClock(ms, () => confirmReceipt(SHOP_SEED, pending, terms));
}

/** confirmReceipt with terms refuses: it throws, and the message names `cause`. */
function assertTermsRefused(pending, terms, cause, what, { ms = FIXED_MS, seed = SHOP_SEED } = {}) {
  let thrown = null;
  let out;
  try { out = atClock(ms, () => confirmReceipt(seed, pending, terms)); } catch (e) { thrown = e; }
  assert.ok(thrown, `${what} is refused, not confirmed: ${String(out).slice(0, 300)}`);
  assert.ok(thrown instanceof TypeError, `${what}: a TypeError, not ${thrown?.constructor?.name}: ${thrown?.message}`);
  assert.match(String(thrown.message), cause, `${what}: the refusal names its cause: ${thrown.message}`);
  assert.ok(!String(thrown.message).includes(SHOP_SEED), `${what}: the seed is never in the message`);
}

/** The confirmed quote reply `text` carries `terms` exactly and still chains to `pendingText`. */
function assertConfirmedWithTerms(text, pendingText, terms) {
  const out = JSON.parse(text);
  const pending = JSON.parse(pendingText);
  assert.equal(out.status, 'confirmed', 'the follow-up reads confirmed');
  assert.deepEqual(sortedKeys(out), [...REPLY_KEYS, 'terms'].sort(), 'confirmReceipt\'s fields and terms, nothing else');
  for (const k of ['verb', 'of', 'customer_did', 'request']) assert.equal(out[k], pending[k], `keeps the receipt's ${k}`);
  for (const k of ['type', 'partyA', 'partyB', 'termsHash', 'salt', 'ref', 'contextId']) {
    assert.equal(out.deal[k], pending.deal[k], `the deal keeps the receipt's ${k}: the existing fields keep their meaning`);
  }
  assert.ok(Number.isSafeInteger(out.deal.ts) && out.deal.ts >= pending.deal.ts, 'a fresh ts, never before the hold\'s');
  assert.equal(typeof out.deal.sigA, 'string', 'the deal is signed');
  assert.deepEqual(out.terms, { ...terms }, 'the terms exactly as given');
  if (!Object.hasOwn(terms, 'note')) assert.ok(!Object.hasOwn(out.terms, 'note'), 'no note given: no note key');
}

// ================================================================ confirmReceipt with terms: functional

test('fixture: the pinned quote pending text is one confirmReceipt accepts without terms', () => {
  const out = JSON.parse(confirmWith(QUOTE_PENDING, undefined));
  assert.equal(out.status, 'confirmed');
  assert.equal(out.verb, 'quote');
});

test('without terms, confirmReceipt\'s bytes are unchanged: no terms key, the same text as the two-argument call', () => {
  const two = atClock(FIXED_MS, () => confirmReceipt(SHOP_SEED, QUOTE_PENDING));
  const three = confirmWith(QUOTE_PENDING, undefined);
  assert.equal(three, two, 'an undefined third argument is the two-argument call');
  assert.deepEqual(sortedKeys(JSON.parse(two)), REPLY_KEYS, 'no terms key without terms');
});

test('a confirmed quote with terms carries them exactly, on the receipt\'s termsHash', () => {
  const text = confirmWith(QUOTE_PENDING, TERMS);
  assert.equal(typeof text, 'string', 'confirmReceipt returns the follow-up text');
  assertConfirmedWithTerms(text, QUOTE_PENDING, TERMS);
  assert.equal(JSON.parse(text).deal.ts, FIXED_S, 'the decision second is the clock\'s');
});

test('the note is optional: without it there is no note key in terms', () => {
  assertConfirmedWithTerms(confirmWith(QUOTE_PENDING, TERMS_NO_NOTE), QUOTE_PENDING, TERMS_NO_NOTE);
});

test('the terms are committed: the same reply with other terms is a different signed decision', () => {
  const a = JSON.parse(confirmWith(QUOTE_PENDING, TERMS));
  const b = JSON.parse(confirmWith(QUOTE_PENDING, { ...TERMS, price: '12.00' }));
  const plain = JSON.parse(confirmWith(QUOTE_PENDING, undefined));
  assert.notDeepEqual(a.deal, b.deal, 'another price changes what the door signed');
  assert.notDeepEqual(a.deal, plain.deal, 'a priced acceptance is not the plain confirmation\'s deal');
});

test('deterministic: one clock and one set of terms give one text', () => {
  assert.equal(confirmWith(QUOTE_PENDING, TERMS), confirmWith(QUOTE_PENDING, TERMS));
});

test('accepted spellings: prices, currencies, durations, zones, a 500-character note, non-ASCII words', () => {
  const ok = [
    { price: '45' }, { price: '0.50' }, { price: '1999.9' }, { price: '0' },
    { currency: 'JPY' }, { currency: 'USD' },
    { leadTime: 'PT48H' }, { leadTime: 'P2W' }, { leadTime: 'P1DT12H' }, { leadTime: 'P1M' }, { leadTime: 'PT30M' },
    { validUntil: isoAt(FIXED_S + 1) },
    { validUntil: '2025-10-17T03:00:00+09:00' },
    { note: 'n'.repeat(500) },
    { note: 'Pièces en stock. 部品は在庫あり。' },
  ];
  for (const change of ok) {
    const terms = { ...TERMS, ...change };
    assertConfirmedWithTerms(confirmWith(QUOTE_PENDING, terms), QUOTE_PENDING, terms);
  }
});

test('validUntil is compared with the decision time, which never runs before the hold\'s ts', () => {
  const behind = (VECTOR_TS - 600) * 1000;
  const terms = { ...TERMS, validUntil: isoAt(VECTOR_TS + 1) };
  const out = JSON.parse(confirmWith(QUOTE_PENDING, terms, behind));
  assert.equal(out.deal.ts, VECTOR_TS, 'the decision ts is the hold\'s on a clock behind it');
  assert.deepEqual(out.terms, terms);
});

test('a quote the door issued live: confirmed with terms, chained to the customer\'s receipt', async () => {
  const entry = makeDoor(createMemoryStore());
  const { replyText } = await knockOffer(entry, 'quote', QUOTE_TEXT);
  const terms = { ...TERMS, validUntil: isoAt(nowS() + 30 * 86400) };
  assertConfirmedWithTerms(confirmReceipt(SHOP_SEED, replyText, terms), replyText, terms);
});

// ================================================================ confirmReceipt with terms: refusals

test('refused: terms on a non-quote verb (hold, book)', () => {
  assertTermsRefused(HOLD_PENDING, TERMS, /quote/i, 'terms on a hold');
  assertTermsRefused(BOOK_PENDING, TERMS, /quote/i, 'terms on a book');
});

test('refused: a float or number price, and price strings that are not plain decimals', () => {
  for (const bad of [120.5, 120, 0, '-5', '+5', '1e3', '12.', '.5', ' 12', '12 ', '', 'NaN', 'Infinity', '0x10',
    '1,200.00', '12.0.0', '１２']) {
    assertTermsRefused(QUOTE_PENDING, { ...TERMS, price: bad }, /price/i, `price ${JSON.stringify(bad)}`);
  }
});

test('refused: a currency that is lower-case, mixed-case, or not three letters', () => {
  for (const bad of ['eur', 'Eur', 'EU', 'EURO', '', 'E1R', 978, ' EUR', 'ＥＵＲ']) {
    assertTermsRefused(QUOTE_PENDING, { ...TERMS, currency: bad }, /currency/i, `currency ${JSON.stringify(bad)}`);
  }
});

test('refused: a leadTime that is not an ISO 8601 duration', () => {
  for (const bad of ['3 days', 'P', 'PT', 'P1DT', '3D', '', 'p3d', 'P-3D', 3, 'P3D ']) {
    assertTermsRefused(QUOTE_PENDING, { ...TERMS, leadTime: bad }, /lead ?time/i, `leadTime ${JSON.stringify(bad)}`);
  }
});

test('refused: a validUntil that is not a zoned ISO 8601 date-time', () => {
  for (const bad of ['2025-10-16', 'tomorrow', FIXED_S + 86400, '2025-13-01T00:00:00Z', '2025-10-16T09:53:20',
    '2025-10-32T00:00:00Z', '', '2025-10-16T25:00:00Z']) {
    assertTermsRefused(QUOTE_PENDING, { ...TERMS, validUntil: bad }, /valid ?until/i, `validUntil ${JSON.stringify(bad)}`);
  }
});

test('refused: a validUntil in the past, or not strictly after the decision time', () => {
  assertTermsRefused(QUOTE_PENDING, { ...TERMS, validUntil: isoAt(FIXED_S - 86400) }, /valid ?until/i, 'a day ago');
  assertTermsRefused(QUOTE_PENDING, { ...TERMS, validUntil: isoAt(FIXED_S - 1) }, /valid ?until/i, 'a second ago');
  assertTermsRefused(QUOTE_PENDING, { ...TERMS, validUntil: isoAt(FIXED_S) }, /valid ?until/i, 'the decision second itself');
  assertTermsRefused(QUOTE_PENDING, { ...TERMS, validUntil: isoAt(VECTOR_TS - 1) }, /valid ?until/i,
    'before the hold, on a clock behind it', { ms: (VECTOR_TS - 600) * 1000 });
});

test('refused: an oversized note, a note with a control character, a note that is not a string', () => {
  assertTermsRefused(QUOTE_PENDING, { ...TERMS, note: 'n'.repeat(501) }, /note/i, 'a 501-character note');
  for (const [name, ch] of [['newline', '\n'], ['tab', '\t'], ['NUL', '\u0000'], ['DEL', '\u007f'], ['escape', '\u001b']]) {
    assertTermsRefused(QUOTE_PENDING, { ...TERMS, note: `In stock.${ch}Friday.` }, /note/i, `a note with ${name}`);
  }
  for (const bad of [42, null, ['x'], { text: 'x' }]) {
    assertTermsRefused(QUOTE_PENDING, { ...TERMS, note: bad }, /note/i, `a note of ${JSON.stringify(bad)}`);
  }
});

test('refused: a missing required field, each named', () => {
  for (const [key, cause] of [['price', /price/i], ['currency', /currency/i], ['leadTime', /lead ?time/i],
    ['validUntil', /valid ?until/i]]) {
    const terms = { ...TERMS };
    delete terms[key];
    assertTermsRefused(QUOTE_PENDING, terms, cause, `terms without ${key}`);
  }
});

test('refused: terms that are not a plain object, or that carry an unknown key', () => {
  for (const bad of [null, 'price 120', ['120.00', 'EUR'], 42, true]) {
    assertTermsRefused(QUOTE_PENDING, bad, /terms/i, `terms of ${JSON.stringify(bad)}`);
  }
  assertTermsRefused(QUOTE_PENDING, { ...TERMS, discount: '10' }, /terms|discount|key/i, 'an unknown key');
  assertTermsRefused(QUOTE_PENDING, JSON.parse(`{"price":"1","currency":"EUR","leadTime":"P1D","validUntil":"${TERMS.validUntil}","__proto__":{"x":1}}`),
    /terms|__proto__|key/i, 'a __proto__ key');
});

test('the door\'s signature is checked FIRST: another key\'s receipt with bad terms is refused as not signed', () => {
  assertTermsRefused(pinnedPending({ seed: STRANGER_SEED }), { ...TERMS, price: 1.5 }, /sign/i,
    'another door\'s receipt with a float price');
});

test('refused: terms on a reply that is not pending (already confirmed)', () => {
  const confirmed = confirmWith(QUOTE_PENDING, undefined);
  assertTermsRefused(confirmed, TERMS, /pending/i, 'a confirmed reply');
});

test('declineReceipt takes no terms: its third argument stays the note, a terms object is refused as a note', () => {
  let thrown = null;
  try { atClock(FIXED_MS, () => declineReceipt(SHOP_SEED, QUOTE_PENDING, TERMS)); } catch (e) { thrown = e; }
  assert.ok(thrown, 'a terms object as the decline note is refused');
  assert.match(String(thrown.message), /note/i);
});

// ================================================================ the shop's door and the visitor

function makeDoor(store, baseUrl = SHOP_BASE) {
  const declaration = clone(DECLARATION);
  declaration.entry.baseUrl = baseUrl;
  return createAgentEntry({ seedHex: SHOP_SEED, name: declaration.entry.name, baseUrl, declaration,
    signedRatePerMin: 0, signedRatePerMinTotal: 0, store });
}

const fetchVia = (entry) => async (url, init = {}) => {
  const u = new URL(url);
  const out = await entry.handleRequestAsync(init.method || 'GET', u.pathname + u.search, init.headers || {},
    Buffer.from(init.body || ''), { remoteAddress: '127.0.0.1' });
  return new Response(out.body, { status: out.status, headers: out.headers });
};

let sequence = 0;
/** One signed knock for `offer` at `entry`, in process: the pending reply exactly as the door signed it. */
async function knockOffer(entry, offer, text, seed = CUSTOMER_SEED) {
  const from = didFromSeedHex(seed);
  const messageId = `quote-terms-${offer}-${++sequence}-${process.pid}`;
  const timestamp = nowS();
  const sig = signEnvelope(seed, { from, to: entry.did, messageId, contextId: null, timestamp, text });
  const body = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
      metadata: { from, to: entry.did, timestamp, sig, offer } } },
  }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
    { remoteAddress: '127.0.0.1' });
  const replyText = JSON.parse(Buffer.from(out.body).toString('utf8')).result.parts[0].text;
  const reply = JSON.parse(replyText);
  assert.equal(reply.status, 'pending_confirmation', `fixture: the door answers the ${offer} pending: ${replyText.slice(0, 300)}`);
  return { replyText, reply, ref: reply.deal.ref };
}

/** Put `text` on `ref`'s row as the stored decision. */
async function putDecision(store, ref, status, text) {
  const row = clone(await store.getReceipt(ref));
  row.decision = { status, text, decided_ts: nowS() };
  await store.putReceipt(ref, row);
}

const liveTerms = () => ({ ...TERMS, validUntil: isoAt(nowS() + 30 * 86400) });

const visitor = { keyPath: null };
before(() => {
  visitor.keyPath = join(tmp('ae-quote-terms-key-'), 'knock-seed');
  writeFileSync(visitor.keyPath, `${CUSTOMER_SEED}\n`, { mode: 0o600 });
});
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

async function collect(entry, ref) {
  return knockAgentEntry(`${SHOP_BASE}${AGENT_CARD_PATH}`,
    { keyPath: visitor.keyPath, offer: 'track', text: JSON.stringify({ ref }), fetchImpl: fetchVia(entry) });
}

/** A confirmed quote with `terms`, stored on its row at a fresh door: { entry, store, ref, pendingText, text }. */
async function quotedDoor(terms = liveTerms()) {
  const store = createMemoryStore();
  const entry = makeDoor(store);
  const q = await knockOffer(entry, 'quote', QUOTE_TEXT);
  const text = confirmReceipt(SHOP_SEED, q.replyText, terms);
  await putDecision(store, q.ref, 'confirmed', text);
  return { entry, store, ref: q.ref, pendingText: q.replyText, text, terms };
}

test('the visitor collects a priced acceptance: verified, read as its booking, the terms exactly as signed', async () => {
  const q = await quotedDoor();
  const result = await collect(q.entry, q.ref);
  assert.ok(result.ok, `the visitor's knock verifies the shop's answer: ${JSON.stringify(result).slice(0, 400)}`);
  assert.equal(result.reply?.result?.parts?.[0]?.text, q.text, 'the door answers track with the decision verbatim');
  assert.ok(result.booking, `checkedBookingReceipt reads a booking: ${String(result.text).slice(0, 300)}`);
  assert.equal(result.booking.status, 'confirmed');
  assert.equal(result.booking.verb, 'quote');
  assert.deepEqual(result.booking.terms, q.terms, 'the booking carries the terms exactly as signed');
  assert.equal(result.booking.deal?.termsHash, JSON.parse(q.pendingText).deal.termsHash, 'on the receipt\'s termsHash');
  assert.deepEqual(JSON.parse(result.text).terms, q.terms, 'the checked text carries the terms too');
});

test('a priced acceptance without a note reads back without a note', async () => {
  const { note, ...terms } = liveTerms();
  const q = await quotedDoor(terms);
  const result = await collect(q.entry, q.ref);
  assert.ok(result.ok && result.booking, `collected: ${JSON.stringify(result).slice(0, 300)}`);
  assert.deepEqual(result.booking.terms, terms);
});

test('a plain confirmation of a quote (no terms) still reads as a booking with no terms key', async () => {
  const store = createMemoryStore();
  const entry = makeDoor(store);
  const q = await knockOffer(entry, 'quote', QUOTE_TEXT);
  await putDecision(store, q.ref, 'confirmed', confirmReceipt(SHOP_SEED, q.replyText));
  const result = await collect(entry, q.ref);
  assert.ok(result.ok && result.booking, `collected: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(!Object.hasOwn(result.booking, 'terms'), 'no terms invented');
});

/** The forged decision (a real one, edited) is never reported as a booking. */
async function assertForgeryRefused(label, { verb = 'quote', status = 'confirmed', edit }) {
  const store = createMemoryStore();
  const entry = makeDoor(store);
  const q = verb === 'quote' ? await knockOffer(entry, 'quote', QUOTE_TEXT) : await knockOffer(entry, 'hold', HOLD_TEXT);
  const terms = liveTerms();
  let real;
  if (status === 'declined') real = JSON.parse(declineReceipt(SHOP_SEED, q.replyText, 'Too busy this month.'));
  else if (verb === 'quote') real = JSON.parse(confirmReceipt(SHOP_SEED, q.replyText, terms));
  else real = JSON.parse(confirmReceipt(SHOP_SEED, q.replyText));
  const v = clone(real);
  edit(v, terms);
  const text = JSON.stringify(v);
  await putDecision(store, q.ref, status, text);
  let result = null;
  let error = null;
  try { result = await collect(entry, q.ref); } catch (e) { error = e; }
  assert.ok(error !== null || result?.ok !== true, `${label}: the knock refuses it: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(!result?.booking, `${label}: no booking is reported`);
}

const FORGERIES = [
  ['price altered after signing', { edit: (v) => { v.terms.price = '12.00'; } }],
  ['currency altered after signing', { edit: (v) => { v.terms.currency = 'JPY'; } }],
  ['validUntil altered after signing', { edit: (v) => { v.terms.validUntil = isoAt(nowS() + 365 * 86400); } }],
  ['leadTime altered after signing', { edit: (v) => { v.terms.leadTime = 'P1D'; } }],
  ['note altered after signing', { edit: (v) => { v.terms.note = 'Free of charge.'; } }],
  ['note removed after signing', { edit: (v) => { delete v.terms.note; } }],
  ['a key added to the terms after signing', { edit: (v) => { v.terms.discount = '100'; } }],
  ['the terms removed after signing', { edit: (v) => { delete v.terms; } }],
  ['price turned into a number after signing', { edit: (v) => { v.terms.price = 120; } }],
  ['currency lower-cased after signing', { edit: (v) => { v.terms.currency = v.terms.currency.toLowerCase(); } }],
  ['terms pasted onto a confirmed hold', { verb: 'hold', edit: (v, t) => { v.terms = t; } }],
  ['terms pasted onto a declined quote', { status: 'declined', edit: (v, t) => { v.terms = t; } }],
  ['terms of the wrong kind on a confirmed quote', { edit: (v) => { v.terms = ['120.00', 'EUR']; } }],
];

for (const [label, spec] of FORGERIES) {
  test(`refused by checkDecision: ${label}`, async () => {
    await assertForgeryRefused(label, spec);
  });
}

test('control: the same door reads the unedited priced acceptance as a booking', async () => {
  const q = await quotedDoor();
  const result = await collect(q.entry, q.ref);
  assert.ok(result.ok && result.booking, `the real decision is a booking: ${JSON.stringify(result).slice(0, 300)}`);
});

// ================================================================ the CLI: decide <ref> approve --terms <file>

const cli = { project: null, home: null };
before(() => {
  cli.home = tmp('ae-quote-terms-home-');
  cli.project = tmp('ae-quote-terms-shop-');
  writeFileSync(join(cli.project, 'agent-entry.json'), `${JSON.stringify(DECLARATION, null, 2)}\n`);
});

function runDecide(args, { fixedNowMs = null } = {}) {
  const log = join(tmp('ae-quote-terms-dial-'), 'dial.jsonl');
  const env = { HOME: cli.home, AE_NO_DIAL_LOG: log, AGENT_ENTRY_SEED_HEX: SHOP_SEED };
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k];
  if (fixedNowMs !== null) env.AE_FIXED_NOW_MS = String(fixedNowMs);
  const imports = ['--import', NO_DIAL, ...(fixedNowMs !== null ? ['--import', FIXED_CLOCK] : [])];
  const run = spawnSync(process.execPath, [...imports, BIN, 'decide', ...args],
    { cwd: cli.project, env, encoding: 'utf8', timeout: 60000 });
  let dial = [];
  try { dial = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
  return { code: run.status, stdout: run.stdout || '', stderr: run.stderr || '', dial, timedOut: run.error?.code === 'ETIMEDOUT' };
}

const said = (run) => `exit ${run.code}; stdout ${JSON.stringify(run.stdout.slice(0, 400))}; stderr ${JSON.stringify(run.stderr.slice(0, 400))}`;

function assertNeverDialled(run, what) {
  assert.ok(!run.timedOut, `${what}: timed out`);
  assert.ok(run.dial.some((r) => r.kind === 'loaded'), `${what}: the no-dial guard did not load`);
  assert.deepEqual(run.dial.filter((r) => r.kind !== 'loaded'), [], `${what}: tried to reach the network`);
}

/** A refusal: non-zero (`codes`), nothing on stdout, the cause named, the store byte for byte. */
function assertCliRefused(run, { storePath, before: bytes, cause, what, codes = [1] }) {
  assertNeverDialled(run, what);
  assert.ok(codes.includes(run.code), `${what} is refused with exit ${codes.join(' or ')}: ${said(run)}`);
  assert.equal(run.stdout.trim(), '', `${what}: nothing printed: ${said(run)}`);
  if (cause) assert.match(run.stderr, cause, `${what}: the refusal names its cause: ${said(run)}`);
  assert.ok(!`${run.stdout}${run.stderr}`.includes(SHOP_SEED), `${what}: the seed is never printed`);
  assert.equal(readFileSync(storePath, 'utf8'), bytes, `${what}: nothing is written to the store`);
}

/** A fresh file store with one undecided quote and one undecided hold the door issued. */
async function cliStore() {
  const storePath = join(tmp('ae-quote-terms-store-'), 'state.json');
  const entry = makeDoor(createFileStore(storePath));
  const quote = await knockOffer(entry, 'quote', QUOTE_TEXT);
  const hold = await knockOffer(entry, 'hold', HOLD_TEXT);
  return { storePath, quote, hold };
}

function termsFile(value) {
  const path = join(tmp('ae-quote-terms-file-'), 'terms.json');
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

test('decide <ref> approve --terms <file>: stores the priced acceptance, prints it, byte for byte confirmReceipt\'s', async () => {
  const { storePath, quote } = await cliStore();
  const fixedNowMs = (nowS() + 5) * 1000;
  const terms = { ...TERMS, validUntil: isoAt(fixedNowMs / 1000 + 14 * 86400) };
  const run = runDecide([quote.ref, 'approve', '--terms', termsFile(terms), '--store', storePath], { fixedNowMs });
  assertNeverDialled(run, 'decide approve --terms');
  assert.equal(run.code, 0, `decide approve --terms succeeds: ${said(run)}`);
  const row = await createFileStore(storePath).getReceipt(quote.ref);
  assert.equal(row?.decision?.status, 'confirmed', `the decision is stored: ${JSON.stringify(row).slice(0, 300)}`);
  assertConfirmedWithTerms(row.decision.text, quote.replyText, terms);
  const expected = atClock(fixedNowMs, () => confirmReceipt(SHOP_SEED, quote.replyText, terms));
  assert.equal(row.decision.text, expected, 'the stored text is confirmReceipt(seed, pending_text, terms)');
  assert.ok(run.stdout.includes(row.decision.text), `the follow-up text is printed: ${said(run)}`);
});

test('decide <ref> approve without --terms on a quote is today\'s plain confirmation', async () => {
  const { storePath, quote } = await cliStore();
  const run = runDecide([quote.ref, 'approve', '--store', storePath]);
  assert.equal(run.code, 0, said(run));
  const text = (await createFileStore(storePath).getReceipt(quote.ref)).decision.text;
  assert.ok(!Object.hasOwn(JSON.parse(text), 'terms'), 'no terms key');
});

test('decide --help documents --terms', () => {
  const run = spawnSync(process.execPath, ['--import', NO_DIAL, BIN, 'decide', '--help'],
    { cwd: cli.project, env: { ...process.env, HOME: cli.home, AE_NO_DIAL_LOG: join(tmp('ae-qt-help-'), 'd.jsonl') }, encoding: 'utf8' });
  assert.equal(run.status, 0, `decide --help: ${run.stderr}`);
  assert.match(run.stdout, /--terms/, 'the usage names --terms');
});

test('refused by the CLI: --terms on a hold ref', async () => {
  const { storePath, hold } = await cliStore();
  const before = readFileSync(storePath, 'utf8');
  assertCliRefused(runDecide([hold.ref, 'approve', '--terms', termsFile(liveTerms()), '--store', storePath]),
    { storePath, before, cause: /quote/i, what: '--terms on a hold' });
});

test('refused by the CLI: --terms with decline', async () => {
  const { storePath, quote } = await cliStore();
  const before = readFileSync(storePath, 'utf8');
  assertCliRefused(runDecide([quote.ref, 'decline', '--terms', termsFile(liveTerms()), '--store', storePath]),
    { storePath, before, cause: /terms/i, what: '--terms with decline', codes: [1, 2] });
});

test('refused by the CLI: --note stays decline-only, with or without --terms', async () => {
  const { storePath, quote } = await cliStore();
  const before = readFileSync(storePath, 'utf8');
  assertCliRefused(runDecide([quote.ref, 'approve', '--note', 'In stock.', '--store', storePath]),
    { storePath, before, cause: /note/i, what: '--note with approve', codes: [2] });
  assertCliRefused(runDecide([quote.ref, 'approve', '--note', 'In stock.', '--terms', termsFile(liveTerms()), '--store', storePath]),
    { storePath, before, cause: /note/i, what: '--note beside --terms', codes: [1, 2] });
});

test('refused by the CLI: a malformed terms file, each cause named', async () => {
  const { storePath, quote } = await cliStore();
  const before = readFileSync(storePath, 'utf8');
  const cases = [
    ['a float price', { ...liveTerms(), price: 120.5 }, /price/i],
    ['a lower-case currency', { ...liveTerms(), currency: 'eur' }, /currency/i],
    ['a four-letter currency', { ...liveTerms(), currency: 'EURO' }, /currency/i],
    ['a validUntil in the past', { ...liveTerms(), validUntil: isoAt(nowS() - 86400) }, /valid ?until/i],
    ['a 501-character note', { ...liveTerms(), note: 'n'.repeat(501) }, /note/i],
    ['a leadTime that is not a duration', { ...liveTerms(), leadTime: 'three days' }, /lead ?time/i],
    ['a file that is not JSON', '{"price": "1",', /JSON|terms/i],
    ['a JSON array', ['120.00', 'EUR'], /terms/i],
  ];
  for (const [what, value, cause] of cases) {
    assertCliRefused(runDecide([quote.ref, 'approve', '--terms', termsFile(value), '--store', storePath]),
      { storePath, before, cause, what });
  }
  assertCliRefused(runDecide([quote.ref, 'approve', '--terms', join(tmp('ae-qt-missing-'), 'nope.json'), '--store', storePath]),
    { storePath, before, cause: /terms|no such|not found|read/i, what: 'a terms file that does not exist' });
});

test('refused by the CLI: a quote already approved is not re-priced by a second approve --terms', async () => {
  const { storePath, quote } = await cliStore();
  const first = runDecide([quote.ref, 'approve', '--terms', termsFile(liveTerms()), '--store', storePath]);
  assert.equal(first.code, 0, said(first));
  const bytes = readFileSync(storePath, 'utf8');
  const stored = (await createFileStore(storePath).getReceipt(quote.ref)).decision.text;
  const again = runDecide([quote.ref, 'approve', '--terms', termsFile({ ...liveTerms(), price: '1.00' }), '--store', storePath]);
  assert.ok(again.code === 0 || again.code === 1, `a second approve never crashes: ${said(again)}`);
  if (again.code === 0) assert.ok(again.stdout.includes(stored), 'exit 0 prints the stored decision, not a new price');
  assert.equal(readFileSync(storePath, 'utf8'), bytes, 'the stored terms are unchanged');
});

// ================================================================ the bin knock prints the terms

test('knock --offer track --ref <ref> prints the priced acceptance with its terms exactly as signed', async () => {
  const store = createMemoryStore();
  let entry = null;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const out = await entry.handleRequestAsync(req.method, req.url, req.headers, Buffer.concat(chunks),
          { remoteAddress: req.socket.remoteAddress });
        res.writeHead(out.status, out.headers || {});
        res.end(out.body || '');
      } catch (e) { res.writeHead(500); res.end(String(e?.message || e)); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    entry = makeDoor(store, origin);
    const q = await knockOffer(entry, 'quote', QUOTE_TEXT);
    const terms = liveTerms();
    const text = confirmReceipt(SHOP_SEED, q.replyText, terms);
    await putDecision(store, q.ref, 'confirmed', text);
    const log = join(tmp('ae-qt-guard-'), 'guard.jsonl');
    const env = { HOME: cli.home, AGENT_ENTRY_KNOCK_KEY: visitor.keyPath, AE_CLI_GUARD_LOG: log,
      AGENT_ENTRY_KNOCK_TEXT: 'hold item {"id":999}' };
    for (const k of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k];
    const run = await new Promise((resolveRun) => {
      const child = spawn(process.execPath, ['--import', LOOPBACK, BIN, 'knock', `${origin}${AGENT_CARD_PATH}`,
        '--offer', 'track', '--ref', q.ref], { cwd: cli.home, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
      child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
      child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
      child.on('close', (code) => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
    });
    assert.equal(run.code, 0, `the knock collects the decision: ${said(run)}`);
    const lines = run.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `one JSON document on stdout: ${said(run)}`);
    const printed = JSON.parse(lines[0]);
    assert.deepEqual(printed, JSON.parse(text), 'it prints the decision the door signed');
    assert.deepEqual(printed.terms, terms, 'the terms exactly as signed');
  } finally {
    await new Promise((r) => server.close(() => r()));
  }
});

// ================================================================ documentation

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('README describes the terms object on a confirmed quote', () => {
  const readme = read('README.md');
  for (const word of ['validUntil', 'leadTime', 'currency', '--terms']) {
    assert.ok(readme.includes(word), `README.md names ${word}`);
  }
});

test('spec/v1.md describes the terms object: its fields, quote only, committed by the deal', () => {
  const spec = read('spec/v1.md');
  for (const word of ['terms', 'price', 'currency', 'leadTime', 'validUntil', 'quote']) {
    assert.ok(spec.includes(word), `spec/v1.md names ${word}`);
  }
  assert.match(spec, /ISO 4217/, 'the currency rule is named');
  assert.match(spec, /ISO 8601/, 'the duration and date-time rules are named');
});

test('CHANGELOG records the quote terms and no longer lists negotiation on quote as not built', () => {
  const log = read('CHANGELOG.md');
  const newest = log.split(/\n## /)[1] || '';
  assert.match(newest, /quote/i, 'the newest section names quote');
  assert.match(newest, /validUntil|terms/, 'the newest section names the terms');
  assert.ok(!log.includes('- Negotiation on `quote` / `hold` (coordination turns, R9, after the pilot shop).'),
    'the not-built line naming quote is moved');
});
