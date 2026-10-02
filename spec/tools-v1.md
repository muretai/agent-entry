# Agent Entry Tools v1

**One declaration, keyed by what a customer can do, that becomes a site's signed tool contract,
its card's skills, and its door's replies.**

Status: **Draft.** Version 1. Companion to [Agent Entry v1](v1.md); every requirement there
still holds. Editor: Muretai. Feedback: <https://github.com/muretai/agent-entry/issues>.
Licence: MIT, like the reference implementation.

---

## 1. What this specifies

An agent that is handed a URL wants to know what its person can do there. This document gives
a site one file, `agent-entry.json`, that answers that. The file lists **offers**. An offer is a
**verb** (`book`, `buy`, `ask`, …) plus an **object** (`table`, `order`, `anything`, …). From
that one file an entry generates three things, so they cannot disagree:

- the **contract**: a signed document at `/.well-known/agent-tools.json`, listing the offers a
  page runtime may register as tools;
- the **card's `skills[]`**: one skill per offer;
- the **door's default replies**: one per offer that has a door binding.

The byte-level rules are also written as data in `conformance/vectors-tools.json`. A second
implementation can read that table instead of this prose. Where the two disagree, the vectors
win, and the disagreement is a defect in this document.

The key words **MUST**, **MUST NOT**, **SHOULD** and **MAY** are as in RFC 2119 and RFC 8174.
"The door" is an Agent Entry as specified in v1. "Canonical JSON" is the encoding v1 §4.3 uses
for the signed card envelope (sorted keys by code point, no whitespace, UTF-8, integers only
where the seam allows them).

## 2. Normative requirements

### 2.1 The declaration

**AT-1. Grammar.** A declaration is a JSON object with exactly these keys: `v` (the number
`1`), `entry`, `offers`, and optionally `facts`.

- `entry` is `{name, baseUrl, domains?, prefer?, catalog?, counts?}`:
  - `name` is a non-empty string;
  - `baseUrl` is the URL visitors dial, under the rules of v1;
  - `domains` is a list of bare domain names;
  - `prefer` is an `agentEntry.prefer` list (v1 AE-30);
  - `catalog` is a boolean;
  - `counts` is an absolute `https` URL with a host. Plain `http`, any other scheme, a
    relative or protocol-relative reference, and a non-string are refused as `entry.counts`.
- `offers` is a non-empty list of offers. Each offer is
  `{verb, of, about, input, effect?, ask?, then?, page?, door?}`.
- `verb` and `of` match `^[a-z][a-z0-9_]*$`. The offer's id is `verb + "_" + of`. Two offers
  **MUST NOT** have the same id.
- `about` is a non-empty string.
- `input` is a field map from a field name to one of `string`, `integer`, `number`, `boolean`.
  It may be empty.
- `page` is `{on, do, then?}`:
  - `on` is a non-empty list of same-origin route patterns;
  - `do` holds exactly one of `open` (a same-origin path), `read` (a selector),
    `fill` (`{form}`), `fetch` (`{method: "GET"|"POST", path, query?}`, where `query` maps a
    parameter to an input field), or `call` (a function name);
  - `then` may only be `"door"`.
- `door` is `{reply, receipt?, url?}`:
  - `reply` is one of `catalog`, `facts`, `pending`, `checkout`, `brain`, `human`;
  - `receipt` is a boolean;
  - `url` is required for `checkout` and allowed for nothing else.
- An offer **MUST** have a `page` binding, a `door` binding, or both.
- `facts` maps a name to a string. A `facts` reply needs declared `facts`.

A **same-origin path** starts with one `/`, not `//`, and is printable ASCII with no backslash.
`{field}` placeholders in a checkout `url` or in `page.do.open` **MUST** name fields of the
offer's `input`.

**AT-2. Validation refuses whole, and names the field.** A declaration that breaks AT-1 **MUST**
be refused as a whole. The refusal **MUST** name the offending field, for example
`entry.prefer`, `door.url`, or the duplicated offer id. An entry given such a declaration
**MUST** refuse to start. It **MUST NOT** publish a corrected or partial set of offers. This is
the same posture as `prefer` in v1 AE-30. Unknown keys are refused, so a misspelt `efect` cannot
silently drop a declared effect.

