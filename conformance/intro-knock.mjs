#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// A knock that carries an introduction credential: the door verifies metadata.vc and records the
// introducer, never the credential.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). Mac A ruling 20261108T120925Z, intake
// 20261108T211322Z. The implementer may not edit this file. Run it as
// `node conformance/intro-knock.mjs`. The verifier itself is pinned by conformance/intro-verify.mjs.
//
// What it pins:
//   - a SIGNED knock whose metadata.vc is a valid AgentIntroduction for the knock's verified `from`
//     DID, introduced to this door's own DID, is answered as usual AND the visitor's account row
//     gains `introductions`: an array of entries, each exactly
//       { introducer: <issuer DID>, id: <credential id>, verified_at: <integer epoch seconds>,
//         valid_until: <integer epoch seconds> }
//     (verified_at is the door's clock at verification, the same unit as first_seen/last_seen;
//     valid_until is credentialSubject.validUntil in that unit, added by intake 20261109T015407Z);
//   - the credential body is never stored: no proof, no jws, no credentialSubject, no type list,
//     no expertise, in the account row, the default ledger, or the createFileStore file on disk.
// Refusals (each is answered as an ordinary unintroduced knock: not refused, the visitor's row is
// the plain row, no `introductions` entry, the introducer DID and credential id appear nowhere):
//   - a credential issued for another subject, replayed by a different visitor;
//   - one introducedTo another door;
//   - an expired one;
//   - a tampered one (a signed field edited after signing);
//   - one with no id;
//   - a vc on an unsigned (anonymous-lane) knock: the door never reads it, no row is minted;
//   - a vc that is not an object (string, number, boolean, array, null);
//   - an oversized vc. THE BOUND: a vc whose JSON serialization exceeds 8192 UTF-8 bytes
//     (8 KiB) is ignored unread, even when its signature is valid. A valid vc of about 6000
//     bytes is still recorded, so the bound cannot be set tiny;
//   - SELF-INTRODUCTION (the design choice the core does not make): a vc whose issuer is the
//     visitor itself is REFUSED at the door, although verifyIntroduction alone accepts it. A
//     visitor vouching for itself adds nothing the signature on the knock did not already say,
//     and accepting it would let any key mint an "introduced" mark for free.
//   - docs: README.md and spec/v1.md describe metadata.vc, the `introductions` ledger entry, and
//     the known gap that revocation is not checked yet.
//
// In-process only: handleRequestAsync, no listen, no network. Example hosts only.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import * as door from '../muretai-agent-entry.mjs';

const { canonicalJSON, createAgentEntry, createFileStore, didFromSeedHex, signBytes, signEnvelope } = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const DOOR_SEED = 'a1'.repeat(32);
const OTHER_DOOR_SEED = 'a2'.repeat(32);
const VISITOR_SEED = 'b2'.repeat(32);
const STRANGER_SEED = 'b3'.repeat(32);
const INTRODUCER_SEED = 'c3'.repeat(32);
const VISITOR = didFromSeedHex(VISITOR_SEED);
const STRANGER = didFromSeedHex(STRANGER_SEED);
const INTRODUCER = didFromSeedHex(INTRODUCER_SEED);
const OTHER_DOOR = didFromSeedHex(OTHER_DOOR_SEED);
const BASE_URL = 'https://door.example';
const VC_BOUND = 8192;

const scratch = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const clone = (v) => JSON.parse(JSON.stringify(v));
const nowS = () => Math.floor(Date.now() / 1000);
const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

