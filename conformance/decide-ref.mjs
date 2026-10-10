#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// `agent-entry decide <ref> approve --store <file>`: the owner's approval, looked up by ref in the
// door's own receipts store, superseding `decide <receipt file> approve` (544b8e0).
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). AT-28 chain skeleton item 2 of 6, parent
// design record 20261004T022919Z (section 2, "The decision"), brief intake 20261010T051833Z. Item 1
// (2ae57bd, the receipts section) is pinned by conformance/receipts.mjs and not repeated here;
// conformance/frame.mjs frame 5 is the acceptance pin and is not duplicated; decline, track, pending
// and knock --ref are later chain items and are not pinned here. The implementer may not edit this
// file. It is not wired into `npm test` until it is green; run it as `node conformance/decide-ref.mjs`.
//
// The store is a createFileStore state file the shop's door wrote when it answered a hold; the CLI
// opens it with `--store <file>`, and the seed comes from AGENT_ENTRY_SEED_HEX as for the file form.
//
// What it pins:
//   - the ref is looked up in the receipts store: no receipt file is read or needed;
//   - the follow-up is confirmReceipt(seed, row.pending_text), byte for byte at one fixed clock;
//   - the row's decision is stored as {status: "confirmed", text, decided_ts}, the rest of the row
//     unchanged, and the row leaves the undecided list;
//   - stdout is the follow-up text (the stored decision's text), nothing else;
//   - a repeat of the same ref approve is idempotent: exit 0, the same bytes on stdout even at a later
//     clock, the stored row unchanged, nothing sent (nothing dialled at all).
// Refusals (exit 1, nothing on stdout, nothing written to the store, the seed never printed):
//   - an unknown ref, including a receipt file path where the ref goes and a prototype-key ref;
//   - a ref already decided with a different verdict (a stored decline): approve does not overwrite it;
//   - a stored receipt this shop did not sign (another door's, a re-signed one, an edited one, or the
//     right one under another seed): confirmReceipt's refusal, and the row stays undecided.
// THE DECISION NEVER DIALS: every child runs with fixtures/cli/no-dial.mjs preloaded.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const {
  canonicalBytes, confirmReceipt, createAgentEntry, createFileStore, didFromSeedHex, publicKeyHexFromDid,
  signBytes, signEnvelope, verifyBytes,
} = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'muretai-agent-entry.mjs');
const NO_DIAL = pathToFileURL(join(HERE, 'fixtures', 'cli', 'no-dial.mjs')).href;
const FIXED_CLOCK = pathToFileURL(join(HERE, 'fixtures', 'cli', 'fixed-clock.mjs')).href;

const SHOP_SEED = '5b'.repeat(32);
const CUSTOMER_SEED = '6d'.repeat(32);
const STRANGER_SEED = '7f'.repeat(32);
const SHOP_DID = didFromSeedHex(SHOP_SEED);
const CUSTOMER_DID = didFromSeedHex(CUSTOMER_SEED);
const SHOP_BASE = 'https://shop.example';

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

const state = { home: null, project: null };
const clone = (v) => JSON.parse(JSON.stringify(v));
const nowS = () => Math.floor(Date.now() / 1000);
const dealPayload = (d) => canonicalBytes({ type: d.type, partyA: d.partyA, partyB: d.partyB, termsHash: d.termsHash,
  contextId: d.contextId, ref: d.ref, ts: d.ts });

// ---------------------------------------------------------------- the shop's door and its store

function makeDoor(seed, store) {
  return createAgentEntry({ seedHex: seed, name: DECLARATION.entry.name, baseUrl: SHOP_BASE,
    declaration: clone(DECLARATION), signedRatePerMin: 0, signedRatePerMinTotal: 0, store });
}

/** A fresh state file in the shop's project directory, and the shop's door writing into it. */
function freshShop(name) {
  const storePath = join(state.project, `${name}.state.json`);
  return { storePath, entry: makeDoor(SHOP_SEED, createFileStore(storePath)) };
}

