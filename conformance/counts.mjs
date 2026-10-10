#!/usr/bin/env node
// FRAME Analytics-2 (intake 20261003T131711Z-2, frame step 6b): `first_contact` on the envelope,
// in the sinks and in `agent-entry counts`. The acceptance pin is conformance/frame.mjs 6b; this
// file pins, at the unit level beside it, what that step needs. Fixtures only: an in-process door
// with no socket, a stubbed gaSink fetch, and literal fileSink-shaped logs for the CLI.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). The authority is the written requirement,
// not the implementer. Not wired into conformance/run.mjs or `npm test` until green. Run it as
// `node conformance/counts.mjs`. Every CLI child runs with fixtures/cli/loopback-only.mjs
// preloaded and must not dial out.
//
// What is pinned:
//   - The responder envelope and the observer row of every ANSWERED POST carry `first_contact`, a
//     boolean: true when that message created the account row (noteContact's first contact),
//     false otherwise. The first answered POST from a new account is true, its second false, and
//     a separate new account is true again. An answered anonymous POST mints no account row, so it
//     is false.
//   - `first_contact` is in SINK_FIELDS: a fileSink line and a gaSink event's params carry it,
//     as a boolean.
//   - `counts` (both --json and the text form) shows new versus returning knocks, read from the
//     log's first_contact, and still reports returning_customers from the store. The JSON split
//     is found the way frame 6b finds it: an object with a `new|first|first_contact(s)|true` key
//     and a `returning|repeat|false` key, both integers.
//   - Refusal: no DID in a sink line, a GA body or the counts output (first_contact is a boolean,
//     never a DID); an account row keeps exactly {first_seen, last_seen, messages}, in memory and
//     in a createFileStore file; a request that is not answered (refused or rejected) is never
//     marked a first contact and creates no account row, and a replay does not re-mark one.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const {
  createAgentEntry, createFileStore, didFromPublicKeyHex, fileSink, gaSink, publicKeyFromSeedHex, signEnvelope,
} = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'muretai-agent-entry.mjs');
const GUARD = join(HERE, 'fixtures', 'cli', 'loopback-only.mjs');

const DOOR_SEED = '7a'.repeat(32);
const SEED_A = '7b'.repeat(32);
const SEED_B = '7c'.repeat(32);
const SEED_C = '7d'.repeat(32);
const BASE_URL = 'https://door.example';
const FIXED_TS = 1767225600;
const ROW_KEYS = ['first_seen', 'last_seen', 'messages'];
const MARKER = 'Marker-Ada-4417 brass lamp';

const didOf = (seed) => didFromPublicKeyHex(publicKeyFromSeedHex(seed));
const DOOR_DID = didOf(DOOR_SEED);
const DID_A = didOf(SEED_A);
const DID_B = didOf(SEED_B);
const DID_C = didOf(SEED_C);
const ALL_DIDS = [DOOR_DID, DID_A, DID_B, DID_C];

const scratch = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

// ---------------------------------------------------------------- the door

function rpc(messageId, text, metadata) {
  return Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', parts: [{ kind: 'text', text }],
      messageId, contextId: null, metadata } },
  }), 'utf8');
}

function signedBody(seed, messageId, text = MARKER, { tamper = false } = {}) {
  const from = didOf(seed);
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signEnvelope(seed, { from, to: DOOR_DID, messageId, contextId: null, timestamp, text });
  return rpc(messageId, tamper ? `${text}!` : text, { timestamp, from, to: DOOR_DID, sig });
}

const anonBody = (messageId) => rpc(messageId, MARKER, { timestamp: Math.floor(Date.now() / 1000) });

const HEADERS = { 'content-type': 'application/json', 'user-agent': 'Claude-User/1.0' };

/** A door with a recording observer and responder, plus a fileSink and a gaSink fed every
 *  observed envelope: { entry, obs, resp, ga, log }. */
