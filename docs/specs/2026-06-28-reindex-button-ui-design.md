# Reindex button in the Find tab (offline PWA)

Date: 2026-06-28
Status: approved (design)

## Problem

The uttale backend now exposes `POST /uttale/Reindex` (query-driven, idempotent,
per-file replace; see the uttale repo spec
`docs/specs/2026-06-28-incremental-reindex-design.md`). The offline PWA cannot
trigger it: there is no `/api/reindex` proxy and no UI.

The Find tab's search box already holds a filename/path pattern (e.g.
`"idioti 202606"`) sent to `/uttale/Scopes` via `Api.scopes`. When a search shows
fewer episodes than expected, the missing ones are simply not indexed on the
server. We add a **Reindex** button beside the "Search results" header that reuses
the **current search-box value** as the reindex pattern, then re-runs the search
so the newly-indexed episodes appear.

This is offline-PWA (harken repo) follow-up work; the backend already shipped.

## Scope

- `offline/offline.py`: a `/api/reindex` POST proxy to `/uttale/Reindex`.
- `offline/static/api.js`: `Api.reindex(pattern)`.
- `offline/static/app.js`: the header button + click handler + auto re-search.
- `offline/static/app.css`: minor styling for the header row + button (reuse
  existing `.gen-topics`-style button if it fits).

No new IndexedDB stores, no caching — reindex is a pure server action; results
flow back through the existing `Api.scopes` path.

## UI placement & state

- The button lives in the **"Search results" header row** (`renderFind`'s
  `resultsHdr` `<h3>` becomes a small flex row holding the title + the button).
- Visible/enabled **only when online AND the search box is non-empty**. Hidden
  when the box is empty or the device is offline (reindex needs the server; the
  backend rejects an empty pattern). Mirrors the online-gated `renderTopicsEmpty`
  pattern (`app.js`).
- Visibility is (re)computed every time `search(query, box)` runs — i.e. on every
  query change, chip tap, and the initial render — based on
  `navigator.onLine && query.trim()`. The existing `online`/`offline` window
  listeners (`app.js:90-94`) do **not** re-render the Find view, so a connectivity
  change while the user sits idle on results does not re-hide the button until the
  next search. That residual case is covered at click time: the handler still
  guards on `navigator.onLine` and wraps `Api.reindex` in try/catch, so a stale
  visible button that's tapped while offline shows "Reindex failed" rather than
  misbehaving. (Hooking the button into the connectivity listeners is deliberately
  out of scope — YAGNI.)
- Enabled regardless of how many results showed — the user reindexes precisely
  when they suspect missing episodes, which the client cannot detect (a
  zero-result query may still have unindexed files on disk).

## Click behavior

1. Disable the button; set label **"Reindexing…"**.
2. `POST /api/reindex` with body `{ "pattern": <current query> }`.
3. On the JSON response `{status, matched, truncated, ...}`:
   - `started` → label **"Reindexed N"** (N = `matched`; if `truncated`,
     **"Reindexed N+ — narrow query"**). After a **5-second delay**, auto re-run
     the current search (so new episodes appear), then restore the button to
     **"Reindex"** (re-enabled).
   - `already running` → label **"Already running…"**, then re-search after the
     5s delay (it may finish soon), restore.
   - `nothing matched` → label **"Nothing to index"** briefly (~2s), no
     re-search, restore.
   - `no pattern` → restore quietly (should not occur — gated on non-empty).
   - network/other error (POST throws) → label **"Reindex failed"** briefly
     (~2s), restore.
4. While the button is in its transient state it stays disabled so repeated taps
   can't stack timers / re-POST.

The 5-second delay is a deliberate, simple heuristic: a typical podcast+month
reindex parses a handful of files in well under that, so the re-search shows the
new episodes. A very large reindex may still be running, in which case a manual
re-search picks up the rest — acceptable (documented limitation, not polled).

## Plumbing (mirror the existing `/api/topics` → `GenerateTopics` pattern)

### `offline/offline.py`
- Add `"/api/reindex"` to the `do_POST` allow-list set.
- Dispatch: `if parsed.path == "/api/reindex": self._proxy_post("/uttale/Reindex", raw, "reindex error"); return`.
- `_proxy_post` already forwards the raw JSON body (method POST,
  `Content-Type: application/json`) and relays the upstream status/body — no
  change to that helper.

