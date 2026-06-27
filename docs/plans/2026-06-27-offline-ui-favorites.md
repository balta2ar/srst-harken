# srst-offline UI/playback + Favorites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make srst-offline's Listen view usable while a podcast plays elsewhere (always-reachable transport, auto-advancing active line, episode-absolute timestamps, a custom episode scrubber), add a compact icon top bar, a Favorites view with server-side Telegram export, prefilled search chips, date-DESC search ordering, and a non-blocking cross-network origin banner.

**Architecture:** Client JS is split into focused modules: `db.js` (storage, unchanged), `api.js` (fetch wrappers for `/api/*`), `timeline.js` (pure episode-timeline math, DOM-free), and `app.js` (all UI/views). The server (`offline.py`) gains one online-only `POST /api/export` that reuses harken's telegram-send path. The episode timeline (segment durations + episode-absolute line times) is derived from VTT line end-times (approach A), and a `timeupdate` listener drives active-line highlight/scroll/clock/scrubber.

**Tech Stack:** Python 3.12 stdlib (`http.server`, `urllib`, `subprocess`, `tempfile`, `ssl`); vanilla JS (IndexedDB, `<audio>`, inline SVG); no new runtime dependencies.

**Spec:** `docs/specs/2026-06-27-offline-ui-favorites-design.md`

---

## Testing approach (read first)

No automated suite (AGENTS.md). Verification per task:
- Python → `py_compile` + `curl -k` smoke against live uttale (`https://localhost:7010`, already running — do not start/stop it).
- Pure JS (`timeline.js`) → a node harness exercising the math (deterministic, no browser).
- DOM/UI JS → `node --check` for syntax + served-200 check; behavior (playback, scroll, scrubber, banner, tabs) is a **manual browser checklist** recorded in SESSION.md (no headless browser here).

**Environment facts (verified live, use verbatim):**
- harken venv python: `/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python`.
- `node` is available (v25); `fake-indexeddb` installable under `/tmp/opencode` if needed.
- Real 2-segment episode: `MarianneMoterMennesker/20210316` → `48k/MarianneMoterMennesker/20210316/by10m/by10m_00.vtt` and `…by10m_01.vtt`.
- There are **6** real user favorites; any smoke writing a favorite/export MUST clean up so the count returns to 6.
- Telegram channel is **real** ("Norsk audioclips"); export smoke sends a real message — use an obviously-labeled test clip; the user may delete it. `TELEGRAM_SEND_VOICE = /home/bz/rc.arch/bz/bin/telegram-send-voice`.
- Spare smoke port: **7021-7029**; kill smoke server by saved PID (never bare `pkill`); temp files in `/tmp/opencode`; clean up harnesses.

**Commit discipline:** stage only files each task names; never `git add -A` (the repo has pre-existing untracked files: `.ctags`, `*.egg-info/`, `hello.py`, `openapi.json`, `response.json`).

---

## File Structure

| File | Change |
|---|---|
| `offline/static/timeline.js` | **new** — pure timeline model + `fmt`/`tsToSeconds`/`lineAtEpTime`/`segAtEpTime`/`buildTimeline` |
| `offline/static/api.js` | **new** — `Api` object: `scopes`, `lines`, `audioBlob`, `favAdd`, `favDel`, `export` |
| `offline/offline.py` | **modify** — add `POST /api/export` + ported ts helpers |
| `offline/static/index.html` | **modify** — icon top bar, transport sub-row, 3 view sections, bottom panel, banner host, script tags |
| `offline/static/app.css` | **modify** — compact bar, transport, scrubber, line subscript, favorites rows, banner |
| `offline/static/app.js` | **modify** — use timeline/api; top bar+tabs; listen mechanics; find chips+sort; favorites view; banner; boot |
| `offline/static/sw.js` | **modify** — add `/api.js`,`/timeline.js` to SHELL |
| `SESSION.md` | **modify** — manual checklist + single-origin note |

---

## Task 1: `timeline.js` — pure episode-timeline model

**Files:**
- Create: `offline/static/timeline.js`
- Test: node harness at `/tmp/opencode/test_timeline.js`

- [ ] **Step 1: Write the module**

Create `offline/static/timeline.js`:

```javascript
const Timeline = (() => {
  function tsToSeconds(s) {
    const [h, m, rest] = s.split(":");
    const [sec, ms] = rest.replace(",", ".").split(".");
    return (+h) * 3600 + (+m) * 60 + (+sec) + (ms ? +ms / 1000 : 0);
  }

  function fmt(secs) {
    secs = Math.max(0, Math.floor(secs || 0));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  // segments: [{vtt, lines:[{start,end,text}]}] where start/end are VTT strings.
  function build(segments) {
    const segs = [];
    const lines = [];
    let offset = 0;
    let idx = 0;
    for (let si = 0; si < segments.length; si++) {
      const segLines = segments[si].lines.map((ln) => ({
        start: tsToSeconds(ln.start), end: tsToSeconds(ln.end), text: ln.text,
      }));
      const duration = segLines.length ? segLines[segLines.length - 1].end : 0;
      for (const ln of segLines) {
        lines.push({
          vtt: segments[si].vtt, segIndex: si,
          start: ln.start, end: ln.end,
          epStart: offset + ln.start, epEnd: offset + ln.end,
          text: ln.text, idx: idx++,
        });
      }
      segs.push({ vtt: segments[si].vtt, offset, duration, lines: segLines });
      offset += duration;
    }
    return { segments: segs, total: offset, lines };
  }

  function lineAtEpTime(tl, t) {
    const L = tl.lines;
    if (!L.length) return -1;
    let lo = 0, hi = L.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (L[mid].epStart <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function segAtEpTime(tl, t) {
    const S = tl.segments;
    let segIndex = 0;
    for (let i = 0; i < S.length; i++) {
      if (t >= S[i].offset) segIndex = i; else break;
    }
    return { segIndex, segLocalTime: t - (S[segIndex] ? S[segIndex].offset : 0) };
  }

  return { tsToSeconds, fmt, build, lineAtEpTime, segAtEpTime };
})();

if (typeof module !== "undefined") module.exports = Timeline;
```

