#!/usr/bin/env bash
# Close the Herdr tab of a worker that is finished, and record it in the coordinator's log.
#
#   appl-close.sh <worker>
#   appl-close.sh --dead <worker>
#
# Owner rule 2026-09-19: a finished tab closes on its own (twelve idle tabs piled up in a
# single day). The coordinator runs this once a report is verified and its successor is
# spawned, and when an intake reaches done / SUPERSEDED / a final blocked state.
#
# It REFUSES -- non-zero, no `herdr tab close`, nothing logged -- when:
#   * the name is not herdr's agent-name rule ([a-z][a-z0-9_-], at most 32), so no prompt
#     can steer an argument or a path anywhere;
#   * an intake directly under $HERD_DIR/coordinator/intake/ still needs the worker: its
#     HEADER `status:` -- the lines before the first blank line, read the way
#     appl-hook.sh:header_status reads them, so a `status:` inside the `## Task` body
#     (data another session wrote) is never a status -- names <worker> as a whole word
#     and opens with `tests`, `impl`, `review`, `blocked` or `question`. A worker blocked at
#     landing, and one the coordinator may still re-prompt, is never closed. A worker
#     named only as a key (`key <harness>:<worker>`) or only inside a `spawn <next> (...)`
#     clause of a queue status is not named: it is neither the blocked party nor the
#     pair's implementer, so a verified author waiting for its implementer is swept. A status
#     opening with `split` (`split <n> items`: the intake was cut into a skeleton chain
#     and each item is its own intake now) is CLOSED and holds no worker;
#   * such a header status's FIRST word is <worker> itself, as a whole word, and
#     $HERD_DIR/.repos/<worker> is herd-spawn.sh's spawn record (a regular file of ours
#     holding one absolute path): `status: tip-pin-impl2` names a worker just spawned. Without
#     that record, a longer first word, or a closed first word (`done`, `landed`, `split`),
#     the bare name holds nobody;
#   * the worker is the TEST AUTHOR of a pair whose implementer is still named by such a
#     status (`impl ...` or `blocked ...`). The implementer runs in the author's worktree
#     under the author's owner key, so closing the author releases the claim the
#     implementer stands on. The author is found by an explicit `author=<worker>` token in
#     that status when there is one, else by the coordinator's naming rule (`<base>-tests`
#     pairs with `<base>-impl`). The hold does not ask herdr whether the implementer is
#     alive: a dead one is re-spawned, and would be stranded. It releases when the status
#     moves on (`landed` / `done`), or when the hold has already PASSED: herd-spawn.sh
#     hands the author's worktree lock to the implementer at spawn (lib.sh:
#     iso_lock_handover), and a lock of the repository this runs in (the coordinator's
#     cwd) whose owner key is the pair's (`<harness>:<author>`) and whose `owner_worker=`
#     is an implementer that status names no longer stands on the author's session, so
#     closing the author releases nothing the implementer needs. No such lock -- not a
#     repository, a symlink, an unreadable file, a lock still the author's -- keeps the
#     refusal;
#   * $HERD_DIR/.resume/<worker> is a regular file of ours whose lines include
#     `stop=start-timeout`. herd-spawn.sh left the tab open because `herdr agent start`
#     returned `timed out waiting for agent startup`, and kept the brief for `--resume`.
#     Closing that tab is the loop that never grew the pane count. The refusal stands
#     until `--resume` delivers the line and removes the record. `--dead` is the
#     exception: it removes that record and goes on. `--dead` also still closes when
#     the holding header is `tests <worker>` or `impl <worker>`. Without `--dead` that
#     hold stands;
#   * herdr does not list the worker, or does not answer at all. A listing that fails
#     means herdr is down, not that the worker is gone -- the fail-closed reading
#     herd-watch.sh already takes. `--dead` still refuses a listing that fails. With
#     no `--dead`, a listing that answers and has no tab for the worker is refused.
#     `--dead` does not use that listing as a source of the tab id: it closes the
#     `tab=` line of $HERD_DIR/.watch/<worker>.pane when that file is a regular file,
#     else the `tab=` line of $HERD_DIR/.resume/<worker>. No such line is a non-zero
#     exit and no `herdr tab close`. A row with `"focused": true` is never closed, and
#     neither is the tab whose label is $HERD_WATCH_NOTIFY or muretai-coordinator;
#   * `herdr tab close` itself fails. The log says what happened, so a tab that is still
#     open never gets a `closed` line.
#
# A tab id has nothing to do with a worker name. Without `--dead` it is resolved through
# `herdr tab list` (a row's `label` -> its `tab_id`), with `herdr agent list` (a row's
# `name`) as the fallback -- the two shapes herd-watch.sh already reads. `--dead` closes
# only the recorded `tab=` line, never the label. herdr 0.9.x prints a tab id as
# `<workspace>:<tab>` (`w3:tCF`), so the id is one ASCII word or two joined by ONE colon,
# each word opening with a letter or digit; anything else -- a metacharacter, whitespace,
# a leading `-`, an empty or over-long id -- is not a tab id and closes nothing.
#
# One line is appended to $HERD_DIR/coordinator/coordinator.log (HERD_DIR defaults to
# ~/.cache/muretai-herd), append-only and never through a symlink:
#
#   <UTC time> closed <worker>
#
# and the same line is the whole of the worker's closed marker,
# $HERD_DIR/walls/.closed/<worker> (never through a symlink): appl-hook.sh's closed()
# and herd-watch.sh's check_receipt honour it however large the log grows. It lies outside
# $HERD_DIR/<worker>/ and $HERD_DIR/walls/<worker>/, so nothing the worker writes un-closes
# it -- `.closed` is never a worker name, so it is never a worker's wall -- and the name
# rule above keeps the marker's name one plain path component. It stays out of
# $HERD_DIR/coordinator/, where closing writes nothing but the log line.
#
# No model, no network, and no intake or lock is rewritten: herdr is the only thing this
# calls besides one read-only `git rev-parse` for the lock directory (plan 2026-09-19
# "coordinator harness", addendum 3).
set -euo pipefail

