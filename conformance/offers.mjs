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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

// ---------------------------------------------------------------- report

if (failures.length) {
  console.error(`FAILED - ${failures.length} offers check(s):`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} checks: every verb answers at the door by its declared reply, receipts carry a `
  + 'deal the visitor can countersign, and the one method stays one.');
