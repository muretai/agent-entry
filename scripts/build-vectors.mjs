#!/usr/bin/env node
/**
 * scripts/build-vectors.mjs — derive conformance/vectors.json from the vendored seam vectors.
 *
 * WHY THIS LIVES HERE. An Agent Entry implements the SEAM, not the network: canonical JSON,
 * did:key, the six-field envelope, the refusals, the card envelope, the device binding, the
 * Web Bot Auth verify side. Those bytes are owned by agent-seam and published there as
 * `vectors/wire_vectors.json`; this repository carries a pinned copy at
 * vendor/agent-seam/wire_vectors.json (see vendor/agent-seam/VENDOR.json). The door's
 * conformance file is a SUBSET of that file — the sections a door can actually be held to — and
 * a subset must be DERIVED, never hand-maintained: a second copy of a golden file is a second
 * answer to the same question, and the failure it produces is the worst kind, an implementer
 * passing a suite that no longer describes the implementation.
 *
 * Until 2026-09-07 this derivation lived in Muretai core, and core's test compared this
 * package's copy against ITS derivation — which made this repository a mirror of core rather
 * than the home of the door. It now runs here, from the vendored copy, and nothing outside this
 * repository is read. conformance/seam-twin.mjs fails when the file on disk is not what this
 * derives.
 *
 *   node scripts/build-vectors.mjs            # write conformance/vectors.json
 *   node scripts/build-vectors.mjs --check    # exit 1 if the file on disk is stale
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'conformance', 'vectors.json');
const SOURCE = join(ROOT, 'vendor', 'agent-seam', 'wire_vectors.json');

/** The sections a door can actually be held to. Ordered as they are written, so the output
 *  is stable under re-derivation. Byte-identical to core's Python builder by contract. */
const SECTIONS = [
  'protocolVersion',     // what these bytes are for
  'canonicalSpec',       // the canonicalisation rule, in words
  'timestampNote',       // integer epoch seconds is the CONTRACT, not a coincidence
  'canonical',           // the canonicaliser, including the traps both languages disagree on
  'numberHazards',       // numbers a canonicaliser must refuse rather than guess at
  'numberHazardNote',
  'did',                 // did:key derivation, both curves
  'envelope',            // the six signed fields and their exact bytes
  'bindingV2',           // the device->owner binding the door verifies
  'domainLinkage',       // the domain credential the door publishes and checks
  'domainLinkageNote',
  'webBotAuth',          // inbound Web Bot Auth, verify-only
  'cardpub',             // the signed card envelope the door serves
  'epochNote',
];
/** `reject` also carries invite and claim cases, which belong to a NODE, not a door.
 *  Everything else under `reject` is the door's, because the door implements the thing each
 *  group refuses: `message` the six-field envelope, `cardpub` the signed card envelope,
 *  `did` the did:key codec, `encoding` the canonical-JSON boundary. `keystate` is here too
 *  — the door carries `verifyKeystate` and `resolveOpDid` in its spliced block.
 *
 *  THIS LIST WAS `['message']` UNTIL 0.3.1, AND THAT WAS THE BUG. A group left out here is
 *  not merely unshipped, it is invisible: the derived file simply does not have it, so no
 *  loop can be written against it and nothing says one is missing. Upstream added
 *  `reject.encoding` and `reject.keystate` in 0.3.0 and `reject.cardpub` and `reject.did`
 *  in 0.3.1, and all four were dropped here without a word. `checkComplement` below now
 *  refuses to build a file that silently omits a group, so the next one has to be a
 *  decision rather than an oversight. */
const REJECT_KEYS = ['message', 'cardpub', 'did', 'encoding', 'keystate'];
/** The groups that belong to a NODE and are deliberately not the door's. Named, so that
 *  `REJECT_KEYS` plus this list must account for EVERY group upstream carries. */
const REJECT_NOT_OURS = ['invite', 'claim'];
const NOTE =
  'Golden wire vectors for an Agent Entry implementation. Reproduce every `canonical`, ' +
  '`did`, `signingPayload` and `bindingPayload` field BYTE-FOR-BYTE, and REFUSE every ' +
  'case under `reject`. A drift does not throw: it silently makes your signatures ' +
  'unverifiable by everyone else, and an implementation that refuses nothing passes ' +
  'every positive vector in this file. Header and URL values inside a signed vector are ' +
  'OPAQUE TEST DATA covered by that vector\'s signature: reproduce them verbatim. ' +
  'Substituting your own host there does not make the case yours, it makes it fail.';

/** Find the span of `"key": <value>` at `indent` spaces, as [firstLine, lastLine] — by TEXT.
 *
 *  Why text and not JSON.parse: the source deliberately carries `1.0` (numberHazards), the
 *  value whose canonical bytes differ between Python and JavaScript. `JSON.parse('1.0')` is
 *  irrecoverably `1`, so a builder that parsed and re-serialised would rewrite the very case
 *  that exists to be reproduced verbatim — and would do it silently. The file is
 *  `json.dumps(indent=2)` output: one key per line at a fixed indent, a value that is either
 *  a scalar on the same line or a bracketed block that closes at the same indent. Both are
 *  found here with a string-aware bracket walk, and never by trusting a line number. */
