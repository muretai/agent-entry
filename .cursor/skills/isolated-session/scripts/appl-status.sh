#!/usr/bin/env bash
# Set an APPL intake's `status:` line, and log the change in the coordinator's fixed
# vocabulary.
#
#   appl-status.sh <intake file> "<status words>" [--question "<one line>"]
#
# The intake must be a regular file (not a symlink) DIRECTLY under
# $HERD_DIR/coordinator/intake/ (HERD_DIR defaults to ~/.cache/muretai-herd), named
# `<name>.md`. Only the HEADER is touched: the lines before the first blank line, where
# tools/appl-add.sh writes `status: new`. The `## Task` below it is data another session
# wrote, and a `status:` line inside it is text, never the intake's status -- so the
# first header `status:` line is replaced and nothing after the blank line is read as a
# field. `--question` also sets (or replaces) one header `question: <line>` line.
#
# An intake whose HEADER says `mac: B` is Mac B's (appl-hook.sh mails it there and records
# `routed mac-b`): a status that hands it to a worker here -- `tests|impl|review|solo ...`
# -- is refused. Any other status (`routed mac-b`, `blocked ...`) may be set, except
# `blocked spawn-freeze`: idle and done panes do not hold a worker-cap slot, and that
# status was a coordinator parking intakes without calling herd-spawn.sh. It is refused
# and the file is left as it was; herd-watch.sh puts an intake already carrying it back
# to `new`.
#
# A value carrying a line break or any other control character is refused: it would
# forge a second header field. Every refusal is a non-zero exit with one stderr line and
# nothing written. The file is rewritten through a temporary file in the same directory
# and an atomic rename, at the bytes level: a header or task that is not valid UTF-8 is
# kept byte for byte, only the lines set here change, and the mode is kept.
#
# No link is ever followed, even one a walled worker swaps into coordinator/intake/ while
# the status is being written: the intake is opened O_NOFOLLOW and refused when the open
# fd is not the inode the lstat saw (st_dev/st_ino); its mode is taken with fstat on that
# fd and set with fchmod on the temporary file's own fd; and the rename is refused when
# what sits at the temporary path is no longer the file written (security review of
# 40d488f..fe0fe92). Such a swap is a refusal: no status-failed marker, no log line, and
# only a temporary file still identified as this run's own is removed.
#
# A write that fails (no temporary file can be made, the rename is refused) is a non-zero
# exit with one stderr line, and leaves $HERD_DIR/.watch/status-failed/<intake file name>
# (the intake's mtime in ns; .watch/ is outside every worker's wall): herd-watch.sh stops
# re-typing that intake from its next pass. A later write that succeeds removes it.
#
# One line is appended to $HERD_DIR/coordinator/coordinator.log:
#   <UTC time> <verb> <intake file name> [<last status word>]
# the verb `blocked`, `question`, `landed` or `status` by the status's first word, and the
# last word only when it is a plain name or a range -- never the question text, never
# free text. The log is opened append-only and never through a symlink.
#
# And one `status-change` line goes to the run ledger $HERD_DIR/coordinator/runs.jsonl
# through run_ledger.py beside this script (never a symlinked module): old is the header's
# status before, new the status words set, category the log line's verb, intake_id the
# header's `id:`. The question text is never passed. A ledger that refuses the line or
# cannot be written never blocks the change: the status stays set, the exit stays 0, and
# the failure is one stderr line.
#
# No model, no herdr, no network (plan 2026-09-19 "coordinator harness", A.2).
set -euo pipefail

