const Api = (() => {
  async function scopes(q) {
    const r = await fetch("/api/scopes?q=" + encodeURIComponent(q));
    if (!r.ok) {
      let body = "";
      try { body = (await r.text()).slice(0, 120); } catch (e) {}
      throw new Error("HTTP " + r.status + (body ? " " + body : ""));
    }
    return r.json();
  }
  async function lines(vtt) {
    const r = await fetch("/api/lines?scope=" + encodeURIComponent(vtt));
    return r.json();
  }
  async function topics(filename) {
    try {
      const r = await fetch("/api/topics?filename=" + encodeURIComponent(filename));
      if (!r.ok) return { results: [] };
      return r.json();
    } catch (e) {
      return { results: [] };
    }
  }
  async function favList() {
    const r = await fetch("/api/favorites");
    if (!r.ok) throw new Error("favList " + r.status);
    return r.json();
  }
  async function audioBlob(vtt) {
    const r = await fetch("/api/audio?filename=" + encodeURIComponent(vtt));
    return r.blob();
  }
  async function favAdd(fav) {
    return fetch("/api/favorite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: fav.filename, start: fav.start, end: fav.end, text: fav.text,
      }),
    });
  }
  async function favDel(filename, start) {
    return fetch("/api/favorite?filename=" + encodeURIComponent(filename) +
      "&start=" + encodeURIComponent(start), { method: "DELETE" });
  }
  async function exportFav(fav) {
    return fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: fav.filename, start: fav.start, end: fav.end, text: fav.text,
      }),
    });
  }
  async function markExported(filename, start) {
    return fetch("/api/exported", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, start }),
    });
  }
  async function listenList() {
    const r = await fetch("/api/listens");
    if (!r.ok) throw new Error("listenList " + r.status);
    return r.json();
  }
  async function listenPut(filename, position) {
    return fetch("/api/listens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, position }),
    });
  }
  async function generateTopics(filename) {
    try {
      const r = await fetch("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      if (!r.ok) return null;
      return r.json();
    } catch (e) {
      return null;
    }
  }
  async function reindex(pattern) {
    try {
      const r = await fetch("/api/reindex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern }),
      });
      if (!r.ok) return null;
      return r.json();
    } catch (e) {
      return null;
    }
  }
  async function clipBlob(filename, start, end) {
    try {
      const r = await fetch("/api/clip?filename=" + encodeURIComponent(filename) +
        "&start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end));
      if (!r.ok) return null;
      return r.blob();
    } catch (e) {
      return null;
    }
  }
  return { scopes, lines, favList, audioBlob, favAdd, favDel, exportFav, markExported, topics, generateTopics, reindex, clipBlob, listenList, listenPut };
})();
