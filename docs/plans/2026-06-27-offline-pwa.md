# srst-offline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `srst-offline`, an offline-first PWA (stdlib HTTPS proxy server + vanilla-JS client) that downloads a podcast episode at home, lets you listen and star favorites offline, and auto-syncs those favorites to the uttale backend when back online.

**Architecture:** A thin Python stdlib `ThreadingHTTPServer` (`offline/offline.py`) serves five static files and proxies four uttale endpoints under `/api/*`. The real app is a vanilla-JS client: a service worker precaches the app shell, IndexedDB stores episode lines + audio Blobs + a favorite queue, and two views handle find/download (online) and listen/favorite (offline). Sync replays the queue on reconnect.

**Tech Stack:** Python 3.12 stdlib (`http.server`, `urllib.request`, `ssl`, `argparse`); vanilla JS (Service Worker API, IndexedDB, Cache API, `<audio>`); no new runtime dependencies.

**Spec:** `docs/specs/2026-06-27-offline-pwa-design.md`

---

## Testing approach (read first)

This repo has **no automated test suite** (per `AGENTS.md`); verification is
`py_compile` + smoke render, and browser behavior (SW/IndexedDB) is verified
manually. Therefore each task ends with a **verification step** appropriate to
this repo, not pytest:

- Python server tasks → `py_compile` + `curl -k` smoke against the live backend
  at `https://localhost:7010`.
- Client tasks → `py_compile` of the server is unaffected; the file is served and
  checked with `curl -k` for 200 + correct `Content-Type`; functional behavior is
  a documented **manual browser check** (the env has no headless browser harness).

**Environment facts (verified live, use verbatim in smoke):**
- uttale runs at `https://localhost:7010` (self-signed) and is **already running**
  — do not start/stop it.
- Real episode for smoke: `MarianneMoterMennesker/20210316` has exactly **2**
  segments: `48k/MarianneMoterMennesker/20210316/by10m/by10m_00.vtt` and
  `…/by10m_01.vtt`.
- There are **6** real user favorites; any smoke that writes a favorite MUST
  delete it and confirm the count returns to 6.
- harken venv python (works): `.venv/bin/python`.
- Pick a spare port in **7021-7029** for smoke; kill the smoke server **by PID**
  (never bare `pkill`); remove any temp harness afterward.

**Commit discipline:** commit after each task. Do not commit the `*.egg-info/`,
`.ctags`, `hello.py`, `response.json`, or `openapi.json` files already untracked
in the repo — stage only files this plan creates/edits.

---

## File Structure

| File | Responsibility |
|---|---|
| `offline/__init__.py` | marks `offline` as a package (empty) |
| `offline/offline.py` | stdlib HTTPS server: static serving, `/api/*` proxy, argparse, cert helpers |
| `offline/static/index.html` | app shell markup for both views + script/manifest tags |
| `offline/static/app.css` | minimal styling (line list, active line, star, status bar) |
| `offline/static/db.js` | IndexedDB wrapper (open + per-store get/put/delete helpers) |
| `offline/static/app.js` | app logic: views, search/group, download, playback, favorite queue, sync, SW registration |
| `offline/static/sw.js` | service worker: precache + serve app shell |
| `offline/static/manifest.webmanifest` | PWA manifest |
| `offline/static/icon-192.png`, `offline/static/icon-512.png` | manifest icons |
| `pyproject.toml` | add `srst-offline` console script + `offline` package + static package-data |

Client JS is split into `db.js` (storage primitive, no UI) and `app.js` (everything
else) so the IndexedDB layer can be reasoned about and changed independently.

---

## Task 1: Package skeleton + server that serves a static shell

**Files:**
- Create: `offline/__init__.py`
- Create: `offline/offline.py`
- Create: `offline/static/index.html`

- [ ] **Step 1: Create the empty package marker**

Create `offline/__init__.py` with no content (empty file).

- [ ] **Step 2: Create a minimal shell page**

Create `offline/static/index.html`:

```html
<!DOCTYPE html>
<html lang="no">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>srst-offline</title>
</head>
<body>
  <h1 id="boot">srst-offline</h1>
</body>
</html>
```

- [ ] **Step 3: Write the server with static serving + argparse + cert helpers**

