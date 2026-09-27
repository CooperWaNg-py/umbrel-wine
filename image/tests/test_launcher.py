"""Launcher tests: pure helpers plus the HTTP API against a fake Wine runner.

Run from the repo root:  python3 -m unittest discover -s image/tests -v
"""

import http.client
import json
import os
import shutil
import struct
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "root" / "opt" / "umbrel-wine"))

import launcher  # noqa: E402

# Stands in for /usr/local/bin/umbrel-wine. wineboot creates system.reg like the
# real thing; the drive named `broken` fails every command, drives named
# `slow*` hang in wineboot, and spam.exe floods its output.
FAKE_RUNNER = """#!/usr/bin/env bash
root="{root}"
drive=main
server=0
while [ $# -gt 0 ]; do
  case "$1" in
    --drive) drive="$2"; shift 2 ;;
    --server) server=1; shift ;;
    *) break ;;
  esac
done
if [ "$1" = "--version" ]; then echo wine-11.0; exit 0; fi
if [ "$drive" = "broken" ]; then echo "boom"; exit 1; fi
case "$drive" in slow*) [ "$1" = "wineboot" ] && {{ echo "hanging"; sleep 60; }} ;; esac
case "$*" in *spam.exe*) seq 1 20000; exit 0 ;; esac
if [ "$server" = 0 ] && [ "$1" = "wineboot" ]; then
  mkdir -p "$root/drives/$drive/prefix"
  echo "WINE REGISTRY Version 2" > "$root/drives/$drive/prefix/system.reg"
fi
if [ "$server" = 0 ]; then echo "ran $* in $(pwd -P)"; fi
exit 0
"""


class LnkTests(unittest.TestCase):
    def test_parse_lnk(self):
        data = make_lnk(r"C:\Program Files\App\app.exe", r'-a "b c"', r"C:\Program Files\App")
        self.assertEqual(launcher.parse_lnk(data), {
            "target": r"C:\Program Files\App\app.exe",
            "workdir": r"C:\Program Files\App",
            "args": r'-a "b c"',
        })
        self.assertIsNone(launcher.parse_lnk(b"not a shortcut"))
        self.assertIsNone(launcher.parse_lnk(data[:0x60]))  # truncated

    def test_split_windows_args(self):
        cases = {
            "": [],
            'a  "b c" d': ["a", "b c", "d"],
            r'a\"b': ['a"b'],
            r'"a\\" b': ["a\\", "b"],
            r"C:\dir\file": [r"C:\dir\file"],
            '"say ""hi"""': ['say "hi"'],
        }
        for s, expected in cases.items():
            self.assertEqual(launcher.split_windows_args(s), expected, s)

    def test_program_command(self):
        with tempfile.TemporaryDirectory() as d:
            prefix = Path(d)
            (prefix / "drive_c/Games/X").mkdir(parents=True)
            lnk = prefix / "drive_c/users/abc/Desktop/X.lnk"
            lnk.parent.mkdir(parents=True)
            lnk.write_bytes(make_lnk(r"C:\Games\X\x.exe", "-fast"))
            self.assertEqual(launcher.program_command(prefix, lnk),
                             ([r"C:\Games\X\x.exe", "-fast"], prefix / "drive_c/Games/X"))
            lnk.write_bytes(b"garbage")
            self.assertEqual(launcher.program_command(prefix, lnk),
                             (["start", "/unix", str(lnk)], lnk.parent))


def make_lnk(target: str, args: str = "", workdir: str = "") -> bytes:
    """Minimal MS-SHLLINK file: Unicode LinkInfo (header 0x24) + string data."""
    flags = 0x02 | 0x80 | (0x10 if workdir else 0) | (0x20 if args else 0)
    header = bytearray(0x4C)
    struct.pack_into("<I", header, 0, 0x4C)
    struct.pack_into("<I", header, 20, flags)
    volume = struct.pack("<IIII", 0x11, 3, 0, 0x10) + b"\0"
    ansi_base, ansi_suffix = target.encode("cp1252") + b"\0", b"\0"
    uni_base, uni_suffix = target.encode("utf-16-le") + b"\0\0", b"\0\0"
    vol_off = 0x24
    base_off = vol_off + len(volume)
    suffix_off = base_off + len(ansi_base)
    base_u_off = suffix_off + len(ansi_suffix)
    suffix_u_off = base_u_off + len(uni_base)
    body = volume + ansi_base + ansi_suffix + uni_base + uni_suffix
    size = 0x24 + len(body)
    linkinfo = struct.pack("<9I", size, 0x24, 1, vol_off, base_off, 0, suffix_off, base_u_off, suffix_u_off) + body
    strings = b""
    for s in (workdir, args):
        if s:
            strings += struct.pack("<H", len(s)) + s.encode("utf-16-le")
    return bytes(header) + linkinfo + strings


