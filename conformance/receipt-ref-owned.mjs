#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// A receipt's ref belongs to the knock that first filed it: a later knock with the same messageId
// never replaces the row.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). Intake 20261028T210658Z, finding D1 of the
// security review secrev-entry-6059-0363-2 (putReceipt at the pending-hold write, both built-in
// stores overwriting). The ruled fix is option (c): the door refuses to file a receipt under a ref
// that already exists. Options (a) (a door-minted ref) and (b) (rows keyed by partyB and messageId)
// are NOT taken, and nothing here needs them: the ref stays the visitor's messageId. The
// implementer may not edit this file. Run it as
// `bash .cursor/skills/isolated-session/scripts/run-node.sh conformance/receipt-ref-owned.mjs`.
//
// Where the refusal lives: on the door's pending-hold write. The store seam's own putReceipt keeps
// replacing a row when called directly -- conformance/receipts.mjs, decide.mjs, decide-ref.mjs and
// the owner's `decide` all rely on that -- so this file drives the door, never putReceipt alone.
//
// The 600 s replay window (REPLAY_TTL_S) is passed on a FAKE clock: Date.now is replaced for the
// duration of a test, the knocks are signed at the fake time, and nothing sleeps.
//
// What it pins, for the memory store and for the file store:
//   - a hold whose messageId already names a row, sent after the replay window, is answered -32603
//     (the door's existing store-failure answer), with no result, no deal and nothing of the
//     original row in the body -- whether the row is undecided or decided, and whether the knock is
//     signed by a stranger or by the original customer;
//   - the row stays byte-identical, and so does the rest of the receipts section;
//   - the original customer's track still answers afterwards (pending, or the stored decision text
//     byte for byte), and a stranger's track on that ref is still the one -32602 refusal;
//   - decide still acts on the original row: the follow-on names the original customer;
//   - a hold with a fresh messageId still succeeds, for the stranger and for the original customer.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const {
  ERRORS, REPLAY_TTL_S, confirmReceipt, createAgentEntry, createFileStore, createMemoryStore, didFromSeedHex,
  signEnvelope, verifyEnvelope,
} = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'muretai-agent-entry.mjs');
const NO_DIAL = pathToFileURL(join(HERE, 'fixtures', 'cli', 'no-dial.mjs')).href;

const DOOR_SEED = 'e3'.repeat(32);
const CUSTOMER_SEED = '4a'.repeat(32);
const STRANGER_SEED = '9f'.repeat(32);
const CUSTOMER = didFromSeedHex(CUSTOMER_SEED);
const STRANGER = didFromSeedHex(STRANGER_SEED);
const SHOP_BASE = 'https://shop.example';
const HOLD_TEXT = 'hold item {"id":101}';
const STRANGER_TEXT = 'hold item {"id":666}';

const DECLARATION = {
  v: 1,
  entry: { name: 'Harbor Lamp', baseUrl: SHOP_BASE },
  offers: [{ verb: 'hold', of: 'item', about: 'Hold one item for pickup; the shop confirms it.',
    input: { id: 'integer' }, door: { reply: 'pending' } }],
};

const scratch = [];
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
const state = { project: null, home: null };
before(() => {
  state.home = tmp('ae-refown-home-');
  state.project = tmp('ae-refown-shop-');
  writeFileSync(join(state.project, 'agent-entry.json'), `${JSON.stringify(DECLARATION, null, 2)}\n`);
});
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------- the fake clock

const REAL_NOW = Date.now;
/** Run `fn` with Date.now on a fake clock that starts two hours before the real one (so a `decide`
 *  child on the real clock is always later than anything signed here) and moves only by `advance`. */
async function withFakeClock(fn) {
  const clock = { ms: REAL_NOW() - 2 * 3600 * 1000 };
  Date.now = () => clock.ms;
  try {
    return await fn({ advance: (seconds) => { clock.ms += seconds * 1000; } });
  } finally {
    Date.now = REAL_NOW;
  }
}
const PAST_THE_WINDOW_S = REPLAY_TTL_S + 1;

// ---------------------------------------------------------------- the door and its knocks

function makeDoor(store) {
  return createAgentEntry({ seedHex: DOOR_SEED, name: DECLARATION.entry.name, baseUrl: SHOP_BASE,
    declaration: clone(DECLARATION), signedRatePerMin: 0, signedRatePerMinTotal: 0,
    responder: () => 'ok', store });
}

