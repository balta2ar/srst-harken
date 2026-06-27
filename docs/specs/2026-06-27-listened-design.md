# Listened / Recent Listens — design

Date: 2026-06-27
Repos: `srst-uttale` (backend API + separate SQLite store) and `srst-harken`
(`offline/` UI). Modeled on the existing **Favorites** feature; reuses its
local-first + sync patterns with deliberate differences noted below.

## Goal

Track and share, across all devices, the last position the user reached in each
podcast episode ("what I've listened to"). Everything is global (no user/device
id). Records are saved locally first (works offline) then synced to the uttale
server. A new "Recent Listens" tab lists episodes newest-first with podcast,
date, the in-episode position, and when the record was last updated; tapping
podcast/date searches, tapping the position resumes playback there.

## Key constant

`LISTENS_LIMIT = 10` (server module constant; client constant mirrors it). The
server keeps only the 10 most recent listens; the device also keeps only 10; the
view shows the merge of local+remote, also capped to 10. Changing the constant
later changes all three caps.

## Data model

One listen record **per episode**, keyed by the episode's **first-segment
filename** (the same key shape used by Audio/Topics; `episodeKeyOf`/`podcastOf`/
`dateOf` derive episode-key/podcast/date from it).

Server table `listens` (separate DB file, see below):

```
filename    TEXT PRIMARY KEY      -- first-segment vtt path
position    TEXT                  -- episode-absolute VTT string "HH:MM:SS.mmm"
updated_at  TEXT                  -- ISO timestamp (recency + conflict key)
```

Client IndexedDB store `listened` (keyPath `id`):

```
id          = filename            -- one per episode (id == filename)
filename    = first-segment vtt
position    = "HH:MM:SS.mmm"       -- episode-absolute VTT string
updated_at  = ISO string
status      = "pending" | "synced"  -- client-only; never sent to server
```

Differences from Favorites: one row per episode (not per line); `id == filename`
(no `|start`); no `end`/`text`/`comment`/`exported_at`/`created_at`; no
`deleted` tombstone (listens are never user-deleted; they age out via the cap),
so the sync state machine is just pending -> synced.

## Position format

Episode-absolute VTT string `HH:MM:SS.mmm`. Live position while playing is
`epNow = tl.segments[currentSeg].offset + el.player.currentTime` (seconds).
`Timeline.fmt` is lossy (`H:MM:SS`), so add a round-trippable helper
`Timeline.fmtVtt(seconds) -> "HH:MM:SS.mmm"` and export it: zero-pad hours,
minutes, seconds to 2 digits and the millisecond part to 3 (from the fractional
second, e.g. `4114.2 -> "01:08:34.200"`). Resume seeks via
`seekEp(Timeline.tsToSeconds(position))`.

## Backend (uttale `server.py`)

Separate database file, **not kept locked** (WAL + busy_timeout):

- CLI arg `--listens-db` (default `~/.cache/srst-uttale/listens.db`), resolved
  through `resolve_db_path` like `--favorites-db`. Helper `listens_db_path()`.
- `@contextmanager listens_db(db_path)`: `sqlite3.connect`, `row_factory=Row`,
  then `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout=5000`, then
  `CREATE TABLE IF NOT EXISTS listens (...)`; open/use/commit/close per request
  (mirrors `favorites_db`). WAL lets a reader and a writer proceed without
  blocking; busy_timeout retries instead of erroring on contention.
- `LISTENS_LIMIT = 10` module constant.
- Helpers:
  - `listens_list(db_path) -> list[dict]`: `SELECT * ... ORDER BY updated_at DESC
    LIMIT LISTENS_LIMIT`.
  - `listens_upsert(db_path, filename, position) -> dict`: `INSERT ... ON
    CONFLICT(filename) DO UPDATE SET position=excluded.position,
    updated_at=excluded.updated_at` with `updated_at = now_iso()`; then **prune
    to top-N**: delete all rows whose `filename NOT IN (SELECT filename ... ORDER
    BY updated_at DESC LIMIT LISTENS_LIMIT)`. Return the upserted row.
- Pydantic models: `Listen { filename, position, updated_at }`,
  `Listens { results_count: int = 0, results: list[Listen] = [] }`,
  `ListenAdd { filename: str, position: str }`.
