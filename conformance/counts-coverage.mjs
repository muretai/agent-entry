#!/usr/bin/env node
// FRAME Analytics-1 (parent intake 20261003T131711Z "agent-entry FRAME Analytics", split filed at
// intake 20261003T132912Z; walking-skeleton item 1): the shape `agent-entry counts --json` adds,
// a coverage header and a who block, pinned against fixture logs this file writes. No real
// agent-entry log, no door, no live state: every log below is a literal fileSink-shaped JSONL.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). The authority is the written requirement,
// not the implementer. Not wired into conformance/run.mjs or `npm test` until green. Run it as
// `node conformance/counts-coverage.mjs`. Every CLI child runs with fixtures/cli/loopback-only.mjs
// preloaded and must not dial out.
//
// What is pinned (beside the keys counts --json already prints, which stay):
//   coverage: {
//     from:          ISO 8601 UTC (Date#toISOString) of the smallest `t` among the rows kept, or null
//     to:            ISO 8601 UTC of the largest `t` among the rows kept, or null
//     last_event:    ISO 8601 UTC of the `t` of the last row kept, in log order, or null
//     store_present: true when --store names a readable store, false when --store is not passed
//     rows_dropped:  how many log rows the allowlist filter dropped
//   }  -- exactly these five keys.
//   The allowlist filter keeps only rows fileSink could have written: a JSON object of `t` plus
//   SINK_FIELDS keys, with no string value that starts with `did:`. A row carrying any other key
//   (`did`, `text`, ...) or a DID-shaped value is dropped and counted; a dropped row is not an
//   event seen: it moves neither the range nor last_event and is not counted under who.
//   who: {
//     signed:   { <signature_agent>: n }  door knocks whose signature_agent is one of VENDORS
//     declared: { <ua_family>: n }        door knocks whose ua_family is one of AI_AGENT_FAMILIES
//     network:  { <ip_vendor>: n }        door knocks whose ip_vendor is one of VENDORS
//     'stealth-agent': n                  door knocks in no tier above whose client_class is stealth-agent
//     none: n                             every other door knock in no tier above
//   }  -- exactly these five keys. The three tiers are independent: one knock counts in every tier
//   it carries evidence for (the frame, conformance/frame.mjs 6a, counts every knock from a named
//   range under network even when it is also declared). Every door knock is in at least one tier,
//   or in exactly one of stealth-agent / none. A door knock is a row whose stage is signed_post,
//   anon_post or refused_post; page rows and card/notice GETs are not knocks. A value outside the
//   bounded vocabularies never becomes a key.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AI_AGENT_FAMILIES, VENDORS } from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'muretai-agent-entry.mjs');
const GUARD = join(HERE, 'fixtures', 'cli', 'loopback-only.mjs');

const T0 = 1790000000;
const iso = (t) => new Date(t * 1000).toISOString();
const DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const MARKER = 'Marker-Ada-4417 brass lamp';
const COVERAGE_KEYS = ['from', 'last_event', 'rows_dropped', 'store_present', 'to'];
const WHO_KEYS = ['declared', 'network', 'none', 'signed', 'stealth-agent'];

const scratch = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + (rows.length ? '\n' : '');

/** A project dir holding the log (and a store when asked): { dir, log, store }. */
function fixture(rows, { store = true } = {}) {
  const dir = tmp('ae-counts-cov-');
  const log = join(dir, 'visits.jsonl');
  writeFileSync(log, jsonl(rows));
  let storePath = null;
  if (store) {
    storePath = join(dir, 'ledger.json');
    writeFileSync(storePath, JSON.stringify({ v: 1, messages: [], accounts: [], deviceOwners: [], keyStates: [] }));
  }
  return { dir, log, store: storePath };
}

/** Run the bin with the loopback guard preloaded: { code, stdout, stderr, guard }. */
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

/** `counts --json` on a fixture; exit 0, exactly one JSON document, no DID and no text on stdout. */
async function countsJson(fx, { withStore = true } = {}) {
  const args = ['counts', '--json', '--log', fx.log, ...(withStore && fx.store ? ['--store', fx.store] : [])];
  const run = await runCli(args, fx.dir);
  assert.equal(run.code, 0, `counts --json: ${said(run)}`);
  assert.ok(!run.stdout.includes('did:'), `no DID anywhere in counts --json: ${said(run)}`);
  assert.ok(!run.stdout.includes(MARKER), 'no message text anywhere in counts --json');
  let out;
  assert.doesNotThrow(() => { out = JSON.parse(run.stdout); }, `stdout is one JSON document: ${said(run)}`);
  return out;
}

