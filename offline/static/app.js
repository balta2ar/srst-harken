const el = {
  banner: document.getElementById("banner"),
  viewFind: document.getElementById("view-find"),
  viewListen: document.getElementById("view-listen"),
  viewFav: document.getElementById("view-fav"),
  lines: document.getElementById("lines"),
  player: document.getElementById("player"),
  status: document.getElementById("status"),
  navFind: document.getElementById("nav-find"),
  navListen: document.getElementById("nav-listen"),
  navFav: document.getElementById("nav-fav"),
  favCount: document.getElementById("fav-count"),
  nowplaying: document.getElementById("nowplaying"),
  transport: document.getElementById("transport"),
  tPlay: document.getElementById("t-play"),
  clock: document.getElementById("clock"),
  clockNow: document.getElementById("clock-now"),
  clockTotal: document.getElementById("clock-total"),
  scrubber: document.getElementById("scrubber"),
  scrubFill: document.getElementById("scrub-fill"),
  scrubHandle: document.getElementById("scrub-handle"),
  scrubMarks: document.getElementById("scrub-marks"),
  topics: document.getElementById("topics"),
  topicsHead: document.getElementById("topics-head"),
  topicsCaret: document.getElementById("topics-caret"),
  topicsCount: document.getElementById("topics-count"),
  topicsList: document.getElementById("topics-list"),
};

const SEARCH_CHIPS = ["idioti 2026", "kontakt 2026", "saltIAran 2026", "VernaBedrift 2026", "heimelaga 2026", "ukesnytt 2026"];

let tl = null;            // current Timeline model
let audioVtt = null;     // which segment blob is loaded
let currentSeg = 0;      // active segment index
let currentLine = -1;    // active line idx
let autoscroll = false;  // follow the playing line (toggled via the total-time tap)
let topicsOpen = false;  // topics panel expanded (persists across episodes in-session)

function episodeKeyOf(vtt) { return vtt.split("/").slice(0, 3).join("/"); }
function podcastOf(vtt) { return vtt.split("/")[1] || vtt; }
function dateOf(vtt) { return vtt.split("/")[2] || ""; }

function showView(which) {
  el.viewFind.hidden = which !== "find";
  el.viewListen.hidden = which !== "listen";
  el.viewFav.hidden = which !== "fav";
  const listening = which === "listen";
  el.nowplaying.hidden = !listening;
  el.transport.hidden = !listening;
  el.navFind.classList.toggle("active", which === "find");
  el.navListen.classList.toggle("active", which === "listen");
  el.navFav.classList.toggle("active", which === "fav");
}
el.navFind.onclick = () => { renderFind(); showView("find"); };
el.navListen.onclick = () => showView("listen");
el.navFav.onclick = () => {
  showView("fav");
  renderFav();
  if (navigator.onLine) syncFavorites().then(renderFav);
};

async function updateStatus() {
  const favs = await DB.all("favorites");
  const active = favs.filter((f) => f.status !== "deleted");
  const pending = favs.filter((f) => f.status !== "synced").length;
  el.status.textContent = (navigator.onLine ? "📶" : "✈️") + " " + pending;
  el.status.title = (navigator.onLine ? "online" : "offline") + ` · ${pending} pending`;
  el.favCount.textContent = active.length;
  el.favCount.hidden = active.length === 0;
}
window.addEventListener("online", () => { syncFavorites().then(updateStatus); });
window.addEventListener("offline", updateStatus);

const VTT_TS = /^\d{2}:\d{2}:\d{2}\.\d{3}$/;

// One-time heal: drop favorites saved by an earlier build with a numeric start
// (e.g. 11.3 instead of "00:00:11.300"). The backend rejected those with HTTP 422
// so they were never stored server-side and only jammed the pending counter.
async function migrateFavorites() {
  for (const f of await DB.all("favorites")) {
    if (typeof f.start !== "string" || !VTT_TS.test(f.start)) {
      await DB.del("favorites", f.id);
    }
  }
}

