#!/usr/bin/env node
/*
 * conformance/seam-twin.mjs — the door's crypto block is the seam, byte for byte.
 *
 * WHY THIS EXISTS. The block between the `CANONICAL JSON` banner and the `reach-back through a
 * relay` banner is not this package's private code: it is the seam — the wire layer every
 * other implementation reproduces (the Python node, the Swift and Kotlin clients, the PHP
 * plugin, the browser extension). Its home is the agent-seam repository; this door carries a
 * copy that `scripts/vendor-seam.mjs` took at one commit and pinned in
 * vendor/agent-seam/VENDOR.json. Two copies of one contract drift, and a drift here is silent
 * on the wire: nothing throws, signatures simply stop verifying for everyone else. This is the
 * alarm on this side of the copy, and it needs NOTHING outside this repository to sound.
 *
 * WHAT IT COMPARES
 *   pin        every file under vendor/agent-seam/ is the one VENDOR.json names, at the sha256
 *              it records, and nothing else is there
 *   sections   the nine sections in EXPECTED_SECTIONS occur in the vendored seam.mjs AND in
 *              this door, byte for byte
 *   pinned     every DECLARATION seam.mjs carries above its region is found in this door BY
 *              NAME, declared exactly once, and compared whole
 *   surface    nothing else in seam.mjs is code: outside the region, only comments, this
 *              door's own `node:` imports, those pinned declarations and one export
 *   derived    conformance/vectors.json is exactly what scripts/build-vectors.mjs derives from
 *              the vendored vectors (source checkout only)
 *   readme     what the npm page must keep saying (source checkout only; see below)
 *   sibling    ONLY when an agent-seam checkout is beside this one: the recorded commit really
 *              produces every vendored byte (`git show <commit>:<path>`), so a pin cannot name
 *              a commit it was not taken from; and how far behind that checkout's HEAD it is
 *
 * THREE THINGS THIS FILE LEARNED THE HARD WAY, each from an attack that made an earlier cut
 * of it print OK while the bytes differed:
 *   1. THE LIST OF SECTIONS IS PINNED HERE, NOT READ FROM THE SEAM. Comparing "every section
 *      the seam happens to carry" meant deleting a section THERE silently unpinned it HERE. A
 *      checker that lets the checked party choose what is checked is a checker in name.
 *   2. PINNED DECLARATIONS ARE MATCHED BY NAME, NOT BY SUBSTRING. They live OUTSIDE the block
 *      (`CLOCK_WINDOW_S`, `REPLAY_TTL_S`, the size caps, the `-32xxx` table), the softest target
 *      in the file; "does this line appear somewhere" passed a tenfold-shorter replay window.
 *   3. THE LINES OUTSIDE THE BLOCK ARE CODE TOO. Repointing the `node:crypto` import at a shim
 *      left every signature running through another file while a block-only check said OK.
 *
 * WHERE IT RUNS. In this source checkout, everything above. In the published tarball there is
 * no vendor/ and no scripts/ — the package ships one file and the vectors suite — so this
 * prints one `skip:` line and exits 0; conformance/run.mjs is the contract check that ships.
 * A source checkout with vendor/agent-seam/ missing is a FAILURE, not a skip.
 *
 * Run:  node conformance/seam-twin.mjs                    (part of `npm test`)
 *       node conformance/seam-twin.mjs --door PATH        (check another door file)
 *       MURETAI_AGENT_SEAM=/path/to/agent-seam npm test   (sibling rows against that checkout)
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const VENDOR = join(ROOT, 'vendor', 'agent-seam');
const SOURCE_CHECKOUT = existsSync(join(ROOT, 'scripts', 'build-vectors.mjs'));

/** The seam, section by section, in file order. Pinned HERE: agent-seam does not get to shorten
 *  the list of what it is held to. A section this door adds and the seam does not carry
 *  (pay/v0's grants and receipts) is reported and not compared. */
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
/** The declarations the seam carries above its region, by name. Pinned here for the same
 *  reason: comparing only what the pinned zone still happens to declare makes DELETION
 *  invisible. */
