// Live opt-in test: no movie file is saved, only playlists and a short segment probe.
const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const base = option('--server', 'http://127.0.0.1:8787');
const title = option('--title', '葬送的芙莉莲');
const provider = option('--provider', 'moonci');
const sourceNumber = Number(option('--source', '1'));
if (!Number.isInteger(sourceNumber) || sourceNumber < 1) throw new Error('--source must be a positive source number');
async function api(path, timeout = 60000) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(timeout) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
  return data;
}
const search = await api('/api/search?q=' + encodeURIComponent(title) + '&provider=' + encodeURIComponent(provider));
console.log('Sources:', search.providers);
const selection = search.items.find(item => item.title === title) || search.items[0];
if (!selection) throw new Error('No search results');
const show = await api('/api/shows/' + selection.id);
console.log('Title:', show.title, 'Provider:', show.provider);
console.log('Episode counts:', show.roads.map(road => road.episodes.length));
const road = show.roads[sourceNumber - 1];
if (!road) throw new Error('Source ' + sourceNumber + ' is not available for this title');
console.log('Playback source:', road.name);
const episode = road.episodes[0];
console.log('Resolving:', episode.name);
const { item } = await api('/api/resolve/' + episode.id);
console.log('Stream:', item.format, base + item.streamPath);
let target = base + item.streamPath;
if (item.format === 'hls') {
  for (let depth = 0; depth < 5; depth++) {
    const response = await fetch(target, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Playlist HTTP ' + response.status);
    const text = await response.text();
    if (!text.startsWith('#EXTM3U')) throw new Error('Invalid playlist');
    const master = text.includes('#EXT-X-STREAM-INF');
    const entry = text.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'));
    if (!entry) throw new Error('Playlist is empty');
    target = new URL(entry, target).href;
    if (!master) break;
  }
}
const response = await fetch(target, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20000) });
if (![200, 206].includes(response.status)) throw new Error('Segment HTTP ' + response.status);
const reader = response.body.getReader();
const { value } = await reader.read(); await reader.cancel();
if (!value?.length) throw new Error('Empty segment');
console.log('PASS: Mac proxy returned', value.length, 'original video bytes, HTTP', response.status);
console.log('Physical-TV playback and codec support still need confirmation.');
