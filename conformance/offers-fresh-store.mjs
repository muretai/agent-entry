// conformance/offers-fresh-store.mjs - every conformance run of offers.mjs starts from an empty
// hold store (intake 20261104T045727Z, whole item).
//
// WRITTEN BEFORE THE FIX (test-first). The implementer makes this file pass; it does not edit it.
//
// What is pinned:
//   - two back-to-back runs of conformance/offers.mjs both exit 0 and never answer -32004;
//   - a run over a sandbox seeded with stale hold stores (state files in the createFileStore
//     format, each holding more undecided receipts than the door takes, per party and in total)
//     still exits 0 and never answers -32004: a leftover store is never reused;
//   - the run reads and writes no shared temp or home path: it leaves nothing behind in the HOME
//     or TMPDIR it was given, and the seeded stores are byte-identical afterwards (the run never
//     deletes or alters a store it does not own);
//   - the shop's own rate limit is NOT relaxed by the fix: a door over a store that already
//     holds MAX_UNDECIDED_RECEIPTS_PER_PARTY undecided rows for a visitor still refuses that
//     visitor's next hold with -32004, and a fresh door still refuses the sixth undecided hold.
//
// Every path this file touches is one it creates with mkdtemp; it never names the real HOME or
// the real temp directory as a place to write, and it removes only what it created.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const OFFERS = join(HERE, 'offers.mjs');
const RATE_LIMITED = -32004;
const RATE_TEXT = 'the shop holds as many undecided receipts as it takes';

const { createAgentEntry, createFileStore, didFromSeedHex, signEnvelope } = door;

// The seeds offers.mjs knocks with: the stale rows name the very parties a run uses.
const DOOR_SEED = 'c4'.repeat(32);
const VISITOR_SEED = '77'.repeat(32);
const VISITOR = didFromSeedHex(VISITOR_SEED);

let passed = 0;
const failures = [];
function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${detail}` : ''}`);
  return false;
}

const ROOT = mkdtempSync(join(tmpdir(), 'offers-fresh-store-'));

/** A sandbox this file owns: HOME and TMPDIR the child is pointed at, both empty. */
function sandbox(name) {
  const base = join(ROOT, name);
  const home = join(base, 'home');
  const tmp = join(base, 'tmp');
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  return { base, home, tmp };
}

/** Every file under dir, relative, sorted. */
function listFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { out.push(`${r}/`); walk(join(d, ent.name), r); } else out.push(r);
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out.sort();
}