let sequence = 0;
/** One signed message/send at `entry`, in process, at the (fake) clock's time. */
async function send(entry, { offer = 'hold', text = HOLD_TEXT, seed = CUSTOMER_SEED, messageId = null } = {}) {
  const from = didFromSeedHex(seed);
  const id = messageId ?? `refown-${++sequence}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signEnvelope(seed, { from, to: entry.did, messageId: id, contextId: null, timestamp, text });
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId: id, contextId: null, parts: [{ kind: 'text', text }],
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
  return { messageId: id, text, raw, parsed, replyText, reply, verified };
}

const trackText = (ref) => JSON.stringify({ ref });

/** A hold that must succeed: pending, with a deal whose ref is the knock's messageId. */
async function pendingHold(entry, opts = {}) {
  const k = await send(entry, opts);
  assert.ok(k.verified, `the door answers the hold, signed: ${k.raw.slice(0, 300)}`);
  assert.equal(k.reply?.status, 'pending_confirmation', `the hold is pending: ${String(k.replyText).slice(0, 300)}`);
  assert.ok(k.reply?.deal && k.reply.deal.ref === k.messageId, 'the pending reply carries a deal on the messageId');
  return k;
}

/** The overwrite refusal: -32603, nothing answered, nothing of the original row in the body. */
function assertStoreRefusal(k, what, secrets) {
  assert.ok(!k.parsed?.result, `${what}: no answer is given: ${k.raw.slice(0, 300)}`);
  assert.equal(k.parsed?.error?.code, ERRORS.INTERNAL_ERROR.code, `${what}: refused -32603: ${k.raw.slice(0, 300)}`);
  assert.ok(!k.raw.includes('"deal"'), `${what}: no deal`);
  for (const s of secrets) {
    assert.ok(!k.raw.includes(s), `${what}: the refusal does not carry ${JSON.stringify(String(s).slice(0, 60))}`);
  }
}

// ---------------------------------------------------------------- the two stores

/** Both built-in stores, fresh, each with a way to read its receipts section as bytes. */
function bothStores() {
  const path = join(state.project, `refown-${++sequence}.state.json`);
  const memory = createMemoryStore();
  return [
    { label: 'memory', store: memory, path: null,
      section: () => JSON.stringify([...memory.listUndecidedReceipts()]) },
    { label: 'file', store: createFileStore(path), path,
      section: () => JSON.stringify(JSON.parse(readFileSync(path, 'utf8')).receipts) },
  ];
}

const rowBytes = async (store, ref) => JSON.stringify(await store.getReceipt(ref));

/** Decide the row in place, the way the owner's decide does: the same row plus a decision. */
async function decideInPlace(store, ref) {
  const row = clone(await store.getReceipt(ref));
  const text = confirmReceipt(DOOR_SEED, row.pending_text);
  await store.putReceipt(ref, { ...row, decision: { status: 'confirmed', text, decided_ts: Math.floor(Date.now() / 1000) } });
  return text;
}

// ---------------------------------------------------------------- the decide child

function runDecide(args) {
  const log = join(tmp('ae-refown-dial-'), 'dial.jsonl');
  const env = { HOME: state.home, AE_NO_DIAL_LOG: log, AGENT_ENTRY_SEED_HEX: DOOR_SEED };
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k];
  const run = spawnSync(process.execPath, ['--import', NO_DIAL, BIN, 'decide', ...args],
    { cwd: state.project, env, encoding: 'utf8', timeout: 60000 });
  return { code: run.status, stdout: run.stdout || '', stderr: run.stderr || '' };
}
const said = (run) => `exit ${run.code}; stdout ${JSON.stringify(run.stdout.slice(0, 400))}; stderr ${JSON.stringify(run.stderr.slice(0, 400))}`;

// ---------------------------------------------------------------- refusals: the undecided row

test('refused: a stranger reusing an undecided row\'s messageId after the replay window gets -32603; the row is byte-identical', async () => {
  await withFakeClock(async ({ advance }) => {
    for (const { label, store, section } of bothStores()) {
      const entry = makeDoor(store);
      const original = await pendingHold(entry);
      const rowBefore = await rowBytes(store, original.messageId);
      const sectionBefore = section();
      advance(PAST_THE_WINDOW_S);
      const reuse = await send(entry, { seed: STRANGER_SEED, text: STRANGER_TEXT, messageId: original.messageId });
      assertStoreRefusal(reuse, `${label}: stranger reuse`, [CUSTOMER, original.replyText]);
      assert.equal(await rowBytes(store, original.messageId), rowBefore, `${label}: the row is byte-identical`);
      assert.equal(section(), sectionBefore, `${label}: the receipts section is unchanged`);
      const row = await store.getReceipt(original.messageId);
      assert.equal(row.partyB, CUSTOMER, `${label}: partyB is still the original customer`);
      assert.equal(row.decision, null, `${label}: still undecided`);
    }
  });
});

test('refused: the original customer reusing its own messageId after the window gets -32603 too; the row is byte-identical', async () => {
  await withFakeClock(async ({ advance }) => {
    for (const { label, store, section } of bothStores()) {
      const entry = makeDoor(store);
      const original = await pendingHold(entry);
      const rowBefore = await rowBytes(store, original.messageId);
      const sectionBefore = section();
      advance(PAST_THE_WINDOW_S);
      const reuse = await send(entry, { text: 'hold item {"id":202}', messageId: original.messageId });
      assertStoreRefusal(reuse, `${label}: own reuse`, [original.replyText]);
      assert.equal(await rowBytes(store, original.messageId), rowBefore, `${label}: the row is byte-identical`);
      assert.equal(section(), sectionBefore, `${label}: the receipts section is unchanged`);
    }
  });
});

test('refused: reuse long after the window, many times over, never moves the row', async () => {
  await withFakeClock(async ({ advance }) => {
    for (const { label, store } of bothStores()) {
      const entry = makeDoor(store);
      const original = await pendingHold(entry);
      const rowBefore = await rowBytes(store, original.messageId);
      for (let i = 0; i < 4; i += 1) {
        advance(PAST_THE_WINDOW_S * (i + 1));
        const reuse = await send(entry, { seed: i % 2 ? CUSTOMER_SEED : STRANGER_SEED,
          text: `hold item {"id":${700 + i}}`, messageId: original.messageId });
        assertStoreRefusal(reuse, `${label}: reuse ${i + 1}`, [original.replyText]);
      }
      assert.equal(await rowBytes(store, original.messageId), rowBefore, `${label}: the row is byte-identical`);
      assert.equal((await store.listUndecidedReceipts()).length, 1, `${label}: still one row`);
    }
  });
});

// ---------------------------------------------------------------- refusals: the decided row

test('refused: a stranger reusing a DECIDED row\'s messageId after the window gets -32603; the decision is byte-identical', async () => {
  await withFakeClock(async ({ advance }) => {
    for (const { label, store, path } of bothStores()) {
      const entry = makeDoor(store);
      const original = await pendingHold(entry);
      const decisionText = await decideInPlace(store, original.messageId);
      const rowBefore = await rowBytes(store, original.messageId);
      const sectionBefore = path ? JSON.stringify(JSON.parse(readFileSync(path, 'utf8')).receipts) : null;
      advance(PAST_THE_WINDOW_S);
      const reuse = await send(entry, { seed: STRANGER_SEED, text: STRANGER_TEXT, messageId: original.messageId });
      assertStoreRefusal(reuse, `${label}: stranger reuse of a decided ref`, [CUSTOMER, decisionText]);
      assert.equal(await rowBytes(store, original.messageId), rowBefore, `${label}: the decided row is byte-identical`);
      if (path) {
        assert.equal(JSON.stringify(JSON.parse(readFileSync(path, 'utf8')).receipts), sectionBefore,
          'file: the receipts section is unchanged');
      }
      assert.deepEqual(await store.listUndecidedReceipts(), [], `${label}: no undecided row appeared`);
      // The original customer collects the decision as stored.
      const track = await send(entry, { offer: 'track', text: trackText(original.messageId) });
      assert.ok(track.verified, `${label}: the original customer's track is answered: ${track.raw.slice(0, 300)}`);
      assert.equal(track.replyText, decisionText, `${label}: the stored decision text, byte for byte`);
    }
  });
});

