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
a deploy pipeline and no always-on process it wants to babysit. An agent entry is ~one file on
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
read and an agent entry call with ONE schema. In production `responder` would POST that dict to
your backend behind a bearer token (exactly what WebhookWake does) and return what it says;
here it is called in-process to keep the sample runnable in one file.

Run it standalone:

    python3 examples/agent_entry_reference.py --port 8099 --name "Example Studio"
"""
from __future__ import annotations

import json
import os
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
from shared import domainbind                    # noqa: E402  THE definition of a bare domain
from shared import keybinding                     # noqa: E402  countersigned v2 device binding
from shared import protocol as p                 # noqa: E402  the wire contract

#: The SITE's software version, not a muretai build number: an agent entry is not a node and
#: has no installed release. It rides in the card's `version` because A2A expects the field.
AGENT_ENTRY_VERSION = "1.0.0"

#: Signed replies per minute the ANONYMOUS lane may cost this entry, in total. The lane
#: is unauthenticated, so without a bound it is a signing oracle: a stranger can spend an
#: Ed25519 signature (and a backend call) per request forever, and nothing in the ladder
#: cares, because there is no key to attribute the cost to. Must match
#: `ANON_RATE_PER_MIN` in web/agent-entry/muretai-agent-entry.mjs — the two agent entries are one
#: contract, and a bound that differs between them is a bound a site cannot reason about.
ANON_RATE_PER_MIN = 30

#: How many domains one card may advertise. Mirrors `agent/domainstore.MAX_CARD_DOMAINS`
#: and the same ceiling `shared/protocol.build_agent_card` applies to a node's card: every
#: name listed is an outbound HTTPS fetch this entry asks strangers to make, so the cap is
#: a bound on the work an entry can push onto its visitors, not on how many domains a site
#: may own. Must match `MAX_CARD_DOMAINS` in web/agent-entry/muretai-agent-entry.mjs.
MAX_CARD_DOMAINS = 5

#: The outer whitespace BOTH languages strip identically. Python's `str.strip()` also
#: removes \x1c-\x1f, U+0085 and U+00A0; JavaScript's `trim()` removes a different tail of
#: Unicode spaces. Folding only this intersection — and refusing everything else outside
#: 0x21..0x7E — is what stops the two twins from accepting different strings for the same
#: operator input (the same reasoning as `canonical_base_url`'s character gate).
_OUTER_WS = " \t\n\r\f\v"

#: Every response carries these. An agent entry reads NO cookie, header credential or
#: session — authority comes only from an Ed25519 signature inside the body — so `*` grants
#: a browser-resident agent exactly what curl already had, and nothing more. NEVER add
#: `Access-Control-Allow-Credentials`: it is the one header that would turn `*` into an
#: instruction to attach the visitor's ambient authority, and there is no ambient authority
#: here to attach. Must match `CORS_HEADERS` in web/agent-entry/muretai-agent-entry.mjs.
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
}

#: What `Allow:` says on an OPTIONS and on a 405. HEAD is not listed because RFC 9110 makes
#: it identical to GET; the twin's `Access-Control-Allow-Methods` spells the same three.
ALLOWED_METHODS = "GET, POST, OPTIONS"

JSON_CTYPE = "application/json; charset=utf-8"

#: The refusal text for a request-target that is not in origin form, shared with the JS twin
#: so the two return the same diagnostic for the same request.
ORIGIN_FORM_ONLY = ("the request-target must be an origin-form path: this entry answers "
                    "exactly the address its card names, and that address has no other "
                    "spelling")

#: The refusal text when a body does not arrive inside `BODY_BUDGET`.
TOO_SLOW = "the request body did not arrive within the time budget"

#: Longest chunk-size (or trailer) line a chunked body may carry. Generous for a size in hex
#: plus extensions, and small enough that an endless line cannot be a memory attack.
_MAX_CHUNK_LINE = 8192

_OVERLOADED_BODY = b'{"error":"too many concurrent connections"}'
_OVERLOADED = (b"HTTP/1.1 503 Service Unavailable\r\n"
               b"Content-Type: application/json; charset=utf-8\r\n"
               b"Content-Length: " + str(len(_OVERLOADED_BODY)).encode() + b"\r\n"
               b"Connection: close\r\n\r\n" + _OVERLOADED_BODY)


class _BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """`ThreadingHTTPServer` with a CEILING on live connections.

    A thread-per-connection server with no ceiling is a thread bomb any unauthenticated
    stranger can set off, and the timeouts alone do not close it: they bound how LONG each
    connection lives, not how MANY exist at once. Past the ceiling a connection is answered
    503 and closed on the accept loop, WITHOUT starting a thread — so the refusal costs
    strictly less than the attack, which is the only property that makes a bound useful.

    Stdlib only, deliberately: the whole file is copyable, and a dependency here would be a
    dependency in every site that copies it (CLAUDE.md principle 1)."""

    daemon_threads = True
    max_connections = 64

    def __init__(self, *args, **kwargs):
        # Before super().__init__, which binds and activates the socket: the accept loop
        # must never see this object without its counter.
        self._live = 0
        self._live_lock = threading.Lock()
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        with self._live_lock:
            live = self._live
            if live < self.max_connections:
                self._live = live + 1
        if live >= self.max_connections:
            try:
                request.sendall(_OVERLOADED)
            except OSError:
                pass                             # they hung up first; nothing to say
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            with self._live_lock:
                self._live -= 1


def _int_epoch(v):
    """An integer epoch, or None. Accepts an integer-valued float (JSON has one number
    type, and a JS re-serialisation yields one) and normalises it; refuses bool, a true
    fraction, and anything non-numeric. The one spelling both implementations agree on."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if isinstance(v, float) and not v.is_integer():
        return None
    return int(v)


#: RFC 3986 `pchar` plus '/' — the only characters an accepted path may carry. Everything
#: outside this set is percent-encoded by JavaScript's URL parser and left verbatim by
#: Python's, which is precisely the divergence `canonical_base_url` exists to prevent.
_PATH_OK = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@/")
_HEX = frozenset("0123456789abcdefABCDEF")
#: A host is already lowercased when this is applied. `_` is not legal in a hostname but is
#: real in the wild (internal names, some CDNs) and both parsers keep it verbatim, so it is
#: not a divergence — accept it rather than break a working deployment.
_HOST_OK = frozenset("abcdefghijklmnopqrstuvwxyz0123456789.-_")
_DEFAULT_PORT = {"http": 80, "https": 443}


def _dot_segment(seg: str) -> "str | None":
    """`'.'` or `'..'` if this path segment is a dot segment AS THE URL PARSERS SEE IT,
    else None.

    Raw `.` and `..` are the obvious spellings; WHATWG's `new URL()` ALSO removes `%2e`,
    `%2E` and every mixture (`.%2e`, `%2e.`, `%2e%2e`), and Python's `urlsplit` removes
    none of them. So a segment test written against the raw text lets exactly that family
    through: measured, `https://shop.example/a/%2e%2e/support` started and published here
    while the JavaScript twin refused it — and refused it by ACCUSING ITSELF, since the
    only thing that noticed was its `new URL()` tripwire. Decoding just this one escape
    (never the whole segment — `%41` must stay `%41`, it is a different path) makes the
    two implementations refuse the same family, on the operator's screen, with a reason
    about the input."""
    decoded = seg.replace("%2e", ".").replace("%2E", ".")
    return decoded if decoded in (".", "..") else None


def _refuse(given, rule: str, why: str, fix: "str | None" = None, *,
            field: str = "base_url"):
    """Raise the one refusal shape, in the order an operator can act on at 2am: what they
    gave (quoted, so an invisible tab is VISIBLE), which rule in words, the fix as a string
    they can paste, and one clause of why. `<field> is not publishable:` is the greppable
    stem the JavaScript twin shares — `base_url` for the address, `domains` for the names
    this entry claims to speak for."""
    lines = [f"{field} is not publishable: {rule}", f"  given: {given!r}"]
    if fix:
        lines.append(f"  use:   {fix!r}")
    lines.append("  " + why)
    raise ValueError("\n".join(lines))


