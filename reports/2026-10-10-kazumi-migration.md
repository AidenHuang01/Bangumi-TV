# Real Kazumi core migration verification

Mac: Apple Silicon, Xcode 16.0, project-local Flutter 3.47.6 / CocoaPods 1.16.2.
Kazumi 2.3.8, unmodified upstream commit
`4e821e48282d0e8e3753fd6266bb1d15e4dc0f02`.

The staging gateway was bound to 127.0.0.1:8788. The native Flutter worker was
bound to 127.0.0.1:8789 with a randomly generated server-only token. No commands
were sent to the TV during these checks. `/api/health` reported `engine: kazumi`
and `parser: VideoWebviewAppleImpl`; unauthenticated worker health returned 401.

All following tests used original Kazumi search, chapter and native WebView
extraction, followed by the Mac's stream validation and byte proxy. No legacy
extractor fallback was enabled. These are server-side first-episode checks, not
physical-TV playback tests or guarantees about every episode/source.

| Search / selected title | Provider / road | Episodes per road | First episode proxy |
| --- | --- | --- | --- |
| 葬送的芙莉莲 | AGE / 4 | 28, 28, 28, 28, 28, 28 | HLS, 1024 bytes, HTTP 206 |
| 命运石之门 | AGE / 4 | 26, 26, 25, 25 | HLS, 1024 bytes, HTTP 206 |
| 死亡笔记 / DEATH NOTE | AGE / 3 | 37, 37, 37, 37 | HLS, 1024 bytes, HTTP 206 |
| BanG Dream! Ave Mujica | AGE / 5 | 13, 13, 13, 13, 13, 13, 6 | HLS, 1024 bytes, HTTP 206 |

FFprobe on Frieren's proxied HLS stream confirmed H.264, 1920×1080 and AAC.
No complete episode was downloaded or saved. Movie-vs-series ambiguity matters:
the loose `ave mujica` query's first AGE hit was a theatrical title. The successful
series test selected the exact `BanG Dream! Ave Mujica` title instead.

After the final rebuild, Frieren / AGE / road 4 again passed extraction and the
1024-byte proxy probe. Additional 7sefun testing returned two original-Kazumi
roads (not the old adapter's four); road 2 resolved/probed as MP4, but the separate
client proxy request hit its 20-second timeout. This is **not** counted as a full
pass. An all-provider Frieren search returned results from AGE, DM84, moonci and
7sefun; MXdm and sorani still returned source-request errors. Migration does not
guarantee improved playback for those providers.

Automated verification: 55 Node/phone/TV tests and 3 Flutter tests passed,
including preservation of opaque API source IDs (rather than treating every
source selection as a page URL).
Flutter analysis and release build are required by `npm run setup:kazumi`.
Worker source imports the original modules rather than porting their logic to JS.
GPL-3.0 license and upstream attribution are included in `kazumi-core/`.

Remaining scope: TV danmaku overlays, original desktop UI/player/downloads,
collection sync and exhaustive regression checks across all providers are not
part of this migration. Third-party TLS/region/CAPTCHA/DRM failures are not bypassed.

## Activated service

The old gateway was restarted only after confirming no active transfers, an idle
TV and an empty queue. Production at `http://10.0.0.30:8787` now reports the real
Kazumi backend. The installed 0.3 TV receiver automatically re-registered and
reports online/idle. `/remote/` returns HTTP 200. Frieren / AGE / road 4 also
passed the 1024-byte HLS proxy check on the production port after the switch.
No physical-TV Play command was issued; the user should refresh the phone and
select an episode to confirm actual TV playback.