function makeDoor(opts = {}) {
  const obs = [];
  const resp = [];
  const ga = [];
  const log = join(tmp('ae-first-contact-'), 'visits.jsonl');
  const toFile = fileSink(log);
  const toGa = gaSink({ measurementId: 'G-TEST000001', apiSecret: 'test-secret-4417',
    fetchImpl: async (url, init = {}) => {
      ga.push(typeof init.body === 'string' ? init.body : Buffer.from(init.body || '').toString('utf8'));
      return new Response(null, { status: 204 });
    } });
  const entry = createAgentEntry({
    seedHex: DOOR_SEED, name: 'first-contact', baseUrl: BASE_URL,
    anonymousLane: true, signedRatePerMin: 0,
    responder: (env) => { resp.push(env); return { text: 'ok', timestamp: FIXED_TS }; },
    observer: (env) => { obs.push(env); toFile(env); toGa(env); },
    ...opts,
  });
  return { entry, obs, resp, ga, log };
}

async function post(d, body) {
  const before = { obs: d.obs.length, resp: d.resp.length };
  const out = await d.entry.handleRequestAsync('POST', '/', HEADERS, body, { remoteAddress: '198.51.100.23' });
  const text = out.body ? Buffer.from(out.body).toString('utf8') : '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* below */ }
  return {
    out, parsed, answered: Boolean(parsed && parsed.result),
    obs: d.obs.slice(before.obs), resp: d.resp.slice(before.resp),
  };
}

