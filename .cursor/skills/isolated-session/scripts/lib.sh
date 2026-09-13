#!/usr/bin/env bash
# Shared by the isolated-session scripts and the hook. Source it; nothing here runs
# on its own.
#
# Two answers live here because four scripts and one hook must agree on them:
#   * who owns a session (iso_owner) -- a KEY. For most harnesses it is the nearest
#     agent process above us (one `claude` per chat), so two chats are two owners; for
#     a harness whose chats share one process (Cursor's Agent mode: every chat in a
#     window runs under one `agent-exec` helper) it is `cursor:<conversation_id>`,
#     which the hook reads off its payload and injects into the chat's shells, so the
#     chat's scripts and its hooks name the same owner;
#   * the per-worktree session lock (iso_lock_*) -- a file inside the worktree's own
#     git dir, so `git worktree remove` takes it with the tree and nothing ever
#     commits it.

# --- the herd directory -------------------------------------------------------

# Where briefs, reports and review checkouts live: HERD_DIR, else a directory under
# the home -- never /tmp. A reviewer's cwd is under it, Claude Code reads CLAUDE.md
# from every directory above a cwd, and /private/tmp is world-writable: any local uid
# could plant /private/tmp/CLAUDE.md and steer every reviewer
# (ISSUE(security-audit-2026-09-12-the-review-checkout-lives-4)).
# Prints nothing and returns 1 when neither HERD_DIR nor HOME is set: a caller under
# `set -u` after a merge must say so, not die
# (ISSUE(security-audit-2026-09-12-the-cleanup-trusts-n-d474-4)).
iso_herd_dir() {
  if [[ -n "${HERD_DIR:-}" ]]; then
    printf '%s\n' "$HERD_DIR"
  elif [[ -n "${HOME:-}" ]]; then
    printf '%s\n' "${HOME}/.cache/muretai-herd"
  else
    return 1
  fi
}

# 0 when every directory at or above $1 (symlinks resolved; a directory that does not
# exist yet is skipped) is owned by this user or root and writable by nobody else;
# else 1 with the first offending directory on stdout.
iso_private_path() {
  python3 - "$1" <<'PY'
import os, sys
p = os.path.realpath(sys.argv[1])
me = os.getuid()
while True:
    try:
        st = os.stat(p)
    except OSError:
        st = None
    if st is not None and (st.st_uid not in (me, 0) or (st.st_mode & 0o022)):
        print(p)
        sys.exit(1)
    parent = os.path.dirname(p)
    if parent == p:
        sys.exit(0)
    p = parent
PY
}

# --- checkout geometry ------------------------------------------------------

# The nearest existing directory at or above $1 (a file that is not written yet
# still has to resolve to a checkout).
iso_existing_dir() {
  local p="$1"
  [[ -d "$p" ]] || p="$(dirname "$p")"
  while [[ -n "$p" && "$p" != "/" && ! -d "$p" ]]; do p="$(dirname "$p")"; done
  printf '%s\n' "$p"
}

# The primary checkout root for any path inside a checkout, linked worktree or not.
iso_primary_of() {
  local dir common
  dir="$(iso_existing_dir "$1")"
  common="$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null)" || return 1
  [[ "$common" == /* ]] || common="$(cd "$dir" && cd "$common" && pwd)"
  dirname "$common"
}

# The worktree root (git toplevel) for any path inside a checkout.
iso_worktree_of() {
  local dir
  dir="$(iso_existing_dir "$1")"
  git -C "$dir" rev-parse --show-toplevel 2>/dev/null
}

# 0 when $1 (a worktree root) is a linked worktree rather than the primary checkout.
iso_is_linked() {
  [[ -f "$1/.git" ]]
}

# --- who owns this session --------------------------------------------------

iso_is_pid() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# The process that stands for "this session" by the process tree alone: the nearest
# ancestor that is an agent host (Claude Code, Codex, Grok Build, Cursor, VS Code, Grok
# Bot), else the top-most ancestor below the init process (a terminal tab).
iso_owner_pid() {
  local pid=$$ last=$$ comm base
  while [[ -n "$pid" && "$pid" -gt 1 ]]; do
    comm="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
    base="${comm##*/}"
    case "$base" in
      claude|claude-code|codex|grok|xai-grok-pager|Cursor*|cursor*|Code*|code*|Electron|"Grok Bot"*|Grok*)
        printf '%s\n' "$pid"
        return 0
        ;;
    esac
    last="$pid"
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  done
  printf '%s\n' "$last"
}

