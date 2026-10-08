#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The door's front page says what a customer can do here.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). Intake 20261007T160326Z,
// P0 skeleton, agent-entry group 0e. The implementer may not edit this file.
// It is not wired into `npm test` until it is green; run it as
// `node conformance/front-page.mjs`.
//
// What a non-guest mount serves, and what offersSignpost(declaration) returns:
//   GET the mount with Accept listing text/html answers an HTML page whose body
//   contains the block offersSignpost(declaration) returns, byte for byte.
//   The block lists every offer of the signed contract: verb, of, the description
//   (the offer's about), each input name and type, the line "needs the customer's
//   key" (this declaration names no unsigned lane, and an unsigned knock of a
//   door-bound offer is refused), and one knock command line
//   `knock <absolute card URL> --offer <offer id>`.
//   The same block carries the card link and the signposts: bodySignpost for the
//   mount's card path, and the head link tag for that path. The HTML response's
//   Link header is the notice route's signpost header.
//   offersSignpost is a pure function of the declaration: same bytes for the same
//   offers whatever the key order, no fetch.
//   Any other Accept, including none, */* and text/plain, keeps today's text
//   notice body byte for byte, with the same Link header.
//   A guest mount does not serve the page.
//   Offer text that holds markup is refused or escaped, never rendered as a tag.
// The init snippet writes agent-entry.door.mjs calling offersSignpost. The
// WooCommerce plugin prints that same block on the site's own page.
import { spawn, spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const {
  AGENT_CARD_PATH, AGENT_ENTRY_REL, ERRORS, bodySignpost, canonicalBaseUrl, canonicalMount,
  compileDeclaration, createAgentEntry, validateDeclaration,
} = door;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DOOR_FILE = join(ROOT, 'muretai-agent-entry.mjs');
const FIXTURE = join(HERE, 'fixtures', 'front-page-declaration.json');
const PLUGIN = join(ROOT, 'examples', 'woocommerce-agent-entry.php');
const SHIM = join(HERE, 'fixtures', 'woo-plugin', 'wp-shim.php');
const SEED = 'ab'.repeat(32);
const MARKUP = 'Hold one lamp <script>alert(1)</script><img src=x onerror=alert(1)>';
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const declaration = JSON.parse(readFileSync(FIXTURE, 'utf8'));

let passed = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${String(detail).slice(0, 500)}` : ''}`);
  return false;
}

async function section(name, fn) {
  try { await fn(); } catch (error) { check(false, `${name}/threw`, error?.stack || String(error)); }
}

const clone = (v) => JSON.parse(JSON.stringify(v));

function reorderKeys(value) {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).reverse()) out[key] = reorderKeys(value[key]);
    return out;
  }
  return value;
}

function header(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return String(headers[key] ?? '');
  }
  return '';
}

function mountOf(decl) {
  const base = canonicalBaseUrl(decl.entry.baseUrl, { warn: false });
  return canonicalMount(base);
}

function cardUrlOf(decl) {
  return `${canonicalBaseUrl(decl.entry.baseUrl, { warn: false })}${AGENT_CARD_PATH}`;
}

function cardPathOf(decl) {
  return `${mountOf(decl)}${AGENT_CARD_PATH}`;
}

function signpostLink(decl) {
  const path = cardPathOf(decl);
  return `<${path}>; rel="service-desc", <${path}>; rel="${AGENT_ENTRY_REL}"`;
}

function textNotice(entry) {
  return `${entry.card.name}\n\nThis address is agent-reachable (Muretai agent entry).\n`
    + `DID:  ${entry.did}\nCard: ${entry.card.url}${AGENT_CARD_PATH}\n`
    + `POST a signed A2A message/send request to ${entry.mount || '/'} for a signed reply.\n`;
}

function makeEntry(decl, extra = {}) {
  return createAgentEntry({
    seedHex: SEED,
    name: decl.entry.name,
    baseUrl: decl.entry.baseUrl,
    declaration: decl,
    signedRatePerMin: 0,
    signedRatePerMinTotal: 0,
    ...extra,
  });
}

function signpost(decl) {
  if (typeof door.offersSignpost !== 'function') {
    throw new TypeError('offersSignpost(declaration) is not exported from muretai-agent-entry.mjs');
  }
  return door.offersSignpost(decl);
}

async function get(entry, path, accept, headerName = 'accept') {
  const headers = {};
  if (accept !== undefined) headers[headerName] = accept;
  const out = await entry.handleRequestAsync('GET', path, headers, Buffer.alloc(0));
  return {
    status: out.status,
    type: header(out.headers, 'content-type'),
    link: header(out.headers, 'link'),
    body: Buffer.from(out.body || '').toString('utf8'),
  };
}

