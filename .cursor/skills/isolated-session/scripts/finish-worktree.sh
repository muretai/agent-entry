#!/usr/bin/env bash
# Land this session's branch on BASE and remove the worktree (its lock goes with it).
# Must be run only when the user's task is actually done. Never pushes BASE.
#
# The landing is the one serial section of parallel work, so it is short and it is
# ordered: take the landing lock (one landing at a time per primary) -> bring the
# branch onto the current BASE (rebase; merge when the branch is already on origin) ->
# refuse a branch that edited a generated file -> run the tests the diff owes
# (tools/run_tests.py --affected) -> scan the diff (tools/sec_lint.py: a refusal stops
# the landing like a red test; needs-eyes lands and owes a reviewer) -> regenerate the
# ledgers on the tip (tools/ledger.py build) -> fast-forward BASE -> release, remove,
# delete -> when the scan said needs-eyes, spawn the reviewer session through herdr
# (scripts/herd-spawn.sh; never blocking, never failing the landing).
# A repository without those tools (a pinned copy of this skill) lands as before and
# says TESTS=none / SEC=none / LEDGER=none / REVIEW=none in the receipt.
#
# The guards are BASE's, never the branch's. The tests run from the branch by design;
# the gate does not: the lint, the reviewer's brief and the spawner are read out of
# BASE's blobs (`git show BASE:path`), so a branch that rewrites any of them is judged
# by the copies main already had. And a diff that touches a gate file at all (the lint,
# the ledger, the runner, these scripts, the briefs, the hook configs) is needs-eyes
# whatever the lint said -- this script decides that itself, from the paths, because
# the lint is one of the files on that list.
set -euo pipefail

# Scratch files: an unpredictable name under TMPDIR, never /tmp/<name>-$$ (a planted
# symlink there would be followed as the operator).
finish_tmp() {
  mktemp "${TMPDIR:-/tmp}/finish-XXXXXX"
}

# The branch's code runs three times before the merge -- the ledger check, the tests,
# the ledger build (which imports the selector, the spec builder and the projector from
# the branch) -- and none of it may reach a push credential: git's helpers cleared, no
# terminal prompt, ssh disabled, gh pointed at an empty config (the keychain token is
# reached through hosts.yml, which is not there). A test that pushes to a local bare
# remote needs none of these (ISSUE(security-audit-2026-09-12-a-pre-push-hook-makes-the),
# ISSUE(security-audit-2026-09-12-the-wall-is-honest-about-3)).
gh_empty="$(mktemp -d "${TMPDIR:-/tmp}/finish-gh-XXXXXX")"
credless() {
  env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \
      GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false GIT_SSH_COMMAND=/usr/bin/false \
      GH_CONFIG_DIR="$gh_empty" GH_TOKEN= GITHUB_TOKEN= GH_ENTERPRISE_TOKEN= "$@"
}

# The files whose change is judged by eyes whatever the lint said: they decide what a
# landing runs, what it scans, who reviews it, and what a session may edit.
# The comparison folds case: the dev host's filesystem is case-insensitive (APFS,
# core.ignorecase=true), so `git mv tools/spec_build.py tools/Spec_build.py` is a path
# git lists as new and the OS opens as the old one -- `ledger.py build` would run the
# renamed file under its canonical name while a case-exact list called it not a gate
# (ISSUE(security-audit-2026-09-12-the-scanner-ignores-diff-2)). `tr`, not `${1,,}`:
# bash 3.2.
# The gate list -- the paths whose change is needs-eyes whatever the lint said -- is
# BASE's lint's own table (`tools/sec_lint.py --gate-files`), not a table of this
# script's: two tables kept in step by hand missed the weekly clock and the skill's
# SKILL.md (ISSUE(gate-lists-are-two-lists), ISSUE(security-audit-2026-09-12-a-type-change-is-con-02ca)).

branch="${1:-}"
worktree="${2:-}"
if [[ -z "$branch" || -z "$worktree" ]]; then
  echo "usage: finish-worktree.sh <branch> <worktree-path>" >&2
  exit 2
fi
if [[ ! -d "$worktree" ]]; then
  echo "worktree not found: ${worktree}" >&2
  exit 1
fi
worktree="$(cd "$worktree" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

