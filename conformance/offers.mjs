#!/usr/bin/env node
// Agent Entry Suite S1: the door's default responder, generated from offers[]. One knock per
// verb against the generated responder, the reply kinds (catalog, facts, pending, checkout,
// brain, human), the 2-of-2-ready `deal` block, `metadata.offer` on the ONE method, the four
// trade recipes as offers[] starters, and a byte-identical regression of today's recipes.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first pair; see conformance/tools.mjs for the frame).
//
// What is pinned here:
//   createAgentEntry({ ..., declaration })  answers `message/send` with `metadata.offer` =
//     an offer id (`hold_item`) or a registry verb (`hold`) by the offer's door.reply.
//   Reply text (JSON) = { verb, of, customer_did, request, status, deal? } plus, per kind:
//     facts -> `facts`, checkout -> `url`. pending -> status "pending_confirmation".
//   deal = the JS twin of trunk shared/deal.py's half-signed offer:
//     { type: "DealReceipt", partyA: <door did>, partyB: <customer did>, termsHash, contextId,
//       ref: <request messageId>, ts, salt, sigA }
//     termsHash = hex sha256( canonicalBytes({ terms }) || salt ), terms = the reply minus deal,
//     sigA = Ed25519 by the door over canonicalBytes of the seven payload fields.
//   An unrecognised metadata.offer is refused with -32602 and creates no customer row.
//   OFFER_STARTERS = { restaurant, retail, clinic, repair }, each an offers[] array.
//   knockAgentEntry (S6b-2) recognises that Suite reply as a booking next to the older
//     {type, customer_did, request, status} shape, and runs the same customer_did cross-check.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';
import { createCourtBookingDoor } from '../examples/court-booking.mjs';
import { createClinicBookingDoor } from '../examples/clinic-booking.mjs';
import { createRepairShopHandler } from '../examples/repair-shop-serverless.mjs';
import { createHarborLampEntry } from '../examples/live-demo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(HERE, 'vectors-tools.json'), 'utf8'));
const PRE_OFFERS = JSON.parse(readFileSync(join(HERE, 'fixtures', 'recipe-replies-pre-offers.json'), 'utf8'));
const { AGENT_CARD_PATH, canonicalBytes, canonicalJSON, createAgentEntry, didFromSeedHex,
  publicKeyHexFromDid, signBytes, signEnvelope, verifyBytes, verifyEnvelope } = door;

const DOOR_SEED = 'c4'.repeat(32);
const VISITOR_SEED = '77'.repeat(32);
const VISITOR = didFromSeedHex(VISITOR_SEED);

let passed = 0;
const failures = [];
let sequence = 0;

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${detail}` : ''}`);
  return false;
}

function attempt(fn) {
  try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, error }; }
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const sortedKeys = (o) => JSON.stringify(Object.keys(o || {}).sort());

function vector(name) {
  const hit = VECTORS.vectors.find((v) => v.name === name);
  if (!hit) throw new Error(`vectors-tools.json has no vector ${name}`);
  return hit;
}

/** A door built from a declaration, recording every responder and observer call. Rate lanes
 *  are off: this runner knocks many times as one visitor on purpose. */
function makeDoor(declaration, extra = {}) {
  const sink = { resp: [], obs: [] };
  const made = attempt(() => createAgentEntry({
    seedHex: DOOR_SEED,
    name: declaration.entry.name,
    baseUrl: declaration.entry.baseUrl,
    declaration: clone(declaration),
    signedRatePerMin: 0,
    signedRatePerMinTotal: 0,
    responder: (env) => { sink.resp.push(env); return 'the site brain answers: yes, Tuesday works'; },
    observer: (env) => { sink.obs.push(env); },
    ...extra,
  }));
  return { ...made, sink };
}

/** A signed `message/send` whose metadata names an offer. `metadata.offer` rides beside the
 *  signing envelope, exactly as the design puts it ("verbs ride message/send text +
 *  metadata.offer"). */
