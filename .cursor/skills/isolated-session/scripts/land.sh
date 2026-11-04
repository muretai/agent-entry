#!/bin/bash
# land.sh -- the launcher's landing. herd-spawn.sh copies this file into
# $HERD_DIR/walls/<name>/, which the worker cannot write.
#
# The worker may ask for a landing. It does not choose this program, the branch,
# the worktree, or the commit the tests run against. Those come from the spawn's
# run.json, written where the worker cannot write.
#
#   land.sh <run.json>                 do the landing
#   land.sh --repair <run.json> <why>  ask the worker once to fix the branch
# Any other argument is a test option and is refused by name. Under gate github the
# GitHub test check is the landing's test run, so no test option is taken.
#
# A landing that fails asks that worker once, then stops. A person lands only
# after that attempt. This program never tells anyone to run finish-worktree.sh.
#
# The branch's tests run HERE, in this process's own environment -- the launcher's,
# outside every Seatbelt profile -- exactly as an operator's landing runs them
# (ISSUE(launcher-landing-still-runs-inside-the-wall)). They used to go back through
# `plug.sh exec profile`, i.e. behind the worker's own wall, where the OS refuses a
# nested sandbox-exec: every suite that builds a wall was booked FAIL for the room. The
# pid that ran them, and whether a nested sandbox-exec worked from it, go to wall.log.
set -euo pipefail
# -B: this python imports BASE's tools/gate_slots.py out of the gate copy, and a copy that
# gained a __pycache__ would hand bytecode to every later import of it.
# python is started from stdin, so the directory of this copy is handed in. A BASE
# from before land-sandbox.sh still sandboxes with the helper beside this launcher.
ISO_LAND_SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
export ISO_LAND_SCRIPT_DIR
exec python3 -I -B - "$@" <<'PY'
import atexit, hashlib, json, os, re, shutil, site, stat, subprocess, sys, tempfile, time, unicodedata

SKILL = os.path.join(".cursor", "skills", "isolated-session", "scripts")
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
# the installed scripts dir the spawn recorded (installed_scripts()), "" for a vendored skill
INSTALLED = [""]
# the landing keeps at most this many bytes of the gate runner's stderr
STDERR_TAIL = 4096
# git rev-parse --local-env-vars, the same list vendor.sh drops before git -C.
# These name a repository, a work tree, an index or an object store. They are not
# identity (GIT_AUTHOR_*) and not the global config (GIT_CONFIG_GLOBAL).
GIT_REPO_VARS = (
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
    "GIT_PREFIX", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_GRAFT_FILE",
    "GIT_IMPLICIT_WORK_TREE", "GIT_INTERNAL_SUPER_PREFIX", "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE", "GIT_QUARANTINE_PATH",
)


def drop_repo_git_env(env):
    """Remove git's repository-location variables from env. Returns env.

    The herd launcher starts inside the worker's worktree, so this process inherits
    that worktree's GIT_DIR and often GIT_WORK_TREE, GIT_INDEX_FILE or
    GIT_OBJECT_DIRECTORY. Left set, land.sh's own git reads the branch's object
    store, and the copy handed to finish makes the dirty-base check compare the
    primary work tree with the branch's index. The two pins finish reads are put
    on finish's environment from the spawn record, under ISO_FINISH_PIN_* names.
    """
    for key in GIT_REPO_VARS:
        env.pop(key, None)
    return env


def say(text):
    sys.stderr.write(text if text.endswith("\n") else text + "\n")


def runjson_of(argv):
    if len(argv) < 2 or not argv[1]:
        say("land: no spawn record")
        return ""
    return argv[1]


def wall_of(runjson):
    return os.path.dirname(os.path.realpath(runjson))


