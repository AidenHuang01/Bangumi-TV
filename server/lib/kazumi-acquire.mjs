import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { requestUpstream } from './upstream.mjs';
import { readBody } from './discovery.mjs';
import { animeKey, episodeNumber } from './auto-danmaku.mjs';
import { parseDanmaku } from './danmaku.mjs';

const exec = promisify(execFile);
const driverPath = fileURLToPath(new URL('../../scripts/kazumi-ui.jxa', import.meta.url));
const appPath = fileURLToPath(new URL('../../.tools/official-kazumi-2.4.2/Kazumi.app', import.meta.url));
const failure = message => Object.assign(new Error(message), { publicMessage: message });

export function createKazumiUIDriver({ run = exec } = {}) {
  return async function ui(input, signal) {
    const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', driverPath, JSON.stringify(input)],
      { signal, timeout: 12000, maxBuffer: 512 * 1024 });
    return JSON.parse(result.stdout);
  };
}

// Only public Bangumi metadata; the official app itself obtains all danmaku.
export async function findKazumiSubject(title, { upstream = requestUpstream, signal } = {}) {
  const result = await upstream('https://api.bgm.tv/v0/search/subjects?limit=10', {
    method: 'POST', contentType: 'application/json', signal,
    body: JSON.stringify({ keyword: title, filter: { type: [2], nsfw: false } }),
    source: { userAgent: 'Forge-TV (https://github.com/forgetech-dev/Forge-TV)' }
  });
  if (result.status !== 200) { result.stream.destroy(); throw failure('番剧资料暂时不可用，稍后可重新播放重试。'); }
  const data = JSON.parse((await readBody(result, 1024 * 1024)).toString());
  const matches = (data.data || []).filter(item => Number.isSafeInteger(item.id) && item.id > 0 &&
    [item.name, item.name_cn].some(name => name && animeKey(name) === animeKey(title)));
  if (matches.length !== 1) throw failure('没有唯一且名称完全匹配的番剧，已停止自动获取，避免错季。');
  return { id: matches[0].id, aliases: [matches[0].name_cn, matches[0].name].filter(Boolean) };
}

export function providerRows(rows, provider) {
  const start = rows.findIndex(row => row.label.startsWith('来源规则：' + provider + '，'));
  if (start < 0) return [];
  const next = rows.findIndex((row, index) => index > start && row.label.startsWith('来源规则：'));
  return rows.slice(start + 1, next < 0 ? undefined : next);
}

