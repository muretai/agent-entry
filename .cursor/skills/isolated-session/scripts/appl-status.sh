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
# -- is refused. Any other status (`routed mac-b`, `blocked ...`) may be set.
#
# A value carrying a line break or any other control character is refused: it would
# forge a second header field. Every refusal is a non-zero exit with one stderr line and
# nothing written. The file is rewritten through a temporary file in the same directory
# and an atomic rename.
#
# One line is appended to $HERD_DIR/coordinator/coordinator.log:
#   <UTC time> <verb> <intake file name> [<last status word>]
# the verb `blocked`, `question`, `landed` or `status` by the status's first word, and the
# last word only when it is a plain name or a range -- never the question text, never
# free text. The log is opened append-only and never through a symlink.
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

python3 -I - "${herd%/}/coordinator" "$intake" "$words" "$has_question" "$question" <<'PY'
import os, re, sys, tempfile, time

coord, intake, words, has_q, question = sys.argv[1:6]
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
if os.path.islink(intake) or not os.path.isfile(intake):
    refuse("no intake file there (or a symlink)")

with open(intake, encoding="utf-8") as f:
    text = f.read()
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
lines[status_at] = "status: " + words
if has_q == "yes":
    q_at = next((i for i in range(end) if lines[i].startswith("question:")), None)
    if q_at is None:
        lines.insert(status_at + 1, "question: " + question)
    else:
        lines[q_at] = "question: " + question

fd, tmp = tempfile.mkstemp(prefix=".status-", dir=os.path.dirname(intake))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    os.chmod(tmp, os.stat(intake).st_mode & 0o777)
    os.replace(tmp, intake)
except BaseException:
    if os.path.lexists(tmp):
        os.unlink(tmp)
    raise

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
PY
