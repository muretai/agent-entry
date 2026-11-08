#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Quote terms, fix round 1: four findings from the security review of 21eb708.
//
// WRITTEN BEFORE THE FIXES; each case fails on 21eb708. Run it as
// `node conformance/quote-terms-fix1.mjs`.
//   1. A lapsed quote: the visitor compares validUntil with its own clock and marks the booking
//      `termsExpired: true` when it has passed, keeping the verified terms (never refusing).
//   2. A repeat `decide <ref> approve [--terms]` on a confirmed row is refused unless the new
//      terms (or their absence) equal the stored decision's terms, canonically.
//   3. The terms file is read once from one fd: not a regular file (a FIFO, /dev/zero) is
//      refused, and more than 16 KiB is refused however the size looked first.
//   4. The terms file is strict UTF-8: a Latin-1 note is refused, never signed as U+FFFD.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const {
  AGENT_CARD_PATH, confirmReceipt, createAgentEntry, createFileStore, createMemoryStore,
  didFromSeedHex, knockAgentEntry, signEnvelope,
} = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'muretai-agent-entry.mjs');
const NO_DIAL = pathToFileURL(join(HERE, 'fixtures', 'cli', 'no-dial.mjs')).href;

const SHOP_SEED = '3d'.repeat(32);
const CUSTOMER_SEED = '6c'.repeat(32);
const SHOP_BASE = 'https://repair.example';
const QUOTE_TEXT = 'quote repair {"item":"desk lamp","problem":"flickers when warm"}';
const HOLD_TEXT = 'hold item {"id":101}';
const MAX_TERMS_FILE_BYTES = 16 * 1024;

const DECLARATION = {
  v: 1,
  entry: { name: 'Bench Repair', baseUrl: SHOP_BASE },
  offers: [
    { verb: 'quote', of: 'repair', about: 'Get a price for a repair before you commit.',
      input: { item: 'string', problem: 'string' }, door: { reply: 'pending' } },
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
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const clone = (v) => JSON.parse(JSON.stringify(v));
const nowS = () => Math.floor(Date.now() / 1000);
const isoAt = (epochS) => new Date(epochS * 1000).toISOString().replace(/\.000Z$/, 'Z');
const liveTerms = (extra = {}) => ({ price: '120.00', currency: 'EUR', leadTime: 'P3D',
  validUntil: isoAt(nowS() + 30 * 86400), note: 'Parts in stock.', ...extra });

function makeDoor(store) {
  return createAgentEntry({ seedHex: SHOP_SEED, name: DECLARATION.entry.name, baseUrl: SHOP_BASE,
    declaration: clone(DECLARATION), signedRatePerMin: 0, signedRatePerMinTotal: 0, store });
}

const fetchVia = (entry) => async (url, init = {}) => {
  const u = new URL(url);
  const out = await entry.handleRequestAsync(init.method || 'GET', u.pathname + u.search, init.headers || {},
    Buffer.from(init.body || ''), { remoteAddress: '127.0.0.1' });
  return new Response(out.body, { status: out.status, headers: out.headers });
};

let sequence = 0;
async function knockOffer(entry, offer, text) {
  const from = didFromSeedHex(CUSTOMER_SEED);
  const messageId = `quote-terms-fix1-${offer}-${++sequence}-${process.pid}`;
  const timestamp = nowS();
  const sig = signEnvelope(CUSTOMER_SEED, { from, to: entry.did, messageId, contextId: null, timestamp, text });
  const body = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
      metadata: { from, to: entry.did, timestamp, sig, offer } } },
  }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
    { remoteAddress: '127.0.0.1' });
  const replyText = JSON.parse(Buffer.from(out.body).toString('utf8')).result.parts[0].text;
  const reply = JSON.parse(replyText);
  assert.equal(reply.status, 'pending_confirmation', `fixture: the door answers the ${offer} pending: ${replyText.slice(0, 300)}`);
  return { replyText, ref: reply.deal.ref };
}

