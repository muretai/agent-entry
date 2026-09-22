# Agent Entry for Muse — a custom-connector recipe

This page is written for Muse to read when its user says "build a custom connector for this
shop". It says how to reach any website that serves an Agent Entry, from the user's own Muse
VM, with one command. It is **documented for Muse, not tested in Muse**: the command is
covered by this package's conformance suite on an ordinary machine, but no Muse account has run
it yet.

## What it is

- **Package:** `@muretai/agent-entry` on npm. Node 20 or later, zero dependencies.
- **Base URL:** there is none to configure. Every shop publishes its own Agent Card, for example
  `https://shop.example/.well-known/agent-card.json`, and that URL is the only input.
- **Transport:** public HTTPS to the shop's own origin. Nothing runs on localhost and no Muretai
  service sits in between.

## Auth

There is no account, no API token, no OAuth flow and no registration. Auth is an Ed25519
signature on every message: the command keeps one private key on the VM, signs each message
with it, and the shop recognises the key's `did:key` as the customer. The first knock is the
account.

The key lives at `~/.config/muretai-agent-entry/knock-seed`, created mode `0600` on the first
run. That file **is** the user's account at every door that has ever answered them, so:

- keep it on the VM's durable storage; a new file is a new, unknown customer everywhere;
- never print it, paste it into chat, or copy it into a prompt, a note or a connector setting;
- never create or edit it by hand. A corrupt or unreadable file makes the command stop with an
  error before anything is sent; it is not replaced.

Custody trade-off: the seed is a file on the VM, not a secret in Muse's
Secure Credentials Store, so it is not surrogated. Whoever can read that file can knock as this user. That is the
price of one key per person with no service in the middle.

## The call

```bash
npx @muretai/agent-entry knock https://shop.example/.well-known/agent-card.json
```

The command fetches the card and verifies its signature against the URL, signs a
`message/send`, verifies the shop's signed reply, and prints the result. With no message given
it sends the first example the shop's card lists. To choose the message:

```bash
AGENT_ENTRY_KNOCK_TEXT='Table for four on Friday at 20:00?' \
  npx @muretai/agent-entry knock https://shop.example/.well-known/agent-card.json
```

## Ask the card which verbs the shop offers

Before knocking on the user's behalf, ask the shop's card what a customer can do there. A shop
that publishes an `agent-entry.json` declaration lists its offers in the card's `skills[]`, one
skill per offer. Each skill's `id` is the verb and the thing it acts on, `verb_of` (`find_products`,
`hold_item`, `book_table`, `ask_anything`). Its `tags` start with the verb, and its `examples` are
messages the shop has promised to answer. Match the user's intent against the verb, not the
wording. The verbs are the same at every shop: `find`, `ask`, `quote`, `book`, `hold`, `order`,
`buy`, `track`, `change`, `cancel` and `join`.

For example, for the card at `https://shop.example.com/.well-known/agent-card.json`:

```json
{"id": "hold_item", "name": "hold_item", "description": "Hold one lamp for pickup within 48 hours.",
 "tags": ["hold", "item"],
 "examples": ["Hold one lamp for pickup within 48 hours.", "hold item {\"sku\":\"<string>\"}"]}
```

- Tell the user which verbs the shop offers before you act, and knock only for the one they
  chose.
- Put that skill's example, filled in with the user's details, in `AGENT_ENTRY_KNOCK_TEXT`.
- A verb that changes something (`book`, `hold`, `order`, `change`, `join`) or pays (`buy`) needs
  the user's yes first. `buy` never takes payment at the door: the reply carries the shop's own
  checkout URL, which you show the user.
- A card with no skills, or skills without a registry verb, is a shop that has not declared its
  offers. Knock with the user's words.

`knock` sends the text only. It does not yet set `metadata.offer`, the field a door uses to pick
one offer by its id. So the shop's own responder reads the message and decides which offer it
is.

## Reading the answer

On success the command exits 0 and prints one JSON object on stdout. When the shop's verified
reply is a booking, it is exactly these keys:

```json
{"type": "restaurant_reservation_request", "customer_did": "did:key:z6Mk…", "request": "Table for four on Friday at 20:00?", "status": "pending_shop_confirmation"}
```

- `type` — what the shop recorded.
- `customer_did` — this user at this shop. It is the same on every knock from the same VM, and
  the same at every shop. Tell the user who they are to the shop by this value, not by the key.
- `request` — the message the shop received.
- `status` — where the request stands on the shop's side.

Any other verified reply is printed as the shop's text.

## When the door refuses

On a refusal the command exits non-zero, prints nothing on stdout, and writes to stderr:

```text
Refused (<JSON-RPC code>): <the door's message>
- Use an Ed25519 did:key …
- …
```

The first line is the JSON-RPC error code. The lines after it are the door's `data.accepts`
translated into plain instructions: which DID and signature it takes, which fields are signed,
who the recipient is, the clock rule, and where to POST. Read them, repair, and knock again. A
rate-limit refusal is repaired by waiting, not by a new key. Never answer a refusal by deleting
the seed: that throws the user's account away.

## Rules for the connector

1. One command, one card URL. Do not import the package's internals or rebuild the signing.
2. Only knock on cards the user asked for.
3. Keep `~/.config/muretai-agent-entry/knock-seed` where it is, and never show its contents.
4. Show the user `customer_did` and `status`; they are safe to share.

## Not covered here

These are named, not built: a `connector` kind in the card's `agentEntry.prefer` list, a
`.well-known` connector pointer, an OpenAPI description of the door, and a Host-side "knock on
my behalf" Bearer connector (planned after the pilot shop). Nothing on this page is submitted to
Muse's connector directory.