// ---------------------------------------------------------------- functional: the owner and the customer afterwards

test('after a refused reuse, the original customer\'s track still answers and the stranger\'s is still refused', async () => {
  await withFakeClock(async ({ advance }) => {
    for (const { label, store } of bothStores()) {
      const entry = makeDoor(store);
      const original = await pendingHold(entry);
      advance(PAST_THE_WINDOW_S);
      const reuse = await send(entry, { seed: STRANGER_SEED, text: STRANGER_TEXT, messageId: original.messageId });
      assertStoreRefusal(reuse, `${label}: stranger reuse`, [CUSTOMER]);
      const mine = await send(entry, { offer: 'track', text: trackText(original.messageId) });
      assert.ok(mine.verified, `${label}: the original customer's track is answered, signed: ${mine.raw.slice(0, 300)}`);
      assert.equal(mine.reply?.status, 'pending_confirmation', `${label}: still pending`);
      assert.equal(mine.reply?.customer_did, CUSTOMER, `${label}: filed under the original customer`);
      const theirs = await send(entry, { offer: 'track', text: trackText(original.messageId), seed: STRANGER_SEED });
      assert.ok(!theirs.parsed?.result, `${label}: the stranger's track gets no answer: ${theirs.raw.slice(0, 300)}`);
      assert.equal(theirs.parsed?.error?.code, ERRORS.INVALID_PARAMS.code, `${label}: the one track refusal`);
    }
  });
});

