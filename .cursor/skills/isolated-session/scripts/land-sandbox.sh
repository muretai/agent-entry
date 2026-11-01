#!/bin/bash
# A disposable shared clone for one landing test run.
#
#   land-sandbox.sh prepare <checkout>
#       Prints parent=<dir> and clone=<dir>. The clone is `git clone --shared`
#       of <checkout>'s common dir, detached at that checkout's HEAD. parent is
#       a private directory under /tmp, not /tmp itself. Export it as
#       GIT_CEILING_DIRECTORIES and as MURETAI_LAND_SANDBOX. On failure nothing
#       is left behind, and stderr says "disposable clone could not be created".
#   land-sandbox.sh remove <clone>
#       Removes the clone only. The private parent stays, because the ceiling
#       has to name a directory after the run returns. Refuses any other path.
#
# Git runs with every GIT_* variable stripped, then GIT_CEILING_DIRECTORIES set
# to the private parent, so an inherited GIT_DIR cannot redirect the clone onto
# the caller's repository. Bash 3.2. ASCII only.
set -eu

usage() {
  echo "usage: land-sandbox.sh prepare <checkout> | remove <parent>" >&2
  exit 2
}

# Every git here also runs with fsmonitor and hooks pinned off on the command line, which
# no config the clone or HOME carries, include or includeIf, can re-enable: a program it
# named would run outside every wall. The same pins as appl-hook.sh's GIT_PINS.
GIT_PINS=(-c core.fsmonitor=false -c core.hooksPath=/dev/null)

run_git() {
  local ceiling="$1"
  shift
  python3 -I - "$ceiling" "${GIT_PINS[@]}" "$@" <<'PY'
import os, subprocess, sys
ceiling = sys.argv[1]
args = sys.argv[2:]
env = {}
for key, value in os.environ.items():
    if not key.startswith("GIT_"):
        env[key] = value
if ceiling:
    env["GIT_CEILING_DIRECTORIES"] = ceiling
raise SystemExit(subprocess.run(["git"] + args, env=env).returncode)
PY
}

refuse() {
  local parent="$1"
  local errf="$2"
  local why="$3"
  local detail=""
  if [[ -n "$errf" && -f "$errf" ]]; then
    detail="$(tr '\n' ' ' < "$errf" | sed 's/[[:space:]]*$//')"
    rm -f -- "$errf"
  fi
  if [[ -n "$parent" ]]; then
    rm -rf -- "$parent"
  fi
  if [[ -n "$detail" ]]; then
    echo "disposable clone could not be created: ${detail}" >&2
  else
    echo "disposable clone could not be created: ${why}" >&2
  fi
  exit 1
}

prepare() {
  local worktree="$1"
  local parent="" clone="" common="" tip="" errf="" sbx_tmp=""
  if [[ -z "$worktree" || ! -d "$worktree" ]]; then
    echo "disposable clone could not be created: the checkout was not named" >&2
    exit 1
  fi
  # /tmp, not $TMPDIR: a test that binds a Unix socket under the scratch
  # directory meets a 104-byte path limit, and macOS's own TMPDIR is already long.
  # The private parent is a child of /tmp, not /tmp itself.
  sbx_tmp="/tmp"
  if [[ ! -d "$sbx_tmp" || ! -w "$sbx_tmp" ]]; then
    sbx_tmp="${TMPDIR:-/tmp}"
  fi
  parent="$(mktemp -d "${sbx_tmp}/land-sbx-XXXXXX")" || {
    echo "disposable clone could not be created: a private directory could not be created" >&2
    exit 1
  }
  chmod 700 "$parent" || refuse "$parent" "" "the private directory could not be made private"
  parent="$(cd "$parent" && pwd -P)" || refuse "$parent" "" "the private directory could not be read"
  errf="$(mktemp "${TMPDIR:-/tmp}/land-sbx-err-XXXXXX")" ||
    refuse "$parent" "" "a private directory could not be created"
  common="$(run_git "$parent" -C "$worktree" rev-parse --git-common-dir 2>"$errf")" ||
    refuse "$parent" "$errf" "the repository could not be read"
  common="$(printf '%s' "$common" | tr -d '[:space:]')"
  case "$common" in
    /*) ;;
    *) common="${worktree}/${common}" ;;
  esac
  common="$(cd "$common" 2>/dev/null && pwd -P)" ||
    refuse "$parent" "$errf" "the repository could not be read"
  tip="$(run_git "$parent" -C "$worktree" rev-parse --verify HEAD 2>"$errf")" ||
    refuse "$parent" "$errf" "the branch tip could not be read"
  tip="$(printf '%s' "$tip" | tr -d '[:space:]')"
  clone="${parent}/clone"
  run_git "$parent" clone -q --shared --no-checkout "$common" "$clone" 2>"$errf" ||
    refuse "$parent" "$errf" "git clone failed"
  run_git "$parent" -C "$clone" checkout -q --detach "$tip" 2>"$errf" ||
    refuse "$parent" "$errf" "the branch tip could not be checked out"
  # Local, so a child that no longer sees the credential-helper variables still
  # does not use the operator's helper inside this clone.
  run_git "$parent" -C "$clone" config --local credential.helper "" >/dev/null 2>&1 || true
  rm -f -- "$errf"
  printf 'parent=%s\nclone=%s\n' "$parent" "$clone"
}

remove_clone() {
  # The private parent stays. It is GIT_CEILING_DIRECTORIES, and that directory
  # has to exist after the run returns. Only the clone itself is removed.
  local clone="$1"
  case "$clone" in
    */land-sbx-*/clone)
      if [[ -d "$clone" ]]; then
        rm -rf -- "$clone"
      fi
      ;;
    *)
      echo "refusing to remove ${clone}" >&2
      exit 1
      ;;
  esac
}

[[ $# -ge 1 ]] || usage
case "$1" in
  prepare)
    [[ $# -eq 2 ]] || usage
    prepare "$2"
    ;;
  remove)
    [[ $# -eq 2 ]] || usage
    remove_clone "$2"
    ;;
  *)
    usage
    ;;
esac
