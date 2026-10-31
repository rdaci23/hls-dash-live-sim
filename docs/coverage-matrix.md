# Core coverage and verification boundaries

The [roadmap](scenario-roadmap.md) records execution checkpoints. This matrix
states what each check establishes; a local result from an older commit does not
qualify the publication candidate. Exact-candidate CI and the full release review
remain required. Repository visibility and npm publication require separate approval.

| Capability | Simulator evidence | Browser evidence and limits |
| --- | --- | --- |
| Healthy live baselines | Advertised media, timestamps, publication, retention and local UTC. | Existing HLS/DASH three-minute, first-frame and played DASH Period gates remain required. |
| Status/retry faults | Media/manifest/init targeting; three failures then the same download succeeds; HEAD exclusions. | Startup and established 404 recovery have dedicated checks with measured continuation. |
| Selective rendition outages | HLS high/low and DASH low isolated; other media/init/manifests/UTC healthy, same bytes restore. | High/low fallback and re-entry are separate observations; every profile has not shown both switches. |
| Starvation/oscillation/shaping | Nonzero below-minimum cap, four cycles, shared pacing, bytes, cancellation, active rate changes. | Fault-associated buffering and adaptation retained separately. A successful HTTP rate check is not an ABR pass. |
| Manual scenario runs | Authentication, session/run isolation, immutable definitions, fresh IDs, scoped reset and retained results. | Real UI checks cover catalog/controls, inert reads and evidence export. |
| Invalid payloads | Malformed HLS/MPD, damaged media, wrong-track init and genuinely stale init/fresh-media pairs. | Targeted malformed/media/wrong-init observations are separate; stale-init automatic recovery remains unverified. |
| Bounded transport | Header delay, body stall, abort, slow progress, explicit HTTP/1.1 framing, bytes and cleanup. | Targeted framing observation; browser recovery for every transport/network composition is unverified. |
| CDN/cache/publication | Recorded fresh/newer/stale identity, real negative cache, origin/edge isolation, rendition lag and delayed complete availability. | Targeted rollback/lag/late-caption observations; no general CDN compatibility claim. |
| HTTP policy | Safe failure statuses/headers, Retry-After, validators/304, ranges/416, If-Range and resumed bytes. | Independent wire/HTTP evidence. Player-specific handling of every status/header is unverified. |
| Independent tracks | Owned fMP4 HLS with separate audio, DASH tracks, two authored tones, timed WebVTT/wvtt, third rung, asymmetric shaping. | Healthy checks require decoded tone, language switching and correctly timed active/empty cues; fault observations separately cover audio/text outage and late captions. |
| Valid restart/event ending | Aligned HLS discontinuity/new MAP and DASH Period/PTO, compatible coded times and retained finite media. | Both protocols have rendered restart and native `ended` checks. |
| Invalid lifecycle/DVR | Unannounced timestamp reset, sequence rollback, incompatible URL reuse; bounded retention, seek/join/freeze HTTP restoration. | User pause/seek is separate from automatic recovery. Startup outage and long-freeze client limits remain in the roadmap. |
| Offline AES | Local AES-128 rotation, clear/encrypted transitions, unavailable/wrong key responses; byte integrity and decryption checks. | Three-minute decoded encrypted baseline; automatic wrong-key recovery is unverified. |
| Access expiry/renewal | Local expiry, old-token denial, renewal restores the same logical media, no diagnostic secrets. | Explicit auth client renews on actual 401 and retries once before delivering to the player. This is not bare-player 401 recovery. |
| UTC faults | Explicit local UTC GET/HEAD failure, malformed response and bounded skew; other HEAD exclusions remain. | Normal synchronization stays enabled. Playback recovery from every clock fault is unverified. |
| Concurrent endurance | One browser plus two HTTP viewers per protocol, churn/slow reads/cancel, A/V markers, retention/fairness, memory and drained ownership. | Ten-minute smoke and four-hour soak require actual elapsed time, complete diagnostic parts and the exact candidate. Short development runs cannot qualify them. |

Named-fault errors remain visible. Unexplained exceptions during healthy playback
block verification. A documented client limitation is not relabelled as a simulator
defect or hidden by changing the player retry settings without recording them.

See [targeted browser observations](browser-scenario-observations.md),
[endurance](endurance.md) and [publication preparation](publication-preparation.md).
Commercial DRM, ads, low-latency protocols, HTTP/2/3 simulation and virtual clocks
are deferred. Apple, Android, additional Roku hardware and internet-isolated Roku
playback are unverified; native recovery development is outside this repository.
