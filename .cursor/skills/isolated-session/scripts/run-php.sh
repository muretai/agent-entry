#!/usr/bin/env bash
# Path-first php runner, the PHP twin of run-node.sh: `run-php.sh tests/<file>.php` runs
# `php <that path>` (php found through PATH) and exits with its status. A walled pane's
# permission profile allows this one fixed shape while bare `php` stays denied, so the
# argument is checked here and never evaluated: exactly one argument, a relative path with no
# leading `-`, no leading `/` or `~`, no `.` or `..` step and no line break, that ends in
# `.php`, exists, and, with every symlink resolved, is a regular file inside the repository
# (the git top level of the working directory) and outside its .git. php is handed that path
# and nothing else, with PHPRC and PHP_INI_SCAN_DIR unset (an ini can reach php through the
# environment too, the way a loader reaches node through NODE_OPTIONS). Anything else is
# refused with exit 2 and nothing runs.
set -euo pipefail
export LC_ALL=C
unset CDPATH

refuse() {
  echo "run-php.sh: refused: $1" >&2
  echo "usage: run-php.sh <relative path to a .php file in the repository>, e.g. tests/<file>.php" >&2
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
  *$'\n'*|*$'\r'*) refuse "the path holds a line break" ;;
esac
case "$arg" in
  -*) refuse "a flag or option is not a path; php is handed one path and no flag" ;;
  /*) refuse "an absolute path; name the file relative to the repository root" ;;
  '~'*) refuse "a ~ home path is outside the repository" ;;
esac
case "/$arg/" in
  */../*|*/./*) refuse "the path holds a . or .. step" ;;
esac
case "$arg" in
  *.php) ;;
  *) refuse "not a .php file" ;;
esac
if [[ ! -e "$arg" && ! -L "$arg" ]]; then
  refuse "the file does not exist"
fi

# the repository's own root, every symlink resolved
top="$(git rev-parse --show-toplevel 2>/dev/null)" || refuse "not inside a git repository"
[[ -n "$top" && -d "$top" ]] || refuse "not inside a git repository"
top="$(cd -P -- "$top" && pwd -P)" || refuse "the repository root does not resolve"

# resolve PATH like realpath(1): follow a symlinked last component, then resolve the
# directory part with `cd -P`. Prints the result; fails when anything does not resolve.
resolve() {
  local p="$1" t n=0 d b
  while [[ -L "$p" ]]; do
    n=$((n + 1))
    [[ $n -le 40 ]] || return 1
    t="$(readlink -- "$p")" || return 1
    case "$t" in
      /*) p="$t" ;;
      *) p="$(dirname -- "$p")/$t" ;;
    esac
  done
  b="$(basename -- "$p")"
  case "$b" in
    .|..|/) return 1 ;;
  esac
  d="$(cd -P -- "$(dirname -- "$p")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "$d" "$b"
}

real="$(resolve "$arg")" || refuse "the path does not resolve (a missing file or a broken link)"
case "$real" in
  "$top"/.git|"$top"/.git/*) refuse "the path resolves into the repository's .git" ;;
  "$top"/*) ;;
  *) refuse "the path resolves outside the repository (through a symlink)" ;;
esac
if [[ -L "$real" || ! -f "$real" ]]; then
  refuse "not a regular file"
fi

unset PHPRC PHP_INI_SCAN_DIR
exec php "$arg"
