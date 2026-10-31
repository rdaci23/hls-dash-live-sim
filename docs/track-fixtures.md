# Owned fMP4 audio and caption fixtures

The optional `tracks` fixture adds independent tracks for HLS and DASH while
keeping the existing MPEG-TS and DASH-engine defaults. It runs locally without
Docker or external media, clock, key or account services.

```sh
npm ci
npm run build
npm run hls -- --fixture tracks
npm run dash -- --fixture tracks
# Optional third video rendition:
npm run hls -- --fixture tracks --video-renditions 3
npm run dash -- --fixture tracks --video-renditions 3
```

The local fixture is served through the existing fault adapters and authenticated
manual controls. Supply `--fault-config` and `--diagnostics-file` as usual. To use
manual runs, set HLS_DASH_CONTROL_TOKEN and add `--scenario-start manual`. Load
advertised playlists/MPD first, then refresh the catalog. The fixture cannot
combine with external sources, engine assets/images/Period options, external UTC
or a disabled proxy. Stop its foreground session with Ctrl+C.

## Media and timing

| Track aliases | Fixture content |
| --- | --- |
| video:0 / video:1 | Genuine 320×180 and 640×360 H.264 video. |
| video:2, opt-in | Genuine 960×540 H.264 video. The normal two-rung ladder stays the default. |
| audio:0 / audio:1 | Separate stereo AAC, 440 / 880 Hz procedural tones, labelled en / ro. These are distinguishable test signals, not recorded speech. |
| text:0 / text:1 | Authored `EN cue …` / `RO cue …`, HLS WebVTT and DASH MP4 WebVTT (`wvtt`). |

All tracks have exactly eight seconds of coded sample duration per source loop.
AAC initialization omits the priming edit list: coded priming samples remain as
initial silence, so the presented loop is not shortened by 1,024 samples.
The live publisher advances fragment decode times, sequence numbers and SIDX
presentation times rather than reusing a URL with incompatible bytes. The same
published URI has stable bytes within retention. HLS PROGRAM-DATE-TIME, DASH AST/
Period/segment timing and local UTC share the real-time source epoch. Track
boundaries can differ slightly because AAC access units are not video frames;
complete eight-second cycles align, avoiding cumulative loop drift.

The default live window is six segments; `--window-segments` supports 3–120.
Removed media remains available for the existing retention grace. Initialization
stays compatible. HLS uses separate EXT-X-MAP, AUDIO and SUBTITLES renditions.
DASH uses separate audio/text AdaptationSets and explicit finite timelines.
`--mode vod` serves the finite eight-second fixture; event completion and encoder
restart controls are described in [owned lifecycle scenarios](lifecycle-scenarios.md).

The optional source also has an authored 0.4-second white corner / audio-amplitude
pulse every eight seconds for [independent endurance timing](endurance.md). The
continuous 440/880 Hz signals stay distinguishable between pulses.

The authored caption schedule repeats in media time:

| Position within an eight-second cycle | Expected output |
| --- | --- |
| 0.25–1.50 s | Language-specific cue 1. |
| 2.00–4.00 s | Valid, fully empty caption interval. |
| 4.25–5.50 s | Cue 3. |
| 6.25–7.50 s | Cue 4. |

The DASH text path uses application/mp4 with wvtt and explicit sample durations/
sizes, including timed empty `vtte` samples. It is tested through the pinned
player's parser, not presented as universal native text support. See
[primary-source fixture notes](caption-fixture-research.md).

## Independent failures and per-track networking

These presets require the corresponding advertised independent tracks:

- [Independent audio outage](../examples/scenarios/independent-audio-outage.json):
  audio:0 media fails during seconds 30–45; other audio/video/text and init stay healthy.
- [Independent text outage](../examples/scenarios/independent-text-outage.json):
  text:0 media fails; other tracks, playlists/MPD, initialization and UTC stay healthy.
- [Late caption publication](../examples/scenarios/late-caption-publication.json):
  text:0 becomes downloadable up to eight seconds after normal availability,
  bounded by the same 30–45 second fault window. This can miss a player's caption
  deadline; it does not shift authored cue times to hide late arrival.