function knockBody(entry, { text, offer, method = 'message/send', seed = VISITOR_SEED, omitOffer = false }) {
  const from = didFromSeedHex(seed);
  const messageId = `offers-${++sequence}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signEnvelope(seed, { from, to: entry.did, messageId, contextId: null, timestamp, text });
  const metadata = { from, to: entry.did, timestamp, sig };
  if (!omitOffer) metadata.offer = offer;
  return {
    messageId,
    buffer: Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: messageId, method,
      params: { message: { kind: 'message', role: 'user', messageId, contextId: null,
        parts: [{ kind: 'text', text }], metadata } },
    })),
  };
}

async function knock(entry, opts) {
  const { messageId, buffer } = knockBody(entry, opts);
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, buffer);
  const raw = Buffer.from(out.body || '').toString('utf8');
  let body = null;
  try { body = JSON.parse(raw); } catch { /* reported by callers */ }
  const message = body?.result;
  const text = message?.parts?.[0]?.text;
  const signed = Boolean(message) && verifyEnvelope({
    from: message.metadata?.from, to: message.metadata?.to, messageId: message.messageId,
    contextId: message.contextId ?? null, timestamp: message.metadata?.timestamp, text,
    sig: message.metadata?.sig,
  }, { recipientDid: didFromSeedHex(opts.seed || VISITOR_SEED), signerDid: entry.did });
  let reply = null;
  try { reply = JSON.parse(text); } catch { /* brain replies are free text */ }
  return { out, raw, body, messageId, text, signed, reply };
}

const BASE_KEYS = ['customer_did', 'of', 'request', 'status', 'verb'];

function checkBase(k, { verb, of, text }, label) {
  check(k.out.status === 200 && !k.body?.error, `${label}/answered`,
    `HTTP ${k.out.status} ${JSON.stringify(k.body?.error)}`);
  check(k.signed, `${label}/signed-by-the-door`);
  const r = k.reply || {};
  check(r.verb === verb && r.of === of, `${label}/verb-and-of`, JSON.stringify({ verb: r.verb, of: r.of }));
  check(r.customer_did === VISITOR, `${label}/customer_did-is-the-signer`, JSON.stringify(r.customer_did));
  check(r.request === text, `${label}/request-is-the-signed-text`, JSON.stringify(r.request));
  check(typeof r.status === 'string' && r.status.length > 0, `${label}/status`, JSON.stringify(r.status));
  check(!Object.hasOwn(r, 'type'), `${label}/type-is-replaced-by-verb-and-of`);
  for (const key of ['paid', 'confirmed', 'booked', 'amount']) {
    check(r[key] === undefined, `${label}/not-a-completed-sale/${key}`);
  }
}

/** The deal block, checked the way the visitor's runtime will before it countersigns. */
function checkDeal(k, entry, label) {
  const r = k.reply || {};
  const deal = r.deal;
  if (!check(deal && typeof deal === 'object', `${label}/deal/present`, JSON.stringify(r))) return null;
  check(sortedKeys(deal) === JSON.stringify(
    ['contextId', 'partyA', 'partyB', 'ref', 'salt', 'sigA', 'termsHash', 'ts', 'type']),
  `${label}/deal/shape`, sortedKeys(deal));
  check(deal.type === 'DealReceipt', `${label}/deal/type`);
  check(deal.partyA === entry.did && deal.partyB === VISITOR, `${label}/deal/parties-door-and-customer`);
  check(deal.contextId === null && deal.ref === k.messageId, `${label}/deal/ref-is-the-request`,
    JSON.stringify({ contextId: deal.contextId, ref: deal.ref }));
  check(Number.isSafeInteger(deal.ts), `${label}/deal/ts-integer`);
  check(!Object.hasOwn(deal, 'sigB'), `${label}/deal/half-signed-the-visitor-countersigns`);
  const salt = Buffer.from(String(deal.salt), 'base64');
  check(salt.length >= 16 && salt.toString('base64') === deal.salt, `${label}/deal/salt-16-bytes-base64`);
  const { deal: _omit, ...terms } = r;
  const commit = createHash('sha256').update(Buffer.concat([canonicalBytes({ terms }), salt])).digest('hex');
  check(deal.termsHash === commit, `${label}/deal/termsHash-commits-to-the-reply-terms`,
    `${deal.termsHash} vs ${commit}`);
  const payload = canonicalBytes({
    type: deal.type, partyA: deal.partyA, partyB: deal.partyB, termsHash: deal.termsHash,
    contextId: deal.contextId, ref: deal.ref, ts: deal.ts,
  });
  const sigA = Buffer.from(String(deal.sigA), 'base64');
  check(sigA.length === 64 && verifyBytes(Buffer.from(publicKeyHexFromDid(entry.did), 'hex'), sigA, payload),
    `${label}/deal/sigA-verifies-under-the-door`);
  // 2-of-2 ready: the visitor can countersign the same payload and both halves verify.
  const sigB = signBytes(VISITOR_SEED, payload);
  check(verifyBytes(Buffer.from(publicKeyHexFromDid(VISITOR), 'hex'), sigB, payload),
    `${label}/deal/visitor-can-countersign`);
  return deal;
}

function checkNoDeal(k, label) {
  check(k.reply && !Object.hasOwn(k.reply, 'deal'), `${label}/no-deal`, JSON.stringify(k.reply));
}

// ---------------------------------------------------------------- 1. every reply kind

const harbor = vector('harbor-lamp-every-reply-kind-and-facts');
{
  const d = makeDoor(harbor.declaration);
  if (check(d.ok, 'harbor/door-starts', d.ok ? '' : d.error?.message)) {
    const entry = d.value;

    // catalog: find has no receipt by default.
    const find = await knock(entry, { offer: 'find', text: 'brass desk lamp' });
    checkBase(find, { verb: 'find', of: 'products', text: 'brass desk lamp' }, 'reply/catalog');
    checkNoDeal(find, 'reply/catalog');

    // pending: hold and book carry a deal by default, and the shape is exactly the new one.
    for (const [offer, verb, of, text] of [
      ['hold', 'hold', 'item', 'Hold the brass lamp, sku L-12'],
      ['hold_item', 'hold', 'item', 'Hold the green lamp, sku L-7'],
      ['book', 'book', 'table', 'Table for 4 on Saturday at 19:00'],
      ['book_table', 'book', 'table', 'Table for 2 on Sunday at 12:30'],
    ]) {
      const k = await knock(entry, { offer, text });
      const label = `reply/pending/${offer}`;
      checkBase(k, { verb, of, text }, label);
      check(k.reply?.status === 'pending_confirmation', `${label}/status-pending_confirmation`,
        JSON.stringify(k.reply?.status));
      check(sortedKeys(k.reply) === JSON.stringify([...BASE_KEYS, 'deal'].sort()),
        `${label}/exactly-verb-of-customer_did-request-status-deal`, sortedKeys(k.reply));
      checkDeal(k, entry, label);
    }
    // A fresh salt per deal: two identical asks never share a commitment.
    const a = await knock(entry, { offer: 'book', text: 'Same ask' });
    const b = await knock(entry, { offer: 'book', text: 'Same ask' });
    check(a.reply?.deal?.salt && a.reply.deal.salt !== b.reply?.deal?.salt
        && a.reply.deal.termsHash !== b.reply?.deal?.termsHash,
      'reply/pending/fresh-salt-per-deal');

    // checkout: a URL handoff to the site's own checkout. Payment is never touched.
    const before = d.sink.resp.length;
    const buy = await knock(entry, { offer: 'buy', text: 'Pay for hold H-1' });
    checkBase(buy, { verb: 'buy', of: 'order', text: 'Pay for hold H-1' }, 'reply/checkout');
    checkNoDeal(buy, 'reply/checkout');
    check(typeof buy.reply?.url === 'string' && buy.reply.url.startsWith('https://shop.example/checkout'),
      'reply/checkout/url-on-the-shop-origin', JSON.stringify(buy.reply?.url));
    const money = ['amount', 'price', 'total', 'currency', 'payment', 'paid', 'card', 'charge', 'invoice'];
    check(money.every((key) => !Object.hasOwn(buy.reply || {}, key)),
      'reply/checkout/carries-no-payment-fields', sortedKeys(buy.reply));
    check(!['paid', 'confirmed', 'complete', 'completed'].includes(buy.reply?.status),
      'reply/checkout/status-is-not-a-payment', JSON.stringify(buy.reply?.status));
    check(d.sink.resp.length === before, 'reply/checkout/site-responder-not-called');

    // human: the ledger remembers the customer, and the reply says someone will answer.
    const human = await knock(entry, { offer: 'ask', text: 'Do you ship to Osaka?' });
    checkBase(human, { verb: 'ask', of: 'anything', text: 'Do you ship to Osaka?' }, 'reply/human');
    check(JSON.stringify(human.reply || {}).toLowerCase().includes('we will answer'),
      'reply/human/says-we-will-answer', JSON.stringify(human.reply));
    check(entry.ledger.has(VISITOR) && entry.ledger.get(VISITOR).messages >= 1,
      'reply/human/ledger-row-for-the-customer');
    check(d.sink.resp.length === before, 'reply/human/site-responder-not-called');
    checkNoDeal(human, 'reply/human');

    // The one-method invariant: page tools and verbs are never A2A methods.
    check(entry.card.supportedInterfaces?.length === 1
        && entry.card.supportedInterfaces[0].protocolBinding === 'JSONRPC',
      'one-method/card-has-one-interface');
    for (const method of ['hold_item', 'hold', 'find_products', 'tools/call', 'tools/list', 'offers/list',
      'offers/hold', 'message/stream', 'tasks/send', 'agenttools/get']) {
      const k = await knock(entry, { method, offer: 'hold', text: 'Hold sku L-12' });
      check(k.out.status === 200 && k.body?.error?.code === -32601 && !k.body?.result,
        `one-method/${method}-is-method-not-found`, JSON.stringify(k.body?.error));
    }

    // metadata.offer that names nothing this door offers is refused, never silently ignored.
    for (const offer of ['teleport', 'Hold', 'HOLD_ITEM', 'hold_', 'hold_table', 'buy_products', '',
      'track', 'find_products ', 'did:key:z6MkNotAnOffer']) {
      const seed = createHash('sha256').update(`stranger-${offer}`).digest('hex');
      const stranger = didFromSeedHex(seed);
      const k = await knock(entry, { offer, text: 'Hold sku L-12', seed });
      const label = `offer/unrecognised/${JSON.stringify(offer)}`;
      check(k.out.status === 200 && k.body?.error?.code === -32602 && !k.body?.result,
        `${label}/refused-32602`, JSON.stringify(k.body?.error));
      check(offer.length < 4 || !k.raw.includes(offer), `${label}/value-not-echoed`, k.raw.slice(0, 200));
      check(!entry.ledger.has(stranger), `${label}/no-customer-row`);
    }
    for (const offer of [42, true, {}, ['hold']]) {
      const k = await knock(entry, { offer, text: 'Hold sku L-12' });
      check(k.body?.error && !k.body?.result, `offer/not-a-string/${JSON.stringify(offer)}/refused`,
        JSON.stringify(k.body));
    }
  }
}

// ---------------------------------------------------------------- 2. facts, receipts by verb

{
  const repair = vector('repair-desk-reversible-and-receipt-defaults');
  const d = makeDoor(repair.declaration);
  if (check(d.ok, 'repair/door-starts', d.ok ? '' : d.error?.message)) {
    const entry = d.value;
    const track = await knock(entry, { offer: 'track', text: 'Where is ticket T-9?' });
    checkBase(track, { verb: 'track', of: 'repair', text: 'Where is ticket T-9?' }, 'reply/facts');
    check(canonicalJSON(track.reply?.facts ?? null) === canonicalJSON(repair.declaration.facts),
      'reply/facts/draws-on-the-declared-facts', JSON.stringify(track.reply?.facts));
    checkNoDeal(track, 'reply/facts');

    for (const [offer, verb, of, wantsDeal] of [
      ['quote', 'quote', 'repair', true],
      ['order', 'order', 'parts', true],
      ['change', 'change', 'booking', false],
      ['cancel', 'cancel', 'booking', false],
      ['join', 'join', 'waitlist', false],
    ]) {
      const text = `${verb} please, ticket T-${sequence}`;
      const k = await knock(entry, { offer, text });
      const label = `receipt-default/${verb}`;
      checkBase(k, { verb, of, text }, label);
      if (wantsDeal) checkDeal(k, entry, label);
      else checkNoDeal(k, label);
    }
  }
}

// ---------------------------------------------------------------- 3. overrides and brain

{
  const studio = vector('overrides-raise-effect-and-ask-opt-out-of-then');
  const d = makeDoor(studio.declaration);
  if (check(d.ok, 'studio/door-starts', d.ok ? '' : d.error?.message)) {
    const entry = d.value;
    const book = await knock(entry, { offer: 'book', text: 'Two people, slot S-3' });
    checkBase(book, { verb: 'book', of: 'session', text: 'Two people, slot S-3' }, 'receipt-override/book-false');
    checkNoDeal(book, 'receipt-override/book-false');

    // brain: the site's own responder answers, verbatim, and is told which offer was asked.
    const before = d.sink.resp.length;
    const brain = await knock(entry, { offer: 'ask_studio', text: 'Is Tuesday free?' });
    check(brain.signed && !brain.body?.error, 'reply/brain/answered-and-signed', JSON.stringify(brain.body?.error));
    check(d.sink.resp.length === before + 1, 'reply/brain/site-responder-called-once');
    check(brain.text === 'the site brain answers: yes, Tuesday works', 'reply/brain/responder-text-verbatim',
      JSON.stringify(brain.text));
    const env = d.sink.resp[d.sink.resp.length - 1] || {};
    check(env.offer === 'ask_studio' && env.peer_did === VISITOR && env.text === 'Is Tuesday free?',
      'reply/brain/responder-env-names-the-offer', JSON.stringify({ offer: env.offer, peer: env.peer_did }));

    // Page-only offers have no door binding: the door does not answer them.
    for (const offer of ['find_slots', 'hold_slot']) {
      const k = await knock(entry, { offer, text: 'slot S-3' });
      check(k.body?.error?.code === -32602 && !k.body?.result, `offer/page-only/${offer}-refused-at-the-door`,
        JSON.stringify(k.body?.error));
    }
  }
}

// ---------------------------------------------------------------- 4. the four recipes as starters

const OFFER_STARTERS = door.OFFER_STARTERS;
check(OFFER_STARTERS && typeof OFFER_STARTERS === 'object', 'export/OFFER_STARTERS');
if (OFFER_STARTERS && typeof OFFER_STARTERS === 'object') {
  check(JSON.stringify(Object.keys(OFFER_STARTERS).sort()) === JSON.stringify(['clinic', 'repair', 'restaurant', 'retail']),
    'starters/four-trades', JSON.stringify(Object.keys(OFFER_STARTERS)));
  const ids = (trade) => (OFFER_STARTERS[trade] || []).map((o) => `${o.verb}_${o.of}`);
  check(JSON.stringify(ids('restaurant')) === JSON.stringify(['book_table', 'ask_anything']),
    'starters/restaurant-book-table-and-ask', JSON.stringify(ids('restaurant')));
  check(JSON.stringify(ids('retail')) === JSON.stringify(['find_products', 'hold_item', 'buy_order']),
    'starters/retail-find-hold-buy', JSON.stringify(ids('retail')));
  check(OFFER_STARTERS.clinic?.[0]?.verb === 'book' && OFFER_STARTERS.repair?.[0]?.verb === 'book',
    'starters/clinic-and-repair-lead-with-book');

  const kinds = { book_table: 'pending', ask_anything: 'human', find_products: 'catalog',
    hold_item: 'pending', buy_order: 'checkout' };
  for (const trade of ['restaurant', 'retail', 'clinic', 'repair']) {
    const offers = OFFER_STARTERS[trade];
    if (!check(Array.isArray(offers) && offers.length > 0, `starters/${trade}/is-an-offers-array`)) continue;
    const declaration = {
      v: 1, entry: { name: `${trade} starter`, baseUrl: `https://${trade}.example` }, offers: clone(offers),
    };
    const valid = attempt(() => door.validateDeclaration(clone(declaration)));
    check(valid.ok, `starters/${trade}/validates`, valid.ok ? '' : valid.error?.message);
    for (const o of offers) {
      const id = `${o.verb}_${o.of}`;
      check(o.door && typeof o.door.reply === 'string', `starters/${trade}/${id}/door-bound-so-doctor-can-knock`);
      if (kinds[id] && trade !== 'clinic' && trade !== 'repair') {
        check(o.door?.reply === kinds[id], `starters/${trade}/${id}/reply-${kinds[id]}`, JSON.stringify(o.door));
      }
    }
    const d = makeDoor(declaration);
    if (!check(d.ok, `starters/${trade}/door-starts`, d.ok ? '' : d.error?.message)) continue;
    const entry = d.value;
    check(JSON.stringify(entry.card.skills.map((s) => s.id)) === JSON.stringify(offers.map((o) => `${o.verb}_${o.of}`)),
      `starters/${trade}/card-skills-are-the-offers`);
    for (const o of offers) {
      const id = `${o.verb}_${o.of}`;
      const text = entry.card.skills.find((s) => s.id === id)?.examples?.[0] || o.about;
      const k = await knock(entry, { offer: id, text });
      const label = `starters/${trade}/${id}/knock`;
      if (o.door?.reply === 'brain') {
        check(k.signed && !k.body?.error, `${label}/brain-answered`);
        continue;
      }
      checkBase(k, { verb: o.verb, of: o.of, text }, label);
      const receipt = o.door?.receipt ?? ['hold', 'book', 'order', 'quote'].includes(o.verb);
      if (receipt) checkDeal(k, entry, label);
      else checkNoDeal(k, label);
      if (o.door?.reply === 'checkout') {
        check(String(k.reply?.url).startsWith(`https://${trade}.example/`), `${label}/checkout-url-on-origin`);
      }
    }
  }
}

