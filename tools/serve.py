#!/usr/bin/env python3
"""Serve the Trading Journal PWA plus a read-only /live bridge to MT5 exports.

    python3 tools/serve.py [--port 8080] [--data-dir PATH]

The data dir defaults to the Wine MT5 MQL5/Files/ai_trading_platform_data
folder (or env MT5_DATA_DIR). It is only ever READ — the three whitelisted
files account.json / history.json / positions.json are re-read on each
GET /live request and returned verbatim; nothing is cached, nothing is
written back.
"""

import argparse
import json
import os
import socket
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DATA_DIR = os.path.expanduser(
    "~/Library/Application Support/net.metaquotes.wine.metatrader5/"
    "drive_c/Program Files/MetaTrader 5/MQL5/Files/ai_trading_platform_data"
)

LIVE_FILES = {
    "account": "account.json",
    "history": "history.json",
    "positions": "positions.json",
}


class Handler(SimpleHTTPRequestHandler):
    data_dir = DEFAULT_DATA_DIR

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    # -- headers ----------------------------------------------------------
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # -- routing ----------------------------------------------------------
    def do_GET(self):
        if self.path.split("?", 1)[0] == "/live":
            self.handle_live()
        else:
            super().do_GET()

    def _method_not_allowed(self):
        self.send_error(405, "Method Not Allowed")

    do_POST = _method_not_allowed
    do_PUT = _method_not_allowed
    do_DELETE = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_OPTIONS = _method_not_allowed

    # -- /live ------------------------------------------------------------
    def handle_live(self):
        payload = {"ok": True, "served_at": time.time(), "errors": {}}
        for key, fname in LIVE_FILES.items():
            path = os.path.join(self.data_dir, fname)
            try:
                with open(path, "rb") as f:
                    data = json.loads(f.read().decode("utf-8"))
                if key == "account":
                    data = dict(data)
                    data["file_age_seconds"] = round(
                        max(0.0, time.time() - os.path.getmtime(path)), 1)
                payload[key] = data
            except FileNotFoundError:
                payload[key] = None
                payload["errors"][key] = "not found: " + fname
            except Exception as e:  # mid-write JSON, unreadable file, etc.
                payload[key] = None
                payload["errors"][key] = f"{fname}: {e}"
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def main():
    ap = argparse.ArgumentParser(description="Trading Journal dev server + MT5 /live bridge")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--data-dir", default=os.environ.get("MT5_DATA_DIR", DEFAULT_DATA_DIR))
    args = ap.parse_args()

    Handler.data_dir = os.path.abspath(os.path.expanduser(args.data_dir))
    account_path = os.path.join(Handler.data_dir, "account.json")

    print(f"MT5 data dir : {Handler.data_dir}", flush=True)
    print(f"account.json : {'found' if os.path.isfile(account_path) else 'MISSING'}", flush=True)
    print(f"Serving app  : http://127.0.0.1:{args.port}/", flush=True)
    ip = lan_ip()
    print(f"On iPhone    : http://{ip}:{args.port}/", flush=True)
    print("Live endpoint: GET /live", flush=True)

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
