#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * conformance/poppy.mjs - the door publishes /.well-known/poppy.json for its shop
 * (Poppy 1.0 discovery only: no sessions, no auth, no Poppy conversation protocol).
 *
 * WRITTEN BEFORE THE IMPLEMENTATION (test author only). The implementer may not edit this file.
 * Run it as `node conformance/poppy.mjs`. Nothing here dials off this machine: the one live
 * server binds 127.0.0.1 on an ephemeral port.
 *
 * THE SURFACE THIS FILE PINS
 *   POPPY_PATH                        exported, exactly '/.well-known/poppy.json'.
 *   poppyDocument(card, servedOrigin) exported, PURE: the Poppy 1.0 document for this door, or null.
 *                                     `card` is the door's own Agent Card (entry.card);
 *                                     `servedOrigin` is the origin the document is served at,
 *                                     e.g. 'https://shop.example:8443'. null when that origin or
 *                                     the card's endpoint is not https.
 *   createAgentEntry({ poppy })       the switch. DEFAULT OFF (false): publishing a new public
 *                                     file for every shop on upgrade is the maintainer's call, and
 *                                     no existing option makes "on" obvious. Only a boolean is
 *                                     accepted, as for trustProxy; anything else is a TypeError
 *                                     naming `poppy`, so a typo never starts a door silently.
 *
 * THE DOCUMENT (spec facts, personalagentprotocol.org/docs/1.0/spec, read 2026-11-17):
 *   { protocol_version: '1.0',
 *     organization: { name: <card name>, domain: <served host, with its port when not 443> },
 *     agent: { protocols: [ { type: 'a2a', endpoint: <the door's https endpoint as the card
 *                             states it>, description: <card description> } ] },   (omitted when
 *                                                                                   the card has
 *                                                                                   no description)
 *     web: {} }
 *   No `apis` key: an Agent Entry door is neither openapi nor mcp, and every listed API MUST
 *   accept the Poppy Session header. No other key: no new marketing copy.
 *
 * THE HOST RULE PINNED HERE, AND WHY. organization.domain is derived from the door's CONFIGURED
 * origin (baseUrl, canonicalised as the card is) and from nothing the request carries: the Host
 * header, X-Forwarded-Host and the absolute-form target never change one byte of the document,
 * with or without trustProxy. The configured origin is the one host this door's signed card
 * already binds to, so it is by construction the host the document is legitimately served on.
 * Echoing Host would let any stranger who can reach the process (a shared IP, a mis-routed
 * vhost, a proxy that passes Host through) make the door publish "organization.domain =
 * victim.example" with the shop's name beside it. A Personal Agent that fetched through some
 * other host sees a mismatched domain and discards the file, which is the spec's own guard.
 *
 * ROUTING: GET and HEAD of exactly POPPY_PATH at the host root, no query. A query string, a
 * trailing slash, any other case, a dot-segment or percent-encoded spelling, a doubled slash and
 * an absolute-form target are all 404. The switch off, or an http origin, is the ordinary 404
 * byte for byte (`{"error":"not found"}`), the same answer any unowned path gets.
 *
 * UNCHANGED: the card, the tools contract, an ownership proof and the notice keep the exact
 * bytes and headers recorded at origin/main 329fd85, with the switch on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';
import { CONTROL, poppyProblems, strings } from './fixtures/poppy-validator.mjs';

const { createAgentEntry, AGENT_CARD_PATH } = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const SEED = '5a'.repeat(32);
const NAME = 'Poppy Shop';
const DESCRIPTION = 'Hand-tied bouquets, delivered same day.';
const PATH = '/.well-known/poppy.json';
const NOT_FOUND = '{"error":"not found"}';

