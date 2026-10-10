#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// `agent-entry decide <ref> approve --store <file>`: the owner's approval, built and checked locally.
//
// RE-AIMED (coordinator ruling 20261010T051833Z-b, AT-28 item 5 of 6, intake 20261010T051835Z).
// This file first pinned the file form `decide <receipt file> approve` (skeleton item 1 of the FRAME
// Answer-1 chain, parent intake 20261003T131710Z), which `decide <ref> approve --store <file>`
// superseded (83cc12d). Its still-meaningful cases are kept here, aimed at the ref form; the two
// cases about the JSON-RPC message/send envelope the file form built (and the customer's door taking
// that message in) are retired, because the ref form prints the follow-up text and builds no
// message: the customer now collects the decision with `track` instead (conformance/track.mjs,
// conformance/knock-track.mjs). conformance/decide-ref.mjs pins the ref form's own contract (the
// stored decision, idempotency, unknown refs, crossovers); this file keeps the follow-up's content
// and the receipt checks the file form pinned. Not wired into `npm test`; run it as
// `node conformance/decide.mjs`.
//
// What it pins, in a shop's project directory whose seed is AGENT_ENTRY_SEED_HEX, the store a
// createFileStore state file the shop's door wrote when it answered a hold:
//   - `decide <ref> approve --store <file>` exits 0 and prints the follow-on reply: the shop's
//     confirmed reply on the customer's own terms, its deal chained to the hold's termsHash with a
//     fresh ts and a sigA by the shop's key;
//   - that follow-on is the one Woo-5's exported confirmReceipt(seedHex, receiptText) returns
//     (landed 2887644): byte for byte at one fixed clock, and the source calls it;
//   - the customer's side accepts it: the customer's own knock, `track` on that ref at the shop's
//     door, verifies the answer as signed by the shop and checkedBookingReceipt reads it as its
//     booking, status confirmed, on the receipt's termsHash.
// Refusals (exit 1, nothing on stdout, the state file unchanged, the seed never printed):
//   - a stored receipt this shop's key did not sign (another key's, self-consistent under that key;
//     the shop's, re-signed by a stranger), the right one under another seed, or no seed at all;
//   - a stored receipt whose pending text is already a confirmed reply (decide's own follow-on);
//   - a stored receipt edited after it was signed: its terms or its deal changed.
// THE DECISION NEVER DIALS: every child runs with fixtures/cli/no-dial.mjs preloaded, which refuses
// and records every socket, fetch, DNS question, UDP socket and WebSocket, loopback included.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const {
  AGENT_CARD_PATH, canonicalBytes, confirmReceipt, createAgentEntry, createFileStore, didFromSeedHex,
  knockAgentEntry, publicKeyHexFromDid, signBytes, signEnvelope, verifyBytes,
} = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'muretai-agent-entry.mjs');
const NO_DIAL = pathToFileURL(join(HERE, 'fixtures', 'cli', 'no-dial.mjs')).href;
const FIXED_CLOCK = pathToFileURL(join(HERE, 'fixtures', 'cli', 'fixed-clock.mjs')).href;

const SHOP_SEED = '5a'.repeat(32);
const CUSTOMER_SEED = '6c'.repeat(32);
const STRANGER_SEED = '7e'.repeat(32);
const SHOP_DID = didFromSeedHex(SHOP_SEED);
const CUSTOMER_DID = didFromSeedHex(CUSTOMER_SEED);
const SHOP_BASE = 'https://shop.example';
const HOLD_TEXT = 'hold item {"id":101}';

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
const clone = (v) => JSON.parse(JSON.stringify(v));
const nowS = () => Math.floor(Date.now() / 1000);
const dealPayload = (d) => canonicalBytes({ type: d.type, partyA: d.partyA, partyB: d.partyB, termsHash: d.termsHash,
  contextId: d.contextId, ref: d.ref, ts: d.ts });

// ---------------------------------------------------------------- the shop's door and its store

function makeDoor(seed, store) {
  return createAgentEntry({ seedHex: seed, name: DECLARATION.entry.name, baseUrl: SHOP_BASE,
    declaration: clone(DECLARATION), signedRatePerMin: 0, signedRatePerMinTotal: 0, store });
}

/** A fresh state file in the project directory, and the shop's door writing into it. */
function freshShop(name) {
  const storePath = join(state.project, `${name}.state.json`);
  return { storePath, entry: makeDoor(SHOP_SEED, createFileStore(storePath)) };
}

/** A door answering in process, as a fetch (the knock's own fetchImpl). */
const fetchVia = (entry) => async (url, init = {}) => {
  const u = new URL(url);
  const out = await entry.handleRequestAsync(init.method || 'GET', u.pathname + u.search, init.headers || {},
    Buffer.from(init.body || ''), { remoteAddress: '127.0.0.1' });
  return new Response(out.body, { status: out.status, headers: out.headers });
};