function assertShape(out) {
  assert.ok(out.coverage && typeof out.coverage === 'object' && !Array.isArray(out.coverage),
    `a coverage object: top-level keys ${JSON.stringify(Object.keys(out))}`);
  assert.deepEqual(Object.keys(out.coverage).sort(), COVERAGE_KEYS, `coverage keys: ${JSON.stringify(out.coverage)}`);
  assert.ok(out.who && typeof out.who === 'object' && !Array.isArray(out.who),
    `a who object: top-level keys ${JSON.stringify(Object.keys(out))}`);
  assert.deepEqual(Object.keys(out.who).sort(), WHO_KEYS, `who keys: ${JSON.stringify(out.who)}`);
  for (const tier of ['signed', 'declared', 'network']) {
    const map = out.who[tier];
    assert.ok(map && typeof map === 'object' && !Array.isArray(map), `who.${tier} is a map: ${JSON.stringify(map)}`);
    for (const [k, n] of Object.entries(map)) assert.ok(Number.isInteger(n) && n > 0, `who.${tier}.${k} is a positive count: ${n}`);
  }
  for (const k of ['stealth-agent', 'none']) assert.ok(Number.isInteger(out.who[k]) && out.who[k] >= 0, `who.${k} is a count: ${out.who[k]}`);
  // Bounded keyspace: nothing a client sends becomes a key.
  for (const k of Object.keys(out.who.signed)) assert.ok(VENDORS.includes(k), `who.signed names vendors only: ${k}`);
  for (const k of Object.keys(out.who.network)) assert.ok(VENDORS.includes(k), `who.network names vendors only: ${k}`);
  for (const k of Object.keys(out.who.declared)) assert.ok(AI_AGENT_FAMILIES.has(k), `who.declared names AI families only: ${k}`);
  // The keys counts --json printed before stay.
  for (const k of ['offers', 'referrals', 'returning_customers', 'knocks']) assert.ok(Object.hasOwn(out, k), `counts --json still has ${k}`);
}

// ---------------------------------------------------------------- the fixture log

// One row per case; every row is what fileSink(path) writes: `t` plus SINK_FIELDS only.
const FULL = [
  // not a knock: a card GET by a declared agent
  { t: T0, stage: 'card_get', ua_family: 'claude-user', client_class: 'declared-agent' },
  // signed + declared + network, all three
  { t: T0 + 10, stage: 'signed_post', offer: 'ask', reply: 'facts', identified: true, verified: true,
    signature_agent: 'openai', ua_family: 'openai', client_class: 'declared-agent', ip_vendor: 'openai', ms: 12 },
  // declared + network
  { t: T0 + 20, stage: 'signed_post', offer: 'ask', reply: 'facts', ua_family: 'claude-user',
    client_class: 'declared-agent', ip_vendor: 'anthropic', country: 'US', ms: 9 },
  // declared only
  { t: T0 + 30, stage: 'anon_post', ua_family: 'claude-user', client_class: 'declared-agent' },
  // network only, though its client_class is stealth-agent: a tier wins over the special categories
  { t: T0 + 40, stage: 'refused_post', refused: 'rate', ua_family: 'browser', client_class: 'stealth-agent', ip_vendor: 'aws' },
  // no tier, stealth-agent
  { t: T0 + 50, stage: 'signed_post', offer: 'ask', reply: 'facts', ua_family: 'browser', client_class: 'stealth-agent' },
  // no tier, a named tool: none
  { t: T0 + 60, stage: 'anon_post', ua_family: 'curl', client_class: 'named-tool' },
  // no tier, nothing at all: none
  { t: T0 + 70, stage: 'anon_post' },
  // not a knock: a page referral whose engine word is also a vendor word -- never merged into who
  { t: T0 + 80, stage: 'page', event: 'referral', engine: 'perplexity' },
  // signed only (a browser UA from an unnamed address that signed as anthropic)
  { t: T0 + 90, stage: 'signed_post', offer: 'ask', reply: 'facts', signature_agent: 'anthropic',
    ua_family: 'browser', client_class: 'stealth-agent' },
];
const FULL_WHO = {
  signed: { openai: 1, anthropic: 1 },
  declared: { openai: 1, 'claude-user': 2 },
  network: { openai: 1, anthropic: 1, aws: 1 },
  'stealth-agent': 1,
  none: 2,
};

