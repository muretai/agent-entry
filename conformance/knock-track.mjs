#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// `agent-entry knock <card-url> --offer track --ref <ref>`: the customer collects the shop's decision.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). AT-28 skeleton item 5 of 6 (intake
// 20261010T051835Z) of the parent design record 20261004T022919Z, section "Collecting it". Items 2-4
// (decide <ref> approve 83cc12d, declineReceipt 34462ef, the door's track answer 263c995) are on main
// and pinned by conformance/decide-ref.mjs, conformance/decline.mjs and conformance/track.mjs; they
// are used here, not re-pinned. conformance/frame.mjs frame 5 is the end-to-end pin. The implementer
// may not edit this file. It is not wired into `npm test` until it is green; run it as
// `node conformance/knock-track.mjs`.
//
// The shop's door answers on 127.0.0.1 over http, in this process; its receipts are the rows it wrote
// itself when the customer held (the memory store), with decisions put on them through putReceipt as
// confirmReceipt and declineReceipt build them. Every knock is the bin, run as a child with
// fixtures/cli/loopback-only.mjs preloaded, and AGENT_ENTRY_KNOCK_TEXT set to an unrelated text so
// that a knock which ignores --ref is seen.
//
// What it pins:
//   - `knock <card> --offer track --ref <ref>` sends ONE signed message/send, metadata.offer "track",
//     whose text carries exactly {"ref": "<ref>"} (plain words before the JSON allowed), and prints
//     the decision the door returns for that ref: confirmed, declined (with the shop's note), or the
//     track shape still pending_confirmation -- each printed as that decision, never as confirmed;
//   - checkedBookingReceipt recognises the printed decision: the confirmed and declined ones keep the
//     hold's termsHash, partyA the shop, sigA verifying.
// Refusals:
//   - `--offer track` with no `--ref` (even with a knock text that carries a ref), `--ref` with no
//     value or an empty one, `--ref` twice, `--ref` beside an offer other than track: misuse, exit 2,
//     nothing sent, nothing on stdout;
//   - an unknown ref (prototype keys included), another customer's ref, a malformed ref: exit 1 (or
//     misuse before sending), nothing on stdout, no decision text anywhere in the output;
//   - a decision whose signature or terms do not check out (a broken sigA, partyA re-signed by a
//     stranger, terms edited after signing, a termsHash re-signed by the shop over other terms, a
//     decided status with no deal at all): the door answers it verbatim, and checkedBookingReceipt
//     refuses it -- the bin exits 1 with nothing on stdout, and the library knock does not report it
//     as a booking.
// Fixtures only: nothing here dials out; no .pem is written.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const {
  AGENT_CARD_PATH, canonicalBytes, confirmReceipt, createAgentEntry, createMemoryStore, declineReceipt,
  didFromSeedHex, knockAgentEntry, publicKeyHexFromDid, signBytes, signEnvelope, verifyBytes,
} = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'muretai-agent-entry.mjs');
const GUARD = pathToFileURL(join(HERE, 'fixtures', 'cli', 'loopback-only.mjs')).href;

const DOOR_SEED = 'b8'.repeat(32);
const CUSTOMER_SEED = '4e'.repeat(32);
const STRANGER_SEED = '5f'.repeat(32);
const CUSTOMER = didFromSeedHex(CUSTOMER_SEED);
const STRANGER = didFromSeedHex(STRANGER_SEED);
const DECLINE_NOTE = 'Sorry, that lamp sold this morning.';
const UNRELATED_TEXT = 'hold item {"id":999}';

const DECLARATION = {
  v: 1,
  entry: { name: 'Harbor Lamp', baseUrl: 'http://127.0.0.1' },
  offers: [
    { verb: 'hold', of: 'item', about: 'Hold one item for pickup; the shop confirms it.',
      input: { id: 'integer' }, door: { reply: 'pending' } },
  ],
};

