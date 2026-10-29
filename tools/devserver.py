#!/usr/bin/env python3
"""Development server: serves ui/ and runs the debug binary as a CGI for
api.cgi/*, the way DSM's web server does, plus the transfer daemon.
Authentication is replaced by SYNOFILE_DEV_USER, which only debug builds
honour, and the shared folders are the subfolders of --root.

    cargo build && tools/devserver.py --root /tmp/synofile-shares [--port 8766]
"""

import argparse
import http.server
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui"
BINARY = ROOT / "target" / "debug" / "synofile"
VAR = ROOT / "target" / "devvar"


def base_env(shares):
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
        "SYNOFILE_DEV_USER": "dev",
        "SYNOFILE_DEV_ROOT": str(shares),
        "SYNOPKG_PKGVAR": str(VAR),
    }


class Handler(http.server.SimpleHTTPRequestHandler):
    shares = None
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(UI), **kwargs)

    def log_message(self, fmt, *args):
        if "/api.cgi/jobs?" not in self.path:
            super().log_message(fmt, *args)

    def end_headers(self):
        # the interface is plain files: never cache them while developing
        if not self.path.startswith("/api.cgi/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/webman/login.cgi"):
            body = json.dumps({"SynoToken": "dev"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if self.path.startswith("/api.cgi/"):
            return self.cgi()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api.cgi/"):
            return self.cgi()
        self.send_error(404)

    def cgi(self):
        url = urlsplit(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        env = base_env(self.shares) | {
            "GATEWAY_INTERFACE": "CGI/1.1",
            "REQUEST_METHOD": self.command,
            "PATH_INFO": url.path[len("/api.cgi"):],
            "QUERY_STRING": url.query,
            "CONTENT_TYPE": self.headers.get("Content-Type", ""),
            "CONTENT_LENGTH": str(length),
        }
        if self.headers.get("Range"):
            env["HTTP_RANGE"] = self.headers["Range"]
        proc = subprocess.Popen([str(BINARY)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
        left = length
        while left > 0:
            chunk = self.rfile.read(min(left, 1 << 20))
            if not chunk:
                break
            proc.stdin.write(chunk)
            left -= len(chunk)
        proc.stdin.close()
        status, headers = 200, []
        while True:
            line = proc.stdout.readline().decode("latin-1").rstrip("\r\n")
            if not line:
                break
            name, _, value = line.partition(": ")
            if name.lower() == "status":
                status = int(value.split()[0])
            else:
                headers.append((name, value))
        self.send_response(status)
        has_length = any(n.lower() == "content-length" for n, _ in headers)
        for name, value in headers:
            self.send_header(name, value)
        if not has_length:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        shutil.copyfileobj(proc.stdout, self.wfile, 1 << 20)
        proc.wait()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--root", required=True, help="folder whose subfolders play the shared folders")
    args = parser.parse_args()
    if not BINARY.exists():
        sys.exit("build first: cargo build")
    VAR.mkdir(parents=True, exist_ok=True)
    Handler.shares = Path(args.root).resolve()
    daemon = subprocess.Popen([str(BINARY), "daemon"], env=base_env(Handler.shares))
    print(f"http://127.0.0.1:{args.port}/index.html")
    try:
        http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
    finally:
        daemon.terminate()


if __name__ == "__main__":
    main()
