#!/usr/bin/env bash
# Land this session's branch on BASE and remove the worktree (its lock goes with it).
# Must be run only when the user's task is actually done. Never pushes BASE.
#
# The landing is the one serial section of parallel work, so it is short and it is
# ordered: run the tests the diff owes ONCE, before any lock, into a bound receipt (the
# test step below reuses it while it is still current) -> take the landing lock (one
# landing at a time per primary) -> fast-forward
# local BASE from origin/BASE, so the landing descends from what the other primary
# published (diverged: refuse) -> bring the branch onto that BASE (rebase; merge when
# another checkout holds the branch -- origin, the publisher bundle, another remote or
# another worktree, SHARED= on the receipt; a holder that cannot be read refuses) ->
# refuse a branch that edited a generated file -> run the tests the diff owes
# (tools/run_tests.py --affected) -> scan the diff (tools/sec_lint.py: a refusal stops
# the landing like a red test; needs-eyes lands and owes a reviewer) -> regenerate the
# ledgers on the tip (tools/ledger.py build) -> fast-forward BASE -> release, remove,
# delete -> when the scan said needs-eyes, spawn the reviewer session through herdr
# (scripts/herd-spawn.sh; never blocking, never failing the landing).
# A repository without those tools (a pinned copy of this skill) lands as before and
# says TESTS=none / SEC=none / LEDGER=none / REVIEW=none in the receipt.
# A landing its tests refused says MERGED=no with TESTS=, TESTS_RED= (the diff's own
# reds), TESTS_COULD_NOT_RUN= (suites the room refused -- a landing behind a wall), and
# TESTS_REFUSAL=environment|red: `environment` when only the room refused, `red` when any
# ordinary red is present. The two lists are disjoint. A file red on BASE too (the runner
# re-ran it once there) is TESTS_RED_ON_BASE=, counted `<n> red-on-base` on TESTS=, on a
# landing and on a refusal alike, and never refuses: only TESTS_RED= does.
# `appl land` may hand over appl.toml's [tests] command (APPL_TESTS_COMMAND): it runs in
# place of tools/run_tests.py, in the worktree, only when it is the primary's appl.toml's
# own command as BASE's appl/config.py reads it; TESTS=<command> on the receipt, and a
# non-zero exit is TESTS_REFUSAL=red. Any other value is ignored and the runner judges.
# Its twin, appl.toml's [scan] command (APPL_SCAN_COMMAND), is trusted the same way: it
# runs in place of tools/sec_lint.py's diff scan, in the worktree; SEC=<command> on the
# receipt, and a non-zero exit is SEC=refused. Any other value is ignored and the lint scans.
# The command replaces the diff verdict only: BASE's lint's per-commit refuse check runs
# first either way, and a refuse-level finding in any commit is SEC=refused.
# Its third, appl.toml's [ledger] command (APPL_LEDGER_COMMAND), is trusted the same
# way: it runs in place of tools/ledger.py build, in the worktree, on the tip before
# the fast-forward; LEDGER=<command> on the receipt, and a non-zero exit prints
# LEDGER_REFUSAL=<code> and MERGED=no. Any other value is ignored and the inline build
# runs. A repository with no tools/ledger.py stays LEDGER=none and the command does not run.
#
# The guards are BASE's, never the branch's. The branch's TESTS run by design; the gate
# does not: this script re-runs itself from BASE's copy of this skill and of the gate
# tools before it sources anything (see "the code that judges a landing is BASE's"
# below), and the lint, the reviewer's brief and the spawner are read out of BASE's blobs
# (`git show BASE:path`), so a branch that rewrites any of them is judged by the copies
# main already had. And a diff that touches a gate file at all (the lint,
# the ledger, the runner, these scripts, the briefs, the hook configs) is needs-eyes
# whatever the lint said -- this script decides that itself, from the paths, because
# the lint is one of the files on that list.
set -euo pipefail

# Scratch files: an unpredictable name under TMPDIR, never /tmp/<name>-$$ (a planted
# symlink there would be followed as the operator).
finish_tmp() {
  mktemp "${TMPDIR:-/tmp}/finish-XXXXXX"
}

# The branch's code runs three times before the merge -- the ledger check, the tests,
# the ledger build (which imports the selector, the spec builder and the projector from
# the branch) -- and none of it may reach a push credential: git's helpers cleared, no
# terminal prompt, ssh disabled, gh pointed at an empty config (the keychain token is
# reached through hosts.yml, which is not there). A test that pushes to a local bare
# remote needs none of these (ISSUE(security-audit-2026-09-12-a-pre-push-hook-makes-the),
# ISSUE(security-audit-2026-09-12-the-wall-is-honest-about-3)).
#
# PYTHONNOUSERSITE is part of it for the same reason and one level down: a branch's own
# test run can write `usercustomize.py` into the USER SITE directory, which is outside the
# checkout -- so `git status --porcelain` after the tests stays green, the lint never sees
# it and no reviewer opens it -- and every later plain `python3` imports it at start-up. It
# reached the gate itself: the scan, the gate-file probe, the ledger build and the brief
# render are all `python3` (ISSUE(security-audit-2026-09-18-daily-2026-09-18-3)). The
# guards were BASE's for the FILE and not for the INTERPRETER that ran it.
#
# `credless` itself now lives in lib.sh, sourced below, because the daily engine and the
# weekly clock need the identical wall and two copies are how one of them goes stale
# (ISSUE(security-audit-2026-09-18-daily-2026-09-18-7)). It is ARMED once, at top level,
# right after the source: a `credless` called inside a `$( )` would otherwise make its own
# empty gh directory per call.

# EVERY python the landing runs on BASE's behalf goes through here, and none any other
# way -- and so does the SPAWNER, which runs pythons of its own: the generated-file check,
# the tests harness, the two summaries, BASE's lint and its gate-file table, the ledger
# build, the reviewer's brief, and herd-spawn.sh's re-render of that brief and its
# permission list. `-I` is isolated mode -- no user site directory (so the hook above is
# never imported) and no PYTHON* variable read -- and `credless` is the credential wall
# these already had. The branch's TESTS still run however they run; this is the GATE's
# interpreter, which is a different thing.
# `tests/test_gate_pythons_are_isolated.py` holds this paragraph to its word: it greps
# every `python3` a landing or the daily job can reach and fails on a bare one.
#
# `-I` also keeps the caller's directory off sys.path. Nothing here depends on that
# prepend: tools/ledger.py, tools/run_tests.py and tools/sec_lint.py each insert their own
# tools/ directory themselves, and the heredocs below import stdlib only.
landing_python() {
  credless python3 -I "$@"
}

# ... and the one python here that is NOT the gate's: the harness that runs THE BRANCH'S
# TESTS, and every child IT spawns. `-I` is per-process and reaches no child, so the wall a
# child gets is the ENVIRONMENT it inherits -- `tools/run_tests.py` spawns one process per
# test file with `dict(os.environ)` and takes that file's ok-or-fail from its exit code
# alone.
#
# This used to read `credless PYTHONNOUSERSITE= python3 -I`: the empty assignment was one
# more `NAME=VALUE` on credless's own `env` line and the LAST one won, and CPython reads an
# empty flag variable as not set at all. So the user site directory was ENABLED for every
# child, and one branch test writing `usercustomize.py` with
# `atexit.register(lambda: os._exit(0))` turned every later affected test green -- for
# every later landing by any session, from a file outside every checkout a guard here looks
# at (ISSUE(security-audit-2026-09-18-daily-2026-09-18-10)).
#
# The trade that clearing was made for is real and is still paid, by a different route.
# `cryptography` -- the relay/E2E layer's X25519 and ChaCha20-Poly1305, optional by
# CLAUDE.md principle 1 -- lives ONLY in `~/Library/Python/3.9/.../site-packages` on this
# machine, and without it `tests/test_dispatch_take.py` falls to the pure-Python Ed25519
# backend and times out on its ack deadline. So the wall goes back on
# (`PYTHONNOUSERSITE=1`). The directory travels in its own variable, not PYTHONPATH:
# the runner appends it AFTER interpreter startup and the stdlib. Neither a planted
# json.py nor startup customization in that directory runs ahead of the shim.
# The directory is still the operator's: a poisoned importable module planted there
# is still imported by later landings. ISSUE(the-lent-backend-is-the-operators)
# closes only with a pinned copy of the backend that belongs to the landing.
# `-B`: the runner it starts is the gate copy's, and that runner imports its siblings out
# of the copy; a __pycache__ written there would be loaded by the next start from it.
branch_tests_python() {
  credless PYTHONNOUSERSITE=1 MURETAI_TEST_BACKEND_PATH="${branch_tests_backend_path-}" python3 -I -B "$@"
}

# The files whose change is judged by eyes whatever the lint said: they decide what a
# landing runs, what it scans, who reviews it, and what a session may edit.
# The comparison folds case: the dev host's filesystem is case-insensitive (APFS,
# core.ignorecase=true), so `git mv tools/spec_build.py tools/Spec_build.py` is a path
# git lists as new and the OS opens as the old one -- `ledger.py build` would run the
# renamed file under its canonical name while a case-exact list called it not a gate
# (ISSUE(security-audit-2026-09-12-the-scanner-ignores-diff-2)). `tr`, not `${1,,}`:
# bash 3.2.
# The gate list -- the paths whose change is needs-eyes whatever the lint said -- is
# BASE's lint's own table (`tools/sec_lint.py --gate-files`), not a table of this
# script's: two tables kept in step by hand missed the weekly clock and the skill's
# SKILL.md (ISSUE(gate-lists-are-two-lists), ISSUE(security-audit-2026-09-12-a-type-change-is-con-02ca)).

branch="${1:-}"
worktree="${2:-}"
if [[ -z "$branch" || -z "$worktree" ]]; then
  echo "usage: finish-worktree.sh <branch> <worktree-path>" >&2
  echo "REFUSAL=usage"
  exit 2
fi
if [[ ! -d "$worktree" ]]; then
  echo "worktree not found: ${worktree}" >&2
  echo "REFUSAL=usage"
  exit 1
fi
worktree="$(cd "$worktree" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"