// Serialize desktop jobs: a late request must never click in another job's UI.
export function createKazumiAcquirer({ cache, ui = createKazumiUIDriver(), run = exec,
  subject = findKazumiSubject, platform = process.platform, timeout = 150000,
  onCache = async () => {},
  wait = (ms, signal) => sleep(ms, undefined, { signal }) } = {}) {
  let tail = Promise.resolve();
  return request => {
    const job = tail.catch(() => {}).then(() => acquire(request));
    tail = job;
    return job;
  };
  async function acquire({ title, episode, provider, signal: parent }) {
    if (platform !== 'darwin') throw failure('自动获取需要在这台 Mac 登录桌面后运行。');
    if (!title || title.length > 200 || !Number.isInteger(episode) || episode < 1 || episode > 9999)
      throw failure('无法可靠识别集数，请手动匹配弹幕。');
    const abort = new AbortController();
    const cancel = () => abort.abort(parent?.reason);
    if (parent?.aborted) cancel(); else parent?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => abort.abort(failure('官方 Kazumi 获取弹幕超时；视频继续播放。')), timeout);
    const signal = abort.signal;
    let selected, metadata;
    const call = input => { signal.throwIfAborted(); return ui(input, signal); };
    async function snapshot() { return (await call({ action: 'snapshot' })).rows || []; }
    const press = (row, scope) => call({ action: 'press', label: row.label, role: row.role, provider: scope });
    async function until(test, attempts = 25) {
      for (let i = 0; i < attempts; i++) {
        const rows = await snapshot(), value = test(rows);
        if (value) return value;
        await wait(700, signal);
      }
      throw failure('官方 Kazumi 界面未出现预期控件，已安全停止自动操作。');
    }
    try {
      signal.throwIfAborted();
      metadata = await subject(title, { signal });
      const before = new Map((await cache.list()).items.map(item => [item.id, item.updatedAt]));
      // Verify the known UI version. Never operate another application/bundle.
      const version = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', appPath + '/Contents/Info.plist'], { signal });
      if (version.stdout.trim() !== '2.4.2') throw failure('Kazumi 版本变化，需重新验证自动获取流程。');
      await run('/usr/bin/open', ['-a', appPath, 'kazumi://bangumi/' + metadata.id], { signal });
      await wait(800, signal);
      await call({ action: 'enable' });
      const start = await until(rows => {
        if (!rows.some(row => metadata.aliases.some(name => animeKey(row.label) === animeKey(name)))) return null;
        return rows.find(row => row.role === 'AXButton' && row.label === '开始观看');
      });
      await press(start);
      // Prefer the current provider, then official defaults. Exact series only.
      const providers = [...new Set([provider, 'AGE', 'TvTFun', 'mutefun', 'moonci', 'mgnacg'].filter(Boolean))];
      await until(rows => rows.some(row => /^\d+ 个来源 · \d+ 个结果$/.test(row.label)));
      for (const name of providers) {
        let rows = await snapshot();
        const header = rows.find(row => row.role === 'AXButton' && row.label.startsWith('来源规则：' + name + '，') && /[1-9]\d* 个结果/.test(row.label));
        if (!header) continue;
        let scoped = providerRows(rows, name);
        if (!scoped.some(row => row.label.startsWith('播放 '))) { await press(header); rows = await snapshot(); scoped = providerRows(rows, name); }
        const expand = scoped.find(row => /^展开全部 \d+ 个结果$/.test(row.label));
        if (expand) { await press(expand, name); rows = await snapshot(); scoped = providerRows(rows, name); }
        selected = scoped.find(row => row.role === 'AXButton' && row.label.endsWith('，来源 ' + name) &&
          metadata.aliases.some(alias => animeKey(row.label.slice(3, -('，来源 ' + name).length)) === animeKey(alias)));
        if (selected) { await press(selected, name); break; }
      }
      if (!selected) throw failure('官方 Kazumi 没有找到完全同名的可用来源，未选择近似番剧。');
      // Player controls can be absent from Flutter's AX tree. The driver only
      // allows two fixed points on the verified 1280x860 2.4.2 player layout.
      await wait(2000, signal);
      let rows = await snapshot();
      let download = rows.find(row => row.label === '缓存剧集');
      if (!download) {
        await call({ action: 'player-hover' });
        await wait(300, signal);
        await call({ action: 'player-panel' });
        await wait(250, signal); rows = await snapshot();
        download = rows.find(row => row.label === '缓存剧集');
      }
      if (download) await press(download);
      else await call({ action: 'download-sheet' });
      rows = await until(list => list.some(row => row.label === '下载选集') && list);
      const episodeRows = rows.filter(row => episodeNumber(row.label) !== null);
      const tile = episodeRows.find(row => episodeNumber(row.label) === episode);
      if (!tile || episodeRows.filter(row => episodeNumber(row.label) === episode).length !== 1)
        throw failure('下载选集里无法唯一识别这一集，已停止，避免下载错集。');
      await press(tile);
      const downloadOne = await until(list => list.find(row => row.role === 'AXButton' && row.label === '下载 1 集'));
      await press(downloadOne);
      // Cache delivery is handled separately and does not wait for the video.
      for (;;) {
        signal.throwIfAborted();
        const listing = await cache.list();
        const item = listing.items.find(item => String(item.bangumiId) === String(metadata.id) && item.episode === episode &&
          item.updatedAt !== before.get(item.id));
        if (item) {
          // A cache file can be visible before its JSON has finished writing.
          let valid = false;
          try { valid = parseDanmaku((await cache.read(item.id)).content).length > 0; } catch { /* Retry partial writes. */ }
          if (valid) { await onCache(item); return; }
        }
        await wait(2000, signal);
      }
    } catch (error) {
      if (parent?.aborted) return;
      if (signal.aborted) throw signal.reason;
      if (error.publicMessage) throw error;
      if (/assistive|not allowed|not authorized|-25211|-1743/i.test(error.stderr || error.message || ''))
        throw failure('请在 Mac 辅助功能权限中允许 osascript，并保持 Kazumi 可见。');
      throw failure('官方 Kazumi 自动获取未完成，可能是来源或界面变化；视频继续播放。');
    } finally {
      clearTimeout(timer); parent?.removeEventListener('abort', cancel);
      // Stop the extra Mac player after this serialized job, including cancel
      // and error paths. This does not stop the TV or delete download files.
      if (selected && metadata) {
        await run('/usr/bin/open', ['-a', appPath, 'kazumi://bangumi/' + metadata.id], { timeout: 5000 }).catch(() => {});
      }
    }
  }
}
