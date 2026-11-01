#!/usr/bin/env bash
# Fetch, bundle, publish and grant artifacts for the coordinator, confined to
# $HERD_DIR/coordinator/reference/ (HERD_DIR defaults to ~/.cache/muretai-herd).
#
#   appl-artifact.sh fetch <token>
#   appl-artifact.sh bundle <repo> <branch> --to <did> --relay <url>
#   appl-artifact.sh publish-grant <file> <did> --relay <url>
#
# Every operator call is the pane's dispatch-mac-a seat, through APPL_OPERATOR_CLI
# (unset: `muretai op`), with the artifact subcommand passed as argv and no shell:
#   --as dispatch-mac-a --relay <url> artifact ...
# fetch prints the lowercase sha256 of the file the operator wrote at
# reference/<name>/<name>. bundle writes a git bundle of origin/main..<branch>
# to reference/<safe>/<safe>.bundle (<safe> is <branch> with each / replaced by -),
# then publish and grant --dm. publish-grant does those two calls for a file that
# is already under reference/.
#
# Refusals exit non-zero, name the offending input and the rule, and do not call
# the operator: a path outside reference/ (a `..` segment, or a symlink that
# points out, including reference/ itself), a repository that is not listed in
# the dispatch repos file, a malformed token, a malformed did.
set -uo pipefail
herd="${HERD_DIR:-${HOME:-}/.cache/muretai-herd}"
exec python3 -I - "${herd%/}" "$@" <<'PY'
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys

DISPATCH = "dispatch-mac-a"
NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
SAFE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,200}\Z")
RELAY_RE = re.compile(r"https://\S+\Z")
DID_RE = re.compile(r"did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,256}\Z")
REPO_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]+\Z")
AID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,200}\Z")
BRANCH_RE = re.compile(r"[A-Za-z0-9._/-]+\Z")


def usage():
    sys.stderr.write(
        "usage: appl-artifact.sh fetch <token>"
        " | bundle <repo> <branch> --to <did> --relay <url>"
        " | publish-grant <file> <did> --relay <url>\n")
    sys.exit(2)


def refuse(phrase, needle):
    sys.stderr.write("appl-artifact: " + needle + ": " + phrase + "\n")
    sys.exit(1)


def reference_root(herd):
    return os.path.join(herd, "coordinator", "reference")


def under_real(real_root, path):
    return path == real_root or path.startswith(real_root + os.sep)


def symlink_escapes(root, path):
    """True when root, or an existing component of path, is a symlink that
    resolves outside root. root itself being a symlink always escapes.
    A component that does not exist yet is not an escape."""
    if os.path.islink(root):
        return True
    if not os.path.isdir(root):
        return os.path.lexists(root)
    if path != root and not path.startswith(root + os.sep):
        return True
    real_root = os.path.realpath(root)
    if path == root:
        return False
    cur = root
    for part in path[len(root) + 1:].split("/"):
        if part in ("", ".", ".."):
            return True
        cur = os.path.join(cur, part)
        if not os.path.lexists(cur):
            return False
        if os.path.islink(cur) and not under_real(real_root, os.path.realpath(cur)):
            return True
    return False


def lexical_outside(root, path):
    if not path.startswith("/") or ".." in path.split("/"):
        return True
    return not path.startswith(root + os.sep)


def file_outside(root, path):
    """True unless path is a regular file lexically under root, with no `..`
    segment and no symlink along the way that resolves outside root."""
    if lexical_outside(root, path):
        return True
    if os.path.islink(root) or not os.path.isdir(root):
        return True
    real_root = os.path.realpath(root)
    cur = root
    for part in path[len(root) + 1:].split("/"):
        if part in ("", ".", ".."):
            return True
        cur = os.path.join(cur, part)
        if not os.path.lexists(cur):
            return True
        if os.path.islink(cur) and not under_real(real_root, os.path.realpath(cur)):
            return True
    real_file = os.path.realpath(cur)
    if not under_real(real_root, real_file) or not os.path.isfile(real_file):
        return True
    return False


