# Development and CI

## Environment

For a checkout, use Node.js 24 LTS and npm. Routine CI uses Ubuntu 24.04 and Node
24. Manual full checks cover Node 22, 24 and 26 on Ubuntu 24.04 and macOS 15.
The package still declares the legacy Node 20.3 engine floor;
that floor and Windows are not part of this CI matrix. Prefer a maintained Node
release. No runtime compatibility requirement is changed by this documentation.

```sh
npm ci
npm run build
```

DASH integration/playback additionally needs a running Docker daemon and the exact
engine image. Pull the constant used by the built adapter to avoid digest drift:

```sh
IMAGE=$(node -p 'require("./dist/support-tools/dash-sim-runner.js").DEFAULT_IMAGE')
docker pull --platform linux/amd64 "$IMAGE"
```

The image is AMD64-only; Docker emulates it on ARM. Browser checks need installed
Google Chrome, launched through the pinned Playwright dependency. On a disposable
Linux runner, CI installs Chrome/dependencies using
`npx --no-install playwright install --with-deps chrome`. On your own computer,
use your existing Chrome installation.

## Local checks

| Command | Coverage | Requirements |
| --- | --- | --- |
| `npm run test:ui` | Real legacy and session-scoped HLS/DASH UI journeys, discovery, drafts/conflicts, exports and keyboard/narrow-window checks. | Chrome; Node-only owned fixtures; no device. |
| `npm run endurance:driver` | Decoded native Chrome startup, CSP origin isolation, main/worker exceptions, console errors and owned-process/protocol cleanup. | Chrome; no Docker; about 30 seconds. |
| `npm run endurance:smoke` | Ten-minute concurrent HLS/DASH browser plus two HTTP viewers each, drift/RSS/cleanup and complete rotated evidence. | Chrome, no Docker; about ten minutes. |
| `npm run endurance:release` | Optional four-hour stress test, with the same ownership/evidence gates. | Chrome; explicit opt-in; keep the host awake; duration cannot be shortened. |
| `npm run services:verify` | Seven local key/auth/UTC HTTP cases, scope, restoration and redacted exports. | Node; no Docker. |
| `npm run browser:services` | Three-minute decoded AES baseline and HLS/DASH local-token renewal. | Chrome; no Docker. |
| `npm run lifecycle:invalid` | Six intentional timestamp/sequence/incompatible-URL checks; controls, HEAD and restoration. | Node, no Docker. |
| `npm run dvr:verify` | Retention expiry, join outage and 45-second freeze/resume HTTP checks. | Node, no Docker; about three minutes. |
| `npm run browser:dvr` | Explicit pause/seek and separate automatic join/long-freeze observations. | Chrome, no Docker; several minutes. |
| `npm run lifecycle:verify` | Owned aligned restart and finite event HTTP authoring, retained bytes and cleanup, both protocols. | Node; no Docker. |
| `npm run browser:lifecycle` | Rendered restart, decoded audio/captions and actual native event completion. | Chrome; no Docker; no restart/seek after initial configuration. |
| `npm run docs:check` | Local documentation link targets exist. Does not verify remote URLs or heading fragments. | Node; no network. |
| `npm run notices:check` | Lockfile inventory, preserved license/NOTICE hashes and scope match. | Node; no network or installed optional platform packages needed. |
| `npm run typecheck` | TypeScript checking. | Development dependencies. |
| `npm test` | Builds assets, then API, protocol, safety, diagnostics, scenarios, bandwidth/jitter timing and evidence regressions. | No Docker/browser; optional integrations are reported as skipped. |
| `npm run test:ui` | Real control-page JS, authentication, settings, latency and HLS/DASH viewer, stream status, clipboard and exact download interactions. | Google Chrome. DASH viewer responses use a local fixture here. |
| `npm run test:docker` | Actual pinned livesim2, A/V resources and period-boundary timelines, clock headers, multi-rendition fault isolation and owned-container cleanup. | Docker and pinned image already present. |
| `npm run manifest:verify` | Two 20-second manifest freeze/resume cycles for both protocols, with live media and local UTC checks. | Node; DASH requires Docker and pinned image; about two minutes. |
| `npm run network:verify` | Timed HLS/DASH profiles, pacing, byte preservation, manifest freeze/resume and identical seeded jitter on replay. | DASH needs Docker/pinned image; `--protocol hls` needs Node only; about 40 seconds. |
| `npm run scenario:verify -- --protocol hls` | Generated HLS HTTP 404/retry scenario and diagnostics. | Node only. |
| `npm run scenario:verify` | Both HLS/DASH media HTTP scenario checks. | Docker and pinned image. |
| `npm run transport:verify` | 20 body-stall/abort HTTP cases for HLS/DASH media, manifests and init, including range observations and retry. | Node; real DASH needs Docker/pinned image; `--protocol hls` needs no Docker. |
| `npm run retry:verify` | Eight three-failure-then-success HTTP cases for media, manifests, initialization and ranges on both protocols. | Node; real DASH needs Docker/pinned image; `--protocol hls` needs no Docker. |
| `npm run audio:verify` | DASH audio-only outage isolation/restoration in both Time/Number modes, healthy video/init/MPD/UTC and same-download audio retries. | Docker/pinned image; about 40 seconds, no browser. `--preset-timing` uses the original longer schedule. |
| `npm run rendition:verify` | HLS high/low and DASH low HTTP outage isolation and restoration. | About one minute; DASH needs the pinned Docker image. |
| `npm run network:presets` | Starvation and four network cycles for both protocols; pacing, bytes, cancellation and in-flight restoration. | About two minutes; DASH requires pinned Docker image. |
| `npm run http:verify` | Conditional manifest/init/media responses, single ranges, If-Range and exact resumption across both protocols. | Node; DASH needs pinned Docker. |
| `npm run headers:verify` | 54 protocol/resource/status cases with bounded safe headers, HEAD exclusions and same-resource retry. | Node; DASH needs pinned Docker. |
| `npm run browser:core` | Phase-correlated browser observations for rendition outages, starvation and four-cycle profiles; simulator/recovery outcomes remain separate. | Chrome; DASH needs pinned Docker. About 3–4 minutes per case. |
| `npm run faults:verify` | Forty payload, raw HTTP/1.1 transport and shared-network completion/cancellation cases for both protocols. | Node only; uses owned procedural media origins. |
| `npm run controls:verify` | Authenticated manual HLS/DASH arm/start/reset, run isolation, retained outcomes and redacted evidence. | Node; DASH needs pinned Docker image. |
| `npm run resource:verify` | Eight manifest/init HTTP isolation and retry cases using a local HLS fMP4 origin and real DASH engine. | Node; DASH needs Docker/pinned image; `--protocol hls` needs no Docker. |
| `npm run test:package` | Builds, packs locally, installs with production dependencies into a fresh temporary directory, invokes the executable, serves HLS media and control assets. | npm registry access for production dependencies; never publishes. |
| `npm run roku:suite -- --device ROKU_LAN_IP --server-host COMPUTER_LAN_IP --case outage` | Sequential native HLS/DASH sustained media-outage evidence. | Dedicated physical Roku with tester 1.1.0 installed; Docker and pinned image; about six minutes. |
| `npm run roku:build` | Compiles/packages the standalone SceneGraph tester. | Development dependencies; no device contacted. |
| `npm run browser:abr` | Automatic HLS 1,500 → 450 → 1,500 kbps adaptation with rendered high/low/high evidence. | Chrome; no Docker; several minutes. |
| `npm run browser:dash-abr` | Automatic DASH 1,500 → 450 → 1,500 kbps adaptation with served/rendered high/low/high evidence and default UTC. | Chrome, Docker and pinned image; several minutes. |
| `npm run browser:dash-fallback` | Optional high-rendition 503 compatibility probe; currently fails default dash.js client fallback and retains that evidence. | Chrome, Docker and pinned image; up to 165 seconds. |
| `npm run browser:outage` | Timed 20-second HLS/DASH media outage, rendered stall, automatic recovery and 60 seconds afterward. | Chrome, Docker, pinned image; about three minutes. |
| `npm run browser:verify` | Full six-case rendered browser playback/recovery gate. | Chrome, Docker, pinned image; several minutes. |

