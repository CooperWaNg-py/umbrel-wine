"""Umbrel Wine launcher: upload .exe files into drives and run them with Wine.

A drive is one Wine prefix (its own C: drive and registry) plus the .exe files
uploaded to it:

    <root>/drives/<drive>/prefix/   WINEPREFIX
    <root>/drives/<drive>/files/    uploaded .exe files and folders
    <root>/logs/<drive>-<YYYYmmdd-HHMMSS>-<stem>.log

Python 3 stdlib only. Importing this module has no side effects; only main()
starts threads or binds a socket, so the tests can import it.
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import signal
import socket
import stat
import struct
import subprocess
import tarfile
import threading
import time
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

DRIVE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
# Uploaded paths are relative to a drive's files/ directory: either one .exe
# ("putty.exe") or anything inside a folder ("Game/data/level1.pak"), so
# programs that need DLLs or data files next to them can be uploaded whole.
WINDOWS_ILLEGAL = frozenset('<>:"/\\|?*')
MAX_PATH_CHARS = 1024
MAX_PATH_DEPTH = 32
MAX_COMPONENT_BYTES = 255
# Executables listed per folder; installers and games can ship dozens of
# helper .exe files (crash handlers, redistributables).
MAX_LISTED_EXES = 100
# Folder summaries walk the whole tree; programs may write into their folder,
# so cached summaries expire even without an API write.
FOLDER_CACHE_TTL = 30

MAIN_DRIVE = "main"
CHUNK = 1024 * 1024
UPLOAD_RESERVE = 512 * 1024 * 1024
# Logs in /config/logs: at most MAX_LOGS files besides those still referenced
# (listed runs, each drive's latest setup log). Each keeps its first
# LOG_HEAD_BYTES and a rolling last LOG_KEEP_BYTES, so a chatty program can
# never fill the Umbrel's disk: ~4 MiB per log, ~200 MiB in total.
MAX_LOGS = 50
LOG_HEAD_BYTES = 1024 * 1024
LOG_KEEP_BYTES = 3 * 1024 * 1024
LOG_DROPPED_MARK = b"\n[umbrel-wine: output dropped here to keep this log small]\n"
LOG_TAIL = 64 * 1024
# Finished runs kept in the Running list, per drive.
MAX_FINISHED_RUNS = 20
# `wineboot -i` normally takes under a minute natively and several minutes
# under box64 on a Pi; past this it is hung, and would block the single init
# worker (every other drive) forever.
INIT_TIMEOUT = 30 * 60
MAX_JSON_BODY = 64 * 1024
# Drive file browser: text files up to this size open in the editor. The save
# body is JSON, where escaping can grow the text several times over.
MAX_EDIT_BYTES = 2 * 1024 * 1024
MAX_TEXT_BODY = 16 * 1024 * 1024
MAX_LIST_ENTRIES = 5000
# Browser paths are relative to drives/<d>/; these hold the drive together and
# are removed only through Reset / Delete drive.
PROTECTED_BROWSE_PATHS = frozenset({"", "files", "prefix"})
KILL_TIMEOUT = 10
STOP_GRACE = 5
# Upper bound on draining a rejected upload's body; see Handler._linger.
LINGER_SECONDS = 10
# `wineserver -w` after wineboot flushes the registry. It would block forever if
# something else keeps the server alive (e.g. winecfg opened from the Openbox
# menu on `main`), so the single init worker gives up waiting after this long.
FLUSH_TIMEOUT = 120

PROGRAM_DIRS = (
    "drive_c/ProgramData/Microsoft/Windows/Start Menu/Programs",
    "drive_c/users/*/AppData/Roaming/Microsoft/Windows/Start Menu/Programs",
    "drive_c/users/*/Desktop",
    "drive_c/users/Public/Desktop",
)

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
}

WARN_16K = (
    "16K-page kernel detected (Raspberry Pi 5): Wine under box64 is "
    "experimental on this hardware."
)
WARN_BOX64 = (
    "x86 programs are emulated with box64 on this device; expect them to run "
    "much slower than on a PC."
)


class ApiError(Exception):
    """An error that maps directly onto a JSON error response."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


# --------------------------------------------------------------------------
# Pure helpers
# --------------------------------------------------------------------------


def validate_drive_name(s: str) -> bool:
    return isinstance(s, str) and DRIVE_NAME_RE.match(s) is not None


def split_rel_path(s) -> list[str] | None:
    """Components of a safe path relative to files/, or None.

    Rejects empty, `.`/`..` and dot-prefixed components (also keeps clear of
    the launcher's own .upload-*.part files), characters Windows cannot put in
    a file name, and trailing dots/spaces, which Windows strips.
    """
    if not isinstance(s, str) or not s or len(s) > MAX_PATH_CHARS:
        return None
    parts = s.split("/")
    if len(parts) > MAX_PATH_DEPTH:
        return None
    for p in parts:
        if (
            not p
            or p.startswith(".")
            or p.endswith((" ", "."))
            or len(p.encode("utf-8", errors="replace")) > MAX_COMPONENT_BYTES
            or any(c in WINDOWS_ILLEGAL or ord(c) < 32 for c in p)
        ):
            return None
    return parts


def is_exe(name: str) -> bool:
    return name.lower().endswith(".exe")


def validate_upload_path(s) -> list[str] | None:
    """split_rel_path, plus: a file on its own (not in a folder) must be .exe."""
    parts = split_rel_path(s)
    if parts is None or (len(parts) == 1 and not is_exe(parts[0])):
        return None
    return parts


def contained(root: Path, path: Path) -> bool:
    """Whether `path` resolves inside `root`. Programs run as the same user and
    could plant symlinks in files/; API writes and deletes must not follow
    them out."""
    r = root.resolve()
    p = path.resolve()
    return p == r or p.is_relative_to(r)


def summarize_folder(files: Path, name: str) -> dict:
    """Size, file count and .exe paths (relative to files/) of one folder."""
    size = count = 0
    exes = []
    for dirpath, dirnames, filenames in os.walk(files / name):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for f in filenames:
            if f.startswith("."):
                continue
            try:
                st = os.lstat(os.path.join(dirpath, f))
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            size += st.st_size
            count += 1
            if is_exe(f):
                exes.append(Path(dirpath, f).relative_to(files).as_posix())
    exes.sort(key=lambda r: (r.count("/"), r.casefold()))
    return {"size": size, "file_count": count, "executables": exes[:MAX_LISTED_EXES]}


class ClientGone(Exception):
    """The request body ended before Content-Length: the upload was cancelled."""


def extract_folder_tar(fileobj, dest: Path) -> tuple[int, int]:
    """Unpack a folder upload (a tar stream) into `dest`; (files, bytes).

    Only relative paths that pass split_rel_path, plain files and directories
    are accepted: no links, devices or sparse members, which a browser-built
    archive never contains. Like single uploads, every .exe must start with MZ.
    """
    count = size = 0
    with tarfile.open(fileobj=fileobj, mode="r|") as tar:
        for member in tar:
            parts = split_rel_path(member.name.rstrip("/"))
            if parts is None:
                raise ApiError(400, "invalid_name", f"Invalid path in the upload: {member.name!r}.")
            path = dest.joinpath(*parts)
            try:
                if member.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                    continue
                if not member.isfile() or member.issparse():
                    raise ApiError(400, "unsupported_entry", f"{member.name} is not a regular file or folder.")
                path.parent.mkdir(parents=True, exist_ok=True)
                out = open(path, "xb")
            except (FileExistsError, NotADirectoryError):
                raise ApiError(400, "conflict", f"{member.name} appears twice or collides with another entry.")
            with out:
                src = tar.extractfile(member)
                first = src.read(CHUNK)
                if is_exe(parts[-1]) and first[:2] != b"MZ":
                    raise ApiError(415, "not_a_windows_executable", f"{member.name} is not a Windows executable.")
                while first:
                    out.write(first)
                    first = src.read(CHUNK)
            count += 1
            size += member.size
    return count, size


