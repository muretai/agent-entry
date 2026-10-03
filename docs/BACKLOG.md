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

- P0 FRAME TEST the one test that walks the thin line: conformance/frame.mjs, test author only, red at every step a member makes green (init from a fixture Woo store, door up, claim file served, knock find/ask/hold, decide approve, counts shows who and first_contact); not wired into npm test until green. [20261003T131708Z] [skeleton]
- P0 Woo declaration generator: `npx @muretai/agent-entry init --from woocommerce <store-url>` reads the shop's PUBLIC Store API and writes agent-entry.json (frame members Woo-1 refusals and Woo-2 `ask` from one page; Woo-3 pagination, Woo-4 `find` snapshot, Woo-5 `hold`, Woo-6 doctor are the polish members of the same chain). [20261003T001759Z] [skeleton]
- P0 FRAME Claim-1 WooCommerce one-file plugin: examples/woocommerce-agent-entry.php serves the card, the signed tools contract and `POST /` from the generated declaration (ask -> facts, hold -> pending with a receipt), seed minted at activation; installing it IS the claim by install; conformance/recipes.mjs pins its bytes against the Node door's. [20261003T131709Z] [skeleton]
- P0 FRAME Claim-2 publish --claim serves the Catalog's proof file: `publish --claim <32 hex>` makes the door serve /.well-known/muretai-catalog-claim.txt with body `muretai-catalog-claim=<code>` (trunk catalog/service.py contract) and prints the DNS TXT alternative; 404 without a code. [20261003T131709Z-2] [skeleton]
- P1 FRAME Answer-1 owner decision on the wire: `agent-entry decide <receipt> approve|decline` sends the signed follow-up to the customer's DID through message/send with the deal receipt updated (AT-13, new AT-28), idempotent by receipt id; the Host's tap UI is trunk's. [20261003T131710Z] [skeleton]
- P1 S6b the knock speaks the verbs: S6b-2, checkedBookingReceipt recognises the Suite's default reply shape next to the older one (tests in flight); S6b-1 (`--offer` on the knock) landed 9e58808. Tail id. [20261002T215210Z] [skeleton]
- P2 FRAME Visitor-1 the visitor skill carries the errand rule: spec/skill-distill.md and the distilled skill state the 2026-09-26 ruling in one sentence (the errand is the mandate), the journey step compares terms with the errand, no 'Ask first?' column; pin follows. [20261003T131710Z-2] [skeleton]
- P1 FRAME Analytics-1 counts coverage header and who in three tiers: `counts` opens with log range / last event / store present / rows dropped, then door knocks by signed (signature_agent), declared (AI ua_family) and network (ip_vendor) tiers plus country; vendor and engine vocabularies never merged; reads only what fileSink writes. [20261003T131711Z] [skeleton]
- P1 FRAME Analytics-2 first_contact on the envelope and in the sink: answered POST rows carry first_contact (true when the message created the account row), it joins SINK_FIELDS, `counts` shows new vs returning knocks from the log. [20261003T131711Z-2] [after P1 FRAME Analytics-1 counts coverage header and who in three tiers] [skeleton]
- P1 S6a entry.counts hosted counts URL: the chain S6a-2 (door posts the AT-14 body to the counts URL, impl) -> S6a-3 (page runtime posts the same body) -> S6a-4 (README, CHANGELOG, docs.mjs needle, the "NOT YET ACCEPTED" drift); S6a-1 landed 4a6617b. Tail id. [20261002T215209Z] [skeleton]

### 1. Polish (each waits for its frame member; filed only when the frame test is green)

- P1 claim proof checks on the door: `doctor --claim` checks what trunk's catalog/verify.py checks (both card files 200, signature valid, under 6 h old, card.url names the origin) and the DNS TXT form is verified against a resolver; conformance/cli.mjs pins both forms. [none] [after P0 FRAME Claim-2 publish --claim serves the Catalog's proof file]
- P1 analytics time and funnel: `counts --since <days>` and per-day tables for knocks, page events, receipts and refusals; the per-offer table becomes a funnel (page: started -> succeeded / failed / ask_denied -> handoff; door: asked -> completed / refused by code -> receipt), the handoff -> door join is a count comparison only; the beacon's random `session` joins SINK_FIELDS for a within-visit funnel. [none] [after P1 FRAME Analytics-1 counts coverage header and who in three tiers]
- P1 returning customers over time: from {first_seen, last_seen, messages} alone: accounts, returning, repeat rate, new accounts per week, active in the last 7 / 30 days, returning-and-active, span buckets; what needs more storage is named as not promised. [none] [after P1 FRAME Analytics-2 first_contact on the envelope and in the sink]
- P2 decline with terms and the WP admin for pending holds: `decide decline --terms <text>` carries the shop's counter-terms in the follow-up; the one-file plugin lists pending holds in WP admin with approve / decline buttons that call the same wire shape. [none] [after P1 FRAME Answer-1 owner decision on the wire]
- P1 seam-twin resolves the sibling from a worktree: conformance/seam-twin.mjs finds the agent-seam checkout the same way from a worktree as from the primary checkout, and when MURETAI_AGENT_SEAM is unset and no sibling is found the skip is a hard failure (ISSUE intake 20260920T120501Z, 78 vs 72 checks). [none] [after P0 FRAME TEST the one test that walks the thin line]
- P2 security review of the frame and Suite S1 to S3: a reviewer session reads 3c7c8e9..main (signing and public routes, the browser runtime verifying signatures, the CLI's seeds and secrets on disk, the new claim file and decide paths), writes notes/security-review-frame.md with findings anchored by line, files every fix as a line here; changes no code. [none] [after P0 FRAME TEST the one test that walks the thin line] [solo]
- P2 Python twin of the Suite conformance: a Python reader of conformance/vectors-tools.json checks compileDeclaration determinism, the agenttools envelope and the verb registry defaults as conformance/tools.mjs does, so trunk's hosted door runs the same vectors without Node. [none] [after P0 FRAME TEST the one test that walks the thin line]
- P2 steps page action: the page runtime accepts a `steps` entry in an offer's `page` block (an ordered list of open/read/fill/fetch/call actions, each bounded as today) with the AT-9 refusal set extended per step and vectors added. [none] [after P0 FRAME TEST the one test that walks the thin line]
- P2 verb registry as its own document: spec/verbs.md generated from VERBS, VERB_EFFECTS and ASK_FLOOR by scripts/build-vectors.mjs so the two never drift; README links it under "What a customer can do here". [none] [after P0 FRAME TEST the one test that walks the thin line] [solo]
- P3 serverless template renders the same declaration: agent-entry-serverless re-vendors at the current published version (pinned v1.11.6) and its template reads agent-entry.json so a Worker door serves the signed contract and skills as the Node door does; lands in that repository, tracked here. [none] [after P0 Woo declaration generator]

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

- P1 S6b the knock speaks the verbs: S6b-2, checkedBookingReceipt recognises the Suite's default reply {verb, of, customer_did, request, status, facts|url by kind, deal?} next to the older {type, customer_did, request, status} shape, so the customer_did cross-check runs on a real Suite door's answer; S6b-1 (`--offer` on the knock) landed 9e58808. The whole chain has landed. [20261002T215209Z-2, 20261002T215210Z] [skeleton]
- S6b-1 the knock gains `--offer` and sends metadata.offer (chain of S6b) [20261002T215209Z-2] d463ef2..9e58808
- S6a-1 `counts` joins the accepted entry keys (chain of S6a) [20261002T215207Z] f1b4020..4a6617b
- isolated-session: re-vendor APPL v0.1.1 (da7c693) [20260930T020158Z] 1bc9b04

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