herd="${HERD_DIR:-${HOME:-}/.cache/muretai-herd}"
if [[ $# -ne 2 && $# -ne 4 ]]; then
  echo "usage: appl-status.sh <intake file> \"<status words>\" [--question \"<one line>\"]" >&2
  exit 2
fi
intake="$1"
words="$2"
question=""
has_question=no
if [[ $# -eq 4 ]]; then
  if [[ "$3" != "--question" ]]; then
    echo "usage: appl-status.sh <intake file> \"<status words>\" [--question \"<one line>\"]" >&2
    exit 2
  fi
  question="$4"
  has_question=yes
fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || here=""

python3 -I - "${herd%/}/coordinator" "$intake" "$words" "$has_question" "$question" "${here:+$here/run_ledger.py}" <<'PY'
import os, re, stat, sys, tempfile, time

coord, intake, words, has_q, question, ledger_py = sys.argv[1:7]
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
RANGE = re.compile(r"[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}")
# the status words that hand an intake to a worker on this Mac: `<slot> <w> ...`
SLOTS = ("tests", "impl", "review", "solo")


def refuse(why):
    print("appl-status: " + why + "; nothing was written", file=sys.stderr)
    sys.exit(1)


def clean(value, what):
    if not value.strip():
        refuse(what + " is empty")
    if any(ord(c) < 0x20 or ord(c) == 0x7f for c in value):
        refuse(what + " carries a line break or a control character")
    return value.strip()


words = clean(words, "the status")
if words.split() == ["blocked", "spawn-freeze"]:
    refuse("idle and done do not hold a worker-cap slot; spawn with herd-spawn.sh; "
           "blocked spawn-freeze is not a status")
if has_q == "yes":
    question = clean(question, "the question")

intake_dir = os.path.join(coord, "intake")
base = os.path.basename(intake)
if not intake.startswith("/"):
    refuse("the intake is named by an absolute path")
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,124}\.md", base):
    refuse("not an intake file name")
if not os.path.isdir(intake_dir) or os.path.realpath(os.path.dirname(intake)) != os.path.realpath(intake_dir):
    refuse("not a file directly under " + intake_dir)
try:
    seen = os.lstat(intake)
except OSError:
    seen = None
if seen is None or not stat.S_ISREG(seen.st_mode):
    refuse("no intake file there (or a symlink)")

# Opened O_NOFOLLOW and checked on its fd: an intake swapped for a link or for another file
# after the lstat is refused, never followed (security review of 40d488f..fe0fe92).
try:
    ifd = os.open(intake, os.O_RDONLY | os.O_NOFOLLOW)
except OSError as e:
    refuse("the intake could not be opened without following a link: " + (e.strerror or "an OS error"))
# Bytes, decoded with surrogateescape and never newline-translated: an intake whose task
# holds bytes that are not UTF-8 (Latin-1, a cut sequence, a CR) round-trips byte for byte.
# A strict decode raised on every write, the header stayed `new` and the watchdog re-typed
# it forever (security review of 65163eb, finding 1).
with os.fdopen(ifd, "rb") as f:
    held = os.fstat(f.fileno())
    if (held.st_dev, held.st_ino) != (seen.st_dev, seen.st_ino) or not stat.S_ISREG(held.st_mode):
        refuse("the intake was swapped for another file after it was checked")
    text = f.read().decode("utf-8", "surrogateescape")
lines = text.split("\n")
try:
    end = lines.index("")
except ValueError:
    end = len(lines)
status_at = next((i for i in range(end) if lines[i].startswith("status:")), None)
if status_at is None:
    refuse("the intake header carries no status: line")
mac_at = next((i for i in range(end) if lines[i].startswith("mac:")), None)
if (mac_at is not None and lines[mac_at][len("mac:"):].strip() == "B"
        and words.split()[0] in SLOTS):
    refuse("the intake header says `mac: B`: it is Mac B's to spawn, never handed to a worker here")
old_status = lines[status_at][len("status:"):].strip()
id_at = next((i for i in range(end) if lines[i].startswith("id:")), None)
intake_id = lines[id_at][len("id:"):].strip() if id_at is not None else ""
lines[status_at] = "status: " + words
if has_q == "yes":
    q_at = next((i for i in range(end) if lines[i].startswith("question:")), None)
    if q_at is None:
        lines.insert(status_at + 1, "question: " + question)
    else:
        lines[q_at] = "question: " + question

watch = os.path.join(os.path.dirname(coord), ".watch")
marker = os.path.join(watch, "status-failed", base)


def mark_failed(mtime_ns):
    """<HERD_DIR>/.watch/status-failed/<intake name>, the intake's mtime in ns: outside every
    worker's wall, never written through a link, best effort"""
    d = os.path.dirname(marker)
    try:
        for p in (watch, d):
            if os.path.islink(p):
                return
            if not os.path.isdir(p):
                os.mkdir(p, 0o700)
        mfd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(mfd, "w", encoding="ascii") as f:
            f.write("%d\n" % mtime_ns)
    except OSError:
        pass


def same_file(a, b):
    return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)


def drop_tmp():
    """unlink the temporary path only while it is still the file this run made"""
    if tmp is None or made is None:
        return
    try:
        if same_file(os.lstat(tmp), made):
            os.unlink(tmp)
    except OSError:
        pass


tmp = None
made = None
swapped = False
mtime_ns = held.st_mtime_ns
try:
    fd, tmp = tempfile.mkstemp(prefix=".status-", dir=os.path.dirname(intake))
    with os.fdopen(fd, "wb") as f:
        made = os.fstat(f.fileno())
        f.write("\n".join(lines).encode("utf-8", "surrogateescape"))
        f.flush()
        # the mode through the temporary file's own fd: a link planted at its path is never chmodded
        os.fchmod(f.fileno(), held.st_mode & 0o777)
    # what sits at the temporary path must still be the file written, or the rename would
    # move a worker's planted link onto the intake
    if same_file(os.lstat(tmp), made):
        os.replace(tmp, intake)
    else:
        swapped = True
except OSError as e:
    drop_tmp()
    # a write that failed once fails again: the marker stops the watchdog re-typing the intake
    mark_failed(mtime_ns)
    print("appl-status: the status was not written: " + (e.strerror or "an OS error"), file=sys.stderr)
    sys.exit(1)
except BaseException:
    drop_tmp()
    raise
if swapped:
    # a refusal, not a failed write: no status-failed marker, no log line
    drop_tmp()
    refuse("the temporary file was swapped for another file before the rename")
if os.path.lexists(marker) and not os.path.islink(os.path.dirname(marker)):
    try:
        os.unlink(marker)
    except OSError:
        pass

parts = words.split()
verb = {"blocked": "blocked", "question": "question", "landed": "landed"}.get(parts[0], "status")
if has_q == "yes":
    verb = "question"
line = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + verb + " " + base
last = parts[-1] if len(parts) > 1 else ""
if verb != "question" and (NAME.fullmatch(last) or RANGE.fullmatch(last)):
    line += " " + last
try:
    fd = os.open(os.path.join(coord, "coordinator.log"), os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write(line + "\n")
except OSError as e:
    print("appl-status: the status is set, but the log line was not written: " + e.strerror, file=sys.stderr)

# the run ledger: best effort, after the change, so a failure never blocks it
try:
    if not ledger_py or not os.path.isfile(ledger_py) or os.path.islink(ledger_py):
        raise OSError("run_ledger.py is not beside appl-status.sh")
    # compiled from the source, so a cached or planted __pycache__ pyc is never read
    import types
    run_ledger = types.ModuleType("run_ledger")
    run_ledger.__file__ = ledger_py
    with open(ledger_py, "rb") as f:
        exec(compile(f.read(), ledger_py, "exec"), run_ledger.__dict__)
    run_ledger.append(event="status-change", intake_id=intake_id, worker="", keys={"old": old_status, "new": words, "category": verb},
                      herd_dir=os.path.dirname(coord))
except Exception as e:                       # noqa: BLE001 -- the ledger never blocks a status change
    print("appl-status: the status is set, but no status-change line went to the run ledger: %s" % e,
          file=sys.stderr)
PY