# The owner key, in this order: ISOLATED_SESSION_OWNER (a harness or a sessionStart
# hook set it, or a test), then a harness key the caller read off a hook payload
# ($1, e.g. cursor:<conversation_id>), then the process walk.
iso_owner() {
  if [[ -n "${ISOLATED_SESSION_OWNER:-}" ]]; then
    printf '%s\n' "$ISOLATED_SESSION_OWNER"
    return 0
  fi
  if [[ -n "${1:-}" ]]; then
    printf '%s\n' "$1"
    return 0
  fi
  iso_owner_pid
}

# Harnesses whose payload id may become the owner key: only those that also carry
# that key into the chat's shells, otherwise the chat would refuse its own commits.
# Cursor does (the sessionStart response's `env`). Claude Code has one process per
# chat and needs no key. Extend here, one word per harness.
iso_harness_keys_shells() {
  case "$1" in
    cursor) return 0 ;;
    *) return 1 ;;
  esac
}

# The kind of owner: from the key's prefix, else from the process's executable.
iso_owner_kind() {  # $1 owner, [$2 pid]
  local owner="$1" pid="${2:-}" comm
  case "$owner" in
    *:*) printf '%s\n' "${owner%%:*}"; return 0 ;;
  esac
  [[ -n "$pid" ]] || pid="$owner"
  comm="$(iso_proc_comm "$pid")"
  case "$comm" in
    claude|claude-code) echo claude ;;
    codex) echo codex ;;
    grok|xai-grok-pager) echo grok ;;
    "Grok Bot"*|Grok*) echo grokbot ;;
    Cursor*|cursor*) echo cursor ;;
    Code*|code*|Electron) echo vscode ;;
    '') echo unknown ;;
    *) echo shell ;;
  esac
}

# The start time of process $1 as `ps` prints it; empty when the process is gone.
# Recorded into the lock so a pid the OS hands out again after the owner died does
# not look like a live owner.
iso_proc_start() {
  ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//; s/ *$//'
}

iso_proc_comm() {
  ps -o comm= -p "$1" 2>/dev/null | sed 's#.*/##'
}

# 0 when pid $1 is alive AND (when $2 is given) still the process the lock recorded.
iso_owner_alive() {
  local pid="$1" recorded="${2:-}" now
  iso_is_pid "$pid" || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ -z "$recorded" ]] && return 0
  now="$(iso_proc_start "$pid")"
  [[ -z "$now" || "$now" == "$recorded" ]]
}

# --- the session lock -------------------------------------------------------

