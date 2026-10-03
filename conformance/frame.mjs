#!/usr/bin/env node
// The frame (owner ruling 2026-10-03, intake 20261003T131708Z): the one test that walks the
// product's thin line end to end, on fixtures and a local door --
//
//   one WooCommerce shop -> its declaration -> a door that is its claim -> a visiting agent finds,
//   asks, holds -> the owner approves and the customer gets a signed follow-up -> the owner reads
//   who came and who came back.
//
// WRITTEN BEFORE THE IMPLEMENTATIONS (test author only; no implementer pair). Each step is its own
// top-level test, named after the frame member that makes it green, so a red run says which
// member is missing. A step whose member has already landed may come up green; the file as a
// whole stays red until the last member lands, and is NOT wired into conformance/run.mjs or
// `npm test` until then. Run it as `node conformance/frame.mjs`. The member implementers may not
// edit this file.
//
// What each step pins (the CLI is `node muretai-agent-entry.mjs <verb> ...`, the package bin):
//   1 Woo-2 (20261003T001757Z)   `init --from woocommerce <store> --facts <file>` in a project dir
//        writes agent-entry.json: it validates, names the store's origin as entry.baseUrl, carries
//        the facts file's ten facts as `facts`, and an offer of verb `ask` answered at the door by
//        `facts`. It reads only the store's public Store API (and robots.txt). Refusals: a store
//        that is not https (Woo-1, landed 49930bf) and an incomplete facts file write nothing.
//   2 the door (Suite S1, landed) started from that declaration serves the card and its signature,
//        /.well-known/agent-tools.json and /.well-known/agent-tools.sig.json, all verifying.
//   3 Claim-2 (20261003T131709Z-2)   `publish --claim <32 lowercase hex>` records the code in the
//        door's config (agent-entry.json), and a door started from it serves
//        /.well-known/muretai-catalog-claim.txt with the body exactly `muretai-catalog-claim=<code>`
//        (trunk catalog/service.py:46-49), text/plain; 404 before. A code that is not 32 hex is
//        refused and writes nothing.
//   4 AT-12/AT-13 at the door, S6b-1 (`knock --offer`, landed 9e58808)   `knock --offer find`,
//        `ask`, `hold`: find answers see_catalog, ask answers the facts, hold answers
//        pending_confirmation with a deal receipt signed by the shop for this customer.
//   5 Answer-1 (20261003T131710Z)   `decide <receipt file> approve --to <customer card url>` sends
//        the customer's DID a signed message/send whose text the customer reads as its booking:
//        status confirmed, the same termsHash, the shop's fresh signature over it. Sent once per
//        receipt; a receipt that does not verify against the shop's key is refused, nothing sent.
//   6a Analytics-1 (20261003T131711Z)   `counts --json` opens with a coverage header (log range,
//        last event, store present) and counts the door knocks under who.signed, who.declared and
//        who.network.
//   6b Analytics-2 (20261003T131711Z-2)   every answered POST row in the fileSink log carries
//        first_contact: true on the customer's first knock, false after; counts shows new vs
//        returning knocks.
//
// Frame choices a member must honour (none is invented beyond what its intake names):
//   - Woo-2's ten facts: the six the intake names plus the four its open question proposes
//     (address, warranty, holidays, languages): fixtures/frame/facts.json.
//   - find and hold are Woo-4/Woo-5, which the frame pass files as polish. Until the generated
//     declaration carries them, the frame's door adds the retail starter's door-bound `find` and
//     `hold` (OFFER_STARTERS.retail) beside what init wrote, so step 4 never waits on polish.
//   - The door is started from agent-entry.json exactly as it is on disk after each CLI step
//     (plus those two starter offers), with the project's own seed when init minted one, else the
//     fixture seed, which every CLI child also gets as AGENT_ENTRY_SEED_HEX.
//   - The store and the door share one https origin on 127.0.0.1 (the shop answers its own Store
//     API; everything else is the door), with the test CA of fixtures/cli/woo handed to every
//     child as NODE_EXTRA_CA_CERTS: trust is added, verification is never turned off.
//   - When a step's member has not landed, the next step proceeds from a stand-in so that its own
//     red names its own member, not the one before it.
//
// THE FRAME NEVER DIALS OUT: every CLI child runs with fixtures/cli/loopback-only.mjs preloaded,
// and the runner imports the same guard.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { guardLog } from './fixtures/cli/loopback-only.mjs';
import * as door from '../muretai-agent-entry.mjs';

