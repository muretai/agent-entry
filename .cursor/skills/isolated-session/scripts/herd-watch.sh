#!/usr/bin/env bash
# herd-watch: the coordinator's eyes on its herd -- one line per event: worker status
# changes, reports written, approval prompts answered or handed up, and stalled workers
# resumed.
#
#   herd-watch.sh [--notify NAME]                   loop: one pass every 20 s, forever
#   herd-watch.sh once [--notify NAME]              one pass, no sleep, exit 0
#   herd-watch.sh verdict <worker> [--worktree P]   pane text on stdin -> one line:
#                                                   `SAFE <cmd>` (exit 0), `BLOCKED <what>`
#                                                   (exit 1) or `NOPROMPT` (exit 2);
#                                                   never calls herdr
#
# --notify NAME: every REPORT:/PROMPT:/RESUMED:/STUCK: line a pass prints is ALSO sent,
# verbatim and once, as `herdr agent prompt NAME "<that line>"` -- how the coordinator
# pane (`muretai-coordinator`, briefs/coordinator.md) hears its herd without polling.
# WORKERS: and APPROVED: are not sent: one is a roll call, the other already handled.
# The lines are the fixed vocabulary below, so what the pane is typed is a name and a
# state, never pane text. NAME must be an agent name ([a-z][a-z0-9_-], at most 32) or
# the call is exit 2 before herdr is asked anything. A prompt that fails (the pane is
# down) is ignored: the pass goes on, and the line still reaches stdout.
#
# Who is watched is re-derived on EVERY pass: each agent in `herdr agent list` with a
# worker name, other than the --notify target, whose <HERD_DIR>/<name>/permissions.json
# exists and is not a symlink (herd-spawn wrote it), united with WORKERS. A worker spawned
# after the watcher started is picked up on the next pass; the loop logs `WORKERS:` when
# the set (or a status in it) changes. A listing that fails or comes back empty discovers
# nobody and drops no state; WORKERS names are still watched. Every pass also writes the
# roll call to <HERD_DIR>/.watch/workers (`<UTC time> <w>[=<status>] ...`, removed when
# herdr cannot be read). It is this pass's record, never a count: the coordinator's
# live-worker line (appl-hook.sh SessionStart) asks `herdr agent list` itself, and quotes
# this file, marked `(roll call; herdr unreachable)` with no count, only when herdr fails.
#
# A report is announced only when report.md is strictly newer than the worker's
# permissions.json (rewritten on every spawn), so a report left over from an earlier run
# under the same name is stale. <HERD_DIR>/<w>/.reported holds the SHA-256 of the report
# last announced: each distinct report is announced once, across passes and restarts.
# The report is hashed while streaming, never held. One whose lstat size is over 4 MiB is
# absent for that pass (never opened, nothing announced or marked) and logged once per
# pass as `<UTC time> report-oversized <w>` in coordinator.log.
#
# A worker that landed without writing report.md (its pane closed while the launcher ran its
# landing) is announced once per receipt as `REPORT: <w> landed without report.md`: every
# directory in HERD_DIR with its own rules file, listed by herdr or not, with no report.md
# and a $HERD_DIR/walls/<w>/landing-receipt.json that is a regular file strictly newer than
# permissions.json (state .watch/<w>.landed). The receipt is never opened; appl-hook.sh
# verifies the worker from it. The receipt is written before the worker's own report.md, so
# a worker herdr still lists is announced only once herdr shows it idle/done and both the
# receipt and that idle stretch are older than RECEIPT_GRACE (300 s); a working one never is,
# and with no listing nobody is. A worker herdr no longer lists is announced at once.
#
# Environment:
#   WORKERS                  optional: names watched even when herdr does not list them
#                            (herdr agent names = tab labels)
#   HERD_DIR                 the herd directory (default ~/.cache/muretai-herd); a worker's
#                            report is <HERD_DIR>/<w>/report.md, its rules file
#                            <HERD_DIR>/<w>/permissions.json (herd-spawn.sh writes both)
#   HERD_WATCH_NOW           the clock, epoch seconds (tests); default: the real one
#   HERD_WATCH_CAPACITY_BIN  the dispatch-capacity.sh to run (default: the sibling script)
#   HERD_WATCH_ALIVE_BIN     the liveness check of a landing's pid: an executable run with one
#                            argument, the pid; exit 0 alive, anything else dead (default:
#                            kill(pid, 0), as the landing-running marker always asked)
#   HERD_WATCH_INTERVAL      seconds between passes in the loop (default 20)
#   HERD_WATCH_RECEIPT_GRACE seconds a listed idle worker has, after its landing receipt, to
#                            write report.md before `landed without report.md` (default
#                            RECEIPT_GRACE, 300; anything but positive seconds is the default)
#   HERD_WATCH_PASS_TIMEOUT  the ceiling on one pass, in seconds (default 300, far above a
#                            normal pass). A pass still running then is killed with its
#                            whole process group (it runs as its own group, so no herdr
#                            call or other child it started outlives it), says so in one
#                            stderr line and exits 124; `once` returns that status and the
#                            loop goes on to its next pass. Enforced inside the Python, not
#                            with timeout(1), which macOS lacks.
#   HERD_WATCH_PS_BIN        the process listing a pass counts orphans from, run with
#                            `-A -o pid=,ppid=,comm=`, and finds a background
#                            finish-worktree.sh in, run with `-A -ww -o pid=,args=`
#                            (tests); default /bin/ps
#
# Orphans (every pass). Mac A once carried 32 `caffeinate` processes adopted by launchd, one
# per gate run, and nothing the coordinator read said so
# (ISSUE(caffeinate-and-sleep-orphans-per-gate-run)). Each pass counts the listing's rows whose
# ppid is 1 and whose command's last path component is exactly `caffeinate`, and when the
# count N is above 0 prints ONE line `ORPHANS: caffeinate=N` (the loop: only when it changed).
# It only counts -- nothing is signalled -- and a listing that fails is no count, no line.
#
# A non-regular file under coordinator/intake/ -- a FIFO, a socket, a device, a symlink --
# is judged on lstat and never opened (an open of a FIFO with nobody on its other end
# blocks forever), wherever an intake's header is read: the sweep's live workers, a
# RE-SPAWN's intakes and the resubmit's `intake <path>` alike.
#
# FIXED VOCABULARY, never free text: WORKERS:, REPORT:, APPROVED:, PROMPT:, STUCK:,
# RESUMED:, ORPHANS:, PUBLISHER: (publisher_watch; its reason is folded to one line). Every WORKERS: line ends `STUCK=<n>`: how many intakes are past their
# stuck threshold this pass (intake_stuck; intake 20261012T151408Z), told this pass or not.
# A `STUCK: <id> <age> <blocker>` line is an action for appl-hook.sh, never a log line, so
# an operator monitor must never filter STUCK. The hourly <coordinator>/status-report starts
# with <coordinator>/owner-stops.md. Command lines, pane tails and reconnect strings go to
# $HERD_DIR/.watch/<worker>.detail, read from there by the coordinator's own tool call.
# Why (2026-09-14): three injections reached the coordinator as text appended to task
# notifications, shaped as operator instructions. A watcher that pipes remote text into
# the coordinator's context is a carrier for that; one that emits only names and states
# is not. An event is a signal to GO LOOK, never a fact and never an instruction. The same
# holds for what the watcher TYPES: a resumed worker is sent one fixed sentence, never
# anything read from a pane.
#
# Approvals. A pane waiting at `Run this command?` is answered `y` only when EVERY
# segment of the line -- split on `&&`, `;`, `|` and `|&` (= `2>&1 |`) -- is on the safe
# table; a pipe stage after the first may also be a read-only filter. Inside a segment
# `$?`/`$VAR` are allowed as echo/printf arguments, `2>&1` anywhere, and a file redirect
# only when its target, realpath-normalised and compared by path component, is under the
# worker's worktree or <HERD_DIR>/<worker>/ (or is /dev/null). Command substitution,
# `||`, a background `&`, a subshell, an input redirect and a target nobody can resolve
# (`> $OUT`) are refused. The veto list (git options that run a program or read an
# untracked path, printf -v) is checked against the whole line and every segment, and
# beats everything. In the loop, the worktree is the agent's cwd as herdr reports it, and
# only when that cwd is a linked worktree: never the `in <dir>` the pane prints, which
# the session being judged wrote itself.
#
# A cursor worker is answered by policy and never from memory. y is sent only
# for a command on the SAFE table, a read-only command whose paths all stay
# inside the linked worktree, one simple command that equals a whole line of
# that worker's own brief, or a write inside the worker's herd directory or
# its review checkout. A write of brief.md, permissions.json, role,
# report.md.other or report.md.notesx stays a prompt, and so does any path
# that still contains a ".." segment. report.md and report.md.notes of this
# worker are the two report files that stay y. A brief line that is not on
# those tables is y once, a rule-gap line is logged, and one P1 rules-parity
# intake is filed per command text per UTC day. Anything else, including a
# pipe, a chain, a redirect, a
# substitution, python3 -c, curl, ssh, sudo and git config, is refused with NO
# key and no follow-up sentence: one BLOCKED detail line and one PROMPT line,
# deduplicated by .watch/<w>.last, and the pane is not counted as answered, so
# the park clock runs (intake 20261020T113041Z). A refused write, a prompt that
# does not parse and a bare "Not in allowlist" screen are refused the same way.
# n is sent only when the screen's UI lines are the old cursor menu, "Run
# (once) (y)" and "Skip (esc or n)". The full parsed command is judged,
# never the 400-character display text. A worker's own request never writes
# cursor-owner-allow, and a stored rule is not a reason for y. tab and
# shift+tab are never sent. A claude prompt keeps the safe-table path.
#
# The --notify target is not a watched worker, so the pass never reaches it
# through the worker list. When herdr lists that pane blocked, the same
# approve() runs for it. One more shape is y, and only for that pane: printf
# or echo appending one line to <HERD_DIR>/coordinator/coordinator.log, with a
# single $(date -u +FORMAT) and no other substitution, pipe, chain or redirect.
# That y is not stored as a Shell rule. python3 -c, curl, ssh, sudo and git
# config stay unanswered. tab and shift+tab are never sent.
#
# Dialogs. A worker herdr shows `blocked`, `done` or `idle` whose pane is at a dialog its
# runtime's adapter recognizes (scripts/trust/<harness>.sh --recognize, pane text on stdin,
# one kind word out: `trust`, `teach`, ...) is `dialog <kind> <w>` on the WORKERS: line and
# gets ONE `STUCK: <w>` per stop (.watch/<w>.dialog) -- except the kind `logged-out`, which is
# no dialog and goes down the logged-out path below. Nothing is typed into that pane -- no
# approval, no CONTINUE, no restart -- even for a repository in the dispatch repos: a line
# typed into a dialog could answer it, and answering is herd-spawn.sh's, at spawn, behind
# the dispatch gate. This script carries no runtime's dialog text; the adapter does.
#
# Resume. A worker whose pane tail says `stopped retrying`, `usage limit` or `rate limit`
# (any case) is prompted with CONTINUE below; a worker that is done (herdr does not see it
# at its input) or gone from `herdr agent list`, with no report.md, is restarted in its
# pane with herd-spawn.sh's claude arguments plus `--resume`, then prompted. Attempts at
# +0, +300, +1800 and +3600 s, four at most per spawn (.watch/<w>.resume), one RESUMED
# line each. A restart needs the worker's permissions.json (no rules file, no restart:
# claude is never started without --settings) and that file to be at least 600 s old (a
# fresh spawn that has not taken its brief yet is not a stalled worker). A listing that
# fails means herdr is down, not that the worker is gone: nothing is restarted.
# `dispatch-capacity.sh full "<phrase>: <worker>"` runs once per signature. CONTINUE goes in
# only after still_idle() re-lists the pane (intake 20261009T225956Z): a prompt typed into a
# pane that has since turned blocked would be answered by its Enter. The prompt branch re-lists
# before the attempt is counted, so a refused one spends nothing; the restart branch re-lists
# after its `agent wait`.
#
# Intake watchdog (with --notify only). The coordinator once set an intake's status to
# `new -- brief for <w> being written` and ended its turn before it spawned: the intake
# looked handled and nothing said it stalled. Each pass, every regular `<name>.md` directly
# under <HERD_DIR>/coordinator/intake/ (name by appl-hook's rule; no symlink, no subdir)
# whose HEADER `status:` names no agent in `herdr agent list`, whose first status word is
# not done/landed/SUPERSEDED/blocked/question/split, and whose mtime is more than 300 s old is
# typed into the NAME pane as `intake <path>` -- the bytes tools/appl-add.sh sends -- and
# logged `<UTC time> reprompt <file name>` in <HERD_DIR>/coordinator/coordinator.log. At
# most once per 300 s per (intake, mtime), state in .watch/intakes.json; an edit restarts
# the grace period. A failed agent listing judges nobody live: nothing is typed. Only the
# file name ever leaves an intake; the watchdog never edits one, spawns or closes a tab.
# Not forever (security review of 65163eb, finding 1): an intake appl-status.sh could not
# write stayed `new` and was re-typed every 300 s for good. One unchanged (same mtime) intake
# is typed at most STALL_CAP = 5 times, and not again from the first pass that finds
# .watch/status-failed/<file name> holding its mtime (appl-status.sh writes it when a write
# fails; .watch/ is outside every worker's wall). Either way ONE line, `<UTC time>
# reprompt-capped <file name>` or `<UTC time> status-failed <file name>`, goes to
# coordinator.log; an edit to the intake starts it over. Other intakes are unaffected.
#
# A free slot (with --notify only). When the coordinator pane is `idle` or `done` and
# live workers are fewer than the number in <HERD_DIR>/coordinator/worker-cap (the same
# count as the backlog pull: `working` and `blocked` hold a slot, the coordinator pane
# does not), one intake is typed as `intake <path>` and logged `slot <file name>`.
# Eligible: header status exactly `blocked after`, or a first word `new` that is still
# inside the 300 s grace (a stale `new` stays with the watchdog above). A status word
# that names a live agent is skipped. Order: the intake's header `repo:` against
# <HERD_DIR>/coordinator/project-priority, first line first. A line is a repo basename
# or an absolute path; a basename matches the repo path's last component; a ` share=<n>`
# or ` role=<role>` word is not part of it (scripts/project_priority.py). An unlisted
# repo sorts after every listed one. Within one rank a header `lane: fast` is ahead of
# an intake without it (`lane: Fast` does not count), and within that the older file
# name is first. A fast intake is never ahead of an earlier project.
# No such file: older file name only. One prompt is outstanding until this pane has
# been `working` since it was typed and that intake is no longer eligible, or 300 s
# have passed. The pass never edits an intake.
#
# A stopped seat (with --notify only). When the notify pane is idle or done, at least one
# other pane is listed, and none of those is working, every pane has stopped and a person
# is not the one who continues the turn. This pass types one fixed sentence into the notify
# pane and logs `<UTC time> seat <name>`. It does not type when this pass already typed
# into that pane (that pass only starts the 300 s), when the pane is blocked, when a
# re-list is not idle or done, when no other pane is listed, or when the coordinator
# directory is a symlink. The same panes are not prompted again inside 300 s unless this
# pane has been `working` since the sentence: a turn that started and ended is prompted
# again at once. The sentence keeps coming for as long as those panes stay stopped.
# Nothing from a pane or an intake is copied into the sentence. When the notify pane's
# spawn record says harness=claude, the sentence is typed only if `bash
# "$HERD_WATCH_HERE/appl-hook.sh" --kinds` prints a line `seat`: the hook's list is the one
# source of truth, and a hook that would block the sentence is not typed into.
#
# A logged-out target (with --notify only). The coordinator pane twice showed `Not logged
# in - Please run /login` after an in-pane auto-update and the watchdog re-typed intakes into
# it every 300 s for hours; /login is an interactive OAuth no script can do. Each pass reads
# the NAME pane: when its last reply line (the last 20 lines, the input box and the status
# line under it dropped, the U+23BF/U+23FA marks stripped) BEGINS with `Not logged in` or
# `Login expired` (a mention mid-line never counts), or when its runtime's adapter
# (--recognize, as for dialogs) prints the kind word `logged-out` -- the runtime's other
# logged-out lines, a revoked OAuth token among them, are known only there -- nothing is typed into it -- no intake, no notification -- and, once per occurrence
# (.watch/<NAME>.logged-out), `<UTC time> logged-out <NAME>` goes to coordinator.log and one
# line naming the pane, /login and restart-coordinator-pane.sh to
# <HERD_DIR>/coordinator/owner-step-login-<NAME>.txt. A pane that reads normally again
# clears both and the watchdog resumes; an unreadable pane changes nothing.
#
# The idle sweep (every pass whose listings answered). A REPORT appl-hook.sh BLOCKS never
# reaches the coordinator's model, and a worker pane answering `Not logged in` can do
# nothing: both used to idle forever. A watched worker (a listed agent with its own
# non-symlink rules file) that is not the coordinator pane (the --notify target, or
# `muretai-coordinator`) and that no intake HEADER status names live (`tests|impl|review
# <w>`, whole words, or a first word that is <w>'s bare name with its .repos/<w> spawn
# record) is closed through the sibling appl-close.sh -- which keeps all of its own
# refusals -- and logged `<UTC time> swept <w> <why>` (<why>: printable ASCII naming the
# first word of the header status it read for <w>): when herdr's agent_status has been
# idle/done for more than 20 minutes (counted from the last pass that saw it working, else
# the first that saw it idle; state in .watch/<w>.sweep, never through a link), or at once
# when its pane is logged out (the same rule as the target, the adapter's `logged-out` kind
# included; such a pane is never approved, prompted or restarted), which is
# first logged `logged-out <w>` once per spawn and named, with every other logged-out pane,
# in <HERD_DIR>/coordinator/owner-step-login-workers.txt. The worktree and the herd dir are
# never touched. A worker whose <HERD_DIR>/<w>/close-requested (written by appl-hook.sh on a
# final BLOCKED report; a regular file newer than the rules file) exists is due at once, and
# the marker is removed once the close went through. A worker herdr shows `working` on a pass
# is never closed by it (a logged-out pane aside), marker or not: the marker stays for the
# first pass that sees it idle. An appl-close.sh refusal is
# `sweep-refused <w>`: nothing is forced, the
# next candidate is still tried, and that worker waits another 20 minutes.
# A finished idle pane (herdr `idle` or `done`, never `working`, never logged out) is
# closed on that same pass, still only through appl-close.sh -- herd-watch never calls
# `herdr tab close` for this -- only once report.md exists as a regular file (a symlink
# is not a report; the bytes are not a verdict). Then, when coordinator.log has
# `verified <w>` or `verified <w> <range>` for that whole name at a UTC time after this
# spawn's permissions.json, or when the report's COMMIT= (a 40-hex sha, data) is an
# ancestor of refs/heads/main in $HERD_DIR/.repos/<w> and the report's WORKTREE= (an
# absolute path, data, never a shell word) is gone. A verified line, a finish command
# or a landing with no report.md does not close it. One line: `closed-verified <w>` or
# `closed-landed <w>`. A verified line wins when both are true. A BLOCKED or WAITING
# report with neither record stays inside the idle window, and an intake appl-close.sh
# still holds does too.
# A pane with no report.md that the idle window alone made due is held (no close, no line):
# (a) while herdr listed it working, or first listed it idle/done after its last working
# pass, no more than the receipt grace ago (a working pass restarts it), and (b) while its
# rules file is younger than 2 h, unless an intake HEADER status naming it as a whole word
# begins with `done`, `landed` or `split`. A close-requested marker or a logged-out pane
# closes as above, and a finished pane needs report.md anyway.
# A lost REPORT is never final (owner ruling 20261029T141406Z item 3): an idle or done pane
# the idle window made due, with report.md and no verdict line for it in coordinator.log --
# `verified <w>[ <range>]`, or `blocked <w> <why>` with `verdict <w> ...`, that whole name,
# after this spawn's permissions.json -- is not closed on that pass: `REPORT: <w> wrote
# report.md` is emitted once more (stdout and the --notify target, as any REPORT line) and
# the next pass that finds it due, still with no verdict, closes it as above and logs
# `<UTC time> unverified <w>`. A working pass starts that again. The dead-pane close below
# keeps the same rule: its first due pass re-emits the REPORT line, the next one closes.
# A pane due for any of these closes whose <HERD_DIR>/<w>/landing-running (written by
# finish-worktree.sh for HERD_WORKER=<w>) names a live pid is left open and logged
# `<UTC time> sweep-kept <w> landing`; the next pass asks again. A dead pid keeps nothing,
# nor (where ps answers) a pid that started after the marker's `started=` (a reused pid). A symlinked, foreign-owned or non-regular marker is judged on
# lstat before it is read, keeps nothing, and is logged `landing-marker-ignored <w> <why>`.
# The marker is written only once land.sh reaches finish-worktree.sh, so a landing the herd
# launcher runs OUTSIDE the wall, queued on the landing lock, keeps the pane too
# (ISSUE(sweep-kills-reviewer-while-its-receipt-lands)): the last `land: the landing of <b>
# runs its tests in pid=<P> (parent pid=<L>, the launcher)` line of $HERD_DIR/walls/<w>/wall.log,
# matched by run.py's `gate: the landing of <b> runs as pid=<P>, a child of the launcher
# pid=<L>` line, whose P is alive (HERD_WATCH_ALIVE_BIN) and no newer than the line, with no
# walls/<w>/landing-receipt.json written since it: `sweep-kept <w> landing` as above. A dead
# pid, a receipt, or a wall.log that is a symlink, not ours or not a regular file keeps nothing.
# A pane whose worker waits on a live background run (intake 20261024T100902Z) is kept the
# same way, logged `sweep-kept <w> background`, and gets no STUCK line for its empty input
# while it waits: (a) $HERD_DIR/walls/<w>/bg-run, a regular file of ours, mode 600, holding
# the one line `pid=<decimal>`, names a live pid that is no newer than the file; or (b) a row
# of the process listing (HERD_WATCH_PS_BIN or /bin/ps, `-A -ww -o pid=,args=`) has a word
# whose last path component is exactly finish-worktree.sh followed by a word equal to
# `record.branch` of $HERD_DIR/walls/<w>/run.json. Only the launcher side, outside the
# wall, may write bg-run; nothing in this watcher writes it. A malformed record, a dead pid,
# another branch or another script keeps nothing. Once the run ends the pane is STUCK and
# swept as any other.
# A logged-out worker is also, once per spawn (.watch/<w>.respawn), given its own
# close-requested marker and ONE intake filed through tools/appl-add.sh, titled
# `RE-SPAWN <w> after login expiry`, naming the worker, its worktree (linked_worktree) and
# the intakes whose header status names it -- so the work is picked up after /login. The
# coordinator pane never is. A revivable pane (below) gets neither on its first pass: its
# intake waits for the revive to fail (intake 20261009T123123Z).
# A dead pane (20261016T051251Z, item 1, guarded by 20261016T083349Z). A worker herd-spawn
# wrote -- its own rules file, not the coordinator pane -- is a candidate only when that
# rules file is strictly newer than this process's start (time.time() as the pass begins,
# not HERD_WATCH_NOW) and an earlier pass listed it working, idle or blocked. A directory
# never seen alive is never dead and never respawned. muretai-coordinator is never a
# candidate. A candidate is closed through appl-close.sh --dead once one of three absences
# is older than 300 seconds on this watcher's clock, counted from the first pass that saw
# it (.watch/<w>.dead). The absences: herdr's tab list, agent list and pane list all omit
# the worker (why `unknown`); the tab and the pane list carry it and the agent list does
# not (`missing-agent`); all three carry it and `herdr pane process-info` shows no
# foreground process named claude, cursor-agent or grok (`no-harness`; bash and zsh are
# the shell). The log line is `<UTC time> dead <w> <why>`. At most 5 due workers close
# per pass, the lexicographically first; the rest stay due. A pass whose tab list or whose
# agent list has lost more than half of the names that listing showed alive on the previous
# pass is a failed listing: it logs `<UTC time> listing-dropped <n>` (each lost name once),
# skips the dead close, the idle sweep and RE-SPAWN filing, and does not touch
# .watch/<w>.dead or .watch/listing.alive. It still emits a pending report, answers a
# prompt and checks a stall. The same lost names on the next pass are real: the baseline
# becomes the names still listed and the pass logs `<UTC time> listing-rebased <n>`. A
# lost name whose tab is absent and whose pane is absent counts as closed, marker or not,
# when the pane list still carries a name that baseline showed alive. A pane list that
# carries none of them is the gutted listing and stays a drop. More than 10 consecutive
# failed listings appends one owner-stops row and sends one owner mail, `watcher latched:
# listing-dropped x<n>`, once. A pass that is not a failed listing resets that count. A
# name still in that listing is not lost, whatever its status became, and neither is a
# name appl-close.sh already closed: that absence is the close, not herdr dropping the
# list. The pair key, the one
# line in $HERD_DIR/.keys/<w>, gains one on $HERD_DIR/.watch/<key>.deaths. A RE-SPAWN
# intake is filed only when an intake HEADER status is `tests <w>` or `impl <w>`; any
# other death is logged alone. A pass 300 seconds later is not yet due. A live harness,
# a name that is not a worker name, and a herdr that does not answer close nothing, file
# nothing and do not move the count.
# A cursor start-timeout (20261016T082412Z, child of 20261016T051251Z). A resume record
# with the lines harness=cursor and stop=start-timeout is timed from the rules file's
# mtime on HERD_WATCH_NOW. Before 300 seconds nothing is resumed and nothing is closed.
# At 300 seconds a foreground list with no cursor-agent is dead at once: appl-close.sh
# --dead, the log line `dead <w> start-timeout`, and herd-spawn.sh is not called. A live
# cursor-agent is resumed with herd-spawn.sh --resume at 300 seconds and again 60, 300
# and 900 seconds after the previous resume. The pass after the fourth resume is dead,
# and there is no fifth resume. The record is removed when the pane is working or
# report.md is a regular file, and kept while it is neither. A record without
# stop=start-timeout is not this decision. The dead sweep above is unchanged: a pane
# that is not in this condition still needs a seen-alive candidate and a recorded tab.
# A start-failed pane (20261018T131819Z, child of 20261016T051251Z) is a separate step.
# It runs after the cursor start-timeout delivery and before the dead sweep, and it uses
# only evidence written outside the wall. A listed tab whose agent list has no row of
# that name, and whose walls/<w>/wall.log is a regular file of ours whose latest
# `started pid=<digits>` line is followed by `exited status=<digits>` at most 60 seconds
# later, is closed through appl-close.sh --dead. Exactly 60 seconds counts; 61 does not.
# A newer `started pid=` with no exit after it is not a pair, and a symlink wall.log is
# not a pair. The pane is read with `herdr pane read <pane id> --lines 20`, the pane id
# from that tab row, never the worker name. The first of those lines that begins with
# `Error:` is the start error: characters outside printable ASCII are removed and the
# line is cut to 200 characters. No such line logs `-`. The log line is
# `start-failed <w> <status> <start error>`. Counting replaces every maximal run of two
# or more hex digits, and any remaining digit, with `#`. At most 5 closes a pass, the
# lexicographically first. A pass whose tab list or agent list failed closes nothing,
# reads no pane and files nothing. Never the coordinator, the --notify target, a listed
# agent, or a name without both a listed tab and a wall pair. A stop=start-timeout
# record whose process list has no cursor-agent is closed here and the record is
# removed; one that still names cursor-agent is left in place. An intake whose header
# is exactly `tests <w>` or `impl <w>` is respawned once, herd-spawn.sh <fresh> <brief>,
# under a fresh name nobody listed, and the intake becomes `<role> <fresh>`. Two
# failures of one key within 2 hours stop respawn until a later successful start of the
# same harness clears the key. The stop writes one owner-stops.md row, one owner mail
# `start-failed x<n>: <start error> -- answer: appl-add.sh "<question>" --parent <id>`,
# and `status: question` on each intake that just hit the stop, at most once per 4 hours
# per key. A successful start is that harness word on the wall's spawn line, a
# `started pid=` with no exit after it that is already more than 60 seconds old, and
# the agent listed working. A different harness does not clear the key.
# The login revive (2026-10-09) is the one carve-out from "nothing is typed into a logged-out
# pane". A watched worker -- listed, its own rules file, not closed by appl-close.sh since
# this spawn, never the coordinator pane -- whose last reply line BEGINS with `Login expired`
# or `OAuth token revoked` (the `Not logged in` reading; the adapter's own logged-out screens
# are not revived) gets, once HERD_WATCH_LOGIN_GRACE_S (default 30; a non-numeric, negative
# or empty value is the default) has passed since the first pass that saw the episode, ONE
# `herdr agent prompt <w> "continue with the brief"` and `<UTC time> revived <w>` in
# coordinator.log. Once per episode (.watch/<w>.revive): herdr showing the pane `working`
# ends it; a later expired screen is a new episode with its own grace and its own line. Until
# the line was typed and a further grace has passed, the sweep leaves that pane open.
# When that further grace has passed, herdr has not shown the pane working since the line,
# and its last reply still begins with one of the two texts, the revive failed: the sweep
# closes it through appl-close.sh (whose refusals stand -- a worker blocked at landing stays),
# then runs the sibling `herd-spawn.sh --resume <w>` with this HERD_DIR when
# $HERD_DIR/.resume/<w> exists; with none, it files the one RE-SPAWN intake above then,
# after the close (a refused close files none). One `<UTC time> respawned <w>` instead of `swept`, and once per episode (the
# record notes the spawn). Such a pane herdr shows `working` is never closed. A pane whose
# episode ends -- shown working, or reading normally again -- loses the record and any
# close-requested marker a logged-out filing left, so the revive it got is not undone.
# Revive and that close-and-re-spawn act only on a pane herdr shows `idle` or `done`, never
# `blocked`: a permission prompt can display a command ending in `Login expired`, and the
# Enter after the line would approve it. A blocked pane is read as blocked before it is read
# as logged out, so it always reaches verdict() and its PROMPT line.
# The pass's status is a snapshot (ISSUE security-audit-2026-10-09-pin-that-herd-watch-54fc): a
# pane listed idle can raise a permission prompt before the line goes in. So every guard of a
# pass reads its ONE `herdr agent list` (the tab row only for a pane with no agent row, never
# over it), and just before any line or lone Enter goes into a pane -- the revive line, the
# coordinator's spawn line, the nudge, the resubmit's Enter -- that pane's status is re-listed
# with `herdr agent list`, nothing read or typed between: only a single row saying `idle` or
# `done` lets it through. A re-list that fails, is empty or not JSON, omits the row or says
# anything else types nothing. A revive episode or a nudge then waits for a later pass to ask
# again; the resubmit's record is consumed as always, so that text never gets its Enter.
# The coordinator's login revive (item 3 of 20261009T102930Z) is the same carve-out for the
# logged-out --notify target. Its last reply BEGINS with `Login expired` or `OAuth token
# revoked` and herdr shows it `idle` or `done`, never `blocked` (the worker path's check).
# Once the login grace has passed since the first pass that saw the episode, it gets ONE line:
# its own spawn line, `Read <HERD_DIR>/<NAME>/brief.md and follow it. Your report goes to
# <HERD_DIR>/<NAME>/report.md. Open the brief with your Read tool, not with a shell command.`
# That is herd-spawn.sh's first line, which appl-hook.sh passes as `brief <NAME>`. It never
# gets `continue with the brief`, which the hook blocks there. The line is logged
# `<UTC time> coordinator-login-revive <NAME>`. Once per episode
# (.watch/<NAME>.coord-revive): herdr showing it `working`, or the pane reading normally,
# ends the episode. When a further grace has passed, the pane still expired, the sibling
# restart-coordinator-pane.sh runs ONCE with no arguments and this HERD_DIR, logged
# `coordinator-login-restart <NAME>`. That happens only for NAME `muretai-coordinator`, the one
# pane that script restarts; any other NAME gets ONE `<UTC time> no restart recipe for <NAME>`
# at that point instead, once per episode, and no script runs. A missing script is ONE
# `coordinator-restart-missing <NAME>` line and nothing else. Never appl-close.sh or herd-spawn.sh: this watcher closes no tab.
#
# The stall nudge (every pass whose listings answered, before the sweep may close anyone). A
# spawn line herd-spawn.sh typed can sit unsubmitted, or never arrive (the prompt showing its
# placeholder); four did on 2026-09-30, and one worker was swept after 20 minutes without its
# brief. A watched worker herdr shows `idle` (never the coordinator pane), its brief.md handed
# over, no current report.md, never seen working for this spawn, whose spawn record (the rules
# file) is at least 180 s old, gets herd-spawn's own nudge: one Enter when its last prompt
# line is exactly its spawn line, or one re-send of that line (built from abspath(HERD_DIR)/<w>,
# never read from a file or a pane) when the prompt shows the placeholder. Any other screen,
# a dialog or a logged-out pane is left alone. Once per spawn record (.watch/<w>.nudge),
# logged `<UTC time> nudged <w>` in coordinator.log; the pass that nudges closes nothing and
# restarts that worker's idle count.
#
# The resubmit (every pass). Text the watcher itself typed -- a notification or an `intake
# <path>` at the --notify pane, CONTINUE or a re-sent spawn line at a worker -- can sit
# unsubmitted in the prompt bar (a background shell running, a banner) while herdr reports
# success. Each typed text is recorded (.watch/<w>.typed, the newest per pane); the next pass
# that reads that pane consumes the record and, when the LAST prompt line is exactly that
# text, the pane is at no dialog and a re-list just then shows it idle or done, presses ONE
# Enter, logged `<UTC time> resubmitted <w>`
# in coordinator.log. Any other bar gets nothing. Never a second Enter for one text, and
# nothing read from a pane is ever typed.
# A cursor pane, the spawn record naming harness=cursor, is resubmitted from its screen
# instead (intake 20261019T061637Z). cursor_screen_kind in herd-spawn.sh names the pane.
# Only the word `typed` can be pressed. The idle interval starts on the first pass that
# sees the pane idle with that exact typed row text. A later pass presses one
# `herdr agent send-keys <w> enter` and logs `<UTC time> resubmitted <w>` only when the
# same text is still the typed row and the clock is more than 60 seconds after that first
# pass. Exactly 60 seconds presses nothing. The same text is never pressed twice. A
# different typed text starts its own 60 seconds. approval, empty, box-closed and no row
# press nothing, including an approval menu with a typed-looking row above it. The row
# text is not typed back. A claude pane keeps the prompt-row resubmit above and is not
# on this path, even when its screen shows a cursor typed row.
# A claude pane, the spawn record naming harness=claude, whose input row is the prompt
# glyph, one space, then text, is resubmitted the same way (intake 20261020T174548Z),
# idle or done. The interval starts on the first pass that sees that exact typed row.
# A later pass presses one Enter and logs `<UTC time> resubmitted <w>` only when the
# same text is still the row and the clock is more than 60 seconds after that first
# pass. Exactly 60 seconds presses nothing. The same text is never pressed twice. A
# different typed text starts its own 60 seconds. A bare glyph, a glyph with no text,
# the placeholder and a numbered choice are empty. A permission or approval screen
# ("Do you want to proceed?", "Run this command?", "Write to this file?") gets no
# Enter whether or not a typed row sits under it. Working and blocked get nothing.
# The row text is not typed back. The prompt-row resubmit above is unchanged: a
# bordered row matching .watch/<w>.typed still gets one Enter on the next pass, with
# no 60 second wait. A cursor pane is not on this path.
# The one exception is a stalled answer (intake 20261009T201212Z): a watched worker (never the
# coordinator pane) herdr lists `done` and at its input, with no report.md, whose LAST prompt
# line holds text for MORE than HERD_WATCH_STALL_ANSWER_S seconds (default 300) since the first
# pass that saw that state, gets ONE `herdr agent prompt <w> <that text>` -- the pane's own
# text, back into that pane only, never logged -- after a re-list just then shows it idle or
# done, and `<UTC time> resubmitted <w>`. No Enter. Once per stall (.watch/<w>.stall-answer,
# the text's SHA-256 only): shown anything but done, an emptied or changed line, or a report
# ends it, and the next stall is timed afresh. Only a plain answer in the bordered claude
# input row is typed back: dim ghost text, a `!` or `/` line, a selection row, a numbered
# choice list on the last screenful, or a pane with no bordered input row (cursor, codex,
# grok) is refused, and a refused text's SHA-256 stays in .watch/<w>.stall-refused across
# working and done, so it is never retried.
# A done pane with an EMPTY last prompt line (or the placeholder) and no report.md for more
# than 15 minutes (intake 20261010T010135Z) has nothing to resubmit: it gets ONE `STUCK: <w>`
# line per episode (.watch/<w>.stuck-empty), sent on with --notify, and nothing is typed.
#
# Stuck spawns (every pass whose listings answered, before the sweep). A spawned worker once
# sat at its runtime's folder-trust dialog for 16 hours: herd-spawn.sh had removed its
# brief.md, no report came, the idle sweep never fires on a `blocked` pane, and the slot
# stayed taken. A watched worker (as the sweep means it, never the coordinator pane) is
#   never-briefed: no regular brief.md in its herd dir, no report newer than its rules file,
#     never seen `working` by this watcher, and a rules file more than 900 s old;
#   parked: herdr `blocked` on every pass for more than 20 minutes, counted from the first
#     blocked pass (any other status, or a prompt this pass approved, starts it over).
# Once per spawn (.watch/<w>.stall): `<UTC time> never-briefed <w>` or `parked <w>` in
# coordinator.log, then the logged-out path above -- close-requested marker (the sweep
# closes through appl-close.sh, whose refusals stand) and ONE `RE-SPAWN <w>` intake, the
# .watch/<w>.respawn state shared with the login-expiry filing so a worker gets one in all.
# Runtime-neutral: judged from herdr's status and the herd dir alone, never from pane text or
# any agent runtime's own configuration, and the stuck prompt is never answered.
#
# The backlog pull (every pass whose agent listing answered, last). When a slot is free --
# the listing's rows other than the coordinator pane whose agent_status is `working` or
# `blocked` (an unreadable status counts; `idle` and `done` do not) are fewer than the
# one number in <HERD_DIR>/coordinator/worker-cap -- the pass runs appl-backlog-pull.sh, through
# appl-hook.sh's seam APPL_BACKLOG_PULL, once per repo in the dispatch repos ($DISPATCH_DIR/
# repos, default ~/.muretai/dispatch/repos; `<name>=<absolute path>` lines) that has a
# docs/BACKLOG.md or a <HERD_DIR>/coordinator/backlog/<name>/inbox directory, in file order,
# stopping at the first pull that files (exit 0, the intake's path on stdout). A pull that
# exits non-zero is skipped and logged `<UTC time> backlog-pull-refused <name>` in
# coordinator.log; its output is never read. $APPL_BACKLOG_REPO (an absolute path) restricts
# the pass to that one repo, no fallback. So an idea in a backlog inbox
# (tools/appl-backlog-add.sh) is filed without waiting for a landing. No listing, no
# readable cap, no free slot, or a logged-out --notify target: not run. The pull's output
# never reaches this pass's stdout.
#
# The idle fuzz run (every pass whose agent listing answered, after the pull; intake
# 20261024T203610Z). When no worker row is working or blocked, the pass starts
# tools/fuzz_idle.py of this skill's APPL checkout with one --root per dispatch repo, detached
# (its own session, output to <HERD_DIR>/coordinator/fuzz-idle.log) and never waited for, so a
# pass returns while a harness runs. fuzz_idle.py holds its own lock, checks idle and the
# spawn floor again, and yields to a pane that turns active. At most one start per 300 s
# (.watch/fuzz-idle.kick), none once coordinator/fuzz-idle.done holds today's UTC date.
#
# Log rotation (every pass, first). herd-watch is the one owner of coordinator.log's size:
# at 64 MiB or more the pass moves <HERD_DIR>/coordinator/coordinator.log.1 to .2 (an old
# .2 is dropped) and coordinator.log to .1; two backups, no more. A symlink, or anything
# not a regular file, at any of the three names rotates nothing. The moves are renames, so
# a writer appending at that moment loses no line.
#
# Self-reload (the loop only). The pass's Python is read into a variable once, at start, so a
# watcher left running kept old code through every later landing (one ran two days). Before
# each pass the loop compares this file's content (cksum) with what it started from; when it
# changed, and the new file passes `bash -n`, it logs ONE line `herd-watch: reloaded
# <old>..<new>` on stderr and execs the same path with the same arguments -- same pid, between
# passes, never two watchers. A new file that fails `bash -n` is not run: one line `herd-watch:
# kept <old>, <new> fails bash -n` per such content, and the old code keeps watching.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
export HERD_WATCH_HERE="$here"
# the loop re-execs this very file with these very arguments when it changes (below)
self="$here/$(basename "$0")"
orig_args=("$@")

