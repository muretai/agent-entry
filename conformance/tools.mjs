#!/usr/bin/env node
// Agent Entry Suite S1: the declaration `agent-entry.json` (verbs first), the verb registry
// and its defaults, the byte-pinned compile, skills generation, the signed `agenttools`
// envelope, origin binding and version immutability, and the contract routes.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first pair). The authority is the owner-approved
// design (`agent-entry-suite-design.md` sections 1, 2, 6, 7-S1), not the implementer: these
// checks pin the vocabulary spelling, the registry defaults, the compile bytes and the wire.
// The module is imported as a namespace so a missing export is a named failure here, not a
// link error that hides every other check.
//
// What is pinned, in one place (the vectors file carries the same rules as data):
//   validateDeclaration(declaration)                 -> returns, or throws naming the field
//   compileDeclaration(declaration, { version = 1 }) -> the contract (byte-pinned)
//   skillsFromOffers(declaration)                    -> card skills[], one per offer
//   makeToolsEnvelope(seedHex, contract, ts)         -> { v: 1, typ: 'agenttools', contract, ts, sig }
//   verifyToolsEnvelope(envelope, expectedDid, { origin }) -> contract | null
//   createAgentEntry({ ..., declaration, toolsHistory })   -> serves the contract routes
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(HERE, 'vectors-tools.json'), 'utf8'));
const { canonicalJSON, createAgentEntry, didFromSeedHex, makeCardEnvelope, verifyCardEnvelope,
  publicKeyHexFromDid, verifyBytes, ALLOW_CARD } = door;

const SEED = '5a'.repeat(32);
const OTHER_SEED = '6b'.repeat(32);
const TOOLS = '/.well-known/agent-tools.json';
const TOOLS_SIG = '/.well-known/agent-tools.sig.json';
const EVENTS = '/.well-known/agent-tools/events';

let passed = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${detail}` : ''}`);
  return false;
}

/** The export, or a recorded failure and `undefined`. */
function need(name) {
  const value = door[name];
  check(value !== undefined, `export/${name}`, 'not exported by muretai-agent-entry.mjs');
  return value;
}

function attempt(fn) {
  try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, error }; }
}