const {
  AGENT_CARD_PATH, AGENT_CARD_SIG_PATH, AI_AGENT_FAMILIES, OFFER_STARTERS, REFERRAL_ENGINES, TOOLS_PATH,
  TOOLS_SIG_PATH, VENDORS, canonicalBytes, canonicalJSON, compileDeclaration, createAgentEntry,
  createFileStore, didFromSeedHex, fileSink, knockAgentEntry, publicKeyHexFromDid, signBytes,
  validateDeclaration, verifyBytes, verifyCardEnvelope, verifyToolsEnvelope,
} = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'muretai-agent-entry.mjs');
const FIX = join(HERE, 'fixtures', 'frame');
const WOO_FIX = join(HERE, 'fixtures', 'cli', 'woo');
const GUARD = join(HERE, 'fixtures', 'cli', 'loopback-only.mjs');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const PAGES = [readFileSync(join(FIX, 'store-api-products-page-1.json')), readFileSync(join(FIX, 'store-api-products-page-2.json'))];
const FACTS_FILE = join(FIX, 'facts.json');
const FACTS = readJson(FACTS_FILE);
const SEEDS = readJson(join(FIX, 'seed.json'));
const CA = readFileSync(join(WOO_FIX, 'test-ca.pem'));
const TLS = { key: readFileSync(join(WOO_FIX, 'store-key.pem')), cert: readFileSync(join(WOO_FIX, 'store-cert.pem')) };
const CHILD_TLS = { NODE_EXTRA_CA_CERTS: join(WOO_FIX, 'test-ca.pem') };

const WOO_PRODUCTS = '/wp-json/wc/store/v1/products';
const CLAIM_PATH = '/.well-known/muretai-catalog-claim.txt';
const CLAIM_CODE = '3f9c2a7e1b4d8065c2e9a1f7b3d5c804';
const CLAIM_MAX_BYTES = 4096;                       // trunk catalog/service.py CLAIM_FILE_MAX_BYTES
const SEED_IN_FILE = /^[ \t]*(?:export[ \t]+)?AGENT_ENTRY_SEED_HEX[ \t]*=[ \t]*["']?([0-9a-f]{64})["']?[ \t]*\r?$/m;
const CUSTOMER_DID = didFromSeedHex(SEEDS.customer);
const DOOR_STAGES = new Set(['signed_post', 'anon_post', 'refused_post']);
const NETWORK_VENDOR = 'anthropic';                 // the frame door's vendorRanges give it 127.0.0.0/8
const DECLARED_UA = 'Claude-User/1.0 (+https://www.anthropic.com/claude-user)';

// ---------------------------------------------------------------- scratch, children

const scratch = [];
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const HOME = tmp('ae-frame-home-');
writeFileSync(join(HOME, '.gitconfig-empty'), '');
const KNOCK_KEY = join(HOME, 'knock-seed');
writeFileSync(KNOCK_KEY, `${SEEDS.customer}\n`, { mode: 0o600 });

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
    AGENT_ENTRY_KNOCK_KEY: KNOCK_KEY,
    AGENT_ENTRY_SEED_HEX: SEEDS.shop,
    ...CHILD_TLS,
  };
}

/** Run the bin with the loopback guard preloaded: { code, stdout, stderr, guard, timedOut }. */
function runCli(args, { cwd, env = {}, timeout = 60000 } = {}) {
  const log = join(tmp('ae-frame-guard-'), 'guard.jsonl');
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(GUARD).href, BIN, ...args], {
      cwd: cwd || tmp('ae-frame-cwd-'), env: { ...baseEnv(), ...env, AE_CLI_GUARD_LOG: log },
      stdio: ['ignore', 'pipe', 'pipe'],
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

const said = (run) => `exit ${run.code}; stdout ${JSON.stringify(run.stdout.slice(0, 400))}; stderr ${JSON.stringify(run.stderr.slice(0, 400))}`;

/** Every child: finished, the guard loaded, nothing tried to leave the machine. */
function assertStayedHome(run, what) {
  assert.ok(!run.timedOut, `${what}: timed out`);
  assert.ok(run.guard.some((r) => r.kind === 'loaded'), `${what}: the loopback guard did not load`);
  const blocked = run.guard.filter((r) => r.allowed === false);
  assert.deepEqual(blocked, [], `${what}: tried to dial out`);
}

/** A project directory the way a shop owner starts one: an empty git repository that ignores env files. */
function makeProject() {
  const dir = tmp('ae-frame-shop-');
  writeFileSync(join(dir, '.gitignore'), '.env\n.env.local\nnode_modules/\n');
  spawnSync('git', ['init', '-q'], { cwd: dir, env: baseEnv() });
  return dir;
}

// ---------------------------------------------------------------- https on 127.0.0.1 with the test CA

/** A fetch for knockAgentEntry and the runner's own GETs that trusts the test CA (and nothing is disabled). */
function caFetch(url, { method = 'GET', headers = {}, body = null } = {}) {
  const u = new URL(url);
  const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolveFetch, reject) => {
    const req = send(u, { method, headers, ...(u.protocol === 'https:' ? { ca: CA } : {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveFetch({ status: res.statusCode, headers: res.headers, text: async () => text, body: text });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`timeout ${url}`)));
    if (body !== null) req.write(body);
    req.end();
  });
}