def repair(runjson, reason):
    """One attempt by the worker that owns this landing. A second failure names a person."""
    reason = " ".join(str(reason).split())[:400] or "the landing failed"
    wall = wall_of(runjson)
    marker = os.path.join(wall, "repair-tried")
    if os.path.lexists(marker):
        say("landing exception: the repair agent already tried once. A person may land this branch.")
        return 0
    try:
        cfg = json.load(open(runjson, encoding="utf-8"))
    except (OSError, ValueError):
        say("landing exception: the repair agent could not be prompted. A person may land this branch.")
        return 0
    worker = cfg.get("worker") if isinstance(cfg, dict) else ""
    if not isinstance(worker, str):
        worker = ""
    try:
        with open(os.path.join(wall, "landing-exception.json"), "w", encoding="utf-8") as fh:
            json.dump({"worker": worker, "reason": reason}, fh, indent=1)
            fh.write("\n")
        fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
    except OSError:
        say("landing exception: the repair agent could not be prompted. A person may land this branch.")
        return 0
    brief = ("Landing failed: %s. Fix the branch in the recorded worktree and ask for the "
             "landing again. You are the first attempt; a person lands only if you cannot."
             % reason)
    herdr = shutil.which("herdr")
    if not herdr or not worker:
        say("landing exception: the repair agent could not be prompted. A person may land this branch.")
        return 0
    try:
        r = subprocess.run([herdr, "agent", "prompt", worker, brief],
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        r = None
    if r is None or r.returncode != 0:
        say("landing exception: the repair agent could not be prompted. A person may land this branch.")
    return 0


def safe_name(text):
    """`text` with every control or line-separator code point spelled out, so a name the
    diff chose cannot end a receipt line or start one."""
    return "".join(_spell_control(ord(c)) if unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp")
                   else c for c in text)


def base_parks(common, base):
    """The paths BASE's own tools/units.json parks, read from git ({} when there is none)."""
    r = git(common, "show", base + ":tools/units.json")
    try:
        rows = json.loads(r.stdout).get("files") if r.returncode == 0 else None
    except (ValueError, AttributeError):
        rows = None
    rows = rows if isinstance(rows, dict) else {}
    return set(f for f, row in rows.items() if isinstance(row, dict)
               and isinstance(row.get("parked"), str) and row["parked"].strip())


def tests_lines(wall, held=None):
    """The runner's JSON, in the same TESTS=/TESTS_RED= shape finish-worktree.sh prints.
    `held` is the set of paths BASE's map parks: a parked file outside it is marked."""
    try:
        data = json.load(open(os.path.join(wall, "tests-runner.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    if not isinstance(data, dict):
        return ""
    files = data.get("files") if isinstance(data.get("files"), list) else []
    # a file red on BASE too is counted `red-on-base`, never `fail`, and does not refuse
    on_base = [x for x in (data.get("red_on_base") or []) if isinstance(x, str)]
    counts = {}
    for row in files:
        if isinstance(row, dict):
            k = "red-on-base" if row.get("file") in on_base else row.get("status")
            counts[k] = counts.get(k, 0) + 1
    # a parked file (a units.json `parked` row) was not run and never refuses
    order = ("ok", "skip", "fail", "timeout", "could-not-run", "red-on-base", "parked")
    line = ", ".join("%d %s" % (counts[k], k) for k in order if counts.get(k))
    text = "TESTS=%s (of %d; %s)\n" % (line or "0 files", len(files), data.get("selection") or "")
    # a timeout is not a fail: `<path> (timeout)` for a file killed at its budget, a failed
    # one bare; both refuse. A runner without `timed_out` put timeouts on `failed`, and the
    # per-file status still tells them apart
    status = dict((row.get("file"), row.get("status")) for row in files if isinstance(row, dict))
    timed_out = [x for x in (data.get("timed_out") or []) if isinstance(x, str)]
    named = [x for x in (data.get("failed") or []) if isinstance(x, str)]
    named += [x for x in timed_out if x not in named]
    failed = " ".join(x + " (timeout)" if x in timed_out or status.get(x) == "timeout" else x
                      for x in named)
    unrun = " ".join(x for x in (data.get("could_not_run") or []) if isinstance(x, str))
    if failed:
        text += "TESTS_RED=%s\n" % failed
    if unrun:
        text += "TESTS_COULD_NOT_RUN=%s\n" % unrun
    if on_base:
        text += "TESTS_RED_ON_BASE=%s\n" % " ".join(on_base)
    # the parked files, a park BASE's own map lacks marked as finish-worktree.sh marks it
    held = held or set()
    parked = " ".join(safe_name(x) + ("" if x in held else " (not parked on BASE)")
                      for x in (data.get("parked") or []) if isinstance(x, str))
    if parked:
        text += "TESTS_PARKED=%s\n" % parked
    # the refusal's class, as finish-worktree.sh spells it: `environment` only when every
    # suite that did not pass is one the room could not run; any ordinary red makes it `red`
    text += "TESTS_REFUSAL=%s\n" % ("environment" if unrun and not failed else "red")
    return text


def log(wall, line):
    """One line in the spawn's wall.log, appended the way run.py appends: never through a link."""
    try:
        fd = os.open(os.path.join(wall, "wall.log"),
                     os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            os.write(fd, (time.strftime("%Y-%m-%dT%H:%M:%S%z") + " " + line + "\n").encode())
        finally:
            os.close(fd)
    except OSError:
        pass


def nest_probe():
    """The requirement's probe, from THIS process: `sandbox-exec -p '(version 1)(allow
    default)' true`. "ok" outside every profile; the refusal's words inside one; "n/a"
    where there is no Seatbelt."""
    if sys.platform != "darwin" or not os.path.exists(SANDBOX_EXEC):
        return "n/a"
    try:
        r = subprocess.run([SANDBOX_EXEC, "-p", "(version 1)(allow default)", "/usr/bin/true"],
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        return "refused (%s)" % type(e).__name__
    if r.returncode == 0:
        return "ok"
    said = (r.stderr.strip().splitlines() or [""])[-1][:120]
    return "refused (exit %d: %s)" % (r.returncode, said)


def tests_env(env):
    """What finish-worktree.sh's branch_tests_python gives the branch's tests: no push
    credential in reach, the user site directory walled, the operator's optional backend
    lent through MURETAI_TEST_BACKEND_PATH (never PYTHONPATH). The blanked keys are
    lib.sh's credless keys; tests/test_land_tests_env_oauth.py pins the two equal."""
    out = dict(env)
    out.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "credential.helper",
                "GIT_CONFIG_VALUE_0": "", "GIT_TERMINAL_PROMPT": "0",
                "GIT_ASKPASS": "/usr/bin/false", "GIT_SSH_COMMAND": "/usr/bin/false",
                "GH_CONFIG_DIR": "/nonexistent/iso-gh", "GH_TOKEN": "", "GITHUB_TOKEN": "",
                "GH_ENTERPRISE_TOKEN": "", "CLAUDE_CODE_OAUTH_TOKEN": "",
                "PYTHONNOUSERSITE": "1"})
    out.pop("PYTHONPATH", None)
    try:
        usersite = site.getusersitepackages() or ""
    except Exception:  # noqa: BLE001
        usersite = ""
    out["MURETAI_TEST_BACKEND_PATH"] = usersite if usersite and os.path.isdir(usersite) else ""
    return out


def sandbox_helper(dest):
    """BASE's land-sandbox.sh in the gate copy, else the one beside this launcher.

    The gate copy is BASE's blob. A tree from before this script has no such blob;
    the helper next to the land.sh that is running is that same program. A link
    is never followed."""
    gate = os.path.join(dest, SKILL, "land-sandbox.sh")
    if not os.path.islink(gate) and os.path.isfile(gate):
        return gate
    for here in (os.environ.get("ISO_LAND_SCRIPT_DIR") or "", INSTALLED[0]):
        if here:
            sibling = os.path.join(here, "land-sandbox.sh")
            if not os.path.islink(sibling) and os.path.isfile(sibling):
                return sibling
    return gate


def sandbox_prepare(dest, worktree, env):
    """(parent, clone) of a disposable shared clone of worktree's BASE at its tip.

    ("", why) when the clone cannot be created. why already says so, and nothing of
    the attempt is left behind. The helper is BASE's, from the gate copy, or the
    one beside this launcher when BASE does not carry it yet."""
    helper = sandbox_helper(dest)
    if os.path.islink(helper) or not os.path.isfile(helper):
        return "", "disposable clone could not be created: the gate has no land-sandbox.sh"
    proc = subprocess.run(["/bin/bash", helper, "prepare", worktree], env=env,
                          stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if proc.returncode != 0:
        err = (proc.stderr or "").strip()
        if "could not" not in err.lower() and "cannot" not in err.lower() and "unable" not in err.lower():
            err = "disposable clone could not be created: " + (err or "git clone failed")
        return "", err
    parent, clone = "", ""
    for line in (proc.stdout or "").splitlines():
        if line.startswith("parent="):
            parent = line.split("=", 1)[1]
        elif line.startswith("clone="):
            clone = line.split("=", 1)[1]
    if not parent or not clone or not os.path.isdir(clone):
        return "", "disposable clone could not be created: the helper named no clone"
    return (parent, clone), ""


def sandbox_remove(dest, clone, env):
    """Remove the clone. Its private parent stays: it is the ceiling the run published."""
    helper = sandbox_helper(dest)
    if clone and not os.path.islink(helper) and os.path.isfile(helper):
        subprocess.run(["/bin/bash", helper, "remove", clone], env=env,
                       stdin=subprocess.DEVNULL, capture_output=True)


def sandbox_test_env(env, parent):
    """tests_env, with inherited GIT_* dropped and the clone's ceiling put back.

    tests_env then adds the credential wall. When MURETAI_LAND_SANDBOX is set,
    run_tests.py strips every other GIT_* name from the test child but keeps the
    wall's names and GIT_CEILING_DIRECTORIES, a parent of the clone, and blanks
    SSH_AUTH_SOCK."""
    out = {k: v for k, v in env.items() if not k.startswith("GIT_")}
    out["GIT_CEILING_DIRECTORIES"] = parent
    out["MURETAI_LAND_SANDBOX"] = parent
    return tests_env(out)


def slot_dir_refusal(dest):
    """Why the gate's slot directory refuses this landing, or "" when it does not.

    The one definition of that directory is tools/gate_slots.py, loaded BY PATH from the
    gate's copy of BASE (never the worktree's), so this program spells no path of its own.
    tools/ is never put on this interpreter's sys.path: with it there, a tools/typing.py or
    tools/ast.py BASE carried would answer the module's own `from typing import ...` and run
    here, as the operator, outside every wall (W4b, review secrev-land-sh-refuses-a-ba-389a
    finding 1). A gate_slots this interpreter already holds FROM THAT SAME FILE is asked as
    it is -- one resolver for the gate and this pre-check (tests/test_nested_gate_slot.py),
    never a second copy with its own idea of the directory. A BASE that predates the module
    has no slot directory to check: its runner does not use one. Self-contained on purpose
    (os and sys only): the test above lifts this function out of land.sh and runs it alone."""
    tools = os.path.join(dest, "tools")
    mod = os.path.join(tools, "gate_slots.py")
    if not os.path.isfile(mod) or os.path.islink(mod):
        return ""
    gate_slots = sys.modules.get("gate_slots")
    if gate_slots is None or os.path.realpath(getattr(gate_slots, "__file__", "") or "") != os.path.realpath(mod):
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location("_land_gate_slots", mod)
            if spec is None or spec.loader is None:
                raise ImportError("no loader for " + mod)
            gate_slots = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = gate_slots            # a private name: nothing imports it by accident
            spec.loader.exec_module(gate_slots)
        except Exception as e:  # noqa: BLE001 -- a gate module that will not load is a refusal
            return "the gate's tools/gate_slots.py could not be loaded by path: %s" % e
    try:
        gate_slots.ensure_slot_dir()
    except gate_slots.SlotDirRefused as e:
        return "the gate's slot directory is refused before any test runs: %s" % e
    except OSError as e:
        return "the gate's slot directory %s could not be made: %s" % (gate_slots.slot_dir(), e)
    return ""


def fast_lane_map_error(common, dest, wall, base_sha, tip):
    """The lines naming each path a fast-lane landing reaches outside the fast units, or [].

    Only a landing whose spawn record says lane `fast` is asked (main() checks that). The
    map is BASE's tools/units.json as this landing starts -- never the branch's, so a worker
    cannot grant its own diff the fast lane -- and the predicate is all_paths_in_fast_units
    from the gate copy's tools/affected_tests.py, loaded BY PATH under a private name, the way
    slot_dir_refusal() loads gate_slots. The changed paths are the branch's own: the fork
    point (merge base of BASE and the tip) to the tip, renames split into their two paths.
    Each line names one non-fast path with every unit that claims it, or names it unclaimed;
    a fast path is never named. A map or a module that cannot be read is one line too: the
    fast lane is not granted on a map nobody could check."""
    mod = os.path.join(dest, "tools", "affected_tests.py")
    if not os.path.isfile(mod) or os.path.islink(mod):
        return ["fast-lane map error: BASE carries no tools/affected_tests.py to check the fast lane"]
    units_blob = subprocess.run(["git", "--git-dir", common, "show", "%s:tools/units.json" % base_sha],
                                capture_output=True)
    if units_blob.returncode != 0:
        return ["fast-lane map error: BASE carries no tools/units.json to check the fast lane"]
    units_path = os.path.join(wall, "fast-lane-units.json")
    try:
        with open(units_path, "wb") as fh:
            fh.write(units_blob.stdout)
        import importlib.util
        spec = importlib.util.spec_from_file_location("_land_affected_tests", mod)
        if spec is None or spec.loader is None:
            raise ImportError("no loader for " + mod)
        affected = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = affected            # a private name: nothing imports it by accident
        spec.loader.exec_module(affected)
        fork = git(common, "merge-base", base_sha, tip).stdout.strip() or base_sha
        r = subprocess.run(["git", "--git-dir", common, "diff", "--name-only", "--no-renames",
                            "-z", fork, tip], capture_output=True)
        if r.returncode != 0:
            return ["fast-lane map error: git diff over the branch's commits failed"]
        paths = sorted({p.decode("utf-8", "replace") for p in r.stdout.split(b"\0") if p})
        if affected.all_paths_in_fast_units(paths, units_path):
            return []
        data = affected.load_units(affected.Path(units_path))
        units = data["units"]
        lines = []
        for rel in paths:
            names = affected.units_for(rel, data)
            slow = [n for n in names if units[n].get("lane") != "fast"]
            if not names:
                lines.append("fast-lane map error: %s is unclaimed: no unit in tools/units.json "
                             "claims it" % rel)
            elif slow:
                lines.append("fast-lane map error: %s is claimed by %s, which is not a fast unit"
                             % (rel, ", ".join(slow)))
        if not lines:
            lines.append("fast-lane map error: the branch changes no path a fast unit claims")
        return lines
    except Exception as e:  # noqa: BLE001 -- a map that will not load is a refusal
        return ["fast-lane map error: the fast lane could not be checked: %s" % " ".join(str(e).split())]
    finally:
        try:
            os.unlink(units_path)
        except OSError:
            pass


def fail(runjson, reason, extra=""):
    if extra:
        sys.stdout.write(extra if extra.endswith("\n") else extra + "\n")
    sys.stdout.write("MERGED=no\n")
    say("land: " + " ".join(str(reason).split()))
    repair(runjson, reason)
    return 1


def _spell_control(code):
    if code < 128:
        return "\\x%02x" % code
    return "\\u%04x" % code


def runner_stdout_text(raw):
    """The runner's stdout as text. Universal newlines stay on stdout only: the
    JSON receipt is text. stderr is never decoded on this path."""
    return raw.decode("utf-8", "replace").replace("\r\n", "\n").replace("\r", "\n")


def format_runner_stderr(raw):
    """The landing's copy of the gate runner's stderr, or "" when it wrote nothing.

    Bytes in, so a bare CR is still a CR: text mode would have made it a newline
    before it could be neutralised. The last STDERR_TAIL bytes are kept, and when
    that dropped anything the block says so. Every control other than tab and
    newline is spelled out before any line split, the bytes are decoded with
    errors replaced, and every line is indented so none can start a receipt line.
    """
    if not raw:
        return ""
    cut = len(raw) > STDERR_TAIL
    tail = raw[-STDERR_TAIL:] if cut else raw
    kept = bytearray()
    for b in tail:
        if b in (9, 10):
            kept.append(b)
        elif b < 32 or b == 127:
            kept.extend(_spell_control(b).encode("ascii"))
        else:
            kept.append(b)
    chars = []
    for ch in bytes(kept).decode("utf-8", "replace"):
        if ch in ("\t", "\n"):
            chars.append(ch)
        elif unicodedata.category(ch) == "Cc":
            chars.append(_spell_control(ord(ch)))
        else:
            chars.append(ch)
    lines = "".join(chars).split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    text = "runner stderr:\n"
    if cut:
        text += "  earlier stderr was cut; kept the last %d bytes\n" % STDERR_TAIL
    text += "\n".join("  " + line for line in lines) + "\n"
    return text


def emit_runner_stderr(raw):
    """Print the block after the verdict. It is data: it does not change MERGED=,
    the receipt, or the exit code."""
    shown = format_runner_stderr(raw)
    if shown:
        sys.stderr.write(shown)


def refuse(runjson, reason, runner_err, extra=""):
    """fail() first, so MERGED=no is already written, then the runner's stderr."""
    rc = fail(runjson, reason, extra)
    emit_runner_stderr(runner_err)
    return rc


def git(gitdir, *args):
    return subprocess.run(["git", "--git-dir", gitdir, *args],
                          capture_output=True, text=True)


def gitdir_of(worktree):
    """The git dir the worktree's .git names now. A symlink is not a worktree we will trust."""
    p = os.path.join(worktree, ".git")
    if os.path.islink(p):
        return ""
    if os.path.isfile(p):
        try:
            text = open(p, encoding="utf-8", errors="replace").read().strip()
        except OSError:
            return ""
        if not text.startswith("gitdir:"):
            return ""
        gd = text.split(":", 1)[1].strip()
        if not gd:
            return ""
        if not os.path.isabs(gd):
            gd = os.path.join(worktree, gd)
        return os.path.realpath(gd)
    if os.path.isdir(p):
        return os.path.realpath(p)
    return ""


def commondir_refusal(gitdir, common, primary):
    """Why the worktree's <gitdir>/commondir refuses this landing ("" when it does not).

    git finds a linked worktree's refs and objects through that file, and the worker can
    write it (its gitdir is allow-write). One pointed at a git dir of the worker's own, whose
    main carried a finish-worktree.sh, had that blob run as the launcher, outside every wall
    (intake 20261011T142331Z, ruling 20261011T142424Z). So the file, read as git reads it
    (resolved against the gitdir when relative), must name the recorded common dir, and the
    recorded common dir must be the primary's own. Returns the refusal and the primary's
    common dir (the one finish is pinned to)."""
    recorded = os.path.realpath(common)
    real = recorded
    if primary:
        r = subprocess.run(["git", "-C", primary, "rev-parse", "--git-common-dir"],
                           capture_output=True, text=True)
        theirs = r.stdout.strip() if r.returncode == 0 else ""
        if not theirs:
            return "the primary %s has no common dir to check the worktree's commondir against" % primary, ""
        real = os.path.realpath(os.path.join(primary, theirs))
    path = os.path.join(os.path.realpath(gitdir), "commondir")
    try:
        text = open(path, encoding="utf-8", errors="replace").read().rstrip("\r\n")
    except OSError:
        return ("the worktree's commondir %s cannot be read; the recorded common dir is %s"
                % (path, real)), ""
    named = os.path.realpath(os.path.join(os.path.realpath(gitdir), text)) if text else ""
    if named != real:
        return ("the worktree's commondir names %s (%r), not the recorded common dir %s"
                % (named or "nothing", text, real)), ""
    if recorded != real:
        return ("the recorded common dir %s is not the primary's common dir %s"
                % (recorded, real)), ""
    return "", real


def listed(common, worktree):
    r = git(common, "worktree", "list", "--porcelain")
    if r.returncode != 0:
        return False
    want = os.path.realpath(worktree)
    for line in r.stdout.splitlines():
        if line.startswith("worktree "):
            try:
                if os.path.realpath(line.split(" ", 1)[1]) == want:
                    return True
            except OSError:
                continue
    return False


def record_of(cfg):
    gate = cfg.get("gate") if isinstance(cfg.get("gate"), dict) else {}
    rec = cfg.get("record") if isinstance(cfg.get("record"), dict) else {}
    out = dict(rec)
    out.update({k: v for k, v in gate.items() if v})
    return out


SAFE_NAME = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")

# The programs the gate runs out of its copy of BASE. Their imports are walked at BASE
# (closure() below) to find which repository modules outside tools/ the copy must carry.
GATE_ENTRIES = ("tools/ledger.py", "tools/sec_lint.py", "tools/invariants.py",
                "tools/run_tests.py", "tools/audit_scope.py", "tools/backlog_build.py",
                "tools/spec_build.py", "tools/affected_tests.py")
# The modules outside tools/ that a gate program may reach through its own sys.path
# insert (tools/ledger.py puts company/ops/ first). Where the insert points cannot be
# read statically, so the list is pinned. It must name exactly the paths outside tools/ in
# finish-worktree.sh's `gate_tools` -- tests/test_gate_closure_lists.py holds the two
# to each other (ISSUE(gate-copy-lacks-the-ledgers-import)).
GATE_CLOSURE = ("company/ops/backlog_to_core.py",)
# The gate's config reader, which finish-worktree.sh runs out of the gate copy (gate_config):
# not imported by any gate program, so the closure walk never reaches it.
GATE_CONFIG = ("appl/config.py",)


def imported_names(path, source=None):
    """The top-level names a Python file imports absolutely, anywhere in it. A file that does
    not parse imports nothing here: the gate program that runs it will crash, and
    finish-worktree.sh calls that crash a broken gate. `source`, when given, is the file's
    bytes read from BASE's tree rather than from disk."""
    import ast
    try:
        tree = ast.parse(open(path, "rb").read() if source is None else source, path)
    except (OSError, SyntaxError, ValueError):
        return set()
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
            names.add(node.module.split(".")[0])
    return names


def closure(dest):
    """The GATE_CLOSURE paths BASE's gate actually imports: a walk from GATE_ENTRIES through
    every tools/ module they import, and through each closure module already written into
    `dest` (extract() calls this until it names nothing new). A closure path nothing
    imports is not demanded, so a BASE without a ledger needs no company/ops/."""
    by_name = {os.path.splitext(os.path.basename(p))[0]: p for p in GATE_CLOSURE}

    def there(rel):
        return os.path.isfile(os.path.join(dest, *rel.split("/")))

    queue = [p for p in GATE_ENTRIES if there(p)]
    seen, needed = set(queue), []
    while queue:
        rel = queue.pop(0)
        for name in sorted(imported_names(os.path.join(dest, *rel.split("/")))):
            if name in by_name:
                nxt = by_name[name]
                if nxt not in needed:
                    needed.append(nxt)
                if not there(nxt) and there("tools/" + name + ".py"):
                    nxt = "tools/" + name + ".py"       # BASE keeps it at tools/ (in_tools())
            else:
                nxt = "tools/" + name + ".py"
            if nxt not in seen and there(nxt):
                seen.add(nxt)
                queue.append(nxt)
    return needed


def in_tools(dest, path):
    """True when the copy in `dest` holds tools/<stem>.py for the GATE_CLOSURE `path`: BASE
    keeps that module at tools/, where the gate program's own tools/ insert finds it, so it
    answers the import as well as the closure path would (extract() copied it from BASE's
    blob with the rest of tools/)."""
    stem = os.path.splitext(os.path.basename(path))[0]
    return os.path.isfile(os.path.join(dest, "tools", stem + ".py"))


def stdlib_names():
    """The top-level names of THIS interpreter's standard library: the one the gate runner
    (`sys.executable -I -B <copy>/tools/run_tests.py`) starts with <copy>/tools first on its
    sys.path, so a tools/<name>.py for any of these answers the runner's own `import <name>`.
    sys.stdlib_module_names exists from 3.10 only; the floor is 3.9, so the set is built from
    what is always there -- sys.builtin_module_names plus the stdlib directories' listing
    (stdlib, platstdlib, lib-dynload: a .py, a package directory or an extension file each
    name a module) -- and sys.stdlib_module_names is added where it exists."""
    import sysconfig
    names = set(getattr(sys, "stdlib_module_names", ()))
    names.update(sys.builtin_module_names)
    paths = sysconfig.get_paths()
    dirs = []
    for key in ("stdlib", "platstdlib"):
        d = paths.get(key)
        if d:
            dirs.extend((d, os.path.join(d, "lib-dynload")))
    for d in dirs:
        try:
            entries = os.listdir(d)
        except OSError:
            continue
        for entry in entries:
            stem = entry.split(".")[0]
            if not stem.isidentifier():
                continue
            if entry.endswith((".py", ".so", ".pyd")) or os.path.isdir(os.path.join(d, entry)):
                names.add(stem)
    return names


def code_shadow(parts, stems, std):
    """The stem a tools/ entry (its path split below tools/) would answer an import for, or
    "" when the entry is harmless. Only CODE shadows count: a .py file named for a standard
    library module, a package directory tools/<stem>/ holding a .py (or an extension file, or
    a __pycache__ entry) anywhere under it, an extension file tools/<stem>*.so / .pyd, an
    entry tools/__pycache__/<stem>.*, or a bare extensionless tools/<stem>. A data file
    (tools/json/schema.json) or a directory with no code under it (tools/affected_tests/README.md)
    answers no import and is never a shadow, whatever its name."""
    first = parts[0]
    if len(parts) > 1:
        if first == "__pycache__":
            stem = parts[1].split(".")[0]
            return stem if len(parts) == 2 and (stem in stems or stem in std) else ""
        last = parts[-1]
        holds_code = last.endswith((".py", ".so", ".pyd")) or "__pycache__" in parts[1:]
        return first if holds_code and (first in stems or first in std) else ""
    stem = first.split(".")[0]
    if first.endswith(".py"):
        return stem if stem in std else ""
    if first == stem or first.endswith((".so", ".pyd")):
        return stem if (stem in stems or stem in std) else ""
    return ""


def shadow_refusal(common, gate_sha, whose="BASE", skip=()):
    """Why `whose` tree (BASE, or the branch's tip) refuses this landing because its tools/
    shadows a module the gate imports, or "".

    Run before extract(), on the tree itself, so nothing is written on a refusal. A gate
    module's stem is every GATE_ENTRIES stem, every module the closure walk reaches from them
    (the same walk closure() makes, read blob by blob from the tree), and every name those
    files import; to those come the standard library's top-level names (stdlib_names()),
    since the runner starts with the copy's tools/ first on its sys.path and a
    tools/typing.py there would answer `from typing import ...` in gate_slots.py, in the
    runner and in the launcher's own load of the module. Which shapes shadow is code_shadow()'s
    rule: code only, never a data file or a directory without .py (finding 2 of the review of
    389a23e refused tools/json/schema.json). `skip` names the paths the branch deletes: a BASE
    shadow the branch removes is not held against the branch, which is the one landing that
    can take it out. The landing stops and names the entry rather than stepping around it."""
    listing = {}
    for root in ("tools/",) + tuple(p for p in GATE_CLOSURE if not p.startswith("tools/")):
        r = subprocess.run(["git", "--git-dir", common, "ls-tree", "-r", "-z", "--full-tree",
                            gate_sha, "--", root], capture_output=True)
        if r.returncode != 0:
            return "%s's tree could not be listed at %s" % (whose, root)
        for raw in r.stdout.split(b"\0"):
            head, _, rawpath = raw.partition(b"\t")
            fields = head.split()
            if len(fields) == 3:
                listing[rawpath.decode("utf-8", "replace")] = fields[0].decode()

    def source(rel):
        if listing.get(rel) not in ("100644", "100755"):
            return None
        r = subprocess.run(["git", "--git-dir", common, "cat-file", "blob",
                            "%s:%s" % (gate_sha, rel)], capture_output=True)
        return r.stdout if r.returncode == 0 else None

    by_name = {os.path.splitext(os.path.basename(p))[0]: p for p in GATE_CLOSURE}
    stems = {os.path.splitext(os.path.basename(p))[0] for p in GATE_ENTRIES}
    queue = [p for p in GATE_ENTRIES if p in listing]
    seen = set(queue)
    while queue:
        rel = queue.pop(0)
        text = source(rel)
        if text is None:
            continue
        for name in sorted(imported_names(rel, text)):
            stems.add(name)
            nxt = by_name.get(name) or "tools/" + name + ".py"
            if nxt not in seen and nxt in listing:
                seen.add(nxt)
                queue.append(nxt)
    std = stdlib_names()
    skip = set(skip)
    for path in sorted(listing):
        if not path.startswith("tools/") or path in skip:
            continue
        parts = path[len("tools/"):].split("/")
        stem = code_shadow(parts, stems, std)
        if not stem:
            continue
        entry = "tools/%s/" % parts[0] if len(parts) > 1 and parts[0] != "__pycache__" else path
        shadow_of = ("the standard-library module %s" % stem if stem in std
                     else "the gate module tools/%s.py" % stem)
        return ("%s's %s shadows %s; the landing refuses before the gate copy is made"
                % (whose, entry, shadow_of))
    return ""


def deleted_by_branch(common, base_sha, tip):
    """The tools/ paths the branch takes out: present at the fork point (the merge base of
    BASE and the branch's tip) and absent at the tip. A path BASE added after the fork is not
    the branch's deletion -- the merge would keep it -- so it is not in this set."""
    fork = git(common, "merge-base", base_sha, tip).stdout.strip() or base_sha
    r = subprocess.run(["git", "--git-dir", common, "diff", "--name-only", "--diff-filter=D",
                        "-z", fork, tip, "--", "tools/"], capture_output=True)
    if r.returncode != 0:
        return set()
    return {p.decode("utf-8", "replace") for p in r.stdout.split(b"\0") if p}


def installed_scripts(cfg, primary):
    """The recorded scripts dir when it is an installed skill (~/.appl/<v>), "" when the
    landing runs BASE's vendored skill out of the gate copy as before (the record names the
    primary's vendored dir, or names none). run.py judged the dir before it started this
    program; here it must still be a real directory, never a link."""
    value = cfg.get("scripts_dir")
    if not isinstance(value, str) or not value:
        return ""
    if primary and os.path.realpath(value) == os.path.realpath(os.path.join(primary, SKILL)):
        return ""
    return value


def extract(common, gate_sha, wall, skip=(), need_skill=True):
    """BASE's scripts and tools, from gate_sha -- BASE's tip as the landing starts, never the
    commit the spawn recorded, so a worker spawned before a gate change lands under the gate
    BASE holds now -- into walls/<name>/base. The worker cannot write that directory, so it
    cannot swap the runner. `skip` names the tools/ paths the branch deletes (see
    deleted_by_branch()): a shadow among them is left out of the copy, as the merge leaves it
    out of BASE; any other deleted path is copied as usual, so the branch cannot thin the gate.

    Returns (dest, "") or ("", why). Read blob by blob -- `ls-tree -r -z`, then `git show`
    per entry -- the way finish-worktree.sh extracts BASE's walls/, never `git archive`:
    the archive honours `.gitattributes` export-ignore, and the real tree marks `.cursor/`
    so, which left the gate copy with tools/ and no skill at all
    (ISSUE(land-extract-honours-export-ignore)). `--worktree-attributes` is no cure, since
    it reads the worker-writable worktree. Only regular blobs (100644/100755, the exec bit
    kept) are written; a symlink, a gitlink or anything else under these paths is refused
    by name -- neither followed nor silently skipped. Each name below the prefix obeys the
    walls/ basename rule, and a name that breaks it is refused the same way.

    The order under tools/: first, a code entry that shadows a module the gate imports is
    REFUSED by name -- a .py or a package named for a standard-library module (tools/typing.py
    would answer gate_slots.py's `from typing import` in the runner), an extension file, a
    __pycache__ entry or a package on a gate module's stem (code_shadow() is the rule; main()
    runs shadow_refusal() on BASE and on the branch's tip before this, so the refusal is
    normally theirs and nothing is written). Then, of what is left, only .py files are written:
    every other blob (notes, units.json, a pyc on a stem no gate program imports) is skipped
    and never refuses the landing."""
    dest = os.path.join(wall, "base")
    GATE_COPIES.pop(dest, None)
    if os.path.lexists(dest):
        if os.path.islink(dest):
            return "", "the gate copy's directory is a link"
        unseal(dest)
        shutil.rmtree(dest)
    os.mkdir(dest, 0o700)
    written = {}

    def bail(why):
        shutil.rmtree(dest, ignore_errors=True)
        return "", why

    def put(path, mode):
        """One regular blob of BASE into dest, exec bit kept; never through a link."""
        target = os.path.join(dest, *path.split("/"))
        os.makedirs(os.path.dirname(target), 0o700, exist_ok=True)
        blob = subprocess.run(["git", "--git-dir", common, "show", "%s:%s" % (gate_sha, path)],
                              capture_output=True)
        if blob.returncode != 0:
            return False
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                     0o755 if mode == "100755" else 0o644)
        try:
            os.write(fd, blob.stdout)
        finally:
            os.close(fd)
        written[path] = hashlib.sha256(blob.stdout).hexdigest()
        return True

    # Only the skill is demanded. tools/ is optional, and each gate program in it is decided
    # per file at BASE (main() below): a repository that vendors this skill alone (agent-entry,
    # muretai-site, muretai-docs, agent-seam) lands the way finish-worktree.sh lands it without
    # them (ISSUE(land-sh-demands-a-runner-a-vendored-repo-does-not-have)).
    roots = (SKILL.replace(os.sep, "/"), "tools")
    skill = subprocess.run(["git", "--git-dir", common, "ls-tree", "-z", "--full-tree",
                            gate_sha, "--", roots[0] + "/"], capture_output=True)
    if skill.returncode != 0 or (need_skill and not skill.stdout):
        return bail("BASE's skill scripts are not in BASE's tip")
    tree = subprocess.run(["git", "--git-dir", common, "ls-tree", "-r", "-z", "--full-tree",
                           gate_sha, "--"] + [r + "/" for r in roots], capture_output=True)
    if tree.returncode != 0:
        return bail("BASE's tree could not be listed")
    gate_stems = {os.path.splitext(os.path.basename(p))[0] for p in GATE_ENTRIES}
    std = stdlib_names()
    skip = set(skip)
    for raw in tree.stdout.split(b"\0"):
        if not raw:
            continue
        head, _, rawpath = raw.partition(b"\t")
        path = rawpath.decode("utf-8", "replace")
        fields = head.split()
        if len(fields) != 3:
            return bail("BASE's tree lists an entry land.sh cannot read")
        mode, kind = fields[0].decode(), fields[1].decode()
        if kind != "blob" or mode not in ("100644", "100755"):
            return bail("BASE's %s is not a regular file" % path)
        root = next((r for r in roots if path.startswith(r + "/")), "")
        parts = path[len(root) + 1:].split("/") if root else []
        if not parts or any(not p or p.startswith(".") or not set(p) <= SAFE_NAME for p in parts):
            return bail("BASE's %s is not a name land.sh extracts" % path)
        if root == "tools":
            stem = code_shadow(parts, gate_stems, std)
            if stem and path in skip:
                # a shadow the branch deletes: out of the copy, as the merge takes it out of BASE
                continue
            if stem:
                entry = "tools/%s/" % parts[0] if len(parts) > 1 and parts[0] != "__pycache__" else path
                return bail("BASE's %s shadows %s; the gate copy is not made" % (
                    entry, "the standard-library module %s" % stem if stem in std
                    else "the gate module tools/%s.py" % stem))
            if not path.endswith(".py"):
                # under tools/ only .py files: any other blob (a pyc or extension file on a stem
                # no gate program imports, notes, units.json) is never copied and never refuses
                continue
        if not put(path, mode):
            return bail("BASE's %s could not be read" % path)
    # Every closure path outside tools/ is decided per file at BASE as well, whether or not a
    # gate program imports it: absent is fine, present as anything but a regular blob (a
    # symlink, a gitlink) is refused by name -- never followed, never read as absent.
    for path in GATE_CLOSURE:
        rec = subprocess.run(["git", "--git-dir", common, "ls-tree", "-z", "--full-tree",
                              gate_sha, "--", path], capture_output=True)
        if rec.returncode != 0:
            return bail("BASE's tree could not be listed at %s" % path)
        head, _, rawpath = rec.stdout.rstrip(b"\0").partition(b"\t")
        if rawpath.decode("utf-8", "replace") != path:
            continue
        fields = head.split()
        if (len(fields) != 3 or fields[1] != b"blob"
                or fields[0].decode() not in ("100644", "100755")):
            return bail("BASE's %s is not a regular file" % path)
    # ... and BASE's closure for the gate: every GATE_CLOSURE path its gate programs import,
    # by blob like the rest. Demanded and missing at BASE is refused here, by name, before a
    # test runs -- the ledger would otherwise die of ModuleNotFoundError inside finish, after
    # the tests (ISSUE(gate-copy-lacks-the-ledgers-import)). Never the worktree's copy: the
    # branch cannot supply a module BASE's gate lacks.
    done = set()
    while True:
        todo = [p for p in closure(dest) if p not in done]
        if not todo:
            break
        for path in todo:
            done.add(path)
            rec = subprocess.run(["git", "--git-dir", common, "ls-tree", "-z", "--full-tree",
                                  gate_sha, "--", path], capture_output=True)
            head, _, rawpath = rec.stdout.rstrip(b"\0").partition(b"\t")
            if (rec.returncode == 0 and rawpath.decode("utf-8", "replace") != path
                    and in_tools(dest, path)):
                # BASE keeps the module at tools/ instead (no company/ops/): the copy
                # already holds BASE's blob of it, and the import resolves there
                continue
            if rec.returncode != 0 or rawpath.decode("utf-8", "replace") != path:
                return bail("BASE's gate imports %s, and BASE's tip does not carry it"
                            % path)
            fields = head.split()
            if (len(fields) != 3 or fields[1] != b"blob"
                    or fields[0].decode() not in ("100644", "100755")):
                return bail("BASE's %s is not a regular file" % path)
            if not put(path, fields[0].decode()):
                return bail("BASE's %s could not be read" % path)
    # BASE's gate config: finish-worktree.sh reads the gate word, lands-locally and the
    # hand-off's [tests] command out of <copy>/appl/config.py, so a copy without it landed a
    # gate = "github" branch locally. Copied when BASE carries it as a regular blob; absent
    # (a consumer) is fine, anything but a regular blob is refused by name.
    for path in GATE_CONFIG:
        rec = subprocess.run(["git", "--git-dir", common, "ls-tree", "-z", "--full-tree",
                              gate_sha, "--", path], capture_output=True)
        if rec.returncode != 0:
            return bail("BASE's tree could not be listed at %s" % path)
        head, _, rawpath = rec.stdout.rstrip(b"\0").partition(b"\t")
        if rawpath.decode("utf-8", "replace") != path:
            continue
        fields = head.split()
        if (len(fields) != 3 or fields[1] != b"blob"
                or fields[0].decode() not in ("100644", "100755")):
            return bail("BASE's %s is not a regular file" % path)
        if not os.path.exists(os.path.join(dest, *path.split("/"))):
            if not put(path, fields[0].decode()):
                return bail("BASE's %s could not be read" % path)
    try:
        seal(dest)
    except OSError as e:
        return bail("the gate copy %s could not be made read-only: %s" % (dest, e))
    if dest not in GATE_COPIES:
        # when the landing is over the copy may be removed again: it is never run again
        atexit.register(unseal, dest)
    GATE_COPIES[dest] = written
    return dest, ""


# The gate copies extract() wrote in this process: dest -> {path: sha256 of BASE's blob}.
# The branch's tests run as the operator's uid, so a copy they can reach they can also
# chmod and rewrite (ISSUE(security-audit-2026-09-27-daily-2026-09-27)). So the copy is
# read-only from the moment it is written, and before anything runs from it again --
# after the tests, and before the finish -- gate_copy_refusal() holds it to exactly what
# extract() wrote. finish-worktree.sh then checks it again, blob by blob, against BASE.
GATE_COPIES = {}


def seal(dest):
    """Every file and directory under dest loses its write bits: files 0444 (0555 with the
    exec bit), directories 0555, the deepest first."""
    for root, dirs, files in os.walk(dest, topdown=False):
        for name in files:
            p = os.path.join(root, name)
            os.chmod(p, 0o555 if os.lstat(p).st_mode & 0o100 else 0o444)
        os.chmod(root, 0o555)


def unseal(dest):
    """Give this uid back the write bit on every directory under dest, so it can be removed.
    Never through a link."""
    if os.path.islink(dest) or not os.path.isdir(dest):
        return
    for root, dirs, files in os.walk(dest):
        try:
            os.chmod(root, 0o700)
        except OSError:
            pass


def gate_copy_refusal(dest):
    """Why the gate copy in dest is no longer what extract() wrote, or "" when it is.

    Every entry must be this uid's, writable by nobody, and a directory or a regular file;
    the files must be exactly the ones extract() wrote, each with the bytes of BASE's blob.
    A copy any test could have opened up, planted a file in or rewritten is refused by name:
    nothing in it runs again."""
    want = GATE_COPIES.get(dest)
    if want is None:
        return "the gate copy %s is not one this landing extracted" % dest

    def changed(what):
        return ("the gate copy %s was changed after it was extracted (%s); a branch test could "
                "have written it, so nothing in it runs" % (dest, what))

    uid = os.getuid()
    seen = set()
    stack = [""]
    while stack:
        rel = stack.pop()
        path = os.path.join(dest, *rel.split("/")) if rel else dest
        try:
            st = os.lstat(path)
        except OSError as e:
            return changed("%s cannot be read: %s" % (path, e.strerror or type(e).__name__))
        if st.st_uid != uid:
            return changed("%s is owned by uid %d" % (path, st.st_uid))
        if st.st_mode & 0o222:
            return changed("%s is writable, mode %o" % (path, stat.S_IMODE(st.st_mode)))
        if stat.S_ISDIR(st.st_mode):
            try:
                names = os.listdir(path)
            except OSError as e:
                return changed("%s cannot be listed: %s" % (path, e.strerror or type(e).__name__))
            stack.extend(rel + "/" + n if rel else n for n in names)
        elif stat.S_ISREG(st.st_mode):
            if rel not in want:
                return changed("%s is no file of BASE's gate" % path)
            try:
                fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | os.O_NONBLOCK)
                try:
                    digest = hashlib.sha256()
                    while True:
                        chunk = os.read(fd, 1 << 16)
                        if not chunk:
                            break
                        digest.update(chunk)
                finally:
                    os.close(fd)
            except OSError as e:
                return changed("%s cannot be read: %s" % (path, e.strerror or type(e).__name__))
            if digest.hexdigest() != want[rel]:
                return changed("%s is not BASE's blob" % path)
            seen.add(rel)
        else:
            return changed("%s is neither a directory nor a regular file" % path)
    gone = sorted(set(want) - seen)
    if gone:
        return changed("%s is missing" % os.path.join(dest, gone[0]))
    return ""


def write_json(path, obj):
    tmp = path + ".tmp"
    if os.path.lexists(tmp):
        os.unlink(tmp)
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)
        fh.write("\n")
    os.replace(tmp, path)


def remote_gate_mode():
    """off, all, or when-busy. A missing file, a symlink, or any other word is off.

    Off is today's landing: this function reads one file and starts nothing. The
    gate tool runs only when the word is all or when-busy."""
    path = os.environ.get("APPL_MACHINE_CONFIG") or ""
    if not path:
        home = os.environ.get("HOME") or ""
        if not home:
            return "off"
        path = os.path.join(home, ".config", "appl", "machine.toml")
    if os.path.islink(path) or not os.path.isfile(path):
        return "off"
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | os.O_NONBLOCK)
    except OSError:
        return "off"
    try:
        raw = os.read(fd, 1 << 16)
    finally:
        os.close(fd)
    try:
        text = raw.decode("utf-8")
    except UnicodeError:
        return "off"
    in_gate = False
    found = ""
    for line in text.splitlines():
        s = line.split("#", 1)[0].strip()
        if not s:
            continue
        if s.startswith("["):
            in_gate = s == "[gate]"
            continue
        if not in_gate or "=" not in s:
            continue
        key, value = s.split("=", 1)
        if key.strip() != "remote":
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        found = value
    if found in ("all", "when-busy"):
        return found
    return "off"


def remote_gate_receipt(dest, tip, wall, mode, worktree, base, branch):
    """The runner JSON a verified receipt stands in for, or ("local", "") to run here.

    ("refuse", reason) is a bad receipt under a remote mode: the landing does not
    fall through to a local run that would hide it. BASE without the tool runs
    the tests here, the same as a landing from before this hook. The receipt is
    bound to the branch worktree, and to this landing's base and branch."""
    tool = os.path.join(dest, "tools", "remote_gate.py")
    if os.path.islink(tool) or not os.path.isfile(tool):
        log(wall, "land: [gate] remote=%s but BASE has no tools/remote_gate.py; tests run here" % mode)
        return ("local", "")
    argv = [sys.executable, "-I", "-B", tool, "accept", "--tip", tip, "--base", base,
            "--branch", branch, "--mode", mode, "--json", "--repo-dir", worktree]
    node = os.environ.get("MURETAI_NODE") or ""
    if node:
        argv += ["--node", node]
    state = os.environ.get("APPL_REMOTE_GATE_STATE") or ""
    if state:
        argv += ["--state", state]
    receipt = os.environ.get("APPL_REMOTE_GATE_RECEIPT") or ""
    if receipt:
        argv += ["--receipt", receipt]
    proc = subprocess.run(argv, cwd=dest, env=dict(os.environ), stdin=subprocess.DEVNULL,
                          capture_output=True)
    if proc.returncode == 2:
        return ("local", "")
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        reason = err[-1] if err else "remote-gate: receipt refused"
        return ("refuse", " ".join(reason.split()))
    return ("ok", proc.stdout.decode("utf-8", "replace"))


def main(argv):
    drop_repo_git_env(os.environ)
    if argv[1:2] == ["--repair"]:
        if len(argv) < 4:
            say("land: a repair needs the spawn record and a reason")
            return 1
        return repair(argv[2], argv[3])
    # A test option (--affected, a tests/ path, anything after the record) is refused
    # by name before a lock, a test, or a push. --repair is the only other form.
    if len(argv) > 2:
        say("land: refusing %s: a test option is not taken" % " ".join(argv[2:]))
        return 1
    runjson = runjson_of(argv)
    if not runjson or os.path.islink(runjson) or not os.path.isfile(runjson):
        say("land: the spawn record is not a regular file")
        return 1
    try:
        cfg = json.load(open(runjson, encoding="utf-8"))
    except (OSError, ValueError):
        return fail(runjson, "the spawn record is not JSON")
    if not isinstance(cfg, dict):
        return fail(runjson, "the spawn record is not a record")
    rec = record_of(cfg)
    wall = wall_of(runjson)
    common = rec.get("common_dir") or ""
    gitdir = rec.get("worktree_gitdir") or ""
    worktree = rec.get("worktree") or ""
    branch = rec.get("branch") or ""
    branch_ref = rec.get("branch_ref") or ""
    base_sha = rec.get("base_sha") or ""
    base_ref = rec.get("base_ref") or "main"
    primary = rec.get("primary") or ""
    for label, value in (("common dir", common), ("worktree", worktree), ("git dir", gitdir),
                         ("branch", branch), ("base", base_sha)):
        if not isinstance(value, str) or not value:
            return fail(runjson, "the spawn record has no " + label)
    if os.path.realpath(worktree) != worktree or gitdir_of(worktree) != os.path.realpath(gitdir):
        return fail(runjson, "the worktree does not point at the git dir recorded at spawn")
    swapped, pinned_common = commondir_refusal(gitdir, common, primary)
    if swapped:
        return fail(runjson, swapped)
    if not listed(common, worktree):
        return fail(runjson, "the worktree is not in the recorded repository")
    tip = git(common, "rev-parse", "--verify", "--quiet", branch_ref + "^{commit}").stdout.strip()
    if not tip:
        return fail(runjson, "the recorded branch has no commit")
    if git(common, "merge-base", "--is-ancestor", base_sha, tip).returncode != 0:
        main_now = git(common, "rev-parse", "--verify", "--quiet",
                       "refs/heads/" + base_ref + "^{commit}").stdout.strip()
        return fail(runjson, "the branch tip %s is not a descendant of %s %s "
                    "(recorded base %s)" % (tip, base_ref, main_now or base_sha, base_sha))
    # BASE as this landing starts: the receipt's range begins here, never at the recorded
    # base, whose range may hold commits other sessions landed since the spawn.
    base_before = git(common, "rev-parse", "--verify", "--quiet",
                      "refs/heads/" + base_ref + "^{commit}").stdout.strip()
    if not base_before:
        return fail(runjson, "the recorded base branch has no commit")
    # Nothing of the worker's own would land when every recorded commit is already
    # equivalent on BASE (`git cherry` lists no `+`): finish-worktree.sh would answer
    # `already contained` with MERGED=yes, and a receipt over BASE's head would book other
    # sessions' commits as this worker's (ISSUE(security-audit-2026-09-28-daily-2026-09-28-4)).
    # Refused here, before finish runs, so no MERGED=yes line reaches the worker.
    cherry = git(common, "cherry", "refs/heads/" + base_ref, tip, base_sha)
    if cherry.returncode != 0:
        return fail(runjson, "git cherry over the recorded commits failed")
    if not any(line.startswith("+") for line in cherry.stdout.splitlines()):
        return fail(runjson, "nothing of the worker's own work would land: every recorded commit "
                             "is already equivalent on " + base_ref)
    # The gate copy is BASE as this landing starts, not the recorded base: a worker spawned
    # before a gate change lands under the gate BASE holds now. base_sha still bounds the
    # ancestor check, the cherry checks and the affected range. A BASE that shadows a gate
    # module (or a stdlib name the gate imports) is refused first, by name, so nothing of it
    # is extracted -- except for the shadows this branch deletes, which the merge takes out.
    # The branch's tip is checked the same way, so the landing that INTRODUCES a shadow is
    # the one refused, not every landing after it.
    deleted = deleted_by_branch(common, base_before, tip)
    shadowed = shadow_refusal(common, base_before, "BASE", deleted)
    if shadowed:
        return fail(runjson, shadowed)
    shadowed = shadow_refusal(common, tip, "the branch's tip")
    if shadowed:
        return fail(runjson, shadowed)
    # A consumer that pins an installed skill vendors none: BASE's tip carries no skill, and
    # finish-worktree.sh runs from the scripts dir recorded at spawn instead of the gate copy.
    installed = installed_scripts(cfg, primary)
    if installed:
        if os.path.islink(installed) or not os.path.isdir(installed):
            return fail(runjson, "the recorded scripts dir %s is not a directory" % installed)
    INSTALLED[0] = installed
    dest, why = extract(common, base_before, wall, deleted, need_skill=not installed)
    if why:
        return fail(runjson, why)
    if not dest:
        return fail(runjson, "BASE's skill scripts are not in the recorded commit")
    # The fast lane is granted here, from the spawn record a worker cannot write, and only for
    # the exact string `fast`. A fast-lane diff that reaches any path outside the fast units is
    # refused by name before any test or finish runs, so the item goes the normal way. A
    # landing without the fast lane is never refused for this.
    if rec.get("lane") == "fast":
        errors = fast_lane_map_error(common, dest, wall, base_before, tip)
        if errors:
            for line in errors:
                say("land: " + line)
            return fail(runjson, "fast-lane map error: the branch reaches %d path(s) outside the "
                                 "fast units; the item goes the normal way, not the fast lane"
                        % len(errors))
    env ={k: v for k, v in os.environ.items() if not k.startswith("HERD_GATE_")}
    env.pop("ISO_FINISH_TESTS_RECEIPT", None)
    env.pop("ISO_FINISH_WALLS_DIR", None)
    # Outside the wall, as the operator's landing: no plug, no profile. `--gate` keeps the
    # runner honest if this launcher was itself started behind a wall: then a suite the
    # room refused is could-not-run, never a red on the diff and never a pass.
    # A BASE without a runner (extract() already refused one that is not a regular blob)
    # runs no tests here: finish-worktree.sh finds no runner in the gate copy and says
    # TESTS=none, exactly as an operator's landing does. The worktree's runner never runs.
    runner = os.path.join(dest, "tools", "run_tests.py")
    runner_path = ""
    runner_err = b""
    refused = slot_dir_refusal(dest)
    if refused:
        return fail(runjson, refused)
    # This run is a pre-run to the gate pool, ranked as finish-worktree.sh ranks its own.
    # BASE's runner text decides which of three kinds it is:
    #  - it names --gate-phase: phase pre-run, the branch as holder, and --gate-nowait, so it
    #    never queues for a slot and never barges past an in-lock waiter (tools/gate_slots.py,
    #    THE ORDER); a nowait exit 3 skips the pre-run and finish tests the branch
    #  - it names --gate alone: a slot-pool runner that cannot declare a phase would take a
    #    free slot unranked, so it is not started here; finish's own phased pre-run judges
    #  - it names neither: it takes no slot, so it runs as it always did, with the old argv
    has_runner = os.path.isfile(runner) and not os.path.islink(runner)
    runner_text = b""
    if has_runner:
        try:
            with open(runner, "rb") as fh:
                runner_text = fh.read()
        except OSError:
            runner_text = b""
    gate_phase_ok = b"--gate-phase" in runner_text
    # --gate not followed by - or a word character, so --gate-phase and the like do not count
    gate_pool = re.search(rb"--gate(?![-\w])", runner_text) is not None
    remote_taken = False
    mode = remote_gate_mode()
    if mode != "off":
        decided = remote_gate_receipt(dest, tip, wall, mode, worktree, base=base_before, branch=branch)
        if decided[0] == "refuse":
            return fail(runjson, decided[1])
        if decided[0] == "ok":
            runner_path = os.path.join(wall, "tests-runner.json")
            with open(runner_path, "w", encoding="utf-8") as fh:
                fh.write(decided[1])
            write_json(os.path.join(wall, "tests.json"), {"rc": 0})
            log(wall, "land: accepted a remote gate receipt for %s; the tests were not re-run here"
                % branch)
            remote_taken = True
    if remote_taken:
        pass
    elif has_runner and gate_pool and not gate_phase_ok:
        log(wall, "land: BASE's tools/run_tests.py takes a gate slot but predates --gate-phase, "
                  "so the landing of %s runs no pre-run here; finish-worktree.sh runs the tests"
            % branch)
    elif has_runner:
        probe = nest_probe()
        where = ("outside every wall" if probe in ("ok", "n/a")
                 else "INSIDE a wall this launcher was started in, so the room's refusals are could-not-run")
        log(wall, "land: the landing of %s runs its tests in pid=%d (parent pid=%d, the launcher), "
                  "%s; nested sandbox-exec from here: %s"
            % (branch, os.getpid(), os.getppid(), where, probe))
        # stderr stays bytes. text=True would turn a bare CR into LF before it could
        # be neutralised, and the block below is printed only after the verdict.
        # The files run in a disposable shared clone of BASE at the branch tip, never
        # in the worktree. The clone is removed on a green run and on a red one.
        prepared, why = sandbox_prepare(dest, worktree, env)
        if why:
            say(why)
            return fail(runjson, "the disposable clone could not be created")
        parent, clone = prepared
        argv = [sys.executable, "-I", "-B", runner, "--root", clone, "--affected", base_sha + ".." + tip,
                "--gate", "--json"]
        # As finish-worktree.sh: -j only when the operator set one; else the machine file's count.
        if env.get("ISOLATED_SESSION_LAND_JOBS"):
            argv += ["-j", env["ISOLATED_SESSION_LAND_JOBS"]]
        if gate_phase_ok:
            argv += ["--gate-phase", "pre-run", "--gate-holder", branch, "--gate-nowait"]
        # The tests ran as this uid: the copy is held to what extract() wrote before its
        # land-sandbox.sh removes the clone, and a copy they changed runs nothing again.
        changed = ""
        try:
            proc = subprocess.run(
                argv, cwd=clone, env=sandbox_test_env(env, parent),
                stdin=subprocess.DEVNULL, capture_output=True)
        finally:
            changed = gate_copy_refusal(dest)
            if not changed:
                sandbox_remove(dest, clone, env)
        if changed:
            return refuse(runjson, changed, proc.stderr)
        if gate_phase_ok and proc.returncode == 3:
            # no slot free at once: nothing ran, so there is no receipt to hand on and no
            # refusal; finish-worktree.sh tests the branch, as after its own skipped pre-run
            log(wall, "land: skipped the pre-run of %s: no gate slot was free at once; "
                      "finish-worktree.sh tests the branch" % branch)
        else:
            runner_err = proc.stderr
            runner_path = os.path.join(wall, "tests-runner.json")
            with open(runner_path, "w", encoding="utf-8") as fh:
                fh.write(runner_stdout_text(proc.stdout))
            write_json(os.path.join(wall, "tests.json"), {"rc": proc.returncode})
            if proc.returncode != 0:
                return refuse(runjson, "the landing tests exited %d" % proc.returncode,
                              runner_err, tests_lines(wall, base_parks(common, base_before)))
    else:
        log(wall, "land: BASE carries no tools/run_tests.py, so the landing of %s runs no tests "
                  "here (TESTS=none, as an operator's landing says it)" % branch)
    scripts = installed or os.path.realpath(os.path.join(dest, SKILL))
    finish = os.path.join(scripts, "finish-worktree.sh")
    if not os.path.isfile(finish) or os.path.islink(finish) or not primary:
        if installed:
            return refuse(runjson, "the recorded scripts dir %s has no finish-worktree.sh" % installed,
                          runner_err)
        return refuse(runjson, "BASE's finish-worktree.sh is not in the recorded commit", runner_err)
    # the last look before the finish runs out of the copy: still exactly BASE's blobs
    changed = gate_copy_refusal(dest)
    if changed:
        return refuse(runjson, changed, runner_err)
    fenv = drop_repo_git_env(dict(env))
    # ORIGIN is the operator's offline break-glass. Only a value already in this
    # process's environment counts: land.sh does not read git config to fill it
    # in, and it does not drop a value the operator set, blank included.
    if "ORIGIN" in os.environ:
        fenv["ORIGIN"] = os.environ["ORIGIN"]
    fenv["ISO_FINISH_GATE_DIR"] = dest
    fenv["ISO_FINISH_GATE_SELF"] = scripts
    # the commit the copy was extracted from: finish checks every file against its blobs
    fenv["ISO_FINISH_GATE_BASE"] = base_before
    if runner_path:
        fenv["ISO_FINISH_TESTS_RECEIPT"] = runner_path
        fenv["ISO_FINISH_WALLS_DIR"] = wall
    # The tip this launcher recorded and tested. finish refuses a branch that no longer
    # equals it before it judges anything; the check after it returns is land's own.
    fenv["ISO_FINISH_EXPECT_TIP"] = tip
    # The dirs checked above, pinned: a commondir swapped after the check is not followed.
    # finish puts them on its first git call only. They travel under names of finish's
    # own, never as GIT_COMMON_DIR or GIT_DIR: an older vendored finish does not clear
    # those, and its dirty-base check would read the branch as changes on the primary.
    fenv["ISO_FINISH_PIN_COMMON_DIR"] = pinned_common
    fenv["ISO_FINISH_PIN_GIT_DIR"] = os.path.realpath(gitdir)
    # BASE as finish starts: what another session landed while the tests above ran was
    # judged by its own landing, so the check after finish reads only what came after it.
    base_at_finish = git(common, "rev-parse", "--verify", "--quiet",
                         "refs/heads/" + base_ref + "^{commit}").stdout.strip()
    landed = subprocess.run(
        ["/bin/bash", finish, branch, worktree], cwd=primary, env=fenv,
        stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace")
    sys.stdout.write(landed.stdout)
    if landed.stderr:
        sys.stderr.write(landed.stderr)
    merged, kind, review, handed = "no", "", "", ""
    saw_merged = False
    for line in landed.stdout.splitlines():
        if line.startswith("MERGED="):
            merged = line.split("=", 1)[1].strip()
            saw_merged = True
        elif line.startswith("MERGE_KIND="):
            kind = line.split("=", 1)[1].strip()
        elif line.startswith("REVIEW="):
            review = line.split("=", 1)[1].strip().split(" ", 1)[0]
        elif line.startswith("HANDED=github"):
            handed = line.split("=", 1)[1].strip()
    # A gate = "github" hand-off is a success that leaves BASE alone: finish printed one
    # HANDED=github line and no MERGED=yes, and exited 0. Nothing landed here, so there is
    # no landing receipt, no main verdict and no repair ask.
    if landed.returncode == 0 and handed and merged != "yes":
        log(wall, "land: %s handed off: %s; %s was not merged into" % (branch, handed, base_ref))
        emit_runner_stderr(runner_err)
        return 0
    if landed.returncode != 0 or merged != "yes":
        # finish already printed MERGED=no with the reason. A second one makes the
        # receipt look like two refusals. Keep land's own line and the repair ask.
        if saw_merged and merged == "no":
            say("land: the landing did not fast-forward the recorded base")
            repair(runjson, "the landing did not fast-forward the recorded base")
            emit_runner_stderr(runner_err)
            return 1
        return refuse(runjson, "the landing did not fast-forward the recorded base", runner_err)

    # finish printed MERGED=yes, and it is the receipt's one MERGED= line: what land refuses
    # from here gets its own words and the repair ask, never a second MERGED=no.
    def refuse_landed(reason):
        say("land: " + " ".join(str(reason).split()))
        repair(runjson, reason)
        emit_runner_stderr(runner_err)
        return 1

    if kind == "already":
        # BASE moved under the landing and took every recorded commit's equivalent first
        return refuse_landed("MERGE_KIND=already refused: nothing of the worker's own work landed")
    base_tip = git(common, "rev-parse", "--verify", "--quiet",
                   "refs/heads/" + base_ref + "^{commit}").stdout.strip()
    if (not base_tip or base_tip == base_before
            or git(common, "merge-base", "--is-ancestor", base_before, base_tip).returncode != 0):
        return refuse_landed("the landing did not move the recorded base past where it started")
    # finish-worktree.sh REBASES a branch whose base moved before it fast-forwards, so the
    # commits that landed may be copies of the recorded ones and the recorded tip on no base.
    # A reviewer's receipt branch always starts at the BASE it reviewed, behind the tip main
    # already holds, so its landing always takes this path. The landing counts when every
    # recorded commit's patch is on the base now (`git cherry` lists none as missing).
    if git(common, "merge-base", "--is-ancestor", tip, base_tip).returncode != 0:
        cherry = git(common, "cherry", base_tip, tip, base_sha)
        if cherry.returncode != 0 or any(line.startswith("+") for line in cherry.stdout.splitlines()):
            return refuse_landed("the landing did not fast-forward the recorded base")
    # Nothing of the branch beyond the recorded tip landed. The branch ref is the worker's
    # to move, so one moved to an unscanned child after this launcher recorded and tested
    # the tip used to land under the receipt and be noted as branch_tip
    # (ISSUE(security-audit-2026-10-10-pin-gate-file-review-497f)). Every commit the landing
    # added that the recorded tip does not hold must be a rebased copy of a recorded commit,
    # finish's own ledger-regeneration commit, or a merge (of the tip with BASE's commits,
    # which BASE already held or which are judged here one by one). `git cherry` lists
    # non-merges only, `+` for a patch no recorded commit carries. The range starts where
    # BASE was as finish started, when that is still under BASE's tip, or where finish's
    # BASE_FF took it from origin: those commits were already on main before the merge, judged
    # by their own landing, and finish held its merge to the recorded tip before main moved.
    since = base_before

    def later_since(rev):
        return (rev and rev != base_tip
                and git(common, "merge-base", "--is-ancestor", since, rev).returncode == 0
                and git(common, "merge-base", "--is-ancestor", rev, base_tip).returncode == 0)

    if later_since(base_at_finish):
        since = base_at_finish
    for line in landed.stdout.splitlines():
        ff = re.match(r"BASE_FF=\d+ commit\(s\) from \S+ \(([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\)", line)
        if ff:
            ff_to = git(common, "rev-parse", "--verify", "--quiet", ff.group(2) + "^{commit}").stdout.strip()
            if later_since(ff_to):
                since = ff_to
    beyond = git(common, "cherry", tip, base_tip, since)
    if beyond.returncode != 0:
        return refuse_landed("git cherry over the landed commits failed")
    # finish's ledger commit is known by its subject, which anyone can write, so it counts
    # only once, and only straight on top of the recorded tip or a rebased copy of it.
    ledger_subject = "ledger: regenerate on landing " + branch

    def patch_of(rev):
        diff = git(common, "diff-tree", "-p", "--no-commit-id", rev).stdout
        pid = subprocess.run(["git", "--git-dir", common, "patch-id", "--stable"],
                             input=diff, capture_output=True, text=True).stdout.split()
        return pid[0] if pid else ""

    tip_patch = patch_of(tip)
    ledger_seen = False
    for line in beyond.stdout.splitlines():
        if not line.startswith("+"):
            continue
        sha = line[1:].strip()
        subject = git(common, "log", "-1", "--format=%s", sha).stdout.rstrip("\n")
        parents = git(common, "rev-list", "--parents", "-n", "1", sha).stdout.split()[1:]
        if (subject == ledger_subject and not ledger_seen and len(parents) == 1
                and (parents[0] == tip or (tip_patch and patch_of(parents[0]) == tip_patch))):
            ledger_seen = True
            continue
        say("land: %s landed commit %s, beyond the recorded tip %s: the branch moved after "
            "the tip was recorded and tested" % (branch, sha[:12], tip[:12]))
        return refuse_landed("the landing carries commit %s of %s beyond the recorded tip %s, "
                             "which no test or scan judged" % (sha[:12], branch, tip[:12]))
    # The landing's OWN range: BASE when it started .. BASE after it. At least one recorded
    # commit was missing from BASE at the start and all are on it now, so that range holds
    # the worker's work.
    receipt = {"base_sha": base_before, "tip": base_tip, "review": review or "none", "merged": "yes"}
    if base_tip != tip:
        receipt["branch_tip"] = tip
    write_json(os.path.join(wall, "landing-receipt.json"), receipt)
    start_main_verdict(dest, primary, wall, env)
    emit_runner_stderr(runner_err)
    return 0


def start_main_verdict(dest, primary, wall, env):
    """Main moved: start the one whole-suite gate run of the landed tip (intake
    20261030T141936Z), detached, from BASE's copy of the tool in the gate copy, with its
    output in <state>/main-verdict.log. <state> is $HERD_DIR/coordinator/main-verdicts/<the
    primary's name>. Never waited on, and nothing it does decides this landing. A BASE
    without the tool, or a throwaway primary (throwaway()), starts none. The run's HERD_DIR is
    the herd directory, the wall's grandparent, whatever env holds (intake 20261031T072745Z);
    with no herd directory to derive, none starts."""
    try:
        repo = os.path.realpath(primary) if primary else ""
        name = os.path.basename(repo)
        herd = os.path.dirname(os.path.dirname(wall)) if wall else ""
        state = os.path.join(herd, "coordinator", "main-verdicts", name)
        tool = os.path.join(dest, "tools", "main_verdict.py")
        argv = [sys.executable, "-I", "-B", tool, "receipt",
                os.path.join(wall, "landing-receipt.json"), "--repo", repo, "--state", state]
        if (not repo or not herd or not os.path.isabs(herd) or not os.path.isdir(herd)
                or os.path.islink(tool) or not os.path.isfile(tool) or throwaway(repo)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name)):
            return
        env = dict(os.environ if env is None else env)
        env["HERD_DIR"] = herd
        os.makedirs(state, mode=0o700, exist_ok=True)
        fd = os.open(os.path.join(state, "main-verdict.log"),
                     os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            subprocess.Popen(argv, cwd=state, env=env, stdin=subprocess.DEVNULL, stdout=fd,
                             stderr=fd, start_new_session=True, close_fds=True)
        finally:
            os.close(fd)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass


def throwaway(path):
    """True when path is under a temp directory or the test cache ($MURETAI_TEST_CACHE,
    default ~/.cache/muretai-tests), where fixtures live and no real primary does."""
    roots = {tempfile.gettempdir(), os.environ.get("TMPDIR") or "", "/tmp", "/var/tmp",
             "/private/tmp", "/var/folders", "/private/var/folders",
             os.environ.get("MURETAI_TEST_CACHE") or "",
             os.path.join(os.path.expanduser("~"), ".cache", "muretai-tests")}
    for root in filter(None, roots):
        root = os.path.realpath(root).rstrip(os.sep)
        if root and (path == root or path.startswith(root + os.sep)):
            return True
    return False


sys.exit(main(sys.argv))
PY