def operator(args):
    cli = os.environ.get("APPL_OPERATOR_CLI", "")
    argv = [cli] if cli else ["muretai", "op"]
    argv.extend(["--as", DISPATCH])
    argv.extend(args)
    return subprocess.run(
        argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def offer(token):
    if TOKEN_RE.fullmatch(token) is None:
        return None
    pad = "=" * ((4 - len(token) % 4) % 4)
    try:
        raw = base64.urlsafe_b64decode(token + pad)
        doc = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        return None
    if type(doc) is not dict:
        return None
    return doc


def run_fetch(herd, token):
    doc = offer(token)
    if doc is None or doc.get("typ") != "artifact-offer":
        refuse("malformed token", token)
    relay = doc.get("relay")
    if not isinstance(relay, str) or RELAY_RE.fullmatch(relay) is None:
        refuse("malformed token", token)
    name = doc.get("name")
    if not isinstance(name, str):
        refuse("malformed token", token)
    if NAME_RE.fullmatch(name) is None:
        refuse("outside reference/", name)
    root = reference_root(herd)
    dest = os.path.join(root, name, name)
    if symlink_escapes(root, dest):
        refuse("outside reference/", name)
    result = operator(
        ["--relay", relay, "artifact", "fetch", "--out", dest, token])
    if result.returncode != 0:
        sys.stderr.write("appl-artifact: fetch failed\n")
        sys.exit(1)
    if symlink_escapes(root, dest) or os.path.islink(dest):
        sys.exit(1)
    try:
        fd = os.open(dest, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        sys.exit(1)
    try:
        digest = hashlib.sha256()
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            digest.update(chunk)
    finally:
        os.close(fd)
    sys.stdout.write(digest.hexdigest() + "\n")


def repos_path():
    ddir = os.environ.get("DISPATCH_DIR", "")
    if not ddir:
        home = os.environ.get("HOME", "")
        if not home:
            return ""
        ddir = os.path.join(home, ".muretai", "dispatch")
    return os.path.join(ddir, "repos")


def repo_listed(repo):
    if not repo.startswith("/"):
        return False
    path = repos_path()
    if not path:
        return False
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return False
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return False
        text = os.read(fd, 1 << 16).decode("utf-8", "replace")
    except OSError:
        return False
    finally:
        os.close(fd)
    want = os.path.realpath(repo)
    for ln in text.split("\n"):
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        name, sep, listed = ln.partition("=")
        name, listed = name.strip(), listed.strip()
        if (sep and REPO_NAME_RE.fullmatch(name) and listed.startswith("/")
                and os.path.realpath(listed) == want):
            return True
    return False


def branch_outside(branch):
    if not branch or branch.startswith("-") or branch.startswith("/"):
        return True
    parts = branch.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return True
    if BRANCH_RE.fullmatch(branch) is None:
        return True
    return SAFE_RE.fullmatch(branch.replace("/", "-")) is None


def prepare_bundle(root, safe):
    if os.path.islink(root):
        return None
    if os.path.lexists(root) and not os.path.isdir(root):
        return None
    parent = os.path.join(root, safe)
    if os.path.islink(parent):
        return None
    try:
        os.makedirs(parent, 0o700, exist_ok=True)
    except OSError:
        return None
    if os.path.islink(root) or os.path.islink(parent) or not os.path.isdir(parent):
        return None
    dest = os.path.join(parent, safe + ".bundle")
    if os.path.lexists(dest):
        if os.path.islink(dest) or not os.path.isfile(dest):
            return None
        if not under_real(os.path.realpath(root), os.path.realpath(dest)):
            return None
        try:
            os.remove(dest)
        except OSError:
            return None
    return dest


def make_bundle(repo, branch, dest):
    result = subprocess.run(
        ["git", "-C", repo, "bundle", "create", dest, "origin/main.." + branch],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.returncode == 0 and os.path.isfile(dest) and not os.path.islink(dest)


def need_did(did):
    if DID_RE.fullmatch(did) is None:
        refuse("malformed did", did)


def need_relay(url):
    if RELAY_RE.fullmatch(url) is None:
        sys.stderr.write("appl-artifact: " + url + ": relay is not https\n")
        sys.exit(1)


def publish_and_grant(path, did, relay):
    result = operator(["--relay", relay, "artifact", "publish", "--json", path])
    if result.returncode != 0:
        sys.stderr.write("appl-artifact: publish failed\n")
        sys.exit(1)
    try:
        doc = json.loads(result.stdout.decode("utf-8"))
        aid = doc["aid"]
    except (ValueError, UnicodeError, KeyError, TypeError):
        sys.stderr.write("appl-artifact: publish returned no aid\n")
        sys.exit(1)
    if not isinstance(aid, str) or AID_RE.fullmatch(aid) is None:
        sys.stderr.write("appl-artifact: publish returned no aid\n")
        sys.exit(1)
    granted = operator(
        ["--relay", relay, "artifact", "grant", aid, did, "--dm"])
    if granted.returncode != 0:
        sys.stderr.write("appl-artifact: grant failed\n")
        sys.exit(1)


def parse(args, with_to):
    pos = []
    flags = {}
    known = {"--relay", "--to"} if with_to else {"--relay"}
    i = 0
    while i < len(args):
        item = args[i]
        if item in known:
            if i + 1 >= len(args) or args[i + 1].startswith("--"):
                usage()
            flags[item] = args[i + 1]
            i += 2
        elif item.startswith("-"):
            usage()
        else:
            pos.append(item)
            i += 1
    return pos, flags


def main(argv):
    if len(argv) < 3:
        usage()
    herd = argv[1]
    verb = argv[2]
    rest = argv[3:]
    if verb == "fetch":
        if len(rest) != 1 or rest[0].startswith("-"):
            usage()
        run_fetch(herd, rest[0])
        return
    if verb == "bundle":
        pos, flags = parse(rest, True)
        if len(pos) != 2 or "--to" not in flags or "--relay" not in flags:
            usage()
        repo, branch = pos
        did = flags["--to"]
        relay = flags["--relay"]
        need_did(did)
        need_relay(relay)
        if not repo_listed(repo):
            refuse("not listed in the dispatch repos", repo)
        if branch_outside(branch):
            refuse("outside reference/", branch)
        root = reference_root(herd)
        dest = prepare_bundle(root, branch.replace("/", "-"))
        if dest is None or symlink_escapes(root, os.path.dirname(dest)):
            refuse("outside reference/", branch)
        if not make_bundle(repo, branch, dest):
            sys.stderr.write("appl-artifact: bundle was not created\n")
            sys.exit(1)
        if symlink_escapes(root, dest) or os.path.islink(dest):
            refuse("outside reference/", branch)
        publish_and_grant(dest, did, relay)
        return
    if verb == "publish-grant":
        pos, flags = parse(rest, False)
        if len(pos) != 2 or "--relay" not in flags:
            usage()
        path, did = pos
        relay = flags["--relay"]
        need_did(did)
        need_relay(relay)
        root = reference_root(herd)
        if file_outside(root, path):
            refuse("outside reference/", path)
        publish_and_grant(path, did, relay)
        return
    usage()


if __name__ == "__main__":
    main(sys.argv)
PY