Create `offline/offline.py`. Cert/LAN helpers are copied from harken
(`harken/harken.py:1031-1055`) to keep this module dependency-free.

```python
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
```

- [ ] **Step 4: Verify it compiles**

Run: `/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m py_compile offline/offline.py`
Expected: no output, exit 0.

- [ ] **Step 5: Smoke — serve and fetch the shell**

Run (HTTP, no cert needed for this step), from repo root:

```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 &
echo $! > /tmp/opencode/offline.pid
sleep 1
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:7021/
kill "$(cat /tmp/opencode/offline.pid)"
```

Expected: `200 text/html; charset=utf-8`.

- [ ] **Step 6: Commit**

```bash
git add offline/__init__.py offline/offline.py offline/static/index.html
git commit -m "srst-offline: stdlib server serving static shell"
```

---

## Task 2: `/api/*` proxy routes (scopes, lines, audio, favorite POST/DELETE)

**Files:**
- Modify: `offline/offline.py`

- [ ] **Step 1: Add a JSON-forward helper and GET proxy routes**

In `offline/offline.py`, add these methods to `Handler` (above `do_GET`):

```python
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
```

- [ ] **Step 2: Route GET `/api/*` in `do_GET`**

Replace the body of `do_GET` with:

```python
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
        else:
            self._serve_static(parsed.path)
```

- [ ] **Step 3: Add POST and DELETE for favorites**

Add to `Handler`:

```python
    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/favorite":
            self._send(404, b"not found")
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        url = f"{self.uttale}/uttale/Favorites"
        req = URLRequest(url, data=raw, method="POST")
        req.add_header("Content-Type", "application/json")
        try:
            with urlopen(req, context=SSL_NOVERIFY) as r:
                body = r.read()
        except URLError as e:
            logging.error("favorite POST error: %s", e)
            self._send(502, b'{"error":"upstream"}', "application/json")
            return
        self._send(200, body, "application/json")

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
            logging.error("favorite DELETE error: %s", e)
            self._send(502, b'{"error":"upstream"}', "application/json")
            return
        self._send(200, body, "application/json")
```

- [ ] **Step 4: Verify it compiles**

Run: `/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m py_compile offline/offline.py`
Expected: no output, exit 0.

- [ ] **Step 5: Smoke — proxy GET routes against live uttale**

This step talks to the **real** backend, so run the smoke server with `--ssl`
(uttale default is https). Run from repo root:

```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 --ssl &
echo $! > /tmp/opencode/offline.pid
sleep 1
echo "scopes:"; curl -sk "https://localhost:7021/api/scopes?q=MarianneMoterMennesker/20210316" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['results']),'results')"
echo "lines:"; curl -sk "https://localhost:7021/api/lines?scope=48k/MarianneMoterMennesker/20210316/by10m/by10m_00.vtt" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['results']),'lines')"
echo "audio:"; curl -sk "https://localhost:7021/api/audio?filename=48k/MarianneMoterMennesker/20210316/by10m/by10m_00.vtt" -o /tmp/opencode/seg.ogg -w "%{http_code} %{content_type} %{size_download}\n"
kill "$(cat /tmp/opencode/offline.pid)"
```

Expected: scopes `2 results`; lines a positive count (e.g. `~30 lines`); audio
`200 audio/ogg <large size_download>` (tens/hundreds of KB, not 0).

- [ ] **Step 6: Smoke — favorite POST then DELETE (must restore count to 6)**

```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 --ssl &
echo $! > /tmp/opencode/offline.pid
sleep 1
echo "before:"; curl -sk "https://localhost:7021/api/scopes?q=" >/dev/null; curl -sk "https://localhost:7010/uttale/Favorites" | python3 -c "import sys,json;print(json.load(sys.stdin)['results_count'])"
curl -sk -X POST "https://localhost:7021/api/favorite" -H "Content-Type: application/json" -d '{"filename":"OFFLINE_SMOKE.vtt","start":"00:00:00.000","end":"00:00:01.000","text":"smoke"}' >/dev/null
echo "after add:"; curl -sk "https://localhost:7010/uttale/Favorites" | python3 -c "import sys,json;print(json.load(sys.stdin)['results_count'])"
curl -sk -X DELETE "https://localhost:7021/api/favorite?filename=OFFLINE_SMOKE.vtt&start=00:00:00.000" >/dev/null
echo "after delete:"; curl -sk "https://localhost:7010/uttale/Favorites" | python3 -c "import sys,json;print(json.load(sys.stdin)['results_count'])"
kill "$(cat /tmp/opencode/offline.pid)"
```

