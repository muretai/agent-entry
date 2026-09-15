/**
 * Harbor Lamp — a live Agent Entry you can show an investor or a site owner.
 *
 * This is a usage SAMPLE, not part of the module. The door is `createAgentEntry()`.
 * The page is what a human sees on GET /. The three buttons drive a real visiting
 * knock against that same door (in-process, the protocol a stranger would run).
 *
 *     node examples/live-demo.mjs
 *     open http://127.0.0.1:8788
 *
 * Unsigned inquiry → refusal that teaches how to knock, ledger still empty.
 * First signed knock → the key is the account.
 * Second signed knock → the same customer, recognised.
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_CARD_PATH,
  AGENT_ENTRY_REL,
  bodySignpost,
  createAgentEntry,
  didFromSeedHex,
  knockAgentEntry,
  newSeedHex,
} from '../muretai-agent-entry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SATURDAY_ASK = 'Do you have a table Saturday 19:00 for two?';
export const RETURN_ASK = 'Same party, Saturday 19:00 — please hold it.';
export const UNSIGNED_ASK = 'Table for two this Saturday?';

function pageHtml() {
  return readFileSync(join(HERE, 'live-demo.html'), 'utf8');
}

export function fetchEntry(entry) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const out = await entry.handleRequestAsync(
      init.method || 'GET',
      parsed.pathname + parsed.search,
      init.headers || {},
      Buffer.from(init.body || ''),
    );
    return new Response(out.body, { status: out.status, headers: out.headers });
  };
}

export function snapshotLedger(entry) {
  return [...entry.ledger.entries()].map(([did, row]) => ({
    did,
    messages: row.messages,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
  }));
}

export function createHarborLampEntry({
  seedHex,
  baseUrl,
  howToUrl = `${baseUrl}/#how`,
} = {}) {
  if (!seedHex) throw new TypeError('createHarborLampEntry: seedHex is required');
  if (!baseUrl) throw new TypeError('createHarborLampEntry: baseUrl is required');
  return createAgentEntry({
    seedHex,
    name: 'Harbor Lamp',
    baseUrl,
    howToUrl,
    openDoor: true,
    description: 'Neighborhood restaurant. A signed message is the reservation request '
      + 'and the customer account. No signup form. The shop keeps the ledger.',
    skills: [{
      id: 'book-table',
      name: 'restaurant-reservation',
      description: 'Request a table by party size, date and time. The signed reply is a '
        + 'pending request, not a confirmed booking.',
      tags: ['restaurant', 'reservation', 'booking'],
      examples: [SATURDAY_ASK],
    }],
    responder(env) {
      return JSON.stringify({
        type: 'restaurant_reservation_request',
        customer_did: env.owner_did || env.peer_did,
        request: env.text,
        status: 'pending_shop_confirmation',
      });
    },
  });
}

function unsignedBody(text) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 'unsigned-walk-in',
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: 'unsigned-walk-in',
        parts: [{ kind: 'text', text }],
      },
    },
  });
}

export async function runDemoStep(entry, session, action) {
  const cardUrl = `${entry.card.url}${AGENT_CARD_PATH}`;
  const fetchImpl = fetchEntry(entry);

  if (action === 'reset') {
    writeFileSync(session.keyPath, `${newSeedHex()}\n`, { mode: 0o600 });
    session.visitorDid = didFromSeedHex(readFileSync(session.keyPath, 'utf8').trim());
    return {
      action,
      ok: true,
      visitorDid: session.visitorDid,
      accounts: snapshotLedger(entry),
    };
  }

  if (action === 'unsigned') {
    const out = await entry.handleRequestAsync(
      'POST',
      '/',
      { 'content-type': 'application/json', 'user-agent': 'curl/8' },
      Buffer.from(unsignedBody(UNSIGNED_ASK)),
    );
    const reply = JSON.parse(out.body.toString('utf8'));
    return {
      action,
      ok: false,
      asked: UNSIGNED_ASK,
      status: out.status,
      error: reply.error || null,
      accounts: snapshotLedger(entry),
      accountCount: entry.ledger.size,
    };
  }

  if (action !== 'first' && action !== 'again') {
    throw new TypeError(`unknown demo action: ${action}`);
  }

  const asked = action === 'first' ? SATURDAY_ASK : RETURN_ASK;
  if (action === 'again') {
    const existing = snapshotLedger(entry)
      .find((row) => row.did === session.visitorDid);
    if (!existing) {
      const err = new Error('knock as the same customer after the first signed visit');
      err.code = 'DEMO_ORDER';
      throw err;
    }
  }

  const knocked = await knockAgentEntry(cardUrl, {
    keyPath: session.keyPath,
    text: asked,
    fetchImpl,
  });
  session.visitorDid = knocked.did;
  const row = snapshotLedger(entry).find((item) => item.did === knocked.did);
  return {
    action,
    ok: knocked.ok,
    asked,
    did: knocked.did,
    status: knocked.status,
    text: knocked.ok ? knocked.text : null,
    booking: knocked.booking || null,
    error: knocked.ok ? null : knocked.error,
    requirements: knocked.requirements || null,
    messages: row?.messages ?? 0,
    accounts: snapshotLedger(entry),
  };
}

export function newDemoSession(dir = mkdtempSync(join(tmpdir(), 'harbor-lamp-demo-'))) {
  const keyPath = join(dir, 'visitor-seed');
  writeFileSync(keyPath, `${newSeedHex()}\n`, { mode: 0o600 });
  return {
    dir,
    keyPath,
    visitorDid: didFromSeedHex(readFileSync(keyPath, 'utf8').trim()),
  };
}

function demoIndexHeaders() {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    Link: `<${AGENT_CARD_PATH}>; rel="${AGENT_ENTRY_REL}"`,
    'Cache-Control': 'no-store',
  };
}

export async function handleDemoRequest(entry, session, method, path, headers, bodyBuffer) {
  const url = new URL(path, 'http://127.0.0.1');
  const route = url.pathname;

  if ((method === 'GET' || method === 'HEAD') && (route === '/' || route === '/index.html')) {
    const html = pageHtml()
      .replaceAll('{{SIGNPOST}}', bodySignpost(AGENT_CARD_PATH))
      .replaceAll('{{SHOP_DID}}', entry.did)
      .replaceAll('{{CARD_PATH}}', AGENT_CARD_PATH)
      .replaceAll('{{VISITOR_DID}}', session.visitorDid);
    const buf = Buffer.from(html, 'utf8');
    return {
      status: 200,
      headers: { ...demoIndexHeaders(), 'Content-Length': String(buf.length) },
      body: method === 'HEAD' ? Buffer.alloc(0) : buf,
    };
  }

  if ((method === 'GET' || method === 'HEAD') && route === '/demo/state') {
    const payload = Buffer.from(JSON.stringify({
      shopDid: entry.did,
      visitorDid: session.visitorDid,
      cardPath: AGENT_CARD_PATH,
      accounts: snapshotLedger(entry),
    }), 'utf8');
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(payload.length),
      },
      body: method === 'HEAD' ? Buffer.alloc(0) : payload,
    };
  }

  if (method === 'POST' && route === '/demo/step') {
    let action;
    try {
      action = JSON.parse(bodyBuffer.toString('utf8') || '{}').action;
    } catch {
      const payload = Buffer.from(JSON.stringify({ error: 'body must be JSON' }), 'utf8');
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(payload.length) },
        body: payload,
      };
    }
    try {
      const result = await runDemoStep(entry, session, action);
      const payload = Buffer.from(JSON.stringify(result), 'utf8');
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(payload.length) },
        body: payload,
      };
    } catch (err) {
      const status = err && err.code === 'DEMO_ORDER' ? 409 : 400;
      const payload = Buffer.from(JSON.stringify({
        error: err && err.message ? err.message : String(err),
      }), 'utf8');
      return {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(payload.length) },
        body: payload,
      };
    }
  }

  return entry.handleRequestAsync(method, path, headers, bodyBuffer);
}

export function listenHarborLampDemo({
  seedHex,
  baseUrl,
  port = 8788,
  host = '127.0.0.1',
  onReady,
} = {}) {
  const entry = createHarborLampEntry({ seedHex, baseUrl });
  const session = newDemoSession();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', () => { try { res.destroy(); } catch { /* already gone */ } });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      Promise.resolve()
        .then(() => handleDemoRequest(entry, session, req.method, req.url, req.headers, body))
        .then(({ status, headers, body: out }) => {
          res.writeHead(status, headers);
          res.end(req.method === 'HEAD' ? undefined : out);
        })
        .catch(() => { try { res.destroy(); } catch { /* already gone */ } });
    });
  });
  const tidy = () => {
    try { unlinkSync(session.keyPath); } catch { /* gone */ }
    try { rmSync(session.dir, { recursive: true, force: true }); } catch { /* gone */ }
  };
  server.on('close', tidy);
  process.once('exit', tidy);
  server.listen(port, host, () => {
    if (onReady) onReady({ server, entry, session });
  });
  return { server, entry, session };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.AGENT_ENTRY_PORT || 8788);
  const host = process.env.AGENT_ENTRY_HOST || '127.0.0.1';
  const baseUrl = process.env.AGENT_ENTRY_BASE_URL || `http://${host}:${port}`;
  let seedHex = process.env.AGENT_ENTRY_SEED_HEX;
  if (!seedHex) {
    seedHex = newSeedHex();
    console.log('No AGENT_ENTRY_SEED_HEX — throwaway shop identity for this run.');
    console.log(`  export AGENT_ENTRY_SEED_HEX=${seedHex}`);
  }
  listenHarborLampDemo({
    seedHex,
    baseUrl,
    port,
    host,
    onReady({ entry }) {
      const url = `${baseUrl.replace(/\/$/, '')}/`;
      console.log(`Harbor Lamp is open at ${url}`);
      console.log(`  Shop DID: ${entry.did}`);
      console.log(`  Card:     ${entry.card.url}${AGENT_CARD_PATH}`);
      console.log('  Show this page. Press the three buttons in order.');
    },
  }).server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. AGENT_ENTRY_PORT=${port + 1} node examples/live-demo.mjs`);
      process.exit(1);
    }
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  });
}
