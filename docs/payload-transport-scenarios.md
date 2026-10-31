# Payload, transport and shared-network faults

These version-1 actions are explicit invalid cases. Healthy defaults, existing
status rules, fingerprints and the original `stall`/`abort` behavior are preserved.
Simulator delivery and player recovery are separate results; the HTTP verifier
below makes no browser recovery claim.

## Payload controls

| Preset | Target / effect | Valid control and prerequisites |
| --- | --- | --- |
| [next-malformed-manifest.json](../examples/scenarios/next-malformed-manifest.json) | Root manifest GET: invalid HLS duration syntax or unclosed DASH XML. Change the manifest target to an advertised HLS video/audio alias to test a child playlist. | The next response is the original valid manifest. HEAD is excluded. |
| [next-damaged-media.json](../examples/scenarios/next-damaged-media.json) | `video:0` media: replace the first up-to-4,096 bytes with `0xff`, preserving length and the remaining bytes. | The next download of that resource returns genuine unchanged media. |
| [next-wrong-track-init.json](../examples/scenarios/next-wrong-track-init.json) | `video:0` init receives captured `audio:0` init bytes. | After starting the run, first fetch the advertised audio init donor. The normal video init is the valid control. |
| [next-stale-init.json](../examples/scenarios/next-stale-init.json) | The second GET for a video init returns its first captured generation. | An owned origin must change matching video init **and media** before the second GET. The third GET returns the fresh init. |

Payload actions require a complete nonempty 200 response. Ranges are rejected
with 422 rather than pretending that a partial object is a valid initialization
control. Missing donors, identical old/current init bytes or invalid manifest
controls are also rejected and do not count as applied faults. Failed actions
remain visible in the report; reset/restart before another run.
Only advertised, successfully downloaded init objects can become snapshots; no
payload accepts an arbitrary server filename or URL. Snapshots own their copied
bytes and are limited to 128 tracks / 64 MiB per run. Reset/shutdown clears them.
Payloads cannot combine with status/transport actions, network timelines, outage
rules or HTTP `expectRetry` assertions. Restoration is compared by delivered bytes.
The manual catalog disables stale-init for the built-in immutable-init samples.

HLS TS defaults support manifest and damaged-media cases. Init cases use a
faithful fMP4 origin. DASH uses advertised MPD track identities. The verifier owns
a procedural fMP4 source for init epoch changes, since the upstream loop engine
does not expose an encoder-generation lifecycle. The owned source changes both
init and matching media; returning arbitrary damaged bytes is not a stale-init
verification. This does not add a public caption/audio support claim.

## Transport controls

| Preset | Delivery |
| --- | --- |
| [next-video-header-delay.json](../examples/scenarios/next-video-header-delay.json) | Wait two seconds **before sending response headers**, then send the original bytes. |
| [next-video-drip.json](../examples/scenarios/next-video-drip.json) | Send at most 8,192 bytes per write, with a 100 ms gap between writes, under a 15 s overall deadline. |
| [next-video-content-length.json](../examples/scenarios/next-video-content-length.json) | HTTP/1.1 declares 16 more bytes than it delivers, then closes. The full original body is present but its message is incomplete. |
| [next-video-chunked.json](../examples/scenarios/next-video-chunked.json) | HTTP/1.1 uses chunked encoding with an invalid `Z` chunk-size token. It delivers no valid media body. |

Change `target.resource` to `manifest`/`init` with a matching track to target those
resources. HEAD never consumes an action. A successful same-resource retry is
required by these presets. The framing verifier reads raw HTTP bytes; an HTTP
status or Content-Type header alone cannot prove a framing fault.
These actions buffer bounded bodies like the existing transport implementation
(128 active bodies / 64 MiB total). Timers, artificial gaps, bandwidth waits and
slow-reader backpressure share a hard deadline of at most 60 seconds. Drip
configurations whose minimum gap time already exceeds their deadline fail before
headers. Cancellation/shutdown releases retained bodies and owned work.

## Explicit network composition

Only media `header-delay`/`drip` actions can opt into a shared bandwidth/jitter
timeline with `transport.network: true`. They use the **same** limiter as ordinary
concurrent media requests. Bandwidth changes affect an already active response;
the header delay, drip gaps and limiter waits all count toward its body deadline.
Manifest/UTC bodies remain outside the bandwidth cap; manifests retain the
existing timeline jitter behavior. Zero still means unlimited.

```json
{
  "version": 1,
  "seed": 42,
  "rules": [{
    "target": {"track": "video:0", "segment": "next"},
    "transport": {"kind": "drip", "afterBytes": 0, "chunkBytes": 8192,
      "intervalMs": 20, "deadlineMs": 15000, "network": true},
    "expectRetry": true
  }],
  "timeline": [
    {"afterMs": 0, "beforeMs": 5000, "network": {"bandwidthKbps": 50, "jitterMs": 25}},
    {"afterMs": 5000, "beforeMs": 10000, "network": {"bandwidthKbps": 1500, "jitterMs": 25}}
  ]
}
```

Other transport/timeline mixtures, init/manifest composition, freeze composition
and payload mixtures are rejected. The old `stall`/`abort` definitions still
reject timelines; adding a timeline cannot silently change their delivery.

## Setup examples and verification

```sh
npm run build
node dist/cli.js livesim --sim-type hls --scenario examples/scenarios/next-damaged-media.json --fault-config output/payload-faults.json
node dist/cli.js livesim --sim-type dash --asset abr --scenario examples/scenarios/next-video-drip.json --fault-config output/drip-faults.json
```

Use an all-off file for every scenario. For interactive start/reset, use
[manual runs](scenario-controls.md). To exercise fMP4 init controls, start the
owned source (`node scripts/resource-scenarios/origin.cjs --port 8898`) and proxy
its printed HLS URL with `--manifest-url URL --no-dummy-content`. Fetch advertised
playlists before initialization; fetch the audio donor before the wrong-track
video init. Stale-init additionally requires an origin with a real init/media
generation change; the standalone static origin alone does not change generations.

```sh
npm run faults:verify -- --output output/core-faults
npm run faults:verify -- --protocol hls --suite payload --output output/hls-payload
```

The isolated Node-only matrix checks 40 cases: eight payload, 24 transport
(resource × action × protocol), and eight shared-network completion/cancellation
cases. It retains scenario definitions, hashed body controls, request diagnostics,
raw framing responses and reports tied to the exact commit/dirty-tree state.
It checks HEAD exclusions, healthy alternate resources and local UTC, actual
bytes/framing, active rate changes, same-resource restoration and drained
ownership after shutdown. Negative acceptance tests cover malformed definitions,
unsupported combinations, unavailable/equal donors, snapshot capacity, impossible
drip timing, deadlines/backpressure, and separate HLS child-playlist isolation.
This is simulator evidence; targeted browser outcomes and the full healthy
playback gate remain distinct release requirements. CI is configured to retain
this matrix for seven days.