// ---------- Find ----------
async function renderFind(initialQuery) {
  el.viewFind.innerHTML = "";
  const chips = document.createElement("div");
  chips.id = "chips";
  el.viewFind.appendChild(chips);
  const input = document.createElement("input");
  input.id = "search";
  input.placeholder = "Search podcast / episode (e.g. Marianne 20210316)";
  el.viewFind.appendChild(input);

  const cachedHdr = document.createElement("h3");
  cachedHdr.textContent = "On this device";
  el.viewFind.appendChild(cachedHdr);
  const cachedBox = document.createElement("div");
  el.viewFind.appendChild(cachedBox);
  el.cachedBox = cachedBox;
  await renderCached(cachedBox);

  const resultsHdr = document.createElement("h3");
  resultsHdr.textContent = "Search results";
  el.viewFind.appendChild(resultsHdr);
  const resultsBox = document.createElement("div");
  el.viewFind.appendChild(resultsBox);

  const reset = document.createElement("button");
  reset.className = "danger";
  reset.textContent = "Reset local data";
  reset.title = "Wipe cached episodes and favorites on this device (server is untouched)";
  reset.onclick = () => resetLocal();
  el.viewFind.appendChild(reset);

  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => search(input.value, resultsBox), 600);
  };
  for (const c of SEARCH_CHIPS) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = c;
    b.onclick = () => { input.value = c; search(c, resultsBox); };
    chips.appendChild(b);
  }
  if (initialQuery) { input.value = initialQuery; search(initialQuery, resultsBox); }
}

function gotoFind(query) {
  renderFind(query);
  showView("find");
}

async function renderCached(box) {
  box.innerHTML = "";
  const eps = await DB.all("episodes");
  if (!eps.length) { box.innerHTML = "<p><small>Nothing cached yet.</small></p>"; return; }
  eps.sort((a, b) =>
    a.podcast !== b.podcast ? (a.podcast < b.podcast ? -1 : 1) : (a.date < b.date ? 1 : -1));
  for (const ep of eps) {
    const row = document.createElement("div");
    row.className = "episode";
    const label = document.createElement("span");
    label.innerHTML = `${ep.podcast} <small>${ep.date} · ${ep.segments.length} seg</small>`;
    label.onclick = () => openEpisode(ep.key);
    const actions = document.createElement("span");
    actions.className = "row-actions";
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.onclick = async (e) => { e.stopPropagation(); await deleteEpisode(ep); renderCached(box); };
    actions.appendChild(del);
    row.appendChild(label);
    row.appendChild(actions);
    box.appendChild(row);
  }
}

async function cachedEpisodeKeys() {
  return new Set((await DB.all("episodes")).map((e) => e.key));
}

async function search(query, box) {
  box.innerHTML = "<p><small>Searching…</small></p>";
  let data;
  try { data = await Api.scopes(query); }
  catch (e) { box.innerHTML = "<p><small>Offline — can't search.</small></p>"; return; }
  const groups = {};
  for (const vtt of data.results || []) {
    const k = episodeKeyOf(vtt);
    (groups[k] = groups[k] || []).push(vtt);
  }
  box.innerHTML = "";
  const keys = Object.keys(groups);
  if (!keys.length) { box.innerHTML = "<p><small>No matches.</small></p>"; return; }
  const cached = await cachedEpisodeKeys();
  // newest episode first: by date (YYYYMMDD) desc, ties by podcast name
  keys.sort((a, b) => {
    const da = a.split("/")[2] || "", db = b.split("/")[2] || "";
    if (da !== db) return db < da ? -1 : 1;
    return a < b ? -1 : 1;
  });
  for (const k of keys) {
    const segs = groups[k].sort();
    const row = document.createElement("div");
    row.className = "episode";
    const label = document.createElement("span");
    label.innerHTML = `${podcastOf(segs[0])} <small>${dateOf(segs[0])} · ${segs.length} seg</small>`;
    row.appendChild(label);
    if (cached.has(k)) {
      row.classList.add("downloaded");
      row.onclick = () => openEpisode(k);
    } else {
      row.onclick = () => downloadEpisode(k, segs, label);
    }
    box.appendChild(row);
  }
}

