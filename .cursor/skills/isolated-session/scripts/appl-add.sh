#!/usr/bin/env bash
# appl-add: file an APPL intake and hand it to the coordinator pane.
#
# The real script is tools/appl-add.sh. The skill's scripts/appl-add.sh is a byte-identical
# copy, so vendor.sh carries it to every consumer (appl-phrase.py, the invocable APPL
# skill's parser, runs that copy); `vendor.sh check` in the home refuses a drifted copy.
#
#   tools/appl-add.sh "<task>" [--from <harness:session>] [--repo <path>] [--branch <b>]
#                     [--mail-id <digits>] [--mail-at <time>] [--mail-did <did>]
#                     [--status new|question] [--solo]
#   tools/appl-add.sh -- "<task>" [options...]
#
# The task is the FIRST argument. When it may itself begin with `-` (a peer's mail body
# is data, and `--dry-run, please` is a fine sentence), put `--` first: the argument after
# it is the task, whatever it looks like. A bare first argument starting with `--` is
# still usage, so a mistyped `appl-add.sh --from x` never files the flag as a task.
#
# --mail-id / --mail-at are for an intake filed from inbound mail (appl-hook.sh, on the
# coordinator's mail wake): the message's inbox id (decimal digits only, else exit 2) and
# its time, written as the header lines `mail-id:` and `mail-at:`. appl-answer.sh reads
# them back to reply, and records `status: answered #<id>`.
#
# --mail-did is the SIGNER's DID of that message (the inbox row's peer_did), written as
# `mail-did: <did>`; it is the only identity appl-answer.sh replies to -- `from:` is a
# display name a sender can forge (security review 2026-09-28, findings 1 and 3). It must
# be DID-shaped (`did:<method>:<id>`, no space and no shell character), else exit 2.
# --status is the header status the intake is filed with: `new` (the default, work) or
# `question` (appl-hook.sh files mail from a DID outside mail.allow that way). Any other
# word is exit 2.
#
# --solo marks the item as a solo (records/config only, no test-author/implementer pair):
# the header gets the line `solo: yes`. Without it there is no `solo:` line at all.
# appl-backlog-pull.sh passes it for a `[solo]` line of docs/BACKLOG.md.
#
# Writes $HERD_DIR/coordinator/intake/<YYYYMMDDTHHMMSSZ>-<slug>.md (HERD_DIR defaults to
# ~/.cache/muretai-herd; intake/ is created when absent), prints that absolute path as
# its only stdout line, and prompts the coordinator pane with exactly `intake <path>`
# (wake_coordinator). The pane is the one whose tokens.muretai_agent is dispatch-mac-a in
# `herdr agent list`, else the one NAMED muretai-coordinator. Exit 0 means filed AND
# woken. When the wake cannot be delivered -- no such pane (or herdr is not installed),
# the listing fails, the prompt is refused, or the path holds a character that is not
# safe to type -- the intake is still written and its path still printed, but the exit
# is 3 with ONE stderr line saying why (for no pane: the command that starts it). The
# file is the durable record and the coordinator reads every `status: new` intake when it
# starts; the non-zero exit is so "filed but not woken" never looks like "filed and
# woken" (ISSUE(appl-add-wakes-a-pane-name-that-no-longer-exists)). Exit 2 is usage,
# exit 1 is "nothing filed".
#
# Defaults: --from is $APPL_FROM, else `unknown`; --repo is $PWD; --branch is the repo's
# current branch when it is a git checkout, else `-`. Any other flag (a `--priority`
# included) is exit 2 with nothing written: an option this script silently skipped
# would look honoured to the caller.
#
# What it never does, and why (the no-stops plan, P3):
#   * it reads no binding token and runs no operator CLI -- the session filing an intake
#     is not the DID principal, so it sends no DM and records nothing in a Room; the
#     coordinator pane, started once by the owner, is the only one that speaks as the
#     node;
#   * it writes nothing under --repo -- the caller's checkout is someone else's session;
#   * the task is DATA: it reaches the file through printf '%s' only, never through eval
#     or an unquoted expansion, and never travels on a herdr argv (the prompt carries
#     the path alone, so a long task cannot be cut short by a pty either);
#   * an intake is never overwritten -- the file is created with noclobber (O_EXCL), and
#     a name already taken in the same second gets a -2, -3, ... suffix.
#
# The intake's ID is the header line `id: <id>`, written once, second in the header:
# `<stamp>` for the first file of its second, `<stamp>-N` for the N-th, whatever its slug
# (so the file name's own -2 suffix and the id's need not agree). Every file of that stamp
# already there counts -- a legacy one with no `id:` line too -- and N is one past both
# their count and the highest id among them. Nothing the caller passes reaches that line:
# the id is computed here, and --from / the task are values of other lines or body text.
# Readers resolve an id by the one rule in .cursor/skills/isolated-session/scripts/intake_id.py.
set -u

