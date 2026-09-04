# Agent Entry — Episode-to-Skill (site side)

Status: **local loop shipped** (`scripts/distill/`). Does not change the v1
HTTP contract (`spec/v1.md`).
Method: Repo-To-Skill (arXiv 2609.02749) — distill, verify, load only what
the task needs. Source: outcome-labeled knocks at **this** door, not a
GitHub crawl and not a network-wide catalog.

This repository stays the door. Distillation is an **owner-side, offline**
loop. Nothing here is added to `muretai-agent-entry.mjs` at request time.

---

## 1. What is missing today

A visiting agent reads the card before it knocks. If `skills[]` is empty or
wrong, it guesses and learns the menu from refusals. The README already
states the two owner duties:

- every `examples[]` entry must be answerable by the responder
- declare only what the responder actually does

Those duties are still hand-written. The paper's claim is that this
operating knowledge already exists in **grounded outcomes** — signed
envelopes plus what the door did — and can be distilled into the menu the
next visitor sees.

The door already emits the labels, without changing a verdict:

- `observer(env)` runs **after** the reply; its return is discarded
- `stats()` / `clientStats()` count family and stage, including refusals
- JSON-RPC refusals teach (`-32004` over-rate, unsigned, replay, wrong
  recipient); the recipe already rides in the refusal
- the responder's own result (answered / asked for a missing field /
  handed off) is the site-specific outcome

User-Agent never affects `verified`, a ledger row, a rate lane, or any
refusal. Distillation must not reopen that. UA is a counting hint, not a
training label for "who to trust".

---

## 2. What to steal, what to refuse

Steal: four-stage distillation (scope → ground → construct → verify);
skills as operating context, not a new control loop; environment-grounded
admission (a transcript-only gate cannot improve uniformly); withhold-the-
skill measurement.

Refuse:

- Distiller inside the one-file runtime (zero dependencies, no database)
- a hosted catalog of every site's skills
- FOLLOW of visitor-authored text (`env.text` stays untrusted data)
- stamping a third-party `howToUrl` (empty means omitted; only a URL the
  owner operates)
- changing any wire byte or verdict because a skill exists

---

## 3. Mapping

| Paper | This repo |
|---|---|
| Declarative source | Signed inbound `text` + door outcome (verify / refuse code / responder result) |
| Skill | A2A `skills[]` on the **signed** card; optional owner `howToUrl`; optional `SKILL.md` the owner hosts |
| Skill graph | One entry skill (what this door answers) → component skills per declared capability |
| Router | The card itself. Visitors read `skills[]` before POST. Agent Web Router finds the door; it does not write this menu |
| Verification | Card signature still covers the menu. Examples are driven through the responder in tests (already required) |
| Creator / researcher | Owner Distiller writes a proposed menu; the running entry only **serves** what the owner published |

```
visitor  --probe-->  card.skills[]  (menu; signed)
visitor  --knock-->  POST door      (unchanged contract)
observer --trace-->  local log      (after verdict)
Distiller (offline) --> proposed skills[] / how-to
owner publishes --> card resigns
```

---

## 4. Distiller pipeline (offline, this repo or a sibling package)

Anchor is this origin's door, not a task on the open web.

1. **Scope.** One capability the responder already implements (hours,
   quote, book, …). Do not invent a skill the responder cannot keep.
2. **Ground.** Read owner-local traces only: `observer` rows the owner
   chose to keep, plus the door's refuse reason. A row is
   `{text, verified, refuse_code?, responder_tag, ts}`. No operator
   aggregation across sites.
3. **Construct.** Propose:
   - `skills[]` id / name / description / tags / **answerable** examples
   - optional how-to prose at a URL the owner operates
   - construction record `R`: evidence (trace ids), checks, remaining gaps
4. **Verify (M0).** Before publish:
   - the new card still signs
   - every example POSTed to the local entry gets a signed reply the
     visitor could accept (existing "examples are promises" rule)
   - refuse rate on a frozen visitor suite does not rise
   - remaining gaps stay in `R`

The running entry never imports the Distiller. Shipped layout (not
imported by the one-file runtime):

