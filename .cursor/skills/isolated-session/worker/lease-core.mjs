// lease-core.mjs -- the landing lease's decision logic, as the Durable Object runs it.
//
// Pure: no Worker API, no clock, no storage of its own. The DO (worker.mjs) hands it a
// store adapter over its SQL storage and Date.now(); tests/landing_lease_do.test.mjs
// hands it an in-memory double. Everything a request can change goes through the store.
//
//   handle(store, { repo, envelope, now, allowlist, ttlS, rateLimit, rateWindowS,
//                   isAllowed, env }) -> { status, body }
//
// Why an epoch CAS: the Room-memory lease read the holder and wrote it back as two
// separate messages, so two machines could both read "free" and both win. Here the only
// write is casRow(repo, expectedEpoch, row), which lands only if the stored epoch is still
// the one this request read; a take that loses the race re-reads and is told who won.
//
// Why the DO holds no key: the grant is the HTTPS answer to the holder's own request, over
// TLS to an endpoint the holder configured, so it needs no signature of its own. The DO
// only VERIFIES, with WebCrypto (crypto.subtle, never node:crypto -- the same code runs in
// a Worker and under node --test), against the public key the requester's did:key carries.
//
// The order of the checks is the security argument, so it is fixed and stated:
//   1. shape (malformed), the repo this DO serves (repo-mismatch), the key type
//      (unsupported-key), the ts window (stale-ts): pure, touch nothing;
//   2. the signature (bad-signature): a forgery claiming a member's DID stops here, so it
//      can never spend that member's rate budget or burn its nonce;
//   3. membership (not-allowlisted), through the isAllowed seam, on every request: a
//      stranger stops here and leaves nothing in storage -- no row, nonce or hit;
//   4. sweep, then the per-DID rolling rate limit (rate-limited, 429 -- adds no hit);
//   5. the nonce (replayed-nonce): scoped per DID, remembered for REPLAY_TTL_S;
//   6. the hit is recorded, then the lease verb itself. A 409 (held / not-holder /
//      stale-epoch / expired) therefore counts toward the budget: it was real work for a
//      member.

export const DEFAULT_TTL_S = 900;
export const CLOCK_WINDOW_S = 300;       // agent/inbox.py CLOCK_WINDOW
export const REPLAY_TTL_S = 600;         // agent/inbox.py REPLAY_TTL: covers ts up to +300 s
export const DEFAULT_RATE_LIMIT = 60;
export const DEFAULT_RATE_WINDOW_S = 60;

const VERBS = new Set(['take', 'release', 'renew']);
const PAYLOAD_KEYS = new Set(['verb', 'repo', 'did', 'ts', 'nonce', 'epoch']);
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NONCE_RE = /^[\x21-\x7e]{8,128}$/;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// -- the membership seam ------------------------------------------------------------

// isAllowed(did, env, store) -> boolean. The ONE place membership is decided. The v1
// implementation reads the Worker secret LEASE_ALLOWLIST (a JSON array of DIDs, or DIDs
// separated by commas or whitespace). A data-held membership (a table in the DO's own
// storage, say) replaces this function and nothing else; handle() consults it on every
// request, so a removal takes effect on the member's very next request.
export async function isAllowed(did, env, store) {
  return parseAllowlist(env && env.LEASE_ALLOWLIST).includes(did);
}

export function parseAllowlist(raw) {
  if (Array.isArray(raw)) return raw.filter((d) => typeof d === 'string');
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const s = raw.trim();
  if (s.startsWith('[')) {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.filter((d) => typeof d === 'string') : [];
    } catch (e) {
      return [];
    }
  }
  return s.split(/[\s,]+/).filter(Boolean);
}

// -- helpers --------------------------------------------------------------------------

function refuse(status, reason, extra) {
  return { status, body: { ok: false, reason, ...(extra || {}) } };
}

function isoOf(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// The protocol's canonical JSON: sorted keys, no whitespace (Python's
// json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)).
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function b58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch === '1') out.unshift(0); else break; }
  return Uint8Array.from(out);
}

// The raw Ed25519 public key a did:key names, or null for any other key type.
export function ed25519FromDid(did) {
  if (typeof did !== 'string' || !did.startsWith('did:key:z')) return null;
  const bytes = b58decode(did.slice('did:key:z'.length));
  if (!bytes || bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) return null;
  return bytes.slice(2);
}

function b64decode(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch (e) {
    return null;
  }
}

async function verifies(pub, sig, message) {
  try {
    const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, new TextEncoder().encode(message));
  } catch (e) {
    return false;
  }
}