# The program is held in a variable, not piped in, so stdin stays free for `verdict`'s pane
# text; `read -d ''` rather than `$(cat <<...)`, which bash 3.2 mis-parses on a quote or a
# parenthesis inside the here-document. read returns 1 at the end of input, by design.
IFS= read -r -d '' HERD_WATCH_PY <<'PY'
import calendar, hashlib, json, os, re, signal, stat, subprocess, sys, time, traceback, unicodedata

CONTINUE = "Continue from your last saved state; same report.md."
PHRASES = ("stopped retrying", "usage limit", "rate limit")
DELAYS = (0, 300, 1800, 3600)      # wait before attempt 1..4, from the attempt before it
YOUNG = 600                        # a rules file younger than this is a fresh spawn
NAME_RE = re.compile(r"[a-z][a-z0-9_-]{0,31}")
PANE_RE = re.compile(r"[A-Za-z0-9:_.-]{1,64}")
HOME = os.environ.get("HOME", "")
H = re.escape(HOME) if HOME else r"(?!x)x"

NON_SHELL = ("Write to this file?", "Delete this file?", "Allow this web fetch?",
             "Allow this web search?", "Run this MCP tool?", "Delete this file")

READERS = [
    r"rg( .*)?", r"grep( .*)?", r"sort( .*)?", r"uniq( -[A-Za-z]+)*", r"wc( .*)?",
    r"head( .*)?", r"tail( .*)?", r"cut( .*)?", r"sed -n [0-9]+(,([0-9]+|\$))?p",
]
# options that turn a reader into a writer or a runner
READER_VETO = [r"^rg\b.*\s--pre", r"^sort\b.*\s(-[A-Za-z]*o|--o|--comp)"]
SAFE = [
    r"python3 test_[A-Za-z0-9_]+\.py( .*)?",
    r"python3 tests/test_[A-Za-z0-9_]+\.py( .*)?",
    r"python3 tools/test_[A-Za-z0-9_]+\.py( .*)?",
    r"python3 tools/check\.py( .*)?",
    r"((AGENTNET_IROH_REQUIRE=1|MURETAI_IROH_PYTHON=" + H + r"/\.cache/muretai-tests/iroh-venv/bin/python) )*("
    + H + r"/\.cache/muretai-tests/iroh-venv/bin/python|python3) (test_[A-Za-z0-9_]+\.py|tools/iroh_offline_canary\.py)( .*)?",
    r"python3 \.claude/skills/contract-test/scripts/(check_test_provenance|mutate)\.py .*",
    r"flyctl (auth whoami|apps list|ips list|secrets list|certs list|status|releases|machine list|machines list|logs|version)( .*)?",
    r"mkdir -p (~|\$HOME)/\.cache/muretai-tests/[A-Za-z0-9_.-]+",
    r"([A-Z_]+=[^ ]+ )*(~|\$HOME|" + H + r")/\.cache/muretai-tests/iroh-venv/bin/python3? (operator_cli\.py|agent_mcp\.py|tools/[A-Za-z0-9_]+\.py|test_[A-Za-z0-9_]+\.py|-m [a-z_.]+)( .*)?",
    r"([A-Z_]+=[^ ]+ )*python3 (operator_cli\.py|tools/[A-Za-z0-9_]+\.py) (transport|doctor|--as [A-Za-z0-9_-]+ (transport|doctor|wake status))( .*)?",
    r"export ([A-Z_]+=[^ ]+ ?)+",
    r"echo( .*)?",
    r"(GIT_EDITOR=true )?git rebase( --continue| main)",
    r"git add [A-Za-z0-9_./ -]+",
    r"git mv (-k )?(test_[A-Za-z0-9_*]+\.py |tests/[A-Za-z0-9_./*-]+ )+tests/?[A-Za-z0-9_./-]*",
    r"mkdir -p tests/?[A-Za-z0-9_./-]*",
    r"git restore( --)? [A-Za-z0-9_./ -]+",
    r"git commit .*",
    r"herdr (tab list|pane list|api schema|--version|--help)( .*)?",
    r"herdr agent (read|prompt|send-keys|wait) --help",
    r"ps -o [A-Za-z=,]+ -ax",
    r"python3 tools/(run_tests|ledger|affected_tests|spec_build|audit_scope|sec_lint)\.py( .*)?",
    r"python3 -m agent\.plugins( .*)?",
    r"git (grep|ls-files|blame|rev-parse|rev-list|worktree list)( .*)?",
    r"printf( .*)?",
    r"git branch( --list| -a| -v| --show-current)?( [A-Za-z0-9_./-]+)?",
    r"npm (test|run [A-Za-z0-9:_-]+)( --.*)?",
    r"bash \.cursor/skills/isolated-session/scripts/(assert-head|stale|claim-worktree)\.sh( .*)?",
    r"bash \.cursor/skills/isolated-session/scripts/finish-worktree\.sh [A-Za-z0-9_./-]+ [A-Za-z0-9_./-]+",
    r"pwd",
]
# The read-only commands (ls, find, cat, git log, herdr agent read, ...) are not kept here by
# hand: READONLY, below, is readonly-commands.tsv beside this script, the list herd-spawn.sh
# renders into every profile (intake 20261007T152501Z).
# Never auto-approve the git options that run a program or read or write an untracked
# path -- git grep -O/--open-files-in-pager runs a command, git blame --contents reads any
# file the uid can read, --textconv and --ext-diff run a configured filter, --output
# writes anywhere, and the git diff family the 2026-09-13 review closed
# (ISSUE(security-audit-2026-09-14-daily-2026-09-14)). Long options are matched by the
# prefix git itself accepts as an abbreviation (`--open` is `--open-files-in-pager`).
# printf -v assigns a variable (PATH) that a later segment would then run under.
VETO = [
    r"\bgit\b[^|&;]*\bgrep\b[^|&;]*\s-[A-Za-z]*O",
    r"\bgit\b[^|&;]*\bgrep\b[^|&;]*\s--op",
    r"\bgit\b[^|&;]*\bblame\b[^|&;]*\s--con",
    r"\bgit\b[^|&;]*\b(grep|blame|log|show|diff)\b[^|&;]*\s--textc",
    r"\bgit\b[^|&;]*\b(log|show|diff)\b[^|&;]*\s--ext",
    r"\bgit\b[^|&;]*\b(log|show|diff|format-patch|blame)\b[^|&;]*\s--out",
    r"\bgit\b[^|&;]*\bdiff\b[^|&;]*(\s--no-i|/dev/null)",
    r"(^|\s)printf\s+(-\S+\s+)*-v",
]
# an assignment (a prefix or an export) that would change what a later command runs
BAD_ASSIGN = re.compile(r"(PATH|PYTHON[A-Z0-9_]*|GIT_[A-Z0-9_]*|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|BASH_ENV|ENV|"
                        r"BASH_FUNC[A-Za-z0-9_%]*|IFS|PS4|PROMPT_COMMAND|HOME|SHELLOPTS|BASHOPTS|CDPATH|"
                        r"[A-Z0-9_]*PAGER|[A-Z0-9_]*EDITOR|NODE_OPTIONS|PERL5OPT|RUBYOPT)=")


class Refuse(Exception):
    pass


def clean(s, n=400):
    """one line an operator may read: invisible code points spelled out, bounded"""
    out = []
    for ch in s:
        if unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp", "Cs", "Co", "Cn"):
            out.append("\\x%02x" % ord(ch) if ord(ch) < 0x100 else "\\u%04x" % (ord(ch) & 0xFFFF))
        else:
            out.append(ch)
    return "".join(out)[:n]


def herd_dir():
    d = os.environ.get("HERD_DIR") or os.path.join(HOME, ".cache", "muretai-herd")
    return os.path.abspath(d)


def clock():
    try:
        return int(os.environ.get("HERD_WATCH_NOW") or time.time())
    except ValueError:
        return int(time.time())


# ------------------------------------------------------------------ the verdict

def parse_prompt(text):
    """("OTHER", what) | ("NOPROMPT", None) | ("CMD", (cmd, dir))"""
    tail = text[-2500:]
    for kind in NON_SHELL:
        if kind in tail and "Run this command?" not in tail:
            where = ""
            for line in reversed(tail.rsplit(kind, 1)[0].splitlines()):
                if line.strip():
                    where = line.strip()[:160]
                    break
            return "OTHER", kind + " " + where
    if "Run this command?" not in text:
        return "NOPROMPT", None
    before = text.rsplit("Run this command?", 1)[0].splitlines()
    # the command may wrap over several lines: walk back to the `$` line, join what follows
    acc = []
    for line in reversed(before):
        if not line.strip():
            continue
        acc.insert(0, line.strip())
        if re.match(r"^\s*\$\s+", line):
            m = re.match(r"^\$\s+(.*) in (\.|\S+)$", " ".join(acc).strip())
            if m:
                return "CMD", (m.group(1).strip(), m.group(2))
            break
        if len(acc) > 8:
            break
    return "NOPROMPT", None


def lex(cmd):
    """Shell words and operators, quote-aware. Tokens: ("word", value, expands),
    ("op", ;|&&||&), ("redir", op), ("dup", op). Anything this does not model is refused."""
    toks = []
    word, expands, quoted = None, False, False
    i, n = 0, len(cmd)

    def flush():
        nonlocal word, expands, quoted
        if word is not None:
            toks.append(("word", word, expands))
        word, expands, quoted = None, False, False

    while i < n:
        c = cmd[i]
        if c in " \t":
            flush(); i += 1; continue
        if c == "'":
            j = cmd.find("'", i + 1)
            if j < 0:
                raise Refuse("an unbalanced quote")
            word = (word or "") + cmd[i + 1:j]; quoted = True; i = j + 1; continue
        if c == '"':
            j, buf = i + 1, ""
            while j < n and cmd[j] != '"':
                if cmd[j] == "\\" and j + 1 < n and cmd[j + 1] in '"\\$`':
                    buf += cmd[j + 1]; j += 2; continue
                if cmd[j] == "$":
                    expands = True
                buf += cmd[j]; j += 1
            if j >= n:
                raise Refuse("an unbalanced quote")
            word = (word or "") + buf; quoted = True; i = j + 1; continue
        if c == "\\":
            if i + 1 >= n:
                raise Refuse("a trailing backslash")
            word = (word or "") + cmd[i + 1]; quoted = True; i += 2; continue
        if c == "$":
            expands = True
        if c in ";&|<>()":
            fd = ""
            if c == ">" and word is not None and not quoted and word.isdigit():
                fd, word, expands, quoted = word, None, False, False
            else:
                flush()
            if c in "()":
                raise Refuse("a subshell or group")
            if c == "<":
                raise Refuse("an input redirect or here-document")
            if c == ";":
                toks.append(("op", ";")); i += 1; continue
            if c == "|":
                if cmd.startswith("||", i):
                    raise Refuse("`||`")
                if cmd.startswith("|&", i):
                    toks.append(("op", "|&")); i += 2; continue
                toks.append(("op", "|")); i += 1; continue
            if c == "&":
                if cmd.startswith("&&", i):
                    toks.append(("op", "&&")); i += 2; continue
                if cmd.startswith("&>>", i):
                    toks.append(("redir", "&>>")); i += 3; continue
                if cmd.startswith("&>", i):
                    toks.append(("redir", "&>")); i += 2; continue
                raise Refuse("a background `&`")
            op = ">>" if cmd.startswith(">>", i) else ">"
            i += len(op)
            if cmd.startswith("|", i):
                raise Refuse("`>|`")
            if op == ">" and cmd.startswith("&", i):
                i += 1
                m = re.match(r"[0-9]+|-", cmd[i:])
                if m and (i + m.end() >= n or cmd[i + m.end()] in " \t;|&"):
                    toks.append(("dup", (fd or "1") + ">&" + m.group(0))); i += m.end(); continue
                toks.append(("redir", "&>")); continue
            toks.append(("redir", (fd or "1") + op)); continue
        word = (word or "") + c; i += 1
    flush()
    return toks


def pipelines(toks):
    """[[stage, ...], ...] split on `;`/`&&` then `|`/`|&`; a stage is (words, targets)"""
    out, cur = [], []
    words, targets, pending = [], [], None
    for t in toks:
        if pending is not None:
            if t[0] != "word":
                raise Refuse("a redirect without a target")
            targets.append(t); pending = None; continue
        if t[0] == "word":
            words.append(t)
        elif t[0] == "redir":
            pending = t[1]
        elif t[0] == "dup":
            pass                                       # 2>&1, >&2: no file is named
        else:
            cur.append((words, targets)); words, targets = [], []
            if t[1] in (";", "&&"):
                out.append(cur); cur = []
    if pending is not None:
        raise Refuse("a redirect without a target")
    cur.append((words, targets))
    out.append(cur)
    # a trailing `;` leaves one empty pipeline behind; any other empty stage is an error
    if len(out) > 1 and out[-1] == [([], [])]:
        out.pop()
    for p in out:
        for words, targets in p:
            if not words:
                raise Refuse("an empty command")
    return out


def under(path, root):
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def target_ok(tok, roots, cwd):
    value, expands = tok[1], tok[2]
    if expands:
        m = re.fullmatch(r"\$(HOME|\{HOME\})(/[^$]*)?", value)
        if not m or not HOME:
            raise Refuse("a redirect target nobody can resolve")
        value = HOME + (m.group(2) or "")
    elif value == "~" or value.startswith("~/"):
        value = HOME + value[1:]
    if not os.path.isabs(value):
        if not cwd or not os.path.isabs(cwd):
            raise Refuse("a relative redirect target")
        value = os.path.join(cwd, value)
    real = os.path.realpath(value)
    if real == "/dev/null":
        return
    if not any(under(real, r) for r in roots):
        raise Refuse("a redirect outside the worktree and the worker's herd directory")


def stage_text(words):
    for w in words:
        value = w[1]
        if BAD_ASSIGN.match(value) and value != "GIT_EDITOR=true":
            raise Refuse("an assignment to " + value.split("=", 1)[0])
    first = words[0][1]
    for w in words:
        if w[2] and first not in ("echo", "printf") and not re.fullmatch(r"\$(HOME|\{HOME\})(/[^$]*)?", w[1]):
            raise Refuse("an expansion outside echo/printf")
    return " ".join(w[1] for w in words)


def judge(cmd, roots, cwd):
    """raises Refuse, or returns when every segment is safe"""
    if "$(" in cmd or "`" in cmd:
        raise Refuse("command substitution")
    if any(re.search(v, cmd) for v in VETO):
        raise Refuse("a vetoed option")
    ps = pipelines(lex(cmd))
    if sum(len(p) for p in ps) > 8:
        raise Refuse("more than eight segments")
    for p in ps:
        for k, (words, targets) in enumerate(p):
            s = stage_text(words)
            if any(re.search(v, s) for v in VETO):
                raise Refuse("a vetoed option")
            for t in targets:
                target_ok(t, roots, cwd)
            if k == 0:
                if not any(re.fullmatch(r, s) for r in SAFE) and not readonly_ok(words):
                    raise Refuse("a command not on the safe table")
            elif not any(re.fullmatch(r, s) for r in READERS) or any(re.search(v, s) for v in READER_VETO):
                raise Refuse("a pipe stage that is not a read-only filter")


def roots_for(worker, worktree):
    roots = [os.path.realpath(os.path.join(herd_dir(), worker))]
    if worktree:
        wt = os.path.realpath(worktree)
        if wt not in ("/", os.path.realpath(HOME or "/"), os.path.realpath(herd_dir())):
            roots.append(wt)
    return roots


def verdict(text, worker, worktree):
    """(line, exit status)"""
    kind, what = parse_prompt(text)
    if kind == "OTHER":
        return "BLOCKED " + clean(what), 1, "not a shell prompt"
    if kind == "NOPROMPT":
        return "NOPROMPT", 2, ""
    cmd, cwd = what
    try:
        judge(cmd, roots_for(worker, worktree), cwd if cwd != "." else None)
    except Refuse as e:
        return "BLOCKED " + clean(cmd), 1, str(e)
    return "SAFE " + clean(cmd), 0, ""


def main_verdict(argv):
    if not argv or not NAME_RE.fullmatch(argv[0]):
        print("usage: herd-watch.sh verdict <worker> [--worktree PATH]  (pane text on stdin)", file=sys.stderr)
        return 2
    worker, worktree, rest = argv[0], None, argv[1:]
    while rest:
        if rest[0] == "--worktree" and len(rest) > 1:
            worktree, rest = rest[1], rest[2:]
        else:
            print("herd-watch: unknown argument: " + clean(rest[0], 80), file=sys.stderr)
            return 2
    line, rc, why = verdict(sys.stdin.read(), worker, worktree)
    print(line)
    if why:
        print("herd-watch: " + why, file=sys.stderr)
    return rc


# ------------------------------------------------------------------ one pass

NOTIFIED = ("REPORT:", "PROMPT:", "RESUMED:", "STUCK:", "PUBLISHER:")
TARGET_OUT = False                 # the --notify pane is logged out this pass: type nothing


def emit(line):
    print(line, flush=True)
    target = os.environ.get("HERD_WATCH_NOTIFY", "")
    if target and NAME_RE.fullmatch(target) and line.startswith(NOTIFIED) and not TARGET_OUT:
        if coord_prompt(target, line)[0] == 0:         # a down pane is not our failure
            typed(os.path.join(herd_dir(), ".watch"), target, line)


HERDR_BIN = "herdr"                # `input-clear` takes appl-add.sh's herdr; a pass uses PATH's


def herdr(*args, timeout=60):
    try:
        r = subprocess.run([HERDR_BIN] + list(args), capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout
    except (OSError, subprocess.SubprocessError):
        return 1, ""


# ------------------------------------------------------------------ the coordinator's input box
#
# Owner ruling 20261029T130410Z: a prompt the coordinator's hook blocks stays in its input
# box, and the next line typed was glued to it, so every later event was blocked too and the
# coordinator went deaf. Before every prompt to the --notify pane (and appl-add.sh's wake,
# through `herd-watch.sh input-clear`), the box is read; text left there is deleted with
# backspaces only, logged `input-cleared <target> <n>`, and only the events recognised in it
# are typed again, one prompt each, RESEND_GAP seconds apart. Nothing else of it is typed.

CLEAR_EXTRA = 20                   # backspaces past the box's length: a row padding miscount
CLEAR_MAX = 200                    # backspaces in one send-keys call
RESEND_GAP = "5"                   # seconds between two prompts the guard types
COORD_PANE_ID = None               # the --notify pane's pane_id, once a listing named it
BOX_REPORT = re.compile(r"REPORT: ([a-z][a-z0-9_-]{0,31}) wrote report\.md")
BOX_INTAKE = re.compile(r"intake (/[A-Za-z0-9/._-]+)")
BOX_INTAKE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,124}\.md")
PLAIN_PANE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")


def box_text(screen):
    """the text of the last input box drawn on a visible screen -- the rows between its top
    bar and its bottom bar, the side bars, the prompt marker and each row's padding taken
    off -- or None when no box is drawn there. Scrollback above the box is never box text."""
    rows = screen.split("\n")
    corner_top, corner_bottom, side, marker = chr(0x256D), chr(0x2570), chr(0x2502), chr(0x276F)
    bottom = next((i for i in range(len(rows) - 1, -1, -1) if rows[i].lstrip().startswith(corner_bottom)), None)
    if bottom is None:
        return None
    top = next((i for i in range(bottom - 1, -1, -1) if rows[i].lstrip().startswith(corner_top)), None)
    if top is None or top + 1 >= bottom:
        return None
    out = []
    for k, row in enumerate(rows[top + 1:bottom]):
        s = row.strip()
        if not s.startswith(side):
            return None
        s = s[1:]
        if s.endswith(side):
            s = s[:-1]
        if k == 0:
            m = re.match(r" ?(?:>|" + marker + r")(?: |$)", s)
            if m is None:
                return None
            s = s[m.end():]
        else:
            s = s[3:] if s.startswith("   ") else s.lstrip(" ")
        out.append(s.rstrip())
    return "\n".join(out)


def lregular(p):
    try:
        return stat.S_ISREG(os.lstat(p).st_mode)
    except OSError:
        return False


def box_events(text, herd):
    """the lines of the box that are coordinator events this herd knows, in box order: a
    `REPORT: <w> wrote report.md` whose <w>/report.md is a regular file, and an `intake
    <path>` naming a regular file directly under coordinator/intake. Each once."""
    idir = os.path.join(herd, "coordinator", "intake")
    out = []
    for ln in text.split("\n"):
        s = ln.strip()
        m = BOX_REPORT.fullmatch(s)
        if m:
            wdir = os.path.join(herd, m.group(1))
            ok = (NAME_RE.fullmatch(m.group(1)) is not None and not os.path.islink(wdir)
                  and lregular(os.path.join(wdir, "report.md")))
        else:
            m = BOX_INTAKE.fullmatch(s)
            p = m.group(1) if m else ""
            ok = (m is not None and BOX_INTAKE_NAME.fullmatch(os.path.basename(p)) is not None
                  and os.path.isdir(idir) and os.path.realpath(os.path.dirname(p)) == os.path.realpath(idir)
                  and lregular(p))
        if ok and s not in out:
            out.append(s)
    return out


def pause():
    """RESEND_GAP seconds through HERD_WATCH_SLEEP_BIN (an executable run with the seconds),
    else sleep"""
    try:
        subprocess.run([os.environ.get("HERD_WATCH_SLEEP_BIN") or "sleep", RESEND_GAP], stdin=subprocess.DEVNULL,
                       capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        pass


def clear_input(target, then):
    """the guard (see above), run before `then` is typed into <target>. A box herdr cannot
    read, or an empty one, is left as it is."""
    pane = COORD_PANE_ID or target
    rc, screen = herdr("pane", "read", pane, "--source", "visible", timeout=30)
    text = box_text(screen) if rc == 0 else None
    if not text:
        return
    keys = ["backspace"] * (len(text) + CLEAR_EXTRA)
    for i in range(0, len(keys), CLEAR_MAX):
        if herdr("pane", "send-keys", pane, *keys[i:i + CLEAR_MAX], timeout=30)[0] != 0:
            break
    herd = herd_dir()
    coord_log(herd, target + " " + str(len(text)), clock(), "input-cleared")
    sent = 0
    for ev in box_events(text, herd):
        if ev == then:
            continue                                   # typed next anyway
        if sent:
            pause()
        herdr("agent", "prompt", target, ev, timeout=30)
        sent += 1
    if sent:
        pause()


def coord_prompt(target, line, timeout=30):
    """`herdr agent prompt <target> <line>` to the coordinator, its input box cleared first"""
    clear_input(target, line)
    return herdr("agent", "prompt", target, line, timeout=timeout)


def main_input_clear(argv):
    """herd-watch.sh input-clear <herdr> <pane> <line>: the guard alone, for appl-add.sh's
    wake, before it types <line>. Exit 0 whatever the box held; 2 is usage."""
    global HERDR_BIN, COORD_PANE_ID
    if len(argv) != 3 or not argv[0] or not PLAIN_PANE.fullmatch(argv[1]):
        print("usage: herd-watch.sh input-clear <herdr> <pane> <line>", file=sys.stderr)
        return 2
    HERDR_BIN, target = argv[0], argv[1]
    for r in listing("agent") or []:
        pid = r.get("pane_id")
        if target in (r.get("name"), pid) and isinstance(pid, str) and PLAIN_PANE.fullmatch(pid):
            COORD_PANE_ID = pid
            break
    clear_input(target, argv[2])
    return 0


def listing(kind):
    """the rows of `herdr <kind> list`, or None when herdr did not answer"""
    rc, out = herdr(kind, "list")
    if rc != 0:
        return None
    try:
        rows = json.loads(out).get("result", {}).get(kind + "s")
    except (ValueError, AttributeError):
        return None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else None


def word(v):
    """One state word for the roll call: herdr's agent_status, or `logged-out` -- the one
    value with a hyphen, this watcher's own for a pane whose last reply is a logout (L1)."""
    return v if isinstance(v, str) and (v == LOGOUT_KIND or re.fullmatch(r"[a-z_]{1,20}", v)) else "?"


def detail(watch, w, text):
    with open(os.path.join(watch, w + ".detail"), "a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + text.replace("\n", " ") + "\n")


def read_file(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def write_file(p, text):
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


def load_sibling(name):
    """<name>.py beside this script, by absolute path (`-I` keeps the directory off
    sys.path), compiled from its source: no bytecode is read or written"""
    import types
    path = os.path.join(os.environ["HERD_WATCH_HERE"], name + ".py")
    mod = types.ModuleType(name)
    mod.__file__ = path
    with open(path, "rb") as f:
        exec(compile(f.read(), path, "exec"), mod.__dict__)
    return mod


def ledger_event(herd, event, w):
    """one `stuck`, `dead` or `respawn` line naming <w> in $HERD_DIR/coordinator/runs.jsonl
    through run_ledger.py beside this script (never a symlinked one). Best effort: a ledger
    that refuses the line or cannot be written never changes what the pass does or prints."""
    try:
        path = os.path.join(os.environ.get("HERD_WATCH_HERE", ""), "run_ledger.py")
        if os.path.islink(path) or not os.path.isfile(path):
            return
        load_sibling("run_ledger").append(event=event, intake_id="", worker=w, keys={},
                                          herd_dir=herd)
    except Exception:                                    # noqa: BLE001 -- the ledger never blocks a pass
        pass


# The one reader and the one writer of a name in a worker's herd dir (a FIFO, a symlink or
# a hard link may sit there), shared with appl-hook.sh's close-requested marker.
_herd_files = load_sibling("herd_files")
read_regular = _herd_files.read_regular
replace_regular = _herd_files.replace_regular

# The read-only half of the safe table: readonly-commands.tsv beside this script, through its
# one loader. A list that does not load leaves it EMPTY -- every such command is BLOCKED, the
# coordinator answers it -- never a partial table.
try:
    _readonly = load_sibling("readonly_commands")
    READONLY = _readonly.load(os.path.join(os.environ["HERD_WATCH_HERE"], "readonly-commands.tsv"))
except (OSError, ValueError, SyntaxError) as _e:
    print("herd-watch: the read-only command list does not load, so none of it is SAFE: "
          + clean(str(_e), 200), file=sys.stderr)
    _readonly, READONLY = None, []


# Readers the cursor approval box alone may answer (intake 20261019T163318Z), never added to
# the list above, so no harness profile renders them: cmp and diff only as plain comparisons
# of paths, every flag refused (`-*` is the prefix `-`), so no option that writes output
# (diff --output, an -o form, a bundled cluster) is ever answered. Empty when the list did
# not load, as everything else here.
BOX_READONLY = [] if _readonly is None else [
    _readonly.Entry(("cmp",), ("-*",)),
    _readonly.Entry(("diff",), ("-*",)),
]


def readonly_ok(words, extra=()):
    """The stage starts with a listed command's words, and no later word is a flag that
    command refuses. Redirect targets, expansions and the git VETO are judged as for any
    stage; a pipe stage after it is still a READERS filter. extra entries count as listed."""
    values = [w[1] for w in words]
    for e in list(READONLY) + list(extra):
        n = len(e.words)
        if tuple(values[:n]) == e.words:
            if not any(_readonly.refuses(e, v) for v in values[n:]):
                return True
    return False


def read_pane(w):
    rc, out = herdr("agent", "read", w, "--source", "recent-unwrapped", "--lines", "80")
    if rc != 0:
        rc, out = herdr("agent", "read", w)
    return out if rc == 0 else ""


def linked_worktree(agent):
    """the agent's cwd as herdr reports it, when that is a linked worktree"""
    cwd = (agent or {}).get("cwd")
    if isinstance(cwd, str) and os.path.isabs(cwd) and os.path.isfile(os.path.join(cwd, ".git")):
        return cwd
    return None


# A runtime's dialogs (folder trust, auto mode's teach dialog, ...) are known ONLY to its
# adapter beside herd-spawn.sh, scripts/trust/<harness>.sh: `--recognize` reads a pane's text
# on stdin and prints one kind word. This watcher carries no runtime's dialog text; it asks
# every adapter there (herdr's listing names no harness, so none is chosen by name) and keeps
# the first word that is a kind. It only NAMES the dialog -- `dialog <kind> <w>` on the
# WORKERS: line and one STUCK: per stop, with no pane byte copied -- and never answers it: a
# listed repository's dialog is answered at spawn, behind the dispatch gate, and anything
# left at it is the operator's, or the parked backstop's (stalls()).
KIND_RE = re.compile(r"[a-z][a-z0-9-]{0,31}")
DIALOG_STATUSES = ("blocked", "done", "idle")


def adapters():
    d = os.path.join(os.environ.get("HERD_WATCH_HERE", ""), "trust")
    try:
        names = sorted(os.listdir(d))
    except OSError:
        return []
    out = []
    for n in names:
        p = os.path.join(d, n)
        if n.endswith(".sh") and not os.path.islink(p) and os.path.isfile(p):
            out.append(p)
    return out


_KINDS = {}                        # pane text -> kind word, so one pass asks the adapters once


def dialog_kind(pane):
    """the kind word an adapter gives this pane, or None; the adapter only recognizes here"""
    if not pane:
        return None
    if pane not in _KINDS:
        _KINDS[pane] = _ask_adapters(pane)
    return _KINDS[pane]


def _ask_adapters(pane):
    for p in adapters():
        try:
            r = subprocess.run(["bash", p, "--recognize"], input=pane.encode("utf-8", "replace"),
                               capture_output=True, timeout=30)
        except (OSError, subprocess.SubprocessError):
            continue
        out = r.stdout.decode("ascii", "replace")
        if r.returncode == 0 and out.endswith("\n") and KIND_RE.fullmatch(out[:-1]):
            return out[:-1]
    return None


def dialog_stuck(w, kind, watch):
    """a worker at a recognized dialog: one STUCK line per stop, nothing typed"""
    p = os.path.join(watch, w + ".dialog")
    if read_file(p) != kind:
        detail(watch, w, "DIALOG " + kind)
        emit("STUCK: %s is at a dialog (%s) -- answer it in the pane yourself" % (w, kind))
        write_file(p, kind)


def dialog_left(w, watch):
    """not at a dialog this pass: the next stop at one is a new stop"""
    p = os.path.join(watch, w + ".dialog")
    if os.path.lexists(p):
        os.unlink(p)


BRIEF_MAX = 1 << 20                # bytes: a brief.md larger than this is never read


def own_brief_lines(w):
    """The whitespace-normalised lines of $HERD_DIR/<w>/brief.md, w's own brief only. A
    brief that is a symlink, of another owner, not a regular file or too large gives none."""
    path = os.path.join(herd_dir(), w, "brief.md")
    try:
        st = os.lstat(path)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_size > BRIEF_MAX:
            return set()
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return set()
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            return set()
        text = os.read(fd, BRIEF_MAX).decode("utf-8", "replace")
    except OSError:
        return set()
    finally:
        os.close(fd)
    return {n for n in (" ".join(line.split()) for line in text.splitlines()) if n}


def cursor_allowlist_miss(w, pane):
    """True when the pane is showing Cursor's "Not in allowlist" menu and w was spawned
    on the cursor harness. A claude pane never matches."""
    if "Not in allowlist" not in pane[-2500:]:
        return False
    return spawn_harness(herd_dir(), w) == "cursor"


def norm_cmd(cmd):
    return " ".join((cmd or "").split())


def owner_allow_path():
    """The machine file of commands the owner has let a cursor pane run once.
    APPL_CURSOR_OWNER_ALLOW overrides it (the tests point at a throwaway file)."""
    override = os.environ.get("APPL_CURSOR_OWNER_ALLOW")
    if override:
        return override
    home = os.environ.get("HOME", "")
    if not home:
        return ""
    return os.path.join(home, ".config", "appl", "cursor-owner-allow")


# A star on these bases would run arbitrary code or open a network client.
# git push is not here: the publisher's push is `git push` with whatever ref
# the hand-off names, so one approval stores Shell(git:push *).
UNREMEMBERED_BASES = {
    "curl", "wget", "ssh", "scp", "nc", "ncat", "sudo", "doas",
    "python", "python2", "python3", "node", "perl", "ruby", "php",
    "bash", "sh", "zsh", "dash", "env",
}
SHELL_META = set(";|&<>`$()\\")


# git options that take the next word as a value when it is not `--opt=value`.
_GIT_OPTS_WITH_ARG = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix"}


def git_subcommand(words):
    """The subcommand after `git` and its leading options. Empty when there
    is none. `git --git-dir=/path status` and `git -C path status` are both
    `status`."""
    i = 1
    while i < len(words):
        word = words[i]
        if not word.startswith("-"):
            return word
        i += 1
        bare = word.split("=", 1)[0]
        if "=" not in word and bare in _GIT_OPTS_WITH_ARG and i < len(words):
            i += 1
    return ""


def allow_rule(cmd):
    """The Shell rule one owner approval stores. Arguments are `*`. A git
    subcommand stays fixed (`git push origin main` -> `Shell(git:push *)`),
    so a later push of another ref matches and `git config` does not. A pipe,
    chain, redirect or substitution is None: `*` would swallow it."""
    n = norm_cmd(cmd)
    if not n or len(n) > 4000:
        return None
    if any(unicodedata.category(ch) in ("Cc", "Cf") for ch in n):
        return None
    if any(c in n for c in SHELL_META):
        return None
    words = n.split(" ")
    base = words[0]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*", base):
        return None
    if base in UNREMEMBERED_BASES:
        return None
    if base == "git":
        sub = git_subcommand(words)
        if not sub or sub == "config":
            return None
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", sub):
            return None
        return "Shell(git:%s *)" % sub
    return "Shell(%s:*)" % base


def rule_matches(rule, cmd):
    """True when cmd is one simple command covered by a stored Shell rule.
    `Shell(git:push *)` matches `git push` and `git push origin main`.
    `Shell(rg:*)` matches `rg` and `rg -n foo`."""
    if allow_rule(cmd) is None or not (rule.startswith("Shell(") and rule.endswith(")")):
        return False
    body = rule[len("Shell("):-1]
    base, sep, args = body.partition(":")
    if not sep:
        return False
    n = norm_cmd(cmd)
    if args == "*":
        return n == base or n.startswith(base + " ")
    if base == "git" and args.endswith(" *"):
        return allow_rule(cmd) == rule
    if args.endswith(" *"):
        prefix = (base + " " + args[:-2]).strip()
        return n == prefix or n.startswith(prefix + " ")
    return False


def read_owner_allows():
    """The Shell rules in the owner file, or none when the file is missing,
    a symlink, another user's, or larger than 1 MiB."""
    path = owner_allow_path()
    if not path:
        return set()
    try:
        st = os.lstat(path)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_size > (1 << 20):
            return set()
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return set()
    try:
        text = os.read(fd, 1 << 20).decode("utf-8", "replace")
    except OSError:
        return set()
    finally:
        os.close(fd)
    out = set()
    for line in text.splitlines():
        rule = line.strip()
        if rule.startswith("Shell(") and rule.endswith(")") and "\n" not in rule:
            out.add(rule)
    return out


def owner_granted(cmd):
    return any(rule_matches(rule, cmd) for rule in read_owner_allows())


def remember_owner_command(cmd):
    """Append the argument-star Shell rule to the owner file (mode 600). True
    when the file now contains it. A symlink at the path or its parent is left
    untouched. python3 -c and a chain append nothing."""
    rule = allow_rule(cmd)
    if not rule:
        return False
    path = owner_allow_path()
    if not path:
        return False
    parent = os.path.dirname(path)
    try:
        os.makedirs(parent, 0o700, exist_ok=True)
    except OSError:
        return False
    if os.path.islink(parent) or os.path.islink(path):
        return False
    if rule in read_owner_allows():
        return True
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, flags, 0o600)
    except OSError:
        return False
    try:
        os.write(fd, (rule + "\n").encode("utf-8"))
    finally:
        os.close(fd)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return True


def observe_owner_grant(w, pane, watch):
    """A command this pass left on Cursor's menu, which the owner then let run,
    is appended to the owner file. Skip (the 'tell the agent' box) stores nothing.
    A menu still on screen stores nothing yet."""
    askp = os.path.join(watch, w + ".ask")
    cmd = norm_cmd(read_file(askp) or "")
    if not cmd:
        return
    tail = pane[-800:]
    if ("Not in allowlist" in tail or "Run this command?" in tail
            or "Waiting for approval" in tail):
        return
    if "Tell the agent what to do instead" in tail:
        detail(watch, w, "ASK-SKIPPED " + cmd)
        os.unlink(askp)
        return
    if cmd not in norm_cmd(pane):
        return
    rule = allow_rule(cmd)
    if rule and remember_owner_command(cmd):
        detail(watch, w, "GRANTED " + rule)
    else:
        detail(watch, w, "ASK-UNSTORED " + cmd)
    try:
        os.unlink(askp)
    except OSError:
        pass


def in_brief(w, pane, why):
    """The normalised command of a cursor "Run this command?" prompt refused only for not
    being on the safe table, when it is one simple command that equals a whole line of w's
    own brief.md after whitespace normalisation; else None. A cursor prompt carries "Not in
    allowlist" and w's spawn record names harness=cursor; a claude prompt never comes here.
    A cursor command prompt is decided in approve_cursor before this is asked.
    A miss returns None. approve() does not send y for it and does not store a rule."""
    if why != "a command not on the safe table" or "Not in allowlist" not in pane[-2500:]:
        return None
    if spawn_harness(herd_dir(), w) != "cursor":
        return None
    kind, what = parse_prompt(pane)
    if kind != "CMD":
        return None
    cmd = " ".join(what[0].split())
    try:
        ps = pipelines(lex(cmd))
    except Refuse:
        return None
    if len(ps) != 1 or len(ps[0]) != 1 or ps[0][0][1]:
        return None
    return cmd if cmd and cmd in own_brief_lines(w) else None


_DATE_SUB = re.compile(r"\$\(date -u \+%[-A-Za-z0-9:%._+]+\)")


def coordinator_log_append(pane):
    """True when this pane asks to append one printf or echo line to
    coordinator.log and the only substitution is $(date -u +FORMAT)."""
    if "Run this command?" not in pane or "Not in allowlist" not in pane[-2500:]:
        return False
    kind, what = parse_prompt(pane)
    if kind != "CMD":
        return False
    cmd = what[0]
    if not cmd or len(cmd) > 2000 or "`" in cmd or "\n" in cmd or cmd.count("$(") != 1:
        return False
    found = _DATE_SUB.search(cmd)
    if found is None:
        return False
    rest = cmd[:found.start()] + " " + cmd[found.end():]
    if rest.count(">>") != 1:
        return False
    left, right = rest.split(">>", 1)
    body = left + right
    # '%s\n' is the one backslash this line may carry
    if any(c in body for c in "$`;|&<>") or "\\" in body.replace("'%s\\n'", ""):
        return False
    left = " ".join(left.split())
    right = right.strip()
    if len(right) >= 2 and right[0] == "'" and right[-1] == "'":
        right = right[1:-1]
    if not re.fullmatch(r"/[-A-Za-z0-9._+/]+", right):
        return False
    if not left or left.split(" ", 1)[0] not in ("printf", "echo"):
        return False
    coord = os.path.join(herd_dir(), "coordinator")
    log = os.path.join(coord, "coordinator.log")
    parent = os.path.dirname(right)
    if os.path.islink(coord) or os.path.islink(log) or os.path.islink(parent):
        return False
    return os.path.realpath(right) == os.path.realpath(log)


_OLD_MENU_RUN = re.compile(r"^\s*(?:->\s*)?Run \(once\) \(y\)\s*$", re.M)
_OLD_MENU_SKIP = re.compile(r"^\s*(?:->\s*)?Skip \(esc or n\)\s*$", re.M)


def old_cursor_menu(pane):
    """True when the screen's UI lines are the old cursor menu: one line that is
    "Run (once) (y)" and one that is "Skip (esc or n)", each alone on its line. The
    same words inside a command line are not UI lines."""
    tail = pane[-2500:]
    return bool(_OLD_MENU_RUN.search(tail) and _OLD_MENU_SKIP.search(tail))


def _clear_prompt_state(watch, w):
    for suffix in (".last", ".ask"):
        p = os.path.join(watch, w + suffix)
        if os.path.lexists(p):
            try:
                os.unlink(p)
            except OSError:
                pass


def _send_key(w, watch, key, line):
    """Send y or n. Never tab, never shift+tab, never a follow-up text. line is the
    detail text."""
    if herdr("agent", "send-keys", w, key)[0] != 0:
        return False
    if key != "n":
        emit("APPROVED: %s (detail in .watch/%s.detail)" % (w, w))
    detail(watch, w, line)
    _clear_prompt_state(watch, w)
    return True


def _cursor_refuse(w, watch, pane, key, why):
    """A cursor refusal. On the old cursor menu ("Run (once) (y)" / "Skip (esc or n)"
    as UI lines) it is n, and the prompt counts as answered. Anywhere else no key at
    all (intake 20261020T113041Z): one BLOCKED detail line and one PROMPT per key,
    deduplicated by .watch/<w>.last, and False, so the park clock keeps running."""
    if old_cursor_menu(pane):
        return _send_key(w, watch, "n", "refused " + key + "  [" + why + "]")
    last = os.path.join(watch, w + ".last")
    key = "CURSOR " + key
    if key != read_file(last):
        detail(watch, w, "BLOCKED " + key + "  [" + why + "]")
        emit("PROMPT: %s is waiting -- read the pane yourself before answering" % w)
        write_file(last, key)
    return False


def _one_stage(cmd):
    """The single stage of a simple command, or None when it is not one stage."""
    if not cmd or "$(" in cmd or "`" in cmd:
        return None
    try:
        ps = pipelines(lex(cmd))
    except Refuse:
        return None
    if len(ps) != 1 or len(ps[0]) != 1:
        return None
    words, targets = ps[0][0]
    if targets or not words:
        return None
    return words


def unanswerable(cmd):
    """A shape policy refuses at once, even when the brief names it: a pipe, a
    chain, a redirect, a substitution, python3 -c, curl, ssh, sudo or git config.
    Anything lex will not take as one simple stage is refused too."""
    words = _one_stage(cmd)
    if words is None:
        return True
    base = words[0][1]
    if base in ("curl", "ssh", "sudo"):
        return True
    if base == "python3" and len(words) > 1 and words[1][1] == "-c":
        return True
    if base == "git" and git_subcommand([t[1] for t in words]) == "config":
        return True
    return False


def on_safe_table(cmd):
    """True when cmd is one simple command matching the SAFE regex list."""
    words = _one_stage(cmd)
    if words is None:
        return False
    try:
        text = stage_text(words)
    except Refuse:
        return False
    if any(re.search(v, cmd) for v in VETO) or any(re.search(v, text) for v in VETO):
        return False
    return any(re.fullmatch(r, text) for r in SAFE)


def readonly_inside(cmd, worktree, extra=()):
    """A read-only command whose path arguments all stay inside the linked worktree.
    The pane's `in <dir>` text is not a root. No worktree means no. extra entries
    count as read-only for this call only."""
    if not worktree:
        return False
    words = _one_stage(cmd)
    if words is None or not readonly_ok(words, extra):
        return False
    try:
        if any(re.search(v, cmd) for v in VETO):
            return False
        stage_text(words)
    except Refuse:
        return False
    root = os.path.realpath(worktree)
    values = [t[1] for t in words]
    rest = []
    for entry in list(READONLY) + list(extra):
        n = len(entry.words)
        if tuple(values[:n]) == entry.words:
            rest = values[n:]
            break
    for value in rest:
        if value.startswith("-"):
            continue
        if value == "~" or value.startswith("~/") or value.startswith("$"):
            return False
        path = value if os.path.isabs(value) else os.path.join(worktree, value)
        if not under(os.path.realpath(path), root):
            return False
    return True


def write_path_of(pane):
    """The path on a `Write to this file?` dialog, or None when this is not one."""
    if "Write to this file?" not in pane or "Run this command?" in pane:
        return None
    kind, what = parse_prompt(pane)
    prefix = "Write to this file? "
    if kind != "OTHER" or not isinstance(what, str) or not what.startswith(prefix):
        return ""
    return what[len(prefix):]


def cursor_write_stays_prompt(path):
    """True when a Write dialog path stays a prompt even inside this worker's directory.

    report.md and report.md.notes are the two files a seat may write. brief.md,
    permissions.json, role, and the prefix lookalikes report.md.other and
    report.md.notesx are not those files. A path that still contains a ".."
    segment is judged as shown: resolving it would hide a climb into another
    worker's report, or a second spelling of this worker's own file."""
    if not path:
        return False
    if ".." in path.split(os.sep):
        return True
    base = os.path.basename(path.rstrip(os.sep))
    if base in ("brief.md", "permissions.json", "role"):
        return True
    if base.startswith("report.md") and base not in ("report.md", "report.md.notes"):
        return True
    return False


def write_inside_own(w, path):
    """True when path is inside this worker's herd dir or its review checkout.
    A relative path is the feature worktree, which is not a write target.
    cursor_write_stays_prompt names the paths inside the herd dir that stay a
    prompt; this check does not fold those away."""
    if not path or not os.path.isabs(path) or "\n" in path or "\x00" in path:
        return False
    herd = herd_dir()
    roots = (
        os.path.realpath(os.path.join(herd, w)),
        os.path.realpath(os.path.join(herd, "review", w)),
    )
    real = os.path.realpath(path)
    return any(under(real, root) for root in roots)


def _gap_filed(idir, cmd, day):
    """True when today's P1 rules-parity intake for this normalised command is already there."""
    try:
        names = os.listdir(idir)
    except OSError:
        return False
    want_day = "day: " + day
    for name in names:
        if not INTAKE_RE.fullmatch(name):
            continue
        path = os.path.join(idir, name)
        try:
            st = os.lstat(path)
        except OSError:
            continue
        if not stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode) or st.st_size > (1 << 20):
            continue
        try:
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        except OSError:
            continue
        try:
            text = os.read(fd, 1 << 20).decode("utf-8", "replace")
        except OSError:
            text = ""
        finally:
            os.close(fd)
        lines = text.splitlines()
        if "P1" in text and "rules-parity" in text and want_day in lines and cmd in lines:
            return True
    return False


def file_rule_gap(cmd):
    """One P1 rules-parity intake per normalised command text per UTC day of the watcher clock.
    The intake names that text, never the raw spacing. A second prompt the same day files none."""
    now = clock()
    day = time.strftime("%Y-%m-%d", time.gmtime(now))
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now))
    herd = herd_dir()
    coord = os.path.join(herd, "coordinator")
    idir = os.path.join(coord, "intake")
    if os.path.islink(herd) or os.path.islink(coord) or os.path.islink(idir):
        return
    if _gap_filed(idir, cmd, day):
        return
    try:
        os.makedirs(idir, 0o700, exist_ok=True)
    except OSError:
        return
    if os.path.islink(idir) or not os.path.isdir(idir):
        return
    if _gap_filed(idir, cmd, day):
        return
    digest = hashlib.sha256((day + "\n" + cmd).encode("utf-8")).hexdigest()[:16]
    name = "%s-rules-parity-%s.md" % (stamp, digest)
    if not INTAKE_RE.fullmatch(name):
        return
    body = "id: %s\nfrom: herd-watch\nstatus: new\npriority: P1\nday: %s\n\nP1 rules-parity\n%s\n" % (
        stamp, day, cmd)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(os.path.join(idir, name), flags, 0o600)
    except OSError:
        return
    try:
        os.write(fd, body.encode("utf-8"))
    finally:
        os.close(fd)


