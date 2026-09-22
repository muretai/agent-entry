// SPDX-License-Identifier: MIT
// Preloaded with `node --import` by conformance/cli.mjs into every CLI child it starts, and
// imported by the runner itself. The suite must never dial out: every outbound socket to an
// address that is not this machine (loopback, or one of its own interface addresses) is
// refused BEFORE a DNS lookup or a packet, and recorded. Every child process is recorded too,
// so the runner can prove `doctor` launched no headless browser.
//
// Rows go to `guardLog` in-process and, when AE_CLI_GUARD_LOG names a file, one JSON line each:
//   { kind: 'loaded', pid }
//   { kind: 'connect', host, port, allowed }      (allowed false = blocked, nothing sent)
//   { kind: 'fetch', url, allowed }
//   { kind: 'spawn', command, args }
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { networkInterfaces } from 'node:os';

const LOG = process.env.AE_CLI_GUARD_LOG || null;
export const guardLog = [];

function note(row) {
  guardLog.push(row);
  if (LOG) {
    try { appendFileSync(LOG, `${JSON.stringify(row)}\n`); } catch { /* a guard never throws */ }
  }
}

const OWN = new Set();
for (const list of Object.values(networkInterfaces())) {
  for (const addr of list || []) OWN.add(String(addr.address).toLowerCase());
}

/** True for an address that cannot leave this machine. */
export function isLocalHost(host) {
  if (host === undefined || host === null || host === '') return true;   // Node's default is localhost
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h === '::1' || /^::ffff:127\./.test(h)) return true;
  return OWN.has(h);
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0];                    // net.connect's normalized args
  let host;
  let port;
  let path;
  if (opts && typeof opts === 'object') ({ host, port, path } = opts);
  else if (typeof opts === 'string' && !/^\d+$/.test(opts)) path = opts;
  else { port = opts; host = typeof args[1] === 'string' ? args[1] : undefined; }
  if (path) return originalConnect.apply(this, args);         // a unix socket / pipe stays local
  const allowed = isLocalHost(host);
  note({ kind: 'connect', host: host ?? 'localhost', port: Number(port) || null, allowed });
  if (!allowed) {
    const error = Object.assign(new Error(`connect refused by the test guard: ${host}:${port} is not loopback`),
      { code: 'ECONNREFUSED' });
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return originalConnect.apply(this, args);
};

const originalFetch = globalThis.fetch;
if (typeof originalFetch === 'function') {
  globalThis.fetch = async function guardedFetch(input, init) {
    let host = null;
    const url = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? '');
    try { host = new URL(url).hostname; } catch { /* let fetch report it */ }
    const allowed = host === null || isLocalHost(host);
    note({ kind: 'fetch', url: url.slice(0, 200), allowed });
    if (!allowed) throw new TypeError(`fetch failed (the test guard allows loopback only) for ${url.slice(0, 80)}`);
    return originalFetch.call(this, input, init);
  };
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[name];
  if (typeof original !== 'function') continue;
  childProcess[name] = function guardedChild(command, ...rest) {
    const args = Array.isArray(rest[0]) ? rest[0].map(String) : [];
    note({ kind: 'spawn', command: String(command), args });
    return original.call(this, command, ...rest);
  };
}
syncBuiltinESMExports();

note({ kind: 'loaded', pid: process.pid });
