#!/usr/bin/env node
// init <store url>: the source is detected, never named by the user.
//
// WRITTEN BEFORE THE IMPLEMENTATION. Intake 20261031T165410Z (owner direction 2026-10-31: the
// sources already go beyond Woo, so the script decides the source, never the user). The implementer
// may not edit this file. The stores are local fixtures on 127.0.0.1, and the in-process cases
// answer from a stubbed globalThis.fetch. Nothing here dials a live site. Run it as
// `bash .cursor/skills/isolated-session/scripts/run-node.sh conformance/detect.mjs`.
//
//   agent-entry init <https store url> [--facts <file>] [--max-pages <n>] [--max-bytes <n>]
//       [--name <name>] [--json]
//
// Detection, in this order, the first that answers wins:
//   woocommerce  one GET of <store>/wp-json/wc/store/v1/products that answers as the
//                `--from woocommerce` probe does (200, JSON, a list of products).
//   site         Product JSON-LD on the store's own pages, as the `--from site` reader finds it.
// Then the chosen reader runs exactly as its forced flag runs it: the same agent-entry.json and
// the same agent-entry.products.json, byte for byte. --json carries `source` (the detector's
// name); the text output has a line naming the source.
// `--from woocommerce` and `--from site` stay a forced override: no detection, no other source asked.
// A mismatched forced flag is refused as today: --from woocommerce on a store with no Store API is
// not-woo (exit 1), --from site on a store with no Product JSON-LD is not-a-store (exit 1), and
// neither falls back to the other source. An unknown --from stays misuse (exit 2).
// A store that answers no detector is refused by name: exit non-zero, the message names the
// store URL and says no source was detected, and nothing is written.
//
// The one place detection lives, exported from muretai-agent-entry.mjs:
//   SOURCE_DETECTORS        an array, in detection order, of { name, detect }. name is a string;
//                           detect(base) gets the store's base URL (a URL on the store origin) and
//                           resolves true when that source answers. [0] is woocommerce, [1] is site.
//   detectSource(storeUrl)  tries every entry of SOURCE_DETECTORS, in order, as the array stands
//                           when it is called, and resolves the first answering detector's name; it
//                           rejects with an Error naming the store URL and "no source detected"
//                           when none answers. A detector registered there (pushed onto the array)
//                           is tried after the two without any other change to init.
// The README's main path is `init <store url>`: its store example carries no --from.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { guardLog } from './fixtures/cli/loopback-only.mjs';
import { makeRuntimeTls } from './fixtures/cli/runtime-tls.mjs';
import * as door from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'muretai-agent-entry.mjs');
const FIX = join(HERE, 'fixtures', 'cli');
const GUARD = join(FIX, 'loopback-only.mjs');
const FACTS_FILE = join(FIX, 'woo', 'facts.json');
const WOO_PAGE = readFileSync(join(FIX, 'woo', 'products-page.json'), 'utf8');
const TREES = JSON.parse(readFileSync(join(FIX, 'frameworks.json'), 'utf8'));
const WOO_PRODUCTS = '/wp-json/wc/store/v1/products';
const WOO_JSON = 'application/json; charset=UTF-8';
const WOO_NOT_WOO = /wc\/store\/v1\/products|store api|not a woo/i;
const NO_SOURCE = /no source (was )?detected/i;
const SNAPSHOT = 'agent-entry.products.json';
const DECL = 'agent-entry.json';

const TLS = makeRuntimeTls({ prefix: 'ae-detect-tls-' });
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

