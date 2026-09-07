#!/usr/bin/env node
/*
 * conformance/wire-twin.mjs — the door's crypto block is the wire layer, byte for byte.
 *
 * WHY THIS EXISTS. The block between the `CANONICAL JSON` banner and the `reach-back through a
 * relay` banner is not this package's private code: it is the wire contract every other
 * implementation reproduces — the Python node, the Swift and Kotlin clients, the PHP plugin,
 * the browser extension. That layer has a home of its own, `agent-wire`, which carries the
 * same bytes in `js/wire.mjs` beside the golden vectors. Two copies of one contract drift, and
 * a drift here is silent on the wire: nothing throws, signatures simply stop verifying for
 * everyone else. This is the alarm on this side of that copy.
 *
 * WHAT IT COMPARES
 *   sections   the nine sections named in EXPECTED_SECTIONS occur in agent-wire's block AND in
 *              this door, byte for byte
 *   pinned     every DECLARATION agent-wire quotes above its copy of the block is found in this
 *              door BY NAME, declared exactly once, and compared whole
 *   surface    nothing else in js/wire.mjs is code: outside the block, only comments, the
 *              door's own `node:` imports, those pinned declarations and one export
 *   vectors    testdata/*.json == agent-wire's vectors/*.json
 *
 * THREE THINGS THIS FILE LEARNED THE HARD WAY, each from an attack that made an earlier cut
 * of it print OK while the bytes differed:
 *
 *   1. THE LIST OF SECTIONS IS PINNED HERE, NOT READ FROM agent-wire. Comparing "every section
 *      agent-wire happens to carry" meant deleting a section THERE silently unpinned it HERE —
 *      eight of the nine could go one at a time, each leaving a `note:` line that reads exactly
 *      like the legitimate one `pay/v0` earns for adding a section. A checker that lets the
 *      checked party choose what is checked is a checker in name.
 *   2. PINNED DECLARATIONS ARE MATCHED BY NAME, NOT BY SUBSTRING. They live OUTSIDE the block —
 *      `CLOCK_WINDOW_S`, `REPLAY_TTL_S`, the size caps, the `-32xxx` table — so they are the
 *      softest target in the file, and "does this line appear somewhere in the door" is not a
 *      check: `export const REPLAY_TTL_S = 60;` beside a comment quoting the old line passed
 *      it, with the replay window cut tenfold.
 *   3. THE 72 LINES OUTSIDE THE BLOCK ARE CODE TOO. One of them is the `node:crypto` import.
 *      Repointing it at a local shim left every signature and every key running through
 *      another file while this check said OK, because it looked only at the block.
 *
 * A MISSING SIBLING IS A SKIP, NOT A FAILURE. `npm install` delivers this package to machines
 * that have no agent-wire checkout, and `npm test` must stay green there. The check says which
 * path it looked in, so a skip can never hide behind silence. A sibling that EXISTS but is
 * unreadable, empty or half-copied is a failure, not a skip.
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

/** The wire layer, section by section, in file order. Pinned HERE: agent-wire does not get to
 *  shorten the list of what it is held to. A section this door adds and agent-wire does not
 *  publish (pay/v0's grants and receipts) is reported and not compared — that is a door growing
 *  a new signed object, not the wire layer losing one. */
const EXPECTED_SECTIONS = [
  'CANONICAL JSON',
  'Ed25519 (node:crypto)',
  'base58btc + did:key',
  'the signing envelope',
  'KeyState (inline op-key, T142 A2)',
  'Web Bot Auth (RFC 9421 subset, verify-only) — T107',
  'device-key binding v2 (T102)',
  'signed Agent Card envelope',
  'cryptobox (X25519 + ChaCha20)',
];
/** The declarations agent-wire quotes above its copy of the block, by name. Pinned here for
 *  the same reason as the sections: comparing only what the pinned zone still happens to
 *  declare makes DELETION invisible — drop `export const REPLAY_TTL_S = 600;` there and every
 *  row stays green while the constant simply stops being pinned. */
