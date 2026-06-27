#!/usr/bin/env python3

# ideas
# - display part of speech, color code (especially adjectives and verbs)
# - copy audio to clipboard (extract with ffmpeg + pyperclip/xclip)
# - mark sentences as favorites (saved server-side)
# - favorites view
# - allow overwriting subtitles (in case there are errors). should be stored server-side
# - command / script to export favorites to a telegram channel

import argparse
import logging
import re
import hashlib
import base64
import socket
import ssl
import tempfile
import subprocess
from bisect import bisect_left
from collections import namedtuple
from dataclasses import dataclass
from json import loads
from pathlib import Path
from time import perf_counter
from typing import Callable, List, Optional
from urllib.error import URLError
from urllib.parse import quote, urlencode
from urllib.request import Request as URLRequest, urlopen

from fastapi import Header, Request, Response
from fastapi.responses import StreamingResponse
from nicegui import app, ui
from nicegui.elements.audio import Audio
from nicegui.elements.button import Button
from nicegui.elements.input import Input
from nicegui.elements.link import Link
from nicegui.events import KeyEventArguments
from pydantic import BaseModel

api = None
logging.basicConfig(level=logging.DEBUG)

# uttale may use a self-signed cert when running over HTTPS; these are
# internal server-to-server calls to a trusted local backend, so skip verification.
SSL_NOVERIFY = ssl._create_unverified_context()

MEDIA = {".mp3", ".mp4", ".mkv", ".avi", ".webm", ".opus", ".ogg"}
SUBS = {".vtt"}

SCOPE_LIMIT = 1000
SEARCH_LIMIT = 1000
SubAndMedia = namedtuple("NamedPair", ["sub", "media"])

def generate_filename_hash(text: str) -> str:
    digest = hashlib.sha256(text.encode()).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")[:20]

def copy_to_clipboard(file_path: str):
    uri = Path(file_path).as_uri()
    try:
        subprocess.run(['xclip', '-selection', 'clipboard', '-t', 'text/uri-list'], input=uri.encode(), check=True)
    except Exception as e:
        logging.error(f"Clipboard copy failed: {e}")

def slurp(path):
    logging.info(f"Slurping {path}")
    with open(path, "rb") as f:
        return f.read()

def spit_temp(filename: str, data: bytes) -> Path:
    tmp_path = Path(tempfile.gettempdir()) / filename
    with open(tmp_path, "wb") as f:
        f.write(data)
    return tmp_path

def slurp_lines(path):
    with open(path) as f:
        return f.readlines()

@dataclass
class SearchResult:
    filename: str
    text: str
    start: str
    end: str
    def as_sub_and_media(self) -> SubAndMedia:
        return SubAndMedia(sub=self.filename, media=link_to_media(self.filename))
    def offset(self) -> int:
        # TODO: this is not efficient to send a new request for each offset,
        # it's server that should return the offset in search results
        results = api.search_text(query="", scope=self.filename)
        for i, result in enumerate(results):
            if result.start == self.start:
                return i
        return 0

class UttaleAPI:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.logger = logging.getLogger("UttaleAPI")

    def _make_request(self, endpoint: str, params: Optional[dict] = None) -> dict:
        try:
            url = f"{self.base_url}{endpoint}"
            if params:
                url += "?" + urlencode(params)

            self.logger.info(url)
            start_time = perf_counter()

            with urlopen(url, context=SSL_NOVERIFY) as response:
                data = response.read()
                response_time = perf_counter() - start_time

                response_json = loads(data.decode())
                self.logger.info(f"Received in {response_time:.3f}s: response size: {len(response_json)}")
                return response_json

        except URLError as e:
            self.logger.error(f"API Error: {e}")
            return None

    def search_scopes(self, query: str, limit: int = 1000) -> list[str]:
        result = self._make_request("/uttale/Scopes", {
            "q": query,
            "limit": limit,
        })
        if result and isinstance(result.get("results"), list):
            return result["results"]
        return []

    def search_text(self, query: str, scope: str = "", limit: int = 1000) -> list[SearchResult]:
        result = self._make_request("/uttale/Search", {
            "q": query,
            "scope": scope,
            "limit": limit,
        })
        if result and isinstance(result.get("results"), list):
            return [SearchResult(**item) for item in result["results"]]
        return []

    def get_audio(self, filename: str, start: str = "", end: str = "") -> bytes:
        url = (f"{self.base_url}/uttale/Audio?"
            f"filename={quote(filename)}&"
            f"start={quote(start)}&"
            f"end={quote(end)}")

        try:
            self.logger.info(url)
            start_time = perf_counter()

            with urlopen(url, context=SSL_NOVERIFY) as response:
                data = response.read()
                response_time = perf_counter() - start_time

                size_kb = len(data) / 1024
                self.logger.info("Received %.1fKB of audio data in %.3fs", size_kb, response_time)
                return data

        except URLError as e:
            self.logger.exception("Audio fetch error: %s", e)
            return b""

