#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// verifyIntroduction on a `requested` introduction, and the door's ledger on a repeat knock.
//
// Added by the implementer beside the test author's conformance/intro-verify.mjs, which covers a
// requested credential only with no embedded request. Here the embedded request is the subject's
// signed L2 envelope (shared/vc.py intro_request_record), checked the way the core's
// verify_intro_request does: signed by the subject, addressed to the issuer, live at the
// credential's issuanceDate, and naming this recipient when it names one.
//
// In-process only, fixed seeds, example hosts. Run it as `node conformance/intro-requested.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const { canonicalJSON, createAgentEntry, didFromSeedHex, signBytes, signEnvelope, verifyIntroduction,
  MAX_INTRODUCTIONS_PER_ACCOUNT } = door;

const DOOR_SEED = 'd1'.repeat(32);
const SUBJECT_SEED = 'd2'.repeat(32);
const INTRODUCER_SEED = 'd3'.repeat(32);
const STRANGER_SEED = 'd4'.repeat(32);
const DOOR = didFromSeedHex(DOOR_SEED);
const SUBJECT = didFromSeedHex(SUBJECT_SEED);
const INTRODUCER = didFromSeedHex(INTRODUCER_SEED);
const STRANGER = didFromSeedHex(STRANGER_SEED);

const NOW = new Date('2026-11-09T00:00:00Z');
const ISSUED_S = Date.parse('2026-11-08T12:00:00Z') / 1000;
const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function request({ seed = SUBJECT_SEED, to = INTRODUCER, text = `introduce-me-to:${DOOR}`, timestamp = ISSUED_S - 3600 } = {}) {
  const from = didFromSeedHex(seed);
  const messageId = 'req-1';
  const sig = signEnvelope(seed, { from, to, messageId, contextId: null, timestamp, text });
  return { from, to, messageId, contextId: null, timestamp, text, sig };
}

function issue({ seed = INTRODUCER_SEED, subject = SUBJECT, recipient = DOOR, provenance, id = 'urn:uuid:5eed0000000040008000000000000001',
  issued = ISSUED_S, validUntil = '2026-12-31T00:00:00Z' } = {}) {
  const issuer = didFromSeedHex(seed);
  const body = {
    credentialSubject: { expertise: ['tea'], id: subject, introducedTo: recipient, trustLevelBp: 700, validUntil },
    id, issuanceDate: iso(issued), issuer, provenance, type: ['VerifiableCredential', 'AgentIntroduction'],
  };
  if (provenance === undefined) delete body.provenance;
  const jws = signBytes(seed, Buffer.from(canonicalJSON(body), 'utf8')).toString('base64');
  return { ...body, proof: { created: body.issuanceDate, jws, type: 'Ed25519Signature2020', verificationMethod: issuer } };
}

const opts = { expectedSubject: SUBJECT, expectedRecipient: DOOR, now: NOW };

test('a requested introduction embedding the subject\'s signed request verifies', () => {
  assert.equal(verifyIntroduction(issue({ provenance: { mode: 'requested', request: request() } }), opts), true);
});

test('an untargeted (referral) request verifies too', () => {
  const req = request({ text: 'looking for someone who knows tea' });
  assert.equal(verifyIntroduction(issue({ provenance: { mode: 'requested', request: req } }), opts), true);
});

test('a requested introduction fails when its request does not back it', () => {
  const cases = [
    ['request signed by a stranger', request({ seed: STRANGER_SEED })],
    ['request addressed to another introducer', request({ to: STRANGER })],
    ['request names another target', request({ text: `introduce-me-to:${STRANGER}` })],
    ['request older than 30 days at issuance', request({ timestamp: ISSUED_S - 31 * 86400 })],
    ['request signed after issuance beyond the skew', request({ timestamp: ISSUED_S + 600 })],
    ['request with its signature edited', { ...request(), text: `introduce-me-to:${DOOR} ` }],
    ['request a string', 'introduce-me-to'],
  ];
  for (const [label, req] of cases) {
    assert.equal(verifyIntroduction(issue({ provenance: { mode: 'requested', request: req } }), opts), false, label);
  }
});

test('a credential with no provenance is tolerated, as in the core', () => {
  assert.equal(verifyIntroduction(issue({ provenance: undefined }), opts), true);
});

async function knock(entry, seed, vc, n) {
  const from = didFromSeedHex(seed);
  const messageId = `intro-req-${n}`;
  const text = 'hello';
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signEnvelope(seed, { from, to: entry.did, messageId, contextId: null, timestamp, text });
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
      metadata: { from, to: entry.did, timestamp, sig, vc } } } }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
    { remoteAddress: '127.0.0.1' });
  return JSON.parse(Buffer.from(out.body).toString('utf8'));
}

test('the door: a repeat of the same introduction refreshes its entry, and the list is capped', async () => {
  const entry = createAgentEntry({ seedHex: DOOR_SEED, name: 'Tea Door', baseUrl: 'https://tea.example',
    signedRatePerMin: 0, signedRatePerMinTotal: 0, responder: () => 'ok' });
  const now = Math.floor(Date.now() / 1000);
  const live = (id) => issue({ id, provenance: { mode: 'proactive' }, issued: now - 60, validUntil: iso(now + 86400) });
  let n = 0;
  const first = live('urn:uuid:repeat');
  assert.equal((await knock(entry, SUBJECT_SEED, first, ++n)).error, undefined);
  assert.equal((await knock(entry, SUBJECT_SEED, first, ++n)).error, undefined);
  let row = entry.ledger.get(SUBJECT);
  assert.equal(row.messages, 2);
  assert.equal(row.introductions.length, 1, 'the same introducer and id is one entry');
  for (let i = 0; i < MAX_INTRODUCTIONS_PER_ACCOUNT + 3; i += 1) {
    assert.equal((await knock(entry, SUBJECT_SEED, live(`urn:uuid:many-${i}`), ++n)).error, undefined);
  }
  row = entry.ledger.get(SUBJECT);
  assert.equal(row.introductions.length, MAX_INTRODUCTIONS_PER_ACCOUNT);
  assert.equal(row.introductions.at(-1).id, `urn:uuid:many-${MAX_INTRODUCTIONS_PER_ACCOUNT + 2}`, 'the newest is kept');
  assert.ok(!row.introductions.some((e) => e.id === 'urn:uuid:repeat'), 'the oldest fell off');
  // A later knock with no vc keeps the entries.
  assert.equal((await knock(entry, SUBJECT_SEED, undefined, ++n)).error, undefined);
  assert.equal(entry.ledger.get(SUBJECT).introductions.length, MAX_INTRODUCTIONS_PER_ACCOUNT);
});
