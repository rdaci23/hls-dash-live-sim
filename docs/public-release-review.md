# HLS and DASH simulator public release review

The useful core is a local streaming test tool for player developers and QA:
serve a known stream, inject a failure, and observe recovery on a browser or device.
The recovered implementation proves parts of that workflow, but several advertised
stream characteristics are metadata or placeholders. It needs correctness and
process-safety work before a public release can be trusted.

Historical baseline review. See [implementation status](implementation.md) for the fixes and current verification.

Review date: 28 October 2026. Reviewed commit: `55952e9`.
The repository remains private. No simulator implementation was changed in this
review. The attached [observations](research-evidence.json) distinguish measured
behavior from the additional source findings below.

## What the tool does today

| Area | Actual behavior | Useful today |
| --- | --- | --- |
| Bundled HLS | A fixed playlist repeats two video segment files and two audio files; it ends after the generated duration. | Initial player integration and basic segment failure handling. |
| Remote HLS proxy | Fetches a manifest and rewrites some references through local playlist, segment and key routes. | Controlled debugging of simple HLS origins. |
| HLS manifest substitution | Keeps parts of a remote master while substituting the same local sample media. | Inspecting selected manifest metadata; playback fidelity is limited. |
| DASH | Starts the DASH Industry Forum livesim2 Docker image, optionally behind a Node proxy. | An entry point to livesim2 plus local fault injection. |
| DASH preservation and periods | Rewrites or constructs MPDs and attempts to translate their segment paths. | Experimental; segment mapping has reproducible failures. |
| Templates | Five named presets, personal JSON storage and manifest import commands. | Selecting presets and storing metadata; several settings do not affect emitted media. |
| Fault controls | HTTP status failures, body truncation, fixed delay, manifest freeze, and limited HLS key faults. | Manual negative testing, subject to the bugs below. |
| Reporting | Console request logs, startup descriptions and local/LAN URLs. | Manual diagnosis; no assertion of player recovery. |

The existing three integration tests pass. They verify HTTP responses and selected
control behavior; they do not prove continuous playback, live timing, ABR changes,
DRM, low latency, multi-period playback or device compatibility. `npm audit`
reported zero dependency advisories for the installed lockfile on the review date.

## Bugs that block a dependable public release

Priority 0 means remove the behavior before sharing the tool for general use.
Priority 1 means a supported workflow is incorrect or misleading. Each item states
whether its evidence is a runtime reproduction or source inspection.

### Priority 0 Port cleanup can kill unrelated processes

