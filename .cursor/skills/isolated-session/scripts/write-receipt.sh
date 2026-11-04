#!/usr/bin/env bash
# Path-first receipt writer: `write-receipt.sh <range> <slug> <verdict> <findings> <notes-file>`
# reads the notes from a regular file and runs
# `python3 -I tools/audit_scope.py write-receipt` (or the pinned APPL install's copy, see
# below) with those four values and the file's text as literal argv. A permission profile can allow this one fixed shape. The notes
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

# Which audit_scope.py writes the receipt: the repository's own tools/audit_scope.py when
# it has one, else the one of the APPL install its appl.toml pins, ~/.appl/<X.Y.Z>/tools/.
# The pin is the top-level `version = "X.Y.Z"` line (reading stops at the first table
# header, as bin/appl's read_pin does); a pin that is not a plain X.Y.Z is refused, never
# taken as a path. Last, for a wall copy only: the spawner's tools dir, which herd-spawn.sh
# names in write-receipt.tools beside the copy in walls/<HERD_WORKER>/ (intake
# 20261029T142027Z). That file is read as data, never sourced; with no such file the
# pinned install's refusals stand. No other copy is guessed: no `..`, no path relative to
# this file beyond that one named file.

# The pinned install's audit_scope.py into $audit. Returns 1, with the reason in $why,
# when there is no pin to follow or its install is absent; refuses outright on a pin or
# install that is there but wrong.
#
# <v> is taken in this order (intake 20261101T103611Z):
#   1. a top-level `version = "X.Y.Z"` pin;
#   2. `version = "latest"`: the numerically highest ~/.appl/X.Y.Z that is a real
#      directory, not a symlink (latest_version);
#   3. no pin at all (no appl.toml, or no top-level version line): the vendored tag of
#      the cwd-relative .cursor/skills/isolated-session/VENDOR.json (vendor_version).
# Nothing under the repository, the worktree or the branch under review is ever taken as
# the audit tool on these paths: only ~/.appl/<v>/tools/audit_scope.py, with HOME absolute.

