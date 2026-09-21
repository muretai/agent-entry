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

// ---------------------------------------------------------------- report

if (failures.length) {
  console.error(`FAILED - ${failures.length} collector check(s):`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} checks: the page's counts come in same-origin, small, named and anonymous, `
  + 'reach the observer as stage "page", and never touch the ledger.');
