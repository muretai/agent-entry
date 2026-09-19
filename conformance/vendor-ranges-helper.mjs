#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * conformance/vendor-ranges-helper.mjs — the helper that FETCHES, held apart from the door that
 * never does.
 *
 * `scripts/vendor-ranges.mjs` downloads the vendors' published crawler ranges and Web Bot Auth
 * key directories, and writes two files an operator passes to `createAgentEntry`:
 *
 *   var/vendor-ranges.json   { fetched_at: <ISO 8601>, ranges: { <vendor>: [CIDR, …] } }
 *   var/wba-verifiers.json   [ { vendor: <vendor>, jwks: { keys: [ … ] } }, … ]
 *
 * `ranges` sits under its own key rather than beside `fetched_at` so the object can be handed to
 * `vendorRanges` as it is — that option refuses an unknown key, and `fetched_at` is one. The
 * directory file IS the array `wbaVerifiers` accepts.
 *
 * THE SEAM THESE TESTS DRIVE. The script exports `main(argv, { fetchImpl, cwd, now, stderr })`
 * and resolves to an exit code: `fetchImpl` stands in for `fetch`, `cwd` is where `var/` lives,
 * `now` is epoch milliseconds, `stderr` is anything with `write(string)`. Run as a CLI it uses
 * the real ones and exits with that code. Importing it does nothing.
 *
 * No network: every fetch here is a stub, and the CLI run preloads
 * conformance/fixtures/no-network-fetch.mjs.
 *
 * Run:  node conformance/vendor-ranges-helper.mjs   (from the package root; also in `npm test`)
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { createAgentEntry, publicKeyFromSeedHex } from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HELPER = join(ROOT, 'scripts', 'vendor-ranges.mjs');
const NO_NETWORK = join(HERE, 'fixtures', 'no-network-fetch.mjs');

let pass = 0;
const failures = [];

function check(ok, label, detail) {
  if (ok) { pass += 1; return true; }
  failures.push(detail ? `${label}\n      ${detail}` : label);
  return false;
}

async function section(name, fn) {
  try { await fn(); } catch (e) {
    check(false, `${name}/threw`, `${e && e.constructor ? e.constructor.name : 'Error'}: ${e && e.message}`);
  }
}

const VENDORS_WANT = ['openai', 'anthropic', 'google', 'microsoft', 'perplexity', 'apple',
  'meta', 'xai', 'cloudflare', 'aws', 'gcp', 'azure', 'fly', 'hetzner', 'other'];
const NOW = Date.parse('2026-09-19T06:00:00.000Z');
const HOUR = 3600 * 1000;

/** Which vendor a URL speaks for, by its host. The helper's own table decides the exact URLs
 *  (verified at implementation time); these tests decide only that what a host served lands
 *  under that host's vendor. */
function vendorOf(url) {
  const host = new URL(url).hostname;
  if (/(^|\.)(openai\.com|chatgpt\.com)$/.test(host)) return 'openai';
  if (/(^|\.)(google\.com|gstatic\.com|googleapis\.com|googleusercontent\.com)$/.test(host)) return 'google';
  if (/(^|\.)(bing\.com|microsoft\.com)$/.test(host)) return 'microsoft';
  if (/(^|\.)perplexity\.(ai|com)$/.test(host)) return 'perplexity';
  if (/(^|\.)cloudflare\.com$/.test(host)) return 'cloudflare';
  if (/(^|\.)(anthropic\.com|claude\.ai|claude\.com)$/.test(host)) return 'anthropic';
  if (/(^|\.)fly\.io$/.test(host)) return 'fly';
  return null;
}

const OPTIONAL_LARGE = /amazonaws\.com|\/cloud\.json|azure|servicetags|hetzner/i;

/** A stub `fetch`. Every range source gets its own CIDRs so the test can see where each landed;
 *  every key directory gets its own Ed25519 key. `mode` breaks it the ways the network does. */
