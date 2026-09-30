#!/usr/bin/env bash
# Carry this skill into another repository, pinned -- or prove a copy is still its pin.
#
#   vendor.sh pull --ref <tag>
#                     copy SKILL.md, scripts/ and tests/test_isolated_session.py
#                     from the home (${APPL_HOME:-$HOME/appl}) AT release tag <tag>
#                     into THIS repository and write VENDOR.json with the ref, the
#                     commit it points at and every digest. The contract test is
#                     taken from tests/test_isolated_session.py and written at the
#                     same relative path (creating tests/ in the consumer). A stale
#                     root copy in the consumer is removed. The APPL skill's two entry
#                     points, .claude/skills/appl/SKILL.md and .cursor/rules/appl.mdc,
#                     are the only other paths outside the skill it carries.
#   vendor.sh pull --ref main
#                     the same, from the home's main -- spelled out, never implied
#   vendor.sh check   hold the copies to VENDOR.json's digests; needs no home checkout.
#                     In the home (no VENDOR.json) it is the release self-test: every FILES
#                     entry stays under the skill, and FILES with its closure carries every
#                     skill path tests/test_isolated_session.py reads, each missing one named;
#                     and each COPIES entry (tools/appl-add.sh, tools/appl-backlog-add.sh)
#                     is byte-identical to its copy under the skill's scripts/.
#
# APPL is consumed by release tag, never by commit (owner ruling 2026-09-29). `pull` reads
# the home's git objects at the ref (`git ls-tree` / `git cat-file`), never the home
# checkout's working files, so a consumer gets the tagged bytes even when the home has
# moved on or is dirty. A pull without --ref exits 2 and writes nothing. The ref must be a
# tag of the home (refs/tags/<ref>) or the literal `main` (refs/heads/main); a branch, a
# commit sha, HEAD or a revision expression is refused, named, before anything is written.
#
# What is copied is the explicit FILES list below -- the reviewed contract -- and its
# CLOSURE: every sibling a copied script reaches (`$here/<name>`, a `source` of
# `$(dirname ...)/<name>`, Python's `HERE / "<name>"`), transitively. A reference that
# names a DIRECTORY reaches every file under it (herd-spawn.sh's trust adapter, a
# `<harness>.sh` under scripts/trust, reaches that directory), and those are walked in turn. `pull` refuses a
# home where a reference names nothing at the ref, or a symlink, and `check` refuses a copy
# whose closure VENDOR.json does not cover. The bugs this exists for: finish-worktree.sh
# runs landing-lease.sh / landing-lease.py and names dispatch-init.sh, none of which was
# listed, so every vendored landing failed with "can't open file .../landing-lease.py";
# and pull skipped the directory scripts/trust, so every consumer's first `check` was red.
#
# `pull` validates everything before it writes anything: a FILES entry must be a plain
# relative path under the skill (or the contract test), and a source must be a regular
# file in the tree at the ref (mode 100644/100755), never a symlink (120000) -- a symlink
# in the home would copy whatever it points at.
#
# The home is APPL: $APPL_HOME, else $HOME/appl. MURETAI_CORE (the old variable, whose
# default was $HOME/muretai-trunk) is honoured for one release when APPL_HOME is unset,
# with a deprecation note. A set APPL_HOME is final: if it is no home, `pull` refuses and
# never falls back to MURETAI_CORE or the default.
#
# The home is the one repository without a VENDOR.json. It never pulls into itself (nor
# into a linked worktree of itself). Nothing here writes into the home, and nothing in the
# home writes here.
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
usage="usage: vendor.sh pull --ref <tag>|main  or  vendor.sh check"
mode="${1:-}"
[[ "$mode" == "pull" || "$mode" == "check" ]] || { echo "$usage" >&2; exit 2; }
shift
ref=""
ref_set=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      [[ "$mode" == "pull" ]] || { echo "vendor: check takes no --ref -- $usage" >&2; exit 2; }
      [[ $# -ge 2 && -n "$2" ]] || { echo "vendor: --ref needs a value: a release tag of the home, or main" >&2; exit 2; }
      ref="$2"
      ref_set=1
      shift 2
      ;;
    *)
      echo "vendor: unexpected argument: $1 -- $usage" >&2
      exit 2
      ;;
  esac
done
if [[ "$mode" == "pull" && -z "$ref_set" ]]; then
  echo "vendor: refusing to pull without --ref: APPL is consumed by release tag -- run vendor.sh pull --ref <tag> (or --ref main to take the home's main on purpose)" >&2
  exit 2
fi
if [[ -n "${APPL_HOME+set}" ]]; then
  [[ -n "$APPL_HOME" ]] || { echo "vendor: APPL_HOME is set but empty -- point it at the APPL checkout, or unset it for \$HOME/appl" >&2; exit 2; }
  home_repo="$APPL_HOME"
  home_from="APPL_HOME"
elif [[ -n "${MURETAI_CORE:-}" ]]; then
  home_repo="$MURETAI_CORE"
  home_from="MURETAI_CORE"
  echo "vendor: note: MURETAI_CORE is deprecated and is read for one release only -- set APPL_HOME to the APPL checkout instead" >&2
else
  home_repo="$HOME/appl"
  home_from="default"
fi

VENDOR_MODE="$mode" VENDOR_REF="$ref" VENDOR_REPO="$repo" VENDOR_HOME="$home_repo" VENDOR_HOME_FROM="$home_from" python3 - <<'PY'
import hashlib, json, os, pathlib, posixpath, re, shutil, subprocess, sys, tempfile, datetime

mode = os.environ["VENDOR_MODE"]
ref = os.environ["VENDOR_REF"]
repo = pathlib.Path(os.environ["VENDOR_REPO"]).resolve()
home = pathlib.Path(os.path.expanduser(os.environ["VENDOR_HOME"]))
home_from = os.environ["VENDOR_HOME_FROM"]
# how a refusal names where the home came from, so the operator knows what to change
HOME_HOW = {
    "APPL_HOME": "APPL_HOME",
    "MURETAI_CORE": "MURETAI_CORE (deprecated; set APPL_HOME)",
    "default": "the default $HOME/appl (APPL_HOME is unset)",
}[home_from]
skill = ".cursor/skills/isolated-session"
FILES = [
    f"{skill}/SKILL.md",
    f"{skill}/scripts/lib.sh",
    f"{skill}/scripts/ensure-worktree.sh",
    f"{skill}/scripts/assert-head.sh",
    f"{skill}/scripts/claim-worktree.sh",
    f"{skill}/scripts/finish-worktree.sh",
    f"{skill}/scripts/landing-lease.sh",
    f"{skill}/scripts/landing-lease.py",
    f"{skill}/scripts/lease_core.py",
    f"{skill}/scripts/dispatch-init.sh",
    f"{skill}/scripts/stale.sh",
    f"{skill}/scripts/session-guard.sh",
    f"{skill}/scripts/vendor.sh",
    f"{skill}/scripts/herd-spawn.sh",
    # the landing the spawner copies beside the wall (herd-spawn.sh reaches it as `$here/land.sh`)
    f"{skill}/scripts/land.sh",
    # the worker wall's platform plug and its one profile template (herd-spawn.sh reaches
    # them as `$here/walls/<os>.sh`; a Linux plug joins this list when it exists)
    f"{skill}/scripts/walls/darwin.sh",
    f"{skill}/scripts/walls/darwin.sb.template",
    f"{skill}/scripts/dispatch-take.sh",
    f"{skill}/scripts/dispatch-capacity.sh",
    f"{skill}/scripts/herd-watch.sh",
    # every role brief, each on its own line: the contract test reads them, and v0.1.0
    # shipped only two, so every consumer's contract test failed at the first missing one
    f"{skill}/briefs/coordinator.md",
    f"{skill}/briefs/dispatch-ticket.md",
    f"{skill}/briefs/implementer.md",
    f"{skill}/briefs/test-author.md",
    f"{skill}/briefs/worker.md",
    # the invocable APPL skill: the one parser, its phrase table and the two filing
    # scripts it runs (the entry points below name the parser by this path); the filing
    # scripts are the COPIES below
    f"{skill}/scripts/appl-phrase.py",
    f"{skill}/scripts/appl-phrases.tsv",
    f"{skill}/scripts/appl-add.sh",
    f"{skill}/scripts/appl-backlog-add.sh",
]

# FILES entries that are byte-identical copies of a home script outside the skill: the real
# script stays at its tools/ path in the home (its callers and tests name it there), and
# the copy under the skill is what a pull carries. `check` in the home refuses a copy that
# differs from its source, or is missing, whenever the source is there.
COPIES = {
    f"{skill}/scripts/appl-add.sh": "tools/appl-add.sh",
    f"{skill}/scripts/appl-backlog-add.sh": "tools/appl-backlog-add.sh",
}

CONTRACT = "tests/test_isolated_session.py"
# The only paths outside the skill a pull may carry besides the contract test: the APPL
# skill's two entry points (Claude Code, Cursor). A literal list, compared whole -- never a
# pattern, so a sibling rule or another file of either directory is still refused. A pull
# carries each one the home has at the ref (a release from before they existed has none).
ENTRY_POINTS = (
    ".claude/skills/appl/SKILL.md",
    ".cursor/rules/appl.mdc",
)
pin = repo / skill / "VENDOR.json"

def sha(p: pathlib.Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

def fail(head, lines, tail=None):
    print("vendor: " + head, file=sys.stderr)
    for b in lines:
        print("   " + b, file=sys.stderr)
    if tail:
        print(tail, file=sys.stderr)
    sys.exit(1)

def not_plain(rel: str):
    """Why `rel` may not be vendored, or None: a plain relative path under the skill."""
    if rel.startswith("/") or os.path.isabs(rel):
        return "an absolute path"
    if any(part in ("", ".", "..") for part in rel.split("/")):
        return "not a plain relative path (`..`, `.` or an empty segment)"
    if rel != CONTRACT and rel not in ENTRY_POINTS and not rel.startswith(skill + "/"):
        return "outside " + skill
    return None

# --- the closure -----------------------------------------------------------------------
# The forms a skill script uses to reach a sibling: `$here/<name>` (also `"$here")/<name>`,
# the spelling a refusal prints through printf %q), `source`/`.` of `$(dirname ...)/<name>`,
# and Python's `HERE / "<name>"`. Each is resolved against the script's own directory; a
# reference that lands outside the skill is never a vendoring requirement (and is never
# followed), and one naming a directory stands for every path under it.
_NAME = r"((?:\.\./)*[A-Za-z0-9_][A-Za-z0-9_./-]*)"
REF_PATTERNS = [
    re.compile(r"\$\{?here\}?[\"')]*/" + _NAME),
    re.compile(r"(?:^|[\s;&|(])(?:source|\.)\s+[\"']?\$\(\s*dirname\s+[^)]*\)[\"']?/" + _NAME),
    re.compile(r"\bHERE\s*/\s*[\"']" + _NAME + r"[\"']"),
]

def refs_of(root: pathlib.Path, rel: str) -> set:
    """Skill-relative paths `rel` (skill-relative) references, inside the skill."""
    path = root / rel
    if path.suffix not in (".sh", ".py") or path.is_symlink() or not path.is_file():
        return set()
    text = path.read_text(errors="replace")
    out = set()
    for pat in REF_PATTERNS:
        for m in pat.finditer(text):
            name = m.group(1).rstrip("./")
            if not name:
                continue
            target = posixpath.normpath(posixpath.join(posixpath.dirname(rel), name))
            if target == ".." or target.startswith("../") or target == rel:
                continue
            out.add(target)
    return out

def closure(root: pathlib.Path, start, paths) -> dict:
    """Every skill-relative path reachable from `start`, with the files that reference it.
    `paths` is every path the skill holds; a reference naming a directory of them reaches
    each path under it, and one naming none of them stays in the result as itself."""
    need, todo, done = {}, sorted(start), set()
    while todo:
        cur = todo.pop()
        if cur in done:
            continue
        done.add(cur)
        for ref in refs_of(root, cur):
            under = sorted(p for p in paths if p.startswith(ref + "/"))
            for f in [ref] if ref in paths or not under else under:
                need.setdefault(f, set()).add(cur)
                if f not in done:
                    todo.append(f)
    return need

def in_skill(rels) -> set:
    return {r[len(skill) + 1:] for r in rels if r.startswith(skill + "/")}

def on_disk(root: pathlib.Path) -> set:
    """Every non-directory path under `root`, symlinks included, never followed."""
    out = set()
    for d, dirs, names in os.walk(str(root)):
        for n in names + [x for x in dirs if os.path.islink(os.path.join(d, x))]:
            out.add(pathlib.Path(d, n).relative_to(root).as_posix())
    return out

def tracked(root: pathlib.Path) -> set:
    """Skill-relative paths the repository at `root` tracks; what is on disk when git cannot say."""
    try:
        out = subprocess.run(["git", "-C", str(root), "ls-files", "-z", "--", skill],
                             capture_output=True, check=True).stdout
    except (subprocess.CalledProcessError, OSError):
        return on_disk(root / skill)
    return in_skill(p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p)

# --- what the contract test reads --------------------------------------------------------
# A `/` chain rooted at SKILL_DIR or SCRIPTS (or at a local bound to one, as
# `briefs = SKILL_DIR / "briefs"`) whose parts are string literals or a loop name over a
# literal tuple, and `script("<name>")`. A chain rooted at REPO is outside the skill, which
# no pull carries, and is not a FILES requirement.
ROOTS = {"SKILL_DIR": "", "SCRIPTS": "scripts"}

def contract_reads(text: str) -> set:
    import ast
    def lit(n):
        return n.value if isinstance(n, ast.Constant) and isinstance(n.value, str) else None
    def chain(n, alias, loops):
        if isinstance(n, ast.Name):
            if n.id in ROOTS:
                return [ROOTS[n.id]]
            return [alias[n.id]] if n.id in alias else None
        if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Div):
            left = chain(n.left, alias, loops)
            s = lit(n.right)
            names = [s] if s is not None else (loops.get(n.right.id) if isinstance(n.right, ast.Name) else None)
            if left is None or not names:
                return None
            return [(b + "/" + x) if b else x for b in left for x in names]
        return None
    reads = set()
    for fn in ast.parse(text).body:
        if not isinstance(fn, ast.FunctionDef):
            continue
        alias, loops = {}, {}
        for n in ast.walk(fn):
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                got = chain(n.value, alias, loops)
                if got and len(got) == 1:
                    alias[n.targets[0].id] = got[0]
            if isinstance(n, ast.For) and isinstance(n.target, ast.Name) \
                    and isinstance(n.iter, (ast.Tuple, ast.List)):
                names = [lit(e) for e in n.iter.elts]
                if names and None not in names:
                    loops[n.target.id] = names
        for n in ast.walk(fn):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "script" \
                    and n.args and lit(n.args[0]):
                reads.add("scripts/" + lit(n.args[0]))
            if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Div):
                reads.update(p for p in chain(n, alias, loops) or [] if p)
    return reads

