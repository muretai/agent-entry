#!/usr/bin/env node
// Default declaration in library mode (intake 20261016T083155Z, E1 of the chain
// index 20261016T083408Z). Design record: agent-entry-plan face table row 2.
// Owner ruling 2026-10-16: the install is everything.
//
// WRITTEN BEFORE THE IMPLEMENTATION. The implementer may not edit this file.
// It is not wired into npm test until it is green. Run it as
//   node conformance/default-declaration.mjs
//
// createAgentEntry() with no `declaration` derives one instead of serving an empty
// face. It does not throw, and it does not print a manual step on stdout or stderr.
//
//   name         the site name
//   facts        optional map of public fact name to string. Omitted or {} is empty.
//   catalogFile  optional products snapshot. Omitted or null means there is none.
//
// The derived declaration has one ask offer whose door.reply is "facts", answered
// with every given fact and with the site name as one of the fact values. It has
// one find offer whose door.reply is "catalog" only when catalogFile is a snapshot,
// and no find offer otherwise. No other offer is added.
//
// That declaration is compiled and served the way a given one is: canonical
// /.well-known/agent-tools.json, a verifying /.well-known/agent-tools.sig.json,
// and the same bytes at /.well-known/agent-tools/v1.json. The card carries
// agentEntry.tools and skills[] generated from those offers. GET / with
// Accept: text/html lists each offer id, the site name and the fact values.
//
// A declaration the caller passed is compiled unchanged. facts and catalogFile
// do not replace it and do not merge an ask or a find offer into it.
//
// Refusals: a tampered default-declaration envelope fails verifyToolsEnvelope.
// A fact value or a site name that holds markup or a control character is not
// echoed raw into any GET / body. E2 through E11 are not pinned here.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as door from '../muretai-agent-entry.mjs';

const {
  ERRORS, canonicalJSON, compileDeclaration, createAgentEntry, didFromSeedHex,
  signEnvelope, verifyEnvelope, verifyToolsEnvelope,
} = door;

const SEED = 'd4'.repeat(32);
const VISITOR_SEED = 'e5'.repeat(32);
const VISITOR = didFromSeedHex(VISITOR_SEED);
const TOOLS = '/.well-known/agent-tools.json';
const TOOLS_SIG = '/.well-known/agent-tools.sig.json';
const V1 = '/.well-known/agent-tools/v1.json';
const BRAIN = 'BRAIN-SHOULD-NOT-ANSWER-AN-OFFER';
const MANUAL = /add a declaration|run agent-entry init|write a declaration|declaration is required|missing declaration/i;

const SNAP_ORIGIN = 'https://snapshot.example';
const ROW = {
  id: 101,
  name: 'Brass Desk Lamp',
  price: '89.00 EUR',
  stock_status: 'in_stock',
  permalink: `${SNAP_ORIGIN}/product/brass-desk-lamp/`,
};

const home = mkdtempSync(join(tmpdir(), 'default-declaration-'));
const snapPath = join(home, 'products.json');
writeFileSync(snapPath, `${JSON.stringify([ROW])}\n`);

let passed = 0;
const failures = [];
let sequence = 0;

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${String(detail).slice(0, 400)}` : ''}`);
  return false;
}

function attempt(fn) {
  try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, error }; }
}

async function section(name, fn) {
  try { await fn(); } catch (error) { check(false, `${name}/threw`, error?.stack || String(error)); }
}

const bodyText = (out) => Buffer.from(out.body || '').toString('utf8');

function header(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return String(headers[key] ?? '');
  }
  return '';
}

function contractHash(contract) {
  const { hash: _omit, ...rest } = contract;
  return createHash('sha256').update(canonicalJSON(rest), 'utf8').digest('hex');
}

function isHtml(type) {
  return /^text\/html\b/i.test(type) && /charset=utf-8/i.test(type);
}

function manual(text) {
  return MANUAL.test(String(text));
}