// Recorded at origin/main 329fd85 for SEED, NAME, DESCRIPTION (sha256 of the response body).
const GOLDEN = {
  card: {
    'https://shop.example': 'bb8d0aa2be0cf376bc2a36c456ce94ecf4ff005543a6340bf50ba0beb977013c',
    'https://shop.example:8443': '00460212ee92e170206a17cd5364a89ea6b47d330ff5f8eda0088616ad272078',
    'https://shop.example/support': '202a640f7b8802070b5e41b849e7c8fc4ffa22e313520cbbc5a0fb025a3da9a0',
  },
  cardLength: { 'https://shop.example': '7786', 'https://shop.example:8443': '7821', 'https://shop.example/support': '7838' },
  tools: '4464b0790ff00059a8b38ae19f311e480849e59897c1abe54e8e9d66057f6dde',
  proof: 'ea4fd71d3a1fc8ab80ce5bc702fa5ccdb3bf5d59ea614bcbb7d9360bf6f20094',
  notice: 'f557fce6f6d0485552e98125706f730e2ec9b79c124901d9a6cffd7028931f5e',
};
const CARD_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};
const PROOF = { path: '/.well-known/poppy-proof.txt', body: 'proof-7731' };

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function entry(extra = {}) {
  return createAgentEntry({ seedHex: SEED, name: NAME, description: DESCRIPTION,
    baseUrl: 'https://shop.example', ...extra });
}

function get(e, path, headers = {}, method = 'GET') {
  const r = e.handleRequest(method, path, headers, Buffer.alloc(0));
  return { status: r.status, headers: r.headers, body: Buffer.from(r.body || Buffer.alloc(0)) };
}

function header(headers, name) {
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name.toLowerCase()) return String(v);
  return undefined;
}

function mediaType(headers) {
  return String(header(headers, 'content-type') || '').split(';', 1)[0].trim().toLowerCase();
}

/** The door-specific shape on top of the spec: exactly these keys, no apis, no new copy. */
function doorShapeProblems(doc) {
  const p = [];
  const top = Object.keys(doc).sort();
  for (const k of top) if (!['agent', 'organization', 'protocol_version', 'web'].includes(k)) p.push(`unexpected key ${k}`);
  if ('apis' in doc) p.push('the door must not list itself under apis');
  if (!doc.web || typeof doc.web !== 'object' || Array.isArray(doc.web) || Object.keys(doc.web).length) p.push('web is not {}');
  if (doc.organization) {
    const keys = Object.keys(doc.organization).sort().join(',');
    if (keys !== 'domain,name') p.push(`organization keys ${keys}`);
  }
  if ('agent' in doc) {
    if (Object.keys(doc.agent).join(',') !== 'protocols') p.push('agent carries more than protocols');
    const protocols = doc.agent.protocols || [];
    if (protocols.length !== 1) p.push(`agent.protocols has ${protocols.length} entries, not 1`);
    const e = protocols[0] || {};
    if (Object.keys(e).sort().join(',') !== 'description,endpoint,type') p.push('protocol entry keys are not type/endpoint/description');
    if (e.type !== 'a2a') p.push(`protocol type ${e.type} is not a2a`);
  }
  return p;
}

/** The door's https endpoint as its card states it: card.url or a supportedInterfaces url. */
function cardEndpoints(card) {
  const out = new Set();
  if (typeof card.url === 'string') out.add(card.url);
  for (const i of card.supportedInterfaces || []) if (i && typeof i.url === 'string') out.add(i.url);
  return out;
}

function served(e, path = PATH, headers = {}) {
  const r = get(e, path, headers);
  assert.equal(r.status, 200, `GET ${path} is ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`);
  return { ...r, doc: JSON.parse(r.body.toString('utf8')) };
}

// ---------------------------------------------------------------------------------------------
// the exported surface

test('POPPY_PATH is exported as /.well-known/poppy.json', () => {
  assert.equal(door.POPPY_PATH, PATH);
});

test('poppyDocument is an exported function', () => {
  assert.equal(typeof door.poppyDocument, 'function');
});

test('poppyDocument builds a valid document from the card alone, with no new copy', () => {
  const e = entry();
  const doc = door.poppyDocument(e.card, 'https://shop.example');
  assert.deepEqual(poppyProblems(doc, 'https://shop.example'), []);
  assert.deepEqual(doorShapeProblems(doc), []);
  assert.equal(doc.organization.name, NAME);
  assert.equal(doc.organization.domain, 'shop.example');
  assert.equal(doc.agent.protocols[0].description, DESCRIPTION);
  assert.ok(cardEndpoints(e.card).has(doc.agent.protocols[0].endpoint),
    `endpoint ${doc.agent.protocols[0].endpoint} is not a url the card states`);
  assert.deepEqual(doc.web, {});
});

