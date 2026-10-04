# Agent Entry roadmap

What is planned for the open-source door, in rough order. Plans change; a line here is an intention, not a
promise, and nothing is described as working until it ships in a release. Released features are in CHANGELOG.md.

## Next release

- **WooCommerce in one command.** `init --from woocommerce <store-url>` reads a store's public product API and
  writes `agent-entry.json` with `find`, `ask` and `hold`; `doctor` knocks each one.
- **A one-file WooCommerce plugin.** Installs like any plugin, signs the card on the shop's own key, answers
  `ask`, `find` and `hold`, and keeps pending holds in WordPress for the owner.
- **Ownership proof for directories.** `publish --claim` serves the proof file an index asks for, so a
  directory can confirm the door belongs to the site.
- **The owner's decision reaches the customer.** `decide <ref> approve|decline` answers a pending hold with a
  signed follow-up; the visiting agent collects it with the `track` verb.
- **Readable counts.** `counts` opens with whether logging is working, then who knocked in three confidence
  tiers (signed, declared, by network), what they asked, and who came back.
- **A cleaner `init`.** The converter for a third-party tool config is removed; `init` builds from trade
  starters, from WooCommerce, or (soon) from the site itself.

## Who is knocking

- The product token of an unrecognised User-Agent, kept locally, so the operator can name new agents.
- Cloudflare's verified-bot category and TLS fingerprint read from headers, as observation only.
- Organisation and reverse-DNS verification for agents whose operators publish them.
- A one-word agent label (`agent`, `agent_tier`) on every observation, so one analytics field answers
  "which agent".
- A page-side signal for agentic browsers (WebMCP present, automation present).

Throughout: the door identifies agent products, never people; no device fingerprinting; an address is used
for at most a day in memory and never written down.

## Where the counts go

- Several destinations at once (`teeSinks`).
- A built-in SQLite database (`sqliteSink`, no dependency) that `counts` can read.
- Any HTTP endpoint (`httpSink`).
- Adapters for widely used analytics services, each added only once it is tested.
- Per-tool success rate, P95 latency and sessions in `counts`.

## Turning a site into tools

- `init --scan <url>`: find a site's existing features (search, contact, booking, cart, order lookup) and draft
  the declaration for review; nothing is published from a draft.
- Framework detection and wiring for common web frameworks and WordPress.
- `doctor --browser`: load each page in a headless browser and call every tool as an agent would.
- A skill for coding agents to maintain `agent-entry.json`.
- Multi-step page actions, rollback and a diff before `publish`.

## Safety

- A per-address rate limit and an expiring blocklist, both explicit and documented.
- Unsigned visitors are answered only from templates, never by a model, unless the site opts in.
- A documented way to block a DID.
