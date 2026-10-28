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

// ---------------------------------------------------------------- by country
//
// Intake 20261028T111224Z-2 (parent 20261003T131711Z), the predecessor of agent-entry-go's
// counts-html by-country cases, which spawn this CLI and expect the same shape:
//   json: a top-level `by_country` object, the key right after `who`. Each door knock
//     (signed_post, anon_post, refused_post) counts under its country. A knock with no country,
//     a page, card_get or notice_get row, and a dropped row add nothing. With no country data it
//     is {}, never missing.
//   text: exactly one line, right after `door knocks by client class:`, reading
//     `door knocks by country: JP 2, US 1, DE 1` in by_country order, or
//     `door knocks by country: none` when the map is empty.
//   The coverage header and the who block are the same whether or not countries are present.

/** Two JP knocks, one US, one DE; a knock with no country; page, card_get and notice_get rows
 *  carrying countries that must not be counted. by_country is { JP: 2, US: 1, DE: 1 }. */
function countryRows() {
  return [
    { t: T0 + 1, stage: 'signed_post', offer: 'ask', reply: 'facts', ua_family: 'claude-user',
      client_class: 'declared-agent', ip_vendor: 'anthropic', signature_agent: 'anthropic', country: 'JP' },
    { t: T0 + 2, stage: 'anon_post', ua_family: 'gptbot', client_class: 'declared-agent', ip_vendor: 'openai', country: 'US' },
    { t: T0 + 3, stage: 'refused_post', refused: 'rate', ua_family: 'other', client_class: 'stealth-agent', country: 'DE' },
    { t: T0 + 4, stage: 'refused_post', refused: 'size', ua_family: 'browser', client_class: 'human-like', country: 'JP' },
    { t: T0 + 5, stage: 'anon_post', ua_family: 'browser', client_class: 'human-like' },
    { t: T0 + 6, stage: 'page', event: 'referral', engine: 'chatgpt', country: 'FR' },
    { t: T0 + 7, stage: 'card_get', ua_family: 'claude-user', client_class: 'declared-agent', country: 'BR' },
    { t: T0 + 8, stage: 'notice_get', ua_family: 'gptbot', client_class: 'declared-agent', country: 'IN' },
  ];
}
const COUNTRY_MAP = { JP: 2, US: 1, DE: 1 };
const NOT_KNOCK_COUNTRIES = ['FR', 'BR', 'IN'];

const noCountryRows = () => countryRows().map((r) => {
  const copy = { ...r };
  delete copy.country;
  return copy;
});

/** `counts` (the text form) on a fixture: exit 0, no DID, the stdout lines. */
async function countsTextLines(fx) {
  const run = await runCli(['counts', '--log', fx.log, ...(fx.store ? ['--store', fx.store] : [])], fx.dir);
  assert.equal(run.code, 0, `counts: ${said(run)}`);
  assert.ok(!run.stdout.includes('did:'), `no DID anywhere in counts: ${said(run)}`);
  assert.ok(!run.stdout.includes(MARKER), 'no message text anywhere in counts');
  return run.stdout.split('\n');
}

const countryLineOf = (map) => {
  const entries = Object.entries(map);
  return `door knocks by country: ${entries.length ? entries.map(([k, n]) => `${k} ${n}`).join(', ') : 'none'}`;
};

function assertByCountry(out) {
  assert.ok(Object.hasOwn(out, 'by_country'), `a top-level by_country: keys ${JSON.stringify(Object.keys(out))}`);
  const map = out.by_country;
  assert.ok(map && typeof map === 'object' && !Array.isArray(map), `by_country is a map: ${JSON.stringify(map)}`);
  for (const [k, n] of Object.entries(map)) {
    assert.equal(typeof k, 'string');
    assert.ok(Number.isInteger(n) && n > 0, `by_country.${k} is a positive count: ${n}`);
  }
  const keys = Object.keys(out);
  assert.equal(keys.indexOf('by_country'), keys.indexOf('who') + 1, `by_country is the key right after who: ${keys.join(',')}`);
}

