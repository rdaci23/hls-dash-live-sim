# Setup and first stream

This guide starts with generated local media, then explains how to configure a
session. The repository is currently private; cloning requires an authorized
GitHub account. No npm release is published.

## Prerequisites

| What you want to do | Install |
| --- | --- |
| Generate HLS and use the control UI | Node.js 24 LTS and npm. |
| Generate DASH | The above, plus Docker with its daemon running. |
| Run browser verification | Development dependencies and Google Chrome. |
| Regenerate media fixtures | FFmpeg with libx264; existing samples work without it. |

CI covers Node 22/24/26 on Linux and macOS. Windows and the declared legacy Node
20.3 floor are not verified. Use Node 24 for the documented setup.

```sh
git clone https://github.com/rdaci23/hls-dash-live-sim.git
cd hls-dash-live-sim
npm ci
npm run build
mkdir -p output
cp examples/configurations/healthy.json output/demo-faults.json
npm run hls -- --fault-config output/demo-faults.json
```

The normal HLS URL is `http://127.0.0.1:8899/proxy.m3u8`; use the actual URL printed
if you chose another port. It serves a 180p/360p H.264/AAC ladder with two-second
segments. In a second terminal in the same checkout:

```sh
npm run fault-control -- --fault-config output/demo-faults.json
```

Open `http://127.0.0.1:19090`, paste the playback URL into **Simulator manifest
URL**, then select **Load Manifest**. The UI shows stream details, a copyable root
playback URL, active faults and the actual manifest. Pick an HLS child playlist to
see its live sequence. Copy/download exports the displayed text snapshot.

The control UI inspects streams; it does not contain a video player. Give the
playback URL to your own HLS-capable player. A plain browser tab does not guarantee
native HLS support. The automated Chrome checks bundle pinned hls.js/dash.js
locally; see [verification commands](development.md).

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
| Private clone fails | Authenticate an authorized account; this is not a public repo yet. |
| DASH cannot start | Start Docker, check image-download access and use the pinned image. |
| Port in use | Stop your own session or select a free `--port`. |
| Controls have no effect | Stream and control commands must use the same absolute fault-file path. |
| No video in a plain browser | Use a compatible player; the control UI is an inspector. |
| Scenario rejects manual faults | Start with a healthy config and leave manual controls off in scenario mode. |
| A deliberate fault appears late | The player may be rendering buffered media. Inspect request/fault IDs. |
| Stream freezes but UTC/media still respond | Manifest freeze holds responses while live publication and clocks continue. |

See [configuration](configuration.md), [supported limits](implementation.md) and
[development/CI](development.md) for detailed commands and acceptance evidence.