const scratch = [];
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const nowS = () => Math.floor(Date.now() / 1000);
const dealPayload = (d) => canonicalBytes({ type: d.type, partyA: d.partyA, partyB: d.partyB, termsHash: d.termsHash,
  contextId: d.contextId, ref: d.ref, ts: d.ts });

const state = { server: null, origin: null, entry: null, store: null, posts: [], home: null, customerKey: null, strangerKey: null };
const cardUrl = () => `${state.origin}${AGENT_CARD_PATH}`;

// ---------------------------------------------------------------- the shop's door on 127.0.0.1

before(async () => {
  state.home = tmp('ae-knock-track-home-');
  state.customerKey = join(state.home, 'knock-seed');
  writeFileSync(state.customerKey, `${CUSTOMER_SEED}\n`, { mode: 0o600 });
  state.strangerKey = join(state.home, 'stranger-seed');
  writeFileSync(state.strangerKey, `${STRANGER_SEED}\n`, { mode: 0o600 });
  state.server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'POST') state.posts.push(body.toString('utf8'));
      try {
        const out = await state.entry.handleRequestAsync(req.method, req.url, req.headers, body,
          { remoteAddress: req.socket.remoteAddress });
        res.writeHead(out.status, out.headers || {});
        res.end(out.body || '');
      } catch (e) {
        res.writeHead(500);
        res.end(String(e?.message || e));
      }
    });
  });
  await new Promise((r) => state.server.listen(0, '127.0.0.1', r));
  state.origin = `http://127.0.0.1:${state.server.address().port}`;
  state.store = createMemoryStore();
  const declaration = clone(DECLARATION);
  declaration.entry.baseUrl = state.origin;
  state.entry = createAgentEntry({ seedHex: DOOR_SEED, name: declaration.entry.name, baseUrl: state.origin,
    declaration, signedRatePerMin: 0, signedRatePerMinTotal: 0, responder: () => 'ok', store: state.store });
});

after(async () => {
  if (state.server) await new Promise((r) => state.server.close(() => r()));
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixtures: holds and decisions

let sequence = 0;
/** One signed `hold` by `seed` at the door, in process: the door files the pending row under its ref. */
async function hold(seed = CUSTOMER_SEED) {
  const entry = state.entry;
  const from = didFromSeedHex(seed);
  const messageId = `knock-track-hold-${++sequence}`;
  const text = `hold item {"id":${100 + sequence}}`;
  const timestamp = nowS();
  const sig = signEnvelope(seed, { from, to: entry.did, messageId, contextId: null, timestamp, text });
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
      metadata: { from, to: entry.did, timestamp, sig, offer: 'hold' } } } }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
    { remoteAddress: '127.0.0.1' });
  const pendingText = JSON.parse(Buffer.from(out.body).toString('utf8')).result.parts[0].text;
  const pending = JSON.parse(pendingText);
  assert.equal(pending.status, 'pending_confirmation', `fixture: the hold is answered pending: ${pendingText.slice(0, 300)}`);
  const ref = pending.deal.ref;
  const row = await state.store.getReceipt(ref);
  assert.equal(row?.pending_text, pendingText, 'fixture: the door filed the pending reply under its ref');
  return { ref, pendingText, pending };
}

/** Put `text` on `ref`'s row as the stored decision with `status`. */
async function decide(ref, status, text) {
  const row = clone(await state.store.getReceipt(ref));
  row.decision = { status, text, decided_ts: nowS() };
  await state.store.putReceipt(ref, row);
}

async function confirmed() {
  const h = await hold();
  const text = confirmReceipt(DOOR_SEED, h.pendingText);
  await decide(h.ref, 'confirmed', text);
  return { ...h, text };
}

async function declined() {
  const h = await hold();
  const text = declineReceipt(DOOR_SEED, h.pendingText, DECLINE_NOTE);
  await decide(h.ref, 'declined', text);
  return { ...h, text };
}

// ---------------------------------------------------------------- the bin

