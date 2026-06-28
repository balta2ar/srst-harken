# Generate Topics — design

Generate chapter `topics` for a whole episode on demand via an external script,
triggered from the offline UI when an opened episode has no topics. Fire-and-forget:
the API launches the generator in the background and returns immediately.

## Backend: `POST /uttale/GenerateTopics`

Mirrors the existing `Reindex` pattern (immediate return + background work) and the
existing `Topics` reader.

- Request: `GenerateTopicsRequest { filename: str }` — the episode's first-segment
  VTT, the same value `GET /uttale/Topics?filename=` takes.
- Response 200: `GenerateTopics { filename: str, status: str }` where
  `status ∈ {"started", "already running", "not found"}`.
- Resolve dir: `topic_dir = dirname(join(args.root, filename))`. Missing dir →
  `status="not found"`, nothing launched.

### Concurrency guard (in-memory, per dir)

- Module-level `_topics_running: set[str]` protected by `_topics_lock = threading.Lock()`.
- Key = `os.path.realpath(topic_dir)`.
- If key already present → `status="already running"`, launch nothing.
- Else add key, start worker thread, return `status="started"`.
- Lost on restart (acceptable for fire-and-forget); a `finally` always removes the
  key so a crash never wedges a dir permanently.

### Worker (background thread, logged, atomic)

The external script is on PATH: `vtt-topics <dir> > topics`. We run it without a
shell so the `> topics` redirect becomes an explicit temp stdout file, giving us
logging, exit code, and an atomic publish.

1. Ensure `/tmp/vtt-topics/` exists; open log
   `/tmp/vtt-topics/<sanitized-dir>-<YYYYMMDD-HHMMSS>.log`.
2. Write a header (command + target dir + start time) to the log.
3. Run `subprocess.run(["vtt-topics", topic_dir], stdout=<temp file in topic_dir>,
   stderr=<log>)`.
4. On exit 0 **and** non-empty stdout → `os.replace(tmp, join(topic_dir, "topics"))`
   (atomic). Otherwise remove temp, leave any existing `topics` untouched. Append
   `exit=<code>` to the log.
5. `finally`: discard the running-key.

Why thread + `subprocess.run` (not bare `Popen`): lets us hold the lock for the real
duration, capture exit/stderr to the log, and do the atomic rename — none of which the
raw redirect provides. Still fire-and-forget from the client's view (response returns
instantly).

New imports: none (`subprocess`, `threading`, `tempfile`, `datetime`, `os` already
imported).

## Offline proxy: `POST /api/topics`

`offline.py` already has `_proxy_post`. Add `/api/topics` to the `do_POST` allow-list
and relay to `/uttale/GenerateTopics`. (The existing `GET /api/topics` reader is
unchanged.)

## Offline client

- `Api.generateTopics(filename)` — `POST /api/topics {filename}`, returns the JSON
  (or `null` on failure, like the other client methods).
- `renderTopics()` currently hides the whole `#topics` panel when there are no topics.
  New empty-state: when `tl.topics` is empty **and** `navigator.onLine`, show the panel
  with a single "Generate topics" button instead of the list.
  - Click → disable button, set label "Generating…", call `Api.generateTopics`.
  - On a `started`/`already running` response → label "Generating… reopen later"
    (stays disabled). On failure → re-enable with the original label.
  - No polling. The new `topics` file appears server-side seconds-to-minutes later;
    the existing `loadTopics`-on-open re-fetches it the next time the episode is opened.
- Offline with no topics → no button (panel stays hidden, as today). Generation is a
  server action.

## Out of scope (YAGNI)

- Live polling / progress for generated topics (appear on next open).
- Persisting the running-set across restarts.
- Regenerate-when-topics-already-exist UI (only offered when topics are absent).

## Verification (no pytest)

- uttale: `python -m py_compile`; `python -m unittest` adding `TestGenerateTopics`
  (dir resolution, "not found", concurrency skip via a fake script, atomic publish,
  log file written). Use a temp `--root` with a stub `vtt-topics` on PATH.
- offline: `node --check`; `fake-indexeddb` harness extracting the real
  `renderTopics`/click handler to assert the button appears only when empty+online and
  that clicking calls `Api.generateTopics` and disables.
