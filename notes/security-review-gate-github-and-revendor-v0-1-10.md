# Security review: gate-github-and-revendor-v0-1-10

## Why

The publisher holds agent-entry main at origin 407f74e because two commits have no clean reviewer receipt: 73bd7b5, which sets the landing gate to github, and 59a6253, the APPL v0.1.10 re-vendor. This note files the findings of the review of 407f74e..59a6253. The receipt is .security/audit-receipts/seq-0/20261101-202333-gate-github-and-revendor-v0-1-10.json.

## Design notes

- The vendored files under .cursor/skills/isolated-session/ were checked against the pin, not reviewed for their logic. vendor.sh check reports 67 files matching appl @ v0.1.10 = 3a26fee5acc3.
- The gate verdict comes from main's committed appl.toml blob, finish-worktree.sh:1287-1290. A branch's own appl.toml does not decide it.
- A branch that only reverts the gate, or only adds review receipts or notes, lands locally. That is APPL's design, at appl_config.py:383-402. It is not a finding of this range.
- This repository has no tools/ directory and appl.toml has no [tests] command. As a result, a local landing here runs no tests and no scan, as at finish-worktree.sh:3607, and every gate=github hand-off is refused, at finish-worktree.sh:1349-1352. The refusal fails closed. It is an operational gap, not filed as a security finding.

## Open issues

- ISSUE(security-audit-2026-11-01-gate-github-and-revendor-v0-1-10): Under gate = "github", the one required check `test` is defined by the PR head itself. .github/workflows/test.yml:4-7 runs on pull_request and merge_group, which use the head or queued tree's workflow, and test.yml:22 runs the head's package.json scripts.test. docs/LANDING.md:27-35 asks for no approving review and no code-owner review, and LANDING.md:37 says CODEOWNERS has no rules, although .github/CODEOWNERS has `* @muretai`. The chain: a hostile branch sets scripts.test to `true`, or rewrites the test step. The required check `test` passes, the merge queue re-runs the same edited definition, and the code merges to GitHub main with no human review. Fix: require an approving code-owner review in the main ruleset, or make the test workflow a ruleset-required workflow taken from main, and correct LANDING.md:13 and :37.
- ISSUE(security-audit-2026-11-01-gate-github-and-revendor-v0-1-10-2): `init <store url>` detection does not share the --max-bytes budget. The woo probe wooFirstPage, at muretai-agent-entry.mjs:7149-7152, reads robots.txt and up to min(4 MiB, maxBytes) of the Store API path. When that answer is not a Store API page, detection moves on, and siteWalk starts a fresh state at bytes 0, at muretai-agent-entry.mjs:7630, and reads robots.txt again. The chain: a hostile store answers the woo path with a 200 non-JSON body at the cap, then serves a product sitemap. init then reads about maxBytes plus min(4 MiB, maxBytes) plus two robots.txt bodies, against README's "the most body bytes read over every page together". The read stays finite, so this is low severity. Fix: carry the probe's bytes into the site walk's state.

## Decisions

(none)
