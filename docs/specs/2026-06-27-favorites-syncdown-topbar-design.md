# srst-offline — favorites sync-down + top-bar tweaks design

Date: 2026-06-27

## Goals

1. **Show all favorites (local + remote).** The Favorites view currently renders
   only local IndexedDB favorites, and the app never fetches the server's list, so
   on any origin/device without locally-marked favorites the view is empty — even
   though the server has them. Fix: pull the server list down, reconcile into
   IndexedDB, render the union. (Bug + the requested "display both local and
   remote, sync with remote when we can".)
2. **Top bar:** remove prev/next-line buttons; keep only play/pause; move play/pause
   and the clock into the top bar, right after the Favorites tab.
3. **Status icons:** replace the confusing `⛅`/`⚡` with 📶 (online) / ✈️ (offline)
   + pending count.

## Root cause (#1, verified)

`renderFav` reads only `DB.all("favorites")` (local IndexedDB). `offline.py` has no
GET that lists favorites; `syncFavorites` only POSTs (`pending`) and DELETEs
(`deleted`) — it never *fetches*. The live server (`GET /uttale/Favorites`) has 7
favorites with full fields (`filename, start, end, text, comment, created_at,
updated_at, exported_at`). So a fresh local store renders nothing.

## Section 1 — Favorites sync-down + reconcile

### Server: new `GET /api/favorites`

In `offline.py`, add a route in `do_GET`: `/api/favorites` →
`_proxy_json("/uttale/Favorites", {"sort": "created_desc"})` → returns the uttale
list JSON unchanged (`{results:[...]}`). Online-only; SW already bypasses `/api/*`.

### Client: `Api.favList()`

In `api.js`: `favList()` → `GET /api/favorites` → `r.json()` (shape `{results:[...]}`).

### Client: `syncFavorites` becomes bidirectional

Order each run (still gated on `navigator.onLine`):

1. **Sync up (unchanged):** for each local favorite — `pending` → `Api.favAdd` (on
   ok set `synced`); `deleted` → `Api.favDel` (on ok or 404 `DB.del`).
2. **Pull down + reconcile:** `const data = await Api.favList();` (guard against
   failure — on throw, skip the pull, keep what we have). Build `serverByKey` keyed
   by `filename + "|" + start`. Re-read local `DB.all("favorites")`. Then:
   - **server item, no local row** → `DB.put({id, filename, start, end, text,
     status:"synced", updatedAt: <server updated_at or now>, exported_at:
     <server exported_at>})`.
   - **server item, local `synced`** → update `text`, `end`, `exported_at` from
     server; keep `status:"synced"`; `DB.put`.
   - **server item, local `pending` or `deleted`** → leave untouched (local intent
     wins; step 1 already attempted the flush). Note: step 1 runs first in the same
     pass, so a `pending` row that successfully POSTed is already `synced` by the
     time the pull re-reads `DB.all`, and is then handled by the "local `synced`"
     branch above. The `pending`/`deleted` branch therefore only covers rows whose
     flush failed (still offline-ish / server error) — correctly left queued.
   - **local `synced` whose key is ABSENT from server** → deleted elsewhere →
     `DB.del(id)`.
   - **local `pending`/`deleted` absent from server** → leave (still queued).

   Reconcile key = `filename + "|" + start` (same as the favorite `id`).

Net: IndexedDB becomes a durable, offline-readable mirror of the server, overlaid
with unflushed local `pending`/`deleted`. Offline: `syncFavorites` returns early,
nothing pulled, render from the existing mirror.

### When it runs

`syncFavorites` is already called on boot (when online) and on the `online` event.
Add: call it (then re-render) when the **Favorites tab is opened** while online.
The order is sync-up→pull, so the view reflects just-made local changes.

### Render

`renderFav` keeps reading `DB.all("favorites")` minus `deleted`, newest-first — but
the set now includes pulled-down server favorites. To avoid a blank wait:
`renderFav` renders immediately from current IndexedDB, and if online kicks off
`syncFavorites().then(() => re-render)` so server items appear a moment later.
`epStartForFav` already falls back to segment-relative time when the favorite's
episode isn't cached locally, so server-only favorites render fine (text +
podcast/date + time + ✈/✓ from `exported_at`).

Knock-on: `updateStatus` (pending count) and `renderMarks` (scrubber ticks) read
IndexedDB, so they reflect the merged set after a pull.