def canonical_base_url(base_url, *, warn: bool = True) -> str:
    """The exact string this entry may publish as its card `url`, or ValueError.

    The contract, and the only reason this function exists: **the returned value equals
    `Outbox.card_scope(base_url)`** — the arithmetic a VISITOR runs on the url they dialled
    to decide whether this card is about this site (`agent/outbox.py`). An entry that
    publishes anything else fails verification on a stranger's machine, with "signature
    verification failed" as the only diagnostic and nothing at all on the operator's screen.

    So every input on which the operator's spelling and the visitor's arithmetic could
    disagree — or on which this file and its JavaScript twin could disagree — is REFUSED
    here, loudly, at construction. The two implementations are held byte-identical by an
    acceptance suite; a value they canonicalise differently is a signed-bytes split for
    identical operator input, which is the bug this whole function is about.

    The algorithm, written out because a third implementation (Go, Rust) has no `neturl`
    to call and this file is the reference:

      0. must be a non-empty string
      1. strip outer ASCII whitespace                                       (silent)
      2. every character in 0x21..0x7E — one rule that kills interior spaces, TAB/CR/LF
         (BOTH parsers DELETE these mid-string, so the operator never sees them), NUL,
         and all non-ASCII
      3. no '\\'      (JavaScript reads it as '/', Python keeps it in the host)
      4. no '?' and no '#', tested on the RAW string — a bare trailing '#' parses to an
         EMPTY fragment, so a parsed-component test waves through the one input that
         makes the trick work (`shared/neturl.peer_base_ok` tests the raw string too)
      5. scheme is http or https, case-insensitive -> lowercased
      6. authority = up to the first '/'; the rest (with that '/') = path
      7. no '@' in the authority (userinfo), no '%' in the authority
      8. host lowercased, ALL trailing '.' dropped, IPv6 brackets kept; port 1..65535 with
         the scheme's default dropped
      9. ALL trailing '/' stripped from the path; empty stays "" and never becomes "/";
         no '.' or '..' segment; every character in pchar+'/' or a well-formed '%HH'.
         Path case and percent-escape case are PRESERVED, never folded — `card_scope`
         does not fold them either, and folding here would publish a value the visitor
         does not compute
     10. reassemble, then assert the result is a fixed point of the verifier's arithmetic

    Steps 0-7 run BEFORE `neturl.origin` is called, which is what makes reusing it safe:
    `origin()` silently folds userinfo, query and fragment away — correct for a consumer
    reading a stranger's card, wrong for a producer, since it would quietly publish
    something other than what the operator typed. It never sees those inputs here.

    `warn=False` silences the advisory notes (they go to stderr and are never fatal).
    """
    if not isinstance(base_url, str) or not base_url.strip():
        _refuse(base_url, "it is empty.",
                "Set it to the URL visitors actually dial — it is what your signed card "
                "claims, and a card naming a different origin proves nothing about yours.")
    s = base_url.strip()

    for ch in s:
        if ch < "\x21" or ch > "\x7e":
            if ch > "\x7e":
                host_guess = s.split("://", 1)[-1].split("/", 1)[0]
                fix = None
                try:                              # best-effort A-label for the message only
                    ascii_host = host_guess.encode("idna").decode()
                    if ascii_host != host_guess:
                        fix = s.replace(host_guess, ascii_host, 1)
                except Exception:
                    pass
                _refuse(s, "it is not ASCII.", fix=fix,
                        why="Python and JavaScript disagree on how to spell this (Python "
                            "keeps it as typed, JavaScript percent-encodes or punycodes "
                            "it), so the two Agent Entry implementations would sign "
                            "different bytes for the same site. Supply the ASCII form, and "
                            "publish your links and QR codes in that same form.")
            _refuse(s, "it contains whitespace or a control character.",
                    "Both URL parsers DELETE a tab or newline silently and mid-string, so "
                    "the value you meant and the value that gets signed are not the same "
                    "string and nothing tells you.")

    if "\\" in s:
        _refuse(s, "it contains a backslash.", fix=s.replace("\\", "/"),
                why="JavaScript reads '\\' as '/' and Python does not, so the two Agent "
                    "Entry implementations would disagree about where the host ends.")
    for bad, label in (("?", "a query string"), ("#", "a fragment")):
        if bad in s:
            _refuse(s, f"it carries {label}.", fix=s.split(bad, 1)[0] or None,
                    why="This string is signed into your Agent Card, and every visitor "
                        "compares it to the URL they dialled — which never carries one.")

    scheme, sep, rest = s.partition("://")
    scheme = scheme.lower()
    if not sep or scheme not in _DEFAULT_PORT:
        _refuse(s, "it is not an http(s) URL.",
                fix=("https://" + s) if (not sep and "/" not in s.split("?")[0][:1]) else None,
                why="An Agent Card names an origin a visitor can dial over HTTP.")
    authority, slash, tail = rest.partition("/")
    path = slash + tail

    if "@" in authority:
        _refuse(s, "it carries userinfo (a '@' before the host).",
                fix=f"{scheme}://{authority.rsplit('@', 1)[1]}{path}",
                why="The part before '@' is not the host: a visitor dials the part AFTER "
                    "it, so a card built from this string would name a different site than "
                    "the one being served.")
    if "%" in authority:
        _refuse(s, "the host contains a percent-escape.",
                "Python lowercases it into the host and JavaScript refuses the URL "
                "outright, so the two Agent Entry implementations cannot agree.")

    if authority.startswith("["):                 # IPv6 literal — brackets are part of it
        close = authority.find("]")
        if close < 0:
            _refuse(s, "the IPv6 host is missing its closing ']'.",
                    "An address literal must be bracketed, e.g. http://[::1]:9000")
        host, port_part = authority[:close + 1].lower(), authority[close + 1:]
        if port_part and not port_part.startswith(":"):
            _refuse(s, "there is text after the IPv6 address.",
                    "Only ':<port>' may follow a bracketed address.")
        port_s = port_part[1:] if port_part else ""
    elif ":" in authority:
        host, _, port_s = authority.rpartition(":")
        host = host.lower()
    else:
        host, port_s = authority.lower(), ""

    if port_s:
        if not port_s.isdigit() or not (1 <= int(port_s) <= 65535):
            _refuse(s, f"the port {port_s!r} is not a number in 1-65535.",
                    "A visitor dials a real port; anything else cannot be reached.")
        port = int(port_s)
    else:
        port = None
    host = host.rstrip(".")                       # trailing dot: DNS-equal, byte-different
    if not host or (not host.startswith("[") and set(host) - _HOST_OK):
        _refuse(s, "the host is missing or contains characters that are not a hostname.",
                "A card must name a host a visitor can resolve.")

    path = path.rstrip("/")                       # ALL of them: card_scope uses rstrip too
    if path:
        i = 0
        while i < len(path):
            ch = path[i]
            if ch == "%":
                if len(path) - i < 3 or path[i + 1] not in _HEX or path[i + 2] not in _HEX:
                    _refuse(s, "the path has a malformed percent-escape.",
                            "'%' must be followed by exactly two hex digits, or the two "
                            "URL parsers disagree about what the path is.")
                i += 3
                continue
            if ch not in _PATH_OK:
                _refuse(s, f"the path contains {ch!r}, which is not allowed unencoded.",
                        "JavaScript percent-encodes this character and Python leaves it "
                        "verbatim, so the two Agent Entry implementations would sign "
                        "different bytes. Percent-encode it yourself.")
            i += 1
        segments = path.split("/")
        if any(_dot_segment(seg) is not None for seg in segments):
            segs: list[str] = []                  # RFC 3986 remove_dot_segments, for the fix
            for seg in segments:
                dot = _dot_segment(seg)
                if dot == ".":
                    continue
                if dot == "..":
                    if len(segs) > 1:
                        segs.pop()
                    continue
                segs.append(seg)
            _refuse(s, "the path contains '.' or '..' segments "
                       "(the percent-encoded spellings '%2e' and '%2E' count).",
                    fix=f"{scheme}://{authority}" + "/".join(segs).rstrip("/"),
                    why="JavaScript collapses these segments — encoded ones included — and "
                        "Python does not, so the two Agent Entry implementations would "
                        "sign different bytes.")

    out = f"{scheme}://{host}"
    if port is not None and port != _DEFAULT_PORT[scheme]:
        out += f":{port}"
    out += path

    # The property, asserted rather than assumed: what we publish IS what the verifier
    # computes, and it is a fixed point. `Outbox.card_scope` is `neturl.origin(u) +
    # urlsplit(u).path.rstrip("/")`; inlined (three lines) so this file needs nothing from
    # agent/, and cross-checked against the real card_scope by test_agent_entry_contract.
    from shared import neturl                    # noqa: PLC0415  local: keeps the top light
    scope = neturl.origin(out) + urllib.parse.urlsplit(out).path.rstrip("/")
    if scope != out:
        # The wording matters, and it is the JavaScript twin's tripwire that taught us:
        # it asserted "a bug in this file, NOT in your input" and sent the operator to an
        # issue tracker for `https://shop.example/a/%2e%2e/support`, which is an input
        # problem with a paste-able fix. A tripwire cannot know which it is looking at, so
        # it must not claim to. Name both, input first.
        raise ValueError(
            f"base_url is not publishable: canonicalising it produces a value the "
            f"verifier does not compute.\n"
            f"  given: {base_url!r}\n"
            f"  this file canonicalises it to {out!r}, but the verifier "
            f"(Outbox.card_scope) computes {scope!r}.\n"
            f"  Check the address first — a spelling this gate does not know how to fold "
            f"lands here. If it is an ordinary http(s) URL with no unusual escaping, this "
            f"is a bug in this file: please report it at "
            f"https://github.com/muretai/agent-entry/issues")

    if warn:
        if any(c.isupper() for c in path):
            print(f"warning: base_url path {path!r} contains uppercase letters. Paths are "
                  f"case-SENSITIVE and are not folded by the visitor's check, so a visitor "
                  f"who dials {path.lower()!r} will fail to verify your card. Make sure "
                  f"every link, invite and QR code you publish spells it exactly {path!r}.",
                  file=sys.stderr)
        if "%" in path:
            print(f"warning: base_url path {path!r} contains a percent-escape. It is "
                  f"compared verbatim, case included, so a visitor who dials another "
                  f"spelling of the same path will fail to verify your card.",
                  file=sys.stderr)
        if scheme == "http" and host not in ("localhost", "127.0.0.1", "[::1]"):
            print(f"warning: base_url {out!r} is plain HTTP on a public host. A visiting "
                  f"agent refuses a plain-http open door (the message text would cross the "
                  f"wire in the clear), so this entry will be skipped by every well-behaved "
                  f"visitor. Use https.", file=sys.stderr)
    return out


