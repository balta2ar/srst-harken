# Telegram Export + Favorite Blocks — Design Spec

Date: 2026-06-27
Repos: `srst-harken` (UI + export execution), `srst-uttale` (minor backend tweak)

## Goal

1. Export favorited audio to Telegram as a voice message, with the combined
   subtitle text as the caption, using the local script
   `/home/bz/rc.arch/bz/bin/telegram-send-voice <audiofile> -m <text>`.
2. Add a UI-only concept of a **block**: several consecutive favorited lines in
   the same file are treated as one unit — shown as one row in the favorites
   tab and exported as a single audio file with combined text. No backend
   storage change for blocks (they are derived in harken).

## Block model (UI-only, derived in harken)

A **block** = a maximal run of favorited lines in the same `filename` whose line
indices are adjacent (offset N, N+1, … with no un-favorited line between them).
A lone favorite is a block of size 1.

Computed only when rendering the `/favorites` page:
1. Fetch all favorites via `list_favorites(sort=…)`.
2. Group by `filename`. For each distinct file, fetch its ordered lines once
   (`api.search_text("", scope=filename)`) and build `start_time -> offset`
   (same pattern as `SearchResult.offset()`). One extra request per file.
3. Within a file, sort favorites by offset; split into runs of consecutive
   offsets -> blocks.
4. Block fields:
   - `filename`
   - `members`: member favorites ordered by offset
   - `text`: members' text joined by `" "`
   - `start`: first member's `start` (VTT string)
   - `end`: last member's `end` (VTT string)
   - `created_at`: **max** of members' `created_at` (sort key for created sorts)
   - `comment`: members' non-empty comments joined by `" "`
   - `exported`: True iff every member has a non-null `exported_at`

Block ordering follows the page's selected sort, keyed by the block
representative: newest member `created_at` for created sorts; `(filename, first
start)` for name sorts. (Re-sort blocks client-side after grouping, since
grouping reorders within a file.)

## Favorites tab rendering (one row per block)

- **Text:** combined block text.
- **Meta:** `filename` (+ joined comments if any).
- **Status:** representative `created_at` · `exported <ts>` if `exported` else
  `not exported`.
- **Click row → jump:** `/?scope=<filename>&at=<first start>` (first line).
- **Delete (trash):** delete every member (`delete_favorite` per member), refresh.
- **Send (telegram icon):** export just this block (see below).
- **Top buttons:** "Export all" (loop export over all blocks) and the sort
  selector remain. (The old generic "Export" stub button is replaced by
  "Export all".)

## Export mechanics (harken backend, same host as the script)

Helper `export_block(block) -> (ok, detail)`:
1. `audio_filename = with_extension(block.filename, ".ogg")`
2. `audio = api.get_audio(audio_filename, clip_ts(block.start, -0.5),
   clip_ts(block.end, +0.5))` — identical range logic to `copy_audio_segment`
   (first-line start → last-line end, ±0.5 s margin).
3. If no audio -> fail.
4. Write temp `.ogg` via `spit_temp(f"{generate_filename_hash(text)}.ogg", audio)`.
5. `subprocess.run([TELEGRAM_SEND_VOICE, tmp_path, "-m", block.text],
   capture_output=True, text=True)`. Non-zero exit or exception -> fail with
   stderr detail.
6. On success: stamp `exported_at` for each member via
   `api.update_favorite(filename, start, set_exported=True)`.

`TELEGRAM_SEND_VOICE = "/home/bz/rc.arch/bz/bin/telegram-send-voice"` (module
constant). The script already outputs/*converts to* ogg/opus and sources
`~/.telegram` for credentials; harken passes the `.ogg` segment directly.

Run via NiceGUI's `run.io_bound(...)` so the audio fetch + upload don't freeze
the event loop (the handler is `async`, awaiting each export). After export(s),
refresh the list so statuses flip to "exported". Use `ui.notify` only for export
results (success/failure) — an explicit action with no other feedback.
"Export all" notifies a summary (e.g. "Exported 3/3 blocks").

## Backend tweak (uttale): extend Update to stamp exported_at

Extend the existing `POST /uttale/Favorites/Update`:
- `FavoriteUpdate`: `filename`, `start`, `comment: Optional[str] = None`,
  `set_exported: bool = False`.
- `favorites_update(db_path, filename, start, comment=None, set_exported=False)`:
  builds a partial UPDATE — sets `comment` only if provided; sets
  `exported_at = now()` if `set_exported`; always bumps `updated_at`. 404 if the
  favorite doesn't exist. Returns the updated row.
- Server generates the `exported_at` timestamp (client never sends timestamps),
  consistent with `created_at`/`updated_at`.

harken `update_favorite(filename, start, comment=None, set_exported=False)`
sends only the provided fields.

## Error handling

- Missing audio, script non-zero exit, or subprocess exception -> caught;
  `ui.notify` error; `exported_at` NOT stamped for that block.
- Per-block failures during "Export all" don't abort the loop; summary reports
  successes/failures.
- `update_favorite`/`delete_favorite` already degrade gracefully on API error.

## Testing

- uttale: unit test for `favorites_update` with `set_exported=True` (stamps
  `exported_at`, preserves comment when omitted) and the missing -> None/404
  case. Run via uv env (`unittest`).
- harken: `py_compile`; block-grouping verified against a throwaway backend with
  seeded adjacent/non-adjacent favorites; one **real** telegram send to confirm
  end-to-end (user deletes the test message afterward).

## Non-goals / notes

- Blocks are not persisted; re-deriving on each favorites render is fine for the
  archive size.
- Main reading view is unchanged (per-line stars/markers only).
- Re-timed/re-indexed VTTs could change offsets; acceptable.
