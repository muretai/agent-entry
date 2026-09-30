#!/usr/bin/env bash
# appl-backlog-add: put one idea into a project's backlog inbox, without landing anything.
# The loop (appl-backlog-pull.sh, on a landing, on SessionStart and on a herd-watch pass
# with a free slot) files it as an APPL intake later, by itself.
#
# The real script is tools/appl-backlog-add.sh. The skill's scripts/appl-backlog-add.sh is a
# byte-identical copy, so vendor.sh carries it to every consumer (appl-phrase.py, the
# invocable APPL skill's parser, runs that copy); `vendor.sh check` in the home refuses a
# drifted copy.
#
#   tools/appl-backlog-add.sh [--] "<title>" --repo <path> [--note <path|url>]
#                             [--priority P0|P1|P2|P3] [--after <intake id or title>]
#                             [--solo] [--skeleton] [--needs-ruling] [--parent <intake id>]
#                             [--from <harness:session>] [--body <text>]
#
# The body -- the requirement text -- is --body, else stdin. It is DATA: written byte for
# byte (a --body gets a final newline), never run, never parsed; a body line that looks
# like a header line is body.
#
# The namespace is the NAME --repo is listed under in the dispatch repos file
# ($DISPATCH_DIR/repos, default ~/.muretai/dispatch/repos; `<name>=<path>` lines, the
# format dispatch-init.sh writes): --repo must resolve to one listed path. The file is
#
#   $HERD_DIR/coordinator/backlog/<name>/inbox/<YYYYMMDDTHHMMSSZ>-<slug>.md
#
# (HERD_DIR defaults to ~/.cache/muretai-herd; the stamp is the UTC time of the call), mode
# 644 whatever the umask, written whole (a temporary file, then a link), never overwritten
# (a name taken in the same second gets -2, -3, ...). Its absolute path is the only stdout
# line. The file: header lines `key: value` -- title, repo (the name), from, priority (P2
# when not given), class (only with --skeleton: `class: skeleton`; the pull reads no class
# as polish and files skeleton items first), note and after (only when given), parent
# (only with --parent: `parent: <intake id>`, the item a split chain was cut from), solo
# (yes|no), needs-ruling (only with --needs-ruling: the pull files it as a question
# intake) -- then one blank line, then the body.
#
# Refused, exit 2 (usage) or 1, with nothing written: a title that is empty, holds a
# control character or is over 120 characters; a --repo not listed in the dispatch repos
# (or no repos file, or a symlinked one); a --note path with a `..` component or that is a
# symlink; a priority other than P0..P3; a control character in --from, --note or
# --after; a --parent that is not an intake id (`YYYYMMDDTHHMMSSZ`, optionally `-N`); an
# --after in the long form `<stamp>-<slug>` (an intake's file name, not its id); an
# empty body. A note is a string: it is never opened, read or fetched here or
# by the pull (the symlink check is an lstat).
set -u

IFS= read -r -d '' APPL_BACKLOG_ADD_PY <<'PY'
import os, re, stat, sys, time

TITLE_MAX = 120
PRIORITIES = ("P0", "P1", "P2", "P3")
REPO_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
# an intake id, as .cursor/skills/isolated-session/scripts/intake_id.py resolves one:
# `<stamp>`, or `<stamp>-N` for the N-th intake of that second
STAMP = re.compile(r"[0-9]{8}T[0-9]{6}Z")
INTAKE_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z(?:-[1-9][0-9]*)?")


def die(msg, code=1):
    sys.stderr.write("appl-backlog-add: " + msg + "\n")
    sys.exit(code)


def usage(msg=""):
    if msg:
        sys.stderr.write("appl-backlog-add: " + msg + "\n")
    sys.stderr.write('usage: appl-backlog-add.sh [--] "<title>" --repo <path> [--note <path|url>]'
                     " [--priority P0|P1|P2|P3] [--after <id|title>] [--solo] [--skeleton] [--needs-ruling]"
                     " [--parent <intake id>]"
                     " [--from <harness:session>] [--body <text>]\n")
    sys.exit(2)


def control(s):
    """a character a header reader could split on or a terminal could act on"""
    return any(ord(c) < 0x20 or 0x7f <= ord(c) < 0xa0 or len(("x" + c + "x").splitlines()) > 1
               for c in s)


def intake_id_ok(s):
    """an intake id: YYYYMMDDTHHMMSSZ, optionally -N (N >= 1, no leading zero), and nothing
    else"""
    return INTAKE_ID.fullmatch(s) is not None


def long_form(s):
    """an intake FILE NAME's `<stamp>-<slug>` (not an id): a stamp, then more than an -N"""
    return STAMP.match(s) is not None and not intake_id_ok(s)


def listed_name(repo):
    """the name --repo is listed under in the dispatch repos file, or None"""
    home = os.environ.get("HOME", "")
    ddir = os.environ.get("DISPATCH_DIR") or (os.path.join(home, ".muretai", "dispatch") if home else "")
    if not ddir:
        return None
    path = os.path.join(ddir, "repos")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        text = os.read(fd, 1 << 16).decode("utf-8", "replace")
    finally:
        os.close(fd)
    want = os.path.realpath(repo)
    for ln in text.split("\n"):
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        name, sep, p = ln.partition("=")
        name, p = name.strip(), p.strip()
        if sep and REPO_NAME.fullmatch(name) and p.startswith("/") and os.path.realpath(p) == want:
            return name
    return None