### `offline/static/api.js`
- Add:
  ```js
  async function reindex(pattern) {
    const r = await fetch("/api/reindex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pattern }),
    });
    return r.json();
  }
  ```
- Add `reindex` to the exported object.

### `offline/static/app.js`
- In `renderFind`, replace the plain `resultsHdr` `<h3>` with a header row
  (`<div class="results-head">`) containing the title and a Reindex `<button>`.
  Store the button (and the live `input`/`resultsBox` refs the handler needs).
- The button's visibility is set inside `search(query, box)` (which already runs
  on every query and knows `query` + online state) — so `search` toggles the
  button hidden/shown based on `navigator.onLine && query.trim()`. (The button
  element is reachable via a stored `el.reindexBtn` or by passing it through.)
- New `reindexSearch(query, box, btn)` async function implements the click
  behavior above, calling `Api.reindex(query)` and re-running `search(query, box)`
  after the delay via `setTimeout`.

### `offline/static/app.css`
- `.results-head` — flex row, title left, button right (align baseline).
- Reuse the `.gen-topics` button styling, or add a small `.reindex-btn` rule
  consistent with it; disabled state dimmed.

## Error handling

- The button is normally hidden offline (recomputed on each `search` run), and the
  click handler additionally guards on `navigator.onLine` and wraps `Api.reindex`
  in try/catch, so a stale visible button tapped after a mid-session disconnect
  shows "Reindex failed" rather than an unhandled rejection.
- The auto re-search reuses `search()`, which already handles offline
  ("Offline — can't search.") and the no-matches case.

## Testing (harken AGENTS.md: no pytest; `node --check` + fake-indexeddb harness extracting real funcs; `curl -k` smoke; manual checklist)

Run node harnesses from `/tmp/opencode` (where `fake-indexeddb` is installed).

- **`offline.py`**: `python -m py_compile offline/offline.py`; throwaway uttale on
  `127.0.0.1:7011` + offline server on `127.0.0.1:7023`; `curl -k -X POST
  /api/reindex -d '{"pattern":"idioti"}'` returns the upstream JSON
  (`status`/`matched`); kill by saved PID.
- **`api.js`**: node harness stubbing global `fetch`; assert `Api.reindex("idioti")`
  issues `POST /api/reindex` with `Content-Type: application/json` and body
  `{"pattern":"idioti"}`, and returns the parsed JSON.
- **`app.js`**: node harness extracting the real `reindexSearch` (and the
  visibility logic). Stub `Api.reindex`, a `search` spy, `navigator.onLine`, and
  fake timers. Assert:
  - `started` (matched 3) → button shows "Reindexed 3", disabled; after the timer
    fires, `search` is called again and the button is restored.
  - `truncated` true → label includes "+" / "narrow".
  - `nothing matched` → no re-search call; button restored.
  - `Api.reindex` throws → "Reindex failed"; button restored; no re-search.
  - visibility helper: hidden when `navigator.onLine` false or query empty; shown
    when online and non-empty.
- **`node --check`** on app.js and api.js.
- **Manual**: search a known-incomplete query (e.g. a recent month with missing
  episodes), click Reindex, confirm new episodes appear after ~5s; clear the box →
  button hides; toggle offline → button hides; `already running` path by
  double-clicking quickly (second is gated by the disabled state) or reindexing a
  large query twice.

## Out of scope

- No progress bar / polling beyond the single delayed re-search (YAGNI; matched
  sets are tiny).
- No per-row reindex (header button only, per design decision).
- No new caching / IndexedDB stores.
- Cannot trigger a full-corpus rebuild from the UI (empty pattern is rejected by
  the backend; the button is gated on non-empty anyway). Full rebuild stays CLI.

## Files touched

- `offline/offline.py`: `/api/reindex` POST proxy.
- `offline/static/api.js`: `Api.reindex`.
- `offline/static/app.js`: header button in `renderFind`, visibility in `search`,
  `reindexSearch` handler.
- `offline/static/app.css`: `.results-head` + button styling.
- `docs/specs/2026-06-28-reindex-button-ui-design.md`: this document.