let sequence = 0;
/** One signed `hold` knock by the customer at `entry`, in process: the pending reply and its ref. */
async function hold(entry, { text = 'hold item {"id":101}', seed = CUSTOMER_SEED } = {}) {
  const from = didFromSeedHex(seed);
  const messageId = `decide-ref-${++sequence}`;
  const timestamp = nowS();
  const sig = signEnvelope(seed, { from, to: entry.did, messageId, contextId: null, timestamp, text });
  const body = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
      metadata: { from, to: entry.did, timestamp, sig, offer: 'hold' } } },
  }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
    { remoteAddress: '127.0.0.1' });
  const replyText = JSON.parse(Buffer.from(out.body).toString('utf8')).result.parts[0].text;
  const reply = JSON.parse(replyText);
  assert.equal(reply.status, 'pending_confirmation', `the fixture door answers the hold pending: ${replyText.slice(0, 300)}`);
  assert.equal(typeof reply.deal?.ref, 'string', 'with a deal and its ref');
  return { ref: reply.deal.ref, replyText, reply };
}

/** The row under `ref`, read through a fresh file store over the state file. */
async function rowOf(storePath, ref) {
  return createFileStore(storePath).getReceipt(ref);
}
async function undecidedRefs(storePath) {
  return (await createFileStore(storePath).listUndecidedReceipts()).map((r) => r.ref).sort();
}
const storeBytes = (storePath) => readFileSync(storePath, 'utf8');

// ---------------------------------------------------------------- the CLI child

/** Run `decide` in the project with no-dial (and, when `fixedNowMs` is given, the fixed clock) preloaded. */
function runDecide(args, { seed = SHOP_SEED, fixedNowMs = null } = {}) {
  const log = join(tmp('ae-decide-ref-dial-'), 'dial.jsonl');
  const env = { HOME: state.home, AE_NO_DIAL_LOG: log };
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k];
  if (seed !== null) env.AGENT_ENTRY_SEED_HEX = seed;
  if (fixedNowMs !== null) env.AE_FIXED_NOW_MS = String(fixedNowMs);
  const imports = ['--import', NO_DIAL, ...(fixedNowMs !== null ? ['--import', FIXED_CLOCK] : [])];
  const run = spawnSync(process.execPath, [...imports, BIN, 'decide', ...args],
    { cwd: state.project, env, encoding: 'utf8', timeout: 60000 });
  let dial = [];
  try { dial = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
  return { code: run.status, stdout: run.stdout || '', stderr: run.stderr || '', timedOut: run.error?.code === 'ETIMEDOUT', dial };
}

const said = (run) => `exit ${run.code}; stdout ${JSON.stringify(run.stdout.slice(0, 400))}; stderr ${JSON.stringify(run.stderr.slice(0, 400))}`;

function assertNeverDialled(run, what) {
  assert.ok(!run.timedOut, `${what}: timed out`);
  assert.ok(run.dial.some((r) => r.kind === 'loaded'), `${what}: the no-dial guard did not load`);
  assert.deepEqual(run.dial.filter((r) => r.kind !== 'loaded'), [], `${what}: tried to reach the network (a send)`);
}

function assertNoSeed(run, what) {
  for (const s of [SHOP_SEED, CUSTOMER_SEED, STRANGER_SEED]) {
    assert.ok(!`${run.stdout}${run.stderr}`.includes(s), `${what}: a seed is never printed`);
  }
}

/** A refusal: exit 1, nothing on stdout, nothing dialled, no seed printed, the state file byte for byte unchanged. */
function assertRefused(run, what, storePath, bytesBefore) {
  assertNeverDialled(run, what);
  assert.equal(run.code, 1, `${what} is refused: ${said(run)}`);
  assert.equal(run.stdout.trim(), '', `${what}: a refusal prints no follow-up: ${said(run)}`);
  assert.ok(run.stderr.trim().length > 0, `${what}: the refusal says why: ${said(run)}`);
  assertNoSeed(run, what);
  assert.equal(storeBytes(storePath), bytesBefore, `${what}: nothing is written to the store on a refusal`);
}

/** The follow-up decide printed: exactly the one text, a trailing newline allowed. */
function printed(run) {
  return run.stdout.replace(/\n$/, '');
}

