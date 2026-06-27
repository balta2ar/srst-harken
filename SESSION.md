# SESSION.md — handoff

Last updated: 2026-06-27

## TL;DR for next session

We finished **designing** a global "favorites" feature and committed the spec.
Next action: **produce the implementation plan, then implement it.**

Start by reading, in order:
1. `docs/specs/2026-06-27-favorites-design.md` (the full design — source of truth)
2. This file
3. `AGENTS.md` here, and `/home/bz/share/btsync/prg/srst-uttale/AGENTS.md`

Then invoke the `writing-plans` skill to turn the spec into an implementation
plan, and begin implementing.

## What the favorites feature is

Single-user, global "favorites": mark subtitle lines, list them, jump back to
them, mark them visually. Spans two repos:

- **srst-uttale** (`/home/bz/share/btsync/prg/srst-uttale`, `uttale/backend/server.py`):
  new **separate SQLite** DB (NOT the main DuckDB), opened/closed per request via
  a context-manager helper; new `--favorites-db` arg (default
  `~/.cache/srst-uttale/favorites.db`); `Favorite`/`Favorites` pydantic models;
  `/uttale/Favorites` List(GET)/Add(POST)/Delete(DELETE),
  `/uttale/Favorites/Update`(POST), `/uttale/Favorites/Export`(POST no-op stub).
  Table columns: `filename, start, end, text, comment, created_at, updated_at,
  exported_at`. PK `(filename, start)` where `start` is the VTT string.
- **srst-harken** (here, `harken/harken.py`): `UttaleAPI` favorite methods (+ a
  POST/DELETE helper alongside the GET-only `_make_request`); a `Favorite`
  dataclass; per-line star toggle + `harken-fav` CSS marker; `b` key toggles the
  active line; deep-link `at` (start-time) param for jump-to-line (one-time jump
  on load, then dropped from URL); a second page `@ui.page("/favorites")` listing
  all favorites with Delete + Export buttons and an export-status indicator; nav
  link between `/` and `/favorites`.

All the precise schema/endpoint/UI semantics are in the spec — follow it.

## Implementation order (agreed)

1. uttale: SQLite helper + `--favorites-db` arg + models + endpoints, with
   `unittest` tests in `uttale/backend/test_server.py`.
2. harken: `UttaleAPI` client methods + POST/DELETE helper + `Favorite` dataclass.
3. harken: main-view per-line star + `harken-fav` marker + `b` key + `at`
   deep-link.
4. harken: `/favorites` page + nav links + Delete/Export buttons + export-status.

Restart the uttale backend (HTTPS :7010) to pick up its changes. Verify harken
via `py_compile` + a smoke render on a spare port (8081-8085); verify uttale via
its unittest suite.

## Decisions worth remembering

- Favorites live in their own SQLite DB, opened/closed per op — keep them out of
  the global DuckDB.
- API responses mirror `Search`/`Scopes` (`results` + `results_count`) so harken
  joins lines↔favorites by `(filename, start)` client-side.
- Export is a wired **no-op stub** this iteration; `exported_at` column/field/UI
  indicator exist now, to be stamped by the real export later.
- `at` deep-link: one-time jump on page load, then `sync_url()` drops it.
- `/favorites` is a separate route (fits per-session page architecture), not a
  Quasar in-page tab.
- Comment editing via UI and the real export (telegram upload) are later
  iterations; the `Update` API and `comment` column already exist.

## Repo state (all committed)

- harken HEAD `bd71874` (spec). Prior: compact line spacing `725054d`, HTTPS +
  audio proxy `dad748a`, per-session + responsive `9c914e9`, LAN bind `3136f5f`,
  clickable scope segments `f522119`, URL persistence `be02504`, chrome audio
  CORS/autoplay fix `4204fda`.
- uttale HEAD `ce89d29` (Range header alias). Prior: `--ssl` `817d30c`,
  `Vary: Origin` `f2dc545`, CORS `2f0d9df`.

## Env / verification notes

- harken venv: `/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python`
  (nicegui 2.10.1, py3.12).
- uttale venv: `/home/bz/share/btsync/prg/srst-uttale/.venv/bin/python` (py3.12);
  deployed process may use system py3.13 — restart to pick up changes.
- Smoke-render harken: temp harness IN the repo dir (imports need repo on path),
  spare port 8081-8085, poll for HTTP 200, kill by PID (no bare `pkill`), clean
  up the harness after.
