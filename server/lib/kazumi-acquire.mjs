import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { requestUpstream } from './upstream.mjs';
import { readBody } from './discovery.mjs';
import { animeKey, episodeNumber } from './auto-danmaku.mjs';
import { parseDanmaku } from './danmaku.mjs';
import { bangumiAliases } from './bangumi-titles.mjs';

const exec = promisify(execFile);
const driverPath = fileURLToPath(new URL('../../scripts/kazumi-ui.jxa', import.meta.url));
export const officialAppPath = fileURLToPath(new URL('../../.tools/official-kazumi-2.4.2/Kazumi.app', import.meta.url));
const executable = officialAppPath + '/Contents/MacOS/Kazumi';
const failure = message => Object.assign(new Error(message), { publicMessage: message });

export function createKazumiUIDriver({ run = exec } = {}) {
  return async function ui(input, signal) {
    const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', driverPath, JSON.stringify(input)],
      { signal, timeout: 12000, maxBuffer: 512 * 1024 });
    return JSON.parse(result.stdout);
  };
}

// Only public Bangumi metadata; the unmodified official app obtains comments.
export async function findKazumiSubject(title, { upstream = requestUpstream, signal } = {}) {
  async function json(url, options = {}) {
    const result = await upstream(url, { ...options, signal,
      source: { userAgent: 'Bangumi-TV-POC (https://github.com/AidenHuang01/Bangumi-TV)' } });
    if (result.status !== 200) { result.stream.destroy(); throw failure('番剧资料暂时不可用，稍后可重试。'); }
    return JSON.parse((await readBody(result, 1024 * 1024)).toString());
  }
  const data = await json('https://api.bgm.tv/v0/search/subjects?limit=10', {
    method: 'POST', contentType: 'application/json',
    body: JSON.stringify({ keyword: title, filter: { type: [2], nsfw: false } })
  });
  const matches = [];
  for (const item of (data.data || []).slice(0, 10)) {
    if (!Number.isSafeInteger(item.id) || item.id <= 0) continue;
    const detail = await json('https://api.bgm.tv/v0/subjects/' + item.id);
    if (detail.id !== item.id) continue;
    const aliases = bangumiAliases(detail);
    if (aliases.some(name => animeKey(name) === animeKey(title))) matches.push({
      id: detail.id, aliases, date: detail.date, totalEpisodes: Number(detail.eps) || null
    });
  }
  if (matches.length !== 1) throw failure('没有唯一且名称完全匹配的番剧，已停止自动获取，避免错季。');
  return matches[0];
}

export function providerRows(rows, provider) {
  const start = rows.findIndex(row => row.label.startsWith('来源规则：' + provider + '，'));
  if (start < 0) return [];
  const next = rows.findIndex((row, index) => index > start && row.label.startsWith('来源规则：'));
  return rows.slice(start + 1, next < 0 ? undefined : next);
}

export function createKazumiLifecycle({ run = exec, ui = createKazumiUIDriver({ run }), wait = ms => sleep(ms) } = {}) {
  async function pids() {
    const { stdout } = await run('/bin/ps', ['-axo', 'pid=,comm='], { timeout: 5000 });
    return stdout.split('\n').map(line => /^\s*(\d+)\s+(.+)$/.exec(line))
      .filter(row => row && row[2] === executable).map(row => Number(row[1]));
  }
  return {
    async start() {
      if ((await pids()).length) throw failure('官方 Kazumi 正在使用中；请先退出它，再在手机点“重新获取当前集弹幕”。');
      const version = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', officialAppPath + '/Contents/Info.plist']);
      if (version.stdout.trim() !== '2.4.2') throw failure('Kazumi 版本变化，需重新验证自动获取流程。');
      await run('/usr/bin/open', ['-a', officialAppPath]); // Never use custom deep-link workarounds.
    },
    async stop(originalSize) {
      if (originalSize) await ui({ action: 'restore-window', size: originalSize }).catch(() => {});
      await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'Application("com.example.kazumi").quit()'], { timeout: 5000 }).catch(() => {});
      // Quit can return -128 while exiting. Verify the exact binary; never
      // terminate the separate headless native Kazumi core.
      for (let i = 0; i < 12; i++) {
        if (!(await pids()).length) return;
        await wait(250);
      }
      for (const pid of await pids()) await run('/bin/kill', ['-TERM', String(pid)], { timeout: 5000 }).catch(() => {});
      for (let i = 0; i < 12; i++) {
        if (!(await pids()).length) return;
        await wait(250);
      }
      throw failure('官方 Kazumi 未能退出；请在 Mac 退出它以停止下载和播放。');
    }
  };
}

