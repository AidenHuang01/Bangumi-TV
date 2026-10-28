# Official Kazumi app → comment cache → TV gateway

## Result

A real no-gateway-API-key data path is now implemented. The official macOS app
retrieves comments using its normal behavior; our server reads only its generated
`danmaku.json` and supplies normalized comments to the existing TV/phone overlay.
This does not use the native source-build API bridge added previously.

## Actual verification, 2026-10-28

- Downloaded the official 2.4.2 DMG from
  https://github.com/Predidit/Kazumi/releases/tag/2.4.2 and verified SHA-256
  `325b52d2f1b84a482c95dac1f1396daba9d106f2ae4eada19677b15c14cf39a7`.
  The original app is under `.tools/official-kazumi-2.4.2/Kazumi.app`; the
  separate source reference is pinned to `7cb58d7d800c8de46b9a36ec4ae97cd6a3f9602b`.
  Neither the app nor its comment data is committed.
- The user authorized accepting the first-use agreement and changing the app's
  metadata connection from its failing mirror to the official direct endpoint,
  plus enabling 下载设置 → 缓存弹幕. No system proxy, certificates, TLS checks or
  macOS protections were changed.
- Frieren search and metadata worked. AGE/TvTFun attempts did not establish
  playback in that session; moonci explicitly reached a parser-timeout screen.
- The desktop session subsequently played a video titled `命运石之门0 [第01话]`.
  Turning on danmaku visibly showed many comments. Its parent Bangumi selection
  was `命运石之门` (10380), so **source title / series association can differ**;
  this does not verify correct-season matching.
- Using the official app's episode download UI produced
  `downloads/10380_AGE/1/danmaku.json`: 143,101 bytes and 2,172 comments, all 2,172
  accepted by our existing parser. No API credentials were entered/extracted.
- A temporary HTTP gateway read that **real file**, attached it to a test stream,
  and returned all 2,172 comments from the TV's `/api/danmaku/...` endpoint while
  `configured` remained false. This was endpoint verification, not physical-TV
  playback; the real TV was offline and no TV Play command was issued.
- 90 Node/phone/TV tests passed, covering file selection, symlink/size/path guards,
  metadata fallback boundaries, origin checks and phone-to-overlay delivery.
- The production server was gracefully restarted after checking the TV was
  offline, no transfers were active and no resolution/remux was running.
  The new cache endpoint listed the real cache. The actual Chrome remote UI was
  refreshed and visibly listed `命运石之门 · 第1集 · AGE` under the new button.

## How to use

1. In the official Mac Kazumi app, enable 下载设置 → 缓存弹幕, select the correct
   show/season/source and download the desired episode. The comment file can be
   used as soon as it exists; completing the video download is not a requirement.
2. Play the matching episode on the TV (or phone player).
3. Refresh the phone remote, expand 弹幕 and choose
   读取 Mac 上的 Kazumi 弹幕. Verify title/episode, then select that cache.
4. Existing pause/seek handling keeps the overlay on the TV's own clock. Adjust
   the existing offset control if the source has a different intro/edit.

## Limits

This is **download-cache forwarding**, not a live memory hook and not automatic
desktop playback following. Ordinary streaming alone does not necessarily write
comments to disk. There is no secret extraction, HTTPS interception, binary
patching, or anonymous API workaround. The official app still depends on its own
service availability and quotas. A metadata mismatch in Kazumi can cache the wrong
show's comments; manual confirmation is intentional. Our copied comments remain
in server memory until restart; the official cache files are never changed/deleted.

Default discovery is restricted to the official macOS sandbox download directory;
a custom local directory requires the server-side `KAZUMI_CACHE_DIR` environment
setting. Requests from the phone accept opaque cache IDs, not filesystem paths.
Only bounded comment JSON files are read; app binaries/databases/keys are not read.
