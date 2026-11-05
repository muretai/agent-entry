#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Undecided receipts are capped, per partyB and in total; a hold past either cap is refused, and
// no undecided row is ever evicted to make room.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). Intake 20261028T210658Z, finding D2 of the
// security review secrev-entry-6059-0363-2 (decidedOverCap never evicts an undecided row, so every
// signed pending knock adds one, without bound). The implementer may not edit this file. Run it as
// `node conformance/receipt-undecided-caps.mjs`.
//
// The caps, named here because the requirement leaves the names and values to the test author:
//   export const MAX_UNDECIDED_RECEIPTS_PER_PARTY = 5;    undecided rows one partyB may hold
//   export const MAX_UNDECIDED_RECEIPTS = 500;            undecided rows the door holds in all
// Both are exported from muretai-agent-entry.mjs. A row counts against them while its decision is
// null; a decided row never does. The door enforces them on its pending-hold write, for whatever
// store it was given; the store seam's own putReceipt is not asked to refuse (conformance/*.mjs
// seed rows through it directly).
//
// The refusal, named here too: a hold that would file an undecided row past either cap is answered
// with the JSON-RPC error ERRORS.RATE_LIMITED (-32004): no result, no deal, no receipt row, and the
// receipts section unchanged (the file store's bytes too). The door is saying "come back later":
// the room frees when the owner decides.
//
// What it pins, for the memory store and for the file store:
//   - the two constants, exported, with exactly these values;
//   - reaching the per-partyB cap refuses that partyB's next hold, while another partyB still
//     succeeds;
//   - reaching the total cap refuses any new hold, from a partyB that holds nothing;
//   - deciding a row frees room, per partyB (through the owner's `decide` too) and in total;
//   - decided rows are not counted: a partyB with decided rows still gets its full undecided cap;
//   - every undecided row remains after the caps are hit, and track on them still answers;
//   - a pending offer that files no receipt (no deal) is not refused by a full cap.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const {
  ERRORS, createAgentEntry, createFileStore, createMemoryStore, didFromSeedHex, signEnvelope, verifyEnvelope,
} = door;

const PER_PARTY = 5;
const TOTAL = 500;

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'muretai-agent-entry.mjs');
const NO_DIAL = pathToFileURL(join(HERE, 'fixtures', 'cli', 'no-dial.mjs')).href;

const DOOR_SEED = 'c4'.repeat(32);
const ALICE_SEED = '1d'.repeat(32);
const BOB_SEED = '2e'.repeat(32);
const CAROL_SEED = '3f'.repeat(32);
const ALICE = didFromSeedHex(ALICE_SEED);
const BOB = didFromSeedHex(BOB_SEED);
const SHOP_BASE = 'https://shop.example';

const DECLARATION = {
  v: 1,
  entry: { name: 'Harbor Lamp', baseUrl: SHOP_BASE },
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
const state = { project: null, home: null };
before(() => {
  state.home = tmp('ae-caps-home-');
  state.project = tmp('ae-caps-shop-');
  writeFileSync(join(state.project, 'agent-entry.json'), `${JSON.stringify(DECLARATION, null, 2)}\n`);
});
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const clone = (v) => JSON.parse(JSON.stringify(v));
const nowS = () => Math.floor(Date.now() / 1000);

function makeDoor(store) {
  return createAgentEntry({ seedHex: DOOR_SEED, name: DECLARATION.entry.name, baseUrl: SHOP_BASE,
    declaration: clone(DECLARATION), signedRatePerMin: 0, signedRatePerMinTotal: 0,
    responder: () => 'ok', store });
}

let sequence = 0;
/** One signed message/send at `entry`, in process. */
async function send(entry, { offer = 'hold', text = null, seed = ALICE_SEED } = {}) {
  const from = didFromSeedHex(seed);
  const id = `caps-${++sequence}`;
  const body0 = text ?? `hold item {"id":${sequence}}`;
  const timestamp = nowS();
  const sig = signEnvelope(seed, { from, to: entry.did, messageId: id, contextId: null, timestamp, text: body0 });
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId: id, contextId: null, parts: [{ kind: 'text', text: body0 }],
      metadata: { offer, from, to: entry.did, timestamp, sig } } } }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
    { remoteAddress: '127.0.0.1' });
  const raw = Buffer.from(out.body || '').toString('utf8');
  let parsed = null; try { parsed = JSON.parse(raw); } catch { /* not json */ }
  const message = parsed?.result;
  const replyText = message?.parts?.[0]?.text;
  let reply = null; try { reply = JSON.parse(replyText); } catch { /* not json */ }
  const verified = Boolean(message) && verifyEnvelope({ from: message.metadata?.from, to: message.metadata?.to,
    messageId: message.messageId, contextId: message.contextId ?? null, timestamp: message.metadata?.timestamp,
    text: replyText, sig: message.metadata?.sig }, { recipientDid: from, signerDid: entry.did });
  return { messageId: id, raw, parsed, replyText, reply, verified };
}

