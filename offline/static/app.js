const el = {
  viewFind: document.getElementById("view-find"),
  viewListen: document.getElementById("view-listen"),
  lines: document.getElementById("lines"),
  player: document.getElementById("player"),
  status: document.getElementById("status"),
  navFind: document.getElementById("nav-find"),
  navListen: document.getElementById("nav-listen"),
};

let current = { episodeKey: null, lines: [] }; // lines: [{vtt,start,end,text}]

function episodeKeyOf(vtt) {
  // 48k/<podcast>/<date>/by10m/by10m_NN.vtt  ->  48k/<podcast>/<date>
  const parts = vtt.split("/");
  return parts.slice(0, 3).join("/");
}
function podcastOf(vtt) { return vtt.split("/")[1] || vtt; }
function dateOf(vtt) { return vtt.split("/")[2] || ""; }

function showView(which) {
  el.viewFind.hidden = which !== "find";
  el.viewListen.hidden = which !== "listen";
}
el.navFind.onclick = () => { renderFind(); showView("find"); };
el.navListen.onclick = () => showView("listen");

async function updateStatus() {
  const favs = await DB.all("favorites");
  const pending = favs.filter((f) => f.status !== "synced").length;
  el.status.textContent =
    (navigator.onLine ? "online" : "offline") + ` · ${pending} pending`;
}
window.addEventListener("online", () => { syncFavorites().then(updateStatus); });
window.addEventListener("offline", updateStatus);

async function renderFind() {
  el.viewFind.innerHTML = "";
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
  try {
    const r = await fetch("/api/scopes?q=" + encodeURIComponent(query));
    data = await r.json();
  } catch (e) { box.innerHTML = "<p><small>Offline — can't search.</small></p>"; return; }
  const groups = {};
  for (const vtt of data.results || []) {
    const k = episodeKeyOf(vtt);
    (groups[k] = groups[k] || []).push(vtt);
  }
  box.innerHTML = "";
  const keys = Object.keys(groups).sort();
  if (!keys.length) { box.innerHTML = "<p><small>No matches.</small></p>"; return; }
  for (const k of keys) {
    const segs = groups[k].sort();
    const row = document.createElement("div");
    row.className = "episode";
    row.innerHTML = `${podcastOf(segs[0])} <small>${dateOf(segs[0])} · ${segs.length} seg</small>`;
    row.onclick = () => downloadEpisode(k, segs, row);
    box.appendChild(row);
  }
}

async function downloadEpisode(key, segs, row) {
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (e) {}
  }
  let done = 0;
  for (const vtt of segs) {
    row.innerHTML = `${podcastOf(vtt)} <small>downloading ${done}/${segs.length}…</small>`;
    const linesResp = await fetch("/api/lines?scope=" + encodeURIComponent(vtt));
    const linesData = await linesResp.json();
    const lines = (linesData.results || []).map((r) => ({
      start: r.start, end: r.end, text: r.text,
    }));
    const audioResp = await fetch("/api/audio?filename=" + encodeURIComponent(vtt));
    const audio = await audioResp.blob();
    await DB.put("segments", { vtt, lines, audio });
    done += 1;
  }
  await DB.put("episodes", {
    key, podcast: podcastOf(segs[0]), date: dateOf(segs[0]),
    segments: segs, cachedAt: new Date().toISOString(),
  });
  row.innerHTML = `${podcastOf(segs[0])} <small>${dateOf(segs[0])} · cached</small>`;
  openEpisode(key);
}

async function deleteEpisode(ep) {
  for (const vtt of ep.segments) await DB.del("segments", vtt);
  await DB.del("episodes", ep.key);
}

async function openEpisode(key) {
  const ep = await DB.get("episodes", key);
  if (!ep) return;
  current = { episodeKey: key, lines: [] };
  for (const vtt of ep.segments) {
    const seg = await DB.get("segments", vtt);
    if (!seg) continue;
    for (const ln of seg.lines) {
      current.lines.push({ vtt, start: ln.start, end: ln.end, text: ln.text });
    }
  }
  await renderLines();
  showView("listen");
}

function tsToSeconds(s) {
  const [h, m, rest] = s.split(":");
  const [sec, ms] = rest.replace(",", ".").split(".");
  return (+h) * 3600 + (+m) * 60 + (+sec) + (ms ? +ms / 1000 : 0);
}

let audioVtt = null; // which segment blob is currently loaded in the player

async function favIdsForEpisode() {
  const favs = await DB.all("favorites");
  const set = new Set();
  for (const f of favs) if (f.status !== "deleted") set.add(f.id);
  return set;
}

async function renderLines() {
  el.lines.innerHTML = "";
  const favSet = await favIdsForEpisode();
  current.lines.forEach((ln, i) => {
    const id = ln.vtt + "|" + ln.start;
    const li = document.createElement("li");
    li.className = "line";
    li.dataset.index = i;
    const star = document.createElement("button");
    star.className = "star";
    star.textContent = favSet.has(id) ? "★" : "☆";
    star.onclick = (e) => { e.stopPropagation(); toggleFavorite(ln, star); };
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = ln.text;
    li.appendChild(star);
    li.appendChild(text);
    li.onclick = () => playLine(i);
    el.lines.appendChild(li);
  });
}

async function playLine(i) {
  const ln = current.lines[i];
  if (audioVtt !== ln.vtt) {
    const seg = await DB.get("segments", ln.vtt);
    if (!seg) return;
    el.player.src = URL.createObjectURL(seg.audio);
    audioVtt = ln.vtt;
  }
  el.player.currentTime = tsToSeconds(ln.start);
  el.player.play();
  highlight(i);
}

function highlight(i) {
  el.lines.querySelectorAll(".line.active").forEach((n) => n.classList.remove("active"));
  const li = el.lines.querySelector(`.line[data-index="${i}"]`);
  if (li) li.classList.add("active");
}

async function toggleFavorite(ln, star) {
  const id = ln.vtt + "|" + ln.start;
  const existing = await DB.get("favorites", id);
  if (!existing) {
    await DB.put("favorites", {
      id, filename: ln.vtt, start: ln.start, end: ln.end, text: ln.text,
      status: "pending", updatedAt: new Date().toISOString(),
    });
    star.textContent = "★";
  } else if (existing.status === "synced") {
    existing.status = "deleted";
    existing.updatedAt = new Date().toISOString();
    await DB.put("favorites", existing);
    star.textContent = "☆";
  } else {
    // pending and not yet synced -> just drop it
    await DB.del("favorites", id);
    star.textContent = "☆";
  }
  updateStatus();
  if (navigator.onLine) syncFavorites().then(updateStatus);
}

async function syncFavorites() {
  if (!navigator.onLine) return;
  const favs = await DB.all("favorites");
  for (const f of favs) {
    try {
      if (f.status === "pending") {
        const r = await fetch("/api/favorite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: f.filename, start: f.start, end: f.end, text: f.text,
          }),
        });
        if (r.ok) { f.status = "synced"; await DB.put("favorites", f); }
      } else if (f.status === "deleted") {
        const r = await fetch(
          "/api/favorite?filename=" + encodeURIComponent(f.filename) +
          "&start=" + encodeURIComponent(f.start), { method: "DELETE" });
        // 404 = already gone upstream; treat as done so it stops requeuing.
        if (r.ok || r.status === 404) await DB.del("favorites", f.id);
      }
    } catch (e) { /* stay queued for next attempt */ }
  }
}

(async function boot() {
  await updateStatus();
  if (navigator.onLine) { await syncFavorites(); await updateStatus(); }
  renderFind();
  showView("find");
})();
