#!/usr/bin/env bash
# Configure this machine for the Room landing lease: who it is, and which checkout is
# which repository.
#
#   dispatch-init.sh --as <agent> --repo <name>=<absolute path> [--node <absolute path>]
#
# Writes $DISPATCH_DIR (default ~/.muretai/dispatch):
#   agent   `name=<agent>`         -- the line finish-worktree.sh reads for `take --as`
#   repos   `<name>=<path>` lines  -- one per repository; finish-worktree.sh takes the
#                                     lease `--repo <name>` for the line whose path is
#                                     its primary checkout
#   node    `node=<path>`          -- the node whose operator_cli.py and keys/ the lease
#                                     and dispatch-take.sh run through (the M1 defect:
#                                     they used to run this checkout's copy)
# All mode 600. Without --node an existing node line is kept; with none, node= is
# written as $HOME/muretai-node only if that passes the same checks as --node, and
# otherwise no node line is written and stderr says to pass --node (agent and repos
# are still written). The node checks are landing-lease.py's `check_node`: absolute,
# no `..`, an existing directory that is not a symlink, owned by this user, holding
# operator_cli.py, and not this repository or one of its worktrees. Idempotent: running it twice leaves one line per repository, a new path
# for a name replaces that name's line where it stands, and every other line (another
# repository, a comment) is kept byte for byte. Any other `agent` line than `name=` is
# kept too.
#
# Why this exists: the lease was built, but real landings ran with LANDING_LEASE=off
# because nothing wrote `agent` and `repos` mapped only `demo`; the landing now refuses a
# configured Room without them and prints the exact call of this script to run
# (plan 2026-09-19-multi-mac-appl, M1). The Room file (`room`, `did=`) is NOT written
# here -- see ISSUE(dispatch-init-writes-no-room).
#
# Refused (non-zero exit, both files untouched, nothing created on a fresh machine):
#   * an agent name outside [a-z][a-z0-9-]{0,31} (herdr's and the node's name shape);
#   * a repository name outside [A-Za-z0-9._-] or starting with `.` -- so no `=`, no
#     `/`, no whitespace, nothing that could be a second line or a comment;
#   * a path that is not an existing absolute directory as given, or that carries any
#     control character (a newline in a real directory name would otherwise write a
#     second `repos` line);
#   * an `agent` or `repos` that is a symlink or not a regular file -- the readers
#     ignore a symlinked file, and a write through one would land wherever it points.
# Each file is written to a temporary file in the same directory and renamed over the
# old one, so a reader never sees half a file and the result is mode 600 even when the
# old file was wider.
set -euo pipefail
export LC_ALL=C
umask 077
here="$(cd "$(dirname "$0")" && pwd)"

usage() {
  echo "usage: dispatch-init.sh --as <agent> --repo <name>=<absolute path> [--node <absolute path>]" >&2
  exit 2
}

die() {
  echo "dispatch-init: $1" >&2
  exit 1
}

# A value we echo back in a refusal is somebody's typing: control characters are shown
# as `?`, never printed raw.
show() {
  printf '%s' "$1" | tr '\000-\037\177' '?'
}

as_name=""
as_set="no"
repo_spec=""
repo_set="no"
node_arg=""
node_set="no"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --as) [[ $# -ge 2 ]] || usage; as_name="$2"; as_set="yes"; shift 2 ;;
    --repo) [[ $# -ge 2 ]] || usage; repo_spec="$2"; repo_set="yes"; shift 2 ;;
    --node) [[ $# -ge 2 ]] || usage; node_arg="$2"; node_set="yes"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "dispatch-init: unknown argument: $(show "$1")" >&2; usage ;;
  esac
done
[[ "$as_set" == "yes" && "$repo_set" == "yes" ]] || usage

# --- validate everything before anything is created ------------------------------
case "$as_name" in
  [a-z]*) ;;
  *) die "agent name '$(show "$as_name")' must match [a-z][a-z0-9-]{0,31}" ;;
esac
case "$as_name" in
  *[!a-z0-9-]*) die "agent name '$(show "$as_name")' must match [a-z][a-z0-9-]{0,31}" ;;
esac
if [[ "${#as_name}" -gt 32 ]]; then
  die "agent name '$(show "$as_name")' is longer than 32 characters"
fi

case "$repo_spec" in
  *=*) ;;
  *) die "--repo takes <name>=<absolute path>, got '$(show "$repo_spec")'" ;;
esac
repo_name="${repo_spec%%=*}"
repo_path="${repo_spec#*=}"
case "$repo_name" in
  ''|.*|*[!A-Za-z0-9._-]*)
    die "repository name '$(show "$repo_name")' must be letters, digits, '.', '_' or '-' (no '=', '/' or whitespace), not starting with '.'"
    ;;
