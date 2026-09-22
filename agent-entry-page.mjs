/**
 * Agent Entry page runtime (Suite S2): the page face of the door.
 *
 * A browser module with no dependencies, served from the site's own origin:
 *
 *     <script type="module" src="/agent-entry-page.mjs"></script>
 *
 * It fetches the site's card, its signed tool contract and the contract's envelope, all from
 * the page's own origin. It verifies the envelope with WebCrypto Ed25519 against the card's
 * did:key, checks that the contract names this origin and that its hash holds, and only then
 * registers each offer that has a `page` binding for this route on `document.modelContext`
 * (WebMCP). Anything that does not verify is refused whole: no tool, no count.
 *
 * Load it as `/agent-entry-page.mjs?manual` to stop it installing itself, then call
 * `install({ window, signal, handlers })` yourself. `handlers` holds the functions a `call`
 * action names; without one there, the function is looked up on `window`.
 *
 * Rules (spec/tools-v1.md AT-15 onwards):
 *   - same origin only: every request, navigation and count stays on `location.origin`;
 *   - one `<dialog>` per call for an offer whose compiled `ask` is `advised` or `always`, and
 *     the call goes ahead only on `returnValue === "confirm"`;
 *   - results of an offer with `then: "door"` carry `_meta.handoff` and the legacy `muretai` key;
 *   - counts are anonymous: event names, offer ids, an engine and a duration, never an input
 *     value or a DID.
 */

export const REFUSALS = Object.freeze(['contract_missing', 'sig_missing', 'sig_invalid', 'origin_mismatch',
  'hash_mismatch', 'card_mismatch']);

const CARD_PATH = '/.well-known/agent-card.json';
const TOOLS_PATH = '/.well-known/agent-tools.json';
const EVENTS_PATH = '/.well-known/agent-tools/events';
const ASKING = new Set(['advised', 'always']);
const MAX_EVENTS = 100;
const MAX_BEACON_BYTES = 2048;
const MAX_RESULT_CHARS = 50000;
const ENGINES = [
  ['chatgpt', ['chatgpt.com', 'chat.openai.com']],
  ['claude', ['claude.ai']],
  ['perplexity', ['perplexity.ai']],
  ['gemini', ['gemini.google.com']],
  ['copilot', ['copilot.microsoft.com']],
  ['grok', ['grok.com']],
  ['deepseek', ['chat.deepseek.com']],
  ['mistral', ['chat.mistral.ai']],
  ['you', ['you.com']],
];

class Refusal extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

// ---------------------------------------------------------------- bytes

/** Canonical JSON: keys sorted by code point, no whitespace (spec v1 section 4.3). */
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('not encodable');
    if (value === undefined) throw new TypeError('not encodable');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).sort(codePointCompare);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

