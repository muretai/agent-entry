#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * conformance/who-is-knocking.mjs — "Who is knocking" v2: vendor ranges, country, and Web Bot
 * Auth recognition as OBSERVATION (AE-31, AE-32).
 *
 * WHAT THIS HOLDS THE DOOR TO. Three new observer fields — `ip_vendor`, `country`,
 * `signature_agent` — each one of a fixed table the door chose, and `entry.vendorStats()`
 * beside `stats()` / `clientStats()`. And the rule that makes them safe to add at all: they are
 * observation, never identity. The same message gets the same verdict, the same account row,
 * the same rate lane and the same refusal bytes whether `trustProxy` is on or off, whether
 * `vendorRanges` is configured or not, and whether a forged `CF-Connecting-IP` names an OpenAI
 * address. Only the observer's three fields may differ. That invariant is the first block below
 * and it is the one that matters; everything after it is the functional half.
 *
 * NO IP LEAVES THE PROCESS. The client address is held for one request. Every block scans what
 * the door exposes — `stats()`, `clientStats()`, `vendorStats()`, the ledger, observer and
 * responder envelopes, anything written to the console, and every wire byte — for the literal
 * test addresses.
 *
 * HOW THE SOCKET ADDRESS REACHES AN IN-PROCESS CALL. `handleRequest` / `handleRequestAsync`
 * take a FIFTH argument, `{ remoteAddress }`, spelled as Node's `req.socket.remoteAddress`, and
 * `listen()` passes the real socket's. That is the seam this file stubs; the last block drives a
 * real loopback `listen()` to prove the wiring. No network beyond 127.0.0.1.
 *
 * Run:  node conformance/who-is-knocking.mjs      (from the package root; also in `npm test`)
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as door from '../muretai-agent-entry.mjs';

const {
  AGENT_CARD_PATH, createAgentEntry, didFromPublicKeyHex, publicKeyFromSeedHex, signBytes,
  signEnvelope,
} = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0;
const failures = [];
const notes = [];

function check(ok, label, detail) {
  if (ok) { pass += 1; return true; }
  failures.push(detail ? `${label}\n      ${detail}` : label);
  return false;
}

/** One block, and a throw inside it is ONE red row rather than the end of the run — so the
 *  untouched branch reports every missing behaviour instead of the first. */
async function section(name, fn) {
  try { await fn(); } catch (e) {
    check(false, `${name}/threw`, `${e && e.constructor ? e.constructor.name : 'Error'}: ${e && e.message}`);
  }
}

// ---------------------------------------------------------------- fixtures

/** The fixed table, in the brief's order. */
const VENDORS_WANT = ['openai', 'anthropic', 'google', 'microsoft', 'perplexity', 'apple',
  'meta', 'xai', 'cloudflare', 'aws', 'gcp', 'azure', 'fly', 'hetzner', 'other'];
const NEW_FIELDS = ['ip_vendor', 'country', 'signature_agent'];
const STAGES = ['card_get', 'notice_get', 'anon_post', 'signed_post', 'refused_post'];

const DOOR_SEED = '55'.repeat(32);
const VISITOR_SEED = '44'.repeat(32);
const WBA_A = 'a1'.repeat(32);        // configured, labelled openai (array) / other (legacy)
const WBA_B = 'b2'.repeat(32);        // configured, labelled google (array)
const WBA_C = 'c3'.repeat(32);        // NEVER configured: an unrecognised signer
const BASE_URL = 'https://door.example';
const AUTHORITY = 'door.example';
const FIXED_TS = 1767225600;

// Test addresses, all distinctive enough that a substring hit is a leak and not a coincidence.
const FORGED_CF_IP = '203.0.113.77';      // in the openai range: the forgery the invariant uses
const FLY_HDR_IP = '192.0.2.44';          // anthropic
const XFF_FIRST = '100.64.1.9';           // google
const XFF_SECOND = '172.16.5.5';          // microsoft — must never win: only the FIRST hop counts
const SOCKET_IP = '198.51.100.23';        // fly
const UNMATCHED_SOCKET = '198.18.0.1';    // in no range
const ALL_TEST_IPS = [FORGED_CF_IP, FLY_HDR_IP, XFF_FIRST, XFF_SECOND, SOCKET_IP, UNMATCHED_SOCKET];

const RANGES = {
  openai: ['203.0.113.0/24'],
  anthropic: ['192.0.2.0/24'],
  google: ['100.64.0.0/10'],
  microsoft: ['172.16.0.0/12'],
  fly: ['198.51.100.0/24'],
};

const FORGED = {
  'user-agent': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)',
  'content-type': 'application/json',
  'cf-connecting-ip': FORGED_CF_IP,
  'cf-ipcountry': 'JP',
  'fly-client-ip': FLY_HDR_IP,
  'x-forwarded-for': `${XFF_FIRST}, ${XFF_SECOND}`,
};

