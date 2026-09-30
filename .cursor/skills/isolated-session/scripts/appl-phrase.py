#!/usr/bin/env python3
"""appl-phrase: turn one sentence ("APPL this: XX", "queue XX") into an APPL filing.

    appl-phrase.py [--dry-run] [--backlog] -- "<sentence>"

The invocable APPL skill's one parser. The entry points (.claude/skills/appl/SKILL.md and
.cursor/rules/appl.mdc) hand it the person's sentence verbatim, as the ONE argument after
`--`, and do nothing else. It reads its phrases from appl-phrases.tsv beside it (UTF-8;
this source stays ASCII), and:

  * an intake phrase (A1) -> the argv of appl-add.sh beside it:
        <here>/appl-add.sh -- XX --repo <top> --branch <default> [--from F] [--solo]
  * an inbox phrase (A2), or --backlog -> the argv of appl-backlog-add.sh beside it:
        <here>/appl-backlog-add.sh -- <title> --repo <top> --priority P [--after A]
            [--note N] [--needs-ruling] [--solo] [--from F] --body XX

XX is the sentence with the trigger phrase removed and NOTHING else changed: priority,
after, note, ruling and records-only words stay in it (A8, C3). The title is XX, or, when
XX is over the backlog's 120-character limit, XX cut to 117 characters plus `...`; the
body is always XX in full. --from is $APPL_FROM, passed only when set. <top> is the git
top-level of the cwd and must be listed in the dispatch repos file ($DISPATCH_DIR/repos,
default ~/.muretai/dispatch/repos). <default> is origin/HEAD's branch, else `main` when
that branch exists.

--dry-run prints that argv as ONE JSON array line and exits 0. Otherwise it runs it --
never through a shell -- and prints ONE line naming what was filed, the repo, the
priority (inbox) and the path, in the sentence's language.

Refused (exit 1, one stderr line, nothing run): an empty requirement, a control character
(C0/C1, DEL, a line or paragraph separator, a bidi override), a cwd that is no git
checkout or is not listed, a repository with no default branch to name.
Ambiguous (A7; exit 4, ONE stdout line that is a question, nothing run): an intake and an
inbox phrase together; two priorities; an intake with a priority, after, note or ruling
word (appl-add.sh takes none of them); no trigger phrase and no --backlog; an after or
note word naming nothing, or two different things.
"""
import json
import os
import re
import stat
import subprocess
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
PHRASES = os.path.join(HERE, "appl-phrases.tsv")
ADD = os.path.join(HERE, "appl-add.sh")
BACKLOG_ADD = os.path.join(HERE, "appl-backlog-add.sh")

TITLE_MAX = 120
REPO_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
# the bidi embeddings, overrides and isolates: text that displays in another order than it reads
BIDI = set(range(0x202A, 0x202F)) | set(range(0x2066, 0x206A))
# where an EN after-target ends, and the separators before a JP one
AFTER_END = re.compile(r"[,;]")
# (the ideographic comma and full stop, the fullwidth comma and exclamation mark: chr() keeps
# this source ASCII)
JP_PUNCT = chr(0x3001) + chr(0x3002) + chr(0xFF0C)
TOKEN_SEP = re.compile("[\\s,;" + JP_PUNCT + "]+")
CLOSING = ".!" + chr(0x3002) + chr(0xFF01)

USAGE = 'usage: appl-phrase.py [--dry-run] [--backlog] -- "<sentence>"'


def refuse(msg):
    sys.stderr.write("appl-phrase: " + msg + "\n")
    sys.exit(1)


def usage(msg=""):
    sys.stderr.write(("appl-phrase: " + msg + "\n" if msg else "") + USAGE + "\n")
    sys.exit(2)


class Ask(Exception):
    """An ambiguous sentence: the message key and its fields."""

    def __init__(self, key, **fields):
        Exception.__init__(self, key)
        self.key = key
        self.fields = fields


# ---------------------------------------------------------------- the table

class Table(object):
    def __init__(self, path):
        self.triggers = []      # (kind, where, before, after)
        self.priority = []      # (P, word)
        self.after = []         # (side, word)
        self.note = []
        self.ruling = []
        self.solo = []
        self.msg = {}           # (key, lang) -> text
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except (OSError, UnicodeDecodeError) as e:
            refuse("cannot read the phrase table %s (%s)" % (path, e))
        for n, ln in enumerate(text.split("\n"), 1):
            if not ln.strip() or ln.startswith("#"):
                continue
            row = ln.split("\t")
            role = row[0]
            try:
                if role in ("intake", "inbox") and row[1] in ("prefix", "suffix") and len(row) == 3:
                    self.triggers.append((role, row[1], row[2] if row[1] == "prefix" else "",
                                          row[2] if row[1] == "suffix" else ""))
                elif role == "inbox" and row[1] == "around" and len(row) == 4:
                    self.triggers.append((role, "around", row[2], row[3]))
                elif role == "priority" and len(row) == 3 and row[1] in ("P0", "P1", "P2", "P3"):
                    self.priority.append((row[1], row[2]))
                elif role == "after" and len(row) == 3 and row[1] in ("before", "follows"):
                    self.after.append((row[1], row[2]))
                elif role in ("note", "ruling", "solo") and len(row) == 2:
                    getattr(self, role).append(row[1])
                elif role == "msg" and len(row) == 4 and row[2] in ("en", "ja"):
                    self.msg[(row[1], row[2])] = row[3]
                else:
                    raise IndexError
            except IndexError:
                refuse("the phrase table %s has a malformed line %d" % (path, n))
        for kind in ("intake", "inbox"):
            if not any(t[0] == kind for t in self.triggers):
                refuse("the phrase table %s has no %s phrase" % (path, kind))

    def say(self, key, lang, **fields):
        text = self.msg.get((key, lang)) or self.msg.get((key, "en"))
        if text is None:
            refuse("the phrase table has no message %r" % key)
        for k, v in fields.items():
            text = text.replace("{" + k + "}", v)
        return text


