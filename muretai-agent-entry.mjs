/**
 * web/agent-entry/muretai-agent-entry.mjs
 * THE AGENT ENTRY — one dependency-free Node file that makes a website agent-reachable.
 *
 * Why this exists:
 *   Muretai's adoption bottleneck is that BOTH ends had to run a node. A site does not want
 *   a daemon, a key store or an inbox loop; it wants an endpoint. This module is that half:
 *   drop it on an origin you already have, and a visiting agent can (1) verify from your
 *   Agent Card that this DID really owns this origin, (2) POST a signed A2A message, and
 *   (3) get YOUR signed reply back in the same HTTP response. First contact IS account
 *   creation — there is no signup form, because the sender's did:key already is the account.
 *
 * Zero dependencies, forever: `node:crypto`, `node:http`, `node:buffer` only. No npm, no
 * build step, no transpiler. Node 20+ (native ed25519 / x25519 / hkdfSync / chacha20-poly1305).
 *
 * THE BYTES ARE THE CONTRACT. Every signed payload here must be byte-identical to what
 * Python's `shared/crypto.canonical` produces, or the signature is unverifiable and the only
 * diagnostic anyone gets is "signature verification failed". The pinned bytes live in
 * `testdata/wire_vectors.json`; `test_agent_entry_contract.py` Part 3 re-derives all of them
 * through this file. If you change anything under CANONICAL JSON, run that suite first.
 *
 *   import { createAgentEntry } from './muretai-agent-entry.mjs';
 *   createAgentEntry({ seedHex, name: 'Example Studio', baseUrl: 'https://studio.example',
 *                    responder: (env) => `You said: ${env.text}` }).listen(8788);
 *
 * See examples/agent_entry_server.mjs for the ~50-line file a site actually copies.
 */

import {
  createHash, createPrivateKey, createPublicKey, createCipheriv, createDecipheriv,
  diffieHellman, hkdfSync, randomBytes, sign as nodeSign, verify as nodeVerify,
} from 'node:crypto';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------- protocol constants

export const PROTOCOL_VERSION = '0.2';
/** `text` ceiling in UTF-8 BYTES (shared/protocol.MAX_TEXT_BYTES). Bytes, not characters:
 *  a limit in characters is not a limit on what anyone has to store. */
export const MAX_TEXT_BYTES = 64 * 1024;
/** HTTP body ceiling. Anything larger is refused with 413 BEFORE the JSON parser sees it. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Accepted clock skew, seconds, either direction (agent/inbox.CLOCK_WINDOW). */
export const CLOCK_WINDOW_S = 300;
/** How long a messageId is remembered for replay refusal, seconds. */
export const REPLAY_TTL_S = 600;
/** The signed card envelope is re-minted at most this often (Inbox.CARD_SIG_REFRESH). */
export const CARD_SIG_REFRESH_S = 3600;
/** Signed replies per minute the ANONYMOUS lane may cost this agent entry, in total.
 *  Unauthenticated, so without a bound it is a signing oracle: a stranger spends an Ed25519
 *  signature (and a backend call) per request forever and nothing can attribute the cost.
 *  Per-ENTRY, not per-IP — behind a proxy the source address is whatever the last hop
 *  wrote. Must match `ANON_RATE_PER_MIN` in examples/agent_entry_reference.py: one contract,
 *  two implementations, one bound. */
export const ANON_RATE_PER_MIN = 30;

export const AGENT_CARD_PATH = '/.well-known/agent-card.json';
export const AGENT_CARD_PATH_LEGACY = '/.well-known/agent.json';
export const AGENT_CARD_SIG_PATH = '/.well-known/agent-card.sig.json';

const CARD_ENVELOPE_VERSION = 1;
const CARD_ENVELOPE_TYPE = 'agentcard';

/** JSON-RPC + Muretai L2 error objects, message strings included — a client greps these. */
export const ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
  UNAUTHENTICATED: { code: -32001, message: 'Signature verification failed' },
  REPLAY_REJECTED: { code: -32002, message: 'Replay or stale message' },
  WRONG_RECIPIENT: { code: -32003, message: 'Message not addressed to me' },
  RATE_LIMITED: { code: -32004, message: 'Rate limited' },
  MESSAGE_TOO_LARGE: { code: -32005, message: 'Message text too large' },
};

// ================================================================ CANONICAL JSON
//
// Reproduces, byte for byte:
//   json.dumps(obj, sort_keys=True, separators=(",",":"), ensure_ascii=False,
//              allow_nan=False).encode("utf-8")
//
// The four traps, each pinned by a case in testdata/wire_vectors.json:
//   1. KEY ORDER is by UNICODE CODE POINT. JavaScript's default string sort compares
//      UTF-16 code UNITS, which disagrees for astral characters (U+1F600 sorts BEFORE
//      U+FFFD by unit, AFTER it by code point). `codePointCompare` below is deliberate.
//   2. NON-ASCII STAYS LITERAL (ensure_ascii=False). JSON.stringify already does this,
//      but most hand-rolled canonicalizers \u-escape and are then wrong for every
//      Japanese message on the network.
//   3. Python's ESCAPE SET is exactly: the seven shorthands (" \ \b \f \n \r \t), every
//      other control char < 0x20 as lowercase \u00xx — and NOTHING else. `/` and DEL
//      (0x7F) are NOT escaped. Many JSON writers escape both; that is a silent break.
//   4. NUMBERS. Only integers inside +/-(2**53-1) and ordinary fractional floats are
//      emitted; anything whose rendering differs between Python and JavaScript THROWS
//      rather than producing bytes only Python can verify (see numberHazards in the
//      vectors: 1.0, -0.0, 1e-07, 1e+16, 2**53+1 …).

const ESCAPES = new Map([
  ['"', '\\"'], ['\\', '\\\\'], ['\b', '\\b'], ['\f', '\\f'],
  ['\n', '\\n'], ['\r', '\\r'], ['\t', '\\t'],
]);
// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /[\u0000-\u001f"\\]/;

function encodeString(s) {
  if (!NEEDS_ESCAPE.test(s)) return `"${s}"`;
  let out = '"';
  for (const ch of s) {                       // iterates by CODE POINT, not code unit
    const shorthand = ESCAPES.get(ch);
    if (shorthand !== undefined) { out += shorthand; continue; }
    const cp = ch.codePointAt(0);
    if (cp < 0x20) out += `\\u${cp.toString(16).padStart(4, '0')}`;   // lowercase hex
    else out += ch;                            // '/' and DEL included: NOT escaped
  }
  return out + '"';
}

function encodeNumber(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    // allow_nan=False. NaN/Infinity are not JSON (RFC 8259) and no two languages agree
    // on a spelling — refuse to sign them rather than emit a token nobody can check.
    throw new TypeError(`canonicalJSON: non-finite number (${n})`);
  }
  if (Number.isInteger(n)) {
    if (!Number.isSafeInteger(n)) {
      // Not a formatting mismatch — SILENT DATA CORRUPTION. Python has arbitrary
      // precision; a JS Number rounds. Signed integers stay inside +/-(2**53-1).
      throw new RangeError(`canonicalJSON: integer outside +/-(2**53-1) (${n})`);
    }
    return String(n);                          // -0 renders "0", same as Python's int 0
  }
  const rendered = String(n);
  if (rendered.includes('e') || rendered.includes('E')) {
    // Python zero-pads and always signs the exponent (1e-07); JS writes 1e-7. And the
    // thresholds at which each switches to exponent notation differ (Python 1e16, JS 1e21).
    throw new RangeError(`canonicalJSON: float needs exponent notation (${rendered}) — `
      + 'Python and JavaScript spell it differently; use an integer');
  }
  if (Math.abs(n) < 1e-4) {
    // Python's repr switches to exponent below 1e-4 while JS still writes decimals.
    throw new RangeError(`canonicalJSON: float too small to render identically (${rendered})`);
  }
  return rendered;
}