CURSOR_TELL = "Tell the agent what to do instead (Enter to send, empty to skip, Esc to cancel)"
_BOX_ROW = re.compile(r"[ \t]*" + re.escape(chr(0x2502)) + r"(.*)" + re.escape(chr(0x2502)))
_BOX_CMD_START = re.compile(r" \$  (\S.*)")


def cursor_box(pane):
    """Intake 20261019T163318Z, widened by 20261020T113042Z. cursor-agent's approval box
    that repeats the pending command, read by its shape, or None when the pane is not that
    box. The last input row is two spaces, U+2192, one space, then what the row holds: the
    placeholder CURSOR_TELL when empty, else the characters already typed there (never the
    idle `Add a follow-up`, which is not this box). Above it, blank lines aside, the box: a
    bottom border row, the rows between the side bars, and a top border row. A command starts
    at a `<bar> $  <text>` row; each further row inside the box up to the next `$` row is a
    continuation of it, so a line of command text that looks like a border, or holds
    "Run this command?", is command text and never ends the box. Returns (cmd, held, top,
    last): cmd is the one command, or "" when the rows name more than one, or no `in <dir>`
    ends it; held is the typed text ("" for the placeholder); top and last are the box's
    first row and the input row. The `in <dir>` text is dropped, never used as a root."""
    mark = "  " + chr(0x2192) + " "
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?", "", pane or "")
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text)
    rows = text.splitlines()
    last = None
    for i, row in enumerate(rows):
        if cursor_row_text(row) is not None:
            last = i
    if last is None or not rows[last].startswith(mark):
        return None
    held = rows[last].rstrip()[len(mark):]
    if held == "Add a follow-up":
        return None
    if held == CURSOR_TELL:
        held = ""
    j = last - 1
    while j >= 0 and rows[j].strip() == "":
        j -= 1
    if j < 0 or not rows[j].strip().startswith(chr(0x2514)):
        return None
    j -= 1
    inner = []
    while j >= 0:
        m = _BOX_ROW.fullmatch(rows[j].rstrip())
        if not m:
            break
        inner.insert(0, m.group(1))
        j -= 1
    if not inner or j < 0 or not rows[j].strip().startswith(chr(0x250C)):
        return None
    top = j
    cmds = []
    for body in inner:
        m = _BOX_CMD_START.fullmatch(body.rstrip())
        if m:
            cmds.append([m.group(1)])
        elif cmds:
            cmds[-1].append(body.strip())
        else:
            return None
    joined = ["\n".join(c).rstrip() for c in cmds]
    if len(set(joined)) != 1:
        return "", held, top, last
    cmd, sep, where = joined[0].rpartition(" in ")
    if not sep or not cmd.strip() or not where.strip() or re.search(r"\s", where.strip()):
        return "", held, top, last
    return cmd.strip(), held, top, last


def cursor_box_command(pane):
    """The pending command of cursor_box's approval box ("" when it names no one command),
    or None when the pane is not that box."""
    box = cursor_box(pane)
    return None if box is None else box[0]


def cursor_question_ui(pane):
    """True when "Run this command?" is a UI line of the menu: a row outside cursor_box's
    box, and not inside a `$ <cmd>` whose closing `in <dir>` comes after it (the question
    in a pending command's own text is command text)."""
    q = "Run this command?"
    if q not in (pane or ""):
        return False
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?", "", pane or "")
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text)
    rows = text.splitlines()
    box = cursor_box(pane)
    closed = re.compile(r".* in (\.|\S+)$")
    for i, row in enumerate(rows):
        if q not in row:
            continue
        if box is not None and box[2] <= i <= box[3]:
            continue
        opened = False
        for k in range(i - 1, -1, -1):
            s = rows[k].strip()
            if closed.match(s):
                break
            if re.match(r"\$\s+", s):
                opened = True
                break
        if opened and any(closed.match(rows[k].strip()) for k in range(i + 1, len(rows))):
            continue
        return True
    return False


def approve_cursor_box(w, agent, watch, cmd, held=""):
    """The approval box that repeats the pending command. A read-only command whose
    paths all stay inside w's own linked worktree is y (triage-read). Anything else --
    a path outside it, a state-changing command, a pipe, a redirect, no linked worktree,
    no one command -- is one PROMPT per command and no key at all: on this box n is not
    the Run this command? menu's answer, and Enter would send the box. An input row that
    already holds typed characters (held) is logged once per command as BOX ROW DIRTY
    with their count, and the PROMPT says so."""
    if cmd and not unanswerable(cmd) and readonly_inside(cmd, linked_worktree(agent), BOX_READONLY):
        return _send_key(w, watch, "y", "APPROVED %s triage-read %s" % (w, clean(norm_cmd(cmd))))
    last = os.path.join(watch, w + ".last")
    key = "BOX " + clean(norm_cmd(cmd or ""))
    if key != read_file(last):
        detail(watch, w, "BLOCKED " + key + "  [the cursor approval box: not a read-only command inside the worktree]")
        if held:
            detail(watch, w, "BOX ROW DIRTY %d  [the box's input row already holds typed characters]" % len(held))
            emit("PROMPT: %s is waiting -- the box's input row is dirty, %d typed character(s); "
                 "read the pane yourself before answering" % (w, len(held)))
        else:
            emit("PROMPT: %s is waiting -- read the pane yourself before answering" % w)
        write_file(last, key)
    return False


def approve_cursor(w, agent, watch, pane):
    """Answer a cursor worker from policy. None when this pane is not a command
    prompt and not a write dialog, so the caller keeps the claude path. Never
    writes cursor-owner-allow. Judges the full parsed command, not clean()'s
    400-character display text."""
    menu = cursor_question_ui(pane)
    boxed = cursor_box(pane) if not menu else None
    if boxed is not None:
        return approve_cursor_box(w, agent, watch, boxed[0], boxed[1])
    if "Write to this file?" in pane and not menu:
        path = write_path_of(pane)
        if path and cursor_write_stays_prompt(path):
            return _cursor_refuse(w, watch, pane, "WRITE " + clean(path or ""),
                                  "refused write: not this worker's report.md or report.md.notes")
        if path and write_inside_own(w, path):
            return _send_key(w, watch, "y", "APPROVED %s herd-write %s" % (w, clean(path)))
        return _cursor_refuse(w, watch, pane, "WRITE " + clean(path or ""),
                              "refused write: outside the worker's herd dir and review checkout")
    if not menu:
        return None
    kind, what = parse_prompt(pane)
    if kind != "CMD":
        return _cursor_refuse(w, watch, pane, "UNPARSED", "refused unparsed: the prompt did not parse")
    cmd = what[0]
    shown = norm_cmd(cmd)
    if unanswerable(cmd):
        return _cursor_refuse(w, watch, pane, clean(shown), "refused: a shape policy never answers")
    if on_safe_table(cmd):
        return _send_key(w, watch, "y", "APPROVED %s triage-safe %s" % (w, clean(shown)))
    if readonly_inside(cmd, linked_worktree(agent)):
        return _send_key(w, watch, "y", "APPROVED %s triage-read %s" % (w, clean(shown)))
    named = in_brief(w, pane, "a command not on the safe table")
    if named is not None:
        sent = _send_key(w, watch, "y", "APPROVED %s in-brief %s" % (w, named))
        if sent:
            detail(watch, w, "rule-gap %s" % named)
            file_rule_gap(named)
        return sent
    return _cursor_refuse(w, watch, pane, clean(shown),
                          "refused: not safe, not read-only inside the worktree, not a brief line")


def approve(w, agent, watch, pane=None):
    """True when the pane's prompt was answered this pass (progress, not parking).
    A cursor worker is approve_cursor: policy only, no owner-allow write. A claude
    prompt is unchanged: y for a safe command, PROMPT for a blocked one. The
    coordinator log append is y only for the notify pane. tab and shift+tab are
    never sent."""
    if pane is None:
        pane = read_pane(w)
    if os.environ.get("HERD_WATCH_NOTIFY", "") == w and coordinator_log_append(pane):
        # one log line for this pane only; never a stored Shell(printf:*) rule
        detail(watch, w, "APPROVED %s coordinator-log" % w)
        if herdr("agent", "send-keys", w, "y")[0] == 0:
            emit("APPROVED: %s (detail in .watch/%s.detail)" % (w, w))
            last = os.path.join(watch, w + ".last")
            if os.path.exists(last):
                os.unlink(last)
            return True
        return False
    if spawn_harness(herd_dir(), w) == "cursor":
        decided = approve_cursor(w, agent, watch, pane)
        if decided is not None:
            return decided
    line, _, why = verdict(pane, w, linked_worktree(agent))
    last = os.path.join(watch, w + ".last")
    cmd = in_brief(w, pane, why) if line.startswith("BLOCKED ") else None
    if cmd is not None:
        # the same `y` the safe table sends; never tab, never shift+tab
        detail(watch, w, "APPROVED %s in-brief %s" % (w, clean(cmd)))
        if herdr("agent", "send-keys", w, "y")[0] == 0:
            emit("APPROVED: %s (detail in .watch/%s.detail)" % (w, w))
            if os.path.exists(last):
                os.unlink(last)
            return True
    elif line.startswith("SAFE "):
        detail(watch, w, line)
        if herdr("agent", "send-keys", w, "y")[0] == 0:
            emit("APPROVED: %s (detail in .watch/%s.detail)" % (w, w))
            if os.path.exists(last):
                os.unlink(last)
            return True
    elif cursor_allowlist_miss(w, pane) and line.startswith("BLOCKED "):
        # approve_cursor did not take this pane. Still no memory and no y.
        return _cursor_refuse(w, watch, pane, line[len("BLOCKED "):], "refused" + (": " + why if why else ""))
    elif cursor_allowlist_miss(w, pane):
        # The menu did not parse to a command. No key; n only on the old menu.
        return _cursor_refuse(w, watch, pane, "UNPARSED", "refused unparsed" + (": " + why if why else ""))
    elif line.startswith("BLOCKED "):
        key = line[len("BLOCKED "):]
        if key != read_file(last):
            detail(watch, w, line + ("  [" + why + "]" if why else ""))
            emit("PROMPT: %s is waiting -- read the pane yourself before answering" % w)
            write_file(last, key)
    elif read_file(last) != "NOPROMPT":
        detail(watch, w, "NOPROMPT " + clean(pane[-300:], 300))
        emit("PROMPT: %s is blocked and the prompt did not parse -- read the pane yourself" % w)
        write_file(last, "NOPROMPT")
    return False


def stuck(w, pane, watch):
    """a working session stuck reconnecting to its API for ten minutes or more"""
    hits = re.findall(r"Reconnecting to [^ ]+ \(attempt [0-9]+, [0-9]+s\)", "\n".join(pane.splitlines()[-12:]))
    if not hits:
        return
    s = hits[-1]
    secs = int(re.search(r"([0-9]+)s\)$", s).group(1))
    p = os.path.join(watch, w + ".stuck")
    if secs >= 600 and s != read_file(p):
        detail(watch, w, "STUCK " + clean(s))
        emit("STUCK: %s (reconnecting; detail in .watch/%s.detail)" % (w, w))
        write_file(p, s)


def capacity(w, phrase, watch):
    """dispatch-capacity.sh full "<phrase>: <worker>", once per signature"""
    sig = phrase + ": " + w
    p = os.path.join(watch, w + ".capacity")
    seen = (read_file(p) or "").splitlines()
    if sig in seen:
        return
    binp = os.environ.get("HERD_WATCH_CAPACITY_BIN") or os.path.join(
        os.environ.get("HERD_WATCH_HERE", ""), "dispatch-capacity.sh")
    try:
        subprocess.run(["bash", binp, "full", sig], capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return
    with open(p, "a", encoding="utf-8") as f:
        f.write(sig + "\n")


def rules_file(wdir):
    """(path, mtime) of the worker's own permissions.json, or None"""
    p = os.path.join(wdir, "permissions.json")
    try:
        if os.path.islink(wdir) or os.path.islink(p):
            return None
        st = os.stat(p)
    except OSError:
        return None
    if st.st_uid != os.getuid() or not os.path.isfile(p):
        return None
    return p, int(st.st_mtime)


def pane_of(agent, tab):
    for row in (agent, tab):
        v = (row or {}).get("pane_id")
        if isinstance(v, str) and PANE_RE.fullmatch(v):
            return v
    tab_id = (tab or {}).get("tab_id")
    if not isinstance(tab_id, str):
        return None
    panes = listing("pane") or []
    ids = [r.get("pane_id") for r in panes if r.get("tab_id") == tab_id]
    ids = [v for v in ids if isinstance(v, str) and PANE_RE.fullmatch(v)]
    return ids[0] if len(ids) == 1 else None


def one_permission_mode(args):
    """True when the claude args hold exactly one --permission-mode token (either spelling)
    and it is the auto pair. Checked before every restart: a second token -- a later,
    looser mode, say -- would decide the mode, so such an argv is never started."""
    modes = [i for i, a in enumerate(args)
             if a == "--permission-mode" or a.startswith("--permission-mode=")]
    return (len(modes) == 1 and args[modes[0]] == "--permission-mode"
            and args[modes[0] + 1:modes[0] + 2] == ["auto"])


def resume(w, tab, agent, pane, herd, watch, now):
    wdir = os.path.join(herd, w)
    status = (agent or {}).get("agent_status")
    # herdr says `done` both for a claude that ended its turn (still at its input:
    # interactive_ready) and for one whose process is gone; only the second is restarted
    restart = agent is None or (status == "done" and agent.get("interactive_ready") is not True)
    low = "\n".join(pane.splitlines()[-20:]).lower()
    phrase = next((ph for ph in PHRASES if ph in low), None)
    if not restart and not (phrase and status in ("idle", "done")):
        return
    if restart and tab is None:
        return                                 # no tab, no pane to restart in
    if phrase:
        capacity(w, phrase, watch)
    rules = rules_file(wdir)
    spath = os.path.join(watch, w + ".resume")
    try:
        state = json.loads(read_file(spath) or "{}")
    except ValueError:
        state = {}
    spawn = rules[1] if rules else None
    if not isinstance(state, dict) or state.get("spawn") != spawn:
        state = {"count": 0, "last": 0, "spawn": spawn}   # a new spawn starts a new budget
    count, last = int(state.get("count", 0)), int(state.get("last", 0))
    if count >= len(DELAYS) or (count and now - last < DELAYS[count]):
        return
    if restart:
        if rules is None or now - rules[1] < YOUNG:
            return
        p = pane_of(agent, tab)
        if p is None:
            return
    elif not still_idle(w):
        return                                 # changed since the listing: no CONTINUE, no attempt spent
    state.update(count=count + 1, last=now)
    write_file(spath, json.dumps(state) + "\n")
    ok = True
    if restart:
        args = ["--permission-mode", "auto", "--model", "opus", "--add-dir", wdir,
                "--settings", rules[0], "--setting-sources", "project", "--strict-mcp-config",
                "--resume"]
        ok = one_permission_mode(args)
        if not ok:
            detail(watch, w, "RESUME refused: the restart argv holds more than one --permission-mode")
        else:
            ok = herdr("agent", "start", w, "--kind", "claude", "--pane", p, "--timeout", "120000",
                       "--", *args, timeout=180)[0] == 0
        if ok:
            herdr("agent", "wait", w, "--until", "idle", "--timeout", "120000", timeout=180)
            if not still_idle(w, by_tab=agent is None):
                ok = False                     # not idle after the wait: CONTINUE's Enter could answer a prompt
                detail(watch, w, "RESUME refused: the re-list after the restart did not show it idle")
    if ok:
        ok = herdr("agent", "prompt", w, CONTINUE)[0] == 0
        if ok:
            typed(watch, w, CONTINUE)
    detail(watch, w, "RESUME attempt %d (%s%s): %s" % (count + 1, "restart" if restart else "prompt",
                                                      ", " + phrase if phrase else "", "ok" if ok else "failed"))
    if ok:
        emit("RESUMED: " + w)
    else:
        emit("STUCK: %s (resume attempt failed; detail in .watch/%s.detail)" % (w, w))


def discovered(agents, herd):
    """The herd as herdr sees it NOW: every listed agent with a worker name that is not the
    --notify target and whose own herd dir holds the rules file herd-spawn wrote. Re-read
    on every pass (ISSUE(herd-watch-workers-list-is-static)): a list read once at start
    left every later spawn unwatched, its report never announced. A name that is not a
    worker name is dropped before it is joined to a path or printed; an agent with no
    rules file was not spawned by herd-spawn and is not ours. A listing that failed
    (None) or came back empty discovers nobody -- it says nothing about who is gone."""
    target = os.environ.get("HERD_WATCH_NOTIFY", "")
    out = set()
    for a in agents or []:
        n = a.get("name")
        if not isinstance(n, str) or not NAME_RE.fullmatch(n) or n == target:
            continue
        wdir = os.path.join(herd, n)
        if os.path.isdir(wdir) and rules_file(wdir) is not None:
            out.add(n)
    return out


REPORT_CAP = 4 << 20               # bytes: a report.md over this is no report for the pass
_oversized = set()                 # worker dirs logged `report-oversized` this pass


def report_oversized(wdir):
    """log `<UTC time> report-oversized <w>` in coordinator.log, once per pass however many
    readers find it (each pass is a fresh child, so the set is this pass's)"""
    if wdir in _oversized:
        return
    _oversized.add(wdir)
    herd, w = os.path.split(wdir)
    log_reprompt(os.path.join(herd, "coordinator"), w, clock(), "report-oversized")


def report_digest(wdir):
    """(sha256 hex, mtime) of <wdir>/report.md, or None. Neither the herd dir nor the
    report is followed through a symlink: a link could hand the coordinator a file the
    worker never wrote, or point .reported's write outside HERD_DIR. The report is hashed
    while streaming, never held; one over REPORT_CAP is absent for this pass and logged
    (review of cdd2703..72fc029, finding 1: a walled worker can make it a sparse 1 TiB)."""
    if os.path.islink(wdir) or not os.path.isdir(wdir):
        return None
    got = _herd_files.digest_regular(os.path.join(wdir, "report.md"), REPORT_CAP)
    if got == _herd_files.OVERSIZED:
        report_oversized(wdir)
        return None
    if got is None:
        return None
    return got[0], got[1].st_mtime


def current_report(wdir):
    """(digest, mtime) of the report THIS spawn wrote, or None. A report is the current
    spawn's only when strictly newer than permissions.json, which herd-spawn rewrites on
    every spawn: a report left over from an earlier run under the same name (the daily
    reviewer, 2026-09-22) is stale, never announced and never a reason not to restart.
    A symlinked rules file refuses outright. A name with no rules file at all can only be
    here from WORKERS -- the operator said to watch it -- so there is no spawn time to
    compare with and the check is skipped."""
    rep = report_digest(wdir)
    if rep is None:
        return None
    p = os.path.join(wdir, "permissions.json")
    if os.path.islink(p):
        return None
    try:
        st = os.stat(p)
    except OSError:
        return rep
    return rep if rep[1] > st.st_mtime else None


def announced(wdir):
    """the digest in .reported, '' for the old watcher's empty marker, None when absent
    (anything not a regular file is absent: not yet reported)"""
    got = read_regular(os.path.join(wdir, ".reported"), 256)
    if got is None:
        return None
    return got[0].decode("ascii", "replace").strip(), got[1].st_mtime


def mark_reported(wdir, digest):
    replace_regular(os.path.join(wdir, ".reported"), (digest + "\n").encode("ascii"))


def check_report(w, herd):
    """Announce w's current report once per distinct content, across passes and restarts.
    True when the current spawn has a report (announced now or before)."""
    wdir = os.path.join(herd, w)
    rep = current_report(wdir)
    if rep is None:
        return False
    digest, mtime = rep
    seen = announced(wdir)
    if seen is not None and seen[0] == digest:
        return True
    if seen is not None and not re.fullmatch(r"[0-9a-f]{64}", seen[0]) and mtime <= seen[1]:
        # the old watcher's empty marker, written after this report: already announced
        try:
            mark_reported(wdir, digest)
        except OSError:
            pass
        return True
    try:
        mark_reported(wdir, digest)
    except OSError:
        return True                    # cannot record it: announcing every pass is worse
    emit("REPORT: %s wrote report.md" % w)
    return True


# ------------------------------------------------------------------ the intake watchdog

GRACE = 300                        # an intake unchanged this long, with no live worker, stalled
INTAKE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,124}\.md")   # appl-hook.sh's own rule
HEADER_MAX = 1 << 16
STALL_CAP = 5                      # typings of one unchanged `new` intake before the watchdog stops


def status_failed(watch, name):
    """the intake mtime (ns) in .watch/status-failed/<name>, which appl-status.sh writes when
    its write of that intake failed, or None. Never read through a link."""
    p = os.path.join(watch, "status-failed", name)
    try:
        if os.path.islink(os.path.dirname(p)):
            return None
        fd = os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        v = os.read(fd, 64).decode("ascii", "replace").strip()
    except OSError:
        return None
    finally:
        os.close(fd)
    return int(v) if re.fullmatch(r"[0-9]{1,30}", v) else None


def header_status(path):
    """the words of the intake's HEADER `status:` line (the lines before the first blank
    line, as appl-status.sh reads it), or None. A `status:` inside `## Task` is text.
    Anything not a regular file -- a symlink, a FIFO, a socket, a device -- is judged on lstat
    and never opened: opening a FIFO with nobody on its other end blocks forever, and a
    walled worker can mkfifo under intake/ (review finding 2 of 65163eb). The open is
    O_NONBLOCK as well, and the fstat must be the regular file lstat saw, as in
    landing_running()."""
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode):
        return None
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            return None
        data = os.read(fd, HEADER_MAX).decode("utf-8", "replace")
    except OSError:
        return None
    finally:
        os.close(fd)
    for line in data.split("\n"):
        if line == "":
            break
        if line.startswith("status:"):
            return line[len("status:"):].split()
    return None


