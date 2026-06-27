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
  transportTop: document.getElementById("transport-top"),
  transport: document.getElementById("transport"),
  tPrev: document.getElementById("t-prev"),
  tPlay: document.getElementById("t-play"),
  tNext: document.getElementById("t-next"),
  clock: document.getElementById("clock"),
  scrubber: document.getElementById("scrubber"),
  scrubFill: document.getElementById("scrub-fill"),
  scrubHandle: document.getElementById("scrub-handle"),
  scrubMarks: document.getElementById("scrub-marks"),
};

const SEARCH_CHIPS = ["idioti 2026", "kontakt 2026", "saltIAran 2026", "VernaBedrift 2026", "heimelaga 2026"];

let tl = null;            // current Timeline model
let audioVtt = null;     // which segment blob is loaded
let currentSeg = 0;      // active segment index
let currentLine = -1;    // active line idx

function episodeKeyOf(vtt) { return vtt.split("/").slice(0, 3).join("/"); }
function podcastOf(vtt) { return vtt.split("/")[1] || vtt; }
function dateOf(vtt) { return vtt.split("/")[2] || ""; }

function showView(which) {
  el.viewFind.hidden = which !== "find";
  el.viewListen.hidden = which !== "listen";
  el.viewFav.hidden = which !== "fav";
  const listening = which === "listen";
  el.transportTop.hidden = !listening;
  el.transport.hidden = !listening;
  el.navFind.classList.toggle("active", which === "find");
  el.navListen.classList.toggle("active", which === "listen");
  el.navFav.classList.toggle("active", which === "fav");
}
el.navFind.onclick = () => { renderFind(); showView("find"); };
el.navListen.onclick = () => showView("listen");
el.navFav.onclick = () => { renderFav(); showView("fav"); };

async function updateStatus() {
  const favs = await DB.all("favorites");
  const pending = favs.filter((f) => f.status !== "synced").length;
  el.status.textContent = (navigator.onLine ? "⛅" : "⚡") + pending;
  el.status.title = (navigator.onLine ? "online" : "offline") + ` · ${pending} pending`;
}
window.addEventListener("online", () => { syncFavorites().then(updateStatus); });
window.addEventListener("offline", updateStatus);

// ---------- Find ----------
async function renderFind() {
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
  await renderCached(cachedBox);

  const resultsHdr = document.createElement("h3");
  resultsHdr.textContent = "Search results";
  el.viewFind.appendChild(resultsHdr);
  const resultsBox = document.createElement("div");
  el.viewFind.appendChild(resultsBox);

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
}

async function renderCached(box) {
  box.innerHTML = "";
  const eps = await DB.all("episodes");
  if (!eps.length) { box.innerHTML = "<p><small>Nothing cached yet.</small></p>"; return; }
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
    row.onclick = () => downloadEpisode(k, segs, label);
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
  openEpisode(key);
}

async function deleteEpisode(ep) {
  for (const vtt of ep.segments) await DB.del("segments", vtt);
  await DB.del("episodes", ep.key);
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
  await renderLines();
  renderMarks();
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
    const id = ln.vtt + "|" + ln.start;
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
  el.scrubMarks.innerHTML = "";
  if (!tl || !tl.total) return;
  favIds().then((set) => {
    for (const ln of tl.lines) {
      if (set.has(ln.vtt + "|" + ln.start)) {
        const m = document.createElement("div");
        m.className = "mark";
        m.style.left = (100 * ln.epStart / tl.total) + "%";
        el.scrubMarks.appendChild(m);
      }
    }
  });
}

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

async function playLine(idx) {
  const ln = tl.lines[idx];
  if (audioVtt !== ln.vtt) { if (!(await loadSegment(ln.segIndex))) return; }
  el.player.currentTime = ln.start;
  el.player.play();
  setActive(idx);
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
  if (li) { li.classList.add("active"); li.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  currentLine = idx;
}

function updateClock(epNow) {
  el.clock.textContent = Timeline.fmt(epNow) + " / " + Timeline.fmt(tl ? tl.total : 0);
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
el.tPrev.onclick = () => { if (currentLine > 0) playLine(currentLine - 1); };
el.tNext.onclick = () => { if (tl && currentLine + 1 < tl.lines.length) playLine(currentLine + 1); };

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
  const id = ln.vtt + "|" + ln.start;
  const existing = await DB.get("favorites", id);
  if (!existing) {
    await DB.put("favorites", {
      id, filename: ln.vtt, start: ln.start, end: ln.end, text: ln.text,
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

async function renderFav() {
  el.viewFav.innerHTML = "";
  const hdr = document.createElement("div");
  hdr.className = "episode";
  const exportAll = document.createElement("button");
  exportAll.textContent = "Export all (unexported)";
  exportAll.onclick = () => exportAllUnexported(exportAll);
  hdr.appendChild(exportAll);
  el.viewFav.appendChild(hdr);

  const favs = (await DB.all("favorites")).filter((f) => f.status !== "deleted");
  favs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  if (!favs.length) { el.viewFav.insertAdjacentHTML("beforeend", "<p><small>No favorites yet.</small></p>"); return; }
  for (const f of favs) {
    const row = document.createElement("div");
    row.className = "fav";
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = await epStartForFav(f);
    const body = document.createElement("div");
    body.className = "text";
    const t = document.createElement("div");
    t.textContent = f.text;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${podcastOf(f.filename)} · ${dateOf(f.filename)}`;
    body.appendChild(t);
    body.appendChild(meta);
    const send = document.createElement("button");
    send.title = "Send to Telegram";
    send.textContent = "✈";
    if (f.exported_at) { send.classList.add("exported"); send.textContent = "✓"; }
    send.onclick = () => sendFav(f, send);
    const del = document.createElement("button");
    del.title = "Delete";
    del.textContent = "🗑";
    del.onclick = async () => { await toggleFavorite({ vtt: f.filename, start: f.start, end: f.end, text: f.text }, null); renderFav(); };
    row.appendChild(ts);
    row.appendChild(body);
    row.appendChild(send);
    row.appendChild(del);
    el.viewFav.appendChild(row);
  }
}

async function sendFav(f, btn) {
  if (!navigator.onLine) { btn.textContent = "off"; setTimeout(() => (btn.textContent = "✈"), 1000); return; }
  btn.textContent = "…";
  try {
    const r = await Api.exportFav(f);
    if (r.ok) {
      f.exported_at = new Date().toISOString();
      await DB.put("favorites", f);
      btn.textContent = "✓"; btn.classList.add("exported");
    } else {
      const d = await r.json().catch(() => ({}));
      btn.textContent = "✈"; alert("Export failed: " + (d.detail || r.status));
    }
  } catch (e) { btn.textContent = "✈"; alert("Export failed: " + e); }
}

async function exportAllUnexported(btn) {
  if (!navigator.onLine) { alert("Need a connection to export."); return; }
  const favs = (await DB.all("favorites")).filter((f) => f.status !== "deleted" && !f.exported_at);
  let sent = 0;
  for (const f of favs) {
    btn.textContent = `sending ${sent}/${favs.length}…`;
    try {
      const r = await Api.exportFav(f);
      if (r.ok) { f.exported_at = new Date().toISOString(); await DB.put("favorites", f); sent += 1; }
    } catch (e) { /* skip */ }
  }
  btn.textContent = "Export all (unexported)";
  renderFav();
}

async function syncFavorites() {
  if (!navigator.onLine) return;
  const favs = await DB.all("favorites");
  for (const f of favs) {
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
  await updateStatus();
  if (navigator.onLine) { await syncFavorites(); await updateStatus(); }
  renderFind();
  showView("find");
})();
