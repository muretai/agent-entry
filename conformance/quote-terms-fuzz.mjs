#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Kind fuzz: the quote terms object, from the owner (confirmReceipt's third argument, the
// `decide --terms` file) and from the wire (the visitor reading a signed decision).
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). Mac A ruling 20261108T120925Z, intake
// 20261108T211317Z. The implementer may not edit this file. Run it as
// `node conformance/quote-terms-fuzz.mjs`.
//
// Property: round_trip -- for every generated terms value, confirmReceipt on a pending quote either
// throws a TypeError (never another error, never a crash) or returns a confirmed reply whose
// `terms` is deep-equal to the input; and every accepted terms object satisfies the pinned field
// shapes (price a plain decimal string, currency three upper-case letters, validUntil after the
// decision second, only the five known keys). Plus one invariant on the visitor side: a signed
// priced acceptance with one terms field changed to a generated value is never reported as a
// booking by the visitor's knock.
//
// Deterministic: a local seeded generator (mulberry32, fixed seed), a fake Date.now for the owner
// side, no network. A failure names the case index and the value, so it reproduces exactly.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const {
  AGENT_CARD_PATH, canonicalBytes, confirmReceipt, createAgentEntry, createMemoryStore, didFromSeedHex,
  knockAgentEntry, signBytes, signEnvelope,
} = door;

const FUZZ_SEED = 0x9a07e511;
const OWNER_CASES = 600;
const WIRE_CASES = 40;

const SHOP_SEED = '3d'.repeat(32);
const CUSTOMER_SEED = '6c'.repeat(32);
const CUSTOMER_DID = didFromSeedHex(CUSTOMER_SEED);
const SHOP_BASE = 'https://repair.example';
const QUOTE_TEXT = 'quote repair {"item":"desk lamp","problem":"flickers when warm"}';
const KNOWN = new Set(['price', 'currency', 'leadTime', 'validUntil', 'note']);

const VECTOR_TS = 1760000000;
const FIXED_S = VECTOR_TS + 3600;
const isoAt = (s) => new Date(s * 1000).toISOString().replace(/\.000Z$/, 'Z');

const scratch = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pinnedPending() {
  const salt = Buffer.alloc(16, 0x2b).toString('base64');
  const terms = { verb: 'quote', of: 'repair', customer_did: CUSTOMER_DID, request: QUOTE_TEXT, status: 'pending_confirmation' };
  const termsHash = createHash('sha256')
    .update(Buffer.concat([canonicalBytes({ terms }), Buffer.from(salt, 'base64')])).digest('hex');
  const signed = { type: 'DealReceipt', partyA: didFromSeedHex(SHOP_SEED), partyB: CUSTOMER_DID, termsHash,
    contextId: null, ref: 'fuzz-quote-1', ts: VECTOR_TS };
  return JSON.stringify({ ...terms, deal: { ...signed, salt, sigA: signBytes(SHOP_SEED, canonicalBytes(signed)).toString('base64') } });
}
const PENDING = pinnedPending();

// ---------------------------------------------------------------- the generator

const pick = (rand, s) => s[Math.floor(rand() * s.length)];
function randomString(rand) {
  const len = Math.floor(rand() * 12);
  let out = '';
  const kind = Math.floor(rand() * 4);
  for (let i = 0; i < len; i += 1) {
    if (kind === 0) out += String.fromCharCode(0x20 + Math.floor(rand() * 95));
    else if (kind === 1) out += String.fromCharCode(Math.floor(rand() * 0x20));
    else if (kind === 2) out += String.fromCodePoint(0x1f300 + Math.floor(rand() * 0x300));
    else out += String.fromCharCode(Math.floor(rand() * 0x10000));
  }
  return out;
}

