#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * conformance/private-facts.mjs
 *
 * Private declaration facts, written before the implementation (OSS-seams chain item 3 of 3,
 * parent intake 20261005T115429Z, item (b), under owner ruling C-1: a private fact is kept by the
 * door, never in the signed contract). Red until the door grows them.
 *
 * What is pinned (the CLI is `node muretai-agent-entry.mjs publish ...`, the package bin):
 *
 *   publish --fact <key>=<value> [--private]   repeatable
 *       sets a declaration fact in agent-entry.json, then publishes as `publish` always does.
 *       --private marks the --fact just before it, and only that one. A fact set without
 *       --private behaves as a declared fact does today: it is in the published contract and
 *       in a `facts` reply. A private fact's value is in none of: the signed contract, the
 *       files under the static dir (agent-tools.json, its .sig.json, agent-tools/v<n>.json),
 *       the card and its signature, any reply the door sends a visitor, any observer event or
 *       fileSink line, anything the door prints, and anything the CLI prints. The facts persist:
 *       a later plain `publish` is a no-op with the same hash.
 *
 *   createAgentEntry({ declaration }).privateFact(key)
 *       hands the embedding code the private value of `key` from that declaration (the
 *       agent-entry.json `publish --fact ... --private` wrote); a key it does not hold is
 *       undefined. How the declaration records a private fact is not pinned here.
 *
 *   A malformed --fact refuses (non-zero exit) and writes nothing at all -- no declaration
 *   change, no contract, no partial file -- even when a well-formed --fact precedes it:
 *   no `=` in the argument, an empty key, the same key given twice, a key that is not a plain
 *   identifier (a space, a dot, a leading digit), and --private with no --fact before it. The
 *   refusal is not "unknown flag", and it never prints a value it was given.
 *
 * Nothing here dials off this machine: every CLI child runs under the loopback guard, and every
 * door request is handled in process.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { guardLog } from './fixtures/cli/loopback-only.mjs';
import * as door from '../muretai-agent-entry.mjs';

const {
  AGENT_CARD_PATH, AGENT_CARD_PATH_LEGACY, AGENT_CARD_SIG_PATH, TOOLS_PATH, TOOLS_SIG_PATH,
  canonicalJSON, compileDeclaration, createAgentEntry, didFromSeedHex, fileSink, signEnvelope,
  skillsFromOffers, validateDeclaration,
} = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'muretai-agent-entry.mjs');
const FIX = join(HERE, 'fixtures', 'cli');
const GUARD = join(FIX, 'loopback-only.mjs');
const TREES = JSON.parse(readFileSync(join(FIX, 'frameworks.json'), 'utf8'));
const SEED = 'f4'.repeat(32);
const VISITOR = '5a'.repeat(32);

// The planted values. The private one is distinctive, so any trace of it is found.
const PRIVATE_KEY = 'supplier_cost';
const PRIVATE_VALUE = 'Quill-7731 wholesale at 4.20 per lamp';
const PRIVATE_TRACES = [
  PRIVATE_VALUE,
  'Quill-7731',
  JSON.stringify(PRIVATE_VALUE).slice(1, -1),
  Buffer.from(PRIVATE_VALUE, 'utf8').toString('base64'),
  Buffer.from(PRIVATE_VALUE, 'utf8').toString('base64url'),
  Buffer.from(PRIVATE_VALUE, 'utf8').toString('hex'),
  encodeURIComponent(PRIVATE_VALUE),
];
const PUBLIC_KEY = 'pickup_hours';
const PUBLIC_VALUE = 'Pickup-Wren-5520 weekdays 9 to 5';

const DECLARATION = {
  v: 1,
  entry: { name: 'Harbor Lamp', baseUrl: 'https://shop.example' },
  offers: [
    { verb: 'ask', of: 'shop', about: 'Ask the shop a question it has answered already.',
      input: { text: 'string' }, door: { reply: 'facts' } },
    { verb: 'hold', of: 'item', about: 'Hold one lamp for pickup within 48 hours.',
      input: { sku: 'string' }, door: { reply: 'pending' } },
  ],
  facts: { opening_hours: 'Mon-Sat 10-18' },
};

let passed = 0;
const failures = [];
const scratch = [];

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${String(detail).slice(0, 500)}` : ''}`);
  return false;
}

async function section(name, fn) {
  try { await fn(); } catch (error) { check(false, `${name}/threw`, error?.stack || String(error)); }
}