// ---------------------------------------------------------------- 5. today's recipes, byte for byte

function maskReply(raw) {
  const parsed = JSON.parse(raw);
  parsed.result.messageId = '<per-reply>';
  parsed.result.metadata.sig = '<per-reply>';
  parsed.result.metadata.timestamp = '<per-reply>';
  return JSON.stringify(parsed);
}

{
  // The fixture was recorded from the door BEFORE offers[] existed (commit 26b78ca). A door
  // built the old way - its own skills and responder, no declaration - must answer exactly as
  // it did: same card bytes, same reply bytes but for the fresh messageId, timestamp and sig.
  const recipes = [
    ['court', createCourtBookingDoor({ seedHex: '81'.repeat(32), baseUrl: 'https://court.example' })],
    ['clinic', createClinicBookingDoor({ seedHex: '82'.repeat(32), baseUrl: 'https://clinic.example' })],
    ['repair', createRepairShopHandler({ seedHex: '83'.repeat(32), baseUrl: 'https://repair.example' }).entry],
    ['restaurant', createHarborLampEntry({ seedHex: 'a1'.repeat(32), baseUrl: 'https://harbor.example' })],
  ];
  for (const [label, entry] of recipes) {
    const want = PRE_OFFERS[label];
    const card = await entry.handleRequestAsync('GET', AGENT_CARD_PATH, {}, Buffer.alloc(0));
    check(card.status === want.cardStatus && card.body.toString('utf8') === want.cardBody,
      `book-regression/${label}/card-bytes-unchanged`);
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = signEnvelope(VISITOR_SEED, {
      from: VISITOR, to: entry.did, messageId: want.messageId, contextId: null, timestamp, text: want.text,
    });
    const body = Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: want.messageId, method: 'message/send',
      params: { message: { kind: 'message', role: 'user', messageId: want.messageId, contextId: null,
        parts: [{ kind: 'text', text: want.text }],
        metadata: { from: VISITOR, to: entry.did, timestamp, sig } } },
    }));
    const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body);
    const raw = out.body.toString('utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* reported below */ }
    check(out.status === want.replyStatus && parsed?.result?.parts?.[0]?.text === want.replyText,
      `book-regression/${label}/reply-text-bytes-unchanged`, parsed?.result?.parts?.[0]?.text);
    let masked = null;
    try { masked = maskReply(raw); } catch { /* reported below */ }
    check(masked === want.replyMasked, `book-regression/${label}/reply-body-bytes-unchanged`,
      `\n    got  ${masked}\n    want ${want.replyMasked}`);
  }
}

