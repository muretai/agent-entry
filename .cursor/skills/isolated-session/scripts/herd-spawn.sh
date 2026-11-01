#!/usr/bin/env bash
# Start one worker session through herdr: a tab in a checkout, an interactive agent
# in it (its own process, so the session guard sees it as its own session), and a
# brief as its first prompt.
#
#   herd-spawn.sh <name> <brief-file> [--cwd DIR] [--profile worker|reviewer|weekly|coordinator|release]
#                 [--env K=V ...] [--var KEY=VALUE ...] [--allow 'Bash(...)' ...]
#                 [--muretai-agent NAME] [--role solo] [--p0] [--lane fast]
#                 [--open-worktree TITLE [--repo PRIMARY] [--base REV (reviewer)]]
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
#               {{NAME}}, {{PRIMARY}} (the cwd), {{REPORT}} and {{SCRIPTS}} (the
#               skill scripts dir, by bin/appl's shared resolver) are filled for you,
#               in one pass (a value is never re-scanned for a later key), and a
#               placeholder the template carries that nobody filled stops the spawn
#               (exit 2) rather than reaching a worker as literal braces. The filled
#               brief is written to $HERD_DIR/<name>/brief.md, mode 600, BEFORE herdr
#               is asked to create a tab, start an agent or type anything, and to the
#               operator's copy $HERD_DIR/briefs/<name>.md. A REGULAR brief.md already
#               there (a previous spawn of the same name, or a plant) is REWRITTEN with
#               this render: the exact path is unlinked, then created O_EXCL, the way
#               permissions.json is -- a re-used name gets its new brief, never the old
#               one and never none. A symlink or a directory at that path is still
#               exit 2, judged before anything is written; so is a symlinked worker
#               directory or briefs/. (This reverses the earlier "exit 2, never
#               overwritten or rotated" rule: ISSUE(herd-spawn-writes-the-brief-outside-
#               the-worker-directory).) The worker is TOLD one
#               short line: `Read <brief.md> and follow it. Your report goes to
#               <report.md>.` and, for claude and cursor, `Open the brief with your
#               Read tool, not with a shell command.` (codex: `Open the brief in one
#               command of its own, chained to no other.`). A pty drops typed input past about 1 KB and a stalled
#               prompt is re-typed, so a brief typed into the pane arrived cut short
#               (ISSUE(herd-spawn-stall-recovery-truncates-brief)); the body never
#               travels on any herdr argv.
#               A spawn that fails after writing brief.md exits non-zero, prints no
#               worker= line, and says on ONE stderr line which steps completed (the
#               tab and pane, whether the agent started) and that the brief was not
#               delivered. It removes brief.md only when nothing was typed into the
#               pane (a tab, start or wait failure); when `agent
#               prompt` itself failed -- a stall past the deadline, a timeout, a
#               refusal -- the line may already be in the pane, so brief.md is KEPT and
#               the message says so: a worker that did get the line finds its brief.
#               A spawn STOPPED AT A FIRST-RUN PROMPT (folder trust, the renderer, the
#               auto-mode setup, "Not logged in") keeps brief.md, .roles/<name> and
#               .repos/<name>, writes $HERD_DIR/.resume/<name> (the pane, tab, cwd,
#               harness, model, wall and owner key), prints nothing on stdout and ONE
#               `herd-spawn.sh --resume <name>` on stderr. Two workers found no brief
#               after an owner answered the trust dialog and re-sent the spawn line.
#
#   herd-spawn.sh --resume <name>
#               finish that spawn once its prompt is answered: same HERD_DIR and herdr,
#               no brief argument. It types the spawn's own line (`Read <the same brief.md>
#               and follow it. ...`, the record's harness's wording) into
#               the agent herdr already has (never a second `agent start`), after the pair
#               hand-over, prints the one worker= line and removes the resume record; the
#               three files stay as they are. A pane still on its prompt is exit 1 with
#               nothing typed; a bad name, no resume record, or a brief.md that is not a
#               regular file of the caller's (a symlink) is exit 2.
#
#   herd-spawn.sh --render <name> <brief-file> [the flags above]
#               the files a spawn of the same arguments writes, without a pane: the
#               rendered $HERD_DIR/<name>/brief.md (and briefs/<name>.md),
#               permissions.json (or the harness's own rules file), and
#               $HERD_DIR/walls/<name>/ with its profile and run.json. It prints ONE line,
#               the harness command line the spawn would have herdr start, and exits 0.
#               It is the spawn's own code, run with herdr left out: herdr is never
#               found or asked anything (so it need not be installed or up), no tab is
#               made, no agent started, nothing typed. It holds no worker state: no
#               worktree is opened or handed over (--open-worktree is refused), no owner
#               key is judged against live workers, and no .roles, .repos, .keys or
#               .resume record is written or removed. The wall profile carries no
#               deny-connect line for herdr's socket, which only herdr can name. Every
#               refusal of a spawn that herdr plays no part in is a refusal here, with
#               the same line and exit: a missing brief, a --cwd that is missing or in
#               no repository, a bad flag or knob.
#               A template that is missing, a directory or unreadable is exit 2 before any
#               record is written and before a tab.
#   --cwd DIR   where the tab opens; default: the primary checkout of the repository
#               this script lives in. A worker opens its own worktree from there.
#               A WALLED worker's landing gate binds to the branch this directory has
#               checked out at spawn, so on the primary (the base branch) it records no
#               gate and says `gate=none (cwd is the primary on <base>)` on stderr and in
#               wall.log; an IMPLEMENTER brief (implementer.md, by its first line) or a
#               SOLO worker brief (worker.md, by its first line) walled there is exit 2
#               before a tab -- pass --cwd <WORKTREE>, or --open-worktree for a solo worker
#               (ISSUE(solo-workers-spawned-on-the-primary-cannot-land)). A Dispatch ticket
#               (dispatch-ticket.md) there still starts, with gate=none: dispatch-take.sh
#               now spawns it in the ticket's worktree, and this is the fallback for an
#               older dispatch-take (or a by-hand spawn) that did not.
#               REQUIRED in practice for HERD_SPAWN_HARNESS=codex: a codex session's
#               writable sandbox root IS this directory, and no session guard runs on
#               that harness, so a primary checkout here is exit 2 before herdr is asked
#               anything -- name the worktree instead.
#               REQUIRED for HERD_SPAWN_HARNESS=grok as well: grok reads its instruction
#               files from the directory it opens, so a primary checkout here is exit 2
#               naming the fix -- pass --cwd <worktree>.
#               A cursor test author is opened here instead of refused. When the worker
#               profile's harness is cursor (the machine file's first entry, unless
#               HERD_SPAWN_HARNESS names another) and the brief is test-author.md with no
#               --cwd, the spawn opens the pair's worktree on the --open-worktree path
#               and starts the author in it. The title is --var TITLE=, or the brief's
#               step-2 ensure-worktree.sh "<title>" line, passed as one argument and never
#               evaluated. No key, or a worktree another key holds, is the same refusal
#               --open-worktree gives (exit 2, nothing started). Claude-first, and
#               HERD_SPAWN_HARNESS=claude, leave the author on the primary to open its
#               own worktree. The template's five-step block is not edited; the rendered
#               brief says the worktree is already open and to skip ensure-worktree.sh.
#   --profile   which allowlist the session gets (below). `worker` (default) may run
#               the test runner and the test files; `reviewer` may not -- a reviewer
#               runs no tests, its brief says so, and what it reads is a diff an
#               attacker may have authored in full, so it gets no exec it does not need.
#               `coordinator` is the Dispatch coordinator's pane: it spawns through
#               this script, drives panes with the herdr agent/tab verbs (never `agent
#               start`: that is denied), reads the node inbox, sends dms, reads the
#               coordinator directory and edits only its intake/ and briefs/. The seat is
#               not a harness name: the spawn must write this pane's allow and deny into
#               a file that harness loads alone, and register appl-hook.sh on that pane
#               alone. Claude does both in $HERD_DIR/<name>/permissions.json. Cursor does
#               both in a mode-700 directory under $HERD_DIR/<name>/, handed to that pane
#               as CURSOR_CONFIG_DIR, never ~/.cursor and never <cwd>/.cursor/cli.json.
#               A slot that is a symlink, or that would make the pane read a shared file,
#               is still exit 2, one line naming appl-hook and cli.json, before a tab
#               exists. cursor-agent still reads ~/.cursor/rules and ~/.agents/skills
#               (there is no switch to leave them out); that is said on stderr and in
#               wall.log, not papered over. Codex and grok cannot, and each is exit 2
#               naming what is missing, before herdr is asked.
#               Its settings file alone also carries the harness: a UserPromptSubmit and
#               a SessionStart hook through appl-hook.sh, a PostToolUse hook for the Agent
#               tool only (appl-hook.sh records a helper's id at its launch), the
#               appl-*.sh scripts by exact path, and the Agent tool for the three appl-*
#               subagents.
#               `release` is the release solo's pane (the walled-release chain, intake
#               20261004T224500Z): it may write the checkout's top-level VERSION and
#               CHANGELOG.md through Edit/Write and create an annotated tag with `git tag -a
#               -m <msg> v<X.Y.Z> [<commit>]`, and nothing else. Every other path of the
#               checkout -- an existing file, one that does not exist yet, .git/, a look-alike
#               (VERSION.bak, docs/VERSION) -- is DENIED by an explicit deny rule (negated
#               character classes plus their `/**` forms), never left unlisted for the
#               auto-mode classifier. Its deny list begins with the shared static list; it
#               carries none of the worker's task or test exec rules and takes no --allow.
#               Claude and cursor: any other harness is exit 2 naming the release profile.
#               The cursor render is that same allow and deny in Cursor's spelling, not the
#               worker brief list, and it drops any allow that matches a receipt write.
#               `weekly` is the weekly security hunt tools/security_weekly.sh spawns: the
#               reviewer profile in every respect (it IS spawned as one, every reviewer
#               deny and refusal included) plus ONE allow rule, for write-weekly-receipt.sh,
#               the full receipt its brief's step 5 writes. The per-landing reviewer keeps
#               no --full path of any spelling (intake 20261009T101928Z).
#   --allow 'Bash(...)'
#               one more allow rule for this session (repeatable): the brief's author
#               widening the list for a task-specific command, so the worker does not
#               stop on it. Bash rules only. A rule a deny entry would beat anyway (it
#               would still stop), or one naming a reader, an interpreter or a network
#               command, is exit 2 with one line and no worker. An accepted rule goes
#               into the settings file verbatim. On the grok harness the same rule is
#               also one `--allow` on the grok argv (that argv is the wall). It is
#               never printed on stdout.
#   --env K=V   extra environment for the tab (repeatable). A key the SPAWN sets itself is
#               refused here, by name: CODEX_HOME, CURSOR_CONFIG_DIR, PYTHONNOUSERSITE,
#               CLAUDE_CODE_DISABLE_AUTO_MEMORY, HERD_WORKER, HERD_BRIEF, HERD_REPORT,
#               ISOLATED_SESSION_GUARD_TRACE, MURETAI_HERDR_AGENT (which has a flag of
#               its own, --muretai-agent, with a name rule this door would skip), and
#               HERD_WALL_INSIDE (the wall's own marker: the plug sets it, a caller never),
#               and CLAUDE_CODE_OAUTH_TOKEN (THE OAUTH TOKEN, below: only the file is
#               honored, so a spawn line cannot hand a pane a token by hand). The
#               caller's entries are appended AFTER the spawn's on `herdr tab create`, so a
#               duplicate key leaves it to herdr's dedup order which value the tab gets --
#               neither pinned here nor testable, and the two it would decide are the
#               interpreter wall and the config home. MURETAI_BINDING_FILE and
#               ISOLATED_SESSION_OWNER are deliberately NOT on the list: the spawn never
#               sets the first, and sets the second only when the caller did not (a walled
#               worker's default key is its own name -- THE OWNER KEY, in the wall block --
#               and a caller's entry is then the only one on the tab). The first names a
#               binding a node child reads, and the second is
#               how a test-author / implementer pair hands its worktree lock over: every
#               lock of the cwd's repository owned by that key passes to THIS worker by
#               name (stderr says which), and the worker's session binds its own process
#               at its first guarded command -- see the pair hand-over in lib.sh.
#               A key a LIVE worker holds (one herdr still lists) is refused, naming that
#               worker, before a tab or a record -- except that hand-over itself: --cwd into
#               the key's worktree once the holder wrote its report.md (key_guard, below;
#               the key is recorded in $HERD_DIR/.keys/<name>).
#               The wall's knobs are the exception the other way: `--env HERD_WALL=off`
#               (and HERD_WALL_EGRESS, _CPU_SECS, _MEM_MB, _PROCS) set THIS spawn's wall,
#               exactly as the same variable in the spawn's environment would, and are
#               never put on the tab.
#               A coordinator-profile tab always carries DISABLE_AUTOUPDATER=1 (an
#               in-pane update must not end the long-lived coordinator mid-loop); a
#               caller's DISABLE_AUTOUPDATER on that profile is exit 2.
#   --muretai-agent NAME
#               mark the pane as that Muretai agent's wake target: tab env
#               MURETAI_HERDR_AGENT=NAME, then herdr pane report-metadata with
#               token muretai_agent=NAME (never a DID). Without this flag the
#               spawn is unchanged.
#   --role solo DECLARE the worker a solo one: spawned alone, with no test-author /
#               implementer pair, whose report appl-verify.sh checks as a landing with an
#               empty pin (ISSUE(single-worker-report-is-ignored)). Any other value, or no
#               value, is exit 2 before herdr is asked anything. The role is never inferred
#               from a name or a brief. The spawn writes it TWICE, each file mode 400,
#               created exclusively (the exact path unlinked first): the marker
#               $HERD_DIR/<name>/role, beside permissions.json, and the spawn's own record
#               $HERD_DIR/.roles/<name>, in a herd-level directory that is no worker's
#               --add-dir (a worker name starts with a letter, so `.roles` is never one) and
#               is Edit-denied to every session. appl-role-of.sh says `solo` only when BOTH
#               are there: the marker alone is in the worker's own directory, where it could
#               write one and skip its pin check. Since 2026-09-26 (Option B) a worker-profile
#               spawn WITHOUT --role writes the same two files: an operator's own spawn is
#               solo, and a pair worker stays its template's role because appl-role-of.sh
#               lets a template brief win over any record. A reviewer-profile spawn
#               removes the marker and writes the record alone, reading `reviewer`, the
#               same way (a non-template review brief is then verified as a review); a
#               coordinator spawn removes both, so a record left by an earlier spawn
#               never promotes it.
#               Every spawn, whatever its role, also records the repository its worker's
#               report is judged in: $HERD_DIR/.repos/<name>, `iso_primary_of <cwd>` and a
#               newline, mode 600 in a herd-level directory of mode 700, Edit-denied like
#               .roles/, written before the tab exists and removed with the brief when the
#               spawn fails (kept, with the brief, when it stops at a first-run prompt). appl-hook.sh reads it as `appl-verify.sh --repo`; a cwd with no
#               repository is refused before herdr is asked anything.
#   --lane fast write record.lane as the string fast into this spawn's own
#               $HERD_DIR/walls/<name>/run.json, in the same write that creates
#               the record, so the lane is there from that moment on every exit:
#               a delivered worker=, a live pane whose agent wait failed, a
#               half_fail keep, a first-run stop that prints --resume, and a
#               later --resume of that name. Any other value is exit 2 before
#               herdr is asked anything. Absent, the record is still written
#               and its lane is not fast. A later --resume does not rewrite
#               the record, so the lane the first spawn wrote stays.
#   --open-worktree TITLE
#               open the worker's worktree HERE, before herdr is asked anything, and spawn
#               in it: `ensure-worktree.sh "TITLE"` runs in the primary of the repository
#               this script lives in, under the caller's `--env ISOLATED_SESSION_OWNER=<k>`
#               (required with this flag) and no other ISOLATED_SESSION_* variable, the way
#               dispatch-take.sh opens a ticket's worktree (293dfea7). Its WORKTREE= becomes
#               --cwd, and the brief gets WORKTREE, BRANCH and PRIMARY (the primary it was
#               opened from, not the cwd) and, unless the caller passed one, TITLE. The key
#               is stable, so a re-run for the same title finds its own lock and resumes the
#               same worktree; the pair hand-over below then passes that hold to the worker.
#               It is the coordinator's sanctioned way to open a SOLO worker's worktree: its
#               seat may not set ISOLATED_SESSION_OWNER itself. With --cwd, or with a --var
#               WORKTREE/BRANCH/PRIMARY of the caller's, it is exit 2: two answers to one
#               question. A refused ensure-worktree is exit 2 with its last words, no tab.
#   --repo PRIMARY
#               with --open-worktree only (alone it is exit 2): open the worktree in THAT
#               repository instead of this script's -- for the coordinator seat, which runs
#               every call from its own checkout and cannot `cd` elsewhere first. PRIMARY is
#               resolved (relative to the caller's directory, symlinks and a trailing slash
#               dropped) and must be a repository's primary checkout, not a linked worktree
#               or a subdirectory, listed in $HOME/.muretai/dispatch/repos (dispatch_listed);
#               otherwise exit 2 before herdr is asked anything and before any worktree or
#               branch exists. That repository's OWN ensure-worktree.sh runs, from its
#               primary; one that has none is exit 2 (this script's copy is never run
#               against it). The brief's PRIMARY is that repository. --cwd stays refused.
#   --base REV  with --profile reviewer and --open-worktree only (anything else is exit 2):
#               open the REVIEWER's worktree at that commit, directly under
#               $HERD_DIR/review/<name>, through `ensure-worktree.sh --at <sha> --into <dir>`
#               under the caller's key -- so the review-checkout carve-out below applies and
#               its write rules are exactly those of a reviewer spawned with --cwd in such a
#               checkout. REV resolves only through `git rev-parse --verify --quiet
#               --end-of-options "REV^{commit}"` in the primary the worktree opens from; an
#               empty value, or one that is not a commit, is exit 2 before herdr is asked
#               anything and before any worktree or branch exists. The value is never
#               evaluated. The new branch's tip is that commit: the open lands nothing.
#               A reviewer's --open-worktree needs --base.
#
# Exit 3, one line on stderr, when herdr is not on PATH or its server is not running
# (HERD_SPAWN_BIN names the binary explicitly; the tests point it at a stub). Exit 2
# on a usage error. On success the one stdout line is
#   worker=<name> pane=<id> tab=<id> report=<path> harness=<h> model=<m> wall=walled|unwalled|inherited egress=open
# (`inherited`: this spawn itself runs behind a wall that cannot nest -- see THE WALL.)
#
# HERD_WALL (require|prefer|off), HERD_WALL_EGRESS (open; deny is refused until wall v2),
# HERD_WALL_CPU_SECS (7200), HERD_WALL_MEM_MB (8192) and HERD_WALL_PROCS (512): the wall
# the worker runs behind, its probe, and the bounds it runs under -- see "the wall and the
# bounds" below; the record is $HERD_DIR/walls/<name>/wall.log.
#
# HERD_SPAWN_READY_SECS (default 30) is how long `agent start` is retried while the
# pane's shell prints its prompt. HERD_SPAWN_AGENT_READY_SECS (default 120) is how
# long, after start succeeds, to wait for the agent's input line (`herdr agent wait
# --until idle`) and is the caller --timeout on `agent prompt`. The two waits are
# not folded: start succeeding means the process is in the pane, not that a brief
# will be read. A spawn either hands the brief to an agent that took it, or fails.
#
# The agent runs on `opus`, or on the first `[harness.order]` entry of the machine file
# for its profile (HERD_SPAWN_MODEL overrides either: an alias or a model id) and
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
# `python3 tools/*` (the no-stops plan's S2: a worker stopped on every task script), the
# test files as the prefix rules `python3 tests/test_` and `python3 -I tests/test_`, and
# run-test.sh / run-node.sh by the one path its brief names (intake 20261028T150531Z).
# Both profiles have the glue a worker chains
# after a real command -- echo, printf, pwd, true, test, mkdir -p -- and three read-only
# git verbs (S1: a `cmd && echo "$X"` line stopped at the classifier because `echo` was on
# no list). Every profile but release also takes the one read-only command list,
# readonly-commands.tsv beside this script (ls, find, cat, head, tail, grep, wc, stat,
# read-only git, herdr agent list/read: intake 20261007T152501Z), with the denies that keep a
# redirect and each refused flag out; the wall, not the list, bounds what a reader reads.
# `git push` is refused outright -- by the session's own rule, which is a promise
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
# THE GROK HARNESS (HERD_SPAWN_HARNESS=grok) is Grok Build, the `grok` binary. Measured
# on grok 1.0.41 (`grok --help` only; this script never starts a grok session): the pane
# is `grok --cwd <worktree>` with one `--allow` per allow rule and one `--deny` per deny
# rule. The flag value is the spelling grok_rules.py produces, not the Claude rule
# verbatim. The brief is typed the same way as for cursor.
# A grok worker starts only in a worktree, because its instruction files live in the
# directory it opens; a primary checkout is exit 2 naming `pass --cwd <worktree>`. A
# reviewer is exit 2 before herdr is asked anything, until which instruction files grok
# reads is known; a coordinator is refused the same way (no per-pane slot for
# appl-hook.sh either). `grok --help` lists no hooks flag and the grok config directory
# holds no hooks config (ISSUE(grok-harness-has-no-hook)). The harness is refused at
# selection until a hook registration exists. The auto-approve switch is never passed:
# the argv pins `--permission-mode auto`, and a grok config.toml or requirements.toml whose
# `[ui] permission_mode` is empty or bypass-shaped refuses the spawn before the wall.
# HERD_SPAWN_MODEL is `--model` when set; unset is the account default. HERD_SPAWN_PERMISSION_MODE does
# not apply: a set value is exit 2 rather than a word this branch would drop.
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

# ledger_line EVENT WORKER KEY=VALUE...: one line in $HERD_DIR/coordinator/runs.jsonl through
# run_ledger.py beside this script (spawn, spawn-failure, failover). Best effort: a ledger
# that refuses the line or cannot be written never changes what the spawn does, prints or
# exits with, and a symlinked module is never run. The brief is never passed.
ledger_line() {
  local mod="$here/run_ledger.py" event="$1" who="$2"
  shift 2
  [[ -f "$mod" && ! -L "$mod" ]] || return 0
  python3 -I "$mod" "${herd_dir:-${HERD_DIR:-${HOME:-}/.cache/muretai-herd}}" "$event" "" "$who" "$@" \
    >/dev/null 2>&1 || true
}

usage() {
  echo "usage: herd-spawn.sh <name> <brief-file> [--cwd DIR] [--profile worker|reviewer|weekly|coordinator|release] [--env K=V ...] [--var KEY=VALUE ...] [--allow 'Bash(...)' ...] [--muretai-agent NAME] [--role solo] [--p0] [--lane fast] [--open-worktree TITLE [--base REV]]" >&2
  echo "       HERD_SPAWN_HARNESS=codex requires --cwd <worktree>: a codex session's writable sandbox root IS the directory it opens in, and no session guard runs on that harness" >&2
  echo "       HERD_SPAWN_HARNESS=grok requires --cwd <worktree>: grok reads its instruction files from the directory it opens, and a primary checkout is refused" >&2
  echo "       herd-spawn.sh --resume <name>   (a spawn that stopped at a first-run prompt, once the prompt is answered; same HERD_DIR)" >&2
  echo "       herd-spawn.sh --render <name> <brief-file> [the flags above]   (the spawn's files and its harness command line, with no herdr, tab or agent)" >&2
  exit 2
}

# --- the shared tail ---------------------------------------------------------------------
# Defined before anything runs, because two paths use them: a spawn, and `--resume <name>`
# (the same spawn, picked up after the owner answered a first-run prompt in its pane).
resuming=no

# herdr on PATH (or HERD_SPAWN_BIN) and its server up, else exit 3
find_herdr() {
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
}

# A failed start is not always a slow shell: a harness stuck on one of Claude Code's
# FIRST-RUN prompts (the renderer choice, the auto-mode setup, folder trust, "Not logged
# in") is already registered, so a retry only earns herdr's agent_name_taken (Mac B,
# 2026-09-17). The pane is read once and matched on keywords; a match is NAMED from the
# fixed vocabulary below -- the pane's bytes never reach stderr, they are data another
# checkout may have written. The keywords are guesses at the real screens
# (ISSUE(first-run-prompt-texts-are-guesses)).
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

# The kind word the harness's own adapter gives the pane's screen (`<adapter> --recognize`,
# the screen on stdin), or return 1. The adapter is the one place a runtime's dialogs are
# known; this script learns only the word, and a word that is not [a-z][a-z0-9-]{0,31} is
# no kind. Recognizing types nothing. The screen is $1 when the caller already read the
# pane (the stall nudge reads it once), else read here. The adapter is the harness's file
# beside this script (the spawn's validated harness, or a resume record's): adapter_path,
# THE seam's one path, computed on each call and never taken from a variable a caller
# could have set.
adapter_path() {
  printf '%s\n' "$here/trust/${harness}.sh"
}
dialog_kind() {
  local screen="${1:-}" kind adapter
  adapter="$(adapter_path)"
  [[ -f "$adapter" && ! -L "$adapter" ]] || return 1
  if [[ -z "$screen" ]]; then
    screen="$("$herdr" agent read "$name" --source recent-unwrapped --lines 80 2>/dev/null \
              || "$herdr" agent read "$name" 2>/dev/null || true)"
  fi
  [[ -n "$screen" ]] || return 1
  kind="$(printf '%s' "$screen" | bash "$adapter" --recognize 2>/dev/null)" || return 1
  [[ "$kind" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || return 1
  printf '%s\n' "$kind"
}

# half_fail RC WHAT [keep|resume]: one stderr line naming the failure, the steps that
# completed (done_steps), and that the brief was NOT delivered; no worker= line.
#   keep    a failure of `agent prompt` itself (a stall past the deadline, a timeout, a
#           refusal), where the line may already be in the pane: the ISSUE this exists for
#           was a worker that received the line after a stall and found brief.md removed
#           by the spawn's own cleanup.
#   resume  a spawn stopped at a first-run prompt: nothing was typed, and brief.md, the
#           .roles and .repos records and the resume record all stay, so the one command
#           printed here delivers the SAME brief once the owner has answered the prompt.
#           (It used to remove them, and an owner who answered the prompt and re-sent the
#           spawn line by hand left a worker with no brief and a report with no record.)
# Without a mode a spawn removes what it wrote (drop_brief); a --resume never removes
# anything, and its failure says the resume can be run again.
half_fail() {
  local rc="$1" what="$2" keep="${3:-}" tail delivered="the brief was not delivered"
  if [[ "$keep" == "keep" ]]; then
    brief_ours=no
    delivered="the brief was not delivered as far as herdr reports"
    tail="brief.md is KEPT at ${bfile}: the line may already have been typed into the pane, so a worker that got it finds its brief -- check the pane before re-spawning ${name}"
  elif [[ "$keep" == "resume" ]]; then
    brief_ours=no
    tail="nothing was typed into the pane, so brief.md (${bfile}) and the .roles and .repos records are KEPT; answer the prompt in the pane, then run: bash ${here}/herd-spawn.sh --resume ${name}"
  elif [[ "$resuming" == "yes" ]]; then
    tail="nothing was typed into the pane; brief.md, its records and the resume record are kept, so the same resume can be run again"
  else
    tail="nothing was typed into a pane, so brief.md is removed"
  fi
  echo "herd-spawn: ${what}; ${delivered} to ${name} -- done: ${done_steps}; ${tail}" >&2
  exit "$rc"
}

# stall_shape [MARK]: at the first `agent_prompt_stalled`, the pane is read ONCE and named by one
# word in nudge_shape (nudge_why says why, in this script's own words):
#   typed   the last prompt line is exactly prompt_line, typed but not submitted: one Enter
#   empty   the prompt shows the runtime's placeholder (`Try "..."`): one re-send of prompt_line
#   stop    a dialog the harness's adapter recognizes (dialog_kind: an Enter would answer it),
#           a report.md already there, or a worker herdr no longer lists: nothing is typed
#   none    an unreadable pane or any other screen: the old retry loop, unchanged
# Nothing read from the pane is ever typed: the only key is Enter, the only text prompt_line.
# (Four spawns on 2026-09-30 sat at agent_prompt_stalled in one of the two shapes, each a
# human stop; one worker was swept 20 minutes later without ever getting its brief.)
# A prompt row opens with `>` or with MARK, the harness's declared input_row (U+276F when
# no MARK is given), as bar_holds_line reads it.
stall_shape() {
  local screen kind row_mark="${1:-}"
  nudge_shape=none nudge_why=""
  screen="$("$herdr" agent read "$name" --source recent-unwrapped --lines 80 2>/dev/null \
            || "$herdr" agent read "$name" 2>/dev/null || true)"
  [[ -n "$screen" ]] || return 0
  if kind="$(dialog_kind "$screen")"; then
    nudge_shape=stop nudge_why="the pane is at a dialog its adapter names '${kind}', so nothing was typed into it; answer it in the pane"
    return 0
  fi
  if [[ -e "$report" || -L "$report" ]]; then
    nudge_shape=stop nudge_why="${report} exists already, so the pane was not nudged"
    return 0
  fi
  nudge_shape="$(printf '%s' "$screen" | python3 -I -c '
import re, sys
line = sys.argv[1]
bar = chr(0x2502)   # the box side bar, kept ASCII here
mark = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else chr(0x276F)
text = sys.stdin.buffer.read().decode("utf-8", "replace")
text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?", "", text)
text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text)
last = None
for row in text.splitlines():
    m = re.fullmatch(r"\s*" + bar + r"?\s*(?:>|" + re.escape(mark) + r")(?: (.*?))?\s*" + bar + r"?\s*", row)
    if m:
        last = (m.group(1) or "").strip()
if last is not None and last == line:
    print("typed")
elif last is not None and re.fullmatch(r"Try \"[^\"]*\"", last):
    print("empty")
else:
    print("none")
' "$prompt_line" "$row_mark" 2>/dev/null)" || nudge_shape=none
  case "$nudge_shape" in
    typed|empty) ;;
    *) nudge_shape=none; return 0 ;;
  esac
  # a worker herdr no longer lists is sent nothing; a listing that does not answer is no
  # proof it is there
  if ! "$herdr" agent list 2>/dev/null | python3 -I -c '
import json, sys
try:
    rows = json.load(sys.stdin).get("result", {}).get("agents") or []
except (ValueError, AttributeError):
    sys.exit(1)
sys.exit(0 if any(isinstance(r, dict) and r.get("name") == sys.argv[1] for r in rows) else 1)
' "$name" >/dev/null 2>&1; then
    nudge_shape=stop nudge_why="herdr no longer lists ${name}, so nothing was typed"
  fi
}

# bar_holds_line [MARK]: the pane's LAST prompt row is exactly prompt_line -- typed, not
# submitted, though `agent prompt` answered success (a pane busy with a background shell, or
# under a banner, reads `working` to herdr while the Enter was lost). The same row rule as
# stall_shape: a row opens with `>` or with MARK, the harness's declared input_row (U+276F
# when no MARK is given; deliver_brief and wake-deliver.sh both pass the declared one).
# Anything else in the bar (a prefix, more text, another line, a draft) is no.
bar_holds_line() {
  local screen row_mark="${1:-}"
  screen="$("$herdr" agent read "$name" --source recent-unwrapped --lines 80 2>/dev/null \
            || "$herdr" agent read "$name" 2>/dev/null || true)"
  [[ -n "$screen" ]] || return 1
  printf '%s' "$screen" | python3 -I -c '
import re, sys
line = sys.argv[1]
bar = chr(0x2502)   # the box side bar, kept ASCII here
mark = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else chr(0x276F)
text = sys.stdin.buffer.read().decode("utf-8", "replace")
text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?", "", text)
text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text)
last = None
for row in text.splitlines():
    m = re.fullmatch(r"\s*" + bar + r"?\s*(?:>|" + re.escape(mark) + r")(?: (.*?))?\s*" + bar + r"?\s*", row)
    if m:
        last = (m.group(1) or "").strip()
sys.exit(0 if last is not None and last == line else 1)
' "$prompt_line" "$row_mark" 2>/dev/null
}

# cursor_box_shape: one word for cursor-agent's input box (intake 20261011T145010Z).
# cursor-agent draws its input as a box (U+250C ... U+2514) whose row is `| -> <text>` with
# the arrow U+2192, which bar_holds_line never matches. The LAST box on the screen is read,
# whitespace dropped so a wrapped line still compares:
#   typed   the box holds exactly the spawn line: one Enter may submit it
#   taken   the box does not hold it (`Read <brief>`), and the screen above the box shows
#           it: submitted
#   none    the box holds the line with other text (no Enter), or the line is nowhere:
#           not taken
#   nobox   the screen shows no cursor-agent input box
#   unread  herdr gave no screen at all
# An optional MARK (wake-deliver.sh passes the wake adapter's declared input_row) takes the
# place of U+2192.
cursor_box_shape() {
  local screen
  screen="$("$herdr" agent read "$name" --source recent-unwrapped --lines 80 2>/dev/null \
            || "$herdr" agent read "$name" 2>/dev/null || true)"
  [[ -n "$screen" ]] || { echo unread; return 0; }
  printf '%s' "$screen" | python3 -I -c '
import re, sys
line = sys.argv[1]
top, bottom, side, arrow = chr(0x250C), chr(0x2514), chr(0x2502), chr(0x2192)
if len(sys.argv) > 2 and sys.argv[2]:
    arrow = sys.argv[2]
text = sys.stdin.buffer.read().decode("utf-8", "replace")
text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?", "", text)
text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text)
rows = text.splitlines()
start = None
for i, row in enumerate(rows):
    if row.strip().startswith(top):
        start = i
end = None
if start is not None:
    end = next((j for j in range(start + 1, len(rows)) if rows[j].strip().startswith(bottom)), None)
if start is None or end is None:
    print("nobox")
    sys.exit(0)
squash = lambda s: re.sub(r"\s+", "", s)
key = squash(line.split(" and follow it.")[0])
inside = squash("".join(r.replace(side, "").replace(arrow, "") for r in rows[start + 1:end]))
above = squash("".join(rows[:start]))
if key and inside == squash(line):
    print("typed")
elif key and key in inside:
    print("none")
elif key and key in above:
    print("taken")
else:
    print("none")
' "$prompt_line" "${1:-}" 2>/dev/null || echo none
}

# cursor_screen_kind: one word for a cursor-agent screen on stdin (intake 20261018T222625Z).
# Prints approval, typed, empty, box-closed, or no row, then exits 0. Does not call herdr.
# approval wins: a question line Run this command?, Delete this file?, or Write to this
# file?, then option lines. One option is marked with two spaces, U+2192, one space, and
# at least one option ends in (y). A line between the question and those options stays in
# the menu. approval is also the box that repeats the pending command (intake
# 20261019T163318Z): the last input row is exactly two spaces, U+2192, one space, Tell the
# agent what to do instead (Enter to send, empty to skip, Esc to cancel); above it, blank
# lines aside, a box (U+250C ... U+2514) whose every line is U+2502, one space, `$`, two
# spaces, the command, then U+2502. Text above that box does not change the word.
# The arrow on an option line is not an input row. box-closed is only the
# heading Tell the agent what to do instead, matched on the whole line; the menu option
# Skip & tell the agent what to do instead (esc or n) is not that heading. The input row
# is the last line of either shape, trailing whitespace ignored: two spaces, U+2192, one
# space, text; or optional whitespace, U+2502, one space, U+2192, one space, text. empty
# is the row text Add a follow-up. Any other row text is typed. A bare arrow is no row.
# An optional MARK (wake-deliver.sh passes the wake adapter's declared input_row) takes the
# place of U+2192 in the input row; the approval option mark stays U+2192.
cursor_screen_kind() {
  python3 -I -c '
import re, sys
arrow, bar = chr(0x2192), chr(0x2502)
row_arrow = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else arrow
text = sys.stdin.buffer.read().decode("utf-8", "replace")
text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?", "", text)
text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text)
rows = text.splitlines()
questions = ("Run this command?", "Delete this file?", "Write to this file?")
mark = "  " + arrow + " "
row_mark = "  " + row_arrow + " "

def marked_body(row):
    s = row.rstrip()
    if not s.startswith(mark):
        return None
    body = s[len(mark):]
    if body == "":
        return None
    return body

def plain_body(row):
    s = row.rstrip()
    n = 0
    while n < len(s) and s[n] == " ":
        n += 1
    if n < 4 or n >= len(s):
        return None
    return s[n:]

def is_approval():
    for i, row in enumerate(rows):
        if row.strip() not in questions:
            continue
        seen = False
        has_mark = False
        has_yes = False
        for later in rows[i + 1:]:
            marked = marked_body(later)
            plain = None if marked is not None else plain_body(later)
            if marked is None and plain is None:
                if seen:
                    break
                continue
            seen = True
            body = marked if marked is not None else plain
            if marked is not None:
                has_mark = True
            if body.endswith("(y)"):
                has_yes = True
        if has_mark and has_yes:
            return True
    return False

def row_text(row):
    s = row.rstrip()
    if s.startswith(row_mark):
        body = s[len(row_mark):]
        return body if body != "" else None
    m = re.fullmatch(r"[ \t]*" + re.escape(bar) + " " + re.escape(row_arrow) + " (.*)", s)
    if not m:
        return None
    body = m.group(1).rstrip()
    return body if body != "" else None

tell = "Tell the agent what to do instead (Enter to send, empty to skip, Esc to cancel)"
cmd_row = re.compile(r"[ \t]*" + re.escape(bar) + r" \$  \S.*" + re.escape(bar))

def is_command_box():
    last = None
    for i, row in enumerate(rows):
        if row_text(row) is not None:
            last = i
    if last is None or rows[last].rstrip() != row_mark + tell:
        return False
    j = last - 1
    while j >= 0 and rows[j].strip() == "":
        j -= 1
    if j < 0 or not rows[j].strip().startswith(chr(0x2514)):
        return False
    j -= 1
    seen = 0
    while j >= 0 and cmd_row.fullmatch(rows[j].rstrip()):
        seen += 1
        j -= 1
    return seen > 0 and j >= 0 and rows[j].strip().startswith(chr(0x250C))

if is_approval() or is_command_box():
    print("approval")
elif any(row.strip().lower() == "tell the agent what to do instead" for row in rows):
    print("box-closed")
else:
    last = None
    for row in rows:
        got = row_text(row)
        if got is not None:
            last = got
    if last is None:
        print("no row")
    elif last == "Add a follow-up":
        print("empty")
    else:
        print("typed")
' "${1:-}"
}

# cursor_input_row: the last input-row text on stdin, the same two shapes cursor_screen_kind
# reads. Prints that text and exits 0. Prints nothing when the screen has no row. Does not
# call herdr. The kind stays cursor_screen_kind's word; this only names the row so a typed
# row can be compared with this worker's own spawn line.
cursor_input_row() {
  python3 -I -c '
import re, sys
arrow, bar = chr(0x2192), chr(0x2502)
text = sys.stdin.buffer.read().decode("utf-8", "replace")
text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?", "", text)
text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text)
mark = "  " + arrow + " "

def row_text(row):
    s = row.rstrip()
    if s.startswith(mark):
        body = s[len(mark):]
        return body if body != "" else None
    m = re.fullmatch(r"[ \t]*" + re.escape(bar) + " " + arrow + " (.*)", s)
    if not m:
        return None
    body = m.group(1).rstrip()
    return body if body != "" else None

last = None
for row in text.splitlines():
    got = row_text(row)
    if got is not None:
        last = got
if last is not None:
    print(last)
'
}

# cursor_submit_check: on the cursor harness the spawn line is submitted and then checked
# (intake 20261011T145010Z): `agent prompt` answered success while its Enter was lost and the
# line sat in cursor-agent's box, and herdr still read the pane as `working`. The box is read
# until it no longer holds the line and the line shows above it. A box that holds the line
# gets ONE Enter -- never a re-typed line (a second copy would be appended), never a second
# Enter, none after the stall nudge's own. Not taken within 30 s (counted with date +%s and
# sleep, as the loops above): `cursor-prompt-unsubmitted`, no worker= line, exit non-zero.
# A pane whose first read gives no screen cannot be checked: it is said, and the spawn goes
# on as before. A screen with no box (intake 20261019T061613Z) is read with cursor_screen_kind.
# One Enter when the kind is typed and the row is this worker's own spawn line. Nothing on
# approval, empty, box-closed, no row, or a typed row that is not this line. Still that typed
# line 30 s after the press: refused by the worker's name, nothing else pressed. A row that
# clears after the press finishes the spawn.
cursor_submit_check() {
  local deadline shape enter_done="$enter_sent" first=yes screen kind row
  deadline=$(( $(date +%s) + 30 ))
  while :; do
    shape="$(cursor_box_shape)"
    [[ "$shape" == "taken" ]] && return 0
    if [[ "$shape" == "nobox" ]]; then
      screen="$("$herdr" agent read "$name" --source recent-unwrapped --lines 80 2>/dev/null \
                || "$herdr" agent read "$name" 2>/dev/null || true)"
      kind="$(printf '%s' "$screen" | cursor_screen_kind)"
      row="$(printf '%s' "$screen" | cursor_input_row)"
      if [[ "$kind" == "typed" && "$row" == "$prompt_line" ]]; then
        if [[ "$enter_done" == "no" ]]; then
          enter_done=yes
          if "$herdr" agent send-keys "$name" enter >/dev/null 2>&1; then
            echo "herd-spawn: ${name}'s spawn line sat typed on the input row; one Enter was pressed" >&2
          else
            echo "herd-spawn: ${name}'s spawn line sat typed on the input row, and the one Enter was refused" >&2
          fi
          deadline=$(( $(date +%s) + 30 ))
          continue
        fi
        if [[ $(date +%s) -ge $deadline ]]; then
          half_fail 1 "${name}'s spawn line was still typed 30s after one Enter" keep
        fi
        sleep 2
        continue
      fi
      return 0
    fi
    if [[ "$first" == "yes" ]] && [[ "$shape" == "unread" ]]; then
      echo "herd-spawn: herdr showed no cursor-agent input box for ${name}'s pane, so whether cursor-agent took the spawn line was not checked; check the pane" >&2
      return 0
    fi
    first=no
    if [[ "$shape" == "typed" && "$enter_done" == "no" ]]; then
      enter_done=yes
      if "$herdr" agent send-keys "$name" enter >/dev/null 2>&1; then
        echo "herd-spawn: the line sat typed but unsubmitted in ${name}'s cursor-agent input box after herdr took it; one Enter was pressed" >&2
      else
        echo "herd-spawn: the line sat typed but unsubmitted in ${name}'s cursor-agent input box, and the one Enter was refused" >&2
      fi
      continue
    fi
    if [[ $(date +%s) -ge $deadline ]]; then
      half_fail 1 "cursor-prompt-unsubmitted: ${name}'s cursor-agent did not take the spawn line within 30s (pane ${pane}, tab ${tab_id}; its input box reads '${shape}'); the line was not typed again" keep
    fi
    sleep 2
  done
}

# prompt_is_stalled REASON: the last line of `herdr agent prompt`'s stderr is the stall.
# Every harness still stalls on the bare word agent_prompt_stalled. The cursor adapter
# prints one JSON object whose error code is that word (intake 20261012T115500Z); only
# the cursor harness reads that form. claude, codex and grok keep the bare-line compare.
prompt_is_stalled() {
  [[ "$1" == "agent_prompt_stalled" ]] && return 0
  [[ "$harness" == "cursor" ]] || return 1
  printf '%s' "$1" | python3 -I -c '
import json, sys
raw = sys.stdin.read().strip()
try:
    data = json.loads(raw)
except ValueError:
    sys.exit(1)
err = data.get("error") if isinstance(data, dict) else None
code = err.get("code") if isinstance(err, dict) else ""
sys.exit(0 if code == "agent_prompt_stalled" else 1)
' 2>/dev/null
}

# cursor_line_echoed: one read of the pane. A transcript row whose text is the arrow
# (U+2192), a space, and THIS spawn line means cursor-agent already took the prompt
# (intake 20261012T115500Z). The row may have surrounding whitespace. Another worker's
# arrow row, a bare copy of the line, and the same line inside the input box are not
# it. Nothing read from the pane is typed.
cursor_line_echoed() {
  local screen
  screen="$("$herdr" agent read "$name" --source recent-unwrapped --lines 80 2>/dev/null \
            || "$herdr" agent read "$name" 2>/dev/null || true)"
  [[ -n "$screen" ]] || return 1
  printf '%s' "$screen" | python3 -I -c '
import re, sys
line = sys.argv[1]
arrow = chr(0x2192)
text = sys.stdin.buffer.read().decode("utf-8", "replace")
text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?", "", text)
text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text)
want = arrow + " " + line
for row in text.splitlines():
    if row.strip() == want:
        sys.exit(0)
sys.exit(1)
' "$prompt_line" 2>/dev/null
}

# wake_decl HARNESS KEY: one field of HARNESS's wake adapter declaration
# (wake-adapter.sh show, beside this script). Returns 1, the adapter's refusal on stderr,
# when the declaration is refused or the harness has none.
wake_decl() {
  local decl field
  decl="$(bash "$here/wake-adapter.sh" show "$1")" || return 1
  while IFS= read -r field; do
    case "$field" in
      "$2="*) printf '%s' "${field#"$2="}"; return 0 ;;
    esac
  done <<< "$decl"
  return 1
}

# first_line_for HARNESS BRIEF REPORT: the one line a pane is told, for the spawn and for
# --resume alike. It keeps the prefix `Read <brief.md> and follow it. Your report goes to
# <report.md>.` and adds how to open the brief: two reviewer panes died on a FIRST call that
# read the brief with a chained shell command their profile denied. The clause is the
# harness's declared spawn_clause, none for a harness that is told no clause.
# appl-hook.sh on_spawn_line and herd-watch.sh spawn_line build the same lines;
# tests/test_spawn_first_read.py.
first_line_for() {
  local clause
  clause="$(wake_decl "$1" spawn_clause)" || return 1
  [[ "$clause" != "none" ]] || clause=""
  printf '%s' "Read ${2} and follow it. Your report goes to ${3}.${clause:+ ${clause}}"
}

# wake_facts: the running harness's declared input_row (wake_row), resubmit key (wake_key)
# and submit check (wake_check: `box` reads the input box the way cursor_submit_check does,
# `bar` reads the last prompt row the way bar_holds_line does). A box harness's row is read
# by its box readers, so for it wake_row is empty and the stall nudge keeps its own row
# rule. Returns 1 on a refused declaration or a key that is not one herdr key name.
wake_facts() {
  wake_row="$(wake_decl "$harness" input_row)" || return 1
  wake_key="$(wake_decl "$harness" resubmit)" || return 1
  wake_check="$(wake_decl "$harness" submit_check)" || return 1
  case "$wake_key" in
    ""|*[!A-Za-z0-9_+-]*) return 1 ;;
  esac
  [[ "$wake_check" == "bar" ]] || wake_row=""
}

# The two readers a `box` submit check runs: the transcript row that shows the line was
# taken at a stall, and the check of the box after the prompt.
box_line_taken() { cursor_line_echoed; }
box_submit_check() { cursor_submit_check; }

# What a harness leaves unenforced, said on the spawn's own stdout where the person
# spawning the worker reads it: on codex the allow/deny lists this script computed are
# recorded, not applied. A file nobody opens would let the claude wall be assumed for a
# session that does not have it. The second line is the OTHER half of the same truth, and
# it was missing while the header claimed the opposite: no session guard runs here either,
# so the worktree named by --cwd is the whole of this session's blast radius.
say_unenforced_wall() {
  if [[ "$harness" == "codex" ]]; then
    echo "codex: the allow/deny lists are not enforced on this harness; the wall is the sandbox (workspace-write) and approval (on-request)"
    echo "codex: and no session guard runs on it -- the isolated-session hook is registered for claude, cursor and grok only, and codex-cli reads neither .claude/settings.json nor .cursor/hooks.json; the worktree this worker opened in is the whole of its blast radius"
  fi
}

# deliver_brief: the agent is in the pane; wait for its input line, hand over the pair's
# lock, type the one line, and only then print the worker= line. Reads name, herdr, pane,
# tab_id, cwd, pair_key, prompt_line, report, harness, model and wall_state.
deliver_brief() {
  # Start succeeding means the harness process is in the pane, not that its input
  # line takes text (daily-2026-09-16 typed into a banner; shop-door-hardening-tests
  # at 23:50 sat unsent). One wait for idle, then prompt with --wait until working
  # or blocked so the spawn returns when the brief is taken, not when the turn ends.
  agent_ready_secs="${HERD_SPAWN_AGENT_READY_SECS:-120}"
  ready_ms=$(( agent_ready_secs * 1000 ))
  wait_err="$(mktemp "${TMPDIR:-/tmp}/herd-spawn-wait.XXXXXX")"
  if ! "$herdr" agent wait "$name" --until idle --timeout "$ready_ms" >/dev/null 2>"$wait_err"; then
    wait_reason="$(tail -1 "$wait_err" 2>/dev/null || true)"
    rm -f "$wait_err"
    half_fail 1 "'herdr agent wait' failed for ${name} (pane ${pane}, tab ${tab_id}): ${wait_reason}; the agent started but never reached its input line, and no prompt was typed"
  fi
  rm -f "$wait_err"
  # The input row, the resubmit key and the submit check are the harness's declared ones.
  if ! wake_facts; then
    half_fail 1 "the wake adapter declaration of ${harness} was refused or names no input_row, resubmit and submit_check, so ${name}'s input line cannot be read; no prompt was typed"
  fi

  # The pair hand-over (ISSUE(pair-worktree-lock-dies-with-the-test-author-session)): a
  # worker started with `--env ISOLATED_SESSION_OWNER=<key>` takes over every worktree lock
  # of THIS repository (the cwd's) whose owner is that key -- the test author's -- recorded
  # as handed to this worker by name; the worker's session binds its own process at its
  # first guarded command (lib.sh, iso_lock_handover / iso_lock_bind). Here, after the agent
  # is up and before it is told anything, so it never meets the author's lock, and a spawn
  # that failed earlier hands nothing to a worker that does not exist. A spawn without the
  # key, or with a key no lock carries, changes nothing. A walled worker always has a key --
  # the caller's, or its own name (THE OWNER KEY) -- so the hold on a folder that key
  # already owns passes to it the same way. A resume hands over here too: the spawn it
  # picks up stopped before this step.
  if [[ -n "$pair_key" ]]; then
    while IFS= read -r handed; do
      [[ -n "$handed" ]] || continue
      echo "herd-spawn: the hold on $(iso_safe_text "$handed" || echo '(a worktree)') passes to ${name} (owner key $(iso_safe_text "$pair_key" || echo '?'))" >&2
    done < <(iso_lock_handover "$cwd" "$pair_key" "$name" 2>/dev/null || true)
  fi

  # Flags after TEXT (herdr: agent prompt <TARGET> <TEXT> [OPTIONS]). Only
  # agent_prompt_stalled is retried, two seconds apart, until AGENT_READY_SECS
  # from the first attempt. Any other failure (agent_blocked, timeout, ...) is not.
  # The FIRST stall is answered by the nudge (stall_shape, above) when the pane shows one of
  # its two shapes: one Enter for the typed line, or one re-send of the line at the empty
  # prompt, then the stall is reported if the agent is still idle -- never looped, and an
  # Enter that did not submit is not followed by a re-send (a second copy would be appended
  # to the line still in the prompt). A pane the nudge does not recognize keeps the loop.
  # A stall on a harness whose declared submit check is `box` is read once before that
  # nudge (intake 20261012T115500Z): a transcript row that is the arrow and this spawn's
  # line means the prompt was already taken, so nothing is pressed and the line is not sent
  # again. The spawn then goes on to the box submit check. Any other screen keeps the nudge
  # and the retry below.
  prompt_err="$(mktemp "${TMPDIR:-/tmp}/herd-spawn-prompt.XXXXXX")"
  prompted=no
  enter_sent=no
  nudge_done=no
  nudge_said=""
  taken_read=no
  prompt_deadline=$(( $(date +%s) + agent_ready_secs ))
  while :; do
    if "$herdr" agent prompt "$name" "$prompt_line" \
         --wait --until working --until blocked --timeout "$ready_ms" \
         >/dev/null 2>"$prompt_err"; then
      prompted=yes
      break
    fi
    prompt_reason="$(tail -1 "$prompt_err" 2>/dev/null)"
    if ! prompt_is_stalled "$prompt_reason"; then
      rm -f "$prompt_err"
      half_fail 1 "'herdr agent prompt' failed for ${name} (pane ${pane}, tab ${tab_id}): ${prompt_reason}; the agent had started" keep
    fi
    if [[ "$wake_check" == "box" && "$taken_read" == "no" ]]; then
      taken_read=yes
      if box_line_taken; then
        prompted=yes
        enter_sent=yes
        break
      fi
    fi
    if [[ "$nudge_done" == "no" ]]; then
      nudge_done=yes
      stall_shape "$wake_row"
      case "$nudge_shape" in
        stop)
          nudge_said="$nudge_why"
          break
          ;;
        typed)
          enter_sent=yes
          if "$herdr" agent send-keys "$name" "$wake_key" >/dev/null 2>&1 &&
             "$herdr" agent wait "$name" --until working --until blocked --timeout "$ready_ms" >/dev/null 2>&1; then
            prompted=yes
          else
            nudge_said="the line sat typed but unsubmitted and one Enter did not submit it"
          fi
          break
          ;;
        empty)
          if "$herdr" agent prompt "$name" "$prompt_line" \
               --wait --until working --until blocked --timeout "$ready_ms" \
               >/dev/null 2>"$prompt_err"; then
            prompted=yes
            break
          fi
          prompt_reason="$(tail -1 "$prompt_err" 2>/dev/null)"
          if ! prompt_is_stalled "$prompt_reason"; then
            rm -f "$prompt_err"
            half_fail 1 "'herdr agent prompt' failed for ${name} (pane ${pane}, tab ${tab_id}) on its one re-send at the empty prompt: ${prompt_reason}; the agent had started" keep
          fi
          nudge_said="the prompt sat empty and one re-send of the line stalled too"
          break
          ;;
      esac
    fi
    [[ $(date +%s) -lt $prompt_deadline ]] || break
    sleep 2
  done
  if [[ "$prompted" != "yes" ]]; then
    prompt_reason="$(tail -1 "$prompt_err" 2>/dev/null || true)"
    rm -f "$prompt_err"
    if [[ -n "$nudge_said" ]]; then
      half_fail 1 "'herdr agent prompt' stalled for ${name} (pane ${pane}, tab ${tab_id}): ${nudge_said}; the agent had started" keep
    fi
    half_fail 1 "'herdr agent prompt' kept stalling for ${name} (pane ${pane}, tab ${tab_id}) past ${agent_ready_secs}s: ${prompt_reason}; the agent had started" keep
  fi
  rm -f "$prompt_err"
  # A success is not proof the line was submitted: with a background shell running or a
  # banner up, the Enter `agent prompt` pressed was lost and herdr still read the pane as
  # `working` (three of four such cases raised no agent_prompt_stalled). The pane is read
  # once; when its last prompt row is exactly the line, ONE Enter -- never a re-typed line
  # (a second copy would be appended to the one in the bar), never a second Enter, and none
  # after the stall nudge's own Enter. Nothing read from the pane is typed. The row is the
  # declared input_row and the key the declared resubmit.
  if [[ "$wake_check" == "box" ]]; then
    box_submit_check
  elif [[ "$enter_sent" == "no" ]] && bar_holds_line "$wake_row"; then
    if "$herdr" agent send-keys "$name" "$wake_key" >/dev/null 2>&1; then
      echo "herd-spawn: the line sat typed but unsubmitted in ${name}'s prompt bar after herdr took it; one Enter was pressed" >&2
    else
      echo "herd-spawn: the line sat typed but unsubmitted in ${name}'s prompt bar after herdr took it, and the one Enter was refused; check the pane" >&2
    fi
  fi
  brief_ours=no          # the worker has been told to read it: it stays
  say_unenforced_wall
  # the harness and the model are on the line, so a landing's REVIEW= and its note can say
  # which eyes read the diff; and whether the worker is walled, with the network said
  # plainly (wall v1 leaves it open), so nobody reads "walled" as "offline"
  ledger_line spawn "$name" "role=${profile:-worker}" "harness=$harness" "model=${model:-default}" \
    "attempt=$(( ${order_index:-0} + 1 ))"
  echo "worker=${name} pane=${pane} tab=${tab_id} report=${report} harness=${harness} model=${model:-default} wall=${wall_state} egress=open"
}

# The belt under a cursor worker's own CURSOR_CONFIG_DIR: the user's ~/.cursor/cli-config.json
# carrying a permissions.allow of its own means an "always allow" was clicked somewhere, and
# a cursor session that ever falls back to that file would run under it
# (ISSUE(security-audit-2026-09-12-cursor-s-project-rul-e6f4-3)). Prints why and returns 1
# when it is armed; an absent file is not armed. Used by a --resume, which types the line
# into a pane, as well as by a fresh spawn (whose stricter check is below).
user_cursor_cfg_armed() {
  local cfg="${HOME:-}/.cursor/cli-config.json"
  [[ -e "$cfg" || -L "$cfg" ]] || return 0
  python3 -I - "$cfg" <<'PY'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception as e:                                 # noqa: BLE001
    print("unreadable: " + type(e).__name__); sys.exit(1)
perms = cfg.get("permissions") if isinstance(cfg, dict) else None
allowed = (perms or {}).get("allow") if isinstance(perms, dict) else None
if allowed:
    print("permissions.allow is not empty: it would be unioned into the session"); sys.exit(1)
sys.exit(0)
PY
}

# A grok config file ($1, a config.toml or requirements.toml in the effective grok home)
# that would put a grok worker in a bypass mode: prints why and returns 1 when its
# `[ui] permission_mode` is not one of grok's non-bypass modes (an allowlist: default,
# acceptEdits, auto, plan -- grok 1.0.41's, notes/grok-rule-spelling.md), or when it is a
# requirements.toml whose `[ui] yolo` is not false
# (ISSUE(security-audit-2026-10-09-pin-the-grok-worker-17c7)). The file is read the way TOML
# reads it, not line by line: quoted and escaped keys and headers are decoded, and a
# multi-line string or array is one value however many lines it spans, so neither a
# `"permission_mode"` key nor a `[z]` line inside a string hides the key
# (intake 20261009T202248Z). Python 3.9 has no tomllib, so this is a small reader of its
# own, and anything it cannot classify is refused rather than guessed. The path must be a
# regular file (a FIFO would hang open()), opened non-blocking and checked again on the
# descriptor; a value it prints is ASCII-escaped, and the caller passes the reason through
# iso_safe_text too. A missing key returns 0. A function and not an inline $(...) heredoc:
# bash 3.2 misparses the quotes of a heredoc inside $(...).
grok_cfg_bypassed() {
  python3 -I - "$1" <<'PY'
import os, re, stat, sys
MODES = ("default", "acceptEdits", "auto", "plan")
LIMIT = 1 << 20
path = sys.argv[1]
req = os.path.basename(path) == "requirements.toml"


def no(why):
    print(why); sys.exit(1)


try:
    if not stat.S_ISREG(os.stat(path).st_mode):
        no("is not a regular file")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
except OSError as e:
    no("unreadable: " + type(e).__name__)
with os.fdopen(fd, "rb") as f:
    if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
        no("is not a regular file")
    data = f.read(LIMIT + 1)
if len(data) > LIMIT:
    no("is larger than 1 MiB, which this check does not read")
try:
    s = data.decode("utf-8")
except UnicodeDecodeError:
    no("is not UTF-8, which this check does not read")


class Bad(Exception):
    pass


class Inline(list):
    """an inline table: (key parts, value) pairs"""


ESC = {"b": "\b", "t": "\t", "n": "\n", "f": "\f", "r": "\r", "e": "\x1b", '"': '"', "\\": "\\"}
BARE = re.compile(r"[A-Za-z0-9_-]+")
SCALAR = re.compile(r"true|false|[+-]?(?:inf|nan)|[+-]?[0-9][0-9A-Za-z_:.+-]*(?:[ Tt][0-9][0-9:.+Zz-]*)?")
n, i = len(s), 0


def at(k=0):
    return s[i + k] if i + k < n else ""


def ws():
    global i
    while i < n and s[i] in " \t":
        i += 1


def blank():
    """spaces, line breaks and comments, where TOML allows them between values"""
    global i
    while i < n:
        if s[i] in " \t\r\n":
            i += 1
        elif s[i] == "#":
            while i < n and s[i] != "\n":
                i += 1
        else:
            return


def eol():
    global i
    ws()
    if at() == "#":
        while i < n and s[i] != "\n":
            i += 1
    if at() == "\r" and at(1) == "\n":
        i += 1
    if i < n and s[i] != "\n":
        raise Bad("more than one key or value on a line")
    i += 1


def basic(multi):
    global i
    out = []
    if multi:
        if s.startswith("\r\n", i):
            i += 2
        elif at() == "\n":
            i += 1
    while True:
        if i >= n:
            raise Bad("an unterminated string")
        c = s[i]
        if multi and s.startswith('"""', i):
            j = i + 3
            while j < n and s[j] == '"' and j - i < 5:
                j += 1
            out.append('"' * (j - i - 3))
            i = j
            return "".join(out)
        if not multi and c == '"':
            i += 1
            return "".join(out)
        if c == "\n" and not multi:
            raise Bad("a line break inside a one-line string")
        if c != "\\":
            out.append(c)
            i += 1
            continue
        e = at(1)
        if multi and e in " \t\r\n":
            j = i + 1
            while j < n and s[j] in " \t":
                j += 1
            if not (at(j - i) == "\n" or s.startswith("\r\n", j)):
                raise Bad("a backslash escape this check cannot read")
            i = j
            while i < n and s[i] in " \t\r\n":
                i += 1
            continue
        if e in ESC:
            out.append(ESC[e])
            i += 2
            continue
        k = {"u": 4, "U": 8, "x": 2}.get(e)
        h = s[i + 2:i + 2 + k] if k else ""
        if not k or len(h) != k or not re.fullmatch(r"[0-9A-Fa-f]+", h):
            raise Bad("a backslash escape this check cannot read")
        cp = int(h, 16)
        if cp > 0x10FFFF or 0xD800 <= cp <= 0xDFFF:
            raise Bad("a backslash escape this check cannot read")
        out.append(chr(cp))
        i += 2 + k


def literal(multi):
    global i
    if multi:
        if s.startswith("\r\n", i):
            i += 2
        elif at() == "\n":
            i += 1
        end = s.find("'''", i)
        if end < 0:
            raise Bad("an unterminated string")
        j = end + 3
        while j < n and s[j] == "'" and j - end < 5:
            j += 1
        out = s[i:j - 3]
        i = j
        return out
    end = s.find("'", i)
    if end < 0 or "\n" in s[i:end]:
        raise Bad("an unterminated string")
    out = s[i:end]
    i = end + 1
    return out


def key():
    global i
    parts = []
    while True:
        ws()
        if s.startswith('"""', i) or s.startswith("'''", i):
            raise Bad("a multi-line string used as a key")
        if at() == '"':
            i += 1
            parts.append(basic(False))
        elif at() == "'":
            i += 1
            parts.append(literal(False))
        else:
            m = BARE.match(s, i)
            if not m:
                raise Bad("a key this check cannot read")
            parts.append(m.group(0))
            i = m.end()
        ws()
        if at() != ".":
            return parts
        i += 1


def value(depth=0):
    global i
    if depth > 32:
        raise Bad("values nested too deep")
    if s.startswith('"""', i):
        i += 3
        return basic(True)
    if at() == '"':
        i += 1
        return basic(False)
    if s.startswith("'''", i):
        i += 3
        return literal(True)
    if at() == "'":
        i += 1
        return literal(False)
    if at() in "[{":
        close = "]" if at() == "[" else "}"
        out = [] if close == "]" else Inline()
        i += 1
        while True:
            blank()
            if at() == close:
                i += 1
                return out
            if close == "]":
                out.append(value(depth + 1))
            else:
                k = key()
                if at() != "=":
                    raise Bad("an inline table this check cannot read")
                i += 1
                ws()
                out.append((k, value(depth + 1)))
            blank()
            if at() == ",":
                i += 1
            elif at() != close:
                raise Bad("an array or inline table this check cannot read")
    m = SCALAR.match(s, i)
    if not m:
        raise Bad("a value this check cannot read")
    i = m.end()
    return {"true": True, "false": False}.get(m.group(0))       # a number or a date: None


def judge(full, v):
    if isinstance(v, Inline):
        for k, sub in v:
            judge(full + k, sub)
        return
    if full[:1] != ["ui"]:
        return
    if isinstance(v, list) and any(isinstance(x, (list, Inline)) for x in v):
        raise Bad("[ui] holds an array of tables or arrays, which this check does not read")
    if full == ["ui", "permission_mode"]:
        if not isinstance(v, str) or v not in MODES:
            no("[ui] permission_mode is %s, not one of grok's non-bypass modes (%s)"
               % (ascii(v)[:60], ", ".join(MODES)))
    elif full[:2] == ["ui", "permission_mode"] or full == ["ui"]:
        raise Bad("[ui] permission_mode written as a table")
    elif req and full == ["ui", "yolo"]:
        if v is not False:
            no("[ui] yolo is %s, which leaves always-approve on" % ascii(v)[:60])
    elif req and full[:2] == ["ui", "yolo"]:
        raise Bad("[ui] yolo written as a table")


table = []
try:
    while True:
        blank()
        if i >= n:
            break
        if s.startswith("[[", i):
            i += 2
            table = key()
            if not s.startswith("]]", i):
                raise Bad("a table header this check cannot read")
            i += 2
            eol()
            if table[:1] == ["ui"]:
                raise Bad("[ui] written as an array of tables")
        elif at() == "[":
            i += 1
            table = key()
            if at() != "]":
                raise Bad("a table header this check cannot read")
            i += 1
            eol()
            if table[:2] == ["ui", "permission_mode"] or (req and table[:2] == ["ui", "yolo"]):
                raise Bad("[ui] %s written as a table" % table[1])
        else:
            k = key()
            if at() != "=":
                raise Bad("a line that is neither a table header nor a key = value")
            i += 1
            ws()
            v = value()
            eol()
            judge(table + k, v)
except Bad as e:
    no("holds %s (near line %d), so it is refused rather than guessed" % (e, s.count("\n", 0, min(i, n)) + 1))
sys.exit(0)
PY
}

# A cursor worker's own CURSOR_CONFIG_DIR, read again right before it is handed on: just
# before the tab opens, and on --resume before anything is typed. Between the seed and the
# tab a still-running process of an earlier walled worker of the same name can rewrite the
# seed, add a hooks.json or an mcp.json, or swap the directory for a symlink
# (ISSUE(security-audit-2026-10-09-pin-the-cursor-worke-0a6d)). The directory is a fresh one
# per spawn, $HERD_DIR/.cursor-homes/<name>.<unique>, which no earlier spawn's wall opens
# (intake 20261009T173850Z). Prints why and returns 1 unless DIR is a real directory of the
# caller's (no symlink, not writable by others), spelled and resolved as exactly
# $HERD_DIR/.cursor-homes/<name>.<hex> under a real .cursor-homes. A fresh spawn's listing
# is exactly cli-config.json. A resume also allows the directory chats and the regular
# file statsig-cache.json, which cursor-agent writes after it starts, and nothing else.
# cli-config.json is a regular file of the caller's in allowlist mode with an empty
# permissions.allow.
cursor_home_verify() {
  # $2 is `resume` or omitted (`spawn`). A fresh spawn's directory holds only the seed.
  # A resume runs after cursor-agent has started, and that process writes `chats/` and
  # `statsig-cache.json` into its own CURSOR_CONFIG_DIR; those two names are the resume
  # allow, and anything else (hooks.json, mcp.json, a planted file) is still refused.
  python3 -I - "$1" "$herd_dir" "$name" "${2:-spawn}" <<'PY'
import json, os, re, stat, sys
d, herd, name, mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
def no(why):
    print(why); sys.exit(1)
homes = os.path.join(herd, ".cursor-homes")
base = os.path.basename(d)
if os.path.dirname(d) != homes or not re.fullmatch(re.escape(name) + r"\.[0-9a-f]{8,64}", base):
    no("is not this spawn's own $HERD_DIR/.cursor-homes/" + name + ".<unique>")
try:
    hst = os.lstat(homes)
except OSError:
    no("has no " + homes + " above it")
if (not stat.S_ISDIR(hst.st_mode) or hst.st_uid != os.getuid() or hst.st_mode & 0o022):
    no("lies under " + homes + ", which is a symlink, not the caller's or writable by others")
try:
    st = os.lstat(d)
except OSError:
    no("is missing")
if stat.S_ISLNK(st.st_mode):
    no("is a symlink, not a directory")
if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
    no("is not a directory owned by the caller")
if st.st_mode & 0o022:
    no("is writable by others")
real, want = os.path.realpath(d), os.path.join(os.path.realpath(homes), base)
if real != want:
    no("resolves to " + real + ", not " + want)
for extra in ("hooks.json", "mcp.json"):
    if os.path.lexists(os.path.join(d, extra)):
        no("holds a " + extra)
try:
    listing = sorted(os.listdir(d))
except OSError:
    no("cannot be listed")
# resume: cursor-agent's own runtime files, and only those, beside the seed
runtime = {"chats", "statsig-cache.json"} if mode == "resume" else set()
allowed = {"cli-config.json"} | runtime
stray = [x for x in listing if x not in allowed][:3]
if "cli-config.json" not in listing or stray or (mode != "resume" and listing != ["cli-config.json"]):
    no("holds more than cli-config.json (%d entries%s)" % (
        len(listing), (": " + ", ".join(ascii(x)[:60] for x in stray)) if stray else ""))
if mode == "resume" and "chats" in listing:
    cst = os.lstat(os.path.join(d, "chats"))
    if stat.S_ISLNK(cst.st_mode) or not stat.S_ISDIR(cst.st_mode):
        no("holds a chats that is not a directory")
if mode == "resume" and "statsig-cache.json" in listing:
    sst = os.lstat(os.path.join(d, "statsig-cache.json"))
    if stat.S_ISLNK(sst.st_mode) or not stat.S_ISREG(sst.st_mode):
        no("holds a statsig-cache.json that is not a regular file")
cfg = os.path.join(d, "cli-config.json")
try:
    fd = os.open(cfg, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
except OSError:
    no("has no cli-config.json that is a regular file (missing or a symlink)")
with os.fdopen(fd, "rb") as f:
    fst = os.fstat(f.fileno())
    if not stat.S_ISREG(fst.st_mode) or fst.st_uid != os.getuid():
        no("has a cli-config.json that is not a regular file of the caller's")
    try:
        data = json.loads(f.read().decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        no("has a cli-config.json that is not JSON")
if not isinstance(data, dict) or data.get("approvalMode") != "allowlist":
    no("has a cli-config.json not in allowlist mode")
perms = data.get("permissions", {})
allow = perms.get("allow", []) if isinstance(perms, dict) else None
if allow != []:
    no("has a cli-config.json whose permissions.allow is not empty")
sys.exit(0)
PY
}

# herdr_lists_elsewhere NAME PANE TAB: the places herdr lists NAME -- `agent list` by name,
# `tab list` by label, the rows key_guard reads -- other than pane PANE and tab TAB (empty
# for a fresh spawn: every place counts), one per line. Returns 1, printing why, when either
# listing does not answer: herdr not answering is not "that pane is gone".
herdr_lists_elsewhere() {
  [[ -n "${herdr:-}" ]] || find_herdr
  python3 -I - "$herdr" "$1" "$2" "$3" <<'PY'
import json, subprocess, sys
herdr, name, pane, tab = sys.argv[1:5]
found = []
for kind, field, idf, mine in (("agent", "name", "pane_id", pane), ("tab", "label", "tab_id", tab)):
    try:
        p = subprocess.run([herdr, kind, "list"], stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.SubprocessError) as e:
        print("'herdr %s list' did not run (%s)" % (kind, type(e).__name__)); sys.exit(1)
    if p.returncode != 0:
        print("'herdr %s list' exited %d" % (kind, p.returncode)); sys.exit(1)
    try:
        rows = json.loads(p.stdout.decode("utf-8", "replace")).get("result", {}).get(kind + "s")
    except (ValueError, AttributeError):
        rows = None
    if not isinstance(rows, list):
        print("'herdr %s list' printed no %ss" % (kind, kind)); sys.exit(1)
    for r in rows:
        if not isinstance(r, dict) or r.get(field) != name:
            continue
        where = r.get(idf)
        if mine and where == mine:
            continue
        found.append("%s %s" % ("pane" if kind == "agent" else "tab", where if isinstance(where, str) else "?"))
print("\n".join(found))
PY
}

# --- --resume <name>: a spawn that stopped at a first-run prompt, picked up -------------
# The spawn it picks up wrote brief.md, the .roles and .repos records, opened the tab and
# started the agent, which then sat on a first-run prompt; it wrote $HERD_DIR/.resume/<name>
# (the pane, the tab, the cwd, the harness, the model, the wall and the owner key) and
# printed this command. Same environment (HERD_DIR, the herdr on PATH), no brief argument:
# the brief is the brief.md that spawn rendered, never a new one. Nothing is written but
# the resume record's removal after the line is typed; the three files are left as they are.
#   * a name that is not a worker name is exit 2 before herdr is asked anything;
#   * no resume record (never spawned, or already delivered) is exit 2, nothing invented;
#   * a brief.md that is not a regular file of the caller's (a symlink planted after the
#     stop) is exit 2: the line would tell the worker to read whatever it points at;
#   * a pane still on a first-run prompt is exit 1 and nothing is typed (a line typed
#     into a dialog could answer it);
#   * only a delivered line prints worker=.
if [[ "${1:-}" == "--resume" ]]; then
  resuming=yes
  if [[ $# -ne 2 ]]; then
    echo "usage: herd-spawn.sh --resume <name>   (a spawn that stopped at a first-run prompt; same HERD_DIR as that spawn)" >&2
    exit 2
  fi
  name="$2"
  case "$name" in
    ''|*[!a-z0-9_-]*|[!a-z]*)
      echo "herd-spawn: --resume takes a worker name, [a-z][a-z0-9_-]* (herdr's agent-name rule); nothing was resumed" >&2
      exit 2
      ;;
  esac
  if [[ ${#name} -gt 32 ]]; then
    echo "herd-spawn: --resume takes a worker name of at most 32 characters (herdr's agent-name rule); nothing was resumed" >&2
    exit 2
  fi
  herd_dir="$(iso_herd_dir)" || {
    echo "herd-spawn: neither HERD_DIR nor HOME is set, so there is no herd directory; nothing was resumed for ${name}" >&2
    exit 2
  }
  [[ "$herd_dir" == /* ]] || herd_dir="$(pwd)/${herd_dir}"
  resume_rec="$herd_dir/.resume/${name}"
  bfile="$herd_dir/${name}/brief.md"
  report="$herd_dir/${name}/report.md"
  repo_record="$herd_dir/.repos/${name}"
  if [[ ! -d "$herd_dir" || ! -O "$herd_dir" ]] || ! iso_private_path "$herd_dir" >/dev/null ||
     [[ -L "$herd_dir/.resume" || -L "$herd_dir/${name}" || -L "$herd_dir/.repos" ]]; then
    echo "herd-spawn: ${herd_dir} (HERD_DIR) is missing, not ${USER:-the caller}'s own, writable by others, or holds a symlink where ${name}'s records live; nothing was resumed for ${name}" >&2
    exit 2
  fi
  if [[ -L "$resume_rec" || ! -f "$resume_rec" || ! -O "$resume_rec" ]]; then
    echo "herd-spawn: nothing to resume for ${name}: no spawn of that name stopped at a first-run prompt under ${herd_dir} (no resume record, or it was delivered already); spawn it with its brief instead" >&2
    exit 2
  fi
  if [[ -L "$bfile" || ! -f "$bfile" || ! -O "$bfile" ]]; then
    echo "herd-spawn: ${bfile} is missing, a symlink or not a regular file of $(id -un)'s; the resumed line would tell ${name} to read it, so it is never followed; spawn ${name} again with its brief; nothing was resumed" >&2
    exit 2
  fi
  if [[ -L "$repo_record" || ! -f "$repo_record" ]]; then
    echo "herd-spawn: ${repo_record} is missing or a symlink, so ${name}'s report could never be verified; spawn ${name} again with its brief; nothing was resumed" >&2
    exit 2
  fi
  pane="" tab_id="" cwd="" harness="" model="" wall_state="" pair_key="" profile=""
  while IFS= read -r rline || [[ -n "$rline" ]]; do
    case "$rline" in
      pane=*) pane="${rline#pane=}" ;;
      tab=*) tab_id="${rline#tab=}" ;;
      cwd=*) cwd="${rline#cwd=}" ;;
      harness=*) harness="${rline#harness=}" ;;
      model=*) model="${rline#model=}" ;;
      wall=*) wall_state="${rline#wall=}" ;;
      pair_key=*) pair_key="${rline#pair_key=}" ;;
      profile=*) profile="${rline#profile=}" ;;
    esac
  done < "$resume_rec"
  # The profile the spawn recorded, never one read off the directory shape under
  # $HERD_DIR/<name>, which that pane's wall can rewrite (intake 20261009T173857Z). A record
  # with none, or one this script does not know, is refused, not guessed.
  case "$profile" in
    worker|reviewer|coordinator|release) ;;
    *)
      echo "herd-spawn: the resume record ${resume_rec} names no known profile (worker, reviewer, coordinator or release), so whether ${name} is a worker cannot be told; nothing was typed into ${name}'s pane and the record is kept: spawn ${name} again with its brief" >&2
      exit 2
      ;;
  esac
  case "$harness" in
    claude|cursor|codex|grok) ;;
    *) harness="" ;;
  esac
  if [[ -z "$pane" || -z "$tab_id" || -z "$harness" || -z "$wall_state" || ! -d "$cwd" ]]; then
    echo "herd-spawn: the resume record ${resume_rec} is incomplete (pane, tab, harness, wall or cwd); spawn ${name} again with its brief; nothing was resumed" >&2
    exit 2
  fi
  if [[ "$harness" == "cursor" ]] && ! why="$(user_cursor_cfg_armed)"; then
    echo "herd-spawn: ${HOME:-}/.cursor/cli-config.json: ${why}; nothing was typed into ${name}'s pane and the resume record ${resume_rec} is kept: empty that permissions.allow, then run this resume again" >&2
    exit 2
  fi
  # A cursor worker's pane reads its per-spawn $HERD_DIR/.cursor-homes/<name>.<unique> (its
  # CURSOR_CONFIG_DIR) when the line lands: read it again now, before anything is typed. The
  # spawn named that directory in $HERD_DIR/.cursor-homes/<name>, which no wall opens. A
  # cursor coordinator's pane has its cursor-config instead; the recorded profile says which.
  cursor_home=""
  cursor_ptr="$herd_dir/.cursor-homes/${name}"
  if [[ "$harness" == "cursor" && "$profile" != "coordinator" ]]; then
    if [[ ! -L "$herd_dir/.cursor-homes" && ! -L "$cursor_ptr" && -f "$cursor_ptr" && -O "$cursor_ptr" ]]; then
      IFS= read -r cursor_home < "$cursor_ptr" || true
    fi
    case "$cursor_home" in
      "$herd_dir/.cursor-homes/${name}."*) ;;
      *)
        echo "herd-spawn: ${cursor_ptr} does not name ${name}'s own CURSOR_CONFIG_DIR (missing, a symlink, not the caller's, or naming another place); nothing was typed into ${name}'s pane and the resume record ${resume_rec} is kept: close that tab and spawn ${name} again with its brief" >&2
        exit 2
        ;;
    esac
  fi
  if [[ -n "$cursor_home" ]] && ! why="$(cursor_home_verify "$cursor_home" resume)"; then
    echo "herd-spawn: ${cursor_home} (${name}'s CURSOR_CONFIG_DIR) ${why}; it is never followed or repaired; nothing was typed into ${name}'s pane and the resume record ${resume_rec} is kept: close that tab and spawn ${name} again with its brief" >&2
    exit 2
  fi
  find_herdr
  # One pane per name: the pane this record names is the one resumed; ${name} listed at any
  # other pane or tab is an earlier worker of that name, perhaps still writing under
  # $HERD_DIR/<name>, and a listing that does not answer is no proof it is gone.
  if [[ "$harness" == "cursor" ]]; then
    if ! elsewhere="$(herdr_lists_elsewhere "$name" "$pane" "$tab_id")"; then
      echo "herd-spawn: herdr's listing did not answer (${elsewhere:-no reason}), so whether another pane named ${name} is still live cannot be told; nothing was typed into ${name}'s pane and the resume record ${resume_rec} is kept" >&2
      exit 2
    fi
    if [[ -n "$elsewhere" ]]; then
      echo "herd-spawn: herdr still lists ${name} at $(printf '%s' "$elsewhere" | tr '\n' ',' | sed 's/,$//; s/,/, /g') besides the recorded pane ${pane}, tab ${tab_id}; nothing was typed into ${name}'s pane and the resume record ${resume_rec} is kept: close the other tab, then run this resume again" >&2
      exit 2
    fi
  fi
  prompt_line="$(first_line_for "$harness" "$bfile" "$report")"
  done_steps="brief.md kept (${bfile}), tab kept (pane ${pane}, tab ${tab_id}), resume started"
  if stuck_on="$(first_run_prompt)"; then
    echo "herd-spawn: ${name} is still on Claude Code's first-run prompt (${stuck_on}) in pane ${pane}, tab ${tab_id}; nothing was typed into it; answer it in the pane and run this resume again -- brief.md and its records are kept" >&2
    exit 1
  fi
  deliver_brief
  rm -f "$resume_rec"
  exit 0
fi

# --render: the spawn below, run with herdr left out (the header says what it writes and
# what it holds). Every herdr step is skipped where it stands, so the files it writes are
# written by the same code as a spawn's, never by a copy of it.
render=no
if [[ "${1:-}" == "--render" ]]; then
  render=yes
  shift
fi

name="${1:-}"
brief="${2:-}"
[[ -n "$name" && -n "$brief" ]] || usage
# A cross-harness failover re-execs this script. The parser below consumes $@,
# so the original argv is kept here for that exec.
failover_argv=("$@")
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
# $HERD_DIR/<name> is on the worker's allow-write line, and the default HERD_DIR holds the
# landing gate's slot directory (tools/gate_slots.py): a worker by that name would be
# handed the machine-wide semaphore every gate waits on; and it holds the gate-scratch root
# (lib.sh's iso_gate_scratch_root), where a landing builds BASE's lint and invariant copies
if [[ "$name" == "gate-slots" ]]; then
  echo "herd-spawn: the worker name gate-slots is reserved (it names the landing gate's slot directory); nothing was started" >&2
  exit 2
fi
if [[ "$name" == "gate-scratch" ]]; then
  echo "herd-spawn: the worker name gate-scratch is reserved (it names the landing gate's scratch directory); nothing was started" >&2
  exit 2
fi
if [[ ! -f "$brief" ]]; then
  echo "herd-spawn: no brief at ${brief}" >&2
  exit 2
fi
# ... and one this spawn can read: an unreadable template used to reach the render below and
# end there in a Python traceback, after herdr had been asked for its status
if [[ ! -r "$brief" ]]; then
  echo "herd-spawn: the brief ${brief} is not readable; the worker ${name} was not started" >&2
  exit 2
fi

cwd=""
profile="worker"
envs=()
vars=()
extra_allow=()
muretai_agent=""
role=""
cwd_given=no
open_title=""
open_given=no
open_repo=""
repo_given=no
open_base=""
base_given=no
p0=no
lane=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd) [[ $# -ge 2 ]] || usage; cwd="$2"; cwd_given=yes; shift 2 ;;
    # A priority-0 spawn. The capacity check below never holds one. No value.
    --p0) p0=yes; shift ;;
    --lane)
      [[ $# -ge 2 ]] || usage
      if [[ "$2" != "fast" ]]; then
        echo "herd-spawn: --lane is fast or absent (got a value that is neither); the worker ${name} was not started" >&2
        exit 2
      fi
      lane="fast"; shift 2 ;;
    --open-worktree) [[ $# -ge 2 ]] || usage; open_title="$2"; open_given=yes; shift 2 ;;
    --repo) [[ $# -ge 2 ]] || usage; open_repo="$2"; repo_given=yes; shift 2 ;;
    --base) [[ $# -ge 2 ]] || usage; open_base="$2"; base_given=yes; shift 2 ;;
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
        CODEX_HOME|CURSOR_CONFIG_DIR|GROK_HOME|PYTHONNOUSERSITE|CLAUDE_CODE_DISABLE_AUTO_MEMORY|HERD_WORKER|HERD_BRIEF|HERD_REPORT|ISOLATED_SESSION_GUARD_TRACE|MURETAI_HERDR_AGENT|HERD_WALL_INSIDE|CLAUDE_CODE_OAUTH_TOKEN)
          echo "herd-spawn: --env ${2%%=*}=... is refused: the spawn sets that key on the tab itself and the caller's entries are appended after its own, so which value the tab got would be herdr's dedup order to decide; the worker ${name} was not started" >&2
          exit 2
          ;;
        # The wall and the bounds ride on the tab's PATH: its first entry is the launcher
        # directory under $HERD_DIR/walls/<name>/bin (see the wall block below). A caller
        # PATH would decide, by herdr's dedup order, whether the agent starts behind them.
        PATH)
          echo "herd-spawn: --env PATH=... is refused: the tab's PATH carries the launcher that starts the agent behind the wall and under the bounds, so a caller PATH could start it outside them; the worker ${name} was not started" >&2
          exit 2
          ;;
        # The wall's knobs are read by THIS spawn, not by the tab: `--env HERD_WALL=off` is
        # how a coordinator (whose rules allow this script's argv, not an env prefix) spells
        # them. Set here, validated below like the environment's own, never put on the tab --
        # where it would only have unwalled the spawns the worker itself starts.
        HERD_WALL|HERD_WALL_EGRESS|HERD_WALL_CPU_SECS|HERD_WALL_MEM_MB|HERD_WALL_PROCS)
          export "$2"; shift 2; continue ;;
      esac
      envs+=("$2"); shift 2 ;;
    --var) [[ $# -ge 2 ]] || usage; vars+=("$2"); shift 2 ;;
    --allow) [[ $# -ge 2 ]] || usage; extra_allow+=("$2"); shift 2 ;;
    --muretai-agent) [[ $# -ge 2 ]] || usage; muretai_agent="$2"; shift 2 ;;
    --role)
      [[ $# -ge 2 ]] || usage
      if [[ "$2" != "solo" ]]; then
        echo "herd-spawn: --role is solo or absent (got a value that is neither); the worker ${name} was not started" >&2
        exit 2
      fi
      role="$2"; shift 2 ;;
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
  worker|reviewer|weekly|coordinator|release) ;;
  *) echo "herd-spawn: --profile is worker, reviewer, weekly, coordinator or release (got '${profile}'); the worker ${name} was not started" >&2; exit 2 ;;
esac
# The weekly hunt is a reviewer from here on -- every reviewer rule, deny and refusal below
# reads `reviewer` -- and keeps its own name only for the spawn record and its one extra
# allow rule (THE WEEKLY HUNT'S RECEIPT, after the reviewer's allow list).
profile_said="$profile"
weekly_hunt="no"
if [[ "$profile" == "weekly" ]]; then
  weekly_hunt="yes"
  profile="reviewer"
fi
# The release solo writes two files and one tag and nothing else; a brief's own Bash rule
# could write anything, so the profile takes none
if [[ "$profile" == "release" && ${#extra_allow[@]} -gt 0 ]]; then
  echo "herd-spawn: --allow is refused for the release profile: a release solo writes VERSION, CHANGELOG.md and the tag and nothing else, so no rule is added to it; the worker ${name} was not started" >&2
  exit 2
fi
# A coordinator pane carries DISABLE_AUTOUPDATER=1 (set on the tab below), so a caller's
# `--env DISABLE_AUTOUPDATER=...` is refused for that profile rather than left to herdr's
# dedup order: a silent override would hide the mistake. Judged after the loop because
# --profile may follow --env on the line.
if [[ "$profile" == "coordinator" ]]; then
  for kv in ${envs[@]+"${envs[@]}"}; do
    if [[ "${kv%%=*}" == "DISABLE_AUTOUPDATER" ]]; then
      echo "herd-spawn: --env DISABLE_AUTOUPDATER=... is refused for the coordinator profile: the spawn sets DISABLE_AUTOUPDATER=1 on that tab itself, so an in-pane update cannot end the coordinator mid-loop; the worker ${name} was not started" >&2
      exit 2
    fi
  done
fi
# a solo worker lands its own work, which is what the worker profile is for; a reviewer or
# a coordinator declared solo would be verified as a landing it never makes
if [[ -n "$role" && "$profile" != "worker" ]]; then
  echo "herd-spawn: --role solo goes with the worker profile only (got '${profile}'); the worker ${name} was not started" >&2
  exit 2
fi
# --open-worktree: judged here, before herdr is asked anything and before the worktree is
# opened (which happens where the tab's directory is resolved, below). It opens a worker's
# OWN worktree, so it goes with the worker profile; it needs the caller's stable key, or a
# re-run could not find its own lock; and it is the only answer to "where", so a --cwd or a
# caller's WORKTREE/BRANCH/PRIMARY beside it is refused rather than silently outvoted.
# A reviewer's --open-worktree is the one exception: with --base it opens the reviewer's own
# checkout at that commit, under $HERD_DIR/review/<name> (the header says why); --base goes
# with nothing else.
open_key=""
if [[ "$base_given" == "yes" && ( "$profile" != "reviewer" || "$open_given" != "yes" ) ]]; then
  echo "herd-spawn: --base goes with --profile reviewer and --open-worktree only (got profile '${profile}'$([[ "$open_given" == "yes" ]] || echo ', no --open-worktree')); the worker ${name} was not started" >&2
  exit 2
fi
if [[ "$open_given" == "yes" ]]; then
  if [[ -z "$open_title" ]]; then
    echo "herd-spawn: --open-worktree needs a title (the task, as ensure-worktree.sh takes it); the worker ${name} was not started" >&2
    exit 2
  fi
  if [[ "$profile" == "reviewer" && "$base_given" != "yes" ]]; then
    echo "herd-spawn: a reviewer's --open-worktree needs --base <rev>: the commit its review checkout opens at; the worker ${name} was not started" >&2
    exit 2
  fi
  if [[ "$profile" != "worker" && "$profile" != "reviewer" ]]; then
    echo "herd-spawn: --open-worktree goes with the worker profile, or the reviewer profile with --base (got '${profile}'); the worker ${name} was not started" >&2
    exit 2
  fi
  if [[ "$cwd_given" == "yes" ]]; then
    echo "herd-spawn: --open-worktree and --cwd both say where the worker opens; pass one; the worker ${name} was not started" >&2
    exit 2
  fi
  for kv in ${vars[@]+"${vars[@]}"}; do
    case "${kv%%=*}" in
      WORKTREE|BRANCH|PRIMARY)
        echo "herd-spawn: --var ${kv%%=*}=... is refused with --open-worktree: the spawn fills it from the worktree it opens; the worker ${name} was not started" >&2
        exit 2
        ;;
    esac
  done
  for kv in ${envs[@]+"${envs[@]}"}; do
    if [[ "${kv%%=*}" == "ISOLATED_SESSION_OWNER" ]]; then
      open_key="${kv#*=}"
    fi
  done
  if [[ -z "$open_key" ]]; then
    echo "herd-spawn: --open-worktree needs --env ISOLATED_SESSION_OWNER=<harness>:<worker>: the worktree is opened under that key and handed to the worker by it, and a re-run finds its own lock only under the same key; the worker ${name} was not started" >&2
    exit 2
  fi
fi

# 0 when the repository $1 (a primary checkout) is itself a path listed in the operator's
# $HOME/.muretai/dispatch/repos, dispatch-init.sh's `<name>=<absolute path>` lines. Read the
# way the other dispatch readers read it (finish-worktree.sh): a regular file and not a
# symlink, blank and `#` lines skipped. Stricter here, because the answer is a trust
# decision: the listed path must BE the repository (both resolved), never a directory
# holding it (a parent, HOME, `/`) or a sibling sharing its prefix; a line carrying `*` is
# skipped whole; a relative path counts for nothing. HOME only -- DISPATCH_DIR is not
# read, so no variable can point the check at a list the operator did not write.
# Defined here, before herdr is asked anything, because --repo is judged against it; the
# trust seam below asks it again.
dispatch_listed() {
  local want="$1" repos line pth got
  [[ -n "${HOME:-}" && "$want" == /* ]] || return 1
  repos="${HOME}/.muretai/dispatch/repos"
  [[ -f "$repos" && ! -L "$repos" && -O "$repos" ]] || return 1
  want="$(cd "$want" 2>/dev/null && pwd -P)" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      ''|\#*|*'*'*) continue ;;
    esac
    [[ "$line" == *=* ]] || continue
    pth="${line#*=}"
    case "$pth" in
      "~/"*) pth="${HOME}/${pth#\~/}" ;;
    esac
    [[ "$pth" == /* && -d "$pth" ]] || continue
    got="$(cd "$pth" 2>/dev/null && pwd -P)" || continue
    if [[ "$got" == "$want" ]]; then
      return 0
    fi
  done < "$repos"
  return 1
}

# --repo <primary>: which repository --open-worktree opens the worktree in, for a caller
# (the coordinator seat) that cannot `cd` there first. Judged here, before herdr is asked
# anything and before any worktree or branch exists. It goes with --open-worktree only.
# The value is resolved to a canonical absolute path (a relative one from the caller's
# directory; symlinks and a trailing slash fall away) and must be a repository's PRIMARY
# checkout -- its top level, not a linked worktree or a subdirectory -- listed in the
# operator's $HOME/.muretai/dispatch/repos (dispatch_listed). Anything else is refused the
# same way as an unlisted path. The worktree is opened by THAT repository's own
# ensure-worktree.sh, never this one's run against it; a repository without one is refused.
open_repo_primary=""
if [[ "$repo_given" == "yes" ]]; then
  if [[ "$open_given" != "yes" ]]; then
    echo "herd-spawn: --repo goes with --open-worktree only (it names the repository the worktree opens in); the worker ${name} was not started" >&2
    exit 2
  fi
  repo_real=""
  if [[ -n "$open_repo" && -d "$open_repo" ]]; then
    repo_real="$(cd "$open_repo" 2>/dev/null && pwd -P)" || repo_real=""
  fi
  repo_top=""
  if [[ -n "$repo_real" ]]; then
    repo_top="$(iso_primary_of "$repo_real" 2>/dev/null)" || repo_top=""
    [[ -z "$repo_top" ]] || repo_top="$(cd "$repo_top" 2>/dev/null && pwd -P)" || repo_top=""
  fi
  if [[ -z "$repo_real" || "$repo_top" != "$repo_real" || ! -d "$repo_real/.git" ]] \
     || ! dispatch_listed "$repo_real"; then
    echo "herd-spawn: --repo $(iso_safe_text "$open_repo" || echo '?') is not a primary checkout listed in the dispatch repos (\$HOME/.muretai/dispatch/repos); the worker ${name} was not started" >&2
    exit 2
  fi
  repo_ensure="$repo_real/.cursor/skills/isolated-session/scripts/ensure-worktree.sh"
  if [[ ! -f "$repo_ensure" || -L "$repo_ensure" ]]; then
    echo "herd-spawn: --repo ${repo_real} has no ensure-worktree.sh of its own (${repo_ensure}); this script's copy is never run against another repository; the worker ${name} was not started" >&2
    exit 2
  fi
  open_repo_primary="$repo_real"
fi

# --base <rev>: resolved here to one commit, before herdr is asked anything and before any
# worktree or branch exists, in the primary the worktree opens from. Only `rev-parse
# --verify --quiet --end-of-options "<rev>^{commit}"` reads it -- one argument, never an
# option, never evaluated -- and only the full sha it prints goes on to the open.
open_base_sha=""
if [[ "$base_given" == "yes" ]]; then
  if [[ -n "$open_repo_primary" ]]; then
    base_repo="$open_repo_primary"
  else
    base_repo="$(iso_primary_of "$here" 2>/dev/null)" || base_repo=""
  fi
  if [[ -n "$open_base" && -n "$base_repo" ]]; then
    open_base_sha="$(git -C "$base_repo" rev-parse --verify --quiet --end-of-options "${open_base}^{commit}" 2>/dev/null)" || open_base_sha=""
  fi
  case "$open_base_sha" in
    *[!0-9a-f]*|'') open_base_sha="" ;;
  esac
  if [[ -z "$open_base_sha" ]]; then
    echo "herd-spawn: --base $(iso_safe_text "$open_base" || echo '?') is not a commit in ${base_repo:-this repository}; the worker ${name} was not started" >&2
    exit 2
  fi
fi

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
# Kept across a cross-harness re-exec. The unsets below stop a worker's own
# spawn from inheriting the caller's knobs; the re-exec is still this spawn.
failover_perm_saved=no
failover_perm_value=""
if [[ -n "${HERD_SPAWN_PERMISSION_MODE+set}" ]]; then
  failover_perm_saved=yes
  failover_perm_value="$HERD_SPAWN_PERMISSION_MODE"
fi
failover_codex_home_saved=no
failover_codex_home_value=""
if [[ -n "${CODEX_HOME+set}" ]]; then
  failover_codex_home_saved=yes
  failover_codex_home_value="$CODEX_HOME"
fi
unset HERD_SPAWN_PERMISSION_MODE
# The model: `opus` unless HERD_SPAWN_MODEL says otherwise (a model alias or id, one
# token of letters, digits, dots and dashes). A reviewer reads a diff for twenty to
# forty minutes; on the owner's subscription that is the cost that matters, and the
# top-tier model is not what the reading needs. Dropped from this process like the
# mode, so a worker's own spawns start from the default again.
# The harness: `claude` (Claude Code), `cursor` (Cursor's CLI agent, `cursor-agent`),
# `codex` (codex-cli) or `grok` (Grok Build), HERD_SPAWN_HARNESS. herdr drives any of them
# in a pane; the brief, the report directory and the receipt tools are the same. Cursor
# reads its rules from `<cwd>/.cursor/cli.json` (written below from the same allow/deny
# lists) and runs in its classifier mode (`--auto-review`); the isolated-session hook
# speaks its dialect already. Another model's eyes on a diff see other things; the cost
# lands on the other plan.
#
# Codex is different in kind and the top-of-file header says how: no per-command rules,
# so the sandbox and the approval policy are the whole wall, `worker` is the only profile,
# and the config home is the spawn's. Grok's wall is one `--allow` per allow rule and one
# `--deny` per deny rule on the grok argv; the header says the rest.
#
# THE MACHINE FILE'S ORDER. The one per-Mac file, `$APPL_MACHINE_CONFIG` (default
# `$HOME/.config/appl/machine.toml`, TOML), may carry an ordered list of harnesses per
# profile, each entry a table with `harness` and `model`:
#
#     [[harness.order.worker]]
#     harness = "claude"
#     model = "opus"
#
# The worker, coordinator and reviewer profiles take the FIRST entry of their own list.
# HERD_SPAWN_HARNESS, when set, beats the entry's harness, and
# HERD_SPAWN_MODEL the entry's model; each override wins its own field. The entry's model
# is used only while the harness is the entry's own: a model named for cursor means
# nothing to claude. No file, or a file with no `[harness.order]` at all, is the spawn as
# before (claude, opus). A `[harness.order]` whose list for this profile is missing, empty,
# or opens with an entry that is not a table, has no known harness or no model, is refused
# here, before herdr is asked anything. A later entry is used only when the one in the pane
# fails to start: the spawn fails over onto it, under that entry's daily cap, counted in
# $HERD_DIR/.failover/$HERD_SPAWN_TODAY (YYYY-MM-DD; the unix clock is not the day). A
# harness set with HERD_SPAWN_HARNESS does not walk the list.
# machine.example.toml beside this script is the shape. The reader is a stdlib TOML subset
# (Python 3.9 has no tomllib): headers, `key = value` with a one-line string, integer,
# boolean or one-line array of those; the `harness` tables and the `[capacity]` table
# are read, and every other section is skipped unread. `[capacity]` carries
# `spawn_floor` and `p0_floor`, each an integer 0..100. A spawn with no `[capacity]`
# table, or no machine file, is today's spawn: the memory level is not read.
order_read() {
  python3 -I - "$1" "$2" "$name" <<'PY'
import os, re, sys

path, profile, worker = sys.argv[1], sys.argv[2], sys.argv[3]
HARNESSES = ("claude", "cursor", "codex", "grok")
MODEL = re.compile(r"^[a-z][a-z0-9.=,\[\]-]{0,79}\Z")
KEY = re.compile(r"^[A-Za-z0-9_-]+\Z")
SCALAR = re.compile(r"true\b|false\b|[+-]?[0-9][0-9_]*")


class Refused(Exception):
    pass


class CapacityRefused(Exception):
    pass


def refuse(why):
    raise Refused(why)


def scalar(s, i, where):
    c = s[i]
    if c == "\"":
        j = i + 1
        while s[j] != "\"":
            if s[j] == "\\":
                refuse("%s: escapes in strings are not read" % where)
            j += 1
        return s[i + 1:j], j + 1
    if c == "'":
        j = s.index("'", i + 1)
        return s[i + 1:j], j + 1
    m = SCALAR.match(s, i)
    if not m:
        refuse("%s: a value this reader does not read: %r" % (where, s[i:]))
    w = m.group(0)
    return (w == "true") if w in ("true", "false") else int(w.replace("_", "")), m.end()


def value(s, where):
    s = s.strip()
    try:
        if s.startswith("["):
            items, i = [], 1
            while True:
                while s[i] in " \t":
                    i += 1
                if s[i] == "]":
                    i += 1
                    break
                v, i = scalar(s, i, where)
                items.append(v)
                while s[i] in " \t":
                    i += 1
                if s[i] == ",":
                    i += 1
                elif s[i] == "]":
                    i += 1
                    break
                else:
                    refuse("%s: expected , or ] in the array" % where)
            v = items
        else:
            v, i = scalar(s, 0, where)
    except (IndexError, ValueError):
        refuse("%s: an unterminated or multi-line value is not read" % where)
    rest = s[i:].strip()
    if rest and not rest.startswith("#"):
        refuse("%s: unexpected text after the value: %r" % (where, rest))
    return v


def header(line, where):
    double = line.startswith("[[")
    close = "]]" if double else "]"
    end = line.find(close)
    if end < 0:
        refuse("%s: unterminated table header" % where)
    rest = line[end + len(close):].strip()
    if rest and not rest.startswith("#"):
        refuse("%s: unexpected text after the table header" % where)
    parts = [p.strip() for p in line[len(close):end].split(".")]
    if not all(KEY.match(p) for p in parts):
        refuse("%s: a table name this reader does not read" % where)
    return double, parts


def parse(text):
    root, arrays, defined = {}, set(), set()
    cur = None
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        where = "line %d" % n
        if line.startswith("["):
            inner = line[2:] if line.startswith("[[") else line[1:]
            section = inner.split("]", 1)[0].split(".")[0].strip()
            if section not in ("harness", "capacity"):
                cur = None
                continue
            double, parts = header(line, where)
            node = root
            for p in parts[:-1]:
                node = node.setdefault(p, {})
                if isinstance(node, list) and id(node) in arrays:
                    node = node[-1]
                if not isinstance(node, dict):
                    refuse("%s: %s is not a table" % (where, ".".join(parts)))
            last = parts[-1]
            if double:
                lst = node.setdefault(last, [])
                if not isinstance(lst, list) or (lst and id(lst) not in arrays):
                    refuse("%s: %s is given twice" % (where, ".".join(parts)))
                arrays.add(id(lst))
                cur = {}
                lst.append(cur)
            else:
                name = ".".join(parts)
                if name in defined:
                    refuse("%s: [%s] is given twice" % (where, name))
                defined.add(name)
                cur = node.setdefault(last, {})
                if not isinstance(cur, dict):
                    refuse("%s: %s is given twice" % (where, name))
            continue
        if cur is None:
            continue
        key, eq, rest = line.partition("=")
        key = key.strip()
        if not eq or not KEY.match(key):
            refuse("%s: expected key = value" % where)
        if key in cur:
            refuse("%s: %s is given twice" % (where, key))
        cur[key] = value(rest, where)
    return root


def load():
    if not os.path.lexists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except (OSError, UnicodeDecodeError) as e:
        refuse("the file cannot be read (%s)" % e.__class__.__name__)
    return parse(text)


def capacity_floors(root):
    # [capacity] is optional. Absent means today's spawn. Present means both floors
    # are integers 0..100. bool is a subclass of int; type() keeps it out.
    if not root or "capacity" not in root:
        return None
    cap = root["capacity"]
    if type(cap) is not dict:
        raise CapacityRefused("capacity is not a table")
    sf = cap.get("spawn_floor")
    pf = cap.get("p0_floor")
    if type(sf) is not int or sf < 0 or sf > 100:
        raise CapacityRefused("spawn_floor must be an integer from 0 to 100")
    if type(pf) is not int or pf < 0 or pf > 100:
        raise CapacityRefused("p0_floor must be an integer from 0 to 100")
    return sf, pf


def pick(root):
    # worker, coordinator and reviewer each read their own list. weekly has already
    # been rewritten to reviewer. release reads none.
    if profile not in ("worker", "coordinator", "reviewer") or not root:
        return None
    harness = root.get("harness")
    if harness is None:
        return None
    if not isinstance(harness, dict):
        refuse("harness is not a table")
    if "order" not in harness:
        return None
    order = harness["order"]
    if not isinstance(order, dict):
        refuse("harness.order is not a table of per-profile lists")
    if profile not in order:
        refuse("harness.order has no %s list" % profile)
    lst = order[profile]
    if not isinstance(lst, list):
        refuse("harness.order.%s is not a list" % profile)
    if not lst:
        refuse("harness.order.%s is empty" % profile)
    entry = lst[0]
    if not isinstance(entry, dict):
        refuse("the first harness.order.%s entry is not a table with harness and model" % profile)
    h = entry.get("harness")
    if h not in HARNESSES:
        refuse("the first harness.order.%s entry names no known harness (one of %s)"
               % (profile, ", ".join(HARNESSES)))
    m = entry.get("model")
    if not isinstance(m, str) or not MODEL.match(m):
        refuse("the first harness.order.%s entry has no model alias or id" % profile)
    if h == "codex" and ("[" in m or "]" in m):
        refuse("the first harness.order.%s entry gives codex a bracketed model" % profile)
    return h, m


def entry_cap(entry):
    # Missing is "-". An integer is its digits, zero and negative included. Anything
    # else (a word, a bool) is "?", which allows no failover.
    cap = entry.get("cap", None)
    if cap is None:
        return "-"
    if type(cap) is int:
        return str(cap)
    return "?"


def list_entries(root):
    # Every usable entry, in order. The first was already refused by pick() when it
    # is bad. A later entry that is not a harness and a model ends the list there.
    harness = root.get("harness") if root else None
    if not isinstance(harness, dict):
        return []
    order = harness.get("order")
    if not isinstance(order, dict):
        return []
    lst = order.get(profile)
    if not isinstance(lst, list):
        return []
    out = []
    for entry in lst:
        if not isinstance(entry, dict):
            break
        h = entry.get("harness")
        m = entry.get("model")
        if h not in HARNESSES or not isinstance(m, str) or not MODEL.match(m):
            break
        if h == "codex" and ("[" in m or "]" in m):
            break
        out.append((h, m, entry_cap(entry)))
    return out


try:
    root = load()
    floors = capacity_floors(root)
    got = pick(root)
except CapacityRefused as e:
    sys.stderr.write("herd-spawn: capacity in %s is refused: %s;"
                     " the worker %s was not started\n" % (path, e, worker))
    sys.exit(4)
except Refused as e:
    sys.stderr.write("herd-spawn: harness.order for the %s profile in %s is refused: %s;"
                     " the worker %s was not started\n" % (profile, path, e, worker))
    sys.exit(3)
if got:
    sys.stdout.write("order %s %s\n" % got)
# Every entry, including when pick() takes none (release reads no harness to start on,
# and still has to refuse a later entry that the first entry's checks would refuse).
if root:
    for h, m, cap_s in list_entries(root):
        sys.stdout.write("entry %s %s %s\n" % (h, m, cap_s))
if floors:
    sys.stdout.write("capacity %d %d\n" % floors)
PY
}

# The memory level, read only when [capacity] is present and this spawn is not --p0.
# Darwin: APPL_CAPACITY_SYSCTL_BIN -n kern.memorystatus_level, one bare integer.
# Linux: floor(MemAvailable * 100 / MemTotal) from APPL_CAPACITY_MEMINFO_PATH, two
# integers and nothing else. A value that is not that, or a reader that fails, is
# unreadable: the caller prints a capacity: line and never the text that was read.
# The Darwin path does not open the meminfo seam. The Linux path does not run sysctl.
capacity_level() {
  local platform bin mem out rc
  platform="${APPL_CAPACITY_PLATFORM-}"
  if [[ -z "$platform" ]]; then
    platform="$(uname -s)"
  fi
  case "$platform" in
    Darwin)
      bin="${APPL_CAPACITY_SYSCTL_BIN:-sysctl}"
      rc=0
      out="$("$bin" -n kern.memorystatus_level 2>/dev/null)" || rc=$?
      [[ "$rc" -eq 0 ]] || return 1
      case "$out" in
        ""|*[!0-9]*) return 1 ;;
      esac
      printf '%s\n' "$out"
      ;;
    Linux)
      mem="${APPL_CAPACITY_MEMINFO_PATH:-/proc/meminfo}"
      rc=0
      out="$(python3 -I - "$mem" 2>/dev/null <<'PY'
import re, sys
path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
except (OSError, UnicodeError):
    sys.exit(1)
total = avail = None
pat = re.compile(r"(MemTotal|MemAvailable):[ \t]+([0-9]+)[ \t]+kB\Z")
for raw in text.splitlines():
    m = pat.match(raw.strip())
    if not m:
        continue
    n = int(m.group(2))
    if m.group(1) == "MemTotal" and total is None:
        total = n
    elif m.group(1) == "MemAvailable" and avail is None:
        avail = n
if total is None or avail is None or total <= 0:
    sys.exit(1)
sys.stdout.write("%d\n" % ((avail * 100) // total))
PY
)" || rc=$?
      [[ "$rc" -eq 0 ]] || return 1
      case "$out" in
        ""|*[!0-9]*) return 1 ;;
      esac
      printf '%s\n' "$out"
      ;;
    *)
      return 1
      ;;
  esac
}

order_harness=""
order_model=""
cap_spawn=""
cap_p0=""
order_entries_h=()
order_entries_m=()
order_entries_c=()
order_judge_h=()
order_judge_m=()
order_walk=no
order_index=0
failover_continue=no
failover_from=0
failover_replace_pane=""
failover_replace_tab=""
harness_from_caller=no
machine_file="${APPL_MACHINE_CONFIG:-}"
[[ -n "$machine_file" || -z "${HOME:-}" ]] || machine_file="${HOME}/.config/appl/machine.toml"
if [[ -n "$machine_file" ]]; then
  order_rc=0
  order_pick="$(order_read "$machine_file" "$profile")" || order_rc=$?
  if [[ "$order_rc" -eq 4 || "$order_rc" -eq 3 ]]; then
    exit 2
  elif [[ "$order_rc" -ne 0 ]]; then
    echo "herd-spawn: harness.order for the ${profile} profile could not be read from ${machine_file} (exit ${order_rc}); the worker ${name} was not started" >&2
    exit 2
  fi
  while read -r kind rest; do
    case "$kind" in
      order)
        order_harness="${rest%% *}"
        order_model="${rest#* }"
        ;;
      capacity)
        cap_spawn="${rest%% *}"
        cap_p0="${rest#* }"
        ;;
      entry)
        order_eh="${rest%% *}"
        order_erest="${rest#* }"
        order_em="${order_erest%% *}"
        order_ec="${order_erest#* }"
        order_entries_h+=("$order_eh")
        order_entries_m+=("$order_em")
        order_entries_c+=("$order_ec")
        ;;
    esac
  done <<ORDER_OUT
${order_pick}
ORDER_OUT
fi
# Judged for every profile that loaded a list, including release, which starts on
# no entry from it. Copied before the clear below.
if [[ ${#order_entries_h[@]} -gt 0 ]]; then
  order_judge_h=("${order_entries_h[@]}")
  order_judge_m=("${order_entries_m[@]}")
fi
# release reads no harness.order; a capacity table still applies to every profile.
# weekly was rewritten to reviewer above, so it reads the reviewer list.
if [[ "$profile" != "worker" && "$profile" != "coordinator" && "$profile" != "reviewer" ]]; then
  order_harness=""
  order_model=""
  order_entries_h=()
  order_entries_m=()
  order_entries_c=()
fi
# Below spawn_floor, or unreadable, a non-P0 spawn stops here: exit 2, no herdr call.
# --p0 is never held by this check. No [capacity] table skips the read entirely.
if [[ -n "$cap_spawn" && "$p0" != "yes" ]]; then
  cap_level=""
  cap_rc=0
  cap_level="$(capacity_level)" || cap_rc=$?
  if [[ "$cap_rc" -ne 0 ]]; then
    echo "capacity: held (level unreadable)" >&2
    exit 2
  fi
  case "$cap_level" in
    ""|*[!0-9]*)
      echo "capacity: held (level unreadable)" >&2
      exit 2
      ;;
  esac
  if [[ "10#$cap_level" -lt "10#$cap_spawn" ]]; then
    echo "capacity: held (level=${cap_level})" >&2
    exit 2
  fi
fi
[[ -z "${HERD_SPAWN_HARNESS+set}" ]] || harness_from_caller=yes
harness="${HERD_SPAWN_HARNESS-${order_harness:-claude}}"
unset HERD_SPAWN_HARNESS
# A cross-harness failover re-execs at the taken entry. The index is this
# spawn's, not a caller override: HERD_SPAWN_HARNESS still beats the order.
if [[ -n "${HERD_SPAWN_FAILOVER_INDEX+set}" ]]; then
  failover_from="${HERD_SPAWN_FAILOVER_INDEX}"
  case "$failover_from" in
    0|[1-9]|[1-9][0-9]) ;;
    *)
      echo "herd-spawn: the failover index is not an entry this spawn read; the worker ${name} was not started" >&2
      exit 2
      ;;
  esac
  if [[ "$failover_from" -ge ${#order_entries_h[@]} ]]; then
    echo "herd-spawn: the failover index is past the order; the worker ${name} was not started" >&2
    exit 2
  fi
  failover_continue=yes
  harness_from_caller=no
  harness="${order_entries_h[$failover_from]}"
  failover_replace_pane="${HERD_SPAWN_REPLACE_PANE-}"
  failover_replace_tab="${HERD_SPAWN_REPLACE_TAB-}"
fi
unset HERD_SPAWN_FAILOVER_INDEX HERD_SPAWN_REPLACE_PANE HERD_SPAWN_REPLACE_TAB
# The cursor screen that means the account hit its usage limit (cursor-agent
# v2026.10.19). A dead harness, the same as Agent stopped retrying.
out_of_usage_line="You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue."
# HERD_SPAWN_OUT_OF_USAGE=<harness>: herd-watch saw that harness at the out-of-usage
# screen. It must name the first entry of this profile's harness.order, which this
# spawn then does not start: it fails over from it before the start loop. Any other
# value is refused here. Empty is the spawn as before. A re-exec never sees it.
out_of_usage_from=""
if [[ -n "${HERD_SPAWN_OUT_OF_USAGE:-}" && "$failover_continue" != "yes" ]]; then
  if [[ "$harness_from_caller" == "yes" || ${#order_entries_h[@]} -eq 0 \
        || "$HERD_SPAWN_OUT_OF_USAGE" != "${order_entries_h[0]}" ]]; then
    echo "herd-spawn: HERD_SPAWN_OUT_OF_USAGE must name the first harness.order entry of the ${profile} profile; the worker ${name} was not started" >&2
    exit 2
  fi
  out_of_usage_from="$HERD_SPAWN_OUT_OF_USAGE"
fi
unset HERD_SPAWN_OUT_OF_USAGE
case "$harness" in
  claude|cursor|codex|grok) ;;
  *)
    echo "herd-spawn: HERD_SPAWN_HARNESS must be claude, cursor, codex or grok (got '${harness}'); the worker ${name} was not started" >&2
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
# grok's permission mode is pinned by this script, `--permission-mode auto` at the grok
# argv site, and the wall is the --allow / --deny list. A value accepted above and then
# dropped would be a knob that looks like it did something. Unset stays the normal path.
if [[ "$harness" == "grok" && -n "$permission_mode_set" ]]; then
  echo "herd-spawn: HERD_SPAWN_PERMISSION_MODE does not apply to the grok harness: its wall is one --allow per rule of the worker allow list and this script pins --permission-mode auto, so a mode set here would be validated and then dropped; unset it; the worker ${name} was not started" >&2
  exit 2
fi
# A cursor reviewer is allowed (owner 2026-10-13). [[harness.order.reviewer]] names the
# harness, and cursor is one of the names. cursor-agent still reads ~/.cursor/rules and
# skills by walking ancestors of the cwd, and it has no switch to leave them out
# (measured 2026-09-12: a rule planted under ~/.cursor/rules steered a herd session at
# once; ISSUE(security-audit-2026-09-12-a-herd-session-can-r-b1b5)). The spawn does not
# pretend the private CURSOR_CONFIG_DIR covers that. The cwd is still never the primary:
# the rules file there is shared by every Cursor session.
# A grok reviewer is refused until which instruction files grok reads from the directory
# it opens is known. One line, exit 2, before herdr is asked anything, and no brief is
# written. The profile is refused, not the harness. A Grok model on the cursor harness
# is the cursor harness, and is not this refusal.
if [[ "$harness" == "grok" && "$profile" == "reviewer" ]]; then
  echo "herd-spawn: the grok harness reviews nothing yet: which instruction files grok reads from the directory it opens has not been measured, so a reviewer would obey files this spawn does not own; the worker ${name} was not started" >&2
  exit 2
fi
# A grok WORKER (the worker, test-author and implementer briefs) is no longer refused
# outright: it runs behind the claude worker's wall -- the same plug, the same
# darwin.sb.template, the same path denies (THE WALL, below; intake 20261008T161926Z) --
# and never unwalled, whatever HERD_WALL says. The reviewer refusal above and the
# coordinator refusal below stay. A Grok model on the cursor harness is not this.
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
elif [[ -n "$order_model" && "$harness" == "$order_harness" ]]; then
  # the machine file's first entry, checked by order_read with the same pattern
  model="$order_model"
fi
[[ -n "$model" || "$harness" != "claude" ]] || model="opus"
unset HERD_SPAWN_MODEL
# The taken entry's model, not HERD_SPAWN_MODEL and not the first entry's.
if [[ "$failover_continue" == "yes" ]]; then
  model="${order_entries_m[$failover_from]}"
fi
# The coordinator seat is two inputs this spawn can write for THIS pane alone: the allow
# and deny, into a file the harness loads and the worker cannot rewrite, and appl-hook.sh
# on UserPromptSubmit and SessionStart. Claude's --settings file is both, and
# --setting-sources project keeps the user's own allow out of it. Cursor's is a private
# CURSOR_CONFIG_DIR under $HERD_DIR/<name>/ (checked once that directory exists, below):
# the shared <cwd>/.cursor/cli.json is never written, and a cursor coordinator's cwd is
# the primary, which is the normal seat. What Cursor still has no switch for is the
# user's own rules and skills; that limit is recorded when the pane is started, not
# used to refuse a pane that has a private directory. Codex has no per-command deny and
# no hook at all. A coordinator that cannot sit does not write rules.unenforced.json:
# that file records a worker's lists.
if [[ "$harness" == "codex" && "$profile" == "coordinator" ]]; then
  echo "herd-spawn: the codex harness does not take the coordinator profile: it has no per-command deny list and no session-guard hook, so the spawn cannot write this pane's allow and deny or register appl-hook.sh on it alone; the worker ${name} was not started" >&2
  exit 2
fi
# The release profile's wall is explicit Edit and Bash denies. Claude holds them in
# its settings file. Cursor holds the same list in cli.json (Cursor's spelling), not
# the worker brief list. No other harness has been pinned to hold it, so each is
# refused by name rather than handed a weaker one (coordinator ruling, intake
# 20261004T224500Z; cursor added by ruling 20261016T194215Z).
if [[ "$profile" == "release" && "$harness" != "claude" && "$harness" != "cursor" ]]; then
  echo "herd-spawn: the ${harness} harness does not take the release profile: only the claude and cursor harnesses are pinned to hold its deny-everything-but-VERSION-and-CHANGELOG.md rules, and a weaker release wall is not emitted; the worker ${name} was not started" >&2
  exit 2
fi
if [[ "$harness" == "grok" && "$profile" == "coordinator" ]]; then
  echo "herd-spawn: the grok harness does not take the coordinator profile: which instruction files it reads has not been measured, and appl-hook.sh has no per-pane slot on it (the hook is written only into the claude --settings file); the worker ${name} was not started" >&2
  exit 2
fi

# --- the read-only command list: rendered before herdr is asked anything -----------------
# readonly-commands.tsv beside this script (read through readonly_commands.py, never from a
# path a caller names) is the one list of commands a pane runs without a prompt on any
# harness (intake 20261007T152501Z). Each row becomes, in Claude Code's spelling,
#   allow `Bash(<words>:*)`;
#   deny  `Bash(<words> *>*)` -- a `>` is not split off a command, so the prefix allow would
#         otherwise let `cat x > out` through -- and `Bash(<words> *<flag>*)` per refused flag.
# Every profile but release takes them (the worker, reviewer and coordinator, on claude and
# codex as written and on cursor in Cursor's spelling, below). A list that does not load is
# exit 2. A copy of this script with NEITHER file beside it (an older or partial install)
# renders no list and denies the five readers the static list used to, so such a pane is
# exactly as strict as before the list, never wider. Cursor's `Shell(<cmd>:<args>)` splits at the first `:`, so a row whose command
# carries one cannot be named there: a cursor spawn is refused by that row, before any
# herdr call and before any rules file. What a reader may READ is the wall's to bound.
ro_allow=()
ro_deny=()
if [[ "$profile" != "release" ]]; then
  ro_out="$(python3 -I - "$here/readonly_commands.py" "$here/readonly-commands.tsv" "$harness" "$name" <<'PY'
import importlib.util, os, sys
loader, path, harness, name = sys.argv[1:5]
if not os.path.lexists(loader) and not os.path.lexists(path):
    print("MISSING")
    sys.exit(0)
try:
    spec = importlib.util.spec_from_file_location("readonly_commands", loader)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    entries = mod.load(path)
except (OSError, ValueError, SyntaxError) as e:
    print("herd-spawn: the read-only command list %s does not load (%s); the worker %s was not started"
          % (path, e, name), file=sys.stderr)
    sys.exit(2)
if harness == "cursor":
    bad = [" ".join(e.words) for e in entries if ":" in e.words[0]]
    if bad:
        print("herd-spawn: the cursor harness cannot express the read-only list entry %s: its "
              "Shell(<cmd>:<args>) rule splits at the first ':', so no cursor rule names that command; "
              "the worker %s was not started" % (", ".join(bad), name), file=sys.stderr)
        sys.exit(2)
for e in entries:
    w = " ".join(e.words)
    print("A Bash(%s:*)" % w)
    print("D Bash(%s *>*)" % w)
    for f in e.refused:
        print("D Bash(%s *%s*)" % (w, f.rstrip("*")))
PY
)" || exit 2
  while IFS= read -r ro_line; do
    case "$ro_line" in
      "A "*) ro_allow+=("${ro_line#A }") ;;
      "D "*) ro_deny+=("${ro_line#D }") ;;
      MISSING) ro_deny+=("Bash(cat:*)" "Bash(head:*)" "Bash(tail:*)" "Bash(grep:*)" "Bash(wc:*)") ;;
    esac
  done <<RO_OUT
${ro_out}
RO_OUT
  unset ro_out ro_line
fi

# --- the wall's mode, its egress, and the bounds: checked before herdr is asked anything --
# (P1 ISSUE(workers-have-no-resource-limit-and-no-egress-control); the wall block below
# says what each one does.) HERD_WALL is require, prefer or off. Unset is require,
# including where this machine has no wall: a missing plug does not pick a mode that
# tolerates the missing plug. Set to anything else -- an empty string included -- is
# exit 2: a typo must not become "no wall". The caller's bytes are
# not echoed back (the line must stay one line).
wall_mode=""
if [[ -n "${HERD_WALL+set}" ]]; then
  case "$HERD_WALL" in
    require|prefer|off) wall_mode="$HERD_WALL" ;;
    *)
      echo "herd-spawn: HERD_WALL must be require, prefer or off (unset is require, including where this machine has no wall); the worker ${name} was not started" >&2
      exit 2
      ;;
  esac
fi
# A grok worker never starts unwalled, by any spelling (coordinator ruling on intake
# 20261008T161926Z): `off` is refused here, before herdr is asked anything, and `prefer`
# is held to require below -- a finding refuses it instead of starting it unwalled.
if [[ "$harness" == "grok" && "$wall_mode" == "off" ]]; then
  echo "herd-spawn: HERD_WALL=off does not apply to the grok harness: a grok worker runs only behind the wall, never unwalled; unset HERD_WALL; the worker ${name} was not started" >&2
  exit 2
fi
# Wall v1 leaves the network OPEN, and says so (egress=open on the success line and in
# wall.log). Denying egress needs a loopback proxy holding a host allowlist -- a real
# worker needs its API, the Dispatch finish verbs need the relay -- which is wall v2 and
# not built. So `deny` is refused in every mode, rather than accepted and ignored: a
# worker that ran with the network open under a `deny` would be a half-wall.
if [[ -n "${HERD_WALL_EGRESS+set}" ]]; then
  case "$HERD_WALL_EGRESS" in
    open) ;;
    deny)
      echo "herd-spawn: HERD_WALL_EGRESS=deny is refused: wall v1 leaves the network open, and denying egress needs the loopback proxy of wall v2, which does not exist yet; the worker ${name} was not started" >&2
      exit 2
      ;;
    *)
      echo "herd-spawn: HERD_WALL_EGRESS must be open (wall v1; deny waits for the wall v2 proxy); the worker ${name} was not started" >&2
      exit 2
      ;;
  esac
fi
# The bounds: positive whole numbers, nine digits at most, or the default. There is no
# spelling of "unbounded": 0, -1, `unlimited`, an empty string, a fraction and a number
# too long to be meant are each exit 2, on one line naming the variable.
#   cpu   seconds of CPU time PER PROCESS (an rlimit: SIGXCPU). A session idles on its API
#         most of its life, so two hours is far past a long session and still ends a
#         test spinning in a loop.
#   mem   megabytes of memory (physical footprint) of the worker's whole process tree.
#   procs processes in the worker's tree -- its own, not the uid's.
wall_bound() {
  local var="$1" def="$2" out="$3"
  if [[ -n "${!var+set}" ]]; then
    if ! [[ "${!var}" =~ ^[1-9][0-9]{0,8}$ ]]; then
      echo "herd-spawn: ${var} must be a positive whole number of at most nine digits (there is no unbounded value); the worker ${name} was not started" >&2
      exit 2
    fi
    printf -v "$out" '%s' "${!var}"
  else
    printf -v "$out" '%s' "$def"
  fi
}
wall_bound HERD_WALL_CPU_SECS 7200 wall_cpu
wall_bound HERD_WALL_MEM_MB 8192 wall_mem
wall_bound HERD_WALL_PROCS 512 wall_procs
#   probe seconds each of the two wall probes (the wall probe, the claim probe) may take
#         before it is killed and the spawn refused by name. Both waited with no limit, so a
#         probe that stalled behind the wall stalled the spawn with it. Checked here, before
#         any probe starts; like the other bounds it has no unbounded spelling.
wall_bound HERD_WALL_PROBE_SECS 120 wall_probe_secs
# dropped from this process like the other knobs, so a spawn a worker starts decides its
# own wall from the defaults again. Saved first so a cross-harness re-exec sees them.
failover_wall_saved=no
failover_wall_value=""
failover_egress_saved=no
failover_egress_value=""
failover_cpu_saved=no
failover_cpu_value=""
failover_mem_saved=no
failover_mem_value=""
failover_procs_saved=no
failover_procs_value=""
failover_probe_saved=no
failover_probe_value=""
if [[ -n "${HERD_WALL+set}" ]]; then
  failover_wall_saved=yes
  failover_wall_value="$HERD_WALL"
fi
if [[ -n "${HERD_WALL_EGRESS+set}" ]]; then
  failover_egress_saved=yes
  failover_egress_value="$HERD_WALL_EGRESS"
fi
if [[ -n "${HERD_WALL_CPU_SECS+set}" ]]; then
  failover_cpu_saved=yes
  failover_cpu_value="$HERD_WALL_CPU_SECS"
fi
if [[ -n "${HERD_WALL_MEM_MB+set}" ]]; then
  failover_mem_saved=yes
  failover_mem_value="$HERD_WALL_MEM_MB"
fi
if [[ -n "${HERD_WALL_PROCS+set}" ]]; then
  failover_procs_saved=yes
  failover_procs_value="$HERD_WALL_PROCS"
fi
if [[ -n "${HERD_WALL_PROBE_SECS+set}" ]]; then
  failover_probe_saved=yes
  failover_probe_value="$HERD_WALL_PROBE_SECS"
fi
unset HERD_WALL HERD_WALL_EGRESS HERD_WALL_CPU_SECS HERD_WALL_MEM_MB HERD_WALL_PROCS HERD_WALL_PROBE_SECS

# --- THE OAUTH TOKEN: the owner's long-lived login for the pane -------------------------
# Every pane refreshing the one shared ~/.claude login knocked the others out at each
# rotation (a refresh token is single-use). When $HOME/.muretai/herd/oauth-token passes
# iso_herd_oauth_token (a regular 0600-style file of the caller's, not a symlink), a claude
# pane gets it as CLAUDE_CODE_OAUTH_TOKEN on `herdr tab create` and never touches that file.
# Anything else is an absent file: today's spawn, on the shared login. A file present but
# rejected says so by its reason word alone (mode, owner, symlink, charset, size, from
# iso_herd_oauth_token_judged): one stderr line here and one `oauth-token rejected <why>`
# line in coordinator.log once HERD_DIR is judged ours. An absent, empty, whitespace-only
# or unreadable file, and an honored one, say nothing. The FILE
# is the only source -- a CLAUDE_CODE_OAUTH_TOKEN this process inherited is dropped here, so
# no caller smuggles one past the mode and symlink check, and nothing this spawn runs
# inherits it. The value lives in this shell variable only: it is written to no file (not
# permissions.json, the brief, the wall, the resume record) and printed on no line. The
# channel is herdr's --env argv on `tab create` (the daemon builds the tab from that list
# alone), so the value is in the process table while that one call runs:
# ISSUE(herd-oauth-token-rides-tab-create-argv). Cursor and codex do not read it and get none.
oauth_token=""
oauth_why=""
if [[ "$harness" == "claude" ]]; then
  oauth_said="$(iso_herd_oauth_token_judged 2>/dev/null)" || true
  case "$oauth_said" in
    "honored "?*) oauth_token="${oauth_said#honored }" ;;
    "rejected mode"|"rejected owner"|"rejected symlink"|"rejected charset"|"rejected size")
      oauth_why="${oauth_said#rejected }" ;;
  esac
  oauth_said=""
  if [[ -n "$oauth_why" ]]; then
    echo "herd-spawn: oauth-token file present but rejected: ${oauth_why}" >&2
  fi
fi
unset CLAUDE_CODE_OAUTH_TOKEN

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
  # consume the rest of a cluster. `Bash(python:*)` already covers every `python `.
  # The shape rules read the interpreter's FLAGS only -- the words between `python3` and the
  # script path -- never a script's arguments. The first spelling of them (`python3 -*c *`,
  # `python3 * -m`, ...) put a `*` before the `c`, and a `*` spans spaces: it ran past the
  # script into its arguments, so `python3 -I tools/sec_lint.py --diff <sha>..<sha>` was
  # DENIED whenever a sha ended in `c` or `m`, and a reviewer's receipt depended on the hex
  # of its range (the landing 46815a9..c3691b0). So every literal below stops inside the
  # flag words and each `*` only follows it: the one flag spelling a session is allowed is
  # `python3 -I <path>`, and the rules deny every OTHER start -- a second flag word after
  # `-I`, a cluster that continues `-I`, any other dash option, a long option, a doubled
  # space. Letter by letter, in the loop after this list (`-c'code'` and `-mmod`, with no
  # space, are the `c` and `m` of it). Pinned both ways by test_herd_spawn.test_deny_by_shape
  # and tests/test_reviewer_receipt_perms.py.
  "Bash(python3 -m:*)"
  "Bash(python3 -I -*)" "Bash(python3 --*)" "Bash(python3  *)" "Bash(python3 -I  *)"
  "Bash(perl:*)" "Bash(ruby:*)" "Bash(node:*)" "Bash(php:*)"
  "Bash(bash -*)" "Bash(sh -*)" "Bash(zsh -*)"
  # cat, head, tail, grep and wc left this list for readonly-commands.tsv (intake
  # 20261007T152501Z): a reader on that list runs without a prompt, and the wall bounds what
  # it reads. The readers below are not on it.
  "Bash(sed:*)" "Bash(awk:*)" "Bash(od:*)" "Bash(xxd:*)" "Bash(strings:*)" "Bash(dd:*)"
  "Bash(tr:*)" "Bash(nl:*)" "Bash(rev:*)" "Bash(cut:*)" "Bash(fold:*)" "Bash(tee:*)"
  "Bash(less:*)" "Bash(more:*)"
  "Bash(curl:*)" "Bash(wget:*)" "Bash(ssh:*)" "Bash(scp:*)"
)
# the flag words, letter by letter (see the shape rules above): `-I` continued by a letter
# is a cluster (`-Ic`, `-IBm`), and a first flag that is not `-I` is any other option
for py_flag in a b c d e f g h i j k l m n o p q r s t u v w x y z \
               A B C D E F G H I J K L M N O P Q R S T U V W X Y Z; do
  deny+=("Bash(python3 -I${py_flag}*)")
  [[ "$py_flag" == "I" ]] || deny+=("Bash(python3 -${py_flag}*)")
done
unset py_flag
# A test run is ONE command, `python3 -I tests/<file>.py`, never redirected (A2 of intake
# 20260929T223514Z): a pipe splits the line and its `tail`/`head` half is denied above, but
# `> out.txt` stays inside the one subcommand, so it needs a rule of its own. The `*` only
# follows the literal `tests/` and guards no `c` or `m` (the shape rule above). A `..` would
# walk the every-profile `tests/*.py` allow out of tests/, so it is refused the same way.
# After the static list, so a profile's deny still begins with it byte for byte.
deny+=("Bash(python3 -I tests/*>*)" "Bash(python3 tests/*>*)" "Bash(python3 -I tests/*..*)")
# ... and never piped: the pipe's `tail`/`head` half was denied by the static list until
# those readers moved to the read-only list (intake 20261007T152501Z), so A2 says it here.
deny+=("Bash(python3 -I tests/*|*)" "Bash(python3 tests/*|*)")
# The read-only list's denies (rendered above): its redirects and refused flags, after the
# static list for the same reason.
deny+=(${ro_deny[@]+"${ro_deny[@]}"})
# The coordinator starts panes only through this script (which writes their rules), so
# the raw verb that would start an agent with any flags it likes is denied to it.
if [[ "$profile" == "coordinator" ]]; then
  deny+=("Bash(herdr agent start:*)")
fi
# The release solo's shell writes the tag and nothing else. Its allow list (below) names
# only that and a few read-only verbs, so an unlisted line would go to the classifier;
# these name the write routes outright so none is the classifier's to wave through: the
# tag forced, deleted or written elsewhere, any other ref, a path restored or removed, a
# redirect, and every interpreter or script (a task script runs code the checkout carries).
# After the static list, which still heads the deny list byte for byte.
if [[ "$profile" == "release" ]]; then
  deny+=(
    "Bash(git tag -d*)" "Bash(git tag -f*)" "Bash(git tag --*)" "Bash(git tag * -d*)" "Bash(git tag * -f*)"
    "Bash(git tag * --delete*)" "Bash(git tag * --force*)" "Bash(git tag *\$*)" "Bash(git tag *\`*)"
    "Bash(git update-ref:*)" "Bash(git symbolic-ref:*)" "Bash(git branch:*)" "Bash(git reset:*)"
    "Bash(git checkout:*)" "Bash(git restore:*)" "Bash(git switch:*)" "Bash(git merge:*)"
    "Bash(git rebase:*)" "Bash(git cherry-pick:*)" "Bash(git revert:*)" "Bash(git stash:*)"
    "Bash(git clean:*)" "Bash(git rm:*)" "Bash(git mv:*)" "Bash(git apply:*)" "Bash(git am:*)"
    "Bash(git config:*)" "Bash(git remote:*)" "Bash(git fetch:*)" "Bash(git pull:*)"
    "Bash(git notes:*)" "Bash(git replace:*)" "Bash(git gc:*)" "Bash(git prune:*)" "Bash(git worktree:*)"
    "Bash(rm:*)" "Bash(rmdir:*)" "Bash(mv:*)" "Bash(cp:*)" "Bash(ln:*)" "Bash(touch:*)" "Bash(mkdir:*)"
    "Bash(chmod:*)" "Bash(truncate:*)" "Bash(install:*)" "Bash(rsync:*)" "Bash(find:*)" "Bash(xargs:*)"
    "Bash(env:*)" "Bash(python3:*)" "Bash(bash:*)" "Bash(sh:*)" "Bash(zsh:*)" "Bash(source:*)" "Bash(.:*)"
    "Bash(*>*)"
    # `git log`/`git show` write any file through `--output` (and its accepted prefixes down
    # to `--outp`), and `--ext-diff`/`--textconv` (down to `--ext`/`--textc`) run a program
    # the config names; the allowed `git log:*`/`git show:*`/`git diff:*` would pass them,
    # so they are denied in any position (intake 20261011T042959Z)
    "Bash(git log *--outp*)" "Bash(git show *--outp*)" "Bash(git diff *--outp*)"
    "Bash(git log *--ext*)" "Bash(git show *--ext*)" "Bash(git diff *--ext*)"
    "Bash(git log *--textc*)" "Bash(git show *--textc*)" "Bash(git diff *--textc*)"
    # the readers the static list carried before the read-only list: this profile takes
    # no read-only list, so they stay denied here
    "Bash(cat:*)" "Bash(head:*)" "Bash(tail:*)" "Bash(grep:*)" "Bash(wc:*)"
  )
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

# --- one live worker per owner key -------------------------------------------------------
# The key is a pair's identity: ensure-worktree.sh gives its worktree `lock: mine` to any
# session holding it, so a second worker started under a key a LIVE worker holds writes on
# that worker's branch beside it (appl-home-tests2 beside appl-home-tests, 2026-09-29).
# key_guard KEY DIR HANDOVER refuses such a spawn (exit 2, one line naming the live worker)
# before a tab, a record or the lock is touched. The workers holding KEY are those whose
# $HERD_DIR/.keys/<w> record says KEY (written by their own spawn) and the owner_worker of
# every lock of DIR's repository owned by KEY (a hand-over names it); this worker's own
# name is not one of them (herdr refuses a live name by itself). Only those herdr still
# lists -- `agent list` by name or `tab list` by label -- are live, so nothing is asked of
# herdr when no worker holds the key. A listing herdr does not answer is a refusal too:
# herdr not answering is not "the tab is gone".
# The one spawn under a live key that goes ahead is the pair hand-over (HANDOVER=yes): DIR
# is the worktree whose lock is owned by KEY, and every live holder has written a regular,
# non-empty $HERD_DIR/<holder>/report.md. The coordinator spawns the implementer that way
# and closes the author after; a second implementer while the first is live and unreported
# is refused like any duplicate.
key_guard() {
  local key="$1" dir="$2" handover="$3" hd f w k line wt lk ow cands="" live="" missing="" listed lock_owner
  hd="$(iso_herd_dir)" || return 0
  [[ "$hd" == /* ]] || hd="$(pwd)/${hd}"
  if [[ -d "$hd/.keys" && ! -L "$hd/.keys" ]]; then
    for f in "$hd/.keys"/*; do
      [[ -f "$f" && ! -L "$f" ]] || continue
      w="${f##*/}"
      case "$w" in *[!a-z0-9_-]*|[!a-z]*) continue ;; esac
      [[ "$w" != "$name" ]] || continue
      k=""
      IFS= read -r k < "$f" || true
      [[ "$k" == "$key" ]] || continue
      case " $cands " in *" $w "*) ;; *) cands="${cands:+$cands }$w" ;; esac
    done
  fi
  while IFS= read -r line; do
    case "$line" in worktree\ *) wt="${line#worktree }" ;; *) continue ;; esac
    lk="$(iso_lock_path "$wt" 2>/dev/null)" || continue
    [[ -f "$lk" && ! -L "$lk" ]] || continue
    [[ "$(iso_lock_get "$lk" owner)" == "$key" ]] || continue
    ow="$(iso_lock_get "$lk" owner_worker)"
    case "$ow" in ''|*[!a-z0-9_-]*|[!a-z]*) continue ;; esac
    [[ "$ow" != "$name" ]] || continue
    case " $cands " in *" $ow "*) ;; *) cands="${cands:+$cands }$ow" ;; esac
  done < <(git -C "$dir" worktree list --porcelain 2>/dev/null || true)
  [[ -n "$cands" ]] || return 0
  [[ -n "${herdr:-}" ]] || find_herdr
  if ! listed="$(python3 -I - "$herdr" <<'PY'
import json, subprocess, sys
names = set()
for kind, field in (("agent", "name"), ("tab", "label")):
    try:
        p = subprocess.run([sys.argv[1], kind, "list"], stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.SubprocessError) as e:
        print("'herdr %s list' did not run (%s)" % (kind, type(e).__name__)); sys.exit(1)
    if p.returncode != 0:
        print("'herdr %s list' exited %d" % (kind, p.returncode)); sys.exit(1)
    try:
        rows = json.loads(p.stdout.decode("utf-8", "replace")).get("result", {}).get(kind + "s")
    except (ValueError, AttributeError):
        rows = None
    if not isinstance(rows, list):
        print("'herdr %s list' printed no %ss" % (kind, kind)); sys.exit(1)
    for r in rows:
        if isinstance(r, dict) and isinstance(r.get(field), str):
            names.add(r[field])
print("\n".join(sorted(names)))
PY
)"; then
    echo "herd-spawn: the owner key $(iso_safe_text "$key" || echo '?') is held by ${cands// /, }, and herdr's listing did not answer (${listed:-no reason}), so whether that worker is still live cannot be told; refusing rather than start a second worker under a live key; the worker ${name} was not started" >&2
    exit 2
  fi
  for w in $cands; do
    case $'\n'"$listed"$'\n' in
      *$'\n'"$w"$'\n'*) live="${live:+$live }$w" ;;
    esac
  done
  [[ -n "$live" ]] || return 0
  if [[ "$handover" == "yes" ]]; then
    lk="$(iso_lock_path "$dir" 2>/dev/null || true)"
    lock_owner=""
    [[ -z "$lk" || ! -f "$lk" || -L "$lk" ]] || lock_owner="$(iso_lock_get "$lk" owner)"
    if [[ "$lock_owner" == "$key" ]]; then
      for w in $live; do
        f="$hd/${w}/report.md"
        [[ ! -L "$f" && -f "$f" && -s "$f" ]] || missing="${missing:+$missing }$w"
      done
      [[ -n "$missing" ]] || return 0
      echo "herd-spawn: the owner key $(iso_safe_text "$key" || echo '?') is held by the live worker ${missing// /, }, which has written no report.md yet; the pair hand-over into ${dir} waits for that report; the worker ${name} was not started" >&2
      exit 2
    fi
  fi
  echo "herd-spawn: the owner key $(iso_safe_text "$key" || echo '?') is held by the live worker ${live// /, } (herdr still lists it); a second worker under a live key would share its worktree -- only the pair hand-over (--cwd <the key's worktree>, after the holder's report.md) may, or wait until that tab is closed; the worker ${name} was not started" >&2
  exit 2
}
caller_key=""
for kv in ${envs[@]+"${envs[@]}"}; do
  if [[ "${kv%%=*}" == "ISOLATED_SESSION_OWNER" ]]; then
    caller_key="${kv#*=}"
  fi
done

# A cursor test author is spawned in the primary so its brief can run ensure-worktree.sh.
# Cursor refuses the primary, so under a cursor-first order that author never started.
# Open the pair's worktree on the --open-worktree path below: the title is data, one
# argument, never evaluated. The template file stays as written; only the rendered brief
# says the worktree is already open. Claude-first, and HERD_SPAWN_HARNESS=claude, do not
# enter here (the harness above is the one the spawn will actually use).
author_worktree=no
if [[ "$harness" == "cursor" && "$profile" == "worker" && "$open_given" != "yes" && "$cwd_given" != "yes" ]]; then
  author_first=""
  IFS= read -r author_first < "$brief" || true
  case "$author_first" in
    "You are a Muretai test-author session"*)
      author_title=""
      for kv in ${vars[@]+"${vars[@]}"}; do
        if [[ "${kv%%=*}" == "TITLE" ]]; then
          author_title="${kv#*=}"
        fi
      done
      if [[ -z "$author_title" || "$author_title" == "{{TITLE}}" ]]; then
        author_title="$(python3 -I - "$brief" <<'PY'
import re, sys
try:
    text = open(sys.argv[1], encoding="utf-8").read()
except (OSError, UnicodeDecodeError):
    sys.exit(0)
m = re.search(r'ensure-worktree\.sh "([^"\n]*)"', text)
if m and m.group(1) and m.group(1) != "{{TITLE}}":
    sys.stdout.write(m.group(1))
PY
)"
      fi
      if [[ -z "$author_title" || "$author_title" == "{{TITLE}}" ]]; then
        echo "herd-spawn: a cursor test author needs a title (--var TITLE= or the brief's ensure-worktree.sh \"<title>\" line) to open its worktree; the worker ${name} was not started" >&2
        exit 2
      fi
      if [[ -z "$caller_key" ]]; then
        echo "herd-spawn: --open-worktree needs --env ISOLATED_SESSION_OWNER=<harness>:<worker>: the worktree is opened under that key and handed to the worker by it, and a re-run finds its own lock only under the same key; the worker ${name} was not started" >&2
        exit 2
      fi
      for kv in ${vars[@]+"${vars[@]}"}; do
        case "${kv%%=*}" in
          WORKTREE|BRANCH|PRIMARY)
            echo "herd-spawn: --var ${kv%%=*}=... is refused with --open-worktree: the spawn fills it from the worktree it opens; the worker ${name} was not started" >&2
            exit 2
            ;;
        esac
      done
      open_title="$author_title"
      open_key="$caller_key"
      open_given=yes
      author_worktree=yes
      ;;
  esac
fi
# A render holds no worker state, and opening a worktree takes a hold on it. Judged here,
# after the cursor test author's own open was decided and before anything is opened.
if [[ "$render" == "yes" && "$open_given" == "yes" ]]; then
  echo "herd-spawn: --render takes --cwd <worktree>, never --open-worktree: opening the worktree would take a hold, and a render holds no worker state; nothing was rendered for ${name}" >&2
  exit 2
fi

# --- the name: a closed one is never reused (intake 20261010T175128Z-2) -----------------
# A name appl-close.sh closed -- its marker $HERD_DIR/walls/.closed/<name>, or a coordinator
# log line in exactly its `<UTC time> closed <name>` shape -- is finished for good: the hook
# ignores its report. On 2026-10-10 a reused closed name had its live pane's report ignored
# for two hours. So the name is allocated HERE, before any record, worktree or tab: the
# next free `<name>-<n>` from 2, skipping one with a brief or spawn record, one herdr lists
# live, or one itself closed. Nothing a worker can write (its report.md, its directory, its
# wall) and no line in another shape counts. The old name's files are never touched. An
# unclosed name is used as given, and herdr is asked nothing here.
name_closed() {
  python3 -I - "$1" "$2" <<'PY'
import os, re, stat, sys
herd, w = sys.argv[1], sys.argv[2]
def ours(p):
    try:
        st = os.lstat(p)
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid()
walls = os.path.join(herd, "walls")
marks = os.path.join(walls, ".closed")
if not os.path.islink(walls) and not os.path.islink(marks) and ours(os.path.join(marks, w)):
    sys.exit(0)
coord = os.path.join(herd, "coordinator")
log = os.path.join(coord, "coordinator.log")
if not os.path.islink(coord) and ours(log):
    shape = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z closed (\S+)")
    with open(log, encoding="utf-8", errors="replace") as f:
        for ln in f:
            m = shape.fullmatch(ln.rstrip("\n"))
            if m and m.group(1) == w:
                sys.exit(0)
sys.exit(1)
PY
}
name_recorded() {
  local p
  for p in "$1/$2/brief.md" "$1/walls/$2/run.json" "$1/.repos/$2" "$1/briefs/$2.md" "$1/.resume/$2"; do
    if [[ -e "$p" || -L "$p" ]]; then
      return 0
    fi
  done
  return 1
}
if alloc_herd="$(iso_herd_dir)" && [[ -n "$alloc_herd" ]]; then
  [[ "$alloc_herd" == /* ]] || alloc_herd="$(pwd)/${alloc_herd}"
  if [[ -d "$alloc_herd" ]] && name_closed "$alloc_herd" "$name"; then
    asked="$name"
    n=2
    while :; do
      cand="${asked}-${n}"
      if [[ ${#cand} -gt 32 ]]; then
        echo "herd-spawn: ${asked} was closed and no free ${asked}-<n> fits herdr's 32-character name rule (${cand}); pick another name; nothing was started" >&2
        exit 2
      fi
      if ! name_recorded "$alloc_herd" "$cand" && ! name_closed "$alloc_herd" "$cand"; then
        # a render asks herdr nothing and starts no pane to collide with a live one
        [[ "$render" != "yes" ]] || break
        if ! live_at="$(herdr_lists_elsewhere "$cand" "" "")"; then
          echo "herd-spawn: ${asked} was closed, and herdr could not say whether ${cand} is live (${live_at}); nothing was started" >&2
          exit 3
        fi
        [[ -n "$live_at" ]] || break
      fi
      n=$((n + 1))
    done
    echo "herd-spawn: ${asked} was closed (appl-close.sh); a closed name is never reused, so this worker is ${cand}" >&2
    name="$cand"
  fi
fi

# --- where the tab opens ---------------------------------------------------------------
# Resolved BEFORE herdr is asked anything, because for codex the answer is itself a
# refusal (below) and a refused spawn must leave nothing anywhere -- not a tab, not a
# recorded call, not a directory.
#
# --open-worktree opens the worker's worktree first and makes it the cwd (the header says
# why). ensure-worktree.sh runs in a subshell holding the caller's key and no other
# ISOLATED_SESSION_* variable (an override in the coordinator's environment must not reach
# the open), with HERD_WORKER set to THIS worker's name (not the caller's), from the primary
# of the repository this script lives in -- dispatch-take.sh's open_worktree, plus the
# worker name a re-run needs after the hand-over. Only its WORKTREE= and BRANCH= lines are read;
# the title reaches it as one argument and is never evaluated.
# With --repo (judged above) the primary is that repository's and so is the script: its own
# ensure-worktree.sh, from its own primary.
if [[ "$open_given" == "yes" ]]; then
  if [[ -n "$open_repo_primary" ]]; then
    open_primary="$open_repo_primary"
    open_ensure="$repo_ensure"
  else
    open_primary="$(iso_primary_of "$here")" || {
      echo "herd-spawn: --open-worktree: this script is not inside a git checkout; the worker ${name} was not started" >&2
      exit 2
    }
    open_ensure="$here/ensure-worktree.sh"
  fi
  # A reviewer's checkout (--base, judged above) opens at that commit directly under
  # $HERD_DIR/review/<name>, where the review-checkout carve-out finds it -- the herd
  # directory resolved here as it is below, and one already owned by someone else refused
  # before anything is made in it.
  open_at=()
  if [[ -n "$open_base_sha" ]]; then
    open_herd="$(iso_herd_dir)" || {
      echo "herd-spawn: neither HERD_DIR nor HOME is set, so there is no herd directory for the reviewer's checkout; the worker ${name} was not started" >&2
      exit 2
    }
    [[ "$open_herd" == /* ]] || open_herd="$(pwd)/${open_herd}"
    if [[ -e "$open_herd" && ! -O "$open_herd" ]] || [[ -e "$open_herd/review" && ( -L "$open_herd/review" || ! -O "$open_herd/review" ) ]]; then
      echo "herd-spawn: ${open_herd} (or its review/) is not a directory of $(id -un)'s; the reviewer's checkout is not opened there; the worker ${name} was not started" >&2
      exit 2
    fi
    for open_d in "$open_herd" "$open_herd/review"; do
      if [[ ! -d "$open_d" ]]; then
        mkdir -p "$open_d"
        chmod 700 "$open_d" 2>/dev/null || true
      fi
    done
    open_at=(--at "$open_base_sha" --into "$open_herd/review/$name")
  fi
  # a function, called in a subshell: bash 3.2 cannot parse a `case` written inside $( )
  open_run() {
    local v
    for v in $(compgen -e); do
      case "$v" in
        ISOLATED_SESSION_*|HERD_WORKER) unset "$v" ;;
      esac
    done
    export ISOLATED_SESSION_OWNER="$open_key"
    # ... as THIS worker: once a spawn has handed the hold over, the lock names the worker
    # (owner_worker=<name>) and is `mine` only for a session whose HERD_WORKER is that
    # name (lib.sh iso_lock_state) -- which is what lets a re-run resume, and keeps another
    # worker started under the same key out
    export HERD_WORKER="$name"
    cd "$open_primary" || return 2
    bash "$open_ensure" ${open_at[@]+"${open_at[@]}"} "$open_title" </dev/null 2>&1
  }
  open_out=""
  open_rc=0
  open_out="$(open_run)" || open_rc=$?
  open_wt=""
  open_branch=""
  while IFS= read -r open_line; do
    case "$open_line" in
      WORKTREE=*) [[ -n "$open_wt" ]] || open_wt="${open_line#WORKTREE=}" ;;
      BRANCH=*) [[ -n "$open_branch" ]] || open_branch="${open_line#BRANCH=}" ;;
    esac
  done <<< "$open_out"
  if [[ "$open_rc" -ne 0 || -z "$open_wt" || -z "$open_branch" || ! -d "$open_wt" ]]; then
    echo "herd-spawn: --open-worktree could not open the worker's worktree (ensure-worktree exit ${open_rc}): $(printf '%s' "$open_out" | tail -3 | tr '\n' ' '); the worker ${name} was not started" >&2
    exit 2
  fi
  cwd="$open_wt"
  vars=("WORKTREE=${open_wt}" "BRANCH=${open_branch}" "PRIMARY=${open_primary}" ${vars[@]+"${vars[@]}"})
  open_has_title=no
  for kv in ${vars[@]+"${vars[@]}"}; do
    if [[ "${kv%%=*}" == "TITLE" ]]; then
      open_has_title=yes
    fi
  done
  [[ "$open_has_title" == "yes" ]] || vars+=("TITLE=${open_title}")
  echo "herd-spawn: opened ${open_wt} on ${open_branch} for ${name} (owner key $(iso_safe_text "$open_key" || echo '?'))" >&2
fi
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
# The repository the worker's report will be judged in: the spawn's own answer, recorded
# below as $HERD_DIR/.repos/<name> and passed by the hook as `appl-verify.sh --repo`, so
# the report is never asked where it landed. A cwd in no repository means a worker that
# could never be verified, so it is not started -- before herdr is asked anything
# (coordinator ruling 2026-09-24). After the codex rule, whose refusal is the sharper one.
spawn_repo="$(iso_primary_of "$cwd" 2>/dev/null)" && [[ "$spawn_repo" == /* ]] || {
  echo "herd-spawn: ${cwd} is not inside a git repository, so there is no repository to verify the worker's report in; the worker ${name} was not started" >&2
  exit 2
}
# The skill scripts dir the worker runs, by the one shared rule: bin/appl's resolve_skill,
# asked through `appl scripts-dir` in the worker's cwd -- a committed vendored skill gives
# the primary's copy, none plus an appl.toml pin gives ~/.appl/<v>'s. It fills {{SCRIPTS}}
# in the brief, names finish-worktree.sh in the claude and cursor allow rules and is
# recorded in run.json as scripts_dir. A missing or symlinked pinned dir is refused here,
# before anything is written. A copy of this script with no bin/appl beside it (a vendored
# skill) keeps the primary's dir, as before. So does the resolver's own fallback (no
# vendored skill and no pin: the launcher's copy, this script's dir), which a later item
# replaces: the dir stays <primary>/.cursor/skills/isolated-session/scripts, unchanged.
spawn_appl="$here/../../../../bin/appl"
spawn_scripts=""
if [[ -f "$spawn_appl" && ! -L "$spawn_appl" ]]; then
  spawn_scripts="$(cd "$cwd" && bash "$spawn_appl" scripts-dir)" && [[ "$spawn_scripts" == /* ]] || {
    echo "herd-spawn: the shared resolver gave no skill scripts dir for ${cwd}; the worker ${name} was not started" >&2
    exit 2
  }
fi
if [[ -z "$spawn_scripts" || "$spawn_scripts" == "$(cd "$here" && pwd -P)" ]]; then
  spawn_scripts="$(cd "$spawn_repo" && pwd -P)/.cursor/skills/isolated-session/scripts" || exit 2
fi
unset spawn_appl
# A cursor worker (and a grok one) never starts in a primary: the
# rules file and instruction files live in the directory it opens. A cursor test author
# with no --cwd was moved into the worktree the spawn opened above, on the
# --open-worktree path, so this check sees that worktree. `iso_primary_of "$cwd"
# == "$cwd"` alone admitted <primary>/<subdir> (finding 2 of secrev-add-grok-harness-to-bb14),
# so the cwd is held to the codex form: a .git file, its `pwd -P` its own worktree top
# level, and that resolved path not the primary. Judged here, before the hold hand-over,
# before anything is written under HERD_DIR and before herdr is asked anything. A cursor
# coordinator's cwd is the primary by design and is not judged here.
if { [[ "$harness" == "cursor" && "$profile" != "coordinator" ]] || [[ "$harness" == "grok" ]]; }; then
  cwd_real="$(cd "$cwd" && pwd -P)" || cwd_real=""
  cwd_top="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" &&
    cwd_top="$(cd "$cwd_top" && pwd -P)" || cwd_top=""
  cwd_primary="$(iso_primary_of "$cwd" 2>/dev/null)" &&
    cwd_primary="$(cd "$cwd_primary" && pwd -P)" || cwd_primary=""
  if [[ ! -f "$cwd/.git" || -z "$cwd_real" || "$cwd_top" != "$cwd_real" ||
        -z "$cwd_primary" || "$cwd_primary" == "$cwd_real" ]]; then
    echo "herd-spawn: a ${harness} session starts only at the root of a linked worktree, never in a primary checkout or a subdirectory of one (${cwd}): its rules and instruction files live in the directory it opens; pass --cwd <worktree>; the worker ${name} was not started" >&2
    exit 2
  fi
fi
# Every order entry, not only the one this spawn starts on. A later entry that
# would be refused as the first entry is refused by name here, before herdr is
# asked anything. Release keeps the list only for this judgment (it starts on
# no entry from it). HERD_SPAWN_HARNESS does not walk the order, so it does
# not judge entries it will not take.
refuse_order_entries() {
  local i n eh cwd_real cwd_top cwd_primary cwd_bad
  local cursor_author_can_open ca_first ca_title ca_blocked kv
  cwd_bad=no
  cursor_author_can_open=no
  cwd_real="$(cd "$cwd" && pwd -P)" || cwd_real=""
  cwd_top="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" &&
    cwd_top="$(cd "$cwd_top" && pwd -P)" || cwd_top=""
  cwd_primary="$(iso_primary_of "$cwd" 2>/dev/null)" &&
    cwd_primary="$(cd "$cwd_primary" && pwd -P)" || cwd_primary=""
  if [[ ! -f "$cwd/.git" || -z "$cwd_real" || "$cwd_top" != "$cwd_real" ||
        -z "$cwd_primary" || "$cwd_primary" == "$cwd_real" ]]; then
    cwd_bad=yes
  fi
  # A cursor test author with no --cwd is not refused for the primary: the
  # spawn opens the pair's worktree and moves there before that check. A
  # cursor entry in the order would take that same path as the first entry,
  # so it is not a primary refusal. A --cwd, a caller --open-worktree, a
  # missing title or key, or any other brief still is.
  if [[ "$cwd_bad" == "yes" && "$profile" == "worker" && "$open_given" != "yes" &&
        "$cwd_given" != "yes" && -n "$caller_key" ]]; then
    ca_first=""
    IFS= read -r ca_first < "$brief" || true
    case "$ca_first" in
      "You are a Muretai test-author session"*)
        ca_title=""
        ca_blocked=no
        for kv in ${vars[@]+"${vars[@]}"}; do
          case "${kv%%=*}" in
            TITLE) ca_title="${kv#*=}" ;;
            WORKTREE|BRANCH|PRIMARY) ca_blocked=yes ;;
          esac
        done
        if [[ -z "$ca_title" || "$ca_title" == "{{TITLE}}" ]]; then
          ca_title="$(python3 -I - "$brief" <<'PY'
import re, sys
try:
    text = open(sys.argv[1], encoding="utf-8").read()
except (OSError, UnicodeDecodeError):
    sys.exit(0)
m = re.search(r'ensure-worktree\.sh "([^"\n]*)"', text)
if m and m.group(1) and m.group(1) != "{{TITLE}}":
    sys.stdout.write(m.group(1))
PY
)"
        fi
        if [[ "$ca_blocked" == "no" && -n "$ca_title" && "$ca_title" != "{{TITLE}}" ]]; then
          cursor_author_can_open=yes
        fi
        ;;
    esac
  fi
  n=${#order_judge_h[@]}
  i=0
  while [[ "$i" -lt "$n" ]]; do
    eh="${order_judge_h[$i]}"
    if [[ "$eh" == "grok" && "$profile" == "reviewer" ]]; then
      echo "herd-spawn: the grok harness reviews nothing yet: which instruction files grok reads from the directory it opens has not been measured, so a reviewer would obey files this spawn does not own; the worker ${name} was not started" >&2
      exit 2
    fi
    if [[ "$eh" == "codex" && "$profile" == "reviewer" ]]; then
      echo "herd-spawn: the codex harness reviews nothing: it has no per-command deny list (its wall is the sandbox and the approval policy), and a reviewer reads a diff an attacker may have authored in full; the worker ${name} was not started" >&2
      exit 2
    fi
    if [[ "$eh" == "codex" && "$profile" == "coordinator" ]]; then
      echo "herd-spawn: the codex harness does not take the coordinator profile: it has no per-command deny list and no session-guard hook, so the spawn cannot write this pane's allow and deny or register appl-hook.sh on it alone; the worker ${name} was not started" >&2
      exit 2
    fi
    if [[ "$eh" == "grok" && "$profile" == "coordinator" ]]; then
      echo "herd-spawn: the grok harness does not take the coordinator profile: which instruction files it reads has not been measured, and appl-hook.sh has no per-pane slot on it (the hook is written only into the claude --settings file); the worker ${name} was not started" >&2
      exit 2
    fi
    if [[ "$profile" == "release" && "$eh" != "claude" && "$eh" != "cursor" ]]; then
      echo "herd-spawn: the ${eh} harness does not take the release profile: only the claude and cursor harnesses are pinned to hold its deny-everything-but-VERSION-and-CHANGELOG.md rules, and a weaker release wall is not emitted; the worker ${name} was not started" >&2
      exit 2
    fi
    if [[ "$eh" == "grok" && "$wall_mode" == "off" ]]; then
      echo "herd-spawn: HERD_WALL=off does not apply to the grok harness: a grok worker runs only behind the wall, never unwalled; unset HERD_WALL; the worker ${name} was not started" >&2
      exit 2
    fi
    if [[ "$cwd_bad" == "yes" ]]; then
      if [[ "$eh" == "cursor" && "$cursor_author_can_open" == "yes" ]]; then
        :
      elif { [[ "$eh" == "cursor" && "$profile" != "coordinator" ]] || [[ "$eh" == "grok" ]]; }; then
        echo "herd-spawn: a ${eh} session starts only at the root of a linked worktree, never in a primary checkout or a subdirectory of one (${cwd}): its rules and instruction files live in the directory it opens; pass --cwd <worktree>; the worker ${name} was not started" >&2
        exit 2
      fi
    fi
    i=$((i + 1))
  done
}
if [[ "$harness_from_caller" == "no" && ${#order_judge_h[@]} -gt 0 ]]; then
  refuse_order_entries
fi
# A cursor worker's own project state (intake 20261007T161448Z). cursor-agent mkdirs one
# directory under <HOME>/.cursor/projects first thing and dies with EPERM when the wall
# gives it no write there. The name is the slug of the workspace realpath (every run of
# characters outside [A-Za-z0-9-] one '-', a '-' at either end dropped). Measured on
# cursor-agent 2026.10.16-e3cb207: --trust writes .workspace-trusted in the uncut slug
# (paths.js Xq). Startup mkdirs a second directory when that joined path is longer than
# 91 characters (paths.js kL): the first 83 characters, a hyphen, and the first 7 hex
# digits of sha256 of the uncut path. Measured 2026-10-18, a long agent-entry-go
# worktree died `EPERM mkdir .../Users-mkt-agent-entry-go-worktrees-the-anonymous-lane-a-4738983`
# because the wall allow-wrote the 2026.10.01 cut (longer than 92, first 84). Allowing
# only the cut directory is the old failure ("Failed to trust workspace"): --trust
# still writes the uncut one.
# Both are made HERE, mode 700, outside the wall, when they differ. A projects directory
# longer than 84 falls back to <HOME>/.cursor, then to /tmp/.cursor. The trust record
# for --add-dir is the same pair on HERD_DIR/<name>. Each component must be a real
# directory, and the last one ours: a symlink or a non-directory is exit 2, never
# followed into an allow-write line -- before herdr is asked anything and before any
# sandbox starts.
cursor_project=""
if [[ "$harness" == "cursor" && "$profile" != "coordinator" && -n "${HOME:-}" ]]; then
  IFS= read -r -d '' cursor_project_src <<'PY' || true
import hashlib, os, re, stat, sys
home, cwd, name = os.environ["HS_HOME"], os.environ["HS_CWD"], os.environ["HS_NAME"]

def cursor_joined(home_path, workspace):
    home_r = os.path.realpath(home_path)
    base = os.path.join(home_r, ".cursor", "projects")
    if len(base) > 84:
        base = os.path.join(home_r, ".cursor")
        if len(base) > 84:
            base = "/tmp/.cursor"
    slug = re.sub(r"[^A-Za-z0-9-]+", "-", os.path.realpath(workspace)).strip("-")
    if not slug:
        return ""
    return os.path.join(base, slug)

def cursor_real(full):
    # cursor-agent's own fallback, when even <HOME>/.cursor is longer than 84 characters,
    # is the string /tmp/.cursor. On macOS /tmp is a symlink, and an allow path has to be
    # the real directory, so the suffix is kept and only that prefix is rewritten. The
    # sha256 in the 92-character cut is of the string BEFORE this rewrite: that is the
    # string paths.js hashes.
    if full == "/tmp" or full.startswith("/tmp/"):
        root = os.path.realpath("/tmp")
        if root != "/tmp":
            return root + full[len("/tmp"):]
    return full

def cursor_project_dir(home_path, workspace):
    raw = cursor_joined(home_path, workspace)
    return cursor_real(raw) if raw else ""

def cursor_state_dir(home_path, workspace):
    # paths.js kL, cursor-agent 2026.10.16-e3cb207. The uncut joined path, unless it
    # is longer than 91 characters: then the first 83, a hyphen, and sha256 of the
    # uncut path's first 7 hex digits. The hash is of the string before /tmp is
    # rewritten. For /Users/mkt that cut keeps 55 characters of the slug.
    raw = cursor_joined(home_path, workspace)
    if not raw:
        return ""
    if len(raw) > 91:
        raw = raw[:min(83, len(raw))] + "-" + hashlib.sha256(raw.encode()).hexdigest()[:7]
    return cursor_real(raw)

def make_ours(path):
    acc = ""
    for part in path.split("/"):
        if part == "":
            continue
        acc = acc + "/" + part
        if os.path.lexists(acc):
            st = os.lstat(acc)
            # /tmp is a symlink to a directory on macOS. cursor-agent's own fallback, when
            # even <HOME>/.cursor is longer than 84 characters, is the string /tmp/.cursor,
            # so that one intermediate link is the path it mkdirs. Every other symlink, and
            # a symlink at the final directory, is still refused.
            if stat.S_ISLNK(st.st_mode) and acc != path and acc == "/tmp" and os.path.isdir(acc):
                continue
            if not stat.S_ISDIR(st.st_mode) or (acc == path and st.st_uid != os.getuid()):
                print("herd-spawn: %s is a symlink, not a directory, or not yours; a cursor worker's project state is "
                      "never followed through one -- remove it; the worker %s was not started" % (acc, name),
                      file=sys.stderr)
                sys.exit(2)
        else:
            os.mkdir(acc, 0o700)

p = cursor_project_dir(home, cwd)
state = cursor_state_dir(home, cwd)
if not p or not state:
    print("herd-spawn: %s gives cursor-agent no project slug; the worker %s was not started" % (cwd, name),
          file=sys.stderr)
    sys.exit(2)
make_ours(p)
if state != p:
    make_ours(state)
print(p)
PY
  cursor_project="$(HS_HOME="$HOME" HS_CWD="$cwd" HS_NAME="$name" python3 -I -c "$cursor_project_src")" || exit 2
fi

# --- herdr: on PATH (or HERD_SPAWN_BIN) and its server up, else exit 3 ---------------
# (a render never looks: it asks herdr nothing, so herdr need not be there)
[[ "$render" == "yes" ]] || find_herdr

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
# the rejected oauth-token file's reason word (fixed vocabulary, never the value) in the
# coordinator's log: appended, never through a link, and only into a coordinator
# directory that already exists -- a missing one is not made here, and a log line that
# cannot be written costs the spawn nothing (stderr already said it)
if [[ -n "$oauth_why" ]]; then
  python3 -I - "$herd_dir/coordinator" "$oauth_why" <<'PY' 2>/dev/null || true
import os, stat, sys, time
coord, why = sys.argv[1], sys.argv[2]
st = os.lstat(coord)
if stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid():
    fd = os.open(os.path.join(coord, "coordinator.log"),
                 os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a", encoding="ascii") as f:
        f.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " oauth-token rejected " + why + "\n")
PY
fi
# the key a live worker holds is not handed to a second one. With --open-worktree this is
# judged after the open: ensure-worktree.sh already refuses a lock handed to another worker
# by name, and says so; an open is never the pair hand-over.
#
# ... and a key the worktree's lock does not carry is not handed in at all
# (ISSUE(spawn-hands-a-key-that-does-not-match-the-lock)): a worker spawned with --cwd into a
# linked worktree whose lock names another owner could never pass assert-head there, and it
# would sit idle in its pane with nothing said. Exact strings: `claude:<k>` and `<k>` are two
# keys. The primary, a worktree with no lock and a spawn with no caller key are left as they
# were; so is --open-worktree, whose open judges the lock itself.
if [[ -n "$caller_key" && "$open_given" != "yes" && -f "$cwd/.git" ]] &&
   [[ "$(iso_primary_of "$cwd" 2>/dev/null || true)" != "$cwd" ]]; then
  cwd_lock="$(iso_lock_path "$cwd" 2>/dev/null || true)"
  if [[ -n "$cwd_lock" && -f "$cwd_lock" && ! -L "$cwd_lock" ]]; then
    cwd_lock_owner="$(iso_lock_get "$cwd_lock" owner)"
    if [[ -n "$cwd_lock_owner" && "$cwd_lock_owner" != "$caller_key" ]]; then
      echo "herd-spawn: the lock of ${cwd} is owned by $(iso_safe_text "$cwd_lock_owner" || echo '?'), not by the owner key $(iso_safe_text "$caller_key" || echo '?') this spawn hands over; a worker under that key could never pass assert-head there -- spawn it under the key the lock carries (the author's \$HERD_DIR/.keys/<author> record); the worker ${name} was not started" >&2
      exit 2
    fi
  fi
fi
# (a render hands no key to a worker, so it is not judged against live ones, and herdr is
# not asked who is live)
if [[ -n "$caller_key" && "$render" != "yes" ]]; then
  if [[ "$open_given" == "yes" ]]; then
    key_guard "$caller_key" "$cwd" no
  else
    key_guard "$caller_key" "$cwd" yes
  fi
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
own_dir "$herd_dir/.roles"
own_dir "$herd_dir/.repos"
own_dir "$herd_dir/.keys"
own_dir "$herd_dir/${name}"
role_marker="$herd_dir/${name}/role"
role_record="$herd_dir/.roles/${name}"
repo_record="$herd_dir/.repos/${name}"
key_record="$herd_dir/.keys/${name}"
report="$herd_dir/${name}/report.md"
rendered="$herd_dir/briefs/${name}.md"
perms="$herd_dir/${name}/permissions.json"
bfile="$herd_dir/${name}/brief.md"
# Something at brief.md that is NOT a regular file -- a symlink (dangling or not; -L
# first, since -e and -f follow one) or a directory -- is a refusal, judged before the
# brief is even rendered, so nothing under HERD_DIR changes: it is never followed,
# replaced or prompted. A REGULAR brief.md (a previous spawn of this name, or a plant) is
# rewritten by the render below. (The render re-checks, for one that appears in between.)
if [[ -L "$bfile" ]] || { [[ -e "$bfile" ]] && [[ ! -f "$bfile" ]]; }; then
  echo "herd-spawn: ${bfile} is a symlink or not a regular file; brief.md is never written through or over one -- remove it if the name is yours to re-spawn; the worker ${name} was not started" >&2
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
# A cursor coordinator's config directory is private only when it is a real directory
# under this pane, owned by the caller, and not the user's ~/.cursor or <cwd>/.cursor.
# A symlink is refused before it is followed: the slot the test plants points into the
# shared rules, and replacing it would be writing through that link.
cursor_slot_is_private() {
  local slot="$1" resolved pane shared user
  if [[ -L "$slot" || ( -e "$slot" && ! -d "$slot" ) ]]; then
    return 1
  fi
  if [[ -d "$slot" ]]; then
    [[ -O "$slot" ]] || return 1
    resolved="$(cd "$slot" && pwd -P)" || return 1
    pane="$(cd "$herd_dir/${name}" && pwd -P)" || return 1
    case "$resolved/" in
      "$pane"/*) ;;
      *) return 1 ;;
    esac
    if [[ -d "$cwd/.cursor" ]]; then
      shared="$(cd "$cwd/.cursor" && pwd -P)" || return 1
      case "$resolved/" in
        "$shared"/*) return 1 ;;
      esac
    fi
    if [[ -n "${HOME:-}" && -d "${HOME}/.cursor" ]]; then
      user="$(cd "${HOME}/.cursor" && pwd -P)" || return 1
      case "$resolved/" in
        "$user"/*) return 1 ;;
      esac
    fi
  fi
  return 0
}
cursor_coord_refuse() {
  echo "herd-spawn: the cursor harness cannot register appl-hook.sh on this pane alone: ${name}'s CURSOR_CONFIG_DIR is not a private directory, so the pane would read the shared <cwd>/.cursor/cli.json; the worker ${name} was not started" >&2
  exit 2
}
if [[ "$harness" == "cursor" ]]; then
  if [[ "$profile" == "coordinator" ]]; then
    # The pane's own config home, not the user's and not the checkout's. The allow/deny
    # and the appl-hook registration are written into it later, once the lists exist.
    # The user's ~/.cursor/cli-config.json is not consulted: this directory is allowlist
    # because we write it, and a coordinator's cwd is the primary.
    cursor_home="$herd_dir/${name}/cursor-config"
    cursor_slot_is_private "$cursor_home" || cursor_coord_refuse
    if [[ ! -d "$cursor_home" ]]; then
      mkdir -m 700 "$cursor_home" 2>/dev/null || cursor_coord_refuse
    fi
    [[ -L "$cursor_home" ]] && cursor_coord_refuse
    chmod 700 "$cursor_home" 2>/dev/null || cursor_coord_refuse
    cursor_slot_is_private "$cursor_home" || cursor_coord_refuse
    # Honest limit: cursor-agent has no switch that drops the user's rules and skills.
    # Said where the person spawning reads it, and again in wall.log below.
    cursor_rules_note="cursor: this pane reads the user's own rules and skills (~/.cursor/rules, ~/.agents/skills); cursor-agent has no switch to leave them out"
    echo "$cursor_rules_note" >&2
    agent_args=(--trust --workspace "$cwd" --add-dir "$herd_dir/${name}")
    [[ -z "$model" ]] || agent_args+=(--model "$model")
    typed="cursor-agent ${agent_args[*]}"
  else
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
  # its config dir as CURSOR_CONFIG_DIR, else XDG_CONFIG_HOME/cursor, else ~/.cursor. The
  # worker's tab is handed a CURSOR_CONFIG_DIR of its own, $HERD_DIR/.cursor-homes/<name>.<unique>, seeded
  # below once the name is this spawn's: cursor-agent rewrites cli-config.json by a temp
  # file and a rename, and the wall never opens ~/.cursor to that. The user's file is still
  # checked here, as the belt: armed, it refuses every cursor spawn and every --resume.
  cursor_cfg="${HOME:-}/.cursor/cli-config.json"
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
  fi
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
elif [[ "$harness" == "grok" ]]; then
  # Like cursor: the instruction files grok reads live in the directory it opens, so the
  # cwd is never the primary. --cwd is grok's flag for that directory (measured on
  # grok 1.0.41). The allow and deny rules are appended once the lists exist, below.
  #
  # The permission mode is pinned on the argv, `--permission-mode auto`, never left to the
  # user's config: grok otherwise takes `[ui] permission_mode` from its config.toml, which
  # on the owner's Mac is always-approve, and under that only the deny rules bind
  # (ISSUE(security-audit-2026-10-09-pin-the-grok-worker-17c7), intake 20261009T161252Z).
  # `--always-approve` is never passed. Spelling: notes/grok-rule-spelling.md. Whether the
  # flag beats the config key is not measured, so the belt: a config.toml (or a
  # requirements.toml) in the effective grok home whose `[ui] permission_mode` is empty or
  # bypass-shaped, or a requirements.toml whose `[ui] yolo` is true, refuses the spawn here,
  # before the wall and before herdr. A missing file, a missing key or a non-bypass value
  # goes on. The way cursor's armed-config check refuses, above. The home checked is the
  # home the tab is handed, as GROK_HOME (tab_env, below), and a caller's --env GROK_HOME is
  # refused where --env is parsed: grok never runs from a home nobody checked
  # (intake 20261009T202249Z). The check runs again just before the tab opens.
  grok_home="${GROK_HOME:-${HOME:-}/.grok}"
  if [[ "$grok_home" != /* ]]; then
    echo "herd-spawn: GROK_HOME (or HOME) is not an absolute path, so the grok home the check reads and the one the tab is handed could differ; the worker ${name} was not started" >&2
    exit 2
  fi
  grok_home_check() {
    local grok_cfg why
    for grok_cfg in "$grok_home/config.toml" "$grok_home/requirements.toml"; do
      [[ -e "$grok_cfg" || -L "$grok_cfg" ]] || continue
      if ! why="$(grok_cfg_bypassed "$grok_cfg")"; then
        why="$(iso_safe_text "$why" || echo 'a value that cannot be printed')"
        echo "herd-spawn: ${grok_cfg}: ${why}${1:-}; a grok worker would run every command its deny list does not name with no prompt, so the worker ${name} was not started" >&2
        exit 2
      fi
    done
  }
  grok_home_check
  if [[ "$(iso_primary_of "$cwd" 2>/dev/null || true)" == "$cwd" ]]; then
    echo "herd-spawn: a grok session does not start in the primary checkout: its instruction files live in the directory it opens, so a primary would be this repository's own; pass --cwd <worktree>; the worker ${name} was not started" >&2
    exit 2
  fi
  agent_args=(--cwd "$cwd" --permission-mode auto)
  [[ -z "$model" ]] || agent_args+=(--model "$model")
  typed="grok ${agent_args[*]}"
else
  agent_args=(--permission-mode "$permission_mode" --model "$model" --add-dir "$herd_dir/${name}"
              --settings "$perms" --setting-sources project --strict-mcp-config)
  # The reviewer's tool set is declared, never left to whatever the installed claude
  # ships: a landing reviewer stopped BLOCKED at step 1 on "No such tool available: Grep"
  # (intake 20261006T182544Z). It holds every tool the reviewer brief's steps name (Read,
  # Grep, Agent), Bash for its commands, Write and Edit for its notes and report, and Glob
  # for the personas' Read/Grep/Glob, since a subagent has no tool its parent lacks. No
  # spaces, so it is one word on the typed line. tests/test_reviewer_brief_tools.py.
  if [[ "$profile" == "reviewer" ]]; then
    agent_args+=(--tools Agent,Bash,Edit,Glob,Grep,Read,Write)
  fi
  typed="claude ${agent_args[*]}"
fi
if [[ ${#typed} -gt 900 ]]; then
  echo "herd-spawn: the command herdr would type is ${#typed} characters (bound 900; a pty drops typed input past about 1 KB) -- shorten HERD_DIR (${herd_dir}); the worker ${name} was not started" >&2
  exit 2
fi
# ... and the one line the worker is told, under the same bound for the same reason (with
# the default HERD_DIR and a 32-character name it is under 300 characters)
prompt_line="$(first_line_for "$harness" "$bfile" "$report")"
if [[ ${#prompt_line} -gt 900 ]]; then
  echo "herd-spawn: the prompt herdr would type is ${#prompt_line} characters (bound 900) -- shorten HERD_DIR (${herd_dir}); the worker ${name} was not started" >&2
  exit 2
fi

# --- the wall and the bounds ------------------------------------------------------------
# P1 ISSUE(workers-have-no-resource-limit-and-no-egress-control). Until this block, every
# timeout here bounded the spawn HANDSHAKE and nothing bounded a worker once it ran, and
# the only thing between a worker and `keys/` was a deny list, which is not containment.
# The publisher, one directory away, already scans under sandbox-exec and PROBES that its
# wall stands before it trusts it; this is that, ported, and the probe is the half that
# matters.
#
# THE WALL (claude `worker` and `reviewer` sessions, and a cursor or grok `worker` session). A plug per platform,
# scripts/walls/<uname -s, lowercased>.sh, answers `available` and
# `exec <profile> -- <cmd...>` (walls/darwin.sh: Seatbelt). This script owns the rest: the
# mode, the profile, the probe, the bounds and the record. The profile is NEUTRAL (one verb
# and one path per line) and is written to $HERD_DIR/walls/<name>/profile; wall v1 denies
# READS of the primary checkout's keys/ and of ~/.muretai/bindings, and WRITES anywhere but
# the worker's own places -- its cwd, its $HERD_DIR/<name>/ (never its brief.md or its
# permissions.json), git's common directory (never its hooks/ or config), the temporary
# directories, and ~/.claude -- and the two places its JOB writes: ~/.cache/muretai-tests
# (the fixture root the test files hard-code) and $HERD_DIR/coordinator/intake (where
# tools/appl-add.sh files an intake). Those two exactly, never HERD_DIR or ~/.cache whole;
# the spawn creates them mode 700 before rendering, since the worker cannot. ~/.muretai
# stays readable and unwritable. The network stays OPEN in v1 (`egress=open` on the success
# line and in wall.log, so nobody reads "walled" as "offline"); HERD_WALL_EGRESS=deny is
# refused above until the v2 proxy exists.
#   Deliberate holes, for v2 to revisit: the walled agent may write ~/.claude (the harness
#   keeps its session state there and does not start without it -- and a write there can
#   plant instructions for a LATER session), and the `coordinator` profile is never walled
#   (its whole job is dms and inbox reads through the node: the network and the bindings).
#   A cursor worker uses this same plug and the same darwin.sb.template. Its profile is the
#   claude worker's, plus two allows under <HOME>/.cursor: the worktree's project directory
#   and the directory of this worker's own trust record, the slug of HERD_DIR/<name>.
#   Nothing else there. wall=walled is recorded only after that probe's sandbox-exec holds;
#   when the wall cannot be built, require mode exits before any worker= line. A grok worker
#   gets the claude worker's profile with ~/.grok in place of ~/.claude, and nothing else
#   (intake 20261008T161926Z); it is never started unwalled: HERD_WALL=off is refused and
#   prefer is held to require. Codex stays unwalled in v1 (it brings a sandbox of its own,
#   and sandbox-exec does not nest under one); wall.log says why, per spawn.
# THE PROBE runs before herdr is asked for a tab, through the SAME plug with the SAME
# profile the agent later gets, from a scratch directory inside HERD_DIR that is removed
# afterwards. It tries to list the two directories; either one it can see into is a leak.
# It also trials a write into each of the job's two places; one it cannot write means the
# wall stands but the worker could not do its job.
# HERD_WALL=require (the default, including where there is no plug): a leak, a plug that
# cannot build the wall, a probe that did not finish, or a job the wall denies is exit 2
# on one line naming what leaked or what the worker could not do,
# with no tab, no agent and no brief. prefer, only when set explicitly: the same
# findings are ONE warning line and the worker runs unwalled, recorded. off: unwalled,
# recorded. No variable skips the probe.
# INHERITED: a spawn that itself runs behind a wall (a walled worker's test that spawns)
# cannot build another -- sandbox-exec does not nest. When the plug says so, the plug's
# `exec` marker HERD_WALL_INSIDE is set, AND the plug's `inside` verb confirms a wall
# around this process, the worker starts `wall=inherited why=inside:<name>`, with the
# bounds and no new profile; run.py asks `inside` again before it starts the agent. A
# missing plug is still a refusal, marker or not, and so is a marker `inside` denies.
# THE BOUNDS hold in every mode, for every profile but the coordinator (which lives for
# days): cpu seconds per process, memory of the worker's tree, processes in the worker's
# tree (above). A launcher enforces them from OUTSIDE the wall: the tab's PATH starts with
# $HERD_DIR/walls/<name>/bin, whose one file is named for the harness binary and execs
# run.py; run.py sets RLIMIT_CPU on its child, starts the agent through the plug (or
# directly, unwalled), watches the tree -- kqueue fork events and libproc on macOS, /proc
# elsewhere -- and on a breach stops and kills the whole tree and appends a `killed` line
# naming the bound to wall.log. Measured on macOS 26: RLIMIT_AS/DATA/RSS are refused and
# RLIMIT_NPROC counts every process of the uid, so memory and the process cap cannot be
# rlimits there; only the CPU bound is.
# THE GATE. A walled worker cannot run the landing's gate (a suite that builds a wall,
# walks the process tree or writes beside its HERD_DIR entry dies of the wall, and the
# fast-forward writes the primary), so the same launcher serves the worker's LANDING from
# outside the wall: finish-worktree.sh, walled, writes a request into $HERD_DIR/<name>/, and
# run.py runs the PRIMARY's finish-worktree.sh unwalled on the branch and worktree recorded
# here at spawn (run.json `gate`), then hands the receipt back with a GATE= line saying so.
# The request is judged, never obeyed; see run.py's Gate. The worker stays walled.
# Everything the launcher runs is COPIED into $HERD_DIR/walls/<name>/ at spawn -- the
# plug, its templates and run.py -- where the walled worker cannot write (walls/ is on no
# allow-write line). The script this block lives in may run from a worktree the worker can
# edit, or from the landing's temporary copy that is deleted after the spawn.
#
# THE OWNER KEY (ISSUE(walled-worker-cannot-claim-a-worktree)). Behind wall v1 `ps` cannot
# run (/bin/ps is setuid, and a Seatbelt-walled process cannot exec it), so the process walk
# that names a keyless session's owner has no answer there, and iso_owner_pid refuses. A
# walled (or inherited-wall) worker is therefore ALWAYS given a stable key on its tab:
# the caller's `--env ISOLATED_SESSION_OWNER=<k>` when there is one -- and then that entry
# alone, never a second beside it, which would leave the value to herdr's dedup order --
# else the worker's own name. Every lock of the repository that key already owns is handed
# over below, exactly as the pair hand-over does. And the probe proves the claim works:
# behind the same wall, before any tab exists, claim-worktree.sh and assert-head.sh run
# under that key against a THROWAWAY repository in the worker's own directory (removed
# afterwards); a wall under which they fail is a finding like a leak.
owner_key=""
owner_key_from_caller=no
for kv in ${envs[@]+"${envs[@]}"}; do
  if [[ "${kv%%=*}" == "ISOLATED_SESSION_OWNER" ]]; then
    owner_key="${kv#*=}"
    owner_key_from_caller=yes
  fi
done
[[ "$owner_key_from_caller" == "yes" ]] || owner_key="$name"
wall_scope=walled
bounded=yes
if [[ "$profile" == "coordinator" ]]; then
  wall_scope=coordinator
  bounded=no
elif [[ "$harness" == "codex" ]]; then
  # cursor and grok workers share the claude wall (wall_scope stays walled). A cursor
  # coordinator already took the branch above. Codex stays out: it brings a wall of its own.
  wall_scope="harness-${harness}"
fi
case "$harness" in
  cursor) agent_cmd="cursor-agent" ;;
  *) agent_cmd="$harness" ;;
esac
wall_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
walls_dir="$herd_dir/walls"
wall_dir="$walls_dir/${name}"
own_dir "$walls_dir"
own_dir "$wall_dir"
own_dir "$wall_dir/bin"
# A grok worker's wall entry lives in walled/, off the tab's PATH: bin/grok is the shim that
# runs the argv launcher, and the launcher execs walled/grok (ruling 20261012T085833Z).
[[ "$harness" != "grok" ]] || own_dir "$wall_dir/walled"
# THE REVIEWER'S RECEIPT WRAPPER in a repository that does not carry it (intake
# 20261028T210325Z). A reviewer whose checkout has no regular
# .cursor/skills/isolated-session/scripts/write-receipt.sh gets walls/<name>/write-receipt.sh,
# a byte copy of this script's own, mode 0500, where the walled reviewer cannot write. Its
# brief's receipt step and its one allow rule name that copy. The path is unlinked by its
# exact name (a planted symlink goes, its target stays) and created O_EXCL|O_NOFOLLOW. A
# checkout that carries this wrapper byte for byte gets no copy and keeps its relative
# rule; one whose wrapper differs gets the copy and loses the relative rule. A spawner
# with no write-receipt.sh beside it at all (the temporary copy security_daily.sh and a
# landing extract from a BASE that predates the wrapper, whose checkout lacks it too) has
# none to copy: the brief keeps the relative spelling, as before, and the spawn prints
# nothing about it, since tools/security_weekly.sh records the spawner's stderr with its
# stdout as the spawn line.
receipt_wall=""
receipt_differs=no
if [[ "$profile" == "reviewer" ]]; then
  receipt_rel=".cursor/skills/isolated-session/scripts/write-receipt.sh"
  if [[ ! -e "$here/write-receipt.sh" && ! -L "$here/write-receipt.sh" ]]; then
    :
  else
    # A checkout wrapper that differs from this one by any byte (an older vendored v0.1.x
    # one, which knows no pinned install and refused "needs tools/audit_scope.py", intake
    # 20261029T142027Z) gets the wall copy too. Beside the copy, write-receipt.tools names
    # this tree's tools dir, $here/../../../../tools, as the copy's last audit_scope.py
    # source; the copy's own bytes stay $here's, so a hand-placed copy with no such file
    # refuses as before. Exit 3: the checkout's wrapper is this one byte for byte; exit 4:
    # the copy is written and the checkout carries a regular wrapper that differs.
    rc=0
    HS_SRC="$here/write-receipt.sh" HS_DST="$wall_dir/write-receipt.sh" HS_NAME="$name" \
      HS_CO="$cwd/$receipt_rel" HS_TOOLS="$here/../../../../tools" python3 -I - <<'PY' || rc=$?
import os, stat, sys
src, dst, name = os.environ["HS_SRC"], os.environ["HS_DST"], os.environ["HS_NAME"]
try:
    st = os.lstat(src)
    if not stat.S_ISREG(st.st_mode):
        raise OSError("not a regular file")
    with open(src, "rb") as f:
        body = f.read()
except OSError as e:
    print("herd-spawn: %s could not be read (%s), so the reviewer %s, whose checkout lacks this write-receipt.sh, "
          "has no receipt wrapper; the worker %s was not started" % (src, e.strerror or e, name, name), file=sys.stderr)
    sys.exit(2)
co = os.environ["HS_CO"]
differs = False
try:
    if stat.S_ISREG(os.lstat(co).st_mode):
        with open(co, "rb") as f:
            if f.read() == body:
                sys.exit(3)
        differs = True
except OSError:
    pass
tools = os.path.realpath(os.environ["HS_TOOLS"])


def put(path, data, mode):
    if os.path.lexists(path):
        if stat.S_ISDIR(os.lstat(path).st_mode):
            print("herd-spawn: %s is a directory; the worker %s was not started" % (path, name), file=sys.stderr)
            sys.exit(2)
        os.unlink(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    os.fchmod(fd, mode)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


put(os.path.join(os.path.dirname(dst), "write-receipt.tools"), (tools + "\n").encode("utf-8"), 0o400)
put(dst, body, 0o500)
sys.exit(4 if differs else 0)
PY
    case "$rc" in
      0) receipt_wall="$wall_dir" ;;
      4) receipt_wall="$wall_dir"; receipt_differs=yes ;;
      3) ;;
      *) exit 2 ;;
    esac
    unset rc
  fi
  unset receipt_rel
fi
wall_py="$(command -v python3 2>/dev/null || true)"
wall_primary="$(iso_primary_of "$cwd" 2>/dev/null || true)"
[[ -n "$wall_primary" ]] || wall_primary="$cwd"
wall_common="$(cd "$cwd" && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
# run.py: the launcher (`run`) and the probe (`probe`), one stdlib file. It is here rather
# than beside this script because the landing runs this script from a temporary copy of
# herd-spawn.sh and lib.sh alone.
IFS= read -r -d '' wall_run_src <<'PY' || true
"""run.py -- written by herd-spawn.sh into $HERD_DIR/walls/<name>/. Two modes:

  run.py probe <word> <dir> [<word> <dir> ...]
      Run BEHIND the wall, before the worker exists. Prints each <word> whose <dir> it
      could see into (a leak), then `done`. A directory that is not there has nothing to
      leak; one it cannot stat or list is held. A <word> spelled `write:<job>` is the other
      half, the worker's JOB: it makes a directory in <dir>, writes a file there, reads it
      back and removes both; any step that fails prints `cannot-<job>`.
  run.py run <run.json> -- <agent args...>
      The launcher the tab's PATH finds first. Starts the harness binary (the next one on
      PATH after its own directory) through the plug, or directly when the spawn ran
      unwalled; puts RLIMIT_CPU on it; watches its process tree from OUTSIDE the wall; on a
      breach of the memory bound or the process cap stops and kills the whole tree, and
      writes `killed` and the bound to wall.log. A child that dies of SIGXCPU is the cpu
      bound, recorded the same way.
      A WALLED run also serves the worker's landing from outside the wall -- see Gate.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import errno
import json
import os
import resource
import select
import signal
import stat
import subprocess
import sys
import threading
import time

LOG = ""


def log(line: str) -> None:
    try:
        fd = os.open(LOG, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            os.write(fd, (time.strftime("%Y-%m-%dT%H:%M:%S%z") + " " + line + "\n").encode())
        finally:
            os.close(fd)
    except OSError:
        pass


def probe(args: list) -> int:
    for word, path in zip(args[0::2], args[1::2]):
        if word.startswith("write:"):
            d = os.path.join(path, ".herd-wall-probe-%d" % os.getpid())
            try:
                os.mkdir(d, 0o700)
                p = os.path.join(d, "probe")
                fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
                try:
                    os.write(fd, b"x")
                finally:
                    os.close(fd)
                with open(p, "rb") as f:
                    if f.read() != b"x":
                        raise OSError("read back")
                os.unlink(p)
                os.rmdir(d)
            except OSError:
                print("cannot-" + word[len("write:"):])
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue                      # absent: nothing to leak; EPERM/EACCES: held
        try:
            if stat.S_ISDIR(st.st_mode):
                os.listdir(path)
            else:
                with open(path, "rb") as f:
                    f.read(1)
        except OSError:
            continue
        print(word)
    print("done")
    return 0


class RUsage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in (
        "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins",
        "wired_size", "resident_size", "phys_footprint", "proc_start_abstime", "proc_exit_abstime")]


class Table:
    """The worker's process tree and its memory: libproc on macOS, /proc on Linux, ps
    anywhere else."""

    def __init__(self) -> None:
        self.lib = None
        if sys.platform == "darwin":
            try:
                self.lib = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib")
                self.lib.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
                self.lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
            except (OSError, AttributeError):
                self.lib = None
        self.proc = os.path.isdir("/proc/self/task")
        self.buf = (ctypes.c_int * 8192)()

    def _listpids(self, kind: int, arg: int) -> list:
        n = self.lib.proc_listpids(kind, arg, self.buf, ctypes.sizeof(self.buf))
        return [self.buf[i] for i in range(max(n, 0) // 4) if self.buf[i] > 0]

    def _ppid_map(self) -> dict:
        out = {}
        if self.proc:
            for d in os.listdir("/proc"):
                if d.isdigit():
                    try:
                        with open("/proc/%s/stat" % d) as f:
                            out[int(d)] = int(f.read().rsplit(")", 1)[1].split()[1])
                    except (OSError, ValueError, IndexError):
                        pass
            return out
        r = subprocess.run(["ps", "-A", "-o", "pid=", "-o", "ppid="], capture_output=True, text=True)
        for line in r.stdout.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                out[int(parts[0])] = int(parts[1])
        return out

    def tree(self, root: int) -> set:
        seen, todo = set(), [root]
        kids = None
        if self.lib is None:
            ppids = self._ppid_map()
            kids = {}
            for p, pp in ppids.items():
                kids.setdefault(pp, []).append(p)
        while todo:
            p = todo.pop()
            if p in seen:
                continue
            seen.add(p)
            todo.extend(self._listpids(6, p) if self.lib is not None else kids.get(p, []))  # 6: PROC_PPID_ONLY
        # a process group we lead (a pane's job) also holds what was orphaned out of the tree
        if self.lib is not None and os.getpgrp() == os.getpid():
            seen.update(self._listpids(2, os.getpid()))                                    # 2: PROC_PGRP_ONLY
        seen.discard(os.getpid())
        return seen

    def footprint(self, pids: set) -> int:
        total = 0
        for p in pids:
            if self.lib is not None:
                ru = RUsage()
                if self.lib.proc_pid_rusage(p, 0, ctypes.byref(ru)) == 0:           # 0: RUSAGE_INFO_V0
                    total += ru.phys_footprint
            elif self.proc:
                try:
                    with open("/proc/%d/statm" % p) as f:
                        total += int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
                except (OSError, ValueError, IndexError):
                    pass
            else:
                r = subprocess.run(["ps", "-o", "rss=", "-p", str(p)], capture_output=True, text=True)
                if r.stdout.strip().isdigit():
                    total += int(r.stdout.strip()) * 1024
        return total


def stop_and_kill(table: Table, root: int, also: set) -> None:
    """SIGSTOP first, the whole tree, until no new member appears -- a stopped parent
    cannot fork and its children stay its children, so the tree is still there to read --
    then SIGKILL every member."""
    seen = set()
    for _ in range(64):
        cur = table.tree(root) | {p for p in also if p != os.getpid()}
        new = cur - seen
        if not new:
            break
        for p in new:
            try:
                os.kill(p, signal.SIGSTOP)
            except OSError:
                pass
        seen |= new
    for p in seen:
        try:
            os.kill(p, signal.SIGKILL)
        except OSError:
            pass


NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
FINISH_REL = os.path.join(".cursor", "skills", "isolated-session", "scripts", "finish-worktree.sh")
SKILL_PARTS = (".cursor", "skills", "isolated-session", "scripts")


def shown(value) -> str:
    """A recorded value as text a log line and stderr can carry (a lone surrogate, too)."""
    if not isinstance(value, str):
        return repr(value)
    out = []
    for ch in value:
        o = ord(ch)
        if o < 32 or o == 127 or 0xD800 <= o <= 0xDFFF:
            out.append("\\x%02x" % o if o < 256 else "\\u%04x" % o)
        else:
            out.append(ch)
    return "".join(out)


def scripts_dir_refusal(cfg: dict) -> str:
    """Why the scripts dir run.json recorded at spawn may not run, or "" when it may.

    Its finish-worktree.sh runs UNWALLED, as the operator, so the dir is judged here,
    before the agent starts and again before each landing. Only the record counts: no
    env var, argument, worktree file or request key names it. The dir must be exactly
    ~/.appl/<v>/<skill> or the primary's vendored <skill>, with no symlink from ~/.appl
    (or the primary) down to finish-worktree.sh, each of them owned by this uid and
    writable by nobody else."""
    value = cfg.get("scripts_dir")
    if not isinstance(value, str) or not value:
        return "run.json records no scripts_dir (missing or not a path): %s" % shown(value)
    name = shown(value)
    head = "the recorded scripts dir %s" % name
    if "\x00" in value or not os.path.isabs(value) or os.path.normpath(value) != value:
        return "%s is outside the allowed roots: not a plain absolute path" % head
    try:
        if os.path.islink(value):
            return "%s is a symlink" % head
    except (ValueError, UnicodeError):
        return "%s is outside the allowed roots: not a usable path" % head
    gate = cfg.get("gate") if isinstance(cfg.get("gate"), dict) else {}
    primary = gate.get("primary") if isinstance(gate.get("primary"), str) else ""
    appl = os.path.join(os.path.expanduser("~"), ".appl")
    chain = []
    every = value.split("/")
    # (root, how many trailing names): ~/.appl/<v>/<skill>, or <primary>/<skill>. The prefix
    # left of those names is matched by realpath (a /tmp spelling of /private/tmp is the
    # same root); every name below it is walked as recorded, so a link there is refused.
    for root, n in ((appl, 1 + len(SKILL_PARTS)), (primary, len(SKILL_PARTS))):
        if not root or not os.path.isabs(root) or len(every) <= n:
            continue
        parts = every[-n:]
        if tuple(parts[-len(SKILL_PARTS):]) != SKILL_PARTS or parts[0] in ("", ".", ".."):
            continue
        prefix = "/".join(every[:-n]) or "/"
        try:
            if os.path.realpath(prefix) != os.path.realpath(root):
                continue
        except (OSError, ValueError, UnicodeError):
            continue
        chain = [prefix]
        for p in parts:
            chain.append(os.path.join(chain[-1], p))
        break
    if not chain:
        worktree = gate.get("worktree") if isinstance(gate.get("worktree"), str) else ""
        if worktree and (value + "/").startswith(worktree.rstrip("/") + "/"):
            return "%s is outside the allowed roots: it is the worker's own worktree copy" % head
        return ("%s is outside the allowed roots: neither ~/.appl/<v>/%s nor the primary's "
                "vendored %s" % (head, "/".join(SKILL_PARTS), "/".join(SKILL_PARTS)))
    uid = os.geteuid()
    for path in chain + [os.path.join(value, "finish-worktree.sh")]:
        try:
            st = os.lstat(path)
        except (OSError, ValueError, UnicodeError):
            return "%s does not exist: %s is missing" % (head, shown(path))
        if stat.S_ISLNK(st.st_mode):
            return "%s is refused: %s on its path is a symlink" % (head, shown(path))
        want = stat.S_ISREG if path.endswith("/finish-worktree.sh") else stat.S_ISDIR
        if not want(st.st_mode):
            return "%s is refused: %s is not a %s" % (
                head, shown(path), "regular file" if want is stat.S_ISREG else "directory")
        if st.st_uid != uid:
            return "%s is refused: %s is not owned by the current user (uid %d, owner %d)" % (
                head, shown(path), uid, st.st_uid)
        if st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            return "%s is refused: %s is group- or world-writable" % (head, shown(path))
    return ""


LAND_REL = "/".join(SKILL_PARTS + ("land.sh",))


def base_land_blob(gate: dict) -> tuple:
    """BASE's committed land.sh, read from the tip of the recorded base ref -- the commit the
    landing lands onto and extracts its gate from -- as ("", bytes); ("", None) when BASE
    carries none (a pinned consumer vendors no skill); (why, None) when BASE cannot be read."""
    common = gate.get("common_dir") if isinstance(gate.get("common_dir"), str) else ""
    ref = gate.get("base_ref") if isinstance(gate.get("base_ref"), str) else ""
    if not common or not ref or ref.startswith("-") or "\x00" in ref or "\x00" in common:
        return "the spawn record names no base to read BASE's land.sh from", None
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    tip = "refs/heads/" + ref
    try:
        rec = subprocess.run(["git", "--git-dir", common, "ls-tree", "-z", "--full-tree", tip, "--",
                              LAND_REL], capture_output=True, env=env, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        rec = None
    if rec is None or rec.returncode != 0:
        return "BASE's tree at %s could not be listed for its land.sh" % shown(tip), None
    head, _, rawpath = rec.stdout.rstrip(b"\0").partition(b"\t")
    if rawpath.decode("utf-8", "replace") != LAND_REL:
        return "", None
    fields = head.split()
    if len(fields) != 3 or fields[1] != b"blob" or fields[0] not in (b"100644", b"100755"):
        return "BASE's %s is not a regular file" % LAND_REL, None
    try:
        blob = subprocess.run(["git", "--git-dir", common, "cat-file", "blob", fields[2].decode()],
                              capture_output=True, env=env, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        blob = None
    if blob is None or blob.returncode != 0:
        return "BASE's %s could not be read" % LAND_REL, None
    return "", blob.stdout


class Gate:
    """The landing a walled worker ASKS for, run from OUTSIDE its wall (coordinator
    rulings, 2026-09-24).

    Why: the landing's gate is not the worker's work. Behind the wall a suite that builds a
    wall, walks the process tree or writes beside the worker's HERD_DIR entry dies of the
    wall, and the fast-forward writes the primary, which the wall denies -- so a worker
    that had finished its work was refused, and an operator landed it by hand. This does
    what that operator did, and nothing else.

    The worker may ASK; it may not say WHAT. Its finish-worktree.sh writes `gate.request`
    into the one place both sides reach, the worker's own $HERD_DIR/<name>/ (walls/<name>/
    is unwritable to it). The request is read once, removed, and JUDGED, never obeyed: it
    must name exactly the branch and worktree this launcher was started on (run.json,
    written at spawn where the worker cannot write), and what runs is decided here --
    `land.sh` from this walls/<name>/ directory, never a path the request or run.json names,
    and only while it is BASE's committed land.sh byte for byte (_lander_refusal). land.sh
    reads the spawn record, runs the branch's tests in its own process -- a child of THIS
    launcher, outside every profile, as an operator's landing runs them -- and only then
    runs BASE's finish-worktree.sh out of the recorded base commit. (It used to run them
    back through the plug and the worker's profile, where a nested sandbox-exec is refused,
    so every suite that builds a wall was booked FAIL: ISSUE(launcher-landing-still-runs-
    inside-the-wall).) wall.log names the pid that ran the landing. A landing that fails
    asks this worker once to fix the branch; a person is named only after that attempt.
    The receipt comes back as `gate.result`, written through
    a directory descriptor, O_EXCL and O_NOFOLLOW, then renamed into place: a link the
    worker planted there is replaced, never followed. Its stdout ends with a GATE= line
    saying the gate ran outside the worker's wall -- the escalation is on the receipt.

    One landing at a time. The landing runs in a session of its own, so its tests are not
    the worker's tree and never count against the worker's bounds; the worker itself stays
    behind its wall the whole time."""

    REQUEST, RESULT = "gate.request", "gate.result"

    def __init__(self, gate: dict, shim_dir: str, worker: str, runjson: str, cfg=None) -> None:
        self.cfg = cfg
        self.channel = gate["channel"]
        self.primary = gate["primary"]
        self.worktree = gate["worktree"]
        self.branch = gate["branch"]
        # walls/<name>/land.sh beside the spawn record, never a path run.json names
        self.lander = os.path.join(os.path.dirname(os.path.abspath(runjson)), "land.sh") if runjson else ""
        self.gate = gate
        self.runjson = runjson
        self.shim = os.path.realpath(shim_dir)
        self.worker = worker
        self.thread = None
        self.closed = False

    def env_for_agent(self) -> dict:
        return {"HERD_GATE_CHANNEL": self.channel, "HERD_GATE_BRANCH": self.branch,
                "HERD_GATE_WORKTREE": self.worktree}

    def _dirfd(self) -> int:
        return os.open(self.channel, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | NOFOLLOW)

    def _take(self):
        """The request's bytes, "" when it is not a small regular file, None when absent."""
        try:
            dfd = self._dirfd()
        except OSError:
            return None
        try:
            try:
                fd = os.open(self.REQUEST, os.O_RDONLY | os.O_NONBLOCK | NOFOLLOW, dir_fd=dfd)
            except OSError as e:
                if e.errno == errno.ENOENT:
                    return None
                data = ""                           # a link, or something we may not open
            else:
                try:
                    st = os.fstat(fd)
                    data = os.read(fd, 4097) if stat.S_ISREG(st.st_mode) else ""
                finally:
                    os.close(fd)
            try:
                os.unlink(self.REQUEST, dir_fd=dfd)
            except OSError:
                # a name we cannot remove would be answered on every tick: stop serving
                self.closed = True
                log("gate: closed: %s/%s could not be removed" % (self.channel, self.REQUEST))
            return data
        finally:
            os.close(dfd)

    def _judge(self, data) -> tuple:
        """("", script) to land, or (why, "") to refuse."""
        if not isinstance(data, bytes) or not data or len(data) > 4096:
            return "the request was not a small regular file", ""
        try:
            req = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return "the request was not JSON", ""
        if not isinstance(req, dict) or not isinstance(req.get("branch"), str) \
                or not isinstance(req.get("worktree"), str):
            return "the request named no branch and worktree", ""
        if req["branch"] != self.branch or os.path.realpath(req["worktree"]) != self.worktree:
            return ("this launcher lands only %s in %s, the branch and worktree its worker was "
                    "started on" % (self.branch, self.worktree)), ""
        script = self.lander
        refused = self._lander_refusal()
        if refused:
            return refused, ""
        # judged again here: the dir's finish-worktree.sh is what land.sh runs, unwalled
        refused = scripts_dir_refusal(self.cfg) if isinstance(self.cfg, dict) else ""
        if refused:
            return refused, ""
        return "", script

    def _answer(self, rc: int, out: str, err: str) -> None:
        body = json.dumps({"rc": rc, "stdout": out, "stderr": err}).encode("utf-8")
        tmp = self.RESULT + ".tmp"
        try:
            dfd = self._dirfd()
        except OSError as e:
            log("gate: could not open %s to answer: %s" % (self.channel, type(e).__name__))
            return
        try:
            try:
                os.unlink(tmp, dir_fd=dfd)
            except FileNotFoundError:
                pass
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=dfd)
            try:
                os.write(fd, body)
            finally:
                os.close(fd)
            os.rename(tmp, self.RESULT, src_dir_fd=dfd, dst_dir_fd=dfd)
        except OSError as e:
            log("gate: could not write the receipt into %s: %s" % (self.channel, type(e).__name__))
        finally:
            os.close(dfd)

    def _lander_refusal(self) -> str:
        """Why walls/<name>/land.sh may not run, or "" when it may.

        It runs unwalled, so it must be BASE's committed land.sh byte for byte: a wall copy
        made at spawn and never refreshed would land under the gate BASE held then, and be
        refused late, after the tests, once BASE's gate changed. A stale copy is refused at
        once by name; a re-spawn copies BASE's. A link is never run. A BASE that carries no
        land.sh (a pinned consumer, no vendored skill) keeps the copy made at spawn."""
        script = self.lander
        try:
            st = os.lstat(script) if script else None
        except OSError:
            st = None
        if st is not None and stat.S_ISLNK(st.st_mode):
            return "%s is a symlink: a land.sh is never run through a link" % shown(script)
        if st is None or not stat.S_ISREG(st.st_mode):
            return "the spawn record has no land.sh"
        why, base = base_land_blob(self.gate)
        if why:
            return why
        if base is None:
            return ""
        try:
            fd = os.open(script, os.O_RDONLY | os.O_NONBLOCK | NOFOLLOW)
            try:
                chunks = []
                while True:
                    chunk = os.read(fd, 1 << 16)
                    if not chunk:
                        break
                    chunks.append(chunk)
            finally:
                os.close(fd)
        except OSError:
            return "%s could not be read" % shown(script)
        if b"".join(chunks) != base:
            return ("stale land.sh: %s is not the land.sh BASE carries at refs/heads/%s; it is "
                    "never run, so re-spawn the worker for a fresh landing round"
                    % (shown(script), shown(self.gate.get("base_ref"))))
        return ""

    def _repair(self, reason: str) -> None:
        # only a land.sh the landing itself may run asks for the repair
        if not self.lander or not self.runjson or self._lander_refusal():
            return
        try:
            subprocess.run(["/bin/bash", self.lander, "--repair", self.runjson, reason],
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            log("gate: the repair agent was not prompted")

    def _land(self, script: str) -> None:
        env = {k: v for k, v in os.environ.items() if not k.startswith("HERD_GATE_")}
        # never this worker's launcher again: a reviewer the landing spawns finds the real harness
        env["PATH"] = os.pathsep.join(d for d in env.get("PATH", "").split(os.pathsep)
                                      if d and os.path.realpath(d) != self.shim)
        log("gate: landing %s from the spawn record outside the wall" % self.branch)
        try:
            p = subprocess.Popen(["/bin/bash", script, self.runjson], cwd=self.primary, env=env,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, errors="replace", start_new_session=True)
            log("gate: the landing of %s runs as pid=%d, a child of the launcher pid=%d, not of the worker"
                % (self.branch, p.pid, os.getpid()))
            out, err = p.communicate()
            rc = p.returncode
        except OSError as e:
            rc, out, err = 126, "MERGED=no\n", "herd gate: could not start the landing: %s\n" % type(e).__name__
        if out and not out.endswith("\n"):
            out += "\n"
        out += ("GATE=ran outside the worker's wall: the herd launcher for %s ran land.sh "
                "from the spawn record\n" % self.worker)
        log("gate: landing of %s exited %d" % (self.branch, rc))
        self._answer(rc, out, err)

    def poll(self) -> None:
        if self.closed or (self.thread is not None and self.thread.is_alive()):
            return
        data = self._take()
        if data is None:
            return
        why, script = self._judge(data)
        if why:
            log("gate: refused a landing request: " + why)
            self._repair(why)
            self._answer(1, "MERGED=no\n", "herd gate: refusing to land: %s; nothing moved.\n" % why)
            return
        self.thread = threading.Thread(target=self._land, args=(script,), daemon=False)
        self.thread.start()

    def join(self) -> None:
        if self.thread is not None:
            self.thread.join()


def resolve(cmd: str, skip_dir: str) -> str:
    skip = os.path.realpath(skip_dir)
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if not d or os.path.realpath(d) == skip:
            continue
        p = os.path.join(d, cmd)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return os.path.abspath(p)
    return ""


def run(cfg_path: str, args: list) -> int:
    global LOG
    fd = os.open(cfg_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd) as f:
        cfg = json.load(f)
    LOG = cfg["log"]
    cpu, mem_mb, procs = int(cfg["cpu"]), int(cfg["mem_mb"]), int(cfg["procs"])
    agent = resolve(cfg["command"], cfg["shim_dir"])
    if not agent:
        sys.stderr.write("herd wall: no %s on PATH after the launcher's own directory\n" % cfg["command"])
        log("refused: no %s on PATH after the launcher" % cfg["command"])
        return 127
    gate = None
    child_env = dict(os.environ)
    if cfg["walled"]:
        argv = [cfg["bash"], cfg["plug"], "exec", cfg["profile"], "--", agent] + args
        # only a walled worker needs its landing served from outside; unwalled, it lands itself
        if isinstance(cfg.get("gate"), dict):
            # the landing runs the recorded scripts dir's finish-worktree.sh unwalled: a dir
            # that may not run stops the launcher before the agent or anything else starts
            refused = scripts_dir_refusal(cfg)
            if refused:
                sys.stderr.write("herd wall: refusing to start: %s; nothing was run\n" % refused)
                log("refused: " + refused)
                return 2
            gate = Gate(cfg["gate"], cfg["shim_dir"], cfg["worker"], cfg_path, cfg)
            child_env.update(gate.env_for_agent())
    else:
        argv = [agent] + args
        # an INHERITED wall is the one this launcher itself must be inside: the spawn saw
        # one around itself, but the tab may have been started by a herdr server that is
        # not behind it. The plug's `inside` is asked here, where the agent runs.
        if cfg.get("inherited"):
            inside = subprocess.run([cfg["bash"], cfg["plug"], "inside"], stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL).returncode == 0
            if not inside:
                sys.stderr.write("herd wall: the spawn inherited a wall, but this launcher runs behind none; "
                                 "the agent was not started\n")
                log("refused: wall=inherited, but the launcher runs behind no wall")
                return 2
    pid = os.fork()
    if pid == 0:
        try:
            soft, hard = resource.getrlimit(resource.RLIMIT_CPU)
            top = cpu + 5 if hard == resource.RLIM_INFINITY else min(hard, cpu + 5)
            resource.setrlimit(resource.RLIMIT_CPU, (min(cpu, top), top))
            os.execve(argv[0], argv, child_env)
        except BaseException as e:                                  # noqa: BLE001
            os.write(2, ("herd wall: could not start %s: %s\n" % (cfg["command"], type(e).__name__)).encode())
        os._exit(127)
    for s in (signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP):
        signal.signal(s, signal.SIG_IGN)

    def forward(sig, _frame):
        try:
            os.kill(pid, sig)
        except OSError:
            pass
    for s in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(s, forward)
    said = "walled" if cfg["walled"] else ("inherited" if cfg.get("inherited") else "unwalled")
    log("started pid=%d wall=%s cpu=%ds mem=%dMB procs=%d" % (pid, said,
                                                              cpu, mem_mb, procs))
    table = Table()
    kq = select.kqueue() if hasattr(select, "kqueue") else None
    watched: set = set()
    killed = ""
    last = {pid}
    status, ru = 0, None
    while True:
        try:
            wpid, status, ru = os.wait4(pid, os.WNOHANG)
        except ChildProcessError:
            break
        if wpid == pid:
            break
        if gate is not None and not killed:
            gate.poll()
        if not killed:
            tree = table.tree(pid)
            if tree:
                last = tree
            if len(tree) > procs:
                killed = "process"
                log("killed: the process cap (procs=%d) was hit: %d in the worker's tree" % (procs, len(tree)))
                stop_and_kill(table, pid, tree)
            else:
                used = table.footprint(tree)
                if used > mem_mb * 1024 * 1024:
                    killed = "memory"
                    log("killed: the memory bound (mem=%dMB) was hit: %dMB in the worker's tree"
                        % (mem_mb, used // (1024 * 1024)))
                    stop_and_kill(table, pid, tree)
            if kq is not None and not killed:
                for p in tree - watched:
                    try:
                        kq.control([select.kevent(p, select.KQ_FILTER_PROC, select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                                                  select.KQ_NOTE_FORK | select.KQ_NOTE_EXIT)], 0, 0)
                    except OSError:
                        pass
                watched = (watched | tree) & tree
        try:
            if kq is not None:
                kq.control(None, 64, 0.2)
            else:
                time.sleep(0.1)
        except InterruptedError:
            pass
    rc = 0
    if os.WIFSIGNALED(status):
        sig = os.WTERMSIG(status)
        spent = (ru.ru_utime + ru.ru_stime) if ru is not None else 0.0
        if not killed and (sig == signal.SIGXCPU or (sig == signal.SIGKILL and spent >= cpu)):
            killed = "cpu"
            log("killed: the cpu bound (cpu=%ds) was hit by the agent after %.1fs of cpu time" % (cpu, spent))
            stop_and_kill(table, pid, last)
        rc = 128 + sig
    elif os.WIFEXITED(status):
        rc = os.WEXITSTATUS(status)
    log("exited status=%d" % rc)
    if gate is not None:
        # a landing half-done is worse than a launcher that outlives its worker by minutes
        gate.join()
    return rc


def main(argv: list) -> int:
    if argv[1:2] == ["probe"]:
        return probe(argv[2:])
    if argv[1:2] == ["run"] and len(argv) >= 3:
        rest = argv[3:]
        if rest[:1] == ["--"]:
            rest = rest[1:]
        return run(argv[2], rest)
    sys.stderr.write("usage: run.py probe <word> <dir> ... | run <run.json> -- <args...>\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
PY
# Step 1: judge every path this block writes (a symlink or a non-file there is exit 2,
# never followed or replaced -- even with HERD_WALL=off), then write the profile and the
# copies the launcher will run. Each file is unlinked by its exact path and created O_EXCL.
# The branch and its git dir are read NOW, before the worker exists, and the profile allows
# only that branch's ref -- never the whole common directory.
wall_branch="$(git -C "$cwd" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
wall_gitdir="$(git -C "$cwd" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
# herdr's control socket, as herdr itself reports it (the `socket:` line of `herdr status
# server`), never a path built from HOME or herdr's config. The wall denies writes, and a
# connect is not a write: a worker that reaches this socket can start an unwalled pane or
# type into any other, the coordinator's included. Every scope but the coordinator's (which
# drives herdr) gets a deny-connect line for it. No socket line, or a failing herdr, is no
# line -- find_herdr above already refused a herdr whose server is down. A render asks
# herdr nothing, so its profile has no such line.
wall_herdr_sock=""
if [[ "$wall_scope" != "coordinator" && "$render" != "yes" ]]; then
  wall_herdr_sock="$("$herdr" status server 2>/dev/null | sed -n 's/^socket:[[:space:]]*//p' | head -n 1)" || wall_herdr_sock=""
fi
# A cursor worker's CURSOR_CONFIG_DIR is a directory of this spawn alone,
# $HERD_DIR/.cursor-homes/<name>.<16 hex>, named now so the profile below allow-writes it and
# nothing beside it, and made (exclusively) once the name is this spawn's. An earlier spawn of
# the same name allow-wrote its own $HERD_DIR/<name> and its own per-spawn directory, never
# this one, so a process it left running cannot plant into this seed
# (intake 20261009T173850Z).
cursor_worker_home=""
if [[ "$harness" == "cursor" && "$profile" != "coordinator" ]]; then
  cursor_unique="$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  if [[ ! "$cursor_unique" =~ ^[0-9a-f]{16}$ ]]; then
    echo "herd-spawn: no random name could be read from /dev/urandom for ${name}'s own CURSOR_CONFIG_DIR; the worker ${name} was not started" >&2
    exit 2
  fi
  cursor_worker_home="$herd_dir/.cursor-homes/${name}.${cursor_unique}"
fi
# (`if !` rather than `<<'PY' || exit 2`: the here-document line ends in <<'PY', the shape
# tests/test_nested_gate_slot.py reads this program by.)
if ! HS_WALL_DIR="$wall_dir" HS_WALLS="$walls_dir" HS_CWD="$cwd" HS_HERD="$herd_dir" HS_NAME="$name" \
  HS_PRIMARY="$wall_primary" HS_COMMON="$wall_common" HS_PLUG="$here/walls/${wall_os}.sh" \
  HS_AGENT_CMD="$agent_cmd" HS_RUN_SRC="$wall_run_src" \
  HS_BRANCH="$wall_branch" HS_GITDIR="$wall_gitdir" HS_HERDR_SOCK="$wall_herdr_sock" \
  HS_CURSOR_PROJECT="$cursor_project" HS_HARNESS="$harness" HS_CURSOR_WORKER_HOME="$cursor_worker_home" \
  python3 -I - <<'PY'
import hashlib, os, re, shutil, stat, sys
wd, walls, cwd, herd, name = (os.environ[k] for k in ("HS_WALL_DIR", "HS_WALLS", "HS_CWD", "HS_HERD", "HS_NAME"))
primary, common, plug = os.environ["HS_PRIMARY"], os.environ["HS_COMMON"], os.environ["HS_PLUG"]
home, tmp = os.environ.get("HOME", ""), os.environ.get("TMPDIR", "")
targets = ["profile", "wall.log", "run.json", "run.py", "plug.sh", os.path.join("bin", os.environ["HS_AGENT_CMD"])]
tpl_dir = os.path.dirname(plug)
templates = sorted(n for n in (os.listdir(tpl_dir) if os.path.isdir(tpl_dir) else [])
                   if n.endswith(".template"))
for t in targets + templates:
    p = os.path.join(wd, t)
    if os.path.lexists(p) and not stat.S_ISREG(os.lstat(p).st_mode):
        print("herd-spawn: %s is a symlink or not a regular file; the wall's files are never written "
              "through or over one -- remove it if the name is yours to re-spawn; the worker %s was not started"
              % (p, name), file=sys.stderr)
        sys.exit(2)


def write(rel, text, mode=0o600):
    p = os.path.join(wd, rel)
    if os.path.lexists(p):
        os.unlink(p)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)


def real(p):
    return os.path.realpath(p)


def cursor_joined(home_path, workspace):
    home_r = os.path.realpath(home_path)
    base = os.path.join(home_r, ".cursor", "projects")
    if len(base) > 84:
        base = os.path.join(home_r, ".cursor")
        if len(base) > 84:
            base = "/tmp/.cursor"
    slug = re.sub(r"[^A-Za-z0-9-]+", "-", os.path.realpath(workspace)).strip("-")
    if not slug:
        return ""
    return os.path.join(base, slug)


def cursor_real(full):
    if full == "/tmp" or full.startswith("/tmp/"):
        root = os.path.realpath("/tmp")
        if root != "/tmp":
            return root + full[len("/tmp"):]
    return full


def cursor_project_dir(home_path, workspace):
    """Where --trust writes .workspace-trusted (paths.js Xq): the uncut slug.

    A projects directory longer than 84 falls back to <HOME>/.cursor, then /tmp/.cursor.
    """
    raw = cursor_joined(home_path, workspace)
    return cursor_real(raw) if raw else ""


def cursor_state_dir(home_path, workspace):
    """Where startup mkdirs (paths.js kL, cursor-agent 2026.10.16-e3cb207).

    The uncut path, unless it is longer than 91 characters: then the first 83, a
    hyphen, and sha256 of the uncut path's first 7 hex digits. The hash is of the
    string before /tmp is rewritten to its real path. For /Users/mkt that cut keeps
    55 characters of the slug.
    """
    raw = cursor_joined(home_path, workspace)
    if not raw:
        return ""
    if len(raw) > 91:
        raw = raw[:min(83, len(raw))] + "-" + hashlib.sha256(raw.encode()).hexdigest()[:7]
    return cursor_real(raw)


def job_dir(anchor, parts):
    """Create anchor/parts... mode 700 where absent, OUTSIDE the wall: the worker may write
    into the last one but not beside it, so it could never create the chain itself. Each
    component made here must be a real directory -- a symlink or a file is exit 2, never
    followed into an allow-write line."""
    p = anchor
    for part in parts:
        p = os.path.join(p, part)
        if os.path.lexists(p):
            if not stat.S_ISDIR(os.lstat(p).st_mode):
                print("herd-spawn: %s is a symlink or not a directory; a walled worker's job directory is never "
                      "followed through one -- remove it; the worker %s was not started" % (p, name), file=sys.stderr)
                sys.exit(2)
        else:
            os.mkdir(p, 0o700)
    return p


# The worker's JOB, the two places outside its own that it must write (coordinator ruling,
# 2026-09-24): the test fixture root 54 test files hard-code, and the intake directory
# tools/appl-add.sh files into. Those two and nothing wider -- never HERD_DIR, which holds
# every other worker's brief and permissions.json.
intake = job_dir(herd, ["coordinator", "intake"])
fixtures = ""
if home:
    os.makedirs(os.path.join(home, ".cache"), exist_ok=True)
    fixtures = job_dir(os.path.join(home, ".cache"), ["muretai-tests"])
keys = real(os.path.join(primary, "keys"))
bindings = real(os.path.join(home, ".muretai", "bindings")) if home else ""
lines = ["# herd wall profile v1, written by herd-spawn.sh for the worker " + name,
         "# read by scripts/walls/<os>.sh; one verb and one absolute path per line",
         "egress open",
         "allow-write " + real(cwd),
         "allow-write " + real(os.path.join(herd, name)),
         "allow-write " + real(intake)]
if fixtures:
    lines.append("allow-write " + real(fixtures))
# The common directory is not a trust anchor: a worker who can write every ref can point
# main at their own commit. Allow the object store, this worktree's git dir, and this
# branch's ref and its reflog, each as a LITERAL path together with its `.lock` (git writes
# <ref>.lock and renames it onto <ref>). They used to be prefixes, and a prefix on
# refs/heads/feat/w also covered refs/heads/feat/w2.lock -- another worktree's branch whose
# name merely begins with ours (tests/test_herd_wall_sequencer.py, w2_ref_lock). Deny
# main, master and packed-refs after that allow; a later Seatbelt rule wins.
# Deleting any ref -- this worktree's CHERRY_PICK_HEAD, REBASE_HEAD, MERGE_HEAD -- takes
# <common>/packed-refs.lock even when the ref is not packed, so that one file is allowed
# too, literal: a `git cherry-pick --quit` or a rebase can clear its own sequencer state.
# packed-refs itself stays denied, so a rewrite of it (renaming the lock onto it) still fails.
branch = os.environ.get("HS_BRANCH", "")
gitdir = os.environ.get("HS_GITDIR", "")
if common and branch:
    lines.append("allow-write " + real(os.path.join(common, "objects")))
    if gitdir:
        gd, cm = real(gitdir), real(common)
        if gd != cm and (gd + "/").startswith(cm + "/worktrees/"):
            lines.append("allow-write " + gd)
            # The git dir's pointer files: commondir and gitdir say where the common dir
            # and the worktree are, config.worktree carries per-worktree config such as
            # core.fsmonitor. No commit writes them, so each is denied as a literal path
            # after the allow above; a later Seatbelt rule wins.
            for f in ("commondir", "gitdir", "config.worktree"):
                lines.append("deny-write-literal " + os.path.join(gd, f))
    ref = real(os.path.join(common, "refs", "heads", branch))
    reflog = real(os.path.join(common, "logs", "refs", "heads", branch))
    for p in (ref, ref + ".lock", reflog, reflog + ".lock", real(os.path.join(common, "packed-refs.lock"))):
        lines.append("allow-write-literal " + p)
    for denied in ("refs/heads/main", "refs/heads/master",
                   "logs/refs/heads/main", "logs/refs/heads/master", "packed-refs"):
        lines.append("deny-write " + real(os.path.join(common, denied)))
for t in (tmp, "/tmp"):
    if t and os.path.isdir(t):
        lines.append("allow-write " + real(t))
# The harness's own config home: ~/.claude for claude (and cursor, whose profile is the
# claude worker's plus its own lines below), ~/.grok for grok -- the harness word is the
# only difference between a grok worker's profile and a claude worker's.
config_home = "." + ("grok" if os.environ.get("HS_HARNESS") == "grok" else "claude")
# That home is session state AND the operator's own config: what a later, unwalled session
# loads (settings*.json with its hooks, agents, skills, commands, hooks, plugins, rules,
# output styles, CLAUDE.md) is denied after the allow, write and link. The home itself is a
# literal deny, so it can be neither renamed away nor replaced by a directory renamed into
# its place -- a rename is checked against the moved node's own path, never what it carries.
# So it is made here, outside the wall, when absent; a symlink is left as the operator made it.
# The denies hold in every letter case: on a case-insensitive volume Settings.json IS
# settings.json to every later reader. At its top level the home is an allowlist: only the
# named session-state entries stay writable.
if home:
    cfg = os.path.join(home, config_home)
    if not os.path.lexists(cfg):
        os.mkdir(cfg, 0o700)
    cfg = real(cfg)
    lines.append("allow-write " + cfg)
    # The home's config file beside it is the operator's too: its mcpServers run in the
    # next unwalled session. It and its siblings (.backup, .lock, .tmp.*) are denied in
    # every case, and through a symlink's target; a worker's session state lives in its
    # HERD_DIR pane directory instead.
    for cfg_file in dict.fromkeys((os.path.join(real(home), config_home + ".json"),
                                   real(os.path.join(home, config_home + ".json")))):
        lines.append("deny-write-anycase-literal " + cfg_file)
        lines.append("deny-write-anycase-prefix " + cfg_file + ".")
    # Claude Code prefers <config home>/.config.json over that file as its global config
    # whenever it exists, so it and its siblings are denied the same way.
    cfg_json = os.path.join(cfg, ".config.json")
    lines.append("deny-write-anycase-literal " + cfg_json)
    lines.append("deny-write-anycase-prefix " + cfg_json + ".")
    lines.append("deny-write-anycase-literal " + cfg)
    lines.append("deny-write-anycase-prefix " + os.path.join(cfg, "settings"))
    for denied in ("agents", "skills", "commands", "hooks", "plugins", "rules", "output-styles", "CLAUDE.md"):
        lines.append("deny-write-anycase " + os.path.join(cfg, denied))
    # Other harnesses read instructions from this home too: grok's Claude compatibility
    # loads each of these names (grok 1.0.41). The anycase deny ends at a path component,
    # so CLAUDE.md above never covers CLAUDE.local.md: one line per name.
    for denied in ("Agents.md", "Claude.md", "CLAUDE.local.md", "AGENT.md", "AGENTS.md"):
        lines.append("deny-write-anycase " + os.path.join(cfg, denied))
    # Claude Code loads each project's auto memory at start. Any slug, including one made
    # after the spawn; the rest of a project's session state stays writable.
    lines.append("deny-write-anycase-glob " +os.path.join(cfg, "projects", "*", "memory"))
    # Every other top-level entry of the home is denied too, in every letter case, so a
    # config file name the harness adds later is closed by default. Spared: the session
    # state the harness writes (a directory and all beneath it, or exactly a file), this
    # worker's own wall probe file, and .credentials.json, the Linux login a pane without
    # CLAUDE_CODE_OAUTH_TOKEN refreshes.
    for spared in ("projects", "todos", "shell-snapshots", "statsig", "session-env", "file-history"):
        lines.append("deny-write-anycase-spare " + os.path.join(cfg, spared))
    for spared in ("history.jsonl", "herd-wall-" + name + ".txt", ".credentials.json"):
        lines.append("deny-write-anycase-spare-literal " + os.path.join(cfg, spared))
    lines.append("deny-write-anycase-others " + cfg)
# A cursor worker's own project state, made and judged above, and its trust record.
# cursor-agent --trust writes one file per workspace root, at
# <HOME>/.cursor/projects/<full slug>/.workspace-trusted, for --workspace and again for
# --add-dir (measured 2026-10-14). Startup mkdirs paths.js kL, which is that same path
# until it is longer than 91 characters and then the 83-character cut plus a sha256
# prefix (cursor-agent 2026.10.16-e3cb207). For a herd worker the second workspace is
# HERD_DIR/<name>. Each directory is made here, before any sandbox starts: a real
# directory owned by this user, never a symlink followed into an allow-write. The
# profile allow-writes those directories and
# nothing else under <HOME>/.cursor. A claude worker has no cursor_project, so its
# profile is unchanged. Judged again here, so a swap since the project dir was made is
# never followed.
def grant_state(workspace, already):
    """Allow-write the directory startup mkdirs, when it is not already granted."""
    state = cursor_state_dir(home, workspace) if home else ""
    if not state or state in already:
        return
    acc = ""
    for part in state.split("/"):
        if part == "":
            continue
        acc = acc + "/" + part
        if os.path.lexists(acc):
            st = os.lstat(acc)
            if stat.S_ISLNK(st.st_mode) and acc != state and acc == "/tmp" and os.path.isdir(acc):
                continue
            if not stat.S_ISDIR(st.st_mode) or (acc == state and st.st_uid != os.getuid()):
                print("herd-spawn: %s is a symlink, not a directory, or not yours; a cursor worker's project state is "
                      "never followed through one -- remove it; the worker %s was not started" % (acc, name),
                      file=sys.stderr)
                sys.exit(2)
        else:
            os.mkdir(acc, 0o700)
    if os.path.islink(state) or not os.path.isdir(state) or real(state) != state:
        print("herd-spawn: %s is no longer a real directory; the worker %s was not started" % (state, name),
              file=sys.stderr)
        sys.exit(2)
    lines.append("allow-write " + state)


cursor_project = os.environ.get("HS_CURSOR_PROJECT", "")
if cursor_project:
    if (not os.path.isabs(cursor_project) or os.path.islink(cursor_project) or not os.path.isdir(cursor_project)
            or real(cursor_project) != cursor_project):
        print("herd-spawn: %s is no longer a real directory; the worker %s was not started" % (cursor_project, name),
              file=sys.stderr)
        sys.exit(2)
    lines.append("allow-write " + cursor_project)
    grant_state(cwd, {cursor_project})
    target = real(os.path.join(herd, name))
    trust = cursor_project_dir(home, target) if home else ""
    if not trust:
        print("herd-spawn: %s gives cursor-agent no trust-record directory; the worker %s was not started"
              % (target, name), file=sys.stderr)
        sys.exit(2)
    acc = ""
    for part in trust.split("/"):
        if part == "":
            continue
        acc = acc + "/" + part
        if os.path.lexists(acc):
            st = os.lstat(acc)
            # Same /tmp exception as the project-dir mkdir above: the fallback path is the
            # string cursor-agent uses, and /tmp is a symlink to a directory.
            if stat.S_ISLNK(st.st_mode) and acc != trust and acc == "/tmp" and os.path.isdir(acc):
                continue
            if not stat.S_ISDIR(st.st_mode) or (acc == trust and st.st_uid != os.getuid()):
                print("herd-spawn: %s is a symlink, not a directory, or not yours; a cursor worker's trust record is "
                      "never followed through one -- remove it; the worker %s was not started" % (acc, name),
                      file=sys.stderr)
                sys.exit(2)
        else:
            os.mkdir(acc, 0o700)
    if os.path.islink(trust) or not os.path.isdir(trust) or real(trust) != trust:
        print("herd-spawn: %s is no longer a real directory; the worker %s was not started" % (trust, name),
              file=sys.stderr)
        sys.exit(2)
    if trust != cursor_project:
        lines.append("allow-write " + trust)
    grant_state(target, {cursor_project, trust})
# A cursor worker's own per-spawn CURSOR_CONFIG_DIR (named above, made after this block): its
# parent $HERD_DIR/.cursor-homes is made here, outside the wall, a real directory of the
# caller's closed to others, and only this spawn's one directory under it is allow-written --
# never the parent, never another spawn's.
cursor_worker_home = os.environ.get("HS_CURSOR_WORKER_HOME", "")
if cursor_worker_home:
    homes = job_dir(herd, [".cursor-homes"])
    hst = os.lstat(homes)
    if (os.path.dirname(cursor_worker_home) != homes or hst.st_uid != os.getuid() or hst.st_mode & 0o022
            or os.path.lexists(cursor_worker_home)):
        print("herd-spawn: %s is not a private directory of the caller's, or %s already exists; a cursor worker's "
              "own CURSOR_CONFIG_DIR is never made through one; the worker %s was not started"
              % (homes, cursor_worker_home, name), file=sys.stderr)
        sys.exit(2)
    lines.append("allow-write " + os.path.join(real(homes), os.path.basename(cursor_worker_home)))
if common:
    lines += ["deny-write " + real(os.path.join(common, "hooks")), "deny-write " + real(os.path.join(common, "config"))]
lines += ["deny-write " + real(os.path.join(herd, name, "brief.md")),
          "deny-write " + real(os.path.join(herd, name, "permissions.json")),
          "deny-write " + real(walls), "deny-write " + keys, "deny-read " + keys]
if bindings:
    lines += ["deny-write " + bindings, "deny-read " + bindings]
# The APPL install root, ~/.appl, and every version under it: resolved physically, written
# whether or not it exists yet, and after every allow so it wins (a version installed after
# the spawn is shut too). Reading it stays allowed.
if home:
    lines.append("deny-write " + real(os.path.join(home, ".appl")))
# The landing gate's slot directory: flock(2) needs only an open descriptor, a read-only one
# locks too, and the wall allows reads by default -- so the worker is denied READ as well as
# write there, or it could hold every slot and hang every gate on the machine. Its place is
# tools/gate_slots.py's; a checkout without that module (a vendored skill) denies the
# default place, spelled here once.
slots = []
repo_tools = os.path.normpath(os.path.join(os.path.dirname(plug), "..", "..", "..", "..", "..", "tools"))
if os.path.isfile(os.path.join(repo_tools, "gate_slots.py")):
    sys.path.insert(0, repo_tools)
    try:
        import gate_slots
        slots.append(str(gate_slots.slot_dir()))
    except Exception:  # noqa: BLE001 -- the default below still stands
        pass
    finally:
        sys.path.remove(repo_tools)
if home:
    slots.append(os.path.join(home, ".cache", "muretai-herd", "gate-slots"))
# The gate-scratch root (lib.sh's iso_gate_scratch_root): where a landing builds BASE's lint
# and invariant copies. A worker that could write there could swap BASE's sec_lint.py or plant
# its bytecode while the launcher lands; one that could list it would learn every landing's
# scratch name. Denied read and write, at the seam when the spawn sets it and at the default.
if os.environ.get("MURETAI_GATE_SCRATCH_DIR"):
    slots.append(os.environ["MURETAI_GATE_SCRATCH_DIR"])
if home:
    slots.append(os.path.join(home, ".cache", "muretai-herd", "gate-scratch"))
for s in slots:
    for p in sorted({os.path.abspath(s), real(s)}):
        if ("deny-read " + p) not in lines:
            lines += ["deny-write " + p, "deny-read " + p]
# The backlog pull's two locks (appl-backlog-pull.sh): the same read-only-descriptor flock
# as the gate slots -- a worker holding backlog-pull.lock makes every pull exit 0 as busy,
# and the last-skip lock behind the busy dedup is the same hole. Denied read and write, the
# two files only: coordinator/ beside them stays readable, coordinator/intake writable.
for lock in ("backlog-pull.lock", "backlog-pull.last-skip"):
    s = os.path.join(herd, "coordinator", lock)
    for p in sorted({os.path.abspath(s), real(s)}):
        if ("deny-read " + p) not in lines:
            lines += ["deny-write " + p, "deny-read " + p]
# herdr's control socket (read above, empty for the coordinator): the path herdr reported,
# and its resolved path too when a symlink stands in it -- the kernel checks the latter.
sock = os.environ.get("HS_HERDR_SOCK", "").strip()
if sock.startswith("/"):
    for p in sorted({sock, real(sock)}):
        lines.append("deny-connect " + p)
# file-link only. A deny-write of the primary would cover this worker's worktree
# (it sits inside the checkout) and the later file-write rule would take the
# worktree with it. The plug turns deny-link into file-link denies and leaves
# every allow-write path under the primary linkable, so other worktrees stay
# denied and this worktree does not. .repos holds the spawn records outside walls/.
if primary:
    lines.append("deny-link " + real(primary))
lines.append("deny-link " + real(os.path.join(herd, ".repos")))
write("profile", "\n".join(lines) + "\n")
write("run.py", os.environ["HS_RUN_SRC"])
if os.path.isfile(plug) and not os.path.islink(plug):
    write("plug.sh", open(plug, encoding="utf-8").read(), 0o700)
    for t in templates:
        src = os.path.join(tpl_dir, t)
        if os.path.isfile(src) and not os.path.islink(src):
            write(t, open(src, encoding="utf-8").read())
else:
    for t in ["plug.sh"] + templates:
        if os.path.lexists(os.path.join(wd, t)):
            os.unlink(os.path.join(wd, t))
PY
then
  exit 2
fi
# The claim probe (THE OWNER KEY above). Runs through the plug, under the worker's profile,
# the scripts a worker runs to hold its folder -- claim-worktree.sh, then assert-head.sh from
# another shell, as each Bash call of a session is -- with the key the tab will carry, in a
# throwaway repository and linked worktree made behind the wall inside $HERD_DIR/<name>/
# (the one place under HERD_DIR the profile lets the worker write, never TMPDIR and never
# the worker's repository), removed whatever the outcome. The scripts are this script's own
# siblings, the version that just wrote the profile: the landing's reviewer spawn and
# tools/security_daily.sh extract both from BASE beside their temporary copy of this script.
# Failing that, the cwd checkout's copy -- the one the worker itself will run -- is used.
# No copy of either is a finding, not a skip.
# Silent and 0 when the claim holds; else one clause on stdout and 1. No variable skips it.
#
# probe_bounded SECS CMD...: run CMD in a session of its own and wait at most SECS seconds;
# at the bound its whole process group is killed (the stalled plug and whatever it started)
# and this returns 124. macOS has no timeout(1), so the bound is a few lines of python3 -I.
probe_bounded() {
  python3 -I -c '
import os, signal, subprocess, sys
secs = int(sys.argv[1])
p = subprocess.Popen(sys.argv[2:], start_new_session=True)
try:
    rc = p.wait(timeout=secs)
except subprocess.TimeoutExpired:
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except OSError:
        pass
    p.wait()
    sys.exit(124)
sys.exit(128 - rc if rc < 0 else rc)
' "$@"
}
wall_claim_probe() {
  local sd="" cand wt_root cdir crc cout step
  wt_root="$(iso_worktree_of "$cwd" 2>/dev/null || true)"
  for cand in "$here" "${wt_root:-/nonexistent}/.cursor/skills/isolated-session/scripts"; do
    if [[ -f "$cand/claim-worktree.sh" && -f "$cand/assert-head.sh" && -f "$cand/lib.sh" ]]; then
      sd="$cand"
      break
    fi
  done
  if [[ -z "$sd" ]]; then
    echo "no claim-worktree.sh and assert-head.sh were found to prove the worktree claim behind the wall, so the worker's lock is unproven"
    return 1
  fi
  if ! cdir="$(mktemp -d "$herd_dir/${name}/.claim-probe.XXXXXX" 2>/dev/null)"; then
    echo "could not create the claim probe's throwaway directory in ${herd_dir}/${name}, so the worker's lock is unproven"
    return 1
  fi
  crc=0
  cout="$( cd "$cdir" && probe_bounded "$wall_probe_secs" /bin/bash "$wall_dir/plug.sh" exec "$wall_dir/profile" -- /bin/bash -c '
    d="$1"; sd="$2"
    unset HERD_WORKER ISOLATED_SESSION_TAKEOVER ISOLATED_SESSION_FORCE ISOLATED_SESSION_RESUME ISOLATED_SESSION_CROSS
    export ISOLATED_SESSION_OWNER="$3" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
    export GIT_AUTHOR_NAME=herd-probe GIT_AUTHOR_EMAIL=herd-probe@example.invalid
    export GIT_COMMITTER_NAME=herd-probe GIT_COMMITTER_EMAIL=herd-probe@example.invalid
    git init -q "$d/repo" >/dev/null 2>&1 &&
      git -C "$d/repo" commit -q --allow-empty -m probe >/dev/null 2>&1 &&
      git -C "$d/repo" worktree add -q -b herd/claim-probe "$d/wt" >/dev/null 2>&1 || { echo step=setup; exit 1; }
    /bin/bash "$sd/claim-worktree.sh" "$d/wt" >/dev/null 2>&1 || { echo step=claim; exit 1; }
    /bin/bash "$sd/assert-head.sh" herd/claim-probe "$d/wt" >/dev/null 2>&1 || { echo step=assert-head; exit 1; }
    echo step=done
  ' herd-claim-probe "$cdir" "$sd" "$owner_key" 2>/dev/null )" || crc=$?
  rm -rf "$cdir"
  step="$(printf '%s\n' "$cout" | sed -n 's/^step=//p' | tail -1)"
  if [[ "$crc" == "0" && "$step" == "done" ]]; then
    return 0
  fi
  if [[ "$crc" == "124" ]]; then
    echo "the claim probe timed out behind the wall (killed after ${wall_probe_secs}s, HERD_WALL_PROBE_SECS), so the worker's worktree claim and lock are unproven"
    return 1
  fi
  case "$step" in
    claim|assert-head)
      echo "behind the wall the worktree claim does not hold (${step}.sh failed in a throwaway repository under the worker's key), so the worker could not keep its lock" ;;
    setup)
      echo "behind the wall the claim probe could not even make its throwaway repository (git failed), so the worker's worktree claim and lock are unproven" ;;
    *)
      echo "the claim probe did not run to the end behind the wall (exit ${crc}), so the worker's worktree claim and lock are unproven" ;;
  esac
  return 1
}
wall_state=unwalled
wall_why=""
if [[ "$wall_scope" != "walled" ]]; then
  wall_why="scope=${wall_scope}"
  [[ -n "$wall_mode" ]] || wall_mode="n/a"
else
  plug_ok=no
  if [[ -f "$wall_dir/plug.sh" ]] && /bin/bash "$wall_dir/plug.sh" available >/dev/null 2>&1; then
    plug_ok=yes
  fi
  mode_said="HERD_WALL=${wall_mode}"
  if [[ -z "$wall_mode" ]]; then
    wall_mode=require
    mode_said="HERD_WALL=require, the default"
  fi
  # A finding refuses the spawn under require, and for a grok worker under prefer too:
  # grok has no unwalled launch (off was refused before herdr was asked anything).
  wall_refuses=no
  if [[ "$wall_mode" == "require" ]]; then
    wall_refuses=yes
  elif [[ "$harness" == "grok" ]]; then
    wall_refuses=yes
    mode_said="${mode_said}, which a grok worker is held to as require: it never starts unwalled"
  fi
  # A spawn that already runs BEHIND a wall inherits it (coordinator ruling 2026-09-25):
  # sandbox-exec does not nest, so the plug says it cannot build one, and a walled worker
  # that runs a test which spawns would otherwise be refused. The marker is what the plug's
  # `exec` put into the walled process; it is a CLAIM, and the plug's `inside` verb (the
  # kernel's answer) must confirm it. A missing plug is a broken install, not a nested
  # wall: no marker turns it into a start. The launcher asks `inside` again where the agent
  # really runs (run.py), since a real herdr starts the tab from its server, not from here.
  inherited_from=""
  marker_said=""
  if [[ "$wall_mode" != "off" && "$plug_ok" != "yes" && -f "$wall_dir/plug.sh" ]]; then
    case "${HERD_WALL_INSIDE:-}" in
      ''|*[!a-z0-9_-]*|[!a-z]*) ;;
      *)
        if [[ ${#HERD_WALL_INSIDE} -le 32 ]] && /bin/bash "$wall_dir/plug.sh" inside >/dev/null 2>&1; then
          inherited_from="$HERD_WALL_INSIDE"
        else
          marker_said="; HERD_WALL_INSIDE is set, but the plug finds no wall around this spawn, so the marker is not a wall"
        fi
        ;;
    esac
  fi
  if [[ "$wall_mode" == "off" ]]; then
    wall_why="why=off"
  elif [[ -n "$inherited_from" ]]; then
    wall_state=inherited
    wall_why="why=inside:${inherited_from}"
  elif [[ "$plug_ok" != "yes" ]]; then
    if [[ "$wall_refuses" == "yes" ]]; then
      echo "herd-spawn: the ${harness} harness has no wall on this machine (scripts/walls/${wall_os}.sh is missing or says it cannot build one) and ${mode_said}${marker_said}; the worker ${name} was not started" >&2
      exit 2
    fi
    echo "herd-spawn: warning: no wall on this machine (scripts/walls/${wall_os}.sh is missing or says it cannot build one)${marker_said}, so the worker ${name} runs unwalled (${mode_said}); the bounds still hold" >&2
    wall_why="why=no-wall"
  else
    # the probe: through the plug, under the agent's own profile, from a scratch
    # directory inside HERD_DIR (never TMPDIR), removed whatever the outcome
    probe_dir="$(mktemp -d "$herd_dir/.wall-probe.XXXXXX")" || {
      echo "herd-spawn: could not create the wall probe's scratch directory under ${herd_dir}; the worker ${name} was not started" >&2
      exit 2
    }
    # ... and the JOB: the same run trials a write into each place the worker must write
    # outside its own (the fixture root, the intake dir). A wall that holds the secrets but
    # denies the job would start a worker only to have it die at its first test run.
    probe_args=(keys "$wall_primary/keys" bindings "${HOME:-/nonexistent}/.muretai/bindings"
                write:intake "$herd_dir/coordinator/intake")
    [[ -z "${HOME:-}" ]] || probe_args+=(write:suite "$HOME/.cache/muretai-tests")
    probe_rc=0
    ( cd "$probe_dir" && probe_bounded "$wall_probe_secs" /bin/bash "$wall_dir/plug.sh" exec "$wall_dir/profile" -- \
        "$wall_py" -I "$wall_dir/run.py" probe "${probe_args[@]}" \
    ) >"$probe_dir/out" 2>/dev/null || probe_rc=$?
    leaks=""
    jobs_denied=""
    probe_done=no
    # a path is named with a literal ~ for HOME: the line is read on a screen, not pasted
    home_said() {
      if [[ -n "${HOME:-}" && ( "$1" == "$HOME" || "$1" == "$HOME"/* ) ]]; then
        printf '%s%s' '~' "${1#"$HOME"}"
      else
        printf '%s' "$1"
      fi
    }
    while IFS= read -r pl; do
      case "$pl" in
        keys|bindings) leaks="${leaks}${leaks:+, }${pl}" ;;
        cannot-suite)
          jobs_denied="${jobs_denied}${jobs_denied:+, nor }write $(home_said "$HOME/.cache/muretai-tests") (so it could not run the test suite)" ;;
        cannot-intake)
          jobs_denied="${jobs_denied}${jobs_denied:+, nor }write $(home_said "$herd_dir/coordinator/intake") (so it could not file an intake)" ;;
        done) probe_done=yes ;;
      esac
    done < "$probe_dir/out"
    rm -rf "$probe_dir"
    if [[ "$probe_rc" == "124" ]]; then
      finding="the wall probe timed out behind the wall (killed after ${wall_probe_secs}s, HERD_WALL_PROBE_SECS), so the wall is unproven"
    elif [[ -n "$leaks" ]]; then
      finding="the wall probe could still read ${leaks} behind the wall, so the wall does not hold"
    elif [[ "$probe_done" != "yes" || "$probe_rc" != "0" ]]; then
      finding="the wall probe did not run to the end (exit ${probe_rc}), so the wall is unproven"
    elif [[ -n "$jobs_denied" ]]; then
      finding="the wall stands, but behind it the worker could not ${jobs_denied}"
    elif ! finding="$(wall_claim_probe)"; then
      :
    else
      finding=""
      wall_state=walled
    fi
    if [[ -n "$finding" ]]; then
      if [[ "$wall_refuses" == "yes" ]]; then
        echo "herd-spawn: the ${harness} harness cannot be walled (${finding}); the worker ${name} was not started (${mode_said})" >&2
        exit 2
      fi
      echo "herd-spawn: warning: ${finding}; the worker ${name} runs unwalled (${mode_said}); the bounds still hold" >&2
      wall_why="why=probe"
    fi
  fi
fi
# A walled worker whose cwd is the PRIMARY gets NO gate. The launcher's gate is the branch
# the cwd has checked out at spawn, and finish-worktree.sh hands a landing to it only when
# the branch and worktree it lands ARE the gate's -- a gate on the base branch in the
# primary matches no landing a worker ever makes (it opens its own worktree from there), so
# it would only look like a gate. "The primary" is judged the way the landing judges it:
# the recorded branch is the base ref, which a subdirectory of the primary is too. Said on
# stderr and in wall.log, so a spawn that can never land through the gate is visible.
wall_base="main"
if [[ -n "$wall_common" ]] &&
   ! git --git-dir "$wall_common" rev-parse --verify --quiet refs/heads/main >/dev/null 2>&1 &&
   git --git-dir "$wall_common" rev-parse --verify --quiet refs/heads/master >/dev/null 2>&1; then
  wall_base="master"
fi
gate_none=""
if [[ "$wall_state" == "walled" && -n "$wall_common" && "$wall_branch" == "$wall_base" ]]; then
  gate_none="gate=none (cwd is the primary on ${wall_base})"
  # ... and an IMPLEMENTER there is not started at all: it is the worker that lands, and
  # its landing could never be handed to the launcher, so it would fall to the lease step
  # inside the wall and wait for a person. Judged by the brief's first line, the way
  # appl-role-of.sh reads a role. The IMPLEMENTER and SOLO WORKER templates (a solo worker
  # lands its own work too: ISSUE(solo-workers-spawned-on-the-primary-cannot-land); its
  # spawner opens the worktree first, --open-worktree). Not the ticket: dispatch-take.sh now opens
  # the ticket's worktree and spawns there, but a Dispatch ticket spawned on the primary (an
  # older dispatch-take, a by-hand spawn) still starts here with gate=none (coordinator
  # ruling 20260927T014613Z; test_gate_cwd.py c4).
  # A test author on the primary opens its own worktree and never lands, so it starts.
  brief_first=""
  IFS= read -r brief_first < "$brief" || true
  case "$brief_first" in
    "You are a Muretai implementer session"*)
      echo "herd-spawn: a walled implementer on the primary checkout could never land: its landing gate binds to the branch its cwd has checked out at spawn (${wall_base} here), and finish-worktree.sh hands the launcher only that branch in that worktree; pass --cwd <WORKTREE> (the pair's worktree, from the test author's report); the worker ${name} was not started" >&2
      exit 2
      ;;
    "You are a Muretai worker session"*)
      echo "herd-spawn: a walled solo worker on the primary checkout could never land: its landing gate binds to the branch its cwd has checked out at spawn (${wall_base} here), and finish-worktree.sh hands the launcher only that branch in that worktree; open its worktree first -- --open-worktree \"<TITLE>\" with its --env ISOLATED_SESSION_OWNER key, or pass --cwd <WORKTREE> with --var WORKTREE= and --var BRANCH=; the worker ${name} was not started" >&2
      exit 2
      ;;
  esac
  echo "herd-spawn: ${gate_none}: the worker ${name} has no landing gate; a landing it makes runs where it runs" >&2
fi
# Step 2: the record, and the launcher. wall.log is this spawn's own (rewritten, like the
# profile); run.py appends to it -- the start, and any kill -- from outside the wall.
if [[ "$bounded" == "yes" ]]; then
  bounds_said="cpu=${wall_cpu}s mem=${wall_mem}MB procs=${wall_procs}"
else
  bounds_said="bounds=none"
fi
# The test runners a worker is told to run (intake 20261028T150531Z), each by the first of:
# the repository's own copy at the relative path, where the cwd carries it as a regular file
# (the path a repo with its own wrapper keeps); the rig's scripts dir (the brief's
# {{SCRIPTS}}), by its absolute path; else a copy of this script's own, written by the block
# below once, mode 0500, a real file beside land.sh in walls/<name>/, where the walled worker
# cannot write. A rig without them is muretai-trunk today and every de-vendored consumer
# later. The brief names (its relative spelling re-spelled at render, below), and the worker
# profile allows, exactly the path chosen here, never a relative path a repository without
# the file lets a worker plant.
run_rel=".cursor/skills/isolated-session/scripts"
run_test_sh="$spawn_scripts/run-test.sh"
run_node_sh="$spawn_scripts/run-node.sh"
run_php_sh="$spawn_scripts/run-php.sh"
wall_runners=""
for wr in run-test.sh run-node.sh run-php.sh; do
  if [[ -f "$cwd/$run_rel/$wr" && ! -L "$cwd/$run_rel/$wr" ]]; then
    wr_at="$run_rel/$wr"
  elif [[ -f "$spawn_scripts/$wr" && ! -L "$spawn_scripts/$wr" ]]; then
    continue
  elif [[ -f "$here/$wr" && ! -L "$here/$wr" ]]; then
    wall_runners="${wall_runners:+${wall_runners} }${wr}"
    wr_at="$wall_dir/$wr"
  else
    continue
  fi
  case "$wr" in
    run-test.sh) run_test_sh="$wr_at" ;;
    run-php.sh) run_php_sh="$wr_at" ;;
    *) run_node_sh="$wr_at" ;;
  esac
done
unset wr wr_at run_rel
# The landing the launcher may serve for a walled worker (run.py's Gate): the branch the
# worker's cwd has checked out NOW, at spawn, in the file the worker cannot write -- never
# what the worker's worktree says later, and never what its request says. wall_branch and
# wall_gitdir were read before the profile, so the record and the wall name the same ref.
HS_WALL_DIR="$wall_dir" HS_NAME="$name" HS_AGENT_CMD="$agent_cmd" HS_PY="$wall_py" \
  HS_HERD="$herd_dir" HS_CWD="$cwd" HS_PRIMARY="$wall_primary" HS_BRANCH="$wall_branch" \
  HS_COMMON="$wall_common" HS_GITDIR="$wall_gitdir" HS_LAND="$here/land.sh" \
  HS_RECORD="spawn worker=${name} profile=${profile_said} harness=${harness} mode=${wall_mode} wall=${wall_state} egress=open ${bounds_said}${wall_why:+ ${wall_why}}" \
  HS_WALLED="$wall_state" HS_BOUNDED="$bounded" HS_CPU="$wall_cpu" HS_MEM="$wall_mem" HS_PROCS="$wall_procs" \
  HS_GATE_NONE="$gate_none" HS_PROFILE="$profile" \
  HS_CURSOR_RULES_NOTE="${cursor_rules_note-}" \
  HS_LANE="$lane" HS_SCRIPTS="$spawn_scripts" HS_HERE="$here" HS_WALL_RUNNERS="$wall_runners" \
  python3 -I - <<'PY' || exit 2
import json, os, shlex, subprocess, time
wd = os.environ["HS_WALL_DIR"]


def write(rel, text, mode=0o600):
    p = os.path.join(wd, rel)
    if os.path.lexists(p):
        os.unlink(p)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    if isinstance(text, bytes):
        with os.fdopen(fd, "wb") as f:
            f.write(text)
        return
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)


stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
logged = stamp + " " + os.environ["HS_RECORD"] + "\n"
if os.environ.get("HS_GATE_NONE"):
    logged += stamp + " " + os.environ["HS_GATE_NONE"] + "\n"
if os.environ.get("HS_CURSOR_RULES_NOTE"):
    logged += stamp + " " + os.environ["HS_CURSOR_RULES_NOTE"] + "\n"
write("wall.log", logged)
# The wall's test runners (see run_test_sh above): $here's bytes, read without following a
# link; a planted link or stranger at the wall path is unlinked by write(), never followed.
# A rig that carries its own leaves no wall copy behind from an earlier spawn of the name.
for wr in ("run-test.sh", "run-node.sh", "run-php.sh"):
    if wr in os.environ.get("HS_WALL_RUNNERS", "").split():
        fd = os.open(os.path.join(os.environ["HS_HERE"], wr), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as f:
            write(wr, f.read(), 0o500)
    elif os.path.lexists(os.path.join(wd, wr)):
        os.unlink(os.path.join(wd, wr))
shim =os.path.join("bin", os.environ["HS_AGENT_CMD"])
# grok: the run.py launcher is the wall entry walled/grok; bin/grok is the argv shim the grok
# branch writes below, which runs $HERD_DIR/<name>/grok-launch.sh, which execs this entry
if os.environ["HS_AGENT_CMD"] == "grok":
    shim = os.path.join("walled", "grok")
if os.environ["HS_BOUNDED"] != "yes":
    for rel in ("run.json", shim, os.path.join("bin", os.environ["HS_AGENT_CMD"])):
        if os.path.lexists(os.path.join(wd, rel)):
            os.unlink(os.path.join(wd, rel))
else:
    common = os.environ.get("HS_COMMON", "")
    branch = os.environ.get("HS_BRANCH", "")
    gitdir = os.environ.get("HS_GITDIR", "")

    def has_ref(ref):
        if not common:
            return False
        return subprocess.run(["git", "--git-dir", common, "rev-parse", "--verify", "--quiet", ref],
                              capture_output=True).returncode == 0

    base_ref = "main"
    if common and not has_ref("refs/heads/main") and has_ref("refs/heads/master"):
        base_ref = "master"
    base_sha = ""
    if common and has_ref("refs/heads/" + base_ref):
        base_sha = subprocess.run(
            ["git", "--git-dir", common, "rev-parse", "--verify", "--quiet",
             "refs/heads/" + base_ref + "^{commit}"],
            capture_output=True, text=True).stdout.strip()
    # A REVIEWER's checkout is opened at the BASE it reviews from, on a receipt branch of its
    # own, while main already carries the landings it reads (both spawn sites). Its base is
    # that checkout's HEAD now, at spawn: land.sh runs BASE's gate out of it and tests the
    # receipt range from it, and the landed tip would name commits the reviewer never branched
    # from. A worker's base stays main at spawn.
    if os.environ.get("HS_PROFILE") == "reviewer" and branch and gitdir:
        base_sha = subprocess.run(
            ["git", "--git-dir", gitdir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            capture_output=True, text=True).stdout.strip()
    record = None
    if branch and common:
        record = {"common_dir": os.path.realpath(common),
                  "worktree_gitdir": os.path.realpath(gitdir) if gitdir else "",
                  "base_ref": base_ref, "base_sha": base_sha, "branch": branch,
                  "branch_ref": "refs/heads/" + branch,
                  "worktree": os.path.realpath(os.environ["HS_CWD"]),
                  "primary": os.path.realpath(os.environ["HS_PRIMARY"])}
    # The wall's land.sh is BASE's committed copy, read the way run.py's base_land_blob reads
    # it (ls-tree, then cat-file of a regular blob at refs/heads/<base_ref>), because the gate
    # refuses a wall copy that is not BASE's byte for byte. A BASE that carries none (a pinned
    # consumer) keeps this script's copy. A link, or any other non-regular entry, is refused.
    # Written once here, mode 0500, a real file.
    land_rel = ".cursor/skills/isolated-session/scripts/land.sh"
    land = None
    if common and has_ref("refs/heads/" + base_ref):
        genv ={k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        tip = "refs/heads/" + base_ref
        why = ""
        try:
            rec = subprocess.run(["git", "--git-dir", common, "ls-tree", "-z", "--full-tree", tip, "--",
                                  land_rel], capture_output=True, env=genv, timeout=60)
        except (OSError, subprocess.TimeoutExpired):
            rec = None
        if rec is None or rec.returncode != 0:
            why = "BASE's tree at %s could not be listed for its land.sh" % tip
        else:
            head, _, rawpath = rec.stdout.rstrip(b"\0").partition(b"\t")
            fields = head.split()
            if rawpath.decode("utf-8", "replace") != land_rel:
                pass
            elif len(fields) == 3 and fields[0] == b"120000":
                why = "BASE's %s at %s is a symlink: a land.sh is never seeded through a link" % (land_rel, tip)
            elif len(fields) != 3 or fields[1] != b"blob" or fields[0] not in (b"100644", b"100755"):
                why = "BASE's %s at %s is not a regular file" % (land_rel, tip)
            else:
                try:
                    blob = subprocess.run(["git", "--git-dir", common, "cat-file", "blob", fields[2].decode()],
                                          capture_output=True, env=genv, timeout=60)
                except (OSError, subprocess.TimeoutExpired):
                    blob = None
                if blob is None or blob.returncode != 0:
                    why = "BASE's %s at %s could not be read" % (land_rel, tip)
                else:
                    land = blob.stdout
        if why:
            if os.path.lexists(os.path.join(wd, "land.sh")):
                os.unlink(os.path.join(wd, "land.sh"))
            raise SystemExit("herd-spawn: %s; the worker %s was not started" % (why, os.environ["HS_NAME"]))
    src = os.environ.get("HS_LAND", "")
    if land is None and src and os.path.isfile(src) and not os.path.islink(src):
        with open(src, "rb") as f:
            land = f.read()
    if land is not None:
        write("land.sh", land, 0o500)
    gate = None
    # no gate on the base branch: a cwd in the primary (see gate_none in the shell above)
    if os.environ["HS_WALLED"] == "walled" and branch and record and branch != base_ref:
        gate = {"channel": os.path.join(os.environ["HS_HERD"], os.environ["HS_NAME"]),
                "primary": record["primary"], "worktree": record["worktree"], "branch": branch,
                "lander": os.path.join(wd, "land.sh")}
        gate.update(record)
    # The lane is on every --lane fast spawn's record, as the header says. A cwd with no
    # branch (a detached checkout) has no landing record, so its record is the lane alone;
    # the gate above was decided first and stays None there.
    if os.environ.get("HS_LANE") == "fast":
        if not isinstance(record, dict):
            record = {}
        record["lane"] = "fast"
    write("run.json", json.dumps({
        "worker": os.environ["HS_NAME"], "log": os.path.join(wd, "wall.log"),
        "cpu": int(os.environ["HS_CPU"]), "mem_mb": int(os.environ["HS_MEM"]), "procs": int(os.environ["HS_PROCS"]),
        "walled": os.environ["HS_WALLED"] == "walled", "inherited": os.environ["HS_WALLED"] == "inherited",
        "plug": os.path.join(wd, "plug.sh"),
        "profile": os.path.join(wd, "profile"), "command": os.environ["HS_AGENT_CMD"],
        "shim_dir": os.path.join(wd, "bin"), "bash": "/bin/bash",
        "scripts_dir": os.environ["HS_SCRIPTS"],
        "record": record, "gate": gate}, indent=1) + "\n")
    write(shim, "#!/bin/bash\n"
          "# herd-spawn.sh wrote this launcher for the worker " + os.environ["HS_NAME"] + ": the tab's PATH\n"
          "# finds it first, and it starts the agent under the bounds (and behind the wall, when\n"
          "# the spawn was walled) -- see run.py and run.json beside it.\n"
          "exec " + " ".join(shlex.quote(a) for a in (os.environ["HS_PY"], "-I", os.path.join(wd, "run.py"), "run",
                                                       os.path.join(wd, "run.json"), "--")) + ' "$@"\n', 0o700)
PY
# grok 1.0.41 has no hooks file this spawn can register (grok --help lists no hooks
# flag; the config directory holds none). Said here, where the wall record is. The
# claim that the session guard already covers this pane stays out until a hook
# registration exists.
if [[ "$harness" == "grok" ]]; then
  printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" \
    "hook=none (grok has no hooks file: grok --help lists no hooks flag and the grok config directory holds no hooks config) ISSUE(grok-harness-has-no-hook)" \
    >> "$wall_dir/wall.log"
fi
# Only a spawn that GETS a landing needs land.sh: the same test run.json's `gate` uses (walled,
# on a branch, in a repository). A spawn in a detached checkout has no branch to land, so
# nothing would ever run the lander; refusing it for a missing one refused the daily review.
# Both reviewer spawn sites now open the reviewer ON its receipt branch, so a walled reviewer
# gets the gate, and needs land.sh, like a worker.
if [[ "$wall_state" == "walled" && -n "$wall_branch" && -n "$wall_common" && ! -f "$wall_dir/land.sh" ]]; then
  echo "herd-spawn: no land.sh beside this script; a walled worker has no landing to run; the worker ${name} was not started" >&2
  exit 2
fi

# --- the brief, filled ----------------------------------------------------------------
# Built-ins first, --var after, so a caller can override NAME/PRIMARY/REPORT on purpose.
# One pass with a dict: a value is substituted, never re-scanned, so a value carrying
# `{{NAME}}` stays literal. A placeholder the TEMPLATE carries and nobody filled stops
# the spawn. The text is rendered once and written twice: the worker's brief.md, and the
# operator's copy under briefs/ (the brief may already BE that path -- a landing renders
# there, then calls this script on it -- so it is read once, before either write).
# Both files are written the way the rules file is: the exact path unlinked, then created
# O_EXCL mode 600. For the operator's copy a symlink goes and its target stays. For
# brief.md only a REGULAR file is unlinked (the re-spawn of a name gets its new brief);
# a symlink or a directory there is exit 2 BEFORE the operator's copy is touched, and a
# path that exists again between the unlink and the create is a refusal, never a merge.
# {{PRIMARY}} is the git primary of the cwd. A linked worktree used to be told the
# worktree itself, so the brief's finish-worktree.sh line named the worktree's copy,
# which the cursor rules refuse. iso_primary_of is unchanged; pwd -P resolves the path
# it returns. A cwd that is the primary itself stays that path. --var PRIMARY= still
# overrides: the built-ins are filled first.
brief_primary="$cwd"
if [[ -f "$cwd/.git" ]]; then
  _linked_primary="$(iso_primary_of "$cwd" 2>/dev/null || true)"
  if [[ -n "${_linked_primary}" && "${_linked_primary}" != "$cwd" && -d "${_linked_primary}" ]]; then
    if _resolved="$(cd "${_linked_primary}" && pwd -P)"; then
      brief_primary="$_resolved"
    fi
  fi
fi
unset _linked_primary _resolved
HS_RUN_TEST="$run_test_sh" HS_RUN_NODE="$run_node_sh" HS_RECEIPT_WALL="$receipt_wall" \
  python3 -I - "$brief_abs" "$rendered" "$bfile" "NAME=${name}" "PRIMARY=${brief_primary}" "REPORT=${report}" \
  "SCRIPTS=${spawn_scripts}" \
  ${vars[@]+"${vars[@]}"} <<'PY' || exit $?
import os, re, stat, sys
src, dst, bfile = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(src, encoding="utf-8") as f:
        text = f.read()
except (OSError, UnicodeDecodeError) as e:
    print("herd-spawn: the brief " + src + " could not be read (" + (getattr(e, "strerror", None) or type(e).__name__)
          + "); the worker " + os.path.basename(os.path.dirname(bfile)) + " was not started", file=sys.stderr)
    sys.exit(2)
# A reviewer whose checkout lacks write-receipt.sh is told the wall copy the spawn wrote
# (see THE REVIEWER'S RECEIPT WRAPPER): the template's relative receipt spelling becomes it,
# in the template text, before any value is filled.
receipt_wall = os.environ.get("HS_RECEIPT_WALL", "")
if receipt_wall:
    text = text.replace("bash .cursor/skills/isolated-session/scripts/write-receipt.sh ",
                        "bash " + receipt_wall + "/write-receipt.sh ")
# The test runners by the path chosen above (run_test_sh): the template names each by the
# relative skill path, and that literal is re-spelled in the TEMPLATE text, before any value
# is filled, so a value is still never touched.
for rel, env in (("run-test.sh", "HS_RUN_TEST"), ("run-node.sh", "HS_RUN_NODE")):
    lit = ".cursor/skills/isolated-session/scripts/" + rel
    at = os.environ.get(env, "")
    if at and at != lit:
        text = text.replace("bash " + lit + " ", "bash " + at + " ")
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


worker = os.path.basename(os.path.dirname(bfile))


def refuse(why):
    print("herd-spawn: " + bfile + " " + why + "; brief.md is never written through or over one -- "
          "remove it if the name is yours to re-spawn; the worker " + worker + " was not started",
          file=sys.stderr)
    sys.exit(2)


def not_regular(p):
    st = os.lstat(p)
    return not stat.S_ISREG(st.st_mode)


if os.path.lexists(bfile) and not_regular(bfile):
    refuse("is a symlink or not a regular file")
if os.path.lexists(dst):
    os.unlink(dst)
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(out)
# a re-spawn of the name: the previous brief.md (a regular file, checked above) is
# replaced by this render -- unlinked by its exact path, then created O_EXCL
if os.path.lexists(bfile):
    if not_regular(bfile):
        refuse("became a symlink or a non-regular file while the brief was rendered")
    os.unlink(bfile)
try:
    fd = os.open(bfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except OSError as e:
    refuse("could not be created exclusively (" + (e.strerror or type(e).__name__) + ")")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(out)
PY
# The template's five-step block stays intact (tests/test_denied_test_run.py). A cursor
# test author whose worktree this spawn just opened is told so in the rendered brief
# only: the worktree and branch by name, skip ensure-worktree.sh, no numbered step that
# runs it. stale.sh and assert-head.sh stay.
if [[ "$author_worktree" == "yes" ]]; then
  author_real="$(cd "$open_wt" && pwd -P)" || author_real="$open_wt"
  python3 -I - "$rendered" "$bfile" "$open_wt" "$open_branch" "$author_real" <<'PY' || exit $?
import os, re, sys
rendered, bfile, wt, branch, real = sys.argv[1:6]
shown = wt if (not real or real == wt) else (wt + " (" + real + ")")
phrase = ("and this directory is its PRIMARY checkout: read-only for you "
          "(the project's hooks refuse edits here).")
instead = ("and its primary checkout is read-only (the project's hooks refuse edits there). "
           "The worktree is already open at %s on %s. Skip ensure-worktree.sh."
           % (shown, branch))
pat = re.compile(r"^2\. `?bash [^\n]*ensure-worktree\.sh[^\n]*$", re.M)
repl = ("2. The worktree is already open at %s on %s. Skip ensure-worktree.sh. "
        "Every file you touch lives under that worktree." % (shown, branch))


def rewrite(text):
    text = text.replace(phrase, instead, 1)
    text, n = pat.subn(repl, text, count=1)
    if n != 1:
        return None
    text = text.replace("<WORKTREE>", wt).replace("<BRANCH>", branch)
    if not text.endswith("\n"):
        text += "\n"
    return text


def write(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)


try:
    with open(bfile, encoding="utf-8") as f:
        out = rewrite(f.read())
except (OSError, UnicodeDecodeError) as e:
    print("herd-spawn: the rendered brief could not be read (" + type(e).__name__
          + "); the worker was not started", file=sys.stderr)
    sys.exit(2)
if out is None:
    print("herd-spawn: the rendered test-author brief has no step-2 ensure-worktree.sh "
          "line to mark already open; the worker was not started", file=sys.stderr)
    sys.exit(2)
try:
    write(rendered, out)
    write(bfile, out)
except OSError as e:
    print("herd-spawn: the rendered brief could not be marked already open ("
          + (e.strerror or type(e).__name__) + "); the worker was not started", file=sys.stderr)
    sys.exit(2)
PY
fi
# brief.md is this spawn's own from here: a failure below where nothing was typed into the
# pane removes it (a refusal above never reaches this line, and leaves the file that was
# there alone). A failure of `agent prompt` itself, and a stop at a first-run prompt, keep
# it: see half_fail.
brief_ours=yes
# What a failure below has already done, for the one line it prints: the coordinator
# must never read a half-spawn as a success, and "which half" is what it acts on.
done_steps="brief.md written (${bfile})"
# A resume record an earlier spawn of this name left names a pane this spawn is replacing:
# it goes, so a --resume can only ever pick up the spawn that wrote the brief.md above.
# A start-timeout record is not that: the tab is still the one herdr opened, and deleting
# the record is what let the same name be spawned again. Refuse before the record goes,
# and before another tab is created. brief.md was rewritten above from this call's brief;
# it stays, with the records, because this exit is not a failed start.
# A render replaces no pane and leaves the resume record as it is.
resume_dir="$herd_dir/.resume"
resume_rec="$resume_dir/${name}"
if [[ "$render" != "yes" && -f "$resume_rec" && ! -L "$resume_rec" ]] && grep -F -x -q 'stop=start-timeout' "$resume_rec"; then
  brief_ours=no
  echo "herd-spawn: ${name} already has a tab left open after 'timed out waiting for agent startup' (${resume_rec}). The tab stays. Do not spawn ${name} again; bash ${here}/herd-spawn.sh --resume ${name} delivers the line when the agent can take input. Nothing was started" >&2
  exit 2
fi
if [[ "$render" != "yes" && -d "$resume_dir" && ! -L "$resume_dir" ]]; then
  rm -f "$resume_rec"
fi
drop_brief() {
  if [[ "${brief_ours:-no}" == "yes" ]]; then
    rm -f "$bfile"
    # a solo role belongs to a worker that was started; a failed spawn declares nothing,
    # and records no repository for a report that will never come. A render wrote none of
    # them, so the ones there (an earlier spawn's of the name) are not its to remove.
    if [[ "$render" != "yes" ]]; then
      rm -f "$role_marker" "$role_record" "$repo_record" "$key_record"
    fi
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
# A cursor worker's own config directory, the per-spawn $HERD_DIR/.cursor-homes/<name>.<unique>
# named above, made now that the name is this spawn's: mkdir fails on anything already at
# that path, so nothing an earlier spawn left (a cli-config.json with an allow in it, a
# hooks.json, a symlink) is handed on or taken over, and no earlier spawn's wall opens it
# (intake 20261009T173850Z). cli-config.json is created in it O_EXCL|O_NOFOLLOW: allowlist
# mode, as herd-spawn requires of the user's file, and no allow of its own. The directory
# is then named in $HERD_DIR/.cursor-homes/<name>, the record --resume reads it from. The
# old slot $HERD_DIR/<name>/cursor is neither read nor handed on. The worker's rules stay
# in <cwd>/.cursor/cli.json.
if [[ "$harness" == "cursor" && "$profile" != "coordinator" ]]; then
  cursor_home="$cursor_worker_home"
  cursor_worker_refuse() {
    echo "herd-spawn: ${cursor_home} (the worker's CURSOR_CONFIG_DIR) $1; it is never followed or written through; the worker ${name} was not started" >&2
    exit 2
  }
  # One pane per name, checked long before the tab: a pane herdr still lists as ${name} is
  # an earlier worker of that name whose processes may be writing under $HERD_DIR/<name>
  # while the new tab opens (ISSUE(security-audit-2026-10-09-pin-the-cursor-worke-0a6d)).
  # A listing that does not answer is a refusal too. A render opens no tab and asks herdr
  # nothing.
  elsewhere=""
  if [[ "$render" != "yes" ]] &&
     ! elsewhere="$(herdr_lists_elsewhere "$name" "$failover_replace_pane" "$failover_replace_tab")"; then
    echo "herd-spawn: herdr's listing did not answer (${elsewhere:-no reason}), so whether an earlier pane named ${name} is still live cannot be told; the worker ${name} was not started" >&2
    exit 2
  fi
  if [[ -n "$elsewhere" ]]; then
    echo "herd-spawn: herdr still lists ${name} at $(printf '%s' "$elsewhere" | tr '\n' ',' | sed 's/,$//; s/,/, /g'); an earlier worker of that name may still write under ${herd_dir}/${name}; close that tab first; the worker ${name} was not started" >&2
    exit 2
  fi
  cursor_homes="$herd_dir/.cursor-homes"
  [[ -n "$cursor_home" && -d "$cursor_homes" && ! -L "$cursor_homes" && -O "$cursor_homes" ]] ||
    cursor_worker_refuse "has no private ${cursor_homes} to live in"
  mkdir -m 700 "$cursor_home" 2>/dev/null || cursor_worker_refuse "could not be created afresh"
  [[ ! -L "$cursor_home" && -d "$cursor_home" && -O "$cursor_home" ]] ||
    cursor_worker_refuse "is not a directory owned by $(id -un)"
  chmod 700 "$cursor_home" 2>/dev/null || cursor_worker_refuse "could not be closed to others"
  python3 -I - "$cursor_home/cli-config.json" <<'PY' || cursor_worker_refuse "could not be seeded with cli-config.json"
import json, os, sys
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
try:
    fd = os.open(sys.argv[1], flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"approvalMode": "allowlist", "permissions": {"allow": [], "deny": []}}, f, indent=1)
        f.write("\n")
except OSError:
    sys.exit(1)
PY
  # the record --resume reads the directory from: unlinked by exact path, created O_EXCL
  python3 -I - "$cursor_homes/${name}" "$cursor_home" <<'PY' || cursor_worker_refuse "could not be recorded in ${cursor_homes}/${name}"
import os, sys
path, value = sys.argv[1], sys.argv[2]
try:
    if os.path.lexists(path):
        os.unlink(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(value + "\n")
except OSError:
    sys.exit(1)
PY
fi

# --- the role, declared ------------------------------------------------------------------
# Only after brief.md was created exclusively: the name is this spawn's from here, so what
# an earlier spawn of it left is ours to replace. Every WORKER-profile spawn declares solo,
# with or without `--role solo` (coordinator ruling 2026-09-26, Option B): operator spawns
# made without the flag (invariant-gate-tests, four-guards) had no record, and their
# REPORT lines never reached the coordinator. A pair worker is still not solo: its brief
# opens as a template, and appl-role-of.sh lets the template win over any record. The
# marker and the spawn's own record are each unlinked by exact path (a planted symlink
# goes, never followed) and created O_EXCL mode 400. A reviewer spawn REMOVES the marker
# and writes the spawn's record alone, reading `reviewer`, the same way: a coordinator
# ruling's own review brief is none of the templates, and with no record its REPORT was
# logged `unrecorded` (ISSUE(reviewer-pane-first-call-is-a-chained-cat-then-the-denial-
# rule-kills-it)). appl-role-of.sh reads `reviewer` from that herd-level record only, never
# from a marker in the worker's own directory, and a template still wins over it. A
# coordinator spawn declares nothing and REMOVES both, so a record an earlier spawn of the
# name left never makes it solo or reviewer (ISSUE(solo-marker-is-worker-writable)).
# A render holds no worker state: the role, the .repos record and the .keys record below
# are written for a worker that is started, so a render writes and removes none of them.
if [[ "$render" != "yes" ]]; then
if [[ "$profile" == "worker" || "$profile" == "reviewer" ]]; then
  role_word="solo"
  role_files=("$role_marker" "$role_record")
  if [[ "$profile" == "reviewer" ]]; then
    rm -f "$role_marker"
    role_word="reviewer"
    role_files=("$role_record")
  fi
  python3 -I - "$role_word" "${role_files[@]}" <<'PY' || exit 2
import os, sys
for path in sys.argv[2:]:
    if os.path.lexists(path):
        os.unlink(path)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    except OSError as e:
        print("herd-spawn: could not create the role file exclusively at " + path + ": " + e.strerror
              + "; the worker was not started", file=sys.stderr)
        sys.exit(2)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(sys.argv[1] + "\n")
PY
else
  rm -f "$role_marker" "$role_record"
fi

# --- the repository the report is judged in ----------------------------------------------
# Every worker, whatever its role: unlinked by exact path, created O_EXCL mode 600 in the
# herd-level .repos/ (mode 700, Edit-denied to every session), before the tab exists. The
# hook reads it and nothing else to name `appl-verify.sh --repo`; with no record it blocks.
python3 -I - "$repo_record" "$spawn_repo" <<'PY' || exit 2
import os, sys
path, repo = sys.argv[1], sys.argv[2]
if os.path.lexists(path):
    os.unlink(path)
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
except OSError as e:
    print("herd-spawn: could not create the repository record exclusively at " + path + ": " + e.strerror
          + "; the worker was not started", file=sys.stderr)
    sys.exit(2)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(repo + "\n")
PY

# --- the owner key this worker holds -----------------------------------------------------
# $HERD_DIR/.keys/<name>: the caller's --env ISOLATED_SESSION_OWNER and a newline, made the
# way the .repos record is, removed with the brief when the spawn fails. key_guard reads it
# to name the live worker a later spawn under the same key would duplicate. A walled (or
# inherited-wall) worker with no caller key gets its own name on its tab (THE OWNER KEY), and
# that key is recorded the same way, so the implementer's spawn reads it back rather than
# retyping it (ISSUE(spawn-hands-a-key-that-does-not-match-the-lock)). A spawn that puts no
# key on the tab removes one an earlier spawn of the name left.
record_key="$caller_key"
if [[ -z "$record_key" ]] && [[ "$wall_state" == "walled" || "$wall_state" == "inherited" ]]; then
  record_key="$owner_key"
fi
if [[ -n "$record_key" ]]; then
  python3 -I - "$key_record" "$record_key" <<'PY' || exit 2
import os, sys
path, key = sys.argv[1], sys.argv[2]
if os.path.lexists(path):
    os.unlink(path)
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
except OSError as e:
    print("herd-spawn: could not create the owner-key record exclusively at " + path + ": " + e.strerror
          + "; the worker was not started", file=sys.stderr)
    sys.exit(2)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(key + "\n")
PY
else
  rm -f "$key_record"
fi
fi

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
# The coordinator is the one pane that runs for days. Claude Code's in-pane auto-update
# ended it mid-loop twice (2026-09-24, 2026-09-26: `Update installed - Restart to update`
# beside `Not logged in`), after which it swallowed every intake until the owner found it.
# With the updater off, the update happens when the owner restarts the pane on purpose
# (restart-coordinator-pane.sh). A caller override was refused above.
if [[ "$profile" == "coordinator" ]]; then
  tab_env+=(--env DISABLE_AUTOUPDATER=1)
fi
# THE OAUTH TOKEN (above): the pane's own login, so it never refreshes the shared one
if [[ -n "$oauth_token" ]]; then
  tab_env+=(--env "CLAUDE_CODE_OAUTH_TOKEN=${oauth_token}")
fi
if [[ "$harness" == "codex" ]]; then
  # the config home the spawn owns, so the file we wrote is the file codex obeys; no path
  # under the user's own ~/.codex is handed to the tab at all
  tab_env+=(--env "CODEX_HOME=${codex_home}")
fi
if [[ "$harness" == "grok" ]]; then
  # exactly the home the bypass check read, so the grok the herdr daemon starts never falls
  # back to another (intake 20261009T202249Z)
  tab_env+=(--env "GROK_HOME=${grok_home}")
fi
# the launcher first on the tab's PATH, so the harness binary herdr starts is the wall's
# and the bounds' (a caller --env PATH= is refused where --env is parsed)
if [[ "$bounded" == "yes" ]]; then
  tab_env+=(--env "PATH=${wall_dir}/bin:${PATH}")
fi
for kv in ${envs[@]+"${envs[@]}"}; do
  tab_env+=(--env "$kv")
done
# A walled worker's stable owner key (THE OWNER KEY, in the wall block): the caller's entry
# went on above and is the only one; without it, the worker's name. An unwalled worker keeps
# the process walk, which works where `ps` does.
if [[ "$wall_state" == "walled" || "$wall_state" == "inherited" ]] && [[ "$owner_key_from_caller" != "yes" ]]; then
  tab_env+=(--env "ISOLATED_SESSION_OWNER=${owner_key}")
fi
# Wake-target mark: the pane env is what a node child / L0 hook can see. The
# token is the first non-DID mark herdrwake._select recognises. Never a DID.
if [[ -n "$muretai_agent" ]]; then
  tab_env+=(--env "MURETAI_HERDR_AGENT=${muretai_agent}")
fi
# The seed, read again as the last step before the tab opens (cursor_home_verify, above):
# it was written well before this point, and is handed on only as it was written.
if [[ "$harness" == "cursor" && "$profile" != "coordinator" ]] && ! why="$(cursor_home_verify "$cursor_home")"; then
  cursor_worker_refuse "$why, after it was seeded"
fi
# The grok home's config, read again as the last step before the tab opens: the first read
# was long before, and the home is the one the tab is handed (intake 20261009T202248Z).
if [[ "$harness" == "grok" ]]; then
  grok_home_check ", checked again just before the tab"
fi
# A render makes no tab: the rules below are written all the same, then it stops.
if [[ "$render" != "yes" ]]; then
tab_json="$("$herdr" tab create --cwd "$cwd" --label "$name" --no-focus "${tab_env[@]}")" ||
  half_fail 1 "'herdr tab create' failed for ${name}, so no tab and no pane exist"
ids="$(printf '%s\n' "$tab_json" | python3 -I -c '
import json, sys
d = json.load(sys.stdin)
r = d.get("result", d)
print(r["root_pane"]["pane_id"], r["tab"]["tab_id"])
')" || half_fail 1 "could not read pane/tab ids from 'herdr tab create' output for ${name} (a tab may be open under the label ${name})"
pane="${ids%% *}"
tab_id="${ids#* }"
done_steps="${done_steps}, tab created (pane ${pane}, tab ${tab_id}; left open)"
if [[ -n "$muretai_agent" ]]; then
  # Pane id is known only after tab create. Token only -- never muretai_did
  # (a spawn must not write a DID onto argv or into the brief).
  "$herdr" pane report-metadata "$pane" --source muretai \
      --token "muretai_agent=${muretai_agent}" >/dev/null ||
    half_fail 1 "'herdr pane report-metadata' failed for ${name} (pane ${pane}); the agent was not started"
fi
fi

if [[ "$profile" == "coordinator" ]]; then
  # Exactly this list, nothing shared with the others: spawn (both spellings, the second
  # through the primary of the repository this script lives in), drive panes, read the
  # node inbox, dm, read the coordinator directory, write only its intake/ and briefs/.
  # No git, no echo, no tools/: a coordinator that needs more briefs a worker. Its one
  # tests rule is the shared `python3 -I tests/*.py`, added after this block for every seat.
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
    "Bash(muretai op --as * inbox)" "Bash(muretai op --as * inbox --json)"
    "Bash(muretai op --as * dm *)"
    "Read(//${coord_dir#/}/**)"
    "Edit(//${coord_dir#/}/intake/**)" "Edit(//${coord_dir#/}/briefs/**)"
  )
  # The coordinator harness (plan 2026-09-19): the pane's deterministic steps, each script
  # by its exact path (both spellings, like the spawner: never a directory or an `appl-*`
  # glob, which would run whatever a diff drops beside them), and the Agent tool for its
  # four small-model subagents only. appl-hook.sh is not here: the hook runs it, the
  # model never needs to. appl-split-check.sh is the split check's wrapper: the
  # checker reads stdin, and a `python3 ... < file` redirect never matches a prefix rule.
  for s in appl-verify.sh appl-status.sh appl-hydrate.sh appl-role-of.sh appl-close.sh \
      appl-split-check.sh appl-note.sh; do
    allow+=("Bash(bash .cursor/skills/isolated-session/scripts/${s}:*)")
    if [[ -n "${spawner_primary:-}" ]]; then
      allow+=("Bash(bash ${spawner_primary}/.cursor/skills/isolated-session/scripts/${s}:*)")
    fi
  done
  # Artifact fetch, publish and grant stay inside this one script. One relative
  # rule and no absolute twin: a second spelling would be a second copy.
  allow+=("Bash(bash .cursor/skills/isolated-session/scripts/appl-artifact.sh:*)")
  allow+=("Agent(appl-brief-writer)" "Agent(appl-report-reader)" "Agent(appl-prompt-triage)" "Agent(appl-splitter)")
elif [[ "$profile" == "release" ]]; then
  # The release solo (`release` in the header): the annotated tag by its one spelling, and
  # read-only git. No task script, no test file, no glue that could redirect. Its Edit
  # allows -- the checkout's VERSION and CHANGELOG.md, nothing wider -- and the deny of
  # every other checkout path are written with the rules file, below.
  allow=(
    "Bash(git tag -a -m * v*)"
    "Bash(cd:*)" "Bash(pwd)"
    "Bash(git status:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(git diff:*)"
    "Bash(git rev-parse:*)" "Bash(git describe:*)"
  )
else
# The reviewer's ONE write through a tool is its receipt, and write-receipt.sh (below) is its
# only path to it: the wrapper refuses --full and a missing --range, and a direct
# `python3 [-I] tools/audit_scope.py write-receipt` would skip both, so a reviewer steered by
# planted finding text could write a receipt covering landings nobody read
# (ISSUE(security-audit-2026-10-09-the-daily-reviewer-b-c9fb)). The reviewer gets no
# audit_scope.py rule at all; other profiles keep the whole tool, in the same place.
allow=()
if [[ "$profile" != "reviewer" ]]; then
  allow+=("Bash(python3 tools/audit_scope.py:*)")
fi
allow+=(
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
  # the no-stops plan's S2: the task scripts of the worker's own worktree (no-space `*`:
  # `tools/*` is any path under tools/). The tests rules are prefix rules only (intake
  # 20261028T150531Z): the harness reads `Bash(<p>:*)` as every command that starts with <p>,
  # and no other `*` shape as a prefix, so `Bash(python3 tests/*)` and
  # `Bash(env -u * python3 tests/*)` allowed nothing the briefs name and are gone
  allow+=("Bash(python3 tools/*)")
  # The other harnesses read their own rules from these (cursor_rule() re-spells them) and
  # keep the shapes they had: `python3 tests/*` behind `env -u X` too (a bare
  # `env *python3 tests/*` also matched `env python3 -c '<code>' python3 tests/x`).
  if [[ "$harness" != "claude" && "$harness" != "codex" ]]; then
    allow+=("Bash(python3 tests/*)" "Bash(env -u * python3 tests/*)")
  fi
  # the test files in the isolated spelling, the one the briefs name, as the same prefix
  allow+=("Bash(python3 -I tools/run_tests.py:*)" "Bash(python3 -I tests/test_:*)")
  # Dispatch finish verbs the ticket brief names: coord deliver, a Room dm
  # (deliverable, /remember, or failed), and stance full via dispatch-capacity.
  # A bare `muretai op` prefix would let a ticket drive wake set/test. Both go through the
  # front door, never an interpreter: an interpreter-spelled rule sits in the family the
  # deny list refuses by shape, so a dm whose text held ` - `, `-m` or `-c` was shadowed.
  allow+=("Bash(muretai op --as * coord * deliver *)")
  allow+=("Bash(muretai op --as * dm *)")
  allow+=("Bash(bash .cursor/skills/isolated-session/scripts/dispatch-capacity.sh:*)")
  # The JavaScript test-run spelling the briefs name (intake 20261003T215502Z): run-node.sh
  # runs node on ONE regular file under the repository's conformance/ or tests/ (symlinks
  # resolved) with NODE_OPTIONS unset, and refuses everything else, so this one fixed shape
  # is safe in every repository -- and a brief naming it must not stop a worker where node
  # is not the test runner (tests/test_claude_worker_profile_runs_briefs.py). Both runners by
  # the one absolute path the brief names: the rig's own, or the wall copy (run_test_sh above),
  # never a relative path a repository without the file would let a worker plant. The other
  # harnesses keep the one relative run-node.sh rule: cursor writes its own narrow Shell
  # spellings of both runners (cursor_rule() below), and a `:*` here would widen them.
  if [[ "$harness" == "claude" || "$harness" == "codex" ]]; then
    allow+=("Bash(bash ${run_test_sh}:*)" "Bash(bash ${run_node_sh}:*)")
    # The php twin (intake 20261031T191113Z): run-php.sh runs php on ONE regular .php file
    # inside the repository (symlinks resolved) with PHPRC and PHP_INI_SCAN_DIR unset, and
    # refuses everything else, so a walled pane runs its php tests by this one shape while
    # bare `php` stays denied. By the path chosen above (run_php_sh), like run-node.sh; codex
    # carries it too because its list is the claude worker's (test_codex_worker_allow_parity).
    allow+=("Bash(bash ${run_php_sh}:*)")
  else
    allow+=("Bash(bash .cursor/skills/isolated-session/scripts/run-node.sh:*)")
  fi
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
if [[ "$profile" != "reviewer" ]]; then
  allow+=("Bash(python3 -I tools/audit_scope.py:*)")
fi
allow+=(
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
  # The reviewer's receipt step: write-receipt.sh by this path and no other script.
  # The worker carries the same rule, so the reviewer profile stays no wider.
  "Bash(bash .cursor/skills/isolated-session/scripts/write-receipt.sh:*)"
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
# The wall copy of write-receipt.sh (THE REVIEWER'S RECEIPT WRAPPER, above), by its one
# absolute path, for a reviewer whose checkout lacks this wrapper. When the checkout
# carries a differing one, the relative rule goes too: it would run that wrapper.
if [[ -n "$receipt_wall" ]]; then
  allow+=("Bash(bash ${receipt_wall}/write-receipt.sh:*)")
fi
if [[ "$receipt_differs" == "yes" ]]; then
  kept=()
  for rule in "${allow[@]}"; do
    [[ "$rule" == "Bash(bash .cursor/skills/isolated-session/scripts/write-receipt.sh:*)" ]] || kept+=("$rule")
  done
  allow=("${kept[@]}")
  unset kept rule
fi
# THE WEEKLY HUNT'S RECEIPT: the weekly profile's one rule beyond the reviewer's. Its brief's
# step 5 writes a FULL receipt, which write-receipt.sh refuses; write-weekly-receipt.sh takes
# that one fixed shape (a weekly-YYYY-MM-DD slug, from the pane of that date) and nothing
# else. The NO-SPACE wildcard, not `:*`: the date continues `weekly-` without a space. The
# per-landing reviewer never gets it (intake 20261009T101928Z).
if [[ "$weekly_hunt" == "yes" ]]; then
  allow+=("Bash(bash .cursor/skills/isolated-session/scripts/write-weekly-receipt.sh tools/audit_scope.py write-receipt --full --slug weekly-*)")
fi
fi
# The one test-run spelling every brief names, `python3 -I tests/<file>.py`, for EVERY profile
# (A1 of intake 20260929T223514Z): a brief that tells a session to run a test file its rules
# do not allow stops it at a prompt on its own instructions. One file, no arguments: the `*`
# ends at `.py`, and a redirect or a pipe half is refused by the deny list whatever this says.
# On claude (and codex, whose list is claude's) a worker and a reviewer get it as the prefix
# rule `Bash(python3 -I tests/test_:*)` instead, each once: that harness reads no other `*`
# shape as a prefix (intake 20261028T150531Z), and the reviewer stays no wider than the worker.
if [[ "$profile" != "release" ]]; then
  if [[ ( "$harness" == "claude" || "$harness" == "codex" ) && "$profile" != "coordinator" ]]; then
    case " ${allow[*]} " in
      *" Bash(python3 -I tests/test_:*) "*) ;;
      *) allow+=("Bash(python3 -I tests/test_:*)") ;;
    esac
  else
    allow+=("Bash(python3 -I tests/*.py)")
  fi
fi
# The read-only list's allows (rendered above; none for release), each once: a profile
# that already names one keeps its own place for it.
for ro_rule in ${ro_allow[@]+"${ro_allow[@]}"}; do
  case " ${allow[*]} " in
    *" ${ro_rule} "*) ;;
    *) allow+=("$ro_rule") ;;
  esac
done
unset ro_rule
# the brief's own --allow rules (judged above), after the profile's
allow+=(${extra_allow[@]+"${extra_allow[@]}"})
# THE CLAUDE WORKER PROFILE, re-spelled for the matcher Claude Code really runs (intake
# 20261003T000031Z part B; notes/2026-10-03-walled-run-denials-claude.md). On a live walled
# claude pane every brief command was refused before it ran: deny beats allow, and the
# stdin-script deny `Bash(python3 -:*)` matched `python3 -I ...` (the prefix read up to a
# word boundary, not up to a space), shadowing the whole family the allow list grants;
# `bash -n <path>` and a read-only `grep` had no allow and fell to `Bash(bash -*)` and
# `Bash(grep:*)`. For a claude (and codex) worker only (the reviewer, the coordinator and
# the other harnesses keep the static list) each of those three rules is replaced IN PLACE, so the
# deny list keeps its order:
#   * `Bash(python3 -:*)` -> `Bash(python3 -)` and `Bash(python3 - *)`: a literal `python3 -`
#     as a whole word, never a prefix that reaches `python3 -I`;
#   * `Bash(bash -*)` -> every dash option but `-n` (letter by letter, like the python shape
#     rules), a cluster that continues `-n`, a second flag after it, `bash -` (stdin), a long
#     option and a `+` option; and `bash -n` aimed out of the worktree (an absolute path,
#     `..`, `~`, `$`) or through a redirect;
#   * `Bash(grep:*)` -> a grep that leaves the worktree (an absolute path, `=/`, `-f/`, `..`,
#     `~`, `$`), follows symlinks out of it (`-R`), or redirects. Since the read-only list
#     (intake 20261007T152501Z) `Bash(grep:*)` is no longer a static deny but an allow every
#     profile takes; this worker keeps those narrowing denies, appended after the list's.
# The allows are NARROW: `bash -n <path>`; `git cherry-pick --quit` (both briefs end a
# cherry-pick sequence with it); and finish-worktree.sh by the PRIMARY's absolute path (the
# implementer brief's step 7, as the cursor worker allows it). The worktree-grep allows this
# block once added are gone: the list's `Bash(grep:*)` covers them. Pinned by
# tests/test_claude_worker_profile_runs_briefs.py.
# The codex worker goes through this SAME block (intake 20261003T221152Z): its
# rules.unenforced.json is the wall a claude worker of this profile is held to, so both
# are derived from these lists and cannot drift apart again
# (tests/test_codex_worker_allow_parity.py).
if [[ ( "$harness" == "claude" || "$harness" == "codex" ) && "$profile" == "worker" ]]; then
  cw_bash=("Bash(bash -)" "Bash(bash - *)" "Bash(bash --*)" "Bash(bash +*)"
           "Bash(bash -n -*)" "Bash(bash -n +*)" "Bash(bash -n  *)"
           "Bash(bash -n /*)" "Bash(bash -n * /*)" "Bash(bash -n *..*)" "Bash(bash -n ~*)" "Bash(bash -n *~*)"
           "Bash(bash -n *\$*)" "Bash(bash -n *>*)" "Bash(bash -n *<*)")
  for cw_flag in a b c d e f g h i j k l m n o p q r s t u v w x y z \
                 A B C D E F G H I J K L M N O P Q R S T U V W X Y Z; do
    [[ "$cw_flag" == "n" ]] || cw_bash+=("Bash(bash -${cw_flag}*)")
    cw_bash+=("Bash(bash -n${cw_flag}*)")
  done
  cw_grep=("Bash(grep /*)" "Bash(grep * /*)" "Bash(grep *=/*)" "Bash(grep *-f/*)" "Bash(grep *..*)"
           "Bash(grep ~*)" "Bash(grep *~*)" "Bash(grep *\$*)" "Bash(grep *-R*)"
           "Bash(grep *--dereference-recursive*)" "Bash(grep *>*)" "Bash(grep *<*)")
  # A NODE-TESTED repository (intake 20261003T215502Z): the cwd holds a package.json, or its
  # appl.toml's [tests] command starts with node, npm or npx. There a fourth static rule,
  # `Bash(node:*)`, is replaced in place so `node --check <relative path>` (a syntax check,
  # nothing runs) can be allowed; every other node line stays denied, under the documented
  # and the word-boundary reading alike (no rule here is a `:*` prefix):
  #   * a bare `node`, and a first operand that is not an option (`node <file>`: the run
  #     goes through run-node.sh, allowed above for every worker);
  #   * every dash option, letter by letter -- `-e`, `-p`, `-r`, ... -- and every long option
  #     but `--check`: `--eval`, `--print`, `--loader`, `--experimental-loader`, `--import`,
  #     `--experimental-network-imports`, `--inspect`, `--require`, ...;
  #   * `node --check` followed by a flag, or by a path that leaves the worktree (an absolute
  #     path, `..`, `~`, `$`) or a redirect.
  # Elsewhere `Bash(node:*)` stays as it is, byte for byte (tests/test_herd_spawn.py).
  cw_node=""
  if [[ -f "$cwd/package.json" && ! -L "$cwd/package.json" ]]; then
    cw_node=1
  elif [[ -f "$cwd/appl.toml" && ! -L "$cwd/appl.toml" ]]; then
    cw_sect=""
    cw_re='^command[[:space:]]*=[[:space:]]*"(node|npm|npx)[[:space:]]'
    while IFS= read -r cw_line || [[ -n "$cw_line" ]]; do
      case "$cw_line" in
        "["*) cw_sect="$cw_line" ;;
        *) if [[ "$cw_sect" == "[tests]" && "$cw_line" =~ $cw_re ]]; then cw_node=1; fi ;;
      esac
    done < "$cwd/appl.toml"
  fi
  cw_nodes=("Bash(node)" "Bash(node  *)" "Bash(node -)" "Bash(node - *)" "Bash(node --)" "Bash(node -- *)"
            "Bash(node .*)" "Bash(node /*)" "Bash(node ~*)" "Bash(node \$*)" "Bash(node _*)"
            "Bash(node \"*)" "Bash(node '*)"
            "Bash(node --check=*)" "Bash(node --check  *)" "Bash(node --check -*)" "Bash(node --check * -*)"
            "Bash(node --check /*)" "Bash(node --check * /*)" "Bash(node --check *..*)"
            "Bash(node --check ~*)" "Bash(node --check *~*)" "Bash(node --check *\$*)"
            "Bash(node --check *>*)" "Bash(node --check *<*)")
  for cw_flag in a b c d e f g h i j k l m n o p q r s t u v w x y z \
                 A B C D E F G H I J K L M N O P Q R S T U V W X Y Z 0 1 2 3 4 5 6 7 8 9; do
    cw_nodes+=("Bash(node ${cw_flag}*)")
    case "$cw_flag" in
      [0-9]) continue ;;
    esac
    cw_nodes+=("Bash(node -${cw_flag}*)")
    [[ "$cw_flag" == "c" ]] || cw_nodes+=("Bash(node --${cw_flag}*)")
    [[ "$cw_flag" == "h" ]] || cw_nodes+=("Bash(node --c${cw_flag}*)")
  done
  cw_deny=()
  for rule in "${deny[@]}"; do
    case "$rule" in
      "Bash(python3 -:*)") cw_deny+=("Bash(python3 -)" "Bash(python3 - *)") ;;
      "Bash(bash -*)") cw_deny+=("${cw_bash[@]}") ;;
      "Bash(node:*)")
        if [[ -n "$cw_node" ]]; then
          cw_deny+=("${cw_nodes[@]}")
        else
          cw_deny+=("$rule")
        fi ;;
      *) cw_deny+=("$rule") ;;
    esac
  done
  # grep is on the read-only list now (its `Bash(grep:*)` left the static list), and this
  # worker's grep keeps the narrowing it had: after the list's denies, each rule once
  for rule in "${cw_grep[@]}"; do
    case " ${cw_deny[*]} " in
      *" ${rule} "*) ;;
      *) cw_deny+=("$rule") ;;
    esac
  done
  deny=("${cw_deny[@]}")
  allow+=("Bash(bash -n:*)" "Bash(git cherry-pick --quit)")
  if [[ -n "$cw_node" ]]; then
    allow+=("Bash(node --check *)")
  fi
  # finish-worktree.sh by absolute path from the resolved scripts dir only: the dir the
  # brief's {{SCRIPTS}} names (the shared resolver's answer, above).
  allow+=("Bash(bash ${spawn_scripts}/finish-worktree.sh:*)")
  unset cw_bash cw_grep cw_deny cw_flag cw_entry cw_node cw_nodes cw_sect cw_re cw_line
fi
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
  HS_BRIEF_PRIMARY="${brief_primary:-$cwd}" HS_SCRIPTS="$spawn_scripts" \
  HS_CODEX_HOME="${codex_home:-}" HS_CODEX_AUTH="${user_auth:-}" HS_MODEL="$model" HS_PROFILE="$profile" \
  HS_WEEKLY="$weekly_hunt" HS_RECEIPT_WALL="$receipt_wall" \
  HS_CURSOR_HOME="${cursor_home-}" \
  HS_RO_ALLOW="$(printf '%s\n' ${ro_allow[@]+"${ro_allow[@]}"})" \
  HS_EXTRA_ALLOW="$(printf '%s\n' ${extra_allow[@]+"${extra_allow[@]}"})" \
  python3 -I - "$rules_out" "${#allow[@]}" "${allow[@]}" "${deny[@]}" <<'PY' || half_fail 2 "the rules file for ${name} could not be written; the agent was not started"
import json, os, re, shlex, stat, sys
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
# THE REVIEWER'S OWN CHECKOUT. Since the reviewer gate, a reviewer runs in its own linked
# worktree at $HERD_DIR/review/<name>, on its own receipt branch, and lands its note and
# receipt from there -- which the blanket `review/**` deny made impossible, so the operator
# wrote the note by hand. A deny beats any allow, so the carve-out cannot be an allow under
# that deny: for a reviewer whose cwd is such a checkout the herd's `review/**` is replaced
# by one deny per OTHER entry of review/ (the other reviewers' checkouts), the checkout
# itself gets one deny per top-level entry except notes/ and .security/, and .security/ one
# per entry except audit-receipts/ -- entries as they exist AT SPAWN (literal names, no
# `[!..]` classes: a class spelling this repository has not measured Claude Code honour is
# not a wall to lean on). Then exactly two allows: <co>/notes/** and
# <co>/.security/audit-receipts/**. A path the checkout gains after the spawn matches no
# rule and stops at a prompt, never a write. Either allowed directory that is a symlink (or
# a .security/ that is one) is denied instead of allowed, and every rule is written for the
# checkout as spelled AND as resolved, since a path is judged in both forms. The primary is
# never a reviewer's review checkout (a linked worktree has a .git FILE), and the worker and
# coordinator profiles take none of this.
review_co = ""
review_root = os.path.join(herd, "review")
if (os.environ.get("HS_PROFILE") == "reviewer"
        and os.path.isfile(os.path.join(cwd, ".git"))
        and os.path.realpath(cwd) != os.path.realpath(os.environ.get("HS_PRIMARY") or "/")
        and os.path.realpath(os.path.dirname(cwd)) == os.path.realpath(review_root)):
    review_co = cwd
review_allow = []
if review_co:
    own = os.path.basename(review_co)
    roots = []
    for r in (review_root, os.path.realpath(review_root)):
        if r not in roots:
            roots.append(r)
    for entry in sorted(os.listdir(review_root)):
        if entry != own:
            for r in roots:
                extra_deny.append(abs_rule(os.path.join(r, entry)))
                extra_deny.append(abs_rule(os.path.join(r, entry, "**")))
    sec = os.path.join(review_co, ".security")
    carve = {"notes": os.path.join(review_co, "notes"),
             ".security/audit-receipts": os.path.join(sec, "audit-receipts")}
    denied_rel = [e for e in os.listdir(review_co) if e not in ("notes", ".security")]
    if os.path.islink(sec) or (os.path.lexists(sec) and not os.path.isdir(sec)):
        denied_rel.append(".security")
    elif os.path.isdir(sec):
        denied_rel += [".security/" + e for e in os.listdir(sec) if e != "audit-receipts"]
    for rel, p in sorted(carve.items()):
        if os.path.islink(p) or os.path.islink(os.path.dirname(p)):
            denied_rel.append(rel)
        else:
            review_allow.append(rel)
    bases = []
    for b in (review_co, os.path.realpath(review_co)):
        if b not in bases:
            bases.append(b)
    for rel in sorted(denied_rel):
        for b in bases:
            extra_deny.append(abs_rule(os.path.join(b, rel)))
            extra_deny.append(abs_rule(os.path.join(b, rel, "**")))
    review_allow = [abs_rule(os.path.join(b, rel, "**")) for rel in review_allow for b in bases]
# THE RELEASE PROFILE: Edit/Write may reach the checkout's top-level VERSION and
# CHANGELOG.md, and every other path of the checkout is DENIED by a rule, not left unlisted
# (an unlisted edit inside the cwd is the auto-mode classifier's to wave through, and a
# release solo runs unattended). The deny is built from negated character classes walked
# letter by letter along the two names: a first character that starts neither, then at
# each depth a name that leaves the spelling there or stops short of it, and one that runs
# past it; each with its `/**` form, and the two files themselves as directories. A deny
# beats any allow, so the two allows never reach a look-alike, and a `..` or a symlink is
# judged where it lands. Written for the checkout as spelled AND as resolved; the worker,
# reviewer and coordinator profiles take none of this.
release_allow = []
if os.environ.get("HS_PROFILE") == "release":
    keep = ("VERSION", "CHANGELOG.md")
    bases = []
    for b in (cwd, os.path.realpath(cwd)):
        if b not in bases:
            bases.append(b)
    pats = ["[!" + "".join(sorted({k[0] for k in keep})) + "]*"]
    for k in keep:
        for i in range(1, len(k)):
            pats.append(k[:i])
            pats.append(k[:i] + "[!" + k[i] + "]*")
        pats.append(k + "?*")
    for b in bases:
        for pat in pats:
            extra_deny.append(abs_rule(os.path.join(b, pat)))
            extra_deny.append(abs_rule(os.path.join(b, pat, "**")))
        for k in keep:
            extra_deny.append(abs_rule(os.path.join(b, k, "*")))
            extra_deny.append(abs_rule(os.path.join(b, k, "*", "**")))
        release_allow += [abs_rule(os.path.join(b, k)) for k in keep]
# .repos/ holds the repository each worker's report is judged in: a worker that could
# rewrite its own record would choose where its claim is checked again; .resume/ holds the
# pane a --resume types into, and the key it hands the pair's lock to
for d in ("review/**", "briefs/**", ".roles/**", ".repos/**", ".resume/**", "CLAUDE.md", "CLAUDE.local.md", ".claude/**"):
    if d == "review/**" and review_co:
        continue
    extra_deny.append(abs_rule(os.path.join(herd, d)))
if home:
    extra_deny.append(abs_rule(os.path.join(home, ".claude/**")))
    # ... and Cursor's, whose user config every Cursor session inherits and where an
    # "always allow" would be persisted (ISSUE(security-audit-2026-09-12-cursor-s-project-rul-e6f4-3))
    extra_deny.append(abs_rule(os.path.join(home, ".cursor/**")))
    # ... and the APPL install root, every version under it present at spawn or not: a
    # version's read-only mode bits are no wall to a worker of the same uid. The root
    # itself and its subtree, as written and as resolved; never a look-alike (~/.applx).
    appl_roots = []
    for b in (os.path.join(home, ".appl"), os.path.realpath(os.path.join(home, ".appl"))):
        if b not in appl_roots:
            appl_roots.append(b)
    for b in appl_roots:
        extra_deny.append(abs_rule(b))
        extra_deny.append(abs_rule(os.path.join(b, "**")))


def own_report_rules():
    """Edit of this seat's own report.md and report.md.notes.

    A test author and an implementer are the worker profile; a reviewer is the
    reviewer profile. The two paths are absolute (Claude's // form) and carry
    no glob, so the allow names those files and nothing wider under the herd
    directory. A spawn whose cwd is the primary keeps the Edit allow the older
    pins name: that checkout is shared. A worktree seat gets the two files.
    """
    if os.environ.get("HS_PROFILE") not in ("worker", "reviewer"):
        return []
    primary = os.environ.get("HS_PRIMARY", "")
    if not primary or not name_of_worker:
        return []
    try:
        if os.path.realpath(cwd) == os.path.realpath(primary):
            return []
    except OSError:
        return []
    report = os.path.join(herd, name_of_worker, "report.md")
    return [abs_rule(report), abs_rule(report + ".notes")]


report_allow = own_report_rules()
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
settings = {"permissions": {"allow": rest[:n] + review_allow + release_allow + report_allow,
                            "deny": rest[n:] + extra_deny},
            "autoMemoryEnabled": False,
            "claudeMdExcludes": excludes}
if os.environ.get("HS_PROFILE") == "coordinator":
    # The coordinator harness (plan 2026-09-19, B): the pane's prompts go through
    # appl-hook.sh first, which blocks the mechanical ones and hands the rest over with
    # the verdict. In THIS file only, so no worker or reviewer ever carries it. The tab is
    # not handed HERD_DIR, so the command carries this spawn's own; the script is found
    # from whichever checkout the pane runs in ($CLAUDE_PROJECT_DIR, else the cwd), never
    # by the primary's absolute path. A REPORT runs the named tests, hence the long
    # timeout. No model is named here: HERD_SPAWN_MODEL alone picks the pane's. Each
    # command carries the pane's harness (--harness claude), so a fail-closed block goes
    # out in the shape this pane honours.
    hook = ('HERD_DIR=' + shlex.quote(herd) + ' bash "${CLAUDE_PROJECT_DIR:-.}"'
            '/.cursor/skills/isolated-session/scripts/appl-hook.sh ')
    on = " --harness claude"
    settings["hooks"] = {
        "UserPromptSubmit": [{"hooks": [{"type": "command", "command": hook + "UserPromptSubmit" + on,
                                         "timeout": 3600}]}],
        "SessionStart": [{"matcher": "startup|resume|compact|clear",
                          "hooks": [{"type": "command", "command": hook + "SessionStart" + on,
                                     "timeout": 60}]}],
        # after an Agent call, the hook records a helper's id at its launch: the only way it
        # knows whose `<agent-message>` hand-back arrives later (it names nothing but the id)
        "PostToolUse": [{"matcher": "Agent",
                         "hooks": [{"type": "command", "command": hook + "PostToolUse" + on,
                                    "timeout": 30}]}],
    }
with os.fdopen(fd, "w", encoding="utf-8") as f:
    if os.environ.get("HS_HARNESS") == "codex":
        json.dump({"note": UNENFORCED_NOTE,
                   "allow": rest[:n] + report_allow, "deny": rest[n:] + extra_deny},
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


# Cursor's Shell `*` spans spaces and the line is not split on `|`, `;` or `&&`.
# The worker allow starts as the brief's own spellings. The same profile's Claude
# allow list is then added in Cursor's spelling (cursor_rule). A trailing star
# spans a pipe or a semicolon, so the chain denies below are built from the
# combined list and beat the allow. A star that is still needed -- a test file
# name, a commit message, a path -- is paired with those denies.
CURSOR_WORKER_DENY = [
    "Shell(*;*)",
    "Shell(*|*)",
    "Shell(*&&*)",
    "Shell(*||*)",
    "Shell(*$(*)",
    "Shell(*`*)",
    "Shell(*>*)",
    "Shell(*<*)",
    "Shell(*&*)",
    # A newline ends a command the way `;` does, and every allow's `*` spans it.
    # The rule carries a literal newline; cli.json writes it as the JSON escape.
    "Shell(*\n*)",
    "Shell(env:*)",
    "Shell(/usr/bin/env:*)",
    "Shell(PYTHONNOUSERSITE=*)",
    "Shell(PYTHONPATH=*)",
    "Shell(PYTHONHOME=*)",
    "Shell(ISOLATED_SESSION_OWNER=*)",
    "Shell(git:add -*)",
    "Shell(git:commit --*)",
    # An option after the first -m: the allow's `*` spans the whole -m list, so
    # `-a`, the no-verify option, `-c`, `-F`, a template file and the rest are
    # refused wherever they stand, not only first. A message carrying ` -a` or
    # ` --` as text is refused too; that is the price of a plain glob.
    "Shell(git:commit * -a*)",
    "Shell(git:commit * -n*)",
    "Shell(git:commit * -c*)",
    "Shell(git:commit * -C*)",
    "Shell(git:commit * -F*)",
    "Shell(git:commit * -t*)",
    "Shell(git:commit * -i*)",
    "Shell(git:commit * -o*)",
    "Shell(git:commit * -p*)",
    "Shell(git:commit * --*)",
    # run-test.sh / run-node.sh allows name one file. Cursor's `*` spans
    # slashes and spaces, so `tests/*.py` still matches `tests/../x.py` and
    # `tests/x.py tests/y.py`. These beat that allow. The `*` stays after the
    # script path, the same shape as the allows.
    "Shell(bash:.cursor/skills/isolated-session/scripts/run-test.sh *..*)",
    "Shell(bash:.cursor/skills/isolated-session/scripts/run-test.sh * *)",
    "Shell(bash:.cursor/skills/isolated-session/scripts/run-node.sh *..*)",
    "Shell(bash:.cursor/skills/isolated-session/scripts/run-node.sh * *)",
]


# Published: a remembered owner-allow line never widens these families.
# A head is the whole command word, so rmdir is not rm and killall is not kill.
# A git subcommand is the whole word after git:, so reset-hard is not reset.
# The role render's own cd allow is not an owner line and is not on this list.
CURSOR_OWNER_BANNED_HEADS = (
    "herdr", "kill", "rm", "mv", "launchctl", "command", "cd", "env",
)
CURSOR_OWNER_BANNED_GIT = (
    "reset", "rebase", "switch", "cherry-pick", "update-ref",
    "write-tree", "commit-tree", "hash-object", "push",
)


def cursor_owner_banned(rule):
    """True when a Shell rule is on the published banned list."""
    body = rule[len("Shell("):-1]
    base, _, args = body.partition(":")
    if base in CURSOR_OWNER_BANNED_HEADS:
        return True
    if base == "git" and args.endswith(" *"):
        return args[:-2] in CURSOR_OWNER_BANNED_GIT
    return False


def cursor_allow_without_banned(rules):
    """The rendered allow list never grants a published banned head. The role
    render's own Shell(cd:*) stays. A read-only herdr agent list is that head,
    so it is absent too."""
    kept = []
    for rule in rules:
        if rule == "Shell(cd:*)":
            kept.append(rule)
            continue
        if rule.startswith("Shell(") and rule.endswith(")") and cursor_owner_banned(rule):
            continue
        kept.append(rule)
    return kept


def cursor_owner_allow_rules(home):
    """Shell rules the owner approved once. Arguments are a star. A python3
    or curl rule in the file is ignored. A line on the published banned list
    is dropped and logged once, however often the file repeats it."""
    path = os.environ.get("APPL_CURSOR_OWNER_ALLOW") or (
        os.path.join(home, ".config", "appl", "cursor-owner-allow") if home else "")
    if not path or os.path.islink(path):
        return []
    try:
        st = os.lstat(path)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_size > (1 << 20):
            return []
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return []
    try:
        text = os.read(fd, 1 << 20).decode("utf-8", "replace")
    except OSError:
        return []
    finally:
        os.close(fd)
    ok_rule = re.compile(
        r"^Shell\([A-Za-z0-9][A-Za-z0-9._+-]*:(?:\*|[A-Za-z0-9][A-Za-z0-9_-]* \*)\)$")
    ignored = {
        "curl", "wget", "ssh", "scp", "nc", "ncat", "sudo", "doas",
        "python", "python2", "python3", "node", "perl", "ruby", "php",
        "bash", "sh", "zsh", "dash",
    }
    out = []
    logged = set()
    for line in text.splitlines():
        rule = line.strip()
        if not ok_rule.fullmatch(rule):
            continue
        if cursor_owner_banned(rule):
            if rule not in logged:
                logged.add(rule)
                print("herd-spawn: dropped owner-allow rule " + rule, file=sys.stderr)
            continue
        if rule in out:
            continue
        body = rule[len("Shell("):-1]
        base = body.split(":", 1)[0]
        if base in ignored or body.startswith("git:config"):
            continue
        out.append(rule)
    return out


def cursor_worker_allow(primary, brief_primary, herd, name, profile="worker"):
    """The cursor seat's allow list: the commands the briefs name, and a Write
    of this pane's report.md and report.md.notes. Read of the pane directory stays, so the
    prompt's `Read brief.md` is not a prompt of its own. A reviewer keeps the
    one-file test spelling and loses the suite runner, the same cut the claude
    reviewer has, and gains write-receipt.sh, the one receipt path that profile
    has. A weekly hunt also gains its full-receipt script."""
    scripts = ".cursor/skills/isolated-session/scripts"
    allow = ["Shell(python3:-I tests/*.py)"]
    if profile != "reviewer":
        allow.append("Shell(python3:-I tools/run_tests.py --affected main..HEAD -j4)")
    allow += [
        "Shell(python3:-I tools/ledger.py new *)",
        "Shell(bash:" + scripts + "/stale.sh)",
        "Shell(bash:" + scripts + "/ensure-worktree.sh *)",
        "Shell(bash:" + scripts + "/assert-head.sh *)",
        "Shell(bash:" + scripts + "/vendor.sh check)",
    ]
    if profile != "reviewer":
        # One tests/<file>.py via the wrapper, and one conformance/ or tests/ .mjs
        # file. The reviewer runs `python3 -I tests/<file>.py` and does not get
        # these wrappers. `tests/*.py` is the narrowest pattern the Shell matcher
        # has for that shape (`*` spans slashes and spaces; the denies above
        # refuse a `..` step and a second argument).
        allow += [
            "Shell(bash:" + scripts + "/run-test.sh tests/*.py)",
            "Shell(bash:" + scripts + "/run-node.sh conformance/*.mjs)",
            "Shell(bash:" + scripts + "/run-node.sh tests/*.mjs)",
        ]
    else:
        # The receipt step the reviewer brief names. The wrapper refuses --full
        # and a missing range; a direct audit_scope.py rule is not granted.
        allow.append("Shell(bash:" + scripts + "/write-receipt.sh *)")
        if os.environ.get("HS_RECEIPT_WALL"):
            allow.append("Shell(bash:" + os.environ["HS_RECEIPT_WALL"] + "/write-receipt.sh *)")
        if os.environ.get("HS_WEEKLY") == "yes":
            allow.append(
                "Shell(bash:" + scripts + "/write-weekly-receipt.sh "
                "tools/audit_scope.py write-receipt --full --slug weekly-*)")
    allow += [
        "Shell(git:add)",
        "Shell(git:add *)",
        # Quoted -m values, any number of them. `;`, `<` and `>` stay refused
        # even inside the quotes: a plain glob cannot tell a quoted `;` from
        # `-m "a -m "b; touch "m"`, whose `;` the shell reads as a chain.
        'Shell(git:commit -m "*")',
        "Shell(git:commit -m '*')",
        # A message file directly in this pane's own herd directory; the denies
        # in cursor_worker_commit_deny keep it to one name and no other option.
        "Shell(git:commit -F " + os.path.join(herd, name) + "/*)",
        "Shell(cd:*)",
        "Read(" + os.path.join(herd, name) + "/**)",
        "Write(" + os.path.join(herd, name, "report.md") + ")",
        "Write(" + os.path.join(herd, name, "report.md.notes") + ")",
    ]
    # finish-worktree.sh by absolute path from the resolved scripts dir only: the dir the
    # brief's {{SCRIPTS}} names (the shared resolver's answer, HS_SCRIPTS).
    resolved = os.environ.get("HS_SCRIPTS", "")
    dirs = [resolved] if resolved else [r + "/" + scripts for r in dict.fromkeys((brief_primary, primary)) if r]
    for d in dirs:
        allow.append("Shell(bash:" + d + "/finish-worktree.sh *)")
    return allow


def cursor_worker_commit_deny(herd, name):
    """The denies the -F allow needs: a file directly under the pane's own
    directory, no `..`, no subdirectory, and nothing after the path."""
    own = os.path.join(herd, name)
    return [
        "Shell(git:commit -F " + own + "/*..*)",
        "Shell(git:commit -F " + own + "/*/*)",
        "Shell(git:commit -F " + own + "/* *)",
    ]


def cursor_reviewer_commit_denies(deny):
    """Step 7 of the reviewer brief, with the slug and the count filled in.

    The summary is `security: review of landing <slug> -- N finding(s)`. The
    broad `Shell(git:commit * --*)` deny matches that double dash, and a deny
    beats the quoted -m allow, so the commit never runs. A long option is `--`
    and then a letter or a digit (`--amend`, `--no-verify`). The summary is
    `--` and then a space. Drop the broad deny and name those options, so the
    step 7 spelling is allowed and a long option is still refused. The worker
    render is not passed through here and keeps the broad deny."""
    broad = "Shell(git:commit * --*)"
    out = [rule for rule in deny if rule != broad]
    for ch in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789":
        rule = "Shell(git:commit * --" + ch + "*)"
        if rule not in out:
            out.append(rule)
    return out


def cursor_reviewer_note_allow(checkout):
    """Write of notes/security-review-<slug>.md in this reviewer's own checkout.

    One path component for the slug, so a path that still contains a `..`
    segment does not match, and the rule is not a Write of the whole checkout.
    Spelled and resolved, the same two forms the Claude notes allow uses. A
    notes directory that is a symlink is not granted."""
    if not checkout:
        return []
    notes_dir = os.path.join(checkout, "notes")
    if os.path.islink(notes_dir):
        return []
    bases = []
    for base in (checkout, os.path.realpath(checkout)):
        if base not in bases:
            bases.append(base)
    out = []
    for base in bases:
        rule = "Write(" + os.path.join(base, "notes", "security-review-*.md") + ")"
        if rule not in out:
            out.append(rule)
    return out


def cursor_worker_chain_deny(allow):
    """The chain, redirect, substitution and newline denies again, in the
    `base:args` form, once for each command base the allow list grants and once
    for any base. Cursor's permissions reference says a rule with no colon is
    matched against the FIRST TOKEN only, so `Shell(*;*)` alone may never see the
    `;` in `cd x; touch m`; `Shell(cd:*;*)` does. The no-colon rules stay as
    well: a deny is never removed. Live cursor behaviour is not measured here."""
    syntax = [r[len("Shell(*"):-len("*)")] for r in CURSOR_WORKER_DENY
              if r.startswith("Shell(*") and r.endswith("*)") and ":" not in r]
    bases = ["*"]
    for r in allow:
        if r.startswith("Shell(") and r.endswith(")"):
            base = r[len("Shell("):-1].partition(":")[0]
            if base not in bases:
                bases.append(base)
    return ["Shell(" + b + ":*" + s + "*)" for b in bases for s in syntax]


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


def _cursor_star(pat, text):
    """A Shell `*` matches any text, spaces and slashes included."""
    return re.fullmatch(".*".join(re.escape(p) for p in pat.split("*")), text,
                        flags=re.DOTALL) is not None


def cursor_shell_matches(rule, cmd):
    """Whether one rendered Shell rule would run `cmd`. The same reading the
    cursor pins use: a star spans spaces, and a colon splits the command base
    from its arguments. A rule is judged by the command it matches."""
    if not (rule.startswith("Shell(") and rule.endswith(")")):
        return False
    body = rule[len("Shell("):-1]
    if ":" not in body:
        return _cursor_star(body, cmd)
    base, _, args = body.partition(":")
    if args == "*":
        return cmd == base or cmd.startswith(base + " ")
    if args == "":
        return cmd == base
    return _cursor_star(base + " " + args, cmd) or cmd == base + " " + args


# Receipt writes a worker or a release pane must not run. Each rendered allow
# is matched against these commands. A rule that matches one is dropped, which
# is how a wider copy such as Shell(python3:tools/*) loses the receipt even
# though its text names none of the three tools. The reviewer and the weekly
# hunt are not filtered: they keep the skill script, and the weekly hunt keeps
# the full-receipt script.
CURSOR_RECEIPT_COMMANDS = (
    "python3 -I tools/audit_scope.py write-receipt",
    "python3 -I tools/audit_scope.py write-receipt --full",
    "python3 -I tools/audit_scope.py write-receipt --range a..b s clean 0 notes.txt",
    "python3 tools/audit_scope.py write-receipt",
    "python3 tools/audit_scope.py write-receipt --full",
    "python3 tools/audit_scope.py write-receipt --range a..b s clean 0 notes.txt",
    "python3 -I tools/sec_lint.py --diff a..b",
    "python3 -I tools/sec_lint.py --diff a..b --json",
    "python3 tools/sec_lint.py --diff a..b",
    "python3 tools/sec_lint.py --diff a..b --json",
    "bash tools/write-receipt.sh a..b s clean 0 notes.txt",
    "python3 tools/write-receipt.sh a..b s clean 0 notes.txt",
    "bash .cursor/skills/isolated-session/scripts/write-receipt.sh a..b s clean 0 notes.txt",
)


def cursor_drop_receipt_allows(rules):
    """Allow rules that match a receipt-writing command, removed. The decision
    is the match, never a search of the rule text."""
    return [rule for rule in rules
            if not any(cursor_shell_matches(rule, cmd) for cmd in CURSOR_RECEIPT_COMMANDS)]


# Claude's `Bash(git commit:*)` is every commit. Cursor's `*` spans the line, so the
# same translation is `Shell(git:commit *)`, which also matches `--no-verify`, `--amend`
# and `-a`. Those stay off this list: the narrow `-m` and pane-directory `-F` allows
# already cover the commits the briefs name, and the hook-bypass spellings stay refused.
# Claude's `stale.sh:*` likewise becomes `Shell(bash:.../stale.sh *)`. The lander allow
# is the path with no star (tests/test_cursor_allow_extra_rules.py); the star form is
# the widening that pin refuses. The path with no star is already on the worker list.
CURSOR_COMMIT_STAR = {"Shell(git:commit)", "Shell(git:commit *)"}
CURSOR_STALE_STAR = {
    "Shell(bash:.cursor/skills/isolated-session/scripts/stale.sh *)",
}
# The Claude copy (cfd8442) is what a cursor worker was missing. These spellings
# stay off that copy. The worker pin refuses them: audit_scope and sec_lint are
# not on the cursor worker allow, write-receipt.sh is the reviewer's path, and
# git ls-files, git grep and git blame are not granted. The bare tests/test_*
# prefix is the open form that pin refuses. The isolated tests/test_* prefix
# stays: cfd8442 put that one on the cursor allow.
CURSOR_WORKER_COPY_SKIP = {
    "Shell(git:ls-files)", "Shell(git:ls-files *)",
    "Shell(git:grep)", "Shell(git:grep *)",
    "Shell(git:blame)", "Shell(git:blame *)",
    "Shell(python3:tests/test_*)",
}


def cursor_claude_allows(rules, profile="worker"):
    skip = CURSOR_COMMIT_STAR | CURSOR_STALE_STAR
    out = []
    for rule in cursor_rules(rules):
        if rule in skip:
            continue
        if profile == "worker" and (
                rule in CURSOR_WORKER_COPY_SKIP
                or "audit_scope.py" in rule or "sec_lint.py" in rule
                or "write-receipt.sh" in rule):
            continue
        out.append(rule)
    return out


# The read-only list's allows, in Claude Code's spelling (`Bash(<words>:*)`), as the spawn
# rendered them from readonly-commands.tsv; none for the release profile.
RO_ALLOW = [r for r in os.environ.get("HS_RO_ALLOW", "").split("\n") if r]
# The brief's own --allow rules (judged above: each a `Bash(<body>)`), as given.
EXTRA_ALLOW = [r for r in os.environ.get("HS_EXTRA_ALLOW", "").split("\n") if r]


def readonly_cursor_deny(rules):
    """The chain, redirect, substitution and newline denies once per read-only command,
    scoped to that command's own words (`Shell(git:status*;*)`, `Shell(ls:*&&*)`): Cursor
    matches the whole line, so the list's prefix allow would otherwise run `ls && rm x`.
    Scoped, so a coordinator's `herdr agent prompt` text that carries a `;` is untouched."""
    syntax = [r[len("Shell(*"):-len("*)")] for r in CURSOR_WORKER_DENY
              if r.startswith("Shell(*") and r.endswith("*)") and ":" not in r]
    out = []
    for r in rules:
        base, _, args = r[len("Bash("):-len(":*)")].partition(" ")
        for s in syntax:
            out.append("Shell(%s:%s*%s*)" % (base, args, s) if args else "Shell(%s:*%s*)" % (base, s))
    return out


if os.environ.get("HS_HARNESS") == "cursor" and os.environ.get("HS_PROFILE") == "coordinator":
    # The pane's own config home (CURSOR_CONFIG_DIR), not <cwd>/.cursor/cli.json.
    # cli-config.json is the file Cursor reads approvalMode from; the project file's
    # schema refuses that key. hooks.json is the user-level hook file Cursor reads
    # from that config directory. The two events appl-hook.sh is registered for are
    # the same two the claude --settings file registers.
    cfg_dir = os.environ.get("HS_CURSOR_HOME", "")

    def _under(child, parent):
        if not parent:
            return False
        return child == parent or child.startswith(parent + os.sep)

    real = os.path.realpath(cfg_dir) if cfg_dir else ""
    pane = os.path.realpath(os.path.join(herd, name_of_worker))
    shared = os.path.realpath(os.path.join(cwd, ".cursor"))
    home_cursor = os.path.realpath(os.path.join(home, ".cursor")) if home else ""
    if (not cfg_dir or os.path.islink(cfg_dir) or not os.path.isdir(cfg_dir)
            or not _under(real, pane) or real == pane
            or _under(real, shared) or _under(real, home_cursor)):
        print("herd-spawn: the cursor harness cannot register appl-hook.sh on this pane alone: "
              "CURSOR_CONFIG_DIR is not a private directory, so the pane would read the shared "
              "<cwd>/.cursor/cli.json; the worker was not started", file=sys.stderr)
        sys.exit(2)
    coord_allow = cursor_rules(rest[:n])
    # Claude's coordinator list has no Write rule. Cursor still needs one line for
    # this pane's report.md and report.md.notes, in the same Write(/absolute) form
    # cursor_rule emits for intake/** and briefs/**. Worker and reviewer renders
    # do not take these: cursor_worker_allow already names that pane's own two files.
    coord_allow.append("Write(" + os.path.join(herd, name_of_worker, "report.md") + ")")
    coord_allow.append("Write(" + os.path.join(herd, name_of_worker, "report.md.notes") + ")")
    coord_deny = cursor_rules(rest[n:] + extra_deny) + readonly_cursor_deny(RO_ALLOW)
    primary = os.environ.get("HS_PRIMARY", "")
    if primary:
        coord_deny.append("Read(" + os.path.join(primary, "keys") + "/**)")
    hook = ('HERD_DIR=' + shlex.quote(herd) + ' bash "${CLAUDE_PROJECT_DIR:-.}"'
            '/.cursor/skills/isolated-session/scripts/appl-hook.sh ')

    def write_cfg(filename, payload):
        dest = os.path.join(cfg_dir, filename)
        if os.path.islink(dest) or (os.path.lexists(dest) and not os.path.isfile(dest)):
            print("herd-spawn: the cursor harness cannot register appl-hook.sh on this pane alone: "
                  + dest + " is not a regular file, so the pane would read the shared "
                  "<cwd>/.cursor/cli.json; the worker was not started", file=sys.stderr)
            sys.exit(2)
        if os.path.lexists(dest):
            os.unlink(dest)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(dest, flags, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=1)
            f.write("\n")

    write_cfg("cli-config.json", {
        "approvalMode": "allowlist",
        "permissions": {"allow": coord_allow, "deny": coord_deny},
    })
    write_cfg("hooks.json", {
        "version": 1,
        "hooks": {
            # each command carries the pane's harness, as the claude registration does
            "beforeSubmitPrompt": [{"command": hook + "UserPromptSubmit --harness cursor"}],
            "sessionStart": [{"command": hook + "SessionStart --harness cursor"}],
            "postToolUse": [{"command": hook + "PostToolUse --harness cursor", "matcher": "Agent"}],
        },
    })

if os.environ.get("HS_HARNESS") == "cursor" and os.environ.get("HS_PROFILE") != "coordinator":
    # The worker's allow is the brief's spellings (cursor_worker_allow) plus this
    # profile's Claude allow list in Cursor's spelling. A trailing star spans a
    # pipe or a semicolon, so the chain denies below are built after this union
    # and beat the allow. The deny list is still the Claude translation, plus the
    # chain and guard-prefix denies a star cannot express. The file is the
    # workspace's .cursor/cli.json (exclusive; gitignored here). The primary is
    # never granted for reading -- its keys/ holds the resident agents' seeds
    # (ISSUE(security-audit-2026-09-12-cursor-s-project-rul-e6f4)).
    primary = os.environ.get("HS_PRIMARY", "")
    brief_primary = os.environ.get("HS_BRIEF_PRIMARY", "") or primary
    profile_now = os.environ.get("HS_PROFILE", "worker")
    if profile_now == "release":
        # The release solo's own list (the tag, read-only git, VERSION and
        # CHANGELOG.md). The worker brief spellings are a wider wall.
        cursor_allow = cursor_rules(rest[:n] + release_allow)
    else:
        cursor_allow = cursor_worker_allow(primary, brief_primary, herd, name_of_worker,
                                           profile_now)
    # the read-only list, then every allow this same profile grants on Claude.
    # --allow rules sit in that Claude list too, and they are written after the
    # chain denies (below): a base only an --allow rule names must not gain its
    # own Shell(base:*;*) denies (tests/test_cursor_allow_extra_rules.py).
    extra_spellings = set(cursor_rules(EXTRA_ALLOW))
    cursor_allow += [r for r in cursor_rules(RO_ALLOW) if r not in cursor_allow]
    cursor_allow += [r for r in cursor_claude_allows(
                         rest[:n], os.environ.get("HS_PROFILE", "worker"))
                     if r not in cursor_allow and r not in extra_spellings]
    # Commands the owner has already approved once, as Shell rules with a star
    # on the arguments (Shell(rg:*)). A published banned line is already absent
    # and was logged once. An owner line never lifts a deny: sed, env and
    # git push stay refused. Chain, pipe, redirect and substitution denies stay.
    owner_rules = cursor_owner_allow_rules(home)
    cursor_allow += [r for r in owner_rules if r not in cursor_allow]
    cursor_deny =(cursor_rules(rest[n:] + extra_deny) + CURSOR_WORKER_DENY
                   + cursor_worker_commit_deny(herd, name_of_worker)
                   + cursor_worker_chain_deny(cursor_allow))
    # Each --allow rule (and so the lander's `git merge main`, `git merge --abort` and
    # stale.sh) in the Shell(<base>:<args>) spelling a live pane was measured to honour
    # (notes/2026-10-03-walled-run-denials-cursor.md): `Bash(git merge main)` is
    # `Shell(git:merge main)`, its own arguments and no wider, written once. Only in
    # permissions.json, a cursor worker stopped at "Not in allowlist" (intake
    # 20261012T120451Z). After the deny list, which stays as it was; its any-base chain
    # denies (`Shell(*:*;*)`) still cover a base only these rules name.
    cursor_allow += [r for r in dict.fromkeys(cursor_rules(EXTRA_ALLOW)) if r not in cursor_allow]
    # After every copy is on the list. A reviewer keeps the skill receipt, and a
    # weekly hunt (already profile reviewer, with the full-receipt rule added)
    # keeps that and the full-receipt script. Every other profile drops an allow
    # that matches a receipt write. The match is the command against the rule.
    if os.environ.get("HS_PROFILE") != "reviewer":
        cursor_allow = cursor_drop_receipt_allows(cursor_allow)
    if primary:
        cursor_deny.append("Read(" + os.path.join(primary, "keys") + "/**)")
    cursor_allow = cursor_allow_without_banned(cursor_allow)
    # Reviewer cursor render only. The worker render (test author and
    # implementer) keeps the broad commit deny and its two report Writes.
    if os.environ.get("HS_PROFILE") == "reviewer":
        cursor_deny = cursor_reviewer_commit_denies(cursor_deny)
        for rule in cursor_reviewer_note_allow(review_co):
            if rule not in cursor_allow:
                cursor_allow.append(rule)
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
# grok takes each rule as its own flag (measured: grok 1.0.41 --help, --allow and --deny).
# The value is grok_rules.py's spelling of the Claude rule, never the raw rule: a trailing
# :* is a word boundary there and a leading // is an absolute path, and neither of those
# is what grok's matcher does with the Claude text. The typed-line bound above is the
# claude/cursor/codex form, which keeps the rules in a file so the line stays under what
# a pty will type. These flags ARE the wall, and a pty drops typed input past about 1 KB
# (ISSUE(grok-allow-argv-exceeds-pty-bound)), so they never go on the typed line: the
# argv goes into the launcher $HERD_DIR/<name>/grok-launch.sh (mode 700), and herdr types
# the bare word `grok` (kind grok, no agent args). The chain, ruling 20261012T085833Z:
# $wall_dir/bin/grok, first on the tab's PATH, is the shim `exec /bin/bash <launcher>`; the
# launcher is `exec $wall_dir/walled/grok --cwd <worktree> --permission-mode auto` plus every
# --allow / --deny grok_rules.py yields, in order; walled/grok is the run.py wall entry,
# whose resolve skips bin/ and so finds the real grok, never the shim again.
if [[ "$harness" == "grok" ]]; then
  grok_argv_file="$(mktemp "${TMPDIR:-/tmp}/herd-spawn-grok-argv.XXXXXX")"
  if ! python3 -I "$here/grok_rules.py" "$rules_out" >"$grok_argv_file"; then
    rm -f "$grok_argv_file"
    exit 1
  fi
  if ! HS_ARGV="$grok_argv_file" HS_ENTRY="$wall_dir/walled/grok" HS_SHIM="$wall_dir/bin/grok" \
       HS_LAUNCHER="$herd_dir/${name}/grok-launch.sh" HS_NAME="$name" \
       python3 -I - "${agent_args[@]}" <<'PY'
import os, shlex, sys


def write(p, text):
    if os.path.lexists(p):
        os.unlink(p)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o700)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(p, 0o700)


with open(os.environ["HS_ARGV"], "rb") as f:
    rules = [w.decode("utf-8") for w in f.read().split(b"\0")[:-1]]
argv = [os.environ["HS_ENTRY"]] + sys.argv[1:] + rules
name, launcher = os.environ["HS_NAME"], os.environ["HS_LAUNCHER"]
write(launcher, "#!/bin/bash\n"
      "# herd-spawn.sh wrote this launcher for the grok worker " + name + ": the argv is too long\n"
      "# for a pty to type, so the PATH shim runs this file, which execs the wall entry.\n"
      "exec " + " ".join(shlex.quote(a) for a in argv) + "\n")
write(os.environ["HS_SHIM"], "#!/bin/bash\n"
      "# herd-spawn.sh wrote this shim for the grok worker " + name + ": it runs the launcher.\n"
      "exec /bin/bash " + shlex.quote(launcher) + "\n")
PY
  then
    rm -f "$grok_argv_file"
    echo "herd-spawn: the grok launcher could not be written; the worker ${name} was not started" >&2
    exit 1
  fi
  rm -f "$grok_argv_file"
  agent_args=()
fi
# The render's end: every file is written. The one line is the harness command line the
# start below hands `herdr agent start` (the harness binary, then its argv), and brief.md
# stays: it is the render's output, not a half-spawn's leftover.
if [[ "$render" == "yes" ]]; then
  brief_ours=no
  render_line="$agent_cmd"
  if [[ ${#agent_args[@]} -gt 0 ]]; then
    render_line="${render_line} ${agent_args[*]}"
  fi
  printf '%s\n' "$render_line"
  exit 0
fi
# A new tab's shell needs a moment to print its prompt, and `herdr agent start` refuses
# a pane that is not at one: called 143 ms after `tab create` it failed (2026-09-12).
# So try again, two seconds apart, for HERD_SPAWN_READY_SECS (default 30). Only a FAST
# failure is retried: an attempt that ran into herdr's own readiness timeout has
# already typed the command, and the deadline has long passed by then.
# HERD_SPAWN_AGENT_READY_SECS (below) is a different wait: after start succeeds.
# A failed start is not always a slow shell: after a failure that is not the slow shell,
# the pane is read once (first_run_prompt, at the top) and a first-run prompt stops the
# spawn without a second start. The tab stays open: the owner answers the prompt in it,
# then runs the one `--resume` command the stop prints.
# The key a pair hand-over passes the lock by (deliver_brief), decided here so a stop at a
# first-run prompt can record it for the resume, which hands over in its place.
pair_key=""
if [[ "$owner_key_from_caller" == "yes" ]] ||
   [[ "$wall_state" == "walled" || "$wall_state" == "inherited" ]]; then
  pair_key="$owner_key"
fi
# (dispatch_listed, the trust seam's list check, is defined above, where --repo is judged;
# dialog_kind, the adapter's recognizer, in the shared tail at the top, because the stall
# nudge in deliver_brief asks it too, on the --resume path as well.)
# trust_adapter is THE seam's one path (adapter_path), chosen by the harness: recognizing and
# answering go through the same file.
trust_adapter="$(adapter_path)"
# Walk the machine file's list only when this spawn took its harness from that list.
# HERD_SPAWN_HARNESS beats the list and does not fail over.
if [[ "$failover_continue" == "yes" ]]; then
  order_walk=yes
  order_index=$failover_from
elif [[ "$harness_from_caller" == "no" && ${#order_entries_h[@]} -gt 0 ]]; then
  if [[ "$harness" == "${order_entries_h[0]}" ]]; then
    order_walk=yes
  fi
fi
# cap_allows CAP: a positive whole number. Missing (-), a word (?), zero and a
# negative allow no failover.
cap_allows() {
  case "${1:-}" in
    ""|*[!0-9]*) return 1 ;;
  esac
  [[ "$1" -gt 0 ]]
}
# cursor_dead_phrase: the cursor screen, trailing whitespace removed, ends on a line
# that means the agent did not start even though agent start exited 0. Prints that
# phrase. Any other screen, including the same words earlier in the pane, is not one.
# The out-of-usage line counts only as the whole last non-empty line, stripped.
cursor_dead_phrase() {
  local screen
  screen="$("$herdr" agent read "$name" --source recent-unwrapped --lines 80 2>/dev/null \
            || "$herdr" agent read "$name" 2>/dev/null || true)"
  [[ -n "$screen" ]] || return 1
  printf '%s' "$screen" | python3 -I -c '
import sys
text = sys.stdin.read().rstrip()
if text.splitlines() and text.splitlines()[-1].strip() == sys.argv[1]:
    sys.stdout.write(sys.argv[1])
    raise SystemExit(0)
for phrase in (
    "Error: Agent stopped retrying",
    "The connection was interrupted repeatedly without saving progress",
):
    if text.endswith(phrase):
        sys.stdout.write(phrase)
        raise SystemExit(0)
raise SystemExit(1)
' "$out_of_usage_line"
}
# The argv herdr types for the harness now in $harness. Used when a failover stays
# on the same harness: only the model changes. A different harness does not use
# this; it closes the tab and re-execs the whole per-harness path.
apply_failover_args() {
  case "$harness" in
    cursor)
      agent_args=(--trust --workspace "$cwd" --add-dir "$herd_dir/${name}")
      [[ -z "$model" ]] || agent_args+=(--model "$model")
      typed="cursor-agent ${agent_args[*]}"
      ;;
    codex)
      agent_args=(-C "$cwd" --add-dir "$herd_dir/${name}")
      [[ -z "$model" ]] || agent_args+=(-m "$model")
      agent_args+=(-s workspace-write -a on-request)
      typed="codex ${agent_args[*]}"
      ;;
    grok)
      agent_args=(--cwd "$cwd" --permission-mode auto)
      [[ -z "$model" ]] || agent_args+=(--model "$model")
      typed="grok ${agent_args[*]}"
      ;;
    *)
      agent_args=(--permission-mode "$permission_mode" --model "$model" --add-dir "$herd_dir/${name}"
                  --settings "$perms" --setting-sources project --strict-mcp-config)
      if [[ "$profile" == "reviewer" ]]; then
        agent_args+=(--tools Agent,Bash,Edit,Glob,Grep,Read,Write)
      fi
      typed="claude ${agent_args[*]}"
      ;;
  esac
  prompt_line="$(first_line_for "$harness" "$bfile" "$report")"
}
# failover_reserve CAP DAY: count one failover in $HERD_DIR/.failover/DAY, a regular
# file whose contents are the decimal count and one newline. A symlink at the count
# file or its directory is exit 2 and is not followed. Returns 1 when the cap is
# already used or the file is not that decimal, and leaves the file as it was.
failover_reserve() {
  local cap="$1" day="$2" dir file rc
  dir="$herd_dir/.failover"
  file="$dir/$day"
  if [[ -L "$dir" || -L "$file" ]]; then
    rm -f "$start_err"
    printf 'herd-spawn: %s is a symlink; the failover count is never followed or written through one; the worker %s was not started\n' "$file" "$name" >&2
    exit 2
  fi
  if [[ -e "$file" && ! -f "$file" ]]; then
    rm -f "$start_err"
    printf 'herd-spawn: %s is not a regular file; the failover count is never followed; the worker %s was not started\n' "$file" "$name" >&2
    exit 2
  fi
  if [[ ! -d "$dir" ]]; then
    mkdir -m 700 "$dir" || {
      rm -f "$start_err"
      printf 'herd-spawn: %s could not be created; the worker %s was not started\n' "$dir" "$name" >&2
      exit 2
    }
  fi
  if [[ -L "$dir" || ! -d "$dir" || -L "$file" ]]; then
    rm -f "$start_err"
    printf 'herd-spawn: %s is a symlink; the failover count is never followed or written through one; the worker %s was not started\n' "$file" "$name" >&2
    exit 2
  fi
  rc=0
  python3 -I - "$file" "$cap" <<'PY' || rc=$?
import os, sys
path, cap = sys.argv[1], int(sys.argv[2])
used = 0
if os.path.lexists(path):
    if os.path.islink(path):
        sys.exit(2)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        sys.exit(2)
    with os.fdopen(fd, "r", encoding="utf-8") as fh:
        text = fh.read()
    if not (len(text) >= 2 and text.endswith("\n") and text[:-1].isdigit()):
        sys.exit(3)
    used = int(text[:-1])
    if used >= cap:
        sys.exit(4)
flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
try:
    fd = os.open(path, flags, 0o600)
except OSError:
    sys.exit(2)
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.write("%d\n" % (used + 1))
PY
  if [[ "$rc" -eq 0 ]]; then
    return 0
  fi
  if [[ "$rc" -eq 3 || "$rc" -eq 4 ]]; then
    return 1
  fi
  rm -f "$start_err"
  printf 'herd-spawn: %s is a symlink; the failover count is never followed or written through one; the worker %s was not started\n' "$file" "$name" >&2
  exit 2
}
# report_no_take REASON: nothing was taken. One exact line, then the usual half-fail.
report_no_take() {
  printf 'herd-spawn: %s did not start (%s)\n' "$harness" "$1" >&2
  ledger_line spawn-failure "$name" "from=$harness" "to=none" "why=$1"
  rm -f "$start_err"
  half_fail 1 "'herdr agent start' failed for ${name} (pane ${pane}, tab ${tab_id}): ${1}; the agent did not start"
}
# Device, inode and sha256 of this process's own script. Pass 1 records them
# before the start loop; the cross-harness re-exec compares the file at $0.
spawner_dev=""
spawner_ino=""
spawner_dig=""
spawner_file_ident() {
  python3 -I - "$1" <<'PY'
import hashlib, os, sys
path = sys.argv[1]
try:
    st = os.stat(path)
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        h.update(fh.read())
except OSError:
    sys.exit(1)
sys.stdout.write("%d %d %s" % (st.st_dev, st.st_ino, h.hexdigest()))
PY
}
# 0 when $1 is a directory of mode 700 owned by this user.
spawner_dir_mode_owned() {
  python3 -I - "$1" <<'PY'
import os, stat, sys
try:
    st = os.lstat(sys.argv[1])
except OSError:
    sys.exit(1)
if not stat.S_ISDIR(st.st_mode):
    sys.exit(1)
if stat.S_IMODE(st.st_mode) != 0o700:
    sys.exit(1)
if st.st_uid != os.geteuid():
    sys.exit(1)
PY
}
# 0 when $here may re-exec: a mode-700 directory this user owns that is a direct
# child of $HERD_DIR, or the scripts directory of a primary checkout listed in
# the dispatch repos file. Anything else is not a spawner directory.
spawner_directory_ok() {
  local here_phys herd_phys parent primary
  if [[ -d "$here" && ! -L "$here" ]] && spawner_dir_mode_owned "$here"; then
    here_phys="$(cd "$here" && pwd -P)" || here_phys=""
    herd_phys="$(cd "$herd_dir" 2>/dev/null && pwd -P)" || herd_phys=""
    if [[ -n "$here_phys" && -n "$herd_phys" ]]; then
      parent="$(dirname "$here_phys")"
      if [[ "$parent" == "$herd_phys" ]]; then
        return 0
      fi
    fi
  fi
  case "$here" in
    */.cursor/skills/isolated-session/scripts) ;;
    *) return 1 ;;
  esac
  primary="${here%/.cursor/skills/isolated-session/scripts}"
  [[ -n "$primary" && -d "$primary" && ! -L "$primary" ]] || return 1
  [[ -d "$primary/.git" && ! -L "$primary/.git" ]] || return 1
  dispatch_listed "$primary"
}
record_spawner_ident() {
  local ident rest
  spawner_dev=""
  spawner_ino=""
  spawner_dig=""
  ident="$(spawner_file_ident "$0" || true)"
  case "$ident" in
    *" "*" "*)
      spawner_dev="${ident%% *}"
      rest="${ident#* }"
      spawner_ino="${rest%% *}"
      spawner_dig="${rest#* }"
      ;;
  esac
}
# Prints the refusal reason when the cross-harness re-exec must not run.
# Directory first, then device, inode, digest. Returns 1 when the copy is the
# one pass 1 recorded and $here is a spawner directory.
spawner_identity_reason() {
  local now dev ino dig rest
  if ! spawner_directory_ok; then
    printf '%s\n' "not a spawner directory"
    return 0
  fi
  now="$(spawner_file_ident "$0" || true)"
  dev=""
  ino=""
  dig=""
  case "$now" in
    *" "*" "*)
      dev="${now%% *}"
      rest="${now#* }"
      ino="${rest%% *}"
      dig="${rest#* }"
      ;;
  esac
  if [[ -z "$spawner_dev" || -z "$dev" || "$dev" != "$spawner_dev" ]]; then
    printf '%s\n' "device mismatch"
    return 0
  fi
  if [[ "$ino" != "$spawner_ino" ]]; then
    printf '%s\n' "inode mismatch"
    return 0
  fi
  if [[ "$dig" != "$spawner_dig" ]]; then
    printf '%s\n' "digest mismatch"
    return 0
  fi
  return 1
}
# rerun_taken_entry INDEX: the taken harness is not the one this tab was built
# for. Close the failed tab and re-exec so the taken entry gets the wall probe,
# the launcher, the tab environment and its home, and the rules files. Does not
# return on success. Refuses when $here is not a spawner directory or the file
# at $0 is no longer the one pass 1 recorded.
rerun_taken_entry() {
  local index="$1" why
  why="$(spawner_identity_reason || true)"
  if [[ -n "$why" ]]; then
    rm -f "$start_err"
    printf 'herd-spawn: spawner-identity: refusing the cross-harness re-exec (%s); the worker %s was not started\n' "$why" "$name" >&2
    exit 2
  fi
  if [[ -z "${tab_id:-}" ]]; then
    echo "herd-spawn: the ${harness} failover has no tab to close; the worker ${name} was not started" >&2
    exit 2
  fi
  if ! "$herdr" tab close "$tab_id" >/dev/null; then
    echo "herd-spawn: the failed tab ${tab_id} could not be closed, so the ${harness} harness was not started" >&2
    exit 2
  fi
  if [[ "$failover_perm_saved" == "yes" ]]; then
    export HERD_SPAWN_PERMISSION_MODE="$failover_perm_value"
  fi
  if [[ "$failover_wall_saved" == "yes" ]]; then
    export HERD_WALL="$failover_wall_value"
  fi
  if [[ "$failover_egress_saved" == "yes" ]]; then
    export HERD_WALL_EGRESS="$failover_egress_value"
  fi
  if [[ "$failover_cpu_saved" == "yes" ]]; then
    export HERD_WALL_CPU_SECS="$failover_cpu_value"
  fi
  if [[ "$failover_mem_saved" == "yes" ]]; then
    export HERD_WALL_MEM_MB="$failover_mem_value"
  fi
  if [[ "$failover_procs_saved" == "yes" ]]; then
    export HERD_WALL_PROCS="$failover_procs_value"
  fi
  if [[ "$failover_probe_saved" == "yes" ]]; then
    export HERD_WALL_PROBE_SECS="$failover_probe_value"
  fi
  if [[ "$failover_codex_home_saved" == "yes" ]]; then
    export CODEX_HOME="$failover_codex_home_value"
  fi
  export HERD_SPAWN_FAILOVER_INDEX="$index"
  export HERD_SPAWN_REPLACE_PANE="${pane:-}"
  export HERD_SPAWN_REPLACE_TAB="$tab_id"
  trap - EXIT
  exec "$0" "${failover_argv[@]}"
  echo "herd-spawn: could not rerun the spawn for the ${harness} harness; the worker ${name} was not started" >&2
  exit 2
}
# take_next_failover REASON: move to the next order entry when its cap allows, or
# report this harness and stop. Returns 0 only after a same-harness switch. A
# different harness closes the tab and re-execs. A symlink exits 2.
take_next_failover() {
  local why="${1:-}" next cap old nh nm day
  next=$((order_index + 1))
  if [[ "$next" -ge ${#order_entries_h[@]} ]]; then
    report_no_take "$why"
  fi
  cap="${order_entries_c[$next]}"
  if ! cap_allows "$cap"; then
    report_no_take "$why"
  fi
  day="${HERD_SPAWN_TODAY:-}"
  case "$day" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) report_no_take "$why" ;;
  esac
  if ! failover_reserve "$cap" "$day"; then
    report_no_take "$why"
  fi
  old="$harness"
  nh="${order_entries_h[$next]}"
  nm="${order_entries_m[$next]}"
  order_index=$next
  harness="$nh"
  model="$nm"
  printf 'herd-spawn: failover: %s did not start (%s); taking %s %s\n' \
    "$old" "$why" "$harness" "$model" >&2
  ledger_line failover "$name" "from=$old" "to=$harness $model" "why=$why"
  if [[ "$nh" == "$old" ]]; then
    apply_failover_args
    trust_adapter="$(adapter_path)"
    return 0
  fi
  rerun_taken_entry "$next"
}
# Pass 1, before the start loop: the file this process opened, so a swap during
# the failed start is visible to the cross-harness re-exec.
record_spawner_ident
start_err="$(mktemp "${TMPDIR:-/tmp}/herd-spawn-start.XXXXXX")"
started=no
stuck_on=""
deadline=$(( $(date +%s) + ${HERD_SPAWN_READY_SECS:-30} ))
# herd-watch's hand-off: the first entry is already at the out-of-usage screen, so it
# is not started. Same failover, same daily cap, or the report line and no start.
if [[ -n "$out_of_usage_from" ]]; then
  if [[ "$order_walk" != "yes" ]]; then
    report_no_take "$out_of_usage_line"
  fi
  take_next_failover "$out_of_usage_line"
fi
while :; do
  if "$herdr" agent start "$name" --kind "$harness" --pane "$pane" --timeout 120000 -- \
       ${agent_args[@]+"${agent_args[@]}"} >/dev/null 2>"$start_err"; then
    # A cursor screen that ends on a dead line is a start failure even though
    # agent start exited 0, and it counts against the cap. A first-run prompt is
    # not this: that stop is the branch below, and it does not fail over.
    if [[ "$order_walk" == "yes" && "$harness" == "cursor" ]] \
       && dead_phrase="$(cursor_dead_phrase)"; then
      if take_next_failover "$dead_phrase"; then
        stuck_on=""
        continue
      fi
      printf '%s\n' "$dead_phrase" > "$start_err"
      break
    fi
    started=yes
    break
  fi
  # a pane not yet at a shell prompt never had the harness typed into it, so it cannot
  # show a first-run prompt: that is the old slow-shell case, retried without a read
  if ! grep -q 'not at an interactive shell prompt' "$start_err" 2>/dev/null \
       && stuck_on="$(first_run_prompt)"; then
    break
  fi
  # herdr's own start deadline (`timed out waiting for agent startup`) already waited.
  # A fast failure is retried; this one is not: another start would not open a new pane,
  # and the handler below leaves the tab open for --resume. The first-run stub's wording
  # (`timeout after ... waiting for the agent to become ready`) does not match.
  # A start failure that is not a first-run prompt and not that timeout fails over
  # once the ready window is spent, or is reported by the harness name.
  if grep -F -q 'timed out waiting for agent startup' "$start_err" 2>/dev/null; then
    break
  fi
  stuck_on=""
  if [[ $(date +%s) -lt $deadline ]]; then
    sleep 2
    continue
  fi
  if [[ "$order_walk" == "yes" ]]; then
    fail_why="$(tail -1 "$start_err" 2>/dev/null || true)"
    if take_next_failover "$fail_why"; then
      stuck_on=""
      continue
    fi
  fi
  break
done
# THE TRUST SEAM (P1, owner principle 20260928T125026Z: APPL does not depend on one agent
# runtime). A pane stopped at the runtime's folder-trust question is answered ONLY when the
# spawn's repository -- its primary, so a linked worktree of a listed primary counts -- is a
# path the operator listed in $HOME/.muretai/dispatch/repos (dispatch_listed, above), and
# then only by the harness's own adapter, the file named after the harness in the trust
# directory beside this script. That adapter is the one place a runtime's dialog is known;
# this script knows no runtime's trust record or file, and no flag or variable reaches the
# check. A harness with no adapter there, an adapter that finds some other screen (exit 1),
# or an unlisted repository: the spawn stops and names the question exactly as before.
# The same seam answers every OTHER dialog the adapter recognizes (`--recognize` gives its
# kind word, e.g. auto mode's teach dialog): same gate, same adapter, same stop. It is asked
# only for a screen first_run_prompt did not already call `trust` (and never for "Not logged
# in"), so a trust stop still makes exactly one adapter call, and only when listed.
dialog=""
if [[ "$stuck_on" == "trust" ]]; then
  dialog="trust"
elif [[ -n "$stuck_on" && "$stuck_on" != "login" ]]; then
  dialog="$(dialog_kind)" || dialog=""
fi
trust_answered=no
if [[ -n "$dialog" ]] && dispatch_listed "$spawn_repo"; then
  if [[ -f "$trust_adapter" && ! -L "$trust_adapter" ]] &&
     bash "$trust_adapter" "$herdr" "$name" "$pane" </dev/null >/dev/null 2>&1; then
    if [[ "$dialog" == "trust" ]]; then
      echo "herd-spawn: ${name}'s folder-trust question was answered once (the repository is listed in the dispatch repos)" >&2
    else
      echo "herd-spawn: ${name}'s ${dialog} dialog was answered once (the repository is listed in the dispatch repos)" >&2
    fi
    trust_answered=yes
    stuck_on=""
    started=yes
    # The answer is not proof the pane moved on (another first-run prompt may follow, or the
    # key may not have landed). The agent must reach its input line; if it does not, this is
    # a spawn stopped at a first-run prompt like any other -- the P0 stop below keeps brief.md
    # and prints the one --resume -- and nothing more is typed.
    trust_wait_secs="${HERD_SPAWN_AGENT_READY_SECS:-120}"
    if ! "$herdr" agent wait "$name" --until idle --timeout "$(( trust_wait_secs * 1000 ))" >/dev/null 2>&1; then
      stuck_on="$(first_run_prompt)" || stuck_on="$dialog"
      trust_answered=unsettled
      started=no
    fi
  else
    trust_answered=failed
  fi
fi
if [[ -n "$stuck_on" ]]; then
  rm -f "$start_err"
  # a dialog other than trust is named by the adapter's kind word, never by its text
  [[ "$dialog" == "trust" || -z "$dialog" ]] || stuck_on="dialog"
  case "$stuck_on" in
    login)     what="\"Not logged in\"; run 'claude auth login' (once per machine)" ;;
    dialog)
      if [[ "$trust_answered" == "unsettled" ]]; then
        what="the dialog its adapter names '${dialog}', answered once (the repository is listed in the dispatch repos), but the agent never reached its input line; answer what the pane shows"
      elif [[ "$trust_answered" == "failed" ]]; then
        what="the dialog its adapter names '${dialog}' (the repository is listed in the dispatch repos, but the adapter did not answer it: its selection or screen was not the one it answers); answer it in the pane"
      else
        what="the dialog its adapter names '${dialog}', not answered because the repository is not listed in the dispatch repos (~/.muretai/dispatch/repos); answer it in the pane"
      fi
      ;;
    trust)
      if [[ "$trust_answered" == "unsettled" ]]; then
        what="the folder-trust question, answered once (the repository is listed in the dispatch repos), but the agent never reached its input line; answer what the pane shows"
      elif [[ "$trust_answered" == "failed" ]]; then
        what="the folder-trust question (the repository is listed in the dispatch repos, but the ${harness} harness has no trust adapter or its screen was not the dialog it answers); answer it in the pane"
      else
        what="the folder-trust question, not answered because the repository is not listed in the dispatch repos (~/.muretai/dispatch/repos); answer it in the pane"
      fi
      ;;
    auto-mode) what="the auto-mode setup prompt; answer it in the pane" ;;
    *)         what="the renderer choice; answer it in the pane" ;;
  esac
  stuck_said="${name} is stuck on Claude Code's first-run prompt: ${what}. The tab is left open (pane ${pane}, tab ${tab_id}). Not retried: the agent is already registered, and it did not start"
  # The resume record: what `--resume` needs to finish THIS spawn and nothing it could take
  # from a caller -- the pane and tab herdr gave it, the cwd, the harness, the model, the
  # wall, the owner key and the profile (what --resume branches on, never the directory
  # shape a wall can rewrite: intake 20261009T173857Z). In the herd-level .resume/ (mode 700, Edit-denied to every
  # session like .roles/ and .repos/), unlinked by exact path and created O_EXCL mode 600.
  # A value with a line break could forge a key, so it is refused, and so is the resume.
  own_dir "$resume_dir"
  if python3 -I - "$resume_rec" "pane=${pane}" "tab=${tab_id}" "cwd=${cwd}" "harness=${harness}" \
       "model=${model}" "wall=${wall_state}" "pair_key=${pair_key}" "profile=${profile}" <<'PY'
import os, sys
path, lines = sys.argv[1], sys.argv[2:]
if any(("\n" in l or "\r" in l or "\x00" in l) for l in lines):
    sys.exit(1)
if os.path.lexists(path):
    os.unlink(path)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
PY
  then
    half_fail 1 "$stuck_said" resume
  fi
  half_fail 1 "${stuck_said}; its resume record could not be written, so close the tab and spawn ${name} again"
fi
if [[ "$started" != "yes" ]]; then
  start_reason="$(tail -1 "$start_err" 2>/dev/null || true)"
  rm -f "$start_err"
  # herdr's own start deadline (`timed out waiting for agent startup`) is the same shape as
  # a first-run stop: the tab exists, the agent is not at its input yet, and closing the
  # tab is what left the owner with the panes they already had. Keep brief.md and write the
  # resume record the dialog path writes, plus stop=start-timeout, so --resume delivers the
  # one line once the agent can take it and appl-close refuses the tab until then.
  if printf '%s\n' "$start_reason" | grep -F -q 'timed out waiting for agent startup'; then
    start_said="${name} timed out waiting for agent startup (pane ${pane}, tab ${tab_id}). The tab is left open and brief.md is kept. When the agent can take input, run: bash ${here}/herd-spawn.sh --resume ${name}. Do not close the tab and do not spawn ${name} again"
    own_dir "$resume_dir"
    if python3 -I - "$resume_rec" "pane=${pane}" "tab=${tab_id}" "cwd=${cwd}" "harness=${harness}" \
         "model=${model}" "wall=${wall_state}" "pair_key=${pair_key}" "profile=${profile}" \
         "stop=start-timeout" <<'PY'
import os, sys
path, lines = sys.argv[1], sys.argv[2:]
if any(("\n" in l or "\r" in l or "\x00" in l) for l in lines):
    sys.exit(1)
if os.path.lexists(path):
    os.unlink(path)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
PY
    then
      half_fail 1 "$start_said" resume
    fi
    half_fail 1 "${start_said}; its resume record could not be written, so close the tab and spawn ${name} again"
  fi
  half_fail 1 "'herdr agent start' failed for ${name} (pane ${pane}, tab ${tab_id}): ${start_reason}; the agent did not start"
fi
rm -f "$start_err"
done_steps="${done_steps}, agent started in pane ${pane}"

# the wait, the pair hand-over, the one line, and only then the worker= line (at the top)
deliver_brief