const clone = (v) => JSON.parse(JSON.stringify(v));

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** The private value, in any of its traced forms, is nowhere in `text`. */
function noTrace(label, text) {
  const s = Buffer.isBuffer(text) ? text.toString('utf8') : String(text ?? '');
  const found = PRIVATE_TRACES.filter((t) => s.includes(t));
  return check(found.length === 0, `${label}/private-value-absent`, `found ${JSON.stringify(found)} in ${JSON.stringify(s.slice(0, 200))}`);
}

// ---------------------------------------------------------------- child processes

const HOME = tmp('ae-facts-home-');
writeFileSync(join(HOME, '.gitconfig-empty'), '');

function baseEnv() {
  const env = {};
  for (const k of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) if (process.env[k]) env[k] = process.env[k];
  return {
    ...env,
    HOME,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(HOME, '.gitconfig-empty'),
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, env: baseEnv(), encoding: 'utf8' });
}

/** Run the bin with the loopback guard preloaded. Resolves { code, stdout, stderr, guard, timedOut }. */
function runCli(args, { cwd, timeout = 60000 } = {}) {
  const log = join(tmp('ae-facts-guard-'), 'guard.jsonl');
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(GUARD).href, BIN, ...args], {
      cwd, env: { ...baseEnv(), AE_CLI_GUARD_LOG: log }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let guard = [];
      try { guard = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
      resolveRun({ code, stdout, stderr, guard, timedOut });
    });
  });
}

function guardClean(label, run) {
  check(run.guard.some((r) => r.kind === 'loaded'), `${label}/guard-loaded`);
  const blocked = run.guard.filter((r) => r.allowed === false);
  check(blocked.length === 0, `${label}/never-dials-out`, JSON.stringify(blocked.slice(0, 3)));
  check(!run.timedOut, `${label}/finished`, 'timed out');
}

// ---------------------------------------------------------------- fixture project

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** A committed Vite project with the seed in an ignored .env and `declaration` as agent-entry.json. */
function makeProject(declaration = DECLARATION) {
  const tree = TREES.frameworks.vite;
  const dir = tmp('ae-facts-vite-');
  writeFiles(dir, tree.files);
  if (tree.gitignore !== null && tree.gitignore !== undefined) writeFileSync(join(dir, '.gitignore'), tree.gitignore);
  writeFileSync(join(dir, 'agent-entry.json'), `${JSON.stringify(declaration, null, 2)}\n`);
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  writeFileSync(join(dir, '.env'), `AGENT_ENTRY_SEED_HEX=${SEED}\n`);
  return dir;
}

const STATIC = (dir) => join(dir, 'public');

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue;
    const p = join(dir, name);
    if (lstatSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
}

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

function parseJson(label, text) {
  try { return JSON.parse(text); } catch {
    check(false, `${label}/is-json`, JSON.stringify(String(text).slice(0, 300)));
    return null;
  }
}

// ---------------------------------------------------------------- in-process door

function doorFrom(declaration, extra = {}) {
  return createAgentEntry({ seedHex: SEED, name: declaration.entry.name, baseUrl: declaration.entry.baseUrl,
    declaration: clone(declaration), signedRatePerMin: 0, signedRatePerMinTotal: 0, ...extra });
}

async function ask(entry, method, path, headers = {}, body = Buffer.alloc(0)) {
  const out = await entry.handleRequestAsync(method, path, headers, body, { remoteAddress: '127.0.0.1' });
  return { status: out.status, headers: out.headers || {}, body: Buffer.from(out.body || '').toString('utf8') };
}