function makeFetch({ mode = 'ok', fail = null, failAs = 'status' } = {}) {
  const log = [];
  const served = new Map();       // url -> { cidrs } | { jwk }
  let n = 0;
  const fetchImpl = async (input) => {
    const url = String(input && typeof input === 'object' && 'url' in input ? input.url : input);
    log.push(url);
    if (mode === 'throw') throw new TypeError('fetch failed');
    if (fail && fail.test(url)) {
      if (failAs === 'json') return new Response('{"prefixes": [', { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('upstream error', { status: 500 });
    }
    n += 1;
    if (/http-message-signatures-directory/.test(url)) {
      const seed = createHash('sha256').update(url).digest('hex');
      const jwk = { kty: 'OKP', crv: 'Ed25519', x: publicKeyFromSeedHex(seed).toString('base64url') };
      served.set(url, { jwk });
      return new Response(JSON.stringify({ keys: mode === 'empty' ? [] : [jwk] }),
        { status: 200, headers: { 'content-type': 'application/http-message-signatures-directory+json' } });
    }
    const v4 = `10.${n}.0.0/16`;
    const v6 = `2001:db8:${n.toString(16)}::/48`;
    if (/ips-v4/.test(url)) {
      served.set(url, { cidrs: [v4] });
      return new Response(mode === 'empty' ? '' : `${v4}\n`, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (/ips-v6/.test(url)) {
      served.set(url, { cidrs: [v6] });
      return new Response(mode === 'empty' ? '' : `${v6}\n`, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (/\.json(\?|$)/.test(new URL(url).pathname + new URL(url).search)) {
      served.set(url, { cidrs: [v4, v6] });
      const prefixes = mode === 'empty' ? [] : [{ ipv4Prefix: v4 }, { ipv6Prefix: v6 }];
      return new Response(JSON.stringify({ creationTime: '2026-09-19T00:00:00.000000', prefixes }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, log, served };
}

function sink() {
  const s = { text: '', write(chunk) { s.text += String(chunk); return true; } };
  return s;
}

const oneLine = (text) => /^[^\n]+\n?$/.test(text) && text.trim().length > 0;

function tmp() { return mkdtempSync(join(tmpdir(), 'agent-entry-vendor-ranges-')); }
const rangesPath = (cwd) => join(cwd, 'var', 'vendor-ranges.json');
const wbaPath = (cwd) => join(cwd, 'var', 'wba-verifiers.json');
const readOr = (p) => (existsSync(p) ? readFileSync(p) : null);

// ---------------------------------------------------------------- the helper exists, and importing it is inert
let main = null;
await section('import', async () => {
  check(existsSync(HELPER), 'helper/exists', 'scripts/vendor-ranges.mjs is missing');
  const repoVarBefore = existsSync(join(ROOT, 'var'));
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new TypeError('no network in tests'); };
  try {
    const mod = await import(pathToFileURL(HELPER).href);
    main = typeof mod.main === 'function' ? mod.main : null;
  } finally {
    globalThis.fetch = saved;
  }
  check(main !== null, 'helper/exports-main', 'no `main(argv, {fetchImpl, cwd, now, stderr})` export');
  check(calls === 0, 'helper/import-fetches-nothing', `${calls} fetch call(s) on import`);
  check(existsSync(join(ROOT, 'var')) === repoVarBefore, 'helper/import-writes-nothing', 'var/ appeared on import');
});

const run = async (cwd, fetch, { now = NOW, argv = [] } = {}) => {
  const stderr = sink();
  const code = await main(argv, { fetchImpl: fetch.fetchImpl, cwd, now, stderr });
  return { code, stderr: stderr.text };
};

// ---------------------------------------------------------------- normalisation
let goodRanges = null;
let goodWba = null;
await section('normalise', async () => {
  if (!main) { check(false, 'normalise/needs-main', ''); return; }
  const cwd = tmp();
  try {
    const f = makeFetch();
    const { code, stderr } = await run(cwd, f);
    check(code === 0, 'normalise/exit-0', `exit ${code}, stderr ${JSON.stringify(stderr)}`);
    check(f.log.every((u) => u.startsWith('https://')), 'normalise/https-only', f.log.filter((u) => !u.startsWith('https://')).join(', '));
    for (const name of ['gptbot.json', 'chatgpt-user.json', 'searchbot.json', 'googlebot.json',
      'special-crawlers.json', 'user-triggered-fetchers.json', 'bingbot.json', 'ips-v4', 'ips-v6']) {
      check(f.log.some((u) => u.includes(name)), `normalise/fetches-${name}`, `fetched: ${f.log.join(' ')}`);
    }
    check(f.log.some((u) => /chatgpt\.com\/\.well-known\/http-message-signatures-directory/.test(u)),
      'normalise/fetches-chatgpt-wba-directory', '');
    check(!f.log.some((u) => OPTIONAL_LARGE.test(u)), 'normalise/large-ranges-are-opt-in',
      `fetched by default: ${f.log.filter((u) => OPTIONAL_LARGE.test(u)).join(' ')}`);

    const file = JSON.parse(readFileSync(rangesPath(cwd), 'utf8'));
    goodRanges = file;
    check(file.fetched_at === new Date(NOW).toISOString(), 'normalise/fetched_at-is-now',
      `fetched_at ${JSON.stringify(file.fetched_at)}`);
    const ranges = file.ranges;
    check(ranges && typeof ranges === 'object' && !Array.isArray(ranges), 'normalise/ranges-object', JSON.stringify(Object.keys(file)));
    const keys = Object.keys(ranges || {});
    check(keys.length > 0 && keys.every((k) => VENDORS_WANT.includes(k)), 'normalise/vendors-from-the-table', JSON.stringify(keys));
    check(keys.every((k) => Array.isArray(ranges[k]) && ranges[k].every((c) => typeof c === 'string')),
      'normalise/vendor-maps-to-list-of-cidr-strings', '');
    for (const [url, got] of f.served) {
      if (!got.cidrs) continue;
      const vendor = vendorOf(url);
      if (vendor === null) continue;
      for (const cidr of got.cidrs) {
        check((ranges?.[vendor] || []).includes(cidr), `normalise/${new URL(url).pathname.split('/').pop()}-lands-under-${vendor}`,
          `${cidr} from ${url} is not under ranges.${vendor}`);
        const elsewhere = keys.filter((k) => k !== vendor && ranges[k].includes(cidr));
        check(elsewhere.length === 0, `normalise/${cidr}-only-under-${vendor}`, `also under ${elsewhere.join(', ')}`);
      }
    }
    let err = null;
    try { createAgentEntry({ seedHex: '55'.repeat(32), baseUrl: 'https://door.example', vendorRanges: ranges }); } catch (e) { err = e; }
    check(err === null, 'normalise/door-accepts-ranges-as-written', err ? err.message : '');

    const wba = JSON.parse(readFileSync(wbaPath(cwd), 'utf8'));
    goodWba = wba;
    check(Array.isArray(wba) && wba.length > 0, 'normalise/wba-verifiers-is-the-array-shape', JSON.stringify(wba).slice(0, 120));
    check(Array.isArray(wba) && wba.every((e) => e && VENDORS_WANT.includes(e.vendor) && Array.isArray(e.jwks?.keys) && e.jwks.keys.length > 0),
      'normalise/wba-entries-are-vendor-plus-jwks', '');
    for (const [url, got] of f.served) {
      if (!got.jwk) continue;
      const holder = Array.isArray(wba) ? wba.find((e) => (e.jwks?.keys || []).some((k) => k.x === got.jwk.x)) : null;
      check(Boolean(holder), `normalise/wba-key-from-${new URL(url).hostname}-kept`, '');
      if (/(^|\.)chatgpt\.com$/.test(new URL(url).hostname)) {
        check(holder && holder.vendor === 'openai', 'normalise/chatgpt-directory-is-openai', JSON.stringify(holder && holder.vendor));
      }
    }
    err = null;
    try { createAgentEntry({ seedHex: '55'.repeat(32), baseUrl: 'https://door.example', wbaVerifiers: wba }); } catch (e) { err = e; }
    check(err === null, 'normalise/door-accepts-wba-verifiers-as-written', err ? err.message : '');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/** A directory holding a GOOD cache written `ageMs` before NOW. */
function seeded(ageMs) {
  const cwd = tmp();
  mkdirSync(join(cwd, 'var'), { recursive: true });
  const ranges = goodRanges?.ranges ?? { openai: ['203.0.113.0/24'] };
  writeFileSync(rangesPath(cwd), `${JSON.stringify({ fetched_at: new Date(NOW - ageMs).toISOString(), ranges }, null, 2)}\n`);
  const wba = goodWba ?? [{ vendor: 'openai', jwks: { keys: [{ kty: 'OKP', crv: 'Ed25519', x: publicKeyFromSeedHex('a1'.repeat(32)).toString('base64url') }] } }];
  writeFileSync(wbaPath(cwd), `${JSON.stringify(wba, null, 2)}\n`);
  return cwd;
}

// ---------------------------------------------------------------- the 24 h refresh gate
await section('refresh-gate', async () => {
  if (!main) { check(false, 'refresh-gate/needs-main', ''); return; }
  const fresh = seeded(1 * HOUR);
  try {
    const before = [readOr(rangesPath(fresh)), readOr(wbaPath(fresh))];
    const f = makeFetch();
    const { code, stderr } = await run(fresh, f);
    check(code === 0, 'refresh-gate/fresh-cache-exit-0', `exit ${code} ${stderr}`);
    check(f.log.length === 0, 'refresh-gate/fresh-cache-fetches-nothing', `${f.log.length} fetch(es): ${f.log[0] || ''}`);
    check(before[0].equals(readOr(rangesPath(fresh))) && before[1].equals(readOr(wbaPath(fresh))),
      'refresh-gate/fresh-cache-untouched', '');
  } finally { rmSync(fresh, { recursive: true, force: true }); }

  const stale = seeded(25 * HOUR);
  try {
    const f = makeFetch();
    const { code, stderr } = await run(stale, f);
    check(code === 0, 'refresh-gate/stale-cache-exit-0', `exit ${code} ${stderr}`);
    check(f.log.length > 0, 'refresh-gate/stale-cache-refetches', '');
    const after = JSON.parse(readFileSync(rangesPath(stale), 'utf8'));
    check(after.fetched_at === new Date(NOW).toISOString(), 'refresh-gate/stale-cache-rewritten', JSON.stringify(after.fetched_at));
  } finally { rmSync(stale, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- failure never overwrites a good cache
await section('refuse-overwrite', async () => {
  if (!main) { check(false, 'refuse-overwrite/needs-main', ''); return; }
  const failures_ = [
    ['network-down', { mode: 'throw' }],
    ['every-source-empty', { mode: 'empty' }],
    ['one-range-source-500', { fail: /gptbot\.json/ }],
    ['one-range-source-bad-json', { fail: /googlebot\.json/, failAs: 'json' }],
    ['wba-directory-500', { fail: /chatgpt\.com\/\.well-known\/http-message-signatures-directory/ }],
  ];
  for (const [label, how] of failures_) {
    const cwd = seeded(48 * HOUR);
    try {
      const before = [readOr(rangesPath(cwd)), readOr(wbaPath(cwd))];
      const { code, stderr } = await run(cwd, makeFetch(how));
      check(typeof code === 'number' && code !== 0, `refuse-overwrite/${label}/non-zero-exit`, `exit ${code}`);
      check(oneLine(stderr), `refuse-overwrite/${label}/one-line-reason`, JSON.stringify(stderr));
      check(before[0].equals(readOr(rangesPath(cwd)) ?? Buffer.alloc(0)), `refuse-overwrite/${label}/ranges-cache-kept`, '');
      check(before[1].equals(readOr(wbaPath(cwd)) ?? Buffer.alloc(0)), `refuse-overwrite/${label}/wba-cache-kept`, '');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
  // With no cache at all, a failure writes nothing — never an empty file a door would load.
  const cwd = tmp();
  try {
    const { code, stderr } = await run(cwd, makeFetch({ mode: 'throw' }));
    check(typeof code === 'number' && code !== 0, 'refuse-overwrite/no-cache/non-zero-exit', `exit ${code}`);
    check(oneLine(stderr), 'refuse-overwrite/no-cache/one-line-reason', JSON.stringify(stderr));
    check(!existsSync(rangesPath(cwd)) && !existsSync(wbaPath(cwd)), 'refuse-overwrite/no-cache/writes-nothing', '');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- the CLI, offline
await section('cli', async () => {
  const cwd = tmp();
  try {
    const out = spawnSync(process.execPath, ['--import', pathToFileURL(NO_NETWORK).href, HELPER],
      { cwd, encoding: 'utf8', timeout: 30000 });
    check(out.status !== 0 && out.status !== null, 'cli/offline-exits-non-zero', `status ${out.status}`);
    check(oneLine(out.stderr || ''), 'cli/offline-one-line-reason', JSON.stringify(out.stderr));
    check(!existsSync(rangesPath(cwd)), 'cli/offline-writes-nothing', '');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- what the source must record
await section('source', async () => {
  const src = existsSync(HELPER) ? readFileSync(HELPER, 'utf8') : '';
  check(/\b20\d\d-\d\d-\d\d\b/.test(src), 'source/header-records-the-date-urls-were-checked', '');
  for (const [name, re] of [['aws', /amazonaws\.com/i], ['gcp', /cloud\.json/i], ['azure', /azure|servicetags/i], ['hetzner', /hetzner/i]]) {
    check(re.test(src), `source/optional-${name}-source-listed`, '');
  }
  check(/['"`]--[a-z][a-z-]+['"`]/.test(src), 'source/an-opt-in-flag-exists', 'the large ranges must sit behind a flag');
});

// ---------------------------------------------------------------- verdict
if (failures.length) {
  console.log(`\nFAILED — ${failures.length} of ${pass + failures.length} checks:\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('\nThe helper is the only code that fetches; a failure here is a door booting on a');
  console.log('half-written range file, or a network call nobody asked for.\n');
  process.exit(1);
}
console.log(`OK — ${pass} checks: the helper fetches, normalises, and never overwrites a good cache with a bad one.\n`);
