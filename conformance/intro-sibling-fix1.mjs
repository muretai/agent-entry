#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Fix round 1 for the sibling-device refusal: two LOW findings from the review of 19de2a6.
//
//   1. the knock-time sibling read (getDeviceOwner on the introducer) must not start before the
//      keystate write resolves: with an async store, its rejection while putKeyState is pending
//      was an unhandled rejection, and Node 22 exits on one. A rejected read fails closed: the
//      knock is answered and no introduction is recorded.
//   2. the device-to-owner fold must do every read before it writes, and delete the device row
//      only after the owner row is written: a read that rejects mid-fold lost the device's
//      messages and introductions, and the fold never re-ran.
//
// In-process only: handleRequestAsync over an async store, no listen, no network. Example hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const { canonicalBytes, canonicalJSON, createAgentEntry, createMemoryStore, didFromSeedHex, publicKeyFromSeedHex,
  signBytes, signEnvelope, BINDING_V2_TYP } = door;

const DOOR_SEED = 'c1'.repeat(32);
const SUBJECT_SEED = 'c2'.repeat(32);
const OP_SEED = 'c3'.repeat(32);
const INTRODUCER_SEED = 'c4'.repeat(32);
const OWNER_SEED = 'c5'.repeat(32);
const DEVICE_SEED = 'c6'.repeat(32);
const STRANGER_SEED = 'c7'.repeat(32);
const SUBJECT = didFromSeedHex(SUBJECT_SEED);
const INTRODUCER = didFromSeedHex(INTRODUCER_SEED);
const OWNER = didFromSeedHex(OWNER_SEED);
const DEVICE = didFromSeedHex(DEVICE_SEED);
const STRANGER = didFromSeedHex(STRANGER_SEED);

const nowS = () => Math.floor(Date.now() / 1000);
const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every unhandled rejection in this process is a failure: Node 22 would exit on it.
const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

/** A memory store behind an async seam. `rejectOwnerOf` names DIDs whose getDeviceOwner read
 *  rejects while it is set; `putKeyStateDelayMs` holds the keystate write open that long. */
function asyncStore({ putKeyStateDelayMs = 0 } = {}) {
  const inner = createMemoryStore();
  const rejectOwnerOf = new Set();
  const store = {};
  for (const [k, fn] of Object.entries(inner)) store[k] = async (...a) => fn(...a);
  store.getDeviceOwner = async (did) => {
    if (rejectOwnerOf.has(did)) throw new Error(`example store outage reading ${did}`);
    return inner.getDeviceOwner(did);
  };
  store.putKeyState = async (...a) => {
    await sleep(putKeyStateDelayMs);
    return inner.putKeyState(...a);
  };
  return { store, rejectOwnerOf };
}

const newEntry = (store) => createAgentEntry({ seedHex: DOOR_SEED, name: 'Fix Door', baseUrl: 'https://fix.example',
  signedRatePerMin: 0, signedRatePerMinTotal: 0, responder: () => 'ok', store });

let serial = 0;
function issue({ issuerSeed, subject, recipient }) {
  const issuer = didFromSeedHex(issuerSeed);
  const t = nowS();
  serial += 1;
  const body = {
    credentialSubject: { expertise: ['tea'], id: subject, introducedTo: recipient, trustLevelBp: 600,
      validUntil: iso(t + 86400) },
    id: `urn:uuid:5f1c0000000040008000000000${String(serial).padStart(6, '0')}`,
    issuanceDate: iso(t - 60), issuer, provenance: { mode: 'proactive' },
    type: ['VerifiableCredential', 'AgentIntroduction'],
  };
  const jws = signBytes(issuerSeed, Buffer.from(canonicalJSON(body), 'utf8')).toString('base64');
  return { ...body, proof: { created: body.issuanceDate, jws, type: 'Ed25519Signature2020', verificationMethod: issuer } };
}

function keystateFor(rootSeed, opSeed) {
  const unsigned = {
    typ: 'muretai/keystate/1', rootDid: didFromSeedHex(rootSeed), epoch: 1,
    rootKey: publicKeyFromSeedHex(rootSeed).toString('hex'), rootNextHash: '',
    opDid: didFromSeedHex(opSeed), opNextHash: '', encPub: '', encNextHash: '', guardiansHash: '',
    revokedOps: [], notBefore: 0, notAfter: null, ts: 1,
  };
  return { ...unsigned, sig: signBytes(rootSeed, canonicalBytes(unsigned)).toString('base64') };
}

function bindingFor(ownerSeed, deviceSeed) {
  const ts = nowS() - 10;
  const payload = canonicalBytes({ typ: BINDING_V2_TYP, rootDid: didFromSeedHex(ownerSeed),
    deviceDid: didFromSeedHex(deviceSeed), ts, validUntil: 0 });
  return { typ: BINDING_V2_TYP, rootDid: didFromSeedHex(ownerSeed), deviceDid: didFromSeedHex(deviceSeed), ts,
    validUntil: 0, sig: signBytes(ownerSeed, payload).toString('base64'),
    deviceSig: signBytes(deviceSeed, payload).toString('base64') };
}

