# Favorite comments — design

## Summary

Add per-favorite comments to the offline PWA's Favorites view. A user can add,
edit, and delete a short free-text comment under each favorite. Favorites with a
comment get a subtle green background so the comment-less ones stand out as
"to-do". Comments are included in the Telegram export, joined to the favorite
text by a blank line. Comments persist locally (offline-first) and sync to the
uttale backend, which already supports a `comment` column end-to-end.

## Context

* The uttale backend **already supports `comment`** on favorites: schema column
  `comment TEXT DEFAULT ''` (separate SQLite `favorites.db`), `FavoriteAdd.comment`,
  `FavoriteUpdate.comment`, `POST /uttale/Favorites/Update`, and `comment` is
  returned in the `GET /uttale/Favorites` list and on every create/update. **No
  backend change is required.**
* `offline.py`'s `POST /api/favorite` is a raw passthrough to `/uttale/Favorites`,
  so a `comment` field added to the client's add payload reaches the server's
  upsert with **no `offline.py` change**.
* In the Favorites view, adjacent favorited lines from the same file are
  collapsed into one grouped row (`groupFavorites`); the row's text is the
  members' `.text` joined with a space (`app.js:782`). The backend stores a
  `comment` per individual line.
* Client favorite record today (IndexedDB `favorites` store, `keyPath:"id"`,
  `id = filename + "|" + start`): `{id, filename, start, end, text, status,
  updatedAt, exported_at}`. No `comment`. Sync is local-first with a `status`
  state machine: `pending` (push via `favAdd`), `synced`, `deleted` (push via
  `favDel`). Reconcile lets local `pending`/`deleted` win, else server wins.

## Decisions

* **One comment per group, stored on the group's first line.** A grouped row's
  comment is the `comment` of `group[0]` (`group[0].filename` + `group[0].start`).
  Editing the row edits only that record. Other members keep empty comments.
* **No IndexedDB `VERSION` bump.** The store is schemaless; a missing `comment`
  is treated as `""`.
* **Persist comment edits by piggybacking on the existing add/upsert path.**
  No new proxy route, no `offline.py` change. The only API change is `Api.favAdd`
  including `comment` in its POST body.
* **Visual:** has-comment rows get a subtle green background `#eef6ec` (a softer
  shade than the downloaded-episode `#eafbe7`), via a `.has-comment` class on the
  `.fav` row. Comment-less rows stay transparent and show a faint
  `+ add comment` placeholder.
* **Editing model:** click the comment text (or the placeholder) → inline
  auto-growing `<textarea>`. **Blur saves**, **Esc cancels** (reverts to prior
  value), **Ctrl/Cmd+Enter saves**, plain **Enter inserts a newline**.
* **Delete a comment:** clear the textarea and blur (or Ctrl/Cmd+Enter) → an
  empty/whitespace-only comment is saved as no comment; the row loses its tint and
  shows `+ add comment` again. No dedicated delete control.
* **Export:** combine `joinedText + "\n\n" + comment` (only when a comment
  exists) in the client `payload.text` (`exportGroup`). `offline.py` keeps
  building `#pod #wtf\n{text}` unchanged.

## Data model

Client favorite record gains one optional field:

* `comment` — string, default `""`. Missing key is treated as `""` everywhere.

Touch points:

* `toggleFavorite` create-path (`app.js:592`): write `comment: ""`.
* `reconcileFavorites` create block (`app.js:1055`): copy `comment: s.comment || ""`.
* `reconcileFavorites` synced-update block (`app.js:1061`): set
  `local.comment = s.comment || ""`.

`reconcile` continues to leave local `pending`/`deleted` untouched, so a pending
comment edit wins over a stale server `comment` until it flushes.

## Sync flow (edit a comment)

`saveComment(group, value)`:

1. Resolve the target record: `fav = group[0]` by its `id`.
2. Normalize `value` (trim trailing whitespace; treat whitespace-only as `""`).
3. If unchanged vs. the stored `comment`, no-op (avoid needless re-push).
4. Write the record: `comment = value`, `status = "pending"`,
   `updatedAt = now`.
5. `renderFav()` to repaint the row (tint + comment text / placeholder).
6. If `navigator.onLine`, `syncFavorites().then(updateStatus)`.

The existing flush loop's `pending` branch (`app.js:1020-1024`) calls
`Api.favAdd(f)`, which now includes `comment`. The server's `ON CONFLICT`
updates only `end/text/comment/updated_at` (preserves `created_at` and
`exported_at`). Reconcile then flips the record back to `synced` and copies the
server `comment` down (identical value).

Re-flagging an already-`synced` favorite to `pending` re-uses the existing push
path verbatim — the only behavioral change is that `favAdd` now carries `comment`.

## API change

`Api.favAdd` (`api.js`): add `comment: fav.comment || ""` to the JSON body.
No other API or proxy change.

## UI / render

In `_renderFav`'s per-group loop (`app.js:770-831`):

* `body` is laid out meta-first so the text and comment stay adjacent: append
  the `meta` line (podcast · date · N lines) at the TOP of `body`, then the
  favorite text, then the comment element.