def split_browse_path(s) -> list[str] | None:
    """Components of a file-browser path relative to drives/<d>/, or None.

    More permissive than upload paths: internal files include dotfiles and
    names like dosdevices/c:. Only empty, `.` and `..` components are refused;
    symlinks are handled by `contained`.
    """
    if s is None or s == "":
        return []
    if not isinstance(s, str) or len(s) > 4096 or "\0" in s:
        return None
    parts = s.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return None
    return parts


# name -> (BOM, codec). Detection order matters: BOMs first, then strict UTF-8,
# then cp1252 (Windows' ANSI page), then latin-1, which decodes any byte.
TEXT_ENCODINGS = {
    "utf-8-bom": (b"\xef\xbb\xbf", "utf-8"),
    "utf-16-le": (b"\xff\xfe", "utf-16-le"),
    "utf-16-be": (b"\xfe\xff", "utf-16-be"),
    "utf-8": (b"", "utf-8"),
    "cp1252": (b"", "cp1252"),
    "latin-1": (b"", "latin-1"),
}


def decode_text(data: bytes) -> dict | None:
    """{"text", "encoding", "newline"} for an editable text file, or None if it
    looks binary. Text is returned with \\n line endings; `newline` records the
    file's own so encode_text can restore it (textareas normalise to \\n)."""
    for name, (bom, codec) in TEXT_ENCODINGS.items():
        if bom and data.startswith(bom):
            try:
                text = data[len(bom):].decode(codec)
            except UnicodeDecodeError:
                return None
            break
    else:
        if b"\0" in data:
            return None
        for name in ("utf-8", "cp1252", "latin-1"):
            try:
                text = data.decode(TEXT_ENCODINGS[name][1])
                break
            except UnicodeDecodeError:
                continue
    newline = "\r\n" if "\r\n" in text else "\n"
    return {"text": text.replace("\r\n", "\n"), "encoding": name, "newline": newline}


def encode_text(text: str, encoding: str, newline: str) -> bytes:
    """Inverse of decode_text. Raises ValueError for an unknown encoding or
    newline and UnicodeEncodeError for characters the encoding cannot hold."""
    if encoding not in TEXT_ENCODINGS or newline not in ("\n", "\r\n"):
        raise ValueError("unknown encoding or newline")
    bom, codec = TEXT_ENCODINGS[encoding]
    return bom + text.replace("\r\n", "\n").replace("\n", newline).encode(codec)


def scan_programs(prefix: Path) -> list[dict]:
    """Start Menu and Desktop shortcuts in a prefix, minus uninstallers."""
    found: dict[str, str] = {}
    for pattern in PROGRAM_DIRS:
        for base in sorted(prefix.glob(pattern)):
            if not base.is_dir():
                continue
            for lnk in sorted(base.rglob("*")):
                if lnk.suffix.lower() != ".lnk" or not lnk.is_file():
                    continue
                if "uninstall" in lnk.stem.lower() or lnk.stem in found:
                    continue
                found[lnk.stem] = lnk.relative_to(prefix).as_posix()
    return [
        {"name": name, "path": found[name]}
        for name in sorted(found, key=str.casefold)
    ]


def resolve_program(prefix: Path, rel) -> Path | None:
    """Absolute path of a shortcut inside prefix/drive_c, or None.

    Containment is checked on the normalised path rather than the
    symlink-resolved one: Wine links users/<name>/Desktop to $HOME/Desktop when
    that exists, so a legitimate shortcut can resolve outside the prefix. `..`
    components are collapsed first, so they cannot escape drive_c.
    """
    if not isinstance(rel, str) or not rel or "\x00" in rel:
        return None
    base = os.path.normpath(os.path.join(os.path.abspath(prefix), "drive_c"))
    target = os.path.normpath(os.path.join(os.path.abspath(prefix), rel))
    if not target.startswith(base + os.sep):
        return None
    if not target.lower().endswith(".lnk") or not os.path.isfile(target):
        return None
    return Path(target)


# LinkFlags bits from MS-SHLLINK 2.1.1.
LNK_HAS_IDLIST = 0x01
LNK_HAS_LINKINFO = 0x02
LNK_STRING_FLAGS = (0x04, 0x08, 0x10, 0x20, 0x40)  # name, relpath, workdir, args, icon
LNK_IS_UNICODE = 0x80


def _c_string(data: bytes, off: int, unicode: bool) -> str:
    if unicode:
        end = off
        while end + 1 < len(data) and data[end:end + 2] != b"\0\0":
            end += 2
        return data[off:end].decode("utf-16-le")
    end = data.index(b"\0", off)
    return data[off:end].decode("cp1252", errors="replace")


def parse_lnk(data: bytes) -> dict | None:
    """Target path, working directory and arguments of a Windows shortcut.

    Returns {"target", "workdir", "args"} (Windows paths/strings; workdir and
    args may be ""), or None when the shortcut has no local target path.
    """
    try:
        if len(data) < 0x4C or struct.unpack_from("<I", data, 0)[0] != 0x4C:
            return None
        flags = struct.unpack_from("<I", data, 20)[0]
        off = 0x4C
        if flags & LNK_HAS_IDLIST:
            off += 2 + struct.unpack_from("<H", data, off)[0]
        target = ""
        if flags & LNK_HAS_LINKINFO:
            size, hsize, liflags, _vol, base, _net, suffix = struct.unpack_from("<7I", data, off)
            if liflags & 1:  # VolumeIDAndLocalBasePath
                if hsize >= 0x24:
                    base_u, suffix_u = struct.unpack_from("<2I", data, off + 28)
                    target = _c_string(data, off + base_u, True) + _c_string(data, off + suffix_u, True)
                else:
                    target = _c_string(data, off + base, False) + _c_string(data, off + suffix, False)
            off += size
        unicode = bool(flags & LNK_IS_UNICODE)
        strings = {}
        for bit in LNK_STRING_FLAGS:
            if flags & bit:
                count = struct.unpack_from("<H", data, off)[0]
                off += 2
                width = 2 if unicode else 1
                raw = data[off:off + count * width]
                strings[bit] = raw.decode("utf-16-le") if unicode else raw.decode("cp1252", errors="replace")
                off += count * width
    except (struct.error, ValueError, UnicodeDecodeError):
        return None
    if not target:
        return None
    return {"target": target, "workdir": strings.get(0x10, ""), "args": strings.get(0x20, "")}


