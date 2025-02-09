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
from bisect import bisect_left
from collections import namedtuple
from dataclasses import dataclass
from json import loads
from pathlib import Path
from time import perf_counter
from typing import Callable, List, Optional
from urllib.error import URLError
from urllib.parse import quote, urlencode
from urllib.request import urlopen

from nicegui import ui
from nicegui.elements.audio import Audio
from nicegui.elements.button import Button
from nicegui.elements.input import Input
from nicegui.elements.link import Link
from nicegui.events import KeyEventArguments
from pydantic import BaseModel

api = None
logging.basicConfig(level=logging.DEBUG)

MEDIA = {".mp3", ".mp4", ".mkv", ".avi", ".webm", ".opus", ".ogg"}
SUBS = {".vtt"}

SCOPE_LIMIT = 100
SEARCH_LIMIT = 100
SubAndMedia = namedtuple("NamedPair", ["sub", "media"])

def slurp(path):
    logging.info(f"Slurping {path}")
    with open(path, "rb") as f:
        return f.read()

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

            with urlopen(url) as response:
                data = response.read()
                response_time = perf_counter() - start_time

                response_json = loads(data.decode())
                self.logger.info(f"Received in {response_time:.3f}s: response size: {len(response_json)}")
                return response_json

        except URLError as e:
            self.logger.error(f"API Error: {e}")
            return None

    def search_scopes(self, query: str, limit: int = 1000) -> List[str]:
        result = self._make_request("/uttale/Scopes", {
            "q": query,
            "limit": limit,
        })
        if result and isinstance(result.get("results"), list):
            return result["results"]
        return []

    def search_text(self, query: str, scope: str = "", limit: int = 1000) -> List[SearchResult]:
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

            with urlopen("http://" + url.split("://")[1]) as response:
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
    def activate(self, at): # float (time in seconds) or int (index, # of the line)
        if isinstance(at, int): index = at
        elif isinstance(at, float): index = max(0, bisect_left(self.starts, at)-1)
        else: raise ValueError(f"Invalid type {type(at)}: {at}")
        self.lines[self.current_line].classes(remove="active")
        valid = 0 <= index < len(self.lines)
        if valid:
            self.lines[index].classes(add="active")
            self.current_line = index
    def add(self, line, start):
        self.lines.append(line)
        self.starts.append(start)

@dataclass
class UiState:
    files: List[SubAndMedia]
    current_file: SubAndMedia
    subtitles: [Subtitle]
    sub_lines: SubtitleLines
    player: MyPlayer
    button_record: Button
    button_play: Button
    button_compress: Button
    search_field: Input
    search_query: str
    search_scope_field: Input
    search_scope: str
    commands: [Callable]

def load_subtitles(scope) -> List[Subtitle]:
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

def link_to_media(vtt: str) -> str:
    media_file = with_extension(vtt, ".ogg")
    return f"{api.base_url}/uttale/Audio?filename={quote(media_file)}&start=&end="