const didOf = (seed) => didFromPublicKeyHex(publicKeyFromSeedHex(seed));
const jwkOf = (seed) => ({ kty: 'OKP', crv: 'Ed25519', x: publicKeyFromSeedHex(seed).toString('base64url') });
function keyidOf(seed) {
  const x = publicKeyFromSeedHex(seed).toString('base64url');
  return createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`, 'utf8').digest('base64url');
}

/** A Web Bot Auth header set (RFC 9421, tag web-bot-auth) over @authority + signature-agent,
 *  built the way conformance/vectors.json's `webBotAuth` group spells it. The control in the
 *  signature_agent block proves this builder verifies on the door as it stands. */
function wbaHeaders(seed, authority = AUTHORITY, agentUrl = 'https://agent.example') {
  const now = Math.floor(Date.now() / 1000);
  const sa = `"${agentUrl}"`;
  const params = `("@authority" "signature-agent");created=${now};expires=${now + 60};`
    + `keyid="${keyidOf(seed)}";alg="ed25519";tag="web-bot-auth"`;
  const base = `"@authority": ${authority}\n"signature-agent": ${sa}\n"@signature-params": ${params}`;
  const sig = signBytes(seed, Buffer.from(base, 'utf8')).toString('base64');
  return { 'signature-agent': sa, 'signature-input': `sig1=${params}`, signature: `sig1=:${sig}:` };
}

function rpc(messageId, text, metadata) {
  return Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', parts: [{ kind: 'text', text }],
      messageId, contextId: null, metadata } },
  }), 'utf8');
}

function signedBody(seed, toDid, messageId, text = 'book a table', { tamper = false } = {}) {
  const from = didOf(seed);
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signEnvelope(seed, { from, to: toDid, messageId, contextId: null, timestamp, text });
  return rpc(messageId, tamper ? `${text}!` : text, { timestamp, from, to: toDid, sig });
}

const anonBody = (messageId, text = 'what can I book?') =>
  rpc(messageId, text, { timestamp: Math.floor(Date.now() / 1000) });

/** Key-order-independent JSON, so two envelopes compare by content. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object' && !Buffer.isBuffer(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

const without = (env, keys) => Object.fromEntries(Object.entries(env).filter(([k]) => !keys.includes(k)));

/** A signed reply differs between two runs by exactly its fresh `messageId` and the `sig` that
 *  covers it; the responder pins text and timestamp. Everything else is compared byte for byte,
 *  and every REFUSAL (no `result`) is compared unmasked. */
function wireView(out) {
  const text = out.body ? Buffer.from(out.body).toString('utf8') : '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON: compare raw */ }
  if (parsed && parsed.result) {
    const mask = (v) => {
      if (Array.isArray(v)) return v.map(mask);
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).map(([k, x]) =>
          [k, (k === 'messageId' || k === 'sig') ? '<per-reply>' : mask(x)]));
      }
      return v;
    };
    const headers = without(out.headers || {}, ['Content-Length', 'content-length']);
    return `${out.status} ${stable(headers)} ${stable(mask(parsed))}`;
  }
  return `${out.status} ${stable(out.headers || {})} ${text}`;
}

function ledgerView(entry) {
  const mask = (row) => Object.fromEntries(Object.entries(row || {}).map(([k, v]) =>
    [k, /seen|_at$|^ts$/.test(k) ? '<time>' : v]));
  return stable([...entry.ledger].map(([k, row]) => [k, mask(row)]));
}

function wireText(outs) {
  return outs.map((o) => `${stable(o.headers || {})}\n${o.body ? Buffer.from(o.body).toString('latin1') : ''}`).join('\n');
}

/** The door, with a recording observer and responder. Each call builds a FRESH entry, so two
 *  configurations never share a replay set or a rate window. */
function makeDoor(opts = {}, sink = {}) {
  sink.obs = []; sink.resp = [];
  return createAgentEntry({
    seedHex: DOOR_SEED, name: 'knocking-v2', baseUrl: BASE_URL,
    anonymousLane: true, anonRatePerMin: 2, signedRatePerMin: 2,
    responder: (env) => { sink.resp.push(env); return { text: 'ok', timestamp: FIXED_TS }; },
    observer: (env) => { sink.obs.push(env); },
    ...opts,
  });
}

const send = (entry, r, remoteAddress) =>
  entry.handleRequestAsync(r.method, r.path, r.headers, r.body ?? Buffer.alloc(0), { remoteAddress });

async function drive(opts, script, remoteAddress = SOCKET_IP) {
  const sink = {};
  const entry = makeDoor(opts, sink);
  const wire = [];
  for (const r of script) wire.push(await send(entry, r, remoteAddress));
  return { entry, obs: sink.obs, resp: sink.resp, wire };
}

/** One card GET from `remoteAddress` with `headers`; the observer's envelope for it. */
async function probe(entry, sink, remoteAddress, headers = {}) {
  const before = sink.obs.length;
  await send(entry, { method: 'GET', path: AGENT_CARD_PATH, headers }, remoteAddress);
  return sink.obs[before] ?? null;
}

function scanForIps(label, text) {
  const hits = ALL_TEST_IPS.filter((ip) => text.includes(ip));
  check(hits.length === 0, label, hits.length ? `found ${hits.join(', ')}` : '');
}

const DID_TO = didOf(DOOR_SEED);

// The one script the invariant replays under every configuration. Built ONCE, so every door
// sees the same bytes, including the same timestamps and messageIds.
const SCRIPT = [
  { label: 'card', method: 'GET', path: AGENT_CARD_PATH, headers: FORGED },
  { label: 'notice', method: 'GET', path: '/', headers: FORGED },
  { label: 'head-card', method: 'HEAD', path: AGENT_CARD_PATH, headers: FORGED },
  { label: 'anon-1', method: 'POST', path: '/', headers: FORGED, body: anonBody('anon-1') },
  { label: 'anon-2', method: 'POST', path: '/', headers: FORGED, body: anonBody('anon-2') },
  { label: 'anon-3-over-the-lane', method: 'POST', path: '/', headers: FORGED, body: anonBody('anon-3') },
  { label: 'signed-1', method: 'POST', path: '/', headers: FORGED, body: signedBody(VISITOR_SEED, DID_TO, 'signed-1') },
  { label: 'signed-1-replay', method: 'POST', path: '/', headers: FORGED, body: signedBody(VISITOR_SEED, DID_TO, 'signed-1') },
  { label: 'signed-2', method: 'POST', path: '/', headers: FORGED, body: signedBody(VISITOR_SEED, DID_TO, 'signed-2') },
  { label: 'signed-3-over-the-account-lane', method: 'POST', path: '/', headers: FORGED, body: signedBody(VISITOR_SEED, DID_TO, 'signed-3') },
  { label: 'bad-signature', method: 'POST', path: '/', headers: FORGED, body: signedBody(VISITOR_SEED, DID_TO, 'bad-1', 'hi', { tamper: true }) },
  { label: 'partial-envelope', method: 'POST', path: '/', headers: FORGED, body: rpc('partial-1', 'hi', { from: didOf(VISITOR_SEED), to: DID_TO }) },
  { label: 'unparseable', method: 'POST', path: '/', headers: FORGED, body: Buffer.from('{', 'utf8') },
  { label: 'unowned-path', method: 'POST', path: '/elsewhere', headers: FORGED, body: anonBody('elsewhere-1') },
  { label: 'options', method: 'OPTIONS', path: '/', headers: FORGED },
];

// ---------------------------------------------------------------- 1. THE INVARIANT
// Same message, same verdict. Five configurations of the door, one script; only the three
// observer fields may differ. Passes on a door that ignores the options — it is the guard the
// implementation must keep green, and the reason every other block below is safe to add.
const CONFIGS = [
  ['plain', {}],
  ['trustProxy', { trustProxy: true }],
  ['vendorRanges', { vendorRanges: RANGES }],
  ['trustProxy+vendorRanges', { trustProxy: true, vendorRanges: RANGES }],
  ['trustProxy-false+vendorRanges', { trustProxy: false, vendorRanges: RANGES }],
];
const runs = {};
await section('invariant', async () => {
  for (const [name, opts] of CONFIGS) runs[name] = await drive(opts, SCRIPT);
  const base = runs.plain;

  // CONTROLS: the script reaches every lane, or the equalities below prove nothing.
  const codeOf = (o) => { try { return JSON.parse(Buffer.from(o.body).toString('utf8')).error?.code ?? null; } catch { return null; } };
  const at = (label) => base.wire[SCRIPT.findIndex((r) => r.label === label)];
  check(at('anon-1').status === 200 && codeOf(at('anon-1')) === null, 'invariant/control/anon-lane-answers', wireView(at('anon-1')));
  check(codeOf(at('anon-3-over-the-lane')) !== null, 'invariant/control/anon-rate-lane-refuses', wireView(at('anon-3-over-the-lane')));
  check(codeOf(at('signed-1')) === null && at('signed-1').status === 200, 'invariant/control/signed-lane-answers', wireView(at('signed-1')));
  check(codeOf(at('signed-1-replay')) !== null, 'invariant/control/replay-refused', wireView(at('signed-1-replay')));
  check(codeOf(at('signed-3-over-the-account-lane')) !== null, 'invariant/control/account-rate-lane-refuses', wireView(at('signed-3-over-the-account-lane')));
  check(codeOf(at('bad-signature')) !== null, 'invariant/control/bad-signature-refused', wireView(at('bad-signature')));
  check(base.entry.ledger.size === 1, 'invariant/control/one-account-row', `ledger has ${base.entry.ledger.size} rows`);
  check(base.resp.length > 0 && base.resp.some((e) => e.verified === true), 'invariant/control/verified-reaches-the-responder', '');

  for (const [name] of CONFIGS.slice(1)) {
    const run = runs[name];
    SCRIPT.forEach((r, i) => {
      const want = wireView(base.wire[i]);
      const got = run.wire[i] ? wireView(run.wire[i]) : '<no answer>';
      check(got === want, `invariant/${name}/wire-identical/${r.label}`, `plain:  ${want.slice(0, 300)}\n      ${name}: ${got.slice(0, 300)}`);
    });
    check(stable(run.resp) === stable(base.resp), `invariant/${name}/responder-envelopes-identical`,
      'the responder was handed a different envelope (verified, DIDs, wba_did, text) — observation reached the verdict path');
    check(ledgerView(run.entry) === ledgerView(base.entry), `invariant/${name}/account-rows-identical`,
      `plain ${ledgerView(base.entry)}\n      ${name} ${ledgerView(run.entry)}`);
    check(stable(run.entry.stats()) === stable(base.entry.stats()), `invariant/${name}/stats-identical`, '');
    check(stable(run.entry.clientStats()) === stable(base.entry.clientStats()), `invariant/${name}/clientStats-identical`, '');
    check(run.obs.length === base.obs.length, `invariant/${name}/same-number-of-observations`, `${base.obs.length} vs ${run.obs.length}`);
    const a = base.obs.map((e) => stable(without(e, NEW_FIELDS)));
    const b = run.obs.map((e) => stable(without(e, NEW_FIELDS)));
    check(stable(a) === stable(b), `invariant/${name}/observer-identical-but-for-the-three-fields`,
      `first difference at ${a.findIndex((x, i) => x !== b[i])}`);
  }

  // The responder's envelope is the FROZEN backend-handoff shape (backendEnvelope): the new
  // fields are the OBSERVER's, never the responder's.
  const leakedIntoResponder = runs['trustProxy+vendorRanges'].resp.filter((e) => NEW_FIELDS.some((k) => k in e));
  check(leakedIntoResponder.length === 0, 'invariant/responder-envelope-key-set-unchanged',
    `the responder's envelope gained ${NEW_FIELDS.filter((k) => leakedIntoResponder[0] && k in leakedIntoResponder[0]).join(', ')}`);

  // What each configuration must SAY, on every observation (the positive half).
  const expect = {
    plain: [null, null],
    trustProxy: [null, 'JP'],                        // no ranges: nothing to match
    vendorRanges: ['fly', null],                     // socket only, headers ignored, no country
    'trustProxy+vendorRanges': ['openai', 'JP'],     // the forged CF-Connecting-IP wins
    'trustProxy-false+vendorRanges': ['fly', null],
  };
  for (const [name, [vendor, country]] of Object.entries(expect)) {
    const bad = runs[name].obs.filter((e) => e.ip_vendor !== vendor || e.country !== country || !('ip_vendor' in e) || !('country' in e));
    check(runs[name].obs.length > 0 && bad.length === 0, `invariant/${name}/observer-says-${vendor}-${country}`,
      bad.length ? `stage ${bad[0].stage}: ip_vendor=${JSON.stringify(bad[0].ip_vendor)} country=${JSON.stringify(bad[0].country)}` : '');
  }

  // No IP anywhere a door exposes, under the configuration that read every header.
  for (const [name] of CONFIGS) {
    const run = runs[name];
    scanForIps(`no-ip/${name}/wire`, wireText(run.wire));
    scanForIps(`no-ip/${name}/observer-envelopes`, JSON.stringify(run.obs));
    scanForIps(`no-ip/${name}/responder-envelopes`, JSON.stringify(run.resp));
    scanForIps(`no-ip/${name}/ledger`, JSON.stringify([...run.entry.ledger]));
    scanForIps(`no-ip/${name}/stats`, JSON.stringify(run.entry.stats()));
    scanForIps(`no-ip/${name}/clientStats`, JSON.stringify(run.entry.clientStats()));
    if (typeof run.entry.vendorStats === 'function') {
      scanForIps(`no-ip/${name}/vendorStats`, JSON.stringify(run.entry.vendorStats()));
    }
    const wire = wireText(run.wire);
    for (const needle of ['ip_vendor', 'signature_agent', 'vendorStats', 'vendor_stats']) {
      check(!wire.includes(needle), `no-wire/${name}/${needle}`, `"${needle}" appears in an HTTP response`);
    }
  }
});

