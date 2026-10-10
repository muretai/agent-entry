#!/usr/bin/env node
// Agent Entry Suite S1: the collector route `POST /.well-known/agent-tools/events`.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first pair; see conformance/tools.mjs for the frame).
// Design section 5: same-origin sendBeacon, <= 2 KB, <= 100 events per session, allowlisted
// names, no DID / free text / input values, 204, never on the ledger, each event handed to
// `observer(env)` with `stage: "page"` and the door's usual ua_family / client_class /
// ip_vendor / country. Everything else under the prefix stays 404 (AE-4, in tools.mjs).
//
// What is pinned here:
//   body   = { "session": <[A-Za-z0-9_-]{8,64}>, "events": [ <event>, ... ] }
//   event  = { "name": <COLLECTOR_EVENTS>, "offer"?: <a declared offer id>,
//              "engine"?: <REFERRAL_ENGINES>, "ms"?: <integer 0..600000> } and nothing else
//   A body with ANY bad part is refused whole: no event of it reaches the observer.
//   Cross-origin (or no Origin) -> 403. Over 2048 bytes -> 413. Other refusals -> 4xx.
//   observer env = { stage: "page", event, offer, engine, ms, ua_family, client_class,
//                    ip_vendor, country, ... } with no DID and no text.
//
// Agent Entry S6a-2 (split 2 of 4 of intake 20261002T130609Z), section 8 below, WRITTEN BEFORE
// THE IMPLEMENTATION: a door whose declaration names `entry.counts` (an absolute https URL, S6a-1)
// also POSTs the SAME AT-14 body to that URL, best-effort and non-blocking exactly as gaSink is.
//   - One POST per accepted beacon that counted at least one event, to exactly entry.counts,
//     with `Origin` = the beacon's (already checked) origin, because trunk's collector
//     (agent/shopcounts.py origin_ok) takes only the shop's own origin.
//   - body = { "session": <the beacon's session>, "events": <the events the door COUNTED> }:
//     the per-session cap trims it (events past 100 are not sent), and a refused beacon sends
//     nothing. Nothing else rides along: no DID, no text, no input value, no address, no
//     ua_family / ip_vendor / country, no page header. <= 2048 bytes, <= 100 events.
//   - The bytes are ones trunk's collector accepts: parseBeaconTrunk below is a line-for-line
//     JS twin of agent/shopcounts.py parse_beacon (trunk S5, 94b76839). That holds for the bytes
//     the door WRITES, not the ones the page sent: a number spelled "6e5" grows when re-serialized,
//     and an offer the door takes (a verb outside the registry, an id over 64) is one trunk
//     refuses the whole body over (8j, 8k).
//   - The door stays one file with no dependency and vendor/agent-seam is untouched (8l).
//   - Fire-and-forget: a slow, hanging, throwing, rejecting or non-2xx sink never delays the
//     204 or a signed reply, never changes one byte of either, is never retried, and never
//     surfaces as an unhandled rejection. No entry.counts -> no request at all.
//   The door reaches the network through globalThis.fetch (read no earlier than createAgentEntry,
//   as gaSink's default is), so the stub below sees every byte that would leave.
import * as door from '../muretai-agent-entry.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(HERE, 'vectors-tools.json'), 'utf8'));
const { createAgentEntry, didFromSeedHex } = door;

const EVENTS = '/.well-known/agent-tools/events';
const ORIGIN = 'https://shop.example';
const SOCKET = '198.51.100.23';
const FORGED_CF_IP = '203.0.113.77';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const A_DID = didFromSeedHex('99'.repeat(32));

let passed = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${detail}` : ''}`);
  return false;
}

const harbor = VECTORS.vectors.find((v) => v.name === 'harbor-lamp-every-reply-kind-and-facts');

function makeDoor(extra = {}) {
  const sink = { obs: [] };
  let entry = null;
  let error = null;
  try {
    entry = createAgentEntry({
      seedHex: 'd5'.repeat(32), name: 'Harbor Lamp', baseUrl: ORIGIN,
      declaration: JSON.parse(JSON.stringify(harbor.declaration)),
      trustProxy: true, vendorRanges: { openai: ['203.0.113.0/24'], fly: ['198.51.100.0/24'] },
      observer: (env) => { sink.obs.push(env); },
      ...extra,
    });
  } catch (e) { error = e; }
  return { entry, error, sink };
}

const BEACON = {
  origin: ORIGIN,
  'content-type': 'text/plain;charset=UTF-8',
  'user-agent': CHROME,
  'cf-connecting-ip': FORGED_CF_IP,
  'cf-ipcountry': 'JP',
  'sec-fetch-site': 'same-origin',
};

async function post(entry, body, headers = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const out = await entry.handleRequestAsync('POST', EVENTS, { ...BEACON, ...headers }, buffer, { remoteAddress: SOCKET });
  return { ...out, text: Buffer.from(out.body || '').toString('utf8') };
}

const pageEvents = (sink) => sink.obs.filter((e) => e.stage === 'page');
let sessionSeq = 0;
const session = () => `tab-${String(++sessionSeq).padStart(8, '0')}`;

// ---------------------------------------------------------------- 1. vocabulary

