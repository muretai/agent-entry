#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Sibling-device refusal for an introduction credential (intake 20261109T015407Z, LOW follow-up
// from the review of PR 5, 223d0f7).
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). The implementer may not edit this file.
// Run it as `node conformance/intro-sibling.mjs`.
//
// The door already refuses an introduction whose issuer is the knock's resolved signer DID, the
// bound account, or the op key. This file pins one more refusal: an issuer that the device-owner
// table (getDeviceOwner) maps to the visitor's own account is a sibling device of the same owner
// introducing its owner, and it records nothing.
//   - at knock time: a bound device introduced by a sibling device of the same owner, and the
//     owner key itself introduced by one of its own devices;
//   - in the device-to-owner fold (foldIntroductions): a device row's entry whose introducer is a
//     sibling device of the owner it now folds into is dropped, whether or not the owner has a row;
//   - controls: an issuer bound to a DIFFERENT owner is still recorded, at knock time and in the
//     fold, and an unbound visitor is not refused for an issuer that is someone else's device.
// A refusal is an ordinary knock: answered, the visitor enrolled, no entry, no error.
//
// In-process only: handleRequestAsync, no listen, no network. Example hosts only.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const { canonicalBytes, canonicalJSON, createAgentEntry, createFileStore, didFromSeedHex, signBytes, signEnvelope,
  BINDING_V2_TYP } = door;

const DOOR_SEED = 'd1'.repeat(32);
const OWNER_SEED = 'd2'.repeat(32);
const DEVICE_SEED = 'd3'.repeat(32);
const SIBLING_SEED = 'd4'.repeat(32);
const OTHER_OWNER_SEED = 'd5'.repeat(32);
const FOREIGN_DEVICE_SEED = 'd6'.repeat(32);
const STRANGER_SEED = 'd7'.repeat(32);
const OWNER = didFromSeedHex(OWNER_SEED);
const DEVICE = didFromSeedHex(DEVICE_SEED);
const SIBLING = didFromSeedHex(SIBLING_SEED);
const OTHER_OWNER = didFromSeedHex(OTHER_OWNER_SEED);
const FOREIGN_DEVICE = didFromSeedHex(FOREIGN_DEVICE_SEED);
const STRANGER = didFromSeedHex(STRANGER_SEED);
const BASE_URL = 'https://sibling.example';

const scratch = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const nowS = () => Math.floor(Date.now() / 1000);
const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let serial = 0;
function issue({ issuerSeed, subject, recipient }) {
  const issuer = didFromSeedHex(issuerSeed);
  const t = nowS();
  serial += 1;
  const body = {
    credentialSubject: { expertise: ['bread'], id: subject, introducedTo: recipient, trustLevelBp: 500,
      validUntil: iso(t + 86400) },
    id: `urn:uuid:51b11a90000040008000000000${String(serial).padStart(6, '0')}`,
    issuanceDate: iso(t - 60),
    issuer,
    provenance: { mode: 'proactive' },
    type: ['VerifiableCredential', 'AgentIntroduction'],
  };
  const jws = signBytes(issuerSeed, Buffer.from(canonicalJSON(body), 'utf8')).toString('base64');
  return { ...body, proof: { created: body.issuanceDate, jws, type: 'Ed25519Signature2020', verificationMethod: issuer } };
}

function newDoor() {
  const dir = mkdtempSync(join(tmpdir(), 'ae-intro-sib-'));
  scratch.push(dir);
  const storePath = join(dir, 'state.json');
  const store = createFileStore(storePath);
  const entry = createAgentEntry({ seedHex: DOOR_SEED, name: 'Sibling Door', baseUrl: BASE_URL,
    signedRatePerMin: 0, signedRatePerMinTotal: 0, responder: () => 'ok', store });
  return { entry, store, storePath };
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
async function knock(ctx, seed, { vc, binding } = {}) {
  const from = didFromSeedHex(seed);
  const to = ctx.entry.did;
  const messageId = `intro-sib-${++msgSerial}`;
  const text = 'hello';
  const timestamp = nowS();
  const sig = signEnvelope(seed, { from, to, messageId, contextId: null, timestamp, text });
  const metadata = { from, to, timestamp, sig };
  if (vc !== undefined) metadata.vc = vc;
  if (binding !== undefined) metadata.binding = binding;
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
      metadata } } }));
  const out = await ctx.entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
    { remoteAddress: '127.0.0.1' });
  const json = JSON.parse(Buffer.from(out.body).toString('utf8'));
  assert.equal(out.status, 200, 'HTTP 200');
  assert.equal(json.error, undefined, `answered, not refused: ${JSON.stringify(json.error)}`);
  assert.ok(json.result, 'a result');
  return json;
}

