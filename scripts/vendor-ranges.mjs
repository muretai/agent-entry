#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * scripts/vendor-ranges.mjs — fetch the vendors' published crawler ranges and Web Bot Auth key
 * directories into the two files a door hands to `createAgentEntry`:
 *
 *   var/vendor-ranges.json   { fetched_at: <ISO 8601>, ranges: { <vendor>: [CIDR, …] } }
 *                            -> createAgentEntry({ vendorRanges: file.ranges, … })
 *   var/wba-verifiers.json   [ { vendor, jwks: { keys: [ … ] } }, … ]
 *                            -> createAgentEntry({ wbaVerifiers: file, … })
 *
 * THE DOOR NEVER RUNS THIS. `muretai-agent-entry.mjs` makes no network call and never imports
 * anything under scripts/; this is the one place that fetches, run at boot or from cron. A door
 * boots fine without either file — the options are simply unset.
 *
 *   node scripts/vendor-ranges.mjs            refresh when the cache is older than 24 h
 *   node scripts/vendor-ranges.mjs --force    refresh now
 *   node scripts/vendor-ranges.mjs --large    also fetch the large cloud lists (AWS, GCP)
 *
 * NEVER A HALF-WRITTEN CACHE. Every source is fetched and checked, and the result is validated
 * by constructing a door with it, BEFORE either file is touched. Any failure — a network error,
 * an HTTP error, unparseable JSON, a source that lists nothing, a directory with no Ed25519 key
 * — leaves both files exactly as they were and exits 1 with a one-line reason on stderr.
 * `var/` is created on demand, relative to the working directory.
 *
 * SOURCES. Table written 2026-09-19 from each vendor's documentation. It was NOT fetched from
 * the session that wrote it (no network there), so the first real run is the check of every
 * URL below: a URL that moved fails the run loudly, it never yields a silently smaller list.
 *
 *   openai       https://openai.com/gptbot.json, chatgpt-user.json, searchbot.json
 *   google       https://developers.google.com/static/search/apis/ipranges/googlebot.json,
 *                special-crawlers.json, user-triggered-fetchers.json (Google also documents a
 *                user-triggered-fetchers-google.json; add it once confirmed)
 *   microsoft    https://www.bing.com/toolbox/bingbot.json
 *   perplexity   https://www.perplexity.com/perplexitybot.json, perplexity-user.json
 *   cloudflare   https://www.cloudflare.com/ips-v4, ips-v6 (plain text, one CIDR per line)
 *   aws    (--large)  https://ip-ranges.amazonaws.com/ip-ranges.json
 *   gcp    (--large)  https://www.gstatic.com/ipranges/cloud.json
 *
 * MANUAL — listed, never fetched, because no machine-readable list exists to fetch:
 *
 *   anthropic    publishes its addresses on an HTML docs page only
 *   fly          no published list; egress addresses are per app
 *   azure        the Service Tags JSON lives at a download URL that rotates weekly
 *   hetzner      no official list (ASN 24940)
 *
 *   Add those by hand to the object you pass the door: { ...file.ranges, anthropic: [...] }.
 *
 * WEB BOT AUTH DIRECTORIES (RFC 9421 key directories, `/.well-known/http-message-signatures-directory`):
 *
 *   openai       https://chatgpt.com/.well-known/http-message-signatures-directory
 *
 *   Google's, Shopify's and Cloudflare's directories were named in the brief; their hosts were
 *   not confirmed on 2026-09-19, so they are not fetched. Add an entry to WBA_DIRECTORIES once a
 *   host is confirmed. The directory is trusted by its TLS origin; its own response signature is
 *   not checked here.
 */

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgentEntry } from '../muretai-agent-entry.mjs';

const GOOGLE_RANGES = 'https://developers.google.com/static/search/apis/ipranges';

/** Every range source a run may fetch. `shape` says how its body lists CIDRs; `large` sources
 *  are fetched only under `--large`. */
