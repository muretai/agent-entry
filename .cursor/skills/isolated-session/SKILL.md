---
name: isolated-session
description: Isolate every code change in this repo into its own Git worktree and unique branch, with one live session per folder, so parallel chats -- Claude Code, Cursor, Codex, a person in a second window -- cannot mix files, HEAD, or commits. Dev sessions (feat/) and design sessions (design/) keep to their own paths. Use for any implement, fix, add, refactor, test, UI, design, bug, 実装, 修正, 追加, 直して, 作って, デザイン request even when the user did not type /worktree. Also use for 並列, worktree, ブランチ混入, セッション isolation, 同時編集.
icon: git-branch
color: green
---

# Isolated session

The user types a normal task. Do not wait for a pasted kickoff prompt. Isolate first, then do the work.

## Do this before any file edit

1. Run `scripts/stale.sh`. It exits non-zero when something is past the deadline; deal with those before adding to the pile (see **Deadline**). Its last block is who holds which folder right now.
2. Run `scripts/ensure-worktree.sh` with the user's task as the first argument -- `--design` first when the task is design work (see **Two kinds of session**).
3. Read WORKTREE=, BRANCH= and KIND= from the script output.
4. Edit, test, and commit only inside WORKTREE.

```bash
bash .cursor/skills/isolated-session/scripts/stale.sh
bash .cursor/skills/isolated-session/scripts/ensure-worktree.sh "<user task>"
bash .cursor/skills/isolated-session/scripts/ensure-worktree.sh --design "<user task>"
```

`ensure-worktree.sh` refuses to start when the primary checkout is sitting on a session branch, when BASE and `origin/BASE` have diverged, when the branch it would use already exists without a worktree, or when the folder it would use is **open in another live session**. Each refusal names the fix. Do not paper over one with an override you cannot defend.

## Two kinds of session

- A **dev** session is the default: branch `feat/<slug>`.
- A **design** session -- `--design` -- is for the pages, the theme, the brand copy: branch `design/<slug>`.
- A repository that separates the two lists what design owns in `.cursor/design-paths` (one path per line; a directory prefix ends in `/`). A design session lands only those files; a dev session lands none of them. `finish-worktree.sh` refuses the rest, naming the crossing files. `ISOLATED_SESSION_CROSS=1` lands a crossing change on purpose -- say why in the commit.
- No `.cursor/design-paths` means this repository has no design sessions: `--design` is refused and told to open in the repository that owns the design. In this project that is `muretai-site`; core carries only pinned copies of the design.

## One live owner per folder

Isolation is per folder, not per chat. `ensure-worktree.sh` takes the worktree for this session -- a lock inside the worktree's own git dir, keyed to the chat's owner -- and a second chat asking for the same folder is refused, naming the first. A folder whose owner is gone is taken over with a note. `assert-head.sh` checks the lock before every commit; `stale.sh` lists every holder, with its kind and whether it is alive, GONE, or EXPIRED.

The hook `scripts/session-guard.sh` makes that binding on an editor that never read this file. Claude Code and Claude Desktop run it from `.claude/settings.json`, Cursor from `.cursor/hooks.json`, Grok Build from both:

- **before a file-editing tool** it refuses an edit in the primary checkout, in a folder another live session holds, and in a folder nobody holds -- with the sentence that fixes it;
- **on session start**, when the chat opened a linked worktree directly, it takes that folder (if nobody live holds it) and puts the open-session inventory in front of the chat; when someone does hold it, the chat is told to STOP before its first edit;
- **on session end** it releases every folder this session held.

A launch cannot be vetoed by a hook; the first edit can. That is where a person's second window on the same folder is stopped, whatever they meant to do. `scripts/claim-worktree.sh [path]` takes a free or abandoned folder in place -- never one a live session holds. `ISOLATED_SESSION_GUARD_TRACE=1` in the editor's environment appends one line per event to `<primary>/.git/isolated-session-guard.log` -- how a harness's dialect is verified on its first live chat.

## Harnesses: who the owner is