test('poppyDocument is pure: same input, same output, the card is not mutated', () => {
  const e = entry();
  const before = JSON.stringify(e.card);
  const a = JSON.stringify(door.poppyDocument(e.card, 'https://shop.example'));
  const b = JSON.stringify(door.poppyDocument(e.card, 'https://shop.example'));
  assert.equal(a, b);
  assert.equal(JSON.stringify(e.card), before);
});

test('poppyDocument: a non-443 port is part of the domain', () => {
  const e = entry({ baseUrl: 'https://shop.example:8443' });
  const doc = door.poppyDocument(e.card, 'https://shop.example:8443');
  assert.deepEqual(poppyProblems(doc, 'https://shop.example:8443'), []);
  assert.equal(doc.organization.domain.toLowerCase(), 'shop.example:8443');
});

test('poppyDocument: an explicit :443 is not part of the domain', () => {
  const e = entry();
  const doc = door.poppyDocument(e.card, 'https://shop.example:443');
  assert.equal(doc.organization.domain.toLowerCase(), 'shop.example');
});

test('poppyDocument: a card with no description omits the agent entry and is still valid via web', () => {
  const e = entry({ description: '' });
  const doc = door.poppyDocument(e.card, 'https://shop.example');
  assert.ok(doc, 'no document at all');
  assert.equal('agent' in doc, false, 'agent entry invented for a card with no description');
  assert.deepEqual(doc.web, {});
  assert.deepEqual(poppyProblems(doc, 'https://shop.example'), []);
  const bare = { ...e.card };
  delete bare.description;
  const doc2 = door.poppyDocument(bare, 'https://shop.example');
  assert.equal('agent' in doc2, false);
  assert.deepEqual(poppyProblems(doc2, 'https://shop.example'), []);
});

test('poppyDocument: a mounted door names its mount as the endpoint, the host as the domain', () => {
  const e = entry({ baseUrl: 'https://shop.example/support' });
  const doc = door.poppyDocument(e.card, 'https://shop.example');
  assert.deepEqual(poppyProblems(doc, 'https://shop.example'), []);
  assert.equal(doc.organization.domain, 'shop.example');
  const endpoint = doc.agent.protocols[0].endpoint;
  assert.ok(cardEndpoints(e.card).has(endpoint));
  assert.ok(endpoint.startsWith('https://shop.example/support'), endpoint);
});

test('refusal: poppyDocument returns null for an http served origin', () => {
  const e = entry();
  assert.equal(door.poppyDocument(e.card, 'http://shop.example'), null);
});

test('refusal: poppyDocument returns null for a card whose endpoint is http', () => {
  const e = createAgentEntry({ seedHex: SEED, name: NAME, description: DESCRIPTION, baseUrl: 'http://127.0.0.1:8788' });
  assert.equal(door.poppyDocument(e.card, 'https://127.0.0.1:8788'), null);
  assert.equal(door.poppyDocument(e.card, 'http://127.0.0.1:8788'), null);
});

// ---------------------------------------------------------------------------------------------
// the route

test('poppy: true serves the document as application/json, valid, equal to poppyDocument', () => {
  const e = entry({ poppy: true });
  const r = served(e);
  assert.equal(mediaType(r.headers), 'application/json');
  assert.equal(header(r.headers, 'content-length'), String(r.body.length));
  assert.deepEqual(poppyProblems(r.doc, 'https://shop.example'), []);
  assert.deepEqual(doorShapeProblems(r.doc), []);
  assert.deepEqual(r.doc, door.poppyDocument(e.card, 'https://shop.example'));
});

