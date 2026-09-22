/**
 * Harbor Lamp in a real browser: the page runtime (`agent-entry-page.mjs`) driven in a local
 * headless Chrome, against a real door, on loopback only.
 *
 * This is a usage SAMPLE and a check the owner runs by hand. It is NOT part of `npm test`, it
 * downloads nothing, and it needs a Chrome (or Chromium) that is already installed:
 *
 *     npm run demo:chrome
 *     CHROME_PATH=/path/to/chrome npm run demo:chrome      # when Chrome is somewhere else
 *
 * Node 22 or later (it speaks the DevTools protocol over Node's own WebSocket). With no Chrome
 * found it says where it looked and exits 2.
 *
 * What it proves, in Chrome's own engine (WebCrypto Ed25519, <dialog>, fetch, navigation,
 * sendBeacon): the page verifies its signed contract and registers only the route's verbs;
 * `find products` answers from the shop's own API; `hold item` asks once, fills the form and
 * hands off to the door, where a signed knock gets a pending hold with a deal block;
 * `buy order` asks once and lands on the site's checkout URL; `ask anything` is door-only and
 * answered at the door; the page's counts reach the door's collector.
 *
 * WebMCP itself may not be switched on in this Chrome, so a small recording
 * `document.modelContext` is put in place before the page loads, and the leg calls the tools
 * through it. Everything past `registerTool` is the real runtime in the real browser.
 * Chrome runs with a throwaway profile and a host-resolver rule that resolves nothing but
 * 127.0.0.1, so it cannot reach the network.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_CARD_PATH, createAgentEntry, didFromSeedHex, newSeedHex, signEnvelope,
} from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RUNTIME = readFileSync(join(ROOT, 'agent-entry-page.mjs'), 'utf8');
const VECTORS = JSON.parse(readFileSync(join(ROOT, 'conformance', 'vectors-tools.json'), 'utf8'));
const HARBOR = VECTORS.vectors.find((v) => v.name === 'harbor-lamp-every-reply-kind-and-facts').declaration;
const PRODUCTS = [
  { id: 'L-12', name: 'Brass harbour lamp', price: '48.00' },
  { id: 'L-13', name: 'Brass desk lamp', price: '36.00' },
  { id: 'L-20', name: 'Paper lantern', price: '12.00' },
];

// ---------------------------------------------------------------- find Chrome

function chromeCandidates() {
  if (process.env.CHROME_PATH) return [process.env.CHROME_PATH];
  if (process.platform === 'darwin') {
    const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      'Chromium.app/Contents/MacOS/Chromium'];
    return [...apps.map((a) => `/Applications/${a}`), ...apps.map((a) => join(homedir(), 'Applications', a))];
  }
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return roots.map((r) => join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

// ---------------------------------------------------------------- the shop, on loopback

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title} - Harbor Lamp</title>
  <script type="module" src="/agent-entry-page.mjs"></script>
</head>
<body>
  <h1>Harbor Lamp</h1>
  ${body}
</body>
</html>`;
}

const PAGES = {
  '/shop/lamps': () => page('Lamps', '<ul>' + PRODUCTS.map((p) => `<li>${p.name}</li>`).join('') + '</ul>'),
  '/product/l-12': () => page('Brass harbour lamp', `
  <p>Brass harbour lamp, 48.00</p>
  <form id="hold" action="/demo/hold" method="post">
    <label>SKU <input name="sku"></label>
    <label>Name <input name="name"></label>
    <button>Hold for pickup</button>
  </form>
  <p id="held"></p>
  <script type="module">
    document.getElementById('hold').addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = JSON.stringify(Object.fromEntries(new FormData(event.target)));
      const res = await fetch('/demo/hold', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      document.getElementById('held').textContent = (await res.json()).note;
    });
  </script>`),
  '/checkout/start': () => page('Checkout', '<p>Your held items.</p>'),
  '/checkout': (url) => page('Checkout', `<p id="checkout">Checkout for hold ${
    (url.searchParams.get('hold') || '').replace(/[^A-Za-z0-9 _-]/g, '')}</p>`),
};

function startShop() {
  const seen = [];
  const holds = [];
  const counted = [];
  let entry = null;
  let base = null;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, base);
      seen.push(`${req.method} ${url.pathname}${url.search}`);
      const send = (status, type, text) => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(text);
      };
      try {
        if (req.method === 'GET' && url.pathname === '/agent-entry-page.mjs') {
          return send(200, 'text/javascript; charset=utf-8', RUNTIME);
        }
        if (req.method === 'GET' && PAGES[url.pathname]) return send(200, 'text/html; charset=utf-8', PAGES[url.pathname](url));
        if (req.method === 'GET' && url.pathname === '/wp-json/wc/store/v1/products') {
          const q = (url.searchParams.get('search') || '').toLowerCase();
          return send(200, 'application/json', JSON.stringify(PRODUCTS.filter((p) => p.name.toLowerCase().includes(q))));
        }
        if (req.method === 'POST' && url.pathname === '/demo/hold') {
          holds.push(JSON.parse(body.toString('utf8') || '{}'));
          return send(200, 'application/json', JSON.stringify({ note: 'Held for 48 hours.' }));
        }
        const out = await entry.handleRequestAsync(req.method, `${url.pathname}${url.search}`, req.headers, body,
          { remoteAddress: req.socket.remoteAddress });
        res.writeHead(out.status, out.headers);
        res.end(req.method === 'HEAD' ? undefined : out.body);
      } catch (e) {
        send(500, 'text/plain', String(e?.message || e));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      const seedHex = newSeedHex();
      entry = createAgentEntry({
        seedHex, name: HARBOR.entry.name, baseUrl: base,
        declaration: { ...HARBOR, entry: { ...HARBOR.entry, baseUrl: base } },
        observer(env) { if (env.stage === 'page') counted.push({ event: env.event, offer: env.offer, engine: env.engine }); },
      });
      resolve({ server, entry, base, seedHex, seen, holds, counted });
    });
  });
}

// ---------------------------------------------------------------- the DevTools protocol

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    this.waiters = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`)); else resolve(msg.result);
        return;
      }
      for (const w of this.waiters.slice()) {
        if (w.method === msg.method && (!w.sessionId || w.sessionId === msg.sessionId)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg.params);
        }
      }
    });
  }

  send(method, params = {}, sessionId = undefined, ms = 15000) {
    const id = ++this.next;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: no answer in ${ms} ms`)); }, ms);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  once(method, sessionId, ms = 15000) {
    return new Promise((resolve, reject) => {
      const w = { method, sessionId, resolve: (v) => { clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`${method}: not seen in ${ms} ms`));
      }, ms);
      this.waiters.push(w);
    });
  }
}

function launchChrome(path) {
  const profile = mkdtempSync(join(tmpdir(), 'agent-entry-chrome-'));
  const child = spawn(path, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-default-apps',
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stop = () => {
    try { child.kill(); } catch { /* gone */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* gone */ }
  };
  const ws = new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not open DevTools in 20 s:\n${err.slice(-800)}`)), 20000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited (${code}):\n${err.slice(-800)}`)); });
    child.stderr.on('data', (d) => {
      err += String(d);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  return { ws, stop };
}

// A recording `document.modelContext`, in place before any page script runs.
const SHIM = `(() => {
  const native = 'modelContext' in Document.prototype || 'modelContext' in navigator;
  const tools = new Map();
  const modelContext = {
    registerTool(tool, options = {}) {
      if (tools.has(tool.name)) throw new DOMException('already registered: ' + tool.name, 'InvalidStateError');
      tools.set(tool.name, tool);
      options.signal?.addEventListener('abort', () => { if (tools.get(tool.name) === tool) tools.delete(tool.name); }, { once: true });
    },
  };
  Object.defineProperty(document, 'modelContext', { value: modelContext, configurable: true });
  window.__leg = {
    native,
    names: () => [...tools.keys()].sort(),
    run(name, input) {
      const tool = tools.get(name);
      if (!tool) return Promise.resolve({ missing: name });
      return Promise.resolve(tool.execute(input, { requestUserInteraction: async (cb) => cb() })).then((result) => {
        try { sessionStorage.setItem('leg:' + name, JSON.stringify(result)); } catch {}
        return result;
      });
    },
  };
})();`;

// ---------------------------------------------------------------- the leg

let passed = 0;
const failures = [];
function check(ok, label, detail = '') {
  if (ok) { passed += 1; console.log(`  ok   ${label}`); return true; }
  failures.push(label);
  console.log(`  FAIL ${label}${detail ? ` - ${String(detail).slice(0, 400)}` : ''}`);
  return false;
}
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function knock(shop, offer, text) {
  const visitor = newSeedHex();
  const fields = { from: didFromSeedHex(visitor), to: shop.entry.did, messageId: `leg-${Date.now()}-${offer}`,
    contextId: null, timestamp: Math.floor(Date.now() / 1000), text };
  const body = { jsonrpc: '2.0', id: fields.messageId, method: 'message/send', params: { message: {
    kind: 'message', role: 'user', messageId: fields.messageId, contextId: null, parts: [{ kind: 'text', text }],
    metadata: { from: fields.from, to: fields.to, timestamp: fields.timestamp, sig: signEnvelope(visitor, fields), offer },
  } } };
  const res = await fetch(`${shop.base}/`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  const reply = await res.json();
  const part = reply?.result?.parts?.[0]?.text;
  try { return JSON.parse(part); } catch { return { raw: reply }; }
}

async function main() {
  if (typeof globalThis.WebSocket !== 'function') {
    console.error(`This leg needs Node 22 or later (a global WebSocket). This is Node ${process.version}.`);
    return 1;
  }
  const candidates = chromeCandidates();
  const chromePath = candidates.find((p) => existsSync(p));
  if (!chromePath) {
    console.error('No local Chrome found. Nothing was downloaded. Looked at:');
    for (const p of candidates) console.error(`  ${p}`);
    console.error('Set CHROME_PATH to a Chrome or Chromium binary and run it again.');
    return 2;
  }

  const shop = await startShop();
  const chrome = launchChrome(chromePath);
  let ws = null;
  try {
    ws = new WebSocket(await chrome.ws);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools socket')); });
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (method, params) => cdp.send(method, params, sessionId);
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Page.addScriptToEvaluateOnNewDocument', { source: SHIM });
    const { product } = await s('Browser.getVersion').catch(() => cdp.send('Browser.getVersion'));

    const evaluate = async (expression) => {
      const out = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
      return out.result.value;
    };
    const open = async (path) => {
      const loaded = cdp.once('Page.loadEventFired', sessionId);
      await s('Page.navigate', { url: `${shop.base}${path}` });
      await loaded;
      return evaluate("import('/agent-entry-page.mjs').then((m) => m.ready)");
    };
    const waitFor = async (expression, ms = 5000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        try { if (await evaluate(expression)) return true; } catch { /* page in flight */ }
        await pause(50);
      }
      return false;
    };
    const answerDialog = async (value) => {
      const shown = await waitFor("!!document.querySelector('dialog[open]')");
      const text = shown ? await evaluate("document.querySelector('dialog[open]').textContent") : '';
      if (shown) await evaluate(`document.querySelector('dialog[open] button[value=${value}]').click(), true`);
      return { shown, text };
    };
    const cardUrl = `${shop.base}${AGENT_CARD_PATH}`;
    const about = (id) => HARBOR.offers.find((o) => `${o.verb}_${o.of}` === id).about;

    console.log(`Harbor Lamp at ${shop.base}, ${product} (${chromePath})`);

    // 1. find products, arriving from an answer engine.
    console.log('find products');
    const ready = await open('/shop/lamps?utm_source=chatgpt.com');
    check(ready?.ok === true, 'the page verified its signed contract in Chrome (WebCrypto Ed25519)', JSON.stringify(ready));
    const native = await evaluate('window.__leg.native');
    console.log(`  (WebMCP in this Chrome: ${native ? 'present, shadowed by the recording shim' : 'absent, recording shim in place'})`);
    check(JSON.stringify(await evaluate('window.__leg.names()')) === '["find_products"]', '/shop/lamps registers find_products only');
    const found = await evaluate("window.__leg.run('find_products', { q: 'brass' })");
    const foundText = found?.content?.[0]?.text ?? '';
    check(!found?.isError && foundText.includes('Brass harbour lamp') && !foundText.includes('Paper lantern'),
      'find_products answers from the shop\'s own API, filtered by the query', foundText);
    check(found?._meta === undefined && found?.muretai === undefined, 'find_products carries no handoff');
    check(!(await evaluate("!!document.querySelector('dialog')")), 'find_products asks no one (ask: never)');

    // 2. hold item: one dialog, the form filled and sent, then the handoff to the door.
    console.log('hold item');
    await open('/product/l-12');
    check(JSON.stringify(await evaluate('window.__leg.names()')) === '["hold_item"]', '/product/l-12 registers hold_item only');
    await evaluate("window.__hold = window.__leg.run('hold_item', { sku: 'L-12', name: 'Ada Lovelace' }), true");
    const asked = await answerDialog('confirm');
    check(asked.shown && asked.text.includes(about('hold_item')), 'hold_item opens one <dialog> that says what it does', asked.text);
    const held = await evaluate('window.__hold');
    check(!held?.isError, 'hold_item succeeds once confirmed', JSON.stringify(held));
    await waitFor("document.getElementById('held').textContent !== ''");
    check(shop.holds.some((h) => h.sku === 'L-12' && h.name === 'Ada Lovelace'), 'the site\'s own form was filled and sent',
      JSON.stringify(shop.holds));
    const next = held?._meta?.handoff?.next?.[0];
    check(held?._meta?.handoff?.v === 1 && next?.kind === 'a2a' && next?.card === cardUrl, 'hold_item hands off to the door\'s card',
      JSON.stringify(held?._meta));
    check(held?.muretai?.action === 'dm' && held?.muretai?.to === shop.entry.did, 'the legacy muretai key names the door');
    const card = await (await fetch(next?.card ?? cardUrl)).json();
    check(card.did === shop.entry.did, 'the handoff card is the door that signed the contract');
    const pending = await knock(shop, 'hold_item', 'hold item {"sku":"L-12","name":"Ada Lovelace"}');
    check(pending?.verb === 'hold' && pending?.status === 'pending_confirmation' && pending?.deal?.type === 'DealReceipt',
      'a signed knock at the door gets a pending hold with a deal block', JSON.stringify(pending));

    await evaluate("window.__hold2 = window.__leg.run('hold_item', { sku: 'L-13', name: 'Ada Lovelace' }), true");
    const holdsBefore = shop.holds.length;
    await answerDialog('cancel');
    const denied = await evaluate('window.__hold2');
    await pause(200);
    check(denied?.isError === true && !denied?._meta && shop.holds.length === holdsBefore,
      'a cancelled dialog is a denial: nothing sent, no handoff', JSON.stringify(denied));

    // 3. buy order: one dialog, then the site's own checkout URL.
    console.log('buy order');
    await open('/checkout/start');
    check(JSON.stringify(await evaluate('window.__leg.names()')) === '["buy_order"]', '/checkout/start registers buy_order only');
    const landed = cdp.once('Page.loadEventFired', sessionId);
    await evaluate("window.__leg.run('buy_order', { hold_id: 'H-7' }), true");
    const pay = await answerDialog('confirm');
    check(pay.shown && pay.text.includes(about('buy_order')), 'buy_order opens one <dialog> (ask: always)', pay.text);
    await landed;
    const where = await evaluate('location.pathname + location.search');
    check(where === '/checkout?hold=H-7', 'buy_order lands on the checkout URL, same origin', where);
    check(shop.seen.includes('GET /checkout?hold=H-7'), 'the shop served its own checkout page');
    const bought = JSON.parse(await evaluate("sessionStorage.getItem('leg:buy_order')") || 'null');
    check(bought?._meta?.handoff?.next?.[0]?.card === cardUrl, 'buy_order also hands off to the door (pays)', JSON.stringify(bought));

    // 4. ask: door-only, answered at the door.
    console.log('ask');
    const answer = await knock(shop, 'ask', 'Do you ship to the islands?');
    check(answer?.verb === 'ask' && answer?.status === 'awaiting_person', 'ask anything is answered at the door',
      JSON.stringify(answer));

    // 5. counts: leave the page so the last beacon goes out.
    console.log('counts');
    const left = cdp.once('Page.loadEventFired', sessionId);
    await s('Page.navigate', { url: 'about:blank' });
    await left;
    await pause(500);
    const names = new Set(shop.counted.map((e) => e.event));
    for (const name of ['page_ready', 'referral', 'offer_registered', 'offer_started', 'offer_succeeded', 'handoff', 'ask_denied']) {
      check(names.has(name), `the door's collector counted ${name}`, JSON.stringify(shop.counted));
    }
    check(shop.counted.some((e) => e.event === 'referral' && e.engine === 'chatgpt'), 'the referral is attributed to chatgpt');
    check(!shop.seen.some((l) => l.startsWith('GET /.well-known/agent-tools/events')), 'counts went by beacon POST only');
  } finally {
    try { ws?.close(); } catch { /* gone */ }
    chrome.stop();
    shop.server.close();
  }

  if (failures.length) {
    console.log(`FAILED - ${failures.length} of ${passed + failures.length} browser check(s).`);
    return 1;
  }
  console.log(`OK - ${passed} browser checks: Harbor Lamp's verbs work in Chrome, and hand off to the door.`);
  return 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