let serial = 0;
/** Issue an AgentIntroduction the way the core's issue_introduction does. `edit` runs before signing. */
function issue({ issuerSeed = INTRODUCER_SEED, subject = VISITOR, recipient, validFor = 86400, edit = null } = {}) {
  const issuer = didFromSeedHex(issuerSeed);
  const t = nowS();
  serial += 1;
  const body = {
    credentialSubject: { expertise: ['photography'], id: subject, introducedTo: recipient,
      trustLevelBp: 800, validUntil: iso(t + validFor) },
    id: `urn:uuid:7e57c0de0000400080000000000${String(serial).padStart(5, '0')}`,
    issuanceDate: iso(t - 60),
    issuer,
    provenance: { mode: 'proactive' },
    type: ['VerifiableCredential', 'AgentIntroduction'],
  };
  if (edit) edit(body);
  const jws = signBytes(issuerSeed, Buffer.from(canonicalJSON(body), 'utf8')).toString('base64');
  return { ...body, proof: { created: body.issuanceDate, jws, type: 'Ed25519Signature2020', verificationMethod: issuer } };
}

/** A fresh door with a file store, so the bytes on disk can be searched too. */
function newDoor({ anonymousLane = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ae-intro-knock-'));
  scratch.push(dir);
  const storePath = join(dir, 'state.json');
  const store = createFileStore(storePath);
  const entry = createAgentEntry({ seedHex: DOOR_SEED, name: 'Intro Door', baseUrl: BASE_URL, anonymousLane,
    signedRatePerMin: 0, signedRatePerMinTotal: 0, responder: () => 'ok', store });
  return { entry, store, storePath };
}

function stored(ctx) {
  try { return readFileSync(ctx.storePath, 'utf8'); } catch { return ''; }
}

let msgSerial = 0;
async function post(entry, message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.messageId, method: 'message/send',
    params: { message } }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body,
    { remoteAddress: '127.0.0.1' });
  return { status: out.status, json: JSON.parse(Buffer.from(out.body).toString('utf8')) };
}

/** A signed knock by `seed`, with `vc` riding as unsigned metadata when given (even when null). */
async function knock(ctx, seed, vc, { withVc = true } = {}) {
  const from = didFromSeedHex(seed);
  const to = ctx.entry.did;
  const messageId = `intro-knock-${++msgSerial}`;
  const text = 'hello, I was told to come here';
  const timestamp = nowS();
  const sig = signEnvelope(seed, { from, to, messageId, contextId: null, timestamp, text });
  const metadata = { from, to, timestamp, sig };
  if (withVc) metadata.vc = vc;
  return post(ctx.entry, { kind: 'message', role: 'user', messageId, contextId: null,
    parts: [{ kind: 'text', text }], metadata });
}

async function anonKnock(ctx, vc) {
  const messageId = `intro-anon-${++msgSerial}`;
  return post(ctx.entry, { kind: 'message', role: 'user', messageId, contextId: null,
    parts: [{ kind: 'text', text: 'hello from nobody' }], metadata: { vc } });
}

function answered(res, label) {
  assert.equal(res.status, 200, `${label}: HTTP 200`);
  assert.equal(res.json.error, undefined, `${label}: answered, not refused: ${JSON.stringify(res.json.error)}`);
  assert.ok(res.json.result, `${label}: a result`);
}

const rowOf = async (ctx, did) => ctx.store.getAccount(did);

const BODY_MARKERS = (vc) => [vc.proof.jws, 'credentialSubject', 'AgentIntroduction', 'Ed25519Signature2020',
  'photography', 'trustLevelBp', 'introducedTo', 'verificationMethod'];

/** The account row for `did` exists (the knock enrolled it) and carries nothing from `vc`. */
async function plainRow(ctx, did, vc, label) {
  const row = await rowOf(ctx, did);
  assert.ok(row, `${label}: the ordinary knock still enrolls the visitor`);
  const intros = row.introductions;
  assert.ok(intros === undefined || (Array.isArray(intros) && intros.length === 0),
    `${label}: no introductions entry: ${JSON.stringify(intros)}`);
  const rowText = JSON.stringify(row);
  assert.ok(!rowText.includes(INTRODUCER), `${label}: the introducer DID is not on the row`);
  if (vc && typeof vc === 'object' && !Array.isArray(vc) && typeof vc.id === 'string') {
    assert.ok(!stored(ctx).includes(vc.id), `${label}: the credential id is nowhere in the store file`);
  }
  assert.ok(!stored(ctx).includes(INTRODUCER), `${label}: the introducer DID is nowhere in the store file`);
  assert.ok(!stored(ctx).includes('credentialSubject'), `${label}: no credential body in the store file`);
}

