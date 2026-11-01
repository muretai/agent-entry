#!/bin/bash
# The herd worker wall on macOS: Seatbelt, through /usr/bin/sandbox-exec.
#
#   darwin.sh available                      exit 0 when this machine can build the wall
#   darwin.sh exec <profile> -- <cmd...>     exec <cmd...> behind the wall <profile> describes
#   darwin.sh inside                         exit 0 when THIS process already runs behind a wall
#
# `exec` exports HERD_WALL_INSIDE=<worker name> (the name of the directory the profile sits
# in, $HERD_DIR/walls/<name>/profile) into the walled process. A spawn started from behind
# the wall finds `available` failing -- sandbox-exec refuses to nest -- and the marker set;
# it then asks `inside`, which asks the kernel (sandbox_check on its own pid) rather than
# the marker, so a marker set by hand outside any wall is not a wall.
#
# This file is a PLUG (AGENTS.md principle 12): herd-spawn.sh owns the mode, the probe, the
# bounds and the record, and picks the plug by `uname -s`, lowercased -- a Linux wall is
# one more file beside this one, answering the same two verbs. The profile is NEUTRAL: the
# lines herd-spawn.sh writes to $HERD_DIR/walls/<name>/profile, one verb and one absolute
# path per line --
#
#   egress open                  the only egress policy wall v1 has (see the template)
#   allow-write <dir>            the worker may write under <dir>
#   allow-write-prefix <path>    ... and any path that begins with <path> (~/.claude.json*)
#   allow-write-literal <path>   ... and exactly <path>, nothing beside or beneath it (a ref
#                                and its .lock; a prefix on refs/heads/feat/w also covered
#                                feat/w2.lock)
#   deny-write <path>            but never under <path>, though an allow-write covers it
#   deny-write-literal <path>    and never exactly <path>, though an allow-write covers it
#                                (the git dir's commondir, gitdir and config.worktree)
#   deny-write-anycase <path>    never write or hard-link under <path> in any letter case
#                                (a case-insensitive volume: Settings.json IS settings.json)
#   deny-write-anycase-prefix <path>   ... any path that begins with <path> (settings*.json)
#   deny-write-anycase-literal <path>  ... exactly <path>, so a directory can be neither
#                                renamed away nor replaced, while what is under it keeps its
#                                own answer
#   deny-write-anycase-glob <path>  ... like deny-write-anycase, where a component that
#                                is exactly `*` stands for any one component (projects/*/memory)
#   deny-write-anycase-others <dir>  ... every top-level entry of <dir>, and all beneath it,
#                                except those the two spare verbs below name under <dir>
#                                (the config home's allowlist of session state)
#   deny-write-anycase-spare <dir>/<name>  spares <name>, and all beneath it, from the
#                                -others deny of <dir>: an allow rendered right after that
#                                deny and before every other deny, so no deny loses to it
#   deny-write-anycase-spare-literal <dir>/<name>  ... spares exactly <name>, a file
#   deny-link <path>            and never hard-link <path> or anything under it, except
#                                an allow-write path under it. file-write* is untouched:
#                                the worker's worktree sits inside the primary checkout,
#                                so a deny-write of that checkout would take the worktree
#   deny-read <dir>              and never read, list or stat anything under <dir>
#   deny-connect <path>          and never connect to the unix socket at exactly <path>
#                                (herdr's control socket: a connect is not a file write)
#
# -- and this plug turns them into Seatbelt rules through darwin.sb.template, which sits
# in the same DIRECTORY. The directory is found from $0's dirname and never from this
# file's own name, so a copy of the plug under another name still finds its template.
#
# The profile is read here, OUTSIDE the wall, a moment before the exec; the walled
# process cannot write it (its directory is under $HERD_DIR/walls/, which is on no
# allow-write line). A path carrying a quote, a backslash or a control character is
# refused rather than escaped: it would be spliced into the rule language.
set -uo pipefail

