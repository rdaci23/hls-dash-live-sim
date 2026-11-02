# Endurance and concurrent viewers

The endurance runner uses the owned local tracks source, one real Chrome viewer
and two independent HTTP viewers **per protocol**, concurrently. It needs no
Docker, external clocks or media. The repository/npm remain private.

The endurance viewer controls sandboxed Chrome through a bounded CDP pipe using
Runtime, Page and Log events. It retains the shared player page, normal player
settings and every decoded audio/caption/frame sample. Main-page and worker
exceptions and console errors remain release blockers. Independent HTTP viewers
retain the wire checks; Chrome network-observation bookkeeping is unnecessary for
this runner. Protocol calls, buffers, owned Chrome process groups and temporary
profiles must drain on close.

```sh
npm run endurance:cleanup -- --output output/endurance-interruption
npm run endurance:driver -- --output output/endurance-driver
npm run endurance:smoke -- --output output/endurance-smoke
npm run endurance:release -- --output output/endurance-candidate
# Short harness development only; cannot qualify either release gate:
npm run endurance:dev -- --development-seconds 90 --output output/endurance-development
```

Smoke runs for ten actual minutes after both viewers are ready. Release mode runs
for four actual hours; it cannot be shortened with development flags. A machine
sleep, interruption, source error, missing evidence or changed working tree cannot
qualify. Reports retain the exact commit and distinguish development, smoke and
release-soak qualification. No mode publishes, tags or changes visibility.

For driver-memory diagnosis, add `--profile-memory` to release mode and use a new
output directory. This marks the report `diagnosticOnly` and disables both
qualification flags. After measurement stops, it records allocation stacks and
before/after diagnostic garbage-collection statistics in
`driver-memory-profile.json`; it does not capture heap object contents. Normal
commands retain ordinary GC and the same RSS/workload gates.

The packaged [smoke profile](../examples/scenarios/endurance-smoke.json) and
[four-hour profile](../examples/scenarios/endurance-four-hour.json) expose the
network schedule in the scenario catalog. Running a profile alone is not the
concurrent-viewer verifier or qualification. The final bandwidth cap has a bounded
one-minute shutdown grace so independently started source clocks cannot release
queued bodies just before the common measurement deadline. Qualification still
requires the full ten minutes or four hours; grace does not shorten or accelerate
that interval. Every attempted cancellation is retained before its assertion.

## Workload and gates

- Both HTTP viewers download distinct advertised video/audio/text tracks, retain
  bounded body identities, check repeated-byte stability and advancing decoded/
  advertised publication times, then verify expired media is unavailable.
- Independent keep-alive agents actually leave/rejoin. Slow readers, cancellations
  and in-flight shared limiting run throughout; manifests and DASH UTC stay healthy.
- A short 1,200 kbps shared-cap interval exercises three competing range readers,
  with actual wire chunks, equal-progress bounds and byte identity. HTTP body
  polling pauses around that interval so the test does not accidentally introduce
  an additional sustained starvation scenario. The normal shared cap is 3,000 kbps.
- Each browser requires a first rendered frame within ten seconds, continued
  rendered progress and no unexplained player errors, exceptions or gap over four
  seconds. Decoded audio and correctly timed active/empty captions are sampled
  repeatedly; advancing video alone does not qualify them.
- The source has authored eight-second markers: a white corner pulse and a louder
  audio tone for 0.4 seconds. The browser observes actual video pixels and decoded
  audio energy independently. Pulse separation must stay within 250 ms and drift
  within 150 ms of the initial five-cycle median. These bounds account for the
  analyser window and 100 ms sampling; they do not measure speaker latency.