test('the route follows the card route header pattern (CORS headers as the card has them)', () => {
  const e = entry({ poppy: true });
  const r = served(e);
  const card = get(e, AGENT_CARD_PATH);
  for (const k of ['Access-Control-Allow-Origin', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Headers', 'Access-Control-Max-Age']) {
    assert.equal(header(r.headers, k), header(card.headers, k), k);
  }
  assert.equal(header(r.headers, 'cache-control'), header(card.headers, 'cache-control'), 'cache-control differs from the card route');
});

test('the route on a non-443 origin names host:port, compared ignoring case', () => {
  const e = entry({ poppy: true, baseUrl: 'https://Shop.Example:8443' });
  const r = served(e);
  assert.deepEqual(poppyProblems(r.doc, 'https://shop.example:8443'), []);
});

test('two GETs answer the same bytes', () => {
  const e = entry({ poppy: true });
  assert.ok(served(e).body.equals(served(e).body));
});

test('HEAD matches GET: status and every header', () => {
  const e = entry({ poppy: true });
  const g = get(e, PATH);
  const h = get(e, PATH, {}, 'HEAD');
  assert.equal(h.status, 200);
  assert.equal(h.status, g.status);
  assert.deepEqual(h.headers, g.headers);
});

test('HEAD over a live server: same status, type and length as GET, no body', async () => {
  const e = entry({ poppy: true });
  const server = await new Promise((resolve, reject) => {
    const s = e.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  try {
    const port = server.address().port;
    const call = (method) => new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: PATH, method }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.setTimeout(5000, () => { req.destroy(); reject(new Error(`timeout ${method}`)); });
      req.on('error', reject);
      req.end();
    });
    const g = await call('GET');
    const h = await call('HEAD');
    assert.equal(g.status, 200);
    assert.equal(h.status, 200);
    assert.equal(h.headers['content-type'], g.headers['content-type']);
    assert.equal(h.headers['content-length'], g.headers['content-length']);
    assert.equal(h.body.length, 0);
    // The Host this client sent was 127.0.0.1:<port>; the domain is still the configured one.
    assert.equal(JSON.parse(g.body.toString('utf8')).organization.domain, 'shop.example');
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------------------------
// the switch and the http refusal

test('the switch is OFF by default: the ordinary 404, byte for byte', () => {
  const r = get(entry(), PATH);
  assert.equal(r.status, 404);
  assert.equal(r.body.toString('utf8'), NOT_FOUND);
  assert.equal(get(entry(), PATH, {}, 'HEAD').status, 404);
});

test('poppy: false gives the ordinary 404', () => {
  const r = get(entry({ poppy: false }), PATH);
  assert.equal(r.status, 404);
  assert.equal(r.body.toString('utf8'), NOT_FOUND);
});

test('refusal: poppy accepts only a boolean', () => {
  for (const bad of ['yes', 1, {}, 'true']) {
    assert.throws(() => entry({ poppy: bad }), (err) => err instanceof TypeError && /poppy/.test(err.message),
      `poppy: ${JSON.stringify(bad)} started a door`);
  }
});

test('refusal: an http origin starts, and serves no file (404)', () => {
  const e = createAgentEntry({ seedHex: SEED, name: NAME, description: DESCRIPTION,
    baseUrl: 'http://127.0.0.1:8788', poppy: true });
  for (const method of ['GET', 'HEAD']) {
    const r = get(e, PATH, { host: '127.0.0.1:8788' }, method);
    assert.equal(r.status, 404, `${method} on an http origin is ${r.status}`);
    assert.equal(r.body.toString('utf8'), NOT_FOUND);
  }
});

// ---------------------------------------------------------------------------------------------
// attacks

test('attack: a Host header naming another domain changes not one byte', () => {
  const e = entry({ poppy: true });
  const base = served(e).body;
  for (const host of ['victim.example', 'VICTIM.example:8443', 'shop.example.victim.example', 'shop.example:444',
    'shop.example@victim.example', '127.0.0.1', '']) {
    const r = get(e, PATH, { host });
    assert.equal(r.status, 200, `Host ${host}`);
    assert.ok(r.body.equals(base), `Host ${JSON.stringify(host)} changed the document: ${r.body.toString('utf8').slice(0, 200)}`);
  }
});

test('attack: X-Forwarded-Host and Forwarded do not move the domain, even under trustProxy', () => {
  for (const trustProxy of [false, true]) {
    const e = entry({ poppy: true, trustProxy });
    const base = served(e).body;
    const r = get(e, PATH, { host: 'victim.example', 'x-forwarded-host': 'victim.example',
      'x-forwarded-proto': 'https', forwarded: 'host=victim.example;proto=https' });
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(base), `trustProxy ${trustProxy}: ${r.body.toString('utf8').slice(0, 200)}`);
    assert.equal(JSON.parse(r.body.toString('utf8')).organization.domain, 'shop.example');
  }
});

test('attack: control characters and markup in the name and description cannot break the JSON', () => {
  const nasty = 'Poppy\u0000\u0007\u001b[31m Shop\u007f\u0085  </script><script>alert(1)</script>"\\\'';
  let e;
  try {
    e = createAgentEntry({ seedHex: SEED, baseUrl: 'https://shop.example', poppy: true,
      name: nasty, description: `${nasty} <img src=x onerror=alert(1)>` });
  } catch (err) {
    // Refusing to start on such a name is acceptable; it must be a TypeError, never a crash later.
    assert.ok(err instanceof TypeError, String(err));
    return;
  }
  // A door that started with this name publishes it, cleaned: the name has letters to keep.
  const r = get(e, PATH);
  assert.equal(r.status, 200);
  const text = r.body.toString('utf8');
  const doc = JSON.parse(text);
  assert.deepEqual(poppyProblems(doc, 'https://shop.example'), []);
  for (const s of strings(doc)) assert.ok(!CONTROL.test(s), `control character survived in ${JSON.stringify(s)}`);
  assert.ok(!text.includes('<'), 'a raw < reached the served bytes');
  assert.ok(!/[\u0000-\u001f]/.test(text), 'a raw control byte reached the served bytes');
});

test('attack: 64 KiB of name and description cannot bloat the file', () => {
  const big = 'P'.repeat(64 * 1024);
  let e;
  try {
    e = createAgentEntry({ seedHex: SEED, baseUrl: 'https://shop.example', poppy: true, name: big, description: big });
  } catch (err) {
    assert.ok(err instanceof TypeError, String(err));
    return;
  }
  const r = get(e, PATH);
  assert.equal(r.status, 200);
  assert.ok(r.body.length <= 8192, `the document is ${r.body.length} bytes for a 64 KiB card`);
  const doc = JSON.parse(r.body.toString('utf8'));
  assert.deepEqual(poppyProblems(doc, 'https://shop.example'), []);
});

test('attack: no other spelling of the path serves the document', () => {
  const e = entry({ poppy: true });
  const spellings = [
    `${PATH}?a=1`, `${PATH}?protocol_version=0.4`, `${PATH}/`, `${PATH}//`,
    '/.well-known/POPPY.json', '/.WELL-KNOWN/poppy.json', '/.well-known/poppy.JSON', '/.Well-Known/Poppy.Json',
    '/.well-known/x/../poppy.json', '/x/../.well-known/poppy.json', '/.well-known/./poppy.json',
    '/.well-known/%2e%2e/.well-known/poppy.json', '/%2e%2e/.well-known/poppy.json',
    '/.well-known/poppy%2Ejson', '/.well-known/poppy%2ejson', '/%2Ewell-known/poppy.json',
    '/.well-known%2Fpoppy.json', '/.well-known/poppy.json%00', '/.well-known/poppy.json;x',
    '/.well-known/poppy.json.', '//.well-known/poppy.json', '/.well-known//poppy.json',
    '/.well-known\\poppy.json', '/support/.well-known/poppy.json', '.well-known/poppy.json',
    'https://shop.example/.well-known/poppy.json', 'https://victim.example/.well-known/poppy.json',
  ];
  for (const path of spellings) {
    for (const method of ['GET', 'HEAD']) {
      const r = get(e, path, {}, method);
      assert.equal(r.status, 404, `${method} ${path} answered ${r.status}`);
      assert.ok(!r.body.toString('utf8').includes('protocol_version'), `${method} ${path} leaked the document`);
    }
  }
});

test('attack: other methods on the path never answer the document', () => {
  const e = entry({ poppy: true });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = get(e, PATH, { 'content-type': 'application/json' }, method);
    assert.notEqual(r.status, 200, `${method} answered 200`);
    assert.ok(!r.body.toString('utf8').includes('protocol_version'), `${method} leaked the document`);
  }
});

// ---------------------------------------------------------------------------------------------
// the existing routes are unchanged

test('the card is byte-for-byte unchanged with the switch on (bare, port, mount)', () => {
  for (const baseUrl of Object.keys(GOLDEN.card)) {
    for (const poppy of [undefined, false, true]) {
      const extra = poppy === undefined ? { baseUrl } : { baseUrl, poppy };
      const e = entry(extra);
      const mount = new URL(baseUrl).pathname.replace(/\/$/, '');
      const r = get(e, mount + AGENT_CARD_PATH);
      assert.equal(r.status, 200);
      assert.equal(sha(r.body), GOLDEN.card[baseUrl], `card bytes moved for ${baseUrl} poppy=${poppy}`);
      assert.deepEqual(r.headers, { ...CARD_HEADERS, 'Content-Length': GOLDEN.cardLength[baseUrl] });
      assert.equal('poppy' in e.card, false);
    }
  }
});

test('tools, proof and notice routes are byte-for-byte unchanged with the switch on', () => {
  const e = entry({ poppy: true, ownershipProof: PROOF });
  for (const p of ['/.well-known/agent-tools.json', '/.well-known/agent-tools/v1.json']) {
    const r = get(e, p);
    assert.equal(r.status, 200, p);
    assert.equal(sha(r.body), GOLDEN.tools, p);
  }
  const proof = get(e, PROOF.path);
  assert.equal(proof.status, 200);
  assert.equal(sha(proof.body), GOLDEN.proof);
  const notice = get(e, '/');
  assert.equal(notice.status, 200);
  assert.equal(sha(notice.body), GOLDEN.notice);
  const other = get(e, '/.well-known/not-poppy.json');
  assert.equal(other.status, 404);
  assert.equal(other.body.toString('utf8'), NOT_FOUND);
});

// ---------------------------------------------------------------------------------------------
// the README, for a door mounted below the root

test('README documents the switch, the mounted-door rewrite and the exact-path rule', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(PATH), 'README never names /.well-known/poppy.json');
  assert.ok(/\bpoppy\s*:\s*true\b/.test(readme), 'README never shows the poppy: true option');
  const at = readme.indexOf(PATH);
  const section = readme.slice(Math.max(0, at - 4000), at + 4000);
  assert.ok(/\b(rewrite|redirect)\b/i.test(section), 'no redirect or rewrite named beside the poppy path');
  assert.ok(/exactly\s+`?\/\.well-known\/poppy\.json`?/i.test(readme),
    'README does not state that the final path must be exactly /.well-known/poppy.json');
  assert.ok(/\bquery\b/i.test(section), 'README does not say the final URL carries no query');
});

