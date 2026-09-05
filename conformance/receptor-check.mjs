#!/usr/bin/env node
/*
 * conformance/receptor-check.mjs — is a live URL a conformant Agent Entry?
 *
 * WHY THIS SHIPS BESIDE `run.mjs`. That file checks a LIBRARY against golden vectors: the
 * bytes this build signs, and the messages it must refuse. It cannot see a running door.
 * This one is pointed at a URL and answers the only question a site owner actually has —
 * "my install is deployed; does it obey the contract?" — over plain HTTP, so it judges a
 * door on any stack: this package, the PHP plugin, the serverless template, a hand-written
 * implementation nobody here has read.
 *
 * IT HAS A TWIN, AND THE TWO MUST AGREE ROW FOR ROW. `tools/receptor_check.py` in Muretai
 * core is this file in Python. For ONE door both tools emit the same rows in the same
 * order, each with the same `id`, label, level and outcome; they agree on the verdict and
 * the exit status, and their `--json` documents are comparable field for field. Two
 * implementations of one contract that disagree are worse than one, because a door
 * certified by one and refused by the other tells a site owner nothing. The harness is a
 * plain diff:
 *
 *     diff <(python3 tools/receptor_check.py --json URL) \
 *          <(node conformance/receptor-check.mjs --json URL)
 *
 * (after normalising the six values that genuinely cannot be identical — the clock in
 * `sig.fresh`'s detail, and the per-run random DIDs and ids; see NORMALISATION below).
 *
 * NEUTRALITY. This file imports NOTHING but `./muretai-agent-entry.mjs` and Node builtins.
 * No dependency, no vendored core, no network at import time. That constraint is the
 * reason several decisions in the Python twin were CHANGED rather than mirrored: it proves
 * a card the way any HTTP client can, and a check a neutral implementation cannot run is
 * not a conformance check.
 *
 * DECLARED EXEMPTIONS from the parity contract, and they are the only two:
 *   * `--help` / CLI-misuse TEXT. argparse's usage block is Python-shaped and reproducing
 *     it here would be cargo cult. Only the EXIT STATUS of those paths is pinned (0 for
 *     `--help`, 2 for misuse), and so is the bad-URL message, which both tools print to
 *     stderr with JSON quoting. argparse's flag ABBREVIATION (`--hand` for `--handshake`)
 *     is part of this exemption: this file accepts full flag names only.
 *   * URL-PARSER edge cases in the positional argument. WHATWG `new URL` punycodes IDN
 *     hosts, percent-encodes path characters and normalises `http:/host`; Python's
 *     `urlsplit` does none of that. The argument must be an ASCII, already-percent-encoded
 *     `http(s)://host[:port][/path]`. Inside one tool the divergence cancels — `cardScope`
 *     runs the dialled url and the card's url through the SAME parser — so it can only
 *     bite when the card spells a character one way and the operator spells it the other.
 *
 * ONE HELPER EXISTS THERE AND MUST NOT EXIST HERE. The Python twin carries `_collapse`,
 * which joins REPEATED response headers instead of keeping the last one, because
 * `email.message` is last-one-wins and a WordPress page emits its own
 * `Link: …rel="https://api.w.org/"` beside the entry's door signpost. Node's
 * `Headers.get()` already comma-joins repeated fields per the Fetch spec — which is
 * exactly the RFC 9110 §5.3 behaviour that helper restores — so there is nothing to
 * restore here. Both runtimes join with `', '`, which is why `methodSet()`'s comma split
 * works unchanged for both. This is a LANGUAGE difference, not a behaviour difference: do
 * not add a matching helper, and do not "fix" the Python one into a dict comprehension.
 *
 * WHAT IT CHECKS. Two tiers, because the tool is pointed at a stranger's production URL:
 *
 *   READ-ONLY (default) — sends no message, mints no account:
 *     * the plain card at /.well-known/agent-card.json (valid, names a DID)
 *     * the legacy alias /.well-known/agent.json is BYTE-IDENTICAL
 *     * the signed envelope at /.well-known/agent-card.sig.json verifies under the card's
 *       DID, carries an INTEGER `ts`, and is FRESH (<= CARD_SIG_MAX_AGE_S, 6h)
 *     * the SIGNED card's own `url` names the origin+path that was dialled, and that card
 *       advertises an open door
 *     * OPTIONS on the door and the card path answer 204 with an `Allow` that a
 *       per-resource CORS `Access-Control-Allow-Methods` AGREES with, `*` origin, and NO
 *       `Access-Control-Allow-Credentials` (the header that would turn `*` into a hole)
 *     * an unknown path is not a DOOR: no JSON-RPC answer to a POST there, and no 204 +
 *       `Allow` from OPTIONS (the preflight must not become a path oracle). Deliberately
 *       NOT "the origin 404s" — an entry hosted inside a site shares the origin with a
 *       site that owns its own routing and legitimately answers other paths its own way
 *     * (advisory) the notice route carries the `Link` door signpost
 *
 *   HANDSHAKE (--handshake) — sends signed messages, MAY create one account row:
 *     * a real signed message/send returns an INLINE reply that verifies under the door's
 *       DID, echoes the contextId, and stamps an integer timestamp
 *     * the attack battery every door must refuse: tampered text (-32001), wrong recipient
 *       (-32003), stale/future timestamp (-32002), replayed messageId (-32002), oversize
 *       text (-32005), missing signature (-32001), unparseable body (400), >1 MiB (413)
 *
 * The read-only tier is safe against any URL. The handshake tier writes to the door's
 * ledger and is the real acceptance gate for a new implementation; run it against a door
 * you own (or a throwaway install), not a stranger's.
 *
 * NORMALISATION, for anyone building the parity harness. Six values cannot be identical
 * and every one is bounded by construction rather than by hope: the clock (regex the
 * detail of row `sig.fresh` ONLY — `s/\bage -?\d+(\.\d+)?h\b/age <AGE>h/`), the per-run
 * random DID / messageId / contextId (`did:key:z…` -> `<did>`, then `receptor-dup-<32
 * hex>`, then bare 32-hex, IN THAT ORDER), and socket/DNS/TLS error wording — which never
 * reaches a diffed field at all, because `req()` folds every transport failure to status
 * `null` and `fmtStatus` spells that `no response`. Run the two tools sequentially with a
 * gap (never concurrently) when `--handshake` is used: the tier sends 12 POSTs and two
 * runs back to back is 24 against a door whose anonymous ceiling is 30/min. A `-32004` in
 * any detail means the parity run is VOID, not failed.
 *
 * ONE MORE VOID CONDITION, and it is a door's non-determinism rather than a twin's.
 * Against a door that answers the >1 MiB probe WITHOUT DRAINING the request body, the
 * connection can be reset while the 1 MiB is still going out; Python's urllib surfaces
 * that as no response and undici still reads the answer, so `refuse.body_too_large`'s
 * detail reads `got no response` there and `got 200` here. Measured, and it is a RACE, not
 * a rule — the same door gave both answers minutes apart, and a door that answers 413
 * without draining (the defensive shape) was stable in both. If exactly one run spells
 * that row `no response`, re-run: the parity run is VOID, not failed.
 *
 * USAGE
 *     node conformance/receptor-check.mjs https://shop.example
 *     node conformance/receptor-check.mjs https://shop.example/support   # path-mounted
 *     node conformance/receptor-check.mjs --handshake http://127.0.0.1:8788
 *     node conformance/receptor-check.mjs --json https://shop.example
 *
 * Exit status is 0 only when every hard check passed (advisories never fail the run), 1
 * when any row FAILed, and 2 for a bad URL or CLI misuse — so this gates a plugin's CI.
 */

