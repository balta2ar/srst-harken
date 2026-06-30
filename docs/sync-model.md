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
* **Sync up fires on:** ① app boot (`Sync.request("all")`, `app.js:1363`), ② the
  browser `online` event (`network:online` → `app.js:146`), ③ opening the
  **Favorites tab** (`Sync.request("favorites")`, `app.js:73`), and ④
  **immediately after every favorite edit** if online — each mutation emits
  `favorites:changed` (`toggleFavorite` `app.js:710`, `saveComment`
  `app.js:662`) and the subscriber requests a debounced `Sync.request("favorites")`
  (`app.js:114`). So favorites still reach the server right away (debounced
  ~750ms), now via the event/sync bus rather than a direct `syncFavorites` call.
* **Sync down:** the same `syncFavorites` call then pulls `GET /uttale/Favorites`
  and reconciles (`reconcileFavorites`, `app.js:1106-1136`).
* **Conflict rule — status-based / local-intent-wins:** unflushed
  `pending`/`deleted` always beat the server; once `synced`, the server is
  authoritative for content (text/end/comment/exported_at copied down); a
  `synced` row the server no longer has is deleted locally. A malformed/empty
  server payload aborts reconcile (`app.js:1098`) so it can never wipe the local
  mirror.

### listened (resume position) — persists often, uploads promptly (debounced)

* **Persist (IndexedDB):** captured **every 5 seconds while audio is playing**
  (`setInterval(recordListen, 5000)`, `app.js:1361`; the callback early-returns
  unless playing, `app.js:1211`), **plus** forced **on `play`** (`app.js:614`)
  and **on `pause`** (`app.js:615`). NOT on `timeupdate`, NOT on `ended`. Only
  the 10 most-recent files are kept (`pruneListened`, `LISTENS_LIMIT = 10`). The
  saved position is episode-absolute time (`offset + currentTime`), VTT-formatted
  (`app.js:1214-1216`).
* **Sync up — promptly, via the event/sync bus:** since the events/sync
  refactor, `recordListen` writes IndexedDB (`status:"pending"`) and then
  **emits `listens:changed`** with `reason:"local-record"` (or
  `"local-record-pruned"` when pruning fired, `app.js:1221-1224`). Both reasons
  are in the `isLocalIntent` allowlist (`SYNC_TRIGGERING_REASONS`,
  `app.js:45-49`), so the subscriber calls `Sync.request("listens")`
  (`app.js:129-133`), which **debounces ~750ms then runs `syncListens`** (up &
  down). Because `recordListen` is driven by the 5 s timer (plus `play`/`pause`),
  the resume position now reaches the server roughly **every ~5 s while playing**
  — each tick is its own upload (a 750ms debounce can't coalesce ticks 5 s
  apart). App boot (`Sync.request("all")`, `app.js:1363`), the `network:online`
  event (`app.js:146`), and opening the **Recent Listens tab** (`app.js:85`)
  **still also** sync. (`syncListens` phase 1, `app.js:1244-1249`: `pending` →
  `Api.listenPut` → `POST /uttale/Listens`.)
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

Since the events/sync refactor, fan-out is **centralized through a small event
bus** (`offline/static/events.js` — `Events.on`/`Events.emit`),
`offline/static/job.js` (`Job.coalesce`/`Job.debounce` scheduling primitives),
and `offline/static/sync.js` (`Sync.register`/`Sync.request`, a debounced serial
domain syncer). Mutations no longer call `updateStatus`/`renderMarks`/`renderFav`/
`renderListened`/`updateRecentCount`/`syncFavorites` directly; instead they emit
`favorites:changed`/`listens:changed`, whose subscribers (`app.js:109-138`)
**coalesce the UI jobs** (`Job.coalesce`) and **request a debounced sync**
(`Sync.request`, ~750ms). Sync-loop suppression is an `isLocalIntent(reason)`
**allowlist** (`SYNC_TRIGGERING_REASONS`, `app.js:45-49`): reasons
`server-reconcile` and `line-order-learned` update the UI but do **not** trigger
a sync. (Line numbers below are approximate; `app.js` changed substantially.)

* **App boot** (`boot()`, `app.js:1351-1368`): register the favorites/listens
  syncers with `Sync`, then `Sync.request("all")` (up & down for both), start the
  5 s listen timer, prefetch clips.
* **Tab switches** (`app.js:68-86`):
  * **Find** → no sync (renders cached episodes; search box debounced 600 ms).
  * **Listen** → no sync, no write.
  * **Favorites** → `Sync.request("favorites")` (debounced up & down) + clip
    prefetch + lineorder refine (a learned refinement emits
    `favorites:changed {reason:"line-order-learned"}`, which re-renders but does
    **not** sync).
  * **Recent Listens** → `Sync.request("listens")` (debounced up & down).
* **`online` event** (`app.js:140`) → emits `network:online`, whose subscriber
  (`app.js:143-148`) repaints badges and fires `Sync.request("all")` — a
  catch-up flush of **both** favorites and listens.
* **`offline` event** (`app.js:141`) → emits `network:offline`, whose subscriber
  (`app.js:150-153`) only repaints badges (no sync attempts).
* **Timer** → `setInterval(recordListen, 5000)` (`app.js:1361`): writes the
  position locally, then emits `listens:changed` → coalesced Recent-UI jobs +
  debounced `Sync.request("listens")`, so each ~5 s tick pushes promptly.
* **Audio events** → `play`/`pause` force-save the listen position
  (`recordListen({force:true})`, `app.js:614-615`), which likewise emits
  `listens:changed`; `timeupdate`/`ended` persist nothing.
* **Per-edit** → star toggle, comment-edit blur, delete, export write favorites
  locally and emit `favorites:changed` (`app.js:662/710` etc.); the subscriber
  coalesces the status/marks/Favorites-render jobs and, for local-intent reasons,
  `Sync.request("favorites")` (debounced up-sync when online).
* **No `beforeunload` / `visibilitychange` / `pagehide` handler** → there is no
  flush-on-tab-close. But because each 5 s tick (and `play`/`pause`) now emits
  `listens:changed` and debounced-pushes, the resume position is already on the
  server within a few seconds of the last tick — killing the tab loses at most
  the unsynced tail since the previous push.

## Notable asymmetries

1. **Both favorites and listens push on local change** (no longer asymmetric).
   Since the events/sync refactor, a favorite edit pushes **immediately** (on the
   edit, via `favorites:changed`) and a listen position pushes on **each ~5 s
   tick / `play` / `pause`** (via `listens:changed`) — both debounced through
   `Sync.request` (~750ms) and both gated on `isLocalIntent(reason)`. Earlier the
   resume position uploaded only on boot / `online` / Recent-tab; that lazy
   asymmetry is gone (boot / `online` / Recent still also sync as catch-ups).
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
