# Changelog

Releases before 1.12.0 are recorded in the commit history and in the README's "Since 1.x"
paragraphs.

## 1.13.0 — Agent Entry Suite S1: one declaration, verbs first (unreleased)

A site can now describe what a customer can do there in one declaration, `agent-entry.json`,
keyed by verbs (`find`, `book`, `hold`, `buy`, `ask`, …). The door turns it into a signed tool
contract, the card's skills, and default replies. The new spec is `spec/tools-v1.md` (AT-1 to
AT-14). The tests came first: `conformance/tools.mjs`, `offers.mjs`, `collector.mjs` and their
data (commit `3c7c8e9`, wired in `b9a49f5`). The implementation did not edit them. Design record:
Agent Entry Suite, sections 1, 2, 5 (collector), 6 and 7-S1, owner-approved 2026-09-22 (intake
`20260921T215426Z`).

What landed, all inside `muretai-agent-entry.mjs` (still one file, still zero dependencies,
`vendor/agent-seam` untouched):

- **Declaration.** `validateDeclaration`, and `compileDeclaration(declaration, { version })`,
  which returns `{v, name, origins, version, offers, facts?, hash}`. Identical input always gives
  the same bytes, and the output is pinned by vectors. A refusal names the field.
- **Verb registry.** `VERBS`, `VERB_EFFECTS` and `ASK_FLOOR` (all frozen), plus `REPLY_KINDS`,
  `PAGE_ACTIONS` and `INPUT_TYPES`.
- **Skills.** `skillsFromOffers(declaration)` generates the card's `skills[]`.
- **Signed contract.** `makeToolsEnvelope` / `verifyToolsEnvelope` produce and check the new
  `agenttools` envelope `{v, typ, contract, ts, sig}`. It can never be replayed as a card, and a
  card can never pass as one. It is bound to the contract's `origins`.
- **New `createAgentEntry` options.** `declaration` and `toolsHistory` (the prior compiled
  contracts). With them the door:
  - serves `/.well-known/agent-tools.json`, `.sig.json` and `/.well-known/agent-tools/v<n>.json`;
  - puts `agentEntry.tools` and `agentEntry.events` on the card, and generates `skills[]` from
    the offers;
  - refuses to start on a declaration for another origin, or on a prior version that fails its
    hash, is out of sequence, or names another origin.
- **Default responder**, chosen per offer by `door.reply`:
  - it covers `catalog`, `facts`, `pending`, `checkout`, `brain` and `human`;
  - replies are `{verb, of, customer_did, request, status, deal?}`;
  - a `deal` block (`DealReceipt`, `termsHash` with `salt`, door `sigA`) is added when the offer
    carries a receipt.
- **`metadata.offer`** on the one method `message/send`. It takes an offer id or a registry verb.
  A value the door does not answer is refused with -32602, before any crypto, with no ledger row
  and no echo.
- **Collector** at `POST /.well-known/agent-tools/events`: same-origin only, at most 2048 bytes
  and 100 events per session, allowlisted names. It answers 204, never touches the ledger, and
  reports each event to the observer as `stage: "page"`. New constants: `COLLECTOR_EVENTS`,
  `REFERRAL_ENGINES`, `COLLECTOR_MAX_BODY_BYTES`, `COLLECTOR_MAX_EVENTS_PER_SESSION`.
- **`OFFER_STARTERS`**: the four trade recipes (restaurant, retail, clinic, repair) as `offers[]`
  starters for `init`.
- **Doors without a declaration are unchanged**, byte for byte. That covers card, replies and
  routes, and all four recipe doors.

### Decisions (coordinator rulings of 2026-09-22 on the test author's calls)

- Ask floors: `none` → `never`, `reversible` → `advised`, `changes` → `advised`, `pays` →
  `always`. `effect` and `ask` may only be raised. `then: "none"` opts out of the handoff, and
  `page.then: "door"` is folded into the offer's `then`.