function assertCountryLine(lines, map) {
  const found = lines.filter((l) => l.startsWith('door knocks by country:'));
  assert.equal(found.length, 1, `exactly one country line: ${JSON.stringify(lines)}`);
  assert.equal(found[0], countryLineOf(map));
  const classAt = lines.findIndex((l) => l.startsWith('door knocks by client class:'));
  assert.ok(classAt >= 0, `the client class line is still there: ${JSON.stringify(lines)}`);
  assert.equal(lines[classAt + 1], found[0], `the country line follows the client class line: ${JSON.stringify(lines)}`);
}

test('counts --json: by_country counts each door knock under its country, right after who', async () => {
  const out = await countsJson(fixture(countryRows()));
  assertShape(out);
  assertByCountry(out);
  assert.deepEqual(out.by_country, COUNTRY_MAP);
  assert.deepEqual(Object.keys(out.by_country), ['JP', 'US', 'DE'], 'in first-seen order');
});

test('counts (text): one country line in by_country order, right after the client class line', async () => {
  const lines = await countsTextLines(fixture(countryRows()));
  assertCountryLine(lines, COUNTRY_MAP);
  assert.ok(lines.includes('door knocks by country: JP 2, US 1, DE 1'), JSON.stringify(lines));
});

test('counts: json and text agree on the same fixture rows', async () => {
  for (const rows of [countryRows(), noCountryRows(), []]) {
    const fx = fixture(rows);
    const out = await countsJson(fx);
    assertByCountry(out);
    assertCountryLine(await countsTextLines(fx), out.by_country);
  }
});

test('counts --json: countries do not change the coverage header or the who block', async () => {
  const withCountry = await countsJson(fixture(countryRows()));
  const without = await countsJson(fixture(noCountryRows()));
  assertShape(withCountry);
  assertShape(without);
  assertByCountry(withCountry);
  assertByCountry(without);
  assert.deepEqual(withCountry.coverage, without.coverage);
  assert.deepEqual(withCountry.who, without.who);
  assert.deepEqual(withCountry.coverage, {
    from: iso(T0 + 1), to: iso(T0 + 8), last_event: iso(T0 + 8), store_present: true, rows_dropped: 0,
  });
  assert.deepEqual(withCountry.who, {
    signed: { anthropic: 1 }, declared: { 'claude-user': 1, gptbot: 1 }, network: { anthropic: 1, openai: 1 },
    'stealth-agent': 1, none: 2,
  });
  // The full fixture's who and coverage pins above still hold beside the new key.
  const full = await countsJson(fixture(FULL));
  assertByCountry(full);
  assert.deepEqual(full.who, FULL_WHO);
  assert.equal(full.coverage.rows_dropped, 0);
});

test('counts: an empty log has by_country {} beside who, and the text says none', async () => {
  const fx = fixture([]);
  const out = await countsJson(fx);
  assertShape(out);
  assertByCountry(out);
  assert.deepEqual(out.by_country, {});
  assert.deepEqual(out.who, { signed: {}, declared: {}, network: {}, 'stealth-agent': 0, none: 0 });
  assertCountryLine(await countsTextLines(fx), {});
  assert.ok((await countsTextLines(fx)).includes('door knocks by country: none'));
});

test('counts: knocks with no country give by_country {}, and the text says none', async () => {
  const fx = fixture(noCountryRows());
  const out = await countsJson(fx);
  assertByCountry(out);
  assert.deepEqual(out.by_country, {});
  assert.ok(Object.keys(out.who.declared).length >= 1, 'the knocks are still counted under who');
  const lines = await countsTextLines(fx);
  assertCountryLine(lines, {});
  assert.ok(lines.includes('door knocks by country: none'), JSON.stringify(lines));
});

// ---------------------------------------------------------------- by country: refusals

