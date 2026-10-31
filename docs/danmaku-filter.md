# Danmaku moderation policy v2

This is a personal POC's local, deterministic backend filter, **not semantic AI
moderation**. It does not fetch lists/models, send comments to an external
moderation service, change video playback, or reuse Kazumi credentials. Every
source still goes through the single `createDanmaku().put()` sink.

## Design

1. Normalize a matching-only copy: Unicode compatibility/combining characters,
   invisible formatting characters, relevant Traditional Chinese characters,
   selected mixed-Latin lookalikes and elongated Latin letters. Keep the original
   allowed comment unchanged. Chinese matching ignores separators; Latin matching
   has word boundaries, bounded separators/repetitions and common leetspeak.
2. Apply custom literal blocks first. They cannot be overridden by exceptions.
3. Check named category-specific rules: explicit content, harassment, misogyny,
   direct insults and personal attacks. Ambiguous words require context rather
   than indiscriminate fuzzy matching of every homophone or identity term.
4. Consider narrow exceptions **at each matched span**. Direct negation,
   prohibiting name-calling, discussion about an insulting word, medical context
   and literal animal references can spare that occurrence. Neither quotes alone
   nor generic words such as “科普”, “不要” or “女性权益” exempt a whole row.
5. Continue checking other spans/rules. Remove the entire row on the first
   non-exempt hit. An entirely removed episode remains a successful empty result.

`inspect(text)` provides `{blocked, category, ruleId, reason}` for local debugging;
it does not include the matched or original text. Delivery returns category counts
only. There is no blocked-text log or persistent moderation decision cache.
An episode-local map avoids reclassifying identical strings while counting every
row. This also avoids stale decisions after policy changes.

## Profiles and examples

Default `balanced` retains casual expressions like “卧槽, 这么功利” and “holy shit”.
They do not alone constitute harassment. It still blocks “你他妈有病”, sexual
solicitation, explicit sexual words and misogynistic insults. `strict` also blocks
standalone casual profanity; contextual exceptions still apply.

| Retained | Blocked |
| --- | --- |
| 这集作画真垃圾 | 你就是垃圾 |
| 母猪产后护理 | 她是母猪 |
| 科普阴道 | 奶子 |
| 不要叫她婊子 | 不要叫她婊子，你这个傻逼 |
| 她不是婊子 | 你不是傻逼谁是 |
| 她是公交车司机 | 她就是个公交车 |
| USB / SBS / SB表示某人 | n.m.s.l / b1tch / bіtch |

Configure the ignored `server/settings.local.json`, then restart the backend:

```json
{
  "danmakuFilter": {
    "profile": "balanced",
    "extraBlockedWords": []
  }
}
```

Merge this property into existing settings; do not replace private account/server
settings. The TV/phone cannot disable or relax the policy. No widget install is
needed. Already delivered comments are not retroactively changed; reload the
episode after deployment.

## Reproducible checks

```sh
npm test
npm run benchmark:danmaku -- --baseline 05d68dd
npm run benchmark:danmaku -- --live --baseline 05d68dd
```

The offline command uses hand-authored Chinese/English minimal pairs, not a
representative sample or a held-out public benchmark. Cases were developed with
the rules, so **do not interpret the results as production precision/recall**.
Separate tests cover separator/Unicode variations, strict policy, rule explanations,
multiple abusive spans, duplicate counts, source imports, all-blocked acquisition,
and actual phone/TV HTTP delivery.

On 2026-10-31, the 203 hand-authored cases contained 93 allowed and 110 blocked
rows. v1 (`05d68dd`) misclassified 53 allowed and 14 blocked rows; v2 passed these
regressions. These numbers describe this small policy-specific fixture only.

The same day's read-only online Lycoris Recoil episode-1 acquisition returned
4,309 rows, of which the existing parser accepted 4,308. v1 blocked 3; balanced v2
blocked 2 (one explicit-content row and one targeted insult), retaining the casual
“卧槽” row. This does **not** establish that the other 4,306 rows are harmless;
no complete independent human labeling was performed.

On this Mac, v2's live-data first pass took about 0.179 s, with a 20-run warmed
median of 0.039 s (v1: 0.155 s and 0.018 s respectively). Acquisition took 3.56 s.
These are indicative wall-clock measurements, not performance guarantees; the
first pass includes regex warmup, and network time is separate.

## Limits and future options

Novel slang, all-foreign-script lookalikes, character substitutions outside the
curated set, sarcasm and anime dialogue without narrative context can still be
missed or overblocked. Medical/counterspeech heuristics are deliberately narrow
but not adversarially foolproof. Do not automatically learn exceptions from
untrusted comments, use a blanket negation/quote whitelist, or aggressively
expand every Chinese homophone: that makes false positives or bypasses worse.

The next useful improvement is user-reviewed minimal pairs from actual errors,
kept separately from development cases to measure regressions honestly. If that
is insufficient, an opt-in **locally evaluated** Chinese contextual model could
adjudicate ambiguous cases. It should first be tested for anime-domain accuracy,
latency, license, and bias. This change does not silently install a model, add
an external API/fee, or claim that a model automatically solves ambiguity.

Research informing the separation of toxic types and treatment of context:

- [Lu et al., ACL 2023: fine-grained Chinese toxicity](https://aclanthology.org/2023.acl-long.898/)
  distinguishes direct/indirect toxicity and proposes a fine-grained taxonomy.
- [Pavlopoulos et al., ACL 2020: context and toxicity judgments](https://aclanthology.org/2020.acl-main.396/)
  finds context can change judgments, but adding context did not automatically
  improve the classifiers tested. These papers motivate evaluation, not a claim
  that this local rule implementation reproduces their models or results.
