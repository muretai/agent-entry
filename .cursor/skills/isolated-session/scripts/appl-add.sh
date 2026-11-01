#!/usr/bin/env bash
# appl-add: file an APPL intake and hand it to the coordinator pane.
#
# The real script is tools/appl-add.sh. The skill's scripts/appl-add.sh is a byte-identical
# copy, so vendor.sh carries it to every consumer (appl-phrase.py, the invocable APPL
# skill's parser, runs that copy); `vendor.sh check` in the home refuses a drifted copy.
#
#   tools/appl-add.sh "<task>" [--from <harness:session>] [--repo <path>] [--branch <b>]
#                     [--mail-id <digits>] [--mail-at <time>] [--mail-did <did>] [--mail-as <identity>]
#                     [--status new|question] [--solo] [--lane fast] [--mac A|B] [--parent <intake id>]
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
# --mail-as is the coordinator identity whose inbox the message arrived in, written as
# `mail-as: <identity>`; appl-answer.sh replies `--as` that identity. It must be one agent
# name (`[a-z][a-z0-9-]{0,31}`), else exit 2.
# --status is the header status the intake is filed with: `new` (the default, work) or
# `question` (appl-hook.sh files mail from a DID outside mail.allow that way). Any other
# word is exit 2.
#
# --solo marks the item as a solo (records/config only, no test-author/implementer pair):
# the header gets the line `solo: yes`. Without it there is no `solo:` line at all.
# appl-backlog-pull.sh passes it for a `[solo]` line of docs/BACKLOG.md.
#
# --lane fast marks the item as a fast-lane intake. It reads <repo>/tools/units.json
# of --repo, not the cwd. The header gets `lane: fast` and `solo: yes` (no separate
# --solo). When that file is absent, or no unit's lane is the string fast, exit 2
# with one reason line and nothing written. Any other value, an empty value, or a
# missing value is exit 2 with nothing written. Without --lane there is no `lane:` line.
#
# --mac A|B names the Mac the item is meant to run on: the header gets the line
# `mac: <A|B>`. Without it there is no `mac:` line at all. Any other value (lowercase,
# empty, another word, a line break) is exit 2 with nothing written. appl-backlog-pull.sh
# passes `--mac B` for a `## Next` line whose last tag is `[macB]`; appl-hook.sh mails a
# `mac: B` intake to Mac B's coordinator instead of briefing it on Mac A.
#
# --parent <intake id> links a fix round, a respawn or a follow-up to the intake it comes
# from: the header gets `parent: <id>`, and also `owner-priority: P0` when that intake is
# owner P0 (intake_id.owner_p0: its header's marker, or its own `parent:` chain's), so the
# owner's priority is inherited without anyone re-stating it. A value that is not an
# intake id (`YYYYMMDDTHHMMSSZ`, optionally `-N`) is exit 2 with nothing written.
#
# Writes $HERD_DIR/coordinator/intake/<YYYYMMDDTHHMMSSZ>-<slug>.md (HERD_DIR defaults to
# ~/.cache/muretai-herd; intake/ is created when absent) and its trusted record
# $HERD_DIR/coordinator/filed/<same name> (write_record, below), prints that absolute path as
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
#   * an intake is never overwritten -- the file is created by os.open with
#     O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600 whatever the umask, so a name already there (a
#     regular file, a FIFO, a symlink, a dangling one) is never opened, written through or
#     blocked on; a name already taken in the same second gets a -2, -3, ... suffix.
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
  echo "usage: appl-add.sh [--] \"<task in one or more sentences>\" [--from <harness:session>] [--repo <path>] [--branch <branch>] [--mail-id <digits>] [--mail-at <time>] [--mail-did <did>] [--mail-as <identity>] [--status new|question] [--solo] [--lane fast] [--mac A|B] [--parent <intake id>]" >&2
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
mail_as=""
status="new"
solo=0
lane=""
mac=""
parent=""
owner=0
ID_RE='^[0-9]{8}T[0-9]{6}Z(-[1-9][0-9]*)?$'
AGENT_RE='^[a-z][a-z0-9-]{0,31}$'
while [ $# -gt 0 ]; do
  case "$1" in
    --solo)
      solo=1
      shift
      ;;
    --from|--repo|--branch|--mail-id|--mail-at|--mail-did|--mail-as|--status|--mac|--parent|--lane)
      [ $# -ge 2 ] || usage
      case "$1" in
        --parent)
          # an intake id and nothing else: <stamp>, or <stamp>-N
          if ! [[ "$2" =~ $ID_RE ]]; then
            echo "appl-add: --parent takes an intake id: YYYYMMDDTHHMMSSZ, optionally -N" >&2
            usage
          fi
          parent=$2
          ;;
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
        --mail-as)
          # the identity a reply is sent as: one agent name, nothing a header reader could split
          if ! [[ "$2" =~ $AGENT_RE ]]; then
            echo "appl-add: --mail-as takes one agent name ([a-z][a-z0-9-]{0,31})" >&2
            usage
          fi
          mail_as=$2
          ;;
        --status)
          case "$2" in
            new|question) status=$2 ;;
            *) echo "appl-add: --status takes new or question" >&2; usage ;;
          esac
          ;;
        --mac)
          case "$2" in
            A|B) mac=$2 ;;
            *) echo "appl-add: --mac takes A or B" >&2; usage ;;
          esac
          ;;
        --lane)
          case "$2" in
            fast) lane=fast ;;
            *) echo "appl-add: --lane takes fast" >&2; exit 2 ;;
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