def home_check():
    """The release self-test: FILES stays under the skill, and FILES with its closure carries
    every skill path the contract test reads (a directory read standing for every tracked
    file under it) -- so a release whose consumers' contract test cannot pass is refused."""
    bad = [f"{rel}: {why} -- FILES names only paths under {skill}" for rel in FILES
           for why in [not_plain(rel)] if why]
    contract = repo / CONTRACT
    if not contract.is_file():
        fail("the home has no contract test to hold FILES to:", [f"{CONTRACT}: missing"])
    paths = tracked(repo)
    reads = set()
    for r in contract_reads(contract.read_text()):
        under = {p for p in paths if p.startswith(r + "/")}
        reads |= {r} if r in paths or not under else under
    have = in_skill(FILES)
    carried = have | set(closure(repo / skill, have, paths | have))
    bad += [f"{skill}/{r}: read by {CONTRACT} but neither in vendor.sh FILES nor reached by it"
            for r in sorted(reads - carried)]
    # a home stand-in that holds only the skill and the contract test (the tests build
    # those) has no tools/ source to hold the copy to
    for dst, src in sorted(COPIES.items()):
        s, d = repo / src, repo / dst
        if not s.is_file():
            continue
        if not d.is_file():
            bad.append(f"{dst}: the copy of {src} is missing")
        elif s.read_bytes() != d.read_bytes():
            bad.append(f"{dst}: differs from {src} -- copy {src} over it byte for byte")
    if bad:
        fail("FILES does not carry what the contract test reads, or a copy has drifted:", bad,
             "Fix FILES in scripts/vendor.sh (or the contract test) before tagging a release.")
    print(f"vendor: {repo} is the home of the skill; FILES carries all {len(reads)} skill paths {CONTRACT} reads")
    sys.exit(0)

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
            home_check()
        print(f"vendor: {pin} is missing -- this copy is unpinned; run vendor.sh pull", file=sys.stderr)
        sys.exit(1)
    data = json.loads(pin.read_text())
    bad = []
    for rel, meta in data["files"].items():
        why = not_plain(rel)
        p = repo / rel
        if why:
            bad.append(f"{rel}: {why}")
        elif p.is_symlink():
            bad.append(f"{rel}: a symlink, not the pinned file")
        elif not p.is_file():
            bad.append(f"{rel}: missing")
        elif sha(p) != meta["sha256"]:
            bad.append(f"{rel}: digest differs from the pin")
    # the reviewed list and the pin agree ...
    for rel in FILES + [CONTRACT]:
        if rel not in data["files"]:
            bad.append(f"{rel}: listed in vendor.sh FILES but not in VENDOR.json")
    # ... and the pin covers everything its own scripts reach, present or not: a reached
    # directory is judged by what is on disk under it AND what the pin puts there
    have = in_skill(data["files"])
    need = closure(repo / skill, have, on_disk(repo / skill) | have)
    bad += ["%s/%s: referenced by %s but not in VENDOR.json" % (skill, n, ", ".join(sorted(need[n])))
            for n in sorted(set(need) - have)]
    if bad:
        fail("the copy has drifted from VENDOR.json:", bad,
             "Edit the skill in its home and pull again; never patch the copy.")
    at = data["commit"][:12]
    if data.get("ref"):
        at = f"{data['ref']} = {at}"
    print(f"vendor: {len(data['files'])} files match the pin ({data['from']} @ {at}, {data['date']})")
    sys.exit(0)