/** One https listener on 127.0.0.1. `route(req, body)` answers or returns null for "the door". */
function startHttps(handle) {
  return new Promise((resolveStart) => {
    const sockets = new Set();
    const server = createHttpsServer(TLS, (req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        Promise.resolve()
          .then(() => handle(req, Buffer.concat(chunks)))
          .then((out) => {
            res.writeHead(out.status, out.headers || {});
            res.end(req.method === 'HEAD' ? undefined : out.body);
          })
          .catch(() => { res.writeHead(500); res.end(); });
      });
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.on('tlsClientError', () => { /* a client that hung up mid-handshake */ });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({ port, origin: `https://127.0.0.1:${port}`,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) });
    });
  });
}

const viaEntry = (entry, req, body) => entry.handleRequestAsync(req.method, req.url, req.headers, body,
  { remoteAddress: req.socket ? req.socket.remoteAddress : undefined });

// ---------------------------------------------------------------- the shop: its Store API and its door

const state = {
  shop: null,             // the https listener: Store API + door, one origin
  hits: [],               // every request the shop was asked, in order
  entry: null,            // the door currently answering at the shop's origin
  project: null,          // the shop's project directory (init / publish / decide run here)
  dataDir: null,          // the fileSink log and the file store
  declaration: null,      // what step 1 left in agent-entry.json (or the stand-in)
  receiptFile: null,      // step 4's hold reply, for decide
  hold: null,             // step 4's parsed hold reply
  customer: null,         // the customer's own door (step 5)
  inbox: [],              // what the customer's door was sent
};

function storeApi(req) {
  const url = new URL(req.url, 'https://store.invalid');
  if (url.pathname === '/robots.txt') {
    return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'User-agent: *\nAllow: /\n' };
  }
  if (url.pathname.replace(/\/$/, '') !== WOO_PRODUCTS) return null;
  const page = Number(url.searchParams.get('page') || '1');
  const headers = { 'content-type': 'application/json; charset=UTF-8', 'x-wp-total': '3', 'x-wp-totalpages': String(PAGES.length) };
  if (!Number.isInteger(page) || page < 1 || page > PAGES.length) {
    return { status: 400, headers, body: JSON.stringify({ code: 'rest_invalid_param', message: 'Invalid parameter(s): page', data: { status: 400 } }) };
  }
  return { status: 200, headers, body: PAGES[page - 1] };
}

const logPath = () => join(state.dataDir, 'counts.jsonl');
const storePath = () => join(state.dataDir, 'store.json');

/** The seed the shop's door signs with: the one init minted into the project, else the fixture's. */
function shopSeed() {
  for (const rel of ['.env.local', '.env']) {
    try {
      const m = SEED_IN_FILE.exec(readFileSync(join(state.project, rel), 'utf8'));
      if (m) return m[1];
    } catch { /* not there */ }
  }
  return SEEDS.shop;
}

/** What init wrote, plus the retail starter's door-bound find and hold when it carries neither. */
function doorDeclaration(onDisk) {
  const declaration = JSON.parse(JSON.stringify(onDisk));
  for (const verb of ['find', 'hold']) {
    if (declaration.offers.some((o) => o.verb === verb && o.door)) continue;
    declaration.offers.push(JSON.parse(JSON.stringify(OFFER_STARTERS.retail.find((o) => o.verb === verb))));
  }
  return declaration;
}

/** (Re)start the shop's door from agent-entry.json as it is on disk now. */
function startDoorFromProject() {
  const onDisk = readJson(join(state.project, 'agent-entry.json'));
  const declaration = doorDeclaration(onDisk);
  state.entry = createAgentEntry({
    seedHex: shopSeed(),
    name: declaration.entry.name,
    baseUrl: declaration.entry.baseUrl,
    declaration,
    store: createFileStore(storePath()),
    observer: fileSink(logPath()),
    vendorRanges: { [NETWORK_VENDOR]: ['127.0.0.0/8'] },
  });
  return state.entry;
}

/** The stand-in a later step proceeds from when step 1's member has not landed. */
function standInDeclaration() {
  return {
    v: 1,
    entry: { name: 'Harbor Lamp', baseUrl: state.shop.origin },
    facts: { ...FACTS },
    offers: [{ verb: 'ask', of: 'shop', about: 'Ask the shop about hours, shipping, returns, payment and pickup.',
      input: { text: 'string' }, door: { reply: 'facts' } }],
  };
}

function ensureDeclaration() {
  const path = join(state.project, 'agent-entry.json');
  let ok = false;
  try { validateDeclaration(readJson(path)); ok = true; } catch { /* missing or not valid */ }
  if (!ok) writeFileSync(path, `${JSON.stringify(standInDeclaration(), null, 2)}\n`);
  if (!state.entry) startDoorFromProject();
}

const cardUrl = () => `${state.shop.origin}${AGENT_CARD_PATH}`;

