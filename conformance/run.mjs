#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * conformance/run.mjs — check an Agent Entry implementation against the golden vectors.
 *
 * WHY THIS SHIPS IN THE PACKAGE. A conformance suite that lives on a website is a suite
 * with an uptime requirement, and until now this one was worse than that: the vectors sat
 * in a git checkout that `npm install` never delivers, so "run the suite" meant "send us
 * your implementation and we will run it". Everything needed to hold this code to its own
 * contract is now in the tarball: `npm test`, no network, no dependencies, no account.
 *
 * WHAT IT CHECKS, AND WHY BOTH HALVES ARE HERE. The positive half proves this build
 * produces the same BYTES as every other implementation — canonical JSON, did:key, the six
 * signed fields. The negative half proves it REFUSES what it must, and it is the half that
 * catches the failure nobody notices: an implementation that verifies nothing passes every
 * positive vector in the file. A drift in either direction is silent on the wire — nothing
 * throws, signatures simply stop verifying for everyone else.
 *
 * Run:  node conformance/run.mjs            (from the package root)
 *       npm test
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  canonicalJSON, canonicalFromJSON, createAgentEntry, didFromPublicKeyHex,
  publicKeyFromSeedHex, publicKeyHexFromDid, resolveOpDid, signingPayload, signEnvelope,
  verifyCardEnvelope, verifyEnvelope,
} from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(HERE, 'vectors.json'), 'utf8'));

let pass = 0;
const failures = [];

function check(ok, label, detail) {
  if (ok) { pass += 1; return true; }
  failures.push(detail ? `${label}\n      ${detail}` : label);
  return false;
}

// ---------------------------------------------------------------- canonical JSON
for (const v of vectors.canonical) {
  let got;
  try { got = canonicalJSON(v.payload); } catch (e) { got = `THREW: ${e.message}`; }
  check(got === v.canonical, `canonical/${v.name}`,
        got === v.canonical ? '' : `want ${JSON.stringify(v.canonical)}\n      got  ${JSON.stringify(got)}`);
}

// `numberHazards` is DELIBERATELY NOT EXECUTED, and reading it is the point. Every case
// there is a value whose canonical bytes differ between languages, so asserting either
// spelling would be asserting one runtime's float formatting — the opposite of the
// contract. The rule it carries is a SIGNER discipline (`signMustNotEmit`), not a
// canonicaliser output: never sign a payload containing one, because the bytes you produce
// will only verify where they were produced. An agent entry meets it for free — the only
// number among the six signed fields is `timestamp`, and integer epoch seconds is the
// contract.
const hazards = vectors.numberHazards?.length ?? 0;

// ---------------------------------------------------------------- did:key
for (const v of vectors.did) {
  if (v.curve !== 'ed25519') continue;          // p256 did:key is not an envelope signer
  let got;
  try { got = didFromPublicKeyHex(v.publicHex); } catch (e) { got = `THREW: ${e.message}`; }
  check(got === v.did, `did/${v.publicHex.slice(0, 12)}…`,
        got === v.did ? '' : `want ${v.did}\n      got  ${got}`);
}

// ---------------------------------------------------------------- the six signed fields
for (const v of vectors.envelope) {
  const fields = { from: v.from, to: v.to, messageId: v.messageId,
                   contextId: v.contextId ?? null, timestamp: v.timestamp, text: v.text };
  let got;
  try { got = signingPayload(fields); } catch (e) { got = `THREW: ${e.message}`; }
  check(got === v.signingPayload, `envelope/${v.name}`,
        got === v.signingPayload ? '' : `want ${JSON.stringify(v.signingPayload)}\n      got  ${JSON.stringify(got)}`);
}