// ---------------------------------------------------------------------------------------------
// round 2: what an independent review of Poppy 1.0 found unpinned or wrong. Every test below
// reaches the document or the refusal through createAgentEntry and handleRequest only.

const SHOP = 'https://shop.example';

/** The card's built-in defaults, read off a door that was given neither (poppy off). */
function cardDefaults() {
  const e = createAgentEntry({ seedHex: SEED, baseUrl: SHOP });
  return { name: e.card.name, description: e.card.description };
}

test('r2-1 default identity: poppy: true with no explicit name refuses to start, naming the option', () => {
  // Spec 3.1: organization.name is the Company's display name. The door's built-in name is the
  // software's, so publishing it would tell every Personal Agent the shop is called that.
  const defaults = cardDefaults();
  assert.ok(typeof defaults.name === 'string' && defaults.name, 'the door has no built-in name to guard against');
  let started = null;
  assert.throws(() => { started = createAgentEntry({ seedHex: SEED, baseUrl: SHOP, poppy: true }); },
    (err) => err instanceof TypeError && /\bname\b/.test(err.message),
    'poppy: true with no name started a door');
  if (started) {
    const r = get(started, PATH);
    assert.ok(!(r.status === 200 && JSON.parse(r.body.toString('utf8')).organization?.name === defaults.name),
      `the door published its built-in name ${JSON.stringify(defaults.name)} as the shop's`);
  }
  // The refusal is the poppy switch's: without it the same options still start.
  assert.doesNotThrow(() => createAgentEntry({ seedHex: SEED, baseUrl: SHOP }));
  assert.doesNotThrow(() => createAgentEntry({ seedHex: SEED, baseUrl: SHOP, poppy: false }));
});