let sequence = 0;
/** One signed `hold` knock by `seed` at `entry`, in process: the pending reply and its ref. */
async function hold(entry, seed = CUSTOMER_SEED, text = HOLD_TEXT) {
  const from = didFromSeedHex(seed);
  const messageId = `decide-hold-${++sequence}`;
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
  return { ref: reply.deal.ref, replyText, reply };
}

const rowOf = (storePath, ref) => createFileStore(storePath).getReceipt(ref);
const storeBytes = (storePath) => readFileSync(storePath, 'utf8');

/** Put `pendingText` on `ref`'s row in place of what the door stored, still undecided. */
async function replacePending(storePath, ref, pendingText) {
  const row = clone(await rowOf(storePath, ref));
  await createFileStore(storePath).putReceipt(ref, { ...row, pending_text: pendingText, decision: null });
}

// ---------------------------------------------------------------- the CLI child

/** Run `decide` in the project with no-dial (and, when `fixedNowMs` is given, the fixed clock) preloaded. */
function runDecide(args, { seed = SHOP_SEED, fixedNowMs = null } = {}) {
  const log = join(tmp('ae-decide-dial-'), 'dial.jsonl');
  const env = { HOME: state.home, AE_NO_DIAL_LOG: log };
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k];
  if (seed !== null) env.AGENT_ENTRY_SEED_HEX = seed;
  if (fixedNowMs !== null) env.AE_FIXED_NOW_MS = String(fixedNowMs);
  const imports = ['--import', NO_DIAL, ...(fixedNowMs !== null ? ['--import', FIXED_CLOCK] : [])];
  const run = spawnSync(process.execPath, [...imports, BIN, 'decide', ...args], { cwd: state.project, env, encoding: 'utf8', timeout: 60000 });
  let dial = [];
  try { dial = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
  return { code: run.status, stdout: run.stdout || '', stderr: run.stderr || '', timedOut: run.error?.code === 'ETIMEDOUT', dial };
}

const approve = (ref, storePath, opts) => runDecide([ref, 'approve', '--store', storePath], opts);

const said = (run) => `exit ${run.code}; stdout ${JSON.stringify(run.stdout.slice(0, 400))}; stderr ${JSON.stringify(run.stderr.slice(0, 400))}`;

/** Every child: finished, the guard loaded, and nothing dialled -- not even this machine. */
function assertNeverDialled(run, what) {
  assert.ok(!run.timedOut, `${what}: timed out`);
  assert.ok(run.dial.some((r) => r.kind === 'loaded'), `${what}: the no-dial guard did not load`);
  assert.deepEqual(run.dial.filter((r) => r.kind !== 'loaded'), [], `${what}: tried to reach the network`);
}

/** A refusal: exit 1, nothing on stdout, the seed never printed, nothing dialled, the store unchanged. */
function assertRefused(run, what, storePath, bytesBefore) {
  assertNeverDialled(run, what);
  assert.equal(run.code, 1, `${what} is refused: ${said(run)}`);
  assert.equal(run.stdout.trim(), '', `${what}: a refusal prints no follow-up: ${said(run)}`);
  for (const s of [SHOP_SEED, CUSTOMER_SEED, STRANGER_SEED]) {
    assert.ok(!`${run.stdout}${run.stderr}`.includes(s), `${what}: a seed is never printed`);
  }
  assert.equal(storeBytes(storePath), bytesBefore, `${what}: nothing is written to the store`);
}

/** The follow-up decide printed: exactly one line. */
function printed(run) {
  const lines = run.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `decide approve prints exactly one line: ${said(run)}`);
  return lines[0];
}

before(() => {
  state.home = tmp('ae-decide-home-');
  state.project = tmp('ae-decide-shop-');
  writeFileSync(join(state.project, 'agent-entry.json'), `${JSON.stringify(DECLARATION, null, 2)}\n`);
});

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- functional