SANDBOX=/usr/bin/sandbox-exec
walls="$(cd "$(dirname "$0")" && pwd)"
template="${walls}/darwin.sb.template"

die() { echo "walls/darwin: $*" >&2; exit 2; }

# a path fit to stand between double quotes in a rule: absolute, printable, no quote or
# backslash (bash 3.2: a bracket class, no regex engine needed)
safe_path() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *[\"\\]*|*[[:cntrl:]]*) return 1 ;;
  esac
  return 0
}

# anycase_regex <path>: the path as a regex body that matches it in every ASCII letter case.
# A letter becomes a [xX] class, a regex metacharacter a one-character class; a `^` has no
# backslash-free class (a backslash is refused in a path), so it is refused too.
anycase_regex() {
  local p="$1" out="" c i=0 rest
  local lower=abcdefghijklmnopqrstuvwxyz upper=ABCDEFGHIJKLMNOPQRSTUVWXYZ
  while [[ $i -lt ${#p} ]]; do
    c="${p:$i:1}"
    i=$((i + 1))
    case "$c" in
      [abcdefghijklmnopqrstuvwxyz])
        rest="${lower%%"$c"*}"
        out="${out}[${c}${upper:${#rest}:1}]" ;;
      [ABCDEFGHIJKLMNOPQRSTUVWXYZ])
        rest="${upper%%"$c"*}"
        out="${out}[${lower:${#rest}:1}${c}]" ;;
      '^') return 1 ;;
      .|'*'|+|'?'|'('|')'|'{'|'}'|'|'|'$'|'['|']') out="${out}[${c}]" ;;
      *) out="${out}${c}" ;;
    esac
  done
  printf '%s' "$out"
}

# anycase_deny <filter> <path> <regex tail>: a write and a link deny of <path> as given,
# and the same again for every letter case of it. Filtered, never a bare deny.
anycase_deny() {
  local filt="$1" path="$2" tail="$3" re op
  re="$(anycase_regex "$path")" || die "profile line refused (a '^' in an anycase path)"
  for op in 'file-write*' file-link; do
    printf '(deny %s (%s "%s"))\n' "$op" "$filt" "$path"
    printf '(deny %s (regex #"^%s%s"))\n' "$op" "$re" "$tail"
  done
}

# anycase_glob_deny <path>: a write and a link deny of <path> under every letter case,
# a component that is exactly `*` matching any one component. A glob has no literal
# filter, so both denies are the regex alone.
anycase_glob_deny() {
  local rest="${1#/}" out="" comp re op
  while [[ -n "$rest" ]]; do
    comp="${rest%%/*}"
    if [[ "$comp" == "$rest" ]]; then
      rest=""
    else
      rest="${rest#*/}"
    fi
    if [[ "$comp" == "*" ]]; then
      out="${out}/[^/]+"
    else
      re="$(anycase_regex "$comp")" || die "profile line refused (a '^' in an anycase path)"
      out="${out}/${re}"
    fi
  done
  for op in 'file-write*' file-link; do
    printf '(deny %s (regex #"^%s(/|$)"))\n' "$op" "$out"
  done
}

# others_deny <dir> <profile>: a write and a link deny of every top-level entry of <dir>,
# and all beneath it, in every letter case; then a write and a link allow of each entry the
# profile's spare lines name under <dir>, in every letter case, since a later rule wins.
# Seatbelt's regex has no lookahead, so the allowlist is a deny followed by allows, never
# one complement regex. It renders FIRST in the deny section, so every other deny comes
# after these allows and still wins over an allowlist entry (projects/*/memory, say).
others_deny() {
  local dir="$1" profile="$2" line verb path name re nre tail op
  re="$(anycase_regex "$dir")" || die "profile line refused (a '^' in an anycase path)"
  for op in 'file-write*' file-link; do
    printf '(deny %s (regex #"^%s/[^/]+(/|$)"))\n' "$op" "$re"
  done
  while IFS= read -r line || [[ -n "$line" ]]; do
    verb="${line%% *}"
    path="${line#* }"
    case "$verb" in
      deny-write-anycase-spare) tail='(/|$)' ;;
      deny-write-anycase-spare-literal) tail='$' ;;
      *) continue ;;
    esac
    [[ "$path" == "$dir"/* ]] || continue
    name="${path#"$dir"/}"
    case "$name" in
      ''|*/*|*[!A-Za-z0-9._-]*) die "profile line refused (a spare is one plain name under its directory): ${verb}" ;;
    esac
    nre="$(anycase_regex "$name")" || die "profile line refused (a '^' in an anycase path)"
    for op in 'file-write*' file-link; do
      printf '(allow %s (regex #"^%s/%s%s"))\n' "$op" "$re" "$nre" "$tail"
    done
  done < "$profile"
}

