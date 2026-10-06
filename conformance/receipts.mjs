#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The door keeps its own pending list: a `receipts` store section, keyed by the deal's ref.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). AT-28 chain item 1 of the parent design
// record 20261004T022919Z (intake 20261004T114455Z), section "The door keeps its own pending list".
// Later chain items (decide <ref>, track, knock --ref, decline, any CLI surface) are not pinned here.
// The implementer may not edit this file. It is not wired into `npm test` until it is green; run it
// as `node conformance/receipts.mjs`.
//
// The seam this file pins (names chosen here, since the requirement leaves them open):
//   store.getReceipt(ref)            -> the row, or null
//   store.putReceipt(ref, row)       -> stores the row under ref (a later put replaces it)
//   store.listUndecidedReceipts()    -> an array of the rows whose decision is null
//   createMemoryStore({ maxReceipts })                 exported: the door's own memory store
//   createFileStore(path, { maxReceipts, ... })        gains the `receipts` section ([ref, row] pairs)
// Methods may be sync or async; every call here is awaited.
//
// What it pins:
//   - a signed knock that earns a pending reply with a deal writes one row under deal.ref:
//     { ref, offer, partyB, issued_ts, pending_text, decision: null }, pending_text being the reply
//     text exactly as signed -- through the memory store, the file store and a hand-written
//     pluggable store alike;
//   - get/put-by-ref round-trips in both stores, the file store across a restart;
//   - list-undecided returns only rows whose decision is null, in both stores;
//   - maxReceipts (default 5000) evicts decided rows first, oldest first, and never an undecided
//     row, even over the cap.
// Refusals:
//   - a pluggable store missing getReceipt, putReceipt or listUndecidedReceipts is refused at
//     construction, by name;
//   - no row for a reply without a deal (the anonymous lane, a non-receipt offer), a refused knock
//     (bad signature) or a replayed message id;
//   - a visitor-chosen ref such as __proto__ is stored as data, never as an object key that
//     reaches a prototype.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const { createAgentEntry, createFileStore, didFromSeedHex, signEnvelope, verifyEnvelope } = door;

const DOOR_SEED = 'd1'.repeat(32);
const VISITOR_SEED = '8b'.repeat(32);
const VISITOR = didFromSeedHex(VISITOR_SEED);
const HOLD_TEXT = 'hold item {"id":101}';
const RECEIPT_METHODS = ['getReceipt', 'putReceipt', 'listUndecidedReceipts'];
const ROW_KEYS = ['decision', 'issued_ts', 'offer', 'partyB', 'pending_text', 'ref'];

const DECLARATION = {
  v: 1,
  entry: { name: 'Harbor Lamp', baseUrl: 'https://shop.example' },
  offers: [
    { verb: 'hold', of: 'item', about: 'Hold one item for pickup; the shop confirms it.',
      input: { id: 'integer' }, door: { reply: 'pending' } },
    { verb: 'ask', of: 'hours', about: 'Ask when the shop is open; the shop answers later.',
      input: {}, door: { reply: 'pending' } },
  ],
};

const scratch = [];
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const clone = (v) => JSON.parse(JSON.stringify(v));
const nowS = () => Math.floor(Date.now() / 1000);

function memoryStore(opts) {
  assert.equal(typeof door.createMemoryStore, 'function', 'createMemoryStore (the door\'s memory store) is exported');
  return door.createMemoryStore(opts);
}

/** A hand-written pluggable store: every method the door requires, on plain Maps. */
function pluggableStore() {
  const seen = new Set(); const accounts = new Map(); const owners = new Map(); const keyStates = new Map();
  const receipts = new Map();
  const calls = [];
  return {
    calls, receipts,
    seenMessage: (id) => { if (seen.has(id)) return false; seen.add(id); return true; },
    getAccount: (d) => accounts.get(d) ?? null,
    putAccount: (d, row) => { if (row === null) accounts.delete(d); else accounts.set(d, row); },
    getDeviceOwner: (d) => owners.get(d) ?? null,
    putDeviceOwner: (d, o) => { owners.set(d, o); },
    getKeyState: (d) => keyStates.get(d) ?? null,
    putKeyState: (d, k) => { keyStates.set(d, k); },
    getReceipt: (ref) => { calls.push(['getReceipt', ref]); return receipts.get(ref) ?? null; },
    putReceipt: (ref, row) => { calls.push(['putReceipt', ref]); receipts.set(ref, clone(row)); },
    listUndecidedReceipts: () => { calls.push(['listUndecidedReceipts']); return [...receipts.values()].filter((r) => r.decision === null); },
  };
}