// The same invariant for Web Bot Auth: recognition (legacy JWKS vs the labelled array) may add
// `signature_agent` to the observer and nothing else. `wba_did` stays exactly what it was.
await section('invariant-wba', async () => {
  const wbaScript = [
    { label: 'wba-card', method: 'GET', path: AGENT_CARD_PATH, headers: { ...FORGED, ...wbaHeaders(WBA_A) } },
    { label: 'wba-anon', method: 'POST', path: '/', headers: { ...FORGED, ...wbaHeaders(WBA_A) }, body: anonBody('wba-anon-1') },
    { label: 'wba-signed', method: 'POST', path: '/', headers: { ...FORGED, ...wbaHeaders(WBA_A) }, body: signedBody(VISITOR_SEED, DID_TO, 'wba-signed-1') },
    { label: 'wba-refused', method: 'POST', path: '/', headers: { ...FORGED, ...wbaHeaders(WBA_A) }, body: signedBody(VISITOR_SEED, DID_TO, 'wba-bad-1', 'x', { tamper: true }) },
  ];
  const legacy = await drive({ wbaVerifiers: { keys: [jwkOf(WBA_A)] } }, wbaScript);
  check(legacy.resp.some((e) => e.wba_did === didOf(WBA_A)), 'invariant-wba/control/legacy-recognises',
    `wba_did seen: ${JSON.stringify(legacy.resp.map((e) => e.wba_did))}`);
  for (const [name, opts] of [
    ['array', { wbaVerifiers: [{ vendor: 'openai', jwks: { keys: [jwkOf(WBA_A)] } }] }],
    ['array+trustProxy+vendorRanges', { trustProxy: true, vendorRanges: RANGES,
      wbaVerifiers: [{ vendor: 'openai', jwks: { keys: [jwkOf(WBA_A)] } }] }],
  ]) {
    let run;
    try { run = await drive(opts, wbaScript); } catch (e) {
      check(false, `invariant-wba/${name}/starts`, e.message); continue;
    }
    wbaScript.forEach((r, i) => {
      check(wireView(run.wire[i]) === wireView(legacy.wire[i]), `invariant-wba/${name}/wire-identical/${r.label}`,
        `legacy: ${wireView(legacy.wire[i]).slice(0, 200)}\n      ${name}: ${wireView(run.wire[i]).slice(0, 200)}`);
    });
    check(stable(run.resp) === stable(legacy.resp), `invariant-wba/${name}/responder-envelopes-identical`, 'wba_did or verified changed with the verifier shape');
    check(ledgerView(run.entry) === ledgerView(legacy.entry), `invariant-wba/${name}/account-rows-identical`, '');
    check(stable([...run.entry.wbaVisits]) === stable([...legacy.entry.wbaVisits]), `invariant-wba/${name}/wbaVisits-identical`, '');
    const a = legacy.obs.map((e) => stable(without(e, NEW_FIELDS)));
    const b = run.obs.map((e) => stable(without(e, NEW_FIELDS)));
    check(stable(a) === stable(b), `invariant-wba/${name}/observer-identical-but-for-the-three-fields`, '');
  }
});

