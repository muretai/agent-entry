#!/usr/bin/env node
/*
 * conformance/wire-twin.mjs — the door's crypto block is the wire layer, byte for byte.
 *
 * WHY THIS EXISTS. The block between the `CANONICAL JSON` banner and the `reach-back through a
 * relay` banner in `muretai-agent-entry.mjs` is not this package's private code: it is the wire
 * contract every other implementation reproduces — the Python node, the Swift and Kotlin
 * clients, the PHP plugin, the browser extension. That layer now has a home of its own,
 * `agent-wire`, which carries the same bytes in `js/wire.mjs` beside the golden vectors and a
 * Python reference. Two copies of one contract drift, and a drift here is silent on the wire:
 * nothing throws, signatures simply stop verifying for everyone else. This is the alarm on
 * this side of that copy.
 *
 * WHAT IT COMPARES.
 *   sections  every banner-delimited section of agent-wire's block (canonical JSON, Ed25519,
 *             base58btc + did:key, the signing envelope, KeyState, Web Bot Auth, device-key
 *             binding v2, the card envelope, cryptobox) occurs VERBATIM in this door
 *   pinned    every line agent-wire pins ABOVE its copy of the block (the wire constants, the
 *             error table, two card-envelope constants and one case-folding helper) occurs
 *             verbatim as a line of this door — they are quoted from here, not rewritten there
 *   vectors   testdata/*.json == agent-wire's vectors/*.json, when both are present
 *
 * SECTION BY SECTION, NOT REGION BY REGION, and the difference is the point. The comparison is
 * by BANNER, never by line number, because the same section sits at different lines on `main`
 * and on `pay/v0`. And an experimental branch may ADD a section inside the block — `pay/v0`
 * puts `pay/v0: grants and receipts` between the device binding and the card envelope — which
 * is a door growing a new signed object, not the wire layer drifting. Extra sections are
 * reported, never failed; a changed byte inside a shared section is failed.
 *
 * A MISSING SIBLING IS A SKIP, NOT A FAILURE. `npm install` delivers this package to machines
 * that have no agent-wire checkout, and `npm test` must stay green there. The check says which
 * path it looked in, so a skip can never hide behind silence.
 *
 * Run:  node conformance/wire-twin.mjs                    (from the package root)
 *       node conformance/wire-twin.mjs --door PATH        (check another door file)
 *       MURETAI_AGENT_WIRE=/path/to/agent-wire npm test
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const doorPath = opt('--door') ?? join(ROOT, 'muretai-agent-entry.mjs');
const wireRoot = resolve(ROOT, process.env.MURETAI_AGENT_WIRE || '../agent-wire');
const wirePath = join(wireRoot, 'js', 'wire.mjs');

// The banners that delimit the block. They are the door's own section headings, so they move
// with the code rather than with a line count.
const START = /^\/\/ =+ CANONICAL JSON$/;
const END_DOOR = /^\/\/ =+ reach-back through a relay$/;
const END_WIRE = /^\/\/ ---- end of the door's block/;
const PINNED = /^\/\/ ---- pinned:/;

let pass = 0;
const failures = [];
function check(ok, label, detail) {
  if (ok) { pass += 1; return true; }
  failures.push(detail ? `${label}\n      ${detail}` : label);
  return false;
}
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
function slice(text, startRe, endRe) {
  const lines = text.split('\n');
  const a = lines.findIndex((l) => startRe.test(l));
  const b = lines.findIndex((l, i) => i > a && endRe.test(l));
  return a < 0 || b < 0 ? null : lines.slice(a, b).join('\n');
}
/** The banner-delimited sections of a block, as [{title, text}] in file order. */
function sections(region) {
  const lines = region.split('\n');
  const marks = [];
  lines.forEach((l, i) => { const m = /^\/\/ ={10,} (.+)$/.exec(l); if (m) marks.push([i, m[1]]); });
  return marks.map(([start, title], k) => ({
    title,
    text: lines.slice(start, k + 1 < marks.length ? marks[k + 1][0] : lines.length).join('\n'),
  }));
}

