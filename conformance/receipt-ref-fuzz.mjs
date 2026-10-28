#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Kind fuzz: the visitor-chosen messageId, which becomes a receipt's ref.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). Intake 20261028T210658Z, finding D1 of the
// security review secrev-entry-6059-0363-2. The implementer may not edit this file. Run it as
// `bash .cursor/skills/isolated-session/scripts/run-node.sh conformance/receipt-ref-fuzz.mjs`.
//
// Property: no_crash -- for every generated messageId the door answers a JSON-RPC 2.0 object with
// exactly one of result and error, and never throws -- plus one invariant: a repeated messageId
// never changes an existing row. Each case files a hold under the id, moves a fake clock past the
// replay window (REPLAY_TTL_S), and sends a second hold under the same id from a different visitor
// with different text. When the first hold left a row, the second is refused -32603 and the row
// reads back byte-identical. An id the seam's signEnvelope refuses (a lone surrogate) is not
// sendable: that case is skipped and counted apart, and the quarter-filed check counts sent cases.
//
// Deterministic: a local seeded generator (mulberry32, fixed seed), a fake Date.now, no network,
// no real time, no sleeps. A failure names the case index and the id, so it reproduces exactly.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const {
  ERRORS, MAX_MESSAGE_ID_BYTES, REPLAY_TTL_S, createAgentEntry, createFileStore, createMemoryStore, didFromSeedHex,
  signEnvelope,
} = door;

const FUZZ_SEED = 0x5eed2610;
const MEMORY_CASES = 300;
const FILE_CASES = 40;

const DOOR_SEED = 'b8'.repeat(32);
const DECLARATION = {
  v: 1,
  entry: { name: 'Harbor Lamp', baseUrl: 'https://shop.example' },
  offers: [{ verb: 'hold', of: 'item', about: 'Hold one item for pickup; the shop confirms it.',
    input: { id: 'integer' }, door: { reply: 'pending' } }],
};

const scratch = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the seeded generator

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIXED = ['1', '0', '__proto__', 'constructor', 'hasOwnProperty', 'toString', ' ', 'null', 'undefined',
  '{"ref":"x"}', '../../etc/passwd', 'a\u0000b', '‮', '😀', 'ref\nnext', '\ud800'];

/** One messageId of a random kind: short counters, ASCII, controls, astral, lone surrogates, long. */
function messageIdFrom(rand) {
  const pick = (s) => s[Math.floor(rand() * s.length)];
  const kind = Math.floor(rand() * 7);
  const len = 1 + Math.floor(rand() * 24);
  let out = '';
  switch (kind) {
    case 0: return pick(FIXED);
    case 1: return String(Math.floor(rand() * 1000));
    case 2: for (let i = 0; i < len; i += 1) out += String.fromCharCode(0x20 + Math.floor(rand() * 95)); return out;
    case 3: for (let i = 0; i < len; i += 1) out += String.fromCharCode(Math.floor(rand() * 0x20)); return out;
    case 4: for (let i = 0; i < len; i += 1) out += String.fromCodePoint(0x1f300 + Math.floor(rand() * 0x300)); return out;
    case 5: for (let i = 0; i < len; i += 1) out += String.fromCharCode(Math.floor(rand() * 0x10000)); return out;
    default: return 'x'.repeat(MAX_MESSAGE_ID_BYTES - 8 + Math.floor(rand() * 16));
  }
}

