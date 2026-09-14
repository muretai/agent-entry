#!/usr/bin/env bash
# Take an accepted Dispatch ticket on this desk and spawn a worker.
#
#   dispatch-take.sh --as <agent> --context <contextId> [--capacity-file <path>]
#                    [--primary <repo checkout>] [--room <did>]
#
# Reads the accepted coord thread from the node (operator_cli JSON), checks the
# thread is accepted by this DID, checks the local stance is open, checks the
# Room /mem carries no taken-by line for that contextId, writes the /remember
# line, and spawns a worker through herd-spawn.sh (worker profile) in the
# resolved repo. Ticket fields reach the brief as fenced DATA through --var;
# they are never a shell argument to anything else. This script never calls
# `herdr agent prompt`.
#
# Exit 0 spawned; 2 not accepted / not mine / missing key / unknown repo;
# 3 herdr down (prints the by-hand command); 4 stance full or already taken
# (prints who).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

usage() {
  echo "usage: dispatch-take.sh --as <agent> --context <contextId> [--capacity-file PATH] [--primary DIR] [--room DID]" >&2
  exit 2
}

as_name=""
context=""
capacity_file=""
primary=""
room=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --as) [[ $# -ge 2 ]] || usage; as_name="$2"; shift 2 ;;
    --context) [[ $# -ge 2 ]] || usage; context="$2"; shift 2 ;;
    --capacity-file) [[ $# -ge 2 ]] || usage; capacity_file="$2"; shift 2 ;;
    --primary) [[ $# -ge 2 ]] || usage; primary="$2"; shift 2 ;;
    --room) [[ $# -ge 2 ]] || usage; room="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "dispatch-take: unknown argument: $1" >&2; usage ;;
  esac
done
[[ -n "$as_name" && -n "$context" ]] || usage

skill_repo="$(iso_primary_of "$here")" || {
  echo "dispatch-take: this script is not inside a git checkout" >&2
  exit 2
}

export DISPATCH_AS="$as_name"
export DISPATCH_CONTEXT="$context"
export DISPATCH_CAPACITY_FILE="$capacity_file"
export DISPATCH_PRIMARY="${primary}"
export DISPATCH_ROOM="$room"
export DISPATCH_HERE="$here"
export DISPATCH_SKILL_REPO="$skill_repo"

python3 - <<'PY'
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

as_name = os.environ["DISPATCH_AS"]
context = os.environ["DISPATCH_CONTEXT"]
capacity_file = os.environ.get("DISPATCH_CAPACITY_FILE") or ""
primary_arg = os.environ.get("DISPATCH_PRIMARY") or ""
room_arg = os.environ.get("DISPATCH_ROOM") or ""
here = Path(os.environ["DISPATCH_HERE"])
skill_repo = Path(os.environ["DISPATCH_SKILL_REPO"])
cli = Path(os.environ.get("DISPATCH_CLI") or (skill_repo / "operator_cli.py"))
spawn_sh = here / "herd-spawn.sh"
brief_tpl = here.parent / "briefs" / "dispatch-ticket.md"
py = sys.executable


def die(code: int, msg: str) -> None:
    sys.stderr.write("dispatch-take: " + msg.rstrip() + "\n")
    sys.exit(code)


def iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# -- --as on a missing key refuses (never mint) --------------------------------
sys.path.insert(0, str(skill_repo))
from agent import paths as _paths  # noqa: E402

keys = _paths.keys_root(None)
key_path = keys / (as_name + ".key")
signer_path = keys / (as_name + ".signer.json")
if not key_path.exists() and not signer_path.exists():
    die(2, "no identity %r at %s. --as on a missing key refuses; create it first."
        % (as_name, key_path))


# -- capacity: open or full, never a remaining-% --------------------------------
if capacity_file:
    cap_path = Path(capacity_file)
    dispatch_dir = cap_path.parent
else:
    dispatch_dir = Path(os.environ.get("DISPATCH_DIR")
                        or (Path.home() / ".muretai" / "dispatch"))
    cap_path = dispatch_dir / "capacity"

stance, cap_reason = "open", ""
if cap_path.is_file() and not cap_path.is_symlink():
    fields = {}
    for line in cap_path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, _, v = line.partition("=")
            fields[k.strip()] = v
    stance = (fields.get("stance") or "open").strip().lower()
    cap_reason = (fields.get("reason") or "").strip()
if stance == "full":
    who = cap_reason or "stance=full"
    sys.stdout.write("full %s\n" % who)
    die(4, "stance is full (%s)" % who)


# -- operator_cli JSON (stdout is one object; banner is on stderr) ---------------
def op(*args: str, timeout: float = 30.0) -> subprocess.CompletedProcess:
    return subprocess.run(
        [py, str(cli), "--as", as_name, *args],
        capture_output=True, text=True, timeout=timeout)


def op_json(*args: str, timeout: float = 30.0) -> dict:
    r = op(*args, timeout=timeout)
    if r.returncode != 0:
        die(2, "operator_cli %s failed (%s): %s"
            % (" ".join(args[:3]), r.returncode, (r.stderr or r.stdout).strip()[-400:]))
    lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
    if not lines:
        die(2, "operator_cli %s printed no JSON" % " ".join(args[:3]))
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError:
        die(2, "operator_cli %s was not JSON: %s" % (" ".join(args[:3]), r.stdout[-200:]))


inbox = op_json("inbox", "--json")
me = inbox.get("did") or ""
if not me:
    die(2, "inbox --json did not name this DID")

rows = inbox.get("messages") or []


def latest_id() -> int:
    return int(op_json("inbox", "--json").get("latest_id") or 0)


def wait_in(after: int, timeout: float = 12.0) -> list:
    r = op("wait", "--after", str(after), "--timeout", str(timeout), "--json",
           timeout=timeout + 5)
    if r.returncode != 0:
        return []
    lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
    if not lines:
        return []
    try:
        d = json.loads(lines[-1])
    except json.JSONDecodeError:
        return []
    return list(d.get("messages") or [])


# Room: --room, else a group overlay on any inbox row, else dispatch/room.
# Consulted BEFORE "is this mine" so a third desk that can see /mem exits 4
# (already taken) instead of 2 (not mine). The 1:1 ticket is not on Carol's
# inbox; the board record is.
def room_did() -> str:
    if room_arg:
        return room_arg
    for m in rows:
        g = m.get("group") or {}
        if isinstance(g, dict):
            rid = g.get("room_id") or g.get("host")
            if isinstance(rid, str) and rid.startswith("did:"):
                return rid
    room_file = dispatch_dir / "room"
    if room_file.is_file() and not room_file.is_symlink():
        for line in room_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("did="):
                return line.split("=", 1)[1].strip()
    return ""


def mem_text(room_id: str) -> str:
    after = latest_id()
    r = op("dm", room_id, "/mem")
    if r.returncode != 0:
        die(2, "could not send /mem to the Room: %s" % (r.stderr or r.stdout)[-300:])
    deadline = time.time() + 12
    chunks: list[str] = []
    while time.time() < deadline:
        msgs = wait_in(after, timeout=min(4.0, max(1.0, deadline - time.time())))
        for m in msgs:
            if m.get("peer_did") == room_id and m.get("direction") == "in":
                t = m.get("text") or ""
                if "MEMORY" in t or "taken-by=" in t or "(no entries" in t:
                    chunks.append(t)
        if chunks:
            return "\n".join(chunks)
        after = latest_id()
    die(2, "no /mem reply from the Room within 12s")


def taken_who(doc: str) -> str:
    for line in doc.splitlines():
        if context in line and "taken-by=" in line:
            m = re.search(r"taken-by=(\S+)", line)
            return m.group(1) if m else line.strip()
    return ""


room = room_did()
if room:
    taken = taken_who(mem_text(room))
    if taken:
        sys.stdout.write("taken-by=%s\n" % taken)
        die(4, "already taken by %s" % taken)


thread = [m for m in rows if m.get("context_id") == context]
if not thread:
    die(2, "no coord thread %s in this agent's inbox (not mine)" % context)

propose = None
accept_out = False
for m in thread:
    coord = m.get("coord") or {}
    if not isinstance(coord, dict):
        continue
    if coord.get("type") == "propose" and propose is None:
        propose = m
    if coord.get("type") == "accept" and m.get("direction") == "out":
        accept_out = True

if propose is None:
    die(2, "thread %s has no propose (not a Dispatch ticket)" % context)
peer = propose.get("peer_did") or ""
if propose.get("direction") != "in":
    die(2, "thread %s was not proposed TO this DID (not mine)" % context)
if not accept_out:
    die(2, "thread %s is not accepted by this DID" % context)

st = op_json("coord-state", peer, "--thread", context, "--json")
status = (st.get("status") or "").lower()
if status not in ("agreed", "confirmed", "delivered", "completed"):
    die(2, "thread %s status is %r, not accepted" % (context, st.get("status")))


# -- ticket fields ride in the existing coord payload text ----------------------
def parse_ticket(text: str) -> dict:
    out = {"title": "", "task": "", "repo": "", "branchHint": ""}
    raw = (text or "").strip()
    if not raw:
        return out
    if raw.startswith("{"):
        try:
            d = json.loads(raw)
        except json.JSONDecodeError:
            d = None
        if isinstance(d, dict):
            for k in out:
                v = d.get(k)
                if isinstance(v, str):
                    out[k] = v
            return out
    for line in raw.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
        elif "=" in line:
            k, _, v = line.partition("=")
        else:
            continue
        k = k.strip()
        if k in out:
            out[k] = v.strip()
    return out


ticket = parse_ticket(propose.get("text") or "")
repo_name = ticket.get("repo") or ""


def looks_like_path(name: str) -> bool:
    if not name:
        return False
    if "/" in name or name.startswith(".") or name.startswith("~"):
        return True
    if re.fullmatch(r"[0-9a-fA-F]{40}", name):
        return True
    return False


if looks_like_path(repo_name):
    die(2, "repo is a name the receiver resolves locally, never a path or a git sha: %r"
        % repo_name)

repos_path = dispatch_dir / "repos"
resolved = ""
if repos_path.is_file() and not repos_path.is_symlink() and repo_name:
    for line in repos_path.read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        n, _, pth = line.partition("=")
        if n.strip() == repo_name:
            resolved = os.path.expanduser(pth.strip())
            break
if not resolved and primary_arg:
    resolved = os.path.abspath(os.path.expanduser(primary_arg))
if not resolved:
    die(2, "unknown repo %r: add %s=<path> to %s (or pass --primary)"
        % (repo_name or "(empty)", repo_name or "NAME", repos_path))
if not os.path.isdir(resolved):
    die(2, "resolved repo path is not a directory: %s" % resolved)

if not room:
    die(2, "no Room to consult: pass --room <did> or set did= in %s/room"
        % dispatch_dir)


# -- herdr preflight (exit 3, print the by-hand command, do not take) ------------
worker = "dt-" + re.sub(r"[^a-z0-9]", "", context.lower())[:20]
if not re.match(r"^[a-z]", worker):
    worker = "d" + worker[1:]
brief_rel = ".cursor/skills/isolated-session/briefs/dispatch-ticket.md"
vars_kv = [
    ("TITLE", ticket.get("title") or context),
    ("TASK", ticket.get("task") or ""),
    ("REPO", repo_name),
    ("BRANCH_HINT", ticket.get("branchHint") or ""),
    ("CONTEXT", context),
    ("AS", as_name),
    ("DID", me),
    ("ROOM", room),
    ("PEER", peer),
]


def spawn_argv() -> list[str]:
    cmd = ["bash", str(spawn_sh), worker, str(brief_tpl),
           "--cwd", resolved, "--profile", "worker"]
    for k, v in vars_kv:
        cmd.extend(["--var", "%s=%s" % (k, v)])
    return cmd


def by_hand() -> str:
    cmd = ["bash", ".cursor/skills/isolated-session/scripts/herd-spawn.sh",
           worker, brief_rel, "--cwd", resolved, "--profile", "worker"]
    for k, v in vars_kv:
        cmd.extend(["--var", "%s=%s" % (k, v)])
    return " ".join(shlex_quote(p) for p in cmd)


def shlex_quote(s: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_./:=+-]+", s):
        return s
    return "'" + s.replace("'", "'\"'\"'") + "'"


def herdr_ok() -> bool:
    named = os.environ.get("HERD_SPAWN_BIN") or ""
    if named:
        return os.path.isfile(named) and os.access(named, os.X_OK) and \
            subprocess.run([named, "status"], capture_output=True).returncode == 0
    herdr = shutil.which("herdr")
    if not herdr:
        return False
    return subprocess.run([herdr, "status"], capture_output=True).returncode == 0


hand = by_hand()
if not herdr_ok():
    sys.stdout.write("needed -- run: %s\n" % hand)
    die(3, "herdr is not running; needed -- run: %s" % hand)


# -- /remember once, then spawn -------------------------------------------------
# title is the contextId so a third desk's /mem can match it; type stays `note`
# (room mem has no `task` type). Body is the taken-by line the board reads.
remember = "/remember note [task] %s | taken-by=%s lane=working at=%s" % (
    context, me, iso_now())
after = latest_id()
r = op("dm", room, remember)
if r.returncode != 0:
    die(2, "could not /remember the take: %s" % (r.stderr or r.stdout)[-300:])
# wait for the room to accept the write so a second take sees it
deadline = time.time() + 12
acked = False
while time.time() < deadline:
    msgs = wait_in(after, timeout=min(4.0, max(1.0, deadline - time.time())))
    for m in msgs:
        t = m.get("text") or ""
        if m.get("peer_did") == room and "remembered" in t.lower():
            acked = True
            break
    if acked:
        break
    after = latest_id()
if not acked:
    die(2, "Room did not ack /remember within 12s")

spawn = subprocess.run(spawn_argv(), capture_output=True, text=True)
sys.stdout.write(spawn.stdout)
sys.stderr.write(spawn.stderr)
if spawn.returncode == 3:
    sys.stdout.write("needed -- run: %s\n" % hand)
    die(3, "herdr is not running; needed -- run: %s" % hand)
if spawn.returncode != 0:
    die(2, "herd-spawn failed (%s): %s" % (spawn.returncode, (spawn.stderr or "").strip()[-300:]))
sys.exit(0)
PY