herd="${HERD_DIR:-${HOME:-}/.cache/muretai-herd}"
dead=0
if [[ "${1:-}" == "--dead" ]]; then
  dead=1
  shift
fi
if [[ $# -ne 1 ]]; then
  echo "usage: appl-close.sh [--dead] <worker>" >&2
  exit 2
fi
w="$1"
if ! [[ "$w" =~ ^[a-z][a-z0-9_-]{0,31}$ ]]; then
  echo "appl-close: not a worker name: the rule is [a-z][a-z0-9_-], at most 32; nothing was closed" >&2
  exit 1
fi

# the lock directory of the repository the coordinator runs in (lib.sh:iso_lock_handover's
# reading); none when this is not a repository, and then no hand-over can be proved
common="$(git rev-parse --git-common-dir 2>/dev/null)" || common=""
if [[ -n "$common" && "$common" != /* ]]; then
  common="$(cd "$common" 2>/dev/null && pwd)" || common=""
fi

python3 -I - "${herd%/}/coordinator" "$w" "$common" "$dead" <<'PY'
import json, os, re, stat, subprocess, sys, time

coord, w, common, dead_flag = sys.argv[1:5]
dead = dead_flag == "1"
intake_dir = os.path.join(coord, "intake")
# the states that still need the worker: it is working, or the coordinator may re-prompt it
HOLDS = ("tests", "impl", "review", "blocked", "question")
# the states in which a pair's implementer is (or will again be) at work in the author's worktree
PAIR_HOLDS = ("impl", "blocked")
# closed states that name workers only as history: `split <n> items ...` (the chain items
# are their own intakes) never holds anyone
CLOSED = ("split",)
# the first words that close a status: a worker that happens to bear one of these names is
# never held by its bare name (intake 20261010T021047Z)
CLOSED_FIRST = ("done", "landed", "split")
# `w3:tCF` (herdr 0.9.x) or a bare word (`tab-11`): at most one colon, no other new character
TAB_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,63})?")


def refuse(why):
    print("appl-close: " + why + "; nothing was closed", file=sys.stderr)
    sys.exit(1)


def header_status(path):
    """the words of the HEADER `status:` line (appl-hook.sh:header_status, same reading)"""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read(65536)
    except OSError:
        return []
    for ln in text.split("\n"):
        if ln == "":
            break
        if ln.startswith("status:"):
            return ln[len("status:"):].split()
    return []


def named(words):
    """the status words that name a party: a `spawn <next> (...)` clause names a worker not
    started yet, and `key <harness>:<w>` names a worktree key, so neither is the blocked or
    resumed party (intake 20261009T194603Z: the queue statuses held every verified author)"""
    out, i = [], 0
    while i < len(words):
        t = words[i]
        if t == "spawn":
            i += 2                        # the worker to spawn
            if i < len(words) and words[i].startswith("("):
                while i < len(words) and not words[i].endswith(")"):
                    i += 1
                i += 1                    # its parenthesized clause, closing token included
            continue
        if t.lstrip("(") == "key":
            i += 2                        # the key token after `key`
            continue
        out.append(t)
        i += 1
    return out


def pairs_with(words):
    """True when this worker is the test author of the pair a status names: the status's
    `author=<worker>` token when it carries one, else the naming rule (<base>-tests is the
    author of <base>-impl)"""
    authors = [t[len("author="):] for t in words if t.startswith("author=")]
    if authors:
        return w in authors
    return w.endswith("-tests") and (w[:-len("-tests")] + "-impl") in words


def read_lock(dfd):
    """the key=value pairs of <dfd>/isolated-session.lock, never through a symlink and
    only from a regular file (lib.sh:iso_lock_py read_lock), or None"""
    try:
        fd = os.open("isolated-session.lock", os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0),
                     dir_fd=dfd)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        data = os.read(fd, 65536)
    finally:
        os.close(fd)
    out = {}
    for ln in data.decode("utf-8", "replace").splitlines():
        k, sep, v = ln.partition("=")
        if sep and k not in out:
            out[k] = v
    return out


def handed_over(words):
    """True when a worktree lock of this repository carries the pair's key and has already
    been handed to an implementer this status names: the hold passed at spawn, so the
    author's tab no longer carries the implementer's claim"""
    impls = set(t for t in words[1:] if not t.startswith("author="))
    if not common or not impls:
        return False
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        top = os.open(os.path.join(common, "worktrees"), flags)
    except OSError:
        return False
    try:
        for entry in sorted(os.listdir(top)):
            try:
                dfd = os.open(entry, flags, dir_fd=top)
            except OSError:
                continue                  # a symlink, a file, gone: proves nothing
            try:
                lock = read_lock(dfd)
            finally:
                os.close(dfd)
            owner = (lock or {}).get("owner", "")
            if lock and lock.get("owner_worker") in impls and ":" in owner and owner.rpartition(":")[2] == w:
                return True
    except OSError:
        return False
    finally:
        os.close(top)
    return False


def spawn_record():
    """True when $HERD_DIR/.repos/<w> is herd-spawn.sh's spawn record: a regular file of ours,
    never through a symlink, holding one absolute path of printable ASCII (herd-watch.sh:
    recorded_repo, the same reading)"""
    repos = os.path.join(os.path.dirname(coord), ".repos")
    if os.path.islink(repos):
        return False
    try:
        fd = os.open(os.path.join(repos, w), os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return False
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
            return False
        data = os.read(fd, 4097)
    except OSError:
        return False
    finally:
        os.close(fd)
    if not data or len(data) > 4096:
        return False
    lines = data.split(b"\n")
    path = lines[0]
    return (path.startswith(b"/") and all(0x20 <= c < 0x7f for c in path)
            and not any(lines[1:]))


def held_by():
    """the first intake whose header status still needs this worker, or None. A status whose
    FIRST word is this worker's bare name holds it when herd-spawn.sh left its spawn record
    (intake 20261010T021047Z: `status: tip-pin-impl2` named a working implementer by no
    HOLDS word, and the sweep closed it); a closed first word never holds"""
    if not os.path.isdir(intake_dir):
        return None
    for name in sorted(os.listdir(intake_dir)):
        p = os.path.join(intake_dir, name)
        if not name.endswith(".md") or os.path.islink(p) or not os.path.isfile(p):
            continue
        words = header_status(p)
        if not words or words[0] in CLOSED:
            continue
        if words[0] == w and w not in CLOSED_FIRST and spawn_record():
            return name, w
        party = named(words)
        if w in party and words[0] in HOLDS:
            return name, words[0]
        if words[0] in PAIR_HOLDS and pairs_with(party) and not handed_over(party):
            return name, words[0] + " (its implementer)"
    return None


def herdr(*args, timeout=60):
    try:
        r = subprocess.run(["herdr"] + list(args), stdin=subprocess.DEVNULL,
                           capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout
    except (OSError, subprocess.SubprocessError):
        return 1, ""


def listing(kind):
    """the rows of `herdr <kind> list`, or None when herdr did not answer (herd-watch.sh:listing)"""
    rc, out = herdr(kind, "list")
    if rc != 0:
        return None
    try:
        rows = json.loads(out).get("result", {}).get(kind + "s")
    except (ValueError, AttributeError):
        return None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else None


def tab_of(rows, key):
    for row in rows or []:
        if row.get(key) == w:
            tab = row.get("tab_id")
            if isinstance(tab, str) and TAB_ID.fullmatch(tab):
                return tab
    return None


def read_own(path):
    """bytes of a regular file of ours, never through a symlink, or None"""
    parent = os.path.dirname(path)
    if os.path.islink(parent) or os.path.islink(path):
        return None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
            return None
        return os.read(fd, 4096)
    except OSError:
        return None
    finally:
        os.close(fd)


def tab_line(data):
    """the value of the first tab= line when it is one tab id, else None"""
    if not data:
        return None
    for raw in data.split(b"\n"):
        if not raw.startswith(b"tab="):
            continue
        try:
            tab = raw[4:].decode("ascii")
        except UnicodeError:
            return None
        return tab if TAB_ID.fullmatch(tab) else None
    return None


def recorded_tab():
    """the tab= line of .watch/<w>.pane when that file is a regular file, else of
    .resume/<w>. The label in herdr's listing is not a source."""
    herd = os.path.dirname(coord)
    for path in (os.path.join(herd, ".watch", w + ".pane"),
                 os.path.join(herd, ".resume", w)):
        tab = tab_line(read_own(path))
        if tab:
            return tab
    return None


def spared(tab, rows):
    """a reason this tab id must not be closed, or None. A focused row is never closed,
    nor a row whose label is the --notify target or muretai-coordinator."""
    notify = os.environ.get("HERD_WATCH_NOTIFY", "")
    reason = None
    for row in rows or []:
        if row.get("tab_id") != tab:
            continue
        if row.get("focused") is True:
            return "the focused tab is not closed"
        label = row.get("label")
        if label == "muretai-coordinator" or (notify and label == notify):
            reason = "the notify target is not closed"
    return reason


def start_timeout_resume():
    """True when herd-spawn.sh left this worker's tab open for a start timeout.
    The record is $HERD_DIR/.resume/<w>, a regular file of ours, never through a symlink,
    and one of its lines is exactly stop=start-timeout. --resume removes it on delivery."""
    parent = os.path.dirname(coord)
    rec_dir = os.path.join(parent, ".resume")
    rec = os.path.join(rec_dir, w)
    if os.path.islink(rec_dir) or os.path.islink(rec):
        return False
    try:
        fd = os.open(rec, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return False
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
            return False
        data = os.read(fd, 4096)
    except OSError:
        return False
    finally:
        os.close(fd)
    return b"stop=start-timeout" in data.split(b"\n")


def drop_start_timeout():
    """unlink the start-timeout record. The directory stays. A symlink is left alone."""
    parent = os.path.dirname(coord)
    rec_dir = os.path.join(parent, ".resume")
    rec = os.path.join(rec_dir, w)
    if os.path.islink(rec_dir) or os.path.islink(rec):
        return
    try:
        os.unlink(rec)
    except OSError:
        pass


held = held_by()
# --dead still closes a worker whose header is tests or impl, including the author of a
# pair that header names: the pane is already dead, and the respawn is filed afterwards
if held is not None and not (dead and (held[1] in ("tests", "impl")
                                        or held[1].endswith(" (its implementer)"))):
    refuse(held[0] + " still needs " + w + " (status: " + held[1] + " ...)")

if not dead and start_timeout_resume():
    refuse(w + " is waiting out 'timed out waiting for agent startup'; the tab stays open until herd-spawn.sh --resume " + w + " delivers the brief")

tabs = listing("tab")
agents = listing("agent")
if tabs is None and agents is None:
    refuse("herdr did not answer, so " + w + " is not known to be finished")
if dead:
    if tabs is None:
        refuse("herdr did not answer, so " + w + " is not known to be finished")
    tab = recorded_tab()
    if tab is None:
        refuse("no recorded tab for " + w)
    why = spared(tab, tabs)
    if why:
        refuse(why)
else:
    tab = tab_of(tabs, "label") or tab_of(agents, "name")
    if tab is None:
        refuse("herdr lists no tab for " + w)
if dead and start_timeout_resume():
    drop_start_timeout()

if tab is not None and herdr("tab", "close", tab)[0] != 0:
    refuse("`herdr tab close " + tab + "` failed")

line = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " closed " + w
try:
    # the closed marker: one file per worker, outside every worker's wall, so the hook and
    # the watcher know the worker is closed however large coordinator.log has grown
    walls = os.path.join(os.path.dirname(coord), "walls")
    marks = os.path.join(walls, ".closed")
    os.makedirs(walls, mode=0o700, exist_ok=True)
    if not os.path.islink(walls) and not os.path.islink(marks):
        os.makedirs(marks, mode=0o700, exist_ok=True)
        fd = os.open(os.path.join(marks, w), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(line + "\n")
except OSError as e:
    print("appl-close: the tab of " + w + " is closed, but its closed marker was not written: "
          + (e.strerror or "write failed"), file=sys.stderr)
try:
    os.makedirs(coord, mode=0o700, exist_ok=True)
    fd = os.open(os.path.join(coord, "coordinator.log"),
                 os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write(line + "\n")
except OSError as e:
    print("appl-close: the tab of " + w + " is closed, but the log line was not written: "
          + (e.strerror or "write failed"), file=sys.stderr)
PY
