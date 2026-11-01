#!/usr/bin/env bash
# Run the split check on one appl-splitter answer the coordinator saved.
#
#   appl-split-check.sh <coordinator dir>/briefs/<intake id>.split
#
# appl-split-check.py reads the answer on stdin, and a `python3 ... < file` redirect never
# matches a `Bash(prefix:*)` allow rule, so the coordinator's claude profile allows this
# wrapper by its exact path instead (herd-spawn.sh). It feeds the file's bytes to
# `python3` (from PATH) running appl-split-check.py on stdin, and passes the checker's
# stdout and exit code through unchanged: 0 accepted, 1 refused. When the file is named
# by an intake id, it passes `--intake <coordinator dir>/intake <id>`: the checker then
# prints every accepted line at `priority: P0` when that intake is owner P0.
#
# It REFUSES with exit 2 -- nothing on stdout, python3 never run -- when:
#   * there is not exactly one argument, or it is empty;
#   * the argument does not end in `.split`;
#   * the path, every symlink resolved, is not a regular `.split` file directly under
#     $HERD_DIR/coordinator/briefs/ (HERD_DIR defaulting to ~/.cache/muretai-herd), so
#     a `..`, a look-alike directory or a symlink out of briefs/ is never read.
set -u

refuse() {
  echo "appl-split-check.sh: $*" >&2
  exit 2
}

# physical path of a directory, or nothing
phys_dir() {
  (cd -P -- "$1" 2>/dev/null && pwd -P)
}

[[ $# -eq 1 ]] || refuse "usage: appl-split-check.sh <coordinator dir>/briefs/<intake id>.split"
arg="$1"
[[ -n "$arg" ]] || refuse "an empty path"
case "$arg" in
  *?.split) ;;
  *) refuse "not a .split file: $arg" ;;
esac

herd="${HERD_DIR:-$HOME/.cache/muretai-herd}"
briefs="$(phys_dir "$herd/coordinator/briefs")"
[[ -n "$briefs" ]] || refuse "no coordinator briefs directory under $herd"

# resolve the path's symlinks, one hop at a time (bash 3.2: no realpath)
f="$arg"
hops=0
while [[ -L "$f" ]]; do
  hops=$((hops + 1))
  [[ $hops -le 40 ]] || refuse "too many symlinks: $arg"
  t="$(readlink -- "$f")" || refuse "cannot read the link: $f"
  case "$t" in
    /*) f="$t" ;;
    *) f="$(dirname -- "$f")/$t" ;;
  esac
done
dir="$(phys_dir "$(dirname -- "$f")")"
[[ -n "$dir" ]] || refuse "no such directory: $arg"
name="$(basename -- "$f")"

[[ "$dir" == "$briefs" ]] || refuse "not directly under $briefs: $arg"
case "$name" in
  *?.split) ;;
  *) refuse "does not resolve to a .split file: $arg" ;;
esac
[[ -f "$dir/$name" ]] || refuse "no such file: $arg"

here="$(phys_dir "$(dirname -- "${BASH_SOURCE[0]}")")"
[[ -n "$here" ]] || refuse "cannot find its own directory"
# briefs/<intake id>.split: the checker prints every line at P0 when that intake is owner P0
ident="${name%.split}"
id_re='^[0-9]{8}T[0-9]{6}Z(-[1-9][0-9]*)?$'
if [[ "$ident" =~ $id_re ]]; then
  exec python3 -I "$here/appl-split-check.py" --intake "${herd%/}/coordinator/intake" "$ident" < "$dir/$name"
fi
exec python3 -I "$here/appl-split-check.py" < "$dir/$name"
