# srst-offline — UI/playback enhancements + Favorites view design

Date: 2026-06-27

## Goal

Make the offline player's Listen view actually usable on a phone while a podcast
plays in another app, and add a Favorites overview with Telegram export. Concretely
the eight changes requested:

1. Playback transport (prev-line / play-pause / next-line) reachable at all times
   (top bar), not only via the scrolled-away native audio element.
2. Active line advances automatically while audio plays (currently it never moves).
3. Episode-absolute timestamps (HH:MM:SS): a current/total clock in the top bar, a
   small subscript on each line, and a custom bottom **episode scrubber** for
   whole-episode navigation (with favorite markers), seeking by tap/drag. The
   custom bottom panel is this scrubber (not the native media element).
5. Compact icon top bar: Find / Listen / Favorites + an online·N-pending chip.
6. A Favorites view (local, per-line) with per-line Telegram **send** and an
   **Export all (unexported)** action, reusing harken's server-side telegram path.
7. Prefilled search chips above the search box (hardcoded list).
8. Search results ordered by episode date, newest first.

Plus an operational fix surfaced during design: cross-network storage (see
"Single-origin requirement").

## Context (current state)

`offline/static/`: `index.html` (2 views: Find, Listen), `app.css`, `db.js`
(IndexedDB wrapper: `DB.open/put/get/del/all`; stores `episodes`/`segments`/
`favorites`), `app.js` (264 lines: element refs, `episodeKeyOf/podcastOf/dateOf`,
`showView`, `updateStatus`, View 1 find/download, View 2 listen/favorite, sync,
boot), `sw.js` (precaches shell, bypasses `/api/*`).

`offline/offline.py`: stdlib HTTPS server; proxies `/api/scopes|lines|audio` (GET),
`/api/favorite` (POST/DELETE). Imports `subprocess` (cert gen). Favorite records:
`id = filename + "|" + start`, fields `{id, filename, start, end, text, status,
updatedAt, exported_at?}`, status `pending|synced|deleted`.

harken's telegram path (to reuse): `TELEGRAM_SEND_VOICE =
/home/bz/rc.arch/bz/bin/telegram-send-voice`; fetch clip `GET /uttale/Audio?
filename=<ogg>&start=<s-0.5>&end=<e+0.5>` → temp `.ogg` → run script with
`-m "#<podcast> #wtf\n<text>"`; stamp `POST /uttale/Favorites/Update {filename,
start, set_exported:true}`.

## Single-origin requirement (operational, with in-app safeguard)

IndexedDB / Cache Storage / service workers are partitioned per **origin**
(`scheme://host:port`). Opening the app via the home LAN IP
(`https://192.168.1.4:7020`) and later via a Tailscale IP
(`https://100.x.y.z:7020`) are **different origins → separate IndexedDB**, so
favorites and the pending-sync queue marked at home would be invisible at work.

**Fix (operational):** always open the app via a single stable hostname on every
network — recommended: the Tailscale MagicDNS name
(`https://<host>.<tailnet>.ts.net:7020`), which is one origin everywhere and can
also get a real TLS cert (which additionally avoids the mobile self-signed-cert
service-worker risk). Documented in run notes.

**In-app safeguard (non-blocking):** on boot, if `location.hostname` is a raw
IPv4/IPv6 literal and not previously dismissed, show a slim **dismissible** top
banner: "Open via your Tailscale name so favorites travel across networks." It
pushes content down (does not overlay), and an ✕ stores
`localStorage["origin-hint-dismissed"]=1` to hide it permanently. DNS/`.ts.net`
hostnames show no banner. Never blocks use.

## Architecture / file structure

Client JS is split so each unit has one responsibility (roughly doubling app.js
otherwise):

| File | Responsibility |
|---|---|
| `offline/static/db.js` | IndexedDB primitive (unchanged) |
| `offline/static/api.js` | **new**: fetch wrappers for `/api/*` (scopes, lines, audio URL, favorite add/del, export) — no DOM |
| `offline/static/timeline.js` | **new**: pure episode-timeline model + time math + `fmt(secs)→H:MM:SS` — no DOM, no network |
| `offline/static/app.js` | views/UI wiring: top bar, transport, scrubber, find/listen/favorites views, banner, boot |
| `offline/static/index.html` | shell: icon top bar, transport sub-row, three view sections, fixed bottom panel, script tags for api.js/timeline.js |
| `offline/static/app.css` | styling for compact bar, scrubber, line subscripts, favorites rows, banner |
| `offline/static/sw.js` | add `/api.js`,`/timeline.js` to SHELL precache |
| `offline/offline.py` | add `POST /api/export` (server-side telegram) |

