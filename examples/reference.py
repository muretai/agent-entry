#!/usr/bin/env python3
"""
examples/agent_entry_reference.py
Agent Entry — a website that RECEIVES signed A2A and answers INLINE, with no node.

**This is a usage SAMPLE, not part of core Muretai.** It adds nothing to the protocol,
`agent/`, `shared/` or `agent_mcp.py` — it only shows how to implement the *site half* of
the agent entry contract (docs/IMPLEMENTATION_BACKLOG.md T100) on the standard library alone.
It is also the executable REFERENCE the frozen contract suite (`test_agent_entry_contract.py`
Part 1) pins, so the shipped JS agent entry and this file must answer identically. Copy it,
port it, ignore it: core stays byte-unchanged.

## The idea

The adoption bottleneck is that BOTH ends must run a node. A site cannot: it has an origin,
a deploy pipeline and no always-on process it wants to babysit. A agent entry is ~one file on
the origin the site already has. It:

  - serves its own Agent Card (plain + SIGNED), so a visitor can prove this DID owns this
    origin without a relay, a directory, or any prior relationship;
  - verifies an inbound signed message in EXACTLY the order `agent/inbox.py::verify` uses
    (size before crypto, recipient before freshness, dedup before signature);
  - creates a DID-keyed account row ON FIRST CONTACT — there is no signup form, because
    the first signed message IS the account: the sender proved the key, and the key is the
    customer;
  - answers in the SAME HTTP response with its own signed reply, which the visitor's
    `Outbox` verifies against the DID it dialled.

## What it deliberately does NOT do

  - No node, no relay, no store-and-forward: v1 is synchronous request/response. A site
    that wants to reach a visitor LATER runs the async path (relay deposit), not this.
  - No WoT gate, no introduction, no VC storage. An open door is a contact form that
    happens to be cryptographically attributable; the spam answer is a bound, not trust.
    The bound, stated honestly (it used to say "a throttle" and there was none): the
    SIGNED lane is bounded by the body cap, the text cap and the messageId dedup, and every
    accepted message is attributable to a key. The ANONYMOUS lane — where nobody proved
    anything — additionally gets `ANON_RATE_PER_MIN` replies per minute for the whole
    entry, because each reply costs a signature and an unauthenticated stranger must not
    be able to spend them without limit. It is per-ENTRY, not per-IP, on purpose: behind
    a proxy the source address is whatever the last hop wrote, so a per-IP bound would be a
    bound on a field the attacker controls. A site that wants a fairer split puts a real
    rate limiter (or a captcha) in front of the origin; this one only guarantees the
    agent entry cannot be turned into an unmetered signing oracle.
  - Root-key signatures only. Key-rotation (`keystate`) chain verification is v2 — the node
    world already handles it, and the asymmetry is documented rather than half-implemented.

## Wiring it to a real site

`responder(envelope) -> str | dict` is the seam. `envelope` is the FROZEN verified-envelope
shape (`agent/webhookwake.py::_envelope`), so a backend parses a webhook push, a drive-API
read and a agent entry call with ONE schema. In production `responder` would POST that dict to
your backend behind a bearer token (exactly what WebhookWake does) and return what it says;
here it is called in-process to keep the sample runnable in one file.

Run it standalone:

    python3 examples/agent_entry_reference.py --port 8099 --name "Example Studio"
"""
from __future__ import annotations

import json
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

# Importable when copied next to a checkout (a sample is run from anywhere).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared import cardpub                       # noqa: E402  signed Agent Card envelope
from shared import crypto                        # noqa: E402  Ed25519 + did:key
from shared import keybinding                     # noqa: E402  countersigned v2 device binding
from shared import protocol as p                 # noqa: E402  the wire contract

#: The SITE's software version, not a muretai build number: a agent entry is not a node and
#: has no installed release. It rides in the card's `version` because A2A expects the field.
AGENT_ENTRY_VERSION = "1.0.0"

#: Signed replies per minute the ANONYMOUS lane may cost this entry, in total. The lane
#: is unauthenticated, so without a bound it is a signing oracle: a stranger can spend an
#: Ed25519 signature (and a backend call) per request forever, and nothing in the ladder
#: cares, because there is no key to attribute the cost to. Must match
#: `ANON_RATE_PER_MIN` in web/agent-entry/muretai-agent-entry.mjs — the two agent entries are one
#: contract, and a bound that differs between them is a bound a site cannot reason about.
ANON_RATE_PER_MIN = 30