* The left column holds the timestamp in a `div.fav-ts-col` (a small flex
  column). When the favorite has NO comment, a `+` button (`.fav-add-comment`)
  is appended under the timestamp as the "add comment" affordance — there is no
  inline placeholder line in the body.
* After the text, append a comment slot `div.fav-comment`:
  * If `group[0].comment` is non-empty: it shows the comment text (preserve
    newlines via `white-space: pre-wrap`), is click-to-edit, and the `.fav` row
    gets class `has-comment`.
  * Else: it is left EMPTY (collapses via `.fav-comment:empty`) and serves as the
    mount target for the editor when the `+` is clicked.
* The comment text renders at the same size as the favorite text (no explicit
  font-size; inherits the row), styled grey.
* Opening the editor (clicking the comment text, or the `+` under the timestamp)
  replaces the body comment slot in place with a `<textarea.fav-comment-edit>`
  pre-filled with the current comment, focused, caret at end, auto-sized. The
  editor always mounts in the body slot, never under the timestamp. The `+`
  stays visible and inert while editing.

Editor behavior (a small helper `openCommentEditor(group, host)`):

* **Auto-grow:** on `input`, set `height = "auto"` then `height = scrollHeight`.
  Initial height set the same way after mount.
* **Save:** on `blur` and on Ctrl/Cmd+Enter → `saveComment(group, textarea.value)`.
* **Cancel:** on Escape → restore the previous (non-edit) rendering without
  saving. Escape sets a guard so the subsequent blur does not also save.
* **Enter:** default newline (do not intercept).
* Guard against double-save (blur firing after an explicit save/cancel).

Because `_renderFav` repaints the whole list, opening the editor must not be
clobbered by a stray `renderFav()` mid-edit. Acceptable: edits are short-lived
and `renderFav` is already coalesced/non-reentrant; `saveComment` triggers the
repaint itself after the value is committed.

## Export

`exportGroup` (`app.js:973-978`): build

```
text = group.map(f => f.text).join(" ")
comment = (group[0].comment || "").trim()
payload.text = comment ? text + "\n\n" + comment : text
```

Resulting Telegram caption (server prepends `#pod #wtf\n`):

```
#pod #wtf
<favorite text>

<comment>
```

i.e. exactly one visible blank line between text and comment.

## CSS

In `app.css`, favorites block:

* `.fav.has-comment { background: #eef6ec; }`
* `.fav .meta { ... margin-bottom: .15rem; }` (meta now sits above the text)
* `.fav-ts-col { display: flex; flex-direction: column; align-items: flex-start;
  gap: .1rem; flex-shrink: 0; align-self: flex-start; }`
* `.fav-add-comment { font-size: 1rem; line-height: 1; color: #bbb; padding: 0; }`
  with `:hover { color: #0d6efd; }` (the `+` under the timestamp)
* `.fav-comment { color: #555; white-space: pre-wrap; cursor: text;
  margin-top: .15rem; }` (no font-size — matches the favorite text size);
  `.fav-comment:empty { margin-top: 0; }` so an empty slot adds no gap
* `.fav-comment-edit { width: 100%; box-sizing: border-box; font: inherit;
  resize: none; overflow: hidden; }`

(Exact shades may be tuned later.)

## Testing

No automated browser harness exists; per `AGENTS.md` verify with `node --check`,
a Node harness exercising REAL extracted pure functions, and a manual browser
checklist.

Pure/unit-testable seams to extract or target:

* `buildExportText(joinedText, comment)` — returns `text` when comment empty,
  `text + "\n\n" + comment` otherwise; trims comment; whitespace-only → no
  append. (Extract a tiny helper so export assembly is unit-tested.)
* `normalizeComment(value)` — trim trailing whitespace; whitespace-only → `""`.
* `saveComment` semantics: no-op when unchanged; sets `status="pending"` +
  writes `comment` when changed (test against a fake DB / in-memory shim if
  feasible, else assert the helper logic).

Manual browser checklist:

1. Favorite has no comment → faint `+ add comment` shows; row not tinted.
2. Click placeholder → textarea opens focused; type multiple lines → grows
   vertically, no scrollbar.
3. Click outside → comment saved; row turns green `#eef6ec`; comment text shows
   with line breaks.
4. Reload page → comment persists (IndexedDB).
5. Online: comment reaches server (verify via `GET /uttale/Favorites`).
6. Edit existing comment, Ctrl/Cmd+Enter → saves.
7. Esc while editing → reverts, no save, no tint change.
8. Clear all text + blur → comment removed; tint gone; placeholder back.
9. Export a favorite with a comment → Telegram caption shows text, one blank
   line, then comment.
10. Grouped row (multi-line favorite): comment attaches to the group; editing
    edits one comment; export joins group text + that comment.

## Out of scope

* Per-line comments within a group (only the group's first line carries one).
* A dedicated comment-update endpoint / new proxy route (piggyback on add).
* Backend changes (already supports `comment`).
* Markdown / rich text in comments (plain text only).
