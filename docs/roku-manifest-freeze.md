# Native manifest-freeze observation

This optional standalone check uses the same generated track fixture and
35–80 second manifest freeze as the browser DVR case. It records simulator HTTP
behavior separately from native A/V position progress. It does not qualify browser
telemetry, captions, perceived audio quality or additional device models.

Build/install the standalone tester on an explicitly selected dedicated Roku as
shown in [native playback setup](playback-gates.md). Installing replaces the
sideloaded developer channel. The verifier itself never installs software.

```sh
npm run build
node scripts/verify-roku-freeze.cjs --device ROKU_LAN_IP --server-host COMPUTER_LAN_IP --protocol dash --output output/roku-freeze
```

For the same test with HLS, use `--protocol hls` and a different output directory.
HLS uses the generated fMP4 fixture with separate audio, rather than the default
MPEG-TS samples. Its freeze probes inspect a video media playlist; the master
playlist alone does not establish whether publication stopped. The local UTC
probe applies only to DASH.

The owned HLS fixture uses one constant target duration across video, audio and
live text, as required by [RFC 8216 section 6.2.4](https://www.rfc-editor.org/rfc/rfc8216.html#section-6.2.4).
AAC fragments slightly exceed two seconds, so the common target is three seconds.
This does not change media timestamps, the default six-segment window or test
deadlines. Earlier fixtures incorrectly declared two seconds for video and three
for audio; their playback observations do not establish behavior of the corrected
fixture.

The default live window is approximately 12 seconds. This is an explicit
short-window recovery stress case, not evidence of a recommended Roku live setup:
[Roku's streaming guidance](https://developer.roku.com/dev/docs/media#playing-and-seeking-to-the-live-edge)
calls for playback at least 30 seconds behind the live edge. Keep any longer-window
diagnostic result separate from the original short-window outcome.

Use real private LAN IPv4 addresses in place of the two placeholders. The computer
serves only the owned generated fixture; no external accounts or license services
are used. The check waits for native A/V progress before starting the scenario.
It never restarts or seeks the player to manufacture recovery. The installed
1.1.0 tester records to completion, then stops playback; Ctrl+C stops this run.

The recording lasts 185 seconds. Independent probes verify repeated identical
frozen manifests, fresh publication after restoration, current media/init access
and the advertised local HEAD clock. Native checks retain the 10-second startup,
30-second healthy lead-in, four-second healthy-stall and 60-second continuation
gates. Freeze recovery has the browser DVR case's 30-second observation window.
Cross-device sample/clock bounds are explicit in the saved report. Failure to
recover stays a failed native outcome, even when HTTP restoration passes.
Uninterrupted playback is reported as continuation; recovery requires an observed
freeze-associated native stall.
Stalls still present at the final native sample are reported as `terminalStall`,
separately from gaps that ended with resumed progress. This describes the observed
failure and does not relax the recovery or continuation requirements.

Reports retain the exact model/OS build, candidate identity, native file hash,
closed source evidence, cleanup counters and separate HTTP/native results. Never
publish unsanitized native logs or device identifiers. Repository verification
remains local-only while Actions is disabled; no support claim expands from a
single observation.

## Short-window HLS investigation

Local observations on 6 November 2026 used one Express 4K (3940EU), Roku OS
16.0.4 build 853, and the standalone 1.1.0 tester. The corrected stream code was
commit `9e4e66bb0588b2a26545f35d0dc019966943e79e`. These results do not qualify
other devices, MPEG-TS samples or a full release candidate.

| Comparison | Observation |
| --- | --- |
| Original fixture, 12-second window, no freeze | Approximately three minutes of independent native A/V position progress; no observed stall. This predates the target-duration correction. |
| Corrected fixture, 12-second window, 35–80 second freeze | HTTP freeze/restoration passed. Native A/V did not resume. An over-limit native sample gap also prevented complete telemetry qualification. |
| Corrected fixture, 60-second window, same freeze | Native A/V continued with no observed stall and 102 seconds of post-restoration progress. This is continuation, **not verified recovery from a stall**. |
| Corrected fixture, 12-second window, browser hls.js 1.7.3 / Chrome 156.0.8078.80 | Automatic recovery and the required continuation passed the isolated browser check. |

The target-duration mismatch was a simulator defect. Correcting it did not fix
Roku's short-window recovery. In the short-window failure, the selected video
playlist advances again after restoration, while the native player keeps
reloading it without downloading new media. A 45-second freeze outlasts the
12-second sliding window, so the old and restored playlists have no overlap.
This evidence points to a Roku recovery compatibility limit in that condition;
it does not establish an exact internal firmware cause. The longer-window result
must never replace or relabel the failed short-window result.