# The lock file for worktree $1: inside that worktree's git dir.
iso_lock_path() {
  local gd
  gd="$(git -C "$1" rev-parse --git-dir 2>/dev/null)" || return 1
  [[ "$gd" == /* ]] || gd="$(cd "$1" && cd "$gd" && pwd)"
  printf '%s\n' "$gd/isolated-session.lock"
}

iso_lock_get() {  # $1 lock file, $2 key
  sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1
}

# Rewrite one key of a lock (whole file, tmp + mv: sed -i differs between BSD and GNU).
iso_lock_set() {  # $1 lock file, $2 key, $3 value
  local tmp="$1.tmp"
  { grep -v "^$2=" "$1" 2>/dev/null || true; echo "$2=$3"; } > "$tmp" && mv "$tmp" "$1"
}

# A lock is alive when its process is, and -- for a key-owned lock, whose chat may end
# without a sessionEnd -- when it was seen within ISOLATED_SESSION_OWNER_TTL_HOURS
# (default 12). Every `mine` verdict touches it, so a chat in use never expires.
iso_lock_alive() {  # $1 lock file
  local owner pid seen ttl now
  owner="$(iso_lock_get "$1" owner)"
  if iso_is_pid "$owner"; then
    iso_owner_alive "$owner" "$(iso_lock_get "$1" owner_started)"
    return $?
  fi
  pid="$(iso_lock_get "$1" owner_pid)"
  if [[ -n "$pid" ]] && ! iso_owner_alive "$pid" "$(iso_lock_get "$1" owner_started)"; then
    return 1
  fi
  seen="$(iso_lock_get "$1" owner_seen)"
  [[ -n "$seen" ]] || seen="$(iso_lock_get "$1" started)"
  if [[ -z "$seen" ]]; then return 1; fi
  ttl="${ISOLATED_SESSION_OWNER_TTL_HOURS:-12}"
  now="$(date +%s)"
  if (( now - seen < ttl * 3600 )); then return 0; fi
  return 1
}

# alive | gone | expired -- why a lock is or is not live, for a sentence.
iso_lock_liveness() {  # $1 lock file
  local owner pid
  if iso_lock_alive "$1"; then echo alive; return 0; fi
  owner="$(iso_lock_get "$1" owner)"
  if iso_is_pid "$owner"; then echo gone; return 0; fi
  pid="$(iso_lock_get "$1" owner_pid)"
  if [[ -n "$pid" ]] && ! iso_owner_alive "$pid" "$(iso_lock_get "$1" owner_started)"; then
    echo gone
  else
    echo expired
  fi
}

# free | mine | dead | other -- the lock of worktree $1 as seen by owner $2.
iso_lock_state() {
  local lock owner
  lock="$(iso_lock_path "$1")" || { echo free; return 0; }
  [[ -f "$lock" ]] || { echo free; return 0; }
  owner="$(iso_lock_get "$lock" owner)"
  if [[ "$owner" == "$2" ]]; then
    echo mine
  elif iso_lock_alive "$lock"; then
    echo other
  else
    echo dead
  fi
}

# Write the lock: $1 worktree, $2 owner, $3 kind, $4 branch, $5 task.
iso_lock_write() {
  local lock pid
  lock="$(iso_lock_path "$1")" || return 1
  if iso_is_pid "$2"; then pid="$2"; else pid="$(iso_owner_pid)"; fi
  {
    echo "owner=$2"
    echo "owner_pid=$pid"
    echo "owner_started=$(iso_proc_start "$pid")"
    echo "owner_comm=$(iso_proc_comm "$pid")"
    echo "owner_kind=$(iso_owner_kind "$2" "$pid")"
    echo "owner_seen=$(date +%s)"
    echo "kind=$3"
    echo "branch=$4"
    echo "task=$(printf '%s' "$5" | tr '\n' ' ')"
    echo "started=$(date +%s)"
    echo "started_iso=$(date '+%Y-%m-%d %H:%M')"
    echo "host=$(hostname)"
  } > "$lock"
}

# Mark worktree $1's lock as seen now (called on every `mine` verdict).
iso_lock_touch() {
  local lock
  lock="$(iso_lock_path "$1")" || return 0
  [[ -f "$lock" ]] || return 0
  iso_lock_set "$lock" owner_seen "$(date +%s)"
}

iso_lock_release() {
  local lock
  lock="$(iso_lock_path "$1")" || return 0
  rm -f "$lock"
}

# --- the landing lock -------------------------------------------------------
# One landing at a time per primary. The file lives in the COMMON git dir (shared by
# every worktree, so it survives `git worktree remove` and a crash) and is taken with
# noclobber, so two finishes racing for it get one winner. Same owner rules as the
# worktree lock: a live holder is waited for, a dead one taken over.

# ---- the no-push speed bump -------------------------------------------------------------
# Sessions never push; the owner pushes on purpose. Until 2026-09-12 that was a promise
# (allowlists, briefs); by the owner's decision A `<common git dir>/hooks/pre-push`
# refuses every push unless ISOLATED_SESSION_PUSH=1 is in the environment -- something
# a human types in a terminal, and something tools/sec_lint.py refuses inside any
# script. Installed by ensure-worktree.sh, claim-worktree.sh and the session guard, so a
# checkout that has hosted one session has it.
#
# What it is and is not (the ninth landing review, 2026-09-12): a client-side hook stops
# an honest session and a mistake; it cannot stop a same-uid process that sets the
# variable itself, passes `--no-verify`, or points `core.hooksPath` elsewhere. The wall
# against THAT is a push credential a process cannot use without the owner (an SSH key
# added with `ssh-add -c`, or none on the box) -- the owner's decision, recorded in
# ISSUE(push-credential-confirmation).
#
# The hook is verified by CONTENT, not by a comment: an existing hook that carries our
# marker but not our body is rewritten (`repaired`); one without the marker is someone
# else's and is left alone (`foreign`). Nothing here opens the hook path for writing: the
# file is written beside it and renamed over it, so a FIFO or a symlink planted there
# cannot block or redirect the installer (`replaced`).
ISO_PREPUSH_MARK="isolated-session pre-push v1"

iso_prepush_body() {
  cat <<'EOF'
#!/bin/sh
# isolated-session pre-push v1 -- installed by the isolated-session skill (lib.sh).
# Sessions never push. A push goes through only when ISOLATED_SESSION_PUSH=1 is in the
# environment: the owner types it, on purpose, from a terminal:
#   ISOLATED_SESSION_PUSH=1 git push origin main
# tools/sec_lint.py refuses that spelling inside any script, so no script carries it.
# The hand-off is the exception: a bare repository on this machine, credential-free,
# that the publisher (another user, the only GitHub token) reads and publishes from
# (company/ops/publisher/README.md). A landing pushes BASE there.
# (`*` in a case pattern crosses `/`, so the name after the root is checked to be one
# component: `muretai-handoff/../elsewhere/x.git` is not the hand-off)
case "${2:-}" in
  /Users/Shared/muretai-handoff/*.git|file:///Users/Shared/muretai-handoff/*.git)
    case "${2#*muretai-handoff/}" in
      */*) ;;
      *) exit 0 ;;
    esac ;;
esac
if [ "${ISOLATED_SESSION_PUSH:-}" = "1" ]; then
  exit 0
fi
echo "pre-push: refusing to push to $1 -- sessions never push. The owner pushes with: ISOLATED_SESSION_PUSH=1 git push ..." >&2
exit 1
EOF
}