async function pendingHold(entry, opts = {}) {
  const k = await send(entry, opts);
  assert.ok(k.verified, `the door answers the hold, signed: ${k.raw.slice(0, 300)}`);
  assert.equal(k.reply?.status, 'pending_confirmation', `the hold is pending: ${String(k.replyText).slice(0, 300)}`);
  assert.ok(k.reply?.deal && k.reply.deal.ref === k.messageId, 'the pending reply carries a deal');
  return k;
}

/** The cap refusal: -32004, nothing answered, no deal, no row under its messageId. */
async function assertCapRefusal(k, store, what) {
  assert.ok(!k.parsed?.result, `${what}: no answer is given: ${k.raw.slice(0, 300)}`);
  assert.equal(k.parsed?.error?.code, ERRORS.RATE_LIMITED.code, `${what}: refused -32004: ${k.raw.slice(0, 300)}`);
  assert.ok(!k.raw.includes('"deal"'), `${what}: no deal`);
  assert.equal(await store.getReceipt(k.messageId), null, `${what}: no row under its messageId`);
}

// ---------------------------------------------------------------- the two stores

/** Both built-in stores, fresh, each with its receipts section readable as bytes. */
function bothStores() {
  const path = join(state.project, `caps-${++sequence}.state.json`);
  const memory = createMemoryStore();
  const file = createFileStore(path);
  return [
    { label: 'memory', store: memory, path: null,
      section: async () => JSON.stringify(await memory.listUndecidedReceipts()) },
    { label: 'file', store: file, path,
      section: async () => JSON.stringify(JSON.parse(readFileSync(path, 'utf8')).receipts) },
  ];
}

/** A row in the door's shape, seeded straight through the store seam (not a signed pending text). */
const seededRow = (ref, partyB, decision = null) => ({ ref, offer: 'hold', partyB, issued_ts: nowS() - 60,
  pending_text: JSON.stringify({ ref }), decision });
const decided = () => ({ status: 'confirmed', text: '{"status":"confirmed"}', decided_ts: nowS() });

/** `count` undecided rows, one per made-up partyB, seeded into `store` (the file store in one write). */
async function seedUndecided(label, store, path, count, prefix = 'seed') {
  const pairs = [];
  for (let i = 0; i < count; i += 1) {
    const ref = `${prefix}-${i}`;
    pairs.push([ref, seededRow(ref, `did:key:z6MkSeededParty${prefix}${i}`)]);
  }
  if (label === 'file') {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    doc.receipts = [...doc.receipts, ...pairs];
    writeFileSync(path, `${JSON.stringify(doc)}\n`);
  } else {
    for (const [ref, row] of pairs) await store.putReceipt(ref, row);
  }
  return pairs.map(([ref]) => ref);
}

/** A file store whose file exists, so it can be seeded in one write. */
async function touch(store) {
  await store.putReceipt('touch', seededRow('touch', 'did:key:z6MkTouch', decided()));
}

/** Decide `ref` in place, as the owner's decide does: the same row plus a decision. */
async function decideInPlace(store, ref) {
  const row = clone(await store.getReceipt(ref));
  await store.putReceipt(ref, { ...row, decision: decided() });
}