function tmp(prefix = 'ae-detect-') {
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

const HOME = tmp('ae-detect-home-');
writeFileSync(join(HOME, '.gitconfig-empty'), '');

function git(cwd, args) {
  return spawnSync('git', args, { cwd, env: baseEnv(HOME), encoding: 'utf8' });
}

function makeRepo(name) {
  const tree = TREES.frameworks[name];
  const dir = tmp(`ae-detect-${name}-`);
  for (const [rel, content] of Object.entries(tree.files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
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
  const log = join(tmp('ae-detect-guard-'), 'guard.jsonl');
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

function send(res, type, body, status = 200, extra = {}) {
  const buf = Buffer.from(body);
  res.writeHead(status, { 'content-type': type, 'content-length': String(buf.length), ...extra });
  res.end(buf);
}

const pathOf = (h) => {
  const u = new URL(h.url, 'https://x.invalid');
  return u.pathname.replace(/\/$/, '') || '/';
};
const askedWoo = (hits) => hits.filter((h) => h.method === 'GET' && pathOf(h) === WOO_PRODUCTS);
const askedSite = (hits) => hits.filter((h) => h.method === 'GET' && pathOf(h) !== WOO_PRODUCTS && pathOf(h) !== '/robots.txt');

/** The recorded Woo page with the fixture's shop origin swapped for the store's (as cli.mjs does). */
const onOrigin = (text, origin) => text.split('https://shop.example').join(origin);

function urlset(origin, paths) {
  const urls = paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function productPage(origin, spec) {
  const blocks = [
    { '@context': 'https://schema.org/', '@type': 'Organization', name: 'Harbor Lamp', url: `${origin}/about` },
    { '@context': 'https://schema.org/', '@type': 'Product', name: spec.name, sku: spec.sku,
      description: 'Solid brass, hand finished.',
      offers: { '@type': 'Offer', url: `${origin}${spec.path}`, priceCurrency: spec.currency, price: spec.price,
        availability: spec.availability } },
  ];
  const scripts = blocks.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('');
  return `<!doctype html><html><head>${scripts}</head><body><h1>item</h1></body></html>`;
}

// The site-generic shape of conformance/site.mjs: a sitemap urlset of product pages with JSON-LD.
const SITE_SPECS = [
  { path: '/p/brass-desk-lamp', name: 'Brass Desk Lamp', sku: 'L-12', price: '89.00', currency: 'EUR',
    availability: 'https://schema.org/InStock' },
  { path: '/p/linen-shade', name: 'Linen Shade', sku: 'L-13', price: '15.00', currency: 'EUR',
    availability: 'https://schema.org/OutOfStock' },
];

const ROBOTS_OK = 'User-agent: *\nAllow: /\n';
const NOT_FOUND = '<!doctype html><title>missing</title>';

/** A store: `woo` answers the Store API products path, `site` the sitemap and product pages. */
async function openStore({ woo = false, site = false }) {
  let store = null;
  store = await startStore((req, res) => {
    const origin = store.origin;
    const path = pathOf(req);
    if (path === '/robots.txt') return send(res, 'text/plain; charset=utf-8', ROBOTS_OK);
    if (path === WOO_PRODUCTS) {
      if (woo) return send(res, WOO_JSON, onOrigin(WOO_PAGE, origin), 200, { 'x-wp-total': '3', 'x-wp-totalpages': '1' });
      return send(res, WOO_JSON, JSON.stringify({ code: 'rest_no_route', message: 'No route was found.', data: { status: 404 } }), 404);
    }
    if (site && path === '/sitemap.xml') return send(res, 'text/xml; charset=utf-8', urlset(origin, SITE_SPECS.map((s) => s.path)));
    if (!site && path === '/sitemap.xml') return send(res, 'text/xml; charset=utf-8', urlset(origin, ['/about']));
    if (path === '/about') return send(res, 'text/html; charset=utf-8', '<!doctype html><html><body><h1>About this shop</h1></body></html>');
    const spec = site && SITE_SPECS.find((s) => s.path === path);
    if (spec) return send(res, 'text/html; charset=utf-8', productPage(origin, spec));
    return send(res, 'text/html; charset=utf-8', NOT_FOUND, 404);
  });
  return store;
}

/** One init in a fresh vite project against `store`; `args` follow `init`. */
async function runInit(label, store, args) {
  const dir = makeRepo('vite');
  const before = treeState(dir);
  const home = tmp('ae-detect-home-');
  const homeBefore = treeState(home);
  const from = store.hits.length;
  const run = await runCli(['init', ...args], { cwd: dir, env: { ...ENV, HOME: home } });
  guardClean(label, run, { onlyPort: store.port });
  return { dir, before, home, homeBefore, run, hits: store.hits.slice(from) };
}

function unwritten(label, got) {
  const diff = stateDiff(got.before, treeState(got.dir));
  check(diff.length === 0, `${label}/writes-nothing`, JSON.stringify(diff.slice(0, 8)));
  check(!existsSync(join(got.dir, DECL)), `${label}/no-agent-entry.json`);
  check(!existsSync(join(got.dir, SNAPSHOT)), `${label}/no-snapshot`);
  const home = stateDiff(got.homeBefore, treeState(got.home));
  check(home.length === 0, `${label}/writes-nothing-in-home`, JSON.stringify(home.slice(0, 8)));
}

function said(run) {
  return `exit ${run.code}; stdout ${run.stdout.slice(0, 300)}; stderr ${run.stderr.slice(0, 400)}`;
}

function jsonOut(label, run) {
  try { return JSON.parse(run.stdout); } catch (error) {
    check(false, `${label}/json-output-parses`, `${String(error)}; ${run.stdout.slice(0, 200)}`);
    return null;
  }
}

/** The text line that names the source: it says "source" and the source's name. */
function namesSource(text, name) {
  return text.split('\n').some((line) => /\bsource\b/i.test(line) && new RegExp(`\\b${name}\\b`, 'i').test(line));
}

// ---------------------------------------------------------------- 1. detected equals forced, per fixture

for (const [name, shape] of [['woocommerce', { woo: true }], ['site', { site: true }]]) {
  await section(`detect-${name}`, async () => {
    const store = await openStore(shape);
    try {
      const forced = await runInit(`detect-${name}/forced`, store, ['--from', name, store.origin, '--facts', FACTS_FILE, '--json']);
      if (!check(forced.run.code === 0, `detect-${name}/forced/exit-0`, said(forced.run))) return;
      const detected = await runInit(`detect-${name}/detected`, store, [store.origin, '--facts', FACTS_FILE, '--json']);
      if (!check(detected.run.code === 0, `detect-${name}/detected/exit-0`, said(detected.run))) return;
      const out = jsonOut(`detect-${name}/detected`, detected.run);
      check(out && out.source === name, `detect-${name}/detected/json-source-is-${name}`, JSON.stringify(out));
      check(out && Array.isArray(out.wrote) && out.wrote.includes(DECL) && out.wrote.includes(SNAPSHOT),
        `detect-${name}/detected/json-wrote-names-both-files`, JSON.stringify(out?.wrote));
      for (const file of [DECL, SNAPSHOT]) {
        const want = existsSync(join(forced.dir, file)) ? readFileSync(join(forced.dir, file)) : null;
        const got = existsSync(join(detected.dir, file)) ? readFileSync(join(detected.dir, file)) : null;
        check(want !== null && got !== null && want.equals(got), `detect-${name}/detected/${file}-byte-identical-to-forced`,
          `forced ${want && want.toString('utf8').slice(0, 200)} detected ${got && got.toString('utf8').slice(0, 200)}`);
      }
      const rows = existsSync(join(detected.dir, SNAPSHOT)) ? JSON.parse(readFileSync(join(detected.dir, SNAPSHOT), 'utf8')) : [];
      check(Array.isArray(rows) && rows.length > 0, `detect-${name}/detected/snapshot-has-rows`, JSON.stringify(rows).slice(0, 200));
      if (name === 'woocommerce') {
        check(askedSite(detected.hits).length === 0, 'detect-woocommerce/detected/site-is-not-tried-once-woo-answers',
          JSON.stringify(detected.hits.map(pathOf)));
      } else {
        const woo = askedWoo(detected.hits);
        check(woo.length === 1, 'detect-site/detected/one-get-of-the-store-api-products-path', JSON.stringify(detected.hits.map(pathOf)));
        const wooAt = detected.hits.findIndex((h) => pathOf(h) === WOO_PRODUCTS);
        const siteAt = detected.hits.findIndex((h) => SITE_SPECS.some((s) => s.path === pathOf(h)));
        check(wooAt !== -1 && siteAt !== -1 && wooAt < siteAt, 'detect-site/detected/woo-is-tried-before-the-site-pages',
          JSON.stringify(detected.hits.map(pathOf)));
      }
      const text = await runInit(`detect-${name}/text`, store, [store.origin, '--facts', FACTS_FILE]);
      check(text.run.code === 0 && namesSource(text.run.stdout, name), `detect-${name}/text/names-the-source`, said(text.run));
    } finally { await store.close(); }
  });
}

// ---------------------------------------------------------------- 2. detection keeps the bounds

await section('detect-bounds', async () => {
  const store = await openStore({ site: true });
  try {
    const got = await runInit('detect-bounds/max-pages-1', store, [store.origin, '--facts', FACTS_FILE, '--max-pages', '1', '--json']);
    if (check(got.run.code === 0, 'detect-bounds/max-pages-1/exit-0', said(got.run))) {
      const out = jsonOut('detect-bounds/max-pages-1', got.run);
      check(out && out.source === 'site' && out.stopped === 'page-bound' && out.pages === 1,
        'detect-bounds/max-pages-1/the-detected-reader-keeps-the-bound', JSON.stringify(out));
    }
  } finally { await store.close(); }
});

// ---------------------------------------------------------------- 3. the forced flags skip detection

await section('detect-forced', async () => {
  const both = await openStore({ woo: true, site: true });
  try {
    const site = await runInit('detect-forced/site-on-a-woo-store', both, ['--from', 'site', both.origin, '--facts', FACTS_FILE, '--json']);
    check(site.run.code === 0, 'detect-forced/site-on-a-woo-store/exit-0', said(site.run));
    check(askedWoo(site.hits).length === 0, 'detect-forced/site-on-a-woo-store/never-asks-the-store-api',
      JSON.stringify(site.hits.map(pathOf)));
    const woo = await runInit('detect-forced/woo-on-a-site-store', both, ['--from', 'woocommerce', both.origin, '--facts', FACTS_FILE, '--json']);
    check(woo.run.code === 0, 'detect-forced/woo-on-a-site-store/exit-0', said(woo.run));
    check(askedSite(woo.hits).length === 0, 'detect-forced/woo-on-a-site-store/never-reads-the-site-pages',
      JSON.stringify(woo.hits.map(pathOf)));
    const detected = await runInit('detect-forced/both-detected', both, [both.origin, '--facts', FACTS_FILE, '--json']);
    if (check(detected.run.code === 0, 'detect-forced/both-detected/exit-0', said(detected.run))) {
      const out = jsonOut('detect-forced/both-detected', detected.run);
      check(out && out.source === 'woocommerce', 'detect-forced/both-detected/woo-wins-when-both-answer', JSON.stringify(out));
    }
  } finally { await both.close(); }
});

// ---------------------------------------------------------------- 4. the refusals

await section('detect-refusals', async () => {
  const none = await openStore({});
  try {
    for (const json of [false, true]) {
      const label = `detect-refusals/no-source${json ? '-json' : ''}`;
      const got = await runInit(label, none, [none.origin, '--facts', FACTS_FILE, ...(json ? ['--json'] : [])]);
      check(got.run.code !== 0 && got.run.code !== null, `${label}/exits-non-zero`, said(got.run));
      check(got.run.stderr.includes(none.origin), `${label}/names-the-store-url`, got.run.stderr.slice(0, 300));
      check(NO_SOURCE.test(got.run.stderr), `${label}/says-no-source-was-detected`, got.run.stderr.slice(0, 300));
      check(askedWoo(got.hits).length === 1, `${label}/woo-was-tried-once`, JSON.stringify(got.hits.map(pathOf)));
      check(got.hits.some((h) => pathOf(h) === '/sitemap.xml'), `${label}/site-was-tried`, JSON.stringify(got.hits.map(pathOf)));
      unwritten(label, got);
    }

    // Mismatched forced flags: refused as today, never a fallback to the other source.
    const wooOnSite = await openStore({ site: true });
    try {
      const got = await runInit('detect-refusals/forced-woo-on-a-site-store', wooOnSite, ['--from', 'woocommerce', wooOnSite.origin, '--facts', FACTS_FILE]);
      check(got.run.code === 1 && WOO_NOT_WOO.test(got.run.stderr) && /not a WooCommerce store/.test(got.run.stderr),
        'detect-refusals/forced-woo-on-a-site-store/not-woo-exit-1', said(got.run));
      check(!NO_SOURCE.test(got.run.stderr), 'detect-refusals/forced-woo-on-a-site-store/not-the-detection-refusal', got.run.stderr.slice(0, 300));
      check(askedSite(got.hits).length === 0, 'detect-refusals/forced-woo-on-a-site-store/no-fallback-to-the-site',
        JSON.stringify(got.hits.map(pathOf)));
      unwritten('detect-refusals/forced-woo-on-a-site-store', got);
    } finally { await wooOnSite.close(); }

    const siteOnWoo = await openStore({ woo: true });
    try {
      const got = await runInit('detect-refusals/forced-site-on-a-woo-store', siteOnWoo, ['--from', 'site', siteOnWoo.origin, '--facts', FACTS_FILE]);
      check(got.run.code === 1 && got.run.stderr.includes('not-a-store'), 'detect-refusals/forced-site-on-a-woo-store/not-a-store-exit-1',
        said(got.run));
      check(!NO_SOURCE.test(got.run.stderr), 'detect-refusals/forced-site-on-a-woo-store/not-the-detection-refusal', got.run.stderr.slice(0, 300));
      check(askedWoo(got.hits).length === 0, 'detect-refusals/forced-site-on-a-woo-store/no-fallback-to-the-store-api',
        JSON.stringify(got.hits.map(pathOf)));
      unwritten('detect-refusals/forced-site-on-a-woo-store', got);
    } finally { await siteOnWoo.close(); }

    const unknown = await runInit('detect-refusals/unknown-from', none, ['--from', 'shopify', none.origin, '--facts', FACTS_FILE]);
    check(unknown.run.code === 2 && unknown.run.stderr.includes('init --from accepts only woocommerce or site'),
      'detect-refusals/unknown-from/misuse-exit-2', said(unknown.run));
    check(unknown.hits.length === 0, 'detect-refusals/unknown-from/before-any-request', JSON.stringify(unknown.hits));
    unwritten('detect-refusals/unknown-from', unknown);
  } finally { await none.close(); }
});

// ---------------------------------------------------------------- 5. the one place detection lives

/** Swap globalThis.fetch for `answer(url)` -> { status, type, body } while `fn` runs; every URL is logged. */
async function withStubFetch(answer, fn) {
  const log = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input?.url ?? input));
    log.push(url.pathname);
    const { status = 200, type = 'text/plain', body = '', headers = {} } = answer(url) || {};
    return new Response(status === 204 || status === 304 ? null : body, { status, headers: { 'content-type': type, ...headers } });
  };
  try { return await fn(log); } finally { globalThis.fetch = real; }
}

const STUB = 'https://shop.example';

function stubStore({ woo = false, site = false, wooBody = null }) {
  return (url) => {
    const path = url.pathname.replace(/\/$/, '') || '/';
    if (path === '/robots.txt') return { type: 'text/plain', body: ROBOTS_OK };
    if (path === WOO_PRODUCTS) {
      if (wooBody !== null) return { type: WOO_JSON, body: wooBody };
      return woo ? { type: WOO_JSON, body: onOrigin(WOO_PAGE, STUB), headers: { 'x-wp-totalpages': '1' } }
        : { status: 404, type: WOO_JSON, body: '{"code":"rest_no_route"}' };
    }
    if (path === '/sitemap.xml') return { type: 'text/xml', body: urlset(STUB, site ? SITE_SPECS.map((s) => s.path) : ['/about']) };
    const spec = site && SITE_SPECS.find((s) => s.path === path);
    if (spec) return { type: 'text/html', body: productPage(STUB, spec) };
    return { status: 404, type: 'text/html', body: NOT_FOUND };
  };
}

async function settle(promise) {
  try { return { value: await promise }; } catch (error) { return { error }; }
}

await section('detect-registry', async () => {
  const { SOURCE_DETECTORS, detectSource } = door;
  if (!check(Array.isArray(SOURCE_DETECTORS), 'detect-registry/SOURCE_DETECTORS-is-exported-as-an-array', typeof SOURCE_DETECTORS)) return;
  if (!check(typeof detectSource === 'function', 'detect-registry/detectSource-is-exported', typeof detectSource)) return;
  check(JSON.stringify(SOURCE_DETECTORS.slice(0, 2).map((d) => d && d.name)) === JSON.stringify(['woocommerce', 'site']),
    'detect-registry/woocommerce-then-site', JSON.stringify(SOURCE_DETECTORS.map((d) => d && d.name)));
  check(SOURCE_DETECTORS.every((d) => d && typeof d.name === 'string' && typeof d.detect === 'function'),
    'detect-registry/every-entry-is-a-name-and-a-detect');

  const woo = await withStubFetch(stubStore({ woo: true, site: true }), async (log) => ({ got: await settle(detectSource(`${STUB}/`)), log }));
  check(woo.got.value === 'woocommerce', 'detect-registry/woo-store-is-woocommerce', String(woo.got.error?.message ?? woo.got.value));
  check(woo.log.filter((p) => p.replace(/\/$/, '') === WOO_PRODUCTS).length === 1,
    'detect-registry/woo-store/one-get-of-the-products-path', JSON.stringify(woo.log));
  check(!woo.log.some((p) => p === '/sitemap.xml'), 'detect-registry/woo-store/site-is-not-tried', JSON.stringify(woo.log));

  const site = await withStubFetch(stubStore({ site: true }), async (log) => ({ got: await settle(detectSource(`${STUB}/`)), log }));
  check(site.got.value === 'site', 'detect-registry/site-store-is-site', String(site.got.error?.message ?? site.got.value));
  check(site.log.filter((p) => p.replace(/\/$/, '') === WOO_PRODUCTS).length === 1,
    'detect-registry/site-store/one-get-of-the-products-path', JSON.stringify(site.log));

  // The Store API path answering what the --from woocommerce probe refuses is not woo.
  for (const [tag, body] of [['json-object', '{"products":[]}'], ['html-body', '<!doctype html><body>Lamps</body>'], ['not-json', '[{']]) {
    const got = await withStubFetch(stubStore({ site: true, wooBody: body }), () => settle(detectSource(`${STUB}/`)));
    check(got.value === 'site', `detect-registry/woo-path-${tag}-is-not-woo`, String(got.error?.message ?? got.value));
  }

  const none = await withStubFetch(stubStore({}), () => settle(detectSource(`${STUB}/`)));
  check(none.error instanceof Error && none.error.message.includes(STUB) && NO_SOURCE.test(none.error.message),
    'detect-registry/no-source-is-refused-by-name', String(none.error?.message ?? none.value));

  // A next detector, registered in the one place, is tried after the two.
  const calls = [];
  const extra = { name: 'products-json', detect: async (base) => { calls.push(String(base)); return true; } };
  SOURCE_DETECTORS.push(extra);
  try {
    const got = await withStubFetch(stubStore({}), async (log) => ({ got: await settle(detectSource(`${STUB}/`)), log: log.slice() }));
    check(got.got.value === 'products-json', 'detect-registry/extra-detector-answers', String(got.got.error?.message ?? got.got.value));
    check(calls.length === 1 && calls[0].startsWith(STUB), 'detect-registry/extra-detector-is-called-once-with-the-store', JSON.stringify(calls));
    check(got.log.some((p) => p.replace(/\/$/, '') === WOO_PRODUCTS) && got.log.some((p) => p === '/sitemap.xml'),
      'detect-registry/extra-detector-is-tried-after-the-two', JSON.stringify(got.log));
    calls.length = 0;
    const first = await withStubFetch(stubStore({ woo: true }), () => settle(detectSource(`${STUB}/`)));
    check(first.value === 'woocommerce' && calls.length === 0, 'detect-registry/extra-detector-is-not-tried-when-woo-answers',
      JSON.stringify({ value: first.value, calls }));
    extra.detect = async () => { calls.push('no'); return false; };
    const declined = await withStubFetch(stubStore({}), () => settle(detectSource(`${STUB}/`)));
    check(declined.error instanceof Error && NO_SOURCE.test(declined.error.message) && calls.includes('no'),
      'detect-registry/an-extra-detector-that-declines-still-ends-in-the-refusal', String(declined.error?.message ?? declined.value));
  } finally {
    SOURCE_DETECTORS.splice(SOURCE_DETECTORS.indexOf(extra), 1);
  }
});

// ---------------------------------------------------------------- 6. the README main path

await section('detect-readme', async () => {
  const lines = readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n');
  const storeExamples = lines.filter((l) => /agent-entry init\b[^`\n]*https:\/\//.test(l) && !/--base-url\b/.test(l));
  check(storeExamples.length > 0, 'detect-readme/has-a-store-url-init-example', 'no `agent-entry init <https url>` line');
  check(storeExamples.length > 0 && !/--from\b/.test(storeExamples[0]), 'detect-readme/main-path-example-has-no-from',
    storeExamples[0] || '');
  check(lines.some((l) => /agent-entry init https:\/\/\S+/.test(l)), 'detect-readme/main-path-is-init-url',
    'no `agent-entry init https://...` line');
});

check(!guardLog.some((r) => r.allowed === false), 'runner/never-dialled-out',
  JSON.stringify(guardLog.filter((r) => r.allowed === false).slice(0, 2)));

for (const dir of scratch) {
  try { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures.length) {
  console.error(`FAILED - ${failures.length} detect check(s):`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} detect checks.`);