// A signature this build makes must verify in this build. Round-tripping is the weakest
// possible claim on its own — it only says the code agrees with itself — which is exactly
// why the byte checks above and the refusals below are not optional.
{
  const seed = '11'.repeat(32);
  const from = didFromPublicKeyHex(publicKeyFromSeedHex(seed));
  const fields = { from, to: from, messageId: 'm1', contextId: null,
                   timestamp: 1752451200, text: 'round trip' };
  const sig = signEnvelope(seed, fields);
  check(verifyEnvelope({ ...fields, sig }, { recipientDid: from }), 'envelope/round-trip');
}

// ---------------------------------------------------------------- the refusals
// The half that catches an implementation which verifies nothing.
for (const v of vectors.reject.message) {
  // The case's message lives under `input`; `recipientDid` (when a case pins one, as
  // `wrong-recipient` does) sits beside it at the top level. Reading the message from the top
  // level instead built `{contextId: null}` with an undefined recipient, which every verifier
  // refuses for being empty - so all six checks passed without ever exercising the attack they
  // are named for. Proven by mutation: with the signature check neutered and field-presence
  // left intact, this file still printed "every case that must be refused was". With the
  // wiring correct the same mutant turns four checks red, `from-not-signer` among them.
  const m = v.input ?? v;
  const fields = { from: m.from, to: m.to, messageId: m.messageId,
                   contextId: m.contextId ?? null, timestamp: m.timestamp,
                   text: m.text, sig: m.sig };
  // `recipientDid` inside the message is UNSIGNED and it is BAIT. It is copied in so it sits
  // exactly where a verifier that trusts the wire would look, and it is never read as the
  // answer: `wire-names-its-own-recipient` carries a `recipientDid` equal to its own `to`, so
  // a chain ending `?? m.recipientDid ?? m.to` compares the message against itself and always
  // holds. That chain was here, and it made the case unfailable. A case that sets
  // `verifierNamesNoRecipient` is the door with no "me" — unknown fails closed.
  if (m.recipientDid !== undefined) fields.recipientDid = m.recipientDid;
  const opts = v.verifierNamesNoRecipient ? {} : { recipientDid: v.recipientDid ?? m.to };
  let accepted;
  try {
    accepted = verifyEnvelope(fields, opts);
  } catch {
    accepted = false;                            // refusing by throwing is still refusing
  }
  check(accepted === false, `reject/${v.name}`,
        accepted === false ? '' : `ACCEPTED a message it must refuse — ${v.note || v.why || ''}`);
}

// ---------------------------------------------------------------- the OTHER refusals
// Four groups that this file did not carry until 0.3.1, because `scripts/build-vectors.mjs`
// shipped only `reject.message`. A group the derived file does not have cannot be looped
// over, and nothing said one was missing — which is how the door came to be held to none of
// them. Each loop below drives the door's OWN exported function, not a re-implementation.

