# SESSION.md — handoff

Last updated: 2026-06-27

## TL;DR for next session

The global "favorites" feature is **implemented end-to-end and verified live**
(uttale backend restarted on :7010; harken pages render and round-trip
favorites). The design spec is `docs/specs/2026-06-27-favorites-design.md`.

Remaining follow-ups (none blocking):
- Optionally pass `--favorites-db` when launching the deployed backend (it
  currently uses the default `~/.cache/srst-uttale/favorites.db`).
- Future iterations (not done): comment-editing UI, and the real export
  (telegram upload) that stamps `exported_at` — the `Update` API, `comment`
  column, and `exported_at` column/indicator already exist.

## What shipped

Single-user, global favorites: mark subtitle lines, list them, jump back, mark
them visually. Two repos:

- **srst-uttale** (`/home/bz/share/btsync/prg/srst-uttale`, `uttale/backend/server.py`):
  separate **SQLite** store (NOT the DuckDB), opened/closed per request via the
  `favorites_db()` context manager; `--favorites-db` arg (default
  `~/.cache/srst-uttale/favorites.db`); `Favorite`/`Favorites` + `FavoriteAdd`/
  `FavoriteUpdate` models; helpers `favorites_add/get/list/update/delete` +
  `now_iso`; endpoints `/uttale/Favorites` GET(list, `?filename=` LIKE filter)/
  POST(upsert)/DELETE(`?filename=&start=`), `/uttale/Favorites/Update` POST
  (comment, 404 if missing), `/uttale/Favorites/Export` POST (no-op stub
  `{"status":"not implemented"}`). Table columns `filename, start, end, text,
  comment, created_at, updated_at, exported_at`; PK `(filename, start)` where
  `start` is the VTT string. Tests: `test_server.py::TestFavorites` (11 tests).
- **srst-harken** (here, `harken/harken.py`): `Favorite` dataclass; `UttaleAPI`
  `_send` helper (POST/DELETE+JSON via `URLRequest(method=...)`) +
  `list_favorites/add_favorite/update_favorite/delete_favorite/export_favorites`;
  `UiState.favorites` (dict keyed by start-time string) + `fetch_favorites`;
  per-line star toggle button + `harken-fav` CSS marker (coexists with
  `.active`); `b` key toggles the active line; `at` deep-link param (one-time
  jump on load via `state.commands`, then `sync_url()` drops it); a `Favorites`
  nav link; second page `@ui.page("/favorites")` listing all favorites with
  per-row Delete, an Export button, and an export-status indicator, each row
  jumping via `/?scope=<file>&at=<start>`.

## Decisions worth remembering

- Favorites live in their own SQLite DB, opened/closed per op — keep them out of
  the global DuckDB.
- API responses mirror `Search`/`Scopes` (`results` + `results_count`); harken
  joins lines↔favorites by start-time string client-side.
- Export is a wired no-op stub; `exported_at` exists for the future real export.
- `at` deep-link: one-time jump on load, then dropped from URL.
- `/favorites` is a separate route (fits per-session page architecture).

## Verification done

- uttale: `make test` style — `python3 -m unittest uttale.backend.test_server -v`
  → 32 tests pass (21 existing + 11 favorites). Also a FastAPI `TestClient`
  exercise of every endpoint, and a **live** HTTPS round-trip against :7010
  (add/upsert/list/filter/update/404/export/delete/404/cleanup) — all green.
- harken: `py_compile` clean; smoke render on a spare port confirmed `/` and
  `/favorites` return 200, the favorited line shows `harken-fav`, the
  `/favorites` page lists a seeded favorite with comment + "not exported", and
  `/?scope=…&at=…` returns 200. No tracebacks. Seeded test data cleaned up.

## Repo state (committed)

- harken: favorites feature committed as `harken: favorites (per-line star,
  /favorites page, at deep-link, URL state)`. Prior: spec `bd71874`, AGENTS/
  SESSION `9dbdb47`, compact line spacing `725054d`, HTTPS + audio proxy
  `dad748a`, per-session + responsive `9c914e9`, LAN bind `3136f5f`, clickable
  scope segments `f522119`, URL persistence `be02504`, chrome audio CORS/autoplay
  fix `4204fda`.
- uttale: favorites backend committed as `add favorites SQLite store and
  /uttale/Favorites endpoints` (`a388886`) + AGENTS doc (`4cee63e`). Prior: Range
  header alias `ce89d29`, `--ssl` `817d30c`, `Vary: Origin` `f2dc545`, CORS
  `2f0d9df`. `test_server.py` is now tracked (was never committed before).

## Env / verification notes (CORRECTED)

- harken venv WORKS: `/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python`
  (nicegui 2.10.1, py3.12) — use it for `py_compile` and smoke renders.
- uttale has NO working venv: `.venv/bin/python` is a broken symlink to system
  py3.14, and no system python has `polars`/`webvtt`, so `server.py` can't
  import there. To run uttale tests in a sandbox, use **uv**:
  `uv venv /tmp/opencode/uttale-test --python 3.12` then `uv pip install
  --python /tmp/opencode/uttale-test/bin/python duckdb polars uvicorn webvtt-py
  fastapi pydantic tqdm httpx`. (Use uv for ALL env operations.)
- The deployed uttale backend is an **editable uv tool** (`uv tool list` shows
  `uttale`, installed from this repo with `editable:true`) that imports
  `server.py` directly from the repo working tree — so a plain **restart** picks
  up changes (no reinstall). Launch seen: `srst-uttale-backend-api --db root.db
  --root /mnt/wd-red-wcc4/audio/podcast/nordnorsk/ --ssl`.
- Smoke-render harken: temp harness IN the repo dir (imports need repo on path),
  spare port 8081-8085, poll for HTTP 200, kill by PID (no bare `pkill`), remove
  the harness after.
