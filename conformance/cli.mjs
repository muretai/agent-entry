#!/usr/bin/env node
// Agent Entry Suite S3: the CLI verbs `init`, `publish` (alias `deploy`), `doctor`, `counts` on
// the existing `agent-entry` bin beside `knock`, and the exported `gaSink()`.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first pair). The authority is the owner-approved
// design (`agent-entry-suite-design.md` sections 4 and 5) and spec/tools-v1.md (AT-4 for the
// doctor warning, AT-10 for immutable versions, 3.1 for the sodium.json mapping), not the
// implementer. S1's API is used as landed and never redefined here.
//
// THE SUITE NEVER DIALS OUT. Every CLI child runs with fixtures/cli/loopback-only.mjs preloaded,
// which refuses (before DNS, before a packet) and records any socket to an address that is not
// this machine, and records every child process. The runner imports the same guard. `doctor
// --url` is only ever pointed at a door this runner starts on 127.0.0.1, or at 192.0.2.1
// (RFC 5737 TEST-NET-1, never routed) to prove it fails closed. gaSink is exercised against a
// stubbed fetch only.
//
// What is pinned (the CLI is `node muretai-agent-entry.mjs <verb> ...`, the package bin):
//   exit status   0 = done / every hard check passed, 1 = refused or a check FAILed, 2 = misuse.
//   --json        stdout is exactly one JSON document and nothing else.
//   seed slot     `AGENT_ENTRY_SEED_HEX=<64 hex>` in a file git ignores (the examples' name).
//   init [--from sodium.json] [--trade restaurant|retail|clinic|repair] [--name N] [--base-url U] [--json]
//                 -> { framework, trade, did, seed: { path } | null, route?, wrote: [paths] }
//                 framework in next-app | next-pages | nuxt | sveltekit | astro | vite | express
//                 | static (route "agent-entry-serverless") | wordpress (route "agent-entry-wordpress").
//                 Refuses (exit 1, stderr names .gitignore) when git would track the seed slot.
//   publish | deploy [--version N] [--json]  -> { version, hash }
//                 writes <static dir>/.well-known/agent-tools.json (canonical bytes),
//                 agent-tools.sig.json (the agenttools envelope) and agent-tools/v<n>.json.
//                 The static dir of a Vite project is public/. No --version: identical content
//                 is a no-op, changed content becomes max+1. A version whose published hash
//                 differs is refused (exit 1, naming it); a gap in the sequence is refused.
//   doctor [--url U] [--json]  -> { rows: [{ id, level: PASS|FAIL|WARN|INFO, label, detail }] }
//                 the receptor-check.mjs row shape. A site-added verb without `effect` is a WARN
//                 row naming the offer id and `effect` (AT-4), never a FAIL, never silence.
//                 Live: exactly one signed knock per door-bound offer (metadata.offer = its id,
//                 text ending with the offer's example input as a JSON object), none for a
//                 page-only offer; a reply kind unlike the declared one FAILs. Text mode prints
//                 the `agent-browser` webmcp list one-liner. No browser process is launched.
//   counts [--serve [--port P] [--host H]] --log <fileSink log> --store <createFileStore file> [--json]
//                 -> { offers: { <offer id>: { page_asked, door_asked, completed, receipts } },
//                      referrals: { <engine>: n }, returning_customers: n,
//                      knocks: { by_stage: { <stage>: n }, by_class: { <class>: n } } }
//                 --serve prints `http://127.0.0.1:<port>/` (or [::1]) and serves one HTML page;
//                 a non-loopback --host is refused.
//   fileSink(path)                        -> observer that appends the counts log (no DID, no text).
//   gaSink({ measurementId, apiSecret })  -> observer posting GA4 Measurement Protocol events with
//                 engagement_time_msec, session_id and typed dimensions only.
//   knock <card-url> [--offer <id or verb>]  (S6b-1) and knockAgentEntry(url, { offer }) -> the knock
//                 carries metadata.offer after sig; without it the POST body is byte for byte today's.
//   init --from woocommerce <store-url>  (Woo chain item 1) refuses, exit 1, each with its own
//                 reason on stderr and nothing written: a URL that is not https (before any
//                 request), a store whose /wp-json/wc/store/v1/products is absent or not JSON, and a
//                 first page past the byte bound. A well-formed in-bounds https store is not refused.
//   init --from woocommerce <store-url> [--facts <file>]  (Woo chain item 2) reads robots.txt and ONE
//                 Store API page, writes agent-entry.json with one `ask` offer answered from the facts
//                 (file, or prompted one per line); a facts file without the human contact
//                 (human_contact_name + human_contact_email|phone) is refused by name before any request.
//   init --from woocommerce <store-url> [--max-pages <n>] [--max-bytes <n>]  (Woo chain item 3) walks the
//                 Store API pages 1..n in order, each asked once, never past x-wp-totalpages, never off
//                 the store's host; --json -> { ..., products: <count over every page read>, pages: <n>,
//                 stopped: null | "page-bound" | "byte-bound" }: a bound that ends the walk is named.
//   init --from woocommerce <store-url>  (Woo chain item 5) also writes one door-bound `hold` offer answered
//                 `pending` with a receipt; the door's hold reply is pending_confirmation until the owner's
//                 confirmReceipt(seedHex, replyText) returns the follow-on that reads confirmed (section 11e).
//   doctor --from woocommerce [--json]  (Woo chain item 6) in the project `init --from woocommerce` wrote:
//                 knocks each door-bound offer of agent-entry.json at the door its entry.baseUrl names, and
//                 only there; one row per offer, id `offer.<offer id>`, PASS or FAIL, every offer checked
//                 even after one fails; never confirms a hold, never echoes a secret (section 11f).
//   publish --claim <32 lowercase hex>  (FRAME Claim-2) records the code in agent-entry.json, prints
//                 `_muretai-catalog.<host> TXT muretai-catalog-claim=<code>`, and the door serves
//                 GET /.well-known/muretai-catalog-claim.txt: 200 text/plain `muretai-catalog-claim=<code>`
//                 (no trailing newline), 404 without a code, GET in OPTIONS' Allow once claimed. Any
//                 other code is refused naming 32/hex, and nothing is written.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { guardLog, isLocalHost } from './fixtures/cli/loopback-only.mjs';
import { makeRuntimeTls } from './fixtures/cli/runtime-tls.mjs';
import * as door from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'muretai-agent-entry.mjs');
const FIX = join(HERE, 'fixtures', 'cli');
const GUARD = join(FIX, 'loopback-only.mjs');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const TREES = readJson(join(FIX, 'frameworks.json'));
const SODIUM_EXPECTED = readJson(join(FIX, 'sodium-offers.expected.json'));
const DECL_V1 = readJson(join(FIX, 'declaration-v1.json'));
const DECL_V1_CHANGED = readJson(join(FIX, 'declaration-v1-changed.json'));
const DOCTOR = readJson(join(FIX, 'doctor-declaration.json'));

const { AGENT_ENTRY_REL, OFFER_STARTERS, TOOLS_PATH, TOOLS_SIG_PATH, TOOLS_EVENTS_PATH, bodySignpost,
  canonicalJSON, compileDeclaration, createAgentEntry, createFileStore, didFromSeedHex, signEnvelope,
  validateDeclaration, verifyToolsEnvelope } = door;

const SEED_LINE = /AGENT_ENTRY_SEED_HEX\s*=\s*["']?([0-9a-f]{64})\b/;
const ANY_HEX64 = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/;
const BROWSER = /chrom|headless|puppeteer|playwright|msedge|firefox|webdriver/i;
const PUBLISH_SEED = 'e1'.repeat(32);
const DOCTOR_SEED = 'd0'.repeat(32);
const COUNTS_SEED = 'c7'.repeat(32);
const VISITOR_A = 'a1'.repeat(32);
const VISITOR_B = 'b2'.repeat(32);
const VISITOR_C = 'c3'.repeat(32);
const MARKER = 'Marker-Ada-4417 brass lamp';

let passed = 0;
const failures = [];
const scratch = [];

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${String(detail).slice(0, 600)}` : ''}`);
  return false;
}

/** One section; a throw inside it is a named failure, never the end of the run. */
async function section(name, fn) {
  try { await fn(); } catch (error) { check(false, `${name}/threw`, error?.stack || String(error)); }
}

function need(name) {
  const value = door[name];
  check(value !== undefined, `export/${name}`, 'not exported by muretai-agent-entry.mjs');
  return value;
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const sorted = (a) => JSON.stringify([...a].sort());

function tmp(prefix = 'ae-cli-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

// ---------------------------------------------------------------- child processes

function baseEnv(home) {
  const env = {};
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k];
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig-empty'),
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    AGENT_ENTRY_KNOCK_KEY: join(home, 'knock-seed'),
  };
}

const HOME = tmp('ae-cli-home-');
writeFileSync(join(HOME, '.gitconfig-empty'), '');

function git(cwd, args) {
  return spawnSync('git', args, { cwd, env: baseEnv(HOME), encoding: 'utf8' });
}

/** Run the bin with the loopback guard preloaded. Resolves { code, signal, stdout, stderr, guard }. */
function runCli(args, { cwd, env = {}, timeout = 60000 } = {}) {
  const log = join(tmp('ae-cli-guard-'), 'guard.jsonl');
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(GUARD).href, BIN, ...args], {
      cwd: cwd || tmp(), env: { ...baseEnv(HOME), ...env, AE_CLI_GUARD_LOG: log },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let guard = [];
      try { guard = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
      resolveRun({ code, signal, stdout, stderr, guard, timedOut });
    });
  });
}

/** Every child: the guard loaded, nothing tried to leave the machine, no browser started. */
function guardClean(label, run, { onlyPort = null } = {}) {
  check(run.guard.some((r) => r.kind === 'loaded'), `${label}/guard-loaded`, 'the loopback guard did not load');
  const blocked = run.guard.filter((r) => r.allowed === false);
  check(blocked.length === 0, `${label}/never-dials-out`, JSON.stringify(blocked.slice(0, 3)));
  const browsers = run.guard.filter((r) => r.kind === 'spawn' && BROWSER.test(`${r.command} ${r.args.join(' ')}`));
  check(browsers.length === 0, `${label}/no-browser-launched`, JSON.stringify(browsers.slice(0, 3)));
  check(!run.timedOut, `${label}/finished`, 'timed out');
  if (onlyPort !== null) {
    const elsewhere = run.guard.filter((r) => r.kind === 'connect' && r.port !== onlyPort);
    check(elsewhere.length === 0, `${label}/connects-only-to-the-fixture-door`, JSON.stringify(elsewhere.slice(0, 3)));
  }
}

function parseJsonOut(label, run) {
  try { return JSON.parse(run.stdout); } catch {
    check(false, `${label}/stdout-is-one-json-document`, `exit ${run.code}; stdout ${JSON.stringify(run.stdout.slice(0, 300))}; stderr ${JSON.stringify(run.stderr.slice(0, 300))}`);
    return null;
  }
}

// ---------------------------------------------------------------- fixture projects

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** A fixture tree as a committed git repository. */
function makeRepo(name, { gitignore, tracked = null, extra = {} } = {}) {
  const tree = TREES.frameworks[name];
  const dir = tmp(`ae-cli-${name}-`);
  writeFiles(dir, tree.files);
  const ignore = gitignore === undefined ? tree.gitignore : gitignore;
  if (ignore !== null) writeFileSync(join(dir, '.gitignore'), ignore);
  writeFiles(dir, extra);
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  if (tracked) {
    writeFiles(dir, tracked);
    git(dir, ['add', '-f', ...Object.keys(tracked)]);
  }
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return dir;
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, base, out);
    else if (st.size < 2 * 1024 * 1024) out.push(relative(base, p));
  }
  return out;
}

/** Paths git would track: tracked files plus untracked files no ignore rule covers. */
function trackable(dir) {
  const out = git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return out.stdout.split('\0').filter(Boolean).filter((p) => existsSync(join(dir, p)));
}

/** Trackable files that carry the seed, or any seed-shaped secret line. */
function seedLeaks(dir, seed = null) {
  const leaks = [];
  for (const rel of trackable(dir)) {
    let text = '';
    try { text = readFileSync(join(dir, rel), 'utf8'); } catch { continue; }
    if (SEED_LINE.test(text) || (seed && text.includes(seed))) leaks.push(rel);
  }
  return leaks;
}

/** Every file anywhere in the tree (ignored or not) carrying a seed line. */
function seedFilesAnywhere(dir) {
  return walk(dir).filter((rel) => {
    try { return SEED_LINE.test(readFileSync(join(dir, rel), 'utf8')); } catch { return false; }
  });
}

/** A Vite project with a known seed in an ignored .env and a declaration already written. */
function makePublishProject(declaration, { seed = PUBLISH_SEED, withSeed = true } = {}) {
  const extra = { 'agent-entry.json': `${JSON.stringify(declaration, null, 2)}\n` };
  const dir = makeRepo('vite', { extra });
  if (withSeed) writeFileSync(join(dir, '.env'), `AGENT_ENTRY_SEED_HEX=${seed}\n`);
  return dir;
}

const WELL_KNOWN = (dir) => join(dir, 'public', '.well-known');

function snapshot(dir) {
  const root = WELL_KNOWN(dir);
  if (!existsSync(root)) return {};
  const out = {};
  for (const rel of walk(root)) out[rel] = readFileSync(join(root, rel), 'utf8');
  return out;
}

const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const rowText = (r) => `${r.id} ${r.label} ${r.detail}`;

// ---------------------------------------------------------------- 1. init, per framework

const DIRECT = ['next-app', 'next-pages', 'nuxt', 'sveltekit', 'astro', 'vite', 'express'];

await section('init', async () => {
  for (const name of DIRECT) {
    const tree = TREES.frameworks[name];
    const label = `init/${name}`;
    const dir = makeRepo(name);
    const displayName = `Harbor ${name}`;
    const baseUrl = `https://${name}.example`;
    const run = await runCli(['init', '--json', '--trade', tree.trade, '--name', displayName,
      '--base-url', baseUrl], { cwd: dir });
    guardClean(label, run);
    if (!check(run.code === 0, `${label}/exit-0`, `exit ${run.code}: ${run.stderr}`)) continue;
    const out = parseJsonOut(label, run);
    if (!out) continue;
    check(out.framework === tree.expect.framework, `${label}/detects-${tree.expect.framework}`, JSON.stringify(out.framework));
    check(out.trade === tree.trade, `${label}/trade-${tree.trade}`, JSON.stringify(out.trade));
    check(Array.isArray(out.wrote) && out.wrote.length > 0 && out.wrote.every((p) => typeof p === 'string'
      && !p.startsWith('/') && existsSync(join(dir, p))), `${label}/wrote-lists-relative-paths-that-exist`, JSON.stringify(out.wrote));

    // The seed: minted locally, in the platform's slot, where git will not track it.
    const seedPath = out.seed?.path;
    const seedText = typeof seedPath === 'string' ? readText(join(dir, seedPath)) : null;
    const seed = seedText?.match(SEED_LINE)?.[1] ?? null;
    if (check(seed !== null, `${label}/seed-minted-as-AGENT_ENTRY_SEED_HEX`, `seed.path ${JSON.stringify(seedPath)}`)) {
      check(git(dir, ['check-ignore', '-q', seedPath]).status === 0, `${label}/seed-slot-is-git-ignored`, seedPath);
      check(git(dir, ['ls-files', '--error-unmatch', seedPath]).status !== 0, `${label}/seed-slot-is-not-tracked`, seedPath);
      check((statSync(join(dir, seedPath)).mode & 0o077) === 0, `${label}/seed-slot-mode-0600`,
        (statSync(join(dir, seedPath)).mode & 0o777).toString(8));
      check(seedLeaks(dir, seed).length === 0, `${label}/no-trackable-file-carries-the-seed`, JSON.stringify(seedLeaks(dir, seed)));
      check(seed !== PUBLISH_SEED && seed !== DOCTOR_SEED && !/^(..)\1+$/.test(seed), `${label}/seed-is-fresh-random`);
      check(out.did === didFromSeedHex(seed), `${label}/reports-the-did-of-the-minted-seed`, JSON.stringify(out.did));
      check(!run.stdout.includes(seed) && !run.stderr.includes(seed), `${label}/seed-never-printed`);
    }

    // agent-entry.json: entry filled, the trade's starters from OFFER_STARTERS, valid.
    const declText = readText(join(dir, 'agent-entry.json'));
    let decl = null;
    try { decl = JSON.parse(declText); } catch { /* reported below */ }
    if (check(decl !== null, `${label}/writes-agent-entry.json`)) {
      let valid = true;
      try { validateDeclaration(decl); } catch (e) { valid = false; check(false, `${label}/declaration-validates`, e.message); }
      if (valid) passed += 1;
      check(decl.entry?.name === displayName && decl.entry?.baseUrl === baseUrl, `${label}/entry-filled`, JSON.stringify(decl.entry));
      check(JSON.stringify(decl.offers) === JSON.stringify(OFFER_STARTERS[tree.trade]),
        `${label}/offers-are-the-${tree.trade}-starters`, JSON.stringify(decl.offers?.map((o) => `${o.verb}_${o.of}`)));
      check(!ANY_HEX64.test(declText), `${label}/declaration-holds-no-secret`);
    }

    // The coding agent's skill.
    const skill = readText(join(dir, '.agents', 'skills', 'agent-entry', 'SKILL.md'));
    if (check(skill !== null, `${label}/writes-SKILL.md`)) {
      check(/^---\n[\s\S]*?\bname:\s*agent-entry\s*\n[\s\S]*?\bdescription:\s*\S[\s\S]*?\n---\n/.test(skill),
        `${label}/SKILL.md-frontmatter-name-and-description`, skill.slice(0, 200));
      check(skill.includes('agent-entry.json') && skill.includes('page'), `${label}/SKILL.md-names-the-declaration-and-page-bindings`);
      check(!ANY_HEX64.test(skill), `${label}/SKILL.md-holds-no-secret`);
    }

    // Wiring: the three door routes, the three signposts (bodySignpost reused), the page tag.
    const skip = new Set(['agent-entry.json', join('.agents', 'skills', 'agent-entry', 'SKILL.md'), seedPath]);
    // What init added or changed: new files outside the three above, and edited fixture files.
    const touched = (rel) => (Object.hasOwn(tree.files, rel)
      ? readFileSync(join(dir, rel), 'utf8') !== tree.files[rel]
      : !skip.has(rel) && rel !== '.gitignore');
    const wired = walk(dir).filter(touched).map((rel) => readFileSync(join(dir, rel), 'utf8'));
    const any = (fn) => wired.some(fn);
    check(any((t) => t.includes('agent-entry-page.mjs')), `${label}/wires-the-page-runtime-tag`);
    check(any((t) => t.includes('createAgentEntry') || (t.includes('agent-card.json') && t.includes('agent-card.sig.json'))),
      `${label}/wires-the-three-door-routes`);
    check(any((t) => t.includes('bodySignpost') || t.includes(bodySignpost())), `${label}/wires-the-body-signpost-via-bodySignpost`);
    check(any((t) => t.includes(AGENT_ENTRY_REL)), `${label}/wires-the-link-signposts`);
    check(!wired.some((t) => SEED_LINE.test(t) || (seed && t.includes(seed))), `${label}/wired-code-reads-the-seed-never-embeds-it`);

    // A second init never rotates the key (a new seed is a new DID: every visitor's memory lost).
    if (seed) {
      const again = await runCli(['init', '--json', '--trade', tree.trade, '--name', displayName, '--base-url', baseUrl], { cwd: dir });
      guardClean(`${label}/rerun`, again);
      const after = readText(join(dir, seedPath))?.match(SEED_LINE)?.[1] ?? null;
      check(after === seed, `${label}/rerun-keeps-the-seed`, after === null ? 'seed gone' : 'seed rotated');
      check(seedFilesAnywhere(dir).length === 1, `${label}/rerun-mints-no-second-seed`, JSON.stringify(seedFilesAnywhere(dir)));
    }

    // The installed project publishes, and the local doctor passes on it.
    const pub = await runCli(['publish', '--json'], { cwd: dir });
    guardClean(`${label}/publish`, pub);
    if (check(pub.code === 0, `${label}/publish-exit-0`, pub.stderr)) {
      const doc = await runCli(['doctor', '--json'], { cwd: dir });
      guardClean(`${label}/doctor`, doc);
      const report = parseJsonOut(`${label}/doctor`, doc);
      const fails = (report?.rows || []).filter((r) => r.level === 'FAIL');
      check(doc.code === 0 && fails.length === 0, `${label}/doctor-local-passes-after-init-and-publish`,
        `exit ${doc.code}; ${JSON.stringify(fails.slice(0, 3))}`);
    }
  }

  // Static host and WordPress: routed to the product that serves them.
  for (const name of ['static', 'wordpress']) {
    const tree = TREES.frameworks[name];
    const label = `init/${name}`;
    const dir = makeRepo(name);
    const run = await runCli(['init', '--json', '--trade', tree.trade, '--name', `Harbor ${name}`,
      '--base-url', `https://${name}.example`], { cwd: dir });
    guardClean(label, run);
    if (!check(run.code === 0, `${label}/exit-0`, `exit ${run.code}: ${run.stderr}`)) continue;
    const out = parseJsonOut(label, run);
    if (!out) continue;
    check(out.framework === tree.expect.framework, `${label}/detects-${tree.expect.framework}`, JSON.stringify(out.framework));
    check(out.route === tree.expect.route, `${label}/routes-to-${tree.expect.route}`, JSON.stringify(out.route));
    check(seedLeaks(dir).length === 0, `${label}/no-trackable-file-carries-a-seed`, JSON.stringify(seedLeaks(dir)));
  }

  // Misuse.
  const bad = await runCli(['init', '--json', '--trade', 'casino'], { cwd: makeRepo('vite') });
  check(bad.code === 2, 'init/unknown-trade-exit-2', `exit ${bad.code}`);
});

// ---------------------------------------------------------------- 2. R1: never a trackable seed

