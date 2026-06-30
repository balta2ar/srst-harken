# Offline app event/sync refactor — design

Date: 2026-06-30
Repo: `srst-harken` (`offline/` UI only)

## Goal

Refactor the vanilla JS offline app from direct fan-out calls into a small
internal event-driven model. The app should keep IndexedDB as the durable source
of truth, but mutation paths should emit domain events so UI refreshes,
background sync, counts, marks, and clip prefetching are triggered consistently.

This is a refactor/specification for another implementation pass. It should not
change user-visible behavior except to make updates more consistent and avoid
redundant overlapping work.

## Current pain points

Several call sites perform the same manual fan-out:

- Opening Favorites shows the tab, renders, syncs, renders again, refines line
  order, and prefetches clips.
- Toggling a favorite writes IndexedDB, mutates the clicked star, updates the
  count/status, redraws timeline marks, and starts sync.
- Saving a favorite comment writes IndexedDB, renders Favorites, and starts sync.
- Opening Recent renders, syncs, and renders again.
- Recording a listen writes IndexedDB, prunes, and directly updates the Recent
  count.

The desired model is:

```text
IndexedDB mutation
  -> Events.emit("domain:changed", { reason, ids })
    -> local UI jobs coalesce
    -> sync request debounces/serializes
    -> sync emits changed/synced events
```

## New files

Add three small browser-global modules under `offline/static/` and load them in
`offline/static/index.html` before `app.js`:

1. `events.js`
2. `job.js`
3. `sync.js`

Keep the style consistent with existing `api.js`/`db.js`: IIFE assigned to a
single global constant. Do not use imports/modules.

### `events.js`

Expose `Events.on(type, fn)` and `Events.emit(type, detail)`.

Suggested shape:

```js
const Events = (() => {
  const target = new EventTarget();

  function on(type, fn) {
    target.addEventListener(type, (event) => fn(event.detail || {}));
  }

  function emit(type, detail) {
    target.dispatchEvent(new CustomEvent(type, { detail: detail || {} }));
  }

  return { on, emit };
})();
```

This is app-internal only. Do not introduce `BroadcastChannel` in this pass.
Cross-tab propagation is out of scope.

### `job.js`

Expose two helpers:

```js
Job.coalesce(fn)
Job.debounce(fn, wait)
```

Do not add a generic keyed scheduler yet. `Jobs.schedule` / `Scheduler.schedule`
is explicitly out of scope for this pass.

#### `Job.coalesce(fn)`

Use for local UI and local derived state:

- favorite badge/status
- Recent badge
- visible Favorites render
- visible Recent render
- favorite timeline marks

Semantics:

- No debounce delay.
- Do not overlap `fn` with itself.
- If scheduled while `fn` is running, run exactly one more time after the current
  run finishes.
- Multiple schedules while running collapse into one follow-up run.

This is the extracted/generalized form of the current `renderFav` and
`renderListened` non-reentrant `_running/_again` pattern.

#### `Job.debounce(fn, wait)`

Use for network/background work:

- app sync
- clip prefetch
- favorite line-order refinement, if still needed as a separate background job

Semantics:

- Wait `wait` ms after the most recent schedule before starting.
- Do not overlap `fn` with itself.
- Multiple schedules before the timer fires collapse into one run.
- If scheduled while `fn` is running, run one follow-up pass after the current
  pass finishes, after another `wait` ms.

The follow-up pass is important: if the user changes data while sync is in
flight, that request must not be lost.

Suggested shape:

```js
const Job = (() => {
  function coalesce(fn) {
    let running = false;
    let again = false;

    return async function schedule() {
      if (running) {
        again = true;
        return;
      }

      running = true;
      try {
        do {
          again = false;
          await fn();
        } while (again);
      } finally {
        running = false;
      }
    };
  }

  function debounce(fn, wait) {
    let timer = null;
    let running = false;
    let again = false;

    async function run() {
      if (running) {
        again = true;
        return;
      }

      running = true;
      again = false;
      try {
        await fn();
      } finally {
        running = false;
        if (again) {
          clearTimeout(timer);
          timer = setTimeout(run, wait);
        }
      }
    }

    return function schedule() {
      again = true;
      clearTimeout(timer);
      timer = setTimeout(run, wait);
    };
  }

  return { coalesce, debounce };
})();
```

