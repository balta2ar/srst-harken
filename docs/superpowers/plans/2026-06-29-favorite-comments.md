# Favorite Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-favorite comments to the offline PWA Favorites view — inline auto-growing editor, green tint for has-comment rows, export-with-comment, all offline-first and synced to the (already comment-capable) uttale backend.

**Architecture:** Client-only feature. The favorite record gains an optional `comment` string. Editing writes IndexedDB locally, re-flags the favorite `pending`, and the existing sync flush re-pushes it via `Api.favAdd` (now carrying `comment`) to the passthrough `/api/favorite` proxy. Two pure helpers (`normalizeComment`, `buildExportText`) carry the testable logic. No backend or `offline.py` change.

**Tech Stack:** Vanilla JS (no framework), IndexedDB via `db.js`, plain DOM. Node `--check` for syntax; a Node harness extracting the real pure helpers for unit tests (per `AGENTS.md`, run from `/tmp/opencode`).

## Global Constraints

- No automated browser tests. Verify each task with `node --check` on changed `.js` files; unit-test only the extracted PURE helpers via a Node harness (functions touching no IndexedDB don't need fake-indexeddb). Manual browser checklist at the end. (`AGENTS.md`)
- Keep all imports/`require`s at the top; no local imports. Mimic existing code style; no comments except "why". Be compact. (`AGENTS.md`)
- IndexedDB `VERSION` stays `4` — `comment` is a schemaless property; treat missing as `""`.
- Comment is stored on the GROUP'S FIRST LINE only: `group[0]` (its `filename` + `start`).
- Has-comment row background: `#eef6ec`. Comment-less rows: transparent + faint `+ add comment`.
- Editor: blur saves; Esc cancels (reverts); Ctrl/Cmd+Enter saves; plain Enter = newline. Whitespace-only comment ⇒ deleted (no comment).
- Export caption joins `text + "\n\n" + comment` (only when comment non-empty), combined CLIENT-side in `exportGroup`'s `payload.text`.
- Functions/files to test from `/tmp/opencode`; `node` is v25. Helpers must be exposed for `require` in a way consistent with the file's existing export pattern (see Task 1).

---

### Task 1: Pure helpers `normalizeComment` + `buildExportText`

Add two pure, side-effect-free helpers to `app.js` and unit-test them. They encode the two pieces of logic that must be exactly right: comment normalization (whitespace-only ⇒ `""`) and export-caption assembly (blank line only when a comment exists).

**Files:**
- Modify: `offline/static/app.js` (add two top-level functions near the other favorite helpers, e.g. just above `toggleFavorite` at `app.js:583`; and export them if/where the file exposes functions for tests)
- Test: `/tmp/opencode/test-fav-comments.mjs` (Node harness; throwaway, not committed)

**Interfaces:**
- Produces:
  - `normalizeComment(value: string | undefined) -> string` — returns `""` for `null`/`undefined`/whitespace-only; otherwise the input with trailing whitespace removed (leading whitespace preserved, interior newlines preserved).
  - `buildExportText(joinedText: string, comment: string | undefined) -> string` — returns `joinedText` when `normalizeComment(comment) === ""`; otherwise `joinedText + "\n\n" + normalizeComment(comment)`.

- [ ] **Step 1: Confirm extraction approach (no export mechanism)**

CONFIRMED: `offline/static/app.js` is top-level declarations (NOT an IIFE), has NO `module.exports` guard, and harnesses are throwaway (none committed). Do NOT add any export mechanism to `app.js`. Both helpers are pure and self-contained, so the harness extracts each function's SOURCE by regex from the file text and evaluates it in isolation (the standard repo pattern). `normalizeComment` is referenced by `buildExportText`, so eval them together in one scope.

- [ ] **Step 2: Write the failing test**

Create `/tmp/opencode/test-fav-comments.mjs`. Read `offline/static/app.js`, regex-extract the two function sources, and eval them together so `buildExportText` can see `normalizeComment`:

```js
import assert from "node:assert";
import { readFileSync } from "node:fs";

const SRC = readFileSync("/mnt/payload/share/msi/prg/srst-harken/offline/static/app.js", "utf8");
function grab(name) {
  const m = SRC.match(new RegExp("function " + name + "\\s*\\([\\s\\S]*?\\n\\}", "m"));
  if (!m) throw new Error("not found: " + name);
  return m[0];
}
// eval both in one scope; buildExportText calls normalizeComment.
const ns = {};
new Function(grab("normalizeComment") + "\n" + grab("buildExportText") +
  "\nthis.normalizeComment = normalizeComment; this.buildExportText = buildExportText;").call(ns);
const { normalizeComment, buildExportText } = ns;

// normalizeComment
assert.equal(normalizeComment(undefined), "");
assert.equal(normalizeComment(""), "");
assert.equal(normalizeComment("   \n  \t "), "");
assert.equal(normalizeComment("hi"), "hi");
assert.equal(normalizeComment("hi   "), "hi");
assert.equal(normalizeComment("line1\nline2  "), "line1\nline2");
assert.equal(normalizeComment("a\n\nb"), "a\n\nb");

// buildExportText
assert.equal(buildExportText("text", ""), "text");
assert.equal(buildExportText("text", "   "), "text");
assert.equal(buildExportText("text", undefined), "text");
assert.equal(buildExportText("text", "note"), "text\n\nnote");
assert.equal(buildExportText("a b c", "two\nlines"), "a b c\n\ntwo\nlines");

console.log("OK");
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node /tmp/opencode/test-fav-comments.mjs`
Expected: FAIL (helpers not defined / not exported).

- [ ] **Step 4: Implement the helpers**

In `offline/static/app.js`, add near the favorite helpers:

```js
function normalizeComment(value) {
  const s = (value == null ? "" : String(value)).replace(/\s+$/, "");
  return s.trim() === "" ? "" : s;
}

function buildExportText(joinedText, comment) {
  const c = normalizeComment(comment);
  return c ? joinedText + "\n\n" + c : joinedText;
}
```

Then expose both via the file's existing test-export mechanism (matching Step 1).

- [ ] **Step 5: Run test to verify it passes**

Run: `node /tmp/opencode/test-fav-comments.mjs`
Expected: `OK`.

- [ ] **Step 6: Syntax check + commit**

```bash
node --check offline/static/app.js
git add offline/static/app.js
git commit -m "feat(offline): add normalizeComment + buildExportText helpers for favorite comments"
```

---

### Task 2: Persist `comment` through the favorite record + API + sync

Wire `comment` into the client favorite record (create + reconcile) and into the add payload, so a comment round-trips to the backend and survives sync. No editor yet; this task makes the data plumbing correct and testable end-to-end via the running servers.

**Files:**
- Modify: `offline/static/api.js:37-39` (add `comment` to `favAdd` body)
- Modify: `offline/static/app.js:592-595` (`toggleFavorite` create-path writes `comment: ""`)
- Modify: `offline/static/app.js:1055-1059` (reconcile create block copies `comment`)
- Modify: `offline/static/app.js:1061-1065` (reconcile synced-update block copies `comment`)

**Interfaces:**
- Consumes: `normalizeComment` (Task 1) — not strictly needed here but available.
- Produces: favorite records now carry `comment` (default `""`); `Api.favAdd(fav)` sends `comment: fav.comment || ""`.

- [ ] **Step 1: Add `comment` to `favAdd` payload**

`offline/static/api.js`, change the `favAdd` body (lines 37-39) to:

```js
      body: JSON.stringify({
        filename: fav.filename, start: fav.start, end: fav.end, text: fav.text,
        comment: fav.comment || "",
      }),
```

- [ ] **Step 2: Write `comment: ""` on local create**

`offline/static/app.js`, in `toggleFavorite` create-path (lines 592-595), add `comment: ""`:

```js
    await DB.put("favorites", {
      id, filename: ln.vtt, start: startStr, end: endStr, text: ln.text,
      comment: "", status: "pending", updatedAt: new Date().toISOString(),
    });
```

- [ ] **Step 3: Copy `comment` down on reconcile (create block)**

`offline/static/app.js`, reconcile create block (lines 1055-1059), add `comment`:

```js
      await DB.put("favorites", {
        id: key, filename: s.filename, start: s.start, end: s.end || "",
        text: s.text || "", comment: s.comment || "", status: "synced",
        updatedAt: s.updated_at || new Date().toISOString(),
        exported_at: s.exported_at || null,
      });
```

- [ ] **Step 4: Copy `comment` down on reconcile (synced-update block)**

`offline/static/app.js`, reconcile synced block (lines 1061-1065), add the comment line:

```js
    } else if (local.status === "synced") {
      local.text = s.text || "";
      local.end = s.end || "";
      local.comment = s.comment || "";
      local.exported_at = s.exported_at || null;
      await DB.put("favorites", local);
    }
```

- [ ] **Step 5: Syntax check**

Run: `node --check offline/static/app.js && node --check offline/static/api.js`
Expected: no output (success).

- [ ] **Step 6: Live round-trip smoke (servers)**

Bring up throwaway uttale + offline (per `AGENTS.md`/SESSION conventions), with separate temp DBs:

```bash
# uttale on 127.0.0.1:7011 (HTTP; needs PYTHONPATH; temp favorites DB)
PYTHONPATH=/home/bz/share/btsync/prg/srst-uttale \
/tmp/opencode/uttale-test/bin/python -m uttale.backend.server \
  --iface 127.0.0.1:7011 --db /tmp/opencode/fc-root.db \
  --favorites-db /tmp/opencode/fc-fav.db \
  --root /mnt/wd-red-wcc4/audio/podcast/nordnorsk/ & echo $! > /tmp/opencode/utt.pid
# offline on 127.0.0.1:7023 (HTTP)
/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python \
  /mnt/payload/share/msi/prg/srst-harken/offline/offline.py \
  --uttale http://127.0.0.1:7011 --host 127.0.0.1 --port 7023 & echo $! > /tmp/opencode/off.pid
sleep 2
# POST a favorite WITH a comment through the offline proxy:
curl -s -X POST http://127.0.0.1:7023/api/favorite -H 'Content-Type: application/json' \
  -d '{"filename":"x.vtt","start":"00:00:01.000","end":"00:00:02.000","text":"hi","comment":"my note"}'
echo
# Read it back from uttale; comment must be present:
curl -s 'http://127.0.0.1:7023/api/favorites' | grep -o '"comment":"my note"' && echo COMMENT_OK
kill $(cat /tmp/opencode/off.pid) $(cat /tmp/opencode/utt.pid)
```

Expected: `COMMENT_OK` printed (proves the proxy passthrough forwards `comment` and the backend persists/returns it).

- [ ] **Step 7: Commit**

```bash
git add offline/static/app.js offline/static/api.js
git commit -m "feat(offline): plumb favorite comment through record, favAdd, and reconcile"
```

---

### Task 3: Export favorite text + comment

Use `buildExportText` so an exported favorite's caption includes the group's first-line comment, separated by a blank line.

**Files:**
- Modify: `offline/static/app.js:975-978` (`exportGroup` payload `text`)

**Interfaces:**
- Consumes: `buildExportText` (Task 1); favorite `comment` field (Task 2).

- [ ] **Step 1: Use `buildExportText` in `exportGroup`**

`offline/static/app.js`, `exportGroup` (lines 975-978), change the payload to:

```js
  const payload = {
    filename: first.filename, start: first.start, end: last.end || last.start,
    text: buildExportText(group.map((f) => f.text).join(" "), group[0].comment),
  };
```

- [ ] **Step 2: Syntax check**

Run: `node --check offline/static/app.js`
Expected: no output.

- [ ] **Step 3: Verify via the Task 1 harness (regression)**

The export-assembly logic is already covered by `buildExportText` tests. Re-run:
Run: `node /tmp/opencode/test-fav-comments.mjs`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add offline/static/app.js
git commit -m "feat(offline): include favorite comment in Telegram export caption"
```

---

### Task 4: CSS for comment display + editor

Add the styles for the comment line, the placeholder, the auto-grow textarea, and the has-comment green tint.

**Files:**
- Modify: `offline/static/app.css` (favorites block, after line 63)

**Interfaces:**
- Produces: classes `.fav.has-comment`, `.fav-comment`, `.fav-comment.placeholder`, `.fav-comment-edit` consumed by Task 5.

- [ ] **Step 1: Add the rules**

`offline/static/app.css`, after the favorites `@media` block (line 63), add:

```css
.fav.has-comment { background: #eef6ec; }
.fav-comment { font-size: .8rem; color: #555; white-space: pre-wrap; cursor: text; margin-top: .15rem; }
.fav-comment.placeholder { color: #aaa; font-style: italic; }
.fav-comment-edit { width: 100%; box-sizing: border-box; font: inherit; font-size: .8rem; resize: none; overflow: hidden; }
```

- [ ] **Step 2: Sanity check the file still parses (no tool; visual)**

Read back the edited region to confirm the rules are well-formed (balanced braces). No build step for CSS.

- [ ] **Step 3: Commit**

```bash
git add offline/static/app.css
git commit -m "style(offline): favorite comment display, placeholder, editor, has-comment tint"
```

---

### Task 5: Render comment + inline auto-grow editor

Render the comment (or placeholder) under each favorite row, add the `has-comment` class, and wire the click-to-edit textarea with blur-save / Esc-cancel / Ctrl-Enter-save and auto-grow. This is the interactive core; verified by the manual browser checklist.

**Files:**
- Modify: `offline/static/app.js` — `_renderFav` per-group loop (insert after `body.appendChild(meta)` at line 800, before the `play` button); add helpers `saveComment(group, value)` and `openCommentEditor(group, host)` near the other favorite helpers.

**Interfaces:**
- Consumes: `normalizeComment` (Task 1); favorite `comment` field + `Api.favAdd` carrying comment (Task 2); CSS classes (Task 4); existing `renderFav`, `syncFavorites`, `updateStatus`, `DB`.
- Produces: `saveComment(group, value)`, `openCommentEditor(group, host)`.

- [ ] **Step 1: Add `saveComment` helper**

In `offline/static/app.js`, near the favorite helpers, add:

```js
async function saveComment(group, value) {
  const fav = await DB.get("favorites", group[0].id);
  if (!fav) return;
  const next = normalizeComment(value);
  if ((fav.comment || "") === next) return;
  fav.comment = next;
  fav.status = "pending";
  fav.updatedAt = new Date().toISOString();
  await DB.put("favorites", fav);
  renderFav();
  if (navigator.onLine) syncFavorites().then(updateStatus);
}
```

- [ ] **Step 2: Add `openCommentEditor` helper**

In `offline/static/app.js`, add:

```js
function openCommentEditor(group, host) {
  const ta = document.createElement("textarea");
  ta.className = "fav-comment-edit";
  ta.value = group[0].comment || "";
  let done = false;
  const grow = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  const commit = () => { if (done) return; done = true; saveComment(group, ta.value); };
  const cancel = () => { if (done) return; done = true; renderFav(); };
  ta.addEventListener("input", grow);
  ta.addEventListener("blur", commit);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.blur(); }
  });
  host.replaceWith(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  grow();
}
```

Note: `cancel()` and `commit()` both call `renderFav()` (commit indirectly via `saveComment`); the `done` guard prevents the blur that follows Escape/Ctrl-Enter from double-firing. On cancel, `renderFav()` repaints from the unchanged stored record (revert).

- [ ] **Step 3: Render the comment element in `_renderFav`**

In `offline/static/app.js`, in the per-group loop, AFTER `body.appendChild(meta);` (line 800) and BEFORE the `play` button creation (line 801), insert:

```js
    const comment = (group[0].comment || "");
    if (comment) row.classList.add("has-comment");
    const cmt = document.createElement("div");
    cmt.className = comment ? "fav-comment" : "fav-comment placeholder";
    cmt.textContent = comment || "+ add comment";
    cmt.onclick = () => openCommentEditor(group, cmt);
    body.appendChild(cmt);
```

- [ ] **Step 4: Syntax check**

Run: `node --check offline/static/app.js`
Expected: no output.

- [ ] **Step 5: Manual browser checklist (live servers)**

Start uttale (7011) + offline (7023) as in Task 2 Step 6 (or reuse if running). Open `http://127.0.0.1:7023` in a browser. Favorite a couple of lines first (Listen view star), then in Favorites verify each item from the spec's Manual browser checklist:

1. No-comment favorite shows faint `+ add comment`; row NOT tinted.
2. Click placeholder → focused textarea; multi-line typing grows vertically, no scrollbar.
3. Click outside → saved; row turns `#eef6ec`; comment shows with line breaks.
4. Reload → comment persists.
5. (Online) `curl -s http://127.0.0.1:7023/api/favorites | grep comment` shows it server-side.
6. Edit existing comment; Ctrl/Cmd+Enter saves.
7. Esc while editing reverts, no save, tint unchanged.
8. Clear all text + blur → comment removed; tint gone; placeholder back.
9. Export a commented favorite → caption shows text, blank line, comment.
10. Multi-line grouped favorite: comment attaches to the group (first line); export joins group text + that comment.

Tear down: `kill $(cat /tmp/opencode/off.pid) $(cat /tmp/opencode/utt.pid)`.

- [ ] **Step 6: Commit**

```bash
git add offline/static/app.js
git commit -m "feat(offline): render favorite comment + inline auto-grow editor (blur saves, Esc cancels)"
```

---

## Self-Review

**Spec coverage:**
- Data model `comment` field + no VERSION bump → Task 2. ✓
- One comment per group on first line → Tasks 3/5 use `group[0]`. ✓
- Add/edit/delete via inline auto-grow editor, blur/Esc/Ctrl-Enter → Task 5. ✓
- Delete = clear + blur (whitespace ⇒ "") → `normalizeComment` (Task 1) + `saveComment` (Task 5). ✓
- Piggyback sync, re-flag pending, favAdd carries comment, reconcile preserves → Task 2. ✓
- Green `#eef6ec` has-comment tint + placeholder → Task 4 (CSS) + Task 5 (class/placeholder). ✓
- Export text + `\n\n` + comment client-side → Tasks 1 (`buildExportText`) + 3. ✓
- Testing: pure helpers unit-tested (Task 1), live round-trip (Task 2), manual checklist (Task 5). ✓

**Placeholder scan:** No TBD/TODO; all code shown; commands have expected output. ✓

**Type consistency:** `normalizeComment`/`buildExportText` signatures match between Task 1 def and Tasks 3/5 use; `saveComment(group,value)`/`openCommentEditor(group,host)` consistent between definition (Task 5 Steps 1-2) and call sites (Step 3); `comment` field name consistent across api.js, record, reconcile, render, export. ✓