const EXPECTED_PINNED = [
  'PROTOCOL_VERSION', 'MAX_TEXT_BYTES', 'MAX_BODY_BYTES', 'CLOCK_WINDOW_S', 'REPLAY_TTL_S',
  'CARD_SIG_REFRESH_S', 'AGENT_CARD_PATH', 'AGENT_CARD_PATH_LEGACY', 'AGENT_CARD_SIG_PATH',
  'SIGNED_ENVELOPE_SCHEME', 'AGENT_ENTRY_REL', 'ERRORS', 'asciiLower', 'CARD_ENVELOPE_VERSION',
  'CARD_ENVELOPE_TYPE',
];
/** The block is ~1038 lines. A floor stops a mangled banner from collapsing the compared
 *  region to a handful of lines that trivially match. */
const MIN_REGION_LINES = 900;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); const v = args[i + 1]; return i >= 0 && v && !v.startsWith('--') ? v : null; };
const doorPath = opt('--door') ?? join(ROOT, 'muretai-agent-entry.mjs');
const wireRoot = resolve(ROOT, process.env.MURETAI_AGENT_WIRE || '../agent-wire');
const wirePath = join(wireRoot, 'js', 'wire.mjs');

const START = /^\/\/ =+ CANONICAL JSON$/;
const END_DOOR = /^\/\/ =+ reach-back through a relay$/;
const END_WIRE = /^\/\/ ---- end of the door's block/;
const PINNED = /^\/\/ ---- pinned:/;
const DECL = /^(?:export\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/;

let pass = 0;
const failures = [];
function check(ok, label, detail) {
  if (ok) { pass += 1; return true; }
  failures.push(detail ? `${label}\n      ${detail}` : label);
  return false;
}
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

function slice(lines, startRe, endRe) {
  const a = lines.findIndex((l) => startRe.test(l));
  const b = lines.findIndex((l, i) => i > a && endRe.test(l));
  return a < 0 || b < 0 ? null : { a, b, text: lines.slice(a, b).join('\n') };
}

/** The banner-delimited sections of a block. The title is trimmed: three invisible trailing
 *  spaces otherwise read as a different section, and the failure then says "no such section"
 *  about one that is right there. */
function sections(region) {
  const lines = region.split('\n');
  const marks = [];
  lines.forEach((l, i) => { const m = /^\/\/ ={10,} (.+)$/.exec(l); if (m) marks.push([i, m[1].trim()]); });
  return marks.map(([start, title], k) => ({
    title,
    text: lines.slice(start, k + 1 < marks.length ? marks[k + 1][0] : lines.length).join('\n'),
  }));
}

/** The extent of the declaration that starts at `i`, by bracket balance: a single line that
 *  closes with `;`, or everything through the line that brings the depth back to zero. */
function unitAt(lines, i) {
  let depth = 0;
  for (let end = i; end < lines.length && end < i + 400; end += 1) {
    for (const ch of lines[end]) {
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    }
    if (depth <= 0 && /[;}\]]\s*$/.test(lines[end])) return { start: i, end, text: lines.slice(i, end + 1).join('\n') };
  }
  return { start: i, end: i, text: lines[i] };
}

/** Every top-level declaration in `text`, as [{name, text, start, end}]. */
function declarations(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = DECL.exec(lines[i]);
    if (!m) continue;
    const u = unitAt(lines, i);
    out.push({ name: m[1], text: u.text, start: u.start, end: u.end });
    i = u.end;
  }
  return out;
}

if (!existsSync(wireRoot)) {
  console.log(`skip: no agent-wire checkout at ${wireRoot} (set MURETAI_AGENT_WIRE if it lives elsewhere).`);
  console.log('      Nothing was compared. The wire layer is at https://github.com/muretai/agent-wire.\n');
  process.exit(0);
}
// The directory is there. From here a missing or unreadable file is a failure: a half-copied
// sibling is exactly the state in which a stale copy hides.
check(existsSync(wirePath), 'wire/js-wire-mjs-present', `${wireRoot} exists but has no js/wire.mjs`);
if (failures.length) { report(); }

