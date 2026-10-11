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

Each episode gets a fresh original `VideoWebviewAppleImpl`, preventing one rule's
legacy-parser setting from leaking into another. Search uses original request
cancellation; video jobs are bounded and serial. The gateway probes the actual
stream/first HLS segment before publishing a playable selection, without encoding.

No upstream source is patched. Desktop playback/UI and TV danmaku overlays are
not part of this worker's current capabilities. Native browser subrequests follow
Kazumi's macOS networking behavior rather than the legacy Node DNS-pinned router.

Source and license: https://github.com/Predidit/Kazumi/tree/4e821e48282d0e8e3753fd6266bb1d15e4dc0f02