async function downloadEpisode(key, segs, label) {
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (e) {}
  }
  let done = 0;
  for (const vtt of segs) {
    label.innerHTML = `${podcastOf(vtt)} <small>downloading ${done}/${segs.length}…</small>`;
    const linesData = await Api.lines(vtt);
    const lines = (linesData.results || []).map((r) => ({ start: r.start, end: r.end, text: r.text }));
    const audio = await Api.audioBlob(vtt);
    await DB.put("segments", { vtt, lines, audio });
    done += 1;
  }
  await DB.put("episodes", {
    key, podcast: podcastOf(segs[0]), date: dateOf(segs[0]),
    segments: segs, cachedAt: new Date().toISOString(),
  });
  label.innerHTML = `${podcastOf(segs[0])} <small>${dateOf(segs[0])} · cached</small>`;
  const row = label.closest(".episode");
  if (row) row.classList.add("downloaded");
  if (el.cachedBox) renderCached(el.cachedBox);
}

async function deleteEpisode(ep) {
  for (const vtt of ep.segments) await DB.del("segments", vtt);
  await DB.del("episodes", ep.key);
}

async function resetLocal() {
  if (!confirm("Wipe all cached episodes and favorites on this device? The server is not affected; synced favorites will sync back when online.")) return;
  el.player.pause();
  el.player.removeAttribute("src");
  el.player.load();
  await DB.reset();
  tl = null;
  audioVtt = null;
  currentSeg = 0;
  currentLine = -1;
  setAutoscroll(false);
  await updateStatus();
  renderFind();
  showView("find");
}

// ---------- Listen ----------
async function openEpisode(key) {
  const ep = await DB.get("episodes", key);
  if (!ep) return;
  el.player.pause();
  el.player.removeAttribute("src");
  el.player.load();
  const segments = [];
  for (const vtt of ep.segments) {
    const seg = await DB.get("segments", vtt);
    if (seg) segments.push({ vtt, lines: seg.lines });
  }
  tl = Timeline.build(segments);
  audioVtt = null;
  currentSeg = 0;
  currentLine = -1;
  setAutoscroll(false);
  await loadTopics(ep);
  await renderLines();
  renderTopics();
  renderMarks();
  renderTopicMarks();
  updateClock(0);
  showView("listen");
}

async function favIds() {
  const favs = await DB.all("favorites");
  const set = new Set();
  for (const f of favs) if (f.status !== "deleted") set.add(f.id);
  return set;
}

async function renderLines() {
  el.lines.innerHTML = "";
  const favSet = await favIds();
  tl.lines.forEach((ln) => {
    const id = ln.vtt + "|" + ln.startStr;
    const li = document.createElement("li");
    li.className = "line";
    li.dataset.index = ln.idx;
    const star = document.createElement("button");
    star.className = "star";
    star.textContent = favSet.has(id) ? "★" : "☆";
    star.onclick = (e) => { e.stopPropagation(); toggleFavorite(ln, star); };
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = ln.text;
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = Timeline.fmt(ln.epStart);
    li.appendChild(star);
    li.appendChild(text);
    li.appendChild(ts);
    li.onclick = () => playLine(ln.idx);
    el.lines.appendChild(li);
  });
}

function renderMarks() {
  el.scrubMarks.querySelectorAll(".mark").forEach((n) => n.remove());
  if (!tl || !tl.total) return;
  favIds().then((set) => {
    for (const ln of tl.lines) {
      if (set.has(ln.vtt + "|" + ln.startStr)) {
        const m = document.createElement("div");
        m.className = "mark";
        m.style.left = (100 * ln.epStart / tl.total) + "%";
        el.scrubMarks.appendChild(m);
      }
    }
  });
}