- Unknown verbs pass through with no defaults (no `effect`, `ask` or `then`, and `receipt`
  false). `spec/tools-v1.md` AT-4 says so normatively: a site-added verb gets no ask floor unless
  it declares `effect`, and a paying or changing action MUST use the registry verb or declare
  `effect`.
- Contract and skill shapes, and serving: contracts are served as canonical bytes, and the card
  gains `agentEntry.tools` and `agentEntry.events`, never on the `muretai` alias.
- Reply shapes: `type` is gone only for doors built from a declaration. Old recipe doors keep
  their bytes.
- The `deal` block is the JS twin of trunk `shared/deal.py`, with `salt` added so the visitor
  can check the commitment.
- `metadata.offer` refusals: -32602, no ledger row, no echo.
- Collector event names: `page_ready, referral, offer_registered, offer_started,
  offer_succeeded, offer_failed, ask_denied, handoff`. These are the names (the owner's own
  vocabulary), normative in AT-14. The S2 and S5 intakes are being moved from `tool_*` to them.
- `metadata.offer` stays outside the six signed fields. S1 does not change the signed payload.
- `validatePrefer` keeps its own `agentEntry.prefer` messages. The declaration validator wraps
  them so the refusal names `entry.prefer`.

Choices made in the implementation, where the tests left room:

- Only an absent `declaration` means none. `declaration: null` refuses to start, because a
  declaration that failed to load is not "no declaration".
- `skills` together with `declaration` refuses to start: the skills are generated. A `prefer`
  option that disagrees with `entry.prefer` also refuses. When only `entry.prefer` is given, it
  is published as `agentEntry.prefer`.
- Unknown keys anywhere in a declaration are refused, so a misspelling cannot drop a field.
- An offer must bind a page, a door, or both.
- A `facts` reply needs declared `facts`.
- `door.url` belongs to `checkout` only.
- `{field}` placeholders in a URL template must name input fields, and so must `fetch.query`
  values.
- A registry verb in `metadata.offer` picks nothing when two door-bound offers share it.
- Reply status strings:
  - `catalog` answers `see_catalog`;
  - `facts` answers `answered`;
  - `checkout` answers `continue_at_checkout`, with `url` built from the door's origin, and
    placeholders filled from a JSON object after the visitor's words or else left empty;
  - `human` answers `awaiting_person`, with a `note` saying "We will answer …".
- A `brain` reply is the site's text verbatim and so carries no `deal`, even with
  `receipt: true`.
- The anonymous lane gets `customer_did: null` and no `deal`: there is no party B.
- The collector accepts any of the contract's `origins` as same-origin. Past the per-session
  cap, events are dropped with 204; it remembers at most 10000 sessions. It does not add a
  `page` stage to `stats()`.
- On a guest mount the agent-tools routes are also served at the origin, as the card is.

### Follow-ups (named, not built here)

- Steps page action (`sodium.json` `interaction{steps}`).
- Negotiation on `quote` / `hold` (coordination turns, R9, after the pilot shop).
- WordPress plugin and serverless templates render the same declaration.
- Hosted no-code tier.
- Python twin (declaration, compile vectors, envelope, responder, collector).
- `doctor` warns on a site verb without `effect` (S3).
- Sign the offer selection (`metadata.offer` is outside the six signed fields).
- Also noticed while implementing:
  - the `catalog` reply does not yet draw on `entry.catalog` or the Store API (S1 answers
    `see_catalog`);
  - `knock` still recognises only the old `{type, …}` booking shape, not
    `{verb, of, …, deal?}`.

## 1.12.0 — who is knocking, v2 (landed 2026-09-19, not yet published)

The door can now say whose network a visitor came from, which country the edge reported, and
whose Web Bot Auth key signed the request, as observation only (spec AE-31, AE-32). Tests first:
`conformance/who-is-knocking.mjs` and `conformance/vendor-ranges-helper.mjs` (commit `a0564dd`),
unedited by the implementation.