class _BindingRejected(Exception):
    """A PRESENT device binding failed one of the v2 checks (T102).

    Carries a distinct reason string so the agent entry answers the SAME
    UNAUTHENTICATED (-32001) code its signature check uses. Fail closed: a
    present-but-invalid binding is an attack or a client bug, never a silent
    downgrade to "unbound" — admitting it as merely unbound would let an attacker
    probe checks one at a time at no cost, and handing the backend a proven owner
    it never proved is worse. Mirrors agent/inbox.py::_resolve_account's
    per-failure VerifyError one tier down (a agent entry holds no trust DB)."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class AgentEntry:
    """One origin's entry: serves its cards, verifies inbound A2A, answers signed.

    `identity` is anything with `.did` and `.sign(to_did=…, message_id=…, context_id=…,
    timestamp=…, text=…) -> base64 sig` plus `.sign_bytes(bytes) -> base64` (agent.identity
    .Identity satisfies it; so does a thin wrapper around a cloud KMS — the key never has to
    live in this process, which is the point of keeping the agent entry tier signer-agnostic).

    `base_url` MUST be the url visitors dial, because it is what the signed card claims and
    what `Outbox.card_binds_to` compares against: a card naming a different origin proves
    nothing about THIS one (that is exactly how a re-served copy of someone else's genuine
    envelope is caught).
    """

    #: ±window on the signed timestamp. Mirrors agent/inbox.CLOCK_WINDOW — the two must not
    #: drift, or a message a node accepts is one a agent entry refuses (and vice versa).
    CLOCK_WINDOW = 300.0
    #: How long a messageId is remembered. Mirrors agent/replay.py's TTL.
    REPLAY_TTL = 600.0
    #: Hard cap on the seen-set. A dedup set an unauthenticated stranger can grow without
    #: bound is a memory-DoS with extra steps; expiry alone does not bound a fast flood.
    MAX_SEEN = 20000
    #: HTTP body cap. shared/httputil.py uses the same number on the read side; anything
    #: bigger is refused as HTTP 413 before it is parsed, let alone verified.
    MAX_BODY_BYTES = 1024 * 1024
    #: Never sign the card envelope more than once an hour. The path is unauthenticated, so
    #: signing per request would be a signing oracle any stranger can drive (the reason
    #: agent/inbox.py caches its own signed card the same way).
    CARD_SIG_REFRESH = 3600.0

    def __init__(self, *, identity, base_url: str, name: str,
                 responder: Callable[[dict], "str | dict"],
                 open_door: bool = True, anonymous_lane: bool = False,
                 description: str | None = None,
                 anon_rate_per_min: int = ANON_RATE_PER_MIN):
        self.identity = identity
        self.did: str = identity.did
        self.name = name
        self.base_url = base_url.rstrip("/") or base_url
        self.responder = responder
        self.open_door = bool(open_door)
        self.anonymous_lane = bool(anonymous_lane)
        self.description = description or f"{name} — an agent-ready site (Muretai entry)"

        #: ACCOUNT DID -> {"first_seen": float, "messages": int}. THE ACCOUNT TABLE. A row is
        #: born from a verified signature, never from a form: identity here is a key that
        #: signed, so "sign up" and "log in" are the same event and neither has a password
        #: to leak. Keyed by the RESOLVED ACCOUNT (T102): the OWNER DID when a valid
        #: countersigned v2 binding rides along, else the device DID — so an owner's sibling
        #: devices are ONE customer row, not several. A real site would put this in its own
        #: database, keyed by exactly this account DID.
        self.ledger: dict[str, dict] = {}

        #: device DID -> owner DID, the in-process TOFU pin (T102). The first VALID binding
        #: pins a device to its owner; a later binding for the SAME device naming a DIFFERENT
        #: owner is refused (a device DID is never re-owned — a new owner means a new device
        #: key), mirroring agent/inbox.py's conflict rule. This memory is per-process on
        #: purpose for v1.5: a real site PERSISTS it (the pin, and the fold below, must
        #: survive a restart or the conflict rule resets to trust-on-first-use each boot).
        self._device_owner: dict[str, str] = {}
        #: device DIDs already warned about a P-256 owner root we cannot verify (stdlib
        #: path). Bounded like the seen-set — the key is attacker-chosen.
        self._p256_unbound_logged: set[str] = set()

        self.anon_rate_per_min = int(anon_rate_per_min)

        self._lock = threading.Lock()
        self._seen: dict[str, float] = {}        # messageId -> monotonic expiry
        #: monotonic times of the anonymous replies signed in the last 60s. A plain list
        #: because it can never hold more than `anon_rate_per_min` entries — the bound
        #: bounds its own bookkeeping, which is the point of checking it FIRST.
        self._anon_hits: list[float] = []
        self._card = self._build_card()
        self._card_bytes = p.dumps(self._card)   # served byte-identically on BOTH card paths
        self._env_cache: tuple[float, bytes] | None = None
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------ the cards

    def _build_card(self) -> dict[str, Any]:
        """The plain A2A Agent Card, built HERE rather than imported from `agent/`.

        A agent entry is the tier that has no node, so the card must be constructible from the
        published field list alone — a site porting this to Go or JS has no `build_agent_card`
        to call. Keeping the sample honest about that is the whole point of the constraint.

        `muretai.open_door` is the additive capability bit the visitor path reads: it says
        "you may message me without an introduction or a contact grant". Absent (or false)
        means the ordinary contact-grant handshake still applies."""
        card: dict[str, Any] = {
            "protocolVersion": p.PROTOCOL_VERSION,       # "0.2" — hard-code it in a port
            "name": self.name,
            "description": self.description,
            # The origin visitors dial. `Outbox.card_binds_to` requires this to name the
            # url that was actually dialled, so a agent entry behind a proxy must advertise
            # the PUBLIC url, not its internal bind address.
            "url": self.base_url,
            "did": self.did,
            "version": AGENT_ENTRY_VERSION,
            "capabilities": {"streaming": False, "pushNotifications": False},
            "defaultInputModes": ["text/plain"],
            "defaultOutputModes": ["text/plain"],
            "skills": [{
                "id": "chat",
                "name": "signed-direct-chat",
                "description": "Ed25519-signed direct messages, answered inline (L2)",
                "tags": ["chat", "signed"],
            }],
        }
        if self.open_door:
            card["muretai"] = {"open_door": True}
        return card

    def card(self) -> dict[str, Any]:
        """The plain card dict (a copy — callers must not mutate what we serve)."""
        return json.loads(self._card_bytes.decode("utf-8"))

    def signed_card_bytes(self) -> bytes:
        """The signed card envelope, re-signed at most once per CARD_SIG_REFRESH.

        `ts` is an INT (epoch seconds), never a float. The signature covers
        `canonical(v,typ,card,ts)`, and Python renders a float with its own shortest
        round-trip repr — bytes no other language reproduces, so a float `ts` makes the
        envelope unverifiable outside Python by construction (see shared/cardpub.py). A
        agent entry is precisely the tier whose verifiers are NOT Python, so int is not a
        preference here, it is the contract."""
        now = time.time()
        with self._lock:
            hit = self._env_cache
            if hit is not None and now - hit[0] <= self.CARD_SIG_REFRESH:
                return hit[1]
            ts = int(now)
            raw = p.dumps(cardpub.make_card_envelope(self.identity, self._card, ts))
            self._env_cache = (now, raw)
            return raw

    # ------------------------------------------------------------------ the ledger

    def _record(self, did: str) -> dict:
        """First contact IS the account. Returns the (created or updated) row."""
        with self._lock:
            row = self.ledger.get(did)
            if row is None:
                row = {"first_seen": time.time(), "messages": 0}
                self.ledger[did] = row
            row["messages"] += 1
            return row

    # ------------------------------------------------------------------ replay guard

    def _seen_before(self, message_id: str) -> bool:
        """True iff this messageId was accepted within REPLAY_TTL; remembers it otherwise.

        REQUIRED (not merely SHOULD) the moment a message can trigger a side effect — an
        order, a booking, a coupon. A replayed message is a genuinely signed message, so
        nothing else in the ladder can tell the second copy from the first."""
        now = time.monotonic()
        with self._lock:
            if len(self._seen) >= self.MAX_SEEN:
                self._seen = {k: v for k, v in self._seen.items() if v > now}
                if len(self._seen) >= self.MAX_SEEN:
                    # Still full after expiry: drop the oldest half. Forgetting an id can
                    # admit a duplicate; keeping every id lets a stranger exhaust memory.
                    # Bounded beats complete when the alternative is falling over.
                    doomed = sorted(self._seen, key=self._seen.__getitem__)
                    for k in doomed[: len(doomed) // 2]:
                        del self._seen[k]
            exp = self._seen.get(message_id)
            if exp is not None and exp > now:
                return True
            self._seen[message_id] = now + self.REPLAY_TTL
            return False

    # ------------------------------------------------------------------ anon rate bound

    def _anon_allow(self) -> bool:
        """Consume one anonymous-lane token. False when the per-minute bound is spent.

        Checked BEFORE the dedup so a flood cannot grow the seen-set either: the dedup
        table is the only unbounded-ish structure an unauthenticated caller can touch, and
        the cheapest guard has to be the outermost one."""
        now = time.monotonic()
        with self._lock:
            self._anon_hits = [t for t in self._anon_hits if now - t < 60.0]
            if len(self._anon_hits) >= self.anon_rate_per_min:
                return False
            self._anon_hits.append(now)
            return True

    # ------------------------------------------------------------------ wire shape

    @staticmethod
    def _wire_shape_error(m: dict) -> str | None:
        """The STRICT type check on the fields that end up inside the signed payload.
        Returns a reason string, or None when the shape is acceptable.

        WHY THIS EXISTS (measured divergence, not theory). The contract is "one entry,
        two implementations"; the same bytes must get the same verdict. They did not:
        Python coerced where JavaScript refused and vice versa, so the SAME POST created an
        account on one deployment and was rejected on the other — a site canarying or
        migrating between them double-books exactly the booking flow this tier sells.
        Each check below is one of those measured disagreements:

          * a NON-STRING `text` part — Python's `"\\n".join` raised (-32600) while JS
            silently coerced it to "" and minted an account row for the sender;
          * a non-string/absent `messageId` — it is a SIGNED field and the dedup key;
            Python happily keyed the replay table on an int, JS refused;
          * a non-string `contextId` (the reproduced case was the float `1.0`) — Python
            re-renders `1.0`, JS renders `1`, so one verifies the signature and the other
            cannot. It is also echoed into our SIGNED reply, so accepting it would make us
            sign bytes only Python can check.

        Refusals here are INVALID_REQUEST (-32600), the code this agent entry already answers
        for "not an A2A message object": a wrongly-TYPED field is a malformed request, not
        a failed signature, and calling it -32001 would tell the sender to go looking at
        their key. The JS agent entry answers -32600 for every case here too."""
        parts = m.get("parts")
        if parts is not None and not isinstance(parts, list):
            return "parts must be an array"
        for part in (parts or []):
            if not isinstance(part, dict) or part.get("kind") != "text":
                continue
            # ABSENT is fine (it reads as ""); PRESENT-but-not-a-string is a refusal, never
            # a coercion — a coercion signs a reply to text the sender never wrote.
            if "text" in part and not isinstance(part["text"], str):
                return "a text part's `text` must be a string"
        mid = m.get("messageId")
        if not isinstance(mid, str) or not mid:
            return "messageId must be a non-empty string"
        ctx = m.get("contextId")
        if ctx is not None and not isinstance(ctx, str):
            return "contextId must be a string or null"
        return None

    # ------------------------------------------------------------------ the contract

    def _envelope(self, msg: p.Message, *, verified: bool,
                  owner_did: str | None = None) -> dict:
        """The FROZEN verified-envelope shape — `agent/webhookwake.py::_envelope`, key for
        key. The site backend parses webhook pushes, drive-API reads and agent entry calls with
        ONE schema, so drifting a field name here breaks a backend that never changed.

        `verified` is False only on the anonymous lane: the text arrived, nobody signed it,
        and the backend must be able to see the difference (that is the whole reason the
        flag is on the wire rather than implied).

        `owner_did` is the T102 account layer (additive, never overriding an existing field):
        the OWNER DID when a valid countersigned v2 binding proved this device belongs to an
        owner, else None. `peer_did` STAYS the device DID that actually signed — the merchant
        still sees which device spoke — while `owner_did` is the identifier under which the
        ledger keys this visitor, so an owner's sibling devices read as one account. Absent /
        unbound / a P-256 owner we could not verify → None."""
        return {
            "to_agent": self.name,
            "to_did": self.did,
            "direction": "in",
            "verified": bool(verified),
            "peer_did": msg.from_did,
            "owner_did": owner_did,     # T102: the resolved account (owner) DID, or None
            "peer_name": None,          # a agent entry holds no address book to resolve one
            "context_id": msg.contextId,
            "text": msg.text,
            "msg_id": msg.messageId,
            "reply_to": msg.replyTo,
            "wire_ts": msg.timestamp,
            "auto": bool(msg.auto),
            "coord": msg.coordination,
            "deal": msg.deal,
            "group": msg.group,
        }

    # ------------------------------------------------------------------ account (T102)

    def _resolve_account(self, msg: p.Message) -> str:
        """The ACCOUNT DID this message belongs to (T102) — the same move as
        `agent/inbox.py::_resolve_account`, one tier down where the agent entry holds no
        trust DB. Returns the OWNER DID when a valid countersigned v2 binding rides in
        `metadata.binding`, else the wire (device) DID.

        Absent binding → the device DID, byte-identical to today. PRESENT binding → EVERY
        check below must hold or it raises `_BindingRejected` (fail closed, a distinct
        message per failure). The cheap structural pins (typ, owner named, deviceDid ==
        sender, integer ts/validUntil, not future/expired) produce those distinct messages;
        the two SIGNATURES are then left to the module verifier `verify_device_binding_v2`,
        the one contract clients re-implement — the agent entry must never disagree with it.

        One deliberate exception, exactly `inbox`'s posture: a P-256 owner root without the
        optional `cryptography` backend is treated as UNBOUND (account = device DID) with a
        one-time stderr note — never rejected (that would refuse an envelope-valid message
        for a gap on OUR side) and never merged unverified. Default owner roots are Ed25519,
        stdlib-verifiable, so the zero-dependency core still collapses accounts.

        TOFU: the first valid binding pins device→owner; a later binding for the same device
        naming a DIFFERENT owner is refused (no legitimate re-ownership). On that first pin,
        an earlier UNBOUND row for this device folds into the owner row ONCE — never the
        reverse, so a stripped binding can never pull an owner's history."""
        binding = getattr(msg, "binding", None)
        if binding is None:
            return msg.from_did
        if not isinstance(binding, dict):
            raise _BindingRejected("attached device binding is malformed")
        if binding.get("typ") != keybinding.BINDING_V2_TYP:
            raise _BindingRejected("attached device binding has an unsupported typ")
        root_did = binding.get("rootDid")
        if not isinstance(root_did, str) or not root_did:
            raise _BindingRejected("attached device binding names no owner")
        if binding.get("deviceDid") != msg.from_did:
            # The anti-copy pin: a binding lifted off another device's message.
            raise _BindingRejected("device binding does not name the sender")
        ts, valid_until = binding.get("ts"), binding.get("validUntil")
        if isinstance(ts, bool) or not isinstance(ts, int) \
                or isinstance(valid_until, bool) or not isinstance(valid_until, int):
            raise _BindingRejected("device binding timestamps must be integers")
        now = time.time()
        if ts > now + self.CLOCK_WINDOW:
            raise _BindingRejected("device binding ts is in the future")
        if valid_until != 0 and now > valid_until:
            raise _BindingRejected("device binding has expired")
        # P-256 owner root without the optional backend: the only unverifiable part is the
        # owner signature, and the two honest outcomes are "unbound" or "rejected". Rejecting
        # refuses an envelope-valid message for a gap on OUR side, so: treat as unbound, and
        # say so loudly once per device.
        try:
            root_curve = crypto.key_from_did(root_did)[0]
        except ValueError:
            raise _BindingRejected("device binding owner DID is unparseable")
        if root_curve == "p256" and not crypto.P256_AVAILABLE:
            self._note_p256_unbound(msg.from_did)
            return msg.from_did
        # Belt over the piecewise checks: the module verifier is the one contract clients
        # re-implement (the JS agent entry being the twin), so the two must never disagree.
        if not keybinding.verify_device_binding_v2(binding, now=now,
                                                   expected_device_did=msg.from_did):
            raise _BindingRejected("device binding does not verify")
        with self._lock:
            pinned = self._device_owner.get(msg.from_did)
            if pinned is not None and pinned != root_did:
                raise _BindingRejected(
                    "device is already bound to a different owner (a device DID is never "
                    "re-owned — a new owner means a new device key)")
            if pinned is None:
                self._device_owner[msg.from_did] = root_did
                self._fold_device_into_owner(msg.from_did, root_did)
        return root_did

    def _fold_device_into_owner(self, device_did: str, owner_did: str) -> None:
        """Called under `self._lock`. When a device that ALREADY has an unbound ledger row
        first proves its owner, move that row's history into the owner row — ONCE. Never the
        reverse: a later stripped binding resolves to the device DID and must not merge, or
        stripping a binding would become a way to read the owner's history."""
        dev_row = self.ledger.pop(device_did, None)
        if dev_row is None:
            return
        owner_row = self.ledger.get(owner_did)
        if owner_row is None:
            self.ledger[owner_did] = dev_row
        else:
            owner_row["messages"] += dev_row.get("messages", 0)
            owner_row["first_seen"] = min(owner_row["first_seen"], dev_row["first_seen"])

    def _note_p256_unbound(self, device_did: str) -> None:
        """Warn ONCE per device that a P-256 owner binding cannot be verified on the stdlib
        path (so it is treated as unbound). Bounded — the key is attacker-chosen."""
        with self._lock:
            if device_did in self._p256_unbound_logged:
                return
            if len(self._p256_unbound_logged) > self.MAX_SEEN:
                self._p256_unbound_logged.clear()
            self._p256_unbound_logged.add(device_did)
        print(f"note: {device_did[:24]}… presents a P-256 owner binding but the optional "
              f"`cryptography` backend is absent — treating the sender as UNBOUND (never "
              f"merging unverified). Install `cryptography` to honor P-256 owner roots.",
              file=sys.stderr, flush=True)

    def _ask_responder(self, env: dict) -> tuple[str, Any, Any]:
        """Call the site backend. Returns (text, context_id_override, timestamp_override).

        A plain string is the ordinary answer. The dict form may carry `context_id` /
        `timestamp` overrides, and they exist for ONE reason: a TEST AFFORDANCE, so the
        contract suite can make this agent entry misbehave on purpose and prove the VISITOR
        refuses a cross-conversation or stale reply (both fields are inside the signed
        payload, so a misbehaving site can sign them perfectly well). A real backend
        returns a string and never touches them."""
        out = self.responder(env)
        if isinstance(out, dict):
            return (str(out.get("text") or ""),
                    out["context_id"] if "context_id" in out else None,
                    out["timestamp"] if "timestamp" in out else None)
        return str(out or ""), None, None

    def _signed_reply(self, req_id: Any, msg: p.Message, text: str,
                      ctx_override: Any, ts_override: Any) -> dict:
        """Build the inline reply: same contextId, fresh messageId, INT timestamp, signed.

        `replyTo` threads it to the message it answers (an unsigned UI hint, like everywhere
        else in the protocol). The timestamp is `int(time.time())` for the same reason the
        card envelope's is — a float is a Python-only artifact, and the visitor verifying
        this signature may not be Python."""
        reply = p.Message(
            role="agent", text=text,
            contextId=msg.contextId if ctx_override is None else ctx_override,
            from_did=self.did, to_did=msg.from_did or "",
            replyTo=msg.messageId)
        reply.timestamp = int(time.time()) if ts_override is None else ts_override
        reply.sig = self.identity.sign(
            to_did=reply.to_did, message_id=reply.messageId,
            context_id=reply.contextId, timestamp=reply.timestamp, text=reply.text)
        return p.rpc_result(req_id, reply.to_a2a())

    def rpc(self, raw: bytes, *, too_large: bool = False) -> tuple[int, dict]:
        """Answer one POST body. Returns `(http_status, json_body)`.

        THE ORDER IS THE SECURITY, and it is the order of `agent/inbox.py::verify`:

          1. body over 1 MiB          -> HTTP 413 (never parsed)
          2. unparseable / not object -> HTTP 400 (no JSON-RPC id exists to answer under)
          3. wrongly-TYPED wire field -> -32600 (`_wire_shape_error`: a non-string text
             part, messageId or contextId). Before the size check because it is cheaper
             than measuring, and before everything else because these fields end up inside
             the signed payload — ours as well as theirs.
          3b. text over MAX_TEXT_BYTES -> -32005 BEFORE any crypto. Verifying an oversized
             message means canonicalizing and hashing every byte of it first, so a size
             check placed after the signature is a check the attacker simply skips.
          4. missing from/to/sig      -> -32001 (or the anonymous lane, below)
          5. `to` is not my DID       -> -32003. Inside the signed payload, so this is what
             stops a message signed for SOMEONE ELSE being replayed at us.
          6. timestamp not an integer-valued NUMBER, or |now - timestamp| > 300 -> -32002
          7. messageId seen before    -> -32002
          8. signature does not match -> -32001
        Everything from 3 on is HTTP 200 carrying a JSON-RPC error object: the request was
        well-formed HTTP, and a transport code would hide the protocol verdict from a client
        that only checks the status line.

        Step 6 is STRICTER THAN A NODE on purpose. `agent/inbox.py` still accepts a float
        timestamp because the deployed fleet contains nodes that mint them and the signature
        is over whatever type the wire carried. A agent entry is the tier whose verifiers are
        NOT all Python — a float renders through Python's repr and no other language
        reproduces those bytes — so here the INTEGER spelling is the contract: a string or
        boolean timestamp is refused (-32002) and a fractional one is unverifiable (-32001),
        where Python used to coerce with `float()` and accept all of them. See the code
        comment at step 6 for why the split between the two codes is forced by what
        JavaScript can observe rather than chosen.

        The anonymous lane (off by default) accepts a message carrying NO envelope at all —
        a contact-form-grade walk-in. It is answered with a signed reply and creates NO
        ledger row: nobody proved a key, so there is no account to create, and minting one
        would let a stranger fill the customer table with ghosts. A message carrying a
        PARTIAL envelope (a stripped `sig`, say) is never anonymous — it is a tampered
        signed message, and it is refused with -32001 on both lanes.

        The lane runs the SAME ladder, minus the checks that need a key: the body cap, the
        shape gate and the text cap are shared code above; the rate bound (-32004) and the
        messageId dedup (-32002) are applied below. What it does NOT check is freshness —
        an UNSIGNED timestamp is a number the sender chose, so refusing an old one buys
        nothing; the dedup is what makes a replayed walk-in cost a refusal instead of a
        signature, and the rate bound is what makes a NEW walk-in cost a bounded number of
        them."""
        if too_large:
            return 413, {"error": f"request body over {self.MAX_BODY_BYTES} bytes"}
        try:
            req = p.loads_object(raw)
        except Exception:
            return 400, {"error": "unparseable request body (expected a JSON-RPC object)"}

        req_id = req.get("id")
        if req.get("method") != "message/send":
            return 200, p.rpc_error(req_id, p.METHOD_NOT_FOUND,
                                    "a agent entry implements message/send only")
        params = req.get("params")
        m = params.get("message") if isinstance(params, dict) else None
        if not isinstance(m, dict):
            return 200, p.rpc_error(req_id, p.INVALID_PARAMS,
                                    "params.message must be an A2A message object")
        # (3) the wire SHAPE, checked on the raw object — `from_a2a` fills defaults (a
        # missing messageId becomes a fresh one, a missing timestamp becomes now), so a
        # check made after it cannot tell "absent" from "sent". The bytes are the contract.
        shape = self._wire_shape_error(m)
        if shape is not None:
            return 200, p.rpc_error(req_id, p.INVALID_REQUEST, shape)
        try:
            msg = p.Message.from_a2a(m)
        except Exception:
            return 200, p.rpc_error(req_id, p.INVALID_REQUEST, "not an A2A message object")

        # (3b) size, before any crypto.
        over = p.text_too_large(msg.text)
        if over:
            return 200, p.rpc_error(
                req_id, p.MESSAGE_TOO_LARGE,
                f"text is {over} bytes over the {p.MAX_TEXT_BYTES}-byte limit")

        # (4) the signing envelope — or the anonymous lane.
        if not (msg.from_did and msg.to_did and msg.sig):
            if self.anonymous_lane and not (msg.from_did or msg.to_did or msg.sig):
                # The unmetered-signing-oracle guards, cheapest first. Both refusals cost
                # this agent entry no signature, which is the entire point.
                if not self._anon_allow():
                    return 200, p.rpc_error(
                        req_id, p.RATE_LIMITED,
                        f"the anonymous lane is limited to {self.anon_rate_per_min} "
                        f"replies per minute — sign your message to lift the bound")
                if self._seen_before(msg.messageId):
                    return 200, p.rpc_error(req_id, p.REPLAY_REJECTED,
                                            "duplicate messageId (replay) detected")
                env = self._envelope(msg, verified=False)
                try:
                    text, ctx_over, ts_over = self._ask_responder(env)
                except Exception:
                    return 200, p.rpc_error(req_id, p.INTERNAL_ERROR,
                                            "the site backend failed to answer")
                return 200, self._signed_reply(req_id, msg, text, ctx_over, ts_over)
            return 200, p.rpc_error(req_id, p.UNAUTHENTICATED,
                                    "missing signing envelope (from/to/sig)")

        # (5) recipient, (6) freshness, (7) replay, (8) signature.
        if msg.to_did != self.did:
            return 200, p.rpc_error(req_id, p.WRONG_RECIPIENT,
                                    f"not addressed to me: {msg.to_did[:24]}…")
        # An INTEGER epoch, or nothing. `bool` is an `int` in Python and `True` would
        # canonicalize as `true`, so it is excluded explicitly rather than slipping through
        # isinstance; a string is refused outright (Python used to coerce it with float()
        # and accept where the JS agent entry answered -32002).
        #
        # WHY THIS IS A VALUE TEST AND NOT A TYPE TEST, and why `int()` below is not a
        # coercion in the old sense: `JSON.parse` DESTROYS the int/float distinction —
        # `1.0` and `1` both arrive in JavaScript as the Number 1, and nothing in the
        # parsed object can recover which was written. So "reject a float timestamp" is a
        # rule only Python could enforce, and enforcing it only here is how the two
        # implementations disagreed in the first place. The contract therefore has to be
        # defined by what BOTH can see: the timestamp must be a NUMBER with an exact
        # integer value, and the SIGNATURE is checked against the canonical integer
        # spelling. A sender who signed `1786580417.0` is refused by both — as -32001,
        # which is the literal truth (their signature does not cover the bytes we verify) —
        # and a sender who signed the integer is accepted by both. There is no input left
        # that one accepts and the other refuses.
        wire_ts = (m.get("metadata") or {}).get("timestamp")
        if isinstance(wire_ts, bool) or not isinstance(wire_ts, (int, float)) \
                or (isinstance(wire_ts, float) and not wire_ts.is_integer()):
            return 200, p.rpc_error(
                req_id, p.REPLAY_REJECTED,
                "timestamp must be an integer epoch (a fractional, string or boolean "
                "timestamp cannot be canonicalized identically outside Python)")
        wire_ts = int(wire_ts)
        msg.timestamp = wire_ts     # the backend envelope sees the canonical spelling too
        skew = abs(time.time() - wire_ts)
        if skew > self.CLOCK_WINDOW:
            return 200, p.rpc_error(req_id, p.REPLAY_REJECTED,
                                    "timestamp out of range (clock skew or replay)")
        if self._seen_before(msg.messageId):
            return 200, p.rpc_error(req_id, p.REPLAY_REJECTED,
                                    "duplicate messageId (replay) detected")
        # v1 verifies the ROOT key only: `from` IS the key (did:key is self-certifying), so
        # this needs no directory and no network. A key-rotated sender's op-key chain
        # (shared/keystate.py) is v2 — see the module docstring.
        if not crypto.verify_envelope(msg.from_did, msg.to_did, msg.messageId,
                                      msg.contextId, msg.timestamp, msg.text, msg.sig):
            return 200, p.rpc_error(req_id, p.UNAUTHENTICATED, "signature does not match")

        # (9) T102 account layer. An OPTIONAL countersigned v2 binding (metadata.binding)
        # collapses an owner's device DIDs to ONE account; a present-but-INVALID binding is
        # refused with the SAME UNAUTHENTICATED code (fail closed, never a silent downgrade
        # to unbound). Absent → the device DID, byte-identical to today.
        try:
            account = self._resolve_account(msg)
        except _BindingRejected as e:
            return 200, p.rpc_error(req_id, p.UNAUTHENTICATED, e.reason)

        # Verified. The row comes BEFORE the answer: the account exists because they
        # proved a key, whether or not the backend has anything useful to say. It is keyed
        # by the ACCOUNT — the owner when bound — so sibling devices are one customer.
        self._record(account)
        owner_did = account if account != msg.from_did else None
        env = self._envelope(msg, verified=True, owner_did=owner_did)
        try:
            text, ctx_over, ts_over = self._ask_responder(env)
        except Exception:
            return 200, p.rpc_error(req_id, p.INTERNAL_ERROR,
                                    "the site backend failed to answer")
        return 200, self._signed_reply(req_id, msg, text, ctx_over, ts_over)

    # ------------------------------------------------------------------ HTTP

    def _handler_class(self):
        entry = self

        class _Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            server_version = f"muretai-agent-entry/{AGENT_ENTRY_VERSION}"

            def log_message(self, fmt, *args):   # quiet by default (a sample, not a server)
                pass

            def _send(self, status: int, body: bytes,
                      ctype: str = "application/json; charset=utf-8") -> None:
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):                    # noqa: N802 (BaseHTTPRequestHandler API)
                path = urllib.parse.urlsplit(self.path).path
                if path in p.AGENT_CARD_PATHS:
                    # IDENTICAL BYTES on both paths: the canonical A2A path and its legacy
                    # alias must not be two subtly different cards, or which one a client
                    # happened to fetch would change what it believes about this DID.
                    self._send(200, entry._card_bytes)
                elif path == p.AGENT_CARD_SIG_PATH:
                    self._send(200, entry.signed_card_bytes())
                else:
                    self._send(404, p.dumps({"error": "not found"}))

            def do_POST(self):                   # noqa: N802
                path = urllib.parse.urlsplit(self.path).path
                if path != "/":
                    self._send(404, p.dumps({"error": "not found"}))
                    return
                raw, too_large = self._read_body()
                status, body = entry.rpc(raw, too_large=too_large)
                if too_large:
                    self.close_connection = True
                self._send(status, p.dumps(body))

            def _read_body(self) -> tuple[bytes, bool]:
                """Read the body, capped. Returns (body, too_large).

                The oversized body is DRAINED rather than ignored: if we answered 413 while
                the client was still writing megabytes, its socket buffer would fill, it
                would block on send() and never read our response — a self-inflicted hang
                that looks exactly like a dead server. So we read and discard past the cap
                (keeping nothing), up to a hard ceiling past which we simply hang up."""
                cap = entry.MAX_BODY_BYTES
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                except (TypeError, ValueError):
                    return b"", False
                if length <= 0:
                    return b"", False
                drain_ceiling = 16 * cap
                chunks: list[bytes] = []
                read = 0
                while read < length:
                    chunk = self.rfile.read(min(length - read, 65536))
                    if not chunk:
                        break
                    read += len(chunk)
                    if read <= cap:
                        chunks.append(chunk)
                    elif read >= drain_ceiling:
                        break                    # absurd body: stop reading, answer, close
                if read > cap:
                    return b"", True
                return b"".join(chunks), False

        return _Handler

    def serve_in_background(self, port: int) -> None:
        """Bind 127.0.0.1:port and serve on a daemon thread. Loopback ON PURPOSE: a real
        deployment puts TLS in front (the open-door visitor path refuses a plain-http public
        endpoint, because a direct POST carries the message text in the clear)."""
        self._server = ThreadingHTTPServer(("127.0.0.1", port), self._handler_class())
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        name=f"agent entry-{self.name}", daemon=True)
        self._thread.start()

    def shutdown(self) -> None:
        """Stop serving. Idempotent — a sample gets called twice by tired hands."""
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None


