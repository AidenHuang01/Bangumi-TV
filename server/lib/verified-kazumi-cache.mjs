import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

// Old official downloads may have been obtained after choosing a different
// season in Kazumi's source picker. Auto-use only files whose acquisition was
// verified by our exact-title workflow. Manual cache selection stays available.
export function createVerifiedKazumiCache(cache, { file = null } = {}) {
  let approved = {}, loaded = false, work = Promise.resolve();
  async function load() {
    if (loaded) return;
    loaded = true;
    if (!file) return;
    try {
      const text = await readFile(file, 'utf8');
      if (text.length > 100000) return;
      const data = JSON.parse(text);
      approved = Object.fromEntries(Object.entries(data).filter(([id, time]) => /^[a-f0-9]{32}$/.test(id) && Number.isFinite(time)).slice(-500));
    } catch { /* Missing provenance is untrusted, never a playback failure. */ }
  }
  return {
    async list() {
      await load();
      const result = await cache.list();
      return { ...result, items: result.items.filter(item => approved[item.id] === item.updatedAt) };
    },
    read: id => cache.read(id),
    approve(item) {
      work = work.catch(() => {}).then(async () => {
        await load();
        if (!/^[a-f0-9]{32}$/.test(item.id) || !Number.isFinite(item.updatedAt)) throw new Error('Invalid cache provenance');
        approved[item.id] = item.updatedAt;
        approved = Object.fromEntries(Object.entries(approved).slice(-500));
        if (file) {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file + '.tmp', JSON.stringify(approved), { mode: 0o600 });
          await rename(file + '.tmp', file);
        }
      });
      return work;
    }
  };
}