# --- the running-landing marker: a herd worker's pane is not swept mid-landing ---------
# herd-watch.sh closes a finished or idle worker pane, and closing a pane SIGTERMs the
# landing running in it. So a landing started for a herd worker (HERD_WORKER=<w>, as
# herd-spawn.sh exports it) writes HERD_DIR/<w>/landing-running -- `pid=` the process
# that was started (this one; the BASE copy and the gate copy below are its children),
# `started=` the UTC time it wrote the marker -- here, before the re-exec, the tests
# and the landing-lock wait. Every EXIT trap from here on removes it, and a SIGKILLed
# landing leaves one naming a dead pid, which the sweep treats as stale. The sweep only
# ever KEEPS a pane for it. No `ps`: behind a wall the setuid /bin/ps cannot be exec'd.
# Written with O_CREAT|O_EXCL|O_NOFOLLOW, mode 600, into the worker's own directory only
# (a real directory this user owns). The one thing removed first is a stale regular
# file of ours naming a dead pid. A symlink or anything else at the path is left alone
# and no marker is written, and so is a marker naming a live pid -- in a nested copy
# that is the started process's own marker. Never fatal: a marker that cannot be
# written is no marker. Removed only while it still names this pid.
landing_marker=""
landing_marker_drop() {
  local m="$landing_marker"
  landing_marker=""
  [[ -n "$m" && -f "$m" && ! -L "$m" && -O "$m" ]] || return 0
  grep -qx "pid=$$" "$m" 2>/dev/null && rm -f "$m" 2>/dev/null
  return 0
}
landing_marker_write() {
  local w="${HERD_WORKER:-}" d=""
  [[ -n "$w" && -n "${HERD_DIR:-}" ]] || return 0
  [[ "$w" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return 0
  d="${HERD_DIR%/}/${w}"
  [[ -d "$d" && ! -L "$d" && -O "$d" ]] || return 0
  python3 -I - "${d}/landing-running" "$$" <<'PY' >/dev/null 2>&1 || return 0
import os, stat, sys, time
path, pid = sys.argv[1], sys.argv[2]
try:
    st = os.lstat(path)
except FileNotFoundError:
    st = None
if st is not None:
    # only a regular file of ours naming a dead pid is stale; anything else stays
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
        sys.exit(1)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                sys.exit(1)
            old = os.read(fd, 4096).decode("ascii", "replace")
        finally:
            os.close(fd)
    except OSError:
        sys.exit(1)
    for ln in old.splitlines():
        k, _, v = ln.partition("=")
        if k.strip() == "pid" and v.strip().isdigit() and int(v.strip()) > 1:
            try:
                os.kill(int(v.strip()), 0)
            except ProcessLookupError:
                continue
            except OSError:
                pass
            sys.exit(1)                     # a live pid, or one we may not ask about
    os.unlink(path)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    os.fchmod(fd, 0o600)
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    os.write(fd, ("pid=%s\nstarted=%s\n" % (pid, started)).encode("ascii"))
finally:
    os.close(fd)
PY
  landing_marker="${d}/landing-running"
}
trap 'landing_marker_drop' EXIT
landing_marker_write || true

# --- the receipt, appended to the herd worker's report.md ------------------------------
# A worker whose turn ended before its landing did has no receipt on record unless the
# landing writes one. So for a herd worker (HERD_WORKER set) the gate's own run below is
# started through this relay: it passes the run's stdout and stderr through as they come,
# keeps a copy, and once the run has exited appends to HERD_DIR/<w>/report.md the receipt
# it printed -- every `KEY=value` line of stdout, in order -- and, on a non-zero exit, the
# stderr lines from the last `refusing to land` on (the why, which for held gate slots is
# the runner's own words and on stderr only). Appended, never truncated: O_APPEND, created
# mode 600 when absent, opened with O_NOFOLLOW under a descriptor of HERD_DIR/<w> that was
# itself opened with O_NOFOLLOW. The marker's rule decides who may be written for: HERD_WORKER
# matches `[A-Za-z0-9][A-Za-z0-9._-]*`, HERD_DIR/<w> is a real directory this user owns,
# and report.md is a regular file of this user's. Anything else is refused with one stderr
# line naming report.md, and nothing is written. Never fatal, and never the exit status:
# the run's own is passed on. HUP/INT/TERM do not stop the relay (the run, in the same
# process group, gets them itself, and the relay passes each on to it as TERM for a
# signal sent to the relay alone), so the run never writes into a closed pipe while it
# releases the landing lock. No HERD_WORKER, or no HERD_DIR (as for the marker): no relay,
# nothing logged, the run is started as before.
receipt_append_py=""
read -r -d '' receipt_append_py <<'PY' || true
import os, re, select, signal, stat, subprocess, sys, time
herd, worker, branch, argv = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
KEEP = 1 << 20
p = None


def pass_on(*_):
    # the relay stays; the run is told to give up (TERM), and releases what it holds
    if p is not None and p.poll() is None:
        try:
            p.send_signal(signal.SIGTERM)
        except OSError:
            pass


for s in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(s, pass_on)


def shown(s):
    return "".join(c if c.isprintable() else "?" for c in s)


try:
    p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
except OSError as e:
    sys.stderr.write("refusing to land %s: the gate copy could not be started (%s); nothing moved.\n"
                     % (shown(branch), e.strerror or type(e).__name__))
    sys.stdout.write("REFUSAL=gate\n")
    sys.exit(1)
bufs = {p.stdout.fileno(): (1, bytearray()), p.stderr.fileno(): (2, bytearray())}
out, err = bufs[p.stdout.fileno()][1], bufs[p.stderr.fileno()][1]
live, broken, deadline = set(bufs), set(), None
while live:
    if deadline is None and p.poll() is not None:
        deadline = time.time() + 5           # what is still buffered, not a lingering child
    wait = 0.5 if deadline is None else deadline - time.time()
    if wait <= 0:
        break
    ready = select.select(list(live), [], [], wait)[0]
    for fd in ready:
        chunk = os.read(fd, 65536)
        if not chunk:
            live.discard(fd)
            continue
        dest, buf = bufs[fd]
        if dest not in broken:
            try:
                view = memoryview(chunk)
                while view:
                    view = view[os.write(dest, view):]
            except OSError:
                broken.add(dest)             # keep reading: the run must never see EPIPE
        buf += chunk
        if len(buf) > KEEP:
            del buf[:len(buf) - KEEP]
rc = p.wait()
rc = 128 - rc if rc < 0 else rc

lines = [shown(ln) for ln in out.decode("utf-8", "replace").splitlines()
         if re.match(r"[A-Z][A-Z0-9_]*=", ln)]
if rc != 0:
    said = err.decode("utf-8", "replace").splitlines()
    at = [i for i, ln in enumerate(said) if ln.startswith("refusing to land ")]
    if at:
        lines += [shown(ln) for ln in said[at[-1]:at[-1] + 40]]
path = os.path.join(herd, worker, "report.md")


def refuse(why):
    sys.stderr.write("note: refusing to append the landing receipt to %s: %s; nothing was written.\n"
                     % (shown(path), why))
    sys.stderr.flush()


def append():
    if not re.match(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z", worker):
        return refuse("HERD_WORKER is not a worker name")
    try:
        dfd = os.open(os.path.join(herd, worker), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as e:
        return refuse("HERD_DIR/<worker> is not a real directory (%s)" % (e.strerror or type(e).__name__))
    try:
        st = os.fstat(dfd)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
            return refuse("HERD_DIR/<worker> is not a directory of this user's")
        flags = os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK
        try:
            fd, created = os.open("report.md", flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=dfd), True
        except FileExistsError:
            try:
                fd, created = os.open("report.md", flags, dir_fd=dfd), False
            except OSError as e:
                return refuse("it is a symlink or cannot be opened (%s)" % (e.strerror or type(e).__name__))
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
                return refuse("it is not a regular file of this user's")
            if created:
                os.fchmod(fd, 0o600)
            head = "\n" if st.st_size and os.pread(fd, 1, st.st_size - 1) != b"\n" else ""
            text = head + "\n## landing receipt: finish-worktree.sh %s, exit %d, %s\n\n%s\n" % (
                shown(branch), rc, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "\n".join(lines))
            view = memoryview(text.encode("utf-8"))
            while view:
                view = view[os.write(fd, view):]
        finally:
            os.close(fd)
    finally:
        os.close(dfd)


if lines:
    try:
        append()
    except Exception as e:                   # writing the receipt never fails a landing
        refuse("the write failed (%s)" % type(e).__name__)
sys.exit(rc)
PY

# The copy that was started runs the landing as a CHILD (BASE's blob, the gate copy), and
# that child is the one that takes the landing lock and runs the in-lock gate. A TERM,
# INT or HUP sent to the started process alone used to end it and leave the child
# landing on, holding the lock. So the child runs in the background and is waited for,
# and each of those signals is passed on to it as TERM -- the child gives up, releasing
# what it holds -- while this copy waits for it to end and exits with its status. stdin
# is the caller's (`<&0`: an async command's is /dev/null otherwise), and INT and QUIT
# are put back to their defaults before the exec: bash starts an async command with both
# ignored, and an ignored signal is inherited by every test the gate runs. A python3 that
# cannot run starts the child as it is: the landing then refuses on its own words where it
# needs python3, rather than here with none.
finish_child_run() {
  local child rc=0
  if python3 -I -c '' >/dev/null 2>&1; then
    python3 -I -c 'import os, signal, sys
signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGQUIT, signal.SIG_DFL)
os.execvp(sys.argv[1], sys.argv[1:])' "$@" <&0 &
  else
    "$@" <&0 &
  fi
  child=$!
  trap 'kill -TERM "$child" 2>/dev/null || true' TERM INT HUP
  while :; do
    rc=0
    wait "$child" || rc=$?
    kill -0 "$child" 2>/dev/null || break
  done
  trap - TERM INT HUP
  return "$rc"
}

# --- the common dir is the PRIMARY's, never the one the worktree names ---------------
# A linked worktree finds its refs and objects through <gitdir>/commondir, and that gitdir
# is the worker's to write. A worker that pointed it at a git dir of its own, whose main
# carried a finish-worktree.sh, had that blob read through `git -C <worktree>` below and
# run here as the launcher, outside every wall (intake 20261011T142331Z, ruling
# 20261011T142424Z). So the common dir is asked of the PRIMARY -- the directory the landing
# runs from: land.sh and the operator both start it there -- and a worktree whose common
# dir resolves anywhere else is refused before anything is read through it. land.sh also
# hands over the common dir and git dir pinned to the dirs it recorded and checked: they
# are read once, by the first git call here, and cleared, so nothing this landing starts
# (the merge in the primary, a test that builds a repository of its own) inherits them.
# Every other repository-location variable is cleared before that call. The launcher is
# started in the worktree, so this process also inherits GIT_WORK_TREE, GIT_INDEX_FILE
# or GIT_OBJECT_DIRECTORY. Left set, the dirty-base check reads the branch: its committed
# files are reported as uncommitted changes on main, and a stray object directory makes
# a clean primary look dirty. Identity and the global config stay. A landing started
# outside any repository has no primary to ask and reads the worktree's.
finish_resolve_dir() {  # $1 a git dir as git printed it, $2 the directory it is relative to
  local d="$1"
  [[ -n "$d" ]] || return 1
  [[ "$d" == /* ]] || d="$2/$d"
  (cd "$d" 2>/dev/null && pwd -P)
}
# GIT_WORK_TREE, GIT_INDEX_FILE and the other location variables redirect
# `git -C <checkout>` onto whatever they name. Drop them before the pin read.
# GIT_DIR and GIT_COMMON_DIR stay for that one read, then go too.
# Cleared before the pin is read, so the pin's git and the dirty-base check both see
# the primary. land.sh hands the two pins as ISO_FINISH_PIN_COMMON_DIR and
# ISO_FINISH_PIN_GIT_DIR, names an older vendored finish ignores; an inherited
# GIT_COMMON_DIR and GIT_DIR are read the same way. All four go before any git call, and
# the pins are put back on that one read only.
unset GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_PREFIX \
  GIT_CEILING_DIRECTORIES GIT_DISCOVERY_ACROSS_FILESYSTEM \
  GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_GRAFT_FILE \
  GIT_IMPLICIT_WORK_TREE GIT_INTERNAL_SUPER_PREFIX GIT_NO_REPLACE_OBJECTS \
  GIT_REPLACE_REF_BASE GIT_SHALLOW_FILE GIT_QUARANTINE_PATH
pin_common_in="${ISO_FINISH_PIN_COMMON_DIR:-${GIT_COMMON_DIR:-}}"
pin_gitdir_in="${ISO_FINISH_PIN_GIT_DIR:-${GIT_DIR:-}}"
unset ISO_FINISH_PIN_COMMON_DIR ISO_FINISH_PIN_GIT_DIR GIT_COMMON_DIR GIT_DIR
pin_common=""
if [[ -n "$pin_common_in" ]]; then
  if [[ -n "$pin_gitdir_in" ]]; then
    pin_common="$(GIT_COMMON_DIR="$pin_common_in" GIT_DIR="$pin_gitdir_in" git -C "$worktree" rev-parse --git-common-dir 2>/dev/null)" || pin_common=""
  else
    pin_common="$(GIT_COMMON_DIR="$pin_common_in" git -C "$worktree" rev-parse --git-common-dir 2>/dev/null)" || pin_common=""
  fi
  pin_common="$(finish_resolve_dir "$pin_common" "$worktree")" || pin_common=""
  if [[ -z "$pin_common" ]]; then
    echo "refusing to land ${branch}: the GIT_COMMON_DIR this landing was handed is not a directory; nothing moved." >&2
    echo "REFUSAL=other"
    exit 1
  fi
fi
primary_common="$(git -C "$PWD" rev-parse --git-common-dir 2>/dev/null)" || primary_common=""
primary_common="$(finish_resolve_dir "$primary_common" "$PWD")" || primary_common=""
wt_common="$(git -C "$worktree" rev-parse --git-common-dir 2>/dev/null)" || wt_common=""
wt_common="$(finish_resolve_dir "$wt_common" "$worktree")" || wt_common=""
if [[ -n "$pin_common" && -n "$primary_common" && "$pin_common" != "$primary_common" ]]; then
  echo "refusing to land ${branch}: the common dir this landing was handed (${pin_common}) is not the primary's (${primary_common}); nothing moved." >&2
  echo "REFUSAL=other"
  exit 1
fi
[[ -n "$primary_common" ]] || primary_common="${pin_common:-$wt_common}"
if [[ -n "$wt_common" && "$wt_common" != "$primary_common" ]]; then
  echo "refusing to land ${branch}: the worktree's commondir names ${wt_common}, not the primary's common dir ${primary_common}; nothing moved." >&2
  echo "REFUSAL=other"
  exit 1
fi

# --- the code that judges a landing is BASE's: re-run from BASE's own copy ----------
# Everything below this block -- lib.sh, assert-head.sh, the landing lease
# (landing-lease.sh/.py), the test runner, the ledger, the lint -- used to be taken from
# wherever THIS file was started, which is the branch's own tree whenever the operator ran
# the worktree's copy. So a branch cut before a gate fix ran the OLD gate (2026-09-22:
# three landings after 1596abac ran the old landing-lease.py and refused, "relay is not
# reachable"), and a branch that rewrote its own runner merged with a red test
# (ISSUE(finish-worktree-runs-the-worktree-s-own-lease-code)).
#
# So before anything is sourced, BASE's copy of this skill's scripts directory and of the
# gate tools is written out of BASE's BLOBS (`git cat-file blob`, regular files only -- a
# symlink at a gate path is never followed, in BASE, in the branch or in the primary's
# working tree) into a private directory (mktemp -d, mode 700), and THAT copy of this file
# is run with the same arguments. The directory lives until this process exits, so the
# lease release, the ledger and the review spawn after the fast-forward -- which moves the
# primary's working tree to the branch's code -- still run BASE's copy. Always the blobs,
# never the primary's working tree: a blob cannot be edited under us or swapped for a link.
#
# An edited copy of this file used to be trusted up to the block below
# (ISSUE(branch-edited-finish-is-trusted-when-run-directly)). Before that block, and
# before any line a branch can plant ahead of it, the invoked file is compared with
# BASE's blob of this script. The blob is read from BASE's commit (`git cat-file blob`
# of the id `rev-parse <base>:<path>` names), never from the worktree file, a branch
# commit or the primary working tree. A difference re-execs that blob with the original
# argv, written to a private temporary file that is removed when the run returns or
# fails to start. The re-exec'd copy is marked with ISO_FINISH_REEXEC_BLOB set to that
# blob id (exported into its environment only) and does not re-exec again; any other
# value is ignored, so a stand-in id cannot skip the check. A byte-identical copy does
# not take this detour. An edited copy that belongs to the repository refuses when BASE
# carries no such script; a copy from outside the repository still falls through.
# $1 is this file's path. The remaining arguments are the caller's original argv.
finish_reexec_base_blob() {
  local g_common="" g_base="main" g_sha="" blob_id="" invoked="" invoked_id=""
  local rel="" here_real="" here_common="" reexec_rc=0
  rel=".cursor/skills/isolated-session/scripts/finish-worktree.sh"
  invoked="${1:-}"
  shift
  # the primary's common dir (above), never the one the worktree's commondir names
  g_common="$primary_common"
  [[ -n "$g_common" ]] || return 0
  if git --git-dir="$g_common" symbolic-ref --quiet refs/remotes/origin/HEAD >/dev/null 2>&1; then
    g_base="$(git --git-dir="$g_common" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
  fi
  if ! git --git-dir="$g_common" show-ref --verify --quiet "refs/heads/${g_base}" 2>/dev/null &&
     git --git-dir="$g_common" show-ref --verify --quiet "refs/heads/master" 2>/dev/null; then
    g_base="master"
  fi
  g_sha="$(git --git-dir="$g_common" rev-parse --verify --quiet "refs/heads/${g_base}^{commit}" 2>/dev/null)" || return 0
  blob_id="$(git --git-dir="$g_common" rev-parse --verify --quiet "${g_sha}:${rel}" 2>/dev/null)" || blob_id=""
  # Honoured only when it names BASE's blob. A different value is not a mark.
  if [[ -n "${ISO_FINISH_REEXEC_BLOB:-}" && -n "$blob_id" && "${ISO_FINISH_REEXEC_BLOB}" == "$blob_id" ]]; then
    unset ISO_FINISH_REEXEC_BLOB
    return 0
  fi
  if [[ -n "${ISO_FINISH_REEXEC_BLOB:-}" ]]; then
    unset ISO_FINISH_REEXEC_BLOB
  fi
  case "$invoked" in
    /*) ;;
    "") invoked="" ;;
    *) invoked="$(cd "$(dirname "$invoked")" 2>/dev/null && pwd)/$(basename "$invoked")" || invoked="" ;;
  esac
  if [[ -n "$blob_id" && -n "$invoked" && -f "$invoked" ]]; then
    invoked_id="$(git --git-dir="$g_common" hash-object -- "$invoked" 2>/dev/null)" || invoked_id=""
    if [[ -n "$invoked_id" && "$invoked_id" == "$blob_id" ]]; then
      return 0
    fi
  fi
  if [[ -z "$blob_id" ]]; then
    if [[ -z "$invoked" ]]; then
      return 0
    fi
    here_real="$(cd "$(dirname "$invoked")" 2>/dev/null && pwd -P)" || return 0
    here_common="$(git -C "$here_real" rev-parse --git-common-dir 2>/dev/null || true)"
    if [[ -z "$here_common" ]]; then
      return 0
    fi
    [[ "$here_common" == /* ]] || here_common="${here_real}/${here_common}"
    here_common="$(cd "$here_common" 2>/dev/null && pwd -P || true)"
    if [[ "$here_common" == "$g_common" ]]; then
      echo "refusing to land ${branch}: ${g_base} carries no ${rel}, and the copy started (${here}) belongs to the repository being landed; nothing moved." >&2
      echo "REFUSAL=gate"
      exit 1
    fi
    return 0
  fi
  FINISH_REEXEC_TMP="$(mktemp "${TMPDIR:-/tmp}/finish-reexec-XXXXXX" 2>/dev/null)" || {
    echo "refusing to land ${branch}: could not create a private file for ${g_base}'s finish-worktree.sh; nothing moved." >&2
    echo "REFUSAL=gate"
    exit 1
  }
  trap 'rm -f "$FINISH_REEXEC_TMP"; landing_marker_drop' EXIT
  chmod 700 "$FINISH_REEXEC_TMP" 2>/dev/null || {
    rm -f "$FINISH_REEXEC_TMP"
    trap 'landing_marker_drop' EXIT
    echo "refusing to land ${branch}: could not make the re-exec file private; nothing moved." >&2
    echo "REFUSAL=gate"
    exit 1
  }
  if ! git --git-dir="$g_common" cat-file blob "$blob_id" > "$FINISH_REEXEC_TMP"; then
    rm -f "$FINISH_REEXEC_TMP"
    trap 'landing_marker_drop' EXIT
    echo "refusing to land ${branch}: could not read ${g_base}'s finish-worktree.sh from the commit object; nothing moved." >&2
    echo "REFUSAL=gate"
    exit 1
  fi
  chmod 700 "$FINISH_REEXEC_TMP" 2>/dev/null || true
  set +e
  ISO_FINISH_REEXEC_BLOB="$blob_id" finish_child_run bash "$FINISH_REEXEC_TMP" "$@"
  reexec_rc=$?
  set -e
  rm -f "$FINISH_REEXEC_TMP"
  trap 'landing_marker_drop' EXIT
  exit "$reexec_rc"
}

finish_reexec_base_blob "${BASH_SOURCE[0]}" "$@"

# A copy of this file that lives OUTSIDE the repository being landed (a vendored skill
# driving another repository, a test harness) is nothing the branch wrote: when BASE
# carries no finish-worktree.sh of its own, that copy runs, still with BASE's tools. A copy
# INSIDE the repository with no BASE copy to hand over to is refused.
gate_scripts_rel=".cursor/skills/isolated-session/scripts"
gate_tools="tools/run_tests.py tools/gate_slots.py tools/affected_tests.py tools/sec_lint.py tools/audit_scope.py
            tools/ledger.py tools/backlog_build.py tools/spec_build.py company/ops/backlog_to_core.py
            appl/config.py"
here_real="$(cd "$here" && pwd -P)"
# --- a gate directory handed in is trusted only as a sealed copy of BASE's blobs ----------
# ISO_FINISH_GATE_DIR used to be taken on -d, ! -L and -O alone: any directory of this
# uid's was the gate, and every tool the landing runs came out of it. And the branch's tests
# run as this uid too, so a copy they can reach they can chmod and rewrite
# (ISSUE(security-audit-2026-09-27-daily-2026-09-27)). So a directory is the gate only when
# it is a real directory of this uid's, nothing in it is writable by anyone, it holds only
# directories and regular files of this uid's, and every file is byte for byte the blob
# BASE carries at that path. Which BASE is gate_dir_from's answer, once, as the dir is
# accepted: the commit ISO_FINISH_GATE_BASE names when it is BASE's tip or under it (the
# commit land.sh or the copy below extracted from), else BASE's tip. gate_dir_from prints
# that commit, or why not and returns 1; gate_dir_untrusted prints why the dir is not such
# a copy of it and returns 1, silent and 0 when it is. The second is asked again, of the
# same commit, after every run of the branch's tests, before anything runs out of the dir.
gate_dir_from() {  # $1 the BASE commit the dir was extracted from, or ""
  local g_common="$primary_common" g_base="main" g_tip="" g_from=""
  if [[ -z "$g_common" ]]; then
    echo "there is no primary common dir to check it against"
    return 1
  fi
  if git --git-dir="$g_common" symbolic-ref --quiet refs/remotes/origin/HEAD >/dev/null 2>&1; then
    g_base="$(git --git-dir="$g_common" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
  fi
  if ! git --git-dir="$g_common" show-ref --verify --quiet "refs/heads/${g_base}" 2>/dev/null &&
     git --git-dir="$g_common" show-ref --verify --quiet "refs/heads/master" 2>/dev/null; then
    g_base="master"
  fi
  if ! g_tip="$(git --git-dir="$g_common" rev-parse --verify --quiet "refs/heads/${g_base}^{commit}" 2>/dev/null)"; then
    echo "there is no branch ${g_base} to check it against"
    return 1
  fi
  g_from="$g_tip"
  if [[ -n "$1" ]]; then
    if [[ "$1" == *[!0-9a-f]* ]] ||
       ! g_from="$(git --git-dir="$g_common" rev-parse --verify --quiet "${1}^{commit}" 2>/dev/null)" ||
       ! git --git-dir="$g_common" merge-base --is-ancestor "$g_from" "$g_tip" 2>/dev/null; then
      echo "the commit it names as its BASE is not ${g_base}'s tip or under it"
      return 1
    fi
  fi
  printf '%s\n' "$g_from"
}
gate_dir_untrusted() {  # $1 the directory, $2 the commit gate_dir_from named
  if [[ -z "$primary_common" || -z "$2" ]]; then
    echo "there is no BASE commit to check it against"
    return 1
  fi
  # git, find and the shell only: a landing with no python3 on PATH gates itself too
  local top="$1" rev="$2" uid="" out="" rel="" rels="" want="" got="" n=0 i=0
  local -a wants=() gots=() names=()
  if [[ -L "$top" ]]; then
    echo "it is a symlink"
    return 1
  fi
  if [[ ! -d "$top" ]]; then
    echo "it is not a directory"
    return 1
  fi
  uid="$(id -u)" || { echo "this uid could not be read"; return 1; }
  # find never follows a link here (-P is its default); a walk that fails is a refusal
  if ! out="$(find "$top" ! -user "$uid" 2>&1)"; then
    echo "it could not be walked: ${out%%$'\n'*}"
    return 1
  fi
  if [[ -n "$out" ]]; then
    echo "${out%%$'\n'*} is owned by another uid, not this uid ${uid}"
    return 1
  fi
  out="$(find "$top" \( -perm -0200 -o -perm -0020 -o -perm -0002 \) 2>&1)" ||
    { echo "it could not be walked"; return 1; }
  if [[ -n "$out" ]]; then
    echo "${out%%$'\n'*} is writable, so it could have been changed since it was extracted"
    return 1
  fi
  out="$(find "$top" ! -type d ! -type f 2>&1)" || { echo "it could not be walked"; return 1; }
  if [[ -n "$out" ]]; then
    echo "${out%%$'\n'*} is neither a directory nor a regular file"
    return 1
  fi
  out="$(find "$top" -mindepth 1 -name '*[!A-Za-z0-9._-]*' 2>&1)" || { echo "it could not be walked"; return 1; }
  if [[ -n "$out" ]]; then
    echo "it holds a name no gate copy carries"
    return 1
  fi
  rels="$(cd "$top" && find . -type f | sort)" || { echo "its files could not be listed"; return 1; }
  [[ -n "$rels" ]] || return 0
  while IFS= read -r rel; do
    names[n]="${rel#./}"
    n=$(( n + 1 ))
  done <<< "$rels"
  # what BASE holds at each path, and what each file hashes to, one line per file in order
  want="$(for rel in "${names[@]}"; do printf '%s:%s\n' "$rev" "$rel"; done |
          git --git-dir="$primary_common" cat-file --batch-check='%(objectname) %(objecttype)' 2>/dev/null)" ||
    { echo "BASE's tree could not be read"; return 1; }
  got="$(for rel in "${names[@]}"; do printf '%s/%s\n' "$top" "$rel"; done |
         git --git-dir="$primary_common" hash-object --no-filters --stdin-paths 2>/dev/null)" ||
    { echo "its files could not be hashed"; return 1; }
  while IFS= read -r rel; do wants[${#wants[@]}]="$rel"; done <<< "$want"
  while IFS= read -r rel; do gots[${#gots[@]}]="$rel"; done <<< "$got"
  while (( i < n )); do
    if [[ "${wants[i]:-}" != "${gots[i]:-x} blob" ]]; then
      echo "${top}/${names[i]} is not BASE's blob"
      return 1
    fi
    i=$(( i + 1 ))
  done
  return 0
}
gate_dir=""
gate_dir_base=""
if [[ -n "${ISO_FINISH_GATE_DIR:-}" && "${ISO_FINISH_GATE_SELF:-}" == "$here_real" ]]; then
  if ! gate_dir_base="$(gate_dir_from "${ISO_FINISH_GATE_BASE:-}" 2>&1)" ||
     ! gate_dir_why="$(gate_dir_untrusted "$ISO_FINISH_GATE_DIR" "$gate_dir_base" 2>&1)"; then
    echo "refusing to land ${branch}: the gate directory ISO_FINISH_GATE_DIR=${ISO_FINISH_GATE_DIR} is not a copy this landing can trust: ${gate_dir_why:-${gate_dir_base:-it could not be checked}}; nothing ran from it and nothing moved." >&2
    echo "REFUSAL=gate"
    exit 1
  fi
  gate_dir="$ISO_FINISH_GATE_DIR"
fi
gate_from_base="${ISO_FINISH_GATE_FROM:-}"
# never inherited: a test this landing runs starts its own finish, which gates itself
unset ISO_FINISH_GATE_DIR ISO_FINISH_GATE_SELF ISO_FINISH_GATE_FROM ISO_FINISH_GATE_BASE
if [[ -z "$gate_dir" ]]; then
  # One stderr line, before any lock, lease or ref is touched.
  gate_refuse() {
    echo "refusing to land ${branch}: $1; nothing moved." >&2
    echo "REFUSAL=gate"
    exit 1
  }
  # BASE and its blobs come out of the primary's common dir, never the worktree's commondir
  g_common="$primary_common"
  [[ -n "$g_common" ]] ||
    gate_refuse "${worktree} is not a git checkout, so there is no BASE to take the gate code from"
  if git --git-dir="$g_common" symbolic-ref --quiet refs/remotes/origin/HEAD >/dev/null 2>&1; then
    g_base="$(git --git-dir="$g_common" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
  else
    g_base="main"
  fi
  if ! git --git-dir="$g_common" show-ref --verify --quiet "refs/heads/${g_base}" 2>/dev/null &&
     git --git-dir="$g_common" show-ref --verify --quiet "refs/heads/master" 2>/dev/null; then
    g_base="master"
  fi
  g_sha="$(git --git-dir="$g_common" rev-parse --verify --quiet "refs/heads/${g_base}^{commit}" 2>/dev/null)" ||
    gate_refuse "there is no branch ${g_base} in $(dirname "$g_common") to take the gate code from"
  # is the copy that was started part of the repository being landed?
  g_here_common="$(git -C "$here_real" rev-parse --git-common-dir 2>/dev/null || true)"
  g_here_inside="no"
  if [[ -n "$g_here_common" ]]; then
    [[ "$g_here_common" == /* ]] || g_here_common="${here_real}/${g_here_common}"
    g_here_common="$(cd "$g_here_common" 2>/dev/null && pwd -P || true)"
    if [[ "$g_here_common" == "$g_common" ]]; then
      g_here_inside="yes"
    fi
  fi
  g_dir="$(mktemp -d "${TMPDIR:-/tmp}/finish-gate-XXXXXX" 2>/dev/null)" ||
    gate_refuse "could not create a private directory for ${g_base}'s gate code under ${TMPDIR:-/tmp}"
  trap 'chmod -R u+w "$g_dir" 2>/dev/null; rm -rf "$g_dir"; landing_marker_drop' EXIT
  chmod 700 "$g_dir" 2>/dev/null || gate_refuse "could not make ${g_dir} private"
  g_real="$(cd "$g_dir" && pwd -P)"
  # One path out of BASE's tree: 0 written, 1 not in BASE as a regular file, 2 failed.
  gate_put() {  # $1 path relative to the top of the tree
    local rec="" meta="" mode=""
    rec="$(git --git-dir="$g_common" ls-tree --full-tree "$g_sha" -- "$1" 2>/dev/null)" || return 2
    [[ -n "$rec" && "${rec#*$'\t'}" == "$1" ]] || return 1
    meta="${rec%%$'\t'*}"
    mode="${meta%% *}"
    case "$mode" in
      100644|100755) ;;
      *) return 1 ;;
    esac
    mkdir -p "${g_dir}/$(dirname "$1")" 2>/dev/null || return 2
    git --git-dir="$g_common" cat-file blob "${meta##* }" > "${g_dir}/$1" 2>/dev/null || return 2
    chmod 700 "${g_dir}/$1" 2>/dev/null || return 2
  }
  g_names="$(git --git-dir="$g_common" ls-tree --full-tree --name-only "$g_sha" -- "${gate_scripts_rel}/" 2>/dev/null)" ||
    gate_refuse "could not list ${gate_scripts_rel} in ${g_base}"
  for g_path in $g_names $gate_tools; do
    case "$g_path" in
      *[!A-Za-z0-9._/-]*) continue ;;       # a name this block would have to quote: not ours
    esac
    g_rc=0
    gate_put "$g_path" || g_rc=$?
    [[ "$g_rc" != "2" ]] || gate_refuse "could not write ${g_base}:${g_path} into ${g_dir}"
  done
  # BASE's tools/ledger.py puts its own directory on sys.path and imports siblings from it,
  # which no fixed list can name (ISSUE(gate-copy-lacks-the-ledgers-import)). So its imports
  # are READ -- parsed, never run -- out of the copy, and every tools/<name>.py they reach
  # that BASE carries is written in from BASE's blob, walking on through each one written.
  # A name the interpreter itself resolves (the standard library) is left alone, and a name
  # BASE does not carry is left out: the ledger then crashes in the copy, and the check
  # below reports that as a ledger crash. The branch's copy of a sibling is never read.
  g_absent=""
  while [[ -f "${g_dir}/tools/ledger.py" ]]; do
    g_more="$(python3 -I - "$g_dir" $g_absent <<'PY'
import ast, importlib.util, os, sys
top, absent = sys.argv[1], set(sys.argv[2:])
queue = ["tools/ledger.py"]
seen, want = set(queue), []
while queue:
    rel = queue.pop(0)
    try:
        tree = ast.parse(open(os.path.join(top, rel), "rb").read(), rel)
    except (OSError, SyntaxError, ValueError):
        continue
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
            names.add(node.module.split(".")[0])
    for name in sorted(names):
        nxt = "tools/" + name + ".py"
        if nxt in seen or not name.isidentifier():
            continue
        seen.add(nxt)
        if os.path.isfile(os.path.join(top, nxt)):
            queue.append(nxt)
        elif nxt not in absent and importlib.util.find_spec(name) is None:
            want.append(nxt)
print("\n".join(want))
PY
)" || gate_refuse "could not read the imports of ${g_base}'s tools/ledger.py"
    [[ -n "$g_more" ]] || break
    for g_path in $g_more; do
      case "$g_path" in
        *[!A-Za-z0-9._/-]*) g_absent="${g_absent} ${g_path}"; continue ;;
      esac
      g_rc=0
      gate_put "$g_path" || g_rc=$?
      [[ "$g_rc" != "2" ]] || gate_refuse "could not write ${g_base}:${g_path} into ${g_dir}"
      [[ "$g_rc" != "1" ]] || g_absent="${g_absent} ${g_path}"
    done
  done
  if [[ -f "${g_dir}/${gate_scripts_rel}/finish-worktree.sh" && -f "${g_dir}/${gate_scripts_rel}/lib.sh" ]]; then
    g_run="${g_dir}/${gate_scripts_rel}/finish-worktree.sh"
    g_self="${g_real}/${gate_scripts_rel}"
    g_from="${g_base}@${g_sha}"
  elif [[ "$g_here_inside" == "yes" ]]; then
    gate_refuse "${g_base} carries no ${gate_scripts_rel}/finish-worktree.sh and lib.sh as regular files, and the copy started (${here}) belongs to the repository being landed; run a copy of the skill from outside it"
  else
    g_run="${here_real}/$(basename "$0")"
    g_self="$here_real"
    g_from=""
  fi
  # Sealed before it is handed over: the child takes it only as a read-only copy of
  # g_sha's blobs (gate_dir_untrusted, above), the same test land.sh's copy passes, and
  # asks it again after every run of the branch's tests.
  chmod -R a-w "$g_dir" 2>/dev/null || gate_refuse "could not make ${g_dir} read-only"
  set +e
  if [[ -n "${HERD_WORKER:-}" && -n "${HERD_DIR:-}" ]] && command -v python3 >/dev/null 2>&1; then
    # a herd worker's landing: through the receipt relay above
    ISO_FINISH_GATE_DIR="$g_dir" ISO_FINISH_GATE_SELF="$g_self" ISO_FINISH_GATE_FROM="$g_from" \
      ISO_FINISH_GATE_BASE="$g_sha" \
      finish_child_run python3 -I -c "$receipt_append_py" "${HERD_DIR:-}" "$HERD_WORKER" "$branch" bash "$g_run" "$@"
  else
    ISO_FINISH_GATE_DIR="$g_dir" ISO_FINISH_GATE_SELF="$g_self" ISO_FINISH_GATE_FROM="$g_from" \
      ISO_FINISH_GATE_BASE="$g_sha" \
      finish_child_run bash "$g_run" "$@"
  fi
  g_rc=$?
  set -e
  chmod -R u+w "$g_dir" 2>/dev/null || true
  rm -rf "$g_dir"
  trap 'landing_marker_drop' EXIT
  exit "$g_rc"
fi
# From here on this is the gate's own run: `here` is BASE's scripts directory (or the
# outside copy above), and every gate tool comes from gate_dir -- never the worktree's.
gate_runner="${gate_dir}/tools/run_tests.py"
gate_ledger="${gate_dir}/tools/ledger.py"
gate_config="${gate_dir}/appl/config.py"
# The [tests] command's reader: BASE's appl/config.py, or -- in a consumer, whose BASE
# carries no appl/ -- the byte-identical copy the skill ships, scripts/appl_config.py, out
# of the same gate copy of BASE. Never the branch's, never one beside the started copy.
gate_tests_config="$gate_config"
if [[ ! -f "$gate_tests_config" ]]; then
  gate_tests_config="${gate_dir}/${gate_scripts_rel}/appl_config.py"
fi

# land.sh hands over the tip it recorded and tested (ISO_FINISH_EXPECT_TIP): a branch that
# no longer equals it when this landing reads it is refused before anything is judged. It
# can only add a refusal, so it needs no trust. Cleared: nothing this landing starts
# inherits it.
expect_tip="${ISO_FINISH_EXPECT_TIP-}"
unset ISO_FINISH_EXPECT_TIP

# --- appl.toml's [tests] command: asked for, never trusted on its own ----------------
# `bin/appl land` hands the launcher root's `[tests] command` over as APPL_TESTS_COMMAND.
# Anyone can set that variable -- a direct call, a worker's environment carried into
# land.sh, a caller of `appl land` (which clears it) -- so its value is only a REQUEST:
# the command runs in place of tools/run_tests.py only when it is exactly what BASE's
# appl/config.py reads out of the primary's own appl.toml (resolved once `primary` is
# known, below). Never the branch's appl.toml, never the branch's config.py. Cleared here,
# so nothing this landing starts -- a test that runs its own finish -- inherits it.
tests_command_asked="${APPL_TESTS_COMMAND-}"
unset APPL_TESTS_COMMAND
tests_command=""
# Its twin, `[scan] command` as APPL_SCAN_COMMAND, the same way: a request that runs in
# place of tools/sec_lint.py's diff scan only when it matches the primary's appl.toml.
scan_command_asked="${APPL_SCAN_COMMAND-}"
unset APPL_SCAN_COMMAND
scan_command=""
# And `[ledger] command` as APPL_LEDGER_COMMAND, the same way: a request that runs in
# place of tools/ledger.py build only when it matches the primary's appl.toml.
ledger_command_asked="${APPL_LEDGER_COMMAND-}"
unset APPL_LEDGER_COMMAND
ledger_command=""

. "$here/lib.sh"
iso_credless_arm

# Everything from here to the end of this file is ONE command, read whole before any of it
# runs. bash reads a script as it goes, so a branch test that rewrote this file in place
# while the landing ran its tests would otherwise have its text run in the lines after
# them -- ahead of the check (gate_dir_hold) that refuses the rewritten copy.
{

# The affected tests run in a disposable `git clone --shared` of BASE at the
# checkout's tip (land-sandbox.sh), never with --root set to the worktree.
# GIT_CEILING_DIRECTORIES is that clone's private parent. Every other GIT_* name
# is stripped here; branch_tests_python's credential wall adds its own, and
# tools/run_tests.py keeps those for the test child, drops every other GIT_*
# name and blanks SSH_AUTH_SOCK when MURETAI_LAND_SANDBOX is set. The clone's
# directory is removed when the run returns, pass or fail. A clone that cannot
# be created refuses the landing.
# The branch's tests run as this uid, so after every run of them the gate directory is held
# to the check it was accepted on (gate_dir_untrusted, above) before anything runs out of it
# again: a copy a test changed refuses the landing by name. $1 says where the landing is;
# the rest are this landing's scratch files, removed on the refusal.
gate_dir_hold() {  # $1 where, $2... files to remove on a refusal
  local where="$1" why=""
  shift
  [[ -n "$gate_dir" ]] || return 0
  if why="$(gate_dir_untrusted "$gate_dir" "$gate_dir_base" 2>&1)"; then
    return 0
  fi
  [[ "$#" == "0" ]] || rm -f "$@"
  echo "refusing to land ${branch}: the gate directory ${gate_dir} is no longer a copy this landing can trust ${where}: ${why:-it could not be checked}; nothing more runs from it, and ${branch} was not merged." >&2
  echo "MERGED=no"
  refusal_category="gate"
  exit 1
}
sandbox_parent=""
sandbox_clone=""
sandbox_end() {
  # The clone goes. The private parent stays: it is GIT_CEILING_DIRECTORIES. The helper
  # runs out of the gate directory, and only while that still passes its check: the
  # tests just ran, and the caller refuses a copy they changed.
  if [[ -n "${sandbox_clone:-}" ]]; then
    if gate_dir_untrusted "$gate_dir" "$gate_dir_base" >/dev/null 2>&1; then
      /bin/bash "$here/land-sandbox.sh" remove "$sandbox_clone" || true
    fi
  fi
  sandbox_parent=""
  sandbox_clone=""
}
sandbox_begin() {  # $1 the checkout whose HEAD the clone detaches at
  local out="" rc=0
  sandbox_parent=""
  sandbox_clone=""
  if [[ ! -f "$here/land-sandbox.sh" || -L "$here/land-sandbox.sh" ]]; then
    echo "disposable clone could not be created: land-sandbox.sh is not in the gate scripts" >&2
    return 1
  fi
  out="$(/bin/bash "$here/land-sandbox.sh" prepare "$1")" || rc=$?
  if [[ "$rc" != "0" ]]; then
    return 1
  fi
  sandbox_parent="$(printf '%s\n' "$out" | sed -n 's/^parent=//p' | head -n 1)"
  sandbox_clone="$(printf '%s\n' "$out" | sed -n 's/^clone=//p' | head -n 1)"
  if [[ -z "$sandbox_parent" || -z "$sandbox_clone" || ! -d "$sandbox_clone" ]]; then
    echo "disposable clone could not be created: the helper named no clone" >&2
    sandbox_end
    return 1
  fi
  return 0
}
sandbox_child_env() {
  local key="" names=""
  names="$(env | sed -n 's/=.*//p')"
  for key in $names; do
    case "$key" in
      GIT_*) unset "$key" ;;
    esac
  done
  export GIT_CEILING_DIRECTORIES="$sandbox_parent"
  export MURETAI_LAND_SANDBOX="$sandbox_parent"
}

# --- behind a herd worker's wall, the landing is the launcher's to run ----------------
# A walled worker (herd-spawn.sh) cannot run the landing's gate: suites that build a wall,
# walk the process tree or write beside its HERD_DIR entry die of the wall, and the merge
# writes the primary, which the wall denies (2026-09-24: `32 ok, 1 skip, 5 fail` walled,
# all green from an operator's shell). The gate is not the worker's work, so it runs
# OUTSIDE the wall: the launcher herd-spawn.sh put outside it serves a landing REQUEST by
# running the PRIMARY's finish-worktree.sh, unwalled, on the branch and worktree the
# worker was STARTED on -- state the launcher holds, never anything this request says.
# The launcher marks the agent's environment with HERD_GATE_* (walled spawns only); this
# block only asks, waits, and prints what came back. It asks only for the landing the
# launcher would do anyway -- the same branch in the same worktree -- so a test fixture
# that runs finish on some OTHER branch from inside a worker still lands in the wall (and
# its suites say they could not run), and never sets the worker's real landing off.
# The variables are cleared either way: nothing this landing starts inherits the channel.
# The receipt that comes back carries the launcher's own GATE= line saying where it ran.
hg_channel="${HERD_GATE_CHANNEL:-}"
hg_branch="${HERD_GATE_BRANCH:-}"
hg_worktree="${HERD_GATE_WORKTREE:-}"
unset HERD_GATE_CHANNEL HERD_GATE_BRANCH HERD_GATE_WORKTREE
if [[ -n "$hg_channel" && "$branch" == "$hg_branch" && -n "$hg_worktree" &&
      "$(cd "$worktree" && pwd -P)" == "$hg_worktree" && -d "$hg_channel" && ! -L "$hg_channel" ]]; then
  set +e
  landing_python - "$hg_channel" "$branch" "$worktree" <<'PY'
import json, os, sys, time
chan, branch, worktree = sys.argv[1:4]
req, res = os.path.join(chan, "gate.request"), os.path.join(chan, "gate.result")
ACK_S, WAIT_S = 30, 6 * 3600


def refuse(why: str) -> None:
    print("refusing to land %s: %s; nothing moved." % (branch, why), file=sys.stderr)
    print("MERGED=no")
    print("REFUSAL=other")
    sys.exit(1)


try:
    if os.path.lexists(res):
        os.unlink(res)                       # an answer to an EARLIER request is not ours
    tmp = "%s.%d" % (req, os.getpid())
    with open(tmp, "x", encoding="utf-8") as f:
        json.dump({"branch": branch, "worktree": worktree}, f)
    os.replace(tmp, req)
except OSError as e:
    refuse("behind the worker's wall the gate cannot run here, and the landing request "
           "could not be written to %s (%s)" % (chan, e.strerror or type(e).__name__))
print("the gate runs outside the worker's wall: landing %s was handed to the herd launcher; "
      "waiting for its receipt" % branch, file=sys.stderr, flush=True)
t0 = time.time()
while os.path.lexists(req):
    if time.time() - t0 > ACK_S:
        try:
            os.unlink(req)
        except OSError:
            pass
        refuse("behind the worker's wall the gate cannot run here, and the herd launcher did not "
               "take the landing request within %ds (is this worker still under its launcher?)" % ACK_S)
    time.sleep(0.2)
while not os.path.lexists(res):
    if time.time() - t0 > WAIT_S:
        refuse("the herd launcher took the landing request and gave no receipt within %ds" % WAIT_S)
    time.sleep(0.5)
try:
    with open(res, encoding="utf-8", errors="replace") as f:
        got = json.load(f)
    os.unlink(res)
    rc, out, err = int(got["rc"]), str(got["stdout"]), str(got["stderr"])
except (OSError, ValueError, KeyError, TypeError) as e:
    # the landing outside DID run: whether it moved BASE is the primary's to say, not ours
    print("the herd launcher ran the landing of %s outside the worker's wall, and its receipt "
          "could not be read (%s): look at the primary before landing again" % (branch, type(e).__name__),
          file=sys.stderr)
    sys.exit(1)
sys.stderr.write(err)
sys.stdout.write(out)
sys.exit(rc)
PY
  hg_rc=$?
  set -e
  exit "$hg_rc"
fi

# --- the refusal's category, and the landing receipt in the run ledger ---------------
# Every refusal prints exactly one stdout line REFUSAL=<category>, one of: usage config
# lock lock-take-failed lease dirty diverged collision generated gate tests sec ledger publish other. A
# refusal site from here on names its category in refusal_category before it exits; one
# that names none is `other`. A landing that merged prints no REFUSAL= line. Each landing
# that reaches this point, merged or refused, also appends one landing-receipt line to
# $HERD_DIR/coordinator/runs.jsonl through run_ledger.py beside this script: MERGED, GATE,
# SEC, TESTS and TESTS_SECS as the receipt printed them ("" when it printed no such line),
# REFUSAL (the category, "" on a landing that merged) and COMMIT (the branch tip). The
# append is best effort: a ledger that refuses the line or cannot be written never blocks
# the landing, nor changes what it prints or exits with.
refusal_category=""
receipt_merged="no"
receipt_gate=""
receipt_sec=""
receipt_tests=""
receipt_tests_secs=""
receipt_noted="no"
receipt_tip="$(git --git-dir="$primary_common" rev-parse --verify --quiet "refs/heads/${branch}^{commit}" 2>/dev/null || true)"
finish_receipt_note() {  # $1 the exit status
  local refusal="" mod="$here/run_ledger.py"
  [[ "$receipt_noted" == "no" ]] || return 0
  receipt_noted="yes"
  if [[ "$1" != "0" && "$receipt_merged" != "yes" ]]; then
    refusal="${refusal_category:-other}"
    echo "REFUSAL=${refusal}" || true
  fi
  [[ -f "$mod" && ! -L "$mod" ]] || return 0
  landing_python "$mod" "${HERD_DIR:-${HOME:-}/.cache/muretai-herd}" landing-receipt "" "${HERD_WORKER:-}" \
    "MERGED=${receipt_merged}" "GATE=${receipt_gate}" "SEC=${receipt_sec}" "TESTS=${receipt_tests}" \
    "TESTS_SECS=${receipt_tests_secs}" "REFUSAL=${refusal}" "COMMIT=${scanned_tip:-$receipt_tip}" \
    < /dev/null > /dev/null 2>&1 || true
  return 0
}
trap 'finish_receipt_note $?; landing_marker_drop' EXIT

# --- before anything prints a name somebody else chose ----------------------------
# Every such name goes through iso_safe_text, which spells out each code point in an
# invisible Unicode category. That answer comes from python3, and the old helper fell back
# to a byte-level `tr` in SILENCE whenever its python could not run -- a fallback that
# stops at 0x7F, so U+009B (the 8-bit CSI, erase-line in a UTF-8 terminal) and U+202E
# passed through it byte-identical, with no sign to the operator that anything had changed
# (ISSUE(security-audit-2026-09-18-daily-2026-09-18-3)). Asked once, here, because a
# landing that cannot print a name safely does not print it at all.
case "$(iso_safe_text_mode)" in
  python) ;;
  tr)
    # a machine with no python3 at all: worse than the category table, never nothing, and
    # said out loud rather than chosen quietly
    echo "note: names printed with the byte-level fallback (no python3)" >&2
    ;;
  *)
    {
      echo "refusing to land: this landing could not print safely -- a python3 is on PATH"
      echo "and iso_safe_text could not run it, so every name it would show you (a colliding"
      echo "path, a lint finding, a red test file) would fall to a byte-level fallback that"
      echo "leaves U+009B and U+202E intact. Fix python3, or remove it from PATH to accept"
      echo "the fallback deliberately. Nothing moved."
    } >&2
    exit 1
    ;;
esac

# ... and the branch name is a name somebody chose too. git accepts a C1 byte in a ref
# name (it refuses CR and the 0x00-0x1F range, not U+009B), and ${branch} is printed raw in
# every refusal, in BRANCH= on the receipt, in the exit notes and in the "waiting for the
# landing lock" line ANOTHER operator reads. Rather than escape it at each of those sinks
# and add the next one to the same list, a name carrying a code point that cannot be
# printed as itself is refused HERE -- before the landing lock, before assert-head.sh,
# before anything else prints at all. No honest branch has one
# (ISSUE(security-audit-2026-09-18-daily-2026-09-18-4)).
branch_safe="$(iso_safe_text "$branch")"
if [[ "$branch_safe" != "$branch" ]]; then
  {
    echo "refusing to land: the branch name carries a code point that cannot be printed as"
    echo "itself, so it is spelled out here and nowhere else:"
    echo "   ${branch_safe}"
    echo "Rename it (git branch -m) and run finish again; nothing moved, and no landing lock"
    echo "was taken."
  } >&2
  exit 1
fi

case "$branch" in
  main|master|develop)
    echo "refusing to finish a base branch (${branch})" >&2
    exit 1
    ;;
  cursor/*)
    echo "Cloud Agent: do not merge into main. Open a ready-for-review PR." >&2
    exit 3
    ;;
esac

"$here/assert-head.sh" "$branch" "$worktree"

# The tip land.sh recorded and tested, when it handed one over: refuses, naming the branch
# and both shas, when the branch is anywhere else. $1 says where the landing is.
expect_tip_hold() {
  local now=""
  [[ -n "$expect_tip" ]] || return 0
  now="$(git -C "$worktree" rev-parse --verify --quiet "refs/heads/${branch}^{commit}" 2>/dev/null || true)"
  [[ "$now" != "$expect_tip" ]] || return 0
  echo "refusing to land ${branch}: the branch moved ${1} -- the launcher recorded and tested ${expect_tip:0:12}, the branch is now ${now:0:12}; nothing was merged." >&2
  echo "MERGED=no"
  echo "TIP_MOVED=${now:-none}"
  exit 1
}
expect_tip_hold "after the launcher recorded its tip"

# GIT_COMMON_DIR pinned to the primary's: a commondir the worker swapped since the check
# above is not followed
if [[ -n "$(GIT_COMMON_DIR="$primary_common" git -C "$worktree" status --porcelain)" ]]; then
  echo "uncommitted changes in worktree; commit or discard before finish" >&2
  GIT_COMMON_DIR="$primary_common" git -C "$worktree" status -sb >&2
  refusal_category="dirty"
  exit 1
fi

# the primary's common dir, as resolved above -- never the worktree's commondir
git_common="$primary_common"
primary="$(dirname "$git_common")"
# lib.sh's origin fetch runs with GIT_COMMON_DIR pinned to it
iso_pin_common="$git_common"

# The requests above stand only when the launcher root's appl.toml -- the primary's, a
# regular file, read by BASE's config.py -- names that very command. Anything else (no
# file, a link, a refusal, no [tests]/[scan]/[ledger] command, a different one) falls
# back to tools/run_tests.py / tools/sec_lint.py / tools/ledger.py build, and says so.
if [[ -n "$tests_command_asked" || -n "$scan_command_asked" || -n "$ledger_command_asked" ]]; then
  tc_configured=""
  sc_configured=""
  lc_configured=""
  if [[ -f "$gate_tests_config" && -f "${primary}/appl.toml" && ! -L "${primary}/appl.toml" ]]; then
    tc_handoff="$(finish_tmp)"
    if landing_python "$gate_tests_config" handoff "${primary}/appl.toml" > "$tc_handoff" 2>/dev/null; then
      while IFS= read -r -d '' tc_name && IFS= read -r -d '' tc_value; do
        if [[ "$tc_name" == "APPL_TESTS_COMMAND" ]]; then
          tc_configured="$tc_value"
        elif [[ "$gate_tests_config" != "$gate_config" ]]; then
          # the skill's copy vouches for the [tests] command only; [scan] and [ledger]
          # stay with BASE's appl/config.py
          continue
        elif [[ "$tc_name" == "APPL_SCAN_COMMAND" ]]; then
          sc_configured="$tc_value"
        elif [[ "$tc_name" == "APPL_LEDGER_COMMAND" ]]; then
          lc_configured="$tc_value"
        fi
      done < "$tc_handoff"
    fi
    rm -f "$tc_handoff"
  fi
  if [[ -n "$tests_command_asked" ]]; then
    # a whitespace-only [tests] command is no command: it counts as unset, never as a pass
    if [[ -n "${tc_configured//[[:space:]]/}" && "$tc_configured" == "$tests_command_asked" ]]; then
      tests_command="$tc_configured"
    else
      echo "NOTE: ignoring APPL_TESTS_COMMAND -- it is not the [tests] command of ${primary}/appl.toml; tools/run_tests.py judges" >&2
    fi
  fi
  if [[ -n "$scan_command_asked" ]]; then
    if [[ -n "$sc_configured" && "$sc_configured" == "$scan_command_asked" ]]; then
      scan_command="$sc_configured"
    else
      echo "NOTE: ignoring APPL_SCAN_COMMAND -- it is not the [scan] command of ${primary}/appl.toml; tools/sec_lint.py judges" >&2
    fi
  fi
  if [[ -n "$ledger_command_asked" ]]; then
    if [[ -n "$lc_configured" && "$lc_configured" == "$ledger_command_asked" ]]; then
      ledger_command="$lc_configured"
    else
      echo "NOTE: ignoring APPL_LEDGER_COMMAND -- it is not the [ledger] command of ${primary}/appl.toml; tools/ledger.py judges" >&2
    fi
  fi
fi

# --- appl.toml's gate = "github": a hand-off, not a landing --------------------------
# BASE's COMMITTED appl.toml at BASE's tip (a regular blob, fed to BASE's config.py -- never
# the primary's working tree, never the branch's) may say `gate = "github"`: the landing is
# then not this machine's to make. The working tree is not read for it because a merge
# runs in the checkout that has BASE checked out: a branch that landed `gate = "github"`
# would otherwise hand off every later landing, the reviewer's receipt and the revert
# included (intake 20261028T172727Z). No landing lock is taken and main is never written.
# A branch that does not descend from main first has main MERGED into it, in the worktree
# (a merge commit on the branch, never a rebase); a merge that conflicts is aborted, the
# tip left as it was, and refused as diverged. Then the primary's appl.toml [tests] command
# runs once, in the worktree, on the merged tree; a non-zero exit refuses as tests, and the
# branch keeps the merge. Only when both pass does HANDED=github name the (new) branch tip,
# and the exit is 0. The hand-off writes its landing-receipt line (MERGED=no, GATE=handed
# github, COMMIT the tip) and a refusal on this path its own, as a local landing does. No
# gate key, `gate = "local"`, or a file the reader refuses lands as today -- and so does a
# branch whose change is only review receipts and notes, or only the gate taken back to
# local (config.py lands_locally: exact path rules, anything mixed is handed off).
gh_base="main"
if git --git-dir="$primary_common" symbolic-ref --quiet refs/remotes/origin/HEAD >/dev/null 2>&1; then
  gh_base="$(git --git-dir="$primary_common" symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')"
fi
if ! git --git-dir="$primary_common" show-ref --verify --quiet "refs/heads/${gh_base}" &&
   git --git-dir="$primary_common" show-ref --verify --quiet "refs/heads/master"; then
  gh_base="master"
fi
gh_main="$(git --git-dir="$primary_common" rev-parse --verify --quiet "refs/heads/${gh_base}^{commit}" 2>/dev/null || true)"
gh_tip="$(git --git-dir="$primary_common" rev-parse --verify --quiet "refs/heads/${branch}^{commit}" 2>/dev/null || true)"
# appl.toml at commit $1 into the file $2: 0 written, 1 none there as a regular blob
gate_toml_put() {
  local rec="" meta=""
  rec="$(git --git-dir="$primary_common" ls-tree --full-tree "$1" -- appl.toml 2>/dev/null)" || return 1
  [[ -n "$rec" && "${rec#*$'\t'}" == "appl.toml" ]] || return 1
  meta="${rec%%$'\t'*}"
  case "${meta%% *}" in
    100644|100755) ;;
    *) return 1 ;;
  esac
  git --git-dir="$primary_common" cat-file blob "${meta##* }" > "$2" 2>/dev/null || return 1
}
gate_word=""
if [[ -f "$gate_config" && -n "$gh_main" ]]; then
  gate_toml="$(finish_tmp)"
  if gate_toml_put "$gh_main" "$gate_toml"; then
    gate_word="$(landing_python "$gate_config" gate "$gate_toml" 2>/dev/null || true)"
  fi
  rm -f "$gate_toml"
fi
if [[ "$gate_word" == "github" && -n "$gh_tip" ]]; then
  gl_mb="$(git --git-dir="$primary_common" merge-base "$gh_main" "$gh_tip" 2>/dev/null || true)"
  if [[ -n "$gl_mb" ]]; then
    gl_changes="$(finish_tmp)"
    gl_base_toml="$(finish_tmp)"
    gl_tip_toml="$(finish_tmp)"
    gl_base_arg=""
    gl_tip_arg=""
    gate_toml_put "$gl_mb" "$gl_base_toml" && gl_base_arg="$gl_base_toml"
    gate_toml_put "$gh_tip" "$gl_tip_toml" && gl_tip_arg="$gl_tip_toml"
    gl_word=""
    if git --git-dir="$primary_common" diff-tree -r -z --no-renames --no-abbrev "$gl_mb" "$gh_tip" > "$gl_changes" 2>/dev/null; then
      gl_word="$(landing_python "$gate_config" lands-locally "$gl_changes" "$gl_base_arg" "$gl_tip_arg" 2>/dev/null || true)"
    fi
    rm -f "$gl_changes" "$gl_base_toml" "$gl_tip_toml"
    if [[ "$gl_word" == "yes" ]]; then
      echo "landing ${branch} here although ${gh_base}'s appl.toml says gate = \"github\": its change is only review receipts and notes, or only the gate taken back to local" >&2
      gate_word=""
    fi
  fi
fi
if [[ "$gate_word" == "github" ]]; then
  if [[ -z "$gh_main" || -z "$gh_tip" ]]; then
    echo "refusing to hand ${branch} off: ${gh_base} or the branch tip could not be read; nothing moved" >&2
    refusal_category="diverged"
    exit 1
  fi
  if ! git -C "$worktree" merge-base --is-ancestor "$gh_main" "$gh_tip" >/dev/null 2>&1; then
    echo "merging ${gh_base} ${gh_main} into ${branch} in its worktree before the hand-off" >&2
    set +e
    git -C "$worktree" merge --no-ff --no-edit -m "Merge ${gh_base} into ${branch}" "$gh_main" >&2
    gh_rc=$?
    set -e
    if [[ "$gh_rc" != "0" ]]; then
      git -C "$worktree" merge --abort >/dev/null 2>&1 || true
      echo "refusing to hand ${branch} off: merging ${gh_base} into it ends in a conflict; the merge was aborted and the branch is as it was" >&2
      refusal_category="diverged"
      exit 1
    fi
    receipt_tip="$(git --git-dir="$primary_common" rev-parse --verify --quiet "refs/heads/${branch}^{commit}" 2>/dev/null || true)"
  fi
  gh_tests="$tests_command"
  if [[ -z "$gh_tests" ]]; then
    gh_handoff="$(finish_tmp)"
    if landing_python "$gate_config" handoff "${primary}/appl.toml" > "$gh_handoff" 2>/dev/null; then
      while IFS= read -r -d '' gh_name && IFS= read -r -d '' gh_value; do
        if [[ "$gh_name" == "APPL_TESTS_COMMAND" ]]; then
          gh_tests="$gh_value"
        fi
      done < "$gh_handoff"
    fi
    rm -f "$gh_handoff"
  fi
  if [[ "${ISOLATED_SESSION_LAND_TESTS:-1}" == "0" ]]; then
    echo "NOTE: ISOLATED_SESSION_LAND_TESTS=0 -- handing ${branch} off without running its tests" >&2
  elif [[ -z "$gh_tests" ]]; then
    echo "refusing to hand ${branch} off: ${primary}/appl.toml names no [tests] command to run first" >&2
    refusal_category="tests"
    exit 1
  else
    echo "running appl.toml's [tests] command for ${branch}: $(iso_safe_text "$gh_tests")" >&2
    set +e
    ( cd "$worktree" && credless bash -c "$gh_tests" ) < /dev/null >&2
    gh_rc=$?
    set -e
    if [[ "$gh_rc" != "0" ]]; then
      echo "refusing to hand ${branch} off: appl.toml's [tests] command exited ${gh_rc}" >&2
      refusal_category="tests"
      exit 1
    fi
  fi
  handed_tip="$(git --git-dir="$primary_common" rev-parse --verify --quiet "refs/heads/${branch}^{commit}" 2>/dev/null || true)"
  receipt_tip="$handed_tip"
  gh_handed() {
    echo "handing ${branch} off to github: ${gh_base}'s appl.toml says gate = \"github\"; no landing lock, nothing written to main" >&2
    echo "HANDED=github ${handed_tip}"
    # the run ledger's line for it: a landing-receipt that neither merged nor refused
    receipt_gate="handed github"
  }
  # The hand-off itself (intake 20261028T192508Z): the branch goes to the primary's
  # `handoff` remote under the same refs/heads/feat/* name, and THEN its record is written
  # beside that repository, at <dir>/<name without .git>.records/<branch, / as __>.json --
  # the path and shape trunk's publisher reads (muretai-publish.py read_record): exactly
  # the string keys intake (APPL_INTAKE, as bin/appl land hands it over), title (the
  # worktree lock's task=), tip (the pushed sha) and base (BASE's sha at hand-off). A
  # failed push leaves no record. The record is written to a fresh file beside its final
  # path and renamed over it, never through an existing file; a symlink at the path is
  # refused and left as it is. The worktree and the branch stay; no lock is taken. A
  # primary with no `handoff` remote hands off with nothing pushed, and says so.
  if ! gh_handoff_url="$(git -C "$primary" remote get-url handoff 2>/dev/null)"; then
    echo "NOTE: ${primary} has no handoff remote -- nothing pushed and no hand-off record written" >&2
    gh_handed
    exit 0
  fi
  case "$branch" in
    feat/*) ;;
    *)
      echo "refusing to hand ${branch} off: only feat/* branches go to the hand-off remote; nothing pushed, no record written" >&2
      refusal_category="other"
      exit 1
      ;;
  esac
  gh_intake="${APPL_INTAKE:-}"
  if [[ ! "$gh_intake" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
    echo "refusing to hand ${branch} off: APPL_INTAKE does not name the intake for its hand-off record; nothing pushed" >&2
    refusal_category="publish"
    exit 1
  fi
  gh_url_path="${gh_handoff_url#file://}"
  if [[ "$gh_url_path" != /* ]]; then
    echo "refusing to hand ${branch} off: the handoff remote is not a local path, so there is nowhere beside it for the hand-off record; nothing pushed" >&2
    refusal_category="publish"
    exit 1
  fi
  gh_url_path="${gh_url_path%/}"
  gh_records="$(dirname "$gh_url_path")/$(basename "$gh_url_path" .git).records"
  gh_record="${gh_records}/${branch//\//__}.json"
  gh_push_err="$(finish_tmp)"
  if ! ISOLATED_SESSION_PUSH=1 git -C "$primary" push --quiet handoff "${handed_tip}:refs/heads/${branch}" >/dev/null 2>"$gh_push_err"; then
    echo "refusing to finish the hand-off of ${branch}: the push to the hand-off remote failed: $(iso_safe_text "$(tail -1 "$gh_push_err" 2>/dev/null | tr -d '\r' | cut -c1-200)"); no record written" >&2
    rm -f "$gh_push_err"
    refusal_category="publish"
    exit 1
  fi
  rm -f "$gh_push_err"
  gh_lock="$(iso_lock_path "$worktree" 2>/dev/null || true)"
  set +e
  landing_python - "$gh_records" "$gh_record" "$gh_lock" "$gh_intake" "$handed_tip" "$gh_main" <<'PY'
import json
import os
import stat
import sys
import tempfile
records, final, lock, intake, tip, base = sys.argv[1:7]
title = ""
if lock:
    try:
        fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as fh:
            if stat.S_ISREG(os.fstat(fh.fileno()).st_mode):
                for line in fh.read(64 * 1024).decode("utf-8", "replace").splitlines():
                    if line.startswith("task="):
                        title = line[len("task="):].strip()
                        break
    except OSError:
        pass
title = title[:256]
try:
    st = os.lstat(records)
except FileNotFoundError:
    try:
        os.mkdir(records, 0o755)
    except OSError as e:
        sys.stderr.write("could not make the hand-off records directory %s: %s\n" % (records, e.strerror))
        sys.exit(1)
else:
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        sys.stderr.write("the hand-off records directory %s is a symlink or not a directory\n" % records)
        sys.exit(1)
def at_final():
    try:
        return os.lstat(final)
    except FileNotFoundError:
        return None
st = at_final()
if st is not None and stat.S_ISLNK(st.st_mode):
    sys.stderr.write("a symlink is at the hand-off record path %s; it is left as it is\n" % final)
    sys.exit(1)
if st is not None and not stat.S_ISREG(st.st_mode):
    sys.stderr.write("the hand-off record path %s is not a regular file\n" % final)
    sys.exit(1)
body = json.dumps({"intake": intake, "title": title, "tip": tip, "base": base},
                  ensure_ascii=False, indent=2) + "\n"
try:
    fd, tmp = tempfile.mkstemp(prefix=".record-", suffix=".tmp", dir=records)
except OSError as e:
    sys.stderr.write("could not write the hand-off record beside %s: %s\n" % (final, e.strerror))
    sys.exit(1)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(body)
        fh.flush()
        os.fsync(fh.fileno())
    os.chmod(tmp, 0o644)
    st = at_final()
    if st is not None and stat.S_ISLNK(st.st_mode):
        raise RuntimeError("a symlink appeared at the hand-off record path %s; it is left as it is" % final)
    os.replace(tmp, final)
except (OSError, RuntimeError) as e:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    sys.stderr.write("could not put the hand-off record in place at %s: %s\n"
                     % (final, getattr(e, "strerror", None) or e))
    sys.exit(1)
PY
  gh_rc=$?
  set -e
  if [[ "$gh_rc" != "0" ]]; then
    echo "refusing to finish the hand-off of ${branch}: its hand-off record was not written; the branch is on the hand-off remote at ${handed_tip}" >&2
    refusal_category="publish"
    exit 1
  fi
  echo "pushed ${branch} ${handed_tip} to the hand-off remote and wrote its record ${gh_record}" >&2
  gh_handed
  exit 0
fi

# Where a refusal tells the operator to find this skill's scripts: never the private
# directory this run came from, which is gone the moment it exits. The name stays spelled
# as $here's sibling so vendor.sh's closure still sees that finish needs dispatch-init.sh.
hint_init="$here/dispatch-init.sh"
if [[ -n "$gate_from_base" ]]; then
  hint_init="${primary}/${gate_scripts_rel}/${hint_init##*/}"