function makeDoor(store) {
  return createAgentEntry({ seedHex: DOOR_SEED, name: DECLARATION.entry.name, baseUrl: DECLARATION.entry.baseUrl,
    declaration: clone(DECLARATION), signedRatePerMin: 0, signedRatePerMinTotal: 0,
    responder: () => 'ok', ...(store ? { store } : {}) });
}

let sequence = 0;
/** One knock at `entry`, in process. `signed: false` takes the anonymous lane; `badSig` signs over other text. */
async function knock(entry, { offer = 'hold', text = HOLD_TEXT, seed = VISITOR_SEED, messageId = null,
  signed = true, badSig = false } = {}) {
  const from = didFromSeedHex(seed);
  const id = messageId ?? `receipts-${++sequence}`;
  const timestamp = nowS();
  const metadata = { offer };
  if (signed) {
    const sig = signEnvelope(seed, { from, to: entry.did, messageId: id, contextId: null, timestamp,
      text: badSig ? `${text} (edited)` : text });
    Object.assign(metadata, { from, to: entry.did, timestamp, sig });
  }
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId: id, contextId: null, parts: [{ kind: 'text', text }], metadata } } }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
    { remoteAddress: '127.0.0.1' });
  const raw = Buffer.from(out.body || '').toString('utf8');
  let parsed = null; try { parsed = JSON.parse(raw); } catch { /* not json */ }
  const message = parsed?.result;
  const replyText = message?.parts?.[0]?.text;
  let reply = null; try { reply = JSON.parse(replyText); } catch { /* not json */ }
  const verified = Boolean(message) && signed && verifyEnvelope({ from: message.metadata?.from, to: message.metadata?.to,
    messageId: message.messageId, contextId: message.contextId ?? null, timestamp: message.metadata?.timestamp,
    text: replyText, sig: message.metadata?.sig }, { recipientDid: from, signerDid: entry.did });
  return { messageId: id, raw, parsed, replyText, reply, verified };
}

/** A pending hold with a deal; returns the knock and the bounds its row's issued_ts must sit in. */
async function pendingHold(entry, opts = {}) {
  const before = nowS();
  const k = await knock(entry, opts);
  const afterS = nowS();
  assert.ok(k.verified, `the door answers the hold with a signed reply: ${k.raw.slice(0, 300)}`);
  assert.equal(k.reply?.status, 'pending_confirmation', `the hold is pending: ${String(k.replyText).slice(0, 300)}`);
  assert.ok(k.reply?.deal && typeof k.reply.deal.ref === 'string', 'the pending reply carries a deal');
  return { ...k, before, after: afterS };
}

function assertRow(row, k, what) {
  assert.ok(row && typeof row === 'object', `${what}: a receipts row under the deal's ref: ${JSON.stringify(row)}`);
  assert.deepEqual(Object.keys(row).sort(), ROW_KEYS, `${what}: exactly the six fields`);
  assert.equal(row.ref, k.reply.deal.ref, `${what}: ref is the deal's ref`);
  assert.equal(row.ref, k.messageId, `${what}: which is the knock's message id`);
  assert.equal(row.offer, 'hold', `${what}: the offer the knock chose`);
  assert.equal(row.partyB, VISITOR, `${what}: partyB is the visitor`);
  assert.equal(row.partyB, k.reply.deal.partyB, `${what}: the deal's partyB`);
  assert.ok(Number.isSafeInteger(row.issued_ts) && row.issued_ts >= k.before - 1 && row.issued_ts <= k.after + 1,
    `${what}: issued_ts is the issue time in epoch seconds: ${row.issued_ts}`);
  assert.equal(row.pending_text, k.replyText, `${what}: pending_text is the reply text exactly as signed`);
  assert.equal(row.decision, null, `${what}: undecided`);
}