```
scripts/distill/          # owner CLI
  record.mjs              # fileSink() for observer → var/traces.jsonl
  distill.mjs             # traces → generated/skills.json
  measure.mjs             # M2 with/without the proposed menu
  loop.mjs                # distill → measure → mutation
```

`npm run distill`. Proposed `skills[]` is never written onto the running
card. `--m0` also runs the door conformance suite.

`createAgentEntry({ observer })` already exists. Recording is an owner
choice. Default remains no disk.

---

## 5. Measurement

A skill cannot be graded by reading it (ACES, arXiv 2608.20614).

- **M0 admission** — signed card; examples answerable; contract suite
  (`conformance/`) still green. Fail-closed.
- **M2 lift** — freeze responder, rates, and a held-out visitor prompt
  set. Arm A: current `skills[]` / how-to. Arm B: proposed menu. Score
  only what a visitor observes: first-knock useful answer, refuse-for-
  missing-field, handoff that the card still names. Not token count.
- **Producer mutation** — Distiller emits empty `skills[]`. Lift must
  fall to ~0. If it stays green, the test was scoring the responder.
- **No leaderboard.** One site, that site's traces, that site's reader.

Publish rule: M0 holds, M2 first-knock success rises or refuse-for-guess
falls, mutation kills the lift.

---

## 6. First dojo (this repo, no production traffic)

Frozen visitor prompts against `examples/server.mjs` (or a fixture
responder) that requires a missing field the naive visitor omits.

- Train traces: naive knocks that the responder rejects with a teachable
  reason, plus one complete knock.
- Distiller writes a skill example that includes the field.
- Holdout: a new wording of the same need.
- Naive visitor still omits the field; skill-equipped visitor includes it.
- Mutation: empty Distiller, both arms omit, lift 0.

Do not use live `muretai.com` traffic for the first number.

---

## 7. What this does not change

v1 HTTP surface, Ed25519 envelope, account-from-first-signature, rate
lanes, Web Bot Auth as recognition-only, `Link` signpost, path mounts,
`domains`. Agent Web Router remains a **visitor** of this door. It may
read the distilled menu; it must not write it.

## 8. Relation to `muretai-skill-distill`

That sibling app proved withhold-the-skill lift on a fail-closed parse
dojo. This design is the same method with a different source: **door
outcomes**, not `x-rlds` lines. Do not vendor-copy core crypto. The entry
already verifies signatures.

---

## 9. Live loop — two rails (we never see installer traffic)

This package is installed by other people, on origins we do not operate.
Their visitors' messages, accounts, and `observer` rows are **not ours**
and MUST NOT be fetched, phoned home, or scraped. There is no telemetry
channel. Evolution therefore splits.

### Rail A — this package (what we can update)

We improve the **door machinery and the refusal recipe**, not a site's
menu. Labels come only from sources we already own or that someone
chose to publish:

- `conformance/` vectors and the contract suite (attacks we author)
- the doors **we** run (for example the muretai.com entry)
- a GitHub issue a site owner **opts into**, attaching a redacted
  fixture they exported (`export --redact` if later built; default off,
  never runs itself)

A package release may change refusal text, `howTo` defaults (still no
third-party host), rate-lane behaviour, or new contract tests. It MUST
NOT patch a stranger's `skills[]`. That list is their signed claim.

Measure a release against **our** fixtures (§5). If we do not have a
new fixture, we do not have a new skill.

### Rail B — each installer's machine (what they can update)

The only place their knock data exists is their process. The Distiller,
if they run it, reads a local `observer` sink they configured. The
child `skills[]` stays on their card. We never receive it.

```
their observer → their disk → their Distiller → their next card
```

`stats()` they already have is for **them**. It is not a feed to us.
User-Agent remains unusable as a label.

### What we do when we cannot see production

We do not wait for it. The first dojo (§6) and every later package
change are fixture-grown. When a user reports "visitors keep getting
refused and the recipe did not teach X", the artifact we want is a
**reproducing envelope**, not their ledger. That becomes a conformance
case. That is the only upstream ratchet that does not take their
customers.
