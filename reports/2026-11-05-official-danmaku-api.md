# Official 弹弹play application integration — 2026-11-05

Personal, non-commercial Bangumi-TV POC verification. No credentials, signed CDN
URLs, raw comment dumps or account identifiers are included in this report.

## Changes

- Read only application credential keys from the ignored root `.env`; no shell
  evaluation, global environment mutation or TV/phone bundle injection.
- Search/metadata prefer the fixed official HTTPS API with AppId/timestamp/path
  signatures. Normal read-only comments do not require user OAuth/callback login.
- Preserve the existing authorized NipaPlay account as catalogue failure fallback
  and related-source enrichment. Application and account results do **not**
  necessarily include the same association links.
- For the same exact episode ID, request both comment paths concurrently, merge
  native rows and associated Bahamut links, fetch each numeric Bahamut ID once,
  retain timing shifts and the existing exact-time deduplication. Either path
  can fail independently without discarding usable comments from the other.
- Secrets/signatures never go to redirected CDN requests; unsafe redirects,
  unbounded bodies and reflected upstream credential errors are rejected.
- Phone/TV protocol, moderation, source resolution and playback are unchanged.

## Live, isolated comparison

Application authentication succeeded (HTTP 200 / success true). Separate workers
on ports 9322 and 9323 compared legacy aggregation with official-plus-enrichment
at the same time. No production TV commands were sent. Counts below are valid
parsed rows, before local moderation.

| First episode | Legacy | Official + enrichment | Missing old rows | Additional rows | Acquisition seconds, legacy / new |
| --- | ---: | ---: | ---: | ---: | --- |
| Lycoris Recoil / 莉可丽丝 | 4,308 | 4,308 | 0 | 0 | 4.00 / 3.81 |
| FX战士久留美 | 3,049 | 3,049 | 0 | 0 | 2.39 / 3.00 |

Comparisons use time, mode, color and original text, not just equal totals.
After the unchanged v2 moderation policy: Lycoris retained 4,306 (2 blocked),
FX retained 3,047 (2 blocked). A single invalid Lycoris row was excluded by the
existing parser (4,309 upstream rows → 4,308 valid rows).

Separate native-response checks returned 2,610 Lycoris rows and 2,806 FX rows.
The application responses in these checks had no Bahamut URLs, while the account
FX response included an associated Bahamut video. Hence native-only replacement
would lose comments; account enrichment is deliberately retained.

FX's 3,049 total is lower than the earlier 2026-10-31 snapshot of 4,226. Both old
and new routes returned the same current set, so this difference is not a loss
introduced by this integration. The historical upstream/source difference was
not independently established; do not claim full coverage or invent its cause.
Counts and latency are snapshots, not service-level or completeness guarantees.

## Verification

- 181 automated tests passed, including credential parsing/precedence, signature
  calculation, no OAuth/no CDN credential forwarding, redirect/size/business error
  handling, combined native/related results, channel failures and old TV/phone tests.
- Root `.env` remains git-ignored/untracked and was restricted to mode 600.
- Reproduce selectively: `npm run benchmark:danmaku-sources`. This uses two
  user-selected representative episodes, not scheduled crawling or quota bypass.
- Official usage/limits: [API guide](https://doc.dandanplay.com/open/),
  [permissions and quota announcements](https://doc.dandanplay.com/open/changelog.html).
