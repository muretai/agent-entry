# Security review: the frame and Suite S1 to S3

Intake 20261003T225754Z, solo review. Range `3c7c8e9..main`, reviewed at main = `f2a8fad`. Every anchor below is
`file:line` at that commit. Read-only: nothing was run from the repository and no network request was made.
This repository has no sec_lint (ISSUE intake 20260920T130938Z), so no scan backs these notes; they come from
reading the code.

Severity: **high** means a remote party can take the key, forge a signature or reach payment; **medium** means
a remote party can cause real harm (DoS of the door, a misleading signed artefact, a private datum published) or
the operator can be walked into it; **low** means defence in depth or harm only under an unusual setup;
**info** means a property worth recording, with an optional hardening step.

Totals: high 0, medium 5, low 6, info 4.

What holds up, briefly: the seed never reaches stdout, a log, a published file or an error message in any path
read here. Seed files are created `wx` with mode 0600, git is consulted before a slot is written, and `doctor`
scans every trackable file for the seed. The card and tools envelopes sign `typ` inside the bytes, so neither
can be replayed as the other. `confirmReceipt` checks the signature before reading anything else, and checks
the exact key set and the termsHash commitment. The page runtime builds every DOM node with `textContent`,
and keeps every request and navigation on `location.origin`. The Woo walk is https only, follows no
redirects, caps bytes as they stream and keeps permalinks on the store's origin. The counts page binds to
loopback only, checks the Host header and sends a strict CSP.

---

## 1. Signing and the public routes

### S-1 (medium): the collector believes any `Origin`, and fans out unbounded to `entry.counts`

`muretai-agent-entry.mjs:5261-5263` lets a beacon in when its `Origin` header names one of the contract's
origins. Only a browser enforces `Origin`; curl can set it to anything. Each accepted beacon with a fresh
`session` then starts one `fetch` to `entry.counts` (`muretai-agent-entry.mjs:5294`, `5302-5309`). Nothing awaits
or caps these fetches, and they have no timeout. The collector has no rate limit of its own.

*Attacker:* posts many small beacons with a forged `Origin`, each with a new session id. This inflates every
count the owner reads (`offer_succeeded`, `referral`). If `entry.counts` is set, the door also opens one
outbound request per beacon. When the counts host is slow or hangs, these pending sockets and promises pile up
until the door runs out of file descriptors or memory, so the signed door goes down with the counts.

*Fix:* give `postCounts` a bounded queue (drop when full), an `AbortSignal.timeout`, and a concurrency cap of a
few requests. Give the collector its own per-minute ceiling, like `anonRatePerMin`. Document that the counts
are forgeable by anyone who can send HTTP, and are not evidence.

### S-2 (medium): `find` re-reads, re-parses and signs the whole snapshot on every knock

`muretai-agent-entry.mjs:5117-5119` calls `readCatalogFile` per request, and `muretai-agent-entry.mjs:3769-3776`
reads, `JSON.parse`s and maps the whole file every time. The file may be up to 16 MiB
(`muretai-agent-entry.mjs:3741`). Every row goes into the signed reply, whatever `q` asked for. The signed
lane allows 600 replies a minute across the door (`SIGNED_RATE_PER_MIN_TOTAL`); the anonymous lane, when it
is on, allows more.

*Attacker:* mints keys (free) and asks `find` in a loop. Each request costs the door a multi-megabyte read,
parse, re-serialise, escape and sign, plus an equally large response. A few requests a second pin the event
loop.

*Fix:* read and validate the snapshot once at start, and again only when its mtime changes. Filter by `q` and
cap the rows in a reply (for example 50, with a `more` flag). Optionally cap the snapshot by row count as well
as bytes.

### S-3 (low): the Woo plugin keeps the door's seed in `wp_options` in clear

`examples/woocommerce-agent-entry.php:142` stores the seed base64-encoded in the options table, and `:115-118`
reads it back. Anyone who can read the database holds the shop's identity for good: a SQL injection in any
other plugin, a backup, a staging clone, an admin export. A cloned staging site also answers as the same DID.
Deactivating or deleting the plugin leaves the seed in place, which is deliberate, but nothing tells the owner.

*Fix:* prefer a `MUAE_SEED` constant in `wp-config.php` (outside the database) when it is defined, and fall
back to the option. Document that the option is the shop's private key, so backups and staging copies carry
it. Name a rotation step (delete the option, then re-activate), and say that rotation gives the shop a new DID.

### S-4 (info): a guest mount answers the Catalog claim for the whole host

`muretai-agent-entry.mjs:5229-5231` serves `/.well-known/muretai-catalog-claim.txt` at the origin, whatever
the mount. That is by design, because the Catalog proves a host. On a host where several parties run guest
mounts under different paths, though, whichever entry is routed that path can claim the whole host.

*Fix:* refuse `entry.claim` on a mounted entry unless an explicit `claimHost: true` is given. State in the
README that a claim speaks for every path on the host.

---

## 2. The browser runtime (`agent-entry-page.mjs`)