import { Buffer } from 'node:buffer';
import process from 'node:process';

import {
  AGENT_CARD_PATH, AGENT_CARD_PATH_LEGACY, AGENT_CARD_SIG_PATH, AGENT_ENTRY_REL,
  CARD_SIG_REFRESH_S, didFromSeedHex, newId, newSeedHex, signEnvelope,
  verifyCardEnvelope, verifyEnvelopeSignature,
} from '../muretai-agent-entry.mjs';

/** How stale a VISITOR tolerates a card envelope: one full re-mint period
 *  (`CARD_SIG_REFRESH_S`, what the SERVING side does) of legitimate staleness, plus five
 *  more of slack for an unsynchronised clock on either side. The derivation is written out
 *  — rather than a bare `21600` — because these are two DIFFERENT quantities that both
 *  spell "an hour" in the neighbouring constant, and substituting the refresh period for
 *  the tolerance tightens the check 6x and fails honest doors. The Python twin, which can
 *  import neither, states the same derivation. */
const CARD_SIG_MAX_AGE_S = 6 * CARD_SIG_REFRESH_S;

/** The door's text ceiling — the number the CONTRACT names. Stated locally, exactly as the
 *  Python twin states it, because there it CANNOT be read from the product:
 *  `protocol.MAX_TEXT_BYTES` is overridden by `AGENTNET_MAX_TEXT_BYTES`, so an operator's
 *  environment would change the size of the oversize probe and the twins would send
 *  different bodies on one machine and the same on every other. */
const MAX_TEXT_BYTES = 64 * 1024;

/** Every request, both tiers. */
const TIMEOUT_MS = 15_000;

/** Sent on EVERY request by both twins. undici announces its own `user-agent` plus an
 *  `accept-encoding` nobody chose, urllib announces `Python-urllib/3.x` — and a WAF that
 *  behaves differently by User-Agent then hands the two tools different statuses for the
 *  same door. `identity` additionally guarantees both compare the same BYTES on the
 *  byte-identical row. */
const FIXED_HEADERS = {
  'User-Agent': 'agent-entry-check/1',
  Accept: '*/*',
  'Accept-Encoding': 'identity',
};

/** The `--json` document's contract version. Bumped only when the row schema or the
 *  top-level keys change, so a future contract change is DETECTED by a parity harness
 *  rather than silently mis-diffed. */
const SCHEMA_VERSION = 1;

// `ignoreBOM: true` is not "ignore a BOM" — it means "do not STRIP one", which is what the
// twins need. TextDecoder's default silently removes a leading U+FEFF, so a card served with
// EF BB BF parsed cleanly here while Python's `body.decode("utf-8")` kept the character and
// `json.loads` refused it: the same bytes, CONFORMANT on one twin and NOT CONFORMANT on the
// other. RFC 8259 §8.1 says an implementation MUST NOT add a BOM to JSON, so refusing is also
// the right answer — the twins now refuse together.
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// ---------------------------------------------------------------- shared formatters
//
// Four functions, same names and same output in both twins. Every value that reaches a
// diffed field goes through one of them, which is what keeps runtime-specific spellings
// (Python's `repr`, `type(x).__name__`, a JSON decoder's error message, a socket error's
// class name) out of the comparison BY CONSTRUCTION rather than by regex afterwards.

/** The decimal status, or `no response` when no status line arrived. NEVER the exception
 *  class or message: that is how socket/DNS/TLS wording — on which no two runtimes will
 *  ever agree — is kept out of every diffed field. */
function fmtStatus(status) {
  return status === null ? 'no response' : String(status);
}

