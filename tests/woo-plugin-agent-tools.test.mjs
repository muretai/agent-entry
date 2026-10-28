#!/usr/bin/env node
// FRAME skeleton item, parent intake 20261015T135200Z, this intake 20261020T163649Z.
// The WooCommerce plugin serves the agent-tools contract and its signature at the
// well-known paths, byte for byte what the Node door serves for the same declaration
// and seed. Written before that serving exists. The card, ask and hold are other items.
//
// Spec wording, tools-v1.md, not invented here:
//   AT-6  the contract {v, name, origins, version, offers, facts?, hash}
//   AT-8  the agenttools envelope {v, typ, contract, ts, sig}
//   AT-9  a contract whose origins omit the door origin is refused
//   AT-10 GET the contract and the envelope; OPTIONS 204; any other method 405
//         with Allow GET, HEAD, OPTIONS; every other agent-tools address 404
// The intake calls this serving pair AT-6 and AT-7. A refused signature carries no
// contract bytes. No private fact appears in either body.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALLOW_CARD,
  TOOLS_PATH,
  TOOLS_SIG_PATH,
  canonicalJSON,
  compileDeclaration,
  didFromSeedHex,
  makeToolsEnvelope,
  verifyCardEnvelope,
  verifyToolsEnvelope,
} from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PLUGIN = join(ROOT, 'examples', 'woocommerce-agent-entry.php');
const SHIM = join(ROOT, 'conformance', 'fixtures', 'woo-plugin', 'wp-shim.php');
const VECTORS = join(ROOT, 'conformance', 'vectors-tools.json');
const VECTOR_NAME = 'harbor-lamp-every-reply-kind-and-facts';
const DECLARATION_OPTION = 'muretai_agent_entry_declaration';
const PRIVATE = 'Quill-contact-7731-owner-at-harbor.example';
const INJECT = 'inject-sentinel-tools-9f3a';
const SIX_HOURS_S = 6 * 60 * 60;
const METHOD_NOT_ALLOWED = '{"error":"method not allowed"}';
const NOT_FOUND = '{"error":"not found"}';
const PRIVATE_TRACES = [
  PRIVATE,
  Buffer.from(PRIVATE, 'utf8').toString('base64'),
  Buffer.from(PRIVATE, 'utf8').toString('base64url'),
  Buffer.from(PRIVATE, 'utf8').toString('hex'),
  encodeURIComponent(PRIVATE),
];

const vectorFile = JSON.parse(readFileSync(VECTORS, 'utf8'));
const vector = vectorFile.vectors.find((item) => item.name === VECTOR_NAME);
const ORIGIN = vector.declaration.entry.baseUrl;

function declarationFor(baseUrl) {
  const declaration = JSON.parse(JSON.stringify(vector.declaration));
  declaration.entry.baseUrl = baseUrl;
  declaration.privateFacts = { owner_line: PRIVATE };
  return declaration;
}

function contractBytesFor(declaration) {
  const compiled = compileDeclaration(declaration, { version: vector.version });
  return {
    compiled,
    bytes: Buffer.from(canonicalJSON(compiled), 'utf8'),
  };
}

function hashWithout(contract) {
  const rest = { ...contract };
  delete rest.hash;
  return createHash('sha256').update(canonicalJSON(rest), 'utf8').digest('hex');
}

function phpBinary() {
  const candidates = [process.env.AGENT_ENTRY_PHP, 'php', '/opt/homebrew/bin/php'].filter(Boolean);
  for (const bin of candidates) {
    const out = spawnSync(bin, ['-r', 'echo extension_loaded("sodium") ? "sodium" : "no-sodium";'], {
      encoding: 'utf8', timeout: 15000,
    });
    if (!out.error && out.status === 0) return { bin, sodium: out.stdout.trim() === 'sodium' };
  }
  return null;
}

const phpString = (text) => `s:${Buffer.byteLength(text, 'utf8')}:"${text}";`;

function readState(path) {
  const state = JSON.parse(readFileSync(path, 'utf8'));
  return { options: state.options || {}, transients: state.transients || {} };
}

function writeState(path, state) {
  writeFileSync(path, JSON.stringify(state));
}

