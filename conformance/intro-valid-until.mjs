#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// valid_until on an introduction entry (intake 20261109T015407Z, LOW follow-up from the review of
// PR 5, 223d0f7).
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). The implementer may not edit this file.
// Run it as `node conformance/intro-valid-until.mjs`.
//
// What it pins:
//   - each entry in a visitor row's `introductions` is exactly
//       { introducer, id, verified_at, valid_until }
//     where valid_until is the credential's credentialSubject.validUntil as integer epoch seconds,
//     the same unit as verified_at;
//   - nothing is refused for lapsing after it was recorded: an entry whose valid_until is in the
//     past stays on the row, through a later knock and through the device-to-owner fold;
//   - a repeat of the same (introducer, id) keeps the later verified_at AND its valid_until, at
//     knock time and in the fold;
//   - a legacy row written before this change, with three-key entries, still loads, folds and
//     keeps its entries; a missing valid_until is left missing (unknown), never invented.
//
// In-process only: handleRequestAsync, no listen, no network. Example hosts only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const { canonicalBytes, canonicalJSON, createAgentEntry, createFileStore, didFromSeedHex, signBytes, signEnvelope,
  BINDING_V2_TYP } = door;

const DOOR_SEED = 'f1'.repeat(32);
const VISITOR_SEED = 'f2'.repeat(32);
const INTRODUCER_SEED = 'f3'.repeat(32);
const OTHER_INTRODUCER_SEED = 'f4'.repeat(32);
const OWNER_SEED = 'f5'.repeat(32);
const VISITOR = didFromSeedHex(VISITOR_SEED);
const INTRODUCER = didFromSeedHex(INTRODUCER_SEED);
const OTHER_INTRODUCER = didFromSeedHex(OTHER_INTRODUCER_SEED);
const OWNER = didFromSeedHex(OWNER_SEED);
const BASE_URL = 'https://valid-until.example';
const KEYS4 = ['id', 'introducer', 'valid_until', 'verified_at'];
const KEYS3 = ['id', 'introducer', 'verified_at'];

const scratch = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const nowS = () => Math.floor(Date.now() / 1000);
const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let serial = 0;
function issue({ issuerSeed = INTRODUCER_SEED, subject = VISITOR, recipient, validUntil, id } = {}) {
  const issuer = didFromSeedHex(issuerSeed);
  const t = nowS();
  serial += 1;
  const body = {
    credentialSubject: { expertise: ['maps'], id: subject, introducedTo: recipient, trustLevelBp: 600,
      validUntil: validUntil ?? iso(t + 86400) },
    id: id ?? `urn:uuid:7a11d000000040008000000000${String(serial).padStart(6, '0')}`,
    issuanceDate: iso(t - 60),
    issuer,
    provenance: { mode: 'proactive' },
    type: ['VerifiableCredential', 'AgentIntroduction'],
  };
  const jws = signBytes(issuerSeed, Buffer.from(canonicalJSON(body), 'utf8')).toString('base64');
  return { ...body, proof: { created: body.issuanceDate, jws, type: 'Ed25519Signature2020', verificationMethod: issuer } };
}

const secondsOf = (vc) => Date.parse(vc.credentialSubject.validUntil) / 1000;