await section('r1', async () => {
  const base = TREES.r1.base;
  for (const [caseName, spec] of Object.entries(TREES.r1.cases)) {
    const label = `r1/${caseName}`;
    const dir = makeRepo(base, { gitignore: spec.gitignore, tracked: spec.tracked || null });
    const before = readText(join(dir, '.gitignore'));
    const run = await runCli(['init', '--json', '--trade', 'retail', '--name', 'Harbor Lamp',
      '--base-url', 'https://shop.example'], { cwd: dir });
    guardClean(label, run);
    check(run.code === 1, `${label}/init-refuses-exit-1`, `exit ${run.code}; stdout ${run.stdout.slice(0, 200)}`);
    check(/\.gitignore|tracked/i.test(run.stderr), `${label}/refusal-names-the-gitignore-or-tracking`, JSON.stringify(run.stderr.slice(0, 300)));
    check(seedLeaks(dir).length === 0, `${label}/no-seed-reaches-a-trackable-path`, JSON.stringify(seedLeaks(dir)));
    check(seedFilesAnywhere(dir).length === 0, `${label}/no-seed-written-at-all`, JSON.stringify(seedFilesAnywhere(dir)));
    check(readText(join(dir, '.gitignore')) === before, `${label}/gitignore-not-silently-rewritten`);
    if (spec.tracked) {
      for (const [rel, content] of Object.entries(spec.tracked)) {
        check(readText(join(dir, rel)) === content, `${label}/tracked-${rel}-untouched`);
      }
    }
  }
});

// ---------------------------------------------------------------- 3. init --from sodium.json

await section('from-sodium', async () => {
  const label = 'from-sodium';
  const dir = makeRepo('vite', { extra: { 'sodium.json': readFileSync(join(FIX, 'sodium.json'), 'utf8') } });
  const run = await runCli(['init', '--json', '--from', 'sodium.json', '--base-url', 'https://shop.example'], { cwd: dir });
  guardClean(label, run);
  if (check(run.code === 0, `${label}/exit-0`, `exit ${run.code}: ${run.stderr}`)) {
    let decl = null;
    try { decl = JSON.parse(readFileSync(join(dir, 'agent-entry.json'), 'utf8')); } catch { /* below */ }
    if (check(decl !== null, `${label}/writes-agent-entry.json`)) {
      try { validateDeclaration(decl); passed += 1; } catch (e) { check(false, `${label}/declaration-validates`, e.message); }
      check(decl.entry?.name === SODIUM_EXPECTED.entry_name && decl.entry?.baseUrl === 'https://shop.example',
        `${label}/entry-from-app-name`, JSON.stringify(decl.entry));
      check(JSON.stringify(decl.offers) === JSON.stringify(SODIUM_EXPECTED.offers), `${label}/offers-exactly-mapped`,
        JSON.stringify(decl.offers));
      check(Array.isArray(decl.offers) && decl.offers.every((o) => !Object.hasOwn(o, 'door') && o.page),
        `${label}/page-filled-door-left-empty`);
    }
  }

  // A tool with no v1 equivalent (interaction steps) refuses the whole file, naming the tool.
  const sodium = readJson(join(FIX, 'sodium.json'));
  sodium.tools.push({ id: 'compare_lamps', name: 'compare_lamps', description: 'Compare two lamps.',
    input: {}, on: ['/shop/**'], run: { type: 'interaction', steps: [{ click: '#compare' }] }, risk: 'read_only' });
  const dir2 = makeRepo('vite', { extra: { 'sodium.json': `${JSON.stringify(sodium, null, 2)}\n` } });
  const refused = await runCli(['init', '--json', '--from', 'sodium.json', '--base-url', 'https://shop.example'], { cwd: dir2 });
  guardClean(`${label}/steps`, refused);
  check(refused.code === 1, `${label}/steps-refused-exit-1`, `exit ${refused.code}`);
  check(refused.stderr.includes('compare_lamps'), `${label}/steps-refusal-names-the-tool`, refused.stderr.slice(0, 300));
  check(!existsSync(join(dir2, 'agent-entry.json')), `${label}/steps-refusal-writes-no-partial-declaration`);

  const missing = await runCli(['init', '--json', '--from', 'nope.json'], { cwd: makeRepo('vite') });
  check(missing.code === 1 || missing.code === 2, `${label}/missing-file-refused`, `exit ${missing.code}`);
});

// ---------------------------------------------------------------- 4. publish / deploy, R3

await section('publish', async () => {
  const did = didFromSeedHex(PUBLISH_SEED);
  const origin = 'https://shop.example';
  const c1 = compileDeclaration(clone(DECL_V1), { version: 1 });
  const c2 = compileDeclaration(clone(DECL_V1_CHANGED), { version: 2 });

  for (const verb of ['publish', 'deploy']) {
    const label = `publish/${verb}`;
    const dir = makePublishProject(DECL_V1);
    const run = await runCli([verb, '--json'], { cwd: dir });
    guardClean(label, run);
    if (!check(run.code === 0, `${label}/v1-exit-0`, `exit ${run.code}: ${run.stderr}`)) continue;
    const out = parseJsonOut(label, run);
    check(out?.version === 1 && out?.hash === c1.hash, `${label}/reports-version-and-hash`, JSON.stringify(out));
    const wk = WELL_KNOWN(dir);
    check(readText(join(wk, 'agent-tools.json')) === canonicalJSON(c1), `${label}/current-contract-canonical-bytes`);
    check(readText(join(wk, 'agent-tools', 'v1.json')) === canonicalJSON(c1), `${label}/v1-file-canonical-bytes`);
    let env = null;
    try { env = JSON.parse(readText(join(wk, 'agent-tools.sig.json'))); } catch { /* below */ }
    const verified = env ? verifyToolsEnvelope(env, did, { origin }) : null;
    check(verified !== null && verified.hash === c1.hash, `${label}/sig-verifies-under-the-site-did-and-origin`);
    check(env?.typ === 'agenttools' && Number.isSafeInteger(env?.ts) && Math.abs(env.ts - Date.now() / 1000) < 600,
      `${label}/sig-envelope-typ-and-fresh-ts`, JSON.stringify({ typ: env?.typ, ts: env?.ts }));
    check(!Object.values(snapshot(dir)).some((t) => t.includes(PUBLISH_SEED)), `${label}/seed-never-published`);
    if (verb === 'deploy') continue;

    // Identical content: allowed, and no new version.
    const same = await runCli(['publish', '--json'], { cwd: dir });
    guardClean(`${label}/identical`, same);
    check(same.code === 0, `${label}/identical-republish-allowed`, `exit ${same.code}: ${same.stderr}`);
    check(!existsSync(join(wk, 'agent-tools', 'v2.json')), `${label}/identical-republish-bumps-nothing`);
    check(readText(join(wk, 'agent-tools.json')) === canonicalJSON(c1), `${label}/identical-republish-keeps-v1-current`);

    // Changed content: bumps to v2, v1 byte for byte as first published.
    writeFileSync(join(dir, 'agent-entry.json'), JSON.stringify(DECL_V1_CHANGED, null, 2));
    const bumped = await runCli(['publish', '--json'], { cwd: dir });
    guardClean(`${label}/bump`, bumped);
    const bout = parseJsonOut(`${label}/bump`, bumped);
    check(bumped.code === 0 && bout?.version === 2 && bout?.hash === c2.hash, `${label}/changed-content-bumps-to-v2`,
      `exit ${bumped.code}: ${JSON.stringify(bout)} ${bumped.stderr}`);
    check(readText(join(wk, 'agent-tools.json')) === canonicalJSON(c2), `${label}/v2-is-current`);
    check(readText(join(wk, 'agent-tools', 'v2.json')) === canonicalJSON(c2), `${label}/v2-file-canonical-bytes`);
    check(readText(join(wk, 'agent-tools', 'v1.json')) === canonicalJSON(c1), `${label}/v1-kept-byte-for-byte`);
    let env2 = null;
    try { env2 = JSON.parse(readText(join(wk, 'agent-tools.sig.json'))); } catch { /* below */ }
    check(env2 && verifyToolsEnvelope(env2, did, { origin })?.version === 2, `${label}/sig-covers-v2`);

    // A door started from what publish wrote accepts it as its history (AT-10).
    const history = [JSON.parse(readText(join(wk, 'agent-tools', 'v1.json')))];
    let started = true;
    try {
      createAgentEntry({ seedHex: PUBLISH_SEED, name: 'Harbor Lamp', baseUrl: origin,
        declaration: clone(DECL_V1_CHANGED), toolsHistory: history });
    } catch (e) { started = false; check(false, `${label}/door-accepts-published-history`, e.message); }
    if (started) passed += 1;
  }

  // R3: a published version is immutable; changed content under its number is refused.
  {
    const label = 'r3';
    const dir = makePublishProject(DECL_V1);
    const first = await runCli(['publish', '--version', '1', '--json'], { cwd: dir });
    guardClean(`${label}/first`, first);
    check(first.code === 0, `${label}/publish-v1`, `exit ${first.code}: ${first.stderr}`);
    const before = snapshot(dir);
    const again = await runCli(['publish', '--version', '1', '--json'], { cwd: dir });
    check(again.code === 0, `${label}/identical-content-same-version-allowed`, `exit ${again.code}: ${again.stderr}`);
    writeFileSync(join(dir, 'agent-entry.json'), JSON.stringify(DECL_V1_CHANGED, null, 2));
    const mid = snapshot(dir);
    const refused = await runCli(['publish', '--version', '1', '--json'], { cwd: dir });
    guardClean(`${label}/refused`, refused);
    check(refused.code === 1, `${label}/changed-content-same-version-refused-exit-1`, `exit ${refused.code}`);
    check(/\bv1\b|version 1\b/i.test(refused.stderr), `${label}/refusal-names-the-conflicting-version`, refused.stderr.slice(0, 300));
    check(JSON.stringify(snapshot(dir)) === JSON.stringify(mid), `${label}/refusal-writes-nothing`);
    check(readText(join(WELL_KNOWN(dir), 'agent-tools', 'v1.json')) === before['agent-tools/v1.json'], `${label}/v1-untouched`);

    const gap = await runCli(['publish', '--version', '3', '--json'], { cwd: dir });
    check(gap.code === 1 && !existsSync(join(WELL_KNOWN(dir), 'agent-tools', 'v3.json')), `${label}/gap-in-sequence-refused`,
      `exit ${gap.code}`);

    // A prior version edited on disk fails its own hash: publish will not build on it.
    const v1Path = join(WELL_KNOWN(dir), 'agent-tools', 'v1.json');
    if (check(existsSync(v1Path), `${label}/v1-file-exists`)) {
      writeFileSync(v1Path, readText(v1Path).replace('Harbor Lamp', 'Harbor Lamps'));
      const forged = await runCli(['publish', '--json'], { cwd: dir });
      check(forged.code === 1 && !existsSync(join(WELL_KNOWN(dir), 'agent-tools', 'v2.json')),
        `${label}/tampered-prior-version-refused`, `exit ${forged.code}`);
    }
  }

  // Refusals that write nothing.
  {
    const bad = clone(DECL_V1);
    bad.offers[1].efect = 'changes';
    const dir = makePublishProject(bad);
    const run = await runCli(['publish', '--json'], { cwd: dir });
    guardClean('publish/invalid', run);
    check(run.code === 1 && run.stderr.includes('efect'), 'publish/invalid-declaration-refused-naming-the-field',
      `exit ${run.code}: ${run.stderr.slice(0, 200)}`);
    check(!existsSync(WELL_KNOWN(dir)), 'publish/invalid-declaration-writes-nothing');

    const noSeed = makePublishProject(DECL_V1, { withSeed: false });
    const run2 = await runCli(['publish', '--json'], { cwd: noSeed });
    check(run2.code === 1 && !existsSync(WELL_KNOWN(noSeed)), 'publish/missing-seed-refused-writes-nothing', `exit ${run2.code}`);
  }
});

// ---------------------------------------------------------------- 5. doctor, local

await section('doctor-local', async () => {
  const label = 'doctor-local';
  const dir = makeRepo('vite');
  const init = await runCli(['init', '--json', '--trade', 'retail', '--name', 'Harbor Lamp', '--base-url', 'https://shop.example'], { cwd: dir });
  const seedPath = parseJsonOut(`${label}/init`, init)?.seed?.path;
  const pub = await runCli(['publish', '--json'], { cwd: dir });
  if (!check(init.code === 0 && pub.code === 0 && typeof seedPath === 'string', `${label}/setup-init-and-publish`,
    `${init.stderr} ${pub.stderr}`)) return;

  const doctor = async (tag) => {
    const run = await runCli(['doctor', '--json'], { cwd: dir });
    guardClean(`${label}/${tag}`, run);
    return { run, rows: parseJsonOut(`${label}/${tag}`, run)?.rows || [] };
  };
  const rowShape = (rows) => rows.length > 0 && rows.every((r) => typeof r.id === 'string' && typeof r.label === 'string'
    && ['PASS', 'FAIL', 'WARN', 'INFO'].includes(r.level) && typeof r.detail === 'string');

  const clean = await doctor('clean');
  check(clean.run.code === 0 && rowShape(clean.rows) && !clean.rows.some((r) => r.level === 'FAIL'), `${label}/clean-passes`,
    `exit ${clean.run.code}`);
  check(!clean.rows.some((r) => r.level === 'WARN' && /effect/.test(rowText(r))), `${label}/registry-verbs-draw-no-effect-warning`);

  // R2 (AT-4): a site-added verb without `effect` -> a WARN naming it, not a FAIL, not silence.
  const decl = JSON.parse(readFileSync(join(dir, 'agent-entry.json'), 'utf8'));
  writeFileSync(join(dir, 'agent-entry.json'), JSON.stringify({ ...decl, offers: [...decl.offers, clone(DOCTOR.site_verb_without_effect)] }, null, 2));
  check((await runCli(['publish', '--json'], { cwd: dir })).code === 0, `${label}/r2-publish-site-verb`);
  const warned = await doctor('r2-no-effect');
  const warn = warned.rows.filter((r) => r.level === 'WARN' && rowText(r).includes('rent_bike') && /effect/.test(rowText(r)));
  check(warn.length >= 1, 'r2/local-site-verb-without-effect-warns', JSON.stringify(warned.rows.filter((r) => r.level !== 'PASS')));
  check(!warned.rows.some((r) => r.level === 'FAIL'), 'r2/local-the-warning-is-not-an-error');
  check(warned.run.code === 0, 'r2/local-warning-keeps-exit-0', `exit ${warned.run.code}`);
  check(!warned.rows.some((r) => r.level === 'WARN' && /effect/.test(rowText(r)) && /hold_item|find_products|buy_order/.test(rowText(r))),
    'r2/local-only-the-site-verb-is-named');

  writeFileSync(join(dir, 'agent-entry.json'), JSON.stringify({ ...decl, offers: [...decl.offers, clone(DOCTOR.site_verb_with_effect)] }, null, 2));
  check((await runCli(['publish', '--json'], { cwd: dir })).code === 0, `${label}/r2-publish-site-verb-with-effect`);
  const declared = await doctor('r2-with-effect');
  check(!declared.rows.some((r) => r.level === 'WARN' && rowText(r).includes('rent_bike')) && declared.run.code === 0,
    'r2/local-site-verb-with-effect-draws-no-warning');

  // The contract on disk no longer verifies.
  const current = join(WELL_KNOWN(dir), 'agent-tools.sig.json');
  const saved = readFileSync(current, 'utf8');
  const env = JSON.parse(saved);
  env.contract.name = 'Harbor Lamp (forged)';
  writeFileSync(current, JSON.stringify(env));
  const forged = await doctor('forged');
  check(forged.run.code === 1 && forged.rows.some((r) => r.level === 'FAIL'), `${label}/contract-that-does-not-verify-fails`,
    `exit ${forged.run.code}`);
  writeFileSync(current, saved);

  // The seed is missing.
  renameSync(join(dir, seedPath), join(dir, `${seedPath}.away`));
  const missing = await doctor('seed-missing');
  check(missing.run.code === 1 && missing.rows.some((r) => r.level === 'FAIL'), `${label}/missing-seed-fails`, `exit ${missing.run.code}`);
  renameSync(join(dir, `${seedPath}.away`), join(dir, seedPath));

  // The seed is committed.
  git(dir, ['add', '-f', seedPath]);
  git(dir, ['commit', '-q', '-m', 'oops']);
  const committed = await doctor('seed-committed');
  check(committed.run.code === 1 && committed.rows.some((r) => r.level === 'FAIL' && /seed|secret|commit/i.test(rowText(r))),
    `${label}/committed-seed-fails`, `exit ${committed.run.code}`);
  check(!committed.run.stdout.includes(readFileSync(join(dir, seedPath), 'utf8').match(SEED_LINE)?.[1] ?? '\0'),
    `${label}/committed-seed-never-printed`);

  // An unwired project: agent-entry.json but no routes or tag.
  const bare = makePublishProject(DECL_V1);
  check((await runCli(['publish', '--json'], { cwd: bare })).code === 0, `${label}/bare-publish`);
  const run = await runCli(['doctor', '--json'], { cwd: bare });
  check(run.code === 1, `${label}/unwired-routes-and-tag-fail`, `exit ${run.code}`);
});

// ---------------------------------------------------------------- 6. doctor --url, live, R2, R4

function startFixtureServer() {
  return new Promise((resolveStart) => {
    const state = { handler: null, posts: [] };
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const path = req.url.split('?')[0];
        if (req.method === 'POST' && path === '/') state.posts.push(body.toString('utf8'));
        try {
          const out = await state.handler(req.method, req.url, req.headers, body, { remoteAddress: req.socket.remoteAddress });
          res.writeHead(out.status, out.headers || {});
          res.end(out.body || '');
        } catch (e) {
          res.writeHead(500);
          res.end(String(e?.message || e));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({ server, port, origin: `http://127.0.0.1:${port}`, state });
    });
  });
}

function doctorDeclaration(origin, extraOffers = [], patch = null) {
  const d = clone(DOCTOR.declaration);
  d.entry.baseUrl = origin;
  d.offers.push(...clone(extraOffers));
  if (patch) patch(d);
  return d;
}

function liveDoor(declaration) {
  return createAgentEntry({ seedHex: DOCTOR_SEED, name: declaration.entry.name, baseUrl: declaration.entry.baseUrl,
    declaration, signedRatePerMin: 0, signedRatePerMinTotal: 0 });
}

function knocksOf(posts) {
  return posts.map((raw) => {
    try {
      const m = JSON.parse(raw).params.message;
      return { offer: m.metadata?.offer, text: m.parts?.[0]?.text ?? '', signed: Boolean(m.metadata?.sig && m.metadata?.from) };
    } catch { return { offer: null, text: '', signed: false }; }
  });
}

function trailingObject(text) {
  const at = text.indexOf('{');
  for (let i = at; i !== -1; i = text.indexOf('{', i + 1)) {
    try { const v = JSON.parse(text.slice(i)); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* next */ }
  }
  return null;
}

await section('doctor-live', async () => {
  const fx = await startFixtureServer();
  try {
    const decl = doctorDeclaration(fx.origin);
    const entry = liveDoor(decl);
    fx.state.handler = (...a) => entry.handleRequestAsync(...a);
    const doorBound = decl.offers.filter((o) => o.door).map((o) => `${o.verb}_${o.of}`);
    const inputs = Object.fromEntries(decl.offers.map((o) => [`${o.verb}_${o.of}`, Object.keys(o.input)]));

    // Clean live run.
    fx.state.posts = [];
    const run = await runCli(['doctor', '--url', fx.origin, '--json']);
    guardClean('doctor-live/clean', run, { onlyPort: fx.port });
    const rows = parseJsonOut('doctor-live/clean', run)?.rows || [];
    check(run.code === 0 && !rows.some((r) => r.level === 'FAIL'), 'doctor-live/clean-door-passes',
      `exit ${run.code}; ${JSON.stringify(rows.filter((r) => r.level === 'FAIL').slice(0, 3))}`);
    const knocks = knocksOf(fx.state.posts);
    check(knocks.length === doorBound.length, 'doctor-live/exactly-one-knock-per-door-bound-offer',
      `${knocks.length} knocks for ${doorBound.length} offers: ${JSON.stringify(knocks.map((k) => k.offer))}`);
    check(sorted(knocks.map((k) => k.offer)) === sorted(doorBound), 'doctor-live/each-door-bound-offer-knocked-by-id',
      JSON.stringify(knocks.map((k) => k.offer)));
    check(!knocks.some((k) => k.offer === 'track_order'), 'doctor-live/page-only-offer-not-knocked');
    check(knocks.every((k) => k.signed), 'doctor-live/knocks-are-signed');
    for (const k of knocks) {
      const keys = inputs[k.offer] || [];
      if (!keys.length) continue;
      const obj = trailingObject(k.text);
      check(obj !== null && sorted(Object.keys(obj)) === sorted(keys), `doctor-live/${k.offer}-knock-carries-its-example-input`,
        JSON.stringify(k.text));
    }
    check(!rows.some((r) => r.level === 'WARN' && /effect/.test(rowText(r))), 'doctor-live/registry-verbs-draw-no-effect-warning');
    check(!/"?score"?\s*[:=]/i.test(run.stdout), 'doctor-live/site-checker-facts-no-score');

    // Text mode: the agent-browser one-liner, still one knock each.
    fx.state.posts = [];
    const text = await runCli(['doctor', '--url', fx.origin]);
    guardClean('doctor-live/text', text, { onlyPort: fx.port });
    check(text.code === 0, 'doctor-live/text-mode-exit-0', `exit ${text.code}: ${text.stderr.slice(0, 300)}`);
    check(text.stdout.split('\n').some((l) => l.includes('agent-browser') && /webmcp/i.test(l)),
      'doctor-live/prints-the-agent-browser-webmcp-one-liner', text.stdout.slice(-400));
    check(fx.state.posts.length === doorBound.length, 'doctor-live/text-mode-one-knock-per-offer', String(fx.state.posts.length));

    // R2 live: a site-added verb without `effect` warns; with `effect` it does not.
    for (const [tag, offer, expectWarn] of [['no-effect', DOCTOR.site_verb_without_effect, true],
      ['with-effect', DOCTOR.site_verb_with_effect, false]]) {
      const e2 = liveDoor(doctorDeclaration(fx.origin, [offer]));
      fx.state.handler = (...a) => e2.handleRequestAsync(...a);
      fx.state.posts = [];
      const r2 = await runCli(['doctor', '--url', fx.origin, '--json']);
      guardClean(`r2/live-${tag}`, r2, { onlyPort: fx.port });
      const rr = parseJsonOut(`r2/live-${tag}`, r2)?.rows || [];
      const warns = rr.filter((r) => r.level === 'WARN' && rowText(r).includes('rent_bike') && /effect/.test(rowText(r)));
      if (expectWarn) {
        check(warns.length >= 1, 'r2/live-site-verb-without-effect-warns', JSON.stringify(rr.filter((r) => r.level !== 'PASS')));
        check(r2.code === 0 && !rr.some((r) => r.level === 'FAIL'), 'r2/live-warning-is-not-an-error', `exit ${r2.code}`);
      } else {
        check(warns.length === 0 && r2.code === 0, 'r2/live-site-verb-with-effect-draws-no-warning', `exit ${r2.code}`);
      }
      check(knocksOf(fx.state.posts).filter((k) => k.offer === 'rent_bike').length === 1, `r2/live-${tag}-site-verb-knocked-once`);
    }

    // A reply kind unlike the declared one FAILs, and names the offer.
    const liar = liveDoor(doctorDeclaration(fx.origin, [], (d) => {
      d.offers.find((o) => o.verb === 'hold').door = { reply: 'human' };
    }));
    fx.state.handler = (method, url, ...rest) => (method === 'POST' && url.split('?')[0] === '/'
      ? liar.handleRequestAsync(method, url, ...rest) : entry.handleRequestAsync(method, url, ...rest));
    const mis = await runCli(['doctor', '--url', fx.origin, '--json']);
    guardClean('doctor-live/mismatch', mis, { onlyPort: fx.port });
    const mrows = parseJsonOut('doctor-live/mismatch', mis)?.rows || [];
    check(mis.code === 1, 'doctor-live/reply-kind-mismatch-exit-1', `exit ${mis.code}`);
    check(mrows.some((r) => r.level === 'FAIL' && rowText(r).includes('hold_item')), 'doctor-live/mismatch-fail-names-the-offer');
    check(!mrows.some((r) => r.level === 'FAIL' && /find_products|book_table|buy_order|ask_anything|find_hours/.test(rowText(r))),
      'doctor-live/mismatch-fails-only-that-offer', JSON.stringify(mrows.filter((r) => r.level === 'FAIL')));

    // A forged contract envelope FAILs.
    fx.state.handler = async (method, url, ...rest) => {
      const out = await entry.handleRequestAsync(method, url, ...rest);
      if (method === 'GET' && url.split('?')[0] === TOOLS_SIG_PATH && out.status === 200) {
        const env = JSON.parse(Buffer.from(out.body).toString('utf8'));
        env.contract.name = 'Harbor Lamp (forged)';
        return { ...out, body: Buffer.from(JSON.stringify(env)) };
      }
      return out;
    };
    const forged = await runCli(['doctor', '--url', fx.origin, '--json']);
    guardClean('doctor-live/forged', forged, { onlyPort: fx.port });
    check(forged.code === 1 && (parseJsonOut('doctor-live/forged', forged)?.rows || []).some((r) => r.level === 'FAIL'),
      'doctor-live/forged-contract-envelope-fails', `exit ${forged.code}`);

    // A door without a declaration: no contract, no collector -> FAIL.
    const plain = createAgentEntry({ seedHex: DOCTOR_SEED, name: 'Harbor Lamp', baseUrl: fx.origin });
    fx.state.handler = (...a) => plain.handleRequestAsync(...a);
    const none = await runCli(['doctor', '--url', fx.origin, '--json']);
    check(none.code === 1, 'doctor-live/door-without-contract-fails', `exit ${none.code}`);
  } finally {
    fx.server.close();
  }

  // R4: pointed off loopback, doctor fails closed and nothing leaves the machine. 192.0.2.1 is
  // TEST-NET-1 (RFC 5737): even without the guard no packet could reach a real host.
  const off = await runCli(['doctor', '--url', 'http://192.0.2.1:9', '--json'], { timeout: 90000 });
  check(off.guard.some((r) => r.kind === 'loaded'), 'r4/guard-loaded');
  check(off.code === 1 && off.signal === null && !off.timedOut, 'r4/off-loopback-target-fails-closed-exit-1', `exit ${off.code} ${off.signal}`);
  const hostOf = (r) => {
    if (r.kind === 'connect') return r.host;
    try { return new URL(r.url).hostname; } catch { return ''; }
  };
  const reached = off.guard.filter((r) => (r.kind === 'connect' || r.kind === 'fetch') && r.allowed && !isLocalHost(hostOf(r)));
  check(reached.length === 0, 'r4/no-connection-left-the-machine', JSON.stringify(reached));

  const misuse = await runCli(['doctor', '--url', 'not a url']);
  check(misuse.code === 2, 'doctor/bad-url-exit-2', `exit ${misuse.code}`);
});

