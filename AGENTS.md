# Danmaku quota policy

The user's official 弹弹play API has a daily quota. Do not call any live danmaku
service for tests, benchmarks, debugging, or post-deployment verification. This
includes searches, episode metadata, downloads, and indirect requests through
the production Mac server or a temporary worker. Do not load real `.env`/account
credentials for tests. Use injected mocks, synthetic fixtures, or an existing
local comment file instead. Do not restore `--live` or source-comparison fetching
unless the user explicitly reauthorizes that particular quota-consuming check.

Normal user playback may fetch comments. Daily video-source audits must remain
video-only and must not prefetch or request comments. Production health/status
checks may read local state only, never trigger upstream danmaku operations.

Run tests with `npm test`, which preloads a network guard. Maintain the test-context
credential/client/worker guards as well; do not weaken them to make a test pass.
Never print, commit, or send application secrets to frontends or other services.