{
  const events = ['page_ready', 'referral', 'offer_registered', 'offer_started', 'offer_succeeded',
    'offer_failed', 'ask_denied', 'handoff'];
  const engines = ['chatgpt', 'claude', 'perplexity', 'gemini', 'copilot', 'grok', 'deepseek', 'mistral',
    'you', 'other'];
  check(JSON.stringify(door.COLLECTOR_EVENTS) === JSON.stringify(events), 'vocabulary/COLLECTOR_EVENTS',
    JSON.stringify(door.COLLECTOR_EVENTS));
  check(JSON.stringify(door.REFERRAL_ENGINES) === JSON.stringify(engines), 'vocabulary/REFERRAL_ENGINES',
    JSON.stringify(door.REFERRAL_ENGINES));
  check(door.COLLECTOR_MAX_BODY_BYTES === 2048, 'vocabulary/COLLECTOR_MAX_BODY_BYTES-2048',
    String(door.COLLECTOR_MAX_BODY_BYTES));
  check(door.COLLECTOR_MAX_EVENTS_PER_SESSION === 100, 'vocabulary/COLLECTOR_MAX_EVENTS_PER_SESSION-100',
    String(door.COLLECTOR_MAX_EVENTS_PER_SESSION));
  check(Object.isFrozen(door.COLLECTOR_EVENTS ?? {}) && Object.isFrozen(door.REFERRAL_ENGINES ?? {}),
    'vocabulary/tables-are-frozen');
}

// ---------------------------------------------------------------- 2. an accepted beacon

{
  const { entry, error, sink } = makeDoor();
  if (check(entry !== null, 'door/starts-with-a-declaration', error?.message)) {
    const s = session();
    const out = await post(entry, {
      session: s,
      events: [
        { name: 'page_ready' },
        { name: 'referral', engine: 'claude' },
        { name: 'offer_started', offer: 'hold_item' },
        { name: 'offer_succeeded', offer: 'hold_item', ms: 120 },
        { name: 'handoff', offer: 'hold_item' },
      ],
    });
    check(out.status === 204 && out.text === '', 'accept/204-no-body', `HTTP ${out.status} ${out.text}`);
    const got = pageEvents(sink);
    check(got.length === 5, 'accept/each-event-reaches-the-observer', `got ${got.length}`);
    check(JSON.stringify(got.map((e) => e.event))
        === JSON.stringify(['page_ready', 'referral', 'offer_started', 'offer_succeeded', 'handoff']),
      'accept/events-in-order', JSON.stringify(got.map((e) => e.event)));
    check(got[1]?.engine === 'claude' && got[2]?.offer === 'hold_item' && got[3]?.ms === 120,
      'accept/offer-engine-ms-carried', JSON.stringify(got.slice(1, 4)));
    for (const [i, env] of got.entries()) {
      const label = `accept/env-${i}`;
      check(env.stage === 'page', `${label}/stage-page`);
      check(typeof env.ua_family === 'string' && typeof env.client_class === 'string',
        `${label}/ua_family-and-client_class`);
      check(env.ip_vendor === 'openai' && env.country === 'JP', `${label}/ip_vendor-and-country`,
        JSON.stringify({ ip_vendor: env.ip_vendor, country: env.country }));
      check((env.peer_did ?? null) === null && (env.owner_did ?? null) === null && (env.text ?? null) === null,
        `${label}/no-did-no-text`);
      const flat = JSON.stringify(env);
      check(!flat.includes('did:key:') && !flat.includes(FORGED_CF_IP) && !flat.includes(SOCKET),
        `${label}/no-did-no-address`, flat);
    }
    check(entry.ledger.size === 0, 'accept/never-on-the-ledger', `ledger ${entry.ledger.size}`);

    const json = await post(entry, { session: session(), events: [{ name: 'page_ready' }] },
      { 'content-type': 'application/json' });
    check(json.status === 204, 'accept/application-json-too', `HTTP ${json.status}`);

    // An observer that throws cannot change the answer (the hook is never a verdict).
    const loud = makeDoor({ observer: () => { throw new Error('observer blew up'); } });
    if (loud.entry) {
      const o = await post(loud.entry, { session: session(), events: [{ name: 'page_ready' }] });
      check(o.status === 204, 'accept/throwing-observer-still-204', `HTTP ${o.status}`);
    }
  }
}

// ---------------------------------------------------------------- 3. same-origin only

{
  const { entry, sink } = makeDoor();
  if (entry) {
    for (const [label, headers] of [
      ['foreign-origin', { origin: 'https://evil.example' }],
      ['http-scheme', { origin: 'http://shop.example' }],
      ['other-port', { origin: 'https://shop.example:8443' }],
      ['suffix-host', { origin: 'https://shop.example.evil.example' }],
      ['opaque-null-origin', { origin: 'null' }],
      ['no-origin', { origin: undefined }],
      ['cross-site-fetch', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }],
    ]) {
      const hdrs = { ...BEACON, ...headers };
      if (hdrs.origin === undefined) delete hdrs.origin;
      const out = await entry.handleRequestAsync('POST', EVENTS, hdrs,
        Buffer.from(JSON.stringify({ session: session(), events: [{ name: 'page_ready' }] })),
        { remoteAddress: SOCKET });
      check(out.status === 403, `origin/${label}-403`, `HTTP ${out.status}`);
    }
    check(pageEvents(sink).length === 0, 'origin/refused-beacons-never-reach-the-observer',
      `got ${pageEvents(sink).length}`);
  }
}

// ---------------------------------------------------------------- 4. body size

{
  const { entry, sink } = makeDoor();
  if (entry) {
    const many = (n, s) => JSON.stringify({ session: s,
      events: Array.from({ length: n }, () => ({ name: 'offer_started', offer: 'hold_item' })) });
    let fits = 1;
    while (Buffer.byteLength(many(fits + 1, 'tab-sizes000'), 'utf8') <= 2048) fits += 1;
    const small = many(fits, 'tab-sizes000');
    const large = many(fits + 1, 'tab-sizes001');
    check(Buffer.byteLength(small) <= 2048 && Buffer.byteLength(large) > 2048 && fits + 1 <= 100,
      'size/fixture-straddles-2048', `${Buffer.byteLength(small)} / ${Buffer.byteLength(large)}`);
    const ok = await post(entry, small);
    check(ok.status === 204, `size/${Buffer.byteLength(small)}-bytes-accepted`, `HTTP ${ok.status}`);
    const before = pageEvents(sink).length;
    const big = await post(entry, large);
    check(big.status === 413, `size/${Buffer.byteLength(large)}-bytes-413`, `HTTP ${big.status}`);
    check(pageEvents(sink).length === before, 'size/oversize-reaches-no-observer');
    const huge = await post(entry, Buffer.alloc(1024 * 512, 0x20));
    check(huge.status === 413, 'size/half-a-megabyte-413-before-parsing', `HTTP ${huge.status}`);
  }
}