test('after a refused reuse, decide acts on the original row: the follow-on names the original customer', async () => {
  await withFakeClock(async ({ advance }) => {
    const path = join(state.project, 'refown-decide.state.json');
    const store = createFileStore(path);
    const entry = makeDoor(store);
    const original = await pendingHold(entry);
    const originalRow = clone(await store.getReceipt(original.messageId));
    advance(PAST_THE_WINDOW_S);
    const reuse = await send(entry, { seed: STRANGER_SEED, text: STRANGER_TEXT, messageId: original.messageId });
    assertStoreRefusal(reuse, 'stranger reuse before decide', [CUSTOMER]);
    const run = runDecide([original.messageId, 'approve', '--store', path]);
    assert.equal(run.code, 0, `decide <ref> approve succeeds: ${said(run)}`);
    const follow = JSON.parse(run.stdout.trim());
    assert.equal(follow.status, 'confirmed');
    assert.equal(follow.customer_did, CUSTOMER, 'the follow-on is the original customer\'s');
    assert.notEqual(follow.customer_did, STRANGER, 'never the stranger\'s');
    assert.equal(follow.deal?.partyB, CUSTOMER, 'the deal names the original customer as partyB');
    assert.equal(follow.deal?.termsHash, original.reply.deal.termsHash, 'on the original hold\'s termsHash');
    const row = await store.getReceipt(original.messageId);
    assert.equal(row.partyB, CUSTOMER, 'the decided row is the original customer\'s');
    assert.equal(row.pending_text, originalRow.pending_text, 'over the original pending text');
    assert.equal(row.decision?.text, run.stdout.trim(), 'the decision stored is the one printed');
    const track = await send(entry, { offer: 'track', text: trackText(original.messageId) });
    assert.ok(track.verified, `the original customer collects it: ${track.raw.slice(0, 300)}`);
    assert.equal(track.replyText, run.stdout.trim(), 'the stored decision text, byte for byte');
  });
});

test('after a refused reuse, a hold with a fresh messageId still succeeds, for the stranger and for the customer', async () => {
  await withFakeClock(async ({ advance }) => {
    for (const { label, store } of bothStores()) {
      const entry = makeDoor(store);
      const original = await pendingHold(entry);
      const rowBefore = await rowBytes(store, original.messageId);
      advance(PAST_THE_WINDOW_S);
      assertStoreRefusal(await send(entry, { seed: STRANGER_SEED, text: STRANGER_TEXT, messageId: original.messageId }),
        `${label}: stranger reuse`, [CUSTOMER]);
      const fresh = await pendingHold(entry, { seed: STRANGER_SEED, text: STRANGER_TEXT });
      const theirRow = await store.getReceipt(fresh.messageId);
      assert.equal(theirRow?.partyB, STRANGER, `${label}: the stranger's fresh hold is filed under the stranger`);
      const again = await pendingHold(entry, { text: 'hold item {"id":303}' });
      assert.equal((await store.getReceipt(again.messageId))?.partyB, CUSTOMER, `${label}: and the customer's`);
      assert.equal(await rowBytes(store, original.messageId), rowBefore, `${label}: the first row is still byte-identical`);
      assert.equal((await store.listUndecidedReceipts()).length, 3, `${label}: three rows, one per fresh ref`);
    }
  });
});

test('control: a messageId inside the replay window is still the replay refusal, not the store one', async () => {
  await withFakeClock(async () => {
    for (const { label, store } of bothStores()) {
      const entry = makeDoor(store);
      const original = await pendingHold(entry);
      const rowBefore = await rowBytes(store, original.messageId);
      const replay = await send(entry, { seed: STRANGER_SEED, text: STRANGER_TEXT, messageId: original.messageId });
      assert.equal(replay.parsed?.error?.code, ERRORS.REPLAY_REJECTED.code, `${label}: inside the window, -32002: ${replay.raw.slice(0, 300)}`);
      assert.equal(await rowBytes(store, original.messageId), rowBefore, `${label}: the row is byte-identical`);
    }
  });
});