fi

if git --git-dir="$git_common" symbolic-ref --quiet refs/remotes/origin/HEAD >/dev/null 2>&1; then
  base="$(git --git-dir="$git_common" symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')"
else
  base="main"
fi
if ! git --git-dir="$git_common" show-ref --verify --quiet "refs/heads/${base}"; then
  if git --git-dir="$git_common" show-ref --verify --quiet "refs/heads/master"; then
    base="master"
  fi
fi

# A tip that shares no history with base, or whose parent object is missing, must
# not fast-forward base. A diverged tip that still shares history is rebased onto
# base further down; this check leaves that case alone. Both shas are named so a
# refusal says which two commits were compared. Nothing has moved yet.
desc_main="$(git --git-dir="$git_common" rev-parse --verify --quiet "refs/heads/${base}^{commit}" 2>/dev/null || true)"
desc_tip="$(git --git-dir="$git_common" rev-parse --verify --quiet "refs/heads/${branch}^{commit}" 2>/dev/null || true)"
desc_refuse_not_descendant() {
  echo "refusing to land ${branch}: ${desc_tip:-unreadable} is not a descendant of ${base} ${desc_main:-unreadable}; nothing moved." >&2
  refusal_category="diverged"
  exit 1
}
if [[ -z "$desc_main" || -z "$desc_tip" ]]; then
  desc_refuse_not_descendant
fi
if ! git --git-dir="$git_common" merge-base --is-ancestor "$desc_main" "$desc_tip" >/dev/null 2>&1; then
  desc_bad="no"
  while IFS= read -r desc_line || [[ -n "$desc_line" ]]; do
    case "$desc_line" in
      parent\ *)
        desc_p="${desc_line#parent }"
        if [[ "${#desc_p}" -ne 40 || "$desc_p" == *[!0-9a-fA-F]* ]] ||
           ! git --git-dir="$git_common" cat-file -e "${desc_p}^{commit}" >/dev/null 2>&1; then
          desc_bad="yes"
        fi
        ;;
      "")
        break
        ;;
    esac
  done < <(git --git-dir="$git_common" cat-file commit "$desc_tip" 2>/dev/null || true)
  if [[ "$desc_bad" == "no" ]] &&
     ! git --git-dir="$git_common" merge-base "$desc_main" "$desc_tip" >/dev/null 2>&1; then
    desc_bad="yes"
  fi
  if [[ "$desc_bad" == "yes" ]]; then
    desc_refuse_not_descendant
  fi
fi

# A repository with .cursor/design-paths keeps two kinds of session apart: a design
# session (design/*) lands only files design owns, a dev session (feat/*) lands none
# of them. The check is here, at landing, because that is where the split is either
# real or decorative. ISOLATED_SESSION_CROSS=1 lands a crossing change on purpose.
kind="$(iso_kind_of_branch "$branch")"
if [[ -f "$(iso_design_paths_file "$primary")" ]]; then
  merge_base="$(git -C "$worktree" merge-base "$base" "$branch")"
  crossing=""
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if iso_is_design_path "$primary" "$f"; then
      [[ "$kind" == "dev" ]] && crossing="${crossing}   ${f}"$'\n'
    else
      [[ "$kind" == "design" ]] && crossing="${crossing}   ${f}"$'\n'
    fi
  done < <(git -C "$worktree" diff --name-only "$merge_base" "$branch")
  if [[ -n "$crossing" ]]; then
    if [[ "${ISOLATED_SESSION_CROSS:-0}" == "1" ]]; then
      {
        echo "NOTE: ISOLATED_SESSION_CROSS=1 -- this ${kind} session lands files outside its paths:"
        printf '%s' "$crossing"
      } >&2
    else
      {
        if [[ "$kind" == "design" ]]; then
          echo "refusing to land ${branch}: a design session changed files design does not own:"
        else
          echo "refusing to land ${branch}: a dev session changed files that belong to design:"
        fi
        printf '%s' "$crossing"
        echo "The split is $(iso_design_paths_file "$primary"). Move those changes to a session of"
        echo "the other kind, or land with ISOLATED_SESSION_CROSS=1 when the change has to cross"
        echo "(and say why in the commit)."
      } >&2
      exit 1
    fi
  fi
fi

worktree_for_branch() {
  local want="refs/heads/$1"
  local wt=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) wt="${line#worktree }" ;;
      branch\ *)
        if [[ "${line#branch }" == "$want" ]]; then
          printf '%s\n' "$wt"
          return 0
        fi
        ;;
    esac
  done < <(git -C "$worktree" worktree list --porcelain)
  return 1
}

# Is <rel>, in checkout <root>, a tracked GITLINK sitting over LIVE STATE?
#
# A gitlink (mode 160000) with no `.gitmodules` is an UNINITIALISED submodule to git, and
# git looks inside one for nothing: whatever a real directory of that name holds,
# `git diff`, `git diff --cached` and `git status --porcelain` all say clean, and
# `git ls-files --others [--ignored]` inside it prints NOTHING -- so `is_tracked_dirty`
# reports a checkout holding a running node's keys under such a path as having nothing to
# lose, and the collision walk's untracked-file enumeration reads "every file in it is
# git's to replace". `git merge --ff-only` of a range that turns that gitlink into a
# regular blob then reports `mode change 160000 => 100644` and the files under it are gone.
# Measured end to end at both sinks
# (ISSUE(security-audit-2026-09-18-daily-2026-09-18-6)).
#
# Two shapes are deliberately NOT live state:
#   * an EMPTY directory -- there is nothing to protect, so the same flip lands;
#   * a directory that is a CHECKOUT of its own (it has a `.git`): an initialised
#     submodule, or a linked worktree that a `git add -A` in the primary staged as a
#     gitlink, which is the ordinary shape of `.worktrees/<session>` here. Its contents are
#     git's own and are reachable from its own repository; treating it as unprotected state
#     makes every later landing in that primary refuse for a path no range even touches
#     (measured against the review-checkout suite).
# The directory is read with a glob, not `ls`, for ff_dirent's reason: bash reads a
# directory entry that `ls` cannot spell.
#
# The shape is read with ff_disk_form (below), not with `-d` on the incoming spelling: on a
# folding filesystem `-d "$root/agents.d"` answers about an `Agents.d` that is there under
# another name, and the refusal then prints a path that, as printed, is not on disk. A
# CASE VARIANT is deliberately NOT this shape -- the collision walk judges it and names
# BOTH spellings, which is the sentence an operator can act on. A SYMLINK to a directory
# IS: git unlinks the link to write the incoming blob, and the state behind it is as lost
# as if the directory had stood here itself (finding 5 of the 2026-09-18 review,
# ISSUE(security-audit-2026-09-18-daily-2026-09-18-13)).
ff_gitlink_live() {  # $1 root, $2 rel
  local root="$1" rel="$2" meta="" form=""
  meta="$(git -C "$root" -c core.quotepath=false ls-files -s -- ":(literal)${rel}" 2>/dev/null || true)"
  case "$meta" in
    160000\ *) ;;
    *) return 1 ;;
  esac
  form="$(ff_disk_form "$root" "$rel")"
  [[ "$form" == "dir" || "$form" == "link" ]] || return 1
  if [[ -e "${root}/${rel}/.git" ]]; then
    return 1
  fi
  [[ -n "$(shopt -s nullglob dotglob; printf '%s' "${root}/${rel}"/*)" ]]
}

# Every such path in checkout $1, one NUL-separated record each. This is the RANGE-BLIND
# half of the guard: the walk below refuses the flip the range actually carries, and this
# one keeps a checkout holding such state from being moved under the operator at all.
gitlink_over_live_state() {  # $1 dir
  local dir="$1" meta="" path=""
  while IFS= read -r -d '' meta; do
    case "$meta" in
      160000\ *) ;;
      *) continue ;;
    esac
    # `<mode> <object> <stage>` then a TAB then the path, in the tree's own spelling
    path="${meta#*$'\t'}"
    [[ -n "$path" && "$path" != "$meta" ]] || continue
    if ( ff_gitlink_live "$dir" "$path" ); then
      printf '%s\0' "$path"
    fi
  done < <(git -C "$dir" -c core.quotepath=false ls-files -s -z 2>/dev/null || true)
}

# The sentence that follows a "cannot merge" when the reason is the one git will not
# show: `git status -sb` prints NOTHING about a gitlink over live state, so a refusal
# that stops at `status` hands the operator a checkout that looks clean. Names the paths,
# each through iso_safe_text -- and a name that cannot be escaped is said to be one
# rather than printed raw, because this refusal is read immediately before somebody
# deletes something by hand.
say_gitlink_state() {  # $1 dir
  local dir="$1" rec="" esc="" any="no"
  while IFS= read -r -d '' rec; do
    [[ -n "$rec" ]] || continue
    if [[ "$any" == "no" ]]; then
      echo "these tracked gitlink(s) hold a directory that is NOT empty on disk:" >&2
      any="yes"
    fi
    if esc="$(iso_safe_text "$rec")"; then
      echo "   ${esc}" >&2
    else
      echo "   (a gitlink path this landing could not print safely)" >&2
    fi
  done < <(gitlink_over_live_state "$dir")
  if [[ "$any" == "yes" ]]; then
    {
      echo "git looks inside none of them -- to git they are uninitialised submodules, so"
      echo "diff, diff --cached and status --porcelain are all silent about what is in there."
      echo "A range that turns one into a regular file deletes what is under it without a"
      echo "word. Move that state aside (or initialise the submodule), then run finish again."
    } >&2
  fi
}

# A checkout with uncommitted TRACKED changes cannot be moved under the operator's
# feet. Used twice: the fast-forward of BASE from origin below, and the merge of the
# branch into BASE further down -- both move refs/heads/BASE and both bring whatever
# has it checked out along with it.
#
# The third question is the one git cannot be asked: a tracked gitlink over a non-empty
# directory is state to protect, and the two `--quiet` diffs above return 0 for it.
is_tracked_dirty() {
  local dir="$1"
  if ! git -C "$dir" diff --quiet; then
    return 0
  fi
  if ! git -C "$dir" diff --cached --quiet; then
    return 0
  fi
  if [[ -n "$(gitlink_over_live_state "$dir")" ]]; then
    return 0
  fi
  return 1
}

# What is ALREADY on disk where an incoming commit would create <rel> -- the path
# itself, tracked or not, ignored or not, or the first ancestor of it that is not a
# directory (a file where a directory has to be written is as much a collision as a
# file where a file would land). Prints what is in the way -- the path, and for a
# directory a few of the paths under it that would go with it -- one per line, and
# returns 0; silent and non-zero when the path is free.
#
# Why a plain existence test and not `git status`: `is_tracked_dirty` sees only TRACKED
# changes, and `git merge --ff-only` refuses only for untracked files it can SEE -- an
# IGNORED file it treats as expendable and deletes to make room for the incoming blob.
# `keys/`, `data/`, `agents.d/` and `node.env` are ignored in this repository and are a
# running node's live private state inside the primary checkout, so a commit reachable
# from origin/BASE that tracks such a path took an Ed25519 seed with it, with no refusal
# and no receipt line. Called through $( ), so `set -f` and IFS stay in the subshell.
#
# The question asked of git is "does it track a FILE at exactly this path", never "does
# it track anything at or under this path". `git ls-files --error-unmatch -- ':(literal)p'`
# answers the second: it exits 0 for a tracked directory PREFIX, and the walk asked it
# before the final-component test, so `git rm -r keys` plus a regular file named `keys`
# was skipped outright -- `is_tracked_dirty` saw nothing, the live files under `keys/`
# being ignored, and the fast-forward deleted the directory and the Ed25519 seed in it.
# One innocuous landing that tracks `keys/README.md` is all it takes to arm that; today
# `.claude`, `.cursor` and `apps` are tracked prefixes already. So: a tracked prefix is
# not a tracked file, and the final component is judged by what is actually there.
#
# ... and "what is actually there" is asked of the DIRECTORY ENTRY, byte for byte, never
# of a stat of the incoming spelling. The dev host's filesystem folds case (APFS,
# core.ignorecase=true): `[[ -d "$root/Keys" ]]` answers about `keys/`, while
# `git ls-files --others [--ignored] --exclude-standard -- ':(literal)Keys'` is byte-exact
# and prints nothing and exits 0 -- so the walk read an empty enumeration as "every file in
# it is tracked" and returned "no collision", and `git merge --ff-only`, whose own lstat
# folds too, landed on `keys/`, unlinked the ignored entries in it and wrote the file.
# Measured end to end: `keys/agent-a.key` gone, at BOTH sinks
# (ISSUE(security-audit-2026-09-18-daily-2026-09-18)).

# The REAL directory entry for the component $2 inside the directory $1. Prints one of:
#   "=<name>"  an entry exists under EXACTLY that spelling
#   "~<name>"  an entry exists only under ANOTHER spelling -- a case variant
#   "?"        something is there and could not be enumerated: fail closed
#   ""         nothing is there under any spelling
# A glob, not `ls`: bash reads a directory entry with a newline in it and `ls` does not,
# and the whole point of this helper is that the bytes are compared and not folded.
ff_dirent() {
  local dir="$1" want="$2" e="" name="" variant=""
  [[ -d "$dir" ]] || return 0
  if [[ ! -r "$dir" || ! -x "$dir" ]]; then
    printf '?'
    return 0
  fi
  shopt -s nullglob dotglob
  for e in "$dir"/*; do
    name="${e##*/}"
    if [[ "$name" == "$want" ]]; then
      printf '=%s' "$name"
      return 0
    fi
  done
  shopt -s nocasematch
  for e in "$dir"/*; do
    name="${e##*/}"
    if [[ "$name" == "$want" ]]; then
      variant="$name"
      break
    fi
  done
  shopt -u nocasematch
  if [[ -n "$variant" ]]; then
    printf '~%s' "$variant"
    return 0
  fi
  # The listing showed nothing and the name still resolves: something is reachable that
  # the enumeration did not show. That is not "free"; it is a check that did not answer.
  if [[ -e "${dir}/${want}" || -L "${dir}/${want}" ]]; then
    printf '?'
  fi
  return 0
}

# The on-disk FORM of <rel> in <root>, every component read from the real directory entry
# (ff_dirent) rather than stat'ed under the incoming spelling -- the distinction ff_dirent
# exists for. Prints exactly one of:
#   dir      a real directory, at exactly this spelling
#   link     a symlink at exactly this spelling that resolves to a directory
#   other    something else at exactly this spelling: a file, or a link to one
#   variant  nothing at this spelling, but an entry under a CASE VARIANT of it
#   unknown  something is there and could not be enumerated: fail closed
#   none     nothing under any spelling
# Sets shell options through ff_dirent, so every caller reads it through $( ).
ff_disk_form() {  # $1 root, $2 rel
  local root="$1" rest="$2" part="" parent="$root" ent=""
  while [[ -n "$rest" ]]; do
    part="${rest%%/*}"
    if [[ "$part" == "$rest" ]]; then rest=""; else rest="${rest#*/}"; fi
    [[ -n "$part" ]] || continue
    ent="$(ff_dirent "$parent" "$part")"
    case "$ent" in
      "") printf 'none'; return 0 ;;
      "?") printf 'unknown'; return 0 ;;
      "=${part}") ;;
      *) printf 'variant'; return 0 ;;
    esac
    parent="${parent}/${part}"
  done
  if [[ -L "$parent" ]]; then
    if [[ -d "$parent" ]]; then printf 'link'; else printf 'other'; fi
    return 0
  fi
  if [[ -d "$parent" ]]; then printf 'dir'; else printf 'other'; fi
  return 0
}

# One record per thing in the way, NUL-separated, appended to $3.
ff_emit() {
  printf '%s\0' "$2" >> "$1"
}

# The DIRECTORY arm, and the one the `Keys` bug lived in. git replaces a directory only by
# deleting what is in it, and it deletes an IGNORED file without a word, so the directory
# is in the way exactly when something under it is not git's. Emits $4 (the label an
# operator reads) and up to four of the paths under it -- four, because a refusal that
# prints a whole data directory is a refusal nobody reads -- and returns 0 when it is in
# the way; returns 1, emitting nothing, when every file in it is git's to replace. $5 is
# `yes` when the caller has already decided it is a collision and only wants the label and
# the contents. $2 is the ON-DISK spelling, which is the only spelling git's byte-exact
# pathspec matching will answer about.
ff_under() {  # $1 root, $2 rel (on disk), $3 hits, $4 label, $5 force
  local root="$1" rel="$2" hits="$3" label="$4" force="$5" u="" one="" n=0 i=0
  if ! u="$(finish_tmp)"; then
    ff_emit "$hits" "${label} (the untracked-file check could not run)"
    return 0
  fi
  # `-z`, so a path with a newline in it arrives as one record; `:(literal)` so a `*` in a
  # name cannot match some other path. A non-zero exit is a check that did not run, which
  # is a refusal -- never an empty answer read as "nothing there".
  if ! git -C "$root" ls-files --others --exclude-standard -z -- ":(literal)${rel}" > "$u" 2>/dev/null; then
    ff_emit "$hits" "${label} (the untracked-file check could not run)"
    rm -f "$u"
    return 0
  fi
  if ! git -C "$root" ls-files --others --ignored --exclude-standard -z -- ":(literal)${rel}" >> "$u" 2>/dev/null; then
    ff_emit "$hits" "${label} (the ignored-file check could not run)"
    rm -f "$u"
    return 0
  fi
  while IFS= read -r -d '' one; do
    if [[ -n "$one" ]]; then n=$(( n + 1 )); fi
  done < "$u"
  if [[ "$n" == "0" ]]; then
    rm -f "$u"
    if [[ "$force" == "yes" ]]; then
      ff_emit "$hits" "$label"
      return 0
    fi
    return 1
  fi
  ff_emit "$hits" "$label"
  while IFS= read -r -d '' one; do
    if [[ -z "$one" ]]; then continue; fi
    i=$(( i + 1 ))
    if [[ "$i" -gt 4 ]]; then break; fi
    ff_emit "$hits" "$one"
  done < "$u"
  rm -f "$u"
  return 0
}

# Is <rel> in <root> worth walking when the range does something to it OTHER than create
# it? Only a path that can be holding a running node's live state is, and there are three
# such shapes, not one:
#   * a real DIRECTORY at exactly this spelling -- the shape this test started as;
#   * a SYMLINK to a directory, which is the ordinary arrangement when the state lives on
#     another volume. `-d && ! -L` refused it on BOTH guards, so the walk was never called,
#     `git status --porcelain` said nothing, and `git merge --ff-only` unlinked the live
#     link to write the incoming blob;
#   * a CASE VARIANT of this spelling. `-d` folds on this filesystem, so `agents.d` was
#     refused only by accident, through a check that had answered about `Agents.d` and then
#     printed a path that, as printed, is not there.
# Plus `unknown` -- an entry that is there and could not be enumerated -- which is walked
# so that ff_collision says so, rather than skipped as if the path were free
# (ISSUE(security-audit-2026-09-18-daily-2026-09-18-13)).
# ff_collision then decides; this only says "look". Sets shell options through ff_dirent,
# so callers run it in a subshell.
ff_walk_worthy() {  # $1 root, $2 rel
  case "$(ff_disk_form "$1" "$2")" in
    dir|link|variant|unknown) return 0 ;;
    *) return 1 ;;
  esac
}

# Walks <rel> component by component against what is on disk in <root>, appending one
# NUL-separated record per thing in the way to <hits>. Returns 0 when it appended
# something, 1 when the path is free. Run in a subshell by its one caller, so the shell
# options it sets stay there.
ff_collision() {  # $1 root, $2 rel, $3 hits
  local root="$1" rel="$2" hits="$3"
  local rest="$rel" part="" acc="" disk_acc="" parent="$root"
  local ent="" kind="" real="" tracked="" parts=()
  while [[ -n "$rest" ]]; do
    part="${rest%%/*}"
    if [[ "$part" == "$rest" ]]; then rest=""; else rest="${rest#*/}"; fi
    if [[ -n "$part" ]]; then parts+=("$part"); fi
  done
  if [[ "${#parts[@]}" -eq 0 ]]; then
    return 1
  fi
  for part in "${parts[@]}"; do
    acc="${acc:+${acc}/}${part}"
    ent="$(ff_dirent "$parent" "$part")"
    if [[ -z "$ent" ]]; then
      # nothing on disk under this name in any spelling, so nothing below it either
      return 1
    fi
    if [[ "$ent" == "?" ]]; then
      ff_emit "$hits" "${acc} (what is on disk under this name could not be listed)"
      return 0
    fi
    kind="${ent:0:1}"
    if [[ "$kind" == "=" ]]; then
      # the entry is spelled exactly as the incoming path spells it; command substitution
      # eats a trailing newline, so take the spelling we already have
      real="$part"
    else
      real="${ent:1}"
    fi
    disk_acc="${disk_acc:+${disk_acc}/}${real}"

    if [[ "$kind" == "~" ]]; then
      # A CASE VARIANT. git's only in ONE shape: a tracked FILE, at the final component,
      # which is a case-only rename and is exactly what git fast-forwards correctly. The
      # walk used to refuse that -- and its refusal told the operator to move a TRACKED
      # file aside, which trips is_tracked_dirty and wedges every later landing, the same
      # wedge the `notes` -> `notes/` arm above exists to undo. Everything else is a
      # collision, named with BOTH spellings: the incoming one, and the one the filesystem
      # actually holds, because a refusal that prints only the spelling that is NOT there
      # sends the operator hunting.
      tracked="$(git -C "$root" -c core.quotepath=false ls-files -- ":(literal)${disk_acc}" 2>/dev/null || true)"
      if [[ "$acc" == "$rel" && "$tracked" == "$disk_acc" &&
            -f "${root}/${disk_acc}" && ! -L "${root}/${disk_acc}" ]]; then
        return 1
      fi
      ff_under "$root" "$disk_acc" "$hits" \
        "${acc} (this filesystem folds case: what is on disk is spelled ${disk_acc})" "yes" || true
      return 0
    fi

    if [[ "$acc" != "$rel" ]]; then
      # An INTERMEDIATE component. git tracking exactly this path as a FILE means the
      # incoming range turns that file into a directory -- git's to replace, not ours to
      # refuse: a commit that turns the tracked file `notes` into the directory `notes/`
      # arrives as D `notes` + A `notes/one.md` and fast-forwards correctly. The walk
      # used to flag `notes` anyway, under a sentence ("none of which is tracked there")
      # that was false of the very path it printed, and whose own instruction (move it
      # aside) then tripped is_tracked_dirty, so nothing landed until somebody
      # fast-forwarded BASE by hand.
      # `:(literal)` so a `*` in a name cannot match some other tracked file; quotepath off
      # so a non-ASCII name comes back as itself and can be compared to the path we asked
      # about. A failure to ask is an empty answer, which is the fail-closed direction.
      tracked="$(git -C "$root" -c core.quotepath=false ls-files -- ":(literal)${acc}" 2>/dev/null || true)"
      if [[ "$tracked" == "$acc" ]]; then
        parent="${parent}/${real}"
        continue
      fi
      # A real DIRECTORY is never in the way of a file INSIDE it; anything else here is,
      # a SYMLINK to a directory included -- `-d` follows links, so a `keys` symlink into
      # the node's key store used to satisfy "is a directory" and be waved through, and
      # git then replaced the link with a real directory wherever the ignore pattern let
      # it (measured in the daily-2026-09-17 review: one character in .gitignore apart).
      if [[ -d "${root}/${acc}" && ! -L "${root}/${acc}" ]]; then
        parent="${parent}/${real}"
        continue
      fi
      ff_emit "$hits" "$acc"
      return 0
    fi

    # The FINAL component, at the spelling the filesystem really holds.
    if [[ -d "${root}/${acc}" && ! -L "${root}/${acc}" ]]; then
      if ff_under "$root" "$acc" "$hits" "$acc" "no"; then
        return 0
      fi
      # ... and "every file in it is tracked" is what an EMPTY enumeration says, which is
      # also what git says about a tracked GITLINK: it will not list inside one. Asked
      # directly, before that silence is read as consent.
      if ff_gitlink_live "$root" "$acc"; then
        ff_emit "$hits" "${acc} (a tracked gitlink: git lists nothing inside it, and the files under it are not git's)"
        return 0
      fi
      # every file in it is tracked: git's to replace
      return 1
    fi
    # a tracked FILE at exactly this path is git's to replace; an untracked or ignored
    # file, or a symlink, is not
    tracked="$(git -C "$root" -c core.quotepath=false ls-files -- ":(literal)${acc}" 2>/dev/null || true)"
    if [[ "$tracked" == "$acc" ]]; then
      return 1
    fi
    ff_emit "$hits" "$acc"
    return 0
  done
  return 1
}

# The whole check, as ONE function used at BOTH sinks -- the origin->BASE fast-forward
# and the branch->BASE merge. Two copies were how the first version of this guard came
# to cover one sink and not the other: `git merge` deletes an ignored file to make room
# for an incoming tracked blob wherever it runs, and a session branch that `git add -f`s
# `keys/agent-a.key` or `node.env` passes the generated-file check, the tests and the
# lint (whose secret-file rule matches `keys/*.key`, not `node.env` or `data/`).
#
# Prints the indented list of what is in the way in $1 (empty when nothing is), every
# name run through iso_safe_text. Returns 2, printing nothing, when the ENUMERATION
# itself could not run: the range goes to a temporary file so `git diff`'s exit status
# is observed, because a guard that cannot run its check must refuse the landing, never
# conclude from a failed check that there is nothing in the way. Read from a process
# substitution, a failing `git diff` left this list empty and the landing fell straight
# through to the merge -- the exact pre-guard behaviour, silently.
# Renames arrive as D + A, so --no-renames keeps the added half.
#
# The enumeration is NOT "what the range adds". It used to be (`--diff-filter=A` alone),
# and a TYPECHANGE -- git's `T`, the letter for "the same path, a different kind" -- is
# neither `A` nor `D`, so a range that turns a tracked gitlink into a regular blob printed
# nothing here and the walk below was never called at all
# (ISSUE(security-audit-2026-09-18-daily-2026-09-18-6)). So the range is read TWICE, and
# every path either read judges goes through the same walk and the same rules:
#   * `--diff-filter=A`  -- what the range CREATES, walked whatever is on disk, as before;
#   * `--diff-filter=CMRDT` -- the rest of `ACMRDT`, walked when its current on-disk form
#     can be holding a running node's live state (`ff_walk_worthy`, by the real directory
#     entry as the fold code does): a directory, a SYMLINK to one, a CASE VARIANT of the
#     spelling, or an entry that could not be listed.
# Two reads rather than one `--name-status`: the first read keeps the exact spelling a
# landing has always used, so the arm that proves this guard FAILS CLOSED when git cannot
# answer is exercised by the same command it was written against. An ordinary modification
# of a tracked file is a file on disk, so it costs one dirent read and is free, as it was.
# Returns 3 when a name could not be ESCAPED, which the caller refuses on for the same
# reason: a landing that cannot print a name safely does not print it at all.
#
# The names are escaped BEFORE they are split into lines, and the two never meet: a hit
# is one NUL-separated RECORD per thing in the way, read with `read -r -d ''`. Splitting a
# multi-line hit on newlines first let the one Cc byte that structures the output past the
# escaper -- a crafted name bought a fabricated, correctly indented entry in a list whose
# next sentence is "move those paths aside yourself"
# (ISSUE(security-audit-2026-09-18-daily-2026-09-18-5)).
ff_collisions() {  # $1 the checkout the range would be written into, $2 the range
  local root="$1" range="$2" list="" wide="" hits="" add="" rec="" esc="" acc="" rc=0
  list="$(finish_tmp)" || return 2
  if ! wide="$(finish_tmp)"; then
    rm -f "$list"
    return 2
  fi
  if ! hits="$(finish_tmp)"; then
    rm -f "$list" "$wide"
    return 2
  fi
  if ! git -C "$worktree" -c core.quotepath=false diff --name-only -z \
         --no-renames --diff-filter=A "$range" > "$list"; then
    rm -f "$list" "$wide" "$hits"
    return 2
  fi
  # the other letters of ACMRDT. A failure to ask is a check that did not run, exactly as
  # above: never an empty answer read as "nothing in the way".
  if ! git -C "$worktree" -c core.quotepath=false diff --name-only -z \
         --no-renames --diff-filter=CMRDT "$range" > "$wide"; then
    rm -f "$list" "$wide" "$hits"
    return 2
  fi
  while IFS= read -r -d '' add; do
    [[ -n "$add" ]] || continue
    # a subshell, so the shell options ff_dirent sets never leave the walk; anything other
    # than "in the way" (0) or "free" (1) is a check that did not run
    rc=0
    ( ff_collision "$root" "$add" "$hits" ) || rc=$?
    if [[ "$rc" != "0" && "$rc" != "1" ]]; then
      rm -f "$list" "$wide" "$hits"
      return 2
    fi
  done < "$list"
  while IFS= read -r -d '' add; do
    [[ -n "$add" ]] || continue
    # not an addition: only a path whose on-disk form can be sitting over live state is
    # walked -- a directory, a symlink to one, a case variant of the spelling, or an entry
    # that could not be listed -- and it is then judged by exactly the rules an addition
    # gets (ff_walk_worthy)
    ( ff_walk_worthy "$root" "$add" ) || continue
    rc=0
    ( ff_collision "$root" "$add" "$hits" ) || rc=$?
    if [[ "$rc" != "0" && "$rc" != "1" ]]; then
      rm -f "$list" "$wide" "$hits"
      return 2
    fi
  done < "$wide"
  while IFS= read -r -d '' rec; do
    [[ -n "$rec" ]] || continue
    if ! esc="$(iso_safe_text "$rec")"; then
      rm -f "$list" "$wide" "$hits"
      return 3
    fi
    acc="${acc}   ${esc}"$'\n'
  done < "$hits"
  rm -f "$list" "$wide" "$hits"
  printf '%s' "$acc"
  return 0
}

# --- the self-rebase of an UNPUBLISHED BASE --------------------------------------
# The S7 shape: this Mac landed, handed BASE off, and the publisher could not push it
# because the other Mac moved origin first ("not a fast-forward"). Nobody but this Mac
# has those commits, so rebasing them onto origin rewrites nothing anyone else holds --
# and it is exactly what the owner otherwise does by hand before anything lands again.
# Everything else that diverges stays a refusal: a person reconciles it.
#
# Prints, as one clause, why BASE may NOT be rebased here; prints nothing when it may.
# All of these must hold (ISOLATED_SESSION_FORCE is checked by the caller):
#   * origin/BASE was read by THIS landing (fetched, or from a current bundle) -- a
#     rebase onto an origin view nobody refreshed buys nothing and rewrites anyway;
#   * the `handoff` remote's BASE is exactly local BASE -- ahead of it, or elsewhere,
#     means what the hand-off holds may already be on its way to origin;
#   * the publisher's status (LANDING_PUBLISHER_STATUS, else <state>/status/<name>.txt)
#     says result=held, not a fast-forward -- it saw that tip and could not publish it.
# Commits origin already contains are never rewritten by construction: the rebase
# replays only ${remote_base}..${base}.
self_rebase_blocker() {
  local sb_base sb_handoff sb_status sb_name
  if [[ "$origin_read" != "yes" ]]; then
    echo "origin was not read by this landing (no fetch, no current bundle), so ${remote_base} is not known to be origin"
    return 0
  fi
  if ! git -C "$primary" remote get-url handoff >/dev/null 2>&1; then
    echo "there is no handoff remote, so nothing shows that the local commits are unpublished"
    return 0
  fi
  sb_base="$(git -C "$worktree" rev-parse "$base")"
  sb_handoff="$(credless git -C "$primary" ls-remote handoff "refs/heads/${base}" 2>/dev/null |
                awk -v want="refs/heads/${base}" '$2 == want { print $1; exit }')" || sb_handoff=""
  if [[ "$sb_handoff" != "$sb_base" ]]; then
    echo "the hand-off's ${base} (${sb_handoff:0:7}) is not local ${base} (${sb_base:0:7}), so what it holds may already be on its way to origin"
    return 0
  fi
  if [[ -n "${LANDING_PUBLISHER_STATUS:-}" ]]; then
    sb_status="$LANDING_PUBLISHER_STATUS"
  elif sb_name="$(iso_publisher_name "$primary")"; then
    sb_status="${ISO_PUBLISHER_STATE}/status/${sb_name}.txt"
  else
    echo "the hand-off remote names no publisher repository, so there is no publisher status to read"
    return 0
  fi
  if ! iso_publisher_held_not_ff "$sb_status"; then
    echo "the publisher status $(iso_safe_text "$sb_status") does not say it held ${base} as not a fast-forward of origin"
    return 0
  fi
  return 0
}

# A conflict the ledger cannot answer: abort, put BASE back at exactly $2, name the
# paths on the receipt line, refuse. $3 is the conflicted paths, one per line.
self_rebase_refuse() {  # $1 checkout, $2 BASE's sha before, $3 paths
  local rr_wt="$1" rr_sha="$2" rr_paths="$3" rr_one="" rr_esc="" rr_names=""
  git -C "$rr_wt" rebase --abort >/dev/null 2>&1 || true
  if [[ "$(git -C "$worktree" rev-parse "$base")" != "$rr_sha" ]]; then
    git -C "$rr_wt" reset --quiet --keep "$rr_sha" >/dev/null 2>&1 || true
  fi
  while IFS= read -r rr_one; do
    [[ -n "$rr_one" ]] || continue
    if rr_esc="$(iso_safe_text "$rr_one")"; then
      rr_names="${rr_names}${rr_names:+ }${rr_esc}"
    else
      rr_names="${rr_names}${rr_names:+ }(a path this landing could not print safely)"
    fi
  done <<< "$rr_paths"
  echo "BASE_REBASE=conflict ${rr_names:-(the rebase stopped without naming a path)}"
  {
    echo "refusing to land ${branch}: ${base} holds this Mac's unpublished landings and ${remote_base}"
    echo "moved under them; rebasing them onto ${remote_base} conflicts in: ${rr_names:-(no path named)}"
    if [[ "$(git -C "$worktree" rev-parse "$base")" == "$rr_sha" ]]; then
      echo "The rebase was aborted and ${base} is exactly where it was (${rr_sha:0:7}); the hand-off,"
      echo "${branch} and ${worktree} did not move. That conflict is a person's to resolve:"
    else
      echo "WARNING: the rebase was aborted but ${base} is NOT back at ${rr_sha:0:7}; check it by hand"
      echo "(git -C '${rr_wt}' reset --keep ${rr_sha}) before anything else lands. Then:"
    fi
    echo "  in ${rr_wt}: git rebase ${remote_base}, resolve, git rebase --continue, then run finish again."
  } >&2
  exit 1
}