// ---------------------------------------------------------------- 6. the knock reads the Suite reply (S6b-2)
//
// A real Suite door answers {verb, of, customer_did, request, status, facts|url by kind, deal?}
// (AT-12/AT-13), with no `type`. knockAgentEntry must recognise that as a booking the same way
// it recognises the older {type, customer_did, request, status}: surface it as `booking`, make
// `text` the checked JSON, and throw when the signed reply files it under someone else.

const FOREIGN = 'did:key:z6MkNotTheVisitor';
const DIFFERENT_CUSTOMER = 'the signed reply files a booking under a different customer';
const SUITE_KEYS = new Set(['verb', 'of', 'customer_did', 'request', 'status', 'facts', 'url', 'deal']);
const knockHome = mkdtempSync(join(tmpdir(), 'offers-knock-'));
const knockKey = join(knockHome, 'knock-seed');

function fetchEntry(entry) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const out = await entry.handleRequestAsync(init.method || 'GET', parsed.pathname + parsed.search,
      init.headers || {}, Buffer.from(init.body || ''));
    return new Response(out.body, { status: out.status, headers: out.headers });
  };
}

async function knockOrCatch(entry, opts) {
  try {
    return { threw: false, result: await door.knockAgentEntry(`${entry.card.url}${AGENT_CARD_PATH}`,
      { keyPath: knockKey, fetchImpl: fetchEntry(entry), ...opts }) };
  } catch (error) {
    return { threw: true, error };
  }
}

function parseMaybe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** The booking a knock surfaced from a real Suite door: the signed reply's own object, every key. */
function checkSuiteBooking(k, { verb, of, text, status }, label) {
  if (!check(!k.threw && k.result?.ok === true, `${label}/knock-ok`,
    k.threw ? `threw ${k.error?.message}` : JSON.stringify(k.result?.error))) return null;
  const knocked = k.result;
  const signed = parseMaybe(knocked.reply?.result?.parts?.[0]?.text);
  const booking = knocked.booking;
  check(booking && typeof booking === 'object' && !Array.isArray(booking), `${label}/booking-object`,
    `got ${booking === undefined ? 'undefined' : typeof booking}`);
  check(booking?.verb === verb && booking?.of === of, `${label}/booking-verb-and-of`,
    JSON.stringify({ verb: booking?.verb, of: booking?.of }));
  check(booking?.customer_did === knocked.did, `${label}/booking-customer_did-is-the-knocker`,
    JSON.stringify(booking?.customer_did));
  check(booking?.request === text, `${label}/booking-request-is-the-signed-text`, JSON.stringify(booking?.request));
  check(booking?.status === status, `${label}/booking-status`, JSON.stringify(booking?.status));
  check(Boolean(booking) && !Object.hasOwn(booking, 'type'), `${label}/booking-has-no-type`);
  check(Boolean(booking) && canonicalJSON(booking) === canonicalJSON(signed),
    `${label}/booking-is-the-signed-reply-object`, `\n    got  ${JSON.stringify(booking)}\n    want ${JSON.stringify(signed)}`);
  const printed = parseMaybe(knocked.text);
  check(Boolean(booking) && canonicalJSON(printed) === canonicalJSON(booking), `${label}/text-is-the-checked-booking`,
    JSON.stringify(knocked.text));
  return booking;
}