// ---------------------------------------------------------------- 2. trustProxy: which address
await section('trust-proxy', async () => {
  const sink = {};
  const on = makeDoor({ trustProxy: true, vendorRanges: RANGES }, sink);
  const base = { 'user-agent': 'curl/8' };
  const order = [
    ['cf-connecting-ip-first', { ...base, 'cf-connecting-ip': FORGED_CF_IP, 'fly-client-ip': FLY_HDR_IP, 'x-forwarded-for': `${XFF_FIRST}, ${XFF_SECOND}` }, 'openai'],
    ['then-fly-client-ip', { ...base, 'fly-client-ip': FLY_HDR_IP, 'x-forwarded-for': `${XFF_FIRST}, ${XFF_SECOND}` }, 'anthropic'],
    ['then-first-hop-of-x-forwarded-for', { ...base, 'x-forwarded-for': `${XFF_FIRST}, ${XFF_SECOND}` }, 'google'],
    ['first-hop-trimmed', { ...base, 'x-forwarded-for': `  ${XFF_FIRST} ,${XFF_SECOND}` }, 'google'],
    ['never-a-later-hop', { ...base, 'x-forwarded-for': `${UNMATCHED_SOCKET}, ${XFF_SECOND}` }, null],
    ['then-the-socket', { ...base }, 'fly'],
    ['header-names-are-case-insensitive', { ...base, 'CF-Connecting-IP': FORGED_CF_IP }, 'openai'],
  ];
  for (const [label, headers, want] of order) {
    const env = await probe(on, sink, SOCKET_IP, headers);
    check(env !== null && env.ip_vendor === want, `trust-proxy/on/${label}`, `ip_vendor=${JSON.stringify(env && env.ip_vendor)}, want ${JSON.stringify(want)}`);
  }

  // OFF (the default, and explicit): the headers are not read AT ALL. A door not behind a
  // proxy must not be poisoned by a header any client can write.
  for (const [name, opts] of [['default', { vendorRanges: RANGES }], ['explicit-false', { trustProxy: false, vendorRanges: RANGES }]]) {
    const s = {};
    const off = makeDoor(opts, s);
    const forged = { ...base, 'cf-connecting-ip': FORGED_CF_IP, 'fly-client-ip': FLY_HDR_IP,
      'x-forwarded-for': `${XFF_FIRST}, ${XFF_SECOND}`, 'cf-ipcountry': 'JP' };
    const fromSocket = await probe(off, s, SOCKET_IP, forged);
    check(fromSocket !== null && fromSocket.ip_vendor === 'fly' && fromSocket.country === null,
      `trust-proxy/${name}/forged-headers-ignored-socket-matched`,
      `ip_vendor=${JSON.stringify(fromSocket && fromSocket.ip_vendor)} country=${JSON.stringify(fromSocket && fromSocket.country)}, want "fly"/null`);
    const unmatched = await probe(off, s, UNMATCHED_SOCKET, forged);
    check(unmatched !== null && unmatched.ip_vendor === null && 'ip_vendor' in unmatched,
      `trust-proxy/${name}/forged-headers-never-a-match`, `ip_vendor=${JSON.stringify(unmatched && unmatched.ip_vendor)}`);
  }

  // No socket address at all (a host that did not pass one) is not an error.
  const s2 = {};
  const bare = makeDoor({ trustProxy: true, vendorRanges: RANGES }, s2);
  const out = await bare.handleRequestAsync('GET', AGENT_CARD_PATH, { 'user-agent': 'curl/8' }, Buffer.alloc(0));
  check(out.status === 200 && s2.obs[0] && s2.obs[0].ip_vendor === null && 'ip_vendor' in s2.obs[0],
    'trust-proxy/no-socket-address-is-null-not-an-error', `status ${out.status}, env ${JSON.stringify(s2.obs[0] && s2.obs[0].ip_vendor)}`);

  // The synchronous entry point takes the same fifth argument.
  const s3 = {};
  const sync = makeDoor({ vendorRanges: RANGES }, s3);
  sync.handleRequest('GET', AGENT_CARD_PATH, { 'user-agent': 'curl/8' }, Buffer.alloc(0), { remoteAddress: SOCKET_IP });
  check(s3.obs[0] && s3.obs[0].ip_vendor === 'fly', 'trust-proxy/handleRequest-sync-takes-remoteAddress',
    `ip_vendor=${JSON.stringify(s3.obs[0] && s3.obs[0].ip_vendor)}`);

  // Configured nothing to match: no matching is done, the field is null.
  for (const [name, opts] of [['no-vendorRanges', { trustProxy: true }], ['empty-vendorRanges', { trustProxy: true, vendorRanges: {} }]]) {
    const s = {};
    const e = makeDoor(opts, s);
    const env = await probe(e, s, SOCKET_IP, { 'cf-connecting-ip': FORGED_CF_IP });
    check(env !== null && env.ip_vendor === null && 'ip_vendor' in env, `trust-proxy/${name}-is-null`, `ip_vendor=${JSON.stringify(env && env.ip_vendor)}`);
  }
});

