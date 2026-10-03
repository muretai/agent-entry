#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// `agent-entry decide <receipt file> approve`: the owner's approval, built and checked locally.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). Skeleton item 1 of the FRAME Answer-1 chain:
// parent intake 20261003T131710Z (`decide <receipt> approve|decline` sends the signed follow-up to the
// customer's DID through message/send, the deal receipt updated, idempotent by receipt id), split
// filed 20261003T132912Z. This item adds the BUILD only: nothing is sent, so `--to <card url>` is not
// pinned here (conformance/frame.mjs step 5 pins the send). The implementer may not edit this file.
// It is not wired into `npm test` until it is green; run it as `node conformance/decide.mjs`.
//
// What it pins, run in a shop's project directory whose seed is AGENT_ENTRY_SEED_HEX:
//   - `decide <receipt file> approve` exits 0 and prints exactly one JSON document on stdout: the
//     JSON-RPC `message/send` request carrying the follow-up, a message signed by the shop's door key
//     (metadata.from) to the customer the receipt names (metadata.to = customer_did = deal.partyB),
//     whose one text part is the follow-on reply.
//   - That follow-on is the one Woo-5's exported confirmReceipt(seedHex, receiptText) returns (landed
//     2887644): decide builds on it and does not sign the deal itself. At one fixed clock the text is
//     byte for byte confirmReceipt's (Ed25519 is deterministic), and the source calls it.
//   - The customer's side accepts it: the customer's own door verifies the message as signed by the
//     shop, and the customer's knock (checkedBookingReceipt) reads it as its booking, status
//     confirmed, on the receipt's termsHash.
// Refusals (exit 1, nothing on stdout, the seed never printed):
//   - a receipt this shop's key did not sign (another key's, self-consistent under that key), or no
//     seed at all;
//   - a receipt that is already confirmed;
//   - an edited receipt: its terms or its deal changed after it was signed.
// THE BUILD NEVER DIALS: every child runs with fixtures/cli/no-dial.mjs preloaded, which refuses and
// records every socket, fetch, DNS question, UDP socket and WebSocket, loopback included; a decide
// that tried any of them, on success or on refusal, is red.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const {
  AGENT_CARD_PATH, canonicalBytes, confirmReceipt, createAgentEntry, didFromSeedHex, knockAgentEntry,
  publicKeyHexFromDid, signBytes, signEnvelope, verifyBytes, verifyEnvelope,
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

const state = { shop: null, project: null, receiptText: null, receipt: null, receiptFile: null, home: null };

// ---------------------------------------------------------------- the shop's door, in process

/** A door answering in process, as a fetch (the knock's own fetchImpl). */
const fetchVia = (entry) => async (url, init = {}) => {
  const u = new URL(url);
  const out = await entry.handleRequestAsync(init.method || 'GET', u.pathname + u.search, init.headers || {},
    Buffer.from(init.body || ''), { remoteAddress: '127.0.0.1' });
  return new Response(out.body, { status: out.status, headers: out.headers });
};

let sequence = 0;
/** One signed `hold` knock by `seed` at `entry`, in process: the reply text exactly as the door signed it. */
async function holdReceipt(entry, seed, text = HOLD_TEXT) {
  const from = didFromSeedHex(seed);
  const messageId = `decide-hold-${++sequence}`;
  const timestamp = Math.floor(Date.now() / 1000);
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
  return { replyText, reply };
}

// ---------------------------------------------------------------- the CLI child