// ---------------------------------------------------------------- the happy path

test('a signed knock with a valid introduction records the introducer, the id and the time', async () => {
  const ctx = newDoor();
  const vc = issue({ recipient: ctx.entry.did });
  const t0 = nowS();
  const res = await knock(ctx, VISITOR_SEED, vc);
  const t1 = nowS();
  answered(res, 'valid intro');
  const row = await rowOf(ctx, VISITOR);
  assert.ok(row, 'the visitor has an account row');
  assert.ok(Array.isArray(row.introductions), `row.introductions is an array: ${JSON.stringify(row)}`);
  assert.equal(row.introductions.length, 1);
  const [intro] = row.introductions;
  assert.deepEqual(Object.keys(intro).sort(), ['id', 'introducer', 'valid_until', 'verified_at'],
    'the entry is exactly introducer, id, verified_at, valid_until');
  assert.equal(intro.introducer, INTRODUCER);
  assert.equal(intro.id, vc.id);
  assert.ok(Number.isInteger(intro.verified_at) && intro.verified_at >= t0 && intro.verified_at <= t1,
    `verified_at is the door's epoch second: ${intro.verified_at}`);
  // intake 20261109T015407Z: valid_until is credentialSubject.validUntil in integer epoch seconds.
  assert.ok(Number.isInteger(intro.valid_until), `valid_until is an integer: ${intro.valid_until}`);
  assert.equal(intro.valid_until, Date.parse(vc.credentialSubject.validUntil) / 1000,
    'valid_until is the vector validUntil in seconds');
  // the plain row fields keep their meaning
  assert.equal(row.messages, 1);
});

test('the credential text appears nowhere in the ledger row or the store file', async () => {
  const ctx = newDoor();
  const vc = issue({ recipient: ctx.entry.did });
  answered(await knock(ctx, VISITOR_SEED, vc), 'valid intro');
  const rowText = JSON.stringify(await rowOf(ctx, VISITOR));
  const file = stored(ctx);
  assert.ok(file.includes(INTRODUCER) && file.includes(vc.id), 'the store file holds the introducer and the id');
  for (const marker of BODY_MARKERS(vc)) {
    assert.ok(!rowText.includes(marker), `the row never holds ${marker}`);
    assert.ok(!file.includes(marker), `the store file never holds ${marker}`);
  }
  assert.ok(!file.includes(canonicalJSON(vc)) && !file.includes(JSON.stringify(vc)), 'no whole credential on disk');
});

test('the default in-memory ledger records the same entry and no body', async () => {
  const entry = createAgentEntry({ seedHex: DOOR_SEED, name: 'Intro Door', baseUrl: BASE_URL,
    signedRatePerMin: 0, signedRatePerMinTotal: 0, responder: () => 'ok' });
  const vc = issue({ recipient: entry.did });
  answered(await knock({ entry }, VISITOR_SEED, vc), 'valid intro, memory store');
  const row = entry.ledger.get(VISITOR);
  assert.ok(row && Array.isArray(row.introductions) && row.introductions.length === 1,
    `entry.ledger row carries one introduction: ${JSON.stringify(row)}`);
  assert.equal(row.introductions[0].introducer, INTRODUCER);
  assert.equal(row.introductions[0].id, vc.id);
  const all = JSON.stringify([...entry.ledger.entries()]);
  for (const marker of BODY_MARKERS(vc)) assert.ok(!all.includes(marker), `the ledger never holds ${marker}`);
});