// ---------------------------------------------------------------- 7. counts, R6

function countsKnock(entry, seed, offer, text = MARKER) {
  const from = didFromSeedHex(seed);
  const messageId = `counts-${Math.random().toString(16).slice(2)}-${Date.now()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signEnvelope(seed, { from, to: entry.did, messageId, contextId: null, timestamp, text });
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
      metadata: { from, to: entry.did, timestamp, sig, offer } } } }));
  return entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json', 'user-agent': 'Claude-User/1.0' },
    body, { remoteAddress: '127.0.0.1' });
}

function beacon(entry, events) {
  const body = Buffer.from(JSON.stringify({ session: 'tab-counts01', events }));
  return entry.handleRequestAsync('POST', TOOLS_EVENTS_PATH, { origin: 'https://shop.example',
    'content-type': 'text/plain;charset=UTF-8', 'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36' }, body, { remoteAddress: '127.0.0.1' });
}

function waitForUrl(child, ms) {
  return new Promise((resolveUrl) => {
    let buf = '';
    const timer = setTimeout(() => resolveUrl(null), ms);
    child.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      const m = buf.match(/http:\/\/(127\.0\.0\.1|\[::1\]):(\d+)\/?/);
      if (m) { clearTimeout(timer); resolveUrl({ url: m[0], host: m[1], port: Number(m[2]) }); }
    });
    child.on('close', () => { clearTimeout(timer); resolveUrl(null); });
  });
}

function tryConnect(host, port) {
  return new Promise((r) => {
    const s = connect({ host, port });
    s.setTimeout(2000, () => { s.destroy(); r(false); });
    s.on('connect', () => { s.destroy(); r(true); });
    s.on('error', () => r(false));
  });
}

function ownAddresses() {
  return Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal).map((a) => a.address);
}

await section('counts', async () => {
  const fileSink = need('fileSink');
  const haveSink = typeof fileSink === 'function';
  const dir = tmp('ae-cli-counts-');
  const log = join(dir, 'counts.jsonl');
  const storePath = join(dir, 'store.json');
  const decl = doctorDeclaration('https://shop.example');
  const contract = compileDeclaration(clone(decl));
  const entry = createAgentEntry({ seedHex: COUNTS_SEED, name: 'Harbor Lamp', baseUrl: 'https://shop.example',
    declaration: decl, signedRatePerMin: 0, signedRatePerMinTotal: 0, observer: haveSink ? fileSink(log) : null,
    store: createFileStore(storePath) });

  const ev = (name, extra = {}) => ({ name, ...extra });
  const page = [
    ev('page_ready'), ev('referral', { engine: 'claude' }), ev('referral', { engine: 'claude' }), ev('referral', { engine: 'perplexity' }),
    ev('offer_started', { offer: 'find_products' }), ev('offer_started', { offer: 'find_products' }), ev('offer_started', { offer: 'find_products' }),
    ev('offer_succeeded', { offer: 'find_products', ms: 80 }), ev('offer_succeeded', { offer: 'find_products', ms: 95 }),
    ev('offer_failed', { offer: 'find_products' }), ev('offer_started', { offer: 'hold_item' }),
  ];
  check((await beacon(entry, page)).status === 204, 'counts/setup-beacon-accepted');
  for (const [seed, offer] of [[VISITOR_A, 'hold_item'], [VISITOR_A, 'hold_item'], [VISITOR_A, 'book_table'], [VISITOR_B, 'ask_anything']]) {
    const out = await countsKnock(entry, seed, offer);
    check(out.status === 200, `counts/setup-knock-${offer}`, `HTTP ${out.status}`);
  }
  await countsKnock(entry, VISITOR_C, 'teleport_now');           // refused: -32602, no account row
  await new Promise((r) => setTimeout(r, 50));
  const accounts = JSON.parse(readText(storePath) || '{"accounts":[]}').accounts || [];
  check(accounts.length === 2 && accounts.filter(([, row]) => row.messages >= 2).length === 1,
    'counts/setup-store-has-one-returning-customer', JSON.stringify(accounts.map(([, row]) => row)));
  if (!haveSink) return;

  const logText = readText(log) || '';
  check(logText.length > 0, 'counts/fileSink-writes-the-log');
  check(!logText.includes('did:key:') && !logText.includes('Marker-Ada'), 'counts/fileSink-log-carries-no-did-and-no-text');

  const receipt = (id) => contract.offers.find((o) => o.id === id)?.door?.receipt === true;
  const run = await runCli(['counts', '--json', '--log', log, '--store', storePath], { cwd: dir });
  guardClean('counts/json', run);
  check(run.code === 0, 'counts/json-exit-0', `exit ${run.code}: ${run.stderr.slice(0, 300)}`);
  const out = parseJsonOut('counts/json', run);
  if (out) {
    const o = out.offers || {};
    check(o.find_products?.page_asked === 3 && o.find_products?.door_asked === 0 && o.find_products?.completed === 2
      && o.find_products?.receipts === 0, 'counts/find_products-page-asked-3-completed-2', JSON.stringify(o.find_products));
    check(o.hold_item?.page_asked === 1 && o.hold_item?.door_asked === 2, 'counts/hold_item-page-1-door-2', JSON.stringify(o.hold_item));
    check(o.hold_item?.receipts === (receipt('hold_item') ? 2 : 0), 'counts/hold_item-receipts', JSON.stringify(o.hold_item));
    check(o.book_table?.door_asked === 1 && o.book_table?.receipts === (receipt('book_table') ? 1 : 0), 'counts/book_table', JSON.stringify(o.book_table));
    check(o.ask_anything?.door_asked === 1 && o.ask_anything?.receipts === 0, 'counts/ask_anything', JSON.stringify(o.ask_anything));
    check(!Object.hasOwn(o, 'teleport_now'), 'counts/refused-offer-is-not-a-verb');
    check(JSON.stringify(out.referrals) === JSON.stringify({ claude: 2, perplexity: 1 })
      || (out.referrals?.claude === 2 && out.referrals?.perplexity === 1 && Object.keys(out.referrals).length === 2),
    'counts/referrals-by-engine', JSON.stringify(out.referrals));
    check(out.returning_customers === 1, 'counts/returning-customers-dids-seen-twice', JSON.stringify(out.returning_customers));
    check(out.knocks?.by_stage?.signed_post === 4 && out.knocks?.by_stage?.refused_post === 1, 'counts/knocks-by-stage',
      JSON.stringify(out.knocks?.by_stage));
    const sum = (m) => Object.values(m || {}).reduce((a, b) => a + b, 0);
    check(sum(out.knocks?.by_class) === sum(out.knocks?.by_stage) && sum(out.knocks?.by_class) > 0, 'counts/knocks-by-class-add-up',
      JSON.stringify(out.knocks));
  }
  check(!run.stdout.includes('did:key:') && !run.stdout.includes('Marker-Ada'), 'counts/json-lists-no-did-and-no-text');

  const textRun = await runCli(['counts', '--log', log, '--store', storePath], { cwd: dir });
  check(textRun.code === 0 && textRun.stdout.includes('find_products') && textRun.stdout.includes('hold_item'),
    'counts/text-mode-renders-per-verb', `exit ${textRun.code}`);
  check(!textRun.stdout.includes('did:key:'), 'counts/text-mode-lists-no-did');

  // --serve: loopback only.
  const child = spawn(process.execPath, ['--import', pathToFileURL(GUARD).href, BIN, 'counts', '--serve', '--port', '0',
    '--log', log, '--store', storePath], { cwd: dir, env: baseEnv(HOME), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const at = await waitForUrl(child, 15000);
    if (check(at !== null, 'counts/serve-prints-its-loopback-url')) {
      check(at.host === '127.0.0.1' || at.host === '[::1]', 'r6/serve-address-is-loopback', at.host);
      const res = await fetch(at.url);
      const html = await res.text();
      check(res.status === 200 && /text\/html/.test(res.headers.get('content-type') || ''), 'counts/serve-answers-html',
        `HTTP ${res.status} ${res.headers.get('content-type')}`);
      check(html.includes('hold_item') && html.includes('find_products'), 'counts/serve-page-shows-the-verbs');
      check(!html.includes('did:key:') && !html.includes('Marker-Ada'), 'counts/serve-page-lists-no-did-and-no-text');
      for (const addr of ownAddresses()) {
        check(!(await tryConnect(addr, at.port)), `r6/serve-not-reachable-on-${addr}`, 'bound beyond loopback');
      }
    }
  } finally { child.kill('SIGKILL'); }

  // R6: a non-loopback bind is refused.
  const hosts = ['0.0.0.0', '::', ...ownAddresses().slice(0, 2)];
  for (const host of hosts) {
    const r = await runCli(['counts', '--serve', '--port', '0', '--host', host, '--log', log, '--store', storePath],
      { cwd: dir, timeout: 15000 });
    check(!r.timedOut && r.code !== 0 && r.code !== null, `r6/serve-refuses-host-${host}`, `exit ${r.code} timedOut ${r.timedOut}`);
    check(!/http:\/\//.test(r.stdout), `r6/serve-refused-${host}-prints-no-url`, r.stdout.slice(0, 200));
  }
});

// ---------------------------------------------------------------- 8. gaSink, R5

await section('gaSink', async () => {
  const gaSink = need('gaSink');
  if (typeof gaSink !== 'function') return;
  const sent = [];
  const stub = async (url, init = {}) => {
    sent.push({ url: String(url), method: init.method || 'GET', body: typeof init.body === 'string' ? init.body
      : Buffer.from(init.body || '').toString('utf8') });
    return new Response(null, { status: 204 });
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  const settle = () => new Promise((r) => setTimeout(r, 60));
  try {
    for (const bad of [{}, { measurementId: 'G-TEST000001' }, { apiSecret: 'test-secret' }, { measurementId: '', apiSecret: 'x' }]) {
      let threw = false;
      try { gaSink(bad); } catch { threw = true; }
      check(threw, `gaSink/refuses-${JSON.stringify(Object.keys(bad))}`);
    }

    const sink = gaSink({ measurementId: 'G-TEST000001', apiSecret: 'test-secret-4417', fetchImpl: stub });
    check(typeof sink === 'function', 'gaSink/returns-an-observer');
    const PEER = didFromSeedHex(VISITOR_A);
    const OWNER = didFromSeedHex(VISITOR_B);
    const pageEnv = { stage: 'page', event: 'offer_succeeded', offer: 'hold_item', engine: 'claude', ms: 120, identified: 0,
      verified: false, ua_family: 'Chrome', client_class: 'human-like', peer_did: null, owner_did: null, wba_did: null,
      text: null, ip_vendor: null, country: 'JP', signature_agent: null };
    const knockEnv = { stage: 'signed_post', offer: 'hold_item', identified: 1, verified: true, ua_family: 'Claude-User',
      client_class: 'declared-agent', peer_did: PEER, owner_did: OWNER, wba_did: null, to_did: didFromSeedHex(COUNTS_SEED),
      text: 'Hold the brass lamp for Ada Lovelace, ada@example.com, sku L-12', msg_id: 'msg-SECRET-4417',
      context_id: 'ctx-SECRET-9921', request: { sku: 'L-12', name: 'Ada Lovelace' }, input: { sku: 'L-12' },
      remote_address: '198.51.100.23', ip_vendor: 'anthropic', country: 'GB', signature_agent: null };

    sent.length = 0;
    sink(pageEnv);
    await settle();
    check(sent.length === 1, 'gaSink/one-request-per-page-event', `${sent.length}`);
    sink(knockEnv);
    await settle();
    check(sent.length === 2, 'gaSink/one-request-per-door-event', `${sent.length}`);

    const FORBIDDEN_KEYS = /^(did|peer_did|owner_did|customer_did|wba_did|to_did|text|request|input|q|message|msg_id|context_id|email|ip|remote_address|user_id|sku)$/;
    const FORBIDDEN_VALUES = [PEER, OWNER, didFromSeedHex(COUNTS_SEED), 'did:key:', 'Ada', 'Lovelace', 'ada@example.com', 'brass',
      'L-12', 'msg-SECRET-4417', 'ctx-SECRET-9921', '198.51.100.23', PEER.slice(8)];
    for (const [i, req] of sent.entries()) {
      const label = `r5/request-${i}`;
      let url = null;
      try { url = new URL(req.url); } catch { /* below */ }
      check(req.method === 'POST', `${label}/POST`, req.method);
      check(url?.searchParams.get('measurement_id') === 'G-TEST000001' && url?.searchParams.get('api_secret') === 'test-secret-4417',
        `${label}/measurement-id-and-secret-in-the-query`, req.url);
      check(url !== null && /\/mp\/collect$/.test(url.pathname), `${label}/measurement-protocol-path`, req.url);
      for (const v of FORBIDDEN_VALUES) check(!req.body.includes(v), `${label}/body-omits-${v.slice(0, 16)}`, req.body.slice(0, 300));
      let body = null;
      try { body = JSON.parse(req.body); } catch { check(false, `${label}/body-is-json`, req.body.slice(0, 200)); continue; }
      check(typeof body.client_id === 'string' && body.client_id.length > 0 && !body.client_id.includes('did'),
        `${label}/client-id-is-not-a-did`, JSON.stringify(body.client_id));
      check(Array.isArray(body.events) && body.events.length >= 1, `${label}/events`);
      for (const e of body.events || []) {
        check(/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(e.name || ''), `${label}/event-name-ga-shaped`, JSON.stringify(e.name));
        const p = e.params || {};
        check(Number.isSafeInteger(p.engagement_time_msec) && p.engagement_time_msec > 0, `${label}/engagement_time_msec`,
          JSON.stringify(p.engagement_time_msec));
        check((typeof p.session_id === 'string' && p.session_id.length > 0) || Number.isSafeInteger(p.session_id),
          `${label}/session_id`, JSON.stringify(p.session_id));
        for (const [k, v] of Object.entries(p)) {
          check(!FORBIDDEN_KEYS.test(k), `${label}/param-${k}-is-not-identifying`);
          const typed = typeof v === 'number' ? Number.isFinite(v) : typeof v === 'boolean'
            || (typeof v === 'string' && v.length <= 64 && !/[\s@]/.test(v));
          check(typed, `${label}/param-${k}-is-a-typed-dimension`, JSON.stringify(v));
        }
      }
      const top = Object.keys(body).filter((k) => !['client_id', 'events', 'timestamp_micros', 'non_personalized_ads'].includes(k));
      check(top.length === 0, `${label}/no-other-top-level-fields`, JSON.stringify(top));
    }

    // The hook is never a verdict: a failing endpoint throws nothing out of the observer.
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const failing = async () => { throw new TypeError('fetch failed (stub)'); };
    globalThis.fetch = failing;
    const loud = gaSink({ measurementId: 'G-TEST000001', apiSecret: 'x', fetchImpl: failing });
    let threw = false;
    try { loud(pageEnv); } catch { threw = true; }
    await settle();
    process.off('unhandledRejection', onUnhandled);
    check(!threw && unhandled.length === 0, 'gaSink/failing-endpoint-never-throws', String(unhandled[0]));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------- 9. knock --offer (S6b-1)
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first, split 1 of 2 of parent intake 20261002T130610Z).
// `knockAgentEntry(cardUrl, { offer })` and `agent-entry knock <card-url> --offer <id or verb>`
// put `metadata.offer` beside from/to/timestamp/sig, after `sig`, the way doctor's in-process
// knock already does (AT-11, AT-24). The selection is not signed (section 4): the sig covers the
// same six fields with or without it. Without --offer the POST body is byte for byte today's.
// A value that is not an id or a verb by AT-1's spelling (^[a-z][a-z0-9_]*$, a string) is
// refused before anything is sent; a well-formed value the door does not answer is sent, and
// the door's -32602 comes back as a refusal.

const KNOCK_SEED = 'f4'.repeat(32);
const OFFER_SPELLING = /^[a-z][a-z0-9_]*$/;
const MALFORMED_OFFERS = ['Hold', 'HOLD_ITEM', 'hold item', 'hold-item', '1hold', '_hold', '', 'hold ', ' hold',
  'hold_item\n', 'did:key:z6MkNotAnOffer', 'holdé'];
const NON_STRING_OFFERS = [42, true, {}, ['hold']];
const { verifyEnvelope } = door;

function knockKeyFile(seed = KNOCK_SEED) {
  const keyPath = join(tmp('ae-cli-knock-key-'), 'knock-seed');
  writeFileSync(keyPath, `${seed}\n`, { mode: 0o600 });
  return keyPath;
}

/** An in-process fetch onto one door: never a socket. Records every POST body as sent. */
function doorFetch(entry, posts) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = init.method || 'GET';
    const body = Buffer.from(init.body || '');
    if (method === 'POST') posts.push(body.toString('utf8'));
    const out = await entry.handleRequestAsync(method, parsed.pathname + parsed.search, init.headers || {}, body,
      { remoteAddress: '127.0.0.1' });
    return new Response(out.body, { status: out.status, headers: out.headers });
  };
}

/**
 * The pre-change wire, rebuilt from the values one captured POST carries: the exact object
 * literal and JSON.stringify call knockAgentEntry used before S6b-1, with `offer` appended after
 * `sig` only when one was given (doctor's offerKnock order). Any reorder, extra field or
 * whitespace change in what was sent makes the bytes differ.
 */
function expectedKnockBytes(raw, offer = undefined) {
  const m = JSON.parse(raw).params.message;
  const md = m.metadata;
  const metadata = { from: md.from, to: md.to, timestamp: md.timestamp, sig: md.sig };
  if (offer !== undefined) metadata.offer = offer;
  return JSON.stringify({ jsonrpc: '2.0', id: m.messageId, method: 'message/send', params: { message: {
    kind: 'message', role: 'user', messageId: m.messageId, contextId: null, parts: [{ kind: 'text', text: m.parts[0].text }],
    metadata } } });
}

/** Byte identity plus the values themselves: signed by the knock key to the door, fresh, unsigned offer. */
function checkKnockWire(label, raw, { doorDid, text, offer = undefined }) {
  let m = null;
  try { m = JSON.parse(raw).params.message; } catch { /* below */ }
  if (!check(m !== null, `${label}/post-is-a-message-send`, raw.slice(0, 200))) return;
  let want = null;
  try { want = expectedKnockBytes(raw, offer); } catch (e) { want = `unbuildable: ${e.message}`; }
  check(raw === want, `${label}/wire-bytes-exact`, `sent ${JSON.stringify(raw.slice(0, 400))} want ${JSON.stringify(String(want).slice(0, 400))}`);
  const md = m.metadata || {};
  const keys = offer === undefined ? ['from', 'to', 'timestamp', 'sig'] : ['from', 'to', 'timestamp', 'sig', 'offer'];
  check(JSON.stringify(Object.keys(md)) === JSON.stringify(keys), `${label}/metadata-keys-${keys.join('-')}`, JSON.stringify(Object.keys(md)));
  if (offer === undefined) check(!Object.hasOwn(md, 'offer'), `${label}/no-offer-field-when-not-given`);
  else check(md.offer === offer, `${label}/metadata-offer-is-the-value-given`, JSON.stringify(md.offer));
  check(md.from === didFromSeedHex(KNOCK_SEED) && md.to === doorDid, `${label}/from-the-knock-key-to-the-door`,
    JSON.stringify({ from: md.from, to: md.to }));
  check(m.parts?.[0]?.text === text, `${label}/text-is-the-ask`, JSON.stringify(m.parts?.[0]?.text));
  check(/^[0-9a-f]{32}$/.test(m.messageId || '') && JSON.parse(raw).id === m.messageId, `${label}/message-id-shape`);
  check(Number.isSafeInteger(md.timestamp) && Math.abs(md.timestamp - Date.now() / 1000) < 120, `${label}/timestamp-fresh`);
  let verified = false;
  try {
    verified = Boolean(verifyEnvelope({ from: md.from, to: md.to, messageId: m.messageId, contextId: null,
      timestamp: md.timestamp, text: m.parts[0].text, sig: md.sig }, { recipientDid: doorDid, signerDid: md.from }));
  } catch { /* false */ }
  check(verified, `${label}/sig-covers-the-six-fields-and-not-the-offer`);
}

const replyOf = (text) => { try { return JSON.parse(text); } catch { return null; } };

await section('knock-offer-library', async () => {
  const knock = need('knockAgentEntry');
  if (typeof knock !== 'function') return;
  const origin = 'https://shop.example';
  const entry = liveDoor(doctorDeclaration(origin));
  const cardUrl = `${origin}/.well-known/agent-card.json`;
  const keyPath = knockKeyFile();
  const posts = [];
  const fetchImpl = doorFetch(entry, posts);
  const run = async (opts) => {
    posts.length = 0;
    try { return { result: await knock(cardUrl, { keyPath, text: MARKER, fetchImpl, ...opts }), error: null }; } catch (error) {
      return { result: null, error };
    }
  };

  // Baseline: no offer, and an explicit `offer: undefined`, send today's bytes exactly.
  for (const [tag, opts] of [['no-offer', {}], ['offer-undefined', { offer: undefined }]]) {
    const label = `knock-offer/library-${tag}`;
    const { result, error } = await run(opts);
    check(error === null && result?.ok === true, `${label}/answered`, error?.message || JSON.stringify(result?.error));
    if (check(posts.length === 1, `${label}/one-post`, String(posts.length))) {
      checkKnockWire(label, posts[0], { doorDid: entry.did, text: MARKER });
    }
  }

  // An offer id and a registry verb: carried as metadata.offer, and the door answers that offer.
  for (const offer of ['hold_item', 'hold', 'find_hours']) {
    const label = `knock-offer/library-${offer}`;
    const { result, error } = await run({ offer });
    check(error === null && result?.ok === true, `${label}/answered`, error?.message || JSON.stringify(result?.error));
    if (check(posts.length === 1, `${label}/one-post`, String(posts.length))) {
      checkKnockWire(label, posts[0], { doorDid: entry.did, text: MARKER, offer });
    }
    const reply = replyOf(result?.text);
    const want = offer === 'find_hours' ? ['find', 'hours'] : ['hold', 'item'];
    check(reply?.verb === want[0] && reply?.of === want[1], `${label}/door-answered-that-offer`, String(result?.text).slice(0, 200));
  }

  // Well-formed but not answered at this door: sent as given, and the door's -32602 comes back as ok:false.
  for (const offer of ['teleport_now', 'track_order', 'hold_']) {
    const label = `knock-offer/library-unanswered-${offer}`;
    const { result, error } = await run({ offer });
    check(error === null && result?.ok === false && result?.error?.code === -32602, `${label}/door-refusal-returned`,
      error?.message || JSON.stringify(result?.error));
    if (check(posts.length === 1, `${label}/one-post`, String(posts.length))) {
      checkKnockWire(label, posts[0], { doorDid: entry.did, text: MARKER, offer });
    }
  }

  // Malformed: refused before anything is sent, never quietly dropped and sent without it.
  for (const offer of [...MALFORMED_OFFERS, ...NON_STRING_OFFERS]) {
    const label = `knock-offer/library-malformed-${JSON.stringify(offer)}`;
    if (typeof offer === 'string' && OFFER_SPELLING.test(offer)) { check(false, `${label}/fixture-is-malformed`); continue; }
    const { result, error } = await run({ offer });
    check(error !== null || (result && result.ok !== true), `${label}/refused`, JSON.stringify(result));
    check(error === null || error instanceof Error, `${label}/refusal-is-an-error`, String(error));
    check(posts.length === 0, `${label}/nothing-sent`, JSON.stringify(posts.map((p) => JSON.parse(p).params?.message?.metadata)));
  }
});

await section('knock-offer-bin', async () => {
  const fx = await startFixtureServer();
  try {
    const entry = liveDoor(doctorDeclaration(fx.origin));
    fx.state.handler = (...a) => entry.handleRequestAsync(...a);
    const cardUrl = `${fx.origin}/.well-known/agent-card.json`;
    const keyPath = knockKeyFile();
    const env = { AGENT_ENTRY_KNOCK_KEY: keyPath, AGENT_ENTRY_KNOCK_TEXT: MARKER };
    const knockCli = async (args) => {
      fx.state.posts = [];
      const run = await runCli(['knock', ...args], { env });
      return { run, posts: [...fx.state.posts] };
    };

    // Baseline: the bin without --offer sends today's bytes exactly.
    {
      const label = 'knock-offer/bin-no-offer';
      const { run, posts } = await knockCli([cardUrl]);
      guardClean(label, run, { onlyPort: fx.port });
      check(run.code === 0, `${label}/exit-0`, `exit ${run.code}: ${run.stderr.slice(0, 300)}`);
      if (check(posts.length === 1, `${label}/one-post`, String(posts.length))) {
        checkKnockWire(label, posts[0], { doorDid: entry.did, text: MARKER });
      }
    }

    // --offer <id> and --offer <verb>, end to end.
    for (const offer of ['hold_item', 'hold']) {
      const label = `knock-offer/bin-${offer}`;
      const { run, posts } = await knockCli([cardUrl, '--offer', offer]);
      guardClean(label, run, { onlyPort: fx.port });
      check(run.code === 0, `${label}/exit-0`, `exit ${run.code}: ${run.stderr.slice(0, 300)}`);
      if (check(posts.length === 1, `${label}/one-post`, String(posts.length))) {
        checkKnockWire(label, posts[0], { doorDid: entry.did, text: MARKER, offer });
      }
      const reply = replyOf(run.stdout.trim());
      check(reply?.verb === 'hold' && reply?.of === 'item', `${label}/prints-the-door-answer-to-that-offer`, run.stdout.slice(0, 200));
    }

    // Well-formed, not answered here: sent, refused by the door, exit 1 naming -32602.
    {
      const label = 'knock-offer/bin-unanswered';
      const { run, posts } = await knockCli([cardUrl, '--offer', 'teleport_now']);
      guardClean(label, run, { onlyPort: fx.port });
      check(run.code === 1 && /Refused \(-32602\)/.test(run.stderr), `${label}/exit-1-door-refusal`,
        `exit ${run.code}: ${run.stderr.slice(0, 300)}`);
      if (check(posts.length === 1, `${label}/one-post`, String(posts.length))) {
        checkKnockWire(label, posts[0], { doorDid: entry.did, text: MARKER, offer: 'teleport_now' });
      }
    }

    // Malformed or missing values: misuse, exit 2, and no knock reaches the door.
    for (const offer of MALFORMED_OFFERS) {
      const label = `knock-offer/bin-malformed-${JSON.stringify(offer)}`;
      const { run, posts } = await knockCli([cardUrl, '--offer', offer]);
      guardClean(label, run, { onlyPort: fx.port });
      check(run.code === 2, `${label}/exit-2`, `exit ${run.code}: ${run.stderr.slice(0, 200)}`);
      check(posts.length === 0, `${label}/nothing-sent`, String(posts.length));
      check(run.stdout === '', `${label}/prints-nothing-on-stdout`, run.stdout.slice(0, 200));
    }
    for (const [tag, args] of [['flag-without-value', [cardUrl, '--offer']], ['no-card-url', ['--offer', 'hold_item']],
      ['unknown-flag', [cardUrl, '--frobnicate', 'x']]]) {
      const label = `knock-offer/bin-${tag}`;
      const { run, posts } = await knockCli(args);
      check(run.code === 2, `${label}/exit-2`, `exit ${run.code}: ${run.stderr.slice(0, 200)}`);
      check(posts.length === 0, `${label}/nothing-sent`, String(posts.length));
    }
  } finally {
    fx.server.close();
  }
});

// ---------------------------------------------------------------- 10. the bin still knows `knock`, misuse is 2

await section('bin', async () => {
  const unknown = await runCli(['frobnicate']);
  check(unknown.code === 2, 'bin/unknown-verb-exit-2', `exit ${unknown.code}`);
  const none = await runCli([]);
  check(none.code === 2, 'bin/no-verb-exit-2', `exit ${none.code}`);
  const knock = await runCli(['knock']);
  check(knock.code === 2 && /knock/.test(knock.stderr), 'bin/knock-usage-unchanged', `exit ${knock.code}`);
  for (const verb of ['init', 'publish', 'deploy', 'doctor', 'counts']) {
    const help = await runCli([verb, '--help']);
    check(help.code === 0 && help.stdout.includes(verb), `bin/${verb}-help-exit-0`, `exit ${help.code}`);
  }
});

// ---------------------------------------------------------------- 11. init --from woocommerce: the refusals
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first, skeleton item 1 of 6 of the Woo declaration
// generator chain; parent intake 20261002T235854Z: public Store API only, bounded, robots.txt
// respected). `init --from woocommerce <store-url>` refuses, exit 1, each by its own reason:
//   non-https   the URL is not https: refused before any request is made, even when a plain
//               http listener there would answer a perfect products page.
//   not-woo     GET <store>/wp-json/wc/store/v1/products is absent (404, or nothing listening) or
//               does not answer JSON: not a WooCommerce store.
//   too-large   the first products page exceeds the byte bound, with or without Content-Length.
// No refusal writes anything: the project tree and HOME are byte for byte as before.
// A well-formed, in-bounds https store is not refused for any of the three reasons.
// The https store is a listener on 127.0.0.1 whose certificate chains to a throwaway CA this run
// mints under a temp directory (fixtures/cli/runtime-tls.mjs, node:crypto only), handed to the
// child as NODE_EXTRA_CA_CERTS: trust is added, verification is never turned off. No certificate
// or key is committed: no .pem file lives anywhere under conformance/ (a publisher's secret scan
// refuses them, and the fix is to not commit them, never an allowlist).

const WOO_FIX = join(FIX, 'woo');
const WOO_PRODUCTS = '/wp-json/wc/store/v1/products';
const WOO_PAGE = readFileSync(join(WOO_FIX, 'products-page.json'));
const WOO_RUNTIME = makeRuntimeTls({ prefix: 'ae-cli-woo-tls-' });
scratch.push(WOO_RUNTIME.dir);
const WOO_TLS = { key: WOO_RUNTIME.key, cert: WOO_RUNTIME.cert };
const WOO_ENV = { NODE_EXTRA_CA_CERTS: WOO_RUNTIME.caPath };
const WOO_OVERSIZE = 32 * 1024 * 1024;   // far past any first page a bounded public catalogue read needs
const WOO_REASONS = {
  'non-https': /\bhttps\b/i,
  'not-woo': /wc\/store\/v1\/products|store api|not a woo/i,
  'too-large': /\bbytes?\b|\bbound\b|too large|exceed/i,
};
const WOO_JSON = { 'content-type': 'application/json; charset=UTF-8' };

/** Every path under dir (but .git) with its content hash: two equal states mean nothing was written. */
function treeState(dir) {
  const out = {};
  const visit = (p) => {
    for (const name of readdirSync(p).sort()) {
      if (p === dir && name === '.git') continue;
      const q = join(p, name);
      const st = lstatSync(q);
      const rel = relative(dir, q);
      if (st.isDirectory()) { out[`${rel}/`] = 'dir'; visit(q); } else {
        out[rel] = st.isFile() ? createHash('sha256').update(readFileSync(q)).digest('hex') : `other:${st.mode}`;
      }
    }
  };
  visit(dir);
  return out;
}

function stateDiff(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
}

/** A store on 127.0.0.1 (https by default) recording every request it is asked. */
function startStore(handler, { tls = true } = {}) {
  return new Promise((resolveStart) => {
    const hits = [];
    const sockets = new Set();
    const onRequest = (req, res) => {
      hits.push({ method: req.method, url: req.url });
      req.resume();
      handler(req, res);
    };
    const server = tls ? createHttpsServer(WOO_TLS, onRequest) : createServer(onRequest);
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.on('tlsClientError', () => { /* a client that hangs up mid-handshake */ });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({ port, hits, origin: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) });
    });
  });
}

/** A shop: robots.txt allows everything (never the reason here), the products path answers `products`. */
function wooStore(products) {
  return (req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nAllow: /\n');
    } else if (path === WOO_PRODUCTS || path === `${WOO_PRODUCTS}/`) {
      products(req, res);
    } else {
      res.writeHead(404, { 'content-type': 'text/html; charset=UTF-8' });
      res.end('<!doctype html><title>Page not found</title>');
    }
  };
}

const wooPage = (req, res) => {
  res.writeHead(200, { ...WOO_JSON, 'x-wp-total': '3', 'x-wp-totalpages': '1' });
  res.end(WOO_PAGE);
};

/** A products page that is valid Woo JSON in every way but its size (> WOO_OVERSIZE bytes). */
function oversizedPage({ declareLength }) {
  const one = Buffer.from(JSON.stringify(JSON.parse(WOO_PAGE)[0]));
  const unit = Buffer.concat([one, Buffer.from(',')]);
  const count = Math.ceil(WOO_OVERSIZE / unit.length);
  const tail = Buffer.concat([one, Buffer.from(']')]);
  const total = 1 + count * unit.length + tail.length;
  const block = Buffer.concat(Array(64).fill(unit));
  return (req, res) => {
    const headers = { ...WOO_JSON, 'x-wp-total': String(count + 1), 'x-wp-totalpages': '1' };
    if (declareLength) headers['content-length'] = String(total);
    res.writeHead(200, headers);
    res.write('[');
    let left = count;
    res.on('close', () => { left = -1; });
    res.on('error', () => { /* the client stopped reading at its bound */ });
    const pump = () => {
      while (left > 0) {
        const n = Math.min(64, left);
        left -= n;
        if (!res.write(n === 64 ? block : Buffer.concat(Array(n).fill(unit)))) { res.once('drain', pump); return; }
      }
      if (left === 0) res.end(tail);
    };
    pump();
  };
}

const askedProducts = (hits) => hits.some((h) => h.method === 'GET' && h.url.split('?')[0].replace(/\/$/, '') === WOO_PRODUCTS);

/** Every file under conformance/, relative to the repository root. */
function conformanceFiles() {
  const out = [];
  const visit = (p) => {
    for (const name of readdirSync(p).sort()) {
      const q = join(p, name);
      const st = lstatSync(q);
      if (st.isDirectory()) visit(q); else out.push(relative(ROOT, q));
    }
  };
  visit(HERE);
  return out;
}

/** One https GET to a store; resolves { ok, status, code } and never turns verification off. */
function tlsGet(origin, ca) {
  return new Promise((resolveGet) => {
    const req = httpsRequest(`${origin}/robots.txt`, ca ? { ca } : {}, (res) => {
      res.resume();
      res.on('end', () => resolveGet({ ok: true, status: res.statusCode }));
    });
    req.on('error', (error) => resolveGet({ ok: false, code: error.code || String(error) }));
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// The certificate source: minted at run time, never committed.
await section('woo-tls', async () => {
  const pemFiles = conformanceFiles().filter((p) => /\.pem$/i.test(p));
  check(pemFiles.length === 0, 'woo-tls/no-pem-file-under-conformance', JSON.stringify(pemFiles));
  for (const name of ['store-cert.pem', 'store-key.pem', 'test-ca.pem']) {
    check(!existsSync(join(WOO_FIX, name)), `woo-tls/fixture-${name}-deleted`);
  }
  check(existsSync(join(WOO_FIX, 'products-page.json')), 'woo-tls/products-page.json-stays');

  const source = readFileSync(join(FIX, 'runtime-tls.mjs'), 'utf8');
  const imports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);
  check(imports.length > 0 && imports.every((m) => m.startsWith('node:')) && imports.includes('node:crypto'),
    'woo-tls/generator-is-node-builtins-only', JSON.stringify(imports));
  check(!/child_process|openssl|spawn|exec/i.test(source.replace(/^\/\/.*$/gm, '')), 'woo-tls/generator-never-shells-out-to-openssl');

  const ca = new X509Certificate(WOO_RUNTIME.ca);
  const leaf = new X509Certificate(WOO_RUNTIME.cert);
  check(ca.ca === true && ca.verify(ca.publicKey), 'woo-tls/ca-is-a-self-signed-ca');
  check(leaf.ca === false && leaf.verify(ca.publicKey), 'woo-tls/leaf-is-signed-by-the-ca-and-is-not-a-ca');
  check(leaf.checkIP('127.0.0.1') === '127.0.0.1', 'woo-tls/leaf-names-127.0.0.1', String(leaf.subjectAltName));
  check(leaf.checkPrivateKey(createPrivateKey(WOO_TLS.key)), 'woo-tls/key-is-the-leaf-key');
  const now = Date.now();
  check(Date.parse(leaf.validFrom) <= now && now < Date.parse(leaf.validTo), 'woo-tls/leaf-is-valid-now', `${leaf.validFrom} .. ${leaf.validTo}`);
  check(Date.parse(leaf.validTo) - now <= 31 * 24 * 3600 * 1000, 'woo-tls/leaf-is-short-lived', leaf.validTo);

  const rel = relative(ROOT, WOO_RUNTIME.dir);
  check(rel.startsWith('..') && !relative(tmpdir(), WOO_RUNTIME.dir).startsWith('..'),
    'woo-tls/minted-under-a-temp-directory-outside-the-repository', WOO_RUNTIME.dir);
  check(readFileSync(WOO_RUNTIME.caPath).equals(WOO_RUNTIME.ca), 'woo-tls/NODE_EXTRA_CA_CERTS-is-the-minted-ca');
  if (process.platform !== 'win32') {
    check((statSync(WOO_RUNTIME.keyPath).mode & 0o077) === 0, 'woo-tls/key-file-is-owner-only',
      (statSync(WOO_RUNTIME.keyPath).mode & 0o777).toString(8));
  }

  const other = makeRuntimeTls({ prefix: 'ae-cli-woo-tls-other-' });
  scratch.push(other.dir);
  check(new X509Certificate(other.ca).fingerprint256 !== ca.fingerprint256 && !other.key.equals(WOO_RUNTIME.key),
    'woo-tls/every-run-mints-fresh-keys');

  // Trust is added, never disabled: only a client holding this run's CA reaches the store.
  const store = await startStore(wooStore(wooPage));
  try {
    const trusted = await tlsGet(store.origin, WOO_RUNTIME.ca);
    check(trusted.ok && trusted.status === 200, 'woo-tls/a-client-trusting-the-minted-ca-is-answered', JSON.stringify(trusted));
    const bare = await tlsGet(store.origin, null);
    check(!bare.ok, 'woo-tls/refused/a-client-without-the-ca-is-refused', JSON.stringify(bare));
    const stranger = await tlsGet(store.origin, other.ca);
    check(!stranger.ok, 'woo-tls/refused/another-runs-ca-is-refused', JSON.stringify(stranger));
  } finally { await store.close(); }
});

await section('woo-init', async () => {
  const refusalText = {};

  /** One refusal: exit 1, its own reason on stderr, nothing written in the project or HOME. */
  async function refusal(label, reason, url, { store = null, port = null, expectAsked = true } = {}) {
    const dir = makeRepo('vite');
    const home = tmp('ae-cli-woo-home-');
    const before = { tree: treeState(dir), home: treeState(home) };
    const run = await runCli(['init', '--from', 'woocommerce', url], { cwd: dir, env: { ...WOO_ENV, HOME: home } });
    guardClean(label, run, { onlyPort: port ?? store?.port ?? null });
    check(run.code === 1, `${label}/refused-exit-1`, `exit ${run.code}; stdout ${run.stdout.slice(0, 200)}; stderr ${run.stderr.slice(0, 300)}`);
    check(WOO_REASONS[reason].test(run.stderr), `${label}/refusal-names-${reason}`, JSON.stringify(run.stderr.slice(0, 300)));
    refusalText[reason] = refusalText[reason] ?? run.stderr.trim();
    const tree = stateDiff(before.tree, treeState(dir));
    check(tree.length === 0, `${label}/writes-nothing-in-the-project`, JSON.stringify(tree.slice(0, 10)));
    const homeDiff = stateDiff(before.home, treeState(home));
    check(homeDiff.length === 0, `${label}/writes-nothing-in-home`, JSON.stringify(homeDiff.slice(0, 10)));
    check(!existsSync(join(dir, 'agent-entry.json')), `${label}/no-agent-entry.json`);
    check(seedFilesAnywhere(dir).length === 0, `${label}/no-seed-minted`, JSON.stringify(seedFilesAnywhere(dir)));
    if (store && expectAsked) {
      check(askedProducts(store.hits), `${label}/asked-the-store-api-products-path`, JSON.stringify(store.hits.slice(0, 5)));
    }
    return run;
  }

  // (1) non-https: a plain http listener that would answer a perfect page is never asked at all.
  {
    const plain = await startStore(wooStore(wooPage), { tls: false });
    try {
      const label = 'woo-init/non-https';
      const run = await refusal(label, 'non-https', plain.origin, { store: plain, expectAsked: false });
      check(plain.hits.length === 0, `${label}/no-request-made`, JSON.stringify(plain.hits));
      check(!run.guard.some((r) => (r.kind === 'connect' && r.port === plain.port) || r.kind === 'fetch'),
        `${label}/no-connection-attempted`, JSON.stringify(run.guard.filter((r) => r.kind !== 'loaded').slice(0, 3)));
    } finally { await plain.close(); }
  }

  // (2) not-woo: the products path absent (WordPress without Woo, a plain site, nothing listening)
  // or answering something that is not JSON.
  const notWoo = [
    ['wordpress-without-woo-404', (req, res) => {
      res.writeHead(404, WOO_JSON);
      res.end(JSON.stringify({ code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } }));
    }],
    ['plain-site-404', (req, res) => {
      res.writeHead(404, { 'content-type': 'text/html; charset=UTF-8' });
      res.end('<!doctype html><title>Not found</title><h1>404</h1>');
    }],
    ['html-200', (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
      res.end('<!doctype html><html><head><title>Harbor Lamp</title></head><body><h1>Lamps</h1></body></html>');
    }],
    ['json-header-html-body', (req, res) => {
      res.writeHead(200, WOO_JSON);
      res.end('<!doctype html><html><body>Lamps</body></html>');
    }],
  ];
  for (const [tag, products] of notWoo) {
    const store = await startStore(wooStore(products));
    try {
      await refusal(`woo-init/not-woo-${tag}`, 'not-woo', store.origin, { store });
    } finally { await store.close(); }
  }
  {
    const gone = await startStore(wooStore(wooPage));
    const { port, origin } = gone;
    await gone.close();
    await refusal('woo-init/not-woo-connection-refused', 'not-woo', origin, { port });
  }

  // (3) too-large: a valid page past the bound, declared up front or only counted while reading.
  for (const [tag, declareLength] of [['content-length', true], ['chunked', false]]) {
    const store = await startStore(wooStore(oversizedPage({ declareLength })));
    try {
      await refusal(`woo-init/too-large-${tag}`, 'too-large', store.origin, { store });
    } finally { await store.close(); }
  }

  const texts = Object.values(refusalText);
  check(texts.length === 3 && new Set(texts).size === 3, 'woo-init/three-refusals-are-three-distinct-reasons',
    JSON.stringify(refusalText).slice(0, 600));

  // The positive case: https, a well-formed in-bounds page -> past all three checks.
  {
    const label = 'woo-init/in-bounds-https-store';
    const store = await startStore(wooStore(wooPage));
    try {
      const dir = makeRepo('vite');
      const run = await runCli(['init', '--from', 'woocommerce', store.origin], { cwd: dir, env: WOO_ENV });
      guardClean(label, run, { onlyPort: store.port });
      check(run.code !== 2, `${label}/the-form-is-not-misuse`, `exit ${run.code}: ${run.stderr.slice(0, 300)}`);
      check(askedProducts(store.hits), `${label}/asked-the-store-api-products-path-over-https`, JSON.stringify(store.hits.slice(0, 5)));
      const named = Object.entries(WOO_REASONS).filter(([, re]) => re.test(run.stderr)).map(([k]) => k);
      check(run.code === 0 || named.length === 0, `${label}/not-refused-as-non-https-not-woo-or-too-large`,
        `exit ${run.code}; reasons ${JSON.stringify(named)}; stderr ${JSON.stringify(run.stderr.slice(0, 300))}`);
      check(!texts.includes(run.stderr.trim()), `${label}/not-any-refusal-text`, JSON.stringify(run.stderr.slice(0, 300)));
    } finally { await store.close(); }
  }

  const help = await runCli(['init', '--help']);
  check(help.code === 0 && /woocommerce/i.test(help.stdout), 'woo-init/init-help-names-woocommerce', `exit ${help.code}`);
});

// ---------------------------------------------------------------- 11b. init --from woocommerce: the ask offer
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first, skeleton item 2 of 6 of the Woo declaration
// generator chain, Woo-2; parent intake 20261002T235854Z: public Store API only, bounded,
// robots.txt respected, own vocabulary AT-1, deterministic compile, no payment verb). The
// implementer may not edit this section or fixtures/cli/woo/facts.json.
//
// `init --from woocommerce <store> --facts <file>` (or, without --facts, the same facts prompted
// one per line on stdin) reads robots.txt and exactly ONE page of the public Store API products
// path, to prove the store answers, and writes agent-entry.json holding one offer answered at the
// door from the facts (`door.reply: "facts"`), of verb `ask`, whose `facts` are the facts file as
// written. Paging is Woo-3's: the store here has one page and nothing about a second is pinned.
//
// The facts keys, in this order (also the prompt order): the shop facts hours, shipping, returns,
// payment, pickup, contact, then address, then the REQUIRED human contact, then warranty,
// holidays, languages. Facts are strings (AT-1 `facts` maps a name to a string), so the human
// contact is three flat keys:
//   human_contact_name    a company name or a person name               required, non-blank
//   human_contact_email   an email address                              at least one of these
//   human_contact_phone   a phone number                                two, non-blank
// A --facts file missing the human contact is refused, exit 1, naming the missing key(s), BEFORE
// any request to the store (not even robots.txt) and before any file is written. A facts file
// missing a shop fact, or carrying a non-string value, is refused by that key's name and writes
// nothing. A robots.txt that disallows the Store API path is respected: refused, products never
// asked, nothing written. The same facts file and the same recorded store give byte-identical
// agent-entry.json across runs.

const WOO_FACTS_FILE = join(WOO_FIX, 'facts.json');
const WOO_FACTS = readJson(WOO_FACTS_FILE);
const HUMAN_NAME = 'human_contact_name';
const HUMAN_EMAIL = 'human_contact_email';
const HUMAN_PHONE = 'human_contact_phone';
const WOO_FACT_KEYS = ['hours', 'shipping', 'returns', 'payment', 'pickup', 'contact', 'address',
  HUMAN_NAME, HUMAN_EMAIL, HUMAN_PHONE, 'warranty', 'holidays', 'languages'];
const PAYMENT_VERBS = ['buy', 'pay', 'purchase', 'checkout', 'order'];

/** The bin with stdin fed `input` (then closed): the prompted path. */
function runCliInput(args, { cwd, env = {}, input = '', timeout = 30000 } = {}) {
  const log = join(tmp('ae-cli-guard-'), 'guard.jsonl');
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(GUARD).href, BIN, ...args], {
      cwd: cwd || tmp(), env: { ...baseEnv(HOME), ...env, AE_CLI_GUARD_LOG: log },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.stdin.on('error', () => { /* the child stopped reading */ });
    child.stdin.end(input);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let guard = [];
      try { guard = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
      resolveRun({ code, signal, stdout, stderr, guard, timedOut });
    });
  });
}

const pathOf = (h) => h.url.split('?')[0].replace(/\/$/, '') || '/';
const productsHits = (hits) => hits.filter((h) => pathOf(h) === WOO_PRODUCTS);
const factsFileWith = (patch) => {
  const facts = clone(WOO_FACTS);
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete facts[k]; else facts[k] = v; }
  const file = join(tmp('ae-cli-woo-facts-'), 'facts.json');
  writeFileSync(file, `${JSON.stringify(facts, null, 2)}\n`);
  return { file, facts };
};

await section('woo-ask', async () => {
  // The fixture is the pinned key list, no more, no less.
  check(sorted(Object.keys(WOO_FACTS)) === sorted(WOO_FACT_KEYS), 'woo-ask/fixture-carries-the-pinned-facts-keys',
    JSON.stringify(Object.keys(WOO_FACTS)));
  check(Object.values(WOO_FACTS).every((v) => typeof v === 'string' && v.trim() !== ''), 'woo-ask/fixture-facts-are-strings');

  /** One accepted init: the declaration it wrote (or null), every shared pin checked. */
  async function accepted(label, store, { facts, file = null, input = null }) {
    const dir = makeRepo('vite');
    const before = store.hits.length;
    const args = ['init', '--from', 'woocommerce', store.origin, ...(file ? ['--facts', file] : [])];
    const run = input === null
      ? await runCli(args, { cwd: dir, env: WOO_ENV })
      : await runCliInput(args, { cwd: dir, env: WOO_ENV, input });
    guardClean(label, run, { onlyPort: store.port });
    if (!check(run.code === 0, `${label}/exit-0`, `exit ${run.code}; stdout ${run.stdout.slice(0, 300)}; stderr ${run.stderr.slice(0, 400)}`)) return null;
    const path = join(dir, 'agent-entry.json');
    if (!check(existsSync(path), `${label}/wrote-agent-entry.json`)) return null;
    const bytes = readFileSync(path);
    let declaration = null;
    try { declaration = JSON.parse(bytes.toString('utf8')); } catch (error) { check(false, `${label}/agent-entry.json-is-json`, String(error)); return null; }
    let valid = true;
    try { validateDeclaration(declaration); } catch (error) { valid = false; check(false, `${label}/declaration-validates`, String(error?.message || error)); }
    if (valid) check(true, `${label}/declaration-validates`);
    check(new URL(String(declaration.entry?.baseUrl)).origin === store.origin, `${label}/entry.baseUrl-names-the-store`,
      JSON.stringify(declaration.entry));
    check(canonicalJSON(declaration.facts ?? null) === canonicalJSON(facts), `${label}/facts-are-the-given-facts-as-written`,
      JSON.stringify(declaration.facts).slice(0, 600));
    const offers = Array.isArray(declaration.offers) ? declaration.offers : [];
    const factsOffers = offers.filter((o) => o?.door?.reply === 'facts');
    check(factsOffers.length === 1 && factsOffers[0].verb === 'ask', `${label}/one-door.reply-facts-offer-of-verb-ask`,
      JSON.stringify(offers).slice(0, 400));
    check(!offers.some((o) => PAYMENT_VERBS.includes(o?.verb) || o?.door?.reply === 'checkout'), `${label}/no-payment-verb`,
      JSON.stringify(offers.map((o) => o?.verb)));
    if (valid) {
      check(canonicalJSON(compileDeclaration(declaration)) === canonicalJSON(compileDeclaration(clone(declaration))),
        `${label}/compiles-deterministically`);
    }
    // One page of the public Store API, robots.txt first, nothing else asked.
    const hits = store.hits.slice(before);
    const products = productsHits(hits);
    check(products.length === 1 && products[0].method === 'GET', `${label}/exactly-one-store-api-page-fetched`, JSON.stringify(hits));
    const page = products[0] ? new URL(products[0].url, 'https://x.invalid').searchParams.get('page') : null;
    check(page === null || page === '1', `${label}/the-page-fetched-is-the-first`, JSON.stringify(products));
    const robotsAt = hits.findIndex((h) => pathOf(h) === '/robots.txt');
    const productsAt = hits.findIndex((h) => pathOf(h) === WOO_PRODUCTS);
    check(robotsAt !== -1 && robotsAt < productsAt, `${label}/robots.txt-read-before-the-store-api`, JSON.stringify(hits));
    check(hits.every((h) => ['/robots.txt', WOO_PRODUCTS].includes(pathOf(h))), `${label}/reads-only-robots.txt-and-the-store-api`,
      JSON.stringify(hits));
    check(seedLeaks(dir).length === 0, `${label}/no-trackable-seed`, JSON.stringify(seedLeaks(dir)));
    const seeds = seedFilesAnywhere(dir).map((rel) => SEED_LINE.exec(readFileSync(join(dir, rel), 'utf8'))?.[1]).filter(Boolean);
    check(!seeds.some((s) => `${run.stdout}${run.stderr}`.includes(s)), `${label}/seed-never-printed`);
    check(!bytes.toString('utf8').includes('AGENT_ENTRY_SEED_HEX') && !seeds.some((s) => bytes.toString('utf8').includes(s)),
      `${label}/no-seed-in-agent-entry.json`);
    return { dir, bytes, declaration };
  }

  /** One refusal: exit (1 when `exact`), the named key(s) on stderr, nothing written anywhere. */
  async function refused(label, store, { file = null, input = null, names = [], noRequest = false, exact = true, extraArgs = [] }) {
    const dir = makeRepo('vite');
    const home = tmp('ae-cli-woo-home-');
    const before = { tree: treeState(dir), home: treeState(home), hits: store.hits.length };
    const args = ['init', '--from', 'woocommerce', store.origin, ...(file ? ['--facts', file] : []), ...extraArgs];
    const env = { ...WOO_ENV, HOME: home };
    const run = input === null ? await runCli(args, { cwd: dir, env }) : await runCliInput(args, { cwd: dir, env, input });
    guardClean(label, run, { onlyPort: store.port });
    check(exact ? run.code === 1 : (run.code !== 0 && run.code !== null), `${label}/refused${exact ? '-exit-1' : ''}`,
      `exit ${run.code}; stdout ${run.stdout.slice(0, 200)}; stderr ${run.stderr.slice(0, 300)}`);
    for (const name of names) {
      check(run.stderr.includes(name), `${label}/refusal-names-${name}`, JSON.stringify(run.stderr.slice(0, 400)));
    }
    if (noRequest) {
      check(store.hits.length === before.hits, `${label}/refused-before-any-store-request`, JSON.stringify(store.hits.slice(before.hits)));
    }
    const tree = stateDiff(before.tree, treeState(dir));
    check(tree.length === 0, `${label}/writes-nothing-in-the-project`, JSON.stringify(tree.slice(0, 10)));
    const homeDiff = stateDiff(before.home, treeState(home));
    check(homeDiff.length === 0, `${label}/writes-nothing-in-home`, JSON.stringify(homeDiff.slice(0, 10)));
    check(!existsSync(join(dir, 'agent-entry.json')), `${label}/no-agent-entry.json`);
    check(seedFilesAnywhere(dir).length === 0, `${label}/no-seed-minted`, JSON.stringify(seedFilesAnywhere(dir)));
    return run;
  }

  const store = await startStore(wooStore(wooPage));
  try {
    // (1) --facts: one ask offer from the facts file, one Store API page read.
    const first = await accepted('woo-ask/facts-file', store, { facts: WOO_FACTS, file: WOO_FACTS_FILE });

    // (2) Deterministic: the same facts file, the same recorded store -> the same bytes.
    const second = await accepted('woo-ask/facts-file-again', store, { facts: WOO_FACTS, file: WOO_FACTS_FILE });
    if (first && second) {
      check(first.bytes.equals(second.bytes), 'woo-ask/agent-entry.json-byte-identical-across-runs',
        `${first.bytes.length} vs ${second.bytes.length} bytes`);
      check(canonicalJSON(compileDeclaration(first.declaration)) === canonicalJSON(compileDeclaration(second.declaration)),
        'woo-ask/compiled-contract-identical-across-runs');
    }

    // (3) The human contact needs a name and ONE of email or phone: either alone is enough.
    for (const [tag, drop] of [['phone-only', HUMAN_EMAIL], ['email-only', HUMAN_PHONE]]) {
      const { file, facts } = factsFileWith({ [drop]: undefined, [HUMAN_NAME]: 'Harbor Lamp Ltd.' });
      await accepted(`woo-ask/human-contact-${tag}`, store, { facts, file });
    }

    // (4) No --facts: the facts are prompted, one line per key in the pinned order.
    const answers = `${WOO_FACT_KEYS.map((k) => WOO_FACTS[k]).join('\n')}\n`;
    await accepted('woo-ask/prompted', store, { facts: WOO_FACTS, input: answers });

    // (5) Refused before any store request, by name: the human contact is missing or blank.
    for (const [tag, patch, names] of [
      ['no-name', { [HUMAN_NAME]: undefined }, [HUMAN_NAME]],
      ['blank-name', { [HUMAN_NAME]: '   ' }, [HUMAN_NAME]],
      ['neither-email-nor-phone', { [HUMAN_EMAIL]: undefined, [HUMAN_PHONE]: undefined }, [HUMAN_EMAIL, HUMAN_PHONE]],
      ['blank-email-and-phone', { [HUMAN_EMAIL]: '', [HUMAN_PHONE]: ' ' }, [HUMAN_EMAIL, HUMAN_PHONE]],
      ['no-human-contact-at-all', { [HUMAN_NAME]: undefined, [HUMAN_EMAIL]: undefined, [HUMAN_PHONE]: undefined },
        [HUMAN_NAME, HUMAN_EMAIL, HUMAN_PHONE]],
    ]) {
      const { file } = factsFileWith(patch);
      await refused(`woo-ask/refused/human-contact-${tag}`, store, { file, names, noRequest: true });
    }

    // (6) The rest of the facts shape, refused by the key's name, nothing written.
    {
      const { file } = factsFileWith({ returns: undefined });
      await refused('woo-ask/refused/missing-shop-fact-returns', store, { file, names: ['returns'], exact: false });
    }
    {
      const { file } = factsFileWith({ hours: 10 });
      await refused('woo-ask/refused/non-string-fact-hours', store, { file, names: ['hours'], exact: false });
    }
    {
      const file = join(tmp('ae-cli-woo-facts-'), 'facts.json');
      writeFileSync(file, '{"hours": "Tue-Sat",');
      await refused('woo-ask/refused/facts-file-not-json', store, { file, exact: false });
    }
    await refused('woo-ask/refused/facts-file-absent', store, { file: join(tmp('ae-cli-woo-facts-'), 'no-such-facts.json'), exact: false });

    // (7) Prompted with nothing to read (stdin closed at once): refused, never hangs, writes nothing.
    await refused('woo-ask/refused/prompted-stdin-empty', store, { input: '', exact: false });
  } finally { await store.close(); }

  // (8) robots.txt is respected: a store that disallows its Store API path is never asked for it.
  {
    const shy = await startStore((req, res) => {
      if (pathOf(req) === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('User-agent: *\nDisallow: /wp-json/\n');
      } else {
        wooStore(wooPage)(req, res);
      }
    });
    try {
      const run = await refused('woo-ask/refused/robots-disallows-the-store-api', shy, { file: WOO_FACTS_FILE, exact: false });
      check(/robots/i.test(run.stderr), 'woo-ask/refused/robots-disallows-the-store-api/refusal-names-robots.txt',
        JSON.stringify(run.stderr.slice(0, 300)));
      check(productsHits(shy.hits).length === 0, 'woo-ask/refused/robots-disallows-the-store-api/store-api-never-asked',
        JSON.stringify(shy.hits));
    } finally { await shy.close(); }
  }

  const help = await runCli(['init', '--help']);
  check(help.code === 0 && help.stdout.includes('--facts'), 'woo-ask/init-help-names---facts', `exit ${help.code}`);
});

// ---------------------------------------------------------------- 11c. init --from woocommerce: paging within bounds
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first, skeleton item 3 of 6 of the Woo declaration
// generator chain, Woo-3; parent intake 20261003T001757Z: public Store API only, bounded, robots.txt
// respected; owner answer 20261003T214138Z: both pages of a two-page store are read). The
// implementer may not edit this section. Woo-2's pins above (robots.txt first, a disallow honoured,
// one page on a one-page store) stand as they are and are not repeated here; Woo-1's refusals are
// untouched.
//
// `init --from woocommerce <store>` walks the public Store API products path page by page: page 1
// (with or without ?page=1), then ?page=2, ... in order, each page asked ONCE, and stops at the
// first of:
//   the store's last page    x-wp-totalpages on the answers. A page past it is never asked, even
//                            when the page bound would allow it and the store would answer it.
//   the page bound           --max-pages <n> (a positive integer); its default is named in README.md
//                            on a line carrying `--max-pages`, the word `default` and the number.
//   the byte bound           --max-bytes <n> (a positive integer): the most body bytes read over
//                            every page together; its default is named in README.md the same way
//                            (`--max-bytes`, `default`, the number). The walk never reads past it: once
//                            the pages read add up to the bound, no further page is asked. A FIRST
//                            page past it is Woo-1's too-large refusal, unchanged.
// A walk that a bound ends says so by name: --json carries `stopped: "page-bound"` or
// `stopped: "byte-bound"` (null when the store's last page was read), and the text output names
// "page bound" / "byte bound". Never a silent truncation. --json also carries `pages` (the pages read)
// and `products` (the products over every page read).
// Refusals and bounds:
//   another host     every request goes to the host robots.txt was read from: a redirect to another
//                    host is refused (exit 1, nothing written) and not followed; a Link: rel="next"
//                    naming another host is never asked.
//   no retry storm   a page that fails (5xx, 429/503 with Retry-After: 0, a reset mid-body, a stall)
//                    is asked once; no later page is asked after it, and the outcome names it.
//   misuse           --max-pages / --max-bytes that are not positive integers, or given without
//                    --from woocommerce, are misuse (exit 2, the flag named), before any request.
// The stores are recorded fixtures served on 127.0.0.1: the frame's two-page Store API
// (fixtures/frame/store-api-products-page-{1,2}.json) and fixtures/cli/woo/products-page.json's three
// products served one per page. Never a live store.

const FRAME_FIX = join(HERE, 'fixtures', 'frame');
const TWO_PAGES = [readFileSync(join(FRAME_FIX, 'store-api-products-page-1.json')),
  readFileSync(join(FRAME_FIX, 'store-api-products-page-2.json'))];
const TWO_PAGE_PRODUCTS = TWO_PAGES.reduce((n, b) => n + JSON.parse(b.toString('utf8')).length, 0);
const ONE_PER_PAGE = JSON.parse(WOO_PAGE.toString('utf8')).map((p) => Buffer.from(JSON.stringify([p])));
const BOUND_NAME = { 'page-bound': /page[- ]bound/i, 'byte-bound': /byte[- ]bound/i };

/** The page number a products request asked for (no ?page= is page 1). */
const pageOf = (h) => Number(new URL(h.url, 'https://x.invalid').searchParams.get('page') ?? '1');
const pagesAsked = (hits) => productsHits(hits).map(pageOf);
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

/** A paged Store API: `pages` are bodies, x-wp-totalpages says `totalPages`, and every page up to
 *  `serve` (default: all of them, even past totalPages) is answered. `onPage` may take a request over. */
function pagedProducts(pages, { totalPages = pages.length, serve = pages.length, body = (n) => pages[n - 1], onPage = null, extra = {} } = {}) {
  return (req, res) => {
    const n = Number(new URL(req.url, 'https://x.invalid').searchParams.get('page') ?? '1');
    if (onPage && onPage(n, req, res)) return;
    const headers = { ...WOO_JSON, 'x-wp-total': String(serve), 'x-wp-totalpages': String(totalPages), ...extra };
    if (!Number.isInteger(n) || n < 1 || n > serve) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ code: 'rest_invalid_param', message: 'Invalid parameter(s): page', data: { status: 400 } }));
      return;
    }
    const bytes = body(n);
    res.writeHead(200, { ...headers, 'content-length': String(bytes.length) });
    res.end(bytes);
  };
}

/** The integer README.md names as `flag`'s default, from the line carrying the flag and `default`. */
function readmeDefault(flag) {
  const line = readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n').find((l) => l.includes(flag) && /default/i.test(l));
  const m = line ? line.split(flag).join(' ').replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\b(\d+)\b/) : null;
  return m ? Number(m[1]) : null;
}

await section('woo-pages', async () => {
  /** One init against `store` with the shared facts file; nothing about the outcome checked yet. */
  async function initWalk(label, store, { extra = [], json = true, timeout = 60000 } = {}) {
    const dir = makeRepo('vite');
    const home = tmp('ae-cli-woo-home-');
    const before = { tree: treeState(dir), home: treeState(home), hits: store.hits.length };
    const args = ['init', '--from', 'woocommerce', store.origin, '--facts', WOO_FACTS_FILE, ...(json ? ['--json'] : []), ...extra];
    const run = await runCli(args, { cwd: dir, env: { ...WOO_ENV, HOME: home }, timeout });
    guardClean(label, run, { onlyPort: store.port });
    const hits = store.hits.slice(before.hits);
    const unwritten = () => {
      const tree = stateDiff(before.tree, treeState(dir));
      check(tree.length === 0, `${label}/writes-nothing-in-the-project`, JSON.stringify(tree.slice(0, 10)));
      const homeDiff = stateDiff(before.home, treeState(home));
      check(homeDiff.length === 0, `${label}/writes-nothing-in-home`, JSON.stringify(homeDiff.slice(0, 10)));
      check(!existsSync(join(dir, 'agent-entry.json')), `${label}/no-agent-entry.json`);
    };
    return { run, dir, hits, pages: pagesAsked(hits), unwritten };
  }

  /** A walk that must succeed: exit 0, a valid declaration, robots.txt first, the pages in order. */
  async function walked(label, store, { pages, products = null, stopped, extra = [], atMostOnce = [] }) {
    const w = await initWalk(label, store, { extra });
    if (!check(w.run.code === 0, `${label}/exit-0`, `exit ${w.run.code}; stdout ${w.run.stdout.slice(0, 300)}; stderr ${w.run.stderr.slice(0, 400)}`)) return w;
    const path = join(w.dir, 'agent-entry.json');
    if (check(existsSync(path), `${label}/wrote-agent-entry.json`)) {
      let ok = true;
      try { validateDeclaration(readJson(path)); } catch (error) { ok = false; check(false, `${label}/declaration-validates`, String(error?.message || error)); }
      if (ok) check(true, `${label}/declaration-validates`);
    }
    const robotsAt = w.hits.findIndex((h) => pathOf(h) === '/robots.txt');
    const productsAt = w.hits.findIndex((h) => pathOf(h) === WOO_PRODUCTS);
    check(robotsAt !== -1 && robotsAt < productsAt, `${label}/robots.txt-still-read-first`, JSON.stringify(w.hits));
    check(productsHits(w.hits).every((h) => h.method === 'GET'), `${label}/pages-are-GETs`, JSON.stringify(w.hits));
    // `pages` are the pages that must be asked, once each and in order; `atMostOnce` may follow them.
    const head = w.pages.slice(0, pages.length);
    const tail = w.pages.slice(pages.length);
    check(JSON.stringify(head) === JSON.stringify(pages) && tail.every((p) => atMostOnce.includes(p))
      && new Set(tail).size === tail.length, `${label}/asks-pages-${pages.join('-')}-in-order-once-each`, JSON.stringify(w.pages));
    const out = parseJsonOut(label, w.run);
    if (out) {
      check(out.stopped === stopped, `${label}/stopped-${stopped ?? 'null'}`, JSON.stringify(out));
      if (atMostOnce.length === 0) check(out.pages === pages.length, `${label}/json-pages-${pages.length}`, JSON.stringify(out));
      if (products !== null) check(out.products === products, `${label}/json-products-${products}`, JSON.stringify(out));
    }
    return w;
  }

  // (0) The bounds are documented: README names each default, init --help names each flag.
  const defaultPages = readmeDefault('--max-pages');
  check(Number.isInteger(defaultPages) && defaultPages >= 2, 'woo-pages/readme-names-the---max-pages-default',
    `read ${defaultPages}; a README line with \`--max-pages\`, \`default\` and the number (at least 2: the frame's store has two pages)`);
  const defaultBytes = readmeDefault('--max-bytes');
  check(Number.isInteger(defaultBytes) && defaultBytes > 0, 'woo-pages/readme-names-the---max-bytes-default',
    `read ${defaultBytes}; a README line with \`--max-bytes\`, \`default\` and the number`);
  const help = await runCli(['init', '--help']);
  check(help.code === 0 && help.stdout.includes('--max-pages') && help.stdout.includes('--max-bytes'),
    'woo-pages/init-help-names---max-pages-and---max-bytes', `exit ${help.code}`);

  // (1) The recorded two-page store: both pages read, the products of both counted.
  {
    const store = await startStore(wooStore(pagedProducts(TWO_PAGES)));
    try {
      await walked('woo-pages/two-page-store', store, { pages: [1, 2], products: TWO_PAGE_PRODUCTS, stopped: null });
      const text = await initWalk('woo-pages/two-page-store-text', store, { json: false });
      check(text.run.code === 0 && JSON.stringify(text.pages) === '[1,2]', 'woo-pages/two-page-store-text/reads-both-pages',
        `exit ${text.run.code}; pages ${JSON.stringify(text.pages)}; ${text.run.stderr.slice(0, 300)}`);
      check(!Object.values(BOUND_NAME).some((re) => re.test(`${text.run.stdout}${text.run.stderr}`)),
        'woo-pages/two-page-store-text/names-no-bound-when-none-ended-the-walk', text.run.stdout.slice(0, 400));
    } finally { await store.close(); }
  }

  // (2) x-wp-totalpages is the end: a store that would answer more pages is never asked for them.
  for (const [tag, totalPages, extra] of [
    ['totalpages-2-max-pages-50', 2, ['--max-pages', '50']],
    ['totalpages-2-default-bounds', 2, []],
    ['totalpages-1-of-3-served', 1, ['--max-pages', '50']],
  ]) {
    const store = await startStore(wooStore(pagedProducts(ONE_PER_PAGE, { totalPages, serve: 3 })));
    try {
      await walked(`woo-pages/refused/past-x-wp-totalpages-${tag}`, store, { pages: range(totalPages), products: totalPages, stopped: null, extra });
    } finally { await store.close(); }
  }

  // (3) The page bound: the walk stops exactly at it, and says so by name.
  {
    const store = await startStore(wooStore(pagedProducts(ONE_PER_PAGE)));
    try {
      await walked('woo-pages/max-pages-1', store, { pages: [1], products: 1, stopped: 'page-bound', extra: ['--max-pages', '1'] });
      await walked('woo-pages/max-pages-2', store, { pages: [1, 2], products: 2, stopped: 'page-bound', extra: ['--max-pages', '2'] });
      await walked('woo-pages/max-pages-3-is-the-last-page', store, { pages: [1, 2, 3], products: 3, stopped: null, extra: ['--max-pages', '3'] });
      const text = await initWalk('woo-pages/max-pages-2-text', store, { json: false, extra: ['--max-pages', '2'] });
      check(text.run.code === 0 && BOUND_NAME['page-bound'].test(`${text.run.stdout}${text.run.stderr}`),
        'woo-pages/max-pages-2-text/names-the-page-bound', `exit ${text.run.code}; ${text.run.stdout.slice(0, 300)} ${text.run.stderr.slice(0, 300)}`);
    } finally { await store.close(); }
  }
  // The default page bound, from README: a store reporting more pages than it is read to it, no further.
  if (Number.isInteger(defaultPages) && defaultPages >= 1) {
    const many = defaultPages + 3;
    const store = await startStore(wooStore(pagedProducts([], { totalPages: many, serve: many, body: (n) => ONE_PER_PAGE[(n - 1) % 3] })));
    try {
      await walked('woo-pages/default-page-bound', store, { pages: range(defaultPages), products: defaultPages, stopped: 'page-bound' });
    } finally { await store.close(); }
  }

  // (4) The byte bound: the bytes read over every page never pass it, and it is named when it ends the walk.
  {
    const [a, b] = TWO_PAGES.map((p) => p.length);
    const store = await startStore(wooStore(pagedProducts(TWO_PAGES)));
    try {
      await walked('woo-pages/max-bytes-page-1-exactly', store, { pages: [1], stopped: 'byte-bound',
        products: JSON.parse(TWO_PAGES[0].toString('utf8')).length, extra: ['--max-bytes', String(a)] });
      await walked('woo-pages/max-bytes-both-pages-exactly', store, { pages: [1, 2], products: TWO_PAGE_PRODUCTS, stopped: null,
        extra: ['--max-bytes', String(a + b)] });
      const text = await initWalk('woo-pages/max-bytes-page-1-exactly-text', store, { json: false, extra: ['--max-bytes', String(a)] });
      check(text.run.code === 0 && BOUND_NAME['byte-bound'].test(`${text.run.stdout}${text.run.stderr}`),
        'woo-pages/max-bytes-page-1-exactly-text/names-the-byte-bound', `exit ${text.run.code}; ${text.run.stdout.slice(0, 300)} ${text.run.stderr.slice(0, 300)}`);
      // A first page one byte past the configured bound is Woo-1's too-large refusal.
      const over = await initWalk('woo-pages/refused/max-bytes-below-page-1', store, { extra: ['--max-bytes', String(a - 1)] });
      check(over.run.code === 1 && WOO_REASONS['too-large'].test(over.run.stderr), 'woo-pages/refused/max-bytes-below-page-1/too-large-exit-1',
        `exit ${over.run.code}; ${over.run.stderr.slice(0, 300)}`);
      check(JSON.stringify(over.pages) === '[1]', 'woo-pages/refused/max-bytes-below-page-1/page-2-never-asked', JSON.stringify(over.pages));
      over.unwritten();
    } finally { await store.close(); }
  }
  {
    const [a, b] = ONE_PER_PAGE.map((p) => p.length);
    const store = await startStore(wooStore(pagedProducts(ONE_PER_PAGE)));
    try {
      // The bound falls inside page 2: page 2 may be begun (once), page 3 is never asked.
      await walked('woo-pages/max-bytes-inside-page-2', store, { pages: [1], atMostOnce: [2], stopped: 'byte-bound',
        extra: ['--max-bytes', String(a + b - 1)] });
    } finally { await store.close(); }
  }

  // (5) Never another host: robots.txt was read from the store, so every page comes from the store.
  for (const [tag, status] of [['302', 302], ['307', 307], ['301', 301]]) {
    const other = await startStore(wooStore(pagedProducts(TWO_PAGES)));
    const store = await startStore(wooStore(pagedProducts(TWO_PAGES, { onPage: (n, req, res) => {
      if (n !== 2) return false;
      res.writeHead(status, { location: `${other.origin}${WOO_PRODUCTS}?page=2` });
      res.end();
      return true;
    } })));
    try {
      const label = `woo-pages/refused/page-2-redirects-to-another-host-${tag}`;
      const w = await initWalk(label, store);
      check(other.hits.length === 0, `${label}/other-host-never-asked`, JSON.stringify(other.hits));
      check(w.run.code === 1, `${label}/refused-exit-1`, `exit ${w.run.code}; ${w.run.stdout.slice(0, 200)} ${w.run.stderr.slice(0, 300)}`);
      check(/redirect|host/i.test(w.run.stderr), `${label}/refusal-names-the-redirect`, JSON.stringify(w.run.stderr.slice(0, 300)));
      check(JSON.stringify(w.pages) === '[1,2]', `${label}/page-2-asked-once-of-the-store`, JSON.stringify(w.pages));
      w.unwritten();
    } finally { await store.close(); await other.close(); }
  }
  {
    const other = await startStore(wooStore(pagedProducts(TWO_PAGES)));
    const store = await startStore(wooStore(pagedProducts(TWO_PAGES, {
      onPage: (n, req, res) => {
        const headers = { ...WOO_JSON, 'x-wp-total': '3', 'x-wp-totalpages': '2',
          link: `<${other.origin}${WOO_PRODUCTS}?page=${n + 1}>; rel="next"` };
        if (n < 1 || n > 2) return false;
        res.writeHead(200, { ...headers, 'content-length': String(TWO_PAGES[n - 1].length) });
        res.end(TWO_PAGES[n - 1]);
        return true;
      },
    })));
    try {
      const label = 'woo-pages/refused/link-next-names-another-host';
      const w = await initWalk(label, store);
      check(other.hits.length === 0, `${label}/other-host-never-asked`, JSON.stringify(other.hits));
      check(w.run.code !== 0 || JSON.stringify(w.pages) === '[1,2]', `${label}/pages-come-from-the-store-only`,
        `exit ${w.run.code}; pages ${JSON.stringify(w.pages)}`);
    } finally { await store.close(); await other.close(); }
  }

  // (6) No retry storm: a page that fails is asked once, and no page after it is asked.
  const failures2 = [
    ['500', (res) => { res.writeHead(500, WOO_JSON); res.end('{"code":"internal_server_error","data":{"status":500}}'); }],
    ['503-retry-after-0', (res) => { res.writeHead(503, { ...WOO_JSON, 'retry-after': '0' }); res.end('{}'); }],
    ['429-retry-after-0', (res) => { res.writeHead(429, { ...WOO_JSON, 'retry-after': '0' }); res.end('{}'); }],
    ['reset-mid-body', (res) => {
      res.writeHead(200, { ...WOO_JSON, 'x-wp-totalpages': '3', 'content-length': String(ONE_PER_PAGE[1].length) });
      res.write(ONE_PER_PAGE[1].subarray(0, 20));
      setTimeout(() => res.socket?.destroy(), 50);
    }],
    ['stalled', (res) => {
      res.writeHead(200, { ...WOO_JSON, 'x-wp-totalpages': '3', 'content-length': String(ONE_PER_PAGE[1].length) });
      res.flushHeaders();
      res.on('error', () => { /* the client gave up */ });
    }],
  ];
  for (const [tag, fail] of failures2) {
    const store = await startStore(wooStore(pagedProducts(ONE_PER_PAGE, { onPage: (n, req, res) => {
      if (n !== 2) return false;
      fail(res);
      return true;
    } })));
    try {
      const label = `woo-pages/no-retry-storm/page-2-${tag}`;
      const w = await initWalk(label, store, { timeout: 120000 });
      const count = (p) => w.pages.filter((x) => x === p).length;
      check(count(1) === 1 && count(2) === 1, `${label}/each-page-asked-once`, JSON.stringify(w.pages));
      check(count(3) === 0, `${label}/no-page-after-the-failed-one`, JSON.stringify(w.pages));
      check(w.run.code !== 2, `${label}/not-misuse`, `exit ${w.run.code}`);
      check(w.run.code !== 0 || /page\s*2|page=2|"page":\s*2/i.test(`${w.run.stdout}${w.run.stderr}`), `${label}/outcome-names-page-2`,
        `exit ${w.run.code}; ${w.run.stdout.slice(0, 300)} ${w.run.stderr.slice(0, 300)}`);
    } finally { await store.close(); }
  }
  {
    const store = await startStore(wooStore(pagedProducts(ONE_PER_PAGE, { onPage: (n, req, res) => {
      res.writeHead(503, { ...WOO_JSON, 'retry-after': '0' });
      res.end('{}');
      return true;
    } })));
    try {
      const label = 'woo-pages/no-retry-storm/page-1-503-retry-after-0';
      const w = await initWalk(label, store);
      check(JSON.stringify(w.pages) === '[1]', `${label}/page-1-asked-once`, JSON.stringify(w.pages));
      check(w.run.code === 1, `${label}/refused-exit-1`, `exit ${w.run.code}`);
      w.unwritten();
    } finally { await store.close(); }
  }

  // (7) Misuse: a bound that is not a positive integer, or a bound without --from woocommerce.
  {
    const store = await startStore(wooStore(pagedProducts(TWO_PAGES)));
    try {
      for (const flag of ['--max-pages', '--max-bytes']) {
        for (const value of ['0', '-1', 'abc', '1.5', '']) {
          const label = `woo-pages/refused/${flag.slice(2)}-${value === '' ? 'empty' : value}`;
          const w = await initWalk(label, store, { extra: [flag, value] });
          check(w.run.code === 2, `${label}/misuse-exit-2`, `exit ${w.run.code}; ${w.run.stderr.slice(0, 300)}`);
          check(w.run.stderr.includes(flag), `${label}/names-${flag}`, JSON.stringify(w.run.stderr.slice(0, 300)));
          check(w.hits.length === 0, `${label}/before-any-store-request`, JSON.stringify(w.hits));
          w.unwritten();
        }
      }
    } finally { await store.close(); }
    for (const flag of ['--max-pages', '--max-bytes']) {
      const label = `woo-pages/refused/${flag.slice(2)}-without-from-woocommerce`;
      const dir = makeRepo('vite');
      const before = treeState(dir);
      const run = await runCli(['init', '--trade', 'retail', '--base-url', 'https://shop.example', flag, '2'], { cwd: dir });
      guardClean(label, run);
      check(run.code === 2 && run.stderr.includes(flag), `${label}/misuse-exit-2-naming-the-flag`, `exit ${run.code}; ${run.stderr.slice(0, 300)}`);
      const diff = stateDiff(before, treeState(dir));
      check(diff.length === 0, `${label}/writes-nothing`, JSON.stringify(diff.slice(0, 10)));
    }
  }
});