/** The ask reply's facts: every given pair, plus the site name as one of the values. */
function carries(facts, siteName, given) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return false;
  if (!Object.values(facts).includes(siteName)) return false;
  return Object.entries(given).every(([key, value]) => facts[key] === value);
}

/** Skills the way skillsFromOffers builds them, read off the compiled offers. */
function skillsFor(offers) {
  return offers.map((offer) => {
    const examples = [offer.about];
    const fields = Object.keys(offer.input || {});
    if (fields.length) {
      const shape = Object.fromEntries(fields.map((key) => [key, `<${offer.input[key]}>`]));
      examples.push(`${offer.verb} ${offer.of} ${canonicalJSON(shape)}`);
    }
    return {
      id: offer.id, name: offer.id, description: offer.about, tags: [offer.verb, offer.of], examples,
    };
  });
}

async function capturePrints(fn) {
  const printed = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  const saved = {};
  for (const key of ['log', 'info', 'warn', 'error', 'debug']) saved[key] = console[key];
  process.stdout.write = (chunk, ...rest) => {
    printed.push(String(chunk));
    const cb = rest.find((item) => typeof item === 'function');
    if (cb) cb();
    return true;
  };
  process.stderr.write = process.stdout.write;
  for (const key of Object.keys(saved)) {
    console[key] = (...args) => {
      printed.push(args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' '));
    };
  }
  try { await fn(); } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    for (const key of Object.keys(saved)) console[key] = saved[key];
  }
  return printed.join('\n');
}

function openDoor(extra) {
  return createAgentEntry({
    seedHex: SEED,
    signedRatePerMin: 0,
    signedRatePerMinTotal: 0,
    responder: () => BRAIN,
    ...extra,
  });
}

async function get(entry, method, path, headers = {}) {
  const out = await entry.handleRequestAsync(method, path, headers, Buffer.alloc(0));
  return {
    status: out.status,
    type: header(out.headers, 'content-type'),
    body: bodyText(out),
  };
}

