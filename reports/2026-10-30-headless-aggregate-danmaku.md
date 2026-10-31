# Headless aggregated episode comments — 2026-10-30

## Deployed behavior

- Episode selection prefetches comments while Kazumi-core resolves the video.
- An authorized ordinary DandanPlay account authenticates through NipaPlay's
  fixed HTTPS gateway. No developer AppId/AppSecret is used or extracted.
- The worker fetches the matched episode's native comments and the gateway's
  associated Bahamut video comments, applying the declared timing offsets.
- danmu_api retains its source parsing/formatting pipeline. Grouping is set to
  zero minutes: exact-time duplicate handling is retained without merging a
  whole minute's repeated comments. The TV renderer's existing active limits
  remain unchanged.
- Aggregated dandan candidates take priority over standalone sparse providers.
  Verified Kazumi files are failure-only backups, never cache-first blockers.
- Official Kazumi desktop acquisition defaults to disabled. Neither a Mac
  playback window nor a video download is used, including on online failure.
- Phone copy describes the new flow. The installed TV 0.6.2 HTTP protocol is
  unchanged, so this backend deployment does not require a TV reinstall.

## Live end-to-end acquisition

These are comments accepted by the existing TV parser after formatting and
duplicate handling, not estimates based on the server's reported count.

| Search title | Episode | TV-usable comments | Elapsed | Timestamp range |
| --- | ---: | ---: | ---: | --- |
| 莉可丽丝 | 1 | 4,308 | 4.9 s | 0–1442 s |
| Lycoris Recoil | 6 | 4,336 | 1.7 s | 0–1442 s |
| 葬送的芙莉莲 | 8 | 9,406 | 2.3 s | 0–1469.9 s |

Cold requests include matching, full episode lookup, native CDN download,
associated Bahamut download, and TV-format conversion. Counts and timing can
change with the sources and network. No unrelated seasons/specials were selected.

A separate real HTTP smoke test registered an isolated simulated TV 0.6.2,
reported paused playback, triggered automatic acquisition, and received 4,308
comments with state `loaded` over the normal TV endpoint in 3.4 seconds.
It did not replace the household TV registration or start a video. The physical
TV was offline during deployment; on-screen rendering of this deployment remains
for the next real playback.

## Credentials and transport

- Login/CDN requests preserve TLS certificate validation. There is no plaintext
  gateway backup, system proxy/DNS alteration, or security-wide disable.
- Account auth headers never reach the CDN or Bahamut. CDN redirects are checked
  against HTTPS DandanPlay hosts, fetched immediately, and not cached as URLs.
- Background creation of a macOS Keychain item was refused by the OS. This
  installation therefore uses the supported owner-only private-file store in
  the ignored data directory (directory 700, file 600), not source settings.
- Account credentials go to the worker over stdin, not argv or environment.
  The username-only local settings and credential file are both Git-ignored.
- The three running-service logs and tracked diff were checked for the stored
  password; none contained it. This report contains no account credentials,
  login tokens or signed download URLs.
- Xfinity's per-site Allow Access can expire. If reblocked, online comments may
  fail and require another scoped allow or a provider reclassification; video
  continues and only verified local comments may be used as fallback.

## Verification

All 144 tests passed, including gateway login sharing/renewal/401 recovery,
redirect and response bounds, Bahamut merge/offset/failure handling, credential
storage error sanitization, online-before-cache priority, exact episode matching,
authenticated TV delivery, phone controls, and existing TV playback/seek tests.

The launchd backend was restarted while no transfers/resolution/preparation were
active. Production health now reports `danmaku.engine: danmu_api`, configured
true, and advertises the DandanPlay + Bahamut workflow. Video remains on Kazumi.
