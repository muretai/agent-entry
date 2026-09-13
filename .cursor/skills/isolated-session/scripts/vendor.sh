#!/usr/bin/env bash
# Carry this skill into another repository, pinned -- or prove a copy is still its pin.
#
#   vendor.sh pull    copy SKILL.md, scripts/ and test_isolated_session.py from the
#                     home (${MURETAI_CORE:-$HOME/muretai-trunk}) into THIS repository
#                     and write VENDOR.json with the home commit and every digest
#   vendor.sh check   hold the copies to VENDOR.json's digests; needs no home checkout
#
# The home is the one repository without a VENDOR.json. It never pulls into itself.
# Nothing here writes into the home, and nothing in the home writes here.
set -euo pipefail
# `pull` overwrites this very file while bash is still reading it (bash reads a script
# as it goes), which ended the first pull into muretai-site with a syntax error after
# the copy loop (2026-09-12). So the script runs from a temporary copy of itself and
# remembers where it came from.
if [[ -z "${VENDOR_SH_HERE:-}" ]]; then
  VENDOR_SH_HERE="$(cd "$(dirname "$0")" && pwd)"
  _vendor_copy="$(mktemp "${TMPDIR:-/tmp}/vendor-sh.XXXXXX")"
  cp "$0" "$_vendor_copy"
  VENDOR_SH_HERE="$VENDOR_SH_HERE" exec bash "$_vendor_copy" "$@"
fi
trap 'rm -f "$0"' EXIT
here="$VENDOR_SH_HERE"
skill_dir="$(cd "$here/.." && pwd)"
repo="$(cd "$skill_dir/../../.." && pwd)"
home_repo="${MURETAI_CORE:-$HOME/muretai-trunk}"
mode="${1:-}"
[[ "$mode" == "pull" || "$mode" == "check" ]] || { echo "usage: vendor.sh pull|check" >&2; exit 2; }

VENDOR_MODE="$mode" VENDOR_REPO="$repo" VENDOR_HOME="$home_repo" python3 - <<'PY'
import hashlib, json, os, pathlib, subprocess, sys, datetime

mode = os.environ["VENDOR_MODE"]
repo = pathlib.Path(os.environ["VENDOR_REPO"]).resolve()
home = pathlib.Path(os.path.expanduser(os.environ["VENDOR_HOME"]))
skill = ".cursor/skills/isolated-session"
FILES = [
    f"{skill}/SKILL.md",
    f"{skill}/scripts/lib.sh",
    f"{skill}/scripts/ensure-worktree.sh",
    f"{skill}/scripts/assert-head.sh",
    f"{skill}/scripts/claim-worktree.sh",
    f"{skill}/scripts/finish-worktree.sh",
    f"{skill}/scripts/stale.sh",
    f"{skill}/scripts/session-guard.sh",
    f"{skill}/scripts/vendor.sh",
    f"{skill}/scripts/herd-spawn.sh",
    f"{skill}/briefs/worker.md",
    "test_isolated_session.py",
]
pin = repo / skill / "VENDOR.json"

def sha(p: pathlib.Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

def primary_of(p: pathlib.Path) -> pathlib.Path:
    """The primary checkout behind a path -- a worktree of the home is still the home."""
    try:
        common = subprocess.run(["git", "-C", str(p), "rev-parse", "--git-common-dir"],
                                capture_output=True, text=True, check=True).stdout.strip()
    except (subprocess.CalledProcessError, OSError):
        return p.resolve()
    common_path = pathlib.Path(common) if pathlib.Path(common).is_absolute() else p / common
    return common_path.resolve().parent

is_home = home.exists() and primary_of(home) == primary_of(repo)
if mode == "check":
    if not pin.exists():
        if is_home:
            print(f"vendor: {repo} is the home of the skill; nothing to check")
            sys.exit(0)
        print(f"vendor: {pin} is missing -- this copy is unpinned; run vendor.sh pull", file=sys.stderr)
        sys.exit(1)
    data = json.loads(pin.read_text())
    bad = []
    for rel, meta in data["files"].items():
        p = repo / rel
        if not p.exists():
            bad.append(f"{rel}: missing")
        elif sha(p) != meta["sha256"]:
            bad.append(f"{rel}: digest differs from the pin")
    if bad:
        print("vendor: the copy has drifted from VENDOR.json:", file=sys.stderr)
        for b in bad:
            print("   " + b, file=sys.stderr)
        print("Edit the skill in its home and pull again; never patch the copy.", file=sys.stderr)
        sys.exit(1)
    print(f"vendor: {len(data['files'])} files match the pin ({data['from']} @ {data['commit'][:12]}, {data['date']})")
    sys.exit(0)

# pull
if is_home:
    print("vendor: refusing to pull into the home of the skill", file=sys.stderr)
    sys.exit(1)
if not (home / skill / "SKILL.md").exists():
    print(f"vendor: no skill at {home / skill} -- set MURETAI_CORE to the home checkout", file=sys.stderr)
    sys.exit(1)
def git(*a):
    return subprocess.run(["git", "-C", str(home)] + list(a), capture_output=True, text=True, check=True).stdout.strip()
commit = git("rev-parse", "HEAD")
dirty = git("status", "--porcelain", "--", skill, "test_isolated_session.py")
if dirty:
    print("vendor: refusing to pull uncommitted skill files from the home:", file=sys.stderr)
    print(dirty, file=sys.stderr)
    sys.exit(1)
files = {}
for rel in FILES:
    src, dst = home / rel, repo / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(src.read_bytes())
    dst.chmod(src.stat().st_mode & 0o777)
    files[rel] = {"sha256": sha(dst)}
pin.write_text(json.dumps({
    "_": "Written by .cursor/skills/isolated-session/scripts/vendor.sh pull; never edit the copies by "
         "hand. `vendor.sh check` holds them to these digests with no home checkout present. The "
         "skill's home is the core trunk; edit it there and pull again.",
    "from": "muretai-trunk",
    "repository": "private",
    "commit": commit,
    "date": datetime.date.today().isoformat(),
    "files": files,
}, indent=2) + "\n")
print(f"vendor: pulled {len(files)} files from {home} @ {commit[:12]}")
PY
