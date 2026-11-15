# Core coverage and verification boundaries

The [roadmap](scenario-roadmap.md) records execution checkpoints. This matrix
states what each check establishes; a local result from an older commit does not
qualify the publication candidate. The exact-candidate full local release review
remains required. Hosted checks are paused under the
[local-only policy](development.md#github-actions); untested environments remain
unverified. The GitHub repository is public (public beta), and the package is published to
npm.

| Capability | Simulator evidence | Browser evidence and limits |
| --- | --- | --- |
| Healthy live baselines | Advertised media, timestamps, publication, retention and local UTC. | Existing HLS/DASH three-minute, first-frame and played DASH Period gates remain required. |
| Status/retry faults | Media/manifest/init targeting; three failures then the same download succeeds; HEAD exclusions. | Startup and established 404 recovery have dedicated checks with measured continuation. |
| Selective rendition outages | HLS high/low and DASH low isolated; other media/init/manifests/UTC healthy, same bytes restore. | High/low fallback and re-entry are separate observations; every profile has not shown both switches. |
| Starvation/oscillation/shaping | Nonzero below-minimum cap, four cycles, shared pacing, bytes, cancellation, active rate changes. | Fault-associated buffering and adaptation retained separately. A successful HTTP rate check is not an ABR pass. |
| Session-scoped controls | Separate authenticated manual/scenario modes, session/revision/run checks, private settings, scoped cancellation, immutable definitions and retained results. Legacy shared-file behavior remains separate. | Real HLS/DASH UI checks cover Prepare/Start/Stop, inert discovery, stable manifest exports, draft conflicts, reconnect boundaries and narrow keyboard workflows. Player recovery remains a separate check. |
| Invalid payloads | Malformed HLS/MPD, damaged media, wrong-track init and genuinely stale init/fresh-media pairs. | Targeted malformed/media/wrong-init observations are separate; stale-init automatic recovery remains unverified. |
| Bounded transport | Header delay, body stall, abort, slow progress, explicit HTTP/1.1 framing, bytes and cleanup. With `--http2`, each action on its own HTTP/2 stream (RST_STREAM with an error code) while sibling streams on the connection continue. | Targeted framing observation; browser recovery for every transport/network composition is unverified. |
| CDN/cache/publication | Recorded fresh/newer/stale identity, real negative cache, origin/edge isolation, rendition lag and delayed complete availability. | Targeted rollback/lag/late-caption observations; no general CDN compatibility claim. |
| HTTP policy | Safe failure statuses/headers, Retry-After, validators/304, ranges/416, If-Range and resumed bytes. | Independent wire/HTTP evidence. Player-specific handling of every status/header is unverified. |
| HTTP/2 over TLS (opt-in) | ALPN h2 with HTTP/1.1 on the same port; parts, held preload hints, blocking reloads and delta updates on multiplexed streams; statuses, payload faults, stalls, drip, bandwidth limits, session controls and diagnostics; per-stream resets for abort/reset/no-response/framing; `:authority` host checks; prompt shutdown. | One 75-second simulator run each: Safari 26.4 and tvOS AVPlayer about 2.1 s behind live, hls.js in Chrome 2.4 s. Safari and AVPlayer in the simulators replayed the HLS [fault matrix](device-fault-matrix.md#low-latency-hls-over-http2-apple-simulators) over HTTP/2. No Apple device or LAN observation over HTTP/2. |
| Independent tracks | Owned fMP4 HLS with separate audio, DASH tracks, two authored tones, timed WebVTT/wvtt, third rung, asymmetric shaping. | Healthy checks require decoded tone, language switching and correctly timed active/empty cues; fault observations separately cover audio/text outage and late captions. |
| Valid restart/event ending | Aligned HLS discontinuity/new MAP and DASH Period/PTO, compatible coded times and retained finite media. | Both protocols have rendered restart and native `ended` checks. |
| Invalid lifecycle/DVR | Unannounced timestamp reset, sequence rollback, incompatible URL reuse; bounded retention, seek/join/freeze HTTP restoration. | User pause/seek is separate from automatic recovery. Startup outage and long-freeze client limits remain in the roadmap. |
| Offline AES | Local AES-128 rotation, clear/encrypted transitions, unavailable/wrong key responses; byte integrity and decryption checks. | Three-minute decoded encrypted baseline; automatic wrong-key recovery is unverified. |
| Access expiry/renewal | Local expiry, old-token denial, renewal restores the same logical media, no diagnostic secrets. | Explicit auth client renews on actual 401 and retries once before delivering to the player. This is not bare-player 401 recovery. |
| UTC faults | Explicit local UTC GET/HEAD failure, malformed response and bounded skew; other HEAD exclusions remain. | Normal synchronization stays enabled. Playback recovery from every clock fault is unverified. |
| Concurrent endurance | One browser plus two HTTP viewers per protocol, churn/slow reads/cancel, A/V markers, retention/fairness, memory and drained ownership. | Required ten-minute smoke needs actual elapsed time, complete diagnostic parts and the exact candidate. Four-hour stress testing is optional and reported separately. Short development runs cannot qualify either duration. |

The [accepted beta limitations](release-review.md#accepted-beta-limitations--7-november-2026)
record the failed DASH startup and text-outage observations and their successful
targeted reruns. They do not broaden browser recovery claims.

Named-fault errors remain visible. Unexplained exceptions during healthy playback
block verification. A documented client limitation is not relabelled as a simulator
defect or hidden by changing the player retry settings without recording them.

Extended concurrent stress testing has an unresolved aggregate-memory failure
after 71.3 minutes at `42ed300`; see the
[retained checkpoint](scenario-roadmap.md#ten-minute-qualification-and-optional-extended-testing--2-november-2026).
The ten-minute Linux smoke passed independently. No four-hour qualification is
claimed, and a changed candidate needs fresh required checks.

See [targeted browser observations](browser-scenario-observations.md),
[endurance](endurance.md) and [publication preparation](publication-preparation.md).
[Low-latency HLS and DASH, an fMP4 ladder and HLS ad markers](generated-streams.md)
are generated, with one Chrome/hls.js check each for the HLS shapes, one check
of Apple's player in the iOS and tvOS simulators, one check of Media3 ExoPlayer in
Android phone and TV emulators for every HLS and DASH shape, and no release gate.
Over HTTP/1.1, Apple's players play low-latency HLS at normal latency; with the opt-in
[HTTP/2 over TLS](configuration.md#http2-over-tls) they played it about 2.1
seconds behind live in one simulator run each. ExoPlayer used parts and blocking
reloads over HTTP/1.1. HTTP/2 delivery, held requests,
delta updates, faults, session controls and shutdown have simulator tests in
`test/http2.test.cjs`.
The [device fault matrix](device-fault-matrix.md) records how a Roku Express 4K,
Safari, AVPlayer and ExoPlayer (Android emulators) handled the same fault
scenarios; it is exploratory evidence, and simulator and emulator results are not
device evidence. Commercial DRM, ad insertion logic, HTTP/3 and virtual
clocks are deferred. Apple and Android devices, additional Roku hardware and
internet-isolated Roku playback are unverified; native recovery development is
outside this repository.