test('counts --json: page, card_get and notice_get rows add no country', async () => {
  const fx = fixture([
    { t: T0 + 1, stage: 'page', event: 'referral', engine: 'chatgpt', country: 'FR' },
    { t: T0 + 2, stage: 'page', event: 'offer_started', offer: 'ask', country: 'JP' },
    { t: T0 + 3, stage: 'card_get', ua_family: 'claude-user', client_class: 'declared-agent', country: 'BR' },
    { t: T0 + 4, stage: 'notice_get', ua_family: 'gptbot', client_class: 'declared-agent', country: 'IN' },
  ]);
  const out = await countsJson(fx);
  assertByCountry(out);
  assert.deepEqual(out.by_country, {}, `no knock, no country: ${JSON.stringify(out.by_country)}`);
  assertCountryLine(await countsTextLines(fx), {});
  const mixed = await countsJson(fixture(countryRows()));
  for (const c of NOT_KNOCK_COUNTRIES) assert.equal(Object.hasOwn(mixed.by_country, c), false, `${c} is from a non-knock row`);
});

test('counts --json: a knock with no country adds nothing, not an empty or unknown key', async () => {
  const out = await countsJson(fixture([
    ...countryRows(),
    { t: T0 + 9, stage: 'signed_post', offer: 'ask', reply: 'facts', ua_family: 'claude-user', client_class: 'declared-agent' },
    { t: T0 + 10, stage: 'refused_post', refused: 'signature' },
  ]));
  assertByCountry(out);
  assert.deepEqual(out.by_country, COUNTRY_MAP);
  for (const k of ['', 'none', 'unknown', 'undefined', 'null']) assert.equal(Object.hasOwn(out.by_country, k), false, `no ${JSON.stringify(k)} key`);
});

test('counts --json: a dropped row adds no country, and is still counted in the header', async () => {
  const dropped = [
    { t: T0 + 100, stage: 'signed_post', offer: 'ask', reply: 'facts', ua_family: 'openai', did: DID, country: 'NZ' },
    { t: T0 + 110, stage: 'anon_post', ua_family: 'claude-user', text: MARKER, country: 'NZ' },
    { t: T0 + 120, stage: 'signed_post', signature_agent: DID, country: 'JP' },
    { t: T0 + 130, stage: 'anon_post', country: DID },
  ];
  const fx = fixture([...countryRows(), ...dropped]);
  const out = await countsJson(fx);
  assertShape(out);
  assertByCountry(out);
  assert.deepEqual(out.by_country, COUNTRY_MAP, `dropped rows add nothing: ${JSON.stringify(out.by_country)}`);
  assert.equal(out.coverage.rows_dropped, dropped.length, JSON.stringify(out.coverage));
  assertCountryLine(await countsTextLines(fx), COUNTRY_MAP);
});

// ---------------------------------------------------------------- by vendor
//
// Intake 20261028T150329Z (parent 20261003T131711Z, the backlog grouping parent), the shape
// agent-entry-go's counts page will read:
//   json: a top-level `by_vendor` object, the key right after `by_country`. Each door knock
//     (signed_post, anon_post, refused_post) counts under its vendor word: the row's `ip_vendor`,
//     the per-row vendor value the who block's network tier and the door's vendorStats() already
//     read, and only when it is one of VENDORS. A knock with no vendor word, a page, card_get or
//     notice_get row, and a dropped row add nothing. With no vendor data it is {}, never missing.
//     It is its own map: no other word map (who, by_country, referrals) gains or loses a key.
//   text: exactly one line, right after `door knocks by country:`, reading
//     `door knocks by vendor: openai 2, anthropic 1` in by_vendor order, or
//     `door knocks by vendor: none` when the map is empty.
//   The coverage header, the who block and by_country are the same whether or not vendors are present.

/** Two openai knocks, one anthropic; a knock with no vendor word; page, card_get and notice_get
 *  rows carrying vendors that must not be counted. by_vendor is { openai: 2, anthropic: 1 }. */