test('r2-2a default description: no explicit description publishes no agent entry with the built-in text', () => {
  const defaults = cardDefaults();
  assert.ok(typeof defaults.description === 'string' && defaults.description, 'the door has no built-in description');
  const e = createAgentEntry({ seedHex: SEED, baseUrl: SHOP, name: NAME, poppy: true });
  const r = served(e);
  const protocols = (r.doc.agent && r.doc.agent.protocols) || [];
  for (const p of protocols) {
    assert.notEqual(p && p.description, defaults.description,
      'an agent.protocols entry carries the door\'s built-in description, not the shop\'s words');
  }
  assert.deepEqual(poppyProblems(r.doc, SHOP), []);
  assert.deepEqual(r.doc.web, {}, 'the document without an agent entry must keep web');
  assert.equal(r.doc.organization.name, NAME);
});

test('r2-2b explicit description: a non-empty one is the agent entry\'s description', () => {
  const e = createAgentEntry({ seedHex: SEED, baseUrl: SHOP, name: NAME, description: DESCRIPTION, poppy: true });
  const r = served(e);
  assert.deepEqual(poppyProblems(r.doc, SHOP), []);
  assert.ok(r.doc.agent && Array.isArray(r.doc.agent.protocols), 'no agent entry for an explicit description');
  assert.equal(r.doc.agent.protocols.length, 1);
  assert.equal(r.doc.agent.protocols[0].description, DESCRIPTION);
});