// ---------------------------------------------------------------- 11d. init --from woocommerce: the find offer and its snapshot
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first, skeleton item 4 of 6 of the Woo declaration
// generator chain, Woo-4; parent intake 20261002T235854Z: public Store API only, bounded, robots.txt
// respected, own vocabulary AT-1, deterministic compile, no payment verb). The implementer may not
// edit this section or fixtures/cli/woo/find-snapshot.expected.json. Woo-1/2/3's pins above stand as
// they are and are not repeated here.
//
// `init --from woocommerce <store>` also writes, beside agent-entry.json, the product snapshot
// `agent-entry.products.json`, and the declaration carries exactly one door-bound offer of verb
// `find` answered `door.reply: "catalog"` (beside Woo-2's one `ask`). --json `wrote` names both files.
// The snapshot's bytes are `JSON.stringify(rows, null, 2) + "\n"`, one row per product read, in the
// Store API's order, each row exactly these keys in this order:
//   id            the product id
//   name          the product name, as data
//   price         "<major>.<minor> <currency_code>" from prices.price and prices.currency_minor_unit
//   stock_status  "in_stock" | "out_of_stock" (from is_in_stock)
//   permalink     the product's permalink, only when it is on the store's own origin
// Nothing else: no description or short_description (none by default), no sku, prices block,
// price_html, images, add_to_cart, meta_data. Every "<", ">" and "&" inside a string is written as
// <, >, &: no reader of the raw bytes ever meets markup. A product whose permalink is
// not on the store's origin (another host or port, another scheme, protocol-relative, javascript:)
// is dropped from the snapshot, and that permalink is never requested.
// The door answers `find` from that file: createAgentEntry({ ..., declaration, catalogFile }) with
// catalogFile the snapshot's path replies { verb: "find", ..., status: "see_catalog", products },
// `products` the snapshot's rows, read from the file -- never a request to the store at reply time.
// Its reply text escapes "<" and ">" the same way, so a product name never reaches a reader as markup.

