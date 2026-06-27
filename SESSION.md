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
- Live favorites tests: there are **6 real user favorites** on :7010 — don't
  disturb them; seed/delete temp favorites and verify count returns to 6.
- Telegram sends are REAL (channel "Norsk audioclips"). Several test messages
  ("...test/probe/verify/ignore", "TAGTEST") were sent during dev — user may
  delete them.

## Recent commits

- uttale: `8427138` extend Update (set_exported), `7a0f30d` sort param,
  `a388886` favorites backend, `4cee63e` AGENTS doc.
- harken: `2624c63` telegram caption tags, `da53cff` blocks + telegram export,
  `8284e00` export+blocks spec, `bb63a50` sort selector, `8448d82`/`fffb39d`
  favorites + session.
- rc.arch: `ce5e5a7c` telegram-send-voice exit-code fix.
