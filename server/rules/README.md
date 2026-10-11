# Curated Kazumi rules

Rule JSON contents are from [Predidit/KazumiRules](https://github.com/Predidit/KazumiRules),
commit `fce5e15a2e6b57500912d41b3f1c65bb3eb7d392` (MIT; see LICENSE).

This was still the repository HEAD at the 2026-10-10 check. Snapshots are not
automatically updated. Rule fields are unchanged; file-ending whitespace may differ.

Normal `npm start` runs **the actual Kazumi 2.3.8 Dart search/chapter engine and
native macOS WebView parser**. The independent Node adapter is only the explicit
`npm run start:legacy` fallback; these availability results do not apply to it.

`enabled.json` selects the active providers in recommendation order. On this Mac,
the 2026-10-10 first-episode checks for 葬送的芙莉莲 / 命运石之门 /
死亡笔记 / BanG Dream! Ave Mujica gave:

| Provider | Passed titles | Purpose / tested working roads |
| --- | --- | --- |
| AGE | 4/4 | Primary; roads 4 / 4 / 3 / 5 respectively |
| 7sefun | 3/4 | Backup; roads 2 / 1 / failed / 1 |
| ezdmw (new) | 2/4 | Limited backup; 芙莉莲 and Ave Mujica, road 1 |
| DM84 | 1/4 | Limited backup for 死亡笔记, road 1 |

Only AGE showed high availability across this small sample. `ezdmw` is the best
new independent candidate tested, not a high-availability primary. Its successful
titles passed again in a second run. `xfdmneo` passed only 芙莉莲 and was not
enabled; `aafun` passed only 芙莉莲 and uses the same website as moonci.

Old `moonci`, `MXdm` and `sorani` files are retained for attribution/history but
disabled. moonci passed only 芙莉莲; MXdm and sorani failed catalogue requests.
Other active upstream rules failed requests or required manual verification.
We did not bypass TLS validation, region restrictions or CAPTCHAs.

To add a trusted rule, put its JSON here and add its exact filename stem to
`enabled.json`. Restart the Mac server **when viewing has stopped**; an in-memory
search/stream/queue session does not survive restart. No TV reinstall is needed.
Do not enable untrusted rules or expose this POC to the internet.

Audit details: `../../reports/2026-10-10-rule-availability.md` and the linked JSON
reports. Checks include Kazumi parsing, stream validation and a short byte probe
through an isolated Mac gateway. They do not confirm physical-TV decoding,
every episode, or future/global availability. Only use content you may access.
