import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

// Old official downloads may have been obtained after choosing a different
// season in Kazumi's source picker. Auto-use only files whose acquisition was
// verified by our exact-title workflow. Manual cache selection stays available.
export function createVerifiedKazumiCache(cache, { file = null } = {}) {
  let approved = {}, loading, work = Promise.resolve();
  function load() {
    if (!file) return;
    // A separately verified export can be approved while the gateway is live.
    // Re-read the small atomic registry rather than freezing a startup snapshot.
    return loading ||= (async () => {
      try {
        approved = {};
        const text = await readFile(file, 'utf8');
        if (text.length > 100000) return;
        const data = JSON.parse(text);
        // v1 came from the old unverified wide-layout workflow. Never silently
        // trust it after the known source/season mismatch in that experiment.
        if (data.version !== 2 || !data.items || typeof data.items !== 'object') return;
        approved = Object.fromEntries(Object.entries(data.items).filter(([id, time]) => /^[a-f0-9]{32}$/.test(id) && Number.isFinite(time)).slice(-500));
      } catch { /* Missing provenance is untrusted, never a playback failure. */ }
    })().finally(() => { loading = undefined; });
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
        const next = Object.fromEntries(Object.entries({ ...approved, [item.id]: item.updatedAt }).slice(-500));
        if (file) {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file + '.tmp', JSON.stringify({ version: 2, items: next }), { mode: 0o600 });
          await rename(file + '.tmp', file);
        }
        approved = next;
      });
      return work;
    }
  };
}
