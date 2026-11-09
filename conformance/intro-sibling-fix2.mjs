#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Fix round 2 for the device-to-owner fold: two LOW findings from the review of 9849e18.
//
//   1. partial failure: the owner row is written, the device row delete fails, and the pin is
//      still unwritten. The next bound knock folded the same device row again and counted its
//      messages twice. The owner row now lists the devices folded into it (`folded_from`),
//      written with the merged data, and a listed device is not merged again.
//   2. race, async stores only: two concurrent first bound knocks both read the pin as null and
//      both folded, so a device's messages could count twice, and bindings to two different
//      owners could both pass the different-owner check. Folds are now serialized per device
//      DID in-process, and the second knock reads the pin the first one wrote.
//
// In-process only: handleRequestAsync over an async store, no listen, no network. Example hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const { canonicalBytes, createAgentEntry, createMemoryStore, didFromSeedHex, signBytes, signEnvelope,
  BINDING_V2_TYP } = door;

const DOOR_SEED = 'd1'.repeat(32);
const OWNER_SEED = 'd5'.repeat(32);
const OWNER2_SEED = 'd8'.repeat(32);
const DEVICE_SEED = 'd6'.repeat(32);
const OWNER = didFromSeedHex(OWNER_SEED);
const OWNER2 = didFromSeedHex(OWNER2_SEED);
const DEVICE = didFromSeedHex(DEVICE_SEED);
const OTHER_DEVICE = didFromSeedHex('d9'.repeat(32));

const FOLDED_FROM_CAP = 32;

const nowS = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

/** A memory store behind an async seam. `failDeviceDeleteOnce` makes the first
 *  putAccount(DEVICE, null) reject. `ownerReadDelays` holds the Nth getAccount(owner) read open
 *  for that many ms (index = call number, from 0), so two knocks can be interleaved on purpose.
 *  `opDelayMs` delays every other call. */
function asyncStore({ failDeviceDeleteOnce = false, ownerReadDelays = {}, opDelayMs = 0 } = {}) {
  const inner = createMemoryStore();
  const store = {};
  for (const [k, fn] of Object.entries(inner)) {
    store[k] = async (...a) => { if (opDelayMs) await sleep(opDelayMs); return fn(...a); };
  }
  let failNext = failDeviceDeleteOnce;
  store.putAccount = async (did, row) => {
    if (opDelayMs) await sleep(opDelayMs);
    if (did === DEVICE && row === null && failNext) {
      failNext = false;
      throw new Error('example store outage deleting the device row');
    }
    // A store hands back copies: a row read before a write is a snapshot.
    return inner.putAccount(did, row === null ? null : structuredClone(row));
  };
  const ownerReads = new Map();
  store.getAccount = async (did) => {
    const n = ownerReads.get(did) || 0;
    ownerReads.set(did, n + 1);
    const delay = (did === OWNER || did === OWNER2) ? (ownerReadDelays[n] ?? opDelayMs) : opDelayMs;
    if (delay) await sleep(delay);
    const row = inner.getAccount(did);
    return row ? structuredClone(row) : row;
  };
  return store;
}

const newEntry = (store) => createAgentEntry({ seedHex: DOOR_SEED, name: 'Fix Door', baseUrl: 'https://fix.example',
  signedRatePerMin: 0, signedRatePerMinTotal: 0, responder: () => 'ok', store });

function bindingFor(ownerSeed, deviceSeed) {
  const ts = nowS() - 10;
  const payload = canonicalBytes({ typ: BINDING_V2_TYP, rootDid: didFromSeedHex(ownerSeed),
    deviceDid: didFromSeedHex(deviceSeed), ts, validUntil: 0 });
  return { typ: BINDING_V2_TYP, rootDid: didFromSeedHex(ownerSeed), deviceDid: didFromSeedHex(deviceSeed), ts,
    validUntil: 0, sig: signBytes(ownerSeed, payload).toString('base64'),
    deviceSig: signBytes(deviceSeed, payload).toString('base64') };
}