async function loadTopics(ep) {
  let results;
  if (navigator.onLine) {
    try {
      const data = await Api.topics(ep.segments[0]);
      if (data && Array.isArray(data.results)) {
        results = data.results;
        ep.topics = results;
        await DB.put("episodes", ep);
      }
    } catch (e) { /* fall back to cache */ }
  }
  if (!results) results = Array.isArray(ep.topics) ? ep.topics : [];
  tl.topics = results.map((t) => ({
    title: t.title, start: t.start, epStart: Timeline.tsToSeconds(t.start),
  }));
}

function renderTopics() {
  if (!tl || !tl.topics || !tl.topics.length) { el.topics.hidden = true; return; }
  el.topicsCount.textContent = tl.topics.length;
  const rows = tl.topics.map((t) => {
    const li = document.createElement("li");
    li.className = "topic";
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = Timeline.fmt(t.epStart);
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = t.title;
    li.appendChild(ts);
    li.appendChild(title);
    li.onclick = () => seekTopic(t);
    return li;
  });
  el.topicsList.replaceChildren(...rows);
  el.topicsList.hidden = !topicsOpen;
  el.topicsCaret.textContent = topicsOpen ? "▾" : "▸";
  el.topicsHead.setAttribute("aria-expanded", topicsOpen ? "true" : "false");
  el.topics.hidden = false;
}

function renderTopicMarks() {
  el.scrubMarks.querySelectorAll(".topic-mark").forEach((n) => n.remove());
  if (!tl || !tl.total || !tl.topics) return;
  for (const t of tl.topics) {
    const m = document.createElement("div");
    m.className = "topic-mark";
    m.style.left = (100 * t.epStart / tl.total) + "%";
    el.scrubMarks.appendChild(m);
  }
}

function seekTopic(t) {
  seekEp(t.epStart);
  setTimeout(scrollToCurrent, 0);
}

function toggleTopics() {
  topicsOpen = !topicsOpen;
  el.topicsList.hidden = !topicsOpen;
  el.topicsCaret.textContent = topicsOpen ? "▾" : "▸";
  el.topicsHead.setAttribute("aria-expanded", topicsOpen ? "true" : "false");
}
el.topicsHead.onclick = toggleTopics;

async function loadSegment(si) {
  const seg = tl.segments[si];
  const rec = await DB.get("segments", seg.vtt);
  if (!rec) return false;
  const prev = el.player.src;
  el.player.src = URL.createObjectURL(rec.audio);
  if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
  audioVtt = seg.vtt;
  currentSeg = si;
  return true;
}

async function seekLine(idx, { play }) {
  const ln = tl.lines[idx];
  if (audioVtt !== ln.vtt) { if (!(await loadSegment(ln.segIndex))) return; }
  el.player.currentTime = ln.start;
  if (play) el.player.play();
  setActive(idx);
  updateClock(ln.epStart);
}

async function playLine(idx) {
  await seekLine(idx, { play: true });
}

async function jumpToFavorite(filename, startStr) {
  const key = episodeKeyOf(filename);
  const ep = await DB.get("episodes", key);
  if (!ep) { gotoFind(podcastOf(filename) + " " + dateOf(filename)); return; }
  await openEpisode(key);
  const idx = tl.lines.findIndex((l) => l.vtt === filename && l.startStr === startStr);
  if (idx < 0) return;
  await seekLine(idx, { play: false });
  const li = el.lines.querySelector(`.line[data-index="${idx}"]`);
  if (li) li.scrollIntoView({ block: "center", behavior: "smooth" });
}

async function seekEp(epTarget) {
  if (!tl || !tl.total) return;
  const { segIndex, segLocalTime } = Timeline.segAtEpTime(tl, epTarget);
  if (segIndex !== currentSeg || audioVtt !== tl.segments[segIndex].vtt) {
    if (!(await loadSegment(segIndex))) return;
  }
  el.player.currentTime = Math.max(0, segLocalTime);
  el.player.play();
}

