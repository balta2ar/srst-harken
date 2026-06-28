# Reindex button (Find tab) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Reindex button beside the Find tab's "Search results" header that reuses the current search query as the `/uttale/Reindex` pattern, then auto re-runs the search after 5s so newly-indexed episodes appear.

**Architecture:** Thin additive feature in the offline PWA (harken). A new `/api/reindex` POST proxy in `offline.py` forwards to the backend `/uttale/Reindex` (mirrors the existing `/api/topics`→`GenerateTopics` proxy). `Api.reindex(pattern)` POSTs to it. In `app.js`, `renderFind`'s results header gains a button whose visibility is computed in `search()` (online + non-empty query) and whose click handler `reindexSearch` POSTs the query, shows a transient status, and re-runs the search after 5s.

**Tech Stack:** Vanilla JS (no framework), Python 3 stdlib http.server, NiceGUI-independent offline server; tests via `node --check` + a `fake-indexeddb`-free node harness (these functions don't touch IndexedDB) and `py_compile` + `curl -k` smoke.

## Global Constraints

- Repo: `/mnt/payload/share/msi/prg/srst-harken`. Edit only `offline/offline.py`, `offline/static/api.js`, `offline/static/app.js`, `offline/static/app.css` (+ this plan/spec). Commit to **master**; stage only the named files (never `git add -A` — the repo has untracked throwaways).
- Style (AGENTS.md): mimic existing code; no comments unless they explain *why*; keep all imports at top; concise; reuse helpers.
- Testing (AGENTS.md): **no pytest**, no automated suite. Verify JS with `node --check` and a temporary node harness that extracts the REAL functions from the source (run harnesses from `/tmp/opencode`). Verify python with `python -m py_compile` and a `curl -k` smoke against a throwaway server. Then a manual browser checklist.
- Throwaway servers: uttale backend on `127.0.0.1:7011` (uttale uses `--iface host:port`, NEVER `--port`; separate temp DBs under `/tmp/opencode`); offline server on `127.0.0.1:7023` (offline.py uses `--host`/`--port`). Kill by saved PID (`/tmp/opencode/utt.pid`, `/tmp/opencode/off.pid`); never bare `pkill`. Temp files under `/tmp/opencode`.
- Do NOT start/stop/restart the real servers (uttale :7010, offline :7020). Do not touch `~/.cache/srst-uttale/root.db`.
- The backend `POST /uttale/Reindex` request body is `{ "pattern": "<query>", "limit"?: <int> }`; response `{ "pattern", "status", "limit", "matched", "truncated" }`, `status` ∈ `"no pattern"|"nothing matched"|"already running"|"started"`. (Backend already shipped on master in the uttale repo.)

## File structure

- `offline/offline.py` — add `/api/reindex` to the POST allow-list + one dispatch line calling the existing `_proxy_post`.
- `offline/static/api.js` — add `reindex(pattern)` (clone of `generateTopics`) + export it.
- `offline/static/app.js` — add the header button in `renderFind`, set its visibility in `search`, and add the `reindexSearch` handler.
- `offline/static/app.css` — `.results-head` flex row + reuse `.gen-topics`-style button.

---

### Task 1: `/api/reindex` POST proxy in `offline.py`

**Files:**
- Modify: `offline/offline.py` (do_POST allow-list at line 191; add a dispatch branch after the `/api/topics` branch ~line 207)
- Test: `py_compile` + `curl -k` smoke (Step 4)

**Interfaces:**
- Produces: `POST /api/reindex` with a JSON body `{pattern}` → proxied to `/uttale/Reindex`, relaying the upstream JSON response. Uses the existing `_proxy_post(upstream_path, raw, err_label)` (offline.py:219).

- [ ] **Step 1: Add `/api/reindex` to the allow-list and dispatch**

In `offline/offline.py`, the `do_POST` guard currently reads (line 191):
```python
        if parsed.path not in ("/api/favorite", "/api/export", "/api/exported", "/api/listens", "/api/topics"):
```
Change it to include `/api/reindex`:
```python
        if parsed.path not in ("/api/favorite", "/api/export", "/api/exported", "/api/listens", "/api/topics", "/api/reindex"):
```

Then add a dispatch branch immediately after the existing `/api/topics` branch (after line 207, before the Favorites fall-through `url = ...`):
```python
        if parsed.path == "/api/reindex":
            self._proxy_post("/uttale/Reindex", raw, "reindex error")
            return
```

- [ ] **Step 2: Syntax check**

Run: `python -m py_compile offline/offline.py`
Expected: no output (success).

- [ ] **Step 3: Smoke — proxy forwards to the backend and relays JSON**

Start a throwaway uttale backend + a throwaway offline server pointed at it, then POST `/api/reindex`. (Run from the harken repo root.)

```bash
# temp tree for the backend to index
mkdir -p /tmp/opencode/ui-smoke/48k/idioti/20260601/by10m
printf 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhei\n' > /tmp/opencode/ui-smoke/48k/idioti/20260601/by10m/a.vtt
# backend (uttale) on 7011 with temp DBs
/tmp/opencode/uttale-test/bin/python -m uttale.backend.server \
  --root /tmp/opencode/ui-smoke --db /tmp/opencode/ui-smoke/lines.db \
  --favorites-db /tmp/opencode/ui-smoke/fav.db --listens-db /tmp/opencode/ui-smoke/listens.db \
  --iface 127.0.0.1:7011 >/tmp/opencode/ui-smoke/utt.log 2>&1 &
echo $! > /tmp/opencode/utt.pid
# offline server on 7023 pointing at the backend (http, no ssl)
python offline/offline.py --uttale http://127.0.0.1:7011 --host 127.0.0.1 --port 7023 >/tmp/opencode/ui-smoke/off.log 2>&1 &
echo $! > /tmp/opencode/off.pid
# wait for readiness
for i in $(seq 1 20); do
  c=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:7023/api/scopes?q=idioti" 2>/dev/null || echo 000)
  [ "$c" = "200" ] && { echo "ready"; break; }; sleep 0.5
done
echo "--- POST /api/reindex (expect status started, matched 1) ---"
curl -s -X POST http://127.0.0.1:7023/api/reindex -H 'Content-Type: application/json' -d '{"pattern":"idioti 202606"}'; echo
echo "--- empty pattern (expect status no pattern) ---"
curl -s -X POST http://127.0.0.1:7023/api/reindex -H 'Content-Type: application/json' -d '{"pattern":""}'; echo
```

Expected: first POST returns `{"pattern":"idioti 202606","status":"started","limit":2000,"matched":1,"truncated":false}`; second returns `{"...","status":"no pattern","matched":0,...}`.

- [ ] **Step 4: Tear down throwaway servers (by PID) and verify real servers untouched**

```bash
kill "$(cat /tmp/opencode/off.pid)" 2>/dev/null && rm -f /tmp/opencode/off.pid
kill "$(cat /tmp/opencode/utt.pid)" 2>/dev/null && rm -f /tmp/opencode/utt.pid
rm -rf /tmp/opencode/ui-smoke
```
(Do not touch the real :7010 / :7020 servers.)

- [ ] **Step 5: Commit**

```bash
git add offline/offline.py
git commit -m "offline: add /api/reindex POST proxy to /uttale/Reindex"
```

---

### Task 2: `Api.reindex(pattern)` in `api.js`

**Files:**
- Modify: `offline/static/api.js` (add `reindex` after `generateTopics` ~line 81; add to exports line 92)
- Test: node harness with a stubbed `fetch` (Step 1)

**Interfaces:**
- Consumes: `POST /api/reindex` (Task 1).
- Produces: `Api.reindex(pattern)` → POSTs `{pattern}` as JSON to `/api/reindex`; returns the parsed JSON, or `null` on a non-ok response / thrown error (mirrors `generateTopics`).

- [ ] **Step 1: Write the failing test (node harness)**

Create `/tmp/opencode/api-reindex.test.js`:
```js
const assert = require("assert");
const fs = require("fs");
const src = fs.readFileSync("/mnt/payload/share/msi/prg/srst-harken/offline/static/api.js", "utf8");

// Extract the real `reindex` function body from the IIFE source.
const m = src.match(/async function reindex\(pattern\) \{[\s\S]*?\n  \}/);
if (!m) throw new Error("reindex() not found in api.js");

let lastCall = null;
global.fetch = async (url, opts) => {
  lastCall = { url, opts };
  return { ok: true, async json() { return { status: "started", matched: 2, truncated: false }; } };
};
const reindex = eval("(" + m[0].replace("async function reindex", "async function") + ")");

(async () => {
  const res = await reindex("idioti 202606");
  assert.strictEqual(lastCall.url, "/api/reindex", "POSTs to /api/reindex");
  assert.strictEqual(lastCall.opts.method, "POST");
  assert.strictEqual(lastCall.opts.headers["Content-Type"], "application/json");
  assert.deepStrictEqual(JSON.parse(lastCall.opts.body), { pattern: "idioti 202606" });
  assert.deepStrictEqual(res, { status: "started", matched: 2, truncated: false });

  // non-ok -> null
  global.fetch = async () => ({ ok: false, async json() { return {}; } });
  const res2 = await reindex("x");
  assert.strictEqual(res2, null, "non-ok returns null");

  // throw -> null
  global.fetch = async () => { throw new Error("offline"); };
  const res3 = await reindex("x");
  assert.strictEqual(res3, null, "thrown error returns null");
  console.log("Api.reindex OK");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node /tmp/opencode/api-reindex.test.js`
Expected: FAIL — `Error: reindex() not found in api.js`.

- [ ] **Step 3: Implement `Api.reindex`**

In `offline/static/api.js`, add after the `generateTopics` function (which ends at line 81, before `clipBlob`):
```js
  async function reindex(pattern) {
    try {
      const r = await fetch("/api/reindex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern }),
      });
      if (!r.ok) return null;
      return r.json();
    } catch (e) {
      return null;
    }
  }
```
Add `reindex` to the exported object (line 92):
```js
  return { scopes, lines, favList, audioBlob, favAdd, favDel, exportFav, markExported, topics, generateTopics, reindex, clipBlob, listenList, listenPut };
```

- [ ] **Step 4: Run test + node --check**

Run: `node /tmp/opencode/api-reindex.test.js`
Expected: PASS — `Api.reindex OK`.
Run: `node --check offline/static/api.js`
Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add offline/static/api.js
git commit -m "offline: add Api.reindex(pattern)"
```

---

### Task 3: Reindex button + visibility + handler in `app.js` (+ CSS)

**Files:**
- Modify: `offline/static/app.js` (`renderFind` header ~lines 115-119; `search` ~lines 176-211; add `reindexSearch`)
- Modify: `offline/static/app.css` (add `.results-head` + `.reindex-btn`)
- Test: node harness extracting `reindexSearch` + a visibility check (Step 1)

**Interfaces:**
- Consumes: `Api.reindex(pattern)` (Task 2); the existing `search(query, box)` (app.js:176).
- Produces:
  - `el.reindexBtn` — the header button element (module-level `el` object, used by `search` to toggle visibility).
  - `reindexSearch(query, box, btn)` — async click handler: disables btn, POSTs via `Api.reindex`, sets a transient label per status, and on `started`/`already running` re-runs `search(query, box)` after 5000ms then restores the button.
  - `REINDEX_REFRESH_MS = 5000` (module constant).

- [ ] **Step 1: Write the failing test (node harness)**

Create `/tmp/opencode/app-reindex.test.js`:
```js
const assert = require("assert");
const fs = require("fs");
const src = fs.readFileSync("/mnt/payload/share/msi/prg/srst-harken/offline/static/app.js", "utf8");

// Extract the REINDEX_REFRESH_MS value and the real reindexSearch source.
const cMatch = src.match(/const REINDEX_REFRESH_MS = (\d+);/);
if (!cMatch) throw new Error("REINDEX_REFRESH_MS not found");
// Expose the constant as a global so the eval'd function can see it
// (a separate `eval(const ...)` is block-scoped and would NOT be visible).
global.REINDEX_REFRESH_MS = Number(cMatch[1]);
const fMatch = src.match(/async function reindexSearch\(query, box, btn\) \{[\s\S]*?\n\}/);
if (!fMatch) throw new Error("reindexSearch not found");

// fake timers — capture scheduled callbacks; flush() runs them
let scheduled = [];
global.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; };
function flush() { const s = scheduled; scheduled = []; s.forEach((x) => x.fn()); }