/** Pin `deviceSeed` to `ownerSeed` the way the door does: a bound knock by that device. */
async function pinByKnock(ctx, ownerSeed, deviceSeed) {
  await knock(ctx, deviceSeed, { binding: bindingFor(ownerSeed, deviceSeed) });
  assert.equal(await ctx.store.getDeviceOwner(didFromSeedHex(deviceSeed)), didFromSeedHex(ownerSeed),
    'fixture: the device-owner table maps the device to its owner');
}

const introducersOf = async (ctx, did) => ((await ctx.store.getAccount(did))?.introductions ?? [])
  .map((e) => e.introducer);

const entryOf = (introducer, id, verifiedAt) => ({ introducer, id, verified_at: verifiedAt });

// ---------------------------------------------------------------- knock time

test('knock: a bound device introduced by a sibling device of the same owner records nothing', async () => {
  const ctx = newDoor();
  await pinByKnock(ctx, OWNER_SEED, SIBLING_SEED);
  const vc = issue({ issuerSeed: SIBLING_SEED, subject: DEVICE, recipient: ctx.entry.did });
  assert.equal(door.verifyIntroduction(vc, { expectedSubject: DEVICE, expectedRecipient: ctx.entry.did,
    now: new Date() }), true, 'fixture: the sibling-issued credential verifies as a credential');
  await knock(ctx, DEVICE_SEED, { vc, binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  const row = await ctx.store.getAccount(OWNER);
  assert.ok(row, 'the owner account is enrolled');
  assert.deepEqual(await introducersOf(ctx, OWNER), [], `no sibling introduction: ${JSON.stringify(row)}`);
  assert.ok(!readFileSync(ctx.storePath, 'utf8').includes(vc.id), 'the sibling-issued id is not stored');
});

test('knock: the owner key itself, introduced by one of its own devices, records nothing', async () => {
  const ctx = newDoor();
  await pinByKnock(ctx, OWNER_SEED, SIBLING_SEED);
  const vc = issue({ issuerSeed: SIBLING_SEED, subject: OWNER, recipient: ctx.entry.did });
  await knock(ctx, OWNER_SEED, { vc });
  assert.deepEqual(await introducersOf(ctx, OWNER), [], 'no introduction from the owner\'s own device');
});

test('knock: the refusal answers the same reply as the knock without the vc', async () => {
  const plain = newDoor();
  const withVc = newDoor();
  await pinByKnock(plain, OWNER_SEED, SIBLING_SEED);
  await pinByKnock(withVc, OWNER_SEED, SIBLING_SEED);
  const a = await knock(plain, DEVICE_SEED, { binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  const vc = issue({ issuerSeed: SIBLING_SEED, subject: DEVICE, recipient: withVc.entry.did });
  const b = await knock(withVc, DEVICE_SEED, { vc, binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  const textOf = (r) => r.result?.parts?.map((p) => p.text).join('');
  assert.equal(textOf(b), textOf(a), 'the reply text is the same');
  assert.deepEqual(await introducersOf(withVc, OWNER), []);
});

test('control, knock: an issuer bound to a DIFFERENT owner is still recorded', async () => {
  const ctx = newDoor();
  await pinByKnock(ctx, OTHER_OWNER_SEED, FOREIGN_DEVICE_SEED);
  const vc = issue({ issuerSeed: FOREIGN_DEVICE_SEED, subject: DEVICE, recipient: ctx.entry.did });
  await knock(ctx, DEVICE_SEED, { vc, binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  assert.deepEqual(await introducersOf(ctx, OWNER), [FOREIGN_DEVICE]);
});

test('control, knock: an unbound visitor introduced by another owner\'s device is recorded', async () => {
  const ctx = newDoor();
  await pinByKnock(ctx, OWNER_SEED, SIBLING_SEED);
  const vc = issue({ issuerSeed: SIBLING_SEED, subject: STRANGER, recipient: ctx.entry.did });
  await knock(ctx, STRANGER_SEED, { vc });
  assert.deepEqual(await introducersOf(ctx, STRANGER), [SIBLING], 'the sibling belongs to someone else here');
});

test('control, knock: an unpinned introducer is recorded as before', async () => {
  const ctx = newDoor();
  const vc = issue({ issuerSeed: STRANGER_SEED, subject: DEVICE, recipient: ctx.entry.did });
  await knock(ctx, DEVICE_SEED, { vc, binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  assert.deepEqual(await introducersOf(ctx, OWNER), [STRANGER]);
});

// ---------------------------------------------------------------- the device-to-owner fold

test('fold: a device entry from a sibling of the owner is dropped when the owner has a row', async () => {
  const ctx = newDoor();
  await pinByKnock(ctx, OWNER_SEED, SIBLING_SEED);
  assert.ok(await ctx.store.getAccount(OWNER), 'fixture: the owner has a row');
  await ctx.store.putAccount(DEVICE, { first_seen: 800, last_seen: 850, messages: 2, introductions: [
    entryOf(SIBLING, 'urn:uuid:sib-fold-1', 1500),
    entryOf(STRANGER, 'urn:uuid:sib-fold-kept', 1600),
  ] });
  await knock(ctx, DEVICE_SEED, { binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  assert.equal(await ctx.store.getAccount(DEVICE), null, 'the device row moved');
  const got = (await ctx.store.getAccount(OWNER)).introductions ?? [];
  assert.deepEqual(got.map((e) => e.id), ['urn:uuid:sib-fold-kept'], `sibling entry dropped: ${JSON.stringify(got)}`);
});

test('fold: a device entry from a sibling of the owner is dropped when the owner has no row', async () => {
  const ctx = newDoor();
  await ctx.store.putDeviceOwner(SIBLING, OWNER);
  assert.equal(await ctx.store.getAccount(OWNER), null, 'fixture: the owner has no row');
  await ctx.store.putAccount(DEVICE, { first_seen: 800, last_seen: 850, messages: 2, introductions: [
    entryOf(SIBLING, 'urn:uuid:sib-fold-2', 1500),
    entryOf(STRANGER, 'urn:uuid:sib-fold-kept-2', 1600),
  ] });
  await knock(ctx, DEVICE_SEED, { binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  const got = (await ctx.store.getAccount(OWNER)).introductions ?? [];
  assert.deepEqual(got.map((e) => e.id), ['urn:uuid:sib-fold-kept-2'], `sibling entry dropped: ${JSON.stringify(got)}`);
});

test('fold: the owner row\'s own entry from a sibling device is dropped too', async () => {
  const ctx = newDoor();
  await ctx.store.putDeviceOwner(SIBLING, OWNER);
  await ctx.store.putAccount(OWNER, { first_seen: 700, last_seen: 900, messages: 3, introductions: [
    entryOf(SIBLING, 'urn:uuid:sib-owner-side', 900),
  ] });
  await ctx.store.putAccount(DEVICE, { first_seen: 800, last_seen: 850, messages: 2, introductions: [
    entryOf(STRANGER, 'urn:uuid:sib-dev-side', 1000),
  ] });
  await knock(ctx, DEVICE_SEED, { binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  const got = (await ctx.store.getAccount(OWNER)).introductions ?? [];
  assert.deepEqual(got.map((e) => e.id), ['urn:uuid:sib-dev-side'], `the fold result holds no sibling: ${JSON.stringify(got)}`);
});

test('control, fold: a device entry from an issuer bound to a DIFFERENT owner is kept', async () => {
  const ctx = newDoor();
  await pinByKnock(ctx, OTHER_OWNER_SEED, FOREIGN_DEVICE_SEED);
  await ctx.store.putAccount(DEVICE, { first_seen: 800, last_seen: 850, messages: 2, introductions: [
    entryOf(FOREIGN_DEVICE, 'urn:uuid:foreign-fold', 1500),
  ] });
  await knock(ctx, DEVICE_SEED, { binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  const got = (await ctx.store.getAccount(OWNER)).introductions ?? [];
  assert.deepEqual(got.map((e) => e.introducer), [FOREIGN_DEVICE]);
  assert.equal(await ctx.store.getDeviceOwner(FOREIGN_DEVICE), OTHER_OWNER, 'the foreign pin is untouched');
});
