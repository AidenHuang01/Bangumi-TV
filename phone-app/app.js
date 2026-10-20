(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let state = null, show = null, searchGeneration = 0, requestGeneration = 0;
  let stateBusy = false, noticeTimer, queueSignature = '';
  let mode = 'remote', phoneItem = null, hls = null, phoneGeneration = 0, phoneDanmakuVersion = '', phoneDanmakuBusy = false;
  const phoneVideo = $('phone-video');
  const phoneDanmaku = window.BangumiDanmaku ? new window.BangumiDanmaku($('phone-danmaku')) : null;
  function setMode(value) {
    const changed = mode !== value;
    mode = value;
    $('tv-controls').hidden = value !== 'remote'; $('phone-player-panel').hidden = value !== 'player';
    $('mode-remote').classList.toggle('selected', value === 'remote'); $('mode-player').classList.toggle('selected', value === 'player');
    if (value === 'remote') { if (!phoneItem) phoneGeneration++; phoneVideo.pause(); if (hls) hls.stopLoad(); }
    else if (hls) hls.startLoad(-1);
    if (show && changed) renderEpisodes();
  }
  function stopPhone() {
    phoneGeneration++; phoneItem = null; phoneDanmakuVersion = '';
    if (hls) { hls.destroy(); hls = null; }
    phoneVideo.pause(); phoneVideo.removeAttribute('src'); phoneVideo.load();
    if (phoneDanmaku) phoneDanmaku.clear();
    $('phone-status').textContent = '手机播放已停止。';
  }
  async function refreshPhoneDanmaku() {
    if (!phoneDanmaku || !phoneItem?.danmakuPath || phoneDanmakuBusy) return;
    const item = phoneItem;
    phoneDanmakuBusy = true;
    try {
      const data = await api(item.danmakuPath + '?version=' + encodeURIComponent(phoneDanmakuVersion));
      if (item !== phoneItem) return;
      if (!data.unchanged) phoneDanmaku.setData(data.comments);
      phoneDanmaku.configure(data); phoneDanmakuVersion = data.version;
    } catch { /* Danmaku is optional and cannot stop playback. */ }
    finally { phoneDanmakuBusy = false; }
  }
  async function startPhone(item, position = 0) {
    if (!item?.streamPath?.startsWith('/stream/')) throw new Error('Invalid Mac video stream');
    stopPhone(); setMode('player'); phoneItem = item;
    const generation = phoneGeneration;
    $('phone-title').textContent = item.title; $('phone-status').textContent = 'Loading…';
    phoneVideo.onloadedmetadata = () => {
      if (generation !== phoneGeneration) return;
      if (position > 0) { try { phoneVideo.currentTime = Math.min(position / 1000, Math.max(0, phoneVideo.duration - 1)); } catch {} }
    };
    phoneVideo.onplaying = () => { if (generation === phoneGeneration) $('phone-status').textContent = '正在手机播放 · 原始画质'; };
    phoneVideo.onerror = () => { if (generation === phoneGeneration) $('phone-status').textContent = '手机无法解码或来源读取失败，请换一条播放线路。'; };
    const play = () => {
      if (generation !== phoneGeneration || mode !== 'player') return;
      const promise = phoneVideo.play();
      if (promise?.catch) promise.catch(() => { if (generation === phoneGeneration) $('phone-status').textContent = '视频已就绪，点击播放器的播放按钮开始。'; });
    };
    if (item.format === 'hls' && !phoneVideo.canPlayType('application/vnd.apple.mpegurl')) {
      if (!window.Hls?.isSupported()) throw new Error('This browser cannot play HLS. Try Safari or a current Chrome browser.');
      hls = new window.Hls({ maxBufferLength: 30 });
      hls.on(window.Hls.Events.MANIFEST_PARSED, play);
      hls.on(window.Hls.Events.ERROR, (_event, data) => {
        if (generation === phoneGeneration && data.fatal) $('phone-status').textContent = 'HLS playback failed: ' + data.details + '. Try another playback source.';
      });
      hls.loadSource(item.streamPath); hls.attachMedia(phoneVideo);
    } else { phoneVideo.src = item.streamPath; play(); }
    refreshPhoneDanmaku();
  }
  async function playEpisodeOnPhone(episode) {
    stopPhone(); setMode('player');
    const generation = phoneGeneration;
    $('phone-status').textContent = '正在解析 ' + episode.name + '，最多约 52 秒…';
    try {
      const result = await api('/api/resolve/' + episode.id, {}, 60000);
      if (generation !== phoneGeneration || mode !== 'player') return;
      await startPhone(result.item);
    } catch (error) {
      if (generation === phoneGeneration) $('phone-status').textContent = error.message;
      throw error;
    }
  }
  $('mode-remote').onclick = () => setMode('remote'); $('mode-player').onclick = () => setMode('player');
  $('phone-stop').onclick = stopPhone;
  $('watch-current').onclick = async () => {
    try { if (!state?.media) throw new Error('当前没有可继续的视频，请在下方选集。'); await startPhone(state.media, state.tv.position); }
    catch (error) { notice(error.message, true); }
  };
  setInterval(() => { if (phoneDanmaku && phoneItem) phoneDanmaku.tick(phoneVideo.currentTime * 1000, phoneVideo.paused); }, 100);
  setInterval(refreshPhoneDanmaku, 5000);
  function notice(text, error = false) {
    clearTimeout(noticeTimer); $('notice').textContent = text; $('notice').classList.toggle('error', error);
    noticeTimer = setTimeout(() => { $('notice').textContent = ''; }, error ? 9000 : 5000);
  }
  async function api(path, options = {}, timeout = 22000) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeout);
    try {
      const response = await fetch(path, { ...options, signal: abort.signal,
        headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Server error ' + response.status);
      }
      return result;
    } catch (error) { if (error.name === 'AbortError') throw new Error('The Mac took too long to respond. Try again.'); throw error; }
    finally { clearTimeout(timer); }
  }
  function time(milliseconds) {
    const seconds = Math.max(0, Math.floor((milliseconds || 0) / 1000));
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }
  function connection(online) {
    $('connection').textContent = online ? 'TV online' : 'TV offline';
    $('connection').classList.toggle('online', online);
  }
  function selectTab(value) {
    ['search', 'queue', 'reports'].forEach(name => {
      $(name + '-panel').hidden = value !== name;
      $(name + '-tab').classList.toggle('selected', value === name);
    });
    if (value === 'reports') loadReports();
  }
  function button(label, callback, className) {
    const element = document.createElement('button'); element.type = 'button'; element.textContent = label;
    if (className) element.className = className;
    element.onclick = async () => {
      element.disabled = true;
      try { await callback(element); } catch (error) { notice(error.message, true); }
      finally { element.disabled = false; }
    };
    return element;
  }
  function renderState(value) {
    if (state && value.revision < state.revision) return;
    state = value; connection(value.tvOnline);
    $('watch-current').disabled = !value.media;
    $('now-title').textContent = value.active?.title || value.tv.title || 'Nothing playing';
    const phaseStatus = { resolving: 'Finding the stream on your Mac… up to 45 seconds.',
      preparing: 'Preparing original-quality video for the TV on your Mac…', loading: 'Loading on the TV…' }[value.phase];
    $('now-status').textContent = value.error || (!value.tvOnline ? 'TV offline. Open the updated Bangumi TV app on the TV.' :
      phaseStatus ||
      value.tv.seek?.error || (value.tv.seek?.state === 'seeking' ? 'Seeking on TV…' : '') ||
      (value.tv.status === 'playing' ? 'Playing on TV' :
      value.tv.status === 'paused' ? 'Paused on TV' : 'Ready. Choose an episode or play the queue.'));
    $('playback-time').textContent = time(value.tv.position) + ' / ' + time(value.tv.duration);
    $('progress-fill').style.width = value.tv.duration > 0 ? Math.min(100, 100 * value.tv.position / value.tv.duration) + '%' : '0%';
    $('toggle-play').textContent = value.tv.status === 'paused' ? 'Resume' : 'Pause';
    const playable = value.tvOnline && !['resolving', 'preparing', 'loading'].includes(value.phase) && ['playing', 'paused'].includes(value.tv.status);
    ['toggle-play', 'seek-back', 'seek-forward'].forEach(id => { $(id).disabled = !playable; });
    $('stop').disabled = !value.tvOnline;
    $('play-next').disabled = !value.tvOnline || !value.queue.length || ['resolving', 'preparing'].includes(value.phase);
    $('clear-queue').disabled = !value.queue.length;
    $('queue-count').textContent = value.queue.length;
    const signature = JSON.stringify(value.queue);
    if (signature !== queueSignature) {
      queueSignature = signature; $('queue').textContent = '';
      if (!value.queue.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'Your queue is empty. Add episodes from Find anime.'; $('queue').appendChild(empty); }
      value.queue.forEach((item, index) => {
        const row = document.createElement('div'); row.className = 'queue-item';
        const title = document.createElement('p'); title.textContent = (index + 1) + '. ' + item.title;
        const actions = document.createElement('div'); actions.className = 'queue-actions';
        const up = button('↑ Up', () => action({ action: 'move', id: item.id, direction: -1 })); up.disabled = index === 0;
        const down = button('↓ Down', () => action({ action: 'move', id: item.id, direction: 1 })); down.disabled = index === value.queue.length - 1;
        actions.append(up, down, button('Remove', () => action({ action: 'remove', id: item.id })));
        row.append(title, actions); $('queue').appendChild(row);
      });
    }
  }
  async function updateState() {
    if (stateBusy) return;
    stateBusy = true;
    try {
      renderState(await api('/api/controller/state', {}, 8000));
    } catch (error) {
      $('connection').textContent = 'Mac disconnected'; $('connection').classList.remove('online'); $('now-status').textContent = error.message;
      ['toggle-play', 'seek-back', 'seek-forward', 'stop', 'play-next'].forEach(id => { $(id).disabled = true; });
    }
    finally { stateBusy = false; }
  }
  async function action(value) {
    renderState(await api('/api/controller/action', { method: 'POST', body: JSON.stringify(value) }, 12000));
  }
  function playingMedia() { return mode === 'player' ? phoneItem : state?.media; }
  async function danmakuAction(input) {
    return api('/api/controller/danmaku', { method: 'POST', body: JSON.stringify(input) }, 25000);
  }
  $('danmaku-save').onclick = async () => {
    try { await danmakuAction({ action: 'settings', enabled: $('danmaku-enabled').checked, offset: Number($('danmaku-offset').value) }); notice('Danmaku settings applied.'); }
    catch (error) { notice(error.message, true); }
  };
  $('danmaku-file').onchange = async () => {
    const file = $('danmaku-file').files[0], media = playingMedia();
    if (!file) return;
    try {
      if (!media?.id) throw new Error('Start an episode first.');
      if (file.size > 4 * 1024 * 1024) throw new Error('Danmaku file limit: 4 MB');
      const result = await danmakuAction({ action: 'import', streamId: media.id, content: await file.text() });
      notice(result.count + ' comments imported for ' + media.title);
    } catch (error) { notice(error.message, true); }
    finally { $('danmaku-file').value = ''; }
  };
  $('danmaku-search').onclick = async () => {
    $('danmaku-search').disabled = true;
    try {
      const data = await api('/api/controller/danmaku/search?anime=' + encodeURIComponent($('danmaku-query').value), {}, 25000);
      $('danmaku-matches').textContent = '';
      for (const anime of data.animes || []) for (const episode of anime.episodes || []) {
        $('danmaku-matches').appendChild(button(anime.animeTitle + ' · ' + episode.episodeTitle, async () => {
          const media = playingMedia(); if (!media?.id) throw new Error('Start an episode first.');
          const result = await danmakuAction({ action: 'attach', streamId: media.id, episodeId: episode.episodeId });
          notice(result.count + ' online comments loaded.');
        }));
      }
      if (!$('danmaku-matches').children.length) $('danmaku-matches').textContent = 'No episodes found. Try a more specific title.';
    } catch (error) { notice(error.message, true); }
    finally { $('danmaku-search').disabled = false; }
  };
  function renderEpisodes() {
    if (!show) return;
    const road = show.roads[Number($('road').value) || 0]; $('episodes').textContent = '';
    $('episode-count').textContent = road.episodes.length + ' episodes';
    road.episodes.forEach(episode => {
      const row = document.createElement('div'); row.className = 'episode';
      const title = document.createElement('strong'); title.textContent = episode.name;
      const actions = document.createElement('div'); actions.className = 'actions';
      actions.append(button(mode === 'player' ? '在手机播放' : 'Play on TV', async () => {
        if (mode === 'player') await playEpisodeOnPhone(episode);
        else { await action({ action: 'play', episodeId: episode.id }); notice('Finding ' + episode.name + ' for your TV…'); }
      }, 'primary'),
        button('+ Queue', async () => { await action({ action: 'enqueue', episodeIds: [episode.id] }); notice(episode.name + ' added to the queue.'); }));
      row.append(title, actions); $('episodes').appendChild(row);
    });
  }
  async function openShow(item) {
    const generation = ++requestGeneration;
    $('results').hidden = true; $('episodes-panel').hidden = false;
    $('search-form').hidden = true; $('search-status').hidden = true;
    $('show-title').textContent = item.title + ' / ' + item.provider; $('show-status').textContent = 'Loading episodes…';
    $('episodes').textContent = ''; $('road').textContent = ''; $('queue-all').disabled = true; show = null;
    const value = await api('/api/shows/' + item.id);
    if (generation !== requestGeneration) return;
    show = value;
    value.roads.forEach((road, index) => { const option = document.createElement('option'); option.value = index; option.textContent = road.name; $('road').appendChild(option); });
    $('show-status').textContent = '播放目标由顶部模式选择。Queue 加入电视的待播列表。';
    $('queue-all').disabled = false; renderEpisodes();
  }
  $('search-form').onsubmit = async event => {
    event.preventDefault(); const generation = ++searchGeneration; requestGeneration++;
    $('search-button').disabled = true; $('episodes-panel').hidden = true; $('results').hidden = false; $('results').textContent = '';
    $('search-status').textContent = 'Searching sources…';
    try {
      const result = await api('/api/search?q=' + encodeURIComponent($('query').value.trim()) + '&provider=' + encodeURIComponent($('provider').value));
      if (generation !== searchGeneration) return;
      $('search-status').textContent = (result.items.length ? 'Choose a result.' : 'No results. Try another title or source.') + '\n' +
        result.providers.map(provider => provider.provider + ': ' + (provider.error || provider.count + ' results')).join(' · ');
      result.items.forEach(item => {
        const card = button('', async () => { try { await openShow(item); } catch (error) { $('show-status').textContent = error.message; } }, 'result');
        const title = document.createElement('strong'); title.textContent = item.title;
        const provider = document.createElement('span'); provider.textContent = item.provider;
        const cover = document.createElement('img'); cover.className = 'cover'; cover.alt = ''; cover.loading = 'lazy';
        cover.src = '/api/covers/' + item.id; cover.onerror = () => { cover.hidden = true; };
        const info = document.createElement('div'); info.append(title, provider);
        card.append(cover, info); $('results').appendChild(card);
      });
    } catch (error) { if (generation === searchGeneration) $('search-status').textContent = error.message; }
    finally { if (generation === searchGeneration) $('search-button').disabled = false; }
  };
  $('back-results').onclick = () => {
    requestGeneration++; show = null; $('episodes-panel').hidden = true; $('results').hidden = false;
    $('search-form').hidden = false; $('search-status').hidden = false;
  };
  $('road').onchange = renderEpisodes;
  $('queue-all').onclick = async () => {
    if (!show) return;
    $('queue-all').disabled = true;
    try { await action({ action: 'enqueue', episodeIds: show.roads[Number($('road').value) || 0].episodes.map(episode => episode.id) }); notice('Episodes added in order.'); }
    catch (error) { notice(error.message, true); } finally { $('queue-all').disabled = false; }
  };
  $('search-tab').onclick = () => selectTab('search'); $('queue-tab').onclick = () => selectTab('queue');
  $('reports-tab').onclick = () => selectTab('reports');
  let reportGeneration = 0;
  async function showReport() {
    const id = $('report-select').value, generation = ++reportGeneration;
    if (!id) return;
    try {
      const report = await api('/api/reports/' + encodeURIComponent(id));
      if (generation !== reportGeneration) return;
      $('report-status').textContent = new Date(report.startedAt).toLocaleString() + ' · ' + report.status +
        (report.error ? '\n' + report.error : '') + (report.status !== 'completed' ? '\n报告尚未完成，可稍后刷新。' : '');
      $('report-results').textContent = '';
      for (const provider of report.providers || []) {
        const section = document.createElement('section'); section.className = 'panel';
        const heading = document.createElement('h3');
        heading.textContent = provider.id + ' · ' + provider.cases.filter(item => item?.outcome === 'passed').length + '/' + (report.expectedPerProvider || 10) + ' 通过';
        section.appendChild(heading);
        for (const result of provider.cases.filter(Boolean)) {
          const details = document.createElement('details'), label = document.createElement('summary'), description = document.createElement('p');
          const pending = result.outcome === 'catalogue-only';
          label.textContent = (result.outcome === 'passed' ? '✓ ' : pending ? '… ' : '✗ ') + result.query;
          description.className = 'hint';
          description.textContent = (result.error || (pending ? '目录已找到，等待视频测试' : '')) + '\n' + (result.attempts || []).map(a =>
            '线路 ' + a.road + ' · 第 ' + a.episode + ' · ' + (a.outcome === 'passed' ? a.format + ' / ' + a.bytes + ' bytes' : a.error) + ' · ' + a.elapsedSeconds + 's').join('\n');
          details.append(label, description); section.appendChild(details);
        }
        $('report-results').appendChild(section);
      }
    } catch (error) { if (generation === reportGeneration) $('report-status').textContent = error.message; }
  }
  async function loadReports() {
    try {
      const data = await api('/api/reports'), previous = $('report-select').value;
      $('report-select').textContent = '';
      for (const report of data.reports) {
        const option = document.createElement('option'); option.value = report.id;
        option.textContent = new Date(report.startedAt).toLocaleString() + ' · ' + report.status;
        $('report-select').appendChild(option);
      }
      if (data.reports.some(item => item.id === previous)) $('report-select').value = previous;
      if (!data.reports.length) { $('report-status').textContent = '还没有报告。首次测试完成后会显示在这里。'; return; }
      await showReport();
    } catch (error) { $('report-status').textContent = error.message; }
  }
  $('report-select').onchange = showReport; $('report-refresh').onclick = loadReports;
  const commands = { 'toggle-play': () => ({ action: state?.tv.status === 'paused' ? 'resume' : 'pause' }),
    'seek-back': () => ({ action: 'seek', seconds: -10 }), 'seek-forward': () => ({ action: 'seek', seconds: 10 }),
    stop: () => ({ action: 'stop' }), 'play-next': () => ({ action: 'next' }), 'clear-queue': () => ({ action: 'clear' }) };
  Object.entries(commands).forEach(([id, value]) => { $(id).onclick = async () => { $(id).disabled = true;
    try { await action(value()); } catch (error) { notice(error.message, true); } finally { await updateState(); } }; });
  async function init() {
    await updateState();
    try {
      const settings = await api('/api/controller/danmaku');
      $('danmaku-status').textContent = settings.message;
      $('danmaku-enabled').checked = settings.enabled !== false;
      $('danmaku-offset').value = settings.offset || 0;
      $('danmaku-search').disabled = !settings.configured;
    } catch (error) { $('danmaku-status').textContent = error.message; }
    try {
      const result = await api('/api/providers');
      result.providers.forEach(provider => { const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.name; $('provider').appendChild(option); });
      if (result.providers.some(provider => provider.id === 'moonci')) $('provider').value = 'moonci';
    } catch (error) { $('search-status').textContent = error.message; }
  }
  init(); setInterval(updateState, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateState(); });
}());