case "$branch" in
  main|master|develop)
    echo "refusing to finish a base branch (${branch})" >&2
    exit 1
    ;;
  cursor/*)
    echo "Cloud Agent: do not merge into main. Open a ready-for-review PR." >&2
    exit 3
    ;;
esac

"$here/assert-head.sh" "$branch" "$worktree"

if [[ -n "$(git -C "$worktree" status --porcelain)" ]]; then
  echo "uncommitted changes in worktree; commit or discard before finish" >&2
  git -C "$worktree" status -sb >&2
  exit 1
fi

git_common="$(git -C "$worktree" rev-parse --git-common-dir)"
if [[ "$git_common" != /* ]]; then
  git_common="$(cd "${worktree}/${git_common}" && pwd)"
else
  git_common="$(cd "$git_common" && pwd)"
fi
primary="$(dirname "$git_common")"

if git -C "$worktree" symbolic-ref --quiet refs/remotes/origin/HEAD >/dev/null 2>&1; then
  base="$(git -C "$worktree" symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')"
else
  base="main"
fi
if ! git -C "$worktree" show-ref --verify --quiet "refs/heads/${base}"; then
  if git -C "$worktree" show-ref --verify --quiet "refs/heads/master"; then
    base="master"
  fi
fi

# A repository with .cursor/design-paths keeps two kinds of session apart: a design
# session (design/*) lands only files design owns, a dev session (feat/*) lands none
# of them. The check is here, at landing, because that is where the split is either
# real or decorative. ISOLATED_SESSION_CROSS=1 lands a crossing change on purpose.
kind="$(iso_kind_of_branch "$branch")"
if [[ -f "$(iso_design_paths_file "$primary")" ]]; then
  merge_base="$(git -C "$worktree" merge-base "$base" "$branch")"
  crossing=""
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if iso_is_design_path "$primary" "$f"; then
      [[ "$kind" == "dev" ]] && crossing="${crossing}   ${f}"$'\n'
    else
      [[ "$kind" == "design" ]] && crossing="${crossing}   ${f}"$'\n'
    fi
  done < <(git -C "$worktree" diff --name-only "$merge_base" "$branch")
  if [[ -n "$crossing" ]]; then
    if [[ "${ISOLATED_SESSION_CROSS:-0}" == "1" ]]; then
      {
        echo "NOTE: ISOLATED_SESSION_CROSS=1 -- this ${kind} session lands files outside its paths:"
        printf '%s' "$crossing"
      } >&2
    else
      {
        if [[ "$kind" == "design" ]]; then
          echo "refusing to land ${branch}: a design session changed files design does not own:"
        else
          echo "refusing to land ${branch}: a dev session changed files that belong to design:"
        fi
        printf '%s' "$crossing"
        echo "The split is $(iso_design_paths_file "$primary"). Move those changes to a session of"
        echo "the other kind, or land with ISOLATED_SESSION_CROSS=1 when the change has to cross"
        echo "(and say why in the commit)."
      } >&2
      exit 1
    fi
  fi
fi

worktree_for_branch() {
  local want="refs/heads/$1"
  local wt=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) wt="${line#worktree }" ;;
      branch\ *)
        if [[ "${line#branch }" == "$want" ]]; then
          printf '%s\n' "$wt"
          return 0
        fi
        ;;
    esac
  done < <(git -C "$worktree" worktree list --porcelain)
  return 1
}

if git -C "$worktree" remote get-url origin >/dev/null 2>&1; then
  git -C "$worktree" fetch origin --quiet || true
fi

# --- the landing lock: one landing at a time per primary ----------------------
owner="$(iso_owner)"
land_wait="${ISOLATED_SESSION_LAND_WAIT:-2700}"
waited=0
holding_land="no"
while :; do
  case "$(iso_land_lock_state "$primary" "$owner")" in
    free)
      if iso_land_lock_take "$primary" "$owner" "$branch"; then holding_land="yes"; break; fi
      ;;
    mine)
      holding_land="yes"; break
      ;;
    dead)
      echo "note: a landing lock left by a session that is gone ($(iso_land_lock_describe "$primary")); taking it over" >&2
      iso_land_lock_release "$primary"
      ;;
    other)
      if (( waited >= land_wait )); then
        {
          echo "refusing to land ${branch}: another landing holds ${primary}"
          echo "  $(iso_land_lock_describe "$primary")"
          echo "Waited ${waited}s (ISOLATED_SESSION_LAND_WAIT). Run finish again when it is done."
        } >&2
        exit 1
      fi
      if (( waited % 30 == 0 )); then
        echo "waiting for the landing lock: $(iso_land_lock_describe "$primary")" >&2
      fi
      sleep 5
      waited=$(( waited + 5 ))
      ;;
  esac
done

tmp_merge=""
cleanup() {
  if [[ -n "$tmp_merge" ]]; then
    git -C "$primary" worktree remove --force "$tmp_merge" >/dev/null 2>&1 || true
    tmp_merge=""
  fi
  if [[ "$holding_land" == "yes" ]]; then
    iso_land_lock_release "$primary"
    holding_land="no"
  fi
}
trap cleanup EXIT

# --- bring the branch onto the current base -----------------------------------
# A local session branch is rebased, so the tree the tests see is byte-identical to
# the fast-forwarded BASE and BASE stays linear. A branch that is already on origin
# (a second laptop's) is merged, never rewritten. A conflict confined to the generated
# files is resolved by taking BASE's copy -- the ledger is rebuilt below anyway; any
# other conflict stops the landing with the steps to resolve it.
generated="PLAN.md docs/IMPLEMENTATION_BACKLOG.md docs/SPECIFICATION.md"
rebased="no-op"
if ! git -C "$worktree" merge-base --is-ancestor "$base" "$branch"; then
  on_origin=0
  if git -C "$worktree" remote get-url origin >/dev/null 2>&1 &&
     git -C "$worktree" ls-remote --exit-code origin "refs/heads/${branch}" >/dev/null 2>&1; then
    on_origin=1
  fi
  if [[ "$on_origin" == "1" || "${ISOLATED_SESSION_LAND_MERGE:-0}" == "1" ]]; then
    if ! git -C "$worktree" merge --no-edit "$base" >/dev/null 2>&1; then
      git -C "$worktree" merge --abort >/dev/null 2>&1 || true
      {
        echo "refusing to land ${branch}: merging ${base} into it conflicts."
        echo "In ${worktree}: git merge ${base}, resolve, commit, then run finish again."
      } >&2
      exit 1
    fi
    rebased="merge"
  else
    if ! git -C "$worktree" rebase "$base" >/dev/null 2>&1; then
      while :; do
        conflicted="$(git -C "$worktree" diff --name-only --diff-filter=U)"
        [[ -n "$conflicted" ]] || break
        only_generated=1
        for f in $conflicted; do
          case " $generated " in
            *" $f "*) ;;
            *) only_generated=0 ;;
          esac
        done
        if [[ "$only_generated" != "1" ]]; then
          git -C "$worktree" rebase --abort >/dev/null 2>&1 || true
          {
            echo "refusing to land ${branch}: rebasing onto ${base} conflicts in:"
            printf '   %s\n' $conflicted
            echo "In ${worktree}: git rebase ${base}, resolve, git rebase --continue, then run"
            echo "finish again (ISOLATED_SESSION_LAND_MERGE=1 merges instead of rebasing)."
          } >&2
          exit 1
        fi
        for f in $conflicted; do
          git -C "$worktree" checkout --ours -- "$f" 2>/dev/null || true
          git -C "$worktree" add -- "$f"
        done
        if ! GIT_EDITOR=true git -C "$worktree" rebase --continue >/dev/null 2>&1; then
          if [[ -z "$(git -C "$worktree" diff --name-only --diff-filter=U)" ]]; then
            # the session's regeneration was all that commit carried: taking BASE's
            # copy emptied it, and an empty commit has nothing to land
            GIT_EDITOR=true git -C "$worktree" rebase --skip >/dev/null 2>&1 || true
          fi
        fi
        gd="$(git -C "$worktree" rev-parse --git-dir)"
        [[ -d "$gd/rebase-merge" || -d "$gd/rebase-apply" ]] || break
      done
      if [[ -n "$(git -C "$worktree" diff --name-only --diff-filter=U)" ]] ||
         [[ -d "$(git -C "$worktree" rev-parse --git-dir)/rebase-merge" ]] ||
         [[ -d "$(git -C "$worktree" rev-parse --git-dir)/rebase-apply" ]]; then
        git -C "$worktree" rebase --abort >/dev/null 2>&1 || true
        echo "refusing to land ${branch}: the rebase onto ${base} did not complete; resolve it in ${worktree}" >&2
        exit 1
      fi
    fi
    rebased="yes"
  fi
fi
# after a rebase the branch ref moved; make sure HEAD is still the branch
"$here/assert-head.sh" "$branch" "$worktree" >/dev/null

# --- a session never lands a generated file ------------------------------------
ledger_tool="$worktree/tools/ledger.py"
if [[ -f "$ledger_tool" ]]; then
  ledger_err="$(finish_tmp)"
  if ! credless python3 "$ledger_tool" --into "$worktree" check --diff "$base" --diff-only 2>"$ledger_err"; then
    {
      echo "refusing to land ${branch}: the branch edited a generated file."
      cat "$ledger_err"
      echo "Drop those commits' changes to the generated files (the landing regenerates them):"
      echo "  git -C '${worktree}' checkout ${base} -- ${generated}   # then commit"
    } >&2
    rm -f "$ledger_err"
    exit 1
  fi
  rm -f "$ledger_err"
fi

# --- the tests the diff owes -----------------------------------------------------
runner="$worktree/tools/run_tests.py"
tests_line="none (no tools/run_tests.py in this repository)"
tests_secs=""
tests_files=""
if [[ -f "$runner" ]]; then
  if [[ "${ISOLATED_SESSION_LAND_TESTS:-1}" == "0" ]]; then
    tests_line="skipped-by-operator (ISOLATED_SESSION_LAND_TESTS=0)"
    echo "NOTE: ISOLATED_SESSION_LAND_TESTS=0 -- landing ${branch} without running its tests" >&2
  else
    report="$(finish_tmp)"
    tests_err="$(finish_tmp)"
    # the branch's tests, with no push credential in reach (credless, above)
    set +e
    ( cd "$worktree" && credless python3 tools/run_tests.py --affected "${base}..HEAD" --json -j "${ISOLATED_SESSION_LAND_JOBS:-4}" ) > "$report" 2>"$tests_err"
    rc=$?
    set -e
    summary="$(python3 - "$report" "$rc" <<'PY'
import json, sys
path, rc = sys.argv[1], int(sys.argv[2])
try:
    d = json.load(open(path))
except Exception:
    print("BROKEN\t\t\t")
    sys.exit(0)
files = d.get("files", [])
counts = {}
for r in files:
    counts[r["status"]] = counts.get(r["status"], 0) + 1
line = ", ".join(f"{counts.get(k, 0)} {k}" for k in ("ok", "skip", "fail", "timeout") if counts.get(k))
failed = " ".join(d.get("failed", []))
names = " ".join(r["file"] for r in files)
# unit separator, not a tab: bash `read` folds runs of IFS whitespace, so an empty
# `failed` column would shift the columns after it
print("\x1f".join([f"{line or '0 files'} (of {len(files)}; {d.get('selection', '')})",
                   str(d.get("wall_s", "")), failed, names]))
for r in files:
    if r["status"] in ("fail", "timeout"):
        print(f"--- {r['file']}: {r['status']} {r.get('reason', '')}", file=sys.stderr)
        for ln in r.get("tail", "").splitlines()[-15:]:
            print("   | " + ln, file=sys.stderr)
PY
)"
    IFS=$'\x1f' read -r tests_line tests_secs tests_failed tests_files <<< "$summary"
    if [[ "$tests_line" == "BROKEN" ]]; then
      { echo "refusing to land ${branch}: tools/run_tests.py gave no report:"; cat "$tests_err"; } >&2
      rm -f "$report" "$tests_err"
      exit 1
    fi
    if [[ "$rc" != "0" ]]; then
      {
        echo "refusing to land ${branch}: ${tests_line}"
        echo "red: ${tests_failed}"
        echo "The worktree is untouched (already rebased onto ${base}); fix, commit, run finish again."
      } >&2
      rm -f "$report" "$tests_err"
      exit 1
    fi
    rm -f "$report" "$tests_err"
    if [[ -n "$(git -C "$worktree" status --porcelain)" ]]; then
      {
        echo "refusing to land ${branch}: the tests left the tree dirty -- a test wrote into the checkout:"
        git -C "$worktree" status --porcelain
      } >&2
      exit 1
    fi
  fi
fi

# --- the deterministic security scan of the diff ----------------------------------
# tools/sec_lint.py reads the added lines and the touched paths and answers with one
# word. `refused` (a key, a token, a guard override) stops the landing exactly as a red
# test does; `needs-eyes` (the audited surface or a guard file changed) lands and owes
# a human review, which is spawned after the merge below; `clean` owes nothing.
#
# The lint that runs is BASE's, not the branch's: `git show BASE:tools/sec_lint.py`
# (and its audit_scope.py) into an untracked scratch directory INSIDE the worktree --
# the tool takes its repository from its own location, so from there `--diff` sees the
# branch -- and the directory is gone before anything asks `git status`. A branch that
# replaces the lint with one that answers `clean` is still scanned by the copy main
# had, and its replacement is a gate file (below), so it is needs-eyes on top. A BASE
# without the tool says SEC=none; the branch's copy is never the fallback.
sec_line="none (base has no tools/sec_lint.py)"
sec_verdict="none"
sec_files=""
sec_gate=""
gate_files=""
# a branch that removes the scan or the receipt tool would turn this gate off for every
# later landing (SEC=none): refused here, before BASE's lint even runs
# (ISSUE(security-audit-2026-09-12-the-reviewer-opens-in-a-c-2))
for keep in tools/sec_lint.py tools/audit_scope.py; do
  if git -C "$worktree" cat-file -e "${base}:${keep}" 2>/dev/null &&
     ! git -C "$worktree" cat-file -e "HEAD:${keep}" 2>/dev/null; then
    echo "error: refusing to land ${branch}: it removes ${keep}, which every later landing's security gate runs" >&2
    exit 1
  fi
done
if git -C "$worktree" cat-file -e "${base}:tools/sec_lint.py" 2>/dev/null; then
  sec_base="$(mktemp -d "${worktree}/.sec-base-XXXXXX")"
  mkdir -p "$sec_base/tools"
  git -C "$worktree" show "${base}:tools/sec_lint.py" > "$sec_base/tools/sec_lint.py"
  if git -C "$worktree" cat-file -e "${base}:tools/audit_scope.py" 2>/dev/null; then
    git -C "$worktree" show "${base}:tools/audit_scope.py" > "$sec_base/tools/audit_scope.py"
  fi
  # the gate list, from BASE's table. NUL-separated and never quoted: with git's default
  # quotepath a non-ASCII name arrives octal-quoted and matches no entry (the LONG S
  # case); deletions, renames (as D + A) and type changes included
  while IFS= read -r -d '' f; do
    [[ -n "$f" ]] || continue
    gate_files="${gate_files}${gate_files:+ }${f}"
  done < <(git -C "$worktree" -c core.quotepath=false diff --name-only -z --no-renames --diff-filter=ACMRDT "${base}..HEAD" |
           python3 "$sec_base/tools/sec_lint.py" --gate-files 2>/dev/null || true)
  sec_report="$(finish_tmp)"
  sec_err="$(finish_tmp)"
  set +e
  ( cd "$worktree" && python3 "$sec_base/tools/sec_lint.py" --diff "${base}..HEAD" --json ) > "$sec_report" 2>"$sec_err"
  sec_rc=$?
  set -e
  rm -rf "$sec_base"
  sec_summary="$(python3 - "$sec_report" "$sec_rc" <<'PY'
import json, sys
path, rc = sys.argv[1], int(sys.argv[2])
try:
    d = json.load(open(path))
    verdict = str(d["verdict"])
except Exception:
    print("BROKEN\x1f0\x1f")
    sys.exit(0)
if rc == 2 and verdict != "refused":
    verdict = "refused"          # the exit code is the contract; the word must agree
# review_files (the audited surface + guard files + files with an eyes-level line) is
# what the reviewer opens; an older lint without it names the audited surface only
files = [str(f) for f in (d.get("review_files") or d.get("audited_files", []))]
# unit separator (see the tests summary above); the findings follow, one per line
print("\x1f".join([verdict, str(len(files)), " ".join(files)]))
for f in d.get("findings", []):
    where = f.get("file", "?") if not f.get("line") else f"{f.get('file', '?')}:{f.get('line')}"
    print(f"   {where}: [{f.get('level', '?')}] {f.get('rule', '')}: {f.get('text', '')}")
PY
)"
  sec_head="${sec_summary%%$'\n'*}"
  sec_findings="${sec_summary#*$'\n'}"
  [[ "$sec_findings" == "$sec_summary" ]] && sec_findings=""
  IFS=$'\x1f' read -r sec_verdict sec_count sec_files <<< "$sec_head"
  # a gate file changed: needs-eyes whatever the lint said (a refusal stays a refusal),
  # and the reviewer opens those files too
  if [[ -n "$gate_files" ]]; then
    case "$sec_verdict" in
      clean|needs-eyes)
        sec_verdict="needs-eyes"
        for f in $gate_files; do
          case " $sec_files " in
            *" $f "*) ;;
            *) sec_files="${sec_files}${sec_files:+ }${f}" ;;
          esac
        done
        sec_count=0
        for f in $sec_files; do sec_count=$(( sec_count + 1 )); done
        sec_gate="; gate files changed"
        ;;
    esac
  fi
  case "$sec_verdict" in
    clean)
      sec_line="clean"
      ;;
    needs-eyes)
      sec_line="needs-eyes (${sec_count} file(s) to review: ${sec_files}${sec_gate})"
      if [[ -n "$sec_findings" ]]; then
        { echo "note: tools/sec_lint.py wants eyes on:"; printf '%s\n' "$sec_findings"; } >&2
      fi
      if [[ -n "$gate_files" ]]; then
        echo "note: the diff changes gate file(s), so it is needs-eyes whatever the lint said: ${gate_files}" >&2
      fi
      ;;
    refused)
      {
        echo "refusing to land ${branch}: tools/sec_lint.py refused the diff:"
        [[ -n "$sec_findings" ]] && printf '%s\n' "$sec_findings"
        echo "The worktree is untouched (already rebased onto ${base}); fix, commit, run finish again."
      } >&2
      rm -f "$sec_report" "$sec_err"
      exit 1
      ;;
    *)
      { echo "refusing to land ${branch}: tools/sec_lint.py gave no verdict:"; cat "$sec_err"; } >&2
      rm -f "$sec_report" "$sec_err"
      exit 1
      ;;
  esac
  rm -f "$sec_report" "$sec_err"
else
  # no lint, so no table -- but a diff that brings the scan tools themselves is said,
  # because those two names are the one thing this script knows about the gate
  for keep in tools/sec_lint.py tools/audit_scope.py; do
    if [[ -n "$(git -C "$worktree" diff --name-only --no-renames --diff-filter=ACMRDT "${base}..HEAD" -- "$keep")" ]]; then
      gate_files="${gate_files}${gate_files:+ }${keep}"
    fi
  done
  if [[ -n "$gate_files" ]]; then
    echo "note: ${base} has no tools/sec_lint.py, so the diff was not scanned; it changes gate file(s): ${gate_files}" >&2
  fi
fi

# --- the ledgers, regenerated on the tip ------------------------------------------
ledger_line="none (no tools/ledger.py in this repository)"
if [[ -f "$ledger_tool" ]]; then
  build_out="$(credless python3 "$ledger_tool" --into "$worktree" build 2>&1)" || {
    echo "refusing to land ${branch}: tools/ledger.py build failed:" >&2
    printf '%s\n' "$build_out" >&2
    exit 1
  }
  if [[ -n "$(git -C "$worktree" status --porcelain)" ]]; then
    git -C "$worktree" add -A -- $generated 2>/dev/null || git -C "$worktree" add -A
    git -C "$worktree" commit -q -m "ledger: regenerate on landing ${branch}"
    ledger_line="regenerated ($(git -C "$worktree" rev-parse --short HEAD))"
  else
    ledger_line="current"
  fi
fi

base_wt="$(worktree_for_branch "$base" || true)"
is_tracked_dirty() {
  local dir="$1"
  if ! git -C "$dir" diff --quiet; then
    return 0
  fi
  if ! git -C "$dir" diff --cached --quiet; then
    return 0
  fi
  return 1
}

if [[ -n "$base_wt" ]]; then
  if is_tracked_dirty "$base_wt"; then
    echo "base ${base} is checked out at ${base_wt} and has uncommitted changes; cannot merge" >&2
    git -C "$base_wt" status -sb >&2
    exit 1
  fi
  merge_cwd="$base_wt"
else
  mkdir -p "${primary}/.worktrees"
  tmp_merge="${primary}/.worktrees/.merge-${base}"
  if [[ -e "$tmp_merge" ]]; then
    echo "temp merge worktree already exists: ${tmp_merge}" >&2
    exit 1
  fi
  git -C "$primary" worktree add "$tmp_merge" "$base"
  merge_cwd="$tmp_merge"
fi

base_before="$(git -C "$merge_cwd" rev-parse "$base")"
if git -C "$merge_cwd" merge-base --is-ancestor "$branch" "$base"; then
  echo "BRANCH=${branch} already contained in ${base}"
  merge_kind="already"
else
  if git -C "$merge_cwd" -c advice.diverging=false merge --ff-only --no-verify "$branch"; then
    merge_kind="fast-forward"
  else
    if ! git -C "$merge_cwd" merge --no-edit --no-verify "$branch"; then
      git -C "$merge_cwd" merge --abort >/dev/null 2>&1 || true
      echo "merge into ${base} failed; ${branch} was not merged" >&2
      exit 1
    fi
    merge_kind="commit"
  fi
fi
base_tip="$(git -C "$merge_cwd" rev-parse "$base")"

# This script never pushes BASE. Two reasons, both load-bearing:
#   1. CLAUDE.md step 4 -- "Pushing still requires an explicit ask."
#   2. Local BASE and origin/BASE are not the same history in this repo. Local
#      main carries the full tree from the initial commit; origin/main was
#      seeded as a truncated graft at the 0.2.46/seq-51 release and the two were
#      joined once by hand. A finish that pushes BASE would, the moment those
#      two are reconciled, publish every pre-graft commit in one go.
# Landing BASE on the remote is the trunk owner's deliberate act, not a
# side effect of finishing a session.
pushed="no"

cd "$primary"
if [[ "$worktree" == "$primary" ]]; then
  git switch "$base"
else
  git worktree remove "$worktree"
fi
if git merge-base --is-ancestor "$branch" "$base"; then
  git branch -D "$branch"
else
  echo "refusing to delete ${branch}: not merged into ${base}" >&2
  exit 1
fi
if git remote get-url origin >/dev/null 2>&1; then
  if git ls-remote --exit-code origin "refs/heads/${branch}" >/dev/null 2>&1; then
    # the landing's own cleanup of a session branch that reached origin: the one push a
    # landing makes, never of BASE, and the pre-push hook must let it through
    ISOLATED_SESSION_PUSH=1 git push origin --delete "$branch" || true
  fi
fi
cleanup
trap - EXIT

echo "MERGED=yes"
echo "MERGE_KIND=${merge_kind}"
echo "REBASED=${rebased}"
echo "LANDING_LOCK=waited ${waited}s"
echo "TESTS=${tests_line}"
[[ -n "$tests_secs" ]] && echo "TESTS_SECS=${tests_secs}"
[[ -n "$tests_files" ]] && echo "TESTS_FILES=${tests_files}"
# names are tests/test_x.py: that is how the runner spells a file, and the
# receipt prints them as-is
echo "SEC=${sec_line}"
echo "LEDGER=${ledger_line}"
echo "BASE=${base}"
echo "BRANCH=${branch}"
echo "PRIMARY=${primary}"
echo "PUSHED=${pushed}"
# The hand-off: when the primary has a `handoff` remote (setup-handoff.sh), BASE goes
# there -- a bare repository on this machine, no credential -- for the publisher, another
# user with the only GitHub token, to evaluate and push (company/ops/publisher/README.md).
# Never a failed landing: the line says what happened.
handoff_line="none (no handoff remote)"
if handoff_url="$(git -C "$primary" remote get-url handoff 2>/dev/null)"; then
  handoff_err="$(finish_tmp)"
  if ISOLATED_SESSION_PUSH=1 git -C "$primary" push --quiet handoff "${base}:refs/heads/${base}" >/dev/null 2>"$handoff_err"; then
    handoff_line="pushed ${base_tip} to ${handoff_url}"
  else
    handoff_line="failed: $(tail -1 "$handoff_err" 2>/dev/null | tr -d '\r' | cut -c1-200)"
  fi
  rm -f "$handoff_err"
fi
echo "HANDOFF=${handoff_line}"
echo "WORKTREE_REMOVED=yes"
rm -rf "$gh_empty"

# --- the human half of the scan: a reviewer session -------------------------------
# The landing is done and its lock released; what follows can neither block nor fail
# it. A needs-eyes landing renders the per-landing reviewer brief and hands it to
# herd-spawn.sh; when herdr is absent or down (or the operator set
# ISOLATED_SESSION_LAND_REVIEW=0) the receipt carries the command to run by hand
# instead, because the review is owed either way.
#
# The template and the spawner come out of BASE's blobs at the sha it had BEFORE this
# landing (`git show base_before:path`), never from the primary's working tree: the
# fast-forward above moved that tree to the landed tip, so its copies are the branch's,
# and a branch that rewrote the brief or the spawner would otherwise be reviewed under
# its own brief, or not reviewed at all with a receipt that says it was.
review_line="none"
# The cadence: `<primary>/.security/review-cadence` saying `daily` defers the review
# to tools/security_daily.sh, which reads the whole day's range once (the owner's
# choice, 2026-09-13: a reviewer per landing spent most of a week's subscription in a
# day); ISOLATED_SESSION_LAND_REVIEW, when set, still decides for this landing alone.
review_cadence="$(tr -d '[:space:]' < "${primary}/.security/review-cadence" 2>/dev/null || true)"
if [[ "$sec_verdict" == "needs-eyes" && "$base_before" != "$base_tip" && -z "${ISOLATED_SESSION_LAND_REVIEW+set}" && "$review_cadence" == "daily" ]]; then
  review_line="deferred -- daily cadence (${primary}/.security/review-cadence): tools/security_daily.sh reads the day's landings as one range, and the publisher waits for its receipt"
elif [[ "$sec_verdict" == "needs-eyes" && "$base_before" != "$base_tip" ]]; then
  # herdr names an agent with [a-z][a-z0-9_-]{0,31}: "secrev-" leaves 25 for the slug
  review_slug="$(printf '%s' "${branch#*/}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | tr -s '-')"
  # 20 characters of slug plus four of the landed tip: two branches that share a prefix
  # get two names, two checkouts and two briefs
  # (ISSUE(security-audit-2026-09-12-the-reviewer-opens-in-a-c-6))
  review_slug="${review_slug:0:20}"
  review_slug="${review_slug#-}"
  review_slug="${review_slug%-}"
  review_slug="${review_slug}-$(printf '%s' "$base_tip" | cut -c1-4)"
  review_name="secrev-${review_slug}"
  # empty when neither HERD_DIR nor HOME is set: said on the REVIEW= line below, never
  # a nounset error after the merge (ISSUE(security-audit-2026-09-12-the-cleanup-trusts-n-d474-4))
  herd_dir="$(iso_herd_dir || true)"
  # absolute, so the rules herd-spawn.sh writes from it name real paths
  [[ -z "$herd_dir" || "$herd_dir" == /* ]] || herd_dir="$(pwd)/${herd_dir}"
  review_brief="${herd_dir}/briefs/${review_name}.md"
  # The reviewer opens in a detached checkout of main as it was BEFORE this landing: its
  # SessionStart hook, its scripts and its settings are the ones main had, not the
  # branch's (a diff that edits session-guard.sh would otherwise run as the reviewer
  # spawns), and no .claude/settings.local.json lives there
  # (ISSUE(security-audit-2026-09-12-the-reviewer-sandbox-an-e-2), -3).
  # ... and OUTSIDE the primary: Claude Code reads CLAUDE.md from every parent directory,
  # and the primary's is the landed tip's (-4); under HERD_DIR it collides with no session
  # worktree either (-1)
  review_root="${herd_dir}/review"
  review_co="${review_root}/${review_name}"
  template_rel=".claude/skills/security-audit/references/landing-review-brief.md"
  spawner_rel=".cursor/skills/isolated-session/scripts/herd-spawn.sh"
  lib_rel=".cursor/skills/isolated-session/scripts/lib.sh"
  run_hint="bash ${spawner_rel} ${review_name} ${review_brief} --profile reviewer --cwd ${review_co} --var MAIN=${primary}"
  by_hand="run the security-audit skill over ${base_before}..${base_tip} by hand"
  # HERD_DIR is where a prompt for an autonomous session is written: ours, mode 700
  # when this creates it, refused when someone else owns it, and refused when a
  # directory above it is writable by others (a CLAUDE.md there would reach the
  # reviewer, whose cwd is under it). Nothing in this section may end the landing:
  # the merge is done, and a REVIEW= line is owed whatever stands at these paths
  # (ISSUE(security-audit-2026-09-12-the-review-checkout-lives-3), -4).
  if [[ -n "$herd_dir" && ! -e "$herd_dir" ]]; then
    mkdir -p "$herd_dir" 2>/dev/null && chmod 700 "$herd_dir" 2>/dev/null || true
  fi
  if [[ -z "$herd_dir" ]]; then
    review_line="needed -- neither HERD_DIR nor HOME is set, so there is no herd directory; ${by_hand}"
  elif [[ -L "$herd_dir" || ! -d "$herd_dir" || ! -O "$herd_dir" ]]; then
    review_line="needed -- ${herd_dir} is not a directory owned by $(id -un) (HERD_DIR); ${by_hand}"
  elif ! open_dir="$(iso_private_path "$herd_dir")"; then
    review_line="needed -- ${open_dir}, at or above ${herd_dir}, is writable by others (a CLAUDE.md there would reach the reviewer); set HERD_DIR under your home; ${by_hand}"
  elif ! git -C "$primary" cat-file -e "${base_before}:${template_rel}" 2>/dev/null; then
    review_line="needed -- no ${template_rel} in ${base} before this landing; ${by_hand}"
  elif [[ -L "${herd_dir}/briefs" || ( -e "${herd_dir}/briefs" && ! -d "${herd_dir}/briefs" ) || ( -d "${herd_dir}/briefs" && ! -O "${herd_dir}/briefs" ) ]]; then
    review_line="needed -- ${herd_dir}/briefs is a symlink, a file, or not ours; ${by_hand}"
  elif [[ ! -d "${herd_dir}/briefs" ]] && ! mkdir -m 700 "${herd_dir}/briefs" 2>/dev/null; then
    review_line="needed -- could not create ${herd_dir}/briefs; ${by_hand}"
  elif ! review_tpl="$(finish_tmp)" || ! git -C "$primary" show "${base_before}:${template_rel}" > "$review_tpl" 2>/dev/null; then
    review_line="needed -- could not read ${template_rel} from ${base_before}; ${by_hand}"
  else
    # One pass over the placeholders with a dict, never sequential replaces (a value
    # is never re-scanned for a later key). FILES and BRANCH are data the diff chose:
    # rendered as backticked paths with any backtick, brace pair or newline removed.
    if python3 - "$review_tpl" "$review_brief" "NAME=${review_name}" "BASE=${base_before}" \
         "TIP=${base_tip}" "BRANCH=${branch}" "SLUG=${review_slug}" "FILES=${sec_files}" \
         "PRIMARY=${review_co}" "MAIN=${primary}" <<'PY'
import os, re, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
values = {}
for kv in sys.argv[3:]:
    key, _, value = kv.partition("=")
    values[key] = value


def as_data(s):
    # markdown-safe AND shell-safe: a branch name or a path reaches the brief as prose
    # only, never inside a command, but a reviewer may still paste it -- so nothing that
    # chains, substitutes, quotes or comments survives
    # (ISSUE(security-audit-2026-09-12-the-landing-judges-a-diff-4))
    s = s.replace("`", "").replace("\r", " ").replace("\n", " ")
    while "{{" in s or "}}" in s:
        s = s.replace("{{", "").replace("}}", "")
    s = "".join(ch if (ch.isalnum() or ch in "._/-+@:, ") else "-" for ch in s)
    return s


paths = [as_data(p) for p in values.get("FILES", "").split() if p]
values["FILES"] = ", ".join("`" + p + "`" for p in paths) or "(none)"
values["BRANCH"] = as_data(values.get("BRANCH", ""))


def fill(m):
    # a key the landing does not know ({{REPORT}}) is herd-spawn.sh's to fill; it stays
    return values.get(m.group(1), m.group(0))


# the exact path is unlinked (a planted symlink goes, its target stays) and the file is
# created O_EXCL, mode 600 -- the same write herd-spawn.sh does for its own copy
# (ISSUE(security-audit-2026-09-12-the-reviewer-sandbox-an-e-4))
out = re.sub(r"\{\{([A-Z][A-Z0-9_]*)\}\}", fill, text)
if os.path.lexists(dst):
    os.unlink(dst)
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(out)
PY
    then
      rm -f "$review_tpl"
      if [[ "${ISOLATED_SESSION_LAND_REVIEW:-1}" == "0" ]]; then
        review_line="needed -- ISOLATED_SESSION_LAND_REVIEW=0; run: ${run_hint}"
      elif ! git -C "$primary" cat-file -e "${base_before}:${spawner_rel}" 2>/dev/null ||
           ! git -C "$primary" cat-file -e "${base_before}:${lib_rel}" 2>/dev/null; then
        review_line="needed -- no ${spawner_rel} in ${base} before this landing; run: ${run_hint}"
      elif ! spawn_dir="$(mktemp -d "${TMPDIR:-/tmp}/finish-spawner-XXXXXX" 2>/dev/null)"; then
        review_line="needed -- could not create a scratch directory for the spawner; run: ${run_hint}"
      elif ! git -C "$primary" show "${base_before}:${spawner_rel}" > "$spawn_dir/herd-spawn.sh" 2>/dev/null ||
           ! git -C "$primary" show "${base_before}:${lib_rel}" > "$spawn_dir/lib.sh" 2>/dev/null ||
           ! chmod +x "$spawn_dir/herd-spawn.sh" 2>/dev/null; then
        rm -rf "$spawn_dir"
        review_line="needed -- could not read ${spawner_rel} from ${base_before}; run: ${run_hint}"
      else
        # The reviewer's checkout: detached at the sha main had before this landing,
        # under a review root that is a real directory of ours -- checked BEFORE the
        # cleanup walks it, so a review root swapped for a symlink to the session
        # worktrees is walked by nothing (-1). Only what THIS script created is ever
        # removed: an entry whose physical parent is the physical review root, that
        # git lists as a worktree, whose git dir carries the marker this script writes,
        # that is detached, that is a day old or bears this landing's own name, and
        # that no live session holds. A bare `false` here once ended a completed
        # landing under set -e with no REVIEW= line: every branch of this chain sets
        # review_line and falls through.
        [[ -e "$review_root" ]] || mkdir -m 700 "$review_root" 2>/dev/null || true
        review_root_ok=no
        if [[ ! -L "$review_root" && -d "$review_root" && -O "$review_root" ]] &&
           review_root_real="$(cd "$review_root" 2>/dev/null && pwd -P)"; then
          review_root_ok=yes
        fi
        if [[ "$review_root_ok" == "yes" ]]; then
          for old_co in "${review_root}"/*; do
            [[ -d "$old_co" && ! -L "$old_co" ]] || continue
            old_real="$(cd "$old_co" 2>/dev/null && pwd -P)" || continue
            [[ "$(dirname "$old_real")" == "$review_root_real" ]] || continue
            git -C "$primary" worktree list --porcelain 2>/dev/null |
              grep -qFx -e "worktree ${old_co}" -e "worktree ${old_real}" || continue
            old_gd="$(git -C "$old_co" rev-parse --absolute-git-dir 2>/dev/null)" || continue
            [[ -f "${old_gd}/muretai-review-checkout" ]] || continue
            git -C "$old_co" symbolic-ref -q HEAD >/dev/null 2>&1 && continue
            if [[ "$old_co" == "$review_co" ]] || [[ -n "$(find "$old_co" -maxdepth 0 -mtime +1 2>/dev/null)" ]]; then
              old_lock="$(iso_lock_path "$old_co" 2>/dev/null || true)"
              if [[ -n "$old_lock" && -f "$old_lock" ]] && iso_lock_alive "$old_lock"; then
                continue
              fi
              git -C "$primary" worktree remove --force "$old_co" >/dev/null 2>&1 || true
            fi
          done
          git -C "$primary" worktree prune >/dev/null 2>&1 || true
        fi
        review_err="$(finish_tmp)"
        opened=no
        if [[ "$review_root_ok" == "yes" ]] &&
           git -C "$primary" worktree add --detach "$review_co" "$base_before" >/dev/null 2>"$review_err" &&
           review_gd="$(git -C "$review_co" rev-parse --absolute-git-dir 2>/dev/null)" &&
           printf 'landing=%s\nbase=%s\ntip=%s\n' "$branch" "$base_before" "$base_tip" > "${review_gd}/muretai-review-checkout" 2>/dev/null; then
          opened=yes
        elif [[ "$review_root_ok" != "yes" ]]; then
          printf '%s is not a directory owned by %s\n' "$review_root" "$(id -un)" > "$review_err"
        fi
        if [[ "$opened" != "yes" ]]; then
          echo "note: the reviewer was not spawned: could not open ${review_co} at ${base_before}: $(tail -1 "$review_err" 2>/dev/null || true)" >&2
          review_line="needed -- run: ${run_hint}"
        elif spawn_out="$(bash "$spawn_dir/herd-spawn.sh" "$review_name" "$review_brief" --cwd "$review_co" --profile reviewer --var "MAIN=${primary}" 2>"$review_err")"; then
          review_pane="$(printf '%s\n' "$spawn_out" | sed -n 's/.*pane=\([^ ]*\).*/\1/p' | head -1)"
          review_eyes="$(printf '%s\n' "$spawn_out" | sed -n 's/.*harness=\([^ ]*\) model=\([^ ]*\).*/\1\/\2/p' | head -1)"
          review_line="spawned ${review_name} (pane ${review_pane}${review_eyes:+, ${review_eyes}})"
          # a stubbed spawner is a test's business; the receipt must say so, never "spawned"
          # as if a reviewer were reading the diff (ISSUE(security-audit-2026-09-12-the-guard-override-rule-a-4))
          if [[ -n "${HERD_SPAWN_BIN:-}" ]]; then
            review_line="${review_line} via HERD_SPAWN_BIN=${HERD_SPAWN_BIN}"
          fi
        else
          echo "note: the reviewer was not spawned: $(tail -1 "$review_err" 2>/dev/null || true)" >&2
          review_line="needed -- run: ${run_hint}"
        fi
        rm -f "$review_err"
        rm -rf "$spawn_dir"
      fi
    else
      rm -f "$review_tpl"
      review_line="needed -- could not render ${template_rel}; ${by_hand}"
    fi
  fi
fi
echo "REVIEW=${review_line}"

if git -C "$primary" remote get-url origin >/dev/null 2>&1 &&
   git -C "$primary" rev-parse --verify --quiet "origin/${base}" >/dev/null; then
  ahead="$(git -C "$primary" rev-list --count "origin/${base}..${base}" 2>/dev/null || echo 0)"
  if [[ "$ahead" != "0" ]]; then
    echo "NOTE: local ${base} is ${ahead} commit(s) ahead of origin/${base}."
    echo "NOTE: pushing ${base} is the owner's call -- this script does not do it, and the pre-push hook"
    echo "NOTE: refuses every push without it: ISOLATED_SESSION_PUSH=1 git push origin ${base}"
  fi
fi