before(() => {
  state.home = tmp('ae-decide-ref-home-');
  state.project = tmp('ae-decide-ref-shop-');
  writeFileSync(join(state.project, 'agent-entry.json'), `${JSON.stringify(DECLARATION, null, 2)}\n`);
});

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- functional

test('decide <ref> approve looks the ref up in the store and prints confirmReceipt(seed, pending_text), byte for byte', async () => {
  const { storePath, entry } = freshShop('approve');
  const { ref, replyText } = await hold(entry);
  const row = await rowOf(storePath, ref);
  assert.equal(row?.pending_text, replyText, 'fixture: item 1 stored the pending reply under its ref');

  const fixedNowMs = (nowS() + 5) * 1000;
  const realNow = Date.now;
  let expected;
  Date.now = () => fixedNowMs;
  try { expected = confirmReceipt(SHOP_SEED, row.pending_text); } finally { Date.now = realNow; }

  // No receipt file exists anywhere: the ref alone, against the store, is enough.
  const run = runDecide([ref, 'approve', '--store', storePath], { fixedNowMs });
  assertNeverDialled(run, 'decide <ref> approve');
  assert.equal(run.code, 0, `decide <ref> approve succeeds: ${said(run)}`);
  assertNoSeed(run, 'decide <ref> approve');
  assert.equal(printed(run), expected, 'stdout is the follow-up text: exactly confirmReceipt over the stored pending_text');
  assert.equal(run.stdout.trim().split('\n').length, 1, 'one line, nothing else');
});

test('the follow-up is the shop\'s confirmed reply on the customer\'s own terms', async () => {
  const { storePath, entry } = freshShop('shape');
  const { ref, reply } = await hold(entry);
  const run = runDecide([ref, 'approve', '--store', storePath]);
  assert.equal(run.code, 0, `decide <ref> approve succeeds: ${said(run)}`);
  const follow = JSON.parse(printed(run));
  assert.equal(follow.status, 'confirmed', 'the follow-up reads confirmed');
  for (const k of ['verb', 'of', 'customer_did', 'request']) assert.equal(follow[k], reply[k], `keeps the receipt's ${k}`);
  assert.equal(follow.customer_did, CUSTOMER_DID);
  const d = follow.deal || {};
  for (const k of ['partyA', 'partyB', 'termsHash', 'contextId', 'ref', 'salt']) assert.equal(d[k], reply.deal[k], `the deal keeps ${k}`);
  assert.equal(d.partyA, SHOP_DID);
  assert.equal(d.ref, ref);
  const sigA = Buffer.from(String(d.sigA), 'base64');
  assert.ok(sigA.length === 64 && verifyBytes(Buffer.from(publicKeyHexFromDid(SHOP_DID), 'hex'), sigA, dealPayload(d)),
    'the deal\'s sigA verifies under the shop\'s key');
});

test('the decision is stored as confirmed under the ref; the rest of the row is unchanged; it leaves the undecided list', async () => {
  const { storePath, entry } = freshShop('stored');
  const a = await hold(entry);
  const b = await hold(entry, { text: 'hold item {"id":202}' });
  const before = clone(await rowOf(storePath, a.ref));
  assert.deepEqual(await undecidedRefs(storePath), [a.ref, b.ref].sort(), 'fixture: two undecided rows');

  const t0 = nowS();
  const run = runDecide([a.ref, 'approve', '--store', storePath]);
  const t1 = nowS();
  assert.equal(run.code, 0, `decide <ref> approve succeeds: ${said(run)}`);

  const after = await rowOf(storePath, a.ref);
  for (const k of ['ref', 'offer', 'partyB', 'issued_ts', 'pending_text']) {
    assert.deepEqual(after[k], before[k], `the row's ${k} is unchanged by the decision`);
  }
  const dec = after.decision;
  assert.ok(dec && typeof dec === 'object', `a decision object is stored: ${JSON.stringify(after)}`);
  assert.deepEqual(Object.keys(dec).sort(), ['decided_ts', 'status', 'text'], 'decision is {status, text, decided_ts}');
  assert.equal(dec.status, 'confirmed', 'stored as confirmed');
  assert.equal(dec.text, printed(run), 'the stored text is the text printed');
  assert.ok(Number.isSafeInteger(dec.decided_ts) && dec.decided_ts >= t0 - 1 && dec.decided_ts <= t1 + 1,
    `decided_ts is the decision time in epoch seconds: ${dec.decided_ts}`);
  assert.deepEqual(await undecidedRefs(storePath), [b.ref], 'the decided row is off the pending list; the other stays');
  assert.equal((await rowOf(storePath, b.ref)).decision, null, 'the other row is untouched');
});