# ---------------------------------------------------------------- matching

def ascii_word(c):
    return c.isascii() and c.isalnum()


def eq(a, b):
    """equal, ASCII case ignored"""
    return len(a) == len(b) and (a == b or (a.isascii() and b.isascii() and a.lower() == b.lower()))


def match(s, before, after):
    """The text between `before` at the start of `s` and `after` at its end (whole words
    for ASCII edges), stripped; or None."""
    if len(s) < len(before) + len(after):
        return None
    if before:
        if not eq(s[:len(before)], before):
            return None
        if ascii_word(before[-1]) and len(s) > len(before) and not s[len(before)].isspace():
            return None
    if after:
        if not eq(s[len(s) - len(after):], after):
            return None
        i = len(s) - len(after)
        if ascii_word(after[0]) and i > len(before) and not s[i - 1].isspace():
            return None
    return s[len(before):len(s) - len(after)].strip()


def triggers_of(table, s):
    """Every (kind, consumed length, remainder) a trigger phrase matches `s` with. A
    suffix trigger may be followed by closing punctuation."""
    out = []
    tails = [s]
    t = s.rstrip(CLOSING).rstrip()
    if t != s:
        tails.append(t)
    for kind, _where, before, after in table.triggers:
        for cand in tails:
            if after or cand is s:
                rest = match(cand, before, after)
                if rest is not None:
                    out.append((kind, len(before) + len(after), rest))
    return out


def find_word(text, word):
    """Start offsets of `word` in `text` (a whole word when ASCII, case ignored)."""
    if word.isascii():
        pat = r"(?<![A-Za-z0-9])" + re.escape(word) + r"(?![A-Za-z0-9])"
        return [m.start() for m in re.finditer(pat, text, re.I)]
    return [m.start() for m in re.finditer(re.escape(word), text)]


def targets(text, word, side):
    """What each occurrence of an after/note word names: the token before it (before), the
    text after it up to a comma (follows), or the next token (next)."""
    out = []
    for i in find_word(text, word):
        if side == "before":
            parts = [p for p in TOKEN_SEP.split(text[:i]) if p]
            out.append(parts[-1] if parts else "")
        elif side == "follows":
            out.append(AFTER_END.split(text[i + len(word):], 1)[0].strip())
        else:
            parts = [p for p in TOKEN_SEP.split(text[i + len(word):].lstrip()) if p]
            out.append(parts[0] if parts else "")
    return out


def one_target(found, word):
    got = sorted(set(found))
    if "" in got:
        raise Ask("ask-empty-target", a=word)
    if len(got) > 1:
        raise Ask("ask-two-targets", a=word, b=", ".join(got))
    return got[0] if got else None


def parse(table, sentence, backlog):
    """(kind, XX, options) for the sentence; raises Ask when it is ambiguous."""
    s = sentence.strip()
    hits = triggers_of(table, s)
    kinds = set(k for k, _, _ in hits) | ({"inbox"} if backlog else set())
    if len(kinds) > 1:
        raise Ask("ask-both")
    if not hits:
        if not backlog:
            raise Ask("ask-no-trigger")
        kind, xx = "inbox", s
    else:
        kind, _, xx = max(hits, key=lambda h: h[1])
    # a trigger of the other kind still inside the requirement: both were said
    if xx and any(k != kind for k, _, _ in triggers_of(table, xx)):
        raise Ask("ask-both")

    prios = sorted(set(p for p, w in table.priority if find_word(xx, w)))
    if len(prios) > 1:
        raise Ask("ask-priorities", a=prios[0], b=prios[-1])
    after, note = [], []
    for side, w in table.after:
        after += [(w, t) for t in targets(xx, w, side)]
    for w in table.note:
        note += [(w, t) for t in targets(xx, w, "next")]
    ruling = any(find_word(xx, w) for w in table.ruling)
    solo = any(find_word(xx, w) for w in table.solo)
    if kind == "intake" and (prios or after or note or ruling):
        raise Ask("ask-intake-modifiers")
    opts = {
        "priority": prios[0] if prios else "P2",
        "after": one_target([t for _, t in after], after[0][0]) if after else None,
        "note": one_target([t for _, t in note], note[0][0]) if note else None,
        "ruling": ruling,
        "solo": solo,
    }
    return kind, xx, opts