# The highest ~/.appl/X.Y.Z into $ver. Each part is 1-9 digits, compared as base-10
# numbers, so 0.1.10 beats 0.1.9. Symlinks, files and any other name are skipped.
latest_version() {
  local appl="$HOME/.appl" cand name a b c best="" ba=0 bb=0 bc=0
  if [[ -L "$appl" ]]; then
    refuse ".appl is a symlink, so the latest APPL install is not looked for"
  fi
  if [[ ! -d "$appl" ]]; then
    why="appl.toml pins version \"latest\" but there is no .appl directory under HOME; run: appl install"
    return 1
  fi
  for cand in "$appl"/*; do
    name="${cand##*/}"
    [[ "$name" =~ ^([0-9]{1,9})\.([0-9]{1,9})\.([0-9]{1,9})$ ]] || continue
    if [[ -L "$cand" || ! -d "$cand" ]]; then
      continue
    fi
    a=$((10#${BASH_REMATCH[1]}))
    b=$((10#${BASH_REMATCH[2]}))
    c=$((10#${BASH_REMATCH[3]}))
    if [[ -z "$best" ]] || (( a > ba || (a == ba && b > bb) || (a == ba && b == bb && c > bc) )); then
      best="$name"
      ba=$a
      bb=$b
      bc=$c
    fi
  done
  if [[ -z "$best" ]]; then
    why="appl.toml pins version \"latest\" but .appl holds no installed X.Y.Z directory; run: appl install"
    return 1
  fi
  ver="$best"
}

# The vendored tag of .cursor/skills/isolated-session/VENDOR.json (cwd-relative) into
# $ver: a regular file, reached with no symlink step, holding a JSON object whose "from"
# is "appl" and whose "ref" is vX.Y.Z. The file is parsed as data by python's json module.
vendor_version() {
  local vj=".cursor/skills/isolated-session/VENDOR.json" step out
  if [[ ! -e "$vj" && ! -L "$vj" ]]; then
    why="this repository has no tools/audit_scope.py, its appl.toml pins no version, and it has no $vj to find an installed one by"
    return 1
  fi
  for step in .cursor .cursor/skills .cursor/skills/isolated-session "$vj"; do
    if [[ -L "$step" ]]; then
      refuse "$vj is reached through a symlink ($step)"
    fi
  done
  if [[ ! -f "$vj" ]]; then
    refuse "$vj is not a regular file"
  fi
  out="$(python3 -I -c '
import json, re, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        d = json.load(f)
except (OSError, ValueError) as e:
    sys.stderr.write("unparsable: %s\n" % type(e).__name__)
    sys.exit(3)
if not isinstance(d, dict):
    sys.stderr.write("not a JSON object\n")
    sys.exit(3)
if d.get("from") != "appl":
    sys.stderr.write("its from is not appl\n")
    sys.exit(3)
ref = d.get("ref")
if not isinstance(ref, str) or not re.fullmatch(r"v[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}", ref):
    sys.stderr.write("its ref is not a vX.Y.Z tag\n")
    sys.exit(3)
sys.stdout.write(ref[1:])
' "$vj" 2>&1)" || refuse "$vj names no APPL vX.Y.Z tag: ${out//$'\n'/ }"
  if [[ ! "$out" =~ ^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$ ]]; then
    refuse "$vj names no APPL vX.Y.Z tag"
  fi
  ver="$out"
}

pinned_audit() {
  local pin="" pin_seen=no line compact ver="" install
  if [[ -e appl.toml || -L appl.toml ]]; then
    if [[ -L appl.toml || ! -f appl.toml ]]; then
      refuse "appl.toml is a symlink or not a regular file"
    fi
    if [[ ! -r appl.toml ]]; then
      refuse "appl.toml is unreadable"
    fi
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        ''|\#*) continue ;;
        [[:space:]]\#*) continue ;;
      esac
      compact="$(printf '%s' "$line" | tr -d ' \t')"
      case "$compact" in
        \[*) break ;;
        version=*)
          pin="${compact#version=}"
          pin_seen=yes
          break
          ;;
      esac
    done < appl.toml || refuse "appl.toml could not be read"
  fi
  if [[ "$pin_seen" == "yes" && "$pin" != '"latest"' && ! "$pin" =~ ^\"[0-9]+\.[0-9]+\.[0-9]+\"$ ]]; then
    why="the appl.toml version pin is not a plain X.Y.Z version string or \"latest\""
    return 1
  fi
  if [[ "$pin_seen" != "yes" ]]; then
    vendor_version || return 1
  fi
  if [[ -z "${HOME-}" || "$HOME" != /* ]]; then
    why="HOME is unset or not absolute, so the APPL install under .appl is unknown"
    return 1
  fi
  case "$HOME/" in
    */../*|*/./*)
      why="HOME has a dot step, so the APPL install under .appl is unknown"
      return 1
      ;;
  esac
  if [[ -L "$HOME/.appl" ]]; then
    refuse ".appl is a symlink"
  fi
  if [[ "$pin" == '"latest"' ]]; then
    latest_version || return 1
  elif [[ "$pin_seen" == "yes" ]]; then
    ver="${pin#\"}"
    ver="${ver%\"}"
  fi
  install="$HOME/.appl/$ver"
  if [[ -L "$install" ]]; then
    refuse ".appl/${ver} is a symlink"
  fi
  if [[ ! -d "$install" ]]; then
    why=".appl/${ver} is not installed (no tools/audit_scope.py here); run: appl install --ref v${ver}"
    return 1
  fi
  if [[ -L "$install/tools" || ! -d "$install/tools" ]]; then
    refuse ".appl/${ver}/tools is a symlink or not a directory"
  fi
  audit="$install/tools/audit_scope.py"
  if [[ -L "$audit" || ! -f "$audit" ]]; then
    refuse ".appl/${ver} has no regular tools/audit_scope.py"
  fi
  if [[ "$pin" == '"latest"' ]]; then
    receipt_from_latest="$ver"
  fi
}

# The spawner's audit_scope.py into $audit, for a wall copy: this file must sit in
# walls/<HERD_WORKER>/ beside a regular write-receipt.tools whose one line is an absolute
# path with no `..` and no symlink step. Returns 1 when this file is no such wall copy.
# Refuses when it is one and the named tools dir holds no regular audit_scope.py.
spawner_audit() {
  local self_dir loc_file loc
  self_dir="$(dirname -- "${BASH_SOURCE[0]}")"
  case "$self_dir" in
    */walls/"$HERD_WORKER") ;;
    *) return 1 ;;
  esac
  loc_file="$self_dir/write-receipt.tools"
  if [[ -L "$loc_file" || ! -f "$loc_file" ]]; then
    return 1
  fi
  IFS= read -r loc < "$loc_file" || [[ -n "${loc-}" ]] || refuse "$why, and $loc_file could not be read"
  case "$loc" in
    /*) ;;
    *) refuse "$why, and $loc_file names no absolute tools dir" ;;
  esac
  case "/$loc/" in
    */../*|*/./*) refuse "$why, and $loc_file names a path with a dot step" ;;
  esac
  audit="$(resolve_nofollow "$loc/audit_scope.py")" ||
    refuse "$why, and the spawner's tools dir $loc holds no audit_scope.py"
  if [[ -L "$audit" || ! -f "$audit" ]]; then
    refuse "$why, and the spawner's tools dir $loc holds no regular audit_scope.py"
  fi
}

audit="tools/audit_scope.py"
why=""
receipt_from_latest=""
if [[ ! -f "$audit" ]]; then
  if ! pinned_audit; then
    spawner_audit || refuse "$why"
  fi
fi

# A latest pin names the install this receipt actually ran, so the landing stays reproducible.
if [[ -n "$receipt_from_latest" ]]; then
  printf 'APPL=%s resolved from latest\n' "$receipt_from_latest"
fi

exec python3 -I "$audit" write-receipt \
  --range "$range" \
  --slug "$slug" \
  --verdict "$verdict" \
  --findings "$findings" \
  --notes "$notes"
