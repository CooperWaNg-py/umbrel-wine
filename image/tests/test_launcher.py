"""Launcher tests: pure helpers plus the HTTP API against a fake Wine runner.

Run from the repo root:  python3 -m unittest discover -s image/tests -v
"""

import http.client
import json
import os
import shutil
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "root" / "opt" / "umbrel-wine"))

import launcher  # noqa: E402

# Stands in for /usr/local/bin/umbrel-wine. wineboot creates system.reg like the
# real thing; the drive named `broken` fails every command.
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
if [ "$server" = 0 ] && [ "$1" = "wineboot" ]; then
  mkdir -p "$root/drives/$drive/prefix"
  echo "WINE REGISTRY Version 2" > "$root/drives/$drive/prefix/system.reg"
fi
if [ "$server" = 0 ]; then echo "ran $*"; fi
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
    def test_validate_upload_name(self):
        for bad in ("../a.exe", ".a.exe", "a.txt", "a/b.exe", "", "a.exe/"):
            self.assertFalse(launcher.validate_upload_name(bad), bad)
        for good in ("Setup (x64).exe", "putty.exe", "7z2409-x64.EXE"):
            self.assertTrue(launcher.validate_upload_name(good), good)

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
        status, body = self.request("PUT", "/api/drives/main/files/..%2Fx.exe", b"MZ")
        self.assertEqual((status, body["error"]), (400, "invalid_name"))

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
        deadline = time.time() + 10
        while time.time() < deadline:
            _, log = self.request("GET", f"/api/runs/{body['id']}/log")
            if log:
                break
            time.sleep(0.05)
        # The fake runner echoes its argv; args were split Windows-style.
        self.assertEqual(log.strip(), rb"ran C:\Games\Tool\tool.exe -w two words")

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


if __name__ == "__main__":
    unittest.main()
