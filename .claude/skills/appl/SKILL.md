---
name: appl
description: File a requirement with APPL (Agent Parallel Proof Loop) -- 'APPL' is a proper noun, not 'apply'. Use when the person says 'XX を APPL して', 'APPL this', 'use APPL for XX', 'add to the backlog', 'queue XX', 'later:' or 'idea:' (also 'バックログに積んで', 'アイディア'). Hands their sentence, verbatim, to the vendored parser, which files an intake now or an idea in the backlog inbox; never implement, never land, never spawn.
---

# APPL: file it, say where, stop

**APPL is the name of a pipeline (Agent Parallel Proof Loop). It is not the verb "apply" and not 「適用」.** A sentence that asks for APPL means ONE thing: file it, so a separate coordinator session runs it through test author -> implementer -> reviewer -> publisher, now or when the backlog reaches it. 「適用して」 / "apply this" is NOT APPL; if you are unsure which the person meant, ask, do not act.

When asked to APPL something, or to put it in the backlog, do exactly this and nothing else:

1. Do NOT implement, edit files, create or reclaim worktrees, start Herdr workers, land, commit, push, redeploy anything, or "coordinate" the task yourself. A session that does any of that has misread the instruction.
2. From the top of the repository the person is talking about, hand their sentence to the parser. Paste the sentence EXACTLY as they wrote it -- trigger words, priority words and all, not restated, not translated, not quoted or escaped -- on the one line between the heredoc markers. The quoted marker (`<<'APPL_SENTENCE'`) means nothing in it is expanded or run.

   ```bash
   rel=".cursor/skills/isolated-session/scripts/appl-phrase.py"
   is_xyz() {
     case "$1" in
       *[!0-9.]*) return 1 ;;
       *.*.*.*) return 1 ;;
       *.*) ;;
       *) return 1 ;;
     esac
     local a b c saved_ifs
     saved_ifs=$IFS
     IFS=.
     read -r a b c <<< "$1"
     IFS=$saved_ifs
     [ -n "$a" ] && [ -n "$b" ] && [ -n "$c" ]
   }
   xyz_gt() {
     local a1 a2 a3 b1 b2 b3 saved_ifs
     saved_ifs=$IFS
     IFS=.
     read -r a1 a2 a3 <<< "$1"
     read -r b1 b2 b3 <<< "$2"
     IFS=$saved_ifs
     if [ "$a1" -gt "$b1" ]; then
       return 0
     fi
     if [ "$a1" -lt "$b1" ]; then
       return 1
     fi
     if [ "$a2" -gt "$b2" ]; then
       return 0
     fi
     if [ "$a2" -lt "$b2" ]; then
       return 1
     fi
     [ "$a3" -gt "$b3" ]
   }
   parser=""
   if [ -f "$rel" ]; then
     parser="$rel"
   else
     ver=""
     if [ -f appl.toml ]; then
       while IFS= read -r line || [ -n "$line" ]; do
         case "$line" in
           'version = "'*'"')
             prefix='version = "'
             ver=${line#"$prefix"}
             suffix='"'
             ver=${ver%"$suffix"}
             break
             ;;
         esac
       done < appl.toml
     fi
     is_xyz "$ver" || ver=""
     if [ -n "$ver" ] && [ -d "$HOME/.appl/$ver" ]; then
       parser="$HOME/.appl/$ver/$rel"
     elif [ -d "$HOME/.appl/latest" ]; then
       parser="$HOME/.appl/latest/$rel"
     else
       best=""
       if [ -d "$HOME/.appl" ]; then
         for dir in "$HOME/.appl"/*; do
           [ -d "$dir" ] || continue
           name="${dir##*/}"
           is_xyz "$name" || continue
           if [ -z "$best" ] || xyz_gt "$name" "$best"; then
             best="$name"
           fi
         done
       fi
       if [ -n "$best" ]; then
         parser="$HOME/.appl/$best/$rel"
       fi
     fi
   fi
   if [ -z "$parser" ]; then
     echo "appl-phrase: no install; run appl install" >&2
     exit 1
   fi
   APPL_FROM="claude:<your model>" python3 "$parser" -- "$(cat <<'APPL_SENTENCE'
   <the person's sentence, verbatim, on one line>
   APPL_SENTENCE
   )"
   ```

   The parser owns the phrase table (which words mean now or later, a priority, an order, a note, a ruling, a solo item), picks the filing script, and refuses a sentence it cannot file safely. Do not decide any of that yourself, and do not call a filing script directly.
