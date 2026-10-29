# Automatic official Kazumi → TV/phone danmaku bridge

## Implemented

- macOS automatic comments now use the unmodified official Kazumi 2.4.2 app,
  not the sparse first nonempty result from the manual `danmu_api` backup.
- Authenticated TV playback / protected phone playback starts an asynchronous
  job. Video does not wait for comments. The existing TV 0.6.1 comment endpoint
  and renderer remain compatible; no TV package reinstall is needed.
- Public Bangumi metadata provides exact canonical names, aliases (including
  English titles), and release dates. The driver selects an exact-title source
  and only the requested episode in the official download sheet. Ambiguous
  titles/seasons are rejected, not silently replaced with sequels/shorts.
- The known 640×860 portrait layout exposes the download toolbar outside the
  video surface. Fresh Accessibility bounds identify named controls; only the
  verified portrait download icon uses a fixed guarded point. No custom URL
  navigation, private credentials, app modification or interception is used.
- Wait for complete parseable, nonempty JSON from the matching Bangumi ID and
  episode, then return that exact content to the active stream. Quitting does
  not wait for the whole video download. The original window size is restored,
  and the exact official executable is checked for exit. A bounded SIGTERM
  fallback never targets the separate headless native video-discovery core.
- Cancellation, timeout, failure and replacement-episode paths clean up the
  owned official client. A pre-existing user-owned official process is not
  taken over; the phone explains how to retry after exiting it.
- Phone settings describe actual behavior and show acquisition progress. Retry
  replaces an old sparse attachment, while a later manual choice still wins.
- Only current-workflow cache provenance is trusted automatically. v1 provenance
  from the old wide-layout experiment is invalidated because of the known
  Steins;Gate/Steins;Gate 0 mismatch. Cache data remains private and ignored by Git.

## Real verification on 2026-10-29 (America/Los_Angeles)

1. Direct automatic driver test: **Lycoris Recoil episode 6**, Bangumi **364450**,
   AGE main series. Metadata began 13:06:35; new usable comments were detected at
   13:07:33. Obtained **2,784 comments**. The driver then confirmed the official
   process stopped. Approved this exact file/mtime under current provenance.
2. Deployed to the existing macOS launchd gateway after confirming TV idle,
   zero active transfers, no resolution and no remux preparation.
3. In the actual phone remote in Chrome, searched AGE for `Lycoris Recoil`,
   selected the main series (not the short), and clicked **episode 7 → Play on TV**.
   Samsung receiver **0.6.1** reported playing a 24:01 stream. Paused at 11.765s
   during the test; paused playback still keeps comment acquisition active.
4. The production service automatically ran the official UI with no manual
   episode/download clicks: metadata 13:10:59, source selection 13:11:24,
   waiting for file 13:11:52, ready 13:11:54, process stopped 13:11:55.
   New **2,669 comments**, timestamps **0–1441.9 seconds**, attached to
   `anime-dc8b66df2053ae8d224aec7601dc4d98` only.
5. Its existing `/api/danmaku/...` endpoint returned all 2,669 normalized comments,
   source `Kazumi 官方缓存 · 莉可丽丝 · 第7集`, and automatic state `loaded`.
   The actual phone UI visibly displayed `当前视频已加载 2669 条弹幕。` and
   `Paused on TV`. Saved an ignored local screenshot. Physical-TV overlay pixels
   were not captured; endpoint/UI verification is not a claim of visual TV QA.
6. A later read of a stale native-app automation handle reopened Kazumi on its
   homepage, after its verified automatic exit. Closed that inspection-only
   relaunch, restored 1280×860, and verified no official process remained.
   The TV remains paused with its loaded comments; its video was not restarted.
7. **119 tests passed**, including alias/season rejection, partial JSON, cancelled
   serialized jobs, exact-process cleanup, old-provenance rejection, sparse-result
   retry, protected TV → acquisition → comment endpoint delivery, and existing
   phone/TV late-loading, pause/seek and origin/path guards.

## Operational limits

This is a desktop download-cache bridge, not a headless comment-only API. Keep
the Mac desktop logged in and existing `osascript` Accessibility permissions
available. The official window can briefly play video and download video bytes;
the job exits once comments are ready (about a minute in the fresh-episode test).
Partial video cache files may remain; the bridge does not delete official files.
Official source/service availability and the verified UI version still matter.
The amount retrieved is the complete response from that official request, not
a guarantee of every historical comment across all sites.

Refresh the phone remote after updating. For a failed/sparse older attachment,
use **弹幕设置 → 重新获取当前集弹幕**. Verified episodes reload without opening
the official app again. Manual cache selection, imports and `danmu_api` search
remain backups; they are never silently used instead of the official route.
