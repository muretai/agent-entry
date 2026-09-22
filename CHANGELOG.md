# Changelog

Releases before 1.12.0 are recorded in the commit history and in the README's "Since 1.x"
paragraphs.

## 1.13.0 — Agent Entry Suite S1 and S2: one declaration, verbs first, on the door and the page (unreleased)

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

### Suite S2: the page runtime `agent-entry-page.mjs`

The page face of the same declaration. A new file at the package root, `agent-entry-page.mjs`,
is listed in `files`. It is browser code with no dependencies, served from the site's own
origin: `<script type="module" src="/agent-entry-page.mjs">`. It fetches the card, the contract
and its envelope from that origin, and verifies the envelope with WebCrypto Ed25519 against the
card's `did`. It checks `origins` and the hash. Only then does it register the route's page
offers as WebMCP tools on `document.modelContext`. The spec grew AT-15 to AT-21 (the refusal set,
registration and annotation projection, the ask dialog protocol, handoff emission, the
same-origin rule, resync and abort, count emission). The tests came first:
`conformance/page.mjs` (commit `808ec31`, wired in `d734060`). The implementation did not edit
them. Design record: Agent Entry Suite section 3 and 7-S2 (intake `20260921T215427Z`).
`muretai-agent-entry.mjs` and `vendor/agent-seam` are untouched; S1's surface is unchanged.

What landed:

- **`install({window, signal, handlers})`** resolves `{ok: true, version, hash, tools, webmcp}`
  or `{ok: false, reason}`. It never throws on a refusal, and a refusal registers nothing and
  counts nothing. `REFUSALS` (frozen) lists `contract_missing`, `sig_missing`, `sig_invalid`,
  `origin_mismatch`, `hash_mismatch` and `card_mismatch`.
- **The page tag installs itself.** Load the module as `/agent-entry-page.mjs?manual` to call
  `install` yourself, for example with `handlers` for `call` actions. `ready` is the page tag's
  own install promise.
- **Tools:**
  - the name is `verb_of` and the description is `about`;
  - every input field is required and typed, and bad input is refused before any side effect;
  - annotations come from `effect`;
  - the page actions are `fetch` (GET, POST), `read`, `fill`, `call` and `open`;
  - `*` matches one segment and `**` any depth;
  - there is one `AbortSignal` per tool, and never a duplicate registration.
- **Ask:**
  - `advised` or `always` shows one `<dialog>` per call, built with `textContent` only and
    queued so that two are never open at once;
  - the call goes ahead only on `returnValue === "confirm"`;
  - the dialog runs inside the agent's `requestUserInteraction` when one is given.
- **Handoff:** when `then: "door"`, results carry `_meta.handoff` and the legacy `muretai`
  key. `muretai` also carries `connect`, the card URL.
- **SPA resync:** the Navigation API when there is one, else wrapped `pushState` /
  `replaceState` plus `popstate`. Aborting `install`'s signal removes every tool, stops
  resync, restores `history`, and flushes the counts.
- **Counts:**
  - by `sendBeacon` to the same-origin collector, with one random session per page;
  - each beacon is at most 2048 bytes, with at most 100 events per session;
  - flushed on `pagehide` or hidden `visibilitychange`, and on abort;
  - referral engines are recognised from the referrer or `utm_source`.
- **Headless-Chrome leg (local only, not in `npm test`):** `npm run demo:chrome`, or
  `CHROME_PATH=/path/to/chrome npm run demo:chrome`. It is `examples/live-demo-chrome.mjs`,
  which needs Node 22 or later. It serves Harbor Lamp on 127.0.0.1, with a throwaway Chrome
  profile and a host-resolver rule that resolves only 127.0.0.1. It covers four verbs:
  - `find products` from the shop's API;
  - `hold item`: one dialog, the form filled, the handoff, and a signed knock that gets a
    pending hold with a `deal`;
  - `buy order`: one dialog, then the checkout URL;
  - `ask anything`, answered at the door.

  It also checks that the counts reach the collector. It downloads nothing. With no Chrome it
  prints the paths it looked at and exits 2. WebMCP may be off in the local Chrome, so a
  recording `document.modelContext` shim stands in for `registerTool`; everything past that is
  the real runtime in Chrome. Run on 2026-09-22 with Chrome 153: 29/29.

#### Decisions (coordinator rulings of 2026-09-22 on the test author's calls, all accepted as pinned)

- The API is `install({window, signal, handlers})` plus the frozen `REFUSALS`. Every browser API
  is read from the injected `window`.
- A card that names another key than the envelope's signer is `sig_invalid`, not
  `card_mismatch`.
- A served contract that differs from the signed one is `hash_mismatch`.
- `destructiveHint` is set only for `pays`: S1 has no `destroys` effect.
- The dialog confirms only on `returnValue === "confirm"`, and it shows `about`.
- In the handoff, `card` is the card URL string. The legacy key pins `v`, `action: "dm"` and
  `to`.