const row = (ref, decision = null, ts = 1700000000) => ({ ref, offer: 'hold', partyB: VISITOR, issued_ts: ts,
  pending_text: `{"ref":${JSON.stringify(ref)}}`, decision });
const refsOf = (rows) => rows.map((r) => r.ref).sort();

/** Both built-in stores, fresh, under one label each. */
function bothStores(opts = {}) {
  const path = join(tmp('ae-receipts-file-'), 'state.json');
  return [
    ['memory', memoryStore(opts), null],
    ['file', createFileStore(path, opts), path],
  ];
}

// ---------------------------------------------------------------- functional: the door writes the row

test('a pending reply with a deal writes its receipts row, in the memory store', async () => {
  const store = memoryStore();
  for (const m of RECEIPT_METHODS) assert.equal(typeof store[m], 'function', `the memory store implements ${m}`);
  const entry = makeDoor(store);
  const k = await pendingHold(entry);
  assertRow(await store.getReceipt(k.reply.deal.ref), k, 'memory');
  const undecided = await store.listUndecidedReceipts();
  assert.equal(undecided.length, 1, 'one undecided row');
  assertRow(undecided[0], k, 'memory list');
});

test('a pending reply with a deal writes its receipts row, in the file store, and it survives a restart', async () => {
  const path = join(tmp('ae-receipts-door-'), 'state.json');
  const store = createFileStore(path);
  for (const m of RECEIPT_METHODS) assert.equal(typeof store[m], 'function', `the file store implements ${m}`);
  const k = await pendingHold(makeDoor(store));
  assertRow(await store.getReceipt(k.reply.deal.ref), k, 'file');
  const reopened = createFileStore(path);
  assertRow(await reopened.getReceipt(k.reply.deal.ref), k, 'file after restart');
  assert.equal((await reopened.listUndecidedReceipts()).length, 1, 'one undecided row after restart');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(Array.isArray(doc.receipts), 'the state file has a receipts section');
  assert.deepEqual(doc.receipts.map((p) => p[0]), [k.reply.deal.ref], 'keyed by the deal ref, as [ref, row] pairs');
});

test('a pending reply with a deal writes its receipts row through a pluggable store\'s putReceipt', async () => {
  const store = pluggableStore();
  const k = await pendingHold(makeDoor(store));
  assert.ok(store.calls.some(([m, ref]) => m === 'putReceipt' && ref === k.reply.deal.ref),
    `the door called putReceipt(ref, row): ${JSON.stringify(store.calls)}`);
  assertRow(store.receipts.get(k.reply.deal.ref), k, 'pluggable');
});

test('each pending deal gets its own row; a door with no store option starts too', async () => {
  const store = memoryStore();
  const entry = makeDoor(store);
  const a = await pendingHold(entry);
  const b = await pendingHold(entry, { text: 'hold item {"id":202}' });
  assert.notEqual(a.reply.deal.ref, b.reply.deal.ref);
  assertRow(await store.getReceipt(a.reply.deal.ref), a, 'first');
  assertRow(await store.getReceipt(b.reply.deal.ref), b, 'second');
  assert.deepEqual(refsOf(await store.listUndecidedReceipts()), [a.reply.deal.ref, b.reply.deal.ref].sort());
  // The default door builds its own memory store, which now carries the receipt methods.
  const plain = makeDoor(null);
  await pendingHold(plain);
});

// ---------------------------------------------------------------- functional: get / put / list

