# hls-dash-live-sim

A standalone tool for player developers and QA: serve known HLS/DASH streams,
inject faults, and inspect what the player requested and how it recovered.
It has no external framework dependency.

**Private beta preparation.** The repository remains private and npm publishing is
disabled. See the [release checklist](docs/release-checklist.md) for outstanding
requirements. A passing CI run does not publish anything or approve a release.

## Quick start

Use Node.js 24 LTS; CI also checks Node 22 and 26 on Linux and macOS.
HLS needs only Node. DASH additionally needs a running Docker daemon.
These commands are for a repository checkout:

```sh
npm ci
npm run build
npm run hls
```

Open `http://127.0.0.1:8899/proxy.m3u8` in your player. In a second terminal,
from the same directory:

```sh
npm run fault-control
```

Open `http://127.0.0.1:19090` to change faults. Under **Generated manifest**, paste
the stream URL and select **Load Manifest**. HLS offers master/child selection;
DASH displays its MPD. The stream card shows protocol, mode, session ID and a
copyable root playback URL. **Refresh Manifest** reads the current response manually,
including an intentional freeze. The viewer supports simulators on this computer
with the default proxy enabled; it does not fetch media or keys. **Copy Manifest**
and **Download Manifest** export the displayed snapshot without another request.
HLS downloads use `.m3u8`; DASH uses `.mpd`. These are raw manifests, not media
bundles; relative URLs still need the original simulator URL as their base.

To run DASH instead:

```sh
npm run dash
```

Use the actual MPD URL printed at startup. First start downloads the pinned
livesim2 image. It is AMD64-only; ARM Docker hosts use emulation. Ctrl+C closes
the supervised session and its owned container. `--detach` is a legacy flag;
the Node process remains in the foreground.

If commands run from different directories, pass the same absolute
`--fault-config` path to the stream and control commands. Use separate fault
files for independent sessions. Stop sessions before regenerating sample assets.

## Supported behavior

| Area | Current scope |
| --- | --- |
| HLS samples | H.264/AAC, muxed audio/video, 180p/360p renditions, two-second segments, LIVE/EVENT/VOD. |
| HLS live timing | Sliding window, increasing sequences, loop discontinuities and retained segments after window removal. |
| HLS origin proxy | Signed child playlists, alternate audio, init resources, keys, ranges and declared CDN origins. |
| DASH samples | livesim2 v1.15.3 at an immutable digest, H.264 video plus separate AAC, live windows and supported period options. |
| Clock | Coherent real-time DASH availability and local UTC by default; external UTC is opt-in. |
| Manual faults | Segment 403/404, malformed media, fixed response delay, manifest freeze, and limited encrypted-origin HLS key faults. |
| Network conditions | Shared per-session media bandwidth ceiling and additional random media/manifest response jitter. |
| Scenarios | Seeded HTTP status rules targeting logical tracks, segments, attempts and session-time windows; same-download retry assertions. |
| Inspection | Actual HLS/DASH manifests in the control page, request/fault IDs, bounded redacted diagnostics and JSONL export. |
| Playback evidence | Healthy/startup-404/during-playback-404 cases in Chrome hls.js/dash.js and one identified physical Roku; separate automatic HLS bandwidth-adaptation and timed HLS/DASH media-outage checks. |

**Limits:** no LL-HLS/LL-DASH, commercial DRM, ads or shared
virtual clock. DASH source import analyzes supported metadata; it does not clone
arbitrary source media. HLS origin scenarios and broader ABR/fault recovery remain
outside verified coverage. [Automatic HLS bandwidth adaptation](docs/hls-abr.md)
has a separate two-rendition Chrome check. Apple, Android and additional Roku models remain
unverified. [Detailed capabilities and limits](docs/implementation.md).

## Fault controls

The page connects automatically for unprotected local sessions. For protected
sessions, enter the control token and select **Connect**. Actions stay disabled
until configuration loads successfully. **Active faults** separates the saved
control settings from the connected simulator's runtime snapshot. Unsaved edits
are marked. **Refresh Saved Settings** reloads the control file; **Refresh Stream
Status** checks the simulator without requesting media or consuming a one-shot.
Runtime one-shots show armed or consumed. Always use the same fault file for the
stream and controls; inspecting a stream does not retarget its configuration.

Set **Latency (ms)** between 0 and 60,000, then **Apply Latency**. This delays
matching media and manifest responses until **Clear Latency** or zero is applied.
Fixed latency is separate from **Network conditions**: set **Bandwidth limit
(kbps)** and **Jitter (ms)**, then **Apply Network Conditions**. Zero disables each
setting. The bandwidth ceiling is shared across concurrent media/init downloads;
jitter adds a random 0–N ms to media/manifest GETs. **Clear Network Conditions**
releases queued capped transfers. Local UTC and health stay unaffected.
[Units, timing and scope](docs/network-conditions.md).

**Once** applies to one matching GET, not one playback event. Quick Inject rearms
it; repeated injections before consumption coalesce into the latest arm. Player
buffering can delay when a fault becomes visible. HLS key faults require an
actual encrypted origin; they do not affect clear samples or DASH.

**Advanced: equivalent curl command** is an optional terminal alternative to
**Save Config**. Protected commands reference `$HLS_DASH_CONTROL_TOKEN`; the page
never puts your token into the command. [Modes, API and examples](docs/fault-injection-guide.md).

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
characters before starting LAN control, then enter it in the panel:

```sh
npm start -- fault-control --host 0.0.0.0
```

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
| [Implementation](docs/implementation.md) | Current behavior, supported imports and explicit limits. |
| [Development and CI](docs/development.md) | Install, checks, CI matrix and packaged-CLI smoke test. |
| [Sustained media outages](docs/sustained-outages.md) | Timed HLS/DASH 503 outages, measured stall/resume and explicit retry settings. |
| [HLS automatic ABR](docs/hls-abr.md) | Reproducible bandwidth drop/restoration with rendered downshift/upshift evidence. |
| [Playback gates](docs/playback-gates.md) | Numeric acceptance gates, reproducible browser/Roku commands and recorded hardware results. |
| [Release checklist](docs/release-checklist.md) | Completed preparation and unresolved public-release requirements. |
| [Contributing](CONTRIBUTING.md) | Change scope, validation and handling sensitive test inputs. |
| [Fixture provenance](assets/README.md) | Procedural media sources and regeneration. |
| [Verification history](docs/verification-history.md) | Older reports and why they are not current release evidence. |

Quick checks: `npm run docs:check`, `npm run typecheck`, `npm test`.
For the control-page browser checks, run `npm run test:ui` with Google Chrome
installed. These checks do not replace the full playback and device gates.
