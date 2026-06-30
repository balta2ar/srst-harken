# Offline app event/sync refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the offline app's direct fan-out calls with a small internal event-driven model (`Events`/`Job`/`Sync`), so IndexedDB mutations emit domain events that drive UI refresh, debounced sync, counts, marks, and clip prefetch consistently — without changing user-visible behavior except to make updates more consistent and avoid redundant overlapping work.

**Architecture:** Three new browser-global IIFE modules under `offline/static/` (`events.js`, `job.js`, `sync.js`), loaded before `app.js`. Mutation functions in `app.js` stop fanning out and instead `Events.emit("<domain>:changed", {reason, ids})`. Subscribers coalesce local UI jobs (`Job.coalesce`) and debounce/serialize network work (`Job.debounce` via `Sync.request`). `syncFavorites`/`syncListens` keep their separate domain reconcile rules but now return a `changed` boolean; the `Sync` coordinator decides *what* to sync, they decide *how*.

**Tech Stack:** Vanilla browser JS (ES2020, no bundler, no imports — IIFE assigned to a single global const, matching `api.js`/`db.js`). IndexedDB via the existing `DB` wrapper. Tests: Node built-in `node:test` + `node:assert` run from `/tmp/opencode` (node v25), using `MockTimers` for debounce.

## Global Constraints

- No `import`/`export`/ES modules. Each new file is an IIFE assigned to one global const (`Events`, `Job`, `Sync`), exactly like `offline/static/api.js` and `offline/static/db.js`.
- Keep all code in `offline/static/`. The only `index.html` change is adding three `<script>` tags **before** `app.js`, in order `events.js`, `job.js`, `sync.js` (sync.js evaluates `Job.debounce` at IIFE time, so it must load after job.js).
- Do **not** introduce `BroadcastChannel`, a generic keyed scheduler, framework/reactivity libs, SW-driven sync, or IndexedDB schema changes. No `db.js` `VERSION` bump (no schema change). No `sw.js` cache-key bump is required by this refactor (no shell change); leave `sw.js` untouched.
- Do **not** comment "what" the code does; only "why" where non-obvious (matches repo `AGENTS.md`). Match existing brace/quote/2-space-indent style.
- Sync-loop suppression uses an **allowlist** of local-intent reasons (`isLocalIntent`), never a `server-reconcile` denylist.
- Direct-manipulation feedback (clicked star ★/☆ flip, comment textarea) MUST stay synchronous — never routed through `Job.coalesce`.
- Playback position syncing every ~5s is **intended** (the 5s `recordListen` tick requests a listen sync). This removes the old lazy-upload asymmetry.
- Verification per `AGENTS.md`: no pytest; use `node --check`, a `node:test` harness from `/tmp/opencode`, a `curl -k`/HTTP smoke render on a spare port (kill by saved PID, never bare `pkill`), and the manual browser checklist. Commit directly to `master`; stage only named files (never `git add -A`).
- Spec: `docs/specs/2026-06-30-offline-events-sync-refactor-design.md`. Keep `docs/sync-model.md` truthful: the listens-sync-every-5s change must be reflected there (Task 9).

---

## File Structure

- **Create `offline/static/events.js`** — `Events.on(type, fn)` / `Events.emit(type, detail)` over a single `EventTarget`. App-internal pub/sub. (Task 2)
- **Create `offline/static/job.js`** — `Job.coalesce(fn)` (non-reentrant, one trailing run) and `Job.debounce(fn, wait)` (trailing-edge debounce, non-overlapping, one follow-up pass). Pure; no DOM/IDB. (Task 1)
- **Create `offline/static/sync.js`** — `Sync.register(domain, {run, synced, changed})` and `Sync.request(domain)`. One debounced serial app-sync job built on `Job.debounce`; snapshots a requested-domain `Set`, runs each syncer, emits `<domain>:synced {changed}` and (if changed) `<domain>:changed {reason:"server-reconcile"}`. (Task 4)
- **Create `/tmp/opencode/job-test/job.test.cjs`** (scratch, not committed) — `node:test` coverage of `Job`. (Task 1)
- **Modify `offline/static/index.html:55-58`** — add three script tags before `app.js`. (Task 3)
- **Modify `offline/static/app.js`** — add `isLocalIntent` + scheduled-job consts + subscribers; convert `toggleFavorite`, `saveComment`, comment cancel, delete/export marking, `recordListen`, `refineFavOrder`, online/offline, play/pause, tab handlers, and `boot` to emit/register; make `syncFavorites`/`reconcileFavorites`/`syncListens`/`reconcileListens`/`pruneListened` return `changed`. (Tasks 5–8)
- **Modify `docs/sync-model.md`** — reflect listens-sync-every-5s + event-driven fan-out. (Task 9)

Task order is dependency-driven: `Job` (pure, keystone) → `Events` → `index.html` wiring → `Sync` → return-value plumbing on syncers → favorites subscribers/mutations → listens subscribers/mutations → network/boot/tabs → docs.

---

### Task 1: `job.js` — coalesce & debounce primitives (pure, tested)

