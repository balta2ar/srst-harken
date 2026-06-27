# Topics in the srst-offline Listen view — design

Date: 2026-06-27
Repo: `srst-harken` (`offline/`). Depends on the uttale `GET /uttale/Topics`
endpoint (spec: `docs/specs/2026-06-27-topics-api-design.md`).

## Goal

Optionally display background-generated chapter markers ("topics") in the
Listen view. Topics are episode-level (one `topics` file per podcast dir),
fetched from the backend keyed by the first segment's filename. They must be:

- **Optional** — episodes without topics look exactly as today (no panel, no
  ticks, no errors).
- **Navigable / clickable** — tapping a topic seeks the player there and plays.
- **Available offline** — once fetched online, cached so they show offline too.

## Source data

`GET /uttale/Topics?filename=<first-segment vtt>` returns:

```json
{ "filename": "...by10m_00.vtt", "results_count": 17,
  "results": [ { "title": "Velkommen tilbake ...", "start": "00:00:39.000" }, ... ] }
```

`start` is an **episode-absolute** VTT timestamp (the topics file covers the
whole episode), seconds-precision padded to `.000`.

## Data flow & caching

1. **Proxy** (`offline/offline.py`, `do_GET`): add
   `elif parsed.path == "/api/topics": self._proxy_json("/uttale/Topics",
   {"filename": q.get("filename", [""])[0]})`. Mirrors `/api/lines`.
2. **Client API** (`offline/static/api.js`): add
   `topics(filename)` -> `fetch("/api/topics?filename=" +
   encodeURIComponent(filename))`, returning parsed JSON; on network failure
   resolve to `{ results: [] }` (graceful, like `lines`). Export in the returned
   object.
3. **Load on open** (`offline/static/app.js`, `openEpisode`): after `tl =
   Timeline.build(...)`, call `await loadTopics(ep)`:
   - If `navigator.onLine`: `const data = await Api.topics(ep.segments[0])`.
     On a usable response, set `ep.topics = data.results` and
     `await DB.put("episodes", ep)` (persist for offline), use `data.results`.
   - Else / on failure: use `ep.topics` from the cached episode record (may be
     undefined).
   - Build `tl.topics = (results || []).map((t) => ({ title: t.title,
     start: t.start, epStart: Timeline.tsToSeconds(t.start) }))`.
     `epStart` is episode-absolute seconds (no segment offset; topics are
     episode-level).
   - `loadTopics` never throws; any error -> `tl.topics = ep.topics-derived ||
     []`.
4. Refresh-on-open: each online open re-fetches and overwrites `ep.topics`, so
   newly generated topics appear on the next visit.

`Timeline.tsToSeconds` and `Timeline.fmt` are already exported
(`timeline.js:63`), so no timeline changes are needed beyond reusing them.

## UI: collapsible panel

New markup inside `<section id="view-listen">`, above `<ol id="lines">`
(`offline/static/index.html`):

```html
<div id="topics" hidden>
  <button id="topics-head" aria-expanded="false">
    <span id="topics-caret">▸</span> ☰ <span id="topics-count"></span>
  </button>
  <ol id="topics-list" hidden></ol>
</div>
```

- Header uses the **☰ list glyph** plus the count (e.g. `▸ ☰ 17`); no literal
  word "Topics". Caret `▸` collapsed / `▾` expanded.
- **`renderTopics()`** (sibling of `renderLines`, `app.js`):
  - If `!tl.topics || !tl.topics.length` -> `el.topics.hidden = true`; return.
  - Else: `el.topicsCount.textContent = tl.topics.length`; clear and rebuild
    `el.topicsList` with one `<li class="topic">` per topic, children
    `[span.ts = Timeline.fmt(t.epStart), span.title = t.title]`;
    `li.onclick = () => seekTopic(t)`. Set `el.topics.hidden = false` and apply
    the current collapse state.
- **Collapsed by default.** Module global `topicsOpen = false`. `topics-head`
  click toggles it, toggles `el.topicsList.hidden`, swaps caret glyph, sets
  `aria-expanded`. `topicsOpen` persists across episodes within the session
  (not reset by `openEpisode`); page reload resets to collapsed.
- `el` refs added: `topics`, `topicsHead`, `topicsCaret`, `topicsCount`,
  `topicsList`.
- `renderTopics()` is called from `openEpisode` after `renderLines()`.

`showView` already hides the whole `#view-listen` section in non-listen views,
so the panel needs no extra visibility handling there.

## UI: scrubber ticks

Reuse the existing `#scrub-marks` overlay (currently favorites-only).