function serializedStrings(buf) {
  const text = buf.toString('latin1');
  const out = [];
  for (const match of text.matchAll(/s:(\d+):"/g)) {
    const start = match.index + match[0].length;
    out.push(Buffer.from(text.slice(start, start + Number(match[1])), 'latin1'));
  }
  return out;
}

function seedCandidates(state) {
  const seeds = new Set();
  for (const value of Object.values(state.options)) {
    for (const raw of serializedStrings(Buffer.from(String(value), 'base64'))) {
      if (raw.length === 32) seeds.add(raw.toString('hex'));
      const text = raw.toString('utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(text)) seeds.add(text.toLowerCase());
      const decoded = Buffer.from(text, 'base64');
      if (decoded.length === 32 && decoded.toString('base64') === text) seeds.add(decoded.toString('hex'));
    }
  }
  return [...seeds];
}

function rewriteStored(state, needle, replacement) {
  const from = Buffer.from(needle, 'utf8').toString('latin1');
  const to = Buffer.from(replacement, 'utf8').toString('latin1');
  assert.equal(from.length, to.length);
  let hits = 0;
  const rewrite = (encoded) => {
    const buf = Buffer.from(String(encoded), 'base64');
    const text = buf.toString('latin1');
    const found = text.split(from).length - 1;
    if (!found) return null;
    hits += found;
    return Buffer.from(text.split(from).join(to), 'latin1').toString('base64');
  };
  for (const [key, value] of Object.entries(state.options)) {
    const next = rewrite(value);
    if (next) state.options[key] = next;
  }
  for (const row of Object.values(state.transients)) {
    if (!row || typeof row.value !== 'string') continue;
    const next = rewrite(row.value);
    if (next) row.value = next;
  }
  return hits;
}

// The install may store the seed as 32 raw bytes, 64 hex, or standard base64.
function dropSeed(state, seedHex) {
  const raw = Buffer.from(seedHex, 'hex').toString('latin1');
  const asHex = seedHex.toLowerCase();
  const asB64 = Buffer.from(seedHex, 'hex').toString('base64');
  let hits = 0;
  for (const [key, value] of Object.entries(state.options)) {
    const text = Buffer.from(String(value), 'base64').toString('latin1');
    if (text.includes(raw) || text.includes(asHex) || text.includes(asB64)) {
      delete state.options[key];
      hits += 1;
    }
  }
  return hits;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function httpBytes(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body });
  return {
    status: res.status,
    headers: res.headers,
    body: Buffer.from(await res.arrayBuffer()),
  };
}

function leaked(body) {
  const text = body.toString('utf8');
  return PRIVATE_TRACES.filter((trace) => text.includes(trace));
}

function containsContract(body, contractBytes) {
  return body.equals(contractBytes) || body.includes(contractBytes);
}

function startPhp(php, port, env) {
  const child = spawn(php.bin, ['-S', `127.0.0.1:${port}`, SHIM], {
    cwd: dirname(SHIM), env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const ready = (async () => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      try {
        await fetch(`http://127.0.0.1:${port}/`);
        return;
      } catch {
        await new Promise((done) => { setTimeout(done, 100); });
      }
    }
    child.kill('SIGKILL');
    throw new Error(`php -S did not start: ${stderr.slice(0, 400)}`);
  })();
  return { child, stderr: () => stderr, ready };
}

function activate(php, env) {
  return spawnSync(php.bin, [SHIM, 'activate'], { env, encoding: 'utf8', timeout: 30000 });
}

function optionBytes(declaration) {
  return Buffer.from(phpString(JSON.stringify(declaration)), 'utf8').toString('base64');
}

test('the plugin is the one file that signs the agent-tools envelope', () => {
  assert.equal(ALLOW_CARD, 'GET, HEAD, OPTIONS');
  assert.equal(TOOLS_PATH, '/.well-known/agent-tools.json');
  assert.equal(TOOLS_SIG_PATH, '/.well-known/agent-tools.sig.json');
  assert.ok(existsSync(SHIM), 'the WordPress shim the plugin runs under is missing');
  assert.ok(existsSync(PLUGIN), 'examples/woocommerce-agent-entry.php does not exist');
  const php = readFileSync(PLUGIN, 'utf8');
  assert.match(php, /Plugin Name:/);
  assert.match(php, /WooCommerce/);
  assert.ok(php.includes("defined('ABSPATH')"), 'the plugin must refuse to run outside WordPress');
  assert.ok(php.includes(TOOLS_PATH) && php.includes(TOOLS_SIG_PATH),
    'the plugin must name the well-known contract and signature paths');
  assert.ok(php.includes('sodium_crypto_sign_seed_keypair') && php.includes('sodium_crypto_sign_detached'),
    'the signature is PHP sodium, the same construction as the card');
  assert.ok(!/\b(?:require|include)(?:_once)?\s*\(?\s*['"]/.test(php),
    'the install is one file: no sibling PHP is loaded');
  assert.ok(!php.includes('http://127.0.0.1') && !/\b(?:shell_exec|proc_open|passthru|popen)\s*\(/.test(php),
    'the plugin does not shell out or call a hidden sidecar');
});

test('the plugin serves agent-tools.json and its signature, and refuses the rest', async () => {
  assert.ok(vector, `conformance vector ${VECTOR_NAME} is missing`);
  const pinned = contractBytesFor(vector.declaration);
  assert.equal(pinned.bytes.toString('utf8'), canonicalJSON(vector.contract));
  assert.equal(pinned.compiled.hash, hashWithout(pinned.compiled));
  assert.equal(pinned.compiled.hash, vector.contract.hash);
  assert.ok(existsSync(PLUGIN), 'examples/woocommerce-agent-entry.php does not exist');
  const php = phpBinary();
  assert.ok(php, 'php is required to run the plugin');
  assert.ok(php.sodium, 'php has no sodium extension');

  const declaration = declarationFor(ORIGIN);
  const { compiled, bytes: contractBytes } = contractBytesFor(declaration);
  assert.equal(contractBytes.toString('utf8'), canonicalJSON(vector.contract));
  assert.equal(contractBytes.includes(PRIVATE), false);
  assert.deepEqual(leaked(contractBytes), []);

  const dir = mkdtempSync(join(tmpdir(), 'agent-entry-woo-tools-'));
  const port = await freePort();
  const statePath = join(dir, 'state.json');
  const freshState = () => JSON.stringify({
    options: { [DECLARATION_OPTION]: optionBytes(declaration) },
    transients: {},
  });
  writeFileSync(statePath, freshState());
  const env = {
    ...process.env,
    MAE_SHIM_PLUGIN: PLUGIN,
    MAE_SHIM_STATE: statePath,
    MAE_SHIM_HOME: ORIGIN,
  };
  const toolsUrl = `http://127.0.0.1:${port}${TOOLS_PATH}`;
  const sigUrl = `http://127.0.0.1:${port}${TOOLS_SIG_PATH}`;
  let server = null;
  try {
    server = startPhp(php, port, env);
    await server.ready;

    const before = readState(statePath);
    assert.equal(seedCandidates(before).length, 0, 'a fresh install has no seed yet');
    for (const url of [toolsUrl, sigUrl]) {
      const res = await httpBytes(url);
      assert.notEqual(res.status, 200, `${url} answered before a signature could exist`);
      assert.equal(containsContract(res.body, contractBytes), false, 'a missing signature served the contract');
      assert.equal(res.body.includes(Buffer.from('agenttools')), false);
      assert.equal(res.body.includes(Buffer.from('Harbor Lamp')), false);
      assert.deepEqual(leaked(res.body), [], `before activation leaked ${JSON.stringify(leaked(res.body))}`);
    }
    assert.deepEqual(seedCandidates(readState(statePath)), [], 'a request before activation minted a seed');

    const first = activate(php, env);
    assert.equal(first.status, 0, `activation status=${first.status} stderr=${String(first.stderr).slice(0, 300)}`);
    const minted = readState(statePath);
    const seeds = seedCandidates(minted);
    assert.ok(seeds.length > 0, `activation persisted no seed: ${JSON.stringify(Object.keys(minted.options))}`);

    const contract = await httpBytes(toolsUrl, { headers: { accept: 'application/json' } });
    const signature = await httpBytes(sigUrl, { headers: { accept: 'application/json' } });
    assert.equal(contract.status, 200, `contract HTTP ${contract.status} ${contract.body.toString('utf8').slice(0, 200)}`);
    assert.equal(signature.status, 200, `signature HTTP ${signature.status} ${signature.body.toString('utf8').slice(0, 200)}`);
    assert.match(String(contract.headers.get('content-type')), /^application\/json\b/);
    assert.match(String(signature.headers.get('content-type')), /^application\/json\b/);
    assert.ok(contract.body.equals(contractBytes),
      `contract bytes are not the conformance vector\n${contract.body.toString('utf8').slice(0, 300)}`);
    assert.equal(Number(contract.headers.get('content-length')), contractBytes.length);

    const asHtml = await httpBytes(toolsUrl, { headers: { accept: 'text/html' } });
    assert.equal(asHtml.status, 200);
    assert.match(String(asHtml.headers.get('content-type')), /^application\/json\b/);
    assert.ok(asHtml.body.equals(contractBytes), 'Accept: text/html changed the contract bytes');

    const head = await httpBytes(toolsUrl, { method: 'HEAD', headers: { accept: 'application/json' } });
    assert.equal(head.status, 200, `HEAD HTTP ${head.status}`);
    assert.match(String(head.headers.get('content-type')), /^application\/json\b/);
    assert.equal(Number(head.headers.get('content-length')), contractBytes.length);
    assert.equal(head.body.length, 0, 'HEAD served the contract body');

    const envelope = JSON.parse(signature.body.toString('utf8'));
    assert.equal(envelope.v, 1);
    assert.equal(envelope.typ, 'agenttools');
    assert.equal(Number.isSafeInteger(envelope.ts), true, JSON.stringify(envelope.ts));
    const now = Math.floor(Date.now() / 1000);
    assert.ok(envelope.ts <= now + 5, `signature ts ${envelope.ts} is in the future`);
    assert.ok(envelope.ts >= now - SIX_HOURS_S, `signature ts ${envelope.ts} is older than 6 hours`);
    assert.deepEqual(Object.keys(envelope).sort(), ['contract', 'sig', 'ts', 'typ', 'v']);

    let seedHex = null;
    let expectedSig = null;
    for (const candidate of seeds) {
      const mintedEnv = JSON.stringify(makeToolsEnvelope(candidate, compiled, envelope.ts));
      if (mintedEnv === signature.body.toString('utf8')) {
        seedHex = candidate;
        expectedSig = mintedEnv;
        break;
      }
    }
    assert.ok(seedHex, 'no minted seed reproduces the signature for this declaration and ts');
    assert.equal(signature.body.toString('utf8'), expectedSig);
    assert.equal(canonicalJSON(envelope.contract), contractBytes.toString('utf8'));
    assert.equal(envelope.contract.hash, hashWithout(envelope.contract));

    await new Promise((done) => { setTimeout(done, 1100); });
    const again = await httpBytes(sigUrl);
    assert.equal(again.status, 200);
    assert.ok(again.body.equals(signature.body), 'the signature was minted again instead of served from cache');
    const cachedHits = rewriteStored(readState(statePath), envelope.sig, envelope.sig);
    assert.ok(cachedHits > 0, 'the signature is not in the install state, so the cache dies with the process');

    const did = didFromSeedHex(seedHex);
    const seedB64 = Buffer.from(seedHex, 'hex').toString('base64');
    const served = Buffer.concat([contract.body, signature.body]);
    assert.equal(served.includes(Buffer.from(seedHex)), false, 'the seed hex was served');
    assert.equal(served.includes(Buffer.from(seedB64)), false, 'the seed base64 was served');
    assert.deepEqual(leaked(contract.body), [], `contract leaked ${JSON.stringify(leaked(contract.body))}`);
    assert.deepEqual(leaked(signature.body), [], `signature leaked ${JSON.stringify(leaked(signature.body))}`);

    const verified = verifyToolsEnvelope(envelope, did, { origin: ORIGIN });
    assert.equal(canonicalJSON(verified), contractBytes.toString('utf8'));
    assert.equal(verifyToolsEnvelope(envelope, did, { origin: 'https://evil.example' }), null);
    assert.equal(verifyToolsEnvelope(envelope, did, { origin: 'http://shop.example' }), null);
    assert.equal(verifyToolsEnvelope(envelope, didFromSeedHex('11'.repeat(32)), { origin: ORIGIN }), null);
    assert.equal(verifyToolsEnvelope(envelope, '', { origin: ORIGIN }), null);
    assert.equal(verifyCardEnvelope(envelope, did), null);
    assert.equal(verifyCardEnvelope({
      v: 1, typ: 'agentcard', card: { did }, ts: envelope.ts, sig: envelope.sig,
    }, did), null);

    const tamperedContract = JSON.parse(JSON.stringify(envelope));
    tamperedContract.contract.name = 'Not Harbor';
    assert.equal(verifyToolsEnvelope(tamperedContract, did, { origin: ORIGIN }), null);
    const flippedSig = `${envelope.sig.slice(0, 10)}${envelope.sig[10] === 'A' ? 'B' : 'A'}${envelope.sig.slice(11)}`;
    const tamperedSig = { ...envelope, sig: flippedSig };
    assert.equal(verifyToolsEnvelope(tamperedSig, did, { origin: ORIGIN }), null);
    const mismatchedHash = JSON.parse(JSON.stringify(envelope));
    mismatchedHash.contract.hash = 'ab'.repeat(32);
    assert.equal(verifyToolsEnvelope(mismatchedHash, did, { origin: ORIGIN }), null);
    assert.throws(
      () => makeToolsEnvelope(seedHex, { ...compiled, hash: 'ab'.repeat(32) }, envelope.ts),
      TypeError,
    );

    const queried = await httpBytes(`${toolsUrl}?injected=${INJECT}`);
    assert.equal(queried.status, 200);
    assert.ok(queried.body.equals(contractBytes), 'a query string changed the contract');
    assert.equal(queried.body.includes(Buffer.from(INJECT)), false);
    const headed = await httpBytes(toolsUrl, { headers: { 'x-inject': INJECT, accept: 'application/json' } });
    assert.ok(headed.body.equals(contractBytes), 'a request header changed the contract');
    assert.equal(headed.body.includes(Buffer.from(INJECT)), false);

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const url of [toolsUrl, sigUrl]) {
        const res = await httpBytes(url, {
          method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ injected: INJECT }),
        });
        assert.equal(res.status, 405, `${method} ${url} HTTP ${res.status} ${res.body.toString('utf8').slice(0, 200)}`);
        assert.equal(res.headers.get('allow'), ALLOW_CARD, `${method} Allow`);
        assert.equal(res.body.toString('utf8'), METHOD_NOT_ALLOWED);
        assert.equal(containsContract(res.body, contractBytes), false, `${method} served the contract`);
        assert.equal(res.body.includes(Buffer.from(INJECT)), false, `${method} echoed the body`);
        assert.deepEqual(leaked(res.body), [], `${method} leaked a private fact`);
      }
    }
    for (const url of [toolsUrl, sigUrl]) {
      const options = await httpBytes(url, { method: 'OPTIONS' });
      assert.equal(options.status, 204, `OPTIONS ${url} HTTP ${options.status}`);
      assert.equal(options.headers.get('allow'), ALLOW_CARD);
      assert.equal(options.body.length, 0);
    }

    for (const path of [
      `${TOOLS_PATH}/`,
      `${TOOLS_SIG_PATH}/`,
      '/.well-known/agent-tools/v0.json',
      '/.well-known/agent-tools/V1.json',
      '/.well-known/agent-tools.json.extra',
      '/.well-known/agent-tools.sig.json.extra',
      '/.well-known/agent-toolz.json',
    ]) {
      const res = await httpBytes(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 404, `${path} HTTP ${res.status}`);
      assert.equal(res.body.toString('utf8'), NOT_FOUND);
      assert.equal(containsContract(res.body, contractBytes), false, `${path} served the contract`);
      assert.deepEqual(leaked(res.body), [], `${path} leaked a private fact`);
    }

    const saved = readState(statePath);
    const snapshot = JSON.stringify(saved);

    const sigHits = rewriteStored(saved, envelope.sig, flippedSig);
    assert.ok(sigHits > 0, 'the cached signature could not be tampered');
    writeState(statePath, saved);
    const tamperedRes = await httpBytes(sigUrl);
    const tamperedDoc = await httpBytes(toolsUrl);
    assert.notEqual(tamperedRes.body.toString('utf8'), JSON.stringify(tamperedSig));
    if (tamperedRes.status === 200) {
      const repaired = JSON.parse(tamperedRes.body.toString('utf8'));
      assert.equal(canonicalJSON(verifyToolsEnvelope(repaired, did, { origin: ORIGIN })), contractBytes.toString('utf8'));
    } else {
      assert.equal(containsContract(tamperedRes.body, contractBytes), false, 'a refused signature carried the contract');
      assert.equal(tamperedDoc.status === 200, false, 'the contract was served on a refused signature');
      assert.equal(containsContract(tamperedDoc.body, contractBytes), false);
    }
    if (tamperedDoc.status !== 200) {
      assert.equal(containsContract(tamperedDoc.body, contractBytes), false);
    } else {
      assert.ok(tamperedDoc.body.equals(contractBytes));
    }
    assert.deepEqual(leaked(tamperedRes.body), []);
    assert.deepEqual(leaked(tamperedDoc.body), []);

    const mismatched = JSON.parse(snapshot);
    const hashHits = rewriteStored(mismatched, envelope.contract.hash, 'ab'.repeat(32));
    assert.ok(hashHits > 0, 'the cached contract hash could not be mismatched');
    writeState(statePath, mismatched);
    const mismatchSig = await httpBytes(sigUrl);
    const mismatchDoc = await httpBytes(toolsUrl);
    if (mismatchSig.status === 200) {
      const repaired = JSON.parse(mismatchSig.body.toString('utf8'));
      assert.equal(repaired.contract.hash, compiled.hash);
      assert.equal(canonicalJSON(verifyToolsEnvelope(repaired, did, { origin: ORIGIN })), contractBytes.toString('utf8'));
    } else {
      assert.equal(containsContract(mismatchSig.body, contractBytes), false, 'a mismatched signature carried the contract');
      assert.notEqual(mismatchDoc.status, 200, 'the contract was served on a mismatched signature');
      assert.equal(containsContract(mismatchDoc.body, contractBytes), false);
    }
    assert.equal(mismatchSig.body.includes(Buffer.from('ab'.repeat(32))), false, 'a mismatched hash was served');
    assert.deepEqual(leaked(mismatchSig.body), []);
    assert.deepEqual(leaked(mismatchDoc.body), []);

    const missing = JSON.parse(snapshot);
    assert.ok(dropSeed(missing, seedHex) > 0, 'the seed was not stored where a missing signature can be forced');
    writeState(statePath, missing);
    for (const url of [toolsUrl, sigUrl]) {
      const res = await httpBytes(url);
      assert.notEqual(res.status, 200, `${url} answered with no seed`);
      assert.equal(containsContract(res.body, contractBytes), false, 'a missing signature served the contract');
      assert.deepEqual(leaked(res.body), []);
    }

    writeState(statePath, JSON.parse(snapshot));
    const foreignState = readState(statePath);
    foreignState.options[DECLARATION_OPTION] = optionBytes(declarationFor('https://other.example'));
    writeState(statePath, foreignState);
    for (const url of [toolsUrl, sigUrl]) {
      const foreign = await httpBytes(url);
      assert.notEqual(foreign.status, 200, `${url} served a declaration for another origin`);
      assert.equal(containsContract(foreign.body, contractBytes), false);
      assert.equal(foreign.body.includes(Buffer.from('Harbor Lamp')), false);
      assert.equal(foreign.body.includes(Buffer.from('agenttools')), false);
      assert.deepEqual(leaked(foreign.body), []);
    }

    const brokenEncoded = Buffer.from(phpString('{'), 'utf8').toString('base64');
    foreignState.options[DECLARATION_OPTION] = brokenEncoded;
    writeState(statePath, foreignState);
    for (const url of [toolsUrl, sigUrl]) {
      const broken = await httpBytes(url);
      assert.notEqual(broken.status, 200, `${url} served a declaration that is not JSON`);
      assert.equal(containsContract(broken.body, contractBytes), false);
      assert.equal(broken.body.includes(Buffer.from('agenttools')), false);
      assert.deepEqual(leaked(broken.body), []);
    }

    const restored = JSON.parse(snapshot);
    writeState(statePath, restored);
    const back = await httpBytes(toolsUrl);
    assert.equal(back.status, 200);
    assert.ok(back.body.equals(contractBytes), 'restoring the declaration did not restore the contract');
    const backSig = await httpBytes(sigUrl);
    assert.equal(backSig.status, 200);
    assert.deepEqual(leaked(back.body), []);
    assert.deepEqual(leaked(backSig.body), []);
  } finally {
    if (server) server.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
