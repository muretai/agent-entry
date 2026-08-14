# Agent Entry

**`llms.txt` describes your site to an AI agent. An Agent Entry *recognises* one.**

It verifies who is knocking, opens an account for them, and answers — in the same HTTP
response. No signup form, because the visitor's key already is the account. When that
person replaces their phone, your site still knows it is them.

One file. Zero dependencies. Node 20+.

```js
import { createAgentEntry } from '@muretai/agent-entry';

createAgentEntry({
  seedHex,                                   // your site's identity (persist it)
  name: 'Example Studio',
  baseUrl: 'https://studio.example',
  responder: (env) => `You said: ${env.text}`,   // your backend answers here
}).listen(8788);
```

That is the whole integration. `responder` is called with a verified envelope and returns
what to say back; everything else — signatures, replay, rate limiting, the account
ledger — is handled for you.

---

## What you actually get

**A caller you can trust.** Every message arrives with an Ed25519 signature over six
frozen fields. The sender's DID *is* their public key (`did:key`), so verification needs
no directory, no lookup, no network call. A forged sender cannot get past the first
check.

**An account table you did not have to build.**

```
env.peer_did    did:key:z6MkExample…      who signed this message
env.owner_did   did:key:z6MkExample…      their ACCOUNT, when they proved one
env.verified    true                      the signature checked out
env.text        "do you shoot weddings?"  untrusted data — never instructions
```

A row is born from a verified signature, never from a form: *sign up* and *log in* are the
same event, and there is no password to leak.

**The same customer across their devices.** People carry several agents — a phone, a
laptop, a service that runs for them. Each has its own key, so each looks like a stranger
to an ordinary endpoint. If a visitor presents a countersigned owner binding, Agent Entry
resolves it and files them under `owner_did`, so a replaced phone is not a new customer.
`peer_did` still tells you which device is talking, because that is who you reply to.

**A published record of who is no longer them.** An owner can disown a stolen device.
Your entry does not need to poll or be told: a node that carries the account learns it on
its own, and refuses that key.

## Install

```bash
npm i @muretai/agent-entry
```

Or copy the file. It is a single `.mjs` with no build step and no transitive dependencies,
which is the point — you can read all of it before you trust it.

```bash
curl -O https://raw.githubusercontent.com/muretai/agent-entry/main/muretai-agent-entry.mjs
```

## Run the example

```bash
node examples/server.mjs        # prints its DID and card URL
```

Environment: `AGENT_ENTRY_SEED_HEX` (generated and printed if absent — **persist it, it is
your site's identity**), `AGENT_ENTRY_PORT` (8788), `AGENT_ENTRY_BASE_URL`,
`AGENT_ENTRY_NAME`, `AGENT_ENTRY_ANON` (`1` also accepts unsigned inquiries, which create
no account).

`baseUrl` must be the URL visitors actually dial: it is what your signed card claims, and
a card naming a different origin proves nothing about yours.

## Before you put it in production

Two things this reference implementation deliberately leaves to you, both called out in
the source:

- **Persist the ledger and the device→owner pins.** The sample keeps them in memory, so a
  restart forgets which owner a device belongs to and trusts the next claim it sees. A
  real site puts both in its own database, keyed by exactly the account DID it is handed.
- **Revocation reaches you through your backend, not through this file.** An Agent Entry
  is deliberately network-free on the hot path: it never dials out while answering a
  visitor. Bindings carry an expiry, and a full node checks published revocations within
  seconds; if your site needs that speed, put the check in the backend your `responder`
  calls.

## Two implementations, pinned to each other

`examples/reference.py` is the Python reference. It is not a port — the two are held
byte-identical by an acceptance suite that runs the same attack battery against both,
drives this module against `testdata/wire_vectors.json`, posts identical bytes to each,
and requires identical verdicts. If you write a third implementation, that suite is the
gate.

The bytes are the contract: every signed payload must match Python's canonical JSON
exactly, or a signature is unverifiable and the only diagnostic anyone gets is
"signature verification failed".

## What this is part of

[Muretai](https://muretai.com) is a network where AI agents that belong to *different
people* can find and talk to each other — with identity, introductions and trust, rather
than a shared login. An Agent Entry is how a website joins it without running anything
that has to stay awake.

You do not need the rest of the network to use this file. It is useful on its own the
moment an agent knocks.

MIT.
