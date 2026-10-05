#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * conformance/builtin-claim-removed.mjs
 *
 * The door drops its built-in claim workflow, written before the implementation
 * (OSS-seams chain item 2 of 3, parent intake 20261005T115429Z). Red until the
 * removal lands. Item 1 gave the door a generic ownership proof seam
 * (createAgentEntry({ ownershipProof }), serve --proof-path/--proof-body; see
 * conformance/ownership-proof.mjs); with it in place the door no longer carries:
 *
 *   - the hard-coded claim path and its prefix (a /.well-known/ file whose name
 *     holds "claim", and a "<word>-claim=" proof line);
 *   - the `entry.claim` field: a declaration that still carries one is refused as
 *     an unknown entry key, and the entry key list no longer offers it;
 *   - the claimant flags (--address, --contact-name, --contact-email,
 *     --contact-phone on publish) and the "claimant" machinery behind them.
 *
 * None of these appears in the door, its README or its spec; the conformance
 * files carry no claim path, prefix or field (they name the claimant flags only
 * to prove them refused); and the door exports nothing that names or holds them. The CLI side
 * (publish --claim as a refusing deprecated alias) is pinned in conformance/cli.mjs,
 * and frame step 3 in conformance/frame.mjs. Nothing here dials anywhere.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SELF = basename(fileURLToPath(import.meta.url));
const SEED = 'cd'.repeat(32);

let passed = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${String(detail).slice(0, 400)}` : ''}`);
  return false;
}

async function section(name, fn) {
  try { await fn(); } catch (error) { check(false, `${name}/threw`, error?.stack || String(error)); }
}

const clone = (v) => JSON.parse(JSON.stringify(v));

// What the removed workflow looked like, named by shape only.
const GONE = [
  ['claim-path', /\/\.well-known\/[A-Za-z0-9._-]*claim[A-Za-z0-9._-]*/i],
  ['claim-prefix', /[a-z0-9]-claim=/i],
  ['entry-claim-field', /\bentry\??\.claim\b/],
  ['entry-claim-key-in-shape', /\bclaim\?\s*\}/],
  ['claimant-flag-address', /--address\b/],
  ['claimant-flag-contact', /--contact-(?:name|email|phone)\b/],
  ['claimant', /\bclaimant\b/i],
];

function files(dir, keep, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, keep, out);
    else if (keep(name)) out.push(p);
  }
  return out;
}

/** [file, patterns]: the door, README and spec carry none of it. The conformance files carry no
 *  claim path, prefix or field; they may still NAME the claimant flags, because the refusal cases
 *  in conformance/cli.mjs have to pass them to prove they are refused. */
function scanned() {
  const out = [join(ROOT, 'muretai-agent-entry.mjs'), join(ROOT, 'README.md')].map((p) => [p, GONE]);
  out.push(...files(join(ROOT, 'spec'), (n) => n.endsWith('.md')).map((p) => [p, GONE]));
  out.push(...files(HERE, (n) => /\.(mjs|json|md)$/.test(n) && n !== SELF).map((p) => [p, GONE.slice(0, 4)]));
  return out;
}

await section('source', async () => {
  const paths = scanned();
  check(paths.some(([p]) => p.endsWith('frame.mjs')) && paths.some(([p]) => p.endsWith('cli.mjs')),
    'source/scans-the-conformance-files', JSON.stringify(paths.map(([p]) => relative(ROOT, p)).slice(0, 10)));
  for (const [p, patterns] of paths) {
    const rel = relative(ROOT, p);
    const lines = readFileSync(p, 'utf8').split('\n');
    for (const [tag, re] of patterns) {
      const hits = lines.map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l));
      check(hits.length === 0, `source/${rel}/no-${tag}`,
        hits.slice(0, 3).map(([n, l]) => `${n}: ${l.trim().slice(0, 120)}`).join(' | '));
    }
  }
});

await section('exports', async () => {
  for (const [name, value] of Object.entries(door)) {
    check(!/claim/i.test(name), `exports/no-claim-export/${name}`);
    if (typeof value === 'string') {
      for (const [tag, re] of GONE.slice(0, 2)) {
        check(!re.test(value), `exports/${name}/holds-no-${tag}`, value.slice(0, 120));
      }
    }
  }
});

const DECL = JSON.parse(readFileSync(join(HERE, 'fixtures', 'cli', 'declaration-v1.json'), 'utf8'));

function refusal(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

await section('declaration', async () => {
  // Functional: the declaration without the field still validates and starts a door.
  check(refusal(() => door.validateDeclaration(clone(DECL))) === null, 'declaration/plain-still-validates');
  const plain = refusal(() => door.createAgentEntry({ seedHex: SEED, name: DECL.entry.name, baseUrl: DECL.entry.baseUrl,
    declaration: clone(DECL) }));
  check(plain === null, 'declaration/plain-still-starts-a-door', plain?.message);

  // Refusal: entry.claim is no longer a field, whatever its value.
  for (const [tag, value] of [['32-hex', '0123456789abcdef0fedcba987654321'], ['empty', ''], ['null', null], ['number', 7]]) {
    const decl = clone(DECL);
    decl.entry.claim = value;
    const e = refusal(() => door.validateDeclaration(decl));
    check(e !== null, `declaration/entry-claim-${tag}/refused`, 'validated');
    if (e) {
      check(/\bentry\b/.test(String(e.message)), `declaration/entry-claim-${tag}/names-entry`, e.message);
      check(!/32|hex/i.test(String(e.message)), `declaration/entry-claim-${tag}/not-checked-as-a-code`, e.message);
    }
    const started = refusal(() => door.createAgentEntry({ seedHex: SEED, name: DECL.entry.name, baseUrl: DECL.entry.baseUrl,
      declaration: clone(decl) }));
    check(started !== null, `declaration/entry-claim-${tag}/no-door-starts`, 'a door started from a declaration carrying entry.claim');
  }

  // Refusal: the refusal for an unknown entry key does not offer the field back.
  const decl = clone(DECL);
  decl.entry.notAKey = true;
  const e = refusal(() => door.validateDeclaration(decl));
  check(e !== null && !/\bclaim\b/.test(String(e.message)), 'declaration/unknown-key-refusal-does-not-list-claim',
    e ? e.message : 'validated');
});

if (failures.length) {
  console.error(`FAILED - ${failures.length} built-in claim removal check(s), ${passed} passed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} built-in claim removal checks`);
