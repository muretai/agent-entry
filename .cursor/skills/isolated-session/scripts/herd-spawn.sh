#!/usr/bin/env bash
# Start one worker session through herdr: a tab in a checkout, an interactive agent
# in it (its own process, so the session guard sees it as its own session), and a
# brief as its first prompt.
#
#   herd-spawn.sh <name> <brief-file> [--cwd DIR] [--profile worker|reviewer]
#                 [--env K=V ...] [--var KEY=VALUE ...]
#
#   name        the worker: its herdr tab label and agent name, its own directory
#               $HERD_DIR/<name>/ (the one directory added to the session) and its
#               report there, $HERD_DIR/<name>/report.md. HERD_DIR defaults to
#               ~/.cache/muretai-herd (never /tmp: see iso_herd_dir), and it, the
#               cwd and everything above them must be writable by nobody else;
#               ~/.cache/muretai-herd; it is created mode 700 when absent and refused (exit 2)
#               when it exists and someone else owns it: a brief is a prompt for an
#               autonomous session, and a report is what the owner reads.
#   brief-file  the prompt. {{KEY}} placeholders are filled from --var KEY=VALUE;
#               {{NAME}}, {{PRIMARY}} (the cwd) and {{REPORT}} are filled for you,
#               in one pass (a value is never re-scanned for a later key). The
#               filled copy is $HERD_DIR/briefs/<name>.md, and a placeholder the
#               template carries that nobody filled stops the spawn (exit 2) rather
#               than reaching a worker as literal braces. What herdr is told to
#               prompt is the text this script rendered, not a re-read of the file.
#   --cwd DIR   where the tab opens; default: the primary checkout of the repository
#               this script lives in. A worker opens its own worktree from there.
#   --profile   which allowlist the session gets (below). `worker` (default) may run
#               the test runner and the test files; `reviewer` may not -- a reviewer
#               runs no tests, its brief says so, and what it reads is a diff an
#               attacker may have authored in full, so it gets no exec it does not need.
#   --env K=V   extra environment for the tab (repeatable)
#
# Exit 3, one line on stderr, when herdr is not on PATH or its server is not running
# (HERD_SPAWN_BIN names the binary explicitly; the tests point it at a stub). Exit 2
# on a usage error. On success the one stdout line is
#   worker=<name> pane=<id> tab=<id> report=<path>
#
# The agent runs on `opus` (HERD_SPAWN_MODEL overrides it: an alias or a model id) and
# in `auto` permission mode (HERD_SPAWN_PERMISSION_MODE overrides it,
# and only with `auto`, `acceptEdits`, `manual` or `plan`: anything else -- a
# `bypassPermissions`, a `dontAsk`, an empty string -- is exit 2 before herdr is asked
# anything, and the value is not handed down: a worker's own landing spawns the next
# reviewer from the default again unless that worker's environment says otherwise):
# the classifier answers the routine prompts and stops on the risky ones, which is what
# lets a worker run unattended -- in acceptEdits the first real reviewer stopped on
# every read-only `git config` and `ls` outside the allowlist. The project's PreToolUse
# hook still refuses the primary and other sessions' worktrees whatever the mode; the
# allowlist below covers what the briefs ask for and no more: a Bash rule matches the
# command's PREFIX, so `python3` alone would have allowed `python3 -c` anything, and a
# directory prefix (`python3 tools/`) would have run a `tools/evil.py` the reviewed diff
# itself landed -- the rules name each script by its exact path, plus `-m agent.plugins`
# and (worker profile only) `test_*.py`; `cat` is not on it (Read is the tool for a
# file). `git push` is refused outright -- by the session's own rule, which is a promise
# the session keeps, not a guard on the remote. A worker is an interactive session,
# billed like one.
#
# The rules reach the session as a settings file the spawn writes EXCLUSIVELY
# ($HERD_DIR/<name>/permissions.json: the exact path is removed first, then created
# O_EXCL mode 600, so a planted symlink is unlinked and never followed and a racer's
# file is a refusal, not a merge), in a per-worker directory that must be a real
# directory the caller owns (created mode 700; a symlink or another uid's directory is
# exit 2). The session loads the project and local settings only (`--setting-sources
# project,local`): the owner's user-global allow rules never reach a worker, so the file
# is the rules, not a patch over an inherited allow. The deny list names the shell
# readers and interpreters that would read around `--add-dir` (sed, awk, od, perl, a
# versioned python3, `git diff --no-index`, ...). A deny list is not containment: it
# removes the commands the classifier might wave through, and nothing else -- see
# ISSUE(reviewer-sandbox-is-a-denylist).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

usage() {
  echo "usage: herd-spawn.sh <name> <brief-file> [--cwd DIR] [--profile worker|reviewer] [--env K=V ...] [--var KEY=VALUE ...]" >&2
  exit 2
}

