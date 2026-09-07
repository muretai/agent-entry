# Releasing `@muretai/agent-entry`

Releases are cut from this repository and nowhere else. Nothing is copied in from another
checkout at release time, and nothing here writes into another repository.

## Before

```sh
npm test                                   # conformance/run.mjs + conformance/seam-twin.mjs, no network
git status --short                         # clean
```

If the seam moved (agent-seam has a new tag), re-vendor first and commit that on its own:

```sh
npm run vendor:seam -- --ref v0.2.0        # ../agent-seam or $MURETAI_AGENT_SEAM, read with `git show`
npm test
git add -A vendor/agent-seam muretai-agent-entry.mjs conformance/vectors.json
git commit -m "seam: vendor agent-seam v0.2.0"
```

## Cut

```sh
test "$(gh api user --jq .login)" = "muretai"          # the account guard: the wrong login publishes nothing
npm whoami                                             # the muretai publisher; a 401 means `npm login`, not a retry
npm version minor                                      # or patch — bumps package.json, commits, tags vX.Y.Z
npm publish                                            # publishConfig.access is public; --dry-run first if in doubt
git push --follow-tags origin main
```

`npm version` restores tagging, which stopped at v1.6.3 while releases were cut elsewhere.

## After

```sh
npm pack --dry-run                          # the tarball: one module, conformance/, examples/server.mjs, spec/, diagrams/
```

Then tell the consumers. Each pulls at its own pace with its own script; none is written into
from here:

| Consumer | What it takes | How |
|---|---|---|
| Muretai core | the module, `spec/v1.md`, `conformance/receptor-check.mjs`, `examples/server.mjs` | its own vendor tool, at the tag |
| `agent-entry-serverless` | the module, with its `store` seam patch on top | `node scripts/vendor.mjs --ref vX.Y.Z` there |
| The front desk site | the npm package | its `package.json` pin |

The Python door in core is held to this spec by core's contract suite, which it runs against
its vendored copy; a release here that changes behaviour shows up there as a failing parity
part, which is the point.
