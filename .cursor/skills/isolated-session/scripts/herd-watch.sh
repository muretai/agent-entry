#!/usr/bin/env bash
# herd-watch: the coordinator's eyes on its herd -- one line per event: worker status
# changes, reports written, approval prompts answered or handed up, and stalled workers
# resumed.
#
#   herd-watch.sh [--notify NAME]                   loop: one pass every 20 s, forever
#   herd-watch.sh once [--notify NAME]              one pass, no sleep, exit 0
#   herd-watch.sh verdict <worker> [--worktree P]   pane text on stdin -> one line:
#                                                   `SAFE <cmd>` (exit 0), `BLOCKED <what>`
#                                                   (exit 1) or `NOPROMPT` (exit 2);
#                                                   never calls herdr
#
# --notify NAME: every REPORT:/PROMPT:/RESUMED:/STUCK: line a pass prints is ALSO sent,
# verbatim and once, as `herdr agent prompt NAME "<that line>"` -- how the coordinator
# pane (`muretai-coordinator`, briefs/coordinator.md) hears its herd without polling.
# WORKERS: and APPROVED: are not sent: one is a roll call, the other already handled.
# The lines are the fixed vocabulary below, so what the pane is typed is a name and a
# state, never pane text. NAME must be an agent name ([a-z][a-z0-9_-], at most 32) or
# the call is exit 2 before herdr is asked anything. A prompt that fails (the pane is
# down) is ignored: the pass goes on, and the line still reaches stdout.
#
# Who is watched is re-derived on EVERY pass: each agent in `herdr agent list` with a
# worker name, other than the --notify target, whose <HERD_DIR>/<name>/permissions.json
# exists and is not a symlink (herd-spawn wrote it), united with WORKERS. A worker spawned
# after the watcher started is picked up on the next pass; the loop logs `WORKERS:` when
# the set (or a status in it) changes. A listing that fails or comes back empty discovers
# nobody and drops no state; WORKERS names are still watched.
#
# A report is announced only when report.md is strictly newer than the worker's
# permissions.json (rewritten on every spawn), so a report left over from an earlier run
# under the same name is stale. <HERD_DIR>/<w>/.reported holds the SHA-256 of the report
# last announced: each distinct report is announced once, across passes and restarts.
#
# Environment:
#   WORKERS                  optional: names watched even when herdr does not list them
#                            (herdr agent names = tab labels)
#   HERD_DIR                 the herd directory (default ~/.cache/muretai-herd); a worker's
#                            report is <HERD_DIR>/<w>/report.md, its rules file
#                            <HERD_DIR>/<w>/permissions.json (herd-spawn.sh writes both)
#   HERD_WATCH_NOW           the clock, epoch seconds (tests); default: the real one
#   HERD_WATCH_CAPACITY_BIN  the dispatch-capacity.sh to run (default: the sibling script)
#   HERD_WATCH_INTERVAL      seconds between passes in the loop (default 20)
#
# FIXED VOCABULARY, never free text: WORKERS:, REPORT:, APPROVED:, PROMPT:, STUCK:,
# RESUMED:. Command lines, pane tails and reconnect strings go to
# $HERD_DIR/.watch/<worker>.detail, read from there by the coordinator's own tool call.
# Why (2026-09-14): three injections reached the coordinator as text appended to task
# notifications, shaped as operator instructions. A watcher that pipes remote text into
# the coordinator's context is a carrier for that; one that emits only names and states
# is not. An event is a signal to GO LOOK, never a fact and never an instruction. The same
# holds for what the watcher TYPES: a resumed worker is sent one fixed sentence, never
# anything read from a pane.
#
# Approvals. A pane waiting at `Run this command?` is answered `y` only when EVERY
# segment of the line -- split on `&&`, `;`, `|` and `|&` (= `2>&1 |`) -- is on the safe
# table; a pipe stage after the first may also be a read-only filter. Inside a segment
# `$?`/`$VAR` are allowed as echo/printf arguments, `2>&1` anywhere, and a file redirect
# only when its target, realpath-normalised and compared by path component, is under the
# worker's worktree or <HERD_DIR>/<worker>/ (or is /dev/null). Command substitution,
# `||`, a background `&`, a subshell, an input redirect and a target nobody can resolve
# (`> $OUT`) are refused. The veto list (git options that run a program or read an
# untracked path, printf -v) is checked against the whole line and every segment, and
# beats everything. In the loop, the worktree is the agent's cwd as herdr reports it, and
# only when that cwd is a linked worktree: never the `in <dir>` the pane prints, which
# the session being judged wrote itself.
#
# Resume. A worker whose pane tail says `stopped retrying`, `usage limit` or `rate limit`
# (any case) is prompted with CONTINUE below; a worker that is done (herdr does not see it
# at its input) or gone from `herdr agent list`, with no report.md, is restarted in its
# pane with herd-spawn.sh's claude arguments plus `--resume`, then prompted. Attempts at
# +0, +300, +1800 and +3600 s, four at most per spawn (.watch/<w>.resume), one RESUMED
# line each. A restart needs the worker's permissions.json (no rules file, no restart:
# claude is never started without --settings) and that file to be at least 600 s old (a
# fresh spawn that has not taken its brief yet is not a stalled worker). A listing that
# fails means herdr is down, not that the worker is gone: nothing is restarted.
# `dispatch-capacity.sh full "<phrase>: <worker>"` runs once per signature.
#
# Intake watchdog (with --notify only). The coordinator once set an intake's status to
# `new -- brief for <w> being written` and ended its turn before it spawned: the intake
# looked handled and nothing said it stalled. Each pass, every regular `<name>.md` directly
# under <HERD_DIR>/coordinator/intake/ (name by appl-hook's rule; no symlink, no subdir)
# whose HEADER `status:` names no agent in `herdr agent list`, whose first status word is
# not done/landed/SUPERSEDED/blocked/question, and whose mtime is more than 300 s old is
# typed into the NAME pane as `intake <path>` -- the bytes tools/appl-add.sh sends -- and
# logged `<UTC time> reprompt <file name>` in <HERD_DIR>/coordinator/coordinator.log. At
# most once per 300 s per (intake, mtime), state in .watch/intakes.json; an edit restarts
# the grace period. A failed agent listing judges nobody live: nothing is typed. Only the
# file name ever leaves an intake; the watchdog never edits one, spawns or closes a tab.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
export HERD_WATCH_HERE="$here"