# --lane fast is only honest when --repo's unit map has a unit whose lane is fast.
# Checked before any intake directory is created, so a refusal writes nothing.
if [ -n "$lane" ]; then
  if ! python3 -I -c '
import json, sys
path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, ValueError):
    sys.exit(1)
units = data.get("units") if isinstance(data, dict) else None
if not isinstance(units, dict):
    sys.exit(1)
for spec in units.values():
    if isinstance(spec, dict) and spec.get("lane") == "fast":
        sys.exit(0)
sys.exit(1)
' "$repo/tools/units.json"; then
    echo "appl-add: --lane fast needs a unit with lane fast in tools/units.json; nothing filed" >&2
    exit 2
  fi
fi

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

# --parent: the new intake inherits the owner marker when the parent's chain carries it
# (intake_id.owner_p0, the skill's scripts/intake_id.py and nothing else: beside this script
# only when it runs from the skill's scripts/, else $here/../<skill>/scripts. A sibling
# intake_id.py anywhere else -- a tools/intake_id.py a branch could add -- is never loaded)
if [ -n "$parent" ]; then
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || here=""
  ids=""
  case "$here" in
    "") c="" ;;
    */.cursor/skills/isolated-session/scripts) c="$here/intake_id.py" ;;
    *) c="$here/../.cursor/skills/isolated-session/scripts/intake_id.py" ;;
  esac
  if [ -n "$c" ] && [ -f "$c" ] && [ ! -L "$c" ]; then
    ids=$c
  fi
  [ -n "$ids" ] || { echo "appl-add: --parent: cannot find scripts/intake_id.py; nothing filed" >&2; exit 1; }
  owner=$(python3 -I -c '
import importlib.util, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("intake_id", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(1 if mod.owner_p0(sys.argv[2], sys.argv[3]) else 0)
' "$ids" "$dir" "$parent") || { echo "appl-add: --parent: could not read the chain of $parent; nothing filed" >&2; exit 1; }
fi

ts=$(date -u +%Y%m%dT%H%M%SZ)
slug=$(printf '%s' "$task" | LC_ALL=C tr -c 'A-Za-z0-9' '-' | tr -s '-' | cut -c1-40 | sed 's/^-//;s/-$//')
[ -n "$slug" ] || slug=task

# The id the next file of second $ts gets: <stamp> when none of that second is there,
# else <stamp>-N, N one past both the count of those files and the highest id they carry.
# Each entry is opened O_NONBLOCK|O_NOFOLLOW and judged by fstat on that fd, never by a
# path check an entry could be swapped under: a symlink (dangling or not) fails the open,
# a FIFO opens without blocking and is not a regular file, and neither is counted or read.
next_id() {
  python3 -I -c '
import os, re, stat, sys
d, ts = sys.argv[1], sys.argv[2]
count, top = 0, 0
for n in os.listdir(d):
    p = os.path.join(d, n)
    if not (n == ts + ".md" or (n.startswith(ts + "-") and n.endswith(".md"))):
        continue
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    except OSError:
        continue
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            continue
        count += 1
        with os.fdopen(fd, encoding="utf-8", errors="replace") as f:
            fd = -1
            head = f.read(65536).split("\n\n", 1)[0]
    except OSError:
        continue
    finally:
        if fd >= 0:
            os.close(fd)
    # A suffix past nine digits is no id this script wrote: the entry counts, its id does not,
    # so a planted `id: <stamp>-1<thousands of digits>` cannot raise past the int digit limit.
    try:
        for ln in head.split("\n"):
            if ln.startswith("id:"):
                m = re.fullmatch(re.escape(ts) + r"(?:-([1-9][0-9]{0,8}))?", ln[3:].strip())
                if m:
                    top = max(top, int(m.group(1) or 1))
                break
    except ValueError:
        pass
n = max(count, top) + 1
print(ts if n == 1 else "%s-%d" % (ts, n))
' "$dir" "$ts"
}

intake_text() {  # the intake's bytes on stdout; `at:` is fixed-width, so a re-render is as long
  printf '# APPL intake\n'
  printf 'id: %s\n' "$ident"
  printf 'at: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'from: %s\n' "$(oneline "$from")"
  printf 'repo: %s\n' "$(oneline "$repo")"
  printf 'branch: %s\n' "$(oneline "$branch")"
  printf 'status: %s\n' "$status"
  [ -z "$lane" ] || printf 'lane: fast\n'
  if [ "$solo" = "1" ] || [ -n "$lane" ]; then printf 'solo: yes\n'; fi
  [ -z "$mac" ] || printf 'mac: %s\n' "$mac"
  [ -z "$parent" ] || printf 'parent: %s\n' "$parent"
  [ "$owner" != "1" ] || printf 'owner-priority: P0\n'
  [ -z "$mail_id" ] || printf 'mail-id: %s\n' "$mail_id"
  [ -z "$mail_did" ] || printf 'mail-did: %s\n' "$mail_did"
  [ -z "$mail_as" ] || printf 'mail-as: %s\n' "$mail_as"
  [ -z "$mail_at" ] || printf 'mail-at: %s\n' "$(oneline "$mail_at")"
  printf '\n## Task\n'
  printf '%s\n' "$task"
}

# Created by os.open, never by a shell redirection: O_EXCL refuses any entry already at the
# name without opening it (a planted FIFO is never blocked on or fed, a symlink never written
# through), and the mode is 0600 from os.open, not the umask.
write_intake() {  # $1 path; fails when anything already exists there
  intake_text | python3 -I -c '
import os, sys
data = sys.stdin.buffer.read()
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, "wb") as f:
    f.write(data)
' "$1" 2>/dev/null
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

# The trusted record: $herd/coordinator/filed/<intake name>, one line `<name> sha256:<hex>`,
# the hex of the task as appl-hook.sh's task_of() would read it back from the file just written.
# appl-hook.sh mails an intake to Mac B only when this record exists and still matches
# (ISSUE(security-audit-2026-10-09-daily-appl-2)): filed/ is outside intake/, so a walled
# worker that writes an intake by hand -- or runs this script inside its wall -- has none.
# Only the task is digested, never the status, so a retry after `blocked route-*` matches.
# The digest comes from the text this script holds, re-rendered onto stdin and decoded as
# task_of()'s open() decodes it; the intake path is never opened, because intake/ is
# writable by a walled worker that could swap it in the meantime
# (ISSUE(security-audit-2026-10-09-only-trusted-filers-b9f6)).
# A record that cannot be written is one stderr line; the intake stays filed (Mac A only).
write_record() {  # $1 the intake's path, for its name only
  intake_text | python3 -I -c '
import hashlib, io, os, sys, tempfile
path, rec_dir = sys.argv[1], sys.argv[2]
text = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace").read(1 << 20)
body = text.split("\n\n", 1)[1] if "\n\n" in text else ""
if body.startswith("## Task\n"):
    body = body[len("## Task\n"):]
task = body.rstrip("\n")
base = os.path.basename(path)
line = base + " sha256:" + hashlib.sha256(task.encode("utf-8", "surrogateescape")).hexdigest() + "\n"
if os.path.islink(rec_dir):
    sys.exit(1)
os.makedirs(rec_dir, mode=0o700, exist_ok=True)
fd, tmp = tempfile.mkstemp(prefix=".filed-", dir=rec_dir)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(line)
    os.replace(tmp, os.path.join(rec_dir, base))
except BaseException:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
' "$1" "$herd/coordinator/filed" 2>/dev/null
}
write_record "$f" || echo "appl-add: filed, but no trusted record under $herd/coordinator/filed; it will not be routed to Mac B" >&2

# The run ledger: one `intake-filed` line in $herd/coordinator/runs.jsonl through
# run_ledger.py beside this script (tools/run_ledger.py, or the skill's byte-identical
# copy in scripts/, so the skill's appl-add never reaches outside the skill; a symlinked
# module is never loaded). The task is never passed: it counts as a prompt. A ledger that
# cannot be written never blocks filing -- the intake stands, stdout stays the one path
# line, and the failure is one stderr line. It runs LAST, after the path is printed and
# the coordinator woken (or the wake refused), so a held ledger lock -- anyone who can read
# runs.jsonl can take one -- can never delay either; run_ledger.py gives up after ~2 s.
record_filed() {  # $1 the intake's path
  local here ledger=""
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || here=""
  [ -n "$here" ] && ledger="$here/run_ledger.py"
  if [ -z "$ledger" ] || [ ! -f "$ledger" ] || [ -L "$ledger" ]; then
    return 1
  fi
  python3 -I "$ledger" "$herd" intake-filed "$ident" "$from" "intake=$(basename "$1")" >/dev/null 2>&1
}

printf '%s\n' "$f"

# Everything below is the WAKE. The intake is already filed; from here on a failure is
# "filed but not woken", which is exit 3 plus one stderr line -- never exit 0, because a
# filer that cannot tell the two apart reports a hand-off that did not happen. The ledger
# line is still recorded, after the refusal is said.
not_woken() {  # $1 the one stderr line, without the `appl-add: ` prefix
  echo "appl-add: $1" >&2
  record_filed "$f" || echo "appl-add: filed, but no intake-filed line in $herd/coordinator/runs.jsonl" >&2
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

# The skill's scripts/ directory, found the way --parent finds intake_id.py: this script's
# own directory when it runs from there, else $here/../<skill>/scripts.
skill_scripts() {
  local here
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || return 1
  case "$here" in
    */.cursor/skills/isolated-session/scripts) printf '%s\n' "$here" ;;
    *) printf '%s\n' "$here/../.cursor/skills/isolated-session/scripts" ;;
  esac
}

# The coordinator harness's wake facts, from the adapter the machine.toml [wake] knob
# selects (wake-adapter.sh select, then show, in the skill's scripts/): wake_row, the
# declared input_row mark, and wake_key, the declared resubmit key ("" when it is not one
# herdr key name). A refused knob or declaration is "not woken" with the adapter's own
# refusal line, which names the harness; nothing is typed. A copy with no wake-adapter.sh
# in the skill's scripts/ has no adapter to read: it prompts as it did before any adapter,
# with no resubmit. A wake-adapter.sh that is a symlink is refused.
wake_facts() {
  local dir adapter out field
  wake_row=""
  wake_key=""
  dir=$(skill_scripts) || dir=""
  adapter="$dir/wake-adapter.sh"
  if [ -n "$dir" ] && [ -L "$adapter" ]; then
    not_woken "the skill's scripts/wake-adapter.sh is a symlink; $COORD_PANE ($COORD_AGENT) was not woken"
  fi
  if [ -z "$dir" ] || [ ! -f "$adapter" ]; then
    return 0
  fi
  out=$(bash "$adapter" select 2>&1) \
    || not_woken "$(printf '%s\n' "$out" | sed -n 1p); $COORD_PANE ($COORD_AGENT) was not woken"
  out=$(bash "$adapter" show "$out" 2>&1) \
    || not_woken "$(printf '%s\n' "$out" | sed -n 1p); $COORD_PANE ($COORD_AGENT) was not woken"
  while IFS= read -r field; do
    case "$field" in
      input_row=*) wake_row=${field#input_row=} ;;
      resubmit=*) wake_key=${field#resubmit=} ;;
    esac
  done <<< "$out"
  case "$wake_key" in
    ""|*[!A-Za-z0-9_+-]*) wake_key="" ;;
  esac
}