// ---------------------------------------------------------------- 3. CIDR matching, pure JS
await section('cidr', async () => {
  const table = {
    openai: ['10.0.0.0/8'],
    anthropic: ['192.0.2.0/24'],
    google: ['198.51.100.7/32'],
    microsoft: ['203.0.113.64/26'],
    perplexity: ['172.16.0.0/12'],
    gcp: ['100.64.0.0/10'],
    apple: ['2001:db8::/32'],
    meta: ['2001:db9:abcd:12::/64'],
    xai: ['2001:dba::1/128'],
    cloudflare: ['2001:dbb::/127'],
    aws: ['2a00:1450::/33'],
  };
  const sink = {};
  const entry = makeDoor({ vendorRanges: table }, sink);
  const cases = [
    // IPv4 /8
    ['10.0.0.0', 'openai'], ['10.255.255.255', 'openai'], ['9.255.255.255', null], ['11.0.0.0', null],
    // /24
    ['192.0.2.0', 'anthropic'], ['192.0.2.255', 'anthropic'], ['192.0.1.255', null], ['192.0.3.0', null],
    // /32
    ['198.51.100.7', 'google'], ['198.51.100.6', null], ['198.51.100.8', null],
    // /26 (not on an octet)
    ['203.0.113.64', 'microsoft'], ['203.0.113.127', 'microsoft'], ['203.0.113.63', null], ['203.0.113.128', null],
    // /12
    ['172.16.0.0', 'perplexity'], ['172.31.255.255', 'perplexity'], ['172.15.255.255', null], ['172.32.0.0', null],
    // /10
    ['100.64.0.0', 'gcp'], ['100.127.255.255', 'gcp'], ['100.63.255.255', null], ['100.128.0.0', null],
    // IPv6 /32
    ['2001:db8::', 'apple'], ['2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', 'apple'],
    ['2001:db7:ffff:ffff:ffff:ffff:ffff:ffff', null], ['2001:db9::', null],
    ['2001:DB8::1', 'apple'], ['2001:0db8:0000:0000:0000:0000:0000:0001', 'apple'],
    // /64
    ['2001:db9:abcd:12::', 'meta'], ['2001:db9:abcd:12:ffff:ffff:ffff:ffff', 'meta'],
    ['2001:db9:abcd:13::', null], ['2001:db9:abcd:11:ffff:ffff:ffff:ffff', null],
    // /128
    ['2001:dba::1', 'xai'], ['2001:dba::2', null], ['2001:dba::', null],
    // /127
    ['2001:dbb::', 'cloudflare'], ['2001:dbb::1', 'cloudflare'], ['2001:dbb::2', null],
    // /33 (not on a nibble)
    ['2a00:1450::', 'aws'], ['2a00:1450:7fff:ffff:ffff:ffff:ffff:ffff', 'aws'],
    ['2a00:1450:8000::', null], ['2a00:144f:ffff:ffff:ffff:ffff:ffff:ffff', null],
    // IPv4-mapped IPv6 — what a dual-stack Node socket reports for an IPv4 client
    ['::ffff:10.1.2.3', 'openai'], ['::ffff:192.0.2.9', 'anthropic'], ['::ffff:198.51.100.7', 'google'],
    ['::FFFF:10.0.0.1', 'openai'], ['::ffff:9.9.9.9', null],
    // not an address: null, never a throw, never a guess
    ['10.0.0', null], ['10.0.0.256', null], ['1.2.3.4.5', null], ['not-an-ip', null], ['', null],
    ['2001:db8::g', null], ['2001:db8:::1', null], [':::', null], ['10.0.0.1/8', null],
  ];
  for (const [addr, want] of cases) {
    const env = await probe(entry, sink, addr, { 'user-agent': 'curl/8' });
    check(env !== null && env.ip_vendor === want && 'ip_vendor' in env, `cidr/${addr || '<empty>'}`,
      `ip_vendor=${JSON.stringify(env && env.ip_vendor)}, want ${JSON.stringify(want)}`);
  }
});

