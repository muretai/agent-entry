#!/usr/bin/env python3
"""appl.toml's reader: the settings and the Muretai names, a small TOML subset, stdlib
only (Python 3.9+).

    version = "X.Y.Z"   # top-level, before any section: the pin bin/appl read_pin reads;
                        # checked as a one-line string, never handed over or loaded
    gate = "local"      # top-level, before any section: one of GATE_WORDS (local | github);
                        # unset: local. github: finish-worktree.sh hands off, never lands
    [tests]
    command = "..."     # None when unset: finish-worktree.sh's own tools/run_tests.py
    [scan]
    command = "..."     # None when unset: finish-worktree.sh's own tools/sec_lint.py
    [ledger]
    command = "..."     # None when unset: no ledger command is handed over
    [lease]
    backend = "none"    # one of lease_core.BUILT (none | do | command | host); unset: lease_core.DEFAULT_BACKEND
    [muretai]
    coordinator  = "muretai-coordinator"     # each unset key: MURETAI_DEFAULTS, today's value
    agent        = "dispatch-mac-a"
    herd_dir     = "~/.cache/muretai-herd"
    dispatch_dir = "~/.muretai/dispatch"

    cfg = load(path)    # a missing file is the defaults; a refused one raises ConfigError
    names = muretai(path)
                        # the four [muretai] values as written (no ~ expansion); never
                        # raises: a missing, unreadable or refused appl.toml gives
                        # MURETAI_DEFAULTS. No consumer reads them yet.

The subset read: blank lines, `#` comments, `[section]` headers, and `key = "value"` lines
whose value is a basic ("...") or literal ('...') one-line string, optionally followed by a
comment. Anything else -- an unknown section or key, a dotted or quoted key, a duplicate,
a bare or multi-line value, a backend word lease_core does not build -- is refused, naming
it. Values are data: nothing read here is ever evaluated.

BACKEND_WORDS is lease_core.BUILT, read from the lease_core.py beside this root's
finish-worktree.sh, so the words appl.toml accepts are the backends the landing can run.
A root without lease_core.py (no landing lease to configure) falls back to FALLBACK_WORDS,
which tests/test_appl_lease_merge.py holds equal to the real lease_core.BUILT.

Run as a script:

    config.py handoff <appl.toml>    what `bin/appl land` hands to finish-worktree.sh, as
                                     NUL-terminated name/value pairs, and only the settings
                                     the file sets: APPL_TESTS_COMMAND, APPL_SCAN_COMMAND,
                                     APPL_LEDGER_COMMAND and LEASE_BACKEND
    config.py gate <appl.toml>       the top-level gate word the file sets, one line, or
                                     nothing when it sets none (finish-worktree.sh's
                                     hand-off check)
    config.py lands-locally <changes> <base.toml> <branch.toml>
                                     `yes` or `no`: whether the branch change <changes> (the
                                     NUL-separated `git diff-tree -r -z --no-renames
                                     --no-abbrev` of merge-base..tip) lands locally under
                                     gate = "github" (lands_locally). <base.toml> and
                                     <branch.toml> are appl.toml at the merge base and at the
                                     tip, "" when the commit has none
    config.py backend-words          BACKEND_WORDS, one per line (bin/appl's word check)
    config.py merge-lease <word> <base> <out>
                                     write <out> (a new file): the lease config <base> (the
                                     operator's; it may be absent) with its [lease] backend
                                     set to <word>. Every other line is kept byte for byte,
                                     and <base> itself is only read.

A refusal exits 2.
"""
from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path
from typing import Dict, Optional

SCHEMA = {
    "tests": ("command",),
    "scan": ("command",),
    "ledger": ("command",),
    "lease": ("backend",),
    "muretai": ("coordinator", "agent", "herd_dir", "dispatch_dir"),
}
MURETAI_DEFAULTS = {
    "coordinator": "muretai-coordinator",
    "agent": "dispatch-mac-a",
    "herd_dir": "~/.cache/muretai-herd",
    "dispatch_dir": "~/.muretai/dispatch",
}
# The skill's scripts/appl_config.py is a byte-identical copy of this file, the reader a
# consumer's landing gate trusts: there lease_core.py is its sibling.
LEASE_CORE = (Path(__file__).resolve().parent / "lease_core.py"
              if Path(__file__).resolve().parent.name == "scripts"
              else Path(__file__).resolve().parents[1] / ".cursor" / "skills" / "isolated-session"
              / "scripts" / "lease_core.py")