test('get/put by ref round-trip, in both stores; a later put replaces; an unknown ref reads null', async () => {
  for (const [label, store, path] of bothStores()) {
    assert.equal(await store.getReceipt('nope'), null, `${label}: an unknown ref reads null`);
    const r1 = row('ref-1');
    await store.putReceipt('ref-1', r1);
    assert.deepEqual(await store.getReceipt('ref-1'), r1, `${label}: put then get`);
    const decided = { ...r1, decision: 'approved' };
    await store.putReceipt('ref-1', decided);
    assert.deepEqual(await store.getReceipt('ref-1'), decided, `${label}: a later put replaces the row`);
    if (path) {
      assert.deepEqual(await createFileStore(path).getReceipt('ref-1'), decided, 'file: the row survives a restart');
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(doc.receipts.filter((p) => p[0] === 'ref-1').length, 1, 'file: one pair per ref, never a duplicate');
    }
  }
});

test('list-undecided returns only rows whose decision is null, in both stores', async () => {
  for (const [label, store, path] of bothStores()) {
    assert.deepEqual(await store.listUndecidedReceipts(), [], `${label}: empty at first`);
    await store.putReceipt('u-1', row('u-1'));
    await store.putReceipt('d-1', row('d-1', 'approved'));
    await store.putReceipt('u-2', row('u-2'));
    await store.putReceipt('d-2', row('d-2', 'declined'));
    const listed = await store.listUndecidedReceipts();
    assert.ok(Array.isArray(listed), `${label}: an array`);
    assert.deepEqual(refsOf(listed), ['u-1', 'u-2'], `${label}: only the undecided rows`);
    for (const r of listed) assert.deepEqual(r, row(r.ref), `${label}: whole rows`);
    await store.putReceipt('u-1', row('u-1', 'approved'));
    assert.deepEqual(refsOf(await store.listUndecidedReceipts()), ['u-2'], `${label}: deciding a row takes it off the list`);
    if (path) assert.deepEqual(refsOf(await createFileStore(path).listUndecidedReceipts()), ['u-2'], 'file: after a restart');
  }
});

// ---------------------------------------------------------------- functional: maxReceipts

test('over maxReceipts, decided rows are evicted first, oldest first; undecided rows stay', async () => {
  for (const [label, store, path] of bothStores({ maxReceipts: 3 })) {
    await store.putReceipt('d-old', row('d-old', 'approved'));
    await store.putReceipt('u-1', row('u-1'));
    await store.putReceipt('d-new', row('d-new', 'declined'));
    await store.putReceipt('u-2', row('u-2'));
    assert.equal(await store.getReceipt('d-old'), null, `${label}: the oldest decided row goes first`);
    assert.deepEqual(await store.getReceipt('d-new'), row('d-new', 'declined'), `${label}: the newer decided row stays`);
    assert.deepEqual(await store.getReceipt('u-1'), row('u-1'), `${label}: an older undecided row is not evicted before a decided one`);
    await store.putReceipt('u-3', row('u-3'));
    assert.equal(await store.getReceipt('d-new'), null, `${label}: then the next decided row`);
    assert.deepEqual(refsOf(await store.listUndecidedReceipts()), ['u-1', 'u-2', 'u-3'], `${label}: every undecided row stays`);
    if (path) assert.deepEqual(refsOf(await createFileStore(path, { maxReceipts: 3 }).listUndecidedReceipts()),
      ['u-1', 'u-2', 'u-3'], 'file: after a restart');
  }
});

test('an undecided row is never evicted, even over the cap', async () => {
  for (const [label, store] of bothStores({ maxReceipts: 2 })) {
    const refs = ['u-a', 'u-b', 'u-c', 'u-d', 'u-e'];
    for (const r of refs) await store.putReceipt(r, row(r));
    for (const r of refs) assert.deepEqual(await store.getReceipt(r), row(r), `${label}: ${r} is kept over the cap`);
    assert.deepEqual(refsOf(await store.listUndecidedReceipts()), refs, `${label}: all five listed`);
    // A decided row arriving over the cap is the one that goes, not an undecided one.
    await store.putReceipt('d-late', row('d-late', 'approved'));
    for (const r of refs) assert.deepEqual(await store.getReceipt(r), row(r), `${label}: ${r} still kept`);
    assert.equal(await store.getReceipt('d-late'), null, `${label}: the decided row is evicted to honour the cap`);
  }
});