Expected: `before: 6`, `after add: 7`, `after delete: 6`. If the final count is
not 6, manually `DELETE` the `OFFLINE_SMOKE.vtt` favorite until it is.

- [ ] **Step 7: Commit**

```bash
git add offline/offline.py
git commit -m "srst-offline: /api proxy routes (scopes, lines, audio, favorite POST/DELETE)"
```

---

## Task 3: PWA manifest, icons, and service worker (installable shell)

**Files:**
- Create: `offline/static/manifest.webmanifest`
- Create: `offline/static/icon-192.png`
- Create: `offline/static/icon-512.png`
- Create: `offline/static/sw.js`
- Modify: `offline/static/index.html`

- [ ] **Step 1: Create the manifest**

Create `offline/static/manifest.webmanifest`:

```json
{
  "name": "srst-offline",
  "short_name": "offline",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#0d6efd",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- [ ] **Step 2: Generate the two PNG icons**

Run from repo root (uses ImageMagick if present, else Python/Pillow is not a dep —
prefer `convert`):

```bash
convert -size 192x192 xc:'#0d6efd' -gravity center -pointsize 90 -fill white -annotate 0 'O' offline/static/icon-192.png
convert -size 512x512 xc:'#0d6efd' -gravity center -pointsize 240 -fill white -annotate 0 'O' offline/static/icon-512.png
```

If `convert` is unavailable, create solid-color PNGs with the harken venv:

```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python - <<'PY'
import struct, zlib
def png(path, size, rgb):
    def chunk(t, d): 
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
png("offline/static/icon-192.png", 192, (13, 110, 253))
png("offline/static/icon-512.png", 512, (13, 110, 253))
PY
```

Expected: both files exist and are non-empty (`ls -l offline/static/icon-*.png`).

- [ ] **Step 3: Create the service worker (precache shell only)**

Create `offline/static/sw.js`:

```javascript
const CACHE = "srst-offline-v1";
const SHELL = [
  "/",
  "/index.html",
  "/app.css",
  "/db.js",
  "/app.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // /api/* is online-only: never cache, never serve from cache.
  if (url.pathname.startsWith("/api/")) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
```

- [ ] **Step 4: Wire manifest + SW registration into the shell**

Replace the contents of `offline/static/index.html` with:

```html
<!DOCTYPE html>
<html lang="no">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0d6efd">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="stylesheet" href="/app.css">
  <title>srst-offline</title>
</head>
<body>
  <header id="bar">
    <button id="nav-find">Find</button>
    <button id="nav-listen">Listen</button>
    <span id="status"></span>
  </header>
  <main>
    <section id="view-find"></section>
    <section id="view-listen" hidden>
      <audio id="player" controls></audio>
      <ol id="lines"></ol>
    </section>
  </main>
  <script src="/db.js"></script>
  <script src="/app.js"></script>
  <script>
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((e) => console.error("SW", e));
    }
  </script>
</body>
</html>
```

- [ ] **Step 5: Verify served assets**

Run from repo root:

```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 &
echo $! > /tmp/opencode/offline.pid
sleep 1
for p in / /manifest.webmanifest /sw.js /icon-192.png; do
  printf "%s -> " "$p"; curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "http://localhost:7021$p"