# The program is held in a variable, not piped in, so stdin stays free for `verdict`'s pane
# text; `read -d ''` rather than `$(cat <<...)`, which bash 3.2 mis-parses on a quote or a
# parenthesis inside the here-document. read returns 1 at the end of input, by design.
IFS= read -r -d '' HERD_WATCH_PY <<'PY'
import hashlib, json, os, re, stat, subprocess, sys, time, unicodedata

CONTINUE = "Continue from your last saved state; same report.md."
PHRASES = ("stopped retrying", "usage limit", "rate limit")
DELAYS = (0, 300, 1800, 3600)      # wait before attempt 1..4, from the attempt before it
YOUNG = 600                        # a rules file younger than this is a fresh spawn
NAME_RE = re.compile(r"[a-z][a-z0-9_-]{0,31}")
PANE_RE = re.compile(r"[A-Za-z0-9:_.-]{1,64}")
HOME = os.environ.get("HOME", "")
H = re.escape(HOME) if HOME else r"(?!x)x"

NON_SHELL = ("Write to this file?", "Delete this file?", "Allow this web fetch?",
             "Allow this web search?", "Run this MCP tool?", "Delete this file")

READERS = [
    r"rg( .*)?", r"grep( .*)?", r"sort( .*)?", r"uniq( -[A-Za-z]+)*", r"wc( .*)?",
    r"head( .*)?", r"tail( .*)?", r"cut( .*)?", r"sed -n [0-9]+(,([0-9]+|\$))?p",
]
# options that turn a reader into a writer or a runner
READER_VETO = [r"^rg\b.*\s--pre", r"^sort\b.*\s(-[A-Za-z]*o|--o|--comp)"]
SAFE = [
    r"python3 test_[A-Za-z0-9_]+\.py( .*)?",
    r"python3 tests/test_[A-Za-z0-9_]+\.py( .*)?",
    r"python3 tools/test_[A-Za-z0-9_]+\.py( .*)?",
    r"python3 tools/check\.py( .*)?",
    r"((AGENTNET_IROH_REQUIRE=1|MURETAI_IROH_PYTHON=" + H + r"/\.cache/muretai-tests/iroh-venv/bin/python) )*("
    + H + r"/\.cache/muretai-tests/iroh-venv/bin/python|python3) (test_[A-Za-z0-9_]+\.py|tools/iroh_offline_canary\.py)( .*)?",
    r"python3 \.claude/skills/contract-test/scripts/(check_test_provenance|mutate)\.py .*",
    r"flyctl (auth whoami|apps list|ips list|secrets list|certs list|status|releases|machine list|machines list|logs|version)( .*)?",
    r"mkdir -p (~|\$HOME)/\.cache/muretai-tests/[A-Za-z0-9_.-]+",
    r"([A-Z_]+=[^ ]+ )*(~|\$HOME|" + H + r")/\.cache/muretai-tests/iroh-venv/bin/python3? (operator_cli\.py|agent_mcp\.py|tools/[A-Za-z0-9_]+\.py|test_[A-Za-z0-9_]+\.py|-m [a-z_.]+)( .*)?",
    r"([A-Z_]+=[^ ]+ )*python3 (operator_cli\.py|tools/[A-Za-z0-9_]+\.py) (transport|doctor|--as [A-Za-z0-9_-]+ (transport|doctor|wake status))( .*)?",
    r"ls -la? .*",
    r"export ([A-Z_]+=[^ ]+ ?)+",
    r"echo( .*)?",
    r"cat [A-Za-z0-9_./-]+",
    r"head -[0-9]+ [A-Za-z0-9_./-]+",
    r"(GIT_EDITOR=true )?git rebase( --continue| main)",
    r"git add [A-Za-z0-9_./ -]+",
    r"git mv (-k )?(test_[A-Za-z0-9_*]+\.py |tests/[A-Za-z0-9_./*-]+ )+tests/?[A-Za-z0-9_./-]*",
    r"mkdir -p tests/?[A-Za-z0-9_./-]*",
    r"ls( -[A-Za-z]+)* tests/?[A-Za-z0-9_./*-]*",
    r"git restore( --)? [A-Za-z0-9_./ -]+",
    r"git commit .*",
    r"herdr (tab list|agent list|pane list|api schema|--version|--help)( .*)?",
    r"herdr agent (read|prompt|send-keys|wait) --help",
    r"ps -o [A-Za-z=,]+ -ax",
    r"python3 tools/(run_tests|ledger|affected_tests|spec_build|audit_scope|sec_lint)\.py( .*)?",
    r"python3 -m agent\.plugins( .*)?",
    r"git (grep|ls-files|blame|log|show|diff|status|rev-parse|rev-list|merge-base|worktree list)( .*)?",
    r"printf( .*)?",
    r"git branch( --list| -a| -v| --show-current)?( [A-Za-z0-9_./-]+)?",
    r"npm (test|run [A-Za-z0-9:_-]+)( --.*)?",
    r"bash \.cursor/skills/isolated-session/scripts/(assert-head|stale|claim-worktree)\.sh( .*)?",
    r"bash \.cursor/skills/isolated-session/scripts/finish-worktree\.sh [A-Za-z0-9_./-]+ [A-Za-z0-9_./-]+",
    r"ls( -[A-Za-z]+)*( [A-Za-z0-9_./-]+)*",
    r"pwd",
]
# Never auto-approve the git options that run a program or read or write an untracked
# path -- git grep -O/--open-files-in-pager runs a command, git blame --contents reads any
# file the uid can read, --textconv and --ext-diff run a configured filter, --output
# writes anywhere, and the git diff family the 2026-09-13 review closed
# (ISSUE(security-audit-2026-09-14-daily-2026-09-14)). Long options are matched by the
# prefix git itself accepts as an abbreviation (`--open` is `--open-files-in-pager`).
# printf -v assigns a variable (PATH) that a later segment would then run under.
VETO = [
    r"\bgit\b[^|&;]*\bgrep\b[^|&;]*\s-[A-Za-z]*O",
    r"\bgit\b[^|&;]*\bgrep\b[^|&;]*\s--op",
    r"\bgit\b[^|&;]*\bblame\b[^|&;]*\s--con",
    r"\bgit\b[^|&;]*\b(grep|blame|log|show|diff)\b[^|&;]*\s--textc",
    r"\bgit\b[^|&;]*\b(log|show|diff)\b[^|&;]*\s--ext",
    r"\bgit\b[^|&;]*\b(log|show|diff|format-patch|blame)\b[^|&;]*\s--out",
    r"\bgit\b[^|&;]*\bdiff\b[^|&;]*(\s--no-i|/dev/null)",
    r"(^|\s)printf\s+(-\S+\s+)*-v",
]
# an assignment (a prefix or an export) that would change what a later command runs
BAD_ASSIGN = re.compile(r"(PATH|PYTHON[A-Z0-9_]*|GIT_[A-Z0-9_]*|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|BASH_ENV|ENV|"
                        r"BASH_FUNC[A-Za-z0-9_%]*|IFS|PS4|PROMPT_COMMAND|HOME|SHELLOPTS|BASHOPTS|CDPATH|"
                        r"[A-Z0-9_]*PAGER|[A-Z0-9_]*EDITOR|NODE_OPTIONS|PERL5OPT|RUBYOPT)=")


