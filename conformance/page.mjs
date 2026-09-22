#!/usr/bin/env node
// Agent Entry Suite S2: the page runtime `agent-entry-page.mjs` (browser, zero-dependency,
// vendored same-origin, published in `files`).
//
// WRITTEN BEFORE THE IMPLEMENTATION (test-first pair). The authority is the owner-approved
// design (`agent-entry-suite-design.md` section 3) and the S1 surface that already landed
// (spec/tools-v1.md AT-1..AT-14): this runner consumes the contract, the `agenttools`
// envelope, the card and the collector exactly as S1 serves them, and does not re-test them.
//
// The runtime is browser code. Here it runs under Node against fakes: a fake `window` with a
// fake `document` (+ `document.modelContext`), `location`, `history`, `navigation`,
// `navigator.sendBeacon`, `fetch` and a fake WebCrypto that delegates to Node's own. The fake
// `fetch` answers the well-known routes from a real S1 door in-process. There is no network:
// the global `fetch` / `WebSocket` are traps, and every request the runtime makes is recorded.
//
// What is pinned, in one place:
//   import * as page from '../agent-entry-page.mjs'
//     - importing it under Node (no global `document`) does nothing: no fetch, no throw.
//   page.REFUSALS = ['contract_missing', 'sig_missing', 'sig_invalid', 'origin_mismatch',
//                    'hash_mismatch', 'card_mismatch'] (frozen)
//   page.install({ window, signal?, handlers? }) -> Promise<{ ok: true, ... }
//                                                          | { ok: false, reason: <REFUSALS> }>
//     - `window` defaults to globalThis in a browser; every browser API is read from it.
//     - it never throws for a refusal; a refusal registers NOTHING.
//   Tools: `window.document.modelContext.registerTool(tool, { signal })`. The fake has no
//     `unregisterTool`: a tool leaves only when the signal it was registered with aborts.
//     tool = { name: verb_of, description: about, inputSchema: { type: 'object',
//              properties: { <field>: { type } }, required: [<every field>] },
//              annotations, execute(input, client) }
//   Annotations from `effect`: readOnlyHint for none; destructiveHint for pays (the design's
//     "destroys" is not an S1 effect); idempotentHint for none | reversible;
//     untrustedContentHint for a `read` action. A hint that does not apply is absent or false.
//   A tool result is a WebMCP result: text in `content[].text` (or a top-level `text`),
//     `isError: true` (or a rejected promise) on failure. When the compiled offer has
//     `then: "door"` the result carries `_meta.handoff = { v: 1, next: [{ kind: 'a2a',
//     card: <origin + AGENT_CARD_PATH> }] }` and the legacy top-level `muretai = { v: 1,
//     action: 'dm', to: <card did>, ... }` (agent-web-router spec v0 section 6).
//   Ask: an offer whose compiled `ask` is `advised` or `always` shows exactly one `<dialog>`
//     (appended to the document, opened with `showModal()`) per call. The runtime proceeds only
//     when the dialog's `returnValue` is "confirm" at its `close` event -- the
//     `<form method="dialog"><button value="confirm">` idiom. Anything else is a denial.
//     `ask: never` shows none. `window.confirm` is never used.
//   SPA navigation: with `window.navigation`, a re-sync follows `currententrychange` /
//     `navigatesuccess` and `history.pushState` is left alone; without it, `history.pushState`
//     / `replaceState` are patched and `popstate` is followed.
//   Counts: `navigator.sendBeacon(<origin>/.well-known/agent-tools/events, body)` with the S1
//     collector body `{ session, events: [{ name, offer?, engine?, ms? }] }` (AT-14), <= 100
//     events per session, flushed at the latest on `pagehide` / `visibilitychange` to hidden.
//     Every beacon this runner sees is also POSTed to the real S1 door and must answer 204.
import { createHash, webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as door from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const VECTORS = JSON.parse(readFileSync(join(HERE, 'vectors-tools.json'), 'utf8'));
const { AGENT_CARD_PATH, canonicalJSON, compileDeclaration, createAgentEntry, didFromSeedHex,
  makeToolsEnvelope, signBytes } = door;

const ORIGIN = 'https://shop.example';
const SEED = 'd5'.repeat(32);
const OTHER_SEED = '6b'.repeat(32);
const TOOLS = '/.well-known/agent-tools.json';
const TOOLS_SIG = '/.well-known/agent-tools.sig.json';
const EVENTS = '/.well-known/agent-tools/events';
const CARD_URL = `${ORIGIN}${AGENT_CARD_PATH}`;
const REFUSALS = ['contract_missing', 'sig_missing', 'sig_invalid', 'origin_mismatch', 'hash_mismatch',
  'card_mismatch'];
const EVENT_NAMES = ['page_ready', 'referral', 'offer_registered', 'offer_started', 'offer_succeeded',
  'offer_failed', 'ask_denied', 'handoff'];
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0 Safari/537.36';

let passed = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${detail}` : ''}`);
  return false;
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const settle = (ms = 30) => new Promise((resolve) => { setTimeout(resolve, ms); });

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: no answer in ${ms} ms`)), ms); }),
  ]);
}

// ---------------------------------------------------------------- no network, anywhere

const strayNetwork = [];
globalThis.fetch = (input) => {
  strayNetwork.push(String(input?.url ?? input));
  return Promise.reject(new TypeError('the network is off in conformance/page.mjs'));
};
globalThis.WebSocket = class {
  constructor(url) { strayNetwork.push(String(url)); throw new TypeError('the network is off'); }
};

// ---------------------------------------------------------------- the S1 door and contracts

const harbor = VECTORS.vectors.find((v) => v.name === 'harbor-lamp-every-reply-kind-and-facts');

function makeDoor() {
  return createAgentEntry({
    seedHex: SEED, name: 'Harbor Lamp', baseUrl: ORIGIN, declaration: clone(harbor.declaration),
  });
}

let entry = null;
try { entry = makeDoor(); } catch (e) { check(false, 'setup/S1-door-starts', e.message); }
const DOOR_DID = didFromSeedHex(SEED);
const now = () => Math.floor(Date.now() / 1000);

function rehash(contract) {
  const { hash: _drop, ...rest } = contract;
  return { ...rest, hash: sha256hex(canonicalJSON(rest)) };
}

/** Sign ANY contract, even one S1's signer would refuse (the runtime must recheck). */
function handSign(seed, contract, ts = now()) {
  const payload = canonicalJSON({ contract, ts, typ: 'agenttools', v: 1 });
  return { v: 1, typ: 'agenttools', contract, ts, sig: Buffer.from(signBytes(seed, payload)).toString('base64') };
}

async function doorGet(path) {
  const out = await entry.handleRequestAsync('GET', path, { 'sec-fetch-site': 'same-origin' }, Buffer.alloc(0));
  return Buffer.from(out.body || '').toString('utf8');
}

const HARBOR_CONTRACT = harbor.contract;
const HARBOR_BYTES = canonicalJSON(HARBOR_CONTRACT);
const HARBOR_ENV = entry ? JSON.parse(await doorGet(TOOLS_SIG)) : null;
const CARD = entry ? clone(entry.card) : null;

/** Every page action and every effect class, all on every route. */
const KINDS_DECLARATION = {
  v: 1,
  entry: { name: 'Harbor Lamp', baseUrl: ORIGIN },
  offers: [
    { verb: 'find', of: 'products', about: 'Find lamps by words.', input: { q: 'string', limit: 'integer' },
      page: { on: ['/**'], do: { fetch: { method: 'GET', path: '/api/products', query: { search: 'q', per_page: 'limit' } } } } },
    { verb: 'track', of: 'order', about: 'Track an order on this page.', input: {},
      page: { on: ['/**'], do: { read: '#status' } } },
    { verb: 'join', of: 'list', about: 'Join the mailing list.', input: { email: 'string', weekly: 'boolean' },
      page: { on: ['/**'], do: { call: 'joinList' } } },
    { verb: 'cancel', of: 'booking', about: 'Cancel a booking.', input: { ref: 'string' },
      page: { on: ['/**'], do: { open: '/bookings/{ref}/cancel' } } },
    { verb: 'buy', of: 'order', about: 'Pay for a held item.', input: { hold_id: 'string' },
      page: { on: ['/**'], do: { fetch: { method: 'POST', path: '/api/checkout' } } } },
    { verb: 'rent', of: 'bike', about: 'See bikes for rent.', input: { hours: 'number' },
      page: { on: ['/**'], do: { read: '#bikes' } } },
  ],
};

let KINDS = null;
try { KINDS = compileDeclaration(clone(KINDS_DECLARATION)); } catch (e) {
  check(false, 'setup/kinds-declaration-compiles-under-S1', e.message);
}

function servedContract(contract, envelope) {
  return {
    [TOOLS]: { body: canonicalJSON(contract), type: 'application/json' },
    [TOOLS_SIG]: { body: JSON.stringify(envelope), type: 'application/json' },
  };
}

// ---------------------------------------------------------------- fakes

class FakeText {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); this.parentNode = null; this.children = []; }
  remove() { this.parentNode?.removeChild(this); }
}

class FakeElement extends EventTarget {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.localName = String(tag).toLowerCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
    this._text = '';
    this._html = '';
    this.value = '';
    doc.created.push(this);
  }

  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] ?? null; }
  get parentElement() { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v ?? ''); this.children = []; }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.ownerDocument.htmlWrites.push(String(v)); this.children = []; this._text = ''; }
  set outerHTML(v) { this.ownerDocument.htmlWrites.push(String(v)); }
  insertAdjacentHTML(_where, html) { this.ownerDocument.htmlWrites.push(String(html)); }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(n) : n); }
  prepend(...nodes) { this.append(...nodes); }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node) { return this.appendChild(node); }
  removeChild(node) {
    this.children = this.children.filter((c) => c !== node);
    node.parentNode = null;
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attributes, k) ? this.attributes[k] : null; }
  hasAttribute(k) { return Object.hasOwn(this.attributes, k); }
  removeAttribute(k) { delete this.attributes[k]; }
  toggleAttribute(k, force) { if (force === false) delete this.attributes[k]; else this.attributes[k] = ''; }
  get isConnected() {
    for (let n = this; n; n = n.parentNode) if (n === this.ownerDocument.documentElement) return true;
    return false;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  blur() {}
  click() { this.dispatchEvent(new Event('click')); }
  dispatchEvent(event) {
    const out = super.dispatchEvent(event);
    const handler = this[`on${event.type}`];
    if (typeof handler === 'function') handler.call(this, event);
    return out;
  }
}

class FakeDialog extends FakeElement {
  constructor(doc) { super(doc, 'dialog'); this.open = false; this.returnValue = ''; }
  _show() {
    if (!this.isConnected) throw new DOMException('dialog is not connected', 'InvalidStateError');
    if (this.open) throw new DOMException('dialog is already open', 'InvalidStateError');
    const doc = this.ownerDocument;
    this.open = true;
    doc.shown.push(this);
    doc.openNow += 1;
    doc.maxOpen = Math.max(doc.maxOpen, doc.openNow);
    doc.shownText.push(`${this.textContent} ${this.innerHTML} ${this.children.map((c) => c.innerHTML ?? '').join(' ')}`);
    const answer = doc.answer;
    setTimeout(() => {
      if (!this.open) return;
      if (answer !== 'confirm') this.dispatchEvent(new Event('cancel'));
      this.close(answer === 'escape' ? undefined : answer);
    }, 0);
  }
  showModal() { this._show(); }
  show() { this._show(); }
  close(returnValue) {
    if (!this.open) return;
    if (returnValue !== undefined) this.returnValue = String(returnValue);
    this.open = false;
    this.ownerDocument.openNow -= 1;
    this.dispatchEvent(new Event('close'));
  }
  requestClose(returnValue) { this.close(returnValue); }
}

class FakeForm extends FakeElement {
  constructor(doc, fields) {
    super(doc, 'form');
    this.submits = 0;
    this.fields = {};
    for (const name of fields) {
      const input = new FakeElement(doc, 'input');
      input.name = name;
      input.setAttribute('name', name);
      this.appendChild(input);
      this.fields[name] = input;
    }
    const byName = this.fields;
    this.elements = Object.assign(Object.create({
      namedItem(n) { return byName[n] ?? null; },
      item(i) { return Object.values(byName)[i] ?? null; },
    }), byName, { length: fields.length });
  }
  querySelector(sel) {
    const m = /^(?:input|textarea|select)?\[name=["']?([^"'\]]+)["']?\]$/.exec(String(sel));
    return m ? this.fields[m[1]] ?? null : null;
  }
  querySelectorAll(sel) { const one = this.querySelector(sel); return one ? [one] : []; }
  requestSubmit() { this.submits += 1; this.dispatchEvent(new Event('submit', { cancelable: true })); }
  submit() { this.submits += 1; }
}

class FakeDocument extends EventTarget {
  constructor({ referrer, modelContext }) {
    super();
    this.created = [];
    this.htmlWrites = [];
    this.shown = [];
    this.shownText = [];
    this.openNow = 0;
    this.maxOpen = 0;
    this.answer = 'confirm';
    this.selectors = {};
    this.referrer = referrer;
    this.visibilityState = 'visible';
    this.hidden = false;
    this.readyState = 'complete';
    this.title = 'Harbor Lamp';
    this.documentElement = new FakeElement(this, 'html');
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.documentElement.append(this.head, this.body);
    if (modelContext) this.modelContext = modelContext;
  }
  createElement(tag) {
    if (String(tag).toLowerCase() === 'dialog') return new FakeDialog(this);
    return new FakeElement(this, tag);
  }
  createTextNode(text) { return new FakeText(text); }
  createDocumentFragment() { return new FakeElement(this, '#fragment'); }
  querySelector(sel) { return this.selectors[sel] ?? null; }
  querySelectorAll(sel) { const one = this.querySelector(sel); return one ? [one] : []; }
  getElementById(id) { return this.selectors[`#${id}`] ?? null; }
  place(sel, el) { this.body.appendChild(el); this.selectors[sel] = el; return el; }
}