const settle = (ms = 60) => new Promise((done) => setTimeout(done, ms));
const fileLines = (path) => {
  let raw = '';
  try { raw = readFileSync(path, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const postRow = (r) => r.obs.find((e) => ['signed_post', 'anon_post', 'refused_post'].includes(e.stage));

// ---------------------------------------------------------------- functional: the envelope

test('first answered POST from a new account: first_contact true in the responder envelope and the observer row', async () => {
  const d = makeDoor();
  const r = await post(d, signedBody(SEED_A, 'a-1'));
  assert.ok(r.answered, `the knock is answered: ${JSON.stringify(r.parsed).slice(0, 300)}`);
  assert.equal(r.resp.length, 1, 'the responder ran once');
  assert.equal(r.resp[0].first_contact, true, `responder envelope: ${JSON.stringify(r.resp[0].first_contact)}`);
  const row = postRow(r);
  assert.equal(row && row.stage, 'signed_post', 'a signed_post observer row');
  assert.equal(row.first_contact, true, `observer row: ${JSON.stringify(row.first_contact)}`);
});

test('second answered POST from the same account: first_contact false; a separate new account: true again', async () => {
  const d = makeDoor();
  const seen = [];
  for (const [seed, id] of [[SEED_A, 'a-1'], [SEED_A, 'a-2'], [SEED_B, 'b-1'], [SEED_A, 'a-3'], [SEED_B, 'b-2']]) {
    const r = await post(d, signedBody(seed, id));
    assert.ok(r.answered, `${id} is answered: ${JSON.stringify(r.parsed).slice(0, 300)}`);
    seen.push([id, r.resp[0]?.first_contact, postRow(r)?.first_contact]);
  }
  assert.deepEqual(seen, [
    ['a-1', true, true],
    ['a-2', false, false],
    ['b-1', true, true],
    ['a-3', false, false],
    ['b-2', false, false],
  ], 'first_contact on [responder envelope, observer row], per message');
  assert.equal(d.entry.ledger.get(DID_A)?.messages, 3, 'account A counted three messages');
  assert.equal(d.entry.ledger.get(DID_B)?.messages, 2, 'account B counted two messages');
});

test('first_contact follows the store: a door reopened on a file store says false for a known account', async () => {
  const storePath = join(tmp('ae-first-contact-store-'), 'ledger.json');
  const first = makeDoor({ store: createFileStore(storePath) });
  const r1 = await post(first, signedBody(SEED_A, 'a-1'));
  assert.ok(r1.answered, JSON.stringify(r1.parsed).slice(0, 300));
  assert.equal(r1.resp[0]?.first_contact, true, 'first knock on an empty store');
  const again = makeDoor({ store: createFileStore(storePath) });
  const r2 = await post(again, signedBody(SEED_A, 'a-2'));
  assert.ok(r2.answered, JSON.stringify(r2.parsed).slice(0, 300));
  assert.equal(r2.resp[0]?.first_contact, false, 'the store already holds the account');
  assert.equal(postRow(r2)?.first_contact, false, 'observer row after a restart');
  const r3 = await post(again, signedBody(SEED_C, 'c-1'));
  assert.equal(r3.resp[0]?.first_contact, true, 'a new account on the same store');
});

test('an answered anonymous POST mints no account row, so it is not a first contact: first_contact false', async () => {
  const d = makeDoor();
  const r = await post(d, anonBody('anon-1'));
  assert.ok(r.answered, `the anonymous lane answers: ${JSON.stringify(r.parsed).slice(0, 300)}`);
  assert.equal(r.resp[0]?.first_contact, false, `responder envelope: ${JSON.stringify(r.resp[0]?.first_contact)}`);
  assert.equal(postRow(r)?.stage, 'anon_post');
  assert.equal(postRow(r)?.first_contact, false, `observer row: ${JSON.stringify(postRow(r)?.first_contact)}`);
  assert.equal(d.entry.ledger.size, 0, 'no account row');
});

// ---------------------------------------------------------------- functional: the sinks

test('fileSink: every answered POST line carries first_contact as a boolean, true once per account', async () => {
  const d = makeDoor();
  for (const [seed, id] of [[SEED_A, 'a-1'], [SEED_A, 'a-2'], [SEED_B, 'b-1']]) await post(d, signedBody(seed, id));
  const answered = fileLines(d.log).filter((l) => l.stage === 'signed_post');
  assert.equal(answered.length, 3, `three signed_post lines: ${JSON.stringify(fileLines(d.log))}`);
  assert.deepEqual(answered.map((l) => l.first_contact), [true, false, true], JSON.stringify(answered));
  for (const l of answered) assert.equal(typeof l.first_contact, 'boolean');
});

test('gaSink: a door event carries first_contact as a boolean param', async () => {
  const d = makeDoor();
  await post(d, signedBody(SEED_A, 'a-1'));
  await post(d, signedBody(SEED_A, 'a-2'));
  await settle();
  const events = d.ga.map((b) => JSON.parse(b)).flatMap((b) => b.events).filter((e) => e.name === 'door_signed_post');
  assert.equal(events.length, 2, `two door_signed_post events: ${JSON.stringify(d.ga).slice(0, 600)}`);
  assert.deepEqual(events.map((e) => e.params.first_contact), [true, false], JSON.stringify(events.map((e) => e.params)));
});

test('gaSink and fileSink pass first_contact from any envelope: it is in SINK_FIELDS', async () => {
  const log = join(tmp('ae-first-contact-sink-'), 'visits.jsonl');
  const ga = [];
  const toFile = fileSink(log);
  const toGa = gaSink({ measurementId: 'G-TEST000001', apiSecret: 'x',
    fetchImpl: async (url, init = {}) => { ga.push(String(init.body)); return new Response(null, { status: 204 }); } });
  for (const first of [true, false]) {
    const env = { stage: 'signed_post', offer: 'ask', identified: 1, verified: true, first_contact: first,
      peer_did: DID_A, owner_did: null, text: MARKER };
    toFile(env);
    toGa(env);
  }
  await settle();
  assert.deepEqual(fileLines(log).map((l) => l.first_contact), [true, false], readFileSync(log, 'utf8'));
  assert.deepEqual(ga.map((b) => JSON.parse(b).events[0].params.first_contact), [true, false], ga.join('\n'));
});

// ---------------------------------------------------------------- refusal: nothing identifying leaves

test('no DID and no text in any fileSink line or gaSink body; first_contact is never a DID', async () => {
  const d = makeDoor();
  for (const [seed, id] of [[SEED_A, 'a-1'], [SEED_A, 'a-2'], [SEED_B, 'b-1']]) await post(d, signedBody(seed, id));
  await post(d, anonBody('anon-1'));
  await settle();
  const fileText = readFileSync(d.log, 'utf8');
  const gaText = d.ga.join('\n');
  for (const [label, text] of [['fileSink', fileText], ['gaSink', gaText]]) {
    assert.ok(!text.includes('did:'), `${label} carries no DID: ${text.slice(0, 400)}`);
    for (const did of ALL_DIDS) assert.ok(!text.includes(did.slice(8)), `${label} carries no DID fragment`);
    assert.ok(!text.includes(MARKER), `${label} carries no message text`);
  }
  assert.ok(fileLines(d.log).some((l) => 'first_contact' in l), 'the field is there to check');
  for (const env of [...d.obs, ...d.resp]) {
    if ('first_contact' in env) assert.equal(typeof env.first_contact, 'boolean', `first_contact is a boolean: ${JSON.stringify(env.first_contact)}`);
  }
});

test('the account row keeps exactly first_seen, last_seen and messages, in memory and in a file store', async () => {
  const d = makeDoor();
  for (const [seed, id] of [[SEED_A, 'a-1'], [SEED_A, 'a-2'], [SEED_B, 'b-1']]) {
    const r = await post(d, signedBody(seed, id));
    assert.ok(r.answered, JSON.stringify(r.parsed).slice(0, 300));
  }
  assert.ok(d.obs.some((e) => e.first_contact === true), 'first_contact was observed');
  for (const [k, row] of d.entry.ledger) assert.deepEqual(Object.keys(row).sort(), ROW_KEYS, `memory row ${k.slice(0, 20)}: ${JSON.stringify(row)}`);

  const storePath = join(tmp('ae-first-contact-store-'), 'ledger.json');
  const f = makeDoor({ store: createFileStore(storePath) });
  for (const [seed, id] of [[SEED_A, 'a-1'], [SEED_A, 'a-2'], [SEED_B, 'b-1']]) await post(f, signedBody(seed, id));
  assert.ok(f.obs.some((e) => e.first_contact === true), 'first_contact was observed with a file store');
  const accounts = JSON.parse(readFileSync(storePath, 'utf8')).accounts;
  assert.equal(accounts.length, 2, JSON.stringify(accounts));
  for (const [, row] of accounts) assert.deepEqual(Object.keys(row).sort(), ROW_KEYS, `file row: ${JSON.stringify(row)}`);
});

test('a refused signed POST from a new key is not a first contact and creates no account row', async () => {
  const d = makeDoor();
  const bad = await post(d, signedBody(SEED_C, 'c-bad', MARKER, { tamper: true }));
  assert.ok(!bad.answered, 'a tampered signature is refused');
  const partial = await post(d, rpc('c-partial', MARKER, { from: DID_C, to: DOOR_DID }));
  assert.ok(!partial.answered, 'a partial envelope is refused');
  for (const r of [bad, partial]) {
    assert.equal(r.resp.length, 0, 'the responder never ran');
    for (const e of r.obs) assert.notEqual(e.first_contact, true, `a refusal is never a first contact: ${JSON.stringify(e.first_contact)}`);
  }
  assert.equal(d.entry.ledger.has(DID_C), false, 'no account row for the refused key');
  assert.ok(fileLines(d.log).every((l) => l.first_contact !== true), JSON.stringify(fileLines(d.log)));
  // The same key, now answered, is still new: the refusals created nothing.
  const good = await post(d, signedBody(SEED_C, 'c-1'));
  assert.ok(good.answered, JSON.stringify(good.parsed).slice(0, 300));
  assert.equal(good.resp[0]?.first_contact, true, 'the first ANSWERED message is the first contact');
  assert.equal(postRow(good)?.first_contact, true);
});

test('a replayed first message is rejected, not re-marked a first contact, and adds no message', async () => {
  const d = makeDoor();
  const body = signedBody(SEED_A, 'a-1');
  const first = await post(d, body);
  assert.ok(first.answered);
  assert.equal(first.resp[0]?.first_contact, true);
  const replay = await post(d, body);
  assert.ok(!replay.answered, 'the replay is rejected');
  assert.equal(replay.resp.length, 0, 'the responder never ran for the replay');
  for (const e of replay.obs) assert.notEqual(e.first_contact, true, `the replay is not a first contact: ${JSON.stringify(e)}`);
  assert.equal(d.entry.ledger.get(DID_A)?.messages, 1, 'the replay did not touch the row');
});

test('a rate-refused POST from a new account is not a first contact and creates no account row', async () => {
  const d = makeDoor({ signedRatePerMin: 1 });
  const a1 = await post(d, signedBody(SEED_A, 'a-1'));
  assert.ok(a1.answered);
  assert.equal(a1.resp[0]?.first_contact, true);
  // A per-account ceiling of one: A's second message is refused, B is still fresh.
  const a2 = await post(d, signedBody(SEED_A, 'a-2'));
  assert.ok(!a2.answered, 'over the per-account ceiling');
  for (const e of a2.obs) assert.notEqual(e.first_contact, true);
  assert.equal(d.entry.ledger.get(DID_A)?.messages, 1, 'a refusal adds no message');
  const b1 = await post(d, signedBody(SEED_B, 'b-1'));
  assert.ok(b1.answered, JSON.stringify(b1.parsed).slice(0, 300));
  assert.equal(b1.resp[0]?.first_contact, true, 'another account is new');
});

// ---------------------------------------------------------------- counts: new versus returning

const T0 = 1790000000;
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

// Two first contacts and three returning knocks; refused, anonymous, page and GET rows carry no
// boolean first_contact and are neither.
const LOG = [
  { t: T0, stage: 'card_get', ua_family: 'claude-user', client_class: 'declared-agent' },
  { t: T0 + 1, stage: 'signed_post', identified: 1, verified: true, first_contact: true, ua_family: 'claude-user', client_class: 'declared-agent' },
  { t: T0 + 2, stage: 'signed_post', identified: 1, verified: true, first_contact: false, ua_family: 'claude-user', client_class: 'declared-agent' },
  { t: T0 + 3, stage: 'refused_post', refused: 'signature', identified: 1, verified: false, ua_family: 'claude-user' },
  { t: T0 + 4, stage: 'signed_post', identified: 1, verified: true, first_contact: true, ua_family: 'openai', client_class: 'declared-agent' },
  { t: T0 + 5, stage: 'anon_post', identified: 0, verified: false, first_contact: false, ua_family: 'curl', client_class: 'named-tool' },
  { t: T0 + 6, stage: 'signed_post', identified: 1, verified: true, first_contact: false, ua_family: 'openai', client_class: 'declared-agent' },
  { t: T0 + 7, stage: 'page', event: 'referral', engine: 'claude' },
  { t: T0 + 8, stage: 'signed_post', identified: 1, verified: true, first_contact: false, ua_family: 'claude-user', client_class: 'declared-agent' },
];
const NEW = 2;
const RETURNING = 3;

// The store: one account wrote three times, one once, one twice -> returning_customers 2, a number
// the log alone cannot give (so it is read from the store, not derived from first_contact).
const STORE = {
  v: 1, messages: [], deviceOwners: [], keyStates: [],
  accounts: [
    [DID_A, { first_seen: T0 + 1, last_seen: T0 + 8, messages: 3 }],
    [DID_B, { first_seen: T0 + 4, last_seen: T0 + 4, messages: 1 }],
    [DID_C, { first_seen: T0 - 900, last_seen: T0 + 6, messages: 2 }],
  ],
};

function fixture(rows, { store = STORE } = {}) {
  const dir = tmp('ae-counts-first-');
  const log = join(dir, 'visits.jsonl');
  writeFileSync(log, jsonl(rows));
  let storePath = null;
  if (store) {
    storePath = join(dir, 'ledger.json');
    writeFileSync(storePath, JSON.stringify(store));
  }
  return { dir, log, store: storePath };
}

function runCli(args, cwd) {
  const guardLogPath = join(tmp('ae-counts-guard-'), 'guard.jsonl');
  const env = {};
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k];
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(GUARD).href, BIN, ...args], {
      cwd, env: { ...env, HOME: cwd, AE_CLI_GUARD_LOG: guardLogPath }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

const said = (run) => `exit ${run.code}; stdout ${JSON.stringify(run.stdout.slice(0, 600))}; stderr ${JSON.stringify(run.stderr.slice(0, 400))}`;

async function counts(fx, { json = true } = {}) {
  const args = ['counts', ...(json ? ['--json'] : []), '--log', fx.log, ...(fx.store ? ['--store', fx.store] : [])];
  const run = await runCli(args, fx.dir);
  assert.equal(run.code, 0, `counts: ${said(run)}`);
  assert.ok(!run.stdout.includes('did:'), `no DID anywhere in counts: ${said(run)}`);
  for (const did of ALL_DIDS) assert.ok(!run.stdout.includes(did.slice(8)), 'no DID fragment in counts');
  return run;
}

const NEW_KEY = /^(new|first(_contacts?)?|true)$/;
const RET_KEY = /^(returning|repeat|false)$/;

/** The object holding the new / returning split, found the way frame 6b finds it. */
function splitOf(out) {
  const nodes = [];
  const visit = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      nodes.push(v);
      Object.values(v).forEach(visit);
    }
  };
  visit(out);
  const split = nodes.find((o) => {
    const keys = Object.keys(o);
    const n = keys.find((k) => NEW_KEY.test(k));
    const r = keys.find((k) => RET_KEY.test(k));
    return n && r && Number.isInteger(o[n]) && Number.isInteger(o[r]);
  });
  assert.ok(split, `counts --json shows new vs returning knocks: ${JSON.stringify(out).slice(0, 600)}`);
  return { n: split[Object.keys(split).find((k) => NEW_KEY.test(k))], r: split[Object.keys(split).find((k) => RET_KEY.test(k))] };
}

test('counts --json: new versus returning knocks from the log, returning_customers from the store', async () => {
  const out = JSON.parse((await counts(fixture(LOG))).stdout);
  assert.deepEqual(splitOf(out), { n: NEW, r: RETURNING }, 'two first contacts, three returning signed knocks');
  assert.equal(out.returning_customers, 2, 'the store says two accounts wrote twice or more');
  assert.equal(out.coverage.rows_dropped, 0, `a row carrying first_contact is a fileSink row, not dropped: ${JSON.stringify(out.coverage)}`);
});

test('counts --json: the split needs no store; returning_customers is then 0', async () => {
  const out = JSON.parse((await counts(fixture(LOG, { store: null }))).stdout);
  assert.deepEqual(splitOf(out), { n: NEW, r: RETURNING });
  assert.equal(out.returning_customers, 0);
});

test('counts --json: a log of only first contacts, and an empty log', async () => {
  const only = JSON.parse((await counts(fixture(LOG.filter((r) => r.first_contact !== false)))).stdout);
  assert.deepEqual(splitOf(only), { n: NEW, r: 0 });
  const empty = JSON.parse((await counts(fixture([]))).stdout);
  assert.deepEqual(splitOf(empty), { n: 0, r: 0 });
  assert.equal(empty.returning_customers, 2, 'the store still answers on an empty log');
});

test('counts --json: a refused row or a non-boolean first_contact is neither new nor returning', async () => {
  const rows = [
    ...LOG,
    // fileSink keeps a short token under an allowed key; only a boolean is a first contact
    { t: T0 + 9, stage: 'signed_post', identified: 1, verified: true, first_contact: 'true' },
    { t: T0 + 10, stage: 'signed_post', identified: 1, verified: true, first_contact: 1 },
    { t: T0 + 11, stage: 'refused_post', refused: 'rate', identified: 1, verified: false, first_contact: true },
  ];
  const out = JSON.parse((await counts(fixture(rows))).stdout);
  assert.deepEqual(splitOf(out), { n: NEW, r: RETURNING }, JSON.stringify(out).slice(0, 600));
});

test('counts --json: a row carrying a DID beside first_contact is dropped, and counted nowhere', async () => {
  const rows = [
    ...LOG,
    { t: T0 + 20, stage: 'signed_post', identified: 1, verified: true, first_contact: true, peer_did: DID_A },
    { t: T0 + 21, stage: 'signed_post', identified: 1, verified: true, first_contact: false, ua_family: DID_B },
  ];
  const out = JSON.parse((await counts(fixture(rows))).stdout);
  assert.deepEqual(splitOf(out), { n: NEW, r: RETURNING });
  assert.equal(out.coverage.rows_dropped, 2, JSON.stringify(out.coverage));
});

test('counts (text): names the new and the returning knocks, and still the returning customers', async () => {
  const run = await counts(fixture(LOG), { json: false });
  assert.match(run.stdout, new RegExp(`\\bnew\\b[^\\n]*\\b${NEW}\\b`, 'i'), `a line names ${NEW} new knocks: ${said(run)}`);
  assert.match(run.stdout, new RegExp(`\\breturning\\b(?![^\\n]*customers)[^\\n]*\\b${RETURNING}\\b`, 'i'),
    `a line names ${RETURNING} returning knocks: ${said(run)}`);
  assert.match(run.stdout, /returning customers: 2\b/, `returning customers still printed: ${said(run)}`);
});

test('counts --json and the text form carry no DID or text even when the store holds DIDs', async () => {
  const fx = fixture(LOG);
  const json = await counts(fx);
  const text = await counts(fx, { json: false });
  for (const run of [json, text]) assert.ok(!run.stdout.includes(MARKER), 'no message text');
  // the store holds three DIDs; none reaches the output (checked in counts())
  assert.ok(readFileSync(fx.store, 'utf8').includes(DID_A), 'the fixture store does hold a DID');
});