test('a repeat of the same ref approve is idempotent: the same bytes, even at a later clock; the row unchanged; nothing sent', async () => {
  const { storePath, entry } = freshShop('repeat');
  const { ref } = await hold(entry);
  const first = runDecide([ref, 'approve', '--store', storePath], { fixedNowMs: (nowS() + 5) * 1000 });
  assertNeverDialled(first, 'decide approve (first)');
  assert.equal(first.code, 0, `decide <ref> approve succeeds: ${said(first)}`);
  const stored = clone(await rowOf(storePath, ref));
  const bytes = storeBytes(storePath);

  // A later clock: a fresh confirmReceipt would carry a fresh ts and sigA. The repeat prints the
  // stored decision instead, so the bytes are the first run's.
  const again = runDecide([ref, 'approve', '--store', storePath], { fixedNowMs: (nowS() + 120) * 1000 });
  assertNeverDialled(again, 'decide approve (repeat): no second send');
  assert.equal(again.code, 0, `the repeat exits 0: ${said(again)}`);
  assert.equal(again.stdout, first.stdout, 'the repeat prints the same output, byte for byte');
  assert.deepEqual(await rowOf(storePath, ref), stored, 'the stored decision is unchanged (same text, same decided_ts)');
  assert.equal(storeBytes(storePath), bytes, 'the state file is unchanged by the repeat');

  const third = runDecide([ref, 'approve', '--store', storePath]);
  assert.equal(third.code, 0, `a third repeat exits 0 too: ${said(third)}`);
  assert.equal(third.stdout, first.stdout, 'and prints the same bytes');
});

// ---------------------------------------------------------------- refusals

test('refused: an unknown ref, by name; nothing is written', async () => {
  const { storePath, entry } = freshShop('unknown');
  const { ref } = await hold(entry);
  const bytes = storeBytes(storePath);
  for (const bad of ['no-such-ref', `${ref}x`, '__proto__', 'constructor']) {
    const run = runDecide([bad, 'approve', '--store', storePath]);
    assertRefused(run, `decide ${bad} approve`, storePath, bytes);
    assert.match(run.stderr, /unknown|no receipt|not found/i, `${bad}: the refusal names the unknown ref: ${said(run)}`);
  }
  assert.deepEqual(await undecidedRefs(storePath), [ref], 'the real row is still undecided');
});

test('refused: the file form is superseded -- a receipt file where the ref goes is not a ref in the store', async () => {
  const { storePath, entry } = freshShop('fileform');
  const { ref, replyText } = await hold(entry);
  const receiptFile = join(state.project, 'hold-receipt.json');
  writeFileSync(receiptFile, replyText);
  const bytes = storeBytes(storePath);
  for (const arg of [receiptFile, 'hold-receipt.json']) {
    const run = runDecide([arg, 'approve', '--store', storePath]);
    assertRefused(run, `decide <receipt file ${arg}> approve`, storePath, bytes);
  }
  assert.equal((await rowOf(storePath, ref)).decision, null, 'the receipt the file holds stays undecided');
});

test('refused: a ref already decided with another verdict; approve does not overwrite it', async () => {
  const { storePath, entry } = freshShop('declined');
  const { ref, reply } = await hold(entry);
  // A decline stored as the design record shapes it (declineReceipt is a later chain item, so the
  // row is written through the store directly).
  const declinedText = JSON.stringify({ ...reply, status: 'declined', note: 'sold out' });
  const row = clone(await rowOf(storePath, ref));
  row.decision = { status: 'declined', text: declinedText, decided_ts: nowS() - 30 };
  await createFileStore(storePath).putReceipt(ref, row);
  const stored = clone(await rowOf(storePath, ref));
  const bytes = storeBytes(storePath);

  const run = runDecide([ref, 'approve', '--store', storePath]);
  assertRefused(run, 'decide <declined ref> approve', storePath, bytes);
  assert.match(run.stderr, /declined|already decided/i, `the refusal names the existing verdict: ${said(run)}`);
  assert.ok(!run.stdout.includes(declinedText), 'the refusal does not print the stored decline as if it were the answer');
  assert.deepEqual(await rowOf(storePath, ref), stored, 'the stored decline stands');
});

