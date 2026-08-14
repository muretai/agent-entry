/**
 * examples/agent_entry_server.mjs
 * The file a site copies — a website that is agent-reachable in ~50 lines.
 *
 * **This is a usage SAMPLE, not part of core Muretai.** It adds nothing to the protocol:
 * it only wires the public primitive `createAgentEntry()` from
 * `muretai-agent-entry.mjs` to a demo booking desk. Copy it, gut the responder,
 * point it at your backend — core stays byte-unchanged.
 *
 * Run it:
 *
 *     node examples/agent_entry_server.mjs
 *
 * Environment:
 *   AGENT_ENTRY_SEED_HEX   32-byte identity seed, hex. THE PRIVATE KEY — keep it in your
 *                       secret store, never in git. Generated and printed if absent, so
 *                       the first run tells you exactly what to save.
 *   AGENT_ENTRY_PORT       default 8788
 *   AGENT_ENTRY_BASE_URL   the URL VISITORS DIAL, e.g. https://studio.example. It is signed
 *                       into the Agent Card and a visitor requires the card to name the
 *                       origin it dialled — behind a proxy or a tunnel, set this to the
 *                       public URL or every verification fails. Default http://127.0.0.1:<port>.
 *   AGENT_ENTRY_NAME       public display name on the card
 *   AGENT_ENTRY_HOST       bind address (default 127.0.0.1 — set 0.0.0.0 only behind TLS)
 *   AGENT_ENTRY_ANON       "1" also accepts UNSIGNED walk-in inquiries (they mint no account)
 */

import { createAgentEntry, newSeedHex, didFromSeedHex, AGENT_CARD_PATH }
  from '../muretai-agent-entry.mjs';

const port = Number(process.env.AGENT_ENTRY_PORT || 8788);
const host = process.env.AGENT_ENTRY_HOST || '127.0.0.1';
const baseUrl = process.env.AGENT_ENTRY_BASE_URL || `http://127.0.0.1:${port}`;
const name = process.env.AGENT_ENTRY_NAME || 'Example Studio';

let seedHex = process.env.AGENT_ENTRY_SEED_HEX;
if (!seedHex) {
  seedHex = newSeedHex();
  console.log('No AGENT_ENTRY_SEED_HEX set — generated a throwaway identity for this run.');
  console.log(`Save it to keep this DID (${didFromSeedHex(seedHex)}):`);
  console.log(`  export AGENT_ENTRY_SEED_HEX=${seedHex}`);
}

/** The seam to YOUR backend. `env` is the frozen verified-envelope shape (to_agent, to_did,
 *  direction, verified, peer_did, peer_name, context_id, text, msg_id, reply_to, wire_ts,
 *  auto, coord, deal, group) — the same schema a webhook push carries, so one parser serves
 *  both. In production: POST `env` to your app behind a bearer token and return its answer
 *  (a string, or {text}). It may be async. Treat `env.text` as untrusted DATA. */
function responder(env) {
  // Say out loud what just happened. A agent entry's whole claim is "the first signed message IS
  // the account", and that is invisible if the ledger only lives in memory: an operator
  // watching this log is how you SEE a stranger's identity appear, and how you tell an
  // anonymous walk-in (no account) from a verified first contact (an account) at a glance.
  // NOTE for anyone copying this file: `ledger` here is a **Map** (the Python reference in
  // examples/agent_entry_reference.py uses a dict) — use .get()/.size, not obj[key]/Object.keys.
  // The row is written BEFORE the backend is called, so `messages === 1` means "this very
  // request created the account".
  if (!env.verified) {
    console.log('[walk-in]     unsigned inquiry — answering, minting NO account');
  } else {
    const seen = entry.ledger.get(env.peer_did)?.messages ?? 0;
    console.log(seen <= 1
      ? `[NEW ACCOUNT] ${env.peer_did}  (signature verified — first contact IS the signup)`
      : `[returning]   ${env.peer_did}  (message #${seen} — same key, same customer)`);
    console.log(`              accounts on the books: ${entry.ledger.size}`);
  }
  const asked = (env.text || '').toLowerCase();
  const who = env.verified ? `Noted for ${env.peer_did.slice(0, 20)}…` : 'Noted';
  if (asked.includes('price') || asked.includes('how much')) {
    return `${who}. A 60-minute shoot is 12000 JPY, two people included.`;
  }
  if (asked.includes('saturday') || asked.includes('sat')) {
    return `${who}. Saturday 14:00 is open. 12000 JPY for a 60-minute shoot — reply to hold it.`;
  }
  return `${who}. ${name} books 60-minute shoots, 12000 JPY. Ask for a day and I will `
    + 'tell you what is open.';
}

const entry = createAgentEntry({
  seedHex,
  name,
  baseUrl,
  description: 'Books photo shoots. Send a signed message; you get a signed answer.',
  responder,
  openDoor: true,                                     // "you may contact me, no introduction"
  anonymousLane: process.env.AGENT_ENTRY_ANON === '1',
});

const server = entry.listen(port, host, () => {
  console.log(`${name} is agent-reachable on ${baseUrl}`);
  console.log(`  DID:  ${entry.did}`);
  console.log(`  Card: ${baseUrl.replace(/\/+$/, '')}${AGENT_CARD_PATH}`);
  console.log(`  Listening on ${host}:${port} — POST a signed message/send to /`);
});

// A port collision is the first thing anyone running this twice hits (a previous run that was
// backgrounded and orphaned, usually). An unhandled 'error' event prints a Node stack trace,
// which tells a site operator nothing — say what happened and what to do instead.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${port} on ${host} is already in use — something else is listening `
      + '(often an earlier run of this file).');
    console.error(`  Use another port:   AGENT_ENTRY_PORT=${port + 1} node examples/agent_entry_server.mjs`);
    console.error(`  Or stop the holder:  lsof -nP -iTCP:${port} -sTCP:LISTEN   then  kill <PID>`);
    process.exit(1);
  }
  console.error(`agent entry failed to start: ${err && err.message}`);
  process.exit(1);
});