// ---------------------------------------------------------------- 5. 100 events per session

{
  const { entry, sink } = makeDoor();
  if (entry) {
    const s = 'tab-capped00';
    const forty = { session: s, events: Array.from({ length: 40 }, () => ({ name: 'page_ready' })) };
    for (let i = 0; i < 3; i += 1) await post(entry, forty);
    await post(entry, { session: s, events: [{ name: 'page_ready' }] });
    const counted = pageEvents(sink).length;
    check(counted === 100, 'session/at-most-100-events-reach-the-observer', `got ${counted}`);
    const other = await post(entry, { session: 'tab-another0', events: [{ name: 'page_ready' }] });
    check(other.status === 204 && pageEvents(sink).length === 101,
      'session/the-cap-is-per-session-not-per-door', `HTTP ${other.status}, ${pageEvents(sink).length}`);
    const tooMany = await post(entry, { session: 'tab-toomany0',
      events: Array.from({ length: 101 }, () => ({ name: 'page_ready' })) });
    check(tooMany.status >= 400 && tooMany.status < 500 && pageEvents(sink).length === 101,
      'session/one-body-of-101-events-refused', `HTTP ${tooMany.status}`);
  }
}

// ---------------------------------------------------------------- 6. allowlist and forbidden fields

{
  const { entry, sink } = makeDoor();
  if (entry) {
    const refused = async (label, body) => {
      const before = pageEvents(sink).length;
      const out = await post(entry, body);
      check(out.status >= 400 && out.status < 500 && out.status !== 404, `refuse/${label}/4xx`, `HTTP ${out.status}`);
      check(pageEvents(sink).length === before, `refuse/${label}/nothing-observed`);
      return out;
    };
    const one = (event, extra = {}) => ({ session: session(), events: [event], ...extra });

    for (const name of ['tool_started', 'sdk_ready', 'PAGE_READY', 'page_ready ', 'page-ready', '', 'custom',
      'did:key:z6MkName']) {
      await refused(`name-${JSON.stringify(name)}`, one({ name }));
    }
    await refused('name-missing', one({ offer: 'hold_item' }));
    await refused('name-not-a-string', one({ name: 7 }));

    // No DID, no free text, no input values: any field outside the four is refused.
    for (const [field, value] of [
      ['did', A_DID], ['customer_did', A_DID], ['peer_did', A_DID], ['from', A_DID],
      ['text', 'Do you have a table Saturday?'], ['message', 'hello'], ['q', 'brass lamp'],
      ['input', { sku: 'L-12' }], ['sku', 'L-12'], ['value', 'L-12'], ['email', 'a@b.example'],
      ['url', 'https://shop.example/product/l-12?name=Ada'], ['args', ['L-12']],
    ]) {
      await refused(`field-${field}`, one({ name: 'offer_started', offer: 'hold_item', [field]: value }));
    }
    await refused('offer-is-a-did', one({ name: 'offer_started', offer: A_DID }));
    await refused('offer-not-declared', one({ name: 'offer_started', offer: 'teleport_now' }));
    await refused('offer-free-text', one({ name: 'offer_started', offer: 'hold the brass lamp for Ada' }));
    await refused('engine-free-text', one({ name: 'referral', engine: 'my friend told me' }));
    await refused('engine-case', one({ name: 'referral', engine: 'Claude' }));
    for (const ms of [-1, 1.5, '120', 600001]) {
      await refused(`ms-${JSON.stringify(ms)}`, one({ name: 'offer_succeeded', offer: 'hold_item', ms }));
    }

    // The envelope around the events.
    await refused('session-missing', { events: [{ name: 'page_ready' }] });
    await refused('session-is-a-did', { session: A_DID, events: [{ name: 'page_ready' }] });
    await refused('session-too-short', { session: 'tab', events: [{ name: 'page_ready' }] });
    await refused('session-free-text', { session: 'Ada Lovelace table 4', events: [{ name: 'page_ready' }] });
    await refused('top-level-did', one({ name: 'page_ready' }, { did: A_DID }));
    await refused('top-level-text', one({ name: 'page_ready' }, { text: 'hello' }));
    await refused('events-not-an-array', { session: session(), events: { name: 'page_ready' } });
    await refused('event-not-an-object', { session: session(), events: ['page_ready'] });
    await refused('body-is-an-array', [{ name: 'page_ready' }]);
    await refused('body-not-json', '{"session":');
    await refused('body-bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify(one({ name: 'page_ready' })))]));

    // Refused whole: one bad event poisons the body, the good ones are not observed either.
    await refused('one-bad-event-refuses-the-body', { session: session(),
      events: [{ name: 'page_ready' }, { name: 'offer_started', offer: 'hold_item', text: 'secret' }] });

    // A refusal never echoes what the page sent (AE-21).
    const marker = 'ZZ-marker-4417';
    const echoed = await refused('marker', one({ name: marker }));
    check(!echoed.text.includes(marker), 'refuse/marker-not-echoed', echoed.text);

    check(entry.ledger.size === 0, 'refuse/never-on-the-ledger');
  }
}

// ---------------------------------------------------------------- 7. methods

{
  const { entry } = makeDoor();
  if (entry) {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const out = await entry.handleRequestAsync(method, EVENTS, BEACON, Buffer.from('{}'), { remoteAddress: SOCKET });
      const allow = Object.entries(out.headers || {}).find(([k]) => k.toLowerCase() === 'allow')?.[1];
      check(out.status === 405 && allow === 'POST, OPTIONS', `methods/${method}-405-allow-post`,
        `HTTP ${out.status} Allow=${allow}`);
    }
  }
}

