"""intake_id: the one rule every reader resolves an APPL intake id by.

Two intakes filed in the same second share the 16-character stamp of their file names, so
the stamp alone is not an id. tools/appl-add.sh writes each intake's id as the header line
`id: <id>`: `<stamp>` for the first file of its second, `<stamp>-N` for the N-th. A reader
-- appl-backlog-pull.sh (an `after`, the records step, the write-back, the inbox) and
tools/appl-dashboard.py (its intake lookup) -- resolves an id with `resolve` here:

  * a file with an `id:` header line answers to exactly that id and no other;
  * a legacy file (no `id:` line) answers to the bare stamp only when it is the SOLE file
    of that stamp, and, when it has same-stamp siblings, to `<stamp>-N` when its name ends
    in `-N.md` (N >= 2) -- a slug that merely ends in digits, with no sibling, is not one;
  * a bare stamp several files share is AMBIGUOUS (`ambiguous-id`): it names none of them;
  * anything else -- the long form `<stamp>-<slug>`, `<stamp>-02`, `<stamp>-1` -- is not
    an id, or names no file, and resolves to nothing.

An intake is OWNER P0 (owner_p0) when its header carries `owner-priority: P0`, or when the
intake its header `parent: <id>` names is, followed link by link with `resolve` -- the
rule appl-backlog-add.sh, appl-add.sh, appl-split-check.sh, the pull, appl-hydrate.sh and
appl-park.sh all read the marker by.

Kept apart from the resolution of an `after` by TITLE (appl-backlog-pull.sh's title_state).
Standard library only; nothing here opens a file for writing.
"""

import os
import re

STAMP = r"[0-9]{8}T[0-9]{6}Z"
ID = STAMP + r"(?:-[1-9][0-9]*)?"
ID_RE = re.compile(ID)
SUFFIX_RE = re.compile(r"-([1-9][0-9]*)\.md$")
AMBIGUOUS = "ambiguous-id"
HEAD_BYTES = 65536


def is_id(text):
    """True for `<stamp>` or `<stamp>-N` (N >= 1, no leading zero) and nothing else"""
    return ID_RE.fullmatch(text or "") is not None


def header_id(head):
    """the value of the first `id:` line of an intake's header text, or None"""
    for ln in head.split("\n"):
        if ln == "":
            break
        if ln.startswith("id:"):
            return ln[len("id:"):].strip()
    return None


def same_stamp(names, stamp):
    """the `*.md` names of one stamp: `<stamp>.md` and `<stamp>-*.md`"""
    return sorted(n for n in names
                  if n == stamp + ".md" or (n.startswith(stamp + "-") and n.endswith(".md")))


def answer(name, head, siblings):
    """the id one file answers to, among `siblings` files of its stamp (itself counted), or
    None when it answers to none"""
    stamp = name[:16]
    own = header_id(head)
    if own is not None:
        return own if is_id(own) and own[:16] == stamp else None
    if siblings == 1:
        return stamp
    m = SUFFIX_RE.search(name)
    if m and int(m.group(1)) >= 2:
        return stamp + "-" + m.group(1)
    return None


def resolve(ident, entries):
    """(state, name) for an id among `entries`, the (name, header text) of every file of
    its stamp: ("ok", name), ("ambiguous", None) or ("unknown", None)"""
    if not is_id(ident):
        return "unknown", None
    stamp = ident[:16]
    mine = set(same_stamp([n for n, _h in entries], stamp))
    entries = [(n, h) for n, h in entries if n in mine]
    if ident == stamp and len(entries) > 1:
        return "ambiguous", None
    hits = [n for n, h in entries if answer(n, h, len(entries)) == ident]
    if len(hits) == 1:
        return "ok", hits[0]
    return ("ambiguous", None) if hits else ("unknown", None)


def read_head(path):
    """the header text (up to the first blank line) of a regular, non-symlink file, or None"""
    if os.path.islink(path) or not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read(HEAD_BYTES).split("\n\n", 1)[0]
    except OSError:
        return None


def entries_in(intake_dir, stamp):
    """(name, header text) of every regular intake file of one stamp under intake_dir"""
    try:
        names = os.listdir(intake_dir)
    except OSError:
        return []
    out = []
    for n in same_stamp(names, stamp):
        head = read_head(os.path.join(intake_dir, n))
        if head is not None:
            out.append((n, head))
    return out


def resolve_in(intake_dir, ident):
    """resolve() over the files of intake_dir: ("ok", path), ("ambiguous", None) or
    ("unknown", None)"""
    if not is_id(ident):
        return "unknown", None
    state, name = resolve(ident, entries_in(intake_dir, ident[:16]))
    return state, (os.path.join(intake_dir, name) if name else None)


# the longest parent chain walked; a longer one (or a loop) makes nothing owner P0
CHAIN_MAX = 64


def header_value(head, key):
    """the value of the first `<key>:` line of an intake's header text, or None"""
    for ln in head.split("\n"):
        if ln == "":
            break
        if ln.startswith(key + ":"):
            return ln[len(key) + 1:].strip()
    return None


def owner_p0_head(intake_dir, head):
    """True when the header text carries the owner marker `owner-priority: P0`, or its
    `parent: <id>` chain, followed link by link under intake_dir, reaches an intake whose
    header does. A body line is never read (read_head stops at the blank line); a loop, a
    parent that does not resolve or a chain over CHAIN_MAX links ends the walk with False."""
    seen = set()
    for _ in range(CHAIN_MAX):
        if header_value(head, "owner-priority") == "P0":
            return True
        parent = header_value(head, "parent")
        if parent is None or not is_id(parent) or parent in seen:
            return False
        seen.add(parent)
        state, path = resolve_in(intake_dir, parent)
        head = read_head(path) if state == "ok" else None
        if head is None:
            return False
    return False


def owner_p0(intake_dir, ident):
    """owner_p0_head() of the intake <ident> names under intake_dir; False when it names none"""
    state, path = resolve_in(intake_dir, ident)
    head = read_head(path) if state == "ok" else None
    return head is not None and owner_p0_head(intake_dir, head)


def id_of(intake_dir, name):
    """the id the file `name` under intake_dir answers to, when that id resolves back to it;
    else None"""
    entries = entries_in(intake_dir, name[:16])
    for n, head in entries:
        if n == name:
            ident = answer(n, head, len(entries))
            if ident is not None and resolve(ident, entries) == ("ok", name):
                return ident
    return None