/** JSON spelling of a SCALAR. Replaces every Python `!r`: repr uses single quotes, spells
 *  `None`/`True`, and escapes differently from every other language. Restricted to scalars
 *  by contract, so no object's key order or float rendering can leak in. */
function fmtJson(value) {
  return JSON.stringify(value === undefined ? null : value);
}

/** A method set as text, sorted, or `(absent)` when empty. Used for LABELS as well as
 *  details — a Python `sorted(...)` list repr in a label (`['GET', 'HEAD', 'OPTIONS']`)
 *  has no matching spelling here, and a label is the field that gets diffed. */
function fmtMethods(methods) {
  const ordered = [...methods].sort();
  return ordered.length ? ordered.join(', ') : '(absent)';
}

/** One of null / boolean / number / string / array / object. Replaces Python's
 *  `type(v).__name__`: `NoneType`, `int` and `float` are Python words, and int vs float is
 *  a distinction JSON does not even carry. */
function jsonType(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;            // 'boolean' | 'number' | 'string' | 'object'
}

/**
 * The SAFE-WHOLE-NUMBER rule, applied identically in both twins: a number, finite, with no
 * fractional part, inside ±(2**53 - 1). Returns `{ ok, value }`.
 *
 * Not `Number.isInteger` alone and, on the Python side, emphatically not
 * `isinstance(v, int)` — that pairing was the most consequential divergence between the
 * twins. `{"ts": 1756000000.0}` parses to a Python float (which `isinstance(v, int)`
 * refuses) and to a JS number for which `Number.isSafeInteger` is TRUE: the same document,
 * two LEVELS. The information the raw token carried (`.0` or not) is destroyed by every
 * JSON parser and no runtime can recover it, so the rule has to be one both can compute
 * from the PARSED value.
 */
function wholeNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, value: null };
  if (!Number.isInteger(value)) return { ok: false, value: null };
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) return { ok: false, value: null };
  return { ok: true, value };
}

/** `got a non-integer number` when it IS a number, else `got <jsonType>` — so a float and
 *  a string are diagnosed differently without naming a runtime's type. */
function numberDetail(value) {
  return jsonType(value) === 'number' ? 'got a non-integer number' : `got ${jsonType(value)}`;
}

// ---------------------------------------------------------------- result accumulation

/** PASS / FAIL / WARN / INFO, printed as we go and summarised at the end. Only FAIL sets
 *  the exit code; WARN is an advisory (a signpost missing, a soft-optional route), INFO is
 *  context. The verdict a human reads and the status a CI gate reads are the same object. */
class Report {
  constructor({ asJson }) {
    this.asJson = asJson;
    this.rows = [];
  }

  /** `id` FIRST, and always present. It is the PARITY KEY: diffing two tools on labels
   *  alone means any wording improvement silently renumbers the stream and the harness
   *  reports forty phantom failures. `failed`/`warned` stay LABELS so the summary has no
   *  third source of truth — it is derived from these rows. */
  add(id, level, label, detail = '') {
    this.rows.push({ id, level, label, detail });
    if (!this.asJson) {
      const mark = { PASS: 'ok', FAIL: 'FAIL', WARN: 'warn', INFO: '--' }[level];
      console.log(detail ? `${mark}: ${label}  (${detail})` : `${mark}: ${label}`);
    }
    return level !== 'FAIL';
  }

  /** A hard check. Passing prints ok; failing prints FAIL and taints the exit code. */
  check(id, cond, label, detail = '') {
    return this.add(id, cond ? 'PASS' : 'FAIL', label, cond ? '' : detail);
  }

  /** A soft check: a false result is an advisory, never a failure. */
  warn(id, cond, label, detail = '') {
    return this.add(id, cond ? 'PASS' : 'WARN', label, cond ? '' : detail);
  }

  info(id, label, detail = '') {
    this.add(id, 'INFO', label, detail);
  }

  get failed() {
    return this.rows.filter((r) => r.level === 'FAIL').map((r) => r.label);
  }

  get warned() {
    return this.rows.filter((r) => r.level === 'WARN').map((r) => r.label);
  }
}

// ---------------------------------------------------------------- raw HTTP helper

/**
 * One HTTP round trip, NO REDIRECTS FOLLOWED. Returns `{status, headers, body}` where
 * `status` is null and `headers` empty when no status line arrived (the failure mode a
 * door with an unhandled exception shows), so a single bad route cannot abort the run.
 *
 * `redirect: 'manual'` reports a 3xx AS the status it is, which is the more correct
 * posture for a conformance checker — the card path is normative — and it is also the only
 * way the twins can agree: urllib follows 301/302/303/307 but NOT 308 and converts a
 * redirected POST to GET, while `fetch` preserves the method on 307/308, so a followed
 * redirect means the two tools silently tested different requests. It also keeps the SSRF
 * surface of a tool pointed at stranger URLs closed.
 *
 * The exception is deliberately DISCARDED rather than reported: `UND_ERR_CONNECT_TIMEOUT`,
 * `ECONNREFUSED` and `CERTIFICATE_VERIFY_FAILED` have no Python spelling, and a value no
 * row reads is a value a future edit will start reading.
 */
/** The body, but only if the door answered the encoding we asked for.
 *
 *  Both twins send `Accept-Encoding: identity`. Measured on Node 26: `fetch` DECOMPRESSES a
 *  `Content-Encoding: gzip` response transparently anyway while KEEPING the header, where
 *  Python's urllib hands back the compressed bytes. So a door — or, far more likely, a CDN in
 *  front of one — that ignores the request header made this twin parse a card the Python twin
 *  could not read: the same door, two verdicts.
 *
 *  Neither behaviour is worth preserving. We asked for identity; a response that is not
 *  identity is not the one we asked for. Both twins drop it, so the rows below fail together
 *  and the door is told it ignored the header. The header survives decompression in both
 *  runtimes, which is what makes one rule expressible on both sides.
 */