def log_reprompt(coord, name, now, what="reprompt"):
    """one fixed-vocabulary line in coordinator.log, append-only, never through a link"""
    line = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)) + " " + what + " " + name + "\n"
    try:
        fd = os.open(os.path.join(coord, "coordinator.log"),
                     os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError:
        return
    try:
        os.write(fd, line.encode("ascii"))
    finally:
        os.close(fd)


def intake_watchdog(agents, herd, watch, now):
    """ISSUE(coordinator-annotates-an-intake-then-does-not-spawn). The coordinator can set an
    intake's status to an annotation (`new -- brief for w9 being written`) and end its turn
    before it spawns: the intake then looks handled and nothing says it stalled. Every pass,
    each intake directly under <HERD_DIR>/coordinator/intake/ whose header status names no
    live agent, whose first status word is exactly `new` and whose mtime is more than
    GRACE seconds old is typed into the --notify target as `intake <path>` -- the bytes
    tools/appl-add.sh sends, so the pane takes it exactly as a fresh filing -- at most once
    per GRACE per (intake, mtime). State is on disk (.watch/intakes.json) because every pass
    is a fresh process. A listing that failed judges nobody live, so nothing is typed.
    Nothing an intake says reaches stdout, the log or the pane: only its file name, which
    must pass appl-hook's name rule. It never edits an intake, spawns or closes anything."""
    target = os.environ.get("HERD_WATCH_NOTIFY", "")
    if not target or not NAME_RE.fullmatch(target) or agents is None or TARGET_OUT:
        return                                         # logged out: no state moves either
    coord = os.path.join(herd, "coordinator")
    idir = os.path.join(coord, "intake")
    if os.path.islink(coord) or os.path.islink(idir) or not os.path.isdir(idir):
        return
    # The target is driven only when its harness's declaration says it may be the
    # coordinator and is a wake target. A harness the adapter refuses is named, never defaulted.
    harness, decl = pane_harness(herd, target)
    if decl is None:
        detail(watch, target, "REPROMPT refused: harness %s has no wake adapter declaration" % harness)
        return
    if decl.get("coordinator_eligible") != "yes" or decl.get("wake_target") != "yes":
        detail(watch, target, "REPROMPT refused: harness %s is not coordinator-eligible" % harness)
        return
    reprompted = False
    live = {a.get("name") for a in agents if isinstance(a.get("name"), str)} - {target}
    spath = os.path.join(watch, "intakes.json")
    try:
        state = json.loads(read_file(spath) or "{}")
    except ValueError:
        state = {}
    if not isinstance(state, dict):
        state = {}
    kept = {}
    try:
        entries = sorted(os.listdir(idir))
    except OSError:
        return
    for name in entries:
        if not INTAKE_RE.fullmatch(name):
            continue
        path = os.path.join(idir, name)
        try:
            st = os.lstat(path)
        except OSError:
            continue
        if not stat.S_ISREG(st.st_mode):
            continue                                   # a symlink, a directory, a fifo
        prev = state.get(name) if isinstance(state.get(name), dict) else None
        if prev is not None:
            kept[name] = prev
        words = header_status(path)
        if not words or words[0] != "new" or any(w in live for w in words):
            continue                                   # only a `new` intake is ever typed
        mtime = st.st_mtime_ns
        same = prev is not None and prev.get("mtime") == mtime
        if same and prev.get("stopped") is True:
            continue                                   # stopped, and logged once already
        n = prev.get("n") if same and isinstance(prev.get("n"), int) else (1 if same else 0)
        at = prev.get("at") if prev is not None else None
        why = None
        if status_failed(watch, name) == mtime:
            why = "status-failed"                      # appl-status.sh could not write it
        elif now - st.st_mtime <= GRACE:
            continue
        elif same and isinstance(at, int) and now - at <= GRACE:
            continue                                   # typed inside this grace period already
        elif n >= STALL_CAP:
            why = "reprompt-capped"                    # typed STALL_CAP times, still `new`
        if why is not None:
            kept[name] = {"mtime": mtime, "at": at if same else None, "n": n, "stopped": True}
            log_reprompt(coord, name, now, why)
            continue
        if coord_prompt(target, "intake " + path)[0] != 0:
            kept[name] = {"mtime": mtime, "at": now, "n": n + 1}
            continue                                   # the pane is down: counted, tried after GRACE
        typed(watch, target, "intake " + path)
        kept[name] = {"mtime": mtime, "at": now, "n": n + 1}
        log_reprompt(coord, name, now)
        reprompted = True
    if kept != state:
        tmp = spath + ".tmp"
        try:
            if os.path.islink(tmp):
                os.unlink(tmp)
            write_file(tmp, json.dumps(kept, sort_keys=True) + "\n")
            os.replace(tmp, spath)
        except OSError:
            pass
    # Mail beyond the per-wake cap waits for no new mail: a re-prompt also types the declared
    # wake_line, so the coordinator's hook runs the same bounded filing pass a mail wake runs,
    # with the wake's own refusals and its own mail position. Only where mail is set up.
    wake = decl.get("wake_line", "")
    if reprompted and wake and mail_set_up(coord):
        coord_prompt(target, wake, timeout=120)


def mail_set_up(coord):
    """True when the coordinator directory holds a mail.allow or a mail.cursor (as anything,
    a link included): the hook's mail pass has something to judge by"""
    return any(os.path.lexists(os.path.join(coord, f)) for f in ("mail.allow", "mail.cursor"))


# ------------------------------------------------------------------ an intake stuck on a ruling

# the `blocked <word>` statuses that wait on the coordinator's ruling; `question` is the other
RULING_BLOCKED = ("tests-not-clean", "pin-diff", "not-landed", "no-primary", "report-incomplete")
OWNER_STUCK = 30 * 60              # an owner-P0 intake in a ruling status MORE than this is stuck
OTHER_STUCK = 4 * 60 * 60          # any other intake: MORE than this
STUCK_EVERY = 60 * 60              # an idle worker-held intake's STUCK: <id> repeats this often
# a ruling intake's STUCK: <id> repeats at appl-hook.sh's ESCALATE_EVERY, so the watcher
# never sends a repeat the hook would only suppress (intake 20261025T071354Z)
ESCALATE_EVERY = 4 * 60 * 60
OWNER_EVERY = 30 * 60              # an owner-P0 intake's STUCK: <id> repeats this often (20261012T151408Z)
HELD_IDLE = 60 * 60                # a worker-held intake whose pane counter stood this long is stuck
REPORT_EVERY = 60 * 60             # <coordinator>/status-report is rewritten at most this often
# the pane's token counter, e.g. `1.2k tokens` (operator ruling 20261012T222304Z)
TOKENS_RE = re.compile(r"([0-9]+(?:\.[0-9]+)?k?) tokens")
_INTAKE_ID = []


def intake_id_mod():
    """scripts/intake_id.py, loaded once and compiled from its source (no pyc is read or
    written): the one rule an id and owner P0 are read by"""
    if not _INTAKE_ID:
        try:
            mod = load_sibling("intake_id")
        except (OSError, KeyError, ImportError, AttributeError, SyntaxError, ValueError):
            mod = None
        _INTAKE_ID.append(mod)
    return _INTAKE_ID[0]


def ruling_blocker(words):
    """the blocking word of a header status that needs a ruling, or None. Only the first
    words are read: the why after the blocker is never copied anywhere."""
    if not words:
        return None
    if words[0] == "question":
        return "question"
    if words[0] == "blocked" and len(words) > 1 and words[1] in RULING_BLOCKED:
        return words[1]
    return None


def age_text(secs):
    """seconds as `<n>d<n>h<n>m`, the zero leading parts left out, e.g. 31m, 4h02m"""
    m = max(0, int(secs)) // 60
    d, h, m = m // 1440, (m // 60) % 24, m % 60
    if d:
        return "%dd%02dh%02dm" % (d, h, m)
    if h:
        return "%dh%02dm" % (h, m)
    return "%dm" % m


def intake_entries(idir):
    """the regular intake files directly under idir, as (name, path, lstat), sorted"""
    try:
        entries = sorted(os.listdir(idir))
    except OSError:
        return []
    out = []
    for name in entries:
        if not INTAKE_RE.fullmatch(name):
            continue
        path = os.path.join(idir, name)
        try:
            st = os.lstat(path)
        except OSError:
            continue
        if stat.S_ISREG(st.st_mode):
            out.append((name, path, st))                # never a symlink, a directory, a fifo
    return out


def held_workers(herd, listed):
    """the workers an intake is held by -- header status `tests <w>` or `impl <w>` -- that
    herdr lists (listed: the names of this pass's agent listing), sorted"""
    idir = os.path.join(herd, "coordinator", "intake")
    if os.path.islink(os.path.join(herd, "coordinator")) or os.path.islink(idir) or not os.path.isdir(idir):
        return []
    out = set()
    for _name, path, _st in intake_entries(idir):
        words = header_status(path) or []              # None: no header status
        if len(words) >= 2 and words[0] in ("tests", "impl") and words[1] in listed:
            out.add(words[1])
    return sorted(out)


def held_idle(herd, watch, now, panes):
    """operator ruling 20261012T222304Z: {w: idle seconds} for each held worker whose pane
    text is in panes. Activity is a change of the pane's token counter (TOKENS_RE, the last
    one on the pane; a pane with none is compared whole) or <HERD_DIR>/<w>/report.md
    existing; the idle clock starts at the first pass that sees the counter at its current
    value. State is .watch/held-idle.json: only a digest of the counter is kept."""
    spath = os.path.join(watch, "held-idle.json")
    try:
        state = json.loads(read_file(spath) or "{}")
    except ValueError:
        state = {}
    if not isinstance(state, dict):
        state = {}
    kept, idle = {}, {}
    for w, pane in sorted(panes.items()):
        if os.path.lexists(os.path.join(herd, w, "report.md")):
            continue                                   # a report is activity: no clock
        found = TOKENS_RE.findall(pane or "")
        mark = hashlib.sha256((found[-1] if found else (pane or "")).encode("utf-8", "replace")).hexdigest()
        prev = state.get(w) if isinstance(state.get(w), dict) else None
        if prev is None or prev.get("mark") != mark or not isinstance(prev.get("since"), (int, float)):
            prev = {"mark": mark, "since": now}
        kept[w] = prev
        idle[w] = now - prev["since"]
    if kept != state:
        put_state(spath, kept)
    return idle


def intake_stuck(herd, watch, now, idle=None, tell=True):
    """ISSUE(an-unruled-intake-stalls-with-no-clock; intake 20261010T120034Z). An intake whose
    HEADER status needs a ruling (ruling_blocker) sat unruled for hours and nothing said so.
    Every pass, each regular *.md directly under <HERD_DIR>/coordinator/intake/ whose status
    has needed a ruling for MORE than OWNER_STUCK (owner P0: intake_id.owner_p0_head, the
    marker or a parent chain reaching it) or OTHER_STUCK (otherwise), measured from its mtime,
    gets `STUCK: <id> <age> <blocker>` on stdout and the same line in coordinator.log, at most
    once per OWNER_EVERY (owner P0), STUCK_EVERY (idle) or ESCALATE_EVERY (otherwise) per
    (intake, mtime): a status
    change is a new mtime and restarts the clock. A WORKER-HELD intake (`tests <w>` or `impl
    <w>`, <w> in idle: listed by herdr) whose pane has been idle for HELD_IDLE or more is stuck
    too, its blocker `idle` and its age the idle time (operator ruling 20261012T222304Z). State
    is .watch/intake-stuck.json, since every pass is a fresh process. Only the id (`id:`
    header, as intake_id.py resolves it), the age and the fixed blocker word leave an intake;
    it is never edited. Not the per-pane `STUCK: <w> ...` line: that one names a worker, this
    one an intake id. Returns how many intakes are past their threshold now, told this pass
    or not; with tell=False nothing is printed, logged or written."""
    idle = idle or {}
    ids = intake_id_mod()
    coord = os.path.join(herd, "coordinator")
    idir = os.path.join(coord, "intake")
    if ids is None or os.path.islink(coord) or os.path.islink(idir) or not os.path.isdir(idir):
        return 0
    spath = os.path.join(watch, "intake-stuck.json")
    try:
        state = json.loads(read_file(spath) or "{}")
    except ValueError:
        state = {}
    if not isinstance(state, dict):
        state = {}
    kept, count = {}, 0
    for name, path, st in intake_entries(idir):
        words = header_status(path) or []              # None: no header status
        blocker = ruling_blocker(words)
        held = None
        if blocker is None and len(words) >= 2 and words[0] in ("tests", "impl") and words[1] in idle:
            held = idle[words[1]]
            blocker = "idle"
        if blocker is None:
            continue                                   # needs no ruling: its record is dropped
        mtime = st.st_mtime_ns
        prev = state.get(name) if isinstance(state.get(name), dict) else None
        if prev is not None and prev.get("mtime") == mtime:
            kept[name] = prev
        else:
            prev = None                                # a new status: the clock starts over
        head = ids.read_head(path)
        if head is None:
            continue
        owner = ids.owner_p0_head(idir, head)
        if held is not None:
            age = held
            if age < HELD_IDLE:
                continue
        else:
            age = now - st.st_mtime
            if age <= (OWNER_STUCK if owner else OTHER_STUCK):
                continue
        ident = ids.id_of(idir, name)
        if ident is None or not ids.is_id(ident):
            continue                                   # no id to name it by
        count += 1
        at = prev.get("at") if prev is not None else None
        every = OWNER_EVERY if owner else STUCK_EVERY if held is not None else ESCALATE_EVERY
        if isinstance(at, (int, float)) and now - at < every:
            continue                                   # told within its interval already
        if not tell:
            continue
        line = "%s %s %s" % (ident, age_text(age), blocker)
        emit("STUCK: " + line)
        log_reprompt(coord, line, now, "STUCK:")
        kept[name] = {"mtime": mtime, "at": now}
    if not tell:
        return count
    if kept != state:
        tmp = spath + ".tmp"
        try:
            if os.path.islink(tmp):
                os.unlink(tmp)
            write_file(tmp, json.dumps(kept, sort_keys=True) + "\n")
            os.replace(tmp, spath)
        except OSError:
            pass
    return count


def status_report(herd, watch, now, count):
    """the hourly status report, <coordinator>/status-report (intake 20261012T151408Z): its
    bytes start with <coordinator>/owner-stops.md (the escalations appl-hook.sh wrote, read
    as bytes and never through a symlink), then the pass's time and stuck count. Written when
    it is absent or REPORT_EVERY has passed since the last write (.watch/status-report.json);
    left untouched otherwise. Never printed: stdout stays the fixed vocabulary."""
    coord = os.path.join(herd, "coordinator")
    if os.path.islink(coord) or not os.path.isdir(coord):
        return
    path = os.path.join(coord, "status-report")
    state, spath = sweep_state(watch, "status-report", "json")
    at = state.get("at")
    if os.path.lexists(path) and isinstance(at, (int, float)) and now - at < REPORT_EVERY:
        return
    stops = read_nofollow(os.path.join(coord, "owner-stops.md"), 1 << 20) or b""
    tail = ("status %s stuck=%d\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), count)).encode("ascii")
    tmp = path + ".tmp"
    try:
        if os.path.lexists(tmp):
            os.unlink(tmp)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            os.write(fd, stops + (b"" if not stops or stops.endswith(b"\n") else b"\n") + tail)
        finally:
            os.close(fd)
        os.replace(tmp, path)
    except OSError:
        return
    put_state(spath, {"at": now})


# ------------------------------------------------------------------ a logged-out target

# the ways Claude Code says its login has lapsed and one typed line revives it: the session
# refreshes its login on its next turn (the revive below)
REVIVABLE = ("Login expired", "OAuth token revoked")
# the ways Claude Code says its login is gone: never signed in, or a lapsed login
LOGGED_OUT = ("Not logged in",) + REVIVABLE
# the kind word an adapter's --recognize prints for a logged-out screen: never a dialog (no
# STUCK:, no `dialog <kind>`), always this logged-out path
LOGOUT_KIND = "logged-out"
# Non-ASCII glyphs are spelled as \u escapes: the .sh files are ASCII-only.
MARKS = " \t\u23bf\u23fa"          # leading whitespace and the reply marks Claude Code draws
BOX = set("\u2500\u2502\u256d\u256e\u256f\u2570 ")    # the input box's own lines
INPUT_RE = re.compile(r"\u2502?\s*>\s*\u2502?")
RESTART = ".cursor/skills/isolated-session/scripts/restart-coordinator-pane.sh"


def last_reply(pane):
    """The pane's last reply line, marks stripped, or None. The tail is the last 20 lines;
    everything from the LAST input line down (the bare `>`, alone or inside the box's bars)
    is the input box and the status line under it, and is dropped. Blank lines and the
    box's border lines are skipped."""
    lines = pane.splitlines()[-20:]
    for i in range(len(lines) - 1, -1, -1):
        if INPUT_RE.fullmatch(lines[i].strip()):
            lines = lines[:i]
            break
    for line in reversed(lines):
        s = line.lstrip(MARKS)
        if s.strip() and not set(s) <= BOX:
            return s
    return None


def logged_out(pane):
    """the watcher's own two phrases, or the kind word LOGOUT_KIND from the runtime's adapter
    (the runtime's other logged-out lines -- a revoked token -- are known only there)"""
    r = last_reply(pane)
    return (r is not None and r.startswith(LOGGED_OUT)) or dialog_kind(pane) == LOGOUT_KIND


def revivable(pane):
    """the pane's last reply line BEGINS with one of REVIVABLE (the logged_out() reading)"""
    r = last_reply(pane)
    return r is not None and r.startswith(REVIVABLE)


def owner_step(coord, target, now):
    """<coord>/owner-step-login-<target>.txt: one line of the watcher's own words, never
    through a link (a symlinked coordinator dir or file is left alone)"""
    if os.path.islink(coord):
        return
    try:
        if not os.path.isdir(coord):
            os.mkdir(coord, 0o700)
        fd = os.open(os.path.join(coord, "owner-step-login-" + target + ".txt"),
                     os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError:
        return
    line = (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)) + " the pane " + target
            + " is logged out: run /login in it, or restart it with " + RESTART + "\n")
    try:
        os.write(fd, line.encode("ascii"))
    finally:
        os.close(fd)


def check_target(herd, watch, now):
    """ISSUE(coordinator-pane-logs-out-on-auto-update). A --notify pane whose last reply
    begins `Not logged in` or `Login expired` cannot take anything typed into it, and /login is an interactive
    OAuth no script can perform: the watcher stops typing into it (intakes and
    notifications both), logs `<UTC time> logged-out <target>` once per occurrence and
    leaves the owner one line. State is .watch/<target>.logged-out, because every pass is
    a fresh process. A pane that reads normally again clears it; a pane that cannot be
    read (or reads empty) proves nothing and changes nothing. No pane text is copied
    anywhere: the log and the owner step are the watcher's own words. Returns the pane text
    when it is logged out (for coordinator_revive, after the listings), else None."""
    global TARGET_OUT
    target = os.environ.get("HERD_WATCH_NOTIFY", "")
    if not target or not NAME_RE.fullmatch(target):
        return None
    pane = read_pane(target)
    if not pane.strip():
        return None
    coord = os.path.join(herd, "coordinator")
    state = os.path.join(watch, target + ".logged-out")
    if not logged_out(pane):
        coordinator_revive_ended(watch, target)        # it reads normally again: the episode ended
        if os.path.lexists(state):
            try:
                os.unlink(state)
                step = os.path.join(coord, "owner-step-login-" + target + ".txt")
                if not os.path.islink(coord) and os.path.isfile(step) and not os.path.islink(step):
                    os.unlink(step)
            except OSError:
                pass
        resubmit(target, pane, herd, watch, now)       # this pane read, before anything is typed
        return None
    TARGET_OUT = True
    if os.path.lexists(state):
        return pane                                    # this occurrence is logged already
    try:
        write_file(state, str(now) + "\n")
    except OSError:
        return pane                                    # cannot record it: logging every pass is worse
    if not os.path.islink(coord):
        if not os.path.isdir(coord):
            try:
                os.mkdir(coord, 0o700)
            except OSError:
                pass
        log_reprompt(coord, target, now, "logged-out")
    owner_step(coord, target, now)
    return pane


# ------------------------------------------------------------------ the idle sweep

SWEEP_AFTER = 20 * 60              # a worker pane idle this long, and not live, is closed
IDLE = ("idle", "done")
LIVE = ("tests", "impl", "review")  # the header statuses that name a worker still at work
CLOSED_FIRST = ("done", "landed", "split")   # first words that never hold a bare name
COORDINATOR = "muretai-coordinator"   # the coordinator pane's name (briefs/coordinator.md)
WORKERS_STEP = "owner-step-login-workers.txt"


def never_swept():
    """the coordinator pane under both of its names: the --notify target and COORDINATOR"""
    target = os.environ.get("HERD_WATCH_NOTIFY", "")
    return {COORDINATOR} | ({target} if target else set())


def live_workers(herd):
    """every name an intake HEADER status puts to work (`tests|impl|review <w> ...`, whole
    words), or None when the intake directory cannot be read -- then nobody is known to be
    idle for good and nothing is swept. No intake directory at all holds nobody. A status
    whose FIRST word is a bare worker name with its $HERD_DIR/.repos/<w> spawn record
    (recorded_repo) holds that worker too, as appl-close.sh's held_by does; a closed first
    word (CLOSED_FIRST) never does (intake 20261010T021047Z)."""
    coord = os.path.join(herd, "coordinator")
    idir = os.path.join(coord, "intake")
    if os.path.islink(coord) or os.path.islink(idir):
        return None
    if not os.path.lexists(idir):
        return set()
    try:
        entries = sorted(os.listdir(idir))
    except OSError:
        return None
    out = set()
    for name in entries:
        if not INTAKE_RE.fullmatch(name):
            continue
        words = header_status(os.path.join(idir, name))   # lstat first: regular files only
        if words and words[0] in LIVE:
            out.update(words[1:])
        elif (words and words[0] not in CLOSED_FIRST and NAME_RE.fullmatch(words[0])
              and recorded_repo(herd, words[0]) is not None):
            out.add(words[0])
    return out


def sweep_why(herd, w, out):
    """the <why> of `swept <w> <why>`: how the pane was due and the first word of the first
    intake HEADER status naming <w> as a whole word (`status: none` when none does). One
    record of printable ASCII: any other character of that word is `?`."""
    word = "none"
    idir = os.path.join(herd, "coordinator", "intake")
    try:
        entries = [] if os.path.islink(idir) else sorted(os.listdir(idir))
    except OSError:
        entries = []
    for name in entries:
        if not INTAKE_RE.fullmatch(name):
            continue
        words = header_status(os.path.join(idir, name))
        if words and w in words:
            word = "".join(c if 0x21 <= ord(c) < 0x7f else "?" for c in words[0][:64])
            break
    return ("logged-out" if out else "idle") + ", status: " + word


def sweep_state(watch, w, kind="sweep"):
    """(.watch/<w>.<kind> as a dict, its path); never read through a symlink"""
    p = os.path.join(watch, w + "." + kind)
    try:
        fd = os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return {}, p
    try:
        state = json.loads(os.read(fd, 4096).decode("ascii", "replace") or "{}")
    except (OSError, ValueError):
        state = {}
    finally:
        os.close(fd)
    return (state if isinstance(state, dict) else {}), p


def put_state(p, state):
    """write a small state file under .watch/, never through a symlink"""
    try:
        if os.path.islink(p):
            os.unlink(p)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError:
        return
    try:
        os.write(fd, (json.dumps(state, sort_keys=True) + "\n").encode("ascii"))
    finally:
        os.close(fd)


def put_text(p, text):
    """write a small text file under .watch/ whole (a temporary file, then a rename), never
    through a symlink"""
    tmp = p + ".tmp"
    try:
        if os.path.lexists(tmp):
            os.unlink(tmp)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            os.write(fd, text.encode("ascii", "replace"))
        finally:
            os.close(fd)
        os.replace(tmp, p)
    except OSError:
        pass


def drop_state(p):
    try:
        os.unlink(p)
    except OSError:
        pass


def close_requested(wdir, spawn):
    """True when appl-hook.sh left <wdir>/close-requested for THIS spawn: a regular file of
    ours, not a symlink, strictly newer than the rules file herd-spawn rewrites on every
    spawn (a marker left by an earlier run under the same name closes nothing)."""
    try:
        st = os.lstat(os.path.join(wdir, "close-requested"))
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and st.st_mtime > spawn


REASON_CAP = 200                   # characters of appl-close.sh's refusal line a record carries


def refusal_reason(err):
    """appl-close.sh's refusal line (intake 20261009T184125Z), from its stderr bytes: the first
    LF-split line that is not blank, stripped, every byte outside printable ASCII made `?` (a
    CR or ESC can never split or forge a record), cut to REASON_CAP; "" when there is none"""
    for raw in (err or b"").split(b"\n"):
        raw = raw.strip()
        if raw:
            return "".join(chr(b) if 0x20 <= b <= 0x7e else "?" for b in raw).strip()[:REASON_CAP]
    return ""


def appl_close(w):
    """the sibling appl-close.sh <w>: (True, "") when it closed the tab (and logged `closed
    <w>`), else (False, its refusal_reason()); its stdout is never read"""
    here = os.environ.get("HERD_WATCH_HERE", "")
    try:
        r = subprocess.run(["bash", os.path.join(here, "appl-close.sh"), w], stdin=subprocess.DEVNULL,
                           capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return False, ""
    if r.returncode == 0:
        return True, ""
    return False, refusal_reason(r.stderr)


def marker_present(wdir):
    """<wdir>/close-requested is a regular file of ours, whatever its age (not a symlink)"""
    try:
        st = os.lstat(os.path.join(wdir, "close-requested"))
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid()


def workers_step(coord, names, now):
    """<coord>/owner-step-login-workers.txt: one line naming every pane seen `Not logged in`
    on this pass -- the login is shared, so one step covers them all. The watcher's own
    words and the pane names only; never through a link."""
    if os.path.islink(coord):
        return
    try:
        if not os.path.isdir(coord):
            os.mkdir(coord, 0o700)
        p = os.path.join(coord, WORKERS_STEP)
        if os.path.islink(p):
            os.unlink(p)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError:
        return
    line = (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)) + " the panes " + " ".join(sorted(names))
            + " are logged out: run /login in one of them; a swept worker keeps its worktree and"
            " herd dir and is re-spawned after the login\n")
    try:
        os.write(fd, line.encode("ascii"))
    finally:
        os.close(fd)


SAFE_PATH_RE = re.compile(r"/[A-Za-z0-9/._-]{0,400}")


def intakes_naming(herd, w):
    """the file names of the intakes whose HEADER status names w as a whole word"""
    idir = os.path.join(herd, "coordinator", "intake")
    if os.path.islink(os.path.join(herd, "coordinator")) or os.path.islink(idir):
        return []
    try:
        entries = sorted(os.listdir(idir))
    except OSError:
        return []
    return [n for n in entries if INTAKE_RE.fullmatch(n) and w in (header_status(os.path.join(idir, n)) or [])]


RESPAWN_WHY = {
    "logged-out": ("RE-SPAWN %s after login expiry",
                   "herd-watch saw the worker pane %s logged out (its last reply began `Not logged in` or"
                   " `Login expired`, or its runtime's adapter called the screen logged out) and asked for its tab to be closed. After /login, re-spawn it on the"
                   " same worktree and branch so it picks up where it stopped."),
    "never-briefed": ("RE-SPAWN %s that never reached its brief",
                      "herd-watch saw the worker %s with no brief.md and no report in its herd directory,"
                      " never shown working by herdr, long after its spawn, and asked for its tab to be"
                      " closed. Nothing was typed into its pane. Re-spawn it on the same worktree and"
                      " branch; if it stops at a first-run prompt again, answer that prompt once by hand."),
    "parked": ("RE-SPAWN %s parked at a prompt",
               "herd-watch saw herdr report the worker %s blocked on every pass for more than 20"
               " minutes and asked for its tab to be closed. Nothing was typed into its pane. Re-spawn"
               " it on the same worktree and branch so it picks up where it stopped."),
    "dead": ("RE-SPAWN %s after a dead pane",
             "herd-watch saw the worker %s dead for more than 300 seconds, its tab unlisted or its"
             " agent missing or its pane without a harness process, and asked for its tab to be"
             " closed. Re-spawn it on the same worktree and branch so it picks up where it stopped."),
}


def file_respawn(w, agent, rules, herd, watch, why="logged-out", mark=True):
    """ISSUE(worker-panes-lose-login-when-another-process-refreshes-the-oauth-token). A worker
    pane whose login expired can do nothing until the owner logs in again, and the sweep
    that closes it used to leave nothing asking for the work to be picked up. So, once per
    spawn (.watch/<w>.respawn holds the rules file's mtime), write <HERD_DIR>/<w>/close-requested
    -- the marker appl-hook.sh writes, a regular file, never through a link -- and file ONE
    intake through tools/appl-add.sh titled `RE-SPAWN <w> ...` (the reason, `why`, picks the
    title from RESPAWN_WHY), naming the worker, its worktree (the agent's cwd, only when it
    is a linked worktree and a plain path) and the intakes whose header status names it.
    The state is shared by every reason: a worker both logged out and never briefed, or
    never briefed and then parked, gets one intake in all. Every word of the task is the
    watcher's own or a name that passed its rule: no pane text reaches the intake. When the
    --notify target is logged out too, appl-add.sh's wake is suppressed (the intake watchdog
    types it once the pane reads normally again). mark=False files the intake without the
    marker: the sweep's close of a revivable pane whose revive failed already went through."""
    spath = os.path.join(watch, w + ".respawn")
    seen = read_regular(spath, 64)
    if seen is not None and seen[0].decode("ascii", "replace").strip() == str(rules[1]):
        return
    wdir = os.path.join(herd, w)
    try:
        if mark:
            replace_regular(os.path.join(wdir, "close-requested"),
                            (why + " " + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + "\n").encode("ascii"))
    except OSError:
        pass                                           # the intake is still worth filing
    wt = linked_worktree(agent)
    if wt is not None and not SAFE_PATH_RE.fullmatch(wt):
        wt = None
    own = intakes_naming(herd, w)
    title, body = RESPAWN_WHY[why]
    task = ((title % w) + "\n\n" + (body % w) + "\n\n" + "worker: %s\nworktree: %s\nintake: %s"
            % (w, wt or "unknown", " ".join(own) or "none"))
    here = os.environ.get("HERD_WATCH_HERE", "")
    add = os.path.normpath(os.path.join(here, "..", "..", "..", "..", "tools", "appl-add.sh"))
    argv = ["bash", add, "--", task, "--from", "herd-watch"] + (["--repo", wt] if wt else [])
    env = dict(os.environ)
    if TARGET_OUT:
        env["APPL_ADD_HERDR"] = "false"                # nothing is typed into a logged-out pane
    try:
        r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                           timeout=60, env=env)
    except (OSError, subprocess.SubprocessError):
        return
    if r.returncode in (0, 3):                         # 3: filed, not woken -- the file is the record
        put_raw(spath, str(rules[1]) + "\n")


def put_raw(p, text):
    """write a small state file under .watch/ by temp-and-rename, never through the node
    already at the name (a symlink, a FIFO, a hard link)"""
    try:
        replace_regular(p, text.encode("ascii"))
    except OSError:
        pass


# a finished pane: the hook's verdict line, or a landing the report can only point at
FULL_SHA_RE = re.compile(r"[0-9a-f]{40}")
VERIFIED_RANGE_RE = re.compile(r"[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}")


def read_nofollow(path, limit):
    """bytes of a regular file, never through a symlink or a FIFO, or None"""
    got = read_regular(path, limit)
    return None if got is None else got[0]


def plain_absolute(path):
    """an absolute path of printable ASCII, or None. Validated before any use, and never
    placed in a shell string: callers hand it to os.path or to an argv list."""
    if (not isinstance(path, str) or len(path) > 4096 or not path.startswith("/")
            or not all(0x20 <= ord(c) < 0x7f for c in path)):
        return None
    return path


def report_field(wdir, key):
    """the first KEY= value in report.md, or None. The file is data, not followed."""
    if os.path.islink(wdir):
        return None
    data = read_nofollow(os.path.join(wdir, "report.md"), 65536)
    if not data:
        return None
    prefix = key + "="
    for ln in data.decode("utf-8", "replace").splitlines():
        if ln.startswith(prefix):
            return ln[len(prefix):].strip()
    return None


def commit_sha(text):
    """COMMIT= as a full 40-hex sha, or None. The first word, up to whitespace or '('."""
    if not text:
        return None
    word = re.split(r"[\s(]", text, maxsplit=1)[0]
    return word if FULL_SHA_RE.fullmatch(word) else None


def utc_epoch(text):
    try:
        return calendar.timegm(time.strptime(text, "%Y-%m-%dT%H:%M:%SZ"))
    except (ValueError, OverflowError):
        return None


def verified_since(herd, w, spawn):
    """True when coordinator.log carries `verified <w>` or `verified <w> <range>` for this
    whole name, at a UTC time after this spawn's permissions.json (an earlier run's line
    is not this spawn's verdict)."""
    coord = os.path.join(herd, "coordinator")
    if os.path.islink(coord):
        return False
    data = read_nofollow(os.path.join(coord, "coordinator.log"), 1 << 20)
    if not data:
        return False
    for ln in data.decode("utf-8", "replace").splitlines():
        fields = ln.split()
        if len(fields) not in (3, 4) or fields[1] != "verified" or fields[2] != w:
            continue
        if len(fields) == 4 and not VERIFIED_RANGE_RE.fullmatch(fields[3]):
            continue
        when = utc_epoch(fields[0])
        if when is not None and when > spawn:
            return True
    return False


def verdict_since(herd, w, spawn):
    """True when the hook has judged this spawn's report: verified_since, or a `blocked <w>
    <why>` line with a `verdict <w> ...` line, both for this whole name and after this
    spawn's permissions.json. False is a REPORT that may never have reached the hook."""
    if verified_since(herd, w, spawn):
        return True
    coord = os.path.join(herd, "coordinator")
    if os.path.islink(coord):
        return False
    data = read_nofollow(os.path.join(coord, "coordinator.log"), 1 << 20)
    if not data:
        return False
    seen = set()
    for ln in data.decode("utf-8", "replace").splitlines():
        fields = ln.split()
        if len(fields) < 4 or fields[1] not in ("blocked", "verdict") or fields[2] != w:
            continue
        when = utc_epoch(fields[0])
        if when is not None and when > spawn:
            seen.add(fields[1])
    return seen == {"blocked", "verdict"}


def unverified_report(herd, w, spawn):
    """report.md exists for <w> and the hook has no verdict on it for this spawn"""
    return report_present(herd, w) and not verdict_since(herd, w, spawn)


def recorded_repo(herd, w):
    """$HERD_DIR/.repos/<w>, the hook's spawn_repo reading: one absolute path we own, or None.
    The report is never asked which repository it landed in."""
    repos = os.path.join(herd, ".repos")
    path = os.path.join(repos, w)
    if os.path.islink(repos):
        return None
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
        return None
    data = read_nofollow(path, 4097)
    if not data:
        return None
    try:
        text = data.decode("utf-8")
    except UnicodeError:
        return None
    lines = text.split("\n")
    repo = lines[0]
    if len(data) > 4096 or any(ln for ln in lines[1:]) or plain_absolute(repo) is None:
        return None
    return repo


def ancestor_of_main(repo, sha):
    """True when <sha> is an ancestor of refs/heads/main in <repo>. Both are already
    validated. The argv is a list: neither value is placed in a shell string, and GIT_*
    from the environment cannot point the command at another repository."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    try:
        r = subprocess.run(
            ["git", "-C", repo, "merge-base", "--is-ancestor", sha, "refs/heads/main"],
            env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0


def landed_worker(herd, w):
    """the report's COMMIT= is on main in .repos/<w> and its WORKTREE= no longer exists"""
    wdir = os.path.join(herd, w)
    sha = commit_sha(report_field(wdir, "COMMIT"))
    wt = plain_absolute(report_field(wdir, "WORKTREE"))
    repo = recorded_repo(herd, w)
    if not sha or not wt or not repo:
        return False
    if os.path.lexists(wt):
        return False
    return ancestor_of_main(repo, sha)


def report_present(herd, w):
    """True when <HERD_DIR>/<w>/report.md is a regular file. A symlink or a FIFO is absent.
    The bytes are not read: verification is the hook's `verified <w>` line, and
    branch-on-main is git's ancestry of the recorded tip, never a word in the report
    or on the pane. One over REPORT_CAP is absent for this pass, as in report_digest."""
    wdir = os.path.join(herd, w)
    if os.path.islink(wdir) or not os.path.isdir(wdir):
        return False
    got = read_regular(os.path.join(wdir, "report.md"), 0)
    if got is not None and got[1].st_size > REPORT_CAP:
        report_oversized(wdir)
        return False
    return got is not None


def finish_reason(herd, w, spawn):
    """'verified' or 'landed' when this idle pane is finished, else None. Neither holds
    while report.md is absent: a verified line, a finish command or a landing alone does
    not close the pane. A verified line wins when both are true, so the close logs one
    reason."""
    if not report_present(herd, w):
        return None
    if verified_since(herd, w, spawn):
        return "verified"
    if landed_worker(herd, w):
        return "landed"
    return None


# The launcher-landing evidence, shared with appl-hook.sh's live-worker count and the
# dashboard's Workers panel (intake 20261026T002106Z): landing_seat.py beside this script.
# It can only KEEP a pane here; anything in doubt is no landing. Loaded on first use, once
# a pass asks about a landing.
_LANDING_SEAT = []


def landing_seat():
    if not _LANDING_SEAT:
        _LANDING_SEAT.append(load_sibling("landing_seat"))
    return _LANDING_SEAT[0]


WALL_LOG_TAIL = 1 << 20            # bytes: only the end of walls/<w>/wall.log is read


def local_epoch(text):
    return landing_seat().local_epoch(text)


def proc_started(pid):
    return landing_seat().proc_started(pid)


def pid_alive(pid):
    return landing_seat().pid_alive(pid)


def launcher_landing(herd, w):
    return landing_seat().launcher_landing(herd, w)


def landing_running(herd, w, coord, now):
    """landing_seat.landing_running: True when $HERD_DIR/<w>/landing-running names a live
    finish-worktree.sh. A marker ignored for being a symlink, of another owner or not a
    regular file is logged `landing-marker-ignored <w> symlink|owner|type` when coord is
    given."""
    def ignored(why):
        if coord:
            log_reprompt(coord, w + " " + why, now, "landing-marker-ignored")
    return landing_seat().landing_running(herd, w, ignored)


BG_RUN_MAX = 64                    # bytes: walls/<w>/bg-run is one short line
BG_RUN_RE = re.compile(r"pid=([0-9]{1,10})\n?")
RUN_JSON_MAX = 1 << 16             # bytes: walls/<w>/run.json, the spawn's record
BRANCH_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,254}")
FINISH_SCRIPT = "finish-worktree.sh"
_PS_ARGV = []                      # this pass's process listing, as word lists, read once


def wall_file(herd, w, name, limit):
    """(bytes, lstat) of $HERD_DIR/walls/<w>/<name> when it is a regular file of ours, never
    through a link or a FIFO, else None"""
    walls = os.path.join(herd, "walls")
    wall = os.path.join(walls, w)
    path = os.path.join(wall, name)
    if os.path.islink(walls) or os.path.islink(wall):
        return None
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_size > limit:
        return None
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            return None
        data = os.read(fd, limit + 1)
    except OSError:
        return None
    finally:
        os.close(fd)
    return data, st


def bg_child(herd, w):
    """True when $HERD_DIR/walls/<w>/bg-run -- the launcher's record of the run w waits on,
    written outside the wall -- is a regular file of ours, mode 600, holding the one line
    `pid=<decimal>`, and that pid is alive (pid_alive) and did not start after the record
    was written (where ps answers). Anything else keeps nothing."""
    got = wall_file(herd, w, "bg-run", BG_RUN_MAX)
    if got is None or stat.S_IMODE(got[1].st_mode) != 0o600:
        return False
    try:
        m = BG_RUN_RE.fullmatch(got[0].decode("ascii"))
    except UnicodeError:
        return False
    if not m:
        return False
    pid = int(m.group(1))
    if not pid_alive(pid):
        return False
    began = proc_started(pid)
    return began is None or began <= got[1].st_mtime + 5