export const RANGE_SOURCES = [
  { vendor: 'openai', url: 'https://openai.com/gptbot.json', shape: 'prefixes' },
  { vendor: 'openai', url: 'https://openai.com/chatgpt-user.json', shape: 'prefixes' },
  { vendor: 'openai', url: 'https://openai.com/searchbot.json', shape: 'prefixes' },
  { vendor: 'google', url: `${GOOGLE_RANGES}/googlebot.json`, shape: 'prefixes' },
  { vendor: 'google', url: `${GOOGLE_RANGES}/special-crawlers.json`, shape: 'prefixes' },
  { vendor: 'google', url: `${GOOGLE_RANGES}/user-triggered-fetchers.json`, shape: 'prefixes' },
  { vendor: 'microsoft', url: 'https://www.bing.com/toolbox/bingbot.json', shape: 'prefixes' },
  { vendor: 'perplexity', url: 'https://www.perplexity.com/perplexitybot.json', shape: 'prefixes' },
  { vendor: 'perplexity', url: 'https://www.perplexity.com/perplexity-user.json', shape: 'prefixes' },
  { vendor: 'cloudflare', url: 'https://www.cloudflare.com/ips-v4', shape: 'lines' },
  { vendor: 'cloudflare', url: 'https://www.cloudflare.com/ips-v6', shape: 'lines' },
  { vendor: 'aws', url: 'https://ip-ranges.amazonaws.com/ip-ranges.json', shape: 'aws', large: true },
  { vendor: 'gcp', url: 'https://www.gstatic.com/ipranges/cloud.json', shape: 'prefixes', large: true },
];

/** Vendors with no machine-readable list: never fetched, named so an operator knows why. */
export const MANUAL = [
  { vendor: 'anthropic', doc: 'https://docs.anthropic.com/en/api/ip-addresses', why: 'an HTML docs page only' },
  { vendor: 'fly', doc: 'https://fly.io/docs/networking/', why: 'no published list; egress is per app' },
  { vendor: 'azure', doc: 'https://www.microsoft.com/en-us/download/details.aspx?id=56519', why: 'Service Tags download URL rotates weekly' },
  { vendor: 'hetzner', doc: 'https://www.hetzner.com/', why: 'no official list (ASN 24940)' },
];

/** Web Bot Auth key directories, each labelled with the vendor its keys speak for. */
export const WBA_DIRECTORIES = [
  { vendor: 'openai', url: 'https://chatgpt.com/.well-known/http-message-signatures-directory' },
];

const FLAGS = new Set(['--large', '--force']);
const REFRESH_MS = 24 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 32 * 1024 * 1024;

/** A failure with the one line the operator reads. */
class Refusal extends Error {}

async function get(fetchImpl, url, accept) {
  if (!url.startsWith('https://')) throw new Refusal(`${url} is not https`);
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new Refusal(`${url}: ${e && e.message ? e.message : 'fetch failed'}`);
  }
  if (!res || !res.ok) throw new Refusal(`${url} answered HTTP ${res ? res.status : '?'}`);
  const text = await res.text();
  if (text.length > MAX_BODY_CHARS) throw new Refusal(`${url} is larger than ${MAX_BODY_CHARS} characters`);
  return text;
}

function json(url, text) {
  try { return JSON.parse(text); } catch { throw new Refusal(`${url} is not valid JSON`); }
}

/** The CIDR strings a range source lists, in its own shape. */
function cidrsOf(source, text) {
  if (source.shape === 'lines') {
    return text.split(/\s+/).filter((s) => s !== '');
  }
  const doc = json(source.url, text);
  const list = (key) => {
    const v = doc && typeof doc === 'object' ? doc[key] : undefined;
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Refusal(`${source.url}: "${key}" is not an array`);
    return v;
  };
  const pick = (entry, names) => {
    for (const n of names) if (entry && typeof entry[n] === 'string') return entry[n];
    throw new Refusal(`${source.url}: an entry names no ${names.join(' / ')}`);
  };
  if (source.shape === 'aws') {
    return [...list('prefixes').map((e) => pick(e, ['ip_prefix'])),
      ...list('ipv6_prefixes').map((e) => pick(e, ['ipv6_prefix']))];
  }
  return list('prefixes').map((e) => pick(e, ['ipv4Prefix', 'ipv6Prefix']));
}

