# Official danmaku startup / verified-cache recovery

## Incident

- TV 0.6.2 was paused at 71.530s in **Lycoris Recoil episode 1**, with the
  server reporting zero comments and `needs-action`. This was not evidence of
  an animation failure: no comment data was attached to that stream at all.
- The acquisition log recorded metadata → launch → failure about 1.5s after
  launch, before source selection. The old log omitted the action/error, so the
  exact original exception cannot be reconstructed with certainty.
- The previously verified fresh episode-1 export still contained **2,610 comments**
  but had not been registered in current automatic provenance. Only episodes
  6 and 7 were eligible for automatic reuse.

## Fix

- Replace fixed 900ms launch sleep with bounded process/window-readiness polling.
  Recheck before `prepare`; retry transient window creation/destruction races.
  Multiple-window ambiguity and permission/layout errors stop safely. Episode
  and download clicks are never blindly repeated.
- Log only safe stage, action and error category (e.g. `UI_WINDOW_NOT_READY`,
  `UI_PERMISSION`), not raw stderr, clipboard contents or AX trees. Phone status
  distinguishes waiting for the official window from selecting a source.
- Refresh the small atomic verified-cache registry while the gateway is running,
  rather than retaining only its initial snapshot. Recheck approved exact
  subject/episode cache when a queued job starts, before opening the official app.
- Checked episode 1 against its private original export: provenance method
  `new-official-client-download-cache`, Bangumi 364450, AGE, episode 1, unchanged
  cache mtime, matching SHA-256 of raw content, and count 2,610. Approved only
  this known verified export; ambiguous Steins;Gate legacy caches remain excluded.
- Initially attached the verified file to the current stream using the existing
  protected cache endpoint, without changing playback or its 71.530s position.

## Verification / deployment

- **133 tests pass**, including slow cold launch, a readiness→prepare window
  race, bounded startup failure, safe diagnostic fields, permission failure
  cleanup, runtime external approval refresh, and exact approved-cache reuse.
- Three real homepage-only official-client cold launches: every trial initially
  reported `windows: 0`, then `windows: 1` on the next readiness poll. All three
  successfully prepared the portrait window and verified client exit afterward.
  No Mac anime playback or downloads were started by these readiness tests.
  This demonstrates the startup race class, not the missing original exception.
- User explicitly approved restarting the gateway and reopening the episode,
  with possible progress repositioning. Stopped the old TV session, checked no
  transfers/resolution/remux preparation, then gracefully restarted only the
  existing launchd gateway. TV 0.6.2 reconnected; no TV reinstall was performed.
- Reopened AGE main-series episode 1 through the normal controller workflow.
  Receiver 0.6.2 reported a playing 24:01 stream; the new stream's comment endpoint
  returned **2,610 comments**, automatic state `loaded`, and source
  `Kazumi 官方缓存 · 莉可丽丝 · 第1集 · 自动加载`. No manual attach was used for
  this post-restart stream, and no official desktop process was launched.

Private comment files, registry and runtime logs are ignored by Git. No API keys,
certificates, credentials, official binary modifications or network interception
are part of this repair.