class Refuse(Exception):
    pass


def clean(s, n=400):
    """one line an operator may read: invisible code points spelled out, bounded"""
    out = []
    for ch in s:
        if unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp", "Cs", "Co", "Cn"):
            out.append("\\x%02x" % ord(ch) if ord(ch) < 0x100 else "\\u%04x" % (ord(ch) & 0xFFFF))
        else:
            out.append(ch)
    return "".join(out)[:n]


def herd_dir():
    d = os.environ.get("HERD_DIR") or os.path.join(HOME, ".cache", "muretai-herd")
    return os.path.abspath(d)


def clock():
    try:
        return int(os.environ.get("HERD_WATCH_NOW") or time.time())
    except ValueError:
        return int(time.time())


# ------------------------------------------------------------------ the verdict

def parse_prompt(text):
    """("OTHER", what) | ("NOPROMPT", None) | ("CMD", (cmd, dir))"""
    tail = text[-2500:]
    for kind in NON_SHELL:
        if kind in tail and "Run this command?" not in tail:
            where = ""
            for line in reversed(tail.rsplit(kind, 1)[0].splitlines()):
                if line.strip():
                    where = line.strip()[:160]
                    break
            return "OTHER", kind + " " + where
    if "Run this command?" not in text:
        return "NOPROMPT", None
    before = text.rsplit("Run this command?", 1)[0].splitlines()
    # the command may wrap over several lines: walk back to the `$` line, join what follows
    acc = []
    for line in reversed(before):
        if not line.strip():
            continue
        acc.insert(0, line.strip())
        if re.match(r"^\s*\$\s+", line):
            m = re.match(r"^\$\s+(.*) in (\.|\S+)$", " ".join(acc).strip())
            if m:
                return "CMD", (m.group(1).strip(), m.group(2))
            break
        if len(acc) > 8:
            break
    return "NOPROMPT", None