esac
case "$repo_path" in
  *[[:cntrl:]]*) die "the path for '${repo_name}' carries a control character" ;;
  /*) ;;
  *) die "the path for '${repo_name}' must be absolute as given: '$(show "$repo_path")'" ;;
esac
if [[ ! -d "$repo_path" ]]; then
  die "the path for '${repo_name}' is not an existing directory: '$(show "$repo_path")'"
fi

if [[ -z "${DISPATCH_DIR:-}" && -z "${HOME:-}" ]]; then
  die "neither DISPATCH_DIR nor HOME is set, so there is no dispatch directory"
fi
dispatch_dir="${DISPATCH_DIR:-${HOME}/.muretai/dispatch}"
agent_file="${dispatch_dir}/agent"
repos_file="${dispatch_dir}/repos"
node_file="${dispatch_dir}/node"
for f in "$agent_file" "$repos_file" "$node_file"; do
  if [[ -L "$f" ]]; then
    die "refusing to write through a symlink: ${f}"
  fi
  if [[ -e "$f" && ! -f "$f" ]]; then
    die "not a regular file: ${f}"
  fi
done
if [[ -e "$dispatch_dir" && ! -d "$dispatch_dir" ]]; then
  die "not a directory: ${dispatch_dir}"
fi

# node: --node must pass check_node or nothing is written; without it, an existing
# node= line is kept, else the default is written only if it passes the same check.
node_value=""
if [[ "$node_set" == "yes" ]]; then
  if ! python3 -I "$here/landing-lease.py" check-node "$node_arg" --as-prefix dispatch-init >/dev/null; then
    exit 1
  fi
  node_value="$node_arg"
else
  has_node_line="no"
  if [[ -f "$node_file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        node=?*) has_node_line="yes" ;;
      esac
    done < "$node_file"
  fi
  if [[ "$has_node_line" == "no" ]]; then
    default_node="${HOME:-}/muretai-node"
    if [[ -n "${HOME:-}" ]] \
        && python3 -I "$here/landing-lease.py" check-node "$default_node" >/dev/null 2>&1; then
      node_value="$default_node"
    else
      echo "dispatch-init: no node line written: $(show "$default_node") is not a node the lease can use; pass --node <absolute path of this machine's node>" >&2
    fi
  fi
fi

# --- write -----------------------------------------------------------------------
mkdir -p "$dispatch_dir"

tmp_agent=""
tmp_repos=""
tmp_node=""
drop_tmp() {
  rm -f "${tmp_agent:-}" "${tmp_repos:-}" "${tmp_node:-}" 2>/dev/null || true
}
trap drop_tmp EXIT

tmp_agent="$(mktemp "${dispatch_dir}/.agent.XXXXXX")"
tmp_repos="$(mktemp "${dispatch_dir}/.repos.XXXXXX")"

# agent: `name=` replaced (or added first); every other line kept
{
  printf 'name=%s\n' "$as_name"
  if [[ -f "$agent_file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        name=*) ;;
        *) printf '%s\n' "$line" ;;
      esac
    done < "$agent_file"
  fi
} > "$tmp_agent"

# repos: this name's line replaced where it stands (a duplicate of it dropped), else
# appended; every other line kept
written="no"
{
  if [[ -f "$repos_file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" == *=* && "${line%%=*}" == "$repo_name" ]]; then
        if [[ "$written" == "no" ]]; then
          printf '%s=%s\n' "$repo_name" "$repo_path"
          written="yes"
        fi
        continue
      fi
      printf '%s\n' "$line"
    done < "$repos_file"
  fi
  if [[ "$written" == "no" ]]; then
    printf '%s=%s\n' "$repo_name" "$repo_path"
  fi
} > "$tmp_repos"

# node: `node=` replaced (or added first); every other line kept
if [[ -n "$node_value" ]]; then
  tmp_node="$(mktemp "${dispatch_dir}/.node.XXXXXX")"
  {
    printf 'node=%s\n' "$node_value"
    if [[ -f "$node_file" ]]; then
      while IFS= read -r line || [[ -n "$line" ]]; do
        case "$line" in
          node=*) ;;
          *) printf '%s\n' "$line" ;;
        esac
      done < "$node_file"
    fi
  } > "$tmp_node"
fi

chmod 600 "$tmp_agent" "$tmp_repos"
mv -f "$tmp_agent" "$agent_file"
tmp_agent=""
mv -f "$tmp_repos" "$repos_file"
tmp_repos=""
if [[ -n "$tmp_node" ]]; then
  chmod 600 "$tmp_node"
  mv -f "$tmp_node" "$node_file"
  tmp_node=""
fi

echo "AGENT=${as_name}"
echo "REPO=${repo_name}=${repo_path}"
if [[ -n "$node_value" ]]; then
  echo "NODE=${node_value}"
fi
echo "DISPATCH_DIR=${dispatch_dir}"
