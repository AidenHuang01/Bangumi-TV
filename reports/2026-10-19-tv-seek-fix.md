# Samsung TV seeking compatibility verification

Device: Samsung UN65RU7100FXZA, 10.0.0.53. Mac server: 10.0.0.30:8787.
Test: AGE / Lycoris Recoil / playback road 1 / episode 1.

## Failure and change

The original MP4 played H.264/AAC normally, and the Mac gateway returned valid
HTTP byte ranges. FFmpeg could seek to minute 10 and decode a frame through the
same gateway. On the TV, both relative and absolute AVPlay seeks nevertheless
returned `PLAYER_ERROR_INVALID_STATE`. The 0.5.1 async-call sequencing change did
not fix this stream.

The new Mac compatibility path uses `ffmpeg -c copy` to repackage the original
encoded video and audio into a complete MPEG-TS HLS VOD. The measured preparation
took 9.98 seconds and generated about 255 MiB for a 24-minute episode. It does
not encode, scale, or lower the bitrate. TV commands are issued only after the
complete playlist and segments are available locally.

## Physical TV results

These first measurements used the installed 0.5.1 TV widget with the updated Mac
controller sending prepared HLS:

| Action | Before (ms) | Requested (ms) | Confirmed (ms) | TV result |
| --- | ---: | ---: | ---: | --- |
| +10s while playing | 18165 | 28165 | 31514 | done, continued playing |
| -10s while playing | 49850 | 39850 | 42485 | done, continued playing |
| +10s while paused | 54918 | 64918 | 65018 | done, stayed paused |

The first two jumps land within a few seconds of the requested time because the
original keyframe spacing is retained. No invalid-state error was reported for
these HLS jumps. Resume after the paused seek continued playback.

The final widget is **0.5.3**. A repeated test exposed a separate false failure:
the old fixed five-second position tolerance rejected a successful HLS jump
that landed 5.7 seconds past its target. The compatibility metadata now includes
the maximum measured segment length plus one second. The widget validates that
the position moves in the requested direction and uses that bounded tolerance;
a successful callback with an unchanged position is still rejected.

Final installed 0.5.3 widget, restarted production Mac service, same episode:

| Action | Before (ms) | Requested (ms) | Confirmed (ms) | TV result |
| --- | ---: | ---: | ---: | --- |
| +10s playing, #1 | 25242 | 35242 | 37265 | done |
| +10s playing, #2 | 40718 | 50718 | 52838 | done |
| +10s playing, #3 | 56150 | 66150 | 70268 | done |
| -10s playing, #1 | 73618 | 63618 | 65633 | done |
| -10s playing, #2 | 69004 | 59004 | 65615 | done |
| +10s paused | 67569 | 77569 | 81033 | done, stayed paused |

All six consecutive seeks passed on the physical TV and playback was resumed.
The TV reported `format: hls`, `playback: remux`, and `seekToleranceMs: 11428`.
The direct-TV resolve endpoint also returned the prepared HLS item. Other
providers/codecs were not part of this physical regression run.

## Regression coverage

The integration test generates a real MP4 fixture, prepares HLS through the HTTP
API, checks the full VOD playlist, byte-range and HEAD responses, and uses FFmpeg
to seek/decode through the served HLS segments. Additional checks cover cached
controller dispatch, cancellation during preparation, missing FFmpeg cleanup,
private upstream URLs, segment path validation and phone preparation status.
The complete suite passed **72 tests**, including false-failure/unchanged-position
seek checks. FFmpeg is exercised rather than mocked in the remux integration test.