function setActive(idx) {
  if (idx === currentLine) return;
  el.lines.querySelectorAll(".line.active").forEach((n) => n.classList.remove("active"));
  const li = el.lines.querySelector(`.line[data-index="${idx}"]`);
  if (li) { li.classList.add("active"); if (autoscroll) li.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  currentLine = idx;
}

function scrollToCurrent() {
  const li = el.lines.querySelector(".line.active");
  if (li) li.scrollIntoView({ block: "center", behavior: "smooth" });
}

function updateClock(epNow) {
  el.clockNow.textContent = Timeline.fmt(epNow);
  el.clockTotal.textContent = Timeline.fmt(tl ? tl.total : 0);
  if (tl && tl.total) {
    const pct = (100 * epNow / tl.total) + "%";
    el.scrubFill.style.width = pct;
    el.scrubHandle.style.left = pct;
  }
}

el.player.addEventListener("timeupdate", () => {
  if (!tl) return;
  const epNow = tl.segments[currentSeg].offset + el.player.currentTime;
  updateClock(epNow);
  const i = Timeline.lineAtEpTime(tl, epNow);
  if (i >= 0) setActive(i);
});

el.player.addEventListener("ended", () => {
  if (!tl) return;
  if (currentSeg + 1 < tl.segments.length) {
    loadSegment(currentSeg + 1).then((ok) => { if (ok) { el.player.currentTime = 0; el.player.play(); } });
  }
});

el.tPlay.onclick = () => {
  if (el.player.paused) el.player.play(); else el.player.pause();
};
el.player.addEventListener("play", () => { el.tPlay.textContent = "⏸"; });
el.player.addEventListener("pause", () => { el.tPlay.textContent = "▶"; });

el.clockNow.onclick = () => scrollToCurrent();
el.clockTotal.onclick = () => { setAutoscroll(!autoscroll); if (autoscroll) scrollToCurrent(); };

function setAutoscroll(on) {
  autoscroll = on;
  el.clockTotal.classList.toggle("autoscroll-on", on);
}

function scrubToEvent(ev) {
  const rect = el.scrubber.getBoundingClientRect();
  const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
  const f = Math.min(1, Math.max(0, (cx - rect.left) / rect.width));
  seekEp(f * (tl ? tl.total : 0));
}
let scrubbing = false;
el.scrubber.addEventListener("pointerdown", (ev) => {
  scrubbing = true;
  el.scrubber.setPointerCapture(ev.pointerId);
  scrubToEvent(ev);
});
el.scrubber.addEventListener("pointermove", (ev) => { if (scrubbing) scrubToEvent(ev); });
el.scrubber.addEventListener("pointerup", () => { scrubbing = false; });
el.scrubber.addEventListener("pointercancel", () => { scrubbing = false; });

// ---------- Favorites ----------
async function toggleFavorite(ln, star) {
  // Identity uses the VTT-string start so it matches the server (which stores
  // start as a VTT string). tl.lines carries startStr; Favorites-view callers
  // pass an object whose start is already the stored VTT string.
  const startStr = ln.startStr || ln.start;
  const endStr = ln.endStr || ln.end;
  const id = ln.vtt + "|" + startStr;
  const existing = await DB.get("favorites", id);
  if (!existing) {
    await DB.put("favorites", {
      id, filename: ln.vtt, start: startStr, end: endStr, text: ln.text,
      status: "pending", updatedAt: new Date().toISOString(),
    });
    if (star) star.textContent = "★";
  } else if (existing.status === "synced") {
    existing.status = "deleted";
    existing.updatedAt = new Date().toISOString();
    await DB.put("favorites", existing);
    if (star) star.textContent = "☆";
  } else {
    await DB.del("favorites", id);
    if (star) star.textContent = "☆";
  }
  updateStatus();
  renderMarks();
  if (navigator.onLine) syncFavorites().then(updateStatus);
}

async function epStartForFav(f) {
  // Episode-absolute time if the episode is cached; else segment-relative start.
  const ep = await DB.get("episodes", episodeKeyOf(f.filename));
  if (!ep) return Timeline.fmt(Timeline.tsToSeconds(f.start));
  const segments = [];
  for (const vtt of ep.segments) {
    const seg = await DB.get("segments", vtt);
    if (seg) segments.push({ vtt, lines: seg.lines });
  }
  const t = Timeline.build(segments);
  const hit = t.lines.find((l) => l.vtt === f.filename && l.start === Timeline.tsToSeconds(f.start));
  return Timeline.fmt(hit ? hit.epStart : Timeline.tsToSeconds(f.start));
}

// Map (filename, start) -> line index within the file. Line order comes from the
// cached episode segments, else a one-shot /api/lines fetch when online. Returns a
// per-render memoized resolver; favorites whose file order is unknown get undefined
// (and therefore render ungrouped).
async function buildLineIndexResolver(filenames) {
  const byFileStart = {};
  for (const filename of filenames) {
    let starts = null;
    const ep = await DB.get("episodes", episodeKeyOf(filename));
    if (ep) {
      const seg = await DB.get("segments", filename);
      if (seg) starts = seg.lines.map((l) => l.start);
    }
    if (!starts && navigator.onLine) {
      try {
        const data = await Api.lines(filename);
        if (data && Array.isArray(data.results)) starts = data.results.map((l) => l.start);
      } catch (e) { /* leave unknown */ }
    }
    if (starts) starts.forEach((s, i) => { byFileStart[filename + "|" + s] = i; });
  }
  return (f) => {
    const k = f.filename + "|" + f.start;
    return Object.prototype.hasOwnProperty.call(byFileStart, k) ? byFileStart[k] : undefined;
  };
}

function tsSeconds(s) {
  const p = String(s).split(":");
  if (p.length !== 3) return NaN;
  return (+p[0]) * 3600 + (+p[1]) * 60 + parseFloat(p[2]);
}

// Pure: collapse favorites that occupy consecutive line indices in the same file into
// ordered groups. indexOf(f) -> line index or undefined. Favorites with unknown index,
// or non-adjacent indices, or in different files, end up in separate groups.
function groupFavorites(favs, indexOf) {
  const byFile = {};
  for (const f of favs) (byFile[f.filename] = byFile[f.filename] || []).push(f);
  const groups = [];
  for (const filename of Object.keys(byFile)) {
    const items = byFile[filename]
      .map((f) => ({ f, idx: indexOf(f) }))
      .sort((a, b) => tsSeconds(a.f.start) - tsSeconds(b.f.start));
    let cur = null, prevIdx = null;
    for (const { f, idx } of items) {
      const adjacent = cur && idx !== undefined && prevIdx !== undefined && idx === prevIdx + 1;
      if (adjacent) { cur.push(f); } else { cur = [f]; groups.push(cur); }
      prevIdx = idx;
    }
  }
  return groups;
}


async function renderFav() {
  // Non-re-entrant + coalescing: renderFav is triggered from several places
  // (tab open, background sync's .then, delete/toggle handlers) and its body
  // awaits per-row (epStartForFav). Without this guard, two passes interleave
  // their appends into el.viewFav and rows appear duplicated.
  if (renderFav._running) { renderFav._again = true; return; }
  renderFav._running = true;
  try {
    do { renderFav._again = false; await _renderFav(); } while (renderFav._again);
  } finally { renderFav._running = false; }
}

async function _renderFav() {
  const frag = document.createDocumentFragment();
  const hdr = document.createElement("div");
  hdr.className = "episode";
  const exportAll = document.createElement("button");
  exportAll.textContent = "Export all (unexported)";
  exportAll.onclick = () => exportAllUnexported(exportAll);
  hdr.appendChild(exportAll);
  frag.appendChild(hdr);

  const favs = (await DB.all("favorites")).filter((f) => f.status !== "deleted");
  if (!favs.length) {
    frag.appendChild(document.createRange().createContextualFragment("<p><small>No favorites yet.</small></p>"));
    el.viewFav.replaceChildren(frag);
    return;
  }
  const files = [...new Set(favs.map((f) => f.filename))];
  const indexOf = await buildLineIndexResolver(files);
  const groups = groupFavorites(favs, indexOf);
  // Most-recently-touched group first (by max member updatedAt).
  groups.sort((a, b) => groupUpdatedAt(b) < groupUpdatedAt(a) ? -1 : 1);

  for (const group of groups) {
    const row = document.createElement("div");
    row.className = "fav";
    const file = group[0].filename;
    const ts = document.createElement("span");
    ts.className = "ts link";
    ts.textContent = await epStartForFav(group[0]);
    ts.title = "Jump to this moment";
    ts.onclick = () => jumpToFavorite(file, group[0].start);
    const body = document.createElement("div");
    body.className = "text";
    const t = document.createElement("div");
    t.textContent = group.map((f) => f.text).join(" ");
    const meta = document.createElement("div");
    meta.className = "meta";
    const pod = document.createElement("span");
    pod.className = "link";
    pod.textContent = podcastOf(file);
    pod.title = "Find this podcast";
    pod.onclick = () => gotoFind(podcastOf(file));
    const date = document.createElement("span");
    date.className = "link";
    date.textContent = dateOf(file);
    date.title = "Find this episode";
    date.onclick = () => gotoFind(podcastOf(file) + " " + dateOf(file));
    meta.appendChild(pod);
    meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(date);
    if (group.length > 1) meta.appendChild(document.createTextNode(` · ${group.length} lines`));
    body.appendChild(t);
    body.appendChild(meta);
    const send = document.createElement("button");
    const exported = group.every((f) => f.exported_at);
    if (exported) {
      send.classList.add("exported");
      send.textContent = "✓";
      send.title = "Exported " + fmtExportedAt(group[0].exported_at) + " — tap to send again";
    } else {
      send.textContent = "✈";
      send.title = "Send to Telegram";
    }
    send.onclick = () => sendGroup(group, send);
    const del = document.createElement("button");
    del.title = "Delete";
    del.textContent = "🗑";
    del.onclick = () => deleteGroup(group);
    row.appendChild(ts);
    row.appendChild(body);
    row.appendChild(send);
    row.appendChild(del);
    frag.appendChild(row);
  }
  el.viewFav.replaceChildren(frag);
}

function groupUpdatedAt(group) {
  return group.reduce((m, f) => (f.updatedAt > m ? f.updatedAt : m), "");
}

function fmtExportedAt(iso) {
  try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
}

async function deleteGroup(group) {
  for (const f of group) {
    await toggleFavorite({ vtt: f.filename, start: f.start, end: f.end, text: f.text }, null);
  }
  renderFav();
}


// Send one combined clip for a group: audio spans the first member's start to the
// last member's end, caption is the members' texts joined. The backend stamps
// set_exported on the span's start; mark the remaining members exported locally so
// the group shows fully-exported and the state syncs.
async function exportGroup(group) {
  const first = group[0], last = group[group.length - 1];
  const payload = {
    filename: first.filename, start: first.start, end: last.end || last.start,
    text: group.map((f) => f.text).join(" "),
  };
  const r = await Api.exportFav(payload);
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.detail || r.status);
  }
  // The combined send stamps only the span's start server-side; mark every member so
  // the whole group's exported state survives the next sync/reconcile.
  const now = new Date().toISOString();
  for (const f of group) {
    try { await Api.markExported(f.filename, f.start); } catch (e) { /* local mark still applied */ }
    f.exported_at = now;
    await DB.put("favorites", f);
  }
}