done
echo "sw header:"; curl -sI "http://localhost:7021/sw.js" | grep -i "service-worker-allowed"
kill "$(cat /tmp/opencode/offline.pid)"
```

Expected: `/` → `200 text/html…`; `/manifest.webmanifest` → `200 application/manifest+json`;
`/sw.js` → `200 text/javascript…`; `/icon-192.png` → `200 image/png`; and the
`Service-Worker-Allowed: /` header present.

(Note: `app.css`, `db.js`, `app.js` are created in later tasks; `curl` of them now
would 404, which is fine — they are not checked in this step.)

- [ ] **Step 6: Commit**

```bash
git add offline/static/manifest.webmanifest offline/static/icon-192.png offline/static/icon-512.png offline/static/sw.js offline/static/index.html
git commit -m "srst-offline: PWA manifest, icons, service worker, shell wiring"
```

---

## Task 4: IndexedDB layer (`db.js`)

**Files:**
- Create: `offline/static/db.js`

- [ ] **Step 1: Write the IndexedDB wrapper**

Create `offline/static/db.js`. Exposes a global `DB` with promise-based helpers
over three stores. No UI.

```javascript
const DB = (() => {
  const NAME = "srst-offline";
  const VERSION = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("episodes")) db.createObjectStore("episodes", { keyPath: "key" });
        if (!db.objectStoreNames.contains("segments")) db.createObjectStore("segments", { keyPath: "vtt" });
        if (!db.objectStoreNames.contains("favorites")) db.createObjectStore("favorites", { keyPath: "id" });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    }));
  }

  const put = (store, value) => tx(store, "readwrite", (s) => s.put(value));
  const get = (store, key) => tx(store, "readonly", (s) => s.get(key));
  const del = (store, key) => tx(store, "readwrite", (s) => s.delete(key));
  const all = (store) => tx(store, "readonly", (s) => s.getAll());

  return { open, put, get, del, all };
})();
```

- [ ] **Step 2: Verify it is served and is syntactically valid**

Static-syntax check via node if available, else just serve + 200. Run from repo root:

```bash
node --check offline/static/db.js && echo "db.js OK" || echo "node unavailable - skipping syntax check"
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 &
echo $! > /tmp/opencode/offline.pid
sleep 1
curl -s -o /dev/null -w "db.js -> %{http_code} %{content_type}\n" "http://localhost:7021/db.js"
kill "$(cat /tmp/opencode/offline.pid)"
```

Expected: `db.js OK` (if node present) and `db.js -> 200 text/javascript; charset=utf-8`.

- [ ] **Step 3: Commit**

```bash
git add offline/static/db.js
git commit -m "srst-offline: IndexedDB wrapper (db.js)"
```

---

## Task 5: Client app — View 1 (find, group, download) + cached list

**Files:**
- Create: `offline/static/app.css`
- Create: `offline/static/app.js`

- [ ] **Step 1: Minimal CSS**

Create `offline/static/app.css`:

```css
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; margin: 0; padding-bottom: 4rem; }
#bar { position: sticky; top: 0; display: flex; gap: .5rem; align-items: center;
  background: #fff; border-bottom: 1px solid #ddd; padding: .5rem; }