# Exit 0 when the LIVE input row of pane $1 -- the last row opening with the declared
# input_row mark, inside an optional box side bar, as herd-spawn.sh's bar_holds_line reads
# it -- holds exactly the line $2: typed, but not submitted. An unreadable pane is no.
row_holds() {  # $1 the pane, $2 the line
  local screen
  [ -n "$wake_row" ] || return 1
  screen=$("$herdr_bin" agent read "$1" --source recent-unwrapped --lines 80 2>/dev/null \
           || "$herdr_bin" agent read "$1" 2>/dev/null) || return 1
  [ -n "$screen" ] || return 1
  printf '%s' "$screen" | python3 -I -c '
import re, sys
line, mark = sys.argv[1], sys.argv[2]
bar = chr(0x2502)
text = sys.stdin.buffer.read().decode("utf-8", "replace")
text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?", "", text)
text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b.", "", text)
last = None
for row in text.splitlines():
    m = re.fullmatch(r"\s*" + bar + r"?\s*" + re.escape(mark) + r"(?: (.*?))?\s*" + bar + r"?\s*", row)
    if m:
        last = (m.group(1) or "").strip()
sys.exit(0 if last is not None and last == line else 1)
' "$2" "$wake_row" 2>/dev/null
}

# The coordinator's input box, cleared before the wake is typed (owner ruling
# 20261029T130410Z): a prompt its hook blocked stays in the box, and a wake typed after it
# would be glued to it and blocked too. The guard is herd-watch.sh's own, run alone as
# `herd-watch.sh input-clear <herdr> <pane> <line>` from the skill's scripts/: text left in
# the box is deleted with backspaces and only the events recognised in it are typed again.
# A copy with no herd-watch.sh there prompts as before; a symlinked one is never run.
clear_box() {  # $1 the pane, $2 the line about to be typed; uses wake_coordinator's herdr_bin
  local dir watcher
  dir=$(skill_scripts) || return 0
  watcher="$dir/herd-watch.sh"
  if [ ! -f "$watcher" ] || [ -L "$watcher" ]; then
    return 0
  fi
  bash "$watcher" input-clear "$herdr_bin" "$1" "$2" >/dev/null 2>&1 || true
}

# Types `intake <path>` into the coordinator pane -- the one prompt shape appl-hook.sh
# accepts -- or exits 3 saying why it could not. When the pane's live input row still
# holds that line after the prompt, the declared resubmit key is pressed ONCE, the rule
# wake-deliver.sh keeps; the line is never typed again. APPL_ADD_HERDR is the herdr
# executable (the seam the tests drive a stub through); `herdr` on PATH when unset.
wake_coordinator() {  # $1 the intake's absolute path
  local path=$1 herdr_bin listing target wake_row wake_key
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
  wake_facts
  clear_box "$target" "intake $path"
  "$herdr_bin" agent prompt "$target" "intake $path" >/dev/null 2>&1 \
    || not_woken "$COORD_PANE ($COORD_AGENT, pane $target) did not accept the wake; it was not woken"
  if [ -n "$wake_key" ] && row_holds "$target" "intake $path"; then
    "$herdr_bin" agent send-keys "$target" "$wake_key" >/dev/null 2>&1 || true
  fi
}

export GIT_TERMINAL_PROMPT=0
wake_coordinator "$f"
record_filed "$f" || echo "appl-add: filed, but no intake-filed line in $herd/coordinator/runs.jsonl" >&2
exit 0