def with_extension(path: str, ext: str) -> str:
    return str(Path(path).with_suffix(ext))

index = None

def parse_ts_int(s):
    """
    00:00:26,240
    00:00:09.320
    """
    h, m, s_ms = s.split(":")
    s, ms = s_ms.replace(".", ",").split(",")
    return int(h) * 3600000 + int(m) * 60000 + int(s) * 1000 + int(ms)

def parse_ts(s):
    return parse_ts_int(s) / 1000.0

def format_ts(seconds):
    ms = int((seconds % 1) * 1000)
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"

def clip_ts(ts_string: str, offset_float: float) -> str:
    new_seconds = max(0.0, parse_ts(ts_string) + offset_float)
    return format_ts(new_seconds)

class Subtitle(BaseModel):
    start_time: str
    start: float
    end_time: str
    end: float
    text: str
    offset: int

def equals(a, b): assert a == b, f"{a} != {b}"

def overwrite_style():
    ui.add_css("""
:root {
    --nicegui-default-padding: 0.1rem;
    --nicegui-default-gap: 0.1rem;
}
.active {
    background-color: #dfffd6;
}
body {
    padding-bottom: 5rem;
}
.harken-main {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
    gap: 0.25rem;
}
.harken-main > .harken-browse {
    width: 100%;
}
.harken-main > .harken-read {
    width: 100%;
    height: 60vh;
}
.harken-search {
    width: 100%;
}
.harken-line {
    padding-top: 0;
    padding-bottom: 0;
    margin: 0;
}
.harken-line > * {
    line-height: 1;
    padding-top: 0;
    padding-bottom: 0;
}
@media (min-width: 768px) {
    .harken-main {
        flex-direction: row;
    }
    .harken-main > .harken-browse {
        width: 33.333%;
    }
    .harken-main > .harken-read {
        width: 66.666%;
        height: 80vh;
    }
    .harken-search {
        width: 25%;
    }
}
""")

class MyPlayer:
    def __init__(self, player: Audio):
        self.player: Audio = player
        self.playing = False
    def play(self):
        self.player.play()
        self.playing = True
    def pause(self):
        self.player.pause()
        self.playing = False
    def toggle(self):
        if self.playing: self.player.pause()
        else: self.player.play()
        self.playing = not self.playing
    def seek_and_play(self, at):
        self.player.seek(at)
        self.play()

class SubtitleLines:
    def __init__(self):
        self.reset()
    def reset(self):
        self.lines = []
        self.starts = []
        self.current_line = 0
        self.active_indices = set()
    def activate(self, at): # float (time in seconds) or int (index, # of the line)
        if isinstance(at, int): index = at
        elif isinstance(at, float): index = max(0, bisect_left(self.starts, at)-1)
        else: raise ValueError(f"Invalid type {type(at)}: {at}")

        # If the calculated index is already the single active one, do nothing (optimization)
        if len(self.active_indices) == 1 and index in self.active_indices:
            return

        self.set_active([index])
        self.current_line = index

    def set_active(self, indices: List[int]):
        for i in self.active_indices:
            if 0 <= i < len(self.lines):
                self.lines[i].classes(remove="active")

        self.active_indices = set(indices)

        for i in self.active_indices:
            if 0 <= i < len(self.lines):
                self.lines[i].classes(add="active")

    def add(self, line, start):
        self.lines.append(line)
        self.starts.append(start)

@dataclass
class UiState:
    files: list[SubAndMedia]
    current_file: SubAndMedia
    subtitles: list[Subtitle]
    sub_lines: SubtitleLines
    player: MyPlayer
    button_record: Button
    button_play: Button
    button_compress: Button
    search_field: Input
    search_query: str
    search_scope_field: Input
    search_scope: str
    commands: list[Callable]

