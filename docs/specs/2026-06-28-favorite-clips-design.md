# Play favorite clips (offline-capable) — design

Let the user play the short audio clip of a favorite group directly from the
Favorites tab, without downloading the whole episode, and have those clips
available offline after favorites were loaded while online.

A favorite "group" is always a run of adjacent lines in ONE file
(`groupFavorites`, app.js), so its audio is a single contiguous span — no
multi-range concatenation is needed. The backend already extracts an arbitrary
`[start,end]` clip via ffmpeg; we reuse it and add caching headers.

## Clip identity & span

- Span = export's span: `start = clipTs(first.start, -0.5)`,
  `end = clipTs(last.end || last.start, +0.5)` (±0.5 s, mirroring `clip_ts` in
  offline.py and `exportGroup` in app.js). One clip serves both playback and
  export: "what you hear is what you'd export".
- Key (IndexedDB id + backend ETag basis) = `filename | start | end`. The span
  uniquely determines immutable audio. If an adjacent favorite extends the span,
  the key changes → a new clip; the old becomes an orphan (pruned).

## Backend — `uttale/backend/server.py`

Reuse `GET /uttale/Audio` (already extracts `[start,end]`). In the
segment-extraction branch of `get_audio_segment`, return additional headers:

- `ETag: "<sha1(f"{filename}|{start}|{end}")>"`
- `Cache-Control: public, max-age=31536000, immutable`

`audio_endpoint` already sets `Vary: Origin`. `import hashlib` at top (currently
absent). The full-file and byte-range branches are unchanged.

These immutable + ETag headers let the browser HTTP cache (and any future Service
Worker) treat the clip as permanently cacheable. We do NOT add server-side
`If-None-Match`/304 conditional handling: it would be redundant because the
client's primary de-dup is the IndexedDB presence check (`getClip` never hits the
network when the clip is already stored). Keeping the endpoint unconditional also
avoids complicating the offline proxy (which streams a 200 body).

New unittest `TestAudioCaching`: ETag header is present and stable for a given
(filename,start,end), and differs for a different span. Uses a generated tiny
`.ogg` under a temp `--root` (ffmpeg available in env).

## Offline proxy — `offline/offline.py`

New `GET /api/clip?filename=&start=&end=`: convert `.vtt`→`.ogg` (like `_export`)
and forward to `/uttale/Audio` via `_proxy_audio`, passing the client's
`start`/`end` (the current `/api/audio` hard-codes them empty). Extend
`_proxy_audio` to also relay the upstream `ETag` and `Cache-Control` response
headers (today it relays only Content-Type/Content-Length). `/api/audio`
(whole-segment download) is otherwise unchanged.

## Client

### Storage — `offline/static/db.js`
Bump `VERSION` 2→3 and add a `clips` store (`keyPath: "id"`). `onupgradeneeded`
is additive (guarded `if (!contains)`), so existing episodes/segments/favorites/
listened are preserved — no data loss.

### API — `offline/static/api.js`
`Api.clipBlob(filename, start, end)` → `GET /api/clip?...`; returns a Blob, or
`null` on failure (mirrors the defensive style of `topics`/`generateTopics`).

### Logic — `offline/static/app.js`
- `clipTs(ts, delta)` — JS mirror of offline.py `clip_ts`
  (`fmtVtt(max(0, tsToSeconds(ts) + delta))`), reusing `Timeline`.
- `clipSpan(group)` → `{ filename, start, end, id }` (the ±0.5 s triple + key).
- `getClip(group)` → return cached Blob from `clips` if present; else when online
  fetch via `Api.clipBlob`, store `{ id, blob }`, return it; offline + missing →
  `null`.
- `playClip(group, btn)` — dedicated player toggle: if this clip is currently
  playing, stop (pause + reset); else stop any other clip, `getClip`, set
  `clipPlayer.src = URL.createObjectURL(blob)` (revoking the previous blob URL),
  play. Button text ▶ ↔ ⏸; on `ended`/stop, reset to ▶. Disable/short-circuit
  when `getClip` returns null (offline, uncached).
- `prefetchClips()` — enumerate current groups (reuse the `groupFavorites` +
  resolver already used by `_renderFav`); compute the set of valid clip keys.
  When online, for each group whose clip isn't cached, fetch+store (sequential,
  background, best-effort). Then delete any `clips` record whose id ∉ valid set
  (prune orphans). Guarded so it never blocks rendering.
- Wire-up: per-group ▶ button appended in `_renderFav` beside `send`/`del`;
  `prefetchClips()` invoked on boot (when online) and in `navFav` (when online),
  after favorites are reconciled.

### Markup/CSS
- `offline/static/index.html`: hidden `<audio id="clip-player"></audio>`.
- `offline/static/app.css`: `.fav .play` button + a playing state.

## Error handling

- Offline + clip not cached → Play button disabled / inert (no fetch attempt).
- Fetch failure / backend 404 (missing `.ogg`) → button re-enabled, clip simply
  unavailable; no crash.
- Only one clip plays at a time; starting a new clip stops the current one. The
  transcript player (`el.player`) and its state are never touched.

## Out of scope (YAGNI)

- Multi-range concatenation (groups are single contiguous spans).
- Streaming/Range for clips (they're small; full-blob playback from IndexedDB).
- A global "download all clips" affordance separate from the prefetch.
- Reusing the transcript player for clip playback.

## Verification (no pytest)

- uttale: `py_compile`; `unittest` adds `TestAudioCaching` (ETag present and
  stable for a span, differs across spans); confirm no new ruff issues in added
  lines.
- offline: `node --check`; `fake-indexeddb` harness extracting the real
  `clipSpan`/`getClip`/`prefetchClips`/`playClip` — assert: cache-hit skips
  fetch, miss fetches+stores, offline+miss → null, prune deletes orphans, toggle
  play↔stop, only-one-plays.
- Live smoke: throwaway uttale (:7011, separate DBs, generated `.ogg`) + offline
  proxy (:7023). Verify `/api/clip` returns `audio/ogg` with `ETag` +
  `Cache-Control: …immutable` (relayed through the proxy). Kill by saved PID;
  never touch the running :7010 instance.
