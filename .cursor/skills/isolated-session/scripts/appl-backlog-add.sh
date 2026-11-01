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
#                             [--priority P0|P1|P2|P3] [--estimate S|M|L]
#                             [--after <intake id or title>]
#                             [--solo] [--skeleton] [--needs-ruling] [--parent <intake id>]
#                             [--from <harness:session>] [--body <text>]
#   tools/appl-backlog-add.sh --resolve-after "<intake id or title>"
#
# An --after title is resolved when the item is filed, across every dispatch repo: each
# repo's backlog inbox/ and filed/ item titles, its docs/BACKLOG.md `## Next`, `## Now` and
# `## Done` line titles, and the `title:` header and `## Task` first line of the intakes the
# coordinator's filer wrote: those with a filed_by_add record, $HERD_DIR/coordinator/filed/
# <intake file name> holding `<name> sha256:<task digest>` (appl-hook.sh's filed_by_add). An
# intake with no such record, or whose task changed since, is never an item, and a filed
# item's `intake:` or a BACKLOG.md bracket id counts as an id only when a recorded intake
# carries it (else that place is a no-id title). A file that cannot be read or parsed is
# skipped alone, and each read stops at READ_MAX + 1 bytes. Titles
# compare as appl-backlog-pull.sh's title_state compares them: exactly, each side without a
# leading P0..P3 word. One item found by several routes is one item: a no-id title in a repo
# whose recorded intake of the same title names that repo is that intake. The item stores what
# the title resolved to: the intake id when one exists, otherwise `<repo>:<title>`. An
# --after that is an intake id is stored as given, unchecked. An --after that names no item,
# or several, is refused (exit 1, one stderr line naming up to three nearest titles, by
# difflib, or the several items; nothing written). --resolve-after prints what an --after
# would store and writes nothing: exit 0, or that one stderr line with exit 1 (no item) or
# 3 (several items).
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
# (only with --parent: `parent: <intake id>`, the item a split chain was cut from; when
# that intake is owner P0 -- intake_id.owner_p0, its header's `owner-priority: P0` or its
# own `parent:` chain's -- the priority is P0 whatever --priority said, and the header
# carries `owner-priority: P0` after it), estimate (only with --estimate: S under about an
# hour of pair work, M a few hours, L more; the pull files the smaller first), solo
# (yes|no), needs-ruling (only with --needs-ruling: the pull files it as a question
# intake) -- then one blank line, then the body.
#
# Refused, exit 2 (usage) or 1, with nothing written: a title that is empty, holds a
# control character or is over 120 characters; a --repo not listed in the dispatch repos
# (or no repos file, or a symlinked one); a --note path with a `..` component or that is a
# symlink; a priority other than P0..P3; an estimate other than S, M or L; a control
# character in --from, --note or --after; a --parent that is not an intake id (`YYYYMMDDTHHMMSSZ`, optionally `-N`); an
# --after in the long form `<stamp>-<slug>` (an intake's file name, not its id); an
# empty body; a body holding a NUL or bytes that are not UTF-8 (exit 1, one stderr line
# that never echoes the body). A note is a string: it is never opened, read or fetched here or
# by the pull (the symlink check is an lstat).
set -u

IFS= read -r -d '' APPL_BACKLOG_ADD_PY <<'PY'
import difflib, hashlib, os, re, stat, sys, time

TITLE_MAX = 120
PRIORITIES = ("P0", "P1", "P2", "P3")
ESTIMATES = ("S", "M", "L")
REPO_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
# an intake id, as .cursor/skills/isolated-session/scripts/intake_id.py resolves one:
# `<stamp>`, or `<stamp>-N` for the N-th intake of that second
STAMP = re.compile(r"[0-9]{8}T[0-9]{6}Z")
INTAKE_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z(?:-[1-9][0-9]*)?")
# an inbox or filed/ item's file name, and a bracket id on a docs/BACKLOG.md line, as
# appl-backlog-pull.sh reads them
ITEM_NAME = re.compile(r"[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9][A-Za-z0-9_-]{0,160}\.md")
TAG = re.compile(r"\[(" + INTAKE_ID.pattern + r")\]")
READ_MAX = 1 << 20