- [ ] **Step 2: Write the node test harness**

Create `/tmp/opencode/test_timeline.js`:

```javascript
const assert = require("assert");
const Timeline = require("/mnt/payload/share/msi/prg/srst-harken/offline/static/timeline.js");

// fmt
assert.strictEqual(Timeline.fmt(0), "0:00:00");
assert.strictEqual(Timeline.fmt(767), "0:12:47");
assert.strictEqual(Timeline.fmt(3789), "1:03:09");

// tsToSeconds
assert.strictEqual(Timeline.tsToSeconds("00:00:02.539"), 2.539);
assert.strictEqual(Timeline.tsToSeconds("00:01:00.000"), 60);

// build: seg0 last end=10, seg1 last end=20 -> total 30; seg1 offset=10
const segs = [
  { vtt: "a/0.vtt", lines: [
    { start: "00:00:01.000", end: "00:00:05.000", text: "x" },
    { start: "00:00:06.000", end: "00:00:10.000", text: "y" } ] },
  { vtt: "a/1.vtt", lines: [
    { start: "00:00:02.000", end: "00:00:08.000", text: "z" },
    { start: "00:00:09.000", end: "00:00:20.000", text: "w" } ] },
];
const tl = Timeline.build(segs);
assert.strictEqual(tl.total, 30);
assert.strictEqual(tl.segments[1].offset, 10);
assert.strictEqual(tl.lines.length, 4);
assert.strictEqual(tl.lines[2].epStart, 12);   // 10 + 2
assert.strictEqual(tl.lines[3].epEnd, 30);     // 10 + 20

// lineAtEpTime: t=12.5 -> line idx 2 (epStart 12); t=0.5 -> idx 0
assert.strictEqual(Timeline.lineAtEpTime(tl, 12.5), 2);
assert.strictEqual(Timeline.lineAtEpTime(tl, 0.5), 0);
assert.strictEqual(Timeline.lineAtEpTime(tl, 29), 3);

// segAtEpTime: t=12 -> seg 1, local 2
const sa = Timeline.segAtEpTime(tl, 12);
assert.strictEqual(sa.segIndex, 1);
assert.strictEqual(sa.segLocalTime, 2);

console.log("timeline OK");
```

- [ ] **Step 3: Run the harness**

Run: `node /tmp/opencode/test_timeline.js`
Expected: `timeline OK` (no assertion errors).

- [ ] **Step 4: Syntax check the module standalone**

