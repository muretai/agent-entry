#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Fix round 1 for the introduction credential on a signed knock: four LOW findings from the
// security review of f48753b, each checked against the core's Python verifier (shared/vc.py,
// shared/introid.py) under Python 3.9, 3.11 and 3.12.
//
//   1. a `requested` credential whose embedded request has a non-string `text` (5, {}, or an
//      array naming another DID) verifies false, as in Python;
//   2. dates are stripped the way Python's str.strip does, not String.prototype.trim, and a
//      fraction is exactly 3 or 6 digits (Python 3.9 fromisoformat, the core's floor);
//   3. an introduction issued by the visitor's own op key records nothing;
//   4. the device-to-owner fold drops a device entry whose introducer is the owner, and merges
//      by verified_at, keeping the newest 16.
//
// In-process only, fixed seeds, example hosts. Run it as `node conformance/intro-fix1.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const { canonicalBytes, canonicalJSON, createAgentEntry, didFromSeedHex, publicKeyFromSeedHex, signBytes,
  signEnvelope, verifyIntroduction, BINDING_V2_TYP, MAX_INTRODUCTIONS_PER_ACCOUNT } = door;

const DOOR_SEED = 'e1'.repeat(32);
const SUBJECT_SEED = 'e2'.repeat(32);
const INTRODUCER_SEED = 'e3'.repeat(32);
const STRANGER_SEED = 'e4'.repeat(32);
const OP_SEED = 'e5'.repeat(32);
const OWNER_SEED = 'e6'.repeat(32);
const DEVICE_SEED = 'e7'.repeat(32);
const DOOR = didFromSeedHex(DOOR_SEED);
const SUBJECT = didFromSeedHex(SUBJECT_SEED);
const INTRODUCER = didFromSeedHex(INTRODUCER_SEED);
const STRANGER = didFromSeedHex(STRANGER_SEED);
const OP = didFromSeedHex(OP_SEED);
const OWNER = didFromSeedHex(OWNER_SEED);
const DEVICE = didFromSeedHex(DEVICE_SEED);

const NOW = new Date('2026-11-09T00:00:00Z');
const ISSUED_S = Date.parse('2026-11-08T12:00:00Z') / 1000;
const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const nowS = () => Math.floor(Date.now() / 1000);

function request({ text = `introduce-me-to:${DOOR}`, timestamp = ISSUED_S - 3600 } = {}) {
  const from = SUBJECT;
  const to = INTRODUCER;
  const messageId = 'req-fix1';
  const sig = signEnvelope(SUBJECT_SEED, { from, to, messageId, contextId: null, timestamp, text });
  return { from, to, messageId, contextId: null, timestamp, text, sig };
}

function issue({ seed = INTRODUCER_SEED, subject = SUBJECT, recipient = DOOR, provenance = { mode: 'proactive' },
  id = 'urn:uuid:f1x10000000040008000000000000001', issued = ISSUED_S, validUntil = '2026-12-31T00:00:00Z' } = {}) {
  const issuer = didFromSeedHex(seed);
  const body = {
    credentialSubject: { expertise: ['tea'], id: subject, introducedTo: recipient, trustLevelBp: 700, validUntil },
    id, issuanceDate: iso(issued), issuer, provenance, type: ['VerifiableCredential', 'AgentIntroduction'],
  };
  const jws = signBytes(seed, Buffer.from(canonicalJSON(body), 'utf8')).toString('base64');
  return { ...body, proof: { created: body.issuanceDate, jws, type: 'Ed25519Signature2020', verificationMethod: issuer } };
}

const opts = { expectedSubject: SUBJECT, expectedRecipient: DOOR, now: NOW };

// ---------------------------------------------------------------- 1. request field types

test('finding 1: a requested introduction whose request text is not a string verifies false', () => {
  assert.equal(verifyIntroduction(issue({ provenance: { mode: 'requested', request: request() } }), opts), true,
    'fixture: the string request verifies');
  for (const [label, text] of [
    ['text 5', 5],
    ['text {}', {}],
    ['text an array naming another DID', [`introduce-me-to:${STRANGER}`]],
  ]) {
    const vc = issue({ provenance: { mode: 'requested', request: request({ text }) } });
    assert.equal(verifyIntroduction(vc, opts), false, label);
  }
});