def lex(cmd):
    """Shell words and operators, quote-aware. Tokens: ("word", value, expands),
    ("op", ;|&&||&), ("redir", op), ("dup", op). Anything this does not model is refused."""
    toks = []
    word, expands, quoted = None, False, False
    i, n = 0, len(cmd)

    def flush():
        nonlocal word, expands, quoted
        if word is not None:
            toks.append(("word", word, expands))
        word, expands, quoted = None, False, False

    while i < n:
        c = cmd[i]
        if c in " \t":
            flush(); i += 1; continue
        if c == "'":
            j = cmd.find("'", i + 1)
            if j < 0:
                raise Refuse("an unbalanced quote")
            word = (word or "") + cmd[i + 1:j]; quoted = True; i = j + 1; continue
        if c == '"':
            j, buf = i + 1, ""
            while j < n and cmd[j] != '"':
                if cmd[j] == "\\" and j + 1 < n and cmd[j + 1] in '"\\$`':
                    buf += cmd[j + 1]; j += 2; continue
                if cmd[j] == "$":
                    expands = True
                buf += cmd[j]; j += 1
            if j >= n:
                raise Refuse("an unbalanced quote")
            word = (word or "") + buf; quoted = True; i = j + 1; continue
        if c == "\\":
            if i + 1 >= n:
                raise Refuse("a trailing backslash")
            word = (word or "") + cmd[i + 1]; quoted = True; i += 2; continue
        if c == "$":
            expands = True
        if c in ";&|<>()":
            fd = ""
            if c == ">" and word is not None and not quoted and word.isdigit():
                fd, word, expands, quoted = word, None, False, False
            else:
                flush()
            if c in "()":
                raise Refuse("a subshell or group")
            if c == "<":
                raise Refuse("an input redirect or here-document")
            if c == ";":
                toks.append(("op", ";")); i += 1; continue
            if c == "|":
                if cmd.startswith("||", i):
                    raise Refuse("`||`")
                if cmd.startswith("|&", i):
                    toks.append(("op", "|&")); i += 2; continue
                toks.append(("op", "|")); i += 1; continue
            if c == "&":
                if cmd.startswith("&&", i):
                    toks.append(("op", "&&")); i += 2; continue
                if cmd.startswith("&>>", i):
                    toks.append(("redir", "&>>")); i += 3; continue
                if cmd.startswith("&>", i):
                    toks.append(("redir", "&>")); i += 2; continue
                raise Refuse("a background `&`")
            op = ">>" if cmd.startswith(">>", i) else ">"
            i += len(op)
            if cmd.startswith("|", i):
                raise Refuse("`>|`")
            if op == ">" and cmd.startswith("&", i):
                i += 1
                m = re.match(r"[0-9]+|-", cmd[i:])
                if m and (i + m.end() >= n or cmd[i + m.end()] in " \t;|&"):
                    toks.append(("dup", (fd or "1") + ">&" + m.group(0))); i += m.end(); continue
                toks.append(("redir", "&>")); continue
            toks.append(("redir", (fd or "1") + op)); continue
        word = (word or "") + c; i += 1
    flush()
    return toks


def pipelines(toks):
    """[[stage, ...], ...] split on `;`/`&&` then `|`/`|&`; a stage is (words, targets)"""
    out, cur = [], []
    words, targets, pending = [], [], None
    for t in toks:
        if pending is not None:
            if t[0] != "word":
                raise Refuse("a redirect without a target")
            targets.append(t); pending = None; continue
        if t[0] == "word":
            words.append(t)
        elif t[0] == "redir":
            pending = t[1]
        elif t[0] == "dup":
            pass                                       # 2>&1, >&2: no file is named
        else:
            cur.append((words, targets)); words, targets = [], []
            if t[1] in (";", "&&"):
                out.append(cur); cur = []
    if pending is not None:
        raise Refuse("a redirect without a target")
    cur.append((words, targets))
    out.append(cur)
    # a trailing `;` leaves one empty pipeline behind; any other empty stage is an error
    if len(out) > 1 and out[-1] == [([], [])]:
        out.pop()
    for p in out:
        for words, targets in p:
            if not words:
                raise Refuse("an empty command")
    return out


def under(path, root):
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def target_ok(tok, roots, cwd):
    value, expands = tok[1], tok[2]
    if expands:
        m = re.fullmatch(r"\$(HOME|\{HOME\})(/[^$]*)?", value)
        if not m or not HOME:
            raise Refuse("a redirect target nobody can resolve")
        value = HOME + (m.group(2) or "")
    elif value == "~" or value.startswith("~/"):
        value = HOME + value[1:]
    if not os.path.isabs(value):
        if not cwd or not os.path.isabs(cwd):
            raise Refuse("a relative redirect target")
        value = os.path.join(cwd, value)
    real = os.path.realpath(value)
    if real == "/dev/null":
        return
    if not any(under(real, r) for r in roots):
        raise Refuse("a redirect outside the worktree and the worker's herd directory")


def stage_text(words):
    for w in words:
        value = w[1]
        if BAD_ASSIGN.match(value) and value != "GIT_EDITOR=true":
            raise Refuse("an assignment to " + value.split("=", 1)[0])
    first = words[0][1]
    for w in words:
        if w[2] and first not in ("echo", "printf") and not re.fullmatch(r"\$(HOME|\{HOME\})(/[^$]*)?", w[1]):
            raise Refuse("an expansion outside echo/printf")
    return " ".join(w[1] for w in words)


