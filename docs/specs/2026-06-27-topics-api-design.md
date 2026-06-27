# Topics API design (uttale backend)

Date: 2026-06-27
Repo: `srst-uttale` (`uttale/backend/server.py`); consumer: `srst-harken`.

## Goal

Serve background-generated podcast topic/chapter markers as JSON. Topics are
produced offline (a `topics` file written next to a podcast's audio/transcript)
and displayed in the UI. The API keys topics the same way as the rest of the
backend so the UI can reuse its existing primary key.

## Source artifact

A file literally named `topics` (no extension) in a podcast's segment
directory, e.g.:

```
<root>/48k/VernaBedrift/20260623/by10m/topics
```

Each line is `HH:MM:SS<space>title`, for example:

```
00:00:39 Velkommen tilbake – to uker fra hverandre, mindre alkoholtoleranse
00:00:58 Kevins jobb: fiskesortering, lange skift, lite snus
00:03:47 Rondane-turen: introduksjon og pakking av altfor tung sekk
```

There is no header line. The time is seconds-precision (no milliseconds),
whereas the `lines` table uses VTT strings with milliseconds (`00:00:39.240`).

## Endpoint

```
GET /uttale/Topics?filename=<first-segment VTT path>
```

- `filename` is the first segment's VTT path, e.g.
  `48k/VernaBedrift/20260623/by10m/by10m_00.vtt`. Same key shape as
  `Favorites` and `Audio` (the UI keys on `segments[0]`'s filename).
- The backend derives the directory from the filename and reads the `topics`
  file there: `dirname(join(args.root, filename))/topics`. This mirrors the
  path mapping in `get_audio_segment` (`splitext(join(args.root, filename))`).

## Parsing & normalization

For each non-blank line:

1. Split into the leading timestamp token and the remaining `title`.
2. Normalize the timestamp to VTT form: pad `.000` when no milliseconds are
   present (`00:00:39` -> `00:00:39.000`). If milliseconds are already present
   (future-proofing for a generator that emits `00:00:39.240`), pass them
   through unchanged.
3. `title` is the remainder, stripped.
4. Skip lines that are blank or whose first token is not a valid
   `HH:MM:SS[.mmm]` timestamp.

`start` is padded to `.000` and used by the UI to **seek the audio player by
time** (39.0s). It is intentionally NOT resolved against the `lines` table, so
Topics stays a pure filesystem read with no DuckDB coupling and no per-topic
query. Exact transcript-line highlighting is out of scope (YAGNI).

## Response

Mirrors the `Favorites` response shape (`filename` + `results_count` +
`results`).

```json
{
  "filename": "48k/VernaBedrift/20260623/by10m/by10m_00.vtt",
  "results_count": 17,
  "results": [
    { "title": "Velkommen tilbake – to uker fra hverandre, mindre alkoholtoleranse", "start": "00:00:39.000" },
    { "title": "Kevins jobb: fiskesortering, lange skift, lite snus", "start": "00:00:58.000" }
  ]
}
```

## Models

New pydantic `BaseModel`s at the top of `server.py`:

- `Topic { title: str; start: str }`
- `Topics { filename: str = ""; results_count: int = 0; results: list[Topic] = [] }`

## Behavior / errors

- Topics file absent -> HTTP **200** with `results: []`, `results_count: 0`
  (most podcasts will not have a `topics` file yet; "not generated yet" is a
  normal state, not an error).
- Malformed/blank line -> skipped silently.
- Follows the existing graceful-degradation style (`Scopes`/`Search` swallow
  errors); no 500s for normal absence.

## Implementation shape (for testability)

- `parse_topic_time(token) -> str | None`: validate `HH:MM:SS[.mmm]`, return
  normalized VTT string or `None`.
- `read_topics(root, filename) -> list[Topic]`: path mapping + read + parse +
  normalize. Pure; no globals beyond what is passed in. Returns `[]` when the
  file is absent.
- `GET /uttale/Topics` is a thin wrapper building `Topics(filename=...,
  results=read_topics(args.root, filename))`.

## Tests (`test_server.py::TestTopics`, unittest + temp dirs)

- Valid `topics` file -> parsed topics, count matches, seconds normalized to
  `.000`.
- Missing file -> empty results.
- Malformed/blank lines skipped (line with no timestamp, blank line, garbage
  first token).
- Already-millisecond timestamp passed through unchanged.

## No DuckDB involvement

Pure filesystem read; topics regenerate independently and need no reindex.