rules_for() {
  # rules_for <verb> <profile>: the Seatbelt rules for every line of that verb
  local want="$1" profile="$2" verb path
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in ''|'#'*) continue ;; esac
    verb="${line%% *}"
    path="${line#* }"
    [[ "$verb" == "$want" ]] || continue
    safe_path "$path" || die "profile line refused (not a plain absolute path): ${verb}"
    case "$verb" in
      allow-write)        printf '(allow file-write* (subpath "%s"))\n' "$path" ;;
      allow-write-prefix) printf '(allow file-write* (prefix "%s"))\n' "$path" ;;
      allow-write-literal) printf '(allow file-write* (literal "%s"))\n' "$path" ;;
      deny-write)
        # file-write* is what rename-into already loses. file-link is the separate
        # hole: a hard link of this path into a writable directory, then a write
        # through the new name. A filtered deny, never a bare `deny file-link`.
        printf '(deny file-write* (subpath "%s"))\n' "$path"
        printf '(deny file-link (subpath "%s"))\n' "$path"
        ;;
      deny-write-literal)
        # exactly <path>, so a deny of a file inside an allowed directory leaves its
        # siblings writable; the same file-link hole is closed as for deny-write
        printf '(deny file-write* (literal "%s"))\n' "$path"
        printf '(deny file-link (literal "%s"))\n' "$path"
        ;;
      deny-write-anycase)         anycase_deny subpath "$path" '(/|$)' ;;
      deny-write-anycase-prefix)  anycase_deny prefix "$path" '' ;;
      deny-write-anycase-literal) anycase_deny literal "$path" '$' ;;
      deny-write-anycase-glob) anycase_glob_deny "$path" ;;
      deny-write-anycase-others) others_deny "$path" "$profile" ;;
      deny-read)       printf '(deny file-read* (subpath "%s"))\n' "$path" ;;
      deny-connect)       printf '(deny network-outbound (literal "%s"))\n' "$path" ;;
    esac
  done < "$profile"
}

# allow paths remembered while the profile is checked, so a deny-link can leave
# them out. A deny-link of the primary checkout would otherwise cover the
# worker's own worktree, which lives inside that checkout.
link_allow_sub=()
link_allow_pre=()
link_allow_lit=()