// The signed card envelope. Upstream measured that its verification could be deleted
// outright and the contract suite stayed green; these are the cases that changed that.
for (const c of vectors.reject.cardpub ?? []) {
  let accepted;
  try { accepted = verifyCardEnvelope(c.envelope, c.expectedDid ?? null) !== null; }
  catch { accepted = false; }
  check(accepted === false, `reject/cardpub/${c.name}`,
        accepted === false ? '' : `ACCEPTED a card envelope it must refuse — ${c.note || c.why || ''}`);
}
// The did:key codec. A wrong multicodec or a wrong key length is not a DID.
for (const c of vectors.reject.did ?? []) {
  let accepted;
  try { accepted = typeof publicKeyHexFromDid(c.did) === 'string'; }
  catch { accepted = false; }
  check(accepted === false, `reject/did/${c.name}`,
        accepted === false ? '' : `DECODED a did:key it must refuse — ${c.note || c.why || ''}`);
}
// The canonical-JSON boundary, driven on RAW DOCUMENT BYTES — the cases carry hex because
// JSON cannot hold an invalid byte, and the accept half exists so a door that refuses
// everything cannot pass by refusing everything.
const enc = vectors.reject.encoding;
if (enc) {
  for (const c of enc.accept ?? []) {
    let got = null;
    try { got = Buffer.from(canonicalFromJSON(Buffer.from(c.documentHex, 'hex'))).toString('utf8'); }
    catch { got = null; }
    check(got === c.canonical, `encoding/accept/${c.name}`,
          got === null ? 'REFUSED a document it must render'
                       : `rendered ${JSON.stringify(got)}, want ${JSON.stringify(c.canonical)}`);
  }
  for (const c of enc.refuse ?? []) {
    let accepted = true;
    try { canonicalFromJSON(Buffer.from(c.documentHex, 'hex')); } catch { accepted = false; }
    check(accepted === false, `encoding/refuse/${c.name}`,
          accepted === false ? '' : `ACCEPTED bytes it must refuse — ${c.note || c.why || ''}`);
  }
}
// KeyState resolution. The refuse half needs the pin, which is what `opts.pinned` is for;
// without one, revocation is unenforceable and these cases would all pass for the wrong
// reason. The accept half is what stops a resolver passing by always answering the root.
const ks = vectors.reject.keystate;
if (ks) {
  const run = (c) => {
    try {
      return resolveOpDid(ks.rootDid, c.inline ?? null, ks.checkNow,
                          c.pinned ? { pinned: c.pinned } : {});
    } catch (e) { return `THREW: ${e && e.constructor ? e.constructor.name : 'Error'}`; }
  };
  for (const c of ks.accept ?? []) {
    const got = run(c);
    check(got === c.expect, `keystate/accept/${c.name}`, `resolved ${got}, want ${c.expect}`);
    if (c.mustNotResolveTo !== undefined) {
      check(got !== c.mustNotResolveTo, `keystate/accept/${c.name}/not`,
            `resolved to ${got}, the very DID this case must not reach`);
    }
  }
  for (const c of ks.refuse ?? []) {
    const got = run(c);
    check(got === c.expect, `keystate/refuse/${c.name}`, `resolved ${got}, want ${c.expect}`);
    check(got !== c.mustNotResolveTo, `keystate/refuse/${c.name}/not`,
          `resolved to ${got}, the attacker's key`);
  }
}