def split_windows_args(s: str) -> list[str]:
    """Split a Windows command line the way CommandLineToArgvW does.

    Wine rebuilds (and re-quotes) the command line from argv, so splitting here
    preserves what the program sees.
    """
    args, cur, quoted, have, i, n = [], [], False, False, 0, len(s)
    while i < n:
        c = s[i]
        if c == "\\":
            j = i
            while j < n and s[j] == "\\":
                j += 1
            count = j - i
            if j < n and s[j] == '"':
                cur.append("\\" * (count // 2))
                if count % 2:
                    cur.append('"')
                    j += 1
            else:
                cur.append("\\" * count)
            i, have = j, True
        elif c == '"':
            if quoted and i + 1 < n and s[i + 1] == '"':
                cur.append('"')
                i += 2
            else:
                quoted = not quoted
                i += 1
            have = True
        elif c in " \t" and not quoted:
            if have:
                args.append("".join(cur))
                cur, have = [], False
            i += 1
        else:
            cur.append(c)
            have = True
            i += 1
    if have:
        args.append("".join(cur))
    return args


def win_to_unix(prefix: Path, win_path: str) -> Path | None:
    """C:\\... inside the prefix's drive_c; None for other drives or `..`."""
    m = re.match(r"^[Cc]:\\?(.*)$", win_path or "")
    if not m:
        return None
    parts = [p for p in m.group(1).split("\\") if p and p != "."]
    if ".." in parts:
        return None
    return Path(prefix, "drive_c", *parts)


def program_command(prefix: Path, lnk: Path) -> tuple[list[str], Path]:
    """argv tail and cwd for running an installed program's shortcut.

    The shortcut's target runs directly so the run tracks the program itself.
    `start /wait <lnk>` cannot: for a .lnk, Wine's ShellExecuteEx starts the
    target without returning its process handle, so start.exe returns at once
    with a garbage exit code. Shortcuts without a local target (e.g. URLs) are
    still opened through `start`, which then only reports the hand-off.
    """
    try:
        info = parse_lnk(lnk.read_bytes())
    except OSError:
        info = None
    if info is None:
        return ["start", "/unix", str(lnk)], lnk.parent
    cwd = win_to_unix(prefix, info["workdir"]) if info["workdir"] else None
    if cwd is None or not cwd.is_dir():
        target_dir = win_to_unix(prefix, info["target"].rsplit("\\", 1)[0])
        cwd = target_dir if target_dir is not None and target_dir.is_dir() else lnk.parent
    return [info["target"], *split_windows_args(info["args"])], cwd


def sanitize_stem(label: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(label).stem).strip("._")
    return stem[:64] or "program"


class CappedLog:
    """Log file that keeps the first LOG_HEAD_BYTES and the last
    LOG_KEEP_BYTES of what is written, with LOG_DROPPED_MARK between.

    Compacts in place once LOG_KEEP_BYTES have accumulated past the cap, so
    the work stays linear in the output size. Several processes may share one
    log (wineboot, then `wineserver -w`); it closes when the last releases it.
    """

    def __init__(self, fd: int):
        self._fd = fd
        self._lock = threading.Lock()
        self._size = 0
        self._refs = 1
        self._broken = False
        self._base = LOG_HEAD_BYTES + len(LOG_DROPPED_MARK)

    def acquire(self) -> None:
        with self._lock:
            self._refs += 1

    def release(self) -> None:
        with self._lock:
            self._refs -= 1
            if self._refs == 0:
                os.close(self._fd)

    def write(self, data: bytes) -> None:
        with self._lock:
            if self._broken:
                return
            try:
                view = memoryview(data)
                while view:
                    view = view[os.write(self._fd, view):]
                self._size += len(data)
                if self._size > self._base + 2 * LOG_KEEP_BYTES:
                    tail = os.pread(self._fd, LOG_KEEP_BYTES, self._size - LOG_KEEP_BYTES)
                    os.pwrite(self._fd, LOG_DROPPED_MARK, LOG_HEAD_BYTES)
                    os.pwrite(self._fd, tail, self._base)
                    self._size = self._base + len(tail)
                    os.ftruncate(self._fd, self._size)
                    os.lseek(self._fd, 0, os.SEEK_END)
            except OSError:
                # e.g. disk full: stop logging, but the pump keeps draining so
                # the program never blocks on a full pipe.
                self._broken = True


def _pump(pipe, log: CappedLog) -> None:
    try:
        while chunk := os.read(pipe.fileno(), 65536):
            log.write(chunk)
    finally:
        pipe.close()
        log.release()


def spawn_logged(argv: list[str], cwd, log: CappedLog) -> subprocess.Popen:
    """Start argv in its own session with stdout+stderr pumped into `log`.

    Output reaches the log through a pipe rather than a file descriptor so it
    can be capped. Children that inherit the pipe (wineserver) keep feeding
    the same capped log for as long as they live.
    """
    proc = subprocess.Popen(
        argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, start_new_session=True,
    )
    log.acquire()
    threading.Thread(target=_pump, args=(proc.stdout, log), daemon=True).start()
    return proc


def read_tail(path: Path | None) -> bytes:
    if path is None:
        return b""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - LOG_TAIL))
            return f.read()
    except FileNotFoundError:
        return b""


class LogStore:
    """Creates and prunes the log files in /config/logs."""

    def __init__(self, logs: Path, protected):
        self.logs = logs
        self._protected = protected  # () -> set of paths still referenced

    def create(self, drive: str, label: str) -> tuple[Path, CappedLog]:
        """A new, exclusively created log. The caller holds one reference."""
        self.logs.mkdir(parents=True, exist_ok=True)
        base = f"{drive}-{time.strftime('%Y%m%d-%H%M%S')}-{sanitize_stem(label)}"
        n = 1
        while True:
            path = self.logs / (f"{base}.log" if n == 1 else f"{base}-{n}.log")
            try:
                fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o644)
            except FileExistsError:
                n += 1  # same drive, label and second as another run
                continue
            return path, CappedLog(fd)

    def prune(self) -> None:
        """Keep the newest MAX_LOGS unreferenced logs; never touch referenced ones."""
        protected = self._protected()
        entries = []
        try:
            for p in self.logs.iterdir():
                if p in protected:
                    continue
                try:
                    entries.append((p.stat().st_mtime, p))
                except FileNotFoundError:
                    pass  # deleted meanwhile
        except FileNotFoundError:
            return
        entries.sort(reverse=True)
        for _mtime, old in entries[MAX_LOGS:]:
            old.unlink(missing_ok=True)


def kill_group(pid: int, sig: int) -> None:
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------


@dataclass
class Config:
    root: Path
    port: int
    bind: str
    runner: str
    web: Path
    wait_x: bool

    @classmethod
    def from_env(cls) -> "Config":
        env = os.environ
        return cls(
            root=Path(env.get("UMBREL_WINE_ROOT", "/config")),
            port=int(env.get("UMBREL_WINE_PORT", "8090")),
            bind=env.get("UMBREL_WINE_BIND", "127.0.0.1"),
            runner=env.get("UMBREL_WINE_RUNNER", "/usr/local/bin/umbrel-wine"),
            web=Path(env.get("UMBREL_WINE_WEB", "/opt/umbrel-wine/web")),
            wait_x=env.get("UMBREL_WINE_WAIT_X", "1") == "1",
        )

    @property
    def drives(self) -> Path:
        return self.root / "drives"

    @property
    def logs(self) -> Path:
        return self.root / "logs"


# --------------------------------------------------------------------------
# Drives
# --------------------------------------------------------------------------