function identityBody(headers, raw) {
  const enc = (headers.get('content-encoding') || '').trim().toLowerCase();
  if (enc && enc !== 'identity') return Buffer.alloc(0);
  return raw;
}

async function req(method, url, { body = null, headers = {} } = {}) {
  try {
    const res = await fetch(url, {
      method,
      body,
      headers: { ...FIXED_HEADERS, ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, headers: res.headers,
      body: identityBody(res.headers, Buffer.from(await res.arrayBuffer())) };
  } catch {
    return { status: null, headers: new Headers(), body: Buffer.alloc(0) };
  }
}

/** Split an `Allow:` / `Access-Control-Allow-Methods:` value into a method set, order- and
 *  whitespace-insensitively, so 'POST, OPTIONS' and 'OPTIONS,POST' compare equal. */
function methodSet(headerValue) {
  if (!headerValue) return new Set();
  return new Set(headerValue.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean));
}

function isSubset(small, big) {
  for (const v of small) if (!big.has(v)) return false;
  return true;
}

function sameSet(a, b) {
  return a.size === b.size && isSubset(a, b);
}

/**
 * The canonical ORIGIN **plus path prefix** a url addresses, or '' if it is not an http(s)
 * url at all. `https://h/alice/` and `https://H:443/alice` both give `https://h/alice`;
 * `https://h` and `https://h/` both give `https://h`.
 *
 * This is Muretai's `Outbox.card_scope` MINUS its `_same_machine` allowance, which lets a
 * peer advertise a LAN IP while you dial 127.0.0.1. A Muretai NODE needs that (its card
 * url comes from the host's outbound address, so without it `peer add` refuses a node
 * running on the operator's own machine); an AGENT ENTRY's card url is operator-configured
 * (`AGENT_ENTRY_BASE_URL`), so the same allowance has no honest case here — and a carve-out
 * that needs a machine's own interface list is one a neutral implementation could not
 * reproduce anyway. Both twins now fail identically and say "point the checker at the same
 * URL the card names".
 *
 * Empty on ANYTHING unparseable, and an empty scope on EITHER side is never a proof.
 */
function cardScope(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return '';
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return '';
  let host = parsed.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);   // ONE trailing dot: DNS-equal
  if (!host) return '';
  // `URL.port` is already '' for the scheme's default port, and `URL.hostname` already
  // keeps the brackets on an IPv6 literal — the two normalisations Python has to perform
  // by hand.
  const origin = parsed.port ? `${scheme}://${host}:${parsed.port}` : `${scheme}://${host}`;
  return origin + parsed.pathname.replace(/\/+$/, '');
}

/** Does this card advertise an open door? Read off the SIGNED card only. Every level is
 *  type-guarded: `card` is whatever JSON a stranger served, and a non-object section must
 *  answer "no", never throw. */
function openDoorFlag(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return false;
  for (const key of ['agentEntry', 'muretai']) {
    const section = card[key];
    if (section && typeof section === 'object' && !Array.isArray(section)
        && section.open_door) return true;
  }
  return false;
}

// ---------------------------------------------------------------- signed-message probes

/** A throwaway signer that touches no key store (seed generated in memory). The door will
 *  mint one ledger row for it on the first legitimate message; that is the cost of proving
 *  the POST ladder, and why the battery is opt-in. */
function ephemeralIdentity() {
  const seedHex = newSeedHex();
  return { seedHex, did: didFromSeedHex(seedHex) };
}

/**
 * A signed A2A message/send request, BUILT LITERALLY. `tamperText` rewrites the text AFTER
 * signing, so the envelope no longer matches — the door must reject it (-32001).
 *
 * The key order below is the one the Python twin's `protocol.rpc_request` +
 * `Message.to_a2a` shape produces, minus the fourteen null metadata keys `to_a2a` emits
 * (`vc`, `coordination`, `group`, `deal`, `held_vc*`, `keystate`, `binding`, …) which this
 * checker has no business inventing and no reason to send. Both twins build the minimal
 * envelope and serialise it compactly, so the two POST byte-identical bodies — the
 * strongest available form of "exactly the same".
 */
function signedRequest(sender, toDid, text, opts = {}) {
  const { messageId = null, contextId = null, timestamp = null, tamperText = null } = opts;
  const mid = messageId || newId();
  const ts = timestamp === null ? Math.floor(Date.now() / 1000) : timestamp;
  const sig = signEnvelope(sender.seedHex,
    { from: sender.did, to: toDid, messageId: mid, contextId, timestamp: ts, text });
  return {
    jsonrpc: '2.0',
    id: newId(),
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        role: 'user',
        parts: [{ kind: 'text', text: tamperText === null ? text : tamperText }],
        messageId: mid,
        contextId,
        metadata: { timestamp: ts, from: sender.did, to: toDid, sig },
      },
    },
  };
}

/** POST a JSON-RPC object (or raw bytes) to the door and parse the reply. Returns
 *  `{status, parsed}`. `JSON.stringify` is compact, which is why the Python twin abandoned
 *  `protocol.dumps` (whose default separators put a space after every `,` and `:`): the two
 *  would otherwise write different bytes for the same logical request, and at the 1 MiB
 *  boundary a few hundred bytes of separator whitespace is the difference between testing
 *  413 and not. */
async function postRpc(doorUrl, obj, raw = null) {
  const data = raw === null ? Buffer.from(JSON.stringify(obj), 'utf8') : raw;
  const res = await req('POST', doorUrl, { body: data,
    headers: { 'Content-Type': 'application/json' } });
  const txt = res.body.toString('utf8');
  try {
    return { status: res.status, parsed: txt ? JSON.parse(txt) : {} };
  } catch {
    return { status: res.status, parsed: { raw: txt } };
  }
}