# Rebases local BASE onto ${remote_base} in the checkout that has BASE (a temporary one
# when none does), under the same guards as the fast-forward: a clean checkout, and
# nothing the range brings may land on an untracked or ignored path. A conflict confined
# to the generated files is answered by rebuilding the ledger there; any other is
# self_rebase_refuse. Then the hand-off is given the rebased BASE -- the one force push a
# landing ever makes, leased on the old tip so it overwrites only what this check read --
# and a hand-off that will not take it puts BASE back and refuses.
self_rebase_base() {
  local sr_wt sr_from sr_onto sr_rc=0 sr_hits="" sr_conf="" sr_one="" sr_only="" sr_gd="" sr_err="" sr_n=""
  sr_from="$(git -C "$worktree" rev-parse "$base")"
  sr_onto="$(git -C "$worktree" rev-parse "$remote_base")"
  sr_wt="$(worktree_for_branch "$base" || true)"
  if [[ -n "$sr_wt" ]]; then
    if is_tracked_dirty "$sr_wt"; then
      echo "base ${base} is checked out at ${sr_wt} and has uncommitted changes; cannot rebase" >&2
      echo "  ${base} holds unpublished landings that have to be rebased onto ${remote_base} first." >&2
      git -C "$sr_wt" status -sb >&2
      say_gitlink_state "$sr_wt"
      exit 1
    fi
  else
    mkdir -p "${primary}/.worktrees"
    if [[ -e "${primary}/.worktrees/.rebase-${base}" ]]; then
      echo "refusing to land ${branch}: temp rebase worktree already exists: ${primary}/.worktrees/.rebase-${base}" >&2
      exit 1
    fi
    tmp_rebase="${primary}/.worktrees/.rebase-${base}"
    if ! git -C "$primary" worktree add --quiet "$tmp_rebase" "$base" >/dev/null; then
      echo "refusing to land ${branch}: could not open ${base} in a temporary worktree to rebase it" >&2
      exit 1
    fi
    sr_wt="$tmp_rebase"
  fi
  sr_hits="$(ff_collisions "$sr_wt" "${sr_from}..${sr_onto}")" || sr_rc=$?
  if [[ "$sr_rc" != "0" ]]; then
    echo "refusing to land ${branch}: could not list (or could not safely print) the paths rebasing ${base} onto ${remote_base} would create in ${sr_wt}, so the on-disk check never ran; nothing moved." >&2
    exit 1
  fi
  if [[ -n "$sr_hits" ]]; then
    {
      echo "refusing to land ${branch}: rebasing ${base} onto ${remote_base} would have overwritten"
      echo "path(s) already on disk in ${sr_wt} that git does not track there:"
      printf '%s\n' "$sr_hits"
      echo "Move those paths aside yourself, then run finish again; nothing moved."
    } >&2
    exit 1
  fi
  # updateRefs off: a rebase of BASE moves BASE and nothing else, never the session branch
  if ! GIT_EDITOR=true git -C "$sr_wt" -c rebase.updateRefs=false -c rebase.autoStash=false \
         -c rebase.autoSquash=false rebase --quiet "$sr_onto" >/dev/null 2>&1; then
    while :; do
      sr_conf="$(git -C "$sr_wt" -c core.quotepath=false diff --name-only --diff-filter=U)"
      [[ -n "$sr_conf" ]] || break
      sr_only="yes"
      while IFS= read -r sr_one; do
        [[ -n "$sr_one" ]] || continue
        case " $generated " in
          *" $sr_one "*) ;;
          *) sr_only="no" ;;
        esac
      done <<< "$sr_conf"
      if [[ "$sr_only" != "yes" || ! -f "$gate_ledger" ]]; then
        self_rebase_refuse "$sr_wt" "$sr_from" "$sr_conf"
      fi
      # the generated files have one right answer: the ledger (BASE's), rebuilt on this tree
      if ! landing_python "$gate_ledger" --into "$sr_wt" build >/dev/null 2>&1; then
        self_rebase_refuse "$sr_wt" "$sr_from" "$sr_conf"
      fi
      for sr_one in $generated; do
        if [[ -e "$sr_wt/$sr_one" ]] ||
           git -C "$sr_wt" ls-files --error-unmatch -- "$sr_one" >/dev/null 2>&1; then
          git -C "$sr_wt" add -A -- "$sr_one"
        fi
      done
      if [[ -n "$(git -C "$sr_wt" diff --name-only --diff-filter=U)" ]]; then
        self_rebase_refuse "$sr_wt" "$sr_from" "$sr_conf"
      fi
      if ! GIT_EDITOR=true git -C "$sr_wt" -c rebase.updateRefs=false rebase --continue >/dev/null 2>&1; then
        if [[ -z "$(git -C "$sr_wt" diff --name-only --diff-filter=U)" ]]; then
          # the rebuild made that commit empty: nothing of it is left to carry
          GIT_EDITOR=true git -C "$sr_wt" rebase --skip >/dev/null 2>&1 || true
        fi
      fi
      sr_gd="$(git -C "$sr_wt" rev-parse --git-dir)"
      [[ -d "$sr_gd/rebase-merge" || -d "$sr_gd/rebase-apply" ]] || break
    done
    sr_gd="$(git -C "$sr_wt" rev-parse --git-dir)"
    if [[ -n "$(git -C "$sr_wt" diff --name-only --diff-filter=U)" ||
          -d "$sr_gd/rebase-merge" || -d "$sr_gd/rebase-apply" ]]; then
      self_rebase_refuse "$sr_wt" "$sr_from" "$(git -C "$sr_wt" -c core.quotepath=false diff --name-only --diff-filter=U)"
    fi
  fi
  if ! git -C "$worktree" merge-base --is-ancestor "$sr_onto" "$base"; then
    self_rebase_refuse "$sr_wt" "$sr_from" ""
  fi
  sr_err="$(finish_tmp)"
  if ! ISOLATED_SESSION_PUSH=1 git -C "$primary" push --quiet \
         --force-with-lease="refs/heads/${base}:${sr_from}" handoff "${base}:refs/heads/${base}" \
         >/dev/null 2>"$sr_err"; then
    git -C "$sr_wt" reset --quiet --keep "$sr_from" >/dev/null 2>&1 || true
    {
      echo "refusing to land ${branch}: ${base} was rebased onto ${remote_base}, but the hand-off would"
      echo "not take the rebased ${base}: $(iso_safe_text "$(tail -1 "$sr_err" 2>/dev/null || true)")"
      if [[ "$(git -C "$worktree" rev-parse "$base")" == "$sr_from" ]]; then
        echo "${base} was put back where it was (${sr_from:0:7}); nothing else moved."
      else
        echo "WARNING: ${base} could NOT be put back at ${sr_from:0:7}; check it by hand before anything lands."
      fi
    } >&2
    rm -f "$sr_err"
    exit 1
  fi
  rm -f "$sr_err"
  sr_n="$(git -C "$worktree" rev-list --count "${sr_onto}..${base}")"
  base_rebased="yes"
  base_rebase_from="$sr_from"
  base_rebase_line="${sr_n} commit(s) onto $(git -C "$worktree" rev-parse --short=7 "$sr_onto")"
  if [[ -n "$tmp_rebase" ]]; then
    git -C "$primary" worktree remove --force "$tmp_rebase" >/dev/null 2>&1 || true
    tmp_rebase=""
  fi
}

# --- what origin holds: lib.sh:iso_origin_view, and nothing else --------------------
# The owner's uid holds no GitHub credential (company/ops/publisher/README.md), so on this
# machine the fetch always fails, and for as long as it failed silently the landing judged
# BASE against whatever origin/BASE a person last brought down by hand -- hours old while
# the other Mac moved origin, which is how seven landings came to sit on a BASE origin had
# never seen (plan 2026-09-18-no-stops, S7). Then it read the publisher's bundle -- but
# with no bundle, or a stale one, it still went on "against the origin/BASE this
# repository already has", and the owner's rebase script kept a rule of its own that fell
# back to a five-day-old bundle
# (ISSUE(origin-view-has-two-rules-and-one-of-them-serves-a-stale-bundle)).
# Now there is ONE rule, iso_origin_view (lib.sh): the fetch, else the publisher's bundle
# cross-checked against its status, else -- only when no handoff remote names a publisher --
# the operator's non-blank ORIGIN break-glass, else a REFUSAL with nothing moved. It runs
# before the landing lock is taken, so a refusal leaves no lock behind.
# A repository with NO origin remote has no origin to be stale about and lands as it
# always did ("BASE_FF=none (no origin/BASE)"); that boundary is drawn HERE, by not
# calling the helper, so the refusal cannot creep into repositories that never had one.
origin_read="no"         # origin/BASE was read THIS landing (fetched, or from the bundle)
origin_source=""         # " from bundle" when it came from the bundle, for BASE_FF=
if git -C "$worktree" remote get-url origin >/dev/null 2>&1; then
  if ! iso_origin_view "$worktree" "$base"; then
    {
      echo "refusing to land ${branch}: origin/${base} has no current view (the reason is above), and a"
      echo "landing is never judged against an old one. Nothing moved (${base}, ${branch} and"
      echo "${worktree} are as they were); run finish again once the publisher has written a current bundle."
    } >&2
    exit 1
  fi
  origin_read="yes"
  if [[ "$ISO_ORIGIN_VIEW_SOURCE" == "bundle" ]]; then
    origin_source=" from bundle"
  fi
fi

# --- the pre-run: the tests the diff owes, once, OUTSIDE the landing lock -------
# The lock makes the fast-forward and the receipt exclusive; the test run does not need
# it, and holding it through the slowest landing's test phase queued every other landing
# behind that phase (IB:12734). So the affected tests run here, before the lock, into a
# BOUND receipt (tools/run_tests.py: head, BASE, selection, worktree), and the test step
# under the lock takes it only while it is still current (see there); after a rebase or a
# moved BASE the files run again. A red pre-run
# hands nothing on -- the lock holder judges it afresh. The launcher's receipt (land.sh ran
# the same pre-run before starting this) is used in place of our own, and only one that
# lives in the spawn's walls directory with a green `tests.json` beside it: any other path,
# including one a worker set, is ignored. The variables are cleared before anything this
# landing starts, so a test cannot hand them on.
tests_from_wall=no
prerun_receipt=""        # the receipt the test step may --reuse
prerun_tmp=""            # ... when it is our own file, removed after that step
prerun_head=""           # HEAD and BASE our own pre-run saw ("" for the launcher's)
prerun_base=""
rec_path="${ISO_FINISH_TESTS_RECEIPT:-}"
walls_path="${ISO_FINISH_WALLS_DIR:-}"
unset ISO_FINISH_TESTS_RECEIPT ISO_FINISH_WALLS_DIR
# appl.toml's [tests] command has no bound receipt: it runs once, under the lock, below
if [[ -z "$tests_command" && -f "$gate_runner" && "${ISOLATED_SESSION_LAND_TESTS:-1}" != "0" ]]; then
  # --- the children's wall, and the one thing it costs -------------------------------
  # Where the CHILDREN would look for the operator's own packages. Asked ONCE, of an
  # isolated python, so nothing this process reads comes from a PYTHON* variable -- and
  # `-I` does not stop `site.getusersitepackages()` from honouring PYTHONUSERBASE, which
  # it reads from os.environ at call time, so the answer is the directory the children
  # would really have used. A python that cannot answer leaves the path empty, and the
  # children then run walled and without it: closed, and slow, never open.
  tests_usersite="$(credless python3 -I -c 'import site; print(site.getusersitepackages() or "")' 2>/dev/null || true)"
  branch_tests_backend_path=""
  if [[ -n "$tests_usersite" && -d "$tests_usersite" ]]; then
    branch_tests_backend_path="${tests_usersite}"
  fi
  if [[ -n "$rec_path" && -n "$walls_path" ]]; then
    rec_rc="$(landing_python - "$rec_path" "$walls_path" <<'PY'
import json, os, sys
rec, walls = sys.argv[1], sys.argv[2]

def real(p):
    return os.path.realpath(p)

try:
    if os.path.islink(rec) or os.path.islink(walls):
        raise OSError("link")
    rec_r, walls_r = real(rec), real(walls)
    if not os.path.isdir(walls_r) or not os.path.isfile(rec_r) or os.path.dirname(rec_r) != walls_r:
        raise OSError("place")
    rc_path = os.path.join(walls, "tests.json")
    if os.path.islink(rc_path):
        raise OSError("link")
    rc_r = real(rc_path)
    if os.path.dirname(rc_r) != walls_r or not os.path.isfile(rc_r):
        raise OSError("rc")
    rc = json.load(open(rc_r)).get("rc")
    if type(rc) is not int or rc != 0:
        raise OSError("rc")
    sys.stdout.write(rec_r + "\n")
except (OSError, ValueError, AttributeError):
    sys.stdout.write("no\n")
PY
)" || rec_rc="no"
    if [[ -n "$rec_rc" && "$rec_rc" != "no" ]]; then
      prerun_receipt="$rec_rc"
      tests_from_wall=yes
    fi
  fi
  if [[ -z "$prerun_receipt" ]]; then
    # a pre-run to the gate pool: served after any in-lock gate, which every landing waits
    # on (tools/gate_slots.py, THE ORDER); a BASE runner that predates --gate-phase (a
    # consumer's older vendored copy) is called as before
    gate_phase_ok=""
    if grep -q -- '--gate-phase' "$gate_runner" 2>/dev/null; then
      gate_phase_ok=yes
    fi
    # the pre-run never queues behind the order: with --gate-nowait a runner that cannot take
    # a slot at once -- an in-lock gate or another waiter ahead, or the free slot reserved
    # for an in-lock gate -- exits 3 and runs nothing, and the in-lock run below tests the
    # branch, its verdict alone counting (intake 20261006T033737Z); an older BASE runner
    # waits as before
    gate_nowait_ok=""
    if [[ -n "$gate_phase_ok" ]] && grep -q -- '--gate-nowait' "$gate_runner" 2>/dev/null; then
      gate_nowait_ok=yes
    fi
    # ... but with every slot held it waits for one, bounded by the stuck threshold
    # (intake 20261026T223744Z, plan item 14): --gate-wait-s, ISOLATED_SESSION_LAND_STUCK
    # whole seconds, default 2700, the landing lock's own default wait (land_wait below).
    # Past the bound the runner exits 4 and the landing is refused by name, before the
    # landing lock. A BASE runner without --gate-wait-s skips at once as before.
    gate_wait_s=""
    if [[ -n "$gate_nowait_ok" ]] && grep -q -- '--gate-wait-s' "$gate_runner" 2>/dev/null; then
      gate_wait_s="${ISOLATED_SESSION_LAND_STUCK:-2700}"
      [[ "$gate_wait_s" =~ ^(0|[1-9][0-9]{0,8})$ ]] || gate_wait_s=2700
    fi
    prerun_tmp="$(finish_tmp)"
    prerun_err="$(finish_tmp)"
    prerun_head="$(git -C "$worktree" rev-parse HEAD 2>/dev/null || true)"
    prerun_base="$(git -C "$worktree" rev-parse "${base}^{commit}" 2>/dev/null || true)"
    echo "running the affected tests of ${branch} before taking the landing lock" >&2
    set +e
    (
      sandbox_begin "$worktree" || exit 1
      trap 'sandbox_end' EXIT
      sandbox_child_env
      cd "$sandbox_clone" && branch_tests_python "$gate_runner" --root "$sandbox_clone" --affected "${base}..HEAD" --gate --json ${ISOLATED_SESSION_LAND_JOBS:+-j "$ISOLATED_SESSION_LAND_JOBS"} ${gate_phase_ok:+--gate-phase pre-run --gate-holder "$branch"} ${gate_nowait_ok:+--gate-nowait} ${gate_wait_s:+--gate-wait-s "$gate_wait_s"}
    ) > "$prerun_tmp" 2>"$prerun_err"
    prerun_rc=$?
    set -e
    gate_dir_hold "after the tests ran before the landing lock" "$prerun_tmp" "$prerun_err"
    if [[ "$prerun_rc" != "0" ]] && grep -q "disposable clone could not be created" "$prerun_err"; then
      cat "$prerun_err" >&2
      echo "refusing to land ${branch}: the disposable clone could not be created; nothing moved." >&2
      rm -f "$prerun_err" "$prerun_tmp"
      exit 1
    fi
    rm -f "$prerun_err"
    if [[ -n "$gate_wait_s" && "$prerun_rc" == "4" ]]; then
      echo "refusing to land ${branch}: no gate slot came free for the pre-run in ${gate_wait_s}s (ISOLATED_SESSION_LAND_STUCK); nothing moved, and no landing lock was taken." >&2
      rm -f "$prerun_tmp"
      exit 1
    fi
    if [[ -n "$gate_nowait_ok" && "$prerun_rc" == "3" ]]; then
      echo "skipped the pre-lock test run of ${branch}: no gate slot was free at once; the run under the landing lock tests the branch" >&2
    fi
    if [[ "$prerun_rc" == "0" && -n "$prerun_head" && -n "$prerun_base" ]]; then
      prerun_receipt="$prerun_tmp"
    else
      # red, or not bound to a HEAD and BASE this shell saw: the lock holder runs them
      rm -f "$prerun_tmp"
      prerun_tmp=""
    fi
  fi
fi

# --- is the branch shared? asked before the lock, answered by every holder --------------
# A branch another checkout holds is MERGED onto BASE below, never rebased: a rebase
# rewrites commits somebody else already has. The question used to be one live
# `git ls-remote origin`, and on this machine origin cannot be reached at all, so the
# answer was always "no" and a branch shared by bundle or by a second clone was rewritten
# (IB:12735). Now every holder is asked:
#   origin     origin carries refs/heads/<branch> (origin fetched this landing), or
#   bundle     the publisher bundle carries refs/remotes/origin/<branch> (origin was read
#              from it: an unreachable origin whose bundle was read is an answer, not a doubt);
#   <remote>   any other configured remote carries refs/heads/<branch>;
#   worktree   another worktree of this repository has <branch> checked out.
# A holder that cannot be read, or two copies that have diverged, is a refusal by name:
# neither a rebase nor a merge is chosen on a guess. It runs before the landing lock, the
# lease and the fast-forward of BASE, so a refusal leaves everything where it was. Only
# asked when the branch will have to be brought onto BASE at all; SHARED= on the receipt
# says what it found.

# Every OTHER worktree (not the session's) that has <branch> checked out, one per line.
# Run from $1, any checkout of the repository that still exists.
branch_checked_out_elsewhere() {  # $1 a checkout to ask from
  local want="refs/heads/${branch}" wt="" line="" self_p=""
  self_p="$(cd "$worktree" 2>/dev/null && pwd -P || true)"
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) wt="${line#worktree }" ;;
      branch\ *)
        if [[ "${line#branch }" == "$want" && "$wt" != "$worktree" &&
              ( -z "$self_p" || "$(cd "$wt" 2>/dev/null && pwd -P || true)" != "$self_p" ) ]]; then
          printf '%s\n' "$wt"
        fi
        ;;
    esac
  done < <(git -C "$1" worktree list --porcelain 2>/dev/null || true)
}

shared_refuse() {  # $1 why (names the source)
  {
    echo "refusing to land ${branch}: $1"
    echo "A branch that may be shared is neither rebased (that rewrites commits another"
    echo "checkout holds) nor merged on a guess. Nothing moved (${base}, ${branch} and"
    echo "${worktree} are as they were), and no landing lock was taken."
  } >&2
  if [[ -n "${prerun_tmp:-}" ]]; then
    rm -f "$prerun_tmp"
  fi
  exit 1
}

# The tip remote $1 holds for <branch>: prints it and returns 0; 2 when the remote does
# not carry the branch; 1 when the remote could not be read.
shared_ls_remote() {  # $1 remote
  local out="" rc=0 sha="" name=""
  out="$(GIT_TERMINAL_PROMPT=0 git -C "$worktree" ls-remote --exit-code "$1" "refs/heads/${branch}" 2>/dev/null)" || rc=$?
  if [[ "$rc" == "2" ]]; then
    return 2
  fi
  [[ "$rc" == "0" ]] || return 1
  while IFS=$'\t' read -r sha name; do
    if [[ "$name" == "refs/heads/${branch}" ]]; then
      printf '%s\n' "$sha"
      return 0
    fi
  done <<< "$out"
  return 2
}

shared_line="not asked (${branch} already descends from ${base})"
sb_need="no"
if ! git -C "$worktree" merge-base --is-ancestor "$base" "$branch"; then
  sb_need="yes"
elif [[ "$origin_read" == "yes" ]] &&
     git -C "$worktree" rev-parse --verify --quiet "refs/remotes/origin/${base}" >/dev/null &&
     ! git -C "$worktree" merge-base --is-ancestor "refs/remotes/origin/${base}" "$branch"; then
  sb_need="yes"
fi
if [[ "$sb_need" == "yes" ]]; then
  sb_tip="$(git -C "$worktree" rev-parse "refs/heads/${branch}")"
  sb_signals=""
  sb_copies=""        # "<source> <sha>" per line: every copy another holder has
  sb_rc=0
  sb_sha=""
  if [[ "$origin_read" == "yes" && "$ISO_ORIGIN_VIEW_SOURCE" == "bundle" ]]; then
    sb_bundle="${ISO_PUBLISHER_STATE}/origin/$(iso_publisher_name "$worktree" || true).bundle"
    sb_heads="$(git -C "$worktree" bundle list-heads "$sb_bundle" 2>/dev/null)" ||
      shared_refuse "the publisher bundle $(iso_safe_text "$sb_bundle") (origin's view) could not be listed, so whether origin holds a copy of ${branch} -- whether it is shared -- is unknown."
    while IFS=' ' read -r sb_sha sb_name; do
      if [[ "$sb_name" == "refs/remotes/origin/${branch}" ]]; then
        sb_signals="${sb_signals:+${sb_signals},}bundle"
        sb_copies="${sb_copies}bundle ${sb_sha}"$'\n'
        break
      fi
    done <<< "$sb_heads"
  elif [[ "$origin_read" == "yes" && "$ISO_ORIGIN_VIEW_SOURCE" == "break-glass" ]]; then
    # the view is the operator path, not remote.origin.url
    sb_rc=0
    sb_sha="$(shared_ls_remote "$ISO_ORIGIN_BREAK_GLASS")" || sb_rc=$?
    if [[ "$sb_rc" == "0" ]]; then
      sb_signals="${sb_signals:+${sb_signals},}origin"
      sb_copies="${sb_copies}origin ${sb_sha}"$'\n'
    elif [[ "$sb_rc" != "2" ]]; then
      shared_refuse "the origin break-glass $(iso_safe_text "$ISO_ORIGIN_BREAK_GLASS") could not be read (git ls-remote failed), so whether it holds a copy of ${branch} -- whether it is shared -- is unknown."
    fi
  elif [[ "$origin_read" == "yes" ]]; then
    sb_rc=0
    sb_sha="$(shared_ls_remote origin)" || sb_rc=$?
    if [[ "$sb_rc" == "0" ]]; then
      sb_signals="${sb_signals:+${sb_signals},}origin"
      sb_copies="${sb_copies}origin ${sb_sha}"$'\n'
    elif [[ "$sb_rc" != "2" ]]; then
      shared_refuse "origin could not be read (git ls-remote failed), so whether it holds a copy of ${branch} -- whether it is shared -- is unknown."
    fi
  fi
  while IFS= read -r sb_remote; do
    [[ -n "$sb_remote" && "$sb_remote" != "origin" ]] || continue
    sb_show="$(iso_safe_text "$sb_remote")"
    sb_rc=0
    sb_sha="$(shared_ls_remote "$sb_remote")" || sb_rc=$?
    if [[ "$sb_rc" == "0" ]]; then
      sb_signals="${sb_signals:+${sb_signals},}${sb_show}"
      sb_copies="${sb_copies}${sb_show} ${sb_sha}"$'\n'
    elif [[ "$sb_rc" != "2" ]]; then
      shared_refuse "the remote ${sb_show} could not be read (git ls-remote failed), so whether it holds a copy of ${branch} -- whether it is shared -- is unknown. Fix or remove that remote, then run finish again."
    fi
  done < <(git -C "$worktree" remote 2>/dev/null || true)
  if [[ -n "$(branch_checked_out_elsewhere "$worktree")" ]]; then
    sb_signals="${sb_signals:+${sb_signals},}worktree"
  fi
  # Every copy must be one history with the session's tip and with every other copy: an
  # ancestor or a descendant. A copy whose commit this checkout does not even have holds
  # work the session never saw, and no integration here is right for both.
  sb_all="session ${sb_tip}"$'\n'"${sb_copies}"
  while IFS=' ' read -r sb_a sb_ca; do
    [[ -n "$sb_a" ]] || continue
    while IFS=' ' read -r sb_b sb_cb; do
      [[ -n "$sb_b" && "$sb_a" != "$sb_b" && "$sb_ca" != "$sb_cb" ]] || continue
      if ! git -C "$worktree" cat-file -e "${sb_cb}^{commit}" 2>/dev/null ||
         ! git -C "$worktree" cat-file -e "${sb_ca}^{commit}" 2>/dev/null ||
         { ! git -C "$worktree" merge-base --is-ancestor "$sb_ca" "$sb_cb" &&
           ! git -C "$worktree" merge-base --is-ancestor "$sb_cb" "$sb_ca"; }; then
        shared_refuse "the branch is shared and its copies have diverged: ${sb_b} holds ${branch} at ${sb_cb:0:7} and ${sb_a} at ${sb_ca:0:7}, and neither contains the other (or this checkout does not have that commit). Reconcile the copies first."
      fi
    done <<< "$sb_all"
  done <<< "$sb_all"
  shared_line="${sb_signals:-no}"
fi

# --- the landing lock: one landing at a time per primary ----------------------
# Where the lock is, asked ONCE and kept in a variable, so releasing it later is a bare
# `rm` with nothing in front of it. The release used to ask `iso_land_lock_release`,
# which finds the path through `$(git rev-parse --git-common-dir)` -- and a command
# substitution is a fork that inherits this shell's stdio buffer. After a write to a
# broken descriptor that buffer still HOLDS the refusal bash could not deliver, the
# child flushes it into the pipe, and the "path" that comes back is the refusal with the
# path glued to its end. `rm -f` then removes nothing and the landing lock stays owned by
# a live pid -- every other landing then waits with no time limit. Nothing fallible goes in front
# of a release. A live holder is not a timeout: the landing takes a FIFO ticket and
# waits its turn with no time limit. ISOLATED_SESSION_LAND_WAIT=0 still means do not
# wait at all (refuse at once, leave no ticket). Any other value, including the
# default, does not cap the wait.
land_lock="$(iso_land_lock_path "$primary" 2>/dev/null || true)"
# The release removes the lock only while it records THIS process ($$, which created it):
# a lock some other landing has since put there is that landing's. Builtins only -- no
# fork in front of the `rm`, for the reason above.
land_lock_is_mine() {
  local line
  [[ -n "$land_lock" && -f "$land_lock" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      owner_pid=*)
        [[ "${line#owner_pid=}" == "$$" ]] && return 0
        return 1
        ;;
    esac
  done 2>/dev/null < "$land_lock"
  return 1
}
# The in-lock gate runs as a background job in a process group of its own (gate_pid is
# its leader), so a landing that gives up -- a signal, or any exit while the gate still
# runs -- takes the whole gate down with it: the runner, its tests, and the gate slot its
# runner holds. A gate left running kept its 'in-lock' slot as an orphan while the lock it
# ran under was gone. TERM first, KILL after five seconds.
gate_pid=""
land_gate_stop() {
  local g="${gate_pid:-}" n=0
  [[ -n "$g" ]] || return 0
  gate_pid=""
  kill -TERM -- "-${g}" 2>/dev/null || kill -TERM "$g" 2>/dev/null || true
  while (( n < 50 )) && kill -0 -- "-${g}" 2>/dev/null; do
    sleep 0.1
    n=$(( n + 1 ))
  done
  kill -KILL -- "-${g}" 2>/dev/null || true
  return 0
}
# A signal gives up once: a second one (the process group's after the started copy's
# TERM, say) must not cut short the EXIT trap that releases what this landing holds.
land_give_up() {  # $1 exit status
  trap '' TERM INT HUP
  land_gate_stop
  exit "$1"
}
owner="$(iso_owner)"
land_wait="${ISOLATED_SESSION_LAND_WAIT:-2700}"
land_poll="${ISOLATED_SESSION_LAND_POLL:-5}"
land_progress="${ISOLATED_SESSION_LAND_PROGRESS:-600}"
[[ "$land_poll" =~ ^[1-9][0-9]*$ ]] || land_poll=5
[[ "$land_progress" =~ ^[1-9][0-9]*$ ]] || land_progress=600
waited=0
since_progress=0
holding_land="no"
land_ticket=""
land_ticket_name=""
take_failures=0
take_tries=3
# Exits during the wait (before on_exit exists) still remove this landing's ticket.
# on_exit replaces this trap and cleanup removes the ticket again if it is still set.
trap 'finish_receipt_note $?; iso_land_queue_drop "${land_ticket:-}"; land_ticket=""; land_ticket_name=""; landing_marker_drop' EXIT
# A landing that is stopped gives up: it stops its in-lock gate (land_gate_stop) and
# exits, and the EXIT trap releases what it holds. Untrapped, SIGTERM ended bash with no
# EXIT trap at all, leaving the lock and an orphan gate holding its slot.
trap 'land_give_up 143' TERM
trap 'land_give_up 130' INT
trap 'land_give_up 129' HUP
while :; do
  # `$$`: only the finish process that created the lock holds it, never its owner key
  state="$(iso_land_lock_state "$primary" "$owner" "$$")"
  case "$state" in
    mine)
      iso_land_queue_drop "$land_ticket"
      land_ticket=""
      land_ticket_name=""
      holding_land="yes"
      break
      ;;
    dead)
      echo "note: a landing lock left by a session that is gone ($(iso_land_lock_describe "$primary")); taking it over" >&2
      iso_land_lock_take_over "$primary"
      ;;
    free|other)
      if [[ "$state" == "free" ]] && ! iso_land_queue_blocked "$primary" "$land_ticket_name"; then
        if iso_land_lock_take "$primary" "$owner" "$branch" "$$"; then
          iso_land_queue_drop "$land_ticket"
          land_ticket=""
          land_ticket_name=""
          holding_land="yes"
          break
        fi
        # The lock reads free but cannot be created: the take printed why. Retried a few
        # times, then refused by name -- it used to loop with no sleep and no end
        # (intake 20261026T142951Z).
        take_failures=$(( take_failures + 1 ))
        if (( take_failures >= take_tries )); then
          iso_land_queue_drop "$land_ticket"
          land_ticket=""
          land_ticket_name=""
          {
            echo "refusing to land ${branch}: could not take the landing lock $(iso_land_lock_path "$primary" || echo "of ${primary}")"
            echo "  The lock reads free, but creating it failed ${take_failures} times (the error is above)."
            echo "  Most likely a wall denies writes to the primary's .git. Land from outside that wall."
          } >&2
          [[ -z "$prerun_tmp" ]] || rm -f "$prerun_tmp"
          refusal_category="lock-take-failed"
          exit 1
        fi
        sleep 1
      else
        # LAND_WAIT=0: do not queue and do not sleep. The lock (or an earlier live
        # ticket) is left as it is.
        if [[ "$land_wait" == "0" ]]; then
          iso_land_queue_drop "$land_ticket"
          land_ticket=""
          land_ticket_name=""
          {
            echo "refusing to land ${branch}: another landing holds ${primary}"
            echo "  $(iso_land_lock_describe "$primary")"
            echo "Waited ${waited}s (ISOLATED_SESSION_LAND_WAIT). Run finish again when it is done."
          } >&2
          [[ -z "$prerun_tmp" ]] || rm -f "$prerun_tmp"
          refusal_category="lock"
          exit 1
        fi
        if [[ -z "$land_ticket" ]]; then
          land_ticket="$(iso_land_queue_enqueue "$primary" "$owner" "$branch")" || {
            echo "refusing to land ${branch}: could not take a landing-queue ticket" >&2
            [[ -z "$prerun_tmp" ]] || rm -f "$prerun_tmp"
            exit 1
          }
          land_ticket_name="${land_ticket##*/}"
        fi
        if [[ -n "$land_ticket" ]]; then
          iso_land_queue_touch "$land_ticket" || true
        fi
        if (( since_progress == 0 )); then
          echo "waiting for the landing lock: $(iso_land_lock_describe "$primary")" >&2
        fi
        sleep "$land_poll"
        waited=$(( waited + land_poll ))
        since_progress=$(( since_progress + land_poll ))
        if (( since_progress >= land_progress )); then
          since_progress=0
        fi
      fi
      ;;
  esac
done
# when this landing took the lock, epoch seconds: the lease take below, when it holds one,
# moves it (LOCK_HELD_BEFORE_GATE, intake 20261010T143322Z)
lock_taken_at="$(date +%s)"

tmp_merge=""
tmp_rebase=""
tmp_publish=""           # the detached checkout a not-a-fast-forward round rebases in
# the generated files: a conflict confined to them is answered by the ledger, both in the
# self-rebase of BASE and in the rebase of the branch below
generated="PLAN.md docs/IMPLEMENTATION_BACKLOG.md docs/SPECIFICATION.md"
base_rebased="no"        # the self-rebase below rewrote local BASE (and handed it off)
base_rebase_line=""      # BASE_REBASE= on the receipt, when it did
base_rebase_from=""
# The fast-forward of BASE below runs BEFORE the rebase, the tests, the scan and the
# merge, so every refusal AFTER it exits with refs/heads/BASE already advanced and the
# tracked files of the checkout sitting on BASE already rewritten from origin. The
# receipt line is owed on those exits too, and one sentence has to say the primary
# moved even though the landing did not happen -- "the worktree is untouched" is true
# of the session worktree and false of the checkout the operator is looking at. A
# refusal BEFORE the ff (diverged, an on-disk collision, a dirty base) says neither,
# because nothing moved.
#
# ... and the OTHER thing an exit has to know is whether the branch->BASE merge below
# has run. `merged` is set the moment it has, and from then on BASE carries the branch
# permanently: a step that fails after it (the worktree would not come out, the branch
# would not delete) leaves a landing that is neither undone nor finished, and the
# sentence "the landing did not happen" is then simply false. Three states, three
# sentences: (i) ff ran, merge did not; (ii) merge ran, a later step failed; (iii)
# nothing moved -- nothing printed.
base_ff_line="none (no origin/BASE)"
base_ff_moved="no"
base_ff_reported="no"
base_ff_where=""
merged="no"
base_tip=""
remote_base="origin/${base}"
# Landing lease (ISSUE(two-machines-land-without-talking), now a Durable Object: see
# ../worker/): held after the local lock, released on every path that took it --
# success, red tests, a failed publish, the rest -- with the epoch it was granted, so a
# release can never free a lease that has since passed to another machine.
lease_held="no"
lease_did_hold="no"
lease_as=""
lease_repo=""
lease_room=""
lease_epoch=""
lease_release_rc=""
gate_scratch=""
cleanup() {
  # The lease first, while this landing still holds the local lock (unless the hand-off
  # push already released it, see the publish wait), then the lock
  # by name: one `rm` on a path this shell already had, before anything that forks
  # to *find* the lock (see land_lock above for what a fork costs after a failed
  # write). Only then the temp merge worktree, which needs git and may fail.
  # Always 0: a cleanup that held nothing is not an error.
  # A gate still running here is one this landing gave up on: it goes before the lock.
  land_gate_stop
  if [[ "$lease_held" == "yes" ]]; then
    lease_held="no"
    # The release's exit status is kept for the receipt: LEASE=released only on 0.
    lease_release_rc=0
    if [[ -n "${LANDING_LEASE_CLI:-}" ]]; then
      "$LANDING_LEASE_CLI" release --as "$lease_as" --repo "$lease_repo" --room "$lease_room" ${lease_epoch:+--epoch "$lease_epoch"} >/dev/null 2>&1 || lease_release_rc=$?
    else
      DISPATCH_SKILL_REPO="$primary" bash "$here/landing-lease.sh" release --as "$lease_as" --repo "$lease_repo" \
        ${lease_epoch:+--epoch "$lease_epoch"} >/dev/null 2>&1 || lease_release_rc=$?
    fi
  fi
  if [[ -n "${land_ticket:-}" ]]; then
    iso_land_queue_drop "$land_ticket"
    land_ticket=""
    land_ticket_name=""
  fi
  if [[ "$holding_land" == "yes" ]]; then
    holding_land="no"
    land_lock_is_mine && rm -f "$land_lock" 2>/dev/null
  fi
  if [[ -n "$prerun_tmp" ]]; then
    rm -f "$prerun_tmp" 2>/dev/null
    prerun_tmp=""
  fi
  if [[ -n "$tmp_merge" ]]; then
    git -C "$primary" worktree remove --force "$tmp_merge" >/dev/null 2>&1 || true
    tmp_merge=""
  fi
  if [[ -n "$tmp_rebase" ]]; then
    git -C "$primary" worktree remove --force "$tmp_rebase" >/dev/null 2>&1 || true
    tmp_rebase=""
  fi
  if [[ -n "$tmp_publish" ]]; then
    git -C "$tmp_publish" rebase --abort >/dev/null 2>&1 || true
    git -C "$primary" worktree remove --force "$tmp_publish" >/dev/null 2>&1 || true
    tmp_publish=""
  fi
  if [[ -n "$gate_scratch" ]]; then
    rm -rf "$gate_scratch" 2>/dev/null || true
    gate_scratch=""
  fi
  landing_marker_drop
  return 0
}
on_exit() {
  local rc=$? moved_note=""
  # `cleanup` FIRST, and every print after it non-fatal. Under `set -euo pipefail` the
  # trap's echoes ran BEFORE the cleanup they wrapped, so one failed write -- a closed
  # stdout, SIGPIPE, a full disk -- aborted the trap: the landing lock stayed owned by a
  # LIVE pid, every other landing then waits with no time limit, and an in-flight
  # tmp_merge worktree was left for the next landing to trip over. Releasing before
  # speaking costs nothing and cannot be talked out of.
  # (`cleanup` ends in an `if` that is false when nothing is held, so it can return 1
  # with nothing wrong; `|| true` keeps that out of the way.)
  cleanup || true
  [[ "$rc" != "0" ]] || return 0
  finish_receipt_note "$rc"
  if [[ "$base_ff_moved" == "yes" && "$base_ff_reported" == "no" ]]; then
    base_ff_reported="yes"
    echo "BASE_FF=${base_ff_line}" || true
  fi
  # A self-rebase is not undone by a later refusal: local BASE and the hand-off both
  # already hold the rebased history, which is the state the publisher can push. Said,
  # so the operator does not go looking for the commits under their old names.
  if [[ "$base_rebased" == "yes" ]]; then
    echo "BASE_REBASE=${base_rebase_line}" || true
    echo "note: local ${base} was rebased onto ${remote_base} before this exit (${base_rebase_from:0:7}..$(git -C "$primary" rev-parse --short=7 "$base" 2>/dev/null || true), ${base_rebase_line}) and the hand-off was given it; that stays.$([[ "$merged" == "yes" ]] || printf ' The landing did not happen.')" >&2 || true
  fi
  # The ff sentence and the merge sentence are NOT alternatives: a landing can have
  # fast-forwarded BASE from origin AND merged the branch AND then failed, and the
  # operator is owed both facts -- that the checkout they are sitting in had its tracked
  # files rewritten from origin, and that BASE now carries the branch for good. As an
  # if/elif the ff half was simply dropped whenever the merge had run.
  if [[ "$base_ff_moved" == "yes" ]]; then
    # Which half moved matters: the update-ref arm moves a REF and not one working tree,
    # and telling an operator their files were rewritten when nothing touched them is its
    # own small lie.
    if [[ -n "$base_ff_where" ]]; then
      moved_note="local ${base} was moved to ${remote_base} before this exit (its checkout ${base_ff_where} came along), so that ref and the files under it are no longer where they were."
    else
      moved_note="local ${base} was moved to ${remote_base} before this exit; no working tree had ${base} checked out, so the ref moved and no files moved with it."
    fi
    # "the landing did not happen" is true only while the merge has not run: in state
    # (ii) it HAS, and saying so there is the claim the merge sentence exists to correct.
    [[ "$merged" == "yes" ]] || moved_note="${moved_note} The landing did not happen."
    echo "note: ${moved_note}" >&2 || true
  fi
  if [[ "$merged" == "yes" ]]; then
    # (ii) BASE carries the branch and will keep carrying it; only a later step failed.
    # Three facts are owed: what BASE now has, that the landing did not finish, and that
    # finish is not to be re-run as it stands (it would find the branch already merged
    # and print a receipt for a landing that never cleaned up).
    echo "note: ${base} now carries ${branch} (${base_tip}); the landing did not complete -- what remains is the session worktree ${worktree} and the branch ${branch}. No receipt was printed, so do not re-run finish as it stands: remove that worktree and delete the branch by hand." >&2 || true
    # ... and the two the receipt would have carried and cannot: whether what BASE now
    # holds was scanned as needs-eyes (nobody spawned a reviewer -- that section runs
    # after the receipt) and that the hand-off never got this tip, so the publisher has
    # not seen it and will not push it.
    if [[ "${sec_verdict:-none}" == "needs-eyes" ]]; then
      echo "note: that landing was needs-eyes, and its reviewer is spawned only after the receipt -- so no review ran and one is owed: run the security-audit skill over ${base_before}..${base_tip} by hand." >&2 || true
    fi
    echo "note: the hand-off was not pushed, so the publisher has not seen ${base_tip} and will not publish it until a later landing hands it over." >&2 || true
  fi
}
trap on_exit EXIT

