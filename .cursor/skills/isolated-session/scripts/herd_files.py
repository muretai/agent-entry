"""herd_files.py -- the one reader and the one writer of a file in a worker's herd dir.

A walled worker owns $HERD_DIR/<w>, so it can mkfifo, symlink or hard-link any name there
(review of 290cba4, findings 1-2). herd-watch.sh and appl-hook.sh both open such names, and
both load this file by absolute path from their own directory (`python3 -I` keeps the
directory off sys.path), compiled from its source so no bytecode is read from or written
beside it. One copy of each routine, not one per script (review of cdd2703..72fc029,
finding 2). Stdlib only, Python 3.9.
"""

import hashlib
import os
import stat

CHUNK = 1 << 16
OVERSIZED = "oversized"            # digest_regular's answer for a file over its cap


def _open_regular(path):
    """(fd, fstat, lstat) of the regular file at path, or None. Anything lstat does not call
    a regular file -- a FIFO, a socket, a symlink -- is never opened. The open is O_NONBLOCK
    and O_NOFOLLOW, and the opened file must be the dev/ino lstat saw, so a swap between the
    two is absent too. The caller closes fd."""
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode):
        return None
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        fst = os.fstat(fd)
    except OSError:
        os.close(fd)
        return None
    if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
        os.close(fd)
        return None
    return fd, fst, st


def read_regular(path, limit):
    """(bytes, fstat) of the regular file at path, at most `limit` bytes, or None. The limit
    is mandatory: no caller holds a whole file a worker wrote (review of cdd2703..72fc029,
    finding 1). The one reader of every file a pass opens in a worker's herd dir
    (.reported, report.md) and of .watch/<w>.respawn: a walled worker can mkfifo or link
    those names (review of 290cba4, findings 1-2), and each is judged as _open_regular
    judges it."""
    got = _open_regular(path)
    if got is None:
        return None
    fd, fst, _ = got
    try:
        chunks, n = [], 0
        while n < limit:
            b = os.read(fd, min(CHUNK, limit - n))
            if not b:
                break
            chunks.append(b)
            n += len(b)
        return b"".join(chunks), fst
    except OSError:
        return None
    finally:
        os.close(fd)


def digest_regular(path, cap):
    """(sha256 hex, fstat) of the regular file at path, hashed while streaming, or None
    (absent, as read_regular judges it), or OVERSIZED. A file whose lstat st_size is over
    `cap` bytes is OVERSIZED and never opened; one that grows past `cap` while it is read
    is OVERSIZED too, and no more than cap + 1 bytes are read. The bytes are never joined
    or returned (review of cdd2703..72fc029, finding 1)."""
    try:
        if os.lstat(path).st_size > cap:
            return OVERSIZED
    except OSError:
        return None
    got = _open_regular(path)
    if got is None:
        return None
    fd, fst, st = got
    try:
        if st.st_size > cap or fst.st_size > cap:
            return OVERSIZED
        h, n = hashlib.sha256(), 0
        while n <= cap:
            b = os.read(fd, min(CHUNK, cap + 1 - n))
            if not b:
                break
            h.update(b)
            n += len(b)
        if n > cap:
            return OVERSIZED
        return h.hexdigest(), fst
    except OSError:
        return None
    finally:
        os.close(fd)


def replace_regular(path, data):
    """write `data` to a new temporary file in path's directory and rename it over path.
    The existing node -- a FIFO, a symlink, a hard link to a file elsewhere -- is never
    opened or written through: the rename replaces the name. The temporary name never
    outlives the call. Raises OSError when the write or the rename fails."""
    d, base = os.path.split(path)
    tmp = os.path.join(d, ".%s.%d.%s.tmp" % (base, os.getpid(), os.urandom(6).hex()))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        try:
            os.fchmod(fd, 0o600)
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
        finally:
            os.close(fd)
        os.rename(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