#status { margin-left: auto; font-size: .8rem; color: #666; }
main { padding: .5rem; }
#search { width: 100%; padding: .5rem; font-size: 1rem; }
.episode, .line { padding: .5rem; border-bottom: 1px solid #eee; cursor: pointer; }
.episode small { color: #666; }
.line { display: flex; gap: .5rem; align-items: center; }
.line .text { flex: 1; }
.line.active { background: #dfffd6; }
.star { background: none; border: none; font-size: 1.2rem; cursor: pointer; color: #f5b301; }
button { cursor: pointer; }
ol#lines { list-style: none; margin: 0; padding: 0; }
#player { width: 100%; }
.row-actions { display: flex; gap: .5rem; }
```

- [ ] **Step 2: App scaffolding — element refs, view switching, status, online listener, episode grouping**

Create `offline/static/app.js`:

```javascript
const el = {
  viewFind: document.getElementById("view-find"),
  viewListen: document.getElementById("view-listen"),
  lines: document.getElementById("lines"),
  player: document.getElementById("player"),
  status: document.getElementById("status"),
  navFind: document.getElementById("nav-find"),
  navListen: document.getElementById("nav-listen"),
};

let current = { episodeKey: null, lines: [] }; // lines: [{vtt,start,end,text}]

function episodeKeyOf(vtt) {
  // 48k/<podcast>/<date>/by10m/by10m_NN.vtt  ->  48k/<podcast>/<date>
  const parts = vtt.split("/");
  return parts.slice(0, 3).join("/");
}
function podcastOf(vtt) { return vtt.split("/")[1] || vtt; }
function dateOf(vtt) { return vtt.split("/")[2] || ""; }

function showView(which) {
  el.viewFind.hidden = which !== "find";
  el.viewListen.hidden = which !== "listen";
}
el.navFind.onclick = () => { renderFind(); showView("find"); };
el.navListen.onclick = () => showView("listen");

async function updateStatus() {
  const favs = await DB.all("favorites");
  const pending = favs.filter((f) => f.status !== "synced").length;
  el.status.textContent =
    (navigator.onLine ? "online" : "offline") + ` · ${pending} pending`;
}
window.addEventListener("online", () => { syncFavorites().then(updateStatus); });
window.addEventListener("offline", updateStatus);
```

- [ ] **Step 3: View 1 rendering — search box, results grouped into episodes, cached list with Delete**

Append to `offline/static/app.js`:

```javascript
async function renderFind() {
  el.viewFind.innerHTML = "";
  const input = document.createElement("input");
  input.id = "search";
  input.placeholder = "Search podcast / episode (e.g. Marianne 20210316)";
  el.viewFind.appendChild(input);

  const cachedHdr = document.createElement("h3");
  cachedHdr.textContent = "On this device";
  el.viewFind.appendChild(cachedHdr);
  const cachedBox = document.createElement("div");
  el.viewFind.appendChild(cachedBox);
  await renderCached(cachedBox);

  const resultsHdr = document.createElement("h3");
  resultsHdr.textContent = "Search results";
  el.viewFind.appendChild(resultsHdr);
  const resultsBox = document.createElement("div");
  el.viewFind.appendChild(resultsBox);

  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => search(input.value, resultsBox), 600);
  };
}

async function renderCached(box) {
  box.innerHTML = "";
  const eps = await DB.all("episodes");
  if (!eps.length) { box.innerHTML = "<p><small>Nothing cached yet.</small></p>"; return; }
  for (const ep of eps) {
    const row = document.createElement("div");
    row.className = "episode";
    const label = document.createElement("span");
    label.innerHTML = `${ep.podcast} <small>${ep.date} · ${ep.segments.length} seg</small>`;
    label.onclick = () => openEpisode(ep.key);
    const actions = document.createElement("span");
    actions.className = "row-actions";
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.onclick = async (e) => { e.stopPropagation(); await deleteEpisode(ep); renderCached(box); };
    actions.appendChild(del);
    row.appendChild(label);
    row.appendChild(actions);
    box.appendChild(row);
  }
}

async function search(query, box) {
  box.innerHTML = "<p><small>Searching…</small></p>";
  let data;
  try {
    const r = await fetch("/api/scopes?q=" + encodeURIComponent(query));
    data = await r.json();
  } catch (e) { box.innerHTML = "<p><small>Offline — can't search.</small></p>"; return; }
  const groups = {};
  for (const vtt of data.results || []) {
    const k = episodeKeyOf(vtt);
    (groups[k] = groups[k] || []).push(vtt);
  }
  box.innerHTML = "";
  const keys = Object.keys(groups).sort();
  if (!keys.length) { box.innerHTML = "<p><small>No matches.</small></p>"; return; }
  for (const k of keys) {
    const segs = groups[k].sort();
    const row = document.createElement("div");
    row.className = "episode";
    row.innerHTML = `${podcastOf(segs[0])} <small>${dateOf(segs[0])} · ${segs.length} seg</small>`;
    row.onclick = () => downloadEpisode(k, segs, row);
    box.appendChild(row);
  }
}
```

- [ ] **Step 4: Download + cache an episode, then open it; plus delete**

Append to `offline/static/app.js`:

```javascript
async function downloadEpisode(key, segs, row) {
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (e) {}
  }
  let done = 0;
  for (const vtt of segs) {
    row.innerHTML = `${podcastOf(vtt)} <small>downloading ${done}/${segs.length}…</small>`;
    const linesResp = await fetch("/api/lines?scope=" + encodeURIComponent(vtt));
    const linesData = await linesResp.json();
    const lines = (linesData.results || []).map((r) => ({
      start: r.start, end: r.end, text: r.text,
    }));
    const audioResp = await fetch("/api/audio?filename=" + encodeURIComponent(vtt));
    const audio = await audioResp.blob();
    await DB.put("segments", { vtt, lines, audio });
    done += 1;
  }
  await DB.put("episodes", {
    key, podcast: podcastOf(segs[0]), date: dateOf(segs[0]),
    segments: segs, cachedAt: new Date().toISOString(),
  });
  row.innerHTML = `${podcastOf(segs[0])} <small>${dateOf(segs[0])} · cached</small>`;
  openEpisode(key);
}

async function deleteEpisode(ep) {
  for (const vtt of ep.segments) await DB.del("segments", vtt);
  await DB.del("episodes", ep.key);
}
```

- [ ] **Step 5: Verify served + syntax**

Run from repo root:

```bash
node --check offline/static/app.js && echo "app.js OK" || echo "node unavailable - skipping"
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 &
echo $! > /tmp/opencode/offline.pid
sleep 1
curl -s -o /dev/null -w "app.css -> %{http_code} %{content_type}\n" "http://localhost:7021/app.css"
curl -s -o /dev/null -w "app.js  -> %{http_code} %{content_type}\n" "http://localhost:7021/app.js"
kill "$(cat /tmp/opencode/offline.pid)"
```

Expected: `app.js OK` (if node present); `app.css -> 200 text/css…`;
`app.js -> 200 text/javascript…`.

- [ ] **Step 6: Commit**

```bash
git add offline/static/app.css offline/static/app.js
git commit -m "srst-offline: View 1 (search, group episodes, download/cache, cached list)"
```

---

## Task 6: Client app — View 2 (continuous lines, playback) + favoriting + sync

**Files:**
- Modify: `offline/static/app.js`

- [ ] **Step 1: Open an episode → build the continuous line list from cache**

Append to `offline/static/app.js`:

```javascript
async function openEpisode(key) {
  const ep = await DB.get("episodes", key);
  if (!ep) return;
  current = { episodeKey: key, lines: [] };
  for (const vtt of ep.segments) {
    const seg = await DB.get("segments", vtt);
    if (!seg) continue;
    for (const ln of seg.lines) {
      current.lines.push({ vtt, start: ln.start, end: ln.end, text: ln.text });
    }
  }
  await renderLines();
  showView("listen");
}

function tsToSeconds(s) {
  const [h, m, rest] = s.split(":");
  const [sec, ms] = rest.replace(",", ".").split(".");
  return (+h) * 3600 + (+m) * 60 + (+sec) + (ms ? +ms / 1000 : 0);
}
```

- [ ] **Step 2: Render lines with stars; play a line by swapping the segment blob**

Append to `offline/static/app.js`:

```javascript
let audioVtt = null; // which segment blob is currently loaded in the player

async function favIdsForEpisode() {
  const favs = await DB.all("favorites");
  const set = new Set();
  for (const f of favs) if (f.status !== "deleted") set.add(f.id);
  return set;
}

async function renderLines() {
  el.lines.innerHTML = "";
  const favSet = await favIdsForEpisode();
  current.lines.forEach((ln, i) => {
    const id = ln.vtt + "|" + ln.start;
    const li = document.createElement("li");
    li.className = "line";
    li.dataset.index = i;
    const star = document.createElement("button");
    star.className = "star";
    star.textContent = favSet.has(id) ? "★" : "☆";
    star.onclick = (e) => { e.stopPropagation(); toggleFavorite(ln, star); };
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = ln.text;
    li.appendChild(star);
    li.appendChild(text);
    li.onclick = () => playLine(i);
    el.lines.appendChild(li);
  });
}

async function playLine(i) {
  const ln = current.lines[i];
  if (audioVtt !== ln.vtt) {
    const seg = await DB.get("segments", ln.vtt);
    if (!seg) return;
    el.player.src = URL.createObjectURL(seg.audio);
    audioVtt = ln.vtt;
  }
  el.player.currentTime = tsToSeconds(ln.start);
  el.player.play();
  highlight(i);
}

function highlight(i) {
  el.lines.querySelectorAll(".line.active").forEach((n) => n.classList.remove("active"));
  const li = el.lines.querySelector(`.line[data-index="${i}"]`);
  if (li) li.classList.add("active");
}
```

- [ ] **Step 3: Favorite toggle (local, queued) and sync (replay on reconnect/open)**

Append to `offline/static/app.js`:

```javascript
async function toggleFavorite(ln, star) {
  const id = ln.vtt + "|" + ln.start;
  const existing = await DB.get("favorites", id);
  if (!existing) {
    await DB.put("favorites", {
      id, filename: ln.vtt, start: ln.start, end: ln.end, text: ln.text,
      status: "pending", updatedAt: new Date().toISOString(),
    });
    star.textContent = "★";
  } else if (existing.status === "synced") {
    existing.status = "deleted";
    existing.updatedAt = new Date().toISOString();
    await DB.put("favorites", existing);
    star.textContent = "☆";
  } else {
    // pending and not yet synced -> just drop it
    await DB.del("favorites", id);
    star.textContent = "☆";
  }
  updateStatus();
  if (navigator.onLine) syncFavorites().then(updateStatus);
}

async function syncFavorites() {
  if (!navigator.onLine) return;
  const favs = await DB.all("favorites");
  for (const f of favs) {
    try {
      if (f.status === "pending") {
        const r = await fetch("/api/favorite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: f.filename, start: f.start, end: f.end, text: f.text,
          }),
        });
        if (r.ok) { f.status = "synced"; await DB.put("favorites", f); }
      } else if (f.status === "deleted") {
        const r = await fetch(
          "/api/favorite?filename=" + encodeURIComponent(f.filename) +
          "&start=" + encodeURIComponent(f.start), { method: "DELETE" });
        if (r.ok) await DB.del("favorites", f.id);
      }
    } catch (e) { /* stay queued for next attempt */ }
  }
}
```

- [ ] **Step 4: Boot — register status, attempt sync, render initial view**

Append to `offline/static/app.js`:

```javascript
(async function boot() {
  await updateStatus();
  if (navigator.onLine) { await syncFavorites(); await updateStatus(); }
  renderFind();
  showView("find");
})();
```

- [ ] **Step 5: Verify served + syntax**

Run from repo root:

```bash
node --check offline/static/app.js && echo "app.js OK" || echo "node unavailable - skipping"
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 &
echo $! > /tmp/opencode/offline.pid
sleep 1
curl -s -o /dev/null -w "app.js -> %{http_code}\n" "http://localhost:7021/app.js"
kill "$(cat /tmp/opencode/offline.pid)"
```

Expected: `app.js OK` (if node present); `app.js -> 200`.

- [ ] **Step 6: Commit**

```bash
git add offline/static/app.js
git commit -m "srst-offline: View 2 (continuous lines, playback, favoriting, sync)"
```

---

## Task 7: Packaging — console script + package data

**Files:**
- Modify: `pyproject.toml`

- [ ] **Step 1: Add console script, package, and static package-data**

Edit `pyproject.toml`. Add the `srst-offline` entry under `[project.scripts]`,
add `"offline"` to packages, and declare the static files as package data:

```toml
[project.scripts]
srst-harken = "harken.harken:main"
srst-offline = "offline.offline:main"