// ---------------------------------------------------------------- 3b. refuse to start (AE-32)
await section('refuse-to-start', async () => {
  const good = { seedHex: DOOR_SEED, name: 'r', baseUrl: BASE_URL };
  const refuses = (label, extra, mention) => {
    let err = null;
    try { createAgentEntry({ ...good, ...extra }); } catch (e) { err = e; }
    check(err instanceof TypeError && /createAgentEntry/.test(err.message)
      && (!mention || err.message.includes(mention)),
    `refuse-to-start/${label}`,
    err ? `threw ${err.constructor.name}: ${err.message}` : 'STARTED — config the operator believes does something, and it does not');
  };
  refuses('vendorRanges-unknown-vendor', { vendorRanges: { openaii: ['10.0.0.0/8'] } }, 'openaii');
  refuses('vendorRanges-none-is-a-bucket-not-a-vendor', { vendorRanges: { none: ['10.0.0.0/8'] } }, 'none');
  refuses('vendorRanges-vendor-is-case-exact', { vendorRanges: { OpenAI: ['10.0.0.0/8'] } }, 'OpenAI');
  refuses('vendorRanges-not-an-object', { vendorRanges: ['10.0.0.0/8'] }, 'vendorRanges');
  refuses('vendorRanges-a-string', { vendorRanges: 'openai' }, 'vendorRanges');
  refuses('vendorRanges-list-not-an-array', { vendorRanges: { openai: '10.0.0.0/8' } }, 'vendorRanges');
  for (const cidr of ['10.0.0.0/33', '10.0.0.0', '256.0.0.0/8', '10.0.0/8', '10.0.0.0/-1', '10.0.0.0/8/8',
    '/8', '', 'abc', '2001:db8::/129', '2001:db8::', '2001:db8::g/32', '2001:db8:::/32']) {
    refuses(`vendorRanges-malformed-cidr/${cidr || '<empty>'}`, { vendorRanges: { openai: [cidr] } }, 'vendorRanges');
  }
  for (const junk of [42, null, {}]) {
    refuses(`vendorRanges-cidr-not-a-string/${JSON.stringify(junk)}`, { vendorRanges: { openai: [junk] } }, 'vendorRanges');
  }
  // The accept half: a refuser that refuses everything passes every row above.
  for (const [label, ranges] of [['every-vendor', Object.fromEntries(VENDORS_WANT.map((v, i) => [v, [`10.${i}.0.0/16`]]))],
    ['ipv4-/8-and-/32', { openai: ['10.0.0.0/8', '198.51.100.7/32'] }],
    ['ipv6-/32-and-/128', { google: ['2001:db8::/32', '2001:db8::1/128'] }], ['empty', {}]]) {
    let err = null;
    try { createAgentEntry({ ...good, vendorRanges: ranges }); } catch (e) { err = e; }
    check(err === null, `refuse-to-start/accepts/${label}`, err ? err.message : '');
  }

  // wbaVerifiers, extended: the array shape is validated as strictly as the legacy one.
  refuses('wbaVerifiers-empty-array', { wbaVerifiers: [] }, 'wbaVerifiers');
  refuses('wbaVerifiers-unknown-vendor', { wbaVerifiers: [{ vendor: 'openaii', jwks: { keys: [jwkOf(WBA_A)] } }] }, 'openaii');
  refuses('wbaVerifiers-missing-jwks', { wbaVerifiers: [{ vendor: 'openai' }] }, 'wbaVerifiers');
  refuses('wbaVerifiers-bad-key-in-array', { wbaVerifiers: [{ vendor: 'openai', jwks: { keys: [{ kty: 'RSA', n: 'x', e: 'AQAB' }] } }] }, 'wbaVerifiers');
  refuses('wbaVerifiers-non-object-entry', { wbaVerifiers: [{ vendor: 'openai', jwks: { keys: [jwkOf(WBA_A)] } }, 'x'] }, 'wbaVerifiers');
  refuses('wbaVerifiers-legacy-empty-keys-still-refused', { wbaVerifiers: { keys: [] } }, 'wbaVerifiers');
  let err = null;
  try {
    createAgentEntry({ ...good, wbaVerifiers: [
      { vendor: 'openai', jwks: { keys: [jwkOf(WBA_A)] } }, { vendor: 'other', jwks: { keys: [jwkOf(WBA_B)] } }] });
  } catch (e) { err = e; }
  check(err === null, 'refuse-to-start/accepts/wbaVerifiers-array', err ? err.message : '');
});

// ---------------------------------------------------------------- 4. country
await section('country', async () => {
  const sink = {};
  const on = makeDoor({ trustProxy: true }, sink);
  for (const [value, want] of [['JP', 'JP'], ['US', 'US'], ['XX', 'XX'], ['jp', null], ['JPN', null], ['T1', null],
    ['', null], ['<script>', null], ['J1', null], ['ÅÄ', null], ['J', null]]) {
    const env = await probe(on, sink, SOCKET_IP, { 'cf-ipcountry': value });
    check(env !== null && env.country === want && 'country' in env, `country/trustProxy/${JSON.stringify(value)}`,
      `country=${JSON.stringify(env && env.country)}, want ${JSON.stringify(want)}`);
  }
  const absent = await probe(on, sink, SOCKET_IP, {});
  check(absent !== null && absent.country === null && 'country' in absent, 'country/trustProxy/absent-header-is-null', '');
  const s2 = {};
  const off = makeDoor({}, s2);
  const env = await probe(off, s2, SOCKET_IP, { 'cf-ipcountry': 'JP' });
  check(env !== null && env.country === null && 'country' in env, 'country/without-trustProxy-is-null',
    `country=${JSON.stringify(env && env.country)}`);
});

// ---------------------------------------------------------------- 5. signature_agent
await section('signature-agent', async () => {
  // CONTROL: this file's WBA builder verifies on the door as it stands (legacy JWKS).
  {
    const s = {};
    const e = makeDoor({ wbaVerifiers: { keys: [jwkOf(WBA_A)] } }, s);
    await probe(e, s, SOCKET_IP, wbaHeaders(WBA_A));
    check(e.wbaVisits.get(didOf(WBA_A)) === 1, 'signature-agent/control/builder-verifies',
      `wbaVisits ${JSON.stringify([...e.wbaVisits])}`);
  }
  const array = [{ vendor: 'openai', jwks: { keys: [jwkOf(WBA_A)] } }, { vendor: 'google', jwks: { keys: [jwkOf(WBA_B)] } }];
  const cases = [
    ['array/first-vendor', array, WBA_A, 'openai', didOf(WBA_A)],
    ['array/second-vendor', array, WBA_B, 'google', didOf(WBA_B)],
    ['array/unrecognised-signer', array, WBA_C, null, null],
    ['legacy/is-other', { keys: [jwkOf(WBA_A)] }, WBA_A, 'other', didOf(WBA_A)],
    ['legacy/unrecognised-signer', { keys: [jwkOf(WBA_A)] }, WBA_C, null, null],
    ['none-configured', null, WBA_A, null, null],
  ];
  for (const [label, wbaVerifiers, signer, want, wantDid] of cases) {
    const s = {};
    let e;
    try { e = makeDoor(wbaVerifiers ? { wbaVerifiers } : {}, s); } catch (err) {
      check(false, `signature-agent/${label}/starts`, err.message); continue;
    }
    // The signed POST is where `wba_did` is established today; the observer must agree with it.
    const headers = { 'user-agent': 'curl/8', 'content-type': 'application/json', ...wbaHeaders(signer) };
    await send(e, { method: 'POST', path: '/', headers, body: signedBody(VISITOR_SEED, DID_TO, `sa-${label}`) }, SOCKET_IP);
    const post = s.obs.find((o) => o.stage === 'signed_post');
    check(post && post.signature_agent === want && 'signature_agent' in post, `signature-agent/${label}/signed_post`,
      `signature_agent=${JSON.stringify(post && post.signature_agent)}, want ${JSON.stringify(want)}`);
    check(post && post.wba_did === wantDid, `signature-agent/${label}/wba_did-unchanged`,
      `wba_did=${JSON.stringify(post && post.wba_did)}, want ${JSON.stringify(wantDid)}`);
    check(s.resp[0] && s.resp[0].wba_did === wantDid && !('signature_agent' in s.resp[0]),
      `signature-agent/${label}/responder-sees-wba_did-only`, JSON.stringify(s.resp[0] && s.resp[0].wba_did));
    // The card fetch is where a crawler's Web Bot Auth actually arrives: the observer is told
    // there too.
    const card = await probe(e, s, SOCKET_IP, { 'user-agent': 'curl/8', ...wbaHeaders(signer) });
    check(card && card.signature_agent === want && 'signature_agent' in card, `signature-agent/${label}/card_get`,
      `signature_agent=${JSON.stringify(card && card.signature_agent)}, want ${JSON.stringify(want)}`);
  }
  // No signature at all: null on every stage, even with verifiers configured.
  const s = {};
  const e = makeDoor({ wbaVerifiers: { keys: [jwkOf(WBA_A), jwkOf(WBA_B)] } }, s);
  const plain = await probe(e, s, SOCKET_IP, { 'user-agent': 'curl/8' });
  check(plain && plain.signature_agent === null && 'signature_agent' in plain, 'signature-agent/unsigned-request-is-null', '');
  // A signature for ANOTHER authority is not recognition.
  const elsewhere = await probe(e, s, SOCKET_IP, { 'user-agent': 'curl/8', ...wbaHeaders(WBA_A, 'elsewhere.example') });
  check(elsewhere && elsewhere.signature_agent === null, 'signature-agent/other-authority-is-null',
    `signature_agent=${JSON.stringify(elsewhere && elsewhere.signature_agent)}`);
});