def load_subtitles(scope) -> list[Subtitle]:
    return [
        Subtitle(
            start_time=r.start,
            start=parse_ts(r.start),
            end_time=r.end,
            end=parse_ts(r.end),
            text=r.text,
            offset=i,
        )
        for i, r in enumerate(api.search_text(query="", scope=scope))
    ]

PROXY_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges")

def link_to_media(vtt: str) -> str:
    media_file = with_extension(vtt, ".ogg")
    return f"/audio?filename={quote(media_file)}&start=&end="

@app.get("/audio")
@app.head("/audio")
def audio_proxy(filename: str, start: str = "", end: str = "", range_header: str = Header(None, alias="Range")) -> Response:
    url = (f"{api.base_url}/uttale/Audio?"
           f"filename={quote(filename)}&start={quote(start)}&end={quote(end)}")
    req = URLRequest(url)
    if range_header:
        req.add_header("Range", range_header)
    upstream = urlopen(req, context=SSL_NOVERIFY)
    headers = {k: upstream.headers[k] for k in PROXY_HEADERS if upstream.headers.get(k)}

    def stream():
        try:
            while chunk := upstream.read(64 * 1024):
                yield chunk
        finally:
            upstream.close()

    return StreamingResponse(
        stream(),
        status_code=upstream.status,
        headers=headers,
        media_type=upstream.headers.get("Content-Type", "audio/ogg"),
    )

