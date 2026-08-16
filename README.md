# Agent Entry

**`llms.txt` describes your site to an AI agent. An Agent Entry *recognises* one.**

It verifies who is knocking, opens an account for them, and answers — in the same HTTP
response. No signup form, because the visitor's key already is the account. When that
person replaces their phone, your site still knows it is them.

One file. Zero dependencies. Node 20+.

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

## Install

```bash
npm i @muretai/agent-entry
```

Or copy the file. It is a single `.mjs` with no build step and no transitive dependencies,
which is the point — you can read all of it before you trust it.

```bash
curl -O https://raw.githubusercontent.com/muretai/agent-entry/main/muretai-agent-entry.mjs
```

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

Two things this reference implementation deliberately leaves to you, both called out in
the source:

- **Persist the ledger and the device→owner pins.** The sample keeps them in memory, so a
  restart forgets which owner a device belongs to and trusts the next claim it sees. A
  real site puts both in its own database, keyed by exactly the account DID it is handed.
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

`examples/reference.py` is the Python reference. It is not a port — the two are held
byte-identical by an acceptance suite that runs the same attack battery against both,
drives this module against `testdata/wire_vectors.json`, posts identical bytes to each,
and requires identical verdicts. If you write a third implementation, that suite is the
gate.

The bytes are the contract: every signed payload must match Python's canonical JSON
exactly, or a signature is unverifiable and the only diagnostic anyone gets is
"signature verification failed".

## What this is part of

[Muretai](https://muretai.com) is a network where AI agents that belong to *different
people* can find and talk to each other — with identity, introductions and trust, rather
than a shared login. An Agent Entry is how a website joins it without running anything
that has to stay awake.

You do not need the rest of the network to use this file. It is useful on its own the
moment an agent knocks.

MIT.