function isHtml(type) {
  return /^text\/html\b/i.test(type) && /charset=utf-8/i.test(type);
}

function word(text, value) {
  return new RegExp(`\\b${value}\\b`).test(text);
}

function knockCommand(cardUrl, id) {
  return `knock ${cardUrl} --offer ${id}`;
}

function renderedRaw(html) {
  return /<script/i.test(html) || /<img/i.test(html);
}

function checkBlock(block, decl, label) {
  const contract = compileDeclaration(decl);
  const cardUrl = cardUrlOf(decl);
  const cardPath = cardPathOf(decl);
  check(typeof block === 'string' && block.length > 0, `${label}/block-is-a-string`);
  check(block.includes(bodySignpost(cardPath)), `${label}/block-has-the-body-signpost`, block.slice(0, 240));
  check(block.includes(`<link rel="${AGENT_ENTRY_REL}" href="${cardPath}">`),
    `${label}/block-has-the-head-link`, cardPath);
  check(block.includes(cardUrl), `${label}/block-has-the-card-url`, cardUrl);
  check((block.split('needs the customer\'s key').length - 1) >= contract.offers.length,
    `${label}/each-offer-needs-the-customer-key`,
    `count ${block.split('needs the customer\'s key').length - 1} offers ${contract.offers.length}`);
  check(!block.includes('answers unsigned'), `${label}/no-offer-answers-unsigned`);
  for (const offer of contract.offers) {
    const at = `${label}/${offer.id}`;
    check(block.includes(offer.id), `${at}/id`);
    check(word(block, offer.verb), `${at}/verb`, offer.verb);
    check(word(block, offer.of), `${at}/of`, offer.of);
    check(block.includes(offer.about), `${at}/description`, offer.about);
    for (const [name, type] of Object.entries(offer.input)) {
      check(block.includes(name), `${at}/input-name-${name}`);
      check(word(block, type), `${at}/input-type-${name}`, type);
    }
    check(block.includes(knockCommand(cardUrl, offer.id)), `${at}/knock-command`,
      knockCommand(cardUrl, offer.id));
  }
}

function checkPage(page, block, decl, label) {
  check(page.status === 200, `${label}/status-200`, `HTTP ${page.status}`);
  check(isHtml(page.type), `${label}/content-type-html`, page.type);
  check(page.body.includes(block), `${label}/page-contains-the-block`,
    `block ${block.length} bytes, body ${page.body.length} bytes`);
  check(page.link === signpostLink(decl), `${label}/link-header-is-the-signpost`, page.link);
  check(page.body !== textNotice(makeEntry(decl)), `${label}/html-is-not-the-text-notice`);
}

await section('fixture', async () => {
  let valid = true;
  try { validateDeclaration(declaration); } catch (error) {
    valid = false;
    check(false, 'fixture/validates', error?.message);
  }
  if (valid) check(true, 'fixture/validates');
  const contract = compileDeclaration(declaration);
  check(contract.offers.map((o) => o.id).join(',') === 'find_products,hold_item,ask_shop,book_table',
    'fixture/signed-contract-lists-every-offer', contract.offers.map((o) => o.id).join(','));
});

await section('text-notice', async () => {
  const entry = makeEntry(declaration);
  const notice = textNotice(entry);
  const link = signpostLink(declaration);
  for (const accept of [undefined, 'text/plain', 'application/json', '*/*', 'text/htmlextra', '']) {
    const label = `notice/${accept === undefined ? 'absent' : JSON.stringify(accept)}`;
    const page = await get(entry, '/', accept);
    check(page.status === 200, `${label}/status-200`, `HTTP ${page.status}`);
    check(page.type === 'text/plain; charset=utf-8', `${label}/content-type`, page.type);
    check(page.body === notice, `${label}/body-byte-for-byte`, JSON.stringify(page.body));
    check(page.link === link, `${label}/link-header`, page.link);
  }
  const deskDecl = clone(declaration);
  deskDecl.entry.baseUrl = 'https://shop.example/desk';
  const desk = makeEntry(deskDecl);
  const plain = await get(desk, '/desk', 'text/plain');
  check(plain.body === textNotice(desk), 'notice/path-mount-byte-for-byte', JSON.stringify(plain.body));
  check(plain.link === signpostLink(deskDecl), 'notice/path-mount-link-header', plain.link);
});