name="${1:-}"
brief="${2:-}"
[[ -n "$name" && -n "$brief" ]] || usage
shift 2
# herdr's own rule for an agent name (checked here so the reason is one line, not a JSON
# error after the tab exists): a lowercase letter, then [a-z0-9_-], 32 characters at most
case "$name" in
  *[!a-z0-9_-]*|[!a-z]*)
    echo "herd-spawn: a worker name is [a-z][a-z0-9_-]* (herdr's agent-name rule; it also names a tab and a file): ${name}" >&2
    exit 2
    ;;
esac
if [[ ${#name} -gt 32 ]]; then
  echo "herd-spawn: a worker name is at most 32 characters (herdr's agent-name rule): ${name} (${#name})" >&2
  exit 2
fi
if [[ ! -f "$brief" ]]; then
  echo "herd-spawn: no brief at ${brief}" >&2
  exit 2
fi

cwd=""
profile="worker"
envs=()
vars=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd) [[ $# -ge 2 ]] || usage; cwd="$2"; shift 2 ;;
    --profile) [[ $# -ge 2 ]] || usage; profile="$2"; shift 2 ;;
    --env) [[ $# -ge 2 ]] || usage; envs+=("$2"); shift 2 ;;
    --var) [[ $# -ge 2 ]] || usage; vars+=("$2"); shift 2 ;;
    *) echo "herd-spawn: unknown argument: $1" >&2; usage ;;
  esac
done
case "$profile" in
  worker|reviewer) ;;
  *) echo "herd-spawn: --profile is worker or reviewer (got '${profile}'); the worker ${name} was not started" >&2; exit 2 ;;
esac

# --- the permission mode: one of four words, checked before herdr is asked anything ----
# Unset means `auto`; set means exactly one of the accepted values (an empty string is
# not "unset", it is a value nobody meant). The validated literal goes on the command
# line and the variable is dropped from this process, so a spawn started by a worker
# (its landing spawns the next reviewer) does not inherit a mode it never chose.
permission_mode="${HERD_SPAWN_PERMISSION_MODE-auto}"
case "$permission_mode" in
  auto|acceptEdits|manual|plan) ;;
  *)
    echo "herd-spawn: HERD_SPAWN_PERMISSION_MODE must be one of auto, acceptEdits, manual, plan (got '${permission_mode}'); the worker ${name} was not started" >&2
    exit 2
    ;;
esac
unset HERD_SPAWN_PERMISSION_MODE
# The model: `opus` unless HERD_SPAWN_MODEL says otherwise (a model alias or id, one
# token of letters, digits, dots and dashes). A reviewer reads a diff for twenty to
# forty minutes; on the owner's subscription that is the cost that matters, and the
# top-tier model is not what the reading needs. Dropped from this process like the
# mode, so a worker's own spawns start from the default again.
# The harness: `claude` (Claude Code) or `cursor` (Cursor's CLI agent, `cursor-agent`),
# HERD_SPAWN_HARNESS. herdr drives either in a pane; the brief, the report directory and
# the receipt tools are the same. Cursor reads its rules from `<cwd>/.cursor/cli.json`
# (written below from the same allow/deny lists) and runs in its classifier mode
# (`--auto-review`); the isolated-session hook speaks its dialect already. Another
# model's eyes on a diff see other things; the cost lands on the other plan.
harness="${HERD_SPAWN_HARNESS-claude}"
case "$harness" in
  claude|cursor) ;;
  *)
    echo "herd-spawn: HERD_SPAWN_HARNESS must be claude or cursor (got '${harness}'); the worker ${name} was not started" >&2
    exit 2
    ;;
esac
unset HERD_SPAWN_HARNESS
# A Cursor session reads the user's own instruction files -- ~/.cursor/rules/*.mdc,
# ~/.agents/skills/ -- and cursor-agent has no switch to leave them out (measured
# 2026-09-12: a rule planted under ~/.cursor/rules steered a herd session at once).
# Every one of those is the owner's user's to write, so a session of that user could
# dictate a reviewer's receipt through them. Until Cursor honours an instruction home
# the spawn owns, a Cursor session reviews nothing
# (ISSUE(security-audit-2026-09-12-a-herd-session-can-r-b1b5)); and its rules file
# lives in the cwd, shared by every Cursor session there, so the cwd is never the
# primary (-2).
if [[ "$harness" == "cursor" && "$profile" == "reviewer" ]]; then
  echo "herd-spawn: the cursor harness reviews nothing yet: cursor-agent reads the user's own rules and skills, which any session of this user may write; the worker ${name} was not started" >&2
  exit 2