@ui.page("/")
def main_page(request: Request):
    overwrite_style()
    scope = request.query_params.get("scope", "")
    query = request.query_params.get("text", "")
    scopes = api.search_scopes(scope, limit=SCOPE_LIMIT)
    files = [SubAndMedia(sub=vtt, media=link_to_media(vtt)) for vtt in scopes]
    subtitles = load_subtitles(files[0].sub) if files else []

    state = UiState(
        files=files,
        current_file=files[0] if files else SubAndMedia(sub="", media=""),
        subtitles=subtitles,
        sub_lines=SubtitleLines(),
        player=MyPlayer(None),
        button_record=None,
        button_play=None,
        button_compress=None,
        search_field=None,
        search_query=query,
        search_scope_field=None,
        search_scope=scope,
        commands=[],
    )
    logging.info(f"Media files: {len(files)}")

    def load_media(file: SubAndMedia, offset: int = -1):
        state.subtitles.clear()
        state.subtitles.extend(load_subtitles(file.sub))
        state.current_file = file
        state.commands.clear()
        at = 0.0 if offset < 0 else state.subtitles[offset].start
        state.commands.append(lambda: state.player.seek_and_play(at))
        draw.refresh()

    def play_line(sub: Subtitle):
        print(f"Playing line {sub.offset} at {sub.start_time}: {sub.text}")
        state.player.seek_and_play(sub.start)
    def play_line_by_index(index: int):
        index = max(0, min(index, len(state.subtitles)-1))
        state.sub_lines.activate(index)
        play_line(state.subtitles[index])
    def replay_current_line(): play_line_by_index(state.sub_lines.current_line)
    def play_previous_line(): play_line_by_index(state.sub_lines.current_line - 1)
    def play_next_line(): play_line_by_index(state.sub_lines.current_line + 1)
    async def player_position():
        return await ui.run_javascript("document.querySelector('audio').currentTime")
    async def player_update(ev):
        at = await player_position()
        state.sub_lines.activate(at)

    def copy_audio_segment():
        indices = sorted(list(state.sub_lines.active_indices))
        if not indices: return

        start_sub = state.subtitles[indices[0]]
        end_sub = state.subtitles[indices[-1]]

        start_str = clip_ts(start_sub.start_time, -0.5)
        end_str = clip_ts(end_sub.end_time, +0.5)
        audio_filename = with_extension(state.current_file.sub, ".ogg")
        audio_data = api.get_audio(audio_filename, start_str, end_str)

        if audio_data:
            text = " ".join(state.subtitles[i].text for i in indices)
            safe_hash = generate_filename_hash(text)
            tmp_path = spit_temp(f"{safe_hash}.ogg", audio_data)
            copy_to_clipboard(str(tmp_path))
            # Truncate text for notification if too long
            display_text = text if len(text) < 50 else text[:47] + "..."
            ui.notify(f'Copied "{display_text}" ({safe_hash}.ogg)')

    async def handle_selection():
        indices = await ui.run_javascript("""
        (function() {
            const selection = window.getSelection();
            if (selection.isCollapsed) return [];

            function getIndex(node) {
                while (node && node.dataset && !node.dataset.index) {
                    node = node.parentElement;
                }
                if (node && node.dataset && node.dataset.index) {
                    return parseInt(node.dataset.index);
                }
                let curr = node;
                while(curr && curr.nodeType !== 1) curr = curr.parentElement;
                while(curr) {
                    if (curr.dataset && curr.dataset.index !== undefined) return parseInt(curr.dataset.index);
                    curr = curr.parentElement;
                }
                return null;
            }

            const range = selection.getRangeAt(0);
            const startIdx = getIndex(range.startContainer);
            const endIdx = getIndex(range.endContainer);

            if (startIdx !== null && endIdx !== null) {
                const min = Math.min(startIdx, endIdx);
                const max = Math.max(startIdx, endIdx);
                const result = [];
                for (let i = min; i <= max; i++) result.push(i);
                return result;
            }
            return [];
        })()
        """)
        if indices:
            state.sub_lines.set_active(indices)
            # Update current line to the start of selection for navigation continuity
            state.sub_lines.current_line = indices[0]

    def on_key(ev: KeyEventArguments):
        if ev.modifiers:
            return
        if (ev.key == "v" and ev.action.keydown) or (ev.key == "t" and ev.action.keydown):
            state.player.toggle()
        elif ev.key == "w" and ev.action.keydown:
            replay_current_line()
        elif ev.key == "q" and ev.action.keydown:
            play_previous_line()
        elif ev.key == "f" and ev.action.keydown:
            play_next_line()
        elif ev.key == "r" and ev.action.keydown:
            state.button_record.run_method("click")
        elif (ev.key == "p" and ev.action.keydown) or (ev.key == "s" and ev.action.keydown):
            state.button_play.run_method("click")
        elif ev.key == "c" and ev.action.keydown:
            state.button_compress.run_method("click")
        elif ev.key == "k" and ev.action.keydown:
            state.search_field.run_method("focus")
        elif ev.key == "m" and ev.action.keydown:
            copy_audio_segment()

    @ui.refreshable
    def redraw_scopes(scope: str = None) -> None:
        scopes = api.search_scopes(state.search_scope, limit=SCOPE_LIMIT)
        files = [SubAndMedia(sub=vtt, media=link_to_media(vtt)) for vtt in scopes]
        state.files = files
        with ui.scroll_area().classes("border w-full h-80"):
            for f in state.files:
                active = " active" if f == state.current_file else ""
                parts = f.sub.split("/")
                with ui.row().classes("gap-0 items-center"):
                    for i, part in enumerate(parts):
                        if i:
                            ui.label("/").classes("text-gray-400")
                        last = i == len(parts) - 1
                        if last:
                            on_click = lambda f=f: load_media(f)
                        else:
                            prefix = " ".join(parts[: i + 1])
                            on_click = lambda prefix=prefix: select_scope(prefix)
                        classes = "hover:underline cursor-pointer" + active
                        ui.label(part).on("click", on_click).classes(classes)

    @ui.refreshable
    def redraw_search(query: str = None, scope: str = None) -> None:
        if not query: return
        results = api.search_text(query, scope=scope, limit=SEARCH_LIMIT)
        with ui.column().classes("border w-full"):
            for result in results:
                print("result", result)
                on_click = lambda result=result: load_media(result.as_sub_and_media(), result.offset())
                content = result.text
                content = re.sub(rf"({query})", r"<b>\1</b>", content, flags=re.IGNORECASE)
                ui.html(content).classes("pl-4 hover:outline-1 hover:outline-dashed").on("click", on_click)

    def sync_url():
        query = urlencode({"scope": state.search_scope, "text": state.search_query})
        ui.run_javascript(f"history.replaceState(null, '', '?{query}')")

    def select_scope(scope: str):
        nonlocal state
        state.search_scope = scope
        state.search_scope_field.value = scope
        sync_url()
        redraw_scopes.refresh(state.search_scope)

    def on_change_scope(e):
        select_scope(state.search_scope_field.value)

    def on_search(e):
        nonlocal state
        state.search_query = state.search_field.value
        state.search_scope = state.search_scope_field.value
        sync_url()
        redraw_search.refresh(state.search_query, state.search_scope_field.value)

    async def on_record_toggle(self):
        print(self)
        recording = await ui.run_javascript("""
if (window.recorder && window.recorder.state === 'recording') {
    window.recorder.stop()
    return false
} else {
    if (!navigator.mediaDevices) return 'insecure'
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        const context = new AudioContext()
        const source = context.createMediaStreamSource(stream)
        const compressor = context.createDynamicsCompressor()

        compressor.threshold.setValueAtTime(-50, context.currentTime) // dB
        compressor.knee.setValueAtTime(40, context.currentTime) // dB
        compressor.ratio.setValueAtTime(12, context.currentTime)
        compressor.attack.setValueAtTime(0, context.currentTime) // seconds
        compressor.release.setValueAtTime(0.25, context.currentTime) // seconds

        source.connect(compressor)
        //compressor.connect(context.destination)
        const destination = context.createMediaStreamDestination()
        compressor.connect(destination)

        window.chunks = []
        //window.recorder = new MediaRecorder(stream)
        window.recorder = new MediaRecorder(destination.stream)
        window.recorder.addEventListener('dataavailable', e => { window.chunks.push(e.data) })
        window.recorder.addEventListener('stop', e => {
            const blob = new Blob(window.chunks, { type: 'audio/ogg; codecs=opus' })
            const url = URL.createObjectURL(blob)
            window.audio = new Audio(url)
        })
        window.recorder.start()
    })
    return true
}
""")
        if recording == "insecure":
            ui.notify("Recording needs HTTPS or localhost (microphone is blocked on insecure origins)", type="warning")
            return
        state.button_record.props(f'color={"red" if recording else "green"}')
    async def on_record_play():
        state.player.pause()
        await ui.run_javascript("""
if (window.recorder && window.recorder.state === 'recording') {
    window.recorder.addEventListener('stop', e => {
        window.audio.play()
    })
    window.recorder.stop()
    return true
}
window.audio.play()
return true
""")
        state.button_record.props(f'color={"green"}')
    async def on_add_dynamic_compression(self):
        ok = await ui.run_javascript("""
const audioElement = document.querySelector('audio')
if (!audioElement) return false

// Web Audio reads zeroes from a cross-origin element unless it was fetched
// with CORS. crossOrigin must be set before the media loads, so if it isn't
// already set we reload the source (preserving position/playback) first.
if (audioElement.crossOrigin !== 'anonymous') {
    const wasPlaying = !audioElement.paused
    const position = audioElement.currentTime
    audioElement.crossOrigin = 'anonymous'
    audioElement.load()
    await new Promise(resolve => {
        audioElement.addEventListener('loadedmetadata', resolve, { once: true })
    })
    audioElement.currentTime = position
    if (wasPlaying) audioElement.play()
}

// Reuse a single AudioContext / source node: createMediaElementSource
// throws InvalidStateError if called twice on the same element.
window.audioContext = window.audioContext || new AudioContext()
const context = window.audioContext
if (!window.compressorSource) {
    window.compressorSource = context.createMediaElementSource(audioElement)
}
const source = window.compressorSource

const compressor = context.createDynamicsCompressor()
compressor.threshold.setValueAtTime(-50, context.currentTime) // dB
compressor.knee.setValueAtTime(40, context.currentTime) // dB
compressor.ratio.setValueAtTime(12, context.currentTime)
compressor.attack.setValueAtTime(0, context.currentTime) // seconds
compressor.release.setValueAtTime(0.25, context.currentTime) // seconds

source.connect(compressor)
compressor.connect(context.destination)

// Chrome's autoplay policy starts the context suspended; without resuming
// it the element is routed through a halted graph and stays silent.
await context.resume()
console.log('Dynamic compression added, context state:', context.state)
return true
""")
        if not ok:
            logging.warning("Failed to add dynamic compression")
            return
        self.sender.props(f'color={"green"}')
        self.sender.disable()

    async def on_line_click(s):
        # Check if text is selected to prevent playing when selecting text
        has_selection = await ui.run_javascript("window.getSelection().type === 'Range' && window.getSelection().toString().length > 0")
        if not has_selection: play_line(s)

    @ui.refreshable
    def draw():
        keyboard = ui.keyboard(on_key=on_key)
        nonlocal state
        shortcuts = """
v / t -- Toggle player |
w -- Replay current line |
q -- Play previous line |
f -- Play next line |
r -- Record |
p / s -- Play |
c -- Compress |
k -- Focus on search field |
m -- Copy audio segment
"""
        with ui.row().classes("w-full flex-wrap items-center gap-1"):
            state.search_scope_field = ui.input(label="Search scope",
                                                value=state.search_scope,
                                                placeholder="Type something to search",
                                                on_change=on_change_scope).classes("harken-search pl-1").tooltip(shortcuts)
            state.search_field = ui.input(label="Search by word",
                                          value=state.search_query,
                                          placeholder="Type something to search",
                                          on_change=on_search).classes("harken-search pl-1").tooltip(shortcuts)
        with ui.element("div").classes("harken-main"):
            with ui.column().classes("harken-browse border"):
                redraw_scopes(state.search_scope)
                redraw_search(state.search_query, state.search_scope)
            with ui.scroll_area().classes("harken-read border").on('mouseup', handle_selection):
                with ui.column().classes("w-full gap-0"):
                    state.sub_lines.reset()
                    for i, s in enumerate(state.subtitles):
                        with ui.row().classes("harken-line w-full hover:ring-1").props(f'data-index={i}') as line_row:
                            ui.label(f"{s.text}").on("click", lambda s=s: on_line_click(s)).classes("cursor-pointer text-lg")
                            state.sub_lines.add(line_row, s.start)
        draw_controls()
        for c in state.commands: c()
        state.commands.clear()

    def draw_controls():
        with ui.row().classes(
            "fixed bottom-0 left-0 right-0 z-50 w-full flex-nowrap items-center gap-1 "
            "bg-white border-t px-1 py-1"
        ):
            ui.button(icon="skip_previous", on_click=play_previous_line).props("flat round dense").tooltip("Previous line")
            ui.button(icon="replay", on_click=replay_current_line).props("flat round dense").tooltip("Replay line")
            ui.button(icon="play_arrow", on_click=lambda: state.player.toggle()).props("flat round dense").tooltip("Play / pause")
            ui.button(icon="skip_next", on_click=play_next_line).props("flat round dense").tooltip("Next line")
            state.player.player = ui.audio(link_to_media(state.current_file.sub)).classes("flex-grow min-w-0")
            state.player.player.on("timeupdate", player_update)
            state.button_record = ui.button(icon="mic", on_click=on_record_toggle).props("flat round dense").tooltip("Record")
            state.button_play = ui.button(icon="hearing", on_click=on_record_play).props("flat round dense").tooltip("Play recording")
            state.button_compress = ui.button(icon="graphic_eq", on_click=on_add_dynamic_compression).props("flat round dense").tooltip("Compress")
    draw()