// Serialize desktop ownership; cancelled queued jobs never launch UI.
export function createKazumiAcquirer({ cache, ui = createKazumiUIDriver(),
  lifecycle = createKazumiLifecycle({ ui }), subject = findKazumiSubject,
  platform = process.platform, timeout = 180000, onCache = async () => {},
  onEvent = () => {}, wait = (ms, signal) => sleep(ms, undefined, { signal }) } = {}) {
  let tail = Promise.resolve();
  return request => {
    const job = tail.catch(() => {}).then(() => acquire(request)); tail = job; return job;
  };
  async function acquire({ title, episode, provider, signal: parent, onProgress = () => {} }) {
    if (parent?.aborted) return;
    if (platform !== 'darwin') throw failure('自动获取需要在这台 Mac 登录桌面后运行。');
    if (!title || title.length > 200 || !Number.isInteger(episode) || episode < 1 || episode > 9999)
      throw failure('无法可靠识别集数，请手动匹配弹幕。');
    const abort = new AbortController();
    const cancel = () => abort.abort(parent?.reason);
    parent?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => abort.abort(failure('官方 Kazumi 获取弹幕超时；视频继续播放，可在手机重试。')), timeout);
    const signal = abort.signal;
    let owned = false, originalSize, metadata;
    const event = (stage, extra = {}) => { try { onEvent({ stage, title, episode, ...extra }); onProgress(stage); } catch {} };
    const call = input => { signal.throwIfAborted(); return ui(input, signal); };
    const snapshot = async () => (await call({ action: 'snapshot' })).rows || [];
    const press = (row, scope) => call({ action: 'press', label: row.label, role: row.role, provider: scope });
    async function until(test, attempts = 40) {
      for (let i = 0; i < attempts; i++) {
        const rows = await snapshot(), value = test(rows);
        if (value) return value;
        await wait(700, signal);
      }
      throw failure('官方 Kazumi 界面未出现预期控件，已停止自动操作；可在手机重试。');
    }
    try {
      event('metadata'); metadata = await subject(title, { signal }); signal.throwIfAborted();
      const before = new Map((await cache.list()).items.map(item => [item.id, item.updatedAt]));
      event('launch'); await lifecycle.start(); owned = true;
      await wait(900, signal);
      const prepared = await call({ action: 'prepare' }); originalSize = prepared.originalSize;
      await until(rows => rows.some(row => row.label.includes('第 1 个标签，共 4 个')));
      await call({ action: 'home-search' });
      await until(rows => rows.some(row => row.role === 'AXTextField'));
      await call({ action: 'search-text', text: title });
      const result = await until(rows => {
        const candidates = rows.filter(row => row.role === 'AXImage' && metadata.aliases.some(name =>
          animeKey(row.label.split('\n')[0]) === animeKey(name)) &&
          (!metadata.date || row.label.split('\n').includes(metadata.date.slice(0, 4))));
        if (candidates.length > 1) throw failure('Kazumi 搜索结果不唯一，已停止，避免错季。');
        return candidates[0];
      });
      await press(result);
      const start = await until(rows => {
        if (!rows.some(row => metadata.aliases.some(name => animeKey(row.label) === animeKey(name)))) return null;
        if (metadata.date && !rows.some(row => row.label === metadata.date)) return null;
        return rows.find(row => row.role === 'AXButton' && row.label === '开始观看');
      });
      await press(start); event('source');
      await until(rows => rows.some(row => /^\d+ 个来源 · \d+ 个结果$/.test(row.label)));
      const providers = [...new Set(['AGE', provider, 'TvTFun', 'mutefun', 'moonci', 'mgnacg'].filter(Boolean))];
      let selected;
      for (const name of providers) {
        let rows = await snapshot();
        const header = rows.find(row => row.role === 'AXButton' && row.label.startsWith('来源规则：' + name + '，') && /[1-9]\d* 个结果/.test(row.label));
        if (!header) continue;
        let scoped = providerRows(rows, name);
        if (!scoped.some(row => row.label.startsWith('播放 '))) { await press(header); rows = await snapshot(); scoped = providerRows(rows, name); }
        const expand = scoped.find(row => /^展开全部 \d+ 个结果$/.test(row.label));
        if (expand) { await press(expand, name); rows = await snapshot(); scoped = providerRows(rows, name); }
        const matches = scoped.filter(row => row.role === 'AXButton' && row.label.endsWith('，来源 ' + name) &&
          metadata.aliases.some(alias => animeKey(row.label.slice(3, -('，来源 ' + name).length)) === animeKey(alias)));
        if (matches.length === 1) { selected = matches[0]; await press(selected, name); break; }
      }
      if (!selected) throw failure('官方 Kazumi 没有完全同名的来源，未选择近似番剧。');
      // Flutter can temporarily omit the whole player AX tree. The verified
      // native Player menu still identifies the player; the portrait download
      // control has a fixed point and opens a fully accessible native sheet.
      let ready = false;
      for (let i = 0; i < 40; i++) {
        if ((await call({ action: 'player-state' })).ready) { ready = true; break; }
        await wait(700, signal);
      }
      if (!ready) throw failure('官方 Kazumi 未能打开此来源的选集面板，请稍后重试。');
      await wait(500, signal);
      await call({ action: 'download-sheet' });
      const rows = await until(list => list.some(row => row.label === '下载选集') && list);
      const matches = rows.filter(row => episodeNumber(row.label) === episode);
      if (matches.length !== 1 || matches[0].enabled === false)
        throw failure('下载选集里无法唯一选择这一集，或任务已存在；请在 Kazumi 检查此集缓存。');
      await press(matches[0]);
      await press(await until(list => list.find(row => row.role === 'AXButton' && row.label === '下载 1 集')));
      event('waiting');
      // Do not quit before full JSON: Kazumi skips comments if stopped before
      // the download directory is ready. Video completion is not required.
      for (;;) {
        signal.throwIfAborted();
        const item = (await cache.list()).items.find(item => String(item.bangumiId) === String(metadata.id) &&
          item.episode === episode && item.updatedAt !== before.get(item.id));
        if (item) {
          let data, count = 0;
          try { data = await cache.read(item.id); count = parseDanmaku(data.content).length; } catch { /* Partial JSON; retry. */ }
          if (count) { await onCache(item); event('ready', { count }); return data; }
        }
        await wait(1000, signal);
      }
    } catch (error) {
      event(parent?.aborted ? 'cancelled' : 'failed');
      if (parent?.aborted) return;
      if (signal.aborted) throw signal.reason;
      if (error.publicMessage) throw error;
      if (/assistive|not allowed|not authorized|-25211|-1743/i.test(error.stderr || error.message || ''))
        throw failure('请在 Mac 辅助功能权限中允许 osascript，并保持桌面登录。');
      throw failure('官方 Kazumi 自动获取未完成，可能是来源或界面变化；视频继续播放，可在手机重试。');
    } finally {
      clearTimeout(timer); parent?.removeEventListener('abort', cancel);
      if (owned) { await lifecycle.stop(originalSize); event('stopped'); }
    }
  }
}