Run: `node --check offline/static/timeline.js`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add offline/static/timeline.js
git commit -m "srst-offline: timeline.js (pure episode-timeline model)"
```

---

## Task 2: `api.js` — fetch wrappers for `/api/*`

**Files:**
- Create: `offline/static/api.js`

- [ ] **Step 1: Write the module**

Create `offline/static/api.js`:

```javascript
const Api = (() => {
  async function scopes(q) {
    const r = await fetch("/api/scopes?q=" + encodeURIComponent(q));
    return r.json();
  }
  async function lines(vtt) {
    const r = await fetch("/api/lines?scope=" + encodeURIComponent(vtt));
    return r.json();
  }
  async function audioBlob(vtt) {
    const r = await fetch("/api/audio?filename=" + encodeURIComponent(vtt));
    return r.blob();
  }
  async function favAdd(fav) {
    return fetch("/api/favorite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: fav.filename, start: fav.start, end: fav.end, text: fav.text,
      }),
    });
  }
  async function favDel(filename, start) {
    return fetch("/api/favorite?filename=" + encodeURIComponent(filename) +
      "&start=" + encodeURIComponent(start), { method: "DELETE" });
  }
  async function exportFav(fav) {
    return fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: fav.filename, start: fav.start, end: fav.end, text: fav.text,
      }),
    });
  }
  return { scopes, lines, audioBlob, favAdd, favDel, exportFav };
})();
```

- [ ] **Step 2: Syntax check**

Run: `node --check offline/static/api.js`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add offline/static/api.js
git commit -m "srst-offline: api.js (/api fetch wrappers)"
```

---

## Task 3: Server `POST /api/export` (telegram send, online-only)

**Files:**
- Modify: `offline/offline.py`

- [ ] **Step 1: Add ported timestamp helpers + constants**

In `offline/offline.py`, add `import tempfile` to the imports block (after `import subprocess`), and add these module-level constants/helpers after the existing `UTTALE = "https://localhost:7010"` line:

```python
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
```

- [ ] **Step 2: Add the `/api/export` route to `do_POST`**

In `do_POST`, the method currently begins by checking `if parsed.path != "/api/favorite"`. Replace that early-return guard so `/api/export` is also accepted, and branch. Change the start of `do_POST` from:

```python
    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/favorite":
            self._send(404, b"not found")
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
```

to:

```python
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
```

(The rest of `do_POST` — the favorite POST forwarding — stays unchanged below this.)

- [ ] **Step 3: Add the `_export` handler method**

Add this method to the `Handler` class (e.g. right after `do_POST`):

```python
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
```

Note: this uses `os` and `quote`. Add `import os` to the imports block if not present, and `from urllib.parse import quote` (extend the existing `from urllib.parse import urlencode, urlparse, parse_qs` line to include `quote`).

- [ ] **Step 4: Verify it compiles**

Run: `/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m py_compile offline/offline.py`
Expected: no output, exit 0.

- [ ] **Step 5: Smoke — export a throwaway favorite (sends a REAL telegram msg), then clean up**

This sends one real voice message labeled as a test (user may delete it) and stamps a throwaway favorite, which is then deleted so the live count returns to 6. Run from repo root with `--ssl`:

```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 --ssl &
echo $! > /tmp/opencode/offline.pid
sleep 1.5
echo "export:"; curl -sk -X POST "https://localhost:7021/api/export" -H "Content-Type: application/json" \
  -d '{"filename":"48k/MarianneMoterMennesker/20210316/by10m/by10m_00.vtt","start":"00:00:02.539","end":"00:00:05.580","text":"OFFLINE EXPORT SMOKE (ignore)"}' \
  -w "\nhttp=%{http_code}\n"
echo "favorites after export (expect 7, the throwaway got upserted by set_exported):"
curl -sk "https://localhost:7010/uttale/Favorites" | python3 -c "import sys,json;print(json.load(sys.stdin)['results_count'])"
echo "cleanup throwaway:"; curl -sk -X DELETE "https://localhost:7021/api/favorite?filename=48k/MarianneMoterMennesker/20210316/by10m/by10m_00.vtt&start=00:00:02.539" -o /dev/null -w "del=%{http_code}\n"
echo "favorites after cleanup (expect 6):"
curl -sk "https://localhost:7010/uttale/Favorites" | python3 -c "import sys,json;print(json.load(sys.stdin)['results_count'])"
kill "$(cat /tmp/opencode/offline.pid)"
```

Expected: `export:` body `{"status":"sent"}` with `http=200`; favorites `7` then `6` after cleanup. A real voice message titled with the "(ignore)" text appears in the channel. If the count is not 6 at the end, manually `DELETE` that throwaway until it is.

NOTE on `set_exported`: uttale's `Favorites/Update` returns 404 if the favorite doesn't already exist; in that case `exported_at` won't stamp but the telegram send still succeeded and the endpoint still returns `{"status":"sent"}`. The throwaway favorite is created by harken-style usage in real life; for this smoke the Update may 404 harmlessly (logged), and the count behavior above assumes the row may or may not be created — verify the FINAL count returns to 6 regardless, deleting any `by10m_00.vtt @ 00:00:02.539` residue.

- [ ] **Step 6: Commit**

```bash
git add offline/offline.py
git commit -m "srst-offline: POST /api/export (server-side telegram send)"
```

---

## Task 4: HTML shell + CSS — icon bar, 3 views, transport, scrubber, banner

**Files:**
- Modify: `offline/static/index.html`
- Modify: `offline/static/app.css`

- [ ] **Step 1: Rewrite `index.html`**

Replace the entire contents of `offline/static/index.html` with:

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
  <div id="banner" hidden></div>
  <header id="bar">
    <nav id="tabs">
      <button id="nav-find" class="tab" aria-label="Find" title="Find">
        <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
      </button>
      <button id="nav-listen" class="tab" aria-label="Listen" title="Listen">
        <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>
      </button>
      <button id="nav-fav" class="tab" aria-label="Favorites" title="Favorites">
        <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
      </button>
    </nav>
    <span id="status" title=""></span>
  </header>
  <div id="transport-top" hidden>
    <button id="t-prev" aria-label="Previous line" title="Previous line">⏮</button>
    <button id="t-play" aria-label="Play/pause" title="Play/pause">▶</button>
    <button id="t-next" aria-label="Next line" title="Next line">⏭</button>
    <span id="clock">0:00:00 / 0:00:00</span>
  </div>
  <main>
    <section id="view-find"></section>
    <section id="view-listen" hidden>
      <ol id="lines"></ol>
    </section>
    <section id="view-fav" hidden></section>
  </main>
  <div id="transport" hidden>
    <div id="scrubber"><div id="scrub-fill"></div><div id="scrub-handle"></div><div id="scrub-marks"></div></div>
  </div>
  <audio id="player"></audio>
  <script src="/db.js"></script>
  <script src="/api.js"></script>
  <script src="/timeline.js"></script>
  <script src="/app.js"></script>
  <script>
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((e) => console.error("SW", e));
    }
  </script>
</body>
</html>
```

- [ ] **Step 2: Rewrite `app.css`**

Replace the entire contents of `offline/static/app.css` with:

```css
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; margin: 0; padding-bottom: 5rem; }

#banner { background: #fff3cd; color: #664d03; font-size: .8rem;
  padding: .35rem .5rem; display: flex; align-items: center; gap: .5rem;
  border-bottom: 1px solid #ffe69c; }
#banner button { margin-left: auto; background: none; border: none; cursor: pointer; font-size: 1rem; }

#bar { position: sticky; top: 0; z-index: 10; display: flex; gap: .25rem;
  align-items: center; background: #fff; border-bottom: 1px solid #ddd; padding: .25rem .5rem; }
#tabs { display: flex; gap: .25rem; }
.tab { background: none; border: none; cursor: pointer; color: #555; padding: .25rem .4rem;
  border-radius: .4rem; display: inline-flex; align-items: center; }
.tab.active { color: #0d6efd; background: #e7f1ff; }
#status { margin-left: auto; font-size: .8rem; color: #666; white-space: nowrap; }

#transport-top { position: sticky; top: 2.5rem; z-index: 9; display: flex; gap: .25rem;
  align-items: center; background: #fafafa; border-bottom: 1px solid #eee; padding: .2rem .5rem; }
#transport-top button { background: none; border: none; font-size: 1.1rem; cursor: pointer; }
#clock { margin-left: auto; font-size: .8rem; color: #444; font-variant-numeric: tabular-nums; }

main { padding: .5rem; }
#search { width: 100%; padding: .5rem; font-size: 1rem; }
#chips { display: flex; flex-wrap: wrap; gap: .3rem; margin-bottom: .4rem; }
.chip { background: #eee; color: #333; border: none; border-radius: 1rem;
  padding: .2rem .6rem; font-size: .8rem; cursor: pointer; }

.episode { padding: .5rem; border-bottom: 1px solid #eee; cursor: pointer;
  display: flex; align-items: center; }
.episode small { color: #666; }
.episode > span:first-child { flex: 1; }
.row-actions { display: flex; gap: .5rem; }

ol#lines { list-style: none; margin: 0; padding: 0; }
.line { padding: .4rem .5rem; border-bottom: 1px solid #eee; display: flex;
  gap: .5rem; align-items: baseline; cursor: pointer; }
.line .text { flex: 1; }
.line .ts { font-size: .7rem; color: #999; font-variant-numeric: tabular-nums; white-space: nowrap; }
.line.active { background: #dfffd6; }
.star { background: none; border: none; font-size: 1.2rem; cursor: pointer; color: #f5b301; align-self: center; }

.fav { padding: .5rem; border-bottom: 1px solid #eee; display: flex; gap: .5rem; align-items: baseline; }
.fav .text { flex: 1; }
.fav .ts { font-size: .7rem; color: #999; white-space: nowrap; }
.fav .meta { font-size: .7rem; color: #999; }
.fav .exported { color: #28a745; }
.fav button { background: none; border: none; cursor: pointer; font-size: 1.1rem; align-self: center; }

#transport { position: fixed; bottom: 0; left: 0; right: 0; background: #fff;
  border-top: 1px solid #ddd; padding: .6rem .5rem; z-index: 10; }
#scrubber { position: relative; height: 1.4rem; background: #eee; border-radius: .7rem; cursor: pointer; }
#scrub-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0;
  background: #cfe2ff; border-radius: .7rem; }
#scrub-handle { position: absolute; top: 50%; width: .9rem; height: .9rem; margin-left: -.45rem;
  transform: translateY(-50%); background: #0d6efd; border-radius: 50%; left: 0; }
#scrub-marks .mark { position: absolute; top: 0; bottom: 0; width: 2px; background: #f5b301; }

button { cursor: pointer; }
```

- [ ] **Step 3: Verify served + valid markup**

Run from repo root:

```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 &
echo $! > /tmp/opencode/offline.pid
sleep 1
curl -s -o /dev/null -w "index -> %{http_code} %{content_type}\n" "http://localhost:7021/"
curl -s -o /dev/null -w "css   -> %{http_code} %{content_type}\n" "http://localhost:7021/app.css"
kill "$(cat /tmp/opencode/offline.pid)"
```

Expected: `index -> 200 text/html; charset=utf-8`; `css -> 200 text/css; charset=utf-8`.
(Note: `app.js` will not yet reference the new elements — that is Task 5. The page will be partly non-functional between this task and Task 5; that is expected per per-task commits.)

- [ ] **Step 4: Commit**

```bash
git add offline/static/index.html offline/static/app.css
git commit -m "srst-offline: icon top bar, 3 views, transport + scrubber, banner (markup/CSS)"
```

---

## Task 5: `app.js` — rewrite for new top bar, listen mechanics, find, favorites, banner

This task rewrites `app.js` to match the new HTML and wire in `Timeline`/`Api`. It is large but self-contained; the full new file is given. **Replace the entire contents of `offline/static/app.js`** with the file in Step 1.

**Files:**
- Modify: `offline/static/app.js`

- [ ] **Step 1: Replace `offline/static/app.js` entirely with:**

```javascript
const el = {
  banner: document.getElementById("banner"),
  viewFind: document.getElementById("view-find"),
  viewListen: document.getElementById("view-listen"),
  viewFav: document.getElementById("view-fav"),
  lines: document.getElementById("lines"),
  player: document.getElementById("player"),
  status: document.getElementById("status"),
  navFind: document.getElementById("nav-find"),
  navListen: document.getElementById("nav-listen"),
  navFav: document.getElementById("nav-fav"),
  transportTop: document.getElementById("transport-top"),
  transport: document.getElementById("transport"),
  tPrev: document.getElementById("t-prev"),
  tPlay: document.getElementById("t-play"),
  tNext: document.getElementById("t-next"),
  clock: document.getElementById("clock"),
  scrubber: document.getElementById("scrubber"),
  scrubFill: document.getElementById("scrub-fill"),
  scrubHandle: document.getElementById("scrub-handle"),
  scrubMarks: document.getElementById("scrub-marks"),
};

const SEARCH_CHIPS = ["idioti 2026", "kontakt 2026", "saltIAran 2026", "VernaBedrift 2026", "heimelaga 2026"];

let tl = null;            // current Timeline model
let audioVtt = null;     // which segment blob is loaded
let currentSeg = 0;      // active segment index
let currentLine = -1;    // active line idx

function episodeKeyOf(vtt) { return vtt.split("/").slice(0, 3).join("/"); }
function podcastOf(vtt) { return vtt.split("/")[1] || vtt; }
function dateOf(vtt) { return vtt.split("/")[2] || ""; }

function showView(which) {
  el.viewFind.hidden = which !== "find";
  el.viewListen.hidden = which !== "listen";
  el.viewFav.hidden = which !== "fav";
  const listening = which === "listen";
  el.transportTop.hidden = !listening;
  el.transport.hidden = !listening;
  el.navFind.classList.toggle("active", which === "find");
  el.navListen.classList.toggle("active", which === "listen");
  el.navFav.classList.toggle("active", which === "fav");
}
el.navFind.onclick = () => { renderFind(); showView("find"); };
el.navListen.onclick = () => showView("listen");
el.navFav.onclick = () => { renderFav(); showView("fav"); };

async function updateStatus() {
  const favs = await DB.all("favorites");
  const pending = favs.filter((f) => f.status !== "synced").length;
  el.status.textContent = (navigator.onLine ? "⛅" : "⚡") + pending;
  el.status.title = (navigator.onLine ? "online" : "offline") + ` · ${pending} pending`;
}
window.addEventListener("online", () => { syncFavorites().then(updateStatus); });
window.addEventListener("offline", updateStatus);

// ---------- Find ----------
async function renderFind() {
  el.viewFind.innerHTML = "";
  const chips = document.createElement("div");
  chips.id = "chips";
  el.viewFind.appendChild(chips);
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
  for (const c of SEARCH_CHIPS) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = c;
    b.onclick = () => { input.value = c; search(c, resultsBox); };
    chips.appendChild(b);
  }
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
  try { data = await Api.scopes(query); }
  catch (e) { box.innerHTML = "<p><small>Offline — can't search.</small></p>"; return; }
  const groups = {};
  for (const vtt of data.results || []) {
    const k = episodeKeyOf(vtt);
    (groups[k] = groups[k] || []).push(vtt);
  }
  box.innerHTML = "";
  const keys = Object.keys(groups);
  if (!keys.length) { box.innerHTML = "<p><small>No matches.</small></p>"; return; }
  // newest episode first: by date (YYYYMMDD) desc, ties by podcast name
  keys.sort((a, b) => {
    const da = a.split("/")[2] || "", db = b.split("/")[2] || "";
    if (da !== db) return db < da ? -1 : 1;
    return a < b ? -1 : 1;
  });
  for (const k of keys) {
    const segs = groups[k].sort();
    const row = document.createElement("div");
    row.className = "episode";
    const label = document.createElement("span");
    label.innerHTML = `${podcastOf(segs[0])} <small>${dateOf(segs[0])} · ${segs.length} seg</small>`;
    row.appendChild(label);
    row.onclick = () => downloadEpisode(k, segs, label);
    box.appendChild(row);
  }
}

async function downloadEpisode(key, segs, label) {
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (e) {}
  }
  let done = 0;
  for (const vtt of segs) {
    label.innerHTML = `${podcastOf(vtt)} <small>downloading ${done}/${segs.length}…</small>`;
    const linesData = await Api.lines(vtt);
    const lines = (linesData.results || []).map((r) => ({ start: r.start, end: r.end, text: r.text }));
    const audio = await Api.audioBlob(vtt);
    await DB.put("segments", { vtt, lines, audio });
    done += 1;
  }
  await DB.put("episodes", {
    key, podcast: podcastOf(segs[0]), date: dateOf(segs[0]),
    segments: segs, cachedAt: new Date().toISOString(),
  });
  label.innerHTML = `${podcastOf(segs[0])} <small>${dateOf(segs[0])} · cached</small>`;
  openEpisode(key);
}

async function deleteEpisode(ep) {
  for (const vtt of ep.segments) await DB.del("segments", vtt);
  await DB.del("episodes", ep.key);
}

// ---------- Listen ----------
async function openEpisode(key) {
  const ep = await DB.get("episodes", key);
  if (!ep) return;
  const segments = [];
  for (const vtt of ep.segments) {
    const seg = await DB.get("segments", vtt);
    if (seg) segments.push({ vtt, lines: seg.lines });
  }
  tl = Timeline.build(segments);
  audioVtt = null;
  currentSeg = 0;
  currentLine = -1;
  await renderLines();
  renderMarks();
  updateClock(0);
  showView("listen");
}

async function favIds() {
  const favs = await DB.all("favorites");
  const set = new Set();
  for (const f of favs) if (f.status !== "deleted") set.add(f.id);
  return set;
}

async function renderLines() {
  el.lines.innerHTML = "";
  const favSet = await favIds();
  tl.lines.forEach((ln) => {
    const id = ln.vtt + "|" + ln.start;
    const li = document.createElement("li");
    li.className = "line";
    li.dataset.index = ln.idx;
    const star = document.createElement("button");
    star.className = "star";
    star.textContent = favSet.has(id) ? "★" : "☆";
    star.onclick = (e) => { e.stopPropagation(); toggleFavorite(ln, star); };
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = ln.text;
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = Timeline.fmt(ln.epStart);
    li.appendChild(star);
    li.appendChild(text);
    li.appendChild(ts);
    li.onclick = () => playLine(ln.idx);
    el.lines.appendChild(li);
  });
}

function renderMarks() {
  el.scrubMarks.innerHTML = "";
  if (!tl || !tl.total) return;
  favIds().then((set) => {
    for (const ln of tl.lines) {
      if (set.has(ln.vtt + "|" + ln.start)) {
        const m = document.createElement("div");
        m.className = "mark";
        m.style.left = (100 * ln.epStart / tl.total) + "%";
        el.scrubMarks.appendChild(m);
      }
    }
  });
}

async function loadSegment(si) {
  const seg = tl.segments[si];
  const rec = await DB.get("segments", seg.vtt);
  if (!rec) return false;
  el.player.src = URL.createObjectURL(rec.audio);
  audioVtt = seg.vtt;
  currentSeg = si;
  return true;
}

async function playLine(idx) {
  const ln = tl.lines[idx];
  if (audioVtt !== ln.vtt) { if (!(await loadSegment(ln.segIndex))) return; }
  el.player.currentTime = ln.start;
  el.player.play();
  setActive(idx);
}

async function seekEp(epTarget) {
  if (!tl || !tl.total) return;
  const { segIndex, segLocalTime } = Timeline.segAtEpTime(tl, epTarget);
  if (segIndex !== currentSeg || audioVtt !== tl.segments[segIndex].vtt) {
    if (!(await loadSegment(segIndex))) return;
  }
  el.player.currentTime = Math.max(0, segLocalTime);
  el.player.play();
}

function setActive(idx) {
  if (idx === currentLine) return;
  el.lines.querySelectorAll(".line.active").forEach((n) => n.classList.remove("active"));
  const li = el.lines.querySelector(`.line[data-index="${idx}"]`);
  if (li) { li.classList.add("active"); li.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  currentLine = idx;
}

function updateClock(epNow) {
  el.clock.textContent = Timeline.fmt(epNow) + " / " + Timeline.fmt(tl ? tl.total : 0);
  if (tl && tl.total) {
    const pct = (100 * epNow / tl.total) + "%";
    el.scrubFill.style.width = pct;
    el.scrubHandle.style.left = pct;
  }
}

el.player.addEventListener("timeupdate", () => {
  if (!tl) return;
  const epNow = tl.segments[currentSeg].offset + el.player.currentTime;
  updateClock(epNow);
  const i = Timeline.lineAtEpTime(tl, epNow);
  if (i >= 0) setActive(i);
});

el.player.addEventListener("ended", () => {
  if (!tl) return;
  if (currentSeg + 1 < tl.segments.length) {
    loadSegment(currentSeg + 1).then((ok) => { if (ok) { el.player.currentTime = 0; el.player.play(); } });
  }
});

el.tPlay.onclick = () => {
  if (el.player.paused) el.player.play(); else el.player.pause();
};
el.player.addEventListener("play", () => { el.tPlay.textContent = "⏸"; });
el.player.addEventListener("pause", () => { el.tPlay.textContent = "▶"; });
el.tPrev.onclick = () => { if (currentLine > 0) playLine(currentLine - 1); };
el.tNext.onclick = () => { if (tl && currentLine + 1 < tl.lines.length) playLine(currentLine + 1); };

function scrubToEvent(ev) {
  const rect = el.scrubber.getBoundingClientRect();
  const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
  const f = Math.min(1, Math.max(0, x / rect.width));
  seekEp(f * (tl ? tl.total : 0));
}
el.scrubber.addEventListener("click", scrubToEvent);

// ---------- Favorites ----------
async function toggleFavorite(ln, star) {
  const id = ln.vtt + "|" + ln.start;
  const existing = await DB.get("favorites", id);
  if (!existing) {
    await DB.put("favorites", {
      id, filename: ln.vtt, start: ln.start, end: ln.end, text: ln.text,
      status: "pending", updatedAt: new Date().toISOString(),
    });
    if (star) star.textContent = "★";
  } else if (existing.status === "synced") {
    existing.status = "deleted";
    existing.updatedAt = new Date().toISOString();
    await DB.put("favorites", existing);
    if (star) star.textContent = "☆";
  } else {
    await DB.del("favorites", id);
    if (star) star.textContent = "☆";
  }
  updateStatus();
  renderMarks();
  if (navigator.onLine) syncFavorites().then(updateStatus);
}

async function epStartForFav(f) {
  // Episode-absolute time if the episode is cached; else segment-relative start.
  const ep = await DB.get("episodes", episodeKeyOf(f.filename));
  if (!ep) return Timeline.fmt(Timeline.tsToSeconds(f.start));
  const segments = [];
  for (const vtt of ep.segments) {
    const seg = await DB.get("segments", vtt);
    if (seg) segments.push({ vtt, lines: seg.lines });
  }
  const t = Timeline.build(segments);
  const hit = t.lines.find((l) => l.vtt === f.filename && l.start === Timeline.tsToSeconds(f.start));
  return Timeline.fmt(hit ? hit.epStart : Timeline.tsToSeconds(f.start));
}

async function renderFav() {
  el.viewFav.innerHTML = "";
  const hdr = document.createElement("div");
  hdr.className = "episode";
  const exportAll = document.createElement("button");
  exportAll.textContent = "Export all (unexported)";
  exportAll.onclick = () => exportAllUnexported(exportAll);
  hdr.appendChild(exportAll);
  el.viewFav.appendChild(hdr);

  const favs = (await DB.all("favorites")).filter((f) => f.status !== "deleted");
  favs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  if (!favs.length) { el.viewFav.insertAdjacentHTML("beforeend", "<p><small>No favorites yet.</small></p>"); return; }
  for (const f of favs) {
    const row = document.createElement("div");
    row.className = "fav";
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = await epStartForFav(f);
    const body = document.createElement("div");
    body.className = "text";
    const t = document.createElement("div");
    t.textContent = f.text;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${podcastOf(f.filename)} · ${dateOf(f.filename)}`;
    body.appendChild(t);
    body.appendChild(meta);
    const send = document.createElement("button");
    send.title = "Send to Telegram";
    send.textContent = "✈";
    if (f.exported_at) { send.classList.add("exported"); send.textContent = "✓"; }
    send.onclick = () => sendFav(f, send);
    const del = document.createElement("button");
    del.title = "Delete";
    del.textContent = "🗑";
    del.onclick = async () => { await toggleFavorite({ vtt: f.filename, start: f.start, end: f.end, text: f.text }, null); renderFav(); };
    row.appendChild(ts);
    row.appendChild(body);
    row.appendChild(send);
    row.appendChild(del);
    el.viewFav.appendChild(row);
  }
}

async function sendFav(f, btn) {
  if (!navigator.onLine) { btn.textContent = "off"; setTimeout(() => (btn.textContent = "✈"), 1000); return; }
  btn.textContent = "…";
  try {
    const r = await Api.exportFav(f);
    if (r.ok) {
      f.exported_at = new Date().toISOString();
      await DB.put("favorites", f);
      btn.textContent = "✓"; btn.classList.add("exported");
    } else {
      const d = await r.json().catch(() => ({}));
      btn.textContent = "✈"; alert("Export failed: " + (d.detail || r.status));
    }
  } catch (e) { btn.textContent = "✈"; alert("Export failed: " + e); }
}

async function exportAllUnexported(btn) {
  if (!navigator.onLine) { alert("Need a connection to export."); return; }
  const favs = (await DB.all("favorites")).filter((f) => f.status !== "deleted" && !f.exported_at);
  let sent = 0;
  for (const f of favs) {
    btn.textContent = `sending ${sent}/${favs.length}…`;
    try {
      const r = await Api.exportFav(f);
      if (r.ok) { f.exported_at = new Date().toISOString(); await DB.put("favorites", f); sent += 1; }
    } catch (e) { /* skip */ }
  }
  btn.textContent = "Export all (unexported)";
  renderFav();
}

