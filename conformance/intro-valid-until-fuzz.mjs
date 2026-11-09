#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Kind fuzz: valid_until on an introduction entry, derived from a credentialSubject.validUntil that
// arrives from outside the process in a knock's metadata.vc (intake 20261109T015407Z).
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). The implementer may not edit this file.
// Run it as `node conformance/intro-valid-until-fuzz.mjs`.
//
// Property: equivalent -- for every generated validUntil spelling (offsets, 3 and 6 digit
// fractions, a trailing character Python's str.strip drops, and random noise), the knock is
// answered and never crashes; when verifyIntroduction accepts the credential, the recorded entry
// has exactly the four keys and valid_until is a safe integer within one second of the instant
// the spelling names; when it refuses, nothing is recorded.
//
// Deterministic: a local seeded generator (mulberry32, fixed seed), no network. A failure names the
// case index and the spelling, so it reproduces exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const { canonicalJSON, createAgentEntry, didFromSeedHex, signBytes, signEnvelope, verifyIntroduction } = door;

const DOOR_SEED = 'c1'.repeat(32);
const VISITOR_SEED = 'c2'.repeat(32);
const INTRODUCER_SEED = 'c4'.repeat(32);
const VISITOR = didFromSeedHex(VISITOR_SEED);
const INTRODUCER = didFromSeedHex(INTRODUCER_SEED);
const FUZZ_SEED = 0x7a11d0e5;
const CASES = 80;
const KEYS4 = ['id', 'introducer', 'valid_until', 'verified_at'];

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

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** A spelling of an instant some days ahead, and the epoch second (possibly fractional) it names,
 *  or null for the instant when the spelling is noise. */
function spelling(rand, baseS) {
  const ahead = baseS + 3600 + Math.floor(rand() * 400 * 86400);
  const offMin = [0, 0, 540, -300, 330, -720, 345][Math.floor(rand() * 7)];
  const local = new Date((ahead + offMin * 60) * 1000);
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  let frac = '';
  let fracS = 0;
  const fk = Math.floor(rand() * 3);
  if (fk === 1) { const ms = Math.floor(rand() * 1000); frac = `.${pad(ms, 3)}`; fracS = ms / 1000; }
  if (fk === 2) { const us = Math.floor(rand() * 1e6); frac = `.${pad(us, 6)}`; fracS = us / 1e6; }
  let zone;
  if (offMin === 0 && rand() < 0.5) zone = 'Z';
  else {
    const sign = offMin < 0 ? '-' : '+';
    const a = Math.abs(offMin);
    zone = `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }
  let text = `${date}T${time}${frac}${zone}`;
  const noise = Math.floor(rand() * 6);
  if (noise === 1) text = ` ${text}\x1c`;
  if (noise === 2) {
    const at = Math.floor(rand() * 10);
    return { text: `${text.slice(0, at)}x${text.slice(at + 1)}`.replace(/^(\d{4})-/, '$1x'), instant: null };
  }
  if (noise === 3) return { text: text.replace('T', ' '), instant: ahead + fracS };
  return { text, instant: ahead + fracS };
}

let serial = 0;
function issue(recipient, validUntil) {
  const t = Math.floor(Date.now() / 1000);
  serial += 1;
  const body = {
    credentialSubject: { expertise: ['kites'], id: VISITOR, introducedTo: recipient, trustLevelBp: 400, validUntil },
    id: `urn:uuid:f0220000000040008000000000${String(serial).padStart(6, '0')}`,
    issuanceDate: new Date((t - 60) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    issuer: INTRODUCER,
    provenance: { mode: 'proactive' },
    type: ['VerifiableCredential', 'AgentIntroduction'],
  };
  const jws = signBytes(INTRODUCER_SEED, Buffer.from(canonicalJSON(body), 'utf8')).toString('base64');
  return { ...body, proof: { created: body.issuanceDate, jws, type: 'Ed25519Signature2020',
    verificationMethod: INTRODUCER } };
}

async function knock(entry, vc, n) {
  const messageId = `intro-vu-fuzz-${n}`;
  const text = 'hello';
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signEnvelope(VISITOR_SEED, { from: VISITOR, to: entry.did, messageId, contextId: null, timestamp, text });
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
      metadata: { from: VISITOR, to: entry.did, timestamp, sig, vc } } } }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
    { remoteAddress: '127.0.0.1' });
  return { status: out.status, json: JSON.parse(Buffer.from(out.body).toString('utf8')) };
}

test('fuzz: valid_until is the integer second the validUntil spelling names, or nothing is recorded', async () => {
  const rand = mulberry32(FUZZ_SEED);
  const baseS = Math.floor(Date.now() / 1000);
  let recorded = 0;
  for (let i = 0; i < CASES; i += 1) {
    const { text, instant } = spelling(rand, baseS);
    const label = `case ${i}: ${JSON.stringify(text)}`;
    const entry = createAgentEntry({ seedHex: DOOR_SEED, name: 'Fuzz Door', baseUrl: 'https://fuzz.example',
      signedRatePerMin: 0, signedRatePerMinTotal: 0, responder: () => 'ok' });
    const vc = issue(entry.did, text);
    let verdict;
    assert.doesNotThrow(() => {
      verdict = verifyIntroduction(vc, { expectedSubject: VISITOR, expectedRecipient: entry.did, now: new Date() });
    }, label);
    const res = await knock(entry, vc, i);
    assert.equal(res.status, 200, `${label}: HTTP 200`);
    assert.equal(res.json.error, undefined, `${label}: answered, not refused`);
    const intros = entry.ledger.get(VISITOR)?.introductions ?? [];
    if (verdict !== true) {
      assert.equal(intros.length, 0, `${label}: a refused credential records nothing`);
      continue;
    }
    recorded += 1;
    assert.equal(intros.length, 1, `${label}: one entry`);
    const [e] = intros;
    assert.deepEqual(Object.keys(e).sort(), KEYS4, `${label}: four keys: ${JSON.stringify(e)}`);
    assert.ok(Number.isSafeInteger(e.valid_until), `${label}: integer valid_until: ${e.valid_until}`);
    assert.ok(instant !== null, `${label}: fixture: an accepted spelling names an instant`);
    assert.ok(Math.abs(e.valid_until - instant) < 1, `${label}: ${e.valid_until} within a second of ${instant}`);
    assert.ok(e.valid_until > e.verified_at, `${label}: the credential was live when verified`);
  }
  assert.ok(recorded >= CASES / 3, `fixture: enough accepted spellings to mean something: ${recorded}`);
});