`index.html` loads scripts in order: `db.js`, `api.js`, `timeline.js`, `app.js`.

## timeline.js — episode timeline model (approach A: from VTT)

Built on `openEpisode` from the cached segments (no audio decoding, fully offline).

```
buildTimeline(segments) -> {
  segments: [ { vtt, offset, duration, lines:[{start,end,text}] } ],
  total,                       // sum of durations
  lines:    [ { vtt, segIndex, start, end,        // start/end: segment-relative secs
                epStart, epEnd, text, idx } ]       // epStart/epEnd: episode-absolute secs
}
```

- segment `duration` = its last line's `end` (secs); `offset` = cumulative sum of
  prior durations; if a segment has no lines, duration 0.
- line `epStart = segment.offset + line.start`, `epEnd = segment.offset + line.end`.

Pure helpers (DOM-free, node-checkable):
- `fmt(secs)` → `H:MM:SS` (e.g. `0:12:47`, `1:03:09`).
- `lineAtEpTime(timeline, t)` → index of line whose `[epStart, epEnd)` contains `t`
  (or nearest preceding line); binary search over `lines`.
- `segAtEpTime(timeline, t)` → `{segIndex, segLocalTime}` where `segLocalTime =
  t - segments[segIndex].offset`.
- `tsToSeconds(vttString)` → secs (moved here from app.js; handles `.`/`,` and
  missing ms).

## Listen view — playback mechanics

Player state in app.js: `audioVtt` (which segment blob is loaded), `currentSeg`
(active segment index), `tl` (current timeline).