- The result is text in `content[].text`, and a failure is `isError: true`.
- Site verbs without `effect` get no dialog, following the compiled `ask` (S1 AT-4). The
  `doctor` warning is S3's follow-up.

Choices made in the implementation, where the tests left room:

- **Where the documents come from.**
  - The contract URL is the card's `agentEntry.tools` when it is on this origin. Otherwise it
    is this origin's `/.well-known/agent-tools.json`, and the `origins` check then decides.
    The envelope is the same path with `.sig.json`.
  - A foreign `agentEntry.events` falls back to this origin's collector.
- **Input and preconditions.**
  - Input with unknown fields is refused.
  - A missing element, form or function is found before the person is asked, and checked
    again after they confirm.
- **Counts.**
  - Every call counts `offer_started`, then one of `offer_succeeded`, `offer_failed` or
    `ask_denied`. Bad input is `offer_failed`.
  - Only answer engines count as referrals. Any other referrer counts nothing, never
    `other`.
- **Other browsers and other runtimes.**
  - In a browser without `document.modelContext`, the runtime also tries
    `navigator.modelContext`. With neither, `install` resolves `ok: true` with no tools and
    still counts `page_ready`.
  - If `registerTool` returns a handle with `unregister()`, that handle is used alongside the
    signal.
  - A second `install` on the same window stops the first.
- **Results.**
  - Result text is capped at 50,000 characters.
  - `fill` sets values through the native setter and fires `input` and `change`, so framework
    forms see them.
- **Test count.** `npm run test:page` counts 318 checks, not the 322 the test author saw with a
  prototype. The count depends on how many beacons a runtime sends, because each beacon is
  checked, and this runtime batches more events per beacon. No check fails or is skipped.

#### Follow-ups (named, not built here)

- `steps` page action (`sodium.json` `interaction{steps}`), with the page runtime executing it.
- A `destroys` effect, if one is ever added to S1. `destructiveHint` must then cover it as well
  as `pays`.
- A CSP note for sites that vendor the runtime. The page needs `script-src 'self'` for the
  module and `connect-src 'self'` for the well-known fetches and the beacon. The runtime uses no
  inline script, no `eval`, and no third-party origin.
- The Chrome leg drives a shim, not native WebMCP. Once Chrome ships `document.modelContext`
  (or a testing hook such as `modelContextTesting`) unflagged, it should run against the native
  one.
- The runtime does not check the envelope's `ts` age: the door serves it fresh (AT-10). Whether
  a page runtime should also refuse a stale envelope is left to the spec's next revision.

### Suite S3: the site's CLI (`init`, `publish`, `doctor`, `counts`) and two sinks

A site now installs the door with one command and checks it with another. The tests came first:
`conformance/cli.mjs` and `conformance/fixtures/cli/` (commit `bb88de9`, wired in `e9129bf`;
`af3b4f4` and `307faca` before the rebase onto S2).
The implementation did not edit them. The normative text is `spec/tools-v1.md` §2.8, AT-22 to
AT-26. Design record: Agent Entry Suite, sections 4 and 5 (intake `20260921T215441Z`).

What landed, all inside `muretai-agent-entry.mjs` (still one file, still zero dependencies,
`vendor/agent-seam` untouched):

- **`agent-entry init`** detects the framework: `next-app`, `next-pages`, `nuxt`, `sveltekit`,
  `astro`, `vite` or `express`. It hands a static site to `agent-entry-serverless` and WordPress
  to `agent-entry-wordpress`. For a directly wired framework it:
  - mints the seed into `.env.local` (Next) or `.env` (the others), mode 0600;
  - writes `agent-entry.json` from `OFFER_STARTERS[trade]`, or converts `--from sodium.json`;
  - writes `.agents/skills/agent-entry/SKILL.md`, and `agent-entry.door.mjs`, a framework-free
    door module with a Web-standard handler and a Node/Connect one;
  - adds the framework glue: Next middleware, a Next pages API route plus rewrites, a Nitro
    middleware, SvelteKit hooks, Astro middleware, a Vite dev/preview plugin, or an Express
    `app.use`;
  - puts the link and the page tag in `<head>` and `bodySignpost()` in `<body>`, and vendors
    `agent-entry-page.mjs` into the static dir whenever the package ships it.
- **`agent-entry publish`** (alias `deploy`) validates, compiles and signs the declaration, and
  writes `agent-tools.json`, `.sig.json` and `agent-tools/v<n>.json` under
  `<static dir>/.well-known/`. A published version is never rewritten.
- **`agent-entry doctor`** has two modes:
  - Local: the seed and git, the published files against the seed and the declaration, the glue
    imports, and the page tag. It then loads the door module and knocks it in process.
  - `--url`: the same door checks over the network.
  - In both modes it sends one signed knock per door-bound offer, and gives the AT-4 WARN for a
    site verb without `effect`. That closes S1's follow-up.
