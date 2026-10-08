#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// The door answers A2A 1.0 HTTP+JSON beside JSON-RPC.
//
// WRITTEN BEFORE THE IMPLEMENTATION (test author only). Intake 20261007T160328Z,
// P1 skeleton, agent-entry group 0e. The implementer may not edit this file.
// It is not wired into `npm test` until it is green; run it as
// `node conformance/a2a-http-json.mjs`.
//
// Drives createAgentEntry, handleRequestAsync, signEnvelope, verifyEnvelope,
// signingPayload, fileSink, gaSink, and the counts verb of muretai-agent-entry.mjs.
// Fixtures: conformance/fixtures/a2a-http-json-vectors.json (both bindings) and
// conformance/fixtures/a2a-jsonrpc-bytes.json (the JSON-RPC door, byte for byte).
// conformance/vectors.json is re-checked as itself.
//
// What is pinned:
//   The card keeps its JSON-RPC supportedInterfaces entry and adds
//   {url, protocolBinding HTTP+JSON, protocolVersion 1.0} after it. url is the
//   same door address the JSON-RPC entry already publishes.
//   POST <mount>/message:send takes {message: {messageId, role ROLE_USER,
//   parts: [{text}], metadata}} and verifies the six AE-18 fields from
//   message.metadata. A valid signature is answered {message: {role ROLE_AGENT,
//   ...}} as application/a2a+json, signed by the door.
//   A missing envelope is the AIP-193 UNAUTHENTICATED envelope whose data is
//   the JSON-RPC teaching recipe, byte-compatible: data.accepts names
//   did-key-ed25519. A partial envelope has no accepts array. A tampered
//   signed field is refused with the same code, message and data as the
//   JSON-RPC tamper.
//   The tasks routes answer TASK_NOT_FOUND. Any other unknown path stays the
//   door's existing not-found body.
//   A Bearer token without the signed envelope is that same refusal. Its
//   issuer host is recorded as bearer_issuer on the fileSink line only.
//   gaSink does not send it. counts --json and the text form show the hosts
//   under platforms. The issuer is never an account, never who.signed, and
//   never a byte of the HTTP response. A Bearer token beside a valid
//   signature is still the signer's did:key.
//   JSON-RPC message/send refusals stay the pinned bytes, and a JSON-RPC
//   success still uses role "agent".
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ERRORS, PROTOCOL_VERSION, SIGNED_ENVELOPE_SCHEME, createAgentEntry, didFromSeedHex,
  fileSink, gaSink, signEnvelope, signingPayload, verifyEnvelope,
} from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'muretai-agent-entry.mjs');
const GUARD = join(HERE, 'fixtures', 'cli', 'loopback-only.mjs');
const VECTORS = JSON.parse(readFileSync(join(HERE, 'fixtures', 'a2a-http-json-vectors.json'), 'utf8'));
const PINNED = JSON.parse(readFileSync(join(HERE, 'fixtures', 'a2a-jsonrpc-bytes.json'), 'utf8'));
const WIRE = JSON.parse(readFileSync(join(HERE, 'vectors.json'), 'utf8'));

const DOOR_SEED = 'ab'.repeat(32);
const VISITOR_SEED = 'cd'.repeat(32);
const BASE = 'https://lamp.example/door';
const MOUNT = '/door';
const SEND = `${MOUNT}${VECTORS.sendSuffix}`;

let passed = 0;
const failures = [];
const scratch = [];

function check(ok, label, detail = '') {
  if (ok) { passed += 1; return true; }
  failures.push(`${label}${detail ? ` - ${String(detail).slice(0, 500)}` : ''}`);
  return false;
}

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

function header(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return String(headers[key] ?? '');
  }
  return '';
}

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function makeEntry(extra = {}) {
  return createAgentEntry({
    seedHex: DOOR_SEED,
    name: 'Lamp',
    baseUrl: BASE,
    responder: (env) => env.text,
    signedRatePerMin: 0,
    signedRatePerMinTotal: 0,
    ...extra,
  });
}

async function call(entry, method, path, body, headers = {}) {
  const raw = body == null ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const out = await entry.handleRequestAsync(method, path, headers, raw);
  const text = Buffer.from(out.body || '').toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: out.status, contentType: header(out.headers, 'content-type'), text, json };
}