> **Observation.** For every entry in `vectors-tools.json` `refusals`: validation throws, the
> message contains `field`, compiling throws, and an entry refuses to start. For every entry in
> `accepted`: validation and compiling succeed.

### 2.2 Verbs and their defaults

**AT-3. The verb registry.** Registry v1 has these verbs, in this order: `find`, `ask`, `quote`,
`book`, `hold`, `order`, `buy`, `track`, `change`, `cancel`, `join`. Each has a default
`effect`:

| effect | verbs |
|---|---|
| `none` | `find`, `ask`, `quote`, `track` |
| `reversible` | `cancel` |
| `changes` | `book`, `hold`, `order`, `change`, `join` |
| `pays` | `buy` |

An implementation **MUST** use these spellings and these defaults. A caller **MUST NOT** be able
to change them at runtime (the reference freezes `VERBS`, `VERB_EFFECTS` and `ASK_FLOOR`).

**AT-4. Site-added verbs.** A site **MAY** use a verb outside the registry. Such an offer is
passed through **with no defaults**:

- it gets no `effect`, no `ask` and no `then` unless it declares them;
- its `door.receipt` defaults to `false`.

In particular, **a site-added verb gets no ask floor unless it declares `effect`**. An offer
whose action pays or changes something for the customer **MUST** use the registry verb for that
action, or **MUST** declare `effect`. Nothing in a declaration may rename a paying action to
skip the page's confirmation.

> **Why no inferred defaults.** The registry is how agents match intent across shops. Guessing
> an effect for `rent` would be a second, silent registry. An explicit `effect` is the only
> extension mechanism in v1. `doctor` warning on a site verb without `effect` is a named
> follow-up (S3).

**AT-5. Effect, ask floor, handoff and receipt.**

- The page's confirmation floor per effect is: `none` → `never`, `reversible` → `advised`,
  `changes` → `advised`, `pays` → `always`.
- An offer **MAY** raise `effect` along `none < reversible < changes < pays`. It **MAY** raise
  `ask` along `never < advised < always` above the floor of the resolved effect. Lowering either
  **MUST** be refused.
- The compiled offer's `then` is `"door"` in three cases: the offer says `then: "door"`, its
  page binding says `then: "door"`, or its resolved effect is `changes` or `pays`. `then: "none"`
  opts out and removes the key. A page `then` is folded into the offer's `then`, and the
  compiled page binding carries no `then`. An offer that says `then: "none"` while its page
  says `then: "door"` is refused.
- `door.receipt` defaults to `true` for `hold`, `book`, `order` and `quote`, and to `false` for
  every other verb. An offer **MAY** set it either way.

### 2.3 The contract

**AT-6. Compilation is deterministic.** Compiling a declaration at version `n` (a positive
integer; the default is 1) **MUST** produce this contract:

```
{ v: 1, name: entry.name, origins, version: n, offers, facts (only when declared), hash }
```

- **`origins`** starts with the origin of `entry.baseUrl`. Then comes `"https://" +` each
  lowercased `entry.domains[i]`, in order, without duplicates.
- **Each compiled offer** is
  `{id, verb, of, about, input, effect?, ask?, then?, page?: {on, do}, door?: {reply, receipt, url?}}`.
- **`hash`** is the lowercase hex SHA-256 of the UTF-8 bytes of canonical JSON of the contract
  without `hash`. `version` is inside what is hashed.

The canonical bytes **MUST** be identical for identical input, whatever order the keys were
written in. The order of `offers[]` is data and is kept. Compiling **MUST NOT** change its
input.

> **Observation.** Every vector in `vectors-tools.json` compiles to its `contract`, byte for
> byte. It still does after the keys are reversed, and the declaration is unchanged afterwards.

**AT-7. Skills are generated.** A door started with a declaration **MUST** publish `skills[]` on
its card: one skill per offer, in order, and nothing else. Each skill is:

```
{ id, name: id, description: about, tags: [verb, of], examples }
```

`examples[0]` is `about`. When `input` is non-empty, `examples[1]` is `verb + " " + of + " "`
followed by canonical JSON of `{<field>: "<" + type + ">"}` over the input's fields. The
signed card envelope carries the same skills.

### 2.4 The signed envelope and where it is served

