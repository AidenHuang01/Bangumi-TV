/* Shared clock-driven renderer; ES5 for Samsung 2019. Text never becomes HTML. */
(function (root) {
  'use strict';
  root.BangumiDanmaku = function (layer) {
    var comments = [], active = [], cursor = 0, previous = null;
    var settings = { enabled: true, offset: 0, opacity: 0.8 };
    function clear() { while (layer.firstChild) layer.removeChild(layer.firstChild); active = []; }
    function locate(time) {
      var lo = 0, hi = comments.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (comments[mid].time < time) lo = mid + 1; else hi = mid; }
      return lo;
    }
    this.setData = function (data) { comments = data || []; previous = null; clear(); };
    this.configure = function (value) {
      if (settings.offset !== value.offset || settings.enabled !== value.enabled) { clear(); previous = null; }
      settings = { enabled: value.enabled !== false, offset: Number(value.offset) || 0, opacity: Number(value.opacity) || 0.8 };
      layer.style.opacity = settings.opacity;
      layer.style.display = settings.enabled ? '' : 'none';
    };
    this.tick = function (milliseconds, paused) {
      var time = milliseconds / 1000 - settings.offset, width = layer.clientWidth || 1920;
      if (!settings.enabled) return;
      if (previous === null || time < previous || time - previous > 2) { clear(); cursor = locate(Math.max(0, time - 0.4)); }
      previous = time;
      active = active.filter(function (entry) {
        if (time >= entry.end || time < entry.start) { layer.removeChild(entry.element); return false; }
        if (entry.mode === 1) entry.element.style.transform = 'translateX(' + (width - (width + entry.width) * (time - entry.start) / 8) + 'px)';
        return true;
      });
      if (paused) return;
      while (cursor < comments.length && comments[cursor].time <= time) {
        var comment = comments[cursor++], lane, used = {};
        if (time - comment.time > 1) continue;
        active.forEach(function (entry) { used[entry.lane] = true; });
        var first = comment.mode === 4 ? 7 : comment.mode === 5 ? 0 : 1;
        var last = comment.mode === 1 ? 6 : first;
        for (lane = first; lane <= last && used[lane]; lane++) {}
        if (lane > last) continue;
        var element = document.createElement('span');
        element.className = 'danmaku-comment'; element.textContent = comment.text;
        element.style.color = comment.color; element.style.top = (lane * 8 + 3) + '%';
        if (comment.mode !== 1) { element.style.left = '50%'; element.style.transform = 'translateX(-50%)'; }
        else element.style.transform = 'translateX(' + width + 'px)';
        layer.appendChild(element);
        active.push({ element: element, mode: comment.mode, lane: lane, width: element.offsetWidth || comment.text.length * 30,
          start: comment.time, end: comment.time + (comment.mode === 1 ? 8 : 4) });
      }
    };
    this.clear = function () { clear(); comments = []; previous = null; };
  };
}(window));
