# Manifest freeze and resume verification

Freeze holds manifest responses while live publication, media retention and the
local DASH clock continue. Resume discards the held snapshots and serves the
current timeline. This check measures simulator HTTP behavior. Player recovery
policies and rendered playback after a stale manifest are separate client tests.

## Reproduce

From a source checkout with dependencies installed:

```sh
npm run manifest:verify
# HLS only, without Docker:
npm run manifest:verify -- --protocol hls
# Retain a new evidence directory:
npm run manifest:verify -- --output output/my-manifest-freeze-run
```

Both protocols run in separate workers with isolated configuration files and
loopback ports. DASH requires Docker and the pinned image described in
[development](development.md). There is no device access. The default run takes
about two minutes; DASH deliberately aligns its first freeze across a real
one-minute Period boundary. It uses engine real time, without a virtual clock.
Existing output directories are rejected. Interrupting the run fails verification
and closes the sessions and engine container owned by that run.

## Verified behavior

Each worker performs two freeze/resume cycles, holding snapshots for at least
20 seconds per cycle. The checks require:

- Healthy manifests advance before freeze.
- The most recently observed manifest is held byte for byte. A previously
  unobserved manifest captures its first successful response and then holds it.
  HLS checks both 180p and 360p child playlists; DASH checks both Time and Number
  SegmentTimeline MPD paths. Generated HLS keeps its static master index;
  dynamic child playlists carry the frozen live timelines.
- Repeated requests with different cache-busting query parameters return the
  identical snapshot. DASH `nowMS` query overrides also cannot bypass an active
  snapshot. HEAD returns no body and the correct manifest content length.
- Media GET, HEAD and range behavior remains independent of freeze. Freshly
  published HLS media remains downloadable, future HLS media remains unavailable,
  and expired HLS media still returns 410. DASH media and audio/video initialization
  bytes match direct requests to the run's own engine. Range behavior matches the
  engine, including a full 200 response when it ignores Range.
- Local DASH UTC HEAD remains fresh and available while the MPD is frozen.
- Unfreezing returns a newer live edge and media, followed by continued timeline
  advancement. The resumed DASH edge agrees with the independent engine reference
  within two segment durations, and its first cycle includes a new Period.
- Freeze diagnostics identify capture versus hold, correlate request/fault IDs
  with response headers, and never attribute media/clock/resumed responses to
  freeze. Rearming creates a new fault activation.

Control changes are written by a separate process to the shared configuration
file. The worker must observe each change through `/health` within three seconds.
The report records this acknowledgement delay separately from the first fresh
manifest response after resume. Each HTTP request has a five-second timeout.

The engine reference is read from the uniquely owned DASH container's loopback
mapping. It proves that the origin keeps advancing while the proxy MPD stays
frozen. Reference requests are labelled separately and are not proxy fault
observations. No other container is selected, modified or stopped.

## Snapshot and retention semantics

Snapshots are per manifest identity. They preserve the latest successfully
observed response, rather than promising an atomic, simultaneous capture of every
rendition or stream. A cold URI captures when first requested during freeze.
Healthy and frozen caches are bounded to 128 entries; a new uncached URI at the
frozen limit returns 503 until resume. DASH uses the stream path as its identity,
so changing query parameters does not create another snapshot.

Freeze does not extend DVR or retention. References in an old held playlist/MPD
can expire normally during a long freeze. Downloading all frozen references
indefinitely is not part of the fault. Turning freeze off catches up to current
time rather than replaying all elapsed manifests.

## Regression coverage and evidence

The targeted regression tests cover generated HLS publication/expiry during
freeze, key/init availability in the HLS origin proxy, cold capture, cache bounds,
resume/rearm, and in-flight origin responses racing a freeze. A response finishing
from an older origin request must use the currently active snapshot instead of
overwriting it. Scenario-owned sessions continue to exclude manual freeze.

Verification retains manifest bodies, body hashes, protocol/timeline metadata,
control acknowledgements, status/byte/framing measurements, and complete redacted
server JSONL diagnostics. The parent report records source commit and dirty-tree
status at run start. A single-protocol run cannot set `bothProtocolsVerified`;
a passing pair still leaves `releaseReady: false`.

Manual full CI runs the pair in the DASH engine integration job and retains evidence
as a private repository artifact for seven days, including partial evidence on
failure. A CLI failure or incomplete evidence is never counted as verification.
The original failing development attempts remain in their local output directories.