- Each simulator runs in a separate owned Node process. The driver and both
  simulators are sampled against their own post-warm-up baselines, each with
  a maximum increase of 128 MiB. Their combined growth must also stay within
  128 MiB; separating processes cannot hide combined growth. OS high-water RSS
  is retained. Browser-process memory is recorded separately.
  Ordinary Node allocation/GC settings apply. Live index refreshes stage only the
  advertised changes, DASH metadata and indexing share one validated XML parse,
  and diagnostic recording reuses its field tables and reads verbosity directly.
  Origin reads use bounded native HTTP streams and release their deadline timers
  and parent-cancellation listeners when complete. HTTP track probes use the
  existing bounded native viewer rather than retaining Fetch timeout graphs;
  metadata-only reads avoid copying event windows during owner shutdown.
  In-memory diagnostics serialize only when a file or verbose output needs the
  line; snapshots/exports retain the same bounded event window. The browser routing
  precheck uses an actual owned HTTP 302 to verify blocked redirects before the
  unchanged 10,000-request, 128 MiB allowed-request check.
  Timeline boundary tables are built once, settlement reads avoid full phase
  reports, and fault runtimes retain private config copies refreshed by the
  existing change subscription rather than cloning config on each request.
  Manual-conflict checks read a scalar refreshed with config changes. Identical
  small HLS playlists reuse their rewrite with refreshed reference expiry; the
  string cache is bounded to 2 MiB and upstream manifests are still fetched fresh.
  HTTP viewer probes avoid duplicate parsing, header copies and Fetch buffering.
  Diagnostic windows reuse private fixed-shape records and validation patterns;
  snapshots still return independent objects with absent optional fields omitted.
  These reduce transient allocation while preserving retention and complete logs;
  the warm-up, workload and 128 MiB individual/shared limits remain the same.
- Resource indexes, pending work and transfer ownership are sampled. After close,
  all owned transfers/timers, active requests, indexes, buffered source files and
  source actions must drain, and every owned simulator and browser process must exit. The runner
  starts no containers and does not stop unrelated processes.

The four-hour test uses real source/publication/UTC clocks. Time acceleration and
fixed-time probes cannot substitute for it. Full engine browser baselines,
including played DASH Period transitions, remain separate candidate checks.

## Complete bounded evidence

Short recordings retain the original single-file behavior. Opt in to append-only
rotation for a long session:

```sh
npm run hls -- --fixture tracks --diagnostics-file output/requests.jsonl --diagnostics-rotate-files 64
```

Create the output directory first and choose a new file. Each CLI part is bounded
to 10 MiB; 2–256 parts are supported. Rotation preserves every part and writes a
closed manifest containing bytes, SHA-256, event counts and contiguous event IDs.
It never evicts earlier evidence. Reaching the configured bound makes recording
incomplete and fails verification; streaming itself can continue.

The endurance runner uses bounded parts for both source diagnostics and drained
browser/HTTP evidence. Smoke parts are 1 MiB; release source parts are 8 MiB with
at most 128 parts per protocol, and viewer evidence allows 64 parts. Keep each
manifest with **all** named files. Missing, modified, truncated, oversized or
out-of-sequence evidence fails the check, even if recent in-memory events remain.
Closed-file validation streams bounded chunks and retains only a bounded recent
event window. A replay regression measures actual RSS while repeatedly validating
a long trace. The owned browser viewer uses a native origin policy, including
redirect checks, without routing every healthy request through Playwright.
`npm run browser:routing` verifies blocked undeclared origins, blocked redirects
and 10,000 healthy requests within the memory budget.

The real-browser interruption check sends SIGINT, requires failed qualification
and checks that simulator/browser PIDs have exited, counters drain and closed files validate.
The review signals its soak coordinator once, allowing it to close its own
browsers, sources and journals. Repeated stop requests cannot send a second
termination signal during evidence closure; the real interruption check exercises
that path. Failed/interrupted runs still close their owned resources and retain partial
reports with explicit failure reasons.

Manual full CI runs the ten-minute smoke and retains evidence for seven days. The four-hour
release run is a separate candidate gate, also available through the optional
`release_soak` workflow-dispatch input. Select the exact candidate and retain the
resulting complete artifact; enabling the input alone does not qualify it. Check the actual run's report; a workflow
definition or a successful short development run is not endurance qualification.
See the [core roadmap](scenario-roadmap.md) and [release review](release-review.md).