async function sendGroup(group, btn) {
  if (!navigator.onLine) { btn.textContent = "off"; setTimeout(() => (btn.textContent = "✈"), 1000); return; }
  btn.textContent = "…";
  try {
    await exportGroup(group);
    renderFav();
  } catch (e) { btn.textContent = "✈"; alert("Export failed: " + e.message); }
}

async function exportAllUnexported(btn) {
  if (!navigator.onLine) { alert("Need a connection to export."); return; }
  const favs = (await DB.all("favorites")).filter((f) => f.status !== "deleted");
  const indexOf = await buildLineIndexResolver([...new Set(favs.map((f) => f.filename))]);
  const pending = groupFavorites(favs, indexOf).filter((g) => g.some((f) => !f.exported_at));
  let sent = 0;
  for (const group of pending) {
    btn.textContent = `sending ${sent}/${pending.length}…`;
    try { await exportGroup(group); sent += 1; } catch (e) { /* skip */ }
  }
  btn.textContent = "Export all (unexported)";
  renderFav();
}

async function syncFavorites() {
  if (!navigator.onLine) return;
  // 1. sync up: flush local pending/deleted to the server
  for (const f of await DB.all("favorites")) {
    try {
      if (f.status === "pending") {
        const r = await Api.favAdd(f);
        if (r.ok) { f.status = "synced"; await DB.put("favorites", f); }
      } else if (f.status === "deleted") {
        const r = await Api.favDel(f.filename, f.start);
        if (r.ok || r.status === 404) await DB.del("favorites", f.id);
      }
    } catch (e) { /* stay queued */ }
  }
  // 2. pull down + reconcile the server list into IndexedDB
  let data;
  try { data = await Api.favList(); } catch (e) { return; }
  // Only reconcile against a well-formed list; never treat a missing/malformed
  // payload as "server has zero favorites" (that would delete the local mirror).
  if (!data || !Array.isArray(data.results)) return;
  const serverByKey = {};
  for (const s of data.results) {
    serverByKey[s.filename + "|" + s.start] = s;
  }
  await reconcileFavorites(serverByKey);
}