**AT-8. The `agenttools` envelope.** The contract is signed with the site's own seed, the same
key its card names. The envelope is:

```
{ v: 1, typ: "agenttools", contract, ts, sig }
```

- `ts` is an integer epoch.
- `sig` is base64 of the Ed25519 signature over canonical JSON of `{contract, ts, typ, v}`.
  This is the card envelope's construction (v1 §4.3) with its own `typ`.
- Because `typ` is inside the signed bytes of both envelopes, an `agenttools` signature **MUST
  NOT** verify as an `agentcard` one, and the reverse.
- A verifier **MUST** be given the expected DID. The contract names no key; the card does.
- A verifier **MUST** refuse an envelope whose contract `hash` does not match the contract's
  own bytes, even when the signature is good.
- A signer **MUST NOT** sign such a contract.

**AT-9. Origin binding.**

- A verifier given the origin it fetched from **MUST** refuse a contract whose `origins` does
  not contain that origin exactly (scheme, host and port, as URL serializes an origin).
- A door **MUST** refuse to start with a declaration whose `entry.baseUrl` origin is not the
  door's own.
- There is no project id, no publishable key and no third-party endpoint. The key is the site's.

**AT-10. Serving, and versions are immutable.** A door started with a declaration **MUST** serve
the following, each hanging off its mount like every v1 route:

- **`GET /.well-known/agent-tools.json`**: the current contract, as the UTF-8 bytes of its
  canonical JSON, `Content-Type: application/json`.
- **`GET /.well-known/agent-tools.sig.json`**: the envelope, fresh by the card envelope's rules
  (under 6 hours old, never in the future). It is cached rather than minted per request.
- **`GET /.well-known/agent-tools/v<n>.json`**: for every published version `n`, its canonical
  bytes. The current version is also served here. A prior version **MUST** be served byte for
  byte as first published.

The card gains `agentEntry.tools` and `agentEntry.events`: the absolute URLs of the contract and
of the collector (AT-14). The legacy `muretai` alias **MUST NOT** carry them.

Method rules:

- `OPTIONS` on the three contract routes answers 204 with `Allow: GET, HEAD, OPTIONS`.
- Any other method on them answers 405 with the same `Allow`.
- The collector answers `Allow: POST, OPTIONS`.
- Every other address under the `agent-tools` prefix answers 404 for every method (v1 AE-4).
  That includes `v<n>` beyond the current version, `v0`, zero-padded or upper-case spellings,
  and a trailing slash.

A door started with prior versions **MUST** refuse to start when any prior version:

- fails its own hash;
- is out of sequence (versions are 1, 2, … with no gap or repeat);
- or does not name the door's origin.

A door without a declaration **MUST** be exactly the door it was: no `tools` or `events` on the
card, and every one of these routes 404.

### 2.5 The door answers offers

**AT-11. One method, and `metadata.offer`.** Offers ride the one method, `message/send`. They
are never methods of their own, and page tools are never turned into A2A methods. A visitor
picks an offer with `params.message.metadata.offer`, which is either an offer id (`hold_item`)
or a registry verb (`hold`).

- A registry verb picks the one door-bound offer with that verb. It picks nothing when two
  door-bound offers share it.
- A value that picks no offer with a door binding **MUST** be refused with JSON-RPC `-32602`.
  That covers an unknown id, a verb the door does not offer, a page-only offer, a non-string,
  and a near miss such as a trailing space or a different case.
- The refusal **MUST NOT** create an account row and **MUST NOT** echo the value.

`metadata.offer` is not one of the six signed fields. See §4.

**AT-12. Default replies.** For a chosen offer whose `door.reply` is not `brain`, the door
answers with a signed reply whose text is a JSON object:

```
{ verb, of, customer_did, request, status, ...by kind, deal? }
```

- `customer_did` is the signer's DID. On the anonymous lane it is null.
- `request` is the signed text.
- There is **no `type` key**.

