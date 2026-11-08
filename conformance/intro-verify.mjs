#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// verifyIntroduction: the JS port of the muretai core's verify_introduction (shared/vc.py) plus the
// introid id rule (shared/introid.py).
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). Mac A ruling 20261108T120925Z, intake
// 20261108T211322Z, "A knock that carries an introduction credential". The implementer may not edit
// this file. Run it as `node conformance/intro-verify.mjs`.
//
// The contract pinned here:
//   verifyIntroduction(vc, { expectedSubject, expectedRecipient, now }) -> boolean
//     - exported from muretai-agent-entry.mjs;
//     - `now` is a Date (the tests pass one built from the vector file's `now`);
//     - returns exactly `true` or exactly `false`, never anything else, and never throws;
//     - its verdict equals the core's Python verdict on every case of
//       conformance/vectors/intro-vectors.json (copied verbatim from the coordinator's file);
//     - structure and type ("VerifiableCredential" and "AgentIntroduction" in `type`);
//     - Ed25519 signature by the issuer's did:key over canonicalJSON(credential without `proof`),
//       carried as standard base64 in proof.jws;
//     - credentialSubject.id = expectedSubject and credentialSubject.introducedTo = expectedRecipient;
//     - credentialSubject.validUntil strictly after `now`;
//     - provenance.mode "proactive" passes, "requested" needs its embedded request (a requested
//       credential with no request fails), and any other mode fails closed;
//     - top-level `id` is a non-empty string of at most 256 UTF-8 bytes.
//   A self-issued introduction (issuer = subject) is a valid credential at THIS layer, as it is in
//   the core: refusing it is the door's choice, pinned in conformance/intro-knock.mjs.
//
// No network. Fixed clock: `now` comes from the vector file.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const { canonicalJSON, didFromSeedHex, signBytes } = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(HERE, 'vectors', 'intro-vectors.json'), 'utf8'));
const NOW = new Date(VECTORS.now);

const clone = (v) => JSON.parse(JSON.stringify(v));

function verifier() {
  assert.equal(typeof door.verifyIntroduction, 'function',
    'muretai-agent-entry.mjs exports verifyIntroduction(vc, { expectedSubject, expectedRecipient, now })');
  return door.verifyIntroduction;
}

/** The verdict, held to the boolean contract: exactly true or exactly false. */
function verdict(vc, opts) {
  const fn = verifier();
  let out;
  assert.doesNotThrow(() => { out = fn(vc, opts); }, 'verifyIntroduction never throws');
  assert.equal(typeof out, 'boolean', `verifyIntroduction returns a boolean, got ${typeof out}`);
  return out;
}

// The generator's seeds are 0x01..0x04 * 32; find which one is which DID rather than assume.
const SEEDS = ['01', '02', '03', '04'].map((b) => b.repeat(32));
const seedOf = (did) => {
  const seed = SEEDS.find((s) => didFromSeedHex(s) === did);
  assert.ok(seed, `fixture: a 0x01..0x04 seed derives ${did}`);
  return seed;
};
const INTRODUCER_SEED = seedOf(VECTORS.introducer);
const SUBJECT_SEED = seedOf(VECTORS.subject);
const DOOR = VECTORS.door;
const SUBJECT = VECTORS.subject;
const INTRODUCER = VECTORS.introducer;

/** Issue the way shared/vc.py issue_introduction does: sign canonicalJSON(credential minus proof). */
function issue(seed, credential) {
  const body = clone(credential);
  delete body.proof;
  const issuer = didFromSeedHex(seed);
  body.issuer = issuer;
  const jws = signBytes(seed, Buffer.from(canonicalJSON(body), 'utf8')).toString('base64');
  return { ...body, proof: { created: body.issuanceDate, jws, type: 'Ed25519Signature2020', verificationMethod: issuer } };
}

const VALID = VECTORS.cases.find((c) => c.name === 'valid proactive introduction');
const base = () => clone(VALID.vc);
const opts = (extra = {}) => ({ expectedSubject: SUBJECT, expectedRecipient: DOOR, now: NOW, ...extra });

// ---------------------------------------------------------------- fixture sanity

test('fixture: the vector file is the core generator output, with 9 cases', () => {
  assert.equal(VECTORS.cases.length, 9);
  assert.equal(VECTORS.now, '2026-11-09T00:00:00Z');
  assert.ok(VALID && VALID.expect === true);
});

test('fixture: re-issuing the valid vector here reproduces the core signature byte for byte', () => {
  // Proves the signing payload is canonicalJSON(credential without proof): the same bytes the
  // port must verify. If this fails, the fixture, not the implementation, is wrong.
  const again = issue(INTRODUCER_SEED, base());
  assert.equal(again.proof.jws, VALID.vc.proof.jws);
});

// ---------------------------------------------------------------- the 9 cross-language vectors

for (const c of VECTORS.cases) {
  test(`vector: ${c.name} -> ${c.expect}`, () => {
    const got = verdict(clone(c.vc), { expectedSubject: c.expectedSubject, expectedRecipient: c.expectedRecipient, now: NOW });
    assert.equal(got, c.expect, `the Python verdict for "${c.name}" is ${c.expect}`);
  });
}

// ---------------------------------------------------------------- functional, beyond the vectors

test('a freshly issued proactive introduction verifies', () => {
  assert.equal(verdict(issue(INTRODUCER_SEED, base()), opts()), true);
});