# --- Landing lease: after the local lock, before origin fetch/ff/rebase ------------
# Two Macs publish to one origin. This machine must hold the landing lease for this
# repository before it moves git state, and release it on every path after a
# successful take (cleanup, including red tests). A live foreign hold refuses and
# leaves BASE, origin and the worktree unmoved. The take is ONE process and ONE POST
# (landing-lease.sh); its exit code says which failure it was: 2 this machine's
# configuration, 3 the lease service unreachable, 4 held by another, 5 refused by the
# service (its reason verbatim). None of them is ever reported as another.
# LANDING_LEASE=off or APPL_LEASE=off is the break-glass for a lease-service outage:
# either one disables the lease ENTIRELY, even where it is configured -- no take, no
# release, no request -- and the receipt says `LEASE=off (break-glass)` so the landing
# is visibly unleased (owner ruling, 20260922T150818Z). Otherwise the room file still
# says whether this machine is configured to land under a lease at all. Throwaway
# harnesses that never set DISPATCH_DIR and have no dispatch directory take none.
#
# A present room file that does NOT resolve is a refusal, before anything moves, and the
# refusal prints the one command that configures the machine (dispatch-init.sh), with a
# placeholder only where the value is unknown. It never suggests LANDING_LEASE=off: that
# override is an operator's decision, and a refusal that offers it is how every real
# landing came to run without a lease (plan 2026-09-19-multi-mac-appl, M1).
#
# The lease is then held past the hand-off push, until the publisher says it published
# what this landing handed over (see "held until published" below).
publish_wait_s="${LANDING_PUBLISH_WAIT_S:-300}"
case "$publish_wait_s" in
  ''|*[!0-9]*)
    echo "refusing to land ${branch}: LANDING_PUBLISH_WAIT_S=$(iso_safe_text "$publish_wait_s") is not a whole number of seconds; nothing moved." >&2
    refusal_category="config"
    exit 1
    ;;
esac
landing_lease_read_kv() {
  local f="$1" key="$2" line
  [[ -f "$f" && ! -L "$f" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "${key}="*) printf '%s\n' "${line#${key}=}"; return 0 ;;
    esac
  done < "$f"
  return 1
}

landing_lease_repo_from_repos() {
  local repos="$1" want="$2" n pth abs
  [[ -f "$repos" && ! -L "$repos" ]] || return 1
  abs="$(cd "$want" && pwd)" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    [[ "$line" == *=* ]] || continue
    n="${line%%=*}"
    pth="${line#*=}"
    case "$pth" in
      "~/"*) pth="${HOME}/${pth#~/}" ;;
    esac
    if [[ -d "$pth" ]] && [[ "$(cd "$pth" && pwd)" == "$abs" ]]; then
      printf '%s\n' "$n"
      return 0
    fi
  done < "$repos"
  return 1
}

dispatch_dir="${DISPATCH_DIR:-${HOME}/.muretai/dispatch}"
room_file="${dispatch_dir}/room"
refusal_category="lease"        # every refusal of the lease block below
if [[ "${LANDING_LEASE:-}" == "off" || "${APPL_LEASE:-}" == "off" ]]; then
  echo "LEASE=off (break-glass)"
elif [[ ! -f "$room_file" || -L "$room_file" ]]; then
  if [[ -n "${DISPATCH_DIR:-}" || -d "$dispatch_dir" ]]; then
    {
      echo "refusing to land ${branch}: no Room file at ${room_file}"
      echo "  write did=<the Room's did> to that file (the Room this machine takes the landing"
      echo "  lease through), then run finish again; nothing moved."
    } >&2
    exit 1
  fi
else
  lease_as="${LANDING_LEASE_AS:-}"
  if [[ -z "$lease_as" ]]; then
    lease_as="$(landing_lease_read_kv "${dispatch_dir}/agent" name || true)"
  fi
  lease_repo="${LANDING_LEASE_REPO:-}"
  if [[ -z "$lease_repo" ]]; then
    lease_repo="$(landing_lease_repo_from_repos "${dispatch_dir}/repos" "$primary" || true)"
  fi
  lease_room="$(landing_lease_read_kv "$room_file" did || true)"
  if [[ -z "$lease_as" || -z "$lease_repo" || -z "$lease_room" ]]; then
    if [[ -z "$lease_room" ]]; then
      {
        echo "refusing to land ${branch}: the Room file ${room_file} has no did= line"
        echo "  write did=<the Room's did> to it, then run finish again; nothing moved."
      } >&2
      exit 1
    else
      # the command, with each value this landing knows filled in: the agent from the
      # agent file (or LANDING_LEASE_AS), the name from the repos line that maps this
      # primary (or LANDING_LEASE_REPO), and this primary's path, which is always known
      li_path="$(printf '%q' "$primary")"
      {
        echo "refusing to land ${branch}: the Room file ${room_file} is set, but this machine"
        if [[ -z "$lease_as" ]]; then
          echo "  does not say which agent it lands as (no name= in ${dispatch_dir}/agent)"
        fi
        if [[ -z "$lease_repo" ]]; then
          echo "  maps no repository to this checkout (no line in ${dispatch_dir}/repos names ${primary})"
        fi
        echo "Configure it once, then run finish again; nothing moved:"
        echo "  bash $(printf '%q' "$hint_init") --as ${lease_as:-<agent>} --repo ${lease_repo:-<name>}=${li_path}"
        if [[ -z "$lease_repo" ]]; then
          echo "  (<name> is the repository's name in the Room lease: the same on every machine that lands it)"
        fi
      } >&2
      exit 1
    fi
  else
    # The node the lease runs through (M1 defect: the lease ran this checkout's
    # operator_cli, which has no connection to the Room). A missing or untrusted
    # node line refuses here, before anything moves, with the dispatch-init.sh call.
    lease_node="$(landing_lease_read_kv "${dispatch_dir}/node" node || true)"
    lease_node_err=""
    if [[ -z "$lease_node" ]]; then
      lease_node_err="no node= line in ${dispatch_dir}/node: this machine has not said which node the lease runs through"
    else
      set +e
      # DISPATCH_SKILL_REPO: `here` is BASE's copy in a private directory outside any
      # checkout, so the client cannot find this repository from its own location
      lease_node_err="$(DISPATCH_SKILL_REPO="$primary" python3 -I "$here/landing-lease.py" check-node "$lease_node" --as-prefix node 2>&1 >/dev/null)"
      lease_node_rc=$?
      set -e
      if [[ "$lease_node_rc" == "0" ]]; then
        lease_node_err=""
      fi
    fi
    if [[ -n "$lease_node_err" ]]; then
      {
        echo "refusing to land ${branch}: ${lease_node_err}"
        echo "Configure it once, then run finish again; nothing moved:"
        echo "  bash $(printf '%q' "$hint_init") --as ${lease_as} --repo ${lease_repo}=$(printf '%q' "$primary") --node <absolute path of this machine's node>"
      } >&2
      exit 1
    fi
    lease_out="$(finish_tmp)"
    lease_err="$(finish_tmp)"
    set +e
    if [[ -n "${LANDING_LEASE_CLI:-}" ]]; then
      "$LANDING_LEASE_CLI" take --as "$lease_as" --repo "$lease_repo" --room "$lease_room" >"$lease_out" 2>"$lease_err"
    else
      DISPATCH_SKILL_REPO="$primary" bash "$here/landing-lease.sh" take --as "$lease_as" --repo "$lease_repo" \
        >"$lease_out" 2>"$lease_err"
    fi
    lease_rc=$?
    set -e
    cat "$lease_err" >&2 || true
    lease_held_by=""
    lease_until=""
    lease_expired_by=""
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        held-by=*) lease_held_by="${line#held-by=}" ;;
        until=*) lease_until="${line#until=}" ;;
        epoch=*) lease_epoch="${line#epoch=}" ;;
        expired-lease-by=*) lease_expired_by="${line#expired-lease-by=}" ;;
      esac
    done < "$lease_out"
    case "$lease_epoch" in
      *[!0-9]*) lease_epoch="" ;;
    esac
    # what the lease tool printed is the backend's words: every value that reaches the
    # receipt goes through iso_safe_text, like every other outside string in this file
    lease_held_by="$(iso_safe_text "$lease_held_by")"
    lease_until="$(iso_safe_text "$lease_until")"
    lease_expired_by="$(iso_safe_text "$lease_expired_by")"
    if [[ "$lease_rc" == "4" ]]; then
      echo "LEASE=refused held-by ${lease_held_by} until ${lease_until}"
      {
        echo "refusing to land ${branch}: the landing lease is held by ${lease_held_by} until ${lease_until}"
        cat "$lease_out"
      } >&2
      rm -f "$lease_out" "$lease_err"
      exit 1
    fi
    if [[ "$lease_rc" != "0" ]]; then
      # the client's own one-line reason, without its "landing-lease: " prefix: a refusal
      # names the service's reason verbatim, and unreachable says so -- never each other
      lease_why=""
      while IFS= read -r line || [[ -n "$line" ]]; do
        [[ -n "$line" ]] && lease_why="${line#landing-lease: }"
      done < "$lease_err"
      case "$lease_rc" in
        3) lease_what="the lease service is unreachable" ;;
        5) lease_what="the lease service refused the take" ;;
        2) lease_what="this machine's lease configuration is incomplete" ;;
        *) lease_what="the landing lease take failed (exit ${lease_rc})" ;;
      esac
      {
        echo "refusing to land ${branch}: ${lease_what}: $(iso_safe_text "${lease_why:-no reason given}")"
        cat "$lease_out"
        echo "  nothing moved."
      } >&2
      rm -f "$lease_out" "$lease_err"
      exit 1
    fi
    lease_held="yes"
    lease_did_hold="yes"
    lock_taken_at="$(date +%s)"
    if [[ -n "$lease_expired_by" ]]; then
      echo "LEASE=held (expired lease by ${lease_expired_by} superseded) expired-lease-by=${lease_expired_by}"
    else
      echo "LEASE=held ${lease_held_by} until ${lease_until}"
    fi
    rm -f "$lease_out" "$lease_err"
  fi
fi
refusal_category=""

# --- origin is the serialization point: BASE comes down before the rebase ---------
# Two primaries (two Macs) now publish to ONE origin through their own publishers
# (company/ops/publisher/README.md). A landing that rebases onto LOCAL BASE alone
# lands a tip origin has never seen the parent of: this Mac's publisher holds the
# hand-off ("not a fast-forward of origin"), and the next ensure-worktree.sh here
# refuses to start, local BASE and origin/BASE having diverged. So the landed tip
# must DESCEND from origin/BASE, and the cheapest way to get there is to fast-forward
# local BASE first and rebase the branch onto the result.
#
# The fetch above already left origin/BASE current; it tolerates failure, because an
# offline landing is a supported case -- the ff is then judged against whatever
# origin/BASE this repository already has. Nothing here goes TO origin: this moves a
# LOCAL ref to a ref that came FROM origin.
#
# The ref moves, so the checkout that HAS BASE checked out is brought along the same
# way the merge below does it (and is refused, unchanged, when it holds uncommitted
# tracked changes). A diverged BASE is a stop, not a warning: reconciling two
# histories is a person's decision, and the session doing it says so with
# ISOLATED_SESSION_FORCE=1, which lands onto local BASE as before.
#
# A refusal after this point used to say the worktree was untouched and already
# rebased, whether or not either ref had moved. These are the refs before the
# fast-forward and, filled in after the branch is brought onto base, the refs
# after it. say_what_moved reads the difference, not a fixed sentence.
ref_base_before="$(git -C "$worktree" rev-parse "$base" 2>/dev/null || true)"
ref_branch_before="$(git -C "$worktree" rev-parse "$branch" 2>/dev/null || true)"
expect_tip_hold "while the landing waited"
ref_base_after=""
ref_branch_after=""
# $1 = quiet: when nothing moved, print nothing (the caller already spoke).
# Otherwise say the worktree is untouched, and do not claim a rebase or a
# fast-forward. When a recorded ref differs, name what moved and the branch tip.
say_what_moved() {
  local quiet="${1:-}" base_moved=no branch_moved=no tip="" fact=""
  if [[ -n "$ref_base_before" && -n "$ref_base_after" && "$ref_base_before" != "$ref_base_after" ]]; then
    base_moved=yes
  fi
  if [[ -n "$ref_branch_before" && -n "$ref_branch_after" && "$ref_branch_before" != "$ref_branch_after" ]]; then
    branch_moved=yes
  fi
  if [[ "$base_moved" == "no" && "$branch_moved" == "no" ]]; then
    if [[ "$quiet" != "quiet" ]]; then
      echo "The worktree is untouched; fix, commit, run finish again." >&2
    fi
    return 0
  fi
  tip="$ref_branch_after"
  if [[ "$base_moved" == "yes" && "$base_ff_moved" == "yes" ]]; then
    fact="${base} was fast-forwarded"
  elif [[ "$base_moved" == "yes" && "$base_rebased" == "yes" ]]; then
    fact="${base} was rebased"
  elif [[ "$base_moved" == "yes" ]]; then
    fact="${base} moved"
  fi
  if [[ "$branch_moved" == "yes" && "$rebased" == "yes" ]]; then
    if [[ -n "$fact" ]]; then
      fact="${fact} and the branch was rebased"
    else
      fact="the branch was rebased"
    fi
  elif [[ "$branch_moved" == "yes" && "$rebased" == "merge" ]]; then
    if [[ -n "$fact" ]]; then
      fact="${fact} and ${base} was merged into the branch"
    else
      fact="${base} was merged into the branch"
    fi
  elif [[ "$branch_moved" == "yes" ]]; then
    if [[ -n "$fact" ]]; then
      fact="${fact} and the branch tip moved"
    else
      fact="the branch tip moved"
    fi
  fi
  echo "${fact}; the branch tip is now ${tip}. Fix, commit, run finish again." >&2
}
if git -C "$worktree" remote get-url origin >/dev/null 2>&1 &&
   git -C "$worktree" rev-parse --verify --quiet "$remote_base" >/dev/null; then
  ff_from="$(git -C "$worktree" rev-parse "$base")"
  ff_to="$(git -C "$worktree" rev-parse "$remote_base")"
  if git -C "$worktree" merge-base --is-ancestor "$remote_base" "$base"; then
    base_ff_line="no-op${origin_source}"
  elif git -C "$worktree" merge-base --is-ancestor "$base" "$remote_base"; then
    ff_wt="$(worktree_for_branch "$base" || true)"
    if [[ -n "$ff_wt" ]]; then
      if is_tracked_dirty "$ff_wt"; then
        echo "base ${base} is checked out at ${ff_wt} and has uncommitted changes; cannot merge" >&2
        echo "  ${base} is behind ${remote_base} and the landing has to bring it down first." >&2
        # `|| true`: `git status` itself FAILS on some of the shapes that bring us here --
        # a symlink where a gitlink is tracked is "expected submodule path 'x' not to be a
        # symbolic link", non-zero -- and under `set -e` that killed the script in the
        # middle of its own refusal, so the operator got a half-written sentence and exit
        # 128, which is a crash wearing a refusal's words. The refusal is this script's to
        # finish; git's own words are a courtesy inside it
        # (ISSUE(security-audit-2026-09-18-daily-2026-09-18-13)).
        git -C "$ff_wt" status -sb >&2 || true
        say_gitlink_state "$ff_wt"
        exit 1
      fi
      # ... and nothing the incoming commits CREATE may land on top of something that is
      # already on disk there. Ours, by name, before anything moves -- for ignored and
      # un-ignored untracked paths alike (see ff_collision above for what git does with
      # the ignored ones).
      ff_rc=0
      ff_collides="$(ff_collisions "$ff_wt" "${ff_from}..${ff_to}")" || ff_rc=$?
      if [[ "$ff_rc" == "3" ]]; then
        {
          echo "refusing to land ${branch}: the fast-forward of ${base} to ${remote_base}"
          echo "found path(s) already on disk in ${ff_wt} and could not print them -- python3"
          echo "is on PATH and iso_safe_text could not run it, so a name the range chose would"
          echo "reach your terminal unescaped. A landing that cannot print a name safely does"
          echo "not print it at all; nothing moved (${base}, ${branch} and ${worktree} are as"
          echo "they were)."
        } >&2
        exit 1
      fi
      if [[ "$ff_rc" != "0" ]]; then
        {
          echo "refusing to land ${branch}: could not list the paths the fast-forward of"
          echo "${base} to ${remote_base} would create (git diff --diff-filter=A over"
          echo "${ff_from}..${ff_to} failed, its words above), so the on-disk check never ran."
          echo "A guard that cannot run its own check refuses the landing rather than"
          echo "conclude that nothing is in the way; nothing moved (${base}, ${branch} and"
          echo "${worktree} are as they were)."
        } >&2
        exit 1
      fi
      if [[ -n "$ff_collides" ]]; then
        {
          echo "refusing to land ${branch}: the fast-forward of ${base} to ${remote_base}"
          echo "would have overwritten path(s) already on disk in ${ff_wt} that git does not"
          echo "track there -- an untracked or ignored file, or a directory holding one, which"
          echo "is listed with what is under it:"
          printf '%s\n' "$ff_collides"
          echo "git deletes an IGNORED file to make room for an incoming tracked blob, so a"
          echo "running node's live state (keys/, data/, agents.d/, node.env) goes with it."
          echo "Move those paths aside yourself, then run finish again; nothing moved"
          echo "(${base}, ${branch} and ${worktree} are as they were)."
        } >&2
        exit 1
      fi
      # git's stderr is NOT discarded: when it refuses for a reason the check above could
      # not anticipate (a stale index.lock, a permission), its words are the only ones
      # that say why, and ours follow them.
      if ! git -C "$ff_wt" -c advice.diverging=false merge --ff-only --no-verify "$remote_base" >/dev/null; then
        echo "refusing to land ${branch}: could not fast-forward ${base} to ${remote_base} in ${ff_wt}" >&2
        exit 1
      fi
      base_ff_where="$ff_wt"
    else
      # nothing has BASE checked out: move the ref alone, and only from where we looked
      git -C "$worktree" update-ref "refs/heads/${base}" "$ff_to" "$ff_from"
    fi
    # from here on BASE is not where the operator left it: every later exit says so
    base_ff_moved="yes"
    base_ff_line="$(git -C "$worktree" rev-list --count "${ff_from}..${ff_to}") commit(s) from ${remote_base} ($(git -C "$worktree" rev-parse --short=7 "$ff_from")..$(git -C "$worktree" rev-parse --short=7 "$ff_to"))${origin_source}"
  else
    ff_ahead="$(git -C "$worktree" rev-list --count "${remote_base}..${base}")"
    ff_behind="$(git -C "$worktree" rev-list --count "${base}..${remote_base}")"
    if [[ "${ISOLATED_SESSION_FORCE:-0}" == "1" ]]; then
      echo "warning: ${base} and ${remote_base} have diverged; forced landing onto local ${base}" >&2
      base_ff_line="forced (diverged: ${ff_ahead} ahead, ${ff_behind} behind)${origin_source}"
    else
      # Diverged. Rebased here only when the local-only commits are provably this Mac's
      # own UNPUBLISHED landings; anything else is a person's reconcile, as before.
      rb_why="$(self_rebase_blocker)" || rb_why="the conditions for it could not be checked"
      if [[ -z "$rb_why" ]]; then
        self_rebase_base
        base_ff_line="rebased onto ${remote_base} (diverged: ${ff_ahead} ahead, ${ff_behind} behind)${origin_source}"
      else
        {
          echo "refusing to land ${branch}: ${base} and ${remote_base} have diverged"
          echo "  ${base} is ${ff_ahead} commit(s) ahead of and ${ff_behind} behind ${remote_base}"
          echo "Origin is the serialization point for the primaries that share it, so a landing"
          echo "onto a ${base} that origin has never seen is not a landing. Reconcile the two"
          echo "first; nothing moved (${base}, ${branch} and ${worktree} are as they were)."
          echo "Not rebased here: ${rb_why}."
          echo "Override with ISOLATED_SESSION_FORCE=1 (the session doing the reconcile), which"
          echo "lands onto local ${base} as before."
        } >&2
        refusal_category="diverged"
        exit 1
      fi
    fi
  fi
fi

# --- bring the branch onto the current base -----------------------------------
# A local session branch is rebased, so the tree the tests see is byte-identical to
# the fast-forwarded BASE and BASE stays linear. A branch another checkout holds
# (shared_line, asked before the lock above: origin, the bundle, another remote, another
# worktree) is merged, never rewritten. "not asked" is not a share signal: the branch
# already contained BASE when that was checked, and BASE may have moved while this
# landing waited for the lock. That one is rebased, so a queue of landings stays linear
# and in ticket order. ISOLATED_SESSION_LAND_MERGE=1 merges too. A local branch that
# carries a merge of BASE and whose one-by-one replay conflicts is merged as well, with no
# override, when the three-way merge of its tip is clean
# (ISSUE(landing-rebase-replays-merged-branches-and-needs-an-owner-override)).
# A conflict confined to the generated
# files is resolved by taking BASE's copy -- the ledger is rebuilt below anyway; any
# other conflict stops the landing with the steps to resolve it.
integrate="rebase"
case "$shared_line" in
  no|not\ asked*) integrate="rebase" ;;
  *) integrate="merge" ;;
esac
if [[ "${ISOLATED_SESSION_LAND_MERGE:-0}" == "1" ]]; then
  integrate="merge"
fi
rebased="no-op"
if ! git -C "$worktree" merge-base --is-ancestor "$base" "$branch"; then
  if [[ "$integrate" == "merge" ]]; then
    if ! git -C "$worktree" merge --no-edit "$base" >/dev/null 2>&1; then
      git -C "$worktree" merge --abort >/dev/null 2>&1 || true
      {
        echo "refusing to land ${branch}: merging ${base} into it conflicts."
        echo "In ${worktree}: git merge ${base}, resolve, commit, then run finish again."
      } >&2
      exit 1
    fi
    rebased="merge"
  else
    # Does the branch carry a merge OF BASE: a merge commit whose later parent BASE
    # already holds? A merge of some other branch is not one, and is rebased as ever.
    merged_base=0
    for m in $(git -C "$worktree" rev-list --merges "${base}..${branch}"); do
      for p in $(git -C "$worktree" rev-list --parents -n 1 "$m" | cut -d' ' -f3-); do
        if git -C "$worktree" merge-base --is-ancestor "$p" "$base"; then
          merged_base=1
        fi
      done
    done
    if ! git -C "$worktree" rebase "$base" >/dev/null 2>&1; then
      while :; do
        conflicted="$(git -C "$worktree" diff --name-only --diff-filter=U)"
        [[ -n "$conflicted" ]] || break
        only_generated=1
        for f in $conflicted; do
          case " $generated " in
            *" $f "*) ;;
            *) only_generated=0 ;;
          esac
        done
        if [[ "$only_generated" != "1" ]]; then
          git -C "$worktree" rebase --abort >/dev/null 2>&1 || true
          if [[ "$merged_base" == "1" ]]; then
            # the branch already merged BASE once, so a replay of its commits one by one
            # meets conflicts the merge settled: land the tip by a three-way merge of BASE
            # into it instead, the method ISOLATED_SESSION_LAND_MERGE=1 uses. Every commit
            # stays an ancestor of BASE. A conflict there too is refused, nothing half-landed.
            if git -C "$worktree" merge --no-edit "$base" >/dev/null 2>&1; then
              rebased="merge"
              break
            fi
            git -C "$worktree" merge --abort >/dev/null 2>&1 || true
            {
              echo "refusing to land ${branch}: it merged ${base} before, and both rebasing onto"
              echo "${base} and merging ${base} into it conflict in:"
              for f in $conflicted; do printf '   %s\n' "$(iso_safe_text "$f")"; done
              echo "In ${worktree}: git merge ${base}, resolve, commit, then run finish again."
            } >&2
            exit 1
          fi
          {
            echo "refusing to land ${branch}: rebasing onto ${base} conflicts in:"
            # names the diff chose, on a line an operator reads: spelled out, never raw
            for f in $conflicted; do printf '   %s\n' "$(iso_safe_text "$f")"; done
            echo "In ${worktree}: git rebase ${base}, resolve, git rebase --continue, then run"
            echo "finish again (ISOLATED_SESSION_LAND_MERGE=1 merges instead of rebasing)."
          } >&2
          exit 1
        fi
        for f in $conflicted; do
          git -C "$worktree" checkout --ours -- "$f" 2>/dev/null || true
          git -C "$worktree" add -- "$f"
        done
        if ! GIT_EDITOR=true git -C "$worktree" rebase --continue >/dev/null 2>&1; then
          if [[ -z "$(git -C "$worktree" diff --name-only --diff-filter=U)" ]]; then
            # the session's regeneration was all that commit carried: taking BASE's
            # copy emptied it, and an empty commit has nothing to land
            GIT_EDITOR=true git -C "$worktree" rebase --skip >/dev/null 2>&1 || true
          fi
        fi
        gd="$(git -C "$worktree" rev-parse --git-dir)"
        [[ -d "$gd/rebase-merge" || -d "$gd/rebase-apply" ]] || break
      done
      if [[ "$rebased" == "merge" ]]; then
        :
      elif [[ -n "$(git -C "$worktree" diff --name-only --diff-filter=U)" ]] ||
         [[ -d "$(git -C "$worktree" rev-parse --git-dir)/rebase-merge" ]] ||
         [[ -d "$(git -C "$worktree" rev-parse --git-dir)/rebase-apply" ]]; then
        git -C "$worktree" rebase --abort >/dev/null 2>&1 || true
        echo "refusing to land ${branch}: the rebase onto ${base} did not complete; resolve it in ${worktree}" >&2
        exit 1
      fi
    fi
    [[ "$rebased" == "merge" ]] || rebased="yes"
  fi
fi
ref_base_after="$(git -C "$worktree" rev-parse "$base" 2>/dev/null || true)"
ref_branch_after="$(git -C "$worktree" rev-parse "$branch" 2>/dev/null || true)"
# after a rebase the branch ref moved; make sure HEAD is still the branch
"$here/assert-head.sh" "$branch" "$worktree" >/dev/null

# --- the scanned tip: the one commit the gate judges and the merge lands -----------------
# The tests, the scan and the invariant gate below judge THIS sha, and the merge lands
# this sha -- never the branch by name. A walled worker owns its branch ref and can move it
# to an unscanned child while the landing runs; a merge by name then carried that child
# onto BASE under a clean receipt (ISSUE(security-audit-2026-10-10-pin-gate-file-review-497f)).
# Just before the merge the branch must still equal it, or the landing refuses. Only
# finish's own ledger-regeneration commit moves it, and moves it with the ref.
scanned_tip="$(git -C "$worktree" rev-parse --verify --quiet "HEAD^{commit}" 2>/dev/null || true)"
if [[ -z "$scanned_tip" || "$scanned_tip" != "$ref_branch_after" ]]; then
  echo "refusing to land ${branch}: its tip could not be pinned (HEAD ${scanned_tip:-unreadable}, branch ${ref_branch_after:-unreadable}); nothing was scanned" >&2
  exit 1
fi
# Refuses, naming the branch and both shas, when the branch ref or the worktree's HEAD is
# no longer the scanned tip. $1 says where the landing is.
scanned_tip_hold() {
  local now_ref="" now_head=""
  now_ref="$(git -C "$worktree" rev-parse --verify --quiet "refs/heads/${branch}^{commit}" 2>/dev/null || true)"
  now_head="$(git -C "$worktree" rev-parse --verify --quiet "HEAD^{commit}" 2>/dev/null || true)"
  if [[ "$now_ref" == "$scanned_tip" && "$now_head" == "$scanned_tip" ]]; then
    return 0
  fi
  {
    echo "refusing to land ${branch}: the branch moved ${1} -- the gate judged ${scanned_tip:0:12}, the branch is now ${now_ref:0:12} (HEAD ${now_head:0:12}); ${base} was not merged."
    echo "Commits the tests and the scan never saw do not land. Run finish again on the tip you mean to land."
  } >&2
  echo "MERGED=no"
  echo "TIP_MOVED=${now_ref:-none}"
  exit 1
}
# finish's own ledger-regeneration commit moves the scanned tip with it: a single commit
# whose only parent is the scanned tip, on the branch and at HEAD. Anything else refuses.
scanned_tip_follow() {
  local new="" parents=""
  new="$(git -C "$worktree" rev-parse --verify --quiet "HEAD^{commit}" 2>/dev/null || true)"
  parents="$(git -C "$worktree" rev-list --parents -n 1 "$new" 2>/dev/null | cut -d' ' -f2-)"
  if [[ -n "$new" && "$parents" == "$scanned_tip" ]]; then
    scanned_tip="$new"
  fi
  scanned_tip_hold "while its ledger was committed"
}

# --- a session never lands a generated file ------------------------------------
# BASE's ledger, from the gate directory: a branch that brings or rewrites
# tools/ledger.py is judged by the one BASE had, and by none when BASE had none.
ledger_tool="$gate_ledger"
if [[ -f "$ledger_tool" ]]; then
  ledger_err="$(finish_tmp)"
  ledger_rc=0
  landing_python "$ledger_tool" --into "$worktree" check --diff "$base" --diff-only 2>"$ledger_err" || ledger_rc=$?
  if [[ "$ledger_rc" != "0" ]]; then
    # Only the ledger's own verdict is a generated-file edit: exit 1, no Traceback, no
    # `SomeError:` line, and a generated file named. Anything else -- a Traceback, an import
    # failure the ledger printed itself, another exit code -- judged nothing: BASE's gate is
    # broken, and the branch is not to blame. Calling that a generated-file edit sent
    # sessions hunting for an edit they never made (ISSUE(gate-copy-lacks-the-ledgers-import)).
    ledger_verdict="no"
    if [[ "$ledger_rc" == "1" ]] &&
       ! grep -q 'Traceback (most recent call last)' "$ledger_err" &&
       ! grep -Eq '^[A-Za-z_][A-Za-z0-9_.]*(Error|Exception): ' "$ledger_err"; then
      for g_file in $generated; do
        if grep -qF "$g_file" "$ledger_err"; then
          ledger_verdict="yes"
          break
        fi
      done
    fi
    if [[ "$ledger_verdict" != "yes" ]]; then
      # the ledger's words, bounded and with every control byte but the newline escaped
      ledger_said="$(landing_python - "$ledger_err" <<'PY'
import sys
text = open(sys.argv[1], "rb").read().decode("utf-8", "replace")
if len(text) > 4000:
    text = "...\n" + text[-4000:]
out = []
for ch in text:
    cp = ord(ch)
    if ch == "\n" or not (cp < 0x20 or 0x7f <= cp < 0xa0 or 0x2028 <= cp <= 0x2029):
        out.append(ch)
    else:
        out.append("\\x%02x" % cp if cp < 0x100 else "\\u%04x" % cp)