// ---------------------------------------------------------------- 6. envelope on all five stages + vendorStats
const FIVE = [
  { label: 'card', method: 'GET', path: AGENT_CARD_PATH, headers: FORGED },
  { label: 'notice', method: 'GET', path: '/', headers: FORGED },
  { label: 'anon', method: 'POST', path: '/', headers: FORGED, body: anonBody('five-anon') },
  { label: 'signed', method: 'POST', path: '/', headers: FORGED, body: signedBody(VISITOR_SEED, DID_TO, 'five-signed') },
  { label: 'refused', method: 'POST', path: '/', headers: FORGED, body: signedBody(VISITOR_SEED, DID_TO, 'five-bad', 'x', { tamper: true }) },
];
await section('five-stages', async () => {
  const on = await drive({ trustProxy: true, vendorRanges: RANGES, wbaVerifiers: { keys: [jwkOf(WBA_A)] } }, FIVE);
  const off = await drive({}, FIVE);
  check(stable(off.obs.map((o) => o.stage).sort()) === stable([...STAGES].sort()), 'five-stages/control/all-five-observed',
    JSON.stringify(off.obs.map((o) => o.stage)));
  for (const stage of STAGES) {
    const a = on.obs.find((o) => o.stage === stage);
    check(a && a.ip_vendor === 'openai' && a.country === 'JP' && 'signature_agent' in a
      && (a.signature_agent === null || VENDORS_WANT.includes(a.signature_agent)),
    `five-stages/${stage}/carries-the-three-fields`, JSON.stringify(a && { ip_vendor: a.ip_vendor, country: a.country, signature_agent: a.signature_agent }));
    check(a && typeof a.ua_family === 'string' && typeof a.client_class === 'string', `five-stages/${stage}/beside-ua_family-and-client_class`, '');
    const b = off.obs.find((o) => o.stage === stage);
    check(b && NEW_FIELDS.every((k) => k in b && b[k] === null), `five-stages/${stage}/absent-is-null`,
      JSON.stringify(b && Object.fromEntries(NEW_FIELDS.map((k) => [k, k in b ? b[k] : '<missing>']))));
  }
  // Bounded values only, whatever the configuration.
  for (const [name, run] of [['five-on', on], ['five-off', off], ...Object.entries(runs)]) {
    for (const o of run.obs) {
      const okVendor = o.ip_vendor === null || VENDORS_WANT.includes(o.ip_vendor);
      const okSa = o.signature_agent === null || VENDORS_WANT.includes(o.signature_agent);
      const okCountry = o.country === null || /^[A-Z]{2}$/.test(o.country);
      if (!check(okVendor && okSa && okCountry, `five-stages/${name}/values-come-from-the-fixed-tables`,
        `stage ${o.stage}: ${JSON.stringify({ ip_vendor: o.ip_vendor, country: o.country, signature_agent: o.signature_agent })}`)) break;
    }
  }

  // vendorStats(): { <vendor|'none'>: { stage: n } }, same shape as clientStats().
  check(typeof on.entry.vendorStats === 'function', 'vendor-stats/exists', 'entry.vendorStats is not a function');
  if (typeof on.entry.vendorStats === 'function') {
    const want = { openai: Object.fromEntries(STAGES.map((s) => [s, 1])) };
    check(stable(on.entry.vendorStats()) === stable(want), 'vendor-stats/counts-per-stage-under-the-vendor',
      `got ${JSON.stringify(on.entry.vendorStats())}, want ${JSON.stringify(want)}`);
    const none = { none: Object.fromEntries(STAGES.map((s) => [s, 1])) };
    check(stable(off.entry.vendorStats()) === stable(none), 'vendor-stats/no-match-counts-as-none',
      `got ${JSON.stringify(off.entry.vendorStats())}`);
    const copy = on.entry.vendorStats();
    copy.openai.card_get = 999; copy.injected = {};
    check(stable(on.entry.vendorStats()) === stable(want), 'vendor-stats/returns-a-copy', '');
    // One tally point: per stage, the vendor split and the class split count the same visits.
    for (const run of [on, off, ...Object.values(runs)]) {
      const total = (st) => STAGES.map((s) => Object.values(st).reduce((n, row) => n + (row[s] || 0), 0));
      check(stable(total(run.entry.vendorStats())) === stable(total(run.entry.clientStats())), 'vendor-stats/agrees-with-clientStats-per-stage',
        `vendor ${JSON.stringify(total(run.entry.vendorStats()))} vs client ${JSON.stringify(total(run.entry.clientStats()))}`);
      const keys = Object.keys(run.entry.vendorStats());
      check(keys.every((k) => k === 'none' || VENDORS_WANT.includes(k)), 'vendor-stats/bounded-keyspace', JSON.stringify(keys));
    }
  }
  scanForIps('no-ip/five-stages/observer-envelopes', JSON.stringify(on.obs));
  scanForIps('no-ip/five-stages/wire', wireText(on.wire));
  check(!wireText(on.wire).includes('vendorStats') && !wireText(on.wire).includes('ip_vendor'), 'no-wire/five-stages', '');
});

// ---------------------------------------------------------------- nothing is logged
await section('no-ip-in-logs', async () => {
  const captured = [];
  const saved = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[m] = console[m];
    console[m] = (...a) => { captured.push(a.map(String).join(' ')); };
  }
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c, ...r) => { captured.push(String(c)); return true; };
  process.stderr.write = (c, ...r) => { captured.push(String(c)); return true; };
  try {
    await drive({ trustProxy: true, vendorRanges: RANGES }, SCRIPT);
    await drive({ trustProxy: true, vendorRanges: RANGES }, FIVE, UNMATCHED_SOCKET);
  } finally {
    for (const m of Object.keys(saved)) console[m] = saved[m];
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
  scanForIps('no-ip/log-lines', captured.join('\n'));
});