async function knock(entry, offer, text) {
  const from = VISITOR;
  const messageId = `default-decl-${++sequence}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signEnvelope(VISITOR_SEED, { from, to: entry.did, messageId, contextId: null, timestamp, text });
  const buffer = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null,
      parts: [{ kind: 'text', text }],
      metadata: { from, to: entry.did, timestamp, sig, offer } } },
  }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, buffer);
  const raw = bodyText(out);
  let body = null;
  try { body = JSON.parse(raw); } catch { /* reported by the caller */ }
  const message = body?.result;
  const replyText = message?.parts?.[0]?.text;
  const signed = Boolean(message) && verifyEnvelope({
    from: message.metadata?.from, to: message.metadata?.to, messageId: message.messageId,
    contextId: message.contextId ?? null, timestamp: message.metadata?.timestamp, text: replyText,
    sig: message.metadata?.sig,
  }, { recipientDid: VISITOR, signerDid: entry.did });
  let reply = null;
  try { reply = JSON.parse(replyText); } catch { /* a brain reply is free text */ }
  return { status: out.status, raw, body, text: replyText, signed, reply };
}

async function pinFace(entry, { label, siteName, given, wantFind, origin }) {
  const tools = await get(entry, 'GET', TOOLS);
  let contract = null;
  try { contract = JSON.parse(tools.body); } catch { /* checked below */ }
  const served = check(tools.status === 200 && contract && contract.v === 1
      && tools.type.startsWith('application/json'),
    `${label}/serves-agent-tools.json`, `HTTP ${tools.status} ${tools.type} ${tools.body.slice(0, 160)}`);
  if (!served) {
    check(false, `${label}/derived-declaration`);
    return null;
  }
  check(tools.body === canonicalJSON(contract), `${label}/contract-bytes-are-canonical`);
  check(contract.hash === contractHash(contract), `${label}/hash-is-sha256-of-the-rest`, String(contract.hash));
  check(contract.name === siteName, `${label}/contract-name-is-the-site-name`, JSON.stringify(contract.name));
  check(contract.version === 1, `${label}/version-is-1`, String(contract.version));
  check(Array.isArray(contract.origins) && contract.origins.includes(origin),
    `${label}/origins-include-the-door`, JSON.stringify(contract.origins));

  const asks = contract.offers.filter((offer) => offer.verb === 'ask');
  const finds = contract.offers.filter((offer) => offer.verb === 'find');
  check(asks.length === 1, `${label}/one-ask-offer`, JSON.stringify((contract.offers || []).map((o) => o.verb)));
  check(finds.length === (wantFind ? 1 : 0), `${label}/find-offer-${wantFind ? 'present' : 'absent'}`,
    JSON.stringify(finds.map((o) => o.id)));
  check(contract.offers.length === (wantFind ? 2 : 1), `${label}/no-other-offer`,
    JSON.stringify(contract.offers.map((o) => o.verb)));

  const ask = asks[0];
  if (ask) {
    check(ask.door?.reply === 'facts', `${label}/ask-reply-is-facts`, JSON.stringify(ask.door));
    check(ask.id === `ask_${ask.of}`, `${label}/ask-id-is-verb-of`, ask.id);
    check(ask.effect === 'none' && ask.ask === 'never' && ask.door?.receipt === false,
      `${label}/ask-keeps-the-registry-defaults`, JSON.stringify(ask));
    check(carries(contract.facts, siteName, given),
      `${label}/contract-facts-are-the-given-facts-and-the-site-name`, JSON.stringify(contract.facts));
  }
  const find = finds[0];
  if (wantFind && find) {
    check(find.door?.reply === 'catalog', `${label}/find-reply-is-catalog`, JSON.stringify(find.door));
    check(find.id === `find_${find.of}`, `${label}/find-id-is-verb-of`, find.id);
    check(find.effect === 'none' && find.ask === 'never' && find.door?.receipt === false,
      `${label}/find-keeps-the-registry-defaults`, JSON.stringify(find));
  }

  const v1 = await get(entry, 'GET', V1);
  check(v1.status === 200 && v1.body === tools.body, `${label}/v1.json-is-the-same-bytes`,
    `HTTP ${v1.status} ${v1.body.slice(0, 80)}`);

  const sig = await get(entry, 'GET', TOOLS_SIG);
  const again = await get(entry, 'GET', TOOLS_SIG);
  let envelope = null;
  try { envelope = JSON.parse(sig.body); } catch { /* checked below */ }
  const fresh = envelope && Number.isSafeInteger(envelope.ts)
    && Math.abs(Math.floor(Date.now() / 1000) - envelope.ts) <= 21600;
  check(sig.status === 200 && envelope?.typ === 'agenttools' && fresh,
    `${label}/sig-is-a-fresh-agenttools-envelope`, sig.body.slice(0, 160));
  check(sig.body === again.body, `${label}/sig-is-cached`);
  const verified = envelope ? verifyToolsEnvelope(envelope, entry.did, { origin }) : null;
  check(verified && canonicalJSON(verified) === tools.body,
    `${label}/signature-verifies-the-served-contract`);
  check(verifyToolsEnvelope(envelope, entry.did, { origin: 'https://evil.example' }) === null,
    `${label}/signature-refuses-another-origin`);

  const root = String(entry.card.url || '').replace(/\/$/, '');
  check(entry.card.agentEntry?.tools === `${root}${TOOLS}`,
    `${label}/card-carries-agentEntry.tools`, JSON.stringify(entry.card.agentEntry));
  check(canonicalJSON(entry.card.skills) === canonicalJSON(skillsFor(contract.offers)),
    `${label}/card-skills-generated-from-the-offers`, canonicalJSON(entry.card.skills).slice(0, 240));

  const page = await get(entry, 'GET', '/', { accept: 'text/html' });
  check(page.status === 200 && isHtml(page.type), `${label}/get-html-lists-offers`,
    `HTTP ${page.status} ${page.type} ${page.body.slice(0, 180)}`);
  if (page.status === 200) {
    for (const offer of contract.offers) {
      check(page.body.includes(offer.id), `${label}/page-lists-${offer.id}`, page.body.slice(0, 180));
    }
    check(page.body.includes(siteName), `${label}/page-lists-the-site-name`, page.body.slice(0, 180));
    for (const value of Object.values(given)) {
      check(page.body.includes(value), `${label}/page-lists-fact-${JSON.stringify(value)}`, page.body.slice(0, 180));
    }
    check(!manual(page.body), `${label}/page-asks-for-no-manual-step`, page.body.slice(0, 180));
  }

  if (ask) {
    const knocked = await knock(entry, 'ask', 'What are your hours?');
    check(knocked.status === 200 && knocked.signed && knocked.reply?.status === 'answered'
        && knocked.reply?.verb === 'ask' && knocked.reply?.of === ask.of
        && knocked.reply?.customer_did === VISITOR && knocked.reply?.request === 'What are your hours?',
      `${label}/ask-knock-is-answered`, JSON.stringify(knocked.reply || knocked.body).slice(0, 240));
    check(carries(knocked.reply?.facts, siteName, given)
        && canonicalJSON(knocked.reply?.facts) === canonicalJSON(contract.facts),
      `${label}/ask-answer-is-the-facts-and-the-site-name`, JSON.stringify(knocked.reply?.facts));
    check(knocked.text !== BRAIN, `${label}/ask-does-not-call-the-site-responder`);
  }

  if (wantFind && find) {
    const fetches = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetches.push('fetch'); throw new TypeError('no fetch'); };
    let found = null;
    try { found = await knock(entry, 'find', 'find products'); } finally { globalThis.fetch = realFetch; }
    check(found.status === 200 && found.signed && found.reply?.status === 'see_catalog'
        && found.reply?.verb === 'find' && found.reply?.of === find.of,
      `${label}/find-knock-sees-the-catalog`, JSON.stringify(found.reply || found.body).slice(0, 240));
    check(canonicalJSON(found.reply?.products ?? null) === canonicalJSON([ROW]),
      `${label}/find-products-are-the-snapshot-rows`, JSON.stringify(found.reply?.products).slice(0, 240));
    check(fetches.length === 0, `${label}/find-reads-the-snapshot-not-the-network`, String(fetches.length));
  } else {
    const refused = await knock(entry, 'find', 'find products');
    check(refused.body?.error?.code === ERRORS.INVALID_PARAMS.code && !refused.body?.result,
      `${label}/find-knock-refused-without-a-snapshot`, JSON.stringify(refused.body).slice(0, 200));
  }
  return { contract, envelope, toolsBody: tools.body };
}

// ---------------------------------------------------------------- no snapshot: ask only

await section('absent-facts', async () => {
  const origin = 'https://plain.example';
  const siteName = 'Plain Site';
  let printed = '';
  try {
    printed = await capturePrints(async () => {
      const made = attempt(() => openDoor({ name: siteName, baseUrl: origin }));
      check(made.ok, 'absent/starts', made.ok ? '' : made.error?.message);
      if (!made.ok) return;
      await pinFace(made.value, { label: 'absent', siteName, given: {}, wantFind: false, origin });
    });
  } catch (error) {
    check(false, 'absent/threw', error?.stack || String(error));
  }
  check(!manual(printed), 'absent/no-manual-step-on-stdout-or-stderr', printed.slice(0, 300));
});

await section('empty-facts', async () => {
  const origin = 'https://empty.example';
  const siteName = 'Empty Facts';
  let printed = '';
  try {
    printed = await capturePrints(async () => {
      const made = attempt(() => openDoor({
        name: siteName, baseUrl: origin, facts: {}, catalogFile: null,
      }));
      check(made.ok, 'empty/starts', made.ok ? '' : made.error?.message);
      if (!made.ok) return;
      await pinFace(made.value, { label: 'empty', siteName, given: {}, wantFind: false, origin });
    });
  } catch (error) {
    check(false, 'empty/threw', error?.stack || String(error));
  }
  check(!manual(printed), 'empty/no-manual-step-on-stdout-or-stderr', printed.slice(0, 300));
});

// ---------------------------------------------------------------- facts, and a snapshot that adds find

await section('given-facts', async () => {
  const origin = 'https://facts.example';
  const siteName = 'Harbor Lamp';
  const given = { hours: '9 to 5', shipping: 'free over 50' };
  let printed = '';
  try {
    printed = await capturePrints(async () => {
      const made = attempt(() => openDoor({ name: siteName, baseUrl: origin, facts: given }));
      check(made.ok, 'facts/starts', made.ok ? '' : made.error?.message);
      if (!made.ok) return;
      await pinFace(made.value, { label: 'facts', siteName, given, wantFind: false, origin });
    });
  } catch (error) {
    check(false, 'facts/threw', error?.stack || String(error));
  }
  check(!manual(printed), 'facts/no-manual-step-on-stdout-or-stderr', printed.slice(0, 300));
});

await section('snapshot', async () => {
  const siteName = 'Snapshot Shop';
  const given = { hours: '10 to 4' };
  let printed = '';
  try {
    printed = await capturePrints(async () => {
      const made = attempt(() => openDoor({
        name: siteName, baseUrl: SNAP_ORIGIN, facts: given, catalogFile: snapPath,
      }));
      check(made.ok, 'snapshot/starts', made.ok ? '' : made.error?.message);
      if (!made.ok) return;
      await pinFace(made.value, {
        label: 'snapshot', siteName, given, wantFind: true, origin: SNAP_ORIGIN,
      });
    });
  } catch (error) {
    check(false, 'snapshot/threw', error?.stack || String(error));
  }
  check(!manual(printed), 'snapshot/no-manual-step-on-stdout-or-stderr', printed.slice(0, 300));
});

// ---------------------------------------------------------------- a given declaration is not replaced or merged

await section('given-declaration', async () => {
  const origin = 'https://given.example';
  const declaration = {
    v: 1,
    entry: { name: 'Given Shop', baseUrl: origin },
    offers: [{
      verb: 'hold', of: 'item', about: 'Hold one item for pickup.',
      input: { sku: 'string' }, door: { reply: 'pending' },
    }],
  };
  const before = JSON.stringify(declaration);
  const compiled = canonicalJSON(compileDeclaration(declaration));
  const made = attempt(() => openDoor({
    name: 'Given Shop',
    baseUrl: origin,
    declaration,
    facts: { hours: '9 to 5' },
    catalogFile: snapPath,
  }));
  check(made.ok, 'given/starts', made.ok ? '' : made.error?.message);
  check(JSON.stringify(declaration) === before, 'given/caller-declaration-is-not-mutated');
  if (!made.ok) return;
  const tools = await get(made.value, 'GET', TOOLS);
  check(tools.status === 200 && tools.body === compiled,
    'given/served-contract-is-the-given-declaration-unchanged', tools.body.slice(0, 240));
  let contract = null;
  try { contract = JSON.parse(tools.body); } catch { /* checked by the byte compare */ }
  const verbs = (contract?.offers || []).map((offer) => offer.verb);
  check(JSON.stringify(verbs) === JSON.stringify(['hold']),
    'given/no-default-ask-or-find-merged-in', JSON.stringify(verbs));
  check(!tools.body.includes('9 to 5') && !tools.body.includes('Brass Desk Lamp'),
    'given/facts-and-snapshot-are-not-merged-in');
});

// ---------------------------------------------------------------- a tampered default output fails verification

await section('tampered', async () => {
  const origin = 'https://tamper.example';
  const made = attempt(() => openDoor({ name: 'Tamper Shop', baseUrl: origin, facts: { hours: '9 to 5' } }));
  check(made.ok, 'tampered/starts', made.ok ? '' : made.error?.message);
  if (!made.ok) return;
  const face = await pinFace(made.value, {
    label: 'tampered', siteName: 'Tamper Shop', given: { hours: '9 to 5' }, wantFind: false, origin,
  });
  if (!face?.envelope) {
    check(false, 'tampered/no-envelope-to-tamper');
    return;
  }
  const edited = JSON.parse(JSON.stringify(face.envelope));
  edited.contract.name = `${edited.contract.name} tampered`;
  check(verifyToolsEnvelope(edited, made.value.did, { origin }) === null,
    'tampered/edited-contract-fails-verification');
  const flipped = JSON.parse(JSON.stringify(face.envelope));
  const sig = Buffer.from(String(flipped.sig), 'base64');
  if (sig.length > 0) sig[0] ^= 0xff;
  flipped.sig = sig.toString('base64');
  check(verifyToolsEnvelope(flipped, made.value.did, { origin }) === null,
    'tampered/flipped-signature-fails-verification');
});

// ---------------------------------------------------------------- markup and control characters are not raw on GET /

await section('markup', async () => {
  const origin = 'https://markup.example';
  const siteName = 'Harbor \u0001<script>alert(1)</script> Lamp';
  const fact = 'ships \u0007<img src=x onerror=alert(1)> weekly';
  const given = { note: fact };
  let entry = null;
  let printed = '';
  try {
    printed = await capturePrints(async () => {
      const made = attempt(() => openDoor({ name: siteName, baseUrl: origin, facts: given }));
      check(made.ok, 'markup/starts', made.ok ? '' : made.error?.message);
      if (!made.ok) return;
      entry = made.value;
    });
  } catch (error) {
    check(false, 'markup/threw', error?.stack || String(error));
  }
  check(!manual(printed), 'markup/no-manual-step-on-stdout-or-stderr', printed.slice(0, 300));
  if (!entry) return;

  const tools = await get(entry, 'GET', TOOLS);
  let contract = null;
  try { contract = JSON.parse(tools.body); } catch { /* below */ }
  check(tools.status === 200 && carries(contract?.facts, siteName, given),
    'markup/contract-keeps-the-fact-and-the-site-name', tools.body.slice(0, 200));
  const ask = contract?.offers?.find((offer) => offer.verb === 'ask');
  if (ask) {
    const knocked = await knock(entry, 'ask', 'What is the note?');
    check(knocked.reply?.status === 'answered' && carries(knocked.reply?.facts, siteName, given),
      'markup/ask-answer-keeps-the-fact-and-the-site-name', JSON.stringify(knocked.reply?.facts).slice(0, 200));
  } else {
    check(false, 'markup/ask-offer');
  }

  for (const [label, accept] of [['html', 'text/html'], ['plain', 'text/plain'], ['absent', undefined]]) {
    const headers = {};
    if (accept !== undefined) headers.accept = accept;
    const page = await get(entry, 'GET', '/', headers);
    check(page.status === 200, `markup/${label}/status-200`, `HTTP ${page.status}`);
    const rawTag = /<script/i.test(page.body) || /<img/i.test(page.body);
    const rawControl = page.body.includes('\u0001') || page.body.includes('\u0007');
    const rawValue = page.body.includes(siteName) || page.body.includes(fact);
    check(!rawTag && !rawControl && !rawValue, `markup/${label}/not-echoed-raw`, page.body.slice(0, 240));
    check(!manual(page.body), `markup/${label}/no-manual-step`);
    if (label === 'html') {
      check(isHtml(page.type), 'markup/html/content-type', page.type);
      check(page.body.includes('Harbor') && page.body.includes('Lamp')
          && page.body.includes('ships') && page.body.includes('weekly'),
        'markup/html/safe-text-remains', page.body.slice(0, 240));
      if (ask) check(page.body.includes(ask.id), 'markup/html/lists-the-ask-offer', page.body.slice(0, 180));
    }
  }
});

rmSync(home, { recursive: true, force: true });

if (failures.length) {
  console.error(`FAILED - ${failures.length} default-declaration check(s):`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} checks: a door with no declaration derives an ask offer from the facts and the site name, and a find offer only from a products snapshot.`);