sys.stdout.write("".join(out).rstrip("\n"))
PY
)" || ledger_said="(the ledger's output could not be read)"
      {
        echo "refusing to land ${branch}: the landing gate is broken -- ${base}'s tools/ledger.py"
        echo "check crashed (exit ${ledger_rc}) before it could judge the branch (this is not a generated-file edit):"
        printf '%s\n' "$ledger_said"
        echo "Fix the ledger on ${base} (or the module it failed to import), then run finish again."
      } >&2
      rm -f "$ledger_err"
      refusal_category="gate"
      exit 1
    fi
    {
      echo "refusing to land ${branch}: the branch edited a generated file."
      cat "$ledger_err"
      echo "Drop those commits' changes to the generated files (the landing regenerates them):"
      echo "  git -C '${worktree}' checkout ${base} -- ${generated}   # then commit"
    } >&2
    rm -f "$ledger_err"
    refusal_category="generated"
    exit 1
  fi
  rm -f "$ledger_err"
fi

# --- the tests the diff owes -----------------------------------------------------
# BASE's runner, from the gate directory, pointed at the branch's tree with --root: the
# branch's TESTS run, its runner never does (a runner that reports every file green is
# how a red branch merged).
runner="$gate_runner"
tests_line="none (no tools/run_tests.py in this repository)"
tests_secs=""
tests_files=""
tests_on_base=""
# whole minutes the landing lock was held before the in-lock gate's first test file
# started; empty when no in-lock gate ran here or its runner does not say when it started
lock_held_before_gate=""
# appl.toml's [tests] command, delivered by bin/appl and matched against the primary's
# appl.toml above, is the gate IN PLACE OF the runner: run once with the worktree under
# test as its cwd, walled like the branch's tests, and its exit code is the verdict -- a
# non-zero exit refuses the landing as a red runner would (TESTS_REFUSAL=red).
if [[ -n "$tests_command" ]]; then
  tests_command_text="$(iso_safe_text "$tests_command")"
  if [[ "${ISOLATED_SESSION_LAND_TESTS:-1}" == "0" ]]; then
    tests_line="skipped-by-operator (ISOLATED_SESSION_LAND_TESTS=0)"
    echo "NOTE: ISOLATED_SESSION_LAND_TESTS=0 -- landing ${branch} without running its tests" >&2
  else
    echo "running appl.toml's [tests] command for ${branch}: ${tests_command_text}" >&2
    tc_start="$SECONDS"
    set +e
    ( cd "$worktree" && credless bash -c "$tests_command" ) < /dev/null >&2
    rc=$?
    set -e
    tests_secs="$((SECONDS - tc_start))"
    if [[ "$rc" != "0" ]]; then
      tests_line="${tests_command_text} (appl.toml [tests] command; exit ${rc})"
      {
        echo "refusing to land ${branch}: appl.toml's [tests] command exited ${rc}"
        say_what_moved
      } >&2
      echo "MERGED=no"
      echo "TESTS=${tests_line}"
      receipt_tests="$tests_line"
      echo "TESTS_REFUSAL=red"
      refusal_category="tests"
      exit 1
    fi
    tests_line="${tests_command_text} (appl.toml [tests] command; exit 0)"
    if [[ -n "$(git -C "$worktree" status --porcelain)" ]]; then
      {
        echo "refusing to land ${branch}: the tests left the tree dirty -- a test wrote into the checkout:"
        git -C "$worktree" status --porcelain
      } >&2
      refusal_category="tests"
      exit 1
    fi
  fi
elif [[ -f "$runner" ]]; then
  if [[ "${ISOLATED_SESSION_LAND_TESTS:-1}" == "0" ]]; then
    tests_line="skipped-by-operator (ISOLATED_SESSION_LAND_TESTS=0)"
    echo "NOTE: ISOLATED_SESSION_LAND_TESTS=0 -- landing ${branch} without running its tests" >&2
  else
    tests_err="$(finish_tmp)"
    tests_tail="$(finish_tmp)"
    report="$(finish_tmp)"
    # The pre-run (above, outside the lock) stands only while it is current. Our own is
    # one THIS shell ran and saw exit 0: when HEAD and BASE are the shas it saw and the
    # worktree is still clean, it is the verdict and nothing runs again. The launcher's
    # receipt is bound to nothing this shell saw, so it goes through the runner's own
    # --reuse check (head, BASE, selection, worktree), which runs the files when it is
    # not current. A BASE that moved only by commits owing nothing, under the same tip
    # rebased onto them, keeps it current there too (run_tests.py's harmless_base_move);
    # the selector, its map or a guard path that is no record on that range never does.
    #
    # BASE moving under the pre-run is the common case (records commits and other landings
    # land every few minutes), so a moved BASE is judged rather than always paid for
    # (ISSUE(prerun-dies-on-every-records-commit)). The pre-run still stands when every
    # commit between the BASE it saw and this BASE is RECORDS-ONLY for this branch: the
    # range selects no test (BASE's affected_tests over it is empty -- a path in no unit owes
    # the full suite, so it never counts), it touches none of the branch's own paths, and
    # the tree now under test is the pre-run's tree with exactly the range's paths taken
    # from BASE, and the range deletes nothing (a deletion, or the old side of a rename,
    # is invisible to the selection -- changed_files reads the current tree -- yet a test
    # the branch adds may import the path it took away). Otherwise the files run again
    # over prerun_base..HEAD for SELECTION: the branch's selection and the range's
    # together, never only the branch's. The reds of that run are judged on the CURRENT
    # BASE (the runner's --judge-base), the one the branch lands onto: a test red on the
    # BASE the pre-run saw, fixed since and broken again by the branch is the branch's
    # red, not red on BASE (review secrev-pin-pre-run-reuse-ac-64e9, finding 1).
    reuse_receipt=""
    judge_base=""
    tests_from_prerun=no
    tests_range="${base}..${scanned_tip}"
    prerun_moved_line=""
    tests_receipt_line=""
    cur_head="$scanned_tip"
    cur_base="$(git -C "$worktree" rev-parse "${base}^{commit}" 2>/dev/null || true)"
    if [[ -n "$prerun_receipt" && -z "$prerun_head" ]]; then
      reuse_receipt="$prerun_receipt"
    elif [[ -n "$prerun_base" && -n "$cur_base" && "$cur_base" != "$prerun_base" ]] &&
         git -C "$worktree" merge-base --is-ancestor "$prerun_base" "$cur_base" 2>/dev/null; then
      tests_range="${prerun_base}..${scanned_tip}"
      # the re-run selects over the BASE the pre-run saw and judges on this one; a BASE
      # runner that predates --judge-base (a consumer's older vendored copy) judges on the
      # range's start as before
      if grep -q -- '--judge-base' "$runner" 2>/dev/null; then
        judge_base="$cur_base"
      fi
      if [[ -n "$prerun_receipt" && -n "$cur_head" &&
            -z "$(git -C "$worktree" status --porcelain 2>/dev/null)" ]]; then
        prerun_moved="$( cd "$worktree" && landing_python - "${gate_dir}/tools" "$prerun_base" "$prerun_head" "$cur_base" "$cur_head" <<'PY' 2>/dev/null || true
import subprocess, sys
tools, pre_base, pre_head, cur_base, cur_head = sys.argv[1:6]
GIT = ["git", "-c", "core.quotepath=false"]


def names(a, b, *more):
    out = subprocess.run(GIT + ["diff", "--name-only", "-z", "--no-renames"] + list(more) + [a, b],
                         capture_output=True, check=True).stdout.decode("utf-8", "surrogateescape")
    return {p for p in out.split("\0") if p}


try:
    rng = names(pre_base, cur_base)
    ours = names(pre_base, pre_head) | names(cur_base, cur_head)
    # the tree under test is the one the pre-run saw, with only the paths of the range changed
    if rng & ours or not names(pre_head, cur_head) <= rng:
        raise SystemExit(0)
    # a range that deletes a path (--no-renames: the old side of a rename is a deletion) is
    # never records-only: the selection below cannot see a deletion, and a test the branch
    # adds may import what the range took away (secrev-pin-pre-run-reuse-ac-64e9, finding 2)
    if names(pre_base, cur_base, "--diff-filter=D"):
        raise SystemExit(0)
    # the selector and its map decide what every change owes: a move touching one is never
    # records-only, whatever the selection over it says
    if rng & {"tools/units.json", "tools/affected_tests.py", "tools/run_tests.py"}:
        raise SystemExit(0)
    sys.path.insert(0, tools)
    from affected_tests import GUARD_TABLES, Graph, is_guard, is_record, load_units, parse_table, select
    from pathlib import Path
    root = Path(".").resolve()
    # the gate tables of BASE, read from git: a guard path that is no record owes the full suite
    # (a security receipt under .security/audit-receipts/ is a record and stays harmless)
    guards = ()
    for rel, name in GUARD_TABLES:
        blob = subprocess.run(GIT + ["show", cur_base + ":" + rel], capture_output=True)
        if blob.returncode == 0:
            guards += parse_table(blob.stdout.decode("utf-8"), rel, name)
        elif subprocess.run(GIT + ["cat-file", "-e", cur_base + ":" + rel],
                            capture_output=True).returncode == 0:
            raise SystemExit(0)
    if any(is_guard(p, guards) and not is_record(p) for p in rng):
        raise SystemExit(0)
    tests, _why, full = select(Graph(root, load_units(root / "tools" / "units.json")), sorted(rng),
                               None, guards)
    if tests or full:
        raise SystemExit(0)
    n = subprocess.run(GIT + ["rev-list", "--count", pre_base + ".." + cur_base],
                       capture_output=True, text=True, check=True).stdout.strip()
    print(int(n))
except SystemExit:
    raise
except Exception:
    pass
PY
)"
        case "$prerun_moved" in
          ''|*[!0-9]*) ;;
          *)
            tests_from_prerun=yes
            if [[ "$prerun_moved" == "1" ]]; then
              prerun_moved_line="yes (base moved by 1 records-only commit)"
            else
              prerun_moved_line="yes (base moved by ${prerun_moved} records-only commits)"
            fi
            ;;
        esac
      fi
    elif [[ -n "$prerun_receipt" && "$cur_head" == "$prerun_head" && "$cur_base" == "$prerun_base" &&
            -z "$(git -C "$worktree" status --porcelain 2>/dev/null)" ]]; then
      tests_from_prerun=yes
    fi
    if [[ "$tests_from_prerun" == "yes" ]]; then
      rm -f "$report"
      report="$prerun_tmp"
      prerun_tmp=""
      rc=0
      if [[ -n "$prerun_moved_line" ]]; then
        echo "the affected tests ran before the landing lock; ${base} moved since only by records-only commits, so not running them again" >&2
      else
        echo "the affected tests ran before the landing lock on this very HEAD and ${base}; not running them again" >&2
      fi
    else
      # the branch's tests, with no push credential in reach (credless, above), the harness
      # isolated, and the CHILDREN walled but still able to reach the operator's optional
      # backend through PYTHONPATH (branch_tests_python). An in-lock gate to the gate pool:
      # served ahead of every pre-run (tools/gate_slots.py, THE ORDER); a BASE runner that
      # predates --gate-phase is called as before
      in_lock_phase_ok=""
      if grep -q -- '--gate-phase' "$runner" 2>/dev/null; then
        in_lock_phase_ok=yes
      fi
      # A background job in a process group of its own (`set -m` only around the launch),
      # waited for: a trapped TERM interrupts `wait` at once -- it would wait out a
      # foreground gate -- and land_gate_stop then signals the whole group. stdin is
      # /dev/null, so a gate outside the terminal's foreground group is never stopped
      # reading it.
      set +e
      set -m
      (
        sandbox_begin "$worktree" || exit 1
        trap 'sandbox_end' EXIT
        sandbox_child_env
        cd "$sandbox_clone" && branch_tests_python "$runner" --root "$sandbox_clone" --affected "$tests_range" --gate --json ${ISOLATED_SESSION_LAND_JOBS:+-j "$ISOLATED_SESSION_LAND_JOBS"} ${judge_base:+--judge-base "$judge_base"} ${reuse_receipt:+--reuse "$reuse_receipt"} ${in_lock_phase_ok:+--gate-phase in-lock --gate-holder "$branch"}
      ) < /dev/null > "$report" 2>"$tests_err" &
      gate_pid=$!
      set +m
      wait "$gate_pid"
      rc=$?
      gate_pid=""
      set -e
      # the runner's started_at (a BASE runner without it: no line), less the lock's take,
      # floored to whole minutes and never below 0
      lock_held_before_gate="$(landing_python - "$report" "${lock_taken_at:-}" <<'PY' || true
import json, sys
try:
    started = float(json.load(open(sys.argv[1])).get("started_at"))
    taken = int(sys.argv[2])
except Exception:
    sys.exit(0)
print(max(0, int((started - taken) // 60)))
PY
)"
      case "$lock_held_before_gate" in
        ''|*[!0-9]*) lock_held_before_gate="" ;;
      esac
      # the launcher's receipt the runner honoured ran nothing under the lock: the receipt
      # says so the way our own pre-run does, counting the commits BASE moved since it was
      # bound (the runner's harmless_base_move kept it current across them). A runner that
      # judged the move says how on `reuse_move`, and its TESTS_RECEIPT= line counts the
      # files the move changed and names the BASE the receipt was judged against; a code
      # move is never called records-only
      if [[ -n "$reuse_receipt" ]]; then
        reuse_lines="$(landing_python - "$report" "$worktree" "$cur_base" <<'PY' 2>/dev/null || true
import json, re, subprocess, sys
path, worktree, cur_base = sys.argv[1:4]
SHA = r"[0-9a-f]{40,64}"
try:
    d = json.load(open(path))
except Exception:
    sys.exit(0)
if not isinstance(d, dict) or d.get("reused") is not True:
    sys.exit(0)
old = (d.get("bound") or {}).get("base", "") if isinstance(d.get("bound"), dict) else ""
if not re.fullmatch(SHA, old or "") or old == cur_base:
    print("yes (the launcher's pre-run, on this very HEAD and BASE)")
    sys.exit(0)
move = d.get("reuse_move") if isinstance(d.get("reuse_move"), dict) else {}
code = move.get("kind") == "code-move"
try:
    n = int(subprocess.run(["git", "-C", worktree, "rev-list", "--count", old + ".." + cur_base],
                           capture_output=True, text=True, check=True).stdout.strip())
except Exception:
    print("yes (the launcher's pre-run)")
    n = None
if n is not None:
    print("yes (the launcher's pre-run; base moved by %d %s commit%s)"
          % (n, "code-move" if code else "records-only", "" if n == 1 else "s"))
files = move.get("files")
judged = move.get("base")
if (isinstance(files, int) and not isinstance(files, bool) and files >= 0
        and isinstance(judged, str) and re.fullmatch(SHA, judged) and move.get("from") == old):
    print("reused code-move %d file%s, judged against BASE %s, the pre-run on %s"
          % (files, "" if files == 1 else "s", judged, old))
PY
)"
        prerun_moved_line="${reuse_lines%%$'\n'*}"
        if [[ "$reuse_lines" == *$'\n'* ]]; then
          tests_receipt_line="${reuse_lines#*$'\n'}"
        fi
      fi
    fi
    if [[ -n "$prerun_tmp" ]]; then
      rm -f "$prerun_tmp"
      prerun_tmp=""
    fi
    # The tail of a failing file is the BRANCH's own output, so it is a name-the-diff-chose
    # sink like any other: it goes to a file as NUL-separated records and is escaped here,
    # rather than being printed raw from inside the summary
    # (ISSUE(security-audit-2026-09-18-daily-2026-09-18-4)).
    # BASE's own unit map, read from git, never from the tree: the receipt's TESTS_PARKED=
    # marks a parked file this map does not park, whichever runner BASE carries
    # (ISSUE(security-audit-2026-10-27-pin-parking-of-red-o-de38)). None to read is {}.
    base_units_map="$(finish_tmp)"
    git --git-dir="$git_common" show "${base}:tools/units.json" > "$base_units_map" 2>/dev/null || : > "$base_units_map"
    summary="$(landing_python - "$report" "$rc" "$tests_tail" "$base_units_map" <<'PY'
import json, sys, unicodedata
path, rc, tail_path, base_map = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
try:
    d = json.load(open(path))
except Exception:
    print("BROKEN\x1f\x1f\x1f\x1f\x1f\x1f")    # the read below splits on \x1f, never on a tab
    sys.exit(0)
files = d.get("files", [])
# red on BASE too (the runner re-ran it there once): counted as `red-on-base`, never as
# `fail`, and it does not refuse -- `fail` counts only the reds the branch caused
on_base = [x for x in (d.get("red_on_base") or []) if isinstance(x, str)]
counts = {}
for r in files:
    k = "red-on-base" if r["file"] in on_base else r["status"]
    counts[k] = counts.get(k, 0) + 1
# could-not-run is the verdict of the runner for a file behind a wall: counted on its
# own, never among the files that ran, and it refuses the landing like a red. A parked file
# (a units.json `parked` row) was not run and never refuses: counted `<n> parked`
line = ", ".join(f"{counts.get(k, 0)} {k}" for k in ("ok", "skip", "flaky", "fail", "timeout",
                                                     "could-not-run", "red-on-base", "parked")
                 if counts.get(k))
# a timeout is not a fail: a file killed at its budget is named with a " (timeout)" suffix,
# a failed one bare, and both refuse. timed_out is the list from the runner; a runner without it
# put timeouts on failed, and the per-file status still tells them apart
status = {r.get("file"): r.get("status") for r in files if isinstance(r, dict)}
timed_out = [x for x in (d.get("timed_out") or []) if isinstance(x, str)]
reds = []
for f in list(d.get("failed", [])) + [x for x in timed_out if x not in d.get("failed", [])]:
    reds.append(f + " (timeout)" if f in timed_out or status.get(f) == "timeout" else f)
failed = " ".join(reds)
unrun = " ".join(d.get("could_not_run", []))
names = " ".join(r["file"] for r in files)
# the files the gate ran once more after a timeout (a runner without it: none)
rerun = " ".join(x for x in (d.get("rerun") or []) if isinstance(x, str))
# the parked files, each marked ` (not parked on BASE)` when BASE's own map has no park row
# for that exact path. A name is the diff's choice: a line break in it is spelled out here,
# so it can neither end this record early nor start a receipt line (iso_safe_text after)
try:
    base_rows = json.load(open(base_map)).get("files")
except Exception:
    base_rows = {}
base_rows = base_rows if isinstance(base_rows, dict) else {}


def held(f):
    row = base_rows.get(f)
    why = row.get("parked") if isinstance(row, dict) else None
    return isinstance(why, str) and bool(why.strip())


def flat(text):
    return "".join(("\\x%02x" % ord(c) if ord(c) < 256 else "\\u%04x" % ord(c))
                   if unicodedata.category(c) in ("Cc", "Zl", "Zp") else c for c in text)


parked = " ".join(flat(f) + ("" if held(f) else " (not parked on BASE)")
                  for f in (d.get("parked") or []) if isinstance(f, str))
# unit separator, not a tab: bash `read` folds runs of IFS whitespace, so an empty
# `failed` column would shift the columns after it
print("\x1f".join([f"{line or '0 files'} (of {len(files)}; {d.get('selection', '')})",
                   str(d.get("wall_s", "")), failed, unrun, " ".join(on_base), parked, names,
                   rerun]))
with open(tail_path, "w", encoding="utf-8") as fh:
    for r in files:
        if r["status"] in ("fail", "timeout", "could-not-run"):
            fh.write(f"--- {r['file']}: {r['status']} {r.get('reason', '')}\0")
            for ln in r.get("tail", "").splitlines()[-15:]:
                fh.write("   | " + ln + "\0")
PY
)"
    rm -f "$base_units_map"
    IFS=$'\x1f' read -r tests_line tests_secs tests_failed tests_unrun tests_on_base tests_parked tests_files tests_rerun <<< "$summary"
    while IFS= read -r -d '' tail_rec; do
      [[ -n "$tail_rec" ]] || continue
      if ! tail_esc="$(iso_safe_text "$tail_rec")"; then
        echo "refusing to land ${branch}: a test's own output could not be printed safely -- python3 is on PATH and iso_safe_text could not run it." >&2
        rm -f "$report" "$tests_err" "$tests_tail"
        exit 1
      fi
      printf '%s\n' "$tail_esc" >&2
    done < "$tests_tail"
    rm -f "$tests_tail"
    if [[ "$tests_line" == "BROKEN" ]]; then
      { echo "refusing to land ${branch}: tools/run_tests.py gave no report:"; cat "$tests_err"; } >&2
      # a receipt as a red test's is, saying what it is not: no verdict at all
      echo "MERGED=no"
      echo "TESTS=no report (tools/run_tests.py exit ${rc})"
      receipt_tests="no report (tools/run_tests.py exit ${rc})"
      rm -f "$report" "$tests_err"
      refusal_category="tests"
      exit 1
    fi
    if [[ "$rc" != "0" ]]; then
      {
        echo "refusing to land ${branch}: ${tests_line}"
        [[ -z "$tests_failed" ]] || echo "red: $(iso_safe_text "$tests_failed")"
        [[ -z "$tests_on_base" ]] || echo "red on ${base} too (reported, not refusing): $(iso_safe_text "$tests_on_base")"
        if [[ -n "$tests_unrun" ]]; then
          # behind a wall: not a red, and not a pass -- the gate never got to judge these
          echo "could not run (this landing is behind a wall, so these are no verdict on the diff): $(iso_safe_text "$tests_unrun")"
          echo "The landing's gate belongs outside the wall: from a herd worker, the launcher runs it there."
        fi
        if [[ "$tests_from_wall" == "yes" ]]; then
          echo "The repair agent is asked before a person lands."
          say_what_moved quiet
        else
          say_what_moved
        fi
      } >&2
      # A refusal is a receipt too: the counted verdict goes on STDOUT with the rest of
      # the receipt's spelling, so a reader (a herd coordinator, a test) sees what the
      # landing actually measured instead of an empty stdout it has to interpret. MERGED=no
      # is what tells it apart from a landing; the exit status is still the contract.
      echo "MERGED=no"
      echo "TESTS=${tests_line}"
      receipt_tests="$tests_line"
      refusal_category="tests"
      if [[ -n "$tests_failed" ]]; then
        echo "TESTS_RED=$(iso_safe_text "$tests_failed")"
      fi
      if [[ -n "$tests_unrun" ]]; then
        echo "TESTS_COULD_NOT_RUN=$(iso_safe_text "$tests_unrun")"
      fi
      if [[ -n "$tests_on_base" ]]; then
        echo "TESTS_RED_ON_BASE=$(iso_safe_text "$tests_on_base")"
      fi
      if [[ -n "$tests_parked" ]]; then
        echo "TESTS_PARKED=$(iso_safe_text "$tests_parked")"
      fi
      # The refusal's class. `environment`: every suite that did not pass is one the room
      # refused (the runner measured a wall AND the suite carried the room's words), so
      # nothing here is a verdict on the diff. `red`: at least one ordinary failure or
      # timeout -- the diff's own, whatever else the room refused beside it. TESTS_RED= and
      # TESTS_COULD_NOT_RUN= never name the same file.
      if [[ -n "$tests_unrun" && -z "$tests_failed" ]]; then
        echo "TESTS_REFUSAL=environment"
      else
        echo "TESTS_REFUSAL=red"
      fi
      rm -f "$report" "$tests_err"
      exit 1
    fi
    rm -f "$report" "$tests_err"
    if [[ -n "$(git -C "$worktree" status --porcelain)" ]]; then
      {
        echo "refusing to land ${branch}: the tests left the tree dirty -- a test wrote into the checkout:"
        git -C "$worktree" status --porcelain
      } >&2
      refusal_category="tests"
      exit 1
    fi
  fi
fi
# the tree the tests ran in is the scanned tip's, and the scan below reads that sha
scanned_tip_hold "while its tests ran"
# ... and the gate the rest of this landing runs is still the copy it was handed
gate_dir_hold "after its tests ran"

# --- the deterministic security scan of the diff ----------------------------------
# tools/sec_lint.py reads the added lines and the touched paths and answers with one
# word. `refused` (a key, a token, a guard override) stops the landing exactly as a red
# test does; `needs-eyes` (the audited surface or a guard file changed) lands and owes
# a human review, which is spawned after the merge below; `clean` owes nothing.
#
# The lint that runs is BASE's, not the branch's: `git show BASE:tools/sec_lint.py`
# (and its audit_scope.py plus the generator siblings the rebuild runs) into this
# landing's gate-scratch directory (gate_scratch_ensure below), OUTSIDE the worktree
# the worker can write; it runs with the worktree as cwd -- the tool takes its
# repository from git rev-parse --show-toplevel of cwd, so from there `--diff`
# sees the branch.
# A branch that replaces the lint with one that answers `clean` is still scanned
# by the copy main had, and its replacement is a gate file (below), so it is
# needs-eyes on top. A BASE without the tool says SEC=none; the branch's copy is
# never the fallback. The rebuild runs THESE copies against the revision's data,
# never the revision's tools/ (ISSUE(scanner-executes-scanned-revision)).
#
# EVERY COMMIT of the range is judged, one lint run per commit (`c^..c`; a merge is linted
# against every parent, and its touched paths are taken against every parent), as the publisher judges them (muretai-publish.py `evaluate`). The
# scan used to run ONCE over the net diff `BASE..HEAD`, so a commit that added a refused
# line and a later commit of the same branch that rewrote it landed `clean` -- f6b03cee
# went onto main that way, and only the publisher, asking the per-commit question, refused
# it and then held trunk (ISSUE(landing-and-publisher-asked-different-questions)). A
# refusal in any commit refuses the landing and names that commit's short sha; a later
# commit never excuses it -- the branch is rebased or amended instead. The verdict is the
# worst of the commits' verdicts, the review list the union of theirs, and the SCANNED
# list the union of every path any commit touched, printed on the receipt
# (SEC_SCANNED= / SEC_SCANNED_FILES=) so it is read, not inferred. The gate list is taken
# from that same union, so a gate file edited in one commit and restored in the next is
# still a gate change. A range that touches no path says `nothing-to-scan`, never `clean`.
#
# $1 the checkout to run in, $2 the lint, $3 the range's base; writes the aggregate JSON
# (the lint's own shape plus `scanned_files`, `commits`, `broken`) to $4 and the scanned
# paths, NUL-separated and as git spelled them, to $5. $6, when given, is the tip of the
# range (the scanned tip); HEAD otherwise. Non-zero only when it could not run.
sec_scan_commits() {  # $1 cwd, $2 lint, $3 base rev, $4 json out, $5 paths out, $6 tip rev
  ( cd "$1" && landing_python - "$2" "$3" "$4" "$5" "${6:-HEAD}" <<'PY'
import json, subprocess, sys
lint, base, out_json, out_paths, tip = sys.argv[1:6]
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
GIT = ["git", "-c", "core.quotepath=false"]

def git_out(*args):
    return subprocess.run(GIT + list(args), capture_output=True, check=True).stdout

commits = git_out("rev-list", "--reverse", "--topo-order", base + ".." + tip).decode().split()
scanned, review, findings, seen, broken, refused_in = {}, set(), [], set(), [], []
verdicts = set()
def changed(a, b):
    return [p for p in git_out("diff", "--name-only", "-z", "--no-renames", "--diff-filter=ACMRDT",
                               a, b).split(b"\0") if p]

for c in commits:
    parents = git_out("rev-list", "--parents", "-n", "1", c).decode().split()[1:]
    parent = c + "^" if parents else EMPTY_TREE
    touched = changed(parent, c)
    # a merge is diffed against EACH parent for its paths: a resolution that puts back the
    # branch's copy of a gate file main changed differs from its first parent on nothing,
    # so a first-parent diff never named it and an undone guard landed clean
    # (ISSUE(security-audit-2026-10-09-a-branch-that-merged-68d6)). The lint judges the
    # first-parent diff, as the publisher does, AND the merge against each other parent: a
    # resolution that puts back the branch's copy of an audited file that is no gate file
    # (tools/release_sign.py) undoes main's fix with no line of the first-parent diff, and
    # only that other-parent diff shows it to the audited-surface rule; the same diff
    # brings back any line a newer line rule would refuse (intake 20261009T235603Z-2). The
    # verdicts, review lists and findings of every run of the commit are one union.
    for other in parents[1:]:
        touched += [p for p in changed(other, c) if p not in touched]
    if not touched:
        continue                     # an empty commit: nothing of it to judge
    for p in touched:
        scanned.setdefault(p, None)
    for side in [parent] + parents[1:]:
        r = subprocess.run([sys.executable, "-I", lint, "--diff", side + ".." + c, "--json"],
                           capture_output=True, text=True)
        try:
            d = json.loads(r.stdout)
            verdict = str(d["verdict"])
        except (ValueError, KeyError, TypeError):
            broken.append("%s: %s" % (c[:7], (r.stderr.strip() or "no JSON from the lint")[-300:]))
            continue
        if r.returncode == 2 and verdict != "refused":
            verdict = "refused"          # the exit code is the contract; the word must agree
        if verdict not in ("clean", "needs-eyes", "refused"):
            broken.append("%s: the lint said %r" % (c[:7], verdict))
            continue
        verdicts.add(verdict)
        if verdict == "refused" and c[:7] not in refused_in:
            refused_in.append(c[:7])
        review.update(str(f) for f in (d.get("review_files") or d.get("audited_files", [])))
        for f in d.get("findings", []):
            key = (f.get("file"), f.get("line"), f.get("rule"), f.get("level"), f.get("text"))
            if key in seen:
                continue                 # the same finding again in a later run: named once, first commit
            seen.add(key)
            f = dict(f)
            f["commit"] = c[:7]
            findings.append(f)
# refused outranks broken: a range with a refused commit is refused whatever else it
# holds, and a broken commit in it is still named in `broken`
if "refused" in verdicts:
    verdict = "refused"
elif broken:
    verdict = "broken"
elif "needs-eyes" in verdicts:
    verdict = "needs-eyes"
elif scanned:
    verdict = "clean"
else:
    verdict = "nothing-to-scan"
findings.sort(key=lambda f: (0 if f.get("level") == "refuse" else 1, str(f.get("file")), f.get("line") or 0))
names = sorted(p.decode("utf-8", "replace") for p in scanned)
with open(out_json, "w", encoding="utf-8") as fh:
    json.dump({"verdict": verdict, "review_files": sorted(review), "findings": findings,
               "scanned_files": names, "commits": len(commits), "refused_in": refused_in,
               "broken": broken}, fh)
# the paths file, which the gate table is asked about, is that union plus the net diff
# base..tip, each path once
gate_paths = dict(scanned)
if commits:
    for p in changed(base, tip):
        gate_paths.setdefault(p, None)
with open(out_paths, "wb") as fh:
    for p in sorted(gate_paths):
        fh.write(p + b"\0")
PY
  )
}

# BASE's lint and invariant copies are built under this landing's gate-scratch directory
# (lib.sh's iso_gate_scratch_dir: mode 700, under a root every wall denies), never in the
# worktree: the wall lets the worker write its worktree, and a poller it left behind could
# swap BASE's sec_lint.py or plant its bytecode there while this landing runs it, forging
# SEC= and INV= as the operator (review secrev-the-gate-copy-takes-0f58). The copies keep
# their .sec-base- / .inv-base- names inside it. A root that is a symlink, or anything else
# iso_gate_scratch_dir refuses, refuses the landing; nothing falls back into the worktree.
# Called in this shell, never in a `$( )`: it sets gate_scratch, which cleanup() removes.
gate_scratch_ensure() {
  [[ -z "$gate_scratch" ]] || return 0
  if ! gate_scratch="$(iso_gate_scratch_dir "land-$(date +%s)-$$")" || [[ -z "$gate_scratch" ]]; then
    gate_scratch=""
    echo "error: refusing to land ${branch}: no private gate-scratch directory for BASE's gate copies (see above); nothing was built in the worktree" >&2
    return 1
  fi
}

# BASE's gate table over the NUL-separated paths in $2, asked of the lint at $1
# (`--gate-files`). Appends what it names to gate_files. The answer is data: NUL-terminated
# records, read and never evaluated. This used to end in `|| true`, so a step that exited
# non-zero, died by a signal, or answered with anything but NUL-terminated records (the
# last, unterminated record was dropped by `read -d ''`) read as "no gate file" and a clean
# diff skipped its reviewer (IB:52982). A failed step now fails closed as a review OWED,
# not a refusal -- a broken table must not stop every landing, and must never skip a
# review: every path of $2 is put on gate_files (none can be cleared) and
# gate_files_failed says why, with the step's own stderr cut to its last 300 bytes and
# escaped. Called in this shell, never in a `$( )`: it sets globals.
gate_files_failed=""
gate_files_ask() {  # $1 lint, $2 NUL-separated paths
  local out err rc=0 why="" tail_err="" last f
  out="$(finish_tmp)"
  err="$(finish_tmp)"
  landing_python "$1" --gate-files < "$2" > "$out" 2> "$err" || rc=$?
  if [[ "$rc" -gt 128 ]]; then
    why="it was killed by signal $(( rc - 128 ))"
  elif [[ "$rc" != "0" ]]; then
    why="it exited ${rc}"
  elif [[ -s "$out" ]]; then
    last="$(tail -c 1 "$out" | od -An -tx1 | tr -d ' \n')"
    [[ "$last" == "00" ]] || why="its answer is not NUL-terminated records"
  fi
  if [[ -z "$why" ]]; then
    while IFS= read -r -d '' f; do
      [[ -n "$f" ]] || continue
      gate_files="${gate_files}${gate_files:+ }${f}"
    done < "$out"
    rm -f "$out" "$err"
    return 0
  fi
  if [[ -s "$err" ]]; then
    tail_err="$(tail -c 300 "$err")"
    tail_err="$(iso_safe_text "$tail_err")" || tail_err="(its stderr could not be printed safely)"
    why="${why}: ${tail_err}"
  fi
  rm -f "$out" "$err"
  gate_files_failed="tools/sec_lint.py --gate-files failed (${why}), so no path of the diff is cleared as not a gate file"
  while IFS= read -r -d '' f; do
    [[ -n "$f" ]] || continue
    case " $gate_files " in
      *" $f "*) ;;
      *) gate_files="${gate_files}${gate_files:+ }${f}" ;;
    esac
  done < "$2"
  echo "warning: ${gate_files_failed}; the landing owes a review" >&2
}

sec_line="none (base has no tools/sec_lint.py)"
sec_verdict="none"
sec_scanned_line=""
sec_files=""
sec_findings=""
sec_gate=""
gate_files=""
# a branch that removes the scan or the receipt tool would turn this gate off for every
# later landing (SEC=none): refused here, before BASE's lint even runs
# (ISSUE(security-audit-2026-09-12-the-reviewer-opens-in-a-c-2))
for keep in tools/sec_lint.py tools/audit_scope.py; do
  if git -C "$worktree" cat-file -e "${base}:${keep}" 2>/dev/null &&
     ! git -C "$worktree" cat-file -e "${scanned_tip}:${keep}" 2>/dev/null; then
    echo "error: refusing to land ${branch}: it removes ${keep}, which every later landing's security gate runs" >&2
    exit 1
  fi
done
# appl.toml's [scan] command, delivered by bin/appl and matched against the primary's
# appl.toml above, is the scan IN PLACE OF tools/sec_lint.py's per-commit diff scan: run
# once with the worktree under test as its cwd, walled like the branch's tests, and its
# exit code is the verdict -- a non-zero exit refuses the landing (SEC=refused), as a
# refusing lint would. BASE's lint still runs per commit first, for its refuse set only:
# a refuse-level finding in any commit refuses the landing whatever the command would
# say (below). The gate-file rule still holds: BASE's lint's own table
# (`--gate-files`, which scans nothing) over the union of the paths every commit touched,
# so a diff that changes a gate file lands needs-eyes whatever the command said.
if [[ -n "$scan_command" ]]; then
  scan_command_text="$(iso_safe_text "$scan_command")"
  sec_paths="$(finish_tmp)"
  sec_paths_all="$(finish_tmp)"
  for sc_c in $(git -C "$worktree" rev-list --reverse --topo-order "${base}..${scanned_tip}"); do
    # every parent of a merge, as sec_scan_commits diffs it
    sc_parents="$(git -C "$worktree" rev-list --parents -n 1 "$sc_c" | cut -d' ' -f2-)"
    [[ "$sc_parents" != "$sc_c" ]] || sc_parents="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    for sc_parent in $sc_parents; do
      git -C "$worktree" -c core.quotepath=false diff --name-only -z --no-renames --diff-filter=ACMRDT \
        "$sc_parent" "$sc_c" >> "$sec_paths_all"
    done
  done
  # plus the net diff, each path once (sort -u below)
  git -C "$worktree" -c core.quotepath=false diff --name-only -z --no-renames --diff-filter=ACMRDT \
    "${base}..${scanned_tip}" >> "$sec_paths_all"
  sort -z -u < "$sec_paths_all" > "$sec_paths"
  rm -f "$sec_paths_all"
  sec_scanned_n=0
  sec_scanned_files=""
  while IFS= read -r -d '' f; do
    [[ -n "$f" ]] || continue
    sec_scanned_n=$(( sec_scanned_n + 1 ))
    sec_scanned_files="${sec_scanned_files}${sec_scanned_files:+ }${f}"
  done < "$sec_paths"
  sec_scanned_line="SEC_SCANNED=${sec_scanned_n}"$'\n'"SEC_SCANNED_FILES=$(iso_safe_text "$sec_scanned_files")"
  if git --git-dir="$git_common" cat-file -e "${base}:tools/sec_lint.py" 2>/dev/null; then
    gate_scratch_ensure || exit 1
    sec_base="$(mktemp -d "${gate_scratch}/.sec-base-XXXXXX")"
    mkdir -p "$sec_base/tools" "$sec_base/company/ops"
    git --git-dir="$git_common" show "${base}:tools/sec_lint.py" > "$sec_base/tools/sec_lint.py"
    for extra in tools/audit_scope.py tools/ledger.py tools/backlog_build.py \
                 tools/spec_build.py company/ops/backlog_to_core.py; do
      if git --git-dir="$git_common" cat-file -e "${base}:${extra}" 2>/dev/null; then
        mkdir -p "$sec_base/$(dirname "$extra")"
        git --git-dir="$git_common" show "${base}:${extra}" > "$sec_base/${extra}"
      fi
    done
    # The command replaces the lint's VERDICT on the diff, never its per-commit refuse
    # check: a refuse-level finding in any commit of the range is a commit the publisher
    # refuses for good (it judges every commit, the same refuse set), so it is refused
    # here first, before the command runs, naming the commit and the file. A key added
    # and deleted inside the branch is still in a commit; needs-eyes is not brought in
    # (ISSUE(refuse-level-secret-in-a-branch-commit-reached-main)).
    sc_report="$(finish_tmp)"
    sc_paths="$(finish_tmp)"
    sc_find_file="$(finish_tmp)"
    set +e
    sec_scan_commits "$worktree" "$sec_base/tools/sec_lint.py" "$base" "$sc_report" "$sc_paths" "$scanned_tip" 2>/dev/null
    sc_lint_rc=$?
    set -e
    rm -f "$sc_paths"
    sc_head="$(landing_python - "$sc_report" "$sc_lint_rc" "$sc_find_file" <<'PY'
import json, sys
path, rc, findings_path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    if rc != 0:
        raise ValueError("the per-commit scan did not run")
    d = json.load(open(path))
    verdict = str(d["verdict"])
except Exception:
    print("broken\x1f")
    sys.exit(0)
broken = [str(b) for b in d.get("broken", [])]
print("\x1f".join([verdict, " ".join(d.get("refused_in", []))]))
with open(findings_path, "w", encoding="utf-8") as fh:
    for b in broken:
        fh.write("   " + b + "\0")
    for f in d.get("findings", []):
        if f.get("level") != "refuse":
            continue                 # only the refuse set; needs-eyes is left to the command
        where = f.get("file", "?") if not f.get("line") else f"{f.get('file', '?')}:{f.get('line')}"
        fh.write(f"   {where}: [refuse] {f.get('rule', '')}: {f.get('text', '')}"
                 f" (commit {f.get('commit', '?')})\0")
PY
)" || sc_head="broken"$'\x1f'
    rm -f "$sc_report"
    IFS=$'\x1f' read -r sc_lint_verdict sc_refused_in <<< "$sc_head"
    if [[ "$sc_lint_verdict" == "refused" || "$sc_lint_verdict" == "broken" ]]; then
      sc_findings=""
      while IFS= read -r -d '' sec_rec; do
        [[ -n "$sec_rec" ]] || continue
        if ! sec_esc="$(iso_safe_text "$sec_rec")"; then
          echo "refusing to land ${branch}: a lint finding could not be printed safely -- python3 is on PATH and iso_safe_text could not run it." >&2
          rm -f "$sc_find_file"
          exit 1
        fi
        sc_findings="${sc_findings}${sec_esc}"$'\n'
      done < "$sc_find_file"
      rm -f "$sc_find_file"
      rm -rf "$sec_base"
      if [[ "$sc_lint_verdict" == "refused" ]]; then
        {
          echo "refusing to land ${branch}: tools/sec_lint.py refused commit(s) $(iso_safe_text "${sc_refused_in:-?}") of the range -- appl.toml's [scan] command replaces the diff verdict, never this per-commit refuse check:"
          [[ -n "$sc_findings" ]] && printf '%s' "$sc_findings"
          echo "Every commit is judged on its own, as the publisher judges it: a later commit that"
          echo "removes the line does not excuse the one that added it. Rebase or amend the branch"
          echo "so no commit carries it (git rebase -i ${base}), then run finish again."
          say_what_moved
        } >&2
        echo "MERGED=no"
        echo "SEC=refused (in commit(s) $(iso_safe_text "${sc_refused_in:-?}"); before appl.toml [scan] command)"
        receipt_sec="refused (in commit(s) $(iso_safe_text "${sc_refused_in:-?}"); before appl.toml [scan] command)"
      else
        {
          echo "refusing to land ${branch}: tools/sec_lint.py gave no verdict for a commit of the range, so the per-commit refuse check (which runs before appl.toml's [scan] command) could not clear it:"
          [[ -n "$sc_findings" ]] && printf '%s' "$sc_findings"
        } >&2
        echo "MERGED=no"
        echo "SEC=no-verdict"
        receipt_sec="no-verdict"
      fi
      printf '%s\n' "$sec_scanned_line"
      refusal_category="sec"
      exit 1
    fi
    rm -f "$sc_find_file"
    gate_files_ask "$sec_base/tools/sec_lint.py" "$sec_paths"
    rm -rf "$sec_base"
  else
    for keep in tools/sec_lint.py tools/audit_scope.py; do
      if [[ -n "$(git -C "$worktree" diff --name-only --no-renames --diff-filter=ACMRDT "${base}..${scanned_tip}" -- "$keep")" ]]; then
        gate_files="${gate_files}${gate_files:+ }${keep}"
      fi
    done
  fi
  rm -f "$sec_paths"
  echo "running appl.toml's [scan] command for ${branch}: ${scan_command_text}" >&2
  set +e
  ( cd "$worktree" && credless bash -c "$scan_command" ) < /dev/null >&2
  sc_rc=$?
  set -e
  if [[ "$sc_rc" != "0" ]]; then
    {
      echo "refusing to land ${branch}: appl.toml's [scan] command exited ${sc_rc}"
      say_what_moved
    } >&2
    echo "MERGED=no"
    echo "SEC=refused (${scan_command_text}: appl.toml [scan] command; exit ${sc_rc})"
    receipt_sec="refused (${scan_command_text}: appl.toml [scan] command; exit ${sc_rc})"
    printf '%s\n' "$sec_scanned_line"
    refusal_category="sec"
    exit 1
  fi
  if [[ -n "$(git -C "$worktree" status --porcelain)" ]]; then
    {
      echo "refusing to land ${branch}: the scan command left the tree dirty -- it wrote into the checkout:"
      git -C "$worktree" status --porcelain
    } >&2
    refusal_category="sec"
    exit 1
  fi
  sec_verdict="clean"
  sec_line="${scan_command_text} (appl.toml [scan] command; exit 0)"
  if [[ -n "$gate_files" || -n "$gate_files_failed" ]]; then
    sec_verdict="needs-eyes"
    sec_files="$gate_files"
    sec_count=0
    for f in $sec_files; do sec_count=$(( sec_count + 1 )); done
    if [[ -n "$gate_files_failed" ]]; then
      sec_line="${sec_line}; needs-eyes (${sec_count} file(s) to review: $(iso_safe_text "$sec_files"); the gate-files step failed)"
      echo "note: ${gate_files_failed}, so it is needs-eyes whatever the scan command said" >&2
    else
      sec_line="${sec_line}; needs-eyes (${sec_count} file(s) to review: $(iso_safe_text "$sec_files"); gate files changed)"
      echo "note: the diff changes gate file(s), so it is needs-eyes whatever the scan command said: $(iso_safe_text "$gate_files")" >&2
    fi
  fi
