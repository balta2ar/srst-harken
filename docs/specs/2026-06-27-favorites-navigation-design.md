# Favorites navigation: podcast / date / timestamp clicks

Date: 2026-06-27
Status: approved, implementing

## Goal

In the Favorites view, make parts of each (group) row navigable:

1. Click the **podcast name** -> open Find, search for that podcast.
2. Click the **episode date** -> open Find, search for that podcast + date.
3. Click the **timestamp** -> open the Listen view positioned at that favorite's moment.

All targets use the group's earliest member (`group[0]`) for filename/start.
No backend changes.

## Changes

### Split the row meta + make the timestamp clickable (`_renderFav`)
Today meta is one text node `podcast · date · N lines`. Split into:
- `<span class="link" podcast>` -> `gotoFind(podcastOf(file))`
- `<span class="link" date>` -> `gotoFind(podcastOf(file) + " " + dateOf(file))`
- plain ` · N lines` suffix (only when group length > 1)

The `ts` span gets `class="ts link"` and `onclick -> jumpToFavorite(file, group[0].start)`.

### `gotoFind(query)`
Switch to Find and run a search with `query`:
- `renderFind(query)` then `showView("find")`.

Refactor `renderFind(initialQuery)` to accept an optional query: after building the
view, if `initialQuery` is set, set the input value and call `search(initialQuery, resultsBox)`.
Backward compatible (no arg -> behaves as today).

Query formats (verified against live /api/scopes):
- podcast only: `"idioti"` -> all that podcast's episodes.
- podcast + date: `"idioti 20260608"` -> exactly that episode's segments. `dateOf` is
  already `YYYYMMDD`.

### `jumpToFavorite(filename, startStr)`
- `key = episodeKeyOf(filename)`.
- If `DB.get("episodes", key)` exists (cached):
  - `await openEpisode(key)` (builds tl, renders lines, shows Listen, autoscroll off).
  - Find `idx` of the line where `ln.vtt === filename && ln.startStr === startStr`
    (start-string match, same identity used elsewhere).
  - If found: `setActive(idx)`; scroll that line into center; seek audio to the line's
    start WITHOUT playing (`loadSegment(segIndex)` if needed, set
    `el.player.currentTime = ln.start`, update clock). Do not call `play()`.
- Else (uncached): `gotoFind(podcastOf(filename) + " " + dateOf(filename))` so the user
  can download it first.

A small helper `seekLine(idx, { play })` factors the seek/highlight/clock update so both
`playLine` (play:true) and `jumpToFavorite` (play:false) share it. `playLine` keeps its
current behavior.

## CSS
`.link { cursor: pointer; }` and a subtle affordance (color: #0d6efd) on
`.fav .meta .link`. The `ts.link` reuses the same cursor.

## Out of scope
- No auto-download on timestamp tap (uncached -> Find fallback instead).
- No backend changes.

## Verification (no pytest; per AGENTS.md)
- Node harness: `gotoFind` query string for podcast vs podcast+date; `jumpToFavorite`
  branch selection (cached -> openEpisode + seek + setActive, no play; uncached ->
  gotoFind) using stubbed DB/openEpisode/showView spies.
- Node harness: `seekLine(idx,{play:false})` does not call player.play; `{play:true}` does.
- `node --check`; element-id cross-ref; live HTTPS asset smoke; favorites count intact.
- Manual: tap podcast -> Find shows that podcast; tap date -> Find shows that episode;
  tap timestamp on a cached fav -> Listen positioned + highlighted (no autoplay); tap
  timestamp on an uncached fav -> Find pre-searched.