def recorded_branch(herd, w):
    """record.branch of the spawn's $HERD_DIR/walls/<w>/run.json, or None"""
    got = wall_file(herd, w, "run.json", RUN_JSON_MAX)
    if got is None:
        return None
    try:
        rec = json.loads(got[0].decode("utf-8")).get("record")
        branch = rec.get("branch")
    except (UnicodeError, ValueError, AttributeError):
        return None
    return branch if isinstance(branch, str) and BRANCH_RE.fullmatch(branch) else None


def process_words():
    """every row of the process listing as its argv words, the pid dropped: HERD_WATCH_PS_BIN
    (tests) or /bin/ps, asked once per pass. A listing that fails is no rows."""
    if not _PS_ARGV:
        binp = os.environ.get("HERD_WATCH_PS_BIN") or "/bin/ps"
        rows = []
        try:
            r = subprocess.run([binp, "-A", "-ww", "-o", "pid=,args="], stdin=subprocess.DEVNULL,
                               capture_output=True, timeout=30)
            if r.returncode == 0:
                rows = [ln.split()[1:] for ln in r.stdout.decode("utf-8", "replace").splitlines()]
        except (OSError, subprocess.SubprocessError):
            pass
        _PS_ARGV.append(rows)
    return _PS_ARGV[0]


def finish_running(herd, w):
    """True when a live process's argv has a word whose last path component is exactly
    finish-worktree.sh, followed by a word equal to w's recorded branch (recorded_branch)"""
    branch = recorded_branch(herd, w)
    if branch is None:
        return False
    for words in process_words():
        for i in range(len(words) - 1):
            if words[i].rsplit("/", 1)[-1] == FINISH_SCRIPT and words[i + 1] == branch:
                return True
    return False


def bg_waiting(herd, w):
    """True while w waits on a live background run: its recorded child (bg_child) or a
    finish-worktree.sh for its recorded branch (finish_running). It only KEEPS a pane."""
    return bg_child(herd, w) or finish_running(herd, w)


def closed_marker(herd, w):
    """is $HERD_DIR/walls/.closed/<w> a regular file of ours? appl-close.sh writes it
    when it closes the worker's tab (appl-hook.sh:closed_marker, same reading); a symlinked
    marker or marker directory is no marker"""
    if not NAME_RE.fullmatch(w):
        return False
    walls = os.path.join(herd, "walls")
    marks = os.path.join(walls, ".closed")
    if os.path.islink(walls) or os.path.islink(marks):
        return False
    try:
        st = os.lstat(os.path.join(marks, w))
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid()


RECEIPT_GRACE = 300                # seconds a listed, idle worker has to write report.md after its receipt


def receipt_grace():
    """HERD_WATCH_RECEIPT_GRACE as positive seconds, else RECEIPT_GRACE"""
    try:
        v = float(os.environ.get("HERD_WATCH_RECEIPT_GRACE") or RECEIPT_GRACE)
    except ValueError:
        return RECEIPT_GRACE
    return v if 0 < v < 1e7 else RECEIPT_GRACE


def check_receipt(w, herd, watch, status, listed, now):
    """ISSUE(sweep-kills-reviewer-while-its-receipt-lands): a worker whose landing the herd
    launcher ran, but which wrote no report.md (its pane was closed, or never got that far),
    is announced ONCE per receipt as `REPORT: <w> landed without report.md`, so appl-hook.sh
    verifies it from the launcher's receipt. Only a spawned worker (its own rules file), with
    no report.md at all, whose $HERD_DIR/walls/<w>/landing-receipt.json is a regular file of
    ours strictly newer than the rules file; a symlinked walls dir or receipt is no receipt,
    and a report.md that is a regular file wins (its own `wrote report.md` line).
    The receipt is never opened: the line is the fixed vocabulary and the name. State is
    .watch/<w>.landed (the receipt's mtime, inode and size), outside every worker's wall.
    A worker appl-close.sh closed (its marker $HERD_DIR/walls/.closed/<w>, outside the
    worker's wall) is finished and never announced, whatever its own directory holds.

    ISSUE(security-audit-2026-10-09-sweep-spares-a-worke-3bc4-2): land.sh writes the receipt
    BEFORE the worker writes report.md, which quotes the finish lines. A worker herdr no
    longer lists (`listed`, the names of this pass's listings) is announced at once; a listed
    one only when herdr shows it idle/done and both its receipt and the idle stretch this
    watcher has seen (.watch/<w>.landed `idle`, dropped by any pass that sees it otherwise)
    are older than receipt_grace(). A worker herdr shows working -- or blocked at a prompt --
    is never announced. With no listing (`listed` None) nothing is announced: herdr down is
    not a pane gone. RECEIPT_GRACE outlasts the worker's last turn: after its landing returns
    the worker writes report.md in one model turn (seconds to a couple of minutes), and a
    worker that stops short is resumed by this watcher at once (DELAYS[0]) and gets a turn
    more; announcing earlier verified one landing twice, from the receipt and the report."""
    wdir = os.path.join(herd, w)
    if os.path.islink(wdir) or not os.path.isdir(wdir) or closed_marker(herd, w):
        return
    rules = rules_file(wdir)
    if rules is None or report_present(herd, w):
        return
    walls = os.path.join(herd, "walls")
    wall = os.path.join(walls, w)
    if os.path.islink(walls) or os.path.islink(wall):
        return
    try:
        st = os.lstat(os.path.join(wall, "landing-receipt.json"))
    except OSError:
        return
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mtime <= rules[1]:
        return
    key = "%d %d %d" % (st.st_mtime_ns, st.st_ino, st.st_size)
    state, spath = sweep_state(watch, w, "landed")
    if state.get("receipt") == key or listed is None:
        return
    if w in listed:
        if status.get(w) not in IDLE:
            if "idle" in state:
                put_state(spath, {})                   # working again: the idle stretch starts over
            return
        since = state.get("idle")
        if not isinstance(since, (int, float)) or isinstance(since, bool) or since > now:
            since = now
            put_state(spath, {"idle": now})
        grace = receipt_grace()
        if now - st.st_mtime <= grace or now - since <= grace:
            return
    put_state(spath, {"receipt": key})                 # before the line: never twice for one receipt
    emit("REPORT: %s landed without report.md" % w)


def check_receipts(herd, watch, status, listed, now):
    """check_receipt for every worker directory in the herd, listed by herdr or not: the
    sweep may already have closed its pane. status: each listed name's row_status"""
    if os.path.islink(watch):
        return
    try:
        entries = sorted(os.listdir(herd))
    except OSError:
        return
    skip = never_swept()
    for w in entries:
        if NAME_RE.fullmatch(w) and w not in skip:
            check_receipt(w, herd, watch, status, listed, now)


YOUNG_PANE = 2 * 60 * 60           # a pane with no report.md younger than this waits for its intake
CLOSED = ("done", "landed", "split")  # the header statuses that close an intake


def intake_closed(herd, w):
    """True when an intake HEADER status naming w as a whole word begins with done, landed
    or split"""
    idir = os.path.join(herd, "coordinator", "intake")
    for n in intakes_naming(herd, w):
        words = header_status(os.path.join(idir, n))
        if words and words[0] in CLOSED:
            return True
    return False


def no_report_hold(herd, w, state, rules, now):
    """True when the idle sweep holds w, a pane with no report.md: (a) its idle stretch --
    from the first idle/done pass after the last working pass, state `idle` -- is no older
    than receipt_grace(), or (b) its rules file is younger than YOUNG_PANE and no intake
    naming it is closed"""
    if report_present(herd, w):
        return False
    idle = state.get("idle")
    if not isinstance(idle, (int, float)) or isinstance(idle, bool) or now - idle <= receipt_grace():
        return True
    return now - rules[1] < YOUNG_PANE and not intake_closed(herd, w)


def sweep(names, agent_by, tab_by, panes, herd, watch, now, nudged=()):
    """Close the worker panes nobody will use again (2026-09-27). A REPORT the hook BLOCKS
    never reaches the coordinator's model, and a worker pane answering `Not logged in` can do
    nothing; both used to idle forever.

    A candidate is a watched worker -- listed by herdr, with its own non-symlink rules file --
    that is not the coordinator pane and that no intake HEADER status names as live
    (`tests|impl|review <w>`). It is closed through the sibling appl-close.sh, which keeps
    every refusal of its own, and logged `swept <w> <why>` (sweep_why), when herdr's agent_status has been
    idle/done since a pass more than SWEEP_AFTER ago (the time of the first idle pass, or of
    the last pass that saw it working -- a working pass starts the count again), or at once
    when its pane's last reply is `Not logged in` (logged `logged-out <w>` once per spawn,
    and named in the one workers owner step), or at once when appl-hook.sh left it a
    close-requested marker for this spawn (a final BLOCKED report: the hook never calls
    herdr, so it asks, and this pass closes), or at once when it is idle and finished --
    report.md exists and `verified <w>[ <range>]` is in coordinator.log after this spawn,
    or report.md exists and its COMMIT= is an ancestor of main in $HERD_DIR/.repos/<w>
    and its WORKTREE= is gone; a verified line or a landing with no report.md is not
    finished -- logged
    `closed-verified <w>` or `closed-landed <w>` through appl-close.sh, never `herdr tab
    close` from here and never `swept`. A pane with no report.md that only the idle window
    made due is held while no_report_hold says so (the receipt grace, and 2 h for an
    intake not closed); a marker or a logged-out pane is not. An idle pane that is due with
    report.md and no verdict line (unverified_report) is not closed on the first such pass:
    its REPORT line is emitted once more, and the next due pass closes it and logs
    `unverified <w>`. A worker herdr shows `working` this pass is
    never closed (unless its pane is logged out): a marker waits for its first idle pass.
    A pane that is due but whose landing-running marker names a live landing
    (landing_running), or whose landing the launcher runs outside the wall
    (launcher_landing), is left open and logged `sweep-kept <w> landing`. A refusal is `sweep-refused <w>`: nothing is
    forced, the next candidate is still tried, and that worker is not tried again for
    another SWEEP_AFTER. State is .watch/<w>.sweep, since every pass is a fresh process."""
    if os.path.islink(watch):
        return
    coord = os.path.join(herd, "coordinator")
    log_ok = not os.path.islink(coord)
    if log_ok and not os.path.isdir(coord):
        try:
            os.mkdir(coord, 0o700)
        except OSError:
            log_ok = False
    live = live_workers(herd)
    skip = never_swept()
    out_now, newly_out = set(), False
    for w in names:
        agent = agent_by.get(w)
        if w in skip or agent is None:
            continue
        rules = rules_file(os.path.join(herd, w))
        if rules is None:
            continue                                   # not spawned by herd-spawn: not ours
        # a pane already gone (no tab row, a stale agent row) that holds the close-requested
        # marker is closed once, then left alone for this spawn (intake 20261009T193935Z);
        # a tab row again ends that
        gpath = os.path.join(watch, w + ".gone")
        gone = w not in tab_by and marker_present(os.path.join(herd, w))
        if not gone:
            if w in tab_by:
                drop_state(gpath)
        elif sweep_state(watch, w, "gone")[0].get("spawn") == rules[1]:
            continue
        state, spath = sweep_state(watch, w)
        before = dict(state)
        pane = panes.get(w, "")
        out = bool(pane.strip()) and logged_out(pane)
        if pane.strip() and not out:
            revive_ended(herd, watch, w)               # it reads normally again: the revive worked
        asked = close_requested(os.path.join(herd, w), rules[1])   # before this pass writes one
        if out:
            out_now.add(w)
            if state.get("out") != rules[1]:           # once per spawn (the rules file's mtime)
                state["out"] = rules[1]
                newly_out = True
                if log_ok:
                    log_reprompt(coord, w, now, "logged-out")
            if not revivable(pane):                    # a revivable pane's waits for its revive to fail
                file_respawn(w, agent, rules, herd, watch)    # once per spawn, its own state
        elif pane.strip():
            state.pop("out", None)
        status = agent.get("agent_status", (tab_by.get(w) or {}).get("agent_status"))
        since = state.get("since")
        if w in nudged:
            # nudged this pass: its spawn line only now had its chance, so the idle count
            # starts again here and this pass closes nothing
            state["since"] = now
            put_state(spath, state)
            continue
        if status in IDLE or out:
            if not isinstance(since, int):
                since = state["since"] = now
            if status in IDLE and not isinstance(state.get("idle"), int):
                state["idle"] = now                    # the first idle pass after the last working one
        else:
            state["since"] = now                       # working: the count starts again
            state.pop("idle", None)
            state.pop("retyped", None)                 # and so does a re-typed REPORT's wait
            if status != "blocked":                    # a parked pane is not work: a refusal
                state.pop("tried", None)               # of its close waits SWEEP_AFTER
            since = None
        tried = state.get("tried")
        # a pane herdr shows working is at work this pass: never closed, its marker kept for
        # the first idle pass (a logged-out pane keeps its own rule). A logged-out pane
        # keeps the sweep's close; the finished reasons apply only to an idle one.
        finish = finish_reason(herd, w, rules[1]) if status in IDLE and not out else None
        due = (status != "working" or out) and (
            asked or finish or (since is not None and (out or now - since > SWEEP_AFTER)))
        failed = None
        if out and revivable(pane):
            if status not in IDLE or revive_open(watch, w, now):
                due = False                            # not idle or done, or its revive line has not had its chance yet
            else:
                failed = revive_failed(watch, w, rules[1], now)
                if failed == "done":
                    due = False                        # its one close-and-re-spawn already ran
        if (not due or live is None or w in live
                or (isinstance(tried, int) and now - tried <= SWEEP_AFTER)
                or (not (asked or out or finish) and no_report_hold(herd, w, state, rules, now))):
            if state != before:
                put_state(spath, state)
            continue
        # a landing still running in this pane: closing it would SIGTERM the landing. Kept,
        # and asked again on the next pass; the marker never closes anything itself.
        if landing_running(herd, w, coord if log_ok else None, now) or launcher_landing(herd, w):
            if state != before:
                put_state(spath, state)
            if log_ok:
                log_reprompt(coord, w + " landing", now, "sweep-kept")
            continue
        # the worker waits on a background run of its own: closing it would lose that wait
        if bg_waiting(herd, w):
            if state != before:
                put_state(spath, state)
            if log_ok:
                log_reprompt(coord, w + " background", now, "sweep-kept")
            continue
        # a lost REPORT is never final: a report the hook has no verdict on gets its REPORT
        # line once more, and the pane waits one pass for the verdict before it is closed
        unverified = (status in IDLE and not (asked or out or finish)
                      and unverified_report(herd, w, rules[1]))
        if unverified and state.get("retyped") != rules[1]:
            state["retyped"] = rules[1]
            put_state(spath, state)
            emit("REPORT: %s wrote report.md" % w)
            continue
        closed, why = appl_close(w)
        if closed:
            drop_state(spath)
            if gone:
                put_state(gpath, {"spawn": rules[1]})  # its pane was already gone: closed for good
            marker = os.path.join(herd, w, "close-requested")
            if asked or out:
                drop_state(marker)                     # the close it asked for went through
            # a hook's close is the hook's decision: appl-close.sh's `closed <w>` is its record.
            # a finished pane names which condition closed it, and does not also say `swept`.
            if failed == "due":
                if not respawn(w, herd, watch, rules[1], now):   # after the close, never before
                    file_respawn(w, agent, rules, herd, watch, mark=False)   # no resume record
                if log_ok:
                    log_reprompt(coord, w, now, "respawned")
                continue
            if out and revivable(pane):
                # no revive episode ran for it (no tab row, closed since this spawn, or read
                # as a dialog), so its first pass filed nothing: file the one RE-SPAWN intake
                # now, after the close (intake 20261009T165555Z)
                file_respawn(w, agent, rules, herd, watch, mark=False)
            if unverified and log_ok:
                log_reprompt(coord, w, now, "unverified")
            if finish and log_ok:
                log_reprompt(coord, w, now, "closed-" + finish)
            elif (out or not asked) and log_ok:
                log_reprompt(coord, w + " " + sweep_why(herd, w, out), now, "swept")
        else:
            state["tried"] = now
            put_state(spath, state)
            if log_ok:
                log_reprompt(coord, w + (": " + why if why else ""), now, "sweep-refused")
    if newly_out:
        if TARGET_OUT:
            out_now |= {os.environ.get("HERD_WATCH_NOTIFY", "")} - {""}
        workers_step(coord, out_now, now)


# ------------------------------------------------------------------ stuck spawns

NEVER_BRIEFED_AFTER = 900          # a spawn this old that never got its brief is stuck
PARK_AFTER = 20 * 60               # blocked on every pass this long is parked at a prompt


def has_brief(wdir):
    """a REGULAR <wdir>/brief.md whose line was handed over: herd-spawn.sh writes it before
    the pane is started and removes it when nothing was typed into the pane -- except a spawn
    stopped at a first-run prompt, which KEEPS it and leaves $HERD_DIR/.resume/<w> until its
    `--resume` delivers the line (the P0 of 20260929T124218Z). While that record stands the
    brief exists but was never delivered, so it does not count as one here."""
    try:
        if not stat.S_ISREG(os.lstat(os.path.join(wdir, "brief.md")).st_mode):
            return False
    except OSError:
        return False
    return not os.path.lexists(os.path.join(os.path.dirname(wdir), ".resume", os.path.basename(wdir)))


def stalls(names, agent_by, tab_by, herd, watch, now, approved, respawn=True):
    """A worker that never reached its brief, or sits parked at ANY prompt (2026-09-28: a
    spawned worker stopped at its runtime's folder-trust dialog for 16 hours; herd-spawn.sh
    had removed its brief.md, no report came, and the slot stayed taken while other pairs
    queued -- the idle sweep never fires on a `blocked` pane, and nothing looked for a spawn
    that never got its brief).

    Runtime-NEUTRAL by design (owner principle 20260928T125026Z): the judgement is made from
    what herdr reports and what herd-spawn.sh leaves in the herd directory, never from a
    runtime's own configuration file, never from pane text, and the prompt is never answered.

    A candidate is a watched worker -- listed, its own non-symlink rules file, not the
    coordinator pane. It is
      never-briefed: no regular brief.md, no report newer than its rules file, never shown
        `working` by herdr on any pass this watcher made, and a rules file more than
        NEVER_BRIEFED_AFTER old (judged on the first pass that sees it);
      parked: herdr's status `blocked` on every pass for more than PARK_AFTER, counted from
        the first blocked pass; any other status, or a prompt this pass approved, starts the
        count over.
    On detection, once per spawn: `<UTC time> never-briefed|parked <w>` in coordinator.log,
    and file_respawn -- the close-requested marker the sweep then acts on through
    appl-close.sh (whose refusals all stand), and ONE `RE-SPAWN <w>` intake shared with the
    login-expiry filing. State is .watch/<w>.stall, keyed by the rules file's mtime, because
    every pass is a fresh process."""
    if os.path.islink(watch):
        return
    coord = os.path.join(herd, "coordinator")
    log_ok = not os.path.islink(coord)
    if log_ok and not os.path.isdir(coord):
        try:
            os.mkdir(coord, 0o700)
        except OSError:
            log_ok = False
    skip = never_swept()
    for w in names:
        agent = agent_by.get(w)
        if w in skip or agent is None:
            continue
        wdir = os.path.join(herd, w)
        rules = rules_file(wdir)
        if rules is None:
            continue                                   # not spawned by herd-spawn: not ours
        state, spath = sweep_state(watch, w, "stall")
        if state.get("spawn") != rules[1]:
            state = {"spawn": rules[1]}                # a new spawn starts afresh
        before = dict(state)
        status = agent.get("agent_status", (tab_by.get(w) or {}).get("agent_status"))
        if status == "working":
            state["worked"] = True
        if status == "blocked" and w not in approved:
            if not isinstance(state.get("blocked"), int):
                state["blocked"] = now
        else:
            state.pop("blocked", None)
        why = state.get("flagged") if state.get("flagged") in RESPAWN_WHY else None
        if why is None:
            if (not state.get("worked") and not has_brief(wdir) and current_report(wdir) is None
                    and now - rules[1] > NEVER_BRIEFED_AFTER):
                why = "never-briefed"
            elif isinstance(state.get("blocked"), int) and now - state["blocked"] > PARK_AFTER:
                why = "parked"
            if why is not None:
                state["flagged"] = why                 # one line per spawn, even if filing fails
                if log_ok:
                    log_reprompt(coord, w, now, why)
        if state != before:
            put_state(spath, state)
        if why is not None and respawn:
            file_respawn(w, agent, rules, herd, watch, why)   # once per spawn; retried if it failed


# ------------------------------------------------------------------ a stopped seat

SEAT_LINE = (
    "Every pane has stopped. This turn is not over. "
    "List the panes and the open intakes. "
    "Prompt an idle or done pane that still has work. "
    "Close a pane that has finished. "
    "A free slot starts the next eligible intake. "
    "Do not end the turn while one of those remains. "
    "Do not send y, tab, or shift+tab."
)


def save_seat(path, obj):
    tmp = path + ".tmp"
    try:
        if os.path.islink(tmp):
            os.unlink(tmp)
        write_file(tmp, json.dumps(obj, sort_keys=True) + "\n")
        os.replace(tmp, path)
    except OSError:
        pass


