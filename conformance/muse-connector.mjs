#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/*
 * conformance/muse-connector.mjs — the Muse custom-connector recipe (connectors/muse.md).
 *
 * WHAT MUSE GIVES A USER, AND WHAT THIS FILE HOLDS. A Muse "custom connector" is integration
 * code Muse writes and runs on that user's persistent per-user Linux VM. So the connector is
 * the ordinary `knock` CLI, run as a user obtains it (`npx @muretai/agent-entry knock <card>`),
 * and the knock seed it keeps in `$HOME` becomes that user's own did:key. The property that
 * makes the recipe true is therefore one this file can prove without a Muse account:
 *
 *   - the same `HOME`, knocked twice, is the SAME `customer_did`;
 *   - a different fresh `HOME` is a DIFFERENT `customer_did`;
 *   - the seed is created 0600 at `<HOME>/.config/muretai-agent-entry/knock-seed`, its bytes
 *     never reach stdout or stderr, and a seed that cannot be read or is corrupt fails closed:
 *     non-zero, no knock sent, and the file is not silently replaced by a fresh key.
 *
 * AS A USER OBTAINS IT. The CLI is run through the package's `bin`, linked the way npm links it
 * (`node_modules/.bin/<name>` -> `node_modules/@muretai/agent-entry/<target>`), never by
 * importing the module's internals. The door is a LOCAL one (the Harbor Lamp door from
 * `examples/live-demo.mjs`) on 127.0.0.1; nothing leaves the machine. Every run gets a fresh
 * temporary `HOME`; the real `~/.config/muretai-agent-entry/` is never read or touched.
 *
 * Then the static half: the recipe page, the README bullet, the informative spec paragraph and
 * the CHANGELOG line exist and say what the brief says (substrings, not prose), and no example
 * names a domain that is not reserved.
 *
 * The claim this suite supports is "documented for Muse", not "tested in Muse".
 *
 * Run:  node conformance/muse-connector.mjs      (from the package root; also in `npm test`)
 */

import { spawn } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_CARD_PATH, createAgentEntry, didFromSeedHex } from '../muretai-agent-entry.mjs';
import { createHarborLampEntry, SATURDAY_ASK } from '../examples/live-demo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PACKAGE_NAME = '@muretai/agent-entry';
const SEED_REL = join('.config', 'muretai-agent-entry', 'knock-seed');

let pass = 0;
const failures = [];
const notes = [];
const scratch = [];

function check(ok, label, detail) {
  if (ok) { pass += 1; return true; }
  failures.push(detail ? `${label}\n      ${detail}` : label);
  return false;
}

/** One block; a throw inside it is ONE red row rather than the end of the run. */
async function section(name, fn) {
  try { await fn(); } catch (e) {
    check(false, `${name}/threw`, `${e && e.constructor ? e.constructor.name : 'Error'}: ${e && e.message}`);
  }
}

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function parseMaybe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ---------------------------------------------------------------- the package's bin

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** The executable `npx @muretai/agent-entry` runs: a string `bin`, the sole entry of a `bin`
 *  object, or the entry named after the unscoped package name — npm's own rule. */
function binEntry() {
  const bin = pkg.bin;
  if (typeof bin === 'string') return { name: 'agent-entry', target: bin };
  if (bin && typeof bin === 'object') {
    const names = Object.keys(bin);
    if (Object.hasOwn(bin, 'agent-entry')) return { name: 'agent-entry', target: bin['agent-entry'] };
    if (names.length === 1) return { name: names[0], target: bin[names[0]] };
  }
  return null;
}

const BIN = binEntry();

/** A throwaway project with the package linked in the way `npm install` / `npx` link it. The
 *  process is started on the `.bin` link itself, so `process.argv[1]` is what a user's shell
 *  hands Node — a symlink, not the module's real path. */
