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
- The design record for the Suite items is
  `~/.cache/muretai-herd/coordinator/briefs/agent-entry-suite-design.md` (owner-approved 2026-09-22): own
  vocabulary, verbs first, one A2A method, payment untouched, seed minted locally. Those rulings are not
  re-opened by an item here.

## Now (in flight)

(nothing in flight on 2026-10-02; the last landing was the APPL v0.1.1 re-vendor 1bc9b04)

## Next (queued, in order)

### 1. Agent Entry Suite S6 (the follow-ups of 1.13.0, after trunk S5 94b76839)

- P1 S6a entry.counts hosted counts URL: `counts` joins the accepted `entry` keys of AT-1 (spec/tools-v1.md 2.1; today ENTRY_KEYS in muretai-agent-entry.mjs is name/baseUrl/domains/prefer/catalog and onlyKeys refuses the rest) as an absolute https URL refused by name like every field, and the door and the page runtime send the SAME AT-14 body (session + events, eight normative names, no DID, no text, no input values, <=2048 bytes) to that URL as well as to the local observer, best-effort and non-blocking exactly as gaSink is, so a slow or failing sink never delays or changes one byte of a signed reply; the bytes are the ones trunk's collector already accepts (agent/shopcounts.py, tests/test_hosted_door_counts.py), so a self-hosted door's numbers appear on the shop's secret-link ledger page with nothing to run; README's "A hosted dashboard is planned, not shipped" paragraph, the CHANGELOG and conformance/docs.mjs's needle follow. Tests first in conformance/collector.mjs and conformance/tools.mjs. [none] [skeleton]
- P1 S6b the knock speaks the verbs: knockAgentEntry (the `agent-entry knock <card-url>` path) gains `--offer <id or verb>` and sends `metadata.offer`, which the door has read since S1 (AT-11) and `doctor` already sends in-process; and checkedBookingReceipt recognises the Suite's own default reply {verb, of, customer_did, request, status, facts|url by kind, deal?} (AT-12/AT-13) next to the older {type, customer_did, request, status} shape, so the customer_did cross-check runs on a real Suite door's answer instead of printing it as raw text. Tests first in conformance/cli.mjs and conformance/offers.mjs. [none] [skeleton]
- P2 S6c the visitor skill compares terms with the errand: spec/skill-distill.md and the distilled skill (scripts/distill) carry the owner ruling of 2026-09-26 (the person's errand is the mandate; the journey step is "compare the shop's terms with the errand", never "decide whether to ask"; return only on divergent terms, missing information or a verb beyond the errand; no "Ask first?" column), and the conformance pin on the distilled text follows. [none] [after P1 S6b the knock speaks the verbs]

### 2. Conformance and the gate

- P1 seam-twin resolves the sibling from a worktree: conformance/seam-twin.mjs finds the agent-seam checkout the same way from a worktree as from the primary checkout (walk up past .worktrees/<name> to the repository's parent), and when MURETAI_AGENT_SEAM is unset and no sibling is found the skip is a hard failure, so a worker's run can never be six checks weaker than main's and pass silently (ISSUE intake 20260920T120501Z, measured 78 vs 72 on 45e123e). [none]
- P2 security review of Suite S1 to S3: a reviewer session reads 3c7c8e9..661ff37 (the signing and public route of S1, the browser runtime verifying signatures in S2, the CLI's seeds and secrets on disk in S3), writes its findings to notes/security-review-suite-s1-s3.md with each finding anchored to a line, and files every fix it owes as a line here; it changes no code (the three slices landed review=none because this repository has no sec_lint). [none] [solo]
- P2 Python twin of the Suite conformance: a Python reader of conformance/vectors-tools.json checks compileDeclaration determinism, the agenttools envelope and the verb registry defaults the way conformance/tools.mjs does, so trunk's hosted door can run the same vectors without Node (design record section 6, "Python twin = follow-up ISSUE"). [none] [after P1 S6a entry.counts hosted counts URL]

### 3. Polish named by the design record (section 7.6)

- P2 steps page action: the page runtime accepts a `steps` entry in an offer's `page` block (an ordered list of open/read/fill/fetch/call actions, each bounded as today) so a multi-step page task is one offer, with the AT-9 refusal set extended per step and vectors added to conformance/vectors-tools.json. [none] [after P1 S6b the knock speaks the verbs]
- P2 verb registry as its own document: spec/verbs.md states VERBS, VERB_EFFECTS and ASK_FLOOR with one paragraph per verb, generated from the registry by scripts/build-vectors.mjs so the two can never drift, and README links it under "What a customer can do here" for other doors to adopt. [none] [solo]
- P3 serverless template renders the same declaration: agent-entry-serverless re-vendors at the current published version (it is pinned at v1.11.6) and its template reads agent-entry.json so a Worker door serves the signed contract and the generated skills exactly as the Node door does; the work lands in that repository and this line only tracks it. [none] [after P1 S6a entry.counts hosted counts URL]

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

- trunk: the hosted door's collector and ledger counts, S5, landed 94b76839; the Fly deploy of it is an owner
  step (owner-steps-agent-entry-1-4-2026-09-25.sh step2). S6a posts to it.
- muretai-site: the front desk runs the published door (pin 1.13.1 landed 41f325d; deploy is the owner's).
- muretai-trunk / appl: the publisher pushes branches, not tags, until intake 20260925T214349Z lands; v1.13.0 and
  v1.13.1 exist locally and in the hand-off only.

## Done (not yet released)

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