def die(msg, code=1):
    sys.stderr.write("appl-backlog-add: " + msg + "\n")
    sys.exit(code)


def usage(msg=""):
    if msg:
        sys.stderr.write("appl-backlog-add: " + msg + "\n")
    sys.stderr.write('usage: appl-backlog-add.sh [--] "<title>" --repo <path> [--note <path|url>]'
                     " [--priority P0|P1|P2|P3] [--estimate S|M|L] [--after <id|title>] [--solo] [--skeleton] [--needs-ruling]"
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


def owner_p0(intake_dir, ident):
    """intake_id.owner_p0 (the skill's scripts/intake_id.py only, never a sibling elsewhere):
    the parent's chain carries the owner marker"""
    path = os.environ.get("APPL_BACKLOG_ADD_IDS", "")
    if not path:
        die("--parent: cannot find scripts/intake_id.py; nothing written")
    import importlib.util
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("intake_id", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.owner_p0(intake_dir, ident)


def dispatch_repos():
    """(name, path) of each `<name>=<path>` line of the dispatch repos file; [] when there is
    no file, or it is a symlink or not a regular file"""
    home = os.environ.get("HOME", "")
    ddir = os.environ.get("DISPATCH_DIR") or (os.path.join(home, ".muretai", "dispatch") if home else "")
    if not ddir:
        return []
    path = os.path.join(ddir, "repos")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return []
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return []
        text = os.read(fd, 1 << 16).decode("utf-8", "replace")
    finally:
        os.close(fd)
    out = []
    for ln in text.split("\n"):
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        name, sep, p = ln.partition("=")
        name, p = name.strip(), p.strip()
        if sep and REPO_NAME.fullmatch(name) and p.startswith("/"):
            out.append((name, p))
    return out


def listed_name(repo):
    """the name --repo is listed under in the dispatch repos file, or None"""
    want = os.path.realpath(repo)
    for name, p in dispatch_repos():
        if os.path.realpath(p) == want:
            return name
    return None


def herd_dir():
    home = os.environ.get("HOME", "")
    herd = os.environ.get("HERD_DIR") or (os.path.join(home, ".cache", "muretai-herd") if home else "")
    if not herd:
        die("neither HERD_DIR nor HOME is set; nowhere to write the idea")
    return os.path.abspath(herd)


def read_text(path):
    """the text of the regular file at <path>, never through a symlink, or None. The read
    stops at READ_MAX + 1 bytes whatever fstat said: a file past READ_MAX by then, one that
    grew after the size check included, is None"""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
    except (OSError, ValueError):
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > READ_MAX:
            return None
        chunks, size = [], 0
        while size <= READ_MAX:
            b = os.read(fd, min(1 << 16, READ_MAX + 1 - size))
            if not b:
                break
            chunks.append(b)
            size += len(b)
        if size > READ_MAX:
            return None
        return b"".join(chunks).decode("utf-8", "replace")
    except OSError:
        return None
    finally:
        os.close(fd)


def head_of(text):
    """the `key: value` lines before the first blank line, as a dict (first key wins)"""
    out = {}
    for ln in text.partition("\n\n")[0].split("\n"):
        k, sep, v = ln.partition(":")
        if sep and k and k not in out:
            out[k] = v.strip()
    return out


def bare_title(title):
    """<title> as an after-title is compared (appl-backlog-pull.sh's bare_title): without a
    leading P0..P3 word and its space"""
    return re.sub(r"^P[0-3] ", "", title.strip())


def filed_by_add(herd, name, text):
    """does the coordinator's filer vouch for the intake file <name> whose text is <text>?
    The record appl-hook.sh's filed_by_add reads: $HERD_DIR/coordinator/filed/<name>, one
    line `<name> sha256:<hex>`, the hex of the task as its task_of() reads it (the text
    under `## Task` after the header's blank line, newlines read as open() reads them,
    trailing newlines stripped). No record, a symlink, a file that is not regular, any
    other content, or a task changed since: False"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    body = text.split("\n\n", 1)[1] if "\n\n" in text else ""
    if body.startswith("## Task\n"):
        body = body[len("## Task\n"):]
    digest = hashlib.sha256(body.rstrip("\n").encode("utf-8", "surrogateescape")).hexdigest()
    want = (name + " sha256:" + digest + "\n").encode("utf-8", "surrogateescape")
    try:
        fd = os.open(os.path.join(herd, "coordinator", "filed", name),
                     os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
    except (OSError, ValueError):
        return False
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return False
        return os.read(fd, len(want) + 1) == want
    except OSError:
        return False
    finally:
        os.close(fd)


def trusted_intake(herd, d, n, real):
    """(intake id, repo name or None, [titles]) of the intake file <n> under <d> when the
    filer wrote it (filed_by_add), else None"""
    text = read_text(os.path.join(d, n)) if STAMP.match(n) and n.endswith(".md") else None
    if text is None:
        return None
    head = head_of(text)
    ident = head.get("id", "")
    if not intake_id_ok(ident) or not filed_by_add(herd, n, text):
        return None
    repo = head.get("repo", "")
    repo = real.get(os.path.realpath(repo)) if repo.startswith("/") else None
    titles = [head["title"]] if head.get("title") else []
    _pre, sep, task = text.partition("\n## Task\n")
    if sep:
        titles.append(task.split("\n", 1)[0])
    return ident, repo, titles


def known_items(herd):
    """(bare title, intake id or None, repo name or None) for each place an --after title
    can name: every dispatch repo's inbox/ and filed/ items and docs/BACKLOG.md Next, Now
    and Done lines, and the `title:` header and `## Task` first line of every intake the
    coordinator's filer wrote (filed_by_add). An intake with no record is never read as an
    item, and a filed item's `intake:` or a BACKLOG.md bracket id counts only when such an
    intake carries it (else the place is a no-id hit). A file that cannot be read or
    parsed is skipped, alone. Each id hit's repo is the repo its intake names"""
    repos = dispatch_repos()
    real = {}
    for n, p in repos:
        try:
            real.setdefault(os.path.realpath(p), n)
        except (OSError, ValueError):
            pass
    intakes = []
    d = os.path.join(herd, "coordinator", "intake")
    try:
        names = sorted(os.listdir(d))
    except OSError:
        names = []
    for n in names:
        try:
            it = trusted_intake(herd, d, n, real)
        except Exception:                   # one bad file never stops the resolver
            it = None
        if it is not None:
            intakes.append(it)
    home = {}
    for ident, repo, _titles in intakes:
        home.setdefault(ident, repo)
    out = []

    def place(title, ident, name):
        """a place in repo <name>: an id hit, of the repo its intake names, when a trusted
        intake carries <ident>; else a no-id hit of <name>"""
        if ident in home:
            out.append((bare_title(title), ident, home[ident]))
        else:
            out.append((bare_title(title), None, name))

    for name, path in repos:
        for box in ("inbox", "filed"):
            d = os.path.join(herd, "coordinator", "backlog", name, box)
            try:
                names = sorted(os.listdir(d))
            except OSError:
                names = []
            for n in names:
                try:
                    text = read_text(os.path.join(d, n)) if ITEM_NAME.fullmatch(n) else None
                    head = head_of(text) if text is not None else {}
                    if head.get("title"):
                        place(head["title"], head.get("intake", "") if box == "filed" else "", name)
                except Exception:           # one bad file never stops the resolver
                    pass
        section = None
        try:
            lines = (read_text(os.path.join(path, "docs", "BACKLOG.md")) or "").split("\n")
        except Exception:                   # one bad file never stops the resolver
            lines = []
        for ln in lines:
            if ln.startswith("## "):
                section = next((w for w in ("Next", "Now", "Done") if ln.startswith("## " + w)), None)
                continue
            if section is None or not ln.startswith("- "):
                continue
            head, sep, _rest = ln[2:].partition(": ")
            if sep:
                ids = TAG.findall(ln)
                place(head, ids[0] if len(ids) == 1 else "", name)
    for ident, repo, titles in intakes:
        for t in titles:
            if bare_title(t):
                out.append((bare_title(t), ident, repo))
    return out


def shown(s, n=80):
    """<s> for the one stderr line: no control character, at most <n> characters"""
    s = "".join("?" if control(c) else c for c in s)
    return s if len(s) <= n else s[:n - 3] + "..."


def resolve_after(herd, after):
    """(state, value): ("one", what the item stores), or ("none" | "several", the one
    refusal line). An intake id is stored as given, unchecked."""
    if intake_id_ok(after):
        return "one", after
    want = bare_title(after)
    known = known_items(herd)
    hits = [k for k in known if k[0] == want]
    ids = sorted(set(i for _t, i, _r in hits if i))
    by_id = set(r for _t, i, r in hits if i and r)
    keys = ids + sorted(set("%s:%s" % (r, want) for _t, i, r in hits if not i and r not in by_id))
    if len(keys) == 1:
        return "one", keys[0]
    if keys:
        return "several", ('--after "%s" names %d items: %s -- give one intake id; nothing written'
                           % (shown(after), len(keys), ", ".join(shown(k) for k in keys[:5])
                              + (", ..." if len(keys) > 5 else "")))
    near = difflib.get_close_matches(want, sorted(set(t for t, _i, _r in known if t)), n=3)
    return "none", ('--after "%s" names no item in any dispatch repo; %s; nothing written'
                    % (shown(after), "nearest: " + ", ".join('"%s"' % shown(t) for t in near)
                       if near else "no title is near it"))


def main(argv):
    if argv[:1] == ["--resolve-after"]:
        if len(argv) != 2 or control(argv[1]) or not argv[1].strip():
            usage("--resolve-after takes one --after value")
        if long_form(argv[1]):
            usage("--after takes an intake id (YYYYMMDDTHHMMSSZ, optionally -N) or a title;"
                  " <stamp>-<slug> is a file name, not an id")
        state, value = resolve_after(herd_dir(), argv[1])
        if state != "one":
            die(value, 1 if state == "none" else 3)
        print(value)
        return 0
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
        elif a in ("--repo", "--note", "--priority", "--estimate", "--after", "--from", "--body", "--parent"):
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
    if "--estimate" in opts and opts["--estimate"] not in ESTIMATES:
        usage("--estimate takes S, M or L")
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
    # a NUL, or bytes that are not UTF-8, could never reach appl-add's argv: refused here,
    # in one line that never echoes the body
    try:
        body.decode("utf-8", "strict")
    except UnicodeDecodeError:
        die("the body holds bytes that are not UTF-8; nothing written")
    if b"\0" in body:
        die("the body holds a NUL; nothing written")

    herd = herd_dir()
    if opts.get("--after"):
        state, value = resolve_after(herd, opts["--after"])
        if state != "one":
            die(value)
        opts["--after"] = value
    owner = "--parent" in opts and owner_p0(os.path.join(herd, "coordinator", "intake"), opts["--parent"])

    head = ["title: " + title, "repo: " + name, "from: " + opts["--from"],
            "priority: " + ("P0" if owner else opts["--priority"])]
    if owner:
        head.append("owner-priority: P0")
    if "--estimate" in opts:
        head.append("estimate: " + opts["--estimate"])
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

# the intake-id resolver, the skill's scripts/intake_id.py and nothing else: beside this
# script only when it runs from the skill's scripts/, else $here/../<skill>/scripts. A
# sibling intake_id.py anywhere else -- a tools/intake_id.py a branch could add -- is never
# loaded
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || here=""
APPL_BACKLOG_ADD_IDS=""
case "$here" in
  "") c="" ;;
  */.cursor/skills/isolated-session/scripts) c="$here/intake_id.py" ;;
  *) c="$here/../.cursor/skills/isolated-session/scripts/intake_id.py" ;;
esac
if [ -n "$c" ] && [ -f "$c" ] && [ ! -L "$c" ]; then
  APPL_BACKLOG_ADD_IDS=$c
fi
export APPL_BACKLOG_ADD_IDS
exec python3 -I -c "$APPL_BACKLOG_ADD_PY" "$@"
