#!/usr/bin/env python3
"""
run_ledger.py -- the run ledger: one JSON line per event in $HERD_DIR/coordinator/runs.jsonl.

  append(event=..., intake_id=..., worker=..., keys={...}, herd_dir=None)
      appends one line {"ts", "intake_id", "worker", "event", <the event's keys>} to
      <herd_dir>/coordinator/runs.jsonl. herd_dir defaults to $HERD_DIR, else
      $HOME/.cache/muretai-herd, as tools/appl-add.sh does.

The ledger is append-only: the file is opened O_APPEND|O_NOFOLLOW and the whole line goes
out in one write under an exclusive flock, so earlier lines are never rewritten and
concurrent writers interleave whole lines. The flock is taken LOCK_NB and retried for at
most LOCK_WAIT seconds: anyone who can read runs.jsonl can hold it, so append never waits
without a deadline. LedgerRefused is raised, with nothing written, when the event is not
one this ledger records (EVENT_KEYS, below), when the lock is still held at the deadline,
when runs.jsonl is a symlink, or when a key could carry a prompt or a secret or a value is
a path under bindings/. Any other failure (a value JSON cannot encode, a ledger that cannot
be opened for writing) raises before or instead of the write, so no partial line is left.

The events and their keys:

  intake-filed     any keys (tools/appl-add.sh writes intake)
  status-change    old, new, category             (appl-status.sh)
  spawn            role, harness, model, attempt, and repo when known
                                                  (herd-spawn.sh; the worker is the line's worker)
  spawn-failure    from, to, why                  (herd-spawn.sh)
  failover         from, to, why                  (herd-spawn.sh)
  worker-report    verdict                        (appl-hook.sh; the worker is the line's worker)
  landing-receipt  MERGED, GATE, SEC, TESTS, TESTS_SECS, REFUSAL, COMMIT  (finish-worktree.sh)
  security-review  range, findings, verdict
  stuck            no keys                        (herd-watch.sh; the worker is the line's worker)
  dead             no keys                        (herd-watch.sh; the worker is the line's worker)
  respawn          no keys                        (herd-watch.sh; the worker is the line's worker)
  runner-result    cost, turns, session_id, permission_denials, run_id, role_def, outcome,
                   exit_code                      (appl-run.py; the worker is the line's worker)

Every event but intake-filed takes exactly its keys (and its OPTIONAL_KEYS, which may be
left out): a missing or an unknown key is
refused, and so is a spawn, a worker-report, a stuck, a dead, a respawn or a runner-result
with no worker name.

Command line, for the shell writers (nothing on stdout; exit 1 with one stderr line on
failure):

  python3 -I tools/run_ledger.py <herd_dir> <event> <intake_id> <worker> [key=value ...]
"""

from __future__ import annotations

import datetime
import errno
import fcntl
import json
import os
import stat
import sys
import time

# event -> its keys, all required and no others; None takes any keys
EVENT_KEYS = {
    "intake-filed": None,
    "status-change": ("old", "new", "category"),
    "spawn": ("role", "harness", "model", "attempt"),
    "spawn-failure": ("from", "to", "why"),
    "failover": ("from", "to", "why"),
    "worker-report": ("verdict",),
    "landing-receipt": ("MERGED", "GATE", "SEC", "TESTS", "TESTS_SECS", "REFUSAL", "COMMIT"),
    "security-review": ("range", "findings", "verdict"),
    "stuck": (),
    "dead": (),
    "respawn": (),
    "runner-result": ("cost", "turns", "session_id", "permission_denials", "run_id", "role_def",
                      "outcome", "exit_code"),
}
# event -> keys it may carry beyond EVENT_KEYS, none of them required: a spawn's repo is
# written when herd-spawn.sh is given --intake-repo, and a back-filled spawn has none
OPTIONAL_KEYS = {
    "spawn": ("repo",),
}
EVENTS = tuple(EVENT_KEYS)
# events whose line names a worker: an empty worker is a missing key
NEEDS_WORKER = ("spawn", "worker-report", "stuck", "dead", "respawn", "runner-result")
# a key holding any of these words could record a prompt or a secret
SECRET_WORDS = ("prompt", "token", "secret", "password", "passwd", "api_key", "apikey",
                "credential", "private_key")
BASE_KEYS = ("ts", "intake_id", "worker", "event")
# the most append waits for the ledger's lock, and how often it tries again meanwhile
LOCK_WAIT = 2.0
LOCK_POLL = 0.05


class LedgerRefused(Exception):
    """The append was refused; nothing was written."""