// ---------------------------------------------------------------- functional

test('counts --json: a coverage header names the range, the last event, the store and no drops', async () => {
  const out = await countsJson(fixture(FULL));
  assertShape(out);
  assert.deepEqual(out.coverage, {
    from: iso(T0), to: iso(T0 + 90), last_event: iso(T0 + 90), store_present: true, rows_dropped: 0,
  });
});

test('counts --json: who counts door knocks in signed, declared, network, stealth-agent and none', async () => {
  const out = await countsJson(fixture(FULL));
  assertShape(out);
  assert.deepEqual(out.who, FULL_WHO);
  const knocks = FULL.filter((r) => ['signed_post', 'anon_post', 'refused_post'].includes(r.stage)).length;
  for (const tier of ['signed', 'declared', 'network']) {
    assert.ok(Object.values(out.who[tier]).reduce((a, n) => a + n, 0) <= knocks, `who.${tier} counts no more than the ${knocks} knocks`);
  }
});

test('counts --json: store_present is false when no --store is passed', async () => {
  const out = await countsJson(fixture(FULL, { store: false }), { withStore: false });
  assertShape(out);
  assert.equal(out.coverage.store_present, false, JSON.stringify(out.coverage));
  assert.equal(out.coverage.from, iso(T0));
  assert.equal(out.coverage.last_event, iso(T0 + 90));
});

test('counts --json: a page-only and GET-only log has a range but nobody under who', async () => {
  const out = await countsJson(fixture([
    { t: T0 + 5, stage: 'page', event: 'offer_started', offer: 'ask' },
    { t: T0 + 6, stage: 'card_get', ua_family: 'gptbot', client_class: 'declared-agent', ip_vendor: 'openai' },
    { t: T0 + 7, stage: 'page', event: 'referral', engine: 'chatgpt' },
  ]));
  assertShape(out);
  assert.deepEqual(out.coverage, { from: iso(T0 + 5), to: iso(T0 + 7), last_event: iso(T0 + 7), store_present: true, rows_dropped: 0 });
  assert.deepEqual(out.who, { signed: {}, declared: {}, network: {}, 'stealth-agent': 0, none: 0 });
});

// ---------------------------------------------------------------- edges and refusals

test('counts --json: an empty log is an empty header and an empty who, not a refusal', async () => {
  const out = await countsJson(fixture([]));
  assertShape(out);
  assert.deepEqual(out.coverage, { from: null, to: null, last_event: null, store_present: true, rows_dropped: 0 });
  assert.deepEqual(out.who, { signed: {}, declared: {}, network: {}, 'stealth-agent': 0, none: 0 });
});

test('counts --json: a missing log is refused (exit 1), naming the path, with no JSON on stdout', async () => {
  const fx = fixture([]);
  const missing = join(fx.dir, 'no-such-visits.jsonl');
  const run = await runCli(['counts', '--json', '--log', missing, '--store', fx.store], fx.dir);
  assert.equal(run.code, 1, said(run));
  assert.equal(run.stdout, '', `nothing on stdout: ${said(run)}`);
  assert.ok(run.stderr.includes(missing), `stderr names the missing log: ${said(run)}`);
});

test('counts --json: a log where no knock matches any tier counts every knock under none', async () => {
  const rows = [
    { t: T0 + 1, stage: 'anon_post' },
    { t: T0 + 2, stage: 'anon_post', ua_family: 'curl', client_class: 'named-tool' },
    { t: T0 + 3, stage: 'refused_post', refused: 'size', ua_family: 'other', client_class: 'human-like' },
    { t: T0 + 4, stage: 'signed_post', offer: 'ask', reply: 'facts', ua_family: 'muretai-node' },
  ];
  const out = await countsJson(fixture(rows));
  assertShape(out);
  assert.deepEqual(out.who, { signed: {}, declared: {}, network: {}, 'stealth-agent': 0, none: 4 });
  assert.deepEqual(out.coverage, { from: iso(T0 + 1), to: iso(T0 + 4), last_event: iso(T0 + 4), store_present: true, rows_dropped: 0 });
});