async function attemptAsync(fn) {
  try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error }; }
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const bodyText = (out) => Buffer.from(out.body || '').toString('utf8');
const header = (out, name) => {
  const hit = Object.keys(out.headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit === undefined ? undefined : out.headers[hit];
};

function vector(name) {
  const hit = VECTORS.vectors.find((v) => v.name === name);
  if (!hit) throw new Error(`vectors-tools.json has no vector ${name}`);
  return hit;
}

const validateDeclaration = need('validateDeclaration');
const compileDeclaration = need('compileDeclaration');
const skillsFromOffers = need('skillsFromOffers');
const makeToolsEnvelope = need('makeToolsEnvelope');
const verifyToolsEnvelope = need('verifyToolsEnvelope');
const VERBS = need('VERBS');
const VERB_EFFECTS = need('VERB_EFFECTS');
const ASK_FLOOR = need('ASK_FLOOR');

const callable = (f) => typeof f === 'function';

// ---------------------------------------------------------------- 1. vocabulary and paths

{
  const want = ['find', 'ask', 'quote', 'book', 'hold', 'order', 'buy', 'track', 'change', 'cancel', 'join'];
  check(JSON.stringify(VERBS) === JSON.stringify(want), 'registry/VERBS-is-the-v1-list-in-order',
    JSON.stringify(VERBS));
  check(JSON.stringify(want) === JSON.stringify(VECTORS.rules.registry), 'registry/vectors-agree');
  check(canonicalJSON(VERB_EFFECTS ?? null) === canonicalJSON(VECTORS.rules.defaultEffect),
    'registry/VERB_EFFECTS-defaults', JSON.stringify(VERB_EFFECTS));
  check(canonicalJSON(ASK_FLOOR ?? null) === canonicalJSON(VECTORS.rules.askFloor),
    'registry/ASK_FLOOR-per-effect', JSON.stringify(ASK_FLOOR));
  check(Object.isFrozen(VERBS ?? {}) && Object.isFrozen(VERB_EFFECTS ?? {}) && Object.isFrozen(ASK_FLOOR ?? {}),
    'registry/tables-are-frozen', 'a caller must not be able to lower a default at runtime');
  check(door.TOOLS_PATH === TOOLS, 'paths/TOOLS_PATH', JSON.stringify(door.TOOLS_PATH));
  check(door.TOOLS_SIG_PATH === TOOLS_SIG, 'paths/TOOLS_SIG_PATH', JSON.stringify(door.TOOLS_SIG_PATH));
  check(door.TOOLS_EVENTS_PATH === EVENTS, 'paths/TOOLS_EVENTS_PATH', JSON.stringify(door.TOOLS_EVENTS_PATH));
}

// ---------------------------------------------------------------- 2. grammar: accepted and refused

if (callable(validateDeclaration) && callable(compileDeclaration)) {
  for (const { name, declaration } of VECTORS.accepted) {
    const v = attempt(() => validateDeclaration(clone(declaration)));
    check(v.ok, `grammar/accepted/${name}/validates`, v.ok ? '' : v.error?.message);
    const c = attempt(() => compileDeclaration(clone(declaration)));
    check(c.ok, `grammar/accepted/${name}/compiles`, c.ok ? '' : c.error?.message);
  }
  for (const { name, field, declaration } of VECTORS.refusals) {
    const v = attempt(() => validateDeclaration(clone(declaration)));
    check(!v.ok, `grammar/refused/${name}/validate-throws`);
    if (!v.ok) {
      check(v.error instanceof Error && String(v.error.message).includes(field),
        `grammar/refused/${name}/message-names-${field}`, String(v.error?.message));
    }
    const c = attempt(() => compileDeclaration(clone(declaration)));
    check(!c.ok, `grammar/refused/${name}/compile-throws`);
    // Same posture as agentEntry.prefer (AE-30): a declaration that fails validation makes the
    // entry refuse to start, rather than publish a corrected or partial set of offers.
    const e = attempt(() => createAgentEntry({
      seedHex: SEED, name: 'refusal', baseUrl: 'https://refuse.example', declaration: clone(declaration),
    }));
    check(!e.ok, `grammar/refused/${name}/door-refuses-to-start`);
  }
}

// ---------------------------------------------------------------- 3. byte-pinned compile vectors

if (callable(compileDeclaration) && callable(validateDeclaration)) {
  for (const vec of VECTORS.vectors) {
    const label = `vectors/${vec.name}`;
    const before = canonicalJSON(vec.declaration);
    const r = attempt(() => compileDeclaration(clone(vec.declaration), { version: vec.version }));
    if (!check(r.ok, `${label}/compiles`, r.ok ? '' : r.error?.message)) continue;
    const got = canonicalJSON(r.value);
    check(got === canonicalJSON(vec.contract), `${label}/contract-bytes`,
      `\n    got  ${got}\n    want ${canonicalJSON(vec.contract)}`);
    const again = attempt(() => compileDeclaration(clone(vec.declaration), { version: vec.version }));
    check(again.ok && canonicalJSON(again.value) === got, `${label}/deterministic`);
    // Same declaration, keys written in another order: same bytes. Order of offers[] is data.
    const shuffled = Object.fromEntries(Object.entries(clone(vec.declaration)).reverse());
    shuffled.offers = shuffled.offers.map((o) => Object.fromEntries(Object.entries(o).reverse()));
    const s = attempt(() => compileDeclaration(shuffled, { version: vec.version }));
    check(s.ok && canonicalJSON(s.value) === got, `${label}/key-order-does-not-change-bytes`);
    // The hash is over the contract without the hash, and it is what a page runtime rechecks.
    const { hash, ...rest } = r.value;
    check(/^[0-9a-f]{64}$/.test(String(hash)) && hash === sha256hex(canonicalJSON(rest)),
      `${label}/hash-is-sha256-of-the-rest`, String(hash));
    check(r.value.version === vec.version && Array.isArray(r.value.origins),
      `${label}/version-and-origins`);
    const input = clone(vec.declaration);
    attempt(() => compileDeclaration(input, { version: vec.version }));
    check(canonicalJSON(input) === before, `${label}/compile-does-not-mutate-the-declaration`);
  }

  // Version defaults to 1 and must be a positive safe integer.
  const harbor = vector('harbor-lamp-every-reply-kind-and-facts');
  const d = attempt(() => compileDeclaration(clone(harbor.declaration)));
  check(d.ok && d.value.version === 1, 'vectors/version-defaults-to-1');
  for (const bad of [0, -1, 1.5, '2', null]) {
    const r = attempt(() => compileDeclaration(clone(harbor.declaration), { version: bad }));
    check(!r.ok, `vectors/version-${JSON.stringify(bad)}-is-refused`);
  }
  // A different version is a different hash (the version is inside what is hashed).
  const v2 = attempt(() => compileDeclaration(clone(harbor.declaration), { version: 2 }));
  check(v2.ok && d.ok && v2.value.hash !== d.value.hash, 'vectors/version-is-hashed');

  // Classes the brief requires at least one vector for.
  const effects = new Set(VECTORS.vectors.flatMap((v) => v.contract.offers.map((o) => o.effect)));
  for (const e of ['none', 'reversible', 'changes', 'pays']) {
    check(effects.has(e), `vectors/cover-effect-${e}`);
  }
  check(VECTORS.vectors.some((v) => v.contract.facts), 'vectors/cover-facts');
}

// ---------------------------------------------------------------- 4. registry defaults per verb

if (callable(compileDeclaration)) {
  const one = (offer) => ({
    v: 1,
    entry: { name: 'Registry Desk', baseUrl: 'https://registry.example' },
    offers: [{ of: 'thing', about: 'Do the thing.', input: {}, door: { reply: 'pending' }, ...offer }],
  });
  const floorOf = { none: 'never', reversible: 'advised', changes: 'advised', pays: 'always' };
  const defaults = VECTORS.rules.defaultEffect;
  for (const verb of VECTORS.rules.registry) {
    const decl = one(verb === 'buy'
      ? { verb, door: { reply: 'checkout', url: '/checkout' } } : { verb });
    const r = attempt(() => compileDeclaration(decl));
    if (!check(r.ok, `registry/${verb}/compiles`, r.ok ? '' : r.error?.message)) continue;
    const o = r.value.offers[0];
    const effect = defaults[verb];
    check(o.id === `${verb}_thing`, `registry/${verb}/id-is-verb_of`, o.id);
    check(o.effect === effect, `registry/${verb}/effect-${effect}`, String(o.effect));
    check(o.ask === floorOf[effect], `registry/${verb}/ask-${floorOf[effect]}`, String(o.ask));
    const wantsThen = effect === 'changes' || effect === 'pays';
    check(wantsThen ? o.then === 'door' : !Object.hasOwn(o, 'then'),
      `registry/${verb}/then-${wantsThen ? 'door' : 'absent'}`, JSON.stringify(o.then));
    const receipt = ['hold', 'book', 'order', 'quote'].includes(verb);
    check(o.door?.receipt === receipt, `registry/${verb}/receipt-${receipt}`, JSON.stringify(o.door));
  }

  // Overrides: raise effect, raise ask, opt out of then, opt out of the receipt.
  const raised = attempt(() => compileDeclaration(one({ verb: 'find', effect: 'pays' })));
  check(raised.ok && raised.value.offers[0].effect === 'pays' && raised.value.offers[0].ask === 'always'
      && raised.value.offers[0].then === 'door',
    'registry/override/raised-effect-carries-its-floor-and-then',
    raised.ok ? JSON.stringify(raised.value.offers[0]) : raised.error?.message);
  const asked = attempt(() => compileDeclaration(one({ verb: 'hold', ask: 'always' })));
  check(asked.ok && asked.value.offers[0].ask === 'always' && asked.value.offers[0].effect === 'changes',
    'registry/override/raised-ask');
  const noThen = attempt(() => compileDeclaration(one({ verb: 'book', then: 'none' })));
  check(noThen.ok && !Object.hasOwn(noThen.value.offers[0], 'then'), 'registry/override/then-none-opts-out');
  const pageThen = attempt(() => compileDeclaration(one({
    verb: 'find', page: { on: ['/'], do: { read: '#list' }, then: 'door' },
  })));
  check(pageThen.ok && pageThen.value.offers[0].then === 'door'
      && !Object.hasOwn(pageThen.value.offers[0].page || {}, 'then'),
    'registry/override/page-then-door-is-folded-into-then');
  const noReceipt = attempt(() => compileDeclaration(one({ verb: 'book', door: { reply: 'pending', receipt: false } })));
  check(noReceipt.ok && noReceipt.value.offers[0].door.receipt === false, 'registry/override/receipt-false');
  const yesReceipt = attempt(() => compileDeclaration(one({ verb: 'ask', door: { reply: 'pending', receipt: true } })));
  check(yesReceipt.ok && yesReceipt.value.offers[0].door.receipt === true, 'registry/override/receipt-true');

  // A verb outside the registry: accepted, passed through, and given NO defaults. The design
  // says "a site may add its own" and defines no extension mechanism, so nothing is inferred.
  const rent = attempt(() => compileDeclaration(one({ verb: 'rent' })));
  check(rent.ok, 'registry/unknown-verb/accepted', rent.ok ? '' : rent.error?.message);
  if (rent.ok) {
    const o = rent.value.offers[0];
    check(o.id === 'rent_thing' && o.verb === 'rent', 'registry/unknown-verb/passes-through');
    check(!Object.hasOwn(o, 'effect') && !Object.hasOwn(o, 'ask') && !Object.hasOwn(o, 'then'),
      'registry/unknown-verb/no-effect-ask-or-then', JSON.stringify(o));
    check(o.door?.receipt === false, 'registry/unknown-verb/receipt-defaults-false');
  }
}

// ---------------------------------------------------------------- 5. skills[] from offers[]

if (callable(skillsFromOffers)) {
  for (const vec of VECTORS.vectors) {
    const label = `skills/${vec.name}`;
    const r = attempt(() => skillsFromOffers(clone(vec.declaration)));
    if (!check(r.ok, `${label}/generates`, r.ok ? '' : r.error?.message)) continue;
    check(canonicalJSON(r.value) === canonicalJSON(vec.skills), `${label}/exact`,
      `\n    got  ${canonicalJSON(r.value)}\n    want ${canonicalJSON(vec.skills)}`);
    const again = attempt(() => skillsFromOffers(clone(vec.declaration)));
    check(again.ok && JSON.stringify(again.value) === JSON.stringify(r.value), `${label}/deterministic`);
    check(Array.isArray(r.value) && r.value.length === vec.declaration.offers.length,
      `${label}/one-per-offer`);
  }
  // Only offers present: dropping an offer drops its skill and nothing else.
  const harbor = vector('harbor-lamp-every-reply-kind-and-facts');
  const fewer = clone(harbor.declaration);
  fewer.offers = fewer.offers.filter((o) => o.verb !== 'buy');
  const r = attempt(() => skillsFromOffers(fewer));
  check(r.ok && JSON.stringify(r.value.map((s) => s.id))
      === JSON.stringify(['find_products', 'hold_item', 'book_table', 'ask_anything']),
    'skills/reflect-only-offers-present', r.ok ? JSON.stringify(r.value.map((s) => s.id)) : r.error?.message);
  const bad = attempt(() => skillsFromOffers({ v: 1, entry: {}, offers: [{ verb: 'Buy' }] }));
  check(!bad.ok, 'skills/refuses-an-invalid-declaration');
}

// ---------------------------------------------------------------- 6. the agenttools envelope

if (callable(makeToolsEnvelope) && callable(verifyToolsEnvelope)) {
  const did = didFromSeedHex(SEED);
  const contract = vector('harbor-lamp-every-reply-kind-and-facts').contract;
  const ts = Math.floor(Date.now() / 1000);
  const env = attempt(() => makeToolsEnvelope(SEED, clone(contract), ts));
  if (check(env.ok, 'envelope/mints', env.ok ? '' : env.error?.message)) {
    const e = env.value;
    check(JSON.stringify(Object.keys(e).sort()) === JSON.stringify(['contract', 'sig', 'ts', 'typ', 'v']),
      'envelope/shape-is-v-typ-contract-ts-sig', JSON.stringify(Object.keys(e)));
    check(e.v === 1 && e.typ === 'agenttools' && e.ts === ts, 'envelope/v1-typ-agenttools-ts');
    check(canonicalJSON(e.contract) === canonicalJSON(contract), 'envelope/carries-the-contract');
    // The signed bytes, spelled out so a second implementation can reproduce them: the same
    // construction as the card envelope, with the new typ.
    const payload = canonicalJSON({ contract, ts, typ: 'agenttools', v: 1 });
    const sig = Buffer.from(String(e.sig), 'base64');
    check(sig.length === 64 && verifyBytes(Buffer.from(publicKeyHexFromDid(did), 'hex'), sig,
      Buffer.from(payload, 'utf8')), 'envelope/sig-over-canonical-v-typ-contract-ts');
    const back = attempt(() => verifyToolsEnvelope(clone(e), did));
    check(back.ok && back.value && canonicalJSON(back.value) === canonicalJSON(contract),
      'envelope/verifies-and-returns-the-contract');
    check(attempt(() => verifyToolsEnvelope(clone(e), didFromSeedHex(OTHER_SEED))).value === null,
      'envelope/refused-under-another-did');
    check(attempt(() => verifyToolsEnvelope(clone(e))).value === null,
      'envelope/refused-without-an-expected-did', 'the contract names no key; the card does');

    // Never replayable as a card, and a card is never accepted as a contract.
    check(attempt(() => verifyCardEnvelope(clone(e), did)).value === null
        && attempt(() => verifyCardEnvelope(clone(e))).value === null,
      'envelope/agenttools-fails-card-verification');
    const relabeled = { v: 1, typ: 'agentcard', card: clone(contract), ts, sig: e.sig };
    check(attempt(() => verifyCardEnvelope(relabeled)).value === null
        && attempt(() => verifyCardEnvelope({ ...relabeled, card: { ...clone(contract), did } })).value === null,
      'envelope/agenttools-sig-relabelled-as-a-card-fails');
    const card = { name: 'Harbor Lamp', did, url: 'https://shop.example' };
    const cardEnv = makeCardEnvelope(SEED, card, ts);
    check(attempt(() => verifyToolsEnvelope(clone(cardEnv), did)).value === null,
      'envelope/card-fails-agenttools-verification');
    const cardAsTools = { v: 1, typ: 'agenttools', contract: card, ts, sig: cardEnv.sig };
    check(attempt(() => verifyToolsEnvelope(cardAsTools, did)).value === null,
      'envelope/card-sig-relabelled-as-agenttools-fails');

    // Tampering.
    const tampered = clone(e);
    tampered.contract.offers[3].door.url = 'https://pay.elsewhere.example/checkout';
    check(attempt(() => verifyToolsEnvelope(tampered, did)).value === null, 'envelope/tampered-contract-refused');
    const staleTs = clone(e); staleTs.ts = ts + 1;
    check(attempt(() => verifyToolsEnvelope(staleTs, did)).value === null, 'envelope/tampered-ts-refused');
    // A contract whose hash does not match its own bytes is refused even when correctly signed:
    // the page runtime rechecks the hash, so the door must never sign one.
    const badHash = { ...clone(contract), hash: '0'.repeat(64) };
    const signedBad = attempt(() => makeToolsEnvelope(SEED, badHash, ts));
    check(!signedBad.ok || attempt(() => verifyToolsEnvelope(signedBad.value, did)).value === null,
      'envelope/hash-mismatch-never-verifies');
    for (const badTs of [1.5, '1767225600', null]) {
      check(!attempt(() => makeToolsEnvelope(SEED, clone(contract), badTs)).ok,
        `envelope/ts-${JSON.stringify(badTs)}-refused`);
    }

    // Origin binding at the verifier.
    const atHome = attempt(() => verifyToolsEnvelope(clone(e), did, { origin: 'https://shop.example' }));
    check(atHome.ok && atHome.value !== null, 'origin/serving-origin-in-origins-verifies');
    for (const origin of ['https://evil.example', 'http://shop.example', 'https://shop.example:8443',
      'https://shop.example.evil.example']) {
      check(attempt(() => verifyToolsEnvelope(clone(e), did, { origin })).value === null,
        `origin/${origin}-refused`);
    }
  }
}

// ---------------------------------------------------------------- 7. the door serves the contract

async function get(entry, method, path, headers = {}, body = Buffer.alloc(0)) {
  return entry.handleRequestAsync(method, path, headers, body);
}

{
  const harbor = vector('harbor-lamp-every-reply-kind-and-facts');
  const made = attempt(() => createAgentEntry({
    seedHex: SEED, name: 'Harbor Lamp', baseUrl: 'https://shop.example', declaration: clone(harbor.declaration),
  }));
  if (check(made.ok, 'door/starts-with-a-declaration', made.ok ? '' : made.error?.message)) {
    const entry = made.value;
    const card = entry.card;
    check(card.agentEntry?.tools === `https://shop.example${TOOLS}`, 'door/card-names-agentEntry.tools',
      JSON.stringify(card.agentEntry));
    check(card.agentEntry?.events === `https://shop.example${EVENTS}`, 'door/card-names-agentEntry.events',
      JSON.stringify(card.agentEntry));
    check(!Object.hasOwn(card.muretai || {}, 'tools') && !Object.hasOwn(card.muretai || {}, 'events'),
      'door/legacy-muretai-alias-carries-no-tools');
    check(canonicalJSON(card.skills) === canonicalJSON(harbor.skills),
      'door/card-skills-regenerated-from-offers', canonicalJSON(card.skills));
    check(card.supportedInterfaces?.length === 1, 'door/still-one-interface');
    const inner = verifyCardEnvelope(entry.cardEnvelope(), entry.did);
    check(inner && inner.agentEntry?.tools === card.agentEntry?.tools
        && canonicalJSON(inner.skills) === canonicalJSON(card.skills),
      'door/signed-card-envelope-carries-the-same-tools-and-skills');

    const contractBytes = canonicalJSON(harbor.contract);
    const out = await get(entry, 'GET', TOOLS);
    check(out.status === 200 && String(header(out, 'content-type')).startsWith('application/json'),
      'door/GET-agent-tools.json-200-json', `HTTP ${out.status}`);
    check(bodyText(out) === contractBytes, 'door/served-bytes-are-canonical-contract',
      `\n    got  ${bodyText(out)}\n    want ${contractBytes}`);
    const head = await get(entry, 'HEAD', TOOLS);
    check(head.status === 200, 'door/HEAD-agent-tools.json-200');
    const v1 = await get(entry, 'GET', '/.well-known/agent-tools/v1.json');
    check(v1.status === 200 && bodyText(v1) === contractBytes, 'door/v1.json-is-the-current-v1-bytes');

    const s1 = await get(entry, 'GET', TOOLS_SIG);
    const s2 = await get(entry, 'GET', TOOLS_SIG);
    let env = null;
    try { env = JSON.parse(bodyText(s1)); } catch { /* reported below */ }
    check(s1.status === 200 && env?.typ === 'agenttools' && Number.isInteger(env?.ts)
        && Math.abs(Math.floor(Date.now() / 1000) - env.ts) <= 21600,
      'door/GET-agent-tools.sig.json-is-a-fresh-agenttools-envelope', bodyText(s1).slice(0, 120));
    check(bodyText(s1) === bodyText(s2), 'door/sig-is-cached-not-minted-per-request');
    if (callable(verifyToolsEnvelope) && env) {
      const back = attempt(() => verifyToolsEnvelope(env, entry.did, { origin: 'https://shop.example' }));
      check(back.ok && back.value && canonicalJSON(back.value) === contractBytes,
        'door/served-envelope-verifies-under-the-card-did');
    }

    for (const path of [TOOLS, TOOLS_SIG, '/.well-known/agent-tools/v1.json']) {
      const o = await get(entry, 'OPTIONS', path);
      check(o.status === 204 && header(o, 'allow') === ALLOW_CARD, `door/OPTIONS-${path}-allow-card`,
        `HTTP ${o.status} Allow=${header(o, 'allow')}`);
      const p = await get(entry, 'POST', path, { 'content-type': 'application/json' }, Buffer.from('{}'));
      check(p.status === 405 && header(p, 'allow') === ALLOW_CARD, `door/POST-${path}-405`,
        `HTTP ${p.status}`);
    }
    const oe = await get(entry, 'OPTIONS', EVENTS);
    check(oe.status === 204 && header(oe, 'allow') === 'POST, OPTIONS', 'door/OPTIONS-collector-allow-post',
      `HTTP ${oe.status} Allow=${header(oe, 'allow')}`);
    const ge = await get(entry, 'GET', EVENTS);
    check(ge.status === 405 && header(ge, 'allow') === 'POST, OPTIONS', 'door/GET-collector-405',
      `HTTP ${ge.status}`);

    // AE-4: every other address under the agent-tools prefix stays 404, for every method.
    for (const path of [
      '/.well-known/agent-tools', '/.well-known/agent-tools/', '/.well-known/agent-tools/v2.json',
      '/.well-known/agent-tools/v0.json', '/.well-known/agent-tools/v01.json', '/.well-known/agent-tools/V1.json',
      '/.well-known/agent-tools/v1.JSON', '/.well-known/agent-tools/v1.json/', '/.well-known/agent-tools/v1',
      '/.well-known/agent-tools/latest.json', '/.well-known/agent-tools.jsonx', '/.well-known/agent-tools.json/x',
      '/.well-known/agent-tools/events/', '/.well-known/agent-tools/events/x', '/.well-known/agent-tools/event',
      '/.well-known/agent-tools.sig.json/x', '/.well-known/agent-tools/v1.sig.json', '/.well-known/agent-toolz.json',
    ]) {
      for (const method of ['GET', 'POST', 'OPTIONS']) {
        const o = await get(entry, method, path, { 'content-type': 'application/json' }, Buffer.from('{}'));
        check(o.status === 404, `door/AE-4/${method}-${path}-404`, `HTTP ${o.status}`);
      }
    }
  }

  // A declaration served from an origin it does not name is refused at start.
  for (const baseUrl of ['https://other.example', 'http://shop.example', 'https://shop.example:8443']) {
    const r = attempt(() => createAgentEntry({
      seedHex: SEED, name: 'Harbor Lamp', baseUrl, declaration: clone(harbor.declaration),
    }));
    check(!r.ok, `origin/door-at-${baseUrl}-refuses-a-declaration-for-shop.example`);
  }
  // A declared domain is one of the contract's origins (so a page there verifies it).
  const pass = vector('unknown-verb-passes-through-with-no-defaults');
  check(JSON.stringify(pass.contract.origins)
      === JSON.stringify(['https://hire.example', 'https://pedal-hire.example']),
    'origin/vector-origins-are-baseUrl-then-lowercased-domains');

  // A door without a declaration is byte-for-byte the door it was: no tools, no collector.
  const plain = createAgentEntry({ seedHex: SEED, name: 'Plain', baseUrl: 'https://plain.example' });
  check(!Object.hasOwn(plain.card.agentEntry || {}, 'tools') && !Object.hasOwn(plain.card.agentEntry || {}, 'events'),
    'door/no-declaration-no-tools-on-the-card');
  for (const path of [TOOLS, TOOLS_SIG, '/.well-known/agent-tools/v1.json', EVENTS]) {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      const o = await get(plain, method, path, { 'content-type': 'application/json' }, Buffer.from('{}'));
      check(o.status === 404, `door/no-declaration/${method}-${path}-404`, `HTTP ${o.status}`);
    }
  }
}