The owner is a key. For a harness that runs one process per chat it is that process; for one whose chats share a process it is a key the hook reads off its payload and hands to the chat's shells, so the chat's scripts and its hooks agree.

| harness | owner | how the hook is wired | notes |
|---|---|---|---|
| Claude Code (CLI, editor extension) | the chat's `claude` process | `.claude/settings.json` | one process per chat |
| Claude Desktop (Code tab) | the chat's `claude` process | `.claude/settings.json` (Desktop reads project settings for local sessions) | a VM-backed Desktop session reads no project hooks -- and touches no local folder. Desktop's own worktrees under `.claude/worktrees/<name>` are claimable linked worktrees; its GC removes one lock and all, after which the next edit is refused as "no session holds" |
| Cursor Agent mode | `cursor:<conversation_id>` | `.cursor/hooks.json` (camelCase events, `{"permission":"deny"}`) | every chat in a window shares one `agent-exec` process; sessionStart's `env` response gives the chat `ISOLATED_SESSION_OWNER`. A shell that lacks it is told the `export` that fixes it. A key-owned lock also expires after `ISOLATED_SESSION_OWNER_TTL_HOURS` (12) without a `mine` verdict, since a closed chat may send no sessionEnd |
| Grok Build (`grok`, xAI's terminal agent) | the session's `grok` process | reads `.claude/settings.json` and `.cursor/hooks.json` itself (camelCase payload, `{"decision":"deny"}` or exit 2) | project hooks need folder trust once (`/hooks-trust` or `--trust`) |
| Codex, a terminal | the `codex` process / the terminal | no hook here | the scripts bind it: `ensure-worktree.sh`, `assert-head.sh` before every commit |
| Grok Bot (the desktop app with a cloud computer) | its local exec daemon -- one owner for every chat | **none: it reads no hooks** | not guarded (owner decision 2026-09-11). The Bot is instructed to run the scripts; `stale.sh` names it as `grokbot`. Two Grok Bot chats given the same task string would share a worktree |

`iso_harness_keys_shells` in `scripts/lib.sh` is the one-line table of harnesses whose payload id becomes the key; extend it only for a harness that also carries the key into its shells.

## Already isolated?

Isolated when `.git` is a file (linked worktree), HEAD is not main/master/develop, and the folder's lock is this session's. If you are in the primary checkout, run the script. Do not edit the primary checkout.

Cloud Agent VMs are already isolated. Stay on the `cursor/...` branch. Never push to main.

## HEAD lock

- Do not git switch/checkout away from BRANCH
- Do not git -C into another worktree to commit
- Before every commit and push:

```bash
bash .cursor/skills/isolated-session/scripts/assert-head.sh "$BRANCH" "$WORKTREE"
```

Abort if it fails.

## Finish

When the user's request is done (tests pass, nothing left of the task), merge into BASE. Isolation is for the session, not forever: an unmerged `feat/*` or `design/*` branch means MAIN did not receive the work.

Do not open a draft PR as a substitute for merging. Do not wait to be asked.

1. Commit remaining work on BRANCH only.
2. Confirm HEAD, then merge and delete the session worktree:

```bash
bash .cursor/skills/isolated-session/scripts/assert-head.sh "$BRANCH" "$WORKTREE"
bash .cursor/skills/isolated-session/scripts/finish-worktree.sh "$BRANCH" "$WORKTREE"
```

`finish-worktree.sh` is the one serial section of parallel work, so it is short and ordered:

1. it takes the **landing lock** (`<primary>/.git/landing.lock`; one landing at a time; a live holder is waited for up to `ISOLATED_SESSION_LAND_WAIT` seconds, default 2700, a dead one taken over);
2. it **rebases** BRANCH onto the current BASE (a branch already on origin -- another laptop's -- is merged, never rewritten; `ISOLATED_SESSION_LAND_MERGE=1` merges too). A conflict confined to the generated files (`PLAN.md`, `docs/IMPLEMENTATION_BACKLOG.md`, `docs/SPECIFICATION.md`) is resolved with BASE's copy; any other conflict stops the landing with the steps to resolve it in the worktree;
3. it **refuses a branch that edited a generated file** (`tools/ledger.py check --diff BASE --diff-only`) -- a session writes only its note;
4. it runs **the tests the diff owes** (`tools/run_tests.py --affected BASE..HEAD -j 4`; `ISOLATED_SESSION_LAND_JOBS`); red stops the landing with the red files and their last lines, the worktree left in place, already rebased; `ISOLATED_SESSION_LAND_TESTS=0` skips them and the receipt says so; a test that leaves the tree dirty stops it too;
5. it **scans the diff** (`tools/sec_lint.py --diff BASE..HEAD --json`): `refused` -- a private key, a credential in a known shape, a guard override written into a script -- stops the landing exactly as a red test does, the findings on stderr and the worktree left to fix; `needs-eyes` -- the audited surface or a guard file changed, or a construct a reviewer should see -- lands and owes a reviewer; `clean` owes nothing. **The lint that runs is BASE's**, read out of its blobs (`git show BASE:tools/sec_lint.py`, with `tools/audit_scope.py`) into a scratch directory inside the worktree and removed before the tree is checked again -- never the branch's copy, and never as a fallback when BASE has none (`SEC=none (base has no tools/sec_lint.py)`). And the landing decides one thing itself, from the paths alone: a diff that touches a **gate file** -- `tools/sec_lint.py`, `tools/audit_scope.py`, `tools/ledger.py`, `tools/run_tests.py`, anything under this skill's `scripts/` or `briefs/`, the security-audit skill's `references/`, `.claude/settings.json`, `.cursor/hooks.json` -- is `needs-eyes` whatever the lint said (a `refused` stays refused), those paths go on the reviewer's list, and the receipt line ends in `; gate files changed`. The lint is one of the files on that list, which is why the lint cannot be the one to say so;
6. it **regenerates the ledgers on the tip** (`tools/ledger.py build`) and commits `ledger: regenerate on landing <branch>` when they changed;
7. it fast-forwards BASE, removes the worktree (its lock goes with it), deletes BRANCH, releases the landing lock;
8. when the scan said `needs-eyes`, it **spawns the reviewer** -- unless `<primary>/.security/review-cadence` says `daily`, in which case the receipt says `REVIEW=deferred` and `tools/security_daily.sh` (the daily LaunchAgent, `company/ops/launchd/`, 02:00) reads the whole day's range once and writes one receipt for it; `ISOLATED_SESSION_LAND_REVIEW=1` on a landing still spawns one for that landing. Per landing, when it does spawn: the per-landing brief (`.claude/skills/security-audit/references/landing-review-brief.md`) is rendered with the base sha before the merge, the new tip, the branch and the files to review, written to `~/.cache/muretai-herd/briefs/<name>.md`, and `herd-spawn.sh <name> ... --profile reviewer` starts a session on it (see **Workers through herdr**). The name is `secrev-<20 characters of the branch tail>-<4 of the landed tip>` (32 at most, herdr's bound; unique per landing, so two branches that share a prefix never share a reviewer, a brief or a checkout). The reviewer's cwd is a detached checkout of main as it was BEFORE the landing, `$HERD_DIR/review/<name>` -- OUTSIDE the primary, so the landed tip's `CLAUDE.md` is no parent of it and no session worktree shares its name. The landing removes only what a landing created there: an entry whose physical parent is the physical review root, that git lists as a worktree, whose git dir carries the marker the landing wrote (`muretai-review-checkout`), that is detached, a day old, and held by no live session -- and it walks the review root only after checking that the root is a real directory of ours. `HERD_DIR` defaults to `~/.cache/muretai-herd`, never `/tmp`: Claude Code reads `CLAUDE.md` from the cwd and every directory above it, and `/private/tmp` is world-writable, so a checkout there could be steered by any local uid; the landing and `herd-spawn.sh` refuse a `HERD_DIR` or a cwd with a directory above it that others can write to, and the worker's settings exclude memory files under the temporary directories (`claudeMdExcludes`) as a second layer. A worker obeys the instruction files of its checkout and below, none above: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` and `.claude/rules/` in every directory above its cwd are excluded from memory and denied to Edit/Write, as are the review checkouts, the briefs, the herd's own top-level memory files and `~/.claude/`; auto memory is off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the tab, `autoMemoryEnabled: false` in the settings), because it is shared by every session of the repository and written by any of them. A type change is content to the scan (a symlink that becomes a script is a new script), and `AGENTS.override.md` and `.cursor/mcp.json` are gate files. When neither `HERD_DIR` nor `HOME` is set, the landing says `REVIEW=needed` and a spawn exits 2, instead of dying on an unset variable. The landing's gate list is BASE's lint's own table (`tools/sec_lint.py --gate-files`), so there is one table: the whole `.cursor/skills/` tree, `tools/security_weekly.sh` and `company/ops/launchd/` are in it, and an added or type-changed symlink is needs-eyes anywhere, because its target is what runs under the link's name. Herd sessions start with `--strict-mcp-config`: no MCP server reaches them. **The template and the spawner are BASE's too**: `git show <base-before>:<path>` of the template, and of `scripts/herd-spawn.sh` plus `lib.sh` into a temporary directory that is removed after the spawn -- never the primary's working tree, which the fast-forward has just moved to the landed tip, so its copies are the branch's. The render is one pass over the placeholders; the branch name and the file list are data the diff chose, rendered as backticked paths with any backtick, brace pair or newline removed, and the brief says so. The review is non-blocking and runs AFTER the landing; it can neither delay nor fail it. When herdr is absent or down, or `ISOLATED_SESSION_LAND_REVIEW=0`, or BASE had no template or no spawner before this landing, the receipt carries the command to run by hand, because the review is owed either way.

