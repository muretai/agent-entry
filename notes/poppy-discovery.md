# Poppy discovery: the door publishes /.well-known/poppy.json

## Why

CMO request 652, ruled KEEP by Product as discovery only, owner go 2026-11-17. A Poppy 1.0 Personal Agent (https://personalagentprotocol.org/docs/1.0/spec) looks for a Company at https://{domain}/.well-known/poppy.json. This change lets a door publish that file for its shop, built from its own Agent Card and nothing else. No Poppy session, no auth, no Poppy conversation protocol.

## Design notes

- The document is built by a pure function, `poppyDocument(card, servedOrigin)`, from what the door already knows. No new copy: `organization.name` is the card's name, `organization.domain` is the host of the configured origin (with its port when the port is not 443), `agent.protocols` is one entry, and `web` is `{}`. The door serves `poppyDocument(card, origin)` with one difference: when no `description` was given explicitly it passes the card without its description, so the built-in copy is never published and there is no agent entry. An embedder calling the exported `poppyDocument` with a card that carries the built-in name or description gets them in the result, so it must pass its own.
- `organization.name` is the shop's own words only: `poppy: true` refuses to start without an explicit `name` (or with one that has no visible character: whitespace or invisible format characters only), because the card's built-in name is the software's, not the Company's display name (spec 3.1).
- The agent protocol type is `a2a`. Poppy 1.0 does not define it. Spec section 8.1: an agent skips agent protocol types it is not familiar with, and the only type the spec defines today is `poppy`. The entry's endpoint is the door's own HTTPS endpoint as the card states it (the JSON-RPC interface url, else the card's `url`), and its description is the card's description, but only when `createAgentEntry` was given an explicit, non-empty `description`.
- `web` is an empty object. It keeps the document valid (the spec requires at least one of `agent`, `apis`, `web`) for an agent that skips `a2a`, and when the agent entry is omitted: the door was given no explicit description (the card's built-in one is not copied) or an empty one.
- The door is never listed under `apis`: the spec defines two API types there, `openapi` and `mcp`, and agents skip API types they do not recognise; a door is neither.
- Every method other than GET and HEAD on the exact poppy path answers as the card route does (same status and `Allow`). With a query string the path is unknown and every method answers 404, byte for byte as an unknown path; with `poppy: false` the path is an unknown path for every method.
- Default OFF. The option is `poppy`, `true` or `false` only (anything else refuses to start, as for `trustProxy`). Nothing in the existing options made a default obvious, and publishing a new public file for every shop on upgrade is the maintainer's decision.
- The domain is the CONFIGURED origin (`baseUrl`), never the request's `Host`, `X-Forwarded-Host` or an absolute-form target. The document is built once at start, so nothing a request carries can move a byte of it, and nobody who can reach the process can make the shop claim another domain.
- HTTPS only. An `http://` origin, or a card endpoint that is not https, publishes nothing: the ordinary 404.
- The route matches the RAW request target byte for byte against `/.well-known/poppy.json`, at the host root whatever the mount. A query, a trailing slash, another case, an encoded or dot-segment spelling, and absolute-form or `//` targets get the door's existing 404. GET and HEAD share the card route's headers (`application/json; charset=utf-8`, Content-Length, CORS).
- The card's name and description are copied with lone surrogates replaced, control characters (C0, DEL, C1, U+2028, U+2029) removed, and cut to 200 and 800 code points; `<`, `>` and `&` are escaped in the served bytes. A 64 KiB name cannot bloat the file or break the JSON.
- `ownershipProof` with path `/.well-known/poppy.json` and `poppy: true` together refuse to start, so the two files cannot shadow each other.
- No new dependency, and no existing wire field, route or verdict changes: the card, tools and proof routes are pinned byte for byte by conformance/poppy.mjs.
- Tests: conformance/poppy.mjs and conformance/poppy-fuzz.mjs, both in package.json's test script.

## Open issues

- A hosted door that serves many shops on one hostname cannot use this route. The spec allows one poppy.json per host, naming one organization, so a multi-tenant host has no way to list each shop. Each shop needs its own host (or a subdomain whose door answers at its root).
- A door mounted below the root (`baseUrl: https://shop.example.com/support`) cannot serve the host-root path by itself. The README documents the one rewrite or redirect the site owner adds; the final path must be exactly `/.well-known/poppy.json` with no query, so a redirect to `/support/.well-known/poppy.json` does not work.
- `a2a` is not a Poppy 1.0 type. If a later Poppy version defines how a Company lists an A2A endpoint, the type string may need to change.
- Turning it on by default is left to the maintainer.
- Poppy fetches are not tallied or passed to the observer, unlike card fetches.
- Nothing guarantees that any agent recognises the `a2a` type.
- An empty `web` object is valid by implication only: the spec requires one of `agent`, `apis`, `web` and does not say an empty `web` is enough.

## Decisions

- Coordinator ruling (2026-11-17): absolute-form and `//` targets keep the door's existing 404 for the poppy path; the test author changed fuzz case (a) to accept it in 2ae2dc1.