test('counts --json: rows the allowlist drops are counted in the header and seen nowhere else', async () => {
  const dropped = [
    // a key fileSink never writes, carrying a DID
    { t: T0 + 100, stage: 'signed_post', offer: 'ask', reply: 'facts', signature_agent: 'openai',
      ua_family: 'openai', client_class: 'declared-agent', ip_vendor: 'openai', did: DID },
    // a key fileSink never writes, carrying the message text
    { t: T0 + 110, stage: 'anon_post', ua_family: 'claude-user', client_class: 'declared-agent', text: MARKER },
    // an allowed key whose value is a DID: fileSink drops such a value, so no fileSink row has one
    { t: T0 + 120, stage: 'signed_post', offer: 'ask', reply: 'facts', signature_agent: DID, ip_vendor: 'aws' },
  ];
  const out = await countsJson(fixture([...FULL, ...dropped]));
  assertShape(out);
  assert.equal(out.coverage.rows_dropped, dropped.length, `the header counts the ${dropped.length} dropped rows: ${JSON.stringify(out.coverage)}`);
  assert.equal(out.coverage.to, iso(T0 + 90), `a dropped row does not extend the range: ${JSON.stringify(out.coverage)}`);
  assert.equal(out.coverage.last_event, iso(T0 + 90), `a dropped row is not the last event seen: ${JSON.stringify(out.coverage)}`);
  assert.equal(out.coverage.from, iso(T0));
  assert.deepEqual(out.who, FULL_WHO, 'a dropped row counts under no tier and no special category');
});

test('counts --json: a dropped row among kept rows is counted once, wherever it sits', async () => {
  const rows = [
    { t: T0 + 1, stage: 'anon_post', ua_family: 'claude-user', client_class: 'declared-agent', text: MARKER },
    { t: T0 + 2, stage: 'anon_post', ua_family: 'claude-user', client_class: 'declared-agent' },
    { t: T0 + 3, stage: 'anon_post', ua_family: 'gptbot', client_class: 'declared-agent', peer_did: DID },
    { t: T0 + 4, stage: 'anon_post', ua_family: 'gptbot', client_class: 'declared-agent' },
  ];
  const out = await countsJson(fixture(rows));
  assertShape(out);
  assert.deepEqual(out.coverage, { from: iso(T0 + 2), to: iso(T0 + 4), last_event: iso(T0 + 4), store_present: true, rows_dropped: 2 });
  assert.deepEqual(out.who, { signed: {}, declared: { 'claude-user': 1, gptbot: 1 }, network: {}, 'stealth-agent': 0, none: 0 });
});

test('counts --json: a value outside the bounded vocabularies never becomes a who key', async () => {
  // Short tokens fileSink would write if a door ever produced them; none is a vendor or an AI family.
  const rows = [
    { t: T0 + 1, stage: 'signed_post', offer: 'ask', reply: 'facts', signature_agent: 'evilcorp', ip_vendor: 'none', ua_family: 'x-made-up', client_class: 'stealth-agent' },
    { t: T0 + 2, stage: 'anon_post', ip_vendor: '__proto__', ua_family: 'constructor', client_class: 'declared-agent' },
    { t: T0 + 3, stage: 'anon_post', signature_agent: 'chatgpt', ip_vendor: 'Anthropic', ua_family: 'browser', client_class: 'stealth-agent' },
  ];
  const out = await countsJson(fixture(rows));
  assertShape(out);
  assert.deepEqual(out.who.signed, {}, `no forged signer is named: ${JSON.stringify(out.who.signed)}`);
  assert.deepEqual(out.who.network, {}, `no forged network vendor is named, and 'none' is never a vendor: ${JSON.stringify(out.who.network)}`);
  assert.deepEqual(out.who.declared, {}, `no forged family is named: ${JSON.stringify(out.who.declared)}`);
  assert.equal(out.coverage.rows_dropped + out.who['stealth-agent'] + out.who.none, rows.length,
    `each forged row is either dropped or counted once outside the tiers: ${JSON.stringify(out)}`);
});
