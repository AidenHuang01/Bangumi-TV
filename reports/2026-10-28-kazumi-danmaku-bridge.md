# Kazumi native danmaku bridge — 2026-10-28

The Mac worker now exposes the pinned Kazumi 2.3.8 `DanmakuApi` and comment model
through authenticated, loopback-only search / episode / comment endpoints. This
extends our native adapter; the upstream source checkout remains unmodified.
The gateway uses these endpoints when the native build has credentials, and the
phone selects a show followed by its full episode list. Existing phone/TV overlays
remain synchronized to their own player's clock. No screen sharing or encoding
is introduced, and no TV widget update is needed for this change.

## Verified

- 85 Node/phone/TV tests passed, including HTTP phone-selection → normalized TV
  comment delivery, full episode selection, cache import and secret isolation.
- 7 Flutter tests passed, including native HTTP authentication, explicit missing
  credentials, delegation, input validation, bounded concurrency and redaction.
- Flutter analysis reported no issues; the release macOS app compiled successfully.
- A separately launched release worker on port 18789 advertised `danmaku` and
  `configured: false`; an actual search for `葬送的芙莉莲` returned the expected
  actionable 503 rather than making an anonymous upstream request.
- The production launchd server was gracefully restarted only after confirming
  the TV was offline, active transfers were zero, and no resolution/remux was
  running. Its health now advertises the native danmaku bridge and the phone status
  explicitly reports missing credentials. No playback command was sent to the TV.

## Remaining blocker — not a successful live online-danmaku test

The official Kazumi AppId/secret are injected by its release CI and are not part
of the source checkout. Building modified/open-source code does not inherit the
official installation's credentials. This worker is not controlling that existing
official app, and no credentials were extracted from it. Real online retrieval
still requires credentials authorized for this build, supplied through the local
settings file/environment and `npm run setup:kazumi`. A native build with keys has
not been tested against the real API. Quota/network/episode-match failures remain
possible even after authorization.

The no-key fallback is importing an official Kazumi downloaded-episode
`danmaku.json`: both the `danmakus` wrapper and legacy `{m,p}` arrays normalize to
the TV format. This was verified with fixtures, not by downloading a real episode.
There is no automatic desktop-app cache watcher. Streaming in the official app
does not necessarily create this download cache.

Credential injection uses a mode-0600 temporary Flutter define file and cleans it
on normal completion/failure. Keys are absent from command arguments and Git, but
are embedded in a credentialed Mac binary; that binary must not be distributed.