async function getJson(url) {
  const res = await caFetch(url, { headers: { accept: 'application/json' } });
  assert.equal(res.status, 200, `GET ${url} -> ${res.status}: ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body);
}

function logRows() {
  if (!existsSync(logPath())) return [];
  return readFileSync(logPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** The deal block's signature and commitment (AT-12): signed by partyA over the seven fields,
 *  and termsHash = sha256(canonical {terms} || salt), terms being the reply without `deal`. */
function assertDeal(reply, { signer, what }) {
  const { deal, ...terms } = reply;
  assert.ok(deal && typeof deal === 'object', `${what}: no deal block in ${JSON.stringify(reply).slice(0, 300)}`);
  assert.equal(deal.type, 'DealReceipt', `${what}: deal.type`);
  assert.equal(deal.partyA, signer, `${what}: deal.partyA is the shop`);
  assert.equal(deal.partyB, CUSTOMER_DID, `${what}: deal.partyB is the customer`);
  assert.match(String(deal.termsHash), /^[0-9a-f]{64}$/, `${what}: deal.termsHash`);
  const payload = canonicalBytes({ type: 'DealReceipt', partyA: deal.partyA, partyB: deal.partyB,
    termsHash: deal.termsHash, contextId: deal.contextId, ref: deal.ref, ts: deal.ts });
  const ok = verifyBytes(Buffer.from(publicKeyHexFromDid(signer), 'hex'), Buffer.from(String(deal.sigA), 'base64'), payload);
  assert.ok(ok, `${what}: deal.sigA does not verify against the shop's key`);
  return { deal, terms };
}

before(async () => {
  state.shop = await startHttps((req, body) => {
    state.hits.push({ method: req.method, url: req.url });
    const api = storeApi(req);
    if (api) return api;
    if (!state.entry) return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'no door yet' };
    return viaEntry(state.entry, req, body);
  });
  state.project = makeProject();
  state.dataDir = tmp('ae-frame-data-');
});