let msgSerial = 0;
async function knock(entry, { seed, from = didFromSeedHex(seed), vc, keystate, binding }) {
  const messageId = `intro-sib-fix1-${++msgSerial}`;
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
  let json = null;
  try { json = JSON.parse(Buffer.from(out.body).toString('utf8')); } catch { /* reported by the caller */ }
  return { status: out.status, json };
}

// ---------------------------------------------------------------- 1. the knock-time sibling read

test('finding 1: a rejected sibling read while the keystate write is pending fails closed', async () => {
  const { store, rejectOwnerOf } = asyncStore({ putKeyStateDelayMs: 40 });
  const entry = newEntry(store);
  const vc = issue({ issuerSeed: INTRODUCER_SEED, subject: SUBJECT, recipient: entry.did });
  rejectOwnerOf.add(INTRODUCER);
  const before = unhandled.length;
  const res = await knock(entry, { seed: OP_SEED, from: SUBJECT, vc, keystate: keystateFor(SUBJECT_SEED, OP_SEED) });
  await sleep(60);
  assert.equal(unhandled.length, before, `no unhandled rejection: ${unhandled.slice(before).map(String)}`);
  assert.equal(res.status, 200, 'HTTP 200');
  assert.equal(res.json?.error, undefined, `answered, not refused: ${JSON.stringify(res.json?.error)}`);
  assert.ok(res.json?.result, 'a result');
  const row = await store.getAccount(SUBJECT);
  assert.ok(row, 'the visitor is enrolled');
  assert.ok(!row.introductions || row.introductions.length === 0,
    `no introduction recorded: ${JSON.stringify(row.introductions)}`);
  assert.ok(await store.getKeyState(SUBJECT), 'the keystate advance is still written');
});

test('control, finding 1: the same knock with a healthy store records the introduction', async () => {
  const { store } = asyncStore({ putKeyStateDelayMs: 40 });
  const entry = newEntry(store);
  const vc = issue({ issuerSeed: INTRODUCER_SEED, subject: SUBJECT, recipient: entry.did });
  const res = await knock(entry, { seed: OP_SEED, from: SUBJECT, vc, keystate: keystateFor(SUBJECT_SEED, OP_SEED) });
  assert.equal(res.json?.error, undefined, JSON.stringify(res.json?.error));
  assert.deepEqual((await store.getAccount(SUBJECT)).introductions.map((e) => e.introducer), [INTRODUCER]);
});

// ---------------------------------------------------------------- 2. the device-to-owner fold

const entryOf = (introducer, id, verifiedAt) => ({ introducer, id, verified_at: verifiedAt });

for (const ownerHasRow of [false, true]) {
  test(`finding 2: a sibling read that rejects mid-fold loses nothing, and the fold re-runs (owner row: ${ownerHasRow})`,
    async () => {
      const { store, rejectOwnerOf } = asyncStore();
      const entry = newEntry(store);
      if (ownerHasRow) await store.putAccount(OWNER, { first_seen: 700, last_seen: 900, messages: 3 });
      const devRow = { first_seen: 800, last_seen: 850, messages: 2, introductions: [
        entryOf(INTRODUCER, 'urn:uuid:fold-fix1-a', 1500),
        entryOf(STRANGER, 'urn:uuid:fold-fix1-b', 1600),
      ] };
      await store.putAccount(DEVICE, devRow);
      rejectOwnerOf.add(STRANGER);
      const before = unhandled.length;
      // The outage may surface as a refused knock or a rejected call; either is fine, as long
      // as nothing is lost.
      await knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED) }).catch(() => {});
      await sleep(10);
      assert.equal(unhandled.length, before, `no unhandled rejection: ${unhandled.slice(before).map(String)}`);
      assert.deepEqual(await store.getAccount(DEVICE), devRow, 'the device row and its entries still exist');

      rejectOwnerOf.clear();
      const res = await knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
      assert.equal(res.json?.error, undefined, `the later knock is answered: ${JSON.stringify(res.json?.error)}`);
      assert.equal(await store.getAccount(DEVICE), null, 'the later fold moved the device row');
      const owner = await store.getAccount(OWNER);
      assert.equal(owner.messages, (ownerHasRow ? 3 : 0) + 2 + 1, `the device messages carried over: ${JSON.stringify(owner)}`);
      assert.equal(owner.first_seen, ownerHasRow ? 700 : 800);
      assert.deepEqual(owner.introductions.map((e) => e.id), ['urn:uuid:fold-fix1-a', 'urn:uuid:fold-fix1-b'],
        `the device introductions carried over: ${JSON.stringify(owner.introductions)}`);
      assert.equal(await store.getDeviceOwner(DEVICE), OWNER, 'the device is pinned to its owner');
    });
}
