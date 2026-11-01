#!/usr/bin/env bash
# Before every commit: this folder is a session worktree, its HEAD is the branch this
# session was given, and the folder's lock is this session's. Any other answer aborts.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

branch="${1:-}"
root="${2:-.}"
if [[ -z "$branch" ]]; then
  echo "usage: assert-head.sh <branch> [worktree-path]" >&2
  exit 2
fi
root="$(cd "$root" && pwd)"
current="$(git -C "$root" rev-parse --abbrev-ref HEAD)"
if [[ "$current" != "$branch" ]]; then
  echo "abort: HEAD is ${current} (expected ${branch}) cwd=${root}" >&2
  exit 1
fi
wt="$(iso_worktree_of "$root")"
owner="$(iso_owner)"
if ! iso_is_linked "$wt"; then
  if [[ "${ISOLATED_SESSION_FORCE:-0}" != "1" ]]; then
    echo "abort: ${wt} is the primary checkout, not a session worktree; nothing is committed there" >&2
    exit 1
  fi
else
  case "$(iso_lock_state "$wt" "$owner")" in
    mine)
      # a lock iso_lock_set refuses (a line no writer wrote, not a regular file) fails closed
      if ! iso_lock_touch "$wt" "$owner"; then
        echo "abort: the lock $(iso_lock_path "$wt") of ${wt} was refused and left as it is -- nothing is committed; a lock no writer wrote is a finding: report it rather than repair it" >&2
        exit 1
      fi
      ;;
    free)
      echo "abort: no session holds ${wt} -- run claim-worktree.sh (or ensure-worktree.sh) first" >&2
      exit 1
      ;;
    dead)
      echo "abort: ${wt} is held by a session that is gone ($(iso_lock_describe "$wt")) -- run claim-worktree.sh to take it over" >&2
      exit 1
      ;;
    other)
      { echo "abort: ${wt} is held by another live session: $(iso_lock_describe "$wt")"
        iso_lock_fix_hint "$wt" "$owner"; } >&2
      exit 1
      ;;
    *)
      # an empty or unknown answer is a lock check that failed: never a pass
      echo "abort: the lock of ${wt} could not be judged -- nothing is committed; run claim-worktree.sh to take it over if its holder is gone" >&2
      exit 1
      ;;
  esac
fi
echo "HEAD=${current}"
echo "OWNER=${owner}"
echo "OWNER_KIND=$(iso_owner_kind "$owner")"