class FakeModelContext {
  constructor() { this.tools = new Map(); this.log = []; this.dupes = 0; this.options = []; }
  registerTool(tool, options) {
    if (!tool || typeof tool.name !== 'string') throw new TypeError('registerTool: tool.name');
    if (this.tools.has(tool.name)) {
      this.dupes += 1;
      throw new DOMException(`a tool named ${tool.name} is already registered`, 'InvalidStateError');
    }
    const signal = options?.signal;
    this.options.push(options);
    this.log.push({ op: 'register', name: tool.name });
    if (signal?.aborted) return;
    this.tools.set(tool.name, { tool, signal });
    signal?.addEventListener?.('abort', () => {
      if (this.tools.get(tool.name)?.tool === tool) {
        this.tools.delete(tool.name);
        this.log.push({ op: 'abort', name: tool.name });
      }
    }, { once: true });
  }
  names() { return [...this.tools.keys()].sort(); }
  tool(name) { return this.tools.get(name)?.tool; }
  registered() { return this.log.filter((l) => l.op === 'register').map((l) => l.name); }
}

class FakeLocation {
  constructor(href) { this._url = new URL(href); this.assigned = []; }
  _go(v) { this.assigned.push(new URL(String(v), this._url).href); }
  _moveTo(v) { this._url = new URL(String(v), this._url); }
  get href() { return this._url.href; }
  set href(v) { this._go(v); }
  get origin() { return this._url.origin; }
  get protocol() { return this._url.protocol; }
  get host() { return this._url.host; }
  get hostname() { return this._url.hostname; }
  get port() { return this._url.port; }
  get pathname() { return this._url.pathname; }
  set pathname(v) { this._go(new URL(String(v), this._url).href); }
  get search() { return this._url.search; }
  get hash() { return this._url.hash; }
  assign(v) { this._go(v); }
  replace(v) { this._go(v); }
  reload() {}
  toString() { return this.href; }
}