class HelperTests(unittest.TestCase):
    def test_validate_upload_path(self):
        for bad in ("../a.exe", ".a.exe", "a.txt", "", "a.exe/", "Game/.DS_Store",
                    "Game/../x.exe", "Game//x.dll", "Game/a:b", "Game/a\\b", "Game/x.",
                    "Game/x ", "Game/tab\there", None):
            self.assertIsNone(launcher.validate_upload_path(bad), bad)
        self.assertEqual(launcher.validate_upload_path("Setup (x64).exe"), ["Setup (x64).exe"])
        self.assertEqual(launcher.validate_upload_path("7z2409-x64.EXE"), ["7z2409-x64.EXE"])
        self.assertEqual(launcher.validate_upload_path("Game/data/Über level.pak"),
                         ["Game", "data", "Über level.pak"])

    def test_text_round_trips_byte_for_byte(self):
        samples = {
            b"\xff\xfe" + "[fonts]\r\nA=1\r\n".encode("utf-16-le"): ("utf-16-le", "\r\n"),
            b"\xef\xbb\xbf" + "x=ü\n".encode(): ("utf-8-bom", "\n"),
            "k=ü\r\n".encode(): ("utf-8", "\r\n"),
            b"name=caf\xe9\r\n": ("cp1252", "\r\n"),
            b"odd=\x81\x8d": ("latin-1", "\n"),  # bytes cp1252 leaves undefined
        }
        for data, (encoding, newline) in samples.items():
            decoded = launcher.decode_text(data)
            self.assertEqual((decoded["encoding"], decoded["newline"]), (encoding, newline), data)
            self.assertNotIn("\r", decoded["text"])
            self.assertEqual(launcher.encode_text(**decoded), data)
        self.assertIsNone(launcher.decode_text(b"MZ\x90\x00\x03"))
        with self.assertRaises(UnicodeEncodeError):
            launcher.encode_text("€", "latin-1", "\n")


    def test_validate_drive_name(self):
        self.assertTrue(launcher.validate_drive_name("main"))
        self.assertTrue(launcher.validate_drive_name("a" * 32))
        for bad in ("Bad Name", "-x", "a" * 33, "../x", ""):
            self.assertFalse(launcher.validate_drive_name(bad), bad)

    def test_scan_programs(self):
        with tempfile.TemporaryDirectory() as d:
            prefix = Path(d)
            menu = prefix / "drive_c/ProgramData/Microsoft/Windows/Start Menu/Programs/7-Zip"
            menu.mkdir(parents=True)
            (menu / "7-Zip File Manager.lnk").write_bytes(b"L")
            (menu / "Uninstall 7-Zip.lnk").write_bytes(b"L")
            (menu / "readme.txt").write_bytes(b"x")
            desk = prefix / "drive_c/users/abc/Desktop"
            desk.mkdir(parents=True)
            (desk / "7-Zip File Manager.lnk").write_bytes(b"L")  # duplicate name
            (desk / "alpha.LNK").write_bytes(b"L")
            self.assertEqual(
                launcher.scan_programs(prefix),
                [
                    {
                        "name": "7-Zip File Manager",
                        "path": "drive_c/ProgramData/Microsoft/Windows/Start Menu/Programs/7-Zip/7-Zip File Manager.lnk",
                    },
                    {"name": "alpha", "path": "drive_c/users/abc/Desktop/alpha.LNK"},
                ],
            )

    def test_resolve_program(self):
        with tempfile.TemporaryDirectory() as d:
            prefix = Path(d)
            lnk = prefix / "drive_c/users/abc/Desktop/app.lnk"
            lnk.parent.mkdir(parents=True)
            lnk.write_bytes(b"L")
            (prefix / "outside.lnk").write_bytes(b"L")
            self.assertEqual(
                launcher.resolve_program(prefix, "drive_c/users/abc/Desktop/app.lnk"),
                Path(os.path.abspath(lnk)),
            )
            for bad in ("../../etc/passwd.lnk", "outside.lnk", "drive_c/../outside.lnk",
                        "drive_c/users/abc/Desktop/missing.lnk", "drive_c/users", 5, None):
                self.assertIsNone(launcher.resolve_program(prefix, bad), bad)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Uploads keep a 512 MiB free-space reserve; don't let the test host's
        # disk decide the outcome.
        cls._reserve = launcher.UPLOAD_RESERVE
        launcher.UPLOAD_RESERVE = 0
        # A hung wineboot is given up on after INIT_TIMEOUT; keep that short.
        cls._init_timeout = launcher.INIT_TIMEOUT
        launcher.INIT_TIMEOUT = 2
        cls.tmp = tempfile.mkdtemp(prefix="umbrel-wine-test-")
        root = Path(cls.tmp) / "config"
        (root / "drives" / "broken").mkdir(parents=True)
        runner = Path(cls.tmp) / "runner"
        runner.write_text(FAKE_RUNNER.format(root=root))
        runner.chmod(0o755)
        web = Path(cls.tmp) / "web"
        web.mkdir()
        (web / "index.html").write_text("<html>launcher</html>")
        cfg = launcher.Config(root=root, port=0, bind="127.0.0.1", runner=str(runner),
                              web=web, wait_x=False)
        cls.root = root
        cls.app = launcher.App(cfg)
        cls.app.start()
        cls.server = launcher.make_server(cls.app)
        cls.port = cls.server.server_port
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.wait_state("main", "ready")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)
        launcher.UPLOAD_RESERVE = cls._reserve
        launcher.INIT_TIMEOUT = cls._init_timeout

    @classmethod
    def request(cls, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=10)
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
            headers = {"Content-Type": "application/json", **(headers or {})}
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        ctype = resp.getheader("Content-Type", "")
        return resp.status, (json.loads(data) if data and "json" in ctype else data)

    @classmethod
    def drive(cls, name):
        _, drives = cls.request("GET", "/api/drives")
        return next((d for d in drives if d["name"] == name), None)

    @classmethod
    def wait_state(cls, name, state, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            d = cls.drive(name)
            if d and d["state"] == state:
                return d
            time.sleep(0.05)
        raise AssertionError(f"drive {name} never reached {state}: {cls.drive(name)}")

    def files_dir(self):
        return self.root / "drives" / "main" / "files"

    def wait_log(self, run_id):
        deadline = time.time() + 10
        while time.time() < deadline:
            _, log = self.request("GET", f"/api/runs/{run_id}/log")
            if log:
                return log
            time.sleep(0.05)
        raise AssertionError(f"run {run_id} never logged anything")

    def fs(self, method, endpoint, body=None, **query):
        from urllib.parse import urlencode
        return self.request(method, f"/api/drives/main/fs{endpoint}?{urlencode(query)}", body)

    def test_folder_upload_listing_run_delete(self):
        base = "/api/drives/main/files/"
        status, _ = self.request("PUT", base + "Game%2Fbin%2Fgame.exe", b"MZgame")
        self.assertEqual(status, 201)
        # Literal slashes work too; non-.exe files inside a folder are not MZ-checked.
        status, _ = self.request("PUT", base + "Game/data/level%201.pak", b"\0\1data")
        self.assertEqual(status, 201)
        status, body = self.request("PUT", base + "Game%2Fbin%2Fhelper.exe", b"notmz")
        self.assertEqual((status, body["error"]), (415, "not_a_windows_executable"))
        status, body = self.request("PUT", base + "Game%2Fbin%2Fgame.exe%2Fx.dll", b"x")
        self.assertEqual((status, body["error"]), (409, "exists"))

        main = self.drive("main")
        self.assertNotIn("Game", [f["name"] for f in main["files"]])
        self.assertIn({"name": "Game", "size": 12, "file_count": 2,
                       "executables": ["Game/bin/game.exe"]}, main["folders"])

        # A file added through the browser shows up at once (cache invalidated).
        status, _ = self.fs("PUT", "/upload", b"cfg", path="files/Game", name="game.cfg")
        self.assertEqual(status, 201)
        game = next(f for f in self.drive("main")["folders"] if f["name"] == "Game")
        self.assertEqual(game["file_count"], 3)

        # The program runs in its own folder so it finds its DLLs and data.
        status, body = self.request("POST", "/api/drives/main/run", {"file": "Game/bin/game.exe"})
        self.assertEqual(status, 201)
        bin_dir = (self.files_dir() / "Game/bin").resolve()
        self.assertEqual(self.wait_log(body["id"]).strip(),
                         f"ran {self.files_dir() / 'Game/bin/game.exe'} in {bin_dir}".encode())

        status, _ = self.request("DELETE", base + "Game")
        self.assertEqual(status, 204)
        self.assertFalse((self.files_dir() / "Game").exists())
        self.assertEqual([f for f in self.drive("main")["folders"] if f["name"] == "Game"], [])

    def test_browse_follows_links_only_inside_the_drive(self):
        dosdevices = self.root / "drives/main/prefix/dosdevices"
        dosdevices.mkdir(exist_ok=True)
        (dosdevices.parent / "drive_c").mkdir(exist_ok=True)
        for name, target in (("c:", "../drive_c"), ("z:", "/")):
            if not (dosdevices / name).is_symlink():
                (dosdevices / name).symlink_to(target)
        status, root = self.fs("GET", "/list", path="")
        self.assertEqual(status, 200)
        self.assertEqual([e["name"] for e in root["entries"]][:2], ["files", "prefix"])
        _, listing = self.fs("GET", "/list", path="prefix/dosdevices")
        types = {e["name"]: (e["type"], e["link"]) for e in listing["entries"]}
        self.assertEqual(types["c:"], ("dir", True))
        self.assertEqual(types["z:"], ("link", True))
        status, _ = self.fs("GET", "/list", path="prefix/dosdevices/c:")
        self.assertEqual(status, 200)
        for path in ("prefix/dosdevices/z:", "prefix/dosdevices/z:/etc"):
            status, body = self.fs("GET", "/list", path=path)
            self.assertEqual((status, body["error"]), (404, "no_such_file"), path)
        for path in ("..", "prefix/../..", "/etc"):
            status, body = self.fs("GET", "/list", path=path)
            self.assertEqual((status, body["error"]), (400, "invalid_path"), path)
        # Deleting a link removes only the link.
        status, _ = self.fs("DELETE", "", path="prefix/dosdevices/z:")
        self.assertEqual(status, 204)
        self.assertFalse((dosdevices / "z:").is_symlink())
        self.assertTrue(Path("/etc").exists())

    def test_edit_text_file_keeps_encoding_and_detects_changes(self):
        ini = self.root / "drives/main/prefix/drive_c/windows/win.ini"
        ini.parent.mkdir(parents=True, exist_ok=True)
        ini.write_bytes(b"\xff\xfe" + "[fonts]\r\n".encode("utf-16-le"))
        status, doc = self.fs("GET", "/text", path="prefix/drive_c/windows/win.ini")
        self.assertEqual(status, 200)
        self.assertEqual((doc["text"], doc["encoding"], doc["newline"]), ("[fonts]\n", "utf-16-le", "\r\n"))
        save = {**doc, "text": "[fonts]\n[desktop]\n"}
        status, saved = self.fs("PUT", "/text", {k: save[k] for k in ("path", "text", "encoding", "newline", "mtime_ns")})
        self.assertEqual(status, 200)
        self.assertEqual(ini.read_bytes(), b"\xff\xfe" + "[fonts]\r\n[desktop]\r\n".encode("utf-16-le"))
        # Saving again from the stale copy is refused, e.g. after Wine rewrote the file.
        status, body = self.fs("PUT", "/text", {k: save[k] for k in ("path", "text", "encoding", "newline", "mtime_ns")})
        self.assertEqual((status, body["error"]), (409, "changed"))
        status, body = self.fs("PUT", "/text", {**{k: save[k] for k in ("path", "encoding", "newline")},
                                               "text": "\U0001F600", "mtime_ns": saved["mtime_ns"], "encoding": "cp1252"})
        self.assertEqual((status, body["error"]), (400, "unencodable"))
        (ini.parent / "bin.dat").write_bytes(b"\x00\x01\x02")
        status, body = self.fs("GET", "/text", path="prefix/drive_c/windows/bin.dat")
        self.assertEqual((status, body["error"]), (415, "not_text"))
        status, data = self.fs("GET", "/download", path="prefix/drive_c/windows/bin.dat")
        self.assertEqual((status, data), (200, b"\x00\x01\x02"))

    def test_browser_upload_and_protected_folders(self):
        (self.root / "drives/main/prefix/drive_c").mkdir(parents=True, exist_ok=True)
        status, body = self.fs("PUT", "/upload", b"dll", path="prefix/drive_c", name="mod.dll")
        self.assertEqual((status, body), (201, {"path": "prefix/drive_c/mod.dll", "size": 3}))
        status, body = self.fs("PUT", "/upload", b"dll2", path="prefix/drive_c", name="mod.dll")
        self.assertEqual((status, body["error"]), (409, "exists"))
        status, _ = self.fs("PUT", "/upload", b"dll2", path="prefix/drive_c", name="mod.dll", overwrite="1")
        self.assertEqual(status, 201)
        self.assertEqual((self.root / "drives/main/prefix/drive_c/mod.dll").read_bytes(), b"dll2")
        for name in ("a/b.dll", "..", ".upload-x.part"):
            status, body = self.fs("PUT", "/upload", b"x", path="prefix/drive_c", name=name)
            self.assertEqual((status, body["error"]), (400, "invalid_name"), name)
        for path in ("", "prefix", "files"):
            status, body = self.fs("DELETE", "", path=path)
            self.assertEqual((status, body["error"]), (400, "protected"), path)
        status, _ = self.fs("DELETE", "", path="prefix/drive_c/mod.dll")
        self.assertEqual(status, 204)
        status, body = self.fs("PUT", "/upload", b"x", path="", name="stray.txt")
        self.assertEqual((status, body["error"]), (400, "invalid_path"))


    def test_status(self):
        status, body = self.request("GET", "/api/status")
        self.assertEqual(status, 200)
        self.assertIn(body["backend"], ("native", "box64"))
        self.assertIsInstance(body["page_size"], int)

    def test_rejected_upload_lets_client_finish_sending(self):
        # nginx streams the body upstream unbuffered; if the launcher closes
        # right after an early 409, nginx hits EPIPE and answers 502 instead.
        import socket
        self.request("PUT", "/api/drives/main/files/dup.exe", b"MZdup")
        body = b"MZ" + b"\0" * (16 * 1024 * 1024)
        with socket.create_connection(("127.0.0.1", self.port), timeout=10) as s:
            s.sendall(
                b"PUT /api/drives/main/files/dup.exe HTTP/1.1\r\nHost: t\r\n"
                + f"Content-Length: {len(body)}\r\n\r\n".encode()
            )
            time.sleep(0.2)  # let the server answer and (formerly) close
            s.sendall(body)  # ConnectionResetError/BrokenPipeError before the fix
            resp = b""
            while chunk := s.recv(65536):
                resp += chunk
        self.assertTrue(resp.startswith(b"HTTP/1.1 409"), resp[:80])

    def test_drive_states(self):
        self.assertTrue((self.root / "drives/main/prefix/system.reg").exists())
        d = self.wait_state("broken", "error")
        self.assertIn("wineboot failed (exit 1)", d["error_message"])
        _, drives = self.request("GET", "/api/drives")
        self.assertEqual(drives[0]["name"], "main")

    def test_create_bad_name(self):
        status, body = self.request("POST", "/api/drives", {"name": "Bad Name"})
        self.assertEqual((status, body["error"]), (400, "invalid_name"))

    def test_create_reset_delete(self):
        status, _ = self.request("POST", "/api/drives", {"name": "test2"})
        self.assertEqual(status, 201)
        status, body = self.request("POST", "/api/drives", {"name": "test2"})
        self.assertEqual((status, body["error"]), (409, "exists"))
        self.wait_state("test2", "ready")
        status, _ = self.request("POST", "/api/drives/test2/reset")
        self.assertEqual(status, 202)
        self.wait_state("test2", "ready")
        status, _ = self.request("DELETE", "/api/drives/test2")
        self.assertEqual(status, 204)
        self.assertFalse((self.root / "drives/test2").exists())
        self.assertIsNone(self.drive("test2"))
        status, body = self.request("POST", "/api/drives/test2/reset")
        self.assertEqual((status, body["error"]), (404, "no_such_drive"))

    def test_delete_main(self):
        status, body = self.request("DELETE", "/api/drives/main")
        self.assertEqual((status, body["error"]), (400, "cannot_delete_main"))

    def test_upload_not_mz(self):
        status, body = self.request("PUT", "/api/drives/main/files/fake.exe", b"#!/bin/sh\n" * 10)
        self.assertEqual((status, body["error"]), (415, "not_a_windows_executable"))
        self.assertEqual([p.name for p in self.files_dir().iterdir() if "fake" in p.name or p.name.endswith(".part")], [])

    def test_upload_invalid_name(self):
        for name in ("..%2Fx.exe", "readme.txt", "Game%2F.DS_Store"):
            status, body = self.request("PUT", f"/api/drives/main/files/{name}", b"MZ")
            self.assertEqual((status, body["error"]), (400, "invalid_name"), name)

    def test_upload_duplicate_and_overwrite(self):
        path = "/api/drives/main/files/Setup%20(x64).exe"
        status, body = self.request("PUT", path, b"MZ" + b"a" * 100)
        self.assertEqual((status, body), (201, {"name": "Setup (x64).exe", "size": 102}))
        status, body = self.request("PUT", path, b"MZ-second")
        self.assertEqual((status, body["error"]), (409, "exists"))
        status, body = self.request("PUT", path + "?overwrite=1", b"MZ-second")
        self.assertEqual((status, body["size"]), (201, 9))
        self.assertEqual((self.files_dir() / "Setup (x64).exe").read_bytes(), b"MZ-second")
        names = [f["name"] for f in self.drive("main")["files"]]
        self.assertIn("Setup (x64).exe", names)
        status, _ = self.request("DELETE", path)
        self.assertEqual(status, 204)
        status, body = self.request("DELETE", path)
        self.assertEqual((status, body["error"]), (404, "no_such_file"))

    def test_run_file_records_exit_and_log(self):
        self.request("PUT", "/api/drives/main/files/tool.exe", b"MZtool")
        status, body = self.request("POST", "/api/drives/main/run", {"file": "tool.exe"})
        self.assertEqual(status, 201)
        run_id = body["id"]
        deadline = time.time() + 10
        while time.time() < deadline:
            run = next(r for r in self.drive("main")["runs"] if r["id"] == run_id)
            if not run["running"]:
                break
            time.sleep(0.05)
        self.assertEqual((run["running"], run["exit_code"], run["label"]), (False, 0, "tool.exe"))
        status, log = self.request("GET", f"/api/runs/{run_id}/log")
        self.assertEqual(status, 200)
        self.assertIn(b"ran " + str(self.files_dir() / "tool.exe").encode(), log)

    def test_run_program_runs_shortcut_target(self):
        prefix = self.root / "drives/main/prefix"
        (prefix / "drive_c/Games/Tool").mkdir(parents=True)
        menu = prefix / "drive_c/ProgramData/Microsoft/Windows/Start Menu/Programs"
        menu.mkdir(parents=True, exist_ok=True)
        (menu / "Tool.lnk").write_bytes(make_lnk(r"C:\Games\Tool\tool.exe", '-w "two words"', r"C:\Games\Tool"))
        rel = "drive_c/ProgramData/Microsoft/Windows/Start Menu/Programs/Tool.lnk"
        self.assertIn({"name": "Tool", "path": rel}, self.drive("main")["programs"])
        status, body = self.request("POST", "/api/drives/main/run", {"program": rel})
        self.assertEqual(status, 201)
        # The fake runner echoes its argv; args were split Windows-style.
        cwd = (prefix / "drive_c/Games/Tool").resolve()
        self.assertEqual(self.wait_log(body["id"]).strip(),
                         f"ran C:\\Games\\Tool\\tool.exe -w two words in {cwd}".encode())

    def test_run_rejects_traversal_program(self):
        status, body = self.request("POST", "/api/drives/main/run", {"program": "../../etc/passwd.lnk"})
        self.assertEqual((status, body["error"]), (400, "invalid_program"))

    def test_run_on_unready_drive(self):
        self.wait_state("broken", "error")
        status, body = self.request("POST", "/api/drives/broken/run", {"file": "x.exe"})
        self.assertEqual((status, body["error"]), (409, "drive_not_ready"))

    def test_unknown_run(self):
        status, body = self.request("POST", "/api/runs/nope/stop")
        self.assertEqual((status, body["error"]), (404, "no_such_run"))

    # -- folder uploads as one archive -----------------------------------------

    @staticmethod
    def make_tar(files: dict, dirs=(), extra=None) -> bytes:
        buf = BytesIO()
        with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tar:
            for d in dirs:
                info = tarfile.TarInfo(d)
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, BytesIO(data))
            if extra:
                tar.addfile(extra)
        return buf.getvalue()

    def leftovers(self):
        return [p.name for p in self.files_dir().iterdir() if p.name.startswith(".upload-")]

    def test_folder_archive_upload_and_replace(self):
        base = "/api/drives/main/folders/Arch"
        body = self.make_tar({"bin/app.exe": b"MZapp", "data/Über level.pak": b"lvl"}, dirs=["saves"])
        status, resp = self.request("PUT", base, body)
        self.assertEqual((status, resp), (201, {"name": "Arch", "files": 2, "size": 8}))
        folder = self.files_dir() / "Arch"
        self.assertEqual((folder / "bin/app.exe").read_bytes(), b"MZapp")
        self.assertTrue((folder / "saves").is_dir())  # empty folders survive
        game = next(f for f in self.drive("main")["folders"] if f["name"] == "Arch")
        self.assertEqual(game["executables"], ["Arch/bin/app.exe"])

        status, resp = self.request("PUT", base, self.make_tar({"new.exe": b"MZnew"}))
        self.assertEqual((status, resp["error"]), (409, "exists"))
        self.assertTrue((folder / "bin/app.exe").exists())
        status, _ = self.request("PUT", base + "?replace=1", self.make_tar({"new.exe": b"MZnew"}))
        self.assertEqual(status, 201)
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["new.exe"])
        self.assertEqual(self.leftovers(), [])

    def test_cancelled_folder_upload_keeps_existing_folder(self):
        import socket
        base = "/api/drives/main/folders/Keep"
        self.request("PUT", base, self.make_tar({"old.exe": b"MZold"}))
        body = self.make_tar({f"f{i}.bin": os.urandom(4096) for i in range(200)})
        with socket.create_connection(("127.0.0.1", self.port), timeout=10) as s:
            s.sendall(f"PUT {base}?replace=1 HTTP/1.1\r\nHost: t\r\nContent-Length: {len(body)}\r\n\r\n".encode())
            s.sendall(body[: len(body) // 2])  # then the user hits Cancel
        # Give the server time to pick the request up and see it end early;
        # polling at once could pass before the staging folder even exists.
        time.sleep(0.5)
        deadline = time.time() + 5
        while self.leftovers() and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(sorted(p.name for p in (self.files_dir() / "Keep").iterdir()), ["old.exe"])

    def test_folder_archive_rejects_unsafe_members(self):
        link = tarfile.TarInfo("evil")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc"
        cases = {
            "traversal": (self.make_tar({"../escape.txt": b"x"}), 400),
            "symlink": (self.make_tar({"ok.txt": b"x"}, extra=link), 400),
            "fake exe": (self.make_tar({"ok.txt": b"x", "bin/tool.exe": b"#!/bin/sh"}), 415),
            "not a tar": (b"this is not an archive" * 100, 400),
        }
        for label, (body, code) in cases.items():
            status, _ = self.request("PUT", f"/api/drives/main/folders/Bad{code}", body)
            self.assertEqual(status, code, label)
            self.assertFalse((self.files_dir() / f"Bad{code}").exists(), label)
        self.assertFalse((self.files_dir().parent / "escape.txt").exists())
        self.assertEqual(self.leftovers(), [])

    # -- logs, run history, setup ------------------------------------------------

    def run_and_wait(self, file):
        status, body = self.request("POST", "/api/drives/main/run", {"file": file})
        self.assertEqual(status, 201)
        deadline = time.time() + 10
        while time.time() < deadline:
            run = next((r for r in self.drive("main")["runs"] if r["id"] == body["id"]), None)
            if run and not run["running"]:
                return body["id"]
            time.sleep(0.05)
        raise AssertionError("run did not finish")

    def test_chatty_program_log_is_capped_keeping_start_and_end(self):
        saved = launcher.LOG_HEAD_BYTES, launcher.LOG_KEEP_BYTES
        launcher.LOG_HEAD_BYTES, launcher.LOG_KEEP_BYTES = 1000, 3000
        try:
            self.request("PUT", "/api/drives/main/files/spam.exe", b"MZspam")
            run_id = self.run_and_wait("spam.exe")
            path = self.app.runs.get(run_id).log_path
            time.sleep(0.2)  # let the pump flush its last chunk
            data = path.read_bytes()
        finally:
            launcher.LOG_HEAD_BYTES, launcher.LOG_KEEP_BYTES = saved
        full = "".join(f"{i}\n" for i in range(1, 20001)).encode()  # 108,894 bytes
        self.assertLessEqual(len(data), 1000 + len(launcher.LOG_DROPPED_MARK) + 2 * 3000)
        self.assertTrue(data.startswith(full[:1000]))
        self.assertIn(launcher.LOG_DROPPED_MARK, data)
        self.assertTrue(data.endswith(b"19999\n20000\n"))

    def test_run_history_is_bounded_and_listed_logs_survive_pruning(self):
        saved = launcher.MAX_FINISHED_RUNS, launcher.MAX_LOGS
        launcher.MAX_FINISHED_RUNS, launcher.MAX_LOGS = 3, 1
        try:
            self.request("PUT", "/api/drives/main/files/quiet.exe", b"MZq")
            for _ in range(6):
                self.run_and_wait("quiet.exe")
            runs = [r for r in self.drive("main")["runs"] if not r["running"]]
            self.assertEqual(len(runs), 3)
            for r in runs:  # every listed run still has its log
                _, log = self.request("GET", f"/api/runs/{r['id']}/log")
                self.assertIn(b"quiet.exe", log)
        finally:
            launcher.MAX_FINISHED_RUNS, launcher.MAX_LOGS = saved

    def test_hung_setup_times_out_without_blocking_other_drives(self):
        self.assertEqual(self.request("POST", "/api/drives", {"name": "slow1"})[0], 201)
        self.assertEqual(self.request("POST", "/api/drives", {"name": "after-slow"})[0], 201)
        self.wait_state("slow1", "initializing")
        # Stopping programs mid-setup would kill wineboot; it is refused.
        status, body = self.request("POST", "/api/drives/slow1/stop-all")
        self.assertEqual((status, body["error"]), (409, "drive_not_ready"))
        slow = self.wait_state("slow1", "error", timeout=15)
        self.assertIn("did not finish", slow["error_message"])
        self.wait_state("after-slow", "ready", timeout=15)
        status, log = self.request("GET", "/api/drives/slow1/setup-log")
        self.assertEqual((status, log.strip()), (200, b"hanging"))

    def test_setup_log_of_failed_drive(self):
        d = self.wait_state("broken", "error")
        self.assertTrue(d["setup_log"])
        status, log = self.request("GET", "/api/drives/broken/setup-log")
        # wineboot's output; the fake runner prints it again for `wineserver -w`.
        self.assertEqual((status, log.split(b"\n")[0]), (200, b"boom"))


if __name__ == "__main__":
    unittest.main()