function installedBin() {
  if (!BIN) return null;
  const project = tempDir('agent-entry-muse-project-');
  const scope = join(project, 'node_modules', '@muretai');
  mkdirSync(scope, { recursive: true });
  symlinkSync(ROOT, join(scope, 'agent-entry'), 'dir');
  const binDir = join(project, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const link = join(binDir, BIN.name);
  symlinkSync(relative(binDir, join(scope, 'agent-entry', BIN.target)), link);
  return { project, link };
}

let INSTALLED = null;

function runKnock(home, cardUrl, extraEnv = {}) {
  return new Promise((resolveRun, reject) => {
    if (!INSTALLED) {
      resolveRun({ code: null, stdout: '', stderr: 'package.json declares no bin for npx to run' });
      return;
    }
    const env = { ...process.env, HOME: home, ...extraEnv };
    // The default path is the one under test: nothing may redirect the key or the text.
    delete env.AGENT_ENTRY_KNOCK_KEY;
    if (!Object.hasOwn(extraEnv, 'AGENT_ENTRY_KNOCK_TEXT')) delete env.AGENT_ENTRY_KNOCK_TEXT;
    delete env.XDG_CONFIG_HOME;
    const child = spawn(process.execPath, [INSTALLED.link, 'knock', cardUrl], {
      cwd: INSTALLED.project, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('knock CLI timed out')); }, 15000);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  });
}

// ---------------------------------------------------------------- the local door

/** The Harbor Lamp door on a loopback port, counting every POST it receives — "no knock was
 *  sent" is a count of zero here, not an inference from the exit code. */
