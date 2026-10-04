# Agent Entry backlog

Agent Entry's own backlog, kept in Agent Entry's own repository (owner ask 2026-10-02: the door's backlog had
lived inside Muretai Core's; it is independent from here on). One line per item; the intake id in brackets is
the coordinator's record under `~/.cache/muretai-herd/coordinator/intake/`. Muretai Core (trunk), the site, the
seam and APPL keep their own backlogs; nothing here is about them except what the door owes them as a
dependency. An item moves to "Done" when its landing is on `main`, and a release moves the "Done" block under
its version (the agent-entry-release skill cuts releases; the owner publishes with the npm OTP).

The dashboard reads this file: `http://localhost:8091/backlog#agent-entry` (APPL dashboard, `/api/backlog.json`).
Ideas that are not yet lines here go to the inbox with `.cursor/skills/isolated-session/scripts/appl-backlog-add.sh
--repo /Users/mkt/agent-entry`, and the backlog pull turns the eligible line or inbox item into an intake.

## Rules the backlog follows

- The door stays ONE file (`muretai-agent-entry.mjs`), zero dependencies, with the seam vendored under
  `vendor/agent-seam` by digest; nothing here may add a runtime dependency or edit the vendored seam.
- Every item is a test-first pair unless marked solo (records/config only): a separate author extends
  `conformance/` from the spec first, the implementer may not edit those tests (owner rule 2026-09-14).
- Implementation is Opus on Herdr through APPL; this repository has no sec_lint and no landing gate, so every
  landing receipt says TESTS=none / SEC=none (open ISSUE intake 20260920T130938Z). A report states that
  plainly; it never implies a scan ran. `npm test` is the suite the pair runs by hand.
- No release is part of an item. The owner cuts the next version with the agent-entry-release skill after the
  items it carries have landed, and the consumers (trunk `tools/vendor_agent_entry.py`, muretai-site front desk
  pin, agent-entry-serverless `scripts/vendor.mjs --ref`) move only on a published version.
- Public docs carry nothing untested (owner rule 2026-09-27): a caveat that is pending verification is a line
  here, never a README sentence.
- Every line under "Next" is machine-readable for `appl-backlog-pull.sh`, one item per line, in the form
  `- <title>: <requirement, one or two sentences> [<intake id> | none] [after <intake id or title>] [solo]
  [skeleton]` (one line). The title is at most 120 characters and carries no colon; `[none]` means not yet
  filed (the pull writes the new id in its place); `after` names an intake id or the exact title of another
  line; `[solo]` marks a records/config item; `[skeleton]`, only as the last tag, marks a skeleton item.
  `###` group headings under "Next" are not items. The pull files one eligible line at a time by class
  (skeleton before polish), then priority (the title's leading P0..P3 word, P2 without one), then file order.
- OSS / product boundary (owner, 2026-10-04): this repository is the OSS door (MIT) and holds what runs at the shop and
  completes with no Muretai account; what Muretai operates (Catalog, Claim Desk, hosted door, hosted ledger and
  dashboards, the answering AI, billing) lives in muretai-trunk. No Muretai-specific name is hard-coded here: a
  Muretai service is one configured value of a generic feature. A separate product repository is cut only when the
  hosted product deploys and bills apart from trunk.
- A split chain is ONE line here, carrying the chain's TAIL intake id (the last member): the pull moves a line to Done when
  its id lands, so a head id would retire the line after the first member (happened to S6a/S6b on 2026-10-03, b4eca84).
  The Now paragraph names the member in flight; the dashboard's Now cannot show a same-second id (`<stamp>-N`).
- Order (owner ask 2026-10-03, from the pre-seed deck 2026-09): the money path first (p7 List -> Claim -> Answer; p13 the
  three numbers that price the next round: claims, paid conversion, returning customers), then the Suite follow-ups that
  make the counts and the visiting agents real, then the gate, then polish. A line moves up only with a deck reason.
- The design record for the Suite items is
  `~/.cache/muretai-herd/coordinator/briefs/agent-entry-suite-design.md` (owner-approved 2026-09-22): own
  vocabulary, verbs first, one A2A method, payment untouched, seed minted locally. Those rulings are not
  re-opened by an item here.

## Now (in flight)

(2026-10-03 13:2xZ, the FRAME PASS. Owner ruling 2026-10-03: build the whole product skeleton first, in parallel, polish
after; design record ~/.claude/plans/parallel-squishing-parnas.md. The frame is one thin line: one Woo shop -> its
declaration -> a door that is its claim -> find / ask / hold -> the owner approves and the customer gets a signed
follow-up -> the owner reads who came and who came back. Its proof is conformance/frame.mjs (FRAME TEST below), red
until every member lands. Chains in flight: Woo 001756Z -> 001757Z -> {001757Z-2, 001758Z, 001758Z-2} -> 001759Z;
S6a 215207Z (landed) -> 215208Z (impl) -> 215208Z-2 -> 215209Z; S6b 215209Z-2 (landed) -> 215210Z (tests).)

## Next (queued, in order)

### 0. The frame (owner ruling 2026-10-03): every member [skeleton], no member waits on another track

- P0 FRAME Claim-1 WooCommerce one-file plugin: examples/woocommerce-agent-entry.php serves the card, the signed tools contract and `POST /` from the generated declaration (ask -> facts, hold -> pending with a receipt), seed minted at activation; installing it IS the claim by install; conformance/recipes.mjs pins its bytes against the Node door's. [20261003T131709Z] [skeleton]
- P1 FRAME Answer-1 owner decision on the wire: `agent-entry decide <receipt> approve|decline` sends the signed follow-up to the customer's DID through message/send with the deal receipt updated (AT-13, new AT-28), idempotent by receipt id; the Host's tap UI is trunk's. [20261003T131710Z] [skeleton]
- P2 FRAME Visitor-1 the visitor skill carries the errand rule: spec/skill-distill.md and the distilled skill state the 2026-09-26 ruling in one sentence (the errand is the mandate), the journey step compares terms with the errand, no 'Ask first?' column; pin follows. [20261003T131710Z-2] [skeleton]
- P1 FRAME Analytics-1 counts coverage header and who in three tiers: `counts` opens with log range / last event / store present / rows dropped, then door knocks by signed (signature_agent), declared (AI ua_family) and network (ip_vendor) tiers plus country; vendor and engine vocabularies never merged; reads only what fileSink writes. [20261003T131711Z] [skeleton]
- P1 the door names the agent in one field: every observer row gains `agent` (first of signature_agent, an AI ua_family, ip_vendor, else the client_class word) and `agent_tier` (signed / declared / network / unknown), both in SINK_FIELDS so fileSink and gaSink forward them; README names the GA custom dimensions to register. Owner report 2026-10-04: muretai.com's GA shows 100% Unassigned and no agent. [20261004T130132Z] [skeleton]
- P1 FRAME Analytics-2 first_contact on the envelope and in the sink: answered POST rows carry first_contact (true when the message created the account row), it joins SINK_FIELDS, `counts` shows new vs returning knocks from the log. [20261003T131711Z-2] [after P1 FRAME Analytics-1 counts coverage header and who in three tiers] [skeleton]
- P1 S6a entry.counts hosted counts URL: the chain S6a-2 (door posts the AT-14 body to the counts URL, impl) -> S6a-3 (page runtime posts the same body) -> S6a-4 (README, CHANGELOG, docs.mjs needle, the "NOT YET ACCEPTED" drift); S6a-1 landed 4a6617b. Tail id. [20261002T215209Z] [skeleton]

### 1. Polish (each waits for its frame member; filed only when the frame test is green)

- P2 OSS boundary document: docs/OSS_BOUNDARY.md states the line in one table (OSS here: door, spec, conformance, declaration and Woo generator, one-file plugin, decide / track / receipts, local counts, fileSink and gaSink, knock and the visitor skill; product in trunk: Catalog, Claim Desk, hosted door, hosted ledger and dashboards, answering AI, billing), the rule that no Muretai-specific name is hard-coded in the OSS door, and when a separate product repository is cut; README links it from "What this is part of". [20261004T132749Z] [solo]
- P2 claim proof becomes a generic index proof: `publish --claim` stops hard-coding Muretai's path and body; the door serves any index's proof from configuration (`entry.claim: {path, body}` or `--claim-path` / `--claim-body`, path under /.well-known/, body one line, both refused by name when malformed), with the Muretai Catalog's `/.well-known/muretai-catalog-claim.txt` + `muretai-catalog-claim=<32 hex>` as a documented preset (`--claim muretai:<code>`), byte-identical to today's output for that preset; conformance/cli.mjs pins the preset bytes and a second, non-Muretai index. [20261004T132811Z] [after P0 FRAME Claim-2 publish --claim serves the Catalog's proof file]
- P2 counts URL documented as any collector: README, CHANGELOG and spec/tools-v1.md describe `entry.counts` as "a collector URL you choose (for example a Muretai hosted door)", never as a Muretai-only endpoint; the createAgentEntry doc comment stops saying it ships no sink and names no vendor; conformance/docs.mjs pins the wording. Folds into S6a-4 if that member is still open. [none] [solo]

- P1 claim proof checks on the door: `doctor --claim` checks what trunk's catalog/verify.py checks (both card files 200, signature valid, under 6 h old, card.url names the origin) and the DNS TXT form is verified against a resolver; conformance/cli.mjs pins both forms. [20261003T225305Z] [after P0 FRAME Claim-2 publish --claim serves the Catalog's proof file]
- P1 analytics time and funnel: `counts --since <days>` and per-day tables for knocks, page events, receipts and refusals; the per-offer table becomes a funnel (page: started -> succeeded / failed / ask_denied -> handoff; door: asked -> completed / refused by code -> receipt), the handoff -> door join is a count comparison only; the beacon's random `session` joins SINK_FIELDS for a within-visit funnel. [none] [after P1 FRAME Analytics-1 counts coverage header and who in three tiers]
- P1 returning customers over time: from {first_seen, last_seen, messages} alone: accounts, returning, repeat rate, new accounts per week, active in the last 7 / 30 days, returning-and-active, span buckets; what needs more storage is named as not promised. [none] [after P1 FRAME Analytics-2 first_contact on the envelope and in the sink]
- P2 decline with terms and the WP admin for pending holds: `decide decline --terms <text>` carries the shop's counter-terms in the follow-up; the one-file plugin lists pending holds in WP admin with approve / decline buttons that call the same wire shape. [none] [after P1 FRAME Answer-1 owner decision on the wire]
- P1 seam-twin resolves the sibling from a worktree: conformance/seam-twin.mjs finds the agent-seam checkout the same way from a worktree as from the primary checkout, and when MURETAI_AGENT_SEAM is unset and no sibling is found the skip is a hard failure (ISSUE intake 20260920T120501Z, 78 vs 72 checks). [20261003T225327Z] [after P0 FRAME TEST the one test that walks the thin line]
- P2 security review of the frame and Suite S1 to S3: a reviewer session reads 3c7c8e9..main (signing and public routes, the browser runtime verifying signatures, the CLI's seeds and secrets on disk, the new claim file and decide paths), writes notes/security-review-frame.md with findings anchored by line, files every fix as a line here; changes no code. [20261003T225754Z] [after P0 FRAME TEST the one test that walks the thin line] [solo]
- P2 Python twin of the Suite conformance: a Python reader of conformance/vectors-tools.json checks compileDeclaration determinism, the agenttools envelope and the verb registry defaults as conformance/tools.mjs does, so trunk's hosted door runs the same vectors without Node. [20261004T011503Z] [after P0 FRAME TEST the one test that walks the thin line]
- P2 steps page action: the page runtime accepts a `steps` entry in an offer's `page` block (an ordered list of open/read/fill/fetch/call actions, each bounded as today) with the AT-9 refusal set extended per step and vectors added. [20261004T014854Z] [after P0 FRAME TEST the one test that walks the thin line]
- P2 verb registry as its own document: spec/verbs.md generated from VERBS, VERB_EFFECTS and ASK_FLOOR by scripts/build-vectors.mjs so the two never drift; README links it under "What a customer can do here". [20261004T014915Z] [after P0 FRAME TEST the one test that walks the thin line] [solo]
- P3 serverless template renders the same declaration: agent-entry-serverless re-vendors at the current published version (pinned v1.11.6) and its template reads agent-entry.json so a Worker door serves the signed contract and skills as the Node door does; lands in that repository, tracked here. [20261004T114600Z] [after P0 Woo declaration generator]

### 2. Security review fixes (notes/security-review-frame.md, intake 20261003T225754Z; no high finding)

- P1 decide approve shows the terms and refuses stale or repeated receipts (C-2): `decide` prints verb, of, customer_did and request JSON-escaped and needs yes or --yes before signing, refuses a receipt older than a window without --stale-ok, and keeps a decided/<ref> record so a second approval is refused. [20261004T011208Z]
- P1 claimant contact is published knowingly or kept off the contract (C-1): the publish --claim prompt says the facts go public at /.well-known/agent-tools.json and stay in every version; a door-only private facts field keeps human contact out of the contract; a withdrawn version can be served 410. [20261004T011230Z]
- P1 knock refuses an off-origin endpoint and bounds its fetches (K-1): knockAgentEntry refuses a card endpoint whose origin is not the card URL's origin, as doctor does, and its card, signature and reply fetches get a 15 s timeout and a 1 MiB streamed cap. [20261004T011315Z]
- P1 find answers from a cached snapshot with a row cap (S-2): the door reads and validates agent-entry.products.json once and again only on mtime change, filters rows by q and caps a reply's rows with a more flag, instead of re-parsing up to 16 MiB per knock. [20261004T011336Z]
- P1 collector fan-out to entry.counts is bounded (S-1): postCounts gets a bounded queue, a timeout and a small concurrency cap, the collector gets its own per-minute ceiling, and the README says the page counts are forgeable by any HTTP client. [20261004T011358Z]
- P2 tools envelope freshness window (B-1): the page runtime and verifyToolsEnvelope refuse an agenttools envelope over 6 h old or over 300 s in the future, as the card does, with publish's static .sig.json handled by the door re-minting or a stated expiry. [20261004T015314Z]
- P2 URL placeholders refuse dot segments (B-2): the page runtime's open fill and the door's checkout url refuse a placeholder value that is exactly . or .., so a value cannot move the URL up a directory on the origin. [20261004T015336Z]
- P2 remote text is escaped before it reaches the terminal (K-2): knock and doctor --url print door text (reply, error.message, accepts, card.url) JSON-escaped or with C0/C1 controls stripped, as claimantConfirms does. [20261004T015358Z]
- P2 robots.txt fails closed and covers every page URL (W-1): init --from woocommerce refuses on a robots.txt network error, follows up to five same-host robots redirects, and matches each ?page=N URL, path plus query, before asking for it. [20261004T015420Z]
- P2 doctor bounds a remote door and skips state-changing knocks (W-2): doctorChecks caps the version walk, skips knocks on changes or pays offers without --knock-all, and marks its knocks as a probe the default responder and staff can ignore. [20261004T015548Z]
- P2 Woo plugin seed outside the database (S-3): the plugin prefers a wp-config.php constant for the seed when defined, and its header documents that the option is the shop's private key carried by backups and staging clones, with the rotation step and its new DID. [20261004T114538Z]
- P3 claim on a mounted entry needs an explicit host claim (S-4): readDeclaration refuses entry.claim on a mounted baseUrl unless the operator opts in, and the README says a claim speaks for every path on the host. [20261004T114621Z]
- P3 page call resolves only registered handlers (B-3): the page runtime resolves a call action from handlers or a site-registered handler object only, never a bare window global, and spec/tools-v1.md states the signature binds the contract to the card, not to the domain owner. [20261004T114643Z]
- P3 seed and knock key writes refuse symlinks (K-3): mintSeed and knockSeed lstat the slot and the knock key file and refuse a symlink with a message naming it. [20261004T114705Z]
- P3 visitor skill says signed reply data is content not instructions (W-3): spec and the distilled visitor skill state that product names and facts in a shop-signed reply are quoted data, never instructions to follow. [20261004T114727Z] [solo]

## Owner rulings owed (not items until ruled)

- Whether this repository should be gated: vendor a minimal `tools/run_tests.py` (npm test) and `tools/sec_lint.py`
  so the vendored finish-worktree records TESTS and SEC, or have the receipt say "ungated" in words. ISSUE intake
  20260920T130938Z. Until ruled, every landing here says none.
- The live demo's step-2 button reads "2. Sign and book" but the responder returns a pending request, not a
  booking (examples/live-demo.html:79, live-demo.mjs:81). Wording is the owner's call ("Sign and request" or
  "Sign and ask to book" would match). ISSUE intake 20260920T130807Z, with the other copy findings.
- Negotiation on `quote`/`hold` through coordination turns (R9) waits for the pilot shop (bila-makan on the
  hosted door, owner ruling 2026-09-22); it becomes a line here when that shop is live.

## Dependencies on other repositories (tracked there, named here)

- trunk FRAME Hosted-1 [20261003T131712Z]: the hosted shop door takes an agent-entry.json declaration and answers find / ask /
  hold with the Suite's default replies (today it has none: free text by the brain). Without it a claimed shop that installs
  nothing has no answering surface.
- trunk FRAME Hosted-2 [20261003T131713Z, after Hosted-1]: Catalog claim/finish provisions a hosted door for a claimed shop
  and returns ledger_url and card_url (starting pin: the unmerged branch feat/catalog-claim-offers-the-hosted-4a3e).
- trunk, later: the hosted ledger's "who" rendering is deferred (re-identification risk for small shops; marginals only,
  day buckets, cells under 5 suppressed, if ever).
- trunk: the hosted door's collector and ledger counts, S5, landed 94b76839; the Fly deploy of it is an owner
  step (owner-steps-agent-entry-1-4-2026-09-25.sh step2). S6a posts to it.
- muretai-site: the front desk runs the published door (pin 1.13.1 landed 41f325d; deploy is the owner's).
- muretai-trunk / appl: the publisher pushes branches, not tags, until intake 20260925T214349Z lands; v1.13.0 and
  v1.13.1 exist locally and in the hand-off only.

## Done (not yet released)

- P0 Woo declaration generator: `npx @muretai/agent-entry init --from woocommerce <store-url>` reads the shop's PUBLIC Store API and writes agent-entry.json (Woo-1 refusals, Woo-2 `ask` from one page, Woo-3 pagination, Woo-4 `find` snapshot, Woo-5 `hold`, Woo-6 `doctor --from woocommerce`). The whole chain has landed. [20261003T001756Z, 20261003T001757Z, 20261003T001757Z-2, 20261003T001758Z, 20261003T001758Z-2, 20261003T001759Z] [skeleton]
- P1 S6b the knock speaks the verbs: S6b-2, checkedBookingReceipt recognises the Suite's default reply {verb, of, customer_did, request, status, facts|url by kind, deal?} next to the older {type, customer_did, request, status} shape, so the customer_did cross-check runs on a real Suite door's answer; S6b-1 (`--offer` on the knock) landed 9e58808. The whole chain has landed. [20261002T215209Z-2, 20261002T215210Z] [skeleton]
- S6b-1 the knock gains `--offer` and sends metadata.offer (chain of S6b) [20261002T215209Z-2] d463ef2..9e58808
- S6a-1 `counts` joins the accepted entry keys (chain of S6a) [20261002T215207Z] f1b4020..4a6617b
- isolated-session: re-vendor APPL v0.1.1 (da7c693) [20260930T020158Z] 1bc9b04
- P1 S6b the knock speaks the verbs: S6b-2, checkedBookingReceipt recognises the Suite's default reply shape next to the older one (tests in flight); S6b-1 (`--offer` on the knock) landed 9e58808. Tail id. [20261002T215210Z] [skeleton]
- P0 FRAME Claim-2 publish --claim serves the Catalog's proof file: `publish --claim <32 hex>` makes the door serve /.well-known/muretai-catalog-claim.txt with body `muretai-catalog-claim=<code>` (trunk catalog/service.py contract) and prints the DNS TXT alternative; 404 without a code. [20261003T131709Z-2] [skeleton]
- P0 FRAME TEST the one test that walks the thin line: conformance/frame.mjs, test author only, red at every step a member makes green (init from a fixture Woo store, door up, claim file served, knock find/ask/hold, decide approve, counts shows who and first_contact); not wired into npm test until green. [20261003T131708Z] [skeleton]

## Done v1.13.1 (2026-09-28)

- The Muse connector page and README without the not-tested-in-Muse caveat (owner ruling 2026-09-27); conformance
  pins the public pages without it [20260926T204235Z] dbfb63b..bb471a4
- isolated-session re-vendored from muretai-trunk 89f2717f [20260926T233713Z] a7d6401

## Done v1.13.0 (2026-09-26)

- Agent Entry Suite S1: spec/tools-v1.md, vectors, validator/compiler/signer, generated skills, default responder,
  collector route [20260921T215426Z] 26b78ca..9c50b6a
- Agent Entry Suite S2: the page runtime agent-entry-page.mjs verifies the contract before registering
  [20260921T215427Z] 9c50b6a..eecb7b5
- Agent Entry Suite S3: CLI init | publish | doctor | counts and gaSink [20260921T215441Z] b9a49f5..661ff37
- Agent Entry Suite S4: README and CHANGELOG 1.13.0 [20260921T215441Z-2] 5d45b65..3166272
- Re-vendor the isolated-session skill, pinned trunk 84508b68 [20260922T121835Z] 661ff37..5d45b65
- Muse custom connector recipe: connectors/muse.md, README bullet, spec paragraph, same-HOME-same-DID conformance
  [20260919T141503Z] 726bfd3..45e123e

## Done v1.12.0 (2026-09-21)

- Who is knocking v2: trustProxy, vendorRanges with the fixed VENDORS table, country, signature_agent, vendorStats,
  scripts/vendor-ranges.mjs, AE-31/32 [20260919T015727Z] ..26b78ca