class FakeHistory {
  constructor(win) { this._win = win; this.length = 1; this.state = null; this.scrollRestoration = 'auto'; }
  pushState(state, _title, url) {
    if (url !== undefined && url !== null) this._win.location._moveTo(url);
    this.state = state; this.length += 1;
  }
  replaceState(state, _title, url) {
    if (url !== undefined && url !== null) this._win.location._moveTo(url);
    this.state = state;
  }
  back() {}
  forward() {}
  go() {}
}
const ORIGINAL_PUSH = FakeHistory.prototype.pushState;
const ORIGINAL_REPLACE = FakeHistory.prototype.replaceState;

class FakeNavigation extends EventTarget {
  constructor(win) { super(); this._win = win; }
  get currentEntry() { return { url: this._win.location.href, key: 'k', id: 'i', index: 0, sameDocument: true }; }
  navigate(url) {
    this._win.location._go(url);
    return { committed: Promise.resolve(), finished: Promise.resolve() };
  }
}

/** A fake WebCrypto that delegates to Node's, logs what it is asked, and can be broken. */
function makeCrypto(mode = 'real') {
  const log = [];
  const algName = (a) => (typeof a === 'string' ? a : a?.name);
  const subtle = {};
  for (const m of ['importKey', 'verify', 'digest', 'exportKey', 'sign', 'encrypt', 'decrypt', 'deriveBits',
    'deriveKey', 'generateKey', 'wrapKey', 'unwrapKey']) {
    subtle[m] = async (...args) => {
      const alg = m === 'importKey' ? algName(args[2]) : algName(args[0]);
      log.push({ m, alg });
      if (mode === 'verify-false' && m === 'verify') return false;
      if (mode === 'no-ed25519' && /ed25519/i.test(String(alg))) {
        throw new DOMException('Ed25519 is not supported here', 'NotSupportedError');
      }
      return webcrypto.subtle[m](...args);
    };
  }
  return {
    log,
    subtle,
    getRandomValues: (a) => webcrypto.getRandomValues(a),
    randomUUID: () => webcrypto.randomUUID(),
  };
}

function toResponse(r, method) {
  const status = r.status ?? 200;
  const nullBody = method === 'HEAD' || [101, 204, 205, 304].includes(status);
  const headers = {};
  if (r.type) headers['content-type'] = r.type;
  for (const [k, v] of Object.entries(r.headers || {})) if (typeof v === 'string') headers[k] = v;
  return new Response(nullBody ? null : (r.body ?? ''), { status, headers });
}

/**
 * A page at `href`. `routes` maps a same-origin pathname to `{status?, body, type?}` or to a
 * function `(url, method, init) -> {...}`; the well-known routes fall back to the real S1 door.
 */
function makeWindow({ href = `${ORIGIN}/product/l-12`, referrer = '', navigationApi = true, routes = {},
  crypto = makeCrypto(), modelContext = new FakeModelContext() } = {}) {
  const win = new EventTarget();
  win.requests = [];
  win.foreign = [];
  win.beacons = [];
  win.confirms = 0;
  win.modelContext = modelContext;
  win.cryptoLog = crypto.log;
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.location = new FakeLocation(href);
  win.document = new FakeDocument({ referrer, modelContext });
  win.history = new FakeHistory(win);
  if (navigationApi) win.navigation = new FakeNavigation(win);
  win.crypto = crypto;
  win.navigator = {
    userAgent: CHROME,
    language: 'en',
    sendBeacon(url, data) { win.beacons.push({ url: String(url), data }); return true; },
  };
  win.confirm = () => { win.confirms += 1; return true; };
  win.alert = () => {};
  win.prompt = () => null;
  win.routes = routes;
  win.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    const url = new URL(String(raw), win.location.href);
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    win.requests.push({ url: url.href, method, init });
    if (url.origin !== win.location.origin) {
      win.foreign.push(url.href);
      throw new TypeError('a cross-origin request reached the test fetch');
    }
    const route = win.routes[url.pathname];
    if (route !== undefined) {
      const r = typeof route === 'function' ? await route(url, method, init) : route;
      return toResponse(r, method);
    }
    if (url.pathname.startsWith('/.well-known/') && entry) {
      const out = await entry.handleRequestAsync(method, url.pathname + url.search,
        { 'sec-fetch-site': 'same-origin', accept: 'application/json' }, Buffer.alloc(0));
      return toResponse({ status: out.status, body: Buffer.from(out.body || ''), headers: out.headers }, method);
    }
    return toResponse({ status: 404, body: 'not found' }, method);
  };
  for (const name of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
    'structuredClone', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController',
    'AbortSignal', 'Blob', 'Event', 'EventTarget', 'CustomEvent', 'DOMException', 'Headers', 'Request',
    'Response', 'performance', 'console', 'JSON', 'Promise']) {
    win[name] = typeof globalThis[name] === 'function' && /^[a-z]/.test(name)
      ? globalThis[name].bind(globalThis) : globalThis[name];
  }
  win.isSecureContext = true;
  win.origin = win.location.origin;
  const dispatch = win.dispatchEvent.bind(win);
  win.dispatchEvent = (event) => {
    const out = dispatch(event);
    const handler = win[`on${event.type}`];
    if (typeof handler === 'function') handler.call(win, event);
    return out;
  };
  return win;
}

function harborForm(win) {
  return win.document.place('#hold', new FakeForm(win.document, ['sku', 'name']));
}

async function spaNavigate(win, path) {
  win.location._moveTo(path);
  win.navigation.dispatchEvent(new Event('currententrychange'));
  win.navigation.dispatchEvent(new Event('navigatesuccess'));
  await settle();
}

async function flush(win) {
  win.document.visibilityState = 'hidden';
  win.document.hidden = true;
  win.document.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('pagehide'));
  await settle();
}

async function beaconText(data) {
  if (typeof data === 'string') return data;
  if (data && typeof data.text === 'function') return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}

async function beaconBodies(win) {
  const out = [];
  for (const b of win.beacons) {
    const text = await beaconText(b.data);
    let body = null;
    try { body = JSON.parse(text); } catch { /* reported by the caller */ }
    out.push({ url: b.url, text, body });
  }
  return out;
}

async function eventsOf(win) {
  return (await beaconBodies(win)).flatMap((b) => (Array.isArray(b.body?.events) ? b.body.events : []));
}

const CLIENT = { requestUserInteraction: async (cb) => cb() };

async function run(win, name, input) {
  const tool = win.modelContext.tool(name);
  if (!tool || typeof tool.execute !== 'function') return { missing: true, threw: true };
  try {
    return { result: await withTimeout(tool.execute(input, CLIENT), 3000, `execute ${name}`) };
  } catch (error) {
    return { threw: true, error };
  }
}

const failed = (r) => r.threw === true || r.result?.isError === true;
const succeeded = (r) => r.threw !== true && r.result?.isError !== true;
function textOf(r) {
  const res = r.result;
  if (typeof res === 'string') return res;
  const parts = [];
  if (typeof res?.text === 'string') parts.push(res.text);
  for (const c of Array.isArray(res?.content) ? res.content : []) if (typeof c?.text === 'string') parts.push(c.text);
  return parts.join('\n');
}