{
  const shop = makeDoor(harbor.declaration);
  const repairDesk = makeDoor(vector('repair-desk-reversible-and-receipt-defaults').declaration);
  if (check(shop.ok && repairDesk.ok, 'knock-suite/doors-start')) {
    // pending + deal: the receipt the visitor countersigns survives the check intact.
    const holdText = 'Hold the brass lamp, sku L-12';
    const hold = await knockOrCatch(shop.value, { offer: 'hold', text: holdText });
    const held = checkSuiteBooking(hold, { verb: 'hold', of: 'item', text: holdText, status: 'pending_confirmation' },
      'knock-suite/pending');
    const deal = held?.deal;
    if (check(deal && typeof deal === 'object', 'knock-suite/pending/deal-kept', JSON.stringify(held))) {
      check(deal.partyA === shop.value.did && deal.partyB === hold.result.did, 'knock-suite/pending/deal-parties');
      const { deal: _omit, ...terms } = held;
      const salt = Buffer.from(String(deal.salt), 'base64');
      const commit = createHash('sha256').update(Buffer.concat([canonicalBytes({ terms }), salt])).digest('hex');
      check(deal.termsHash === commit, 'knock-suite/pending/deal-termsHash-commits-to-the-booking');
      const payload = canonicalBytes({
        type: deal.type, partyA: deal.partyA, partyB: deal.partyB, termsHash: deal.termsHash,
        contextId: deal.contextId, ref: deal.ref, ts: deal.ts,
      });
      check(verifyBytes(Buffer.from(publicKeyHexFromDid(shop.value.did), 'hex'),
        Buffer.from(String(deal.sigA), 'base64'), payload), 'knock-suite/pending/deal-sigA-verifies');
    }

    // checkout: the url rides along; nothing about payment is invented.
    const buyText = 'Pay for hold H-1';
    const buy = await knockOrCatch(shop.value, { offer: 'buy', text: buyText });
    const bought = checkSuiteBooking(buy, { verb: 'buy', of: 'order', text: buyText, status: 'continue_at_checkout' },
      'knock-suite/checkout');
    check(typeof bought?.url === 'string' && bought.url.startsWith('https://shop.example/checkout'),
      'knock-suite/checkout/url-kept', JSON.stringify(bought?.url));

    // facts: the declared facts ride along.
    const trackText = 'Where is ticket T-9?';
    const track = await knockOrCatch(repairDesk.value, { offer: 'track', text: trackText });
    const tracked = checkSuiteBooking(track, { verb: 'track', of: 'repair', text: trackText, status: 'answered' },
      'knock-suite/facts');
    check(tracked && tracked.facts !== undefined, 'knock-suite/facts/facts-kept', JSON.stringify(tracked));

    // A visitor whose ask is itself Suite-shaped JSON naming someone else does not get that
    // someone's booking: customer_did comes from the door's signed reply, which is the signer.
    const spoofed = JSON.stringify({ verb: 'hold', of: 'item', customer_did: FOREIGN, request: 'x',
      status: 'confirmed' });
    const injected = await knockOrCatch(shop.value, { offer: 'hold', text: spoofed });
    checkSuiteBooking(injected, { verb: 'hold', of: 'item', text: spoofed, status: 'pending_confirmation' },
      'knock-suite/visitor-supplied-json');
    check(injected.result?.booking?.customer_did !== FOREIGN, 'knock-suite/visitor-supplied-json/attacker-did-does-not-win',
      JSON.stringify(injected.result?.booking?.customer_did));
  }
}

/** A door whose own responder signs whatever Suite-shaped object `make(env)` returns. */
function suiteLiar(seedByte, baseUrl, make) {
  return createAgentEntry({
    seedHex: seedByte.repeat(32), name: 'suite-liar', baseUrl,
    skills: [{ id: 'hold_item', name: 'hold', description: 'Hold an item.', examples: ['Hold sku L-12'] }],
    signedRatePerMin: 0, signedRatePerMinTotal: 0,
    responder: (env) => JSON.stringify(make(env)),
  });
}

{
  // REFUSAL: a signed Suite reply filed under a different customer throws the cross-check.
  const shapes = [
    ['pending', { verb: 'hold', of: 'item', customer_did: FOREIGN, request: 'Hold sku L-12',
      status: 'pending_confirmation' }],
    ['checkout', { verb: 'buy', of: 'order', customer_did: FOREIGN, request: 'Hold sku L-12',
      status: 'continue_at_checkout', url: 'https://liar.example/checkout' }],
    ['facts', { verb: 'track', of: 'repair', customer_did: FOREIGN, request: 'Hold sku L-12',
      status: 'answered', facts: { open: 'weekdays' } }],
  ];
  for (const [kind, reply] of shapes) {
    const label = `knock-suite/refuses-foreign-customer/${kind}`;
    const liar = suiteLiar('a7', 'https://liar.example', () => reply);
    const k = await knockOrCatch(liar, { text: 'Hold sku L-12' });
    check(k.threw && String(k.error?.message).includes(DIFFERENT_CUSTOMER), `${label}/throws-the-cross-check`,
      k.threw ? `threw ${k.error?.message}` : `ok=${k.result?.ok} text=${k.result?.text}`);
    check(!(k.result?.ok && String(k.result?.text).includes(FOREIGN)), `${label}/foreign-did-never-printed`);
  }

  // A Suite reply naming the knocker with sale fields the shop signed beside the contract:
  // the booking keeps the Suite keys only, and nothing reads as a completed sale.
  const extras = suiteLiar('a8', 'https://extras.example', (env) => ({
    verb: 'hold', of: 'item', customer_did: env.owner_did || env.peer_did, request: env.text,
    status: 'pending_confirmation', paid: true, confirmed: true, amount: 0,
  }));
  const k = await knockOrCatch(extras, { text: 'Hold sku L-12' });
  const booking = k.result?.booking;
  check(!k.threw && booking && booking.verb === 'hold' && booking.customer_did === k.result?.did,
    'knock-suite/sale-fields/recognised', k.threw ? k.error?.message : JSON.stringify(booking));
  check(Boolean(booking) && Object.keys(booking).every((key) => SUITE_KEYS.has(key)),
    'knock-suite/sale-fields/booking-has-only-suite-keys', JSON.stringify(booking));
  check(!/"(paid|confirmed|amount)"/.test(String(k.result?.text || '')),
    'knock-suite/sale-fields/not-printed', JSON.stringify(k.result?.text));

  // The older shape is still recognised next to the new one.
  const older = createAgentEntry({
    seedHex: 'a9'.repeat(32), name: 'older-desk', baseUrl: 'https://older.example',
    skills: [{ id: 'book', name: 'book', description: 'Request a slot.', examples: ['Book Friday at 18:00'] }],
    signedRatePerMin: 0, signedRatePerMinTotal: 0,
    responder: (env) => JSON.stringify({ type: 'court_booking_request', customer_did: env.owner_did || env.peer_did,
      request: env.text, status: 'pending_confirmation' }),
  });
  const old = await knockOrCatch(older, { text: 'Book Friday at 18:00' });
  check(!old.threw && old.result?.booking?.type === 'court_booking_request'
      && old.result.booking.customer_did === old.result.did,
    'knock-suite/older-shape-still-recognised', old.threw ? old.error?.message : JSON.stringify(old.result?.booking));
}