const SNAPSHOT_FILE = 'agent-entry.products.json';
const SNAPSHOT_KEYS = ['id', 'name', 'price', 'stock_status', 'permalink'];
const SNAPSHOT_EXPECTED = readFileSync(join(WOO_FIX, 'find-snapshot.expected.json'), 'utf8');
const FIND_SEED = '5e'.repeat(32);
let findSequence = 0;

/** The recorded products page (or `raw`) with the fixture's shop origin swapped for the store's. */
const onOrigin = (text, origin) => text.split('https://shop.example').join(origin);

/** A door built from the project's agent-entry.json and its snapshot file. */
function findDoor(dir) {
  const declaration = JSON.parse(readFileSync(join(dir, 'agent-entry.json'), 'utf8'));
  return createAgentEntry({ seedHex: PUBLISH_SEED, name: declaration.entry.name, baseUrl: declaration.entry.baseUrl,
    declaration, catalogFile: join(dir, SNAPSHOT_FILE), signedRatePerMin: 0, signedRatePerMinTotal: 0 });
}

/** One signed `find` knock at the door, in process, with every fetch counted (and refused) meanwhile. */
async function knockFind(entry, text) {
  const from = didFromSeedHex(FIND_SEED);
  const messageId = `woo-find-${++findSequence}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signEnvelope(FIND_SEED, { from, to: entry.did, messageId, contextId: null, timestamp, text });
  const body = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
      metadata: { from, to: entry.did, timestamp, sig, offer: 'find' } } },
  }));
  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { fetches.push(String(input?.url ?? input)); throw new TypeError('no fetch at reply time'); };
  let out;
  try {
    out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body, { remoteAddress: '127.0.0.1' });
  } finally { globalThis.fetch = realFetch; }
  const raw = Buffer.from(out.body || '').toString('utf8');
  let replyText = null;
  let reply = null;
  try { replyText = JSON.parse(raw).result.parts[0].text; reply = JSON.parse(replyText); } catch { /* reported by callers */ }
  return { out, raw, replyText, reply, fetches };
}

await section('woo-find', async () => {
  /** One init against `store`; the snapshot's bytes (or null) and the declaration it wrote. */
  async function initFind(label, store) {
    const dir = makeRepo('vite');
    const before = store.hits.length;
    const run = await runCli(['init', '--from', 'woocommerce', store.origin, '--facts', WOO_FACTS_FILE, '--json'],
      { cwd: dir, env: WOO_ENV });
    guardClean(label, run, { onlyPort: store.port });
    const hits = store.hits.slice(before);
    if (!check(run.code === 0, `${label}/exit-0`, `exit ${run.code}; stdout ${run.stdout.slice(0, 300)}; stderr ${run.stderr.slice(0, 400)}`)) return null;
    const snapPath = join(dir, SNAPSHOT_FILE);
    if (!check(existsSync(snapPath), `${label}/writes-${SNAPSHOT_FILE}-beside-agent-entry.json`, JSON.stringify(walk(dir).slice(0, 20)))) return null;
    const out = parseJsonOut(label, run);
    check(Array.isArray(out?.wrote) && out.wrote.includes('agent-entry.json') && out.wrote.includes(SNAPSHOT_FILE),
      `${label}/json-wrote-names-the-declaration-and-the-snapshot`, JSON.stringify(out?.wrote));
    const raw = readFileSync(snapPath, 'utf8');
    let rows = null;
    try { rows = JSON.parse(raw); } catch (error) { check(false, `${label}/snapshot-is-json`, String(error)); }
    let declaration = null;
    try { declaration = readJson(join(dir, 'agent-entry.json')); } catch { /* below */ }
    const offers = Array.isArray(declaration?.offers) ? declaration.offers : [];
    const finds = offers.filter((o) => o?.verb === 'find' && o?.door);
    check(finds.length === 1 && finds[0].door.reply === 'catalog', `${label}/one-door-bound-find-offer-answered-catalog`,
      JSON.stringify(offers).slice(0, 400));
    check(offers.filter((o) => o?.verb === 'ask' && o?.door?.reply === 'facts').length === 1, `${label}/the-ask-offer-stays`,
      JSON.stringify(offers.map((o) => o?.verb)));
    check(!offers.some((o) => PAYMENT_VERBS.includes(o?.verb) || o?.door?.reply === 'checkout'), `${label}/no-payment-verb`);
    let valid = true;
    try { validateDeclaration(clone(declaration)); } catch (error) { valid = false; check(false, `${label}/declaration-validates`, String(error?.message || error)); }
    if (valid) check(true, `${label}/declaration-validates`);
    check(seedLeaks(dir).length === 0, `${label}/no-trackable-seed`, JSON.stringify(seedLeaks(dir)));
    check(!/AGENT_ENTRY_SEED_HEX|[0-9a-f]{64}/.test(raw), `${label}/snapshot-holds-no-secret`);
    return { dir, raw, rows, hits, run };
  }

  // (1) The recorded page (one item out of stock): the snapshot's exact bytes.
  {
    let store = null;
    store = await startStore(wooStore((req, res) => {
      const bytes = Buffer.from(onOrigin(WOO_PAGE.toString('utf8'), store.origin));
      res.writeHead(200, { ...WOO_JSON, 'x-wp-total': '3', 'x-wp-totalpages': '1', 'content-length': String(bytes.length) });
      res.end(bytes);
    }));
    try {
      const label = 'woo-find/recorded-page';
      const want = onOrigin(SNAPSHOT_EXPECTED, store.origin);
      const first = await initFind(label, store);
      if (first) {
        check(first.raw === want, `${label}/snapshot-exact-bytes`, `\n    got  ${JSON.stringify(first.raw)}\n    want ${JSON.stringify(want)}`);
        const rows = Array.isArray(first.rows) ? first.rows : [];
        check(rows.length === 3 && rows.every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(SNAPSHOT_KEYS)),
          `${label}/rows-hold-exactly-id-name-price-stock_status-permalink`, JSON.stringify(rows.map((r) => Object.keys(r))));
        check(rows.find((r) => r.id === 103)?.stock_status === 'out_of_stock' && rows.filter((r) => r.stock_status === 'in_stock').length === 2,
          `${label}/the-out-of-stock-item-is-kept-and-named`, JSON.stringify(rows.map((r) => r.stock_status)));
        for (const leak of ['description', 'short_description', 'Solid brass, hand finished', 'A solid brass desk lamp',
          'Natural linen', 'sku', 'L-12', 'price_html', 'images', 'add_to_cart', 'categories', 'average_rating', 'low_stock_remaining']) {
          check(!first.raw.includes(leak), `${label}/no-${leak.replace(/\W+/g, '-')}-in-the-snapshot`);
        }

        // Deterministic: the same recorded store gives the same snapshot bytes.
        const second = await initFind(`${label}-again`, store);
        if (second) check(second.raw === first.raw, `${label}/snapshot-byte-identical-across-runs`);

        // The door answers find from the FILE: an edit on disk is what it replies, the store is
        // closed, and no request leaves the door while it answers.
        const snapPath = join(first.dir, SNAPSHOT_FILE);
        const edited = JSON.parse(first.raw);
        edited[0].name = 'Brass Desk Lamp (as the snapshot file says)';
        writeFileSync(snapPath, `${JSON.stringify(edited, null, 2)}\n`);
        const hitsBefore = store.hits.length;
        await store.close();
        let entry = null;
        try { entry = findDoor(first.dir); } catch (error) { check(false, `${label}/door-builds-from-the-declaration-and-snapshot`, String(error?.message || error)); }
        if (entry) {
          const k = await knockFind(entry, 'find products {"q":"lamp"}');
          check(k.out.status === 200 && k.reply !== null, `${label}/find-answered`, k.raw.slice(0, 300));
          check(k.reply?.verb === 'find' && k.reply?.status === 'see_catalog', `${label}/find-reply-verb-and-status`,
            JSON.stringify({ verb: k.reply?.verb, status: k.reply?.status }));
          check(canonicalJSON(k.reply?.products ?? null) === canonicalJSON(edited), `${label}/find-replies-the-snapshot-file-rows`,
            JSON.stringify(k.reply?.products).slice(0, 600));
          check(k.fetches.length === 0, `${label}/find-reply-fetches-nothing`, JSON.stringify(k.fetches));
          check(store.hits.length === hitsBefore, `${label}/store-never-asked-at-reply-time`);
          check(!Object.hasOwn(k.reply || {}, 'deal'), `${label}/find-carries-no-deal`);
        }
      }
    } finally { await store.close(); }
  }

  // (2) Refusals: hostile names stay data, other fields never leak, a foreign permalink is dropped
  // and never followed -- neither by init nor by the door answering find.
  {
    const other = await startStore(wooStore(wooPage));
    let store = null;
    const SCRIPT_NAME = '<script>alert("snapshot")</script> Brass Desk Lamp';
    const IMG_NAME = 'Linen Shade <img src=x onerror=alert(1)> & co';
    const QUOTE_NAME = 'Plain Lamp", "status": "paid';
    const hostile = (origin, port) => {
      const base = JSON.parse(onOrigin(WOO_PAGE.toString('utf8'), origin));
      const extra = (p, patch) => ({ ...p, meta_data: [{ key: '_supplier_cost', value: 'COST-4471' }], ...patch });
      return [
        extra(base[0], { name: SCRIPT_NAME }),
        extra(base[1], { name: IMG_NAME }),
        extra(base[1], { id: 107, name: 'Away Shade', permalink: `${other.origin}/product/linen-shade/` }),
        extra(base[2], { permalink: 'javascript:alert(1)//' }),
        extra(base[0], { id: 104, name: QUOTE_NAME, permalink: `${origin}/product/plain-lamp/` }),
        extra(base[0], { id: 105, name: 'Proto Lamp', permalink: '//evil.example/product/proto/' }),
        extra(base[0], { id: 106, name: 'Plain Http Lamp', permalink: `http://127.0.0.1:${port}/product/plain-http/` }),
      ];
    };
    store = await startStore(wooStore((req, res) => {
      const bytes = Buffer.from(JSON.stringify(hostile(store.origin, store.port)));
      res.writeHead(200, { ...WOO_JSON, 'x-wp-total': '6', 'x-wp-totalpages': '1', 'content-length': String(bytes.length) });
      res.end(bytes);
    }));
    try {
      const label = 'woo-find/refused/hostile-page';
      const got = await initFind(label, store);
      if (got) {
        const rows = Array.isArray(got.rows) ? got.rows : [];
        check(rows.every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(SNAPSHOT_KEYS)),
          `${label}/rows-hold-only-the-five-fields`, JSON.stringify(rows.map((r) => Object.keys(r))));
        check(!/[<>]/.test(got.raw), `${label}/no-raw-markup-in-the-snapshot-bytes`, got.raw.slice(0, 400));
        check(got.raw.includes('\\u003cscript\\u003e'), `${label}/markup-written-escaped`, got.raw.slice(0, 400));
        check(rows.find((r) => r.id === 101)?.name === SCRIPT_NAME, `${label}/script-name-kept-as-data`,
          JSON.stringify(rows.find((r) => r.id === 101)));
        check(rows.find((r) => r.id === 104)?.name === QUOTE_NAME, `${label}/quote-name-kept-as-data`,
          JSON.stringify(rows.find((r) => r.id === 104)));
        check(rows.every((r) => typeof r.permalink === 'string' && r.permalink.startsWith(`${store.origin}/`)),
          `${label}/every-permalink-is-on-the-store-origin`, JSON.stringify(rows.map((r) => r.permalink)));
        check(!got.raw.includes('&') && rows.find((r) => r.id === 102)?.name === IMG_NAME, `${label}/img-name-escaped-and-kept-as-data`,
          JSON.stringify(rows.find((r) => r.id === 102)));
        check(JSON.stringify(rows.map((r) => r.id)) === '[101,102,104]', `${label}/foreign-permalink-products-dropped`,
          JSON.stringify(rows.map((r) => r.id)));
        for (const leak of [other.origin, 'javascript:', 'evil.example', `http://127.0.0.1:${store.port}`, 'meta_data',
          '_supplier_cost', 'COST-4471', 'description', 'Solid brass, hand finished', 'sku', 'price_html']) {
          check(!got.raw.includes(leak), `${label}/no-${leak.replace(/\W+/g, '-')}-in-the-snapshot`);
        }
        check(other.hits.length === 0, `${label}/foreign-permalink-never-requested-by-init`, JSON.stringify(other.hits));
        check(got.hits.every((h) => ['/robots.txt', WOO_PRODUCTS].includes(pathOf(h))), `${label}/init-asked-only-robots-and-the-store-api`,
          JSON.stringify(got.hits));

        let entry = null;
        try { entry = findDoor(got.dir); } catch (error) { check(false, `${label}/door-builds`, String(error?.message || error)); }
        if (entry) {
          const hitsBefore = store.hits.length;
          const k = await knockFind(entry, 'find products {"q":"lamp"}');
          check(k.reply?.verb === 'find' && k.reply?.status === 'see_catalog', `${label}/find-status-not-rewritten-by-a-name`,
            JSON.stringify(k.reply).slice(0, 300));
          check(k.reply && !Object.hasOwn(k.reply, 'paid'), `${label}/find-reply-gains-no-key-from-a-name`);
          check(canonicalJSON(k.reply?.products ?? null) === canonicalJSON(rows), `${label}/find-replies-the-snapshot-rows`,
            JSON.stringify(k.reply?.products).slice(0, 400));
          check(!/<script|<img/i.test(k.raw) && !/[<>]/.test(k.replyText ?? '<'), `${label}/find-reply-escapes-markup`,
            String(k.replyText).slice(0, 400));
          check(!k.raw.includes(other.origin) && !k.raw.includes('javascript:') && !k.raw.includes('evil.example'),
            `${label}/find-reply-carries-no-foreign-permalink`);
          check(k.fetches.length === 0 && other.hits.length === 0 && store.hits.length === hitsBefore,
            `${label}/find-reply-requests-nothing`, JSON.stringify(k.fetches));
        }
      }
    } finally { await store.close(); await other.close(); }
  }
});