// ---------------------------------------------------------------- 8. entry.counts: the door posts the same body (S6a-2)

// agent/shopcounts.py parse_beacon (trunk S5, 94b76839), twinned: the hosted collector's verdict
// on a body. True when trunk would count it, false when it refuses the whole body.
const TRUNK_EVENT_NAMES = ['page_ready', 'referral', 'offer_registered', 'offer_started',
  'offer_succeeded', 'offer_failed', 'ask_denied', 'handoff'];
const TRUNK_ENGINES = ['chatgpt', 'claude', 'perplexity', 'gemini', 'copilot', 'grok', 'deepseek',
  'mistral', 'you', 'other'];
const TRUNK_VERBS = ['find', 'ask', 'quote', 'book', 'hold', 'order', 'buy', 'track', 'change', 'cancel', 'join'];
const TRUNK_OFFER = new RegExp(`^(${TRUNK_VERBS.join('|')})_[a-z][a-z0-9_]*$`);
const TRUNK_SESSION = /^[A-Za-z0-9_-]{8,64}$/;

function parseBeaconTrunk(raw) {
  if (raw.length > 2048) return false;
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return false;
  let doc;
  try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return false; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  if (JSON.stringify(Object.keys(doc).sort()) !== '["events","session"]') return false;
  if (typeof doc.session !== 'string' || !TRUNK_SESSION.test(doc.session)) return false;
  if (!Array.isArray(doc.events) || doc.events.length === 0 || doc.events.length > 100) return false;
  for (const e of doc.events) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    if (Object.keys(e).some((k) => !['name', 'offer', 'engine', 'ms'].includes(k)) || !('name' in e)) return false;
    if (typeof e.name !== 'string' || !TRUNK_EVENT_NAMES.includes(e.name)) return false;
    if ('offer' in e && (typeof e.offer !== 'string' || e.offer.length > 64 || !TRUNK_OFFER.test(e.offer))) return false;
    if ('engine' in e && (typeof e.engine !== 'string' || !TRUNK_ENGINES.includes(e.engine))) return false;
    if ('ms' in e && !(Number.isInteger(e.ms) && e.ms >= 0 && e.ms <= 600000)) return false;
  }
  return true;
}

// The twin itself is pinned first, so a wrong twin cannot make a wrong post look right.
{
  const t = (v) => parseBeaconTrunk(Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
  check(t({ session: 'tab-twin0000', events: [{ name: 'offer_succeeded', offer: 'hold_item', ms: 3 }] }),
    'counts/trunk-twin/accepts-a-good-body');
  check(!t({ session: 'tab-twin0000', events: [{ name: 'page_ready' }], ua_family: 'chrome' }),
    'counts/trunk-twin/refuses-an-extra-top-level-key');
  check(!t({ session: 'tab-twin0000', events: [{ name: 'page_ready', did: A_DID }] }),
    'counts/trunk-twin/refuses-an-extra-event-key');
  check(!t({ session: 'tab-twin0000', events: [] }), 'counts/trunk-twin/refuses-no-events');
  check(!t({ session: 'tab-twin0000', events: Array.from({ length: 101 }, () => ({ name: 'page_ready' })) }),
    'counts/trunk-twin/refuses-101-events');
  check(!t({ session: 'tab-twin0000', events: [{ name: 'offer_started', offer: 'teleport' }] }),
    'counts/trunk-twin/refuses-an-offer-off-the-registry');
}

const COUNTS = 'https://counts.muretai.example/shops/harbor-lamp/.well-known/agent-tools/events';
const realFetch = globalThis.fetch;
const wire = { mode: 'ok', calls: [] };
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled += 1; });

const headerObject = (h) => {
  try { return Object.fromEntries(new Headers(h || {})); } catch { return { unreadable: String(h) }; }
};
const bodyBytes = (b) => {
  if (b === undefined || b === null) return Buffer.alloc(0);
  if (typeof b === 'string') return Buffer.from(b, 'utf8');
  if (b instanceof ArrayBuffer) return Buffer.from(b);
  if (ArrayBuffer.isView(b)) return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  return Buffer.from(String(b), 'utf8');
};

globalThis.fetch = function countsFetchStub(url, init = {}) {
  wire.calls.push({
    url: typeof url === 'string' ? url : (url?.url ?? String(url)),
    method: String(init.method || 'GET').toUpperCase(),
    headers: headerObject(init.headers),
    body: bodyBytes(init.body),
  });
  switch (wire.mode) {
    case 'throw': throw new Error('the counts sink is unreachable');
    case 'reject': return Promise.reject(new Error('ECONNREFUSED counts sink'));
    case 'timeout': return new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), 20).unref();
    });
    case 'hang': return new Promise(() => {});
    case 'slow': return new Promise((done) => {
      setTimeout(() => done(new Response(null, { status: 204 })), 3000).unref();
    });
    case '500': return Promise.resolve(new Response('{"error":"down"}', { status: 500 }));
    case '404': return Promise.resolve(new Response('', { status: 404 }));
    default: return Promise.resolve(new Response(null, { status: 204 }));
  }
};