const EXPECTED_PINNED = [
  'PROTOCOL_VERSION', 'MAX_TEXT_BYTES', 'MAX_BODY_BYTES', 'CLOCK_WINDOW_S', 'REPLAY_TTL_S',
  'CARD_SIG_REFRESH_S', 'AGENT_CARD_PATH', 'AGENT_CARD_PATH_LEGACY', 'AGENT_CARD_SIG_PATH',
  'SIGNED_ENVELOPE_SCHEME', 'AGENT_ENTRY_REL', 'ERRORS', 'asciiLower', 'CARD_ENVELOPE_VERSION',
  'CARD_ENVELOPE_TYPE',
];
/** The block is ~1038 lines. A floor stops a mangled banner from collapsing the compared
 *  region to a handful of lines that trivially match. */
const MIN_REGION_LINES = 900;
const VENDORED = ['seam.mjs', 'wire_vectors.json', 'wba_vectors.json'];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); const v = args[i + 1]; return i >= 0 && v && !v.startsWith('--') ? v : null; };
const doorPath = opt('--door') ?? join(ROOT, 'muretai-agent-entry.mjs');
const seamPath = join(VENDOR, 'seam.mjs');

const START = /^\/\/ =+ CANONICAL JSON$/;
const END_DOOR = /^\/\/ =+ reach-back through a relay$/;
const END_SEAM = /^\/\/ ---- end of the seam$/;
const PINNED = /^\/\/ ---- pinned:/;
const DECL = /^(?:export\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/;

let pass = 0;
const failures = [];
function check(ok, label, detail) {
  if (ok) { pass += 1; return true; }
  failures.push(detail ? `${label}\n      ${detail}` : label);
  return false;
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const short = (s) => sha(s).slice(0, 12);

function slice(lines, startRe, endRe) {
  const a = lines.findIndex((l) => startRe.test(l));
  const b = lines.findIndex((l, i) => i > a && endRe.test(l));
  return a < 0 || b < 0 ? null : { a, b, text: lines.slice(a, b).join('\n') };
}
function sections(region) {
  const lines = region.split('\n');
  const marks = [];
  lines.forEach((l, i) => { const m = /^\/\/ ={10,} (.+)$/.exec(l); if (m) marks.push([i, m[1].trim()]); });
  return marks.map(([start, title], k) => ({ title, text: lines.slice(start, k + 1 < marks.length ? marks[k + 1][0] : lines.length).join('\n') }));
}
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

// ---------------------------------------------------------------- where are we
if (!existsSync(VENDOR)) {
  if (!SOURCE_CHECKOUT) {
    console.log('skip: not a source checkout — the published package carries no vendor/agent-seam/.');
    console.log('      conformance/run.mjs is the contract check that ships; the seam is at https://github.com/muretai/agent-seam.\n');
    process.exit(0);
  }
  check(false, 'pin/vendor-dir-present', `${VENDOR} is missing from a source checkout — run: npm run vendor:seam -- --ref <tag>`);
  report();
}

// ---------------------------------------------------------------- the pin
let pin = null;
try { pin = JSON.parse(readFileSync(join(VENDOR, 'VENDOR.json'), 'utf8')); } catch (e) { check(false, 'pin/VENDOR.json-readable', e.message); }
if (pin) {
  check(pin.from === 'agent-seam' && /^[0-9a-f]{40}$/.test(pin.commit || '') && typeof pin.version === 'string' && pin.files && typeof pin.files === 'object',
        'pin/VENDOR.json-shape', 'VENDOR.json must carry from=agent-seam, a 40-hex commit, a version and a files map');
  const listed = Object.keys(pin.files || {}).map((p) => p.replace(/^vendor\/agent-seam\//, ''));
  const onDisk = readdirSync(VENDOR).filter((f) => f !== 'VENDOR.json').sort();
  check(JSON.stringify(listed.slice().sort()) === JSON.stringify(onDisk), 'pin/accounts-for-disk',
        `VENDOR.json lists [${listed.join(', ')}] but vendor/agent-seam/ holds [${onDisk.join(', ')}]`);
  for (const name of VENDORED) {
    check(listed.includes(name), `pin/${name}-listed`, `VENDOR.json does not list ${name}`);
  }
  for (const [p, v] of Object.entries(pin.files || {})) {
    const local = join(ROOT, p);
    if (!check(existsSync(local), `pin/${p}-present`, `${p} is named by VENDOR.json but is not on disk`)) continue;
    const got = sha(readFileSync(local));
    check(got === v.sha256, `pin/${p}-sha256`, `on disk ${got.slice(0, 12)}, VENDOR.json says ${String(v.sha256).slice(0, 12)} — edited in place? re-vendor instead`);
  }
}
if (failures.length) report();

// ---------------------------------------------------------------- the two files
const doorRaw = readFileSync(doorPath);
const seamRaw = readFileSync(seamPath);
for (const [name, raw] of [['this door', doorRaw], ['vendor/agent-seam/seam.mjs', seamRaw]]) {
  const text = raw.toString('utf8');
  check(Buffer.from(text, 'utf8').equals(raw), `encoding/${name}-is-utf8`, `${name} is not valid UTF-8`);
  check(!text.includes('\r\n'), `encoding/${name}-is-lf`, `${name} has CRLF line endings; the bytes every implementation signs are LF`);
}
const door = doorRaw.toString('utf8');
const seam = seamRaw.toString('utf8');
const doorLines = door.split('\n');
const seamLines = seam.split('\n');

const doorRegion = slice(doorLines, START, END_DOOR);
const seamRegion = slice(seamLines, START, END_SEAM);
check(doorRegion !== null, 'region/door-banners-found', `${doorPath} has no CANONICAL JSON … reach-back pair`);
check(seamRegion !== null, 'region/seam-banners-found', `${seamPath} has no CANONICAL JSON … end-of-the-seam pair`);

if (doorRegion !== null && seamRegion !== null) {
  for (const [label, r] of [['door', doorRegion], ['seam', seamRegion]]) {
    const n = r.text.split('\n').length;
    check(n >= MIN_REGION_LINES, `region/${label}-is-whole`, `the ${label}'s block is ${n} lines, and at least ${MIN_REGION_LINES} were expected — a banner has moved or been faked`);
  }
  const mine = sections(doorRegion.text);
  const theirs = sections(seamRegion.text);
  for (const [label, list] of [['door', mine], ['seam', theirs]]) {
    const seen = new Set();
    const dup = list.map((s) => s.title).filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
    check(dup.length === 0, `section/no-duplicate-titles-in-${label}`, dup.length ? `the ${label} declares "${dup[0]}" twice` : '');
  }
  const doorBy = new Map(mine.map((s) => [s.title, s.text]));
  const seamBy = new Map(theirs.map((s) => [s.title, s.text]));
  for (const title of EXPECTED_SECTIONS) {
    const a = doorBy.get(title);
    const b = seamBy.get(title);
    check(a !== undefined && b !== undefined && a === b, `section/${title}`,
          b === undefined ? 'the vendored seam.mjs no longer carries this section — the seam lost a piece, or EXPECTED_SECTIONS here is out of date'
            : a === undefined ? 'this door has no such section'
            : a === b ? ''
            : `door ${short(a)} (${a.split('\n').length} lines) vs seam ${short(b)} (${b.split('\n').length} lines)`
              + '\n      The seam is edited in agent-seam; this door carries a copy: npm run vendor:seam -- --ref <tag>');
  }
  const extraSeam = theirs.filter((s) => !EXPECTED_SECTIONS.includes(s.title));
  check(extraSeam.length === 0, 'section/seam-carries-only-the-expected-nine',
        extraSeam.length ? `the seam also carries "${extraSeam[0].title}" — if it grew, add it to EXPECTED_SECTIONS here` : '');
  console.log(`  sections: ${EXPECTED_SECTIONS.length} pinned, ${doorRegion.text.split('\n').length} lines in this door's block, ${seamRegion.text.split('\n').length} in the vendored seam`);
  for (const s of mine.filter((x) => !EXPECTED_SECTIONS.includes(x.title))) {
    console.log(`  note: this door also carries "${s.title}" (${s.text.split('\n').length} lines) — not part of the seam`);
  }
}

// ---------------------------------------------------------------- the pinned declarations
const pinnedSlice = seamRegion === null ? null : slice(seamLines, PINNED, START);
let pinnedUnits = [];
if (check(pinnedSlice !== null, 'pinned/marker-found', `${seamPath} has no "// ---- pinned:" marker`)) {
  pinnedUnits = declarations(pinnedSlice.text);
  const have = pinnedUnits.map((d) => d.name);
  const missing = EXPECTED_PINNED.filter((n) => !have.includes(n));
  const extra = have.filter((n) => !EXPECTED_PINNED.includes(n));
  check(missing.length === 0 && extra.length === 0, 'pinned/exactly-the-expected-declarations',
        missing.length ? `the seam no longer pins ${missing.join(', ')}` : extra.length ? `the seam also pins ${extra.join(', ')} — if it grew, add it to EXPECTED_PINNED here` : '');
  for (const d of pinnedUnits) {
    const found = [];
    for (let i = 0; i < doorLines.length; i += 1) {
      const m = DECL.exec(doorLines[i]);
      if (m && m[1] === d.name) { found.push(unitAt(doorLines, i)); i = found[found.length - 1].end; }
    }
    check(found.length === 1 && found[0].text === d.text, `pinned/${d.name}`,
          found.length === 0 ? `this door does not declare ${d.name}`
            : found.length > 1 ? `this door declares ${d.name} ${found.length} times — one of them is not the pinned one`
            : `door ${JSON.stringify(found[0].text).slice(0, 110)}\n      seam ${JSON.stringify(d.text).slice(0, 110)}`);
  }
  console.log(`  pinned: ${pinnedUnits.length} declarations matched by name (${pinnedUnits.map((d) => d.name).join(', ')})`);
}

// ---------------------------------------------------------------- nothing else is code
if (seamRegion !== null && pinnedSlice !== null) {
  const inRegion = new Set();
  for (let i = seamRegion.a; i < seamRegion.b; i += 1) inRegion.add(i);
  for (const d of pinnedUnits) for (let i = pinnedSlice.a + d.start; i <= pinnedSlice.a + d.end; i += 1) inRegion.add(i);
  const doorImports = new Set(doorLines.filter((l) => /^(import\s|\s+create|\s+diffieHellman|\s*\}\s+from\s+'node:)/.test(l)));
  const stray = [];
  let footerExports = 0;
  seamLines.forEach((l, i) => {
    if (inRegion.has(i)) return;
    const t = l.trim();
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return;
    if (i > seamRegion.b && /^export \{ [\w$]+ \};$/.test(t)) { footerExports += 1; return; }   // the one line the seam's file adds
    if (doorImports.has(l)) return;                                                             // the door's own import lines, verbatim
    stray.push(`${i + 1}: ${t.slice(0, 80)}`);
  });
  check(stray.length === 0, 'surface/nothing-outside-the-block-is-code',
        stray.length ? `${stray.length} line(s) of the vendored seam.mjs are code this door does not carry, first: ${stray[0]}` : '');
  check(footerExports === 1, 'surface/one-footer-export', `expected exactly one export after the end marker, found ${footerExports}`);
}

// ---------------------------------------------------------------- the derived subset and the README (source checkout only)
if (SOURCE_CHECKOUT) {
  try {
    const { render } = await import('../scripts/build-vectors.mjs');
    const want = render();
    const have = readFileSync(join(ROOT, 'conformance', 'vectors.json'), 'utf8');
    check(want === have, 'derived/conformance-vectors-json-is-current', 'conformance/vectors.json is not what scripts/build-vectors.mjs derives from vendor/agent-seam/wire_vectors.json — run: npm run build:vectors');
  } catch (e) {
    check(false, 'derived/build-vectors-runs', e.message);
  }
  // What the npm page must keep saying. These were core's `part_published_readme` until this
  // repository became the door's home; each is a bug that shipped once.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const rel = /^export const AGENT_ENTRY_REL = '([^']*)';/m.exec(door);
  if (check(rel !== null, 'readme/AGENT_ENTRY_REL-is-a-plain-constant', 'AGENT_ENTRY_REL is no longer a plain constant in the door')) {
    const missing = [];
    if (!readme.includes(`rel="${rel[1]}"`)) missing.push('the `Link:` header spelling');
    if (!readme.includes(`<link rel="${rel[1]}"`)) missing.push('the `<link rel=…>` tag spelling');
    if (!readme.includes(`<a href="/.well-known/agent-card.json" rel="${rel[1]}"`)) missing.push('the body `<a>` spelling');
    check(missing.length === 0, 'readme/teaches-all-three-signpost-spellings', missing.length ? `missing ${missing.join(' and ')} — the signpost is a REQUIRED install step` : '');
  }
  check(!readme.includes('three routes and nothing else'), 'readme/no-three-routes-completeness-claim', 'retracted 2026-08-20: it stopped adopters at three steps when the signpost is the fourth');
  const sink = /client_id:\s*env\./.exec(readme);
  check(sink === null, 'readme/analytics-example-sends-no-raw-did', sink ? `found ${sink[0]} — key the sink on a SALTED digest` : '');
  check(readme.includes('observer'), 'readme/documents-the-observer-slot', '');
}

// ---------------------------------------------------------------- the sibling, when it is there
const siblingRoot = resolve(ROOT, process.env.MURETAI_AGENT_SEAM || '../agent-seam');
if (pin && existsSync(join(siblingRoot, '.git'))) {
  const git = (...a) => execFileSync('git', ['-C', siblingRoot, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
  let known = true;
  try { git('cat-file', '-e', `${pin.commit}^{commit}`); } catch { known = false; }
  if (check(known, 'sibling/pinned-commit-exists', `${siblingRoot} does not have commit ${pin.commit.slice(0, 12)} — a stale checkout, or a pin that lies; fetch, or point MURETAI_AGENT_SEAM elsewhere`)) {
    for (const [p, v] of Object.entries(pin.files)) {
      let theirs = null;
      try { theirs = git('show', `${pin.commit}:${v.source}`); } catch { /* reported below */ }
      const mine = readFileSync(join(ROOT, p));
      check(theirs !== null && theirs.equals(mine), `sibling/${p}-is-what-${pin.commit.slice(0, 7)}-produces`,
            theirs === null ? `${pin.commit.slice(0, 7)} has no ${v.source}` : `the pin lies: ${v.source} at ${pin.commit.slice(0, 7)} is ${sha(theirs).slice(0, 12)}, the copy here is ${sha(mine).slice(0, 12)}`);
    }
    const behind = git('rev-list', '--count', `${pin.commit}..HEAD`).toString().trim();
    const head = git('rev-parse', '--short', 'HEAD').toString().trim();
    console.log(`  sibling: ${siblingRoot} — pin ${pin.ref} (${pin.commit.slice(0, 7)}) is ${behind} commit(s) behind its HEAD ${head}`);
  }
} else {
  console.log(`  skip: no agent-seam checkout at ${siblingRoot} — the pin was verified by digest only (set MURETAI_AGENT_SEAM to check the recorded commit too)`);
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
  const FLOOR = 2 + 3 + 6 + 4 + 2 + 2 + EXPECTED_SECTIONS.length + 1 + 1 + 1 + EXPECTED_PINNED.length + 2;
  if (pass < FLOOR) {
    console.log(`\nFAILED — only ${pass} checks ran, and at least ${FLOOR} were expected. Read the rows above.\n`);
    process.exit(1);
  }
  console.log(`OK — ${pass} checks: this door's crypto block is the seam, as vendored at ${pin ? `${pin.ref} (${pin.commit.slice(0, 7)}, agent-seam ${pin.version})` : '?'}.\n`);
}
