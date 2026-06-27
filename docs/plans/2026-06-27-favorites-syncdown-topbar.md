# srst-offline favorites sync-down + top-bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Favorites view show the union of local (IndexedDB) and remote (server) favorites by adding a server list endpoint and a bidirectional sync that pulls the server list down and reconciles it into IndexedDB; and tidy the top bar (single row: tabs + play/pause + clock + status chip, prev/next removed, 📶/✈️ status icons).

**Architecture:** A new `GET /api/favorites` proxies uttale's favorites list. `syncFavorites` becomes "sync up, then pull down + reconcile into IndexedDB" so the local store is a durable offline mirror overlaid with unflushed local pending/deleted. The Favorites view renders from that mirror (render immediately, refresh after pull). The top bar moves play/pause + clock inline after the Favorites tab and swaps the status glyphs.

**Tech Stack:** Python 3.12 stdlib; vanilla JS (IndexedDB); no new deps. `fake-indexeddb` (already installed in `/tmp/opencode`) for the reconcile harness.

**Spec:** `docs/specs/2026-06-27-favorites-syncdown-topbar-design.md`

---

## Testing approach (read first)

No automated suite (AGENTS.md). Per task: `py_compile` (Python), `node --check` (JS),
`curl -k` smoke against live uttale (`https://localhost:7010`, already running — do
NOT start/stop it), a `fake-indexeddb` node harness for the reconcile logic, and a
manual browser checklist for DOM behavior.

**Environment facts (verified live):**
- venv python: `/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python`. `node` v25.
- `fake-indexeddb` is installed at `/tmp/opencode/node_modules` (require via absolute path or run harness from `/tmp/opencode`).
- The live server (`GET /uttale/Favorites`) currently has **7** real user favorites. Do NOT disturb them; `GET /api/favorites` smoke just reads (no writes).
- Spare smoke port: 7021-7029; kill smoke server by saved PID (never bare `pkill`); temp files in `/tmp/opencode`; clean up harnesses.

**Commit discipline:** stage only files each task names; never `git add -A` (repo has pre-existing untracked: `.ctags`, `*.egg-info/`, `hello.py`, `openapi.json`, `response.json`).

---

## File Structure

| File | Change |
|---|---|
| `offline/offline.py` | add `/api/favorites` GET route (proxy uttale Favorites list, sort=created_desc) |
| `offline/static/api.js` | add `favList()` |
| `offline/static/app.js` | bidirectional `syncFavorites` (pull + reconcile); Favorites-open sync; `renderFav` render-then-refresh; `showView`/`updateStatus`/`el` changes; drop prev/next refs; add `nowplaying` ref |
| `offline/static/index.html` | single-row bar (play/pause + clock after Favorites); remove prev/next + `#transport-top` |
| `offline/static/app.css` | add `#nowplaying`; remove `#transport-top` rules |

No DB schema or SW change.

---

## Task 1: Server `GET /api/favorites` + `Api.favList()`

**Files:**
- Modify: `offline/offline.py`
- Modify: `offline/static/api.js`

- [ ] **Step 1: Add the `/api/favorites` route to `do_GET`**

In `offline/offline.py`, the `do_GET` method currently has this chain:

```python
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

Add a `/api/favorites` branch before the `else`:

```python
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
```

- [ ] **Step 2: Add `favList()` to api.js**

In `offline/static/api.js`, the IIFE currently returns
`{ scopes, lines, audioBlob, favAdd, favDel, exportFav }`. Add a `favList` function
and include it in the return. Insert this function (e.g. after `lines`):

```javascript
  async function favList() {
    const r = await fetch("/api/favorites");
    return r.json();
  }
```

And change the return line to:

```javascript
  return { scopes, lines, favList, audioBlob, favAdd, favDel, exportFav };
```

- [ ] **Step 3: Verify compile + syntax**

Run:
```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m py_compile offline/offline.py && echo "py ok"
node --check offline/static/api.js && echo "api.js ok"
```
Expected: `py ok` and `api.js ok`.

- [ ] **Step 4: Smoke — `/api/favorites` returns the live list**

Run from repo root with `--ssl`:
```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 --ssl &
echo $! > /tmp/opencode/offline.pid
sleep 1.5
curl -sk "https://localhost:7021/api/favorites" | python3 -c "import sys,json;d=json.load(sys.stdin);print('count',d['results_count']);print('has fields',sorted(d['results'][0].keys()) if d['results'] else 'EMPTY')"
kill "$(cat /tmp/opencode/offline.pid)"
```
Expected: `count 7` and a field list including `created_at, end, exported_at, filename, start, text, updated_at`. (If the real count differs from 7 because favorites changed, that's fine — it must be the same as `GET https://localhost:7010/uttale/Favorites` and be non-empty.)