Implementation may adjust naming internals, but preserve semantics.

### `sync.js`

Expose a coordinator:

```js
Sync.request(domain)
```

Valid domains for this pass:

- `"favorites"`
- `"listens"`
- `"all"`

Keep domain-specific sync functions in `app.js` or move them only if that is a
small, safe extraction. Do not merge favorite/listen reconcile rules into one
giant function. The coordinator chooses *what* to sync; `syncFavorites()` and
`syncListens()` still own their separate domain rules.

Use one debounced serial app-sync job, built with `Job.debounce`. `Sync.request`
should collect requested domains in a `Set`, debounce, then run each requested
domain once. If `"all"` is requested, run all registered domains.

Suggested API if sync functions remain in `app.js`: allow registration after
`app.js` loads its functions:

```js
Sync.register("favorites", {
  run: syncFavorites,
  synced: "favorites:synced",
  changed: "favorites:changed",
});
Sync.register("listens", {
  run: syncListens,
  synced: "listens:synced",
  changed: "listens:changed",
});
```

Then:

```js
Sync.request("favorites");
Sync.request("listens");
Sync.request("all");
```

Coordinator behavior:

1. If offline, ignore the request. The `network:online` event will request
   `"all"` later.
2. Debounce requests for about 750ms.
3. Snapshot requested domains at run start and clear the set.
4. Run each requested syncer serially.
5. Each syncer returns `changed` (`true` if it changed IndexedDB, else `false`).
6. Emit `<domain>:synced` after each syncer.
7. If `changed`, emit `<domain>:changed` with
   `{ reason: "server-reconcile" }`.
8. If another `Sync.request` happens while the app-sync job is running, it must
   schedule a follow-up pass via `Job.debounce` semantics.

Example coordinator shape:

```js
const Sync = (() => {
  const syncers = {};
  const requested = new Set();

  const schedule = Job.debounce(async () => {
    if (!navigator.onLine) return;

    const domains = requested.has("all") ? Object.keys(syncers) : [...requested];
    requested.clear();

    for (const domain of domains) {
      const syncer = syncers[domain];
      if (!syncer) continue;
      const changed = await syncer.run();
      Events.emit(syncer.synced, { changed });
      if (changed) Events.emit(syncer.changed, { reason: "server-reconcile" });
    }
  }, 750);

  function register(domain, syncer) {
    syncers[domain] = syncer;
  }

  function request(domain) {
    if (!navigator.onLine) return;
    requested.add(domain);
    schedule();
  }

  return { register, request };
})();
```

## Naming conventions

Keep these prefixes; they should mean different things:

- `show*`: switch high-level view/visibility/navigation state. Example:
  `showView("fav")` changes which tab is visible and active.
- `render*`: build or update DOM contents from current state/IndexedDB. Example:
  `renderFav()`, `renderListened()`.
- `schedule*`: enqueue/coalesce/debounce a future action. Example:
  `scheduleRenderFav()`, `scheduleListenSync()` if using a direct function, or
  `Sync.request("listens")` for app sync.
- `sync*`: perform the actual network/local reconcile work now. These should be
  async and return a `changed` boolean where practical.
- `record*`, `toggle*`, `save*`, `delete*`, `export*`: domain mutations/actions.
  These write IndexedDB/API as needed and emit events instead of directly fanning
  out to unrelated UI/sync work.

`show*` and `render*` are not the same:

- `show*` answers: "which screen/section is visible?"
- `render*` answers: "what DOM should this visible or cached section contain?"

A tab click often does both: first `showView("recent")`, then
`scheduleRenderRecent()`. Keeping the names separate makes it clear that showing
a view is cheap state/visibility work, while rendering may read IndexedDB and
build DOM.

## Event names and reasons

Use domain events:

- `favorites:changed`
- `favorites:synced`
- `listens:changed`
- `listens:synced`
- `network:online`
- `network:offline`
- optionally `player:play`, `player:pause`, `player:timeupdate` only if it makes
  the code clearer; do not over-abstract high-frequency time updates.

Suggested `reason` values:

Favorites:

- `local-add`
- `local-remove`
- `comment-edit`
- `exported`
- `server-reconcile`
- `line-order-learned`