test('a pending row the door wrote is never evicted by later decided rows over the cap', async () => {
  const store = memoryStore({ maxReceipts: 2 });
  const k = await pendingHold(makeDoor(store));
  for (let i = 0; i < 5; i += 1) await store.putReceipt(`d-${i}`, row(`d-${i}`, 'approved'));
  assertRow(await store.getReceipt(k.reply.deal.ref), k, 'the door\'s row over the cap');
  assert.deepEqual(refsOf(await store.listUndecidedReceipts()), [k.reply.deal.ref]);
});

test('maxReceipts defaults to 5000, in the memory store', async () => {
  const store = memoryStore();
  for (let i = 0; i < 5000; i += 1) await store.putReceipt(`d-${i}`, row(`d-${i}`, 'approved'));
  assert.deepEqual(await store.getReceipt('d-0'), row('d-0', 'approved'), '5000 rows fit');
  await store.putReceipt('d-5000', row('d-5000', 'approved'));
  assert.equal(await store.getReceipt('d-0'), null, 'the 5001st evicts the oldest decided row');
  assert.deepEqual(await store.getReceipt('d-1'), row('d-1', 'approved'), 'only that one');
  assert.deepEqual(await store.getReceipt('d-5000'), row('d-5000', 'approved'));
});

test('maxReceipts defaults to 5000, in the file store', async () => {
  const path = join(tmp('ae-receipts-cap-'), 'state.json');
  const seeded = [];
  for (let i = 0; i < 5000; i += 1) seeded.push([`d-${i}`, row(`d-${i}`, 'approved')]);
  writeFileSync(path, JSON.stringify({ v: 1, messages: [], accounts: [], deviceOwners: [], keyStates: [], receipts: seeded }));
  const store = createFileStore(path);
  assert.deepEqual(await store.getReceipt('d-0'), row('d-0', 'approved'), '5000 rows fit');
  await store.putReceipt('d-5000', row('d-5000', 'approved'));
  assert.equal(await store.getReceipt('d-0'), null, 'the 5001st evicts the oldest decided row');
  assert.deepEqual(await store.getReceipt('d-1'), row('d-1', 'approved'), 'only that one');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).receipts.length, 5000, 'the section holds 5000');
});

test('a state file written before the receipts section still opens, with no receipts', async () => {
  const path = join(tmp('ae-receipts-old-'), 'state.json');
  writeFileSync(path, JSON.stringify({ v: 1, messages: [], accounts: [], deviceOwners: [], keyStates: [] }));
  const store = createFileStore(path);
  assert.equal(await store.getReceipt('any'), null);
  assert.deepEqual(await store.listUndecidedReceipts(), []);
  await store.putReceipt('r', row('r'));
  assert.deepEqual(await createFileStore(path).getReceipt('r'), row('r'));
});

// ---------------------------------------------------------------- refusals: the store seam

test('refused at construction: a pluggable store missing a receipts method, by name', () => {
  for (const missing of RECEIPT_METHODS) {
    const store = pluggableStore();
    delete store[missing];
    assert.throws(() => makeDoor(store), (e) => {
      assert.ok(e instanceof TypeError, `${missing}: a TypeError, as the keyState refusal: ${e}`);
      assert.match(e.message, new RegExp(`missing[^.]*\\b${missing}\\b`), `${missing}: the refusal names it: ${e.message}`);
      for (const other of RECEIPT_METHODS.filter((m) => m !== missing)) {
        assert.doesNotMatch(e.message.split('.')[0], new RegExp(`\\b${other}\\b`), `${missing}: names only what is missing: ${e.message}`);
      }
      return true;
    }, `a store without ${missing} is refused`);
  }
  const store = pluggableStore();
  for (const m of RECEIPT_METHODS) delete store[m];
  assert.throws(() => makeDoor(store), (e) => {
    for (const m of RECEIPT_METHODS) assert.match(e.message, new RegExp(`\\b${m}\\b`), `all three named: ${e.message}`);
    return true;
  }, 'a store with none of the receipts methods is refused');
});