async function syncFavorites() {
  if (!navigator.onLine) return;
  const favs = await DB.all("favorites");
  for (const f of favs) {
    try {
      if (f.status === "pending") {
        const r = await Api.favAdd(f);
        if (r.ok) { f.status = "synced"; await DB.put("favorites", f); }
      } else if (f.status === "deleted") {
        const r = await Api.favDel(f.filename, f.start);
        if (r.ok || r.status === 404) await DB.del("favorites", f.id);
      }
    } catch (e) { /* stay queued */ }
  }
}

// ---------- Banner ----------
function maybeBanner() {
  if (localStorage.getItem("origin-hint-dismissed")) return;
  const h = location.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
  if (!isIp) return;
  el.banner.hidden = false;
  el.banner.innerHTML = "<span>Tip: open via your Tailscale name so favorites travel across networks.</span>";
  const x = document.createElement("button");
  x.textContent = "✕";
  x.onclick = () => { el.banner.hidden = true; localStorage.setItem("origin-hint-dismissed", "1"); };
  el.banner.appendChild(x);
}

// ---------- Boot ----------
(async function boot() {
  maybeBanner();
  await updateStatus();
  if (navigator.onLine) { await syncFavorites(); await updateStatus(); }
  renderFind();
  showView("find");
})();
```

- [ ] **Step 2: Syntax check**

Run: `node --check offline/static/app.js`
Expected: no output, exit 0.

- [ ] **Step 3: Served check + smoke that core endpoints still feed the app**

Run from repo root:

```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 &
echo $! > /tmp/opencode/offline.pid
sleep 1
curl -s -o /dev/null -w "app.js -> %{http_code} %{content_type}\n" "http://localhost:7021/app.js"
kill "$(cat /tmp/opencode/offline.pid)"
```

Expected: `app.js -> 200 text/javascript; charset=utf-8`.

- [ ] **Step 4: Commit**

```bash
git add offline/static/app.js
git commit -m "srst-offline: app.js — top bar, listen mechanics, find chips/sort, favorites view, banner"
```

---

## Task 6: Service worker precache + final E2E smoke + docs

**Files:**
- Modify: `offline/static/sw.js`
- Modify: `SESSION.md`

- [ ] **Step 1: Add the two new modules to the SW shell precache**

In `offline/static/sw.js`, the `SHELL` array currently lists `"/app.js"` among others. Add `/api.js` and `/timeline.js`. Replace the `SHELL` array with:

```javascript
const SHELL = [
  "/",
  "/index.html",
  "/app.css",
  "/db.js",
  "/api.js",
  "/timeline.js",
  "/app.js",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];