# pull -- every refusal below happens before the first write
if is_home:
    print(f"vendor: refusing to pull into the home of the skill: {repo} is {home}, "
          f"named by {HOME_HOW} -- run pull in a consumer", file=sys.stderr)
    sys.exit(1)
bad = [f"{rel}: {why}" for rel in FILES for why in [not_plain(rel)] if why]
if bad:
    fail("refusing to pull: a FILES entry is not a plain path under the skill:", bad)
def git(*a):
    """Run git in the home: (returncode, stdout bytes)."""
    try:
        r = subprocess.run(["git", "-C", str(home)] + list(a), capture_output=True)
    except OSError:
        return 1, b""
    return r.returncode, r.stdout
rc, top = git("rev-parse", "--show-toplevel")
if rc != 0 or pathlib.Path(top.decode().strip()).resolve() != home.resolve():
    print(f"vendor: refusing to pull: no APPL checkout at {home} (the home, from {HOME_HOW}) "
          f"-- set APPL_HOME to the APPL checkout", file=sys.stderr)
    sys.exit(1)
# the ref: a tag of the home or the literal main, and nothing else git would resolve (a
# branch, a sha, HEAD, `v1~1`); `full` starts with refs/, so it never reads as an option
full = "refs/heads/main" if ref == "main" else "refs/tags/" + ref
rc, out = git("rev-parse", "--verify", "--quiet", full + "^{commit}")
if (rc != 0 or ref.startswith("-") or git("check-ref-format", full)[0] != 0
        or git("show-ref", "--verify", "--quiet", full)[0] != 0):
    print(f"vendor: refusing to pull: --ref {ref} is neither a release tag of the home at {home} "
          f"nor main -- name a tag (git -C {home} tag --list) or --ref main", file=sys.stderr)
    sys.exit(1)
