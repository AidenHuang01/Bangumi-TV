# Kazumi core worker

This GPL-3.0 adapter executes the original Kazumi Dart rule engine and macOS
WKWebView video parser. The dependency is an unmodified, pinned upstream source
checkout under `../.tools/Kazumi-reference`, provisioned by `npm run setup:kazumi`.
The upstream version/revision is also checked by the gateway before it starts.

Private HTTP protocol: authenticated `GET /health`, `POST /search` (provider/query),
`POST /chapters` (provider/source), `POST /resolve` (provider/url). Responses are
server-only: URLs/cookies must not be forwarded to the phone or TV. Gateway
selection IDs and `/stream/` URLs replace these values in public responses.

The gateway supplies a random `BANGUMI_CORE_TOKEN`, `BANGUMI_CORE_PORT` and the
vetted rule snapshot in `BANGUMI_CORE_RULES`. There is no unauthenticated standalone
mode. Native plugin calls require a real Flutter macOS application/event loop;
this is not a pure-Dart HTTP daemon. Its small status window is not a video player.

Danmaku uses the original upstream `DanmakuApi` and `DanmakuEntry` through private
`POST /danmaku/search` (`anime`), `/danmaku/episodes` (`animeId`) and
`/danmaku/comments` (`episodeId`). `/health` advertises `danmaku.configured` without
revealing keys. These routes require the same worker token, validate inputs, limit
concurrency and redact upstream errors. The Node gateway normalizes comments for
the existing TV/phone clock-driven overlays; video is not screen-captured.

Official Kazumi release credentials are **not in the source checkout**. Rebuilding
or adding a bridge does not inherit them. `npm run setup:kazumi` optionally reads
your own `server/settings.local.json` (`dandan.appId` / `dandan.appSecret`) or
`DANDAN_APP_ID` / `DANDAN_APP_SECRET` and injects them into the Mac build via a
private temporary `--dart-define-from-file`, deleted even if compilation fails.
These credentials remain embedded in that Mac binary: do not distribute it.
Without credentials the bridge reports 503 instead of attempting anonymous API
requests. This is **not** an interface into an already-installed official app.

For a no-key data path, import the official app's downloaded-episode
`danmaku.json` using the phone's Danmaku panel. Both the `{danDanBangumiID,
danmakus: [{m,p}]}` wrapper and legacy arrays work. Creating this cache in Kazumi
belongs to its download workflow, not guaranteed streaming playback. No automatic
cache watcher or desktop-app remote control is provided here.

Each episode gets a fresh original `VideoWebviewAppleImpl`, preventing one rule's
legacy-parser setting from leaking into another. Search uses original request
cancellation; video jobs are bounded and serial. The gateway probes the actual
stream/first HLS segment before publishing a playable selection, without encoding.

No upstream source is patched; the adapter adds the private bridge around its API.
Desktop playback/UI are not part of this worker. Native browser subrequests follow
Kazumi's macOS networking behavior rather than the legacy Node DNS-pinned router.

Source and license: https://github.com/Predidit/Kazumi/tree/4e821e48282d0e8e3753fd6266bb1d15e4dc0f02