const seedHexFrom = (rand) => Array.from({ length: 32 }, () => Math.floor(rand() * 256).toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- the fake clock and the door

const REAL_NOW = Date.now;
async function withFakeClock(fn) {
  const clock = { ms: REAL_NOW() };
  Date.now = () => clock.ms;
  try {
    return await fn({ advance: (seconds) => { clock.ms += seconds * 1000; } });
  } finally {
    Date.now = REAL_NOW;
  }
}

function makeDoor(store) {
  return createAgentEntry({ seedHex: DOOR_SEED, name: DECLARATION.entry.name, baseUrl: DECLARATION.entry.baseUrl,
    declaration: JSON.parse(JSON.stringify(DECLARATION)), signedRatePerMin: 0, signedRatePerMinTotal: 0,
    responder: () => 'ok', store });
}

/** One signed hold under `messageId`; returns the parsed JSON-RPC answer (no_crash checked here). */
async function hold(entry, seed, messageId, text, what) {
  const from = didFromSeedHex(seed);
  const timestamp = Math.floor(Date.now() / 1000);
  let out;
  try {
    const sig = signEnvelope(seed, { from, to: entry.did, messageId, contextId: null, timestamp, text });
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send',
      params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
        metadata: { offer: 'hold', from, to: entry.did, timestamp, sig } } } }));
    out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
      { remoteAddress: '127.0.0.1' });
  } catch (e) {
    assert.fail(`${what}: the door threw: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
  }
  assert.ok(out && Number.isInteger(out.status), `${what}: an HTTP answer`);
  let parsed;
  try { parsed = JSON.parse(Buffer.from(out.body || '').toString('utf8')); } catch {
    assert.fail(`${what}: the body is not JSON`);
  }
  assert.equal(parsed?.jsonrpc, '2.0', `${what}: a JSON-RPC 2.0 answer`);
  assert.ok(('result' in parsed) !== ('error' in parsed), `${what}: exactly one of result and error`);
  return parsed;
}

/** Whether the test seam's signer accepts `messageId` (it refuses lone surrogates before any door sees them). */
function signable(seed, messageId) {
  try {
    signEnvelope(seed, { from: didFromSeedHex(seed), to: 'did:key:z', messageId, contextId: null, timestamp: 0, text: 'x' });
    return true;
  } catch {
    return false;
  }
}

async function fuzz(store, cases, label) {
  const rand = mulberry32(FUZZ_SEED);
  const entry = makeDoor(store);
  let filed = 0;
  let sent = 0;
  let skipped = 0;
  await withFakeClock(async ({ advance }) => {
    for (let i = 0; i < cases; i += 1) {
      const id = messageIdFrom(rand);
      const what = `${label} case ${i} messageId ${JSON.stringify(id).slice(0, 80)}`;
      const first = seedHexFrom(rand);
      const second = seedHexFrom(rand);
      // Not sendable: no visitor can sign this id, so it is skipped, never counted as the door failing.
      // The window draw is still taken so the generator stream is the same whatever is skipped.
      if (!signable(first, id)) {
        skipped += 1;
        advance(REPLAY_TTL_S + 1 + Math.floor(rand() * 3600) + 1);
        continue;
      }
      sent += 1;
      await hold(entry, first, id, `hold item {"id":${i}}`, `${what} (first)`);
      const before = JSON.stringify(await store.getReceipt(id));
      advance(REPLAY_TTL_S + 1 + Math.floor(rand() * 3600));
      const again = await hold(entry, second, id, `hold item {"id":${100000 + i}}`, `${what} (repeat)`);
      const afterRow = JSON.stringify(await store.getReceipt(id));
      if (before !== 'null') {
        filed += 1;
        assert.equal(afterRow, before, `${what}: a repeated messageId never changes the existing row`);
        assert.ok(!again.result, `${what}: the repeat is not answered`);
        assert.equal(again.error?.code, ERRORS.INTERNAL_ERROR.code, `${what}: the repeat is refused -32603`);
      }
      advance(1);
    }
  });
  assert.equal(sent + skipped, cases, `${label}: every case is either sent or skipped`);
  // A harness whose ids the door refused every time would prove nothing.
  assert.ok(sent > 0 && filed >= sent / 4,
    `${label}: at least a quarter of the sent cases filed a row (${filed} of ${sent} sent, ${skipped} not sendable)`);
}

test('kind fuzz, memory store: no_crash, and a repeated messageId never changes an existing row', async () => {
  await fuzz(createMemoryStore(), MEMORY_CASES, 'memory');
});

test('kind fuzz, file store: no_crash, and a repeated messageId never changes an existing row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ae-ref-fuzz-'));
  scratch.push(dir);
  await fuzz(createFileStore(join(dir, 'state.json')), FILE_CASES, 'file');
});
