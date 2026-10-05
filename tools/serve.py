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
import re
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

TICK_NAME_RE = re.compile(r"^tick_[A-Z0-9._]{3,12}\.json$")
STREAM_INTERVAL = 0.25   # tick export cadence
PING_INTERVAL = 15.0


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
        path = self.path.split("?", 1)[0]
        if path == "/live":
            self.handle_live()
        elif path == "/live/stream":
            self.handle_live_stream()
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
    def live_payload(self):
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
        return payload

    def handle_live(self):
        body = json.dumps(self.live_payload()).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- /live/stream -----------------------------------------------------
    # Server-Sent Events: a "live" event on any account/positions/history
    # file change (and once on connect), a "tick" event per changed tick file
    # for the open-position symbols plus the account-currency conversion
    # pair, and a ": ping" comment every 15 s. Read-only, like /live.
    def _tick_file(self, symbol):
        fname = f"tick_{symbol}.json"
        if not TICK_NAME_RE.match(fname):
            return None
        path = os.path.join(self.data_dir, fname)
        try:
            with open(path, "rb") as f:
                d = json.loads(f.read().decode("utf-8"))
            d["_mtime"] = os.path.getmtime(path)
            return d
        except Exception:
            return None

    def _conversion_pair(self, currency):
        ccy = (currency or "").upper()
        if not ccy or ccy == "USD":
            return None
        for pair in (f"{ccy}USD", f"USD{ccy}"):
            if self._tick_file(pair) is not None:
                return pair
        return None

    def handle_live_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True

        live_mtimes = {}
        tick_mtimes = {}
        last_ping = 0.0
        while True:
            try:
                now = time.time()
                # 1) the three live files
                changed = False
                for fname in LIVE_FILES.values():
                    try:
                        m = os.path.getmtime(os.path.join(self.data_dir, fname))
                    except OSError:
                        m = None
                    if live_mtimes.get(fname) != m:
                        live_mtimes[fname] = m
                        changed = True
                if changed:
                    payload = self.live_payload()
                    positions = payload.get("positions") or []
                    account = payload.get("account") or {}
                    self._send_event("live", payload)
                else:
                    positions = []
                    try:
                        with open(os.path.join(self.data_dir, "positions.json"), "rb") as f:
                            positions = json.loads(f.read().decode("utf-8")) or []
                    except Exception:
                        pass
                    account = {}
                    try:
                        with open(os.path.join(self.data_dir, "account.json"), "rb") as f:
                            account = json.loads(f.read().decode("utf-8")) or {}
                    except Exception:
                        pass

                # 2) tick files for open-position symbols + the fx pair
                pair = self._conversion_pair(account.get("currency"))
                symbols = {str(p.get("symbol", "")).upper().split(".")[0]
                           for p in positions if p.get("symbol")}
                watched = symbols | ({pair} if pair else set())
                fx_tick = self._tick_file(pair) if pair else None
                for sym in sorted(watched):
                    path = os.path.join(self.data_dir, f"tick_{sym}.json")
                    if not TICK_NAME_RE.match(f"tick_{sym}.json"):
                        continue
                    try:
                        m = os.path.getmtime(path)
                    except OSError:
                        continue
                    if tick_mtimes.get(sym) == m:
                        continue
                    tick_mtimes[sym] = m
                    t = self._tick_file(sym)
                    if not t:
                        continue
                    t.pop("_mtime", None)
                    tick = {"symbol": t.get("symbol", sym), "bid": t.get("bid"),
                            "ask": t.get("ask"), "time": t.get("time"),
                            "time_msc": t.get("time_msc"),
                            "fx": ({"pair": pair, "bid": fx_tick.get("bid"),
                                    "ask": fx_tick.get("ask")}
                                   if fx_tick else None)}
                    self._send_event("tick", tick)

                # 3) keep-alive
                if now - last_ping >= PING_INTERVAL:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = now

                time.sleep(STREAM_INTERVAL)
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception:
                # never die on a mid-write JSON or transient stat error
                time.sleep(STREAM_INTERVAL)

    def _send_event(self, event, data):
        self.wfile.write(
            f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8"))
        self.wfile.flush()


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
    print("Live endpoints: GET /live, GET /live/stream (SSE)", flush=True)

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