path_is_exempt() {
  local p="$1" a
  if [[ ${#link_allow_sub[@]} -gt 0 ]]; then
    for a in "${link_allow_sub[@]}"; do
      case "$p" in
        "$a"|"$a"/*) return 0 ;;
      esac
    done
  fi
  if [[ ${#link_allow_pre[@]} -gt 0 ]]; then
    for a in "${link_allow_pre[@]}"; do
      case "$p" in
        "$a"*) return 0 ;;
      esac
    done
  fi
  if [[ ${#link_allow_lit[@]} -gt 0 ]]; then
    for a in "${link_allow_lit[@]}"; do
      [[ "$p" == "$a" ]] && return 0
    done
  fi
  return 1
}

path_has_exception_under() {
  local p="$1" a
  if [[ ${#link_allow_sub[@]} -gt 0 ]]; then
    for a in "${link_allow_sub[@]}"; do
      case "$a" in
        "$p"/*) return 0 ;;
      esac
    done
  fi
  if [[ ${#link_allow_pre[@]} -gt 0 ]]; then
    for a in "${link_allow_pre[@]}"; do
      case "$a" in
        "$p"/*) return 0 ;;
      esac
    done
  fi
  if [[ ${#link_allow_lit[@]} -gt 0 ]]; then
    for a in "${link_allow_lit[@]}"; do
      case "$a" in
        "$p"/*) return 0 ;;
      esac
    done
  fi
  return 1
}

# One filtered file-link deny of path, or of each entry under it that is not an
# allow-write. The allow-write entries stay at the template's (allow default),
# so no later allow line is required and the worktree stays linkable.
link_deny_one() {
  local path="$1" ng dg child
  safe_path "$path" || die "profile line refused (not a plain absolute path): deny-link"
  if path_is_exempt "$path"; then
    return 0
  fi
  if [[ -L "$path" || ! -d "$path" ]] || ! path_has_exception_under "$path"; then
    printf '(deny file-link (subpath "%s"))\n' "$path"
    return 0
  fi
  printf '(deny file-link (literal "%s"))\n' "$path"
  ng="$(shopt -p nullglob)"
  dg="$(shopt -p dotglob)"
  shopt -s nullglob dotglob
  for child in "$path"/*; do
    link_deny_one "$child"
  done
  eval "$ng"
  eval "$dg"
}

link_denies() {
  local profile="$1" line verb path
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in ''|'#'*) continue ;; esac
    verb="${line%% *}"
    [[ "$verb" == "deny-link" ]] || continue
    path="${line#* }"
    safe_path "$path" || die "profile line refused (not a plain absolute path): deny-link"
    link_deny_one "$path"
  done < "$profile"
}

render() {
  local profile="$1" egress="" line verb path
  link_allow_sub=()
  link_allow_pre=()
  link_allow_lit=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in ''|'#'*) continue ;; esac
    verb="${line%% *}"
    path="${line#* }"
    case "$verb" in
      egress) egress="${line#* }" ;;
      allow-write) link_allow_sub+=("$path") ;;
      allow-write-prefix) link_allow_pre+=("$path") ;;
      allow-write-literal) link_allow_lit+=("$path") ;;
      deny-write|deny-write-literal|deny-read|deny-connect|deny-link) ;;
      deny-write-anycase|deny-write-anycase-prefix|deny-write-anycase-literal) ;;
      deny-write-anycase-glob|deny-write-anycase-others) ;;
      deny-write-anycase-spare|deny-write-anycase-spare-literal) ;;
      *) die "profile line refused (unknown verb): ${verb}" ;;
    esac
  done < "$profile"
  # v1 has one egress policy. Anything else is a profile this plug cannot honour, and a
  # wall that silently ignored it would be the half-wall the v2 seam exists to prevent.
  [[ "$egress" == "open" ]] || die "profile egress '${egress}' is not built (wall v1 renders 'open' only)"
  [[ -f "$template" && ! -L "$template" ]] || die "no template at ${template}"
  # A marker line is `@@<NAME>@@` alone on its line; it is matched by shape and dispatched
  # by NAME, so the full marker spelling lives in the template and nowhere else. An
  # unknown marker is a template this plug cannot render: refused, never copied through.
  local tline marker tmp_dir cache_dir
  while IFS= read -r tline || [[ -n "$tline" ]]; do
    marker=""
    case "$tline" in
      @@*@@) marker="${tline#@@}"; marker="${marker%@@}" ;;
    esac
    if [[ -z "$marker" ]]; then
      printf '%s\n' "$tline"
      continue
    fi
    case "$marker" in
      ALLOW_WRITE)
        # the platform's own places every process writes: the devices (/dev/null, the
        # pane's tty) and this user's temporary and cache directories under /var/folders
        printf '(allow file-write* (subpath "/dev"))\n'
        tmp_dir="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
        cache_dir="$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null || true)"
        for d in "$tmp_dir" "$cache_dir"; do
          [[ -n "$d" && -d "$d" ]] || continue
          d="$(cd "$d" && pwd -P)"
          safe_path "$d" && printf '(allow file-write* (subpath "%s"))\n' "$d"
        done
        rules_for allow-write "$profile"
        rules_for allow-write-prefix "$profile"
        rules_for allow-write-literal "$profile"
        ;;
      DENY_WRITE)
        # the allowlist first: its allows sit under every deny that follows
        rules_for deny-write-anycase-others "$profile"
        rules_for deny-write "$profile"
        rules_for deny-write-literal "$profile"
        rules_for deny-write-anycase "$profile"
        rules_for deny-write-anycase-prefix "$profile"
        rules_for deny-write-anycase-literal "$profile"
        rules_for deny-write-anycase-glob "$profile"
        link_denies "$profile"
        ;;
      DENY_READ) rules_for deny-read "$profile" ;;
      DENY_CONNECT) rules_for deny-connect "$profile" ;;
      # wall v2 renders its egress policy here; v1 has only `open` (checked above)
      EGRESS_POLICY) printf '; egress: open -- wall v1 does not restrict the network\n' ;;
      *) die "template marker not known to this plug: ${marker}" ;;
    esac
  done < "$template"
}

# The kernel's answer, not the environment's: sandbox_check(pid, NULL, 0) is 1 for a process
# some Seatbelt profile already holds. Anything else -- no python3, no symbol, an error -- is
# "not inside", so a spawn that asks stays a refusal.
behind_a_wall() {
  local py
  py="$(command -v python3 2>/dev/null || true)"
  [[ -n "$py" ]] || return 1
  "$py" -I - >/dev/null 2>&1 <<'PY'
import ctypes, os, sys
try:
    check = ctypes.CDLL("/usr/lib/libSystem.B.dylib").sandbox_check
    check.restype = ctypes.c_int
    sys.exit(0 if check(ctypes.c_int(os.getpid()), None, ctypes.c_int(0)) == 1 else 1)
except Exception:  # noqa: BLE001
    sys.exit(1)
PY
}

case "${1:-}" in
  available)
    [[ -x "$SANDBOX" ]] || exit 1
    [[ -f "$template" && ! -L "$template" ]] || exit 1
    # A wall does not nest. Behind one, a trial of `(allow default)` can still pass while
    # the worker's real profile is refused (sandbox_apply: exit 71, measured 2026-09-25),
    # so a process already walled is told no here, before the probe, not after it.
    ! behind_a_wall || exit 1
    # a trial wall: sandbox-exec refuses inside some sandboxes, and a plug that says
    # "available" and then cannot exec is a spawn that fails after the probe
    "$SANDBOX" -p '(version 1)(allow default)' /usr/bin/true >/dev/null 2>&1 || exit 1
    exit 0
    ;;
  inside)
    behind_a_wall || exit 1
    exit 0
    ;;
  exec)
    shift
    profile="${1:-}"
    [[ $# -ge 1 ]] && shift
    [[ "${1:-}" == "--" ]] && shift
    [[ -n "$profile" && -f "$profile" && ! -L "$profile" ]] || die "no profile at ${profile:-(none)}"
    [[ $# -ge 1 ]] || die "exec: no command"
    [[ "$1" == /* ]] || die "exec: the command must be an absolute path"
    sbpl="$(render "$profile")" || exit 2
    # the marker a spawn started from behind this wall reads (see the header); a directory
    # name that is not a worker name marks nothing
    inside_name="$(basename "$(dirname "$profile")")"
    case "$inside_name" in
      *[!a-z0-9_-]*|[!a-z]*) unset HERD_WALL_INSIDE ;;
      *) export HERD_WALL_INSIDE="$inside_name" ;;
    esac
    exec "$SANDBOX" -p "$sbpl" "$@"
    ;;
esac
echo "usage: darwin.sh available | inside | exec <profile> -- <cmd...>" >&2
exit 2