def canonical_domains(domains, *, warn: bool = True) -> "list[str]":
    """The exact list this entry may publish as its card's `domains`, or ValueError.

    WHAT IT IS FOR. A domain binding is BILATERAL and neither half is worth anything
    alone (`shared/domainbind.py`, `agent/domainverify.py`): the DOMAIN publishes a
    credential naming this DID at `/.well-known/did-configuration.json`, and the AGENT's
    own live card names the domain back. This list is that second half. Without it a
    verifier that already holds the domain's file answers `card-withdrawn` — the domain
    vouches for an agent that does not claim the domain — so an entry with no `domains`
    can never be proven to belong to the site it is serving from. And because the two
    halves are written by different parties, EITHER can end the binding alone: the domain
    owner deletes one line from the file, or the entry drops the name from this list.

    WHY THE RULE IS BORROWED, NOT RESTATED. `shared/domainbind.valid_domain` is the one
    definition of "is this a bare domain" in this codebase — it is what mints the
    credential, what `agent/domainverify._norm_domain` re-checks, and therefore what
    decides whether the two halves can ever name the same string. A second opinion here
    would produce an entry that starts happily and can never verify, which is precisely
    the failure the whole canonicalise-or-refuse posture exists to move onto the
    operator's screen. So this function CALLS it, and only adds the canonicalization
    `_norm_domain` makes around it: `strip().lower()`, nothing else.

    The algorithm, written out because a third implementation (Go, Rust) has no
    `domainbind` to call and this file is the reference:

      0. absent / empty -> `[]`, and the card then carries NO `domains` key at all.
         Byte-identical to an entry from before this option existed: nobody already
         running one has to re-publish or re-sign anything.
      1. the input is a LIST of strings (a bare string is refused, not wrapped: one
         accepted spelling, so the twins cannot disagree about what "a domain" was)
      2. per entry: strip the outer whitespace BOTH languages agree on (`_OUTER_WS`),
         then REFUSE any remaining character outside 0x21..0x7E — that one rule kills
         interior spaces, tabs, control characters and every non-ASCII (an IDN must be
         supplied as its punycode A-label, exactly as `valid_domain` demands)
      3. lowercase (DNS is case-insensitive; `valid_domain` REJECTS an uppercase
         spelling rather than folding it, so the fold happens here, visibly)
      4. `domainbind.valid_domain` decides: ASCII LDH labels, 1..63 each, no leading or
         trailing '-', at least two labels, host <= 253 and no trailing dot, an optional
         ':<port>' 1..65535 with no leading zero, and no scheme, path, query, fragment
         or userinfo anywhere
      5. de-duplicate, keeping the operator's order
      6. REFUSE more than MAX_CARD_DOMAINS distinct names, naming the count and the
         ceiling

    WHY (6) REFUSES INSTEAD OF TRUNCATING, though `build_agent_card` truncates at the
    same 5: that function renders a card for many callers at runtime and must not blow up
    mid-render, while this one validates an argument an operator just typed — and it
    already refuses every other bad value there. Truncating would start the entry with a
    claim that is USABLE and NOT WHAT THEY SAID: the names that vanished fail for whoever
    verifies them, and nothing anywhere says why. Same failure as publishing a `base_url`
    that is not the one the operator meant, one field over.

    `warn=False` silences the advisory notes (stderr, never fatal)."""
    if domains is None:
        return []
    if isinstance(domains, str) or not isinstance(domains, (list, tuple)):
        _refuse(domains, "it is not a list of domain names.", field="domains",
                fix=None,
                why="Pass a list, e.g. [\"example.com\"] — a single string is refused "
                    "rather than wrapped, so this file and its JavaScript twin cannot "
                    "disagree about what was meant.")
    out: list[str] = []
    for entry in domains:
        if not isinstance(entry, str):
            _refuse(entry, "it is not a string.", field="domains",
                    why="A domain is a name, e.g. \"example.com\".")
        s = entry.strip(_OUTER_WS)
        for ch in s:
            if ch < "\x21" or ch > "\x7e":
                _refuse(entry, "it contains whitespace, a control character or a "
                               "non-ASCII character.", field="domains",
                        fix=_domain_fix(s),
                        why="A domain here is compared byte for byte against the origin "
                            "in the credential the domain itself serves, so an "
                            "internationalized name must be given in its punycode "
                            "(xn--…) A-label form and nothing else may travel with it.")
        lowered = s.lower()
        if not domainbind.valid_domain(lowered):
            _refuse(entry, "it is not a bare domain name.", field="domains",
                    fix=_domain_fix(lowered),
                    why="Give the HOST only: ASCII letters, digits and '-', at least "
                        "two labels (each 1-63 characters, not starting or ending with "
                        "'-'), at most 253 characters, optionally ':<port>' 1-65535 — "
                        "no scheme, no path, no query, no '@', no trailing dot. "
                        "The domain's own credential binds https://<this exact string>, "
                        "so anything else can never match it.")
        if lowered not in out:
            out.append(lowered)
    if len(out) > MAX_CARD_DOMAINS:
        _refuse(list(domains),
                f"it names {len(out)} distinct domains, more than the "
                f"{MAX_CARD_DOMAINS} a card may advertise.", field="domains",
                why="Every name listed is an outbound HTTPS fetch this entry asks "
                    "strangers to make, so a card carries at most "
                    f"{MAX_CARD_DOMAINS}. Publishing the first {MAX_CARD_DOMAINS} and "
                    "dropping the rest would start this entry with a claim that is "
                    "usable and NOT what you said: the names that vanished fail for "
                    "whoever verifies them and nothing anywhere says why. Drop names, "
                    "or run a second entry (its own key) for the rest.")
    return out


