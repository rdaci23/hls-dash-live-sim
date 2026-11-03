# Rendition lag and delayed publication

These bounded version-1 actors change advertised publication or fresh media
availability while keeping other tracks, initialization, manifests and local UTC
healthy. They are simulator HTTP scenarios; browser adaptation and recovery are
separate results. Neither actor changes the stream or UTC clock.

## One-rendition lag

[low-rendition-publication-lag.json](../examples/scenarios/low-rendition-publication-lag.json)
removes the newest complete segment from `video:0` publication during seconds
30–45, then restores the current publication frontier. Lower and higher aliases
come from advertised metadata; file names do not determine the selected track.

```sh
npm run hls -- --scenario-file examples/scenarios/low-rendition-publication-lag.json
npm run dash -- --asset abr --periods-per-hour 1 --scenario-file examples/scenarios/low-rendition-publication-lag.json
```

HLS retains its original sequence/discontinuity metadata and complete retained
segment/init blocks. The master and other rendition remain current. Removed
segments stay downloadable if requested directly within normal retention.

DASH changes only the selected Representation's effective SegmentTemplate. It
keeps the original inherited timeline for other video/audio representations,
without changing numbering, timescale, PTO, initialization or UTC. Rewritten
MPDs retain explicit XML boolean attribute values and must remain well-formed. This first
implementation requires **one dynamic Period**, finite nonnegative repeats, and
more complete segments than the configured lag. Multi-Period lag, VOD, negative
repeats and ambiguous/absent aliases reject explicitly. Use a one-Period test
interval; crossing a Period boundary is outside this actor's current scope.

## Delay fresh media availability

[fresh-video-publication-delay.json](../examples/scenarios/fresh-video-publication-delay.json)
returns 404 for newly available `video:0` segments during seconds 30–45 until each
segment is four seconds older than its normal advertised availability. Repeated
attempts and newly published segments have the same run fault ID. Older media
and other tracks remain healthy. At the window end the delay is removed, even
if a recently published segment has not yet reached the full configured delay.

```sh
npm run hls -- --scenario-file examples/scenarios/fresh-video-publication-delay.json
npm run dash -- --asset abr --periods-per-hour 1 --scenario-file examples/scenarios/fresh-video-publication-delay.json
```

Generated HLS uses the same publication epoch as its PROGRAM-DATE-TIME and
segment duration. A future, unpublished HLS segment remains the ordinary
unavailable response and never counts as an injected delay. Origin HLS media
delay is not supported by this generated-sample actor.

For DASH, normal complete download availability is:

`AST + Period.start + (segment.t + segment.d - PTO) / timescale - ATO`

The index derives these values from the MPD, including inherited templates and
finite availabilityTimeOffset. A still-future segment cannot qualify as a
simulated delay. Complete availability timing must be known; static manifests,
unknown Period starts, nonfinite offsets, and availabilityTimeComplete=false
cannot start a manual delay run. Partial low-latency segment delivery remains
outside this milestone. An origin error is not proof of a publication fault.

## Schema, controls and limits

```json
{
  "version": 1,
  "seed": 42,
  "rules": [],
  "publication": {
    "kind": "rendition-lag",
    "track": "video:0",
    "afterMs": 30000,
    "beforeMs": 45000,
    "segments": 1
  }
}
```

Use `segments` 1–10 for rendition-lag, or `delayMs` 1–60,000 for segment-delay.
Choose an explicit video/audio/text rendition alias. Windows are finite and end
within one day. The shipped presets use video; other independent audio/text
fixtures require their own qualification. Publication cannot combine with rules,
HTTP/cache or network actions until those combinations are verified.

Manual mode uses the existing authenticated arm/start/reset controls. Load the
advertised MPD or HLS target child playlist first and refresh the run catalog;
unsupported metadata disables the preset and start rechecks it. HLS generated
TS uses known generated metadata; VOD cannot use publication actors. Reset
clears the run's bounded failed-download identity set and cancels only its
associated work; it does not rewind publication or UTC. HEAD never consumes,
transforms or delays publication, and GET restoration is checked separately.

## Verification

```sh
npm run publication:verify -- --output output/publication-check
```

The four-case isolated verifier runs generated HLS and the pinned DASH engine.
It records exact commit/dirty-tree identity, before/during/after publication
frontiers in presentation time, byte hashes, request IDs and fault IDs. It checks
repeated and newly published delayed downloads, HEAD exclusions, actual target
availability, healthy alternate tracks/init/manifests/UTC, fault application and
same-download restoration inside retention. Lag is checked through effective
representation templates, not the untouched inherited template alone.

Qualification requires completed delivered bodies. Prepared transformations,
cancelled requests, future-origin 404s and an advancing video alone cannot prove
publication behavior. The delay actor bounds retained identities to 1,024 and
rejects capacity overflow. Close/reset drains those identities. Browser results
will report startup, stalls, adaptation and continuation independently; the HTTP
checks do not claim player recovery.