/** The Ed25519 keys of one directory, reduced to {kty, crv, x}. */
function keysOf(dir, text) {
  const doc = json(dir.url, text);
  const keys = doc && typeof doc === 'object' && Array.isArray(doc.keys) ? doc.keys : [];
  const ed = keys
    .filter((k) => k && k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string')
    .map((k) => ({ kty: 'OKP', crv: 'Ed25519', x: k.x }));
  if (ed.length === 0) throw new Refusal(`${dir.url} lists no Ed25519 key`);
  return ed;
}

/** True when both cache files exist, parse, and the ranges were fetched under 24 h ago. */
function fresh(rangesFile, wbaFile, now) {
  try {
    const cached = JSON.parse(readFileSync(rangesFile, 'utf8'));
    const wba = JSON.parse(readFileSync(wbaFile, 'utf8'));
    const at = Date.parse(cached.fetched_at);
    const age = now - at;
    return Array.isArray(wba) && cached.ranges && typeof cached.ranges === 'object'
      && Number.isFinite(at) && age >= 0 && age < REFRESH_MS;
  } catch {
    return false;
  }
}

/** Write through a temporary name and rename, so a reader never sees half a file. */
function writeAtomically(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Run once. Resolves to the exit code: 0 written or already fresh, 1 anything else, with
 * exactly one line on `stderr`. `fetchImpl` stands in for `fetch`, `cwd` is where `var/`
 * lives, `now` is epoch milliseconds.
 */
export async function main(argv = [], {
  fetchImpl = globalThis.fetch, cwd = process.cwd(), now = Date.now(), stderr = process.stderr,
  stdout = null,
} = {}) {
  try {
    const unknown = argv.filter((a) => !FLAGS.has(a));
    if (unknown.length) throw new Refusal(`unknown argument ${JSON.stringify(unknown[0])} (known: ${[...FLAGS].join(', ')})`);
    const large = argv.includes('--large');
    const force = argv.includes('--force');
    const dir = join(cwd, 'var');
    const rangesFile = join(dir, 'vendor-ranges.json');
    const wbaFile = join(dir, 'wba-verifiers.json');
    if (!force && fresh(rangesFile, wbaFile, now)) {
      if (stdout) stdout.write('vendor-ranges: cache is under 24 h old; nothing fetched (--force to refresh)\n');
      return 0;
    }
    if (typeof fetchImpl !== 'function') throw new Refusal('no fetch available (Node 20+ has one)');

    const sources = RANGE_SOURCES.filter((s) => large || !s.large);
    const [lists, directories] = await Promise.all([
      Promise.all(sources.map(async (s) => {
        const cidrs = cidrsOf(s, await get(fetchImpl, s.url, s.shape === 'lines' ? 'text/plain' : 'application/json'));
        // A list that had ranges yesterday and has none today is a broken fetch, not news.
        if (cidrs.length === 0) throw new Refusal(`${s.url} listed no ranges`);
        return [s.vendor, cidrs];
      })),
      Promise.all(WBA_DIRECTORIES.map(async (d) => ({
        vendor: d.vendor,
        jwks: { keys: keysOf(d, await get(fetchImpl, d.url, 'application/http-message-signatures-directory+json')) },
      }))),
    ]);
    const ranges = {};
    for (const [vendor, cidrs] of lists) {
      ranges[vendor] = [...new Set([...(ranges[vendor] || []), ...cidrs])];
    }

    // The door is the judge of what it will accept: a file it would refuse to start with is
    // never written.
    try {
      createAgentEntry({ seedHex: '00'.repeat(32), baseUrl: 'https://vendor-ranges.invalid',
        vendorRanges: ranges, wbaVerifiers: directories });
    } catch (e) {
      throw new Refusal(`the door would refuse this result: ${e.message}`);
    }

    mkdirSync(dir, { recursive: true });
    writeAtomically(rangesFile, { fetched_at: new Date(now).toISOString(), ranges });
    writeAtomically(wbaFile, directories);
    if (stdout) {
      const n = Object.values(ranges).reduce((k, l) => k + l.length, 0);
      stdout.write(`vendor-ranges: wrote ${n} ranges for ${Object.keys(ranges).join(', ')} and `
        + `${directories.reduce((k, d) => k + d.jwks.keys.length, 0)} Web Bot Auth key(s); `
        + `not fetched (no machine-readable list): ${MANUAL.map((m) => m.vendor).join(', ')}\n`);
    }
    return 0;
  } catch (e) {
    const why = e instanceof Refusal ? e.message : `unexpected: ${e && e.message ? e.message : String(e)}`;
    stderr.write(`vendor-ranges: ${why.replace(/\s+/g, ' ').trim().slice(0, 400)}\n`);
    return 1;
  }
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1])
      && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2), { stdout: process.stdout }).then((code) => { process.exitCode = code; });
}
