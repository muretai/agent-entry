#!/usr/bin/env bash
# Start one worker session through herdr: a tab in a checkout, an interactive agent
# in it (its own process, so the session guard sees it as its own session), and a
# brief as its first prompt.
#
#   herd-spawn.sh <name> <brief-file> [--cwd DIR] [--profile worker|reviewer|coordinator]
#                 [--env K=V ...] [--var KEY=VALUE ...] [--allow 'Bash(...)' ...]
#                 [--muretai-agent NAME]
#
#   name        the worker: its herdr tab label and agent name, its own directory
#               $HERD_DIR/<name>/ (the one directory added to the session) and its
#               report there, $HERD_DIR/<name>/report.md. HERD_DIR defaults to
#               ~/.cache/muretai-herd (never /tmp: see iso_herd_dir), and it, the
#               cwd and everything above them must be writable by nobody else;
#               ~/.cache/muretai-herd; it is created mode 700 when absent and refused (exit 2)
#               when it exists and someone else owns it: a brief is a prompt for an
#               autonomous session, and a report is what the owner reads.
#   brief-file  the brief. {{KEY}} placeholders are filled from --var KEY=VALUE;
#               {{NAME}}, {{PRIMARY}} (the cwd) and {{REPORT}} are filled for you,
#               in one pass (a value is never re-scanned for a later key), and a
#               placeholder the template carries that nobody filled stops the spawn
#               (exit 2) rather than reaching a worker as literal braces. The filled
#               brief is written to $HERD_DIR/<name>/brief.md (created exclusively,
#               mode 600; one that is already there -- a previous spawn of the same
#               name, or a plant -- is exit 2, never overwritten or rotated) and to
#               the operator's copy $HERD_DIR/briefs/<name>.md. The worker is TOLD one
#               short line: `Read <brief.md> and follow it. Your report goes to
#               <report.md>.` A pty drops typed input past about 1 KB and a stalled
#               prompt is re-typed, so a brief typed into the pane arrived cut short
#               (ISSUE(herd-spawn-stall-recovery-truncates-brief)); the body never
#               travels on any herdr argv. A spawn that fails after writing brief.md
#               removes it, so the retry is not refused by the spawn's own leftover.
#   --cwd DIR   where the tab opens; default: the primary checkout of the repository
#               this script lives in. A worker opens its own worktree from there.
#               REQUIRED in practice for HERD_SPAWN_HARNESS=codex: a codex session's
#               writable sandbox root IS this directory, and no session guard runs on
#               that harness, so a primary checkout here is exit 2 before herdr is asked
#               anything -- name the worktree instead.
#   --profile   which allowlist the session gets (below). `worker` (default) may run
#               the test runner and the test files; `reviewer` may not -- a reviewer
#               runs no tests, its brief says so, and what it reads is a diff an
#               attacker may have authored in full, so it gets no exec it does not need.
#               `coordinator` is the Dispatch coordinator's pane: it spawns through
#               this script, drives panes with the herdr agent/tab verbs (never `agent
#               start`: that is denied), reads the node inbox, sends dms, reads the
#               coordinator directory and edits only its intake/ and briefs/. Claude only.
#               Its settings file alone also carries the harness: a UserPromptSubmit and
#               a SessionStart hook through appl-hook.sh, the appl-*.sh scripts by exact
#               path, and the Agent tool for the three appl-* subagents.
#   --allow 'Bash(...)'
#               one more allow rule for this session (repeatable): the brief's author
#               widening the list for a task-specific command, so the worker does not
#               stop on it. Bash rules only. A rule a deny entry would beat anyway (it
#               would still stop), or one naming a reader, an interpreter or a network
#               command, is exit 2 with one line and no worker. An accepted rule goes
#               into the settings file verbatim and nowhere else (no argv, no stdout).
#   --env K=V   extra environment for the tab (repeatable). A key the SPAWN sets itself is
#               refused here, by name: CODEX_HOME, CURSOR_CONFIG_DIR, PYTHONNOUSERSITE,
#               CLAUDE_CODE_DISABLE_AUTO_MEMORY, HERD_WORKER, HERD_BRIEF, HERD_REPORT,
#               ISOLATED_SESSION_GUARD_TRACE, and MURETAI_HERDR_AGENT (which has a flag of
#               its own, --muretai-agent, with a name rule this door would skip). The
#               caller's entries are appended AFTER the spawn's on `herdr tab create`, so a
#               duplicate key leaves it to herdr's dedup order which value the tab gets --
#               neither pinned here nor testable, and the two it would decide are the
#               interpreter wall and the config home. MURETAI_BINDING_FILE and
#               ISOLATED_SESSION_OWNER are deliberately NOT on the list: the spawn sets
#               neither, the first names a binding a node child reads, and the second is
#               how a test-author / implementer pair hands its worktree lock over: every
#               lock of the cwd's repository owned by that key passes to THIS worker by
#               name (stderr says which), and the worker's session binds its own process
#               at its first guarded command -- see the pair hand-over in lib.sh.
#   --muretai-agent NAME
#               mark the pane as that Muretai agent's wake target: tab env
#               MURETAI_HERDR_AGENT=NAME, then herdr pane report-metadata with
#               token muretai_agent=NAME (never a DID). Without this flag the
#               spawn is unchanged.
#
# Exit 3, one line on stderr, when herdr is not on PATH or its server is not running
# (HERD_SPAWN_BIN names the binary explicitly; the tests point it at a stub). Exit 2
# on a usage error. On success the one stdout line is
#   worker=<name> pane=<id> tab=<id> report=<path>
#
# HERD_SPAWN_READY_SECS (default 30) is how long `agent start` is retried while the
# pane's shell prints its prompt. HERD_SPAWN_AGENT_READY_SECS (default 120) is how
# long, after start succeeds, to wait for the agent's input line (`herdr agent wait
# --until idle`) and is the caller --timeout on `agent prompt`. The two waits are
# not folded: start succeeding means the process is in the pane, not that a brief
# will be read. A spawn either hands the brief to an agent that took it, or fails.
#
# The agent runs on `opus` (HERD_SPAWN_MODEL overrides it: an alias or a model id) and
# in `auto` permission mode (HERD_SPAWN_PERMISSION_MODE overrides it,
# and only with `auto`, `acceptEdits`, `manual` or `plan`: anything else -- a
# `bypassPermissions`, a `dontAsk`, an empty string -- is exit 2 before herdr is asked
# anything, and the value is not handed down: a worker's own landing spawns the next
# reviewer from the default again unless that worker's environment says otherwise; on the
# codex harness the knob does not apply at all, and a SET value is exit 2 rather than a
# validated word nobody uses -- see the codex block below):
# the classifier answers the routine prompts and stops on the risky ones, which is what
# lets a worker run unattended -- in acceptEdits the first real reviewer stopped on
# every read-only `git config` and `ls` outside the allowlist. The project's PreToolUse
# session guard still refuses the primary and other sessions' worktrees whatever the mode --
# but only on the three harnesses that read it, which are claude, cursor and grok, and NOT on
# codex, which reads neither `.claude/settings.json` nor `.cursor/hooks.json`. The
# allowlist below covers what the briefs ask for and no more: a Bash rule matches the
# command's PREFIX, so `python3` alone would have allowed `python3 -c` anything, and a
# directory prefix (`python3 tools/`) would have run a `tools/evil.py` the reviewed diff
# itself landed -- for a REVIEWER the rules name each script by its exact path, in the
# bare AND the isolated (`python3 -I ...`) spelling the briefs instruct, plus
# `-m agent.plugins`. A WORKER runs the code of its own worktree anyway, so it also has
# `python3 tools/*`, `python3 tests/*` and `env -u * python3 tests/*` (the no-stops plan's
# S2: a worker stopped on every task script), and `test_*.py` in the isolated spelling.
# Both profiles have the glue a worker chains
# after a real command -- echo, printf, pwd, true, test, mkdir -p -- and three read-only
# git verbs (S1: a `cmd && echo "$X"` line stopped at the classifier because `echo` was on
# no list). `cat` is not on it (Read is the tool for a
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
#
# THE CODEX HARNESS IS DIFFERENT IN KIND (HERD_SPAWN_HARNESS=codex), and the difference is
# not a detail to smooth over. Codex has NO per-command allow/deny list: Claude Code's
# `Bash(cmd:*)` and Cursor's `Shell(cmd:args*)` have no spelling there, so the canonical
# lists above are NOT enforced on it. Its wall is the SANDBOX (`-s workspace-write`) plus
# the approval policy (`-a on-request`), and nothing else -- `git push`, `curl`, a read of
# `keys/` are stopped by the sandbox and by whatever a person answers at an approval
# prompt, never by a rule. `danger-full-access` and
# `--dangerously-bypass-approvals-and-sandbox` are never passed. Rather than pretend the
# lists hold, the spawn writes them to `$HERD_DIR/<name>/rules.unenforced.json` with a note
# saying they are not enforced, and prints one line on stdout saying the same, where the
# person spawning the worker reads it. It writes no permissions.json: a rules file the
# harness ignores would read as a wall that is not there. For the same reason a codex
# session REVIEWS NOTHING (a reviewer reads a diff an attacker may have authored in full,
# and the deny list it would need does not exist here) and COORDINATES NOTHING: `worker`
# is the only profile, and the other two are exit 2 before herdr is asked anything.
# And nothing stands beside that wall either: NO session guard runs on a codex worker --
# the isolated-session PreToolUse hook is registered in `.claude/settings.json` and
# `.cursor/hooks.json`, `scripts/session-guard.sh` dispatches claude, cursor and grok only,
# codex-cli reads neither file, and the `config.toml` this spawn writes registers no hook of
# its own (ISSUE(session-guard-has-no-codex-dialect)). So the directory a codex session
# opens in is the whole of its blast radius, and a codex worker is ALWAYS given
# `--cwd <worktree>`: with `-s workspace-write` that directory IS the writable sandbox root
# and `-a on-request` escalates only for writes OUTSIDE it, so every write inside runs with
# no approval at all. A cwd that is a PRIMARY checkout -- which is the default when no
# `--cwd` is passed -- is exit 2 before herdr is asked anything, the way the cursor branch
# refuses the primary for its own narrower reason.
# Codex reads its own `AGENTS.md` and `config.toml` from CODEX_HOME (default `~/.codex`),
# and the user's copies there are writable by any session of this user -- the same hazard
# that keeps a cursor session from reviewing. So the tab is handed a config home the SPAWN
# owns, `CODEX_HOME=$HERD_DIR/<name>/codex-home` (mode 700, refused when it is a symlink or
# another uid's), holding one `config.toml` the spawn wrote exclusively: the model, the
# sandbox mode, the approval policy, nothing else. That home must hold NOTHING the spawn did
# not just write: a non-empty one is exit 2 listing what is in the way, because a planted
# `AGENTS.md` there would BE the worker's instructions, living in no checkout and in no diff.
# It is refused, never emptied, and a spawn that fails later removes the two files it made,
# so the retry is not refused by this spawn's own leftover.
# Only the login crosses over, and as a
# SYMLINK to the user's own `auth.json`: the path is handled, the content never read,
# printed or copied, and a user with no login is told to log in rather than handed a
# session that starts and cannot talk. That path is judged before it is linked -- a REGULAR
# file (`-L` first, then `-f`) owned by the caller (`-O`), under a home that passes
# `iso_private_path` -- because `-e` follows a symlink and accepts a directory or a fifo, and
# what is linked in is what the session is billed to. CODEX_HOME itself is read ONCE, for
# that login, and then `unset` like HERD_SPAWN_HARNESS and HERD_SPAWN_MODEL, so a spawn a
# worker starts does not inherit a home it never chose; a caller `--env CODEX_HOME=` is
# refused where --env is parsed. HERD_SPAWN_PERMISSION_MODE is refused there too: it is a
# claude knob, the codex approval policy is fixed at `-a on-request`, and a validated value
# this branch then discards is the one place this script would read a wall into something
# that is not one. HERD_SPAWN_MODEL is passed as `-m`; unset means the
# account default (measured 2026-09-20 on codex-cli 0.155.1: `gpt-5.1-codex-max` is
# refused for a ChatGPT account, so there is no id to pin here).
#
# Every `python3` below is `-I` (isolated: no user site directory, no PYTHON* variable
# read). Two of them decide what the reviewer is TOLD and what it may RUN -- the render of
# its brief and the write of that permission list -- and a caller used to reach this script
# outside the landing's wall, so a `usercustomize.py` a branch's own test run had planted
# in the operator-writable user site directory rewrote both, from outside any checkout a
# guard here looks at (ISSUE(security-audit-2026-09-18-daily-2026-09-18-7)). The callers
# now run this script through `credless` as well; `-I` is the half that does not depend on
# the caller remembering. `tests/test_gate_pythons_are_isolated.py` checks it mechanically.
# The TAB the spawn creates is a third thing again: see tab_env below.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