function codePointCompare(a, b) {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** did:key:z + base58btc(0xed 0x01 || 32-byte Ed25519 key) -> the 32 key bytes, or null. */
function keyFromDid(did) {
  if (typeof did !== 'string' || !did.startsWith('did:key:z')) return null;
  let n = 0n;
  for (const ch of did.slice(9)) {
    const d = B58.indexOf(ch);
    if (d < 0) return null;
    n = n * 58n + BigInt(d);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) return null;
  return new Uint8Array(bytes.slice(2));
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function fromBase64(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) return null;
  const clean = s.replace(/=+$/, '');
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- routes and paths

/** `*` is one path segment, `**` any depth (including none). */
function routeMatches(pattern, pathname) {
  if (typeof pattern !== 'string' || !pattern.startsWith('/')) return false;
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '/' && pattern.startsWith('/**', i) && (i + 3 === pattern.length || pattern[i + 3] === '/')) {
      re += '(?:/.*)?';
      i += 2;
    } else if (ch === '*') {
      re += '[^/]*';
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`).test(pathname);
}

/** A path the page may use: one leading "/", printable ASCII, no backslash (AT-1). */
function sameOriginUrl(win, path) {
  if (typeof path !== 'string' || !/^\/(?![/\\])[\x21-\x7e]*$/.test(path) || path.includes('\\')) return null;
  const url = new win.URL(path, win.location.origin);
  return url.origin === win.location.origin ? url : null;
}

// ---------------------------------------------------------------- fetch and verify

async function getText(win, url) {
  let res;
  try {
    res = await win.fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-cache',
      headers: { accept: 'application/json' } });
  } catch {
    return null;
  }
  if (!res || res.status !== 200) return null;
  try { return await res.text(); } catch { return null; }
}

function parse(text) {
  if (typeof text !== 'string') return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

async function sha256hex(win, text) {
  return hex(await win.crypto.subtle.digest('SHA-256', new win.TextEncoder().encode(text)));
}

async function verifyContract(win) {
  const origin = win.location.origin;
  const cardUrl = `${origin}${CARD_PATH}`;

  const card = parse(await getText(win, cardUrl));
  if (!isObject(card)) throw new Refusal('card_mismatch');
  const publicKey = keyFromDid(card.did);
  if (!publicKey) throw new Refusal('card_mismatch');
  // The card must name a contract. It is only ever fetched from this origin: a card that names
  // another origin's contract gets this origin's, and the `origins` check below settles it.
  if (!isObject(card.agentEntry) || typeof card.agentEntry.tools !== 'string') throw new Refusal('card_mismatch');
  const toolsUrl = homeUrl(win, card.agentEntry.tools, TOOLS_PATH);
  if (!toolsUrl.pathname.endsWith('.json')) throw new Refusal('card_mismatch');
  const sigUrl = new win.URL(toolsUrl.pathname.replace(/\.json$/, '.sig.json'), origin);

  const [servedText, envText] = await Promise.all([getText(win, toolsUrl.href), getText(win, sigUrl.href)]);
  const served = parse(servedText);
  if (!isObject(served)) throw new Refusal('contract_missing');
  const env = parse(envText);
  if (!isObject(env)) throw new Refusal('sig_missing');
  if (env.v !== 1 || env.typ !== 'agenttools' || !isObject(env.contract) || !Number.isSafeInteger(env.ts)) {
    throw new Refusal('sig_invalid');
  }
  const sig = fromBase64(env.sig);
  if (!sig || sig.length !== 64) throw new Refusal('sig_invalid');

  let good = false;
  try {
    const signed = new win.TextEncoder().encode(canonicalJSON({ contract: env.contract, ts: env.ts, typ: 'agenttools', v: 1 }));
    const key = await win.crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    good = await win.crypto.subtle.verify({ name: 'Ed25519' }, key, sig, signed) === true;
  } catch {
    good = false;
  }
  if (!good) throw new Refusal('sig_invalid');

  const contract = env.contract;
  if (!Array.isArray(contract.origins) || !contract.origins.includes(origin)) throw new Refusal('origin_mismatch');

  const { hash, ...unhashed } = contract;
  let recomputed = null;
  try { recomputed = await sha256hex(win, canonicalJSON(unhashed)); } catch { recomputed = null; }
  if (typeof hash !== 'string' || recomputed !== hash) throw new Refusal('hash_mismatch');
  let same = false;
  try { same = canonicalJSON(served) === canonicalJSON(contract); } catch { same = false; }
  if (!same) throw new Refusal('hash_mismatch');
  if (!Array.isArray(contract.offers)) throw new Refusal('hash_mismatch');

  const eventsUrl = homeUrl(win, card.agentEntry.events, EVENTS_PATH);
  return { contract, did: card.did, cardUrl, eventsUrl: eventsUrl.href };
}

/** `value` when it is a URL on this origin, else `fallback` on this origin. Never elsewhere. */
function homeUrl(win, value, fallback) {
  const origin = win.location.origin;
  try {
    const url = new win.URL(String(value), origin);
    if (url.origin === origin && sameOriginUrl(win, url.pathname)) return new win.URL(url.pathname, origin);
  } catch { /* fall through */ }
  return new win.URL(fallback, origin);
}

// ---------------------------------------------------------------- counts

function sessionId(win) {
  const bytes = new Uint8Array(16);
  win.crypto.getRandomValues(bytes);
  return hex(bytes);
}

function engineOf(win) {
  const byHost = (host) => {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    for (const [engine, domains] of ENGINES) {
      if (domains.some((d) => h === d || h.endsWith(`.${d}`))) return engine;
    }
    return null;
  };
  let utm = null;
  try { utm = new win.URL(win.location.href).searchParams.get('utm_source'); } catch { utm = null; }
  if (utm) {
    const byUtm = byHost(utm) ?? ENGINES.find(([e]) => e === utm.toLowerCase())?.[0] ?? null;
    if (byUtm) return byUtm;
  }
  const ref = win.document?.referrer;
  if (!ref) return null;
  try {
    const url = new win.URL(ref);
    if (url.origin === win.location.origin) return null;
    return byHost(url.hostname);
  } catch {
    return null;
  }
}

function makeCounter(win, eventsUrl, offerIds) {
  const session = sessionId(win);
  const queue = [];
  let total = 0;

  const encoder = new win.TextEncoder();
  const encode = (events) => JSON.stringify({ session, events });
  const bytes = (events) => encoder.encode(encode(events)).length;
  const flush = () => {
    const send = win.navigator?.sendBeacon;
    if (typeof send !== 'function') { queue.length = 0; return; }
    while (queue.length) {
      const batch = [];
      while (queue.length && bytes([...batch, queue[0]]) <= MAX_BEACON_BYTES) batch.push(queue.shift());
      if (!batch.length) { queue.shift(); continue; }
      try { send.call(win.navigator, eventsUrl, encode(batch)); } catch { /* counts are best effort */ }
    }
  };
  const emit = (name, extra = {}) => {
    if (total >= MAX_EVENTS) return;
    if (extra.offer !== undefined && !offerIds.has(extra.offer)) return;
    total += 1;
    queue.push({ name, ...extra });
    if (bytes(queue) > MAX_BEACON_BYTES * 4) flush();
  };
  return { emit, flush };
}

// ---------------------------------------------------------------- tools

function inputSchema(input) {
  const properties = {};
  for (const [field, type] of Object.entries(input)) properties[field] = { type };
  return { type: 'object', properties, required: Object.keys(input), additionalProperties: false };
}

function annotations(offer, action) {
  return {
    readOnlyHint: offer.effect === 'none',
    destructiveHint: offer.effect === 'pays',
    idempotentHint: offer.effect === 'none' || offer.effect === 'reversible',
    untrustedContentHint: action === 'read',
  };
}

const TYPE_OK = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isSafeInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
};

/** Every declared field, of its declared type, and nothing else. Returns a clean copy. */
function checkInput(input, raw) {
  const value = raw === undefined || raw === null ? {} : raw;
  if (!isObject(value)) throw new Error('The input must be an object.');
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(input, key)) throw new Error(`Unknown field "${key.slice(0, 40)}".`);
  }
  const out = {};
  for (const [field, type] of Object.entries(input)) {
    if (!Object.hasOwn(value, field)) throw new Error(`Missing field "${field}".`);
    const ok = TYPE_OK[type];
    if (!ok || !ok(value[field])) throw new Error(`Field "${field}" must be ${type === 'integer' ? 'an' : 'a'} ${type}.`);
    out[field] = value[field];
  }
  return out;
}

function actionOf(offer) {
  const d = offer?.page?.do;
  if (!isObject(d)) return null;
  const keys = Object.keys(d);
  return keys.length === 1 ? keys[0] : null;
}

function textResult(text) {
  const s = String(text ?? '');
  const clipped = s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : s;
  return { content: [{ type: 'text', text: clipped }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: String(message) }], isError: true };
}

function fill(template, input) {
  return template.replace(/\{([^{}]*)\}/g, (_, key) => (Object.hasOwn(input, key)
    ? encodeURIComponent(String(input[key])) : ''));
}

/** Look up what an action needs before anyone is asked; throws when it is not there. */
function prepare(ctx, action, spec) {
  const { win, handlers } = ctx;
  if (action === 'read') {
    if (typeof spec !== 'string') throw new Error('This offer names no element.');
    const el = win.document.querySelector(spec);
    if (!el) throw new Error('The element this offer reads is not on this page.');
    return el;
  }
  if (action === 'fill') {
    const sel = spec?.form;
    const form = typeof sel === 'string' ? win.document.querySelector(sel) : null;
    if (!form) throw new Error('The form this offer fills is not on this page.');
    return form;
  }
  if (action === 'call') {
    const name = typeof spec === 'string' ? spec : '';
    const fn = handlers && Object.hasOwn(handlers, name) ? handlers[name]
      : /^[A-Za-z_$][\w$]*$/.test(name) ? win[name] : undefined;
    if (typeof fn !== 'function') throw new Error(`The function "${name.slice(0, 40)}" is not on this page.`);
    return fn;
  }
  if (action === 'fetch') {
    if (!isObject(spec) || (spec.method !== 'GET' && spec.method !== 'POST')) throw new Error('This offer names no request.');
    if (!sameOriginUrl(win, spec.path)) throw new Error('This offer names a request off this site; it was not sent.');
    return null;
  }
  if (action === 'open') {
    if (typeof spec !== 'string' || !sameOriginUrl(win, spec)) {
      throw new Error('This offer names a page off this site; it was not opened.');
    }
    return null;
  }
  throw new Error(`The page action "${String(action).slice(0, 20)}" is not supported by this runtime.`);
}

function controlsOf(form, input) {
  const controls = {};
  for (const field of Object.keys(input)) {
    const control = form.elements?.namedItem?.(field)
      ?? form.querySelector?.(`[name="${field.replace(/["\\]/g, '')}"]`) ?? null;
    if (!control) throw new Error(`The form has no field named "${field}".`);
    controls[field] = control;
  }
  return controls;
}