/** Compare two strings by UNICODE CODE POINT (Python's `str` order), not UTF-16 unit. */
function codePointCompare(a, b) {
  if (a === b) return 0;
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i), cb = b.codePointAt(j);
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i >= a.length && j < b.length) return -1;   // a is a prefix of b
  if (j >= b.length && i < a.length) return 1;
  return 0;
}

function encodeValue(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return encodeString(v);
    case 'number': return encodeNumber(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'bigint':
      // A BigInt would render exactly, but it can also exceed 2**53-1 silently on the
      // way back in through JSON.parse. Refuse, like every other unrenderable number.
      throw new TypeError('canonicalJSON: BigInt is not representable on this wire');
    case 'object': break;
    default:
      throw new TypeError(`canonicalJSON: cannot encode ${typeof v}`);
  }
  if (Array.isArray(v)) return `[${v.map(encodeValue).join(',')}]`;
  const keys = Object.keys(v).sort(codePointCompare);
  const parts = [];
  for (const k of keys) {
    const val = v[k];
    if (val === undefined) {
      // Python has no `undefined`: a key whose value is undefined would silently vanish
      // from JSON.stringify and change the signed bytes. Say so instead.
      throw new TypeError(`canonicalJSON: key ${JSON.stringify(k)} is undefined`);
    }
    parts.push(`${encodeString(k)}:${encodeValue(val)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Canonical JSON STRING (UTF-8 when encoded) for `value`. Throws on anything whose
 *  bytes would differ from Python's. */
export function canonicalJSON(value) {
  return encodeValue(value);
}

/** Canonical JSON as a UTF-8 Buffer — the bytes that actually get signed. */
export function canonicalBytes(value) {
  const s = canonicalJSON(value);
  assertEncodable(s);
  return Buffer.from(s, 'utf8');
}

/** Refuse lone surrogates. Python's `.encode("utf-8")` RAISES on them; Node silently
 *  substitutes U+FFFD, which would sign different bytes than the sender believes. */
function assertEncodable(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('lone surrogate in payload');
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new TypeError('lone surrogate in payload');
    }
  }
}

// ================================================================ Ed25519 (node:crypto)
//
// Node wants DER, not raw bytes. These two prefixes are the whole trick:
//   PKCS#8 private = 302e020100300506032b657004220420 || <32-byte seed>
//   SPKI    public = 302a300506032b6570032100        || <32-byte public key>
// (0x2b6570 is OID 1.3.101.112 = Ed25519; 0x2b656e is 1.3.101.110 = X25519.)

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function seedBuffer(seedHex) {
  if (typeof seedHex !== 'string') throw new TypeError('seed must be a 64-char hex string');
  const seed = Buffer.from(seedHex.trim(), 'hex');
  if (seed.length !== 32) throw new TypeError('seed must be 32 bytes (64 hex chars)');
  return seed;
}

function ed25519PrivateKey(seedHex) {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seedBuffer(seedHex)]),
    format: 'der', type: 'pkcs8',
  });
}

function ed25519PublicKey(publicRaw) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicRaw]),
    format: 'der', type: 'spki',
  });
}

/** Raw 32-byte Ed25519 public key for a seed. */
export function publicKeyFromSeedHex(seedHex) {
  const pub = createPublicKey(ed25519PrivateKey(seedHex));
  return pub.export({ format: 'der', type: 'spki' }).subarray(ED25519_SPKI_PREFIX.length);
}

/** Raw Ed25519 signature over `message` (Buffer|string), as a Buffer. */
export function signBytes(seedHex, message) {
  const m = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8');
  return nodeSign(null, m, ed25519PrivateKey(seedHex));
}

/** Verify a raw Ed25519 signature. Never throws — bad key/sig bytes answer false. */
export function verifyBytes(publicRaw, signature, message) {
  try {
    if (!Buffer.isBuffer(publicRaw) || publicRaw.length !== 32) return false;
    if (!Buffer.isBuffer(signature) || signature.length !== 64) return false;
    const m = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8');
    return nodeVerify(null, m, ed25519PublicKey(publicRaw), signature);
  } catch {
    return false;
  }
}

/** A fresh 32-byte identity seed as hex. THIS IS THE PRIVATE KEY — never log or ship it. */
export function newSeedHex() {
  return randomBytes(32).toString('hex');
}

/** A fresh message/correlation id (same shape as Python's uuid4().hex). */
export function newId() {
  return randomBytes(16).toString('hex');
}

// ================================================================ base58btc + did:key

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = new Map([...B58].map((c, i) => [c, BigInt(i)]));
/** Every legitimate base58 here (a DID is ~48 chars) is far under this. The cap guards the
 *  O(n^2) bignum loop from an attacker-chosen `from` field — the decoder runs BEFORE any
 *  signature check, so an unbounded input is free CPU exhaustion (shared/crypto:184). */
const MAX_B58_LEN = 512;
const MULTICODEC_ED25519 = Buffer.from([0xed, 0x01]);

function b58encode(data) {
  let n = 0n;
  for (const b of data) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    const r = n % 58n;
    n /= 58n;
    out = B58[Number(r)] + out;
  }
  let pad = 0;
  for (const b of data) { if (b === 0) pad++; else break; }
  return '1'.repeat(pad) + out;
}

function b58decode(s) {
  if (typeof s !== 'string') throw new TypeError('base58: not a string');
  if (s.length > MAX_B58_LEN) throw new RangeError('base58 input too long');
  let n = 0n;
  for (const ch of s) {
    const v = B58_INDEX.get(ch);
    if (v === undefined) throw new TypeError(`base58: bad character ${JSON.stringify(ch)}`);
    n = n * 58n + v;
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const raw = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let pad = 0;
  for (const ch of s) { if (ch === '1') pad++; else break; }
  return Buffer.concat([Buffer.alloc(pad), raw]);
}

/** 32-byte Ed25519 public key (hex or Buffer) -> `did:key:z…`. */
export function didFromPublicKeyHex(publicHex) {
  const pub = Buffer.isBuffer(publicHex) ? publicHex : Buffer.from(publicHex, 'hex');
  if (pub.length !== 32) throw new TypeError('an ed25519 public key is 32 bytes');
  return 'did:key:z' + b58encode(Buffer.concat([MULTICODEC_ED25519, pub]));
}

/** `did:key:z…` -> 32-byte Ed25519 public key, hex. Enforces the 0xed01 multicodec and the
 *  34-byte total: with did:key the DID IS the key, so this is the whole "key lookup". */
export function publicKeyHexFromDid(did) {
  return publicKeyFromDid(did).toString('hex');
}

function publicKeyFromDid(did) {
  if (typeof did !== 'string' || !did.startsWith('did:key:z')) {
    throw new TypeError(`unsupported DID method: ${String(did).slice(0, 32)}`);
  }
  const raw = b58decode(did.slice('did:key:z'.length));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) {
    throw new TypeError('not an ed25519 did:key');
  }
  return raw.subarray(2);
}

/** The did:key a seed controls. */
export function didFromSeedHex(seedHex) {
  return didFromPublicKeyHex(publicKeyFromSeedHex(seedHex));
}

// ================================================================ the signing envelope

/** The SIX frozen signed fields, canonicalized (shared/crypto.signing_payload). Nothing
 *  else is signed: `replyTo`, `auto`, `group`, `vc` … all ride as UNSIGNED metadata.
 *  `timestamp` is passed through AS GIVEN — never coerced, because the type on the wire
 *  IS the type in the signed bytes (send ints; verify whatever arrived). */
export function signingPayload(fields) {
  return canonicalJSON({
    contextId: fields.contextId ?? null,
    from: fields.from,
    messageId: fields.messageId,
    text: fields.text,
    timestamp: fields.timestamp,
    to: fields.to,
  });
}

/** base64 (standard alphabet, WITH padding) of the Ed25519 signature over the six fields. */
export function signEnvelope(seedHex, fields) {
  if (!seedHex) throw new TypeError('signEnvelope: no seed (this agent entry cannot sign)');
  const payload = signingPayload(fields);
  assertEncodable(payload);
  return signBytes(seedHex, Buffer.from(payload, 'utf8')).toString('base64');
}

/** Question 1 ONLY: does `sig` verify under the key DERIVED FROM `from`, over the six
 *  fields? Total and fail-closed — a malformed DID, bad base64, unrenderable number or
 *  short signature all answer false rather than throwing. */
export function verifyEnvelopeSignature(fields) {
  try {
    if (!fields || typeof fields !== 'object') return false;
    // `from` (the key) and `sig` must be there; `to` may be the EMPTY STRING — that is how
    // an anonymous-lane reply is addressed ("signed by me, to nobody in particular"), and
    // refusing it here would make core's own walk-in answer read as unsigned.
    if (!fields.from || !fields.sig || typeof fields.to !== 'string') return false;
    const payload = signingPayload(fields);
    assertEncodable(payload);
    const sig = Buffer.from(String(fields.sig), 'base64');
    if (sig.length !== 64) return false;
    return verifyBytes(publicKeyFromDid(fields.from), sig, Buffer.from(payload, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Is this envelope an authentic statement ADDRESSED TO ME? Two questions, not one:
 *
 *   1. does `sig` verify under the key derived FROM `from`? With did:key the DID IS the
 *      key, so `from` is never taken as a label — that mistake is how a client ends up
 *      accepting a valid signature by a DIFFERENT identity than the one it displays
 *      (wire_vectors `reject.message/from-not-signer`, the crown-jewel case);
 *   2. is `to` the recipient I am? A signature that verifies FOR SOMEONE ELSE is still a
 *      perfectly valid signature — it is just not my mail. `wire_vectors
 *      reject.message/wrong-recipient` is exactly that: `mustReject: true` even though
 *      the signature checks out, because in core the "to == me" half lives one layer up
 *      (agent/inbox.verify -> WRONG_RECIPIENT).
 *
 * A module-level function has no "me", so the recipient must be NAMED by the caller —
 * `verifyEnvelope(fields, { recipientDid })`, or `recipientDid` on the fields object.
 * An unnamed recipient is UNKNOWN, and unknown fails closed: an envelope nobody claims
 * cannot be verified as theirs. When you deliberately want question 1 alone (auditing a
 * stored message, say), call `verifyEnvelopeSignature`.
 *
 * Never throws.
 */
export function verifyEnvelope(fields, opts = {}) {
  try {
    if (!fields || typeof fields !== 'object') return false;
    const recipient = opts.recipientDid ?? opts.me ?? fields.recipientDid ?? null;
    if (typeof recipient !== 'string' || !recipient) return false;
    if (fields.to !== recipient) return false;
    return verifyEnvelopeSignature(fields);
  } catch {
    return false;
  }
}

// ================================================================ device-key binding v2 (T102)
//
// The ACCOUNT layer: a message may carry a countersigned DeviceKeyBinding v2 in
// metadata.binding proving its device DID belongs to an OWNER DID. This is the JS twin of
// shared/keybinding.verify_device_binding_v2 + the agent entry's account resolution, byte-pinned
// by testdata/wire_vectors.json `bindingV2`.
//
// Two signatures, over the SAME canonical bytes: the OWNER (root) signs, and the DEVICE
// countersigns — the countersignature is what stops a foreign owner claiming someone else's
// device. `typ` lives INSIDE the signed bytes (domain separation), and ts/validUntil are
// INTEGERS (a float's repr is not reproducible cross-language). Unlike the Python reference
// there is no "P-256 owner without a backend → unbound" branch: node:crypto verifies P-256
// natively, so a P-256 owner binding is fully checked here — the documented, expected
// asymmetry (the stdlib Python path treats the very same binding as unbound).

/** `typ` of the countersigned account binding (shared/keybinding.BINDING_V2_TYP). */
export const BINDING_V2_TYP = 'muretai/devicebinding/2';

// SPKI DER prefix for a P-256 public key carrying a COMPRESSED SEC1 point (33 bytes). OpenSSL
// (node:crypto) accepts compressed points, so the did:key point embeds directly — no
// decompression. 0x2a8648ce3d0201 = id-ecPublicKey, 0x2a8648ce3d030107 = prime256v1.
const P256_SPKI_PREFIX = Buffer.from(
  '3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex');

/** did:key → { curve, key }: ('ed25519', 32-byte pubkey) or ('p256', 33-byte compressed
 *  point). Curve-agnostic sibling of `publicKeyFromDid` (which is ed25519-only, for the
 *  message envelope that is always ed25519). Throws on anything else. */
function decodeDidKey(did) {
  if (typeof did !== 'string' || !did.startsWith('did:key:z')) {
    throw new TypeError(`unsupported DID method: ${String(did).slice(0, 32)}`);
  }
  const raw = b58decode(did.slice('did:key:z'.length));
  if (raw.length === 34 && raw[0] === 0xed && raw[1] === 0x01) {
    return { curve: 'ed25519', key: raw.subarray(2) };       // 0xed01 multicodec
  }
  if (raw.length === 35 && raw[0] === 0x80 && raw[1] === 0x24) {
    return { curve: 'p256', key: raw.subarray(2) };          // varint(0x1200) = p256-pub
  }
  throw new TypeError('unsupported did:key multicodec (not ed25519 or p256)');
}

/** Verify an ES256 signature over `message` for a 33-byte compressed P-256 point. Accepts
 *  both encodings clients emit (shared/crypto.p256_verify): raw r||s (64 bytes, WebCrypto /
 *  IEEE P1363) and ASN.1 DER (Secure Enclave / WebAuthn). Never throws. */
function p256Verify(compPoint, signature, message) {
  try {
    if (!Buffer.isBuffer(compPoint) || compPoint.length !== 33) return false;
    const key = createPublicKey({
      key: Buffer.concat([P256_SPKI_PREFIX, compPoint]), format: 'der', type: 'spki' });
    if (signature.length === 64) {
      return nodeVerify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signature);
    }
    return nodeVerify('sha256', message, key, signature);    // DER (Secure Enclave)
  } catch {
    return false;
  }
}

/** Curve-dispatching signature verify against a did:key — the binding's owner may be
 *  ed25519 OR p256; the device is always ed25519. Total and fail-closed. */
function verifyDidSig(did, signature, message) {
  try {
    const { curve, key } = decodeDidKey(did);
    if (curve === 'ed25519') return verifyBytes(key, signature, message);
    if (curve === 'p256') return p256Verify(key, signature, message);
    return false;
  } catch {
    return false;
  }
}

/** Canonical bytes BOTH keys sign — exactly the five declared fields
 *  (shared/keybinding._binding_v2_payload). `canonicalBytes` sorts keys by code point, so
 *  the object order here is irrelevant; the emitted bytes are
 *  {"deviceDid":…,"rootDid":…,"ts":…,"typ":…,"validUntil":…}. */
function bindingV2Payload(rootDid, deviceDid, ts, validUntil) {
  return canonicalBytes({ typ: BINDING_V2_TYP, rootDid, deviceDid, ts, validUntil });
}

/**
 * Verify a v2 binding — the twin of shared/keybinding.verify_device_binding_v2. TOTAL on
 * untrusted input (returns false, never throws). All must hold: typ matches; rootDid and
 * deviceDid are non-empty strings; ts/validUntil are safe integers; `expectedDeviceDid`
 * (when given) matches deviceDid (anti-copy pin); `now` given + validUntil non-zero → not
 * expired; the OWNER signed the canonical five fields; the DEVICE countersigned the same.
 */
export function verifyDeviceBindingV2(binding, { now = null, expectedDeviceDid = null } = {}) {
  try {
    if (!binding || typeof binding !== 'object') return false;
    if (binding.typ !== BINDING_V2_TYP) return false;
    const { rootDid, deviceDid, ts, validUntil } = binding;
    if (typeof rootDid !== 'string' || !rootDid) return false;
    if (typeof deviceDid !== 'string' || !deviceDid) return false;
    if (!Number.isSafeInteger(ts) || !Number.isSafeInteger(validUntil)) return false;
    if (expectedDeviceDid !== null && deviceDid !== expectedDeviceDid) return false;
    if (now !== null && validUntil !== 0 && now > validUntil) return false;
    const sig = Buffer.from(String(binding.sig ?? ''), 'base64');
    const deviceSig = Buffer.from(String(binding.deviceSig ?? ''), 'base64');
    const payload = bindingV2Payload(rootDid, deviceDid, ts, validUntil);
    return verifyDidSig(rootDid, sig, payload) && verifyDidSig(deviceDid, deviceSig, payload);
  } catch {
    return false;
  }
}

// ================================================================ signed Agent Card envelope

/** The canonical bytes a card envelope signs: {card, ts, typ, v} (shared/cardpub).
 *  `ts` MUST be an INTEGER epoch — a float `ts` renders through Python's repr and is,
 *  by construction, unverifiable outside Python. */
export function cardEnvelopePayload(card, ts) {
  return canonicalJSON({ card, ts, typ: CARD_ENVELOPE_TYPE, v: CARD_ENVELOPE_VERSION });
}

/** Wrap `card` in the signed envelope served at /.well-known/agent-card.sig.json. */
export function makeCardEnvelope(seedHex, card, ts) {
  if (!Number.isSafeInteger(ts)) {
    throw new TypeError('card envelope ts must be an INTEGER epoch (a float is Python-only)');
  }
  const payload = cardEnvelopePayload(card, ts);
  assertEncodable(payload);
  return {
    v: CARD_ENVELOPE_VERSION,
    typ: CARD_ENVELOPE_TYPE,
    card,
    ts,
    sig: signBytes(seedHex, Buffer.from(payload, 'utf8')).toString('base64'),
  };
}

/** Verify a card envelope; returns the inner card or null. `expectedDid` is the
 *  anti-substitution check — a signature only proves "X signed X's card". */
export function verifyCardEnvelope(envelope, expectedDid = null) {
  try {
    if (!envelope || typeof envelope !== 'object') return null;
    if (envelope.typ !== CARD_ENVELOPE_TYPE) return null;
    const { card, ts, sig } = envelope;
    if (!card || typeof card !== 'object' || !card.did || sig == null || ts == null) return null;
    if (expectedDid !== null && card.did !== expectedDid) return null;
    const raw = Buffer.from(String(sig), 'base64');
    if (raw.length !== 64) return null;
    const payload = cardEnvelopePayload(card, ts);
    assertEncodable(payload);
    return verifyBytes(publicKeyFromDid(card.did), raw, Buffer.from(payload, 'utf8'))
      ? card : null;
  } catch {
    return null;
  }
}

// ================================================================ cryptobox (X25519 + ChaCha20)
//
// STATIC-STATIC sealed box (shared/cryptobox.py). The X25519 key is a pure function of the
// SAME Ed25519 seed the agent already holds, so there is no second key to provision:
//   x25519_private = sha256("agentnet-x25519:" || ed25519_seed)
//   shared         = X25519(my_private, their_public)                    (raw ECDH)
//   key            = HKDF-SHA256(shared, salt=32 zero bytes, info="agentnet-box-v1", 32)
//   blob           = base64(nonce[12] || ciphertext || tag[16])
// salt=None in Python's HKDF means "HashLen zero bytes", hence Buffer.alloc(32).

const BOX_INFO = Buffer.from('agentnet-box-v1', 'utf8');
const BOX_SALT = Buffer.alloc(32);
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function x25519PrivateRaw(seedHex) {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from('agentnet-x25519:', 'utf8'), seedBuffer(seedHex)]))
    .digest();
}

function x25519PrivateKey(seedHex) {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, x25519PrivateRaw(seedHex)]),
    format: 'der', type: 'pkcs8',
  });
}

/** The X25519 public key (hex) a peer needs to seal a box to this seed. Safe to publish. */
export function encPubHex(seedHex) {
  const pub = createPublicKey(x25519PrivateKey(seedHex));
  return pub.export({ format: 'der', type: 'spki' })
    .subarray(X25519_SPKI_PREFIX.length).toString('hex');
}

function boxKey(seedHex, theirPubHex) {
  const theirPub = Buffer.from(String(theirPubHex), 'hex');
  if (theirPub.length !== 32) throw new TypeError('peer X25519 public key must be 32 bytes');
  const shared = diffieHellman({
    privateKey: x25519PrivateKey(seedHex),
    publicKey: createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, theirPub]), format: 'der', type: 'spki',
    }),
  });
  return Buffer.from(hkdfSync('sha256', shared, BOX_SALT, BOX_INFO, 32));
}

/** Encrypt to the holder of `theirPubHex`. Returns base64(nonce || ciphertext || tag).
 *  A fresh random nonce per call, so the output is never reproducible — which is why the
 *  wire vectors pin only the OPEN direction. */
export function seal(seedHex, theirPubHex, plaintext, ad = Buffer.alloc(0)) {
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const aad = Buffer.isBuffer(ad) ? ad : Buffer.from(String(ad), 'utf8');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('chacha20-poly1305', boxKey(seedHex, theirPubHex), nonce,
    { authTagLength: TAG_BYTES });
  if (aad.length) cipher.setAAD(aad, { plaintextLength: pt.length });
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64');
}

/** Decrypt a box sealed by the matching peer. Returns a Buffer, or **null on ANY failure**
 *  (bad base64, truncated blob, wrong key, AD mismatch, auth-tag failure) — the caller's
 *  verification path stays branch-simple, exactly like shared/cryptobox.open_box. */
export function openBox(seedHex, theirPubHex, blobB64, ad = Buffer.alloc(0)) {
  try {
    const raw = Buffer.from(String(blobB64), 'base64');
    if (raw.length < NONCE_BYTES + TAG_BYTES) return null;
    const nonce = raw.subarray(0, NONCE_BYTES);
    const ct = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const aad = Buffer.isBuffer(ad) ? ad : Buffer.from(String(ad), 'utf8');
    const decipher = createDecipheriv('chacha20-poly1305', boxKey(seedHex, theirPubHex), nonce,
      { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    if (aad.length) decipher.setAAD(aad, { plaintextLength: ct.length });
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    return null;
  }
}

// ================================================================ reach-back through a relay
//
// The inline reply answers the visitor who is holding the HTTP connection. Everything the
// site wants to say LATER ("your booking is confirmed") goes the other way: sealed to the
// visitor's X25519 key and deposited at a relay, which stores and forwards it. The relay
// never sees plaintext — it only checks that the routing fields are signed.

/** Build the A2A message object (shared/protocol.Message.to_a2a) for `fields`. */
function toA2A({ role, text, messageId, contextId, timestamp, from, to, sig, replyTo }) {
  const metadata = { timestamp, from, to, sig };
  if (replyTo) metadata.replyTo = replyTo;
  return {
    kind: 'message',
    role,
    parts: [{ kind: 'text', text }],
    messageId,
    contextId: contextId ?? null,
    metadata,
  };
}

/**
 * Seal a signed `message/send` request to `toDid` and deposit it at `relayUrl`.
 *
 * The deposit body is `{to, from, from_enc, id, blob, sig}` where
 * `sig = Ed25519(to + "|" + from + "|" + id + "|" + blob)` over those UTF-8 bytes — NOT
 * canonical JSON. It proves the routing fields and the opaque blob were not altered in
 * transit while leaving the relay unable to read anything.
 *
 * Resolves `{status, queued, ...body}`; never throws for a non-2xx — the caller decides.
 */
export async function depositToRelay(relayUrl, { seedHex, toDid, toEncPub, text,
  contextId = null, timestamp = null, auto = false } = {}) {
  const from = didFromSeedHex(seedHex);
  const messageId = newId();
  const ts = timestamp ?? nowEpoch();
  const sig = signEnvelope(seedHex, { from, to: toDid, messageId, contextId,
    timestamp: ts, text });
  const message = toA2A({ role: 'user', text, messageId, contextId, timestamp: ts,
    from, to: toDid, sig });
  if (auto) message.metadata.auto = true;
  const rpc = { jsonrpc: '2.0', id: newId(), method: 'message/send', params: { message } };
  // JSON.stringify (not canonical JSON) is correct for the SEALED body: only signed
  // payloads need canonical form, and the AEAD tag already binds these bytes exactly.
  const blob = seal(seedHex, toEncPub, JSON.stringify(rpc));
  const id = newId();
  const depositSig = signBytes(seedHex,
    Buffer.from(`${toDid}|${from}|${id}|${blob}`, 'utf8')).toString('base64');

  const res = await fetch(relayUrl.replace(/\/+$/, '') + '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: toDid, from, from_enc: encPubHex(seedHex), id, blob,
      sig: depositSig }),
  });
  const raw = await res.text();
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
  return { status: res.status, queued: body.queued === true, messageId, ...body };
}

// ================================================================ the agent entry

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

let OVERSIZE_SENTINEL = null;
/** A body one byte over the ceiling — the cheapest thing that makes `handlePost` answer 413.
 *  Shared and read-only: it is never parsed, only measured. */
function oversizeSentinel() {
  if (OVERSIZE_SENTINEL === null) OVERSIZE_SENTINEL = Buffer.alloc(MAX_BODY_BYTES + 1);
  return OVERSIZE_SENTINEL;
}

/** messageId dedup with a TTL and a hard cap, so a stranger cannot grow it without bound. */
class ReplayGuard {
  constructor(ttlSeconds = REPLAY_TTL_S, cap = 20000) {
    this.ttl = ttlSeconds * 1000;
    this.cap = cap;
    this.seen = new Map();               // messageId -> expiry (ms). Insertion-ordered.
    this.inserts = 0;
  }

  /** True if this messageId is NEW (and remembers it); false if it is a replay. */
  checkAndRemember(messageId) {
    const now = Date.now();
    const expiry = this.seen.get(messageId);
    if (expiry !== undefined) {
      if (expiry > now) return false;    // still inside the window: a replay
      this.seen.delete(messageId);       // expired: it may be used again
    }
    this.seen.set(messageId, now + this.ttl);
    if ((++this.inserts & 0xff) === 0) this.sweep(now);
    while (this.seen.size > this.cap) {
      // Oldest-first eviction. Dropping an entry can only ever make us ACCEPT an old
      // duplicate — never reject a fresh message — so a full table degrades safely.
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    return true;
  }

  sweep(now = Date.now()) {
    for (const [k, expiry] of this.seen) {
      if (expiry > now) break;           // insertion order == expiry order (fixed TTL)
      this.seen.delete(k);
    }
  }
}

/** A whole-agent entry sliding-window bound: at most `perMinute` grants in any 60s. Kept
 *  deliberately dumb — it can never hold more than `perMinute` timestamps, so the bound
 *  bounds its own bookkeeping, which is why it is the OUTERMOST guard on the anonymous
 *  lane (it also keeps a flood from growing the replay table). */
class RateBound {
  constructor(perMinute = ANON_RATE_PER_MIN) {
    this.perMinute = Math.max(0, Number(perMinute) || 0);
    this.hits = [];
  }

  /** Consume one token. False when the window is full. */
  allow() {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < 60000);
    if (this.hits.length >= this.perMinute) return false;
    this.hits.push(now);
    return true;
  }
}

/**
 * The STRICT type check on the fields that end up inside the signed payload. Returns a
 * reason string, or null when the shape is acceptable.
 *
 * WHY (measured divergence, not theory). The contract is "one agent entry, two
 * implementations": the same bytes must get the same verdict. They did not. A NUMERIC text
 * part was coerced to '' HERE and an account row was minted, while the Python reference
 * raised and answered -32600 — the same POST created a customer on one deployment and was
 * refused on the other, which is the double-book class for the booking flow this tier
 * sells. Likewise a non-string `contextId` (the reproduced case was the float `1.0`):
 * JavaScript renders it `1` and Python renders it `1.0`, so exactly one of them can verify
 * the signature — and we would then ECHO it into our own signed reply.
 *
 * -32600 (Invalid Request) for all of them: a wrongly-typed field is a malformed request,
 * not a failed signature. `examples/agent_entry_reference.py::_wire_shape_error` answers the
 * same code for the same input, case for case.
 */
function wireShapeError(msg) {
  const parts = msg.parts;
  if (parts !== undefined && parts !== null && !Array.isArray(parts)) {
    return 'parts must be an array';
  }
  for (const part of (Array.isArray(parts) ? parts : [])) {
    if (!part || typeof part !== 'object' || part.kind !== 'text') continue;
    // ABSENT reads as '' (Python's `.get("text", "")`); PRESENT-but-not-a-string is a
    // refusal, never a coercion — coercing means signing a reply to text nobody wrote.
    if ('text' in part && typeof part.text !== 'string') {
      return 'a text part\'s `text` must be a string';
    }
  }
  if (typeof msg.messageId !== 'string' || !msg.messageId) {
    return 'messageId must be a non-empty string';
  }
  if (msg.contextId !== undefined && msg.contextId !== null
      && typeof msg.contextId !== 'string') {
    return 'contextId must be a string or null';
  }
  return null;
}

/** Every response carries these. An agent entry reads NO cookie, header credential or session —
 *  authority comes only from an Ed25519 signature inside the body — so `*` grants a browser
 *  agent exactly what curl already had, and nothing more. Never add Allow-Credentials. */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};

function jsonResponse(status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      ...CORS_HEADERS,
      ...extraHeaders,
    },
    body,
  };
}

function rpcError(id, error, data) {
  const err = { ...error };
  if (data) err.data = data;
  return jsonResponse(200, { jsonrpc: '2.0', id: id ?? null, error: err });
}

function isThenable(v) {
  return v !== null && typeof v === 'object' && typeof v.then === 'function';
}

/**
 * createAgentEntry(opts) -> { did, card, ledger, handleRequest, handleRequestAsync, listen }
 *
 *   seedHex        the site's 32-byte identity seed (hex). THE PRIVATE KEY.
 *   name           the public name on the Agent Card.
 *   baseUrl        the base a visitor dials. It goes in the card's `url`, and the visitor
 *                  REQUIRES card.url to name the origin+path it dialled (Outbox.card_binds_to)
 *                  — that binding is what stops an attacker re-serving your signed card at
 *                  their own host. Get it wrong and Path A verification fails, silently.
 *   responder      (envelope) => string | {text, contextId?, timestamp?} | Promise<…>
 *   openDoor       advertise `muretai.open_door` (default true) — the flag that tells a
 *                  visiting agent it may contact you without an introduction.
 *   anonymousLane  also accept UNSIGNED inquiries (default false). They create no account,
 *                  and the lane as a whole is capped at `anonRatePerMin` signed replies per
 *                  minute — it is unauthenticated, so it must not be an unmetered signing
 *                  oracle. Signed senders are not rate-bound here: they are attributable,
 *                  and every one of them is already in the ledger.
 *   anonRatePerMin anonymous replies per minute for the WHOLE agent entry (default 30).
 */
export function createAgentEntry({
  seedHex,
  name = 'Muretai AgentEntry',
  baseUrl,
  description = 'Signed agent-to-agent messaging. Send an A2A message and get a signed reply.',
  version = '1',
  responder = () => 'Thanks — a human will follow up.',
  openDoor = true,
  anonymousLane = false,
  anonRatePerMin = ANON_RATE_PER_MIN,
  skills = [],
  maxAccounts = 50000,
} = {}) {
  if (!seedHex) throw new TypeError('createAgentEntry: seedHex is required');
  if (!baseUrl) throw new TypeError('createAgentEntry: baseUrl is required (it is signed into the card)');
  const did = didFromSeedHex(seedHex);

  const card = {
    protocolVersion: PROTOCOL_VERSION,
    name,
    description,
    url: baseUrl,
    did,
    version,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
  };
  if (openDoor) card.muretai = { open_door: true };
  // Deliberately NO `relay`/`enc_pub` on the card: those advertise a store-and-forward
  // mailbox, and an agent entry has no listener draining one. Advertising a mailbox nobody
  // reads is worse than advertising none — mail would queue at the relay forever.

  const cardBytes = Buffer.from(JSON.stringify(card), 'utf8');   // identical bytes on both paths
  // ACCOUNT DID -> {first_seen, last_seen, messages}. Keyed by the RESOLVED account (T102):
  // the OWNER DID when a valid v2 binding rides along, else the device DID — so an owner's
  // sibling devices are ONE customer row.
  const ledger = new Map();
  // device DID -> owner DID, the in-process TOFU pin (T102). The first VALID binding pins a
  // device to its owner; a later binding for the same device naming a DIFFERENT owner is
  // refused. Per-process on purpose for v1.5 — a real site PERSISTS this (and the fold), or
  // the conflict rule resets to trust-on-first-use every restart.
  const deviceOwner = new Map();
  const replay = new ReplayGuard();
  const anonRate = new RateBound(anonRatePerMin);
  let sigEnvelope = null;
  let sigMintedAt = 0;

  /** The signed card, re-minted at most hourly. A CONSUMER REJECTS AN ENVELOPE OLDER THAN
   *  6h (and one dated in the FUTURE), so this is a freshness window, not a cache tweak:
   *  without it a saved copy would still "prove" ownership to whoever holds the origin next. */
  function cardEnvelopeBytes() {
    const now = nowEpoch();
    if (!sigEnvelope || now - sigMintedAt >= CARD_SIG_REFRESH_S) {
      sigEnvelope = Buffer.from(JSON.stringify(makeCardEnvelope(seedHex, card, now)), 'utf8');
      sigMintedAt = now;
    }
    return sigEnvelope;
  }

  function noteContact(accountDid) {
    const now = nowEpoch();
    const row = ledger.get(accountDid);
    if (row) {
      row.messages += 1;
      row.last_seen = now;
      return row;
    }
    // FIRST CONTACT IS ACCOUNT CREATION. There is no signup form: the sender proved control
    // of a device key one line above, which is strictly more than an email link. The row is
    // keyed by the ACCOUNT (the owner when bound), so sibling devices are one customer.
    const fresh = { first_seen: now, last_seen: now, messages: 1 };
    ledger.set(accountDid, fresh);
    while (ledger.size > maxAccounts) {
      const oldest = ledger.keys().next();
      if (oldest.done) break;
      ledger.delete(oldest.value);
    }
    return fresh;
  }

  /** When a device that ALREADY has an unbound ledger row first proves its owner, move that
   *  row's history into the owner row — ONCE. Never the reverse: a later stripped binding
   *  resolves to the device DID and must not merge, or stripping a binding would become a
   *  way to read the owner's history. */
  function foldDeviceIntoOwner(deviceDid, ownerDid) {
    const devRow = ledger.get(deviceDid);
    if (!devRow) return;
    ledger.delete(deviceDid);
    const ownerRow = ledger.get(ownerDid);
    if (!ownerRow) { ledger.set(ownerDid, devRow); return; }
    ownerRow.messages += devRow.messages || 0;
    ownerRow.first_seen = Math.min(ownerRow.first_seen, devRow.first_seen);
  }

  /**
   * The account (owner) DID this message belongs to (T102) — the JS twin of
   * examples/agent_entry_reference.py::_resolve_account and, one tier up,
   * agent/inbox.py::_resolve_account. Returns { ok:true, account } or { ok:false, reason }.
   * Absent binding → the device DID (`from`), byte-identical to today. Present binding → every
   * check must hold or it FAILS CLOSED with the same UNAUTHENTICATED code and a distinct
   * reason; never a silent downgrade to unbound, never a proven owner handed on unverified.
   * The cheap structural pins produce the distinct reasons; the two signatures are left to
   * `verifyDeviceBindingV2`, the one contract the Python reference re-implements.
   */
  function resolveAccount(binding, from) {
    if (binding === undefined || binding === null) return { ok: true, account: from };
    if (typeof binding !== 'object' || Array.isArray(binding)) {
      return { ok: false, reason: 'attached device binding is malformed' };
    }
    if (binding.typ !== BINDING_V2_TYP) {
      return { ok: false, reason: 'attached device binding has an unsupported typ' };
    }
    if (typeof binding.rootDid !== 'string' || !binding.rootDid) {
      return { ok: false, reason: 'attached device binding names no owner' };
    }
    if (binding.deviceDid !== from) {
      return { ok: false, reason: 'device binding does not name the sender' };
    }
    const { ts, validUntil, rootDid } = binding;
    if (!Number.isSafeInteger(ts) || !Number.isSafeInteger(validUntil)) {
      return { ok: false, reason: 'device binding timestamps must be integers' };
    }
    const now = nowEpoch();
    if (ts > now + CLOCK_WINDOW_S) {
      return { ok: false, reason: 'device binding ts is in the future' };
    }
    if (validUntil !== 0 && now > validUntil) {
      return { ok: false, reason: 'device binding has expired' };
    }
    if (!verifyDeviceBindingV2(binding, { now, expectedDeviceDid: from })) {
      return { ok: false, reason: 'device binding does not verify' };
    }
    const pinned = deviceOwner.get(from);
    if (pinned !== undefined && pinned !== rootDid) {
      return { ok: false, reason:
        'device is already bound to a different owner (a device DID is never re-owned '
        + '— a new owner means a new device key)' };
    }
    if (pinned === undefined) {
      deviceOwner.set(from, rootDid);
      foldDeviceIntoOwner(from, rootDid);
    }
    return { ok: true, account: rootDid };
  }

  /** The FROZEN backend-handoff shape (agent/webhookwake.py::_envelope). The site's own
   *  code consumes this, so the key set must not drift: a webhook push, a drive-API read
   *  and an agent entry callback all parse with ONE schema. */
  function backendEnvelope(msg, { verified, peerDid, ownerDid = null }) {
    const meta = msg.metadata || {};
    return {
      to_agent: name,
      to_did: did,
      direction: 'in',
      verified,
      peer_did: peerDid,
      // T102: the resolved ACCOUNT (owner) DID when a valid v2 binding proved this device
      // belongs to an owner, else null. `peer_did` STAYS the device that signed; sibling
      // devices share one owner_did, which is how a merchant reads them as one account.
      owner_did: ownerDid,
      peer_name: null,
      context_id: msg.contextId ?? null,
      text: messageText(msg),
      msg_id: msg.messageId ?? null,
      reply_to: meta.replyTo ?? null,
      wire_ts: meta.timestamp ?? null,
      auto: Boolean(meta.auto),
      coord: meta.coordination ?? null,
      deal: meta.deal ?? null,
      group: meta.group ?? null,
    };
  }

  function signedReply(reqId, { text, contextId, timestamp, toDid, replyTo }) {
    const messageId = newId();
    const ts = Number.isSafeInteger(timestamp) ? timestamp : nowEpoch();
    const ctx = contextId ?? null;
    const sig = signEnvelope(seedHex, { from: did, to: toDid, messageId, contextId: ctx,
      timestamp: ts, text });
    const message = toA2A({ role: 'agent', text, messageId, contextId: ctx, timestamp: ts,
      from: did, to: toDid, sig, replyTo });
    return jsonResponse(200, { jsonrpc: '2.0', id: reqId ?? null, result: message });
  }

  function finishReply(reqId, answer, { inbound, toDid }) {
    let text = answer;
    let contextId = inbound.contextId ?? null;
    let timestamp = null;
    if (answer && typeof answer === 'object') {
      text = answer.text;
      // The overrides exist so a test can prove a VISITOR refuses a cross-conversation or
      // stale reply. An honest agent entry never sets them.
      if ('contextId' in answer) contextId = answer.contextId;
      else if ('context_id' in answer) contextId = answer.context_id;
      if ('timestamp' in answer) timestamp = answer.timestamp;
    }
    if (typeof text !== 'string') text = String(text ?? '');
    return signedReply(reqId, { text, contextId, timestamp, toDid,
      replyTo: inbound.messageId });
  }

  /**
   * The POST contract, in EXACTLY this order (agent/inbox.py::verify). The order is
   * load-bearing: an oversized message must cost the recipient nothing to refuse, so the
   * size checks come BEFORE any parsing or crypto — a check placed after the signature is
   * a check the attacker simply skips.
   */
  function handlePost(bodyBuffer) {
    // 1. body over 1 MiB — refused WITHOUT parsing.
    if (bodyBuffer.length > MAX_BODY_BYTES) {
      return jsonResponse(413, { error: 'request body too large' });
    }
    // 2. unparseable or non-object JSON — a transport-level refusal, not a JSON-RPC one.
    let req;
    try {
      req = JSON.parse(bodyBuffer.toString('utf8'));
    } catch {
      return jsonResponse(400, { error: 'malformed JSON' });
    }
    if (!req || typeof req !== 'object' || Array.isArray(req)) {
      return jsonResponse(400, { error: 'JSON-RPC request must be an object' });
    }
    // 3. From here every refusal is HTTP 200 with a JSON-RPC error object.
    const reqId = req.id ?? null;
    if (typeof req.method === 'string' && req.method !== 'message/send') {
      return rpcError(reqId, ERRORS.METHOD_NOT_FOUND,
        `${req.method} — this agent entry serves message/send only`);
    }
    const msg = (req.params && typeof req.params === 'object') ? req.params.message : null;
    if (!msg || typeof msg !== 'object') {
      return rpcError(reqId, ERRORS.INVALID_PARAMS, 'params.message is required');
    }
    // 3a. wrongly-TYPED wire fields, on the raw object and before anything measures or
    //     hashes it. These are the fields that end up inside a signed payload — theirs and,
    //     for contextId, ours — so a coercion here is a signature over something the sender
    //     did not say. Same check, same code, same order as the Python reference.
    const shape = wireShapeError(msg);
    if (shape !== null) return rpcError(reqId, ERRORS.INVALID_REQUEST, shape);

    const meta = (msg.metadata && typeof msg.metadata === 'object') ? msg.metadata : {};
    const text = messageText(msg);

    // 3b. text over the 64 KiB ceiling — BEFORE any crypto.
    const over = Buffer.byteLength(text, 'utf8') - MAX_TEXT_BYTES;
    if (over > 0) {
      return rpcError(reqId, ERRORS.MESSAGE_TOO_LARGE,
        `text is ${over} bytes over the ${MAX_TEXT_BYTES}-byte limit`);
    }

    const from = typeof meta.from === 'string' ? meta.from : null;
    const to = typeof meta.to === 'string' ? meta.to : null;
    const sig = typeof meta.sig === 'string' ? meta.sig : null;

    // 4. no signing envelope. The anonymous lane accepts an inquiry that carries NO
    //    envelope at all (a walk-in with no DID); a message that carries a PARTIAL one
    //    (from/to present, sig stripped) is a downgrade attempt and is always refused.
    if (!from || !to || !sig) {
      const bare = !from && !to && !sig;
      if (!(anonymousLane && bare)) {
        return rpcError(reqId, ERRORS.UNAUTHENTICATED, 'missing signing envelope (from/to/sig)');
      }
      // Anonymous: answer, signed by us, addressed to nobody. NO ledger row — an
      // unauthenticated stranger must never be able to mint an account.
      //
      // It runs the SAME ladder as the signed lane, minus the checks that need a key: the
      // body cap, the shape gate and the text cap are the shared code above; the rate bound
      // and the dedup are here. Both refusals cost this agent entry no signature, which is the
      // whole point — the lane used to answer every unsigned repeat of ONE messageId with a
      // fresh signature, an unmetered signing oracle. Freshness is deliberately NOT checked:
      // an unsigned timestamp is a number the sender chose, so refusing an old one buys
      // nothing the dedup does not already buy.
      if (!anonRate.allow()) {
        return rpcError(reqId, ERRORS.RATE_LIMITED,
          `the anonymous lane is limited to ${anonRatePerMin} replies per minute — `
          + 'sign your message to lift the bound');
      }
      if (!replay.checkAndRemember(msg.messageId)) {
        return rpcError(reqId, ERRORS.REPLAY_REJECTED, 'duplicate messageId (replay) detected');
      }
      return respond(backendEnvelope(msg, { verified: false, peerDid: null }),
        reqId, msg, '');
    }
    // 5. addressed to someone else. Checked BEFORE decoding `from`, so a junk DID in a
    //    misaddressed message never reaches the base58 decoder.
    if (to !== did) {
      return rpcError(reqId, ERRORS.WRONG_RECIPIENT, `not addressed to me: ${to.slice(0, 24)}…`);
    }
    // 6. an INTEGER epoch, inside the clock window (both directions: a future timestamp is
    //    as unusable as a stale one). Integer is the CONTRACT, not a preference: a float
    //    renders through Python's repr and no other language reproduces those bytes, so a
    //    fractional timestamp is a signature only one implementation could check. A STRING
    //    timestamp lands here too — `Number.isSafeInteger('1786580417')` is false — and the
    //    Python reference now answers the same -32002 instead of coercing it with float()
    //    and accepting.
    //
    //    Note what this check CANNOT see: `JSON.parse` destroys the int/float distinction,
    //    so a body that wrote `1786580417.0` is already the Number 1786580417 here. That is
    //    why the contract makes the canonical INTEGER spelling the thing the signature is
    //    verified against (step 8 signs/verifies `timestamp: ts`, an integer Number): the
    //    float-spelled sender then fails on BOTH implementations with -32001 rather than
    //    being accepted by whichever one happened to keep the original bytes.
    const ts = meta.timestamp;
    if (!Number.isSafeInteger(ts) || Math.abs(nowEpoch() - ts) > CLOCK_WINDOW_S) {
      return rpcError(reqId, ERRORS.REPLAY_REJECTED, 'timestamp out of range (clock skew or replay)');
    }
    // 7. duplicate messageId inside the replay window. (Its type was settled by the shape
    //    gate: a non-string messageId never reaches here on either implementation.)
    const messageId = msg.messageId;
    if (!replay.checkAndRemember(messageId)) {
      return rpcError(reqId, ERRORS.REPLAY_REJECTED, 'duplicate messageId (replay) detected');
    }
    // 8. the signature itself, under the key DERIVED FROM `from`.
    const fields = { from, to, messageId, contextId: msg.contextId ?? null,
      timestamp: ts, text, sig };
    if (!verifyEnvelope(fields, { recipientDid: did })) {
      return rpcError(reqId, ERRORS.UNAUTHENTICATED, 'signature does not match');
    }

    // 9. T102 account layer. An OPTIONAL countersigned v2 binding collapses an owner's device
    //    DIDs to ONE account; a present-but-INVALID binding fails closed with the SAME
    //    UNAUTHENTICATED code (never a silent downgrade to unbound). Absent → the device DID.
    const acct = resolveAccount(meta.binding, from);
    if (!acct.ok) return rpcError(reqId, ERRORS.UNAUTHENTICATED, acct.reason);
    const account = acct.account;
    const ownerDid = account !== from ? account : null;

    noteContact(account);
    return respond(backendEnvelope(msg, { verified: true, peerDid: from, ownerDid }),
      reqId, msg, from);
  }

  function respond(env, reqId, msg, toDid) {
    let answer;
    try {
      answer = responder(env);
    } catch (e) {
      return rpcError(reqId, ERRORS.INTERNAL_ERROR, `responder failed: ${e && e.message}`);
    }
    const inbound = { contextId: msg.contextId ?? null, messageId: msg.messageId ?? null };
    if (isThenable(answer)) {
      return answer.then(
        (v) => finishReply(reqId, v, { inbound, toDid }),
        (e) => rpcError(reqId, ERRORS.INTERNAL_ERROR, `responder failed: ${e && e.message}`));
    }
    return finishReply(reqId, answer, { inbound, toDid });
  }

  function route(method, path, bodyBuffer) {
    const pathname = String(path || '/').split('?')[0].split('#')[0];
    if (method === 'GET' || method === 'HEAD') {
      if (pathname === AGENT_CARD_PATH || pathname === AGENT_CARD_PATH_LEGACY) {
        // Byte-identical on both paths: the current A2A path and the legacy alias.
        return { status: 200, headers: cardHeaders(cardBytes.length), body: cardBytes };
      }
      if (pathname === AGENT_CARD_SIG_PATH) {
        const env = cardEnvelopeBytes();
        return { status: 200, headers: cardHeaders(env.length), body: env };
      }
      if (pathname === '/') {
        const body = Buffer.from(
          `${name}\n\nThis origin is agent-reachable (Muretai agent entry).\n`
          + `DID:  ${did}\nCard: ${baseUrl.replace(/\/+$/, '')}${AGENT_CARD_PATH}\n`
          + 'POST a signed A2A message/send request to / for a signed reply.\n', 'utf8');
        return { status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': String(body.length) },
          body };
      }
      return jsonResponse(404, { error: 'not found' });
    }
    if (method === 'POST') {
      // EXACTLY the root path. A POST anywhere else is not this contract.
      if (pathname !== '/') return jsonResponse(404, { error: 'not found' });
      return handlePost(bodyBuffer || Buffer.alloc(0));
    }
    if (method === 'OPTIONS') {
      return { status: 204,
        headers: { Allow: 'GET, POST, OPTIONS', 'Content-Length': '0', ...CORS_HEADERS },
        body: Buffer.alloc(0) };
    }
    return jsonResponse(405, { error: 'method not allowed' });
  }

  function cardHeaders(length) {
    return {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(length),
      // The card and its envelope are public by design: a card is a self-assertion anyone
      // may fetch and re-verify, so there is nothing here to keep from a browser agent.
      ...CORS_HEADERS,
    };
  }

  /** SYNCHRONOUS request handling: (method, path, headers, bodyBuffer) -> {status, headers, body}.
   *  If `responder` returned a Promise, this answers -32603 rather than serializing
   *  "[object Promise]" into a signed reply — use `handleRequestAsync` for an async responder. */
  function handleRequest(method, path, headers, bodyBuffer) {
    const out = route(method, path, bodyBuffer);
    if (isThenable(out)) {
      return rpcError(null, ERRORS.INTERNAL_ERROR,
        'responder is async — serve this agent entry through listen()/handleRequestAsync()');
    }
    return out;
  }

  /** Same contract, awaiting an async responder. This is what `listen()` uses. */
  async function handleRequestAsync(method, path, headers, bodyBuffer) {
    return route(method, path, bodyBuffer);
  }

  /**
   * Bind an HTTP server. Defaults to 127.0.0.1 ON PURPOSE: a demo agent entry that binds
   * 0.0.0.0 by accident is a private key answering the whole LAN. Pass a host explicitly
   * (behind a TLS terminator) to go public.
   */
  function listen(port = 8788, host = '127.0.0.1', onReady) {
    const server = createServer((req, res) => {
      const chunks = [];
      let total = 0;
      let oversize = false;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          // Stop BUFFERING immediately, but keep draining: answering mid-upload makes the
          // client see a connection reset instead of the 413 we are trying to tell it.
          oversize = true;
          if (total > 32 * MAX_BODY_BYTES) { req.destroy(); return; }   // absurd: hang up
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => { try { res.destroy(); } catch { /* already gone */ } });
      req.on('end', () => {
        // MAX_BODY_BYTES+1 bytes is all `handlePost` needs to make the same 413 decision,
        // so the size rule lives in ONE place instead of two that can drift. The sentinel
        // is allocated at most ONCE per process (and only if someone actually sends an
        // oversize body) — minting a fresh 1 MiB buffer per refusal would hand the
        // attacker the very allocation the 413 exists to refuse.
        const body = oversize ? oversizeSentinel() : Buffer.concat(chunks, total);
        Promise.resolve()
          .then(() => handleRequestAsync(req.method, req.url, req.headers, body))
          .catch((e) => rpcError(null, ERRORS.INTERNAL_ERROR, String(e && e.message)))
          .then(({ status, headers, body: out }) => {
            res.writeHead(status, headers);
            res.end(req.method === 'HEAD' ? undefined : out);
          })
          .catch(() => { try { res.destroy(); } catch { /* already gone */ } });
      });
    });
    server.listen(port, host, () => { if (onReady) onReady(server); });
    return server;
  }

  return { did, card, ledger, handleRequest, handleRequestAsync, listen,
    cardEnvelope: () => JSON.parse(cardEnvelopeBytes().toString('utf8')) };
}

/** The A2A text of a message: every `text` part, joined by newline (Message.from_a2a). */
function messageText(msg) {
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  return parts
    .filter((p) => p && typeof p === 'object' && p.kind === 'text')
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('\n');
}