def main(argv):
    if argv and argv[0] == "--":
        if len(argv) < 2:
            usage()
        title, rest = argv[1], argv[2:]
    elif argv and not argv[0].startswith("--"):
        title, rest = argv[0], argv[1:]
    else:
        usage()
    opts = {"--priority": "P2", "--from": os.environ.get("APPL_FROM") or "unknown"}
    flags = set()
    while rest:
        a = rest[0]
        if a in ("--solo", "--skeleton", "--needs-ruling"):
            flags.add(a)
            rest = rest[1:]
        elif a in ("--repo", "--note", "--priority", "--after", "--from", "--body", "--parent"):
            if len(rest) < 2:
                usage()
            opts[a] = rest[1]
            rest = rest[2:]
        else:
            usage("unknown argument")
    if control(title) or not title.strip():
        usage("the title is empty or holds a control character")
    if len(title) > TITLE_MAX:
        usage("the title is over %d characters" % TITLE_MAX)
    if opts["--priority"] not in PRIORITIES:
        usage("--priority takes P0, P1, P2 or P3")
    for k in ("--from", "--note", "--after", "--repo"):
        if k in opts and control(opts[k]):
            usage(k + " holds a control character")
    if "--parent" in opts and not intake_id_ok(opts["--parent"]):
        usage("--parent takes an intake id: YYYYMMDDTHHMMSSZ, optionally -N")
    if long_form(opts.get("--after", "")):
        usage("--after takes an intake id (YYYYMMDDTHHMMSSZ, optionally -N) or a title;"
              " <stamp>-<slug> is a file name, not an id")
    if len(opts["--from"]) > 200 or len(opts.get("--after", "")) > TITLE_MAX:
        usage("--from or --after is too long")
    note = opts.get("--note")
    if note is not None and not re.match(r"[A-Za-z][A-Za-z0-9+.-]*://", note):
        # a path: never opened -- only its spelling and an lstat are looked at
        if not note or ".." in note.split("/"):
            usage("--note: a path with a `..` component is refused")
        if os.path.islink(note):
            usage("--note: a symlink is refused")
    if "--repo" not in opts:
        usage("--repo is required")
    name = listed_name(opts["--repo"])
    if name is None:
        die("--repo is not listed in the dispatch repos (dispatch-init.sh --repo <name>=<path>); nothing written")

    if "--body" in opts:
        body = opts["--body"].encode("utf-8", "surrogateescape")
        if not body.endswith(b"\n"):
            body += b"\n"
    else:
        body = sys.stdin.buffer.read()
    if not body.strip():
        usage("no body: give the requirement text with --body or on stdin")

    head = ["title: " + title, "repo: " + name, "from: " + opts["--from"],
            "priority: " + opts["--priority"]]
    if "--skeleton" in flags:
        head.append("class: skeleton")
    if note is not None:
        head.append("note: " + note)
    if opts.get("--after"):
        head.append("after: " + opts["--after"])
    if "--parent" in opts:
        head.append("parent: " + opts["--parent"])
    head.append("solo: " + ("yes" if "--solo" in flags else "no"))
    if "--needs-ruling" in flags:
        head.append("needs-ruling: yes")
    data = ("\n".join(head) + "\n\n").encode("utf-8", "surrogateescape") + body

    home = os.environ.get("HOME", "")
    herd = os.environ.get("HERD_DIR") or (os.path.join(home, ".cache", "muretai-herd") if home else "")
    if not herd:
        die("neither HERD_DIR nor HOME is set; nowhere to write the idea")
    herd = os.path.abspath(herd)
    box = herd
    for part in ("coordinator", "backlog", name, "inbox"):
        box = os.path.join(box, part)
        if os.path.islink(box):
            die(box + " is a symlink; nothing written")
        try:
            os.mkdir(box, 0o755 if part in (name, "inbox") else 0o700)
        except FileExistsError:
            pass
        except OSError as e:
            die("cannot create %s (%s); nothing written" % (box, e.strerror))
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    slug = re.sub(r"-+", "-", re.sub(r"[^A-Za-z0-9]", "-", title))[:40].strip("-") or "idea"
    tmp = os.path.join(box, ".add-%d.tmp" % os.getpid())
    try:
        if os.path.lexists(tmp):
            os.unlink(tmp)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            os.fchmod(fd, 0o644)
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
        finally:
            os.close(fd)
    except OSError as e:
        die("cannot write under %s (%s); nothing written" % (box, e.strerror))
    try:
        for n in range(1, 51):
            path = os.path.join(box, "%s-%s%s.md" % (stamp, slug, "" if n == 1 else "-%d" % n))
            try:
                os.link(tmp, path)            # never overwrites a name already taken
            except FileExistsError:
                continue
            except OSError as e:
                die("cannot write under %s (%s); nothing written" % (box, e.strerror))
            print(path)
            return 0
        die("could not find a free file name under " + box)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


sys.exit(main(sys.argv[1:]))
PY

exec python3 -I -c "$APPL_BACKLOG_ADD_PY" "$@"