- [ ] **Step 5: Commit**

```bash
git add offline/offline.py offline/static/api.js
git commit -m "srst-offline: GET /api/favorites + Api.favList()"
```

---

## Task 2: Bidirectional `syncFavorites` (pull + reconcile)

**Files:**
- Modify: `offline/static/app.js`
- Test: `/tmp/opencode/test_reconcile.js` (fake-indexeddb harness)

- [ ] **Step 1: Replace `syncFavorites` with the bidirectional version**

In `offline/static/app.js`, replace the entire current `syncFavorites` function:

```javascript
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
```

with:

```javascript
async function syncFavorites() {
  if (!navigator.onLine) return;
  // 1. sync up: flush local pending/deleted to the server
  for (const f of await DB.all("favorites")) {
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
  // 2. pull down + reconcile the server list into IndexedDB
  let data;
  try { data = await Api.favList(); } catch (e) { return; }
  const serverByKey = {};
  for (const s of (data && data.results) || []) {
    serverByKey[s.filename + "|" + s.start] = s;
  }
  await reconcileFavorites(serverByKey);
}

// Reconcile rule: local pending/deleted win until flushed; otherwise server wins;
// a local 'synced' row absent from the server was deleted elsewhere -> remove it.
async function reconcileFavorites(serverByKey) {
  const locals = await DB.all("favorites");
  const localById = {};
  for (const f of locals) localById[f.id] = f;

  for (const key of Object.keys(serverByKey)) {
    const s = serverByKey[key];
    const local = localById[key];
    if (!local) {
      await DB.put("favorites", {
        id: key, filename: s.filename, start: s.start, end: s.end || "",
        text: s.text || "", status: "synced",
        updatedAt: s.updated_at || new Date().toISOString(),
        exported_at: s.exported_at || null,
      });
    } else if (local.status === "synced") {
      local.text = s.text || "";
      local.end = s.end || "";
      local.exported_at = s.exported_at || null;
      await DB.put("favorites", local);
    }
    // local pending/deleted: leave untouched (intent wins; flush already attempted)
  }
  for (const f of locals) {
    if (f.status === "synced" && !serverByKey[f.id]) {
      await DB.del("favorites", f.id);
    }
  }
}
```

- [ ] **Step 2: Write the fake-indexeddb reconcile harness**

