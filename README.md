# Bangumi TV — streaming proof of concept

A Samsung TV player connected to a Mac gateway and the **real Kazumi core**.
The TV retrieves original video bytes from the Mac. No screen sharing, casting or
HDMI is involved. The TV and phone apps remain our lightweight clients, not ports
of the entire Kazumi Flutter UI.

```text
kazumi-core/ on Mac (original Kazumi Dart + native WKWebView)
        Search → source → episode → extracted stream
     + configured stream / local file
                  │
         server/ on your Mac
     Original bytes + seeking + HLS proxy
                  │ home network
           tv-app/ on Samsung
      Native AVPlay + remote controls
```

## What this POC proves

- TV-to-Mac connection, browsing a small library, original-quality playback,
  pause/resume, seeking, and basic WebVTT sidecar subtitles.
- Local MP4/M4V/MOV/WebM/MKV files are listed automatically. Whether each codec
  plays is determined by the TV; MP4 with H.264 video and AAC audio is the baseline.
- Configured remote MP4/HLS URLs are fetched by the Mac. HLS playlists, child
  playlists, segments, initialization segments, and AES-128 key URLs are proxied.
- Optional Referer, User-Agent and source-origin cookies stay on the Mac.
- There is no video re-encoding or resolution reduction in the server.

Version **0.4** replaces the independent search/extraction implementation with a
Flutter macOS worker importing Kazumi **2.3.8**, pinned to unmodified upstream
commit `4e821e48282d0e8e3753fd6266bb1d15e4dc0f02`. It directly executes
`Plugin.traceSearch`, `Plugin.traceChapters` / `RuleEngine`, and
`VideoWebviewAppleImpl` with Kazumi's original modern/legacy parser scripts.
This is actual source reuse, not just KazumiRules JSON compatibility.

`server/` retains opaque selection IDs, the phone controller, queue and original
MP4/HLS byte proxy. `tv-app/` still uses Samsung AVPlay. Kazumi's desktop player,
UI, downloads and collection sync are not migrated. Version 0.5 adds our own
clock-synchronized TV/phone danmaku overlay and optional DanDanPlay integration;
changing the engine alone does not make inaccessible providers work.
Kazumi is GPL-3.0; the worker license is included at
`kazumi-core/LICENSE`. Source: <https://github.com/Predidit/Kazumi>.
Rule snapshot attribution remains in `server/rules/README.md`.

## Run on the Mac

Requires Node.js 18+, Apple Silicon macOS, Xcode, and Homebrew Ruby 3+ for the
project-local CocoaPods install. `setup:kazumi` downloads the checksum-verified
Flutter 3.47.6 SDK, checks out the pinned Kazumi source, installs dependencies,
runs core tests and builds the native worker. Tools stay under `.tools/`; nothing
is installed into your global Flutter or CocoaPods configuration. The first build
requires internet and several GB of free disk space.

```sh
cd /Users/yucheng/workspace/bangumi-tv
npm install
npm run setup:kazumi
npm run demo
TV_IP=10.0.0.53 npm start
```

`npm run demo` uses FFmpeg to create a 45-second **1080p, 24 fps, H.264 High
Level 4.1, 8-bit, AAC stereo** test pattern and timed subtitles entirely on the
Mac. FFmpeg is already installed on this computer. The server does not use FFmpeg
during playback; demo generation is the only encoding step.

Open <http://localhost:8787/> on the Mac to test the interface. The server prints
one or more `TV server address` values. On the home network used during initial
setup, the Mac address was **http://10.0.0.30:8787**. Use the current printed home
LAN address if it changes, rather than `localhost` or the VPN/Tailscale address.

Keep the Mac awake while watching. You can start it with `caffeinate -i npm start`
to prevent idle sleep while the server runs. If macOS asks, allow incoming
connections for Node on your home network. Ctrl+C stops the server.

