#!/usr/bin/env node
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
  canonicalJSON, didFromPublicKeyHex, publicKeyFromSeedHex, signingPayload,
  signEnvelope, verifyEnvelope,
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
  // The case's message lives under `input`; `recipientDid` (when the case pins one, as
  // `wrong-recipient` does) sits beside it at the top level. Reading the message from the
  // top level instead built `{contextId: null}` with an undefined recipient, which every
  // verifier refuses for being empty — so all six checks passed without ever exercising the
  // attack they are named for. Proven by mutation: with the signature check neutered and
  // field-presence left intact, this file still printed "every case that must be refused was".
  const m = v.input ?? v;
  const fields = { from: m.from, to: m.to, messageId: m.messageId,
                   contextId: m.contextId ?? null, timestamp: m.timestamp,
                   text: m.text, sig: m.sig };
  let accepted;
  try {
    accepted = verifyEnvelope(fields, { recipientDid: v.recipientDid ?? m.recipientDid ?? m.to });
  } catch {
    accepted = false;                            // refusing by throwing is still refusing
  }
  check(accepted === false, `reject/${v.name}`,
        accepted === false ? '' : `ACCEPTED a message it must refuse — ${v.why || ''}`);
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
