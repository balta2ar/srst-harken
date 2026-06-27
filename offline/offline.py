#!/usr/bin/env python3

import argparse
import json
import logging
import os
import socket
import ssl
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse, parse_qs
from urllib.request import Request as URLRequest, urlopen

logging.basicConfig(level=logging.INFO)

SSL_NOVERIFY = ssl._create_unverified_context()
STATIC_DIR = Path(__file__).parent / "static"
SCOPE_LIMIT = 200
CHUNK = 64 * 1024

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
    ".json": "application/json",
}

UTTALE = "https://localhost:7010"
TELEGRAM_SEND_VOICE = "/home/bz/rc.arch/bz/bin/telegram-send-voice"


def parse_ts(s: str) -> float:
    h, m, s_ms = s.split(":")
    sec, ms = s_ms.replace(".", ",").split(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000.0


def format_ts(seconds: float) -> str:
    ms = int((seconds % 1) * 1000)
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def clip_ts(ts_string: str, offset_float: float) -> str:
    return format_ts(max(0.0, parse_ts(ts_string) + offset_float))


def podcast_of(filename: str) -> str:
    parts = filename.split("/")
    return parts[1] if len(parts) > 1 else parts[0]


def detect_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def ensure_cert(cert_path: Path, key_path: Path) -> None:
    if cert_path.exists() and key_path.exists():
        return
    cert_path.parent.mkdir(parents=True, exist_ok=True)
    sans = ["DNS:localhost", "IP:127.0.0.1"]
    ip = detect_lan_ip()
    if ip:
        sans.append(f"IP:{ip}")
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", str(key_path), "-out", str(cert_path),
        "-days", "3650", "-subj", "/CN=srst-offline",
        "-addext", f"subjectAltName={','.join(sans)}",
    ], check=True)
    logging.info("Generated self-signed cert at %s", cert_path)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body=b"", content_type="text/plain", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _serve_static(self, path):
        rel = "index.html" if path == "/" else path.lstrip("/")
        target = (STATIC_DIR / rel).resolve()
        if STATIC_DIR.resolve() not in target.parents and target != STATIC_DIR.resolve():
            self._send(403, b"forbidden")
            return
        if not target.is_file():
            self._send(404, b"not found")
            return
        ctype = MIME.get(target.suffix, "application/octet-stream")
        extra = {"Cache-Control": "no-cache"}
        if target.name == "sw.js":
            extra["Service-Worker-Allowed"] = "/"
        self._send(200, target.read_bytes(), ctype, extra)

    def _proxy_json(self, upstream_path, params):
        url = f"{self.uttale}{upstream_path}?{urlencode(params)}"
        try:
            with urlopen(url, context=SSL_NOVERIFY) as r:
                body = r.read()
        except URLError as e:
            logging.error("proxy error %s: %s", url, e)
            self._send(502, b'{"error":"upstream"}', "application/json")
            return
        self._send(200, body, "application/json")

    def _proxy_audio(self, params):
        url = f"{self.uttale}/uttale/Audio?{urlencode(params)}"
        try:
            upstream = urlopen(url, context=SSL_NOVERIFY)
        except URLError as e:
            logging.error("audio proxy error %s: %s", url, e)
            self._send(502, b"upstream")
            return
        self.send_response(200)
        self.send_header("Content-Type", upstream.headers.get("Content-Type", "audio/ogg"))
        cl = upstream.headers.get("Content-Length")
        if cl:
            self.send_header("Content-Length", cl)
        self.end_headers()
        try:
            while chunk := upstream.read(CHUNK):
                self.wfile.write(chunk)
        finally:
            upstream.close()

    def do_GET(self):
        parsed = urlparse(self.path)
        q = parse_qs(parsed.query)
        if parsed.path == "/api/scopes":
            self._proxy_json("/uttale/Scopes", {
                "q": q.get("q", [""])[0], "limit": SCOPE_LIMIT})
        elif parsed.path == "/api/lines":
            self._proxy_json("/uttale/Search", {
                "q": "", "scope": q.get("scope", [""])[0], "limit": 1000})
        elif parsed.path == "/api/audio":
            self._proxy_audio({
                "filename": q.get("filename", [""])[0], "start": "", "end": ""})
        elif parsed.path == "/api/favorites":
            self._proxy_json("/uttale/Favorites", {"sort": "created_desc"})
        else:
            self._serve_static(parsed.path)

    def _relay_error(self, where, e):
        # HTTPError carries the upstream response (e.g. 404 on a missing
        # favorite); relay its real status so the client can act on it. A bare
        # URLError means the backend was unreachable -> 502.
        if isinstance(e, HTTPError):
            self._send(e.code, e.read() or b"", "application/json")
        else:
            logging.error("%s: %s", where, e)
            self._send(502, b'{"error":"upstream"}', "application/json")

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in ("/api/favorite", "/api/export"):
            self._send(404, b"not found")
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        if parsed.path == "/api/export":
            self._export(raw)
            return
        url = f"{self.uttale}/uttale/Favorites"
        req = URLRequest(url, data=raw, method="POST")
        req.add_header("Content-Type", "application/json")
        try:
            with urlopen(req, context=SSL_NOVERIFY) as r:
                body = r.read()
        except URLError as e:
            self._relay_error("favorite POST error", e)
            return
        self._send(200, body, "application/json")

    def _export(self, raw):
        try:
            fav = json.loads(raw or b"{}")
        except ValueError:
            self._send(400, b'{"status":"error","detail":"bad json"}', "application/json")
            return
        filename = fav.get("filename", "")
        start = fav.get("start", "")
        end = fav.get("end", "") or start
        text = fav.get("text", "")
        if not filename or not start:
            self._send(400, b'{"status":"error","detail":"missing filename/start"}', "application/json")
            return
        ogg = str(Path(filename).with_suffix(".ogg"))
        audio_url = (f"{self.uttale}/uttale/Audio?filename={quote(ogg)}"
                     f"&start={quote(clip_ts(start, -0.5))}&end={quote(clip_ts(end, 0.5))}")
        try:
            with urlopen(audio_url, context=SSL_NOVERIFY) as r:
                audio = r.read()
        except URLError as e:
            self._send(502, json.dumps({"status": "error", "detail": f"audio: {e}"}).encode(),
                       "application/json")
            return
        caption = f"#{podcast_of(filename)} #wtf\n{text}"
        with tempfile.NamedTemporaryFile(delete=False, suffix=".ogg") as tmp:
            tmp.write(audio)
            tmp_path = tmp.name
        try:
            proc = subprocess.run([TELEGRAM_SEND_VOICE, tmp_path, "-m", caption],
                                  capture_output=True, text=True)
        except OSError as e:
            self._send(500, json.dumps({"status": "error", "detail": str(e)}).encode(),
                       "application/json")
            return
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "send failed").strip()
            self._send(502, json.dumps({"status": "error", "detail": detail}).encode(),
                       "application/json")
            return
        upd = URLRequest(f"{self.uttale}/uttale/Favorites/Update",
                         data=json.dumps({"filename": filename, "start": start,
                                          "set_exported": True}).encode(),
                         method="POST")
        upd.add_header("Content-Type", "application/json")
        try:
            with urlopen(upd, context=SSL_NOVERIFY):
                pass
        except URLError as e:
            logging.error("export: set_exported failed: %s", e)
        self._send(200, b'{"status":"sent"}', "application/json")

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/favorite":
            self._send(404, b"not found")
            return
        q = parse_qs(parsed.query)
        params = {"filename": q.get("filename", [""])[0],
                  "start": q.get("start", [""])[0]}
        url = f"{self.uttale}/uttale/Favorites?{urlencode(params)}"
        req = URLRequest(url, method="DELETE")
        try:
            with urlopen(req, context=SSL_NOVERIFY) as r:
                body = r.read()
        except URLError as e:
            self._relay_error("favorite DELETE error", e)
            return
        self._send(200, body, "application/json")

    def log_message(self, fmt, *args):
        logging.info("%s - %s", self.address_string(), fmt % args)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--uttale", default=UTTALE,
                        help="Uttale API base URL")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=7020)
    parser.add_argument("--ssl", action="store_true",
                        help="Serve over HTTPS (self-signed cert)")
    parser.add_argument("--ssl-cert",
                        default=str(Path.home() / ".cache/srst-offline/cert.pem"))
    parser.add_argument("--ssl-key",
                        default=str(Path.home() / ".cache/srst-offline/key.pem"))
    args = parser.parse_args()

    Handler.uttale = args.uttale.rstrip("/")
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    if args.ssl:
        cert, key = Path(args.ssl_cert), Path(args.ssl_key)
        ensure_cert(cert, key)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(cert), str(key))
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    scheme = "https" if args.ssl else "http"
    logging.info("srst-offline on %s://%s:%d -> %s",
                 scheme, args.host, args.port, Handler.uttale)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