/** One run of conformance/offers.mjs with HOME and every temp variable pointed into box. */
function runOffers(box) {
  const env = { ...process.env, HOME: box.home, USERPROFILE: box.home, TMPDIR: box.tmp, TMP: box.tmp,
    TEMP: box.tmp, XDG_CONFIG_HOME: join(box.home, '.config'), XDG_STATE_HOME: join(box.home, '.local', 'state'),
    XDG_DATA_HOME: join(box.home, '.local', 'share'), XDG_CACHE_HOME: join(box.home, '.cache') };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) if (key.startsWith('AGENT_ENTRY_')) delete env[key];
  const r = spawnSync(process.execPath, [OFFERS], { cwd: REPO, env, encoding: 'utf8',
    timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout || ''}\n${r.stderr || ''}`;
  return { status: r.status, signal: r.signal, output };
}

function firstLines(text, n = 6) {
  return text.split('\n').filter((l) => l.trim()).slice(0, n).join(' | ').slice(0, 900);
}

function checkRunPassed(run, label) {
  check(run.status === 0, `${label}/exits-0`, `status ${run.status} signal ${run.signal}: ${firstLines(run.output)}`);
  check(!run.output.includes(String(RATE_LIMITED)) && !run.output.includes(RATE_TEXT),
    `${label}/no-${RATE_LIMITED}-rate-limited-answer`, firstLines(run.output.split('\n')
      .filter((l) => l.includes(String(RATE_LIMITED))).join('\n'), 3));
  check(/^OK - \d+ checks/m.test(run.output), `${label}/reports-ok`, firstLines(run.output, 2));
}

/** The run left nothing in the HOME and TMPDIR it was given beyond what was there before. */
function checkLeftNothing(box, before, label) {
  const home = listFiles(box.home);
  const tmp = listFiles(box.tmp);
  const extraHome = home.filter((f) => !before.home.includes(f));
  const extraTmp = tmp.filter((f) => !before.tmp.includes(f));
  check(extraHome.length === 0, `${label}/writes-nothing-under-home`, JSON.stringify(extraHome.slice(0, 10)));
  check(extraTmp.length === 0, `${label}/leaves-nothing-in-tmp`, JSON.stringify(extraTmp.slice(0, 10)));
}

/** A createFileStore-format state document holding `count` undecided receipts for `party`. */
function staleDoc(count, party, prefix) {
  const receipts = [];
  for (let i = 0; i < count; i += 1) {
    const ref = `${prefix}-${i}`;
    receipts.push([ref, { ref, offer: 'hold', partyB: party, issued_ts: 1700000000 + i,
      pending_text: `hold item {"id":${i}}`, decision: null }]);
  }
  return JSON.stringify({ v: 1, messages: [], accounts: [], deviceOwners: [], keyStates: [], receipts }) + '\n';
}

// ---------------------------------------------------------------- 1. two back-to-back runs pass

{
  const box = sandbox('back-to-back');
  for (const n of [1, 2]) {
    const before = { home: listFiles(box.home), tmp: listFiles(box.tmp) };
    const run = runOffers(box);
    checkRunPassed(run, `back-to-back/run-${n}`);
    checkLeftNothing(box, before, `back-to-back/run-${n}`);
  }
}

// ---------------------------------------------------------------- 2. a seeded stale store is not reused

{
  const box = sandbox('stale-store');
  // More undecided rows than the door takes, per party (5) and in total (500), for the visitor
  // offers.mjs knocks as, at every place a run could plausibly look for a leftover store.
  const total = door.MAX_UNDECIDED_RECEIPTS + 20;
  const seeded = [
    join(box.home, '.config', 'muretai-agent-entry', 'store.json'),
    join(box.home, '.config', 'muretai-agent-entry', 'state.json'),
    join(box.home, '.config', 'muretai-agent-entry', 'receipts.json'),
    join(box.home, '.local', 'state', 'muretai-agent-entry', 'store.json'),
    join(box.home, '.cache', 'muretai-agent-entry', 'store.json'),
    join(box.tmp, 'agent-entry-store.json'),
    join(box.tmp, 'muretai-agent-entry-store.json'),
    join(box.tmp, 'offers-store.json'),
    join(box.tmp, 'offers-hold-store.json'),
    join(box.tmp, 'muretai-agent-entry', 'store.json'),
    join(box.tmp, 'offers-hold', 'store.json'),
  ];
  const bytes = new Map();
  seeded.forEach((path, i) => {
    mkdirSync(dirname(path), { recursive: true });
    const doc = staleDoc(total, VISITOR, `stale-${i}`);
    writeFileSync(path, doc);
    bytes.set(path, doc);
  });
  // The seed is a real over-the-cap store: a door opened over it refuses the visitor's hold.
  const probe = createFileStore(seeded[0]);
  check(probe.listUndecidedReceipts().length === total, 'stale-store/seed/is-a-readable-store-over-the-cap',
    String(probe.listUndecidedReceipts().length));

  const before = { home: listFiles(box.home), tmp: listFiles(box.tmp) };
  const run = runOffers(box);
  checkRunPassed(run, 'stale-store/run');
  checkLeftNothing(box, before, 'stale-store/run');
  for (const path of seeded) {
    const rel = path.slice(box.base.length + 1);
    const still = existsSync(path);
    check(still, `stale-store/not-deleted/${rel}`);
    check(still && readFileSync(path, 'utf8') === bytes.get(path), `stale-store/not-altered/${rel}`);
  }
  // A second run over the same leftovers passes too.
  const again = runOffers(box);
  checkRunPassed(again, 'stale-store/run-again');
}

// ---------------------------------------------------------------- 3. the shop's limit stays as it is

const HOLD_DECLARATION = {
  v: 1,
  entry: { name: 'Harbor Lamp', baseUrl: 'https://shop.example' },
  offers: [{ verb: 'hold', of: 'item', about: 'Hold one item for pickup.', input: { id: 'integer' },
    door: { reply: 'pending' } }],
};

let sequence = 0;
async function holdKnock(entry, text) {
  const messageId = `fresh-store-${++sequence}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signEnvelope(VISITOR_SEED, { from: VISITOR, to: entry.did, messageId, contextId: null, timestamp, text });
  const body = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: messageId, method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId, contextId: null,
      parts: [{ kind: 'text', text }], metadata: { from: VISITOR, to: entry.did, timestamp, sig, offer: 'hold' } } },
  }));
  const out = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body);
  let parsed = null;
  try { parsed = JSON.parse(Buffer.from(out.body || '').toString('utf8')); } catch { /* reported below */ }
  return parsed;
}

function holdDoor(extra = {}) {
  return createAgentEntry({ seedHex: DOOR_SEED, name: HOLD_DECLARATION.entry.name,
    baseUrl: HOLD_DECLARATION.entry.baseUrl, declaration: JSON.parse(JSON.stringify(HOLD_DECLARATION)),
    signedRatePerMin: 0, signedRatePerMinTotal: 0, responder: () => 'ok', ...extra });
}

check(door.MAX_UNDECIDED_RECEIPTS_PER_PARTY === 5, 'limit/per-party-cap-is-5', String(door.MAX_UNDECIDED_RECEIPTS_PER_PARTY));
check(door.MAX_UNDECIDED_RECEIPTS === 500, 'limit/total-cap-is-500', String(door.MAX_UNDECIDED_RECEIPTS));

{
  // A store this file created, already at the per-party cap for the visitor, is still refused.
  const dir = join(ROOT, 'limit');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'store.json');
  writeFileSync(path, staleDoc(door.MAX_UNDECIDED_RECEIPTS_PER_PARTY, VISITOR, 'cap'));
  const entry = holdDoor({ store: createFileStore(path) });
  const r = await holdKnock(entry, 'hold item {"id":1}');
  check(r?.error?.code === RATE_LIMITED, 'limit/store-at-the-cap-still-refuses-the-next-hold', JSON.stringify(r?.error ?? r?.result?.kind));
}

{
  // A fresh door takes five undecided holds from one visitor and refuses the sixth.
  const entry = holdDoor();
  const codes = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await holdKnock(entry, `hold item {"id":${200 + i}}`);
    codes.push(r?.error ? r.error.code : 'ok');
  }
  check(JSON.stringify(codes.slice(0, 5)) === JSON.stringify(['ok', 'ok', 'ok', 'ok', 'ok']),
    'limit/fresh-door-takes-five-undecided-holds', JSON.stringify(codes));
  check(codes[5] === RATE_LIMITED, 'limit/fresh-door-refuses-the-sixth-undecided-hold', JSON.stringify(codes));
}

// ---------------------------------------------------------------- report

rmSync(ROOT, { recursive: true, force: true });
if (failures.length) {
  console.error(`FAILED - ${failures.length} offers-fresh-store check(s):`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} checks: each offers.mjs run starts from an empty hold store, twice in a row and `
  + 'over a seeded stale store, and the shop still refuses past its undecided-receipt cap.');