if (!existsSync(wirePath)) {
  console.log(`skip: no agent-wire checkout at ${wireRoot} (set MURETAI_AGENT_WIRE if it lives elsewhere).`);
  console.log('      Nothing was compared. The wire layer is at https://github.com/muretai/agent-wire.\n');
  process.exit(0);
}

const door = readFileSync(doorPath, 'utf8');
const wire = readFileSync(wirePath, 'utf8');

const doorRegion = slice(door, START, END_DOOR);
const wireRegion = slice(wire, START, END_WIRE);
check(doorRegion !== null, 'region/door-banners-found', `${doorPath} has no CANONICAL JSON … reach-back pair`);
check(wireRegion !== null, 'region/wire-banners-found', `${wirePath} has no CANONICAL JSON … end-of-block pair`);

if (doorRegion !== null && wireRegion !== null) {
  const mine = sections(doorRegion);
  const theirs = sections(wireRegion);
  const byTitle = new Map(mine.map((s) => [s.title, s.text]));
  for (const s of theirs) {
    const here = byTitle.get(s.title);
    check(here === s.text, `section/${s.title}`,
          here === undefined ? 'this door has no such section — the wire layer lost a piece here'
            : here === s.text ? ''
            : `door ${sha(here)} (${here.split('\n').length} lines) vs wire ${sha(s.text)} (${s.text.split('\n').length} lines)`
              + '\n      The wire layer is edited in Muretai core and re-synced to agent-wire; this door carries a copy of the same bytes.');
  }
  const extra = mine.filter((s) => !theirs.some((t) => t.title === s.title));
  console.log(`  sections: ${theirs.length} shared, ${doorRegion.split('\n').length} lines in this door's block`);
  for (const s of extra) {
    console.log(`  note: this door also carries "${s.title}" (${s.text.split('\n').length} lines) — not part of the wire layer agent-wire publishes`);
  }
}

const pinned = slice(wire, PINNED, START);
if (check(pinned !== null, 'pinned/marker-found', `${wirePath} has no "// ---- pinned:" marker`)) {
  const lines = pinned.split('\n').slice(1).filter((l) => l.trim() !== '');
  const doorLines = new Set(door.split('\n'));
  const missing = lines.filter((l) => !doorLines.has(l));
  check(missing.length === 0, 'pinned/every-line-is-a-line-of-this-door',
        missing.length === 0 ? '' : `${missing.length} of ${lines.length} not found, first: ${JSON.stringify(missing[0]).slice(0, 90)}`);
  if (missing.length === 0) console.log(`  pinned: ${lines.length} lines quoted from this door`);
}

// The golden vectors: this package keeps a copy for a reader who never clones agent-wire, and
// a copy that can go stale is worse than none.
for (const name of ['wire_vectors.json', 'wba_vectors.json']) {
  const mine = join(ROOT, 'testdata', name);
  const theirs = join(wireRoot, 'vectors', name);
  if (!existsSync(mine) || !existsSync(theirs)) {
    console.log(`  skip: ${name} (${!existsSync(mine) ? 'not in testdata/' : 'not in agent-wire/vectors/'})`);
    continue;
  }
  const a = readFileSync(mine, 'utf8');
  const b = readFileSync(theirs, 'utf8');
  check(a === b, `vectors/${name}`, a === b ? '' : `testdata ${sha(a)} vs agent-wire ${sha(b)}`);
}

if (failures.length) {
  console.log(`\nFAILED — ${failures.length} of ${pass + failures.length} checks:\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('\nA drift here is not cosmetic: these are the bytes every other implementation');
  console.log('reproduces, and a mismatch is a signature that verifies nowhere.\n');
  process.exit(1);
}
console.log(`OK — ${pass} checks: this door's crypto block is the wire layer agent-wire publishes.\n`);
