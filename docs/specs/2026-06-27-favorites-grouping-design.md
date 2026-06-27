# Grouped consecutive favorites (+ Favorites flicker fix)

Date: 2026-06-27
Status: approved, implementing

## Problem

1. Opening Favorites flickers: the view renders, then `syncFavorites().then(renderFav)`
   renders again ~57ms later; each render does `el.viewFav.innerHTML = ""` then an
   async rebuild, so the user sees list -> blank -> list. (Loop already fixed; this is
   the remaining double/destructive paint.)
2. Consecutive favorites (adjacent transcript lines starred in a row) should collapse
   into one group: show only the earliest member's timestamp, the combined text, one
   Telegram send (a single combined clip), and one delete (removes the whole group).

## Adjacency model (client-side, no backend change)

A favorite's "line index" = its position in the file's start-time-sorted line list.
Verified against live data (`48k/idioti/20260608/by10m/by10m_00.vtt`, 218 lines):

- `/api/lines?scope=<file>` returns lines already sorted by start, stable across calls.
- Line starts are unique within a file -> `(filename, start)` maps 1:1 to a position.
- Timestamp touching (`end == next.start`) only holds for 34/217 pairs, so adjacency is
  NOT derivable from gaps; line-index position is. No uttale counter needed.

Two favorites group together iff same `filename` and consecutive line indices (diff 1).

### Where line order comes from
- If the favorite's episode segments are cached in IndexedDB, derive order from them.
- Else, if online, fetch `/api/lines?scope=<file>` once and memoize per-file for the render.
- Else (uncached AND offline): that file's favorites render ungrouped (singletons).
  Grouping is a display enhancement and never blocks showing favorites.

## Grouping algorithm

Input: active favorites (`status !== "deleted"`).
1. Bucket by `filename`.
2. For each file: obtain its line-start list (cached/fetched/none).
3. Sort the file's favorites by start-time. Map each to its index (position of its start
   in the line-start list). Favorites whose start is not found (line order unknown, or a
   stale favorite) are treated as singletons.
4. Walk sorted favorites; start a new group when index != previous + 1.
5. Files with unknown line order: each favorite is its own group.

A "group" is an ordered array of >=1 favorites. Group order in the list follows the
existing sort (most-recent `updatedAt` of the group's members, descending).

## Rendering (atomic; fixes flicker)

Rewrite `_renderFav` to build the whole list into a detached `DocumentFragment`, then
`el.viewFav.replaceChildren(frag)` in one mutation. No empty intermediate state, so the
two render passes on open no longer flicker.

Each group renders as ONE `.fav` row:
- timestamp = earliest member's `epStartForFav`
- text = members' texts joined in order by a space
- meta = `podcastOf(filename) · dateOf(filename)`
- send button ✈ -> sends the combined clip; shows ✓ "exported" only when ALL members
  have `exported_at`
- delete button 🗑 -> deletes every member of the group

Singletons (group size 1) render exactly as today.

## Combined Telegram send

`sendGroup(group, btn)`:
- span = first member's `start` .. last member's `end` (members ordered by line index).
- text = members' texts joined by a space.
- Call existing `Api.exportFav({ filename, start, end, text })`. The backend already
  fetches `/uttale/Audio?filename=&start=&end=` for an arbitrary span (±0.5s padding)
  and sends one .ogg, then stamps `set_exported` on `{filename, start}`.
- On success, mark each member exported locally: set `exported_at`, `DB.put`. (The
  backend only stamped the span's start; we stamp the rest client-side so the group
  shows fully-exported and they sync.)
- Re-render.

`exportAllUnexported` becomes group-aware: iterate groups, skip groups where all members
are exported, otherwise `sendGroup` them. (Singletons included.)

## Group delete

`deleteGroup(group)`: for each member call the existing
`toggleFavorite({ vtt, start, end, text }, null)` delete path (marks synced ones
`deleted`/removes pending), then one re-render.

## Out of scope
- No backend/uttale changes.
- No cross-file groups (a clip can't span two audio files).
- No persisted group entity; groups are computed on each render.

## Verification (no pytest; per AGENTS.md)
- Node harness for the pure grouping function: feed favorites + a line-index map, assert
  group boundaries (adjacent -> grouped, gap -> split, unknown order -> singletons,
  multi-file -> separate).
- Node harness: combined send computes correct span (first.start..last.end) and joined
  text, and marks all members exported.
- Render: assert `_renderFav` uses replaceChildren (no `innerHTML=""`); element-id
  cross-ref; `node --check`; live HTTPS asset smoke; favorites count unaffected.
- Manual: open Favorites (no flicker), star 3 adjacent lines -> one row with earliest
  timestamp + joined text; send -> one Telegram clip; delete -> all three gone.