**Top transport sub-row (#1):** prev-line, play/pause (icon toggles), next-line,
then clock `fmt(epNow) / fmt(total)`. Always visible while in Listen view (sticky
top). prev/next move by line index over `tl.lines`.

**Per-line render (#3):** each line shows text + a small grey subscript
`fmt(line.epStart)`. Star toggles favorite (existing logic, keyed
`vtt + "|" + start`).

**Active-line follow (#2):** one `timeupdate` listener on the hidden `<audio>`:
- `epNow = tl.segments[currentSeg].offset + audio.currentTime`.
- `i = lineAtEpTime(tl, epNow)`; if changed, move `.active` to line `i` and
  `scrollIntoView({block:"nearest", behavior:"smooth"})` when off-screen.
- update top clock and move scrubber handle to `epNow / total`.

**Auto-advance across segments (#2):** on `<audio>` `ended`, if `currentSeg` is not
the last segment, load next segment blob, set `audioVtt`/`currentSeg`, seek 0,
`play()`. Else stop.

**Bottom episode scrubber (#3):** a full-width bar (fixed bottom panel,
`#transport`, Listen only). Handle at `epNow/total`. Favorited lines drawn as small
ticks at `epStart/total`. Tap/drag → fraction `f` → `epTarget = f*total` →
`{segIndex, segLocalTime} = segAtEpTime(tl, epTarget)` → swap blob if
`segIndex≠currentSeg`, set `currentTime = segLocalTime`, `play()`, highlight/scroll
the line. Native `<audio>` kept but visually hidden (no `controls`).

**playLine(i):** from `tl.lines[i]` — swap blob if its `vtt≠audioVtt` (update
`currentSeg`), `currentTime = line.start`, `play()`; `timeupdate` takes over.

## Find view changes

**Prefilled chips (#7):** `SEARCH_CHIPS = ["idioti 2026","kontakt 2026",
"saltIAran 2026","VernaBedrift 2026","heimelaga 2026"]`. Rendered as a small wrap
row of grey pills above the search input; tapping sets input value and runs search
immediately.

**Date-DESC ordering (#8):** in `search()`, after grouping scopes by episode key,
sort episodes by `dateOf(seg)` (the `YYYYMMDD` segment) **descending**, ties by
podcast name. (`YYYYMMDD` strings sort lexicographically = numerically.) Newest
episode across all matching podcasts first. Cached list unchanged.

## Compact top bar (#5)

Three icon tab `<button class="tab">` (inline SVG, offline-safe): magnifier=Find,
list=Listen, star=Favorites; `aria-label`+`title`; active tab highlighted. Status
chip right-aligned: cloud (online) / cloud-off (offline) glyph + pending count when
>0; tooltip "online · N pending". The Listen transport sub-row is a separate
container shown only when Listen is active.

## Favorites view (#6)

New `#view-favorites` section.

**Content:** `DB.all("favorites")` excluding `status==="deleted"`, sorted by
`updatedAt` desc. One row per favorite: timestamp + podcast/date context, line
text, **delete** action (calls the existing `toggleFavorite` so it reuses the same
branch logic: drop a `pending` row, tombstone a `synced` one), **Telegram send**
(paper-plane). Exported favorites (`exported_at` set) marked (greyed icon / "✓
sent"). Timestamp is episode-absolute when that episode is cached (compute via
`buildTimeline`); otherwise falls back to the segment-relative `start` (no offsets
offline).

**Export all (unexported):** top button; sends only favorites with empty
`exported_at`, sequentially, with progress ("sent 2/5"); skips exported. Online-only.

**Server endpoint `POST /api/export`** (offline.py), body `{filename, start, end,
text}`:
1. fetch clip `GET /uttale/Audio?filename=<with .ogg>&start=<start-0.5s>&
   end=<end+0.5s>` → bytes → temp `.ogg`. Port harken's `parse_ts`/`format_ts`/
   `clip_ts` (or compute the ±0.5s padded VTT strings inline) into offline.py.
2. run `TELEGRAM_SEND_VOICE` with `-m "#<podcast> #wtf\n<text>"` (podcast = 2nd
   path segment).
3. on success `POST /uttale/Favorites/Update {filename, start, set_exported:true}`.
4. return `{status:"sent"}` or `{status:"error","detail":...}` (non-200 on failure).

Client send button → `POST /api/export` → on success set local favorite
`exported_at` and re-render row. `/api/export` is online-only (SW bypasses
`/api/*`); offline it fails fast → UI shows "needs connection".

New imports in offline.py: `tempfile` (subprocess already imported). Copied
constants: `TELEGRAM_SEND_VOICE`, ±0.5s padding, caption format (kept
dependency-free, consistent with cert helpers copied from harken).

## Error handling

- Telegram script non-zero exit → `/api/export` returns error+detail → client
  shows "export failed: <detail>" (mirrors harken).
- Export/scrubber/timeline never run network calls offline except `/api/export`
  and search/download, which already degrade gracefully.
- Empty/short search still allowed (existing behavior); chips just prefill.
- Banner failures impossible (pure DOM); dismissal persisted in localStorage.

## Testing / verification

Repo has no automated suite (AGENTS.md) — verify via `py_compile`, `node --check`,
`curl` smoke, and a manual browser/device checklist.

- `python -m py_compile offline/offline.py`; `node --check` each JS file.
- `timeline.js` math: a small node harness exercising `buildTimeline`/`fmt`/
  `lineAtEpTime`/`segAtEpTime` with a synthetic 2-segment fixture (pure functions,
  no browser).
- Server smoke (live :7010, spare port, `--ssl`): all shell assets (now incl.
  `/api.js`,`/timeline.js`) 200 with correct MIME; `/api/export` with a throwaway
  favorite sends a real telegram message (channel is real — use an obvious test
  clip; user may delete it) and the favorite's `exported_at` gets stamped; clean
  up so the live favorites count returns to 6. Kill smoke server by PID.
- Browser-only behavior (active-line follow, auto-scroll, auto-advance, scrubber
  seek, banner, three-view nav) is a documented manual checklist in SESSION.md.

## Non-goals (YAGNI)

- No block-grouping of favorites (per-line only).
- No client-side Telegram (token must stay server-side; see analysis — would leak
  the bot token to every device for zero offline benefit).
- No exact audio-duration probing (approach A from VTT is sufficient).
- No configurable chips (hardcoded list, edited in JS).
- No recording / compression (never part of offline app).

## Risks

- VTT-derived durations omit trailing post-subtitle silence (usually <2s); episode
  total may be marginally short and a segment boundary slightly off — negligible
  for timestamp matching.
- Self-signed cert + mobile service workers (pre-existing); the Tailscale `.ts.net`
  real-cert path is the recommended mitigation, now reinforced by the single-origin
  requirement.
- `/api/export` depends on the home PC being reachable (Tailscale/LAN) and uttale
  running; online-only by design.
