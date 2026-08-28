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
 *                       It MAY include a path (https://example.com/support): the entry then
 *                       answers THERE and 404s the bare host, so one hostname can hold
 *                       several agents — a front desk, support, sales — each its own key.
 *   AGENT_ENTRY_DOMAINS    comma-separated bare domains this entry speaks for, e.g.
 *                       "example.com". Half a proof: the domain must ALSO serve a
 *                       credential naming this DID at /.well-known/did-configuration.json,
 *                       or a verifier correctly reports the agent withdrew its side.
 *                       At most 5, and every segment must be a bare domain — a doubled or
 *                       trailing comma REFUSES to start rather than quietly publishing
 *                       one name fewer than you wrote.
 *   AGENT_ENTRY_NAME       public display name on the card
 *   AGENT_ENTRY_HOST       bind address (default 127.0.0.1 — set 0.0.0.0 only behind TLS)
 *   AGENT_ENTRY_ANON       "1" also accepts UNSIGNED walk-in inquiries (they mint no account)
 *   AGENT_ENTRY_SIGNED_RATE / AGENT_ENTRY_SIGNED_RATE_TOTAL
 *                       signed replies per minute per ACCOUNT and for the whole entry.
 *                       Defaults are generous; LOWER THEM if your responder calls a model —
 *                       the signature costs microseconds, the answer may not. 0 disables a tier.
 *   AGENT_ENTRY_GUEST      "1" = GUEST MOUNT: coexist with a site that keeps its own front
 *                       page. The entry serves its card paths and the POST door named by
 *                       AGENT_ENTRY_BASE_URL (which must then carry that path, e.g.
 *                       https://example.com/agent) and answers NOTHING at `/` — no notice,
 *                       no OPTIONS, no POST. Point your proxy at the door path and the
 *                       well-known paths; the site keeps everything else, unchanged.
 *   AGENT_ENTRY_WBA_JWKS   OPTIONAL: a JWKS document {"keys":[…]} as one JSON string —
 *                       the Web Bot Auth key directory (verified out of band) whose
 *                       holders this entry should RECOGNISE on inbound requests. Off
 *                       when absent. Recognition only ADDS identity (env.wba_did);
 *                       it never changes a verdict.
 */

import { createAgentEntry, newSeedHex, didFromSeedHex, trimOuter, AGENT_CARD_PATH }
  from '../muretai-agent-entry.mjs';

const port = Number(process.env.AGENT_ENTRY_PORT || 8788);
const host = process.env.AGENT_ENTRY_HOST || '127.0.0.1';
const baseUrl = process.env.AGENT_ENTRY_BASE_URL || `http://127.0.0.1:${port}`;
const name = process.env.AGENT_ENTRY_NAME || 'Example Studio';
// An absent (or blank) variable means NO domains at all, and the card then carries no
// `domains` key. Anything else is split on ',' and every segment is handed on AS WRITTEN:
// an EMPTY segment (`a,,b`, or a trailing comma) is REFUSED by createAgentEntry, never
// skipped. A name lost in an edit looks exactly like a harmless typo, and starting with
// fewer domains than the operator named is the same silent mismatch `canonicalBaseUrl`
// refuses one field over. Must match the split rule in examples/agent_entry_reference.py.
//
// "Blank" is `trimOuter` — the intersection `canonicalDomains` folds with — and NOT
// `trim()`, which is where the two runners drifted apart: `trim()` also removes U+FEFF and
// Python's `strip()` also removes \x1c-\x1f and U+0085, so the SAME variable got two
// verdicts. Measured: `AGENT_ENTRY_DOMAINS="\x1c"` started the Python runner with no
// domains and made this one exit 2; a BOM — what a paste out of a spreadsheet or a Windows
// .env carries — did exactly the reverse. One fold, one verdict.
const rawDomains = process.env.AGENT_ENTRY_DOMAINS || '';
const domains = trimOuter(rawDomains) ? rawDomains.split(',') : [];

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
  // Say out loud what just happened. An agent entry's whole claim is "the first signed message IS
  // the account", and that is invisible if the ledger only lives in memory: an operator
  // watching this log is how you SEE a stranger's identity appear, and how you tell an
  // anonymous walk-in (no account) from a verified first contact (an account) at a glance.
  // `[WBA]` is the transport-level identity (T107): the request's HTTP signature named a
  // key we were configured to recognise — identification, never authorship of the text.
  if (env.wba_did) {
    console.log(`[WBA]         transport signed by ${env.wba_did}`);
  }
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

// A bad AGENT_ENTRY_BASE_URL or AGENT_ENTRY_DOMAINS throws HERE, before the socket is
// bound: the entry never starts and never publishes a claim no visitor could use. The
// message names the value and what to paste instead, so print it plainly — a stack trace
// tells a site operator nothing.
let entry;
try {
  // A malformed AGENT_ENTRY_WBA_JWKS refuses to start, same posture as a bad domain
  // list: silently starting without the keys the operator named only looks protective.
  let wbaVerifiers = null;
  if (process.env.AGENT_ENTRY_WBA_JWKS) {
    try {
      wbaVerifiers = JSON.parse(process.env.AGENT_ENTRY_WBA_JWKS);
    } catch {
      throw new TypeError('AGENT_ENTRY_WBA_JWKS is not valid JSON — paste the key '
        + 'directory body ({"keys":[…]}) as one JSON string');
    }
  }
  entry = createAgentEntry({
    seedHex,
    name,
    baseUrl,
    domains,
    description: 'Books photo shoots. Send a signed message; you get a signed answer.',
    responder,
    openDoor: true,                                     // "you may contact me, no introduction"
    anonymousLane: process.env.AGENT_ENTRY_ANON === '1',
    // The SIGNED lane's ceilings. Left unset they are the library defaults, which no
    // conversational peer meets. LOWER THEM if this responder calls a model: verifying a
    // signature costs microseconds, and what the ceiling actually protects is whatever you
    // put behind `responder`.
    ...(process.env.AGENT_ENTRY_SIGNED_RATE
      ? { signedRatePerMin: Number(process.env.AGENT_ENTRY_SIGNED_RATE) } : {}),
    ...(process.env.AGENT_ENTRY_SIGNED_RATE_TOTAL
      ? { signedRatePerMinTotal: Number(process.env.AGENT_ENTRY_SIGNED_RATE_TOTAL) } : {}),
    guest: process.env.AGENT_ENTRY_GUEST === '1',
    wbaVerifiers,
  });
} catch (err) {
  console.error(err && err.message ? err.message : String(err));
  process.exit(2);
}

const server = entry.listen(port, host, () => {
  console.log(`${name} is agent-reachable on ${entry.card.url}`);
  console.log(`  DID:  ${entry.did}`);
  console.log(`  Card: ${entry.card.url}${AGENT_CARD_PATH}`);
  if (entry.card.domains) {
    console.log(`  Speaking for: ${entry.card.domains.join(', ')} — each domain must serve a `
      + 'credential naming this DID at /.well-known/did-configuration.json');
  }
  console.log(`  Listening on ${host}:${port} — POST a signed message/send to `
    + `${entry.mount || '/'}`);
  if (process.env.AGENT_ENTRY_GUEST === '1') {
    console.log(`  Guest mount: the site keeps GET / — this entry answers the card at `
      + `${AGENT_CARD_PATH} (and under ${entry.mount}) and POST ${entry.mount} only`);
  }
});

// The observation counters, surfaced the way the ledger is: on this runner's stdout,
// printed only when they changed. `[ua]` is greppable; the shape is entry.stats()
// verbatim ({family: {stage: n}}). `unref()` so the timer never holds the process open.
let lastStats = '';
let lastClient = '';
setInterval(() => {
  // Sorted keys at every level so the line is stable run to run (and diffable against
  // the Python runner's `json.dumps(..., sort_keys=True)` spelling of the same shape).
  const stable = (obj) => JSON.stringify(obj, (k, v) =>
    (v && typeof v === 'object' && !Array.isArray(v))
      ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]]))
      : v);
  const line = stable(entry.stats());
  if (line !== '{}' && line !== lastStats) {
    console.log(`[ua] ${line}`);
    lastStats = line;
  }
  const clientLine = stable(entry.clientStats());
  if (clientLine !== '{}' && clientLine !== lastClient) {
    console.log(`[client] ${clientLine}`);
    lastClient = clientLine;
  }
}, 60_000).unref();

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