Listens:

- `local-record`
- `local-record-pruned`
- `server-reconcile`

Use `reason` to avoid sync loops. For example, `favorites:changed` with
`reason: "server-reconcile"` should update UI, but should not request another
favorite sync.

## Favorites refactor

### Scheduled jobs

In `app.js`, define named scheduled jobs after the underlying functions exist:

```js
const scheduleFavoriteStatus = Job.coalesce(updateStatus);
const scheduleFavoriteMarks = Job.coalesce(async () => {
  if (!tl) return;
  renderMarks();
});
const scheduleRenderFav = Job.coalesce(async () => {
  if (el.viewFav.hidden) return;
  await renderFav();
});
const schedulePrefetchClips = Job.debounce(async () => {
  if (!navigator.onLine) return;
  await prefetchClips();
}, 2000);
```

If `renderFav()` keeps its current internal `_running/_again` guard initially,
that is acceptable. After the scheduled wrapper is proven stable, the internal
guard may be removed in a later cleanup, but that is not required.

### Events

```js
Events.on("favorites:changed", (detail) => {
  scheduleFavoriteStatus();
  scheduleFavoriteMarks();
  scheduleRenderFav();
  schedulePrefetchClips();

  if (detail.reason !== "server-reconcile") Sync.request("favorites");
});

Events.on("favorites:synced", () => {
  scheduleFavoriteStatus();
  scheduleRenderFav();
  schedulePrefetchClips();
});
```

### Mutation functions

`toggleFavorite`, `saveComment`, delete-group logic, export marking, and server
reconcile should emit `favorites:changed` after durable local state changes.

Example target shape for `toggleFavorite`:

```js
async function toggleFavorite(ln, star) {
  const startStr = ln.startStr || ln.start;
  const endStr = ln.endStr || ln.end;
  const id = ln.vtt + "|" + startStr;
  const existing = await DB.get("favorites", id);
  let active;

  if (!existing) {
    await DB.put("favorites", {
      id, filename: ln.vtt, start: startStr, end: endStr, text: ln.text,
      comment: "", status: "pending", updatedAt: new Date().toISOString(),
    });
    active = true;
  } else if (existing.status === "synced") {
    existing.status = "deleted";
    existing.updatedAt = new Date().toISOString();
    await DB.put("favorites", existing);
    active = false;
  } else {
    await DB.del("favorites", id);
    active = false;
  }

  if (star) star.textContent = active ? "★" : "☆";
  Events.emit("favorites:changed", {
    reason: active ? "local-add" : "local-remove",
    ids: [id],
  });
}
```

Do not leave direct fan-out calls like `updateStatus()`, `renderMarks()`, or
`syncFavorites().then(...)` in mutation functions once the event subscribers are
in place.

### `syncFavorites()` return value

Change `syncFavorites()` to return `true` if it changed IndexedDB and `false`
otherwise. Count these as changes:

- pending favorite successfully marked `synced`
- deleted favorite removed locally after server delete/404
- server favorite inserted locally
- local synced favorite updated from server
- local synced favorite deleted because absent from server

Change `reconcileFavorites(serverByKey)` to return `changed` too, and have
`syncFavorites()` include it.

## Recent/Listened refactor

### Scheduled jobs

```js
const scheduleRecentCount = Job.coalesce(updateRecentCount);
const scheduleRenderRecent = Job.coalesce(async () => {
  if (el.viewRecent.hidden) return;
  await renderListened();
});
```

### Events

```js
Events.on("listens:changed", (detail) => {
  scheduleRecentCount();
  scheduleRenderRecent();

  if (detail.reason !== "server-reconcile") Sync.request("listens");
});

Events.on("listens:synced", () => {
  scheduleRecentCount();
  scheduleRenderRecent();
});
```

### `recordListen()`

After writing `listened` and pruning, emit `listens:changed` instead of directly
calling `updateRecentCount()`.

```js
const pruned = await pruneListened();
Events.emit("listens:changed", {
  reason: pruned ? "local-record-pruned" : "local-record",
  ids: [filename],
});
```

### `pruneListened()` return value

Change `pruneListened()` to return `true` if it deleted any records, `false`
otherwise.

### `syncListens()` return value