let msgSerial = 0;
async function knock(entry, { seed, binding }) {
  const from = didFromSeedHex(seed);
  const messageId = `intro-sib-fix2-${++msgSerial}`;
  const text = 'hello';
  const timestamp = nowS();
  const sig = signEnvelope(seed, { from, to: entry.did, messageId, contextId: null, timestamp, text });
  const metadata = { from, to: entry.did, timestamp, sig };
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

const answered = (res) => res && res.status === 200 && res.json && res.json.error === undefined && res.json.result;

const DEV_ROW = () => ({ first_seen: 800, last_seen: 850, messages: 2 });

// ---------------------------------------------------------------- 1. partial failure

for (const ownerHasRow of [false, true]) {
  test(`finding 1: a failed device delete, then a retry, counts each device message once (owner row: ${ownerHasRow})`,
    async () => {
      const store = asyncStore({ failDeviceDeleteOnce: true });
      const entry = newEntry(store);
      if (ownerHasRow) await store.putAccount(OWNER, { first_seen: 700, last_seen: 900, messages: 3 });
      await store.putAccount(DEVICE, DEV_ROW());
      const before = unhandled.length;
      const first = await knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED) })
        .catch(() => null);
      await sleep(10);
      assert.equal(unhandled.length, before, `no unhandled rejection: ${unhandled.slice(before).map(String)}`);
      assert.equal(await store.getDeviceOwner(DEVICE), null, 'the pin is still unwritten after the failed delete');
      const firstCounted = answered(first) ? 1 : 0;

      const res = await knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
      assert.ok(answered(res), `the retry is answered: ${JSON.stringify(res.json?.error)}`);
      assert.equal(await store.getAccount(DEVICE), null, 'the retry removed the device row');
      assert.equal(await store.getDeviceOwner(DEVICE), OWNER, 'the device is pinned to its owner');
      const owner = await store.getAccount(OWNER);
      assert.equal(owner.messages, (ownerHasRow ? 3 : 0) + 2 + firstCounted + 1,
        `each device message counted exactly once: ${JSON.stringify(owner)}`);
      assert.deepEqual(owner.folded_from, [DEVICE]);
    });
}

// ---------------------------------------------------------------- 2. concurrent first knocks

test('finding 2: two concurrent first bound knocks to one owner count the device messages once', async () => {
  // Knock A reads the owner row at once; knock B's owner read is held open until A has written
  // the owner row, while B already read the device row before A deleted it.
  const store = asyncStore({ opDelayMs: 2, ownerReadDelays: { 0: 0, 1: 40 } });
  const entry = newEntry(store);
  await store.putAccount(DEVICE, DEV_ROW());
  const before = unhandled.length;
  const [a, b] = await Promise.all([
    knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED) }),
    knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED) }),
  ]);
  await sleep(10);
  assert.equal(unhandled.length, before, `no unhandled rejection: ${unhandled.slice(before).map(String)}`);
  assert.ok(answered(a) && answered(b), `both knocks answered: ${JSON.stringify([a.json?.error, b.json?.error])}`);
  const owner = await store.getAccount(OWNER);
  assert.equal(owner.messages, 2 + 2, `the device messages once plus the two knocks: ${JSON.stringify(owner)}`);
  assert.equal(await store.getAccount(DEVICE), null);
  assert.equal(await store.getDeviceOwner(DEVICE), OWNER);
});