fi
# The model: for claude `opus` unless HERD_SPAWN_MODEL says otherwise; for cursor the
# account's default unless it does. One token: letters, digits, dots, dashes, and the
# bracketed overrides Cursor's names carry (`x[context=1m,effort=high]`). Set but empty,
# or anything else, is exit 2 before herdr is asked; dropped from this process like the
# mode, so a worker's own spawns start from the default again.
model=""
if [[ -n "${HERD_SPAWN_MODEL+set}" ]]; then
  model="$HERD_SPAWN_MODEL"
  if ! [[ "$model" =~ ^[a-z][]a-z0-9.=,[-]{0,79}$ ]]; then
    echo "herd-spawn: HERD_SPAWN_MODEL must be a model alias or id (letters, digits, dots, dashes, bracketed overrides; got '${model}'); the worker ${name} was not started" >&2
    exit 2
  fi
fi
[[ -n "$model" || "$harness" != "claude" ]] || model="opus"
unset HERD_SPAWN_MODEL

# --- herdr: on PATH (or HERD_SPAWN_BIN) and its server up, else exit 3 ---------------
herdr="${HERD_SPAWN_BIN:-}"
if [[ -n "$herdr" ]]; then
  if [[ ! -x "$herdr" ]]; then
    echo "herd-spawn: no herdr binary at HERD_SPAWN_BIN=${herdr}; the worker ${name} was not started" >&2
    exit 3
  fi
else
  herdr="$(command -v herdr 2>/dev/null || true)"
  if [[ -z "$herdr" ]]; then
    echo "herd-spawn: herdr is not on PATH (https://herdr.dev); the worker ${name} was not started" >&2
    exit 3
  fi
fi
if ! "$herdr" status >/dev/null 2>&1; then
  echo "herd-spawn: 'herdr status' failed -- the herdr server is not running; the worker ${name} was not started" >&2
  exit 3
fi

# --- where the tab opens ---------------------------------------------------------------
if [[ -z "$cwd" ]]; then
  cwd="$(iso_primary_of "$here")" || {
    echo "herd-spawn: this script is not inside a git checkout; pass --cwd DIR" >&2
    exit 2
  }
fi
if [[ ! -d "$cwd" ]]; then
  echo "herd-spawn: cwd not found: ${cwd}" >&2
  exit 2
fi
cwd="$(cd "$cwd" && pwd)"

