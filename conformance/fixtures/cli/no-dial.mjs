// SPDX-License-Identifier: MIT
// Preloaded with `node --import` by conformance/decide.mjs into every `decide` child. Stricter than
// loopback-only.mjs: nothing may be dialled at all, not even this machine. Every socket connect
// (TCP, TLS, a unix path), every fetch, every DNS question, every UDP socket and every WebSocket
// is refused before anything is sent, and recorded.
//
// Rows go, one JSON line each, to the file AE_NO_DIAL_LOG names:
//   { kind: 'loaded', pid }
//   { kind: 'connect' | 'fetch' | 'dns' | 'udp' | 'websocket', detail }
import dgram from 'node:dgram';
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

const LOG = process.env.AE_NO_DIAL_LOG || null;

function note(row) {
  if (!LOG) return;
  try { appendFileSync(LOG, `${JSON.stringify(row)}\n`); } catch { /* a guard never throws */ }
}

function refusal(kind, detail) {
  note({ kind, detail: String(detail).slice(0, 200) });
  return Object.assign(new Error(`${kind} refused by the no-dial guard: ${String(detail).slice(0, 80)}`),
    { code: 'ECONNREFUSED' });
}

net.Socket.prototype.connect = function refusedConnect(...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0];
  const detail = opts && typeof opts === 'object'
    ? (opts.path ?? `${opts.host ?? 'localhost'}:${opts.port}`)
    : `${args[1] ?? 'localhost'}:${opts}`;
  const error = refusal('connect', detail);
  process.nextTick(() => this.destroy(error));
  return this;
};

globalThis.fetch = async function refusedFetch(input) {
  throw refusal('fetch', typeof input === 'string' || input instanceof URL ? input : input?.url);
};

if (typeof globalThis.WebSocket === 'function') {
  globalThis.WebSocket = function refusedWebSocket(url) { throw refusal('websocket', url); };
}

for (const name of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname',
  'resolveMx', 'resolveNs', 'resolveSrv', 'resolveTxt', 'reverse']) {
  if (typeof dns[name] !== 'function') continue;
  dns[name] = function refusedDns(host, ...rest) {
    const error = refusal('dns', host);
    const cb = rest.find((a) => typeof a === 'function');
    if (cb) process.nextTick(() => cb(error));
    else throw error;
  };
  if (dns.promises && typeof dns.promises[name] === 'function') {
    dns.promises[name] = async (host) => { throw refusal('dns', host); };
  }
}

dgram.createSocket = function refusedUdp(type) { throw refusal('udp', typeof type === 'object' ? type?.type : type); };

syncBuiltinESMExports();

note({ kind: 'loaded', pid: process.pid });