function setOnline(v) {
  Object.defineProperty(globalThis, "navigator", { value: { onLine: v }, configurable: true });
}
setOnline(true);

let reindexResp = { status: "started", matched: 3, truncated: false };
global.Api = { reindex: async (p) => reindexResp };

let searchCalls = [];
global.search = async (q, box) => { searchCalls.push([q, box]); };

function mkBtn() { return { disabled: false, hidden: false, textContent: "Reindex" }; }

eval(fMatch[0].replace("async function reindexSearch", "global.reindexSearch = async function"));

(async () => {
  // started -> "Reindexed 3", disabled, schedules a re-search at 5000ms that runs search + restores
  let btn = mkBtn();
  await reindexSearch("idioti", "BOX", btn);
  assert.ok(/Reindexed 3/.test(btn.textContent), "shows matched count: " + btn.textContent);
  assert.strictEqual(btn.disabled, true, "disabled during transient state");
  const reSearch = scheduled.find((s) => s.ms === 5000);
  assert.ok(reSearch, "a 5s re-search is scheduled");
  flush();
  assert.deepStrictEqual(searchCalls[searchCalls.length - 1], ["idioti", "BOX"], "re-runs search");
  assert.strictEqual(btn.disabled, false, "restored after refresh");
  assert.strictEqual(btn.textContent, "Reindex", "label restored");

  // truncated -> label hints to narrow
  searchCalls = []; reindexResp = { status: "started", matched: 2000, truncated: true };
  btn = mkBtn();
  await reindexSearch("2026", "BOX", btn);
  assert.ok(/narrow/i.test(btn.textContent) || /\+/.test(btn.textContent), "truncated hint: " + btn.textContent);
  flush();

  // nothing matched -> search NOT re-run (the restore timer may still be scheduled; assert on searchCalls, not timer count)
  searchCalls = []; reindexResp = { status: "nothing matched", matched: 0, truncated: false };
  btn = mkBtn();
  await reindexSearch("zzz", "BOX", btn);
  assert.ok(/Nothing/i.test(btn.textContent), "nothing-matched label: " + btn.textContent);
  flush();
  assert.strictEqual(searchCalls.length, 0, "no re-search on nothing matched");
  assert.strictEqual(btn.disabled, false, "restored");

  // error (null) -> "Reindex failed", search NOT re-run
  reindexResp = null; searchCalls = [];
  btn = mkBtn();
  await reindexSearch("x", "BOX", btn);
  assert.ok(/failed/i.test(btn.textContent), "failure label: " + btn.textContent);
  flush();
  assert.strictEqual(searchCalls.length, 0, "no re-search on error");
  assert.strictEqual(btn.disabled, false, "restored");

  // offline guard -> handler is a no-op (button untouched, no POST/search)
  setOnline(false); searchCalls = [];
  btn = mkBtn();
  await reindexSearch("idioti", "BOX", btn);
  assert.strictEqual(btn.textContent, "Reindex", "offline: no change");
  assert.strictEqual(searchCalls.length, 0, "offline: no re-search");
  setOnline(true);

  console.log("reindexSearch OK");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
```

Note on the transient labels: the handler sets an immediate "Reindexing…" label, then the post-response label; the test asserts only the final post-response label, the 5s re-search scheduling, and (for nothing-matched/error) that `search` is NOT re-run. The nothing-matched/error paths schedule a short `restore` timer, so the test asserts on `searchCalls` (the real invariant) rather than the raw scheduled-timer count.

- [ ] **Step 2: Run test to verify it fails**

Run: `node /tmp/opencode/app-reindex.test.js`
Expected: FAIL — `Error: REINDEX_REFRESH_MS not found` (or `reindexSearch not found`).

- [ ] **Step 3: Implement the constant + `reindexSearch`**

In `offline/static/app.js`, add the constant near the other module constants (e.g. just after `let favSort = ...` / near the top `let` block — anywhere at module top level is fine; place it right above `renderFind` at line 96 for locality):
```js
const REINDEX_REFRESH_MS = 5000;
```

Add the handler (place it right after the `search` function, after line 211):
```js
async function reindexSearch(query, box, btn) {
  const q = (query || "").trim();
  if (!q || !navigator.onLine) return;
  btn.disabled = true;
  btn.textContent = "Reindexing…";
  let res;
  try { res = await Api.reindex(q); } catch (e) { res = null; }
  const restore = () => { btn.disabled = false; btn.textContent = "Reindex"; };
  if (res && (res.status === "started" || res.status === "already running")) {
    btn.textContent = res.truncated ? `Reindexed ${res.matched}+ — narrow query`
      : (res.status === "started" ? `Reindexed ${res.matched}` : "Already running…");
    setTimeout(() => { search(q, box); restore(); }, REINDEX_REFRESH_MS);
  } else if (res && res.status === "nothing matched") {
    btn.textContent = "Nothing to index";
    setTimeout(restore, 2000);
  } else {
    btn.textContent = "Reindex failed";
    setTimeout(restore, 2000);
  }
}
```

- [ ] **Step 4: Run test + node --check**

Run: `node /tmp/opencode/app-reindex.test.js`
Expected: PASS — `reindexSearch OK`.
Run: `node --check offline/static/app.js`
Expected: no output.

- [ ] **Step 5: Wire the button into `renderFind` + visibility into `search`**

In `renderFind`, replace the plain results header (app.js:115-119):
```js
  const resultsHdr = document.createElement("h3");
  resultsHdr.textContent = "Search results";
  el.viewFind.appendChild(resultsHdr);
  const resultsBox = document.createElement("div");
  el.viewFind.appendChild(resultsBox);
```
with a header row containing the title + button:
```js
  const resultsHead = document.createElement("div");
  resultsHead.className = "results-head";
  const resultsHdr = document.createElement("h3");
  resultsHdr.textContent = "Search results";
  resultsHead.appendChild(resultsHdr);
  const reindexBtn = document.createElement("button");
  reindexBtn.className = "reindex-btn";
  reindexBtn.textContent = "Reindex";
  reindexBtn.hidden = true;
  reindexBtn.title = "Reindex everything matching this search on the server";
  resultsHead.appendChild(reindexBtn);
  el.viewFind.appendChild(resultsHead);
  el.reindexBtn = reindexBtn;
  const resultsBox = document.createElement("div");
  el.viewFind.appendChild(resultsBox);
  reindexBtn.onclick = () => reindexSearch(input.value, resultsBox, reindexBtn);
```
(`input` is the search box created earlier in `renderFind` at line 102; `resultsBox` is in scope.)

In `search(query, box)`, set the button's visibility based on online + non-empty query. Add at the **top of `search`**, right after the function signature (before `box.innerHTML = "Searching…"`), guarding for the button's existence:
```js
  if (el.reindexBtn) el.reindexBtn.hidden = !(navigator.onLine && (query || "").trim());
```

- [ ] **Step 6: Add CSS**

In `offline/static/app.css`, add (near the `.gen-topics` rules ~line 93):
```css
.results-head { display: flex; align-items: center; gap: .5rem; }
.results-head h3 { flex: 1; margin: 0; }
.reindex-btn { padding: .3rem .7rem; font-size: .8rem; background: #20c997;
  color: #fff; border: none; border-radius: 4px; white-space: nowrap; }
.reindex-btn:disabled { background: #9bd9c6; cursor: default; }
```

- [ ] **Step 7: Re-run node --check + the harness (regression after wiring)**

Run: `node --check offline/static/app.js`
Run: `node /tmp/opencode/app-reindex.test.js`
Expected: both pass (the wiring edits don't change `reindexSearch`/the constant, so the harness still passes).

- [ ] **Step 8: Manual browser smoke (document results in the commit/PR, do not automate)**

Against the real running offline server in a browser (or a throwaway pair from Task 1 Step 3, opened in a browser):
- Type a query that returns fewer episodes than exist on disk → "Reindex" button appears in the Search-results header.
- Click it → label shows "Reindexing…" then "Reindexed N"; after ~5s the search re-runs and the new episodes appear; button returns to "Reindex".
- Clear the search box → button hides. Toggle the device offline → on the next keystroke/search the button hides.
- A query matching nothing on disk → "Nothing to index".

- [ ] **Step 9: Commit**

```bash
git add offline/static/app.js offline/static/app.css
git commit -m "offline: Reindex button in Find tab (reuses query, auto re-search)"
```

---

## Cleanup (after all tasks)

Remove temp harnesses: `rm -f /tmp/opencode/api-reindex.test.js /tmp/opencode/app-reindex.test.js`. Ensure no throwaway server PIDs remain (`/tmp/opencode/utt.pid`, `/tmp/opencode/off.pid` deleted).

## Self-review checklist (completed by plan author)

- **Spec coverage:** `/api/reindex` proxy (T1); `Api.reindex` (T2); header button + online/non-empty visibility (T3 Step 5) + `reindexSearch` status handling incl. `started`/`already running`/`nothing matched`/error + 5s auto re-search + `truncated` hint (T3 Steps 3,1); CSS (T3 Step 6); manual checklist (T3 Step 8). All spec sections mapped.
- **Type consistency:** `Api.reindex(pattern) -> Promise<json|null>` (T2) consumed by `reindexSearch(query, box, btn)` (T3); `el.reindexBtn` set in `renderFind` and read in `search`; `REINDEX_REFRESH_MS` defined once and used in `reindexSearch`. Consistent.
- **No placeholders:** every code/edit step shows full code and exact commands.
- **Note:** these functions don't touch IndexedDB, so the node harnesses don't need `fake-indexeddb` (simpler than other harken harnesses).