Create `/tmp/opencode/test_reconcile.js`. It loads the real `db.js`, extracts
`reconcileFavorites`/`syncFavorites` logic by reimplementing the reconcile against
the real `DB` (the harness calls a copy of `reconcileFavorites` bound to the real
`DB`, since app.js isn't a module). Use this self-contained harness:

```javascript
const assert = require("assert");
require("fake-indexeddb/auto");
const fs = require("fs");
const dbSrc = fs.readFileSync("/mnt/payload/share/msi/prg/srst-harken/offline/static/db.js", "utf8");
const DB = eval(dbSrc + "; DB;");

// Copy of reconcileFavorites from app.js (kept in sync with the implementation).
async function reconcileFavorites(serverByKey) {
  const locals = await DB.all("favorites");
  const localById = {};
  for (const f of locals) localById[f.id] = f;
  for (const key of Object.keys(serverByKey)) {
    const s = serverByKey[key];
    const local = localById[key];
    if (!local) {
      await DB.put("favorites", {
        id: key, filename: s.filename, start: s.start, end: s.end || "",
        text: s.text || "", status: "synced",
        updatedAt: s.updated_at || new Date().toISOString(),
        exported_at: s.exported_at || null,
      });
    } else if (local.status === "synced") {
      local.text = s.text || "";
      local.end = s.end || "";
      local.exported_at = s.exported_at || null;
      await DB.put("favorites", local);
    }
  }
  for (const f of locals) {
    if (f.status === "synced" && !serverByKey[f.id]) {
      await DB.del("favorites", f.id);
    }
  }
}

(async () => {
  // Seed local store:
  await DB.put("favorites", { id: "a.vtt|0", filename: "a.vtt", start: "0", end: "1", text: "old", status: "synced", updatedAt: "t1", exported_at: null }); // will be updated from server
  await DB.put("favorites", { id: "b.vtt|0", filename: "b.vtt", start: "0", end: "1", text: "gone", status: "synced", updatedAt: "t1", exported_at: null }); // absent from server -> removed
  await DB.put("favorites", { id: "c.vtt|0", filename: "c.vtt", start: "0", end: "1", text: "mine", status: "pending", updatedAt: "t1" }); // pending -> untouched
  await DB.put("favorites", { id: "d.vtt|0", filename: "d.vtt", start: "0", end: "1", text: "del", status: "deleted", updatedAt: "t1" }); // deleted -> untouched

  const serverByKey = {
    "a.vtt|0": { filename: "a.vtt", start: "0", end: "2", text: "new", updated_at: "t2", exported_at: "x" }, // updates a
    "e.vtt|0": { filename: "e.vtt", start: "0", end: "3", text: "server-only", updated_at: "t2", exported_at: null }, // inserted
    "c.vtt|0": { filename: "c.vtt", start: "0", end: "1", text: "mine", updated_at: "t2", exported_at: null }, // also on server, but local is pending -> untouched
    // b.vtt absent -> b removed
  };

  await reconcileFavorites(serverByKey);

  const all = await DB.all("favorites");
  const byId = {}; for (const f of all) byId[f.id] = f;

  assert.ok(byId["a.vtt|0"], "a present");
  assert.strictEqual(byId["a.vtt|0"].text, "new", "a text updated from server");
  assert.strictEqual(byId["a.vtt|0"].end, "2", "a end updated");
  assert.strictEqual(byId["a.vtt|0"].exported_at, "x", "a exported_at updated");
  assert.strictEqual(byId["a.vtt|0"].status, "synced", "a stays synced");

  assert.ok(!byId["b.vtt|0"], "b removed (synced, absent from server)");

  assert.ok(byId["c.vtt|0"], "c present");
  assert.strictEqual(byId["c.vtt|0"].status, "pending", "c stays pending (untouched)");
  assert.strictEqual(byId["c.vtt|0"].text, "mine", "c text untouched");

  assert.ok(byId["d.vtt|0"], "d present");
  assert.strictEqual(byId["d.vtt|0"].status, "deleted", "d stays deleted (untouched)");

  assert.ok(byId["e.vtt|0"], "e inserted from server");
  assert.strictEqual(byId["e.vtt|0"].status, "synced", "e inserted as synced");
  assert.strictEqual(byId["e.vtt|0"].text, "server-only", "e text from server");

  console.log("reconcile OK");
})();
```

- [ ] **Step 3: Run the reconcile harness**

Run: `node /tmp/opencode/test_reconcile.js`
Expected: `reconcile OK` (no assertion errors).

- [ ] **Step 4: Syntax-check app.js**

Run: `node --check offline/static/app.js`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add offline/static/app.js
git commit -m "srst-offline: bidirectional syncFavorites (pull server list + reconcile)"
```

---

## Task 3: Favorites-open sync + render-then-refresh

**Files:**
- Modify: `offline/static/app.js`

- [ ] **Step 1: Trigger sync when the Favorites tab opens**

In `offline/static/app.js`, the nav handlers are:

```javascript
el.navFind.onclick = () => { renderFind(); showView("find"); };
el.navListen.onclick = () => showView("listen");
el.navFav.onclick = () => { renderFav(); showView("fav"); };
```

`renderFav` itself will handle the online pull (next step), so leave these as-is.

- [ ] **Step 2: Make `renderFav` render immediately, then refresh after pull**

In `renderFav`, the function currently starts:

```javascript
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
```

Insert a one-time online pull right after `el.viewFav.appendChild(hdr);` (before
reading `favs`), guarded by a module flag so it refreshes once per open without
looping:

```javascript
async function renderFav() {
  el.viewFav.innerHTML = "";
  const hdr = document.createElement("div");
  hdr.className = "episode";
  const exportAll = document.createElement("button");
  exportAll.textContent = "Export all (unexported)";
  exportAll.onclick = () => exportAllUnexported(exportAll);
  hdr.appendChild(exportAll);
  el.viewFav.appendChild(hdr);

  if (navigator.onLine && !renderFav._pulling) {
    renderFav._pulling = true;
    syncFavorites().then(() => { renderFav._pulling = false; renderFav(); })
      .catch(() => { renderFav._pulling = false; });
  }

  const favs = (await DB.all("favorites")).filter((f) => f.status !== "deleted");
```

(The rest of `renderFav` — sort, empty-check, row rendering — is unchanged. The
guard prevents the post-pull `renderFav()` from kicking off another pull.)

- [ ] **Step 3: Syntax-check**

Run: `node --check offline/static/app.js`
Expected: no output, exit 0.

- [ ] **Step 4: Served check**

Run from repo root:
```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 &
echo $! > /tmp/opencode/offline.pid
sleep 1
curl -s -o /dev/null -w "app.js -> %{http_code}\n" "http://localhost:7021/app.js"
kill "$(cat /tmp/opencode/offline.pid)"
```
Expected: `app.js -> 200`.

- [ ] **Step 5: Commit**

```bash
git add offline/static/app.js
git commit -m "srst-offline: Favorites view pulls server list on open (render then refresh)"
```

---

## Task 4: Top bar — play/pause + clock inline, remove prev/next, 📶/✈️ icons

**Files:**
- Modify: `offline/static/index.html`
- Modify: `offline/static/app.css`
- Modify: `offline/static/app.js`

- [ ] **Step 1: Update the bar markup in index.html**

Replace this block:

```html
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
```

with (tabs unchanged; play/pause + clock moved into the bar after the tabs in a
`#nowplaying` span; prev/next and `#transport-top` removed):

```html
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
    <span id="nowplaying" hidden>
      <button id="t-play" aria-label="Play/pause" title="Play/pause">▶</button>
      <span id="clock">0:00:00 / 0:00:00</span>
    </span>
    <span id="status" title=""></span>
  </header>
```

- [ ] **Step 2: Update CSS**

In `offline/static/app.css`, find these rules:

```css
#transport-top { position: sticky; top: 2.5rem; z-index: 9; display: flex; gap: .25rem;
  align-items: center; background: #fafafa; border-bottom: 1px solid #eee; padding: .2rem .5rem; }
#transport-top button { background: none; border: none; font-size: 1.1rem; cursor: pointer; }
#clock { margin-left: auto; font-size: .8rem; color: #444; font-variant-numeric: tabular-nums; }
```

Replace them with (drop the `#transport-top` rules; add `#nowplaying`; keep `#clock`
but without the `margin-left:auto` since the status chip now carries it):

```css
#nowplaying { display: inline-flex; align-items: center; gap: .35rem; }
#nowplaying[hidden] { display: none; }
#nowplaying button { background: none; border: none; font-size: 1.1rem; cursor: pointer; }
#clock { font-size: .8rem; color: #444; font-variant-numeric: tabular-nums; }
```

(The `#status { margin-left: auto; ... }` rule already pushes the chip to the far
right; `#nowplaying` sits between the tabs and the chip.)

- [ ] **Step 3: Update app.js — element refs, showView, updateStatus**

(a) In the `el` object, remove the `transportTop`, `tPrev`, and `tNext` lines and add
`nowplaying`. The block currently is:

```javascript
  navFav: document.getElementById("nav-fav"),
  transportTop: document.getElementById("transport-top"),
  transport: document.getElementById("transport"),
  tPrev: document.getElementById("t-prev"),
  tPlay: document.getElementById("t-play"),
  tNext: document.getElementById("t-next"),
  clock: document.getElementById("clock"),
```

Change to:

```javascript
  navFav: document.getElementById("nav-fav"),
  nowplaying: document.getElementById("nowplaying"),
  transport: document.getElementById("transport"),
  tPlay: document.getElementById("t-play"),
  clock: document.getElementById("clock"),
```

(b) In `showView`, replace the `el.transportTop.hidden = !listening;` line with
`el.nowplaying.hidden = !listening;`. The function becomes:

```javascript
function showView(which) {
  el.viewFind.hidden = which !== "find";
  el.viewListen.hidden = which !== "listen";
  el.viewFav.hidden = which !== "fav";
  const listening = which === "listen";
  el.nowplaying.hidden = !listening;
  el.transport.hidden = !listening;
  el.navFind.classList.toggle("active", which === "find");
  el.navListen.classList.toggle("active", which === "listen");
  el.navFav.classList.toggle("active", which === "fav");
}
```

(c) In `updateStatus`, change the glyph line. The function currently:

```javascript
async function updateStatus() {
  const favs = await DB.all("favorites");
  const pending = favs.filter((f) => f.status !== "synced").length;
  el.status.textContent = (navigator.onLine ? "⛅" : "⚡") + pending;
  el.status.title = (navigator.onLine ? "online" : "offline") + ` · ${pending} pending`;
}
```

Change the `textContent` line to:

```javascript
  el.status.textContent = (navigator.onLine ? "📶" : "✈️") + " " + pending;
```

(d) Remove the now-dangling prev/next handlers. Find and DELETE these two lines:

```javascript
el.tPrev.onclick = () => { if (currentLine > 0) playLine(currentLine - 1); };
el.tNext.onclick = () => { if (tl && currentLine + 1 < tl.lines.length) playLine(currentLine + 1); };
```

(Leave the `el.tPlay.onclick`, the `play`/`pause` listeners, `el.clock`/`updateClock`,
`timeupdate`/`ended`, and all scrubber code intact.)

- [ ] **Step 4: Verify no stale references and syntax**

Run from repo root:
```bash
grep -n "tPrev\|tNext\|transportTop\|transport-top" offline/static/app.js || echo "no stale refs"
node --check offline/static/app.js && echo "app.js ok"
node -e '
const fs=require("fs");
const js=fs.readFileSync("offline/static/app.js","utf8");
const html=fs.readFileSync("offline/static/index.html","utf8");
const ids=[...js.matchAll(/getElementById\("([^"]+)"\)/g)].map(m=>m[1]);
const missing=ids.filter(id=>!html.includes(`id="${id}"`));
console.log("element ids:", ids.length, "| missing in html:", missing.length?missing:"none");
'
```
Expected: `no stale refs`; `app.js ok`; `missing in html: none`.

- [ ] **Step 5: Full-stack served smoke + favorites endpoint**

Run from repo root with `--ssl`:
```bash
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python -m offline.offline --port 7021 --ssl &
echo $! > /tmp/opencode/offline.pid
sleep 1.5
for p in / /app.css /db.js /api.js /timeline.js /app.js /sw.js; do
  printf "%-14s " "$p"; curl -sk -o /dev/null -w "%{http_code}\n" "https://localhost:7021$p"
done
curl -sk "https://localhost:7021/api/favorites" | python3 -c "import sys,json;print('favorites count',json.load(sys.stdin)['results_count'])"
kill "$(cat /tmp/opencode/offline.pid)"
```
Expected: all assets `200`; `favorites count 7` (or the current real baseline, non-empty).

- [ ] **Step 6: Commit**

```bash
git add offline/static/index.html offline/static/app.css offline/static/app.js
git commit -m "srst-offline: single-row top bar (play/pause + clock inline), remove prev/next, wifi/airplane status"
```

---

## Task 5: Manual checklist update

**Files:**
- Modify: `SESSION.md`

- [ ] **Step 1: Append a note under the srst-offline v2 section**

In `SESSION.md`, find the line `8. Offline: marking still works; export shows it
needs a connection.` (end of the v2 checklist) and add immediately after it:

```markdown

v2.1 changes: Favorites now shows the union of local + server favorites — opening
the tab (online) pulls `GET /api/favorites` and reconciles into IndexedDB (local
pending/deleted win; a synced row absent from the server is removed). Verify on a
fresh device/origin: with no local marks, the Favorites tab still lists your server
favorites once online. Top bar is one row now: [Find][Listen][Favorites] then
play/pause + clock (Listen view only), status chip far right showing 📶 (online) /
✈️ (offline) + pending count. Prev/next-line buttons removed (use line taps or the
scrubber).
```

- [ ] **Step 2: Commit**

```bash
git add SESSION.md
git commit -m "srst-offline: v2.1 manual checklist (favorites sync-down + bar)"
```

---

## Self-review notes (for the implementer)

- Spec coverage: #1 = Task 1 (`/api/favorites` + `favList`) + Task 2 (bidirectional
  `syncFavorites` + `reconcileFavorites`) + Task 3 (Favorites-open pull, render-then-
  refresh); #2 = Task 4 (single-row bar, prev/next removed); #3 = Task 4
  (📶/✈️ in `updateStatus`).
- Reconcile rules match the spec exactly (local pending/deleted untouched; server
  inserts/updates synced; synced-absent-from-server removed) and are covered by the
  fake-indexeddb harness in Task 2.
- Contract consistency: `Api.favList()` (Task 1) returns `{results:[...]}` consumed
  by `syncFavorites` (Task 2); reconcile key = `filename + "|" + start` = the
  favorite `id` everywhere; favorite record fields (`id,filename,start,end,text,
  status,updatedAt,exported_at`) unchanged from existing code. The `#nowplaying`
  element (Task 4 HTML) matches `el.nowplaying` (Task 4 JS) and the `#nowplaying`
  CSS.
- No pytest (repo convention); reconcile has a real fake-indexeddb assertion harness;
  server has curl smoke (read-only, no favorite writes — the 7 real favorites are not
  disturbed); DOM behavior is the manual checklist.
- No DB schema change, no SW shell change (`/api/favorites` is a `/api/*` route the SW
  already bypasses).