/** Run `decide` in `cwd` with no-dial (and, when `fixedNowMs` is given, the fixed clock) preloaded. */
function runDecide(args, { cwd = state.project, seed = SHOP_SEED, fixedNowMs = null } = {}) {
  const log = join(tmp('ae-decide-dial-'), 'dial.jsonl');
  const env = { HOME: state.home, AE_NO_DIAL_LOG: log };
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k];
  if (seed !== null) env.AGENT_ENTRY_SEED_HEX = seed;
  if (fixedNowMs !== null) env.AE_FIXED_NOW_MS = String(fixedNowMs);
  const imports = ['--import', NO_DIAL, ...(fixedNowMs !== null ? ['--import', FIXED_CLOCK] : [])];
  const run = spawnSync(process.execPath, [...imports, BIN, 'decide', ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
  let dial = [];
  try { dial = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
  return { code: run.status, stdout: run.stdout || '', stderr: run.stderr || '', timedOut: run.error?.code === 'ETIMEDOUT', dial };
}

const said = (run) => `exit ${run.code}; stdout ${JSON.stringify(run.stdout.slice(0, 400))}; stderr ${JSON.stringify(run.stderr.slice(0, 400))}`;

/** Every child: finished, the guard loaded, and nothing dialled -- not even this machine. */
function assertNeverDialled(run, what) {
  assert.ok(!run.timedOut, `${what}: timed out`);
  assert.ok(run.dial.some((r) => r.kind === 'loaded'), `${what}: the no-dial guard did not load`);
  assert.deepEqual(run.dial.filter((r) => r.kind !== 'loaded'), [], `${what}: tried to reach the network`);
}

/** A refusal: exit 1, nothing built on stdout, the seed never printed, nothing dialled. */
function assertRefused(run, what) {
  assertNeverDialled(run, what);
  assert.equal(run.code, 1, `${what} is refused: ${said(run)}`);
  assert.equal(run.stdout.trim(), '', `${what}: a refusal builds nothing: ${said(run)}`);
  assert.ok(!`${run.stdout}${run.stderr}`.includes(SHOP_SEED), `${what}: the seed is never printed`);
}

function writeReceipt(name, text) {
  const path = join(state.project, name);
  writeFileSync(path, text);
  return path;
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const dealPayload = (d) => canonicalBytes({ type: d.type, partyA: d.partyA, partyB: d.partyB, termsHash: d.termsHash,
  contextId: d.contextId, ref: d.ref, ts: d.ts });

/** The one JSON document decide printed, and the message/send it is. */
function builtMessage(run) {
  const lines = run.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `decide approve prints exactly one JSON document: ${said(run)}`);
  const doc = JSON.parse(lines[0]);
  assert.equal(doc.jsonrpc, '2.0', 'a JSON-RPC 2.0 request');
  assert.equal(doc.method, 'message/send', 'the follow-up is a message/send');
  const message = doc.params?.message;
  assert.ok(message && typeof message === 'object', `params.message: ${lines[0].slice(0, 300)}`);
  assert.equal(message.kind, 'message');
  assert.ok(Array.isArray(message.parts) && message.parts.length === 1 && message.parts[0].kind === 'text',
    `one text part: ${JSON.stringify(message.parts).slice(0, 300)}`);
  return { doc, message, text: message.parts[0].text, body: lines[0] };
}

before(async () => {
  state.home = tmp('ae-decide-home-');
  state.project = tmp('ae-decide-shop-');
  writeFileSync(join(state.project, 'agent-entry.json'), `${JSON.stringify(DECLARATION, null, 2)}\n`);
  state.shop = createAgentEntry({ seedHex: SHOP_SEED, name: DECLARATION.entry.name, baseUrl: SHOP_BASE, declaration: DECLARATION });
  assert.equal(state.shop.did, SHOP_DID);
  const { replyText, reply } = await holdReceipt(state.shop, CUSTOMER_SEED);
  state.receiptText = replyText;
  state.receipt = reply;
  state.receiptFile = writeReceipt('hold-receipt.json', replyText);
});

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- functional

test('decide <receipt> approve builds the signed message/send follow-up: the shop to the customer, confirmed, the same termsHash', () => {
  const run = runDecide([state.receiptFile, 'approve']);
  assertNeverDialled(run, 'decide approve');
  assert.equal(run.code, 0, `decide <receipt> approve succeeds with no --to: ${said(run)}`);
  assert.ok(!`${run.stdout}${run.stderr}`.includes(SHOP_SEED), 'the seed is never printed');
  const { message, text } = builtMessage(run);

  const meta = message.metadata || {};
  assert.equal(meta.from, SHOP_DID, 'signed as the shop\'s door key');
  assert.equal(meta.to, CUSTOMER_DID, 'addressed to the customer the receipt names');
  const fields = { from: meta.from, to: meta.to, messageId: message.messageId, contextId: message.contextId ?? null,
    timestamp: meta.timestamp, text, sig: meta.sig };
  assert.ok(verifyEnvelope(fields, { recipientDid: CUSTOMER_DID }), 'the message envelope verifies for the customer, signed by the shop');

  const follow = JSON.parse(text);
  const hold = state.receipt;
  assert.equal(follow.status, 'confirmed', 'the follow-on reads confirmed');
  for (const k of ['verb', 'of', 'customer_did', 'request']) assert.equal(follow[k], hold[k], `the follow-on keeps the receipt's ${k}`);
  const d = follow.deal || {};
  assert.equal(d.type, 'DealReceipt');
  assert.equal(d.termsHash, hold.deal.termsHash, 'the deal chains to the original receipt\'s termsHash');
  for (const k of ['partyA', 'partyB', 'contextId', 'ref', 'salt']) assert.equal(d[k], hold.deal[k], `the deal keeps the receipt's ${k}`);
  assert.ok(Number.isSafeInteger(d.ts) && d.ts >= hold.deal.ts, 'a fresh ts, never before the hold\'s');
  const sigA = Buffer.from(String(d.sigA), 'base64');
  assert.ok(sigA.length === 64 && verifyBytes(Buffer.from(publicKeyHexFromDid(SHOP_DID), 'hex'), sigA, dealPayload(d)),
    'the deal\'s sigA verifies under the shop\'s key');
});

test('decide approve emits the follow-on confirmReceipt returns: byte for byte at one fixed clock', () => {
  assert.equal(typeof confirmReceipt, 'function', 'confirmReceipt (Woo-5, landed 2887644) is exported');
  const fixedNowMs = (Math.floor(Date.now() / 1000) + 5) * 1000;
  const realNow = Date.now;
  let expected;
  Date.now = () => fixedNowMs;
  try { expected = confirmReceipt(SHOP_SEED, state.receiptText); } finally { Date.now = realNow; }

  const run = runDecide([state.receiptFile, 'approve'], { fixedNowMs });
  assertNeverDialled(run, 'decide approve (fixed clock)');
  assert.equal(run.code, 0, `decide <receipt> approve succeeds: ${said(run)}`);
  const { text } = builtMessage(run);
  assert.equal(text, expected, 'the text decide sends is exactly confirmReceipt(seed, receipt text)');
});

test('decide approve is built on confirmReceipt: the CLI calls it rather than signing a deal of its own', () => {
  const source = readFileSync(BIN, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const calls = source.match(/(?<!function\s)\bconfirmReceipt\s*\(/g) || [];
  assert.ok(calls.length >= 1, 'muretai-agent-entry.mjs calls confirmReceipt( outside its own definition');
  assert.match(source, /\bdecide\b/, 'the CLI knows the verb decide');
});

test('the customer\'s door accepts the follow-up as a message signed by the shop', async () => {
  const run = runDecide([state.receiptFile, 'approve']);
  assertNeverDialled(run, 'decide approve');
  assert.equal(run.code, 0, `decide <receipt> approve succeeds: ${said(run)}`);
  const { body, text } = builtMessage(run);
  const inbox = [];
  const customer = createAgentEntry({ seedHex: CUSTOMER_SEED, name: 'The customer', baseUrl: 'https://customer.example',
    responder: (env) => { inbox.push(env); return 'received'; } });
  const out = await customer.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, Buffer.from(body),
    { remoteAddress: '127.0.0.1' });
  assert.equal(out.status, 200, `the customer's door answers the message/send: ${Buffer.from(out.body).toString('utf8').slice(0, 300)}`);
  assert.equal(inbox.length, 1, 'the customer\'s door took the follow-up in');
  assert.equal(inbox[0].verified, true, 'a verified signed message');
  assert.equal(inbox[0].peer_did, SHOP_DID, 'from the shop\'s door key');
  assert.equal(inbox[0].text, text, 'carrying the follow-on as built');
});

test('the customer\'s checkedBookingReceipt reads the follow-up as its booking: confirmed, on the receipt\'s termsHash', async () => {
  const run = runDecide([state.receiptFile, 'approve']);
  assertNeverDialled(run, 'decide approve');
  assert.equal(run.code, 0, `decide <receipt> approve succeeds: ${said(run)}`);
  const { doc, message } = builtMessage(run);
  // The customer's knock, answered by the shop's own card and, for its POST, with the built message as
  // the reply: knockAgentEntry verifies it (from the card's DID, to the customer) and hands the text to
  // checkedBookingReceipt.
  const viaShop = fetchVia(state.shop);
  const fetchImpl = async (url, init = {}) => ((init.method || 'GET') === 'POST'
    ? new Response(JSON.stringify({ jsonrpc: '2.0', id: doc.id ?? message.messageId, result: message }),
      { status: 200, headers: { 'content-type': 'application/json' } })
    : viaShop(url, init));
  const keyPath = join(tmp('ae-decide-knock-'), 'knock-seed');
  writeFileSync(keyPath, `${CUSTOMER_SEED}\n`, { mode: 0o600 });
  const result = await knockAgentEntry(`${SHOP_BASE}${AGENT_CARD_PATH}`, { keyPath, text: HOLD_TEXT, offer: 'hold', fetchImpl });
  assert.ok(result.ok, `the customer's knock verifies the follow-up: ${JSON.stringify(result).slice(0, 300)}`);
  assert.ok(result.booking, `checkedBookingReceipt reads a booking: ${String(result.text).slice(0, 300)}`);
  assert.equal(result.booking.customer_did, CUSTOMER_DID, 'filed under the customer');
  assert.equal(result.booking.status, 'confirmed', 'the booking reads confirmed');
  assert.equal(result.booking.deal?.termsHash, state.receipt.deal.termsHash, 'on the receipt\'s termsHash');
});

// ---------------------------------------------------------------- refusals

test('refused: a receipt this shop\'s key did not sign', async () => {
  // Another door's receipt, whole and self-consistent under that door's key.
  const strangerDoor = createAgentEntry({ seedHex: STRANGER_SEED, name: 'Another shop', baseUrl: 'https://other.example', declaration: DECLARATION });
  const { replyText } = await holdReceipt(strangerDoor, CUSTOMER_SEED);
  const run = runDecide([writeReceipt('hold-receipt-another-door.json', replyText), 'approve']);
  assertRefused(run, 'decide approve <another door\'s receipt>');
  assert.match(run.stderr, /not signed by this key/, `the refusal is confirmReceipt's own: ${said(run)}`);

  // This shop's receipt, re-signed by a stranger who put its own DID in partyA.
  const foreign = clone(state.receipt);
  foreign.deal.partyA = didFromSeedHex(STRANGER_SEED);
  foreign.deal.sigA = signBytes(STRANGER_SEED, dealPayload(foreign.deal)).toString('base64');
  const run2 = runDecide([writeReceipt('hold-receipt-resigned.json', JSON.stringify(foreign)), 'approve']);
  assertRefused(run2, 'decide approve <re-signed by a stranger>');
  assert.match(run2.stderr, /not signed by this key/, `the refusal is confirmReceipt's own: ${said(run2)}`);

  // The right receipt, but the project's seed is the customer's: it is not this key's to approve.
  const run3 = runDecide([state.receiptFile, 'approve'], { seed: CUSTOMER_SEED });
  assertRefused(run3, 'decide approve <under the customer\'s seed>');
  assert.ok(!`${run3.stdout}${run3.stderr}`.includes(CUSTOMER_SEED), 'that seed is never printed either');
});

test('refused: no seed in the project or the environment, so nothing can be signed', () => {
  const run = runDecide([state.receiptFile, 'approve'], { seed: null });
  assertRefused(run, 'decide approve <no seed>');
  assert.match(run.stderr, /seed/i, `the refusal names the missing seed: ${said(run)}`);
});

test('refused: a receipt that has already been confirmed', () => {
  const confirmed = confirmReceipt(SHOP_SEED, state.receiptText);
  assert.equal(JSON.parse(confirmed).status, 'confirmed');
  const run = runDecide([writeReceipt('hold-receipt-confirmed.json', confirmed), 'approve']);
  assertRefused(run, 'decide approve <an already confirmed receipt>');
  assert.match(run.stderr, /confirm|pending/i, `the refusal says the receipt is not pending: ${said(run)}`);

  // decide's own output, fed back as the receipt, is not a pending receipt either.
  const first = runDecide([state.receiptFile, 'approve']);
  assert.equal(first.code, 0, `decide <receipt> approve succeeds: ${said(first)}`);
  const run2 = runDecide([writeReceipt('hold-receipt-built.json', builtMessage(first).text), 'approve']);
  assertRefused(run2, 'decide approve <its own follow-on>');
});

test('refused: an edited receipt, its content no longer what was signed', () => {
  const edit = (fn) => { const v = clone(state.receipt); fn(v); return JSON.stringify(v); };
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
    ['not-json', `${state.receiptText.slice(0, -1)}`, null],
  ];
  for (const [label, text, reason] of cases) {
    const run = runDecide([writeReceipt(`hold-receipt-${label}.json`, text), 'approve']);
    assertRefused(run, `decide approve <${label}>`);
    if (reason) assert.match(run.stderr, reason, `${label}: the refusal is confirmReceipt's own: ${said(run)}`);
  }
});