Change `syncListens()` to return `true` if it changed IndexedDB and `false`
otherwise. Count these as changes:

- pending listen successfully marked `synced`
- server listen inserted locally
- local listen updated from newer server row
- pruning deleted local listens

Change `reconcileListens(serverByFile)` to return `changed` too. It should not
call `updateRecentCount()` directly; event subscribers handle counts/renders.

## Network events

Replace direct online/offline fan-out with app events:

```js
window.addEventListener("online", () => Events.emit("network:online"));
window.addEventListener("offline", () => Events.emit("network:offline"));
```

Subscribers:

```js
Events.on("network:online", () => {
  scheduleFavoriteStatus();
  scheduleRecentCount();
  Sync.request("all");
  schedulePrefetchClips();
});

Events.on("network:offline", () => {
  scheduleFavoriteStatus();
  scheduleRecentCount();
});
```

## Player events

Do not over-abstract the high-frequency `timeupdate` path. Keep active-line and
clock updates direct unless there is a concrete need to change them.

It is acceptable to keep play/pause handlers direct but route their durable side
effects through `recordListen()`, which then emits `listens:changed`:

```js
el.player.addEventListener("play", () => {
  el.tPlay.textContent = "⏸";
  recordListen({ force: true });
});

el.player.addEventListener("pause", () => {
  el.tPlay.textContent = "▶";
  recordListen({ force: true });
});
```

If desired, add `Events.emit("player:play")` and `Events.emit("player:pause")`,
but only if it improves clarity. Avoid eventing `timeupdate` in this pass.

## Tab handlers after refactor

Favorites:

```js
el.navFav.onclick = () => {
  showView("fav");
  scheduleRenderFav();
  Sync.request("favorites");
  schedulePrefetchClips();
};
```

Recent:

```js
el.navRecent.onclick = () => {
  showView("recent");
  scheduleRenderRecent();
  Sync.request("listens");
};
```

Listen tab and Find tab can remain mostly unchanged. If they trigger durable
state changes in the future, prefer emitting domain events.

## Boot after refactor

Target shape:

```js
(async function boot() {
  scheduleFavoriteStatus();
  scheduleRecentCount();
  setInterval(recordListen, 5000);

  Sync.register("favorites", {
    run: syncFavorites,
    synced: "favorites:synced",
    changed: "favorites:changed",
  });
  Sync.register("listens", {
    run: syncListens,
    synced: "listens:synced",
    changed: "listens:changed",
  });

  if (navigator.onLine) Sync.request("all");

  schedulePrefetchClips();
  renderFind();
  showView("find");
})();
```

Register syncers before any code path can call `Sync.request` if possible. If
that ordering is awkward, move registration immediately after `syncFavorites`
and `syncListens` are defined.

## Verification

There is no full automated frontend test suite. At minimum:

- `node --check offline/static/events.js offline/static/job.js offline/static/sync.js offline/static/app.js offline/static/api.js offline/static/db.js offline/static/timeline.js`
- Smoke render the offline app on a spare port as described in `AGENTS.md`.
- Manual browser checks:
  - Add a favorite: star updates immediately; Favorites badge updates; scrubber
    mark updates; Favorites tab updates if visible; one debounced favorite sync
    occurs when online.
  - Remove a favorite: same as above, including tombstone/deletion sync.
  - Edit a favorite comment: Favorites tab updates; favorite sync is requested.
  - Open Favorites: local render happens immediately; sync/prefetch happen in
    background.
  - Play/pause/5-second interval records listens; Recent badge updates; Recent
    tab updates if visible; listen sync is debounced.
  - Open Recent: local render happens immediately; listen sync happens in the
    background and re-renders only if data changed.
  - Toggle offline/online: offline updates status only; online requests
    `Sync.request("all")` and refreshes both domains.
- Instrument network panel or temporary logging to confirm rapid repeated
  favorite/listen changes coalesce into one sync pass, plus one follow-up pass if
  changes occur while sync is already running.

## Out of scope

- Generic keyed `Scheduler.schedule` / `Jobs.schedule`.
- Framework/reactivity libraries.
- Cross-tab event propagation.
- Service-worker-driven sync.
- Rewriting IndexedDB storage or changing the local-first data model.
- Refactoring high-frequency audio `timeupdate` into app events.