const allWindows = [];

// ---------------------------------------------------------------- 0. the module itself

const PAGE_PATH = join(ROOT, 'agent-entry-page.mjs');
let page = null;
if (check(existsSync(PAGE_PATH), 'module/agent-entry-page.mjs-exists-at-the-package-root')) {
  try { page = await import('../agent-entry-page.mjs'); } catch (e) {
    check(false, 'module/imports-under-node', e.message);
  }
}
await settle();
check(strayNetwork.length === 0, 'module/importing-makes-no-request', strayNetwork.join(' '));

{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  check(Array.isArray(pkg.files) && pkg.files.includes('agent-entry-page.mjs'),
    'module/published-in-package-files', JSON.stringify(pkg.files));
  check(!Object.keys(pkg.dependencies || {}).length, 'module/package-stays-zero-dependency');
  if (existsSync(PAGE_PATH)) {
    const src = readFileSync(PAGE_PATH, 'utf8');
    const specifiers = [...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)]
      .map((m) => m[1] ?? m[2]);
    check(specifiers.length === 0, 'module/zero-dependency-one-file-imports-nothing', specifiers.join(' '));
    check(!/\brequire\s*\(/.test(src) && !/['"]node:/.test(src), 'module/browser-code-no-node-apis');
    check(!/https?:\/\/(?!shop\.example)[a-z0-9.-]+\.[a-z]{2,}\/[^\s'"`]*\.(?:m?js|json)/i.test(src.replace(/\/\/.*$/gm, '')),
      'module/fetches-no-third-party-script-or-json');
  }
}

const install = typeof page?.install === 'function' ? page.install : null;
check(install !== null, 'module/exports-install');
check(JSON.stringify(page?.REFUSALS) === JSON.stringify(REFUSALS), 'module/REFUSALS-are-the-six-in-order',
  JSON.stringify(page?.REFUSALS));
check(Object.isFrozen(page?.REFUSALS ?? {}), 'module/REFUSALS-frozen');

async function boot(opts = {}, { signal, handlers } = {}) {
  const win = makeWindow(opts);
  allWindows.push(win);
  if (opts.form !== false) harborForm(win);
  let result = null;
  let error = null;
  if (install) {
    try {
      result = await withTimeout(install({ window: win, ...(signal ? { signal } : {}),
        ...(handlers ? { handlers } : {}) }), 5000, 'install');
    } catch (e) { error = e; }
  }
  await settle();
  return { win, result, error, mc: win.modelContext };
}

// ---------------------------------------------------------------- 1. fetch, verify, register

if (install && entry) {
  const { win, result, error, mc } = await boot();
  check(error === null, 'verify/install-resolves', error?.message);
  check(result?.ok === true, 'verify/good-contract-ok', JSON.stringify(result));
  const got = win.requests.filter((r) => r.method === 'GET').map((r) => new URL(r.url));
  for (const path of [AGENT_CARD_PATH, TOOLS, TOOLS_SIG]) {
    check(got.some((u) => u.origin === ORIGIN && u.pathname === path), `verify/fetches-${path}-from-its-own-origin`,
      win.requests.map((r) => r.url).join(' '));
  }
  check(win.foreign.length === 0, 'verify/no-other-origin', win.foreign.join(' '));
  const ed = (e) => /^ed25519$/i.test(String(e.alg));
  check(win.cryptoLog.some((e) => e.m === 'importKey' && ed(e)) && win.cryptoLog.some((e) => e.m === 'verify' && ed(e)),
    'verify/ed25519-through-window.crypto.subtle', JSON.stringify(win.cryptoLog));
  check(win.cryptoLog.some((e) => e.m === 'digest' && /^sha-256$/i.test(String(e.alg))),
    'verify/hash-rechecked-with-sha-256', JSON.stringify(win.cryptoLog));

  check(JSON.stringify(mc.names()) === JSON.stringify(['hold_item']), 'register/only-the-route-matching-page-offer',
    JSON.stringify(mc.names()));
  const tool = mc.tool('hold_item');
  const offer = HARBOR_CONTRACT.offers.find((o) => o.id === 'hold_item');
  check(tool?.description === offer.about, 'register/description-is-about', JSON.stringify(tool?.description));
  check(typeof tool?.execute === 'function', 'register/execute-is-a-function');
  const schema = tool?.inputSchema;
  check(schema?.type === 'object'
      && canonicalJSON(schema?.properties ?? null) === canonicalJSON({ name: { type: 'string' }, sku: { type: 'string' } })
      && JSON.stringify([...(schema?.required ?? [])].sort()) === JSON.stringify(['name', 'sku']),
    'register/inputSchema-from-input', JSON.stringify(schema));
  check(mc.options.every((o) => o?.signal instanceof AbortSignal), 'register/each-tool-registered-with-an-AbortSignal',
    JSON.stringify(mc.options.map((o) => typeof o?.signal)));
  check(mc.dupes === 0, 'register/no-duplicate-registration');
}

if (install && entry) {
  const cases = [
    ['/shop/lamps', ['find_products']],
    ['/shop/lamps/brass', ['find_products']],
    ['/product/l-12', ['hold_item']],
    ['/product/l-12?ref=x#top', ['hold_item']],
    ['/product/l-12/reviews', []],
    ['/checkout/start', ['buy_order']],
    ['/about', []],
    ['/', []],
  ];
  for (const [path, want] of cases) {
    const { result, mc } = await boot({ href: `${ORIGIN}${path}` });
    check(result?.ok === true, `register/route-${path}/ok`, JSON.stringify(result));
    check(JSON.stringify(mc.names()) === JSON.stringify(want), `register/route-${path}/registers-${want.join('+') || 'nothing'}`,
      JSON.stringify(mc.names()));
    check(!mc.registered().some((n) => n === 'book_table' || n === 'ask_anything'),
      `register/route-${path}/door-only-offers-never-become-tools`);
  }
}

// ---------------------------------------------------------------- 2. the refusal set

async function refused(label, reason, opts) {
  const { win, result, error, mc } = await boot(opts);
  check(error === null, `refuse/${label}/resolves-not-throws`, error?.message);
  if (reason) {
    check(result?.ok === false && result?.reason === reason, `refuse/${label}/reason-${reason}`, JSON.stringify(result));
  } else {
    check(result?.ok === false && REFUSALS.includes(result?.reason), `refuse/${label}/a-named-refusal`,
      JSON.stringify(result));
  }
  check(mc.log.length === 0, `refuse/${label}/registers-nothing`, JSON.stringify(mc.log));
  await flush(win);
  const events = await eventsOf(win);
  check(!events.some((e) => e.name === 'offer_registered'), `refuse/${label}/no-offer_registered-event`);
  check(win.foreign.length === 0, `refuse/${label}/no-other-origin`, win.foreign.join(' '));
  return win;
}

if (install && entry && HARBOR_ENV && CARD && KINDS) {
  const ts = now();

  // contract_missing
  await refused('contract-404', 'contract_missing', { routes: { [TOOLS]: { status: 404, body: 'nope' } } });

  // sig_missing
  await refused('sig-404', 'sig_missing', { routes: { [TOOLS_SIG]: { status: 404, body: 'nope' } } });
  await refused('sig-malformed', null, { routes: { [TOOLS_SIG]: { body: '{"v":1,', type: 'application/json' } } });

  // sig_invalid
  const flipped = clone(HARBOR_ENV);
  flipped.sig = (flipped.sig[0] === 'A' ? 'B' : 'A') + flipped.sig.slice(1);
  await refused('sig-bit-flipped', 'sig_invalid', { routes: servedContract(HARBOR_CONTRACT, flipped) });
  await refused('sig-by-another-key', 'sig_invalid',
    { routes: servedContract(HARBOR_CONTRACT, makeToolsEnvelope(OTHER_SEED, clone(HARBOR_CONTRACT), ts)) });
  await refused('card-names-another-key', 'sig_invalid',
    { routes: { [AGENT_CARD_PATH]: { body: JSON.stringify({ ...CARD, did: didFromSeedHex(OTHER_SEED) }), type: 'application/json' } } });
  await refused('typ-relabelled-agentcard', 'sig_invalid',
    { routes: servedContract(HARBOR_CONTRACT, { ...clone(HARBOR_ENV), typ: 'agentcard' }) });
  await refused('ts-tampered', 'sig_invalid',
    { routes: servedContract(HARBOR_CONTRACT, { ...clone(HARBOR_ENV), ts: HARBOR_ENV.ts + 1 }) });
  await refused('webcrypto-says-no', 'sig_invalid', { crypto: makeCrypto('verify-false') });
  await refused('no-ed25519-in-this-browser', null, { crypto: makeCrypto('no-ed25519') });

  // origin_mismatch
  await refused('page-on-http', 'origin_mismatch', { href: 'http://shop.example/product/l-12' });
  await refused('page-on-another-port', 'origin_mismatch', { href: 'https://shop.example:8443/product/l-12' });
  await refused('page-on-a-suffix-host', 'origin_mismatch', { href: 'https://shop.example.evil.example/product/l-12' });
  const elsewhere = compileDeclaration({ ...clone(harbor.declaration),
    entry: { ...clone(harbor.declaration.entry), baseUrl: 'https://other.example' } });
  await refused('contract-for-another-origin', 'origin_mismatch',
    { routes: servedContract(elsewhere, makeToolsEnvelope(SEED, clone(elsewhere), ts)) });

  // hash_mismatch (each validly signed, origins right: only the hash is wrong)
  const zeroHash = { ...clone(HARBOR_CONTRACT), hash: '0'.repeat(64) };
  await refused('signed-contract-with-a-zero-hash', 'hash_mismatch', { routes: servedContract(zeroHash, handSign(SEED, zeroHash, ts)) });
  const stale = clone(HARBOR_CONTRACT);
  stale.offers[1].about = 'Hold every lamp forever.';
  await refused('signed-contract-with-a-stale-hash', 'hash_mismatch', { routes: servedContract(stale, handSign(SEED, stale, ts)) });
  const v2 = compileDeclaration(clone(harbor.declaration), { version: 2 });
  await refused('served-contract-is-not-the-signed-one', 'hash_mismatch', {
    routes: { [TOOLS]: { body: canonicalJSON(v2), type: 'application/json' },
      [TOOLS_SIG]: { body: JSON.stringify(HARBOR_ENV), type: 'application/json' } },
  });

  // card_mismatch
  await refused('card-404', 'card_mismatch', { routes: { [AGENT_CARD_PATH]: { status: 404, body: 'nope' } } });
  await refused('card-not-json', 'card_mismatch', { routes: { [AGENT_CARD_PATH]: { body: '<html>', type: 'text/html' } } });
  await refused('card-did-not-did-key', 'card_mismatch',
    { routes: { [AGENT_CARD_PATH]: { body: JSON.stringify({ ...CARD, did: 'did:web:shop.example' }), type: 'application/json' } } });
  const noTools = clone(CARD);
  delete noTools.agentEntry?.tools;
  await refused('card-names-no-tools', 'card_mismatch',
    { routes: { [AGENT_CARD_PATH]: { body: JSON.stringify(noTools), type: 'application/json' } } });

  // No modelContext in this browser: nothing registered, nothing thrown.
  const bare = makeWindow({ modelContext: null });
  allWindows.push(bare);
  delete bare.document.modelContext;
  let threw = null;
  try { await withTimeout(install({ window: bare }), 5000, 'install'); } catch (e) { threw = e; }
  check(threw === null, 'refuse/no-modelContext/does-not-throw', threw?.message);
}

// ---------------------------------------------------------------- 3. annotations from effect

const KIND_PAGE = `${ORIGIN}/account/orders`;

async function bootKinds({ routes = {}, ...extra } = {}, how = {}) {
  return boot({ href: KIND_PAGE, ...extra, form: false,
    routes: { ...servedContract(KINDS, makeToolsEnvelope(SEED, clone(KINDS), now())), ...routes } }, how);
}

if (install && entry && KINDS) {
  const { result, mc } = await bootKinds();
  check(result?.ok === true, 'annotations/kinds-contract-ok', JSON.stringify(result));
  const want = ['buy_order', 'cancel_booking', 'find_products', 'join_list', 'rent_bike', 'track_order'];
  check(JSON.stringify(mc.names()) === JSON.stringify(want), 'annotations/every-page-offer-registered-as-verb_of',
    JSON.stringify(mc.names()));
  const yes = (a, k) => a?.[k] === true;
  const no = (a, k) => a?.[k] !== true;
  const expect = {
    find_products: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, untrustedContentHint: false },
    track_order: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, untrustedContentHint: true },
    join_list: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, untrustedContentHint: false },
    cancel_booking: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, untrustedContentHint: false },
    buy_order: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, untrustedContentHint: false },
    // A site verb without `effect`: never claimed read-only or idempotent (AT-4).
    rent_bike: { readOnlyHint: false, idempotentHint: false, untrustedContentHint: true },
  };
  for (const [name, hints] of Object.entries(expect)) {
    const t = mc.tool(name);
    for (const [hint, on] of Object.entries(hints)) {
      check(on ? yes(t?.annotations, hint) : no(t?.annotations, hint), `annotations/${name}/${hint}-${on}`,
        JSON.stringify(t?.annotations));
    }
    const offer = KINDS.offers.find((o) => o.id === name);
    check(t?.description === offer?.about, `annotations/${name}/description-is-about`);
    const props = {};
    for (const [field, type] of Object.entries(offer?.input || {})) props[field] = { type };
    check(canonicalJSON(t?.inputSchema?.properties ?? null) === canonicalJSON(props),
      `annotations/${name}/inputSchema-types`, JSON.stringify(t?.inputSchema));
  }
}