/** A door over a file store. `legacy` is a raw state document written to disk first. */
function newDoor({ legacy = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ae-intro-vu-'));
  scratch.push(dir);
  const storePath = join(dir, 'state.json');
  if (legacy) writeFileSync(storePath, JSON.stringify(legacy) + '\n');
  const store = createFileStore(storePath);
  const entry = createAgentEntry({ seedHex: DOOR_SEED, name: 'Valid Until Door', baseUrl: BASE_URL,
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
  const messageId = `intro-vu-${++msgSerial}`;
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
  return json;
}

const entryOf = (introducer, id, verifiedAt, validUntil) => (validUntil === undefined
  ? { introducer, id, verified_at: verifiedAt }
  : { introducer, id, verified_at: verifiedAt, valid_until: validUntil });

// ---------------------------------------------------------------- the new key

test('a recorded introduction carries valid_until: the credential validUntil in integer epoch seconds', async () => {
  const ctx = newDoor();
  const t = nowS();
  const vc = issue({ recipient: ctx.entry.did, validUntil: iso(t + 3 * 86400) });
  await knock(ctx, VISITOR_SEED, { vc });
  const [intro] = (await ctx.store.getAccount(VISITOR)).introductions;
  assert.deepEqual(Object.keys(intro).sort(), KEYS4, `exactly four keys: ${JSON.stringify(intro)}`);
  assert.ok(Number.isSafeInteger(intro.valid_until), `valid_until is an integer: ${intro.valid_until}`);
  assert.equal(intro.valid_until, t + 3 * 86400);
  assert.equal(intro.valid_until, secondsOf(vc));
  assert.ok(Number.isSafeInteger(intro.verified_at) && intro.verified_at < intro.valid_until,
    'the same unit as verified_at: seconds, not milliseconds');
});

test('valid_until is stored on disk in seconds, and the body is still not stored', async () => {
  const ctx = newDoor();
  const vc = issue({ recipient: ctx.entry.did });
  await knock(ctx, VISITOR_SEED, { vc });
  const file = readFileSync(ctx.storePath, 'utf8');
  assert.ok(file.includes(`"valid_until":${secondsOf(vc)}`), 'the integer second is on disk');
  assert.ok(!file.includes(vc.credentialSubject.validUntil), 'the ISO string (credential body) is not on disk');
  assert.ok(!file.includes('credentialSubject'), 'no credential body on disk');
});

test('a validUntil with a millisecond fraction still yields an integer valid_until within the second', async () => {
  const ctx = newDoor();
  const t = nowS() + 86400;
  const validUntil = new Date(t * 1000 + 500).toISOString();
  const vc = issue({ recipient: ctx.entry.did, validUntil });
  assert.equal(door.verifyIntroduction(vc, { expectedSubject: VISITOR, expectedRecipient: ctx.entry.did,
    now: new Date() }), true, 'fixture: a 3-digit fraction verifies');
  await knock(ctx, VISITOR_SEED, { vc });
  const [intro] = (await ctx.store.getAccount(VISITOR)).introductions;
  assert.ok(Number.isSafeInteger(intro?.valid_until), `integer: ${JSON.stringify(intro)}`);
  assert.ok(Math.abs(intro.valid_until - (t + 0.5)) < 1, `within the second of ${validUntil}: ${intro.valid_until}`);
});

test('the default in-memory ledger records valid_until too', async () => {
  const entry = createAgentEntry({ seedHex: DOOR_SEED, name: 'Valid Until Door', baseUrl: BASE_URL,
    signedRatePerMin: 0, signedRatePerMinTotal: 0, responder: () => 'ok' });
  const vc = issue({ recipient: entry.did });
  await knock({ entry }, VISITOR_SEED, { vc });
  const [intro] = entry.ledger.get(VISITOR).introductions;
  assert.deepEqual(Object.keys(intro).sort(), KEYS4);
  assert.equal(intro.valid_until, secondsOf(vc));
});

// ---------------------------------------------------------------- lapsing is not a refusal

test('a recorded entry whose valid_until has passed stays on the row through a later knock', async () => {
  const ctx = newDoor();
  const lapsed = entryOf(OTHER_INTRODUCER, 'urn:uuid:lapsed-0001', 1000, 2000);
  await ctx.store.putAccount(VISITOR, { first_seen: 900, last_seen: 1000, messages: 1, introductions: [lapsed] });
  const vc = issue({ recipient: ctx.entry.did });
  await knock(ctx, VISITOR_SEED, { vc });
  const got = (await ctx.store.getAccount(VISITOR)).introductions;
  assert.deepEqual(got[0], lapsed, 'the lapsed entry is kept as recorded');
  assert.equal(got.length, 2);
  assert.equal(got[1].valid_until, secondsOf(vc));
});

// ---------------------------------------------------------------- repeats

test('a repeat of the same (introducer, id) at knock time keeps the later verified_at and its valid_until', async () => {
  const ctx = newDoor();
  const vc = issue({ recipient: ctx.entry.did });
  await ctx.store.putAccount(VISITOR, { first_seen: 900, last_seen: 1000, messages: 1,
    introductions: [entryOf(INTRODUCER, vc.id, 1000, 1500)] });
  const t0 = nowS();
  await knock(ctx, VISITOR_SEED, { vc });
  const got = (await ctx.store.getAccount(VISITOR)).introductions;
  assert.equal(got.length, 1, `one entry per (introducer, id): ${JSON.stringify(got)}`);
  assert.ok(got[0].verified_at >= t0, 'the later verified_at');
  assert.equal(got[0].valid_until, secondsOf(vc), 'and the valid_until that came with it');
});

test('a repeat of the same (introducer, id) in the fold keeps the later verified_at and its valid_until', async () => {
  const DEVICE_SEED = 'f6'.repeat(32);
  const DEVICE = didFromSeedHex(DEVICE_SEED);
  for (const [label, ownerE, devE, want] of [
    ['device newer', entryOf(INTRODUCER, 'urn:uuid:rep-1', 100, 5000), entryOf(INTRODUCER, 'urn:uuid:rep-1', 200, 9000), 9000],
    ['owner newer', entryOf(INTRODUCER, 'urn:uuid:rep-1', 300, 7000), entryOf(INTRODUCER, 'urn:uuid:rep-1', 200, 9000), 7000],
  ]) {
    const ctx = newDoor();
    await ctx.store.putAccount(OWNER, { first_seen: 50, last_seen: 300, messages: 3, introductions: [ownerE] });
    await ctx.store.putAccount(DEVICE, { first_seen: 60, last_seen: 200, messages: 2, introductions: [devE] });
    await knock(ctx, DEVICE_SEED, { binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
    const got = (await ctx.store.getAccount(OWNER)).introductions;
    assert.equal(got.length, 1, `${label}: one entry: ${JSON.stringify(got)}`);
    assert.equal(got[0].valid_until, want, `${label}: the valid_until of the later verified_at`);
  }
});

// ---------------------------------------------------------------- legacy rows

function legacyDoc(rows) {
  return { v: 1, messages: [], accounts: rows, deviceOwners: [], keyStates: [], receipts: [] };
}

test('legacy: a row with three-key entries loads and keeps them unchanged on a knock without a vc', async () => {
  const old = [entryOf(INTRODUCER, 'urn:uuid:legacy-1', 1000), entryOf(OTHER_INTRODUCER, 'urn:uuid:legacy-2', 1100)];
  const ctx = newDoor({ legacy: legacyDoc([[VISITOR, { first_seen: 900, last_seen: 1100, messages: 2,
    introductions: old }]]) });
  await knock(ctx, VISITOR_SEED);
  const row = await ctx.store.getAccount(VISITOR);
  assert.equal(row.messages, 3);
  assert.deepEqual(row.introductions, old, 'kept as written: no valid_until invented');
});

test('legacy: a new introduction on a legacy row adds a four-key entry and leaves the old ones unknown', async () => {
  const old = [entryOf(OTHER_INTRODUCER, 'urn:uuid:legacy-3', 1000)];
  const ctx = newDoor({ legacy: legacyDoc([[VISITOR, { first_seen: 900, last_seen: 1000, messages: 1,
    introductions: old }]]) });
  const vc = issue({ recipient: ctx.entry.did });
  await knock(ctx, VISITOR_SEED, { vc });
  const got = (await ctx.store.getAccount(VISITOR)).introductions;
  assert.equal(got.length, 2, JSON.stringify(got));
  assert.deepEqual(got[0], old[0], 'the legacy entry keeps exactly three keys: valid_until unknown');
  assert.deepEqual(Object.keys(got[0]).sort(), KEYS3);
  assert.deepEqual(Object.keys(got[1]).sort(), KEYS4);
  assert.equal(got[1].valid_until, secondsOf(vc));
});

test('legacy: a repeat of a legacy (introducer, id) replaces it with the four-key entry', async () => {
  const ctx0 = newDoor();
  const vc = issue({ recipient: ctx0.entry.did });
  const ctx = newDoor({ legacy: legacyDoc([[VISITOR, { first_seen: 900, last_seen: 1000, messages: 1,
    introductions: [entryOf(INTRODUCER, vc.id, 1000)] }]]) });
  await knock(ctx, VISITOR_SEED, { vc });
  const got = (await ctx.store.getAccount(VISITOR)).introductions;
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.equal(got[0].valid_until, secondsOf(vc));
});

test('legacy: a device row with three-key entries folds into its owner and keeps them', async () => {
  const DEVICE_SEED = 'f7'.repeat(32);
  const DEVICE = didFromSeedHex(DEVICE_SEED);
  const devOld = [entryOf(INTRODUCER, 'urn:uuid:legacy-dev', 1200)];
  const ownerOld = [entryOf(OTHER_INTRODUCER, 'urn:uuid:legacy-own', 1100)];
  const ctx = newDoor({ legacy: legacyDoc([
    [OWNER, { first_seen: 800, last_seen: 1100, messages: 4, introductions: ownerOld }],
    [DEVICE, { first_seen: 850, last_seen: 1200, messages: 1, introductions: devOld }],
  ]) });
  await knock(ctx, DEVICE_SEED, { binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  assert.equal(await ctx.store.getAccount(DEVICE), null, 'the device row moved');
  const got = (await ctx.store.getAccount(OWNER)).introductions;
  assert.deepEqual(got, [...ownerOld, ...devOld], 'both legacy entries kept, ordered by verified_at, unchanged');
});

test('legacy: a mixed fold keeps a three-key entry beside a four-key one', async () => {
  const DEVICE_SEED = 'f8'.repeat(32);
  const DEVICE = didFromSeedHex(DEVICE_SEED);
  const ctx = newDoor();
  const vc = issue({ subject: DEVICE, recipient: ctx.entry.did });
  await knock(ctx, DEVICE_SEED, { vc });
  const devRow = await ctx.store.getAccount(DEVICE);
  assert.deepEqual(Object.keys(devRow.introductions[0]).sort(), KEYS4, 'the device recorded a four-key entry');
  await ctx.store.putAccount(OWNER, { first_seen: 1, last_seen: 2, messages: 1,
    introductions: [entryOf(OTHER_INTRODUCER, 'urn:uuid:legacy-mixed', 2)] });
  await knock(ctx, DEVICE_SEED, { binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  const got = (await ctx.store.getAccount(OWNER)).introductions;
  assert.equal(got.length, 2, JSON.stringify(got));
  assert.deepEqual(Object.keys(got[0]).sort(), KEYS3);
  assert.equal(got[1].valid_until, secondsOf(vc));
});
