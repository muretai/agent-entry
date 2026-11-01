#!/usr/bin/env bash
# Read one harness's wake adapter declaration, or the machine.toml knob that selects one.
#
#   wake-adapter.sh show NAME
#   wake-adapter.sh select
#   wake-adapter.sh knob
#
# A declaration is wake-adapters/NAME next to this script: a regular file, not a
# symlink, of `key = value` lines, with `#` comment lines and blank lines allowed.
# Every key below must be present once with a non-empty value; coordinator_eligible
# and wake_target are yes or no, and submit_check is box or bar. spawn_clause is the
# sentence herd-spawn.sh adds to the spawn line on how to open the brief, or `none`.
# NAME is one plain segment of a-z, 0-9 and `-`.
# show prints one `key=value` line per key. A refusal prints nothing on stdout and
# names the harness and the key on stderr.
#
# select reads the [wake] table of the machine file, $APPL_MACHINE_CONFIG or else
# $HOME/.config/appl/machine.toml:
#
#   [wake]
#   adapter = "claude"
#
# No file, no [wake] table or no adapter key selects claude. An empty, unknown or
# path-shaped value is refused on stderr by its value. The selected declaration is
# checked as show checks it, then its name is the one stdout line. knob prints the value
# the [wake] table sets, refused as select refuses it, or an empty line when it sets none.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
KEYS="hook_registration hook_output wake_line input_row resubmit seat_sentence coordinator_eligible wake_target spawn_clause submit_check"
DEFAULT_ADAPTER="claude"

refuse() {
  printf 'wake-adapter: %s\n' "$1" >&2
  exit 1
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# One plain segment naming a declaration file that is regular and not a symlink.
check_name() {
  local name="$1"
  case "$name" in
    ""|*[!a-z0-9-]*|-*|*-)
      refuse "refused adapter ${name}: not a harness name"
      ;;
  esac
  local file="${here}/wake-adapters/${name}"
  if [[ -L "$file" || ! -f "$file" ]]; then
    refuse "refused adapter ${name}: no declaration"
  fi
}

show() {
  local name="$1"
  check_name "$name"
  local file="${here}/wake-adapters/${name}"
  local key line val k ref
  for k in $KEYS; do
    printf -v "v_${k}" '%s' ""
    printf -v "seen_${k}" '%s' "0"
  done
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="$(trim "$line")"
    case "$line" in
      ""|"#"*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *) refuse "${name}: a line that is not key = value: ${line}" ;;
    esac
    key="$(trim "${line%%=*}")"
    val="$(trim "${line#*=}")"
    case " ${KEYS} " in
      *" ${key} "*) ;;
      *) refuse "${name}: unknown key ${key}" ;;
    esac
    ref="seen_${key}"
    k="${!ref}"
    if [[ "$k" != "0" ]]; then
      refuse "${name}: ${key} is declared twice"
    fi
    printf -v "seen_${key}" '%s' "1"
    printf -v "v_${key}" '%s' "$val"
  done < "$file"
  for k in $KEYS; do
    ref="v_${k}"
    val="${!ref}"
    if [[ -z "$val" ]]; then
      refuse "${name}: missing ${k}"
    fi
  done
  for k in coordinator_eligible wake_target; do
    ref="v_${k}"
    val="${!ref}"
    case "$val" in
      yes|no) ;;
      *) refuse "${name}: ${k} is ${val}, not yes or no" ;;
    esac
  done
  case "$v_submit_check" in
    box|bar) ;;
    *) refuse "${name}: submit_check is ${v_submit_check}, not box or bar" ;;
  esac
  for k in $KEYS; do
    ref="v_${k}"
    val="${!ref}"
    printf '%s=%s\n' "$k" "$val"
  done
}

# The adapter value of the [wake] table, or $1 when there is none (the default when no
# $1 is given).
knob() {
  local dflt="${1-$DEFAULT_ADAPTER}"
  local cfg
  if [[ -n "${APPL_MACHINE_CONFIG:-}" ]]; then
    cfg="$APPL_MACHINE_CONFIG"
  else
    cfg="${HOME:-}/.config/appl/machine.toml"
  fi
  if [[ ! -e "$cfg" ]]; then
    printf '%s' "$dflt"
    return 0
  fi
  [[ -f "$cfg" ]] || refuse "wake: ${cfg} is not a regular file"
  local line head raw val rest quote in_wake=0 found=0 value=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="$(trim "$line")"
    case "$line" in
      ""|"#"*) continue ;;
      "["*)
        head="$(trim "${line%%#*}")"
        if [[ "$head" == "[wake]" ]]; then in_wake=1; else in_wake=0; fi
        continue
        ;;
    esac
    [[ "$in_wake" == "1" ]] || continue
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    [[ "$(trim "${line%%=*}")" == "adapter" ]] || continue
    [[ "$found" == "0" ]] || refuse "wake: adapter is set twice"
    found=1
    raw="$(trim "${line#*=}")"
    quote="${raw:0:1}"
    case "$quote" in
      '"'|"'") ;;
      *) refuse "wake: adapter ${raw} is not a quoted string" ;;
    esac
    rest="${raw:1}"
    case "$rest" in
      *"$quote"*) ;;
      *) refuse "wake: adapter ${raw} is not a closed string" ;;
    esac
    val="${rest%%"$quote"*}"
    rest="$(trim "${rest#*"$quote"}")"
    case "$rest" in
      ""|"#"*) ;;
      *) refuse "wake: adapter ${raw} has text after its string" ;;
    esac
    value="$val"
  done < "$cfg"
  if [[ "$found" == "0" ]]; then
    printf '%s' "$dflt"
    return 0
  fi
  [[ -n "$value" ]] || refuse "wake: adapter is empty"
  printf '%s' "$value"
}

case "${1:-}" in
  show)
    [[ $# -eq 2 ]] || refuse "usage: wake-adapter.sh show NAME"
    out="$(show "$2")"
    printf '%s\n' "$out"
    ;;
  select)
    [[ $# -eq 1 ]] || refuse "usage: wake-adapter.sh select"
    name="$(knob)"
    show "$name" >/dev/null
    printf '%s\n' "$name"
    ;;
  knob)
    # the value the [wake] table sets, as select reads it, or an empty line when it
    # sets none: appl-hook.sh tells an absent knob from one that names claude
    [[ $# -eq 1 ]] || refuse "usage: wake-adapter.sh knob"
    name="$(knob "")"
    printf '%s\n' "$name"
    ;;
  *)
    refuse "usage: wake-adapter.sh show NAME | select"
    ;;
esac