test('decide <ref> approve prints the follow-on: the shop\'s confirmed reply, chained to the hold\'s termsHash, signed by the shop', async () => {
  const { storePath, entry } = freshShop('follow-on');
  const h = await hold(entry);
  const run = approve(h.ref, storePath);
  assertNeverDialled(run, 'decide <ref> approve');
  assert.equal(run.code, 0, `decide <ref> approve succeeds: ${said(run)}`);
  assert.ok(!`${run.stdout}${run.stderr}`.includes(SHOP_SEED), 'the seed is never printed');
  const follow = JSON.parse(printed(run));
  assert.equal(follow.status, 'confirmed', 'the follow-on reads confirmed');
  for (const k of ['verb', 'of', 'customer_did', 'request']) assert.equal(follow[k], h.reply[k], `the follow-on keeps the receipt's ${k}`);
  assert.equal(follow.customer_did, CUSTOMER_DID, 'addressed to the customer the receipt names');
  const d = follow.deal || {};
  assert.equal(d.type, 'DealReceipt');
  assert.equal(d.termsHash, h.reply.deal.termsHash, 'the deal chains to the original receipt\'s termsHash');
  for (const k of ['partyA', 'partyB', 'contextId', 'ref', 'salt']) assert.equal(d[k], h.reply.deal[k], `the deal keeps the receipt's ${k}`);
  assert.ok(Number.isSafeInteger(d.ts) && d.ts >= h.reply.deal.ts, 'a fresh ts, never before the hold\'s');
  const sigA = Buffer.from(String(d.sigA), 'base64');
  assert.ok(sigA.length === 64 && verifyBytes(Buffer.from(publicKeyHexFromDid(SHOP_DID), 'hex'), sigA, dealPayload(d)),
    'the deal\'s sigA verifies under the shop\'s key');
});

test('decide <ref> approve emits the follow-on confirmReceipt returns: byte for byte at one fixed clock', async () => {
  assert.equal(typeof confirmReceipt, 'function', 'confirmReceipt (Woo-5, landed 2887644) is exported');
  const { storePath, entry } = freshShop('fixed-clock');
  const h = await hold(entry);
  const fixedNowMs = (nowS() + 5) * 1000;
  const realNow = Date.now;
  let expected;
  Date.now = () => fixedNowMs;
  try { expected = confirmReceipt(SHOP_SEED, h.replyText); } finally { Date.now = realNow; }

  const run = approve(h.ref, storePath, { fixedNowMs });
  assertNeverDialled(run, 'decide <ref> approve (fixed clock)');
  assert.equal(run.code, 0, `decide <ref> approve succeeds: ${said(run)}`);
  assert.equal(printed(run), expected, 'the follow-on is exactly confirmReceipt(seed, the stored pending text)');
});