- **`agent-entry counts`** reads a `fileSink` log and a file store, prints the counts as text or
  `--json`, and `--serve` renders one page on loopback.
- **`fileSink(path)`** and **`gaSink({measurementId, apiSecret, fetchImpl?})`** are exported.
- **The observer's envelope** gains `reply` and `receipt` for a chosen offer (observer copy
  only). This lets a counts log say "completed" and "receipts" without holding the reply.
- `knock` is unchanged. The bin's entry is no longer a top-level `await`, because `doctor`
  imports a door module that imports this file.

### Decisions (coordinator rulings of 2026-09-22 on the S3 test author's calls)

- Decisions 1 to 4 and 6 to 11 are accepted as pinned. They cover:
  - invocation and the exit codes 0/1/2, and `--json` as one document;
  - the seed slot `AGENT_ENTRY_SEED_HEX` at 0600, never rotated, never printed;
  - the `init` flags and the framework spellings, and R1 judged by git itself;
  - `publish` immutability and its refusals;
  - the `doctor` rows, the R2 WARN, and one knock per door-bound offer;
  - R4, which fails closed on TEST-NET;
  - the `counts` shape, and a `fileSink` that carries no DID or text;
  - R6, loopback only;
  - the `gaSink` body limits.
- Decision 5 (`init --from sodium.json`) is accepted as pinned, including the whole-file refusal
  on an `interaction{steps}` tool. The field shapes follow the Sodium facts in the design record
  (verified 2026-09-22). No Sodium package was downloaded to check them.
- **`completed` for door-bound offers** means the door sent a signed reply whose status is final
  for that reply kind: `answered` (`facts`) and `continue_at_checkout` (`checkout`). A pending
  reply that is confirmed later is out of scope. The pinned page-only case stands:
  `offer_succeeded` counts as completed. This is normative in AT-25.
- The CLI AT items are AT-22 to AT-26, in a new §2.8, placed after S2's AT-15 to AT-21 (S2
  landed first).
- Risk "init wiring checks are loose": the local `doctor` is the real gate. It does not search
  text. Instead it:
  - imports the generated door module (mapping `@muretai/agent-entry` to this file) and knocks
    it in process;
  - resolves each glue file's import specifiers to the door module;
  - requires the page tag outside comments in the framework's template, and the vendored
    runtime to match the package's.

Choices made in the implementation, where the tests left room:

- `init` needs `--trade` or `--from`, and `--base-url` whenever it writes a new declaration.
- A rerun of `init` keeps an existing `agent-entry.json`, and `--from` refuses to overwrite one.
- A project outside a git repository is refused, because nothing could prove the seed stays out
  of commits.
- Handed-off frameworks (static, WordPress) write nothing: `seed: null`, `wrote: []`.
- `init` never replaces an existing glue file (`middleware.ts`, `hooks.server.ts`, a Vite config
  of its own). It lists the step under `manual` instead, and `doctor` FAILs until the step is
  done.
- Express has no template the CLI can read. `doctor` gives a WARN (never a FAIL) for its page
  tag, and init lists the step under `manual`.
- Next pages router: `POST /` reaches the API route through a rewrite matched on
  `Content-Type: application/json`, because rewrites cannot match a method.
- `sodium.json` `destructive` maps to `effect: changes` with `ask: always`, and `confirmation:
  none` adds no `ask`.
- In live mode, `doctor` knocks with the same key as `knock` (`AGENT_ENTRY_KNOCK_KEY`), so the
  shop sees one "doctor" account. The local knocks use a throwaway key in process.
- `counts --serve` also refuses a request whose `Host` is not a loopback name (DNS rebinding),
  and serves one page with a no-script CSP.
- The `gaSink` `client_id` is random per sink. A door stage is sent as `door_<stage>`, and the
  endpoint can be overridden.
- `init` vendors S2's `agent-entry-page.mjs` into the static dir, and rewrites it when the
  package's copy changes. A package build without it gets an INFO row from `doctor` for the
  runtime file, and the tag is still required.

### S3 follow-ups (named, not built here)

- Verify `--from` against a real published `sodium.json`.
- Offer `--from --skip-steps`, which converts the rest with a warning, once the `steps` action
  exists.
- Reuse `conformance/receptor-check.mjs` in `doctor --url`. It is not reused yet: it posts probes
  to the door, which would break "one knock per offer", and it lives outside the one file.
- Agent Site Checker facts in `doctor --url`.
- Check the `agent-browser … webmcp list` one-liner against the published agent-browser CLI.
- Run the generated glue in each real framework (dev and build) in CI. The suite checks it
  without installing Next, Nuxt, SvelteKit, Astro, Vite or Express.
- Add a door for a Vite static build and for Astro without an adapter. For these the door runs
  only on the dev/preview server or with on-demand rendering.
- A human security review of the seed handling. This landing mints seeds and writes them to
  disk, and no SEC scan ran on it.

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
