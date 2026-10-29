# Smooth TV / phone danmaku animation — TV 0.6.2

## Cause

The former shared renderer directly changed text position only when its caller
sampled video time: the TV's 250ms progress timer (plus native progress events),
and the phone's 100ms timer. It had no independent animation loop. A synthetic
1920px screen / six-character comment moved 65.625px between 250ms updates.
The issue was frontend scheduling, not a reason to re-download comments.

## Changes

- Shared ES5-compatible `requestAnimationFrame` loop, with a bounded fallback.
  Low-frequency media samples discipline a monotonic interpolated clock;
  duplicate/quantized samples do not reset it, and small drift is corrected by
  gentle rate changes instead of backwards position jumps.
- No per-frame AVPlay calls or network access. Missing progress samples bound
  extrapolation to one second and stop the frame loop until a fresh sample.
- Immediate pause/buffering freeze, explicit seek resynchronization, and cleanup
  for stop, replacement episode, hidden page and disabled comments. Cancelled
  stale callbacks cannot spawn a second animation loop.
- Cache layer width; batch new glyph insertion and width measurement. Steady
  frames only update transforms. At most eight comment nodes are mounted even
  when the episode contains thousands of comments.
- `translate3d`, transform hints and non-blurred text shadows on TV and phone.
  Video format/quality, comment acquisition and lane/density policy are unchanged.
- TV receiver/package version 0.6.2. Phone uses the same renderer, 250ms clock
  sampling and direct media events for waiting, playing, pause and seek.

## Verification

- **128 tests passed**, including six new deterministic animation tests and
  native/phone integration cases. Existing source/API/security tests also pass.
- With 250ms media samples and a simulated 60Hz frame clock, one second produces
  **60 distinct forward positions**, ~4.375px per step for the same test glyph,
  instead of four ~65px jumps. No repeated layout/text measurements during the
  steady-frame interval. These are deterministic scheduling tests, **not measured
  Samsung hardware FPS**.
- Tests cover jitter/duplicate samples, pause/buffering/resume, seek, late data,
  3,000 comments with bounded DOM, hidden/disabled/cleared players, stale frame
  callbacks, and recovery after lost progress callbacks.
- User privately signed the package in Terminal. SHA-256 comparison confirmed
  the signed package's `config.xml`, `app.js`, `danmaku.js`, and `style.css` matched
  the tested source files before installation. No certificate/password contents
  were read or stored by this task.
- In-place installation to Samsung UN65RU7100FXZA at 10.0.0.53:26101 completed;
  Tizen reported a successful launch. The gateway then confirmed
  **receiverVersion 0.6.2** connected.
- Phone/shared script responses match current source hashes. No backend restart
  was needed, and the existing episode-7 comment attachment remains in memory.

Actual physical-screen smoothness still needs the user's observation; application
launch and deterministic scheduling tests do not establish a real-TV frame rate.