function b64url(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function bearerToken(iss, sub = 'customer-17') {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ iss, sub })}.x`;
}

function authHeaders(token, extra = {}) {
  return { 'content-type': VECTORS.mediaType, authorization: `Bearer ${token}`, ...extra };
}

function signedMeta(entry, messageId, text) {
  const from = didFromSeedHex(VISITOR_SEED);
  const timestamp = Math.floor(Date.now() / 1000);
  const fields = { contextId: null, from, messageId, text, timestamp, to: entry.did };
  return { ...fields, sig: signEnvelope(VISITOR_SEED, fields) };
}

function httpBody(messageId, text, metadata) {
  return {
    message: {
      messageId,
      role: VECTORS.roleUser,
      parts: [{ text }],
      metadata,
    },
  };
}

function partText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('\n');
}

function isA2a(type) {
  return new RegExp(`^${VECTORS.mediaType.replace('+', '\\+')}\\b`, 'i').test(type);
}

function aipUnauthenticated(res) {
  const expect = VECTORS.unauthenticated;
  const err = res.json && res.json.error;
  const info = err && Array.isArray(err.details) ? err.details[0] : null;
  return res.status === expect.http
    && isA2a(res.contentType)
    && err
    && err.code === expect.http
    && err.status === expect.status
    && err.message === expect.message
    && info
    && info['@type'] === VECTORS.errorInfoType
    && info.reason === expect.reason
    && info.domain === VECTORS.errorDomain
    && String(info.metadata && info.metadata.jsonRpcCode) === String(expect.jsonRpcCode)
    && !('jsonrpc' in res.json);
}

function taskNotFound(res) {
  const expect = VECTORS.taskNotFound;
  const err = res.json && res.json.error;
  const info = err && Array.isArray(err.details) ? err.details[0] : null;
  return res.status === expect.http
    && isA2a(res.contentType)
    && err
    && err.code === expect.http
    && err.status === expect.status
    && typeof err.message === 'string'
    && err.message.length > 0
    && info
    && info['@type'] === VECTORS.errorInfoType
    && info.reason === expect.reason
    && info.domain === VECTORS.errorDomain;
}

function runCounts(args, cwd) {
  const env = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'SystemRoot']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(GUARD).href, BIN, ...args], {
      cwd, env: { ...env, HOME: cwd }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

function logText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function logLines(path) {
  return logText(path).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------- JSON-RPC vectors, byte for byte

for (const v of WIRE.envelope) {
  const fields = {
    from: v.from, to: v.to, messageId: v.messageId,
    contextId: v.contextId ?? null, timestamp: v.timestamp, text: v.text,
  };
  let got;
  try { got = signingPayload(fields); } catch (e) { got = `THREW: ${e.message}`; }
  check(got === v.signingPayload, `jsonrpc-vector/envelope/${v.name}`,
    got === v.signingPayload ? '' : `want ${v.signingPayload} got ${got}`);
}

for (const v of WIRE.reject.message) {
  const m = v.input ?? v;
  const fields = {
    from: m.from, to: m.to, messageId: m.messageId, contextId: m.contextId ?? null,
    timestamp: m.timestamp, text: m.text, sig: m.sig,
  };
  if (m.recipientDid !== undefined) fields.recipientDid = m.recipientDid;
  const opts = v.verifierNamesNoRecipient ? {} : { recipientDid: v.recipientDid ?? m.to };
  let accepted = true;
  try { accepted = verifyEnvelope(fields, opts); } catch { accepted = false; }
  check(accepted === false, `jsonrpc-vector/reject/${v.name}`);
}

// ---------------------------------------------------------------- JSON-RPC door bytes

{
  const entry = makeEntry();
  const from = didFromSeedHex(VISITOR_SEED);
  const walk = await call(entry, 'POST', MOUNT, {
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: {
        kind: 'message', role: 'user', messageId: 'msg-walk-1', contextId: null,
        parts: [{ kind: 'text', text: 'hello' }],
      },
    },
  }, { 'content-type': 'application/json' });
  check(walk.status === PINNED.walk.status && walk.contentType === PINNED.walk.contentType
    && walk.text === PINNED.walk.body, 'jsonrpc/walk-in-bytes',
    `HTTP ${walk.status} ${walk.contentType} ${walk.text.slice(0, 180)}`);

  const timestamp = Math.floor(Date.now() / 1000);
  const fields = {
    from, to: entry.did, messageId: 'msg-tamper-1', contextId: null, timestamp, text: 'the lamp',
  };
  const tamp = await call(entry, 'POST', MOUNT, {
    jsonrpc: '2.0',
    id: 'msg-tamper-1',
    method: 'message/send',
    params: {
      message: {
        kind: 'message', role: 'user', messageId: fields.messageId, contextId: null,
        parts: [{ kind: 'text', text: 'the lamp!' }],
        metadata: { from, to: entry.did, timestamp, sig: signEnvelope(VISITOR_SEED, fields) },
      },
    },
  }, { 'content-type': 'application/json' });
  check(tamp.status === PINNED.tamp.status && tamp.text === PINNED.tamp.body,
    'jsonrpc/tampered-field-bytes', tamp.text.slice(0, 180));

  const part = await call(entry, 'POST', MOUNT, {
    jsonrpc: '2.0',
    id: 'msg-partial-1',
    method: 'message/send',
    params: {
      message: {
        kind: 'message', role: 'user', messageId: 'msg-partial-1', contextId: null,
        parts: [{ kind: 'text', text: 'hello' }],
        metadata: { from, to: entry.did },
      },
    },
  }, { 'content-type': 'application/json' });
  check(part.status === PINNED.part.status && part.text === PINNED.part.body,
    'jsonrpc/partial-envelope-bytes', part.text.slice(0, 180));

  const stranger = httpBody('msg-not-rpc', 'hello', null);
  const wrongFace = await call(entry, 'POST', MOUNT, stranger, { 'content-type': 'application/json' });
  check(wrongFace.status === 200 && wrongFace.json?.error?.code === ERRORS.METHOD_NOT_FOUND.code
    && wrongFace.json?.error?.message === ERRORS.METHOD_NOT_FOUND.message
    && wrongFace.contentType === 'application/json; charset=utf-8',
    'jsonrpc/http-json-body-on-the-mount-is-method-not-found',
    `HTTP ${wrongFace.status} ${wrongFace.text.slice(0, 180)}`);

  const okMeta = signedMeta(entry, 'msg-rpc-ok', 'hold the lamp');
  const ok = await call(entry, 'POST', MOUNT, {
    jsonrpc: '2.0',
    id: 'msg-rpc-ok',
    method: 'message/send',
    params: {
      message: {
        kind: 'message', role: 'user', messageId: 'msg-rpc-ok', contextId: null,
        parts: [{ kind: 'text', text: 'hold the lamp' }],
        metadata: {
          from: okMeta.from, to: okMeta.to, timestamp: okMeta.timestamp, sig: okMeta.sig,
        },
      },
    },
  }, { 'content-type': 'application/json' });
  const result = ok.json && ok.json.result;
  check(ok.status === 200 && ok.json?.jsonrpc === '2.0' && result?.role === 'agent'
    && result?.metadata?.from === entry.did
    && verifyEnvelope({
      from: result?.metadata?.from, to: result?.metadata?.to, messageId: result?.messageId,
      contextId: result?.contextId ?? null, timestamp: result?.metadata?.timestamp,
      text: partText(result), sig: result?.metadata?.sig,
    }, { recipientDid: from }),
    'jsonrpc/signed-reply-stays-role-agent', `HTTP ${ok.status} ${ok.text.slice(0, 200)}`);
}

// ---------------------------------------------------------------- the card

{
  const entry = makeEntry();
  const list = entry.card.supportedInterfaces;
  check(Array.isArray(list) && list.length === 2, 'card/two-interfaces', JSON.stringify(list));
  check(list?.[0]?.url === BASE && list?.[0]?.protocolBinding === 'JSONRPC'
    && list?.[0]?.protocolVersion === PROTOCOL_VERSION, 'card/jsonrpc-interface-unchanged',
    JSON.stringify(list?.[0]));
  check(list?.[1]?.url === BASE && list?.[1]?.protocolBinding === VECTORS.protocolBinding
    && list?.[1]?.protocolVersion === VECTORS.protocolVersion, 'card/http-json-interface',
    JSON.stringify(list?.[1]));
  check(entry.card.protocolVersion === PROTOCOL_VERSION, 'card/top-level-protocol-version-stays');
  check(entry.card.url === BASE, 'card/url-stays', entry.card.url);
  check(entry.card.securitySchemes?.[SIGNED_ENVELOPE_SCHEME]?.type === VECTORS.scheme,
    'card/signature-scheme-stays');
  check(same(entry.card.securitySchemes?.[SIGNED_ENVELOPE_SCHEME]?.agentEntry?.signedFields, VECTORS.signedFields),
    'card/six-signed-fields');
}

// ---------------------------------------------------------------- HTTP+JSON message:send

{
  const entry = makeEntry();
  const from = didFromSeedHex(VISITOR_SEED);
  const text = 'hold the lamp';
  const meta = signedMeta(entry, 'msg-http-ok', text);
  const res = await call(entry, 'POST', SEND, httpBody('msg-http-ok', text, meta), {
    'content-type': VECTORS.mediaType,
  });
  const message = res.json && res.json.message;
  const replyFields = {
    from: message?.metadata?.from,
    to: message?.metadata?.to,
    messageId: message?.messageId,
    contextId: message?.contextId ?? message?.metadata?.contextId ?? null,
    timestamp: message?.metadata?.timestamp,
    text: partText(message),
    sig: message?.metadata?.sig,
  };
  check(res.status === 200 && isA2a(res.contentType) && message?.role === VECTORS.roleAgent
    && !('jsonrpc' in (res.json || {})) && !res.json?.error,
    'http-json/answers-role-agent', `HTTP ${res.status} ${res.contentType} ${res.text.slice(0, 240)}`);
  check(partText(message) === text && message?.metadata?.from === entry.did
    && message?.metadata?.to === from && message?.metadata?.replyTo === 'msg-http-ok'
    && verifyEnvelope(replyFields, { recipientDid: from }),
    'http-json/reply-verifies-under-the-door', res.text.slice(0, 240));
  check(entry.ledger.has(from) && entry.ledger.size === 1, 'http-json/account-is-the-signer',
    [...entry.ledger.keys()].join(','));

  const tampered = signedMeta(entry, 'msg-http-tamper', 'the lamp');
  tampered.text = 'the lamp!';
  const bad = await call(entry, 'POST', SEND, httpBody('msg-http-tamper', 'the lamp', tampered), {
    'content-type': VECTORS.mediaType,
  });
  const rpcTamper = JSON.parse(PINNED.tamp.body);
  check(aipUnauthenticated(bad) && bad.json.error.data === rpcTamper.error.data
    && !bad.json.error.data?.accepts && entry.ledger.size === 1,
    'http-json/tampered-metadata-text-matches-jsonrpc',
    `HTTP ${bad.status} ${bad.text.slice(0, 240)}`);

  const walk = await call(entry, 'POST', SEND, {
    message: {
      messageId: 'msg-http-walk', role: VECTORS.roleUser, parts: [{ text: 'hello' }],
    },
  }, { 'content-type': VECTORS.mediaType });
  const recipe = JSON.parse(PINNED.walk.body).error.data;
  check(aipUnauthenticated(walk) && same(walk.json?.error?.data, recipe)
    && walk.json?.error?.data?.accepts?.[0]?.scheme === VECTORS.scheme
    && same(walk.json?.error?.data?.accepts?.[0]?.signedFields, VECTORS.signedFields),
    'http-json/walk-in-teaches-the-signature', `HTTP ${walk.status} ${walk.text.slice(0, 240)}`);
  check(entry.ledger.size === 1, 'http-json/walk-in-books-nobody');

  const partial = await call(entry, 'POST', SEND, httpBody('msg-http-partial', 'hello', {
    from, to: entry.did,
  }), { 'content-type': VECTORS.mediaType });
  const rpcPartial = JSON.parse(PINNED.part.body);
  check(aipUnauthenticated(partial) && partial.json.error.data === rpcPartial.error.data
    && !partial.json.error.data?.accepts, 'http-json/partial-envelope-has-no-recipe',
    `HTTP ${partial.status} ${partial.text.slice(0, 240)}`);

  const elsewhere = await call(entry, 'GET', `${MOUNT}/not-a-task`);
  check(elsewhere.status === 404 && elsewhere.text === '{"error":"not found"}'
    && elsewhere.contentType === 'application/json; charset=utf-8'
    && !elsewhere.text.includes(VECTORS.taskNotFound.reason),
    'http-json/unknown-path-stays-not-found', `${elsewhere.status} ${elsewhere.text}`);

  for (const [method, path] of VECTORS.taskRoutes) {
    const body = method === 'GET' || method === 'DELETE' ? null : {};
    const out = await call(entry, method, `${MOUNT}${path}`, body, { 'content-type': VECTORS.mediaType });
    check(taskNotFound(out), `http-json/tasks${path}-${method}`,
      `HTTP ${out.status} ${out.contentType} ${out.text.slice(0, 220)}`);
  }
  const after = await call(entry, 'GET', `${MOUNT}/tasks/task-1`);
  check(taskNotFound(after), 'http-json/tasks-still-missing-after-a-message');
}

// ---------------------------------------------------------------- Bearer is an observation, never an identity

{
  const dir = tmp('ae-a2a-bearer-');
  const logPath = join(dir, 'visits.jsonl');
  const entry = makeEntry({ observer: fileSink(logPath) });
  const from = didFromSeedHex(VISITOR_SEED);
  const issuers = [
    'https://platform.example/agents',
    'https://platform.example:443/agents',
    'https://other.example/x',
  ];
  const bare = await call(entry, 'POST', SEND, {
    message: { messageId: 'msg-no-bearer', role: VECTORS.roleUser, parts: [{ text: 'hello' }] },
  }, { 'content-type': VECTORS.mediaType });
  for (const iss of issuers) {
    const token = bearerToken(iss);
    const res = await call(entry, 'POST', SEND, {
      message: { messageId: `msg-${iss.length}`, role: VECTORS.roleUser, parts: [{ text: 'hello' }] },
    }, authHeaders(token));
    check(res.text === bare.text && !res.text.includes('platform.example')
      && !res.text.includes('other.example') && !res.text.includes('customer-17')
      && !res.text.includes(token), `bearer/refusal-bytes-${iss}`, res.text.slice(0, 160));
  }
  check(entry.ledger.size === 0, 'bearer/books-no-account', [...entry.ledger.keys()].join(','));
  const rows = logLines(logPath);
  const hosts = rows.map((row) => row[VECTORS.observation]).filter(Boolean);
  check(same(hosts, ['platform.example', 'platform.example', 'other.example']),
    'bearer/fileSink-records-the-host', JSON.stringify(rows));
  const blob = logText(logPath);
  check(!blob.includes('did:key:') && !blob.includes('customer-17') && !blob.includes('https://'),
    'bearer/fileSink-has-no-token-and-no-did', blob.slice(0, 300));

  const secretDir = tmp('ae-a2a-secret-');
  const secretLog = join(secretDir, 'visits.jsonl');
  const secretEntry = makeEntry({ observer: fileSink(secretLog) });
  await call(secretEntry, 'POST', SEND, {
    message: { messageId: 'msg-userinfo', role: VECTORS.roleUser, parts: [{ text: 'hello' }] },
  }, authHeaders(bearerToken('https://user:secret@platform.example/a')));
  const secretRows = logLines(secretLog);
  const secretBlob = logText(secretLog);
  check(secretRows.length === 1 && secretRows[0][VECTORS.observation] === 'platform.example'
    && !secretBlob.includes('secret') && !secretBlob.includes('user:'),
    'bearer/userinfo-is-not-the-host', secretBlob.slice(0, 300));

  const junkDir = tmp('ae-a2a-junk-');
  const junkLog = join(junkDir, 'visits.jsonl');
  const junkEntry = makeEntry({ observer: fileSink(junkLog) });
  await call(junkEntry, 'POST', SEND, {
    message: { messageId: 'msg-junk-iss', role: VECTORS.roleUser, parts: [{ text: 'hello' }] },
  }, authHeaders(bearerToken('not-a-url')));
  await call(junkEntry, 'POST', SEND, {
    message: { messageId: 'msg-junk-token', role: VECTORS.roleUser, parts: [{ text: 'hello' }] },
  }, authHeaders('not-a-jwt'));
  const junkRows = logLines(junkLog);
  check(junkRows.length === 2 && junkRows.every((row) => !Object.hasOwn(row, VECTORS.observation)),
    'bearer/unreadable-token-records-nothing', JSON.stringify(junkRows));

  const seen = [];
  const gaEntry = makeEntry({
    observer: gaSink({
      measurementId: 'G-TEST1234',
      apiSecret: 'test-secret',
      endpoint: 'http://127.0.0.1/collect',
      fetchImpl: (url, init) => {
        seen.push(String(init?.body ?? ''));
        return Promise.resolve({ ok: true });
      },
    }),
  });
  await call(gaEntry, 'POST', SEND, {
    message: { messageId: 'msg-ga', role: VECTORS.roleUser, parts: [{ text: 'hello' }] },
  }, authHeaders(bearerToken('https://platform.example/agents')));
  check(seen.length === 1 && !seen[0].includes(VECTORS.observation) && !seen[0].includes('platform.example'),
    'bearer/gaSink-omits-the-issuer', seen[0]?.slice(0, 300) || 'no post');

  const jsonRun = await runCounts(['counts', '--json', '--log', logPath], dir);
  let counted = null;
  try { counted = JSON.parse(jsonRun.stdout); } catch { counted = null; }
  const platforms = counted && counted[VECTORS.countsKey];
  check(jsonRun.code === 0 && same(platforms, { 'platform.example': 2, 'other.example': 1 })
    && !jsonRun.stdout.includes('customer-17') && !jsonRun.stdout.includes('did:key:')
    && !jsonRun.stdout.includes('https://')
    && !(counted?.who?.signed && Object.hasOwn(counted.who.signed, 'platform.example'))
    && !(counted?.who?.signed && Object.hasOwn(counted.who.signed, 'other.example')),
    'counts/platforms-json', `exit ${jsonRun.code} ${jsonRun.stdout.slice(0, 400)} ${jsonRun.stderr.slice(0, 200)}`);
  const textRun = await runCounts(['counts', '--log', logPath], dir);
  check(textRun.code === 0 && textRun.stdout.includes('platform.example')
    && textRun.stdout.includes('other.example') && textRun.stdout.includes(VECTORS.countsKey)
    && !textRun.stdout.includes('customer-17'),
    'counts/platforms-text', textRun.stdout.slice(0, 400));

  const idDir = tmp('ae-a2a-identity-');
  const idLog = join(idDir, 'visits.jsonl');
  const idEntry = makeEntry({ observer: fileSink(idLog) });
  const text = 'hold the lamp';
  const meta = signedMeta(idEntry, 'msg-with-bearer', text);
  const answered = await call(idEntry, 'POST', SEND, httpBody('msg-with-bearer', text, meta),
    authHeaders(bearerToken('https://platform.example/agents', 'not-the-customer')));
  const message = answered.json && answered.json.message;
  check(answered.status === 200 && message?.role === VECTORS.roleAgent
    && message?.metadata?.to === from && idEntry.ledger.has(from) && idEntry.ledger.size === 1
    && ![...idEntry.ledger.keys()].some((key) => key.includes('platform') || key.includes('not-the-customer'))
    && !answered.text.includes('platform.example') && !answered.text.includes('not-the-customer'),
    'bearer/signature-stays-the-identity', `HTTP ${answered.status} ledger ${[...idEntry.ledger.keys()].join(',')} ${answered.text.slice(0, 180)}`);
  const idRows = logLines(idLog);
  check(idRows.some((row) => row[VECTORS.observation] === 'platform.example')
    && !logText(idLog).includes('did:key:'),
    'bearer/signed-knock-still-records-the-host', JSON.stringify(idRows));
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true });

if (failures.length) {
  console.error(`FAILED ${failures.length} of ${passed + failures.length}`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`ok ${passed}`);