after(async () => {
  if (state.shop) await state.shop.close();
  if (state.customer) await state.customer.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 1. Woo-2: the shop's declaration

test('frame 1 [Woo-2 20261003T001757Z]: init --from woocommerce <store> --facts <file> writes agent-entry.json with an ask offer', async () => {
  const before1 = state.hits.length;
  const run = await runCli(['init', '--from', 'woocommerce', state.shop.origin, '--facts', FACTS_FILE], { cwd: state.project });
  assertStayedHome(run, 'init --from woocommerce');
  assert.equal(run.code, 0, `init --from woocommerce must succeed on a reachable https Store API: ${said(run)}`);
  const path = join(state.project, 'agent-entry.json');
  assert.ok(existsSync(path), 'init --from woocommerce wrote no agent-entry.json');
  const declaration = readJson(path);
  validateDeclaration(declaration);
  assert.equal(new URL(declaration.entry.baseUrl).origin, state.shop.origin, 'entry.baseUrl names the store it was read from');
  assert.deepEqual(declaration.facts, FACTS, 'the declaration carries the facts file, all ten, as written');
  const ask = declaration.offers.filter((o) => o.verb === 'ask');
  assert.equal(ask.length, 1, `exactly one ask offer: ${JSON.stringify(declaration.offers).slice(0, 300)}`);
  assert.equal(ask[0].door?.reply, 'facts', 'the ask offer is answered at the door from the facts');
  assert.ok(!declaration.offers.some((o) => o.verb === 'buy' || o.verb === 'pay'), 'no payment verb is generated');
  assert.equal(canonicalJSON(compileDeclaration(declaration)), canonicalJSON(compileDeclaration(JSON.parse(JSON.stringify(declaration)))),
    'the declaration compiles deterministically');
  const asked = state.hits.slice(before1).map((h) => new URL(h.url, 'https://x.invalid').pathname.replace(/\/$/, ''));
  assert.ok(asked.includes(WOO_PRODUCTS), `init read the public Store API products path: ${JSON.stringify(asked)}`);
  assert.deepEqual(asked.filter((p) => p !== WOO_PRODUCTS && p !== '/robots.txt'), [],
    'init reads the public Store API (and robots.txt) only');
  assert.ok(!`${run.stdout}${run.stderr}`.includes(shopSeed()), 'the seed is never printed');
});

test('frame 1 refusals [Woo-1 landed 49930bf, Woo-2]: a non-https store and an incomplete facts file write nothing', async () => {
  {
    const dir = makeProject();
    const run = await runCli(['init', '--from', 'woocommerce', state.shop.origin.replace('https:', 'http:'), '--facts', FACTS_FILE], { cwd: dir });
    assertStayedHome(run, 'init --from woocommerce http://');
    assert.equal(run.code, 1, `a store that is not https is refused: ${said(run)}`);
    assert.match(run.stderr, /\bhttps\b/i, 'the refusal names https');
    assert.ok(!existsSync(join(dir, 'agent-entry.json')), 'a refusal writes no agent-entry.json');
  }
  {
    const dir = makeProject();
    const partial = { ...FACTS };
    delete partial.returns;
    const file = join(dir, 'facts-incomplete.json');
    writeFileSync(file, JSON.stringify(partial));
    const run = await runCli(['init', '--from', 'woocommerce', state.shop.origin, '--facts', file], { cwd: dir });
    assertStayedHome(run, 'init --from woocommerce --facts <incomplete>');
    assert.notEqual(run.code, 0, `an incomplete facts file is refused, not used partially: ${said(run)}`);
    assert.match(run.stderr, /returns/, 'the refusal names the missing fact');
    assert.ok(!existsSync(join(dir, 'agent-entry.json')), 'a refusal writes no agent-entry.json');
  }
});

// ---------------------------------------------------------------- 2. the door from that declaration

test('frame 2 [Suite S1 door, landed]: the door started from that declaration serves the card, agent-tools.json and its .sig', async () => {
  ensureDeclaration();
  const entry = startDoorFromProject();
  const card = await getJson(cardUrl());
  assert.equal(card.did, entry.did, 'the card names the door key');
  assert.equal(card.url, state.shop.origin, 'the card names the shop origin');
  assert.ok(card.skills.some((s) => s.tags?.[0] === 'ask'), 'the card lists the ask offer');
  const cardSig = await getJson(`${state.shop.origin}${AGENT_CARD_SIG_PATH}`);
  assert.ok(verifyCardEnvelope(cardSig, card.did), 'the card signature verifies');
  const contract = await getJson(`${state.shop.origin}${TOOLS_PATH}`);
  assert.ok(contract.offers.some((o) => o.verb === 'ask' && o.door?.reply === 'facts'), 'the contract carries the ask offer');
  const toolsSig = await getJson(`${state.shop.origin}${TOOLS_SIG_PATH}`);
  const verified = verifyToolsEnvelope(toolsSig, card.did, { origin: state.shop.origin });
  assert.ok(verified, 'agent-tools.sig.json verifies against the card key and the shop origin');
  assert.equal(canonicalJSON(verified), canonicalJSON(contract), 'the signed contract is the served one');
});

// ---------------------------------------------------------------- 3. Claim-2: the door is the claim

test('frame 3 [Claim-2 20261003T131709Z-2]: publish --claim <32 hex> makes the door serve muretai-catalog-claim.txt', async () => {
  ensureDeclaration();
  startDoorFromProject();
  const before3 = await caFetch(`${state.shop.origin}${CLAIM_PATH}`);
  assert.equal(before3.status, 404, 'no claim file before a code is set');
  const run = await runCli(['publish', '--claim', CLAIM_CODE], { cwd: state.project });
  assertStayedHome(run, 'publish --claim');
  assert.equal(run.code, 0, `publish --claim <32 hex> succeeds: ${said(run)}`);
  startDoorFromProject();
  const res = await caFetch(`${state.shop.origin}${CLAIM_PATH}`, { headers: { accept: 'text/plain' } });
  assert.equal(res.status, 200, `the door serves ${CLAIM_PATH} after publish --claim`);
  assert.match(String(res.headers['content-type']), /^text\/plain\b/, 'served as text/plain');
  assert.equal(res.body, `muretai-catalog-claim=${CLAIM_CODE}`, 'the body is exactly the Catalog proof line');
  assert.ok(Buffer.byteLength(res.body) <= CLAIM_MAX_BYTES, 'within the Catalog reader bound');
  // trunk's reader (catalog/service.py _proof_file): lines, each stripped, one must equal the proof.
  assert.ok(res.body.split(/\r?\n/).map((l) => l.trim()).includes(`muretai-catalog-claim=${CLAIM_CODE}`),
    'the Catalog reader finds the proof line');
});

test('frame 3 refusals [Claim-2]: a claim code that is not 32 lowercase hex is refused and changes nothing', async () => {
  ensureDeclaration();
  const path = join(state.project, 'agent-entry.json');
  const before3 = readFileSync(path);
  for (const bad of ['3f9c2a7e1b4d8065c2e9a1f7b3d5c80', `${CLAIM_CODE}0`, CLAIM_CODE.toUpperCase(), 'not-a-claim-code-at-all-00000000']) {
    const run = await runCli(['publish', '--claim', bad], { cwd: state.project });
    assertStayedHome(run, `publish --claim ${bad}`);
    assert.notEqual(run.code, 0, `publish --claim ${JSON.stringify(bad)} is refused: ${said(run)}`);
    assert.match(run.stderr, /claim/i, 'the refusal names the claim code');
    assert.ok(readFileSync(path).equals(before3), 'a refused code leaves agent-entry.json byte for byte');
  }
});

// ---------------------------------------------------------------- 4. find, ask, hold at the door

async function knock(offer, text) {
  return runCli(['knock', cardUrl(), '--offer', offer], { cwd: state.project, env: { AGENT_ENTRY_KNOCK_TEXT: text } });
}

function knockReply(run, what) {
  assertStayedHome(run, what);
  assert.equal(run.code, 0, `${what} is answered: ${said(run)}`);
  const reply = JSON.parse(run.stdout.trim());
  assert.equal(reply.customer_did, CUSTOMER_DID, `${what}: the reply is filed under this customer`);
  return reply;
}

test('frame 4 [AT-12/AT-13 door, S6b-1 landed 9e58808]: knock --offer find, ask, hold: catalog, facts, pending with a deal receipt', async () => {
  ensureDeclaration();
  if (!state.entry) startDoorFromProject();
  const shopDid = state.entry.did;

  const find = knockReply(await knock('find', 'find products {"q":"brass lamp"}'), 'knock --offer find');
  assert.equal(find.verb, 'find');
  assert.equal(find.status, 'see_catalog', 'find answers catalog');

  const ask = knockReply(await knock('ask', 'When are you open, and do you ship to Germany?'), 'knock --offer ask');
  assert.equal(ask.verb, 'ask');
  assert.equal(ask.status, 'answered', 'ask answers facts');
  assert.deepEqual(ask.facts, readJson(join(state.project, 'agent-entry.json')).facts, 'ask answers the declared facts');

  const holdRun = await knock('hold', 'hold item {"sku":"L-12"}');
  const hold = knockReply(holdRun, 'knock --offer hold');
  assert.equal(hold.verb, 'hold');
  assert.equal(hold.status, 'pending_confirmation', 'hold answers pending');
  const { deal, terms } = assertDeal(hold, { signer: shopDid, what: 'the hold receipt' });
  const commitment = createHash('sha256')
    .update(Buffer.concat([canonicalBytes({ terms }), Buffer.from(String(deal.salt), 'base64')])).digest('hex');
  assert.equal(commitment, deal.termsHash, 'termsHash commits to the reply without its deal block');
  state.hold = hold;
  state.receiptFile = join(state.project, 'hold-receipt.json');
  writeFileSync(state.receiptFile, holdRun.stdout.trim());
});

test('frame 4 refusals [AT-11 door]: an offer the door does not make, and an unsigned POST, are refused', async () => {
  ensureDeclaration();
  const run = await knock('pay_now', 'pay now');
  assertStayedHome(run, 'knock --offer pay_now');
  assert.equal(run.code, 1, `an offer the door does not make is refused: ${said(run)}`);
  assert.match(run.stderr, /Refused/, 'the knock says it was refused');
  const res = await caFetch(`${state.shop.origin}/`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'x1', method: 'message/send', params: { message: {
      kind: 'message', role: 'user', messageId: 'x1', parts: [{ kind: 'text', text: 'hold item {"sku":"L-12"}' }],
      metadata: { offer: 'hold' } } } }),
  });
  const body = JSON.parse(res.body);
  assert.ok(body.error, `an unsigned hold is refused, never answered with a receipt: ${res.body.slice(0, 300)}`);
  assert.ok(!res.body.includes('DealReceipt'), 'no receipt for an unsigned knock');
});