class DriveManager:
    """Drive lifecycle. Prefixes are initialised by ONE worker thread, one
    drive at a time: parallel wineboot on a Raspberry Pi is very slow."""

    def __init__(self, cfg: Config, logs: LogStore):
        self.cfg = cfg
        self.logs = logs
        self._lock = threading.Lock()
        # name -> {"state", "error_message", "gen", "log"}; gen invalidates
        # queued or in-flight inits when a drive is reset or deleted; log is
        # the drive's latest setup log.
        self._drives: dict[str, dict] = {}
        self._queue: queue.Queue = queue.Queue()
        self._init_proc: tuple[str, subprocess.Popen] | None = None

    # -- paths ---------------------------------------------------------------

    def drive_dir(self, name: str) -> Path:
        return self.cfg.drives / name

    def prefix(self, name: str) -> Path:
        return self.drive_dir(name) / "prefix"

    def files_dir(self, name: str) -> Path:
        return self.drive_dir(name) / "files"

    # -- startup -------------------------------------------------------------

    def load(self) -> None:
        """Pick up existing drives, create `main`, queue unready prefixes."""
        self.cfg.drives.mkdir(parents=True, exist_ok=True)
        main = self.drive_dir(MAIN_DRIVE)
        if not main.exists():
            (main / "files").mkdir(parents=True, exist_ok=True)
            (main / "prefix").mkdir(parents=True, exist_ok=True)
        for d in sorted(self.cfg.drives.iterdir()):
            if not d.is_dir() or not validate_drive_name(d.name):
                continue
            (d / "files").mkdir(exist_ok=True)
            (d / "prefix").mkdir(exist_ok=True)
            # Leftovers of interrupted uploads: .part files, extraction dirs
            # and folders that were being replaced.
            for leftover in (d / "files").glob(".upload-*"):
                if leftover.is_dir() and not leftover.is_symlink():
                    shutil.rmtree(leftover, ignore_errors=True)
                else:
                    leftover.unlink(missing_ok=True)
            with self._lock:
                self._drives[d.name] = {"state": "ready", "error_message": None, "gen": 0, "log": None}
                if not (d / "prefix" / "system.reg").exists():
                    self._enqueue_locked(d.name)

    def start_worker(self) -> None:
        threading.Thread(target=self._worker, name="drive-init", daemon=True).start()

    # -- queries -------------------------------------------------------------

    def log_paths(self) -> set[Path]:
        with self._lock:
            return {d["log"] for d in self._drives.values() if d["log"]}

    def setup_log(self, name: str) -> Path | None:
        with self._lock:
            d = self._drives.get(name)
            if d is None:
                raise ApiError(404, "no_such_drive", f"No drive named {name!r}.")
            return d["log"]

    def names(self) -> list[str]:
        with self._lock:
            rest = sorted(n for n in self._drives if n != MAIN_DRIVE)
            return ([MAIN_DRIVE] if MAIN_DRIVE in self._drives else []) + rest

    def info(self, name: str) -> dict:
        with self._lock:
            d = self._drives.get(name)
            if d is None:
                raise ApiError(404, "no_such_drive", f"No drive named {name!r}.")
            return {"state": d["state"], "error_message": d["error_message"], "setup_log": d["log"] is not None}

    def require(self, name: str) -> None:
        self.info(name)

    # -- operations ----------------------------------------------------------

    def create(self, name) -> tuple[int, dict]:
        if not validate_drive_name(name):
            raise ApiError(
                400, "invalid_name",
                "Use lowercase letters, digits and dashes (max 32).",
            )
        with self._lock:
            if name in self._drives or self.drive_dir(name).exists():
                raise ApiError(409, "exists", f"Drive {name!r} already exists.")
            self.files_dir(name).mkdir(parents=True)
            self.prefix(name).mkdir(parents=True)
            self._drives[name] = {"state": "initializing", "error_message": None, "gen": 0, "log": None}
            self._enqueue_locked(name)
        return 201, {"name": name}

    def reset(self, name: str) -> tuple[int, dict]:
        self.require(name)
        self._stop_drive(name)
        with self._lock:
            if name not in self._drives:
                raise ApiError(404, "no_such_drive", f"No drive named {name!r}.")
            shutil.rmtree(self.prefix(name), ignore_errors=True)
            self.prefix(name).mkdir(parents=True, exist_ok=True)
            self._enqueue_locked(name)
        return 202, {"name": name}

    def delete(self, name: str) -> tuple[int, None]:
        if name == MAIN_DRIVE:
            raise ApiError(400, "cannot_delete_main", "The main drive cannot be deleted.")
        self.require(name)
        self._stop_drive(name)
        with self._lock:
            self._drives.pop(name, None)
        shutil.rmtree(self.drive_dir(name), ignore_errors=True)
        return 204, None

    def kill_server(self, name: str) -> None:
        """`wineserver -k` for the drive: ends every Wine program on it."""
        try:
            subprocess.run(
                [self.cfg.runner, "--drive", name, "--server", "-k"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=KILL_TIMEOUT,
            )
        except (subprocess.TimeoutExpired, OSError):
            pass

    # -- internals -----------------------------------------------------------

    def _stop_drive(self, name: str) -> None:
        with self._lock:
            d = self._drives.get(name)
            if d is not None:
                d["gen"] += 1  # invalidates any queued/in-flight init
            current = self._init_proc
        if current is not None and current[0] == name:
            kill_group(current[1].pid, signal.SIGKILL)
        self.kill_server(name)

    def _enqueue_locked(self, name: str) -> None:
        d = self._drives[name]
        d["gen"] += 1
        d["state"] = "initializing"
        d["error_message"] = None
        self._queue.put((name, d["gen"]))

    def _current(self, name: str, gen: int) -> bool:
        with self._lock:
            d = self._drives.get(name)
            return d is not None and d["gen"] == gen

    def _wait_for_x(self) -> None:
        while True:
            try:
                ok = subprocess.run(
                    ["xset", "q"], stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                ).returncode == 0
            except OSError:
                ok = False
            if ok:
                return
            time.sleep(0.5)

    def _worker(self) -> None:
        while True:
            name, gen = self._queue.get()
            if not self._current(name, gen):
                continue
            try:
                self._init_drive(name, gen)
            except Exception as e:  # keep the single worker alive
                with self._lock:
                    d = self._drives.get(name)
                    if d is not None and d["gen"] == gen:
                        d["state"] = "error"
                        d["error_message"] = f"initialisation failed: {e}"

    def _run_init(self, name: str, argv: list[str], log: CappedLog, timeout: float,
                  kill_on_timeout: bool = False) -> int | None:
        """Exit code, or None if it was still running after `timeout`."""
        proc = spawn_logged([self.cfg.runner, "--drive", name, *argv], None, log)
        with self._lock:
            self._init_proc = (name, proc)
        try:
            return proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            if kill_on_timeout:
                kill_group(proc.pid, signal.SIGKILL)
                proc.wait()
            return None
        finally:
            with self._lock:
                self._init_proc = None

    def _init_drive(self, name: str, gen: int) -> None:
        if self.cfg.wait_x:
            self._wait_for_x()
        log_path, log = self.logs.create(name, "wineboot")
        with self._lock:
            d = self._drives.get(name)
            if d is not None:
                d["log"] = log_path
        self.logs.prune()
        try:
            # A hung wineboot is killed rather than left to hold the single
            # worker, which would stop every other drive from being prepared.
            code = self._run_init(name, ["wineboot", "-i"], log, INIT_TIMEOUT, kill_on_timeout=True)
            if code is None:
                self.kill_server(name)  # helpers wineboot started under wineserver
            elif self._current(name, gen):
                self._run_init(name, ["--server", "-w"], log, timeout=FLUSH_TIMEOUT)
        finally:
            log.release()
        ok = code is not None and (self.prefix(name) / "system.reg").exists()
        with self._lock:
            d = self._drives.get(name)
            if d is None or d["gen"] != gen:
                return
            if ok:
                d["state"] = "ready"
                d["error_message"] = None
            elif code is None:
                d["state"] = "error"
                d["error_message"] = (
                    f"wineboot did not finish within {INIT_TIMEOUT // 60} minutes; "
                    "see the setup log, then Reset the drive to try again."
                )
            else:
                d["state"] = "error"
                d["error_message"] = f"wineboot failed (exit {code}); see the setup log."


# --------------------------------------------------------------------------
# Runs
# --------------------------------------------------------------------------


@dataclass
class Run:
    id: str
    drive: str
    label: str
    started: float
    proc: subprocess.Popen
    log_path: Path
    ended: float | None = None
    exit_code: int | None = None

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "started": self.started,
            "ended": self.ended,
            "exit_code": self.exit_code,
            "running": self.ended is None,
        }