```

Also bump the cache name to force the new shell to install: change `const CACHE = "srst-offline-v1";` to `const CACHE = "srst-offline-v2";`.

- [ ] **Step 2: Syntax check the SW**

Run: `node --check offline/static/sw.js`
Expected: no output, exit 0.

- [ ] **Step 3: Full-stack served smoke (all assets incl. new modules) over HTTPS**

Run from repo root:

```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 --ssl &
echo $! > /tmp/opencode/offline.pid
sleep 1.5
for p in / /app.css /db.js /api.js /timeline.js /app.js /sw.js /manifest.webmanifest /icon-192.png; do
  printf "%-16s " "$p"; curl -sk -o /dev/null -w "%{http_code} %{content_type}\n" "https://localhost:7021$p"
done
echo "scopes:"; curl -sk "https://localhost:7021/api/scopes?q=MarianneMoterMennesker/20210316" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['results']),'results')"
kill "$(cat /tmp/opencode/offline.pid)"
echo "favorites count (expect 6):"; curl -sk "https://localhost:7010/uttale/Favorites" | python3 -c "import sys,json;print(json.load(sys.stdin)['results_count'])"
```

Expected: all 9 assets 200 with correct MIME (`/api.js` and `/timeline.js` → `text/javascript`); `scopes 2 results`; favorites `6`.

- [ ] **Step 4: Update SESSION.md manual checklist**

In `SESSION.md`, under the existing "srst-offline — manual device verification" section, append a new subsection documenting the new UI and the single-origin requirement:

```markdown
### srst-offline v2 — UI/playback + favorites (manual device checks)

