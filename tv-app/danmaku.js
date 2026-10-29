/* Shared frame-driven renderer; ES5 for Samsung 2019. Text is never HTML. */
(function (root) {
  'use strict';
  root.BangumiDanmaku = function (layer) {
    var comments = [], active = [], cursor = 0, previous = null, width = 0;
    var frame = null, frameGeneration = 0, hasClock = false, running = false, media = 0, wall = 0;
    var lastMedia = null, lastSample = 0, rate = 1;
    var settings = { enabled: true, offset: 0, opacity: 0.8 };
    var doc = layer.ownerDocument;
    function now() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
    var requestFrame = root.requestAnimationFrame ? function (fn) { return root.requestAnimationFrame(fn); }
      : function (fn) { return root.setTimeout(fn, 16); };
    var cancelFrame = root.cancelAnimationFrame ? function (id) { root.cancelAnimationFrame(id); }
      : function (id) { root.clearTimeout(id); };
    function stopFrame() { frameGeneration++; if (frame !== null) { cancelFrame(frame); frame = null; } }
    function hidden() { return !!(doc && doc.hidden); }
    function estimate(stamp) {
      // A lost progress callback must not let comments run away from video.
      return running ? Math.min(media + Math.max(0, stamp - wall) * rate, lastMedia + 1000) : media;
    }
    function schedule() {
      if (frame !== null || !hasClock || !running || !settings.enabled || !comments.length || hidden()) return;
      var generation = frameGeneration;
      frame = requestFrame(function () {
        if (generation !== frameGeneration) return;
        frame = null;
        var stamp = now();
        if (!running || !settings.enabled || hidden() || stamp - lastSample > 1000) return;
        render(estimate(stamp), false);
        schedule();
      });
    }
    function clear() { while (layer.firstChild) layer.removeChild(layer.firstChild); active = []; }
    function locate(time) {
      var lo = 0, hi = comments.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (comments[mid].time < time) lo = mid + 1; else hi = mid; }
      return lo;
    }
    this.setData = function (data) {
      comments = data || []; previous = null; clear();
      if (!comments.length) stopFrame();
      if (hasClock && !hidden()) render(estimate(now()), !running);
      schedule();
    };
    this.configure = function (value) {
      var next = { enabled: value.enabled !== false, offset: Number(value.offset) || 0, opacity: Number(value.opacity) || 0.8 };
      if (settings.offset !== next.offset || settings.enabled !== next.enabled) { clear(); previous = null; width = 0; }
      settings = next;
      layer.style.opacity = settings.opacity;
      layer.style.display = settings.enabled ? '' : 'none';
      if (!settings.enabled) stopFrame(); else schedule();
    };
    // Low-frequency video samples discipline a monotonic animation clock. Small
    // sample jitter changes speed gently, never snapping back every 250 ms.
    // No AVPlay calls, network requests or layout reads occur in the RAF loop.
    this.tick = function (milliseconds, paused, discontinuity) {
      if (!isFinite(milliseconds)) return;
      var stamp = now(), projected = hasClock ? estimate(stamp) : milliseconds;
      var jump = !!discontinuity || (hasClock && (stamp - lastSample > 1000 || Math.abs(milliseconds - projected) > 1000));
      if (!hasClock || paused || !running || jump) {
        media = milliseconds; wall = stamp; rate = 1;
      } else if (milliseconds !== lastMedia) {
        media = projected; wall = stamp;
        rate = 1 + Math.max(-0.1, Math.min(0.1, (milliseconds - projected) / 1000));
      }
      lastMedia = milliseconds; lastSample = stamp; hasClock = true; running = !paused;
      if (jump) { clear(); previous = null; }
      if (!settings.enabled || hidden()) { stopFrame(); return; }
      render(estimate(stamp), !!paused);
      if (paused) stopFrame(); else schedule();
    };
    function render(milliseconds, paused) {
      var time = milliseconds / 1000 - settings.offset;
      if (!settings.enabled) return;
      if (!width) width = layer.clientWidth || 1920;
      if (previous === null || time < previous - 0.5 || time - previous > 2) { clear(); cursor = locate(Math.max(0, time - 0.4)); }
      previous = time;
      active = active.filter(function (entry) {
        if (time >= entry.end || time < entry.start) { layer.removeChild(entry.element); return false; }
        return true;
      });
      var added = [], fragment = null;
      while (!paused && cursor < comments.length && comments[cursor].time <= time) {
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
        if (comment.mode !== 1) { element.style.left = '50%'; element.style.transform = 'translate3d(-50%,0,0)'; }
        if (!fragment) fragment = doc.createDocumentFragment();
        fragment.appendChild(element);
        var entry = { element: element, mode: comment.mode, lane: lane, width: 0,
          start: comment.time, end: comment.time + (comment.mode === 1 ? 8 : 4) };
        active.push(entry); added.push(entry);
      }
      // Batch insertion, then measure each new scrolling glyph once. Existing
      // comments only receive compositor transforms (at most eight DOM nodes).
      if (added.length) {
        layer.appendChild(fragment);
        added.forEach(function (entry) { if (entry.mode === 1) entry.width = entry.element.offsetWidth || entry.element.textContent.length * 30; });
      }
      active.forEach(function (entry) {
        if (entry.mode === 1) entry.element.style.transform = 'translate3d(' + (width - (width + entry.width) * (time - entry.start) / 8).toFixed(2) + 'px,0,0)';
      });
    }
    this.clear = function () {
      stopFrame(); clear(); comments = []; previous = null; width = 0;
      hasClock = false; running = false; lastMedia = null;
    };
    if (root.addEventListener) root.addEventListener('resize', function () { width = 0; });
    if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', function () {
      stopFrame(); hasClock = false; running = false; previous = null; width = 0;
      // Wait for a fresh video sample after foregrounding, not a wall-clock jump.
      clear();
    });
  };
}(window));