function errCode(resp) {
  const e = resp && typeof resp === 'object' ? resp.error : null;
  return e && typeof e === 'object' && !Array.isArray(e) ? e.code ?? null : null;
}

/** JSON.parse over STRICT UTF-8 — `Buffer.toString('utf8')` substitutes U+FFFD for an
 *  invalid byte and would then parse on, where Python's `body.decode("utf-8")` raises.
 *  Returns `{ok, value}`; a non-object value is handed back as-is and guarded at the use
 *  site, exactly as the Python twin guards it. */
function parseJsonBody(body) {
  try {
    return { ok: true, value: JSON.parse(STRICT_UTF8.decode(body)) };
  } catch {
    return { ok: false, value: null };
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// ---------------------------------------------------------------- the checks

/** The non-invasive tier. Returns the DID the card NAMED (or null when the card could not
 *  even be read), which the handshake tier needs. */
async function readOnlyChecks(rawBase, rep) {
  const base = rawBase.replace(/\/+$/, '');
  const cardUrl = base + AGENT_CARD_PATH;
  const legacyUrl = base + AGENT_CARD_PATH_LEGACY;
  const sigUrl = base + AGENT_CARD_SIG_PATH;

  // -- the plain card exists and is a real A2A card
  const first = await req('GET', cardUrl);
  const location = first.headers.get('location');
  if (!rep.check('card.get', first.status === 200, `GET ${AGENT_CARD_PATH} -> 200`,
    `got ${fmtStatus(first.status)}`
    + (location ? `; Location ${fmtJson(location)} — re-run against that URL` : ''))) {
    return null;
  }
  const cardBody = first.body;
  const cardParsed = parseJsonBody(cardBody);
  if (!cardParsed.ok) {
    // The decoder's message is a runtime spelling (`Unexpected token < in JSON at position
    // 0` vs `Expecting value: line 1 column 1 (char 0)`); a byte count says the same thing
    // in one language.
    rep.check('card.json', false, 'the card is valid JSON',
      `the body is not JSON (${cardBody.length} bytes)`);
    return null;
  }
  const card = asObject(cardParsed.value);
  const did = card.did ?? null;
  rep.check('card.did', typeof did === 'string' && did.startsWith('did:key:'),
    'the card names a did:key', `got ${fmtJson(did)}`);

  // -- the legacy alias is BYTE-IDENTICAL (an additive path, never a fork)
  const legacy = await req('GET', legacyUrl);
  const sameBytes = Buffer.compare(legacy.body, cardBody) === 0;
  rep.check('card.legacy_identical', legacy.status === 200 && sameBytes,
    `the ${AGENT_CARD_PATH_LEGACY} alias is byte-identical to the card`,
    `legacy status ${fmtStatus(legacy.status)}, ${sameBytes ? 'same' : 'differs'} bytes`);

  // -- the signed envelope: valid, integer ts, verifies under the card's DID, fresh
  let verified = null;
  const sigRes = await req('GET', sigUrl);
  if (rep.check('sig.get', sigRes.status === 200, `GET ${AGENT_CARD_SIG_PATH} -> 200`,
    `got ${fmtStatus(sigRes.status)}`)) {
    const envParsed = parseJsonBody(sigRes.body);
    if (!envParsed.ok) {
      rep.check('sig.json', false, 'the signed envelope is valid JSON',
        `the body is not JSON (${sigRes.body.length} bytes)`);
    } else {
      const env = asObject(envParsed.value);
      const ts = env.ts ?? null;
      const whole = wholeNumber(ts);
      rep.check('sig.ts_integer', whole.ok,
        'the envelope `ts` is an integer (a non-Python verifier can read it)',
        numberDetail(ts));
      if (whole.ok) {
        // Verified against the INTEGER READING, which is the only reading this runtime
        // has. The card-envelope payload canonicalises `ts` AS RECEIVED, and Python
        // renders a float via `repr`, so a float-ts envelope verifies THERE and is
        // structurally unverifiable HERE; the twin was changed to read the integer too,
        // because calling such an envelope "verifies" lies to the site owner.
        verified = did ? verifyCardEnvelope({ ...env, ts: whole.value }, did) : null;
        rep.check('sig.verifies', verified !== null,
          "the signed card envelope verifies under the card's DID");
        const age = Date.now() / 1000 - whole.value;
        rep.check('sig.fresh', Math.abs(age) <= CARD_SIG_MAX_AGE_S,
          `the signed card is fresh (age <= ${Math.round(CARD_SIG_MAX_AGE_S / 3600)}h)`,
          `age ${(age / 3600).toFixed(1)}h — a live door re-signs hourly; a stale one is `
          + 'a static file that stopped being re-signed');
      } else {
        rep.check('sig.verifies', false,
          "the signed card envelope verifies under the card's DID",
          'the envelope ts is not an integer epoch, so its signed bytes cannot be '
          + 'reproduced outside Python');
      }
    }
  }

  // -- the SIGNED card names THIS origin and path, and the door is open.
  //
  // Both rows are read off the card `sig.verifies` proved, never off the plain one: an
  // unverified card is a statement by whoever holds the origin right now, and a claim
  // nobody signed proves nothing about the DID. This pair replaces the Python twin's old
  // `fetch_card_verified` call, which could be satisfied through a MURETAI RELAY — a proof
  // an Agent Entry conformance check must not be satisfiable by, and one this file could
  // not have reproduced without importing core.
  const noCard = 'the card envelope did not verify, so nothing it claims is proven';
  const mine = cardScope(base);
  const theirs = verified ? cardScope(verified.url) : '';
  rep.check('origin.url_binding', Boolean(mine) && Boolean(theirs) && mine === theirs,
    "the signed card's own url names the origin and path that were dialled",
    verified === null ? noCard
      : `the card says ${fmtJson(theirs)}; you dialled ${fmtJson(mine)} — point the `
        + 'checker at the same URL the card names');
  rep.check('origin.open_door', openDoorFlag(verified),
    'the card advertises an open door (agentEntry/muretai.open_door)',
    verified === null ? noCard : `got ${fmtJson(false)}`);

  // -- OPTIONS on the card path: 204, Allow says GET/HEAD/OPTIONS, CORS agrees, no creds
  await optionsChecks('options.card', cardUrl, new Set(['GET', 'HEAD', 'OPTIONS']),
    'the card path', rep);
  // -- OPTIONS on the door: 204, Allow includes POST+OPTIONS, CORS agrees, no creds
  await optionsChecks('options.door', `${base}/`, new Set(['POST', 'OPTIONS']),
    'the door', rep);

  // -- an unknown path must not be a DOOR.
  //
  // The check is deliberately not "the origin 404s". An entry that owns its whole origin
  // (a dedicated Node process) does 404 everything else, but an entry hosted INSIDE a
  // site — a CMS plugin, a framework route — shares the origin with a site that owns its
  // own routing and legitimately answers unknown paths its own way (WordPress on plain
  // permalinks serves the home page for any path at all). Demanding a 404 there judges the
  // SITE, not the door, and would fail every coexisting deployment.
  //
  // What must hold in BOTH shapes is that the ENTRY does not answer where it should not: a
  // POST to a non-door path must not produce a JSON-RPC entry answer (a door at an address
  // that was never published), and OPTIONS must not hand back the entry's own 204 +
  // `Allow`, which would turn the preflight into a path oracle.
  const unknown = `${base}/receptor-check-not-a-route-9z8y7x`;

  const unknownPost = await req('POST', unknown, {
    body: Buffer.from('{"jsonrpc":"2.0","id":1,"method":"message/send","params":{}}', 'utf8'),
    headers: { 'Content-Type': 'application/json' },
  });
  rep.check('unknown.post',
    !unknownPost.body.toString('latin1').toLowerCase().includes('jsonrpc'),
    'POST an unknown path is NOT answered by the entry',
    `status ${fmtStatus(unknownPost.status)} returned a JSON-RPC body — the door is `
    + 'answering an address that was never published');

  // The entry's OPTIONS answer for a resource it owns is a 204 carrying `Allow`. Either of
  // those on a path it does NOT own is the path oracle. The presence of CORS headers is
  // deliberately not the signal: both reference implementations keep the origin-wide CORS
  // default on their 404s too, so testing for it would fail a correct entry.
  const unknownOptions = await req('OPTIONS', unknown);
  rep.check('unknown.options',
    !(unknownOptions.status === 204 || unknownOptions.headers.has('allow')),
    'OPTIONS an unknown path is not answered by the entry (no path oracle)',
    `status ${fmtStatus(unknownOptions.status)}, `
    + `Allow: ${fmtJson(unknownOptions.headers.get('allow'))}`);

  // An INFO row's LABEL is one of a fixed set — the observed status lives in the detail,
  // because the label is the field the parity harness diffs.
  const unknownGet = await req('GET', unknown);
  if (unknownGet.status === 404) {
    rep.info('unknown.get', 'an unknown path 404s — this entry owns its whole origin',
      `GET -> ${fmtStatus(unknownGet.status)}`);
  } else {
    rep.info('unknown.get',
      'an unknown path is answered by the site — this entry is hosted inside a site that '
      + 'owns its own routing',
      `GET -> ${fmtStatus(unknownGet.status)}`);
  }

  // -- (advisory) the notice route carries the door signpost. A guest mount keeps the
  //    site's own front page (GET <mount> is 405), so its absence is not a failure.
  const notice = await req('GET', `${base}/`);
  const link = notice.headers.get('link') || '';
  if (notice.status === 200) {
    rep.warn('notice.link', link.includes(AGENT_ENTRY_REL),
      `the notice route carries the Link door signpost (rel=${AGENT_ENTRY_REL})`,
      `Link: ${link || '(absent)'}`);
  } else {
    rep.info('notice.link',
      'the mount does not serve a notice page (guest mount / site keeps its front page) — '
      + 'the Link signpost belongs on a page the site does serve',
      `GET / -> ${fmtStatus(notice.status)}`);
  }

  // The handshake tier runs whenever the card NAMED a DID, WHATEVER this tier concluded:
  // every refusal in the battery is worth measuring on a door whose card is stale or whose
  // CORS is wrong. Only a falsy DID produces `handshake.skipped`.
  return did;
}

/** OPTIONS must answer 204 with an `Allow` describing THIS resource, a CORS
 *  `Access-Control-Allow-Methods` that does not contradict it, `*` origin, and NO
 *  `Access-Control-Allow-Credentials`. */
async function optionsChecks(prefix, url, expectMethods, what, rep) {
  const res = await req('OPTIONS', url);
  rep.check(`${prefix}.status`, res.status === 204, `OPTIONS ${what} -> 204`,
    `got ${fmtStatus(res.status)}`);
  const allow = methodSet(res.headers.get('allow'));
  rep.check(`${prefix}.allow`, isSubset(expectMethods, allow),
    `OPTIONS ${what}: Allow lists ${fmtMethods(expectMethods)}`,
    `Allow: ${fmtMethods(allow)}`);
  const acam = methodSet(res.headers.get('access-control-allow-methods'));
  rep.check(`${prefix}.cors_methods`, sameSet(allow, acam),
    `OPTIONS ${what}: CORS Allow-Methods agrees with Allow`,
    `Allow=${fmtMethods(allow)} vs Allow-Methods=${fmtMethods(acam)}`);
  rep.check(`${prefix}.cors_origin`, res.headers.get('access-control-allow-origin') === '*',
    `OPTIONS ${what}: Access-Control-Allow-Origin is *`,
    `got ${fmtJson(res.headers.get('access-control-allow-origin'))}`);
  rep.check(`${prefix}.no_credentials`, !res.headers.has('access-control-allow-credentials'),
    `OPTIONS ${what}: no Access-Control-Allow-Credentials (would break the * origin)`,
    `got ${fmtJson(res.headers.get('access-control-allow-credentials'))}`);
}

/** The invasive tier: a real signed round trip, then every refusal the door owes. Sends
 *  messages; the door mints one ledger row for the one legitimate message. */
async function handshakeChecks(rawBase, doorDid, rep) {
  const base = rawBase.replace(/\/+$/, '');
  const door = `${base}/`;
  const prober = ephemeralIdentity();

  // -- a real signed message earns an inline reply that verifies under the door's DID
  const ctx = newId();
  const { parsed } = await postRpc(door,
    signedRequest(prober, doorDid, 'receptor-check: are you open?', { contextId: ctx }));
  const envelope = asObject(parsed);
  const res = envelope.result;
  const inlineDetail = 'result' in envelope
    ? '`result` is not an object'
    : `no result member; error code ${fmtJson(errCode(envelope))}`;
  if (rep.check('reply.inline', res !== null && typeof res === 'object' && !Array.isArray(res),
    'a signed message earns an inline reply', inlineDetail)) {
    // READ DIRECTLY. The Python twin used to build a `protocol.Message` from this object,
    // and that constructor RAISES on `kind !== 'message'` and on an empty messageId — so a
    // hostile or half-built door aborted the run with a traceback and the ten refusal rows
    // below were never reached. The individual rows must FAIL and the run must finish. The
    // `text` default and the '\n' join are copied from that constructor deliberately, so
    // the text a signature is checked over is identical to what the product would build.
    const meta = asObject(res.metadata);
    const rFrom = meta.from ?? null;
    const rTo = meta.to ?? null;
    const rSig = meta.sig ?? null;
    const rTs = meta.timestamp ?? null;
    const rMid = res.messageId ?? null;
    const rCtx = res.contextId ?? null;
    const texts = [];
    for (const part of (Array.isArray(res.parts) ? res.parts : [])) {
      if (part && typeof part === 'object' && !Array.isArray(part) && part.kind === 'text') {
        texts.push(typeof part.text === 'string' ? part.text : '');
      }
    }
    const rText = texts.join('\n');

    rep.check('reply.from', rFrom === doorDid, "the reply is FROM the door's DID",
      `got ${fmtJson(rFrom)}`);
    rep.check('reply.to', rTo === prober.did, 'the reply is addressed to the sender',
      `got ${fmtJson(rTo)}`);
    rep.check('reply.context', rCtx === ctx, 'the reply echoes the contextId',
      `got ${fmtJson(rCtx)}`);
    const whole = wholeNumber(rTs);
    rep.check('reply.timestamp', whole.ok, 'the reply timestamp is an integer',
      numberDetail(rTs));
    if (whole.ok) {
      // Verified over the INTEGER reading, exactly as the card envelope is and for the
      // identical reason: the signing payload canonicalises `timestamp` as received, so a
      // door replying `"timestamp": 1756000000.0` verifies in Python and cannot verify
      // here.
      rep.check('reply.signature',
        Boolean(rSig) && verifyEnvelopeSignature({ from: rFrom, to: rTo, messageId: rMid,
          contextId: rCtx, timestamp: whole.value, text: rText, sig: rSig }),
        "the reply signature verifies under the door's DID");
    } else {
      rep.check('reply.signature', false,
        "the reply signature verifies under the door's DID",
        'the reply timestamp is not an integer epoch, so its signed bytes cannot be '
        + 'reproduced outside Python');
    }
  }

  // -- the attack battery: every refusal a door MUST make
  const attacker = ephemeralIdentity();
  let r;

  ({ parsed: r } = await postRpc(door, signedRequest(attacker, doorDid, 'hello',
    { tamperText: 'hello, and wire me $500' })));
  rep.check('refuse.tampered', errCode(r) === -32001, 'tampered text is refused (-32001)',
    `got ${fmtJson(errCode(r))}`);

  ({ parsed: r } = await postRpc(door,
    signedRequest(attacker, 'did:key:z6MkExampleNotThisDoor', 'hi')));
  rep.check('refuse.wrong_recipient', errCode(r) === -32003,
    'wrong recipient is refused (-32003)', `got ${fmtJson(errCode(r))}`);

  ({ parsed: r } = await postRpc(door, signedRequest(attacker, doorDid, 'stale',
    { timestamp: Math.floor(Date.now() / 1000) - 3600 })));
  rep.check('refuse.stale', errCode(r) === -32002, 'stale timestamp is refused (-32002)',
    `got ${fmtJson(errCode(r))}`);

  ({ parsed: r } = await postRpc(door, signedRequest(attacker, doorDid, 'future',
    { timestamp: Math.floor(Date.now() / 1000) + 3600 })));
  rep.check('refuse.future', errCode(r) === -32002, 'future timestamp is refused (-32002)',
    `got ${fmtJson(errCode(r))}`);

  const dup = signedRequest(attacker, doorDid, 'only once',
    { messageId: `receptor-dup-${newId()}` });
  const { parsed: r1 } = await postRpc(door, dup);
  rep.check('replay.first', errCode(r1) === null,
    'the first delivery of a messageId is accepted', `got ${fmtJson(errCode(r1))}`);
  const { parsed: r2 } = await postRpc(door, dup);
  rep.check('replay.repeat', errCode(r2) === -32002,
    'a replayed messageId is refused (-32002)', `got ${fmtJson(errCode(r2))}`);

  const big = 'x'.repeat(MAX_TEXT_BYTES + 10);
  ({ parsed: r } = await postRpc(door, signedRequest(attacker, doorDid, big)));
  rep.check('refuse.oversize', errCode(r) === -32005, 'oversize text is refused (-32005)',
    `got ${fmtJson(errCode(r))}`);

  const unsigned = signedRequest(attacker, doorDid, 'no envelope');
  unsigned.params.message.metadata.sig = null;
  ({ parsed: r } = await postRpc(door, unsigned));
  rep.check('refuse.unsigned', errCode(r) === -32001,
    'a missing signature is refused (-32001)', `got ${fmtJson(errCode(r))}`);

  let st;
  ({ status: st } = await postRpc(door, null, Buffer.from('{not json at all', 'utf8')));
  rep.check('refuse.unparseable', st === 400, 'an unparseable body is HTTP 400',
    `got ${fmtStatus(st)}`);

  const oversized = Buffer.concat([
    Buffer.from('{"jsonrpc":"2.0","id":"x","method":"message/send","params":{"message":'
      + '{"kind":"message","parts":[{"kind":"text","text":"', 'utf8'),
    Buffer.alloc(1024 * 1024 + 64, 0x41),                              // 'A'
    Buffer.from('"}]}}}', 'utf8'),
  ]);
  ({ status: st } = await postRpc(door, null, oversized));
  rep.check('refuse.body_too_large', st === 413, 'a body over 1 MiB is HTTP 413',
    `got ${fmtStatus(st)}`);
}

// ---------------------------------------------------------------- entry point

const USAGE = `usage: receptor-check.mjs [-h] [--handshake] [--json] url

Check whether a live URL is a conformant Agent Entry door.

positional arguments:
  url          the door's base URL, e.g. https://shop.example or
               https://shop.example/support for a path-mounted entry

options:
  -h, --help   show this help message and exit
  --handshake  also send signed messages + the attack battery (WRITES to the
               door's ledger; run against a door you own)
  --json       machine-readable result`;

/** Flags are order-independent and may precede or follow the positional, exactly as
 *  argparse allows. Abbreviations are NOT accepted — see the declared exemptions at the
 *  top of this file; only the exit status of a help/usage path is part of the contract. */
function parseArgs(argv) {
  let url = null;
  let handshake = false;
  let json = false;
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') return { help: true };
    else if (arg === '--handshake') handshake = true;
    else if (arg === '--json') json = true;
    else if (arg.startsWith('-') && arg !== '-') return { usage: `unrecognized arguments: ${arg}` };
    else if (url === null) url = arg;
    else return { usage: `unrecognized arguments: ${arg}` };
  }
  if (url === null) return { usage: 'the following arguments are required: url' };
  return { url, handshake, json };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.usage) {
    console.error(USAGE);
    console.error(`receptor-check.mjs: error: ${args.usage}`);
    return 2;
  }

  // Mirrors the Python twin's `urlsplit` guard: an http(s) scheme and a non-empty
  // authority. Checked on the RAW string rather than through `new URL`, which would
  // silently accept `http:/host` and normalise it — a divergence that is cheap to remove
  // and expensive to explain.
  if (!/^https?:\/\/[^/?#]+/i.test(args.url)) {
    // JSON quoting, not Python's `!r`: repr uses single quotes and Python escape rules,
    // and JSON's is the one spelling both twins produce. It also keeps an empty or
    // whitespace-only argument visible.
    console.error(`error: not an absolute http(s) URL: ${fmtJson(args.url)}`);
    return 2;
  }

  const rep = new Report({ asJson: args.json });
  if (!args.json) {
    console.log(`Agent-ready check: ${args.url}${args.handshake ? '  [+handshake]' : ''}`);
    console.log('-'.repeat(60));
  }

  const doorDid = await readOnlyChecks(args.url, rep);
  if (args.handshake) {
    if (doorDid) {
      if (!args.json) console.log('-'.repeat(60));
      await handshakeChecks(args.url, doorDid, rep);
    } else {
      rep.check('handshake.skipped', false,
        'handshake skipped: the card/DID could not be verified above');
    }
  }

  const passed = rep.rows.filter((r) => r.level === 'PASS').length;
  const failed = rep.failed;
  const verdict = failed.length ? 'NOT CONFORMANT' : 'CONFORMANT';
  if (args.json) {
    // Key order is the contract's insertion order, and `JSON.stringify(doc, null, 2)`
    // matches Python's `json.dumps(doc, indent=2, ensure_ascii=False)` byte for byte — the
    // twin passes `ensure_ascii=False` for exactly this reason, since several details
    // carry an em dash and the default would ship `—` where this ships the literal.
    console.log(JSON.stringify({
      schema: SCHEMA_VERSION,
      url: args.url,
      handshake: args.handshake,
      verdict,
      passed,
      failed,
      warnings: rep.warned,
      rows: rep.rows,
    }, null, 2));
  } else {
    console.log('-'.repeat(60));
    console.log(`${verdict}: ${passed} passed, ${failed.length} failed, `
      + `${rep.warned.length} advisory`);
    if (failed.length) console.log(`  failed: ${failed.join('; ')}`);
  }
  return failed.length ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
