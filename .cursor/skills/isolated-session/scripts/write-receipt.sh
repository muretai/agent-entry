#!/usr/bin/env bash
# Path-first receipt writer: `write-receipt.sh <range> <slug> <verdict> <findings> <notes-file>`
# reads the notes from a regular file and runs
# `python3 -I tools/audit_scope.py write-receipt` with those four values and the file's
# text as literal argv. A permission profile can allow this one fixed shape. The notes
# file must be a regular file directly inside this pane's own herd directory, which is
# the directory of HERD_REPORT, and that directory's last component must be HERD_WORKER.
# The path is walked with no symlink step and no `..`. Exactly five arguments; a
# flag-shaped argument is refused before audit_scope.py runs. Nothing is executed out
# of the notes or the arguments.
set -euo pipefail
export LC_ALL=C
unset CDPATH

refuse() {
  echo "write-receipt.sh: refused: $1" >&2
  echo "usage: write-receipt.sh <range> <slug> <verdict> <findings> <notes-file>" >&2
  exit 2
}

# Absolute spelling of a path. Every step must already exist, must not be a symlink,
# and must not be `..`. Prints the path; returns 1 when it does not qualify.
resolve_nofollow() {
  local raw="$1" rest part acc
  case "$raw" in
    "") return 1 ;;
    /*) ;;
    *) raw="${PWD%/}/$raw" ;;
  esac
  case "$raw" in
    *$'\n'*|*$'\r'*) return 1 ;;
  esac
  acc=""
  rest="${raw#/}"
  while [[ -n "$rest" ]]; do
    part="${rest%%/*}"
    case "$rest" in
      */*) rest="${rest#*/}" ;;
      *) rest="" ;;
    esac
    case "$part" in
      ""|.) continue ;;
      ..) return 1 ;;
    esac
    acc="${acc}/${part}"
    if [[ -L "$acc" ]]; then
      return 1
    fi
    if [[ ! -e "$acc" ]]; then
      return 1
    fi
  done
  [[ -n "$acc" ]] || return 1
  printf '%s\n' "$acc"
}

if [[ $# -ne 5 ]]; then
  refuse "exactly five arguments are required (got $#)"
fi

range="$1"
slug="$2"
verdict="$3"
findings="$4"
notes_file="$5"

case "$range" in -*) refuse "a flag-shaped argument is not accepted" ;; esac
case "$slug" in -*) refuse "a flag-shaped argument is not accepted" ;; esac
case "$verdict" in -*) refuse "a flag-shaped argument is not accepted" ;; esac
case "$findings" in -*) refuse "a flag-shaped argument is not accepted" ;; esac
case "$notes_file" in -*) refuse "a flag-shaped argument is not accepted" ;; esac

# An empty range is not a range: audit_scope.py would treat it as "no --range" and
# might write a baseline receipt. Refuse it here so nothing is written.
if [[ -z "$range" ]]; then
  refuse "the range is empty"
fi

if [[ -z "${HERD_WORKER-}" || -z "${HERD_REPORT-}" ]]; then
  refuse "HERD_WORKER and HERD_REPORT are required"
fi

report_dir="$(dirname -- "$HERD_REPORT")"
allowed="$(resolve_nofollow "$report_dir")" || refuse "the report directory does not resolve"
if [[ -L "$allowed" || ! -d "$allowed" ]]; then
  refuse "the report directory is not a directory"
fi
allowed_name="${allowed##*/}"
if [[ "$allowed_name" != "$HERD_WORKER" ]]; then
  refuse "HERD_WORKER does not match the report directory"
fi

if [[ -z "$notes_file" ]]; then
  refuse "the notes file is empty"
fi
resolved="$(resolve_nofollow "$notes_file")" || refuse "the notes path does not resolve"
if [[ -L "$resolved" || ! -f "$resolved" ]]; then
  refuse "the notes path is not a regular file"
fi
notes_dir="$(dirname -- "$resolved")"
if [[ "$notes_dir" != "$allowed" ]]; then
  refuse "the notes file is not directly inside the pane directory"
fi

# The file's text, as data. The substitution does not run that text.
notes="$(cat -- "$resolved")"

exec python3 -I tools/audit_scope.py write-receipt \
  --range "$range" \
  --slug "$slug" \
  --verdict "$verdict" \
  --findings "$findings" \
  --notes "$notes"
