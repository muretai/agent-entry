#!/usr/bin/env bash
# Path-first node runner, the JavaScript twin of run-test.sh: `run-node.sh conformance/<file>.mjs`
# (or `tests/<file>.mjs`) runs `node <that path>` (node found through PATH) and exits with its
# status. A permission profile can allow this one fixed shape instead of `node <anything>`,
# so the argument is checked here and never evaluated: exactly one argument, a relative path
# that starts with `conformance/` or `tests/`, holds no `..` and no leading `-`, and that,
# with every symlink resolved, is a regular file under the repository's own conformance/ or
# tests/ directory. The repository is the git top level of the working directory. node is
# handed that path and nothing else, with NODE_OPTIONS unset (a loader can reach node
# through the environment too). Anything else is refused with exit 2 and nothing runs.
set -euo pipefail
export LC_ALL=C
unset CDPATH

refuse() {
  echo "run-node.sh: refused: $1" >&2
  echo "usage: run-node.sh conformance/<file>.mjs | tests/<file>.mjs" >&2
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
  conformance/*|tests/*) ;;
  *) refuse "not a path under conformance/ or tests/" ;;
esac
case "/$arg/" in
  */../*|*/./*) refuse "the path holds a . or .. step" ;;
esac
case "$arg" in
  *$'\n'*|*$'\r'*) refuse "the path holds a line break" ;;
esac

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

real="$(resolve "$arg")" || refuse "the path does not resolve"
if [[ -L "$real" || ! -f "$real" ]]; then
  refuse "not a regular file"
fi
case "$real" in
  "$top"/conformance/*|"$top"/tests/*) ;;
  *) refuse "the path resolves outside the repository's conformance/ and tests/" ;;
esac

unset NODE_OPTIONS
exec node "$arg"