// ---------------------------------------------------------------- 11e. init --from woocommerce: the hold offer and its pending receipt
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first, skeleton item 5 of 6 of the Woo declaration
// generator chain, Woo-5; parent intake 20261002T235854Z). The implementer may not edit this section.
// Woo-1/2/3/4's pins above stand as they are and are not repeated here.
//
// `init --from woocommerce <store>` also writes, into agent-entry.json, exactly one door-bound offer of
// verb `hold` answered `door.reply: "pending"`, with a receipt (door.receipt left to the verb's
// default or true, never false; no door.url). The door started from that file answers a signed
// `hold` with { verb: "hold", ..., status: "pending_confirmation", deal } (AT-12/AT-13) and nothing
// that says confirmed; the owner's confirmReceipt(seedHex, replyText) (pinned in
// conformance/offers.mjs section 8) turns it into the follow-on that reads "confirmed" and chains to
// the same termsHash. `buy` is never emitted on this path, and a confirmation claimed in the request
// is data.

const HOLD_SEED = '6b'.repeat(32);
let holdSequence = 0;

/** One signed `hold` knock at the door, in process; the reply text exactly as signed, and its JSON. */
async function knockHold(entry, text) {
  const from = didFromSeedHex(HOLD_SEED);
  const messageId = `woo-hold-${++holdSequence}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signEnvelope(HOLD_SEED, { from, to: entry.did, messageId, contextId: null, timestamp, text });
  const body = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
      metadata: { from, to: entry.did, timestamp, sig, offer: 'hold' } } },
  }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body, { remoteAddress: '127.0.0.1' });
  const raw = Buffer.from(out.body || '').toString('utf8');
  let replyText = null;
  let reply = null;
  try { replyText = JSON.parse(raw).result.parts[0].text; reply = JSON.parse(replyText); } catch { /* reported by callers */ }
  return { out, raw, replyText, reply, messageId, from };
}

await section('woo-hold', async () => {
  const confirmReceipt = need('confirmReceipt');
  let store = null;
  store = await startStore(wooStore((req, res) => {
    const bytes = Buffer.from(onOrigin(WOO_PAGE.toString('utf8'), store.origin));
    res.writeHead(200, { ...WOO_JSON, 'x-wp-total': '3', 'x-wp-totalpages': '1', 'content-length': String(bytes.length) });
    res.end(bytes);
  }));
  try {
    const label = 'woo-hold/recorded-page';
    const dir = makeRepo('vite');
    const run = await runCli(['init', '--from', 'woocommerce', store.origin, '--facts', WOO_FACTS_FILE, '--json'],
      { cwd: dir, env: WOO_ENV });
    guardClean(label, run, { onlyPort: store.port });
    if (!check(run.code === 0, `${label}/exit-0`, `exit ${run.code}; stdout ${run.stdout.slice(0, 300)}; stderr ${run.stderr.slice(0, 400)}`)) return;
    const declaration = readJson(join(dir, 'agent-entry.json'));
    const offers = Array.isArray(declaration?.offers) ? declaration.offers : [];

    // Functional: one door-bound hold, answered pending, with a receipt.
    const holds = offers.filter((o) => o?.verb === 'hold' && o?.door);
    if (!check(holds.length === 1, `${label}/one-door-bound-hold-offer`, JSON.stringify(offers).slice(0, 400))) return;
    const hold = holds[0];
    check(hold.door.reply === 'pending', `${label}/hold-answered-pending`, JSON.stringify(hold.door));
    check(hold.door.receipt !== false && !Object.hasOwn(hold.door, 'url'), `${label}/hold-carries-a-receipt-and-no-checkout-url`,
      JSON.stringify(hold.door));
    let compiled = null;
    try { compiled = compileDeclaration(clone(declaration)); } catch (error) { check(false, `${label}/declaration-compiles`, String(error?.message || error)); }
    const compiledHold = compiled?.offers?.find((o) => o.verb === 'hold' && o.door);
    check(compiledHold?.door?.receipt === true, `${label}/compiled-hold-receipt-true`, JSON.stringify(compiledHold?.door));
    // Refusal: no payment verb rides with the hold: not in its offer, not as a checkout beside it.
    check(!/\bbuy\b/i.test(JSON.stringify(hold)), `${label}/no-buy-in-the-hold-offer`, JSON.stringify(hold));
    check(!offers.some((o) => PAYMENT_VERBS.includes(o?.verb) || o?.door?.reply === 'checkout'), `${label}/no-payment-verb-beside-the-hold`,
      JSON.stringify(offers.map((o) => o?.verb)));

    await store.close();
    let entry = null;
    try { entry = findDoor(dir); } catch (error) { check(false, `${label}/door-builds-from-the-project`, String(error?.message || error)); }
    if (!entry) return;

    // Functional: the hold reply is pending with this customer's deal receipt, and claims nothing confirmed.
    const text = 'hold item {"id":101}';
    const k = await knockHold(entry, text);
    check(k.out.status === 200 && k.reply !== null, `${label}/hold-answered`, k.raw.slice(0, 300));
    const r = k.reply || {};
    check(r.verb === 'hold' && r.status === 'pending_confirmation', `${label}/hold-reply-pending_confirmation`,
      JSON.stringify({ verb: r.verb, status: r.status }));
    check(r.customer_did === k.from && r.request === text, `${label}/hold-reply-filed-under-the-signer`, JSON.stringify(r).slice(0, 300));
    const deal = r.deal || {};
    check(deal.type === 'DealReceipt' && deal.partyA === entry.did && deal.partyB === k.from && deal.ref === k.messageId,
      `${label}/hold-reply-carries-the-deal-receipt`, JSON.stringify(deal).slice(0, 300));
    check(!Object.hasOwn(r, 'confirmed') && !/confirmed"/.test(k.replyText ?? '"confirmed"'), `${label}/hold-reply-claims-no-confirmation`,
      String(k.replyText).slice(0, 300));
    check(!/\bbuy\b/i.test(k.replyText ?? 'buy') && !Object.hasOwn(r, 'url'), `${label}/hold-reply-emits-no-buy`, String(k.replyText).slice(0, 300));

    // Functional: the owner (this project's seed) confirms; the follow-on reads confirmed on the same terms.
    if (typeof confirmReceipt === 'function' && k.replyText) {
      let follow = null;
      try { follow = JSON.parse(confirmReceipt(PUBLISH_SEED, k.replyText)); } catch (error) {
        check(false, `${label}/owner-confirms`, String(error?.message || error));
      }
      if (follow) {
        check(follow.status === 'confirmed' && follow.verb === 'hold' && follow.customer_did === k.from && follow.request === text,
          `${label}/follow-on-reads-confirmed`, JSON.stringify(follow).slice(0, 300));
        check(follow.deal?.termsHash === deal.termsHash && follow.deal?.partyA === entry.did && follow.deal?.partyB === k.from,
          `${label}/follow-on-chains-to-the-hold-receipt`, JSON.stringify(follow.deal).slice(0, 300));
      }
      // Refusal: the customer's own key confirms nothing.
      let byCustomer = null;
      try { byCustomer = confirmReceipt(HOLD_SEED, k.replyText); } catch { /* refused, as it must be */ }
      check(byCustomer === null, `${label}/refused/the-customer-cannot-confirm`, String(byCustomer).slice(0, 300));
    }

    // Refusal: a confirmation the caller claims in its request is data; the reply stays pending.
    const claim = 'hold item {"id":101,"status":"confirmed","confirmed":true,"deal":{"status":"confirmed","partyB":"did:key:z6MkForged"}}';
    const c = await knockHold(entry, claim);
    check(c.reply?.status === 'pending_confirmation' && !Object.hasOwn(c.reply || {}, 'confirmed'),
      `${label}/refused/claimed-confirmation-stays-pending`, JSON.stringify(c.reply).slice(0, 300));
    check(c.reply?.deal?.partyB === c.from && !Object.hasOwn(c.reply?.deal || {}, 'status'),
      `${label}/refused/receipt-not-forged-from-the-request`, JSON.stringify(c.reply?.deal).slice(0, 300));
  } finally { await store.close(); }
});

// ---------------------------------------------------------------- 11f. doctor --from woocommerce: knock every door-bound offer
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first, skeleton item 6 of 6 of the Woo declaration
// generator chain, Woo-6; parent intake 20261002T235854Z: public Store API only, bounded, robots.txt
// respected, own vocabulary AT-1, deterministic compile, no payment verb). The implementer may not
// edit this section. Woo-1..5's pins above stand as they are and are not repeated here.
//
// `agent-entry doctor --from woocommerce [--json]`, run in the project `init --from woocommerce`
// wrote, reads its agent-entry.json and knocks each door-bound offer (ask, find, hold) at the door
// the declaration's own entry.baseUrl names -- that origin and no other: never the store the
// declaration was generated from, never a host named in the facts or the snapshot. It reports one
// row per door-bound offer, `{ id: "offer.<offer id>", level: "PASS" | "FAIL", label, detail }` in
// --json's `rows` (text mode: one PASS/FAIL line naming the offer id). A knock that fails -- the door
// answers an error, drops the connection, answers something malformed, or is not there at all -- is a
// FAIL for that offer by its id, and the remaining offers are still knocked and reported. Exit 0 when
// every offer passes, 1 when any fails.
// Refusals: the hold knock never confirms (no "confirmed" follow-on leaves the doctor, no second
// message reaches the door, nothing is written) and nothing completes a purchase (no request to the
// store, no payment verb at the door). No output -- above all a failure's -- carries the owner seed,
// the knock key, or the store credentials, even when the door's own error text does.

const WOO6_SEED = '9c'.repeat(32);
const WOO6_CK = `ck_${'4f'.repeat(20)}`;
const WOO6_CS = `cs_${'7a'.repeat(20)}`;
const WOO6_LEAK = `door failed: AGENT_ENTRY_SEED_HEX=${WOO6_SEED} consumer_key=${WOO6_CK} consumer_secret=${WOO6_CS}`;
const WOO6_MODES = ['error', 'malformed', 'drop'];

/** A door on 127.0.0.1 in front of `state.entry`; `state.mode[offerId]` makes that offer's knock fail. */
function wooDoctorDoor() {
  return new Promise((resolveStart) => {
    const state = { entry: null, ids: [], mode: {}, posts: [], requests: [], events: [] };
    const sockets = new Set();
    const offerOf = (raw) => {
      try {
        const m = JSON.parse(raw).params.message;
        const text = String(m.parts?.[0]?.text ?? '');
        const meta = m.metadata?.offer;
        const [verb, of] = text.split(/\s+/);
        return { id: JSON.parse(raw).id ?? null, text, signed: Boolean(m.metadata?.sig && m.metadata?.from),
          offer: state.ids.includes(meta) ? meta : `${verb}_${of}` };
      } catch { return { id: null, text: raw.slice(0, 200), signed: false, offer: null }; }
    };
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        state.requests.push({ method: req.method, url: req.url, host: req.headers.host });
        const knock = req.method === 'POST' ? offerOf(body.toString('utf8')) : null;
        if (knock) state.posts.push(knock);
        const mode = knock ? state.mode[knock.offer] : undefined;
        if (mode === 'drop') { req.socket.destroy(); return; }
        if (mode === 'error') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: knock.id, error: { code: -32603, message: WOO6_LEAK } }));
          return;
        }
        if (mode === 'malformed') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(`{"jsonrpc":"2.0","id":${JSON.stringify(knock.id)},"result":{"parts":[{"kind":"text","text":"${WOO6_LEAK}`);
          return;
        }
        try {
          const out = await state.entry.handleRequestAsync(req.method, req.url, req.headers, body, { remoteAddress: req.socket.remoteAddress });
          res.writeHead(out.status, out.headers || {});
          res.end(out.body || '');
        } catch {
          res.writeHead(500);
          res.end('door threw');
        }
      });
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({ port, origin: `http://127.0.0.1:${port}`, state,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) });
    });
  });
}

