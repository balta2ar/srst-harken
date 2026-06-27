# Favorites Feature — Design Spec

Date: 2026-06-27
Repos: `srst-uttale` (backend API + storage), `srst-harken` (NiceGUI UI)

## Goal

Let the single user mark subtitle lines as "favorites" (global, no multi-user).
Favorites are stored by uttale in a **separate SQLite DB**. A favorites view in
harken lists all favorites and jumps to the corresponding line in the main view.
Favorited lines are visually marked in the main view. `comment` and
`exported_at` columns lay groundwork for future translations and export.

## Primary key

A line is identified by `(filename, start)` where `start` is the VTT timestamp
string (e.g. `00:00:26.240`). This is the favorite's primary key. Normal
subtitles and favorites are joined client-side by `(filename, start)`.

## Storage (uttale)

- Separate SQLite DB, configured via `--favorites-db`
  (default `~/.cache/srst-uttale/favorites.db`).
- **Opened per operation and closed immediately** (context-manager helper);
  never held open between requests. Schema auto-created on first connect
  (`CREATE TABLE IF NOT EXISTS`).
- Main DuckDB (`--db`) is unchanged and unrelated.

Table `favorites`:

| column      | type | notes |
|-------------|------|-------|
| filename    | TEXT | PK part |
| start       | TEXT | VTT timestamp string, PK part |
| end         | TEXT | end timestamp |
| text        | TEXT | line text snapshot |
| comment     | TEXT | free-text annotation, default `''` (future translations) |
| created_at  | TEXT | ISO-8601 UTC, set on insert |
| updated_at  | TEXT | ISO-8601 UTC, set on insert and every update |
| exported_at | TEXT | ISO-8601 UTC, nullable, default NULL (set by real export later) |

`PRIMARY KEY (filename, start)`.

## uttale API

Response shapes mirror the existing `Search`/`Scopes` style so harken can join
lines and favorites by `(filename, start)`.

Pydantic models:
- `Favorite`: `filename, start, end, text, comment, created_at, updated_at, exported_at`.
- `Favorites` response: `results: list[Favorite]`, `results_count: int`.

Endpoints (each opens/closes SQLite per call):

| Method | Path | Params/Body | Behavior |
|--------|------|-------------|----------|
| GET    | `/uttale/Favorites` | `?filename=` optional | List; filter by filename (LIKE, like Search) if given else all; order by `filename, start`. Returns `Favorites`. |
| POST   | `/uttale/Favorites` | `filename, start, end, text, comment?` | Upsert. Insert sets `created_at=updated_at=now`, `comment` defaults `''`, `exported_at=NULL`. On PK conflict update `end, text, comment, updated_at` (preserve `created_at`, `exported_at`). Returns the `Favorite`. |
| POST   | `/uttale/Favorites/Update` | `filename, start, comment` | Update `comment` + `updated_at` on an existing favorite. 404 if missing. Returns updated `Favorite`. |
| DELETE | `/uttale/Favorites` | `?filename=&start=` | Delete one by PK. Returns status. |
| POST   | `/uttale/Favorites/Export` | — | No-op stub: returns `{"status": "not implemented"}` (200). Wiring/real script later. |

- `now()` = ISO-8601 UTC string.
- `comment` is optional on every mark; favoriting without a comment is allowed.
- Missing favorite on Update/Delete → 404. Errors raise `HTTPException`
  consistent with existing endpoints.

## harken — API client & data flow

`UttaleAPI` additions (mirroring `search_text`/`_make_request`):
- `list_favorites(filename=None) -> list[Favorite]` → GET.
- `add_favorite(filename, start, end, text, comment="")` → POST.
- `update_favorite(filename, start, comment)` → POST `/Update`.
- `delete_favorite(filename, start)` → DELETE.
- `export_favorites()` → POST `/Export` (stub).

A new sibling helper (e.g. `_send(endpoint, method, params=None, body=None)`)
supports POST/DELETE via `urllib.request.Request(method=...)`, reusing
`SSL_NOVERIFY`. GET-only `_make_request` stays as-is. POST sends a JSON body;
DELETE uses query params (`?filename=&start=`), matching how GET builds URLs.

New harken `Favorite` dataclass mirrors `SearchResult` plus
`comment, created_at, updated_at, exported_at`.

**Per-file favorite set:** when a file's lines load, harken also calls
`list_favorites(filename=current_file.sub)` and builds a dict keyed by `start`
(value = `Favorite`). A line is favorited iff its `start_time` is in that dict.

Client methods return parsed models or safe empties on failure (like
`search_text` returning `[]`). Toggle/jump handlers fail gracefully
(`ui.notify` on error) without crashing the page.

## harken — main view (`/`)

**Deep-link `at`:** URL state grows from `(scope, text)` to `(scope, text, at)`.
- On load, `main_page` reads `at` (a `start_time`). If present, after building
  state for that scope/file, find the line whose `start_time == at` and use the
  existing deferred-command mechanism to seek + highlight it.
- `at` triggers a one-time jump on load; `sync_url()` then drops `at` so the URL
  reflects just `scope`/`text` going forward (the original deep link still works).
- `sync_url()` continues to write `scope` + `text`.

**Per-line favorite marking & toggle:**
- Each `harken-line` row gets a small star toggle button beside the text label.
  Empty star → `add_favorite(...)`; filled star → `delete_favorite(...)`. After
  toggling, update the in-memory favorite set and refresh the view.
- Favorited lines get a distinct visual marker via a `harken-fav` CSS class
  (e.g. left accent / different background), separate from the green `active`
  highlight so the two coexist.
- Clicking the line **text** still plays it (`on_line_click` unchanged).

**Keyboard shortcut:** `b` (bookmark) toggles favorite on the active/current
line (`state.sub_lines.current_line`).

**Nav:** a link to `/favorites` in the top row.

## harken — Favorites view (`/favorites`)

A second `@ui.page("/favorites")`, same per-session structure as main page.

- Top: nav link back to `/`.
- Body: `api.list_favorites()` (no filter → all), rendered as a list. Each row
  shows: filename/breadcrumb (possibly abbreviated), `text`, `comment` if any,
  `created_at`, and export status (`exported {exported_at}` or `not exported`).
  Reuse compact line styling.
- Click a favorite → `ui.navigate.to("/?scope=<filename>&at=<start>")` →
  main page opens that file and seeks/highlights the line.
- Per-row **Delete** (trash) button → `delete_favorite(...)` then refresh list.
- **Export** button → `export_favorites()` (stub; does nothing yet). The
  `exported_at` column/field/indicator exist now, ready for the real export.

## Testing

- uttale: add `unittest` tests (matching existing `test_server.py` style) for the
  favorites helpers using a temp SQLite DB: schema creation, upsert preserving
  `created_at`, comment update, list filtering, delete.
- harken: no test suite; rely on `py_compile` + smoke render + manual verification.

## Edge cases / non-goals

- Single user, per-op SQLite open/close → negligible contention; default SQLite.
- Re-timed/re-indexed VTTs could drift the `(filename, start)` key; acceptable
  for this archive.
- Real export (telegram upload, stamping `exported_at`) is a later iteration.
- Editing comments via UI is a later iteration (API `Update` exists now).
