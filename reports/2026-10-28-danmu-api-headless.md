# Headless danmu_api integration — 2026-10-28

## Scope

Fetch episode comments after selection and deliver them to our existing Samsung
TV overlay. The Mac does not open Kazumi's desktop player or download a video for
comments. Video resolution/proxying stays on the original Kazumi-core path.

## Upstream and runtime

- Repository: https://github.com/huangxd-/danmu_api
- Pinned commit: `4d325e096bbbf0c1ff261a9bfa638f7c58784f60` (upstream reports 1.21.7).
- Source and original license retained in ignored `.tools/danmu-api`.
- Worker imports upstream `handleRequest`; binds only `127.0.0.1:9321`.
- Random per-start private token, four read-only API route families only.
- No public upstream UI, admin API, proxy listener, hosted fallback or dandan source.
- TLS verification remains enabled; dependencies installed with scripts disabled.
- No external API key, login cookie or official Kazumi credential used in these tests.

## Real anonymous comment acquisition

| Series | Episode | Source returned | Parsed comments |
| --- | --- | --- | ---: |
| 葬送的芙莉莲 | 8 | bahamut | 2,880 |
| 命运石之门 | 1 | animeko | 40 |
| 死亡笔记 | 1 | animeko | 175 |
| BanG Dream! Ave Mujica | 1 | bahamut | 2,477 |

Counts reflect the actual anonymous response, not full-coverage guarantees.
Bilibili's anonymous WBI search reported an account-not-logged-in error in this
environment; the other configured sources above worked. No account was accessed.

## Integration and safeguards

- Phone Play on TV starts comment prefetch in parallel with video resolution.
- Authenticated TV playback reports activate asynchronous delivery to its existing
  `/api/danmaku/{streamId}` route; no desktop UI acquisition is wired in.
- Exact title/alias and unique episode matching; multiple release years require
  manual confirmation. Complete episode lists are used, not truncated search lists.
- Wrong season, specials, stale stream changes and disabled comments are guarded.
- In-flight requests are shared across selection prefetch and playback subscribers;
  aborting one subscriber does not abort another active subscriber.
- Six-hour gateway-memory comment cache, maximum 30 episodes, shared across video
  sources. Manual search/full-episode selection remains available on the phone.
- Comment failures do not interrupt video. API responses are bounded to 4 MB.

## Verification

- 112 automated tests passed (including provider, prefetch/cancellation, authenticated
  TV HTTP comment delivery and old TV tests).
- Production gateway reports `engine: danmu_api`, `configured: true`.
- Loopback listener confirmed with `lsof`; requests without the private token return 401.
- Isolated real HTTP smoke test: authenticated receiver playback report → original
  TV comment endpoint → 2,880 Frieren episode 8 comments, automatic state `loaded`.
  This used a separate loopback gateway and did not replace the actual TV session.
- Existing Samsung receiver reports version 0.5.3 and remains connected. Its comment
  endpoint/renderer protocol is unchanged; this backend integration needs no widget update.
- Phone UI tested via real browser selection of Frieren episode 8. AGE road 1
  failed on an upstream video HTTP 403; road 2 timed out resolving video. These
  failures are independent of comment acquisition. The physical TV overlay has
  not yet been visually verified with a playable video during this test.

These are episode-comment snapshots, not a live comment-posting service. The TV
uses its own playback clock to render them, including pause and seek.