function runDecide(args) {
  const log = join(tmp('ae-caps-dial-'), 'dial.jsonl');
  const env = { HOME: state.home, AE_NO_DIAL_LOG: log, AGENT_ENTRY_SEED_HEX: DOOR_SEED };
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k];
  const run = spawnSync(process.execPath, ['--import', NO_DIAL, BIN, 'decide', ...args],
    { cwd: state.project, env, encoding: 'utf8', timeout: 60000 });
  return { code: run.status, stdout: run.stdout || '', stderr: run.stderr || '' };
}
const said = (run) => `exit ${run.code}; stdout ${JSON.stringify(run.stdout.slice(0, 400))}; stderr ${JSON.stringify(run.stderr.slice(0, 400))}`;

// ---------------------------------------------------------------- the constants

test('the caps are exported constants: MAX_UNDECIDED_RECEIPTS_PER_PARTY = 5, MAX_UNDECIDED_RECEIPTS = 500', () => {
  assert.equal(door.MAX_UNDECIDED_RECEIPTS_PER_PARTY, PER_PARTY, 'the per-partyB cap is exported, 5');
  assert.equal(door.MAX_UNDECIDED_RECEIPTS, TOTAL, 'the total cap is exported, 500');
  assert.ok(door.MAX_UNDECIDED_RECEIPTS_PER_PARTY < door.MAX_UNDECIDED_RECEIPTS, 'one partyB cannot fill the door');
});

// ---------------------------------------------------------------- the per-partyB cap

test('refused: a partyB at its cap gets -32004 on the next hold; the receipts section is unchanged; another partyB still succeeds', async () => {
  for (const { label, store, section } of bothStores()) {
    const entry = makeDoor(store);
    const mine = [];
    for (let i = 0; i < PER_PARTY; i += 1) mine.push((await pendingHold(entry)).messageId);
    const before = await section();
    const over = await send(entry);
    await assertCapRefusal(over, store, `${label}: Alice's hold number ${PER_PARTY + 1}`);
    assert.equal(await section(), before, `${label}: the receipts section is unchanged, byte for byte`);
    const again = await send(entry);
    await assertCapRefusal(again, store, `${label}: and the one after`);
    assert.equal(await section(), before, `${label}: still unchanged`);
    const bob = await pendingHold(entry, { seed: BOB_SEED });
    assert.equal((await store.getReceipt(bob.messageId))?.partyB, BOB, `${label}: Bob's hold is filed`);
    const undecided = await store.listUndecidedReceipts();
    for (const ref of mine) assert.ok(undecided.some((r) => r.ref === ref), `${label}: Alice's ${ref} is still undecided and kept`);
    assert.equal(undecided.length, PER_PARTY + 1, `${label}: Alice's five and Bob's one`);
  }
});

test('decided rows are not counted: a partyB with decided rows still gets its full undecided cap', async () => {
  for (const { label, store } of bothStores()) {
    const entry = makeDoor(store);
    for (let i = 0; i < 3; i += 1) await store.putReceipt(`alice-done-${i}`, seededRow(`alice-done-${i}`, ALICE, decided()));
    for (let i = 0; i < PER_PARTY; i += 1) await pendingHold(entry);
    await assertCapRefusal(await send(entry), store, `${label}: the cap is five undecided, whatever is decided`);
    assert.equal((await store.listUndecidedReceipts()).filter((r) => r.partyB === ALICE).length, PER_PARTY,
      `${label}: five undecided`);
    for (let i = 0; i < 3; i += 1) assert.ok(await store.getReceipt(`alice-done-${i}`), `${label}: the decided rows are kept`);
  }
});

test('deciding a row frees room for that partyB', async () => {
  for (const { label, store } of bothStores()) {
    const entry = makeDoor(store);
    const mine = [];
    for (let i = 0; i < PER_PARTY; i += 1) mine.push((await pendingHold(entry)).messageId);
    await assertCapRefusal(await send(entry), store, `${label}: at the cap`);
    await decideInPlace(store, mine[0]);
    const next = await pendingHold(entry);
    assert.equal((await store.getReceipt(next.messageId))?.decision, null, `${label}: the freed room is used`);
    await assertCapRefusal(await send(entry), store, `${label}: and the cap holds again`);
  }
});

