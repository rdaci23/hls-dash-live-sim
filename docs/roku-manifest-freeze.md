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