To keep the phone and TV server available after a Terminal or Codex session ends,
run `npm run service:install` once. This installs a user-level macOS LaunchAgent
that starts the original Kazumi server at login and restarts it if it exits. The
Mac must still be awake, logged in, and connected to the home network. Logs are
written under ignored `server/data/logs/`. Check it with
`launchctl print gui/$(id -u)/dev.forgetech.bangumi-server`; stop and unregister
it with `launchctl bootout gui/$(id -u)/dev.forgetech.bangumi-server`.

Environment options: `PORT` (8787), `HOST` (0.0.0.0), `MEDIA_DIR`, `SOURCES_FILE`,
`ANIME_ENGINE` (`kazumi`, default), `KAZUMI_CORE_PORT` (8789, loopback-only).
`npm start` starts and stops the worker with the gateway. Its separate app/data
container does not use a personal Kazumi installation's history or cookies.
`/api/health` reports `animeBackend.engine`, pinned revision and actual parser.
An unavailable/mismatched core fails explicitly; there is **no silent fallback**.

Explicit rollback: `TV_IP=10.0.0.53 npm run start:legacy`. Only this legacy mode
needs Google Chrome / optional `CHROME_PATH`; it is the old independent Node
adapter, not Kazumi. Rebuilding the Mac backend does not require reinstalling the
existing 0.3 TV widget. Refresh the phone and search again after a server restart;
queues and selection IDs are held in memory.
The server has no user accounts or phone pairing. Controller writes are allowed
on your trusted home network; anyone with access to that network can control
playback. Do not forward its port to the internet or expose it through a tunnel.

## Phone controller and player

TV **0.5.3** requests a TV-compatible stream when selecting episodes. For remote
MP4s, the Mac copies the first video/audio tracks into a complete MPEG-TS HLS VOD
before sending Play to the TV. There is no video/audio re-encoding or resolution
change. This bypasses AVPlay's `PLAYER_ERROR_INVALID_STATE` seeking failure seen
with Lycoris Recoil's original MP4 on the 2019 Samsung TV. Original HLS sources
continue through the existing proxy. The phone's own episode player still uses
the original source; watching the current TV video uses its prepared HLS.

FFmpeg is required on the Mac (`brew install ffmpeg`); `FFMPEG` can override its
executable path. Initial MP4 playback downloads/repackages the complete episode
before starting (about 10 seconds for the tested 24-minute episode, dependent on
source speed). Preparation is limited to two minutes, one job at a time, two
cached videos and 2 GiB total. Cache files live under ignored `server/data/tv-hls/`,
are removed on orderly shutdown, and generated sessions older than six hours are
cleaned on the first preparation after a server start. The phone shows preparation separately from
source extraction and TV loading. Unsupported repackaging returns an error;
there is no automatic lossy transcode. Embedded optional text subtitle tracks
are not carried into MPEG-TS; sidecar subtitles and danmaku remain separate.

The seek watchdog/fallback avoids concurrent AVPlay calls during an async jump,
checks its returned position and reports nonfatal failures. HLS seeks can land
a few seconds from the target at the source's existing keyframes. The Mac sends
the measured segment length as the seek tolerance; unchanged positions still
fail validation. Physical-TV
testing is still necessary for other source/codec combinations. Run
`npm run deploy:tv` to sign, install and launch on the configured TV. Enter author
and distributor certificate passwords only in Terminal if Tizen requests them.

Open **http://10.0.0.30:8787/remote/** on your phone, on the same home Wi-Fi.

