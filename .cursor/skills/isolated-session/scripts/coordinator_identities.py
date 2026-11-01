"""coordinator_identities: the one reader of the identities the coordinator reads mail as
and answers as.

appl-hook.sh (`coordinator_identities`, every mail pass) and appl-answer.sh (its header
checker, every reply) load this file by absolute path from their own script directory, and
nothing else: never <repo>/tools, which is not guarded and, in a consumer, is the
consumer's own (ISSUE(security-audit-2026-10-27-pin-the-coordinator-2468)). Either caller
refuses by this file's name when it is absent or unreadable; neither falls back to a
default identity then.

tools/remote_gate.py keeps its own copy for the `[gate]` path only. The two are the same
rule: the machine file is $APPL_MACHINE_CONFIG, else ~/.config/appl/machine.toml.

Standard library only; nothing here opens a file for writing.
"""

import os
import re
from pathlib import Path

_AGENT = re.compile(r"^[a-z][a-z0-9-]{0,31}$")


def machine_file():
    named = os.environ.get("APPL_MACHINE_CONFIG")
    if named:
        path = Path(named)
        return path if path.is_file() and not path.is_symlink() else None
    home = os.environ.get("HOME") or ""
    if not home:
        return None
    path = Path(home) / ".config" / "appl" / "machine.toml"
    return path if path.is_file() and not path.is_symlink() else None


def read_coordinator_identities(path=None):
    """The ``[coordinator]`` table's ``identities``: the agents the coordinator reads mail
    as and answers as, in file order, each an agent name, duplicates dropped.

    None when there is no machine file or it holds no ``[coordinator]`` table: the caller
    keeps its single default identity. A table with no ``identities`` key, an empty list,
    or a value that is not one list of quoted strings is ``[]``: nothing is guessed. A
    name that is not agent-shaped is left out. The list may span lines."""
    src = path if path is not None else machine_file()
    if src is None or src.is_symlink() or not src.is_file():
        return None
    try:
        fd = os.open(src, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        raw = os.read(fd, 1 << 16)
    finally:
        os.close(fd)
    try:
        text = raw.decode("utf-8")
    except UnicodeError:
        return None
    seen = False
    in_coord = False
    value = None
    for line in text.splitlines():
        s = line.split("#", 1)[0].strip()
        if value is not None:
            value += " " + s
            if "]" in s:
                break
            continue
        if not s:
            continue
        if s.startswith("["):
            in_coord = s == "[coordinator]"
            seen = seen or in_coord
            continue
        if in_coord and "=" in s:
            key, rest = s.split("=", 1)
            if key.strip() == "identities":
                value = rest.strip()
                if "]" in value:
                    break
    if not seen:
        return None
    if value is None:
        return []
    m = re.fullmatch(r"\[\s*((?:(?:\"[^\"]*\"|'[^']*')\s*,\s*)*(?:\"[^\"]*\"|'[^']*')?)\s*,?\s*\]", value)
    if m is None:
        return []
    out = []
    for q in re.findall(r"\"[^\"]*\"|'[^']*'", m.group(1)):
        name = q[1:-1]
        if _AGENT.match(name) and name not in out:
            out.append(name)
    return out