3. Relay what it printed, in one line, and stop:
   - exit 0: the line names what was filed (an intake, or an idea in the backlog inbox), the repository and the path. The coordinator picks it up; the result does not come back to this chat.
   - a question (the line ends in `?`): the sentence was ambiguous and NOTHING was filed. Ask the person that question. Their answer is a new sentence; hand it over the same way. When the question was whether to file now or queue, and they answer "the backlog", run the same command with `--backlog` before `--`, on the same sentence.
   - exit 3 with an `appl-add:` line: the intake IS filed but the coordinator was not woken. Pass that line on unchanged.
   - any other refusal (`appl-phrase:` on stderr): pass it on unchanged. Nothing was filed. Do not work around it.

When .cursor/skills/isolated-session/scripts/appl-phrase.py is absent from the repository, resolve the parser from the install and run that parser with the repository as the working directory. The order is: the version named in the repository's appl.toml, under ~/.appl/<version>/; else ~/.appl/latest/ when that path exists, falling through when it is absent; else the newest ~/.appl/<v>/ directory, the greatest X.Y.Z. Refuse only when no install exists at all, and then the refusal names `appl install` and files nothing. Do not substitute your own implementation.

If the person later asks "did APPL take it?", read the filed file's `status:` line; do not start work.

To vendor APPL into another repository, that repository is joined with `appl join <path>`. The runbook is docs/APPL_JOIN.md.

## Cutting a version

Cutting a version is the owner's step, never this skill's: a session asked to APPL something still files it and stops. The rule is here so the answer to "is a cut due?" is the same everywhere; docs/RELEASING.md is the runbook.

The release advice (`appl-release.sh --advise`) judges whether a cut is due and changes nothing. Past the two blocks below, it checks the criteria in this order: owner-chain, changelog, security-high, cadence. Cadence is last, and the first unmet criterion makes the advice not-due. Owner-chain: no owner-priority chain stands with some, but not all, of its items landed. Changelog: every landing since the newest tag has its intake id in the Unreleased section of CHANGELOG.md. Security-high: every HIGH finding is landed or bundled into the release.

The cadence is met at N=15 landings since the newest vX.Y.Z tag, or when that tag is D=3 days old. These are the cutter's own defaults. The owner's cadence is 1-2 releases a week until APPL is stable.

A cut is blocked while main is red, or while an open P0 security HIGH finding is neither landed nor bundled, whatever else the tree is.

The bump is a patch unless a landed intake carries the header `release: minor`; only that header makes the release minor.

The changelog draft is written from the landed intake titles, in landing order, one line per intake landed since the previous tag.

After the cut, the owner installs the release into `~/.appl/<v>`.

Then owner-priority `appl.toml` pin bumps are filed, one in every consumer and one in APPL itself, so each moves its pin to the new version.

An uncut main is a defect. A landing into an uncut main past 15 landings or 3 days is the `release:uncut-main` owner row on the dashboard, and it stays there until the cut.

## Owner priorities and stalls

These are the coordinator's rules, stated here so a filing session can answer the person when they ask about an owner item. Knowing them is no licence to act on them: the steps above still apply.

An item the owner marks `owner-priority: P0` keeps that priority wherever its work goes. Every split item, fix round, respawn and follow-up inherits it through its parent chain, and `appl status --owner` lists each open one with its age, blocker and ruling.

Blocked is a stall, not a place to rest. An owner-priority item that waits on a ruling for more than 30 minutes is stuck, and any other item is stuck after more than 4 hours. herd-watch.sh then prints an uppercase `STUCK: <id> <age> <blocker>` line and repeats it every 30 minutes for an owner-priority item (hourly for others) until the status changes. A STUCK line is an action, never a log line: the hook answers or escalates it within one pass (a newer ruling, a typed fix, or one line in owner-stops.md and an owner mail), and an operator monitor must never filter STUCK.

A park or a freeze names the intake ids it holds. Nothing is parked or frozen by omission, and an owner-priority item is held only when its own id is named.

Whether a landing is on main is judged the way land.sh judges it. The check is `git cherry main <recorded tip> <recorded base>`, run with the tip and base the landing recorded: it must list at least one commit and no `+` line. An empty range is not landed, whatever the branch holds. `git range-diff` is a reading aid, never a verdict. It is never judged by `git branch --contains`. It is not judged by the branch sha alone.

The hook's not-landed verdict is final. A not-landed stall is answered with a respawn or with a question to the owner, never with a manual `landed`. An operator LANDED ruling names the main commit that carries the work and states that cherry result.

An intake being worked names its worker in its status: `tests <w>` while the test author holds it and `impl <w>` while the implementer does.

A security review of a landing that has findings files them before its receipt.

A worker name that has been closed is never reused: the next pane for the same item gets a new name.