function shapeOf(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const p = envelope.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p) || typeof envelope.sig !== 'string') return null;
  for (const k of Object.keys(p)) if (!PAYLOAD_KEYS.has(k)) return null;   // a ttl is never honoured
  if (!VERBS.has(p.verb)) return null;
  if (typeof p.repo !== 'string' || !REPO_RE.test(p.repo)) return null;
  if (typeof p.did !== 'string' || !p.did || p.did.length > 256) return null;
  if (!Number.isSafeInteger(p.ts)) return null;
  if (typeof p.nonce !== 'string' || !NONCE_RE.test(p.nonce)) return null;
  if (p.verb === 'take') {
    if ('epoch' in p) return null;
  } else if (!Number.isSafeInteger(p.epoch) || p.epoch < 0) {
    return null;
  }
  return p;
}

// -- the lease verbs --------------------------------------------------------------------

function grant(row, extra) {
  return { status: 200, body: { ok: true, holder: row.holder, until: isoOf(row.until), epoch: row.epoch, ...(extra || {}) } };
}

async function take(store, repo, did, now, ttlMs) {
  // Bounded: every lost CAS means another request committed, so the next read decides.
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await store.getRow(repo);
    const live = !!(row && row.holder && row.until > now);
    if (live && row.holder !== did) {
      return refuse(409, 'held', { holder: row.holder, until: isoOf(row.until) });
    }
    if (live) {
      // a take by the live holder is a renew: same epoch, until extended
      const next = { repo, holder: did, until: now + ttlMs, epoch: row.epoch };
      if (await store.casRow(repo, row.epoch, next)) return grant(next);
      continue;
    }
    const expected = row ? row.epoch : 0;
    const next = { repo, holder: did, until: now + ttlMs, epoch: expected + 1 };
    if (await store.casRow(repo, expected, next)) {
      const superseded = row && row.holder ? { holder: row.holder, until: isoOf(row.until) } : null;
      return grant(next, superseded ? { superseded } : undefined);
    }
  }
  return refuse(409, 'held', {});
}

async function holderVerb(store, repo, did, epoch, now, ttlMs, verb) {
  const row = await store.getRow(repo);
  if (!row || row.holder !== did) return refuse(409, 'not-holder');
  if (row.epoch !== epoch) return refuse(409, 'stale-epoch');
  if (row.until <= now) return refuse(409, 'expired');
  const next = verb === 'release'
    ? { repo, holder: null, until: now, epoch: row.epoch }
    : { repo, holder: did, until: now + ttlMs, epoch: row.epoch };
  if (!(await store.casRow(repo, row.epoch, next))) return refuse(409, 'stale-epoch');
  return grant(next);
}

// -- the entry point ----------------------------------------------------------------------

export async function handle(store, options) {
  const o = options || {};
  const now = Number(o.now);
  const ttlMs = (Number.isFinite(o.ttlS) && o.ttlS > 0 ? o.ttlS : DEFAULT_TTL_S) * 1000;
  const rateLimit = Number.isFinite(o.rateLimit) && o.rateLimit > 0 ? o.rateLimit : DEFAULT_RATE_LIMIT;
  const windowMs = (Number.isFinite(o.rateWindowS) && o.rateWindowS > 0 ? o.rateWindowS : DEFAULT_RATE_WINDOW_S) * 1000;

  // 1. pure checks
  const p = shapeOf(o.envelope);
  if (!p) return refuse(400, 'malformed');
  if (p.repo !== o.repo) return refuse(400, 'repo-mismatch');
  const pub = ed25519FromDid(p.did);
  if (!pub) return refuse(400, 'unsupported-key');
  if (Math.abs(p.ts * 1000 - now) > CLOCK_WINDOW_S * 1000) return refuse(401, 'stale-ts');

  // 2. the signature, before anything is attributed to the DID it claims
  const sig = b64decode(o.envelope.sig);
  if (!sig || sig.length !== 64 || !(await verifies(pub, sig, canonical(p)))) {
    return refuse(401, 'bad-signature');
  }

  // 3. membership, on every request
  const member = typeof o.isAllowed === 'function'
    ? await o.isAllowed(p.did, o.env, store)
    : Array.isArray(o.allowlist) && o.allowlist.includes(p.did);
  if (!member) return refuse(403, 'not-allowlisted');

  // 4. eviction, then the rolling per-DID budget (a refusal names no other DID)
  await store.sweep(now);
  if ((await store.countHits(p.did, now - windowMs)) >= rateLimit) return refuse(429, 'rate-limited');

  // 5. the nonce, per DID
  if (!(await store.useNonce(p.did, p.nonce, now + REPLAY_TTL_S * 1000))) {
    return refuse(401, 'replayed-nonce');
  }

  // 6. the hit, then the verb
  await store.addHit(p.did, now, now + windowMs);
  if (p.verb === 'take') return take(store, o.repo, p.did, now, ttlMs);
  return holderVerb(store, o.repo, p.did, p.epoch, now, ttlMs, p.verb);
}
