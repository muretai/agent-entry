// worker.mjs -- the landing-lease Worker and its Durable Object.
//
//   POST /lease/<repo>   body {"payload": {...}, "sig": "..."}   -> the DO for <repo>
//   GET  /health         {"ok": true}   (reachability only: tools/appl-init.sh --check)
//
// One Durable Object per repository, reached by name; the DO serialises its requests and
// runs lease-core.mjs over an adapter to its own SQL storage. The decision logic, the check
// order and why the DO holds no key are in lease-core.mjs; this file is only plumbing.

import { handle, isAllowed, DEFAULT_TTL_S } from './lease-core.mjs';

const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_BODY = 4096;

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function repoOf(url) {
  const m = /^\/lease\/([^/?]+)$/.exec(new URL(url).pathname);
  if (!m) return null;
  let repo;
  try {
    repo = decodeURIComponent(m[1]);
  } catch (e) {
    return null;
  }
  return REPO_RE.test(repo) ? repo : null;
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health') return json(200, { ok: true });
    if (request.method !== 'POST') return json(405, { ok: false, reason: 'method-not-allowed' });
    const repo = repoOf(request.url);
    if (!repo) return json(404, { ok: false, reason: 'not-found' });
    // single-tenant: the DO name is the repository name and nothing else
    const id = env.LANDING_LEASE.idFromName('landing:' + repo);
    return env.LANDING_LEASE.get(id).fetch(request);
  },
};

// The storage adapter lease-core.mjs expects, over ctx.storage.sql. The schema is created
// on the first WRITE, never on a read, so a request refused before it writes (a stranger,
// a forgery) leaves this DO's storage exactly as it found it.
class SqlStore {
  constructor(sql) {
    this.sql = sql;
    this.ready = false;
  }

  exists() {
    if (this.ready) return true;
    const n = this.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'lease'").one().n;
    this.ready = n > 0;
    return this.ready;
  }

  ensure() {
    if (this.exists()) return;
    this.sql.exec('CREATE TABLE IF NOT EXISTS lease (repo TEXT PRIMARY KEY, holder TEXT, until INTEGER NOT NULL, epoch INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS nonce (did TEXT NOT NULL, nonce TEXT NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY (did, nonce))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS hit (did TEXT NOT NULL, at INTEGER NOT NULL, exp INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS hit_did_at ON hit (did, at)');
    this.ready = true;
  }

  async getRow(repo) {
    if (!this.exists()) return null;
    const rows = this.sql.exec('SELECT repo, holder, until, epoch FROM lease WHERE repo = ?', repo).toArray();
    return rows.length ? { repo: rows[0].repo, holder: rows[0].holder, until: rows[0].until, epoch: rows[0].epoch } : null;
  }

  // casRow and useNonce ask the statement WHAT it changed (RETURNING, one row per row
  // written) instead of counting side effects. A cursor's rowsWritten is 0 until it is
  // consumed, and even consumed it counts index writes: a fresh nonce reports 2 under
  // workerd, because the composite primary key has an index of its own. Comparing it to
  // 1 refused every request in production.
  async casRow(repo, expectedEpoch, row) {
    this.ensure();
    // "no row" is epoch 0: materialise it only when the caller expects exactly that
    this.sql.exec('INSERT OR IGNORE INTO lease (repo, holder, until, epoch) SELECT ?, NULL, 0, 0 WHERE ? = 0', repo, expectedEpoch).toArray();
    const changed = this.sql.exec('UPDATE lease SET holder = ?, until = ?, epoch = ? WHERE repo = ? AND epoch = ? RETURNING repo',
      row.holder, row.until, row.epoch, repo, expectedEpoch).toArray();
    return changed.length === 1;
  }

  async useNonce(did, nonce, expiresAtMs) {
    this.ensure();
    const inserted = this.sql.exec('INSERT OR IGNORE INTO nonce (did, nonce, exp) VALUES (?, ?, ?) RETURNING did',
      did, nonce, expiresAtMs).toArray();
    return inserted.length === 1;
  }

  async addHit(did, atMs, expiresAtMs) {
    this.ensure();
    this.sql.exec('INSERT INTO hit (did, at, exp) VALUES (?, ?, ?)', did, atMs, expiresAtMs).toArray();
  }

  async countHits(did, sinceMs) {
    if (!this.exists()) return 0;
    return this.sql.exec('SELECT count(*) AS n FROM hit WHERE did = ? AND at > ?', did, sinceMs).one().n;
  }

  async sweep(nowMs) {
    if (!this.exists()) return;
    this.sql.exec('DELETE FROM nonce WHERE exp <= ?', nowMs).toArray();
    this.sql.exec('DELETE FROM hit WHERE exp <= ?', nowMs).toArray();
  }
}

export class LandingLease {
  constructor(ctx, env) {
    this.env = env;
    this.store = new SqlStore(ctx.storage.sql);
    // One request at a time. The DO's input gate already serialises storage, but the
    // signature check awaits WebCrypto between the read and the CAS; a queue makes the
    // whole read-verify-write one step, and the epoch CAS stays as the second wall.
    this.queue = Promise.resolve();
  }

  async fetch(request) {
    const repo = repoOf(request.url);
    if (!repo) return json(404, { ok: false, reason: 'not-found' });
    const raw = await request.text();
    let envelope = null;
    if (raw.length <= MAX_BODY) {
      try {
        envelope = JSON.parse(raw);
      } catch (e) {
        envelope = null;
      }
    }
    const ttl = Number(this.env.LEASE_TTL_S);
    const run = () => handle(this.store, {
      repo, envelope, now: Date.now(),
      ttlS: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_S,
      isAllowed, env: this.env,
    });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    try {
      const r = await result;
      return json(r.status, r.body);
    } catch (e) {
      return json(500, { ok: false, reason: 'internal' });
    }
  }
}
