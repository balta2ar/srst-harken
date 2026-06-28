# Favorites: local-first render + persisted line-order — design

## Problem (root-caused)

Opening the Favorites tab is slow and re-fetches data that should be cached:

1. **Render blocks on the network.** `_renderFav` `await`s `buildLineIndexResolver`
   before building any DOM, and that resolver `await`s `Api.lines(filename)` over
   the network for any favorited file whose order isn't locally cached. So the
   first paint is gated on network round-trips.
2. **Line-order is never persisted.** The resolver reads order from the
   `segments` store, which is only populated by an explicit episode *download*.
   For favorited-but-not-downloaded episodes it always falls through to
   `/api/lines`, and the fetched order is kept only in a transient per-render map
   — so every Favorites open refetches the same `lines?scope=…`. `/api/lines`
   also has no `Cache-Control`, so the browser HTTP cache can't help.
3. **Clip-id churn.** Clip identity (`filename|start|end`) depends on grouping,
   which depends on the resolver. When a render runs with an incomplete resolver
   (order unknown), groups fragment and clip ids differ from a fully-resolved
   render — causing IndexedDB clip-cache misses and redundant `/api/clip` fetches.

Desired: display local favorites **immediately**, then reconcile and fetch
clips in the background, adding play affordances as clips become available — with
no repeat network fetches for immutable line-order or clips.

## Fix

### A. Persist line-order (IndexedDB `lineorder` store, DB v3 → v4)

- New object store `lineorder`, `keyPath: "filename"`, record
  `{ filename, starts: [<vtt start string>, …] }`. Additive upgrade (guarded
  `if (!contains)`), preserving all existing stores — no data loss.
- `buildLineIndexResolver(filenames)` reads order per file in this priority:
  1. `lineorder` store (local, persisted from any prior fetch/download).
  2. `segments` store (downloaded episodes) — and opportunistically mirror its
     `starts` into `lineorder` so future resolves skip the segments lookup.
  3. Online only: `Api.lines(filename)` — and **persist** the result to
     `lineorder` so it is fetched at most once per file, ever.
- Line order for a given VTT file is immutable (derived from the fixed VTT), so
  caching it indefinitely is safe.

### B. `/api/lines` immutable cache header (offline proxy)

- The `/api/lines` proxy response gains
  `Cache-Control: public, max-age=31536000, immutable` (added in `offline.py`,
  scoped to `/api/lines` only — NOT the mutable favorites/listens proxies).
- This is belt-and-suspenders: the IndexedDB `lineorder` store is the primary
  de-dup (the request normally won't fire at all), but the header lets the
  browser short-circuit any that do.

### C. Local-first `_renderFav` (no network on the paint path)

Split favorites rendering into an immediate local paint plus a background refine:

- **`resolveLocalOrder(filenames)`** — like `buildLineIndexResolver` but reads
  ONLY `lineorder` + `segments` (no network). Synchronous w.r.t. the network
  (only fast IndexedDB reads).
- **`_renderFav()`** builds and commits rows using `resolveLocalOrder`. Favorites
  whose order is locally unknown render ungrouped (each as its own row) — but
  they render **immediately**. No `await Api.lines`, no network on this path.
  (Per-row `epStartForFav` already reads only local IDB; it stays.)
- **Background refine (online only):** after the immediate paint, if any file's
  order was unknown locally, fetch+persist it (via the resolver's persistence in
  A), then call `renderFav()` again to repaint with correct grouping. The
  existing `renderFav` coalescing guard (`_running`/`_again`) handles the repaint.
- **Clips:** `prefetchClips()` continues in the background (unchanged trigger);
  once a group's clip is cached, its ▶ plays. Because grouping is now stable
  across the immediate and refined paints (order persisted), clip ids are stable
  and IndexedDB hits avoid refetching.

### Flow on Favorites open

1. `navFav`: `showView("fav")` → `renderFav()` (immediate local paint) → if online
   `syncFavorites().then(() => { renderFav(); refineFavOrder().then(renderFav); prefetchClips(); })`;
   offline → `prefetchClips()` (prune-safe no-op offline).
2. First paint shows every local favorite right away (grouped where order is
   known, ungrouped otherwise).
3. Background: favorites sync (server reconcile) → repaint; missing line-order
   fetched once + persisted → repaint with final grouping; clips prefetched →
   buttons become playable.

## Out of scope (YAGNI)

- Caching `/api/lines` on the uttale backend itself (the offline proxy header +
  IndexedDB persistence suffice; line order is derived from immutable VTT).
- A visible skeleton/spinner (favorites paint instantly from local data).
- Changing clip identity or the export span.

## Verification (no pytest)

- offline: `node --check`; `fake-indexeddb` harnesses extracting the REAL
  functions to assert:
  - `lineorder` store round-trips; DB v4 preserves existing stores.
  - resolver reads `lineorder` first; on a network fetch it **persists** to
    `lineorder`; a second resolve makes **no** `Api.lines` call.
  - `_renderFav` commits rows WITHOUT any `Api.lines` call (local-first), and a
    file with no local order renders ungrouped immediately; after order is
    persisted, a re-render groups it.
  - clip ids identical between the unknown-order and known-order render for an
    adjacent multi-line group once order is present (stability).
- Live smoke: `/api/lines` response carries the immutable `Cache-Control`.
- Manual: open Favorites, switch away and back — favorites appear instantly and
  the network panel shows no repeat `lines?scope=` or `clip?` requests.
