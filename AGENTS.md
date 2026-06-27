# Agents coding instructions

* mimic the existing code style and conventions
* do not add comments unless necessary, maybe comments that explain "why" something is done, not "what" is done
* strive for conciseness, code reuse, and separate abstractions where appropriate, add helpers
* do not use local imports, keep all imports at the top of the file
* prefer argparse for command-line argument parsing

## Architecture & context (so you don't rediscover)

* harken is a single-file NiceGUI app: `harken/harken.py`. It is a thin UI over
  the `srst-uttale` backend (FastAPI + DuckDB) which lives at
  `/home/bz/share/btsync/prg/srst-uttale` (see its AGENTS.md).
* Pages are built per-session: state is constructed fresh inside the page
  function, so multiple LAN clients don't share state. Routes today:
  `@ui.page("/")` (`main_page(request)`) and `@app.get("/audio")` (audio proxy).
* URL state: `main_page` restores from `request.query_params` (`scope`, `text`);
  `sync_url()` writes them back via `history.replaceState`. Deep-linking a line
  is planned via an `at` (start-time string) param (see favorites spec).
* `UttaleAPI` talks to the backend. `_make_request` is GET-only via `urlopen`
  with `SSL_NOVERIFY`; client methods degrade gracefully (e.g. `search_text`
  returns `[]` on failure). POST/DELETE+JSON need a new sibling helper using
  `urllib.request.Request(method=...)`.
* A "line" = `(filename, start, end_time, text)`. Timestamps are VTT strings
  (`00:00:26.240`). `Subtitle` has both `start_time` (str) and `start` (float
  secs), plus `offset` (index in file). `SearchResult.offset()` maps
  `(filename, start)` -> line index by re-fetching the file's lines; this is the
  pattern for jump-to-line.
* `load_media(file, offset=-1)`: clears/reloads subtitles, sets current_file,
  seeks via a deferred `state.commands` lambda, then `draw.refresh()`.
* CSS lives in `overwrite_style()` (`.harken-line`, `.active`, hand-written media
  queries `.harken-main/-browse/-read/-search`). Layout is responsive/mobile via
  those media queries (not Quasar breakpoints).
* Keys in use (`on_key`): v/t toggle play, w replay, q prev, f next, r record,
  p/s play, c compress, k focus search, m copy segment. (`b` reserved for the
  planned favorite toggle.)
* HTTPS: `--ssl` serves over https with a self-signed cert (openssl) and makes
  the `--uttale` scheme default to https. Audio is proxied through harken's own
  `/audio` so the page is single-origin (fixed a Chrome CORS/autoplay issue with
  compressed audio).
* Backend must be restarted to pick up changes; it has run over HTTPS on :7010.
* venv python: `/mnt/payload/share/msi/prg/srst-harken/.venv/bin/python`
  (nicegui 2.10.1, python 3.12). No automated test suite — verify via
  `py_compile` + a smoke render on a spare port (8081-8085) with a temp harness
  in the repo dir, poll for HTTP 200, kill by PID (avoid bare `pkill`), clean up.
* Current focus: implementing a global "favorites" feature. Design spec:
  `docs/specs/2026-06-27-favorites-design.md`. Session handoff: `SESSION.md`.
