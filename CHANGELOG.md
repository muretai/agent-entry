# Changelog

Releases before 1.12.0 are recorded in the commit history and in the README's "Since 1.x"
paragraphs.

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