test('decide approve is built on confirmReceipt: the CLI calls it rather than signing a deal of its own', () => {
  const source = readFileSync(BIN, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const calls = source.match(/(?<!function\s)\bconfirmReceipt\s*\(/g) || [];
  assert.ok(calls.length >= 1, 'muretai-agent-entry.mjs calls confirmReceipt( outside its own definition');
  assert.match(source, /\bdecide\b/, 'the CLI knows the verb decide');
});

test('the customer collects it: track on that ref at the shop\'s door, verified as the shop\'s, read as its booking, confirmed, on the receipt\'s termsHash', async () => {
  const { storePath, entry } = freshShop('collect');
  const h = await hold(entry);
  const run = approve(h.ref, storePath);
  assert.equal(run.code, 0, `decide <ref> approve succeeds: ${said(run)}`);
  const keyPath = join(tmp('ae-decide-knock-'), 'knock-seed');
  writeFileSync(keyPath, `${CUSTOMER_SEED}\n`, { mode: 0o600 });
  const result = await knockAgentEntry(`${SHOP_BASE}${AGENT_CARD_PATH}`,
    { keyPath, text: JSON.stringify({ ref: h.ref }), offer: 'track', fetchImpl: fetchVia(entry) });
  assert.ok(result.ok, `the customer's knock verifies the shop's answer: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(result.doorDid, SHOP_DID, 'signed by the shop\'s door key');
  assert.equal(result.reply?.result?.parts?.[0]?.text, printed(run), 'the shop answers with the follow-on decide printed');
  assert.ok(result.booking, `checkedBookingReceipt reads a booking: ${String(result.text).slice(0, 300)}`);
  assert.equal(result.booking.customer_did, CUSTOMER_DID, 'filed under the customer');
  assert.equal(result.booking.status, 'confirmed', 'the booking reads confirmed');
  assert.equal(result.booking.deal?.termsHash, h.reply.deal.termsHash, 'on the receipt\'s termsHash');
});

// ---------------------------------------------------------------- refusals

test('refused: a stored receipt this shop\'s key did not sign', async () => {
  const { storePath, entry } = freshShop('foreign');
  const own = await hold(entry);

  // Another door's receipt, whole and self-consistent under that door's key, in this shop's store.
  const otherPath = join(tmp('ae-decide-other-'), 'state.json');
  const other = await hold(makeDoor(STRANGER_SEED, createFileStore(otherPath)));
  await createFileStore(storePath).putReceipt(other.ref, clone(await rowOf(otherPath, other.ref)));
  let bytes = storeBytes(storePath);
  const run = approve(other.ref, storePath);
  assertRefused(run, 'decide <another door\'s receipt> approve', storePath, bytes);
  assert.match(run.stderr, /not signed by this key/, `the refusal is confirmReceipt's own: ${said(run)}`);

  // This shop's receipt, re-signed by a stranger who put its own DID in partyA.
  const foreign = clone(own.reply);
  foreign.deal.partyA = didFromSeedHex(STRANGER_SEED);
  foreign.deal.sigA = signBytes(STRANGER_SEED, dealPayload(foreign.deal)).toString('base64');
  await replacePending(storePath, own.ref, JSON.stringify(foreign));
  bytes = storeBytes(storePath);
  const run2 = approve(own.ref, storePath);
  assertRefused(run2, 'decide <re-signed by a stranger> approve', storePath, bytes);
  assert.match(run2.stderr, /not signed by this key/, `the refusal is confirmReceipt's own: ${said(run2)}`);

  // The right receipt, but the seed is the customer's: it is not this key's to approve.
  await replacePending(storePath, own.ref, own.replyText);
  bytes = storeBytes(storePath);
  const run3 = approve(own.ref, storePath, { seed: CUSTOMER_SEED });
  assertRefused(run3, 'decide <ref> approve under the customer\'s seed', storePath, bytes);
});

test('refused: no seed in the project or the environment, so nothing can be signed', async () => {
  const { storePath, entry } = freshShop('no-seed');
  const h = await hold(entry);
  const bytes = storeBytes(storePath);
  const run = approve(h.ref, storePath, { seed: null });
  assertRefused(run, 'decide <ref> approve <no seed>', storePath, bytes);
  assert.match(run.stderr, /seed/i, `the refusal names the missing seed: ${said(run)}`);
});

test('refused: a stored receipt whose pending text is already a confirmed reply', async () => {
  const { storePath, entry } = freshShop('already');
  const h = await hold(entry);
  const confirmed = confirmReceipt(SHOP_SEED, h.replyText);
  assert.equal(JSON.parse(confirmed).status, 'confirmed');
  await replacePending(storePath, h.ref, confirmed);
  const bytes = storeBytes(storePath);
  const run = approve(h.ref, storePath);
  assertRefused(run, 'decide <a confirmed reply stored as pending> approve', storePath, bytes);
  assert.match(run.stderr, /confirm|pending/i, `the refusal says the receipt is not pending: ${said(run)}`);

  // decide's own output, put back as the pending text, is not a pending receipt either.
  const { storePath: p2, entry: e2 } = freshShop('own-output');
  const h2 = await hold(e2);
  const first = approve(h2.ref, p2);
  assert.equal(first.code, 0, `decide <ref> approve succeeds: ${said(first)}`);
  await replacePending(p2, h2.ref, printed(first));
  const bytes2 = storeBytes(p2);
  const run2 = approve(h2.ref, p2);
  assertRefused(run2, 'decide <its own follow-on stored as pending> approve', p2, bytes2);
});

test('refused: a stored receipt edited after it was signed', async () => {
  const { storePath, entry } = freshShop('edited');
  const h = await hold(entry);
  const edit = (fn) => { const v = clone(h.reply); fn(v); return JSON.stringify(v); };
  const cases = [
    ['request-rewritten', edit((v) => { v.request = 'hold item {"id":999}'; }), /changed after it was signed/],
    ['status-set-confirmed', edit((v) => { v.status = 'confirmed'; }), null],
    ['customer-rewritten', edit((v) => { v.customer_did = didFromSeedHex(STRANGER_SEED); }), null],
    ['termsHash-rewritten', edit((v) => { v.deal.termsHash = 'ab'.repeat(32); }), /not signed by this key/],
    ['partyB-rewritten', edit((v) => { v.deal.partyB = didFromSeedHex(STRANGER_SEED); }), /not signed by this key/],
    ['ts-rewritten', edit((v) => { v.deal.ts -= 60; }), /not signed by this key/],
    ['key-added', edit((v) => { v.confirmed = true; }), null],
    ['sigA-dropped', edit((v) => { delete v.deal.sigA; }), null],
    ['no-deal', edit((v) => { delete v.deal; }), null],
    ['not-json', h.replyText.slice(0, -1), null],
  ];
  for (const [label, text, reason] of cases) {
    await replacePending(storePath, h.ref, text);
    const bytes = storeBytes(storePath);
    const run = approve(h.ref, storePath);
    assertRefused(run, `decide <${label}> approve`, storePath, bytes);
    if (reason) assert.match(run.stderr, reason, `${label}: the refusal is confirmReceipt's own: ${said(run)}`);
    assert.equal((await rowOf(storePath, h.ref)).decision, null, `${label}: nothing is stored as confirmed`);
  }
});