function listenDoor(extra = {}) {
  return new Promise((resolveDoor, reject) => {
    let entry;
    const door = { posts: 0 };
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        if (req.method === 'POST') door.posts += 1;
        const out = await entry.handleRequestAsync(req.method, req.url, req.headers, Buffer.concat(chunks));
        res.writeHead(out.status, out.headers);
        res.end(out.body);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        entry = extra.create ? extra.create(baseUrl)
          : createHarborLampEntry({ seedHex: 'a7'.repeat(32), baseUrl });
      } catch (e) { server.close(); reject(e); return; }
      Object.assign(door, {
        entry,
        cardUrl: `${baseUrl}${AGENT_CARD_PATH}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
      resolveDoor(door);
    });
  });
}

// ---------------------------------------------------------------- seed-leak scan

/** Every spelling of a seed a careless print could produce. */
function seedSpellings(seedText) {
  const hex = seedText.trim();
  const out = [seedText, hex].filter((s) => s.length >= 16);
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    const bytes = Buffer.from(hex, 'hex');
    out.push(hex.toUpperCase(), bytes.toString('base64'), bytes.toString('base64url'));
  }
  return [...new Set(out)];
}

function checkNoSeed(label, run, seedText) {
  const both = `${run.stdout}\n${run.stderr}`;
  const hits = seedSpellings(seedText).filter((s) => both.includes(s));
  check(hits.length === 0, `${label}/seed-bytes-never-printed`,
    hits.length ? `found ${hits.length} spelling(s) of the seed on stdout/stderr` : '');
}

function readSeed(home) {
  const path = join(home, SEED_REL);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function receiptOf(run) {
  const printed = parseMaybe(run.stdout.trim());
  return printed && typeof printed === 'object' && !Array.isArray(printed) ? printed : null;
}

// ---------------------------------------------------------------- 1. the bin

await section('bin', async () => {
  check(pkg.name === PACKAGE_NAME, 'bin/package-name', `package.json name is ${JSON.stringify(pkg.name)}`);
  check(BIN !== null, 'bin/declared',
    `package.json "bin" is ${JSON.stringify(pkg.bin)} — \`npx ${PACKAGE_NAME} knock <card-url>\` needs `
    + 'a string bin, a single bin, or one named "agent-entry"');
  if (!BIN) return;
  const target = join(ROOT, BIN.target);
  check(existsSync(target), 'bin/target-exists', BIN.target);
  if (!existsSync(target)) return;
  const first = readFileSync(target, 'utf8').split('\n', 1)[0];
  check(first === '#!/usr/bin/env node', 'bin/target-has-a-node-shebang',
    `first line is ${JSON.stringify(first)} — npm executes the linked file directly`);
  const files = pkg.files || [];
  const shipped = files.some((f) => {
    const clean = f.replace(/\/+$/, '');
    return clean === BIN.target.replace(/^\.\//, '') || BIN.target.replace(/^\.\//, '').startsWith(`${clean}/`);
  });
  check(shipped, 'bin/target-ships-in-the-package', `package.json "files" is ${JSON.stringify(files)}`);
  INSTALLED = installedBin();
});

// ---------------------------------------------------------------- 2. one HOME, one customer

await section('same-home', async () => {
  const door = await listenDoor();
  try {
    const home = tempDir('agent-entry-muse-home-a-');
    const first = await runKnock(home, door.cardUrl);
    check(first.code === 0, 'same-home/first-knock-exits-0', `code=${first.code} stderr=${first.stderr.trim()}`);
    const seedPath = join(home, SEED_REL);
    check(existsSync(seedPath), 'same-home/seed-created-at-HOME/.config/muretai-agent-entry/knock-seed',
      `no file at <HOME>/${SEED_REL}`);
    const seedText = readSeed(home);
    if (seedText !== null) {
      const mode = statSync(seedPath).mode & 0o777;
      check(mode === 0o600, 'same-home/seed-is-mode-0600', `mode is 0${mode.toString(8)}`);
      check(/^[0-9a-f]{64}\n?$/.test(seedText), 'same-home/seed-is-one-hex-seed', '');
    }
    const a = receiptOf(first);
    check(a !== null && typeof a.customer_did === 'string' && a.customer_did.startsWith('did:key:z'),
      'same-home/first-knock-prints-a-customer_did', first.stdout.trim());
    check(a !== null && a.type === 'restaurant_reservation_request' && a.request === SATURDAY_ASK
      && a.status === 'pending_shop_confirmation',
    'same-home/first-knock-prints-the-checked-receipt', first.stdout.trim());
    if (seedText !== null && a) {
      check(a.customer_did === didFromSeedHex(seedText.trim()), 'same-home/customer_did-is-the-seed-did',
        `${a.customer_did} vs the did:key of <HOME>/${SEED_REL}`);
    }

    const second = await runKnock(home, door.cardUrl);
    check(second.code === 0, 'same-home/second-knock-exits-0', `code=${second.code} stderr=${second.stderr.trim()}`);
    const b = receiptOf(second);
    check(Boolean(a && b && a.customer_did === b.customer_did), 'same-home/same-customer_did-both-times',
      `first ${a && a.customer_did}, second ${b && b.customer_did}`);
    check(readSeed(home) === seedText, 'same-home/second-knock-keeps-the-seed', '');
    check(door.posts === 2, 'same-home/control/two-knocks-reached-the-door', `posts=${door.posts}`);
    const row = a && door.entry.ledger.get(a.customer_did);
    check(Boolean(row) && row.messages === 2 && door.entry.ledger.size === 1,
      'same-home/door-sees-one-account-with-two-messages',
      `ledger ${JSON.stringify([...door.entry.ledger.keys()])} messages=${row && row.messages}`);

    if (seedText !== null) {
      checkNoSeed('same-home/first', first, seedText);
      checkNoSeed('same-home/second', second, seedText);
    }

    // AGENT_ENTRY_KNOCK_TEXT chooses the message; the customer stays the same.
    const ask = 'Table for four on Friday at 20:00?';
    const texted = await runKnock(home, door.cardUrl, { AGENT_ENTRY_KNOCK_TEXT: ask });
    const c = receiptOf(texted);
    check(texted.code === 0 && c !== null && c.request === ask, 'same-home/AGENT_ENTRY_KNOCK_TEXT-is-the-request',
      `code=${texted.code} stdout=${texted.stdout.trim()}`);
    check(Boolean(a && c && c.customer_did === a.customer_did), 'same-home/AGENT_ENTRY_KNOCK_TEXT-keeps-the-customer', '');
    if (seedText !== null) checkNoSeed('same-home/texted', texted, seedText);

    // ---------------------------------------------------------------- 3. another HOME, another customer
    const other = tempDir('agent-entry-muse-home-b-');
    const elsewhere = await runKnock(other, door.cardUrl);
    check(elsewhere.code === 0, 'other-home/knock-exits-0', `code=${elsewhere.code} stderr=${elsewhere.stderr.trim()}`);
    const d = receiptOf(elsewhere);
    check(Boolean(a && d && typeof d.customer_did === 'string' && d.customer_did !== a.customer_did),
      'other-home/different-customer_did', `A ${a && a.customer_did}, B ${d && d.customer_did}`);
    const otherSeed = readSeed(other);
    check(otherSeed !== null && otherSeed !== seedText, 'other-home/own-seed-file', '');
    if (otherSeed !== null) {
      check((statSync(join(other, SEED_REL)).mode & 0o777) === 0o600, 'other-home/seed-is-mode-0600', '');
      checkNoSeed('other-home', elsewhere, otherSeed);
    }
    check(readSeed(home) === seedText, 'other-home/first-HOME-untouched', '');
  } finally {
    await door.close();
  }
});

// ---------------------------------------------------------------- 4. a refusal is readable, and still no seed

await section('refusal', async () => {
  // A door whose signed lane allows one message a minute: the second knock is refused, and the
  // CLI must say so in words a Muse connector can repair from (the JSON-RPC code, then the
  // `data.accepts` translation). The Harbor Lamp factory takes no rate option, so this is the
  // same door built with one.
  const limited = await listenDoor({
    create: (baseUrl) => createAgentEntry({
      seedHex: 'a9'.repeat(32), name: 'Harbor Lamp (one a minute)', baseUrl, signedRatePerMin: 1,
      skills: [{ id: 'book-table', name: 'restaurant-reservation', description: 'Request a table.',
        examples: [SATURDAY_ASK] }],
      responder: (env) => JSON.stringify({ type: 'restaurant_reservation_request',
        customer_did: env.owner_did || env.peer_did, request: env.text, status: 'pending_shop_confirmation' }),
    }),
  });
  try {
    const home = tempDir('agent-entry-muse-home-r-');
    const ok = await runKnock(home, limited.cardUrl);
    check(ok.code === 0, 'refusal/control/first-knock-answered', `code=${ok.code} stderr=${ok.stderr.trim()}`);
    const refused = await runKnock(home, limited.cardUrl);
    check(refused.code !== 0 && refused.code !== null, 'refusal/exits-non-zero', `code=${refused.code}`);
    check(/Refused \(-32\d{3}\)/.test(refused.stderr), 'refusal/prints-the-json-rpc-code', refused.stderr.trim());
    check(/^- Use an Ed25519 did:key/m.test(refused.stderr), 'refusal/prints-the-accepts-translation', refused.stderr.trim());
    check(receiptOf(refused) === null, 'refusal/prints-no-receipt', refused.stdout.trim());
    const seedText = readSeed(home);
    if (seedText !== null) checkNoSeed('refusal', refused, seedText);
  } finally {
    await limited.close();
  }
});

// ---------------------------------------------------------------- 5. a bad seed fails closed

await section('bad-seed', async () => {
  const door = await listenDoor();
  try {
    const cases = [
      ['corrupt-not-hex', 'this is not a seed at all, but it is long enough to notice\n'],
      ['corrupt-short', `${'c4'.repeat(31)}\n`],
      ['corrupt-uppercase', `${'C5'.repeat(32)}\n`],
      ['corrupt-two-seeds', `${'c6'.repeat(32)}\n${'c7'.repeat(32)}\n`],
      ['empty', ''],
    ];
    for (const [label, bytes] of cases) {
      const home = tempDir(`agent-entry-muse-home-${label}-`);
      const seedPath = join(home, SEED_REL);
      mkdirSync(dirname(seedPath), { recursive: true, mode: 0o700 });
      writeFileSync(seedPath, bytes, { mode: 0o600 });
      const before = door.posts;
      const run = await runKnock(home, door.cardUrl);
      check(run.code !== 0 && run.code !== null, `bad-seed/${label}/exits-non-zero`, `code=${run.code}`);
      check(door.posts === before, `bad-seed/${label}/no-knock-sent`, `${door.posts - before} POST(s) reached the door`);
      check(!/did:key:z/.test(run.stdout), `bad-seed/${label}/no-identity-printed`, run.stdout.trim());
      check(readFileSync(seedPath, 'utf8') === bytes, `bad-seed/${label}/seed-not-replaced`,
        'the corrupt file was overwritten — a fresh key would be a stranger at every door');
      if (bytes.length >= 16) checkNoSeed(`bad-seed/${label}`, run, bytes);
    }

    // Unreadable: present, but this user cannot read it. Skipped when the test runs as root,
    // for whom mode 000 is no barrier.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      notes.push('skip: bad-seed/unreadable — running as root, mode 000 does not deny reads');
    } else {
      const home = tempDir('agent-entry-muse-home-unreadable-');
      const seedPath = join(home, SEED_REL);
      mkdirSync(dirname(seedPath), { recursive: true, mode: 0o700 });
      const seed = 'd8'.repeat(32);
      writeFileSync(seedPath, `${seed}\n`, { mode: 0o600 });
      chmodSync(seedPath, 0o000);
      const before = door.posts;
      const run = await runKnock(home, door.cardUrl);
      chmodSync(seedPath, 0o600);
      check(run.code !== 0 && run.code !== null, 'bad-seed/unreadable/exits-non-zero', `code=${run.code}`);
      check(door.posts === before, 'bad-seed/unreadable/no-knock-sent', `${door.posts - before} POST(s) reached the door`);
      check(!/did:key:z/.test(run.stdout), 'bad-seed/unreadable/no-identity-printed', run.stdout.trim());
      check(readFileSync(seedPath, 'utf8') === `${seed}\n`, 'bad-seed/unreadable/seed-not-replaced', '');
      checkNoSeed('bad-seed/unreadable', run, `${seed}\n`);
    }
  } finally {
    await door.close();
  }
});

// ---------------------------------------------------------------- 6. the documents

/** Hosts an example may use: RFC 2606 / RFC 6761 names, and loopback. */
function isReservedHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (/^(?:[a-z0-9-]+\.)*example(?:\.(?:com|net|org))?$/.test(h)) return true;
  return /\.(?:test|example|invalid|localhost)$/.test(h);
}

