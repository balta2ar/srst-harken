# Play Favorite Clips (offline-capable) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user play a favorite group's short audio clip directly from the Favorites tab — without downloading the whole episode — and have those clips available offline after favorites were loaded while online.

**Architecture:** A favorite "group" is always adjacent lines in one file, so its audio is a single contiguous span `[first.start − 0.5s, last.end + 0.5s]` (same as export). The backend reuses `GET /uttale/Audio` (already ffmpeg-extracts a clip) with added `ETag` + immutable `Cache-Control`. The offline server adds a `GET /api/clip` proxy. The client fetches each group's clip as a Blob, stores it in a new IndexedDB `clips` store, plays it from a dedicated `<audio>`, and prefetches all missing clips (pruning orphans) on boot and Favorites-tab open.

**Tech Stack:** Python 3.12 (FastAPI single-file backend; stdlib `ThreadingHTTPServer` proxy), vanilla JS (IndexedDB, `<audio>`), ffmpeg. Tests: `unittest` (uttale), `node --check` + `fake-indexeddb` harness (offline). NO pytest.

## Global Constraints

- NO pytest anywhere. Verify uttale via `python -m py_compile` + `python -m unittest`; verify offline via `node --check` + a `fake-indexeddb` node harness that extracts the REAL functions, plus a `curl -k` live smoke. (AGENTS.md, both repos.)
- uttale: keep all imports at the top of the file; no comments unless they explain "why"; mimic existing style; compact (see STYLE.md). New code must add ZERO new ruff issues (pre-existing ruff issues are not ours).
- offline: stage only named files; NEVER `git add -A`. Leave untracked noise alone (`.ctags`, `*.egg-info/`, `hello.py`, `openapi.json`, `response.json`, throwaway DBs, `__pycache__/`). uttale similarly: leave its untracked DBs/profiles/`Makefile`/`other/` alone.
- Test envs: uttale unittest → `/tmp/opencode/uttale-test/bin/python` (has duckdb/polars/webvtt/fastapi/httpx; ffmpeg available on PATH). Node → `node` v25 with `fake-indexeddb` in `/tmp/opencode/node_modules` (run harnesses from `/tmp/opencode`). harken venv (unused here) `/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python`.
- The real uttale runs at `https://localhost:7010` and its DuckDB `~/.cache/srst-uttale/root.db` is LOCKED by it. NEVER start/stop/touch it. Throwaway smoke instances: uttale on `127.0.0.1:7011` (launched with `--iface host:port`, NEVER `--port`) with separate `--db`/`--favorites-db`/`--listens-db` under `/tmp/opencode`, and offline on `127.0.0.1:7023`. Kill by PID saved in `/tmp/opencode/{utt,off}.pid`; never bare `pkill`. Temp work in `/tmp/opencode`.
- DATE/timestamps: never locale `M/D/YYYY`; clips use VTT strings `HH:MM:SS.mmm`.
- The two repos: offline UI = `/mnt/payload/share/msi/prg/srst-harken`; uttale backend = `/home/bz/share/btsync/prg/srst-uttale` (same files also at `/mnt/payload/share/msi/prg/srst-uttale` — same inode). Feature targets the **offline PWA only**, NOT the legacy `harken/` NiceGUI app.
- Spec: `/mnt/payload/share/msi/prg/srst-harken/docs/specs/2026-06-28-favorite-clips-design.md`.

---

## File Structure

**uttale backend** (`/home/bz/share/btsync/prg/srst-uttale`):
- `uttale/backend/server.py` — add `import hashlib`; add pure `audio_etag(filename, start, end)`; add ETag + immutable Cache-Control to the segment-extraction branch of `get_audio_segment`.
- `uttale/backend/test_server.py` — add `TestAudioCaching`.

**offline** (`/mnt/payload/share/msi/prg/srst-harken`):
- `offline/offline.py` — extend `_proxy_audio` to relay `ETag`/`Cache-Control`; add `GET /api/clip` route forwarding `filename`(→`.ogg`)/`start`/`end` to `/uttale/Audio`.
- `offline/static/db.js` — bump `VERSION` 2→3; add `clips` store (`keyPath: "id"`).
- `offline/static/api.js` — add `Api.clipBlob(filename, start, end)`.
- `offline/static/app.js` — add `clipTs`, `clipSpan`, `getClip`, `playClip`, `stopClip`, `prefetchClips`; per-group ▶ button in `_renderFav`; wire prefetch into `navFav` + `boot`; add `el.clipPlayer`.
- `offline/static/index.html` — add hidden `<audio id="clip-player">`.
- `offline/static/app.css` — `.fav .play` + playing state.

---

## Task 1: Backend — ETag + immutable Cache-Control on clip extraction

**Files:**
- Modify: `/home/bz/share/btsync/prg/srst-uttale/uttale/backend/server.py` (imports near line 1-18; `get_audio_segment` lines 596-671)
- Test: `/home/bz/share/btsync/prg/srst-uttale/uttale/backend/test_server.py` (imports line 13-37; new class after `TestGenerateTopics`)

**Interfaces:**
- Produces: `audio_etag(filename: str, start: str, end: str) -> str` returning a quoted ETag like `"\"<sha1hex>\""`. The segment-extraction branch of `get_audio_segment` returns headers dict additionally containing `"ETag"` and `"Cache-Control": "public, max-age=31536000, immutable"`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `/home/bz/share/btsync/prg/srst-uttale/uttale/backend/test_server.py`. First extend the import block (lines 13-37) to add `audio_etag`, `get_audio_segment`, and the module itself:

```python
from uttale.backend import server
from uttale.backend.server import (
    resolve_db_path,
    pattern_to_wildcard,
    favorites_add,
    favorites_get,
    favorites_list,
    favorites_update,
    favorites_delete,
    parse_topic_time,
    read_topics,
    topics_dir_for,
    run_vtt_topics,
    start_topics_generation,
    _topics_running,
    _topics_lock,
    listens_upsert,
    listens_list,
    LISTENS_LIMIT,
    audio_etag,
    get_audio_segment,
)
```

Then add this class after `TestGenerateTopics` (the test generates a real 0.5s silent `.ogg` with ffmpeg under a temp `--root`, points `server.args` at it, and checks the extraction-branch headers):

```python
class TestAudioCaching(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.filename = os.path.join('48k', 'Pod', '20260628', 'by10m', 'by10m_00.vtt')
        ogg = os.path.join(self.root, os.path.dirname(self.filename), 'by10m_00.ogg')
        os.makedirs(os.path.dirname(ogg))
        subprocess.run(
            ['ffmpeg', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
             '-t', '2', '-c:a', 'libopus', ogg],
            capture_output=True, check=True,
        )
        self._orig_args = server.args
        server.args = SimpleNamespace(root=self.root)

    def tearDown(self):
        server.args = self._orig_args
        shutil.rmtree(self.root, ignore_errors=True)

    def test_etag_is_stable_for_a_span(self):
        a = audio_etag(self.filename, '00:00:00.000', '00:00:01.000')
        b = audio_etag(self.filename, '00:00:00.000', '00:00:01.000')
        self.assertEqual(a, b)
        self.assertTrue(a.startswith('"') and a.endswith('"'))

    def test_etag_differs_across_spans(self):
        a = audio_etag(self.filename, '00:00:00.000', '00:00:01.000')
        b = audio_etag(self.filename, '00:00:00.000', '00:00:01.500')
        self.assertNotEqual(a, b)

    def test_segment_headers_include_etag_and_immutable(self):
        _data, headers = get_audio_segment(self.filename, '00:00:00.000', '00:00:01.000')
        self.assertEqual(headers['ETag'], audio_etag(self.filename, '00:00:00.000', '00:00:01.000'))
        self.assertIn('immutable', headers['Cache-Control'])
```

Also add `from types import SimpleNamespace` to the test file's imports (top, near line 1-9).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/bz/share/btsync/prg/srst-uttale && /tmp/opencode/uttale-test/bin/python -m unittest uttale.backend.test_server.TestAudioCaching -v`
Expected: FAIL — `ImportError: cannot import name 'audio_etag'`.

- [ ] **Step 3: Add `import hashlib`**

In `/home/bz/share/btsync/prg/srst-uttale/uttale/backend/server.py`, add `hashlib` to the stdlib imports. Insert after `import fnmatch` (line 2) so the import block stays alphabetical-ish and grouped:

```python
import argparse
import fnmatch
import hashlib
import logging
```

- [ ] **Step 4: Add the `audio_etag` helper**

Insert immediately ABOVE `def get_audio_segment(` (currently line 596) in `server.py`:

```python
def audio_etag(filename: str, start: str, end: str) -> str:
    digest = hashlib.sha1(f"{filename}|{start}|{end}".encode("utf-8")).hexdigest()
    return f'"{digest}"'


```

- [ ] **Step 5: Add ETag + immutable headers to the extraction branch**

In `server.py`, change the segment-extraction return (currently line 671) from:

```python
        return proc.stdout, {"Cache-Control": "max-age=86400"}
```

to:

```python
        return proc.stdout, {
            "Cache-Control": "public, max-age=31536000, immutable",
            "ETag": audio_etag(filename, start, end),
        }
```