function spanOf(lines, key, indent) {
  const head = ' '.repeat(indent) + JSON.stringify(key) + ': ';
  const i = lines.findIndex((l) => l.startsWith(head));
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false, opened = false;
  for (let j = i; j < lines.length; j++) {
    const text = j === i ? lines[j].slice(head.length) : lines[j];
    for (const ch of text) {
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') { depth++; opened = true; }
      else if (ch === '}' || ch === ']') depth--;
    }
    if (!opened) return [i, i];               // a scalar: the whole value sat on one line
    if (depth === 0) return [i, j];
  }
  throw new Error(`unterminated value for ${key}`);
}

function sliceValue(lines, span) {
  const out = lines.slice(span[0], span[1] + 1);
  out[out.length - 1] = out[out.length - 1].replace(/,\s*$/, '');
  return out.join('\n');
}

export function render(sourcePath = SOURCE) {
  if (!existsSync(sourcePath)) {
    throw new Error(`no vendored vectors at ${sourcePath} — run: npm run vendor:seam -- --ref <tag>`);
  }
  const text = readFileSync(sourcePath, 'utf8');
  const lines = text.split('\n');
  const missing = SECTIONS.filter((k) => spanOf(lines, k, 2) === null);
  if (missing.length) {
    throw new Error(`wire_vectors.json no longer carries ${JSON.stringify(missing)} — either the section was renamed there or this list is stale; decide which`);
  }
  const rejectSpan = spanOf(lines, 'reject', 2);
  if (!rejectSpan) throw new Error('wire_vectors.json has no `reject`');
  const rejectLines = lines.slice(rejectSpan[0], rejectSpan[1] + 1);
  const absent = REJECT_KEYS.filter((k) => spanOf(rejectLines, k, 4) === null);
  if (absent.length) throw new Error(`wire_vectors.json \`reject\` no longer carries ${JSON.stringify(absent)}`);

  // THE COMPLEMENT CHECK. An allowlist can only ever be wrong in one direction quietly: a
  // group upstream adds and this file does not name is dropped without a word, and then no
  // loop can be written against it because the derived file has not got it. That is how
  // `reject.encoding`, `reject.keystate`, `reject.cardpub` and `reject.did` went missing.
  // So every group upstream carries must be accounted for by one list or the other, and
  // adding a group upstream now BREAKS THIS BUILD until somebody decides which it is.
  const upstreamRejectKeys = Object.keys(JSON.parse(text).reject);
  const unaccounted = upstreamRejectKeys.filter(
    (k) => !REJECT_KEYS.includes(k) && !REJECT_NOT_OURS.includes(k));
  if (unaccounted.length) {
    throw new Error(
      `wire_vectors.json \`reject\` carries ${JSON.stringify(unaccounted)}, which this script `
      + 'neither ships nor names as a node\'s. Add each to REJECT_KEYS (the door can drive it) '
      + 'or to REJECT_NOT_OURS (it belongs to a node) — silence is how four groups were '
      + 'already lost.');
  }

  const parts = [`  "note": ${JSON.stringify(NOTE)}`];
  for (const key of SECTIONS) parts.push(sliceValue(lines, spanOf(lines, key, 2)));
  const rejectBody = REJECT_KEYS.map((k) => sliceValue(rejectLines, spanOf(rejectLines, k, 4))).join(',\n');
  parts.push(`  "reject": {\n${rejectBody}\n  }`);
  const noteSpan = spanOf(lines, 'rejectNote', 2);
  if (noteSpan) parts.push(sliceValue(lines, noteSpan));
  const out = `{\n${parts.join(',\n')}\n}\n`;

  // Self-check: the splice must be well-formed JSON that selects exactly these keys, and every
  // selected section must equal the source's (as parsed values — the float distinction is
  // what the TEXT path preserves; the parse path only confirms nothing else moved).
  const parsed = JSON.parse(out);
  const src = JSON.parse(text);
  const wantKeys = ['note', ...SECTIONS, 'reject', ...(noteSpan ? ['rejectNote'] : [])];
  const gotKeys = Object.keys(parsed);
  if (JSON.stringify(gotKeys) !== JSON.stringify(wantKeys)) throw new Error(`key order drifted: ${gotKeys}`);
  for (const k of SECTIONS) {
    if (JSON.stringify(parsed[k]) !== JSON.stringify(src[k])) throw new Error(`section ${k} was not spliced faithfully`);
  }
  for (const k of REJECT_KEYS) {
    if (JSON.stringify(parsed.reject[k]) !== JSON.stringify(src.reject[k])) throw new Error(`reject.${k} was not spliced faithfully`);
  }
  return out;
}

export function build(sourcePath = SOURCE) {
  return JSON.parse(render(sourcePath));
}

function main() {
  const check = process.argv.includes('--check');
  let text;
  try {
    text = render();
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 2;
  }
  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
    if (current === text) {
      console.log(`ok: conformance/vectors.json is what vendor/agent-seam/wire_vectors.json derives (${text.length} chars)`);
      return 0;
    }
    console.error('conformance/vectors.json is STALE against vendor/agent-seam/wire_vectors.json — run: npm run build:vectors');
    return 1;
  }
  writeFileSync(OUT, text);
  console.log(`wrote conformance/vectors.json (${text.length} bytes) from ${SOURCE}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