// ---------------------------------------------------------------- 4. the page actions

if (install && entry && KINDS) {
  const seen = [];
  const joinCalls = [];
  const joinList = (input) => { joinCalls.push(clone(input)); return 'JOINED-5520'; };
  const routes = {
    '/api/products': (url, method) => { seen.push({ url, method }); return { body: '[{"name":"SERVER-PRODUCTS-7731"}]', type: 'application/json' }; },
    '/api/checkout': (url, method, init) => { seen.push({ url, method, init }); return { body: '{"next":"SERVER-CHECKOUT-2210"}', type: 'application/json' }; },
  };
  const { win } = await bootKinds({ routes }, { handlers: { joinList } });
  win.joinList = joinList;
  const status = new FakeElement(win.document, 'p');
  status.textContent = 'Shipped: parcel 4417';
  win.document.place('#status', status);

  // fetch GET: query from input, same origin, the answer comes back as text.
  const f = await run(win, 'find_products', { q: 'brass lamp', limit: 5 });
  check(succeeded(f), 'do/fetch-get/succeeds', f.error?.message ?? JSON.stringify(f.result));
  const get = seen.find((s) => s.url.pathname === '/api/products');
  check(get?.method === 'GET' && get.url.origin === ORIGIN, 'do/fetch-get/same-origin-GET');
  check(get?.url.searchParams.get('search') === 'brass lamp' && get?.url.searchParams.get('per_page') === '5',
    'do/fetch-get/query-mapped-from-input', get?.url.href);
  check(textOf(f).includes('SERVER-PRODUCTS-7731'), 'do/fetch-get/result-carries-the-answer', textOf(f));
  check(win.document.shown.length === 0, 'do/fetch-get/ask-never-shows-no-dialog');

  // Bad input: refused before any request.
  const before = seen.length;
  for (const [label, input] of [['q-not-a-string', { q: 7, limit: 5 }], ['missing-q', { limit: 5 }],
    ['limit-not-an-integer', { q: 'x', limit: 1.5 }]]) {
    const r = await run(win, 'find_products', input);
    check(failed(r), `do/input/${label}/is-an-error`);
  }
  check(seen.length === before, 'do/input/bad-input-makes-no-request', `${seen.length - before} request(s)`);

  // read: the element's text, marked untrusted by its annotation.
  const rd = await run(win, 'track_order', {});
  check(succeeded(rd) && textOf(rd).includes('Shipped: parcel 4417'), 'do/read/returns-the-element-text', textOf(rd));
  const none = await run(win, 'rent_bike', { hours: 2 });
  check(failed(none), 'do/read/missing-element-is-an-error');

  // call: the named function, with the input, once, after its dialog (join -> changes -> advised).
  const c = await run(win, 'join_list', { email: 'a@b.example', weekly: true });
  check(succeeded(c), 'do/call/succeeds', c.error?.message ?? JSON.stringify(c.result));
  check(joinCalls.length === 1 && canonicalJSON(joinCalls[0]) === canonicalJSON({ email: 'a@b.example', weekly: true }),
    'do/call/function-called-once-with-the-input', JSON.stringify(joinCalls));
  check(textOf(c).includes('JOINED-5520'), 'do/call/result-carries-the-return-value', textOf(c));
  const badCall = await run(win, 'join_list', { email: 'a@b.example', weekly: 'yes' });
  check(failed(badCall) && joinCalls.length === 1, 'do/call/bad-input-never-reaches-the-function');

  // open: a same-origin navigation, placeholders percent-encoded.
  const o = await run(win, 'cancel_booking', { ref: 'R 9/x' });
  check(succeeded(o), 'do/open/succeeds', o.error?.message ?? JSON.stringify(o.result));
  check(win.location.assigned.includes(`${ORIGIN}/bookings/R%209%2Fx/cancel`), 'do/open/navigates-same-origin-encoded',
    JSON.stringify(win.location.assigned));

  // fetch POST (buy -> pays -> always).
  const p = await run(win, 'buy_order', { hold_id: 'H-7' });
  check(succeeded(p), 'do/fetch-post/succeeds', p.error?.message ?? JSON.stringify(p.result));
  const post = seen.find((s) => s.url.pathname === '/api/checkout');
  check(post?.method === 'POST' && post.url.origin === ORIGIN, 'do/fetch-post/same-origin-POST');
  check(textOf(p).includes('SERVER-CHECKOUT-2210'), 'do/fetch-post/result-carries-the-answer', textOf(p));
  check(win.confirms === 0, 'do/window.confirm-never-used');

  // call: a function that is not there.
  const other = await bootKinds();
  const missing = await run(other.win, 'join_list', { email: 'a@b.example', weekly: false });
  check(failed(missing), 'do/call/missing-function-is-an-error');
}