class RunManager:
    """Programs started from the UI. In memory only: lost when the launcher
    restarts, which is what "Stop all on this drive" (wineserver -k) covers."""

    def __init__(self, cfg: Config, logs: LogStore):
        self.cfg = cfg
        self.logs = logs
        self._lock = threading.Lock()
        self._runs: dict[str, Run] = {}

    def start(self, drive: str, argv_tail: list[str], cwd: Path, label: str) -> Run:
        log_path, log = self.logs.create(drive, label)
        try:
            proc = spawn_logged([self.cfg.runner, "--drive", drive, *argv_tail], cwd, log)
        finally:
            log.release()
        run = Run(uuid.uuid4().hex[:12], drive, label, time.time(), proc, log_path)
        with self._lock:
            self._runs[run.id] = run
        self.logs.prune()
        threading.Thread(target=self._wait, args=(run,), daemon=True).start()
        return run

    def _wait(self, run: Run) -> None:
        code = run.proc.wait()
        with self._lock:
            run.exit_code = code
            run.ended = time.time()
            # Keep every running program and the newest MAX_FINISHED_RUNS
            # finished ones per drive; their logs stay protected from pruning.
            finished = sorted(
                (r for r in self._runs.values() if r.drive == run.drive and r.ended is not None),
                key=lambda r: r.ended, reverse=True,
            )
            for old in finished[MAX_FINISHED_RUNS:]:
                del self._runs[old.id]

    def log_paths(self) -> set[Path]:
        with self._lock:
            return {r.log_path for r in self._runs.values()}

    def get(self, run_id: str) -> Run:
        with self._lock:
            run = self._runs.get(run_id)
        if run is None:
            raise ApiError(404, "no_such_run", f"No run with id {run_id!r}.")
        return run

    def for_drive(self, drive: str) -> list[dict]:
        with self._lock:
            runs = [r for r in self._runs.values() if r.drive == drive]
            return [r.to_json() for r in sorted(runs, key=lambda r: r.started, reverse=True)]

    def forget_drive(self, drive: str) -> None:
        with self._lock:
            for rid in [i for i, r in self._runs.items() if r.drive == drive]:
                del self._runs[rid]

    def stop(self, run_id: str) -> tuple[int, dict]:
        run = self.get(run_id)
        if run.proc.poll() is None:
            kill_group(run.proc.pid, signal.SIGTERM)

            def escalate():
                time.sleep(STOP_GRACE)
                if run.proc.poll() is None:
                    kill_group(run.proc.pid, signal.SIGKILL)

            threading.Thread(target=escalate, daemon=True).start()
        return 202, {"id": run.id}


# --------------------------------------------------------------------------
# Application
# --------------------------------------------------------------------------


class App:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        # Logs referenced by a listed run or a drive's latest setup are never
        # pruned; the lambda is only called after both managers exist.
        self.logs = LogStore(cfg.logs, lambda: self.runs.log_paths() | self.drives.log_paths())
        self.drives = DriveManager(cfg, self.logs)
        self.runs = RunManager(cfg, self.logs)
        self.arch = os.uname().machine
        self.page_size = os.sysconf("SC_PAGE_SIZE")
        self.wine_version: str | None = None
        self._folder_lock = threading.Lock()
        self._folder_cache: dict[tuple[str, str], tuple[float, dict]] = {}

    def start(self) -> None:
        self.cfg.logs.mkdir(parents=True, exist_ok=True)
        self.drives.load()
        self.drives.start_worker()
        # Off the request path: under box64 on a Pi this takes seconds.
        threading.Thread(target=self._probe_version, daemon=True).start()

    def _probe_version(self) -> None:
        try:
            out = subprocess.run(
                [self.cfg.runner, "--version"], stdin=subprocess.DEVNULL,
                capture_output=True, text=True, timeout=30,
            )
            if out.returncode == 0 and out.stdout.strip():
                self.wine_version = out.stdout.strip()
        except (subprocess.TimeoutExpired, OSError):
            pass

    def status(self) -> dict:
        warnings = []
        if self.arch == "aarch64":
            if self.page_size == 16384:
                warnings.append(WARN_16K)
            warnings.append(WARN_BOX64)
        return {
            "arch": self.arch,
            "backend": "box64" if self.arch == "aarch64" else "native",
            "page_size": self.page_size,
            "wine_version": self.wine_version,
            "warnings": warnings,
        }

    def folder_summary(self, drive: str, name: str) -> dict:
        key = (drive, name)
        now = time.monotonic()
        with self._folder_lock:
            hit = self._folder_cache.get(key)
        if hit and now - hit[0] < FOLDER_CACHE_TTL:
            return hit[1]
        summary = summarize_folder(self.drives.files_dir(drive), name)
        with self._folder_lock:
            self._folder_cache[key] = (now, summary)
        return summary

    def invalidate_folder(self, drive: str, name: str | None = None) -> None:
        """Drop cached summaries for one folder, or all of a drive's."""
        with self._folder_lock:
            for key in [k for k in self._folder_cache if k[0] == drive and name in (None, k[1])]:
                del self._folder_cache[key]

    def list_files(self, drive: str) -> tuple[list[dict], list[dict]]:
        """Top-level .exe files and folders in the drive's files/ directory.

        Only names the API can run/delete are listed; this hides .upload-*.part
        files and anything a program wrote next to a loose .exe.
        """
        files, folders = [], []
        try:
            entries = list(self.drives.files_dir(drive).iterdir())
        except FileNotFoundError:
            return files, folders
        for p in entries:
            if split_rel_path(p.name) is None or p.is_symlink():
                continue
            if p.is_dir():
                folders.append({"name": p.name, **self.folder_summary(drive, p.name)})
            elif p.is_file() and is_exe(p.name):
                st = p.stat()
                files.append({"name": p.name, "size": st.st_size, "mtime": int(st.st_mtime)})
        files.sort(key=lambda f: f["name"].casefold())
        folders.sort(key=lambda f: f["name"].casefold())
        return files, folders

    def list_drives(self, detail: str | None = None) -> list[dict]:
        """Every drive's name and state; files, folders, programs and runs only
        for `detail` (the drive the UI shows), so the 2 s poll does not walk
        every drive's files and Start Menu."""
        result = []
        for name in self.drives.names():
            try:
                info = self.drives.info(name)
            except ApiError:
                continue  # deleted between names() and info()
            entry = {"name": name, **info}
            if name == detail:
                files, folders = self.list_files(name)
                entry.update(
                    files=files,
                    folders=folders,
                    programs=scan_programs(self.drives.prefix(name)),
                    runs=self.runs.for_drive(name),
                )
            result.append(entry)
        return result

    def delete_drive(self, name: str) -> tuple[int, None]:
        result = self.drives.delete(name)
        self.runs.forget_drive(name)
        self.invalidate_folder(name)
        return result

    def run(self, drive: str, body) -> tuple[int, dict]:
        info = self.drives.info(drive)
        if info["state"] != "ready":
            raise ApiError(409, "drive_not_ready", f"Drive {drive!r} is not ready yet.")
        if not isinstance(body, dict):
            raise ApiError(400, "bad_request", "Expected a JSON object.")
        if "file" in body:
            # A loose .exe or one inside an uploaded folder. The program runs
            # in its own directory so it finds the DLLs and data next to it.
            name = body["file"]
            parts = split_rel_path(name)
            if parts is None or not is_exe(parts[-1]):
                raise ApiError(400, "invalid_name", "Invalid file name.")
            files = self.drives.files_dir(drive)
            path = files.joinpath(*parts)
            if not path.is_file() or not contained(files, path):
                raise ApiError(404, "no_such_file", f"No file named {name!r} on this drive.")
            run = self.runs.start(drive, [str(path)], cwd=path.parent, label=name)
        elif "program" in body:
            lnk = resolve_program(self.drives.prefix(drive), body["program"])
            if lnk is None:
                raise ApiError(400, "invalid_program", "Unknown program.")
            argv, cwd = program_command(self.drives.prefix(drive), lnk)
            run = self.runs.start(drive, argv, cwd=cwd, label=lnk.stem)
        else:
            raise ApiError(400, "bad_request", 'Expected "file" or "program".')
        return 201, {"id": run.id}

    # -- drive file browser ------------------------------------------------

    def _fs_path(self, drive: str, rel) -> tuple[Path, list[str], Path]:
        """(drive root, components, path) for a browser path, or ApiError."""
        self.drives.require(drive)
        parts = split_browse_path(rel)
        if parts is None:
            raise ApiError(400, "invalid_path", "Invalid path.")
        root = self.drives.drive_dir(drive)
        return root, parts, root.joinpath(*parts)

    def _fs_existing(self, drive: str, rel) -> tuple[Path, list[str], Path]:
        """Like _fs_path, but the path must exist and resolve inside the drive
        (dosdevices/c: -> ../drive_c is fine; dosdevices/z: -> / is not)."""
        root, parts, path = self._fs_path(drive, rel)
        if not path.exists() or not contained(root, path):
            raise ApiError(404, "no_such_file", f"{'/'.join(parts) or 'The drive'} does not exist.")
        return root, parts, path

    def fs_changed(self, drive: str, parts: list[str]) -> None:
        if len(parts) >= 2 and parts[0] == "files":
            self.invalidate_folder(drive, parts[1])

    def fs_list(self, drive: str, rel) -> dict:
        root, parts, path = self._fs_existing(drive, rel)
        if not path.is_dir():
            raise ApiError(400, "not_a_directory", f"{'/'.join(parts)} is not a folder.")
        entries = []
        with os.scandir(path) as it:
            for e in it:
                entry = {"name": e.name, "link": e.is_symlink(), "size": None, "mtime": None}
                try:
                    if entry["link"] and not contained(root, Path(e.path)):
                        entry["type"] = "link"  # points outside the drive; not followed
                    elif e.is_dir():
                        entry["type"] = "dir"
                    elif e.is_file():
                        entry["type"] = "file"
                    else:
                        entry["type"] = "other"
                    if entry["type"] in ("dir", "file"):
                        st = e.stat()
                        entry["mtime"] = int(st.st_mtime)
                        if entry["type"] == "file":
                            entry["size"] = st.st_size
                except OSError:
                    entry["type"] = "other"
                entries.append(entry)
        entries.sort(key=lambda x: (x["type"] != "dir", x["name"].casefold()))
        return {
            "path": "/".join(parts),
            "entries": entries[:MAX_LIST_ENTRIES],
            "truncated": len(entries) > MAX_LIST_ENTRIES,
        }

    def fs_file(self, drive: str, rel) -> Path:
        """Resolved path of an existing regular file inside the drive."""
        _root, parts, path = self._fs_existing(drive, rel)
        if not path.is_file():
            raise ApiError(400, "not_a_file", f"{'/'.join(parts)} is not a file.")
        return path.resolve()

    def fs_read_text(self, drive: str, rel) -> dict:
        path = self.fs_file(drive, rel)
        st = path.stat()
        if st.st_size > MAX_EDIT_BYTES:
            raise ApiError(413, "too_large", "This file is too large to edit here (limit 2 MB); download it instead.")
        decoded = decode_text(path.read_bytes())
        if decoded is None:
            raise ApiError(415, "not_text", "This file is not a text file; download it instead.")
        # mtime_ns travels as a string: ~1.8e18 exceeds JavaScript's exact
        # integer range, and a rounded value would make every save a conflict.
        return {"path": rel, "mtime_ns": str(st.st_mtime_ns), "size": st.st_size, **decoded}

    def fs_write_text(self, drive: str, body) -> dict:
        if not isinstance(body, dict) or not all(
            isinstance(body.get(k), t)
            for k, t in (("path", str), ("text", str), ("encoding", str), ("newline", str), ("mtime_ns", str))
        ) or not isinstance(body.get("force", False), bool):
            raise ApiError(400, "bad_request", "Expected path, text, encoding, newline and mtime_ns.")
        path = self.fs_file(drive, body["path"])
        st = path.stat()
        # force: the user chose to overwrite a file that changed meanwhile.
        if not body.get("force", False) and str(st.st_mtime_ns) != body["mtime_ns"]:
            raise ApiError(409, "changed", "The file changed on disk since you opened it.")
        try:
            data = encode_text(body["text"], body["encoding"], body["newline"])
        except UnicodeEncodeError as e:
            raise ApiError(400, "unencodable", f"{e.object[e.start]!r} cannot be saved in this file's encoding ({body['encoding']}).")
        except ValueError:
            raise ApiError(400, "bad_request", "Unknown encoding or line ending.")
        # Atomic: write a sibling temp file, then rename over the original.
        tmp = path.with_name(f".{path.name}.umbrel-wine-{uuid.uuid4().hex[:8]}.tmp")
        try:
            tmp.write_bytes(data)
            shutil.copymode(path, tmp)
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
        self.fs_changed(drive, split_browse_path(body["path"]))
        st = path.stat()
        return {"path": body["path"], "mtime_ns": str(st.st_mtime_ns), "size": st.st_size}

    def fs_delete(self, drive: str, rel) -> None:
        root, parts, path = self._fs_path(drive, rel)
        if "/".join(parts) in PROTECTED_BROWSE_PATHS:
            raise ApiError(400, "protected", "This folder holds the drive together; use Reset or Delete drive instead.")
        # The entry itself may be a symlink pointing anywhere; only the link is
        # removed, so only its parent has to be inside the drive.
        if not (path.exists() or path.is_symlink()) or not contained(root, path.parent):
            raise ApiError(404, "no_such_file", f"{'/'.join(parts)} does not exist.")
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
        self.fs_changed(drive, parts)

    def fs_upload_target(self, drive: str, rel_dir, name) -> tuple[list[str], Path]:
        """Components and path for uploading `name` into folder `rel_dir`."""
        root, parts, folder = self._fs_existing(drive, rel_dir)
        name_parts = split_browse_path(name)
        if not name_parts or len(name_parts) != 1 or name.startswith(".upload-"):
            raise ApiError(400, "invalid_name", "Invalid file name.")
        if not folder.is_dir():
            raise ApiError(400, "not_a_directory", f"{'/'.join(parts)} is not a folder.")
        if not parts:
            raise ApiError(400, "invalid_path", "Upload into a folder inside files/ or prefix/.")
        if parts[0] == "files" and validate_upload_path("/".join(parts[1:] + name_parts)) is None:
            raise ApiError(
                400, "invalid_name",
                "Only .exe files can go directly into files/; put other files in a folder. "
                "Names in files/ cannot start with a dot, end with a dot or space, or "
                'contain <>:"\\|?*.',
            )
        return parts + name_parts, folder.resolve() / name


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


