# Offline PWA — data persistence & sync model

A reference map of how every kind of client data is **persisted** (written to
IndexedDB, survives reload, works offline) and **synced** (sent to / pulled from
the uttale backend), and on which events each happens.

"Persisted" and "synced" are separate steps with separate triggers. Of the six
IndexedDB stores, **only two (`favorites`, `listened`) sync to the server**; the
other four are local-only caches.

All citations are `file:line` into `offline/static/*` (`app.js`, `api.js`,
`db.js`, `sw.js`) and `offline/offline.py` (`py`), as of this writing — treat
line numbers as approximate if the files have since changed.

## IndexedDB stores

Database `srst-offline`, `VERSION = 4` (`db.js:2-3`). One additive
`onupgradeneeded` creates any missing store (`db.js:10-18`); there is no
data migration. The SW cache key `srst-offline-v4` (`sw.js:1`) is an independent
version number.

| Store | keyPath | Holds | Synced? |
|---|---|---|---|
| `episodes` | `key` | downloaded-episode metadata: podcast, date, ordered `segments[]`, `cachedAt`, cached `topics` | No (local cache; `topics` refreshed down only) |
| `segments` | `vtt` | one VTT segment's `lines[]` + audio `Blob` | No (local cache) |
| `favorites` | `id` = `filename\|start` | starred lines: text, comment, status, timestamps, exported_at | **Yes — both ways** |
| `listened` | `id` = `filename` | per-file playback resume position | **Yes — both ways** |
| `clips` | `id` = `filename\|start\|end` | cached favorite-clip audio `Blob` | No (local cache) |
| `lineorder` | `filename` | per-file ordered line-start list (maps (filename,start)→index for grouping) | No (local derived cache) |

## The two synced types

### favorites — pushes immediately

* **Persist (IndexedDB):** the instant you act — star/unstar a line
  (`toggleFavorite`, `app.js:636/644/647`), edit a comment (textarea **blur** or
  Ctrl/Cmd+Enter → `saveComment`, `app.js:602`), delete (`deleteGroup` →
  `toggleFavorite`), or send/export (stamps `exported_at`, `app.js:1048-1053`).
  No timer, no debounce.
* **Dirty queue:** the `status` field — `pending` (new/edited, not yet acked),
  `deleted` (tombstone awaiting server DELETE), `synced`.
* **Sync up:** `syncFavorites` phase 1 (`app.js:1081-1092`) walks all favorites;
  `pending` → `Api.favAdd` → `POST /api/favorite` → `POST /uttale/Favorites`
  (upsert); `deleted` → `Api.favDel` → `DELETE /uttale/Favorites`. On success a
  `pending` flips to `synced` (`app.js:1086`); a `deleted` tombstone is removed.
* **Sync up fires on:** ① app boot (`app.js:1287`), ② the browser `online` event
  (`app.js:90-91`), ③ opening the **Favorites tab** (`app.js:64-72`), and
  ④ **immediately after every favorite edit** if online (`toggleFavorite`
  `app.js:652`, `saveComment` `app.js:604`). So favorites reach the server right
  away.
* **Sync down:** the same `syncFavorites` call then pulls `GET /uttale/Favorites`
  and reconciles (`reconcileFavorites`, `app.js:1106-1136`).
* **Conflict rule — status-based / local-intent-wins:** unflushed
  `pending`/`deleted` always beat the server; once `synced`, the server is
  authoritative for content (text/end/comment/exported_at copied down); a
  `synced` row the server no longer has is deleted locally. A malformed/empty
  server payload aborts reconcile (`app.js:1098`) so it can never wipe the local
  mirror.

### listened (resume position) — persists often, uploads lazily

* **Persist (IndexedDB):** captured **every 5 seconds while audio is playing**
  (`setInterval(recordListen, 5000)`, `app.js:1285`; the callback early-returns
  unless playing, `app.js:1147`), **plus** forced **on `play`** (`app.js:555`)
  and **on `pause`** (`app.js:556`). NOT on `timeupdate`, NOT on `ended`. Only
  the 10 most-recent files are kept (`pruneListened`, `LISTENS_LIMIT = 10`). The
  saved position is episode-absolute time (`offset + currentTime`), VTT-formatted
  (`app.js:1150-1152`).