test('refused at construction: a receipts method that is present but not a function', () => {
  const store = pluggableStore();
  store.listUndecidedReceipts = [];
  assert.throws(() => makeDoor(store), /listUndecidedReceipts/, 'a non-function is as missing');
});

test('accepted: a pluggable store with every method, the seven older ones and the three receipts ones', () => {
  assert.doesNotThrow(() => makeDoor(pluggableStore()));
});

// ---------------------------------------------------------------- refusals: no row where no deal was issued

test('no row for a reply without a deal: the anonymous lane, and an offer that carries no receipt', async () => {
  const store = memoryStore();
  const entry = makeDoor(store);
  const anon = await knock(entry, { signed: false });
  assert.ok(!anon.reply?.deal, `the anonymous lane carries no deal: ${anon.raw.slice(0, 300)}`);
  const ask = await knock(entry, { offer: 'ask', text: 'ask hours {}' });
  assert.ok(ask.verified, `the ask offer answers: ${ask.raw.slice(0, 300)}`);
  assert.equal(ask.reply?.status, 'pending_confirmation', 'pending');
  assert.ok(!ask.reply?.deal, 'with no deal');
  assert.deepEqual(await store.listUndecidedReceipts(), [], 'no rows');
  assert.equal(await store.getReceipt(anon.messageId), null);
  assert.equal(await store.getReceipt(ask.messageId), null);
});

test('no row for a refused knock: a signature over other text', async () => {
  const store = memoryStore();
  const k = await knock(makeDoor(store), { badSig: true });
  assert.ok(k.parsed?.error, `the knock is refused: ${k.raw.slice(0, 300)}`);
  assert.equal(await store.getReceipt(k.messageId), null, 'no row under its message id');
  assert.deepEqual(await store.listUndecidedReceipts(), [], 'no rows');
});

test('a replayed message id is refused and leaves the row as first written', async () => {
  for (const [label, store] of bothStores()) {
    const entry = makeDoor(store);
    const k = await pendingHold(entry);
    const first = clone(await store.getReceipt(k.reply.deal.ref));
    const again = await knock(entry, { messageId: k.messageId, text: 'hold item {"id":999}' });
    assert.ok(again.parsed?.error, `${label}: the replay is refused: ${again.raw.slice(0, 300)}`);
    assert.deepEqual(await store.getReceipt(k.reply.deal.ref), first, `${label}: the row is untouched`);
    assert.equal((await store.listUndecidedReceipts()).length, 1, `${label}: still one row`);
  }
});

test('a visitor-chosen ref such as __proto__ is data, never a prototype key', async () => {
  for (const [label, store, path] of bothStores()) {
    for (const ref of ['__proto__', 'constructor', 'hasOwnProperty']) {
      if (ref !== '__proto__') assert.equal(await store.getReceipt(ref), null, `${label}: ${ref} reads null before any put`);
      await store.putReceipt(ref, row(ref));
      assert.deepEqual(await store.getReceipt(ref), row(ref), `${label}: ${ref} round-trips`);
    }
    assert.deepEqual(refsOf(await store.listUndecidedReceipts()), ['__proto__', 'constructor', 'hasOwnProperty'].sort(),
      `${label}: all three listed`);
    assert.equal(({}).decision, undefined, `${label}: Object.prototype untouched`);
    assert.equal(({}).pending_text, undefined, `${label}: Object.prototype untouched`);
    if (path) assert.deepEqual(await createFileStore(path).getReceipt('__proto__'), row('__proto__'), 'file: after a restart');
  }
  // And through the door: a knock whose message id is __proto__ files its row under that ref.
  const store = memoryStore();
  const k = await pendingHold(makeDoor(store), { messageId: '__proto__' });
  assertRow(await store.getReceipt('__proto__'), k, 'door, ref __proto__');
  assert.equal(({}).ref, undefined, 'Object.prototype untouched');
});