test('r2-2c explicit empty description: no agent entry, still valid via web', () => {
  const e = createAgentEntry({ seedHex: SEED, baseUrl: SHOP, name: NAME, description: '', poppy: true });
  const r = served(e);
  assert.equal('agent' in r.doc, false, 'agent entry present for description: \'\'');
  assert.deepEqual(r.doc.web, {});
  assert.deepEqual(poppyProblems(r.doc, SHOP), []);
});

const OTHER_METHODS = ['OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH'];

test('r2-3a methods: with poppy: true the path answers OPTIONS and non-GET methods as the card route does', () => {
  const e = entry({ poppy: true });
  for (const method of OTHER_METHODS) {
    const headers = { 'content-type': 'application/json', origin: 'https://agent.example' };
    const card = get(e, AGENT_CARD_PATH, headers, method);
    const poppy = get(e, PATH, headers, method);
    assert.equal(poppy.status, card.status,
      `${method} ${PATH} is ${poppy.status}, the card route answers ${card.status}`);
    assert.equal(header(poppy.headers, 'allow'), header(card.headers, 'allow'),
      `${method} ${PATH} Allow differs from the card route`);
    assert.equal(header(poppy.headers, 'access-control-allow-methods'), header(card.headers, 'access-control-allow-methods'),
      `${method} ${PATH} Access-Control-Allow-Methods differs from the card route`);
    assert.ok(!poppy.body.toString('utf8').includes('protocol_version'), `${method} leaked the document`);
  }
});

test('r2-3b methods: with poppy: false every method on the path is byte-identical to an unknown path', () => {
  for (const poppy of [undefined, false]) {
    const e = poppy === undefined ? entry() : entry({ poppy });
    for (const method of ['GET', 'HEAD', ...OTHER_METHODS]) {
      const headers = { 'content-type': 'application/json', origin: 'https://agent.example' };
      const a = get(e, PATH, headers, method);
      const b = get(e, '/.well-known/unknown-r2.json', headers, method);
      assert.equal(a.status, b.status, `poppy=${poppy} ${method}`);
      assert.deepEqual(a.headers, b.headers, `poppy=${poppy} ${method} headers`);
      assert.ok(a.body.equals(b.body), `poppy=${poppy} ${method} body`);
    }
  }
});