function vendorRows() {
  return [
    { t: T0 + 1, stage: 'signed_post', offer: 'ask', reply: 'facts', ua_family: 'openai',
      client_class: 'declared-agent', ip_vendor: 'openai', signature_agent: 'openai', country: 'JP' },
    { t: T0 + 2, stage: 'anon_post', ua_family: 'claude-user', client_class: 'declared-agent', ip_vendor: 'anthropic', country: 'US' },
    { t: T0 + 3, stage: 'refused_post', refused: 'rate', ua_family: 'browser', client_class: 'stealth-agent', ip_vendor: 'openai' },
    { t: T0 + 4, stage: 'anon_post', ua_family: 'curl', client_class: 'named-tool', country: 'JP' },
    { t: T0 + 5, stage: 'page', event: 'referral', engine: 'perplexity', ip_vendor: 'google' },
    { t: T0 + 6, stage: 'card_get', ua_family: 'gptbot', client_class: 'declared-agent', ip_vendor: 'microsoft' },
    { t: T0 + 7, stage: 'notice_get', ua_family: 'claude-user', client_class: 'declared-agent', ip_vendor: 'meta' },
  ];
}
const VENDOR_MAP = { openai: 2, anthropic: 1 };
const NOT_KNOCK_VENDORS = ['google', 'microsoft', 'meta'];
const DOOR_KNOCKS = ['signed_post', 'anon_post', 'refused_post'];

const noVendorRows = () => vendorRows().map((r) => {
  const copy = { ...r };
  delete copy.ip_vendor;
  return copy;
});

const vendorLineOf = (map) => {
  const entries = Object.entries(map);
  return `door knocks by vendor: ${entries.length ? entries.map(([k, n]) => `${k} ${n}`).join(', ') : 'none'}`;
};

function assertByVendor(out) {
  assert.ok(Object.hasOwn(out, 'by_vendor'), `a top-level by_vendor: keys ${JSON.stringify(Object.keys(out))}`);
  const map = out.by_vendor;
  assert.ok(map && typeof map === 'object' && !Array.isArray(map), `by_vendor is a map: ${JSON.stringify(map)}`);
  for (const [k, n] of Object.entries(map)) {
    assert.ok(VENDORS.includes(k), `by_vendor names vendors only: ${k}`);
    assert.ok(Number.isInteger(n) && n > 0, `by_vendor.${k} is a positive count: ${n}`);
  }
  const keys = Object.keys(out);
  assert.equal(keys.indexOf('by_vendor'), keys.indexOf('by_country') + 1, `by_vendor is the key right after by_country: ${keys.join(',')}`);
}

function assertVendorLine(lines, map) {
  const found = lines.filter((l) => l.startsWith('door knocks by vendor:'));
  assert.equal(found.length, 1, `exactly one vendor line: ${JSON.stringify(lines)}`);
  assert.equal(found[0], vendorLineOf(map));
  const countryAt = lines.findIndex((l) => l.startsWith('door knocks by country:'));
  assert.ok(countryAt >= 0, `the country line is still there: ${JSON.stringify(lines)}`);
  assert.equal(lines[countryAt + 1], found[0], `the vendor line follows the country line: ${JSON.stringify(lines)}`);
}

test('counts --json: by_vendor counts each door knock under its vendor word, right after by_country', async () => {
  const out = await countsJson(fixture(vendorRows()));
  assertShape(out);
  assertByCountry(out);
  assertByVendor(out);
  assert.deepEqual(out.by_vendor, VENDOR_MAP);
  assert.deepEqual(Object.keys(out.by_vendor), ['openai', 'anthropic'], 'in first-seen order');
});

test('counts (text): one vendor line in by_vendor order, right after the country line', async () => {
  const lines = await countsTextLines(fixture(vendorRows()));
  assertCountryLine(lines, { JP: 2, US: 1 });
  assertVendorLine(lines, VENDOR_MAP);
  assert.ok(lines.includes('door knocks by vendor: openai 2, anthropic 1'), JSON.stringify(lines));
});

test('counts: by_vendor json and the vendor line agree on the same fixture rows', async () => {
  for (const rows of [vendorRows(), noVendorRows(), countryRows(), FULL, []]) {
    const fx = fixture(rows);
    const out = await countsJson(fx);
    assertByVendor(out);
    const lines = await countsTextLines(fx);
    assertCountryLine(lines, out.by_country);
    assertVendorLine(lines, out.by_vendor);
  }
});

