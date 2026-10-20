import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultFile = fileURLToPath(new URL('../data/recently-played.json', import.meta.url));
const clean = (value, limit) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const key = title => title.normalize('NFKC').toLowerCase();

// Store titles, not expiring stream IDs, provider URLs, or browser credentials.
export function createRecentHistory({ file = defaultFile, now = Date.now } = {}) {
  let entries, loading, work = Promise.resolve();
  async function load() {
    if (!loading) loading = (async () => {
      if (!file) { entries = []; return; }
      let data;
      try { data = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') { entries = []; return; } throw new Error('Could not read recently played history.'); }
      if (!Array.isArray(data)) throw new Error('Invalid recently played history.');
      const seen = new Set();
      entries = data.flatMap(row => {
        const title = clean(row?.title, 100);
        if (!title || seen.has(key(title))) return [];
        seen.add(key(title));
        return [{ title, episode: clean(row.episode, 80), provider: clean(row.provider, 64),
          playedAt: Number.isFinite(row.playedAt) ? row.playedAt : 0 }];
      }).slice(0, 10);
    })();
    await loading;
  }
  return {
    async list() { await work; await load(); return entries.map(row => ({ ...row })); },
    record(stream) {
      const operation = work.then(async () => {
        await load();
        const parts = typeof stream.title === 'string' ? stream.title.split(' · ') : [];
        const title = clean(stream.animeTitle || parts[0], 100);
        if (!title) return entries.map(row => ({ ...row }));
        const row = { title, episode: clean(stream.episodeName || parts.slice(1).join(' · '), 80),
          provider: clean(stream.provider, 64), playedAt: now() };
        const updated = [row, ...entries.filter(entry => key(entry.title) !== key(title))].slice(0, 10);
        if (file) {
          await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          const temporary = file + '.' + randomBytes(6).toString('hex') + '.tmp';
          await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
          await rename(temporary, file);
        }
        entries = updated;
        return entries.map(entry => ({ ...entry }));
      });
      work = operation.catch(() => {});
      return operation;
    }
  };
}
