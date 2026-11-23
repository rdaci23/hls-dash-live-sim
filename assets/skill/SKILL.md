---
name: hls-dash-live-sim
description: >-
  Start HLS and DASH live test streams, inject deterministic HTTP/transport/payload/network
  faults, run scenario presets from the CLI, and export redacted request diagnostics using
  hls-dash-live-sim. Activate when testing video players (web, iOS/tvOS, Android/ExoPlayer,
  Roku), reproducing ABR or live-edge bugs, or automating HLS/DASH fault-injection QA.
---

# hls-dash-live-sim Agent Workflow

Use the `hls-dash-live-sim` CLI to serve valid local HLS/DASH streams, control manual faults or deterministic scenarios headlessly, and inspect simulator observations without opening the web UI.

## Core Invariants (Read First)

1. **Simulator delivery is NOT player recovery:** A `passed` scenario or `retryVerified=true` rule proves only that the simulator delivered the planned HTTP/transport fault and observed a matching HTTP retry or timeline window. Always verify actual playback continuation, stalls, frame rendering, audio/captions, or rendition switches in the **player's** own logs, telemetry, or screenshots.
2. **Protect control tokens and credentials:** Generate a per-session `HLS_DASH_CONTROL_TOKEN` (>= 16 chars) in an environment variable rather than hardcoding secrets in transcripts, URLs, or committed files. Never commit `.certs/`, `output/`, `.hls-dash-faults.json`, or `auth*.json`.
3. **Session isolation:** Always pass an isolated `--fault-config` and `--session-file` (each `--session-file` and `--diagnostics-file` must be a **new** path in an existing directory; existing files are never overwritten). Never kill unrelated processes or Docker containers on port collisions; pick a free `--port` instead.
4. **Protocol prerequisites:** HLS samples and `--fixture tracks` (both HLS and DASH) need only Node.js (>= 22). Engine-backed DASH (`livesim --sim-type dash` without `--fixture tracks`) requires a running Docker daemon.

## 1. Start an Isolated Stream in the Background

Create a scratch directory (e.g. `output/agent-run`), generate a token in memory, and record non-secret session metadata with `--session-file`:

```sh
mkdir -p output/agent-run
export HLS_DASH_CONTROL_TOKEN="$(node -p 'require("node:crypto").randomBytes(24).toString("hex")')"

# Default HLS fMP4 ladder (234p/432p/720p + separate AAC):
hls-dash-live-sim livesim start --sim-type hls \
  --port 8899 \
  --fault-config output/agent-run/faults.json \
  --session-file output/agent-run/session.json \
  --diagnostics-file output/agent-run/diagnostics.jsonl
```

Common stream variants:
- **Node-only DASH or multi-track audio/WebVTT/wvtt captions (no Docker needed):**
  `hls-dash-live-sim livesim start --sim-type dash --fixture tracks --port 8888 --fault-config output/agent-run/dash-faults.json --session-file output/agent-run/dash-session.json`
- **Docker livesim2 DASH engine (with 180p/360p ABR ladder):**
  `hls-dash-live-sim livesim start --sim-type dash --asset abr --port 8888 --fault-config output/agent-run/dash-faults.json --session-file output/agent-run/dash-session.json`
- **Android emulator (`10.0.2.2`), LAN devices (Roku / iOS / tvOS), or hosted web players:**
  Add `--host 0.0.0.0` plus `--allow-host 10.0.2.2` (for Android emulator) or `--allow-player-origin https://your-player.example` (or `null` for `file://`).
- **Low-latency HLS over HTTP/2 + TLS (required for Safari/AVPlayer LL-HLS):**
  Run `hls-dash-live-sim certs` once (trust `.certs/ca.pem` on the target simulator/device, never `ca.key`), then start with `--low-latency --http2 --tls-cert .certs/server.pem --tls-key .certs/server.key`. Pass `--ca-cert .certs/ca.pem` to `hls-dash-live-sim control` commands.

Wait until `output/agent-run/session.json` exists, then read the playback `url` from it (`control status --session-file output/agent-run/session.json --json`).

## 2. Inspect Status, Inert Manifests, and Compatible Presets

`--session-file` pins both the simulator origin and exact `sessionId` so commands never hit a restarted or wrong session:

```sh
# Read simulator health, mode, revision, and current run state as JSON:
hls-dash-live-sim control status --session-file output/agent-run/session.json --json

# Discover advertised playlists inertly and list compatible scenario presets:
hls-dash-live-sim control catalog --session-file output/agent-run/session.json --json

# Fetch an inert baseline manifest preview (does NOT consume one-shots or seed freezes):
hls-dash-live-sim control manifest --session-file output/agent-run/session.json
hls-dash-live-sim control manifest --session-file output/agent-run/session.json --playlist video:0
```

You can also target any running simulator without a session file via `--url http://127.0.0.1:8899/proxy.m3u8` (or `HLS_DASH_SIM_URL`).

## 3. Run Deterministic Scenarios

Prefer deterministic scenarios over random manual faults whenever reproducing a bug:

```sh
# Switch to scenario mode, arm, start, and wait for completion:
hls-dash-live-sim control run next-video-retry \
  --session-file output/agent-run/session.json \
  --wait --timeout 45000 --json
```

Step-by-step interactive control (when you want to prepare a test before launching the player):

```sh
hls-dash-live-sim control mode scenario --session-file output/agent-run/session.json
hls-dash-live-sim control arm next-video-retry --session-file output/agent-run/session.json
# Start external player on the playback URL, then trigger fault delivery:
hls-dash-live-sim control start --session-file output/agent-run/session.json
hls-dash-live-sim control wait --session-file output/agent-run/session.json --timeout 45000 --json
# Stop early or disarm when finished (retains evidence; clocks keep running):
hls-dash-live-sim control stop --session-file output/agent-run/session.json
```

Useful built-in presets (verify availability for your stream via `control catalog`):
- **Retries & status:** `next-video-retry`, `three-video-failures-retry`, `next-manifest-retry`, `next-video-init-retry`, `hls-sustained-outage`, `dash-sustained-outage`
- **Rendition & track isolation:** `hls-high-rendition-outage`, `dash-high-rendition-outage`, `dash-audio-only-outage`, `independent-audio-outage`, `independent-text-outage`
- **Network & ABR:** `bandwidth-starvation`, `bandwidth-oscillation`, `network-cycle`, `slow-origin-latency`
- **Transport & payload:** `next-video-body-stall`, `next-video-body-abort`, `next-video-connection-reset`, `next-video-no-response`, `next-malformed-manifest`, `next-damaged-media`
- **Live edge & clocks:** `long-manifest-freeze`, `missing-segment-gap`, `hls-manifest-rollback`, `dash-manifest-rollback`, `owned-encoder-restart`, `owned-event-completion`

## 4. Apply Manual Faults and Network Shaping

Manual faults and scenarios are mutually exclusive modes; switching modes stops the prior test and retains its evidence:

```sh
# Switch to manual mode and shape network conditions:
hls-dash-live-sim control apply \
  --session-file output/agent-run/session.json \
  --ensure-mode \
  --bandwidth-kbps 450 \
  --jitter-ms 120 \
  --latency-ms 200 \
  --json

# Arm a one-shot fault on the next matching GET:
hls-dash-live-sim control inject segment.missing --session-file output/agent-run/session.json
hls-dash-live-sim control inject segment.malformed --session-file output/agent-run/session.json

# Freeze live manifests (media publication and UTC clocks keep advancing):
hls-dash-live-sim control apply --session-file output/agent-run/session.json --freeze always

# Clear all manual faults back to healthy delivery:
hls-dash-live-sim control clear --session-file output/agent-run/session.json
```

## 5. Export Evidence and Shut Down Cleanly

Export bounded evidence promptly before closing the simulator:

```sh
hls-dash-live-sim control evidence \
  --session-file output/agent-run/session.json \
  --output output/agent-run/evidence.json

hls-dash-live-sim control diagnostics \
  --session-file output/agent-run/session.json \
  --output output/agent-run/recent.jsonl
```

Check `droppedEvents` in the `diagnostics.snapshot` header (or use `--diagnostics-file` / `--diagnostics-rotate-files` started with the stream for a complete trace). Send `SIGINT` or `SIGTERM` to the `livesim` process when finished so owned ports and any DASH Docker container shut down cleanly.