// ---------------------------------------------------------------- 5. one dialog per ask

if (install && entry) {
  const { win } = await boot();
  const form = win.document.selectors['#hold'];
  const doc = win.document;

  const ok = await run(win, 'hold_item', { sku: 'L-12', name: 'Ada Lovelace' });
  check(succeeded(ok), 'ask/confirmed/succeeds', ok.error?.message ?? JSON.stringify(ok.result));
  check(doc.shown.length === 1, 'ask/confirmed/exactly-one-dialog', `${doc.shown.length} shown`);
  check(doc.shown[0]?.tagName === 'DIALOG', 'ask/confirmed/it-is-a-dialog-element');
  check(String(doc.shownText[0] ?? '').includes(HARBOR_CONTRACT.offers[1].about) || doc.shown[0]?.textContent.includes(HARBOR_CONTRACT.offers[1].about),
    'ask/confirmed/dialog-says-what-the-offer-does', doc.shownText[0]);
  check(form.fields.sku.value === 'L-12' && form.fields.name.value === 'Ada Lovelace', 'ask/confirmed/fill-sets-the-fields',
    JSON.stringify({ sku: form.fields.sku.value, name: form.fields.name.value }));
  check(form.submits === 1, 'ask/confirmed/fill-submits-once', `${form.submits} submit(s)`);

  const again = await run(win, 'hold_item', { sku: 'L-13', name: 'Ada Lovelace' });
  check(succeeded(again) && doc.shown.length === 2, 'ask/second-call/one-more-dialog', `${doc.shown.length} shown`);
  check(doc.maxOpen === 1, 'ask/never-two-dialogs-open-at-once', `max ${doc.maxOpen}`);

  for (const answer of ['escape', 'cancel']) {
    const shown = doc.shown.length;
    const submits = form.submits;
    form.fields.sku.value = '';
    doc.answer = answer;
    const denied = await run(win, 'hold_item', { sku: 'L-14', name: 'Ada Lovelace' });
    check(failed(denied), `ask/denied-${answer}/is-an-error`);
    check(doc.shown.length === shown + 1, `ask/denied-${answer}/exactly-one-dialog`);
    check(form.submits === submits && form.fields.sku.value === '', `ask/denied-${answer}/nothing-filled-or-submitted`);
    check(!denied.result?._meta?.handoff && !denied.result?.muretai, `ask/denied-${answer}/no-handoff`);
  }
  doc.answer = 'confirm';

  // Input values are never written into the page as HTML.
  const xss = '<img src=x onerror=alert(1)>';
  await run(win, 'hold_item', { sku: xss, name: xss });
  check(!doc.htmlWrites.some((h) => h.includes('<img src=x')), 'ask/input-values-never-become-html',
    doc.htmlWrites.filter((h) => h.includes('<img')).join(' | '));

  // A form that is not on this page.
  delete doc.selectors['#hold'];
  const lost = await run(win, 'hold_item', { sku: 'L-15', name: 'Ada Lovelace' });
  check(failed(lost), 'do/fill/missing-form-is-an-error');

  // ask: always.
  const co = await boot({ href: `${ORIGIN}/checkout/start` });
  const buy = await run(co.win, 'buy_order', { hold_id: 'H 7&x' });
  check(succeeded(buy) && co.win.document.shown.length === 1, 'ask/always/exactly-one-dialog',
    `${co.win.document.shown.length} shown`);
  check(co.win.location.assigned.includes(`${ORIGIN}/checkout?hold=H%207%26x`), 'do/open/checkout-url-same-origin-encoded',
    JSON.stringify(co.win.location.assigned));
  co.win.document.answer = 'cancel';
  const n = co.win.location.assigned.length;
  const buyNo = await run(co.win, 'buy_order', { hold_id: 'H-8' });
  check(failed(buyNo) && co.win.location.assigned.length === n, 'ask/always/denied-never-navigates');

  // ask: never.
  const shop = await boot({ href: `${ORIGIN}/shop/lamps`,
    routes: { '/wp-json/wc/store/v1/products': { body: '[]', type: 'application/json' } } });
  await run(shop.win, 'find_products', { q: 'brass' });
  check(shop.win.document.shown.length === 0, 'ask/never/no-dialog');
}

// ---------------------------------------------------------------- 6. handoff when then: door