/** Run `knock ...args` as the bin with the loopback guard: { code, stdout, stderr, guard, posts, timedOut }. */
function runKnock(args, { keyPath = state.customerKey, knockText = UNRELATED_TEXT } = {}) {
  const log = join(tmp('ae-knock-track-guard-'), 'guard.jsonl');
  const env = { HOME: state.home, AGENT_ENTRY_KNOCK_KEY: keyPath, AE_CLI_GUARD_LOG: log };
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k];
  if (knockText !== null) env.AGENT_ENTRY_KNOCK_TEXT = knockText;
  state.posts = [];
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--import', GUARD, BIN, 'knock', ...args],
      { cwd: state.home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60000);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let guard = [];
      try { guard = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
      resolveRun({ code, stdout, stderr, guard, timedOut, posts: [...state.posts] });
    });
  });
}

const said = (run) => `exit ${run.code}; stdout ${JSON.stringify(run.stdout.slice(0, 400))}; stderr ${JSON.stringify(run.stderr.slice(0, 400))}`;

function assertStayedHome(run, what) {
  assert.ok(!run.timedOut, `${what}: timed out`);
  assert.ok(run.guard.some((r) => r.kind === 'loaded'), `${what}: the loopback guard did not load`);
  assert.deepEqual(run.guard.filter((r) => r.allowed === false), [], `${what}: tried to dial out`);
}

/** The one track knock the door was sent: signed by the knock key, metadata.offer track, text {"ref": ref}. */
function assertTrackPost(run, ref, { signer = CUSTOMER, what }) {
  assert.equal(run.posts.length, 1, `${what}: exactly one message/send reached the door: ${said(run)}`);
  const m = JSON.parse(run.posts[0]).params?.message;
  assert.equal(m?.metadata?.offer, 'track', `${what}: metadata.offer is track`);
  assert.equal(m?.metadata?.from, signer, `${what}: signed by the knock key`);
  assert.equal(m?.metadata?.to, state.entry.did, `${what}: addressed to the door`);
  const text = String(m?.parts?.[0]?.text);
  assert.ok(!text.includes(UNRELATED_TEXT), `${what}: --ref decides the text, not AGENT_ENTRY_KNOCK_TEXT: ${JSON.stringify(text)}`);
  const at = text.indexOf('{');
  let carried = null;
  try { carried = JSON.parse(text.slice(at)); } catch { /* below */ }
  assert.ok(at !== -1, `${what}: the text carries JSON: ${JSON.stringify(text)}`);
  assert.deepEqual(carried, { ref }, `${what}: the text carries exactly {"ref": <ref>}: ${JSON.stringify(text)}`);
}

/** Misuse: exit 2, nothing sent, nothing on stdout. */
function assertMisuse(run, what) {
  assertStayedHome(run, what);
  assert.equal(run.code, 2, `${what} is misuse: ${said(run)}`);
  assert.equal(run.posts.length, 0, `${what}: nothing reaches the door`);
  assert.equal(run.stdout, '', `${what}: nothing on stdout`);
}

/** A refused knock: non-zero, nothing on stdout, none of `secrets` in the output. */
function assertRefusedKnock(run, what, secrets = [], code = 1) {
  assertStayedHome(run, what);
  assert.equal(run.code, code, `${what} is refused: ${said(run)}`);
  assert.equal(run.stdout, '', `${what}: nothing is printed as a decision: ${said(run)}`);
  assert.ok(run.stderr.trim().length > 0, `${what}: the refusal says why`);
  for (const s of secrets) assert.ok(!`${run.stdout}${run.stderr}`.includes(s), `${what}: the output does not carry ${JSON.stringify(s.slice(0, 40))}`);
}

/** What the bin printed, as JSON. */
function printedDecision(run, what) {
  const lines = run.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `${what}: one JSON document on stdout: ${said(run)}`);
  return JSON.parse(lines[0]);
}

