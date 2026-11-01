#!/usr/bin/env bash
# Append one coordinator log line. The coordinator's allow list names this script
# and does not name printf or date, so a log line is not a "Run this command?" stop.
#
#   appl-note.sh <verb> <name> [<name or range>]
#
# <verb> is one word from the coordinator's own vocabulary. The four verbs
# herd-watch.sh writes (swept, sweep-refused, logged-out, and the close it logs
# itself) are refused. <name> is one token: a worker or an intake file name.
# The optional third token is a worker or a commit range. No spaces, no slash,
# no control character. Anything else is a non-zero exit, one stderr line, and
# nothing written.
#
# One line is appended to $HERD_DIR/coordinator/coordinator.log (HERD_DIR
# defaults to ~/.cache/muretai-herd):
#   <UTC time> <verb> <name> [<third>]
# The log is opened append-only and never through a symlink.
#
# No model, no herdr, no network.
set -euo pipefail

if [[ $# -ne 2 && $# -ne 3 ]]; then
  echo "usage: appl-note.sh <verb> <name> [<name or range>]" >&2
  exit 2
fi

herd="${HERD_DIR:-${HOME:-}/.cache/muretai-herd}"
exec python3 -I - "${herd%/}/coordinator" "$1" "$2" "${3:-}" <<'PY'
import os, re, sys, time

coord, verb, name, extra = sys.argv[1:5]
VERBS = {
    "intake", "spawn", "status", "verified", "blocked", "landed", "review",
    "question", "mail", "prompt-left", "ignored", "resumed", "closed",
    "brief", "unrecorded", "handback", "reprompt",
}
TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,200}")
RANGE = re.compile(r"[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}")


def refuse(why):
    print("appl-note: " + why + "; nothing was written", file=sys.stderr)
    sys.exit(1)


def bad(value):
    return any(ord(ch) < 32 or ord(ch) == 127 for ch in value)


if verb not in VERBS or bad(verb):
    refuse("the verb is not one this script writes")
if bad(name) or not TOKEN.fullmatch(name):
    refuse("the name is not one token")
if extra and (bad(extra) or not (TOKEN.fullmatch(extra) or RANGE.fullmatch(extra))):
    refuse("the third token is not a name or a range")
if os.path.islink(coord):
    refuse("the coordinator directory is a symlink")
log = os.path.join(coord, "coordinator.log")
if os.path.islink(log):
    refuse("the log is a symlink")
line = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + verb + " " + name
if extra:
    line += " " + extra
try:
    os.makedirs(coord, 0o700, exist_ok=True)
    if os.path.islink(coord) or os.path.islink(log):
        refuse("the log path is a symlink")
    fd = os.open(log, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
except OSError as e:
    refuse("the log was not written: " + (e.strerror or "an OS error"))
with os.fdopen(fd, "a", encoding="utf-8") as f:
    f.write(line + "\n")
PY
