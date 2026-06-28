# SESSION.md — handoff

Last updated: 2026-06-27

## Status

Favorites feature is **complete and verified live** across three areas:
favorites CRUD, sorting, and Telegram export with UI "blocks". The deployed
uttale backend on HTTPS :7010 is running current code (has sort + set_exported).
Everything below is committed.

Specs (source of truth):
- `docs/specs/2026-06-27-favorites-design.md`
- `docs/specs/2026-06-27-telegram-export-blocks-design.md`

## What exists

**uttale** (`/home/bz/share/btsync/prg/srst-uttale`, `uttale/backend/server.py`):
- Favorites in a separate **SQLite** store (NOT the DuckDB), opened/closed per
  request via `favorites_db()` ctx mgr; `--favorites-db` arg (default
  `~/.cache/srst-uttale/favorites.db`). Columns: `filename, start, end, text,
  comment, created_at, updated_at, exported_at`; PK `(filename, start)` (start =
  VTT string).
- Helpers `favorites_add/get/list/update/delete` + `now_iso`; `FAVORITES_SORTS`
  map.
- Endpoints `/uttale/Favorites`: GET (list; `?filename=` LIKE filter;
  `?sort=created_desc|created_asc|name_asc|name_desc`, default created_desc),
  POST (upsert), DELETE (`?filename=&start=`); `/uttale/Favorites/Update` POST
  (`comment` optional + `set_exported` bool → stamps `exported_at=now`; 404 if
  missing); `/uttale/Favorites/Export` POST (unused no-op stub).
- Tests: `test_server.py::TestFavorites` (39 tests total, all pass).

**harken** (here, `harken/harken.py`):
- `UttaleAPI`: `_send` (POST/DELETE+JSON) + `list_favorites(filename,sort)`,
  `add_favorite`, `update_favorite(comment=None,set_exported=False)`,
  `delete_favorite`. (`export_favorites` stub removed.)
- Main view: per-line star toggle + `harken-fav` CSS marker; `b` key toggles
  active line; `UiState.favorites` dict keyed by start-string + `fetch_favorites`;
  in-place toggle via `SubtitleLines.set_favorited` (NO full redraw, NO popups);
  `at` deep-link param = current playing line, kept in URL, updated by
  `play_line`→`sync_url` (cleared on scope change); `Favorites` nav link reads
  live URL → `/favorites?from=<origin>` so Back restores it. Search inputs
  `debounce=1000`. `SCOPE_LIMIT=100`.
- `/favorites` page: renders **blocks** (`group_favorites_into_blocks` +
  `FavoriteBlock`) = runs of favorited lines with adjacent line-offsets in the
  same file (offsets fetched via `search_text` per file). One row per block:
  combined text (space-join), jump to first line, Delete (all members), per-block
  Send (telegram), top "Export all", sort selector (Newest/Oldest/Name A→Z/Z→A).
- Telegram export: `export_block` reuses `get_audio` (first start→last end,
  ±0.5s) → temp `.ogg` → `TELEGRAM_SEND_VOICE` via `run.io_bound` → stamps
  `exported_at` per member. Caption = `FavoriteBlock.caption` = first line
  `#<podcast> #wtf` then combined text. `podcast` = 2nd path segment
  (`48k/<podcast>/...`). `TELEGRAM_SEND_VOICE =
  /home/bz/rc.arch/bz/bin/telegram-send-voice`.

**rc.arch** (`/home/bz/rc.arch`, `bz/bin/telegram-send-voice`): fixed a bug where
it exited 1 on success (cleanup trap when no ogg conversion) — added `return 0`.

## Open follow-ups (none blocking)

- Comment-editing UI (the `Update` API + `comment` column exist; no UI yet).
- `/favorites` does one `search_text` (~1.5s) per distinct file to get offsets —
  known inefficiency (same as `SearchResult.offset()`); fine for now.
- Optionally pass `--favorites-db` to the deployed backend (uses default now).

## Decisions worth remembering

- Favorites/blocks are joined/derived client-side; blocks are UI-only (no
  backend storage). Block sort key = newest member (created sorts) / (filename,
  first start) (name sorts).
- exported_at stamped server-side via the extended Update (`set_exported`).
- Telegram script outputs/converts ogg itself and sources `~/.telegram`.

## Env / how to verify

- harken venv WORKS: `.venv/bin/python` (nicegui 2.10.1, py3.12) — use for
  `py_compile` and smoke renders.
- uttale has NO working venv (`.venv` is broken py3.14; no polars/webvtt). Run
  tests via **uv** sandbox at `/tmp/opencode/uttale-test` (already created):
  `uv venv /tmp/opencode/uttale-test --python 3.12` then `uv pip install --python
  /tmp/opencode/uttale-test/bin/python duckdb polars uvicorn webvtt-py fastapi
  pydantic tqdm httpx`. Then `/tmp/opencode/uttale-test/bin/python -m unittest
  uttale.backend.test_server`. **Use uv for ALL env ops.**
- Deployed uttale = editable uv tool importing server.py from this repo → plain
  **restart** picks up changes. Launch: `srst-uttale-backend-api --db root.db
  --root /mnt/wd-red-wcc4/audio/podcast/nordnorsk/ --ssl`. Runs HTTPS :7010.