test('refused: a stored receipt another door signed; nothing is stored as confirmed', async () => {
  const { storePath, entry } = freshShop('foreign');
  await hold(entry);
  // Another door's receipt, whole and valid under that door's key, sitting in this shop's store.
  const otherPath = join(tmp('ae-decide-ref-other-'), 'state.json');
  const other = await hold(makeDoor(STRANGER_SEED, createFileStore(otherPath)));
  const otherRow = clone(await rowOf(otherPath, other.ref));
  await createFileStore(storePath).putReceipt(other.ref, otherRow);
  const bytes = storeBytes(storePath);

  const run = runDecide([other.ref, 'approve', '--store', storePath]);
  assertRefused(run, 'decide <another door\'s receipt> approve', storePath, bytes);
  assert.match(run.stderr, /not signed by this key/, `the refusal is confirmReceipt's own: ${said(run)}`);
  assert.equal((await rowOf(storePath, other.ref)).decision, null, 'nothing is stored as confirmed for it');
  assert.ok((await undecidedRefs(storePath)).includes(other.ref), 'it stays on the undecided list');
});

test('refused: a stored receipt re-signed by a stranger, or edited after signing; nothing is stored as confirmed', async () => {
  const { storePath, entry } = freshShop('edited');
  const { ref, reply } = await hold(entry);
  const base = clone(await rowOf(storePath, ref));
  const resigned = clone(reply);
  resigned.deal.partyA = didFromSeedHex(STRANGER_SEED);
  resigned.deal.sigA = signBytes(STRANGER_SEED, dealPayload(resigned.deal)).toString('base64');
  const edit = (fn) => { const v = clone(reply); fn(v); return JSON.stringify(v); };
  const cases = [
    ['resigned', JSON.stringify(resigned), /not signed by this key/],
    ['request-rewritten', edit((v) => { v.request = 'hold item {"id":999}'; }), /changed after it was signed/],
    ['termsHash-rewritten', edit((v) => { v.deal.termsHash = 'ab'.repeat(32); }), /not signed by this key/],
    ['sigA-dropped', edit((v) => { delete v.deal.sigA; }), null],
  ];
  for (const [label, text, reason] of cases) {
    await createFileStore(storePath).putReceipt(ref, { ...base, pending_text: text });
    const bytes = storeBytes(storePath);
    const run = runDecide([ref, 'approve', '--store', storePath]);
    assertRefused(run, `decide <${label}> approve`, storePath, bytes);
    if (reason) assert.match(run.stderr, reason, `${label}: the refusal is confirmReceipt's own: ${said(run)}`);
    assert.equal((await rowOf(storePath, ref)).decision, null, `${label}: nothing is stored as confirmed`);
  }
});

test('refused: the shop\'s own stored receipt under another seed is not that key\'s to approve', async () => {
  const { storePath, entry } = freshShop('wrongseed');
  const { ref } = await hold(entry);
  const bytes = storeBytes(storePath);
  const run = runDecide([ref, 'approve', '--store', storePath], { seed: CUSTOMER_SEED });
  assertRefused(run, 'decide <ref> approve under the customer\'s seed', storePath, bytes);
  assert.match(run.stderr, /not signed by this key/, `the refusal is confirmReceipt's own: ${said(run)}`);
  assert.equal((await rowOf(storePath, ref)).decision, null, 'nothing is stored as confirmed');

  const noSeed = runDecide([ref, 'approve', '--store', storePath], { seed: null });
  assertRefused(noSeed, 'decide <ref> approve with no seed', storePath, bytes);
  assert.match(noSeed.stderr, /seed/i, `the refusal names the missing seed: ${said(noSeed)}`);
});
