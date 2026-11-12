# Setup and first stream

This guide starts with generated local media, then explains how to configure a
session. Install the beta from npm (`npm install -g hls-dash-live-sim`) or from a
source checkout. See the [changelog](../CHANGELOG.md) for release scope and known limits.

## Prerequisites

| What you want to do | Install |
| --- | --- |
| Generate HLS and use the control UI | Node.js 24 LTS and npm. |
| Generate DASH | The above, plus Docker with its daemon running. |
| Run browser verification | Development dependencies and Google Chrome. |
| Regenerate media fixtures | FFmpeg with libx264; existing samples work without it. |

The CI workflow defines a routine Linux/Node 24 job for pushes and pull requests,
and a manually dispatched matrix for Node 22/24/26 on Linux and macOS. Hosted
Actions is currently disabled, so neither runs automatically; checks are run
locally ([policy](development.md#github-actions)). Windows is not verified. The package
requires Node 22 or later; use Node 24 for the documented setup.

The steps below use a checkout. With the npm package, replace `npm run hls --` with
`hls-dash-live-sim livesim --sim-type hls` and `npm run fault-control` with
`hls-dash-live-sim fault-control`; checkout-only scripts such as browser checks
and fixture regeneration need the source tree.

```sh
git clone https://github.com/rdaci23/hls-dash-live-sim.git
cd hls-dash-live-sim
npm ci
npm run build
mkdir -p output
cp examples/configurations/healthy.json output/demo-faults.json
export HLS_DASH_CONTROL_TOKEN="$(node -p 'require("node:crypto").randomBytes(24).toString("hex")')"
printf 'Simulator control token: %s\n' "$HLS_DASH_CONTROL_TOKEN"
npm run hls -- --fault-config output/demo-faults.json
```

The normal HLS URL is `http://127.0.0.1:8899/proxy.m3u8`; use the actual URL printed
if you chose another port. It serves a 180p/360p H.264/AAC ladder with two-second
segments. In a second terminal in the same checkout:

```sh
npm run fault-control
```

Open `http://127.0.0.1:19090`, paste the playback URL into **Simulator manifest
URL**, then select **Connect stream**. Connecting only observes the stream. Under
**Control access**, enter the simulator token printed in the first terminal and
select **Unlock controls**. Tokens stay in page memory and must be re-entered
after a page refresh; the simulator's active settings/test continue unchanged.

The compact connection bar shows the playback URL and active effects. Use
**Scenarios** to choose a compatible preset, **Prepare test**, review its target,
then **Start test** when your external player is ready. **Stop test** retains its
result. The **Manual faults** tab uses an explicit **Use manual controls** action;
switching modes stops the current test in this session. Tabs alone never change
fault delivery. These settings are private to the running simulator, without
changing another stream or writing the shared fault file.

**Manifest** shows a stable baseline preview with friendly HLS playlist choices.
Advertised child playlists are discovered automatically without fetching media,
initialization segments or keys. **Copy original** and **Download original**
export the original snapshot, including when readable XML/wrapping is enabled.
Status updates automatically; the displayed manifest changes only when you
refresh it or choose another playlist. [Controls, settings reuse and API](session-controls.md).

Without a simulator token, playback and inspection still work and controls show
read-only setup guidance. Existing automatic CLI scenarios remain managed by
their startup definition. Legacy shared-file controls are a separate Advanced
tool and still require matching file paths; inspecting a URL never retargets them.

## Connect a player

The control UI inspects streams; it does not contain a video player. Give the
playback URL to your own player. A plain browser tab does not guarantee native
HLS support. The automated Chrome checks bundle pinned hls.js/dash.js locally;
see [verification commands](development.md).

By default the simulator answers only requests addressed to this computer
(`localhost`, `127.0.0.1` or one of its own IP addresses) and browser pages served
from those addresses. Everything else receives HTTP 403. What works without
extra options:

- Native or command-line players: Safari, `ffplay`, VLC, a Roku or phone on the
  LAN (start with `--host 0.0.0.0` and use this computer's LAN IP address).
- A player page you serve from this computer, for example `http://localhost:3000`.

Declare anything else explicitly when starting the stream:

```sh
# Android emulator (reaches the host as 10.0.2.2) or an mDNS/host name
npm run hls -- --allow-host 10.0.2.2 --allow-host my-mac.local

# A hosted demo player, or a page opened from disk (origin "null")
npm run hls -- --allow-player-origin https://hlsjs.video-dev.org
npm run hls -- --allow-player-origin null
```

`--allow-host` takes a bare host name or IP address; `--allow-player-origin`
takes a scheme, host and optional port. Both can be repeated and apply to HLS,
DASH and `--fixture tracks`. A hosted HTTPS page may still be stopped by the
browser's own mixed-content or private-network rules before any request is sent.

Startup prints whether session controls are enabled for the supplied token, and
warns when the fault file already contains active manual faults.

Follow the [three-minute demo](demo.md), then try the [three scenario recipes](scenario-recipes.md).

## Start DASH

Stop the HLS process first if you are following one session through the controls.
Keep the same healthy file, or create a separate file for an independent stream:

```sh
npm run dash -- --asset abr --fault-config output/demo-faults.json
```

First start pulls the immutable livesim2 image. Docker must already be running.
The image is AMD64-only and uses emulation on ARM. The optional `abr` asset has
180p/360p video and separate AAC; omit `--asset abr` for the single-video baseline.
Use the full printed MPD URL, including its path options. It is also available
through `/proxy.mpd` on the printed proxy port. Normal local UTC is the default.
Keep the generated token in that terminal's environment, or set a fresh one before
starting DASH, to enable its session controls. Connecting its URL does not replay
the previous HLS session's faults.

`--detach` is a legacy compatibility flag: keep the terminal process running.
Ctrl+C closes the supervised stream and its owned container. It does not stop
unrelated Docker containers or listeners.

## Ports, devices and shutdown

The defaults are HLS 8899, DASH proxy 8888 and control 19090. Use `--port` on the
relevant command to choose another free port. A collision fails explicitly; it
does not kill another process. Ctrl+C stops each terminal's owned service.

Loopback playback URLs work on this computer. For a LAN player:

```sh
npm start -- livesim --sim-type hls --host 0.0.0.0 --fault-config output/demo-faults.json
```

Replace the playback URL's loopback host with this computer's LAN address. Keep
control on loopback unless needed; LAN control requires a token of at least 16
characters. [Access and authentication](configuration.md). This is a development
tool, not an internet-facing hosting service.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Clone fails | Check the repository URL and GitHub access; private checkouts require an authorized account. |
| DASH cannot start | Start Docker, check image-download access and use the pinned image. |
| Port in use | Stop your own session or select a free `--port`. |
| Controls are read-only | Start the simulator with a control token of at least 16 characters; enter that simulator's token under Control access. |
| Legacy file controls have no effect | Only the separate legacy tool requires stream/controller to use the same absolute file path. |
| No video in a plain browser | Use a compatible player; the control UI is an inspector. |
| Settings changed in another window | Your draft is preserved. Explicitly reload current settings or reapply against the latest revision. |
| Scenario rejects manual faults | Use the explicit mode switch; legacy scenario APIs still require a healthy shared config until UI takeover. |
| A deliberate fault appears late | The player may be rendering buffered media. Inspect request/fault IDs. |
| Stream freezes but UTC/media still respond | Manifest freeze holds responses while live publication and clocks continue. |

See [configuration](configuration.md), [supported limits](implementation.md) and
[development/CI](development.md) for detailed commands and acceptance evidence.