/** `agent-entry knock <card-url>` against a live loopback door built by `create(baseUrl)`. */
async function knockCli(create) {
  let entry;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const out = await entry.handleRequestAsync(req.method, req.url, req.headers, Buffer.concat(chunks));
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  entry = create(`http://127.0.0.1:${server.address().port}`);
  try {
    return await new Promise((done, fail) => {
      const env = { ...process.env, AGENT_ENTRY_KNOCK_KEY: knockKey };
      delete env.AGENT_ENTRY_KNOCK_TEXT;
      const child = spawn(process.execPath, [join(HERE, '..', 'muretai-agent-entry.mjs'), 'knock',
        `${entry.card.url}${AGENT_CARD_PATH}`], { cwd: join(HERE, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('knock CLI timed out')); }, 15000);
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
    });
  } finally {
    await new Promise((done) => server.close(done));
  }
}

{
  // The CLI no longer prints a foreign Suite booking as raw text: it refuses with the cross-check.
  const cli = await knockCli((baseUrl) => suiteLiar('aa', baseUrl, () => ({
    verb: 'hold', of: 'item', customer_did: FOREIGN, request: 'Hold sku L-12', status: 'pending_confirmation',
  })));
  check(cli.code === 1, 'knock-suite/cli/foreign-customer-exits-1', `code=${cli.code} stdout=${cli.stdout}`);
  check(cli.stderr.includes(DIFFERENT_CUSTOMER), 'knock-suite/cli/foreign-customer-says-why', cli.stderr);
  check(!cli.stdout.includes(FOREIGN), 'knock-suite/cli/foreign-did-not-on-stdout', cli.stdout);

  // And prints the checked Suite booking when the reply names the knocker.
  const honest = await knockCli((baseUrl) => suiteLiar('ab', baseUrl, (env) => ({
    verb: 'hold', of: 'item', customer_did: env.owner_did || env.peer_did, request: env.text,
    status: 'pending_confirmation', paid: true,
  })));
  const printed = parseMaybe(honest.stdout.trim());
  check(honest.code === 0 && printed?.verb === 'hold' && printed?.status === 'pending_confirmation'
      && !Object.hasOwn(printed, 'paid'),
    'knock-suite/cli/prints-the-checked-suite-booking', `code=${honest.code} stdout=${honest.stdout}`);
}

rmSync(knockHome, { recursive: true, force: true });

// ---------------------------------------------------------------- 7. find answers from the product snapshot (Woo-4)
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first, skeleton item 4 of 6 of the Woo declaration
// generator chain; parent intake 20261002T235854Z). The implementer may not edit this section.
// createAgentEntry({ ..., declaration, catalogFile }) answers a door-bound `find` offer of reply
// `catalog` with { verb, of, customer_did, request, status: "see_catalog", products }, `products` the
// rows of the snapshot file at `catalogFile` (the file init --from woocommerce writes, pinned byte
// for byte in conformance/cli.mjs section 11d), each row only id, name, price, stock_status and
// permalink. The reply is drawn from the file, never from a request at reply time. Values are data:
// "<" and ">" never reach the reply text unescaped, a name never adds or rewrites a reply key, a
// row whose permalink is not on the door's own origin is refused (left out), and a field the
// snapshot must not hold (a description, anything else) never passes through.

const SNAPSHOT_EXPECTED = JSON.parse(readFileSync(join(HERE, 'fixtures', 'cli', 'woo', 'find-snapshot.expected.json'), 'utf8'));
const SNAPSHOT_KEYS = JSON.stringify(['id', 'name', 'price', 'stock_status', 'permalink']);
const FIND_DECLARATION = {
  v: 1,
  entry: { name: 'Harbor Lamp', baseUrl: 'https://shop.example' },
  offers: [{ verb: 'find', of: 'products', about: 'Find products in the shop catalogue.', input: { q: 'string' },
    door: { reply: 'catalog' } }],
};
const snapHome = mkdtempSync(join(tmpdir(), 'offers-snapshot-'));