test('counts --json: vendors do not change the coverage header, the who block or by_country', async () => {
  const withV = await countsJson(fixture(vendorRows()));
  assertShape(withV);
  assertByCountry(withV);
  assertByVendor(withV);
  assert.deepEqual(withV.coverage, {
    from: iso(T0 + 1), to: iso(T0 + 7), last_event: iso(T0 + 7), store_present: true, rows_dropped: 0,
  });
  assert.deepEqual(withV.who, {
    signed: { openai: 1 }, declared: { openai: 1, 'claude-user': 1 }, network: { openai: 2, anthropic: 1 },
    'stealth-agent': 0, none: 1,
  });
  assert.deepEqual(withV.by_country, { JP: 2, US: 1 });
  // Non-knock rows carrying vendors move nothing: the same knocks alone give the same maps.
  const knocks = await countsJson(fixture(vendorRows().filter((r) => DOOR_KNOCKS.includes(r.stage))));
  assert.deepEqual(knocks.by_vendor, withV.by_vendor);
  assert.deepEqual(knocks.who, withV.who);
  assert.deepEqual(knocks.by_country, withV.by_country);
  // The pins already landed for the full and the country fixtures still hold beside the new key.
  const full = await countsJson(fixture(FULL));
  assertShape(full);
  assertByCountry(full);
  assertByVendor(full);
  assert.deepEqual(full.who, FULL_WHO);
  assert.deepEqual(full.coverage, { from: iso(T0), to: iso(T0 + 90), last_event: iso(T0 + 90), store_present: true, rows_dropped: 0 });
  assert.deepEqual(full.by_country, { US: 1 });
  assert.deepEqual(full.by_vendor, { openai: 1, anthropic: 1, aws: 1 });
  const country = await countsJson(fixture(countryRows()));
  assertByVendor(country);
  assert.deepEqual(country.by_country, COUNTRY_MAP);
  assert.deepEqual(country.by_vendor, { anthropic: 1, openai: 1 });
});

test('counts: an empty log has by_vendor {} beside by_country {}, and the text says none', async () => {
  const fx = fixture([]);
  const out = await countsJson(fx);
  assertShape(out);
  assertByCountry(out);
  assertByVendor(out);
  assert.deepEqual(out.by_vendor, {});
  assert.deepEqual(out.by_country, {});
  assert.deepEqual(out.coverage, { from: null, to: null, last_event: null, store_present: true, rows_dropped: 0 });
  assert.deepEqual(out.who, { signed: {}, declared: {}, network: {}, 'stealth-agent': 0, none: 0 });
  const lines = await countsTextLines(fx);
  assertVendorLine(lines, {});
  assert.ok(lines.includes('door knocks by vendor: none'), JSON.stringify(lines));
});

test('counts: knocks with no vendor word give by_vendor {}, and the text says none', async () => {
  const fx = fixture(noVendorRows());
  const out = await countsJson(fx);
  assertByVendor(out);
  assert.deepEqual(out.by_vendor, {});
  assert.deepEqual(out.by_country, { JP: 2, US: 1 }, 'the knocks are still counted by country');
  const lines = await countsTextLines(fx);
  assertVendorLine(lines, {});
  assert.ok(lines.includes('door knocks by vendor: none'), JSON.stringify(lines));
});

// ---------------------------------------------------------------- by vendor: refusals

test('counts --json: a knock with no vendor word, or one outside VENDORS, adds nothing', async () => {
  const fx = fixture([
    ...vendorRows(),
    { t: T0 + 10, stage: 'signed_post', offer: 'ask', reply: 'facts', ua_family: 'claude-user', client_class: 'declared-agent' },
    { t: T0 + 11, stage: 'anon_post', ip_vendor: null },
    { t: T0 + 12, stage: 'anon_post', ip_vendor: 'none' },
    { t: T0 + 13, stage: 'anon_post', ip_vendor: '' },
    { t: T0 + 14, stage: 'refused_post', refused: 'rate', ip_vendor: 'Anthropic' },
    { t: T0 + 15, stage: 'anon_post', ip_vendor: 'evilcorp' },
    { t: T0 + 16, stage: 'anon_post', ip_vendor: '__proto__' },
    { t: T0 + 17, stage: 'anon_post', ip_vendor: 'constructor' },
    { t: T0 + 18, stage: 'anon_post', ip_vendor: 7 },
  ]);
  const out = await countsJson(fx);
  assertShape(out);
  assertByVendor(out);
  assert.deepEqual(out.by_vendor, VENDOR_MAP, `no vendor word, no key: ${JSON.stringify(out.by_vendor)}`);
  for (const k of ['', 'none', 'unknown', 'undefined', 'null', 'Anthropic', 'evilcorp', '__proto__', 'constructor', '7']) {
    assert.equal(Object.hasOwn(out.by_vendor, k), false, `no ${JSON.stringify(k)} key`);
  }
  assertVendorLine(await countsTextLines(fx), VENDOR_MAP);
});