const visitor = { keyPath: null };
before(() => {
  visitor.keyPath = join(tmp('ae-qt-fix1-key-'), 'knock-seed');
  writeFileSync(visitor.keyPath, `${CUSTOMER_SEED}\n`, { mode: 0o600 });
});

/** Run async `fn` with Date.now running `offsetMs` ahead of the real clock. */
async function aheadBy(offsetMs, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() + offsetMs;
  try { return await fn(); } finally { Date.now = realNow; }
}

// ================================================================ 1. a lapsed quote is marked

test('finding 1: a confirmed quote read after validUntil keeps its terms and reads termsExpired true', async () => {
  const store = createMemoryStore();
  const entry = makeDoor(store);
  const q = await knockOffer(entry, 'quote', QUOTE_TEXT);
  const terms = liveTerms({ validUntil: isoAt(nowS() + 20) });
  const text = confirmReceipt(SHOP_SEED, q.replyText, terms);
  const row = clone(await store.getReceipt(q.ref));
  row.decision = { status: 'confirmed', text, decided_ts: nowS() };
  await store.putReceipt(q.ref, row);
  const collect = () => knockAgentEntry(`${SHOP_BASE}${AGENT_CARD_PATH}`,
    { keyPath: visitor.keyPath, offer: 'track', text: JSON.stringify({ ref: q.ref }), fetchImpl: fetchVia(entry) });

  const early = await collect();
  assert.ok(early.ok && early.booking, `read before validUntil: ${JSON.stringify(early).slice(0, 300)}`);
  assert.ok(early.booking.termsExpired === undefined || early.booking.termsExpired === false,
    'before validUntil the terms are not marked expired');
  assert.deepEqual(early.booking.terms, terms);

  const late = await aheadBy(60_000, collect);
  assert.ok(late.ok, `a lapsed quote is not refused, its signature is still true: ${JSON.stringify(late).slice(0, 300)}`);
  assert.ok(late.booking, 'still read as a booking');
  assert.deepEqual(late.booking.terms, terms, 'the verified terms are kept');
  assert.equal(late.booking.termsExpired, true, 'the visitor\'s clock is past validUntil: termsExpired true');
  assert.equal(JSON.parse(late.text).termsExpired, true, 'the checked text says so too');
});

test('finding 1: a plain confirmation (no terms) never carries termsExpired', async () => {
  const store = createMemoryStore();
  const entry = makeDoor(store);
  const q = await knockOffer(entry, 'quote', QUOTE_TEXT);
  const row = clone(await store.getReceipt(q.ref));
  row.decision = { status: 'confirmed', text: confirmReceipt(SHOP_SEED, q.replyText), decided_ts: nowS() };
  await store.putReceipt(q.ref, row);
  const result = await aheadBy(60_000, () => knockAgentEntry(`${SHOP_BASE}${AGENT_CARD_PATH}`,
    { keyPath: visitor.keyPath, offer: 'track', text: JSON.stringify({ ref: q.ref }), fetchImpl: fetchVia(entry) }));
  assert.ok(result.ok && result.booking, JSON.stringify(result).slice(0, 300));
  assert.ok(!Object.hasOwn(result.booking, 'termsExpired'));
});

test('finding 1: README and spec/v1.md state that a lapsed quote is marked termsExpired, not refused', () => {
  for (const rel of ['README.md', 'spec/v1.md']) {
    assert.ok(readFileSync(join(HERE, '..', rel), 'utf8').includes('termsExpired'), `${rel} names termsExpired`);
  }
});

// ================================================================ the CLI

const cli = { project: null, home: null };
before(() => {
  cli.home = tmp('ae-qt-fix1-home-');
  cli.project = tmp('ae-qt-fix1-shop-');
  writeFileSync(join(cli.project, 'agent-entry.json'), `${JSON.stringify(DECLARATION, null, 2)}\n`);
});