await section('html-page', async () => {
  const entry = makeEntry(declaration);
  const block = signpost(declaration);
  const again = signpost(declaration);
  check(again === block, 'html/offersSignpost-is-deterministic');
  check(signpost(reorderKeys(declaration)) === block, 'html/offersSignpost-ignores-key-order');
  const before = JSON.stringify(declaration);
  signpost(declaration);
  check(JSON.stringify(declaration) === before, 'html/offersSignpost-does-not-mutate');
  checkBlock(block, declaration, 'html/origin');
  for (const [label, accept, headerName] of [
    ['text-html', 'text/html', 'accept'],
    ['accept-capitalised', 'text/html', 'Accept'],
    ['media-type-case', 'Text/HTML', 'accept'],
    ['charset-parameter', 'text/html;charset=utf-8', 'accept'],
    ['browser', BROWSER_ACCEPT, 'accept'],
  ]) {
    const page = await get(entry, '/', accept, headerName);
    checkPage(page, block, declaration, `html/${label}`);
  }
  const queried = await get(entry, '/?q=%3Cscript%3Ealert(1)%3C/script%3E', 'text/html');
  const clean = await get(entry, '/', 'text/html');
  check(queried.body === clean.body, 'html/query-does-not-change-the-page');
  check(!renderedRaw(queried.body), 'html/query-markup-is-not-rendered');
  const repeat = await get(entry, '/', 'text/html');
  check(repeat.body === clean.body, 'html/second-get-is-the-same-bytes');
  const other = await get(entry, '/other', 'text/html');
  check(other.status === 404, 'html/other-path-is-404', `HTTP ${other.status}`);
  check(!other.body.includes(block), 'html/other-path-is-not-the-page');

  const deskDecl = clone(declaration);
  deskDecl.entry.baseUrl = 'https://shop.example/desk';
  const deskBlock = signpost(deskDecl);
  check(deskBlock !== block, 'html/path-mount-block-differs');
  checkBlock(deskBlock, deskDecl, 'html/path-mount');
  const desk = makeEntry(deskDecl);
  const deskPage = await get(desk, '/desk', 'text/html');
  checkPage(deskPage, deskBlock, deskDecl, 'html/path-mount-page');
  const deskRoot = await get(desk, '/', 'text/html');
  check(deskRoot.status === 404, 'html/path-mount-root-is-not-the-page', `HTTP ${deskRoot.status}`);

  const unsigned = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' },
    Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 'front-unsigned', method: 'message/send',
      params: { message: { kind: 'message', role: 'user', messageId: 'front-unsigned',
        parts: [{ kind: 'text', text: 'hello' }],
        metadata: { offer: 'find_products' } } },
    })));
  const unsignedBody = JSON.parse(Buffer.from(unsigned.body).toString('utf8'));
  check(unsignedBody.error?.code === ERRORS.UNAUTHENTICATED.code,
    'html/unsigned-knock-is-refused', JSON.stringify(unsignedBody.error));
});

await section('no-fetch', async () => {
  const prev = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = () => { fetched += 1; throw new Error('offersSignpost must not fetch'); };
  try {
    signpost(declaration);
    check(fetched === 0, 'no-fetch/offersSignpost', `fetched ${fetched}`);
  } finally {
    globalThis.fetch = prev;
  }
});

await section('guest', async () => {
  const guestDecl = clone(declaration);
  guestDecl.entry.baseUrl = 'https://shop.example/door';
  const entry = makeEntry(guestDecl, { guest: true });
  const page = await get(entry, '/door', 'text/html');
  check(page.status === 405, 'guest/status-405', `HTTP ${page.status} ${page.body.slice(0, 200)}`);
  check(!isHtml(page.type), 'guest/does-not-serve-html', page.type);
  const block = signpost(guestDecl);
  check(!page.body.includes(block), 'guest/body-is-not-the-block', page.body.slice(0, 200));
  check(!page.body.includes('find_products'), 'guest/body-does-not-list-offers', page.body.slice(0, 200));
});

await section('markup', async () => {
  const marked = clone(declaration);
  marked.offers[1].about = MARKUP;
  let block;
  let blockRefused = false;
  try { block = signpost(marked); } catch { blockRefused = true; }
  let pageRefused = false;
  let page = null;
  try {
    page = await get(makeEntry(marked), '/', 'text/html');
  } catch { pageRefused = true; }
  const blockSafe = blockRefused || (
    typeof block === 'string' && !block.includes(MARKUP) && !renderedRaw(block) && block.includes('Hold one lamp'));
  const pageSafe = pageRefused || (
    page && isHtml(page.type) && !page.body.includes(MARKUP) && !renderedRaw(page.body)
    && page.body.includes('Hold one lamp'));
  check(blockSafe, 'markup/offersSignpost-refuses-or-escapes',
    blockRefused ? 'refused' : `rendered ${String(block).slice(0, 300)}`);
  check(pageSafe, 'markup/page-refuses-or-escapes',
    pageRefused ? 'refused' : `${page?.type} ${String(page?.body).slice(0, 300)}`);
  if (!blockRefused && !pageRefused && page) {
    check(page.body.includes(block), 'markup/page-contains-the-same-block');
  }
  if (!pageRefused && page) {
    const notice = await get(makeEntry(marked), '/', 'text/plain');
    check(notice.body === textNotice(makeEntry(marked)), 'markup/plain-accept-stays-the-text-notice');
    check(!notice.body.includes(MARKUP) && !renderedRaw(notice.body), 'markup/plain-accept-does-not-render-the-description');
  }
});