if (install && entry) {
  const { win } = await boot();
  const r = await run(win, 'hold_item', { sku: 'L-12', name: 'Ada Lovelace' });
  const handoff = r.result?._meta?.handoff;
  check(handoff?.v === 1, 'handoff/hold_item/_meta.handoff.v-1', JSON.stringify(r.result?._meta));
  check(canonicalJSON(handoff?.next ?? null) === canonicalJSON([{ kind: 'a2a', card: CARD_URL }]),
    'handoff/hold_item/next-is-one-a2a-entry-naming-the-card', JSON.stringify(handoff?.next));
  const legacy = r.result?.muretai;
  check(legacy?.v === 1 && legacy?.action === 'dm' && legacy?.to === DOOR_DID, 'handoff/hold_item/legacy-muretai-key',
    JSON.stringify(legacy));

  const co = await boot({ href: `${ORIGIN}/checkout/start` });
  const b = await run(co.win, 'buy_order', { hold_id: 'H-7' });
  check(canonicalJSON(b.result?._meta?.handoff?.next ?? null) === canonicalJSON([{ kind: 'a2a', card: CARD_URL }]),
    'handoff/buy_order/pays-hands-off-to-the-door', JSON.stringify(b.result?._meta));

  const shop = await boot({ href: `${ORIGIN}/shop/lamps`,
    routes: { '/wp-json/wc/store/v1/products': { body: '[]', type: 'application/json' } } });
  const f = await run(shop.win, 'find_products', { q: 'brass' });
  check(succeeded(f) && f.result?._meta?.handoff === undefined && f.result?.muretai === undefined,
    'handoff/find_products/no-then-no-handoff', JSON.stringify(f.result));
}

// ---------------------------------------------------------------- 7. SPA navigation re-sync

if (install && entry) {
  // Navigation API.
  const { win, mc } = await boot({ href: `${ORIGIN}/shop/lamps` });
  check(JSON.stringify(mc.names()) === '["find_products"]', 'resync/navigation/start', JSON.stringify(mc.names()));
  check(win.history.pushState === ORIGINAL_PUSH && win.history.replaceState === ORIGINAL_REPLACE,
    'resync/navigation/history-left-alone-when-the-navigation-api-exists');
  await spaNavigate(win, '/product/l-12');
  check(JSON.stringify(mc.names()) === '["hold_item"]', 'resync/navigation/product', JSON.stringify(mc.names()));
  check(mc.log.some((l) => l.op === 'abort' && l.name === 'find_products'), 'resync/navigation/left-tool-unregistered-by-its-signal');
  await spaNavigate(win, '/product/l-13');
  check(JSON.stringify(mc.names()) === '["hold_item"]', 'resync/navigation/same-offer-stays', JSON.stringify(mc.names()));
  await spaNavigate(win, '/about');
  check(JSON.stringify(mc.names()) === '[]', 'resync/navigation/about-none', JSON.stringify(mc.names()));
  await spaNavigate(win, '/checkout/start');
  check(JSON.stringify(mc.names()) === '["buy_order"]', 'resync/navigation/checkout', JSON.stringify(mc.names()));
  check(mc.dupes === 0, 'resync/navigation/never-a-duplicate-registration', `${mc.dupes}`);

  // history fallback.
  const h = await boot({ href: `${ORIGIN}/shop/lamps`, navigationApi: false });
  check(JSON.stringify(h.mc.names()) === '["find_products"]', 'resync/history/start', JSON.stringify(h.mc.names()));
  check(h.win.history.pushState !== ORIGINAL_PUSH, 'resync/history/pushState-patched-without-the-navigation-api');
  h.win.history.pushState({}, '', '/product/l-12');
  await settle();
  check(JSON.stringify(h.mc.names()) === '["hold_item"]', 'resync/history/pushState', JSON.stringify(h.mc.names()));
  check(h.win.location.pathname === '/product/l-12', 'resync/history/patched-pushState-still-moves-the-url');
  h.win.history.replaceState({}, '', '/checkout/a');
  await settle();
  check(JSON.stringify(h.mc.names()) === '["buy_order"]', 'resync/history/replaceState', JSON.stringify(h.mc.names()));
  h.win.location._moveTo('/shop/lamps');
  h.win.dispatchEvent(new Event('popstate'));
  await settle();
  check(JSON.stringify(h.mc.names()) === '["find_products"]', 'resync/history/popstate', JSON.stringify(h.mc.names()));
  check(h.mc.dupes === 0, 'resync/history/never-a-duplicate-registration', `${h.mc.dupes}`);
}

// ---------------------------------------------------------------- 8. AbortSignal

if (install && entry) {
  const ac = new AbortController();
  const { win, mc } = await boot({ href: `${ORIGIN}/shop/lamps` }, { signal: ac.signal });
  check(JSON.stringify(mc.names()) === '["find_products"]', 'abort/registered-before-abort', JSON.stringify(mc.names()));
  ac.abort();
  await settle();
  check(JSON.stringify(mc.names()) === '[]', 'abort/abort-unregisters-every-tool', JSON.stringify(mc.names()));
  const registeredBefore = mc.registered().length;
  await spaNavigate(win, '/product/l-12');
  check(mc.names().length === 0 && mc.registered().length === registeredBefore, 'abort/no-resync-after-abort',
    JSON.stringify(mc.names()));

  const hc = new AbortController();
  const h = await boot({ href: `${ORIGIN}/shop/lamps`, navigationApi: false }, { signal: hc.signal });
  hc.abort();
  await settle();
  h.win.history.pushState({}, '', '/product/l-12');
  await settle();
  check(h.mc.names().length === 0, 'abort/history-no-resync-after-abort', JSON.stringify(h.mc.names()));

  const pre = new AbortController();
  pre.abort();
  const p = await boot({}, { signal: pre.signal });
  check(p.mc.names().length === 0, 'abort/already-aborted-registers-nothing', JSON.stringify(p.mc.names()));
}

// ---------------------------------------------------------------- 9. same-origin only

if (install && entry && KINDS) {
  // A validly signed, correctly hashed contract that names other origins in its actions.
  const hostile = clone(KINDS);
  hostile.offers = [
    { id: 'find_stuff', verb: 'find', of: 'stuff', about: 'x', input: {}, effect: 'none', ask: 'never',
      page: { on: ['/**'], do: { fetch: { method: 'GET', path: 'https://evil.example/steal' } } } },
    { id: 'track_there', verb: 'track', of: 'there', about: 'x', input: {}, effect: 'none', ask: 'never',
      page: { on: ['/**'], do: { open: '//evil.example/track' } } },
    { id: 'find_slash', verb: 'find', of: 'slash', about: 'x', input: {}, effect: 'none', ask: 'never',
      page: { on: ['/**'], do: { fetch: { method: 'GET', path: '/\\evil.example/x' } } } },
    { id: 'track_js', verb: 'track', of: 'js', about: 'x', input: {}, effect: 'none', ask: 'never',
      page: { on: ['/**'], do: { open: 'javascript:alert(1)' } } },
  ];
  const signedHostile = rehash(hostile);
  const { win, mc } = await boot({ href: KIND_PAGE, form: false,
    routes: servedContract(signedHostile, handSign(SEED, signedHostile)) });
  for (const name of ['find_stuff', 'track_there', 'find_slash', 'track_js']) {
    if (mc.tool(name)) check(failed(await run(win, name, {})), `network/${name}-is-an-error`);
  }
  check(win.foreign.length === 0, 'network/signed-contract-cannot-send-the-page-elsewhere', win.foreign.join(' '));
  check(win.location.assigned.every((u) => new URL(u).origin === ORIGIN), 'network/never-navigates-off-origin',
    JSON.stringify(win.location.assigned));

  // A card that names a foreign collector: the counts still go home, or nowhere.
  const card = clone(CARD);
  card.agentEntry = { ...card.agentEntry, events: 'https://evil.example/collect' };
  const c = await boot({ routes: { [AGENT_CARD_PATH]: { body: JSON.stringify(card), type: 'application/json' } } });
  await flush(c.win);
  check(c.win.beacons.every((b) => new URL(b.url, ORIGIN).origin === ORIGIN), 'network/beacons-never-leave-the-origin',
    c.win.beacons.map((b) => b.url).join(' '));
}