- Endpoints (namespaced like Favorites):
  - `GET /uttale/Listens` -> `Listens` (newest first, <= LIMIT).
  - `POST /uttale/Listens` body `ListenAdd` -> `Listen` (upsert + prune). 422 on
    missing fields via pydantic; 500 on `sqlite3.Error`.
- No DELETE (listens age out via the cap). No change to favorites or DuckDB.

Server is the source of truth only for the shared top-10 exchange; conflict
resolution is last-write-wins by `updated_at` (the upsert always writes the
posted position with a fresh `updated_at`; clients adopt a newer server
`updated_at` on pull).

## Backend tests (`test_server.py::TestListens`, unittest + temp dirs)

- upsert inserts a row (returns filename/position/updated_at).
- upsert on same filename updates position + updated_at (one row, not two).
- list is newest-first by updated_at.
- prune keeps only LISTENS_LIMIT most recent (insert N+ and assert count ==
  LIMIT and the oldest are gone).
- WAL pragma active (a second connection can read while not blocked) — assert
  `PRAGMA journal_mode` returns `wal`.

## Frontend (`srst-harken/offline`)

### Storage / no migration

`DB.VERSION` bump (1 -> 2) and add `createObjectStore("listened", { keyPath:
"id" })` in `onupgradeneeded`. No migration: the new app is new and unused, so a
fresh DB (existing local data wiped on upgrade) is acceptable. `DB.reset()`
already clears it.

### Proxy (`offline.py`)

- `GET /api/listens` -> `_proxy_json("/uttale/Listens", {})`.
- `POST /api/listens` -> read JSON body, relay to `POST /uttale/Listens` (new
  sibling of the favorites POST relay using `urllib.request.Request(method=...)`;
  502 on URLError, relay upstream status otherwise).

### Client API (`api.js`)

- `listenList()` -> `GET /api/listens`, returns parsed JSON; throws on `!r.ok`
  (like `favList`, so a bad response never looks like "zero").
- `listenPut(filename, position)` -> `POST /api/listens` JSON `{filename,
  position}`, returns raw Response.

### Recording (every 5s while playing)

- `LISTENS_LIMIT = 10` client constant.
- `recordListen()`: if `tl` and audio is actually playing (`!el.player.paused &&
  !el.player.ended`), compute `epNow`, build record `{ id: filename, filename,
  position: Timeline.fmtVtt(epNow), updated_at: now, status: "pending" }` where
  `filename = tl.segments[0].vtt`; `DB.put("listened", rec)`; then
  `pruneListened()`. Update the Recent-tab badge count.
- `setInterval(recordListen, 5000)` started once at boot. The 5s save is
  local-only (marks `status:"pending"`); it does not hit the network.
- `pruneListened()`: load all, sort by `updated_at` desc, `DB.del` everything
  beyond `LISTENS_LIMIT`.

### Sync (tab open / online / boot) — merge-only, last-write-wins

`syncListens()` (mirrors `syncFavorites`, simpler):

1. If offline, return.
2. PUSH: for each local `status === "pending"`, `Api.listenPut(filename,
   position)`; on `r.ok` set `status = "synced"` and `DB.put`. On error, leave
   pending (retried later). (No deletes.)
3. PULL: `data = await Api.listenList()`; guard `Array.isArray(data.results)`
   (abort if malformed). For each server row keyed by `filename`:
   `reconcileListens(serverByFilename)`.

`reconcileListens(serverByFilename)` — **merge-only, never prunes by absence**:

- For each server row `s`: if no local row, insert `{ id:s.filename,
  filename:s.filename, position:s.position, updated_at:s.updated_at, status:
  "synced" }`. If a local row exists and `s.updated_at > local.updated_at`,
  adopt the server position/updated_at and set `status:"synced"` (last-write-
  wins). If local is newer or equal, leave it (it will be/has been pushed).
- Do NOT delete local rows just because they are absent from the server's
  capped list.
- After merging, `pruneListened()` so the device keeps only the top-10 of the
  merged set (server + local). View therefore equals the merged top-10.

Boot: call `syncListens()` beside `syncFavorites()` (when online); add
`syncListens` to the `online` event handler too.

### Boot sequence (explicit)