commit = out.decode().strip()
# the tree at the ref, never the checkout's working files: mode and blob of every path
# under the skill and of the contract
rc, out = git("ls-tree", "-r", "-z", "--full-tree", commit, "--", skill, CONTRACT, *ENTRY_POINTS)
if rc != 0:
    print(f"vendor: refusing to pull: cannot list the home's tree at {ref} ({commit[:12]})", file=sys.stderr)
    sys.exit(1)
entries = {}
for rec in out.split(b"\0"):
    if rec:
        meta, _, path = rec.partition(b"\t")
        tree_mode, _type, obj = meta.decode().split(" ")
        entries[path.decode("utf-8", "surrogateescape")] = (tree_mode, obj)
if f"{skill}/SKILL.md" not in entries:
    print(f"vendor: refusing to pull: no skill at {home / skill} at {ref} ({commit[:12]}) "
          f"(the home, from {HOME_HOW}) -- set APPL_HOME to the APPL checkout", file=sys.stderr)
    sys.exit(1)
if CONTRACT not in entries:
    print(f"vendor: no {CONTRACT} at {home} at {ref} -- the contract test lives under tests/", file=sys.stderr)
    sys.exit(1)
REGULAR = {"100644": 0o644, "100755": 0o755}
# The closure is walked on the skill's regular files at the ref, laid out in a scratch
# directory; a symlink or submodule there is never materialised, so nothing points out,
# but its path is still known from the tree -- a reference reaching it is refused below.
blobs = {}
snap = pathlib.Path(tempfile.mkdtemp(prefix="vendor-ref-"))
try:
    for path, (tree_mode, obj) in entries.items():
        if tree_mode not in REGULAR or not_plain(path):
            continue
        rc, data = git("cat-file", "blob", obj)
        if rc != 0:
            fail("refusing to pull:", [f"{path}: cannot read blob {obj} at {ref}"])
        blobs[path] = (data, REGULAR[tree_mode])
        (snap / path).parent.mkdir(parents=True, exist_ok=True)
        (snap / path).write_bytes(data)
    need = closure(snap / skill, in_skill(FILES), in_skill(entries))