- **`renderTopicMarks()`**: for each `tl.topics`, append
  `<div class="topic-mark">` with `style.left = (100 * t.epStart / tl.total) +
  "%"`. Guard on `tl.total`.
- New CSS `.topic-mark` in a **distinct color** from favorites' gold
  (`#f5b301`): blue `#0d6efd`, ~2px wide, positioned `top/bottom` like `.mark`
  but visually subordinate (e.g. slightly inset top/bottom or lower opacity) so
  favorite ticks stay prominent. Favorites' `.mark` styling is untouched.
- **Coexistence / clearing:** refactor `renderMarks()` (favorites) to clear only
  its own marks — `el.scrubMarks.querySelectorAll(".mark").forEach(n =>
  n.remove())` instead of `innerHTML = ""` — so toggling a favorite does not wipe
  topic ticks. `renderTopicMarks()` similarly clears only `.topic-mark`.
- Both are called from `openEpisode`; `toggleFavorite` calls only
  `renderMarks()` (topic ticks persist).

## Seek behavior

`seekTopic(t)`:
- `seekEp(t.epStart)` — existing primitive (`app.js:335`): maps episode-time ->
  segment, loads the segment blob if needed, sets `currentTime`, and **plays**.
- Then `scrollToCurrent()` (`app.js:353`, scrolls the active line into view,
  `block:"center"`) so the transcript jumps to the chapter even when autoscroll
  is off. `setActive` runs on the player's `timeupdate` after the seek; to avoid
  scrolling before the active line is recomputed, `seekTopic` schedules the
  scroll on the next event-loop tick (`setTimeout(scrollToCurrent, 0)`), which
  fires after the seek's `timeupdate`/`setActive`. (If verification shows the
  tick is unreliable, fall back to computing the target idx via
  `Timeline.lineAtEpTime(tl, t.epStart)` and scrolling that line directly.)
- Net effect: **seek + play + scroll**, matching a transcript-line tap.

## Optionality / error handling

- No topics file / empty results / offline-and-uncached -> panel hidden, no
  ticks. No console errors; `loadTopics` swallows failures.
- A malformed cached `ep.topics` is treated as empty.
- The feature adds nothing to the UI when absent — episodes behave exactly as
  before.

## Components (isolation)

- `Api.topics(filename)` — pure fetch wrapper, graceful failure.
- `loadTopics(ep)` — fetch/cache/fallback, produces `tl.topics`. No DOM.
- `renderTopics()` — DOM for the panel from `tl.topics`. No fetch.
- `renderTopicMarks()` — DOM for scrubber ticks from `tl.topics`. No fetch.
- `seekTopic(t)` — thin: `seekEp` + `scrollToCurrent`.

Each is independently testable; only `loadTopics` touches IndexedDB, only the
two `render*` touch the DOM.

## Testing & verification (AGENTS.md: no pytest)

- `node --check` on `app.js`, `api.js`; `py_compile` on `offline.py`.
- **Live** (offline server on a spare port 7021-7029, kill by saved PID):
  - `curl -k "/api/topics?filename=48k/VernaBedrift/20260623/by10m/by10m_00.vtt"`
    -> 17 topics.
  - `curl -k "/api/topics?filename=<no-topics>.vtt"` -> `{... "results": []}`.
- **Node harness** (`fake-indexeddb`, extracting the REAL functions):
  - `renderTopics`: N topics -> N `.topic` rows with correct `Timeline.fmt`
    text and `onclick` -> `seekTopic`/`seekEp(epStart)`; empty -> panel hidden.
  - `renderTopicMarks`: ticks at expected `left%`; favorites + topic marks
    coexist; `renderMarks` clears only `.mark` (topic ticks survive a favorite
    toggle).
  - caching: online open path stores `ep.topics` in IndexedDB; offline open
    reads it back into `tl.topics`.
- Element-id cross-ref (all `getElementById` ids exist in `index.html`).
- Asset + `/api/favorites` smoke (unchanged routes still 200).
- **Manual on-device checklist** (user runs): panel appears only with topics;
  collapse/expand via header; tap topic seeks + plays + scrolls; ticks visible
  and distinct from gold favorites; works offline after one online open;
  starring a line does not remove topic ticks.

## Out of scope (YAGNI)

- No exact transcript-line resolution for topics (seek by time only).
- No editing/creating topics from the UI (generated offline).
- No topics in Find/Favorites views.
- No SW precaching of `/api/*` (already bypassed; topics persist via the
  episodes IndexedDB record).