# ---------------------------------------------------------------- the repository

def git(cwd, *args):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")
    try:
        r = subprocess.run(["git", "-C", cwd] + list(args), capture_output=True, text=True, env=env)
    except OSError:
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def listed_name(top):
    """The name `top` is listed under in the dispatch repos file, or None (the same reading
    as appl-backlog-add.sh: `<name>=<path>` lines, a regular file, never a symlink)."""
    home = os.environ.get("HOME", "")
    ddir = os.environ.get("DISPATCH_DIR") or (os.path.join(home, ".muretai", "dispatch") if home else "")
    if not ddir:
        return None
    try:
        fd = os.open(os.path.join(ddir, "repos"), os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        text = os.read(fd, 1 << 16).decode("utf-8", "replace")
    finally:
        os.close(fd)
    want = os.path.realpath(top)
    for ln in text.split("\n"):
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        name, sep, p = ln.partition("=")
        name, p = name.strip(), p.strip()
        if sep and REPO_NAME.fullmatch(name) and p.startswith("/") and os.path.realpath(p) == want:
            return name
    return None


def default_branch(top):
    ref = git(top, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
    if ref and ref.startswith("refs/remotes/origin/") and len(ref) > len("refs/remotes/origin/"):
        return ref[len("refs/remotes/origin/"):]
    if git(top, "rev-parse", "--verify", "--quiet", "refs/heads/main") is not None:
        return "main"
    refuse("%s has no default branch to name: no origin/HEAD and no main branch "
           "(git remote set-head origin --auto sets origin/HEAD); nothing filed" % top)


# ---------------------------------------------------------------- main

def control(s):
    return next((c for c in s if unicodedata.category(c) in ("Cc", "Zl", "Zp") or ord(c) in BIDI
                 or len(("x" + c + "x").splitlines()) > 1), None)


def japanese(s):
    return any(0x3040 <= ord(c) <= 0x30FF or 0x4E00 <= ord(c) <= 0x9FFF or 0xFF00 <= ord(c) <= 0xFFEF
               for c in s)


def main(argv):
    dry = backlog = False
    while argv and argv[0] != "--":
        if argv[0] == "--dry-run":
            dry = True
        elif argv[0] == "--backlog":
            backlog = True
        else:
            usage("unknown argument: " + argv[0])
        argv = argv[1:]
    if len(argv) != 2:
        usage("give the sentence as the one argument after --")
    sentence = argv[1]
    bad = control(sentence)
    if bad is not None:
        refuse("the sentence holds a control character (U+%04X); say it on one line; nothing filed" % ord(bad))
    if not sentence.strip():
        refuse("the sentence is empty; nothing filed")

    table = Table(PHRASES)
    lang = "ja" if japanese(sentence) else "en"
    try:
        kind, xx, opts = parse(table, sentence, backlog)
    except Ask as a:
        print(table.say(a.key, lang, **a.fields))
        return 4
    if not xx:
        refuse("the requirement is empty: say what to APPL; nothing filed")

    cwd = os.getcwd()
    top = git(cwd, "rev-parse", "--show-toplevel")
    if not top:
        refuse("%s is not a git checkout; run it from the repository the requirement is about; nothing filed" % cwd)
    name = listed_name(top)
    if name is None:
        refuse("%s is not listed in the dispatch repos (dispatch-init.sh --repo <name>=<path>); nothing filed" % top)
    frm = os.environ.get("APPL_FROM") or ""

    if kind == "intake":
        argv = [ADD, "--", xx, "--repo", top, "--branch", default_branch(top)]
        argv += (["--from", frm] if frm else []) + (["--solo"] if opts["solo"] else [])
    else:
        title = xx if len(xx) <= TITLE_MAX else xx[:TITLE_MAX - 3] + "..."
        argv = [BACKLOG_ADD, "--", title, "--repo", top, "--priority", opts["priority"]]
        argv += ["--after", opts["after"]] if opts["after"] else []
        argv += ["--note", opts["note"]] if opts["note"] else []
        argv += ["--needs-ruling"] if opts["ruling"] else []
        argv += ["--solo"] if opts["solo"] else []
        argv += (["--from", frm] if frm else []) + ["--body", xx]

    if dry:
        print(json.dumps(argv))
        return 0
    try:
        r = subprocess.run(["bash"] + argv, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    except OSError as e:
        refuse("cannot run %s (%s); nothing filed" % (argv[0], e))
    path = r.stdout.strip().split("\n")[-1] if r.stdout.strip() else ""
    if not path.startswith("/"):
        why = (r.stderr.strip().split("\n") or [""])[0]
        refuse("%s filed nothing (exit %d): %s" % (os.path.basename(argv[0]), r.returncode, why))
    key = "filed-intake" if kind == "intake" else "filed-inbox"
    print(table.say(key, lang, name=name, prio=opts["priority"], path=path))
    if r.returncode != 0:
        # filed but not woken (appl-add.sh exit 3): pass its one line on, unchanged
        sys.stderr.write(r.stderr)
    return r.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
