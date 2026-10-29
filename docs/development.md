# Development and CI

## Environment

For a checkout, use Node.js 24 LTS and npm. CI checks Node 22, 24 and 26 on Ubuntu
24.04 and macOS 15. The package still declares the legacy Node 20.3 engine floor;
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
| `npm run docs:check` | Local documentation link targets exist. Does not verify remote URLs or heading fragments. | Node; no network. |
| `npm run typecheck` | TypeScript checking. | Development dependencies. |
| `npm test` | Builds assets, then API, protocol, safety, diagnostics, scenarios, bandwidth/jitter timing and evidence regressions. | No Docker/browser; optional integrations are reported as skipped. |
| `npm run test:ui` | Real control-page JS, authentication, settings, latency and HLS/DASH viewer, stream status, clipboard and exact download interactions. | Google Chrome. DASH viewer responses use a local fixture here. |
| `npm run test:docker` | Actual pinned livesim2, A/V resources and period-boundary timelines, clock headers and owned-container cleanup. | Docker and pinned image already present. |
| `npm run scenario:verify -- --protocol hls` | Generated HLS HTTP 404/retry scenario and diagnostics. | Node only. |
| `npm run scenario:verify` | Both HLS/DASH HTTP scenario checks. | Docker and pinned image. |
| `npm run test:package` | Builds, packs locally, installs with production dependencies into a fresh temporary directory, invokes the executable, serves HLS media and control assets. | npm registry access for production dependencies; never publishes. |
| `npm run roku:build` | Compiles/packages the standalone SceneGraph tester. | Development dependencies; no device contacted. |
| `npm run browser:abr` | Automatic HLS 1,500 → 450 → 1,500 kbps adaptation with rendered high/low/high evidence. | Chrome; no Docker; several minutes. |
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
procedural assets. Stop sessions first. [Provenance](../assets/README.md).

## GitHub Actions

[CI workflow](https://github.com/rdaci23/hls-dash-live-sim/blob/main/.github/workflows/ci.yml) runs on pushes to `main`, pull requests
and manual dispatch. Linux/macOS matrix jobs run docs, types, regular tests, Roku
compilation, HLS HTTP scenarios and the packaged-CLI smoke. Separate Linux jobs
run Chrome control UI tests and real DASH integration plus both HTTP scenarios.
A dedicated Linux/Node 24 job runs the [HLS automatic ABR check](hls-abr.md) on
every CI invocation and retains its raw/report/screenshot evidence for seven days.
The run is successful only when all selected jobs pass; logs retain individual
failures. Inspect [repository Actions](https://github.com/rdaci23/hls-dash-live-sim/actions)
for the actual commit result rather than treating workflow presence as proof.

Manual dispatch offers a **playback** checkbox. Enabling it runs the full six-case
browser gate with normal synchronization and numeric acceptance thresholds. Its
reports, diagnostics and screenshots are retained as a repository Actions artifact
for seven days, including partial evidence on failure. No smoke result is counted
as a full playback pass. Hosted-runner results are distinct from the recorded
controlled-local-network browser and physical Roku evidence.

Actions are pinned to full commit SHAs, checkout credentials are not persisted,
and the workflow token has only `contents: read`. No deployment, npm publication,
release creation, repository-visibility change or physical-device access is
configured. Secrets and private origin URLs are not needed. The private repository's
normal Actions access controls apply to logs and artifacts. Job timeouts and
per-ref concurrency cancellation bound stale work. CI does not set branch
protection; maintainers must decide which checks to require before public release.

The workflow uses the official [checkout](https://github.com/actions/checkout),
[setup-node](https://github.com/actions/setup-node) and
[artifact](https://github.com/actions/upload-artifact) actions. Permission/pinning
choices follow [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use);
Chrome installation follows [Playwright's browser documentation](https://playwright.dev/docs/browsers).
The maintained runtime matrix follows the [Node release table](https://nodejs.org/en/about/previous-releases).

## Release evidence

A green routine CI run is required preparation, not a declaration of release
readiness. It skips full browser playback by default and cannot run a physical
Roku. Use the [playback procedure](playback-gates.md) and
[release checklist](release-checklist.md) for those gates. Retain evidence tied to
the release candidate commit. Do not relabel earlier reports as freshly verified.