/** Every URL host inside fenced code blocks and inline code spans of `text`. */
function exampleHosts(text) {
  const code = [];
  for (const m of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) code.push(m[1]);
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) code.push(m[1]);
  const hosts = [];
  for (const block of code) {
    for (const m of block.matchAll(/\bhttps?:\/\/([^\s/'"`<>)]+)/g)) hosts.push(m[1].replace(/:\d+$/, ''));
  }
  return hosts;
}

const paragraphs = (text) => text.split(/\n\s*\n/);

await section('static', async () => {
  // connectors/muse.md — the page a Muse user's agent reads.
  const musePath = join(ROOT, 'connectors', 'muse.md');
  check(existsSync(musePath), 'static/connectors-muse-md-exists', 'connectors/muse.md');
  const muse = existsSync(musePath) ? readFileSync(musePath, 'utf8') : '';
  for (const needle of ['npx @muretai/agent-entry knock', '~/.config/muretai-agent-entry/knock-seed', '0600',
    'AGENT_ENTRY_KNOCK_TEXT', 'customer_did', 'data.accepts']) {
    check(muse.includes(needle), `static/muse-md-mentions/${needle}`, '');
  }
  check(paragraphs(muse).some((p) => /\bno\b/i.test(p)
    && ['account', 'token', 'oauth', 'registration'].every((w) => p.toLowerCase().includes(w))),
  'static/muse-md-says-no-account-token-oauth-or-registration',
  'one paragraph must state there is no account, token, OAuth or registration');
  check(paragraphs(muse).some((p) => p.includes('Secure Credentials Store') && /\bnot\b/i.test(p)),
    'static/muse-md-names-the-custody-trade-off',
    'one paragraph must say the seed is NOT in Muse\'s Secure Credentials Store');
  const museHosts = exampleHosts(muse);
  const badMuse = museHosts.filter((h) => !isReservedHost(h));
  check(badMuse.length === 0, 'static/muse-md-examples-use-reserved-domains', badMuse.join(', '));
  for (const m of muse.matchAll(/npx @muretai\/agent-entry knock\s+(\S+)/g)) {
    const arg = m[1].replace(/[`'"]/g, '');
    if (/^https?:\/\//.test(arg)) {
      check(isReservedHost(new URL(arg).hostname), 'static/muse-md-knock-example-card-is-reserved', arg);
    }
  }

  // README "Knock from any runtime": a **Muse** bullet beside the others, linking the page.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf('## Knock from any runtime');
  const end = start < 0 ? -1 : readme.indexOf('\n## ', start + 3);
  const knockSection = start < 0 ? '' : readme.slice(start, end < 0 ? undefined : end);
  check(start >= 0, 'static/readme-has-knock-from-any-runtime', '');
  const bullets = knockSection.split(/\n(?=- )/).filter((b) => b.startsWith('- '));
  const museBullet = bullets.find((b) => b.startsWith('- **Muse'));
  check(Boolean(museBullet), 'static/readme-knock-section-has-a-Muse-bullet', '');
  check(Boolean(museBullet && /\]\((?:\.\/)?connectors\/muse\.md(?:#[^)]*)?\)/.test(museBullet)),
    'static/readme-Muse-bullet-links-connectors/muse.md', museBullet ? museBullet.slice(0, 200) : '');
  for (const other of ['- **Claude Code:**', '- **OpenClaw:**', '- **Hermes:**']) {
    check(knockSection.includes(other), `static/readme-knock-section-keeps/${other}`, '');
  }
  if (museBullet) {
    const bad = exampleHosts(museBullet).filter((h) => !isReservedHost(h));
    check(bad.length === 0, 'static/readme-Muse-bullet-examples-use-reserved-domains', bad.join(', '));
  }

  // spec/v1.md "Relationship to other specifications": an informative paragraph beside MCP.
  const spec = readFileSync(join(ROOT, 'spec', 'v1.md'), 'utf8');
  const rel = /^## \d+\. Relationship to other[^\n]*$/m.exec(spec);
  check(Boolean(rel), 'static/spec-has-the-relationship-section', '');
  const relStart = rel ? rel.index : -1;
  const relEnd = relStart < 0 ? -1 : spec.indexOf('\n## ', relStart + 3);
  const relSection = relStart < 0 ? '' : spec.slice(relStart, relEnd < 0 ? undefined : relEnd);
  const relParas = paragraphs(relSection);
  const at = relParas.findIndex((p) => p.startsWith('**Agent connectors'));
  const para = at < 0 ? '' : relParas[at];
  check(at >= 0, 'static/spec-relationship-section-has-an-Agent-connectors-paragraph',
    'a paragraph opening "**Agent connectors (Muse, Instinct).**"');
  check(para.includes('Muse') && para.includes('Instinct'), 'static/spec-Agent-connectors-names-Muse-and-Instinct', '');
  const bold = (p) => (/^\*\*([^*]+)\*\*/.exec(p) || [])[1] || '';
  const neighbours = [relParas[at - 1], relParas[at + 1]].filter(Boolean).map(bold);
  check(at >= 0 && neighbours.some((b) => b.startsWith('MCP')), 'static/spec-Agent-connectors-sits-beside-MCP',
    `neighbours ${JSON.stringify(neighbours)}`);
  check(at >= 0 && !/\bAE-\d+\b/.test(para), 'static/spec-Agent-connectors-adds-no-requirement-number', '');
  check(at >= 0 && !/\b(?:MUST|SHOULD|SHALL|REQUIRED|RECOMMENDED)\b/.test(para),
    'static/spec-Agent-connectors-adds-no-MUST-or-SHOULD', para.slice(0, 200));
  const indexRows = spec.split('\n').filter((l) => /^\| AE-\d+ \|/.test(l));
  check(!indexRows.some((l) => /muse|connector/i.test(l)), 'static/spec-requirement-index-gains-no-connector-row', '');
  const badSpec = exampleHosts(para).filter((h) => !isReservedHost(h));
  check(badSpec.length === 0, 'static/spec-Agent-connectors-examples-use-reserved-domains', badSpec.join(', '));

  // CHANGELOG: the unreleased record, no version bump.
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const sections = changelog.split(/\n(?=## )/).filter((s) => s.startsWith('## '));
  const home = sections.find((s) => s.includes('connectors: Muse recipe'));
  check(Boolean(home), 'static/changelog-has-connectors-Muse-recipe', '');
  const heading = home ? home.split('\n', 1)[0] : '';
  check(/unreleased|not yet published/i.test(heading), 'static/changelog-Muse-line-is-unreleased', heading);
  check(pkg.version === '1.13.0', 'static/version-is-the-released-one', `package.json version is ${pkg.version}`);
});

// ---------------------------------------------------------------- verdict

for (const dir of scratch) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
for (const n of notes) console.log(`  ${n}`);
if (failures.length) {
  console.log(`\nFAILED — ${failures.length} of ${pass + failures.length} checks:\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('\nThe Muse recipe rests on one property: the seed in a HOME is that person, at every door,');
  console.log('and it never leaves the file. A row above is a place that property is not yet held.\n');
  process.exit(1);
}
console.log(`OK — ${pass} checks: one HOME is one customer, another HOME is another, and the seed stays in its file.\n`);