await section('init-snippet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-entry-front-page-init-'));
  try {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n.env\n');
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: 'harbor-lamp-express', private: true, type: 'module',
      dependencies: { express: '5.1.0' },
    }, null, 2)}\n`);
    writeFileSync(join(dir, 'server.js'),
      "import express from 'express';\n\nconst app = express();\n"
      + "app.get('/', (req, res) => res.send('<h1>Harbor Lamp</h1>'));\n"
      + 'app.listen(process.env.PORT || 3000);\n');
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    const run = spawnSync(process.execPath, [DOOR_FILE, 'init', '--json', '--trade', 'retail',
      '--name', 'Harbor Lamp', '--base-url', 'https://shop.example'],
      { cwd: dir, encoding: 'utf8', timeout: 30000 });
    check(run.status === 0, 'init/exit-0', run.stderr?.slice(0, 400));
    const doorModule = join(dir, 'agent-entry.door.mjs');
    let source = '';
    try { source = readFileSync(doorModule, 'utf8'); } catch (error) {
      check(false, 'init/writes-the-door-module', error?.message);
    }
    check(source.includes('offersSignpost'), 'init/door-module-calls-offersSignpost',
      source.slice(0, 400));
    const written = join(dir, 'agent-entry.json');
    let initDecl = null;
    try { initDecl = JSON.parse(readFileSync(written, 'utf8')); } catch { /* reported below */ }
    if (check(initDecl !== null, 'init/writes-the-declaration')) {
      const block = signpost(initDecl);
      check(typeof block === 'string' && block.includes('needs the customer\'s key'),
        'init/declaration-has-a-block');
      check(source.includes('offersSignpost'), 'init/snippet-prints-offersSignpost');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function findPhp(bin) {
  const out = spawnSync(bin, ['-r', 'echo extension_loaded("sodium") ? "sodium" : "no-sodium";'],
    { encoding: 'utf8', timeout: 15000 });
  if (out.error || out.status !== 0) return null;
  return { bin, sodium: out.stdout.trim() === 'sodium' };
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

function phpString(text) {
  return `s:${Buffer.byteLength(text, 'utf8')}:"${text}";`;
}

await section('plugin', async () => {
  const php = findPhp(process.env.AGENT_ENTRY_PHP || 'php');
  if (!php) {
    check(true, 'plugin/php-absent-skipped');
    return;
  }
  if (!php.sodium) {
    check(true, 'plugin/php-without-sodium-skipped');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'agent-entry-front-page-plugin-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const pluginDecl = clone(declaration);
  pluginDecl.entry.baseUrl = origin;
  const statePath = join(dir, 'state.json');
  const text = JSON.stringify(pluginDecl);
  writeFileSync(statePath, JSON.stringify({
    options: { muretai_agent_entry_declaration: Buffer.from(phpString(text), 'utf8').toString('base64') },
    transients: {},
  }));
  const env = { ...process.env, MAE_SHIM_PLUGIN: PLUGIN, MAE_SHIM_STATE: statePath, MAE_SHIM_HOME: origin };
  const activated = spawnSync(php.bin, [SHIM, 'activate'], { env, encoding: 'utf8', timeout: 30000 });
  check(activated.status === 0, 'plugin/activates', activated.stderr?.slice(0, 300));
  const child = spawn(php.bin, ['-S', `127.0.0.1:${port}`, SHIM], {
    cwd: dirname(SHIM), env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  try {
    const deadline = Date.now() + 15000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        await fetch(`${origin}/`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(1000) });
        up = true;
        break;
      } catch { /* not up yet */ }
    }
    check(up, 'plugin/server-started', stderr.slice(0, 300));
    if (!up) return;
    const res = await fetch(`${origin}/`, {
      headers: { accept: 'text/html' }, signal: AbortSignal.timeout(10000),
    });
    const body = await res.text();
    const block = signpost(pluginDecl);
    check(body.includes(block), 'plugin/site-page-prints-the-block',
      `HTTP ${res.status} ${body.slice(0, 300)}`);
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

if (failures.length) {
  console.error(`FAILED ${failures.length} of ${passed + failures.length}`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`ok ${passed}`);
