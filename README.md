# hls-dash-live-sim

A standalone tool for player developers and QA: serve known HLS/DASH streams,
inject faults, and inspect what the player requested and how it recovered.

**0.2.0 beta.** Install from source; no npm release is published. Read the
[changelog](CHANGELOG.md) for features, verification and known limits. Maintainers
track publication status in the [release checklist](docs/release-checklist.md).

New here? Follow [setup](docs/getting-started.md), the [three-minute demo](docs/demo.md),
then [three scenario recipes](docs/scenario-recipes.md). See [configuration](docs/configuration.md)
for ready-to-copy settings, access controls and independent sessions.

## License

Project-owned code, documentation and generated media fixtures are licensed under
the [MIT License](LICENSE). You may use, modify and redistribute them, including
commercially, subject to its notice requirements. Dependencies and external tools
retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

Repository visibility and npm publication remain separate release decisions.

## Quick start

Use Node.js 24 LTS. Routine CI uses Linux/Node 24; manual full checks also cover
Node 22 and 26 on Linux and macOS.
HLS needs only Node. DASH additionally needs a running Docker daemon.
These commands are for a repository checkout:

```sh
git clone https://github.com/rdaci23/hls-dash-live-sim.git
cd hls-dash-live-sim
npm ci
npm run build
export HLS_DASH_CONTROL_TOKEN="$(node -p 'require("node:crypto").randomBytes(24).toString("hex")')"
printf 'Simulator control token: %s\n' "$HLS_DASH_CONTROL_TOKEN"
npm run hls
```

Open `http://127.0.0.1:8899/proxy.m3u8` in your player. In a second terminal,
from the same directory:

```sh
npm run fault-control
```

Open `http://127.0.0.1:19090`, paste the simulator URL and select **Connect stream**.
Enter its token under **Control access** to unlock session-scoped writes. Tokenless
streams remain usable for playback and inspection. Copy the playback URL into your
player, choose a compatible scenario, **Prepare test**, then **Start test**.

