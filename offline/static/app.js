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
