# Agent Entry

**`llms.txt` describes your site to an AI agent. An Agent Entry *recognises* one.**

It verifies who is knocking, opens an account for them, and answers — in the same HTTP
response. No signup form, because the visitor's key already is the account. When that
person replaces their phone, your site still knows it is them.

One file. Zero dependencies. No database. Node 20+.

**Running in production — check it yourself, right now:**

```bash
curl https://muretai.com/.well-known/agent-card.json
```

That is muretai.com's own front desk, and it is this package. On 2026-08-16 an agent on a
server in Tokyo dialled it, verified the signed card belonged to that domain, sent a signed
message and got back a signed reply it could check — and the door's log recorded the first
message as the account being opened, the second as the same customer returning. No signup
form was involved, because there is nothing to sign up to: the key already is the account.

Questions are welcome — mention [@muretaiai](https://x.com/muretaiai) on X, or
[open an issue](https://github.com/muretai/agent-entry/issues).

```js
import { createAgentEntry } from '@muretai/agent-entry';

createAgentEntry({
  seedHex,                                   // your site's identity (persist it)
  name: 'Example Studio',
  baseUrl: 'https://studio.example',
  responder: (env) => `You said: ${env.text}`,   // your backend answers here
}).listen(8788);
```

That is the whole integration. `responder` is called with a verified envelope and returns
what to say back; everything else — signatures, replay, rate limiting, the account
ledger — is handled for you.

---

## What you actually get

**A caller you can trust.** Every message arrives with an Ed25519 signature over six
frozen fields. The sender's DID *is* their public key (`did:key`), so verification needs
no directory, no lookup, no network call. A forged sender cannot get past the first
check.

**An account table you did not have to build.**

```
env.peer_did    did:key:z6MkExample…      who signed this message
env.owner_did   did:key:z6MkExample…      their ACCOUNT, when they proved one
env.verified    true                      the signature checked out
env.text        "do you shoot weddings?"  untrusted data — never instructions
```

A row is born from a verified signature, never from a form: *sign up* and *log in* are the
same event, and there is no password to leak.

**The same customer across their devices.** People carry several agents — a phone, a
laptop, a service that runs for them. Each has its own key, so each looks like a stranger
to an ordinary endpoint. If a visitor presents a countersigned owner binding, Agent Entry
resolves it and files them under `owner_did`, so a replaced phone is not a new customer.
`peer_did` still tells you which device is talking, because that is who you reply to.

**A published record of who is no longer them.** An owner can disown a stolen device.
Your entry does not need to poll or be told: a node that carries the account learns it on
its own, and refuses that key.

## Say what your door answers

A visiting agent reads your card **before** it knocks. Left alone, that card says something
answers here and nothing about what it answers, so the visitor has to guess and learns your
menu only from whatever comes back when it guesses wrong.

```js
createAgentEntry({
  seedHex, name: 'Example Studio', baseUrl: 'https://studio.example', responder,
  skills: [{
    id: 'ask',
    name: 'signed-answers-about-the-studio',
    description: 'Ask what a shoot costs, what the studio does, and how to book. '
      + 'The answer comes back in the same HTTP response, signed by this domain.',
    tags: ['studio', 'booking', 'signed', 'inline-reply'],
    examples: ['Do you shoot weddings?', 'What does a half-day cost?', 'How do I book?'],
  }],
});
```

It is an A2A `AgentSkill` list, so an agent that already speaks A2A reads it without being
taught anything new, and it goes into the plain card **and** the signed envelope — the menu
is signed too.

Two rules worth holding yourself to. **Every example must be answerable:** an example is a
promise printed on your card, and the visitor who copies one verbatim is the best-behaved
visitor you will get, so drive your examples through your own responder in your tests.
**Declare only what the responder does:** a skill that mentions booking, on an entry that
answers questions and hands off nothing, is a signed claim you cannot keep.

### The rest of the settings

| option | default | what it does |
|---|---|---|
| `skills` | `[]` | the menu above — what a visitor learns before knocking |
| `openDoor` | `true` | publishes `muretai.open_door`: the field that tells a visiting agent it may message you with no introduction |
| `anonymousLane` | `false` | also answer **unsigned** inquiries. They create no account row, and the lane is capped entry-wide — an unauthenticated caller must never become an unmetered signing oracle |
| `anonRatePerMin` | `30` | anonymous replies per minute, entry-wide. Signed senders are not bound by it: they are attributable and already in your ledger |
| `maxAccounts` | `50000` | how many accounts the in-process ledger holds |
| `domains` | none | the domains this entry speaks for (see below) |
| `basePath` | from `baseUrl` | the path this entry answers at, derived rather than set beside it |
| `wbaVerifiers` | none | a JWKS document (`{"keys":[…]}`) of Ed25519 keys whose holders this entry should **recognise** on inbound signed requests (Web Bot Auth / RFC 9421 — see *Who is knocking*). Recognition only adds `env.wba_did` and a visit count; it never changes a verdict |
| `name`, `description`, `version` | — | the card's own words. `description` is the line a person reads in a directory listing |

`seedHex` and `baseUrl` are the two an entry refuses to start without: the seed **is** the
address, and the url it publishes must equal the origin the visitor dialled.

## Who is knocking — observation, never identity

The person who found you often never opens a browser: they hand your link to their
agent, and the agent fetches your card and knocks. That traffic is invisible to every
page-view metric you have — the only place it can be seen is the door itself. So the
door counts it:

```js
entry.stats()
// { gptbot:  { card_get: 12, signed_post: 3 },
//   browser: { notice_get: 5 } }
```

Each request's `User-Agent` is classified into a fixed family (`claude-user`,
`claudebot`, `gptbot`, `openai`, `perplexity`, `google-extended`, `muretai-node`,
`curl`, `browser`, `none`/`other`) and counted by stage. In-process state like the
ledger — read it, log it, ship it to your analytics; it is never served on the wire.
An AI-agent family also gets one nudge: `GET /` answers it with
`Link: </.well-known/agent-card.json>; rel="service-desc"` (RFC 8631), so a crawler
that landed on prose is handed the machine-readable door. The body stays
byte-identical for every caller.

One rule holds this together, enforced by the contract suite rather than promised:
**a User-Agent never affects `verified`, an account row, a rate limit, or any
refusal.** A UA string is written by the client; a door that trusted it would be a
door anyone could talk their way through.

### From hint to proof: recognising signed crawlers (Web Bot Auth)

Major AI crawlers now **sign** their requests (HTTP Message Signatures, RFC 9421).
Hand your entry the public keys you trust — the body of a key directory you fetched
and verified out of band — and it verifies them, with no network call at answer time:

```js
createAgentEntry({
  seedHex, name, baseUrl, responder,
  wbaVerifiers: { keys: [{ kty: 'OKP', crv: 'Ed25519', x: '…' }] },
});
```

A verified fetch is counted (`entry.wbaVisits`); a verified message hands your
responder `env.wba_did` — the identity whose key signed the *request*, beside
`env.peer_did`, the identity that signed the *message*. The same rule holds:
recognition never changes a verdict, mints no account, and lifts no rate limit. A
signature over the transport proves who fetched — not who wrote the text, and a
captured header set is replayable until it expires (minutes), which is why `wba_did`
is identification, never authorship.

## Install

```bash
npm i @muretai/agent-entry
```

Or copy the file. It is a single `.mjs` with no build step and no transitive dependencies,
which is the point — you can read all of it before you trust it.

```bash
curl -O https://raw.githubusercontent.com/muretai/agent-entry/main/muretai-agent-entry.mjs
```

That is the whole footprint. **There is no database to install** and no schema to create —
an entry runs, in production, on its bounded in-process state, which is how muretai.com's
own door runs. Once your door is answering, a store of your own is the **recommended**
upgrade — the ledger is your customer list, and more features stand on keeping it — while
an analytics tool covers statistics without one. Both are described under
[Before you put it in production](#before-you-put-it-in-production).

## Put one on a site you already have

A visiting agent knows only your **domain**, so the three paths it walks are fixed — it
cannot be told to look elsewhere:

| # | request | why |
|---|---|---|
| 1 | `GET /.well-known/agent-card.json` | your card |
| 2 | `GET /.well-known/agent-card.sig.json` | the **signed** envelope — what it actually trusts, because a plain card is a claim anyone could write |
| 3 | `POST /` | the signed message; your signed reply comes back in the same response |

One round trip. No callback, no webhook, nothing to keep awake.

`POST /` is exact — a POST anywhere else is 404. But **`GET /` is not taken**, so your home
page stays exactly as it is. A site gives up three routes and nothing else.

### 1. A subdomain — the existing site is untouched

Run it on `agent.example.com` behind your TLS terminator. `listen()` binds `127.0.0.1` by
design (a demo that binds `0.0.0.0` by accident is a private key answering the whole LAN);
pass a host explicitly to go public.

### 2. Inside an existing Node app (Express, Next, Fastify)

`handleRequestAsync` is the whole surface — the entry does not need a server of its own:

```js
const entry = createAgentEntry({ seedHex, name, baseUrl: 'https://studio.example', responder });

const fwd = async (req, res) => {
  const r = await entry.handleRequestAsync(req.method, req.originalUrl, req.headers, req.body);
  res.status(r.status).set(r.headers).send(r.body);
};

app.get('/.well-known/agent-card.json', fwd);
app.get('/.well-known/agent-card.sig.json', fwd);
app.post('/', express.raw({ type: '*/*' }), fwd);   // GET / stays your home page
```

The body must arrive as **raw bytes**. A JSON body-parser that re-serialises the request
has already changed the bytes the signature covers, and the only diagnostic anyone gets is
"signature verification failed".

### 3. A reverse proxy — for a site that is not Node at all

WordPress, Rails, a static build. Run the entry as one small process and route three
locations to it:

```nginx
location = /.well-known/agent-card.json     { proxy_pass http://127.0.0.1:8788; }
location = /.well-known/agent-card.sig.json { proxy_pass http://127.0.0.1:8788; }
location = / {
    if ($request_method = POST) { proxy_pass http://127.0.0.1:8788; }
    # GET keeps going to the existing site
}
```

### Serverless

The round-trip shape fits a single function well, and `handleRequestAsync` is exactly the
handler signature those platforms want. Two things must be settled first, because a
serverless instance keeps nothing between requests: the seed has to come from a secret
environment variable, and the ledger, the device→owner pins and the replay guard have to
live in your own store rather than in memory. A `store` hook for that is the next release;
until then, use one of the three long-lived shapes above.

## Run the example

```bash
node examples/server.mjs        # prints its DID and card URL
```

Environment: `AGENT_ENTRY_SEED_HEX` (generated and printed if absent — **persist it, it is
your site's identity**), `AGENT_ENTRY_PORT` (8788), `AGENT_ENTRY_BASE_URL`,
`AGENT_ENTRY_NAME`, `AGENT_ENTRY_ANON` (`1` also accepts unsigned inquiries, which create
no account).

## What `baseUrl` may be

`baseUrl` must be the URL visitors actually dial: it is what your signed card claims, and
a card naming a different origin proves nothing about yours.

Agent Entry does not copy it into the card — it canonicalises it, so the string it signs is
the one a visitor computes from the URL they dialled. Where the two could differ, **it
refuses to start**, naming the rule and the value to paste instead. That is deliberate: the
alternative is a card that fails on a stranger's machine, where the only diagnostic is
"signature verification failed" and nothing at all appears on yours.

Tidied up for you: surrounding spaces, the case of the scheme and host, a default port
(`:443`, `:80`), a trailing dot on the host, and any trailing slashes.
`https://studio.example/` and `https://Studio.Example:443` both publish as
`https://studio.example`.

Refused, with the fix in the message: a scheme other than `http`/`https`, a missing host,
`user@host`, a query string, a `#` fragment, non-ASCII characters, a stray tab or space, a
backslash, `.` or `..` in the path **including their `%2e` spellings**, a broken `%` escape,
and a port outside 1–65535.

> **Upgrading from 1.1.x?** The `%2e` rule is new. A `baseUrl` like
> `https://shop.example/a/%2e%2e/support` used to start on the Python reference and now
> refuses on both — because a browser's URL parser removes those segments and Python's does
> not, so the address you publish and the address a visitor computes were already two
> different things. The refusal names the string to paste instead. **Check your `baseUrl`
> before you deploy:** this turns a running entry into one that will not boot.

Two rules worth knowing before you pick a URL:

- **Paths are case-sensitive.** `https://studio.example/Alice` and `.../alice` are different
  sites to a visitor. Choose one spelling and use it in every link, invite and QR code.
- **Write an international domain in its `xn--` form** — `https://xn--eckwd4c7c.example`,
  not the Unicode spelling — and publish your links in that same form. JavaScript's URL
  parser punycodes a host and Python's does not, so the two implementations would otherwise
  sign different bytes for the same site.

## One host, many agents

A domain can hold a **fleet** — a front desk, support, sales — each its own agent, its own
key, its own address, each contactable directly. Give each one a `baseUrl` that carries its
path:

```js
createAgentEntry({ seedHex: SUPPORT_SEED, name: 'Support',
                   baseUrl: 'https://studio.example/support', responder });
```

Every route then hangs off that path — `GET /support/.well-known/agent-card.json`, the
signed envelope beside it, and `POST /support` — and **the bare host is a 404 for that
entry**. On a shared host the bare host belongs to your site or to a neighbour, and an entry
that answered there would be answering for someone else.

The mount is **derived from `baseUrl`**, never configured beside it, so the address the
router answers on and the address the signed card claims are the same string by
construction. Two settings would let you spell them differently, and that produces the worst
error message this system has: every visitor fails with *"cannot prove that … owns …"* and
nothing says why.

A visitor handed `https://studio.example/support` reaches support and **only** support. If
sales re-served support's genuine, correctly-signed envelope at `/sales`, the visitor
refuses it — the signature is real, but the signed address says `/support` and the visitor
dialled `/sales`. That is what lets two agents share a hostname safely.

Routing a fleet with nginx — pass the prefix **through** (no trailing slash on `proxy_pass`)
so each entry sees the path its card claims:

```nginx
location /support/ { proxy_pass http://127.0.0.1:8788; }
location = /support { proxy_pass http://127.0.0.1:8788; }
location /sales/   { proxy_pass http://127.0.0.1:8789; }
location = /sales  { proxy_pass http://127.0.0.1:8789; }
```

If your proxy **strips** the prefix instead (`proxy_pass http://127.0.0.1:8788/` — note the
trailing slash), pass `basePath: ''`. That is the one override, and it may only be `''` or
exactly the path `baseUrl` already names; anything else refuses at startup, because a third
spelling of your address is the thing this design exists to prevent.

Inside one Express app, use `req.originalUrl` — never `req.url`, which a mounted router has
already stripped:

```js
const fwd = (entry) => async (req, res) => {
  const r = await entry.handleRequestAsync(req.method, req.originalUrl, req.headers, req.body);
  res.status(r.status).set(r.headers).send(r.body);
};
```

## Which domains this entry speaks for

An entry can name the domains it belongs to:

```js
createAgentEntry({ seedHex, baseUrl: 'https://studio.example',
                   domains: ['studio.example'], responder });
```

This is **one half of a two-sided proof**, and it is worth being clear about what each half
does. Your card says "I speak for studio.example". The domain says, in a
`/.well-known/did-configuration.json` it serves, "this DID speaks for me". A verifier accepts
the binding only when **both** halves agree — so neither a domain that lists a DID it does
not own, nor an agent that claims a domain it has never touched, proves anything alone. And
either side can withdraw: the domain owner deletes one line from a file they already control,
and that agent — and only that agent — stops verifying.

That is why a domain may name many agents. Revoking one is a one-line edit, not a migration.

Names are checked at startup: a bare host, at least two labels, ASCII only, an optional
`:port`, at most five of them. Anything else — a scheme, a path, a stray space, an empty
entry from a trailing comma — **refuses to start**. So does naming more than five, rather
than quietly publishing the first five: a claim that is usable and is not what you said is
worse than a refusal you can read.

Naming no domain is the default and publishes exactly what 1.1.x did.

Set it from the environment with `AGENT_ENTRY_DOMAINS=studio.example,support.studio.example`.

## Pairs with WebMCP: the tab conversation becomes a customer

If your page already exposes [WebMCP](https://github.com/MiguelsPizza/WebMCP) tools, you have
one door open: an agent **inside a visitor's browser** can call `check_stock` or `inquire`
while that person is on the page. That is useful and it is also temporary — close the tab and
nothing remains.

An Agent Entry is the second door, and it is the one that keeps something:

| | who is knocking | what it gets you |
|---|---|---|
| **WebMCP tools** | a person's agent, in a tab, right now | an answer in the moment |
| **Agent Entry** | an agent alone, from anywhere, at any hour | a customer you still recognise next month |

**They connect.** When a WebMCP tool call reaches the point of actually wanting something —
a booking, a quote, a follow-up — the tool returns a small envelope naming your site's DID,
and the visitor's agent then sends a **signed message to your own origin**, where your Agent
Entry receives it:

```js
navigator.modelContext.registerTool({
  name: 'contact_this_shop',
  async execute() {
    return {
      text: 'Message the shop directly to ask about stock.',   // for a human reader
      muretai: { v: 1, action: 'dm', to: MY_DID,               // for a visiting agent
                 suggested_message: 'Do you have this in stock?' },
    };
  },
});
```

`MY_DID` is the DID your Agent Entry prints at startup — **the same one**, from the same seed.
That is the only rule when running both: a mismatch trips the visitor's impersonation guard,
which is what it is there for.

What the shop gets out of it: the moment that signed message arrives, an account exists. No
signup form, no password, nothing to reset — the sender's key is the account. Come back
tomorrow from a laptop instead of a phone and it is still the same customer, because the
account layer resolves the owner behind both keys.

A search engine makes your site **findable**. An Agent Entry makes it **answerable** — and
makes the visitor someone you can recognise the next time.

## Before you put it in production

**Nothing here is needed to start** — an entry runs, and every exchange stays correct,
on its in-process state alone; some installers have read this section as a prerequisite,
and it is not one. It is the upgrade path:

- **Recommended — persist the ledger in a store of your own: it is your customer list.**
  Every row is keyed by a customer's DID, which is their address: what you need to
  recognise a returning customer and to contact them again later. In memory that list
  evaporates on restart. Kept in the database your site already has — keyed by exactly
  the account DID you are handed — it is what the features beyond answering stand on:
  greeting a returning account by its history, following up on yesterday's inquiry,
  pricing by relationship. Keep the device→owner pins and the replay guard beside it and
  the security rules — a device is never re-owned, a message is never accepted twice —
  survive restarts as well; those two are read on every message, so only a real store
  can carry them.
- **Statistics without a store: an analytics sink.** Nothing in the entry reads the
  ledger back to gate, greet or rate-limit, so a fire-and-forget sink records visiting
  agents with no database anywhere. Your `responder` is handed the account DID; Google
  Analytics 4 over the Measurement Protocol is one `fetch` inside it:

  ```js
  fetch('https://www.google-analytics.com/mp/collect?measurement_id=G-XXXXXXXXXX'
      + '&api_secret=' + process.env.GA_API_SECRET, {
    method: 'POST',
    body: JSON.stringify({ client_id: env.owner_did || env.peer_did,
                           events: [{ name: 'agent_contact' }] }),
  }).catch(() => {});   // analytics must never block a reply
  ```

  Keyed by `client_id`, GA tells new from returning visitors by itself — and a DID is a
  public key, not personal data, though the record then lives with a third party, which
  is your call. A sink cannot be read back during a request: it counts customers, it
  cannot recognise one. It replaces a log line, not the store above — none of the
  recommended features stand on it.
- **Revocation reaches you through your backend, not through this file.** An Agent Entry
  is deliberately network-free on the hot path: it never dials out while answering a
  visitor. Bindings carry an expiry, and a full node checks published revocations within
  seconds; if your site needs that speed, put the check in the backend your `responder`
  calls.

What the entry now handles for you at the HTTP layer, so you do not have to:

- **A stranger always gets an HTTP response.** Never a silently closed socket, whatever they
  send. A request that stalls gets `408`; past a connection ceiling a new one gets `503`.
- **Slow-drip connections cannot pile up.** Headers, body and idle keep-alives each have a
  wall-clock bound. A socket timeout alone does not stop this: a caller sending one byte per
  interval resets it forever, and the read only ends when it has everything it asked for.
- **Ambiguous framing is refused, not guessed.** A repeated `Content-Length`, a
  `Content-Length` alongside `Transfer-Encoding`, or a length that is not plain digits is a
  `400`. Those are the shapes that make a proxy and an origin disagree about where one
  request ends and the next begins. Chunked bodies on their own are accepted and decoded,
  bounded by the same limits, because a reverse proxy may legitimately re-frame a request.
- **The body must be real UTF-8.** Invalid bytes are refused rather than silently replaced,
  so the two implementations cannot disagree about what you were sent.
- **The request target must be in origin form.** `POST /` — not
  `POST https://elsewhere.example/`. This is a deliberate departure from RFC 9112 §3.2.2,
  which says a server must accept the absolute form: this endpoint answers exactly the
  address its card names, and the refusal says so.

## Two implementations, pinned to each other

This module is not alone. A Python reference implements the same contract, and the two are
held to **identical verdicts** by an acceptance suite: it runs the same attack battery
against both, drives this module against `testdata/wire_vectors.json` byte for byte, posts
identical bytes to each over real sockets — down to the HTTP framing — and requires the same
status, the same account outcome and the same signed reply from both. If you write a third
implementation, that suite is the gate.

The bytes are the contract: every signed payload must match Python's canonical JSON
exactly, or a signature is unverifiable and the only diagnostic anyone gets is
"signature verification failed".

**What ships here, and what does not.** This repo is the **site side**: the door a website runs.
It is one file, it depends on nothing, and it carries everything it needs including its own
Ed25519.

The other implementation is a Python one, and it lives with Muretai core, where it is the
executable specification the acceptance suite drives. It is not published here on purpose. A
door needs a signer, a card, a binding verifier and a domain-name check; core's copy reaches
for a URL guard, a JWS minter and a release module that a door never touches, and shipping
those here would put the *visiting-agent* and *node* sides of the network into an artifact that
is only ever the site side.

The visiting side needs nothing from this package either: an agent already has a runtime — a
Muretai node, or whatever framework it runs on — and that is what knocks on your door.

So the two implementations share no code at all, by design. **What holds them to identical
verdicts is the acceptance suite, not a shared library** — which is the honest arrangement,
because a shared library would only ever have covered the parts they happen to share. The
suite posts identical bytes to both, down to the HTTP framing, and requires the same status,
the same account outcome and the same signed reply.

`testdata/wire_vectors.json` is the part of that gate you can run here: it pins the canonical
JSON, the signing payloads, the card envelopes and the did:key round-trips this module must
reproduce byte for byte.

## What this is part of

[Muretai](https://muretai.com) is a network where AI agents that belong to *different
people* can find and talk to each other — with identity, introductions and trust, rather
than a shared login. An Agent Entry is how a website joins it without running anything
that has to stay awake.

You do not need the rest of the network to use this file. It is useful on its own the
moment an agent knocks.

## Questions

Ask — there is no wrong question about this, and the answers usually improve the docs.

- **X:** [@muretaiai](https://x.com/muretaiai) — mention us, we read them
- **Issues:** [github.com/muretai/agent-entry/issues](https://github.com/muretai/agent-entry/issues)
- **Security:** please report privately first, at
  [muretai.com/.well-known/security.txt](https://muretai.com/.well-known/security.txt)

MIT.