(Leave the byte-range branch at line 636-641 and the full-file branch at line 646 unchanged.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd /home/bz/share/btsync/prg/srst-uttale && /tmp/opencode/uttale-test/bin/python -m unittest uttale.backend.test_server.TestAudioCaching -v`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full uttale suite + py_compile + ruff-delta check**

Run: `cd /home/bz/share/btsync/prg/srst-uttale && /tmp/opencode/uttale-test/bin/python -m py_compile uttale/backend/server.py uttale/backend/test_server.py && /tmp/opencode/uttale-test/bin/python -m unittest uttale.backend.test_server 2>&1 | tail -4`
Expected: `py_compile` clean; `OK` (65 tests: 62 prior + 3 new).

Then confirm no NEW ruff issues land on the added lines:
Run: `ruff check /home/bz/share/btsync/prg/srst-uttale/uttale/backend/server.py 2>&1 | rg -o "server\.py:\d+:" | sort -t: -k2 -n`
Expected: the error line numbers are all pre-existing (none inside the new `audio_etag` function or the changed return). Cross-check by viewing line numbers; if a new one appears in your added range, fix it.

- [ ] **Step 8: Commit (uttale repo)**

```bash
cd /home/bz/share/btsync/prg/srst-uttale
git add uttale/backend/server.py uttale/backend/test_server.py
git commit -m "backend: ETag + immutable Cache-Control on extracted audio clips

get_audio_segment's segment-extraction branch now returns a stable ETag
(sha1 of filename|start|end) and Cache-Control: public, max-age=31536000,
immutable, so clients/proxies can treat an immutable [start,end] clip as
permanently cacheable. Adds audio_etag helper and TestAudioCaching (3)."
```

---

## Task 2: Offline proxy — relay cache headers + add `GET /api/clip`

**Files:**
- Modify: `/mnt/payload/share/msi/prg/srst-harken/offline/offline.py` (`_proxy_audio` lines 124-142; `do_GET` dispatch lines 147-164)

**Interfaces:**
- Consumes: `audio_etag`/headers from Task 1 (via the upstream HTTP response — no import).
- Produces: HTTP route `GET /api/clip?filename=<vtt>&start=<HH:MM:SS.mmm>&end=<HH:MM:SS.mmm>` returning `audio/ogg` bytes with `ETag` + `Cache-Control` relayed. `_proxy_audio(params)` now also relays `ETag` and `Cache-Control` response headers.

NOTE: This task is verified by the live smoke in Task 7 (the offline proxy needs a running upstream). For now, verify by `py_compile` + a route-presence check.

- [ ] **Step 1: Extend `_proxy_audio` to relay ETag + Cache-Control**

In `/mnt/payload/share/msi/prg/srst-harken/offline/offline.py`, change `_proxy_audio` (lines 132-137) from:

```python
        self.send_response(200)
        self.send_header("Content-Type", upstream.headers.get("Content-Type", "audio/ogg"))
        cl = upstream.headers.get("Content-Length")
        if cl:
            self.send_header("Content-Length", cl)
        self.end_headers()
```

to:

```python
        self.send_response(200)
        self.send_header("Content-Type", upstream.headers.get("Content-Type", "audio/ogg"))
        cl = upstream.headers.get("Content-Length")
        if cl:
            self.send_header("Content-Length", cl)
        for h in ("ETag", "Cache-Control"):
            v = upstream.headers.get(h)
            if v:
                self.send_header(h, v)
        self.end_headers()
```

- [ ] **Step 2: Add the `/api/clip` route to `do_GET`**

In `offline.py`, insert a new branch in `do_GET` immediately after the `/api/audio` branch (after line 160, before the `/api/favorites` branch at line 161):

```python
        elif parsed.path == "/api/clip":
            ogg = str(Path(q.get("filename", [""])[0]).with_suffix(".ogg"))
            self._proxy_audio({
                "filename": ogg,
                "start": q.get("start", [""])[0],
                "end": q.get("end", [""])[0],
            })
```

(`Path` is already imported at line 12; `q` = `parse_qs(parsed.query)` already exists at line 146. The `.vtt`→`.ogg` conversion mirrors `_export` at line 230.)

- [ ] **Step 3: Verify py_compile + route presence**

Run: `cd /mnt/payload/share/msi/prg/srst-harken && /tmp/opencode/uttale-test/bin/python -m py_compile offline/offline.py && echo OK`
Expected: `OK`.

Run: `cd /mnt/payload/share/msi/prg/srst-harken && rg -n "api/clip|ETag|Cache-Control" offline/offline.py`
Expected: shows the new `/api/clip` branch and the two relayed headers in `_proxy_audio`.

- [ ] **Step 4: Commit (offline repo)**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add offline/offline.py
git commit -m "offline: add /api/clip proxy + relay ETag/Cache-Control for audio

/api/clip forwards filename(->.ogg)/start/end to /uttale/Audio so the client
can fetch an arbitrary favorite-group clip (the existing /api/audio hard-codes
empty start/end). _proxy_audio now relays the upstream ETag and Cache-Control."
```

---

## Task 3: Client storage — `clips` IndexedDB store (DB v3)

**Files:**
- Modify: `/mnt/payload/share/msi/prg/srst-harken/offline/static/db.js` (VERSION line 3; `onupgradeneeded` lines 10-16)
- Test: `/tmp/opencode/db3.test.js` (throwaway harness; not committed)

**Interfaces:**
- Produces: an IndexedDB object store `"clips"` with `keyPath: "id"`, reachable via the existing generic `DB.put/get/del/all`. Existing stores (`episodes`, `segments`, `favorites`, `listened`) are preserved (additive upgrade).

- [ ] **Step 1: Write the failing test**

Create `/tmp/opencode/db3.test.js`:

```javascript
require("fake-indexeddb/auto");
const assert = require("assert");
const fs = require("fs");
const DB = eval(fs.readFileSync("/mnt/payload/share/msi/prg/srst-harken/offline/static/db.js","utf8") + "; DB;");

(async () => {
  await DB.open();
  await DB.put("clips", { id: "a|0|1", blob: "BLOB" });
  const got = await DB.get("clips", "a|0|1");
  assert.strictEqual(got.blob, "BLOB", "clips store round-trips");
  // existing stores still usable (additive upgrade)
  await DB.put("favorites", { id: "x|y", filename: "x", start: "y" });
  assert.ok(await DB.get("favorites", "x|y"), "favorites store still present");
  console.log("DB v3 clips store OK");
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /tmp/opencode && node db3.test.js`
Expected: FAIL — `NotFoundError`-style error because object store `clips` does not exist.

- [ ] **Step 3: Bump VERSION and add the store**

In `/mnt/payload/share/msi/prg/srst-harken/offline/static/db.js`, change line 3:

```javascript
  const VERSION = 3;
```

and add inside `onupgradeneeded` (after line 15, the `listened` line):

```javascript
        if (!db.objectStoreNames.contains("clips")) db.createObjectStore("clips", { keyPath: "id" });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /tmp/opencode && node db3.test.js`
Expected: `DB v3 clips store OK`.

- [ ] **Step 5: Syntax check + cleanup**

Run: `cd /mnt/payload/share/msi/prg/srst-harken && node --check offline/static/db.js && echo ok && rm -f /tmp/opencode/db3.test.js`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add offline/static/db.js
git commit -m "offline: add IndexedDB clips store (DB v3, additive upgrade)"
```

---

## Task 4: Client API — `Api.clipBlob`

**Files:**
- Modify: `/mnt/payload/share/msi/prg/srst-harken/offline/static/api.js` (add function before the `return` at line ~88; extend the returned object)

**Interfaces:**
- Produces: `Api.clipBlob(filename: string, start: string, end: string) -> Promise<Blob|null>` — GETs `/api/clip?filename=&start=&end=`; returns the response Blob, or `null` on a non-ok response or thrown error.

- [ ] **Step 1: Write the failing test**

Create `/tmp/opencode/clipblob.test.js` (it stubs global `fetch`, extracts the real `Api` IIFE, and checks both success and failure paths):

```javascript
const assert = require("assert");
const fs = require("fs");
const src = fs.readFileSync("/mnt/payload/share/msi/prg/srst-harken/offline/static/api.js","utf8");

let lastUrl = null, mode = "ok";
global.fetch = async (url) => {
  lastUrl = url;
  if (mode === "ok") return { ok: true, blob: async () => "CLIPBLOB" };
  if (mode === "bad") return { ok: false, blob: async () => { throw new Error("no"); } };
  throw new Error("network");
};
const Api = eval(src + "; Api;");

(async () => {
  assert.strictEqual(typeof Api.clipBlob, "function", "Api.clipBlob exists");
  mode = "ok";
  const b = await Api.clipBlob("48k/Pod/20260628/by10m/by10m_00.vtt", "00:00:01.000", "00:00:03.000");
  assert.strictEqual(b, "CLIPBLOB", "returns blob on ok");
  assert.ok(lastUrl.includes("/api/clip?"), "hits /api/clip");
  assert.ok(lastUrl.includes("filename=") && lastUrl.includes("start=") && lastUrl.includes("end="), "passes params");
  mode = "bad";
  assert.strictEqual(await Api.clipBlob("f", "a", "b"), null, "null on !ok");
  mode = "throw";
  assert.strictEqual(await Api.clipBlob("f", "a", "b"), null, "null on throw");
  console.log("Api.clipBlob OK");
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /tmp/opencode && node clipblob.test.js`
Expected: FAIL — `Api.clipBlob exists` assertion fails (function undefined).

- [ ] **Step 3: Add `clipBlob`**

In `/mnt/payload/share/msi/prg/srst-harken/offline/static/api.js`, add this function immediately after `generateTopics` (after its closing `}` near line 80) and before the `return { ... }` line:

```javascript
  async function clipBlob(filename, start, end) {
    try {
      const r = await fetch("/api/clip?filename=" + encodeURIComponent(filename) +
        "&start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end));
      if (!r.ok) return null;
      return r.blob();
    } catch (e) {
      return null;
    }
  }
```

Then add `clipBlob` to the returned object (the `return { scopes, lines, ... }` line):

```javascript
  return { scopes, lines, favList, audioBlob, favAdd, favDel, exportFav, markExported, topics, generateTopics, clipBlob, listenList, listenPut };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /tmp/opencode && node clipblob.test.js`
Expected: `Api.clipBlob OK`.

- [ ] **Step 5: Syntax check + cleanup**

Run: `cd /mnt/payload/share/msi/prg/srst-harken && node --check offline/static/api.js && echo ok && rm -f /tmp/opencode/clipblob.test.js`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add offline/static/api.js
git commit -m "offline: add Api.clipBlob(filename,start,end) -> Blob|null"
```

---

## Task 5: Client logic — `clipTs`, `clipSpan`, `getClip` (+ markup/CSS, player ref)

**Files:**
- Modify: `/mnt/payload/share/msi/prg/srst-harken/offline/static/app.js` (add `el.clipPlayer` to the `el` object lines 1-30; add helpers near the favorites block, after `groupUpdatedAt` line 717-719)
- Modify: `/mnt/payload/share/msi/prg/srst-harken/offline/static/index.html` (after `<audio id="player">` line 50)
- Modify: `/mnt/payload/share/msi/prg/srst-harken/offline/static/app.css` (append `.fav .play`)
- Test: `/tmp/opencode/getclip.test.js` (throwaway)

**Interfaces:**
- Consumes: `Api.clipBlob` (Task 4), `clips` store (Task 3), `Timeline.tsToSeconds`/`Timeline.fmtVtt`, `DB.get`/`DB.put`.
- Produces:
  - `clipTs(ts: string, delta: number) -> string` (VTT string, clamped ≥ 0).
  - `clipSpan(group: Favorite[]) -> { filename, start, end, id }` where `start = clipTs(group[0].start, -0.5)`, `end = clipTs(group[last].end || group[last].start, +0.5)`, `id = filename + "|" + start + "|" + end`.
  - `getClip(group) -> Promise<Blob|null>` — returns the cached Blob from the `clips` store, else (when `navigator.onLine`) fetches via `Api.clipBlob`, stores `{ id, blob }`, returns it; offline + uncached → `null`.
  - `el.clipPlayer` — the dedicated `<audio id="clip-player">`.

- [ ] **Step 1: Add the hidden clip `<audio>` to index.html**

In `/mnt/payload/share/msi/prg/srst-harken/offline/static/index.html`, add directly after line 50 (`<audio id="player"></audio>`):

```html
  <audio id="clip-player"></audio>
```

- [ ] **Step 2: Add `el.clipPlayer` reference**

In `app.js`, add to the `el` object (after line 6, the `player:` entry):

```javascript
  clipPlayer: document.getElementById("clip-player"),
```

- [ ] **Step 3: Write the failing test**

Create `/tmp/opencode/getclip.test.js` (provides `fake-indexeddb`, a `DB` from db.js, a `Timeline` from timeline.js, a controllable `Api.clipBlob` + `navigator.onLine`, then extracts the real `clipTs`/`clipSpan`/`getClip`):

```javascript
require("fake-indexeddb/auto");
const assert = require("assert");
const fs = require("fs");
const base = "/mnt/payload/share/msi/prg/srst-harken/offline/static/";
const DB = eval(fs.readFileSync(base + "db.js","utf8") + "; DB;");
const Timeline = eval(fs.readFileSync(base + "timeline.js","utf8") + "; Timeline;");
const app = fs.readFileSync(base + "app.js","utf8");
global.DB = DB; global.Timeline = Timeline;

function setOnline(v){ Object.defineProperty(globalThis,"navigator",{value:{onLine:v},configurable:true}); }
let fetchCount = 0, fetchReturn = "BLOB";
global.Api = { clipBlob: async () => { fetchCount++; return fetchReturn; } };

function grab(re){ const m = app.match(re); if(!m) throw new Error("missing "+re); return m[0]; }
eval(grab(/function clipTs\([\s\S]*?\n\}/).replace("function clipTs","global.clipTs = function"));
eval(grab(/function clipSpan\([\s\S]*?\n\}/).replace("function clipSpan","global.clipSpan = function"));
eval(grab(/async function getClip\([\s\S]*?\n\}/).replace("async function getClip","global.getClip = async function"));

const file = "48k/Pod/20260628/by10m/by10m_00.vtt";
const group = [
  { filename: file, start: "00:00:10.000", end: "00:00:12.000", text: "a" },
  { filename: file, start: "00:00:12.000", end: "00:00:15.000", text: "b" },
];

(async () => {
  await DB.open();

  // clipTs clamps and pads
  assert.strictEqual(clipTs("00:00:00.200", -0.5), "00:00:00.000", "clipTs clamps to 0");
  assert.strictEqual(clipTs("00:00:10.000", -0.5), "00:00:09.500", "clipTs subtracts");

  // clipSpan uses first.start-0.5 .. last.end+0.5
  const span = clipSpan(group);
  assert.strictEqual(span.start, "00:00:09.500", "span start");
  assert.strictEqual(span.end, "00:00:15.500", "span end");
  assert.strictEqual(span.id, file + "|00:00:09.500|00:00:15.500", "span id");

  // online miss -> fetch + store
  setOnline(true); fetchCount = 0;
  const b1 = await getClip(group);
  assert.strictEqual(b1, "BLOB", "returns fetched blob");
  assert.strictEqual(fetchCount, 1, "fetched once on miss");
  assert.ok(await DB.get("clips", span.id), "stored in clips");

  // hit -> no fetch
  fetchCount = 0;
  const b2 = await getClip(group);
  assert.strictEqual(fetchCount, 0, "cache hit skips fetch");
  assert.ok(b2, "returns cached blob");

  // offline miss -> null
  await DB.del("clips", span.id);
  setOnline(false); fetchCount = 0;
  const b3 = await getClip(group);
  assert.strictEqual(b3, null, "offline miss returns null");
  assert.strictEqual(fetchCount, 0, "no fetch when offline");

  console.log("clipTs/clipSpan/getClip OK");
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd /tmp/opencode && node getclip.test.js`
Expected: FAIL — `missing /function clipTs.../` (helpers not defined yet).

- [ ] **Step 5: Implement the helpers**

In `app.js`, add this block immediately after `groupUpdatedAt` (after line 719):

```javascript
function clipTs(ts, delta) {
  return Timeline.fmtVtt(Math.max(0, Timeline.tsToSeconds(ts) + delta));
}

// A favorite group is adjacent lines in one file; its clip spans the first
// member's start to the last member's end, padded ±0.5s (same as export), so one
// cached clip serves both playback and export.
function clipSpan(group) {
  const first = group[0], last = group[group.length - 1];
  const filename = first.filename;
  const start = clipTs(first.start, -0.5);
  const end = clipTs(last.end || last.start, 0.5);
  return { filename, start, end, id: filename + "|" + start + "|" + end };
}

async function getClip(group) {
  const span = clipSpan(group);
  const cached = await DB.get("clips", span.id);
  if (cached && cached.blob) return cached.blob;
  if (!navigator.onLine) return null;
  const blob = await Api.clipBlob(span.filename, span.start, span.end);
  if (!blob) return null;
  await DB.put("clips", { id: span.id, blob });
  return blob;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /tmp/opencode && node getclip.test.js`
Expected: `clipTs/clipSpan/getClip OK`.

- [ ] **Step 7: Add CSS for the play button**

In `/mnt/payload/share/msi/prg/srst-harken/offline/static/app.css`, append (the existing `.fav button` rule already styles row buttons; this just adds a playing-state color):

```css
.fav .play.playing { color: #20c997; }
.fav .play:disabled { opacity: .35; cursor: default; }
```

- [ ] **Step 8: Syntax checks + cleanup**

Run: `cd /mnt/payload/share/msi/prg/srst-harken && node --check offline/static/app.js && echo ok && rm -f /tmp/opencode/getclip.test.js`
Expected: `ok`.

- [ ] **Step 9: Commit**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add offline/static/app.js offline/static/index.html offline/static/app.css
git commit -m "offline: clip span/identity + IndexedDB-backed getClip

clipTs/clipSpan compute a favorite group's ±0.5s clip span and stable id
(filename|start|end); getClip returns the cached Blob or fetches+stores it when
online (null offline+uncached). Adds a dedicated #clip-player audio element."
```

---

## Task 6: Client playback + prefetch + Play button wiring

**Files:**
- Modify: `/mnt/payload/share/msi/prg/srst-harken/offline/static/app.js` (`playClip`/`stopClip`/`prefetchClips` after `getClip`; ▶ button in `_renderFav` before `send` at line 693; `navFav` lines 61-65; `boot` lines 983-995)
- Test: `/tmp/opencode/playclip.test.js` (throwaway)

**Interfaces:**
- Consumes: `getClip`, `clipSpan`, `groupFavorites` + `buildLineIndexResolver` (lines 577-625), `el.clipPlayer`, `DB.all`/`DB.del`.
- Produces:
  - `stopClip()` — pauses `el.clipPlayer`, clears its src (revoking the blob URL), resets the active play button to ▶, clears `playingClipId`.
  - `playClip(group, btn) -> Promise<void>` — toggle: if `playingClipId === clipSpan(group).id` and playing, `stopClip()`; else `stopClip()` any other, `getClip`; if null, briefly disable/flash the button and return; else set `el.clipPlayer.src = URL.createObjectURL(blob)` (revoke prior), `play()`, mark button ⏸/`.playing`, set `playingClipId`.
  - `prefetchClips() -> Promise<void>` — when online, enumerate current groups (same favs/resolver/grouping as `_renderFav`), `getClip` each missing; then delete any `clips` record whose `id` ∉ the current valid-id set (prune). Best-effort, never throws.
  - Module var `let playingClipId = null;`.

- [ ] **Step 1: Write the failing test**

Create `/tmp/opencode/playclip.test.js`. It provides DOM/`URL` shims, `fake-indexeddb`, real `clipSpan`/`getClip`/`groupFavorites`/`buildLineIndexResolver`, and extracts `playClip`/`stopClip`/`prefetchClips`:

```javascript
require("fake-indexeddb/auto");
const assert = require("assert");
const fs = require("fs");
const base = "/mnt/payload/share/msi/prg/srst-harken/offline/static/";
const DB = eval(fs.readFileSync(base + "db.js","utf8") + "; DB;");
const Timeline = eval(fs.readFileSync(base + "timeline.js","utf8") + "; Timeline;");
const app = fs.readFileSync(base + "app.js","utf8");
global.DB = DB; global.Timeline = Timeline;

let urlSeq = 0;
global.URL = { createObjectURL: () => "blob:" + (++urlSeq), revokeObjectURL: () => {} };
function setOnline(v){ Object.defineProperty(globalThis,"navigator",{value:{onLine:v},configurable:true}); }
global.Api = { clipBlob: async () => "BLOB", lines: async () => ({ results: [] }) };
global.episodeKeyOf = (v) => v.split("/").slice(0,3).join("/");

// clip player shim
global.el = { clipPlayer: { src:"", paused:true, _played:0,
  play(){ this._played++; this.paused=false; }, pause(){ this.paused=true; },
  addEventListener(){}, } };

function btn(){ return { textContent:"▶", disabled:false, classList:{ _s:new Set(),
  add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, contains(c){return this._s.has(c);} } }; }

function grab(re){ const m = app.match(re); if(!m) throw new Error("missing "+re); return m[0]; }
for (const name of ["clipTs","clipSpan"]) eval(grab(new RegExp("function "+name+"\\([\\s\\S]*?\\n\\}")).replace("function "+name, "global."+name+" = function"));
eval(grab(/async function getClip\([\s\S]*?\n\}/).replace("async function getClip","global.getClip = async function"));
eval(grab(/function groupFavorites\([\s\S]*?\n\}/).replace("function groupFavorites","global.groupFavorites = function"));
eval(grab(/function tsSeconds\([\s\S]*?\n\}/).replace("function tsSeconds","global.tsSeconds = function"));
eval(grab(/async function buildLineIndexResolver\([\s\S]*?\n\}/).replace("async function buildLineIndexResolver","global.buildLineIndexResolver = async function"));
eval(grab(/function stopClip\([\s\S]*?\n\}/).replace("function stopClip","global.stopClip = function"));
eval(grab(/async function playClip\([\s\S]*?\n\}/).replace("async function playClip","global.playClip = async function"));
eval(grab(/async function prefetchClips\([\s\S]*?\n\}/).replace("async function prefetchClips","global.prefetchClips = async function"));

const file = "48k/Pod/20260628/by10m/by10m_00.vtt";
const group = [{ filename:file, start:"00:00:10.000", end:"00:00:12.000", text:"a" }];

(async () => {
  await DB.open();
  setOnline(true);

  // play -> loads + plays + button shows playing
  const b = btn();
  await playClip(group, b);
  assert.strictEqual(el.clipPlayer._played, 1, "played once");
  assert.ok(el.clipPlayer.src.startsWith("blob:"), "src set to blob url");
  assert.ok(b.classList.contains("playing"), "button marked playing");

  // toggle same -> stops
  await playClip(group, b);
  assert.ok(el.clipPlayer.paused, "second click stops");
  assert.ok(!b.classList.contains("playing"), "button reset");

  // offline + uncached -> no play, returns gracefully
  await DB.del("clips", clipSpan(group).id);
  setOnline(false);
  const b2 = btn(); const before = el.clipPlayer._played;
  await playClip(group, b2);
  assert.strictEqual(el.clipPlayer._played, before, "offline uncached does not play");

  // prefetch: caches missing, prunes orphan
  setOnline(true);
  await DB.put("clips", { id: "orphan|x|y", blob: "OLD" });
  await DB.put("favorites", { id: file + "|00:00:10.000", filename:file, start:"00:00:10.000", end:"00:00:12.000", text:"a", status:"synced", updatedAt:"t" });
  await prefetchClips();
  assert.strictEqual(await DB.get("clips", "orphan|x|y"), undefined, "orphan pruned");
  assert.ok(await DB.get("clips", clipSpan(group).id), "current clip prefetched");

  console.log("playClip/stopClip/prefetchClips OK");
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /tmp/opencode && node playclip.test.js`
Expected: FAIL — `missing /function stopClip.../`.

- [ ] **Step 3: Add `playingClipId` module var**

In `app.js`, add after line 39 (`let topicsOpen = ...;`), grouped with the other player-state `let`s:

```javascript
let playingClipId = null; // id of the favorite clip currently playing (dedicated clip player)
```

- [ ] **Step 4: Implement `stopClip`, `playClip`, `prefetchClips`**

In `app.js`, add immediately after `getClip` (the function added in Task 5, after its closing `}`):

```javascript
function stopClip() {
  el.clipPlayer.pause();
  const prev = el.clipPlayer.src;
  el.clipPlayer.removeAttribute("src");
  if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
  if (playingClipId) {
    const b = el.viewFav.querySelector(`.play[data-clip="${playingClipId}"]`);
    if (b) { b.textContent = "▶"; b.classList.remove("playing"); }
  }
  playingClipId = null;
}

async function playClip(group, btn) {
  const id = clipSpan(group).id;
  if (playingClipId === id && !el.clipPlayer.paused) { stopClip(); return; }
  stopClip();
  btn.disabled = true;
  const blob = await getClip(group);
  btn.disabled = false;
  if (!blob) {
    const prev = btn.textContent;
    btn.textContent = "∅";
    setTimeout(() => { btn.textContent = prev; }, 1000);
    return;
  }
  el.clipPlayer.src = URL.createObjectURL(blob);
  el.clipPlayer.play();
  btn.textContent = "⏸";
  btn.classList.add("playing");
  playingClipId = id;
}

// Fetch+cache every current group's clip (when online) so favorites are playable
// offline; then drop clips whose groups no longer exist.
async function prefetchClips() {
  let favs;
  try { favs = (await DB.all("favorites")).filter((f) => f.status !== "deleted"); }
  catch (e) { return; }
  if (!favs.length) {
    const all = await DB.all("clips");
    for (const c of all) await DB.del("clips", c.id);
    return;
  }
  const files = [...new Set(favs.map((f) => f.filename))];
  const indexOf = await buildLineIndexResolver(files);
  const groups = groupFavorites(favs, indexOf);
  const valid = new Set();
  for (const g of groups) {
    const id = clipSpan(g).id;
    valid.add(id);
    if (navigator.onLine) {
      try { await getClip(g); } catch (e) { /* best-effort */ }
    }
  }
  for (const c of await DB.all("clips")) {
    if (!valid.has(c.id)) await DB.del("clips", c.id);
  }
}
```

- [ ] **Step 5: Add the ▶ button to `_renderFav`**

In `app.js`, inside the per-group loop in `_renderFav`, insert BEFORE the `send` button creation (before line 693 `const send = document.createElement("button");`):

```javascript
    const play = document.createElement("button");
    play.className = "play";
    play.dataset.clip = clipSpan(group).id;
    play.textContent = (playingClipId === clipSpan(group).id && !el.clipPlayer.paused) ? "⏸" : "▶";
    if (playingClipId === clipSpan(group).id && !el.clipPlayer.paused) play.classList.add("playing");
    play.title = "Play this clip";
    play.onclick = () => playClip(group, play);
```

and append it into the row before `send` — change the append block (lines 708-711) from:

```javascript
    row.appendChild(ts);
    row.appendChild(body);
    row.appendChild(send);
    row.appendChild(del);
```

to:

```javascript
    row.appendChild(ts);
    row.appendChild(body);
    row.appendChild(play);
    row.appendChild(send);
    row.appendChild(del);
```

- [ ] **Step 6: Wire `el.clipPlayer` 'ended' → reset, and prefetch into navFav + boot**

In `app.js`, register an `ended` handler near the other player wiring. Add right after the `el` object (or near other `el.player` listeners) — place it after line 65's `navFav` handler for proximity:

```javascript
el.clipPlayer.addEventListener("ended", stopClip);
```

Change `navFav` (lines 61-65) from:

```javascript
el.navFav.onclick = () => {
  showView("fav");
  renderFav();
  if (navigator.onLine) syncFavorites().then(renderFav);
};
```

to:

```javascript
el.navFav.onclick = () => {
  showView("fav");
  renderFav();
  if (navigator.onLine) syncFavorites().then(() => { renderFav(); prefetchClips(); });
  else prefetchClips();
};
```

Change `boot` (lines 987-992) — add `prefetchClips()` after favorites sync. From:

```javascript
  if (navigator.onLine) {
    await syncFavorites();
    await updateStatus();
    await syncListens();
    await updateRecentCount();
  }
```

to:

```javascript
  if (navigator.onLine) {
    await syncFavorites();
    await updateStatus();
    await syncListens();
    await updateRecentCount();
  }
  prefetchClips();
```

(`prefetchClips` is best-effort and self-guards online-vs-offline; calling it unconditionally after boot is fine — offline it only prunes against current favorites without fetching.)

- [ ] **Step 7: Run test to verify it passes**

Run: `cd /tmp/opencode && node playclip.test.js`
Expected: `playClip/stopClip/prefetchClips OK`.

- [ ] **Step 8: Re-run earlier harnesses for regressions + syntax check**

Run: `cd /mnt/payload/share/msi/prg/srst-harken && node --check offline/static/app.js && echo ok`
Expected: `ok`.

- [ ] **Step 9: Cleanup + commit**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
rm -f /tmp/opencode/playclip.test.js
git add offline/static/app.js
git commit -m "offline: play favorite clips + prefetch on boot/fav-open

Per-group play/stop button uses a dedicated #clip-player (transcript player
untouched); only one clip plays at a time. prefetchClips fetches+caches every
group's clip when online (boot + Favorites tab) and prunes orphaned clips."
```

---

## Task 7: Live end-to-end smoke (proxy + cache headers)

**Files:** none (verification only). Uses throwaway servers under `/tmp/opencode`.

**Interfaces:** Consumes the running offline proxy (`/api/clip`) → throwaway uttale (`/uttale/Audio`).

- [ ] **Step 1: Build a temp root with a real `.ogg` and start throwaway servers**

```bash
set -e
W=/tmp/opencode/clip-smoke
rm -rf "$W"; mkdir -p "$W"
EP="$W/root/48k/SmokePod/20260628/by10m"
mkdir -p "$EP"
printf "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nhei\n" > "$EP/by10m_00.vtt"
ffmpeg -f lavfi -i anullsrc=r=48000:cl=mono -t 5 -c:a libopus "$EP/by10m_00.ogg" -y >/dev/null 2>&1
cd /home/bz/share/btsync/prg/srst-uttale
/tmp/opencode/uttale-test/bin/python -m uttale.backend.server \
  --root "$W/root" --iface 127.0.0.1:7011 \
  --db "$W/lines.db" --favorites-db "$W/fav.db" --listens-db "$W/listens.db" \
  > "$W/uttale.log" 2>&1 &
echo $! > /tmp/opencode/utt.pid
cd /mnt/payload/share/msi/prg/srst-harken
/tmp/opencode/uttale-test/bin/python offline/offline.py \
  --uttale http://127.0.0.1:7011 --host 127.0.0.1 --port 7023 \
  > "$W/offline.log" 2>&1 &
echo $! > /tmp/opencode/off.pid
for i in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:7023/api/scopes?q=" && break || sleep 0.25
done
echo "up"
```

Expected: `up`.

- [ ] **Step 2: Fetch a clip through the proxy and assert audio + cache headers**

```bash
F='48k/SmokePod/20260628/by10m/by10m_00.vtt'
curl -s -D - -o /tmp/opencode/clip.ogg \
  "http://127.0.0.1:7023/api/clip?filename=${F}&start=00:00:01.000&end=00:00:03.000" \
  | rg -i "HTTP/|Content-Type|ETag|Cache-Control"
echo "bytes: $(wc -c < /tmp/opencode/clip.ogg)"
```

Expected: `HTTP/1.0 200`, `Content-Type: audio/ogg`, an `ETag: "<hex>"`, `Cache-Control: public, max-age=31536000, immutable`, and a non-trivial byte count (> 1000).

- [ ] **Step 3: Confirm the clip is valid ogg (decodes)**

```bash
ffprobe -hide_banner /tmp/opencode/clip.ogg 2>&1 | rg -i "Audio:|Duration"
```

Expected: shows an Opus/Vorbis audio stream with a ~2s duration.

- [ ] **Step 4: Tear down throwaway servers + cleanup; confirm :7010 untouched**

```bash
for f in off utt; do
  P=$(cat /tmp/opencode/$f.pid 2>/dev/null)
  [ -n "$P" ] && kill -0 "$P" 2>/dev/null && kill "$P" && echo "killed $f $P"
done
sleep 0.5
curl -sk -o /dev/null -w 'real :7010 -> %{http_code}\n' "https://localhost:7010/uttale/Scopes?q=&limit=1"
rm -rf /tmp/opencode/clip-smoke /tmp/opencode/clip.ogg
```

Expected: both killed; `real :7010 -> 200` (the real instance never touched).

- [ ] **Step 5: No commit (verification only).** If any assertion failed, fix the responsible task's code before proceeding.

---

## Task 8: Final integration verification + manual checklist update

**Files:**
- Modify (optional): `/mnt/payload/share/msi/prg/srst-harken/SESSION.md` — append a manual browser checklist for the feature.

- [ ] **Step 1: Full uttale suite once more**

Run: `cd /home/bz/share/btsync/prg/srst-uttale && /tmp/opencode/uttale-test/bin/python -m unittest uttale.backend.test_server 2>&1 | tail -3`
Expected: `OK` (65 tests).

- [ ] **Step 2: All offline syntax checks**

Run: `cd /mnt/payload/share/msi/prg/srst-harken && for f in db api app timeline; do node --check offline/static/$f.js || exit 1; done && /tmp/opencode/uttale-test/bin/python -m py_compile offline/offline.py && echo "ALL OK"`
Expected: `ALL OK`.

- [ ] **Step 3: Append the manual checklist to SESSION.md**

Append this section to `/mnt/payload/share/msi/prg/srst-harken/SESSION.md` (under a "Manual checks" area; create the heading if absent):

```markdown
## Favorite clips — manual browser checks (Tailscale .ts.net host, not raw IP)
- Open Favorites while online: each group shows a ▶ button.
- Tap ▶: clip plays from the dedicated player; button shows ⏸; transcript player/scrubber/clock unaffected.
- Tap ⏸ (same row): stops. Tap another row's ▶: first stops, second plays (only one at a time).
- Reload, go offline (DevTools), open Favorites: previously-prefetched clips still play (served from IndexedDB).
- Offline + a clip that was never prefetched: ▶ briefly shows ∅ and does nothing (no crash).
- DevTools → Application → IndexedDB → srst-offline → clips: rows keyed filename|start|end; deleting a favorite then reopening Favorites (online) prunes its orphaned clip.
- Network tab: clip requests carry Cache-Control: immutable + ETag; repeat plays of an already-cached clip make NO /api/clip request (served from IndexedDB).
```

- [ ] **Step 4: Commit the checklist (if changed)**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add SESSION.md
git commit -m "docs: manual browser checklist for favorite-clip playback"
```

- [ ] **Step 5: Review the full set of commits**

Run: `cd /mnt/payload/share/msi/prg/srst-harken && git log --oneline -6 && cd /home/bz/share/btsync/prg/srst-uttale && git log --oneline -2`
Expected: the offline commits (db/api/app/proxy/checklist) and the uttale ETag commit are all present.