* **Sync up — the key asymmetry:** `recordListen` does **NOT** upload after
  writing. Positions sit locally as `status:"pending"` and upload only on ① app
  boot (`app.js:1289`), ② the `online` event (`app.js:92`), or ③ opening the
  **Recent Listens tab** (`app.js:75-79`). So "where you left off" can lag the
  server until you visit Recent or restart. (`syncListens` phase 1,
  `app.js:1175-1181`: `pending` → `Api.listenPut` → `POST /uttale/Listens`.)
* **Sync down:** the same `syncListens` call pulls `GET /uttale/Listens` and
  reconciles (`reconcileListens`, `app.js:1190-1211`).
* **Conflict rule — timestamp last-write-wins:** newest `updated_at` wins
  (`app.js:1202`); local listens are never deleted by reconcile (no tombstones).

## The four local-only caches

None of these ever upload, and none have a server reconcile. They populate from
the server only on demand, and are treated as immutable once cached.

* **episodes / segments** — written on **download** (`downloadEpisode`,
  `app.js:266/269`); deleted on **delete-episode** or full reset. Transcript
  lines and audio are fetched once and never re-pulled. Exception:
  `episodes.topics` is refreshed *down* from the server every time you open an
  episode online (`loadTopics`, `app.js:381-382`) — the only server-driven field
  in an otherwise local-only store.
* **clips** — cached favorite-clip audio, fetched lazily on first ▶
  (`getClip`, `app.js:948-950`) or batch-prefetched (`prefetchClips`) at boot and
  on opening Favorites. Pruning of stale clips is **online-only** (offline it is
  a pure no-op that never deletes, `app.js:997/1013`), so going offline can't
  lose prefetched clips.
* **lineorder** — derived per-file index used to group adjacent favorites into
  one clip whose span matches both playback and the Telegram export. Fetched at
  most once per file (`orderForFile`, `app.js:673-696`); refined on opening
  Favorites online (`refineFavOrder`, `app.js:729-742`).

## Event taxonomy (what kicks what)

* **App boot** (`boot()`, `app.js:1282-1295`): sync favorites + listens (up &
  down), start the 5 s listen timer, prefetch clips.
* **Tab switches** (`app.js:62-79`):
  * **Find** → no sync (renders cached episodes; search box debounced 600 ms).
  * **Listen** → no sync, no write.
  * **Favorites** → full favorites sync (up & down) + clip prefetch + lineorder
    refine.
  * **Recent Listens** → full listens sync (up & down).
* **`online` event** (`app.js:90-93`) → catch-up flush of **both** favorites and
  listens.
* **`offline` event** (`app.js:94`) → nothing but repaint the badge.
* **Timer** → exactly one: `setInterval(recordListen, 5000)` (`app.js:1285`),
  local write only, no server call.
* **Audio events** → `play`/`pause` force-save listen position (local);
  `timeupdate`/`ended` persist nothing.
* **Per-edit** → star toggle, comment-edit blur, delete, export write favorites
  locally + immediate up-sync if online.
* **No `beforeunload` / `visibilitychange` / `pagehide` handler** → there is no
  flush-on-tab-close. Kill the tab mid-playback without pausing and only the last
  5 s tick survives locally, uploading on the next boot/online/Recent-visit.

## Notable asymmetries

1. **Favorites push on edit; listens don't.** Favorites up-sync immediately after
   a mutation; listen positions only upload on boot / `online` / Recent-tab.
2. **Comment edits do NOT bump `updatedAt`** (`app.js:602`), though they do set
   `status:"pending"`. `updatedAt` drives the "By added" sort
   (`groupUpdatedAt` desc, `app.js:898/915`), so editing a comment must not
   re-position the favorite. Star-add/unstar *do* bump `updatedAt`.
3. **Two conflict philosophies:** favorites = status-based/intent-wins (with
   tombstone-free server-delete propagation); listened = timestamp LWW (no
   deletion on reconcile).
4. **`/api/*` bypasses the service worker** (`sw.js:30-32`): all sync is always
   live network, never served stale; only the app shell is cached. Offline, every
   `Api.*` sync call fails fast and the `navigator.onLine` guards prevent attempts.
5. **The "unsynced" badge counts pending AND deleted** (`app.js:84`); the favorite
   *count* excludes `deleted` (`app.js:87`).