COORD_PANE="muretai-coordinator"
# the agent identity herd-spawn marks the coordinator pane with (tokens.muretai_agent)
COORD_AGENT="dispatch-mac-a"
# The documented start line (docs/APPL_COORDINATOR.md, briefs/coordinator.md). The `~`
# is literal: it is what the owner types.
START_LINE='bash .cursor/skills/isolated-session/scripts/herd-spawn.sh muretai-coordinator .cursor/skills/isolated-session/briefs/coordinator.md --profile coordinator --muretai-agent dispatch-mac-a --cwd ~/muretai-trunk'

usage() {
  echo "usage: appl-add.sh [--] \"<task in one or more sentences>\" [--from <harness:session>] [--repo <path>] [--branch <branch>] [--mail-id <digits>] [--mail-at <time>] [--mail-did <did>] [--status new|question] [--solo]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
if [ "$1" = "--" ]; then
  # the next argument is the task, even when it begins with a dash
  [ $# -ge 2 ] || usage
  task=$2
  shift 2
  [ -n "$task" ] || usage
else
  task=$1
  shift
  case "$task" in
    ''|--*) usage ;;
  esac
fi

from="${APPL_FROM:-unknown}"
repo="$PWD"
branch=""
have_branch=0
mail_id=""
mail_at=""
mail_did=""
status="new"
solo=0
while [ $# -gt 0 ]; do
  case "$1" in
    --solo)
      solo=1
      shift
      ;;
    --from|--repo|--branch|--mail-id|--mail-at|--mail-did|--status)
      [ $# -ge 2 ] || usage
      case "$1" in
        --from) from=$2 ;;
        --repo) repo=$2 ;;
        --branch) branch=$2; have_branch=1 ;;
        --mail-id)
          # one decimal number and nothing else: appl-answer.sh reads it back as the id
          case "$2" in
            ''|*[!0-9]*) echo "appl-add: --mail-id takes decimal digits only" >&2; usage ;;
          esac
          mail_id=$2
          ;;
        --mail-at) mail_at=$2 ;;
        --mail-did)
          # the identity a reply goes to: one DID-shaped word, nothing a shell or a
          # header reader could split
          case "$2" in
            did:*:*) ;;
            *) echo "appl-add: --mail-did takes a DID (did:<method>:<id>)" >&2; usage ;;
          esac
          case "$2" in
            *[!A-Za-z0-9._:%-]*) echo "appl-add: --mail-did takes a DID (did:<method>:<id>)" >&2; usage ;;
          esac
          mail_did=$2
          ;;
        --status)
          case "$2" in
            new|question) status=$2 ;;
            *) echo "appl-add: --status takes new or question" >&2; usage ;;
          esac
          ;;
      esac
      shift 2
      ;;
    *)
      echo "appl-add: unknown argument: $1" >&2
      usage
      ;;
  esac
done