**Source inspection.** [dash-sim-runner.ts](https://github.com/rdaci23/hls-dash-live-sim/blob/55952e9712d6386e6bca6f3366bcf7d203fd1897/src/support-tools/dash-sim-runner.ts#L1351)
finds processes using the requested port with `lsof` and executes `kill -9` against
all returned PIDs. A second aggressive-cleanup path repeats it after bind failure.
There is no ownership check. Starting a test tool can terminate a developer's other
server, or potentially a process connected to that port.

Remove this cleanup. Return a port-in-use error or allocate another port. Only stop
processes and containers recorded as owned by the current session. Acceptance:
start an unrelated local server, request its port, and prove that server survives.
The destructive path was not executed during this review.

### Priority 0 HLS proxy destinations can receive origin credentials

**Reproduced with local fixtures and a dummy token.**
The `/seg?u=...`, `/pl?u=...` and `/key?u=...` routes accept arbitrary target URLs.
Configured origin authorization is reused for the requested target. A second local
origin received `Bearer audit-test-only` through the segment route. The Node
streaming server and the default control UI also listen beyond loopback.

Bind to loopback by default and require explicit LAN serving. Resolve proxy
destinations through server-issued resource IDs or validate against declared
origins. Scope credentials to their intended origin and recheck scope after any
redirect. Give LAN control access a separate explicit policy. Acceptance: an
undeclared origin receives neither a request nor a configured authorization header.

### Priority 1 Bundled HLS does not advance as live content

**Reproduced.** [buildLoopingPlaylist](https://github.com/rdaci23/hls-dash-live-sim/blob/55952e9712d6386e6bca6f3366bcf7d203fd1897/src/support-tools/hls-sim-runner.ts#L264)
returns `MEDIA-SEQUENCE:0`, 100 entries referring to only two unique video URLs,
and `EXT-X-ENDLIST`. The response remains identical after a target-duration
interval. Thus live edge, DVR-window, stale-playlist and live-recovery behavior
cannot be meaningfully tested with this mode.

Introduce a session clock, sliding window, increasing sequence numbers and
time-based segment availability. Keep explicit VOD and EVENT modes alongside
LIVE mode. A live media playlist without ENDLIST must publish new segments as
specified in [RFC 8216](https://datatracker.ietf.org/doc/html/rfc8216#section-6.2.2).
Acceptance: playlist updates advance sequence and availability over several reloads;
freeze stops that advancement and unfreeze resumes it.

### Priority 1 The sample audio and video timelines disagree

**Reproduced.** The generated video playlist describes 600 seconds, while its
separate audio playlist describes 518.4 seconds. Both repeat the same number of
cycles despite different cycle lengths. The playlists add no discontinuity tags
when media timestamps return to the beginning of the original files.

Replace the sample with aligned, documented fixtures and either rewrite timestamps
for continuous looping or signal aligned discontinuities. Probe encoded media, not
only playlist strings. Apple's [authoring specification](https://developer.apple.com/streaming/hls-authoring-specification-for-apple-devices.html)
requires continuous timestamps or declared discontinuities and accurate durations.
Acceptance: decode through multiple loops with aligned audio/video and no unexpected
timestamp regressions. The review used ffprobe on the bundled files; perceived
audio/video behavior still needs player testing.

### Priority 1 Templates do not deliver their advertised scenarios

**Reproduced and source-confirmed.** The low-latency preset emits byte-identical
HLS master and video playlists to default HLS, with no partial-segment tags.
The HLS template-start path does not apply bitrate ladder, segment duration or
SCTE-35 settings. The OTT description says 4K while the bundled video is 720p.

Have presets select validated assets and real engine options. Show capabilities
and reject unsupported combinations. Separate an intended scenario from the
measured properties of its selected asset. Acceptance: each supported preset
produces distinct verified behavior; unsupported latency, DRM and ad capabilities
are visibly unavailable rather than silently accepted.

### Priority 1 HLS import does not analyze the source

**Reproduced.** [createTemplateFromHls](https://github.com/rdaci23/hls-dash-live-sim/blob/55952e9712d6386e6bca6f3366bcf7d203fd1897/src/support-tools/stream-templates.ts#L184)
made zero requests to a local HLS source and returned a hardcoded 6-second duration
and bitrate ladder. It reports success even though its options and origin are not
analyzed. HLS template startup also discards its saved source URL.

Parse multivariant and media playlists, inspect representative child playlists,
record supported characteristics, and report unsupported tags. An unreachable
source must fail import unless the user explicitly chooses fallback defaults.
Acceptance: fixtures with different durations, ladders and audio groups produce
different imported configurations and validation failures are explicit.

### Priority 1 DASH duration conversion is wrong by the timescale

**Reproduced.** A SegmentTemplate with `duration="2000" timescale="1000"`
describes 2 seconds, but [template import](https://github.com/rdaci23/hls-dash-live-sim/blob/55952e9712d6386e6bca6f3366bcf7d203fd1897/src/support-tools/stream-templates.ts#L126)
stores `2000000` milliseconds, meaning 2,000 seconds. The parser returns duration
ticks; the importer treats them as seconds. Template startup introduces another
inconsistent duration conversion when building mock MPD information.

Define units explicitly, such as `durationTicks`, `timescale` and `durationMs`.
Convert once at well-defined boundaries. Acceptance: round-trip fixtures with
timescales 1, 1000, 12800 and 90000 preserve the same actual duration.

### Priority 1 The MPD parser fails on ordinary valid variations

**Reproduced.** Reordering `bandwidth` before `id` makes a Representation disappear;
`minimumUpdatePeriod="PT0.5S"` becomes zero; and a tested Representation's codec
attribute is lost. The current regular expressions also do not model adaptation
inheritance, namespaced XML, multiple timelines or separate audio/video correctly.

Use an XML parser and an explicit MPD model, with a declared supported subset.
Maintain distinct AdaptationSets and representations rather than flattening them.
Acceptance: attribute order, quoting, inherited SegmentTemplates, namespaces,
fractional durations and audio/video variants have fixtures and consistent output.

### Priority 1 Preserved DASH segment paths do not match the generated MPD

**Reproduced with the proxy in isolation.** The generated multi-period MPD uses
`1/$Number$.m4s`, producing `/__dash__/1/1.m4s`. The
[proxy handler](https://github.com/rdaci23/hls-dash-live-sim/blob/55952e9712d6386e6bca6f3366bcf7d203fd1897/src/support-tools/dash-fault-proxy.ts#L290) accepts only
`segment-<number>.m4s`. The generated-style path returned 404; the handler-style
path reached the fixture upstream. Alias paths also lack the leading slash used
when concatenating them with the upstream host. Several preserved MPDs hardcode
`localhost`, which points to the player device when opened on a TV.

Generate a manifest and its routing map from one representation model. Use
device-reachable relative URLs, include period identity, and verify initialization
and media resources across period boundaries. Acceptance: follow every URI from
the actual emitted MPD, on localhost and a separate LAN device, and decode through
at least two periods.

### Priority 1 DASH configuration mixes URL generator fields with stream options

**Source comparison with pinned livesim2 v1.7.0.**
[generateLivesimUrlForBase](https://github.com/rdaci23/hls-dash-live-sim/blob/55952e9712d6386e6bca6f3366bcf7d203fd1897/src/support-tools/dash-sim-runner.ts#L459) attaches
`?tsbd=...&stl=...&ato=...` to media URLs. livesim2's
[pinned configuration parser](https://raw.githubusercontent.com/Dash-Industry-Forum/livesim2/v1.7.0/cmd/livesim2/app/configurl.go)
reads options as path components. Its
[URL generator handler](https://raw.githubusercontent.com/Dash-Industry-Forum/livesim2/v1.7.0/cmd/livesim2/app/handler_urlgen.go)
converts form fields into paths such as `tsbd_60/` and `segtimeline_1/`.
The wrapper's prefilled `/urlgen/` link also does not match that handler's create
route and asset/MPD field contract.

Build a versioned livesim2 adapter and contract-test the effective MPD. Do not
infer success from the printed URL. The current
[URL documentation](https://github.com/Dash-Industry-Forum/livesim2/wiki/URL-parameters)
also uses path components. Acceptance: setting each supported option changes the
relevant engine output, and unsupported options fail validation.

### Priority 1 Signed and modern HLS references break during proxying

**Reproduced.** A child URL ending in `.m3u8?sig=demo` is classified as a segment,
so its returned playlist is not recursively rewritten. `EXT-X-MEDIA` audio URIs
and `EXT-X-MAP` initialization URIs remain unchanged. Similar gaps affect partial
segments and other URI-bearing tags. Segment and key requests do not consistently
handle redirects, cancellation, timeouts or all response encodings.

Classify using parsed URL path and content type, and use a playlist parser for
URI-bearing tags. Add controlled redirect handling with credential scoping and
bounded transfers. Acceptance: signed variants, alternate audio, subtitles,
fMP4 initialization, byte ranges and redirected resources remain reachable through
the proxy without leaking authorization.

### Priority 1 Faults do not reliably mean what the UI says

**Reproduced.** HLS child playlists keep advancing with manifest freeze enabled.
DASH freeze returns the first MPD ever fetched rather than the latest MPD before
freezing. Truncating a DASH segment while retaining its original Content-Length
caused the client to wait until timeout rather than receive a complete malformed
response. The observed response did not distinguish intentional transfer failure
from intentional media corruption.

Freeze each changing resource at the requested point. Make media corruption,
connection truncation, stalled transfer and delayed response separate actions,
with correct headers for each. Acceptance: test status, headers, byte count,
completion time and client-visible behavior for every fault type.

### Priority 1 DRM controls overstate implemented support

**Source inspection and proxy observation.** DASH logs DRM settings but its
request handler does not apply them. HLS key mutations apply only to the `/key`
route of a remote encrypted source; they do not create encrypted sample content
or a commercial DRM license workflow. The default sample has no such key route.
Some preservation paths remove DASH ContentProtection while HLS can retain
metadata inconsistent with the substituted clear sample.

Rename the current supported behavior to HLS key-response faults. Hide controls
that do not apply to the active stream. Introduce real DRM fixtures only with
matching encrypted media, keys, license routing and explicit system support.
Acceptance: every enabled control has a reachable request and a demonstrated
player outcome.

## Reliability and maintenance gaps

- **Fault scope and repeatability:** `once` means once per resource URL, not one
  request across the stream. Two different sample segments both returned 404 for
  one injection. Random decisions use a fixed 40 percent threshold, are cached
  per resource, and have no seed. Config changes clear these maps, rearming
  injections. Model fault rules with explicit scope, counters, seed and lifetime.
- **Configuration:** invalid fault modes, negative latency and unknown fields are
  accepted with HTTP 200. File loading shallowly merges nested values and silently
  falls back on parse errors. Saves are not atomic, watchers target the file inode,
  and persistence failure can still be reported as success. Validate schemas,
  watch atomic replacements, keep the last valid config and return real errors.
- **Lifecycle:** Node processes and containers have different detach/stop behavior.
  The DASH proxy registry lives in process memory, so a separate stop command
  cannot stop the original proxy through that registry. There are no coordinated
  signal handlers. Add session IDs, ownership records, health checks and predictable
  foreground/background modes.
- **Session isolation:** fault state and DASH preservation configuration are module
  globals. Multiple in-process sessions can overwrite each other's state. Own all
  mutable state in a session object.
- **Browser delivery:** the DASH proxy does not consistently add CORS headers;
  the fixture upstream produced no allow-origin header. OPTIONS returned a proxied
  media response rather than a CORS preflight. HEAD, caching and Range behavior
  need defined contracts. Test them separately from stream-fault semantics.
- **Latency realism:** both proxies buffer whole upstream responses. A fixed delay
  is not a bandwidth limit, jitter, packet-loss model or low-latency chunk delivery.
  Stream healthy responses with backpressure and define precise network actions.
- **CLI correctness:** unknown simulator flags are accepted, duration parsing
  accepts numeric prefixes, ports and period counts lack strong validation, and
  `--showManifest` guesses a URL that can differ from the selected preserved MPD.
  Return structured startup details and use them consistently in CLI and UI.
- **Template storage:** built-in-versus-saved precedence differs between listing
  and retrieval; writes can fail while success is logged; input lacks a versioned
  schema. Add validation, migration and consistent duplicate-name behavior.
- **Public packaging:** no project license, media attribution/generation record,
  CI workflow or contribution guidance is tracked. Verify source and asset
  redistribution rights, choose a project license and document upstream notices
  before public distribution. `private: true` still blocks npm publication if npm
  distribution is later chosen. Shell `chmod` in the build also needs a Windows
  compatible packaging path.

## Product direction that would make the tool useful

The proposed audience is video-player developers, streaming QA engineers and device
integrators. The main job is to reproduce a playback failure reliably enough that
another developer or CI runner can observe the same failure and recovery.

### First public release

1. **A trustworthy sample stream:** one validated HLS live fixture and one validated
   DASH live fixture, with accurate capability descriptions and local/LAN URLs.
2. **One scenario format:** a versioned JSON file defines asset, protocol, timeline,
   origin policy and fault rules. The same configuration works in CLI and UI.
3. **Deterministic fault rules:** match request kind, track, representation, segment
   number or time; define count, duration, retry behavior and optional random seed.
4. **Useful recovery cases:** fail one segment then recover, freeze a playlist for
   a duration, delay one rendition, interrupt initialization, expire an HLS key,
   and return a temporary server outage. Ship expected behavior with every example.
5. **Observable sessions:** show the active stream, supported controls, pending and
   consumed faults, request timeline and effective configuration. Export sanitized
   events with session and scenario IDs.
6. **Automation:** health/readiness endpoints, predictable exit codes, JSON output,
   a headless mode and a command that runs a named scenario and exports a result.

An example proposed scenario is: start a known live stream; fail the first request
for video segment 12; allow its retry; freeze the video playlist from 30 to 40
seconds; then resume. Save the seed and emitted events. A player run can then
measure whether it stalls, recovers, or needs user action. This is substantially
more useful than a preset called sports whose settings are not applied.

### Features to add after the core is dependable

| Feature | Benefit | Suggested order |
| --- | --- | --- |
| Browser preview with request and playback events | Connects an injected fault to the player's actual response. | Early; use hls.js and dash.js adapters. |
| Network conditions by representation | Makes ABR fallback and recovery testable. | Early; bandwidth caps, jitter and timed outages. |
| Manifest inspector and capability report | Explains what an import contains and what can be simulated faithfully. | Early. |
| Shareable sanitized scenarios | Lets users attach a reproducible case to a bug report. | Early; keep tokens and signed URLs out of exports. |
| Audio, subtitle and track switching fixtures | Covers common OTT integration failures beyond basic video. | Next. |
| Discontinuity, timestamp and multi-period scenarios | Tests transitions, seeks and recovery across program boundaries. | Next, using validated timeline behavior. |
| Clock skew, stale CDN responses and DVR-window eviction | Reproduces live-only failures that static VOD cannot expose. | Next. |
| SCTE-35 and ad transition fixtures | Supports testing cue handling and content/ad transitions. | After timeline correctness; distinguish signaling from real insertion. |
| LL-HLS and low-latency DASH | Supports chunk timing, blocking reloads and latency recovery. | Later; requires real transport and media support. |
| ClearKey and other DRM fixtures | Enables encrypted playback and license-failure testing. | Later; declare each supported system explicitly. |

Use player events to correlate requested faults with buffering, quality changes and
errors. [dash.js exposes playback and metrics events](https://dashif.org/dash.js/pages/usage/player-events.html);
[hls.js provides a browser HLS player and API](https://github.com/video-dev/hls.js).
Browser results should remain distinct from native Roku, AVPlayer and ExoPlayer
results, since those clients can recover differently.

## Architecture and implementation order

Keep one session manager and one validated scenario model. Put fault matching,
counters, clock and event recording in a shared engine. Give HLS generation,
remote HLS proxying and livesim2 separate adapters with explicit capabilities.
The HTTP transport should own timeouts, redirects, credential scope, CORS and
streaming; it should not infer scenario semantics from a filename.

livesim2 already exposes periods, subtitle generation, encryption options and
network fault patterns in its [official parameter reference](https://github.com/Dash-Industry-Forum/livesim2/wiki/URL-parameters).
Reuse supported upstream behavior through a tested adapter. Its
[release page](https://github.com/Dash-Industry-Forum/livesim2/releases)
lists v1.15.3 at review time; this project pins v1.7.0. Evaluate an upgrade against
asset and scenario tests before changing the pin. The product's added value should
be the common scenario workflow, safe local operation and useful evidence.

| Milestone | Deliverable | Acceptance condition |
| --- | --- | --- |
| 1 Safe operation | Remove arbitrary process killing; loopback defaults; origin-scoped credentials; input validation. | Port collision cannot harm another process; undeclared origins receive no credentials; invalid config fails explicitly. |
| 2 Correct streams | Live HLS clock and aligned fixtures; parsed manifests; fixed units; corrected DASH adapter and routing. | Actual hls.js/dash.js playback survives multiple loops and period transitions with expected media properties. |
| 3 Reproducible failures | Versioned scenarios, deterministic rules, session isolation and fault timeline. | Repeating a scenario produces the same logical faults and an intelligible event trace. |
| 4 Public beta | Documentation, examples, media provenance, license, CI and supported-platform matrix. | A new contributor can install, start both protocols, run a scenario and understand the result from a clean checkout. |
| 5 Broader coverage | Track switching, ABR/network conditions, then ads, low latency and DRM. | Each added capability has real fixtures, a player demonstration and automated regression coverage. |

## Reproducing the observations

Run from the repository root:

```sh
npm run build
npm run test:docker
npm test
```

The archived prototype research script is observational: its JSON includes current defects rather
than treating them as passing functionality. It uses temporary configuration,
local HTTP fixtures and a dummy authorization value, then stops its own servers.
The recorded [evidence](research-evidence.json) belongs to the reviewed commit;
retain it as a historical record; current results belong in implementation.md.

The Docker daemon was unavailable, so full livesim2 backend startup and playback
remain unverified. Preserved-path behavior was reproduced directly against the
Node DASH proxy. No browser or native-player playback results are claimed here.