test('a knock with no vc keeps the plain row, with no introductions entry', async () => {
  const ctx = newDoor();
  answered(await knock(ctx, VISITOR_SEED, undefined, { withVc: false }), 'no vc');
  const row = await rowOf(ctx, VISITOR);
  assert.ok(row);
  assert.ok(row.introductions === undefined || row.introductions.length === 0);
});

test('a valid vc just under the 8 KiB bound is still recorded', async () => {
  const ctx = newDoor();
  const vc = issue({ recipient: ctx.entry.did, edit: (b) => { b.credentialSubject.note = 'n'.repeat(5200); } });
  const size = Buffer.byteLength(JSON.stringify(vc), 'utf8');
  assert.ok(size > 5500 && size < VC_BOUND - 1000, `fixture: about 6000 bytes, got ${size}`);
  answered(await knock(ctx, VISITOR_SEED, vc), 'near-bound vc');
  const row = await rowOf(ctx, VISITOR);
  assert.ok(Array.isArray(row?.introductions) && row.introductions.length === 1, 'recorded');
  assert.ok(!stored(ctx).includes('nnnnnnnnnn'), 'the padding (credential body) is not stored');
});

// ---------------------------------------------------------------- attacks: no introducer recorded

test('attack: a credential for another subject, replayed by a different visitor', async () => {
  const ctx = newDoor();
  const vc = issue({ subject: VISITOR, recipient: ctx.entry.did });
  answered(await knock(ctx, STRANGER_SEED, vc), 'replay');
  await plainRow(ctx, STRANGER, vc, 'replay');
  assert.ok(!(await rowOf(ctx, VISITOR)), 'the named subject gains no row from a stranger\'s knock');
});

test('attack: a credential introducedTo another door', async () => {
  const ctx = newDoor();
  const vc = issue({ recipient: OTHER_DOOR });
  answered(await knock(ctx, VISITOR_SEED, vc), 'other door');
  await plainRow(ctx, VISITOR, vc, 'other door');
});

test('attack: an expired credential', async () => {
  const ctx = newDoor();
  const vc = issue({ recipient: ctx.entry.did, validFor: -60 });
  answered(await knock(ctx, VISITOR_SEED, vc), 'expired');
  await plainRow(ctx, VISITOR, vc, 'expired');
});

test('attack: a tampered credential', async () => {
  for (const [label, edit] of [
    ['trust raised', (vc) => { vc.credentialSubject.trustLevelBp = 10000; }],
    ['validUntil extended', (vc) => { vc.credentialSubject.validUntil = '2099-01-01T00:00:00Z'; }],
    ['issuer swapped', (vc) => { vc.issuer = STRANGER; }],
    ['signature zeroed', (vc) => { vc.proof.jws = Buffer.alloc(64).toString('base64'); }],
  ]) {
    const ctx = newDoor();
    const vc = issue({ recipient: ctx.entry.did });
    edit(vc);
    answered(await knock(ctx, VISITOR_SEED, vc), `tampered: ${label}`);
    await plainRow(ctx, VISITOR, vc, `tampered: ${label}`);
  }
});

test('attack: a credential with no id', async () => {
  const ctx = newDoor();
  const vc = issue({ recipient: ctx.entry.did, edit: (b) => { delete b.id; } });
  assert.equal(vc.id, undefined);
  answered(await knock(ctx, VISITOR_SEED, vc), 'no id');
  await plainRow(ctx, VISITOR, vc, 'no id');
});

test('attack: a vc on an unsigned knock is never read and mints nothing', async () => {
  const ctx = newDoor({ anonymousLane: true });
  const vc = issue({ recipient: ctx.entry.did });
  answered(await anonKnock(ctx, vc), 'anonymous with vc');
  assert.ok(!(await rowOf(ctx, VISITOR)), 'no row for the credential subject');
  const file = stored(ctx);
  assert.ok(!file.includes(INTRODUCER), 'the introducer is nowhere on disk');
  assert.ok(!file.includes(vc.id), 'the id is nowhere on disk');
  assert.ok(!file.includes(VISITOR), 'the subject is nowhere on disk');
});

