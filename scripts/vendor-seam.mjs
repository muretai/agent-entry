#!/usr/bin/env node
/**
 * scripts/vendor-seam.mjs — take the seam from agent-seam at one commit, and pin it.
 *
 * The block between this door's `CANONICAL JSON` banner and its `reach-back through a relay`
 * banner is not this package's private code: it is the seam, the wire layer every
 * implementation of Agent Entry reproduces byte for byte, and its home is the agent-seam
 * repository. This door CARRIES a copy. This script is the only way that copy changes:
 *
 *   1. read agent-seam at --ref (a tag or commit; `main` if you say nothing) with `git show`,
 *      so what is on disk in that checkout does not matter, only what is committed;
 *   2. copy js/seam.mjs and the vector files its tools/manifest.json names into
 *      vendor/agent-seam/;
 *   3. splice seam.mjs's region (manifest `start`..`end`) over this door's block, and rewrite
 *      each pinned declaration (the wire constants, the error table, three helpers) in place,
 *      matched by NAME and replaced as a whole bracket-balanced unit;
 *   4. write vendor/agent-seam/VENDOR.json — the commit, the version, the date of that commit
 *      and the sha256 of every copied file as written;
 *   5. rebuild conformance/vectors.json from the vendored vectors.
 *
 * Nothing here writes outside this repository, and nothing here runs at test time:
 * conformance/seam-twin.mjs holds the door to vendor/agent-seam/ using only the digests in
 * VENDOR.json, so `npm test` needs no agent-seam checkout at all.
 *
 *   node scripts/vendor-seam.mjs --ref v0.2.0            # ../agent-seam, or $MURETAI_AGENT_SEAM
 *   node scripts/vendor-seam.mjs --from /path --ref <sha>
 *   node scripts/vendor-seam.mjs --ref v0.2.0 --dry-run  # say what would change, write nothing
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DOOR = join(ROOT, 'muretai-agent-entry.mjs');
const VENDOR = join(ROOT, 'vendor', 'agent-seam');
const REPOSITORY = 'https://github.com/muretai/agent-seam';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); const v = args[i + 1]; return i >= 0 && v && !v.startsWith('--') ? v : null; };
const from = resolve(ROOT, opt('--from') || process.env.MURETAI_AGENT_SEAM || '../agent-seam');
const ref = opt('--ref') || 'main';
const dry = args.includes('--dry-run');

const die = (msg) => { console.error(`error: ${msg}`); process.exit(2); };
if (!existsSync(join(from, 'tools', 'manifest.json'))) die(`no agent-seam checkout at ${from} (pass --from, or set MURETAI_AGENT_SEAM)`);
const git = (...a) => execFileSync('git', ['-C', from, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
let commit;
try { commit = git('rev-parse', '--verify', `${ref}^{commit}`).toString().trim(); } catch { die(`${ref} is not a commit in ${from}`); }
const show = (path) => { try { return git('show', `${commit}:${path}`); } catch { return die(`${ref} (${commit.slice(0, 7)}) has no ${path}`); } };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const date = git('show', '-s', '--format=%cs', commit).toString().trim();
const manifest = JSON.parse(show('tools/manifest.json').toString('utf8'));
const version = JSON.parse(show('package.json').toString('utf8')).version;
const dirty = git('status', '--porcelain').toString().trim();
if (dirty) console.log(`note: ${from} has uncommitted changes; they are NOT what is vendored — only ${commit.slice(0, 7)} is.`);

// ---- 1+2. the copies
const copies = [['js/seam.mjs', 'seam.mjs'], ...manifest.vectors.map((v) => [`vectors/${v}`, v])];
const files = {};
const staged = [];
for (const [source, local] of copies) {
  const bytes = show(source);
  files[`vendor/agent-seam/${local}`] = { source, sha256: sha256(bytes) };
  staged.push([join(VENDOR, local), bytes]);
}

// ---- 3. the door
const seam = show('js/seam.mjs').toString('utf8');
const seamLines = seam.split('\n');
const jr = manifest.jsRegion;
const one = (lines, re, what) => {
  const hits = lines.map((l, i) => (new RegExp(re).test(l) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) die(`${what}: expected exactly one line matching ${re}, found ${hits.length}`);
  return hits[0];
};
const sStart = one(seamLines, jr.start, 'seam.mjs');
const sEnd = one(seamLines, jr.end, 'seam.mjs');
const sMarker = one(seamLines, jr.pinnedMarker, 'seam.mjs');
const region = seamLines.slice(sStart, sEnd);
if (region.length < jr.minLines) die(`seam.mjs's region is ${region.length} lines, under the manifest's floor of ${jr.minLines}`);

const doorText = readFileSync(DOOR, 'utf8');
const doorLines = doorText.split('\n');
const dStart = one(doorLines, '^// =+ CANONICAL JSON$', 'the door');
const dEnd = one(doorLines, '^// =+ reach-back through a relay$', 'the door');
if (dEnd <= dStart) die('the door\'s banners are out of order');
const before = doorLines.slice(dStart, dEnd).join('\n');
const regionChanged = before !== region.join('\n');
const out = [...doorLines.slice(0, dStart), ...region, ...doorLines.slice(dEnd)];

const DECL = /^(?:export\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/;
function unitEnd(lines, i) {
  let depth = 0;
  for (let e = i; e < lines.length && e < i + 400; e += 1) {
    for (const ch of lines[e]) { if ('([{'.includes(ch)) depth += 1; else if (')]}'.includes(ch)) depth -= 1; }
    if (depth <= 0 && /[;}\]]\s*$/.test(lines[e])) return e;
  }
  return i;
}
const pinned = [];
for (let i = sMarker + 1; i < sStart; i += 1) {
  const m = DECL.exec(seamLines[i]);
  if (!m) continue;
  const e = unitEnd(seamLines, i);
  pinned.push({ name: m[1], text: seamLines.slice(i, e + 1).join('\n') });
  i = e;
}
if (pinned.map((p) => p.name).sort().join() !== [...jr.pinnedDeclarations].sort().join()) {
  die(`seam.mjs pins ${pinned.map((p) => p.name).join(', ')} but its manifest says ${jr.pinnedDeclarations.join(', ')}`);
}
const rewritten = [];
for (const p of pinned) {
  const hits = [];
  for (let i = 0; i < out.length; i += 1) {
    const m = DECL.exec(out[i]);
    if (m && m[1] === p.name) { hits.push([i, unitEnd(out, i)]); i = hits[hits.length - 1][1]; }
  }
  if (hits.length !== 1) die(`the door declares ${p.name} ${hits.length} times; exactly one is the pinned declaration`);
  const [a, b] = hits[0];
  if (out.slice(a, b + 1).join('\n') !== p.text) { out.splice(a, b - a + 1, ...p.text.split('\n')); rewritten.push(p.name); }
}
const newDoor = out.join('\n');
const doorChanged = newDoor !== doorText;

// ---- 4. the pin
const vendor = {
  _: 'Written by scripts/vendor-seam.mjs; do not edit by hand. conformance/seam-twin.mjs holds these copies to these digests, and holds the door\'s block and pinned declarations to vendor/agent-seam/seam.mjs, without any agent-seam checkout present.',
  from: 'agent-seam', repository: REPOSITORY, ref, commit, version, date, files,
};
const vendorText = `${JSON.stringify(vendor, null, 2)}\n`;

// ---- report, then write
console.log(`agent-seam ${ref} = ${commit.slice(0, 12)} (${version}, ${date}) from ${from}`);
for (const [p, v] of Object.entries(files)) console.log(`  ${p}  <-  ${v.source}  ${v.sha256.slice(0, 12)}`);
console.log(`  door block: ${regionChanged ? `REPLACED (${before.split('\n').length} -> ${region.length} lines)` : `unchanged (${region.length} lines)`}`);
console.log(`  pinned declarations: ${pinned.length} matched by name${rewritten.length ? `, rewritten: ${rewritten.join(', ')}` : ', all already identical'}`);
if (dry) { console.log('dry run: nothing written'); process.exit(0); }
mkdirSync(VENDOR, { recursive: true });
for (const [p, bytes] of staged) writeFileSync(p, bytes);
for (const f of readdirSync(VENDOR)) {
  if (f !== 'VENDOR.json' && !files[`vendor/agent-seam/${f}`]) console.log(`  note: vendor/agent-seam/${f} is not in this manifest — remove it, or the twin check will refuse it`);
}
writeFileSync(join(VENDOR, 'VENDOR.json'), vendorText);
if (doorChanged) writeFileSync(DOOR, newDoor);
console.log(`  wrote vendor/agent-seam/VENDOR.json${doorChanged ? ' and muretai-agent-entry.mjs' : ''}`);

// ---- 5. the derived subset
execFileSync(process.execPath, [join(HERE, 'build-vectors.mjs')], { stdio: 'inherit' });
console.log('next: npm test, then commit (the pin, the copies, the door and conformance/vectors.json together)');
