import { randomBytes, timingSafeEqual } from 'node:crypto';

const error = (message, status = 400) => Object.assign(new Error(message), { status });
const id = () => randomBytes(18).toString('hex');
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const publicEntry = entry => entry && ({ id: entry.id, title: entry.selection.title });

// One TV / one shared home queue. All source URLs and rule objects stay here, on the Mac.
export function createController({ discovery, now = Date.now } = {}) {
  const epoch = id();
  let receiver, commands = [], commandSequence = 0, queue = [], active = null;
  let generation = 0, phase = 'idle', lastError = '', closed = false;
  let work = Promise.resolve();
  let revision = 0;
  const online = () => !!receiver && now() - receiver.lastSeen < 10000;
  function restorePending() {
    if (active?.fromQueue && ['resolving', 'loading'].includes(phase) && receiver?.playbackId !== active.playbackId &&
      !queue.some(entry => entry.id === active.id) && queue.length < 100) {
      queue.unshift({ id: active.id, selection: active.selection });
    }
  }
  function issue(action, extra = {}) {
    commands.push({ seq: ++commandSequence, action, issuedAt: now(), ...extra });
    if (commands.length > 20) commands.shift();
  }
  function next() {
    if (!online()) throw error('Open the updated Bangumi TV app on your TV first.', 409);
    if (!queue.length) throw error('The queue is empty.', 409);
    restorePending();
    const entry = queue.shift();
    active = null;
    play(entry, true);
  }
  function play(entry, fromQueue = false) {
    if (!online()) throw error('The TV is offline. Open Bangumi TV on the TV first.', 409);
    restorePending();
    const job = ++generation;
    commands = commands.filter(command => command.action !== 'play');
    active = { ...entry, fromQueue, playbackId: id() }; phase = 'resolving'; lastError = '';
    const playbackId = active.playbackId;
    // Resolve serially; a Stop/new Play invalidates an old result, even if its browser job finishes later.
    work = work.then(async () => {
      if (job !== generation || closed) return;
      try {
        const { item } = await discovery.resolveSelection(entry.selection);
        if (job !== generation || closed) return;
        if (!online()) throw error('The TV disconnected while resolving. Open the app and retry.', 409);
        commands = commands.filter(command => command.action !== 'play');
        issue('play', { item, playbackId }); phase = 'loading'; revision++;
      } catch (failure) {
        if (job !== generation || closed) return;
        phase = 'error'; lastError = failure.message; revision++;
        if (fromQueue && queue.length < 100) queue.unshift(entry);
      }
    }).catch(failure => { lastError = failure.message; phase = 'error'; });
  }
  return {
    info() { return { tvOnline: online(), receiverVersion: receiver?.version || null, controllerVersion: '0.3.0' }; },
    register(input) {
      if (typeof input.clientId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.clientId)) throw error('Invalid TV client ID');
      if (online() && receiver.clientId !== input.clientId) throw error('Another TV receiver is already connected.', 409);
      // Reconnecting the same running app retains commands; rebooting it clears stale playback state.
      const bootId = typeof input.bootId === 'string' ? input.bootId.slice(0, 80) : undefined;
      if (!receiver || receiver.clientId !== input.clientId || receiver.bootId !== bootId) {
        restorePending();
        generation++; commands = []; active = null; phase = 'idle'; lastError = '';
        receiver = { clientId: input.clientId, bootId, session: id() };
      }
      receiver.lastSeen = now(); receiver.version = String(input.version || '').slice(0, 20);
      revision++;
      return { session: receiver.session, epoch };
    },
    poll(session, input) {
      if (!receiver || !equal(session, receiver.session)) throw error('TV registration expired.', 401);
      revision++;
      receiver.lastSeen = now();
      const applied = Number.isSafeInteger(input.applied) ? input.applied : 0;
      const expiredPlay = commands.some(command => command.action === 'play' && now() - command.issuedAt > 15000 && command.seq > applied);
      commands = commands.filter(command => command.seq > applied && now() - command.issuedAt <= 15000);
      if (expiredPlay && active) { restorePending(); phase = 'error'; lastError = 'TV did not receive playback in time. Try Play again.'; }
      const states = ['idle', 'loading', 'playing', 'paused', 'error'];
      receiver.status = states.includes(input.status) ? input.status : 'idle';
      receiver.title = typeof input.title === 'string' ? input.title.slice(0, 240) : '';
      receiver.position = Math.max(0, Math.min(Number(input.position) || 0, 86400000));
      receiver.duration = Math.max(0, Math.min(Number(input.duration) || 0, 86400000));
      const seek = input.seek;
      receiver.seek = seek && ['seeking', 'done', 'error'].includes(seek.state) ? {
        state: seek.state, from: Math.max(0, Number(seek.from) || 0), target: Math.max(0, Number(seek.target) || 0),
        actual: Math.max(0, Number(seek.actual) || 0), error: String(seek.error || '').slice(0, 300)
      } : null;
      receiver.playbackId = input.playbackId;
      if (active && input.playbackId === active.playbackId && phase !== 'resolving') {
        phase = receiver.status;
        if (phase === 'error') lastError = String(input.error || 'TV playback failed. Try another source.').slice(0, 300);
      }
      if (active && input.terminal && input.terminal.playbackId === active.playbackId) {
        active = null; phase = 'idle'; lastError = '';
        if (input.terminal.reason === 'ended' && queue.length) next();
      }
      return { epoch, commands };
    },
    state() {
      return { ...this.info(), revision, phase, error: lastError, active: publicEntry(active),
        tv: { status: receiver?.status || 'idle', title: receiver?.title || '',
          position: receiver?.position || 0, duration: receiver?.duration || 0, seek: receiver?.seek || null },
        queue: queue.map(publicEntry) };
    },
    mutate(input) {
      if (input.action === 'enqueue' || input.action === 'play') {
        const ids = input.action === 'play' ? [input.episodeId] : input.episodeIds;
        if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw error('Choose between 1 and 100 episodes.');
        if (input.action === 'enqueue' && queue.length + ids.length > 100) throw error('Queue limit: 100 episodes.');
        // Validate the whole batch before mutating anything. No client-supplied URLs/titles.
        const entries = ids.map(episodeId => ({ id: id(), selection: discovery.selection(episodeId) }));
        if (input.action === 'play') play(entries[0]); else queue.push(...entries);
      } else if (input.action === 'remove' || input.action === 'move') {
        const index = queue.findIndex(entry => entry.id === input.id);
        if (index < 0) throw error('Queue entry no longer exists.', 404);
        if (input.action === 'remove') queue.splice(index, 1);
        else {
          if (![-1, 1].includes(input.direction)) throw error('Invalid move direction');
          const target = index + input.direction;
          if (target >= 0 && target < queue.length) [queue[index], queue[target]] = [queue[target], queue[index]];
        }
      } else if (input.action === 'clear') queue = [];
      else if (input.action === 'next') next();
      else if (['pause', 'resume', 'stop', 'seek'].includes(input.action)) {
        if (!online()) throw error('The TV is offline.', 409);
        if (input.action === 'stop') { restorePending(); generation++; commands = []; active = null; phase = 'idle'; lastError = ''; }
        if (input.action === 'seek' && ![-10, 10].includes(input.seconds)) throw error('Seek must be −10 or +10 seconds');
        issue(input.action, input.action === 'seek' ? { seconds: input.seconds } : {});
      } else throw error('Unknown controller action');
      revision++;
      return this.state();
    },
    async settled() { await work; }, // Deterministic tests / clean lifecycle.
    close() { closed = true; generation++; }
  };
}
