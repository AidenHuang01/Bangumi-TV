/* ES5 syntax and XMLHttpRequest for older Samsung TV web engines. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var nativePlayer = window.webapis && window.webapis.avplay;
  var video = $('browser-player');
  var server = '';
  var current = null;
  var preparing = false;
  var playGeneration = 0;
  var refreshGeneration = 0;
  var subtitlesOn = true;
  var cues = [];
  var subtitleTimer;
  var nativeSubtitleTimer;
  var hideTimer;
  var savedFocus;
  var lastCard;
  var browseView = 'anime';
  var selectedProvider = 'all';
  var browseGeneration = 0;
  var browseXHR;
  var resolving = false;
  var selectedShow;
  var receiverSession;
  var receiverEpoch;
  var receiverApplied = 0;
  var receiverBusy = false;
  var remotePlaybackId = null;
  var remoteTerminal = null;
  var remoteError = '';
  var remoteSeek = null, seekTimer, seekTicket = 0;
  var receiverClient = recall('bangumi-tv-client') || 'tv-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  var receiverBoot = Date.now() + '-' + Math.random().toString(36).slice(2);
  store('bangumi-tv-client', receiverClient);

  function tvPost(path, value, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', server + path, true); xhr.timeout = 8000;
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (receiverSession) xhr.setRequestHeader('X-Bangumi-TV', receiverSession);
    xhr.onload = function () {
      var data;
      try { data = JSON.parse(xhr.responseText); } catch (e) { return callback(new Error('Invalid controller response')); }
      if (xhr.status < 200 || xhr.status >= 300) {
        var error = new Error(data.error || 'Controller unavailable'); error.status = xhr.status; return callback(error);
      }
      callback(null, data);
    };
    xhr.onerror = xhr.ontimeout = function () { callback(new Error('Mac controller disconnected')); };
    xhr.send(JSON.stringify(value));
  }
  function receiverLabel(text) {
    $('phone-controller').textContent = text;
    $('phone-controller-player').textContent = text;
  }
  function pollReceiver() {
    // Browser previews are not TV receivers and cannot steal the physical TV session.
    if (!nativePlayer || !server || receiverBusy) return;
    receiverBusy = true;
    var base = server;
    if (!receiverSession) {
      tvPost('/api/tv/register', { clientId: receiverClient, bootId: receiverBoot, version: '0.5.0' }, function (error, result) {
        receiverBusy = false;
        if (base !== server) return;
        if (error || !result.session) { receiverLabel(error ? error.message : 'Phone controller needs the updated Mac server.'); return; }
        if (receiverEpoch !== result.epoch) { receiverApplied = 0; remotePlaybackId = null; remoteTerminal = null; }
        receiverEpoch = result.epoch; receiverSession = result.session;
        receiverLabel('Phone controller: ' + server + '/remote/');
      });
      return;
    }
    var terminal = remoteTerminal;
    tvPost('/api/tv/poll', { applied: receiverApplied, playbackId: remotePlaybackId,
      status: !current ? 'idle' : remoteError ? 'error' : preparing ? 'loading' : paused() ? 'paused' : 'playing',
      title: current ? current.title : '', position: position(), duration: duration(), error: remoteError, seek: remoteSeek, terminal: terminal }, function (error, result) {
      receiverBusy = false;
      if (base !== server) return;
      if (error) {
        if (error.status === 401) receiverSession = null;
        return;
      }
      if (terminal === remoteTerminal) remoteTerminal = null;
      (result.commands || []).forEach(function (command) {
        if (command.seq <= receiverApplied) return;
        try {
          if (command.action === 'play' && command.item && /^\/stream\//.test(command.item.streamPath)) {
            cancelBrowse(); show($('setup'), false);
            startPlayback(command.item); remotePlaybackId = command.playbackId;
          } else if (command.action === 'pause') togglePlay(false);
          else if (command.action === 'resume') togglePlay(true);
          else if (command.action === 'stop') { cancelBrowse(); stopPlayback(); }
          else if (command.action === 'seek') seek(command.seconds);
        } catch (failure) { remoteError = failure.message || String(failure); }
        receiverApplied = command.seq;
      });
    });
  }

  function visible(element) { return element && element.getClientRects().length > 0; }
  function show(element, yes) { element.classList[yes ? 'remove' : 'add']('hidden'); }
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  function recall(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function normalizeAddress(value) {
    value = value.replace(/^\s+|\s+$/g, '').replace(/\/$/, '');
    if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
    var anchor = document.createElement('a');
    anchor.href = value;
    if (!anchor.hostname || !/^https?:$/.test(anchor.protocol) || anchor.username || anchor.password ||
        (anchor.pathname && anchor.pathname !== '/') || anchor.search || anchor.hash) {
      throw new Error('Enter a server address such as http://192.168.1.20:8787');
    }
    return anchor.protocol + '//' + anchor.host;
  }
  function request(base, path, callback, timeout) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', base + path, true);
    xhr.timeout = timeout || 12000;
    xhr.onload = function () {
      var result;
      try { result = JSON.parse(xhr.responseText); } catch (e) { return callback(new Error('The server returned an invalid response.')); }
      if (xhr.status < 200 || xhr.status >= 300) return callback(new Error(result.error || 'Server error ' + xhr.status));
      callback(null, result);
    };
    xhr.onerror = function () { callback(new Error('Cannot reach your Mac. Check the address, Wi-Fi and Mac firewall.')); };
    xhr.ontimeout = function () { callback(new Error('Connection timed out. Is the Mac server running?')); };
    xhr.send();
    return xhr;
  }
  function cancelBrowse() {
    browseGeneration++;
    if (browseXHR && browseXHR.abort) browseXHR.abort();
    browseXHR = null; resolving = false;
  }
  function setView(view) {
    browseView = view;
    show($('anime-view'), view === 'anime');
    show($('episodes-view'), view === 'episodes');
    show($('local-view'), view === 'local');
    $('anime-tab').classList[view === 'local' ? 'remove' : 'add']('primary');
    $('library-tab').classList[view === 'local' ? 'add' : 'remove']('primary');
  }
  function selectProvider(id, button) {
    selectedProvider = id;
    var buttons = $('providers').querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].classList.remove('selected');
    button.classList.add('selected');
  }
  function loadProviders() {
    var base = server;
    request(base, '/api/providers', function (error, result) {
      if (base !== server) return;
      if (error || !result || !Array.isArray(result.providers)) {
        $('search-status').textContent = 'Search requires the updated Mac server. ' + (error ? error.message : 'Restart npm start on the Mac.'); return;
      }
      var container = $('providers');
      container.textContent = '';
      var all = document.createElement('button'); all.textContent = 'All sources';
      all.onclick = function () { selectProvider('all', all); }; container.appendChild(all);
      result.providers.forEach(function (provider) {
        var button = document.createElement('button'); button.textContent = provider.name;
        button.onclick = function () { selectProvider(provider.id, button); }; container.appendChild(button);
      });
      selectProvider('all', all);
      $('search-status').textContent = 'Search for a title. Use only sources you are authorized to access.';
    });
  }
  function searchAnime() {
    if (!server) return openSetup();
    var query = $('search-query').value.replace(/^\s+|\s+$/g, '');
    if (!query) { $('search-status').textContent = 'Enter an anime title.'; $('search-query').focus(); return; }
    cancelBrowse(); setView('anime');
    var generation = browseGeneration;
    $('search-results').textContent = '';
    $('search-status').textContent = 'Searching sources…';
    browseXHR = request(server, '/api/search?q=' + encodeURIComponent(query) + '&provider=' + encodeURIComponent(selectedProvider), function (error, result) {
      if (generation !== browseGeneration) return;
      if (error) { $('search-status').textContent = error.message; return; }
      var summaries = (result.providers || []).map(function (provider) {
        return provider.provider + ': ' + (provider.error || provider.count + ' results');
      });
      var items = result.items || [];
      $('search-status').textContent = (items.length ? 'Choose a result, then an episode.\n' : 'No results. Try another title or provider.\n') + summaries.join(' · ');
      items.forEach(function (item) {
        var card = document.createElement('button'); card.className = 'video-card search-card';
        var info = document.createElement('div'); info.className = 'card-info';
        var title = document.createElement('h3'); title.textContent = item.title;
        var source = document.createElement('p'); source.textContent = item.provider;
        info.appendChild(title); info.appendChild(source); card.appendChild(info);
        card.onclick = function () { openShow(item); }; $('search-results').appendChild(card);
      });
      var first = $('search-results').querySelector('button');
      if (first && !visible($('setup'))) first.focus();
    }, 22000);
  }
  function openShow(item) {
    cancelBrowse(); selectedShow = item; setView('episodes');
    var generation = browseGeneration;
    $('anime-title').textContent = item.title + ' / ' + item.provider;
    $('episodes-status').textContent = 'Loading episodes…'; $('episode-roads').textContent = '';
    $('back-results').focus();
    browseXHR = request(server, '/api/shows/' + item.id, function (error, result) {
      if (generation !== browseGeneration) return;
      if (error) { $('episodes-status').textContent = error.message; return; }
      $('episodes-status').textContent = 'Choose an episode. Resolving can take up to 45 seconds. Back cancels waiting.';
      (result.roads || []).forEach(function (road) {
        var heading = document.createElement('h3'); heading.className = 'road-heading'; heading.textContent = road.name;
        var buttons = document.createElement('div'); buttons.className = 'episode-buttons';
        road.episodes.forEach(function (episode) {
          var button = document.createElement('button'); button.textContent = episode.name;
          button.onclick = function () { resolveEpisode(episode, button); }; buttons.appendChild(button);
        });
        $('episode-roads').appendChild(heading); $('episode-roads').appendChild(buttons);
      });
      var first = $('episode-roads').querySelector('button');
      if (first && !visible($('setup'))) first.focus();
    }, 22000);
  }
  function resolveEpisode(episode, button) {
    if (resolving) return;
    cancelBrowse(); resolving = true;
    var generation = browseGeneration;
    lastCard = button;
    $('episodes-status').textContent = 'Finding the stream for ' + episode.name + '… Mac may open an isolated background browser. Press Back to cancel waiting.';
    browseXHR = request(server, '/api/resolve/' + episode.id, function (error, result) {
      if (generation !== browseGeneration) return;
      resolving = false;
      if (error || !result.item) { $('episodes-status').textContent = error ? error.message : 'No playable stream returned.'; button.focus(); return; }
      $('episodes-status').textContent = 'Stream ready. Select another episode to continue.';
      startPlayback(result.item);
    }, 55000);
  }
  function backResults() {
    cancelBrowse(); setView('anime');
    var first = $('search-results').querySelector('button');
    if (first) first.focus(); else $('search-anime').focus();
  }
  function openSetup() {
    savedFocus = document.activeElement;
    $('server-address').value = server;
    $('setup-status').textContent = '';
    show($('setup'), true);
    $('server-address').focus();
  }
  function closeSetup() {
    show($('setup'), false);
    if (visible(savedFocus)) savedFocus.focus(); else $('settings').focus();
  }
  function connect() {
    var candidate;
    try { candidate = normalizeAddress($('server-address').value); }
    catch (error) { $('setup-status').textContent = error.message; return; }
    $('connect').disabled = true;
    $('setup-status').textContent = 'Connecting…';
    request(candidate, '/api/health', function (error, health) {
      $('connect').disabled = false;
      if (error) { $('setup-status').textContent = error.message; $('connect').focus(); return; }
      if (health.name !== 'Bangumi TV POC') { $('setup-status').textContent = 'This is not a Bangumi TV server.'; return; }
      server = candidate;
      receiverSession = null; receiverApplied = 0;
      store('bangumi-server', server);
      cancelBrowse(); setView('anime'); loadProviders();
      closeSetup();
      refresh();
    });
  }
  function refresh() {
    if (!server) return openSetup();
    var generation = ++refreshGeneration;
    $('library-status').textContent = 'Loading your library…';
    request(server, '/api/library', function (error, result) {
      if (generation !== refreshGeneration) return;
      $('cards').textContent = '';
      if (error || !result || !Array.isArray(result.items)) {
        $('library-status').textContent = error ? error.message : 'Invalid library response.';
        $('connection-badge').textContent = 'Disconnected';
        $('connection-badge').classList.remove('online');
        $('item-count').textContent = '0 videos';
        return;
      }
      $('connection-badge').textContent = 'Mac connected';
      $('connection-badge').classList.add('online');
      $('server-label').textContent = server;
      $('item-count').textContent = result.items.length + (result.items.length === 1 ? ' video' : ' videos');
      $('library-status').textContent = result.items.length ? 'Ready to play. Choose a video below.' :
        'Your library is empty. Run npm run demo on the Mac, or add a video to server/media/.';
      result.items.forEach(function (item) {
        var card = document.createElement('button');
        card.className = 'video-card';
        var art = document.createElement('div'); art.className = 'card-art';
        var format = document.createElement('span'); format.className = 'card-format';
        format.textContent = (item.kind === 'local' ? 'LOCAL FILE / ' : 'STREAM / ') + item.format;
        var playIcon = document.createElement('span'); playIcon.className = 'card-play'; playIcon.textContent = '▶';
        art.appendChild(format); art.appendChild(playIcon);
        var info = document.createElement('div'); info.className = 'card-info';
        var title = document.createElement('h3'); title.textContent = item.title;
        var description = document.createElement('p'); description.textContent = item.description;
        info.appendChild(title); info.appendChild(description);
        card.appendChild(art); card.appendChild(info);
        card.onclick = function () { lastCard = card; startPlayback(item); };
        $('cards').appendChild(card);
      });
      if (!visible($('setup')) && !current && browseView === 'local') {
        var first = $('cards').querySelector('button');
        if (first) first.focus();
      }
    });
  }
  function timeLabel(milliseconds) {
    var seconds = Math.max(0, Math.floor((milliseconds || 0) / 1000));
    var minutes = Math.floor(seconds / 60);
    return minutes + ':' + ('0' + seconds % 60).slice(-2);
  }
  function position() {
    try { return nativePlayer ? nativePlayer.getCurrentTime() : video.currentTime * 1000; } catch (e) { return 0; }
  }
  function duration() {
    try { return nativePlayer ? nativePlayer.getDuration() : video.duration * 1000; } catch (e) { return 0; }
  }
  function paused() {
    try { return nativePlayer ? nativePlayer.getState() !== 'PLAYING' : video.paused; } catch (e) { return true; }
  }
  function updateTime() {
    var now = position(), length = duration();
    $('playback-time').textContent = timeLabel(now) + ' / ' + timeLabel(length);
    $('progress-fill').style.width = isFinite(length) && length > 0 ? Math.min(100, now / length * 100) + '%' : '0%';
    $('toggle-play').textContent = paused() ? 'Play' : 'Pause';
    var text = '';
    if (subtitlesOn) cues.forEach(function (cue) { if (now >= cue.start && now < cue.end) text += (text ? '\n' : '') + cue.text; });
    if (cues.length || !nativePlayer) $('subtitle').textContent = text;
  }
  function revealControls(focus) {
    clearTimeout(hideTimer);
    $('hud').classList.remove('dimmed');
    $('player-screen').classList.add('controls-visible');
    if (focus) $('toggle-play').focus();
    hideTimer = setTimeout(function () {
      if (current && !preparing && !paused() && !visible($('playback-message'))) {
        $('hud').classList.add('dimmed');
        $('player-screen').classList.remove('controls-visible');
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      }
    }, 4500);
  }
  function message(text) { $('playback-message').textContent = text; show($('playback-message'), !!text); }
  function screenSaver(enabled) {
    var common = window.webapis && window.webapis.appcommon;
    if (!common || !common.setScreenSaver) return;
    try {
      var value = enabled ? common.AppCommonScreenSaverState.SCREEN_SAVER_ON : common.AppCommonScreenSaverState.SCREEN_SAVER_OFF;
      common.setScreenSaver(value, function () {}, function () {});
    } catch (e) {}
  }
  function failPlayback(text) { remoteError = text; preparing = false; screenSaver(true); message(text + ' · Press Back to return to the library.'); revealControls(true); }
  function stopPlayback(reason) {
    if (remotePlaybackId) remoteTerminal = { playbackId: remotePlaybackId, reason: reason === 'ended' ? 'ended' : 'stopped' };
    remotePlaybackId = null; remoteError = '';
    playGeneration++;
    current = null; preparing = false; cues = []; seeking = false;
    seekTicket++; clearTimeout(seekTimer); remoteSeek = null;
    clearInterval(subtitleTimer); clearTimeout(nativeSubtitleTimer); clearTimeout(hideTimer);
    screenSaver(true);
    if (nativePlayer) { try { nativePlayer.close(); } catch (e) {} }
    video.pause(); video.removeAttribute('src'); video.load();
    $('subtitle').textContent = ''; message('');
    show($('player-screen'), false); show($('library-screen'), true);
    document.body.classList.remove('playing');
    if (visible(lastCard)) lastCard.focus(); else $('refresh').focus();
  }
  function startPlayback(item) {
    stopPlayback();
    current = item; preparing = true;
    var generation = ++playGeneration;
    var streamURL = server + item.streamPath;
    $('playing-title').textContent = item.title;
    $('playback-engine').textContent = nativePlayer ? 'Samsung AVPlay · original stream' : 'Browser player · original stream';
    $('toggle-subtitles').textContent = 'Subtitles: ' + (subtitlesOn ? 'on' : 'off');
    show($('library-screen'), false); show($('player-screen'), true);
    document.body.classList.add('playing');
    show(video, !nativePlayer); show($('av-player'), !!nativePlayer);
    message('Loading video…'); revealControls(true);
    if (item.subtitlePath) loadSubtitles(server + item.subtitlePath, generation);
    if (nativePlayer) {
      try {
        nativePlayer.open(streamURL);
        nativePlayer.setDisplayRect(0, 0, 1920, 1080);
        nativePlayer.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
        nativePlayer.setListener({
          onbufferingstart: function () { if (generation === playGeneration) message('Buffering…'); },
          onbufferingprogress: function (percent) { if (generation === playGeneration) message('Buffering… ' + percent + '%'); },
          onbufferingcomplete: function () { if (generation === playGeneration) message(''); },
          oncurrentplaytime: function () { if (generation === playGeneration) updateTime(); },
          onstreamcompleted: function () { if (generation === playGeneration) stopPlayback('ended'); },
          onerror: function (error) { if (generation === playGeneration) failPlayback('TV player error: ' + error); },
          onsubtitlechange: function (length, text) {
            if (generation !== playGeneration || cues.length) return;
            $('subtitle').textContent = subtitlesOn ? text : '';
            clearTimeout(nativeSubtitleTimer);
            nativeSubtitleTimer = setTimeout(function () {
              if (generation === playGeneration && !cues.length) $('subtitle').textContent = '';
            }, length);
          }
        });
        nativePlayer.prepareAsync(function () {
          if (generation !== playGeneration) return;
          try {
            if (nativePlayer.setSilentSubtitle) nativePlayer.setSilentSubtitle(true);
            nativePlayer.play(); screenSaver(false); preparing = false; message(''); revealControls(false);
          }
          catch (error) { failPlayback(error.message); }
        }, function (error) { if (generation === playGeneration) failPlayback('Cannot prepare this video: ' + (error.message || error)); });
      } catch (error) { failPlayback(error.message); }
    } else {
      video.src = streamURL;
      var promise = video.play();
      if (promise && promise.catch) promise.catch(function (error) { if (generation === playGeneration) failPlayback(error.message); });
    }
    subtitleTimer = setInterval(updateTime, 250);
  }
  function togglePlay(force) {
    if (!current || preparing) return;
    try {
      var play = typeof force === 'boolean' ? force : paused();
      if (nativePlayer) { if (play) nativePlayer.play(); else nativePlayer.pause(); }
      else if (play) {
        var promise = video.play();
        if (promise && promise.catch) promise.catch(function (error) { failPlayback(error.message); });
      } else video.pause();
      screenSaver(!play);
      updateTime(); revealControls(false);
    } catch (error) { failPlayback(error.message); }
  }
  var seeking = false;
  function seek(delta) {
    if (!current || preparing) return;
    if (seeking) { message('A seek is in progress…'); return; }
    var length = duration();
    if (!isFinite(length) || length <= 0) { message('This stream does not offer seeking.'); revealControls(false); return; }
    var from = position(), target = Math.round(Math.max(1, Math.min(Math.max(1, length - 1000), from + delta * 1000)));
    var generation = playGeneration, ticket = ++seekTicket, attempt = 0;
    remoteSeek = { state: 'seeking', from: from, target: target, actual: from, error: '' };
    function valid() { return generation === playGeneration && ticket === seekTicket && current; }
    function finish(error) {
      if (!valid()) return;
      clearTimeout(seekTimer); seeking = false;
      remoteSeek = { state: error ? 'error' : 'done', from: from, target: target, actual: position(), error: error || '' };
      message(error || ''); updateTime(); revealControls(false);
    }
    function run(absolute) {
      var number = ++attempt;
      clearTimeout(seekTimer);
      function failed(error) {
        if (!valid() || number !== attempt) return;
        if (!absolute) return run(true);
        finish('Seek failed: ' + (error && (error.message || error.name) || 'TV did not confirm the jump') + '. Try another playback source.');
      }
      function success() {
        if (!valid() || number !== attempt) return;
        clearTimeout(seekTimer);
        seekTimer = setTimeout(function () {
          if (!valid() || number !== attempt) return;
          if (Math.abs(position() - target) > 5000) failed(new Error('Position did not change'));
          else finish();
        }, 750);
      }
      seekTimer = setTimeout(function () { failed(new Error('Seek timed out')); }, 6000);
      try {
        if (absolute) nativePlayer.seekTo(target, success, failed);
        else if (target >= from) nativePlayer.jumpForward(target - from, success, failed);
        else nativePlayer.jumpBackward(from - target, success, failed);
      } catch (error) { failed(error); }
    }
    try {
      if (nativePlayer) {
        seeking = true; message('Seeking…');
        run(typeof nativePlayer.jumpForward !== 'function' || typeof nativePlayer.jumpBackward !== 'function');
      } else { video.currentTime = target / 1000; finish(); }
      revealControls(false);
    } catch (error) { finish('Seeking failed: ' + error.message); }
  }
  function parseVTT(text) {
    function stamp(value) {
      var parts = value.replace(',', '.').split(':');
      var seconds = 0;
      parts.forEach(function (part) { seconds = seconds * 60 + Number(part); });
      return seconds * 1000;
    }
    var parsed = [];
    text.replace(/\r/g, '').split(/\n\s*\n/).forEach(function (block) {
      var lines = block.split('\n'), index;
      for (index = 0; index < lines.length; index++) {
        var match = /^(\S+)\s+-->\s+(\S+)/.exec(lines[index]);
        if (match) {
          parsed.push({ start: stamp(match[1]), end: stamp(match[2]), text: lines.slice(index + 1).join('\n').replace(/<[^>]*>/g, '') });
          break;
        }
      }
    });
    return parsed;
  }
  function loadSubtitles(url, generation) {
    var xhr = new XMLHttpRequest(); xhr.open('GET', url, true); xhr.timeout = 12000;
    xhr.onload = function () { if (generation === playGeneration && xhr.status === 200) cues = parseVTT(xhr.responseText); };
    xhr.send();
  }
  function moveFocus(direction) {
    var root = visible($('setup')) ? $('setup') : current ? $('hud') : $('library-screen');
    var elements = Array.prototype.slice.call(root.querySelectorAll('button:not(:disabled), input'));
    elements = elements.filter(visible);
    var active = document.activeElement;
    if (elements.indexOf(active) < 0) { if (elements[0]) elements[0].focus(); return; }
    var box = active.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
    var best, score = Infinity;
    elements.forEach(function (element) {
      if (element === active) return;
      var rect = element.getBoundingClientRect(), dx = rect.left + rect.width / 2 - x, dy = rect.top + rect.height / 2 - y;
      var primary = direction === 37 ? -dx : direction === 39 ? dx : direction === 38 ? -dy : dy;
      var secondary = direction === 37 || direction === 39 ? Math.abs(dy) : Math.abs(dx);
      var candidate = primary + secondary * 4;
      if (primary > 5 && candidate < score) { score = candidate; best = element; }
    });
    if (best) { best.focus(); best.scrollIntoView({ block: 'nearest' }); }
  }
  document.addEventListener('keydown', function (event) {
    var key = event.keyCode;
    var editing = document.activeElement === $('server-address') || document.activeElement === $('search-query');
    if (key === 10009 || key === 27) {
      event.preventDefault();
      if (visible($('setup'))) closeSetup(); else if (current) stopPlayback();
      else if (resolving) { cancelBrowse(); $('episodes-status').textContent = 'Waiting canceled. The Mac job may take a moment to finish; choose another episode or source.'; }
      else if (browseView === 'episodes') backResults();
      else if (browseView === 'local') { cancelBrowse(); setView('anime'); $('anime-tab').focus(); }
      else if (window.tizen && window.tizen.application) window.tizen.application.getCurrentApplication().exit();
      return;
    }
    if (editing) {
      if (key === 13) { event.preventDefault(); if (document.activeElement === $('server-address')) connect(); else searchAnime(); }
      if (key === 40 || key === 38) { event.preventDefault(); moveFocus(key); }
      return;
    }
    if (current) {
      if (key === 413) { event.preventDefault(); stopPlayback(); return; }
      if (key === 415 || key === 19 || key === 10252 || key === 32) { event.preventDefault(); togglePlay(key === 415 ? true : key === 19 ? false : undefined); return; }
      if (key === 412 || key === 417) { event.preventDefault(); seek(key === 412 ? -10 : 10); return; }
      if ($('hud').classList.contains('dimmed')) {
        if (key === 37 || key === 39) { event.preventDefault(); seek(key === 37 ? -10 : 10); return; }
        if (key === 13) { event.preventDefault(); togglePlay(); return; }
        if (key === 38 || key === 40) { event.preventDefault(); revealControls(true); return; }
      }
      revealControls(false);
    }
    if (key >= 37 && key <= 40) { event.preventDefault(); moveFocus(key); }
  });
  $('settings').onclick = function () { cancelBrowse(); openSetup(); };
  $('refresh').onclick = function () { cancelBrowse(); refresh(); loadProviders(); };
  $('anime-tab').onclick = function () { cancelBrowse(); setView('anime'); $('search-query').focus(); };
  $('library-tab').onclick = function () { cancelBrowse(); setView('local'); refresh(); };
  $('search-anime').onclick = searchAnime; $('back-results').onclick = backResults;
  $('all-providers').onclick = function () { selectProvider('all', $('all-providers')); };
  $('connect').onclick = connect; $('cancel-setup').onclick = closeSetup;
  $('toggle-play').onclick = function () { togglePlay(); };
  $('seek-back').onclick = function () { seek(-10); }; $('seek-forward').onclick = function () { seek(10); };
  $('stop-play').onclick = stopPlayback;
  $('toggle-subtitles').onclick = function () {
    subtitlesOn = !subtitlesOn; $('subtitle').textContent = '';
    $('toggle-subtitles').textContent = 'Subtitles: ' + (subtitlesOn ? 'on' : 'off');
    revealControls(false);
  };
  video.addEventListener('playing', function () { if (current && !nativePlayer) { preparing = false; message(''); revealControls(false); } });
  video.addEventListener('waiting', function () { if (current && !nativePlayer) message('Buffering…'); });
  video.addEventListener('error', function () { if (current && !nativePlayer) failPlayback('Browser cannot play this source. Use a supported MP4 or test it in the installed TV app.'); });
  video.addEventListener('ended', function () { if (current && !nativePlayer) stopPlayback('ended'); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && current && !preparing && !paused()) togglePlay(false);
  });
  window.addEventListener('beforeunload', function () { screenSaver(true); if (nativePlayer) { try { nativePlayer.close(); } catch (e) {} } });
  if (window.tizen && window.tizen.tvinputdevice) {
    ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaRewind', 'MediaFastForward'].forEach(function (name) {
      try { window.tizen.tvinputdevice.registerKey(name); } catch (e) {}
    });
  }
  $('engine-label').textContent = nativePlayer ? 'Samsung native player' : 'Browser preview';
  server = recall('bangumi-server') || window.BANGUMI_DEFAULT_SERVER ||
    (/^https?:$/.test(window.location.protocol) ? window.location.protocol + '//' + window.location.host : '');
  if (server) { refresh(); loadProviders(); } else openSetup();
  if (nativePlayer) { pollReceiver(); setInterval(pollReceiver, 1500); }
}());