await section('woo-doctor', async () => {
  const decoy = await startStore((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('decoy'); }, { tls: false });
  let store = null;
  store = await startStore(wooStore((req, res) => {
    const bytes = Buffer.from(onOrigin(WOO_PAGE.toString('utf8'), store.origin));
    res.writeHead(200, { ...WOO_JSON, 'x-wp-total': '3', 'x-wp-totalpages': '1', 'content-length': String(bytes.length) });
    res.end(bytes);
  }));
  const door = await wooDoctorDoor();
  try {
    // Setup: the project as init --from woocommerce writes it, with a facts line naming another host.
    const label = 'woo-doctor';
    const { file } = factsFileWith({ contact: `Write to us at ${decoy.origin}/contact` });
    const dir = makeRepo('vite');
    const init = await runCli(['init', '--from', 'woocommerce', store.origin, '--facts', file, '--json'], { cwd: dir, env: WOO_ENV });
    if (!check(init.code === 0, `${label}/setup-init-from-woocommerce`, `exit ${init.code}; stderr ${init.stderr.slice(0, 400)}`)) return;
    // The owner's seed and the store's credentials sit in the project, git-ignored: the doctor's temptation.
    writeFileSync(join(dir, '.env'), `AGENT_ENTRY_SEED_HEX=${WOO6_SEED}\nWOO_CONSUMER_KEY=${WOO6_CK}\nWOO_CONSUMER_SECRET=${WOO6_CS}\n`);
    const generated = readJson(join(dir, 'agent-entry.json'));
    let compiled = null;
    try { compiled = compileDeclaration(clone(generated)); } catch (error) { check(false, `${label}/setup-declaration-compiles`, String(error?.message || error)); return; }
    const doorBound = compiled.offers.filter((o) => o.door);
    const ids = doorBound.map((o) => o.id);
    if (!check(sorted(doorBound.map((o) => o.verb)) === sorted(['ask', 'find', 'hold']), `${label}/setup-ask-find-hold-door-bound`,
      JSON.stringify(doorBound.map((o) => [o.id, o.verb])))) return;

    // The declaration's own origin is the running door; the store stays up, named in the snapshot.
    const declaration = clone(generated);
    declaration.entry.baseUrl = door.origin;
    writeFileSync(join(dir, 'agent-entry.json'), `${JSON.stringify(declaration, null, 2)}\n`);
    door.state.ids = ids;
    door.state.entry = createAgentEntry({ seedHex: WOO6_SEED, name: declaration.entry.name, baseUrl: door.origin, declaration,
      catalogFile: join(dir, SNAPSHOT_FILE), signedRatePerMin: 0, signedRatePerMinTotal: 0,
      observer: (e) => { door.state.events.push(e); } });
    const storeHitsBefore = store.hits.length;
    const secrets = () => {
      const out = [WOO6_SEED, WOO6_CK, WOO6_CS];
      const knockKey = readText(join(HOME, 'knock-seed'));
      if (knockKey && knockKey.trim().length >= 16) out.push(knockKey.trim());
      return out;
    };

    /** One doctor run: rows, the door's knocks, and every shared refusal pinned. */
    async function doctor(tag, { json = true, port = door.port } = {}) {
      const tl = `${label}/${tag}`;
      door.state.posts = [];
      const before = treeState(dir);
      const run = await runCli(['doctor', '--from', 'woocommerce', ...(json ? ['--json'] : [])],
        { cwd: dir, env: { AGENT_ENTRY_SEED_HEX: WOO6_SEED } });
      guardClean(tl, run, { onlyPort: port });
      const rows = json ? (parseJsonOut(tl, run)?.rows || []) : [];
      const knocks = door.state.posts.slice();
      // Refusal: only the declaration's door is knocked -- never the store, never a host in the facts.
      check(store.hits.length === storeHitsBefore, `${tl}/refused/never-asks-the-woo-store`, JSON.stringify(store.hits.slice(storeHitsBefore)));
      check(decoy.hits.length === 0, `${tl}/refused/never-asks-a-host-named-elsewhere`, JSON.stringify(decoy.hits));
      check(run.guard.filter((r) => r.kind === 'connect').every((r) => r.port === port && isLocalHost(r.host)),
        `${tl}/refused/connects-only-to-the-declared-door`, JSON.stringify(run.guard.filter((r) => r.kind === 'connect').slice(0, 3)));
      check(door.state.requests.every((r) => r.host === `127.0.0.1:${door.port}`), `${tl}/refused/every-door-request-names-the-door-host`);
      // Refusal: nothing is confirmed, nothing is bought, nothing is written.
      const said = `${run.stdout}\n${run.stderr}`;
      check(!/\bconfirmed\b/i.test(said), `${tl}/refused/no-confirmation-in-the-output`, said.slice(0, 400));
      check(!knocks.some((k) => /\bconfirm(ed)?\b/i.test(k.text) || PAYMENT_VERBS.includes(k.text.split(/\s+/)[0])),
        `${tl}/refused/no-confirmation-or-payment-knock`, JSON.stringify(knocks.map((k) => k.text)));
      check(knocks.filter((k) => k.offer === ids.find((id) => id.startsWith('hold'))).length <= 1, `${tl}/refused/hold-knocked-at-most-once`,
        JSON.stringify(knocks.map((k) => k.offer)));
      check(stateDiff(before, treeState(dir)).length === 0, `${tl}/refused/writes-nothing-in-the-project`,
        JSON.stringify(stateDiff(before, treeState(dir))));
      // Refusal: no secret in the output, failure or not.
      for (const [i, s] of secrets().entries()) check(!said.includes(s), `${tl}/refused/never-echoes-secret-${i}`);
      return { run, rows, knocks, said };
    }
    const rowsOf = (rows, id) => rows.filter((r) => r.id === `offer.${id}`);
    const levelOf = (rows, id) => { const rs = rowsOf(rows, id); return rs.length === 1 ? rs[0].level : `${rs.length} rows`; };

    // (1) Functional: every offer knocked at the door, each a PASS by its offer id.
    {
      const tl = `${label}/clean`;
      const { run, rows, knocks } = await doctor('clean');
      check(run.code === 0, `${tl}/exit-0`, `exit ${run.code}; stderr ${run.stderr.slice(0, 300)}`);
      for (const id of ids) {
        check(levelOf(rows, id) === 'PASS', `${tl}/${id}-one-pass-row`, JSON.stringify(rowsOf(rows, id)));
        check(knocks.filter((k) => k.offer === id).length === 1, `${tl}/${id}-knocked-once-at-the-door`, JSON.stringify(knocks.map((k) => k.offer)));
      }
      check(knocks.length === ids.length && knocks.every((k) => k.signed), `${tl}/one-signed-knock-per-offer-and-no-other-post`,
        JSON.stringify(knocks.map((k) => [k.offer, k.signed])));
      const holdId = ids.find((id) => id.startsWith('hold'));
      check(!/\bconfirmed\b/i.test(rowText(rowsOf(rows, holdId)[0] || { id: '', label: '', detail: 'confirmed' })),
        `${tl}/refused/hold-row-does-not-say-confirmed`, JSON.stringify(rowsOf(rows, holdId)));
      check(!door.state.events.some((e) => e.reply === 'checkout') && door.state.events.filter((e) => e.offer === holdId).every((e) => e.reply === 'pending'),
        `${tl}/refused/the-door-answered-the-hold-pending-and-no-checkout`, JSON.stringify(door.state.events.map((e) => [e.offer, e.reply])));

      const text = await doctor('clean-text', { json: false });
      check(text.run.code === 0, `${tl}-text/exit-0`, `exit ${text.run.code}`);
      const lines = text.run.stdout.split('\n');
      for (const id of ids) {
        check(lines.some((l) => /^\s*PASS\b/.test(l) && l.includes(id)), `${tl}-text/${id}-on-a-pass-line`, text.run.stdout.slice(0, 600));
      }
    }

    // (2) Refusal: a pending receipt the fixture holds stays pending through a doctor run.
    {
      const tl = `${label}/pending-receipt`;
      door.state.events = [];
      const k = await knockHold(door.state.entry, 'hold item {"id":101}');
      check(k.reply?.status === 'pending_confirmation', `${tl}/setup-fixture-hold-pending`, String(k.replyText).slice(0, 300));
      const { run, said } = await doctor('pending-receipt');
      check(run.code === 0, `${tl}/exit-0`, `exit ${run.code}`);
      check(!said.includes(k.messageId) && !said.includes(String(k.reply?.deal?.termsHash ?? '\0')),
        `${tl}/refused/the-fixture-receipt-never-handled`, said.slice(0, 300));
      check(!door.state.events.some((e) => e.reply === 'checkout' || /confirm/i.test(String(e.status ?? ''))),
        `${tl}/refused/no-confirmation-or-purchase-reached-the-door`, JSON.stringify(door.state.events.map((e) => [e.offer, e.reply])));
      check(k.reply?.status === 'pending_confirmation' && !Object.hasOwn(k.reply || {}, 'confirmed'), `${tl}/refused/receipt-still-pending`);
    }

    // (3) Functional + refusal: each way a knock fails, on each offer in turn -> FAIL for that offer by
    // its id, the others still knocked and PASS, no secret echoed from the failing door.
    for (const mode of WOO6_MODES) {
      for (const failing of ids) {
        const tl = `${label}/${mode}-${failing}`;
        door.state.mode = { [failing]: mode };
        const { run, rows, knocks, said } = await doctor(`${mode}-${failing}`);
        door.state.mode = {};
        check(run.code === 1, `${tl}/exit-1`, `exit ${run.code}`);
        check(levelOf(rows, failing) === 'FAIL', `${tl}/fail-row-names-the-offer`, JSON.stringify(rows.filter((r) => r.level !== 'PASS')));
        for (const id of ids.filter((x) => x !== failing)) {
          check(knocks.some((kk) => kk.offer === id), `${tl}/${id}-still-knocked`, JSON.stringify(knocks.map((kk) => kk.offer)));
          check(levelOf(rows, id) === 'PASS', `${tl}/${id}-still-passes`, JSON.stringify(rowsOf(rows, id)));
        }
        if (mode === 'error') {
          check(!said.includes('consumer_secret') && !said.includes('AGENT_ENTRY_SEED_HEX='), `${tl}/refused/door-error-text-not-echoed-raw`,
            said.slice(0, 400));
        }
      }
    }

    // (4) Every offer failing, each its own way, in one run: three FAIL rows, text mode too.
    {
      const tl = `${label}/all-fail`;
      door.state.mode = Object.fromEntries(ids.map((id, i) => [id, WOO6_MODES[i % WOO6_MODES.length]]));
      const { run, rows, knocks } = await doctor('all-fail');
      check(run.code === 1, `${tl}/exit-1`, `exit ${run.code}`);
      for (const id of ids) {
        check(levelOf(rows, id) === 'FAIL', `${tl}/${id}-fail-row`, JSON.stringify(rowsOf(rows, id)));
        check(knocks.some((kk) => kk.offer === id), `${tl}/${id}-knocked`, JSON.stringify(knocks.map((kk) => kk.offer)));
      }
      const text = await doctor('all-fail-text', { json: false });
      check(text.run.code === 1, `${tl}-text/exit-1`, `exit ${text.run.code}`);
      for (const id of ids) {
        check(text.run.stdout.split('\n').some((l) => /^\s*FAIL\b/.test(l) && l.includes(id)), `${tl}-text/${id}-on-a-fail-line`,
          text.run.stdout.slice(0, 600));
      }
      door.state.mode = {};
    }

    // (5) The declared door is not there at all: every offer is a FAIL by its id, not one row and a stop.
    {
      const tl = `${label}/unreachable`;
      const gone = await wooDoctorDoor();
      const { port, origin } = gone;
      await gone.close();
      writeFileSync(join(dir, 'agent-entry.json'), `${JSON.stringify({ ...declaration, entry: { ...declaration.entry, baseUrl: origin } }, null, 2)}\n`);
      const { run, rows } = await doctor('unreachable', { port });
      check(run.code === 1 && run.signal === null, `${tl}/exit-1`, `exit ${run.code} ${run.signal}`);
      for (const id of ids) check(levelOf(rows, id) === 'FAIL', `${tl}/${id}-fail-row`, JSON.stringify(rows.slice(0, 6)));
      check(door.state.posts.length === 0, `${tl}/refused/the-other-door-never-knocked`, JSON.stringify(door.state.posts.map((p) => p.offer)));
      writeFileSync(join(dir, 'agent-entry.json'), `${JSON.stringify(declaration, null, 2)}\n`);
    }
  } finally { await door.close(); await store.close(); await decoy.close(); }
});