/** The deal of a decided reply: the hold's termsHash, partyA the shop, partyB the customer, sigA verifying. */
function assertSignedOnSameTerms(decision, h, what) {
  const d = decision.deal || {};
  assert.equal(d.type, 'DealReceipt', `${what}: deal.type`);
  assert.equal(d.termsHash, h.pending.deal.termsHash, `${what}: the same termsHash as the hold`);
  assert.equal(d.ref, h.ref, `${what}: the deal's ref is the ref asked`);
  assert.equal(d.partyA, state.entry.did, `${what}: partyA is the shop`);
  assert.equal(d.partyB, CUSTOMER, `${what}: partyB is the customer`);
  const sigA = Buffer.from(String(d.sigA), 'base64');
  assert.ok(sigA.length === 64 && verifyBytes(Buffer.from(publicKeyHexFromDid(state.entry.did), 'hex'), sigA, dealPayload(d)),
    `${what}: sigA verifies under the shop's key`);
}

// ---------------------------------------------------------------- functional

test('knock --offer track --ref <ref> on a confirmed ref prints the confirmed decision, on the hold\'s terms, signed by the shop', async () => {
  const c = await confirmed();
  const run = await runKnock([cardUrl(), '--offer', 'track', '--ref', c.ref]);
  assertStayedHome(run, 'knock --offer track --ref <confirmed>');
  assert.equal(run.code, 0, `the knock collects the decision: ${said(run)}`);
  assertTrackPost(run, c.ref, { what: 'knock --offer track --ref <confirmed>' });
  const printed = printedDecision(run, 'confirmed');
  assert.deepEqual(printed, JSON.parse(c.text), 'it prints the decision the door returned for that ref');
  assert.equal(printed.status, 'confirmed');
  assert.equal(printed.customer_did, CUSTOMER, 'filed under the customer');
  for (const k of ['verb', 'of', 'request']) assert.equal(printed[k], c.pending[k], `the hold's ${k}`);
  assertSignedOnSameTerms(printed, c, 'confirmed');
});

test('a declined ref is printed as declined, with the shop\'s note, never as confirmed', async () => {
  const d = await declined();
  const run = await runKnock([cardUrl(), '--offer', 'track', '--ref', d.ref]);
  assertStayedHome(run, 'knock --offer track --ref <declined>');
  assert.equal(run.code, 0, `the knock collects the decision: ${said(run)}`);
  assertTrackPost(run, d.ref, { what: 'knock --offer track --ref <declined>' });
  const printed = printedDecision(run, 'declined');
  assert.deepEqual(printed, JSON.parse(d.text), 'it prints the decision the door returned, the note included');
  assert.equal(printed.status, 'declined');
  assert.notEqual(printed.status, 'confirmed');
  assert.equal(printed.note, DECLINE_NOTE, 'the shop\'s words reach the customer');
  assertSignedOnSameTerms(printed, d, 'declined');
});

test('a ref still held is printed as pending_confirmation, the door\'s track shape, never as confirmed', async () => {
  const h = await hold();
  const run = await runKnock([cardUrl(), '--offer', 'track', '--ref', h.ref]);
  assertStayedHome(run, 'knock --offer track --ref <undecided>');
  assert.equal(run.code, 0, `the knock collects the answer: ${said(run)}`);
  assertTrackPost(run, h.ref, { what: 'knock --offer track --ref <undecided>' });
  const printed = printedDecision(run, 'undecided');
  assert.equal(printed.verb, 'track');
  assert.equal(printed.of, h.pending.of);
  assert.equal(printed.customer_did, CUSTOMER);
  assert.equal(printed.status, 'pending_confirmation', 'still held');
  assert.ok(!Object.hasOwn(printed, 'deal'), 'no deal is invented for an undecided ref');
});

test('the same ref, collected again, prints the same decision: knocking writes nothing', async () => {
  const c = await confirmed();
  const before = clone(await state.store.getReceipt(c.ref));
  const a = await runKnock([cardUrl(), '--offer', 'track', '--ref', c.ref]);
  const b = await runKnock([cardUrl(), '--offer', 'track', '--ref', c.ref]);
  assert.equal(a.code, 0, said(a));
  assert.equal(b.code, 0, said(b));
  assert.equal(b.stdout, a.stdout, 'the same bytes on stdout');
  assert.deepEqual(await state.store.getReceipt(c.ref), before, 'the row is as it was');
});

