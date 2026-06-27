# srst-offline — offline-first PWA design

Date: 2026-06-27

## Goal

A small, offline-first Progressive Web App for listening to a podcast episode
and marking favorite lines **while offline** (e.g. on the commute), then
auto-syncing those favorites back to the uttale backend when back online.

Concretely, the workflow:

1. At home (wifi): find a podcast episode, tap it to **download & cache** all its
   segments (`.ogg` audio + VTT lines) onto the phone.
2. At work / on the train (offline): open the app, navigate the episode's lines,
   play audio, and **star favorites** — all from local cache, no network.
3. Back home (wifi): queued favorites **auto-flush** to the backend and are saved.

This is a separate app from harken. harken is a server-driven NiceGUI app whose
interactive UI cannot work offline (the page needs a live websocket to the Python
process). srst-offline is therefore a real client-side PWA.

## Non-goals (YAGNI)

- No recording, no audio compression (explicitly not needed here).
- No comment-editing UI, no Telegram/export, no "blocks" grouping.
- No hierarchical podcast-tree browsing (search-driven discovery only).
- No Background Sync API initially (the `online` event + app-open replay covers
  the home→work→home loop; can be added later if a closed tab must sync).

## Architecture

Two processes with a clear split:

- **Server — `offline/offline.py`** (Python stdlib only): an HTTPS
  `ThreadingHTTPServer` that serves the static app files and proxies a few uttale
  endpoints. Holds **no state**, does **no DB work**. Threaded so streaming a
  large `.ogg` during download does not block the service-worker / manifest
  fetches. Reuses harken's self-signed-cert approach.
- **Client — vanilla JS PWA**: the actual app. Holds all offline state in
  IndexedDB + the Cache API, runs two views, queues favorites locally, and
  flushes them on reconnect.

Once an episode is cached, the server is irrelevant — the service worker serves
the shell and the client reads audio/lines from IndexedDB.

### Files

| File | Purpose |
|---|---|
| `offline/offline.py` | stdlib HTTPS server: static file serving + proxy routes + argparse + cert helper |
| `offline/static/index.html` | app shell (both views), minimal markup |
| `offline/static/app.js` | vanilla JS: views, IndexedDB, download/cache, favorite queue, sync |
| `offline/static/sw.js` | service worker: precache app shell, serve it offline |
| `offline/static/manifest.webmanifest` | PWA manifest (installable / add-to-home-screen) |
| `offline/static/icon-192.png`, `icon-512.png` | manifest icons (required for install) |

## Backend data model (uttale, confirmed live against :7010)

Scope/filename paths encode the hierarchy:
`48k/<podcast>/<episode-date>/by10m/by10m_NN.vtt`

- **podcast** = 2nd path segment.
- **episode key** = the `48k/<podcast>/<date>` prefix.
- **episode segments** = all VTTs sharing that episode prefix (typically a small
  handful, e.g. `by10m_00.vtt … by10m_0N.vtt`).

Relevant uttale endpoints (verified via live `GET /openapi.json`):

- `GET /uttale/Scopes?q=&limit=` → `{results: [vtt path, …]}` (DB-backed substring
  match; **use this for discovery — never walk the filesystem**, the audio root
  has ~36k files).
- `GET /uttale/Search?q=&scope=<vtt>` → `{results: [{filename,start,end,text}, …]}`
  (all lines of a segment when `q` is empty).
- `GET /uttale/Audio?filename=<vtt>&start=&end=` → with empty start/end returns the
  **whole `.ogg`** straight from disk (no ffmpeg) — ideal for preloading a segment.
- `POST /uttale/Favorites` body `{filename, start, end, text, comment}` → upsert,
  **idempotent on `(filename, start)`** (PK), so replaying a queue is safe.

## Server proxy routes (offline.py)