By kind (the reference's status strings are given for interoperability):

- **`pending`**: `status: "pending_confirmation"`, and exactly those keys plus `deal` when a
  receipt applies.
- **`facts`**: `status: "answered"`, plus `facts`, a copy of the declared facts.
- **`catalog`**: `status: "see_catalog"`.
- **`checkout`**: `status: "continue_at_checkout"`, plus `url`, the door's origin followed by
  the declared checkout path. Its `{field}` placeholders are filled, percent-encoded, from a
  JSON object the visitor wrote after its words, else left empty. A checkout reply **MUST NOT**
  carry an amount, a price, or any payment field. Payment is never touched.
- **`human`**: the site's responder is not called, and the account row is kept as for any
  signed message. The reply says that someone will answer (reference: `status:
  "awaiting_person"` and a `note` saying "We will answer …").
- **`brain`**: the site's own responder answers. Its text is returned verbatim, and its envelope
  gains `offer`, the chosen offer's id. A brain reply carries no `deal`: the door does not
  rewrite the site's text.

A door built without a declaration keeps its own skills, responder and reply bytes unchanged.
The recipe doors' card and reply bytes are pinned in
`conformance/fixtures/recipe-replies-pre-offers.json`.

**AT-13. The `deal` block.** When the chosen offer's `door.receipt` is true and the visitor
signed, the reply **MUST** carry a deal block. The block is ready for a 2-of-2 receipt and is
the JS twin of trunk `shared/deal.py`'s half-signed offer:

```
{ type: "DealReceipt", partyA: <door DID>, partyB: <customer DID>, termsHash,
  contextId: <request contextId or null>, ref: <request messageId>, ts, salt, sigA }
```

- `salt` is at least 16 fresh random bytes per deal, in base64.
- `termsHash` is the hex SHA-256 of canonical JSON of `{terms}` followed by the salt bytes.
  `terms` is the reply object without `deal`.
- `sigA` is the door's Ed25519 signature, in base64, over canonical JSON of the seven fields
  `{type, partyA, partyB, termsHash, contextId, ref, ts}`.
- The visitor countersigns the same payload when its runtime can. The block carries no `sigB`.

### 2.6 Counting

**AT-14. The collector.** A door with a declaration **MUST** accept
`POST /.well-known/agent-tools/events`.

The body is `{session, events: [event, …]}`:

- `session` matches `^[A-Za-z0-9_-]{8,64}$`;
- each event is `{name, offer?, engine?, ms?}` and nothing else;
- `name` is one of the collector's event names (below);
- `offer` is an offer id the contract declares;
- `engine` is one of `chatgpt`, `claude`, `perplexity`, `gemini`, `copilot`, `grok`,
  `deepseek`, `mistral`, `you`, `other`;
- `ms` is an integer from 0 to 600000.

The event names are normative. They are exactly `page_ready`, `referral`, `offer_registered`,
`offer_started`, `offer_succeeded`, `offer_failed`, `ask_denied`, `handoff`. No other spelling
is accepted: the `tool_*` names of other products are not these names.

Refusals:

- An `Origin` that is missing, `null`, or not one of the contract's `origins` → **403**.
- A body over 2048 bytes → **413**, before parsing.
- Any other bad part, including a byte order mark, a non-object, more than 100 events in one
  body, or one bad event among good ones → a **4xx that refuses the whole body**. No event of
  it is counted, and the refusal does not echo what was sent.

An accepted body answers **204** with no body. At most 100 events per session are counted;
events past the cap are dropped silently.

The collector **MUST NOT** carry or accept a DID, free text, or input values, and **MUST NOT**
write to the ledger. The reference hands each counted event to its observer as `stage: "page"`,
with the door's usual `ua_family`, `client_class`, `ip_vendor` and `country` (v1 AE-31).

### 2.7 The page runtime

A **page runtime** is the browser code a site serves from its own origin to register its offers
as WebMCP tools. The reference is `agent-entry-page.mjs`: one file, no dependencies, exporting
`install({window, signal, handlers})` and the frozen list `REFUSALS`. The observations below are
checked by `conformance/page.mjs`, which runs the reference under Node against a fake `window`
and a real door.

**AT-15. The refusal set.** A page runtime fetches three documents, all from the page's own
origin (`location.origin`): the card at the v1 card path, the contract at
`/.well-known/agent-tools.json`, and its envelope at `/.well-known/agent-tools.sig.json`. It
**MUST** refuse to register anything unless all of these checks pass. Each refusal has one name,
and the names are exactly these six, in this order:

| reason | when |
|---|---|
| `contract_missing` | the contract is not served, or is not a JSON object |
| `sig_missing` | the envelope is not served, or is not a JSON object |
| `sig_invalid` | the envelope's `v` is not `1` or its `typ` is not `agenttools`; the signature does not verify under Ed25519 against the card's `did` over canonical JSON of `{contract, ts, typ, v}` (AT-8); or the browser cannot verify Ed25519 at all |
| `origin_mismatch` | the signed contract's `origins` does not contain `location.origin` exactly (AT-9) |
| `hash_mismatch` | the signed contract's `hash` is not the SHA-256 of its own canonical bytes, or the served contract is not the signed one |
| `card_mismatch` | the card is not served or not JSON, its `did` is not a `did:key` for Ed25519, or it has no `agentEntry.tools` |

- A card that names a different key than the one that signed the envelope is `sig_invalid`.
  The runtime cannot tell that apart from a forged signature.
- A refusal **MUST** resolve as `{ok: false, reason}`, **MUST NOT** throw, **MUST NOT** register
  any tool, and **MUST NOT** send any count.
- Verification **MUST** use the browser's own WebCrypto (`crypto.subtle`), never a script from
  another origin.
- A browser without `document.modelContext` is not a refusal: the runtime registers nothing and
  does not throw.

**AT-16. Registration and annotation projection.** After verification, the runtime registers each
offer with a `page` binding whose `on` patterns match `location.pathname`. In a pattern, `*`
matches within one path segment and `**` matches any depth, including none. The query and
fragment are not part of the match. Offers without a `page` binding are never registered.

- Registration is `document.modelContext.registerTool(tool, {signal})`, with one
  `AbortSignal` per tool. A tool name **MUST NOT** be registered twice.
- The tool is `{name: id, description: about, inputSchema, annotations, execute}`.
  `inputSchema` is `{type: "object", properties: {<field>: {type}}, required: [<every field>]}`.
- Annotations are projected from the compiled offer. A hint that does not apply is `false`:

  | hint | true when |
  |---|---|
  | `readOnlyHint` | `effect` is `none` |
  | `destructiveHint` | `effect` is `pays` |
  | `idempotentHint` | `effect` is `none` or `reversible` |
  | `untrustedContentHint` | the page action is `read` |

  An offer without `effect` (a site verb, AT-4) is never read-only and never idempotent.
- `execute` **MUST** refuse input that is not an object of exactly the declared fields and
  types, before any side effect.
- The page actions are:
  - `fetch`: a same-origin request, where `query` maps input fields to parameters, and `POST`
    sends the input as JSON;
  - `read`: the text of the selected element;
  - `fill`: set the form's named fields, then submit once;
  - `call`: the site's function, called once with the input;
  - `open`: a same-origin navigation, with `{field}` placeholders percent-encoded.

  A missing element, form or function is an error result.
- A result is a WebMCP result: `{content: [{type: "text", text}]}`, with `isError: true` on
  failure.

**AT-17. The ask dialog.** An offer whose compiled `ask` is `advised` or `always` **MUST** show
exactly one `<dialog>` per call before any side effect. The dialog is connected to the document,
opened with `showModal()` (or `show()`), and shows the offer's `about`.

- The call proceeds only when the dialog's `returnValue` is `"confirm"` at its `close` event:
  the `<form method="dialog"><button value="confirm">` idiom.
- Anything else **MUST** be a denial: Esc, `cancel`, or closing another way. A denial is an
  error result, has no side effect, and is counted as `ask_denied`.
- Two dialogs **MUST NOT** be open at once.
- `ask: never`, and an offer with no `ask`, shows none.
- `window.confirm` **MUST NOT** be used, and input values **MUST NOT** be written into the page
  as HTML.

**AT-18. Handoff emission.** A successful result of an offer whose compiled `then` is `"door"`
**MUST** carry:

- `_meta.handoff = {v: 1, next: [{kind: "a2a", card: <origin + card path>}]}` (Agent Web
  Router spec v0 §6);
- the legacy top-level `muretai = {v: 1, action: "dm", to: <card did>, ...}`, for readers of
  trunk `docs/WEBMCP_HANDOFF.md`. The reference adds `connect`, the card URL.

An offer without `then` gets neither key, and a denied or failed call gets neither.

**AT-19. Same origin only.** A signed contract is still data. A runtime **MUST NOT** make a
request or a navigation to any origin but `location.origin`, whatever the contract says: an
absolute URL, `//host`, `/\host` and `javascript:` are refused before anything is sent. A card
whose `agentEntry.tools` or `agentEntry.events` names another origin is read as this origin's
own well-known path.

**AT-20. Resync and abort.** Tools follow the route of a single-page app:

- With the Navigation API, the runtime follows `currententrychange` and `navigatesuccess` and
  **MUST** leave `history.pushState` and `replaceState` alone.
- Without it, it wraps `pushState` and `replaceState` (the wrapped calls still move the URL)
  and follows `popstate`.
- On each change, tools whose patterns no longer match are removed by aborting their own
  signal. Tools that still match stay registered, and newly matching ones are added.
- Aborting the `signal` given to `install` removes every tool and stops all resync. An
  already-aborted signal registers nothing.

**AT-21. Count emission.** A runtime that verified its contract counts with the AT-14 body and
names:

- by `navigator.sendBeacon` to `<origin>/.well-known/agent-tools/events`, never by `fetch`;
- one random session per page;
- each body at most 2048 bytes and 100 events, and at most 100 events per session in all;
- flushed at the latest on `pagehide` or `visibilitychange` to hidden.

`page_ready` is sent once. `referral{engine}` is sent at most once, and only when an answer
engine is recognised from `document.referrer` or `utm_source`; never for an empty referrer or
one from the page's own origin. Every call counts `offer_started`, and then `offer_succeeded`
with an integer `ms`, `offer_failed`, or `ask_denied`. A handoff also counts `handoff`. Each
registration counts `offer_registered`. No beacon carries an input value or a DID.

### 2.8 The site's CLI

The reference CLI is the package bin: `agent-entry init | publish (alias deploy) | doctor |
counts`, beside `knock`. Exit status is 0 when done or when every check passed, 1 when refused
or when a check FAILed, and 2 on misuse. With `--json`, stdout is exactly one JSON document. The
conformance runner is `conformance/cli.mjs`.

**AT-22. `init` never leaves the seed where git would carry it.** `init` mints the site's seed
locally and writes it as the line `AGENT_ENTRY_SEED_HEX=<64 hex>` into the framework's secret
file (`.env.local` for Next, `.env` otherwise), with mode 0600.

- Whether git would carry that file is judged by git itself (`check-ignore`, `ls-files --cached`,
  and `ls-files --cached --others --exclude-standard`), not by reading `.gitignore` as text. So a
  negated rule, a global excludes file and an already-tracked file all count as git counts them.
- When git would track the file, or the project is not a git repository, `init` **MUST** refuse
  (exit 1, naming `.gitignore` or the tracking). It then writes no seed anywhere, does not
  rewrite `.gitignore`, and leaves tracked files untouched.
- A second `init` **MUST** keep the seed already there. A new seed is a new DID, and every
  visitor's account would be lost.
- The seed **MUST NOT** be printed, logged, published, or written into any wired file. Wired
  code reads it from the environment or the slot at start.
- A static host is handed to `agent-entry-serverless`, and WordPress to `agent-entry-wordpress`.
  Those products keep the seed in the platform's own secret store, so `init` writes no seed for
  them.
- `init --from sodium.json` follows §3.1. One tool with no v1 equivalent (`interaction{steps}`,
  a `{path, when}` route, a non-scalar input type) refuses the whole file, naming the tool, and
  writes nothing (AT-2's posture).

**AT-23. `publish` never rewrites a version.** `publish` validates the declaration (a refusal
names the field), compiles it, signs it with the site's seed, and writes three files under
`<static dir>/.well-known/`: `agent-tools.json` (canonical bytes), `agent-tools.sig.json` (the
`agenttools` envelope) and `agent-tools/v<n>.json`.

- Without `--version`, identical content is a no-op, and changed content becomes max + 1.
- `--version n` with content other than the published v`n` **MUST** refuse (exit 1, naming
  `v<n>`) and write nothing. A version number past max + 1 is a gap and also refuses.
- A prior version whose bytes no longer match its own hash, number or canonical form, or that
  names another origin, **MUST** refuse, so `publish` never builds on an edited history.
- A missing seed or an invalid declaration refuses before anything is written.
- The door accepts what `publish` wrote as its `toolsHistory` (AT-10).

**AT-24. `doctor` checks the wiring as it runs, and knocks every door-bound offer once.**

- Locally, `doctor` checks five things:
  - the seed is present, mode 0600, git-ignored, not committed, and in no file git would carry;
  - the published contract verifies under the seed's DID and origin and matches the
    declaration;
  - each framework file that must hand requests to the door module really imports it;
  - the page template carries the page tag, and the vendored page runtime matches the package's;
  - the door module starts: it is loaded as the framework loads it and exercised in process.
- Against a live site (`--url`), `doctor` checks the card and its signature, the card's url, the
  signposts, the contract, its signature and every version, and the collector.
- In both modes, `doctor` sends **exactly one** signed knock per door-bound offer, and none for a
  page-only offer. The knock has `metadata.offer` set to the offer id, and its text ends with the
  offer's example input as a JSON object.
- A reply that is unsigned, or whose status differs from the declared kind's (AT-12), FAILs
  that offer only. So does a missing `deal` where the offer carries a receipt.
- A site-added verb without `effect` is a **WARN** row that names the offer and `effect` (AT-4).
  It is never a FAIL and never silent.
- Rows use the shape `{id, level: PASS|FAIL|WARN|INFO, label, detail}`, and no row carries the
  seed.
- `doctor` launches no browser. A target it cannot reach is a FAIL: it fails closed and sends
  nothing past the first failed request.

**AT-25. Counts are anonymous and local.** `fileSink(path)` is an observer that appends one JSON
line per event, holding `t` and an allowlist of the envelope's fields (`stage`, `event`, `offer`,
`engine`, `ms`, `reply`, `receipt`, `identified`, `verified`, `ua_family`, `client_class`,
`ip_vendor`, `country`, `signature_agent`, `refused`). Only numbers, booleans and short tokens
are kept. The line **MUST NOT** carry a DID, text, an input value, or a message or context id.

- For a chosen offer, the observer's copy of the envelope also carries `reply` (the kind) and
  `receipt` (whether this reply carries a `deal`). The responder's envelope is unchanged.
- `counts` reports `{offers: {<id>: {page_asked, door_asked, completed, receipts}}, referrals,
  returning_customers, knocks: {by_stage, by_class}}`:
  - `page_asked` counts `offer_started`, and `door_asked` counts answered door stages naming the
    offer;
  - `returning_customers` is the number of store accounts with two or more messages. It is a
    count only;
  - `knocks` counts the door's POST stages.
- **Completed.** On the page, `completed` counts `offer_succeeded`. At the door, it counts the
  signed replies whose status is final for their kind: `answered` (`facts`) and
  `continue_at_checkout` (`checkout`). A `pending_confirmation` that is later confirmed is out of
  scope for v1, as are `see_catalog`, `awaiting_person` and `brain` replies.
- `counts --serve` **MUST** bind loopback only (`127.0.0.1` or `::1`). It refuses any other host
  before binding and answers only requests addressed to a loopback name.

**AT-26. `gaSink` sends counts, never people.** `gaSink({measurementId, apiSecret, fetchImpl?})`
refuses a missing id or secret and returns an observer.

- Each event is one POST to the GA4 Measurement Protocol, `/mp/collect?measurement_id&api_secret`.
- The body is `client_id` and `events` only. `client_id` is random per sink and never derived
  from a key.
- Every event carries `engagement_time_msec` (an integer above 0) and `session_id`. Its other
  params are AT-25's allowlist, as numbers, booleans and short tokens.
- A page event keeps its collector name. A door stage is sent as `door_<stage>`.
- No DID, text, input value, message or context id, or address appears in the body. A failing
  endpoint never throws out of the observer.

## 3. Informative

### 3.1 Mapping from `sodium.json`

A `sodium.json` v1 file (Sodium, 2026-09) describes page tools only. It maps onto `page`
bindings, and its `door` bindings are left empty:

| `sodium.json` | `agent-entry.json` |
|---|---|
| `tools[].id` / `name` | `verb` + `of` (split at the first `_`; an unknown verb is kept and needs `effect`, AT-4) |
| `description` | `about` |
| `input` field map (`optional` flags) | `input` (types only; v1 has no optional marker) |
| `on: [glob]` | `page.on` |
| `run: navigate` | `page.do.open` |
| `run: extract` | `page.do.read` |
| `run: form` | `page.do.fill` |
| `run: request` | `page.do.fetch` |
| `run: call` | `page.do.call` |
| `run: interaction{steps}` | no equivalent yet (the `steps` page action is a follow-up) |
| `risk: read_only / reversible / state_changing / destructive / financial` | `effect: none / reversible / changes / changes / pays` |
| `confirmation: none / recommended / required` | `ask: never / advised / always` (raise only) |
| server-signed deploy receipt | the site's own `agenttools` envelope (AT-8); no third-party key |
| `tool_*` telemetry names | the collector names (AT-14) |

The converter is `init --from sodium.json` (AT-22). The field shapes it reads (`input: {f: {type,
optional}}`, `run: {type, …}`) follow the Sodium facts recorded on 2026-09-22 and have not yet
been checked against a real published `sodium.json`.

### 3.2 Relation to commerce verbs elsewhere

UCP and the agent-commerce blueprints use `search_products → add_to_cart → checkout`. In this
registry those are `find products`, `hold item` or `order …`, and `buy order`. `buy` is
always a handoff to the site's own checkout. `quote` and `hold` are where negotiation and the
countersigned deal attach later.

## 4. Security considerations

- **The offer selection is not signed.** `metadata.offer` sits beside the six signed fields, so
  an intermediary could switch it. The reply is signed. The `deal` commits to the terms actually
  answered, including `verb` and `of`, so a switched selection is visible in what the visitor
  receives. Signing the selection itself is a named follow-up. This version does not change the
  signed payload.
- **The collector is unauthenticated by design.** It is same-origin, small, allowlisted and
  anonymous. It is a count, not evidence: a script on the site's origin can send any allowed
  event. Nothing it receives reaches a verdict, an account row or the ledger.
- **Site-added verbs** carry no confirmation floor unless they declare `effect` (AT-4). A page
  runtime shows `ask` as compiled, and the declaration is the site's own statement.
- **Checkout** is a same-origin path, checked at validation. A declaration cannot send a
  customer's payment to another origin through the door's reply.
- **The CLI mints and stores the site's private key** (AT-22). Git is the guard that keeps it
  out of commits, so `init` refuses where git would carry it and `doctor` FAILs when git does. A
  file on disk with mode 0600 is still readable by anyone who controls the machine or its
  backups. Moving the seed into the host's secret store is the operator's step.

## 5. Requirement index

| id | subject |
|---|---|
| AT-1 | declaration grammar |
| AT-2 | whole refusal naming the field; refuse to start |
| AT-3 | verb registry and default effects |
| AT-4 | site-added verbs: no defaults; paying/changing actions use the registry or declare `effect` |
| AT-5 | ask floor, raise-only overrides, `then`, receipt defaults |
| AT-6 | deterministic compile, origins, hash |
| AT-7 | generated skills |
| AT-8 | the `agenttools` envelope |
| AT-9 | origin binding |
| AT-10 | serving, card fields, AE-4, immutable versions |
| AT-11 | one method; `metadata.offer` and its refusal |
| AT-12 | default reply shapes per kind |
| AT-13 | the `deal` block |
| AT-14 | the collector and its event names |
| AT-15 | page runtime: the six refusals; verify before registering |
| AT-16 | page runtime: registration, route patterns, annotation projection, page actions |
| AT-17 | page runtime: one `<dialog>` per ask, confirm only on `returnValue === "confirm"` |
| AT-18 | page runtime: handoff emission (`_meta.handoff`, legacy `muretai`) |
| AT-19 | page runtime: same origin only |
| AT-20 | page runtime: SPA resync and abort |
| AT-21 | page runtime: count emission |
| AT-22 | `init`: the seed slot git would never carry; `--from sodium.json` |
| AT-23 | `publish`: immutable versions, refusals that write nothing |
| AT-24 | `doctor`: local and live checks, one knock per door-bound offer, the AT-4 warning |
| AT-25 | counts: `fileSink` privacy, `completed`, loopback-only `--serve` |
| AT-26 | `gaSink`: Measurement Protocol body rule |