ROUTES = [
    (re.compile(r"^/api/status$"), {"GET": "get_status"}),
    (re.compile(r"^/api/drives$"), {"GET": "get_drives", "POST": "post_drive"}),
    (re.compile(r"^/api/drives/([^/]+)$"), {"DELETE": "delete_drive"}),
    (re.compile(r"^/api/drives/([^/]+)/reset$"), {"POST": "post_reset"}),
    (re.compile(r"^/api/drives/([^/]+)/stop-all$"), {"POST": "post_stop_all"}),
    (re.compile(r"^/api/drives/([^/]+)/run$"), {"POST": "post_run"}),
    # The file path may contain literal slashes or %2F (encodeURIComponent).
    (re.compile(r"^/api/drives/([^/]+)/files/(.+)$"), {"PUT": "put_file", "DELETE": "delete_file"}),
    # A whole folder as one tar stream (the UI's folder upload).
    (re.compile(r"^/api/drives/([^/]+)/folders/([^/]+)$"), {"PUT": "put_folder"}),
    # File browser: ?path= is relative to the drive (files/..., prefix/...).
    (re.compile(r"^/api/drives/([^/]+)/fs$"), {"DELETE": "delete_fs"}),
    (re.compile(r"^/api/drives/([^/]+)/fs/list$"), {"GET": "get_fs_list"}),
    (re.compile(r"^/api/drives/([^/]+)/fs/text$"), {"GET": "get_fs_text", "PUT": "put_fs_text"}),
    (re.compile(r"^/api/drives/([^/]+)/fs/download$"), {"GET": "get_fs_download"}),
    (re.compile(r"^/api/drives/([^/]+)/fs/upload$"), {"PUT": "put_fs_upload"}),
    (re.compile(r"^/api/runs/([^/]+)/stop$"), {"POST": "post_run_stop"}),
    (re.compile(r"^/api/runs/([^/]+)/log$"), {"GET": "get_run_log"}),
    (re.compile(r"^/api/drives/([^/]+)/setup-log$"), {"GET": "get_setup_log"}),
]


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.1 so keep-alive works and Expect: 100-continue can be answered
    # only AFTER the upload pre-checks pass (see handle_expect_100).
    protocol_version = "HTTP/1.1"
    server_version = "umbrel-wine"
    app: App  # set by make_server

    # -- plumbing ------------------------------------------------------------

    def handle(self):
        # A client that goes away (cancelled upload, closed tab) resets the
        # connection; that is not an error worth a traceback in the app log.
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            pass

    def handle_expect_100(self):
        # Defer: put_file sends 100 Continue once its checks pass, so a
        # rejected upload is refused before the client sends the body.
        return True

    def log_request(self, code="-", size="-"):
        if self.command != "GET" or (isinstance(code, int) and code >= 400):
            super().log_request(code, size)

    def send_error(self, code, message=None, explain=None):
        # http.server's own errors (bad request line, unknown method) as JSON.
        self.close_connection = True
        self._send_json(code, {"error": "http_error", "message": message or self.responses.get(code, ("",))[0]}, close=True)

    def _send_body(self, status: int, body: bytes, ctype: str, close=False, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, status: int, obj, close=False):
        if status == 204:
            self.send_response(204)
            if close:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            return
        body = json.dumps(obj).encode()
        self._send_body(status, body, "application/json", close=close)

    def _send_api_error(self, e: ApiError, close=False):
        self._send_json(e.status, {"error": e.code, "message": e.message}, close=close)

    def _read_json(self, limit=MAX_JSON_BODY):
        length = self.headers.get("Content-Length")
        if length is None:
            return {}
        try:
            n = int(length)
        except ValueError:
            raise ApiError(400, "bad_request", "Invalid Content-Length.")
        if n < 0 or n > limit:
            self.close_connection = True
            raise ApiError(413, "too_large", "Request body too large.")
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except ValueError:
            raise ApiError(400, "bad_request", "Body is not valid JSON.")

    def _dispatch(self):
        parts = urlsplit(self.path)
        self.query = parse_qs(parts.query)
        path = parts.path
        try:
            if path in STATIC_FILES:
                if self.command not in ("GET", "HEAD"):
                    raise ApiError(405, "method_not_allowed", "Method not allowed.")
                return self._static(path)
            for pattern, methods in ROUTES:
                m = pattern.match(path)
                if not m:
                    continue
                handler = methods.get(self.command)
                if handler is None:
                    raise ApiError(405, "method_not_allowed", "Method not allowed.")
                return getattr(self, handler)(*(unquote(g) for g in m.groups()))
            raise ApiError(404, "not_found", "Not found.")
        except ApiError as e:
            self._send_api_error(e, close=self.close_connection)
        except Exception as e:  # never leak a traceback page
            self.log_error("internal error: %r", e)
            self._send_json(500, {"error": "internal", "message": str(e)}, close=True)

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = _dispatch

    # -- static ------------------------------------------------------------

    def _static(self, path: str):
        fname, ctype = STATIC_FILES[path]
        try:
            body = (self.app.cfg.web / fname).read_bytes()
        except FileNotFoundError:
            raise ApiError(404, "not_found", "Not found.")
        self._send_body(200, body, ctype, extra={"Cache-Control": "no-cache"})

    # -- API ---------------------------------------------------------------

    def get_status(self):
        self._send_json(200, self.app.status())

    def get_drives(self):
        self._send_json(200, self.app.list_drives(self._q("drive") or None))

    def post_drive(self):
        body = self._read_json()
        name = body.get("name") if isinstance(body, dict) else None
        self._send_json(*self.app.drives.create(name))

    def delete_drive(self, drive):
        self._send_json(*self.app.delete_drive(drive))

    def post_reset(self, drive):
        self._send_json(*self.app.drives.reset(drive))

    def post_stop_all(self, drive):
        # `wineserver -k` during setup would kill wineboot and leave a failed
        # or half-built prefix that only Reset recovers.
        if self.app.drives.info(drive)["state"] == "initializing":
            raise ApiError(409, "drive_not_ready", "This drive is still being prepared; wait for it to finish.")
        self.app.drives.kill_server(drive)
        self._send_json(202, {})

    def post_run(self, drive):
        self.app.drives.require(drive)
        body = self._read_json()
        self._send_json(*self.app.run(drive, body))

    def post_run_stop(self, run_id):
        self._send_json(*self.app.runs.stop(run_id))

    def get_run_log(self, run_id):
        self._send_log(self.app.runs.get(run_id).log_path)

    def get_setup_log(self, drive):
        self._send_log(self.app.drives.setup_log(drive))

    def _send_log(self, path: Path | None):
        """The log's last LOG_TAIL bytes as text; with ?download=1, the whole
        log (capped at ~4 MiB by CappedLog) as an attachment."""
        if self._q("download") != "1":
            text = read_tail(path).decode("utf-8", errors="replace").encode("utf-8")
            self._send_body(200, text, "text/plain; charset=utf-8", extra={"Cache-Control": "no-cache"})
            return
        try:
            data = path.read_bytes() if path is not None else None
        except FileNotFoundError:
            data = None
        if data is None:
            raise ApiError(404, "no_log", "This log does not exist (yet).")
        self._send_body(200, data, "text/plain; charset=utf-8", extra={
            "Cache-Control": "no-cache",
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(path.name)}",
        })

    def delete_file(self, drive, name):
        """Delete a loose .exe, a file inside a folder, or a whole folder."""
        self.app.drives.require(drive)
        parts = split_rel_path(name)
        files = self.app.drives.files_dir(drive)
        target = files.joinpath(*parts) if parts else None
        if (
            target is None
            or not (target.exists() or target.is_symlink())
            or not contained(files, target.parent)
        ):
            raise ApiError(404, "no_such_file", f"No file named {name!r} on this drive.")
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
        self.app.invalidate_folder(drive, parts[0])
        self._send_json(204, None)

    def put_file(self, drive, name):
        self._guarded_upload(self._receive_upload, drive, name)

    def put_fs_upload(self, drive):
        self._guarded_upload(self._receive_fs_upload, drive)

    def put_folder(self, drive, name):
        self._guarded_upload(self._receive_folder, drive, name)

    def _guarded_upload(self, receive, *args):
        self._upload_left = None  # body bytes still unread; None = unknown
        try:
            receive(*args)
        except ApiError as e:
            self._send_api_error(e, close=True)
            self._linger(self._upload_left)

    def _linger(self, left):
        """Lingering close after rejecting an upload early.

        nginx streams the body to us unbuffered (proxy_request_buffering off).
        If we closed right after the error response, its next write would hit
        EPIPE before it read our response, and the browser would get a 502
        instead of e.g. the 409 that drives the "Replace it?" prompt. So:
        half-close (the response is complete), then discard the body until the
        peer closes, it is fully consumed, or LINGER_SECONDS pass.
        """
        try:
            self.wfile.flush()
            self.connection.shutdown(socket.SHUT_WR)
        except OSError:
            return
        deadline = time.monotonic() + LINGER_SECONDS
        while left is None or left > 0:
            wait = deadline - time.monotonic()
            if wait <= 0:
                return
            try:
                self.connection.settimeout(wait)
                data = self.connection.recv(CHUNK)
            except OSError:  # includes the timeout
                return
            if not data:
                return
            if left is not None:
                left -= len(data)

    def _read_body(self, n: int) -> bytes:
        """Up to n bytes of the declared body; ClientGone if it ends early."""
        n = min(n, self._upload_left)
        if n <= 0:
            return b""
        data = self.rfile.read(n)
        if not data:
            raise ClientGone()
        self._upload_left -= len(data)
        return data

    def _receive_folder(self, drive, name):
        """A whole folder as one tar stream, built by the browser.

        One request instead of one per file: thousands of small files are no
        longer bound by per-request overhead through the Umbrel gateway, the
        browser shows one exact progress bar, and a single abort cancels it.
        The archive is unpacked into a hidden staging folder and swapped in
        only once complete, so a failed, cancelled or interrupted upload never
        touches an existing folder and never leaves a partial one behind.
        """
        self.close_connection = True
        self.app.drives.require(drive)
        parts = split_rel_path(name)
        if parts is None or len(parts) != 1:
            raise ApiError(400, "invalid_name", "Invalid folder name.")
        total = self._upload_length()
        files = self.app.drives.files_dir(drive)
        target = files / name
        if target.is_symlink() or (target.exists() and not target.is_dir()):
            raise ApiError(409, "exists", f"{name} already exists on this drive and is not a folder.")
        if target.exists() and self._q("replace") != "1":
            raise ApiError(409, "exists", f"Folder {name} already exists on this drive.")
        if self.headers.get("Expect", "").lower() == "100-continue":
            self.send_response_only(100)
            self.end_headers()

        handler = self

        class Body:
            def read(self, n=-1):
                return handler._read_body(handler._upload_left if n is None or n < 0 else n)

        staging = files / f".upload-{uuid.uuid4().hex}.dir"
        staging.mkdir()
        swapped = False
        try:
            try:
                count, size = extract_folder_tar(Body(), staging)
                while self._read_body(CHUNK):  # tar end padding
                    pass
            except ClientGone:
                return  # cancelled: nobody is listening for a response
            except tarfile.TarError as e:
                raise ApiError(400, "bad_archive", f"The upload is not a valid folder archive ({e}).")
            old = None
            if target.exists():
                old = files / f".upload-{uuid.uuid4().hex}.old"
                os.rename(target, old)
            try:
                os.rename(staging, target)
                swapped = True
            finally:
                if old is not None:
                    if swapped:
                        shutil.rmtree(old, ignore_errors=True)
                    else:
                        os.rename(old, target)
        finally:
            if not swapped:
                shutil.rmtree(staging, ignore_errors=True)
        self.app.invalidate_folder(drive, name)
        self.close_connection = False
        self._send_json(201, {"name": name, "files": count, "size": size})

    def _upload_length(self) -> int:
        """Content-Length of an upload, checked against free space."""
        length = self.headers.get("Content-Length")
        if length is None:
            raise ApiError(411, "length_required", "Content-Length is required.")
        try:
            total = int(length)
            if total < 0:
                raise ValueError
        except ValueError:
            raise ApiError(400, "bad_request", "Invalid Content-Length.")
        self._upload_left = total
        free = shutil.disk_usage(self.app.cfg.root).free
        if total > free - UPLOAD_RESERVE:
            raise ApiError(507, "insufficient_storage", "Not enough free space on the Umbrel for this file.")
        return total

    def _stream_upload(self, target: Path, part_dir: Path, name: str, total: int, check_mz: bool) -> bool:
        """Stream the body to part_dir/.upload-*.part, then move it onto target
        (creating missing parent folders). False if the client went away."""
        if self.headers.get("Expect", "").lower() == "100-continue":
            self.send_response_only(100)
            self.end_headers()
        part = part_dir / f".upload-{uuid.uuid4().hex}.part"
        done = False
        try:
            with open(part, "wb") as f:
                remaining = total
                first = True
                while remaining > 0 or first:
                    chunk = self.rfile.read(min(CHUNK, remaining)) if remaining > 0 else b""
                    if first:
                        first = False
                        if check_mz and chunk[:2] != b"MZ":
                            self._upload_left = remaining - len(chunk)
                            raise ApiError(
                                415, "not_a_windows_executable",
                                f"{name} is not a Windows executable.",
                            )
                    if remaining > 0 and not chunk:
                        return False  # client went away mid-upload; nothing to answer
                    f.write(chunk)
                    remaining -= len(chunk)
                    self._upload_left = remaining
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(part, target)
            done = True
        finally:
            if not done:
                part.unlink(missing_ok=True)
        return True

    def _receive_upload(self, drive, name):
        # Every check runs before any of the body is read; on failure the
        # connection is closed so the unread body is never parsed as a request.
        self.close_connection = True
        self.app.drives.require(drive)
        parts = validate_upload_path(name)
        if parts is None:
            raise ApiError(
                400, "invalid_name",
                "A file uploaded on its own must be a .exe; upload the folder that "
                "contains it to include other files. Names cannot start with a dot "
                'or contain <>:"\\|?*.',
            )
        total = self._upload_length()
        files = self.app.drives.files_dir(drive)
        target = files.joinpath(*parts)
        # Every existing ancestor must be a real directory inside files/, and
        # the target must not be one.
        for i in range(1, len(parts)):
            ancestor = files.joinpath(*parts[:i])
            if ancestor.is_symlink() or (ancestor.exists() and not ancestor.is_dir()):
                raise ApiError(409, "exists", f"{'/'.join(parts[:i])} already exists on this drive and is not a folder.")
        if target.is_dir() or target.is_symlink():
            raise ApiError(409, "exists", f"{name} already exists on this drive as a folder.")
        if target.exists() and self._q("overwrite") != "1":
            raise ApiError(409, "exists", f"{name} already exists on this drive.")
        if self._stream_upload(target, files, name, total, check_mz=is_exe(parts[-1])):
            self.app.invalidate_folder(drive, parts[0])
            self.close_connection = False
            self._send_json(201, {"name": name, "size": total})

    def _receive_fs_upload(self, drive):
        """File-browser upload: any file into an existing folder of the drive.
        Inside files/ the sidebar's rules apply, so everything uploaded there
        is listed and runnable: a loose file must be a .exe, and a .exe must
        start with MZ."""
        self.close_connection = True
        name = self._q("name")
        parts, target = self.app.fs_upload_target(drive, self._q("path"), name)
        total = self._upload_length()
        rel = "/".join(parts)
        if target.is_dir():
            raise ApiError(409, "exists", f"{rel} already exists as a folder.")
        if target.exists() and self._q("overwrite") != "1":
            raise ApiError(409, "exists", f"{name} already exists in this folder.")
        # The part file lives in files/ (same filesystem), where startup
        # cleans up leftovers.
        check_mz = parts[0] == "files" and is_exe(name)
        if self._stream_upload(target, self.app.drives.files_dir(drive), name, total, check_mz=check_mz):
            self.app.fs_changed(drive, parts)
            self.close_connection = False
            self._send_json(201, {"path": rel, "size": total})

    # -- drive file browser ------------------------------------------------

    def _q(self, key: str) -> str:
        return self.query.get(key, [""])[0]

    def get_fs_list(self, drive):
        self._send_json(200, self.app.fs_list(drive, self._q("path")))

    def get_fs_text(self, drive):
        self._send_json(200, self.app.fs_read_text(drive, self._q("path")))

    def put_fs_text(self, drive):
        self._send_json(200, self.app.fs_write_text(drive, self._read_json(limit=MAX_TEXT_BODY)))

    def delete_fs(self, drive):
        self.app.fs_delete(drive, self._q("path"))
        self._send_json(204, None)

    def get_fs_download(self, drive):
        path = self.app.fs_file(drive, self._q("path"))
        with open(path, "rb") as f:
            remaining = os.fstat(f.fileno()).st_size
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(remaining))
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(path.name)}")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            while remaining > 0:
                chunk = f.read(min(CHUNK, remaining))
                if not chunk:
                    self.close_connection = True  # file shrank; the length was a lie
                    return
                self.wfile.write(chunk)
                remaining -= len(chunk)


def make_server(app: App) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"app": app})
    server = ThreadingHTTPServer((app.cfg.bind, app.cfg.port), handler)
    server.daemon_threads = True
    return server


def main() -> None:
    app = App(Config.from_env())
    app.start()
    server = make_server(app)
    print(f"umbrel-wine launcher listening on {app.cfg.bind}:{server.server_port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