- harken also running on :8080 (don't kill). Smoke-render: temp `_smoke.py` IN
  repo dir pointing `h.api` at https://localhost:7010, spare port 8081-8089, poll
  for 200, kill by PID (no bare `pkill`), remove harness. NOTE favorites page is
  slow to render (per-file search_text) — give it >10s.
- Live favorites tests: there are **7 real user favorites** on :7010 (was 6
  earlier; the user added more) — don't disturb them; seed/delete temp favorites
  and verify the count returns to its current real baseline.
- Telegram sends are REAL (channel "Norsk audioclips"). Several test messages
  ("...test/probe/verify/ignore", "TAGTEST") were sent during dev — user may
  delete them.

## srst-offline — manual device verification

New offline-first PWA in this repo (`offline/offline.py` + `offline/static/*`),
separate from harken. Spec `docs/specs/2026-06-27-offline-pwa-design.md`, plan
`docs/plans/2026-06-27-offline-pwa.md`. It is a thin stdlib HTTPS server that
proxies uttale (`/api/scopes|lines|audio|favorite`) and serves a vanilla-JS PWA;
audio+VTT cache in IndexedDB, favorites queue locally and auto-sync on reconnect.

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

Automated smoke that passed at build time (no browser): all 9 shell assets 200
with correct MIME over `--ssl`; `/api/scopes` -> 2, `/api/lines` -> 215,
`/api/audio` -> 200 / 3.6 MB; favorite POST then DELETE round-trips and the live
favorites count returned to its baseline. Browser-only behavior (SW/IndexedDB/
offline reload) is the manual checklist above.

### srst-offline v2 — UI/playback + favorites (manual device checks)

Spec `docs/specs/2026-06-27-offline-ui-favorites-design.md`, plan
`docs/plans/2026-06-27-offline-ui-favorites.md`. Adds icon top bar, episode-
absolute timestamps, an episode scrubber, a Favorites view, and `POST /api/export`
(server-side telegram, reusing harken's path).

Single-origin requirement: open the app via ONE stable hostname on every network
(recommended: the Tailscale MagicDNS name, e.g.
`https://<host>.<tailnet>.ts.net:7020`). IndexedDB is per-origin, so mixing a raw
LAN IP and a Tailscale IP splits your cache and favorites/pending queue. A
dismissible banner warns when opened via a raw IP.

After `srst-offline --ssl`, on the phone verify:
1. Top bar shows three icon tabs (Find/Listen/Favorites) + a ⛅/⚡ + pending chip.
2. Find: tap a prefilled chip -> search prefills + runs; results are newest-date
   first.
3. Open a cached episode -> Listen: each line shows an episode-absolute timestamp
   (H:MM:SS) subscript.
4. Play: the active line advances and auto-scrolls as audio plays; at a segment
   end it auto-continues into the next segment.
5. Top transport (prev/play-pause/next + clock) stays visible when scrolled; clock
   shows current/total episode time.
6. Bottom scrubber: tap/drag seeks anywhere in the episode; favorited lines show as
   yellow ticks.
7. Favorites tab: lists your favorites; ✈ sends one to Telegram (online; server
   runs telegram-send-voice on the home PC); "Export all (unexported)" sends the
   rest; sent items show ✓.
8. Offline: marking still works; export shows it needs a connection.

v2.1 changes: Favorites now shows the union of local + server favorites — opening
the tab (online) pulls `GET /api/favorites` and reconciles into IndexedDB (local
pending/deleted win; a synced row absent from the server is removed). Verify on a
fresh device/origin: with no local marks, the Favorites tab still lists your server
favorites once online. Top bar is one row now: [Find][Listen][Favorites] then
play/pause + clock (Listen view only), status chip far right showing 📶 (online) /
✈️ (offline) + pending count. Prev/next-line buttons removed (use line taps or the
scrubber).

Build-time smoke (no browser): timeline math harness passes; all 9 shell assets
(incl. `/api.js`,`/timeline.js`) 200 over `--ssl`; `/api/export` of a throwaway
clip returned `{"status":"sent"}` (real telegram message sent, labeled "ignore");
real favorites left undisturbed (current baseline 7).

## Recent commits


- uttale: `8427138` extend Update (set_exported), `7a0f30d` sort param,
  `a388886` favorites backend, `4cee63e` AGENTS doc.
- harken: `2624c63` telegram caption tags, `da53cff` blocks + telegram export,
  `8284e00` export+blocks spec, `bb63a50` sort selector, `8448d82`/`fffb39d`
  favorites + session.
- srst-offline: `dd15c7f` server shell, `8735f49` /api proxy, `8073113` PWA
  shell, `becbf59` IndexedDB, `8d3e9e3` View 1, `520d72e` View 2, `3cd0210`
  packaging.
- rc.arch: `ce5e5a7c` telegram-send-voice exit-code fix.

## Favorite clips — manual browser checks (Tailscale .ts.net host, not raw IP)
- Open Favorites while online: each group shows a ▶ button.
- Tap ▶: clip plays from the dedicated player; button shows ⏸; transcript player/scrubber/clock unaffected.
- Tap ⏸ (same row): stops. Tap another row's ▶: first stops, second plays (only one at a time).
- Reload, go offline (DevTools), open Favorites: previously-prefetched clips still play (served from IndexedDB).
- Offline + a clip that was never prefetched: ▶ briefly shows ∅ and does nothing (no crash).
- DevTools → Application → IndexedDB → srst-offline → clips: rows keyed filename|start|end; deleting a favorite then reopening Favorites (online) prunes its orphaned clip.
- Network tab: clip requests carry Cache-Control: immutable + ETag; repeat plays of an already-cached clip make NO /api/clip request (served from IndexedDB).