FALLBACK_WORDS = ("none", "do", "command", "host")
PIN_KEY = "version"
GATE_KEY = "gate"
GATE_WORDS = ("local", "github")

BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")
ESCAPES = {"\\": "\\", "\"": "\"", "b": "\b", "t": "\t", "n": "\n", "f": "\f", "r": "\r"}


class ConfigError(Exception):
    """appl.toml is refused; the message names the key, section or word."""


def _lease_core():
    spec = importlib.util.spec_from_file_location("appl_config_lease_core", str(LEASE_CORE))
    if spec is None or spec.loader is None:
        raise ConfigError("cannot find lease_core at %s" % LEASE_CORE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def default_backend() -> str:
    """lease_core.DEFAULT_BACKEND, read from the module so the two never drift."""
    return _lease_core().DEFAULT_BACKEND


def _backend_words() -> tuple:
    """lease_core.BUILT: the backends the landing lease can run, one source."""
    if not LEASE_CORE.is_file():
        return FALLBACK_WORDS
    return tuple(_lease_core().BUILT)


BACKEND_WORDS = _backend_words()


class Config:
    def __init__(self, values: Dict[str, Dict[str, str]], gate: Optional[str] = None) -> None:
        # The top-level gate word the file sets, or None (a local gate).
        self.gate: Optional[str] = gate
        self.tests_command: Optional[str] = values.get("tests", {}).get("command")
        self.scan_command: Optional[str] = values.get("scan", {}).get("command")
        self.ledger_command: Optional[str] = values.get("ledger", {}).get("command")
        # The backend word the file sets, or None; the default is resolved only on request.
        self.lease_backend_set: Optional[str] = values.get("lease", {}).get("backend")
        # The four [muretai] values, each the file's or its default.
        self.muretai: Dict[str, str] = dict(MURETAI_DEFAULTS, **values.get("muretai", {}))

    @property
    def lease_backend(self) -> str:
        return self.lease_backend_set if self.lease_backend_set is not None else default_backend()


def _string(rest: str, where: str) -> str:
    """Parse one string value from `rest` and check only a comment follows it."""
    if rest.startswith("\"\"\"") or rest.startswith("'''"):
        raise ConfigError("%s: multi-line strings are not read" % where)
    if rest.startswith("'"):
        end = rest.find("'", 1)
        if end < 0:
            raise ConfigError("%s: unterminated string" % where)
        value, tail = rest[1:end], rest[end + 1:]
    elif rest.startswith("\""):
        out = []
        i = 1
        while True:
            if i >= len(rest):
                raise ConfigError("%s: unterminated string" % where)
            ch = rest[i]
            if ch == "\"":
                break
            if ch == "\\":
                nxt = rest[i + 1:i + 2]
                if nxt in ESCAPES:
                    out.append(ESCAPES[nxt])
                    i += 2
                    continue
                if nxt in ("u", "U"):
                    width = 4 if nxt == "u" else 8
                    digits = rest[i + 2:i + 2 + width]
                    if len(digits) != width or not re.match(r"^[0-9A-Fa-f]+$", digits):
                        raise ConfigError("%s: bad \\%s escape" % (where, nxt))
                    code = int(digits, 16)
                    if code > 0x10FFFF or 0xD800 <= code <= 0xDFFF:
                        raise ConfigError("%s: bad \\%s escape" % (where, nxt))
                    out.append(chr(code))
                    i += 2 + width
                    continue
                raise ConfigError("%s: unknown escape \\%s" % (where, nxt))
            out.append(ch)
            i += 1
        value, tail = "".join(out), rest[i + 1:]
    else:
        raise ConfigError("%s: the value must be a quoted string" % where)
    tail = tail.strip()
    if tail and not tail.startswith("#"):
        raise ConfigError("%s: unexpected text after the value: %r" % (where, tail))
    if "\0" in value:
        raise ConfigError("%s: the value holds a NUL" % where)
    return value


def parse(text: str, name: str = "appl.toml") -> Config:
    values: Dict[str, Dict[str, str]] = {}
    section = None
    seen_sections = set()
    pinned = False
    gate = None
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        where = "%s:%d" % (name, n)
        if line.startswith("["):
            if line.startswith("[["):
                raise ConfigError("%s: arrays of tables are not read: %r" % (where, line))
            close = line.find("]")
            if close < 0:
                raise ConfigError("%s: unterminated section header %r" % (where, line))
            head = line[1:close].strip()
            tail = line[close + 1:].strip()
            if tail and not tail.startswith("#"):
                raise ConfigError("%s: unexpected text after [%s]: %r" % (where, head, tail))
            if head not in SCHEMA:
                raise ConfigError("%s: unknown section [%s] (known: %s)"
                                  % (where, head, ", ".join(sorted(SCHEMA))))
            if head in seen_sections:
                raise ConfigError("%s: section [%s] given twice" % (where, head))
            seen_sections.add(head)
            section = head
            continue
        key, eq, rest = line.partition("=")
        key = key.strip()
        if not eq:
            raise ConfigError("%s: expected key = \"value\", got %r" % (where, line))
        if not BARE_KEY.match(key):
            raise ConfigError("%s: unknown key %r" % (where, key))
        if section is None and key == PIN_KEY:
            # The pin bin/appl read_pin reads; checked as a value, never handed over.
            if pinned:
                raise ConfigError("%s: top-level key %r given twice" % (where, key))
            _string(rest.strip(), "%s: %s" % (where, key))
            pinned = True
            continue
        if section is None and key == GATE_KEY:
            if gate is not None:
                raise ConfigError("%s: top-level key %r given twice" % (where, key))
            value = _string(rest.strip(), "%s: %s" % (where, key))
            if value not in GATE_WORDS:
                raise ConfigError("%s: unknown gate %r (known: %s)"
                                  % (where, value, ", ".join(GATE_WORDS)))
            gate = value
            continue
        if section is None:
            raise ConfigError("%s: unknown top-level key %r (keys belong under [%s])"
                              % (where, key, "], [".join(sorted(SCHEMA))))
        if key not in SCHEMA[section]:
            raise ConfigError("%s: unknown key %r in [%s] (known: %s)"
                              % (where, key, section, ", ".join(SCHEMA[section])))
        got = values.setdefault(section, {})
        if key in got:
            raise ConfigError("%s: key %r in [%s] given twice" % (where, key, section))
        value = _string(rest.strip(), "%s: [%s] %s" % (where, section, key))
        if section == "lease" and key == "backend" and value not in BACKEND_WORDS:
            raise ConfigError("%s: unknown lease backend %r (known: %s)"
                              % (where, value, ", ".join(BACKEND_WORDS)))
        got[key] = value
    return Config(values, gate)


def load(path) -> Config:
    """Read appl.toml at `path`. A missing file is the defaults; ConfigError on a refusal."""
    p = Path(path)
    if not p.exists():
        if p.is_symlink():
            raise ConfigError("%s is a dangling symlink" % p)
        return Config({})
    if not p.is_file():
        raise ConfigError("%s is not a regular file" % p)
    try:
        text = p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        raise ConfigError("cannot read %s (%s)" % (p, e))
    return parse(text, str(p))


def muretai(path) -> Dict[str, str]:
    """The four [muretai] values of appl.toml at `path`, as written. Never raises: a
    missing, unreadable or refused file gives MURETAI_DEFAULTS."""
    try:
        return dict(load(path).muretai)
    except (ConfigError, OSError, ValueError):
        return dict(MURETAI_DEFAULTS)


def handoff(path) -> bytes:
    cfg = load(path)
    out = []
    for name, value in (("APPL_TESTS_COMMAND", cfg.tests_command),
                        ("APPL_SCAN_COMMAND", cfg.scan_command),
                        ("APPL_LEDGER_COMMAND", cfg.ledger_command),
                        ("LEASE_BACKEND", cfg.lease_backend_set)):
        if value is not None:
            out.append(name.encode("ascii") + b"\0" + value.encode("utf-8") + b"\0")
    return b"".join(out)


# Under gate = "github" a branch that only adds or edits security-review receipts and notes,
# or only takes the gate back to local, lands locally: a hand-off of the reviewer's own
# receipt, or of the revert, is how one hostile `gate = "github"` stalled every later
# landing (intake 20261028T172727Z). Exact path rules, never a glob: `*` in
# notes/security-review-*.md would match a `/`.
RECEIPT_TOP = (".security", "audit-receipts")
NOTE_TOP = "notes"
NOTE_PREFIX = "security-review-"
NOTE_SUFFIX = ".md"
REGULAR_MODE = "100644"
TOML_PATH = "appl.toml"


def review_path(path: str) -> bool:
    """Whether `path` is a review receipt (anywhere under the top-level
    .security/audit-receipts/) or a review note (notes/security-review-<name>.md, directly in
    the top-level notes/, <name> non-empty)."""
    parts = path.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return False
    if len(parts) > len(RECEIPT_TOP) and tuple(parts[:len(RECEIPT_TOP)]) == RECEIPT_TOP:
        return True
    if len(parts) == 2 and parts[0] == NOTE_TOP:
        name = parts[1]
        return (name.startswith(NOTE_PREFIX) and name.endswith(NOTE_SUFFIX)
                and len(name) > len(NOTE_PREFIX) + len(NOTE_SUFFIX))
    return False


def _without_gate(text: str) -> str:
    """`text` with each top-level gate line taken out, every other line kept as it is."""
    out = []
    in_section = False
    for raw in text.splitlines(True):
        line = raw.strip()
        if line.startswith("["):
            in_section = True
        elif (not in_section and "=" in line and not line.startswith("#")
              and line.partition("=")[0].strip() == GATE_KEY):
            continue
        out.append(raw)
    return "".join(out)


def gate_revert(base_text: str, branch_text: str) -> bool:
    """Whether appl.toml going from `base_text` to `branch_text` only sets the gate to local
    or removes the gate key: both files parse, the branch's gate is local or unset, and the
    two are equal byte for byte once their top-level gate lines are taken out."""
    try:
        base = parse(base_text)
        branch = parse(branch_text)
    except ConfigError:
        return False
    if base_text == branch_text or base.gate == branch.gate:
        return False
    if branch.gate not in (None, "local"):
        return False
    return _without_gate(base_text) == _without_gate(branch_text)


def _diff_records(raw: bytes):
    """(old mode, new mode, status, path) for each record of `git diff-tree -r -z
    --no-renames`; None for output this does not read."""
    fields = raw.split(b"\0")
    if fields and fields[-1] == b"":
        fields.pop()
    if len(fields) % 2:
        return None
    out = []
    for meta, path in zip(fields[0::2], fields[1::2]):
        words = meta.split(b" ")
        if len(words) != 5 or not words[0].startswith(b":"):
            return None
        try:
            name = path.decode("utf-8")
            old_mode, new_mode = words[0][1:].decode("ascii"), words[1].decode("ascii")
            status = words[4].decode("ascii")
        except UnicodeDecodeError:
            return None
        out.append((old_mode, new_mode, status, name))
    return out


def lands_locally(raw: bytes, base_text: Optional[str], branch_text: Optional[str]) -> bool:
    """Whether a branch whose change from the merge base is `raw` (see _diff_records) lands
    locally under gate = "github": every path is a review_path added or edited as a regular
    file, or the one path is appl.toml, edited in place, and gate_revert holds for appl.toml
    at the merge base (`base_text`) and at the tip (`branch_text`). Anything mixed with
    anything else is False."""
    records = _diff_records(raw)
    if not records:
        return False
    if all(status in ("A", "M") and new == REGULAR_MODE and review_path(path)
           for _old, new, status, path in records):
        return True
    if len(records) != 1:
        return False
    old, new, status, path = records[0]
    if path != TOML_PATH or status != "M" or old != REGULAR_MODE or new != REGULAR_MODE:
        return False
    if base_text is None or branch_text is None:
        return False
    return gate_revert(base_text, branch_text)


def _text_or_none(path: str) -> Optional[str]:
    if not path:
        return None
    return Path(path).read_text(encoding="utf-8")


def _lease_header(line: str) -> Optional[bool]:
    """For a section header line, whether it opens [lease] -- read exactly as
    lease_core.read_config reads it; None for any other line."""
    stripped = line.strip()
    if not stripped.startswith("["):
        return None
    return stripped.split("]", 1)[0][1:].strip() == "lease"


def _sets_backend(line: str) -> bool:
    """Whether a line inside [lease] sets `backend`, as lease_core.read_config reads it."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return False
    return stripped.partition("=")[0].strip() == "backend"


def merge_lease(word: str, base: Optional[str]) -> str:
    """The lease config text `base` (None: there is none) with its [lease] backend set to
    `word`. Every other line is kept exactly: each backend line in a [lease] section is
    replaced, else one is added under the first [lease] header, else a [lease] section is
    appended."""
    if word not in BACKEND_WORDS:
        raise ConfigError("unknown lease backend %r (known: %s)" % (word, ", ".join(BACKEND_WORDS)))
    setting = "backend = \"%s\"\n" % word
    if base is None:
        return "[lease]\n" + setting
    out = []
    in_lease = False
    first_header = None
    replaced = False
    for line in base.splitlines(True):
        head = _lease_header(line)
        if head is not None:
            in_lease = head
            if head and first_header is None:
                first_header = len(out)
        elif in_lease and _sets_backend(line):
            out.append(setting)
            replaced = True
            continue
        out.append(line)
    if not replaced and first_header is not None:
        if out[first_header] == out[first_header].rstrip("\r\n"):
            out[first_header] += "\n"
        out.insert(first_header + 1, setting)
    elif not replaced:
        if out and out[-1] == out[-1].rstrip("\r\n"):
            out[-1] += "\n"
        out.append("[lease]\n" + setting)
    return "".join(out)


def merge_lease_file(word: str, base, out) -> None:
    """merge_lease over the file `base` (only read, never written), into the new file `out`."""
    b = Path(base)
    text = None
    if b.exists() or b.is_symlink():
        if b.is_symlink() or not b.is_file():
            raise ConfigError("the lease configuration %s is not a regular file" % b)
        try:
            text = b.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            raise ConfigError("cannot read the lease configuration %s (%s)" % (b, e))
    merged = merge_lease(word, text)
    try:
        with open(str(out), "x", encoding="utf-8", newline="") as f:
            f.write(merged)
    except OSError as e:
        raise ConfigError("cannot write the merged lease configuration %s (%s)" % (out, e))


def main(argv) -> int:
    try:
        if len(argv) == 3 and argv[1] == "handoff":
            data = handoff(argv[2])
        elif len(argv) == 3 and argv[1] == "gate":
            gate = load(argv[2]).gate
            data = (gate + "\n").encode("ascii") if gate is not None else b""
        elif len(argv) == 5 and argv[1] == "lands-locally":
            try:
                raw = Path(argv[2]).read_bytes()
                local = lands_locally(raw, _text_or_none(argv[3]), _text_or_none(argv[4]))
            except (OSError, UnicodeDecodeError):
                local = False
            data = b"yes\n" if local else b"no\n"
        elif len(argv) == 2 and argv[1] == "backend-words":
            data = "".join(w + "\n" for w in BACKEND_WORDS).encode("ascii")
        elif len(argv) == 5 and argv[1] == "merge-lease":
            try:
                merge_lease_file(argv[2], argv[3], argv[4])
            except ConfigError as e:
                sys.stderr.write("appl: cannot merge appl.toml's lease backend: %s\n" % e)
                return 2
            return 0
        else:
            sys.stderr.write("usage: config.py handoff <appl.toml> | config.py gate <appl.toml>"
                             " | config.py lands-locally <changes> <base.toml> <branch.toml>"
                             " | config.py backend-words"
                             " | config.py merge-lease <word> <base> <out>\n")
            return 2
    except ConfigError as e:
        sys.stderr.write("appl: appl.toml refused: %s\n" % e)
        return 2
    sys.stdout.buffer.write(data)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