A repository without `tools/run_tests.py`, `tools/sec_lint.py` or `tools/ledger.py` (a pinned copy of this skill) lands as it always did and says `TESTS=none` / `SEC=none` / `LEDGER=none`, with `REVIEW=none`. The receipt carries `REBASED=`, `LANDING_LOCK=waited Ns`, `TESTS=`, `TESTS_SECS=`, `TESTS_FILES=`, `SEC=` (`clean`; `needs-eyes (N file(s) to review: a b c)` -- the audited surface, the guard files and any file that added a construct the lint flags -- with `; gate files changed` before the closing parenthesis when the landing itself forced the verdict; `none (base has no tools/sec_lint.py)`), `LEDGER=`, `HANDOFF=` (`pushed <tip> to <path>` when the primary has a `handoff` remote -- the local bare repository the publisher, another user with the only GitHub token, evaluates and pushes from, see `company/ops/publisher/README.md`; `none (no handoff remote)`; `failed: ...`, never a failed landing), and last `REVIEW=` (`spawned <name> (pane <id>)`; `needed -- run: bash .cursor/skills/isolated-session/scripts/herd-spawn.sh <name> ~/.cache/muretai-herd/briefs/<name>.md --profile reviewer --cwd ~/.cache/muretai-herd/review/<name> --var MAIN=<primary>`; `none`). A `REVIEW=` line is printed whatever happened after the merge -- a checkout that could not be opened is `needed`, never a failed landing. A gate file that is deleted, renamed away or turned into a link counts as a gate change (`CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/` and `.cursor/rules/` are gate files too: every session in the tree obeys them, a reviewer's included), and a branch that removes `tools/sec_lint.py` or `tools/audit_scope.py` is refused before the scan, because the next landing's gate would be `SEC=none`. Abort if it fails. Do not `--force` anything. Report `SEC=` and `REVIEW=` to the owner with the rest of the receipt: a `REVIEW=needed` is a human check they have to see.

**It does not push BASE, and it must not.** Local BASE and `origin/BASE` are not the same history in this repo, and landing a trunk on the remote is the owner's deliberate act, not a side effect of finishing a session. If the receipt says local BASE is ahead of the remote, report that to the owner and let them decide.

**The no-push speed bump, and the wall.** Every session opener (`ensure-worktree.sh`, `claim-worktree.sh`, the session guard's sessionStart) installs `<common git dir>/hooks/pre-push`, which refuses every push unless `ISOLATED_SESSION_PUSH=1` is in the environment; the openers report it as `PREPUSH=installed|present|repaired|replaced|foreign` (`repaired` = a hook carrying our marker but not our body was rewritten; `replaced` = a symlink, FIFO or directory sat at the path; `foreign` = a pre-push hook that is not ours was left alone; a `core.hooksPath` that sidelines it is named, control characters stripped). A session never sets that variable -- `tools/sec_lint.py` refuses the spelling inside any script -- so a push is something the owner types in a terminal: `ISOLATED_SESSION_PUSH=1 git push origin main`. Know what it is: it stops an honest session and a mistake. A same-uid process with code execution can set the variable itself, pass `--no-verify`, or point `core.hooksPath` elsewhere; the wall against that is a push credential no process can use without the owner (an SSH key added with `ssh-add -c`, or no push credential on the box), and the landing runs the branch's tests with git's credential helpers cleared, no terminal prompt, ssh disabled and `gh` pointed at an empty config.

If the user explicitly asked for a PR and not to merge: open a **ready-for-review** PR (not draft) targeting BASE.

Cloud Agent VMs: `finish-worktree.sh` exits 3. Open a ready-for-review PR. Never push to main. A draft PR does not count as finished -- the queue it lands in is nobody's, and it will still be sitting there in a month.

## Deadline

**Seven days. Land it or retire it -- holding is not one of the options.** This applies to a local branch and to an open PR alike. `scripts/stale.sh` is the inventory: unlanded branches with their age, worktrees carrying uncommitted work, who holds which folder, and the open PR queue.

Retiring keeps the history, so it costs nothing:

```bash
git tag archive/<branch> <branch> && git branch -D <branch>
```

Look at the "uncommitted work" block before retiring anything -- that work exists nowhere else.

## Overrides

Each one is a decision you have to be able to defend out loud:

| variable | meaning |
|---|---|
| `ISOLATED_SESSION_FORCE=1` | start anyway on a squatting primary checkout or a diverged BASE. For the session that is *doing* the reconcile. |
| `ISOLATED_SESSION_RESUME=1` | reattach to an existing branch that has no worktree (a killed session). |
| `ISOLATED_SESSION_CROSS=1` | land a design session's change outside its paths, or a dev session's change inside them. Say why in the commit. |
| `ISOLATED_SESSION_TAKEOVER=1` | evict a live session from a folder. Only when that session is yours and idle. |
| `ISOLATED_SESSION_OWNER=<key>` | who this session is: a pid, or a harness key such as `cursor:<conversation_id>` (Cursor's sessionStart hook sets it; the tests use it). |
| `ISOLATED_SESSION_OWNER_TTL_HOURS=N` | how long a key-owned lock stays alive without a `mine` verdict (default 12). |
| `ISOLATED_SESSION_GUARD=off` | switch the hook off for one editor process. |
| `ISOLATED_SESSION_GUARD_TRACE=1` | log every hook event and verdict to `<primary>/.git/isolated-session-guard.log`. |
| `ISOLATED_SESSION_STALE_DAYS=N` | change the deadline `stale.sh` measures against. |
| `ISOLATED_SESSION_LAND_REVIEW=0` | do not spawn the reviewer after a `needs-eyes` landing. The receipt still says `REVIEW=needed` with the command: the review is owed, you are choosing to start it yourself. |

## Workers through herdr

`scripts/herd-spawn.sh <name> <brief-file> [--cwd DIR] [--profile worker|reviewer] [--env K=V ...] [--var KEY=VALUE ...]` starts one worker session: a herdr tab in a checkout (default: the primary checkout of the repository the script lives in), an interactive `claude` in it -- its own process, so the guard sees it as its own session -- and the brief as its first prompt. `{{KEY}}` placeholders in the brief are filled from `--var`; `{{NAME}}`, `{{PRIMARY}}` (the cwd) and `{{REPORT}}` are filled for you, in ONE pass (a value is substituted, never re-scanned, so a value carrying `{{NAME}}` reaches the worker as literal text); the filled copy is `~/.cache/muretai-herd/briefs/<name>.md`, and a placeholder the template carries that nobody filled stops the spawn (exit 2) rather than reaching a worker as literal braces. What herdr is told to prompt is the text the script rendered, not a re-read of that file. Each worker gets its own directory, `~/.cache/muretai-herd/<name>/`, the only directory added to its session (`--add-dir`), and its report is `~/.cache/muretai-herd/<name>/report.md`; `HERD_DIR` moves `~/.cache/muretai-herd`, which is created mode 700 when absent and refused (exit 2) when it exists and someone else owns it. It exits 3 with one line when herdr is not on PATH or its server is down (`HERD_SPAWN_BIN` names the binary), and on success prints one line: `worker=<name> pane=<id> tab=<id> report=~/.cache/muretai-herd/<name>/report.md`. The worker runs in Claude Code unless `HERD_SPAWN_HARNESS=cursor` names Cursor's CLI agent instead (herdr drives either; the same brief, report directory and receipt tools; the same allow/deny lists written in Cursor's spelling to the workspace's `.cursor/cli.json`, gitignored, plus `Read`/`Write` of the worker's report directory and `Write` of the primary's `.worktrees/`; the model is the Cursor account's default unless `HERD_SPAWN_MODEL` names one). Cursor's CLI runs in the account's **allowlist** mode, never `--auto-review`: measured on 2026-09-12, the classifier mode ran `git push`, `cat` and `curl` past their deny rules, while in allowlist mode a denied command is blocked, an allowed one runs, and an unlisted one waits for a person (the session shows as `blocked` in herdr, the safe failure); the spawn refuses when `~/.cursor/cli-config.json` says another `approvalMode`. Cursor's CLI does run the project's `.cursor/hooks.json`, so the isolated-session guard holds there too (measured: `owner=cursor:<conversation_id>` in the trace). In Claude Code the worker runs on `opus` (`HERD_SPAWN_MODEL` overrides it with an alias or a model id; a reviewer reads for twenty to forty minutes, and on a subscription that is the cost that matters) and in `auto` permission mode (`HERD_SPAWN_PERMISSION_MODE` overrides it with exactly one of `auto`, `acceptEdits`, `manual`, `plan` -- anything else, an empty string included, is exit 2 before herdr is asked anything, and the value is not handed down to the tab, so a session a worker spawns starts from the default again; in `acceptEdits` a worker stops at every command outside the allowlist, and the first real reviewer did). The allowlist names each script by its exact path -- `python3 tools/audit_scope.py`, `tools/ledger.py`, `tools/sec_lint.py`, `tools/affected_tests.py`, `tools/spec_build.py`, `python3 -m agent.plugins`, these scripts, `cd`, read-only git plus `git add` / `git commit`, `grep` / `ls` / `wc` / `head` / `tail` -- never bare `python3` or a directory prefix (a Bash rule matches the command's PREFIX, so either would run whatever the diff itself landed) and never `cat` (Read is the tool for a file). `--profile worker` (default) adds `python3 tools/run_tests.py` and `python3 tests/test_*`; `--profile reviewer` -- what a landing and the weekly clock use -- does not, because a reviewer runs no tests and reads a diff an attacker may have written in full. `git push` is refused by the session's own rule, which is a promise the session keeps, not a guard on the remote. A worker is an interactive session, billed like one. Its rules are a settings file the spawn writes exclusively (`$HERD_DIR/<name>/permissions.json`, O_EXCL, mode 600, in a directory it owns) and loads with `--setting-sources project,local`, so the owner's user-global settings never reach a worker; the deny list names the shell readers and interpreters and `git diff --no-index`. A deny list is not containment (ISSUE(reviewer-sandbox-is-a-denylist)).

`briefs/worker.md` is the generic brief: the eight steps a worker takes (`stale.sh`; its OWN `ensure-worktree.sh "{{TITLE}}"`, so the worktree is the worker's and not the coordinator's; `assert-head.sh`; the task; the tests; `ledger.py new`; commit; `finish-worktree.sh` from the primary; the report to `~/.cache/muretai-herd/<name>/report.md`) and the rules (never push, no overrides, no full suite, never the generated files or `tools/test_times.json` / `tools/units.json`). A coordinator fills `TITLE`, `PLAN`, `UNIT`, `TESTS` and `TASK`:

```bash
bash .cursor/skills/isolated-session/scripts/herd-spawn.sh ports .cursor/skills/isolated-session/briefs/worker.md \
  --var "TITLE=Tests bind ephemeral ports instead of fixed ones" --var PLAN=host --var UNIT=tests \
  --var "TESTS=tests/test_artifact.py tests/test_roomhost.py" --var "TASK=$(cat ~/.cache/muretai-herd/briefs/ports-task.md)"
```

The reviewer a landing spawns is the same mechanism with the security-audit skill's `landing-review-brief.md`; `tools/security_weekly.sh` spawns the weekly hunt with its `weekly-audit-brief.md`. `python3 tests/test_herd_spawn.py` is the contract, against a herdr stub.

## Dispatch

Dispatch is orchestration across Herdrs: the job moves, the runtime stays yours. This skill is the Hand. After Bob's owner accepts a 1:1 coord ticket, `scripts/dispatch-take.sh --as <agent> --context <contextId> [--capacity-file PATH] [--primary DIR] [--room DID]` reads the thread from `operator_cli` JSON, refuses unless this DID accepted it, checks the local stance (`~/.muretai/dispatch/capacity`, `open` or `full`), checks Room `/mem` for a `taken-by` line (before "is this mine", so a third desk that was not the recipient still exits 4), writes `/remember note [task] <contextId> | taken-by=<did> lane=working at=<iso>`, and spawns a worker with `herd-spawn.sh` (worker profile) in the resolved repo. `repo` is a name looked up in `~/.muretai/dispatch/repos` (`name=<path>`), or `--primary`. Ticket fields reach `briefs/dispatch-ticket.md` as fenced DATA through `--var` and are never a shell argument to anything else; the script never calls `herdr agent prompt`. Exit 0 spawned, 2 not accepted / not mine / missing key / unknown repo, 3 herdr down (prints the by-hand command), 4 stance full or already taken (prints who). `scripts/dispatch-capacity.sh open|full [reason]` writes the same capacity file the App's loopback writes. `python3 tests/test_dispatch_take.py` is the unit contract; `python3 tests/test_dispatch_v1.py` is the two-desk v1 fixture.

## Copies in other repositories

This skill's home is the core trunk. Any other repository carries a pinned copy: `scripts/vendor.sh pull` brings the scripts, this file and the contract test over from `${MURETAI_CORE:-~/muretai-trunk}` and writes `VENDOR.json`; `scripts/vendor.sh check` holds the copy to that pin with no core checkout present. Never patch a copy -- fix the home and pull again. The script judges the repository by where it lives, so the first pull is a bootstrap: copy `scripts/vendor.sh` and `scripts/lib.sh` into the new repository's `.cursor/skills/isolated-session/scripts/`, then run that copy's `vendor.sh pull`. The home's scripts also run against any other checkout you `cd` into -- that is how the first session in a repository without the skill is opened.

## Never

Two chats in the same folder. Commit on main. Force-push shared branches. Reuse another session's branch. Leave a finished session unmerged. Open a draft PR instead of merging. Push BASE from a session. Land design in a dev session, or dev in a design session, without saying why.

## Tested by

`python3 tests/test_isolated_session.py` -- runs these scripts and the hook against a throwaway repo with a real `origin` on disk, as a second session and as an editor would hit them, and asserts what an operator can see. If you change a script, that suite is the contract. `python3 tests/test_dispatch_take.py` and `python3 tests/test_dispatch_v1.py` cover the Dispatch Hand.