elif git --git-dir="$git_common" cat-file -e "${base}:tools/sec_lint.py" 2>/dev/null; then
  gate_scratch_ensure || exit 1
  sec_base="$(mktemp -d "${gate_scratch}/.sec-base-XXXXXX")"
  mkdir -p "$sec_base/tools" "$sec_base/company/ops"
  git --git-dir="$git_common" show "${base}:tools/sec_lint.py" > "$sec_base/tools/sec_lint.py"
  for extra in tools/audit_scope.py tools/ledger.py tools/backlog_build.py \
               tools/spec_build.py company/ops/backlog_to_core.py; do
    if git --git-dir="$git_common" cat-file -e "${base}:${extra}" 2>/dev/null; then
      mkdir -p "$sec_base/$(dirname "$extra")"
      git --git-dir="$git_common" show "${base}:${extra}" > "$sec_base/${extra}"
    fi
  done
  sec_report="$(finish_tmp)"
  sec_err="$(finish_tmp)"
  sec_find_file="$(finish_tmp)"
  sec_paths="$(finish_tmp)"
  set +e
  sec_scan_commits "$worktree" "$sec_base/tools/sec_lint.py" "$base" "$sec_report" "$sec_paths" "$scanned_tip" 2>"$sec_err"
  sec_rc=$?
  set -e
  # the gate list, from BASE's table, over the SAME union the scan judged (every path
  # any commit touched). NUL-separated and never quoted: with git's default quotepath a
  # non-ASCII name arrives octal-quoted and matches no entry (the LONG S case);
  # deletions, renames (as D + A) and type changes included
  if [[ "$sec_rc" == "0" ]]; then
    gate_files_ask "$sec_base/tools/sec_lint.py" "$sec_paths"
  fi
  rm -f "$sec_paths"
  rm -rf "$sec_base"
  # The findings go to a file as NUL-separated records, not down the same stream as the
  # summary: a finding's `file` and `text` come straight out of the lint, which reads paths
  # as raw bytes, and `bad_path_reason` refuses bytes below 0x20 and 0x7F but not U+009B,
  # U+202E or U+2028. Split on newlines first, those fields could both repaint the line and
  # fabricate another (ISSUE(security-audit-2026-09-18-daily-2026-09-18-4)).
  sec_summary="$(landing_python - "$sec_report" "$sec_rc" "$sec_find_file" <<'PY'
import json, sys
path, rc, findings_path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    if rc != 0:
        raise ValueError("the per-commit scan did not run")
    d = json.load(open(path))
    verdict = str(d["verdict"])
    if verdict == "broken":
        raise ValueError("a commit got no verdict")
except Exception:
    print("BROKEN\x1f0\x1f\x1f0\x1f\x1f")
    sys.exit(0)
# review_files (the audited surface + guard files + files with an eyes-level line), the
# union over the commits, is what the reviewer opens
files = [str(f) for f in d.get("review_files", [])]
scanned = [str(f) for f in d.get("scanned_files", [])]
# unit separator (see the tests summary above)
print("\x1f".join([verdict, str(len(files)), " ".join(files), str(len(scanned)), " ".join(scanned),
                   " ".join(d.get("refused_in", []))]))
with open(findings_path, "w", encoding="utf-8") as fh:
    for f in d.get("findings", []):
        where = f.get("file", "?") if not f.get("line") else f"{f.get('file', '?')}:{f.get('line')}"
        fh.write(f"   {where}: [{f.get('level', '?')}] {f.get('rule', '')}: {f.get('text', '')}"
                 f" (commit {f.get('commit', '?')})\0")
PY
)"
  sec_head="${sec_summary%%$'\n'*}"
  sec_findings=""
  while IFS= read -r -d '' sec_rec; do
    [[ -n "$sec_rec" ]] || continue
    if ! sec_esc="$(iso_safe_text "$sec_rec")"; then
      echo "refusing to land ${branch}: a lint finding could not be printed safely -- python3 is on PATH and iso_safe_text could not run it." >&2
      rm -f "$sec_report" "$sec_err" "$sec_find_file"
      exit 1
    fi
    sec_findings="${sec_findings}${sec_esc}"$'\n'
  done < "$sec_find_file"
  rm -f "$sec_find_file"
  IFS=$'\x1f' read -r sec_verdict sec_count sec_files sec_scanned_n sec_scanned_files sec_refused_in <<< "$sec_head"
  # what was scanned, on the receipt whatever the verdict: every path any commit touched
  sec_scanned_line="SEC_SCANNED=${sec_scanned_n:-0}"$'\n'"SEC_SCANNED_FILES=$(iso_safe_text "${sec_scanned_files:-}")"
  # a gate file changed: needs-eyes whatever the lint said (a refusal stays a refusal),
  # and the reviewer opens those files too
  if [[ -n "$gate_files" || -n "$gate_files_failed" ]]; then
    case "$sec_verdict" in
      clean|needs-eyes)
        sec_verdict="needs-eyes"
        for f in $gate_files; do
          case " $sec_files " in
            *" $f "*) ;;
            *) sec_files="${sec_files}${sec_files:+ }${f}" ;;
          esac
        done
        sec_count=0
        for f in $sec_files; do sec_count=$(( sec_count + 1 )); done
        sec_gate="; gate files changed"
        [[ -z "$gate_files_failed" ]] || sec_gate="; the gate-files step failed"
        ;;
    esac
  fi
  case "$sec_verdict" in
    clean)
      sec_line="clean"
      ;;
    nothing-to-scan)
      # no commit of the range touched a path: nothing was judged, which is not "clean"
      sec_line="nothing-to-scan"
      ;;
    needs-eyes)
      # sec_files stays as git spelled it -- the brief and the reviewer's checkout need
      # the real names -- and only the RECEIPT LINE is spelled out
      sec_line="needs-eyes (${sec_count} file(s) to review: $(iso_safe_text "$sec_files")${sec_gate})"
      if [[ -n "$sec_findings" ]]; then
        # already escaped, one record per line, with its own trailing newline
        { echo "note: tools/sec_lint.py wants eyes on:"; printf '%s' "$sec_findings"; } >&2
      fi
      if [[ -n "$gate_files_failed" ]]; then
        echo "note: ${gate_files_failed}, so it is needs-eyes whatever the lint said" >&2
      elif [[ -n "$gate_files" ]]; then
        echo "note: the diff changes gate file(s), so it is needs-eyes whatever the lint said: $(iso_safe_text "$gate_files")" >&2
      fi
      ;;
    refused)
      {
        echo "refusing to land ${branch}: tools/sec_lint.py refused the diff, in commit(s) $(iso_safe_text "${sec_refused_in:-?}") of the range:"
        [[ -n "$sec_findings" ]] && printf '%s' "$sec_findings"
        echo "Every commit is judged on its own, as the publisher judges it: a later commit that"
        echo "removes the line does not excuse the one that added it, because that commit would"
        echo "still be in ${base}'s history. Rebase or amend the branch so no commit carries it"
        echo "(git rebase -i ${base}), then run finish again."
        say_what_moved
      } >&2
      # a refusal is a receipt too (as a red test's is): what the landing measured, on stdout
      echo "MERGED=no"
      echo "SEC=refused (in commit(s) $(iso_safe_text "${sec_refused_in:-?}"))"
      receipt_sec="refused (in commit(s) $(iso_safe_text "${sec_refused_in:-?}"))"
      printf '%s\n' "$sec_scanned_line"
      rm -f "$sec_report" "$sec_err"
      refusal_category="sec"
      exit 1
      ;;
    *)
      { echo "refusing to land ${branch}: tools/sec_lint.py gave no verdict for a commit of the range:"
        landing_python - "$sec_report" <<'PY' 2>/dev/null || true
import json, sys
try:
    for b in json.load(open(sys.argv[1])).get("broken", []):
        print("   " + str(b))
except Exception:
    pass
PY
        cat "$sec_err"; } >&2
      echo "MERGED=no"
      echo "SEC=no-verdict"
      receipt_sec="no-verdict"
      rm -f "$sec_report" "$sec_err"
      refusal_category="sec"
      exit 1
      ;;
  esac
  rm -f "$sec_report" "$sec_err"
else
  # no lint, so no table -- but a diff that brings the scan tools themselves is said,
  # because those two names are the one thing this script knows about the gate
  for keep in tools/sec_lint.py tools/audit_scope.py; do
    if [[ -n "$(git -C "$worktree" diff --name-only --no-renames --diff-filter=ACMRDT "${base}..${scanned_tip}" -- "$keep")" ]]; then
      gate_files="${gate_files}${gate_files:+ }${keep}"
    fi
  done
  if [[ -n "$gate_files" ]]; then
    echo "note: ${base} has no tools/sec_lint.py, so the diff was not scanned; it changes gate file(s): $(iso_safe_text "$gate_files")" >&2
  fi
fi

# --- the invariant gate, beside the lint ------------------------------------------
# BASE's tools/invariants.py, with BASE's sec_lint.py beside it (the table lives there,
# not in the tree being judged). A BASE without the tool is INV=none and is not a
# refusal, the same shape as SEC=none. refused stops the landing before the merge.
# Fail closed: when BASE's tree names the checker (or the table) but the entry is not a
# blob that can be read, the landing is refused -- it is never "no tool", and the
# branch's copy is never run or read in its place.
inv_refuse_unreadable() {
  echo "refusing to land ${branch}: ${base}'s $1 cannot be read, so the invariant gate cannot judge the diff." >&2
  say_what_moved
  echo "MERGED=no"
  echo "INV=refused"
  exit 1
}
# prints BASE's tree entry for $1 ("<mode> <type> <sha>"), or nothing when BASE has none
inv_base_entry() {
  git --git-dir="$git_common" ls-tree "$base" -- "$1" 2>/dev/null | awk -F '\t' 'NR == 1 { print $1 }'
}
# copies BASE's blob $1 to $2; refuses when the entry is not a readable regular blob
inv_base_copy() {
  local entry
  entry="$(inv_base_entry "$1")"
  case "$entry" in
    100644\ blob\ *|100755\ blob\ *) ;;
    *) inv_refuse_unreadable "$1" ;;
  esac
  if ! git --git-dir="$git_common" cat-file blob "${entry##* }" > "$2" 2>/dev/null; then
    inv_refuse_unreadable "$1"
  fi
}
inv_line="none"
if [[ -n "$(inv_base_entry tools/invariants.py)" ]]; then
  gate_scratch_ensure || exit 1
  inv_base="$(mktemp -d "${gate_scratch}/.inv-base-XXXXXX")"
  mkdir -p "$inv_base/tools"
  inv_base_copy tools/invariants.py "$inv_base/tools/invariants.py"
  if [[ -n "$(inv_base_entry tools/sec_lint.py)" ]]; then
    inv_base_copy tools/sec_lint.py "$inv_base/tools/sec_lint.py"
  fi
  inv_out="$(finish_tmp)"
  inv_err="$(finish_tmp)"
  set +e
  ( cd "$worktree" && landing_python "$inv_base/tools/invariants.py" --diff "${base}..${scanned_tip}" --json >"$inv_out" 2>"$inv_err" )
  inv_rc=$?
  set -e
  inv_meta="$(landing_python - "$inv_out" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.stdout.write("refused\x1f\x1fthe gate printed no verdict")
    raise SystemExit(0)
changed = d.get("changed") or []
why = [str(n) for n in (d.get("notes") or [])]
for guard, marks in sorted((d.get("results_by_guard") or {}).items()):
    why.extend("%s %s: %s" % (guard, k, v) for k, v in sorted(marks.items()) if v != "pass")
sys.stdout.write(str(d.get("verdict") or "refused") + "\x1f" + " ".join(str(p) for p in changed)
                 + "\x1f" + "; ".join(why))
PY
)"
  inv_verdict="${inv_meta%%$'\x1f'*}"
  inv_rest="${inv_meta#*$'\x1f'}"
  inv_changed="${inv_rest%%$'\x1f'*}"
  inv_why="${inv_rest#*$'\x1f'}"
  if [[ -z "$inv_why" && -s "$inv_err" ]]; then
    inv_why="$(tail -n 3 "$inv_err" | tr '\n' ' ')"
  fi
  rm -rf "$inv_base"
  rm -f "$inv_out" "$inv_err"
  case "$inv_verdict" in
    clean|needs-eyes) ;;
    *) inv_verdict="refused" ;;
  esac
  if [[ "$inv_rc" != "0" ]]; then
    inv_verdict="refused"
  fi
  if [[ "$inv_verdict" == "refused" ]]; then
    echo "refusing to land ${branch}: tools/invariants.py refused the diff." >&2
    say_what_moved
    if [[ -n "$inv_why" ]] && inv_why_safe="$(iso_safe_text "$inv_why")"; then
      echo "  why: ${inv_why_safe}" >&2
    fi
    echo "MERGED=no"
    echo "INV=refused"
    exit 1
  fi
  if [[ "$inv_verdict" == "needs-eyes" && -n "$inv_changed" ]]; then
    if ! inv_changed_safe="$(iso_safe_text "$inv_changed")"; then
      echo "refusing to land ${branch}: an invariant path could not be printed safely." >&2
      echo "MERGED=no"
      echo "INV=refused"
      exit 1
    fi
    inv_line="needs-eyes (${inv_changed_safe})"
  else
    inv_line="$inv_verdict"
  fi
fi

# --- the ledgers, regenerated on the tip ------------------------------------------
# appl.toml's [ledger] command, delivered by bin/appl and matched against the primary's
# appl.toml above, is the build IN PLACE OF tools/ledger.py build: run once with the
# worktree as its cwd, walled like the branch's tests, and its exit code is the verdict.
# A non-zero exit refuses the landing (LEDGER_REFUSAL=<code>, MERGED=no) and leaves main
# and the worktree as they were. A root with no tools/ledger.py stays LEDGER=none and
# the command does not run, trusted or not.
ledger_line="none (no tools/ledger.py in this repository)"
if [[ -f "$ledger_tool" ]]; then
  if [[ -n "$ledger_command" ]]; then
    ledger_command_text="$(iso_safe_text "$ledger_command")"
    echo "running appl.toml's [ledger] command for ${branch}: ${ledger_command_text}" >&2
    set +e
    ( cd "$worktree" && credless bash -c "$ledger_command" ) < /dev/null >&2
    lc_rc=$?
    set -e
    if [[ "$lc_rc" != "0" ]]; then
      {
        echo "refusing to land ${branch}: appl.toml's [ledger] command exited ${lc_rc}"
        say_what_moved
      } >&2
      echo "MERGED=no"
      echo "LEDGER_REFUSAL=${lc_rc}"
      refusal_category="ledger"
      exit 1
    fi
    if [[ -n "$(git -C "$worktree" status --porcelain)" ]]; then
      scanned_tip_hold "while its ledger was regenerated"
      git -C "$worktree" add -A -- $generated 2>/dev/null || git -C "$worktree" add -A
      git -C "$worktree" commit -q -m "ledger: regenerate on landing ${branch}"
      scanned_tip_follow
    fi
    # the safe text of a command with nothing to escape is the command itself
    ledger_line="$ledger_command_text"
  else
    build_out="$(landing_python "$ledger_tool" --into "$worktree" build 2>&1)" || {
      echo "refusing to land ${branch}: tools/ledger.py build failed:" >&2
      printf '%s\n' "$build_out" >&2
      refusal_category="ledger"
      exit 1
    }
    if [[ -n "$(git -C "$worktree" status --porcelain)" ]]; then
      scanned_tip_hold "while its ledger was regenerated"
      git -C "$worktree" add -A -- $generated 2>/dev/null || git -C "$worktree" add -A
      git -C "$worktree" commit -q -m "ledger: regenerate on landing ${branch}"
      scanned_tip_follow
      ledger_line="regenerated ($(git -C "$worktree" rev-parse --short HEAD))"
    else
      ledger_line="current"
    fi
  fi
fi

# the last word before the merge: the branch is still the tip the gate judged
scanned_tip_hold "after it was scanned"
# and the ledger build ran branch code: the gate copy is still BASE's
gate_dir_hold "before the merge"

base_wt="$(worktree_for_branch "$base" || true)"
if [[ -n "$base_wt" ]]; then
  if is_tracked_dirty "$base_wt"; then
    echo "base ${base} is checked out at ${base_wt} and has uncommitted changes; cannot merge" >&2
    # `|| true`, for the reason the same call carries at the first sink
    git -C "$base_wt" status -sb >&2 || true
    say_gitlink_state "$base_wt"
    exit 1
  fi
  merge_cwd="$base_wt"
else
  mkdir -p "${primary}/.worktrees"
  tmp_merge="${primary}/.worktrees/.merge-${base}"
  if [[ -e "$tmp_merge" ]]; then
    echo "temp merge worktree already exists: ${tmp_merge}" >&2
    exit 1
  fi
  git -C "$primary" worktree add "$tmp_merge" "$base"
  merge_cwd="$tmp_merge"
fi

base_before="$(git -C "$merge_cwd" rev-parse "$base")"
if git -C "$merge_cwd" merge-base --is-ancestor "$scanned_tip" "$base"; then
  echo "BRANCH=${branch} already contained in ${base}"
  merge_kind="already"
  merged="yes"
else
  # The SECOND sink, guarded exactly like the first. `is_tracked_dirty` above sees only
  # TRACKED changes; what the branch would CREATE in this checkout is nobody's business
  # but this check's, and the file it lands on is a running node's live private state
  # (keys/, data/, agents.d/, node.env are ignored HERE, inside the very checkout the
  # merge writes into). The range is the branch's own, base_before..branch: the branch was
  # the scanned tip just above, and is held to it again right after this enumeration, so
  # the paths listed are the paths of the sha the merge lands.
  merge_rc=0
  merge_collides="$(ff_collisions "$merge_cwd" "${base_before}..${branch}")" || merge_rc=$?
  if [[ "$merge_rc" == "3" ]]; then
    {
      echo "refusing to land ${branch}: merging it into ${base} would have overwritten"
      echo "path(s) already on disk in ${merge_cwd}, and this landing could not print them --"
      echo "python3 is on PATH and iso_safe_text could not run it, so a name the branch chose"
      echo "would reach your terminal unescaped. A landing that cannot print a name safely"
      echo "does not print it at all; ${base} was not merged and ${worktree} is as it was."
    } >&2
    exit 1
  fi
  if [[ "$merge_rc" != "0" ]]; then
    {
      echo "refusing to land ${branch}: could not list the paths merging it into ${base}"
      echo "would create (git diff --diff-filter=A over ${base_before}..${branch} failed,"
      echo "its words above), so the on-disk check never ran. A guard that cannot run its"
      echo "own check refuses the landing rather than conclude that nothing is in the way;"
      echo "${base} was not merged and ${worktree} is as it was."
    } >&2
    exit 1
  fi
  if [[ -n "$merge_collides" ]]; then
    {
      echo "refusing to land ${branch}: merging it into ${base} would have overwritten"
      echo "path(s) already on disk in ${merge_cwd} that git does not track there -- an"
      echo "untracked or ignored file, or a directory holding one, which is listed with"
      echo "what is under it:"
      printf '%s\n' "$merge_collides"
      echo "git deletes an IGNORED file to make room for an incoming tracked blob, so a"
      echo "running node's live state (keys/, data/, agents.d/, node.env) goes with it --"
      echo "and a branch reaches this sink with such a path because 'git add -f' puts it"
      echo "there past the ignore rule. Move those paths aside yourself, or drop them from"
      echo "the branch, then run finish again; ${base} was not merged and ${worktree} is"
      echo "as it was."
    } >&2
    refusal_category="collision"
    exit 1
  fi
  scanned_tip_hold "while the paths it would create were listed"
  # Nothing beyond the tip land.sh recorded and tested lands, judged BEFORE main moves so a
  # refusal is one MERGED=no on an unmoved base. The range is base_before..scanned_tip, so a
  # commit already on main (another landing's, or origin's taken by BASE_FF) is never counted.
  # Every commit in it must be a rebased copy of a recorded commit, a merge (git cherry lists
  # non-merges only), or finish's own ledger commit, once, straight on top of the recorded tip
  # or a rebased copy of it.
  if [[ -n "$expect_tip" ]]; then
    bt_out=""
    if ! bt_out="$(git -C "$merge_cwd" cherry "$expect_tip" "$scanned_tip" "$base_before")"; then
      echo "refusing to land ${branch}: git cherry over the commits the landing would carry failed; ${base} was not merged." >&2
      echo "MERGED=no"
      exit 1
    fi
    bt_patch_of() {
      git -C "$merge_cwd" diff-tree -p --no-commit-id "$1" | git -C "$merge_cwd" patch-id --stable | cut -d' ' -f1
    }
    bt_ledger_subject="ledger: regenerate on landing ${branch}"
    bt_ledger_seen="no"
    bt_tip_patch="$(bt_patch_of "$expect_tip")"
    while IFS= read -r bt_line; do
      [[ "$bt_line" == "+ "* ]] || continue
      bt_sha="${bt_line#+ }"
      bt_subject="$(git -C "$merge_cwd" log -1 --format=%s "$bt_sha")"
      bt_parents="$(git -C "$merge_cwd" rev-list --parents -n 1 "$bt_sha" | cut -d' ' -f2-)"
      if [[ "$bt_subject" == "$bt_ledger_subject" && "$bt_ledger_seen" == "no" && -n "$bt_parents" && "$bt_parents" != *" "* ]]; then
        if [[ "$bt_parents" == "$expect_tip" ]] || [[ -n "$bt_tip_patch" && "$(bt_patch_of "$bt_parents")" == "$bt_tip_patch" ]]; then
          bt_ledger_seen="yes"
          continue
        fi
      fi
      echo "refusing to land ${branch}: the landing carries commit ${bt_sha:0:12} of ${branch} beyond the recorded tip ${expect_tip:0:12}, which no test or scan judged; ${base} was not merged." >&2
      echo "MERGED=no"
      exit 1
    done <<< "$bt_out"
  fi
  # the SHA the gate judged, never the branch by name: the ref is the worker's to move
  merge_msg="Merge branch '${branch}'"
  case "$base" in
    main|master) ;;
    *) merge_msg="${merge_msg} into ${base}" ;;
  esac
  if git -C "$merge_cwd" -c advice.diverging=false merge --ff-only --no-verify "$scanned_tip"; then
    merge_kind="fast-forward"
  else
    if ! git -C "$merge_cwd" merge --no-edit --no-verify -m "$merge_msg" "$scanned_tip"; then
      git -C "$merge_cwd" merge --abort >/dev/null 2>&1 || true
      echo "merge into ${base} failed; ${branch} was not merged" >&2
      exit 1
    fi
    merge_kind="commit"
  fi
  # from here on BASE carries the branch permanently: every later exit says so
  merged="yes"
fi
base_tip="$(git -C "$merge_cwd" rev-parse "$base")"

# This script never pushes BASE. Two reasons, both load-bearing:
#   1. CLAUDE.md step 4 -- "Pushing still requires an explicit ask."
#   2. No process of the owner's user may hold a GitHub credential, so publishing
#      is not this script's to do: BASE goes to the local hand-off remote below,
#      and the PUBLISHER -- another user, the only holder of a token -- scans the
#      range and pushes (company/ops/publisher/README.md).
# This is not in tension with the fast-forward above: that moves a LOCAL ref to a
# ref that came FROM origin, which is how a landing descends from what the other
# primary published. Landing BASE on the remote is still the trunk owner's
# deliberate act, not a side effect of finishing a session.
pushed="no"

cd "$primary"
if [[ "$worktree" == "$primary" ]]; then
  git switch "$base"
else
  git worktree remove "$worktree"
fi
if git merge-base --is-ancestor "$branch" "$base"; then
  # another worktree with the branch checked out (a shared branch) keeps it: git will not
  # delete a branch a checkout is on, and that checkout is somebody's work
  sb_kept="$(branch_checked_out_elsewhere "$primary")"
  if [[ -n "$sb_kept" ]]; then
    echo "note: ${branch} is merged into ${base} and kept: it is checked out in $(iso_safe_text "$sb_kept"); delete it once that checkout is done" >&2
  else
    git branch -D "$branch"
  fi
else
  echo "refusing to delete ${branch}: not merged into ${base}" >&2
  exit 1
fi
if git remote get-url origin >/dev/null 2>&1; then
  if git ls-remote --exit-code origin "refs/heads/${branch}" >/dev/null 2>&1; then
    # the landing's own cleanup of a session branch that reached origin: the one push a
    # landing makes, never of BASE, and the pre-push hook must let it through
    ISOLATED_SESSION_PUSH=1 git push origin --delete "$branch" || true
  fi
fi
# The session worktree is gone and the branch deleted: the landing is done. What is still
# held -- the Room lease until the publisher has answered, the local lock until the
# hand-off push (below) -- is held on purpose, so from here an exit releases what is
# still held and says nothing else: the
# on_exit notes are about a landing that did not finish, and this one did.
if [[ -n "$tmp_merge" ]]; then
  git -C "$primary" worktree remove --force "$tmp_merge" >/dev/null 2>&1 || true
  tmp_merge=""
fi
receipt_merged="yes"
receipt_tests="$tests_line"
receipt_tests_secs="$tests_secs"
receipt_sec="$sec_line"
trap 'finish_receipt_note $?; cleanup || true' EXIT

echo "MERGED=yes"
if [[ "${ISO_ORIGIN_VIEW_SOURCE:-}" == "break-glass" ]]; then
  printf '%s\n' "ORIGIN=${ISO_ORIGIN_BREAK_GLASS}"
fi
echo "MERGE_KIND=${merge_kind}"
echo "BASE_FF=${base_ff_line}"
[[ -n "$base_rebase_line" ]] && echo "BASE_REBASE=${base_rebase_line}"
echo "REBASED=${rebased}"
echo "SHARED=${shared_line}"
echo "LANDING_LOCK=waited ${waited}s"
[[ -n "$lock_held_before_gate" ]] && echo "LOCK_HELD_BEFORE_GATE=${lock_held_before_gate} min (lock held ${lock_held_before_gate} min before the in-lock gate ran)"
echo "TESTS=${tests_line}"
[[ -n "${prerun_moved_line:-}" ]] && echo "TESTS_FROM_PRERUN=${prerun_moved_line}"
[[ -n "${tests_receipt_line:-}" ]] && echo "TESTS_RECEIPT=$(iso_safe_text "$tests_receipt_line")"
[[ -n "$tests_on_base" ]] && echo "TESTS_RED_ON_BASE=$(iso_safe_text "$tests_on_base")"
[[ -n "${tests_parked:-}" ]] && echo "TESTS_PARKED=$(iso_safe_text "$tests_parked")"
[[ -n "$tests_secs" ]] && echo "TESTS_SECS=${tests_secs}"
[[ -n "$tests_files" ]] && echo "TESTS_FILES=$(iso_safe_text "$tests_files")"
# timed out under load and re-run once by the gate, green there (tools/run_tests.py, "A
# GATE'S BUDGET HOLDS UNDER LOAD"): on record, so a slow file is not hidden by the re-run
[[ -n "${tests_rerun:-}" ]] && echo "TESTS_RERUN=$(iso_safe_text "$tests_rerun")"
# names are tests/test_x.py: that is how the runner spells a file, and the receipt
# prints them with every invisible code point spelled out (iso_safe_text) -- a test file
# is a name the diff chose, and this line is read in a terminal
echo "SEC=${sec_line}"
echo "INV=${inv_line}"
[[ -n "$sec_scanned_line" ]] && printf '%s\n' "$sec_scanned_line"
echo "LEDGER=${ledger_line}"
echo "BASE=${base}"
echo "BRANCH=${branch}"
echo "PRIMARY=${primary}"
echo "PUSHED=${pushed}"
# The hand-off: when the primary has a `handoff` remote (setup-handoff.sh), BASE goes
# there -- a bare repository on this machine, no credential -- for the publisher, another
# user with the only GitHub token, to evaluate and push (company/ops/publisher/README.md).
# Never a failed landing: the line says what happened.
#
# --- held until published ------------------------------------------------------------
# The landing lease serializes two Macs' LANDINGS, but a landing that released it at the
# hand-off push left the gap it exists to close: the other Mac could take the lease, land
# and publish before this Mac's publisher ran, and this hand-off was then "not a
# fast-forward of origin" -- held until a person rebased it (plan 2026-09-19-multi-mac-appl,
# M1). So while a lease is held and the hand-off took the push, the lease is kept until
# the publisher's status file answers for THIS push. The local lock is NOT kept: it is
# released as soon as the hand-off push completes, so another landing on this primary can
# take it during the wait. A round below that moves local BASE therefore first checks
# that BASE is still the tip the round started from, and refuses the round if it moved;
# the hand-off push stays leased on that tip. The status answers:
#   * `when=` strictly newer than the second the push started -- a status left by an
#     earlier landing, or written in the same second, never counts -- AND, when the
#     status names a `handoff=`, that it is exactly the tip pushed (a clock cannot confuse
#     that one);
#   * result=published or result=up-to-date: released, PUBLISH=<that>;
#   * result=held because it is not a fast-forward: a ROUND -- origin is read again (the
#     fetch, else the publisher's bundle), local BASE's unpublished commits are rebased
#     onto it in a scratch checkout, the tests the rebased range owes run there, BASE's
#     lint refuses what it refuses, the ledger is rebuilt, and only then does local BASE
#     move and the hand-off take it (leased on the tip it had). At most two rounds after
#     the original push, three pushes in all; a third "not a fast-forward", a conflicting
#     rebase, red tests, or anything else a round cannot finish ends as HANDOFF=held with
#     the reason, local BASE left at the tip the hand-off holds, and exit 0 -- the landing
#     itself happened, and a person picks the hand-off up from the receipt;
#   * nothing of the above within LANDING_PUBLISH_WAIT_S (default 300) of a push:
#     PUBLISH=timeout, released. Any other status (held for a review, an error) is waited
#     out the same way: it is not this Mac's to fix by rebasing.
# No lease, or no hand-off push: no wait at all, as before.
publish_verdict() {  # $1 status file, $2 epoch the push started, $3 the tip pushed
  landing_python - "$1" "$2" "$3" <<'PY'
import sys
from datetime import datetime
path, since, tip = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
except OSError:
    print("pending")
    sys.exit(0)
fields = {}
for line in text.splitlines():
    key, sep, value = line.partition("=")
    if sep and key not in fields:
        fields[key] = value.strip()
try:
    when = datetime.strptime(fields.get("when", ""), "%Y-%m-%dT%H:%M:%S%z").timestamp()
except ValueError:
    print("pending")          # a when= nobody can read does not count
    sys.exit(0)
if when <= since:
    print("pending")          # older than this push, or the same second: not about it
    sys.exit(0)
named = fields.get("handoff", "")
if named and named != tip:
    print("pending")          # about some other tip
    sys.exit(0)
result = fields.get("result", "")
if result in ("published", "up-to-date"):
    print(result)
elif result == "held" and "not a fast-forward" in fields.get("reason", ""):
    print("not-ff")
else:
    print("pending")
PY
}

# Polls until the status answers for the push, or LANDING_PUBLISH_WAIT_S has passed since
# it. Sets pw_result: published, up-to-date, not-ff or timeout.
publish_wait() {  # $1 epoch the push started, $2 epoch it finished, $3 the tip pushed
  local pwv="" pw_now=""
  while :; do
    pwv="$(publish_verdict "$pw_status" "$1" "$3" 2>/dev/null)" || pwv="pending"
    case "$pwv" in
      published|up-to-date|not-ff) pw_result="$pwv"; return 0 ;;
    esac
    pw_now="$(date +%s)"
    # strictly past: `date +%s` is whole seconds, so this holds for at least the full wait
    if (( pw_now > $2 + publish_wait_s )); then
      pw_result="timeout"
      return 0
    fi
    sleep 1
  done
}

# origin/BASE again, the way the landing read it: lib.sh:iso_origin_view, the one rule --
# which also takes only a fast-forward of what this repository already has. Its refusal
# (stale, mismatched, missing, older than what we have) is kept for pw_why.
pw_reread_why=""
publish_reread_origin() {
  local rr_err=""
  rr_err="$(finish_tmp)"
  if iso_origin_view "$primary" "$base" 2>"$rr_err"; then
    rm -f "$rr_err"
    return 0
  fi
  pw_reread_why="$(grep -i "refusing" "$rr_err" 2>/dev/null | head -1 | sed 's/^iso_origin_view: refusing: //')" ||
    pw_reread_why=""
  rm -f "$rr_err"
  return 1
}

# Puts local BASE back at $1 after a round moved it and the hand-off would not take it.
publish_put_back() {  # $1 sha, $2 the checkout that has BASE ("" for none)
  if [[ -n "$2" ]]; then
    git -C "$2" reset --quiet --keep "$1" >/dev/null 2>&1 || true
  else
    git -C "$primary" update-ref "refs/heads/${base}" "$1" >/dev/null 2>&1 || true
  fi
}