// ---------------------------------------------------------------- 5. Answer-1: the owner approves

/** A receipt to decide on: step 4's hold, or (when step 4 is red) one the stand-in door issues in-process. */
async function ensureReceipt() {
  if (state.receiptFile && existsSync(state.receiptFile)) return;
  ensureDeclaration();
  const result = await knockAgentEntry(cardUrl(), { offer: 'hold', text: 'hold item {"sku":"L-12"}', keyPath: KNOCK_KEY, fetchImpl: caFetch });
  assert.ok(result.ok && result.booking, `the stand-in hold must be answered: ${JSON.stringify(result).slice(0, 300)}`);
  state.hold = result.booking;
  state.receiptFile = join(state.project, 'hold-receipt.json');
  writeFileSync(state.receiptFile, result.text);
}

async function ensureCustomerDoor() {
  if (state.customer) return;
  let entry = null;
  state.customer = await startHttps((req, body) => (entry
    ? viaEntry(entry, req, body)
    : { status: 404, headers: {}, body: '' }));
  entry = createAgentEntry({
    seedHex: SEEDS.customer,
    name: 'The customer',
    baseUrl: state.customer.origin,
    responder: (env) => { state.inbox.push(env); return 'received'; },
  });
}

async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

test('frame 5 [Answer-1 20261003T131710Z]: decide <receipt> approve sends the signed follow-up the customer reads as confirmed', async () => {
  await ensureReceipt();
  await ensureCustomerDoor();
  const shopDid = state.entry.did;
  const sent = state.inbox.length;
  const to = `${state.customer.origin}${AGENT_CARD_PATH}`;
  const run = await runCli(['decide', state.receiptFile, 'approve', '--to', to], { cwd: state.project });
  assertStayedHome(run, 'decide approve');
  assert.equal(run.code, 0, `decide <receipt> approve succeeds: ${said(run)}`);
  assert.ok(await waitFor(() => state.inbox.length > sent), 'the customer\'s door received the follow-up through message/send');
  assert.equal(state.inbox.length, sent + 1, 'exactly one follow-up');
  const env = state.inbox[state.inbox.length - 1];
  assert.equal(env.verified, true, 'the follow-up is a verified signed message');
  assert.equal(env.peer_did, shopDid, 'signed by the shop\'s door key');
  // What the customer's checkedBookingReceipt reads: the Suite shape filed under this customer.
  const follow = JSON.parse(env.text);
  assert.equal(follow.customer_did, CUSTOMER_DID, 'filed under the customer\'s DID');
  assert.equal(follow.verb, state.hold.verb);
  assert.equal(follow.of, state.hold.of);
  assert.equal(typeof follow.request, 'string');
  assert.equal(follow.status, 'confirmed', 'the booking now reads confirmed');
  const { deal } = assertDeal(follow, { signer: shopDid, what: 'the follow-up deal' });
  assert.equal(deal.termsHash, state.hold.deal.termsHash, 'the follow-up re-signs the same termsHash: the two receipts chain');
});