The three tabs are **Scenarios**, **Manual faults** and **Manifest**. Tabs and
inspection are inert; mode changes are explicit. Controls affect only the connected
session, and status updates preserve unsaved drafts. The manifest viewer discovers
advertised HLS children without fetching media/init/keys and labels the snapshot
as a baseline preview. **Copy original**/**Download original** retain its original
text without another request. [Setup and workflow](docs/getting-started.md),
[control API and limits](docs/session-controls.md).

To run DASH instead:

```sh
npm run dash
# Optional 180p/360p video ladder, with separate AAC:
npm run dash -- --asset abr
```

Use the actual MPD URL printed at startup. First start downloads the pinned
livesim2 image. It is AMD64-only; ARM Docker hosts use emulation. Ctrl+C closes
the supervised session and its owned container. `--detach` is a legacy flag;
the Node process remains in the foreground.

Only the Advanced legacy shared-file workflow requires stream/controller commands
to share an absolute `--fault-config` path. Legacy sessions sharing a file share
settings until explicit scoped takeover. Stop sessions before regenerating sample
assets.

## Supported behavior

| Area | Current scope |
| --- | --- |
| HLS samples | H.264/AAC, muxed audio/video, 180p/360p renditions, two-second segments, LIVE/EVENT/VOD. |
| HLS live timing | Sliding window, increasing sequences, loop discontinuities and retained segments after window removal. |
| HLS origin proxy | Signed child playlists, alternate audio, init resources, keys, ranges and declared CDN origins. |
| DASH samples | livesim2 v1.15.3 at an immutable digest, H.264 video plus separate AAC, optional `--asset abr` 180p/360p ladder, live windows and supported period options. |
| Clock | Coherent real-time DASH availability and local UTC by default; external UTC is opt-in. |
| Manual faults | Segment 403/404, malformed media, fixed response delay, manifest freeze, and limited encrypted-origin HLS key faults. |
| Network conditions | Shared per-session media bandwidth ceiling and additional random media/manifest response jitter. |
| Scenarios | Seeded media, manifest and init HTTP status or bounded body-stall/abort rules with same-resource retry assertions; timed bandwidth, seeded jitter and manifest freeze/resume profiles. |
| Inspection | Generated HLS/DASH baseline previews in the control page, request/fault IDs, bounded redacted diagnostics and JSONL export. |
| Playback evidence | Healthy/startup-404/during-playback-404 cases in Chrome hls.js/dash.js and one identified physical Roku; separate automatic HLS/DASH bandwidth-adaptation and timed HLS/DASH media-outage checks. |

**Limits:** no LL-HLS/LL-DASH, commercial DRM, ads or shared
virtual clock. DASH source import analyzes supported metadata; it does not clone
arbitrary source media. HLS origin scenarios and broader ABR/fault recovery remain
outside verified coverage. Automatic [HLS](docs/hls-abr.md) and [DASH](docs/dash-abr.md)
bandwidth adaptation have separate two-rendition Chrome checks. Default dash.js
HTTP-error rendition fallback failed its optional compatibility probe; simulator
fault isolation is verified independently. Player-specific recovery behavior is
recorded as compatibility evidence; Roku recovery fixes are outside this repo.
Apple, Android and additional Roku models remain unverified. [Detailed capabilities and limits](docs/implementation.md).

## Fault controls

Normal UI writes require the simulator's control token and current session/revision.
Manual settings and scenarios are exclusive modes; stopping/switching retains
evidence and leaves publication/UTC clocks running. Settings survive UI refresh
and reconnection to the same session, but not simulator restart. Tokens remain in
page memory. Advanced retains a separate legacy shared-file tool for existing
CLI/file workflows; only that tool requires matching stream/controller file paths.

In **Manual faults**, select **Use manual controls**, set **Response delay (ms)**,
**Bandwidth limit (kbps)** and **Jitter (ms)**, then **Apply settings**. Delay and
jitter accept 0–60,000 ms; zero bandwidth means unlimited. The cap is shared
across concurrent media/init downloads; jitter adds a random 0–N ms to
media/manifest GETs. **Clear faults** restores all-off settings and cancels this
session's affected manual work while leaving healthy requests and other sessions
alone. Local UTC and health stay unaffected.
[Units, timing and scope](docs/network-conditions.md).

**Once** applies to one matching GET, not one playback event. **Inject once** rearms
it; repeated injections before consumption coalesce into the latest arm. Player
buffering can delay when a fault becomes visible. HLS key faults require an
actual encrypted origin; they do not affect clear samples or DASH.

**Reuse manual settings** exports portable JSON or imports it as a validated
draft requiring explicit Apply. **Advanced details** provides a session API
command with environment-variable placeholders, never your token. The separate
legacy tool retains **Save Config** and shared-file API examples.
[Modes, API and examples](docs/fault-injection-guide.md).

## Network access

Servers bind to `127.0.0.1` by default. Port collisions fail without stopping
another process. To make a stream reachable by a LAN device:

```sh
npm start -- livesim --sim-type hls --host 0.0.0.0
```

Replace the loopback host in the player URL with this computer's LAN address.
Browser players must be served from localhost or this computer's network
addresses; unrelated website origins are rejected.

Stream access and control access are separate. Keep control on loopback unless
you need LAN control. Set `HLS_DASH_CONTROL_TOKEN` to a token of at least 16
characters before starting LAN control to protect its legacy endpoints:

```sh
npm start -- fault-control --host 0.0.0.0
```

The normal panel needs the **connected simulator's** token, configured when that
simulator starts. The control server's legacy token is separate; the two need not
match. Keep both out of playback URLs and shared transcripts.

Source authorization is scoped to the source origin. A separate CDN must be
explicitly permitted with `--allow-origin`. Saved source URLs can contain secrets;
local templates and authentication files remain ignored by Git.

## Common workflows

```sh
# EVENT or VOD instead of sliding live HLS
npm start -- livesim --sim-type hls --mode event
npm start -- livesim --sim-type hls --mode vod

# Inspect the manifest selected at startup
npm start -- livesim --show-manifest

# Proxy real HLS; optionally allow a separate media CDN
npm start -- livesim --manifest-url https://example.com/master.m3u8
npm start -- livesim --manifest-url https://example.com/master.m3u8 --allow-origin https://media.example.com

# One DASH period each minute (option units: periods per hour)
npm start -- livesim --sim-type dash --periods-per-hour 60

# Discover presets, imports and command options
npm run templates
npm start -- create-manifest-template --help
npm start -- livesim --help
```

Record redacted requests with `--diagnostics-file output/requests.jsonl` after
creating `output`. The file must be new. Read recent events at `/diagnostics` on
the stream port. IDs correlate HTTP responses with fault selection, consumption,
application and cancellation. [Diagnostics format](docs/diagnostics.md).

For deterministic 404/retry testing:

```sh
mkdir -p output
npm start -- livesim --sim-type hls --scenario examples/scenarios/next-video-retry.json --fault-config output/scenario-faults.json
```

Use `--sim-type dash` for DASH. Read the run's assertions at `/scenario`.
Manual faults must be off. [Scenario rules and replay](docs/scenarios.md).

## Documentation and checks

| Document | Purpose |
| --- | --- |
| [Setup](docs/getting-started.md) | Prerequisites, first HLS/DASH stream, ports and troubleshooting. |
| [Demo](docs/demo.md) | A short real-UI walkthrough with a one-shot HTTP retry. |
| [Configuration](docs/configuration.md) | Manual files, scenario files, sample settings and protected access. |
| [Scenario recipes](docs/scenario-recipes.md) | One 404/retry, sustained outage and scheduled network/freeze cycle. |
| [Changelog](CHANGELOG.md) | Version 0.2.0 beta features, verification scope and known limits. |
| [Release review](docs/release-review.md) | History/package audit, clean-clone browser checks and publication decisions. |
| [Dependency notices](THIRD_PARTY_NOTICES.md) | Locked runtime/development inventory and preserved upstream license texts. |
| [Security policy](SECURITY.md) | Private-reporting procedure and current enablement status. |
| [Implementation](docs/implementation.md) | Current behavior, supported imports and explicit limits. |
| [Development and CI](docs/development.md) | Install, checks, CI matrix and packaged-CLI smoke test. |
| [Network scenario timelines](docs/network-scenarios.md) | Scheduled bandwidth, seeded jitter, freeze/resume and HTTP replay evidence. |
| [Network presets](docs/network-presets.md) | Below-minimum starvation, four bandwidth cycles, byte/pacing and active-transfer restoration evidence. |
| [Core roadmap](docs/scenario-roadmap.md) | Remaining pre-release milestones and their evidence gates. |
| [Rendition outages](docs/rendition-outages.md) | HLS high/low and DASH low isolation and restoration. |
| [DASH audio-only outage](docs/dash-audio-outage.md) | Independent audio failure, healthy video/init/MPD/UTC, and same-download restoration evidence. |
| [Multi-attempt retries](docs/multi-attempt-retry.md) | Three failures, then same-resource/range HTTP success, with sequential completion evidence. |
| [Bounded transport faults](docs/transport-scenarios.md) | Headers-only/body stalls, incomplete connection aborts, timing/byte evidence and cleanup bounds. |
| [Manifest/init targeting](docs/resource-scenarios.md) | Resource selectors, local fMP4 HLS origin, HTTP isolation and retry evidence. |
| [Inert manifest previews](docs/manifest-preview.md) | Inspection semantics, source failures and isolated verification. |
| [Manifest freeze/resume](docs/manifest-freeze.md) | Simulator snapshot stability, live media availability, local clock and current-timeline resume. |
| [Sustained media outages](docs/sustained-outages.md) | Timed HLS/DASH 503 outages, measured stall/resume and explicit retry settings. |
| [HLS automatic ABR](docs/hls-abr.md) | Reproducible bandwidth drop/restoration with rendered downshift/upshift evidence. |
| [DASH ladder and ABR](docs/dash-abr.md) | Optional multi-rendition sample, automatic bandwidth switching and separate HTTP fallback compatibility probe. |
| [Playback gates](docs/playback-gates.md) | Numeric acceptance gates, reproducible browser/Roku commands and recorded hardware results. |
| [Release checklist](docs/release-checklist.md) | Completed preparation and unresolved public-release requirements. |
| [Contributing](CONTRIBUTING.md) | Change scope, validation and handling sensitive test inputs. |
| [Fixture provenance](assets/README.md) | Procedural media sources and regeneration. |
| [Verification history](docs/verification-history.md) | Older reports and why they are not current release evidence. |

Quick checks: `npm run docs:check`, `npm run typecheck`, `npm test`.
For the control-page browser checks, run `npm run test:ui` with Google Chrome
installed. These checks do not replace the full playback and device gates.

Opt-in [manual scenario runs](docs/scenario-controls.md) provide a preset catalog,
session-scoped arm/start/reset and evidence downloads. Existing automatic startup
remains the default. [Core coverage roadmap](docs/scenario-roadmap.md).

[Payload and transport scenarios](docs/payload-transport-scenarios.md) cover
explicit invalid manifests/media/init, header delays, slow progress, HTTP/1.1
framing failures and verified shared-network combinations.

[Core browser observations](docs/core-browser-observations.md) record rendition
outages and network cycles with pinned players, rendered frames and explicit
compatibility outcomes.

[HTTP policy scenarios](docs/http-policy-scenarios.md) add revalidation, exact
range resumption and bounded status-response headers, with HTTP evidence kept
separate from player recovery.

See [origin and edge-cache scenarios](docs/cache-scenarios.md) for fresh/newer/stale
manifests, real negative caching, setup and isolated verification.

[Publication scenarios](docs/publication-scenarios.md) cover one-rendition lag
and fresh-segment delay with independent HTTP evidence.

Use the [owned fMP4 audio/caption fixture](docs/track-fixtures.md) for local
alternate-track, WebVTT/wvtt and asymmetric-network tests. Existing sample defaults
remain available.

[Owned lifecycle scenarios](docs/lifecycle-scenarios.md) add aligned encoder
restarts and growing event completion to the optional local tracks fixture.

[Offline local-service scenarios](docs/local-services.md) cover rotating HLS
AES-128 keys, authenticated media access/renewal and explicit local UTC faults.

[Endurance verification](docs/endurance.md) requires a ten-minute candidate smoke
with concurrent viewers, independent decoded A/V timing, bounded evidence rotation
and explicit cleanup checks. A four-hour stress test is available by opt-in.

[Targeted browser observations](docs/browser-scenario-observations.md) record payload,
publication and audio/text fault delivery and HTTP restoration separately from player
recovery. [Coverage matrix](docs/coverage-matrix.md) distinguishes HTTP proof, browser evidence
and compatibility limits. [Publication preparation](docs/publication-preparation.md) lists exact-candidate
gates and the settings to apply only after approval.