test('counts --json: a signer label or a UA family alone is not a vendor word', async () => {
  // The vendor word is ip_vendor; signature_agent and ua_family stay in who.signed and who.declared.
  const fx = fixture([
    { t: T0 + 1, stage: 'signed_post', offer: 'ask', reply: 'facts', signature_agent: 'anthropic', ua_family: 'browser', client_class: 'stealth-agent' },
    { t: T0 + 2, stage: 'anon_post', ua_family: 'openai', client_class: 'declared-agent' },
    { t: T0 + 3, stage: 'anon_post', ua_family: 'perplexity', client_class: 'declared-agent' },
  ]);
  const out = await countsJson(fx);
  assertShape(out);
  assertByVendor(out);
  assert.deepEqual(out.by_vendor, {}, JSON.stringify(out.by_vendor));
  assert.deepEqual(out.who.signed, { anthropic: 1 });
  assert.deepEqual(out.who.declared, { openai: 1, perplexity: 1 });
  assertVendorLine(await countsTextLines(fx), {});
});

test('counts --json: page, card_get and notice_get rows add no vendor', async () => {
  const fx = fixture([
    { t: T0 + 1, stage: 'page', event: 'referral', engine: 'perplexity', ip_vendor: 'perplexity' },
    { t: T0 + 2, stage: 'page', event: 'offer_started', offer: 'ask', ip_vendor: 'openai' },
    { t: T0 + 3, stage: 'card_get', ua_family: 'claude-user', client_class: 'declared-agent', ip_vendor: 'anthropic' },
    { t: T0 + 4, stage: 'notice_get', ua_family: 'gptbot', client_class: 'declared-agent', ip_vendor: 'openai' },
  ]);
  const out = await countsJson(fx);
  assertByVendor(out);
  assert.deepEqual(out.by_vendor, {}, `no knock, no vendor: ${JSON.stringify(out.by_vendor)}`);
  assertVendorLine(await countsTextLines(fx), {});
  const mixed = await countsJson(fixture(vendorRows()));
  for (const v of NOT_KNOCK_VENDORS) assert.equal(Object.hasOwn(mixed.by_vendor, v), false, `${v} is from a non-knock row`);
});

test('counts --json: a dropped row adds no vendor, and is still counted in the header', async () => {
  const dropped = [
    { t: T0 + 100, stage: 'signed_post', offer: 'ask', reply: 'facts', ip_vendor: 'openai', did: DID },
    { t: T0 + 110, stage: 'anon_post', ip_vendor: 'anthropic', text: MARKER },
    { t: T0 + 120, stage: 'signed_post', signature_agent: DID, ip_vendor: 'openai' },
    { t: T0 + 130, stage: 'anon_post', ip_vendor: DID },
    { t: T0 + 140, stage: 'anon_post', ip_vendor: 'xai', peer_did: DID },
  ];
  const fx = fixture([...vendorRows(), ...dropped]);
  const out = await countsJson(fx);
  assertShape(out);
  assertByVendor(out);
  assert.deepEqual(out.by_vendor, VENDOR_MAP, `dropped rows add nothing: ${JSON.stringify(out.by_vendor)}`);
  assert.equal(out.coverage.rows_dropped, dropped.length, JSON.stringify(out.coverage));
  assert.equal(out.coverage.to, iso(T0 + 7), JSON.stringify(out.coverage));
  assertVendorLine(await countsTextLines(fx), VENDOR_MAP);
});