const doorRaw = readFileSync(doorPath);
const wireRaw = readFileSync(wirePath);
// Compare bytes, not a lossy decode: two files that differ only in bytes no decoder can
// represent must not read as equal.
for (const [name, raw] of [['this door', doorRaw], ["agent-wire's js/wire.mjs", wireRaw]]) {
  const text = raw.toString('utf8');
  check(Buffer.from(text, 'utf8').equals(raw), `encoding/${name}-is-utf8`, `${name} is not valid UTF-8`);
  check(!text.includes('\r\n'), `encoding/${name}-is-lf`,
        `${name} has CRLF line endings. The bytes every implementation signs are LF; check out with `
        + '`core.autocrlf=false` (or `* -text` in .gitattributes) before reading anything into this.');
}
const door = doorRaw.toString('utf8');
const wire = wireRaw.toString('utf8');
const doorLines = door.split('\n');
const wireLines = wire.split('\n');

const doorRegion = slice(doorLines, START, END_DOOR);
const wireRegion = slice(wireLines, START, END_WIRE);
check(doorRegion !== null, 'region/door-banners-found', `${doorPath} has no CANONICAL JSON … reach-back pair`);
check(wireRegion !== null, 'region/wire-banners-found', `${wirePath} has no CANONICAL JSON … end-of-block pair`);

if (doorRegion !== null && wireRegion !== null) {
  for (const [label, r] of [['door', doorRegion], ['wire', wireRegion]]) {
    const n = r.text.split('\n').length;
    check(n >= MIN_REGION_LINES, `region/${label}-is-whole`,
          `the ${label}'s block is ${n} lines, and at least ${MIN_REGION_LINES} were expected — a banner has moved or been faked`);
  }
  const mine = sections(doorRegion.text);
  const theirs = sections(wireRegion.text);
  // A title that appears twice makes any title->text lookup last-wins, which is a place to hide
  // a mutated section behind a clean copy of itself.
  for (const [label, list] of [['door', mine], ['wire', theirs]]) {
    const seen = new Set();
    const dup = list.map((s) => s.title).filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
    check(dup.length === 0, `section/no-duplicate-titles-in-${label}`, dup.length ? `the ${label} declares "${dup[0]}" twice` : '');
  }
  const doorBy = new Map(mine.map((s) => [s.title, s.text]));
  const wireBy = new Map(theirs.map((s) => [s.title, s.text]));
  for (const title of EXPECTED_SECTIONS) {
    const a = doorBy.get(title);
    const b = wireBy.get(title);
    check(a !== undefined && b !== undefined && a === b, `section/${title}`,
          b === undefined ? "agent-wire's js/wire.mjs no longer carries this section — the wire layer lost a piece, or EXPECTED_SECTIONS here is out of date"
            : a === undefined ? 'this door has no such section'
            : a === b ? ''
            : `door ${sha(a)} (${a.split('\n').length} lines) vs wire ${sha(b)} (${b.split('\n').length} lines)`
              + '\n      The wire layer is edited in Muretai core and re-synced to agent-wire; this door carries a copy of the same bytes.');
  }
  const extraWire = theirs.filter((s) => !EXPECTED_SECTIONS.includes(s.title));
  check(extraWire.length === 0, 'section/wire-carries-only-the-expected-nine',
        extraWire.length ? `agent-wire also carries "${extraWire[0].title}" — if the wire layer grew, add it to EXPECTED_SECTIONS here` : '');
  console.log(`  sections: ${EXPECTED_SECTIONS.length} pinned, ${doorRegion.text.split('\n').length} lines in this door's block, ${wireRegion.text.split('\n').length} in agent-wire's`);
  for (const s of mine.filter((x) => !EXPECTED_SECTIONS.includes(x.title))) {
    console.log(`  note: this door also carries "${s.title}" (${s.text.split('\n').length} lines) — not part of the wire layer agent-wire publishes`);
  }
}