// ---------------------------------------------------------------- refusals: the command line

test('refused: --offer track with no --ref is misuse, nothing sent -- even when the knock text carries a ref', async () => {
  const c = await confirmed();
  const bare = await runKnock([cardUrl(), '--offer', 'track']);
  assertMisuse(bare, 'knock --offer track (no --ref)');
  const viaText = await runKnock([cardUrl(), '--offer', 'track'], { knockText: JSON.stringify({ ref: c.ref }) });
  assertMisuse(viaText, 'knock --offer track (no --ref, the ref in AGENT_ENTRY_KNOCK_TEXT)');
  assert.ok(!viaText.stderr.includes(c.text), 'no decision text leaks');
});

test('refused: --ref with no value, an empty --ref, --ref twice, --ref beside another offer: misuse, nothing sent', async () => {
  const c = await confirmed();
  const other = await confirmed();
  const cases = [
    ['--ref with no value', [cardUrl(), '--offer', 'track', '--ref']],
    ['an empty --ref', [cardUrl(), '--offer', 'track', '--ref', '']],
    ['--ref twice', [cardUrl(), '--offer', 'track', '--ref', c.ref, '--ref', other.ref]],
    ['--ref beside --offer hold', [cardUrl(), '--offer', 'hold', '--ref', c.ref]],
    ['--ref beside --offer find', [cardUrl(), '--offer', 'find', '--ref', c.ref]],
  ];
  for (const [label, args] of cases) {
    const run = await runKnock(args);
    assertMisuse(run, label);
  }
});

// ---------------------------------------------------------------- refusals: the door says no

test('refused: an unknown ref (prototype keys included) -- sent, the door\'s -32602 comes back, nothing printed', async () => {
  const c = await confirmed();
  for (const ref of ['no-such-ref', `${c.ref}x`, '__proto__', 'constructor']) {
    const run = await runKnock([cardUrl(), '--offer', 'track', '--ref', ref]);
    assertRefusedKnock(run, `knock --ref ${ref}`, [c.text, JSON.parse(c.text).deal.sigA]);
    assertTrackPost(run, ref, { what: `knock --ref ${ref}` });
    assert.match(run.stderr, /Refused \(-32602\)/, `${ref}: the door's refusal is named: ${said(run)}`);
  }
});

test('refused: another customer\'s ref is not this knock key\'s to collect; the decision never leaks', async () => {
  const c = await confirmed();
  const run = await runKnock([cardUrl(), '--offer', 'track', '--ref', c.ref], { keyPath: state.strangerKey });
  assertRefusedKnock(run, 'a stranger collects the customer\'s ref', [c.text, JSON.parse(c.text).deal.sigA, CUSTOMER]);
  assertTrackPost(run, c.ref, { signer: STRANGER, what: 'a stranger collects the customer\'s ref' });
  assert.match(run.stderr, /Refused \(-32602\)/, said(run));
});

test('refused: a malformed ref -- nothing is printed, whether the knock refuses it or the door does', async () => {
  const c = await confirmed();
  for (const ref of [' ', 'r'.repeat(201), 'ref\nwith a newline', `${c.ref} `, '{"ref":"x"}']) {
    const run = await runKnock([cardUrl(), '--offer', 'track', '--ref', ref]);
    assertStayedHome(run, `knock --ref ${JSON.stringify(ref)}`);
    assert.ok(run.code === 1 || run.code === 2, `${JSON.stringify(ref)} is refused: ${said(run)}`);
    assert.equal(run.stdout, '', `${JSON.stringify(ref)}: nothing printed: ${said(run)}`);
    assert.ok(!run.stderr.includes(c.text), `${JSON.stringify(ref)}: no decision leaks`);
    assert.ok(run.posts.length <= 1, `${JSON.stringify(ref)}: at most one knock`);
  }
});