finally:
    shutil.rmtree(str(snap), ignore_errors=True)
reached = {f"{skill}/{n}": ", ".join(sorted(need[n])) for n in need}
pulled = FILES + sorted(set(reached) - set(FILES)) + [e for e in ENTRY_POINTS if e in entries] + [CONTRACT]
repo_real = repo
for rel in pulled:
    dst = repo / rel
    tree_mode = entries.get(rel, ("", ""))[0]
    if rel not in entries and rel in reached:
        bad.append(f"{rel}: referenced by {reached[rel]} but no file or directory in the home at {ref}")
    elif tree_mode == "120000":
        bad.append(f"{rel}: a symlink in the home at {ref} -- refusing to copy what it points at")
    elif tree_mode not in REGULAR or not_plain(rel):
        bad.append(f"{rel}: not a regular file in the home at {ref}")
    # the nearest directory that exists already is the one mkdir would write through
    anc = dst.parent
    while anc != repo and not os.path.lexists(str(anc)):
        anc = anc.parent
    if dst.is_symlink() or (dst.exists() and not dst.is_file()):
        bad.append(f"{rel}: the consumer's copy is a symlink or not a file")
    elif os.path.realpath(str(anc)) != str(repo_real / anc.relative_to(repo)):
        bad.append(f"{rel}: the consumer's directory resolves elsewhere")
if bad:
    fail("refusing to pull:", bad)
files = {}
for rel in pulled:
    data, perm = blobs[rel]
    dst = repo / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)
    dst.chmod(perm)
    files[rel] = {"sha256": sha(dst), "mode": "100755" if perm == 0o755 else "100644"}
stale = repo / "test_isolated_session.py"
if stale.is_file():
    stale.unlink()
pin.write_text(json.dumps({
    "_": "Written by .cursor/skills/isolated-session/scripts/vendor.sh pull --ref; never edit the "
         "copies by hand. `vendor.sh check` holds them to these digests, and to the closure of "
         "what the scripts reference, with no home checkout present. The skill's home is APPL; "
         "edit it there, tag a release, and pull again.",
    "from": "appl",
    "repository": "private",
    "ref": ref,
    "commit": commit,
    "date": datetime.date.today().isoformat(),
    "files": files,
}, indent=2) + "\n")
print(f"vendor: pulled {len(files)} files from {home} @ {ref} ({commit[:12]})")
PY