## Section 2 — Top bar (#2) + status icons (#3)

### Layout

Single `#bar` row: `[Find][Listen][Favorites]  [▶/⏸][clock]  …  [status chip]`.
- Move play/pause (`#t-play`) and clock (`#clock`) into `#bar` right after the
  `#nav-fav` tab, wrapped in a `#nowplaying` span.
- **Remove** prev-line (`#t-prev`), next-line (`#t-next`), and the whole
  `#transport-top` sub-row from `index.html`.
- `#nowplaying` (play/pause + clock) is shown only in Listen view; `showView`
  toggles it (replacing the old `#transport-top` toggle). The status chip stays
  far-right via `margin-left:auto`.
- Bottom `#transport`/`#scrubber` unchanged (still the seek control).

### JS impact (app.js)

- Drop `el.tPrev`, `el.tNext` and their `onclick` handlers; drop `el.transportTop`.
- Add `el.nowplaying`. `showView`: `el.nowplaying.hidden = which !== "listen";`
  (keep `el.transport.hidden = !listening`).
- Keep `el.tPlay` + its click handler and the `play`/`pause` listeners; keep
  `el.clock` + `updateClock`; keep `timeupdate`/`ended`; keep the scrubber.

### Status icons

`updateStatus`: `el.status.textContent = (navigator.onLine ? "📶" : "✈️") + " " +
pending;` Tooltip unchanged (`online/offline · N pending`).

### CSS

- Add `#nowplaying` (inline-flex, gap, align-center) and hide via `[hidden]`.
- `#bar` stays flex; ensure `#status` keeps `margin-left:auto`.
- Remove the now-unused `#transport-top` rules. `#clock` keeps tabular-nums.
- `#transport`/scrubber CSS untouched.

## Files touched

| File | Change |
|---|---|
| `offline/offline.py` | add `GET /api/favorites` route (proxy uttale Favorites list) |
| `offline/static/api.js` | add `favList()` |
| `offline/static/app.js` | bidirectional `syncFavorites` (pull+reconcile); Favorites-open sync; `renderFav` render-then-refresh; `showView`/`updateStatus` changes; drop prev/next + `#transport-top` refs; add `#nowplaying` |
| `offline/static/index.html` | single-row bar (play/pause + clock after Favorites); remove prev/next + `#transport-top` |
| `offline/static/app.css` | `#nowplaying` styling; remove `#transport-top` rules |

No DB schema change (same `favorites` store + `id = filename|start` + status
machine). No SW change (no new shell assets; `/api/favorites` is a `/api/*` route
the SW already bypasses).

## Error handling

- `/api/favorites` upstream failure → `_proxy_json` returns 502; client
  `Api.favList()` throws → reconcile pull skipped, existing mirror kept.
- Offline → `syncFavorites` early-returns; Favorites renders from mirror.
- Reconcile never deletes a local `pending`/`deleted` row (intent preserved); only
  removes `synced` rows missing from the server.

## Testing / verification

No automated suite (AGENTS.md). Verify:
- `python -m py_compile offline/offline.py`; `node --check` each JS file.
- Server smoke (live :7010, spare port, `--ssl`): `GET /api/favorites` returns the
  list with `results_count == 7` (current real baseline — do NOT disturb the 7 real
  favorites); all shell assets still 200.
- A node `fake-indexeddb` harness for the reconcile logic: seed a local store with a
  `synced` row absent from a fake server list (expect removed), a `pending` row
  (expect kept), and a server-only item (expect inserted as `synced`); assert the
  resulting store. (Pure-ish; mirrors how the real `syncFavorites` reconcile maps
  inputs→store.)
- Browser-only behavior (favorites now appear on a fresh origin; bar layout; icons)
  is the manual checklist in SESSION.md.

## Non-goals (YAGNI)

- No comment-editing, no block-grouping, no per-podcast filtering.
- No change to download/listen/scrubber/export logic beyond the bar move.
- No new IndexedDB stores or SW shell entries.
- Keep emoji status icons (📶/✈️) rather than SVG, per request.

## Risks

- Reconcile correctness (the local-intent-wins rules) is the main risk; covered by
  the fake-indexeddb harness + manual check.
- Single-origin caveat from the prior round still applies: the mirror is per-origin,
  so open via one stable (Tailscale) hostname. The dismissible banner already warns.