[tool.setuptools]
packages = ["harken", "offline"]

[tool.setuptools.package-data]
offline = ["static/*"]
```

(Replace the existing `[project.scripts]` and `[tool.setuptools]` blocks; add the
new `[tool.setuptools.package-data]` block.)

- [ ] **Step 2: Verify the package is importable and the entry point resolves**

Run from repo root:

```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -c "import offline.offline as o; print('main' in dir(o))"
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m py_compile offline/offline.py
```

Expected: `True`, then no output from py_compile (exit 0).

- [ ] **Step 3: Verify static files resolve relative to the module (installed-path safety)**

Run from a **different** directory so `STATIC_DIR` is exercised as an absolute,
`__file__`-relative path (not cwd-relative):

```bash
cd /tmp && /mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -c "
from offline.offline import STATIC_DIR
print(STATIC_DIR, (STATIC_DIR / 'index.html').is_file())
"
```

Expected: prints the absolute `…/offline/static` path and `True`.

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml
git commit -m "srst-offline: console script + package data"
```

---

## Task 8: End-to-end smoke + manual browser verification doc

**Files:**
- Modify: `SESSION.md`

- [ ] **Step 1: Full-stack served smoke over HTTPS**

Run from repo root (this is the closest automatable proxy for the real device
flow — it confirms every asset and every `/api/*` route is healthy together):