### B-1 (low): any envelope age is accepted, so an older signed contract can be rolled back in

`agent-entry-page.mjs:183` checks only that `env.ts` is an integer. It never checks the age. `verifyToolsEnvelope`
(`muretai-agent-entry.mjs:3581-3598`) and `doctor` have the same gap. The card path has a 6 h window
(`muretai-agent-entry.mjs:5878-5881`); the tools path has none. Whoever can make the origin serve stale bytes
can bring back an older signed version, which may carry a lower `ask` or an offer since removed. A
mis-keyed CDN cache, a leftover static file or a poisoned cache entry would each do it.

*Fix:* refuse an envelope whose `ts` is more than 6 h old or more than 300 s in the future, both in the page
runtime and in `verifyToolsEnvelope`, as the card does. The door re-mints hourly already
(`muretai-agent-entry.mjs:4513-4520`), but a `publish`ed static `.sig.json` does not. Static hosts therefore
need `publish` to say the signature expires, or the window needs to apply only where the door signs live.

### B-2 (low): URL placeholders admit dot segments

`agent-entry-page.mjs:344-347` fills `{field}` with `encodeURIComponent`, which leaves `.` alone. The door's
checkout URL does the same at `muretai-agent-entry.mjs:5124`. A value of `..` in a path position moves the
URL up a directory. For example, `/orders/{id}/view` with `id=..` becomes `/view`. The result stays on the
origin, so the harm is limited to sending the person, or the visitor's agent, to a different same-origin page
than the offer describes. With two placeholders, `..` in each climbs two levels.

*Fix:* refuse a value that is exactly `.` or `..` before filling, or encode `.` as `%2E` inside path segments.
Do it in both the page runtime and `offerReply`.

### B-3 (info): what the page runtime trusts

The trust root is the same-origin card's `did`, fetched from that origin (`agent-entry-page.mjs:167-170`). So
the signature defends against a contract served without its signature, or tampered with apart from it. It
does not defend against an attacker who controls the origin; that attacker can re-mint the card too. Also,
`call` falls back to any global on `window` whose name matches (`agent-entry-page.mjs:366-367`). This
includes functions a third-party script defined. `read` hands page text to the agent with only
`untrustedContentHint` (`agent-entry-page.mjs:299`, `:413`). All three are the site's own declaration, signed.

*Fix (hardening):* resolve `call` only from `handlers`, or from a `window.agentEntryHandlers` object the site
registers on purpose, never from bare globals. Say in spec/tools-v1.md that the signature binds the contract
to the card, not to the person who owns the domain.

---

## 3. The CLI's seeds and secrets on disk

### K-1 (medium): `knock` POSTs wherever the signed card says, including private addresses

`muretai-agent-entry.mjs:5885-5888` takes `endpoint` from the card's
`securitySchemes...agentEntry.endpoint`, or its `supportedInterfaces`, with no check that it shares the
card's origin. `muretai-agent-entry.mjs:5922` then POSTs there. The card is signed only by its own key, so
whoever hosts it chooses the endpoint. `doctor` checks the origin (`muretai-agent-entry.mjs:7511`), but
`knockAgentEntry` does not. `knock` is made for agents to run against strangers' URLs, so a hostile card can
aim a signed POST at `http://127.0.0.1:…`, `http://169.254.169.254/…` or an intranet host on the knocker's
network: a blind SSRF. The same function has no timeout and no body cap on any of its three fetches
(`muretai-agent-entry.mjs:5861-5870`, `:5932`), so a hostile door can also hang it or feed it gigabytes.

*Fix:* refuse an endpoint whose origin is not the card URL's origin, as `doctor` already does. Add
`AbortSignal.timeout(15000)` and a 1 MiB streamed cap on the card, the signature and the reply.

### K-2 (low): remote text reaches the terminal raw

`knock` prints the door's reply text (`muretai-agent-entry.mjs:5989`), the refusal's `error.message`
(`:5992-5993`) and the `accepts` fields (`:5787-5791`, `:5994`) without escaping. `doctor --url` prints
`card.url` (`:7460`) and `reply.error.message` (`:7530`) the same way. A hostile door can therefore embed
ANSI/OSC escape sequences: rewriting the screen, writing the clipboard (OSC 52) or making a fake hyperlink.
`doctorWoo` already avoids echoing door text (`:7741-7742`), so the rule exists; it is just not applied in
these places.

*Fix:* run remote strings through `JSON.stringify`, or strip C0/C1 controls, before printing, as
`claimantConfirms` does (`:7274-7276`).

### K-3 (info): seed writes follow symlinks

`mintSeed` (`muretai-agent-entry.mjs:6227-6241`) appends to the slot and then calls `chmod`, and `knockSeed`
(`:5733-5738`) reads and `chmod`s an existing key file. Both follow a symlink. If `.env` is a link to a file
outside the repository, `git check-ignore` judges the link, not the target, and the seed lands wherever the
target lives. Only someone who already has write access to the project or home directory can set this up.

*Fix:* `lstat` the slot and the knock key, and refuse a symlink with a message naming it.