test('deciding through the owner\'s decide frees room too (file store)', async () => {
  const path = join(state.project, 'caps-decide.state.json');
  const store = createFileStore(path);
  const entry = makeDoor(store);
  const mine = [];
  for (let i = 0; i < PER_PARTY; i += 1) mine.push((await pendingHold(entry)).messageId);
  await assertCapRefusal(await send(entry), store, 'at the cap');
  const run = runDecide([mine[2], 'approve', '--store', path]);
  assert.equal(run.code, 0, `decide <ref> approve succeeds: ${said(run)}`);
  await pendingHold(entry);
  assert.equal((await store.listUndecidedReceipts()).length, PER_PARTY, 'five undecided again');
});

// ---------------------------------------------------------------- the total cap

test('refused: a door at its total cap gets -32004 on any new hold; the section is unchanged; nothing is evicted', async () => {
  for (const { label, store, path, section } of bothStores()) {
    if (path) await touch(store);
    const entry = makeDoor(store);
    const seeded = await seedUndecided(label, store, path, TOTAL);
    assert.equal((await store.listUndecidedReceipts()).length, TOTAL, `${label}: seeded to the total cap`);
    const before = await section();
    for (const seed of [ALICE_SEED, BOB_SEED, CAROL_SEED]) {
      const k = await send(entry, { seed });
      await assertCapRefusal(k, store, `${label}: a partyB holding nothing, at the total cap`);
    }
    assert.equal(await section(), before, `${label}: the receipts section is unchanged, byte for byte`);
    const undecided = await store.listUndecidedReceipts();
    assert.equal(undecided.length, TOTAL, `${label}: every undecided row remains`);
    for (const ref of [seeded[0], seeded[TOTAL - 1]]) assert.ok(await store.getReceipt(ref), `${label}: ${ref} kept`);
  }
});

test('the total cap counts undecided rows only, and deciding one frees room', async () => {
  for (const { label, store, path } of bothStores()) {
    if (path) await touch(store);
    const entry = makeDoor(store);
    for (let i = 0; i < 50; i += 1) await store.putReceipt(`done-${i}`, seededRow(`done-${i}`, `did:key:z6MkDone${i}`, decided()));
    const seeded = await seedUndecided(label, store, path, TOTAL - 1);
    const last = await pendingHold(entry, { seed: CAROL_SEED });
    assert.equal((await store.getReceipt(last.messageId))?.decision, null, `${label}: decided rows leave room for the 500th`);
    await assertCapRefusal(await send(entry, { seed: BOB_SEED }), store, `${label}: then the cap is reached`);
    await decideInPlace(store, seeded[7]);
    const bob = await pendingHold(entry, { seed: BOB_SEED });
    assert.equal((await store.getReceipt(bob.messageId))?.partyB, BOB, `${label}: deciding one row freed room`);
    await assertCapRefusal(await send(entry), store, `${label}: and the cap holds again`);
    assert.equal((await store.listUndecidedReceipts()).length, TOTAL, `${label}: exactly the cap, nothing evicted`);
  }
});

// ---------------------------------------------------------------- what the caps leave alone

test('at the caps, track on a kept row still answers, and a pending offer that files no receipt is not refused', async () => {
  for (const { label, store, path } of bothStores()) {
    const entry = makeDoor(store);
    const mine = [];
    for (let i = 0; i < PER_PARTY; i += 1) mine.push((await pendingHold(entry)).messageId);
    await assertCapRefusal(await send(entry), store, `${label}: at the per-partyB cap`);
    const track = await send(entry, { offer: 'track', text: JSON.stringify({ ref: mine[0] }) });
    assert.ok(track.verified, `${label}: track on a kept row answers: ${track.raw.slice(0, 300)}`);
    assert.equal(track.reply?.status, 'pending_confirmation', `${label}: still pending`);
    const ask = await send(entry, { offer: 'ask', text: 'ask hours {}' });
    assert.ok(ask.verified, `${label}: a pending ask with no deal is answered: ${ask.raw.slice(0, 300)}`);
    assert.ok(!ask.reply?.deal, `${label}: and files no receipt`);
    if (path) await touch(store);
    await seedUndecided(label, store, path, TOTAL - PER_PARTY);
    await assertCapRefusal(await send(entry, { seed: BOB_SEED }), store, `${label}: at the total cap`);
    const ask2 = await send(entry, { offer: 'ask', text: 'ask hours {}', seed: BOB_SEED });
    assert.ok(ask2.verified, `${label}: the ask is still answered at the total cap: ${ask2.raw.slice(0, 300)}`);
  }
});
