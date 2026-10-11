# KazumiRules availability audit — 2026-10-10

Tested from this Mac/LAN, using original Kazumi 2.3.8 at upstream commit
`4e821e48282d0e8e3753fd6266bb1d15e4dc0f02`. A fresh shallow clone of
[Predidit/KazumiRules](https://github.com/Predidit/KazumiRules) was still at
`fce5e15a2e6b57500912d41b3f1c65bb3eb7d392`; rules did not change since the
earlier snapshot. The improvement is broader testing and curation, not newer rules.

## Method

Tested all 16 providers in the upstream active `index.json`, not every historical
JSON left in the repository. Four catalogue queries: 葬送的芙莉莲, 命运石之门,
死亡笔记, Ave Mujica. Exact aliases select the original series, excluding sequels,
films and specials (in particular, AGE's first Ave result can be a movie).

All seven providers with usable catalogues then went through actual Kazumi native
parsing, server stream validation and a short video-byte fetch through an isolated
Mac gateway. Up to two roads per title; AGE's previously verified roads were tried
first. ezdmw and xfdmneo received a second run with a four-road bound. Successful
video checks returned 1024 bytes, HTTP 206. No full episode was saved, no legacy
extractor was used, and no Play/Stop/queue commands were sent to the physical TV.

An integration recheck exposed that ezdmw returns episodes in descending order:
the initial raw reports tested entries 38 / 25 / 13, not episode 1. Those reports
are annotated and **superseded for ezdmw** by `2026-10-10-ezdmw-episode1.json`.
The audit and smoke tools now explicitly find episode number 1; a regression test
covers descending lists. Corrected episode-1 probes passed Frieren and Ave Mujica,
and both passed again through the curated staging service's actual public
search/chapter/resolve/stream interfaces. No latest-episode probe is counted as
a first-episode pass in the table below.

This is a four-title **first-episode sample**, not uptime monitoring, an exhaustive
test of every playback road, or confirmation of Samsung codec compatibility.
Every ✓ below means actual gateway video bytes, not merely search/playlist success.

## Results

| Provider | 芙莉莲 | 命运石之门 | 死亡笔记 | Ave Mujica | Selection |
| --- | --- | --- | --- | --- | --- |
| AGE | ✓ HLS road 4 | ✓ HLS road 4 | ✓ HLS road 3 | ✓ HLS road 5 | Primary, 4/4 |
| 7sefun | ✓ MP4 road 2 | ✓ MP4 road 1 | Failed | ✓ MP4 road 1 | Backup, 3/4 |
| ezdmw | ✓ MP4 road 1 | Failed | Failed catalogue | ✓ MP4 road 1 | **New limited backup, 2/4** |
| DM84 | Failed | Failed | ✓ MP4 road 1 | Failed catalogue | Death Note backup, 1/4 |
| moonci | ✓ HLS road 1 | Failed | Failed | Failed | Disabled, 1/4 |
| aafun | ✓ HLS road 1 | Failed | Failed | Failed | Not added; same website as moonci, 1/4 |
| xfdmneo | ✓ HLS road 2 | Failed | Failed | Failed | Not added, 1/4 |
| akianime | Failed catalogue | Failed catalogue | Failed catalogue | Failed catalogue | Not added |
| baimao | Failed catalogue | Failed catalogue | Failed catalogue | Failed catalogue | Not added |
| dalvdm | Failed catalogue | Failed catalogue | Failed catalogue | Failed catalogue | Not added |
| MXdm | Failed catalogue | Failed catalogue | Failed catalogue | Failed catalogue | Disabled |
| sorani | Failed catalogue | Failed catalogue | Failed catalogue | Failed catalogue | Disabled |
| xfdmnext | Failed catalogue | Failed catalogue | Failed catalogue | Failed catalogue | Not added |
| giriGiriLove | Verification required | Verification required | Verification required | Verification required | Not added |
| mgnacg | Verification required | Verification required | Verification required | Verification required | Not added |
| mutefun | Verification required | Verification required | Verification required | Verification required | Not added |

Only AGE was broadly reliable in this sample. No new provider achieved 3/4 or
4/4. ezdmw is the strongest new independent candidate, but should not be presented
as a high-availability primary. Its two successful titles passed on both runs.
xfdmneo's Frieren road 2 also passed twice, but coverage was too narrow to enable.

## Why checks failed

- `play.xfvod.pro` failed strict TLS validation on several moonci/aafun/xfdmneo
  streams. Different catalogue sites can share this same failing video host.
- 7sefun Death Note road 1 failed TLS at `v1.adkwai.com`; road 2 reached a stream
  but the gateway byte request failed to connect to its CDN. It is not a pass.
- DM84 Frieren failed HTTP 403, including an explicit region denial; Steins;Gate
  road 1 timed out in Kazumi and road 2 also denied this region.
- moonci/aafun Ave road 1 returned HTTP 400 at `tjdownload.pan.wo.cn`.
- In the corrected episode-1 run, ezdmw Steins;Gate roads 1 and 4 hit Kazumi's
  45-second limit; roads 2 and 3 did not return playable video. Death Note's
  chapter requests failed in all runs. The earlier extra-road run's chapter
  failure was not treated as proof that all four roads failed.
- xfdmneo Ave road 1 returned no validated video, road 2 failed TLS, and the
  additional road 3 returned HTTP 404 at `dl.playxf.top`.
- Other catalogue failures are generic original-Kazumi request errors. They do
  not establish a specific DNS/TLS/HTML cause without additional diagnostics.
- Three providers explicitly required manual verification. No CAPTCHA, TLS,
  region, login or DRM restriction was bypassed.

## Changes and activation

Added unchanged ezdmw rule fields under the existing MIT attribution. Added
`server/rules/enabled.json`, ranked AGE / 7sefun / ezdmw / DM84. Old rule files
were retained, not deleted. All-source searches are now bounded to six queries
each so two simultaneous searches stay within the native core's 12-query limit.

The curated list was tested on an isolated staging service. The production TV
was online and paused on FX战士久留美 · 第02集; it was not restarted or disturbed.
**The new configuration takes effect on the next production server restart.**
Stop viewing before restarting, since stream/search/queue state is in memory.
No TV reinstall or Kazumi rebuild is needed; refresh the phone afterward.

Automated verification: 58 Node/phone/TV tests passed, including catalogue-title
matching, descending-episode selection and the expanded-provider query budget.

Raw evidence:

- [All 16 catalogues](2026-10-10-rule-catalogue.json)
- [Seven-provider playback probes](2026-10-10-rule-playback.json)
- [Repeat / additional-road probes](2026-10-10-rule-extra-roads.json)
- [Corrected ezdmw episode-1 probes](2026-10-10-ezdmw-episode1.json)

Reproduction tool: `npm run audit:rules`. Source URLs and session cookies are
intentionally absent from the reports. Availability can change with time/network;
only use sources and content you are authorized to access.