def judge(cmd, roots, cwd):
    """raises Refuse, or returns when every segment is safe"""
    if "$(" in cmd or "`" in cmd:
        raise Refuse("command substitution")
    if any(re.search(v, cmd) for v in VETO):
        raise Refuse("a vetoed option")
    ps = pipelines(lex(cmd))
    if sum(len(p) for p in ps) > 8:
        raise Refuse("more than eight segments")
    for p in ps:
        for k, (words, targets) in enumerate(p):
            s = stage_text(words)
            if any(re.search(v, s) for v in VETO):
                raise Refuse("a vetoed option")
            for t in targets:
                target_ok(t, roots, cwd)
            if k == 0:
                if not any(re.fullmatch(r, s) for r in SAFE):
                    raise Refuse("a command not on the safe table")
            elif not any(re.fullmatch(r, s) for r in READERS) or any(re.search(v, s) for v in READER_VETO):
                raise Refuse("a pipe stage that is not a read-only filter")


def roots_for(worker, worktree):
    roots = [os.path.realpath(os.path.join(herd_dir(), worker))]
    if worktree:
        wt = os.path.realpath(worktree)
        if wt not in ("/", os.path.realpath(HOME or "/"), os.path.realpath(herd_dir())):
            roots.append(wt)
    return roots


def verdict(text, worker, worktree):
    """(line, exit status)"""
    kind, what = parse_prompt(text)
    if kind == "OTHER":
        return "BLOCKED " + clean(what), 1, "not a shell prompt"
    if kind == "NOPROMPT":
        return "NOPROMPT", 2, ""
    cmd, cwd = what
    try:
        judge(cmd, roots_for(worker, worktree), cwd if cwd != "." else None)
    except Refuse as e:
        return "BLOCKED " + clean(cmd), 1, str(e)
    return "SAFE " + clean(cmd), 0, ""


def main_verdict(argv):
    if not argv or not NAME_RE.fullmatch(argv[0]):
        print("usage: herd-watch.sh verdict <worker> [--worktree PATH]  (pane text on stdin)", file=sys.stderr)
        return 2
    worker, worktree, rest = argv[0], None, argv[1:]
    while rest:
        if rest[0] == "--worktree" and len(rest) > 1:
            worktree, rest = rest[1], rest[2:]
        else:
            print("herd-watch: unknown argument: " + clean(rest[0], 80), file=sys.stderr)
            return 2
    line, rc, why = verdict(sys.stdin.read(), worker, worktree)
    print(line)
    if why:
        print("herd-watch: " + why, file=sys.stderr)
    return rc


# ------------------------------------------------------------------ one pass

NOTIFIED = ("REPORT:", "PROMPT:", "RESUMED:", "STUCK:")


def emit(line):
    print(line, flush=True)
    target = os.environ.get("HERD_WATCH_NOTIFY", "")
    if target and NAME_RE.fullmatch(target) and line.startswith(NOTIFIED):
        herdr("agent", "prompt", target, line, timeout=30)      # a down pane is not our failure


def herdr(*args, timeout=60):
    try:
        r = subprocess.run(["herdr"] + list(args), capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout
    except (OSError, subprocess.SubprocessError):
        return 1, ""


def listing(kind):
    """the rows of `herdr <kind> list`, or None when herdr did not answer"""
    rc, out = herdr(kind, "list")
    if rc != 0:
        return None
    try:
        rows = json.loads(out).get("result", {}).get(kind + "s")
    except (ValueError, AttributeError):
        return None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else None


def word(v):
    return v if isinstance(v, str) and re.fullmatch(r"[a-z_]{1,20}", v) else "?"


def detail(watch, w, text):
    with open(os.path.join(watch, w + ".detail"), "a", encoding="utf-8") as f:
        f.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + text.replace("\n", " ") + "\n")