- `createAgentEntry({ trustProxy, vendorRanges })`, and `wbaVerifiers` also as
  `[{vendor, jwks}]`. Exported `VENDORS` (15 names). `entry.vendorStats()`.
- Observer envelope, all five stages: `ip_vendor`, `country`, `signature_agent`. The responder's
  envelope (`backendEnvelope`) is unchanged.
- `handleRequest` / `handleRequestAsync` take a fifth argument `{ remoteAddress }`; `listen()`
  passes `req.socket.remoteAddress`.
- `scripts/vendor-ranges.mjs` (ships in the package, never imported by the module).
- Invariant: `verified`, account rows, rate lanes, refusals and wire bytes are identical under
  every configuration; no client address reaches a counter, the ledger, an envelope, a log line
  or the wire.
- connectors: Muse recipe. `connectors/muse.md` is the page a Muse custom connector reads: run
  `npx @muretai/agent-entry knock <card-url>` on the user's VM, and the knock seed there is that
  user's did:key. A README bullet and an informative spec §5 paragraph ("Agent connectors") point
  at it. Documented for Muse, not tested in Muse. Tests first: `conformance/muse-connector.mjs`
  (commit `726bfd3`), unedited by the implementation.
- `npx @muretai/agent-entry knock <card-url>` now works: `package.json` declares the `agent-entry`
  bin, the module starts with a `#!/usr/bin/env node` line, and its main-module check compares
  real paths, so it runs through the npm `.bin` symlink instead of exiting 0 silently.

### Decisions left open by the tests (F11), made here

- Overlapping ranges: the most specific prefix wins; the same prefix under two vendors goes to
  the vendor earlier in `VENDORS`.
- Prefixes shorter than /8 (IPv4) or /32 (IPv6), `/0` included, refuse to start. So does an IPv6
  CIDR inside `::ffff:0:0/96`, which could never match (mapped addresses are matched as IPv4).
- Host bits past the prefix are dropped: `10.1.2.3/8` is `10.0.0.0/8`.
- Under `trustProxy`, the first proxy header that is present and non-empty decides. An
  unparseable value gives `ip_vendor: null`; it does not fall through to the next header.
- IPv4-mapped IPv6 in either spelling (`::ffff:192.0.2.9`, `::ffff:c000:209`) is matched as its
  IPv4 address.
- `trustProxy` accepts only `true` / `false` (`null` reads as `false`); anything else refuses to
  start.
- The 64-key cap on `wbaVerifiers` counts keys across all array entries. A key listed under two
  vendors keeps the first label.
- `{openai: []}` is accepted and matches nothing; an empty or absent `vendorRanges` gives
  `ip_vendor: null`.
- `CF-IPCountry` is not trimmed for in-process callers: `" JP"` is null.
- `signature_agent` is set on `card_get` and `notice_get` (where `wbaVisits` already verifies)
  and on answered POSTs from `wba_did`; on `refused_post` it is always null, so a refused flood
  never costs a verify.
- Helper: one range source that lists nothing fails the run (as does a directory with no
  Ed25519 key); the previous cache stays.
- Helper URL table: written from vendor documentation on 2026-09-19 and not fetched from the
  implementing session (no network there); the first real run checks every URL. Anthropic, Fly,
  Azure and Hetzner are `manual` (no machine-readable list). Only the chatgpt.com key directory
  is fetched; Google's, Shopify's and Cloudflare's hosts were not confirmed.

### Follow-up intakes

- `trunk twin VENDORS table`: the Python twin keeps the same `VENDORS` beside `CLIENT_CLASSES`.
  `examples/agent_entry_reference.py` is not in this repository, so the conformance check for it
  skips here.
- `L2 front desk after the npm release`: pin `^1.12.0`, run the helper at boot, forward the three
  fields to analytics.