// ---------------------------------------------------------------- refusals: checkedBookingReceipt

/** A decided row whose decision text is `edit`ed from a real one; the door will answer it verbatim. */
async function forged(status, edit) {
  const h = await hold();
  const real = JSON.parse(status === 'declined'
    ? declineReceipt(DOOR_SEED, h.pendingText, DECLINE_NOTE)
    : confirmReceipt(DOOR_SEED, h.pendingText));
  const v = clone(real);
  edit(v);
  const text = JSON.stringify(v);
  await decide(h.ref, status, text);
  return { ...h, text };
}

const resign = (seed) => (v) => {
  v.deal.partyA = didFromSeedHex(seed);
  v.deal.sigA = signBytes(seed, dealPayload(v.deal)).toString('base64');
};

const FORGERIES = [
  ['confirmed, sigA broken', 'confirmed', (v) => { v.deal.sigA = signBytes(DOOR_SEED, Buffer.from('other bytes')).toString('base64'); }],
  ['confirmed, sigA missing', 'confirmed', (v) => { delete v.deal.sigA; }],
  ['confirmed, re-signed by a stranger as partyA', 'confirmed', resign(STRANGER_SEED)],
  ['confirmed, request edited after signing', 'confirmed', (v) => { v.request = 'hold item {"id":1}'; }],
  ['confirmed, of edited after signing', 'confirmed', (v) => { v.of = 'everything'; }],
  ['confirmed, termsHash swapped and re-signed by the shop', 'confirmed', (v) => {
    v.deal.termsHash = 'ab'.repeat(32);
    v.deal.sigA = signBytes(DOOR_SEED, dealPayload(v.deal)).toString('base64');
  }],
  ['confirmed, no deal at all', 'confirmed', (v) => { delete v.deal; }],
  ['declined, request edited after signing', 'declined', (v) => { v.request = 'hold item {"id":1}'; }],
  ['declined, re-signed by a stranger as partyA', 'declined', resign(STRANGER_SEED)],
];

test('refused by checkedBookingReceipt: a decision whose signature or terms do not check out is not printed', async () => {
  for (const [label, status, edit] of FORGERIES) {
    const f = await forged(status, edit);
    const run = await runKnock([cardUrl(), '--offer', 'track', '--ref', f.ref]);
    assertTrackPost(run, f.ref, { what: label });
    assertRefusedKnock(run, label, [f.text]);
    assert.ok(!/"status"\s*:\s*"confirmed"/.test(run.stderr), `${label}: nothing reads confirmed`);
  }
});

test('refused by checkedBookingReceipt in the library knock too: the forged decision is never reported as a booking', async () => {
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const out = await state.entry.handleRequestAsync(init.method || 'GET', u.pathname + u.search, init.headers || {},
      Buffer.from(init.body || ''), { remoteAddress: '127.0.0.1' });
    return new Response(out.body, { status: out.status, headers: out.headers });
  };
  for (const [label, status, edit] of FORGERIES) {
    const f = await forged(status, edit);
    let result = null;
    let error = null;
    try {
      result = await knockAgentEntry(cardUrl(), { keyPath: state.customerKey, offer: 'track', text: JSON.stringify({ ref: f.ref }), fetchImpl });
    } catch (e) { error = e; }
    assert.ok(error !== null || result?.ok !== true,
      `${label}: the knock refuses it: ${JSON.stringify(result).slice(0, 300)}`);
    assert.ok(!result?.booking, `${label}: no booking is reported`);
  }
  // The control: the real decision on the same door reads as a booking.
  const c = await confirmed();
  const ok = await knockAgentEntry(cardUrl(), { keyPath: state.customerKey, offer: 'track', text: JSON.stringify({ ref: c.ref }), fetchImpl });
  assert.ok(ok.ok && ok.booking, `the real decision is a booking: ${JSON.stringify(ok).slice(0, 300)}`);
  assert.equal(ok.booking.status, 'confirmed');
});