test('finding 1: from, to, messageId and sig must be strings too', () => {
  const good = request();
  for (const [label, edit] of [
    ['messageId a number', { messageId: 7 }],
    ['messageId an object', { messageId: {} }],
    ['sig an array', { sig: [good.sig] }],
    ['to an array', { to: [INTRODUCER] }],
    ['from an array', { from: [SUBJECT] }],
  ]) {
    const vc = issue({ provenance: { mode: 'requested', request: { ...good, ...edit } } });
    assert.equal(verifyIntroduction(vc, opts), false, label);
  }
});

test('finding 1: the named target is stripped as Python strips it (a leading U+FEFF is kept)', () => {
  // shared/vc.py intro_request_target: text[len(prefix):].strip(). Python's strip keeps U+FEFF,
  // so the target is not this door and the credential fails; String.prototype.trim dropped it.
  const vc = issue({ provenance: { mode: 'requested', request: request({ text: `introduce-me-to:﻿${DOOR}` }) } });
  assert.equal(verifyIntroduction(vc, opts), false);
});

// ---------------------------------------------------------------- 2. dates as Python parses them

test('finding 2: validUntil is stripped by Python str.strip and takes a 3 or 6 digit fraction only', () => {
  // Python 3.9 datetime.fromisoformat (the core's floor) accepts a fraction of exactly 3 or 6
  // digits, and shared/vc.py _parse_iso strips with str.strip, which keeps U+FEFF and drops
  // \x1c. JS answers what Python answers, on both sides.
  const cases = [
    ['leading U+FEFF (Python refuses; trim() accepted it)', '﻿2026-12-31T00:00:00Z', false],
    ['trailing \\x1c (Python strips it and accepts)', '2026-12-31T00:00:00Z\x1c', true],
    ['1-digit fraction', '2026-12-31T00:00:00.5Z', false],
    ['7-digit fraction', '2026-12-31T00:00:00.1234567Z', false],
    ['3-digit fraction', '2026-12-31T00:00:00.123Z', true],
    ['6-digit fraction', '2026-12-31T00:00:00.123456Z', true],
  ];
  for (const [label, validUntil, want] of cases) {
    assert.equal(verifyIntroduction(issue({ validUntil }), opts), want, label);
  }
});

// ---------------------------------------------------------------- the door

async function knock(entry, { seed, from = didFromSeedHex(seed), vc, keystate, binding, n }) {
  const messageId = `intro-fix1-${n}`;
  const text = 'hello';
  const timestamp = nowS();
  const sig = signEnvelope(seed, { from, to: entry.did, messageId, contextId: null, timestamp, text });
  const metadata = { from, to: entry.did, timestamp, sig };
  if (vc !== undefined) metadata.vc = vc;
  if (keystate !== undefined) metadata.keystate = keystate;
  if (binding !== undefined) metadata.binding = binding;
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
      metadata } } }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
    { remoteAddress: '127.0.0.1' });
  return JSON.parse(Buffer.from(out.body).toString('utf8'));
}

const newEntry = () => createAgentEntry({ seedHex: DOOR_SEED, name: 'Fix Door', baseUrl: 'https://fix.example',
  signedRatePerMin: 0, signedRatePerMinTotal: 0, responder: () => 'ok' });

function keystateFor(rootSeed, opSeed) {
  const unsigned = {
    typ: 'muretai/keystate/1', rootDid: didFromSeedHex(rootSeed), epoch: 1,
    rootKey: publicKeyFromSeedHex(rootSeed).toString('hex'), rootNextHash: '',
    opDid: didFromSeedHex(opSeed), opNextHash: '', encPub: '', encNextHash: '', guardiansHash: '',
    revokedOps: [], notBefore: 0, notAfter: null, ts: 1,
  };
  return { ...unsigned, sig: signBytes(rootSeed, canonicalBytes(unsigned)).toString('base64') };
}

test('finding 3: an introduction issued by the visitor\'s own op key records nothing', async () => {
  const entry = newEntry();
  const t = nowS();
  const vc = issue({ seed: OP_SEED, recipient: entry.did, issued: t - 60, validUntil: iso(t + 86400) });
  assert.equal(verifyIntroduction(vc, { expectedSubject: SUBJECT, expectedRecipient: entry.did, now: new Date() }),
    true, 'fixture: the op-key-issued credential verifies as a credential');
  const res = await knock(entry, { seed: OP_SEED, from: SUBJECT, vc, keystate: keystateFor(SUBJECT_SEED, OP_SEED), n: 1 });
  assert.equal(res.error, undefined, `answered as an ordinary knock: ${JSON.stringify(res.error)}`);
  const row = entry.ledger.get(SUBJECT);
  assert.ok(row, 'the visitor is enrolled');
  assert.ok(row.introductions === undefined || row.introductions.length === 0,
    `no introductions entry from the visitor's own op key: ${JSON.stringify(row.introductions)}`);
  assert.ok(!JSON.stringify(row).includes(OP), 'the op key is not recorded as an introducer');
});

