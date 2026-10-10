# Bangumi TV — streaming proof of concept

An independent Samsung TV player connected to a Mac server. The TV retrieves actual
video bytes from the Mac. No screen sharing, casting or HDMI is involved.

```text
Kazumi-compatible search → source → episode
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

Version 0.2 adds anime search, source/episode selection and automatic stream
resolution using a snapshot of MIT-licensed KazumiRules. This is an independent
Kazumi-compatible implementation, not the Kazumi Flutter application running as
a server. It supports selected XPath rules and sorani's nested API rule format,
not every Kazumi rule or feature. See `server/rules/README.md` for attribution.

## Run on the Mac

Requires Node.js 18 or newer and Google Chrome on the Mac for dynamic players.
Chrome runs headlessly with a fresh isolated profile, not your personal browser.

```sh
cd /Users/yucheng/workspace/bangumi-tv
npm install
npm run demo
npm start
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

Environment options: `PORT` (8787), `HOST` (0.0.0.0), `MEDIA_DIR`, `SOURCES_FILE`,
`CHROME_PATH` (defaults to the installed macOS Google Chrome executable).
The server has no user accounts or phone pairing. Controller writes are allowed
on your trusted home network; anyone with access to that network can control
playback. Do not forward its port to the internet or expose it through a tunnel.

## Phone controller (version 0.3)

Open **http://10.0.0.30:8787/remote/** on your phone, on the same home Wi-Fi.
No login, app installation or pairing is required. The independent `phone-app/`
page has no video player and never fetches video streams.

- Search using the phone keyboard, pick a result, choose a source, then tap
  **Play on TV** or **+ Queue** beside an episode. Play now replaces the TV video.
- **Queue this source** adds its episodes in order (limit: 100 queue entries).
- The Queue tab supports reordering, removal, clearing and **Play next on TV**.
- The queue advances automatically when a remotely started episode finishes.
  Stop/Back does not advance it. Additions alone do not start playback.
- Pause/resume, ±10-second seek and Stop operate the TV, not the phone.
- TV status and progress update approximately every two seconds. Keep Bangumi
  TV version **0.3.0** open on the TV; browser previews are not TV receivers.

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

The phone controller requires signing/installing the 0.3 TV update with the same
`BangumiTV` profile and commands in **Install the TV app** below. Version 0.2 does
not yet receive phone commands. No additional Samsung privileges are required.

## Find and play anime

The Mac resolver preserves the embedded player's actual request Origin, Referer,
JSON/form content type and scoped session cookies. These also accompany resolved
streams through the proxy. Only allowlisted browser headers are forwarded;
private-network blocking and TLS certificate verification remain enabled.
Resolution errors distinguish parser rejection/decode failures, HTTP errors,
TLS failures and players that never expose a stream. A search result does not
guarantee a working video host; inaccessible or broken provider streams can still fail.
HLS resolution also checks a child playlist and a small prefix of the first video
segment, rather than treating a reachable playlist as proof of playable video.
Explicit CDN region-denial responses are reported without exposing response
tokens or IP addresses; this POC does not bypass those restrictions.

1. Open **Find anime** in the updated app. The test title is prefilled as
   **葬送的芙莉莲**; it can be replaced with another title.
2. Choose **moonci** (verified with this title) or **All sources**, then **Search**.
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
Subtitles embedded in the video remain intact; external ASS/danmaku is not added.

Live opt-in smoke test (requires a running server):

```sh
npm run smoke:anime
# or: npm run smoke:anime -- --title "葬送的芙莉莲" --provider moonci
```

It searches, lists episodes, resolves the first episode, follows proxied HLS
playlists and reads a short video segment probe without saving an episode.
It does not prove physical-TV playback. Resolved selections live only in memory
and expire after six hours; restarting the Mac server requires searching again.

## Add an actual video

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
Additional provider check on 2026-10-09: **7sefun** passed for 葬送的芙莉莲,
episode 1 on **Source 4** (MP4, original bytes through the proxy, HTTP 206) and
was added to the provider list. Source 2 failed with HTTP 404. **akianime** was
not added because its search site failed the TLS connection from this Mac.
Select Source 4 for this 7sefun test; TV codec support still needs confirmation.
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
phone-app/              Local mobile controller, search, queue and transport UI
  test/                 Controller UI tests; no video playback
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