Regular tests and package smoke use isolated temporary fault files. Do not run tests
against personal templates, origin credentials or the ignored default configuration.
`test:package` does not install globally, replace your checkout dependencies, or
change npm `private: true`. Source-checkout npm scripts require the source tree;
they are not promised as commands inside an installed production package.

For development against a locally installed archive, use the executable commands
instead of the checkout's npm scripts, for example:

```sh
hls-dash-live-sim livesim --sim-type hls
hls-dash-live-sim fault-control
```

Fixture regeneration is separate: `npm run fixtures` requires FFmpeg and replaces
procedural assets. `npm run fixtures:dash-abr` regenerates just the optional
DASH ladder. Stop sessions first. [Provenance](../assets/README.md).

## GitHub Actions

[CI workflow](https://github.com/rdaci23/hls-dash-live-sim/blob/main/.github/workflows/ci.yml)
runs one **Routine / Linux / Node 24** job on pushes to `main` and pull requests.
It installs locked dependencies, then runs `docs:check`, `typecheck` and `npm test`.
The unit suite builds the project; it needs neither Chrome nor Docker. Routine
runs do not execute the platform matrix, package smoke, browser/integration jobs
or endurance smoke.

Run the broader checks explicitly from **Actions → CI → Run workflow**, selecting
the candidate branch or tag and the default **full** scope. Full dispatches run the six Linux/macOS
Node 22/24/26 matrix checks, including notices, Roku compilation, HLS HTTP
scenarios and production package installation. Separate jobs run Chrome control
UI, pinned DASH integration, payload/transport and HTTP policy checks, independent
tracks, lifecycle, local services, HLS/DASH ABR, sustained outages and the actual
ten-minute concurrent smoke. Their evidence is retained for seven days.

Manual dispatch also offers these optional additions, all off by default:

| Input | Additional checks |
| --- | --- |
| `playback` | Full six-case browser playback gate and strict DVR browser matrix. |
| `core_observations` | Seven rendition/network profiles and nine owned fault browser profiles. |
| `release_soak` | Optional four-hour concurrent stress test; not required for publication. |

Enable `playback` and `core_observations` for the complete required manual candidate
suite. Extended stress testing is separate. With GitHub CLI:

```sh
gh workflow run ci.yml --ref main -f playback=true -f core_observations=true
```

For focused memory/concurrency verification, select **endurance** scope. This runs
only the Linux/Node 24 endurance smoke job:

```sh
gh workflow run ci.yml --ref main -f scope=endurance
```

Add `-f release_soak=true` only when intentionally requesting the optional
four-hour stress test. Local release review similarly requires an explicit
`--extended-soak`; its default endurance gate is ten minutes.

The run title includes its scope. Playback and core-observation inputs apply to
full scope; a green endurance run qualifies only those endurance checks. The full
candidate still needs the complete full-scope suite and local release review.

For an explicitly unqualified allocation investigation, add `-f memory_profile=true`
to an endurance-scope dispatch. This starts the release workload, skips the separate
smoke job, and retains a driver memory profile when measurement stops. Its run title
is **memory-profile**. Leave this input off for candidate verification.

Select a stable candidate and confirm the run's actual commit. Only executed,
passing jobs qualify; disabled or skipped checks provide no verification. Reports,
diagnostics and screenshots include partial evidence on failure. No smoke result
counts as a full playback or four-hour pass. Hosted-runner results remain separate
from controlled-local-network browser and physical Roku evidence. Inspect
[repository Actions](https://github.com/rdaci23/hls-dash-live-sim/actions) for the
actual result. Manual runs still consume hosted-runner allowance; reducing routine
work does not itself clear an account billing or spending-limit restriction.

Actions are pinned to full commit SHAs, checkout credentials are not persisted,
and the workflow token has only `contents: read`. No deployment, npm publication,
release creation, repository-visibility change or physical-device access is
configured. Secrets and private origin URLs are not needed. Repository Actions
access controls apply to logs and artifacts. Job timeouts and per-ref concurrency
cancellation bound stale work. Routine and manual runs use separate concurrency
groups, so a push does not cancel an ongoing manual candidate check. A new manual
run on the same ref replaces the previous manual run. CI does not set branch
protection; maintainers configure required checks as part of the
[publication checklist](release-checklist.md).

The workflow uses the official [checkout](https://github.com/actions/checkout),
[setup-node](https://github.com/actions/setup-node) and
[artifact](https://github.com/actions/upload-artifact) actions. Permission/pinning
choices follow [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use);
Chrome installation follows [Playwright's browser documentation](https://playwright.dev/docs/browsers).
The maintained runtime matrix follows the [Node release table](https://nodejs.org/en/about/previous-releases).

## Release evidence

A green routine CI run establishes docs, types and unit-test results. Release
qualification additionally requires the exact candidate's full manual checks with
all three inputs enabled, plus the local candidate review. CI cannot test a
physical Roku. Use the [playback procedure](playback-gates.md) and
[release checklist](release-checklist.md) for the separate evidence requirements.
Retain evidence tied to the release candidate commit. Do not relabel earlier
reports as freshly verified.

`npm run cache:verify` checks [real origin/edge caching](cache-scenarios.md) with
separate diagnostic files and full-body identities.

`npm run publication:verify` checks [publication frontiers and availability](publication-scenarios.md)
against generated HLS and the pinned DASH engine.

`npm run tracks:verify` checks independent-track HTTP behavior;
`npm run browser:tracks` checks decoded tones and scheduled captions.
[Fixture development and limits](track-fixtures.md).