// ---------------------------------------------------------------- 12. publish --claim: the Catalog's proof file
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first, P0 FRAME Claim-2, intake 20261003T131709Z-2).
// `publish --claim <code>` with exactly 32 lowercase hex records the code in the door's config
// (agent-entry.json, the one config the door reads: a door built from that file the way the wired
// agent-entry.door.mjs builds it serves the claim), and prints the DNS TXT alternative as one line
// `_muretai-catalog.<host> TXT muretai-catalog-claim=<code>`. The door then answers
// GET /.well-known/muretai-catalog-claim.txt with 200, text/plain, body exactly
// `muretai-catalog-claim=<code>` -- no trailing newline: trunk catalog/service.py hands the owner
// `file_body = CLAIM_PREFIX + code` with none, and its reader (_proof_file) strips each line. Without
// a code the path is 404 and not advertised; with one, OPTIONS on it is 204 with GET in Allow.
// Any other code is refused by name (32 / hex), exit 1 or 2, and nothing is written.

const CLAIM_PATH = '/.well-known/muretai-catalog-claim.txt';
const CLAIM_CODE = '0123456789abcdef0fedcba987654321';
const CLAIM_CODE_2 = 'a'.repeat(16) + '5'.repeat(16);
const BAD_CLAIMS = [
  ['31-hex', CLAIM_CODE.slice(0, 31)],
  ['33-hex', `${CLAIM_CODE}0`],
  ['uppercase', CLAIM_CODE.toUpperCase()],
  ['mixed-case', `${CLAIM_CODE.slice(0, 31)}F`],
  ['non-hex', 'g'.repeat(32)],
  ['64-hex', CLAIM_CODE.repeat(2)],
  ['prefixed', `muretai-catalog-claim=${CLAIM_CODE}`],
  ['trailing-space', `${CLAIM_CODE} `],
  ['leading-space', ` ${CLAIM_CODE}`],
  ['newline-injected', `${CLAIM_CODE}\nX-Evil: 1`],
  ['trailing-newline', `${CLAIM_CODE}\n`],
  ['path-traversal', '../../../../etc/passwd0123456789'],
  ['empty', ''],
];
const CLAIM_REASON = /\b32\b|\bhex/i;
const DNS_LINE = (code) => `_muretai-catalog.shop.example TXT muretai-catalog-claim=${code}`;

/** A door built from the project's agent-entry.json the way the wired door module builds it. */
function doorFromProject(dir) {
  const declaration = JSON.parse(readFileSync(join(dir, 'agent-entry.json'), 'utf8'));
  return createAgentEntry({ seedHex: PUBLISH_SEED, name: declaration.entry.name, baseUrl: declaration.entry.baseUrl,
    declaration });
}

async function claimGet(entry, method = 'GET') {
  const out = await entry.handleRequestAsync(method, CLAIM_PATH, { 'user-agent': 'muretai-catalog/1' }, Buffer.alloc(0),
    { remoteAddress: '127.0.0.1' });
  const headers = Object.fromEntries(Object.entries(out.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { status: out.status, headers, body: Buffer.from(out.body || '') };
}

/** No claim served and none advertised. */
async function checkNoClaim(label, dir) {
  let entry = null;
  try { entry = doorFromProject(dir); } catch (e) { check(false, `${label}/door-builds-from-agent-entry.json`, e.message); return; }
  const get = await claimGet(entry);
  check(get.status === 404, `${label}/claim-path-404`, `HTTP ${get.status} ${get.body.toString('utf8').slice(0, 120)}`);
  check(!get.body.toString('utf8').includes('muretai-catalog-claim='), `${label}/no-proof-body`);
  const opt = await claimGet(entry, 'OPTIONS');
  check(!(opt.status === 204 && /\bGET\b/.test(opt.headers.allow || '')), `${label}/claim-path-not-advertised`,
    `HTTP ${opt.status} Allow ${opt.headers.allow}`);
}

await section('publish-claim', async () => {
  // Before any claim: 404, not advertised.
  {
    const dir = makePublishProject(DECL_V1);
    const pub = await runCli(['publish', '--json'], { cwd: dir });
    check(pub.code === 0, 'publish-claim/setup-publish', `exit ${pub.code}: ${pub.stderr.slice(0, 200)}`);
    await checkNoClaim('publish-claim/unset', dir);
  }

  // The functional case.
  {
    const label = 'publish-claim/valid';
    const dir = makePublishProject(DECL_V1);
    const contractBefore = compileDeclaration(clone(DECL_V1), { version: 1 }).hash;
    const run = await runCli(['publish', '--claim', CLAIM_CODE], { cwd: dir });
    guardClean(label, run);
    check(run.code === 0, `${label}/exit-0`, `exit ${run.code}: ${run.stderr.slice(0, 300)}`);
    check(run.stdout.split('\n').map((l) => l.trim()).includes(DNS_LINE(CLAIM_CODE)), `${label}/prints-the-dns-txt-alternative`,
      JSON.stringify(run.stdout.slice(0, 600)));
    const declText = readText(join(dir, 'agent-entry.json')) || '';
    check(declText.includes(CLAIM_CODE), `${label}/code-recorded-in-agent-entry.json`, declText.slice(0, 300));
    check(!declText.includes(PUBLISH_SEED), `${label}/config-holds-no-seed`);
    let decl = null;
    try { decl = JSON.parse(declText); validateDeclaration(decl); passed += 1; } catch (e) {
      check(false, `${label}/recorded-config-still-validates`, e.message);
    }
    if (decl) {
      check(compileDeclaration(clone(decl), { version: 1 }).hash === contractBefore, `${label}/claim-does-not-change-the-contract`);
    }

    let entry = null;
    try { entry = doorFromProject(dir); } catch (e) { check(false, `${label}/door-builds-from-agent-entry.json`, e.message); }
    if (entry) {
      const get = await claimGet(entry);
      const want = Buffer.from(`muretai-catalog-claim=${CLAIM_CODE}`, 'utf8');
      check(get.status === 200, `${label}/claim-path-200`, `HTTP ${get.status} ${get.body.toString('utf8').slice(0, 120)}`);
      check(/^text\/plain(\s*;\s*charset=utf-8)?$/i.test(get.headers['content-type'] || ''), `${label}/content-type-text-plain`,
        get.headers['content-type']);
      check(get.body.equals(want), `${label}/body-exactly-the-proof-no-trailing-newline`, JSON.stringify(get.body.toString('utf8')));
      if (get.headers['content-length'] !== undefined) {
        check(Number(get.headers['content-length']) === want.length, `${label}/content-length-matches`, get.headers['content-length']);
      }
      const opt = await claimGet(entry, 'OPTIONS');
      check(opt.status === 204 && /\bGET\b/.test(opt.headers.allow || ''), `${label}/options-advertises-get-on-the-claim-path`,
        `HTTP ${opt.status} Allow ${opt.headers.allow}`);
      check(/\bGET\b/.test(opt.headers['access-control-allow-methods'] || ''), `${label}/options-cors-methods-include-get`,
        opt.headers['access-control-allow-methods']);
      const post = await claimGet(entry, 'POST');
      check(post.status === 405 && /\bGET\b/.test(post.headers.allow || ''), `${label}/post-is-405-with-allow`,
        `HTTP ${post.status} Allow ${post.headers.allow}`);
      const other = await entry.handleRequestAsync('GET', '/.well-known/muretai-catalog-claim.txt.bak', {}, Buffer.alloc(0),
        { remoteAddress: '127.0.0.1' });
      check(other.status === 404, `${label}/only-the-exact-path-is-served`, `HTTP ${other.status}`);
    }

    // A refused code on an already-claimed project changes nothing: the first claim still stands.
    const before = treeState(dir);
    const bad = await runCli(['publish', '--claim', CLAIM_CODE.toUpperCase()], { cwd: dir });
    check(bad.code === 1 || bad.code === 2, `${label}/later-bad-code-refused`, `exit ${bad.code}`);
    const diff = stateDiff(before, treeState(dir));
    check(diff.length === 0, `${label}/later-bad-code-writes-nothing`, JSON.stringify(diff));
    if (entry) {
      const still = await claimGet(doorFromProject(dir));
      check(still.body.toString('utf8') === `muretai-catalog-claim=${CLAIM_CODE}`, `${label}/first-claim-still-served`,
        JSON.stringify(still.body.toString('utf8')));
    }

    // A second valid code replaces the first: one claim, the latest.
    const again = await runCli(['publish', '--claim', CLAIM_CODE_2], { cwd: dir });
    check(again.code === 0 && again.stdout.split('\n').map((l) => l.trim()).includes(DNS_LINE(CLAIM_CODE_2)),
      `${label}/second-code-accepted-and-printed`, `exit ${again.code}: ${again.stderr.slice(0, 200)}`);
    try {
      const now = await claimGet(doorFromProject(dir));
      check(now.status === 200 && now.body.toString('utf8') === `muretai-catalog-claim=${CLAIM_CODE_2}`,
        `${label}/second-code-served`, JSON.stringify(now.body.toString('utf8')));
    } catch (e) { check(false, `${label}/second-code-door-builds`, e.message); }
  }

  // Refusals: named, nothing recorded, nothing served, no DNS line printed.
  for (const [tag, code] of BAD_CLAIMS) {
    const label = `publish-claim/refuses-${tag}`;
    const dir = makePublishProject(DECL_V1);
    const before = treeState(dir);
    const run = await runCli(['publish', '--claim', code], { cwd: dir });
    guardClean(label, run);
    check(run.code === 1 || run.code === 2, `${label}/nonzero-exit`, `exit ${run.code}; stdout ${run.stdout.slice(0, 200)}`);
    check(CLAIM_REASON.test(run.stderr) && /claim/i.test(run.stderr), `${label}/refusal-names-the-reason`,
      JSON.stringify(run.stderr.slice(0, 300)));
    check(!run.stdout.includes('_muretai-catalog.'), `${label}/prints-no-dns-line`, run.stdout.slice(0, 200));
    const diff = stateDiff(before, treeState(dir));
    check(diff.length === 0, `${label}/writes-nothing`, JSON.stringify(diff));
    await checkNoClaim(label, dir);
  }

  // Misuse: the flag without a value.
  {
    const dir = makePublishProject(DECL_V1);
    const before = treeState(dir);
    const run = await runCli(['publish', '--claim'], { cwd: dir });
    check(run.code === 2, 'publish-claim/flag-without-value-exit-2', `exit ${run.code}`);
    check(stateDiff(before, treeState(dir)).length === 0, 'publish-claim/flag-without-value-writes-nothing');
  }

  const help = await runCli(['publish', '--help']);
  check(help.code === 0 && help.stdout.includes('--claim'), 'publish-claim/publish-help-names---claim', `exit ${help.code}`);
});

// ---------------------------------------------------------------- the runner itself never dialled out

check(!guardLog.some((r) => r.allowed === false), 'runner/never-dialled-out', JSON.stringify(guardLog.filter((r) => r.allowed === false).slice(0, 3)));

for (const dir of scratch) {
  try { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures.length) {
  console.error(`FAILED - ${failures.length} cli check(s):`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} checks: init wires a door without a trackable secret, publish never rewrites a version, `
  + 'doctor knocks each door-bound offer once on loopback, counts stays anonymous and local, gaSink sends no DID or text.');
