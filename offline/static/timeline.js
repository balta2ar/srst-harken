const Timeline = (() => {
  function tsToSeconds(s) {
    const [h, m, rest] = s.split(":");
    const [sec, ms] = rest.replace(",", ".").split(".");
    return (+h) * 3600 + (+m) * 60 + (+sec) + (ms ? +ms / 1000 : 0);
  }

  function fmt(secs) {
    secs = Math.max(0, Math.floor(secs || 0));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  // segments: [{vtt, lines:[{start,end,text}]}] where start/end are VTT strings.
  function build(segments) {
    const segs = [];
    const lines = [];
    let offset = 0;
    let idx = 0;
    for (let si = 0; si < segments.length; si++) {
      const segLines = segments[si].lines.map((ln) => ({
        start: tsToSeconds(ln.start), end: tsToSeconds(ln.end), text: ln.text,
      }));
      const duration = segLines.length ? segLines[segLines.length - 1].end : 0;
      for (const ln of segLines) {
        lines.push({
          vtt: segments[si].vtt, segIndex: si,
          start: ln.start, end: ln.end,
          epStart: offset + ln.start, epEnd: offset + ln.end,
          text: ln.text, idx: idx++,
        });
      }
      segs.push({ vtt: segments[si].vtt, offset, duration, lines: segLines });
      offset += duration;
    }
    return { segments: segs, total: offset, lines };
  }

  function lineAtEpTime(tl, t) {
    const L = tl.lines;
    if (!L.length) return -1;
    let lo = 0, hi = L.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (L[mid].epStart <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function segAtEpTime(tl, t) {
    const S = tl.segments;
    let segIndex = 0;
    for (let i = 0; i < S.length; i++) {
      if (t >= S[i].offset) segIndex = i; else break;
    }
    return { segIndex, segLocalTime: t - (S[segIndex] ? S[segIndex].offset : 0) };
  }

  return { tsToSeconds, fmt, build, lineAtEpTime, segAtEpTime };
})();

if (typeof module !== "undefined") module.exports = Timeline;
