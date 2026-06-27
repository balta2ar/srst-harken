#!/usr/bin/env python3

import argparse
import json
import logging
import socket
import ssl
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode, urlparse, parse_qs
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

    def do_GET(self):
        parsed = urlparse(self.path)
        self._serve_static(parsed.path)

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
