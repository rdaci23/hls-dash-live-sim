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

## Intentional invalid counterparts

Use a separate source session and pair each with the valid restart above:

```sh
npm run hls -- --fixture tracks --scenario examples/scenarios/owned-unannounced-timestamp-reset.json
npm run dash -- --fixture tracks --scenario examples/scenarios/owned-sequence-rollback.json
npm run hls -- --fixture tracks --scenario examples/scenarios/owned-reused-url-incompatible-media.json
```

These require explicit `track: "video:0"` and `durationMs` from 1,000 to 60,000.
Only owned live sources accept them. During the bounded interval:

- Unannounced reset returns low-video fragments with loop-local decode/SIDX times,
  without a discontinuity, new Period or new initialization.
- Sequence rollback lowers the selected HLS child playlist's media sequence, or
  the selected DASH Representation's startNumber while its advertised sample
  timeline remains fresh. Other Representations keep their normal numbering.
- Incompatible reuse returns the other encoded video's bytes at the low video's
  existing media URL, keeping the low initialization and manifest metadata.

All are deliberately invalid. Source HEAD responses stay healthy and do not
consume/tag the fault. Initialization, other tracks and UTC remain controls.
After restoration the original retained URI returns its original bytes; publication
continues throughout. A reset removes that run's active invalid action. Diagnostics
record delivered fault IDs and completed-response counters, without source URLs.

```sh
npm run lifecycle:invalid -- --output output/invalid-source
```

This is HTTP/byte evidence, not proof that a player survives invalid media.

## DVR, joining and long freezes

```sh
npm run hls -- --fixture tracks --scenario examples/scenarios/join-during-outage.json
npm run dash -- --fixture tracks --scenario examples/scenarios/long-manifest-freeze.json
npm run dvr:verify -- --output output/dvr-http
npm run browser:dvr -- --output output/dvr-browser
```

The isolated HTTP checks retain the same old media identity, wait beyond actual
retention, require 410, then require fresh advertised downloads to work. A 45-second
freeze holds the manifest body while source publication and retention continue;
old held downloads can expire. Resume exposes fresh valid resources. Joining an
outage keeps manifests/init/UTC available, delivers the named video fault and
restores the same retained download.

The browser workflow records three separate cases: explicit pause beyond the
window followed by inside/outside seeks; joining during an outage; and automatic
resume after a long freeze, with 30 seconds of verified healthy lead-in and 60
seconds of continuation. Only the first case permits harness pause/play/seek.
Outside-window clamping, playback of already-buffered media and failure to resume
are distinct observations. Fault-associated player errors remain in raw evidence;
exceptions and unverified recovery cannot become a simulator pass. Reports retain
versions, retry settings, explicit actions and complete diagnostic files. Broader
three-minute baselines and endurance still have their own gates.

### Current startup compatibility limit

In local probes, hls.js 1.7.3 and dash.js 5.2.1 exhausted their default startup
video-503 handling before the sustained outage ended. No first frame appeared
without intervention. The simulator separately passed same-URL restoration and
healthy manifest/init/UTC checks. This is a retained player result, not a startup
recovery pass. The verifier preserves the exact retry settings and failure data;
new browser configurations require separate evidence before a support claim.

The long-freeze development probe restored HLS rendering, decoded audio/captions
and 60 seconds of continuation. DASH played buffered frames briefly, then
stopped at its automatic seek to the new window. That is unqualified browser
recovery. The verifier now additionally requires newly rendered media inside the
restored source window; looping old frames cannot pass. Both protocols passed
HTTP held-body identity, retention expiry, advancing publication and fresh media
restoration. CI always checks these HTTP contracts; the strict DVR browser matrix
runs with the opt-in full-playback workflow and retains its failures.