def create_ui(args):
    where = "Erlend"
    scopes = api.search_scopes(where, limit=SCOPE_LIMIT)
    files = [SubAndMedia(sub=vtt, media=link_to_media(vtt)) for vtt in scopes]
    subtitles = load_subtitles(scopes[0])

    state = UiState(
        files=files,
        current_file=files[0],
        subtitles=subtitles,
        sub_lines=SubtitleLines(),
        player=MyPlayer(None),
        button_record=None,
        button_play=None,
        button_compress=None,
        search_field=None,
        search_query="",
        search_scope_field=None,
        search_scope=where,
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

    def play_line(sub: Subtitle): state.player.seek_and_play(sub.start)
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

    def on_key(ev: KeyEventArguments):
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

    @ui.refreshable
    def redraw_scopes(scope: str = None) -> None:
        scopes = api.search_scopes(state.search_scope, limit=SCOPE_LIMIT)
        files = [SubAndMedia(sub=vtt, media=link_to_media(vtt)) for vtt in scopes]
        state.files = files
        with ui.scroll_area().classes("border w-full h-80"):
            for f in state.files:
                on_click = lambda f=f: load_media(f)
                classes = "hover:underline cursor-pointer"
                if f == state.current_file: classes += " active"
                ui.label(f.sub).on("click", on_click).classes(classes)

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

    def on_change_scope(e):
        nonlocal state
        state.search_scope = state.search_scope_field.value
        redraw_scopes.refresh(state.search_scope)

    def on_search(e):
        nonlocal state
        state.search_query = state.search_field.value
        state.search_scope = state.search_scope_field.value
        redraw_search.refresh(state.search_query, state.search_scope_field.value)

    async def on_record_toggle(self):
        print(self)
        recording = await ui.run_javascript("""
if (window.recorder && window.recorder.state === 'recording') {
    window.recorder.stop()
    return false
} else {
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
        state.button_record.props(f'color={"red" if recording else "green"}')
    async def on_record_play():
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
    def on_add_dynamic_compression(self):
        ui.run_javascript("""
const context = new AudioContext()
const audioElement = document.querySelector('audio')
const source = context.createMediaElementSource(audioElement)
const compressor = context.createDynamicsCompressor()

compressor.threshold.setValueAtTime(-50, context.currentTime) // dB
compressor.knee.setValueAtTime(40, context.currentTime) // dB
compressor.ratio.setValueAtTime(12, context.currentTime)
compressor.attack.setValueAtTime(0, context.currentTime) // seconds
compressor.release.setValueAtTime(0.25, context.currentTime) // seconds

source.connect(compressor)
compressor.connect(context.destination)
console.log('Dynamic compression added')
""")
        self.sender.props(f'color={"green"}')
        self.sender.disable()

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
k -- Focus on search field
"""
        with ui.row().classes("w-full"):
            state.search_scope_field = ui.input(label="Search scope",
                                                value=state.search_scope,
                                                placeholder="Type something to search",
                                                on_change=on_change_scope).classes("w-2/12 pl-1").tooltip(shortcuts)
            state.search_field = ui.input(label="Search by word",
                                          value=state.search_query,
                                          placeholder="Type something to search",
                                          on_change=on_search).classes("w-2/12 pl-1").tooltip(shortcuts)
            state.button_record = ui.button("R").on("click", on_record_toggle).tooltip("Record audio")
            state.button_play = ui.button("P").on("click", on_record_play).tooltip("Play recorded audio")
            state.button_compress = ui.button("C").on("click", on_add_dynamic_compression).tooltip("Add dynamic compression")
            state.player.player = ui.audio(state.current_file.media).classes("w-5/12")
            state.player.player.on("timeupdate", player_update)
        with ui.row().classes("w-full"):
            with ui.column().classes("border w-4/12"):
                redraw_scopes(state.search_scope)
                redraw_search(state.search_query, state.search_scope)
            # with ui.column().classes('border w-5/12'):
            with ui.scroll_area().classes("border w-7/12 h-[90vh]"):
                with ui.row():
                    state.sub_lines.reset()
                    for s in state.subtitles:
                        on_click = lambda s=s: play_line(s)
                        with ui.row().classes("hover:ring-1"):
                            # l = ui.label(f'{s.text}').on('dblclick', on_click)
                            l = ui.label(f"{s.text}").on("click", on_click)
                            state.sub_lines.add(l, s.start)
        for c in state.commands: c()
        state.commands.clear()
    @ui.page("/")
    def main_page():
        overwrite_style()
        draw()

def main(reload=False):
    parser = argparse.ArgumentParser()
    # parser.add_argument('dirs', nargs='+', help='Media directories, can be several')
    parser.add_argument("--uttale", help="Uttale API base URL", default="http://localhost:7010")
    args = parser.parse_args()
    logging.info(f"Args: {args}")
    # app.on_startup(lambda: create_ui(args,))
    global api
    api = UttaleAPI(args.uttale)
    create_ui(args)
    ui.run(title="harken", native=False, show=False, reload=reload)


if __name__ in {"__main__", "__mp_main__"}:
    main(reload=True)
