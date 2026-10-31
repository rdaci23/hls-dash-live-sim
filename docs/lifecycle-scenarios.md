# Owned encoder restart and event completion

These source-authoring presets require the optional [tracks fixture](track-fixtures.md).
Existing MPEG-TS/engine defaults stay unchanged. Unsupported source/mode or mixed
fault definitions reject before a run starts. Version-1 scenarios add an optional
`lifecycle` object; legacy automatic startup and fingerprints are preserved.

```sh
npm run build
npm run hls -- --fixture tracks --scenario examples/scenarios/owned-encoder-restart.json
npm run dash -- --fixture tracks --scenario examples/scenarios/owned-encoder-restart.json
npm run hls -- --fixture tracks --mode event --scenario examples/scenarios/owned-event-completion.json
npm run dash -- --fixture tracks --mode event --scenario examples/scenarios/owned-event-completion.json
```

The presets schedule at 30 seconds, then author at the next common eight-second
media boundary. Publication, UTC and the source epoch continue normally.

| Action | Source behavior |
| --- | --- |
| `encoder-restart` | Fresh initialization/media URI generation, aligned HLS discontinuity/MAP across video, audio and text; DASH Period with matching presentationTimeOffset. Coded timestamps remain continuous and initialization stays compatible. |
| `event-completion` | A growing event stops at a complete common boundary, retains its full published media, and becomes ENDLIST / finite static MPD with a duration. UTC itself stays healthy; static MPD no longer needs a UTC advertisement. |

`afterMs` is bounded to one day, or five minutes for finite-event completion.
Only live/event sources can restart; completion requires event mode. There are at
most 63 new generations per owned source. A reset cancels pending authoring and
that run's affected transfers. It cannot retract an already advertised generation
or turn a completed event back into a live stream. Start a new source session for
another completed event. No arbitrary script, server path or external URL is
accepted by the authoring API. Manual arm/start/reset uses the existing token,
connected-session and current-run checks.

```json
{"version":1,"rules":[],"lifecycle":{"kind":"encoder-restart","afterMs":30000}}
```

The HTTP verifier checks pre-transition healthy bytes, aligned advertised
transitions, compatible initialization, coded fragment timing, same retained
resource bytes, stable final manifests and drained timers/transfers/source actions.
It does not qualify playback merely because a manifest changed.

```sh
npm run lifecycle:verify -- --output output/lifecycle-http
npm run browser:lifecycle -- --output output/lifecycle-browser
# A single probe:
npm run browser:lifecycle -- --protocol hls --kind event-completion --output output/hls-ended
```

Browser checks use the pinned players, retain exact versions/retry settings and
complete diagnostic-file hashes. Restart evidence requires rendered new-generation
media, decoded audio and correctly timed active/empty captions after the boundary;
DASH additionally needs the played Period-switch event. Completion requires the
native video element's `ended` state/event at the finite duration. No harness
restart or seek is used after initial track configuration. Unexpected errors,
exceptions and unexplained rendered gaps over four seconds fail the checks.

These checks are narrower than the three-minute healthy release gate. Invalid
restart counterparts, DVR pause/seek/join/freeze cases and endurance remain open
in the [core roadmap](scenario-roadmap.md). Repository/npm remain private.
