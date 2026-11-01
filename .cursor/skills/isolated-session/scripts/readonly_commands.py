"""readonly_commands.py -- the one loader of the read-only command list.

readonly-commands.tsv, beside this file, is the single source of the commands a herd pane
runs without an approval prompt on any harness (intake 20261007T152501Z). herd-spawn.sh
renders it into each harness profile and herd-watch.sh derives its SAFE table from it; both
load this file by absolute path from their own directory (`python3 -I` keeps the directory
off sys.path), so a copied skill reads its own list.

load(path=None) returns the rows as entries with `.words` and `.refused`, both tuples of
str. A malformed list is an error -- ValueError, or OSError for a file that cannot be
read -- never an empty or a partial list. Stdlib only, Python 3.9.
"""

import collections
import os
import re

LIST_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "readonly-commands.tsv")

Entry = collections.namedtuple("Entry", ["words", "refused"])

# A command word: no shell syntax, no glob, no quote, no assignment (`PATH=x ls` is not a
# command), and no leading dash. `:` is a legal command-name character; whether a harness's
# rule syntax can name it is that harness's renderer's question.
_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:+/-]*")
# A refused flag: a dash first; a trailing `*` makes it a prefix.
_FLAG = re.compile(r"-[A-Za-z0-9-][A-Za-z0-9._-]*\*?")


def _row(line, lineno):
    where = "line %d" % lineno
    fields = line.split("\t")
    if len(fields) > 2:
        raise ValueError(where + ": more than two tab-separated fields")
    words = fields[0].split(" ")
    if any(not w for w in words):
        raise ValueError(where + ": command words must be one space apart, with no leading or trailing space")
    for w in words:
        if not _WORD.fullmatch(w):
            raise ValueError(where + ": %r is not a plain command word" % w)
    refused = ()
    if len(fields) == 2:
        refused = tuple(fields[1].split(" "))
        for f in refused:
            if not _FLAG.fullmatch(f):
                raise ValueError(where + ": %r is not a flag (a refused flag starts with '-')" % f)
    return Entry(tuple(words), refused)


def load(path=None):
    path = LIST_PATH if path is None else os.fspath(path)
    with open(path, "rb") as f:
        data = f.read()
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        raise ValueError(path + ": the list is not ASCII")
    entries, seen = [], set()
    for lineno, line in enumerate(text.split("\n"), 1):
        if not line.strip() or line.startswith("#"):
            continue
        if any(ord(c) < 0x20 and c != "\t" for c in line) or "\x7f" in line:
            raise ValueError("%s: line %d carries a control character" % (path, lineno))
        try:
            entry = _row(line, lineno)
        except ValueError as e:
            raise ValueError(path + ": " + str(e))
        if entry.words in seen:
            raise ValueError("%s: line %d repeats %r" % (path, lineno, " ".join(entry.words)))
        seen.add(entry.words)
        entries.append(entry)
    if not entries:
        raise ValueError(path + ": the list has no command")
    return entries


def refuses(entry, flag):
    """True when `flag` is one `entry` may never carry."""
    for r in entry.refused:
        if r == flag or (r.endswith("*") and flag.startswith(r[:-1])):
            return True
    return False