// ---------------------------------------------------------------- listen(): the real socket
await section('listen', async () => {
  const obs = [];
  const entry = createAgentEntry({
    seedHex: DOOR_SEED, name: 'knocking-v2-listen', baseUrl: BASE_URL,
    // Loopback in a range, AND a forged header naming openai: with trustProxy off only the
    // socket may decide.
    vendorRanges: { other: ['127.0.0.0/8'], openai: ['203.0.113.0/24'] },
    observer: (env) => { obs.push(env); },
  });
  const server = await new Promise((resolve) => { const s = entry.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const { port } = server.address();
    const body = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: AGENT_CARD_PATH, method: 'GET',
        headers: { 'cf-connecting-ip': FORGED_CF_IP, 'user-agent': 'curl/8' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    check(body.status === 200, 'listen/control/card-served', `HTTP ${body.status}`);
    check(obs[0] && obs[0].ip_vendor === 'other', 'listen/passes-the-socket-address',
      `ip_vendor=${JSON.stringify(obs[0] && obs[0].ip_vendor)} — listen() must hand req.socket.remoteAddress to the router`);
    const wire = `${JSON.stringify(body.headers)}\n${body.body.toString('latin1')}`;
    check(!wire.includes('127.0.0.1') && !wire.includes(FORGED_CF_IP), 'listen/no-ip-on-the-wire', '');
    scanForIps('no-ip/listen/observer', JSON.stringify(obs).replace(/127\.0\.0\.1/g, ''));
    check(!JSON.stringify(obs).includes('127.0.0.1'), 'no-ip/listen/observer-has-no-socket-address', '');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------- 8. the published table, the spec, the README
await section('static', async () => {
  const vendors = door.VENDORS ? [...door.VENDORS] : null;
  check(stable(vendors) === stable(VENDORS_WANT), 'static/module-exports-VENDORS',
    `VENDORS is ${JSON.stringify(vendors)} — the fixed table, exported beside CLIENT_CLASSES`);

  const src = readFileSync(join(ROOT, 'muretai-agent-entry.mjs'), 'utf8');
  const specifiers = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const dynamic = [...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const foreign = [...specifiers, ...dynamic].filter((s) => !s.startsWith('node:'));
  check(foreign.length === 0, 'static/module-imports-only-node-builtins', `imports ${foreign.join(', ')}`);
  check(![...specifiers, ...dynamic].some((s) => /vendor-ranges|scripts\//.test(s)), 'static/module-never-imports-the-helper', '');

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  check((pkg.files || []).some((f) => f === 'scripts/vendor-ranges.mjs' || f === 'scripts/' || f === 'scripts'),
    'static/helper-ships-in-the-package', `package.json "files" is ${JSON.stringify(pkg.files)} — a front desk runs it from node_modules`);

  const spec = readFileSync(join(ROOT, 'spec', 'v1.md'), 'utf8');
  const p30 = spec.indexOf('**AE-30.**');
  const p31 = spec.indexOf('**AE-31.**');
  const p32 = spec.indexOf('**AE-32.**');
  const p5 = spec.indexOf('## 5.');
  check(p31 > p30 && p32 > p31 && p32 < p5, 'static/spec-AE-31-and-AE-32-follow-AE-30',
    `positions AE-30 ${p30}, AE-31 ${p31}, AE-32 ${p32}, §5 ${p5}`);
  const para = (at) => (at < 0 ? '' : spec.slice(at, spec.indexOf('\n\n', spec.indexOf('\n\n', at) + 2)));
  const ae31 = para(p31);
  const ae32 = para(p32);
  for (const needle of ['trustProxy', 'MUST', 'verdict']) {
    check(ae31.includes(needle), `static/spec-AE-31-mentions-${needle}`, '');
  }
  for (const needle of ['vendorRanges', 'wbaVerifiers', 'MUST', 'refuse']) {
    check(ae32.includes(needle), `static/spec-AE-32-mentions-${needle}`, '');
  }
  check(/^\| AE-31 \|/m.test(spec) && /^\| AE-32 \|/m.test(spec), 'static/spec-index-lists-AE-31-and-AE-32', '');

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf('## Who is knocking');
  const end = start < 0 ? -1 : readme.indexOf('\n## ', start + 3);
  const section8 = start < 0 ? '' : readme.slice(start, end < 0 ? undefined : end);
  for (const needle of ['trustProxy', 'vendorRanges', 'wbaVerifiers', 'ip_vendor', 'country', 'signature_agent',
    'vendorStats()', 'scripts/vendor-ranges.mjs', 'cf.verified_bot_category', 'Transform Rule', 'stealth-agent', 'CF-Connecting-IP']) {
    check(section8.includes(needle), `static/readme-who-is-knocking-mentions-${needle}`, '');
  }
  // The options table names the three knobs too.
  for (const needle of ['`trustProxy`', '`vendorRanges`']) {
    check(readme.includes(`| ${needle} |`), `static/readme-options-table-has-${needle}`, '');
  }

  // The Python twin keeps the same table beside CLIENT_CLASSES. It is NOT in this repository
  // today (see the report); checked whenever it is present.
  const py = join(ROOT, 'examples', 'agent_entry_reference.py');
  if (existsSync(py)) {
    const text = readFileSync(py, 'utf8');
    const m = /^VENDORS\s*=\s*[([{]([\s\S]*?)[)\]}]/m.exec(text);
    const names = m ? [...m[1].matchAll(/['"]([a-z]+)['"]/g)].map((x) => x[1]) : null;
    check(stable(names) === stable(VENDORS_WANT), 'static/python-reference-VENDORS', `got ${JSON.stringify(names)}`);
    check(/^CLIENT_CLASSES\b/m.test(text), 'static/python-reference-CLIENT_CLASSES-beside-it', '');
  } else {
    notes.push('skip: examples/agent_entry_reference.py is not in this repository — the VENDORS twin check did not run');
  }
});

// ---------------------------------------------------------------- verdict
for (const n of notes) console.log(`  ${n}`);
if (failures.length) {
  console.log(`\nFAILED — ${failures.length} of ${pass + failures.length} checks:\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('\nObservation must never become identity: a row above is either a field the door does');
  console.log('not report yet, or a byte a proxy header or a vendor guess was allowed to move.\n');
  process.exit(1);
}
console.log(`OK — ${pass} checks: who is knocking is observed, bounded, and never a verdict.\n`);