At startup, after the existing favorites boot steps, also:
`updateStatus()` already runs; start `setInterval(recordListen, 5000)` once; if
online, `syncListens().then(...)` (rendering only if the recent view is the
active one). The `online` event handler runs both `syncFavorites` and
`syncListens`. `recordListen` and `syncListens` are independent of the favorites
flow.

### View — "Recent Listens" tab

New 4th tab + section (the existing "Listen" tab is the transcript player; this
is a distinct history view, modeled on the Favorites view):

- `index.html`: add `<button id="nav-recent" class="tab" ...>` (history/replay
  icon) with a `<span id="recent-count" class="badge" hidden>`; add `<section
  id="view-recent" hidden></section>`.
- `showView` gains `recent`: toggles `#view-recent` and `#nav-recent.active`;
  ensure `nowplaying`/`transport` show only for `listen` (unchanged).
- `el.navRecent.onclick = () => { showView("recent"); renderListened(); if
  (navigator.onLine) syncListens().then(renderListened); }` (one-shot pull, like
  Favorites).
- `renderListened()` with the same coalescing guard pattern as `renderFav`
  (`_running`/`_again`) wrapping `_renderListened()`:
  - `_renderListened()` builds a DocumentFragment, loads all `listened`, sorts by
    `updated_at` desc (already <=10), and for each builds a `.listen` row:
    - clickable **position** `ts.className = "ts link"`, text =
      `Timeline.fmt(tsToSeconds(position))`, `onclick = () =>
      resumeListen(rec)` -> `jumpToListen` (open episode + `seekEp` + scroll;
      uncached -> `gotoFind`).
    - clickable **podcast** -> `gotoFind(podcastOf(filename))`.
    - clickable **date** -> `gotoFind(podcastOf + " " + dateOf)`.
    - meta showing date + "updated <relative/abs>" via a small formatter.
    - atomic swap `el.viewRecent.replaceChildren(frag)`.
  - empty -> a "Nothing yet" line.
- `jumpToListen(rec)`: `key = episodeKeyOf(rec.filename)`; if episode not cached
  -> `gotoFind(podcastOf + " " + dateOf)`; else `await openEpisode(key)`,
  `seekEp(Timeline.tsToSeconds(rec.position))` (resumes + plays), then scroll the
  active line into view. (Resume continues listening, consistent with "continue
  listening".)
- Badge: `updateStatus` (or `recordListen`/sync) sets `el.recentCount` to the
  local listened count, hidden when 0.

### Reset

`resetLocal` -> `DB.reset()` already drops the `listened` store; also re-render
the recent view if visible.

## Components (isolation)

- Backend: `listens_db`, `listens_list`, `listens_upsert` (pure DB helpers,
  temp-dir testable); endpoints are thin wrappers.
- Client: `recordListen`/`pruneListened` (local write only), `syncListens`/
  `reconcileListens` (network + merge, no DOM), `renderListened`/`_renderListened`
  (DOM only), `jumpToListen` (thin: open + seek). `Api.listenList`/`listenPut`
  pure fetch wrappers. `Timeline.fmtVtt` pure.

## Verification (AGENTS.md: no pytest)

Backend: `uv` unittest env, run `TestListens`; `py_compile`; live `curl -k`
round-trip of `POST/GET /uttale/Listens` against a throwaway temp `--listens-db`
(do NOT touch the real favorites DB or DuckDB); assert prune-to-10 and
newest-first live.

Frontend: `node --check` app.js/api.js; `py_compile offline.py`; fake-indexeddb
node harnesses extracting the REAL functions:
- `recordListen` upserts one record at the live position and `pruneListened`
  caps to 10.
- `syncListens` pushes pending (flips to synced on ok) and `reconcileListens`
  merges last-write-wins, never prunes by absence, then caps to 10.
- `_renderListened` builds rows with clickable podcast/date/position wired to
  `gotoFind`/`jumpToListen`; empty state.
Element-id cross-ref; `/api/listens` live smoke through the proxy; asset smoke.
Manual on-device checklist (user runs): play an episode -> after ~5s a Recent
Listens row appears; resume from another spot; cross-device sync shows last
position; offline still records and syncs on reconnect; only 10 kept.

## Out of scope (YAGNI)

- No per-line/segment listen history (one position per episode).
- No manual delete UI (age out via cap).
- No "listened %"/completion tracking, no unplayed badges on search results.
- No device/user identity.