test('attack: a vc that is not an object', async () => {
  const ctx0 = newDoor();
  const valid = issue({ recipient: ctx0.entry.did });
  for (const [label, vc] of [['JSON string of a valid vc', JSON.stringify(valid)], ['number', 42], ['boolean', true],
    ['array holding a valid vc', [valid]], ['null', null], ['empty object', {}]]) {
    const ctx = newDoor();
    answered(await knock(ctx, VISITOR_SEED, vc), `not an object: ${label}`);
    await plainRow(ctx, VISITOR, valid, `not an object: ${label}`);
  }
});

test(`attack: an oversized vc (over ${VC_BOUND} bytes) is ignored even when validly signed`, async () => {
  const ctx = newDoor();
  const vc = issue({ recipient: ctx.entry.did, edit: (b) => { b.credentialSubject.note = 'n'.repeat(VC_BOUND); } });
  assert.ok(Buffer.byteLength(JSON.stringify(vc), 'utf8') > VC_BOUND + 300, 'fixture: well over the bound');
  assert.equal(door.verifyIntroduction?.(vc, { expectedSubject: VISITOR, expectedRecipient: ctx.entry.did, now: new Date() }),
    true, 'fixture: the oversized credential is otherwise valid');
  answered(await knock(ctx, VISITOR_SEED, vc), 'oversized');
  await plainRow(ctx, VISITOR, vc, 'oversized');
  assert.ok(!stored(ctx).includes('nnnnnnnnnn'), 'the padding is not stored');
});

test('attack: self-introduction (issuer is the visitor) is refused at the door', async () => {
  const ctx = newDoor();
  const vc = issue({ issuerSeed: VISITOR_SEED, subject: VISITOR, recipient: ctx.entry.did });
  assert.equal(door.verifyIntroduction?.(vc, { expectedSubject: VISITOR, expectedRecipient: ctx.entry.did, now: new Date() }),
    true, 'fixture: the self-issued credential verifies as a credential');
  answered(await knock(ctx, VISITOR_SEED, vc), 'self-introduction');
  const row = await rowOf(ctx, VISITOR);
  assert.ok(row, 'still an ordinary knock');
  assert.ok(row.introductions === undefined || row.introductions.length === 0,
    `no introductions entry for a self-introduction: ${JSON.stringify(row.introductions)}`);
  assert.ok(!stored(ctx).includes(vc.id), 'the self-issued id is not stored');
});

test('an invalid vc never changes the answer: same reply as the knock without one', async () => {
  const plain = newDoor();
  const withBad = newDoor();
  const a = await knock(plain, VISITOR_SEED, undefined, { withVc: false });
  const bad = issue({ recipient: OTHER_DOOR });
  const b = await knock(withBad, VISITOR_SEED, bad);
  answered(a, 'plain');
  answered(b, 'invalid vc');
  const textOf = (r) => r.json.result?.parts?.map((p) => p.text).join('');
  assert.equal(textOf(b), textOf(a), 'the reply text is the same');
});

// ---------------------------------------------------------------- docs

test('README and spec/v1.md describe metadata.vc, the introductions entry and the revocation gap', () => {
  for (const rel of ['README.md', join('spec', 'v1.md')]) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(text.includes('metadata.vc'), `${rel} names metadata.vc`);
    assert.ok(text.includes('AgentIntroduction'), `${rel} names the AgentIntroduction credential`);
    assert.ok(text.includes('introductions'), `${rel} describes the introductions ledger entry`);
    assert.ok(/revocation[^.]*not (yet )?checked|not (yet )?check[^.]*revocation/i.test(text),
      `${rel} says revocation is not checked yet (a known gap)`);
  }
});