# --- HERD_DIR: ours, or nothing is written there ----------------------------------------
# Created mode 700 when absent. An existing directory someone else owns (a shared host's
# /tmp, a directory planted before us) is refused: whoever owns it could swap a brief
# or rewrite a report.
herd_dir="$(iso_herd_dir)" || {
  echo "herd-spawn: neither HERD_DIR nor HOME is set, so there is no herd directory; the worker ${name} was not started" >&2
  exit 2
}
# absolute, so the Edit rules and the excludes below name real paths
[[ "$herd_dir" == /* ]] || herd_dir="$(pwd)/${herd_dir}"
if [[ ! -d "$herd_dir" ]]; then
  mkdir -p "$herd_dir"
  chmod 700 "$herd_dir" 2>/dev/null || true
fi
if [[ ! -O "$herd_dir" ]]; then
  echo "herd-spawn: ${herd_dir} is not owned by $(id -un) (HERD_DIR); refusing to write a brief or a report there; the worker ${name} was not started" >&2
  exit 2
fi
# ... and nothing above it, or above the worker's cwd, is writable by others: Claude
# Code reads CLAUDE.md from the cwd and every directory above it, so a
# /private/tmp/CLAUDE.md planted by any local uid would reach a worker started there
# (ISSUE(security-audit-2026-09-12-the-review-checkout-lives-4))
if ! open_dir="$(iso_private_path "$herd_dir")"; then
  echo "herd-spawn: ${open_dir}, at or above ${herd_dir}, is writable by others; a CLAUDE.md there would reach the worker; set HERD_DIR under your home; the worker ${name} was not started" >&2
  exit 2
fi
if ! open_dir="$(iso_private_path "$cwd")"; then
  echo "herd-spawn: ${open_dir}, at or above the cwd ${cwd}, is writable by others; a CLAUDE.md there would reach the worker; the worker ${name} was not started" >&2
  exit 2
fi
# A directory under it is ours or nothing is written into it: a real directory (a
# symlink planted at $HERD_DIR/<name> by an earlier, prompt-injected session would carry
# the next reviewer's rules file wherever it points), created mode 700 when absent and
# owned by the caller when present. -L before -d: -d follows a symlink to a directory.
own_dir() {
  if [[ -L "$1" ]]; then
    echo "herd-spawn: $1 is a symlink, not a directory; refusing to write there; the worker ${name} was not started" >&2
    exit 2
  fi
  if [[ ! -d "$1" ]]; then
    mkdir -m 700 "$1" 2>/dev/null || {
      echo "herd-spawn: cannot create $1 (something else is in the way); the worker ${name} was not started" >&2
      exit 2
    }
  elif [[ ! -O "$1" ]]; then
    echo "herd-spawn: $1 is not owned by $(id -un); refusing to write there; the worker ${name} was not started" >&2
    exit 2
  fi
}
own_dir "$herd_dir/briefs"
own_dir "$herd_dir/${name}"
report="$herd_dir/${name}/report.md"
rendered="$herd_dir/briefs/${name}.md"
perms="$herd_dir/${name}/permissions.json"
brief_abs="$(cd "$(dirname "$brief")" && pwd)/$(basename "$brief")"

# --- the command herdr will type, bounded -----------------------------------------------
# herdr TYPES the command into the pane, and a pty takes about 1 KB of typed input
# before it drops the rest: the argv form of the rules was cut off at
# `--disallowedTools ... 'Bash(tail:*` once the deny list existed (2026-09-12), and
# claude never started. The rules travel as a settings file to keep the line short, and
# HERD_DIR -- inherited from the environment, on the line twice -- could push it back
# over the limit: a line truncated at the `--settings` token would still be a valid
# `claude --add-dir <dir>`, with no rules at all. So the line is measured here and a long
# one is a refusal before herdr is asked anything, never a session with fewer rules.
#
# --setting-sources project: the owner's user-global settings are not loaded, so a
# worker never inherits an allow rule from ~/.claude/settings.json, and neither is the
# machine-local .claude/settings.local.json, where interactive "don't ask again" grants
# accumulate (ISSUE(security-audit-2026-09-12-the-reviewer-sandbox-an-e-3)); the project's
# own settings (the session-guard hook) and the --settings file (this spawn's rules) are.
# A claude too old for the flag refuses to start ("unknown option"), which the retry
# loop reports as exit 1: closed, not open.
# --strict-mcp-config: no MCP server from ~/.claude.json or a project file reaches a
# herd session (none is passed, so none is loaded)
if [[ "$harness" == "cursor" ]]; then
  # --trust: no workspace prompt in a pane nobody answers; --workspace pins the checkout
  # the tab opened in. NOT --auto-review: under the classifier mode Cursor's CLI ran
  # `git push`, `cat` and `curl` past their deny rules (measured 2026-09-12); in the
  # account's allowlist mode a denied command is "blocked by permissions
  # configuration", an allowed one runs, and an unlisted one waits for a person -- the
  # session shows as `blocked` in herdr, which is the safe failure.
  # The user's own config is unioned into every Cursor session (the CLI has no
  # project-only setting source), so it must be allowlist mode AND carry no allow of its
  # own -- an "always allow" click persists there and would arm every later herd session
  # (ISSUE(security-audit-2026-09-12-cursor-s-project-rul-e6f4-3)). The agent resolves
  # its config dir as CURSOR_CONFIG_DIR, else XDG_CONFIG_HOME/cursor, else ~/.cursor; the
  # tab is handed CURSOR_CONFIG_DIR explicitly so the file checked is the file obeyed (-4).
  cursor_home="${HOME:-}/.cursor"
  cursor_cfg="${cursor_home}/cli-config.json"
  if ! why="$(python3 - "$cursor_cfg" <<'PY'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception as e:                                 # noqa: BLE001
    print("unreadable: " + type(e).__name__); sys.exit(1)
if cfg.get("approvalMode") != "allowlist":
    print("approvalMode is %r, not allowlist" % cfg.get("approvalMode")); sys.exit(1)
allowed = (cfg.get("permissions") or {}).get("allow") or []
if allowed:
    print("permissions.allow is not empty (%s): it would be unioned into the session" % ", ".join(allowed[:5])); sys.exit(1)
sys.exit(0)
PY
)"; then
    echo "herd-spawn: ${cursor_cfg}: ${why}; the worker ${name} was not started" >&2
    exit 2
  fi
  if [[ "$(iso_primary_of "$cwd" 2>/dev/null || true)" == "$cwd" ]]; then
    echo "herd-spawn: a cursor session does not start in the primary checkout: its rules file (<cwd>/.cursor/cli.json) is shared by every Cursor session there; pass --cwd <worktree>; the worker ${name} was not started" >&2
    exit 2
  fi
  agent_args=(--trust --workspace "$cwd" --add-dir "$herd_dir/${name}")
  [[ -z "$model" ]] || agent_args+=(--model "$model")
  typed="cursor-agent ${agent_args[*]}"
else
  agent_args=(--permission-mode "$permission_mode" --model "$model" --add-dir "$herd_dir/${name}"
              --settings "$perms" --setting-sources project --strict-mcp-config)
  typed="claude ${agent_args[*]}"
fi
if [[ ${#typed} -gt 900 ]]; then
  echo "herd-spawn: the command herdr would type is ${#typed} characters (bound 900; a pty drops typed input past about 1 KB) -- shorten HERD_DIR (${herd_dir}); the worker ${name} was not started" >&2
  exit 2
fi

# --- the brief, filled ----------------------------------------------------------------
# Built-ins first, --var after, so a caller can override NAME/PRIMARY/REPORT on purpose.
# One pass with a dict: a value is substituted, never re-scanned, so a value carrying
# `{{NAME}}` stays literal. A placeholder the TEMPLATE carries and nobody filled stops
# the spawn. The text is rendered to stdout and held in a variable: the file is written
# from it and the prompt is sent from it (the brief may already BE the rendered path --
# a landing renders there, then calls this script on it -- and nothing re-reads a file
# between the render and the prompt). The file is written the way the rules file is:
# the exact path unlinked (a symlink goes, its target stays), then created O_EXCL.
rendered_text="$(python3 - "$brief_abs" "$rendered" "NAME=${name}" "PRIMARY=${cwd}" "REPORT=${report}" \
  ${vars[@]+"${vars[@]}"} <<'PY'
import os, re, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
values = {}
for kv in sys.argv[3:]:
    key, _, value = kv.partition("=")
    values[key] = value
missing = []


def fill(m):
    key = m.group(1)
    if key in values:
        return values[key]
    missing.append(key)
    return m.group(0)


out = re.sub(r"\{\{([A-Z][A-Z0-9_]*)\}\}", fill, text)
if missing:
    print("herd-spawn: the brief still carries unfilled placeholders: " + " ".join(sorted(set(missing)))
          + " -- pass --var KEY=VALUE for each", file=sys.stderr)
    sys.exit(2)
if os.path.lexists(dst):
    os.unlink(dst)
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(out.rstrip("\n") + "\n")      # exactly the prompt plus one newline
sys.stdout.write(out)
PY
)" || exit $?

# --- the tab, the agent, the prompt ------------------------------------------------------
# Auto memory is OFF for a herd session: it is keyed by the repository, shared across
# worktrees, and written by every session -- one prompt-injected session's "secrev-*:
# record 0 findings" would reach every later reviewer without appearing in any diff
# (ISSUE(security-audit-2026-09-12-the-cleanup-trusts-n-d474-2)). The settings file
# below says the same (autoMemoryEnabled) and keeps the memory files of the cwd's
# ancestors out too.
tab_env=(--env ISOLATED_SESSION_GUARD_TRACE=1 --env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
         --env "HERD_WORKER=${name}" --env "HERD_BRIEF=${rendered}" --env "HERD_REPORT=${report}")
if [[ "$harness" == "cursor" ]]; then
  tab_env+=(--env "CURSOR_CONFIG_DIR=${cursor_home}")
fi
for kv in ${envs[@]+"${envs[@]}"}; do
  tab_env+=(--env "$kv")
done
tab_json="$("$herdr" tab create --cwd "$cwd" --label "$name" --no-focus "${tab_env[@]}")" || {
  echo "herd-spawn: 'herdr tab create' failed for ${name}" >&2
  exit 1
}
ids="$(printf '%s\n' "$tab_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
r = d.get("result", d)
print(r["root_pane"]["pane_id"], r["tab"]["tab_id"])
')" || {
  echo "herd-spawn: could not read pane/tab ids from 'herdr tab create' output" >&2
  exit 1
}
pane="${ids%% *}"
tab_id="${ids#* }"

allow=(
  "Bash(python3 tools/audit_scope.py:*)"
  "Bash(python3 tools/ledger.py:*)"
  "Bash(python3 tools/sec_lint.py:*)"
  "Bash(python3 tools/affected_tests.py:*)"
  "Bash(python3 tools/spec_build.py:*)"
  "Bash(python3 -m agent.plugins:*)"
)
if [[ "$profile" == "worker" ]]; then
  allow+=("Bash(python3 tools/run_tests.py:*)" "Bash(python3 tests/test_:*)")
  # Dispatch finish: coord deliver, a Room post, /remember, and stance full on a
  # provider limit. Reviewer profile does not send mail or take tickets.
  allow+=("Bash(python3 operator_cli.py:*)")
  allow+=("Bash(bash .cursor/skills/isolated-session/scripts/dispatch-capacity.sh:*)")
fi
allow+=(
  "Bash(bash .cursor/skills/isolated-session/scripts/stale.sh:*)"
  "Bash(bash .cursor/skills/isolated-session/scripts/ensure-worktree.sh:*)"
  "Bash(bash .cursor/skills/isolated-session/scripts/assert-head.sh:*)"
  "Bash(bash .cursor/skills/isolated-session/scripts/claim-worktree.sh:*)"
  "Bash(bash .cursor/skills/isolated-session/scripts/finish-worktree.sh:*)"
  "Bash(cd:*)"
  "Bash(git status:*)" "Bash(git add:*)" "Bash(git commit:*)"
  "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)"
  "Bash(git rev-parse:*)" "Bash(git worktree list:*)"
  "Bash(git ls-files:*)"
  "Bash(ls:*)"
)
# `git ls-files` reads tracked content only (never keys/, which is not tracked).
# `git grep -O` / `--open-files-in-pager` runs a program, and `git blame --contents`
# reads any file the uid can read, so those two are not on the allowlist: a session
# navigates with its own search and Read tools, and a `git grep` stops at a prompt
# (the coordinator answers -- that is the intended cost). Measured 2026-09-13: a
# Cursor session in allowlist mode stops at "Waiting for approval" on an unlisted
# git subcommand, and "add to allowlist" writes the USER config, which the spawner
# then refuses for every later spawn.
# What the shell may NOT do even when a rule above would allow it: a deny rule is
# evaluated before any allow rule and before the auto-mode classifier. A deny list is
# NOT containment. `--add-dir` scopes the Read/Edit tools, not Bash; Bash reads whatever
# the uid reads, and the reviewer's cwd is the primary, where `keys/` lives. What the
# list does is remove the commands the classifier might wave through: the readers
# (`cat`, `sed`, `awk`, `od`, `xxd`, `strings`, `dd`, `tr`, `nl`, `rev`, `cut`, `fold`,
# `tee`, `less`, `more`, `head`, `tail`, `grep`, `wc`), the interpreters (`perl`, `ruby`,
# `node`, `php`, `python`, `python3 -c`, `python3 -` for a heredoc, a shell with a dash
# option: `bash -c`, `sh -lc`, ...), `git diff` outside the checkout (prints any file
# as `+` lines: `--no-index`, and git turns it on by itself when an operand is
# `/dev/null` or a path outside the repository, in EITHER position -- so `/dev/null`,
# an absolute, a `../` or a `~` operand and `--output` are denied wherever they stand,
# and `git diff` stays allowed for the range under review), and the network.
# Whatever is not listed goes to the classifier, and `bash <file the session wrote>`
# is not listed. The real wall is a credential no process can use alone and keys no
# session can read: ISSUE(reviewer-sandbox-is-a-denylist).
#
# Spelling (Claude Code's documented rule syntax): `Bash(x:*)` is `Bash(x *)` -- the
# prefix AND a space, so `Bash(ls:*)` does not match `lsof`, and `Bash(python:*)` does
# not reach the allowed `python3 tools/...`. A versioned interpreter (`python3.12`) has
# no space after `python3.`, so that one is the no-space wildcard `Bash(python3.*)`,
# and a shell's dash options (`-c`, `-lc`, `-ic`) are `Bash(bash -*)`. A `*` stands
# anywhere in a rule and matches any text, spaces included, so `Bash(git diff */dev/null*)`
# is `/dev/null` in any position after `git diff ` (measured on 2026-09-13; a deny beats
# any allow whatever the order of the operands: ISSUE(security-audit-2026-09-13-daily-2026-09-13)).
deny=(
  "Bash(git push:*)" "Bash(git -C:*)" "Bash(git -c:*)" "Bash(python3 -c:*)"
  "Bash(git diff --no-index:*)" "Bash(git diff /dev/null:*)" "Bash(git diff --output:*)" "Bash(git diff --output=*)"
  "Bash(git diff *--no-index*)" "Bash(git diff */dev/null*)" "Bash(git diff *--output*)"
  "Bash(git diff /*)" "Bash(git diff * /*)" "Bash(git diff *../*)" "Bash(git diff ~*)" "Bash(git diff * ~*)" "Bash(git diff *\$*)"
  "Bash(git grep -O:*)" "Bash(git grep -O*)" "Bash(git grep --open-files-in-pager:*)" "Bash(git grep --open-files-in-pager=*)"
  "Bash(git grep *-O*)" "Bash(git grep *--open-files-in-pager*)"
  "Bash(git blame --contents:*)" "Bash(git blame --contents=*)"
  "Bash(git blame *--contents*)"
  "Bash(python -c:*)" "Bash(python:*)" "Bash(python3 -:*)" "Bash(python3.*)"
  "Bash(/usr/bin/python3:*)" "Bash(/opt/homebrew/bin/python3:*)" "Bash(/usr/local/bin/python3:*)"
  "Bash(perl:*)" "Bash(ruby:*)" "Bash(node:*)" "Bash(php:*)"
  "Bash(bash -*)" "Bash(sh -*)" "Bash(zsh -*)"
  "Bash(cat:*)" "Bash(head:*)" "Bash(tail:*)" "Bash(grep:*)" "Bash(wc:*)"
  "Bash(sed:*)" "Bash(awk:*)" "Bash(od:*)" "Bash(xxd:*)" "Bash(strings:*)" "Bash(dd:*)"
  "Bash(tr:*)" "Bash(nl:*)" "Bash(rev:*)" "Bash(cut:*)" "Bash(fold:*)" "Bash(tee:*)"
  "Bash(less:*)" "Bash(more:*)"
  "Bash(curl:*)" "Bash(wget:*)" "Bash(ssh:*)" "Bash(scp:*)"
)
# The rules travel as a settings file, not as argv (the typed-line bound above). The
# file is the worker's own, under its report directory, and it is written exclusively:
# `rm -f` the exact path (a planted symlink is removed, never followed; the file a
# previous spawn of the same name left is removed too), then O_CREAT|O_EXCL mode 600 --
# a path that exists again by then is a refusal, and claude is never started on a file
# this spawn did not create.
rm -f "$perms"
HS_CWD="$cwd" HS_HERD="$herd_dir" HS_HARNESS="$harness" HS_NAME="$name" HS_PRIMARY="$(iso_primary_of "$cwd" 2>/dev/null || true)" \
  python3 - "$perms" "${#allow[@]}" "${allow[@]}" "${deny[@]}" <<'PY' || exit 2
import json, os, sys
path, n = sys.argv[1], int(sys.argv[2])
rest = sys.argv[3:]
cwd, herd, home = os.environ["HS_CWD"], os.environ["HS_HERD"], os.environ.get("HOME", "")
name_of_worker = os.environ.get("HS_NAME", "")


def ancestors(p):
    """the STRICT ancestors of p, nearest first"""
    out = []
    p = os.path.dirname(p)
    while True:
        out.append(p)
        parent = os.path.dirname(p)
        if parent == p:
            return out
        p = parent


def abs_rule(p):
    # Claude Code's absolute path form in a rule: a double slash, then the path
    return "Edit(//" + p.lstrip("/") + ")"


# The worker obeys the instruction files of its checkout and below, none above: Claude
# Code loads CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md and .claude/rules/ from every
# directory above the cwd, and those directories are the owner's (the herd, ~/.cache,
# ~), where any same-uid session may write. Each such file is excluded from memory AND
# denied to Edit/Write (an Edit rule covers Write), so a worker can neither read one
# as instructions nor plant one for the next worker. The review checkouts, the briefs
# and ~/.claude (auto memory, user settings) are denied to Edit/Write as well
# (ISSUE(security-audit-2026-09-12-the-cleanup-trusts-n-d474-2)).
anc = []
for base in (cwd, os.path.realpath(cwd)):
    for a in ancestors(base):
        if a not in anc:
            anc.append(a)
excludes = ["/tmp/**", "/private/tmp/**", "/var/tmp/**", "/private/var/tmp/**"]
extra_deny = []
for a in anc:
    for f in ("CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", ".claude/rules/**"):
        excludes.append(os.path.join(a, f))
        extra_deny.append(abs_rule(os.path.join(a, f)))
for d in ("review/**", "briefs/**", "CLAUDE.md", "CLAUDE.local.md", ".claude/**"):
    extra_deny.append(abs_rule(os.path.join(herd, d)))
if home:
    extra_deny.append(abs_rule(os.path.join(home, ".claude/**")))
    # ... and Cursor's, whose user config every Cursor session inherits and where an
    # "always allow" would be persisted (ISSUE(security-audit-2026-09-12-cursor-s-project-rul-e6f4-3))
    extra_deny.append(abs_rule(os.path.join(home, ".cursor/**")))
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except OSError as e:
    print("herd-spawn: could not create the rules file exclusively at " + path + ": " + e.strerror
          + "; the worker was not started", file=sys.stderr)
    sys.exit(2)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    # claudeMdExcludes: a second layer under the ancestor check for the shared
    # temporary directories, and the only layer for the owner's own directories above
    json.dump({"permissions": {"allow": rest[:n], "deny": rest[n:] + extra_deny},
               "autoMemoryEnabled": False,
               "claudeMdExcludes": excludes},
              f, indent=1)
    f.write("\n")


def cursor_rule(rule):
    """Claude Code's spelling to Cursor's: `Bash(x y:*)` (the prefix and a space) is
    `Shell(x:y*)` (the command base, then its arguments); `Bash(x*)` is `Shell(x*)`;
    `Edit(//abs)` is `Write(/abs)`. Deny beats allow in both."""
    if rule.startswith("Bash(") and rule.endswith(")"):
        body = rule[5:-1]
        if body.endswith(":*"):
            first, _, args = body[:-2].partition(" ")
            if not args:
                return ["Shell(%s:*)" % first]
            if args.endswith("_"):
                # a NAME prefix (`python3 tests/test_:*` is every test file
                # under tests/): the wildcard follows the prefix with no space,
                # or `python3 tests/test_x.py` never matches and a Cursor
                # session stops at "Waiting for approval" on each test run
                # (measured 2026-09-13)
                return ["Shell(%s:%s*)" % (first, args)]
            # the boundary Claude's rule carries (the prefix, then a space): the exact
            # arguments, or the arguments followed by more -- never `tools/x.py_evil.py`
            # (ISSUE(security-audit-2026-09-12-cursor-s-project-rul-e6f4-2))
            return ["Shell(%s:%s)" % (first, args), "Shell(%s:%s *)" % (first, args)]
        first, _, args = body.partition(" ")          # `bash -*`: the base, then its arguments
        return ["Shell(%s:%s)" % (first, args) if args else "Shell(" + body + ")"]
    if rule.startswith("Edit(//") and rule.endswith(")"):
        return ["Write(/" + rule[7:-1] + ")"]
    return [rule]


def cursor_rules(rules):
    out = []
    for r in rules:
        out.extend(cursor_rule(r))
    return out


if os.environ.get("HS_HARNESS") == "cursor":
    # the same lists, in Cursor's spelling, at the one place its CLI reads them: the
    # workspace's own .cursor/cli.json (exclusive, like the file above; the path is
    # gitignored in this tree so a worker's primary stays clean). In allowlist mode a
    # write outside an allowed path waits for a person, so the worker's report
    # directory and the primary's session worktrees are allowed: the isolated-session
    # hook -- which Cursor's CLI does run, measured -- still refuses another session's
    # worktree inside that allowance.
    primary = os.environ.get("HS_PRIMARY", "")
    cursor_allow = cursor_rules(rest[:n])
    cursor_allow += ["Read(" + os.path.join(herd, name_of_worker) + "/**)",
                     "Write(" + os.path.join(herd, name_of_worker) + "/**)"]
    cursor_deny = cursor_rules(rest[n:] + extra_deny)
    if primary:
        # the session worktrees may be written (the guard still holds each to its
        # session); the primary is never granted for reading -- its keys/ holds the
        # resident agents' seeds, and the diff is read through git, not the tree
        # (ISSUE(security-audit-2026-09-12-cursor-s-project-rul-e6f4))
        cursor_allow += ["Write(" + os.path.join(primary, ".worktrees") + "/**)"]
        cursor_deny += ["Read(" + os.path.join(primary, "keys") + "/**)"]
    cli = os.path.join(cwd, ".cursor", "cli.json")
    os.makedirs(os.path.dirname(cli), exist_ok=True)
    if os.path.lexists(cli):
        os.unlink(cli)
    fd = os.open(cli, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        # the project file's schema admits `permissions` alone: `version` and
        # `approvalMode` belong to the user's own config, and their presence here made
        # cursor-agent refuse the whole file at its first real spawn (2026-09-12)
        json.dump({"permissions": {"allow": cursor_allow, "deny": cursor_deny}}, f, indent=1)
        f.write("\n")
PY
# A new tab's shell needs a moment to print its prompt, and `herdr agent start` refuses
# a pane that is not at one: called 143 ms after `tab create` it failed (2026-09-12).
# So try again, two seconds apart, for HERD_SPAWN_READY_SECS (default 30). Only a FAST
# failure is retried: an attempt that ran into herdr's own readiness timeout has
# already typed the command, and the deadline has long passed by then.
start_err="$(mktemp "${TMPDIR:-/tmp}/herd-spawn-start.XXXXXX")"
started=no
deadline=$(( $(date +%s) + ${HERD_SPAWN_READY_SECS:-30} ))
while :; do
  if "$herdr" agent start "$name" --kind "$harness" --pane "$pane" --timeout 120000 -- \
       "${agent_args[@]}" >/dev/null 2>"$start_err"; then
    started=yes
    break
  fi
  [[ $(date +%s) -lt $deadline ]] || break
  sleep 2
done
if [[ "$started" != "yes" ]]; then
  echo "herd-spawn: 'herdr agent start' failed for ${name} (pane ${pane}, tab ${tab_id}): $(tail -1 "$start_err" 2>/dev/null)" >&2
  rm -f "$start_err"
  exit 1
fi
rm -f "$start_err"
"$herdr" agent prompt "$name" "$rendered_text" >/dev/null || {
  echo "herd-spawn: 'herdr agent prompt' failed for ${name} (pane ${pane}, tab ${tab_id})" >&2
  exit 1
}
# the harness and the model are on the line, so a landing's REVIEW= and its note can say
# which eyes read the diff
echo "worker=${name} pane=${pane} tab=${tab_id} report=${report} harness=${harness} model=${model:-default}"