Single-origin requirement: open the app via ONE stable hostname on every network
(recommended: the Tailscale MagicDNS name, e.g. `https://<host>.<tailnet>.ts.net:7020`).
IndexedDB is per-origin, so mixing a raw LAN IP and a Tailscale IP splits your cache
and favorites/pending queue. A dismissible banner warns when opened via a raw IP.

After `srst-offline --ssl`, on the phone verify:
1. Top bar shows three icon tabs (Find/Listen/Favorites) + a ⛅/⚡ + pending chip.
2. Find: tap a prefilled chip -> search prefills + runs; results are newest-date first.
3. Open a cached episode -> Listen view: each line shows an episode-absolute
   timestamp (H:MM:SS) subscript.
4. Play: the active line advances and auto-scrolls as audio plays; at a segment end
   it auto-continues into the next segment.
5. Top transport (prev/play-pause/next + clock) stays visible when scrolled; clock
   shows current/total episode time.
6. Bottom scrubber: tap/drag seeks anywhere in the episode; favorited lines show as
   yellow ticks.
7. Favorites tab: lists your favorites; ✈ sends one to Telegram (online; server runs
   telegram-send-voice on the home PC); "Export all (unexported)" sends the rest;
   sent items show ✓.
8. Offline: marking still works; export shows it needs a connection.
```

- [ ] **Step 5: Commit**

```bash
git add offline/static/sw.js SESSION.md
git commit -m "srst-offline: SW precache new modules + v2 manual checklist"
```

---

## Self-review notes (for the implementer)

- Spec coverage: #1 transport (Task 4 markup + Task 5 `t-prev/t-play/t-next`/clock); #2 active-line follow (Task 5 `timeupdate`/`setActive`/`ended`); #3 timestamps + scrubber (Task 1 timeline + Task 5 `.ts`, `#transport`, `seekEp`, `renderMarks`); #5 icon bar (Task 4 SVG tabs + Task 5 `showView` active classes + `updateStatus` chip); #6 favorites view + export (Task 3 `/api/export` + Task 5 `renderFav`/`sendFav`/`exportAllUnexported`); #7 chips (Task 5 `SEARCH_CHIPS`); #8 date-DESC (Task 5 `search` sort); banner (Task 5 `maybeBanner`).
- Contracts consistent across tasks: `Timeline.build/fmt/lineAtEpTime/segAtEpTime` (Task 1) used verbatim in Task 5; `Api.*` (Task 2) used in Task 5; favorite `id = filename+"|"+start` and status machine unchanged from current code; `/api/export` body `{filename,start,end,text}` matches `Api.exportFav` and the server `_export`.
- No pytest (repo convention); timeline math has a real node assertion harness; server has curl smoke incl. a real (clean-up) export; DOM behavior is the manual checklist.
- Files stay focused: timeline.js and api.js are DOM-free single-purpose; app.js holds UI only.