test('frame 5 refusals [Answer-1]: once per receipt; a receipt the shop did not sign is refused and nothing is sent', async () => {
  await ensureReceipt();
  await ensureCustomerDoor();
  const to = `${state.customer.origin}${AGENT_CARD_PATH}`;
  const sent = state.inbox.length;

  const again = await runCli(['decide', state.receiptFile, 'approve', '--to', to], { cwd: state.project });
  assertStayedHome(again, 'decide approve (again)');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(state.inbox.length, sent, `a second decide on the same receipt sends nothing: ${said(again)}`);

  const tampered = JSON.parse(readFileSync(state.receiptFile, 'utf8'));
  tampered.deal.termsHash = createHash('sha256').update('other terms').digest('hex');
  const tamperedFile = join(state.project, 'hold-receipt-tampered.json');
  writeFileSync(tamperedFile, JSON.stringify(tampered));
  const bad = await runCli(['decide', tamperedFile, 'approve', '--to', to], { cwd: state.project });
  assertStayedHome(bad, 'decide approve <tampered>');
  assert.notEqual(bad.code, 0, `a receipt whose signature does not verify is refused: ${said(bad)}`);

  const foreign = JSON.parse(readFileSync(state.receiptFile, 'utf8'));
  const stranger = 'c3'.repeat(32);
  foreign.deal.partyA = didFromSeedHex(stranger);
  foreign.deal.sigA = signBytes(stranger, canonicalBytes({ type: 'DealReceipt', partyA: foreign.deal.partyA,
    partyB: foreign.deal.partyB, termsHash: foreign.deal.termsHash, contextId: foreign.deal.contextId,
    ref: foreign.deal.ref, ts: foreign.deal.ts })).toString('base64');
  const foreignFile = join(state.project, 'hold-receipt-foreign.json');
  writeFileSync(foreignFile, JSON.stringify(foreign));
  const other = await runCli(['decide', foreignFile, 'approve', '--to', to], { cwd: state.project });
  assertStayedHome(other, 'decide approve <another key\'s receipt>');
  assert.notEqual(other.code, 0, `a receipt another key issued is not this shop's to decide: ${said(other)}`);

  await new Promise((r) => setTimeout(r, 500));
  assert.equal(state.inbox.length, sent, 'no refused decide sent anything');
});

// ---------------------------------------------------------------- 6. Analytics: who came, who came back

/** Every leaf of a JSON value, with the key it sits under. */
function leaves(value, key = '', out = []) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, k, out);
  } else {
    out.push([key, value]);
  }
  return out;
}

const sameSecond = (v, t) => v === t || (typeof v === 'string' && Math.floor(Date.parse(v) / 1000) === t);
const sum = (o) => Object.values(o).reduce((a, n) => a + n, 0);

async function counts() {
  const run = await runCli(['counts', '--json', '--log', logPath(), '--store', storePath()], { cwd: state.project });
  assertStayedHome(run, 'counts --json');
  assert.equal(run.code, 0, `counts --json: ${said(run)}`);
  assert.ok(!run.stdout.includes('did:'), 'no DID anywhere in counts');
  return JSON.parse(run.stdout);
}

/** The customer knocks before the counts are read: at least two answered knocks in the log, and
 *  one of them from a declared AI client (a Claude-User UA) so the declared tier has a member. */
async function ensureKnocks() {
  ensureDeclaration();
  const answered = () => logRows().filter((r) => r.stage === 'signed_post');
  const declaredFetch = (url, init = {}) => caFetch(url, { ...init, headers: { ...(init.headers || {}), 'User-Agent': DECLARED_UA } });
  for (let i = 0; i < 2 && answered().length < 2; i += 1) {
    await knockAgentEntry(cardUrl(), { offer: 'ask', text: 'Do you ship to Germany?', keyPath: KNOCK_KEY, fetchImpl: caFetch });
  }
  if (!logRows().some((r) => r.ua_family === 'claude-user')) {
    const r = await knockAgentEntry(cardUrl(), { offer: 'ask', text: 'Is the brass lamp in stock?', keyPath: KNOCK_KEY, fetchImpl: declaredFetch });
    assert.ok(r.ok, `the declared knock is answered: ${JSON.stringify(r).slice(0, 300)}`);
  }
}

