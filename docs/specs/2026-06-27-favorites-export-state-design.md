# Favorites export state: persistent, with tooltip + re-export

Date: 2026-06-27
Status: approved, implementing

## Problem (root-caused)

"Export" = sending a favorite/group to Telegram. The exported state is broken for
GROUPS: `exportGroup` POSTs `/api/export` with only the span's start
(`first.start`), so the backend stamps `set_exported` on that one row. The other
members get `exported_at` set only LOCALLY. On the next `syncFavorites` ->
`reconcileFavorites`, synced rows are overwritten with the server's `exported_at`
(null for the unstamped members), so `group.every(exported_at)` becomes false and the
row reverts from "✓" to "✈".

Verified backend contract (live :7010):
- `Favorite.exported_at` is a string|null timestamp (server is source of truth).
- `POST /uttale/Favorites/Update {filename,start,set_exported:true}` stamps a real
  `exported_at` timestamp that the GET returns. Round-trip confirmed.

Also missing: a tooltip showing WHEN it was exported, and an explicit "re-export is
allowed" affordance (user may have deleted the Telegram message and want to resend).

## Design

### Backend: mark-exported without resending (offline.py)
Add `POST /api/exported` -> relays `{filename, start, set_exported:true}` to
`{uttale}/uttale/Favorites/Update`. No audio, no Telegram. Extract a small helper
`_mark_exported(filename, start)` reused by `_export` (which currently inlines the
same Favorites/Update call) and the new route.

### API (api.js)
`markExported(filename, start)` -> POST `/api/exported` with JSON body. Resolves on ok.

### exportGroup (app.js)
After the combined send succeeds (`Api.exportFav` for the span), mark EVERY member
exported on the server: `await Api.markExported(f.filename, f.start)` for each member
(idempotent; covers members 2..N that the span send didn't stamp). Then set each
member's local `exported_at = now` for immediate feedback. (A later reconcile aligns
to the server's exact timestamp.) On failure of the audio send, throw as today and do
NOT mark.

Re-export: `exportGroup` always performs the send; being already-exported never blocks
it. After a successful re-send, `exported_at` is refreshed to the new time.

### sendGroup (app.js)
On success: `renderFav()` (re-render) so the icon, class, and tooltip are consistent
instead of ad-hoc `btn.textContent`. On offline / failure keep the existing transient
button feedback.

### Render row (_renderFav)
- `✓` + `.exported` class shown when `group.every(f => f.exported_at)` (now persistent).
- Tooltip:
  - exported: `title = "Exported " + fmtExportedAt(repr)` where `repr` is the earliest
    member's `exported_at` (group[0]); `fmtExportedAt` = `new Date(iso).toLocaleString()`.
  - not exported: `title = "Send to Telegram"`.
- Clicking always calls `sendGroup` (re-export allowed). Visual stays "✓" but resend
  happens; tooltip updates after re-render.

## Out of scope
- No change to single-favorite send semantics other than the shared exportGroup path
  (a singleton is a group of 1, so it benefits from the same server-side mark + tooltip).
- No "unexport" action.

## Verification (no pytest; per AGENTS.md)
- Live round-trip (throwaway favorite, then deleted): POST /api/exported sets server
  `exported_at`; confirm 7 real favorites untouched.
- Node harness (real exportGroup): on ok, calls Api.markExported for EVERY member and
  sets local exported_at on all; on non-ok audio send, throws and marks none.
- Node harness (real _renderFav): exported group row shows "✓", `.exported`, and
  title starting with "Exported "; un-exported shows "✈" + "Send to Telegram".
- node --check (app.js, api.js) + py_compile offline.py; element-id cross-ref; live
  asset + /api/favorites smoke.
- Manual: send a group -> ✓ with "Exported <when>" tooltip; reopen Favorites (triggers
  sync+reconcile) -> stays ✓; click again -> re-sends to Telegram.