```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 --ssl &
echo $! > /tmp/opencode/offline.pid
sleep 1
for p in / /index.html /app.css /db.js /app.js /sw.js /manifest.webmanifest /icon-192.png /icon-512.png; do
  printf "%-26s " "$p"; curl -sk -o /dev/null -w "%{http_code} %{content_type}\n" "https://localhost:7021$p"
done
echo "--- api ---"
curl -sk "https://localhost:7021/api/scopes?q=MarianneMoterMennesker/20210316" | python3 -c "import sys,json;print('scopes',len(json.load(sys.stdin)['results']))"
curl -sk "https://localhost:7021/api/lines?scope=48k/MarianneMoterMennesker/20210316/by10m/by10m_00.vtt" | python3 -c "import sys,json;print('lines',len(json.load(sys.stdin)['results']))"
curl -sk "https://localhost:7021/api/audio?filename=48k/MarianneMoterMennesker/20210316/by10m/by10m_00.vtt" -o /dev/null -w "audio %{http_code} %{size_download}\n"
kill "$(cat /tmp/opencode/offline.pid)"
```

Expected: all nine assets `200` with sensible content types; `scopes 2`;
`lines <positive>`; `audio 200 <large>`.

- [ ] **Step 2: Confirm favorites count is still 6 (no test residue)**