- [Asymmetric track networking](../examples/scenarios/asymmetric-track-network.json):
  one shared 1,500 kbps session ceiling plus a 32 kbps audio:0 cap / 80 ms jitter
  and 8 kbps text:0 cap / 120 ms jitter, then explicit per-track clearing.

```sh
npm run hls -- --fixture tracks --scenario examples/scenarios/independent-audio-outage.json
npm run dash -- --fixture tracks --scenario examples/scenarios/independent-text-outage.json
npm run hls -- --fixture tracks --scenario examples/scenarios/asymmetric-track-network.json
```

A timeline phase accepts additive media-only shaping:

```json
"tracks": {
  "audio:0": {"bandwidthKbps": 32, "jitterMs": 80},
  "text:0": {"bandwidthKbps": 8, "jitterMs": 120}
}
```

Per-track caps are additional ceilings under the existing shared session cap;
zero removes a ceiling. Track jitter adds to any session jitter. HEAD,
initialization, manifests and UTC are excluded from these **per-track** actions;
the normal session profile still applies according to its existing scope. Track
aliases come from advertised metadata. Timed changes update active transfers.
Cancellation releases pending grants, retained bodies and timers.

Each phase supports 1–16 explicit aliases, at most 128 across a run. Invalid
limits, broad aliases, arbitrary fields and unavailable tracks reject explicitly.
Per-track shaping with HTTP/payload/transport rules or manifest freeze is not yet
qualified and is rejected. No extra server paths or URL-fetching control API are
introduced. The control catalog uses the existing immutable/session-scoped runs.

## Verification and limits

```sh
npm run tracks:verify -- --output output/independent-tracks
npm run browser:tracks -- --output output/decoded-tracks
```

The eight HTTP cases cover audio/text outages, late publication and asymmetric
shaping on both adapters. They retain before/during/after responses, repeated and
newly published failures, fault IDs, byte digests, metadata/UTC isolation, HEAD
exclusion and restoration inside retention. Network checks measure pacing,
cancellation, an active transfer spanning a timed rate change, shared limiting,
byte identity, jitter delivery and zero owned pending counters after close.

The Chrome check selects en → ro → en. It requires five fresh decoded-tone
windows with advancing media time, adequate RMS and spectral dominance; active
caption payloads safely inside their authored intervals; a loaded showing track
with no active cues during the known empty interval; actual low/third decoded
video dimensions; and captions off. A Web Audio analyser silences its output
after measurement, so this proves decoded media-element output rather than
physical speaker audibility. Player versions/retry settings and complete closed
diagnostic-file hashes are retained. User-directed selection is separate from
recovery tests that prohibit harness intervention.

The pinned hls.js subtitle controller explicitly aborts its current fragment on
subtitle switches; its loader reports that cancellation as a nonfatal network
`aborted` event. The verifier retains such events separately only when they are
subtitle aborts within 500 ms of both an explicit selection and a player subtitle
switch. Other errors remain failures.
[Switch path](https://raw.githubusercontent.com/video-dev/hls.js/v1.7.3/src/controller/subtitle-stream-controller.ts),
[abort callback](https://raw.githubusercontent.com/video-dev/hls.js/v1.7.3/src/loader/fragment-loader.ts),
[error propagation](https://raw.githubusercontent.com/video-dev/hls.js/v1.7.3/src/controller/base-stream-controller.ts).

HTTP targeting, healthy decoded-track evidence, fault playback/recovery, and
endurance are separate qualifications. These fixture checks do not establish
recovery from independent-track faults or the four-hour release soak. Apple,
Android and additional hardware remain unverified.

## Regeneration

`npm run fixtures:tracks` uses FFmpeg testsrc2 and synthesized tones, plus the
owned wvtt builder. It validates sample timing/dimensions and writes advertised
metadata. FFmpeg 7.1.1 generated the initial assets; encoded bytes can vary across
versions. Rebuild after regeneration, then rerun structural, HTTP and decoded
browser checks. Existing default assets are not replaced. Generated content and
authored captions use the project MIT license; generation tools keep their own
licenses. [Asset provenance](../assets/README.md).