test('r2-4 mounted door: the document is at the HOST ROOT, and <mount>/.well-known/poppy.json is 404', () => {
  for (const guest of [false, true]) {
    const e = createAgentEntry({ seedHex: SEED, name: NAME, description: DESCRIPTION,
      baseUrl: `${SHOP}/support`, guest, poppy: true });
    for (const method of ['GET', 'HEAD']) {
      const root = get(e, PATH, {}, method);
      assert.equal(root.status, 200, `guest=${guest} ${method} ${PATH} at the host root is ${root.status}`);
      const under = get(e, `/support${PATH}`, {}, method);
      assert.equal(under.status, 404, `guest=${guest} ${method} /support${PATH} is ${under.status}`);
      assert.ok(!under.body.toString('utf8').includes('protocol_version'), `guest=${guest} the mount leaked the document`);
    }
    const r = served(e);
    assert.deepEqual(poppyProblems(r.doc, SHOP), []);
    assert.equal(r.doc.organization.domain, 'shop.example');
    assert.ok(r.doc.agent.protocols[0].endpoint.startsWith(`${SHOP}/support`), r.doc.agent.protocols[0].endpoint);
  }
});

test('r2-5 path clash: poppy: true with an ownershipProof on the poppy path refuses to start', () => {
  const clash = { path: PATH, body: 'proof-7731' };
  // The proof alone is a valid one, so the refusal below is the clash and nothing else.
  const alone = entry({ ownershipProof: clash });
  assert.equal(get(alone, PATH).status, 200);
  assert.throws(() => entry({ poppy: true, ownershipProof: clash }),
    (err) => err instanceof TypeError, 'poppy: true and a proof on the same path both started');
});

// The per-field caps, as the implementation states them (POPPY_MAX_NAME, POPPY_MAX_DESCRIPTION
// in muretai-agent-entry.mjs, in code points): an over-long value is cut, not refused.
const NAME_CAP = 200;
const DESCRIPTION_CAP = 800;

/** `n` code points, no whitespace at either end, every 50th an astral character (two code units). */
function codePoints(n, seed) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(i % 50 === 49 ? String.fromCodePoint(0x1f33a) : String.fromCharCode(0x41 + ((i + seed) % 26)));
  return out;
}

test('r2-6a cap: a name at the cap is kept whole, one over is cut to exactly the cap (code points)', () => {
  const atCap = codePoints(NAME_CAP, 0).join('');
  const a = served(createAgentEntry({ seedHex: SEED, baseUrl: SHOP, name: atCap, description: DESCRIPTION, poppy: true }));
  assert.equal(a.doc.organization.name, atCap);
  for (const extra of [1, 57]) {
    const long = codePoints(NAME_CAP + extra, 0);
    const r = served(createAgentEntry({ seedHex: SEED, baseUrl: SHOP, name: long.join(''), description: DESCRIPTION, poppy: true }));
    assert.ok(r.body.length < 8192 / 2, 'the total cap, not the name cap, would decide this case');
    assert.deepEqual(poppyProblems(r.doc, SHOP), []);
    assert.equal(Array.from(r.doc.organization.name).length, NAME_CAP, `name of ${NAME_CAP + extra} code points`);
    assert.equal(r.doc.organization.name, long.slice(0, NAME_CAP).join(''));
    assert.equal(r.doc.agent.protocols[0].description, DESCRIPTION, 'the description moved with the name cap');
  }
});

test('r2-6b cap: a description at the cap is kept whole, one over is cut to exactly the cap (code points)', () => {
  const atCap = codePoints(DESCRIPTION_CAP, 3).join('');
  const a = served(createAgentEntry({ seedHex: SEED, baseUrl: SHOP, name: NAME, description: atCap, poppy: true }));
  assert.equal(a.doc.agent.protocols[0].description, atCap);
  for (const extra of [1, 57]) {
    const long = codePoints(DESCRIPTION_CAP + extra, 3);
    const r = served(createAgentEntry({ seedHex: SEED, baseUrl: SHOP, name: NAME, description: long.join(''), poppy: true }));
    assert.ok(r.body.length < 8192 / 2, 'the total cap, not the description cap, would decide this case');
    assert.deepEqual(poppyProblems(r.doc, SHOP), []);
    const got = r.doc.agent.protocols[0].description;
    assert.equal(Array.from(got).length, DESCRIPTION_CAP, `description of ${DESCRIPTION_CAP + extra} code points`);
    assert.equal(got, long.slice(0, DESCRIPTION_CAP).join(''));
    assert.equal(r.doc.organization.name, NAME, 'the name moved with the description cap');
  }
});