def _domain_fix(candidate: str) -> "str | None":
    """A pasteable repair for a domain we refused, or None when we cannot guess one.

    Only ever suggests something our own validator accepts: strip a scheme, a path, a
    query/fragment and any userinfo, then re-ask `valid_domain`. Guessing is safe
    precisely because the guess is re-validated — a wrong guess simply produces no
    suggestion rather than a second bad value to paste."""
    try:
        guess = candidate.strip(_OUTER_WS).lower()
        guess = guess.split("://", 1)[-1]
        for cut in ("/", "?", "#"):
            guess = guess.split(cut, 1)[0]
        if "@" in guess:
            guess = guess.rsplit("@", 1)[1]
        guess = guess.rstrip(".")
        return guess if guess and guess != candidate and domainbind.valid_domain(guess) \
            else None
    except Exception:
        return None


def canonical_mount(base_url: str, base_path=None) -> str:
    """The path prefix this entry ANSWERS at: derived from the canonical `base_url`, or
    the one documented override. `""` for a bare origin; otherwise `"/support"`-shaped.

    WHY IT IS DERIVED AND NOT CONFIGURED. A mount the operator spells separately from
    `base_url` is a second place to write the same fact, and the failure it produces is
    the worst one this system has: the entry answers at one path while its signed card
    claims another, so every visitor fails `Outbox.card_binds_to` and the only diagnostic
    anyone gets is "cannot prove that … owns …". Deriving it makes the router's mount and
    the card's advertised address THE SAME STRING by construction. (Measured before this
    existed: an entry given `--base-url http://h:p/support` printed that address, signed
    `/support` into its card, and then answered the BARE HOST — three different answers to
    one question.)

    THE ONE OVERRIDE, and why it is not a general knob. A reverse proxy that STRIPS the
    prefix (`location /support/ { proxy_pass http://127.0.0.1:8788/; }`) hands us `/…`
    while the public address is still `https://h/support`. That deployment is real, so
    `base_path=""` is allowed — but ONLY `""` or exactly the canonical url's own path.
    Any other value would be a third spelling of the address, which is the thing this
    function exists to make impossible. Raises ValueError on anything else."""
    path = urllib.parse.urlsplit(base_url).path.rstrip("/")
    if base_path is None:
        return path
    if not isinstance(base_path, str):
        _refuse(base_path, "it is not a string.", field="base_path",
                why="Pass \"\" (a proxy that strips the prefix) or the same path as "
                    "base_url.")
    given = base_path.strip(_OUTER_WS).rstrip("/")
    if given not in ("", path):
        _refuse(base_path, "it is neither empty nor the path base_url already names.",
                field="base_path", fix=path or "",
                why=f"This entry publishes {base_url!r}, so a visitor dials {path or '/'} "
                    f"and nothing else. Use \"\" only when a proxy strips the prefix "
                    f"before the request reaches this process.")
    return given


