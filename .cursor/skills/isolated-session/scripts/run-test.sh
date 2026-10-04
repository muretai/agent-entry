#!/usr/bin/env bash
# Path-first test runner: `run-test.sh tests/<file>.py` runs `python3 -I tests/<file>.py`
# (python3 found through PATH) and exits with its status. A permission profile can allow
# this one fixed shape instead of `python3 -I <anything>`, so the argument is checked
# here and never evaluated: exactly one argument, a file directly under tests/, a name of
# letters, digits, `_`, `-` and `.` only, not starting with `-` or `.`, ending in `.py`.
# Anything else is refused with exit 2 and nothing runs.
set -euo pipefail
export LC_ALL=C

refuse() {
  echo "run-test.sh: refused: $1" >&2
  echo "usage: run-test.sh tests/<file>.py" >&2
  exit 2
}

if [[ $# -ne 1 ]]; then
  refuse "exactly one argument is required (got $#)"
fi
arg="$1"
if [[ -z "$arg" ]]; then
  refuse "empty argument"
fi
case "$arg" in
  tests/*) ;;
  *) refuse "not a path under tests/" ;;
esac
name="${arg#tests/}"
case "$name" in
  ''|*/*) refuse "not a file directly under tests/" ;;
esac
case "$name" in
  *[!A-Za-z0-9_.-]*) refuse "the file name holds a character outside letters, digits, _ - ." ;;
esac
case "$name" in
  -*|.*) refuse "the file name starts with - or ." ;;
  *..*) refuse "the path holds .." ;;
esac
case "$name" in
  *.py) ;;
  *) refuse "not a .py file" ;;
esac

exec python3 -I "$arg"