def hook_kinds():
    """The event kinds appl-hook.sh beside this script accepts, from its --kinds (one per
    line). An empty list when the hook is missing, fails or times out: the watcher keeps
    no copy of its own, so nothing it cannot confirm is typed into a claude pane."""
    hook = os.path.join(os.environ.get("HERD_WATCH_HERE", ""), "appl-hook.sh")
    try:
        r = subprocess.run(["bash", hook, "--kinds"], stdin=subprocess.DEVNULL,
                           capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return []
    if r.returncode != 0:
        return []
    return [ln.strip() for ln in r.stdout.splitlines() if ln.strip()]


def seat_stopped(agents, herd, watch, now):
    """Prompt the idle or done coordinator when every other pane has stopped.
    See the header comment 'A stopped seat'. Nothing is edited. The same stop is
    prompted again when this pane has been working since the sentence, and again
    after GRACE if that turn never started. A stored cap does not silence it."""
    target = os.environ.get("HERD_WATCH_NOTIFY", "")
    if not target or not NAME_RE.fullmatch(target) or agents is None or TARGET_OUT:
        return
    row = next((a for a in agents if isinstance(a, dict) and a.get("name") == target), None)
    if row is None:
        return
    coord = os.path.join(herd, "coordinator")
    if os.path.islink(coord):
        return
    spath = os.path.join(watch, "seat-stopped.json")
    try:
        prev = json.loads(read_file(spath) or "")
    except ValueError:
        prev = None
    if not isinstance(prev, dict):
        prev = None
    status = row.get("agent_status")
    if status == "working":
        if (prev is not None and prev.get("saw") is not True
                and isinstance(prev.get("sig"), str) and isinstance(prev.get("at"), int)):
            prev["saw"] = True
            save_seat(spath, prev)
        return
    if status not in IDLE:
        return
    parts = []
    for a in agents:
        if not isinstance(a, dict):
            return
        name = a.get("name")
        if name == target:
            continue
        st = a.get("agent_status")
        if not isinstance(name, str) or not NAME_RE.fullmatch(name):
            return
        if not isinstance(st, str) or st == "":
            return
        if st == "working":
            return
        parts.append(name + "=" + st)
    if not parts:
        return
    sig = " ".join(sorted(parts))
    if target in TYPED_THIS_PASS:
        save_seat(spath, {"at": now, "saw": False, "sig": sig})
        return
    if prev is not None and prev.get("sig") == sig and isinstance(prev.get("at"), int):
        if prev.get("saw") is not True and now - prev["at"] < GRACE:
            return
    if not still_idle(target):
        return
    if spawn_harness(herd, target) == "claude" and "seat" not in hook_kinds():
        return                       # its hook would block the sentence as no event
    if coord_prompt(target, SEAT_LINE)[0] != 0:
        return
    typed(watch, target, SEAT_LINE)
    if os.path.isdir(coord):
        log_reprompt(coord, target, now, "seat")
    save_seat(spath, {"at": now, "saw": False, "sig": sig})


# ------------------------------------------------------------------ the backlog pull

COORD_AGENT = "dispatch-mac-a"     # the token herd-spawn marks the coordinator pane with


def free_worker_slots(agents, herd):
    """How many worker slots are free, or None when the cap cannot be read.
    The coordinator pane does not hold a slot. A row with no status does, so a
    missing status fails toward fewer spawns. `working` and `blocked` hold one;
    `idle` and `done` do not."""
    if agents is None:
        return None
    coord = os.path.join(herd, "coordinator")
    if os.path.islink(coord):
        return None
    try:
        fd = os.open(os.path.join(coord, "worker-cap"), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    try:
        text = os.read(fd, 64).decode("ascii", "replace").strip()
    except OSError:
        return None
    finally:
        os.close(fd)
    if not re.fullmatch(r"[0-9]{1,6}", text):
        return None
    return int(text) - slot_holders(agents)


def slot_holders(agents):
    """the rows of a listing that hold a worker slot (free_worker_slots' count)"""
    skip = never_swept() | {os.environ.get("APPL_COORDINATOR_NAME") or COORDINATOR}

    def coordinator(a):
        t = a.get("tokens")
        return a.get("name") in skip or (isinstance(t, dict) and t.get("muretai_agent") == COORD_AGENT)

    def holds_slot(a):
        if coordinator(a):
            return False
        status = a.get("agent_status")
        if not isinstance(status, str) or status == "":
            return True
        return status in ("working", "blocked")

    return sum(1 for a in agents if holds_slot(a))


_PROJECT_PRIORITY = []


def project_priority_mod():
    """scripts/project_priority.py, loaded once: the one reader of project-priority"""
    if not _PROJECT_PRIORITY:
        try:
            mod = load_sibling("project_priority")
        except (OSError, KeyError, ImportError, AttributeError, SyntaxError, ValueError):
            mod = None
        _PROJECT_PRIORITY.append(mod)
    return _PROJECT_PRIORITY[0]


def project_lines(coord):
    """coordinator/project-priority's repo names, first line first, through
    project_priority.py (a ` share=<n>` or ` role=<role>` word is not part of the name).
    A missing file, a symlink, a line with a control character, or a reader that does
    not load is no priority: callers then sort by age."""
    mod = project_priority_mod()
    return mod.names(coord) if mod else []


def project_rank(repo, lines):
    """the line index of this repo, or len(lines) when it is unlisted. A line
    with no slash matches the repo path's last component (project_priority.rank)."""
    mod = project_priority_mod()
    return mod.rank(repo, lines) if mod else len(lines)


def intake_slot_view(path):
    """(status words, repo, mtime, lane) from a regular intake, or None. lane is
    the word fast when the header says so, else "". The open rules are
    header_status's: no symlink, no fifo, header only."""
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode):
        return None
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            return None
        data = os.read(fd, HEADER_MAX).decode("utf-8", "replace")
    except OSError:
        return None
    finally:
        os.close(fd)
    words, repo, lane = None, "", ""
    for line in data.split("\n"):
        if line == "":
            break
        if line.startswith("status:") and words is None:
            words = line[len("status:"):].split()
        elif line.startswith("repo:") and repo == "":
            repo = line[len("repo:"):].strip()
        elif line.startswith("lane:") and lane == "":
            if line[len("lane:"):].split() == ["fast"]:
                lane = "fast"
    if not words:
        return None
    return words, repo, st.st_mtime, lane


def save_slot(path, obj):
    tmp = path + ".tmp"
    try:
        if os.path.islink(tmp):
            os.unlink(tmp)
        write_file(tmp, json.dumps(obj, sort_keys=True) + "\n")
        os.replace(tmp, path)
    except OSError:
        pass


def slot_intake(agents, herd, watch, now):
    """Type one intake into the idle or done coordinator when a worker slot is free.
    See the header comment 'A free slot'. Nothing is edited."""
    target = os.environ.get("HERD_WATCH_NOTIFY", "")
    if not target or not NAME_RE.fullmatch(target) or agents is None or TARGET_OUT:
        return
    row = next((a for a in agents if isinstance(a, dict) and a.get("name") == target), None)
    if row is None:
        return
    spath = os.path.join(watch, "slot-intake.json")
    try:
        prev = json.loads(read_file(spath) or "")
    except ValueError:
        prev = None
    if not isinstance(prev, dict):
        prev = None
    status = row.get("agent_status")
    if status == "working":
        if prev is not None and prev.get("saw") is not True:
            prev["saw"] = True
            save_slot(spath, prev)
        return
    if status not in ("done", "idle"):
        return
    if (free_worker_slots(agents, herd) or 0) <= 0:
        return
    coord = os.path.join(herd, "coordinator")
    idir = os.path.join(coord, "intake")
    if os.path.islink(coord) or os.path.islink(idir) or not os.path.isdir(idir):
        return
    live = {a.get("name") for a in agents if isinstance(a, dict) and isinstance(a.get("name"), str)} - {target}
    lines = project_lines(coord)
    found = []
    try:
        entries = os.listdir(idir)
    except OSError:
        return
    for name in entries:
        if not INTAKE_RE.fullmatch(name):
            continue
        view = intake_slot_view(os.path.join(idir, name))
        if view is None:
            continue
        words, repo, mtime, lane = view
        if any(w in live for w in words):
            continue
        if words == ["blocked", "after"]:
            pass
        elif words and words[0] == "new" and now - mtime <= GRACE:
            pass
        else:
            continue
        # project rank, then lane: fast ahead of the rest, then the older file name
        found.append((project_rank(repo, lines), 0 if lane == "fast" else 1, name,
                      os.path.join(idir, name)))
    found.sort()
    eligible = {name for _, _, name, _ in found}
    if prev is not None and isinstance(prev.get("at"), int) and isinstance(prev.get("name"), str):
        age = now - prev["at"]
        if prev.get("saw") is not True and age < GRACE:
            return
        if prev.get("saw") is True and prev["name"] in eligible and age < GRACE:
            return
    if not found:
        return
    _, _, name, path = found[0]
    if coord_prompt(target, "intake " + path)[0] != 0:
        return
    typed(watch, target, "intake " + path)
    log_reprompt(coord, name, now, "slot")
    save_slot(spath, {"at": now, "name": name, "saw": False})


def backlog_pull(agents, herd):
    """Once per pass, when a slot is free, run the backlog pull (appl-backlog-pull.sh), so an
    idea in the backlog inbox is filed without waiting for the next landing or SessionStart.
    Live is this pass's own `herdr agent list` rows other than the coordinator pane (the
    --notify target, a row named muretai-coordinator or $APPL_COORDINATOR_NAME -- the
    pull's own name for it -- or one whose tokens.muretai_agent is dispatch-mac-a) whose
    agent_status is `working` or `blocked`. `idle` and `done` do not count. A row whose
    status cannot be read does, so a missing status fails toward fewer spawns. The cap
    is the one number in <HERD_DIR>/coordinator/worker-cap, the
    pull's own source. A failed listing, no readable cap, or live >= cap: the pull is not
    run. The seam is appl-hook.sh's, APPL_BACKLOG_PULL (an executable run in place of
    `bash <scripts>/appl-backlog-pull.sh`). --repo is $APPL_BACKLOG_REPO alone when it is an
    absolute path (no fallback); else each dispatch repo with a backlog or an inbox
    (backlog_repos), in file order, stopping at the first pull that files. The pull counts
    again under its own lock and files at most one intake; its output never reaches this
    pass's stdout (fixed vocabulary only)."""
    if agents is None or TARGET_OUT:
        return                                         # logged out: appl-add would type into it
    if (free_worker_slots(agents, herd) or 0) <= 0:
        return
    coord = os.path.join(herd, "coordinator")
    here = os.environ.get("HERD_WATCH_HERE", "")
    exe = os.environ.get("APPL_BACKLOG_PULL", "")
    argv = [exe] if exe else ["bash", os.path.join(here, "appl-backlog-pull.sh")]
    repo = os.environ.get("APPL_BACKLOG_REPO", "")
    if repo.startswith("/"):
        pull_one(argv, repo, None, herd, coord)          # the override: that repo, no fallback
        return
    for name, path in backlog_repos(coord):
        if pull_one(argv, path, name, herd, coord):
            return                                     # one intake per pass


FUZZ_KICK_EVERY = 300              # seconds between two starts of the idle fuzz run


def fuzz_idle_kick(agents, herd, watch, now):
    """The idle fuzz run (intake 20261024T203610Z, "Fuzz chain F5"). When this pass's listing
    shows no worker row working or blocked (the backlog pull's count, against a cap of one),
    start tools/fuzz_idle.py beside this skill -- the installed APPL's -- with one --root per
    dispatch repo, DETACHED: its own session, stdin closed, output appended to
    <HERD_DIR>/coordinator/fuzz-idle.log, never waited for, so a pass returns while a harness
    runs. fuzz_idle.py takes its own lock (one run at a time), checks idle and the memory
    floor itself and yields to a pane that turns active. At most one start per
    FUZZ_KICK_EVERY (.watch/fuzz-idle.kick), and none once <HERD_DIR>/coordinator/
    fuzz-idle.done holds today's UTC date. Nothing it prints reaches this pass's stdout."""
    if not isinstance(agents, list) or not all(isinstance(a, dict) for a in agents):
        return                                         # a listing this pass cannot read is not idle
    if TARGET_OUT:
        return                                         # logged out: a filed crash would type into it
    if slot_holders(agents) != 0:
        return
    coord = os.path.join(herd, "coordinator")
    done = read_regular(os.path.join(coord, "fuzz-idle.done"), 32)
    if done is not None and done[0].decode("ascii", "replace").strip() == time.strftime("%Y-%m-%d", time.gmtime()):
        return
    kpath = os.path.join(watch, "fuzz-idle.kick")
    kick = read_regular(kpath, 32)
    try:
        if kick is not None and now - int(kick[0].decode("ascii", "replace").strip()) < FUZZ_KICK_EVERY:
            return
    except ValueError:
        pass
    here = os.environ.get("HERD_WATCH_HERE", "")
    tool = os.path.normpath(os.path.join(here, "..", "..", "..", "..", "tools", "fuzz_idle.py"))
    roots = [path for _, path in dispatch_repos()]
    if not roots or not os.path.isfile(tool) or os.path.islink(tool):
        return
    argv = ["python3", "-I", "-B", tool]
    for path in roots:
        argv += ["--root", path]
    try:
        fd = os.open(os.path.join(coord, "fuzz-idle.log"),
                     os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError:
        return
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return
        subprocess.Popen(argv, cwd=coord, env=dict(os.environ, HERD_DIR=herd), stdin=subprocess.DEVNULL,
                         stdout=fd, stderr=fd, start_new_session=True, close_fds=True)
    except (OSError, subprocess.SubprocessError):
        return
    finally:
        os.close(fd)
    put_raw(kpath, "%d\n" % now)


def main_verdict_tips(herd):
    """The new-tip check of the main-verdict gate run (intake 20261030T141936Z): once per pass,
    for each <HERD_DIR>/coordinator/main-verdicts/<name>/ whose `repo` file a landing recorded
    (land.sh's launch writes it), start tools/main_verdict.py's tip source detached. It runs
    refs/heads/main of that primary only when no run of that tip has started, so a pass with
    nothing new costs one rev-parse. Its output goes to <name>/main-verdict.log; nothing here
    waits on it. A herd no landing recorded a primary in starts nothing."""
    here = os.environ.get("HERD_WATCH_HERE", "")
    tool = os.path.normpath(os.path.join(here, "..", "..", "..", "..", "tools", "main_verdict.py"))
    base = os.path.join(herd, "coordinator", "main-verdicts")
    if not here or not os.path.isfile(tool) or os.path.islink(tool) or os.path.islink(base):
        return
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return
    for name in names:
        state = os.path.join(base, name)
        if not REPO_NAME_RE.fullmatch(name) or os.path.islink(state) or not os.path.isdir(state):
            continue
        raw = read_regular(os.path.join(state, "repo"), 4096)
        repo = raw[0].decode("utf-8", "replace").strip() if raw is not None else ""
        if not os.path.isabs(repo) or not os.path.isdir(repo):
            continue
        argv = ["python3", "-I", "-B", tool, "tip", "--repo", repo, "--state", state]
        try:
            fd = os.open(os.path.join(state, "main-verdict.log"),
                         os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        except OSError:
            continue
        try:
            if stat.S_ISREG(os.fstat(fd).st_mode):
                subprocess.Popen(argv, cwd=state, env=dict(os.environ, HERD_DIR=herd),
                                 stdin=subprocess.DEVNULL, stdout=fd, stderr=fd,
                                 start_new_session=True, close_fds=True)
        except (OSError, subprocess.SubprocessError):
            pass
        finally:
            os.close(fd)


def dispatch_repos():
    """(name, path) per `<name>=<absolute path>` line of the dispatch repos ($DISPATCH_DIR/repos,
    default ~/.muretai/dispatch/repos), in file order, first spelling of a name wins; comments,
    relative paths and names outside REPO_NAME_RE are skipped."""
    d = os.environ.get("DISPATCH_DIR") or os.path.join(HOME, ".muretai", "dispatch")
    try:
        fd = os.open(os.path.join(d, "repos"), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return []
    try:
        data = os.read(fd, 1 << 16).decode("utf-8", "replace")
    except OSError:
        return []
    finally:
        os.close(fd)
    out, seen = [], set()
    for line in data.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, sep, path = line.partition("=")
        name, path = name.strip(), path.strip()
        if not sep or not path.startswith("/") or not REPO_NAME_RE.fullmatch(name) or name in seen:
            continue
        seen.add(name)
        out.append((name, os.path.normpath(path)))
    return out


REPO_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


def backlog_repos(coord):
    """(name, path) per `<name>=<absolute path>` line of the dispatch repos ($DISPATCH_DIR/repos,
    default ~/.muretai/dispatch/repos), in file order, first spelling of a name wins; comments,
    relative paths and names outside REPO_NAME_RE are skipped. Kept: a repo with a
    docs/BACKLOG.md or an existing <coord>/backlog/<name>/inbox directory."""
    return [(name, path) for name, path in dispatch_repos()
            if os.path.isfile(os.path.join(path, "docs", "BACKLOG.md"))
            or os.path.isdir(os.path.join(coord, "backlog", name, "inbox"))]


def pull_one(argv, repo, name, herd, coord):
    """run the pull for one repo; True when it filed (exit 0 and the intake's path on stdout).
    A non-zero exit is `<UTC time> backlog-pull-refused <name>` in coordinator.log (for a
    listed repo); its output is never read, logged or echoed."""
    try:
        r = subprocess.run(argv + ["--repo", repo], env=dict(os.environ, HERD_DIR=herd),
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
    except (OSError, subprocess.SubprocessError):
        return False
    if r.returncode != 0:
        if name is not None:
            log_reprompt(coord, name, clock(), "backlog-pull-refused")
        return False
    return bool(r.stdout.strip())


# ------------------------------------------------------------------ the stall nudge

NUDGE_AFTER = 180                  # a spawn record this old whose line did not land is nudged
_BAR, _MARK = chr(0x2502), chr(0x276F)         # the box's side bar and the other prompt mark
PROMPT_ROW_RE = re.compile(r"\s*" + _BAR + r"?\s*[>" + _MARK + r"](?: (.*?))?\s*" + _BAR + r"?\s*")
PLACEHOLDER_RE = re.compile(r"Try \"[^\"]*\"")
KEY_RE = re.compile(r"[A-Za-z0-9_+-]{1,32}")    # one herdr key name, as wake-deliver.sh takes it
DEFAULT_CLAUSE = "Open the brief with your Read tool, not with a shell command."
_DECLS = {}


def declaration(harness):
    """harness's wake adapter declaration, `wake-adapter.sh show <harness>` beside this script,
    as a dict; None when the adapter refuses it or the name is not one plain word. Read once
    per pass and harness."""
    if harness not in _DECLS:
        got = None
        if re.fullmatch(r"[a-z0-9-]{1,32}", harness or ""):
            path = os.path.join(os.environ.get("HERD_WATCH_HERE", ""), "wake-adapter.sh")
            try:
                r = subprocess.run(["bash", path, "show", harness], stdin=subprocess.DEVNULL,
                                   capture_output=True, text=True, encoding="utf-8", timeout=30)
            except (OSError, subprocess.SubprocessError):
                r = None
            if r is not None and r.returncode == 0:
                got = {}
                for ln in r.stdout.splitlines():
                    k, sep, v = ln.partition("=")
                    if sep:
                        got[k] = v
        _DECLS[harness] = got
    return _DECLS[harness]


def selected_adapter():
    """the harness the machine.toml [wake] knob selects (`wake-adapter.sh select`), or "";
    asked once per pass"""
    if "\0select" not in _DECLS:
        path = os.path.join(os.environ.get("HERD_WATCH_HERE", ""), "wake-adapter.sh")
        word = ""
        try:
            r = subprocess.run(["bash", path, "select"], stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, encoding="utf-8", timeout=30)
            word = (r.stdout or "").strip() if r.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError):
            pass
        _DECLS["\0select"] = word if re.fullmatch(r"[a-z0-9-]{1,32}", word) else ""
    return _DECLS["\0select"]


def pane_harness(herd, w):
    """(harness, declaration) for w's pane: the harness of its herd-spawn.sh record, or the
    [wake] knob's when there is no record at all. The declaration is None for a record that
    does not parse ("?") and for a harness the adapter refuses; the harness word is then
    still returned, so the refusal can name it."""
    h = spawn_harness(herd, w)
    if h == "":
        h = selected_adapter()
    if not h or h == "?":
        return h or "?", None
    return h, declaration(h)


def spawn_line(herd, w, clause=None):
    """herd-spawn.sh's own line (first_line_for), built from abspath(HERD_DIR)/<w> -- never
    read from a file. clause is the harness's declared spawn_clause ("" for none); None is the
    Read-tool clause."""
    wdir = os.path.join(herd, w)
    clause = DEFAULT_CLAUSE if clause is None else clause
    return ("Read " + os.path.join(wdir, "brief.md") + " and follow it. Your report goes to "
            + os.path.join(wdir, "report.md") + "." + (" " + clause if clause else ""))


def last_prompt_row(pane, mark=None):
    """what the pane's LAST prompt line holds (escapes dropped, stripped), or None. A prompt
    row opens with `>` or with mark, a harness's declared input_row (U+276F when None)."""
    if mark:
        row_re = re.compile(r"\s*" + _BAR + r"?\s*(?:>|" + re.escape(mark) + r")(?: (.*?))?\s*" + _BAR + r"?\s*")
    else:
        row_re = PROMPT_ROW_RE
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?", "", pane)
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text)
    last = None
    for row in text.splitlines():
        m = row_re.fullmatch(row)
        if m:
            last = (m.group(1) or "").strip()
    return last


def prompt_shape(pane, line, mark=None):
    """'typed' when the pane's LAST prompt line is exactly line, 'empty' when it shows the
    runtime's placeholder, else None -- herd-spawn.sh's stall_shape, in the same words"""
    last = last_prompt_row(pane, mark)
    if last is None:
        return None
    if last == line:
        return "typed"
    return "empty" if PLACEHOLDER_RE.fullmatch(last) else None


def nudge(w, agent, tab, pane, herd, watch, now):
    """The spawn line that did not land (2026-09-30: a worker sat at the placeholder for the
    whole grace period and the idle sweep closed it without a key pressed). A watched worker
    herdr shows `idle`, not the coordinator pane, with its brief.md handed over and no current
    report, never seen working for this spawn, at least NUDGE_AFTER after its spawn record
    (the rules file's mtime), whose pane shows one of herd-spawn's two stall shapes, gets the
    same nudge: one Enter for the typed-but-unsubmitted spawn line, or one re-send of the
    spawn line at the empty prompt. Once per spawn record (.watch/<w>.nudge, the watcher's own
    directory, holds the rules file's mtime), logged `<UTC time> nudged <w>`. The only key is
    Enter and the only text the line this function builds; nothing read from the pane is
    typed. A dialog and a logged-out pane never get here. True when it nudged this pass."""
    if w in never_swept() or agent is None:
        return False
    status = agent.get("agent_status", (tab or {}).get("agent_status"))
    if status != "idle":
        return False
    wdir = os.path.join(herd, w)
    rules = rules_file(wdir)
    if rules is None or now - rules[1] < NUDGE_AFTER or not has_brief(wdir) or current_report(wdir) is not None:
        return False
    stall, _ = sweep_state(watch, w, "stall")
    if stall.get("spawn") == rules[1] and stall.get("worked"):
        return False                                   # it took its brief: an idle prompt now is its own
    state, spath = sweep_state(watch, w, "nudge")
    if state.get("spawn") == rules[1]:
        return False
    # the row, the key and the line's wording are the harness's declared ones; a harness the
    # adapter refuses is named and gets nothing, never a default
    harness, decl = pane_harness(herd, w)
    if decl is None or not decl.get("input_row") or not KEY_RE.fullmatch(decl.get("resubmit", "")):
        detail(watch, w, "NUDGE refused: harness %s has no wake adapter declaration" % harness)
        return False
    clause = decl.get("spawn_clause", "")
    line = spawn_line(herd, w, "" if clause == "none" else clause)
    shape = prompt_shape(pane or "", line, decl["input_row"])
    if shape is None or not still_idle(w):
        return False                                   # no Enter, no line, at a pane that changed
    put_state(spath, {"spawn": rules[1]})              # before the key: never twice for one record
    if shape == "typed":
        ok = herdr("agent", "send-keys", w, decl["resubmit"])[0] == 0
    else:
        ok = herdr("agent", "prompt", w, line)[0] == 0
    detail(watch, w, "NUDGE %s: %s" % ("enter" if shape == "typed" else "re-send", "ok" if ok else "failed"))
    coord = os.path.join(herd, "coordinator")
    if not os.path.islink(coord):
        if not os.path.isdir(coord):
            try:
                os.mkdir(coord, 0o700)
            except OSError:
                pass
        log_reprompt(coord, w, now, "nudged")
    if shape != "typed" and ok:
        typed(watch, w, line)
    return True


# ------------------------------------------------------------------ the login revive

REVIVE = "continue with the brief"     # the one line typed: a constant, never pane text
LOGIN_GRACE = 30                   # seconds an expired-login episode waits before its line


def login_grace():
    """HERD_WATCH_LOGIN_GRACE_S as seconds >= 0, else LOGIN_GRACE (non-numeric, negative or
    empty included)"""
    try:
        v = float(os.environ.get("HERD_WATCH_LOGIN_GRACE_S", ""))
    except ValueError:
        return LOGIN_GRACE
    return v if 0 <= v < 1e7 else LOGIN_GRACE


def row_status(agent, tab):
    """A pane's agent_status on this pass: its agent row's, from the pass's one agent listing.
    The tab row is read only for a pane herdr lists no agent row for; it never overrides the
    agent row (ISSUE security-audit-2026-10-09-pin-that-herd-watch-54fc: the revive's blocked
    guard read the tab row while the sweep and the nudge read the agent row)."""
    if agent is not None:
        return agent.get("agent_status")
    return (tab or {}).get("agent_status")


def revive_may_type(agent, tab):
    """The one blocked check of every login revive, worker and coordinator alike: herdr shows
    the pane `idle` or `done`, never `blocked` -- a permission prompt can display a command
    ending in `Login expired`, and the Enter after a typed line would approve it."""
    return row_status(agent, tab) in IDLE


def still_idle(w, by_tab=False):
    """The pass's status is a snapshot: a pane listed idle can raise a permission prompt
    before this watcher types, and the Enter of a typed line, or an Enter alone, would answer
    it (ISSUE security-audit-2026-10-09-pin-that-herd-watch-54fc). So w's agent status is
    re-listed from herdr just before a line or a key goes into its pane, with nothing read or
    typed between, and True only when that one row says `idle` or `done`. A re-list that
    fails, is empty or not JSON, has no row for w or more than one, or any other status:
    False, and nothing is typed. by_tab (a pane the pass listed no agent row for, restarted
    in its tab): with no agent row now either, w's one tab row decides instead, as row_status
    reads it; an agent row, when there is one, is never overridden."""
    rows = listing("agent")
    if rows is None:
        return False
    mine = [r for r in rows if r.get("name") == w]
    if not mine and by_tab:
        mine = [r for r in listing("tab") or [] if r.get("label") == w]
    return len(mine) == 1 and mine[0].get("agent_status") in IDLE


def closed_since(herd, w, spawn):
    """appl-close.sh closed this spawn: its marker walls/.closed/<w> is newer than the rules
    file herd-spawn rewrites on every spawn"""
    if not closed_marker(herd, w):
        return False
    try:
        return int(os.lstat(os.path.join(herd, "walls", ".closed", w)).st_mtime) > spawn
    except OSError:
        return False


def revive_open(watch, w, now):
    """an expired-login episode of w whose line is not typed yet, or was typed less than the
    grace ago: the sweep leaves that pane open (it is live, not swept)"""
    state, _ = sweep_state(watch, w, "revive")
    if not isinstance(state.get("seen"), int):
        return False
    done = state.get("typed")
    return not isinstance(done, int) or now - done < login_grace()


def revive_failed(watch, w, spawn, now):
    """"due" when w's revive line was typed at least login_grace() ago in an episode that
    herdr has not ended (main_once drops the record on a working pass) and no
    close-and-re-spawn ran for it yet; "done" when one already ran for this spawn; else None"""
    state, _ = sweep_state(watch, w, "revive")
    if state.get("respawned") == spawn:
        return "done"
    done = state.get("typed")
    if isinstance(done, int) and now - done >= login_grace():
        return "due"
    return None


def revive_ended(herd, watch, w):
    """The episode of w is over -- herdr shows it working, or its pane reads normally again --
    so the revive worked: its record goes, and with it the close-requested marker
    file_respawn left on the first logged-out pass (a marker whose first word is a
    RESPAWN_WHY reason), which would otherwise close the pane the revive saved. A marker
    appl-hook.sh wrote is kept. Nothing when no episode was recorded."""
    state, spath = sweep_state(watch, w, "revive")
    if not isinstance(state.get("seen"), int):
        return
    drop_state(spath)
    marker = os.path.join(herd, w, "close-requested")
    got = read_regular(marker, 256)
    if got is not None and got[0].decode("ascii", "replace").split(" ", 1)[0] in RESPAWN_WHY:
        drop_state(marker)


def respawn(w, herd, watch, spawn, now):
    """2026-10-09, item 2 of 20261009T102930Z: the one revive line did not bring w back, and
    the sweep has just closed its tab through appl-close.sh. Re-spawn it, once per episode
    (the episode record notes this spawn's rules mtime before anything runs): the sibling
    `herd-spawn.sh --resume <w>` with this watcher's HERD_DIR when $HERD_DIR/.resume/<w>
    holds a resume record. True only when that resume exited 0; False -- no record, a
    non-zero exit, a time-out or OSError (intake 20261009T165556Z) -- tells the sweep to file
    the one RE-SPAWN intake through file_respawn now, after the close -- the intake a revivable pane
    was not given on its first logged-out pass (intake 20261009T123123Z)."""
    state, spath = sweep_state(watch, w, "revive")
    state["respawned"] = spawn
    put_state(spath, state)
    rec = os.path.join(herd, ".resume", w)
    try:
        if not stat.S_ISREG(os.lstat(rec).st_mode) or os.path.islink(os.path.dirname(rec)):
            return False
    except OSError:
        return False
    here = os.environ.get("HERD_WATCH_HERE", "")
    env = dict(os.environ)
    env["HERD_DIR"] = herd
    try:
        r = subprocess.run(["bash", os.path.join(here, "herd-spawn.sh"), "--resume", w],
                           stdin=subprocess.DEVNULL, capture_output=True, text=True,
                           timeout=120, env=env)
    except (OSError, subprocess.SubprocessError):
        detail(watch, w, "RESPAWN resume: failed")
        return False
    detail(watch, w, "RESPAWN resume: %s" % ("ok" if r.returncode == 0 else "failed"))
    return r.returncode == 0


def revive(w, tab, agent, pane, herd, watch, now):
    """2026-10-09: twice in one day every claude worker pane stopped at its `Login expired`
    or `OAuth token revoked` screen, and one typed line revived each -- the
    session refreshes its login on its next turn. A watched worker (listed as a tab and an
    agent, its own rules file, not closed by appl-close.sh since this spawn, never the
    coordinator pane) whose last reply line BEGINS with one of REVIVABLE gets, once
    login_grace() has passed since the first pass that saw the episode, ONE `herdr agent
    prompt <w> REVIVE` and `<UTC time> revived <w>` in coordinator.log. Once per episode:
    the episode ends when herdr shows the pane `working` (main_once drops the record), and a
    later expired screen is a new one with its own grace and its own line. The record is
    .watch/<w>.revive, the herd's own state, never <HERD_DIR>/<w> or the worktree. Nothing
    read from the pane is typed or printed. True when it typed this pass."""
    if w in never_swept() or agent is None or tab is None or not NAME_RE.fullmatch(w):
        return False
    if not revive_may_type(agent, tab):
        return False                                   # blocked: Enter could approve a prompt
    if not revivable(pane):
        return False
    rules = rules_file(os.path.join(herd, w))
    if rules is None or closed_since(herd, w, rules[1]):
        return False
    state, spath = sweep_state(watch, w, "revive")
    if isinstance(state.get("respawned"), (int, float)) and state["respawned"] != rules[1]:
        state = {}                                     # a re-spawn since: a new pane, a new episode
    if not isinstance(state.get("seen"), int):
        put_state(spath, {"seen": now})                # the episode starts: its grace counts from here
        return False
    if "typed" in state or now - state["seen"] <= login_grace():
        return False                                   # the grace has passed only once it is exceeded
    if not still_idle(w):
        return False                                   # changed since the listing: a later pass asks again
    state["typed"] = now
    put_state(spath, state)                            # before the line: never twice for one episode
    ok = herdr("agent", "prompt", w, REVIVE)[0] == 0
    detail(watch, w, "REVIVE prompt: %s" % ("ok" if ok else "failed"))
    if not ok:
        return False
    typed(watch, w, REVIVE)
    coord = os.path.join(herd, "coordinator")
    if not os.path.islink(coord):
        if not os.path.isdir(coord):
            try:
                os.mkdir(coord, 0o700)
            except OSError:
                pass
        log_reprompt(coord, w, now, "revived")
    return True


# ------------------------------------------------------------------ the publisher's status
# intake 20261027T165043Z: nothing in the loop read the publisher's status, so a repository
# sat at result=held for two weeks unannounced. Each pass reads
# $MURETAI_PUBLISHER_STATUS/<repo>.txt for every dispatch repo, read-only, opened without
# following a link, as a regular file, under a size cap and never blocking on a FIFO. A change
# to held, or a new reason while held, is ONE line `PUBLISHER: <repo> held <reason[:160]>`;
# held turning published or up-to-date is `PUBLISHER: <repo> <result>`, so appl-hook.sh can
# close the repo's intake. The reason is folded to one line. A file that is missing, not a
# regular file or malformed gives no line and is logged once, not once per pass.

PUBLISHER_STATUS = "/Users/Shared/muretai-publisher/status"
PUBLISHER_CAP = 1 << 16            # bytes: a longer status file is malformed
PUBLISHER_CUT = 160                # chars of the reason the line carries
PUBLISHER_KEYS = ("repo", "when", "result", "origin", "handoff", "confirm", "reason")
PUBLISHER_RESULT = re.compile(r"[a-z][a-z-]{0,31}")


def one_line(text):
    """text with every control character and Unicode line or paragraph break as a space"""
    return "".join(" " if unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") else c for c in text)


def publisher_read(path):
    """(the status fields, None) or (None, why it was skipped). Never follows a link, never
    opens anything but a regular file, never blocks on a FIFO, reads at most the cap"""
    try:
        st = os.lstat(path)
    except OSError:
        return None, "missing"
    if stat.S_ISLNK(st.st_mode):
        return None, "symlink"
    if not stat.S_ISREG(st.st_mode):
        return None, "not-regular"
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None, "unreadable"
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None, "not-regular"
        blob = os.read(fd, PUBLISHER_CAP + 1)
    except OSError:
        return None, "unreadable"
    finally:
        os.close(fd)
    if len(blob) > PUBLISHER_CAP or b"\x00" in blob:
        return None, "malformed"
    try:
        text = blob.decode("utf-8")
    except UnicodeDecodeError:
        return None, "malformed"
    fields = {}
    for ln in text.split("\n"):
        key, sep, value = ln.partition("=")
        if sep and key in PUBLISHER_KEYS and key not in fields:
            fields[key] = one_line(value).strip()
    if not PUBLISHER_RESULT.fullmatch(fields.get("result", "")):
        return None, "malformed"
    return fields, None


def publisher_watch(herd, watch, now):
    """one pass over the publisher's status of every dispatch repo (see above)"""
    sdir = os.environ.get("MURETAI_PUBLISHER_STATUS") or PUBLISHER_STATUS
    spath = os.path.join(watch, "publisher.json")
    try:
        fd = os.open(spath, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            state = json.loads(os.read(fd, 1 << 20).decode("ascii", "replace") or "{}")
        finally:
            os.close(fd)
    except (OSError, ValueError):
        state = {}
    if not isinstance(state, dict):
        state = {}
    kept = {}
    for repo, _path in dispatch_repos():
        old = state.get(repo)
        old = dict(old) if isinstance(old, dict) else {}
        fields, why = publisher_read(os.path.join(sdir, repo + ".txt"))
        if fields is None:
            if old.get("skip") != why:
                coord_log(herd, repo + " " + why, now, "publisher-skip")
            old["skip"] = why
            kept[repo] = old
            continue
        result = fields["result"]
        reason = fields.get("reason", "")
        digest = hashlib.sha256(reason.encode("utf-8")).hexdigest()
        if result == "held" and (old.get("result") != "held" or old.get("reason") != digest):
            emit(("PUBLISHER: %s held %s" % (repo, reason[:PUBLISHER_CUT])).rstrip())
        elif result in ("published", "up-to-date") and old.get("result") == "held":
            emit("PUBLISHER: %s %s" % (repo, result))
        kept[repo] = {"result": result, "reason": digest}
    if kept != state:
        put_state(spath, kept)


# ------------------------------------------------------------------ the coordinator's login revive

RESTART_SCRIPT = "restart-coordinator-pane.sh"     # the sibling that restarts COORDINATOR, and only it


def coord_log(herd, target, now, what):
    """`<UTC time> <what> <target>` in coordinator.log, the coordinator dir made if missing"""
    coord = os.path.join(herd, "coordinator")
    if os.path.islink(coord):
        return
    if not os.path.isdir(coord):
        try:
            os.mkdir(coord, 0o700)
        except OSError:
            pass
    log_reprompt(coord, target, now, what)


ROTATE_AT = 64 * 1024 * 1024       # coordinator.log rotates at this size
LOG_NAMES = ("coordinator.log", "coordinator.log.1", "coordinator.log.2")


def rotate_coord_log(herd):
    """once per pass: coordinator.log at ROTATE_AT or more moves to .1, the old .1 to .2 (an
    old .2 is dropped). A symlink at any of the three names, or anything not a regular file,
    rotates nothing. Renames keep the inode, so a writer appending through an open fd lands
    in .1 and a writer opening after the rename creates a new log: no line is lost."""
    coord = os.path.join(herd, "coordinator")
    if os.path.islink(coord):
        return
    paths = [os.path.join(coord, n) for n in LOG_NAMES]
    for i, p in enumerate(paths):
        try:
            st = os.lstat(p)
        except FileNotFoundError:
            if i == 0:
                return
            continue
        except OSError:
            return
        if not stat.S_ISREG(st.st_mode):
            print("herd-watch: %s is not a regular file; coordinator.log not rotated" % LOG_NAMES[i],
                  file=sys.stderr)
            return
        if i == 0 and st.st_size < ROTATE_AT:
            return
    try:
        if os.path.lexists(paths[1]):
            os.replace(paths[1], paths[2])
        os.replace(paths[0], paths[1])
    except OSError as e:
        print("herd-watch: coordinator.log not rotated: %s" % e.strerror, file=sys.stderr)


def coordinator_revive_ended(watch, target):
    """the coordinator's episode is over -- herdr shows it working, or it reads normally"""
    drop_state(os.path.join(watch, target + ".coord-revive"))


def coordinator_revive(target, tab, agent, pane, herd, watch, now):
    """2026-10-09, item 3 of 20261009T102930Z: the coordinator pane (the --notify target) at
    a `Login expired` or `OAuth token revoked` screen gets what revive() gives a worker, in
    its own words. Once login_grace() has passed since the first pass that saw the episode,
    ONE `herdr agent prompt <target> <its spawn line>` -- spawn_line(herd, target), the line
    herd-spawn.sh first typed and appl-hook.sh passes as `brief <target>`, never REVIVE, which
    the hook blocks there -- and `<UTC time> coordinator-login-revive <target>`. When a
    further grace has passed since that line and the pane still shows the expired screen
    (herdr never showed it working: main_once ends the episode then), the sibling
    restart-coordinator-pane.sh runs once, with no arguments (its defaults) and this HERD_DIR,
    logged `coordinator-login-restart <target>`; a missing script is ONE
    `coordinator-restart-missing <target>` and nothing else. The script restarts only
    COORDINATOR, so another target name gets the line and no restart: at that point one
    `no restart recipe for <target>` instead (intake 20261009T174011Z). Never appl-close.sh,
    never herd-spawn.sh, and this watcher closes no tab. Both steps need herdr to show the
    pane idle or done (revive_may_type), never blocked. State: .watch/<target>.coord-revive.
    Nothing read from the pane is typed, passed or logged."""
    if agent is None or tab is None or not NAME_RE.fullmatch(target):
        return
    if not revive_may_type(agent, tab) or not revivable(pane):
        return
    state, spath = sweep_state(watch, target, "coord-revive")
    if not isinstance(state.get("seen"), int):
        put_state(spath, {"seen": now})                # the episode starts: its grace counts from here
        return
    done = state.get("typed")
    if not isinstance(done, int):
        if now - state["seen"] <= login_grace():
            return
        if not still_idle(target):
            return                                     # changed since the listing: a later pass asks again
        state["typed"] = now
        put_state(spath, state)                        # before the line: never twice for one episode
        line = spawn_line(herd, target)
        ok = herdr("agent", "prompt", target, line)[0] == 0
        detail(watch, target, "COORDINATOR REVIVE prompt: %s" % ("ok" if ok else "failed"))
        if ok:
            typed(watch, target, line)
            coord_log(herd, target, now, "coordinator-login-revive")
        return
    if "restart" in state or now - done < login_grace():
        return
    if target != COORDINATOR:
        # intake 20261009T174011Z: no script restarts this pane, so say so, once per episode
        state["restart"] = "no-recipe"
        put_state(spath, state)
        coord_log(herd, "for " + target, now, "no restart recipe")
        return
    script = os.path.join(os.environ.get("HERD_WATCH_HERE", ""), RESTART_SCRIPT)
    missing = os.path.islink(script) or not os.path.isfile(script)
    state["restart"] = "missing" if missing else now
    put_state(spath, state)                            # before the run: never twice for one episode
    if missing:
        coord_log(herd, target, now, "coordinator-restart-missing")
        return
    coord_log(herd, target, now, "coordinator-login-restart")
    env = dict(os.environ)
    env["HERD_DIR"] = herd
    try:
        r = subprocess.run(["bash", script], stdin=subprocess.DEVNULL, capture_output=True,
                           text=True, timeout=240, env=env)
        ok = r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        ok = False
    detail(watch, target, "COORDINATOR RESTART: %s" % ("ok" if ok else "failed"))


# ------------------------------------------------------------------ the resubmit

TYPED_THIS_PASS = set()           # panes this process already typed into


def typed(watch, w, text):
    """Record the text this watcher just typed into w's pane (.watch/<w>.typed), so a later
    pass can see whether it was submitted. One text per pane: the newest replaces the older."""
    TYPED_THIS_PASS.add(w)
    put_state(os.path.join(watch, w + ".typed"), {"text": text})


def resubmit(w, pane, herd, watch, now):
    """A text the watcher typed (a notification or an `intake <path>` at the --notify pane,
    CONTINUE or a re-sent spawn line at a worker) can sit UNSUBMITTED in the prompt bar when
    the pane runs a background shell or shows a banner, and herdr raises no stall for it. On
    the next pass that reads the pane, the record is consumed: when the LAST prompt line is
    exactly that text (and the pane is at no dialog its adapter names), ONE Enter and
    `<UTC time> resubmitted <w>` in coordinator.log. Any other bar -- empty, a prefix, more
    text, a draft -- gets nothing and the record is gone, so one text is never pressed twice.
    An `intake <path>` gets its Enter only while that intake's header status, read now, still
    starts with `new`: one closed or handed off since it was typed is never delivered. The
    Enter goes only when still_idle() re-lists the pane idle or done just before it: an Enter
    alone at a pane that turned blocked would answer its prompt.
    The only key is Enter; nothing read from the pane is typed. True when it pressed."""
    state, spath = sweep_state(watch, w, "typed")
    text = state.get("text")
    if not isinstance(text, str) or not text or not (pane or "").strip():
        return False                                   # nothing typed, or no proof either way
    drop_state(spath)                                  # one look per text, before the key
    if last_prompt_row(pane) != text or dialog_kind(pane) is not None:
        return False
    if text.startswith("intake "):
        words = header_status(text[len("intake "):])  # read now, never from a record
        if not words or words[0] != "new":
            return False                               # closed or handed off since it was typed
    if not still_idle(w):
        return False                                   # no Enter alone at a pane that changed
    ok = herdr("agent", "send-keys", w, "enter")[0] == 0
    detail(watch, w, "RESUBMIT enter: %s" % ("ok" if ok else "failed"))
    coord = os.path.join(herd, "coordinator")
    if not os.path.islink(coord):
        if not os.path.isdir(coord):
            try:
                os.mkdir(coord, 0o700)
            except OSError:
                pass
        log_reprompt(coord, w, now, "resubmitted")
    return True


CURSOR_TYPED_AFTER = 60           # seconds a cursor typed row must sit idle before one Enter
_CURSOR_KIND_FN = None


def _bash_function(text, name):
    """the bash function name() { ... } from text, or None. The function is the one
    whole line exactly `name() {` through the first following line exactly `}`; none
    or two such definition lines, or no closing line, refuse by name on stderr."""
    rows = text.split("\n")
    starts = [k for k, row in enumerate(rows) if row == name + "() {"]
    if len(starts) != 1:
        sys.stderr.write("refused reader %s: %d definition lines, want 1\n" % (name, len(starts)))
        return None
    for end in range(starts[0] + 1, len(rows)):
        if rows[end] == "}":
            return "\n".join(rows[starts[0]:end + 1])
    sys.stderr.write("refused reader %s: no closing line\n" % name)
    return None


def cursor_screen_kind(pane):
    """herd-spawn.sh's cursor_screen_kind on this pane text: approval, typed, empty,
    box-closed, or no row. None when that function cannot be run. The pane is stdin.
    Nothing read here is typed or logged."""
    global _CURSOR_KIND_FN
    if _CURSOR_KIND_FN is None:
        path = os.path.join(os.environ.get("HERD_WATCH_HERE", ""), "herd-spawn.sh")
        try:
            with open(path, encoding="utf-8") as f:
                src = f.read()
        except OSError:
            src = ""
        _CURSOR_KIND_FN = _bash_function(src, "cursor_screen_kind") or ""
    if not _CURSOR_KIND_FN:
        return None
    try:
        r = subprocess.run(["bash", "-c", _CURSOR_KIND_FN + "\ncursor_screen_kind\n"],
                           input=pane or "", capture_output=True, text=True, encoding="utf-8",
                           timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    word = (r.stdout or "").strip()
    if word in ("approval", "typed", "empty", "box-closed", "no row"):
        return word
    return None


def cursor_row_text(pane):
    """the last cursor input-row text, trailing whitespace ignored, or None. The two
    shapes cursor_screen_kind reads: two spaces, U+2192, one space, text; or optional
    whitespace, U+2502, one space, U+2192, one space, text. A bare arrow is no text."""
    arrow, bar = chr(0x2192), chr(0x2502)
    mark = "  " + arrow + " "
    bar_re = re.compile(r"[ \t]*" + re.escape(bar) + " " + re.escape(arrow) + " (.*)")
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?", "", pane or "")
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text)
    last = None
    for row in text.splitlines():
        s = row.rstrip()
        got = None
        if s.startswith(mark):
            body = s[len(mark):]
            got = body if body != "" else None
        else:
            m = bar_re.fullmatch(s)
            if m:
                body = m.group(1).rstrip()
                got = body if body != "" else None
        if got is not None:
            last = got
    return last


def cursor_typed_resubmit(w, agent, tab, pane, herd, watch, now):
    """Intake 20261019T061637Z. A watched cursor pane herdr lists idle, whose screen
    cursor_screen_kind calls typed, gets one Enter after that exact row text has been
    idle for more than CURSOR_TYPED_AFTER seconds, and `<UTC time> resubmitted <w>`.
    The interval starts on the first pass that sees this idle pane with this text
    (.watch/<w>.cursor-typed holds the text's SHA-256 and that time, never the text).
    Exactly 60 seconds does not press. The same text is never pressed twice. A different
    typed text starts its own interval. approval, empty, box-closed and no row press
    nothing. Any harness but cursor is not on this path. The only key is Enter.
    True when it pressed."""
    if w in never_swept() or not NAME_RE.fullmatch(w):
        return False
    if row_status(agent, tab) != "idle" or spawn_harness(herd, w) != "cursor":
        return False
    if cursor_screen_kind(pane or "") != "typed":
        return False
    text = cursor_row_text(pane or "")
    if not text or text == "Add a follow-up":
        return False
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    state, spath = sweep_state(watch, w, "cursor-typed")
    seen = state.get("seen")
    if state.get("digest") != digest or isinstance(seen, bool) or not isinstance(seen, int):
        put_state(spath, {"digest": digest, "seen": now})
        return False
    if state.get("sent") or now - seen <= CURSOR_TYPED_AFTER:
        return False
    if not still_idle(w):
        return False
    put_state(spath, {"digest": digest, "seen": seen, "sent": now})
    ok = herdr("agent", "send-keys", w, "enter")[0] == 0
    detail(watch, w, "CURSOR RESUBMIT enter: %s" % ("ok" if ok else "failed"))
    coord_log(herd, w, now, "resubmitted")
    return True


CLAUDE_TYPED_AFTER = 60           # seconds a claude typed row must sit idle before one Enter
_CLAUDE_APPROVAL = ("Do you want to proceed?", "Run this command?", "Write to this file?",
                    "Delete this file?", "Allow this web fetch?", "Allow this web search?",
                    "Run this MCP tool?")


def claude_approval(pane):
    """True when the pane is a claude permission or approval screen. A typed row under
    one of these is still that screen: Enter would answer it."""
    text = pane or ""
    return any(q in text for q in _CLAUDE_APPROVAL)


def claude_typed_text(pane):
    """the bordered claude input row's typed text, or None. The row is answer_row's:
    a bordered input row at the input position, judged on the pane as drawn, so a
    prompt-mark line printed above that row never counts and dim or muted text in the
    row never counts. A bare row, the placeholder and a numbered choice are no text.
    Nothing read here is typed or logged."""
    text = answer_row(pane or "")
    if not text or PLACEHOLDER_RE.fullmatch(text):
        return None
    return text


def claude_spawn_token(herd, w):
    """which spawn the sent set belongs to: permissions.json's mtime, which herd-spawn
    rewrites, together with walls/<w>/wall.log's mtime. A new spawn record starts a new
    set. None when either file is missing or not a regular file of this user."""
    rules = rules_file(os.path.join(herd, w))
    if rules is None:
        return None
    path = os.path.join(herd, "walls", w, "wall.log")
    if os.path.islink(path):
        return None
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
        return None
    return "%d:%d" % (rules[1], int(st.st_mtime))


def claude_sent(state, spawn):
    """sent-text digests for this spawn, oldest first, at most REFUSED_KEEP. Another
    spawn's record is an empty set."""
    if not isinstance(state, dict) or state.get("spawn") != spawn:
        return []
    got = state.get("sent")
    if not isinstance(got, list):
        return []
    return [d for d in got if isinstance(d, str)][-REFUSED_KEEP:]


def claude_stall_due(watch, w, digest, now):
    """True when stall_answer already sent this text, or this pass is past its threshold.
    A done pane is submitted by that prompt. Enter here would be a second resubmitted line."""
    state, _ = sweep_state(watch, w, "stall-answer")
    if state.get("digest") != digest:
        return False
    if state.get("sent"):
        return True
    seen = state.get("seen")
    return (isinstance(seen, int) and not isinstance(seen, bool)
            and now - seen > stall_answer_after())


def claude_typed_resubmit(w, agent, tab, pane, herd, watch, now, already=False):
    """Intake 20261020T232539Z. A watched claude pane herdr lists idle or done and
    interactive_ready, with no report.md for this spawn, whose bordered input row holds
    typed text, gets one Enter after that exact text has been idle for more than
    CLAUDE_TYPED_AFTER seconds, and `<UTC time> resubmitted <w>`. The row is
    claude_typed_text() on one `--format ansi` read: the same parse decides the row and
    whether resubmit() already pressed it this pass, so a second Enter does not fall
    in the same pass. The interval starts on the first pass that sees this idle or done
    pane with this text (.watch/<w>.claude-typed holds the text's SHA-256, that time,
    and the sent digests, never the text). Exactly 60 seconds does not press. A done
    pane whose stall_answer record for this text is already due, or already sent, is
    left to that prompt. Sent
    digests are a set capped at REFUSED_KEEP per spawn record, so a text is never
    pressed again while its digest is in the set; a new spawn record starts a new set.
    A bare row, dim or muted text, a printed prompt-mark line, the placeholder, a
    numbered choice, and a permission or approval screen press nothing. Any harness but
    claude is not on this path. The only key is Enter. True when it pressed."""
    if w in never_swept() or not NAME_RE.fullmatch(w):
        return False
    if row_status(agent, tab) not in ("idle", "done") or spawn_harness(herd, w) != "claude":
        return False
    if (agent or {}).get("interactive_ready") is not True:
        return False
    if current_report(os.path.join(herd, w)) is not None:
        return False
    if claude_approval(pane or ""):
        return False
    spawn = claude_spawn_token(herd, w)
    if spawn is None:
        return False
    drawn = read_pane_ansi(w)
    if drawn is None:
        return False
    text = claude_typed_text(drawn)
    if not text:
        return False
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    state, spath = sweep_state(watch, w, "claude-typed")
    sent = claude_sent(state, spawn)
    same = state.get("spawn") == spawn
    seen = state.get("seen") if same else None
    # one parse of the input row: an Enter already sent this pass was this row
    if already and text == claude_typed_text(drawn):
        if digest not in sent:
            sent = (sent + [digest])[-REFUSED_KEEP:]
            put_state(spath, {"digest": digest, "seen": now, "sent": sent, "spawn": spawn})
        return False
    if digest in sent:
        return False
    if (not same or state.get("digest") != digest or isinstance(seen, bool)
            or not isinstance(seen, int)):
        put_state(spath, {"digest": digest, "seen": now, "sent": sent, "spawn": spawn})
        return False
    if now - seen <= CLAUDE_TYPED_AFTER:
        return False
    # a done pane past stall_answer's threshold is that prompt, not a second Enter
    if row_status(agent, tab) == "done" and claude_stall_due(watch, w, digest, now):
        return False
    if not still_idle(w):
        return False
    sent = (sent + [digest])[-REFUSED_KEEP:]
    put_state(spath, {"digest": digest, "seen": seen, "sent": sent, "spawn": spawn})
    ok = herdr("agent", "send-keys", w, "enter")[0] == 0
    detail(watch, w, "CLAUDE RESUBMIT enter: %s" % ("ok" if ok else "failed"))
    coord_log(herd, w, now, "resubmitted")
    return True


STALL_ANSWER = 300                 # seconds an answer may sit unsent in a done pane


def stall_answer_after():
    """HERD_WATCH_STALL_ANSWER_S as seconds >= 0, else STALL_ANSWER (non-numeric, negative or
    empty included)"""
    try:
        v = float(os.environ.get("HERD_WATCH_STALL_ANSWER_S", ""))
    except ValueError:
        return STALL_ANSWER
    return v if 0 <= v < 1e7 else STALL_ANSWER


# ISSUE security-audit-2026-10-10-pin-herd-watch-resub-4537 and -2: the stalled answer is pane
# text the worker can steer, typed back as a USER turn. Only the bordered claude input row is
# an answer: `<bar> > <text> <bar>` as the pane's LAST prompt row, no character of the text
# drawn dim (ghost or suggested-prompt text), the text not a `!` (bash mode) or `/` (slash
# command) line and not a selection row, and no numbered choice list on the last screenful.
# Any other harness has no pinned input shape and is refused whole.
# ISSUE security-audit-2026-10-10-pin-the-herd-watch-s-34a1 and -2 (intakes 20261010T014635Z,
# 20261010T014651Z): a shape the model can print is no proof of the harness, and a plain read
# carries no SGR, so the dim check never fired against the real herdr. So the harness comes
# from the spawn record (spawn_harness: the first line of walls/<w>/wall.log, which herd-spawn.sh
# writes outside the wall) and every harness but claude is refused there, before any row is
# judged; claude's bordered row counts only at the input position -- the box's bottom border
# directly under it and at most one footer row below that; and the row is judged on its own
# `--format ansi` read, where SGR 2, hidden text and a gray foreground (SGR 30/90, 38;5;n and
# 38;2;r;g;b that is achromatic and not bright) all count as dim.
_ESC_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b.?")
_BOXED_ROW_RE = re.compile(r"\s*" + _BAR + r"\s*[>" + _MARK + r"](?: (.*?))?\s*" + _BAR + r"\s*")
_SELECTION_RE = re.compile(r"\s*" + _MARK + r"\s*\d+\.(?:\s|$)")
_CHOICE_RE = re.compile(r"\s*(?:" + _MARK + r"\s*)?\d+\.(?:\s|$)")
SCREENFUL = 60                     # rows of the pane's end a choice list is looked for in
REFUSED_KEEP = 16                  # refused digests kept per worker (.watch/<w>.stall-refused)


def _xterm_rgb(n):
    """the xterm 256-colour palette entry n as (r, g, b)"""
    base = ((0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0), (0, 0, 238), (205, 0, 205),
            (0, 205, 205), (229, 229, 229), (127, 127, 127), (255, 0, 0), (0, 255, 0),
            (255, 255, 0), (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255))
    if n < 16:
        return base[n]
    if n < 232:
        n -= 16
        return tuple(0 if v == 0 else 55 + 40 * v for v in (n // 36, n // 6 % 6, n % 6))
    v = 8 + 10 * (n - 232)
    return (v, v, v)


def _gray(rgb):
    """a foreground drawn as muted text: achromatic and not bright (black included)"""
    return max(rgb) - min(rgb) <= 24 and max(rgb) <= 200


def _num(p):
    return int(p) if p.isdigit() and len(p) <= 3 else None


def sgr_muted(params, st):
    """(dim, hidden, gray foreground) after one SGR's parameters: 2 sets dim, 8 hidden, 0 or
    none clears all three, 22 dim, 28 hidden, 39 the foreground. A basic (30-37, 90-97) or
    extended (38;5;n, 38;2;r;g;b, `;` or `:` separated) foreground is gray by _gray(), one this
    cannot read counts as gray; the arguments of an extended colour are never read as attributes"""
    dim, hidden, gray = st
    ps = params.split(";")
    i = 0
    while i < len(ps):
        sub = ps[i].split(":")
        head, k = sub[0], _num(sub[0])
        if head in ("", "0"):
            dim = hidden = gray = False
        elif head == "2":
            dim = True
        elif head == "22":
            dim = False
        elif head == "8":
            hidden = True
        elif head == "28":
            hidden = False
        elif head == "39":
            gray = False
        elif k is not None and (30 <= k <= 37 or 90 <= k <= 97):
            gray = _gray(_xterm_rgb(k - 30 if k < 90 else k - 82))
        elif head in ("38", "48", "58"):
            args = sub[1:] if len(sub) > 1 else ps[i + 1:]
            rgb, used = None, 0
            if args[:1] == ["5"]:
                n = _num(args[1]) if len(args) > 1 else None
                rgb, used = (_xterm_rgb(n) if n is not None and n < 256 else None), 2
            elif args[:1] == ["2"]:
                vals = [_num(v) for v in ([a for a in args[1:] if a != ""][-3:] if len(sub) > 1 else args[1:4])]
                rgb, used = (tuple(vals) if len(vals) == 3 and None not in vals else None), 4
            if head == "38":
                gray = rgb is None or _gray(rgb)
            if len(sub) == 1:
                i += used
        i += 1
    return dim, hidden, gray


def screen_rows(pane):
    """the pane as (plain row, per-character muted flags) rows: a character is muted when it is
    drawn dim, hidden or in a gray foreground; the attributes carry over rows the way a
    terminal carries them"""
    rows, plain, flags, st, at = [], [], [], (False, False, False), 0
    for m in list(_ESC_RE.finditer(pane)) + [None]:
        end = m.start() if m else len(pane)
        for ch in pane[at:end]:
            if ch == "\n":
                rows.append(("".join(plain), flags))
                plain, flags = [], []
            elif ch != "\r":
                plain.append(ch)
                flags.append(any(st))
        if m is None:
            break
        seq, at = m.group(0), m.end()
        if seq.startswith("\x1b[") and seq.endswith("m"):
            st = sgr_muted(seq[2:-1], st)
    rows.append(("".join(plain), flags))
    return rows


_BOTTOM_RE = re.compile(r"\s*\u2570\u2500+\u256f\s*")   # claude's input box, its bottom border
FOOTER_ROWS = 1                    # non-blank rows claude draws under its input box (the hint)


def answer_row(pane):
    """the text of the pane's LAST prompt row when it is a plain answer in the bordered claude
    input row at the input position (see above), else None"""
    rows = screen_rows(pane)
    last = None
    for i, (row, _) in enumerate(rows):
        if PROMPT_ROW_RE.fullmatch(row):
            last = i
    if last is None:
        return None
    row, flags = rows[last]
    m = _BOXED_ROW_RE.fullmatch(row)
    if not m or m.group(1) is None:
        return None                                    # no bordered input row: no pinned shape
    below = [r for r, _ in rows[last + 1:]]
    if not below or not _BOTTOM_RE.fullmatch(below[0]):
        return None                                    # no bottom border under it: a row the reply drew
    if len([r for r in below[1:] if r.strip()]) > FOOTER_ROWS:
        return None                                    # more than the footer below it: not the input
    text = m.group(1).strip()
    if not text or text[0] in "!/" or _CHOICE_RE.match(text):
        return None
    if any(flags[k] for k in range(m.start(1), m.end(1)) if not row[k].isspace()):
        return None                                    # ghost, suggested or gray text, not typed
    tail = [r for r, _ in rows if r.strip()][-SCREENFUL:]
    if any(_SELECTION_RE.match(r) for r in tail) or sum(1 for r in tail if _CHOICE_RE.match(r)) >= 2:
        return None                                    # a choice list: a line typed could choose
    return text


SPAWN_LINE_RE = re.compile(r"\S+ spawn worker=(\S+) profile=\S+ harness=([a-z][a-z0-9_-]{0,31}) .*")
SPAWN_HEAD = 4096                  # bytes: only the start of walls/<w>/wall.log is read


def spawn_harness(herd, w):
    """The harness w was spawned on, from herd-spawn.sh's record: the first line of
    $HERD_DIR/walls/<w>/wall.log, `<time> spawn worker=<w> profile=<p> harness=<h> ...`, written
    outside the wall. "" when there is no record at all (no herd-spawn.sh record: the row is
    judged on its own, as before); "?" for a record that is a symlink, of another owner, not a
    regular file, or whose first line does not parse or names another worker; else the harness
    word. Nothing read here is printed or logged."""
    walls = os.path.join(herd, "walls")
    wall = os.path.join(walls, w)
    path = os.path.join(wall, "wall.log")
    if os.path.islink(walls) or os.path.islink(wall):
        return "?"
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return ""
    except OSError:
        return "?"
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
        return "?"
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return "?"
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            return "?"
        head = os.read(fd, SPAWN_HEAD).decode("utf-8", "replace")
    except OSError:
        return "?"
    finally:
        os.close(fd)
    m = SPAWN_LINE_RE.fullmatch(head.split("\n", 1)[0])
    if not m or m.group(1) != w:
        return "?"
    return m.group(2)


def read_pane_ansi(w):
    """w's pane as drawn, its SGR kept (`--format ansi`), or None when that read fails"""
    rc, out = herdr("agent", "read", w, "--source", "recent-unwrapped", "--lines", "80", "--format", "ansi")
    return out if rc == 0 else None


def refused_digests(watch, w):
    """(the SHA-256 digests of the texts stall_answer() refused for w, the record's path):
    .watch/<w>.stall-refused, never dropped when the pane shows working, so a refused text
    stays refused when the pane goes done again"""
    state, p = sweep_state(watch, w, "stall-refused")
    got = state.get("digests")
    return ([d for d in got if isinstance(d, str)] if isinstance(got, list) else []), p


def stall_answer(w, agent, tab, pane, herd, watch, now):
    """Intake 20261009T201212Z: an answer typed into a worker pane sat in its input line,
    unsent, while herdr listed the pane `done` and no report came; an Enter alone does not
    submit there. A watched worker (never the coordinator pane) herdr lists `done` and at its
    input (interactive_ready: a gone process is resume()'s), with no report.md in its herd
    dir, whose LAST prompt row holds text (not the placeholder), in that state for MORE than
    stall_answer_after() seconds since the first pass that saw it, gets ONE `herdr agent
    prompt <w> <that text>` and `<UTC time> resubmitted <w>` in coordinator.log, after a
    still_idle() re-list. Once per stall (.watch/<w>.stall-answer holds the first pass's time
    and the text's SHA-256, never the text): a pane not `done`, an empty input line, other
    text or a report ends it, and the next one is timed afresh. The text goes only back into
    the pane it was read from; it is not recorded with typed(), so resubmit() never adds an
    Enter. A worker whose spawn record names any harness but claude, or whose record is not
    one this can trust, is refused whatever its screen shows. Only answer_row()'s text, judged
    on a `--format ansi` read of the pane, is an answer: any other last prompt row is refused, its
    digest kept in .watch/<w>.stall-refused across working and done, so it is never retried.
    True when it typed."""
    if w in never_swept() or agent is None or not NAME_RE.fullmatch(w):
        return False
    state, spath = sweep_state(watch, w, "stall-answer")
    text = last_prompt_row(pane or "")
    if (row_status(agent, tab) != "done" or agent.get("interactive_ready") is not True
            or not text or PLACEHOLDER_RE.fullmatch(text) or dialog_kind(pane) is not None
            or os.path.lexists(os.path.join(herd, w, "report.md"))):
        if state:
            drop_state(spath)                          # it left the state: a later one is a new stall
        return False
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    refused, rpath = refused_digests(watch, w)
    harness = spawn_harness(herd, w)
    drawn = None
    if digest not in refused and harness in ("", "claude"):
        drawn = read_pane_ansi(w)                      # judged as drawn: a plain read shows no dim
        if drawn is None:
            return False                               # unread this pass: a later pass asks again
    if digest in refused or harness not in ("", "claude") or answer_row(drawn) != text:
        if digest not in refused:
            put_state(rpath, {"digests": (refused + [digest])[-REFUSED_KEEP:]})
        if state:
            drop_state(spath)
        return False                                   # not an answer the worker typed: never sent
    if not isinstance(state.get("seen"), int) or state.get("digest") != digest:
        put_state(spath, {"seen": now, "digest": digest})   # the stall starts: timed from here
        return False
    if state.get("sent") or now - state["seen"] <= stall_answer_after():
        return False
    if not still_idle(w):
        return False                                   # changed since the listing: a later pass asks again
    state["sent"] = now
    put_state(spath, state)                            # before the line: never twice for one stall
    ok = herdr("agent", "prompt", w, text)[0] == 0
    detail(watch, w, "STALL ANSWER prompt: %s" % ("ok" if ok else "failed"))
    if ok:
        coord_log(herd, w, now, "resubmitted")
    return ok


STUCK_EMPTY = 15 * 60              # seconds a done pane may sit with an empty input line, no report


def stuck_empty(w, agent, tab, pane, herd, watch, now):
    """Intake 20261010T010135Z: a done pane with nothing in its input line and no report.md is
    waiting for nobody -- no answer to resubmit, no CONTINUE phrase. A watched worker (never
    the coordinator pane) herdr lists `done`, with no report.md in its herd dir, whose LAST
    prompt row is empty (or the placeholder) for MORE than STUCK_EMPTY since the first pass
    that saw that state, gets ONE `STUCK: <w> ...` line, which --notify sends on to the
    coordinator. Once per episode (.watch/<w>.stuck-empty, the first pass's time): any other
    status, text in the line or a report ends it. Nothing is typed into the pane; text in
    the line is stall_answer()'s."""
    spath = os.path.join(watch, w + ".stuck-empty")
    if w in never_swept() or agent is None:
        return
    row = last_prompt_row(pane or "")
    if (row_status(agent, tab) != "done" or row is None or (row and not PLACEHOLDER_RE.fullmatch(row))
            or os.path.lexists(os.path.join(herd, w, "report.md"))):
        drop_state(spath)
        return
    state, _ = sweep_state(watch, w, "stuck-empty")
    if not isinstance(state.get("seen"), int):
        put_state(spath, {"seen": now})                # the episode starts: timed from here
        return
    if state.get("told") or now - state["seen"] <= STUCK_EMPTY:
        return
    if bg_waiting(herd, w):
        return                                         # it waits on its background run: told once that ends
    state["told"] = now
    put_state(spath, state)
    detail(watch, w, "STUCK done with no report.md and an empty input line")
    emit("STUCK: %s is done with no report.md and an empty input line -- look at the pane yourself" % w)
    ledger_event(herd, "stuck", w)


PS_ARGS = ["-A", "-o", "pid=,ppid=,comm="]


def orphaned_caffeinate():
    """How many caffeinate processes launchd (pid 1) has adopted: the rows of the process
    listing -- HERD_WATCH_PS_BIN (tests) or /bin/ps, with PS_ARGS -- whose ppid is 1 and
    whose command's last path component is exactly `caffeinate`. 0 when the listing fails.
    It only counts: nothing is signalled, and no listing text leaves this function."""
    binp = os.environ.get("HERD_WATCH_PS_BIN") or "/bin/ps"
    try:
        r = subprocess.run([binp] + PS_ARGS, stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return 0
    if r.returncode != 0:
        return 0
    n = 0
    for row in r.stdout.decode("utf-8", "replace").splitlines():
        parts = row.split(None, 2)
        if (len(parts) == 3 and parts[0].isdigit() and parts[1] == "1"
                and parts[2].strip().rsplit("/", 1)[-1] == "caffeinate"):
            n += 1
    return n


def start_timeout_state(watch, name):
    """(.watch/<name>.start-timeout path, dict) of the backoff for one failed resume.
    A missing or unreadable file is a fresh budget."""
    spath = os.path.join(watch, name + ".start-timeout")
    try:
        state = json.loads(read_file(spath) or "")
    except ValueError:
        state = None
    return spath, state if isinstance(state, dict) else {}


def drop_start_timeout(spath):
    try:
        if os.path.lexists(spath) and not os.path.islink(spath):
            os.unlink(spath)
    except OSError:
        pass


def start_timeout_reason(stderr):
    """the last non-empty stderr line, one line, at most 300 characters"""
    lines = [ln.strip() for ln in (stderr or "").splitlines() if ln.strip()]
    reason = lines[-1] if lines else "failed"
    if len(reason) > 300:
        reason = reason[:300]
    return reason


def report_regular(herd, name):
    """True when <HERD_DIR>/<name>/report.md is a regular file. A symlink, a FIFO or a
    missing file is not: the brief has not been taken, so a start-timeout resume may
    still deliver it. The bytes are not read."""
    wdir = os.path.join(herd, name)
    if os.path.islink(wdir) or not os.path.isdir(wdir):
        return False
    path = os.path.join(wdir, "report.md")
    if os.path.islink(path):
        return False
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


CURSOR_START_AFTER = 300          # seconds from the rules file before a cursor start-timeout
CURSOR_RESUME_WAITS = (60, 300, 900)  # after resume 1, 2 and 3; the fourth is the last


def cursor_agent_present(pane_id):
    """True when a foreground process is named cursor-agent, False when the list has
    none, None when herdr did not answer. bash is the shell, not the worker."""
    rc, out = herdr("pane", "process-info", "--pane", pane_id)
    if rc != 0 or not out:
        return None
    try:
        info = json.loads(out).get("result", {}).get("process_info", {})
        procs = info.get("foreground_processes")
    except (ValueError, AttributeError):
        return None
    if not isinstance(procs, list):
        return None
    for proc in procs:
        if isinstance(proc, dict) and proc.get("name") == "cursor-agent":
            return True
    return False


def drop_resume_record(rec):
    """unlink a regular resume record. A symlink is left alone. True when it is gone."""
    if os.path.islink(rec):
        return False
    try:
        os.unlink(rec)
    except OSError:
        return False
    return True


def mark_cursor_dead(herd, watch, name, now):
    """this spawn's death is already closed, so the dead sweep does not close it again"""
    if os.path.islink(watch):
        return
    rules = rules_file(os.path.join(herd, name))
    if rules is None:
        return
    state, spath = sweep_state(watch, name, "dead")
    if state.get("spawn") != rules[1]:
        state = {}
    seen = state.get("seen")
    if isinstance(seen, bool) or not isinstance(seen, int):
        seen = now
    put_state(spath, {"done": True, "seen": seen, "spawn": rules[1]})


def close_cursor_start_timeout(herd, watch, name, now, spath):
    """appl-close.sh --dead, then `dead <name> start-timeout`. No herd-spawn.sh."""
    if not appl_close_dead(name):
        return
    ledger_event(herd, "dead", name)
    drop_start_timeout(spath)
    mark_cursor_dead(herd, watch, name, now)
    coord_log(herd, name + " start-timeout", now, "dead")


def deliver_cursor_start_timeout(herd, name, agent, watch, now, rec):
    """A cursor pane whose resume record says stop=start-timeout. Age is HERD_WATCH_NOW
    minus the rules-file mtime. See the header comment 'A cursor start-timeout'."""
    spath, state = start_timeout_state(watch, name)
    working = isinstance(agent, dict) and agent.get("agent_status") == "working"
    if working or report_regular(herd, name):
        drop_resume_record(rec)
        drop_start_timeout(spath)
        return
    if not isinstance(agent, dict):
        return
    rules = rules_file(os.path.join(herd, name))
    if rules is None or now - rules[1] < CURSOR_START_AFTER:
        return
    pid = agent.get("pane_id")
    present = cursor_agent_present(pid) if isinstance(pid, str) and PANE_RE.fullmatch(pid) else None
    if present is None:
        return
    if not present:
        close_cursor_start_timeout(herd, watch, name, now, spath)
        return
    try:
        count, last = int(state.get("count", 0)), int(state.get("last", 0))
    except (TypeError, ValueError):
        count, last = 0, 0
    if isinstance(state.get("count"), bool) or isinstance(state.get("last"), bool):
        count, last = 0, 0
    if count >= 4:
        close_cursor_start_timeout(herd, watch, name, now, spath)
        return
    if count and now - last < CURSOR_RESUME_WAITS[count - 1]:
        return
    if not still_idle(name):
        return
    here = os.environ.get("HERD_WATCH_HERE", "")
    script = os.path.join(here, "herd-spawn.sh")
    env = dict(os.environ)
    env["HERD_DIR"] = herd
    try:
        subprocess.run(["bash", script, "--resume", name], stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, timeout=180, env=env)
    except (OSError, subprocess.SubprocessError):
        return
    try:
        write_file(spath, json.dumps({"count": count + 1, "last": now}) + "\n")
    except OSError:
        pass


def deliver_start_timeouts(herd, agent_by, at_dialog, watch, now):
    """A spawn whose `herdr agent start` returned `timed out waiting for agent startup`
    left its tab open and wrote stop=start-timeout into $HERD_DIR/.resume/<w>. A cursor
    record is deliver_cursor_start_timeout. Any other harness, when the worker is idle
    (or done and still at its input) and not at a dialog, gets one
    `herd-spawn.sh --resume <w>` to deliver the brief. A pane that is not ready yet is left
    alone: nothing is closed and the record stays. A worker whose report.md is already a
    regular file has taken the brief: the record is removed and nothing is typed. A
    failed resume writes its last stderr line into .watch/<w>.detail once, and the same
    reason waits DELAYS before it is tried again."""
    rdir = os.path.join(herd, ".resume")
    if os.path.islink(rdir) or not os.path.isdir(rdir):
        return
    here = os.environ.get("HERD_WATCH_HERE", "")
    script = os.path.join(here, "herd-spawn.sh")
    try:
        names = sorted(os.listdir(rdir))
    except OSError:
        return
    coord = os.path.join(herd, "coordinator")
    for name in names:
        if not NAME_RE.fullmatch(name) or name in at_dialog:
            continue
        rec = os.path.join(rdir, name)
        got = read_regular(rec, 4096)
        if got is None or b"stop=start-timeout" not in got[0].split(b"\n"):
            continue
        if b"harness=cursor" in got[0].split(b"\n"):
            deliver_cursor_start_timeout(herd, name, agent_by.get(name), watch, now, rec)
            continue
        agent = agent_by.get(name)
        if not isinstance(agent, dict):
            continue
        status = agent.get("agent_status")
        ready = status == "idle" or (status == "done" and agent.get("interactive_ready") is True)
        if not ready or not still_idle(name):
            continue
        spath, state = start_timeout_state(watch, name)
        if report_regular(herd, name):
            if os.path.islink(rec):
                continue
            try:
                os.unlink(rec)
            except OSError:
                continue
            drop_start_timeout(spath)
            detail(watch, name, "START-TIMEOUT delivered: report.md is already a regular file")
            if not os.path.islink(coord):
                log_reprompt(coord, name, now, "delivered")
            continue
        try:
            count, last = int(state.get("count", 0)), int(state.get("last", 0))
        except (TypeError, ValueError):
            count, last = 0, 0
        if count >= len(DELAYS) or (count and now - last < DELAYS[count]):
            continue
        env = dict(os.environ)
        env["HERD_DIR"] = herd
        stderr = ""
        try:
            r = subprocess.run(["bash", script, "--resume", name], stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=180, env=env)
            ok = r.returncode == 0
            stderr = r.stderr or ""
        except (OSError, subprocess.SubprocessError) as e:
            ok = False
            stderr = type(e).__name__
        if ok:
            drop_start_timeout(spath)
            detail(watch, name, "START-TIMEOUT resume: ok")
            if not os.path.islink(coord):
                log_reprompt(coord, name, now, "resumed")
            continue
        reason = start_timeout_reason(stderr)
        prev = state.get("reason") if isinstance(state.get("reason"), str) else None
        if prev != reason:
            detail(watch, name, "START-TIMEOUT resume: failed: " + reason)
        try:
            write_file(spath, json.dumps(
                {"count": count + 1, "last": now, "reason": reason}) + "\n")
        except OSError:
            pass


def unfreeze_spawn_freeze(herd, now):
    """An intake whose header status is exactly `blocked spawn-freeze` was parked without
    a spawn. That status is not a stop: rewrite the header line to `status: new` and log
    `unfrozen <file>`, once. The watchdog then re-types it as a fresh filing after the
    grace. Anything else in the file is kept. A symlink, a non-regular file, or a file
    over 1 MiB is left alone."""
    coord = os.path.join(herd, "coordinator")
    idir = os.path.join(coord, "intake")
    if os.path.islink(coord) or os.path.islink(idir) or not os.path.isdir(idir):
        return
    try:
        entries = sorted(os.listdir(idir))
    except OSError:
        return
    cap = 1 << 20
    for name in entries:
        if not INTAKE_RE.fullmatch(name):
            continue
        path = os.path.join(idir, name)
        words = header_status(path)
        if words != ["blocked", "spawn-freeze"]:
            continue
        got = read_regular(path, cap)
        if got is None or got[1].st_size > cap:
            continue
        text = got[0].decode("utf-8", "surrogateescape")
        lines = text.split("\n")
        try:
            end = lines.index("")
        except ValueError:
            end = len(lines)
        changed = False
        for i in range(end):
            if (lines[i].startswith("status:")
                    and lines[i][len("status:"):].split() == ["blocked", "spawn-freeze"]):
                lines[i] = "status: new"
                changed = True
                break
        if not changed:
            continue
        try:
            replace_regular(path, "\n".join(lines).encode("utf-8", "surrogateescape"))
        except OSError:
            continue
        log_reprompt(coord, name, now, "unfrozen")


DEAD_AFTER = 300                   # seconds an absence must exceed before appl-close.sh --dead
DEAD_CAP = 5                       # due workers one pass may close, the lexicographically first
ALIVE_STATUS = ("working", "idle", "blocked")
WATCHER_START = 0.0                # time.time() as the pass begins; main_once sets it
HARNESS_NAMES = ("claude", "cursor-agent", "grok")
PAIR_KEY_RE = re.compile(r"[a-z][a-z0-9_-]{0,31}:[a-z][a-z0-9_-]{0,31}")


def pane_carries(rows, w, tab):
    """True when a pane-list row is this worker: its title or label, or the tab's ids."""
    pane_id = tab.get("pane_id") if isinstance(tab, dict) else None
    tab_id = tab.get("tab_id") if isinstance(tab, dict) else None
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get("title") == w or row.get("label") == w or row.get("name") == w:
            return True
        if pane_id and row.get("pane_id") == pane_id:
            return True
        if tab_id and row.get("tab_id") == tab_id:
            return True
    return False


def pane_id_for(rows, w, tab):
    """a pane id safe to hand to herdr, from the tab row or the pane list, or None"""
    if isinstance(tab, dict):
        pid = tab.get("pane_id")
        if isinstance(pid, str) and PANE_RE.fullmatch(pid):
            return pid
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get("title") != w and row.get("label") != w and row.get("name") != w:
            continue
        pid = row.get("pane_id")
        if isinstance(pid, str) and PANE_RE.fullmatch(pid):
            return pid
    return None


def harness_present(pane_id):
    """True when a foreground process is a harness, False when the list has none, None
    when herdr did not answer. bash and zsh are the shell, not a harness."""
    rc, out = herdr("pane", "process-info", "--pane", pane_id)
    if rc != 0 or not out:
        return None
    try:
        info = json.loads(out).get("result", {}).get("process_info", {})
        procs = info.get("foreground_processes")
    except (ValueError, AttributeError):
        return None
    if not isinstance(procs, list):
        return None
    for proc in procs:
        if isinstance(proc, dict) and proc.get("name") in HARNESS_NAMES:
            return True
    return False


def classify_dead(w, tab, agent, panes):
    """the why word, 'alive' when the absence is not one of the three, or 'skip' when
    process-info did not answer and the clock must stay where it was"""
    in_tab = tab is not None
    in_agent = agent is not None
    in_pane = pane_carries(panes, w, tab)
    if not in_tab and not in_agent and not in_pane:
        return "unknown"
    if in_tab and in_pane and not in_agent:
        return "missing-agent"
    if in_tab and in_pane and in_agent:
        pid = pane_id_for(panes, w, tab)
        if pid is None:
            return "skip"
        present = harness_present(pid)
        if present is None:
            return "skip"
        if present:
            return "alive"
        return "no-harness"
    return "alive"


def pair_key_of(herd, w):
    """the one line of $HERD_DIR/.keys/<w>, a harness:name key, or None"""
    keys = os.path.join(herd, ".keys")
    if os.path.islink(keys):
        return None
    got = read_regular(os.path.join(keys, w), 128)
    if got is None:
        return None
    try:
        text = got[0].decode("ascii")
    except UnicodeError:
        return None
    lines = text.splitlines()
    if len(lines) != 1 or not PAIR_KEY_RE.fullmatch(lines[0]):
        return None
    return lines[0]


def bump_deaths(watch, key):
    """one more on $HERD_DIR/.watch/<key>.deaths. A missing file starts at one. The file
    is the pair key's, never the worker's."""
    if os.path.islink(watch):
        return
    path = os.path.join(watch, key + ".deaths")
    if os.path.islink(path):
        return
    n = 0
    if os.path.lexists(path):
        got = read_regular(path, 32)
        if got is None:
            return
        text = got[0].decode("ascii", "replace").strip()
        if not text.isdigit() or len(text) > 18:
            return
        n = int(text)
    put_text(path, "%d\n" % (n + 1))


def appl_close_dead(w):
    """appl-close.sh --dead <w>, that argv and nothing else. True when it exits 0."""
    here = os.environ.get("HERD_WATCH_HERE", "")
    try:
        r = subprocess.run(["bash", os.path.join(here, "appl-close.sh"), "--dead", w],
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0


def owned_workers(herd):
    """worker names whose herd dir holds the rules file herd-spawn wrote, not the
    coordinator pane. A name that is not a worker name is never joined to a path."""
    if os.path.islink(herd):
        return []
    try:
        entries = sorted(os.listdir(herd))
    except OSError:
        return []
    skip = never_swept()
    out = []
    for w in entries:
        if not NAME_RE.fullmatch(w) or w in skip:
            continue
        wdir = os.path.join(herd, w)
        if os.path.islink(wdir) or not os.path.isdir(wdir):
            continue
        if rules_file(wdir) is None:
            continue
        out.append(w)
    return out


def alive_names(rows, key):
    """names this listing shows working, idle or blocked. A missing status is not alive."""
    found = set()
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        name = row.get(key)
        if (isinstance(name, str) and NAME_RE.fullmatch(name)
                and row.get("agent_status") in ALIVE_STATUS):
            found.add(name)
    return found


def _name_set(raw):
    if not isinstance(raw, list):
        return set()
    return {n for n in raw if isinstance(n, str) and NAME_RE.fullmatch(n)}


def listed_names(rows, key):
    """names this listing still carries, whatever the status. A row that left working,
    idle or blocked is still here; a missing row is a loss."""
    found = set()
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        name = row.get(key)
        if isinstance(name, str) and NAME_RE.fullmatch(name):
            found.add(name)
    return found


LATCH_AFTER = 10                   # consecutive failed listings before one owner notice
DID_RE = re.compile(r"did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,256}")
DISPATCH_DEFAULT = "dispatch-mac-a"


def pane_listed_names(rows):
    """worker names a pane list carries, by title, label or name."""
    found = set()
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        for key in ("title", "label", "name"):
            name = row.get(key)
            if isinstance(name, str) and NAME_RE.fullmatch(name):
                found.add(name)
    return found


def owner_did(coord):
    """the one DID in <coord>/owner.did, or None. A symlink or a second line is none."""
    got = read_regular(os.path.join(coord, "owner.did"), 4096)
    if got is None:
        return None
    lines = [ln.strip() for ln in got[0].decode("ascii", "replace").splitlines() if ln.strip()]
    if len(lines) == 1 and DID_RE.fullmatch(lines[0]):
        return lines[0]
    return None


def tell_listing_latch(herd, n, now):
    """one owner-stops.md row and one owner mail, both carrying the latch phrase.
    True when the row was written. The mail command is APPL_OPERATOR_CLI, else
    `muretai op`, the same seam appl-hook.sh uses."""
    phrase = "watcher latched: listing-dropped x%d" % n
    coord = os.path.join(herd, "coordinator")
    if os.path.islink(coord):
        return False
    if not os.path.isdir(coord):
        try:
            os.mkdir(coord, 0o700)
        except OSError:
            return False
    line = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)) + " " + phrase + "\n"
    try:
        fd = os.open(os.path.join(coord, "owner-stops.md"),
                     os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError:
        return False
    try:
        os.write(fd, line.encode("ascii"))
    finally:
        os.close(fd)
    did = owner_did(coord)
    if did is not None:
        exe = os.environ.get("APPL_OPERATOR_CLI", "")
        argv = [exe] if exe else ["muretai", "op"]
        argv += ["--as", DISPATCH_DEFAULT, "dm", "--", did, phrase]
        try:
            subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True,
                           text=True, timeout=120)
        except (OSError, subprocess.SubprocessError):
            pass
    return True


def accept_listing(path, drop_path, ever, now_tab, now_agent):
    """a pass that is not a failed listing: remember who is alive and reset the streak."""
    put_state(path, {"agent": sorted(now_agent), "ever": sorted(ever | now_tab | now_agent),
                     "tab": sorted(now_tab)})
    drop_state(drop_path)


def note_listing(tabs, agents, herd, watch, now):
    """Remember who this pass listed alive. Return (True, names an earlier pass listed
    alive) or (False, empty) when this pass's tab list or agent list lost more than half
    of the names that listing showed alive last pass. A name still in the listing is not
    lost, and neither is one appl-close.sh already closed, nor one whose tab and pane are
    both gone while the pane list still carries someone the baseline showed alive. Once a
    name has been seen alive it stays a candidate after it drops. A failed listing logs
    `listing-dropped <n>` and leaves the baseline and every .dead clock where they were.
    The same lost names on the next pass re-baseline and log `listing-rebased <n>`.
    More than LATCH_AFTER consecutive failed listings notifies the owner once."""
    prev, path = sweep_state(watch, "listing", "alive")
    drop, drop_path = sweep_state(watch, "listing", "drop")
    prev_tab, prev_agent = _name_set(prev.get("tab")), _name_set(prev.get("agent"))
    ever = _name_set(prev.get("ever"))
    now_tab, now_agent = alive_names(tabs, "label"), alive_names(agents, "name")
    have_tab, have_agent = listed_names(tabs, "label"), listed_names(agents, "name")
    missing = (prev_tab - have_tab) | (prev_agent - have_agent)
    have_pane = set()
    if missing:
        panes = listing("pane")
        if panes is not None:
            have_pane = pane_listed_names(panes)
    # an empty or unrelated pane list is the gutted listing, not a hand-close
    anchor = bool((prev_tab | prev_agent) & have_pane)

    def lost(was, still):
        out = set()
        for n in was - still:
            if closed_marker(herd, n):
                continue
            if anchor and n not in have_tab and n not in have_pane:
                continue
            out.add(n)
        return out

    lost_tab, lost_agent = lost(prev_tab, have_tab), lost(prev_agent, have_agent)
    lost_names = lost_tab | lost_agent
    failed = ((bool(prev_tab) and len(lost_tab) * 2 > len(prev_tab))
              or (bool(prev_agent) and len(lost_agent) * 2 > len(prev_agent)))
    if failed:
        n = len(lost_names)
        if _name_set(drop.get("lost")) == lost_names:
            accept_listing(path, drop_path, ever, now_tab, now_agent)
            coord_log(herd, str(n), now, "listing-rebased")
            return True, ever
        fails = drop.get("fails")
        if isinstance(fails, bool) or not isinstance(fails, int) or fails < 0:
            fails = 0
        fails += 1
        latched = drop.get("latched") is True
        if fails > LATCH_AFTER and not latched and tell_listing_latch(herd, n, now):
            latched = True
        put_state(drop_path, {"fails": fails, "latched": latched, "lost": sorted(lost_names)})
        coord_log(herd, str(n), now, "listing-dropped")
        return False, set()
    accept_listing(path, drop_path, ever, now_tab, now_agent)
    return True, ever


def dead_respawn_named(herd, w):
    """True when an intake HEADER status opens with tests or impl and names w as a whole
    word. Any other status, including done and landed, is a death with no RE-SPAWN."""
    coord = os.path.join(herd, "coordinator")
    idir = os.path.join(coord, "intake")
    if os.path.islink(coord) or os.path.islink(idir) or not os.path.isdir(idir):
        return False
    try:
        entries = sorted(os.listdir(idir))
    except OSError:
        return False
    for name in entries:
        if not INTAKE_RE.fullmatch(name):
            continue
        words = header_status(os.path.join(idir, name))
        if words and words[0] in ("tests", "impl") and w in words[1:]:
            return True
    return False


START_FAIL_WITHIN = 2 * 3600       # two failures of one key inside this window stop respawn
START_FAIL_MAIL = 4 * 3600          # owner mail, the row and question status, once per this
START_FAIL_CAP = 5                  # start-failed closes in one pass
START_FAIL_WINDOW = 60              # seconds from started pid= to exited status=
START_LINE_RE = re.compile(r"^(\S+) started pid=([0-9]+)(?: .*)?$")
EXIT_LINE_RE = re.compile(r"^(\S+) exited status=([0-9]+)(?: .*)?$")
START_FAIL_KEY_RE = re.compile(r"[0-9A-Fa-f]{2,}|[0-9]+")
TAB_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,63})?")
INTAKE_ID_RE = re.compile(r"[0-9]{8}T[0-9]{6}Z(?:-[1-9][0-9]*)?")
START_FAIL_QUESTION = "what should happen after this start failure"


def wall_epoch(text):
    """the leading wall.log timestamp as whole epoch seconds, or None"""
    at = local_epoch(text)
    if at is None:
        return None
    return int(round(at))


def wall_log_text(herd, w):
    """the tail of walls/<w>/wall.log when it is a regular file of ours, else None.
    A symlink, another owner's file, or a missing file is not a pair."""
    if not NAME_RE.fullmatch(w):
        return None
    walls = os.path.join(herd, "walls")
    wall = os.path.join(walls, w)
    path = os.path.join(wall, "wall.log")
    if os.path.islink(walls) or os.path.islink(wall) or os.path.islink(path):
        return None
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
        return None
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            return None
        if fst.st_size > WALL_LOG_TAIL:
            os.lseek(fd, fst.st_size - WALL_LOG_TAIL, os.SEEK_SET)
        return os.read(fd, WALL_LOG_TAIL).decode("utf-8", "replace")
    except OSError:
        return None
    finally:
        os.close(fd)


def wall_run_events(text):
    """(kind, epoch, arg) in file order. kind is start or exit. arg is the pid or status."""
    events = []
    for ln in (text or "").splitlines():
        m = START_LINE_RE.fullmatch(ln)
        if m:
            at = wall_epoch(m.group(1))
            if at is not None:
                events.append(("start", at, m.group(2)))
            continue
        m = EXIT_LINE_RE.fullmatch(ln)
        if m:
            at = wall_epoch(m.group(1))
            if at is not None:
                events.append(("exit", at, m.group(2)))
    return events


def latest_start_outcome(events):
    """('exit', status, start_epoch, exit_epoch) when an exit follows the latest
    started pid=, ('open', start_epoch) when none does, else None. An earlier pair
    does not count once a newer start has no exit after it."""
    start_i = None
    for i, ev in enumerate(events):
        if ev[0] == "start":
            start_i = i
    if start_i is None:
        return None
    start_at = events[start_i][1]
    for ev in events[start_i + 1:]:
        if ev[0] == "exit":
            return ("exit", ev[2], start_at, ev[1])
    return ("open", start_at)


def quick_exit_status(events):
    """the exit status when the latest start is followed by an exit at most 60 seconds
    later, else None. Exactly 60 counts. 61 does not."""
    outcome = latest_start_outcome(events)
    if outcome is None or outcome[0] != "exit":
        return None
    delta = outcome[3] - outcome[2]
    if delta < 0 or delta > START_FAIL_WINDOW:
        return None
    return outcome[1]


def header_field(path, key):
    """the header value of `key` (a line before the first blank line), or "" """
    prefix = key if key.endswith(":") else key + ":"
    try:
        st = os.lstat(path)
    except OSError:
        return ""
    if not stat.S_ISREG(st.st_mode):
        return ""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return ""
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            return ""
        data = os.read(fd, HEADER_MAX).decode("utf-8", "replace")
    except OSError:
        return ""
    finally:
        os.close(fd)
    for line in data.split("\n"):
        if line == "":
            break
        if line.startswith(prefix):
            return line[len(prefix):].strip()
    return ""


def start_error_text(pane_id):
    """the first `Error:` line of `herdr pane read <pane id> --lines 20`, printable
    ASCII, at most 200 characters. No such line, or a read that fails, is `-`."""
    if not isinstance(pane_id, str) or not PANE_RE.fullmatch(pane_id):
        return "-"
    rc, out = herdr("pane", "read", pane_id, "--lines", "20")
    if rc != 0 or not isinstance(out, str):
        return "-"
    for line in out.splitlines():
        if not line.startswith("Error:"):
            continue
        clean = "".join(ch for ch in line if 0x20 <= ord(ch) <= 0x7e)
        return clean[:200] if clean else "-"
    return "-"


def start_fail_key(error):
    """the counting key: each run of two or more hex digits, and any remaining digit, is `#`"""
    return START_FAIL_KEY_RE.sub("#", error)


def start_fail_dir(watch):
    return os.path.join(watch, "start-failed")


def ensure_start_fail_dir(watch):
    sdir = start_fail_dir(watch)
    if os.path.islink(watch) or os.path.islink(sdir):
        return None
    try:
        os.makedirs(sdir, 0o700, exist_ok=True)
    except OSError:
        return None
    if os.path.islink(sdir) or not os.path.isdir(sdir):
        return None
    return sdir


def start_timeout_holds(herd, w, pane_id):
    """True when a stop=start-timeout record must be left alone. No record is False.
    A process list that still names cursor-agent, or that did not answer, holds it."""
    rdir = os.path.join(herd, ".resume")
    if os.path.islink(rdir):
        return False
    got = read_regular(os.path.join(rdir, w), 4096)
    if got is None or b"stop=start-timeout" not in got[0].split(b"\n"):
        return False
    if not isinstance(pane_id, str) or not PANE_RE.fullmatch(pane_id):
        return True
    present = cursor_agent_present(pane_id)
    return present is None or present is True


def record_dead_tab(watch, w, tab_id):
    """write the tab id appl-close.sh --dead closes: .watch/<w>.pane, one tab= line.
    The id is the tab row's, so the close is that tab and not a name."""
    if os.path.islink(watch) or not isinstance(tab_id, str) or not TAB_ID_RE.fullmatch(tab_id):
        return False
    put_text(os.path.join(watch, w + ".pane"), "tab=%s\n" % tab_id)
    return True


def role_intakes(herd, w):
    """(role, path) of intakes whose header status is exactly `tests <w>` or `impl <w>`"""
    coord = os.path.join(herd, "coordinator")
    idir = os.path.join(coord, "intake")
    if os.path.islink(coord) or os.path.islink(idir) or not os.path.isdir(idir):
        return []
    try:
        entries = sorted(os.listdir(idir))
    except OSError:
        return []
    out = []
    for name in entries:
        if not INTAKE_RE.fullmatch(name):
            continue
        path = os.path.join(idir, name)
        words = header_status(path)
        if words == ["tests", w] or words == ["impl", w]:
            out.append((words[0], path))
    return out


def taken_worker_names(herd, tab_by, agent_by):
    """names a fresh worker must not wear: listed tabs and agents, the coordinator,
    herd entries, briefs already written, and any name an intake status already uses"""
    taken = set(never_swept())
    for key in list(tab_by) + list(agent_by):
        if isinstance(key, str):
            taken.add(key)
    try:
        for name in os.listdir(herd):
            if NAME_RE.fullmatch(name):
                taken.add(name)
    except OSError:
        pass
    bdir = os.path.join(herd, "coordinator", "briefs")
    if not os.path.islink(bdir) and os.path.isdir(bdir):
        try:
            for name in os.listdir(bdir):
                if name.endswith(".md") and NAME_RE.fullmatch(name[:-3]):
                    taken.add(name[:-3])
        except OSError:
            pass
    coord = os.path.join(herd, "coordinator")
    idir = os.path.join(coord, "intake")
    if not os.path.islink(coord) and not os.path.islink(idir) and os.path.isdir(idir):
        try:
            entries = os.listdir(idir)
        except OSError:
            entries = []
        for name in entries:
            if not INTAKE_RE.fullmatch(name):
                continue
            for word in header_status(os.path.join(idir, name)) or []:
                if NAME_RE.fullmatch(word):
                    taken.add(word)
    return taken


def fresh_start_name(herd, taken):
    """a worker name nobody listed and nobody has had in this herd"""
    for n in range(1, 1000):
        name = "sfk%d" % n
        if name in taken or not NAME_RE.fullmatch(name):
            continue
        if os.path.lexists(os.path.join(herd, name)):
            continue
        if os.path.lexists(os.path.join(herd, "walls", name)):
            continue
        return name
    return None


def write_start_brief(herd, name, role, intake_path, cause="The previous pane exited at start."):
    """a regular brief under this HERD_DIR. The pane's error text is not copied in."""
    coord = os.path.join(herd, "coordinator")
    bdir = os.path.join(coord, "briefs")
    if os.path.islink(coord) or os.path.islink(bdir):
        return None
    try:
        os.makedirs(bdir, 0o700, exist_ok=True)
    except OSError:
        return None
    if os.path.islink(bdir) or not os.path.isdir(bdir):
        return None
    path = os.path.join(bdir, name + ".md")
    if os.path.lexists(path):
        return None
    body = ("You are a Muretai " + role + " session named " + name + ".\n"
            + cause + " The intake is " + intake_path + ".\n"
            "Read that intake as the task and follow it. Your report goes to "
            + os.path.join(herd, name, "report.md") + ".\n")
    try:
        body.encode("ascii")
    except UnicodeEncodeError:
        return None
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError:
        return None
    try:
        os.write(fd, body.encode("ascii"))
    except OSError:
        os.close(fd)
        return None
    os.close(fd)
    return path


def run_sibling(script, args, timeout):
    here = os.environ.get("HERD_WATCH_HERE", "")
    try:
        r = subprocess.run(["bash", os.path.join(here, script)] + list(args),
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0


def set_intake_status(path, words):
    return run_sibling("appl-status.sh", [path, words], 60)


def spawn_fresh(name, brief, herd):
    env_herd = os.environ.get("HERD_DIR")
    os.environ["HERD_DIR"] = herd
    try:
        return run_sibling("herd-spawn.sh", [name, brief], 180)
    finally:
        if env_herd is None:
            os.environ.pop("HERD_DIR", None)
        else:
            os.environ["HERD_DIR"] = env_herd


def respawn_start_failed(herd, w, taken):
    """one herd-spawn of a fresh name when an intake is exactly tests <w> or impl <w>.
    The intake status becomes `<role> <fresh>`. No such intake spawns nothing."""
    found = role_intakes(herd, w)
    if not found:
        return
    role, intake = found[0]
    name = fresh_start_name(herd, taken)
    if name is None:
        return
    brief = write_start_brief(herd, name, role, intake)
    if brief is None:
        return
    taken.add(name)
    if not spawn_fresh(name, brief, herd):
        return
    ledger_event(herd, "respawn", w)
    for got_role, path in found:
        set_intake_status(path, got_role + " " + name)


# The cursor screen when the account hit its usage limit (cursor-agent v2026.10.19).
# A pane whose last non-empty line, stripped, is exactly this is a dead harness.
OUT_OF_USAGE = ("You're out of usage. Switch to Auto, or ask your admin to increase "
                "your limit to continue.")
OUT_OF_USAGE_STATUSES = ("idle", "done")
SPAWN_SAID_RE = re.compile(r"herd-spawn: (failover: )?[a-z]+ did not start \(.*")


def at_out_of_usage(pane):
    if not isinstance(pane, str):
        return False
    lines = [ln.strip() for ln in pane.splitlines() if ln.strip()]
    return bool(lines) and lines[-1] == OUT_OF_USAGE


def spawn_out_of_usage(name, brief, herd, harness):
    """herd-spawn.sh <name> <brief> told, through HERD_SPAWN_OUT_OF_USAGE, that
    <harness> is out of usage. Returns (spawned, its failover or report lines)."""
    env = dict(os.environ)
    env["HERD_DIR"] = herd
    env["HERD_SPAWN_OUT_OF_USAGE"] = harness
    here = os.environ.get("HERD_WATCH_HERE", "")
    try:
        r = subprocess.run(["bash", os.path.join(here, "herd-spawn.sh"), name, brief],
                           stdin=subprocess.DEVNULL, capture_output=True, text=True,
                           timeout=180, env=env)
    except (OSError, subprocess.SubprocessError):
        return False, []
    said = []
    for ln in (r.stderr or "").splitlines():
        ln = "".join(ch for ch in ln if " " <= ch <= "~")[:300]
        if SPAWN_SAID_RE.fullmatch(ln):
            said.append(ln)
    return r.returncode == 0, said


def close_out_of_usage(agent_by, tab_by, status, herd, watch, now):
    """a listed cursor worker, idle or done, whose screen ends on the out-of-usage line
    is closed as dead and re-spawned once through herd-spawn.sh, which fails it over
    along harness.order under the daily cap. Never the coordinator or the notify target."""
    if os.path.islink(watch) or os.path.islink(herd):
        return
    skip = set(never_swept()) | {"muretai-coordinator", os.environ.get("HERD_WATCH_NOTIFY", "")}
    taken = taken_worker_names(herd, tab_by, agent_by)
    for w in sorted(k for k in agent_by if isinstance(k, str)):
        if not NAME_RE.fullmatch(w) or w in skip or w not in tab_by:
            continue
        if status.get(w) not in OUT_OF_USAGE_STATUSES:
            continue
        if spawn_harness(herd, w) != "cursor":
            continue
        state, spath = sweep_state(watch, w, "out-of-usage")
        if state.get("done") is True:
            continue
        if not at_out_of_usage(read_pane(w)):
            continue
        if not record_dead_tab(watch, w, tab_by[w].get("tab_id")):
            continue
        if not appl_close_dead(w):
            continue
        ledger_event(herd, "dead", w)
        put_state(spath, {"done": True, "at": now})
        coord_log(herd, w + " out-of-usage", now, "dead")
        found = role_intakes(herd, w)
        if not found:
            continue
        role, intake = found[0]
        name = fresh_start_name(herd, taken)
        if name is None:
            continue
        brief = write_start_brief(herd, name, role, intake,
                                  "The previous pane stopped at its harness's usage limit.")
        if brief is None:
            continue
        taken.add(name)
        spawned, said = spawn_out_of_usage(name, brief, herd, "cursor")
        for ln in said:
            coord_log(herd, w + " " + ln, now, "out-of-usage")
        if not spawned:
            continue
        ledger_event(herd, "respawn", w)
        for got_role, path in found:
            set_intake_status(path, got_role + " " + name)


def start_fail_did(herd):
    coord = os.path.join(herd, "coordinator")
    if os.path.islink(coord):
        return None
    got = read_regular(os.path.join(coord, "owner.did"), 4096)
    if got is None:
        return None
    lines = [ln.strip() for ln in got[0].decode("utf-8", "replace").split("\n") if ln.strip()]
    if len(lines) == 1 and DID_RE.fullmatch(lines[0]):
        return lines[0]
    return None


def append_stop_row(herd, sentence):
    coord = os.path.join(herd, "coordinator")
    path = os.path.join(coord, "owner-stops.md")
    if os.path.islink(coord) or os.path.islink(path):
        return False
    try:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError:
        return False
    try:
        os.write(fd, (sentence + "\n").encode("ascii"))
    finally:
        os.close(fd)
    return True


def owner_mail(herd, sentence):
    did = start_fail_did(herd)
    if did is None:
        return False
    cli = os.environ.get("APPL_OPERATOR_CLI", "")
    argv = [cli] if cli else ["muretai", "op"]
    argv += ["--as", "dispatch-mac-a", "dm", "--", did, sentence]
    try:
        r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return False
    return r.returncode == 0


def stop_sentence(count, error, ident):
    return ("start-failed x" + str(count) + ": " + error
            + ' -- answer: appl-add.sh "' + START_FAIL_QUESTION + '" --parent ' + ident)


def notify_start_failed(herd, found, count, error):
    """one owner-stops row, one mail, and status: question on each of these intakes.
    The parent id is the first intake's id: header. False when that id is not one."""
    ident = ""
    paths = []
    for _role, path in found:
        got = header_field(path, "id:")
        if not INTAKE_ID_RE.fullmatch(got):
            continue
        paths.append(path)
        if not ident:
            ident = got
    if not ident:
        return False
    try:
        sentence = stop_sentence(count, error, ident)
        sentence.encode("ascii")
    except UnicodeEncodeError:
        return False
    for path in paths:
        set_intake_status(path, "question")
    append_stop_row(herd, sentence)
    owner_mail(herd, sentence)
    return True


def note_start_failure(watch, key, harness, now):
    """remember one failure of this key. Return (stop, state, path). stop means do
    not respawn: the key is latched, or this failure is the second inside 2 hours."""
    if ensure_start_fail_dir(watch) is None:
        return True, {}, None
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    state, path = sweep_state(start_fail_dir(watch), digest, "json")
    times = []
    for t in state.get("times") or []:
        if isinstance(t, bool) or not isinstance(t, int):
            continue
        if now - t <= START_FAIL_WITHIN:
            times.append(t)
    times.append(now)
    try:
        count = int(state.get("count", 0))
    except (TypeError, ValueError):
        count = 0
    if isinstance(state.get("count"), bool):
        count = 0
    count += 1
    latched = state.get("latched") is True or len(times) >= 2
    kept = state.get("harness") if isinstance(state.get("harness"), str) else ""
    if not NAME_RE.fullmatch(kept):
        kept = harness if isinstance(harness, str) and NAME_RE.fullmatch(harness) else ""
    mailed = state.get("mailed")
    if isinstance(mailed, bool) or not isinstance(mailed, int):
        mailed = None
    new = {"count": count, "harness": kept, "latched": latched, "times": times[-20:]}
    if mailed is not None:
        new["mailed"] = mailed
    put_state(path, new)
    return latched, new, path


def mail_due(state, now):
    mailed = state.get("mailed")
    if isinstance(mailed, bool) or not isinstance(mailed, int):
        return True
    return now - mailed >= START_FAIL_MAIL


def clear_start_failed_keys(agent_by, herd, watch, now):
    """a working agent whose wall shows this harness started more than 60 seconds ago,
    with no exit after that start, clears every key recorded for that harness"""
    harnesses = set()
    for w, agent in agent_by.items():
        if not isinstance(w, str) or not NAME_RE.fullmatch(w):
            continue
        if not isinstance(agent, dict) or agent.get("agent_status") != "working":
            continue
        harness = spawn_harness(herd, w)
        if not isinstance(harness, str) or not NAME_RE.fullmatch(harness):
            continue
        text = wall_log_text(herd, w)
        if text is None:
            continue
        outcome = latest_start_outcome(wall_run_events(text))
        if outcome is not None and outcome[0] == "open" and now - outcome[1] > START_FAIL_WINDOW:
            harnesses.add(harness)
    if not harnesses:
        return
    sdir = start_fail_dir(watch)
    if os.path.islink(sdir) or not os.path.isdir(sdir):
        return
    try:
        names = os.listdir(sdir)
    except OSError:
        return
    for name in names:
        if not name.endswith(".json") or os.path.islink(os.path.join(sdir, name)):
            continue
        state, path = sweep_state(sdir, name[:-5], "json")
        if state.get("harness") in harnesses:
            drop_state(path)


def close_start_failed(agent_by, tab_by, herd, watch, now):
    """close panes whose agent exited at start. See the header comment
    'A start-failed pane'. A failed listing never reaches here."""
    if os.path.islink(watch) or os.path.islink(herd):
        return
    clear_start_failed_keys(agent_by, herd, watch, now)
    skip = never_swept()
    names = []
    panes = {}
    statuses = {}
    for w, tab in tab_by.items():
        if not isinstance(w, str) or not NAME_RE.fullmatch(w) or w in skip or w in agent_by:
            continue
        if not isinstance(tab, dict):
            continue
        text = wall_log_text(herd, w)
        if text is None:
            continue
        status = quick_exit_status(wall_run_events(text))
        if status is None:
            continue
        if start_timeout_holds(herd, w, tab.get("pane_id")):
            continue
        names.append(w)
        panes[w] = tab.get("pane_id")
        statuses[w] = status
    names.sort()
    taken = taken_worker_names(herd, tab_by, agent_by)
    told = set()
    closed = 0
    for w in names:
        if closed >= START_FAIL_CAP:
            break
        if not record_dead_tab(watch, w, tab_by[w].get("tab_id")):
            continue
        if not appl_close_dead(w):
            continue
        ledger_event(herd, "dead", w)
        closed += 1
        error = start_error_text(panes.get(w))
        coord_log(herd, w + " " + statuses[w] + " " + error, now, "start-failed")
        harness = spawn_harness(herd, w)
        stop, state, spath = note_start_failure(watch, start_fail_key(error), harness, now)
        found = role_intakes(herd, w)
        if stop:
            key = start_fail_key(error)
            if spath is not None and mail_due(state, now) and key not in told:
                if notify_start_failed(herd, found, state.get("count", 0), error):
                    state["mailed"] = now
                    put_state(spath, state)
                    told.add(key)
            elif key in told:
                for _role, path in found:
                    set_intake_status(path, "question")
            continue
        respawn_start_failed(herd, w, taken)


def close_dead_panes(agent_by, tab_by, herd, watch, now, seen_alive):
    """Close a pane that is unknown, missing its agent, or without a harness process
    once that absence is older than DEAD_AFTER. A worker is a candidate only when its
    rules file is newer than this pass's start and an earlier pass listed it alive.
    See the header comment 'A dead pane'."""
    if os.path.islink(watch):
        return
    workers = owned_workers(herd)
    if not workers:
        return
    panes = listing("pane")
    if panes is None:
        return                                 # herdr did not answer: close nothing, move nothing
    closed = 0
    for w in workers:
        wdir = os.path.join(herd, w)
        rules = rules_file(wdir)
        if rules is None:
            continue
        if rules[1] <= WATCHER_START or w not in seen_alive:
            continue                           # historical, or never seen alive: not dead
        why = classify_dead(w, tab_by.get(w), agent_by.get(w), panes)
        state, spath = sweep_state(watch, w, "dead")
        if why == "skip":
            continue                           # could not tell: the clock stays
        if why == "alive":
            drop_state(spath)
            continue
        if state.get("spawn") != rules[1]:
            state = {}
        if state.get("done") is True:
            continue                           # this spawn's death was already closed
        seen = state.get("seen")
        if isinstance(seen, bool) or not isinstance(seen, int):
            put_state(spath, {"seen": now, "spawn": rules[1]})
            continue                           # first sight: the 300 seconds start here
        if now - seen <= DEAD_AFTER:
            continue
        if closed >= DEAD_CAP:
            continue                           # still due: the next pass closes it
        # a lost REPORT is never final: as in the idle sweep, one more REPORT line and one pass
        unverified = unverified_report(herd, w, rules[1])
        if unverified and state.get("retyped") is not True:
            put_state(spath, {"seen": seen, "spawn": rules[1], "retyped": True})
            emit("REPORT: %s wrote report.md" % w)
            continue
        if not appl_close_dead(w):
            continue                           # the next pass tries again; nothing is counted
        ledger_event(herd, "dead", w)
        closed += 1
        put_state(spath, {"done": True, "seen": seen, "spawn": rules[1]})
        coord_log(herd, w + " " + why, now, "dead")
        if unverified:
            coord_log(herd, w, now, "unverified")
        key = pair_key_of(herd, w)
        if key is not None:
            bump_deaths(watch, key)
        if dead_respawn_named(herd, w):
            file_respawn(w, agent_by.get(w), rules, herd, watch, "dead", mark=False)


def main_once():
    global WATCHER_START, COORD_PANE_ID
    WATCHER_START = time.time()
    fixed ={w for w in os.environ.get("WORKERS", "").split() if NAME_RE.fullmatch(w)}
    herd = herd_dir()
    rotate_coord_log(herd)
    watch = os.path.join(herd, ".watch")
    os.makedirs(watch, exist_ok=True)
    now = clock()
    target_pane = check_target(herd, watch, now)
    tabs, agents = listing("tab"), listing("agent")
    tab_by = {t.get("label"): t for t in tabs or []}
    agent_by = {a.get("name"): a for a in agents or []}
    if tabs is not None and agents is not None:
        listing_ok, seen_alive = note_listing(tabs, agents, herd, watch, now)
    else:
        listing_ok, seen_alive = True, set()   # herdr did not answer: the silent case, not a drop
    target = os.environ.get("HERD_WATCH_NOTIFY", "")
    # the pane the input-box guard reads and clears (coord_prompt)
    pid =(agent_by.get(target) or {}).get("pane_id") if target else None
    COORD_PANE_ID = pid if isinstance(pid, str) and PLAIN_PANE.fullmatch(pid) else None
    # every guard reads the pass's one agent listing (row_status): the tab row never overrides it
    status = {w: row_status(agent_by.get(w), tab_by.get(w)) for w in set(tab_by) | set(agent_by)}
    if target and tabs is not None and agents is not None:
        if status.get(target) == "working":
            coordinator_revive_ended(watch, target)    # herdr shows it working: the episode ended
        elif target_pane is not None:
            coordinator_revive(target, tab_by.get(target), agent_by.get(target), target_pane,
                               herd, watch, now)
    names = sorted(fixed | discovered(agents, herd))
    # a blocked, done or idle pane is read once, here, so the roll call can name a dialog its
    # runtime's adapter recognizes; approve() and the rest below read the same text rather
    # than asking herdr twice
    read = {w: read_pane(w) for w in names if status.get(w) in DIALOG_STATUSES}
    blocked = {w: pane for w, pane in read.items() if status[w] == "blocked"}
    # a cursor pane at the approval box that repeats the pending command (intake
    # 20261019T163318Z) is judged as a blocked pane whatever herdr lists it as, working
    # included: that screen is never typed, empty or box-closed, so no Enter reaches it
    for w in names:
        if w in blocked or status.get(w) not in DIALOG_STATUSES + ("working",):
            continue
        if spawn_harness(herd, w) != "cursor":
            continue
        pane = read[w] if w in read else read_pane(w)
        if cursor_box_command(pane) is not None:
            blocked[w] = pane
    at_dialog = {}
    for w, pane in read.items():
        kind = dialog_kind(pane)
        if kind is not None and kind != LOGOUT_KIND:   # a logged-out pane is the sweep's, below
            at_dialog[w] = kind
    # a pane whose last reply is a logout (the line before it a `Background command ...
    # completed` notice or an `Agent ... failed: ... authentication_failed` line, or
    # nothing: last_reply() takes the last reply) is `<w>=logged-out` on the roll call, not
    # the `done` herdr shows for it -- the coordinator can do nothing with a done worker
    # that is in fact waiting for /login (L1 of 20260930T080513Z)
    out = {w for w, pane in read.items()
           if w not in at_dialog and w not in blocked and pane.strip() and logged_out(pane)}

    def state_of(w):
        return LOGOUT_KIND if w in out else status[w]

    # a worker-held intake's pane (operator ruling 20261012T222304Z), read once here and
    # reused below, so the roll call can carry the stuck count
    held = {}
    if agents is not None:
        for w in held_workers(herd, set(agent_by)):
            held[w] = read[w] if w in read else read_pane(w)
    idle = held_idle(herd, watch, now, held) if held else {}
    stuck_n = intake_stuck(herd, watch, now, idle, tell=False)
    if tabs is None or agents is None:
        emit("WORKERS: herdr: unreadable STUCK=%d" % stuck_n)
        drop_state(os.path.join(watch, "workers"))
    else:
        emit("WORKERS: " + " ".join(["dialog %s %s" % (at_dialog[w], w) if w in at_dialog
                                     else "%s=%s" % (w, word(state_of(w))) if w in tab_by else w
                                     for w in names] + ["STUCK=%d" % stuck_n]))
        # this pass's roll call, one `<w>[=<state>]` word per worker; a dialog is
        # `<kind>_dialog`, a kind that does not fit `[a-z]{1,13}` plain `dialog`. A record,
        # never a live count: appl-hook.sh's SessionStart line asks herdr itself
        roll = " ".join("%s=%s" % (w, at_dialog[w] + "_dialog" if re.fullmatch(r"[a-z]{1,13}", at_dialog[w])
                                   else "dialog") if w in at_dialog
                        else "%s=%s" % (w, word(state_of(w))) if w in tab_by else w
                        for w in names)
        put_text(os.path.join(watch, "workers"),
                 time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)) + " " + roll + "\n")
    orphans = orphaned_caffeinate()
    if orphans > 0:
        emit("ORPHANS: caffeinate=%d" % orphans)
    panes, approved, nudged = {}, set(), set()
    # the notify target is left out of names, so a blocked coordinator would sit
    # on Run this command until a person answered it
    if (tabs is not None and agents is not None and target and NAME_RE.fullmatch(target)
            and target not in names and status.get(target) == "blocked"):
        tpane = read_pane(target)
        if approve(target, agent_by.get(target), watch, tpane):
            approved.add(target)
    for w in names:
        has_report = check_report(w, herd)
        tab, agent = tab_by.get(w), agent_by.get(w)
        if tabs is not None and agents is not None and (status.get(w) != "done" or w in at_dialog or w in out):
            # blocked, working, at a dialog or logged out: any stalled answer's stall ends here,
            # before the paths below that never reach stall_answer(); a failed listing ends none
            drop_state(os.path.join(watch, w + ".stall-answer"))
            drop_state(os.path.join(watch, w + ".stuck-empty"))
        if w in at_dialog:
            # named, never answered: no verdict, no keys, no prompt, no restart -- a line typed
            # into a dialog could answer it
            dialog_stuck(w, at_dialog[w], watch)
            panes[w] = read[w]
            continue
        if tabs is not None:
            dialog_left(w, watch)
        if status.get(w) == "working":
            revive_ended(herd, watch, w)               # herdr shows it working: the episode ended
        if w in blocked:
            # before the logged-out reading: a permission prompt can display a command whose
            # text ends like an expired login, and Enter there approves it. A blocked pane is
            # always judged by verdict() and its PROMPT line, never revived or swept as out
            if approve(w, agent, watch, blocked[w]):
                approved.add(w)
            continue
        if w in read and read[w].strip() and logged_out(read[w]):
            # nothing is typed into a logged-out pane -- no approval, no CONTINUE, no restart:
            # the sweep logs it, files its RE-SPAWN and closes it. The one carve-out is a
            # lapsed login (REVIVABLE): its one revive line per episode, after the grace
            panes[w] = read[w]
            if tabs is not None and agents is not None:
                revive(w, tab, agent, read[w], herd, watch, now)
            continue
        pane = panes[w] = read[w] if w in read else held[w] if w in held else read_pane(w)
        observe_owner_grant(w, pane, watch)            # a command the owner let run, remembered
        stuck(w, pane, watch)
        submitted = resubmit(w, pane, herd, watch, now)  # a text an earlier pass typed, still in the bar
        if cursor_typed_resubmit(w, agent, tab, pane, herd, watch, now):
            continue                                   # its Enter is on its way: no resume this pass
        if claude_typed_resubmit(w, agent, tab, pane, herd, watch, now, submitted):
            continue                                   # its Enter is on its way: no resume this pass
        if tabs is None or agents is None or has_report:
            continue
        if nudge(w, agent, tab, pane, herd, watch, now):
            nudged.add(w)                              # the line is on its way: no resume this pass
            continue
        if stall_answer(w, agent, tab, pane, herd, watch, now):
            continue                                   # its own answer is on its way: no resume this pass
        stuck_empty(w, agent, tab, pane, herd, watch, now)
        resume(w, tab, agent, pane, herd, watch, now)
    listed = None if tabs is None or agents is None else set(tab_by) | set(agent_by)
    check_receipts(herd, watch, status, listed, now)   # listed or not: its pane may be gone
    if tabs is not None and agents is not None:
        if listing_ok:
            deliver_start_timeouts(herd, agent_by, at_dialog, watch, now)
            close_start_failed(agent_by, tab_by, herd, watch, now)
            close_out_of_usage(agent_by, tab_by, status, herd, watch, now)
        # a failed listing still checks a stall; it does not file the RE-SPAWN
        stalls(names, agent_by, tab_by, herd, watch, now, approved, respawn=listing_ok)
        if listing_ok:
            sweep(names, agent_by, tab_by, panes, herd, watch, now, nudged)
            close_dead_panes(agent_by, tab_by, herd, watch, now, seen_alive)
    unfreeze_spawn_freeze(herd, now)
    intake_watchdog(agents, herd, watch, now)
    slot_intake(agents, herd, watch, now)
    seat_stopped(agents, herd, watch, now)
    status_report(herd, watch, now, intake_stuck(herd, watch, now, idle))
    publisher_watch(herd, watch, now)
    backlog_pull(agents, herd)
    fuzz_idle_kick(agents, herd, watch, now)
    main_verdict_tips(herd)
    return 0


PASS_TIMEOUT = 300                # seconds: the default ceiling on one pass
CUT = 124                          # a pass cut at its ceiling exits with this


class _Ceiling(Exception):
    pass


def pass_timeout():
    """HERD_WATCH_PASS_TIMEOUT as positive seconds, else PASS_TIMEOUT"""
    try:
        v = float(os.environ.get("HERD_WATCH_PASS_TIMEOUT") or PASS_TIMEOUT)
    except ValueError:
        return PASS_TIMEOUT
    return v if 0 < v < 1e7 else PASS_TIMEOUT


def bounded_once():
    """One pass under a ceiling (review finding 2 of 65163eb). The pass runs in a forked
    child that leads its own process group; this process waits for it at most
    pass_timeout() seconds. A pass still running then -- blocked anywhere, in a herdr call
    that never answers or an open nobody anticipated -- is killed with its whole group, so
    nothing it started outlives it, and the exit status is CUT. A signal that stops this
    process takes the group down with it."""
    ceiling = pass_timeout()
    sys.stdout.flush()
    sys.stderr.flush()
    pid = os.fork()
    if pid == 0:
        rc = 1
        try:
            os.setpgid(0, 0)
            rc = main_once()
        except SystemExit as e:
            rc = e.code if isinstance(e.code, int) else 1
        except BaseException:
            traceback.print_exc()
        finally:
            try:
                sys.stdout.flush()
                sys.stderr.flush()
            finally:
                os._exit(rc)
    try:
        os.setpgid(pid, pid)                           # the child may not have run yet
    except OSError:
        pass

    def cut(signum, frame):
        raise _Ceiling()

    def stop(signum, frame):
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
        os._exit(128 + signum)

    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s, stop)
    signal.signal(signal.SIGALRM, cut)
    signal.setitimer(signal.ITIMER_REAL, ceiling)
    try:
        _, status = os.waitpid(pid, 0)
    except _Ceiling:
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
        os.waitpid(pid, 0)
        print("herd-watch: pass cut at its %g s ceiling (HERD_WATCH_PASS_TIMEOUT)" % ceiling,
              file=sys.stderr, flush=True)
        return CUT
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    return 128 + (os.WTERMSIG(status) if os.WIFSIGNALED(status) else 0)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "verdict":
        sys.exit(main_verdict(sys.argv[2:]))
    if mode == "once":
        sys.exit(bounded_once())
    if mode == "input-clear":
        sys.exit(main_input_clear(sys.argv[2:]))
    print("usage: herd-watch.sh [once] [--notify NAME] | verdict <worker> [--worktree PATH]", file=sys.stderr)
    sys.exit(2)
PY

pass_once() {
  python3 -I -c "$HERD_WATCH_PY" once
}

# this script's content as one blank-free token (`<crc>-<bytes>`), or empty when unreadable
script_sum() {
  cksum < "$self" 2>/dev/null | awk 'NF >= 2 { print $1 "-" $2 }'
}

usage() {
  echo "usage: herd-watch.sh [once] [--notify NAME] | verdict <worker> [--worktree PATH]" >&2
  exit 2
}

# herdr's agent-name rule, the same one herd-spawn.sh applies to a worker name
agent_name_ok() {
  case "$1" in
    ''|*[!a-z0-9_-]*|[!a-z]*) return 1 ;;
  esac
  [ ${#1} -le 32 ]
}

if [ "${1:-}" = "verdict" ]; then
  shift
  exec python3 -I -c "$HERD_WATCH_PY" verdict "$@"
fi

# the coordinator input-box guard alone, for tools/appl-add.sh's wake: input-clear <herdr> <pane> <line>
if [ "${1:-}" = "input-clear" ]; then
  shift
  exec python3 -I -c "$HERD_WATCH_PY" input-clear "$@"
fi

mode=loop
if [ "${1:-}" = "once" ]; then
  mode=once
  shift
fi
unset HERD_WATCH_NOTIFY
while [ $# -gt 0 ]; do
  case "$1" in
    --notify)
      [ $# -ge 2 ] || usage
      if ! agent_name_ok "$2"; then
        echo "herd-watch: --notify takes an agent name ([a-z][a-z0-9_-], at most 32)" >&2
        exit 2
      fi
      export HERD_WATCH_NOTIFY="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

case "$mode" in
  once)
    pass_once
    exit $?
    ;;
  loop)
    prev=""
    prev_orphans=""
    self_sum="$(script_sum)"
    bad_sum=""
    while true; do
      if [ -n "$self_sum" ]; then
        new_sum="$(script_sum)"
        if [ -n "$new_sum" ] && [ "$new_sum" != "$self_sum" ] && [ "$new_sum" != "$bad_sum" ]; then
          if bash -n "$self" 2>/dev/null; then
            echo "herd-watch: reloaded $self_sum..$new_sum" >&2
            exec bash "$self" ${orig_args[@]+"${orig_args[@]}"}
          fi
          echo "herd-watch: kept $self_sum, $new_sum fails bash -n" >&2
          bad_sum="$new_sum"
        fi
      fi
      out="$(pass_once)"
      cur_orphans=""
      # the loop prints WORKERS: and ORPHANS: only when they changed; every other line as it comes
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        case "$line" in
          WORKERS:*) [ "$line" = "$prev" ] && continue; prev="$line" ;;
          ORPHANS:*) cur_orphans="$line"; [ "$line" = "$prev_orphans" ] && continue ;;
        esac
        printf '%s\n' "$line"
      done <<EOF
$out
EOF
      prev_orphans="$cur_orphans"
      sleep "${HERD_WATCH_INTERVAL:-20}"
    done
    ;;
esac