```bash
curl -sk "https://localhost:7010/uttale/Favorites" | python3 -c "import sys,json;print('favorites',json.load(sys.stdin)['results_count'])"
```

Expected: `favorites 6`. If not, delete stray `*SMOKE*` favorites until it is 6.

- [ ] **Step 3: Record the manual on-device checklist in SESSION.md**

Add a short section to `SESSION.md` documenting what only a real browser/phone can
verify (the agent cannot automate SW/IndexedDB/offline). Append under a new
heading:

```markdown
## srst-offline — manual device verification

Run: `srst-offline --ssl` (https on :7020, proxies https://localhost:7010).
On phone (same wifi): open `https://<home-pc-lan-ip>:7020`, accept cert, Add to
Home Screen. Then verify:

1. Find: search "MarianneMoterMennesker 20210316" -> one episode (2 seg) appears.
2. Download: tap it -> progress -> opens listen view; episode shows under
   "On this device".
3. Online listen: tap lines -> audio plays, active line highlights.
4. Star a few lines (★). Header shows "N pending".
5. Go offline (airplane mode). Fully close + reopen the app from the home screen.
   It still boots; the episode and lines are present; audio still plays; starring
   still works (pending count changes).
6. Back online. Within a moment the pending count drops to 0 (auto-sync). Confirm
   on the server: `curl -sk https://localhost:7010/uttale/Favorites` shows the new
   favorites; un-favoriting offline then reconnecting removes them too.

Known risk: some mobile browsers refuse to register a service worker behind a
self-signed cert. If step 5 fails to boot offline, trust the cert on the phone
(or use a real cert) and retry.
```

- [ ] **Step 4: Commit**

```bash
git add SESSION.md
git commit -m "srst-offline: end-to-end smoke notes + manual device checklist"
```

---

## Self-review notes (for the implementer)

- The four spec proxy routes (scopes, lines, audio, favorite POST **and** DELETE)
  are all in Task 2. The offline boundary (SW skips `/api/*`) is in Task 3 Step 3.
- IndexedDB stores match the spec (`episodes`/`segments`/`favorites`) in Task 4;
  the `favorites` key is `filename + "|" + start` (used consistently as `id` in
  Tasks 4/6). Episode key = first 3 path segments (`48k/<podcast>/<date>`),
  defined once in `episodeKeyOf` (Task 5) and reused in Task 6.
- Sync handles both `pending` (POST) and `deleted` (DELETE) per the spec decision;
  idempotency makes replays safe.
- Storage management (per-episode Delete + `storage.persist()`) is in Task 5.
- No pytest is used anywhere by design (repo has no suite); every task verifies via
  `py_compile`, `node --check` (best-effort), `curl -k` smoke against the live
  backend, or the documented manual device checklist.