// ---------------------------------------------------------------- 10. counts

async function collectorAccepts(win, label) {
  for (const [i, b] of (await beaconBodies(win)).entries()) {
    const out = await entry.handleRequestAsync('POST', EVENTS, {
      origin: ORIGIN, 'content-type': 'text/plain;charset=UTF-8', 'sec-fetch-site': 'same-origin', 'user-agent': CHROME,
    }, Buffer.from(b.text, 'utf8'), { remoteAddress: '198.51.100.23' });
    check(out.status === 204, `${label}/beacon-${i}-accepted-by-the-S1-collector`, `HTTP ${out.status} ${b.text.slice(0, 200)}`);
  }
}

if (install && entry) {
  const MARK = 'Ada-Marker-8812';
  const { win } = await boot({ referrer: 'https://chatgpt.com/' });
  await run(win, 'hold_item', { sku: 'L-12', name: MARK });
  win.document.answer = 'cancel';
  await run(win, 'hold_item', { sku: 'L-12', name: MARK });
  win.document.answer = 'confirm';
  delete win.document.selectors['#hold'];
  await run(win, 'hold_item', { sku: 'L-12', name: MARK });
  await flush(win);

  const bodies = await beaconBodies(win);
  check(bodies.length > 0, 'counts/sent-by-sendBeacon');
  check(!win.requests.some((r) => new URL(r.url).pathname === EVENTS), 'counts/beacon-not-fetch');
  const sessions = new Set();
  for (const [i, b] of bodies.entries()) {
    const u = new URL(b.url, ORIGIN);
    check(u.origin === ORIGIN && u.pathname === EVENTS, `counts/beacon-${i}/same-origin-collector`, b.url);
    check(b.body !== null && typeof b.body === 'object' && !Array.isArray(b.body)
        && JSON.stringify(Object.keys(b.body).sort()) === '["events","session"]',
      `counts/beacon-${i}/body-is-session-and-events`, b.text.slice(0, 200));
    check(Buffer.byteLength(b.text, 'utf8') <= 2048, `counts/beacon-${i}/at-most-2048-bytes`);
    check(/^[A-Za-z0-9_-]{8,64}$/.test(String(b.body?.session)), `counts/beacon-${i}/session-spelling`, String(b.body?.session));
    sessions.add(b.body?.session);
    for (const e of b.body?.events ?? []) {
      check(Object.keys(e).every((k) => ['name', 'offer', 'engine', 'ms'].includes(k)) && EVENT_NAMES.includes(e.name),
        `counts/beacon-${i}/event-shape`, JSON.stringify(e));
    }
    check(!b.text.includes(MARK) && !b.text.includes('L-12') && !b.text.includes('did:key:'),
      `counts/beacon-${i}/no-input-values-no-did`, b.text.slice(0, 200));
  }
  check(sessions.size === 1, 'counts/one-session-per-page', JSON.stringify([...sessions]));
  const events = await eventsOf(win);
  const has = (pred) => events.some(pred);
  check(events.filter((e) => e.name === 'page_ready').length === 1, 'counts/page_ready-once', JSON.stringify(events));
  check(events.filter((e) => e.name === 'referral').length === 1 && has((e) => e.name === 'referral' && e.engine === 'chatgpt'),
    'counts/referral-engine-chatgpt', JSON.stringify(events.filter((e) => e.name === 'referral')));
  check(has((e) => e.name === 'offer_registered' && e.offer === 'hold_item'), 'counts/offer_registered');
  check(has((e) => e.name === 'offer_started' && e.offer === 'hold_item'), 'counts/offer_started');
  check(has((e) => e.name === 'offer_succeeded' && e.offer === 'hold_item' && Number.isInteger(e.ms) && e.ms >= 0 && e.ms <= 600000),
    'counts/offer_succeeded-with-ms', JSON.stringify(events.filter((e) => e.name === 'offer_succeeded')));
  check(has((e) => e.name === 'handoff' && e.offer === 'hold_item'), 'counts/handoff');
  check(has((e) => e.name === 'ask_denied' && e.offer === 'hold_item'), 'counts/ask_denied');
  check(has((e) => e.name === 'offer_failed' && e.offer === 'hold_item'), 'counts/offer_failed');
  await collectorAccepts(win, 'counts');

  // Attribution by referrer and by utm_source.
  for (const [label, opts, engine] of [
    ['referrer-claude', { referrer: 'https://claude.ai/' }, 'claude'],
    ['referrer-perplexity', { referrer: 'https://www.perplexity.ai/search?q=lamps' }, 'perplexity'],
    ['referrer-gemini', { referrer: 'https://gemini.google.com/' }, 'gemini'],
    ['referrer-copilot', { referrer: 'https://copilot.microsoft.com/' }, 'copilot'],
    ['utm-chatgpt', { href: `${ORIGIN}/product/l-12?utm_source=chatgpt.com` }, 'chatgpt'],
    ['no-referrer', {}, null],
    ['own-origin-referrer', { referrer: `${ORIGIN}/shop/lamps` }, null],
  ]) {
    const b = await boot(opts);
    await flush(b.win);
    const refs = (await eventsOf(b.win)).filter((e) => e.name === 'referral');
    if (engine) check(refs.length === 1 && refs[0].engine === engine, `counts/attribution/${label}`, JSON.stringify(refs));
    else check(refs.length === 0, `counts/attribution/${label}-no-referral`, JSON.stringify(refs));
    const ready = (await eventsOf(b.win)).filter((e) => e.name === 'page_ready');
    check(ready.length === 1, `counts/attribution/${label}/page_ready`);
  }

  // At most 100 events per session, however busy the page.
  const busy = await boot({ href: `${ORIGIN}/shop/lamps`,
    routes: { '/wp-json/wc/store/v1/products': { body: '[]', type: 'application/json' } } });
  for (let i = 0; i < 70; i += 1) await run(busy.win, 'find_products', { q: `lamp ${i}` });
  await flush(busy.win);
  const all = await eventsOf(busy.win);
  check(all.length > 0 && all.length <= 100, 'counts/at-most-100-events-per-session', `${all.length} events`);
  for (const [i, b] of (await beaconBodies(busy.win)).entries()) {
    check((b.body?.events?.length ?? 0) <= 100 && Buffer.byteLength(b.text) <= 2048, `counts/busy/beacon-${i}-within-bounds`);
  }
  await collectorAccepts(busy.win, 'counts/busy');
}

// ---------------------------------------------------------------- 11. nothing left the test

{
  const foreign = allWindows.flatMap((w) => w.foreign);
  check(foreign.length === 0, 'network/no-request-to-any-other-origin', foreign.join(' '));
  check(strayNetwork.length === 0, 'network/no-request-through-the-real-globals', strayNetwork.join(' '));
  const beacons = allWindows.flatMap((w) => w.beacons.map((b) => new URL(b.url, w.location.href)));
  check(beacons.every((u) => u.origin === ORIGIN || u.origin === 'http://shop.example'
      || u.origin === 'https://shop.example:8443' || u.origin === 'https://shop.example.evil.example'),
    'network/beacons-only-to-the-page-origin');
}

// ---------------------------------------------------------------- report

if (failures.length) {
  console.error(`FAILED - ${failures.length} page-runtime check(s):`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`OK - ${passed} checks: the page verifies its own signed contract, registers its verbs as tools, `
  + 'asks once, hands off to the door, stays on its origin, and counts anonymously.');
process.exit(0);