function runDecide(args, { timeout = 20000 } = {}) {
  const log = join(tmp('ae-qt-fix1-dial-'), 'dial.jsonl');
  const env = { HOME: cli.home, AE_NO_DIAL_LOG: log, AGENT_ENTRY_SEED_HEX: SHOP_SEED };
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k];
  const run = spawnSync(process.execPath, ['--import', NO_DIAL, BIN, 'decide', ...args],
    { cwd: cli.project, env, encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
  return { code: run.status, stdout: run.stdout || '', stderr: run.stderr || '', timedOut: run.error?.code === 'ETIMEDOUT' };
}

const said = (run) => `exit ${run.code}${run.timedOut ? ' (timed out)' : ''}; stdout ${JSON.stringify(run.stdout.slice(0, 300))}; `
  + `stderr ${JSON.stringify(run.stderr.slice(0, 300))}`;

function assertRefused(run, { storePath, before: bytes, cause, what, codes = [1] }) {
  assert.ok(!run.timedOut, `${what}: timed out instead of refusing: ${said(run)}`);
  assert.ok(codes.includes(run.code), `${what} is refused with exit ${codes.join(' or ')}: ${said(run)}`);
  assert.equal(run.stdout.trim(), '', `${what}: nothing printed: ${said(run)}`);
  if (cause) assert.match(run.stderr, cause, `${what}: the refusal names its cause: ${said(run)}`);
  assert.equal(readFileSync(storePath, 'utf8'), bytes, `${what}: nothing is written to the store`);
}

async function cliStore() {
  const storePath = join(tmp('ae-qt-fix1-store-'), 'state.json');
  const entry = makeDoor(createFileStore(storePath));
  const quote = await knockOffer(entry, 'quote', QUOTE_TEXT);
  const hold = await knockOffer(entry, 'hold', HOLD_TEXT);
  return { storePath, quote, hold };
}

function termsFile(value) {
  const path = join(tmp('ae-qt-fix1-file-'), 'terms.json');
  writeFileSync(path, Buffer.isBuffer(value) || typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

// ================================================================ 2. a repeat approve with other terms

test('finding 2: plain approve, then approve --terms, is refused; the stored decision stays', async () => {
  const { storePath, quote } = await cliStore();
  const first = runDecide([quote.ref, 'approve', '--store', storePath]);
  assert.equal(first.code, 0, said(first));
  const bytes = readFileSync(storePath, 'utf8');
  assertRefused(runDecide([quote.ref, 'approve', '--terms', termsFile(liveTerms()), '--store', storePath]),
    { storePath, before: bytes, cause: /terms/i, what: 'approve --terms after a plain approve' });
});

test('finding 2: approve --terms a, then --terms b with another price, is refused', async () => {
  const { storePath, quote } = await cliStore();
  const a = liveTerms();
  const first = runDecide([quote.ref, 'approve', '--terms', termsFile(a), '--store', storePath]);
  assert.equal(first.code, 0, said(first));
  const bytes = readFileSync(storePath, 'utf8');
  assertRefused(runDecide([quote.ref, 'approve', '--terms', termsFile({ ...a, price: '1.00' }), '--store', storePath]),
    { storePath, before: bytes, cause: /terms/i, what: 'a second approve at another price' });
  assertRefused(runDecide([quote.ref, 'approve', '--store', storePath]),
    { storePath, before: bytes, cause: /terms/i, what: 'a plain approve after a priced one' });
});

test('finding 2: the same terms twice is idempotent, whatever their key order or spacing', async () => {
  const { storePath, quote } = await cliStore();
  const a = liveTerms();
  const first = runDecide([quote.ref, 'approve', '--terms', termsFile(a), '--store', storePath]);
  assert.equal(first.code, 0, said(first));
  const bytes = readFileSync(storePath, 'utf8');
  const stored = (await createFileStore(storePath).getReceipt(quote.ref)).decision.text;
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  const again = runDecide([quote.ref, 'approve', '--terms', termsFile(JSON.stringify(reordered)), '--store', storePath]);
  assert.equal(again.code, 0, said(again));
  assert.equal(again.stdout.trim(), stored, 'prints the stored decision');
  assert.equal(readFileSync(storePath, 'utf8'), bytes, 'writes nothing');
  const plain = await cliStore();
  assert.equal(runDecide([plain.quote.ref, 'approve', '--store', plain.storePath]).code, 0);
  const plainAgain = runDecide([plain.quote.ref, 'approve', '--store', plain.storePath]);
  assert.equal(plainAgain.code, 0, `plain approve twice stays idempotent: ${said(plainAgain)}`);
});

// ================================================================ 3. one fd, a regular file, the cap

test('finding 3: a FIFO as the terms file is refused, not waited on', async () => {
  const { storePath, quote } = await cliStore();
  const bytes = readFileSync(storePath, 'utf8');
  const fifo = join(tmp('ae-qt-fix1-fifo-'), 'terms.json');
  const made = spawnSync('mkfifo', [fifo]);
  assert.equal(made.status, 0, `fixture: mkfifo: ${made.stderr}`);
  assertRefused(runDecide([quote.ref, 'approve', '--terms', fifo, '--store', storePath], { timeout: 10000 }),
    { storePath, before: bytes, cause: /terms file/i, what: 'a FIFO' });
});

test('finding 3: /dev/zero as the terms file is refused as not a regular file', async () => {
  const { storePath, quote } = await cliStore();
  const bytes = readFileSync(storePath, 'utf8');
  assertRefused(runDecide([quote.ref, 'approve', '--terms', '/dev/zero', '--store', storePath], { timeout: 10000 }),
    { storePath, before: bytes, cause: /regular file/i, what: '/dev/zero' });
});

test('finding 3: a terms file of exactly the cap is read; one byte more is refused', async () => {
  const { storePath, quote } = await cliStore();
  const bytes = readFileSync(storePath, 'utf8');
  const json = JSON.stringify(liveTerms());
  const over = json + ' '.repeat(MAX_TERMS_FILE_BYTES + 1 - json.length);
  assert.equal(Buffer.byteLength(over), MAX_TERMS_FILE_BYTES + 1);
  assertRefused(runDecide([quote.ref, 'approve', '--terms', termsFile(over), '--store', storePath]),
    { storePath, before: bytes, cause: /larger than/i, what: 'cap + 1 bytes' });
  const exact = over.slice(0, -1);
  const run = runDecide([quote.ref, 'approve', '--terms', termsFile(exact), '--store', storePath]);
  assert.equal(run.code, 0, `exactly the cap is read: ${said(run)}`);
});

// ================================================================ 4. strict UTF-8

test('finding 4: a Latin-1 encoded note is refused, never signed as U+FFFD', async () => {
  const { storePath, quote } = await cliStore();
  const bytes = readFileSync(storePath, 'utf8');
  const latin1 = Buffer.from(JSON.stringify(liveTerms({ note: 'Pièces en stock.' })), 'latin1');
  assert.ok(!latin1.includes(Buffer.from('è', 'utf8')), 'fixture: the note is not UTF-8');
  assertRefused(runDecide([quote.ref, 'approve', '--terms', termsFile(latin1), '--store', storePath]),
    { storePath, before: bytes, cause: /UTF-8/i, what: 'a Latin-1 note' });
  const utf8 = runDecide([quote.ref, 'approve', '--terms', termsFile(liveTerms({ note: 'Pièces en stock.' })),
    '--store', storePath]);
  assert.equal(utf8.code, 0, `the same note in UTF-8 is signed: ${said(utf8)}`);
  const signed = JSON.parse((await createFileStore(storePath).getReceipt(quote.ref)).decision.text);
  assert.equal(signed.terms.note, 'Pièces en stock.');
});