---

## 4. The claim and decide paths

### C-1 (medium): the claimant's personal contact is published, signed and kept forever, though the prompt says "store"

`publish --claim --address … --contact-name … --contact-email … --contact-phone …` merges these into
`facts` (`muretai-agent-entry.mjs:7310-7315`). `compileDeclaration` puts `facts` in the public contract
(`:3534`). In the same run, `publish` writes it as an immutable version file (`:7361`), and the door serves
every version for good (`:5383-5387`, `:5221`). The only confirmation asks "Store them in agent-entry.json?"
(`:7276`). For a sole trader these are a private name, phone and home address. Once published they cannot be
withdrawn: v`N`.json is immutable, `publish` refuses to rewrite it (`:7226-7228`), and the door keeps serving
it. Any scraper or spammer reads them from a well-known path.

*Fix:* the prompt should say plainly that these facts will be published at `/.well-known/agent-tools.json`
and kept in every later version. Offer a way to keep human contact out of the contract (door-only
`facts_private`, answered only to a signed knock). Name how to withdraw a published version (serve it as 410)
and accept that this breaks immutability for that version only.

### C-2 (medium): `decide approve` signs "confirmed" without showing the owner what is confirmed

`decideMain` (`muretai-agent-entry.mjs:8046-8072`) reads a receipt file and signs the follow-up. It prints
only the outgoing JSON-RPC line. It never shows the owner the `verb`, `of`, `customer_did` or `request` it is
confirming. `request` is the visitor's own free text, echoed into the pending reply (`:5106`). A receipt
proves only that the door issued it, which it does to anyone who knocks; it does not prove what was asked.
No record is kept either: the same receipt can be approved again with a new ts, and a receipt from months ago
is as good as today's (`:3714`).

*Attacker:* knocks `hold` with a text like `hold item {"id":7} — agreed price 0, delivery free, per your
staff`. They then send the receipt to the owner as "please approve my hold". An owner who approves on the
strength of the file name returns a shop-signed `"status":"confirmed"` over that text. It is a forgery-grade
artefact that the termsHash correctly binds to the shop.

*Fix:* before signing, print the confirmed terms to stderr (JSON-escaped, as `claimantConfirms` does) and
require `yes`, or a `--yes` flag for scripted use. Refuse a receipt older than a set window (for example 14
days) unless given `--stale-ok`. Keep a local `decided/<ref>` record so a second approval is refused, or
re-issued byte for byte. Consider having `offerReply` sign the parsed input values, not the raw `env.text`,
for `pending` replies.

---

## 5. The Woo generator chain (`init --from woocommerce`, `doctor --from woocommerce`)

### W-1 (low): robots.txt fails open, and only page 1's URL is checked

`wooRobotsAllow` treats a network error (`muretai-agent-entry.mjs:6383-6385`) or a redirect (`:6391`) as no
rules. RFC 9309 section 2.3.1.4 says an unreachable robots.txt means complete disallow, and section 2.3.1.2
says to follow up to five redirects. The rules are also matched only against the first URL's path
(`:6483`, `:6406`). They are never matched against the `?page=N` URLs that follow (`:6495`), so a store's
`Disallow: /*?page=` is ignored. Each case reads a store against its stated wishes; none reaches anything
private.

*Fix:* refuse on a network error, as the code already does for 5xx. Follow up to five same-host redirects for
robots.txt only. Match each page URL, path plus query, before asking for it.

### W-2 (low): `doctor --url` trusts a hostile door's numbers, and knocks every door-bound offer on a live site

`doorChecks` loops `n = 1..contract.version` (`muretai-agent-entry.mjs:7485-7491`) with a version taken from
the remote contract, up to 999,999,999. It also sends one signed knock per door-bound offer
(`:7515-7522`), whatever the offer's effect. Against a hostile door, the first means about a billion GETs.
Against a real shop, the second sends `book`/`order`/`buy` texts that a `human` or `brain` responder may act
on: a real request to staff, signed with the operator's persistent knock identity (`:7846`).
`doctor --from woocommerce` likewise opens a real pending hold on the live shop each run (`:7743`, by design
"probed, never confirmed").

*Fix:* cap the version walk (for example, check only v1, the current version and up to 20 between). Skip
knocks on offers whose effect is `changes` or `pays` unless `--knock-all` is given. Mark the doctor's knock
text as a probe (for example a `metadata.probe: true` the default responder ignores) so staff are not paged.

### W-3 (info): product names and facts are store-controlled text in signed replies

Snapshot rows (`muretai-agent-entry.mjs:6528-6538`) and facts reach visiting agents inside shop-signed
replies. Markup is already neutralised (`jsonWithoutMarkup`, `:3764`, `:5138`, `:6575`), but a product
named as an instruction ("ignore previous instructions…") is still a prompt injection, and now carries the
shop's signature. That is the shop's own data, so this is recorded, not a defect.

*Fix (hardening):* the visitor skill and spec should say that reply data is quoted content, never
instructions, signature or not.