// ---------------------------------------------------------------- the door's body boundary
// Everything above drives an EXPORTED FUNCTION. This block drives the DOOR — the real
// `handleRequestAsync`, the real router, the real ladder — because the defect it exists for
// lived at a boundary no exported function touches: the JSON-RPC body decoder had
// `ignoreBOM` at its default of false, and false means STRIP, so `EF BB BF {…}` arrived at
// `JSON.parse` with the mark already gone and was ACCEPTED. `canonicalFromJSON` (checked by
// `encoding/refuse/*` above) had been fixed in agent-seam 0.3.1 and its sibling had not, so
// the vectors were green while the door answered 200 for bytes Muretai core's Python door
// answered 400 for. A vector suite that only reaches the library cannot see that.
//
// TWO THINGS MAKE THIS MEASURE SOMETHING, and neither is optional:
//   * the mount. `handleRequestAsync(method, path, headers, bodyBuffer)` routes on the path,
//     and the mount is `baseUrl`'s pathname — POST anywhere else is 404 or 405 and the body
//     is never read at all, so a test that got this wrong would pass on a door with no guard.
//   * the CONTROL. The same bytes without the mark must earn a SIGNED REPLY. A door that
//     refused everything would satisfy every 400 below; the control is what says the three
//     bytes are the whole difference.
{
  const doorSeed = '22'.repeat(32);
  const visitorSeed = '33'.repeat(32);
  const entry = createAgentEntry({
    seedHex: doorSeed, name: 'conformance', baseUrl: 'https://x.example/agent',
    responder: () => 'ok',
  });
  const from = didFromPublicKeyHex(publicKeyFromSeedHex(visitorSeed));
  const fields = { from, to: entry.did, messageId: 'bom-boundary-1', contextId: null,
                   timestamp: Math.floor(Date.now() / 1000), text: 'hello' };
  const sig = signEnvelope(visitorSeed, fields);
  const clean = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'message/send',
    params: { message: { kind: 'message', role: 'user',
      parts: [{ kind: 'text', text: fields.text }], messageId: fields.messageId,
      contextId: null,
      metadata: { timestamp: fields.timestamp, from, to: entry.did, sig } } },
  }), 'utf8');
  const HEADERS = { 'content-type': 'application/json' };
  const post = (body) => entry.handleRequestAsync('POST', '/agent', HEADERS, body);

  // The refusal every other unparseable body already gets. The marked ones must be
  // INDISTINGUISHABLE from it: which rung refused is not a fact a stranger is told, and the
  // Python door tells them nothing either (one message for the whole 400 class).
  const broken = await post(Buffer.from('{', 'utf8'));
  check(broken.status === 400, 'door/malformed-body-is-400', `got ${broken.status}`);

  // RFC 8259 §8.1: a JSON text sent between systems carries no byte order mark. All five,
  // longest first — UTF-32-LE's begins with UTF-16-LE's.
  const MARKS = [['utf-8', 'efbbbf'], ['utf-16-be', 'feff'], ['utf-16-le', 'fffe'],
                 ['utf-32-be', '0000feff'], ['utf-32-le', 'fffe0000']];
  for (const [name, hex] of MARKS) {
    const out = await post(Buffer.concat([Buffer.from(hex, 'hex'), clean]));
    check(out.status === 400, `door/refuses-${name}-byte-order-mark`,
          out.status === 400 ? ''
            : `answered HTTP ${out.status} for a body that begins ${hex} — core's Python `
              + 'door answers 400, and a stripped mark makes two wire documents one');
    check(out.body.equals(broken.body), `door/${name}-mark-is-the-ordinary-400`,
          `answered ${JSON.stringify(out.body.toString('utf8'))}, and every other `
          + `unparseable body is answered ${JSON.stringify(broken.body.toString('utf8'))}`);
  }
  // And it booked nobody. A marked body that reaches the ladder does not merely get the
  // wrong status — it mints a customer under a signature the other door never accepted.
  check(entry.ledger.size === 0, 'door/marked-body-books-no-account',
        `${entry.ledger.size} ledger row(s) after five refused bodies`);

  // THE CONTROL, last so the ledger assertion above is about the marked bodies alone. It
  // carries the messageId the marked bodies carried, which makes it two assertions in one:
  // the door answers a signed message at all (without which every 400 above is satisfied by
  // a door that refuses everything), AND a marked document was never the same document —
  // on a door that strips the mark this exact body is a REPLAY of the one it just answered,
  // and gets refused for it. That collapse is the whole reason a mark may not be stripped.
  const ok = await post(clean);
  let replySig = null;
  try { replySig = JSON.parse(ok.body.toString('utf8')).result.metadata.sig; } catch { /* null */ }
  check(ok.status === 200 && typeof replySig === 'string' && replySig.length > 0,
        'door/same-bytes-without-the-mark-earn-a-signed-reply',
        `HTTP ${ok.status}, sig ${JSON.stringify(replySig)} — either this door refuses `
        + 'everything (and the 400s above prove nothing), or it STRIPPED the mark, answered '
        + 'the marked twin already, and is now refusing these bytes as a replay of it');
}

// ---------------------------------------------------------------- verdict
console.log(`\n${vectors.note}\n`);
if (failures.length) {
  console.log(`FAILED — ${failures.length} of ${pass + failures.length} checks:\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('\nA mismatch here is not cosmetic: these bytes are what every other');
  console.log('implementation signs and verifies.\n');
  process.exit(1);
}
console.log(`OK — ${pass} checks: the bytes match, and every case that must be refused was.`);
console.log(`     (${hazards} numberHazards read, not executed — see the comment in this file:`);
console.log(`      they are a SIGNER rule, not bytes any single runtime can be held to.)\n`);