test('validUntil one second after now verifies; validUntil equal to now does not', () => {
  const live = base();
  live.credentialSubject.validUntil = '2026-11-09T00:00:01Z';
  assert.equal(verdict(issue(INTRODUCER_SEED, live), opts()), true);
  const edge = base();
  edge.credentialSubject.validUntil = '2026-11-09T00:00:00Z';
  assert.equal(verdict(issue(INTRODUCER_SEED, edge), opts()), false, 'validUntil must be AFTER now');
});

test('the id rule: exactly 256 UTF-8 bytes is accepted, 257 is not', () => {
  const at = base();
  at.id = 'é'.repeat(128); // 128 two-byte characters = 256 bytes
  assert.equal(Buffer.byteLength(at.id, 'utf8'), 256);
  assert.equal(verdict(issue(INTRODUCER_SEED, at), opts()), true);
  const over = base();
  over.id = `${'é'.repeat(128)}a`;
  assert.equal(verdict(issue(INTRODUCER_SEED, over), opts()), false, 'an id over 256 UTF-8 bytes fails');
});

test('a self-issued introduction is a valid credential at this layer, as in the core', () => {
  const self = base();
  assert.equal(verdict(issue(SUBJECT_SEED, self), opts()), true,
    'verifyIntroduction matches core; the door, not the verifier, refuses self-introduction');
});

// ---------------------------------------------------------------- refusals (all signed correctly)

const signedRefusals = [
  ['no id', (vc) => { delete vc.id; }],
  ['empty id', (vc) => { vc.id = ''; }],
  ['numeric id', (vc) => { vc.id = 12345; }],
  ['type without AgentIntroduction', (vc) => { vc.type = ['VerifiableCredential']; }],
  ['no credentialSubject', (vc) => { delete vc.credentialSubject; }],
  ['credentialSubject a string', (vc) => { vc.credentialSubject = SUBJECT; }],
  ['no validUntil', (vc) => { delete vc.credentialSubject.validUntil; }],
  ['validUntil not a date', (vc) => { vc.credentialSubject.validUntil = 'tomorrow'; }],
  ['expired a year ago', (vc) => { vc.credentialSubject.validUntil = '2025-11-09T00:00:00Z'; }],
  ['introduced to another door', (vc) => { vc.credentialSubject.introducedTo = VECTORS.other; }],
  ['for another subject', (vc) => { vc.credentialSubject.id = VECTORS.other; }],
  ['requested with no embedded request', (vc) => { vc.provenance = { mode: 'requested' }; }],
  ['provenance mode not a string', (vc) => { vc.provenance = { mode: 1 }; }],
];
for (const [name, edit] of signedRefusals) {
  test(`refusal, signed by the introducer: ${name}`, () => {
    const vc = base();
    edit(vc);
    assert.equal(verdict(issue(INTRODUCER_SEED, vc), opts()), false);
  });
}

const tamperings = [
  ['subject edited after signing', (vc) => { vc.credentialSubject.id = VECTORS.other; }],
  ['validUntil extended after signing', (vc) => { vc.credentialSubject.validUntil = '2099-01-01T00:00:00Z'; }],
  ['id swapped after signing', (vc) => { vc.id = 'urn:uuid:00000000000000000000000000000000'; }],
  ['proof.jws truncated', (vc) => { vc.proof.jws = vc.proof.jws.slice(0, 40); }],
  ['proof.jws not base64', (vc) => { vc.proof.jws = '!!!not-base64!!!'; }],
  ['proof.jws a number', (vc) => { vc.proof.jws = 7; }],
  ['proof missing', (vc) => { delete vc.proof; }],
  ['issuer not a did:key', (vc) => { vc.issuer = 'https://introducer.example'; }],
  ['an extra unsigned field added', (vc) => { vc.credentialSubject.trustLevelBp = 10000; }],
];
for (const [name, edit] of tamperings) {
  test(`refusal, tampered: ${name}`, () => {
    const vc = base();
    edit(vc);
    assert.equal(verdict(vc, opts()), false);
  });
}

test('refusal: the expectations are required, never inferred from the credential', () => {
  const vc = base();
  assert.equal(verdict(vc, { expectedRecipient: DOOR, now: NOW }), false, 'no expectedSubject');
  assert.equal(verdict(vc, { expectedSubject: SUBJECT, now: NOW }), false, 'no expectedRecipient');
  assert.equal(verdict(vc, { expectedSubject: '', expectedRecipient: DOOR, now: NOW }), false, 'empty expectedSubject');
});

// ---------------------------------------------------------------- never throws (fail closed)

test('never throws: hostile and malformed inputs answer false', () => {
  const cyclic = base();
  cyclic.credentialSubject.self = cyclic;
  const exploding = new Proxy(base(), { get() { throw new Error('boom'); } });
  const getter = base();
  Object.defineProperty(getter, 'issuer', { enumerable: true, get() { throw new Error('boom'); } });
  const inputs = [undefined, null, 0, 1, true, '', 'vc', [], [base()], {}, JSON.stringify(base()),
    cyclic, exploding, getter, Object.create(null), { __proto__: base() }];
  for (const vc of inputs) {
    assert.equal(verdict(vc, opts()), false);
  }
});

test('never throws: malformed options answer false', () => {
  const vc = base();
  for (const o of [undefined, null, 'x', 1, {}, { now: 'not a date', expectedSubject: SUBJECT, expectedRecipient: DOOR },
    { now: new Date(Number.NaN), expectedSubject: SUBJECT, expectedRecipient: DOOR },
    { now: NOW, expectedSubject: 7, expectedRecipient: DOOR }]) {
    assert.equal(verdict(vc, o), false);
  }
});
