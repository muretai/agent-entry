#!/usr/bin/env node
// init --from site: product sitemap, product-page JSON-LD, and the platform hints.
//
// WRITTEN BEFORE THE IMPLEMENTATION. Intake 20261007T202521Z. The authority is that
// requirement and the design record section 6 (the storefront batch). The implementer
// may not edit this file. The stores are local fixtures on 127.0.0.1. Nothing here
// dials a live site.
//
//   agent-entry init --from site <https store url> [--hint wix|squarespace|base]
//       [--facts <file>] [--max-pages <n>] [--max-bytes <n>] [--name <name>] [--json]
//
// robots.txt is read first. A disallow is honoured: the disallowed path is never
// requested, the refusal names robots, and nothing is written.
// No product sitemap and no Product JSON-LD is refused by the name not-a-store,
// and nothing is written.
//
// The declaration is the one checkedDeclaration accepts. The snapshot rows are the
// ones catalogRow returns: id, name, price, stock_status, permalink, in that order.
// agent-entry.json carries ask shop (door.reply facts), find products (door.reply
// catalog) and hold item (door.reply pending, input id is a string, the sku or the
// slug). agent-entry.products.json is the snapshot beside it. Same bounds as
// init --from woocommerce: --max-pages and --max-bytes, the README defaults, a
// page-bound or a byte-bound named when it ends the walk, a first product page past
// the byte bound refused with nothing written.
//
// One page of --max-pages is one product HTML page. robots.txt, the sitemap, a
// squarespace collection JSON page and a base category page are discovery: they are
// read, and they count toward neither --max-pages nor --max-bytes. --max-bytes is
// the sum of the product HTML bodies. A first product page that does not fit is a
// refusal and writes nothing.
//
// id is Product.sku, else Offer.sku, else the last segment of the permalink.
// price is Offer.price (a JSON string kept as written, a JSON number in decimal)
// then a space then Offer.priceCurrency. stock_status is in_stock when the
// availability token is InStock and out_of_stock when it is OutOfStock. The token
// may be bare or the last segment of a schema.org URL. The offer object may be
// under offers or Offers, and the token under availability or Availability: both
// spellings were on public pages. permalink is Offer.url when it is https on the
// store origin. A permalink off that origin is left out of the snapshot and never
// requested. A Product with no Offer is left out. Description, image and seller
// never enter the snapshot.
//
// Hints, each a recorded store served by startStore through siteStore:
//   wix          sitemap index, then store-products-sitemap.xml, then those pages.
//                A blog sitemap in the same index is not fetched.
//   squarespace  the collection page as ?format=json, 20 items on a page, the next
//                page at offset=20, then each item's HTML. The row comes from that
//                page's JSON-LD, not from the collection item's price.
//   base         /categories/<id> pages, then the /items/<id> links written on them.
//                An /items/ loc that appears only in the sitemap is not fetched.
// With no hint, a sitemap urlset of product pages is read the same way.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { guardLog } from './fixtures/cli/loopback-only.mjs';
import { makeRuntimeTls } from './fixtures/cli/runtime-tls.mjs';
import {
  canonicalJSON, createAgentEntry, didFromSeedHex, signEnvelope, validateDeclaration,
} from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'muretai-agent-entry.mjs');
const FIX = join(HERE, 'fixtures', 'cli');
const GUARD = join(FIX, 'loopback-only.mjs');
const FACTS_FILE = join(FIX, 'woo', 'facts.json');
const FACTS = JSON.parse(readFileSync(FACTS_FILE, 'utf8'));
const TREES = JSON.parse(readFileSync(join(FIX, 'frameworks.json'), 'utf8'));
const SNAPSHOT = 'agent-entry.products.json';
const DECL = 'agent-entry.json';
const PAGE_SIZE = 20;

const TLS = makeRuntimeTls({ prefix: 'ae-site-tls-' });
const ENV = { NODE_EXTRA_CA_CERTS: TLS.caPath };

let passed = 0;
const failures = [];
const scratch = [TLS.dir];

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${String(detail).slice(0, 500)}` : ''}`);
  return false;
}

async function section(name, fn) {
  try { await fn(); } catch (error) { check(false, `${name}/threw`, error?.stack || String(error)); }
}

function tmp(prefix = 'ae-site-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

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
  };
}

const HOME = tmp('ae-site-home-');
writeFileSync(join(HOME, '.gitconfig-empty'), '');

