#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Kind fuzz: the introduction credential, as it arrives from outside the process in a knock's
// metadata.vc.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). Mac A ruling 20261108T120925Z, intake
// 20261108T211322Z. The implementer may not edit this file. Run it as
// `node conformance/intro-fuzz.mjs`.
//
// Property: no_crash -- for every generated value, verifyIntroduction returns exactly true or false
// and never throws; and, as the fail-closed half, every generated value that differs from the valid
// vector in a SIGNED part (anything outside `proof`, or proof.jws) answers false. At the door, a
// signed knock carrying any generated vc is answered (never a crash, never a refusal) and never
// records an introduction.
//
// Deterministic: a local seeded generator (mulberry32, fixed seed), the vector file's fixed `now`,
// no network. A failure names the case index and the value, so it reproduces exactly.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const { canonicalJSON, createAgentEntry, didFromSeedHex, signEnvelope } = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(HERE, 'vectors', 'intro-vectors.json'), 'utf8'));
const NOW = new Date(VECTORS.now);
const VALID = VECTORS.cases.find((c) => c.name === 'valid proactive introduction');
const OPTS = { expectedSubject: VALID.expectedSubject, expectedRecipient: VALID.expectedRecipient, now: NOW };

const FUZZ_SEED = 0x1e7d0c55;
const UNIT_CASES = 800;
const DOOR_CASES = 60;

const clone = (v) => JSON.parse(JSON.stringify(v));

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

const ODD = [null, true, false, 0, -1, 1.5, 1e21, [], {}, ['x'], { a: 1 }, '', ' ', '__proto__', 'constructor',
  'did:key:z6Mk', '2099-01-01T00:00:00Z', 'proactive', 'requested', 'AgentIntroduction', ['AgentIntroduction']];

function randomValue(rand, depth = 0) {
  const k = Math.floor(rand() * (depth > 2 ? 3 : 5));
  if (k === 0) return pick(rand, ODD);
  if (k === 1) return randomString(rand);
  if (k === 2) return Math.floor(rand() * 2 ** 31) * (rand() < 0.5 ? -1 : 1);
  if (k === 3) return Array.from({ length: Math.floor(rand() * 3) }, () => randomValue(rand, depth + 1));
  const o = {};
  for (let i = 0; i < Math.floor(rand() * 4); i += 1) o[pick(rand, ['id', 'type', 'issuer', 'proof', 'jws', randomString(rand)])] = randomValue(rand, depth + 1);
  return o;
}

/** Every path into the valid vector, as key lists. */
function paths(v, prefix = []) {
  const out = [prefix];
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) out.push(...paths(v[k], [...prefix, k]));
  }
  return out;
}
const SIGNED_PATHS = paths(VALID.vc).filter((p) => p.length > 0 && (p[0] !== 'proof' || p[1] === 'jws'));
const ALL_PATHS = paths(VALID.vc).filter((p) => p.length > 0);

function setPath(obj, path, value, remove) {
  let cur = obj;
  for (const k of path.slice(0, -1)) {
    if (!cur || typeof cur !== 'object') return;
    cur = cur[k];
  }
  if (!cur || typeof cur !== 'object') return;
  const last = path[path.length - 1];
  if (remove) delete cur[last];
  else cur[last] = value;
}

const unsignedOf = (vc) => { const c = { ...vc }; delete c.proof; return c; };
function signedPartsEqual(a, b) {
  try {
    return canonicalJSON(unsignedOf(a)) === canonicalJSON(unsignedOf(b)) && a.proof?.jws === b.proof?.jws;
  } catch {
    return false;
  }
}

/** Case i: a mutation of the valid vector (signed or unsigned part), or a free-form value. */
function generate(rand) {
  const mode = Math.floor(rand() * 4);
  if (mode === 0) return { vc: randomValue(rand), free: true };
  const vc = clone(VALID.vc);
  const path = pick(rand, mode === 3 ? ALL_PATHS : SIGNED_PATHS);
  setPath(vc, path, randomValue(rand), rand() < 0.25);
  return { vc, free: false };
}

test('fixture: the valid vector is the core output', () => {
  assert.equal(VALID.expect, true);
  assert.ok(SIGNED_PATHS.length > 10);
});

test(`no_crash: ${UNIT_CASES} generated credentials answer a boolean, and a signed-part change answers false`, () => {
  assert.equal(typeof door.verifyIntroduction, 'function', 'verifyIntroduction is exported');
  const rand = mulberry32(FUZZ_SEED);
  for (let i = 0; i < UNIT_CASES; i += 1) {
    const { vc } = generate(rand);
    const shown = (() => { try { return JSON.stringify(vc).slice(0, 300); } catch { return String(vc); } })();
    let out;
    assert.doesNotThrow(() => { out = door.verifyIntroduction(vc, OPTS); }, `case ${i} threw: ${shown}`);
    assert.equal(typeof out, 'boolean', `case ${i} returned ${typeof out}: ${shown}`);
    const changed = !(vc && typeof vc === 'object' && !Array.isArray(vc) && signedPartsEqual(vc, VALID.vc));
    if (changed) assert.equal(out, false, `case ${i}: a credential whose signed part changed verified: ${shown}`);
  }
});

test(`no_crash at the door: ${DOOR_CASES} generated vc values are answered and never recorded`, async () => {
  const VISITOR_SEED = '6b'.repeat(32);
  const visitor = didFromSeedHex(VISITOR_SEED);
  const entry = createAgentEntry({ seedHex: '5a'.repeat(32), name: 'Fuzz Door', baseUrl: 'https://fuzz.example',
    signedRatePerMin: 0, signedRatePerMinTotal: 0, responder: () => 'ok' });
  const rand = mulberry32(FUZZ_SEED ^ 0xd00d);
  for (let i = 0; i < DOOR_CASES; i += 1) {
    const { vc } = generate(rand);
    const messageId = `intro-fuzz-${i}`;
    const text = 'fuzz knock';
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = signEnvelope(VISITOR_SEED, { from: visitor, to: entry.did, messageId, contextId: null, timestamp, text });
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: messageId, method: 'message/send',
      params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
        metadata: { from: visitor, to: entry.did, timestamp, sig, vc } } } }));
    const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
      { remoteAddress: '127.0.0.1' });
    const json = JSON.parse(Buffer.from(out.body).toString('utf8'));
    assert.equal(json.error, undefined, `case ${i}: refused: ${JSON.stringify(json.error)} for ${JSON.stringify(vc).slice(0, 200)}`);
    const row = entry.ledger.get(visitor);
    assert.ok(row, `case ${i}: the visitor is enrolled`);
    assert.ok(row.introductions === undefined || row.introductions.length === 0,
      `case ${i}: recorded an introduction for a credential addressed to another door: ${JSON.stringify(row.introductions)}`);
  }
});