**Files:**
- Create: `offline/static/job.js`
- Test: `/tmp/opencode/job-test/job.test.cjs` (scratch harness, NOT committed)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Job.coalesce(fn) -> schedule()` — `fn` is `() => Promise<void>|void`. Calling `schedule()` runs `fn`; calls made while `fn` runs collapse into exactly one trailing run after the current run finishes.
  - `Job.debounce(fn, wait) -> schedule()` — trailing-edge debounce: `schedule()` (re)arms a `wait`-ms timer; when it fires, run `fn` (never overlapping itself); if `schedule()` was called while `fn` was in flight, run exactly one follow-up `wait` ms after the in-flight pass finishes.

- [ ] **Step 1: Write the failing test**

The harness loads `job.js` (a browser IIFE that assigns a `const Job`) by reading the file and evaluating it in a function scope, then returning `Job`. Uses `node:test` `MockTimers` for debounce timing and a microtask flush for coalesce.

Create `/tmp/opencode/job-test/job.test.cjs`:

```js
const { test, mock } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const JOB_PATH = path.resolve("/mnt/payload/share/msi/prg/srst-harken/offline/static/job.js");

function loadJob() {
  const src = fs.readFileSync(JOB_PATH, "utf8");
  // job.js is `const Job = (() => {...})();` — eval in a fresh scope, return Job.
  return new Function(src + "\nreturn Job;")();
}

const tick = () => new Promise((r) => setImmediate(r));

test("coalesce: single schedule runs fn once", async () => {
  const Job = loadJob();
  let calls = 0;
  const run = Job.coalesce(async () => { calls++; });
  run();
  await tick();
  assert.strictEqual(calls, 1);
});

test("coalesce: schedules during a run collapse into exactly one trailing run", async () => {
  const Job = loadJob();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = Job.coalesce(async () => { calls++; if (calls === 1) await gate; });
  run();            // starts fn (call 1), now awaiting gate
  await tick();
  run(); run(); run(); // three schedules while running -> one trailing run
  release();
  await tick(); await tick();
  assert.strictEqual(calls, 2);
});

test("debounce: rapid schedules within wait collapse to one run", async () => {
  const Job = loadJob();
  const timers = mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  try {
    let calls = 0;
    const run = Job.debounce(async () => { calls++; }, 100);
    run(); run(); run();
    timers.tick(99);
    assert.strictEqual(calls, 0);
    timers.tick(1);
    await tick();
    assert.strictEqual(calls, 1);
  } finally { timers.reset(); }
});