test('frame 6a [Analytics-1 20261003T131711Z]: counts --json opens with a coverage header and counts knocks under who.signed|declared|network', async () => {
  await ensureKnocks();
  const rows = logRows();
  const knocks = rows.filter((r) => DOOR_STAGES.has(r.stage));
  const out = await counts();

  const coverageKey = Object.keys(out).find((k) => /coverage|header/i.test(k));
  assert.ok(coverageKey && out[coverageKey] && typeof out[coverageKey] === 'object',
    `a coverage header object in counts --json: keys ${JSON.stringify(Object.keys(out))}`);
  const cov = leaves(out[coverageKey]);
  const firstT = rows[0].t;
  const lastT = rows[rows.length - 1].t;
  assert.ok(cov.some(([, v]) => sameSecond(v, firstT)), `the coverage header names the log's first t (${firstT}): ${JSON.stringify(out[coverageKey])}`);
  assert.ok(cov.some(([, v]) => sameSecond(v, lastT)), `the coverage header names the log's last t (${lastT}): ${JSON.stringify(out[coverageKey])}`);
  assert.ok(cov.some(([k, v]) => /store/i.test(k) && v === true), `the coverage header says the store is present: ${JSON.stringify(out[coverageKey])}`);

  assert.ok(out.who && typeof out.who === 'object', `a who block: keys ${JSON.stringify(Object.keys(out))}`);
  for (const tier of ['signed', 'declared', 'network']) {
    const map = out.who[tier];
    assert.ok(map && typeof map === 'object' && !Array.isArray(map), `who.${tier} is a map`);
    for (const [k, n] of Object.entries(map)) assert.ok(Number.isInteger(n) && n >= 0, `who.${tier}.${k} is a count`);
  }
  assert.equal(out.who.network[NETWORK_VENDOR], knocks.length,
    `every door knock came from an address the door's vendorRanges name ${NETWORK_VENDOR}: ${JSON.stringify(out.who.network)}`);
  assert.ok((out.who.declared['claude-user'] ?? 0) >= 1, `the Claude-User knock counts as declared: ${JSON.stringify(out.who.declared)}`);
  for (const family of Object.keys(out.who.declared)) {
    if (family === 'none' || family === 'stealth-agent') continue;
    assert.ok(AI_AGENT_FAMILIES.has(family), `who.declared names AI families only: ${family}`);
  }
  assert.equal(Object.entries(out.who.signed).filter(([k]) => VENDORS.includes(k)).reduce((a, [, n]) => a + n, 0), 0,
    `no knock carried a Web Bot Auth signature, so no vendor is signed: ${JSON.stringify(out.who.signed)}`);
  for (const k of Object.keys(out.who.network)) {
    assert.ok(!REFERRAL_ENGINES.includes(k) || VENDORS.includes(k), `vendor and engine words are never merged: ${k}`);
  }
  assert.ok(sum(out.who.network) <= knocks.length, 'the network tier counts no more knocks than the log holds');
});

test('frame 6b [Analytics-2 20261003T131711Z-2]: first_contact true on the customer\'s first knock, false after; counts shows new vs returning', async () => {
  await ensureKnocks();
  const answered = logRows().filter((r) => r.stage === 'signed_post');
  assert.ok(answered.length >= 2, 'at least two answered knocks in the log');
  assert.deepEqual(answered.map((r) => r.first_contact), [true, ...answered.slice(1).map(() => false)],
    `first_contact on every answered row: true once, then false: ${JSON.stringify(answered.map((r) => r.first_contact))}`);
  assert.ok(answered.every((r) => !Object.values(r).some((v) => typeof v === 'string' && v.startsWith('did:'))), 'no DID in the log');

  const out = await counts();
  const nodes = [];
  const visit = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      nodes.push(v);
      Object.values(v).forEach(visit);
    }
  };
  visit(out);
  const split = nodes.find((o) => {
    const keys = Object.keys(o);
    const n = keys.find((k) => /^(new|first(_contacts?)?|true)$/.test(k));
    const r = keys.find((k) => /^(returning|repeat|false)$/.test(k));
    return n && r && Number.isInteger(o[n]) && Number.isInteger(o[r]);
  });
  assert.ok(split, `counts --json shows new vs returning knocks: ${JSON.stringify(out).slice(0, 600)}`);
  const newKey = Object.keys(split).find((k) => /^(new|first(_contacts?)?|true)$/.test(k));
  const retKey = Object.keys(split).find((k) => /^(returning|repeat|false)$/.test(k));
  assert.equal(split[newKey], 1, 'one first contact: the customer is new once');
  assert.equal(split[retKey], answered.length - 1, 'every later answered knock is returning');
  assert.ok(out.returning_customers >= 1, 'the store still says the customer came back');
});

test('frame: the runner never dialled out', () => {
  assert.deepEqual(guardLog.filter((r) => r.allowed === false), []);
});
