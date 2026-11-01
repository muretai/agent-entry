#!/usr/bin/env bash
# The weekly hunt's full-receipt writer, and the weekly profile's one rule beyond the
# reviewer's:
#   write-weekly-receipt.sh tools/audit_scope.py write-receipt --full --slug weekly-YYYY-MM-DD \
#     --findings <N> --verdict <clean|findings-filed> --notes <notes-file>
# Exactly those eleven arguments, the fixed ones as spelled: the line names the command it
# runs, so the brief and the allow rule say what happens. It runs
# `python3 -I tools/audit_scope.py write-receipt --full` with the slug, the count, the
# verdict and the notes file's text as literal argv. Only a `weekly-YYYY-MM-DD` slug is
# taken, and only from the pane `audit-YYYY-MM-DD` of the same date (HERD_WORKER), the name
# tools/security_weekly.sh gives the hunt. The notes file is held to write-receipt.sh's
# rule: a regular file directly inside this pane's own herd directory (the directory of
# HERD_REPORT, whose last component is HERD_WORKER), walked with no symlink step and no
# `..`. A --range, a baseline (no --full), or any other argument is refused before
# audit_scope.py runs. The per-landing reviewer profile does not allow this script, and
# write-receipt.sh still refuses --full (ISSUE(security-audit-2026-10-09-pin-that-the-reviewe-0034)).
set -euo pipefail
export LC_ALL=C
unset CDPATH

refuse() {
  echo "write-weekly-receipt.sh: refused: $1" >&2
  echo "usage: write-weekly-receipt.sh tools/audit_scope.py write-receipt --full --slug weekly-YYYY-MM-DD --findings <N> --verdict <clean|findings-filed> --notes <notes-file>" >&2
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

if [[ $# -ne 11 ]]; then
  refuse "exactly eleven arguments are required (got $#)"
fi

# The fixed words, in their places
if [[ "$1" != "tools/audit_scope.py" || "$2" != "write-receipt" || "$3" != "--full" \
      || "$4" != "--slug" || "$6" != "--findings" || "$8" != "--verdict" \
      || "${10}" != "--notes" ]]; then
  refuse "the fixed arguments are not as spelled (no --range, no baseline, nothing else)"
fi

slug="$5"
findings="$7"
verdict="$9"
notes_file="${11}"

case "$slug" in
  weekly-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) refuse "the slug is weekly-YYYY-MM-DD and nothing else" ;;
esac
case "$findings" in
  ""|*[!0-9]*) refuse "the finding count is a number" ;;
esac
case "$verdict" in
  clean|findings-filed) ;;
  *) refuse "the verdict is clean or findings-filed" ;;
esac
case "$notes_file" in -*|"") refuse "the notes file is a path" ;; esac

if [[ -z "${HERD_WORKER-}" || -z "${HERD_REPORT-}" ]]; then
  refuse "HERD_WORKER and HERD_REPORT are required"
fi
if [[ "$HERD_WORKER" != "audit-${slug#weekly-}" ]]; then
  refuse "only the weekly hunt audit-${slug#weekly-} writes the ${slug} receipt"
fi

report_dir="$(dirname -- "$HERD_REPORT")"
allowed="$(resolve_nofollow "$report_dir")" || refuse "the report directory does not resolve"
if [[ -L "$allowed" || ! -d "$allowed" ]]; then
  refuse "the report directory is not a directory"
fi
if [[ "${allowed##*/}" != "$HERD_WORKER" ]]; then
  refuse "HERD_WORKER does not match the report directory"
fi

resolved="$(resolve_nofollow "$notes_file")" || refuse "the notes path does not resolve"
if [[ -L "$resolved" || ! -f "$resolved" ]]; then
  refuse "the notes path is not a regular file"
fi
if [[ "$(dirname -- "$resolved")" != "$allowed" ]]; then
  refuse "the notes file is not directly inside the pane directory"
fi

# The file's text, as data. The substitution does not run that text.
notes="$(cat -- "$resolved")"

exec python3 -I tools/audit_scope.py write-receipt \
  --full \
  --slug "$slug" \
  --verdict "$verdict" \
  --findings "$findings" \
  --notes "$notes"
