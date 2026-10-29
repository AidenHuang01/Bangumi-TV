import { open, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { requestUpstream } from './upstream.mjs';
import { readBody } from './discovery.mjs';
import { bangumiAliases } from './bangumi-titles.mjs';

const defaultRoot = process.platform === 'darwin' ? path.join(homedir(),
  'Library/Containers/com.example.kazumi/Data/Library/Application Support/com.example.kazumi/downloads') : null;
const fail = message => Object.assign(new Error(message), { status: 400 });
const within = (root, file) => { const relative = path.relative(root, file); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

// Read only downloaded-episode comment files. Never inspect app binaries,
// credentials, databases or HTTPS traffic. No caller-supplied filesystem paths.
export function createKazumiCache({ root = process.env.KAZUMI_CACHE_DIR || defaultRoot, upstream = requestUpstream } = {}) {
  let entries = new Map(), pending;
  const titles = new Map();
  async function title(id) {
    if (titles.has(id)) return titles.get(id);
    let value = { title: 'Bangumi #' + id, aliases: [] };
    try {
      const result = await upstream('https://api.bgm.tv/v0/subjects/' + id, {
        signal: AbortSignal.timeout(4000), source: { userAgent: 'Forge-TV (https://github.com/forgetech-dev/Forge-TV)' }
      });
      if (result.status !== 200) { result.stream.destroy(); throw new Error('Metadata unavailable'); }
      const data = JSON.parse((await readBody(result, 1024 * 1024)).toString());
      if (typeof (data.name_cn || data.name) === 'string') value = {
        title: (data.name_cn || data.name).slice(0, 200),
        aliases: bangumiAliases(data)
      };
    } catch { /* Metadata does not gate local comment import. */ }
    titles.set(id, value);
    while (titles.size > 100) titles.delete(titles.keys().next().value);
    return value;
  }
  async function scan() {
    if (!root) return { available: false, items: [], message: 'Kazumi cache location is not configured on this server.' };
    let base, shows;
    try { base = await realpath(root); shows = await readdir(base, { withFileTypes: true }); }
    catch { entries = new Map(); return { available: false, items: [], message: '未发现 Kazumi 弹幕缓存。请在官方 App 开启“缓存弹幕”，并下载需要的那一集。' }; }
    const found = [];
    // Bound local filesystem work; do not recursively traverse arbitrary folders.
    for (const show of shows.filter(row => row.isDirectory() && /^\d{1,12}_.{1,100}$/.test(row.name)).slice(0, 100)) {
      const split = show.name.indexOf('_'), bangumiId = show.name.slice(0, split), provider = show.name.slice(split + 1);
      let episodes;
      try { episodes = await readdir(path.join(base, show.name), { withFileTypes: true }); } catch { continue; }
      for (const episode of episodes.filter(row => row.isDirectory() && /^[1-9]\d{0,4}$/.test(row.name)).slice(0, 100)) {
        const relative = path.join(show.name, episode.name, 'danmaku.json');
        try {
          const file = await realpath(path.join(base, relative));
          if (!within(base, file) || file !== path.join(base, relative)) continue; // Reject all symlinked components.
          const info = await stat(file);
          if (!info.isFile() || !info.size || info.size > 4 * 1024 * 1024) continue;
          found.push({ id: createHash('sha256').update(relative).digest('hex').slice(0, 32),
            bangumiId, provider, episode: Number(episode.name), updatedAt: info.mtimeMs, file, base });
        } catch { /* In-progress/deleted downloads are optional. */ }
      }
    }
    const recent = found.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
    // One metadata request at a time; look up only the most recent ten shows.
    for (const id of [...new Set(recent.map(row => row.bangumiId))].slice(0, 10)) await title(id);
    entries = new Map(recent.map(row => [row.id, row]));
    return { available: true, items: recent.map(({ file, base, ...row }) => ({ ...row,
      ...(titles.get(row.bangumiId) || { title: 'Bangumi #' + row.bangumiId, aliases: [] }) })),
      message: recent.length ? '仅转发官方 Kazumi 已缓存的弹幕；请核对番剧和集数后选择。' : '还没有弹幕文件。请在官方 Kazumi 下载一集并开启“缓存弹幕”。' };
  }
  return {
    list() { return pending ||= scan().finally(() => { pending = undefined; }); },
    async read(id) {
      if (!/^[a-f0-9]{32}$/.test(id || '')) throw fail('Invalid Kazumi cache selection');
      await this.list();
      const entry = entries.get(id);
      if (!entry) throw fail('Kazumi cache expired. Refresh the list.');
      try {
        const file = await realpath(entry.file);
        if (file !== entry.file || !within(entry.base, file)) throw new Error('Invalid cache');
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!(await handle.stat()).isFile()) throw new Error('Invalid cache');
          const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
          let size = 0;
          while (size < buffer.length) {
            const result = await handle.read(buffer, size, buffer.length - size, null);
            if (!result.bytesRead) break;
            size += result.bytesRead;
          }
          if (size > 4 * 1024 * 1024) throw new Error('Cache too large');
          return { content: buffer.toString('utf8', 0, size), source: 'Kazumi 官方缓存 · ' + (titles.get(entry.bangumiId)?.title || entry.bangumiId) + ' · 第' + entry.episode + '集' };
        } finally { await handle.close(); }
      } catch { throw fail('Kazumi cache is unavailable or still being written. Refresh and try again.'); }
    }
  };
}