Own `/api/*` names (not uttale's), so the service-worker rules and the offline
boundary are unambiguous and we are insulated from uttale path changes.

| Route | Forwards to uttale | Used when |
|---|---|---|
| `GET /api/scopes?q=` | `GET /uttale/Scopes?q=&limit=` | View 1 search (online) |
| `GET /api/lines?scope=<vtt>` | `GET /uttale/Search?q=&scope=` | episode download (online) |
| `GET /api/audio?filename=<vtt>` | `GET /uttale/Audio?filename=&start=&end=` (whole .ogg) | episode download (online) |
| `POST /api/favorite` | `POST /uttale/Favorites` (JSON body) | sync — add (online) |
| `DELETE /api/favorite?filename=&start=` | `DELETE /uttale/Favorites?filename=&start=` | sync — un-favorite (online) |

Implementation notes:
- Proxy with `urllib.request` + `ssl._create_unverified_context()` (harken's
  `SSL_NOVERIFY` pattern; uttale is self-signed).
- `/api/scopes`, `/api/lines`: forward query, return JSON unchanged.
- `/api/audio`: stream bytes in 64 KB chunks (harken's audio-proxy pattern).
- `/api/favorite` POST: read JSON body, forward as POST with `Content-Type:
  application/json`. DELETE: forward query params to uttale's
  `DELETE /uttale/Favorites`.

## Data flow

### Flow 1 — Find & download (View 1, online)

1. Type query → `GET /api/scopes?q=…` → flat list of segment VTT paths.
2. Client groups paths by episode key (`48k/<podcast>/<date>`) → one row per
   episode (label = podcast + date, plus segment count).
3. Tap an episode → **download**, for each segment VTT in episode order:
   - `GET /api/lines?scope=<vtt>` → store lines JSON in IndexedDB.
   - `GET /api/audio?filename=<vtt>` → store the `.ogg` Blob in IndexedDB.
   - show progress ("3/8 segments"). On completion mark episode *cached*, open
     View 2.
   - request `navigator.storage.persist()` on first download (best-effort).
4. View 1 always also lists already-cached episodes (so they can be reopened
   offline), each with a **Delete** action.

### Flow 2 — Listen & favorite (View 2, offline)

1. Load the episode's lines from IndexedDB → render one **continuous** list (all
   segments concatenated in order), each line = star + text.
2. One `<audio>` element. Each line knows its `(segment-vtt, start, end)`. Tapping
   a line: if the audio src isn't already this segment's blob, swap src to
   `URL.createObjectURL(blob-from-IndexedDB)`, then seek to `start` and play.
   `timeupdate` highlights the active line (harken's model).
3. Tap a star → favorite toggle, fully local:
   - on: write `{filename: segment-vtt, start, end, text, status: "pending"}` to
     IndexedDB `favorites`.
   - off: if still `pending`, delete the row; if already `synced`, mark
     `status: "deleted"` for the queue.
   - star reflects state instantly; no network.

### Flow 3 — Sync (online / reconnect)

1. On app open and on the browser `online` event, read all non-`synced`
   favorites and replay them: `pending` adds → `POST /api/favorite`; `deleted`
   entries → `DELETE /api/favorite?filename=&start=`. `(filename,start)` is
   idempotent, so re-sends are harmless.
2. On success → `pending` becomes `synced`; a `deleted` row is pruned. Failures
   stay in their current status for the next attempt.
3. A small header indicator shows pending/synced counts. No button to remember.

### Offline boundary (explicit)

`/api/scopes`, `/api/lines`, `/api/audio`, `/api/favorite` are **online-only**.
Everything in View 2 (lines, audio, favoriting) reads **only** IndexedDB and never
touches `/api/*`. That is what makes the commute work.

## Service worker & storage

**`sw.js` — two jobs:**
1. **App-shell precache** (install): `index.html`, `app.js`,
   `manifest.webmanifest`, icons → cache-first, so the app boots with no server.
2. The SW deliberately does **not** intercept `/api/*` (online-only) and does
   **not** cache audio/VTT. Content lives in IndexedDB, written explicitly during
   download. One writer (app.js) owns content; the SW owns only the shell.

**IndexedDB schema — one database, three stores:**

| Store | Key | Value |
|---|---|---|
| `episodes` | episode key (`48k/<podcast>/<date>`) | `{podcast, date, segments: [vtt…], cachedAt}` |
| `segments` | segment vtt path | `{lines: [{start,end,text}], audio: Blob}` |
| `favorites` | `filename + "\|" + start` | `{filename, start, end, text, status, updatedAt}` |

Lines + audio Blob are co-located per segment: one read opens a segment, one
`delete` evicts it.

**Offline guarantees:**
- Go offline mid-trip: View 2 reads only IndexedDB → works in airplane mode.
- Restart browser / reopen from home screen offline: SW serves shell from Cache
  API → app boots → reads IndexedDB → works.
- Mark favorites offline: writes go to IndexedDB (`pending`) → never network-blocked.
- Back on wifi: `online` event + app-open replay pending favorites → server saved.

**Storage management (minimal):**
- Per-episode **Delete** in View 1 (frees `segments` + `episodes` rows).
- `navigator.storage.persist()` requested on first download so the browser will
  not evict the cache under pressure (best-effort, no fallback logic).

## Packaging & launch

`pyproject.toml`:
- Add console script: `srst-offline = "offline.offline:main"`.
- Add `"offline"` to `[tool.setuptools] packages`.
- Include `offline/static/*` as package data; at runtime resolve `static/`
  relative to `__file__` so it works installed or in-repo.
- **No new runtime dependencies** — stdlib only (nicegui/pydantic remain
  harken-only).

argparse (per AGENTS.md): `--uttale` (default `https://localhost:7010`),
`--host 0.0.0.0`, `--port 7020`, `--ssl`, `--ssl-cert`, `--ssl-key`. Reuse
harken's `ensure_cert` / `detect_lan_ip` (copied into the module to keep it
self-contained and dependency-free).

Run:

```
srst-offline --ssl     # https://0.0.0.0:7020, proxies https://localhost:7010
```

On the phone (same wifi): open `https://<home-pc-lan-ip>:7020`, accept the
self-signed cert once, "Add to Home Screen". Search → tap episode → cache → go
offline → listen + star → home → auto-sync.

## Verification

No automated suite in this repo (AGENTS.md) — `py_compile` + smoke:

- `python -m py_compile offline/offline.py`.
- Smoke on a spare port (e.g. 7021) against live `https://localhost:7010`:
  - `curl -k` the shell (`/`, `/app.js`, `/sw.js`, `/manifest.webmanifest`) → 200
    with correct MIME and SW headers (`Service-Worker-Allowed: /`).
  - `curl -k '/api/scopes?q=Marianne…'`, `/api/lines?scope=…` → JSON.
  - `curl -k '/api/audio?filename=…'` → ogg bytes.
  - kill by PID (no bare `pkill`); clean up the harness.
- Favorites sync hits the **real** uttale favorites DB (6 real user favorites per
  SESSION.md): smoke uses a throwaway `(filename,start)`, then deletes it, leaving
  the count at 6.
- Browser-side behavior (SW registration, IndexedDB, install, offline reload,
  sync round-trip) cannot be fully automated here; the served assets/headers are
  verified by smoke, and the **on-phone offline + sync round-trip is a manual
  check** the user performs.

## Risks / open questions

- **Self-signed HTTPS + service workers on mobile:** some mobile browsers refuse
  to register a service worker behind an untrusted cert. Main risk. Fallback:
  trust the cert on the phone, or use a real cert on the LAN. Flagged here as the
  primary risk; everything else is straightforward.
- **Offline un-favorite (decided):** un-favoriting an already-synced item offline
  marks it `status: "deleted"`; sync forwards `DELETE /api/favorite` →
  `DELETE /uttale/Favorites`. So both offline add and offline remove round-trip to
  the server. (This is why the proxy exposes both POST and DELETE on
  `/api/favorite`.)
- **Episode size:** segments are ~10-minute `.ogg` files; an episode is a few of
  them. Acceptable on wifi and within IndexedDB Blob limits with `persist()`.