class _BindingRejected(Exception):
    """A PRESENT device binding failed one of the v2 checks (T102).

    Carries a distinct reason string so the agent entry answers the SAME
    UNAUTHENTICATED (-32001) code its signature check uses. Fail closed: a
    present-but-invalid binding is an attack or a client bug, never a silent
    downgrade to "unbound" — admitting it as merely unbound would let an attacker
    probe checks one at a time at no cost, and handing the backend a proven owner
    it never proved is worse. Mirrors agent/inbox.py::_resolve_account's
    per-failure VerifyError one tier down (an agent entry holds no trust DB)."""

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
    envelope is caught). It may carry a PATH — `https://example.com/support` — and then
    every route this entry answers hangs off that path and the bare host is 404, so one
    hostname can hold a front desk, support and sales as three separate agents with three
    separate keys (`canonical_mount`).

    `domains` are the names this entry claims to speak for. A claim only: the proof is the
    credential the DOMAIN itself serves, and a verifier requires both halves
    (`canonical_domains`).
    """

    #: ±window on the signed timestamp. Mirrors agent/inbox.CLOCK_WINDOW — the two must not
    #: drift, or a message a node accepts is one an agent entry refuses (and vice versa).
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
    #: The largest |timestamp| this entry will do ARITHMETIC on (~year 36812). A bigint is
    #: perfectly signable — canonical JSON writes it and Ed25519 covers it — so it reaches
    #: the freshness step, where `abs(time.time() - wire_ts)` raises OverflowError and the
    #: blanket net turns a SPECIFIC refusal into "internal error" (-32603) while the JS twin
    #: sees `Infinity`, fails `Number.isInteger` and answers -32002. Refusing the magnitude
    #: HERE, at the step that means it, is what keeps the two verdicts the same one.
    MAX_EPOCH = 1 << 40

    # ---- transport bounds. Node bounds all three of these BY DEFAULT (`headersTimeout`,
    # `requestTimeout`, `keepAliveTimeout`) and this handler bounded NONE, which made the
    # reference the only tier a stranger could wedge with no key and no request body.
    # Measured: 40 unauthenticated trickle connections (`Content-Length: 1000000`, one body
    # byte, then silence) took it from 2 threads to 42, and 0 of the 40 got any response.
    # These numbers are mirrored in web/agent-entry/muretai-agent-entry.mjs `listen()`.

    #: Per-recv socket timeout while a request line and its headers are read. Bounds the
    #: connection that opens and says nothing at all.
    HEADER_TIMEOUT = 20.0
    #: WALL-CLOCK ceiling on reading one request body. The socket timeout above is a
    #: per-recv bound and a trickle resets it forever — this is the deadline that does not
    #: reset. 1 MiB in 20 s is a floor of ~52 KB/s, which no honest client is under.
    BODY_BUDGET = 20.0
    #: How long an IDLE keep-alive connection is held between requests. Node's default.
    KEEPALIVE_TIMEOUT = 5.0
    #: Concurrent connections this entry will serve. A thread-per-connection server with no
    #: ceiling is a thread bomb an unauthenticated stranger can set off; past this a
    #: connection is answered 503 and closed WITHOUT a thread, so the refusal is cheaper
    #: than the attack. Mirrors `maxConnections` in the JS twin.
    MAX_CONNECTIONS = 64

    def __init__(self, *, identity, base_url: str, name: str,
                 responder: Callable[[dict], "str | dict"],
                 open_door: bool = True, anonymous_lane: bool = False,
                 description: str | None = None,
                 domains: "list[str] | None" = None,
                 base_path: "str | None" = None,
                 anon_rate_per_min: int = ANON_RATE_PER_MIN):
        self.identity = identity
        self.did: str = identity.did
        self.name = name
        #: The ONE string this entry publishes as its card url. Canonicalised, not echoed:
        #: it must equal what a visitor's `Outbox.card_scope` computes for the url they
        #: dialled, or the card fails verification on THEIR machine with nothing on ours.
        self.base_url = canonical_base_url(base_url)
        #: The path prefix this entry ANSWERS at, derived from `base_url` (see
        #: `canonical_mount`), so the router and the signed card cannot disagree. "" for a
        #: bare origin, which reproduces every string this file matched before the mount
        #: existed.
        self.mount = canonical_mount(self.base_url, base_path)
        #: The exact strings this entry answers GET on, built ONCE from the mount so the
        #: request path is a lookup and never string arithmetic per request.
        self._card_paths = tuple(self.mount + q for q in p.AGENT_CARD_PATHS)
        self._sig_path = self.mount + p.AGENT_CARD_SIG_PATH
        #: The domains this entry CLAIMS to speak for — the agent half of a T88 binding.
        #: Never auto-derived from `base_url`: a card claiming a domain the domain has not
        #: claimed back is a self-assertion, and deriving it would change the signed bytes
        #: of every entry already deployed.
        self.domains = canonical_domains(domains)
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

        An agent entry is the tier that has no node, so the card must be constructible from the
        published field list alone — a site porting this to Go or JS has no `build_agent_card`
        to call. Keeping the sample honest about that is the whole point of the constraint.

        `muretai.open_door` is the additive capability bit the visitor path reads: it says
        "you may message me without an introduction or a contact grant". Absent (or false)
        means the ordinary contact-grant handshake still applies.

        `domains` (T88) is the reverse half of a domain binding — the names this entry
        claims to speak for, in the same top-level field and the same position
        `shared/protocol.build_agent_card` puts them in, so a verifier reads a node's card
        and an entry's card with one rule. It is a CLAIM and never evidence: the proof is
        the credential the DOMAIN serves, signed by this key. OMITTED ENTIRELY when no
        domain was named, which is what keeps an existing entry's published bytes
        unchanged."""
        card: dict[str, Any] = {
            "protocolVersion": p.PROTOCOL_VERSION,       # "0.2" — hard-code it in a port
            "name": self.name,
            "description": self.description,
            # The origin visitors dial. `Outbox.card_binds_to` requires this to name the
            # url that was actually dialled, so an agent entry behind a proxy must advertise
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
        if self.domains:
            card["domains"] = list(self.domains)
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
    def _not_utf8(s: str) -> bool:
        """True iff this string cannot be written as UTF-8 — i.e. it holds a LONE SURROGATE.

        `"\\ud800"` is legal JSON and `json.loads` hands it back as a Python str, but there
        is no UTF-8 encoding of it: every `.encode("utf-8")` downstream raises
        UnicodeEncodeError. Measured: a one-shot POST carrying `"text": "\\ud800"` from a
        stranger with no key reached `p.text_too_large` -> `.encode("utf-8")` and killed the
        request with no HTTP response at all, while the JavaScript twin — whose strings are
        UTF-16 and whose `Buffer.byteLength` substitutes U+FFFD — answered normally. So a
        lone surrogate is BOTH a crash input here and a divergence: refuse it in the shape
        gate, where every other "this is not the type the wire promised" lives."""
        try:
            s.encode("utf-8")
        except UnicodeEncodeError:
            return True
        return False

    @classmethod
    def _wire_shape_error(cls, m: dict) -> str | None:
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
          * a non-object `metadata`, or a non-string `from`/`to`/`sig` inside it — the
            envelope FIELDS, checked here rather than at step 4, because step 4 can only
            ask "is it there". `metadata: "x"` read as an EMPTY envelope on the JS side and
            became either -32001 or, with the anonymous lane on, a SIGNED ANONYMOUS REPLY:
            a malformed envelope silently downgraded to a walk-in. `metadata.to = 1` was
            worse here — it survived the presence test and reached `to_did[:24]`, which is
            a TypeError out of `rpc()` and therefore no HTTP response at all.
          * a LONE SURROGATE in any of those strings (`_not_utf8`) — legal JSON, not
            encodable text; it raised UnicodeEncodeError out of the text-size check on this
            side while JS quietly substituted U+FFFD and answered -32001.

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
            if isinstance(part.get("text"), str) and cls._not_utf8(part["text"]):
                return "a text part's `text` is not encodable UTF-8 (a lone surrogate)"
        mid = m.get("messageId")
        if not isinstance(mid, str) or not mid:
            return "messageId must be a non-empty string"
        if cls._not_utf8(mid):
            return "messageId is not encodable UTF-8 (a lone surrogate)"
        ctx = m.get("contextId")
        if ctx is not None and not isinstance(ctx, str):
            return "contextId must be a string or null"
        if isinstance(ctx, str) and cls._not_utf8(ctx):
            return "contextId is not encodable UTF-8 (a lone surrogate)"
        # The ENVELOPE fields. `null` reads as ABSENT (that is the stripped-sig case the
        # ladder answers -32001 for, and the shape of a walk-in on the anonymous lane);
        # PRESENT-but-not-a-string is a malformed request and never an absent envelope.
        meta = m.get("metadata")
        if meta is not None and not isinstance(meta, dict):
            return "metadata must be an object"
        for field in ("from", "to", "sig"):
            v = (meta or {}).get(field)
            if v is None:
                continue
            if not isinstance(v, str):
                return f"metadata.{field} must be a string"
            if cls._not_utf8(v):
                return f"metadata.{field} is not encodable UTF-8 (a lone surrogate)"
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
            "peer_name": None,          # an agent entry holds no address book to resolve one
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
        # NORMALISE an integer-valued float, exactly as the message path does at step 6 —
        # and for the same reason. JSON has one number type: a sender that writes `1.0`
        # (or any JS runtime re-serialising a Number) produces a float here, while
        # `JSON.parse` in the JS twin yields the Number 1 and `Number.isSafeInteger(1)` is
        # true. Rejecting the float here and accepting it there made the SAME POST create
        # a customer on one implementation and 401 on the other — the double-book class the
        # wire-shape machinery exists to close, reopened one layer down (found by the
        # security audit, ISSUE(agent-entry-binding-float-ts-divergence)). A TRUE fraction
        # is still refused by both: it cannot be canonicalised identically outside Python.
        ts, valid_until = _int_epoch(binding.get("ts")), _int_epoch(binding.get("validUntil"))
        if ts is None or valid_until is None:
            raise _BindingRejected("device binding timestamps must be integers")
        binding = {**binding, "ts": ts, "validUntil": valid_until}
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
        is over whatever type the wire carried. An agent entry is the tier whose verifiers are
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
        them.

        THE NET. Everything above is a ladder of explicit refusals; this method also
        promises something weaker and more important — that an UNAUTHENTICATED stranger
        always gets an HTTP RESPONSE. It is the promise the other two tiers already keep
        and this one did not: `agent/inbox.py::handle_rpc` ends in a blanket
        `except Exception -> -32603` and the JavaScript twin wraps `handleRequestAsync` in
        a `.catch(...)`, while an exception here escaped into `BaseHTTPRequestHandler`,
        which closes the socket with no status line and prints a traceback. Measured: two
        one-shot POSTs from a stranger with no key did exactly that (`metadata.to = 1` ->
        `to_did[:24]`, and `"text": "\\ud800"` -> `.encode("utf-8")`). Both are refused by
        name now, in the shape gate; the NET is what makes the NEXT such input a -32603
        instead of a dead socket — and this file is the one a merchant copies.

        The detail is printed LOCALLY and never returned (`agent/inbox.py` learned that the
        same way): an exception string carries field names, values and file paths, and an
        unauthenticated caller proved nothing that entitles them to any of it."""
        try:
            return self._ladder(raw, too_large=too_large)
        except Exception as e:                  # noqa: BLE001 — the net, deliberately blanket
            print(f"agent entry: internal error handling a request: {e!r}",
                  file=sys.stderr, flush=True)
            return 200, p.rpc_error(self._recovered_id(raw), p.INTERNAL_ERROR,
                                    "internal error")

    @classmethod
    def _recovered_id(cls, raw: bytes):
        """The JSON-RPC `id` to answer an INTERNAL error under, or None.

        Re-parsing costs nothing because this runs only on the net's error path, and a
        client that pipelines requests needs the id to know which one died."""
        try:
            return cls._safe_id(p.loads_object(raw).get("id"))
        except Exception:
            return None

    @classmethod
    def _safe_id(cls, rid):
        """The JSON-RPC `id` we may ECHO, or None.

        JSON-RPC 2.0 says an id is a String, a Number or Null — never an object or an
        array — and this enforces exactly that, for a reason larger than pedantry: the id
        is the ONE field no signature covers and it is written straight back out, so
        whatever the two runtimes disagree about here becomes a disagreement about the
        whole response.

        Three refusals, each measured:
          - a LONE SURROGATE anywhere inside it has no UTF-8 encoding, so `p.dumps` raises
            while `JSON.stringify` escapes it happily. `id = {"x":"\\ud800"}` BOOKED THE
            ACCOUNT and then died in serialisation — HTTP 500, no reply, the customer on
            the books — while the JS twin answered 200 with a signed reply. The old check
            looked at a TOP-LEVEL string only, so a nested one walked straight past it;
            refusing the whole non-scalar SHAPE is what closes the class rather than the
            instance.
          - a number outside ±2^53 is not representable in JavaScript, where `10**400`
            parses to `Infinity` and re-serialises as `null` while Python echoes the
            bigint verbatim.
          - anything else that is not a scalar.

        `null` is what JSON-RPC allows for an unusable id, and it keeps the VERDICT — not
        the echo — as the thing the two implementations have to agree on."""
        if isinstance(rid, str):
            return None if cls._not_utf8(rid) else rid
        if isinstance(rid, bool) or not isinstance(rid, (int, float)):
            return None
        return None if abs(rid) > (1 << 53) else rid

    def _ladder(self, raw: bytes, *, too_large: bool = False) -> tuple[int, dict]:
        """The ladder itself. Called only by `rpc()`, whose docstring IS the contract."""
        if too_large:
            return 413, {"error": f"request body over {self.MAX_BODY_BYTES} bytes"}
        try:
            req = p.loads_object(raw)
        except Exception:
            return 400, {"error": "unparseable request body (expected a JSON-RPC object)"}

        # An id we could not write back out is answered under `null` — see `_safe_id`.
        req_id = self._safe_id(req.get("id"))
        if req.get("method") != "message/send":
            return 200, p.rpc_error(req_id, p.METHOD_NOT_FOUND,
                                    "an agent entry implements message/send only")
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
        # ...and an epoch outside any plausible clock is refused BEFORE the arithmetic that
        # cannot survive it. `abs(time.time() - wire_ts)` on a signable bigint raises
        # OverflowError, and the blanket net below converts that into -32603 while the JS
        # twin (where `JSON.parse` yields `Infinity`) answers -32002. A net that turns a
        # specific refusal into "internal error" is a divergence generator: the fix is to
        # refuse at the step that MEANS it, under the code this whole rung already carries.
        if abs(wire_ts) > self.MAX_EPOCH:
            return 200, p.rpc_error(req_id, p.REPLAY_REJECTED,
                                    "timestamp out of range (clock skew or replay)")
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

    def is_mount_path(self, path: str) -> bool:
        """True iff `path` is the message endpoint — the base the card's `url` names.

        Exact, because a wandering endpoint is not this contract: with a bare origin that
        is `/` and nothing else (byte-for-byte what this file always accepted), and with
        a mount it is `/support` plus its trailing-slash spelling, since `card_scope`
        folds the two and a visitor may legitimately have been handed either."""
        if not self.mount:
            return path == "/"
        return path == self.mount or path == self.mount + "/"

    def notice_bytes(self) -> bytes:
        """The one-line plain-text notice `GET <mount>` answers with.

        BYTE-IDENTICAL to the JS twin's (`route()` in muretai-agent-entry.mjs). It exists
        because a person who pastes the address into a browser deserves to be told what
        this address is; it is not a route a visiting agent walks. "This ADDRESS", not
        "this origin": once an entry can be mounted under a path the origin may hold
        several agents and this notice speaks for exactly one of them."""
        return (f"{self.name}\n\nThis address is agent-reachable (Muretai agent entry).\n"
                f"DID:  {self.did}\nCard: {self.base_url}{p.AGENT_CARD_PATH}\n"
                f"POST a signed A2A message/send request to {self.mount or '/'} "
                f"for a signed reply.\n").encode("utf-8")

    def _handler_class(self):
        entry = self

        class _Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            server_version = f"muretai-agent-entry/{AGENT_ENTRY_VERSION}"
            #: A per-recv SOCKET timeout, applied by `StreamRequestHandler.setup()`. Without
            #: it a connection that opens and sends nothing holds a thread forever, which is
            #: half of the wedge measured in the class constants above.
            timeout = entry.HEADER_TIMEOUT

            def log_message(self, fmt, *args):   # quiet by default (a sample, not a server)
                pass

            # ---------------------------------------------------------- response plumbing

            def setup(self):
                super().setup()
                #: The bound on the wait for the NEXT request line. The header timeout for
                #: the first request on a connection, the (much shorter) keep-alive timeout
                #: once we have already answered on it.
                self._idle_timeout = entry.HEADER_TIMEOUT

            def handle_one_request(self):
                """One request, with the IDLE bound applied to the wait for its head.

                Node bounds three separate waits by default — `headersTimeout`,
                `requestTimeout` and `keepAliveTimeout` — and this handler bounded none.
                `timeout` above covers the head of a request; this narrows it to
                KEEPALIVE_TIMEOUT once we have already answered on this socket, so a client
                that gets its reply and then sits there does not go on holding a thread for
                the full header timeout as well."""
                try:
                    self.connection.settimeout(self._idle_timeout)
                except OSError:
                    pass
                super().handle_one_request()
                self._idle_timeout = entry.KEEPALIVE_TIMEOUT

            def _send(self, status: int, body: bytes,
                      ctype: "str | None" = "application/json; charset=utf-8",
                      extra: "dict[str, str] | None" = None) -> None:
                self.send_response(status)
                if ctype is not None:
                    self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                for key, value in CORS_HEADERS.items():
                    self.send_header(key, value)
                for key, value in (extra or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                # A HEAD response carries the headers a GET would and NO body (RFC 9110):
                # writing one here is what makes the next response on this socket start
                # inside the previous one's body.
                if self.command != "HEAD":
                    self.wfile.write(body)

            def _request_path(self) -> "tuple[str | None, str | None]":
                """`(path, refusal)` — the PATH of the request-target, or why it is not one.

                HTTP/1.1 lets a client write the target in absolute form
                (`GET http://elsewhere.example/x HTTP/1.1`) and `urlsplit` obligingly
                STRIPS the scheme and authority, leaving `/x` — so this entry answered for
                an address it does not name. Measured against an entry mounted at
                `/victim`: `GET http://attacker.example/victim/.well-known/agent-card.json`
                returned the card (HTTP 200) while the JavaScript twin, which compares the
                target as written, answered 404. Both are refusals of the same kind the
                mount check already makes — this module answers EXACTLY the address its
                card names — so a target carrying a scheme or an authority is refused.

                RFC 9112 §3.2.2 says a server MUST accept absolute form. This contract
                deliberately does not, and therefore has to SAY SO: a bare "not found" for
                a syntactically legal target is the kind of diagnostic that costs an
                integrator an afternoon and teaches them nothing."""
                parts = urllib.parse.urlsplit(self.path)
                if parts.scheme or parts.netloc:
                    return None, ORIGIN_FORM_ONLY
                return parts.path, None

            def _guarded(self, fn) -> None:
                """Run one route and ALWAYS answer. The transport-level twin of `rpc()`'s
                net (and of the JS module's `.catch()` around `handleRequestAsync`): `rpc()`
                itself no longer raises, so what is left here is a failure while ROUTING or
                serialising — and the alternative to answering is the dead socket that made
                the reference entry the only tier with no net at all. The detail is logged
                locally, never returned."""
                try:
                    status, body, close, ctype, extra = fn()
                except Exception as e:          # noqa: BLE001 — the net, deliberately blanket
                    print(f"agent entry: internal error handling a request: {e!r}",
                          file=sys.stderr, flush=True)
                    status, body, close = 500, b'{"error":"internal error"}', True
                    ctype, extra = "application/json; charset=utf-8", {}
                if close:
                    self.close_connection = True
                self._send(status, body, ctype, extra)

            # ---------------------------------------------------------- the method table

            def do_GET(self):                    # noqa: N802 (BaseHTTPRequestHandler API)
                self._guarded(self._get)

            def do_HEAD(self):                   # noqa: N802
                # SAME route, same headers, no body (`_send` drops it). RFC 9110 §9.3.2
                # makes HEAD mandatory for a general-purpose server, and the twin has
                # always answered it; this handler used to answer 501, so a client that
                # probes with HEAD before fetching read one entry as alive and the other
                # as not implementing the card at all.
                self._guarded(self._get)

            def do_OPTIONS(self):                # noqa: N802
                self._guarded(self._options)

            def do_POST(self):                   # noqa: N802
                self._guarded(self._post)

            def __getattr__(self, attr):
                """Any OTHER method is 405, never 501.

                `BaseHTTPRequestHandler` dispatches by looking up `do_<METHOD>` and calls
                `send_error(501)` when it is absent — a different answer from the twin's
                405, and one that skips `_send` and so carries no CORS headers either.
                Answering here keeps the method table in ONE place. Only `do_*` is
                synthesised; every other missing attribute still raises, because silently
                answering an internal typo with an HTTP response is how a router starts
                lying about what it implements."""
                if attr.startswith("do_"):
                    return lambda: self._guarded(self._not_allowed)
                raise AttributeError(attr)

            def _not_allowed(self) -> tuple:
                return (405, p.dumps({"error": "method not allowed"}), False,
                        "application/json; charset=utf-8", {"Allow": ALLOWED_METHODS})

            def _options(self) -> tuple:
                # 204, no Content-Type, and the CORS preflight headers `_send` adds to
                # everything. A browser-resident agent cannot POST to this entry at all
                # without an answer here.
                return 204, b"", False, None, {"Allow": ALLOWED_METHODS}

            def _get(self) -> tuple:
                path, refusal = self._request_path()
                # EVERY route hangs off the mount, which is the path the signed card
                # already claims (`canonical_mount`). With a bare origin the mount is ""
                # and these are byte-for-byte the strings this handler always matched;
                # with `/support` the entry answers THERE and 404s the bare host, so two
                # different agents can hold two paths on one hostname without either
                # answering for the other. A visitor builds the same strings
                # (`neturl.join` keeps the base's path prefix), so this is not a new
                # convention — it is the one the fetcher already follows.
                if refusal is not None:
                    return self._not_found(refusal)
                if path in entry._card_paths:
                    # IDENTICAL BYTES on both paths: the canonical A2A path and its legacy
                    # alias must not be two subtly different cards, or which one a client
                    # happened to fetch would change what it believes about this DID.
                    return 200, entry._card_bytes, False, JSON_CTYPE, {}
                if path == entry._sig_path:
                    return 200, entry.signed_card_bytes(), False, JSON_CTYPE, {}
                if entry.is_mount_path(path):
                    # The human notice. `POST <mount>` is the contract; `GET <mount>` is a
                    # courtesy for whoever pastes the address into a browser, and a site
                    # that keeps its own home page simply does not route GET here.
                    return (200, entry.notice_bytes(), False,
                            "text/plain; charset=utf-8", {})
                return self._not_found()

            def _not_found(self, detail: "str | None" = None) -> tuple:
                body = {"error": "not found"}
                if detail:
                    body["detail"] = detail
                return 404, p.dumps(body), False, JSON_CTYPE, {}

            def _post(self) -> tuple:
                path, refusal = self._request_path()
                if refusal is not None:
                    return self._not_found(refusal)
                if not entry.is_mount_path(path):
                    return self._not_found()
                raw, too_large, denial = self._read_body()
                if denial is not None:
                    # A FRAMING refusal always closes the connection: once the two ends
                    # could disagree about where this request ends, whatever follows on
                    # this socket is not ours to read. That is the whole of the smuggling
                    # defence — the refusal is worth nothing if we then keep parsing.
                    status, why = denial
                    return status, p.dumps({"error": why}), True, JSON_CTYPE, {}
                status, body = entry.rpc(raw, too_large=too_large)
                return status, p.dumps(body), too_large, JSON_CTYPE, {}

            # ---------------------------------------------------------- reading the body

            def _framing(self) -> "tuple[str | None, int, str | None]":
                """How is this body framed — and is the framing UNAMBIGUOUS?

                Returns `(mode, length, refusal)` with mode in `none|length|chunked`.

                THIS IS THE SMUGGLING GATE. `int(self.headers.get("Content-Length") or 0)`
                — what this used to be — takes the FIRST of several headers, accepts `+5`,
                and ignores `Transfer-Encoding` entirely. Those are exactly the two
                canonical request-smuggling desyncs:

                  CL.CL  two Content-Lengths. Whichever of the proxy and the origin reads
                         the other one is parsing a second request out of this one's body.
                  CL.TE  Content-Length AND Transfer-Encoding. Same outcome, and the
                         RFC's "ignore the Content-Length" rule is honoured by nobody
                         uniformly enough to rely on.

                and `+5` is a length a strict parser refuses and a lax one accepts, which
                is the same disagreement wearing a smaller hat. Measured before this
                existed: the JS twin (Node's llhttp) answered 400 to all three while this
                reference ACCEPTED THEM AND BOOKED THE ACCOUNT — and this is the tier whose
                documented deployment is behind a proxy.

                A single `Transfer-Encoding: chunked` is NOT ambiguous and is accepted (see
                `_read_chunked` for why that is the right half of the choice)."""
                lengths = self.headers.get_all("Content-Length") or []
                encodings = self.headers.get_all("Transfer-Encoding") or []
                if encodings and lengths:
                    return None, 0, ("Transfer-Encoding and Content-Length must not both "
                                     "be present")
                if len(lengths) > 1:
                    return None, 0, "a repeated Content-Length is ambiguous"
                if encodings:
                    codings = [c.strip().lower()
                               for value in encodings for c in value.split(",") if c.strip()]
                    if codings != ["chunked"]:
                        return None, 0, ("chunked is the only Transfer-Encoding this entry "
                                         "accepts")
                    return "chunked", 0, None
                if not lengths:
                    return "none", 0, None
                value = lengths[0].strip()
                if not value or any(c not in "0123456789" for c in value):
                    # `+5`, `5, 5`, ` 0x5`, and every other spelling two parsers read
                    # differently. Note `str.isdigit()` would ACCEPT Arabic-Indic digits.
                    return None, 0, "Content-Length must be a plain decimal number"
                return "length", int(value), None

            def _read_body(self) -> "tuple[bytes, bool, tuple[int, str] | None]":
                """Read the body. Returns `(body, too_large, denial)`.

                `denial` is `(status, message)` — 400 for a framing refusal, 408 for a body
                that did not arrive inside the budget — and is None on the happy path.

                TWO BOUNDS, and neither existed before. `timeout` is a PER-RECV socket
                timeout: a client that sends one byte every 19 s resets it forever, which is
                precisely the trickle round 1 fixed on the OUTBOUND fetch and left standing
                on this INBOUND read. `deadline` is the wall-clock ceiling that actually
                ends such a connection. `read1` rather than `read` because a BufferedReader's
                `read(n)` blocks until it has all n bytes — with `read` the loop below never
                gets to re-check the deadline at all.

                The oversized body is DRAINED rather than ignored: if we answered 413 while
                the client was still writing megabytes, its socket buffer would fill, it
                would block on send() and never read our response — a self-inflicted hang
                that looks exactly like a dead server. So we read and discard past the cap
                (keeping nothing), up to a hard ceiling past which we simply hang up."""
                mode, length, refusal = self._framing()
                if refusal is not None:
                    return b"", False, (400, refusal)
                # The head is read under the idle bound (5 s on a reused connection); the
                # BODY gets the full header timeout per recv, with the deadline below as the
                # bound that a trickle cannot reset.
                try:
                    self.connection.settimeout(entry.HEADER_TIMEOUT)
                except OSError:
                    pass
                deadline = time.monotonic() + entry.BODY_BUDGET
                cap = entry.MAX_BODY_BYTES
                try:
                    if mode == "chunked":
                        return self._read_chunked(cap, deadline)
                    return self._read_length(length, cap, deadline)
                except OSError:
                    # The per-recv timeout fired (or the peer vanished mid-body). Either way
                    # the body did not arrive, and that is a 408 the sender can act on — not
                    # the 500 an escaping exception produced before, which reads as "the
                    # site is broken" for what is in fact "you did not finish your request".
                    # `OSError` rather than `TimeoutError`: on Python 3.9 `socket.timeout` is
                    # an OSError and NOT a TimeoutError.
                    return b"", False, (408, TOO_SLOW)

            def _read_length(self, length: int, cap: int,
                             deadline: float) -> "tuple[bytes, bool, tuple[int, str] | None]":
                """A Content-Length-framed body. See `_read_body` for the two bounds."""
                if length <= 0:
                    return b"", False, None
                drain_ceiling = 16 * cap
                chunks: list[bytes] = []
                read = 0
                while read < length:
                    if time.monotonic() > deadline:
                        return b"", False, (408, TOO_SLOW)
                    chunk = self.rfile.read1(min(length - read, 65536))
                    if not chunk:
                        break
                    read += len(chunk)
                    if read <= cap:
                        chunks.append(chunk)
                    elif read >= drain_ceiling:
                        break                    # absurd body: stop reading, answer, close
                if read > cap:
                    return b"", True, None
                return b"".join(chunks), False, None

            def _read_chunked(self, cap: int,
                              deadline: float) -> "tuple[bytes, bool, tuple[int, str] | None]":
                """A BOUNDED chunked reader. Same return shape as `_read_body`.

                WHY BOTH TWINS ACCEPT CHUNKED (the decision, recorded where it is enforced).
                The documented deployment for an agent entry is behind a reverse proxy or a
                TLS terminator, and a proxy legitimately RE-FRAMES a request: nginx buffers
                and sends a Content-Length, Caddy/Envoy/Node forward the client's chunking
                through. Refusing chunked would therefore refuse honest traffic depending on
                which proxy the site happens to run — a failure the operator cannot see,
                cannot reproduce from curl, and would debug as "the agent entry is broken".
                Node already dechunks correctly, so refusing would ALSO mean adding a
                rejection to the twin that handles it properly. The signature covers the
                DECODED body either way, so chunking changes nothing a verifier checks.
                What is refused is only the AMBIGUITY (`_framing`): chunked together with a
                Content-Length, or a repeated one.

                Bounded three ways, because a decoder a stranger drives is a decoder that
                must not be able to spend unbounded time or memory: the wall-clock deadline,
                the same 1 MiB body cap, and a ceiling on the total WIRE bytes (payload plus
                framing overhead) so a stream of one-byte chunks is bounded too."""
                body: list[bytes] = []
                body_bytes = 0
                wire_bytes = 0
                wire_ceiling = 16 * cap
                while True:
                    if time.monotonic() > deadline:
                        return b"", False, (408, TOO_SLOW)
                    line = self.rfile.readline(_MAX_CHUNK_LINE + 1)
                    wire_bytes += len(line)
                    if not line or len(line) > _MAX_CHUNK_LINE or wire_bytes > wire_ceiling:
                        return b"", False, (400, "malformed or oversized chunked body")
                    head = line.split(b";", 1)[0].strip()
                    if not head or any(c not in b"0123456789abcdefABCDEF" for c in head):
                        return b"", False, (400, "malformed chunked body (chunk size)")
                    size = int(head, 16)
                    if size == 0:
                        break
                    body_bytes += size
                    wire_bytes += size + 2
                    if wire_bytes > wire_ceiling:
                        return b"", False, (400, "malformed or oversized chunked body")
                    got = b""
                    while len(got) < size:
                        if time.monotonic() > deadline:
                            return b"", False, (408, TOO_SLOW)
                        piece = self.rfile.read1(size - len(got))
                        if not piece:
                            return b"", False, (400, "truncated chunked body")
                        got += piece
                    if body_bytes <= cap:
                        body.append(got)
                    if self.rfile.read(2) != b"\r\n":
                        return b"", False, (400, "malformed chunked body (missing CRLF)")
                # Trailers, bounded by the same wire ceiling. They are read and DISCARDED:
                # a trailer arrives after the body a signature covers, so nothing in it can
                # be trusted and nothing in this contract reads one.
                while True:
                    if time.monotonic() > deadline:
                        return b"", False, (408, TOO_SLOW)
                    line = self.rfile.readline(_MAX_CHUNK_LINE + 1)
                    wire_bytes += len(line)
                    if not line or len(line) > _MAX_CHUNK_LINE or wire_bytes > wire_ceiling:
                        return b"", False, (400, "malformed or oversized chunked body")
                    if line in (b"\r\n", b"\n"):
                        break
                if body_bytes > cap:
                    return b"", True, None
                return b"".join(body), False, None

        return _Handler

    def serve_in_background(self, port: int) -> None:
        """Bind 127.0.0.1:port and serve on a daemon thread. Loopback ON PURPOSE: a real
        deployment puts TLS in front (the open-door visitor path refuses a plain-http public
        endpoint, because a direct POST carries the message text in the clear)."""
        server = _BoundedThreadingHTTPServer(("127.0.0.1", port), self._handler_class())
        server.max_connections = self.MAX_CONNECTIONS
        self._server = server
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


def domains_from_env(raw: "str | None") -> "list[str] | None":
    """Split an `AGENT_ENTRY_DOMAINS`-style variable, or None when nothing was named.

    THE SPLIT RULE, which must match `examples/agent_entry_server.mjs` exactly — the two
    runners are one operator surface and a difference here is a difference in what the
    product does with the same input. Absent or blank -> None (no `domains` key at all).
    Otherwise split on ',' and hand on EVERY segment AS WRITTEN: an empty segment
    (`a,,b`, a trailing comma) is REFUSED downstream by `canonical_domains`, never
    silently skipped. A name lost in an edit looks exactly like a harmless typo, and
    starting with fewer domains than the operator named is the same silent mismatch
    `canonical_base_url` refuses one field over.

    "Blank" is `_OUTER_WS` — the intersection `canonical_domains` folds with — and NOT
    `str.strip()`, which is where the two runners drifted apart. `strip()` also removes
    \\x1c-\\x1f and U+0085, `trim()` also removes U+FEFF, and neither removes the other's
    set, so the same variable decided the question two ways: `AGENT_ENTRY_DOMAINS="\\x1c"`
    started the Python runner with no domains while the JS runner refused to start
    (exit 2), and a BOM — what a paste out of a spreadsheet or a Windows `.env` carries —
    did exactly the reverse. One fold, one verdict."""
    if not isinstance(raw, str) or not raw.strip(_OUTER_WS):
        return None
    return raw.split(",")


def main(argv: list[str] | None = None) -> int:
    import argparse

    from agent.identity import Identity     # sample-only: a real site brings its own signer

    ap = argparse.ArgumentParser(description="Run the reference Agent Entry.")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--name", default="Example Studio")
    ap.add_argument("--as", dest="key_name", default="agent entry",
                    help="key file to sign with (keys/<name>.key)")
    ap.add_argument("--base-url", default=None,
                    help="the PUBLIC url visitors dial, INCLUDING any path it is mounted "
                         "under (e.g. https://example.com/support). The entry answers "
                         "there and nowhere else. Default http://127.0.0.1:<port>")
    ap.add_argument("--domain", dest="domains", action="append", default=None,
                    metavar="DOMAIN",
                    help="a bare domain this entry speaks for, e.g. example.com "
                         "(repeatable, at most 5). The domain must ALSO serve a "
                         "credential naming this DID at "
                         "/.well-known/did-configuration.json — one half proves nothing")
    ap.add_argument("--anonymous-lane", action="store_true",
                    help="also accept unsigned inquiries (creates no account row)")
    args = ap.parse_args(argv)

    # The same two environment variables examples/agent_entry_server.mjs reads, so both
    # runners can be started identically; an explicit flag always wins over the variable.
    base = (args.base_url or os.environ.get("AGENT_ENTRY_BASE_URL")
            or f"http://127.0.0.1:{args.port}")
    domains = args.domains
    if domains is None:
        domains = domains_from_env(os.environ.get("AGENT_ENTRY_DOMAINS"))
    # A bad --base-url or --domain raises ValueError HERE, before the socket is bound:
    # the entry never starts and never publishes a claim no visitor could use.
    try:
        rc = AgentEntry(identity=Identity.load_or_create(args.key_name), base_url=base,
                        name=args.name, responder=_demo_responder,
                        domains=domains,
                        open_door=True, anonymous_lane=args.anonymous_lane)
    except ValueError as e:
        print(str(e), file=sys.stderr, flush=True)
        return 2
    rc.serve_in_background(args.port)
    print(f"agent entry listening on {rc.base_url}  did={rc.did}", flush=True)
    if rc.domains:
        print(f"  speaking for: {', '.join(rc.domains)}  "
              f"(each domain must serve a credential naming this DID at "
              f"{domainbind.WELL_KNOWN_PATH})", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        rc.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