def default_herd_dir() -> str:
    herd = os.environ.get("HERD_DIR", "")
    if herd:
        return herd
    home = os.environ.get("HOME", "")
    if not home:
        raise LedgerRefused("neither HERD_DIR nor HOME is set; no ledger to write")
    return os.path.join(home, ".cache", "muretai-herd")


def _under_bindings(value: str) -> bool:
    return "/bindings/" in "/" + value.replace("\\", "/")


def _check_value(where: str, value) -> None:
    if isinstance(value, str):
        if _under_bindings(value):
            raise LedgerRefused("%s is a path under bindings/; not recorded" % where)
    elif isinstance(value, dict):
        for k, v in value.items():
            _check_key(where + "." + str(k), k)
            _check_value(where + "." + str(k), v)
    elif isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            _check_value("%s[%d]" % (where, i), v)


def _check_key(where: str, key) -> None:
    if not isinstance(key, str):
        raise LedgerRefused("key %r is not a string" % (key,))
    low = key.lower().replace("-", "_")
    for word in SECRET_WORDS:
        if word in low:
            raise LedgerRefused("key %s could record a prompt or a secret; not recorded" % where)


def _line(event: str, intake_id: str, worker: str, keys: dict) -> bytes:
    if event not in EVENTS:
        raise LedgerRefused("event %r is not recorded by the run ledger" % (event,))
    rec = {
        "ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "intake_id": intake_id,
        "worker": worker,
        "event": event,
    }
    _check_value("intake_id", intake_id)
    _check_value("worker", worker)
    for k, v in keys.items():
        _check_key(str(k), k)
        if k in BASE_KEYS:
            raise LedgerRefused("key %s is set by the ledger itself" % k)
        _check_value(k, v)
        rec[k] = v
    want = EVENT_KEYS[event]
    if want is not None:
        missing = [k for k in want if k not in keys]
        if missing:
            raise LedgerRefused("event %s needs key(s) %s" % (event, ", ".join(missing)))
        may = OPTIONAL_KEYS.get(event, ())
        extra = sorted(str(k) for k in keys if k not in want and k not in may)
        if extra:
            raise LedgerRefused("event %s takes no key(s) %s" % (event, ", ".join(extra)))
    if event in NEEDS_WORKER and not worker:
        raise LedgerRefused("event %s needs the worker's name" % event)
    return (json.dumps(rec, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
            + "\n").encode("ascii")


def _lock(fd: int, path: str) -> None:
    """flock(LOCK_EX) without blocking: retried for at most LOCK_WAIT seconds, then
    LedgerRefused. Anyone who can read runs.jsonl can hold the lock, so a filer never
    waits on it without a deadline."""
    deadline = time.monotonic() + LOCK_WAIT
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except OSError as e:
            if e.errno not in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
                raise
        if time.monotonic() >= deadline:
            raise LedgerRefused("%s is locked by another process; not written after %.0fs"
                                % (path, LOCK_WAIT))
        time.sleep(LOCK_POLL)


def append(event: str, intake_id: str, worker: str, keys: dict | None = None,
           herd_dir: str | None = None) -> str:
    """Append one line; returns the ledger's path. Raises LedgerRefused, or the OSError
    of a ledger that cannot be written, with nothing written."""
    data = _line(event, intake_id, worker, dict(keys or {}))
    coord = os.path.join(herd_dir or default_herd_dir(), "coordinator")
    path = os.path.join(coord, "runs.jsonl")
    os.makedirs(coord, mode=0o700, exist_ok=True)
    if os.path.islink(path):
        raise LedgerRefused("%s is a symlink; not written" % path)
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) \
        | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags, 0o600)
    except OSError as e:
        if e.errno == errno.ELOOP:
            raise LedgerRefused("%s is a symlink; not written" % path) from None
        raise
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise LedgerRefused("%s is not a regular file; not written" % path)
        _lock(fd, path)
        view = memoryview(data)
        while view:
            n = os.write(fd, view)
            view = view[n:]
    finally:
        os.close(fd)
    return path


def main(argv: list) -> int:
    if len(argv) < 4:
        print("usage: run_ledger.py <herd_dir> <event> <intake_id> <worker> [key=value ...]",
              file=sys.stderr)
        return 2
    herd, event, intake_id, worker = argv[:4]
    keys = {}
    for kv in argv[4:]:
        if "=" not in kv:
            print("run_ledger: not key=value: %s" % kv, file=sys.stderr)
            return 2
        k, v = kv.split("=", 1)
        keys[k] = v
    try:
        append(event=event, intake_id=intake_id, worker=worker, keys=keys, herd_dir=herd)
    except (LedgerRefused, OSError, ValueError, TypeError) as e:
        print("run_ledger: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