// ---------------------------------------------------------------- the pinned declarations
const pinnedSlice = wireRegion === null ? null : slice(wireLines, PINNED, START);
let pinnedUnits = [];
if (check(pinnedSlice !== null, 'pinned/marker-found', `${wirePath} has no "// ---- pinned:" marker`)) {
  pinnedUnits = declarations(pinnedSlice.text);
  const have = pinnedUnits.map((d) => d.name);
  const missing = EXPECTED_PINNED.filter((n) => !have.includes(n));
  const extra = have.filter((n) => !EXPECTED_PINNED.includes(n));
  check(missing.length === 0 && extra.length === 0, 'pinned/exactly-the-expected-declarations',
        missing.length ? `agent-wire no longer pins ${missing.join(', ')}` : extra.length ? `agent-wire also pins ${extra.join(', ')} — if the wire layer grew, add it to EXPECTED_PINNED here` : '');
  for (const d of pinnedUnits) {
    const found = [];
    for (let i = 0; i < doorLines.length; i += 1) {
      const m = DECL.exec(doorLines[i]);
      if (m && m[1] === d.name) { found.push(unitAt(doorLines, i)); i = found[found.length - 1].end; }
    }
    check(found.length === 1 && found[0].text === d.text, `pinned/${d.name}`,
          found.length === 0 ? `this door does not declare ${d.name}`
            : found.length > 1 ? `this door declares ${d.name} ${found.length} times — one of them is not the one agent-wire pinned`
            : `door ${JSON.stringify(found[0].text).slice(0, 110)}\n      wire ${JSON.stringify(d.text).slice(0, 110)}`);
  }
  console.log(`  pinned: ${pinnedUnits.length} declarations matched by name (${pinnedUnits.map((d) => d.name).join(', ')})`);
}

// ---------------------------------------------------------------- nothing else is code
// Everything in js/wire.mjs outside the block must be comment, blank, one of the door's own
// `node:` imports, a pinned declaration, or the one footer export. This is what stops the
// import line being repointed at a shim while the block itself compares clean.
if (wireRegion !== null) {
  const inRegion = new Set();
  for (let i = wireRegion.a; i < wireRegion.b; i += 1) inRegion.add(i);
  for (const d of pinnedUnits) for (let i = pinnedSlice.a + d.start; i <= pinnedSlice.a + d.end; i += 1) inRegion.add(i);
  const doorImports = new Set(doorLines.filter((l) => /^(import\s|\s+create|\s+diffieHellman|\s*\}\s+from\s+'node:)/.test(l)));
  const stray = [];
  wireLines.forEach((l, i) => {
    if (inRegion.has(i)) return;
    const t = l.trim();
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return;
    if (t === "export { wbaPublicFromJwk };") return;              // the one line this repo's copy adds
    if (doorImports.has(l)) return;                                 // the door's own import lines, verbatim
    stray.push(`${i + 1}: ${t.slice(0, 80)}`);
  });
  check(stray.length === 0, 'surface/nothing-outside-the-block-is-code',
        stray.length ? `${stray.length} line(s) of agent-wire's js/wire.mjs are code this door does not carry, first: ${stray[0]}` : '');
}

// ---------------------------------------------------------------- the golden vectors
for (const name of ['wire_vectors.json', 'wba_vectors.json']) {
  const mine = join(ROOT, 'testdata', name);
  const theirs = join(wireRoot, 'vectors', name);
  if (!existsSync(theirs)) { console.log(`  skip: ${name} is not in agent-wire/vectors/`); continue; }
  // agent-wire has it, so this repo's copy is not optional: a vectors file that quietly went
  // missing used to leave the run saying OK with two fewer checks and nobody counting.
  if (!check(existsSync(mine), `vectors/${name}/present`, `testdata/${name} is missing here, and agent-wire publishes it`)) continue;
  const a = readFileSync(mine);
  const b = readFileSync(theirs);
  check(a.equals(b), `vectors/${name}`, a.equals(b) ? '' : `testdata ${sha(a.toString('latin1'))} vs agent-wire ${sha(b.toString('latin1'))}`);
}

report();

function report() {
  if (failures.length) {
    console.log(`\nFAILED — ${failures.length} of ${pass + failures.length} checks:\n`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log('\nA drift here is not cosmetic: these are the bytes every other implementation');
    console.log('reproduces, and a mismatch is a signature that verifies nowhere.\n');
    process.exit(1);
  }
  // A count nobody asserts is a count that can quietly fall.
  const FLOOR = 4 + 1 + 2 + 2 + EXPECTED_SECTIONS.length + 1 + 1 + 1 + EXPECTED_PINNED.length + 1 + 4;
  if (pass < FLOOR) {
    console.log(`\nFAILED — only ${pass} checks ran, and at least ${FLOOR} were expected.`);
    console.log('Something was skipped that should not have been. Read the rows above.\n');
    process.exit(1);
  }
  console.log(`OK — ${pass} checks: this door's crypto block is the wire layer agent-wire publishes.`);
  console.log(`     (compared against ${wirePath})\n`);
}