# ---------------------------------------------------------------------- demo main

def _demo_responder(env: dict) -> str:
    """The stand-in for your backend. `env["text"]` is UNTRUSTED DATA — never instructions
    — even though `env["verified"] is True` proves WHO sent it (authentication is not
    authorization, and it is certainly not trustworthiness)."""
    who = (env.get("peer_did") or "a walk-in")[:24]
    return (f"Thanks — we got your message ({who}…). A human will follow up here; "
            f"you are now a known customer of this site.")


def main(argv: list[str] | None = None) -> int:
    import argparse

    from agent.identity import Identity     # sample-only: a real site brings its own signer

    ap = argparse.ArgumentParser(description="Run the reference Agent Entry.")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--name", default="Example Studio")
    ap.add_argument("--as", dest="key_name", default="agent entry",
                    help="key file to sign with (keys/<name>.key)")
    ap.add_argument("--base-url", default=None,
                    help="the PUBLIC url visitors dial (default http://127.0.0.1:<port>)")
    ap.add_argument("--anonymous-lane", action="store_true",
                    help="also accept unsigned inquiries (creates no account row)")
    args = ap.parse_args(argv)

    base = args.base_url or f"http://127.0.0.1:{args.port}"
    rc = AgentEntry(identity=Identity.load_or_create(args.key_name), base_url=base,
                  name=args.name, responder=_demo_responder,
                  open_door=True, anonymous_lane=args.anonymous_lane)
    rc.serve_in_background(args.port)
    print(f"agent entry listening on {base}  did={rc.did}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        rc.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