# One round. 0: the hand-off took the rebased BASE -- pw_tip, pw_since and pw_pushed are
# the new push. 1: pw_why says why not, and local BASE and the hand-off are where they
# were. Runs as the condition of an `if`, so `set -e` is off inside and every step is
# checked by hand. `worktree` is shadowed with the primary: the session worktree is gone,
# and worktree_for_branch and ff_collisions ask git from it.
publish_round() {
  local worktree="$primary"
  local pr_old="" pr_onto="" pr_wt="" pr_new="" pr_conf="" pr_one="" pr_only="" pr_gd=""
  local pr_names="" pr_rc=0 pr_base_wt="" pr_hits="" pr_sec="" pr_extra="" pr_err="" pr_now="" pr_scan=""
  pr_old="$(git -C "$primary" rev-parse "$base")" || { pw_why="could not read ${base}"; return 1; }
  if [[ "$pr_old" != "$pw_tip" ]]; then
    pw_why="${base} moved during the wait (${pr_old:0:7}, the hand-off holds ${pw_tip:0:7})"
    return 1
  fi
  if ! publish_reread_origin; then
    pw_why="origin could not be read again ($(iso_safe_text "${pw_reread_why:-no reason given}" || printf 'a reason that could not be printed safely'))"
    return 1
  fi
  pr_onto="$(git -C "$primary" rev-parse --verify --quiet "$remote_base")" || {
    pw_why="there is no ${remote_base} to rebase onto"
    return 1
  }
  if git -C "$primary" merge-base --is-ancestor "$pr_onto" "$pr_old"; then
    pw_why="the publisher says not a fast-forward, but ${remote_base} as read again (${pr_onto:0:7}) is already in ${base}"
    return 1
  fi

  # the rebase, in a detached scratch checkout: local BASE does not move until the
  # rebased tree has passed everything below
  mkdir -p "${primary}/.worktrees"
  pr_wt="${primary}/.worktrees/.publish-${base}"
  if [[ -e "$pr_wt" ]]; then
    pw_why="a scratch checkout is already at ${pr_wt}"
    return 1
  fi
  if ! git -C "$primary" worktree add --quiet --detach "$pr_wt" "$pr_old" >/dev/null 2>&1; then
    pw_why="could not open ${base} in a scratch checkout to rebase it"
    return 1
  fi
  tmp_publish="$pr_wt"
  if ! GIT_EDITOR=true git -C "$pr_wt" -c rebase.updateRefs=false -c rebase.autoStash=false \
         -c rebase.autoSquash=false rebase --quiet "$pr_onto" >/dev/null 2>&1; then
    # a conflict confined to the generated files has one right answer, the ledger rebuilt
    # on this tree (as in self_rebase_base); any other stops the round
    while :; do
      pr_conf="$(git -C "$pr_wt" -c core.quotepath=false diff --name-only --diff-filter=U)"
      [[ -n "$pr_conf" ]] || break
      pr_only="yes"
      while IFS= read -r pr_one; do
        [[ -n "$pr_one" ]] || continue
        case " $generated " in
          *" $pr_one "*) ;;
          *) pr_only="no" ;;
        esac
      done <<< "$pr_conf"
      [[ "$pr_only" == "yes" && -f "$gate_ledger" ]] || break
      landing_python "$gate_ledger" --into "$pr_wt" build >/dev/null 2>&1 || break
      for pr_one in $generated; do
        if [[ -e "$pr_wt/$pr_one" ]] ||
           git -C "$pr_wt" ls-files --error-unmatch -- "$pr_one" >/dev/null 2>&1; then
          git -C "$pr_wt" add -A -- "$pr_one" >/dev/null 2>&1 || true
        fi
      done
      [[ -z "$(git -C "$pr_wt" diff --name-only --diff-filter=U)" ]] || break
      if ! GIT_EDITOR=true git -C "$pr_wt" -c rebase.updateRefs=false rebase --continue >/dev/null 2>&1; then
        if [[ -z "$(git -C "$pr_wt" diff --name-only --diff-filter=U)" ]]; then
          GIT_EDITOR=true git -C "$pr_wt" rebase --skip >/dev/null 2>&1 || true
        fi
      fi
      pr_gd="$(git -C "$pr_wt" rev-parse --git-dir)"
      [[ -d "$pr_gd/rebase-merge" || -d "$pr_gd/rebase-apply" ]] || break
    done
    pr_gd="$(git -C "$pr_wt" rev-parse --git-dir)"
    if [[ -n "$(git -C "$pr_wt" diff --name-only --diff-filter=U)" ||
          -d "$pr_gd/rebase-merge" || -d "$pr_gd/rebase-apply" ]]; then
      pr_conf="$(git -C "$pr_wt" -c core.quotepath=false diff --name-only --diff-filter=U)"
      while IFS= read -r pr_one; do
        [[ -n "$pr_one" ]] || continue
        pr_names="${pr_names}${pr_names:+ }$(iso_safe_text "$pr_one" 2>/dev/null || printf '(a path this landing could not print safely)')"
      done <<< "$pr_conf"
      pw_why="rebasing ${base} onto ${remote_base} (${pr_onto:0:7}) conflicts in: ${pr_names:-(no path named)}"
      cleanup_publish_wt
      return 1
    fi
  fi
  pr_new="$(git -C "$pr_wt" rev-parse HEAD)"
  if ! git -C "$primary" merge-base --is-ancestor "$pr_onto" "$pr_new"; then
    pw_why="the rebased ${base} does not descend from ${remote_base}"
    cleanup_publish_wt
    return 1
  fi

  # the tests the rebased range owes, on the rebased tree -- run by the gate's runner, not
  # the copy the merge just put on BASE
  if [[ -n "$tests_command" && "${ISOLATED_SESSION_LAND_TESTS:-1}" != "0" ]]; then
    pr_rc=0
    ( cd "$pr_wt" && credless bash -c "$tests_command" ) < /dev/null >/dev/null 2>&1 || pr_rc=$?
    if [[ "$pr_rc" != "0" ]]; then
      pw_why="appl.toml's [tests] command went red on ${base} rebased onto ${remote_base} (${pr_onto:0:7}; exit ${pr_rc})"
      cleanup_publish_wt
      return 1
    fi
    if [[ -n "$(git -C "$pr_wt" status --porcelain)" ]]; then
      pw_why="the tests left the rebased tree dirty"
      cleanup_publish_wt
      return 1
    fi
  elif [[ -f "$gate_runner" && "${ISOLATED_SESSION_LAND_TESTS:-1}" != "0" ]]; then
    pr_rc=0
    pr_sandbox_err="$(finish_tmp)"
    (
      sandbox_begin "$pr_wt" || exit 1
      trap 'sandbox_end' EXIT
      sandbox_child_env
      cd "$sandbox_clone" && branch_tests_python "$gate_runner" --root "$sandbox_clone" --affected "${pr_onto}..HEAD" --gate --json \
        ${ISOLATED_SESSION_LAND_JOBS:+-j "$ISOLATED_SESSION_LAND_JOBS"}
    ) >/dev/null 2>"$pr_sandbox_err" || pr_rc=$?
    if [[ "$pr_rc" != "0" ]]; then
      if grep -q "disposable clone could not be created" "$pr_sandbox_err"; then
        pw_why="the disposable clone could not be created (${base} rebased onto ${remote_base}, ${pr_onto:0:7})"
      else
        pw_why="the tests went red on ${base} rebased onto ${remote_base} (${pr_onto:0:7}; tools/run_tests.py exit ${pr_rc})"
      fi
      rm -f "$pr_sandbox_err"
      cleanup_publish_wt
      return 1
    fi
    rm -f "$pr_sandbox_err"
    if [[ -n "$(git -C "$pr_wt" status --porcelain)" ]]; then
      pw_why="the tests left the rebased tree dirty"
      cleanup_publish_wt
      return 1
    fi
  fi

  # BASE's lint (as it was before this landing), over what the rebase rewrote. The round
  # fails closed on an allow list: only clean and needs-eyes publish (needs-eyes was this
  # landing's, and is on its REVIEW= line); refused, broken (a commit with no, an unknown
  # or an empty verdict), any other word or a scan that could not run holds it.
  # appl.toml's [scan] command, when it was this landing's scan, stands in for the lint's
  # verdict, never for its per-commit refuse check, which runs below either way.
  if [[ -n "$scan_command" ]]; then
    pr_rc=0
    ( cd "$pr_wt" && credless bash -c "$scan_command" ) < /dev/null >/dev/null 2>&1 || pr_rc=$?
    if [[ "$pr_rc" != "0" ]]; then
      pw_why="appl.toml's [scan] command refused ${base} rebased onto ${remote_base} (${pr_onto:0:7}; exit ${pr_rc})"
      cleanup_publish_wt
      return 1
    fi
    if [[ -n "$(git -C "$pr_wt" status --porcelain)" ]]; then
      pw_why="the scan command left the rebased tree dirty"
      cleanup_publish_wt
      return 1
    fi
  fi
  if git -C "$primary" cat-file -e "${base_before}:tools/sec_lint.py" 2>/dev/null; then
    pr_sec="$(mktemp -d "${pr_wt}/.sec-base-XXXXXX")" || { pw_why="could not stage the lint"; cleanup_publish_wt; return 1; }
    mkdir -p "$pr_sec/tools" "$pr_sec/company/ops"
    for pr_extra in tools/sec_lint.py tools/audit_scope.py tools/ledger.py tools/backlog_build.py \
                    tools/spec_build.py company/ops/backlog_to_core.py; do
      if git -C "$primary" cat-file -e "${base_before}:${pr_extra}" 2>/dev/null; then
        mkdir -p "$pr_sec/$(dirname "$pr_extra")"
        git -C "$primary" show "${base_before}:${pr_extra}" > "$pr_sec/${pr_extra}" 2>/dev/null || true
      fi
    done
    # every commit of what the rebase rewrote, as the publisher will judge them
    # (sec_scan_commits), never the net diff
    pr_rc=0
    pr_json="$(finish_tmp)" || { pw_why="could not stage the lint"; rm -rf "$pr_sec"; cleanup_publish_wt; return 1; }
    pr_paths="$(finish_tmp)" || { pw_why="could not stage the lint"; rm -rf "$pr_sec" "$pr_json"; cleanup_publish_wt; return 1; }
    sec_scan_commits "$pr_wt" "$pr_sec/tools/sec_lint.py" "$pr_onto" "$pr_json" "$pr_paths" >/dev/null 2>&1 || pr_rc=$?
    pr_scan="no-verdict"
    if [[ "$pr_rc" == "0" ]]; then
      pr_scan="$(landing_python -c 'import json,sys; print(str(json.load(open(sys.argv[1]))["verdict"]))' \
                   "$pr_json" 2>/dev/null)" || pr_scan="no-verdict"
    fi
    rm -rf "$pr_sec" "$pr_json" "$pr_paths"
    case "$pr_scan" in
      clean|needs-eyes) ;;
      refused)
        pw_why="tools/sec_lint.py refused a commit of ${base} rebased onto ${remote_base}"
        cleanup_publish_wt
        return 1
        ;;
      *)
        pw_why="tools/sec_lint.py gave no clean verdict (${pr_scan:-empty}) for ${base} rebased onto ${remote_base}"
        cleanup_publish_wt
        return 1
        ;;
    esac
  fi

  # the ledgers, rebuilt on the rebased tip. appl.toml's [ledger] command, when this
  # landing trusted one, stands in for tools/ledger.py build, the same as the first build.
  if [[ -f "$gate_ledger" ]]; then
    if [[ -n "$ledger_command" ]]; then
      pr_rc=0
      ( cd "$pr_wt" && credless bash -c "$ledger_command" ) < /dev/null >/dev/null 2>&1 || pr_rc=$?
      if [[ "$pr_rc" != "0" ]]; then
        pw_why="appl.toml's [ledger] command failed on ${base} rebased onto ${remote_base} (${pr_onto:0:7}; exit ${pr_rc})"
        cleanup_publish_wt
        return 1
      fi
    elif ! landing_python "$gate_ledger" --into "$pr_wt" build >/dev/null 2>&1; then
      pw_why="tools/ledger.py build failed on the rebased tree"
      cleanup_publish_wt
      return 1
    fi
    if [[ -n "$(git -C "$pr_wt" status --porcelain)" ]]; then
      git -C "$pr_wt" add -A -- $generated >/dev/null 2>&1 || git -C "$pr_wt" add -A >/dev/null 2>&1
      if ! git -C "$pr_wt" commit -q -m "ledger: regenerate on landing ${branch} (rebased onto ${remote_base})" >/dev/null 2>&1; then
        pw_why="could not commit the rebuilt ledger on the rebased tree"
        cleanup_publish_wt
        return 1
      fi
      pr_new="$(git -C "$pr_wt" rev-parse HEAD)"
    fi
  fi
  cleanup_publish_wt

  # The round runs without the local lock (released at the hand-off push), so another
  # landing may have merged into local BASE while it rebased and tested: never overwrite.
  pr_now="$(git -C "$primary" rev-parse "$base" 2>/dev/null || true)"
  if [[ "$pr_now" != "$pr_old" ]]; then
    pw_why="${base} moved during the round (${pr_now:0:7}, the round started from ${pr_old:0:7}): another landing took the landing lock since; not overwriting it"
    return 1
  fi

  # local BASE moves only now, under the guards every move of it has
  pr_base_wt="$(worktree_for_branch "$base" || true)"
  if [[ -n "$pr_base_wt" ]]; then
    if is_tracked_dirty "$pr_base_wt"; then
      pw_why="${base} is checked out at ${pr_base_wt} with uncommitted changes"
      return 1
    fi
    pr_rc=0
    pr_hits="$(ff_collisions "$pr_base_wt" "${pr_old}..${pr_new}")" || pr_rc=$?
    if [[ "$pr_rc" != "0" ]]; then
      pw_why="could not list (or could not safely print) what the rebased ${base} would write into ${pr_base_wt}"
      return 1
    fi
    if [[ -n "$pr_hits" ]]; then
      { echo "note: the rebased ${base} would overwrite path(s) on disk in ${pr_base_wt} that git does not track there:"; printf '%s\n' "$pr_hits"; } >&2
      pw_why="the rebased ${base} would overwrite untracked or ignored path(s) in ${pr_base_wt} (listed above)"
      return 1
    fi
    if ! git -C "$pr_base_wt" reset --quiet --keep "$pr_new" >/dev/null 2>&1; then
      publish_put_back "$pr_old" "$pr_base_wt"
      pw_why="could not move ${base} to the rebased tip in ${pr_base_wt}"
      return 1
    fi
  elif ! git -C "$primary" update-ref "refs/heads/${base}" "$pr_new" "$pr_old" >/dev/null 2>&1; then
    pw_why="could not move ${base} to the rebased tip"
    return 1
  fi

  # the hand-off takes it, leased on the tip it holds: it overwrites only what we pushed
  pr_err="$(finish_tmp)"
  pw_since="$(date +%s)"
  if ! ISOLATED_SESSION_PUSH=1 git -C "$primary" push --quiet \
         --force-with-lease="refs/heads/${base}:${pr_old}" handoff "${base}:refs/heads/${base}" \
         >/dev/null 2>"$pr_err"; then
    publish_put_back "$pr_old" "$pr_base_wt"
    pw_why="the hand-off would not take the rebased ${base}: $(iso_safe_text "$(tail -1 "$pr_err" 2>/dev/null || true)" 2>/dev/null || true)"
    rm -f "$pr_err"
    return 1
  fi
  rm -f "$pr_err"
  pw_pushed="$(date +%s)"
  pw_tip="$pr_new"
  return 0
}

cleanup_publish_wt() {
  if [[ -n "$tmp_publish" ]]; then
    git -C "$tmp_publish" rebase --abort >/dev/null 2>&1 || true
    git -C "$primary" worktree remove --force "$tmp_publish" >/dev/null 2>&1 || true
    tmp_publish=""
  fi
}

handoff_line="none (no handoff remote)"
publish_line=""
handoff_took="no"
if handoff_url="$(git -C "$primary" remote get-url handoff 2>/dev/null)"; then
  handoff_err="$(finish_tmp)"
  pw_since="$(date +%s)"
  if ISOLATED_SESSION_PUSH=1 git -C "$primary" push --quiet handoff "${base}:refs/heads/${base}" >/dev/null 2>"$handoff_err"; then
    handoff_line="pushed ${base_tip} to ${handoff_url}"
    handoff_took="yes"
  else
    handoff_line="failed: $(tail -1 "$handoff_err" 2>/dev/null | tr -d '\r' | cut -c1-200)"
  fi
  rm -f "$handoff_err"
fi
# The local lock goes here, once the hand-off push has completed and before the publish
# wait: another landing on this primary may take it while this one waits for the
# publisher. `holding_land=no` makes the release final -- the cleanup and on_exit below
# must never remove a lock another landing has taken since.
if [[ "$holding_land" == "yes" ]]; then
  holding_land="no"
  ! land_lock_is_mine || rm -f "$land_lock" 2>/dev/null || true
fi
if [[ "$handoff_took" == "yes" && "$lease_held" == "yes" ]]; then
  pw_pushed="$(date +%s)"
  pw_status=""
  if [[ -n "${LANDING_PUBLISHER_STATUS:-}" ]]; then
    pw_status="$LANDING_PUBLISHER_STATUS"
  elif pw_name="$(iso_publisher_name "$primary")"; then
    pw_status="${ISO_PUBLISHER_STATE}/status/${pw_name}.txt"
  fi
  if [[ -z "$pw_status" ]]; then
    publish_line="not-waited (the hand-off remote names no publisher repository, so there is no status to read)"
  else
    pw_tip="$base_tip"
    pw_rounds=0
    pw_result=""
    pw_why=""
    echo "note: holding the landing lease until the publisher answers for ${pw_tip:0:12} (LANDING_PUBLISH_WAIT_S=${publish_wait_s})" >&2
    while :; do
      publish_wait "$pw_since" "$pw_pushed" "$pw_tip"
      case "$pw_result" in
        published|up-to-date|timeout)
          publish_line="$pw_result"
          break
          ;;
      esac
      # not a fast-forward of origin
      if (( pw_rounds >= 2 )); then
        handoff_line="held -- the publisher held ${pw_tip:0:12} as not a fast-forward of origin after ${pw_rounds} rebase round(s); ${base} is at that tip, which the hand-off holds"
        break
      fi
      pw_rounds=$(( pw_rounds + 1 ))
      echo "note: the publisher held ${pw_tip:0:12} as not a fast-forward of origin; rebasing onto ${remote_base} again (round ${pw_rounds} of 2)" >&2
      if publish_round; then
        handoff_line="pushed ${pw_tip} to ${handoff_url} (rebased onto ${remote_base}, round ${pw_rounds})"
        continue
      fi
      handoff_line="held -- round ${pw_rounds}: ${pw_why}; ${base} is at ${pw_tip:0:12}, which the hand-off holds"
      break
    done
  fi
fi
cleanup
trap - EXIT
echo "HANDOFF=${handoff_line}"
[[ -n "$publish_line" ]] && echo "PUBLISH=${publish_line}"
if [[ "$lease_did_hold" == "yes" ]]; then
  if [[ "$lease_release_rc" == "0" ]]; then
    echo "LEASE=released"
  else
    # The merge already happened, so a failed release is reported, not a refusal.
    echo "LEASE=release-failed (exit ${lease_release_rc})"
  fi
fi
echo "WORKTREE_REMOVED=yes"
finish_receipt_note 0

# --- the human half of the scan: a reviewer session -------------------------------
# The landing is done and its lock released; what follows can neither block nor fail
# it. A needs-eyes landing renders the per-landing reviewer brief and hands it to
# herd-spawn.sh; when herdr is absent or down (or the operator set
# ISOLATED_SESSION_LAND_REVIEW=0) the receipt carries the command to run by hand
# instead, because the review is owed either way.
#
# The template and the spawner come out of BASE's blobs at the sha it had BEFORE this
# landing (`git show base_before:path`), never from the primary's working tree: the
# fast-forward above moved that tree to the landed tip, so its copies are the branch's,
# and a branch that rewrote the brief or the spawner would otherwise be reviewed under
# its own brief, or not reviewed at all with a receipt that says it was.
review_line="none"
# The cadence: `.security/review-cadence` saying `daily` defers the review to
# tools/security_daily.sh, which reads the whole day's range once (the owner's choice,
# 2026-09-13: a reviewer per landing spent most of a week's subscription in a day);
# ISOLATED_SESSION_LAND_REVIEW, when set, still decides for this landing alone.
#
# Read out of BASE's blob at the sha it had BEFORE this landing, like every other gate
# input (the lint, the brief, the spawner), and never off the working tree: the merge
# above has just moved that tree to the landed tip, so a branch that ADDS `daily` made
# its OWN landing say REVIEW=deferred and spawn nothing -- and in a vendored copy with no
# daily LaunchAgent that is "no review at all". Absent in BASE means a reviewer per
# landing, as before.
#
# Defer only when this landing's own $HOME holds the daily job as a regular file at
# Library/LaunchAgents/com.muretai.security-daily.plist (a plain -f check, and not a
# symlink). A missing file, a symlink or a directory is not installed: spawn the
# reviewer exactly as with no cadence file. Never launchctl -- the check must not
# change system state (IB:52979).
review_cadence="$(git -C "$primary" show "${base_before}:.security/review-cadence" 2>/dev/null | tr -d '[:space:]')" || review_cadence=""
daily_plist="${HOME:-}/Library/LaunchAgents/com.muretai.security-daily.plist"
daily_job_installed=no
if [[ -n "${HOME:-}" && -f "$daily_plist" && ! -L "$daily_plist" ]]; then
  daily_job_installed=yes
fi
if [[ "$sec_verdict" == "needs-eyes" && "$base_before" != "$base_tip" && -z "${ISOLATED_SESSION_LAND_REVIEW+set}" && "$review_cadence" == "daily" && "$daily_job_installed" == "yes" ]]; then
  review_line="deferred -- daily cadence (${base}:.security/review-cadence at $(git -C "$primary" rev-parse --short=7 "$base_before")): tools/security_daily.sh reads the day's landings as one range, and the publisher waits for its receipt"
elif [[ "$sec_verdict" == "needs-eyes" && "$base_before" != "$base_tip" ]]; then
  # herdr names an agent with [a-z][a-z0-9_-]{0,31}: "secrev-" leaves 25 for the slug
  review_slug="$(printf '%s' "${branch#*/}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | tr -s '-')"
  # 20 characters of slug plus four of the landed tip: two branches that share a prefix
  # get two names, two checkouts and two briefs
  # (ISSUE(security-audit-2026-09-12-the-reviewer-opens-in-a-c-6))
  review_slug="${review_slug:0:20}"
  review_slug="${review_slug#-}"
  review_slug="${review_slug%-}"
  review_slug="${review_slug}-$(printf '%s' "$base_tip" | cut -c1-4)"
  review_name="secrev-${review_slug}"
  # empty when neither HERD_DIR nor HOME is set: said on the REVIEW= line below, never
  # a nounset error after the merge (ISSUE(security-audit-2026-09-12-the-cleanup-trusts-n-d474-4))
  herd_dir="$(iso_herd_dir || true)"
  # absolute, so the rules herd-spawn.sh writes from it name real paths
  [[ -z "$herd_dir" || "$herd_dir" == /* ]] || herd_dir="$(pwd)/${herd_dir}"
  review_brief="${herd_dir}/briefs/${review_name}.md"
  # The reviewer opens in a checkout of main as it was BEFORE this landing: its
  # SessionStart hook, its scripts and its settings are the ones main had, not the
  # branch's (a diff that edits session-guard.sh would otherwise run as the reviewer
  # spawns), and no .claude/settings.local.json lives there
  # (ISSUE(security-audit-2026-09-12-the-reviewer-sandbox-an-e-2), -3).
  # ... and OUTSIDE the primary: Claude Code reads CLAUDE.md from every parent directory,
  # and the primary's is the landed tip's (-4); under HERD_DIR it collides with no session
  # worktree either (-1)
  review_root="${herd_dir}/review"
  review_co="${review_root}/${review_name}"
  template_rel=".cursor/skills/isolated-session/briefs/reviewer.md"
  spawner_rel=".cursor/skills/isolated-session/scripts/herd-spawn.sh"
  lib_rel=".cursor/skills/isolated-session/scripts/lib.sh"
  # The reviewer's checkout is ON A BRANCH of its own at the pre-landing BASE: the receipt
  # branch ensure-worktree.sh names for "Audit receipt for landing <slug>", held under the
  # reviewer's owner key (herd-spawn's default for a walled spawn: the worker's name). A
  # detached checkout recorded no branch, so the walled reviewer got no gate, and behind the
  # wall it could not open a worktree of its own to land from
  # (ISSUE(walled-reviewer-cannot-write-its-receipt)).
  receipt_task="Audit receipt for landing ${review_slug}"
  receipt_branch="feat/$(iso_task_slug "$receipt_task" 2>/dev/null || true)"
  run_hint="bash ${spawner_rel} ${review_name} ${review_brief} --profile reviewer --cwd ${review_co} --var MAIN=${primary} --env ISOLATED_SESSION_OWNER=${review_name}, in a checkout on ${receipt_branch} at ${base_before} (when it is not there: ISOLATED_SESSION_OWNER=${review_name} bash ${spawner_rel%/*}/ensure-worktree.sh --at ${base_before} --into ${review_co} '${receipt_task}'); the reviewer lands its receipt from that checkout with bash ${spawner_rel%/*}/finish-worktree.sh ${receipt_branch} ${review_co}"
  by_hand="run the security-audit skill over ${base_before}..${base_tip} by hand"
  # HERD_DIR is where a prompt for an autonomous session is written: ours, mode 700
  # when this creates it, refused when someone else owns it, and refused when a
  # directory above it is writable by others (a CLAUDE.md there would reach the
  # reviewer, whose cwd is under it). Nothing in this section may end the landing:
  # the merge is done, and a REVIEW= line is owed whatever stands at these paths
  # (ISSUE(security-audit-2026-09-12-the-review-checkout-lives-3), -4).
  if [[ -n "$herd_dir" && ! -e "$herd_dir" ]]; then
    mkdir -p "$herd_dir" 2>/dev/null && chmod 700 "$herd_dir" 2>/dev/null || true
  fi
  if [[ -z "$herd_dir" ]]; then
    review_line="needed -- neither HERD_DIR nor HOME is set, so there is no herd directory; ${by_hand}"
  elif [[ -L "$herd_dir" || ! -d "$herd_dir" || ! -O "$herd_dir" ]]; then
    review_line="needed -- ${herd_dir} is not a directory owned by $(id -un) (HERD_DIR); ${by_hand}"
  elif ! open_dir="$(iso_private_path "$herd_dir")"; then
    review_line="needed -- ${open_dir}, at or above ${herd_dir}, is writable by others (a CLAUDE.md there would reach the reviewer); set HERD_DIR under your home; ${by_hand}"
  elif ! git -C "$primary" cat-file -e "${base_before}:${template_rel}" 2>/dev/null; then
    review_line="needed -- no ${template_rel} in ${base} before this landing; ${by_hand}"
  elif [[ -L "${herd_dir}/briefs" || ( -e "${herd_dir}/briefs" && ! -d "${herd_dir}/briefs" ) || ( -d "${herd_dir}/briefs" && ! -O "${herd_dir}/briefs" ) ]]; then
    review_line="needed -- ${herd_dir}/briefs is a symlink, a file, or not ours; ${by_hand}"
  elif [[ ! -d "${herd_dir}/briefs" ]] && ! mkdir -m 700 "${herd_dir}/briefs" 2>/dev/null; then
    review_line="needed -- could not create ${herd_dir}/briefs; ${by_hand}"
  elif ! review_tpl="$(finish_tmp)" || ! git -C "$primary" show "${base_before}:${template_rel}" > "$review_tpl" 2>/dev/null; then
    review_line="needed -- could not read ${template_rel} from ${base_before}; ${by_hand}"
  else
    # One pass over the placeholders with a dict, never sequential replaces (a value
    # is never re-scanned for a later key). FILES and BRANCH are data the diff chose:
    # rendered as backticked paths with any backtick, brace pair or newline removed.
    # LINT_FINDINGS is the lint's findings this landing already computed for the range
    # (sec_findings: one iso_safe_text-escaped record per line, in the scan's order), so the
    # reviewer never runs the lint itself; each stays one line, and a brace pair in it is
    # folded so herd-spawn.sh's re-render can neither fill it nor refuse on it.
    if landing_python - "$review_tpl" "$review_brief" "NAME=${review_name}" "BASE=${base_before}" \
         "TIP=${base_tip}" "BRANCH=${branch}" "SLUG=${review_slug}" "FILES=${sec_files}" \
         "PRIMARY=${review_co}" "MAIN=${primary}" "BASE_FROM=the pre-landing base" \
         "LINT_FINDINGS=${sec_findings}" <<'PY'
import os, re, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
values = {}
for kv in sys.argv[3:]:
    key, _, value = kv.partition("=")
    values[key] = value


def as_data(s):
    # markdown-safe AND shell-safe: a branch name or a path reaches the brief as prose
    # only, never inside a command, but a reviewer may still paste it -- so nothing that
    # chains, substitutes, quotes or comments survives
    # (ISSUE(security-audit-2026-09-12-the-landing-judges-a-diff-4))
    s = s.replace("`", "").replace("\r", " ").replace("\n", " ")
    while "{{" in s or "}}" in s:
        s = s.replace("{{", "").replace("}}", "")
    s = "".join(ch if (ch.isalnum() or ch in "._/-+@:, ") else "-" for ch in s)
    return s


paths = [as_data(p) for p in values.get("FILES", "").split() if p]
values["FILES"] = ", ".join("`" + p + "`" for p in paths) or "(none)"
values["BRANCH"] = as_data(values.get("BRANCH", ""))
values["BASE_FROM"] = as_data(values.get("BASE_FROM", ""))


def as_finding(s):
    # verbatim but for what could break the section or refill a placeholder: no line
    # break survives, and no brace pair either
    s = s.replace("\r", " ").replace("\x85", " ").replace(chr(0x2028), " ").replace(chr(0x2029), " ")
    while "{{" in s or "}}" in s:
        s = s.replace("{{", "{").replace("}}", "}")
    return s


found = [as_finding(ln) for ln in values.get("LINT_FINDINGS", "").split("\n") if ln.strip()]
values["LINT_FINDINGS"] = "\n".join(found) or "`none`"


def fill(m):
    # a key the landing does not know ({{REPORT}}) is herd-spawn.sh's to fill; it stays
    return values.get(m.group(1), m.group(0))


# the exact path is unlinked (a planted symlink goes, its target stays) and the file is
# created O_EXCL, mode 600 -- the same write herd-spawn.sh does for its own copy
# (ISSUE(security-audit-2026-09-12-the-reviewer-sandbox-an-e-4))
out = re.sub(r"\{\{([A-Z][A-Z0-9_]*)\}\}", fill, text)
if os.path.lexists(dst):
    os.unlink(dst)
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(out)
PY
    then
      rm -f "$review_tpl"
      if [[ "${ISOLATED_SESSION_LAND_REVIEW:-1}" == "0" ]]; then
        review_line="needed -- ISOLATED_SESSION_LAND_REVIEW=0; run: ${run_hint}"
      elif ! git -C "$primary" cat-file -e "${base_before}:${spawner_rel}" 2>/dev/null ||
           ! git -C "$primary" cat-file -e "${base_before}:${lib_rel}" 2>/dev/null; then
        review_line="needed -- no ${spawner_rel} in ${base} before this landing; run: ${run_hint}"
      # A mode-700 direct child of HERD_DIR, never under TMPDIR: a worker wall may
      # allow-write TMPDIR, and must not be able to replace this copy.
      elif ! spawn_dir="$(mktemp -d "${herd_dir}/finish-spawner-XXXXXX" 2>/dev/null)"; then
        review_line="needed -- could not create a scratch directory for the spawner; run: ${run_hint}"
      elif ! git -C "$primary" show "${base_before}:${spawner_rel}" > "$spawn_dir/herd-spawn.sh" 2>/dev/null ||
           ! git -C "$primary" show "${base_before}:${lib_rel}" > "$spawn_dir/lib.sh" 2>/dev/null ||
           ! chmod +x "$spawn_dir/herd-spawn.sh" 2>/dev/null; then
        rm -rf "$spawn_dir"
        review_line="needed -- could not read ${spawner_rel} from ${base_before}; run: ${run_hint}"
      else
        chmod 700 "$spawn_dir" 2>/dev/null || true
        # ... and BASE's worker wall beside it (scripts/walls/: the platform plug and its
        # template), so the reviewer is walled like any herd session. Without it the spawner
        # finds no plug and, HERD_WALL unset being require, starts no reviewer: the landing
        # says REVIEW=needed with the command to run. The spawner copies what it runs into
        # $HERD_DIR/walls/<name>/ at spawn, so this directory may go right after. Regular
        # blobs only.
        walls_rel="${spawner_rel%/*}/walls"
        if mkdir "$spawn_dir/walls" 2>/dev/null; then
          git -C "$primary" ls-tree "${base_before}" "${walls_rel}/" 2>/dev/null |
            while read -r w_mode w_type _w_sha w_path; do
              [[ "$w_type" == "blob" && ( "$w_mode" == "100644" || "$w_mode" == "100755" ) ]] || continue
              w_base="${w_path##*/}"
              case "$w_base" in *[!A-Za-z0-9._-]*|.*) continue ;; esac
              git -C "$primary" show "${base_before}:${w_path}" > "$spawn_dir/walls/${w_base}" 2>/dev/null || rm -f "$spawn_dir/walls/${w_base}"
            done || true
        fi
        # ... and BASE's claim-worktree.sh and assert-head.sh (each sources lib.sh, already
        # beside it): the spawner's claim probe runs them behind the wall, and with neither
        # beside it the claim is unproven and, under require, no reviewer starts. Same base
        # commit as the spawner; a BASE without them is left to the probe, which says so.
        # land.sh too: the reviewer is now spawned ON A BRANCH, so herd-spawn records a gate
        # for it and copies BASE's land.sh into its walls/ directory, which the launcher runs
        # when the reviewer's finish-worktree.sh asks for its landing (a walled spawn on a
        # branch with no land.sh beside the spawner is refused).
        for claim_name in claim-worktree.sh assert-head.sh land.sh; do
          git -C "$primary" show "${base_before}:${spawner_rel%/*}/${claim_name}" > "$spawn_dir/${claim_name}" 2>/dev/null ||
            rm -f "$spawn_dir/${claim_name}"
        done
        # ... and BASE's wake-adapter.sh with its wake-adapters/ declarations: the spawner
        # reads each harness's spawn line, input row and resubmit key from them, and stops
        # before typing anything when they are absent. Same base commit and the same
        # top-level, regular-blob, safe-name rule as walls/; a BASE without them predates
        # the adapter, and its spawner does not read one.
        git -C "$primary" show "${base_before}:${spawner_rel%/*}/wake-adapter.sh" > "$spawn_dir/wake-adapter.sh" 2>/dev/null ||
          rm -f "$spawn_dir/wake-adapter.sh"
        if mkdir "$spawn_dir/wake-adapters" 2>/dev/null; then
          git -C "$primary" ls-tree "${base_before}" "${spawner_rel%/*}/wake-adapters/" 2>/dev/null |
            while read -r w_mode w_type _w_sha w_path; do
              [[ "$w_type" == "blob" && ( "$w_mode" == "100644" || "$w_mode" == "100755" ) ]] || continue
              w_base="${w_path##*/}"
              case "$w_base" in *[!A-Za-z0-9._-]*|.*) continue ;; esac
              git -C "$primary" show "${base_before}:${w_path}" > "$spawn_dir/wake-adapters/${w_base}" 2>/dev/null || rm -f "$spawn_dir/wake-adapters/${w_base}"
            done || true
        fi
        # The reviewer's checkout: at the sha main had before this landing, on its receipt
        # branch, under a review root that is a real directory of ours -- checked BEFORE the
        # cleanup walks it, so a review root swapped for a symlink to the session
        # worktrees is walked by nothing (-1). Only what THIS script created is ever
        # removed: an entry whose physical parent is the physical review root, that
        # git lists as a worktree, whose git dir carries the marker this script writes,
        # that is detached or on the receipt branch that marker names, that is a day old
        # or bears this landing's own name, and
        # that no live session holds. A bare `false` here once ended a completed
        # landing under set -e with no REVIEW= line: every branch of this chain sets
        # review_line and falls through.
        [[ -e "$review_root" ]] || mkdir -m 700 "$review_root" 2>/dev/null || true
        review_root_ok=no
        if [[ ! -L "$review_root" && -d "$review_root" && -O "$review_root" ]] &&
           review_root_real="$(cd "$review_root" 2>/dev/null && pwd -P)"; then
          review_root_ok=yes
        fi
        if [[ "$review_root_ok" == "yes" ]]; then
          for old_co in "${review_root}"/*; do
            [[ -d "$old_co" && ! -L "$old_co" ]] || continue
            old_real="$(cd "$old_co" 2>/dev/null && pwd -P)" || continue
            [[ "$(dirname "$old_real")" == "$review_root_real" ]] || continue
            git -C "$primary" worktree list --porcelain 2>/dev/null |
              grep -qFx -e "worktree ${old_co}" -e "worktree ${old_real}" || continue
            old_gd="$(git -C "$old_co" rev-parse --absolute-git-dir 2>/dev/null)" || continue
            [[ -f "${old_gd}/muretai-review-checkout" ]] || continue
            # detached (the older shape), or on exactly the receipt branch the marker names;
            # removing the checkout leaves that branch, and iso_open_at keeps any commit on
            # it as an archive/ tag before the name is used again
            if old_head="$(git -C "$old_co" symbolic-ref -q HEAD 2>/dev/null)"; then
              old_receipt="$(sed -n 's/^receipt_branch=//p' "${old_gd}/muretai-review-checkout" 2>/dev/null | head -1)"
              [[ -n "$old_receipt" && "$old_head" == "refs/heads/${old_receipt}" ]] || continue
            fi
            if [[ "$old_co" == "$review_co" ]] || [[ -n "$(find "$old_co" -maxdepth 0 -mtime +1 2>/dev/null)" ]]; then
              old_lock="$(iso_lock_path "$old_co" 2>/dev/null || true)"
              if [[ -n "$old_lock" && -f "$old_lock" ]] && iso_lock_alive "$old_lock"; then
                continue
              fi
              git -C "$primary" worktree remove --force "$old_co" >/dev/null 2>&1 || true
            fi
          done
          git -C "$primary" worktree prune >/dev/null 2>&1 || true
        fi
        review_err="$(finish_tmp)"
        opened=no
        # On the receipt branch at the pre-landing BASE, held under the reviewer's own key
        # (lib.sh, iso_open_at -- the open `ensure-worktree.sh --at` and the daily engine do).
        # The gate that lands it is BASE's land.sh; a BASE that predates it has none to land
        # through, and its reviewer opens detached, as before.
        [[ -f "$spawn_dir/land.sh" ]] || receipt_branch=""
        if [[ "$review_root_ok" == "yes" && -n "$receipt_branch" && "$receipt_branch" != "feat/" ]] &&
           iso_open_at "$primary" "$review_co" "$receipt_branch" "$base_before" "$review_name" "$receipt_task" >/dev/null 2>"$review_err" &&
           review_gd="$(git -C "$review_co" rev-parse --absolute-git-dir 2>/dev/null)" &&
           printf 'landing=%s\nbase=%s\ntip=%s\nreceipt_branch=%s\n' "$branch" "$base_before" "$base_tip" "$receipt_branch" > "${review_gd}/muretai-review-checkout" 2>/dev/null; then
          opened=yes
        elif [[ "$review_root_ok" == "yes" && -z "$receipt_branch" ]] &&
           git -C "$primary" worktree add --detach "$review_co" "$base_before" >/dev/null 2>"$review_err" &&
           review_gd="$(git -C "$review_co" rev-parse --absolute-git-dir 2>/dev/null)" &&
           printf 'landing=%s\nbase=%s\ntip=%s\n' "$branch" "$base_before" "$base_tip" > "${review_gd}/muretai-review-checkout" 2>/dev/null; then
          opened=yes
        elif [[ "$review_root_ok" != "yes" ]]; then
          printf '%s is not a directory owned by %s\n' "$review_root" "$(id -un)" > "$review_err"
        fi
        if [[ "$opened" != "yes" ]]; then
          echo "note: the reviewer was not spawned: could not open ${review_co} at ${base_before}: $(tail -1 "$review_err" 2>/dev/null || true)" >&2
          review_line="needed -- run: ${run_hint}"
        # ... through `credless`, like every other thing the landing runs on BASE's behalf.
        # The spawner runs pythons of its own -- the re-render of the brief the reviewer is
        # given, and the write of the reviewer's permission list -- and outside this wall
        # both took their answer from whatever `usercustomize.py` a branch's own test run
        # had planted in the user site directory
        # (ISSUE(security-audit-2026-09-18-daily-2026-09-18-7)).
        # The reviewer's own name is the key that holds its receipt branch (herd-spawn's
        # default for a walled spawn), said explicitly so an unwalled spawn carries it too.
        elif spawn_out="$(credless bash "$spawn_dir/herd-spawn.sh" "$review_name" "$review_brief" --cwd "$review_co" --profile reviewer --var "MAIN=${primary}" --env "ISOLATED_SESSION_OWNER=${review_name}" 2>"$review_err")"; then
          review_pane="$(printf '%s\n' "$spawn_out" | sed -n 's/.*pane=\([^ ]*\).*/\1/p' | head -1)"
          review_eyes="$(printf '%s\n' "$spawn_out" | sed -n 's/.*harness=\([^ ]*\) model=\([^ ]*\).*/\1\/\2/p' | head -1)"
          review_line="spawned ${review_name} (pane ${review_pane}${review_eyes:+, ${review_eyes}})"
          # a stubbed spawner is a test's business; the receipt must say so, never "spawned"
          # as if a reviewer were reading the diff (ISSUE(security-audit-2026-09-12-the-guard-override-rule-a-4))
          if [[ -n "${HERD_SPAWN_BIN:-}" ]]; then
            review_line="${review_line} via HERD_SPAWN_BIN=${HERD_SPAWN_BIN}"
          fi
        else
          echo "note: the reviewer was not spawned: $(tail -1 "$review_err" 2>/dev/null || true)" >&2
          review_line="needed -- run: ${run_hint}"
        fi
        rm -f "$review_err"
        rm -rf "$spawn_dir"
      fi
    else
      rm -f "$review_tpl"
      review_line="needed -- could not render ${template_rel}; ${by_hand}"
    fi
  fi
fi
# Cadence said daily and the job is not installed: the spawn above is the no-cadence
# path, and the receipt says why. A set ISOLATED_SESSION_LAND_REVIEW still decides
# this landing alone and does not get this note.
if [[ "$sec_verdict" == "needs-eyes" && "$base_before" != "$base_tip" && -z "${ISOLATED_SESSION_LAND_REVIEW+set}" && "$review_cadence" == "daily" && "$daily_job_installed" != "yes" ]]; then
  review_line="${review_line} -- daily cadence set but the daily job is not installed"
fi
echo "REVIEW=${review_line}"

if git -C "$primary" remote get-url origin >/dev/null 2>&1 &&
   git -C "$primary" rev-parse --verify --quiet "origin/${base}" >/dev/null; then
  ahead="$(git -C "$primary" rev-list --count "origin/${base}..${base}" 2>/dev/null || echo 0)"
  if [[ "$ahead" != "0" ]]; then
    echo "NOTE: local ${base} is ${ahead} commit(s) ahead of origin/${base}."
    echo "NOTE: pushing ${base} is the owner's call -- this script does not do it, and the pre-push hook"
    echo "NOTE: refuses every push without it: ISOLATED_SESSION_PUSH=1 git push origin ${base}"
  fi
fi

# Last, because `credless` is what runs the reviewer's spawner above and the wall it
# hands that spawner is this directory. It used to be removed right after
# WORKTREE_REMOVED=, which is before the brief render and before the spawn.
rm -rf "${ISO_GH_EMPTY:-/nonexistent/iso-gh}"
}