test('finding 2: two concurrent first bound knocks to two different owners: exactly one binding wins', async () => {
  const store = asyncStore({ opDelayMs: 2, ownerReadDelays: { 0: 0, 1: 40 } });
  const entry = newEntry(store);
  await store.putAccount(DEVICE, DEV_ROW());
  const before = unhandled.length;
  const [a, b] = await Promise.all([
    knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED) }),
    knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER2_SEED, DEVICE_SEED) }),
  ]);
  await sleep(10);
  assert.equal(unhandled.length, before, `no unhandled rejection: ${unhandled.slice(before).map(String)}`);
  const wins = [answered(a), answered(b)].filter(Boolean).length;
  assert.equal(wins, 1, `exactly one binding answered: ${JSON.stringify([a.json?.error, b.json?.error])}`);
  const winner = answered(a) ? OWNER : OWNER2;
  const loser = winner === OWNER ? OWNER2 : OWNER;
  assert.equal(await store.getDeviceOwner(DEVICE), winner, 'the pin names the winner');
  const won = await store.getAccount(winner);
  assert.equal(won.messages, 2 + 1, `the device messages land once, in the winner: ${JSON.stringify(won)}`);
  assert.equal(await store.getAccount(loser), null, `the losing owner gets nothing: ${JSON.stringify(await store.getAccount(loser))}`);
});

test('control, finding 2: the per-device lock is released after a rejected fold', async () => {
  const store = asyncStore({ failDeviceDeleteOnce: true, opDelayMs: 2 });
  const entry = newEntry(store);
  await store.putAccount(DEVICE, DEV_ROW());
  const [a, b] = await Promise.all([
    knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED) }).catch(() => null),
    knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED) }).catch(() => null),
  ]);
  const counted = [a, b].filter(answered).length;
  const res = await knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  assert.ok(answered(res), `a later knock is answered: ${JSON.stringify(res.json?.error)}`);
  assert.equal(await store.getDeviceOwner(DEVICE), OWNER);
  assert.equal((await store.getAccount(OWNER)).messages, 2 + counted + 1);
});

// ---------------------------------------------------------------- legacy rows and the cap

test('a legacy owner row with no folded_from still folds, and gains the list', async () => {
  const store = asyncStore();
  const entry = newEntry(store);
  await store.putAccount(OWNER, { first_seen: 700, last_seen: 900, messages: 3 });
  await store.putAccount(DEVICE, DEV_ROW());
  const res = await knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  assert.ok(answered(res), JSON.stringify(res.json?.error));
  const owner = await store.getAccount(OWNER);
  assert.equal(owner.messages, 3 + 2 + 1, JSON.stringify(owner));
  assert.equal(owner.first_seen, 700);
  assert.deepEqual(owner.folded_from, [DEVICE]);
  assert.equal(await store.getAccount(DEVICE), null);
});

test('an owner row that lists another device still folds this one', async () => {
  const store = asyncStore();
  const entry = newEntry(store);
  await store.putAccount(OWNER, { first_seen: 700, last_seen: 900, messages: 3, folded_from: [OTHER_DEVICE] });
  await store.putAccount(DEVICE, DEV_ROW());
  const res = await knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  assert.ok(answered(res), JSON.stringify(res.json?.error));
  const owner = await store.getAccount(OWNER);
  assert.equal(owner.messages, 3 + 2 + 1);
  assert.deepEqual(owner.folded_from, [OTHER_DEVICE, DEVICE]);
});

test(`folded_from keeps the newest ${FOLDED_FROM_CAP} devices: past the cap the oldest is dropped`, async () => {
  const store = asyncStore();
  const entry = newEntry(store);
  const full = Array.from({ length: FOLDED_FROM_CAP }, (_, i) => `did:example:folded-${i}`);
  await store.putAccount(OWNER, { first_seen: 700, last_seen: 900, messages: 3, folded_from: full });
  await store.putAccount(DEVICE, DEV_ROW());
  const res = await knock(entry, { seed: DEVICE_SEED, binding: bindingFor(OWNER_SEED, DEVICE_SEED) });
  assert.ok(answered(res), JSON.stringify(res.json?.error));
  const owner = await store.getAccount(OWNER);
  assert.equal(owner.messages, 3 + 2 + 1);
  assert.deepEqual(owner.folded_from, [...full.slice(1), DEVICE]);
});
