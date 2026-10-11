(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let state = null, show = null, searchGeneration = 0, requestGeneration = 0;
  let stateBusy = false, noticeTimer, queueSignature = '';
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
    $('search-panel').hidden = value !== 'search'; $('queue-panel').hidden = value !== 'queue';
    $('search-tab').classList.toggle('selected', value === 'search'); $('queue-tab').classList.toggle('selected', value === 'queue');
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
    $('now-title').textContent = value.active?.title || value.tv.title || 'Nothing playing';
    $('now-status').textContent = value.error || value.tv.seek?.error || (value.tv.seek?.state === 'seeking' ? 'Seeking on TV…' : '') || (!value.tvOnline ? 'TV offline. Open the updated Bangumi TV app on the TV.' :
      value.phase === 'resolving' ? 'Finding the stream on your Mac… up to 45 seconds.' :
      value.phase === 'loading' ? 'Loading on the TV…' : value.tv.status === 'playing' ? 'Playing on TV' :
      value.tv.status === 'paused' ? 'Paused on TV' : 'Ready. Choose an episode or play the queue.');
    $('playback-time').textContent = time(value.tv.position) + ' / ' + time(value.tv.duration);
    $('progress-fill').style.width = value.tv.duration > 0 ? Math.min(100, 100 * value.tv.position / value.tv.duration) + '%' : '0%';
    $('toggle-play').textContent = value.tv.status === 'paused' ? 'Resume' : 'Pause';
    const playable = value.tvOnline && ['playing', 'paused'].includes(value.tv.status);
    ['toggle-play', 'seek-back', 'seek-forward'].forEach(id => { $(id).disabled = !playable; });
    $('stop').disabled = !value.tvOnline;
    $('play-next').disabled = !value.tvOnline || !value.queue.length || value.phase === 'resolving';
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
  function playingMedia() { return state?.media; }
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
      actions.append(button('Play on TV', async () => { await action({ action: 'play', episodeId: episode.id }); notice('Finding ' + episode.name + ' for your TV…'); }, 'primary'),
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
    $('show-status').textContent = 'Play now replaces the current TV video. Queue adds to Up next.';
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
        card.append(title, provider); $('results').appendChild(card);
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