Use **电视遥控 / 手机播放器** at the top to choose the playback target. In phone
mode, selecting an episode resolves it on the Mac and plays the original stream
in the phone browser, even with the TV offline. **在手机继续当前视频** opens the
TV's current stream at its last reported position without stopping the TV.
Switching back to remote mode pauses phone playback. Queue actions still target
the TV. Safari uses native HLS; other compatible browsers use pinned, locally
served hls.js 1.7.3 (https://github.com/video-dev/hls.js). No third-party player CDN
is required. Some phone browsers require tapping Play after resolution. Container
and codec support still depend on the phone browser. Danmaku settings/imports
apply to the video selected in the current mode.
No login, app installation or pairing is required. The independent `phone-app/`
page defaults to remote mode and fetches video only when phone playback is chosen.

TV **0.6.0** and the phone search page include **最近播放**. They share the ten
most recently played distinct anime, newest first. Starting another episode or
source of the same title moves it to the front and updates its episode label.
Clicking a title searches all sources afresh; it does not autoplay or enqueue.
TV playback is recorded after a playing/paused receiver confirmation, and phone
playback after the browser's playing event. Failed resolutions and queue-only
actions are not recorded. Titles are stored atomically on the Mac in ignored
`server/data/recently-played.json` and survive server restarts; expired stream
URLs and provider credentials are not saved in history. Earlier sessions that
were never recorded cannot be reconstructed automatically.

- Search using the phone keyboard, pick a result, choose a source, then tap
  **Play on TV** or **+ Queue** beside an episode. Play now replaces the TV video.
- **Queue this source** adds its episodes in order (limit: 100 queue entries).
- The Queue tab supports reordering, removal, clearing and **Play next on TV**.
- The queue advances automatically when a remotely started episode finishes.
  Stop/Back does not advance it. Additions alone do not start playback.
- In remote mode, Pause/resume, ±10-second seek and Stop operate the TV.
- TV status and progress update approximately every two seconds. Keep Bangumi
  TV version **0.5.3** open on the TV; browser previews are not TV receivers.

Queues are in memory and clear when the Mac server restarts. Episode selection
data stays on the Mac and is held for the queue's lifetime; streams are resolved
just before playback. Source failures retain the queued episode for retry.
Canceling a lookup invalidates its result, so it cannot unexpectedly start later.
Resolution may still finish its bounded background job before another lookup begins.

For this TV, the Mac server can restrict automatic receiver registration to its
known IP with `TV_IP=10.0.0.53 npm start`. If the TV IP changes, update that setting.
Receiver registration is automatic; its internal session token is not phone pairing.
The installed Samsung widget has its own origin, not the Mac page's origin.
Set `TV_IP` to allow that widget's requests only from the TV's actual IP address;
this exception never applies to phone-controller endpoints or forwarded headers.
Phone writes require JSON from the same origin, and controller requests reject
public hostnames to mitigate cross-site/DNS-rebinding requests. These checks are
not a substitute for a trusted network or authentication.

The phone controller requires TV 0.3 or newer; install the current 0.5.3 update with the same
`BangumiTV` profile and commands in **Install the TV app** below. Version 0.2 does
not yet receive phone commands. No additional Samsung privileges are required.

## Find and play anime

Kazumi performs search and chapter requests with its original network stack and
loads episode pages in its native, sandboxed macOS WKWebView. The adapter passes
the WebView User-Agent, matching URL cookies and configured/page Referer to the
Mac proxy. Complex iframe-specific headers may still need per-provider work.
The private worker listens on 127.0.0.1 and requires a fresh server-only token.
It loads only the server's configured rule snapshot; phone clients cannot submit
arbitrary rules or source URLs. The byte proxy still DNS-checks/pins public
addresses, scopes cookies and verifies TLS. **Native WebView subrequests do not
share the legacy Chromium resolver's complete DNS-pinned request interception**;
use trusted rules and keep this service on your trusted LAN, not the internet.
Do not treat the worker as a browser sandbox for arbitrary untrusted rules.
A search result does not guarantee a working video host; inaccessible or broken
provider streams can still fail.
HLS resolution also checks a child playlist and a small prefix of the first video
segment, rather than treating a reachable playlist as proof of playable video.
Explicit CDN region-denial responses are reported without exposing response
tokens or IP addresses; this POC does not bypass those restrictions.

1. Open **Find anime** in the updated app. The test title is prefilled as
   **葬送的芙莉莲**; it can be replaced with another title.
2. Choose **AGE** (verified through the real Kazumi core) or **All sources**, then
   **Search**. For the initial Frieren test, playback source 4 was successful.
3. Select a result, a playback source and an episode. Resolution can take up to
   45 seconds. Only one video is resolved at a time.
4. The TV receives a Mac `/stream/…` URL and plays it through AVPlay. Source URLs,
   Referer headers and session cookies are not sent in the search/resolve API.
5. Back returns to episodes, then results. Back during resolution cancels TV
   waiting; the bounded Mac job may continue until its deadline.

Provider errors are shown separately from empty results. Rules can go stale;
try another source. CAPTCHA, DRM and login-gated players are not bypassed. Use
only sources and content you are authorized to access. Source quality determines
the available resolution; preserving original bytes does not improve a low-quality source.
Subtitles embedded in the video remain intact. External ASS is not added;
danmaku uses the optional framework described below.

Live opt-in smoke test (requires a running server):

```sh
npm run smoke:anime
# or: npm run smoke:anime -- --title "葬送的芙莉莲" --provider moonci
```

It searches, lists episodes, resolves the first episode, follows proxied HLS
playlists and reads a short video segment probe without saving an episode.
It does not prove physical-TV playback. Resolved selections live only in memory
and expire after six hours; restarting the Mac server requires searching again.

### Curated sources

Phone and TV search cards fetch posters asynchronously from Bangumi metadata,
through a bounded Mac cache. Exact title matching avoids assigning a sequel's
poster to season 1. Missing or failed images use a local placeholder and do not
block searching or playback. Metadata API: https://bangumi.github.io/api/.

`server/rules/enabled.json` now controls the provider list and recommendation
order: AGE, 7sefun, ezdmw, DM84. The 2026-10-10 original-Kazumi audit passed
4/4, 3/4, 2/4 and 1/4 of the four requested first-episode checks respectively.
AGE is the primary; new ezdmw is only a limited backup for Frieren and Ave Mujica.
See [the full availability report](reports/2026-10-10-rule-availability.md).
Old moonci/MXdm/sorani JSON files are retained but no longer enabled by default.

To add a trusted KazumiRules JSON, put it in `server/rules/` and add its filename
stem to `enabled.json`, then restart the Mac server when playback has stopped.
Rules are fixed snapshots; no TV reinstall is needed, but refresh the phone and
reopen TV search to load the new provider list. Rules do not provide danmaku;
that uses the separate framework below.

Re-run the opt-in upstream audit on isolated ports (no TV Play commands):

```sh
# Clone this reference only if it is not already present.
git clone --depth 1 https://github.com/Predidit/KazumiRules.git .tools/KazumiRules-availability
npm run audit:rules -- --catalog-only
npm run audit:rules -- --providers AGE,7sefun,ezdmw,DM84 --report reports/rules-playback.json
```

The audit imports the upstream active index, uses an independent native Kazumi
worker on 8790 and a loopback gateway on 8788, and saves only metadata/outcomes,
not source URLs or cookies. Its default limit is two playback roads per title;
`--max-roads 4` can expand that bound. Failures do not prove every other road
is unusable. Use `--core-port` / `--port` if these ports are occupied.

## Add an actual video

### Danmaku framework

TV playback has a clock-driven overlay supporting scrolling, top and bottom
comments. Pause and seek use the video clock. Open **Danmaku / 弹幕** on the phone
to toggle it, set a ±600-second offset, or import Bilibili XML / Dandan JSON
or an official Kazumi downloaded-episode `danmaku.json` cache (wrapper or array)
for the current episode. Imports stay in Mac memory and clear on restart.
Text is rendered as text, never executable HTML; imports are limited to 4 MB.

The native core exposes Kazumi's original `DanmakuApi` through authenticated
loopback endpoints. When built with credentials, the gateway uses that module for
show search, full episode lists and comments; the TV renders comments using its
own playback clock. Search requires selecting a show and then an episode, avoiding
the search API's potentially truncated episode lists.

**Open source does not include Kazumi's official-release API credentials.** Adding
this bridge or rebuilding Kazumi does not automatically enable online comments.
Online access uses 弹弹play开放弹幕网络 (https://www.dandanplay.com/). When your own
credentials are ready, copy the structure of `server/settings.example.json` into
`server/settings.local.json`, fill `dandan.appId` and `dandan.appSecret`, then
run `npm run setup:kazumi` and restart the server to activate the native bridge.
This local file is ignored by Git. Alternatively set
`DANDAN_APP_ID` and `DANDAN_APP_SECRET` in the server environment. Keys are never
sent to the phone or TV. The phone's online search lets you explicitly select
the matching show/episode before loading comments. Without keys, local imports
and rendering work; online search remains disabled. Real authenticated API
verification awaits those credentials. Without a rebuild, server-only credentials
can still use the existing direct API adapter. The bridge is not a remote control
interface into an already-installed official Kazumi app. No automatic cache
watcher is installed. See https://doc.dandanplay.com/open/.

### Daily source reports

`npm run audit:daily` checks **each enabled source against ten fixed titles**, using
episode 1 and at most two playback roads per title. It uses a separate original
Kazumi worker (8792) and loopback gateway (8785); it never sends TV commands.
Reports update atomically under ignored `server/data/reports/`, contain stage/
error/timing/byte-probe results, and are visible on the phone's **源测试** tab.
A failed catalogue lookup counts as a failed title check, not a successful stream.
An interrupted run is marked failed and remains inspectable. Runs cannot overlap.

`npm run schedule:install` installs the macOS user LaunchAgent
`dev.forgetech.bangumi-source-audit` at **05:00 America/Los_Angeles**. The installer
checks the Mac time zone. The user must be logged in; if the Mac sleeps at 05:00,
launchd runs the missed job on wake. Caffeinate keeps it awake during the audit.
The server must be running to read reports from the phone, but audits run without
the production server. Logs are in `server/data/logs/`. To disable the schedule:
`launchctl bootout gui/$(id -u)/dev.forgetech.bangumi-source-audit`.

Place a video in `server/media/` and select **Refresh** in the app. Files are
served directly with byte-range support for seeking. Place a `.vtt` file with the
same basename alongside it for subtitles: `Episode.mp4` and `Episode.vtt`.
The POC scans this folder only, not your other personal files.

For a resolved remote media URL, create `server/sources.json` using
[server/sources.example.json](server/sources.example.json) as a template:

```json
{
  "sources": [
    {
      "id": "episode-1",
      "title": "Episode 1",
      "url": "https://your-source.example/path/master.m3u8",
      "format": "hls",
      "referer": "https://your-source.example/",
      "userAgent": "Mozilla/5.0"
    }
  ]
}
```

Use `"format": "mp4"` for a direct MP4 URL. `cookie` is optional and is sent only
to the original source's origin, not unrelated CDN hosts. Set `enabled` to `false`
to hide an entry. Configuration is reloaded per request; no restart is needed.
Upstream URLs must be public HTTP(S) addresses. Expired URLs, DRM and sources
requiring browser sessions can still fail. Manually configured URLs are not
auto-refreshed; anime selections are resolved anew when an episode is chosen.

## Install the TV app

`tv-app/` is a packaged Tizen web application. Its HTML/CSS/JS runs inside an
installed TV app using **Samsung AVPlay**, rather than a browser tab. The same
UI also has an HTML5 video fallback for Mac browser preview. Browser preview is
not a substitute for testing AVPlay on your actual TV.

There are two stages: packaging and Samsung signing/installation.
**`dist/BangumiTV-unsigned.wgt` is an unsigned preview archive and cannot be
installed on a retail TV as-is.**

1. Install [Tizen Studio and the Samsung TV SDK extension](https://developer.samsung.com/smarttv/develop/tools/tizen-studio.html).
   Add its `tools/ide/bin` and `tools` directories to PATH so `tizen` and `sdb` work.
2. On the TV, open **Apps**, enter **12345**, enable Developer Mode and enter the
   Mac's home LAN IP (currently `10.0.0.30`, without the port). Restart the TV as
   instructed. Menu details depend on the TV model.
3. Follow [Samsung's device connection instructions](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html)
   to connect using Device Manager or `sdb connect YOUR_TV_IP`.
4. Use [Certificate Manager](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html)
   to create a Samsung **TV** certificate profile that includes this TV's DUID.
   In Device Manager, right-click the TV and select **Permit to install applications**.
   Certificate/account interactions must be completed by you.
5. Package and sign, substituting your profile name and current Mac address:

   ```sh
   npm run package:tv -- --server http://10.0.0.30:8787 --profile YOUR_SAMSUNG_PROFILE
   sdb devices
   tizen install -n BangumiTV.wgt -t YOUR_TV_DEVICE_NAME -- dist
   tizen run -p BgmiTVpoc1.BangumiTV -t YOUR_TV_DEVICE_NAME
   ```

   The packaging script creates `dist/BangumiTV.wgt` with a space-free filename.
   On this 2019 TV, an archive filename containing spaces failed installation;
   the same signed archive installed successfully after renaming it.
   `--server` pre-fills the Mac address; it can still be changed in the app.

   If the developer connection fails from an automated shell on macOS, run
   `sdb connect YOUR_TV_IP` in the regular Terminal app. Leave that SDB server
   running: subsequent commands can reuse its connection. If signing asks for
   certificate passwords, run the package command in Terminal and enter them
   privately at the prompts, not as command-line arguments.

Alternatively, import `tv-app/` as an existing Tizen project in Tizen Studio,
select your Samsung certificate profile, and choose **Run As → Tizen Web Application**.

Open **Bangumi TV POC** from the TV Apps screen. In **Server settings**, enter the
Mac's address, select **Connect & open library**, and play **Playback test**.
The address is remembered on this TV. Signing, installation and launch were
verified on Samsung UN65RU7100FXZA (Tizen 5.0) at `10.0.0.53`, using the
`BangumiTV` certificate profile and Mac server `http://10.0.0.30:8787`.
The user confirmed demo-video playback on the physical TV. Version 0.2 was
signed, installed and launched successfully on the same TV; its device API
reported version 0.2.0, running and visible. Physical-TV anime playback still
needs confirmation separately.
Version 0.3 adds the phone receiver and needs its own signing/reinstallation.

Live Mac verification on 2026-10-09: **葬送的芙莉莲**, moonci, two sources with
28 episodes each; episode 1 resolved and its proxied playlist/segment passed.
FFprobe read the stream through our proxy and identified **1920×1080 H.264 video,
AAC audio, approximately 26 minutes**. This is a moment-in-time source check,
not a guarantee of future availability or successful decoding on the TV.
The old independent-adapter test of **7sefun Source 4** is superseded by the
2026-10-10 original-Kazumi audit: Frieren has two roads, and **road 2** passed
as MP4 through the Mac proxy. Do not use old adapter road numbers with the
current core. **akianime** remains disabled after failed catalogue requests.
The proxy preserves `.m3u8` playlist paths for
[Samsung's HLS engine detection](https://developer.samsung.com/smarttv/develop/guides/multimedia/adaptive-streaming.html).

For this already-configured TV, update in Terminal (certificate passwords stay private):

```sh
cd /Users/yucheng/workspace/bangumi-tv
PATH="/Users/yucheng/tizen-studio/tools/ide/bin:$PATH" npm run package:tv -- --server http://10.0.0.30:8787 --profile BangumiTV
/Users/yucheng/tizen-studio/tools/ide/bin/tizen install -s 10.0.0.53:26101 -n BangumiTV.wgt -- /Users/yucheng/workspace/bangumi-tv/dist
/Users/yucheng/tizen-studio/tools/ide/bin/tizen run -s 10.0.0.53:26101 -p BgmiTVpoc1.BangumiTV
```

Keep the existing SDB daemon running. If disconnected, reconnect with
`/Users/yucheng/tizen-studio/tools/sdb connect 10.0.0.53` in your Terminal first.

## Test checklist

1. Video plays with sound and fills the display without cropping.
2. Pause and resume work. Seek forward/back by 10 seconds while paused and playing.
3. Test subtitles appear at 0–8, 12–22 and 30–40 seconds. Toggle subtitles off/on.
4. Back returns to the library. Restart the app and confirm the server is remembered.
5. Add a real episode, refresh and repeat. Run a longer episode to assess buffering.

Controls: D-pad to browse, OK to select, Back to return. During playback the HUD
auto-hides after 4.5 seconds. With it hidden, Left/Right seek, OK toggles playback,
and Down reveals the controls. Dedicated media keys work when the remote has them.
Desktop preview: arrow keys, Enter, Space and Escape.

## Verification and limits

Run `npm test` for discovery, HTTP/range/HLS proxy, TV search-flow and simulated
AVPlay lifecycle tests. Unit/integration tests use fixtures, not live providers.
The simulation checks state handling; only your physical TV can verify codecs,
Samsung signatures, AVPlay rendering and home-network performance.

No full Kazumi runtime, transcoding, Anime4K upscaling, ASS styling, playback
history, user accounts or DRM support. WebVTT subtitles are a basic text overlay.
HLS variable substitution is rejected explicitly. Older TV web browsers may have
limited HLS support; the installed app is intended to use AVPlay instead.

## Structure

```text
server/                 Mac service, source configuration, control state and local media
  app.mjs               HTTP API, library, media serving and HLS proxy
  lib/                  Rule engine, resolver, ranges, HLS and upstream fetching
  rules/                Curated MIT KazumiRules snapshot and license
  tools/smoke-anime.mjs  Opt-in real-source, short segment test
  tools/make-demo.mjs    Locally generated test video and subtitles
  test/                 Server integration tests
tv-app/                 Independent TV application; no server code in package
  config.xml            Samsung/Tizen manifest and permissions
  app.js                AVPlay, HTML5 fallback, subtitles and remote controls
  test/                 Simulated native player tests; excluded from package
phone-app/              Local mobile remote/player, search, queue and reports
  test/                 Remote controls and phone playback lifecycle tests
scripts/                Packaging/signing helper and launcher icon generator
dist/                   Generated app payload and widget archive
```

`GET /api/providers`, `GET /api/search?q=…&provider=…`, `GET /api/shows/:id` and
`GET /api/resolve/:episodeId` implement discovery. IDs are issued by this server;
clients cannot submit arbitrary URLs to the resolver. Browser requests and
streams use a DNS-pinned public-address-only transport, blocking private-LAN access.

`GET /api/controller/state` reports TV/queue state and
`POST /api/controller/action` changes playback/queue. The native TV app uses
`POST /api/tv/register` and `POST /api/tv/poll` to receive sequenced commands and
report playback. Only TV completion events advance the queue, not phone refreshes.

`GET /api/health` reports server state, `GET /api/library` lists videos,
`GET|HEAD /stream/:id` serves video and `GET /subtitles/:id.vtt` serves sidecars.
Source URLs, headers and filesystem paths are not included in library or
discovery responses. HLS references are signed encoded URLs (not encryption);
do not share playlist references outside your trusted LAN.
# Forge-TV