let sequence = 0;
async function knock(entry, offer, text) {
  const from = didFromSeedHex(VISITOR);
  const messageId = `private-facts-${++sequence}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signEnvelope(VISITOR, { from, to: entry.did, messageId, contextId: null, timestamp, text });
  const body = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
      metadata: { from, to: entry.did, timestamp, sig, ...(offer ? { offer } : {}) } } },
  }));
  const got = await ask(entry, 'POST', '/', { 'content-type': 'application/json', 'user-agent': 'Claude-User/1.0' }, body);
  let reply = null;
  try { reply = JSON.parse(JSON.parse(got.body).result.parts[0].text); } catch { /* checked by callers */ }
  return { ...got, reply };
}

/** Everything the process prints while `fn` runs, kept and not shown. */
async function capturePrints(fn) {
  const printed = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) saved[k] = console[k];
  process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); const cb = rest.find((r) => typeof r === 'function'); if (cb) cb(); return true; };
  process.stderr.write = process.stdout.write;
  for (const k of Object.keys(saved)) console[k] = (...a) => { printed.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  try { await fn(); } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    for (const k of Object.keys(saved)) console[k] = saved[k];
  }
  return printed.join('\n');
}

// ---------------------------------------------------------------- 1. publish --fact: public and private

/** One accepted publish with --fact args; every published byte checked. Returns { dir, declaration, contract }. */
async function plantAndPublish(label, factArgs) {
  const dir = makeProject();
  const run = await runCli(['publish', '--json', ...factArgs], { cwd: dir });
  guardClean(label, run);
  if (!check(run.code === 0, `${label}/exit-0`, `exit ${run.code}; stderr ${run.stderr.slice(0, 400)}`)) return null;
  noTrace(`${label}/cli-stdout`, run.stdout);
  noTrace(`${label}/cli-stderr`, run.stderr);
  const out = parseJson(`${label}/stdout`, run.stdout);

  // The published files: every byte of the static dir.
  const published = walk(STATIC(dir));
  check(published.some((p) => p.endsWith('agent-tools.json')) && published.some((p) => p.endsWith('agent-tools.sig.json')),
    `${label}/published-the-contract`, JSON.stringify(published));
  for (const rel of published) noTrace(`${label}/file/${rel}`, readFileSync(join(STATIC(dir), rel)));

  const contractPath = join(STATIC(dir), '.well-known', 'agent-tools.json');
  const contract = existsSync(contractPath) ? parseJson(`${label}/agent-tools.json`, readFileSync(contractPath, 'utf8')) : null;
  if (contract) {
    check(contract.facts?.[PUBLIC_KEY] === PUBLIC_VALUE, `${label}/public-fact-in-the-contract`, JSON.stringify(contract.facts));
    check(contract.facts?.opening_hours === DECLARATION.facts.opening_hours, `${label}/declared-fact-kept`, JSON.stringify(contract.facts));
    if (out) check(out.hash === contract.hash, `${label}/json-hash-is-the-contract-hash`, JSON.stringify(out));
  }

  // The declaration the door keeps: it validates, and compiles to nothing that carries the value.
  const declaration = parseJson(`${label}/agent-entry.json`, readFileSync(join(dir, 'agent-entry.json'), 'utf8'));
  if (declaration) {
    let valid = true;
    try { validateDeclaration(clone(declaration)); } catch (e) { valid = false; check(false, `${label}/declaration-validates`, e.message); }
    if (valid) {
      const compiled = compileDeclaration(clone(declaration));
      noTrace(`${label}/compileDeclaration`, canonicalJSON(compiled));
      check(compiled.facts?.[PUBLIC_KEY] === PUBLIC_VALUE, `${label}/compiled-public-fact`, JSON.stringify(compiled.facts));
      if (contract) check(compiled.hash === contract.hash, `${label}/compiles-to-the-published-contract`);
      noTrace(`${label}/skillsFromOffers`, JSON.stringify(skillsFromOffers(clone(declaration))));
    }
  }
  return { dir, declaration, contract };
}

const BOTH_PRIVATE_LAST = ['--fact', `${PUBLIC_KEY}=${PUBLIC_VALUE}`, '--fact', `${PRIVATE_KEY}=${PRIVATE_VALUE}`, '--private'];
const BOTH_PRIVATE_FIRST = ['--fact', `${PRIVATE_KEY}=${PRIVATE_VALUE}`, '--private', '--fact', `${PUBLIC_KEY}=${PUBLIC_VALUE}`];

let planted = null;

await section('publish', async () => {
  planted = await plantAndPublish('publish/private-last', BOTH_PRIVATE_LAST);
  // --private binds to the --fact just before it, whichever order they come in.
  await plantAndPublish('publish/private-first', BOTH_PRIVATE_FIRST);

  // Text output (not --json) prints nothing of it either.
  {
    const dir = makeProject();
    const run = await runCli(['publish', ...BOTH_PRIVATE_LAST], { cwd: dir });
    guardClean('publish/text', run);
    check(run.code === 0, 'publish/text/exit-0', `exit ${run.code}; stderr ${run.stderr.slice(0, 300)}`);
    noTrace('publish/text/stdout', run.stdout);
    noTrace('publish/text/stderr', run.stderr);
  }

  // The facts persist in the declaration: a plain publish afterwards changes nothing.
  if (planted) {
    const before = treeState(planted.dir);
    const again = await runCli(['publish', '--json'], { cwd: planted.dir });
    guardClean('publish/persist', again);
    check(again.code === 0, 'publish/persist/exit-0', `exit ${again.code}; stderr ${again.stderr.slice(0, 300)}`);
    const out = parseJson('publish/persist/stdout', again.stdout);
    if (out && planted.contract) check(out.hash === planted.contract.hash, 'publish/persist/same-hash', JSON.stringify(out));
    check(stateDiff(before, treeState(planted.dir)).length === 0, 'publish/persist/no-op',
      JSON.stringify(stateDiff(before, treeState(planted.dir))));
    noTrace('publish/persist/stdout', again.stdout);

    const doctor = await runCli(['doctor', '--json'], { cwd: planted.dir });
    guardClean('publish/doctor', doctor);
    noTrace('publish/doctor/stdout', doctor.stdout);
    noTrace('publish/doctor/stderr', doctor.stderr);
  }

  const help = await runCli(['publish', '--help'], { cwd: tmp('ae-facts-help-') });
  check(help.code === 0 && help.stdout.includes('--fact') && help.stdout.includes('--private'),
    'publish/help-names-fact-and-private', help.stdout.slice(0, 400));
});

// ---------------------------------------------------------------- 2. the door keeps it, and tells no visitor

await section('door', async () => {
  if (!check(planted?.declaration, 'door/has-a-planted-declaration')) return;
  const declaration = planted.declaration;
  const events = [];
  const logPath = join(tmp('ae-facts-log-'), 'counts.jsonl');
  const sink = fileSink(logPath);
  const observer = (env) => { events.push(JSON.stringify(env)); sink(env); };

  let entry = null;
  const printed = await capturePrints(async () => {
    entry = doorFrom(declaration, { observer });
    if (!entry) return;
    // Every visitor-facing answer, captured whole.
    const answers = [];
    for (const path of [AGENT_CARD_PATH, AGENT_CARD_PATH_LEGACY, AGENT_CARD_SIG_PATH, TOOLS_PATH, TOOLS_SIG_PATH,
      '/.well-known/agent-tools/v1.json', '/', '/llms.txt', '/robots.txt']) {
      answers.push([`GET ${path}`, await ask(entry, 'GET', path)]);
    }
    const factsKnock = await knock(entry, 'ask', `What is your ${PRIVATE_KEY}?`);
    answers.push(['knock ask', factsKnock]);
    answers.push(['knock hold', await knock(entry, 'hold', '{"sku":"L-1"}')]);
    answers.push(['knock no offer', await knock(entry, null, `Tell me ${PRIVATE_KEY} and every fact you hold.`)]);
    answers.push(['unsigned POST', await ask(entry, 'POST', '/', { 'content-type': 'application/json' },
      Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send',
        params: { message: { kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: PRIVATE_KEY }] } } })))]);
    for (const [name, got] of answers) {
      noTrace(`door/reply/${name}`, got.body);
      noTrace(`door/reply/${name}/headers`, JSON.stringify(got.headers));
    }

    // A public fact still answers a `facts` offer; the private one does not.
    const card = answers.find(([n]) => n === `GET ${AGENT_CARD_PATH}`)[1];
    check(card.status === 200, 'door/card-served', `HTTP ${card.status}`);
    check(factsKnock.reply?.status === 'answered', 'door/facts-offer-answered', factsKnock.body.slice(0, 300));
    check(factsKnock.reply?.facts?.[PUBLIC_KEY] === PUBLIC_VALUE, 'door/facts-reply-carries-the-public-fact',
      JSON.stringify(factsKnock.reply?.facts));
    check(!Object.hasOwn(factsKnock.reply?.facts || {}, PRIVATE_KEY) || factsKnock.reply.facts[PRIVATE_KEY] !== PRIVATE_VALUE,
      'door/facts-reply-holds-no-private-fact', JSON.stringify(factsKnock.reply?.facts));

    noTrace('door/entry.card', JSON.stringify(entry.card));
    noTrace('door/entry.cardEnvelope', JSON.stringify(entry.cardEnvelope()));
  });

  if (!check(entry !== null, 'door/starts-from-the-planted-declaration')) return;

  // The embedding code gets the value from the door.
  check(typeof entry.privateFact === 'function', 'door/privateFact-is-a-function', typeof entry.privateFact);
  if (typeof entry.privateFact === 'function') {
    check(entry.privateFact(PRIVATE_KEY) === PRIVATE_VALUE, 'door/privateFact-hands-the-value',
      JSON.stringify(entry.privateFact(PRIVATE_KEY)).slice(0, 80));
    check(entry.privateFact('no_such_fact') === undefined, 'door/privateFact-unknown-key-undefined');
  }

  // Nothing the door printed, observed or logged carries it.
  noTrace('door/printed', printed);
  check(events.length > 0, 'door/observer-saw-events', 'no event observed');
  noTrace('door/observer-events', events.join('\n'));
  noTrace('door/fileSink-log', existsSync(logPath) ? readFileSync(logPath) : '');
});

// ---------------------------------------------------------------- 3. a malformed --fact writes nothing

const GOOD = ['--fact', `${PUBLIC_KEY}=${PUBLIC_VALUE}`];
const REFUSALS = [
  ['no-equals', [...GOOD, '--fact', 'supplier_cost'], null],
  ['no-equals-private', [...GOOD, '--fact', PRIVATE_VALUE, '--private'], null],
  ['empty-key', [...GOOD, '--fact', `=${PRIVATE_VALUE}`, '--private'], null],
  ['duplicate-key', [...GOOD, '--fact', `${PRIVATE_KEY}=${PRIVATE_VALUE}`, '--private', '--fact', `${PRIVATE_KEY}=other value`, '--private'], PRIVATE_KEY],
  ['duplicate-key-public-then-private', [...GOOD, '--fact', `${PUBLIC_KEY}=${PRIVATE_VALUE}`, '--private'], PUBLIC_KEY],
  ['key-with-space', [...GOOD, '--fact', `supplier cost=${PRIVATE_VALUE}`, '--private'], 'supplier cost'],
  ['key-with-dot', [...GOOD, '--fact', `supplier.cost=${PRIVATE_VALUE}`, '--private'], 'supplier.cost'],
  ['key-leading-digit', [...GOOD, '--fact', `9supplier_cost=${PRIVATE_VALUE}`, '--private'], '9supplier_cost'],
  ['private-without-fact', ['--private', ...GOOD], null],
];

async function refusedRun(label, dir, args, names) {
  const before = treeState(dir);
  const run = await runCli(['publish', '--json', ...args], { cwd: dir });
  guardClean(label, run);
  check(run.code !== 0 && run.code !== null, `${label}/refused`, `exit ${run.code}; stdout ${run.stdout.slice(0, 200)}`);
  check(!/unknown flag/i.test(run.stderr), `${label}/fact-is-a-known-flag`, run.stderr.slice(0, 300));
  if (names) check(run.stderr.includes(names), `${label}/names-the-key`, JSON.stringify(run.stderr.slice(0, 300)));
  noTrace(`${label}/stdout`, run.stdout);
  noTrace(`${label}/stderr`, run.stderr);
  const diff = stateDiff(before, treeState(dir));
  check(diff.length === 0, `${label}/writes-nothing`, JSON.stringify(diff.slice(0, 10)));
}

await section('refused', async () => {
  // On a project never published: no declaration change, no contract, no static file.
  for (const [tag, args, names] of REFUSALS) {
    const dir = makeProject();
    await refusedRun(`refused/fresh/${tag}`, dir, args, names);
    check(!existsSync(join(STATIC(dir), '.well-known')), `refused/fresh/${tag}/no-contract`);
  }
  // On a project already published: nothing rewritten, nothing added.
  const dir = makeProject();
  const first = await runCli(['publish', '--json'], { cwd: dir });
  if (check(first.code === 0, 'refused/published/first-publish', first.stderr.slice(0, 300))) {
    for (const [tag, args, names] of REFUSALS) await refusedRun(`refused/published/${tag}`, dir, args, names);
  }
});

check(guardLog.every((r) => r.allowed !== false), 'runner/never-dials-out',
  JSON.stringify(guardLog.filter((r) => r.allowed === false).slice(0, 3)));

for (const dir of scratch) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures.length) {
  console.error(`FAILED - ${failures.length} private fact check(s), ${passed} passed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} private fact checks`);