function git(cwd, args) {
  return spawnSync('git', args, { cwd, env: baseEnv(HOME), encoding: 'utf8' });
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

function makeRepo(name) {
  const tree = TREES.frameworks[name];
  const dir = tmp(`ae-site-${name}-`);
  writeFiles(dir, tree.files);
  if (tree.gitignore !== null) writeFileSync(join(dir, '.gitignore'), tree.gitignore);
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return dir;
}

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

function runCli(args, { cwd, env = {}, timeout = 20000 } = {}) {
  const log = join(tmp('ae-site-guard-'), 'guard.jsonl');
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

function guardClean(label, run, { onlyPort = null } = {}) {
  check(run.guard.some((r) => r.kind === 'loaded'), `${label}/guard-loaded`);
  const blocked = run.guard.filter((r) => r.allowed === false);
  check(blocked.length === 0, `${label}/never-dials-out`, JSON.stringify(blocked.slice(0, 2)));
  check(!run.timedOut, `${label}/finished`, 'timed out');
  if (onlyPort !== null) {
    const elsewhere = run.guard.filter((r) => r.kind === 'connect' && r.port !== onlyPort);
    check(elsewhere.length === 0, `${label}/connects-only-to-the-fixture`, JSON.stringify(elsewhere.slice(0, 2)));
  }
}

function startStore(handler) {
  return new Promise((resolveStart) => {
    const hits = [];
    const sockets = new Set();
    const server = createHttpsServer({ key: TLS.key, cert: TLS.cert }, (req, res) => {
      hits.push({ method: req.method, url: req.url });
      req.resume();
      handler(req, res);
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.on('tlsClientError', () => { /* a client that hangs up mid-handshake */ });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({
        port, hits, origin: `https://127.0.0.1:${port}`,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

function send(res, type, body, status = 200) {
  const buf = Buffer.from(body);
  res.writeHead(status, { 'content-type': type, 'content-length': String(buf.length) });
  res.end(buf);
}

const pathOf = (h) => {
  const u = new URL(h.url, 'https://x.invalid');
  return u.pathname.replace(/\/$/, '') || '/';
};

function urlset(origin, paths) {
  const urls = paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function sitemapIndex(origin, paths) {
  const maps = paths.map((p) => `  <sitemap><loc>${origin}${p}</loc></sitemap>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${maps}\n</sitemapindex>\n`;
}

function productPage(blocks) {
  const scripts = blocks.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('');
  return `<!doctype html><html><head>${scripts}</head><body><h1>item</h1></body></html>`;
}

/** The router startStore serves. `answer(origin, path, url, res)` writes the response. */
function siteStore(store, answer) {
  return (req, res) => {
    const origin = store.origin;
    const url = new URL(req.url, origin);
    const path = url.pathname.replace(/\/$/, '') || '/';
    answer(origin, path, url, res);
  };
}

async function openStore(answer) {
  let store = null;
  store = await startStore((req, res) => siteStore(store, answer)(req, res));
  return store;
}

function stockOf(availability) {
  return String(availability).split('/').pop() === 'InStock' ? 'in_stock' : 'out_of_stock';
}

function rowOf(origin, spec) {
  const permalink = spec.foreign || `${origin}${spec.path}`;
  const id = spec.sku || spec.offerSku || spec.path.split('/').filter(Boolean).pop();
  return {
    id, name: spec.name, price: `${spec.price} ${spec.currency}`,
    stock_status: stockOf(spec.availability), permalink,
  };
}

function wixBlocks(origin, spec) {
  const permalink = spec.foreign || `${origin}${spec.path}`;
  const org = { '@context': 'https://schema.org/', '@type': 'Organization', name: 'Harbor Lamp', url: `${origin}/about` };
  const product = {
    '@context': 'https://schema.org/', '@type': 'Product', name: spec.name,
    description: spec.description || 'Solid brass, hand finished.',
    image: `${origin}/media/${spec.path.split('/').pop()}.jpg`,
  };
  if (spec.sku) product.sku = spec.sku;
  if (!spec.drop) {
    const offer = {
      '@type': 'Offer', url: permalink, priceCurrency: spec.currency, price: spec.price,
    };
    offer[spec.availabilityKey || 'availability'] = spec.availability;
    if (spec.offerSku) offer.sku = spec.offerSku;
    product[spec.offersKey || 'offers'] = offer;
  }
  return [org, product];
}

function readmeDefault(flag) {
  const line = readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n').find((l) => l.includes(flag) && /default/i.test(l));
  const m = line ? line.split(flag).join(' ').replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\b(\d+)\b/) : null;
  return m ? Number(m[1]) : null;
}

function generated(n) {
  return Array.from({ length: n }, (_, i) => ({
    path: `/product-page/lamp-${i + 1}`,
    name: `Lamp ${i + 1}`,
    sku: `L-${i + 1}`,
    price: `${i + 1}.00`,
    currency: 'EUR',
    availability: 'https://schema.org/InStock',
  }));
}

async function runInit(label, store, extra, { facts = FACTS_FILE, onlyPort = store.port } = {}) {
  const dir = makeRepo('vite');
  const before = treeState(dir);
  const home = tmp('ae-site-home-');
  const from = store.hits.length;
  const args = ['init', '--from', 'site', store.origin, ...(facts ? ['--facts', facts] : []), ...extra];
  const run = await runCli(args, { cwd: dir, env: { ...ENV, HOME: home } });
  guardClean(label, run, { onlyPort });
  return { dir, before, home, run, hits: store.hits.slice(from) };
}

function unwritten(label, got) {
  const diff = stateDiff(got.before, treeState(got.dir));
  check(diff.length === 0, `${label}/writes-nothing`, JSON.stringify(diff.slice(0, 8)));
  check(!existsSync(join(got.dir, DECL)), `${label}/no-agent-entry.json`);
  check(!existsSync(join(got.dir, SNAPSHOT)), `${label}/no-snapshot`);
}

function productHits(hits, prefix) {
  return hits.filter((h) => h.method === 'GET' && pathOf(h).startsWith(prefix));
}

await section('site-help', async () => {
  const help = await runCli(['init', '--help']);
  check(help.code === 0 && /--from site\b/.test(help.stdout) && /--hint\b/.test(help.stdout)
    && help.stdout.includes('--max-pages') && help.stdout.includes('--max-bytes'),
  'site-help/names-site-hint-and-the-bounds', `exit ${help.code}; ${help.stdout.slice(0, 400)}`);
});

await section('site-wix', async () => {
  const specs = [
    { path: '/product-page/shade', name: 'Shade <b> & co', sku: 'S-1', price: '24.00', currency: 'EUR',
      availability: 'https://schema.org/InStock', description: 'Natural linen over a steel frame.' },
    { path: '/product-page/linen-shade', name: 'Linen Shade', price: '15.00', currency: 'EUR',
      availability: 'https://schema.org/OutOfStock', offersKey: 'Offers', availabilityKey: 'Availability' },
    { path: '/product-page/away', name: 'Away Lamp', sku: 'A-1', price: '9.00', currency: 'EUR',
      availability: 'https://schema.org/InStock', foreign: 'https://192.0.2.1/product/away' },
    { path: '/product-page/dropped', name: 'Dropped Lamp', sku: 'D-1', drop: true },
  ];
  const store = await openStore((origin, path, url, res) => {
    if (path === '/robots.txt') return send(res, 'text/plain; charset=utf-8', 'User-agent: *\nAllow: /\n');
    if (path === '/sitemap.xml') return send(res, 'text/xml; charset=utf-8', sitemapIndex(origin, ['/store-products-sitemap.xml', '/blog-posts-sitemap.xml']));
    if (path === '/store-products-sitemap.xml') return send(res, 'text/xml; charset=utf-8', urlset(origin, specs.map((s) => s.path)));
    if (path === '/blog-posts-sitemap.xml') return send(res, 'text/xml; charset=utf-8', urlset(origin, ['/blog/hello']));
    const spec = specs.find((s) => s.path === path);
    if (spec) return send(res, 'text/html; charset=utf-8', productPage(wixBlocks(origin, spec)));
    return send(res, 'text/html; charset=utf-8', '<!doctype html><title>missing</title>', 404);
  });
  try {
    const want = [rowOf(store.origin, specs[0]), rowOf(store.origin, specs[1])];
    const first = await runInit('site-wix/recorded', store, ['--hint', 'wix', '--json']);
    if (!check(first.run.code === 0, 'site-wix/recorded/exit-0', `exit ${first.run.code}; ${first.run.stderr.slice(0, 400)}`)) return;
    const declText = readFileSync(join(first.dir, DECL), 'utf8');
    const declaration = JSON.parse(declText);
    check(validateDeclaration(declaration) && declaration.entry.baseUrl.replace(/\/$/, '') === store.origin,
      'site-wix/recorded/declaration-validates-on-the-store', JSON.stringify(declaration.entry));
    check(canonicalJSON(declaration.facts) === canonicalJSON(FACTS), 'site-wix/recorded/facts-are-the-file');
    const offers = declaration.offers.map((o) => `${o.verb} ${o.of} ${o.door && o.door.reply}`);
    check(JSON.stringify(offers) === JSON.stringify(['ask shop facts', 'find products catalog', 'hold item pending']),
      'site-wix/recorded/ask-find-hold', JSON.stringify(offers));
    const hold = declaration.offers.find((o) => o.verb === 'hold');
    check(hold && hold.input && hold.input.id === 'string' && hold.door.receipt !== false && !Object.hasOwn(hold.door, 'url'),
      'site-wix/recorded/hold-id-is-a-string-and-has-no-checkout-url', JSON.stringify(hold));
    check(!declaration.offers.some((o) => ['buy', 'pay', 'purchase', 'checkout', 'order'].includes(o.verb)),
      'site-wix/recorded/no-payment-verb');
    const raw = readFileSync(join(first.dir, SNAPSHOT), 'utf8');
    const rows = JSON.parse(raw);
    check(JSON.stringify(rows) === JSON.stringify(want), 'site-wix/recorded/snapshot-rows', `${JSON.stringify(rows)} want ${JSON.stringify(want)}`);
    const escaped = `${JSON.stringify(want, null, 2)}\n`.replace(/[<>&]/g, (c) => `\\u00${c.charCodeAt(0).toString(16)}`);
    check(raw === escaped, 'site-wix/recorded/snapshot-escapes-markup', raw.slice(0, 300));
    for (const leak of ['Natural linen', 'Solid brass', 'Harbor Lamp', '/media/', '/about', '192.0.2.1', 'Dropped Lamp', 'Away Lamp']) {
      check(!raw.includes(leak), `site-wix/recorded/snapshot-omits-${leak.replace(/\W+/g, '-')}`);
    }
    const out = JSON.parse(first.run.stdout);
    check(out.from === 'site' && out.stopped === null && out.pages === 4 && out.products === 4
      && out.wrote.includes(DECL) && out.wrote.includes(SNAPSHOT),
    'site-wix/recorded/json-names-the-walk', JSON.stringify(out));
    const robotsAt = first.hits.findIndex((h) => pathOf(h) === '/robots.txt');
    const mapAt = first.hits.findIndex((h) => pathOf(h) === '/sitemap.xml');
    const productsAt = first.hits.findIndex((h) => pathOf(h) === '/store-products-sitemap.xml');
    const pageAt = first.hits.findIndex((h) => pathOf(h) === specs[0].path);
    check(robotsAt !== -1 && robotsAt < mapAt && mapAt < productsAt && productsAt < pageAt,
      'site-wix/recorded/robots-then-index-then-product-sitemap-then-pages', JSON.stringify(first.hits));
    check(!first.hits.some((h) => pathOf(h) === '/blog-posts-sitemap.xml' || pathOf(h) === '/blog/hello' || pathOf(h).startsWith('/media/') || pathOf(h) === '/about'),
      'site-wix/recorded/skips-the-blog-sitemap-and-never-fetches-images', JSON.stringify(first.hits.map(pathOf)));
    const second = await runInit('site-wix/again', store, ['--hint', 'wix', '--json']);
    if (second.run.code === 0) {
      check(readFileSync(join(second.dir, SNAPSHOT), 'utf8') === raw, 'site-wix/again/snapshot-byte-identical');
      check(readFileSync(join(second.dir, DECL), 'utf8') === declText, 'site-wix/again/declaration-byte-identical');
    }

    await store.close();
    const entry = createAgentEntry({
      seedHex: 'e1'.repeat(32), name: declaration.entry.name, baseUrl: declaration.entry.baseUrl,
      declaration, catalogFile: join(first.dir, SNAPSHOT), signedRatePerMin: 0, signedRatePerMinTotal: 0,
    });
    const from = didFromSeedHex('5e'.repeat(32));
    const messageId = 'site-find-1';
    const timestamp = Math.floor(Date.now() / 1000);
    const text = 'find products {"q":"shade"}';
    const sig = signEnvelope('5e'.repeat(32), { from, to: entry.did, messageId, contextId: null, timestamp, text });
    const body = Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: messageId, method: 'message/send',
      params: { message: { kind: 'message', role: 'user', messageId, contextId: null, parts: [{ kind: 'text', text }],
        metadata: { from, to: entry.did, timestamp, sig, offer: 'find' } } },
    }));
    const fetches = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input) => { fetches.push(String(input && input.url || input)); throw new TypeError('no fetch at reply time'); };
    let reply = null;
    let replyText = '';
    try {
      const answered = await entry.handleRequestAsync('POST', '/', { 'content-type': 'application/json' }, body, { remoteAddress: '127.0.0.1' });
      replyText = JSON.parse(Buffer.from(answered.body || '').toString('utf8')).result.parts[0].text;
      reply = JSON.parse(replyText);
    } catch (error) {
      check(false, 'site-wix/recorded/find-answered', String(error && error.message || error));
    } finally { globalThis.fetch = realFetch; }
    if (reply) {
      check(reply.verb === 'find' && reply.status === 'see_catalog', 'site-wix/recorded/find-replies-from-the-snapshot', JSON.stringify(reply).slice(0, 300));
      check(canonicalJSON(reply.products) === canonicalJSON(want), 'site-wix/recorded/find-products-are-the-rows');
      check(fetches.length === 0 && !/<b>|&/.test(replyText), 'site-wix/recorded/find-fetches-nothing-and-escapes-markup', replyText.slice(0, 200));
    }
  } finally { await store.close(); }
});

await section('site-generic', async () => {
  const spec = { path: '/p/brass-desk-lamp', name: 'Brass Desk Lamp', sku: 'L-12', price: '89.00', currency: 'EUR',
    availability: 'https://schema.org/InStock' };
  const store = await openStore((origin, path, url, res) => {
    if (path === '/robots.txt') return send(res, 'text/plain; charset=utf-8', 'User-agent: *\nAllow: /\n');
    if (path === '/sitemap.xml') return send(res, 'text/xml; charset=utf-8', urlset(origin, [spec.path]));
    if (path === spec.path) return send(res, 'text/html; charset=utf-8', productPage(wixBlocks(origin, spec)));
    return send(res, 'text/html; charset=utf-8', '<!doctype html><title>missing</title>', 404);
  });
  try {
    const got = await runInit('site-generic/urlset', store, ['--json']);
    if (!check(got.run.code === 0, 'site-generic/urlset/exit-0', `exit ${got.run.code}; ${got.run.stderr.slice(0, 300)}`)) return;
    const rows = JSON.parse(readFileSync(join(got.dir, SNAPSHOT), 'utf8'));
    check(JSON.stringify(rows) === JSON.stringify([rowOf(store.origin, spec)]), 'site-generic/urlset/one-row', JSON.stringify(rows));
    const robotsAt = got.hits.findIndex((h) => pathOf(h) === '/robots.txt');
    const pageAt = got.hits.findIndex((h) => pathOf(h) === spec.path);
    check(robotsAt !== -1 && robotsAt < pageAt, 'site-generic/urlset/robots-before-the-product-page', JSON.stringify(got.hits.map(pathOf)));
  } finally { await store.close(); }
});

function squarespaceSpecs() {
  const specs = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => ({
    path: `/shop/p/lamp-${i + 1}`,
    name: `Lamp ${i + 1}`,
    offerSku: `SQ-${i + 1}`,
    price: i === 0 ? 24.5 : (i + 1),
    currency: 'USD',
    availability: i === PAGE_SIZE ? 'OutOfStock' : 'InStock',
  }));
  return specs;
}

function squarespaceBlocks(origin, spec) {
  const offer = {
    price: spec.price, priceCurrency: spec.currency, url: `${origin}${spec.path}`,
    availability: spec.availability, sku: spec.offerSku, '@context': 'http://schema.org', '@type': 'Offer',
  };
  return [
    { '@context': 'http://schema.org', '@type': 'WebSite', name: 'Harbor', url: `${origin}/` },
    { name: spec.name, image: `${origin}/media/${spec.offerSku}.jpg`, description: 'Solid brass, hand finished.',
      brand: 'Harbor', offers: offer, '@context': 'http://schema.org', '@type': 'Product' },
  ];
}

function squarespaceJson(specs, offset) {
  const slice = specs.slice(offset, offset + PAGE_SIZE);
  return JSON.stringify({
    collection: { fullUrl: '/shop', pageSize: PAGE_SIZE, itemCount: specs.length },
    items: slice.map((s) => ({
      fullUrl: s.path, urlId: s.path.split('/').pop(), title: `decoy ${s.offerSku}`,
      priceCents: 1, priceMoney: { currency: 'USD', value: '0.01' },
    })),
  });
}

function jsonOffsets(hits) {
  return hits.filter((h) => h.method === 'GET').map((h) => {
    const u = new URL(h.url, 'https://x.invalid');
    if ((u.pathname.replace(/\/$/, '') || '/') !== '/shop') return null;
    if (u.searchParams.get('format') !== 'json') return null;
    return u.searchParams.get('offset') ?? '0';
  }).filter((x) => x !== null);
}

await section('site-squarespace', async () => {
  const specs = squarespaceSpecs();
  const store = await openStore((origin, path, url, res) => {
    if (path === '/robots.txt') return send(res, 'text/plain; charset=utf-8', 'User-agent: *\nAllow: /\n');
    if (path === '/sitemap.xml') return send(res, 'text/xml; charset=utf-8', urlset(origin, ['/shop']));
    if (path === '/shop' && url.searchParams.get('format') === 'json') {
      const offset = Number(url.searchParams.get('offset') || '0');
      return send(res, 'application/json; charset=utf-8', squarespaceJson(specs, offset));
    }
    const spec = specs.find((s) => s.path === path);
    if (spec) return send(res, 'text/html; charset=utf-8', productPage(squarespaceBlocks(origin, spec)));
    return send(res, 'text/html; charset=utf-8', '<!doctype html><title>shop</title>', 200);
  });
  try {
    const full = await runInit('site-squarespace/two-pages', store, ['--hint', 'squarespace', '--json']);
    if (check(full.run.code === 0, 'site-squarespace/two-pages/exit-0', `exit ${full.run.code}; ${full.run.stderr.slice(0, 300)}`)) {
      const rows = JSON.parse(readFileSync(join(full.dir, SNAPSHOT), 'utf8'));
      const want = specs.map((s) => rowOf(store.origin, s));
      check(JSON.stringify(rows) === JSON.stringify(want), 'site-squarespace/two-pages/json-ld-price-not-the-collection-price',
        JSON.stringify(rows.slice(0, 2)));
      check(!readFileSync(join(full.dir, SNAPSHOT), 'utf8').includes('decoy') && !readFileSync(join(full.dir, SNAPSHOT), 'utf8').includes('0.01'),
        'site-squarespace/two-pages/collection-fields-stay-out-of-the-snapshot');
      check(JSON.stringify(jsonOffsets(full.hits)) === JSON.stringify(['0', '20']),
        'site-squarespace/two-pages/format-json-then-offset-20', JSON.stringify(jsonOffsets(full.hits)));
      check(!jsonOffsets(full.hits).includes('40'), 'site-squarespace/two-pages/stops-when-the-page-is-short');
      const last = full.hits.findIndex((h) => pathOf(h) === specs[PAGE_SIZE].path);
      const second = full.hits.findIndex((h) => jsonOffsets([h])[0] === '20');
      check(second !== -1 && last > second, 'site-squarespace/two-pages/page-2-item-is-read-after-offset-20', JSON.stringify(full.hits.map(pathOf)));
      const robotsAt = full.hits.findIndex((h) => pathOf(h) === '/robots.txt');
      const jsonAt = full.hits.findIndex((h) => jsonOffsets([h]).length === 1);
      check(robotsAt !== -1 && jsonAt !== -1 && robotsAt < jsonAt, 'site-squarespace/two-pages/robots-before-format-json',
        JSON.stringify(full.hits.map(pathOf)));
    }
    const bounded = await runInit('site-squarespace/max-pages-1', store, ['--hint', 'squarespace', '--max-pages', '1', '--json']);
    if (check(bounded.run.code === 0, 'site-squarespace/max-pages-1/exit-0', `exit ${bounded.run.code}; ${bounded.run.stderr.slice(0, 300)}`)) {
      const out = JSON.parse(bounded.run.stdout);
      check(out.stopped === 'page-bound' && out.pages === 1, 'site-squarespace/max-pages-1/names-the-page-bound', JSON.stringify(out));
      check(JSON.stringify(jsonOffsets(bounded.hits)) === JSON.stringify(['0']),
        'site-squarespace/max-pages-1/does-not-request-offset-20', JSON.stringify(jsonOffsets(bounded.hits)));
      check(productHits(bounded.hits, '/shop/p/').length === 1, 'site-squarespace/max-pages-1/one-product-page',
        JSON.stringify(bounded.hits.map(pathOf)));
      const rows = JSON.parse(readFileSync(join(bounded.dir, SNAPSHOT), 'utf8'));
      check(rows.length === 1 && rows[0].id === 'SQ-1' && rows[0].price === '24.5 USD',
        'site-squarespace/max-pages-1/keeps-the-first-json-ld-row', JSON.stringify(rows[0]));
    }
  } finally { await store.close(); }
});

const BASE_KEPT = [
  { path: '/items/11', name: 'Brass Desk Lamp', sku: 'B-11', price: '8.00', currency: 'EUR', availability: 'https://schema.org/InStock' },
  { path: '/items/12', name: 'Linen Shade', price: '6.50', currency: 'EUR', availability: 'https://schema.org/OutOfStock',
    offersKey: 'Offers', availabilityKey: 'Availability' },
];

function baseAnswer(kind) {
  return (origin, path, url, res) => {
    if (path === '/robots.txt') return send(res, 'text/plain; charset=utf-8', 'User-agent: *\nAllow: /\n');
    if (path === '/sitemap.xml') return send(res, 'text/xml; charset=utf-8', urlset(origin, ['/categories/7', '/items/99']));
    if (path === '/categories/7') {
      return send(res, 'text/html; charset=utf-8', '<!doctype html><html><body><a href="/items/11">one</a><a href="/items/12">two</a></body></html>');
    }
    if (path === '/items/99') return send(res, 'text/html; charset=utf-8', productPage(wixBlocks(origin, {
      path: '/items/99', name: 'Sitemap Only', sku: 'NO-99', price: '1.00', currency: 'EUR', availability: 'https://schema.org/InStock',
    })));
    const spec = BASE_KEPT.find((s) => s.path === path);
    if (spec && kind === 'jsonld') return send(res, 'text/html; charset=utf-8', productPage(wixBlocks(origin, spec)));
    if (spec && kind === 'observed') {
      return send(res, 'text/html; charset=utf-8',
        '<!doctype html><html><head><meta property="product:price:amount" content="8000"></head><body><div data-item="11">ItemPrice 8000</div></body></html>');
    }
    return send(res, 'text/html; charset=utf-8', '<!doctype html><title>missing</title>', 404);
  };
}

await section('site-base', async () => {
  const store = await openStore(baseAnswer('jsonld'));
  try {
    const got = await runInit('site-base/categories', store, ['--hint', 'base', '--json']);
    if (check(got.run.code === 0, 'site-base/categories/exit-0', `exit ${got.run.code}; ${got.run.stderr.slice(0, 300)}`)) {
      const rows = JSON.parse(readFileSync(join(got.dir, SNAPSHOT), 'utf8'));
      check(JSON.stringify(rows) === JSON.stringify(BASE_KEPT.map((s) => rowOf(store.origin, s))),
        'site-base/categories/rows-from-item-json-ld', JSON.stringify(rows));
      const cat = got.hits.findIndex((h) => pathOf(h) === '/categories/7');
      const item = got.hits.findIndex((h) => pathOf(h) === '/items/11');
      check(got.hits.findIndex((h) => pathOf(h) === '/robots.txt') < cat && cat < item && item < got.hits.findIndex((h) => pathOf(h) === '/items/12'),
        'site-base/categories/robots-then-category-then-items', JSON.stringify(got.hits.map(pathOf)));
      check(!got.hits.some((h) => pathOf(h) === '/items/99'), 'site-base/categories/sitemap-item-loc-is-not-the-catalog',
        JSON.stringify(got.hits.map(pathOf)));
    }
    const bounded = await runInit('site-base/max-pages-1', store, ['--hint', 'base', '--max-pages', '1', '--json']);
    if (check(bounded.run.code === 0, 'site-base/max-pages-1/exit-0', `exit ${bounded.run.code}; ${bounded.run.stderr.slice(0, 300)}`)) {
      const out = JSON.parse(bounded.run.stdout);
      check(out.stopped === 'page-bound' && productHits(bounded.hits, '/items/').map(pathOf).join(',') === '/items/11',
        'site-base/max-pages-1/reads-one-item-page', JSON.stringify({ out, hits: bounded.hits.map(pathOf) }));
    }
  } finally { await store.close(); }

  const observed = await openStore(baseAnswer('observed'));
  try {
    const got = await runInit('site-base/refused/no-product-json-ld', observed, ['--hint', 'base']);
    check(got.run.code === 1 && got.run.stderr.includes('not-a-store'), 'site-base/refused/no-product-json-ld/not-a-store',
      `exit ${got.run.code}; ${got.run.stderr.slice(0, 300)}`);
    check(got.hits.some((h) => pathOf(h) === '/items/11'), 'site-base/refused/no-product-json-ld/the-item-page-was-read',
      JSON.stringify(got.hits.map(pathOf)));
    unwritten('site-base/refused/no-product-json-ld', got);
  } finally { await observed.close(); }
});

await section('site-bounds', async () => {
  const defaultPages = readmeDefault('--max-pages');
  check(defaultPages === 10, 'site-bounds/readme-default-pages-is-10', String(defaultPages));
  const many = generated(defaultPages + 2);
  const store = await openStore((origin, path, url, res) => {
    if (path === '/robots.txt') return send(res, 'text/plain; charset=utf-8', 'User-agent: *\nAllow: /\n');
    if (path === '/sitemap.xml') return send(res, 'text/xml; charset=utf-8', sitemapIndex(origin, ['/store-products-sitemap.xml']));
    if (path === '/store-products-sitemap.xml') return send(res, 'text/xml; charset=utf-8', urlset(origin, many.map((s) => s.path)));
    const spec = many.find((s) => s.path === path);
    if (spec) return send(res, 'text/html; charset=utf-8', productPage(wixBlocks(origin, spec)));
    return send(res, 'text/html; charset=utf-8', '<!doctype html><title>missing</title>', 404);
  });
  try {
    const got = await runInit('site-bounds/default-page-bound', store, ['--hint', 'wix', '--json']);
    if (check(got.run.code === 0, 'site-bounds/default-page-bound/exit-0', `exit ${got.run.code}; ${got.run.stderr.slice(0, 300)}`)) {
      const out = JSON.parse(got.run.stdout);
      const pages = productHits(got.hits, '/product-page/').map(pathOf);
      const wantPages = many.slice(0, defaultPages).map((s) => s.path);
      check(out.stopped === 'page-bound' && JSON.stringify(pages) === JSON.stringify(wantPages),
        'site-bounds/default-page-bound/stops-at-the-readme-default', JSON.stringify({ out, pages }));
    }
    const one = await runInit('site-bounds/max-pages-1', store, ['--hint', 'wix', '--max-pages', '1', '--json']);
    if (check(one.run.code === 0, 'site-bounds/max-pages-1/exit-0', `exit ${one.run.code}; ${one.run.stderr.slice(0, 300)}`)) {
      const out = JSON.parse(one.run.stdout);
      check(out.stopped === 'page-bound' && productHits(one.hits, '/product-page/').length === 1,
        'site-bounds/max-pages-1/one-product-page', JSON.stringify(out));
      const text = await runInit('site-bounds/max-pages-1-text', store, ['--hint', 'wix', '--max-pages', '1'], {});
      check(text.run.code === 0 && /page[- ]bound/i.test(`${text.run.stdout}${text.run.stderr}`),
        'site-bounds/max-pages-1-text/names-the-page-bound', text.run.stdout.slice(0, 300));
    }
    const firstHtml = productPage(wixBlocks(store.origin, many[0]));
    const over = await runInit('site-bounds/refused/first-page-over-max-bytes', store,
      ['--hint', 'wix', '--max-bytes', String(Buffer.byteLength(firstHtml) - 1)]);
    check(over.run.code === 1 && /byte|bound/i.test(over.run.stderr), 'site-bounds/refused/first-page-over-max-bytes/exit-1',
      `exit ${over.run.code}; ${over.run.stderr.slice(0, 300)}`);
    check(productHits(over.hits, '/product-page/').length <= 1, 'site-bounds/refused/first-page-over-max-bytes/no-later-page',
      JSON.stringify(over.hits.map(pathOf)));
    unwritten('site-bounds/refused/first-page-over-max-bytes', over);
  } finally { await store.close(); }

  const bare = await openStore((origin, path, url, res) => {
    if (path === '/robots.txt') return send(res, 'text/plain; charset=utf-8', 'User-agent: *\nAllow: /\n');
    return send(res, 'text/html; charset=utf-8', '<!doctype html><title>missing</title>', 404);
  });
  try {
    for (const [flag, value] of [['--max-pages', '0'], ['--max-pages', 'abc'], ['--max-bytes', '-1']]) {
      const label = `site-bounds/refused/${flag}-${value}`;
      const got = await runInit(label, bare, ['--hint', 'wix', flag, value]);
      check(got.run.code === 2 && got.run.stderr.includes(flag), `${label}/misuse-exit-2`, `exit ${got.run.code}; ${got.run.stderr.slice(0, 200)}`);
      check(got.hits.length === 0, `${label}/before-any-request`, JSON.stringify(got.hits));
      unwritten(label, got);
    }
    const hint = await runInit('site-bounds/refused/hint-unknown', bare, ['--hint', 'no-such']);
    check(hint.run.code === 2 && /hint/i.test(hint.run.stderr), 'site-bounds/refused/hint-unknown/misuse-exit-2',
      `exit ${hint.run.code}; ${hint.run.stderr.slice(0, 200)}`);
    check(hint.hits.length === 0, 'site-bounds/refused/hint-unknown/before-any-request', JSON.stringify(hint.hits));
  } finally { await bare.close(); }
});

await section('site-refusals', async () => {
  const empty = await openStore((origin, path, url, res) => {
    if (path === '/robots.txt') return send(res, 'text/plain; charset=utf-8', 'User-agent: *\nAllow: /\n');
    if (path === '/sitemap.xml') return send(res, 'text/xml; charset=utf-8', urlset(origin, ['/about']));
    if (path === '/about') return send(res, 'text/html; charset=utf-8', '<!doctype html><html><body><h1>About this shop</h1></body></html>');
    return send(res, 'text/html; charset=utf-8', '<!doctype html><title>missing</title>', 404);
  });
  try {
    const got = await runInit('site-refusals/not-a-store', empty, []);
    check(got.run.code === 1 && got.run.stderr.includes('not-a-store'), 'site-refusals/not-a-store/names-not-a-store',
      `exit ${got.run.code}; ${got.run.stderr.slice(0, 300)}`);
    unwritten('site-refusals/not-a-store', got);
  } finally { await empty.close(); }

  const shy = await openStore((origin, path, url, res) => {
    if (path === '/robots.txt') return send(res, 'text/plain; charset=utf-8', 'User-agent: *\nDisallow: /\n');
    if (path === '/sitemap.xml') return send(res, 'text/xml; charset=utf-8', urlset(origin, ['/p/brass-desk-lamp']));
    return send(res, 'text/html; charset=utf-8', productPage(wixBlocks(origin, {
      path: '/p/brass-desk-lamp', name: 'Brass Desk Lamp', sku: 'L-12', price: '89.00', currency: 'EUR',
      availability: 'https://schema.org/InStock',
    })));
  });
  try {
    const got = await runInit('site-refusals/robots-disallow', shy, []);
    check(got.run.code === 1 && /robots/i.test(got.run.stderr), 'site-refusals/robots-disallow/names-robots',
      `exit ${got.run.code}; ${got.run.stderr.slice(0, 300)}`);
    check(got.hits.some((h) => pathOf(h) === '/robots.txt') && !got.hits.some((h) => pathOf(h) !== '/robots.txt'),
      'site-refusals/robots-disallow/nothing-after-robots', JSON.stringify(got.hits.map(pathOf)));
    unwritten('site-refusals/robots-disallow', got);
  } finally { await shy.close(); }

  const httpHits = [];
  const httpServer = await new Promise((resolveStart) => {
    const sockets = new Set();
    const server = createServer((req, res) => {
      httpHits.push(req.url);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\n');
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.listen(0, '127.0.0.1', () => resolveStart({
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    }));
  });
  try {
    const dir = makeRepo('vite');
    const before = treeState(dir);
    const run = await runCli(['init', '--from', 'site', httpServer.origin, '--facts', FACTS_FILE], { cwd: dir, env: ENV });
    guardClean('site-refusals/http', run);
    check(run.code === 1 && /https/i.test(run.stderr), 'site-refusals/http/refuses-before-a-request',
      `exit ${run.code}; ${run.stderr.slice(0, 300)}`);
    check(httpHits.length === 0, 'site-refusals/http/no-request', JSON.stringify(httpHits));
    check(stateDiff(before, treeState(dir)).length === 0, 'site-refusals/http/writes-nothing');
  } finally { await httpServer.close(); }

  const present = await openStore((origin, path, url, res) => {
    send(res, 'text/plain; charset=utf-8', 'User-agent: *\nAllow: /\n');
  });
  try {
    const dir = makeRepo('vite');
    const body = `${JSON.stringify({ v: 1, kept: true })}\n`;
    writeFileSync(join(dir, DECL), body);
    const before = treeState(dir);
    const from = present.hits.length;
    const run = await runCli(['init', '--from', 'site', present.origin, '--facts', FACTS_FILE, '--hint', 'wix'],
      { cwd: dir, env: ENV });
    guardClean('site-refusals/exists', run, { onlyPort: present.port });
    check(run.code === 1, 'site-refusals/exists/exit-1', `exit ${run.code}; ${run.stderr.slice(0, 200)}`);
    check(present.hits.length === from, 'site-refusals/exists/no-request', JSON.stringify(present.hits.slice(from)));
    check(readFileSync(join(dir, DECL), 'utf8') === body && stateDiff(before, treeState(dir)).length === 0,
      'site-refusals/exists/leaves-the-file', JSON.stringify(stateDiff(before, treeState(dir))));
  } finally { await present.close(); }

  const factsDir = tmp('ae-site-facts-');
  const facts = { ...FACTS };
  delete facts.human_contact_name;
  const factsPath = join(factsDir, 'facts.json');
  writeFileSync(factsPath, `${JSON.stringify(facts)}\n`);
  const early = await openStore((origin, path, url, res) => send(res, 'text/plain; charset=utf-8', 'User-agent: *\nAllow: /\n'));
  try {
    const got = await runInit('site-refusals/facts-missing-human-contact', early, ['--hint', 'wix'], { facts: factsPath });
    check(got.run.code === 1 && got.run.stderr.includes('human_contact_name'),
      'site-refusals/facts-missing-human-contact/names-the-key', `exit ${got.run.code}; ${got.run.stderr.slice(0, 300)}`);
    check(got.hits.length === 0, 'site-refusals/facts-missing-human-contact/before-any-request', JSON.stringify(got.hits));
    unwritten('site-refusals/facts-missing-human-contact', got);
  } finally { await early.close(); }
});

check(!guardLog.some((r) => r.allowed === false), 'runner/never-dialled-out',
  JSON.stringify(guardLog.filter((r) => r.allowed === false).slice(0, 2)));

for (const dir of scratch) {
  try { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures.length) {
  console.error(`FAILED - ${failures.length} site check(s):`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} site checks.`);
