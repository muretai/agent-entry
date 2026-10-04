#!/usr/bin/env bash
# Close the Herdr tab of a worker that is finished, and record it in the coordinator's log.
#
#   appl-close.sh <worker>
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
#     and opens with `tests`, `impl`, `blocked` or `question`. A worker blocked at
#     landing, and one the coordinator may still re-prompt, is never closed. A status
#     opening with `split` (`split <n> items`: the intake was cut into a skeleton chain
#     and each item is its own intake now) is CLOSED and holds no worker;
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
#   * herdr does not list the worker, or does not answer at all. A listing that fails
#     means herdr is down, not that the worker is gone -- the fail-closed reading
#     herd-watch.sh already takes;
#   * `herdr tab close` itself fails. The log says what happened, so a tab that is still
#     open never gets a `closed` line.
#
# A tab id has nothing to do with a worker name: it is resolved through `herdr tab list`
# (a row's `label` -> its `tab_id`), with `herdr agent list` (a row's `name`) as the
# fallback -- the two shapes herd-watch.sh already reads. herdr 0.9.x prints a tab id as
# `<workspace>:<tab>` (`w3:tCF`), so the id is one ASCII word or two joined by ONE colon,
# each word opening with a letter or digit; anything else -- a metacharacter, whitespace,
# a leading `-`, an empty or over-long id -- is not a tab id and closes nothing.
#
# One line is appended to $HERD_DIR/coordinator/coordinator.log (HERD_DIR defaults to
# ~/.cache/muretai-herd), append-only and never through a symlink:
#
#   <UTC time> closed <worker>
#
# No model, no network, and no intake or lock is rewritten: herdr is the only thing this
# calls besides one read-only `git rev-parse` for the lock directory (plan 2026-09-19
# "coordinator harness", addendum 3).
set -euo pipefail

herd="${HERD_DIR:-${HOME:-}/.cache/muretai-herd}"
if [[ $# -ne 1 ]]; then
  echo "usage: appl-close.sh <worker>" >&2
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

python3 -I - "${herd%/}/coordinator" "$w" "$common" <<'PY'
import json, os, re, stat, subprocess, sys, time

coord, w, common = sys.argv[1:4]
intake_dir = os.path.join(coord, "intake")
# the states that still need the worker: it is working, or the coordinator may re-prompt it
HOLDS = ("tests", "impl", "blocked", "question")
# the states in which a pair's implementer is (or will again be) at work in the author's worktree
PAIR_HOLDS = ("impl", "blocked")
# closed states that name workers only as history: `split <n> items ...` (the chain items
# are their own intakes) never holds anyone
CLOSED = ("split",)
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


def held_by():
    """the first intake whose header status still needs this worker, or None"""
    if not os.path.isdir(intake_dir):
        return None
    for name in sorted(os.listdir(intake_dir)):
        p = os.path.join(intake_dir, name)
        if not name.endswith(".md") or os.path.islink(p) or not os.path.isfile(p):
            continue
        words = header_status(p)
        if not words or words[0] in CLOSED:
            continue
        if w in words and words[0] in HOLDS:
            return name, words[0]
        if words[0] in PAIR_HOLDS and pairs_with(words) and not handed_over(words):
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


held = held_by()
if held is not None:
    refuse(held[0] + " still needs " + w + " (status: " + held[1] + " ...)")

tabs = listing("tab")
agents = listing("agent")
if tabs is None and agents is None:
    refuse("herdr did not answer, so " + w + " is not known to be finished")
tab = tab_of(tabs, "label") or tab_of(agents, "name")
if tab is None:
    refuse("herdr lists no tab for " + w)

if herdr("tab", "close", tab)[0] != 0:
    refuse("`herdr tab close " + tab + "` failed")

line = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " closed " + w
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
