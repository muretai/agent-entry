# Agent Entry

[![npm](https://img.shields.io/npm/v/@muretai/agent-entry.svg?label=npm)](https://www.npmjs.com/package/@muretai/agent-entry)
[![LICENSE](https://img.shields.io/badge/LICENSE-MIT-blue.svg)](LICENSE)

**Agents already visit your site. Give them a way to become a customer.**

## Contents

- [What this is](#what-this-is)
- [What you get](#what-you-get)
- [What a customer can do here](#what-a-customer-can-do-here)
- [Who is knocking](#who-is-knocking)
- [Knock from any runtime](#knock-from-any-runtime)
- [Put it on a site](#put-it-on-a-site)
- [On serverless](#on-serverless)
- [On WordPress](#on-wordpress)
- [Your customers are yours](#your-customers-are-yours)
- [Pairs with WebMCP](#pairs-with-webmcp-the-tab-conversation-becomes-a-customer)
- [In production](#in-production)
- [This package](#this-package)

## What this is

They read your pages and leave. No signup, no cookie, nothing in your analytics.
Agent Entry is a single module you put on the origin. It publishes an
[Agent Card](https://a2a-protocol.org/latest/specification/)
at `/.well-known/agent-card.json` — who you are, what you answer, how to knock —
and then answers one signed POST: verify the visitor, open an account from their
key, reply signed, same HTTP response.

No form. The key *is* the account. Come back next month from another device and
it is still them.

Any A2A client works: their agent, `curl`, not a particular router or ours.

### Where this lives

This repository is the home of Agent Entry: the module, the specification (`spec/v1.md`),
the conformance vectors and the two checkers are written here, and the npm package is built
from here and nothing else. Two things are pinned copies rather than ours, and both say so
in a `VENDOR.json` beside them: the crypto block inside the module and the golden vectors are
the **seam** — the wire layer every implementation reproduces — vendored from
[agent-seam](https://github.com/muretai/agent-seam) at one tagged commit
(`vendor/agent-seam/`, `npm run vendor:seam`); and Muretai, the network this door was first
written for, vendors a pinned version of *this* repository into its own and holds its Python
door to the same vectors. Nobody's release overwrites anybody else's checkout, and `npm test`
here reads nothing outside this repository.

Keep WebMCP. A person already in the tab keeps the page. This file sits beside
it and replaces none of it: an Agent Card and a door, so an agent who arrives
alone can become a customer — one signed POST, a signed reply.

`llms.txt` is a brochure — prose, not a contract. MCP is a tool server for an
app that holds a token. A different purpose.

The agent reads the card **before** it knocks (AE-8). The act is then one
**POST** `message/send` — already formed correctly — and a signed reply comes
back on that same request (AE-20).

A **handoff** is how a tool on the page, or a tool server, can send the visitor
*here*: the result names this entry's DID, and the next act is a signed knock at
this origin. This file does not follow a handoff and does not parse
`_meta.handoff`. It is where one lands. The `to` in that envelope must be the
DID printed at startup — the same seed as the card. A visitor (or any router
they run) is who honours the pointer.

| | |
|---|---|
| **Who installs this** | Website owners who want agents as *customers* — a returning identity — not only as crawlers. |
| **Not for** | People writing the visiting agent. This package does not find doors, MCP servers, or WebMCP tools; it *is* a door. |
| **The problem** | A GET-only document cannot recognise anyone. A signup form does not work for an agent. The first signed POST has to *be* the account. |

![A person in the tab keeps WebMCP. An agent alone can become a customer at the door beside it.](diagrams/become.png)

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

### Not an HTTP 402 challenge

[x402](https://x402.org/) v2 over HTTP teaches by **error**. The client asks for the
resource; the server answers `402 Payment Required` with a `PAYMENT-REQUIRED` header; the
client **retries** the same resource with `PAYMENT-SIGNATURE`. The error is how the
client learns what to do next.

Agent Entry does the reverse. The Agent Card states the terms **before** anyone knocks
(AE-8). An HTTP-402-style challenge structurally cannot do that. The first POST is already
formed correctly and is answered `200` with a signed reply (AE-20). This package does not
speak x402 and does not return HTTP 402. A protocol refusal here is HTTP `200` plus a
JSON-RPC error (AE-19). If someone POSTs with no signature at all, `-32001` still carries
`data.accepts` — the same scheme object as the card — so they can succeed on the next POST
(AE-24). That is a fallback, not the design.

![x402: request, HTTP 402, retry with payment. Agent Entry: GET the card as 200, then POST already correct, answered 200.](diagrams/x402.svg)

---

## What you get

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

### Say what your door answers

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
    examples: ['Do you shoot weddings?', 'How much is a half-day?', 'Book Saturday 14:00'],
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

Turning logged knocks into that menu is an offline owner loop, not part of the
runtime — see [`spec/skill-distill.md`](spec/skill-distill.md). On this machine
only: `npm run distill` measures whether a proposed menu would have made the
next first knock useful. `observer: fileSink()` (from
`scripts/distill/record.mjs`) appends POST outcomes to `var/traces.jsonl`.
Nothing is uploaded, and the Distiller is never imported by
`muretai-agent-entry.mjs`.

### The rest of the settings

| option | default | what it does |
|---|---|---|
| `skills` | `[]` | the menu above — what a visitor learns before knocking |
| `openDoor` | `true` | publishes `agentEntry.open_door`: the field that tells a visiting agent it may message you with no introduction. The same fact is emitted under the older `muretai.open_door` spelling beside it — read either, write the neutral one |
| `prefer` | unset | your own order of the ways into your site, published verbatim as `agentEntry.prefer` (spec AE-30): an array of `"page"`, `"card"`, `"mcp"` or `{kind, when}` with `when` one of `person`, `alone`, `key`, `no-key`, `token`, `browser` — e.g. `[{kind:'page', when:'no-key'}, 'card']` says "read on the page if you hold no key; otherwise the door". A visiting agent reads it against what it has on hand. An invalid list refuses to start rather than publish an order you did not write; unset publishes no key at all |
| `anonymousLane` | `false` | also answer **unsigned** inquiries. They create no account row, and the lane is capped entry-wide — an unauthenticated caller must never become an unmetered signing oracle |
| `anonRatePerMin` | `30` | anonymous replies per minute, entry-wide |
| `signedRatePerMin` | `60` | signed replies per minute **per account**, ON by default. Attribution is not scarcity: a `did:key` costs nothing to mint, so being in your ledger was never a bound |
| `signedRatePerMinTotal` | `600` | signed replies per minute for the **whole entry**. Free identity defeats per-identity metering by definition, so only the aggregate resists a flood |
| `guest` | `false` | put the door on a path of its own and leave `GET /` alone entirely — for a site that is keeping its front page. A `GET` on a guest mount answers **405 with `Allow: POST, OPTIONS`**, never 404: the address is signed into a public card, and hiding a published address conceals nothing |
| `maxAccounts` | `50000` | how many accounts the in-process ledger holds |
| `domains` | none | the domains this entry speaks for (see below) |
| `basePath` | from `baseUrl` | the path this entry answers at, derived rather than set beside it |
| `wbaVerifiers` | none | a JWKS document (`{"keys":[…]}`) of Ed25519 keys whose holders this entry should **recognise** on inbound signed requests (Web Bot Auth / RFC 9421 — see *Who is knocking*), or an array `[{vendor, jwks}]` that also says whose keys they are (the observer's `signature_agent`). Recognition only adds `env.wba_did` and a visit count; it never changes a verdict |
| `trustProxy` | `false` | read the client address from `CF-Connecting-IP`, `Fly-Client-IP`, then the first `X-Forwarded-For` hop, and the country from `CF-IPCountry`. Turn it on **only** behind a proxy that overwrites those headers; off, they are not read at all |
| `vendorRanges` | none | `{<vendor>: [CIDR, …]}` — whose network the client address belongs to, for the observer's `ip_vendor` and `entry.vendorStats()`. `scripts/vendor-ranges.mjs` writes one. An unknown vendor or a malformed CIDR refuses to start |
| `observer` | none | called once per message with the same envelope your responder gets, plus `stage`, `identified`, `ua_family`, `client_class`, `ip_vendor`, `country` and `signature_agent`, **after** the verdict — for counting, logging, analytics. It cannot matter: its return is discarded, a throw is swallowed, a promise is never awaited, so a slow or broken watcher cannot delay or change one byte of the signed reply. See [Counting visits](#counting-visits-without-handing-over-your-customer-list) |
| `howToUrl` | none | a page a keyless visitor is pointed at as a worked example. **Empty means omitted** — the refusal already teaches the whole recipe without it, and a reference implementation must not stamp somebody else's docs host into every door built from it. Only set it to a URL you operate, and only after checking it resolves |
| `name`, `description`, `version` | — | the card's own words. `description` is the line a person reads in a directory listing — and the right place to say what you record about visitors, since it is fetched **before** the knock |

`seedHex` and `baseUrl` are the two an entry refuses to start without: the seed **is** the
address, and the url it publishes must equal the origin the visitor dialled.

## What a customer can do here

An agent handed your URL asks one question on its person's behalf: *what can I do here?* A
menu of skills written in your own words answers it only for an agent that reads prose well.
Since 1.13.0 you can answer it in a shared vocabulary instead: one declaration,
`agent-entry.json`, lists your **offers**, and each offer starts with a **verb** from a small
registry that every door spells the same way. So an agent that wants to `book` something can
match that intent at your shop and at the next one without learning either.

From that one declaration the door generates both faces:

- **at the door** — the card's `skills[]` (one per offer, `id` = `verb_of`) and a default signed
  reply for every offer with a `door` binding;
- **on the page** — a signed tool contract that `agent-entry-page.mjs` registers as WebMCP tools
  (one per offer with a `page` binding, named `verb_of`). See
  [Pairs with WebMCP](#pairs-with-webmcp-the-tab-conversation-becomes-a-customer).

The verbs, and what each one does by default:

| verb | default effect | on the page, by default | example (what a customer's agent asks) |
|---|---|---|---|
| `find` | none — it only reads; nothing on your side changes | runs without asking the person | "Do you have brass desk lamps under 80 euros?" (`find_products` on `https://shop.example.com/shop/`) |
| `ask` | none — a question; nothing changes | runs without asking | "Are you open on Sunday?" |
| `quote` | none — a price is stated; nothing is agreed or kept | runs without asking | "What would a half-day shoot cost?" |
| `book` | changes — a table, slot or appointment is requested on your side | asks the person first, then hands over to the door | "A table for four on Friday at 20:00." |
| `hold` | changes — an item is set aside for this customer | asks first, then the door | "Hold the brass lamp for pickup on Saturday." |
| `order` | changes — an order is placed for you to fulfil | asks first, then the door | "Order two more of what I bought last month." |
| `buy` | pays — money moves, on your own checkout page; the door only hands over the checkout URL | always asks the person first | "Buy the lamp I am holding." (continues at `https://shop.example.com/checkout`) |
| `track` | none — reads the state of something already asked | runs without asking | "Where is my order?" |
| `change` | changes — something already booked or ordered is altered | asks first, then the door | "Move my booking to 21:00." |
| `cancel` | reversible — something is withdrawn and can be made again | asks first | "Cancel Friday's table." |
| `join` | changes — the customer is added to a list, a waitlist or a membership | asks first, then the door | "Put me on the waitlist for the spring class." |

An offer may raise its effect or its ask, never lower it. A verb that is not in the registry is
allowed, but it gets no defaults: declare its `effect` yourself (`agent-entry doctor` warns
when you have not). **Payment is never touched:** `buy` hands the visitor to your own checkout.
The full grammar and the normative defaults are in [`spec/tools-v1.md`](spec/tools-v1.md).

A declaration for a lamp shop, cut down to three offers:

```json
{
  "v": 1,
  "entry": { "name": "Harbor Lamp", "baseUrl": "https://shop.example.com" },
  "offers": [
    { "verb": "find", "of": "products", "about": "Find lamps by words.",
      "input": { "q": "string" },
      "page": { "on": ["/shop/**"], "do": { "fetch": { "method": "GET",
                "path": "/wp-json/wc/store/v1/products", "query": { "search": "q" } } } } },
    { "verb": "hold", "of": "item", "about": "Hold one lamp for pickup within 48 hours.",
      "input": { "sku": "string" },
      "door": { "reply": "pending", "receipt": true } },
    { "verb": "ask", "of": "anything", "about": "Ask the shop a question.",
      "input": { "text": "string" },
      "door": { "reply": "human" } }
  ]
}
```

You do not have to write it by hand: `agent-entry init` writes a starter for your trade (see
[Put it on a site](#put-it-on-a-site)), and the declaration is passed to the door as
`createAgentEntry({ declaration, … })`.

## Who is knocking

Observation, never identity. The person who found you often never opens a browser:
they hand your link to their agent, and the agent fetches your card and knocks.
That traffic is invisible to every page-view metric you have — the only place it
can be seen is the door itself. So the door counts it:

```js
entry.stats()
// { gptbot:  { card_get: 12, signed_post: 3 },
//   browser: { notice_get: 5, card_get: 2 } }

entry.clientStats()
// { 'declared-agent': { card_get: 12, signed_post: 3 },
//   'human-like':     { notice_get: 5 },
//   'stealth-agent':  { card_get: 2 } }
```

Each request's `User-Agent` is classified into a fixed family (`claude-user`,
`claudebot`, `gptbot`, `openai`, `perplexity`, `google-extended`, `muretai-node`,
`camoufox`, `playwright`, `puppeteer`, `selenium`, `headless-chrome`,
`curl`, `browser`, `none`/`other`) and counted by stage. `clientStats()` then
folds those families into four owner-facing classes — `declared-agent`,
`named-tool`, `stealth-agent`, `human-like` — so a Firefox-looking fetch of the
card is counted as a stealth agent, not as a person. In-process state like the
ledger — read it, log it, ship it to your analytics; it is never served on the wire.
Every caller also gets one nudge: `GET /` answers with a single `Link:` field carrying
two relations — `rel="service-desc"` (RFC 8631) first, then the door pointer
`rel="https://muretai.net/rel/agent-entry"` — so a crawler that landed on prose is
handed the machine-readable door, whatever its `User-Agent` claims. The body stays
byte-identical for every caller, and so does the header: classification feeds the
counters above and never a byte on the wire.

**Since 1.8.0 the watcher is told the same thing.** `entry.stats()` always counted family by
stage, but the per-visit row handed to your `observer` carried `ua_family` only on the card and
notice fetches — so you could see that a browser *read* your card and not that a browser was the
thing being *refused*. The two questions an operator actually has — is this a crawler, is
somebody's agent failing to sign — were answerable only for the visitors who never knocked. All
five stages now carry it, refusals included, so "which clients got in and which were turned away"
is one query instead of two half-answers. Nothing else moved: no wire byte, no verdict, no ledger
row, no rate lane, and `stats()` is unchanged.

**Since 1.9.0 a Firefox-looking card fetch is not a human.** `stats()` still files it under
`browser` — Camoufox's published shape is a clean Firefox UA, and that is the point of
stealth. `clientStats()` splits it: a browser that only opened the notice is `human-like`;
the same UA on the card or the door is `stealth-agent`; a leaking automation token
(`playwright`, `camoufox`, …) is `named-tool`. Export `bodySignpost()` and put that
`<a>` in the page body, because a snapshot client never sees the header or the
`<head>` tag. Still observation only — the same POST with or without that UA is the
same refusal.

**Since 1.12.0 the door can say whose network a visitor came from.** Three options, all off
by default:

```js
import { readFileSync } from 'node:fs';
const cache = JSON.parse(readFileSync('var/vendor-ranges.json', 'utf8'));

const entry = createAgentEntry({
  seedHex, name, baseUrl, responder, observer,
  trustProxy: true,                     // only behind Cloudflare / Fly / a proxy you run
  vendorRanges: cache.ranges,           // { openai: ['…/24'], google: […], … }
  wbaVerifiers: JSON.parse(readFileSync('var/wba-verifiers.json', 'utf8')),
});

entry.vendorStats()
// { openai: { card_get: 9, signed_post: 2 },
//   none:   { card_get: 4, notice_get: 5 } }
```

- `trustProxy` — behind a proxy, the client address is read from `CF-Connecting-IP`, then
  `Fly-Client-IP`, then the first hop of `X-Forwarded-For`; without it, the socket address is
  the only address, and those headers are never read. A door on a public port with
  `trustProxy` on would believe any header a visitor wrote, so leave it off there.
- `vendorRanges` — `{<vendor>: [CIDR, …]}`, IPv4 and IPv6, matched in plain JavaScript. The
  vendors are a fixed table (`VENDORS`: `openai`, `anthropic`, `google`, `microsoft`,
  `perplexity`, `apple`, `meta`, `xai`, `cloudflare`, `aws`, `gcp`, `azure`, `fly`, `hetzner`,
  `other`). The most specific range wins; two vendors listing the same range go to the one
  earlier in that list. An unknown vendor or a malformed CIDR refuses to start.
- `wbaVerifiers` — also accepts `[{vendor, jwks: {keys: […]}}]`, so a recognised signature
  says whose key it was. The plain JWKS reads as `other`.

The observer gets three fields on all five stages, next to `ua_family` and `client_class`:
`ip_vendor` (a `VENDORS` name or null), `country` (two capital letters from `CF-IPCountry`
under `trustProxy`, else null), and `signature_agent` (the vendor label of the Web Bot Auth key
that signed the request, else null). `entry.vendorStats()` counts by `ip_vendor` (`none` for no
match), in the same shape as `clientStats()`. The address itself lives for one request: it is
in no counter, no ledger row, no observer envelope, no log line, and never on the wire.

`scripts/vendor-ranges.mjs` fetches the ranges and key directories the vendors publish and
writes `var/vendor-ranges.json` (`{fetched_at, ranges}`) and `var/wba-verifiers.json`. Run it at
boot or from cron: `node node_modules/@muretai/agent-entry/scripts/vendor-ranges.mjs`. It
refreshes at most once a day (`--force` to refresh now), fetches the large AWS and GCP lists only
with `--large`, and on any failure keeps the previous files byte for byte and exits non-zero
with one line saying why. The door never imports it and never fetches anything itself.

Cloudflare knows more than the door can: its verified-bot category. The door does not read it,
but one Transform Rule puts it where your own code can — Rules → Transform Rules → Modify
Request Header → set dynamic `X-Verified-Bot-Category` to `cf.verified_bot_category`. Read it in
the code that calls `handleRequest`, or in your logs.

Honest limits. A range says whose **network** a request came from, not who sent it: a VPS on
AWS is `aws`, and a crawler that moved is `null` until the lists catch up. Anthropic, Fly, Azure
and Hetzner publish no list the helper can fetch, so they are named only if you add their ranges
yourself. `country` exists only where Cloudflare adds `CF-IPCountry`. An agent that drives a
stealth browser on a person's own login — the Instinct class — shows as `stealth-agent`, with
at most a hosting vendor; it becomes a name only when it knocks with a DID.

One rule holds this together, enforced by the contract suite rather than promised:
**a User-Agent never affects `verified`, an account row, a rate limit, or any
refusal** — and neither does an address, a vendor range, a country, or a recognised
signature. A UA string is written by the client; a door that trusted it would be a
door anyone could talk their way through.

## Knock from any runtime

If your agent can run Node 20, the card URL is all it needs:

```bash
node muretai-agent-entry.mjs knock https://shop.example/.well-known/agent-card.json
```

The command verifies the signed card against the URL, keeps one Ed25519 identity at
`~/.config/muretai-agent-entry/knock-seed`, sends a correctly signed `message/send`, verifies
the signed reply, and prints the checked `{type, customer_did, request, status}` booking
when the verified reply carries one — never the shop's extra signed keys. If
`AGENT_ENTRY_KNOCK_TEXT` is unset, it copies the
first non-empty `skills[].examples` string from that verified card — so a runtime that only
has the card URL still asks something the shop already promised to answer. Set
`AGENT_ENTRY_KNOCK_TEXT` to choose a different message and `AGENT_ENTRY_KNOCK_KEY` to give a
different private key path. The key file is created mode
`0600`; keep it, because it is the account by which that store recognises this runtime.

There is no invitation, Muretai node, token, registration, or network service between the
runtime and the store:

- **curl:** download the one file with the install `curl -O` command above, then run the
  command shown here. `curl` transports the file; Node supplies Ed25519 without a package.
- **Claude Code:** ask it to run the command with the store's card URL. To send a specific
  inquiry, set `AGENT_ENTRY_KNOCK_TEXT` in the same shell command.
- **OpenClaw:** put the command in a shell/exec tool action. Persist
  `AGENT_ENTRY_KNOCK_KEY` on the runtime's durable volume.
- **Hermes:** use the same shell command as a tool call and keep the key path in the Hermes
  workspace so the next knock is the same customer.
- **Muse:** tell Muse "Build a custom connector for https://shop.example/.well-known/agent-card.json
  using `npx @muretai/agent-entry knock`". It runs the command on the user's own persistent VM,
  so the seed there is that user's did:key at every door. The page Muse reads is
  [connectors/muse.md](connectors/muse.md); documented for Muse, not yet tested in Muse.

On a refusal the command prints the JSON-RPC code and translates `data.accepts` into plain
instructions: which DID/signature to use, which fields are signed, who the recipient is, the
clock rule, and where to POST. A third-party runtime can therefore repair a refusal without
installing this package as a library.

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

## Put it on a site

### Install with one command

From the root of your site's project, inside its git repository:

```bash
npx @muretai/agent-entry init --trade retail --base-url https://shop.example.com
```

`agent-entry init` detects the framework (Next.js app or pages router, Nuxt, SvelteKit, Astro,
Vite, Express), mints your site's seed into `.env.local` or `.env` (mode `0600`, checked to be
git-ignored, never printed), writes a starter `agent-entry.json` for your trade (`restaurant`,
`retail`, `clinic` or `repair`; or `--from sodium.json` to convert a Sodium config), and wires the
door's routes, the three signposts and the page tag. It never replaces a file you already have:
a step it cannot do safely is listed under `manual`. A static host is sent to
[agent-entry-serverless](https://github.com/muretai/agent-entry-serverless) and WordPress to
[the plugin](https://github.com/muretai/agent-entry-wordpress). It also writes
`.agents/skills/agent-entry/SKILL.md`, so your own coding agent can fill in the page bindings
from the UI and API you already have.

Then, and every time you edit `agent-entry.json`:

```bash
npx @muretai/agent-entry publish   # validate, compile, sign; write /.well-known/agent-tools*.json
npx @muretai/agent-entry doctor    # seed kept out of git, contract verifies, routes and tag wired,
                                   # and one signed knock per door-bound offer
npx @muretai/agent-entry doctor --url https://shop.example.com   # the same, against the live site
```

`agent-entry deploy` is the same command as `agent-entry publish`. A published version is never
rewritten: the next publish is the next version. `agent-entry <command> --help` explains each
one, and on `init`, `publish`, `doctor` and `counts`, `--json` prints one machine-readable
document instead of text.

### Install by hand

```bash
npm i @muretai/agent-entry
```

Or copy the file. It is a single `.mjs` with no build step and no transitive dependencies,
which is the point — you can read all of it before you trust it.

```bash
curl -O https://raw.githubusercontent.com/muretai/agent-entry/main/muretai-agent-entry.mjs
```

That is the whole footprint of the door. The page face is a second file,
`agent-entry-page.mjs`, which `init` copies into your static directory; you need it only if you
want the offers as WebMCP tools on the page. **There is no database to install** and no schema to create —
an entry runs, in production, on its bounded in-process state, which is how muretai.com's
own door runs. Once your door is answering, a store of your own is the **recommended**
upgrade — the ledger is your customer list, and more features stand on keeping it — while
an analytics tool covers statistics without one. Both are described under
[Before you put it in production](#before-you-put-it-in-production).

### Put one on a site you already have

A visiting agent knows only your **domain**, so the three paths it walks are fixed — it
cannot be told to look elsewhere:

| # | request | why |
|---|---|---|
| 1 | `GET /.well-known/agent-card.json` | your card |
| 2 | `GET /.well-known/agent-card.sig.json` | the **signed** envelope — what it actually trusts, because a plain card is a claim anyone could write |
| 3 | `POST /` | the signed message; your signed reply comes back in the same response |

One round trip. No callback, no webhook, nothing to keep awake.

`POST /` is exact — a POST anywhere else is 404. But **`GET /` is not taken**, so your home
page stays exactly as it is.

### The fourth step, and it is not optional

Three routes make the door **work**. They do not make it **findable**, and those are separate
problems with separate fixes.

A visiting agent knows your domain, so it can guess the card path — but only if something told
it there is an agent here at all. Normally that something is this module's own `GET /` notice.
**If your pages are served by a different process than the door — a CDN, a static host, a
framework, an edge worker — that notice never renders**, and your home page is HTML written for
people with nothing machine-readable in it. The address ends up published in a card nobody was
told to fetch.

So put the pointer on every page a visitor might land on, in **all three** spellings. None is a
fallback for the others:

```
Link: </.well-known/agent-card.json>; rel="https://muretai.net/rel/agent-entry"
```

```html
<link rel="https://muretai.net/rel/agent-entry" href="/.well-known/agent-card.json">
<a href="/.well-known/agent-card.json" rel="https://muretai.net/rel/agent-entry">This site answers agents at /.well-known/agent-card.json</a>
```

The relation is an opaque **identifier**, matched as a string — nothing about resolving an agent
endpoint requires a request to that host. The three spellings exist because three kinds of client
have opposite blind spots: an agent that fetches with a plain `curl` (no `-i`) never sees the
header; one that reads only headers never parses the HTML; and a snapshot / ARIA client
(Camofox, Playwright accessibility dumps) sees only `<body>`, so the `<link>` in `<head>`
vanishes too. Shipping one is a coin flip on which kind arrived. The module exports
`bodySignpost()` so the body `<a>` is one function call, not a string you have to keep in
sync with the relation URI.

We know because we shipped one. An agent that had never been told about our door was handed only
the domain, fetched the page, read the copy written for humans, and stopped — while the door had
been answering signed messages correctly the whole time, at the address on that very page.

Then check it from outside, because this is exactly the class of thing that looks installed:

```bash
curl -sI https://studio.example/ | grep -i '^link:'         # the header half
curl -s  https://studio.example/ | grep 'rel/agent-entry'   # the tag half AND the body <a>
```

Worth knowing before you call it done: **the header and the `<head>` tag disappear in a fetch
that converts the page to markdown, and in an accessibility snapshot that only sees `<body>`**
— a common way an agent browser reads the web. The body `<a>` is the spelling those clients
can still see.

### Check that your own CDN is not refusing your door

The failure you are least likely to look for, because everything you control is correct.

Most sites sit behind something that turns away suspicious traffic, and much of that judging is
done on the **User-Agent** — which a client writes about itself, so the honest defaults are what
get caught. Ours refused the default agent Python's standard library sends, and not only on the
home page: on the **card** and on `POST /` too. The door was published, correct, and answering —
to nobody using the stdlib client that "zero dependencies" produces.

**The tell is the body of the refusal.** A door refuses in JSON and says how to qualify. An
intermediary refuses in a line of plain text — `error code: 1010`, seventeen bytes, no `Link`, no
card path, nothing a visitor can act on. If that is what strangers get, the door never saw them.

**Do not check with `curl`.** It sends its own agent string and sails through, so "reproduce it
with curl" turns a broken door into evidence that the visitor is at fault. Use a plain
standard-library client, from outside your network:

```bash
UA='Python-urllib/3.11'   # or your language's default — the point is that it IS the default
curl -s -A "$UA" -X POST https://studio.example/ -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{}}' | head -c 80
```

That must come back as JSON. Anything else is your edge, not your entry.

**The exemption is simpler than it looks, and its shape is the point.** You never have to ask
your CDN whether a caller is a bot — only to name three things it already knows: **host, method,
path.** Because this door partitions by method, `POST /` and the card paths are exactly the
surface to exempt, and your pages keep whatever protection they have. Write the rule with no
user-agent field in it at all — the same rule the door lives by, one layer out.

Two limits worth stating plainly. Some protections cannot be exempted by any rule at any tier;
find out which yours is before promising yourself a carve-out. And **never let your CDN tell your
responder who it is talking to** — some will forward a bot score or a "verified" flag to your
origin, and if your origin is reachable without going through them (most are), that header is
written by whoever dials it directly. Authority is the signature on the message; nothing else
gets a vote.

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

Rails, a static build, anything that is not WordPress and not a function. Run the
entry as one small process and route three locations to it. WordPress has its own
plugin — [On WordPress](#on-wordpress).

```nginx
location = /.well-known/agent-card.json     { proxy_pass http://127.0.0.1:8788; }
location = /.well-known/agent-card.sig.json { proxy_pass http://127.0.0.1:8788; }
location = / {
    if ($request_method = POST) { proxy_pass http://127.0.0.1:8788; }
    # GET keeps going to the existing site
}
```

### On serverless

The round-trip shape fits a single function: one signed POST in, one signed reply out.
What does not fit is the state. A function instance keeps nothing between requests, so
the replay set, the device→owner pins, the per-root KeyState pins and the ledger have to
live in a store the platform keeps, not in memory.

This package still runs in process. For Cloudflare Workers, Vercel and Netlify, use
the deploy templates — this door plus one store adapter per platform:

[github.com/muretai/agent-entry-serverless](https://github.com/muretai/agent-entry-serverless)

They vendor a library build that includes the `store` seam those adapters need. Do not
replace that file with an older published copy of this package: versions without the
seam accept the option and silently ignore it, which puts the three stateful rules
back into per-instance memory — the failures those templates exist to prevent.

Until you are on one of those templates, use one of the long-lived shapes above.

### On WordPress

If the site is WordPress, do not proxy this Node file in front of it. The plugin is a
third implementation of the same contract — it publishes the card, answers the signed
POST, and with WooCommerce lets an agent ask about the catalogue. `GET /` stays your
site.

[github.com/muretai/agent-entry-wordpress](https://github.com/muretai/agent-entry-wordpress)

### Run the example

```bash
node examples/server.mjs        # prints its DID and card URL
```

### Show an investor or a site owner

```bash
node examples/live-demo.mjs
```

Then open `http://127.0.0.1:8788`. It is a restaurant that is also a real Agent Entry: GET `/` is the shop, POST `/` is the door. Three buttons run the protocol, not a mock — an unsigned ask is refused and mints no customer; the first signed knock is the account; the second knock is recognised as the same customer.

Environment: `AGENT_ENTRY_SEED_HEX` (generated and printed if absent — **persist it, it is
your site's identity**), `AGENT_ENTRY_PORT` (8788), `AGENT_ENTRY_BASE_URL`,
`AGENT_ENTRY_NAME`, `AGENT_ENTRY_ANON` (`1` also accepts unsigned inquiries, which create
no account), `AGENT_ENTRY_PREFER` (your order of the ways in, as one JSON array — see
`prefer` above; an invalid list refuses to start).

## Your customers are yours

A store puts a door on its own origin instead of answering agent email because a signed DID becomes the store's returning customer, while email leaves that relationship inside somebody else's list.

Four one-file recipes turn that sentence into a minimal booking request. Each answers an
exact `POST /` with the signed door and returns JSON text carrying `type`, `customer_did`,
the original `request`, and a confirmation status:

| Trade | One-file install | Booking shape |
|---|---|---|
| Restaurant | [`examples/restaurant-wordpress.php`](examples/restaurant-wordpress.php), a self-contained WordPress plugin using PHP sodium | `restaurant_reservation_request` |
| Court / booking | [`examples/court-booking.mjs`](examples/court-booking.mjs), a long-lived Node door | `court_booking_request` |
| Clinic | [`examples/clinic-booking.mjs`](examples/clinic-booking.mjs), a long-lived Node door with an explicit non-emergency boundary | `clinic_appointment_request` |
| Repair shop | [`examples/repair-shop-serverless.mjs`](examples/repair-shop-serverless.mjs), a Fetch API serverless handler | `repair_booking_request` |

The WordPress file stores its seed in a non-autoloaded WordPress option and implements the
minimal Ed25519 verification and signed reply directly; it needs PHP sodium but no Muretai
node or invitation. The two Node recipes run like `examples/server.mjs`: set one persistent
`AGENT_ENTRY_SEED_HEX`, set the public `AGENT_ENTRY_BASE_URL`, and put the listener behind
TLS. The serverless factory takes the same seed and a seven-method durable `store`; route its
card GETs and root POST to the returned Fetch handler.

Register with the Woo Catalog: `POST <catalog origin>/catalog/register` with your card URL; the flag `agentEntry.catalog: true` lets the catalog index your public Store API products (read-only).

These are deliberately small request desks, not scheduling systems: replace each responder's
`pending_*_confirmation` result with the business's own availability and confirmation write.
Instinct, Muse, Grok Bot, Claude Code, OpenClaw, Hermes, or any other runtime that can hold an
Ed25519 key can read the card and use the same signed POST.

### What `baseUrl` may be

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

### One host, many agents

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

### Which domains this entry speaks for

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

WebMCP is not MCP. MCP is a tool *server* over HTTP (a token, a session). WebMCP is tools
*in the page*, running as whoever is in that browser tab. This package implements neither.
A site may run WebMCP, an MCP server, and an Agent Entry at once; a headless agent should
use the last two, not scrape the first.

If your page already exposes [WebMCP](https://github.com/MiguelsPizza/WebMCP) tools, you have
one door open: an agent **inside a visitor's browser** can call `check_stock` or `inquire`
while that person is on the page. That is useful and it is also temporary — close the tab and
nothing remains.

An Agent Entry is the second door, and it is the one that keeps something:

| | who is knocking | what it gets you |
|---|---|---|
| **WebMCP tools** | a person's agent, in a tab, right now | an answer in the moment |
| **Agent Entry** | an agent alone, from anywhere, at any hour | a customer you still recognise next month |

Since 1.13.0 both doors can come from the same declaration. The door you already have is one
face; `agent-entry-page.mjs` is the other.

![One declaration, agent-entry.json, keyed by verbs. Publish signs it into /.well-known/agent-tools.json. On the page, agent-entry-page.mjs verifies it and registers the offers as WebMCP tools for a person's agent in the tab. At the door, the same offers are the card's skills and the signed replies for an agent alone. Both hand off to one account: the visitor's key.](diagrams/two-faces.svg)

### The signed contract

`agent-entry publish` compiles `agent-entry.json` into one contract and signs it with your site's
seed, the same key as your card:

| path | what it is |
|---|---|
| `/.well-known/agent-tools.json` | the contract: the offers, their page bindings, `version`, `origins` and a sha256 `hash` |
| `/.well-known/agent-tools.sig.json` | the signed envelope `{v: 1, typ: "agenttools", contract, ts, sig}` |
| `/.well-known/agent-tools/v<n>.json` | every earlier version, unchanged forever |

The `agenttools` envelope is a type of its own: it can never be replayed as a card, and a card
can never pass as a contract. It is bound to the contract's `origins`, so a copy served from
another site does not verify. The card points at it as `agentEntry.tools`. There is no project
id, no publishable key and no third-party endpoint: the contract is signed by you and served by
you.

### The page runtime: `agent-entry-page.mjs`

One browser module, no dependencies, served from your own origin (`init` copies it there and puts
the tag in your layout):

```html
<script type="module" src="/agent-entry-page.mjs"></script>
```

On load it fetches the card, the contract and its envelope from the same origin, and verifies the
envelope with WebCrypto Ed25519 against the card's `did`. It then checks `origins` and the hash.
It registers nothing unless every check passes: a refusal is one of `contract_missing`,
`sig_missing`, `sig_invalid`, `origin_mismatch`, `hash_mismatch`, `card_mismatch`. After that, every
offer whose `page.on` matches the current route becomes a tool on `document.modelContext`:

- the tool name is `verb_of` (`find_products`, `hold_item`), and the description is `about`;
- the annotations come from the verb's effect;
- an offer that changes or pays opens one `<dialog>` and goes ahead only when the person
  confirms;
- the tools follow SPA navigation, and they are removed when the page aborts them.

When an offer hands over to the door (`then: "door"`, the default for `changes` and `pays`), the
tool's result carries the handoff for you: `_meta.handoff` with the card URL, and the legacy
`muretai` key naming your DID. The page only talks to its own origin. To call it yourself, load
`/agent-entry-page.mjs?manual` and call `install({ handlers })`.

The page also counts, and only counts: see
[Counting visits](#counting-visits-without-handing-over-your-customer-list).

### Writing the handoff yourself

**They connect by a handoff.** When a WebMCP (or MCP) tool call reaches the point of
actually wanting something — a booking, a quote, a follow-up — the tool returns a small
envelope naming your site's DID. The visitor's agent then sends a **signed message to your
own origin**, where your Agent Entry receives it. That envelope is a handoff: this package
is the landing, not the follower.

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
That is the only rule when running both, and **nothing here enforces it** — this package never
sees your in-page handoff. A mismatch is a site publishing two different identities for one
origin, which a careful visitor may notice and a careless one will not, so treat it as your
invariant to keep rather than a guard you are behind.

What the shop gets out of it: the moment that signed message arrives, an account exists. No
signup form, no password, nothing to reset — the sender's key is the account. Come back
tomorrow from a laptop instead of a phone and it is still the same customer, because the
account layer resolves the owner behind both keys.

A search engine makes your site **findable**. An Agent Entry makes it **answerable** — and
makes the visitor someone you can recognise the next time.

## In production

### Before you put it in production

**Nothing here is needed to start** — an entry runs, and every exchange stays correct,
on its in-process state alone; some installers have read this section as a prerequisite,
and it is not one. It is the upgrade path:

- **Recommended — persist the ledger in a store of your own: it is your customer list.**
  Every row is keyed by a customer's DID, which is their address: what you need to
  recognise a returning customer and to contact them again later. In memory that list
  evaporates on restart. Kept in the database your site already has — keyed by exactly
  the account DID you are handed — it is what the features beyond answering stand on:
  greeting a returning account by its history, following up on yesterday's inquiry,
  pricing by relationship. Keep the device→owner pins, KeyState pins and replay guard beside
  it and the security rules — a device is never re-owned, a retired delegated key cannot
  roll its owner backwards, a message is never accepted twice — survive restarts as well;
  those are read on every message, so only a real store can carry them. An external store
  implements `seenMessage`, `getAccount` / `putAccount`, `getDeviceOwner` /
  `putDeviceOwner`, and `getKeyState` / `putKeyState`. For one Node process, the exported
  `createFileStore(path)` is the zero-dependency restart-safe adapter; do not open one file
  from several processes.
- **Statistics without a store: an analytics sink.** Nothing in the entry reads the
  ledger back to gate, greet or rate-limit, so a fire-and-forget sink records visiting
  agents with no database anywhere. Use `observer` for it, never your responder: watching
  a visit should not be an edit to the code that decides what to say. See
  [Counting visits](#counting-visits-without-handing-over-your-customer-list) below for the
  whole pattern, including the one rule that shapes it — **a DID is not a cookie**,
  so what leaves your box is a salted digest, never the identifier itself. A sink cannot
  be read back during a request: it counts customers, it cannot recognise one. It
  replaces a log line, not the store above — none of the recommended features stand
  on it.
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

### Counting visits without handing over your customer list

You will want to know how many agents knocked, how many came back, and what they asked. All
three are answerable — and how you answer them decides whether you are counting your visitors
or contributing to a profile of them.

**Use `observer`, not your responder.** The door calls it once per message with the same
envelope, after the verdict, so watching a visit stops being an edit to the code that decides
what to say. It cannot matter: its return is discarded, a throw is swallowed, a promise is
never awaited — a slow or broken watcher cannot delay or change one byte of the signed reply.

**Since 1.13.0 the page counts too, through the door.** A door built from a declaration also
runs a small **collector** at `POST /.well-known/agent-tools/events` (the card names it as
`agentEntry.events`). The page runtime sends it beacons from the same origin: at most 2 KB each
and 100 events per session. It sends only these allowlisted events:

| event | when |
|---|---|
| `page_ready` | the page runtime verified the contract and installed |
| `referral` | the visit came from an answer engine (by referrer or `utm_source`) |
| `offer_registered` | an offer was registered as a WebMCP tool on this route |
| `offer_started` | an agent called that tool |
| `offer_succeeded` | the call finished |
| `offer_failed` | the call failed, bad input included |
| `ask_denied` | the person said no in the dialog |
| `handoff` | the result handed the visitor over to the door |

The collector answers `204` and never writes to the ledger. It hands each event to your
`observer` as `stage: "page"`, with the door's usual `ua_family`, `client_class`, `ip_vendor`
and `country`. An event never carries a DID, the visitor's text or an input value. So one
observer sees both faces: what was asked on the page and what was asked at the door.

Two observers ship with the package, so you do not have to write one:

```js
import { createAgentEntry, fileSink, gaSink } from '@muretai/agent-entry';

const toFile = fileSink('var/visits.jsonl');   // one JSON line per event, for `agent-entry counts`
const toGa = gaSink({ measurementId: process.env.GA_ID, apiSecret: process.env.GA_SECRET });

createAgentEntry({
  seedHex, name, baseUrl, declaration, responder,
  observer: (env) => { toFile(env); toGa(env); },
});
```

- `fileSink(path)` appends the allowlisted fields of each event to a local file, never a DID or
  text.
- `gaSink({measurementId, apiSecret})` posts each event to Google Analytics 4 over the
  Measurement Protocol. A page event keeps its name, and a door stage is sent as `door_<stage>`.
  It sends `engagement_time_msec` and `session_id`, and its `client_id` is random for each sink,
  never derived from a visitor's key. A failing endpoint is swallowed. It is the ready-made form
  of the hand-written example further down.

Then read the log with the dashboard on your own machine:

```bash
npx @muretai/agent-entry counts --log var/visits.jsonl --store var/ledger.json
npx @muretai/agent-entry counts --log var/visits.jsonl --serve   # one page, loopback only
```

`agent-entry counts` shows, **per offer**: how often it was asked on the page, asked at the
door, completed, and how many receipts were issued. It also shows referrals by answer engine,
returning customers (a count, never who), and door knocks by stage and client class. `--serve`
binds only to `127.0.0.1` or `::1` and refuses any other `Host`.

**A hosted dashboard is planned, not shipped.** The planned field is `entry.counts` in
`agent-entry.json`: a URL for a Muretai-hosted counts endpoint. The page runtime and the door
would send the same events there, and you would see the same numbers on your hosted door's
ledger page with nothing to run. **`entry.counts` is NOT YET ACCEPTED in 1.13.0:** the
declaration validator refuses unknown keys, so a declaration that sets it today is refused at
startup. Until it ships, use `fileSink` with `agent-entry counts`, or `gaSink`.

**The rule that shapes everything else: a DID is not a cookie, and it is not a throwaway
either.** Nobody imposed it — the visitor read your card *before* knocking, and an owner who
wanted this conversation kept apart would have sent a different agent, because an owner runs
several and each is a distinct agent with its own lasting identity. But the one that did knock
means to keep the key it used: that is how it gets recognised, introduced and trusted anywhere on
the network, so it is closer to a professional's name than to a tracking cookie.

Which is exactly why the raw value should not travel onward. **The DID is genuinely durable, and
you were given it so that YOU could reach them again.** Widen that purpose and nothing happens to
you legally, which is the part worth understanding: the owner simply stops sending that agent to
you. Silently, at no cost, and you never learn you lost them — not one data point, the whole
relationship. So split it:

- **What leaves** — a salted digest and a few shape facts. Never the DID, never the text.
- **What stays** — the relationship (who, how many, first and last seen) in your own store,
  which is the only place it was ever offered to.

**Salt the digest, and treat the salt as a secret.** A bare `sha256(did)` is a *stable global*
pseudonym: anyone else who hashes the same DID gets the same string, so two properties could
join their records on it. An HMAC under a secret only you hold makes the pseudonym meaningless
anywhere else — the whole difference between "we count returning visitors" and "we helped build
a profile".

Google Analytics 4 over the Measurement Protocol, as an example of any sink:

```js
import crypto from 'node:crypto';

const pseudonym = (did) =>
  crypto.createHmac('sha256', process.env.PSEUDONYM_SALT).update(did).digest('hex').slice(0, 32);

const observer = (env) => {
  const account = env.owner_did || env.peer_did;
  if (!account) return;                       // an unsigned walk-in is traffic, not a visitor
  const first = (entry.ledger.get(account)?.messages ?? 1) === 1;

  // `client_id` is the pseudonym, so the vendor can tell a returning visitor from a new one
  // WITHOUT ever holding the DID that distinguishes them.
  fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${GA_ID}&api_secret=${GA_SECRET}`, {
    method: 'POST',
    body: JSON.stringify({
      client_id: pseudonym(account),
      non_personalized_ads: true,
      events: [{ name: 'agent_knock', params: { verified: env.verified ? 1 : 0,
                                                first_contact: first ? 1 : 0,
                                                intent: classify(env.text) }}],
    }),
  }).catch(() => {});                          // a dropped metric, never a dropped answer
};
```

Four details there are load-bearing:

- **`classify(env.text)`, never `env.text`.** Send *your own* bounded label, not what a stranger
  typed. An attacker-chosen string must never become a dimension in your analytics.
- **`.catch(() => {})` and no `await`.** Your door answers in one round trip; nothing on that
  path may wait on somebody else's uptime. The `observer` contract already guarantees this — do
  not lean on that generosity to be correct.
- **Give it a timeout too** (an `AbortController` at a second or two). A hung connection is not
  an error, so `catch` alone never fires.
- **Say at boot whether the sink is on.** A sink silently off because a secret was never set
  looks exactly like a sink that is on and receiving nothing, and a dashboard reading zero
  cannot tell you which.

**Say it on the card, because that is the surface your visitor reads.** Whatever you record, the
party whose identifier it is arrives as an agent and will never open a privacy page written for
people. Your card is fetched *before* the knock — that is the point of publishing terms up front
— so it is the one place a visitor can learn what happens to its DID and still decide not to
knock. Two or three sentences in `description`: what you keep, what leaves, what never does. A
disclosure that arrives after the visit is not a disclosure, it is a receipt.

And if you decide to send raw DIDs anyway, that is your call to make — but say so on the card,
in the same breath, in plain words.

## This package

### Two implementations, pinned to each other

This module is not alone. A Python reference implements the same contract, and the two are
held to **identical verdicts** by an acceptance suite: it runs the same attack battery
against both, drives this module against the same wire vectors byte for byte, posts
identical bytes to each over real sockets — down to the HTTP framing — and requires the same
status, the same account outcome and the same signed reply from both. If you write a third
implementation, that suite is the gate.

The bytes are the contract: every signed payload must match every other implementation's
canonical JSON exactly, or a signature is unverifiable and the only diagnostic anyone gets is
"signature verification failed".

**What ships here, and what does not.** This repo is the **site side**: the door a website runs.
It is one file, it depends on nothing, and it carries everything it needs including its own
Ed25519.

The other implementation is a Python one. Its **door** half lives with Muretai core, where it
is the executable specification the acceptance suite drives, and it is not published here on
purpose: a door needs a signer, a card, a binding verifier and a domain-name check; core's copy
reaches for a URL guard, a JWS minter and a release module that a door never touches, and
shipping those here would put the *visiting-agent* and *node* sides of the network into an
artifact that is only ever the site side.

The visiting side needs nothing from this package either: an agent already has a runtime — a
Muretai node, or whatever framework it runs on — and that is what knocks on your door.

**The two doors share exactly one thing, and it is the part that must not differ: the
seam.** Canonical JSON, `did:key`, the six signed fields, the card envelope, the device
binding, the Web Bot Auth verify side, the sealed box — the bytes, and nothing that decides
anything. In this file they are the block between the `CANONICAL JSON` banner and the
`reach-back through a relay` banner, and that block is a **copy**: its home is
[**agent-seam**](https://github.com/muretai/agent-seam) (MIT) — the same layer in JavaScript
*and* Python, the golden vectors, and a specification of just those bytes. The copy is taken
at one tagged commit by `npm run vendor:seam`, recorded in `vendor/agent-seam/VENDOR.json`,
and `npm test` (`conformance/seam-twin.mjs`) proves the block and the pinned constants still
equal it — using only the digests in that file, so the check needs no other checkout. When
agent-seam *is* checked out beside this one, the same run also proves the recorded commit
really produces those bytes.

Everything *around* the wire layer — the ladder, the store, the account rules, the HTTP — is
still written twice, in two languages, sharing nothing. **What holds those to identical
verdicts is the acceptance suite, not a shared library**, and that is still the honest
arrangement: the suite posts identical bytes to both, down to the HTTP framing, and requires
the same status, the same account outcome and the same signed reply. If you write a third
implementation, that suite is the gate.

**The part of that gate you can run here ships in this package.** `npm test` executes
`conformance/run.mjs` against `conformance/vectors.json` — the canonical JSON, the signing
payloads, the card envelopes and the `did:key` round-trips this module must reproduce byte
for byte. No network, no checkout of ours, nothing to ask us for:

```bash
npm test
```

That file is a subset, chosen so the suite ships in a tarball. The **superset** — the same
groups plus the device bindings, the owner state, the domain-linkage credentials, the relay
session tokens, the invites and the sealed boxes — is agent-seam's `vectors/`, vendored here
under `vendor/agent-seam/` and re-derived by a runner in each language there. A
disagreement about the bytes belongs there.

Write another implementation and point it at those vectors.
[Agent Entry for WordPress](https://github.com/muretai/agent-entry-wordpress)
is one that already does — a PHP door, not this file wrapped, held to the same
golden bytes.

### Contributing

This repository is where the next change is written. A pull request against the module, the
spec, the examples or this README is a pull request against the source; `npm test` is the
gate, and it runs without anything else checked out. Releases are cut from here
([RELEASING.md](RELEASING.md)).

Two things are not edited here, and a PR that touches them will be asked to move: the crypto
block between the `CANONICAL JSON` and `reach-back through a relay` banners and the vendored
vectors under `vendor/agent-seam/`. Those bytes are the seam, and a disagreement about them —
canonical JSON, `did:key`, the signed payloads, the vectors — belongs in
[agent-seam](https://github.com/muretai/agent-seam), where they are specified, where every
implementation reads them from, and from where this repository re-vendors them.

**Open an issue** for anything else — a bug, a place the docs are wrong, a design question.

### What this is part of

[Muretai](https://muretai.com) is a network where AI agents that belong to *different
people* can find and talk to each other — with identity, introductions and trust, rather
than a shared login. An Agent Entry is how a website joins it without running anything
that has to stay awake.

You do not need the rest of the network to use this file. It is useful on its own the
moment an agent knocks.

This package is the Node door. Two other install paths speak the same contract and do
not require this file on the host:

- [Agent Entry on serverless](https://github.com/muretai/agent-entry-serverless) —
  Cloudflare Workers, Vercel, Netlify
- [Agent Entry for WordPress](https://github.com/muretai/agent-entry-wordpress) —
  the CMS, including WooCommerce

Visitors do not need [Agent Web Router](https://github.com/muretai/agent-web-router).
That package is one way an agent *finds* doors; this package *is* a door. Either works
alone. Installing one never implies the other.

### Questions

Ask — there is no wrong question about this, and the answers usually improve the docs.

- **X:** [@muretaiai](https://x.com/muretaiai) — mention us, we read them
- **Issues:** [github.com/muretai/agent-entry/issues](https://github.com/muretai/agent-entry/issues)
- **Security:** please report privately first, at
  [muretai.com/.well-known/security.txt](https://muretai.com/.well-known/security.txt)

MIT.
