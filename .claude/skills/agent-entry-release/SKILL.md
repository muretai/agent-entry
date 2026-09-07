---
name: agent-entry-release
description: Cut a release of @muretai/agent-entry from this repository — re-vendor the seam if it moved, run the suite, bump, tag, publish, push — and name what the consumers must pull afterwards. Use when the owner says "release agent-entry", "publish the door", "cut 1.x".
---

# Agent Entry release

The runbook is [RELEASING.md](../../../RELEASING.md); this file is the order and the guards.

1. **The seam first, if it moved.** `npm run vendor:seam -- --ref <agent-seam tag>` reads
   `../agent-seam` (or `$MURETAI_AGENT_SEAM`) with `git show`, splices the block, rewrites the
   pinned constants by name, writes `vendor/agent-seam/VENDOR.json` and rebuilds
   `conformance/vectors.json`. Commit that alone. Never edit the block or the vendored files by
   hand: `conformance/seam-twin.mjs` refuses the digests.
2. **`npm test`** — must be green with no other checkout present (try
   `MURETAI_AGENT_SEAM=/nonexistent npm test` if in doubt). The published tarball's `npm test`
   runs `conformance/run.mjs` and a `skip:` line from the twin; that is expected.
3. **Guards, then cut.** `gh api user --jq .login` is `muretai`; `npm whoami` answers;
   `npm version minor|patch`; `npm publish`; `git push --follow-tags origin main`. Nothing is
   pushed or published without the owner saying so in the same conversation.
4. **Tell the consumers**, do not write into them: core runs `tools/vendor_agent_entry.py`,
   serverless runs `scripts/vendor.mjs`, the site bumps its npm pin. If core's parity suite
   then fails, the door changed behaviour the Python door does not have yet — that is a core
   task, not a reason to hold the release.

What this skill never does: copy files from Muretai core (the direction reversed on
2026-09-07), edit `vendor/agent-seam/`, or push on its own.