def detect_lan_ip() -> Optional[str]:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None

def ensure_cert(cert_path: Path, key_path: Path) -> None:
    if cert_path.exists() and key_path.exists():
        return
    cert_path.parent.mkdir(parents=True, exist_ok=True)
    sans = ["DNS:localhost", "IP:127.0.0.1"]
    ip = detect_lan_ip()
    if ip:
        sans.append(f"IP:{ip}")
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", str(key_path), "-out", str(cert_path),
        "-days", "3650", "-subj", "/CN=harken",
        "-addext", f"subjectAltName={','.join(sans)}",
    ], check=True)
    logging.info(f"Generated self-signed cert for {sans} at {cert_path}")

def main(reload=False):
    parser = argparse.ArgumentParser()
    # parser.add_argument('dirs', nargs='+', help='Media directories, can be several')
    parser.add_argument("--uttale", help="Uttale API base URL (defaults to http/https://localhost:7010 based on --ssl)", default=None)
    parser.add_argument("--host", help="Host/interface to bind to", default="0.0.0.0")
    parser.add_argument("--ssl", action="store_true", help="Serve over HTTPS (self-signed cert, needed for mic access over LAN)")
    parser.add_argument("--ssl-cert", default=str(Path.home() / ".cache/srst-harken/cert.pem"), help="TLS certificate path")
    parser.add_argument("--ssl-key", default=str(Path.home() / ".cache/srst-harken/key.pem"), help="TLS private key path")
    args = parser.parse_args()
    logging.info(f"Args: {args}")
    global api
    uttale = args.uttale or f"{'https' if args.ssl else 'http'}://localhost:7010"
    api = UttaleAPI(uttale)
    ssl_kwargs = {}
    if args.ssl:
        cert, key = Path(args.ssl_cert), Path(args.ssl_key)
        ensure_cert(cert, key)
        ssl_kwargs = {"ssl_certfile": str(cert), "ssl_keyfile": str(key)}
    ui.run(title="harken", native=False, show=False, reload=reload, host=args.host, **ssl_kwargs)


if __name__ in {"__main__", "__mp_main__"}:
    main(reload=True)
