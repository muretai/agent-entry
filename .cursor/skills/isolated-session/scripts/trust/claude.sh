#!/usr/bin/env bash
# The Claude Code dialog adapter: the one place Claude Code's first-run dialogs are known.
# It RECOGNIZES them for herd-spawn.sh and herd-watch.sh, and ANSWERS one of them in ONE
# pane, once, through herdr. herd-spawn.sh reaches the answer through its one trust seam,
# chosen by the harness, and only after the seam found the spawn's repository listed in the
# operator's dispatch repos; this file decides nothing about WHETHER to answer, only HOW for
# this runtime.
#
#   claude.sh --recognize                          (pane text on stdin)
#   claude.sh <herdr-binary> <agent-name> <pane-id>
#
# --recognize prints ONE runtime-neutral kind word and exits 0 when the last screenful is a
# dialog this adapter knows -- `trust` (folder trust), `teach` (auto mode's "teach it about
# your environment"), `logged-out` (a revoked OAuth token: the pane's last reply line begins
# `Please run /login`, `API Error: 401` or `OAuth access token has been revoked`; see
# LOGOUT_STARTS below) -- and exits 1 with nothing on stdout for any other screen. It never
# runs herdr and never types. The callers carry no dialog text of their own: the kind word
# is all they learn.
#
# Why keys and not a record: Claude Code documents no way to persist project trust for an
# interactive session ("There is no setting to persist it", code.claude.com/docs/en/security,
# "Trust verification"); trust is skipped only in -p mode, which a herd worker never runs
# in. So this adapter reads and writes no configuration file of any kind. It reads the pane,
# confirms the screen is a dialog it knows with its FIRST choice selected, and sends:
#   trust  one Enter (choice 1, "Yes, I trust this folder");
#   teach  Down, Down, Enter (choice 3, "Don't show again" -- the operator's own answer).
# Any other screen -- the renderer choice, the auto-mode setup, "Not logged in", a dialog
# whose selection is not on choice 1 -- is exit 1 with nothing typed, and the spawn stops and
# names it as before.
#
# Exit 0: the dialog was answered. Exit 1: nothing was typed (or, for teach, a send-keys
# failed part-way).
set -euo pipefail

# kind_of MODE: the kind word of the screen on stdin, or exit 1. MODE `answer` also requires
# the selection mark on choice 1 (Enter and the downs are counted from there).
kind_of() {
  python3 -I -c '
import re, sys
mode = sys.argv[1]
text = sys.stdin.buffer.read().decode("utf-8", "replace")
# drop OSC strings (a title) whole, then CSI/other escapes, then the remaining controls
text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?", "", text)
text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text)
text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", " ", text)
text = text.replace(chr(0x2019), chr(39))
# only the last screenful counts, so a dialog already answered and scrolled up is not it
lines = text.splitlines()[-40:]
tail = "\n".join(lines).lower()
mark = "(?:" + chr(0x276F) + "|>)"
answer = mode == "answer"


def trust():
    # "Quick safety check: ... trust?" with "1. Yes, I trust this folder" / "2. No, exit" (an
    # older build: "Do you trust the files in this folder?" / "1. Yes, proceed")
    question = ("quick safety check" in tail and "trust" in tail) or "do you trust the files in this folder" in tail
    yes = [ln for ln in lines if re.match(r"^\s*" + mark + ("" if answer else "?") + r"\s*1\.\s*yes\b", ln, re.I)]
    no = [ln for ln in lines if re.match(r"^\s*" + mark + r"?\s*2\.\s*no\b", ln, re.I)]
    others = re.search(r"\brenderer\b|\bauto[- ]mode\b|not logged in|please run /login", tail)
    return bool(question and yes and no and not others)


TEACH_TITLE = "Teach auto mode about your environment?"
TEACH_CHOICES = ("Yes", "Not now", "Don" + chr(39) + "t show again")


def teach():
    # the EXACT title line, then exactly three numbered choices, in order, after it
    titles = [i for i, ln in enumerate(lines) if ln.strip() == TEACH_TITLE]
    if not titles:
        return False
    rows = []
    for ln in lines[titles[-1] + 1:]:
        m = re.match(r"^\s*(" + mark + r")?\s*([0-9]+)\.\s*(.*?)\s*$", ln)
        if m:
            rows.append((bool(m.group(1)), int(m.group(2)), m.group(3)))
    if [(n, c) for _, n, c in rows] != list(enumerate(TEACH_CHOICES, 1)):
        return False
    return not answer or [s for s, _, _ in rows] == [True, False, False]


# The lines Claude Code prints when its login is gone and no dialog is up: a revoked OAuth
# token (the 2026-09-29 incident: `Please run /login`, then `API Error: 401 OAuth access token
# has been revoked.`). herd-watch.sh learns only the kind word `logged-out`. The rule is the one
# herd-watch.sh applies to its older phrases: the LAST REPLY LINE of the pane -- the last 20
# lines, everything from the last input line (`>`, bare or inside the box bars) down dropped, blank and box-border lines
# skipped, leading whitespace and the reply marks stripped -- BEGINS with one of these. A
# mention mid-line (quoted, in a reply, in tool output) never counts. `API Error: 401` is the
# whole status: 429 or 500 at line start is not a logout.
LOGOUT_STARTS = ("Please run /login", "OAuth access token has been revoked")
LOGOUT_401 = re.compile(r"API Error: 401(?![0-9])")
MARKS = " \t" + chr(0x23BF) + chr(0x23FA)
BOX = set(chr(c) for c in (0x2500, 0x2502, 0x256D, 0x256E, 0x256F, 0x2570)) | {" "}
INPUT_RE = re.compile(chr(0x2502) + r"?\s*>\s*" + chr(0x2502) + "?")


def last_reply():
    tail = text.splitlines()[-20:]
    for i in range(len(tail) - 1, -1, -1):
        if INPUT_RE.fullmatch(tail[i].strip()):
            tail = tail[:i]
            break
    for ln in reversed(tail):
        s = ln.lstrip(MARKS)
        if s.strip() and not set(s) <= BOX:
            return s
    return None


def logged_out():
    if answer:
        return False                     # nothing is ever answered on a logged-out screen
    r = last_reply()
    return r is not None and (r.startswith(LOGOUT_STARTS) or bool(LOGOUT_401.match(r)))


for kind, known in (("teach", teach), ("trust", trust), ("logged-out", logged_out)):
    if known():
        print(kind)
        sys.exit(0)
sys.exit(1)
' "$1"
}

if [[ "${1:-}" == "--recognize" ]]; then
  [[ $# -eq 1 ]] || exit 1
  kind_of recognize
  exit $?
fi

herdr="${1:-}"
agent="${2:-}"
pane="${3:-}"
[[ -n "$herdr" && -n "$agent" && -n "$pane" ]] || exit 1

screen="$("$herdr" agent read "$agent" --source recent-unwrapped --lines 80 2>/dev/null \
          || "$herdr" agent read "$agent" 2>/dev/null || true)"
[[ -n "$screen" ]] || exit 1

kind="$(printf '%s' "$screen" | kind_of answer)" || exit 1
case "$kind" in
  trust) "$herdr" agent send-keys "$agent" enter >/dev/null 2>&1 || exit 1 ;;
  teach)
    # the keys the operator pressed, herdr key names, one per call; a failed call stops the
    # rest (the spawn then stops at the prompt and names it, and the operator reads the pane)
    for key in down down enter; do
      "$herdr" agent send-keys "$agent" "$key" >/dev/null 2>&1 || exit 1
    done
    ;;
  *) exit 1 ;;
esac
exit 0