/** A knock at a door whose catalogFile holds `rows`, with every fetch counted (and refused) meanwhile. */
async function findFrom(rows, label) {
  const file = join(snapHome, `${label.replace(/\W+/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
  const d = makeDoor(FIND_DECLARATION, { catalogFile: file });
  if (!check(d.ok, `${label}/door-starts`, d.ok ? '' : d.error?.message)) return null;
  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { fetches.push(String(input?.url ?? input)); throw new TypeError('no fetch at reply time'); };
  let k;
  try { k = await knock(d.value, { offer: 'find', text: 'find products {"q":"lamp"}' }); } finally { globalThis.fetch = realFetch; }
  checkBase(k, { verb: 'find', of: 'products', text: 'find products {"q":"lamp"}' }, label);
  check(k.reply?.status === 'see_catalog', `${label}/status-see_catalog`, JSON.stringify(k.reply?.status));
  check(fetches.length === 0, `${label}/no-request-at-reply-time`, JSON.stringify(fetches));
  checkNoDeal(k, label);
  return k;
}

{
  // Functional: the recorded snapshot (one item out of stock) is the reply's products, row for row.
  const k = await findFrom(SNAPSHOT_EXPECTED, 'find-snapshot/recorded');
  if (k) {
    check(canonicalJSON(k.reply?.products ?? null) === canonicalJSON(SNAPSHOT_EXPECTED), 'find-snapshot/recorded/products-are-the-file-rows',
      JSON.stringify(k.reply?.products).slice(0, 600));
    check(k.reply?.products?.find?.((r) => r.id === 103)?.stock_status === 'out_of_stock',
      'find-snapshot/recorded/out-of-stock-item-named-out_of_stock');
  }

  // A different file is a different reply: the door reads the file it is given.
  const other = clone(SNAPSHOT_EXPECTED).slice(1);
  other[0].name = 'Linen Shade (from the other file)';
  const k2 = await findFrom(other, 'find-snapshot/other-file');
  if (k2) {
    check(canonicalJSON(k2.reply?.products ?? null) === canonicalJSON(other), 'find-snapshot/other-file/products-are-that-file-rows',
      JSON.stringify(k2.reply?.products).slice(0, 600));
  }

  // Refusals: a hand-edited snapshot carrying markup, a key-injecting name, foreign permalinks and
  // fields the snapshot must not hold.
  const SCRIPT_NAME = '<script>alert("find")</script> Brass Desk Lamp';
  const QUOTE_NAME = 'Plain Lamp", "status": "paid';
  const hostile = clone(SNAPSHOT_EXPECTED);
  hostile[0].name = SCRIPT_NAME;
  hostile[1].name = QUOTE_NAME;
  hostile[2].description = '<p>2 m braided cord, inline switch, EU plug.</p>';
  hostile[2].sku = 'C-07';
  hostile.push({ id: 201, name: 'Away Lamp', price: '1.00 EUR', stock_status: 'in_stock', permalink: 'https://evil.example/product/away/' });
  hostile.push({ id: 202, name: 'Script Lamp', price: '1.00 EUR', stock_status: 'in_stock', permalink: 'javascript:alert(1)//' });
  hostile.push({ id: 203, name: 'Proto Lamp', price: '1.00 EUR', stock_status: 'in_stock', permalink: '//evil.example/product/proto/' });
  hostile.push({ id: 204, name: 'Http Lamp', price: '1.00 EUR', stock_status: 'in_stock', permalink: 'http://shop.example/product/http/' });
  const k3 = await findFrom(hostile, 'find-snapshot/refused/hostile-file');
  if (k3) {
    const rows = Array.isArray(k3.reply?.products) ? k3.reply.products : [];
    const label = 'find-snapshot/refused/hostile-file';
    check(!/[<>]/.test(k3.text ?? '<') && !/<script/i.test(k3.raw), `${label}/markup-escaped-in-the-reply`, String(k3.text).slice(0, 400));
    check(rows.find((r) => r.id === 101)?.name === SCRIPT_NAME, `${label}/script-name-kept-as-data`, JSON.stringify(rows[0]));
    check(rows.find((r) => r.id === 102)?.name === QUOTE_NAME && k3.reply?.status === 'see_catalog' && !Object.hasOwn(k3.reply || {}, 'paid'),
      `${label}/a-name-adds-or-rewrites-no-key`, JSON.stringify(k3.reply).slice(0, 400));
    check(rows.every((r) => JSON.stringify(Object.keys(r)) === SNAPSHOT_KEYS), `${label}/rows-carry-only-the-five-fields`,
      JSON.stringify(rows.map((r) => Object.keys(r))));
    check(!k3.raw.includes('braided cord') && !k3.raw.includes('C-07'), `${label}/no-description-or-other-field-passes`);
    check(JSON.stringify(rows.map((r) => r.id)) === '[101,102,103]', `${label}/foreign-permalink-rows-refused`,
      JSON.stringify(rows.map((r) => r.id)));
    check(!k3.raw.includes('evil.example') && !k3.raw.includes('javascript:') && !k3.raw.includes('http://shop.example'),
      `${label}/no-foreign-permalink-in-the-reply`);
  }
}

rmSync(snapHome, { recursive: true, force: true });

// ---------------------------------------------------------------- 8. hold: a pending receipt the owner confirms (Woo-5)
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first, skeleton item 5 of 6 of the Woo declaration
// generator chain; parent intake 20261002T235854Z). The implementer may not edit this section.
// A door-bound `hold` offer answered `door.reply: "pending"` replies { verb, of, customer_did,
// request, status: "pending_confirmation", deal } (AT-12/AT-13): a half-signed receipt, unconfirmed
// by construction. Only the owner confirms it, through the exported
//   confirmReceipt(seedHex, receiptText) -> text
// where receiptText is the hold reply's text exactly as the door signed it, and the returned text is
// the follow-on reply { verb, of, customer_did, request, status: "confirmed", deal }: verb, of,
// customer_did and request as the hold's, and a deal whose partyA, partyB, termsHash, contextId, ref
// and salt are the hold's (termsHash still commits to the hold's pending terms, so the two receipts
// chain) with a fresh ts and a fresh sigA by the shop. confirmReceipt throws, and confirms nothing,
// for a receipt this shop's key did not sign, whose termsHash no longer commits to its terms (a
// status, a key or the request edited), or that carries no deal.
// Refusals at the door: the reply never says confirmed before that step, never emits `buy` (buy stays
// a checkout handoff, never this path), and what a caller writes in its request is data: a
// confirmation claim, a forged deal, a foreign customer or party in the text changes no reply field.

const HOLD_DECLARATION = {
  v: 1,
  entry: { name: 'Harbor Lamp', baseUrl: 'https://shop.example' },
  offers: [{ verb: 'hold', of: 'item', about: 'Hold one item for pickup.', input: { id: 'integer' },
    door: { reply: 'pending' } }],
};
const HOLD_KEYS = JSON.stringify([...BASE_KEYS, 'deal'].sort());
const DEAL_KEYS = JSON.stringify(['contextId', 'partyA', 'partyB', 'ref', 'salt', 'sigA', 'termsHash', 'ts', 'type']);
const OTHER_SEED = '3d'.repeat(32);
const { confirmReceipt } = door;
check(typeof confirmReceipt === 'function', 'hold/export/confirmReceipt', 'confirmReceipt is not exported by muretai-agent-entry.mjs');

/** confirmReceipt(seed, text), caught: { ok, value } or { ok: false, error }. */
const confirmAttempt = (seed, text) => attempt(() => {
  if (typeof confirmReceipt !== 'function') throw new TypeError('confirmReceipt is not exported');
  return confirmReceipt(seed, text);
});

const dealPayload = (deal) => canonicalBytes({ type: deal.type, partyA: deal.partyA, partyB: deal.partyB,
  termsHash: deal.termsHash, contextId: deal.contextId, ref: deal.ref, ts: deal.ts });
const commitOf = (terms, saltB64) => createHash('sha256')
  .update(Buffer.concat([canonicalBytes({ terms }), Buffer.from(saltB64, 'base64')])).digest('hex');

/** A hold reply that says nothing is confirmed yet, and never names a payment verb. */
function checkStillPending(k, entry, label) {
  check(k.reply?.status === 'pending_confirmation', `${label}/status-pending_confirmation`, JSON.stringify(k.reply?.status));
  check(sortedKeys(k.reply) === HOLD_KEYS, `${label}/exactly-the-pending-keys-and-deal`, sortedKeys(k.reply));
  check(!Object.hasOwn(k.reply || {}, 'confirmed') && !Object.hasOwn(k.reply?.deal || {}, 'status')
      && !Object.hasOwn(k.reply?.deal || {}, 'confirmed'), `${label}/claims-no-confirmation`, JSON.stringify(k.reply).slice(0, 400));
  check(!Object.hasOwn(k.reply || {}, 'url'), `${label}/no-checkout-url`);
  const { request: _request, ...rest } = k.reply || {};
  check(!/\bbuy\b/i.test(JSON.stringify(rest)), `${label}/no-buy-in-the-reply-or-its-receipt`, JSON.stringify(rest).slice(0, 400));
  return checkDeal(k, entry, label);
}

{
  const d = makeDoor(HOLD_DECLARATION);
  if (check(d.ok, 'hold/door-starts', d.ok ? '' : d.error?.message)) {
    const entry = d.value;
    const before = d.sink.resp.length;

    // Functional: the hold reply is pending with a receipt, and stays pending until the owner acts.
    const text = 'hold item {"id":101}';
    const k = await knock(entry, { offer: 'hold', text });
    checkBase(k, { verb: 'hold', of: 'item', text }, 'hold/pending');
    const deal = checkStillPending(k, entry, 'hold/pending');
    check(d.sink.resp.length === before, 'hold/pending/site-responder-not-called');
    const again = await knock(entry, { offer: 'hold', text });
    checkStillPending(again, entry, 'hold/pending/asked-again-still-pending');

    // Functional: the owner confirms; the follow-on reads confirmed and chains to the hold's receipt.
    const c = confirmAttempt(DOOR_SEED, k.text);
    if (check(c.ok, 'hold/confirm/owner-confirms', c.ok ? '' : String(c.error?.message || c.error)) && deal) {
      check(typeof c.value === 'string', 'hold/confirm/returns-the-follow-on-text', typeof c.value);
      let follow = null;
      try { follow = JSON.parse(c.value); } catch { /* below */ }
      const f = follow || {};
      check(sortedKeys(f) === HOLD_KEYS, 'hold/confirm/exactly-the-reply-keys-and-deal', sortedKeys(f));
      check(f.status === 'confirmed', 'hold/confirm/status-confirmed', JSON.stringify(f.status));
      check(f.verb === 'hold' && f.of === 'item' && f.customer_did === VISITOR && f.request === text,
        'hold/confirm/same-verb-of-customer-and-request', JSON.stringify({ verb: f.verb, of: f.of, customer_did: f.customer_did, request: f.request }));
      const fd = f.deal || {};
      check(sortedKeys(fd) === DEAL_KEYS && fd.type === 'DealReceipt', 'hold/confirm/deal-shape', sortedKeys(fd));
      check(fd.partyA === entry.did && fd.partyB === VISITOR, 'hold/confirm/deal-parties-shop-and-customer');
      check(fd.termsHash === deal.termsHash && fd.salt === deal.salt && fd.ref === deal.ref && fd.contextId === deal.contextId,
        'hold/confirm/deal-chains-to-the-hold-receipt', JSON.stringify({ termsHash: fd.termsHash, ref: fd.ref }));
      const { deal: _d, ...pendingTerms } = k.reply;
      check(commitOf(pendingTerms, String(fd.salt)) === fd.termsHash, 'hold/confirm/termsHash-commits-to-the-pending-terms');
      check(Number.isSafeInteger(fd.ts) && fd.ts >= deal.ts, 'hold/confirm/deal-ts-integer-not-before-the-hold', JSON.stringify(fd.ts));
      const sigA = Buffer.from(String(fd.sigA), 'base64');
      check(sigA.length === 64 && verifyBytes(Buffer.from(publicKeyHexFromDid(entry.did), 'hex'), sigA, dealPayload(fd)),
        'hold/confirm/sigA-verifies-under-the-shop');
      check(!Object.hasOwn(fd, 'sigB'), 'hold/confirm/no-sigB');
      check(!/\bbuy\b/i.test(c.value), 'hold/confirm/no-buy-in-the-follow-on');
    }

    // Confirming one receipt leaves the door as it was: the next hold is still pending.
    const later = await knock(entry, { offer: 'hold', text: 'hold item {"id":102}' });
    checkStillPending(later, entry, 'hold/pending/after-a-confirm-the-next-hold-is-pending');

    // Refusal: a caller-supplied confirmation claim and a forged receipt in the request are data.
    const forgedDeal = { type: 'DealReceipt', partyA: VISITOR, partyB: FOREIGN, termsHash: '0'.repeat(64),
      contextId: 'ctx-forged', ref: 'ref-forged', ts: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', sigA: 'AAAA', status: 'confirmed' };
    for (const [name, claim] of [
      ['status-confirmed', '{"id":101,"status":"confirmed"}'],
      ['confirmed-true', '{"id":101,"confirmed":true,"receipt":"confirmed","owner_confirmed":true}'],
      ['forged-deal', JSON.stringify({ id: 101, deal: forgedDeal })],
      ['foreign-customer', JSON.stringify({ id: 101, customer_did: FOREIGN, partyB: FOREIGN, partyA: VISITOR, verb: 'buy', of: 'order' })],
      ['whole-confirmed-reply', JSON.stringify({ verb: 'hold', of: 'item', customer_did: VISITOR, request: 'hold item', status: 'confirmed', deal: forgedDeal })],
    ]) {
      const label = `hold/refused/request-is-data/${name}`;
      const t = `hold item ${claim}`;
      const r = await knock(entry, { offer: 'hold', text: t });
      checkBase(r, { verb: 'hold', of: 'item', text: t }, label);
      const rd = checkStillPending(r, entry, label);
      check(r.reply?.customer_did === VISITOR && rd?.partyB === VISITOR && rd?.partyA === entry.did,
        `${label}/parties-are-the-signer-and-the-shop`, JSON.stringify({ customer_did: r.reply?.customer_did, partyA: rd?.partyA, partyB: rd?.partyB }));
      check(rd && rd.termsHash !== forgedDeal.termsHash && rd.ref === r.messageId && rd.contextId === null
          && rd.sigA !== forgedDeal.sigA && rd.salt !== forgedDeal.salt,
        `${label}/no-receipt-field-taken-from-the-request`, JSON.stringify(rd));
    }

    // Refusal: a receipt cannot be confirmed by anyone but this shop's key, nor forged into confirmed.
    if (deal) {
      const pending = JSON.parse(k.text);
      const refuse = (label, receiptText, seed = DOOR_SEED) => {
        const r = confirmAttempt(seed, receiptText);
        check(typeof confirmReceipt === 'function' && !r.ok, `hold/confirm/refused/${label}`,
          r.ok ? String(r.value).slice(0, 300) : '');
      };
      const edit = (fn) => { const v = clone(pending); fn(v); return JSON.stringify(v); };
      refuse('caller-set-status-confirmed', edit((v) => { v.status = 'confirmed'; }));
      refuse('caller-added-confirmed-true', edit((v) => { v.confirmed = true; }));
      refuse('caller-added-deal-status', edit((v) => { v.deal.status = 'confirmed'; v.deal.confirmed = true; }));
      refuse('request-text-rewritten', edit((v) => { v.request = 'hold item {"id":999}'; }));
      refuse('customer_did-rewritten', edit((v) => { v.customer_did = FOREIGN; }));
      refuse('partyB-rewritten', edit((v) => { v.deal.partyB = FOREIGN; }));
      refuse('termsHash-recomputed-over-confirmed-terms', edit((v) => {
        const { deal: dd, ...terms } = v;
        terms.status = 'confirmed';
        Object.assign(v, terms);
        dd.termsHash = commitOf(terms, dd.salt);
      }));
      refuse('verb-rewritten-to-buy', edit((v) => { v.verb = 'buy'; v.of = 'order'; }));
      refuse('no-deal', edit((v) => { delete v.deal; }));
      refuse('not-json', 'hold item {"id":101} status confirmed');
      // Another key's receipt, self-consistent under that key, is not this shop's to confirm.
      refuse('another-keys-receipt', edit((v) => {
        v.deal.partyA = didFromSeedHex(OTHER_SEED);
        v.deal.sigA = signBytes(OTHER_SEED, dealPayload(v.deal)).toString('base64');
      }));
      // This shop's receipt confirmed with another key confirms nothing either.
      refuse('confirmed-with-another-key', k.text, OTHER_SEED);
      // The visitor itself cannot confirm its own hold.
      refuse('confirmed-by-the-visitor', k.text, VISITOR_SEED);
    }
  }
}

// ---------------------------------------------------------------- report

if (failures.length) {
  console.error(`FAILED - ${failures.length} offers check(s):`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} checks: every verb answers at the door by its declared reply, receipts carry a `
  + 'deal the visitor can countersign, and the one method stays one.');