function setValue(win, control, value) {
  if (control.type === 'checkbox' || control.type === 'radio') {
    control.checked = Boolean(value);
  } else {
    // Frameworks watch the native setter; call it so they see the new value.
    const proto = Object.getPrototypeOf(control);
    const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(control, String(value)); else control.value = String(value);
  }
  for (const type of ['input', 'change']) {
    try { control.dispatchEvent(new win.Event(type, { bubbles: true })); } catch { /* best effort */ }
  }
}

async function perform(ctx, action, spec, target, input) {
  const { win } = ctx;
  if (action === 'read') {
    return textResult(target.innerText ?? target.textContent ?? '');
  }
  if (action === 'fill') {
    const controls = controlsOf(target, input);
    for (const [field, control] of Object.entries(controls)) setValue(win, control, input[field]);
    if (typeof target.requestSubmit === 'function') target.requestSubmit(); else target.submit();
    return textResult('The form was filled and sent.');
  }
  if (action === 'call') {
    const out = await target.call(win, { ...input });
    if (out === undefined) return textResult('Done.');
    return textResult(typeof out === 'string' ? out : JSON.stringify(out));
  }
  if (action === 'fetch') {
    const url = sameOriginUrl(win, spec.path);
    if (!url) throw new Error('This offer names a request off this site; it was not sent.');
    for (const [param, field] of Object.entries(isObject(spec.query) ? spec.query : {})) {
      if (Object.hasOwn(input, field)) url.searchParams.set(param, String(input[field]));
    }
    const init = { method: spec.method, credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (spec.method === 'POST') {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(input);
    }
    const res = await win.fetch(url.href, init);
    const body = await res.text();
    if (!res.ok) throw new Error(`The site answered HTTP ${res.status}.`);
    return textResult(body);
  }
  if (action === 'open') {
    const url = sameOriginUrl(win, fill(spec, input));
    if (!url) throw new Error('This offer names a page off this site; it was not opened.');
    win.location.assign(url.href);
    return textResult(`Opening ${url.pathname}${url.search}`);
  }
  throw new Error('Unsupported page action.');
}

// ---------------------------------------------------------------- ask

/** One `<dialog>` at a time, per window. */
const dialogQueues = new WeakMap();

function askPerson(win, offer, input, client) {
  const prior = dialogQueues.get(win) ?? Promise.resolve();
  const turn = prior.then(() => {
    const show = () => showDialog(win, offer, input);
    return typeof client?.requestUserInteraction === 'function' ? client.requestUserInteraction(show) : show();
  }).then((answer) => answer === true, () => false);
  dialogQueues.set(win, turn);
  return turn;
}

function showDialog(win, offer, input) {
  const doc = win.document;
  return new Promise((resolve) => {
    const make = (tag, text) => {
      const el = doc.createElement(tag);
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const dialog = make('dialog');
    dialog.setAttribute('aria-label', 'Confirm what the assistant asks');
    dialog.append(make('p', 'An assistant is asking to do this for you:'));
    dialog.append(make('p', offer.about));
    const fields = Object.entries(input);
    if (fields.length) {
      const list = make('ul');
      for (const [field, value] of fields) list.append(make('li', `${field}: ${String(value).slice(0, 200)}`));
      dialog.append(list);
    }
    const form = make('form');
    form.setAttribute('method', 'dialog');
    const cancel = make('button', 'Cancel');
    cancel.setAttribute('type', 'submit');
    cancel.setAttribute('value', 'cancel');
    cancel.value = 'cancel';
    const confirm = make('button', offer.effect === 'pays' ? 'Continue to pay' : 'Confirm');
    confirm.setAttribute('type', 'submit');
    confirm.setAttribute('value', 'confirm');
    confirm.value = 'confirm';
    form.append(cancel, confirm);
    dialog.append(form);

    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      try { dialog.remove(); } catch { /* already gone */ }
      resolve(answer);
    };
    dialog.addEventListener('close', () => finish(dialog.returnValue === 'confirm'), { once: true });
    (doc.body ?? doc.documentElement).append(dialog);
    try {
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.show();
    } catch {
      try { dialog.show(); } catch { finish(false); }
    }
  });
}

// ---------------------------------------------------------------- install

const installed = new WeakMap();

export async function install({ window: win = globalThis, signal, handlers } = {}) {
  if (signal?.aborted) return { ok: true, aborted: true, tools: [] };
  if (!win?.document || !win.location || typeof win.fetch !== 'function') {
    return { ok: true, tools: [], webmcp: false };
  }
  let verified;
  try {
    if (!win.crypto?.subtle) throw new Refusal('sig_invalid');
    verified = await verifyContract(win);
  } catch (e) {
    return { ok: false, reason: e instanceof Refusal ? e.reason : 'contract_missing' };
  }
  if (signal?.aborted) return { ok: true, aborted: true, tools: [] };

  installed.get(win)?.();
  const { contract, did, cardUrl, eventsUrl } = verified;
  const offers = contract.offers.filter((o) => isObject(o) && typeof o.id === 'string'
    && isObject(o.input) && typeof o.about === 'string' && actionOf(o) && Array.isArray(o.page?.on));
  const counts = makeCounter(win, eventsUrl, new Set(contract.offers.map((o) => o?.id)));
  const ctx = { win, handlers: isObject(handlers) || typeof handlers === 'function' ? handlers : null };
  const modelContext = win.document.modelContext ?? win.navigator?.modelContext ?? null;
  const live = new Map();
  const cleanups = [];
  let stopped = false;

  const handoff = () => ({
    _meta: { handoff: { v: 1, next: [{ kind: 'a2a', card: cardUrl }] } },
    muretai: { v: 1, action: 'dm', to: did, connect: cardUrl },
  });

  const makeTool = (offer) => {
    const action = actionOf(offer);
    const spec = offer.page.do[action];
    return {
      name: offer.id,
      description: offer.about,
      inputSchema: inputSchema(offer.input),
      annotations: annotations(offer, action),
      async execute(raw, client) {
        const started = Date.now();
        counts.emit('offer_started', { offer: offer.id });
        try {
          const input = checkInput(offer.input, raw);
          let target = prepare(ctx, action, spec);
          if (ASKING.has(offer.ask)) {
            if (!await askPerson(win, offer, input, client)) {
              counts.emit('ask_denied', { offer: offer.id });
              return errorResult('The person declined. Nothing was done.');
            }
            target = prepare(ctx, action, spec);
          }
          const result = await perform(ctx, action, spec, target, input);
          counts.emit('offer_succeeded', { offer: offer.id, ms: Math.min(600000, Math.max(0, Math.round(Date.now() - started))) });
          if (offer.then !== 'door') return result;
          counts.emit('handoff', { offer: offer.id });
          return { ...result, ...handoff() };
        } catch (e) {
          counts.emit('offer_failed', { offer: offer.id });
          return errorResult(e?.message || 'The action failed.');
        }
      },
    };
  };

  const sync = () => {
    if (stopped || !modelContext || typeof modelContext.registerTool !== 'function') return;
    const path = win.location.pathname;
    const want = new Set(offers.filter((o) => o.page.on.some((p) => routeMatches(p, path))).map((o) => o.id));
    for (const [id, entry] of live) {
      if (want.has(id)) continue;
      live.delete(id);
      entry.stop();
    }
    for (const offer of offers) {
      if (!want.has(offer.id) || live.has(offer.id)) continue;
      const ctl = new win.AbortController();
      let handle;
      try {
        handle = modelContext.registerTool(makeTool(offer), { signal: ctl.signal });
      } catch {
        continue;
      }
      live.set(offer.id, {
        stop() {
          ctl.abort();
          try { handle?.unregister?.(); } catch { /* the signal already did it */ }
        },
      });
      counts.emit('offer_registered', { offer: offer.id });
    }
  };

  const listen = (target, type, fn) => {
    if (typeof target?.addEventListener !== 'function') return;
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };

  if (win.navigation && typeof win.navigation.addEventListener === 'function') {
    listen(win.navigation, 'currententrychange', sync);
    listen(win.navigation, 'navigatesuccess', sync);
  } else if (win.history) {
    const h = win.history;
    for (const method of ['pushState', 'replaceState']) {
      const original = h[method];
      if (typeof original !== 'function') continue;
      const hadOwn = Object.hasOwn(h, method);
      const patched = function patchedHistory(...args) {
        const out = original.apply(this, args);
        sync();
        return out;
      };
      h[method] = patched;
      cleanups.push(() => {
        if (h[method] !== patched) return;
        if (hadOwn) h[method] = original; else delete h[method];
      });
    }
    listen(win, 'popstate', sync);
  }
  listen(win, 'pagehide', counts.flush);
  listen(win.document, 'visibilitychange', () => {
    if (win.document.visibilityState === 'hidden') counts.flush();
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const entry of live.values()) entry.stop();
    live.clear();
    for (const undo of cleanups.splice(0)) { try { undo(); } catch { /* best effort */ } }
    counts.flush();
    if (installed.get(win) === stop) installed.delete(win);
  };
  installed.set(win, stop);
  signal?.addEventListener?.('abort', stop, { once: true });

  counts.emit('page_ready');
  const engine = engineOf(win);
  if (engine) counts.emit('referral', { engine });
  sync();

  return { ok: true, version: contract.version, hash: contract.hash, tools: [...live.keys()], webmcp: Boolean(modelContext) };
}

// Installed by the page tag itself; `?manual` on the module URL leaves it to the site.
export const ready = typeof document !== 'undefined' && typeof window !== 'undefined'
  && !new URL(import.meta.url).searchParams.has('manual')
  ? install({ window }).catch(() => ({ ok: false, reason: 'contract_missing' }))
  : null;
