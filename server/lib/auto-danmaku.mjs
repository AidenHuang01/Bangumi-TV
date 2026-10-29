// Comments arrive independently of video. Polling never waits for desktop work.
export const animeKey = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s!！:：·.\-_]/g, '');
export function episodeNumber(value) {
  const text = String(value || '').trim();
  const match = /^(?:第\s*)?(\d{1,4})(?:\s*[集话話])?$/.exec(text) || /^ep(?:isode)?[ ._-]*(\d{1,4})$/i.exec(text);
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}

export function createAutoDanmaku({ cache, danmaku, acquire, now = Date.now, delay = 2000, retry = 5000, idle = 30000 } = {}) {
  const jobs = new Map(), consumers = new Map();
  let closed = false;
  function prune() {
    for (const [key, value] of consumers) if (now() - value.seen > idle) consumers.delete(key);
    for (const job of jobs.values()) if (![...consumers.values()].some(value => value.id === job.id)) {
      job.abort.abort(); jobs.delete(job.id);
    }
  }
  const cleanup = setInterval(prune, Math.min(idle, 5000)); cleanup.unref?.();
  const valid = job => !closed && danmaku.status().enabled !== false && jobs.get(job.id) === job && [...consumers.values()].some(value => value.id === job.id);
  function status(id) {
    if (danmaku.status().enabled === false) return { state: 'disabled', message: '弹幕已关闭。', count: 0 };
    const job = jobs.get(id);
    return job ? { state: job.state, message: job.message, count: job.count || 0 }
      : { state: 'idle', message: acquire ? '选集后自动获取弹幕，Mac 不播放视频。' : '当前可转发已缓存弹幕；后台获取新弹幕的通道尚未接通。', count: 0 };
  }
  function set(job, state, message) { if (valid(job)) Object.assign(job, { state, message }); }
  async function check(job) {
    try {
      const listing = await cache.list();
      if (!valid(job)) return;
      const matches = (listing.items || []).filter(item => item.episode === job.episode &&
        [item.title, ...(item.aliases || [])].some(name => animeKey(name) === animeKey(job.title)));
      if (matches.length) {
        // Prefer the newest cache for the exact series/episode; provider can vary.
        const selected = matches.sort((a, b) => b.updatedAt - a.updatedAt)[0];
        const data = await cache.read(selected.id);
        if (!valid(job)) return;
        // A manual import/match always wins over a late automatic result.
        if (danmaku.read(job.id).count) {
          set(job, 'loaded', '当前视频已有弹幕，保留已选弹幕。');
          return;
        }
        const result = danmaku.import(job.id, data.content, data.source + ' · 自动加载');
        job.count = result.count;
        set(job, 'loaded', '已自动加载 ' + result.count + ' 条弹幕，与当前播放进度同步。');
        job.abort.abort(); // Stop optional acquisition once the file is usable.
        return;
      }
      if (acquire && !job.requested) {
        job.requested = true;
        set(job, 'acquiring', '正在后台获取当前集弹幕，视频继续播放…');
        job.acquisition = Promise.resolve().then(() => valid(job) && !job.abort.signal.aborted && acquire({ title: job.title, episode: job.episode,
          provider: job.provider, signal: job.abort.signal })).then(result => {
          if (!valid(job) || job.abort.signal.aborted) return;
          if (result?.content && !danmaku.read(job.id).count) {
            const imported = danmaku.import(job.id, result.content, result.source || 'danmu_api');
            job.count = imported.count;
            set(job, 'loaded', '已自动加载 ' + imported.count + ' 条弹幕，与当前播放进度同步。');
          } else if (!job.abort.signal.aborted) set(job, 'waiting', '弹幕请求已处理，正在等待数据…');
          job.next = 0;
        }, error => {
          if (job.abort.signal.aborted || !valid(job)) return;
          set(job, 'needs-action', error.publicMessage || '后台弹幕获取未完成，不影响视频；可在手机重试或手动匹配。');
        }).catch(() => { set(job, 'needs-action', '弹幕数据无法解析，请换一个弹幕来源。'); });
      } else if (!job.requested) {
        set(job, 'waiting', '后台获取新弹幕尚未接通，不会在 Mac 播放视频；可手动选择已缓存弹幕。');
      }
    } catch {
      set(job, 'waiting', '弹幕文件可能仍在写入，稍后自动重试；视频继续播放。');
    } finally { job.busy = false; }
  }
  return {
    observe(stream, consumer = 'tv') {
      if (closed || !stream?.id) return status();
      prune();
      consumers.set(consumer, { id: stream.id, seen: now() });
      if (danmaku.status().enabled === false) {
        const old = jobs.get(stream.id); old?.abort.abort(); jobs.delete(stream.id);
        return { state: 'disabled', message: '弹幕已关闭，不会自动获取。', count: 0 };
      }
      for (const old of jobs.values()) {
        if (!valid(old)) { old.abort.abort(); jobs.delete(old.id); }
      }
      let job = jobs.get(stream.id);
      if (!job) {
        job = { id: stream.id, title: stream.animeTitle || stream.title?.split(' · ')[0],
          episode: episodeNumber(stream.episodeName || stream.title?.split(' · ').at(-1)), provider: stream.provider,
          state: 'waiting', message: '视频先播放，正在准备自动加载弹幕…', next: now() + delay,
          abort: new AbortController() };
        jobs.set(stream.id, job);
      }
      if (!job.title || !job.episode) {
        set(job, 'unmatched', '无法可靠识别番剧或集数，请手动匹配弹幕，避免加载错集。');
        return status(stream.id);
      }
      if (danmaku.read(stream.id).count) {
        job.count = danmaku.read(stream.id).count;
        set(job, 'loaded', '当前视频已加载 ' + job.count + ' 条弹幕。');
        job.abort.abort();
      } else if (!job.busy && job.state !== 'loaded' && now() >= job.next) {
        job.busy = true; job.next = now() + retry;
        job.work = check(job);
      }
      return status(stream.id);
    },
    poll(stream, consumer = 'tv') {
      // Reading a public comment URL cannot initiate desktop automation. Only
      // the protected phone playing event / authenticated TV poll can activate it.
      return consumers.get(consumer)?.id === stream?.id ? this.observe(stream, consumer) : status(stream?.id);
    },
    release(consumer, id) {
      if (id && consumers.get(consumer)?.id !== id) return;
      consumers.delete(consumer);
      for (const job of jobs.values()) if (!valid(job)) { job.abort.abort(); jobs.delete(job.id); }
    },
    status,
    cancel() { for (const job of jobs.values()) job.abort.abort(); jobs.clear(); },
    retry(stream, consumer) {
      const old = jobs.get(stream.id); old?.abort.abort(); jobs.delete(stream.id);
      return this.observe(stream, consumer);
    },
    async settled() { await Promise.all([...jobs.values()].map(job => job.work)); },
    close() { closed = true; clearInterval(cleanup); for (const job of jobs.values()) job.abort.abort(); jobs.clear(); consumers.clear(); }
  };
}