const ODD = [null, true, false, 0, -1, 1.5, 1e21, NaN, [], {}, ['x'], { a: 1 }, '', ' ', '__proto__', 'constructor'];
const PRICES = ['120.00', '45', '0', '0.50', '1999.9', '-5', '1e3', '12.', '.5', ' 12', '1,200', 120.5, 120, 'NaN'];
const CURRENCIES = ['EUR', 'JPY', 'USD', 'eur', 'EU', 'EURO', 'E1R', 978, 'ＥＵＲ'];
const DURATIONS = ['P3D', 'PT48H', 'P2W', 'P1DT12H', 'P', 'PT', 'P1DT', '3D', 'p3d', '3 days'];
const UNTILS = [isoAt(FIXED_S + 86400), isoAt(FIXED_S + 1), isoAt(FIXED_S), isoAt(FIXED_S - 1), '2025-10-16',
  '2025-10-16T09:53:20', '2025-13-01T00:00:00Z', 'tomorrow', FIXED_S + 86400];

function valueFor(rand, key) {
  const r = rand();
  if (r < 0.15) return pick(rand, ODD);
  if (r < 0.25) return randomString(rand);
  if (key === 'price') return pick(rand, PRICES);
  if (key === 'currency') return pick(rand, CURRENCIES);
  if (key === 'leadTime') return pick(rand, DURATIONS);
  if (key === 'validUntil') return pick(rand, UNTILS);
  return rand() < 0.1 ? 'n'.repeat(495 + Math.floor(rand() * 10)) : randomString(rand);
}

/** One terms value of a random kind: mostly objects with mixed good and bad fields, some not objects. */
function termsFrom(rand) {
  if (rand() < 0.08) return pick(rand, ODD);
  const out = {};
  for (const key of ['price', 'currency', 'leadTime', 'validUntil', 'note']) {
    const r = rand();
    if (r < 0.08 && key !== 'note') continue;
    if (key === 'note' && r < 0.4) continue;
    out[key] = r < 0.55 ? ({ price: '120.00', currency: 'EUR', leadTime: 'P3D', validUntil: isoAt(FIXED_S + 86400),
      note: 'Parts in stock.' })[key] : valueFor(rand, key);
  }
  if (rand() < 0.05) out[pick(rand, ['discount', 'Price', 'valid_until', '__proto__'])] = '1';
  return out;
}

function atClock(ms, fn) {
  const realNow = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = realNow; }
}

const describe = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

// ---------------------------------------------------------------- owner side

test('round_trip: confirmReceipt with any terms either throws a TypeError or signs them back exactly', () => {
  const rand = mulberry32(FUZZ_SEED);
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < OWNER_CASES; i += 1) {
    const terms = termsFrom(rand);
    let out;
    let thrown = null;
    try { out = atClock(FIXED_S * 1000, () => confirmReceipt(SHOP_SEED, PENDING, terms)); } catch (e) { thrown = e; }
    if (thrown) {
      assert.ok(thrown instanceof TypeError, `case ${i} ${describe(terms)}: a TypeError, not ${thrown?.constructor?.name}: ${thrown?.message}`);
      refused += 1;
      continue;
    }
    accepted += 1;
    const reply = JSON.parse(out);
    assert.equal(reply.status, 'confirmed', `case ${i}: confirmed`);
    assert.deepEqual(reply.terms, terms, `case ${i} ${describe(terms)}: the terms round-trip exactly`);
    assert.ok(Object.keys(terms).every((k) => KNOWN.has(k)), `case ${i} ${describe(terms)}: only the five known keys`);
    assert.ok(typeof terms.price === 'string' && /^\d+(\.\d+)?$/.test(terms.price), `case ${i}: a decimal string price`);
    assert.ok(typeof terms.currency === 'string' && /^[A-Z]{3}$/.test(terms.currency), `case ${i}: a three-letter currency`);
    assert.ok(typeof terms.leadTime === 'string' && /^P/.test(terms.leadTime), `case ${i}: an ISO 8601 duration`);
    assert.ok(typeof terms.validUntil === 'string' && Date.parse(terms.validUntil) > FIXED_S * 1000,
      `case ${i} ${describe(terms)}: validUntil after the decision second`);
    if (Object.hasOwn(terms, 'note')) {
      assert.ok(typeof terms.note === 'string' && [...terms.note].length <= 500
        && !/[\u0000-\u001f\u007f-\u009f]/.test(terms.note), `case ${i}: a note within the decline note's rule`);
    }
  }
  assert.ok(accepted >= OWNER_CASES / 20, `the generator reaches the accepting path: ${accepted} accepted`);
  assert.ok(refused >= OWNER_CASES / 4, `the generator reaches the refusing path: ${refused} refused`);
});