// ---------------------------------------------------------------- 8. version immutability

if (callable(compileDeclaration)) {
  const harbor = vector('harbor-lamp-every-reply-kind-and-facts');
  const d1 = clone(harbor.declaration);
  const c1 = compileDeclaration(clone(d1), { version: 1 });
  const c1Bytes = canonicalJSON(c1);
  const d2 = clone(d1);
  d2.offers.push({ verb: 'track', of: 'hold', about: 'See whether your hold is ready.',
    input: { hold_id: 'string' }, door: { reply: 'facts' } });
  d2.facts.pickup = '72h';
  const c2 = compileDeclaration(clone(d2), { version: 2 });
  check(canonicalJSON(c1) === c1Bytes, 'versions/compiling-v2-leaves-v1-untouched');
  check(c2.version === 2 && c2.hash !== c1.hash, 'versions/v2-is-a-new-hash');

  const made = attempt(() => createAgentEntry({
    seedHex: SEED, name: 'Harbor Lamp', baseUrl: 'https://shop.example',
    declaration: clone(d2), toolsHistory: [clone(c1)],
  }));
  if (check(made.ok, 'versions/door-starts-with-a-history', made.ok ? '' : made.error?.message)) {
    const entry = made.value;
    const cur = await get(entry, 'GET', TOOLS);
    check(bodyText(cur) === canonicalJSON(c2), 'versions/current-is-v2');
    const v1 = await get(entry, 'GET', '/.well-known/agent-tools/v1.json');
    check(v1.status === 200 && bodyText(v1) === c1Bytes, 'versions/prior-v1-retrievable-byte-identical');
    const v2 = await get(entry, 'GET', '/.well-known/agent-tools/v2.json');
    check(v2.status === 200 && bodyText(v2) === canonicalJSON(c2), 'versions/v2-json-is-current');
    const v3 = await get(entry, 'GET', '/.well-known/agent-tools/v3.json');
    check(v3.status === 404, 'versions/no-v3-yet', `HTTP ${v3.status}`);
    const env = JSON.parse(bodyText(await get(entry, 'GET', TOOLS_SIG)));
    check(canonicalJSON(env.contract) === canonicalJSON(c2), 'versions/envelope-signs-the-current-version');
  }

  const refusesHistory = (label, history) => {
    const r = attempt(() => createAgentEntry({
      seedHex: SEED, name: 'Harbor Lamp', baseUrl: 'https://shop.example',
      declaration: clone(d2), toolsHistory: history,
    }));
    check(!r.ok, `versions/refuses/${label}`);
  };
  refusesHistory('prior-with-a-bad-hash', [{ ...clone(c1), hash: sha256hex('not it') }]);
  const edited = clone(c1); edited.facts.pickup = '1h';
  refusesHistory('prior-edited-after-publishing', [edited]);
  const foreign = compileDeclaration({ ...clone(d1), entry: { ...d1.entry, baseUrl: 'https://other.example' } },
    { version: 1 });
  refusesHistory('prior-for-another-origin', [foreign]);
  refusesHistory('gap-in-versions', [compileDeclaration(clone(d1), { version: 2 })]);
  refusesHistory('duplicate-version', [clone(c1), clone(c1)]);
  refusesHistory('not-an-array', clone(c1));
}

// ---------------------------------------------------------------- report

if (failures.length) {
  console.error(`FAILED - ${failures.length} tools check(s):`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} checks: one declaration keyed by verbs compiles to the same bytes every time, `
  + 'signs as agenttools (never as a card), and serves only from the origins it names.');
