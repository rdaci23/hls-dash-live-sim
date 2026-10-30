# Manifest and initialization fault targeting

Scenario HTTP/transport rules can target media, manifests or initialization resources.
Omitting `target.resource` retains the original media-only behavior, fingerprints
and seeded media choices. These are simulator HTTP checks; client playback and
recovery outcomes remain specific to the player and its retry policy.

## Select a resource

| `target.resource` | `target.track` | `target.segment` |
| --- | --- | --- |
| omitted or `media` | `video`, `audio`, `text`, or an observed alias such as `video:1` | Existing `next`, `each`, or exact Number/Time selector. |
| `manifest` | `root`, `any`, or an HLS child track/type/alias | `next` or `each`. DASH has one MPD and accepts only `root` or `any`. |
| `init` | `any`, `video`, `audio`, `text`, an observed alias, or HLS direct-playlist `root` | `next` or `each`; only initialization advertised in the manifest is eligible. |

HLS `root` is the initial master or direct media playlist; child aliases follow
first-observed video/audio/subtitle declarations. A root DASH MPD includes all
tracks. File extensions do not establish initialization identity: HLS uses
`EXT-X-MAP`, and DASH uses the observed SegmentTemplate initialization reference.
An HLS media range and init range sharing an origin file stay distinct routes.
A direct HLS media playlist does not declare its media type, so its init belongs
to `root` and can be selected with `root` or `any`. Use a master with explicit
track declarations for video/audio aliases. Ambiguous initialization ownership
across tracks is rejected rather than guessed.

`next` for manifest/init means the next matching GET after `afterMs`, including
an already used URI. Its attempt list starts at that GET, so a live manifest can
fail once during a later refresh. Diagnostics retain global attempt numbers.
The selected URI and normalized byte range stay bound through retry. `each`
uses the resource's ordinary attempt count; use a bounded outage with all attempts
for a refresh-failure window. Media `next` retains its earlier semantics: the
next new matching media download, not an old segment's retry.

For repeated HTTP failures, [multi-attempt retry assertions](multi-attempt-retry.md)
verify consecutive failures followed by successful same-resource retry.

HEAD, media, keys, clock and health requests cannot consume manifest/init-only
rules. `expectRetry` requires the GET immediately after the final configured failure
of the same logical resource/range to finish with nonempty 200/206 bytes. A different resource, range,
cancelled request or empty success cannot establish recovery. This does not assert
manifest syntax, decoder readiness or rendered recovery in an arbitrary player.

## Fail the first root manifest, then retry

From a built source checkout:

```sh
mkdir -p output
cp examples/configurations/healthy.json output/resource-faults.json
npm run hls -- --scenario examples/scenarios/next-manifest-retry.json --fault-config output/resource-faults.json
# Alternatively, after stopping HLS:
npm run dash -- --asset abr --scenario examples/scenarios/next-manifest-retry.json --fault-config output/resource-faults.json
```

The first root-manifest GET returns 503; the next successful nonempty GET of that
URI establishes the HTTP retry. Use the printed stream URL. A manifest viewer is
also a client and can consume this rule before a video player connects.

The HLS-only [child-manifest preset](../examples/scenarios/next-video-manifest-retry.json)
instead targets the next video child playlist. The master and other resources
remain healthy. Edit `track` to an observed alias to isolate one child.

For one failure during established playback, add `"afterMs": 60000` to a `next`
rule. The clock starts with the simulator, not when the player connects. For a
sustained refresh outage use `kind: "outage"`, `segment: "each"`, `attempts: "all"`
and finite `afterMs`/`beforeMs`; media and local UTC stay available.

## Fail video initialization only

```sh
npm run dash -- --asset abr --scenario examples/scenarios/next-video-init-retry.json --fault-config output/resource-faults.json
```

The [init preset](../examples/scenarios/next-video-init-retry.json) fails the next
video initialization GET once. Audio initialization, media and the MPD stay
healthy. Change `track` to `audio`, `video:0` or `video:1` for explicit isolation.
An init already cached in a player may not be downloaded again; use a fresh
player session or target an actual upcoming init request.

The generated HLS MPEG-TS sample has no initialization object and rejects init
rules. For a local fMP4 HLS origin, start this source-checkout helper first:

```sh
node scripts/resource-scenarios/origin.cjs --port 8898
```

Then in another terminal:

```sh
npm run hls -- --manifest-url http://127.0.0.1:8898/master.m3u8 --no-dummy-content --scenario examples/scenarios/next-video-init-retry.json --fault-config output/resource-faults.json
```

The helper binds to loopback and serves only explicit procedural fixture files.
It reuses the existing DASH fMP4 ladder, emits HLS video/audio playlists using
the encoded fragment durations, and requires no new media or FFmpeg runtime.
Stop both owned processes with Ctrl+C. For your own origin, keep the existing
origin/credential restrictions and use the manifest's advertised init resources.

HLS origin scenarios in this milestone support manifest/init HTTP rules only;
media rules and network timelines there are rejected. Generated HLS continues
supporting its existing media/timeline rules alongside manifest rules. These selectors also support [bounded body stalls and aborts](transport-scenarios.md).
Targeted malformed manifests and key faults remain outside this scope.
Other [scenario bounds and conflict rules](scenarios.md) continue to apply.

## Verify and retain evidence

```sh
npm run resource:verify
# No Docker, HLS fixture/proxy only:
npm run resource:verify -- --protocol hls
# New output directory; existing directories are rejected:
npm run resource:verify -- --output output/my-resource-targets
```

The eight-case matrix checks root manifests plus low-video, high-video and audio
initialization for both protocols. HLS uses the local fMP4 origin; DASH uses the
real pinned livesim2 engine and `abr` asset, with no image pull. It checks HEAD
exclusion, unaffected resources, actual initialization/media bytes, same-resource
retry, diagnostic resource kinds and matching request/fault IDs. Reports retain
the commit, dirty-tree flag, per-case results, isolated files and redacted JSONL.
Only the full pair sets `bothProtocolsVerified`; `releaseReady` stays false.

Unit/HTTP regressions additionally cover generated HLS child manifests, late
refresh gates, shared-file init/media ranges, ambiguity/capacity rejection, failed
retries and unchanged legacy media selection. Routine CI runs the pair in the
DASH engine job and retains its artifact, including partial evidence on failure.
