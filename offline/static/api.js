const Api = (() => {
  async function scopes(q) {
    const r = await fetch("/api/scopes?q=" + encodeURIComponent(q));
    return r.json();
  }
  async function lines(vtt) {
    const r = await fetch("/api/lines?scope=" + encodeURIComponent(vtt));
    return r.json();
  }
  async function favList() {
    const r = await fetch("/api/favorites");
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
  return { scopes, lines, favList, audioBlob, favAdd, favDel, exportFav };
})();