test('counts --json: by_vendor is its own map, merged into no other word map', async () => {
  // perplexity is a referral engine, an AI family and a vendor; aws is a vendor and nothing else.
  const out = await countsJson(fixture([
    { t: T0 + 1, stage: 'page', event: 'referral', engine: 'perplexity' },
    { t: T0 + 2, stage: 'anon_post', ua_family: 'perplexity', client_class: 'declared-agent', country: 'FR' },
    { t: T0 + 3, stage: 'anon_post', ua_family: 'browser', client_class: 'stealth-agent', ip_vendor: 'perplexity' },
    { t: T0 + 4, stage: 'refused_post', refused: 'rate', ip_vendor: 'aws', country: 'DE' },
  ]));
  assertShape(out);
  assertByCountry(out);
  assertByVendor(out);
  assert.deepEqual(out.by_vendor, { perplexity: 1, aws: 1 });
  assert.deepEqual(out.referrals, { perplexity: 1 }, 'a knock vendor is not a referral');
  assert.deepEqual(out.by_country, { FR: 1, DE: 1 }, 'no vendor word in by_country');
  assert.deepEqual(out.who, {
    signed: {}, declared: { perplexity: 1 }, network: { perplexity: 1, aws: 1 }, 'stealth-agent': 0, none: 0,
  });
  for (const k of ['by_vendor', 'vendor', 'vendors']) {
    assert.equal(Object.hasOwn(out.who, k), false, `who gains no ${k}`);
    assert.equal(Object.hasOwn(out.knocks, k), false, `knocks gains no ${k}`);
  }
  assert.deepEqual(Object.keys(out.knocks).sort(), ['by_class', 'by_stage']);
});

// ---------------------------------------------------------------- by vendor: kind-fuzz
//
// Property (equivalent): for a seeded mix of fileSink-shaped and hostile rows, by_vendor equals an
// oracle that keeps sink rows, takes door knocks only and counts each VENDORS ip_vendor once, in
// first-seen order; the vendor line says the same; the CLI exits 0 on every log.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const FUZZ_STAGES = [...DOOR_KNOCKS, 'page', 'card_get', 'notice_get', 'other', 7, null];
const FUZZ_VENDORS = [...VENDORS, 'none', 'Anthropic', 'OPENAI', '', '__proto__', 'constructor', 'toString', DID, null, 3, true];
const FUZZ_EXTRA = [null, ['did', DID], ['text', MARKER], ['country', 'JP'], ['country', DID],
  ['signature_agent', 'openai'], ['ua_family', 'gptbot']];

function fuzzRows(seed, n) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const roll = r();
    if (roll < 0.04) { rows.push('{not json'); continue; }
    if (roll < 0.07) { rows.push('[1,2]'); continue; }
    const row = { t: T0 + i, stage: pick(FUZZ_STAGES) };
    if (r() < 0.8) row.ip_vendor = pick(FUZZ_VENDORS);
    const extra = pick(FUZZ_EXTRA);
    if (extra) row[extra[0]] = extra[1];
    rows.push(row);
  }
  return rows;
}

/** The generator only writes `did` and `text` outside the sink allowlist. */
function vendorOracle(rows) {
  const out = new Map();
  for (const raw of rows) {
    if (typeof raw === 'string') continue;
    if (Object.hasOwn(raw, 'did') || Object.hasOwn(raw, 'text')) continue;
    if (Object.values(raw).some((v) => typeof v === 'string' && v.startsWith('did:'))) continue;
    if (!DOOR_KNOCKS.includes(raw.stage)) continue;
    if (typeof raw.ip_vendor !== 'string' || !VENDORS.includes(raw.ip_vendor)) continue;
    out.set(raw.ip_vendor, (out.get(raw.ip_vendor) || 0) + 1);
  }
  return Object.fromEntries(out);
}

test('counts kind-fuzz: by_vendor equals the oracle over seeded hostile logs, json and text alike', async () => {
  for (const seed of [1, 4417, 20261028]) {
    const rows = fuzzRows(seed, 160);
    const fx = fixture(rows);
    const out = await countsJson(fx);
    assertShape(out);
    assertByVendor(out);
    const want = vendorOracle(rows);
    assert.deepEqual(out.by_vendor, want, `seed ${seed}`);
    assert.deepEqual(Object.keys(out.by_vendor), Object.keys(want), `seed ${seed}: first-seen order`);
    assertVendorLine(await countsTextLines(fx), want);
  }
});