def read_file(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def write_file(p, text):
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


def read_pane(w):
    rc, out = herdr("agent", "read", w, "--source", "recent-unwrapped", "--lines", "80")
    if rc != 0:
        rc, out = herdr("agent", "read", w)
    return out if rc == 0 else ""


def linked_worktree(agent):
    """the agent's cwd as herdr reports it, when that is a linked worktree"""
    cwd = (agent or {}).get("cwd")
    if isinstance(cwd, str) and os.path.isabs(cwd) and os.path.isfile(os.path.join(cwd, ".git")):
        return cwd
    return None


def approve(w, agent, watch):
    pane = read_pane(w)
    line, _, why = verdict(pane, w, linked_worktree(agent))
    last = os.path.join(watch, w + ".last")
    if line.startswith("SAFE "):
        detail(watch, w, line)
        if herdr("agent", "send-keys", w, "y")[0] == 0:
            emit("APPROVED: %s (detail in .watch/%s.detail)" % (w, w))
            if os.path.exists(last):
                os.unlink(last)
    elif line.startswith("BLOCKED "):
        key = line[len("BLOCKED "):]
        if key != read_file(last):
            detail(watch, w, line + ("  [" + why + "]" if why else ""))
            emit("PROMPT: %s is waiting -- read the pane yourself before answering" % w)
            write_file(last, key)
    elif read_file(last) != "NOPROMPT":
        detail(watch, w, "NOPROMPT " + clean(pane[-300:], 300))
        emit("PROMPT: %s is blocked and the prompt did not parse -- read the pane yourself" % w)
        write_file(last, "NOPROMPT")


def stuck(w, pane, watch):
    """a working session stuck reconnecting to its API for ten minutes or more"""
    hits = re.findall(r"Reconnecting to [^ ]+ \(attempt [0-9]+, [0-9]+s\)", "\n".join(pane.splitlines()[-12:]))
    if not hits:
        return
    s = hits[-1]
    secs = int(re.search(r"([0-9]+)s\)$", s).group(1))
    p = os.path.join(watch, w + ".stuck")
    if secs >= 600 and s != read_file(p):
        detail(watch, w, "STUCK " + clean(s))
        emit("STUCK: %s (reconnecting; detail in .watch/%s.detail)" % (w, w))
        write_file(p, s)


def capacity(w, phrase, watch):
    """dispatch-capacity.sh full "<phrase>: <worker>", once per signature"""
    sig = phrase + ": " + w
    p = os.path.join(watch, w + ".capacity")
    seen = (read_file(p) or "").splitlines()
    if sig in seen:
        return
    binp = os.environ.get("HERD_WATCH_CAPACITY_BIN") or os.path.join(
        os.environ.get("HERD_WATCH_HERE", ""), "dispatch-capacity.sh")
    try:
        subprocess.run(["bash", binp, "full", sig], capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return
    with open(p, "a", encoding="utf-8") as f:
        f.write(sig + "\n")


def rules_file(wdir):
    """(path, mtime) of the worker's own permissions.json, or None"""
    p = os.path.join(wdir, "permissions.json")
    try:
        if os.path.islink(wdir) or os.path.islink(p):
            return None
        st = os.stat(p)
    except OSError:
        return None
    if st.st_uid != os.getuid() or not os.path.isfile(p):
        return None
    return p, int(st.st_mtime)


def pane_of(agent, tab):
    for row in (agent, tab):
        v = (row or {}).get("pane_id")
        if isinstance(v, str) and PANE_RE.fullmatch(v):
            return v
    tab_id = (tab or {}).get("tab_id")
    if not isinstance(tab_id, str):
        return None
    panes = listing("pane") or []
    ids = [r.get("pane_id") for r in panes if r.get("tab_id") == tab_id]
    ids = [v for v in ids if isinstance(v, str) and PANE_RE.fullmatch(v)]
    return ids[0] if len(ids) == 1 else None


def resume(w, tab, agent, pane, herd, watch, now):
    wdir = os.path.join(herd, w)
    status = (agent or {}).get("agent_status")
    # herdr says `done` both for a claude that ended its turn (still at its input:
    # interactive_ready) and for one whose process is gone; only the second is restarted
    restart = agent is None or (status == "done" and agent.get("interactive_ready") is not True)
    low = "\n".join(pane.splitlines()[-20:]).lower()
    phrase = next((ph for ph in PHRASES if ph in low), None)
    if not restart and not (phrase and status in ("idle", "done")):
        return
    if restart and tab is None:
        return                                 # no tab, no pane to restart in
    if phrase:
        capacity(w, phrase, watch)
    rules = rules_file(wdir)
    spath = os.path.join(watch, w + ".resume")
    try:
        state = json.loads(read_file(spath) or "{}")
    except ValueError:
        state = {}
    spawn = rules[1] if rules else None
    if not isinstance(state, dict) or state.get("spawn") != spawn:
        state = {"count": 0, "last": 0, "spawn": spawn}   # a new spawn starts a new budget
    count, last = int(state.get("count", 0)), int(state.get("last", 0))
    if count >= len(DELAYS) or (count and now - last < DELAYS[count]):
        return
    if restart:
        if rules is None or now - rules[1] < YOUNG:
            return
        p = pane_of(agent, tab)
        if p is None:
            return
    state.update(count=count + 1, last=now)
    write_file(spath, json.dumps(state) + "\n")
    ok = True
    if restart:
        ok = herdr("agent", "start", w, "--kind", "claude", "--pane", p, "--timeout", "120000", "--",
                   "--permission-mode", "auto", "--model", "opus", "--add-dir", wdir,
                   "--settings", rules[0], "--setting-sources", "project", "--strict-mcp-config",
                   "--resume", timeout=180)[0] == 0
        if ok:
            herdr("agent", "wait", w, "--until", "idle", "--timeout", "120000", timeout=180)
    if ok:
        ok = herdr("agent", "prompt", w, CONTINUE)[0] == 0
    detail(watch, w, "RESUME attempt %d (%s%s): %s" % (count + 1, "restart" if restart else "prompt",
                                                      ", " + phrase if phrase else "", "ok" if ok else "failed"))
    if ok:
        emit("RESUMED: " + w)
    else:
        emit("STUCK: %s (resume attempt failed; detail in .watch/%s.detail)" % (w, w))


def discovered(agents, herd):
    """The herd as herdr sees it NOW: every listed agent with a worker name that is not the
    --notify target and whose own herd dir holds the rules file herd-spawn wrote. Re-read
    on every pass (ISSUE(herd-watch-workers-list-is-static)): a list read once at start
    left every later spawn unwatched, its report never announced. A name that is not a
    worker name is dropped before it is joined to a path or printed; an agent with no
    rules file was not spawned by herd-spawn and is not ours. A listing that failed
    (None) or came back empty discovers nobody -- it says nothing about who is gone."""
    target = os.environ.get("HERD_WATCH_NOTIFY", "")
    out = set()
    for a in agents or []:
        n = a.get("name")
        if not isinstance(n, str) or not NAME_RE.fullmatch(n) or n == target:
            continue
        wdir = os.path.join(herd, n)
        if os.path.isdir(wdir) and rules_file(wdir) is not None:
            out.add(n)
    return out


def report_digest(wdir):
    """(sha256 hex, mtime) of <wdir>/report.md, or None. Neither the herd dir nor the
    report is followed through a symlink: a link could hand the coordinator a file the
    worker never wrote, or point .reported's write outside HERD_DIR."""
    if os.path.islink(wdir) or not os.path.isdir(wdir):
        return None
    try:
        fd = os.open(os.path.join(wdir, "report.md"), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            return None
        h = hashlib.sha256()
        while True:
            b = os.read(fd, 1 << 16)
            if not b:
                break
            h.update(b)
        return h.hexdigest(), st.st_mtime
    except OSError:
        return None
    finally:
        os.close(fd)


def current_report(wdir):
    """(digest, mtime) of the report THIS spawn wrote, or None. A report is the current
    spawn's only when strictly newer than permissions.json, which herd-spawn rewrites on
    every spawn: a report left over from an earlier run under the same name (the daily
    reviewer, 2026-09-22) is stale, never announced and never a reason not to restart.
    A symlinked rules file refuses outright. A name with no rules file at all can only be
    here from WORKERS -- the operator said to watch it -- so there is no spawn time to
    compare with and the check is skipped."""
    rep = report_digest(wdir)
    if rep is None:
        return None
    p = os.path.join(wdir, "permissions.json")
    if os.path.islink(p):
        return None
    try:
        st = os.stat(p)
    except OSError:
        return rep
    return rep if rep[1] > st.st_mtime else None


def announced(wdir):
    """the digest in .reported, '' for the old watcher's empty marker, None when absent"""
    try:
        fd = os.open(os.path.join(wdir, ".reported"), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    try:
        return os.read(fd, 256).decode("ascii", "replace").strip(), os.fstat(fd).st_mtime
    except OSError:
        return None
    finally:
        os.close(fd)


def mark_reported(wdir, digest):
    fd = os.open(os.path.join(wdir, ".reported"),
                 os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.write(fd, (digest + "\n").encode("ascii"))
    finally:
        os.close(fd)


def check_report(w, herd):
    """Announce w's current report once per distinct content, across passes and restarts.
    True when the current spawn has a report (announced now or before)."""
    wdir = os.path.join(herd, w)
    rep = current_report(wdir)
    if rep is None:
        return False
    digest, mtime = rep
    seen = announced(wdir)
    if seen is not None and seen[0] == digest:
        return True
    if seen is not None and not re.fullmatch(r"[0-9a-f]{64}", seen[0]) and mtime <= seen[1]:
        # the old watcher's empty marker, written after this report: already announced
        mark_reported(wdir, digest)
        return True
    try:
        mark_reported(wdir, digest)
    except OSError:
        return True                    # cannot record it: announcing every pass is worse
    emit("REPORT: %s wrote report.md" % w)
    return True


# ------------------------------------------------------------------ the intake watchdog

GRACE = 300                        # an intake unchanged this long, with no live worker, stalled
CLOSED = ("done", "landed", "SUPERSEDED", "blocked", "question")
INTAKE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,124}\.md")   # appl-hook.sh's own rule
HEADER_MAX = 1 << 16


def header_status(path):
    """the words of the intake's HEADER `status:` line (the lines before the first blank
    line, as appl-status.sh reads it), or None. A `status:` inside `## Task` is text."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        data = os.read(fd, HEADER_MAX).decode("utf-8", "replace")
    except OSError:
        return None
    finally:
        os.close(fd)
    for line in data.split("\n"):
        if line == "":
            break
        if line.startswith("status:"):
            return line[len("status:"):].split()
    return None


def log_reprompt(coord, name, now):
    """one fixed-vocabulary line in coordinator.log, append-only, never through a link"""
    line = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)) + " reprompt " + name + "\n"
    try:
        fd = os.open(os.path.join(coord, "coordinator.log"),
                     os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except OSError:
        return
    try:
        os.write(fd, line.encode("ascii"))
    finally:
        os.close(fd)


def intake_watchdog(agents, herd, watch, now):
    """ISSUE(coordinator-annotates-an-intake-then-does-not-spawn). The coordinator can set an
    intake's status to an annotation (`new -- brief for w9 being written`) and end its turn
    before it spawns: the intake then looks handled and nothing says it stalled. Every pass,
    each intake directly under <HERD_DIR>/coordinator/intake/ whose header status names no
    live agent, whose first status word is not a closed state and whose mtime is more than
    GRACE seconds old is typed into the --notify target as `intake <path>` -- the bytes
    tools/appl-add.sh sends, so the pane takes it exactly as a fresh filing -- at most once
    per GRACE per (intake, mtime). State is on disk (.watch/intakes.json) because every pass
    is a fresh process. A listing that failed judges nobody live, so nothing is typed.
    Nothing an intake says reaches stdout, the log or the pane: only its file name, which
    must pass appl-hook's name rule. It never edits an intake, spawns or closes anything."""
    target = os.environ.get("HERD_WATCH_NOTIFY", "")
    if not target or not NAME_RE.fullmatch(target) or agents is None:
        return
    coord = os.path.join(herd, "coordinator")
    idir = os.path.join(coord, "intake")
    if os.path.islink(coord) or os.path.islink(idir) or not os.path.isdir(idir):
        return
    live = {a.get("name") for a in agents if isinstance(a.get("name"), str)} - {target}
    spath = os.path.join(watch, "intakes.json")
    try:
        state = json.loads(read_file(spath) or "{}")
    except ValueError:
        state = {}
    if not isinstance(state, dict):
        state = {}
    kept = {}
    try:
        entries = sorted(os.listdir(idir))
    except OSError:
        return
    for name in entries:
        if not INTAKE_RE.fullmatch(name):
            continue
        path = os.path.join(idir, name)
        try:
            st = os.lstat(path)
        except OSError:
            continue
        if not stat.S_ISREG(st.st_mode):
            continue                                   # a symlink, a directory, a fifo
        prev = state.get(name) if isinstance(state.get(name), dict) else None
        if prev is not None:
            kept[name] = prev
        words = header_status(path)
        if not words or words[0] in CLOSED or any(w in live for w in words):
            continue
        if now - st.st_mtime <= GRACE:
            continue
        mtime = st.st_mtime_ns
        at = prev.get("at") if prev is not None else None
        if prev is not None and prev.get("mtime") == mtime and isinstance(at, int) and now - at <= GRACE:
            continue                                   # typed inside this grace period already
        if herdr("agent", "prompt", target, "intake " + path, timeout=30)[0] != 0:
            continue                                   # the pane is down: try again next pass
        kept[name] = {"mtime": mtime, "at": now}
        log_reprompt(coord, name, now)
    if kept != state:
        tmp = spath + ".tmp"
        try:
            if os.path.islink(tmp):
                os.unlink(tmp)
            write_file(tmp, json.dumps(kept, sort_keys=True) + "\n")
            os.replace(tmp, spath)
        except OSError:
            pass


def main_once():
    fixed = {w for w in os.environ.get("WORKERS", "").split() if NAME_RE.fullmatch(w)}
    herd = herd_dir()
    watch = os.path.join(herd, ".watch")
    os.makedirs(watch, exist_ok=True)
    now = clock()
    tabs, agents = listing("tab"), listing("agent")
    tab_by = {t.get("label"): t for t in tabs or []}
    agent_by = {a.get("name"): a for a in agents or []}
    names = sorted(fixed | discovered(agents, herd))
    if tabs is None or agents is None:
        emit("WORKERS: herdr: unreadable")
    else:
        emit("WORKERS: " + " ".join("%s=%s" % (w, word(tab_by[w].get("agent_status"))) if w in tab_by else w
                                    for w in names))
    for w in names:
        has_report = check_report(w, herd)
        tab, agent = tab_by.get(w), agent_by.get(w)
        if (tab or {}).get("agent_status") == "blocked":
            approve(w, agent, watch)
            continue
        pane = read_pane(w)
        stuck(w, pane, watch)
        if tabs is None or agents is None or has_report:
            continue
        resume(w, tab, agent, pane, herd, watch, now)
    intake_watchdog(agents, herd, watch, now)
    return 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "verdict":
        sys.exit(main_verdict(sys.argv[2:]))
    if mode == "once":
        sys.exit(main_once())
    print("usage: herd-watch.sh [once] [--notify NAME] | verdict <worker> [--worktree PATH]", file=sys.stderr)
    sys.exit(2)
PY

pass_once() {
  python3 -I -c "$HERD_WATCH_PY" once
}

usage() {
  echo "usage: herd-watch.sh [once] [--notify NAME] | verdict <worker> [--worktree PATH]" >&2
  exit 2
}

# herdr's agent-name rule, the same one herd-spawn.sh applies to a worker name
agent_name_ok() {
  case "$1" in
    ''|*[!a-z0-9_-]*|[!a-z]*) return 1 ;;
  esac
  [ ${#1} -le 32 ]
}

if [ "${1:-}" = "verdict" ]; then
  shift
  exec python3 -I -c "$HERD_WATCH_PY" verdict "$@"
fi

mode=loop
if [ "${1:-}" = "once" ]; then
  mode=once
  shift
fi
unset HERD_WATCH_NOTIFY
while [ $# -gt 0 ]; do
  case "$1" in
    --notify)
      [ $# -ge 2 ] || usage
      if ! agent_name_ok "$2"; then
        echo "herd-watch: --notify takes an agent name ([a-z][a-z0-9_-], at most 32)" >&2
        exit 2
      fi
      export HERD_WATCH_NOTIFY="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

case "$mode" in
  once)
    pass_once
    exit $?
    ;;
  loop)
    prev=""
    while true; do
      out="$(pass_once)"
      # the loop prints WORKERS: only when it changed; every other line as it comes
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        case "$line" in
          WORKERS:*) [ "$line" = "$prev" ] && continue; prev="$line" ;;
        esac
        printf '%s\n' "$line"
      done <<EOF
$out
EOF
      sleep "${HERD_WATCH_INTERVAL:-20}"
    done
    ;;
esac