// ---------------------------------------------------------------- wire side

test('invariant: a signed priced acceptance with one terms field changed is never reported as a booking', async () => {
  const rand = mulberry32(FUZZ_SEED ^ 0x55);
  const keyDir = mkdtempSync(join(tmpdir(), 'ae-qt-fuzz-key-'));
  scratch.push(keyDir);
  const keyPath = join(keyDir, 'knock-seed');
  writeFileSync(keyPath, `${CUSTOMER_SEED}\n`, { mode: 0o600 });
  const store = createMemoryStore();
  const declaration = { v: 1, entry: { name: 'Bench Repair', baseUrl: SHOP_BASE },
    offers: [{ verb: 'quote', of: 'repair', about: 'Get a price for a repair before you commit.',
      input: { item: 'string', problem: 'string' }, door: { reply: 'pending' } }] };
  const entry = createAgentEntry({ seedHex: SHOP_SEED, name: 'Bench Repair', baseUrl: SHOP_BASE, declaration,
    signedRatePerMin: 0, signedRatePerMinTotal: 0, store });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const out = await entry.handleRequestAsync(init.method || 'GET', u.pathname + u.search, init.headers || {},
      Buffer.from(init.body || ''), { remoteAddress: '127.0.0.1' });
    return new Response(out.body, { status: out.status, headers: out.headers });
  };
  for (let i = 0; i < WIRE_CASES; i += 1) {
    const messageId = `qt-fuzz-${i}-${process.pid}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = signEnvelope(CUSTOMER_SEED, { from: CUSTOMER_DID, to: entry.did, messageId, contextId: null, timestamp, text: QUOTE_TEXT });
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: messageId, method: 'message/send',
      params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text: QUOTE_TEXT }],
        metadata: { from: CUSTOMER_DID, to: entry.did, timestamp, sig, offer: 'quote' } } } }));
    const res = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body, { remoteAddress: '127.0.0.1' });
    const pendingText = JSON.parse(Buffer.from(res.body).toString('utf8')).result.parts[0].text;
    const ref = JSON.parse(pendingText).deal.ref;
    const terms = { price: '120.00', currency: 'EUR', leadTime: 'P3D',
      validUntil: isoAt(timestamp + 30 * 86400), note: 'Parts in stock.' };
    const signed = JSON.parse(confirmReceipt(SHOP_SEED, pendingText, terms));
    const key = pick(rand, ['price', 'currency', 'leadTime', 'validUntil', 'note']);
    let value = valueFor(rand, key);
    if (describe(value) === describe(terms[key])) value = `${String(value)}0`;
    signed.terms[key] = value;
    const row = JSON.parse(JSON.stringify(await store.getReceipt(ref)));
    row.decision = { status: 'confirmed', text: JSON.stringify(signed), decided_ts: timestamp };
    await store.putReceipt(ref, row);
    let result = null;
    let error = null;
    try {
      result = await knockAgentEntry(`${SHOP_BASE}${AGENT_CARD_PATH}`,
        { keyPath, offer: 'track', text: JSON.stringify({ ref }), fetchImpl });
    } catch (e) { error = e; }
    assert.ok(error !== null || result?.ok !== true || !result?.booking,
      `case ${i}: ${key} changed to ${describe(value)} after signing is reported as a booking: ${describe(result).slice(0, 300)}`);
  }
});