iso_prepush_install() {  # $1 any path in the checkout -> installed|present|repaired|replaced|foreign|none
  local gd hook tmp state
  gd="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)" || { echo none; return 0; }
  [[ "$gd" == /* ]] || gd="$(cd "$1" && cd "$gd" && pwd)"
  hook="$gd/hooks/pre-push"
  state=installed
  if [[ -h "$hook" || ( -e "$hook" && ! -f "$hook" ) ]]; then
    state=replaced                       # a symlink, a FIFO, a directory: not a hook
  elif [[ -f "$hook" ]]; then
    if iso_prepush_body | cmp -s - "$hook" 2>/dev/null && [[ -x "$hook" ]]; then
      echo present
      return 0
    fi
    if grep -q "$ISO_PREPUSH_MARK" "$hook" 2>/dev/null; then
      state=repaired
    else
      echo foreign
      return 0
    fi
  fi
  mkdir -p "$gd/hooks" 2>/dev/null || { echo none; return 0; }
  tmp="$(mktemp "$gd/hooks/pre-push.XXXXXX" 2>/dev/null)" || { echo none; return 0; }
  iso_prepush_body > "$tmp"
  chmod 755 "$tmp" 2>/dev/null || true
  if [[ -d "$hook" ]]; then
    rm -rf "$hook" 2>/dev/null || { rm -f "$tmp"; echo none; return 0; }
  fi
  mv -f "$tmp" "$hook" 2>/dev/null || { rm -f "$tmp"; echo none; return 0; }
  echo "$state"
}

iso_prepush_line() {  # $1 any path in the checkout -> the receipt value, with the caveat
  local state hp
  state="$(iso_prepush_install "$1")"
  # the value is attacker-settable and goes onto an operator-read line: first line only,
  # control bytes out, bounded
  # The caveat fires when the KEY is set, not when its value survives sanitizing: an empty
  # value and a value that starts with a byte no locale accepts both sideline the hook
  # (ISSUE(security-audit-2026-09-12-the-wall-is-honest-about)). Asked from the path the
  # caller gave, so a worktree-scoped value (extensions.worktreeConfig) is seen when the
  # caller is a worktree (-2).
  # ... and from the primary as well: per-worktree config is not shared, so a value in
  # the PRIMARY's config.worktree sidelines a push from the primary while a worktree
  # sees nothing (ISSUE(security-audit-2026-09-12-the-scan-joins-continued-6)).
  local gd prim where
  gd="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)" || gd=""
  prim=""
  if [[ -n "$gd" ]]; then
    [[ "$gd" == /* ]] || gd="$(cd "$1" && cd "$gd" && pwd)"
    prim="$(dirname "$gd")"
  fi
  for where in "$1" "$prim"; do
    [[ -n "$where" && -d "$where" ]] || continue
    if hp="$(git -C "$where" config --get core.hooksPath 2>/dev/null)"; then
      hp="$(printf '%s' "$hp" | head -n 1 | LC_ALL=C tr -d '\000-\037\177' | cut -c1-200)"
      state="${state} (not consulted: core.hooksPath=${hp:-(empty)})"
      break
    fi
  done
  printf '%s\n' "$state"
}

iso_land_lock_path() {  # $1 primary (or any path in the checkout)
  local gd
  gd="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)" || return 1
  [[ "$gd" == /* ]] || gd="$(cd "$1" && cd "$gd" && pwd)"
  printf '%s/landing.lock\n' "$gd"
}

iso_land_lock_state() {  # $1 primary, $2 me -> free|mine|dead|other
  local lock owner
  lock="$(iso_land_lock_path "$1")" || { echo free; return 0; }
  [[ -f "$lock" ]] || { echo free; return 0; }
  owner="$(iso_lock_get "$lock" owner)"
  if [[ "$owner" == "$2" ]]; then
    echo mine
  elif iso_lock_alive "$lock"; then
    echo other
  else
    echo dead
  fi
}

iso_land_lock_take() {  # $1 primary, $2 owner, $3 branch -> 0 when this call created it
  local lock pid
  lock="$(iso_land_lock_path "$1")" || return 1
  if iso_is_pid "$2"; then pid="$2"; else pid="$(iso_owner_pid)"; fi
  (
    set -o noclobber
    {
      echo "owner=$2"
      echo "owner_pid=$pid"
      echo "owner_started=$(iso_proc_start "$pid")"
      echo "owner_comm=$(iso_proc_comm "$pid")"
      echo "owner_kind=$(iso_owner_kind "$2" "$pid")"
      echo "owner_seen=$(date +%s)"
      echo "kind=landing"
      echo "branch=$3"
      echo "task=landing $3"
      echo "started=$(date +%s)"
      echo "started_iso=$(date '+%Y-%m-%d %H:%M')"
      echo "host=$(hostname)"
    } > "$lock"
  ) 2>/dev/null
}

iso_land_lock_release() {
  local lock
  lock="$(iso_land_lock_path "$1")" || return 0
  rm -f "$lock"
}

iso_land_lock_describe() {
  local lock owner
  lock="$(iso_land_lock_path "$1")" || return 0
  [[ -f "$lock" ]] || { echo "nobody"; return 0; }
  owner="$(iso_lock_get "$lock" owner)"
  printf 'landing of %s by owner %s (%s, %s, %s) since %s\n' \
    "$(iso_lock_get "$lock" branch)" "$owner" "$(iso_lock_get "$lock" owner_kind)" \
    "$(iso_lock_get "$lock" owner_comm)" "$(iso_lock_liveness "$lock")" "$(iso_lock_get "$lock" started_iso)"
}

iso_seen_ago() {  # $1 lock file -> "3m ago"
  local seen now d
  seen="$(iso_lock_get "$1" owner_seen)"
  [[ -n "$seen" ]] || seen="$(iso_lock_get "$1" started)"
  [[ -n "$seen" ]] || { echo "never"; return 0; }
  now="$(date +%s)"
  d=$(( now - seen ))
  if (( d < 120 )); then echo "${d}s ago"
  elif (( d < 7200 )); then echo "$(( d / 60 ))m ago"
  else echo "$(( d / 3600 ))h ago"; fi
}

# One line a person can read about who holds worktree $1.
iso_lock_describe() {
  local lock owner kind
  lock="$(iso_lock_path "$1")" || return 0
  [[ -f "$lock" ]] || { echo "nobody"; return 0; }
  owner="$(iso_lock_get "$lock" owner)"
  kind="$(iso_lock_get "$lock" owner_kind)"
  [[ -n "$kind" ]] || kind="$(iso_owner_kind "$owner")"
  printf 'owner %s (%s, %s, %s, seen %s) since %s, task "%s"\n' \
    "$owner" "$kind" "$(iso_lock_get "$lock" owner_comm)" "$(iso_lock_liveness "$lock")" \
    "$(iso_seen_ago "$lock")" "$(iso_lock_get "$lock" started_iso)" "$(iso_lock_get "$lock" task)"
}

# The sentence that fixes the one honest mismatch: a shell without the harness key
# (a Cursor chat whose env did not arrive) meeting a lock its own hook took.
iso_lock_fix_hint() {  # $1 worktree, $2 me
  local lock owner
  lock="$(iso_lock_path "$1")" || return 0
  [[ -f "$lock" ]] || return 0
  owner="$(iso_lock_get "$lock" owner)"
  if ! iso_is_pid "$owner" && iso_is_pid "$2"; then
    echo "This shell carries no ISOLATED_SESSION_OWNER; if that lock is this chat's, run:"
    echo "  export ISOLATED_SESSION_OWNER=${owner}"
  fi
}

# The open-session inventory for primary $1, one worktree per line. Used by
# stale.sh and by the hook's SessionStart context.
iso_sessions_report() {
  local primary="$1" wt lock owner state kind branch okind
  local found=0
  while IFS= read -r wt; do
    lock="$(iso_lock_path "$wt" 2>/dev/null)" || continue
    [[ -f "$lock" ]] || continue
    found=1
    owner="$(iso_lock_get "$lock" owner)"
    case "$(iso_lock_liveness "$lock")" in
      alive) state="alive" ;;
      expired) state="EXPIRED" ;;
      *) state="GONE" ;;
    esac
    kind="$(iso_lock_get "$lock" kind)"
    branch="$(iso_lock_get "$lock" branch)"
    okind="$(iso_lock_get "$lock" owner_kind)"
    [[ -n "$okind" ]] || okind="$(iso_owner_kind "$owner")"
    printf '   %-60s %-6s %-40s owner=%s (%s, %s, %s, seen %s) since %s\n' \
      "$wt" "$kind" "$branch" "$owner" "$okind" "$(iso_lock_get "$lock" owner_comm)" "$state" \
      "$(iso_seen_ago "$lock")" "$(iso_lock_get "$lock" started_iso)"
  done < <(git -C "$primary" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')
  [[ "$found" == "1" ]] || echo "   (none)"
}

# --- design paths -----------------------------------------------------------

# A repository that separates design work from the rest lists the paths a design
# session owns, one per line, in .cursor/design-paths (directory prefixes end in
# "/"; anything else is an exact file). No file: the repository has no design
# sessions, and every session is a dev session.
iso_design_paths_file() {
  printf '%s\n' "$1/.cursor/design-paths"
}

iso_kind_of_branch() {
  case "$1" in
    design/*) echo design ;;
    *) echo dev ;;
  esac
}

# 0 when repo-relative path $2 is inside the design paths declared by primary $1.
iso_is_design_path() {
  local f p
  f="$(iso_design_paths_file "$1")"
  [[ -f "$f" ]] || return 1
  while IFS= read -r p || [[ -n "$p" ]]; do
    p="${p%%#*}"
    p="${p#"${p%%[![:space:]]*}"}"
    p="${p%"${p##*[![:space:]]}"}"
    [[ -z "$p" ]] && continue
    if [[ "$p" == */ ]]; then
      [[ "$2" == "$p"* ]] && return 0
    else
      [[ "$2" == "$p" ]] && return 0
    fi
  done < "$f"
  return 1
}
