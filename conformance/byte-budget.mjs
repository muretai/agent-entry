#!/usr/bin/env node
// init <store url>: one --max-bytes budget across store-url detection and the site walk.
//
// WRITTEN BEFORE THE IMPLEMENTATION. Parent intake 20261101T102931Z. This item's intake
// 20261101T163125Z (ISSUE security-audit-2026-11-01-gate-github-and-revendor-v0-1-10-2).
// The implementer may not edit this file. The stores are local fixtures on 127.0.0.1.
// Nothing here dials a live site. Run it as
// `node conformance/byte-budget.mjs`.
//
// `init <store url> --max-bytes <n>` reads at most n body bytes in the whole run. That
// total counts every body detection reads (robots.txt and the Store API products body)
// and every body the site walk reads (including its robots.txt). A second robots.txt
// read counts again; a reused copy does not. The sum is the bytes actually pulled from
// the response bodies, not a second charge for a body that was not read.
//
// A body that may be larger than the budget is written one byte at a time, with no
// Content-Length, so a reader can stop when the budget is spent. Every other body is
// one response with Content-Length.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { guardLog } from './fixtures/cli/loopback-only.mjs';
import { makeRuntimeTls } from './fixtures/cli/runtime-tls.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'muretai-agent-entry.mjs');
const FIX = join(HERE, 'fixtures', 'cli');
const GUARD = join(FIX, 'loopback-only.mjs');
const FACTS_FILE = join(FIX, 'woo', 'facts.json');
const TREES = JSON.parse(readFileSync(join(FIX, 'frameworks.json'), 'utf8'));
const WOO_PRODUCTS = '/wp-json/wc/store/v1/products';
const SNAPSHOT = 'agent-entry.products.json';
const DECL = 'agent-entry.json';
const ROBOTS = 'User-agent: *\nAllow: /\n';
const NOT_FOUND = '<!doctype html><title>missing</title>';

const COUNTER_SOURCE = [
  "import { appendFileSync } from 'node:fs';",
  'const logPath = process.env.AE_BYTE_LOG;',
  'const orig = globalThis.fetch;',
  'if (typeof orig === "function" && logPath) {',
  '  globalThis.fetch = async function countedFetch(input, init) {',
  '    const res = await orig.call(this, input, init);',
  '    const url = typeof input === "string" || input instanceof URL ? String(input) : String(input && input.url || "");',
  '    const body = res && res.body;',
  '    if (!body || typeof body.getReader !== "function") return res;',
  '    const getReader = body.getReader;',
  '    body.getReader = function countedGetReader(...args) {',
  '      const reader = getReader.apply(body, args);',
  '      const read = reader.read;',
  '      reader.read = async function countedRead(...readArgs) {',
  '        const step = await read.apply(reader, readArgs);',
  '        if (step && !step.done && step.value) {',
  '          appendFileSync(logPath, JSON.stringify({ url, bytes: step.value.byteLength }) + "\\n");',
  '        }',
  '        return step;',
  '      };',
  '      return reader;',
  '    };',
  '    return res;',
  '  };',
  '}',
  '',
].join('\n');

const TLS = makeRuntimeTls({ prefix: 'ae-budget-tls-' });
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