test("debounce: a schedule during an in-flight run yields exactly one follow-up", async () => {
  const Job = loadJob();
  const timers = mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  try {
    let calls = 0;
    let release;
    let gate = new Promise((r) => { release = r; });
    const run = Job.debounce(async () => { calls++; if (calls === 1) await gate; }, 100);
    run();
    timers.tick(100);     // fire timer -> start fn (call 1), awaiting gate
    await tick();
    assert.strictEqual(calls, 1);
    run();                // scheduled while in flight
    release();            // let call 1 finish -> should re-arm timer
    await tick(); await tick();
    timers.tick(100);     // fire the follow-up timer
    await tick();
    assert.strictEqual(calls, 2);
  } finally { timers.reset(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /tmp/opencode/job-test && node --test`
Expected: FAIL — `job.js` does not exist yet (`ENOENT` / cannot read file). (If you prefer a clean "not defined" failure, create an empty `offline/static/job.js` first; either failure is acceptable as the red state.)

- [ ] **Step 3: Write minimal implementation**

Create `offline/static/job.js` (mirror the shapes from the spec; `coalesce` uses the `running/again` do-while loop, `debounce` re-arms in `finally` when `again`):

```js
const Job = (() => {
  function coalesce(fn) {
    let running = false;
    let again = false;
    return async function schedule() {
      if (running) { again = true; return; }
      running = true;
      try {
        do { again = false; await fn(); } while (again);
      } finally { running = false; }
    };
  }

  function debounce(fn, wait) {
    let timer = null;
    let running = false;
    let again = false;

    async function run() {
      if (running) { again = true; return; }
      running = true;
      again = false;
      try {
        await fn();
      } finally {
        running = false;
        if (again) { clearTimeout(timer); timer = setTimeout(run, wait); }
      }
    }

    return function schedule() {
      again = true;
      clearTimeout(timer);
      timer = setTimeout(run, wait);
    };
  }

  return { coalesce, debounce };
})();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /tmp/opencode/job-test && node --test`
Expected: PASS — 4 tests pass.

Also run: `node --check offline/static/job.js` (from repo root) — Expected: no output (valid).

- [ ] **Step 5: Commit**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add offline/static/job.js
git commit -m "feat(offline): add Job.coalesce/Job.debounce scheduling primitives

Pure non-reentrant coalesce (one trailing run) and trailing-edge debounce
(non-overlapping, one follow-up pass) for the event/sync refactor. Verified with
a node:test harness covering trailing-run and in-flight follow-up semantics."
```

(The `/tmp/opencode/job-test/` harness is scratch and intentionally not committed.)

---

### Task 2: `events.js` — internal pub/sub

**Files:**
- Create: `offline/static/events.js`
- Test: none automated (trivial wrapper; covered by smoke + manual). `node --check` only.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Events.on(type, fn)` — `fn` receives `detail` object (defaults to `{}`).
  - `Events.emit(type, detail)` — dispatches a `CustomEvent` with `detail` (defaults to `{}`).

- [ ] **Step 1: Write the implementation**

Create `offline/static/events.js`:

```js
const Events = (() => {
  const target = new EventTarget();

  function on(type, fn) {
    target.addEventListener(type, (event) => fn(event.detail || {}));
  }

  function emit(type, detail) {
    target.dispatchEvent(new CustomEvent(type, { detail: detail || {} }));
  }

  return { on, emit };
})();
```

- [ ] **Step 2: Verify it parses**

Run: `node --check offline/static/events.js`
Expected: no output (valid).

(`EventTarget`/`CustomEvent` are browser globals; `node --check` only checks syntax, not globals, so this passes under Node.)

- [ ] **Step 3: Commit**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add offline/static/events.js
git commit -m "feat(offline): add Events pub/sub (EventTarget wrapper)

App-internal domain-event bus for the event/sync refactor. No cross-tab
propagation (BroadcastChannel intentionally out of scope)."
```

---

### Task 3: Load new modules in `index.html`

**Files:**
- Modify: `offline/static/index.html:55-58`

**Interfaces:**
- Consumes: `events.js`, `job.js`, `sync.js` files (sync.js created in Task 4 — it is acceptable to add its tag now; the page is not exercised until later tasks).
- Produces: global load order `db.js`, `api.js`, `Events`, `Job`, `Sync`, `timeline.js`, `app.js`.

- [ ] **Step 1: Add the script tags**

Edit `offline/static/index.html`. Replace the existing script block (currently `db.js`, `api.js`, `timeline.js`, `app.js`) so the three new modules load **before** `app.js`, with `events.js` and `job.js` before `sync.js`:

```html
  <script src="/db.js"></script>
  <script src="/api.js"></script>
  <script src="/events.js"></script>
  <script src="/job.js"></script>
  <script src="/sync.js"></script>
  <script src="/timeline.js"></script>
  <script src="/app.js"></script>
```

- [ ] **Step 2: Confirm `offline.py` serves these static files**

Run: `rg -n "static|StaticFiles|/app.js|app\.js|FileResponse" offline/offline.py`
Expected: confirm the static dir is mounted (e.g. `app.mount("/", StaticFiles(directory=...))` or per-file routes). If static files are served by a catch-all/`StaticFiles` mount of `offline/static/`, no `offline.py` change is needed and the new files are served automatically. If individual routes exist per file, add routes for `events.js`/`job.js`/`sync.js` mirroring the `app.js` route. Record which case applies in the commit message.

- [ ] **Step 3: Commit**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add offline/static/index.html
git commit -m "build(offline): load events.js/job.js/sync.js before app.js"
```

(If `offline.py` needed new routes in Step 2, stage and mention it in the same commit.)

---

### Task 4: `sync.js` — debounced serial sync coordinator

**Files:**
- Create: `offline/static/sync.js`

**Interfaces:**
- Consumes: `Job.debounce` (Task 1), `Events.emit` (Task 2), `navigator.onLine`. Syncers registered at runtime by `app.js` (Task 5+): each `{ run: async () => boolean, synced: "<domain>:synced", changed: "<domain>:changed" }`.
- Produces:
  - `Sync.register(domain, syncer)` — register a domain syncer.
  - `Sync.request(domain)` — request a sync of `"favorites"`, `"listens"`, or `"all"`. No-op when offline. Debounced ~750ms; collects domains in a `Set`; on fire, snapshots+clears the set and runs each requested syncer serially. `"all"` expands to all registered domains. After each syncer: emit `<domain>:synced {changed}`; if `changed`, emit `<domain>:changed {reason:"server-reconcile"}`.

- [ ] **Step 1: Write the implementation**

Create `offline/static/sync.js` (exact shape from the spec; the 750ms debounce gives the follow-up-pass guarantee via `Job.debounce`):

```js
const Sync = (() => {
  const syncers = {};
  const requested = new Set();

  const schedule = Job.debounce(async () => {
    if (!navigator.onLine) return;

    const domains = requested.has("all") ? Object.keys(syncers) : [...requested];
    requested.clear();

    for (const domain of domains) {
      const syncer = syncers[domain];
      if (!syncer) continue;
      const changed = await syncer.run();
      Events.emit(syncer.synced, { changed });
      if (changed) Events.emit(syncer.changed, { reason: "server-reconcile" });
    }
  }, 750);

  function register(domain, syncer) {
    syncers[domain] = syncer;
  }

  function request(domain) {
    if (!navigator.onLine) return;
    requested.add(domain);
    schedule();
  }

  return { register, request };
})();
```

- [ ] **Step 2: Verify it parses**

Run: `node --check offline/static/sync.js`
Expected: no output (valid).

- [ ] **Step 3: Commit**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add offline/static/sync.js
git commit -m "feat(offline): add Sync coordinator (debounced serial domain sync)

Collects requested domains in a Set, debounces ~750ms via Job.debounce, runs each
registered syncer serially, and emits <domain>:synced{changed} plus
<domain>:changed{reason:server-reconcile} when a syncer changed IndexedDB. Offline
requests are ignored; network:online re-requests 'all'."
```

---

### Task 5: Syncers return `changed`; add `isLocalIntent` + event scaffolding

This task makes `syncFavorites`/`reconcileFavorites`/`syncListens`/`reconcileListens`/`pruneListened` return a `changed` boolean (consumed by `Sync`), and adds the `isLocalIntent` predicate. No event subscribers yet — those land in Tasks 6–8 so each task stays independently reviewable. After this task the old direct call sites still work (they ignore the new return value).

**Files:**
- Modify: `offline/static/app.js` — `syncFavorites` (1079), `reconcileFavorites` (1108), `pruneListened` (1160), `recordListen` (1156 call), `syncListens` (1173), `reconcileListens` (1190); add `isLocalIntent` near top.
- Test: extend `/tmp/opencode/job-test/` is not suitable; these touch IndexedDB. Verify via `node --check` + the Task 8 smoke. (Return-value logic is exercised by the manual checklist confirming "re-render only if data changed".)

**Interfaces:**
- Consumes: existing `DB`, `Api`.
- Produces:
  - `isLocalIntent(reason) -> boolean` — true for `local-add`, `local-remove`, `comment-edit`, `exported`, `local-record`, `local-record-pruned`; false otherwise (incl. `server-reconcile`, `line-order-learned`).
  - `syncFavorites() -> Promise<boolean>`, `reconcileFavorites(serverByKey) -> Promise<boolean>`, `syncListens() -> Promise<boolean>`, `reconcileListens(serverByFile) -> Promise<boolean>`, `pruneListened() -> Promise<boolean>`.

- [ ] **Step 1: Add `isLocalIntent`**

Add near the top-level constants (e.g. just after `const LISTENS_LIMIT = 10;`, app.js:43):

```js
const SYNC_TRIGGERING_REASONS = new Set([
  "local-add", "local-remove", "comment-edit", "exported",
  "local-record", "local-record-pruned",
]);
function isLocalIntent(reason) { return SYNC_TRIGGERING_REASONS.has(reason); }
```

- [ ] **Step 2: Make `pruneListened` return whether it deleted**

Replace `pruneListened` (app.js:1160-1165):

```js
async function pruneListened() {
  const rows = await DB.all("listened");
  if (rows.length <= LISTENS_LIMIT) return false;
  rows.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  for (const r of rows.slice(LISTENS_LIMIT)) await DB.del("listened", r.id);
  return true;
}
```

- [ ] **Step 3: Make `reconcileFavorites` return `changed`**

Replace `reconcileFavorites` body (app.js:1108-1137) to track a `changed` flag on every IndexedDB write and return it:

```js
async function reconcileFavorites(serverByKey) {
  const locals = await DB.all("favorites");
  const localById = {};
  for (const f of locals) localById[f.id] = f;
  let changed = false;

  for (const key of Object.keys(serverByKey)) {
    const s = serverByKey[key];
    const local = localById[key];
    if (!local) {
      await DB.put("favorites", {
        id: key, filename: s.filename, start: s.start, end: s.end || "",
        text: s.text || "", comment: s.comment || "", status: "synced",
        updatedAt: s.updated_at || new Date().toISOString(),
        exported_at: s.exported_at || null,
      });
      changed = true;
    } else if (local.status === "synced") {
      local.text = s.text || "";
      local.end = s.end || "";
      local.comment = s.comment || "";
      local.exported_at = s.exported_at || null;
      await DB.put("favorites", local);
      changed = true;
    }
  }
  for (const f of locals) {
    if (f.status === "synced" && !serverByKey[f.id]) {
      await DB.del("favorites", f.id);
      changed = true;
    }
  }
  return changed;
}
```

- [ ] **Step 4: Make `syncFavorites` return `changed`**

Replace `syncFavorites` (app.js:1079-1104) so phase-1 flush successes count as changes and it returns `reconcileFavorites`'s result OR'd in. Return `false` on the offline/early-return and malformed-payload paths:

```js
async function syncFavorites() {
  if (!navigator.onLine) return false;
  let changed = false;
  for (const f of await DB.all("favorites")) {
    try {
      if (f.status === "pending") {
        const r = await Api.favAdd(f);
        if (r.ok) { f.status = "synced"; await DB.put("favorites", f); changed = true; }
      } else if (f.status === "deleted") {
        const r = await Api.favDel(f.filename, f.start);
        if (r.ok || r.status === 404) { await DB.del("favorites", f.id); changed = true; }
      }
    } catch (e) { /* stay queued */ }
  }
  let data;
  try { data = await Api.favList(); } catch (e) { return changed; }
  if (!data || !Array.isArray(data.results)) return changed;
  const serverByKey = {};
  for (const s of data.results) serverByKey[s.filename + "|" + s.start] = s;
  const reconciled = await reconcileFavorites(serverByKey);
  return changed || reconciled;
}
```

- [ ] **Step 5: Make `reconcileListens` return `changed` and stop calling `updateRecentCount`**

Replace `reconcileListens` (app.js:1190-1211). Track writes; OR in `pruneListened`'s result; **remove** the direct `updateRecentCount()` (subscribers handle counts in Task 7):

```js
async function reconcileListens(serverByFile) {
  const locals = await DB.all("listened");
  const localById = {};
  for (const r of locals) localById[r.id] = r;
  let changed = false;
  for (const filename of Object.keys(serverByFile)) {
    const s = serverByFile[filename];
    const local = localById[filename];
    if (!local) {
      await DB.put("listened", {
        id: filename, filename, position: s.position,
        updated_at: s.updated_at, status: "synced",
      });
      changed = true;
    } else if (s.updated_at > local.updated_at) {
      local.position = s.position;
      local.updated_at = s.updated_at;
      local.status = "synced";
      await DB.put("listened", local);
      changed = true;
    }
  }
  const pruned = await pruneListened();
  return changed || pruned;
}
```

- [ ] **Step 6: Make `syncListens` return `changed`**

Replace `syncListens` (app.js:1173-1188):

```js
async function syncListens() {
  if (!navigator.onLine) return false;
  let changed = false;
  for (const r of await DB.all("listened")) {
    if (r.status !== "pending") continue;
    try {
      const res = await Api.listenPut(r.filename, r.position);
      if (res.ok) { r.status = "synced"; await DB.put("listened", r); changed = true; }
    } catch (e) { /* stay pending; retried later */ }
  }
  let data;
  try { data = await Api.listenList(); } catch (e) { return changed; }
  if (!data || !Array.isArray(data.results)) return changed;
  const serverByFile = {};
  for (const s of data.results) serverByFile[s.filename] = s;
  const reconciled = await reconcileListens(serverByFile);
  return changed || reconciled;
}
```

- [ ] **Step 7: Keep `recordListen` working for now**

`reconcileListens` no longer calls `updateRecentCount`, but `recordListen` still does (app.js:1157) and the Recent tab/boot still call `renderListened`/`updateRecentCount` directly. Leave `recordListen` calling `updateRecentCount()` for now; Task 7 replaces it with an emit. Do not change `recordListen` in this task. (This keeps the count correct between tasks.)

- [ ] **Step 8: Verify it parses**

Run: `node --check offline/static/app.js`
Expected: no output (valid).

- [ ] **Step 9: Commit**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add offline/static/app.js
git commit -m "refactor(offline): syncers/reconcilers return changed; add isLocalIntent

syncFavorites/reconcileFavorites/syncListens/reconcileListens/pruneListened now
return a boolean for whether they changed IndexedDB (consumed by the Sync
coordinator). reconcileListens no longer pokes updateRecentCount directly. Adds
isLocalIntent() allowlist. No behavior change yet; callers ignore the return."
```

---

### Task 6: Favorites — scheduled jobs, subscribers, and mutation emits

Wire the favorites domain end-to-end through events. After this task, favorite mutations emit `favorites:changed` and the subscriber drives status/marks/render/prefetch + debounced sync; the favorites tab handler and `refineFavOrder` use the new path.

**Files:**
- Modify: `offline/static/app.js` — add scheduled-job consts + subscribers (after the underlying functions are defined; place the block near the other top-of-file wiring but AFTER `updateStatus`, `renderMarks`, `renderFav`, `prefetchClips`, `syncFavorites` are declared — function declarations hoist, but the `Job.coalesce(...)` consts run at load time, so put them after `el`/`Job` exist, e.g. right after `updateStatus` at app.js:89, which is below all needed declarations except `renderFav`/`renderMarks`/`prefetchClips`/`refineFavOrder` which are function declarations and hoist). Convert `toggleFavorite` (627), `saveComment` (594), comment `cancel` (614), export-mark path (1027/1061/1076 are visible-view renders — see Step 6), `refineFavOrder` (729) usage at line 69, and the `el.navFav.onclick` handler (64).

**Interfaces:**
- Consumes: `Events`, `Job`, `Sync`, `isLocalIntent`, existing `updateStatus`/`renderMarks`/`renderFav`/`prefetchClips`/`syncFavorites`/`refineFavOrder`, `el.viewFav`, `navigator.onLine`.
- Produces:
  - `scheduleFavoriteStatus()` (coalesced `updateStatus`)
  - `scheduleFavoriteMarks()` (coalesced; no-op when `!tl`)
  - `scheduleRenderFav()` (coalesced; no-op when `el.viewFav.hidden`)
  - `schedulePrefetchClips()` (debounced 2000ms; no-op offline)
  - emits `favorites:changed {reason, ids}` from mutations and `refineFavOrder`.

- [ ] **Step 1: Add favorites scheduled jobs**

Insert after `updateStatus` (app.js, immediately following its closing brace at line 89, before the `window.addEventListener("online", ...)` block which Task 8 will replace):

```js
const scheduleFavoriteStatus = Job.coalesce(updateStatus);
const scheduleFavoriteMarks = Job.coalesce(async () => { if (tl) renderMarks(); });
const scheduleRenderFav = Job.coalesce(async () => {
  if (el.viewFav.hidden) return;
  await renderFav();
});
const schedulePrefetchClips = Job.debounce(async () => {
  if (!navigator.onLine) return;
  await prefetchClips();
}, 2000);
```

- [ ] **Step 2: Add favorites subscribers**

Immediately below the scheduled-job consts:

```js
Events.on("favorites:changed", (detail) => {
  scheduleFavoriteStatus();
  scheduleFavoriteMarks();
  scheduleRenderFav();
  schedulePrefetchClips();
  if (isLocalIntent(detail.reason)) Sync.request("favorites");
});

Events.on("favorites:synced", () => {
  scheduleFavoriteStatus();
  scheduleRenderFav();
  schedulePrefetchClips();
});
```

- [ ] **Step 3: Convert `toggleFavorite` to emit**

Replace `toggleFavorite` (app.js:627-653). Keep the synchronous star flip; replace the `updateStatus(); renderMarks(); if (online) syncFavorites().then(...)` tail with a single emit carrying `local-add`/`local-remove`:

```js
async function toggleFavorite(ln, star) {
  const startStr = ln.startStr || ln.start;
  const endStr = ln.endStr || ln.end;
  const id = ln.vtt + "|" + startStr;
  const existing = await DB.get("favorites", id);
  let active;
  if (!existing) {
    await DB.put("favorites", {
      id, filename: ln.vtt, start: startStr, end: endStr, text: ln.text,
      comment: "", status: "pending", updatedAt: new Date().toISOString(),
    });
    active = true;
  } else if (existing.status === "synced") {
    existing.status = "deleted";
    existing.updatedAt = new Date().toISOString();
    await DB.put("favorites", existing);
    active = false;
  } else {
    await DB.del("favorites", id);
    active = false;
  }
  if (star) star.textContent = active ? "★" : "☆";
  Events.emit("favorites:changed", {
    reason: active ? "local-add" : "local-remove",
    ids: [id],
  });
}
```

- [ ] **Step 4: Convert `saveComment` to emit**

Replace the tail of `saveComment` (app.js:602-605). Keep the `updatedAt`-preservation comment and `status="pending"`; replace `renderFav(); if (online) syncFavorites().then(updateStatus)` with an emit (`comment-edit`):

```js
  await DB.put("favorites", fav);
  Events.emit("favorites:changed", { reason: "comment-edit", ids: [fav.id] });
}
```

(Keep lines 595-601 unchanged: the early-returns, `normalizeComment`, the no-op `(fav.comment||"")===next` guard, setting `fav.comment`/`fav.status`, and the why-comment about not bumping `updatedAt`.)

- [ ] **Step 5: Make the comment editor `cancel` re-render via the scheduled job**

In `openCommentEditor`, the `cancel` closure (app.js:614) currently calls `renderFav()` to discard the textarea. Change it to `scheduleRenderFav()` so it goes through the coalesced path (the Favorites view is visible here, so it will render):

```js
  const cancel = () => { if (done) return; done = true; scheduleRenderFav(); };
```

(Leave `commit` calling `saveComment(group, ta.value)` unchanged — `saveComment` now emits, which schedules the render.)

- [ ] **Step 6: Route `refineFavOrder`'s learned-order through an emit**

At the favorites tab handler (app.js:64-73), `refineFavOrder().then((learned) => { if (learned) renderFav(); })` becomes an emit with `line-order-learned` (UI-only, no sync). Rewrite the whole handler to the post-refactor shape (uses scheduled jobs + `Sync.request`):

```js
el.navFav.onclick = () => {
  showView("fav");
  scheduleRenderFav();
  Sync.request("favorites");
  schedulePrefetchClips();
  if (navigator.onLine) {
    refineFavOrder().then((learned) => {
      if (learned) Events.emit("favorites:changed", { reason: "line-order-learned" });
    });
  }
};
```

Note: `Sync.request("favorites")` debounces and, on completion, emits `favorites:synced` (re-render + prefetch) and — if it changed data — `favorites:changed {reason:"server-reconcile"}`. So the old `syncFavorites().then(() => { renderFav(); prefetchClips(); })` fan-out (lines 67-68) is fully replaced. The old `else { prefetchClips(); }` offline branch is replaced by the unconditional `schedulePrefetchClips()` (which no-ops offline).

- [ ] **Step 7: Leave the export-mark and sort-toggle renders as direct `renderFav()`**

Do **not** change the `renderFav()` calls at app.js:798 (sort toggle), 1027, 1061, 1076 (export flows). These are synchronous user actions on the already-visible Favorites view; calling `renderFav()` directly is correct and keeps export ordering deterministic. (Converting them to events is out of scope and would add latency to a visible click.)

Do **not** add an `exported` emit. The export path already pushes the mark to the server: `exportGroup` (app.js:1035) calls `Api.markExported(f.filename, f.start)` → `POST /api/exported` (api.js:56) and stamps `exported_at` locally — no extra sync is needed. (`"exported"` remains in the `isLocalIntent` allowlist as harmless future-proofing per the spec; nothing emits it in this pass.)

- [ ] **Step 8: Verify it parses**

Run: `node --check offline/static/app.js`
Expected: no output (valid).

- [ ] **Step 9: Commit**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add offline/static/app.js
git commit -m "refactor(offline): favorites via events (mutations emit, subscriber fans out)

toggleFavorite/saveComment/refineFavOrder emit favorites:changed instead of
calling updateStatus/renderMarks/renderFav/syncFavorites directly. Subscriber
coalesces status/marks/render + debounced prefetch, and requests a debounced
favorites sync only for local-intent reasons (server-reconcile/line-order-learned
never loop). Star flip stays synchronous; visible export/sort renders stay direct.
Favorites tab handler now uses scheduleRenderFav + Sync.request('favorites')."
```

---

### Task 7: Listens — scheduled jobs, subscribers, and `recordListen` emit

Wire the listens domain through events. `recordListen` emits instead of poking the count; the Recent tab handler uses the new path.

**Files:**
- Modify: `offline/static/app.js` — add listens scheduled jobs + subscribers (place right after the favorites block from Task 6); convert `recordListen` (1144), and the `el.navRecent.onclick` handler (75).

**Interfaces:**
- Consumes: `Events`, `Job`, `Sync`, `isLocalIntent`, `updateRecentCount`, `renderListened`, `el.viewRecent`, existing `recordListen` internals (`pruneListened` now returns bool).
- Produces:
  - `scheduleRecentCount()` (coalesced `updateRecentCount`)
  - `scheduleRenderRecent()` (coalesced; no-op when `el.viewRecent.hidden`)
  - `recordListen` emits `listens:changed {reason: pruned ? "local-record-pruned" : "local-record", ids:[filename]}`.

- [ ] **Step 1: Add listens scheduled jobs + subscribers**

Insert after the favorites subscribers (Task 6 Step 2 block):

```js
const scheduleRecentCount = Job.coalesce(updateRecentCount);
const scheduleRenderRecent = Job.coalesce(async () => {
  if (el.viewRecent.hidden) return;
  await renderListened();
});

Events.on("listens:changed", (detail) => {
  scheduleRecentCount();
  scheduleRenderRecent();
  if (isLocalIntent(detail.reason)) Sync.request("listens");
});

Events.on("listens:synced", () => {
  scheduleRecentCount();
  scheduleRenderRecent();
});
```

- [ ] **Step 2: Convert `recordListen` to emit**

Replace the tail of `recordListen` (app.js:1155-1158). Capture `pruneListened`'s boolean and emit instead of calling `updateRecentCount()`:

```js
  await DB.put("listened", rec);
  const pruned = await pruneListened();
  Events.emit("listens:changed", {
    reason: pruned ? "local-record-pruned" : "local-record",
    ids: [filename],
  });
}
```

- [ ] **Step 3: Convert the Recent tab handler**

Replace `el.navRecent.onclick` (app.js:75-79):

```js
el.navRecent.onclick = () => {
  showView("recent");
  scheduleRenderRecent();
  Sync.request("listens");
};
```

(The old `if (navigator.onLine) syncListens().then(renderListened)` is replaced: `Sync.request("listens")` no-ops offline and, on completion, emits `listens:synced` → re-render if visible.)

- [ ] **Step 4: Verify it parses**

Run: `node --check offline/static/app.js`
Expected: no output (valid).

- [ ] **Step 5: Commit**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add offline/static/app.js
git commit -m "refactor(offline): listens via events; sync playback position every ~5s

recordListen emits listens:changed instead of calling updateRecentCount; the
subscriber updates count/render and requests a debounced listen sync (local-record
is local-intent). This intentionally drops the lazy-upload asymmetry: the 5s
recordListen tick now pushes the resume position promptly. Recent tab handler uses
scheduleRenderRecent + Sync.request('listens')."
```

---

### Task 8: Network + play/pause + boot; register syncers; smoke render

Finish the wiring: network events, play/pause durable side-effects through `recordListen`, and `boot` registering syncers and requesting `"all"`. Then run the offline smoke render.

**Files:**
- Modify: `offline/static/app.js` — replace `window.addEventListener("online"/"offline")` (90-94), keep play/pause routing through `recordListen` (555-556, verify), rewrite `boot` (1282-1295). Remove now-unused `refreshRecentIfActive` (1277-1279) if nothing else references it.

**Interfaces:**
- Consumes: `Events`, `Sync`, scheduled jobs from Tasks 6–7, `syncFavorites`/`syncListens`, `recordListen`.
- Produces: `network:online`/`network:offline` emits + subscribers; `boot` registers both syncers and requests `"all"` when online.

- [ ] **Step 1: Replace online/offline listeners with emits + subscribers**

Replace app.js:90-94 (the `window.addEventListener("online", () => {...})` and `window.addEventListener("offline", updateStatus)` block):

```js
window.addEventListener("online", () => Events.emit("network:online"));
window.addEventListener("offline", () => Events.emit("network:offline"));

Events.on("network:online", () => {
  scheduleFavoriteStatus();
  scheduleRecentCount();
  Sync.request("all");
  schedulePrefetchClips();
});

Events.on("network:offline", () => {
  scheduleFavoriteStatus();
  scheduleRecentCount();
});
```

(Placement: these reference `scheduleFavoriteStatus`/`scheduleRecentCount`/`schedulePrefetchClips`, which are `const`s defined in Tasks 6–7 above this point. Ensure this block sits AFTER those consts. If the original online/offline block was above them, move it down to just after the listens subscribers.)

- [ ] **Step 2: Verify play/pause already route through `recordListen`**

Run: `rg -n 'addEventListener\("(play|pause)"' offline/static/app.js`
Expected: lines 555-556 call `recordListen({ force: true })`. These already emit `listens:changed` via Task 7. **No change needed.** (Per spec, do not add `player:play`/`player:pause` events — not needed for clarity here.)

- [ ] **Step 3: Remove `refreshRecentIfActive` if unused**

Run: `rg -n "refreshRecentIfActive" offline/static/app.js`
After Task 7 replaced its only caller (the old `online` handler at line 92, now gone), it should have zero callers. If so, delete its definition (app.js:1277-1279). If `rg` shows any remaining caller, leave it.

- [ ] **Step 4: Rewrite `boot`**

Replace `boot` (app.js:1282-1295). Register syncers, kick the count/status jobs, start the 5s timer, request `"all"` when online, prefetch, render Find:

```js
(async function boot() {
  Sync.register("favorites", {
    run: syncFavorites, synced: "favorites:synced", changed: "favorites:changed",
  });
  Sync.register("listens", {
    run: syncListens, synced: "listens:synced", changed: "listens:changed",
  });

  scheduleFavoriteStatus();
  scheduleRecentCount();
  setInterval(recordListen, 5000);

  if (navigator.onLine) Sync.request("all");

  schedulePrefetchClips();
  renderFind();
  showView("find");
})();
```

(`Sync.request("all")` debounces ~750ms then runs both syncers, emitting `*:synced`/`*:changed` which drive the count/render jobs. The initial `scheduleFavoriteStatus()`/`scheduleRecentCount()` paint badges immediately from local data before sync completes.)

- [ ] **Step 5: Full parse check across all touched files**

Run:
```bash
node --check offline/static/events.js
node --check offline/static/job.js
node --check offline/static/sync.js
node --check offline/static/app.js
```
Expected: no output for each (all valid).

- [ ] **Step 6: Smoke render the offline app (HTTP, spare port, kill by PID)**

Per `AGENTS.md`/repo workflow. Start a throwaway uttale on 7011 and the offline app on 7023 pointing at it, poll for HTTP 200, fetch the new JS files, then kill by saved PID. Run from a scratch dir.

```bash
# uttale backend (HTTP, no --ssl) on 7011 — needs PYTHONPATH; temp DBs in /tmp/opencode
cd /home/bz/share/btsync/prg/srst-uttale
PYTHONPATH=/home/bz/share/btsync/prg/srst-uttale \
  /tmp/opencode/uttale-test/bin/python -m uttale.backend.server \
  --iface 127.0.0.1:7011 \
  --db /tmp/opencode/smoke-utt.db \
  --favorites-db /tmp/opencode/smoke-fav.db &
echo $! > /tmp/opencode/utt.pid

# offline app (http) on 7023, proxying the 7011 backend
cd /mnt/payload/share/msi/prg/srst-harken
.venv/bin/python offline/offline.py --uttale http://127.0.0.1:7011 --host 127.0.0.1 --port 7023 &
echo $! > /tmp/opencode/off.pid

# poll
for i in $(seq 1 30); do
  curl -fsS -o /dev/null "http://127.0.0.1:7023/" && break
  sleep 0.5
done
```

Then verify the app shell and new modules are served 200 and parse-load in order:

```bash
for f in / /events.js /job.js /sync.js /app.js /index.html; do
  printf '%s -> ' "$f"; curl -fsS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:7023$f";
done
# Confirm index.html lists the new scripts before app.js:
curl -fsS "http://127.0.0.1:7023/index.html" | rg -n "events.js|job.js|sync.js|app.js"
```

Expected: every path returns `200`; the script order shows `events.js`, `job.js`, `sync.js` before `app.js`.

- [ ] **Step 7: Tear down the smoke servers (kill by saved PID, never bare pkill)**

```bash
kill "$(cat /tmp/opencode/off.pid)" 2>/dev/null; rm -f /tmp/opencode/off.pid
kill "$(cat /tmp/opencode/utt.pid)" 2>/dev/null; rm -f /tmp/opencode/utt.pid
rm -f /tmp/opencode/smoke-utt.db /tmp/opencode/smoke-fav.db
```

- [ ] **Step 8: Commit**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add offline/static/app.js
git commit -m "refactor(offline): network/boot via events; register syncers in boot

online/offline now emit network:* events; subscribers repaint badges offline and
Sync.request('all') online. boot registers both domain syncers, paints local
badges immediately, starts the 5s listen timer, and requests 'all' when online.
Removed unused refreshRecentIfActive. Play/pause already route durable state
through recordListen. Smoke render on :7023 served all modules 200."
```

---

### Task 9: Update `docs/sync-model.md` to match new behavior

The refactor changes two documented facts: listens now upload promptly (every ~5s tick), and fan-out is event-driven. Keep the reference doc truthful.

**Files:**
- Modify: `docs/sync-model.md` — the "listened … uploads lazily" section, the "Notable asymmetries" #1, and the event-taxonomy "Per-edit"/timer bullets.

**Interfaces:** docs only.

- [ ] **Step 1: Update the listened sync-up description**

In `docs/sync-model.md`, the `### listened (resume position) — persists often, uploads lazily` section currently says `recordListen` does NOT upload after writing and positions upload only on boot/online/Recent. Replace that "key asymmetry" paragraph to state that, since the events/sync refactor, `recordListen` emits `listens:changed` which requests a debounced listen sync, so the 5s tick (and play/pause) now upload the resume position promptly; boot/`network:online`/Recent still also sync. Rename the heading from "uploads lazily" to "uploads promptly (debounced)".

- [ ] **Step 2: Update "Notable asymmetries" #1**

The bullet "Favorites push on edit; listens don't" is no longer true. Replace it: both favorites and listens now push on local change (favorites immediately on edit via `favorites:changed`; listens on each 5s tick / play / pause via `listens:changed`), both debounced through `Sync.request`. Remove the asymmetry framing.

- [ ] **Step 3: Update the event-taxonomy bullets**

Update the "Per-edit", "Timer", and "Audio events" bullets to reflect that mutations now emit domain events (`favorites:changed`/`listens:changed`) that drive coalesced UI jobs + debounced `Sync.request`, rather than calling `updateStatus`/`renderMarks`/`syncFavorites` directly. Add a one-line note that fan-out is centralized in `events.js`/`job.js`/`sync.js`. Keep the `file:line` style but mark line numbers approximate (the file just changed substantially).

- [ ] **Step 4: Commit**

```bash
cd /mnt/payload/share/msi/prg/srst-harken
git add docs/sync-model.md
git commit -m "docs(offline): sync-model reflects event-driven fan-out + 5s listen push

Listened resume positions now upload promptly (debounced) on each 5s tick/play/
pause rather than lazily; favorites/listens fan-out is centralized through
Events/Job/Sync. Updated the asymmetry and event-taxonomy sections."
```

---

## Manual browser checklist (post-implementation, user-run)

Automated DOM/browser testing is out of scope per `AGENTS.md`; these are for the user (or a later interactive session) to verify in a real browser against the running app:

- **Add a favorite:** star flips ★ immediately; Favorites badge increments; scrubber mark appears; if Favorites tab visible it re-renders; exactly one debounced favorite sync fires when online (check Network panel).
- **Remove a favorite:** star flips ☆; badge/marks update; tombstone delete syncs (synced→deleted→server DELETE).
- **Edit a favorite comment:** Favorites tab updates; favorite does NOT change position (updatedAt preserved); one debounced sync; clearing+blur deletes the comment.
- **Open Favorites:** local render is immediate; sync + clip prefetch happen in the background; line-order refinement re-renders without firing a sync.
- **Play/pause + 5s interval:** Recent badge updates; if Recent visible it re-renders; a debounced listen sync fires (positions reach the server promptly).
- **Open Recent:** local render immediate; listen sync in background; re-render only when data changed.
- **Toggle offline → online:** offline only repaints badges (no sync attempts); online fires `Sync.request("all")` and refreshes both domains once (with one follow-up pass if you mutate during the in-flight sync).
- **Rapid repeated toggles/comment edits:** confirm (Network panel or temporary `console.log` in `Sync.request`) they coalesce into one sync pass plus at most one follow-up pass.

---

## Out of scope

- Generic keyed `Scheduler.schedule` / `Jobs.schedule`.
- Framework/reactivity libraries; cross-tab event propagation; service-worker-driven sync.
- Rewriting IndexedDB storage or the local-first data model; `db.js` `VERSION` bump.
- Refactoring high-frequency audio `timeupdate` into app events.
- Adding `player:play`/`player:pause` events (durable side effects already go through `recordListen`).