# One header line per field: a line break inside a value would forge the next field. Every
# character str.splitlines() breaks on (\r, \v, \f, \x1c-\x1e, U+0085, U+2028, U+2029 as
# well as \n) and every other control character becomes a space, so a splitlines() reader
# and a `\n` reader see the same header (security review 2026-09-28, finding 7).
oneline() {
  python3 -I -c '
import os, sys
v = sys.argv[1]
out = "".join(" " if ord(c) < 0x20 or ord(c) == 0x7f or len(("x" + c + "x").splitlines()) > 1
              else c for c in v)
sys.stdout.buffer.write(os.fsencode(out))
' "$1"
}

if [ "$have_branch" != "1" ]; then
  # read-only: no optional locks, no prompt, nothing written into the caller's .git
  branch=$(GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 git -C "$repo" branch --show-current 2>/dev/null) || branch=""
  [ -n "$branch" ] || branch="-"
fi

if [ -n "${HERD_DIR:-}" ]; then
  herd=$HERD_DIR
elif [ -n "${HOME:-}" ]; then
  herd="$HOME/.cache/muretai-herd"
else
  echo "appl-add: neither HERD_DIR nor HOME is set; nowhere to file the intake" >&2
  exit 1
fi
case "$herd" in
  /*) ;;
  *) herd="$PWD/$herd" ;;
esac
# no trailing slash: the typed path must be the one plain absolute path
while [ "${herd%/}" != "$herd" ] && [ "$herd" != "/" ]; do herd=${herd%/}; done
dir="$herd/coordinator/intake"
mkdir -p "$dir" || { echo "appl-add: cannot create $dir" >&2; exit 1; }

ts=$(date -u +%Y%m%dT%H%M%SZ)
slug=$(printf '%s' "$task" | LC_ALL=C tr -c 'A-Za-z0-9' '-' | tr -s '-' | cut -c1-40 | sed 's/^-//;s/-$//')
[ -n "$slug" ] || slug=task

# The id the next file of second $ts gets: <stamp> when none of that second is there,
# else <stamp>-N, N one past both the count of those files and the highest id they carry.
next_id() {
  python3 -I -c '
import os, re, sys
d, ts = sys.argv[1], sys.argv[2]
count, top = 0, 0
for n in os.listdir(d):
    p = os.path.join(d, n)
    if not (n == ts + ".md" or (n.startswith(ts + "-") and n.endswith(".md"))):
        continue
    if os.path.islink(p) or not os.path.isfile(p):
        continue
    count += 1
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            head = f.read(65536).split("\n\n", 1)[0]
    except OSError:
        continue
    for ln in head.split("\n"):
        if ln.startswith("id:"):
            m = re.fullmatch(re.escape(ts) + r"(?:-([1-9][0-9]*))?", ln[3:].strip())
            if m:
                top = max(top, int(m.group(1) or 1))
            break
n = max(count, top) + 1
print(ts if n == 1 else "%s-%d" % (ts, n))
' "$dir" "$ts"
}

write_intake() {  # $1 path; fails when it already exists
  (
    set -o noclobber
    {
      printf '# APPL intake\n'
      printf 'id: %s\n' "$ident"
      printf 'at: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf 'from: %s\n' "$(oneline "$from")"
      printf 'repo: %s\n' "$(oneline "$repo")"
      printf 'branch: %s\n' "$(oneline "$branch")"
      printf 'status: %s\n' "$status"
      [ "$solo" != "1" ] || printf 'solo: yes\n'
      [ -z "$mail_id" ] || printf 'mail-id: %s\n' "$mail_id"
      [ -z "$mail_did" ] || printf 'mail-did: %s\n' "$mail_did"
      [ -z "$mail_at" ] || printf 'mail-at: %s\n' "$(oneline "$mail_at")"
      printf '\n## Task\n'
      printf '%s\n' "$task"
    } > "$1"
  ) 2>/dev/null
}

f="$dir/${ts}-${slug}.md"
n=1
ident=$(next_id) || ident=""
case "$ident" in
  "$ts"|"$ts"-[1-9]*) ;;
  *) echo "appl-add: could not work out the intake id under $dir" >&2; exit 1 ;;
esac
until write_intake "$f"; do
  n=$((n + 1))
  if [ "$n" -gt 50 ] || [ ! -d "$dir" ]; then
    echo "appl-add: could not create an intake file under $dir" >&2
    exit 1
  fi
  f="$dir/${ts}-${slug}-${n}.md"
  # another filer may have taken this second meanwhile: count again
  ident=$(next_id) || ident=""
  case "$ident" in
    "$ts"|"$ts"-[1-9]*) ;;
    *) echo "appl-add: could not work out the intake id under $dir" >&2; exit 1 ;;
  esac
done

printf '%s\n' "$f"

# Everything below is the WAKE. The intake is already filed; from here on a failure is
# "filed but not woken", which is exit 3 plus one stderr line -- never exit 0, because a
# filer that cannot tell the two apart reports a hand-off that did not happen.
not_woken() {  # $1 the one stderr line, without the `appl-add: ` prefix
  echo "appl-add: $1" >&2
  exit 3
}

not_running() {
  not_woken "coordinator pane not running: start it with $START_LINE"
}

# The pane to prompt, from `herdr agent list` JSON on stdin: the pane whose
# tokens.muretai_agent is $COORD_AGENT first (herd-spawn --muretai-agent marks it, and
# that token survives a rename of the pane), else the pane NAMED $COORD_PANE. Prints the
# row's name (its pane_id when the name is not a plain name); prints nothing, exit 1, when
# no pane matches; exit 2 when the listing is not JSON.
resolve_pane() {
  COORD_AGENT="$COORD_AGENT" COORD_PANE="$COORD_PANE" python3 -I -c '
import json, os, re, sys
try:
    rows = json.load(sys.stdin)["result"]["agents"]
    rows = [r for r in rows if isinstance(r, dict)]
except (ValueError, KeyError, TypeError):
    sys.exit(2)
def token(r):
    t = r.get("tokens")
    return t.get("muretai_agent") if isinstance(t, dict) else None
hit = ([r for r in rows if token(r) == os.environ["COORD_AGENT"]]
       or [r for r in rows if r.get("name") == os.environ["COORD_PANE"]])
if not hit:
    sys.exit(1)
plain = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
for key in ("name", "pane_id"):
    v = hit[0].get(key)
    if isinstance(v, str) and plain.fullmatch(v):
        print(v)
        sys.exit(0)
sys.exit(1)
'
}

# Types `intake <path>` into the coordinator pane -- the one prompt shape appl-hook.sh
# accepts -- or exits 3 saying why it could not. APPL_ADD_HERDR is the herdr executable
# (the seam the tests drive a stub through); `herdr` on PATH when unset.
wake_coordinator() {  # $1 the intake's absolute path
  local path=$1 herdr_bin listing target
  # A path is typed into a live pane, so only a path with no character a shell, a pty or
  # the hook could read differently is typed at all; any other is refused, never quoted.
  case "$path" in
    /*) ;;
    *) not_woken "the intake path is not absolute; not typed to $COORD_PANE: $path" ;;
  esac
  case "$path" in
    *[!A-Za-z0-9/._-]*)
      not_woken "the intake path holds a character that is not safe to type; $COORD_PANE ($COORD_AGENT) was not woken -- tell it: intake <the path above>" ;;
  esac
  herdr_bin=${APPL_ADD_HERDR:-herdr}
  command -v "$herdr_bin" >/dev/null 2>&1 || not_running
  listing=$("$herdr_bin" agent list 2>/dev/null) \
    || not_woken "herdr agent list failed; could not look up $COORD_PANE ($COORD_AGENT), so it was not woken"
  target=$(printf '%s' "$listing" | resolve_pane)
  case $? in
    0) ;;
    1) not_running ;;
    *) not_woken "herdr agent list did not answer JSON; could not look up $COORD_PANE ($COORD_AGENT), so it was not woken" ;;
  esac
  "$herdr_bin" agent prompt "$target" "intake $path" >/dev/null 2>&1 \
    || not_woken "$COORD_PANE ($COORD_AGENT, pane $target) did not accept the wake; it was not woken"
}

export GIT_TERMINAL_PROMPT=0
wake_coordinator "$f"
exit 0
