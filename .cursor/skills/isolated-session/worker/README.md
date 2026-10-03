# landing-lease Worker

The landing lease: at most one machine lands on a repository's trunk at a time.
`finish-worktree.sh` takes it before the merge and releases it after the publish step,
through `scripts/landing-lease.sh` -- one process and one signed HTTPS POST per verb.

| file | what it is |
|---|---|
| `lease-core.mjs` | the decision logic, pure: epoch CAS, TTL, replay window, rate limit, membership seam |
| `worker.mjs` | the Worker (routes `POST /lease/<repo>`) and the Durable Object `LandingLease` (SQL storage adapter) |
| `wrangler.toml` | the deploy description: no account, no route, no secret |

## Tenancy

A deployment is single-tenant: every machine that can reach it lands on the same set of
repositories under one allowlist, which is what makes `idFromName("landing:" + repo)` safe,
because two adopters sharing one deployment and one repository name would share one lease.
Each adopter deploys their own Worker on their own Cloudflare account and points
`[lease] url` (or `endpoint=` in `<dispatch dir>/node`) at it.

## Wire

`POST /lease/<repo>` with `{"payload": {"verb", "repo", "did", "ts", "nonce", "epoch"?},
"sig": <base64 Ed25519 over the canonical JSON of payload>}`. `verb` is take, release or
renew; `epoch` is required for release and renew and absent on take. `ts` is whole seconds
and must be within 300 s of the DO's clock; a nonce is remembered per DID for 600 s.

- 200 `{ok: true, holder, until, epoch}` (and `superseded: {holder, until}` when a take
  replaced an expired lease). The grant is unsigned: it is the TLS answer to the holder's
  own request. A take by the live holder is a renew at the same epoch.
- 409 `held` (with `holder`, `until`), `not-holder`, `stale-epoch`, `expired`.
- 400 `malformed`, `repo-mismatch`, `unsupported-key`; 401 `stale-ts`, `bad-signature`,
  `replayed-nonce`; 403 `not-allowlisted`; 429 `rate-limited`.

`GET /health` answers `{"ok": true}`; the doctor (`tools/appl-init.sh --check`) uses it to
say whether the backend is reachable, and never takes the lease.

## Membership

`isAllowed(did, env, store)` in `lease-core.mjs` is the one membership seam. Version 1
reads the Worker secret `LEASE_ALLOWLIST`, a JSON array of `did:key` strings (the lease
identities named by each machine's `lease=` line -- dedicated, unbound keys). The DO holds
no signing key of any kind: it verifies requests with WebCrypto and signs nothing.

## Deploy (owner)

    cf web && cd .cursor/skills/isolated-session/worker && wrangler deploy
    cf web && cd .cursor/skills/isolated-session/worker && wrangler secret put LEASE_ALLOWLIST

`cf web` (company/ops/deploy/cf-account.sh) selects the account from its token and refuses
a mismatch; nothing in this directory names an account.