usage() {
  echo "usage: herd-spawn.sh <name> <brief-file> [--cwd DIR] [--profile worker|reviewer|coordinator] [--env K=V ...] [--var KEY=VALUE ...] [--allow 'Bash(...)' ...] [--muretai-agent NAME]" >&2
  echo "       HERD_SPAWN_HARNESS=codex requires --cwd <worktree>: a codex session's writable sandbox root IS the directory it opens in, and no session guard runs on that harness" >&2
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
extra_allow=()
muretai_agent=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd) [[ $# -ge 2 ]] || usage; cwd="$2"; shift 2 ;;
    --profile) [[ $# -ge 2 ]] || usage; profile="$2"; shift 2 ;;
    # A key the SPAWN sets on the tab itself is refused here, before herdr is asked
    # anything and before a single directory is made. `tab_env` is assembled spawn-first
    # and the caller's entries are appended AFTER it, so two `CODEX_HOME=` entries leave
    # it to herdr's dedup order which one the tab gets -- an order this repository neither
    # pins nor tests, deciding the interpreter wall (PYTHONNOUSERSITE), the memory switch
    # and the codex config home. The refusal is where --env is PARSED, so it holds for
    # every harness and not only for the one that added the newest key. The printed key is
    # the literal this case matched, never the caller's bytes.
    --env)
      [[ $# -ge 2 ]] || usage
      case "${2%%=*}" in
        CODEX_HOME|CURSOR_CONFIG_DIR|PYTHONNOUSERSITE|CLAUDE_CODE_DISABLE_AUTO_MEMORY|HERD_WORKER|HERD_BRIEF|HERD_REPORT|ISOLATED_SESSION_GUARD_TRACE|MURETAI_HERDR_AGENT)
          echo "herd-spawn: --env ${2%%=*}=... is refused: the spawn sets that key on the tab itself and the caller's entries are appended after its own, so which value the tab got would be herdr's dedup order to decide; the worker ${name} was not started" >&2
          exit 2
          ;;
      esac
      envs+=("$2"); shift 2 ;;
    --var) [[ $# -ge 2 ]] || usage; vars+=("$2"); shift 2 ;;
    --allow) [[ $# -ge 2 ]] || usage; extra_allow+=("$2"); shift 2 ;;
    --muretai-agent) [[ $# -ge 2 ]] || usage; muretai_agent="$2"; shift 2 ;;
    *) echo "herd-spawn: unknown argument: $1" >&2; usage ;;
  esac
done
if [[ -n "$muretai_agent" ]]; then
  case "$muretai_agent" in
    *[!a-z0-9_-]*|[!a-z]*)
      echo "herd-spawn: --muretai-agent is [a-z][a-z0-9_-]* (herdr's agent-name rule): ${muretai_agent}" >&2
      exit 2
      ;;
  esac
  if [[ ${#muretai_agent} -gt 32 ]]; then
    echo "herd-spawn: --muretai-agent is at most 32 characters (herdr's agent-name rule): ${muretai_agent} (${#muretai_agent})" >&2
    exit 2
  fi
fi
case "$profile" in
  worker|reviewer|coordinator) ;;
  *) echo "herd-spawn: --profile is worker, reviewer or coordinator (got '${profile}'); the worker ${name} was not started" >&2; exit 2 ;;
esac

# --- the permission mode: one of four words, checked before herdr is asked anything ----
# Unset means `auto`; set means exactly one of the accepted values (an empty string is
# not "unset", it is a value nobody meant). The validated literal goes on the command
# line and the variable is dropped from this process, so a spawn started by a worker
# (its landing spawns the next reviewer) does not inherit a mode it never chose.
# Whether the caller SET it at all, remembered before the unset below: on codex the knob
# does not apply and any value -- `auto` included -- is a refusal, which is a different
# question from whether the value is one of the four words.
permission_mode_set=""
[[ -z "${HERD_SPAWN_PERMISSION_MODE+set}" ]] || permission_mode_set=yes
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
# The harness: `claude` (Claude Code), `cursor` (Cursor's CLI agent, `cursor-agent`) or
# `codex` (codex-cli), HERD_SPAWN_HARNESS. herdr drives any of them in a pane; the brief,
# the report directory and the receipt tools are the same. Cursor reads its rules from
# `<cwd>/.cursor/cli.json` (written below from the same allow/deny lists) and runs in its
# classifier mode (`--auto-review`); the isolated-session hook speaks its dialect already.
# Another model's eyes on a diff see other things; the cost lands on the other plan.
#
# Codex is different in kind and the top-of-file header says how: no per-command rules,
# so the sandbox and the approval policy are the whole wall, `worker` is the only profile,
# and the config home is the spawn's.
harness="${HERD_SPAWN_HARNESS-claude}"
case "$harness" in
  claude|cursor|codex) ;;
  *)
    echo "herd-spawn: HERD_SPAWN_HARNESS must be claude, cursor or codex (got '${harness}'); the worker ${name} was not started" >&2
    exit 2
    ;;
esac
unset HERD_SPAWN_HARNESS
# ... and now that the harness is known: HERD_SPAWN_PERMISSION_MODE is a CLAUDE knob.
# `permission_mode` is consumed by the claude branch alone; the codex argv is fixed at
# `-a on-request`, so a value accepted above and then dropped would let a caller who
# tightened a risky task believe a wall is on that is off. This landing went to real
# trouble not to do that anywhere else -- it writes `rules.unenforced.json` and prints a
# line on stdout precisely so nobody reads a wall into what is not one -- so the knob is
# refused rather than swallowed. Unset stays the normal path.
if [[ "$harness" == "codex" && -n "$permission_mode_set" ]]; then
  echo "herd-spawn: HERD_SPAWN_PERMISSION_MODE does not apply to the codex harness: its approval policy is fixed at -a on-request and this script passes no other, so a mode set here would be validated and then dropped; unset it, or start the worker on claude; the worker ${name} was not started" >&2
  exit 2
fi
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
# A codex session reviews nothing for a reason of its own: the deny list a reviewer is held
# to has no spelling on this harness at all (its wall is the sandbox and the approval
# policy), and a reviewer reads a diff an attacker may have authored in full. It is the
# PROFILE that is refused here, not the harness -- a codex worker is accepted.
if [[ "$harness" == "codex" && "$profile" == "reviewer" ]]; then
  echo "herd-spawn: the codex harness reviews nothing: it has no per-command deny list (its wall is the sandbox and the approval policy), and a reviewer reads a diff an attacker may have authored in full; the worker ${name} was not started" >&2
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
  # The brackets in that pattern are Cursor's (`gpt-5[effort=high]`), and they are what
  # makes it accept `x[bad` as well. A codex model id carries no brackets, so the codex
  # path refuses any token that has one: the shared pattern stays as it is for cursor, and
  # a typo that would reach codex-cli as a model name stops here instead. One pattern now
  # means two things depending on the harness -- ISSUE(model-pattern-differs-by-harness).
  if [[ "$harness" == "codex" && "$model" == *[][]* ]]; then
    echo "herd-spawn: HERD_SPAWN_MODEL carries a bracket, which is Cursor's override spelling and not part of any codex model id (got '${model}'); the worker ${name} was not started" >&2
    exit 2
  fi
fi
[[ -n "$model" || "$harness" != "claude" ]] || model="opus"
unset HERD_SPAWN_MODEL
# The coordinator's rules are Claude Code's Read/Edit path rules, which have no faithful
# Cursor spelling here (cursor_rule below would pass them through untranslated) and none at
# all on codex, where no per-command rule exists; the coordinator runs on claude.
if [[ "$harness" != "claude" && "$profile" == "coordinator" ]]; then
  echo "herd-spawn: the coordinator profile runs on the claude harness only: its rules are Claude Code's Read/Edit path rules, which the ${harness} harness cannot express; the worker ${name} was not started" >&2
  exit 2
fi

# --- the deny list ------------------------------------------------------------------------
# What the shell may NOT do even when an allow rule would allow it: a deny rule is
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
# Defined here, before herdr is asked anything, because --allow is judged against it.
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
  # ARBITRARY-CODE PYTHON IS DENIED BY SHAPE, NOT BY SPELLING. The four rules above are
  # the BARE dialect only -- `Bash(python3 -c:*)` is the prefix `python3 -c` plus a SPACE
  # and `Bash(python3 -:*)` is `python3 -` plus a space -- so the day `python3 -I` became
  # the house form in all six briefs, `python3 -I -c`, `python3 -Ic`, `python3 -I -` and
  # `python3 -I -m http.server` matched NO rule at all, neither deny nor allow, and fell
  # through to the auto-mode classifier: exactly the wave-through this list exists to stop
  # (ISSUE(security-audit-2026-09-18-daily-2026-09-18-16)). The shape is what matters: any
  # `-c`, any `-m`, any bare `-` argument, whatever flags stand between. `-c` and `-m`
  # consume the rest of a cluster, so a cluster carrying one ENDS in `c` or `m` (`-Ic`,
  # `-IBm`) -- that is what the `-*c` / `-*m` rules read. `python3 -I <path>`, the form the
  # briefs instruct, carries no `c `/`m ` and none of these touch it (pinned both ways by
  # test_herd_spawn.test_deny_by_shape). `Bash(python:*)` already covers every `python `.
  "Bash(python3 -m:*)"
  "Bash(python3 * -c)" "Bash(python3 * -c *)"
  "Bash(python3 * -m)" "Bash(python3 * -m *)"
  "Bash(python3 * -)" "Bash(python3 * - *)"
  "Bash(python3 -*c)" "Bash(python3 -*c *)"
  "Bash(python3 -*m)" "Bash(python3 -*m *)"
  "Bash(perl:*)" "Bash(ruby:*)" "Bash(node:*)" "Bash(php:*)"
  "Bash(bash -*)" "Bash(sh -*)" "Bash(zsh -*)"
  "Bash(cat:*)" "Bash(head:*)" "Bash(tail:*)" "Bash(grep:*)" "Bash(wc:*)"
  "Bash(sed:*)" "Bash(awk:*)" "Bash(od:*)" "Bash(xxd:*)" "Bash(strings:*)" "Bash(dd:*)"
  "Bash(tr:*)" "Bash(nl:*)" "Bash(rev:*)" "Bash(cut:*)" "Bash(fold:*)" "Bash(tee:*)"
  "Bash(less:*)" "Bash(more:*)"
  "Bash(curl:*)" "Bash(wget:*)" "Bash(ssh:*)" "Bash(scp:*)"
)
# The coordinator starts panes only through this script (which writes their rules), so
# the raw verb that would start an agent with any flags it likes is denied to it.
if [[ "$profile" == "coordinator" ]]; then
  deny+=("Bash(herdr agent start:*)")
fi

# --- --allow: judged before herdr is asked anything -------------------------------------
# A rule is refused when allowing it would not stop the stall or would open a door:
#   * it is not `Bash(<body>)` (the one form the brief's author may add);
#   * a deny entry overlaps it -- the literal head of one (the text before its first `*`,
#     `x:*` read as `x *`) is a prefix of the other's, in either direction: a deny that
#     covers it would still stop the worker, and a rule wider than a deny (`git:*` over
#     `git push:*`, `python3:*` over `python3 -c:*`, `*`) allows the rest of that family;
#   * a word of it names a reader, a network command or an interpreter (`env cat:*`
#     runs `cat` wherever the word stands, so every word is checked, whole words only:
#     `make concat` is not `cat`); python3 and the shells count as interpreters when
#     they stand alone or take a dash option, not when they run a named script.
# One line on stderr, exit 2, nothing started or written.
if [[ ${#extra_allow[@]} -gt 0 ]]; then
  python3 -I - "$name" "${#deny[@]}" "${deny[@]}" "${extra_allow[@]}" <<'PY' || exit 2
import re, sys
name, n = sys.argv[1], int(sys.argv[2])
deny, rules = sys.argv[3:3 + n], sys.argv[3 + n:]
NAMED = {
    # readers
    "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "sed", "awk", "gawk", "od",
    "xxd", "hexdump", "strings", "dd", "tr", "nl", "rev", "cut", "fold", "tee", "less",
    "more", "base64", "openssl", "sqlite3",
    # interpreters that run code whatever follows
    "perl", "ruby", "node", "php", "python", "python2", "lua", "osascript", "eval", "exec",
    "xargs",
    # network
    "curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ssh", "scp", "sftp", "ftp",
    "rsync",
}
SHELLS = {"python3", "bash", "sh", "zsh", "dash", "ksh"}


def head(body):
    if body.endswith(":*"):
        body = body[:-2] + " *"
    return body.split("*", 1)[0]


def why(rule):
    m = re.fullmatch(r"Bash\(([^()\x00-\x1f\x7f]*)\)", rule)
    if not m or not m.group(1).strip():
        return "only a Bash(<command>) rule may be added"
    body = m.group(1)
    h = head(body)
    for d in deny:
        dm = re.fullmatch(r"Bash\((.*)\)", d)
        if not dm:
            continue
        dh = head(dm.group(1))
        if h.startswith(dh) or dh.startswith(h):
            return "the deny rule " + d + " overlaps it, so the session would still stop"
    words = [w.strip("*'\"") for w in re.split(r"\s+", body[:-2] if body.endswith(":*") else body)]
    words = [w.rsplit("/", 1)[-1] for w in words if w]
    for i, w in enumerate(words):
        if w in NAMED:
            return "it names `" + w + "`, a reader, interpreter or network command"
        if w in SHELLS and (i + 1 == len(words) or words[i + 1].startswith("-")):
            return "it names `" + w + "` bare or with a dash option, an interpreter"
    return ""


for rule in rules:
    reason = why(rule)
    if reason:
        shown = rule if rule.isprintable() else ascii(rule)
        print("herd-spawn: --allow %s is refused: %s; the worker %s was not started"
              % (shown or "''", reason, name), file=sys.stderr)
        sys.exit(2)
PY
fi

# --- where the tab opens ---------------------------------------------------------------
# Resolved BEFORE herdr is asked anything, because for codex the answer is itself a
# refusal (below) and a refused spawn must leave nothing anywhere -- not a tab, not a
# recorded call, not a directory.
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
# A codex session requires a linked worktree: a .git file and a resolving Git common
# directory. `-C "$cwd" -s workspace-write` makes cwd the writable sandbox root,
# and `-a on-request` escalates only for writes OUTSIDE
# it, so every write inside runs with no approval at all -- and no session guard runs on this
# harness to refuse the primary, another live session's worktree or `keys/`: the hook is
# registered in `.claude/settings.json` and `.cursor/hooks.json`, `session-guard.sh`
# dispatches claude, cursor and grok only, codex-cli reads neither, and the `config.toml`
# this spawn writes registers none. A prompt-injected worker would be one write away from
# `<primary>/.claude/settings.json`, whose `hooks` entries are shell command lines, and none
# of it would appear in a diff. The cursor branch refuses the primary for a narrower reason
# (its rules file is shared by every Cursor session there); this one is the wall itself, so
# it is checked here rather than beside its harness block.
if [[ "$harness" == "codex" ]] && { [[ ! -f "$cwd/.git" ]] || ! iso_primary_of "$cwd" >/dev/null 2>&1; }; then
  echo "herd-spawn: a codex session requires a linked worktree, not a primary checkout or plain directory (${cwd}): its writable sandbox root IS the directory it opens in (-s workspace-write; -a on-request stops only for writes outside that root), and no session guard runs on this harness; pass --cwd <worktree>; the worker ${name} was not started" >&2
  exit 2
fi

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
bfile="$herd_dir/${name}/brief.md"
# A brief.md already there -- a previous spawn of this name, or a plant; -L first, since
# -e follows a symlink -- is a refusal, judged before the brief is even rendered: it is
# never overwritten, never rotated, never prompted. (The render's O_EXCL below is the
# same refusal for one that appears in between.)
if [[ -L "$bfile" || -e "$bfile" ]]; then
  echo "herd-spawn: ${bfile} already exists (a previous spawn of this name, or planted); it is neither overwritten nor rotated -- remove it if the name is yours to re-spawn; the worker ${name} was not started" >&2
  exit 2
fi
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
  if ! why="$(python3 -I - "$cursor_cfg" <<'PY'
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
elif [[ "$harness" == "codex" ]]; then
  # The config home is the SPAWN's. Codex resolves CODEX_HOME (default ~/.codex) and loads
  # AGENTS.md and config.toml from it; the user's copies there are writable by any session
  # of this user, so a worker that read them could be told to ignore its brief by something
  # that appears in no diff. The tab is handed a home under the worker's own directory
  # instead, made the way that directory is (mode 700; a symlink or another uid's is exit 2
  # BEFORE a tab exists, so nothing is ever written through a plant).
  #
  # The login stays the user's, as a SYMLINK: we handle the PATH and never the content --
  # auth.json is not read, printed or copied anywhere. A user who has not logged in is told
  # to, here, rather than getting a pane whose agent cannot talk.
  #
  # CODEX_HOME is read ONCE, here, and then dropped from this process the way
  # HERD_SPAWN_PERMISSION_MODE, HERD_SPAWN_HARNESS and HERD_SPAWN_MODEL are: it was the one
  # knob that survived into a spawn a worker started, and the tab is handed the SPAWN's home
  # below, never this one. The other end of the same door -- a caller `--env CODEX_HOME=`,
  # which herdr's dedup order would have decided -- is refused where --env is parsed.
  user_codex_home="${CODEX_HOME:-${HOME:-}/.codex}"
  unset CODEX_HOME
  user_auth="${user_codex_home}/auth.json"
  # Nothing at or above that home may be writable by others: whoever can write there swaps
  # the login this spawn is about to link in, and the session is then billed to, and visible
  # in, an account that is not the owner's.
  if ! open_dir="$(iso_private_path "$user_codex_home")"; then
    echo "herd-spawn: ${open_dir}, at or above the codex home ${user_codex_home}, is writable by others; whoever can write there can swap the login the worker is handed; the worker ${name} was not started" >&2
    exit 2
  fi
  # ... and the login is a REGULAR file of the caller's, or it is not a login. `-e` was not
  # enough on its own: it FOLLOWS a symlink and it accepts a directory and a fifo, so a
  # CODEX_HOME holding a link to somebody else's auth.json was linked in as the worker's,
  # and a fifo there hangs the pane. -L first, the way own_dir tests -L before -d, so the
  # path is judged and never followed.
  if [[ -L "$user_auth" ]]; then
    echo "herd-spawn: the codex login ${user_auth} is a symlink, not a regular file; this path is linked into the worker's config home as its login, so it is judged and never followed; the worker ${name} was not started" >&2
    exit 2
  fi
  if [[ ! -e "$user_auth" ]]; then
    echo "herd-spawn: no codex login at ${user_auth} -- run 'codex login' first; the worker ${name} was not started" >&2
    exit 2
  fi
  if [[ ! -f "$user_auth" || ! -O "$user_auth" ]]; then
    echo "herd-spawn: the codex login ${user_auth} is not a regular file owned by $(id -un) -- a directory, a fifo or another user's file is refused, since it is what the worker is handed to talk with; the worker ${name} was not started" >&2
    exit 2
  fi
  codex_home="$herd_dir/${name}/codex-home"
  own_dir "$codex_home"
  # own_dir answers -L, -d and -O and no more, and codex loads `AGENTS.md` and `config.toml`
  # from this directory: a file planted here under a predictable worker name -- with no
  # brief.md, so the re-spawn refusal never fires -- would BE the worker's instructions,
  # living in no checkout and in no diff, which `tools/sec_lint.py` never scans and no
  # reviewer opens. So the home must hold NOTHING this spawn just wrote. It is REFUSED and
  # never emptied, the way brief.md is: what is in the way is listed and left where it is,
  # a symlink among it neither followed nor unlinked. The same refusal covers a leftover
  # from a spawn of this name that failed, which is the same state reached with no
  # foresight at all -- and drop_brief below removes what THIS spawn wrote, so a failed
  # spawn never refuses its own retry.
  #
  # The names go through iso_safe_text: the sentence an operator reads immediately before
  # deleting something by hand may not be repainted by the thing it names.
  shopt -s nullglob dotglob
  codex_entries=("$codex_home"/*)
  shopt -u nullglob dotglob
  if [[ ${#codex_entries[@]} -gt 0 ]]; then
    in_the_way=""
    for entry in "${codex_entries[@]}"; do
      in_the_way="${in_the_way}${in_the_way:+, }${entry##*/}"
    done
    in_the_way="$(iso_safe_text "$in_the_way")" ||
      in_the_way="(names withheld: this machine has a python3 that cannot run, so they cannot be spelled safely)"
    echo "herd-spawn: ${codex_home} is not empty -- it holds ${in_the_way}; a codex worker reads its instructions and its config from that directory, so it is refused rather than emptied: remove what is in the way if it is yours to re-spawn; the worker ${name} was not started" >&2
    exit 2
  fi
  # The wall, and the whole of it: the sandbox plus the approval policy. No
  # danger-full-access, no --dangerously-bypass-approvals-and-sandbox, ever.
  agent_args=(-C "$cwd" --add-dir "$herd_dir/${name}")
  [[ -z "$model" ]] || agent_args+=(-m "$model")
  agent_args+=(-s workspace-write -a on-request)
  typed="codex ${agent_args[*]}"
else
  agent_args=(--permission-mode "$permission_mode" --model "$model" --add-dir "$herd_dir/${name}"
              --settings "$perms" --setting-sources project --strict-mcp-config)
  typed="claude ${agent_args[*]}"
fi
if [[ ${#typed} -gt 900 ]]; then
  echo "herd-spawn: the command herdr would type is ${#typed} characters (bound 900; a pty drops typed input past about 1 KB) -- shorten HERD_DIR (${herd_dir}); the worker ${name} was not started" >&2
  exit 2
fi
# ... and the one line the worker is told, under the same bound for the same reason (with
# the default HERD_DIR and a 32-character name it is under 200 characters)
prompt_line="Read ${bfile} and follow it. Your report goes to ${report}."
if [[ ${#prompt_line} -gt 900 ]]; then
  echo "herd-spawn: the prompt herdr would type is ${#prompt_line} characters (bound 900) -- shorten HERD_DIR (${herd_dir}); the worker ${name} was not started" >&2
  exit 2
fi

# --- the brief, filled ----------------------------------------------------------------
# Built-ins first, --var after, so a caller can override NAME/PRIMARY/REPORT on purpose.
# One pass with a dict: a value is substituted, never re-scanned, so a value carrying
# `{{NAME}}` stays literal. A placeholder the TEMPLATE carries and nobody filled stops
# the spawn. The text is rendered once and written twice: the worker's brief.md, and the
# operator's copy under briefs/ (the brief may already BE that path -- a landing renders
# there, then calls this script on it -- so it is read once, before either write).
# brief.md is created O_EXCL and never replaced: one already there (a previous spawn of
# this name, or a plant -- a symlink included, which O_EXCL does not follow) is exit 2
# BEFORE the operator's copy is touched. The copy is written the way the rules file is:
# the exact path unlinked (a symlink goes, its target stays), then created O_EXCL.
python3 -I - "$brief_abs" "$rendered" "$bfile" "NAME=${name}" "PRIMARY=${cwd}" "REPORT=${report}" \
  ${vars[@]+"${vars[@]}"} <<'PY' || exit $?
import os, re, sys
src, dst, bfile = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(src, encoding="utf-8").read()
values = {}
for kv in sys.argv[4:]:
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
out = out.rstrip("\n") + "\n"


def refuse_existing():
    print("herd-spawn: " + bfile + " already exists (a previous spawn of this name, or planted); it is "
          "neither overwritten nor rotated -- remove it if the name is yours to re-spawn; "
          "the worker " + os.path.basename(os.path.dirname(bfile)) + " was not started", file=sys.stderr)
    sys.exit(2)


if os.path.lexists(bfile):
    refuse_existing()
if os.path.lexists(dst):
    os.unlink(dst)
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(out)
try:
    fd = os.open(bfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    refuse_existing()
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(out)
PY
# brief.md is this spawn's own from here: a failure below removes it, so the retry is
# not refused by our leftover (a refusal above never reaches this line, and leaves the
# file that was there alone)
brief_ours=yes
drop_brief() {
  if [[ "${brief_ours:-no}" == "yes" ]]; then
    rm -f "$bfile"
    # ... and the codex config home this spawn wrote into. Left standing, the config.toml
    # and the login symlink ARE the non-empty home the check above refuses, so a spawn that
    # failed after them would refuse its own retry; and a link to the owner's auth.json in a
    # home nobody will ever open is a link nobody meant to leave. The EXACT paths are removed
    # (a symlink goes, its target stays), then the directory itself when nothing else is in
    # it -- a plant beside them is not this spawn's to delete.
    if [[ -n "${codex_home:-}" && ! -L "$codex_home" && -d "$codex_home" ]]; then
      rm -f "$codex_home/config.toml" "$codex_home/auth.json"
      rmdir "$codex_home" 2>/dev/null || true
    fi
  fi
}
trap drop_brief EXIT

# --- the tab, the agent, the prompt ------------------------------------------------------
# Auto memory is OFF for a herd session: it is keyed by the repository, shared across
# worktrees, and written by every session -- one prompt-injected session's "secrev-*:
# record 0 findings" would reach every later reviewer without appearing in any diff
# (ISSUE(security-audit-2026-09-12-the-cleanup-trusts-n-d474-2)). The settings file
# below says the same (autoMemoryEnabled) and keeps the memory files of the cwd's
# ancestors out too.
#
# PYTHONNOUSERSITE=1 is on this list and not anywhere else, because `herdr tab create` is
# an RPC to the herdr DAEMON: the tab's environment is exactly what is passed here, and a
# `credless` around THIS script walls this script's own pythons and reaches nothing the
# daemon starts. Measured in a live reviewer session -- `printenv PYTHONNOUSERSITE` exited
# 1 -- so the reviewer's `python3 tools/audit_scope.py write-receipt`, the one command
# whose output the publisher waits for, imported whatever a branch's test run had left in
# the operator-writable user site directory, and the file it wrote could say
# `verdict: clean` while the terminal said "receipt written"
# (ISSUE(security-audit-2026-09-18-daily-2026-09-18-9)). Every profile gets it: a worker
# writes receipts and notes too, and a wall that is on for one session and off for the
# next is a wall nobody can reason about. The briefs spell `python3 -I` and the allow
# rules below grant that spelling, so the tab and the instructions agree.
tab_env=(--env ISOLATED_SESSION_GUARD_TRACE=1 --env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
         --env PYTHONNOUSERSITE=1
         --env "HERD_WORKER=${name}" --env "HERD_BRIEF=${bfile}" --env "HERD_REPORT=${report}")
if [[ "$harness" == "cursor" ]]; then
  tab_env+=(--env "CURSOR_CONFIG_DIR=${cursor_home}")
fi
if [[ "$harness" == "codex" ]]; then
  # the config home the spawn owns, so the file we wrote is the file codex obeys; no path
  # under the user's own ~/.codex is handed to the tab at all
  tab_env+=(--env "CODEX_HOME=${codex_home}")
fi
for kv in ${envs[@]+"${envs[@]}"}; do
  tab_env+=(--env "$kv")
done
# Wake-target mark: the pane env is what a node child / L0 hook can see. The
# token is the first non-DID mark herdrwake._select recognises. Never a DID.
if [[ -n "$muretai_agent" ]]; then
  tab_env+=(--env "MURETAI_HERDR_AGENT=${muretai_agent}")
fi
tab_json="$("$herdr" tab create --cwd "$cwd" --label "$name" --no-focus "${tab_env[@]}")" || {
  echo "herd-spawn: 'herdr tab create' failed for ${name}" >&2
  exit 1
}
ids="$(printf '%s\n' "$tab_json" | python3 -I -c '
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
if [[ -n "$muretai_agent" ]]; then
  # Pane id is known only after tab create. Token only -- never muretai_did
  # (a spawn must not write a DID onto argv or into the brief).
  "$herdr" pane report-metadata "$pane" --source muretai \
      --token "muretai_agent=${muretai_agent}" >/dev/null || {
    echo "herd-spawn: 'herdr pane report-metadata' failed for ${name} (pane ${pane})" >&2
    exit 1
  }
fi

if [[ "$profile" == "coordinator" ]]; then
  # Exactly this list, nothing shared with the others: spawn (both spellings, the second
  # through the primary of the repository this script lives in), drive panes, read the
  # node inbox, dm, read the coordinator directory, write only its intake/ and briefs/.
  # No git, no echo, no tools/tests: a coordinator that needs more briefs a worker.
  spawner_rel=".cursor/skills/isolated-session/scripts/herd-spawn.sh"
  coord_dir="${herd_dir%/}/coordinator"
  allow=("Bash(bash ${spawner_rel}:*)")
  if spawner_primary="$(iso_primary_of "$here")"; then
    allow+=("Bash(bash ${spawner_primary}/${spawner_rel}:*)")
  fi
  allow+=(
    "Bash(herdr agent prompt:*)" "Bash(herdr agent read:*)" "Bash(herdr agent wait:*)"
    "Bash(herdr agent list:*)" "Bash(herdr agent send-keys:*)"
    "Bash(herdr tab list:*)" "Bash(herdr tab close:*)"
    "Bash(python3 operator_cli.py --as * inbox*)" "Bash(python3 operator_cli.py --as * dm *)"
    "Read(//${coord_dir#/}/**)"
    "Edit(//${coord_dir#/}/intake/**)" "Edit(//${coord_dir#/}/briefs/**)"
  )
  # The coordinator harness (plan 2026-09-19): the pane's deterministic steps, each script
  # by its exact path (both spellings, like the spawner: never a directory or an `appl-*`
  # glob, which would run whatever a diff drops beside them), and the Agent tool for its
  # three small-model subagents only. appl-hook.sh is not here: the hook runs it, the
  # model never needs to.
  for s in appl-verify.sh appl-status.sh appl-hydrate.sh appl-role-of.sh appl-close.sh; do
    allow+=("Bash(bash .cursor/skills/isolated-session/scripts/${s}:*)")
    if [[ -n "${spawner_primary:-}" ]]; then
      allow+=("Bash(bash ${spawner_primary}/.cursor/skills/isolated-session/scripts/${s}:*)")
    fi
  done
  allow+=("Agent(appl-brief-writer)" "Agent(appl-report-reader)" "Agent(appl-prompt-triage)")
else
allow=(
  "Bash(python3 tools/audit_scope.py:*)"
  "Bash(python3 tools/ledger.py:*)"
  "Bash(python3 tools/sec_lint.py:*)"
  "Bash(python3 tools/affected_tests.py:*)"
  "Bash(python3 tools/spec_build.py:*)"
  # SHADOWED since the deny list refuses `-m` by shape (see the deny block below): a deny
  # beats any allow, so this rule grants nothing any more and a session that needs
  # `agent.plugins check` asks a person for it. It is left standing, and named here, so
  # the next reader learns the rule was withdrawn rather than never written -- the plugin
  # check a session actually reads is the one tools/security_weekly.sh already ran.
  "Bash(python3 -m agent.plugins:*)"
)
if [[ "$profile" == "worker" ]]; then
  allow+=("Bash(python3 tools/run_tests.py:*)" "Bash(python3 tests/test_:*)")
  # the no-stops plan's S2: the task scripts and tests of the worker's own worktree, also
  # behind `env -u X` (no-space `*`: `tools/*` is any path under tools/). The env form
  # starts `env -u `: a bare `env *python3 tests/*` also matched
  # `env python3 -c '<code>' python3 tests/x`, which no deny prefix reaches
  allow+=("Bash(python3 tools/*)" "Bash(python3 tests/*)" "Bash(env -u * python3 tests/*)")
  # the test files in the isolated spelling. This one is the NO-SPACE wildcard and not a
  # `:*` prefix: `Bash(x:*)` is the prefix AND a space, and the argument here ends in a
  # NAME prefix (`tests/test_`) that the file name continues without one -- the same
  # reason cursor_rule() re-spells a trailing `_` as `<prefix>*`
  allow+=("Bash(python3 -I tools/run_tests.py:*)" "Bash(python3 -I tests/test_*)")
  # Dispatch finish verbs the ticket brief names: coord deliver, a Room dm
  # (deliverable, /remember, or failed), and stance full via dispatch-capacity.
  # A bare operator_cli.py prefix would let a ticket drive wake set/test.
  allow+=("Bash(python3 operator_cli.py --as * coord * deliver *)")
  allow+=("Bash(python3 operator_cli.py --as * dm *)")
  allow+=("Bash(python3 -I operator_cli.py --as * coord * deliver *)")
  allow+=("Bash(python3 -I operator_cli.py --as * dm *)")
  allow+=("Bash(bash .cursor/skills/isolated-session/scripts/dispatch-capacity.sh:*)")
fi
# The SAME commands in the isolated spelling. The tab above carries PYTHONNOUSERSITE=1 and
# every brief instructs `python3 -I`, so a list that granted only the bare spelling would
# stop the worker at a permission prompt on its own instructions -- and a session that has
# to ask a person for each of its own commands is a session that runs nothing unattended.
# `-I` is per-process and grants nothing: it REMOVES the user site directory and the
# PYTHON* variables from that one interpreter. The deny list beats every one of these, and
# since the shape rules below it does so in the ISOLATED dialect too: `python3 -I -c`,
# `python3 -Ic`, `python3 -I -` and `python3 -I -m ...` are refused, while `python3 -I
# <path>` -- what each rule here names -- is not.
allow+=(
  "Bash(python3 -I tools/audit_scope.py:*)"
  "Bash(python3 -I tools/ledger.py:*)"
  "Bash(python3 -I tools/sec_lint.py:*)"
  "Bash(python3 -I tools/affected_tests.py:*)"
  "Bash(python3 -I tools/spec_build.py:*)"
  # `-m agent.plugins` is deliberately NOT here: `-I` takes the caller's directory off
  # sys.path and the module would not be found, so the isolated spelling of that one is a
  # broken command, and a rule granting it would teach it. The tab's PYTHONNOUSERSITE=1
  # walls it either way.
)
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
  # the no-stops plan's S1: the glue chained after a real command, and read-only git
  # (`git branch` only in its reading forms: `git branch -f/-D main` would move or
  # delete the shared trunk ref from a worktree)
  "Bash(echo:*)" "Bash(printf:*)" "Bash(pwd)" "Bash(true)" "Bash(test:*)" "Bash(mkdir -p:*)"
  "Bash(git branch --list:*)" "Bash(git branch --show-current)"
  "Bash(git merge-base:*)" "Bash(git rev-list:*)"
)
fi
# the brief's own --allow rules (judged above), after the profile's
allow+=(${extra_allow[@]+"${extra_allow[@]}"})
# `git ls-files` reads tracked content only (never keys/, which is not tracked).
# `git grep -O` / `--open-files-in-pager` runs a program, and `git blame --contents`
# reads any file the uid can read, so those two are not on the allowlist: a session
# navigates with its own search and Read tools, and a `git grep` stops at a prompt
# (the coordinator answers -- that is the intended cost). Measured 2026-09-13: a
# Cursor session in allowlist mode stops at "Waiting for approval" on an unlisted
# git subcommand, and "add to allowlist" writes the USER config, which the spawner
# then refuses for every later spawn.
# (The deny list is defined above, before herdr is asked anything: --allow is judged
# against it.)
# The rules travel as a settings file, not as argv (the typed-line bound above). The
# file is the worker's own, under its report directory, and it is written exclusively:
# `rm -f` the exact path (a planted symlink is removed, never followed; the file a
# previous spawn of the same name left is removed too), then O_CREAT|O_EXCL mode 600 --
# a path that exists again by then is a refusal, and claude is never started on a file
# this spawn did not create.
#
# On codex the SAME lists are written, to rules.unenforced.json and with a note, because
# nothing there enforces them (see the header). That file is not a settings file: no codex
# argv names it, and no permissions.json is written, so nobody reads a wall into a file the
# harness ignores.
rules_out="$perms"
if [[ "$harness" == "codex" ]]; then
  rules_out="$herd_dir/${name}/rules.unenforced.json"
fi
rm -f "$rules_out"
HS_CWD="$cwd" HS_HERD="$herd_dir" HS_HARNESS="$harness" HS_NAME="$name" HS_PRIMARY="$(iso_primary_of "$cwd" 2>/dev/null || true)" \
  HS_CODEX_HOME="${codex_home:-}" HS_CODEX_AUTH="${user_auth:-}" HS_MODEL="$model" HS_PROFILE="$profile" \
  python3 -I - "$rules_out" "${#allow[@]}" "${allow[@]}" "${deny[@]}" <<'PY' || exit 2
import json, os, shlex, sys
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
UNENFORCED_NOTE = (
    "These lists are not enforced. They are the allow and deny rules a claude worker of "
    "this profile would be held to; the codex harness has no per-command rule of any kind, "
    "so nothing here is applied. The wall is the sandbox (workspace-write) and the approval "
    "policy (on-request). They are written down so what the worker was meant to be held to "
    "is on the record -- not so anyone can point at a file and call it a wall."
)
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except OSError as e:
    print("herd-spawn: could not create the rules file exclusively at " + path + ": " + e.strerror
          + "; the worker was not started", file=sys.stderr)
    sys.exit(2)
settings = {"permissions": {"allow": rest[:n], "deny": rest[n:] + extra_deny},
            "autoMemoryEnabled": False,
            "claudeMdExcludes": excludes}
if os.environ.get("HS_PROFILE") == "coordinator":
    # The coordinator harness (plan 2026-09-19, B): the pane's prompts go through
    # appl-hook.sh first, which blocks the mechanical ones and hands the rest over with
    # the verdict. In THIS file only, so no worker or reviewer ever carries it. The tab is
    # not handed HERD_DIR, so the command carries this spawn's own; the script is found
    # from whichever checkout the pane runs in ($CLAUDE_PROJECT_DIR, else the cwd), never
    # by the primary's absolute path. A REPORT runs the named tests, hence the long
    # timeout. No model is named here: HERD_SPAWN_MODEL alone picks the pane's.
    hook = ('HERD_DIR=' + shlex.quote(herd) + ' bash "${CLAUDE_PROJECT_DIR:-.}"'
            '/.cursor/skills/isolated-session/scripts/appl-hook.sh ')
    settings["hooks"] = {
        "UserPromptSubmit": [{"hooks": [{"type": "command", "command": hook + "UserPromptSubmit",
                                         "timeout": 3600}]}],
        "SessionStart": [{"matcher": "startup|resume|compact|clear",
                          "hooks": [{"type": "command", "command": hook + "SessionStart", "timeout": 60}]}],
    }
with os.fdopen(fd, "w", encoding="utf-8") as f:
    if os.environ.get("HS_HARNESS") == "codex":
        json.dump({"note": UNENFORCED_NOTE,
                   "allow": rest[:n], "deny": rest[n:] + extra_deny},
                  f, indent=1)
    else:
        # claudeMdExcludes: a second layer under the ancestor check for the shared
        # temporary directories, and the only layer for the owner's own directories above;
        # `settings` also carries the coordinator's hooks when HS_PROFILE is coordinator.
        json.dump(settings, f, indent=1)
    f.write("\n")


if os.environ.get("HS_HARNESS") == "codex":
    # The config home the tab is handed: one flat config.toml carrying the model, the
    # sandbox mode and the approval policy, and nothing else -- written the way the rules
    # file is (the EXACT path unlinked first, so a planted symlink goes and its target is
    # never written through, then O_EXCL mode 600). No section, no bypass spelling, and
    # nothing of the user's own config.toml or AGENTS.md, which are not loaded at all.
    codex_home = os.environ["HS_CODEX_HOME"]
    cfg = os.path.join(codex_home, "config.toml")
    lines = []
    if os.environ.get("HS_MODEL"):
        lines.append('model = "' + os.environ["HS_MODEL"] + '"')
    lines.append('sandbox_mode = "workspace-write"')
    lines.append('approval_policy = "on-request"')
    if os.path.lexists(cfg):
        os.unlink(cfg)
    fd = os.open(cfg, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    # The login is the user's and stays there: a symlink by PATH. The file is never
    # opened, so no token reaches this process, an argv, a log line or a copy on disk.
    auth = os.path.join(codex_home, "auth.json")
    if os.path.lexists(auth):
        os.unlink(auth)
    os.symlink(os.environ["HS_CODEX_AUTH"], auth)


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
# HERD_SPAWN_AGENT_READY_SECS (below) is a different wait: after start succeeds.
# A failed start is not always a slow shell: a harness stuck on one of Claude Code's
# FIRST-RUN prompts (the renderer choice, the auto-mode setup, folder trust, "Not logged
# in") is already registered, so a retry only earns herdr's agent_name_taken (Mac B,
# 2026-09-17). After a failure that is not the slow shell, the pane is read once and matched on keywords; a match
# is NAMED from the fixed vocabulary below -- the pane's bytes never reach stderr, they
# are data another checkout may have written -- and the spawn stops without a second
# start. The tab stays open: the owner answers the prompt in it. The keywords are guesses
# at the real screens (ISSUE(first-run-prompt-texts-are-guesses)).
first_run_prompt() {
  local screen
  screen="$("$herdr" agent read "$name" --source recent-unwrapped --lines 80 2>/dev/null \
            || "$herdr" agent read "$name" 2>/dev/null || true)"
  [[ -n "$screen" ]] || return 1
  printf '%s' "$screen" | python3 -I -c '
import re, sys
text = sys.stdin.buffer.read().decode("utf-8", "replace")
# drop OSC strings (a title) whole, then CSI/other escapes, then the remaining controls
text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?", "", text)
text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text)
text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", " ", text).lower()
for word, pat in (("login", r"not logged in|please run /login"),
                  ("trust", r"\btrust\b[^\n]*\b(folder|files|workspace|directory|project)\b"),
                  ("auto-mode", r"\bauto[- ]mode\b"),
                  ("renderer", r"\brenderer\b")):
    if re.search(pat, text):
        print(word)
        sys.exit(0)
sys.exit(1)
'
}
start_err="$(mktemp "${TMPDIR:-/tmp}/herd-spawn-start.XXXXXX")"
started=no
stuck_on=""
deadline=$(( $(date +%s) + ${HERD_SPAWN_READY_SECS:-30} ))
while :; do
  if "$herdr" agent start "$name" --kind "$harness" --pane "$pane" --timeout 120000 -- \
       "${agent_args[@]}" >/dev/null 2>"$start_err"; then
    started=yes
    break
  fi
  # a pane not yet at a shell prompt never had the harness typed into it, so it cannot
  # show a first-run prompt: that is the old slow-shell case, retried without a read
  if ! grep -q 'not at an interactive shell prompt' "$start_err" 2>/dev/null \
       && stuck_on="$(first_run_prompt)"; then
    break
  fi
  stuck_on=""
  [[ $(date +%s) -lt $deadline ]] || break
  sleep 2
done
if [[ -n "$stuck_on" ]]; then
  rm -f "$start_err"
  case "$stuck_on" in
    login)     what="\"Not logged in\"; run 'claude auth login' (once per machine)" ;;
    trust)     what="the folder-trust question; answer it in the pane" ;;
    auto-mode) what="the auto-mode setup prompt; answer it in the pane" ;;
    *)         what="the renderer choice; answer it in the pane" ;;
  esac
  echo "herd-spawn: ${name} is stuck on Claude Code's first-run prompt: ${what}. The tab is left open (pane ${pane}, tab ${tab_id}); close it afterwards and spawn ${name} again. Not retried: the agent is already registered" >&2
  exit 1
fi
if [[ "$started" != "yes" ]]; then
  echo "herd-spawn: 'herdr agent start' failed for ${name} (pane ${pane}, tab ${tab_id}): $(tail -1 "$start_err" 2>/dev/null)" >&2
  rm -f "$start_err"
  exit 1
fi
rm -f "$start_err"

# Start succeeding means the harness process is in the pane, not that its input
# line takes text (daily-2026-09-16 typed into a banner; shop-door-hardening-tests
# at 23:50 sat unsent). One wait for idle, then prompt with --wait until working
# or blocked so the spawn returns when the brief is taken, not when the turn ends.
agent_ready_secs="${HERD_SPAWN_AGENT_READY_SECS:-120}"
ready_ms=$(( agent_ready_secs * 1000 ))
wait_err="$(mktemp "${TMPDIR:-/tmp}/herd-spawn-wait.XXXXXX")"
if ! "$herdr" agent wait "$name" --until idle --timeout "$ready_ms" >/dev/null 2>"$wait_err"; then
  echo "herd-spawn: 'herdr agent wait' failed for ${name} (pane ${pane}, tab ${tab_id}): $(tail -1 "$wait_err" 2>/dev/null)" >&2
  rm -f "$wait_err"
  exit 1
fi
rm -f "$wait_err"

# The pair hand-over (ISSUE(pair-worktree-lock-dies-with-the-test-author-session)): a worker
# started with `--env ISOLATED_SESSION_OWNER=<key>` takes over every worktree lock of THIS
# repository (the cwd's) whose owner is that key -- the test author's -- recorded as handed
# to this worker by name; the worker's session binds its own process at its first guarded
# command (lib.sh, iso_lock_handover / iso_lock_bind). Here, after the agent is up and
# before it is told anything, so it never meets the author's lock, and a spawn that failed
# earlier hands nothing to a worker that does not exist. A spawn without the key, or with a
# key no lock carries, changes nothing.
pair_key=""
for kv in ${envs[@]+"${envs[@]}"}; do
  if [[ "${kv%%=*}" == "ISOLATED_SESSION_OWNER" ]]; then pair_key="${kv#*=}"; fi
done
if [[ -n "$pair_key" ]]; then
  while IFS= read -r handed; do
    [[ -n "$handed" ]] || continue
    echo "herd-spawn: the hold on $(iso_safe_text "$handed" || echo '(a worktree)') passes to ${name} (owner key $(iso_safe_text "$pair_key" || echo '?'))" >&2
  done < <(iso_lock_handover "$cwd" "$pair_key" "$name" 2>/dev/null || true)
fi

# Flags after TEXT (herdr: agent prompt <TARGET> <TEXT> [OPTIONS]). Only
# agent_prompt_stalled is retried, two seconds apart, until AGENT_READY_SECS
# from the first attempt. Any other failure (agent_blocked, timeout, ...) is not.
prompt_err="$(mktemp "${TMPDIR:-/tmp}/herd-spawn-prompt.XXXXXX")"
prompted=no
prompt_deadline=$(( $(date +%s) + agent_ready_secs ))
while :; do
  if "$herdr" agent prompt "$name" "$prompt_line" \
       --wait --until working --until blocked --timeout "$ready_ms" \
       >/dev/null 2>"$prompt_err"; then
    prompted=yes
    break
  fi
  prompt_reason="$(tail -1 "$prompt_err" 2>/dev/null)"
  if [[ "$prompt_reason" != "agent_prompt_stalled" ]]; then
    echo "herd-spawn: 'herdr agent prompt' failed for ${name} (pane ${pane}, tab ${tab_id}): ${prompt_reason}" >&2
    rm -f "$prompt_err"
    exit 1
  fi
  [[ $(date +%s) -lt $prompt_deadline ]] || break
  sleep 2
done
if [[ "$prompted" != "yes" ]]; then
  echo "herd-spawn: 'herdr agent prompt' failed for ${name} (pane ${pane}, tab ${tab_id}): $(tail -1 "$prompt_err" 2>/dev/null)" >&2
  rm -f "$prompt_err"
  exit 1
fi
rm -f "$prompt_err"
brief_ours=no          # the worker has been told to read it: it stays
# The honest half, said out loud where the person spawning the worker reads it: on codex
# the allow/deny lists this script computed are recorded, not applied. A file nobody opens
# would let the claude wall be assumed for a session that does not have it. The second line
# is the OTHER half of the same truth, and it was missing while the header claimed the
# opposite: no session guard runs here either, so the worktree named by --cwd is the whole
# of this session's blast radius.
if [[ "$harness" == "codex" ]]; then
  echo "codex: the allow/deny lists are not enforced on this harness; the wall is the sandbox (workspace-write) and approval (on-request)"
  echo "codex: and no session guard runs on it -- the isolated-session hook is registered for claude, cursor and grok only, and codex-cli reads neither .claude/settings.json nor .cursor/hooks.json; the worktree this worker opened in is the whole of its blast radius"
fi
# the harness and the model are on the line, so a landing's REVIEW= and its note can say
# which eyes read the diff
echo "worker=${name} pane=${pane} tab=${tab_id} report=${report} harness=${harness} model=${model:-default}"