const settle = (ms = 40) => new Promise((done) => setTimeout(done, ms));
const LATE = Symbol('late');
async function inTime(promise, ms = 1000) {
  let timer;
  const late = new Promise((done) => { timer = setTimeout(() => done(LATE), ms); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

function countsDeclaration(counts = COUNTS) {
  const declaration = JSON.parse(JSON.stringify(harbor.declaration));
  if (counts !== null) declaration.entry.counts = counts;
  return declaration;
}
const countsDoor = (extra = {}) => makeDoor({ declaration: countsDeclaration(), signedRatePerMin: 0,
  signedRatePerMinTotal: 0, ...extra });
// null, not undefined: undefined would take the default and give the plain door entry.counts too.
const plainDoor = (extra = {}) => makeDoor({ declaration: countsDeclaration(null), signedRatePerMin: 0,
  signedRatePerMinTotal: 0, ...extra });

const sameResponse = (a, b) => a.status === b.status
  && JSON.stringify(a.headers || {}) === JSON.stringify(b.headers || {})
  && Buffer.compare(Buffer.from(a.body || ''), Buffer.from(b.body || '')) === 0;

const parsed = (call) => { try { return JSON.parse(call.body.toString('utf8')); } catch { return null; } };
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const COOKIE = 'wp_session=ZZ-cookie-5521';

/** What a post may never carry, in its body or its headers. */
function checkClean(call, label) {
  const flatBody = call.body.toString('utf8');
  const flatHeaders = JSON.stringify(call.headers);
  for (const [what, needle] of [['did', 'did:key:'], ['forged-address', FORGED_CF_IP], ['socket-address', SOCKET],
    ['cookie', 'ZZ-cookie-5521'], ['user-agent', 'Chrome/140.0'], ['knock-text', 'ZZ-knock-text-8830']]) {
    check(!flatBody.includes(needle), `${label}/body-carries-no-${what}`, flatBody);
    check(!flatHeaders.includes(needle), `${label}/headers-carry-no-${what}`, flatHeaders);
  }
  for (const field of ['stage', 'ua_family', 'client_class', 'ip_vendor', 'country', 'signature_agent',
    'peer_did', 'owner_did', 'wba_did', 'text', 'identified', 'verified']) {
    check(!new RegExp(`"${field}"\\s*:`).test(flatBody), `${label}/body-has-no-${field}`, flatBody);
  }
  check(call.body.length <= 2048, `${label}/at-most-2048-bytes`, String(call.body.length));
  const doc = parsed(call);
  check(Array.isArray(doc?.events) && doc.events.length <= 100, `${label}/at-most-100-events`);
  check(parseBeaconTrunk(call.body), `${label}/trunk-shopcounts-accepts-the-bytes`, flatBody);
}

// 8a. No entry.counts, no request: the hosted dashboard is opt-in.
{
  wire.mode = 'ok';
  const before = wire.calls.length;
  const { entry, error } = plainDoor();
  if (check(entry !== null, 'counts/plain-door-starts', error?.message)) {
    const out = await post(entry, { session: session(), events: [{ name: 'page_ready' }] });
    await settle();
    check(out.status === 204, 'counts/plain-door-204', `HTTP ${out.status}`);
    check(wire.calls.length === before, 'counts/no-entry-counts-sends-nothing', `${wire.calls.length - before} request(s)`);
  }
}

// 8b. An accepted beacon is posted to entry.counts: the same session, the counted events, nothing else.
{
  wire.mode = 'ok';
  const { entry, error, sink } = countsDoor();
  const plain = plainDoor().entry;
  if (check(entry !== null && plain !== null, 'counts/door-with-entry-counts-starts', error?.message)) {
    const s = session();
    const events = [
      { name: 'page_ready' },
      { name: 'referral', engine: 'claude' },
      { name: 'offer_registered', offer: 'hold_item' },
      { name: 'offer_started', offer: 'hold_item' },
      { name: 'offer_succeeded', offer: 'hold_item', ms: 120 },
      { name: 'handoff', offer: 'hold_item' },
    ];
    const before = wire.calls.length;
    const out = await post(entry, { session: s, events }, { cookie: COOKIE });
    const base = await post(plain, { session: session(), events }, { cookie: COOKIE });
    check(sameResponse(out, base), 'counts/accept/the-204-is-the-plain-doors-204',
      `${out.status} ${JSON.stringify(out.headers)} vs ${base.status} ${JSON.stringify(base.headers)}`);
    check(pageEvents(sink).length === events.length, 'counts/accept/the-local-observer-still-sees-every-event',
      `got ${pageEvents(sink).length}`);
    await settle();
    const mine = wire.calls.slice(before);
    if (check(mine.length === 1, 'counts/accept/exactly-one-post-per-beacon', `${mine.length} request(s)`)) {
      const call = mine[0];
      check(call.url === COUNTS, 'counts/accept/posted-to-exactly-entry-counts', call.url);
      check(call.method === 'POST', 'counts/accept/method-POST', call.method);
      check(call.headers.origin === ORIGIN, 'counts/accept/origin-is-the-shops-own',
        JSON.stringify(call.headers.origin));
      const doc = parsed(call);
      check(doc !== null, 'counts/accept/body-is-json', call.body.toString('utf8'));
      check(JSON.stringify(Object.keys(doc || {}).sort()) === '["events","session"]',
        'counts/accept/body-is-session-and-events-only', JSON.stringify(Object.keys(doc || {})));
      check(doc?.session === s, 'counts/accept/the-pages-own-session', JSON.stringify(doc?.session));
      check(canon(doc?.events) === canon(events), 'counts/accept/the-same-events-in-order',
        JSON.stringify(doc?.events));
      checkClean(call, 'counts/accept');
    }
    check(entry.ledger.size === 0, 'counts/accept/never-on-the-ledger');
  }
}

// 8c. The per-session cap trims what is sent: 100 events per session reach entry.counts, no more.
{
  wire.mode = 'ok';
  const { entry } = countsDoor();
  if (entry) {
    const s = 'tab-capposted';
    const forty = { session: s, events: Array.from({ length: 40 }, () => ({ name: 'page_ready' })) };
    const sizes = [];
    for (let i = 0; i < 4; i += 1) {
      const before = wire.calls.length;
      const out = await post(entry, i < 3 ? forty : { session: s, events: [{ name: 'page_ready' }] });
      check(out.status === 204, `counts/cap/beacon-${i}-204`, `HTTP ${out.status}`);
      await settle();
      const mine = wire.calls.slice(before);
      sizes.push(mine.map((c) => parsed(c)?.events?.length ?? -1));
      for (const [j, c] of mine.entries()) checkClean(c, `counts/cap/beacon-${i}-post-${j}`);
    }
    check(JSON.stringify(sizes) === '[[40],[40],[20],[]]', 'counts/cap/40-40-20-then-nothing',
      JSON.stringify(sizes));
  }
}

// 8d. The largest beacon that fits is still a body trunk takes; nothing grows past 2048 on the way.
{
  wire.mode = 'ok';
  const { entry } = countsDoor();
  if (entry) {
    const many = (n, s) => JSON.stringify({ session: s,
      events: Array.from({ length: n }, (_, i) => ({ name: 'offer_succeeded', offer: 'hold_item', ms: 600000 - i })) });
    let fits = 1;
    while (Buffer.byteLength(many(fits + 1, 'tab-postsize00'), 'utf8') <= 2048) fits += 1;
    const before = wire.calls.length;
    const out = await post(entry, many(fits, 'tab-postsize00'));
    check(out.status === 204, 'counts/size/largest-beacon-204', `HTTP ${out.status}`);
    await settle();
    const mine = wire.calls.slice(before);
    if (check(mine.length === 1, 'counts/size/largest-beacon-posted-once', `${mine.length} request(s)`)) {
      checkClean(mine[0], 'counts/size');
      check(parsed(mine[0])?.events?.length === fits, 'counts/size/every-counted-event-sent',
        `${parsed(mine[0])?.events?.length} of ${fits}`);
    }
  }
}

// 8e. A refused beacon sends nothing: no part of it reaches entry.counts, trimmed or not.
{
  wire.mode = 'ok';
  const { entry } = countsDoor();
  if (entry) {
    const one = (event, extra = {}) => ({ session: session(), events: [event], ...extra });
    for (const [label, body, headers] of [
      ['oversize-413', JSON.stringify({ session: session(),
        events: Array.from({ length: 99 }, () => ({ name: 'offer_started', offer: 'hold_item' })) })],
      ['101-events', { session: session(), events: Array.from({ length: 101 }, () => ({ name: 'page_ready' })) }],
      ['foreign-origin', one({ name: 'page_ready' }), { origin: 'https://evil.example' }],
      ['no-origin', one({ name: 'page_ready' }), { origin: undefined }],
      ['event-did', one({ name: 'offer_started', offer: 'hold_item', did: A_DID })],
      ['event-text', one({ name: 'offer_started', offer: 'hold_item', text: 'Do you have a table Saturday?' })],
      ['event-input-value', one({ name: 'offer_started', offer: 'hold_item', sku: 'L-12' })],
      ['top-level-did', one({ name: 'page_ready' }, { did: A_DID })],
      ['session-is-a-did', { session: A_DID, events: [{ name: 'page_ready' }] }],
      ['offer-is-a-did', one({ name: 'offer_started', offer: A_DID })],
      ['one-bad-event-among-good', { session: session(),
        events: [{ name: 'page_ready' }, { name: 'offer_started', offer: 'hold_item', text: 'secret' }] }],
      ['unknown-name', one({ name: 'tool_started' })],
      ['bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(one({ name: 'page_ready' })))])],
    ]) {
      const hdrs = { ...BEACON, ...(headers || {}) };
      if (hdrs.origin === undefined) delete hdrs.origin;
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const before = wire.calls.length;
      const out = await entry.handleRequestAsync('POST', EVENTS, hdrs, buffer, { remoteAddress: SOCKET });
      await settle(10);
      check(out.status >= 400 && out.status < 500, `counts/refused/${label}/4xx`, `HTTP ${out.status}`);
      check(wire.calls.length === before, `counts/refused/${label}/nothing-posted`,
        wire.calls.slice(before).map((c) => c.body.toString('utf8')).join(' | '));
    }
  }
}

// 8f. A slow or hanging sink never delays the 204, and the post is still attempted (fire, then forget).
for (const mode of ['slow', 'hang']) {
  wire.mode = mode;
  const { entry } = countsDoor();
  const plain = plainDoor().entry;
  if (entry && plain) {
    const body = { session: session(), events: [{ name: 'offer_started', offer: 'hold_item' }] };
    const before = wire.calls.length;
    const started = Date.now();
    const out = await inTime(post(entry, body));
    const took = Date.now() - started;
    check(out !== LATE && took < 1000, `counts/${mode}-sink/the-204-is-not-delayed`, `${took} ms`);
    if (out !== LATE) {
      const base = await post(plain, body);
      check(sameResponse(out, base), `counts/${mode}-sink/the-204-is-unchanged`, `HTTP ${out.status}`);
    }
    await settle();
    check(wire.calls.length - before === 1, `counts/${mode}-sink/the-post-was-attempted-once`,
      `${wire.calls.length - before} request(s)`);
  }
}

// 8g. A failing sink (throws, rejects, times out, answers non-2xx) changes nothing and is never retried.
for (const mode of ['throw', 'reject', 'timeout', '500', '404']) {
  wire.mode = mode;
  const { entry, sink } = countsDoor();
  const plain = plainDoor().entry;
  if (entry && plain) {
    const unhandledBefore = unhandled;
    const before = wire.calls.length;
    let threw = null;
    let out = null;
    const body = { session: session(), events: [{ name: 'page_ready' }, { name: 'referral', engine: 'perplexity' }] };
    try { out = await inTime(post(entry, body)); } catch (e) { threw = e; }
    check(threw === null, `counts/${mode}-sink/nothing-thrown-out-of-the-door`, threw?.message);
    check(out !== LATE, `counts/${mode}-sink/the-204-is-not-delayed`);
    if (out && out !== LATE) {
      const base = await post(plain, body);
      check(sameResponse(out, base), `counts/${mode}-sink/the-204-is-unchanged`, `HTTP ${out.status} ${out.text}`);
    }
    check(pageEvents(sink).length === 2, `counts/${mode}-sink/the-local-observer-still-counts`,
      `got ${pageEvents(sink).length}`);
    await settle(150);
    check(wire.calls.length - before === 1, `counts/${mode}-sink/one-attempt-no-retry`,
      `${wire.calls.length - before} request(s)`);
    check(unhandled === unhandledBefore, `counts/${mode}-sink/no-unhandled-rejection`,
      `${unhandled - unhandledBefore}`);
  }
}

// 8h. A signed reply is the same bytes with a slow or failing sink as without entry.counts. The
//     reply's own messageId, timestamp and signature are fresh per reply, so those three values
//     are replaced by placeholders in the raw bytes before comparing; everything else is byte-equal.
{
  const VISITOR_SEED = '6b'.repeat(32);
  const VISITOR = didFromSeedHex(VISITOR_SEED);
  let seq = 0;
  async function knock(entry) {
    const text = 'ZZ-knock-text-8830 brass lamps please';
    const messageId = `counts-knock-${++seq}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = door.signEnvelope(VISITOR_SEED, { from: VISITOR, to: entry.did, messageId, contextId: null, timestamp, text });
    const buffer = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: messageId, method: 'message/send',
      params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
        metadata: { from: VISITOR, to: entry.did, timestamp, sig, offer: 'find_products' } } } }));
    const started = Date.now();
    const out = await inTime(entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, buffer,
      { remoteAddress: SOCKET }));
    const took = Date.now() - started;
    if (out === LATE) return { late: true, took };
    const raw = Buffer.from(out.body || '').toString('utf8');
    let result = null;
    try { result = JSON.parse(raw).result; } catch { /* reported below */ }
    const replyText = result?.parts?.[0]?.text;
    const signed = Boolean(result) && door.verifyEnvelope({
      from: result.metadata?.from, to: result.metadata?.to, messageId: result.messageId,
      contextId: result.contextId ?? null, timestamp: result.metadata?.timestamp, text: replyText,
      sig: result.metadata?.sig }, { recipientDid: VISITOR, signerDid: entry.did });
    let normal = raw.split(messageId).join('<request-id>');
    for (const [value, slot] of [[result?.messageId, '<reply-id>'], [result?.metadata?.sig, '<sig>']]) {
      if (typeof value === 'string' && value) normal = normal.split(value).join(slot);
    }
    if (Number.isSafeInteger(result?.metadata?.timestamp)) {
      normal = normal.split(`"timestamp":${result.metadata.timestamp}`).join('"timestamp":"<ts>"');
    }
    return { late: false, took, out, normal, signed, replyText };
  }

  wire.mode = 'ok';
  const plain = plainDoor().entry;
  const base = plain ? await knock(plain) : null;
  check(base && !base.late && base.out.status === 200 && base.signed, 'counts/knock/baseline-is-a-signed-reply',
    base?.normal);
  for (const mode of ['ok', 'slow', 'hang', 'throw', 'reject', 'timeout', '500']) {
    wire.mode = mode;
    const { entry } = countsDoor();
    if (!entry || !base) continue;
    const unhandledBefore = unhandled;
    const before = wire.calls.length;
    const k = await knock(entry);
    check(!k.late && k.took < 1000, `counts/knock/${mode}-sink/the-signed-reply-is-not-delayed`, `${k.took} ms`);
    if (k.late) continue;
    check(k.signed, `counts/knock/${mode}-sink/the-reply-is-still-signed-by-the-door`);
    check(k.out.status === base.out.status
        && JSON.stringify(k.out.headers || {}) === JSON.stringify(base.out.headers || {}),
      `counts/knock/${mode}-sink/status-and-headers-unchanged`, `${k.out.status} ${JSON.stringify(k.out.headers)}`);
    check(k.replyText === base.replyText, `counts/knock/${mode}-sink/the-signed-text-is-byte-equal`, k.replyText);
    check(k.normal === base.normal, `counts/knock/${mode}-sink/the-reply-bytes-are-byte-equal`,
      `${k.normal}\n      vs ${base.normal}`);
    await settle(mode === 'timeout' ? 150 : 40);
    check(unhandled === unhandledBefore, `counts/knock/${mode}-sink/no-unhandled-rejection`);
    for (const [j, c] of wire.calls.slice(before).entries()) {
      check(c.url === COUNTS, `counts/knock/${mode}-sink/post-${j}/only-to-entry-counts`, c.url);
      checkClean(c, `counts/knock/${mode}-sink/post-${j}`);
    }
  }
}

// 8j. The door re-serializes what it counted, so a beacon that fits can grow on the way out: "6e5"
//     is a legal JSON spelling of 600000 and is three bytes shorter. A posted body is never over
//     2048 bytes and never over 100 events, whatever the page spelled; a body that would be is
//     not sent as one (trimmed, split or dropped, the door's choice), and the 204 stays the 204.
{
  wire.mode = 'ok';
  const { entry } = countsDoor();
  const plain = plainDoor().entry;
  if (entry && plain) {
    const spelled = (n, s) => `{"session":"${s}","events":[${
      Array.from({ length: n }, () => '{"name":"offer_succeeded","offer":"hold_item","ms":6e5}').join(',')}]}`;
    let fits = 1;
    while (Buffer.byteLength(spelled(fits + 1, 'tab-spelled00'), 'utf8') <= 2048) fits += 1;
    const raw = spelled(fits, 'tab-spelled00');
    const grown = JSON.stringify(JSON.parse(raw));
    check(Buffer.byteLength(raw) <= 2048 && Buffer.byteLength(grown) > 2048,
      'counts/spelling/fixture-grows-past-2048-when-re-serialized',
      `${Buffer.byteLength(raw)} -> ${Buffer.byteLength(grown)}`);
    const before = wire.calls.length;
    const out = await post(entry, raw);
    const base = await post(plain, spelled(fits, 'tab-spelled01'));
    check(out.status === 204 && sameResponse(out, base), 'counts/spelling/the-204-is-the-plain-doors-204',
      `HTTP ${out.status} ${out.text}`);
    await settle();
    const mine = wire.calls.slice(before);
    let sent = 0;
    for (const [j, c] of mine.entries()) {
      check(c.url === COUNTS && c.method === 'POST', `counts/spelling/post-${j}/a-POST-to-entry-counts`, c.url);
      checkClean(c, `counts/spelling/post-${j}`);
      sent += parsed(c)?.events?.length ?? 0;
    }
    check(sent <= fits, 'counts/spelling/never-more-events-than-were-counted', `${sent} of ${fits}`);
  }
}

// 8k. An offer the door takes is not always one trunk takes: a verb outside the registry (AT-4)
//     or an id over 64 characters is declared fine, counted locally, but trunk's parse_beacon
//     refuses the WHOLE body over it. Whatever is posted is still a body trunk accepts, so one
//     such event can never make trunk drop the registry events beside it; the 204 is unchanged.
{
  wire.mode = 'ok';
  const offbeat = { verb: 'reserve', of: 'table', about: 'Reserve a table.', input: { q: 'string' },
    page: JSON.parse(JSON.stringify(harbor.declaration.offers[0].page)) };
  const longOf = `lamp_${'x'.repeat(62)}`;
  const lengthy = { verb: 'hold', of: longOf, about: 'Hold a lamp with a long name.', input: { q: 'string' },
    page: JSON.parse(JSON.stringify(harbor.declaration.offers[0].page)) };
  const declaration = countsDeclaration();
  declaration.offers.push(offbeat, lengthy);
  const { entry, error, sink } = makeDoor({ declaration, signedRatePerMin: 0, signedRatePerMinTotal: 0 });
  if (check(entry !== null, 'counts/off-registry/door-with-an-off-registry-offer-starts', error?.message)) {
    const longId = `hold_${longOf}`;
    check(longId.length > 64, 'counts/off-registry/fixture-id-is-over-64', String(longId.length));
    for (const [label, odd] of [['verb-outside-the-registry', 'reserve_table'], ['id-over-64', longId]]) {
      const before = wire.calls.length;
      const observed = pageEvents(sink).length;
      const out = await post(entry, { session: session(), events: [
        { name: 'page_ready' }, { name: 'offer_started', offer: odd }, { name: 'offer_started', offer: 'hold_item' }] });
      check(out.status === 204, `counts/off-registry/${label}/204`, `HTTP ${out.status} ${out.text}`);
      check(pageEvents(sink).length - observed === 3, `counts/off-registry/${label}/the-local-observer-counts-all-three`,
        `got ${pageEvents(sink).length - observed}`);
      await settle();
      const mine = wire.calls.slice(before);
      for (const [j, c] of mine.entries()) {
        checkClean(c, `counts/off-registry/${label}/post-${j}`);
        check(!c.body.toString('utf8').includes(odd), `counts/off-registry/${label}/post-${j}/carries-no-offer-trunk-refuses`,
          c.body.toString('utf8'));
      }
      const posted = mine.flatMap((c) => parsed(c)?.events ?? []);
      check(posted.some((e) => e.name === 'offer_started' && e.offer === 'hold_item')
          && posted.some((e) => e.name === 'page_ready'),
        `counts/off-registry/${label}/the-registry-events-beside-it-still-reach-trunk`, JSON.stringify(posted));
    }
  }
}

// 8l. The door stays one file with no dependency, and the vendored seam is untouched by this item.
{
  const doorSource = readFileSync(join(HERE, '..', 'muretai-agent-entry.mjs'), 'utf8');
  const specifiers = [...doorSource.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm)]
    .map((m) => m[1]);
  const dynamic = [...doorSource.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const foreign = [...specifiers, ...dynamic].filter((s) => !s.startsWith('node:'));
  check(foreign.length === 0, 'counts/one-file/the-door-imports-only-node-builtins', JSON.stringify(foreign));
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
    check(Object.keys(pkg[field] || {}).length === 0, `counts/one-file/package-json-has-no-${field}`,
      JSON.stringify(pkg[field]));
  }
  const { createHash } = await import('node:crypto');
  const seam = readFileSync(join(HERE, '..', 'vendor', 'agent-seam', 'seam.mjs'));
  check(createHash('sha256').update(seam).digest('hex')
      === '0b724e456ebedf9063f8e562a4b77f70ddedbdc7c9880e80121dbe56995792ed',
    'counts/seam/vendor-agent-seam-seam-mjs-is-the-v0.3.5-copy');
}

// 8i. Every request the door made in this file went to entry.counts and carried a body trunk accepts.
{
  check(wire.calls.length > 0, 'counts/the-door-posted-at-all', 'no request reached the fetch stub');
  for (const [i, c] of wire.calls.entries()) {
    check(c.url === COUNTS && c.method === 'POST', `counts/all/request-${i}/a-POST-to-entry-counts`, `${c.method} ${c.url}`);
    check(parseBeaconTrunk(c.body), `counts/all/request-${i}/trunk-accepts`, c.body.toString('utf8'));
  }
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------- report

if (failures.length) {
  console.error(`FAILED - ${failures.length} collector check(s):`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} checks: the page's counts come in same-origin, small, named and anonymous, `
  + 'reach the observer as stage "page", and never touch the ledger.');