test('finding 3: a different introducer on the same op-keyed knock is still recorded', async () => {
  const entry = newEntry();
  const t = nowS();
  const vc = issue({ recipient: entry.did, issued: t - 60, validUntil: iso(t + 86400) });
  const res = await knock(entry, { seed: OP_SEED, from: SUBJECT, vc, keystate: keystateFor(SUBJECT_SEED, OP_SEED), n: 2 });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(entry.ledger.get(SUBJECT).introductions.map((e) => e.introducer), [INTRODUCER]);
});

// ---------------------------------------------------------------- 4. the device-to-owner fold

function bindingFor(ownerSeed, deviceSeed) {
  const ts = nowS() - 10;
  const payload = canonicalBytes({ typ: BINDING_V2_TYP, rootDid: didFromSeedHex(ownerSeed),
    deviceDid: didFromSeedHex(deviceSeed), ts, validUntil: 0 });
  return { typ: BINDING_V2_TYP, rootDid: didFromSeedHex(ownerSeed), deviceDid: didFromSeedHex(deviceSeed), ts,
    validUntil: 0, sig: signBytes(ownerSeed, payload).toString('base64'),
    deviceSig: signBytes(deviceSeed, payload).toString('base64') };
}

const entryOf = (introducer, id, verifiedAt) => ({ introducer, id, verified_at: verifiedAt });

test('finding 4: the fold drops the owner\'s self-introduction and keeps the newest 16 by verified_at', async () => {
  const entry = newEntry();
  const ownerIntros = Array.from({ length: MAX_INTRODUCTIONS_PER_ACCOUNT },
    (_, i) => entryOf(INTRODUCER, `urn:uuid:owner-${i}`, 1000 + i));
  entry.ledger.set(OWNER, { first_seen: 900, last_seen: 1100, messages: 5, introductions: ownerIntros });
  entry.ledger.set(DEVICE, { first_seen: 800, last_seen: 850, messages: 2, introductions: [
    entryOf(OWNER, 'urn:uuid:self', 1500),
    entryOf(STRANGER, 'urn:uuid:dev-old', 10),
    entryOf(STRANGER, 'urn:uuid:dev-new', 5000),
  ] });
  const res = await knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED), n: 3 });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(entry.ledger.get(DEVICE), undefined, 'the device row moved');
  const got = entry.ledger.get(OWNER).introductions;
  assert.equal(got.length, MAX_INTRODUCTIONS_PER_ACCOUNT);
  assert.ok(!got.some((e) => e.introducer === OWNER), `no self-introduction of the owner: ${JSON.stringify(got)}`);
  assert.ok(!got.some((e) => e.id === 'urn:uuid:dev-old'), 'the device\'s old entry does not evict newer ones');
  assert.equal(got.at(-1).id, 'urn:uuid:dev-new', 'the newest entry is last');
  assert.ok(!got.some((e) => e.id === 'urn:uuid:owner-0'), 'only the oldest owner entry fell off');
  for (let i = 1; i < MAX_INTRODUCTIONS_PER_ACCOUNT; i += 1) {
    assert.ok(got.some((e) => e.id === `urn:uuid:owner-${i}`), `owner-${i} kept`);
  }
  const times = got.map((e) => e.verified_at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'ordered oldest to newest');
});

test('finding 4: a device row moved to an owner with no row loses the owner\'s self-introduction', async () => {
  const entry = newEntry();
  entry.ledger.set(DEVICE, { first_seen: 800, last_seen: 850, messages: 2, introductions: [
    entryOf(OWNER, 'urn:uuid:self', 1500),
    entryOf(STRANGER, 'urn:uuid:dev-kept', 1600),
  ] });
  const res = await knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED), n: 4 });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepEqual(entry.ledger.get(OWNER).introductions.map((e) => e.id), ['urn:uuid:dev-kept']);
});
