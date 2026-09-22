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
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { guardLog, isLocalHost } from './fixtures/cli/loopback-only.mjs';
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

// ---------------------------------------------------------------- 9. the bin still knows `knock`, misuse is 2

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