// Reconcile rule: local pending/deleted win until flushed; otherwise server wins;
// a local 'synced' row absent from the server was deleted elsewhere -> remove it.
async function reconcileFavorites(serverByKey) {
  const locals = await DB.all("favorites");
  const localById = {};
  for (const f of locals) localById[f.id] = f;

  for (const key of Object.keys(serverByKey)) {
    const s = serverByKey[key];
    const local = localById[key];
    if (!local) {
      await DB.put("favorites", {
        id: key, filename: s.filename, start: s.start, end: s.end || "",
        text: s.text || "", status: "synced",
        updatedAt: s.updated_at || new Date().toISOString(),
        exported_at: s.exported_at || null,
      });
    } else if (local.status === "synced") {
      local.text = s.text || "";
      local.end = s.end || "";
      local.exported_at = s.exported_at || null;
      await DB.put("favorites", local);
    }
    // local pending/deleted: leave untouched (intent wins; flush already attempted)
  }
  for (const f of locals) {
    if (f.status === "synced" && !serverByKey[f.id]) {
      await DB.del("favorites", f.id);
    }
  }
}

// ---------- Banner ----------
function maybeBanner() {
  if (localStorage.getItem("origin-hint-dismissed")) return;
  const h = location.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
  if (!isIp) return;
  el.banner.hidden = false;
  el.banner.innerHTML = "<span>Tip: open via your Tailscale name so favorites travel across networks.</span>";
  const x = document.createElement("button");
  x.textContent = "✕";
  x.onclick = () => { el.banner.hidden = true; localStorage.setItem("origin-hint-dismissed", "1"); };
  el.banner.appendChild(x);
}

// ---------- Boot ----------
(async function boot() {
  maybeBanner();
  await migrateFavorites();
  await updateStatus();
  if (navigator.onLine) { await syncFavorites(); await updateStatus(); }
  renderFind();
  showView("find");
})();