function tmp(prefix = 'ae-budget-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const COUNTER = join(tmp('ae-budget-counter-'), 'count-bytes.mjs');
writeFileSync(COUNTER, COUNTER_SOURCE);

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

const HOME = tmp('ae-budget-home-');
writeFileSync(join(HOME, '.gitconfig-empty'), '');

function git(cwd, args) {
  return spawnSync('git', args, { cwd, env: baseEnv(HOME), encoding: 'utf8' });
}

function makeRepo(name) {
  const tree = TREES.frameworks[name];
  const dir = tmp(`ae-budget-${name}-`);
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
  const log = join(tmp('ae-budget-guard-'), 'guard.jsonl');
  const bytesLog = join(tmp('ae-budget-bytes-'), 'bytes.jsonl');
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [
      '--import', pathToFileURL(GUARD).href,
      '--import', pathToFileURL(COUNTER).href,
      BIN, ...args,
    ], {
      cwd: cwd || tmp(),
      env: { ...baseEnv(HOME), ...env, AE_CLI_GUARD_LOG: log, AE_BYTE_LOG: bytesLog },
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
      resolveRun({ code, signal, stdout, stderr, guard, timedOut, bytesLog });
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
      if (req.socket) req.socket.setNoDelay(true);
      req.resume();
      handler(req, res);
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.on('tlsClientError', () => { /* a client that hangs up mid-handshake */ });
    server.on('clientError', () => { /* the reader stopped at the budget */ });
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

/** No Content-Length, one byte at a time, so the reader can stop at the budget. */
function servePaced(req, res, type, body, status = 200) {
  const buf = Buffer.from(body);
  res.on('error', () => { /* the reader closed the socket at the budget */ });
  res.writeHead(status, { 'content-type': type });
  let offset = 0;
  const writeNext = () => {
    if (req.aborted || res.destroyed || res.writableEnded) return;
    if (offset >= buf.length) { res.end(); return; }
    res.write(buf.subarray(offset, offset + 1));
    offset += 1;
    if (offset >= buf.length) { res.end(); return; }
    setTimeout(writeNext, 1);
  };
  req.on('aborted', () => { if (!res.writableEnded) res.destroy(); });
  writeNext();
}

const pathOf = (h) => {
  const u = new URL(h.url, 'https://x.invalid');
  return u.pathname.replace(/\/$/, '') || '/';
};

function urlset(origin, paths) {
  const urls = paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function productPage(origin, spec) {
  const blocks = [
    { '@context': 'https://schema.org/', '@type': 'Organization', name: 'Harbor Lamp', url: `${origin}/about` },
    { '@context': 'https://schema.org/', '@type': 'Product', name: spec.name, sku: spec.sku,
      offers: { '@type': 'Offer', url: `${origin}${spec.path}`, priceCurrency: spec.currency, price: spec.price,
        availability: spec.availability } },
  ];
  const scripts = blocks.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('');
  return `<!doctype html><html><head>${scripts}</head><body><h1>item</h1></body></html>`;
}

const SPEC1 = {
  path: '/p/brass-desk-lamp', name: 'Brass Desk Lamp', sku: 'L-12', price: '89.00', currency: 'EUR',
  availability: 'https://schema.org/InStock',
};
const SPEC2 = {
  path: '/p/linen-shade', name: 'Linen Shade', sku: 'L-13', price: '15.00', currency: 'EUR',
  availability: 'https://schema.org/OutOfStock',
};

function openStore() {
  const routes = {};
  return startStore((req, res) => {
    const path = pathOf(req);
    const route = routes[path];
    if (!route) return send(res, 'text/html; charset=utf-8', NOT_FOUND, 404);
    if (route.paced) return servePaced(req, res, route.type, route.body, route.status || 200);
    return send(res, route.type, route.body, route.status || 200);
  }).then((store) => ({ ...store, routes }));
}

function byteRows(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function pathOfUrl(url) {
  try { return new URL(url).pathname.replace(/\/$/, '') || '/'; } catch { return ''; }
}

function bytesFor(rows, path) {
  let n = 0;
  for (const row of rows) if (pathOfUrl(row.url) === path) n += row.bytes;
  return n;
}

function totalBytes(rows) {
  return rows.reduce((n, row) => n + row.bytes, 0);
}

function byteSummary(rows) {
  const by = {};
  for (const row of rows) {
    const path = pathOfUrl(row.url) || row.url;
    by[path] = (by[path] || 0) + row.bytes;
  }
  return JSON.stringify(by);
}

async function runInit(label, store, args) {
  const dir = makeRepo('vite');
  const before = treeState(dir);
  const home = tmp('ae-budget-home-');
  const from = store.hits.length;
  const run = await runCli(['init', ...args], { cwd: dir, env: { ...ENV, HOME: home } });
  guardClean(label, run, { onlyPort: store.port });
  return { dir, before, home, run, hits: store.hits.slice(from), rows: byteRows(run.bytesLog) };
}

function unwritten(label, got) {
  const diff = stateDiff(got.before, treeState(got.dir));
  check(diff.length === 0, `${label}/writes-nothing`, JSON.stringify(diff.slice(0, 8)));
  check(!existsSync(join(got.dir, DECL)), `${label}/no-agent-entry.json`);
  check(!existsSync(join(got.dir, SNAPSHOT)), `${label}/no-snapshot`);
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

/** The byte bound, as init already names it: exit 0 with stopped byte-bound, or exit 1
 *  naming that bound. not-a-store and a crash are not that result. */
function budgetReached(run) {
  if (run.timedOut || run.signal) return false;
  if (run.code !== 0 && run.code !== 1) return false;
  const text = `${run.stdout}\n${run.stderr}`;
  if (/not-a-store|no source (was )?detected/i.test(text)) return false;
  if (/^\s*at .+\.mjs:\d+/m.test(run.stderr)) return false;
  if (run.code === 0) {
    try { return JSON.parse(run.stdout).stopped === 'byte-bound'; } catch { return false; }
  }
  return /byte-bound|byte bound|--max-bytes\b/i.test(text);
}

const robotsN = Buffer.byteLength(ROBOTS);

function route(type, body, extra = {}) {
  return { type, body, ...extra };
}

// ---------------------------------------------------------------- shared budget, then the remainder

await section('byte-budget/remainder', async () => {
  const store = await openStore();
  const page1 = productPage(store.origin, SPEC1);
  const page2 = productPage(store.origin, SPEC2);
  const sitemap = urlset(store.origin, [SPEC1.path, SPEC2.path]);
  const page1N = Buffer.byteLength(page1);
  const page2N = Buffer.byteLength(page2);
  const sitemapN = Buffer.byteLength(sitemap);
  const productsN = page1N + page2N;
  const productsBody = 'x'.repeat(productsN);
  const worst = robotsN * 2 + sitemapN;
  const best = robotsN + sitemapN;
  const maxBytes = productsN + worst + page1N;
  store.routes['/robots.txt'] = route('text/plain; charset=utf-8', ROBOTS);
  store.routes[WOO_PRODUCTS] = route('application/json', productsBody);
  store.routes['/sitemap.xml'] = route('text/xml; charset=utf-8', sitemap);
  store.routes[SPEC1.path] = route('text/html; charset=utf-8', page1);
  store.routes[SPEC2.path] = route('text/html; charset=utf-8', page2);
  check(productsN + worst + page1N <= maxBytes, 'byte-budget/remainder/fixture-page-1-fits-with-a-second-robots');
  check(productsN + best + page1N + page2N > maxBytes, 'byte-budget/remainder/fixture-page-2-does-not-fit-the-remainder');
  check(page1N + page2N <= maxBytes && page2N < maxBytes, 'byte-budget/remainder/fixture-a-fresh-budget-would-read-both-pages');
  try {
    const got = await runInit('byte-budget/remainder', store, [
      store.origin, '--facts', FACTS_FILE, '--max-bytes', String(maxBytes), '--json',
    ]);
    const rows = got.rows;
    check(bytesFor(rows, '/robots.txt') > 0, 'byte-budget/remainder/robots-body-was-read', byteSummary(rows));
    check(bytesFor(rows, WOO_PRODUCTS) === productsN, 'byte-budget/remainder/products-body-was-read-whole', byteSummary(rows));
    check(totalBytes(rows) <= maxBytes, 'byte-budget/remainder/total-bytes-within-max-bytes',
      `total ${totalBytes(rows)} max ${maxBytes} ${byteSummary(rows)}`);
    check(bytesFor(rows, SPEC1.path) === page1N, 'byte-budget/remainder/page-1-fits-in-the-remainder', byteSummary(rows));
    check(bytesFor(rows, SPEC2.path) < page2N, 'byte-budget/remainder/page-2-is-not-read-from-a-fresh-budget', byteSummary(rows));
    check(got.run.code === 0 || got.run.code === 1, 'byte-budget/remainder/exits-cleanly', said(got.run));
    check(!got.run.signal && !/^\s*at .+\.mjs:\d+/m.test(got.run.stderr), 'byte-budget/remainder/no-crash', said(got.run));
  } finally { await store.close(); }
});

// ---------------------------------------------------------------- a large non-JSON products body

await section('byte-budget/large-non-json', async () => {
  const maxBytes = 800;
  const productsN = 2400;
  const store = await openStore();
  const page = productPage(store.origin, SPEC1);
  const sitemap = urlset(store.origin, [SPEC1.path]);
  store.routes['/robots.txt'] = route('text/plain; charset=utf-8', ROBOTS);
  store.routes[WOO_PRODUCTS] = route('application/json', 'x'.repeat(productsN), { paced: true });
  store.routes['/sitemap.xml'] = route('text/xml; charset=utf-8', sitemap);
  store.routes[SPEC1.path] = route('text/html; charset=utf-8', page);
  check(productsN > maxBytes && Buffer.byteLength(page) < maxBytes,
    'byte-budget/large-non-json/fixture-body-exceeds-the-budget-and-the-page-would-fit-a-fresh-one');
  try {
    const got = await runInit('byte-budget/large-non-json', store, [
      store.origin, '--facts', FACTS_FILE, '--max-bytes', String(maxBytes), '--json',
    ]);
    const total = totalBytes(got.rows);
    check(bytesFor(got.rows, '/robots.txt') > 0, 'byte-budget/large-non-json/robots-body-was-read', byteSummary(got.rows));
    check(total <= maxBytes, 'byte-budget/large-non-json/total-bytes-within-max-bytes',
      `total ${total} max ${maxBytes} ${byteSummary(got.rows)}`);
    check(bytesFor(got.rows, SPEC1.path) === 0, 'byte-budget/large-non-json/no-product-page-body', byteSummary(got.rows));
    check(!got.hits.some((h) => pathOf(h) === '/sitemap.xml' || pathOf(h) === SPEC1.path),
      'byte-budget/large-non-json/walk-is-not-started-on-a-fresh-budget', JSON.stringify(got.hits.map(pathOf)));
    check(budgetReached(got.run), 'byte-budget/large-non-json/byte-bound-not-a-crash', said(got.run));
    unwritten('byte-budget/large-non-json', got);
  } finally { await store.close(); }
});

// ---------------------------------------------------------------- detection exhausts the budget

await section('byte-budget/refused/exhausted', async () => {
  const maxBytes = 2000;
  const store = await openStore();
  const page = productPage(store.origin, SPEC1);
  const sitemap = urlset(store.origin, [SPEC1.path]);
  store.routes['/robots.txt'] = route('text/plain; charset=utf-8', ROBOTS);
  // Exactly --max-bytes of non-JSON. The probe can read that body and still call it
  // not a Store API page. Counting the body spends the budget before the walk.
  store.routes[WOO_PRODUCTS] = route('application/json', 'x'.repeat(maxBytes));
  store.routes['/sitemap.xml'] = route('text/xml; charset=utf-8', sitemap);
  store.routes[SPEC1.path] = route('text/html; charset=utf-8', page);
  check(Buffer.byteLength(page) < maxBytes, 'byte-budget/refused/exhausted/fixture-page-fits-a-fresh-budget');
  try {
    const got = await runInit('byte-budget/refused/exhausted', store, [
      store.origin, '--facts', FACTS_FILE, '--max-bytes', String(maxBytes), '--json',
    ]);
    const total = totalBytes(got.rows);
    check(bytesFor(got.rows, '/robots.txt') > 0, 'byte-budget/refused/exhausted/robots-body-was-read', byteSummary(got.rows));
    check(total <= maxBytes, 'byte-budget/refused/exhausted/total-bytes-within-max-bytes',
      `total ${total} max ${maxBytes} ${byteSummary(got.rows)}`);
    check(!got.hits.some((h) => pathOf(h) === '/sitemap.xml'),
      'byte-budget/refused/exhausted/no-sitemap-after-the-budget', JSON.stringify(got.hits.map(pathOf)));
    check(!got.hits.some((h) => pathOf(h) === SPEC1.path),
      'byte-budget/refused/exhausted/no-product-page-after-the-budget', JSON.stringify(got.hits.map(pathOf)));
    check(bytesFor(got.rows, SPEC1.path) === 0 && bytesFor(got.rows, '/sitemap.xml') === 0,
      'byte-budget/refused/exhausted/walk-reads-nothing-more', byteSummary(got.rows));
    check(budgetReached(got.run), 'byte-budget/refused/exhausted/byte-bound-not-a-crash', said(got.run));
    unwritten('byte-budget/refused/exhausted', got);
  } finally { await store.close(); }
});

// ---------------------------------------------------------------- under the budget, and robots counted as read

await section('byte-budget/under-budget', async () => {
  const store = await openStore();
  const productsBody = 'not-json';
  const page = productPage(store.origin, SPEC1);
  const sitemap = urlset(store.origin, [SPEC1.path]);
  store.routes['/robots.txt'] = route('text/plain; charset=utf-8', ROBOTS);
  store.routes[WOO_PRODUCTS] = route('application/json', productsBody);
  store.routes['/sitemap.xml'] = route('text/xml; charset=utf-8', sitemap);
  store.routes[SPEC1.path] = route('text/html; charset=utf-8', page);
  const pageN = Buffer.byteLength(page);
  const roomy = 1000000;
  try {
    const forced = await runInit('byte-budget/under-budget/forced', store, [
      '--from', 'site', store.origin, '--facts', FACTS_FILE, '--max-bytes', String(roomy), '--json',
    ]);
    const detected = await runInit('byte-budget/under-budget/detected', store, [
      store.origin, '--facts', FACTS_FILE, '--max-bytes', String(roomy), '--json',
    ]);
    check(forced.run.code === 0, 'byte-budget/under-budget/forced/exit-0', said(forced.run));
    if (check(detected.run.code === 0, 'byte-budget/under-budget/detected/exit-0', said(detected.run))) {
      const out = jsonOut('byte-budget/under-budget/detected', detected.run);
      check(out && out.source === 'site' && out.stopped === null,
        'byte-budget/under-budget/detected/site-and-not-stopped', JSON.stringify(out));
      for (const file of [DECL, SNAPSHOT]) {
        const want = existsSync(join(forced.dir, file)) ? readFileSync(join(forced.dir, file)) : null;
        const gotFile = existsSync(join(detected.dir, file)) ? readFileSync(join(detected.dir, file)) : null;
        check(want !== null && gotFile !== null && want.equals(gotFile),
          `byte-budget/under-budget/detected/${file}-matches-forced-site`,
          `forced ${want && want.toString('utf8').slice(0, 160)} detected ${gotFile && gotFile.toString('utf8').slice(0, 160)}`);
      }
    }
    const detectedTotal = totalBytes(detected.rows);
    check(detectedTotal > 0 && detectedTotal <= roomy, 'byte-budget/under-budget/detected/total-within-the-roomy-budget',
      `total ${detectedTotal} ${byteSummary(detected.rows)}`);
    check(bytesFor(detected.rows, SPEC1.path) === pageN, 'byte-budget/under-budget/detected/product-page-read-whole',
      byteSummary(detected.rows));

    const ceiling = robotsN * 2 + Buffer.byteLength(productsBody) + Buffer.byteLength(sitemap) + pageN;
    const tight = await runInit('byte-budget/under-budget/robots-as-read', store, [
      store.origin, '--facts', FACTS_FILE, '--max-bytes', String(ceiling), '--json',
    ]);
    const robotHits = tight.hits.filter((h) => h.method === 'GET' && pathOf(h) === '/robots.txt').length;
    const robotBytes = bytesFor(tight.rows, '/robots.txt');
    check(robotHits >= 1 && robotBytes === robotHits * robotsN,
      'byte-budget/under-budget/robots-bytes-equal-the-bodies-read',
      `hits ${robotHits} bytes ${robotBytes} one ${robotsN} ${byteSummary(tight.rows)}`);
    check(totalBytes(tight.rows) <= ceiling, 'byte-budget/under-budget/robots-reread-still-within-the-ceiling',
      `total ${totalBytes(tight.rows)} ceiling ${ceiling} ${byteSummary(tight.rows)}`);
    check(bytesFor(tight.rows, SPEC1.path) === pageN, 'byte-budget/under-budget/page-still-read-when-the-real-total-fits',
      byteSummary(tight.rows));
    if (tight.run.code === 0) {
      const out = jsonOut('byte-budget/under-budget/robots-as-read', tight.run);
      check(out && out.source === 'site' && out.stopped === null,
        'byte-budget/under-budget/robots-as-read/same-site-result', JSON.stringify(out));
    } else {
      check(false, 'byte-budget/under-budget/robots-as-read/exit-0', said(tight.run));
    }
  } finally { await store.close(); }
});

check(!guardLog.some((r) => r.allowed === false), 'runner/never-dialled-out',
  JSON.stringify(guardLog.filter((r) => r.allowed === false).slice(0, 2)));

for (const dir of scratch) {
  try { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures.length) {
  console.error(`FAILED - ${failures.length} byte-budget check(s):`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} byte-budget checks.`);
