## Fault Injection Guide

This guide explains how to trigger the HLS and DASH fault scenarios that now ship with `hls-dash-live-sim`. It also documents the logging output you will see in the terminal so you can verify when a request was served successfully versus when an injected error occurred.

### 1. Configuration Overview

- **Config file**: the simulators read `.hls-dash-faults.json` from your project root by default. Override with `--fault-config <path>` or the env var `HLS_FAULT_CONFIG` / `DASH_FAULT_CONFIG`.
- **Profiles**: a simple string identifier stored under `profile`. Use it to tag a known set of toggles (for example `profile: "roku-latency"`).
- **Watch mode**: the file is monitored with `fs.watch`, so any external edits (JSON merge, the control UI, etc.) are applied in realtime without restarting the simulators.
- **JSON structure**:

```json
{
  "profile": "default",
  "segment": {
    "malformed": "off",
    "forbidden": "off",
    "missing": "off",
    "latencyMs": 0
  },
  "drm": {
    "licenseFailure": "off",
    "keyRotationMismatch": "off"
  },
  "manifest": {
    "freeze": "off"
  }
}
```

`FaultMode` can be `off | once | random | always`. Use `latencyMs` to add artificial delay.

### 2. HLS Simulator (`live-hls-sim`)

Start the proxy with fault injection enabled:

```bash
hls-dash-live-sim livesim start --sim-type hls --detach --fault-config ./faults/hls.json
```

Key options:

- `--fault-config <path>`: override the JSON file (defaults to `.hls-dash-faults.json`).
- `--fault-profile <name>`: set the `profile` key on boot.

Logging examples (always printed when a request completes):

```
[hls] {"timestamp":"2025-11-03T13:35:41.814Z","event":"manifest","status":200,"path":"/proxy.m3u8","freeze":false,"source":"dummy"}
[hls] {"timestamp":"2025-11-03T13:35:42.009Z","event":"segment","status":200,"path":"/dummy/segments/segment0.ts","bytes":124928,"source":"dummy"}
[hls] {"timestamp":"2025-11-03T13:35:55.221Z","event":"segment","status":404,"path":"/dummy/segments/segment1.ts","fault":"missing","source":"dummy"}
```

- `status: 200` without `fault` means the segment was served successfully.
- Faults (`missing`, `forbidden`, `malformed`, `licenseFailure`, `keyRotationMismatch`) are annotated in the JSON payload.
- When latency is configured you still receive a single log per request once the response finishes.

### 3. DASH Simulator (`live-dash-sim`)

The DASH simulator now wraps livesim2 in a local HTTP proxy so we can inject segment/manifest failures. Because the proxy runs alongside the CLI, **you must use `--detach`** to enable it.

```bash
hls-dash-live-sim livesim start --sim-type dash --detach --fault-config ./faults/dash.json
```

Important flags:

- `--fault-proxy` (default `true`): disable with `--no-fault-proxy` if you need the raw Docker binding.
- `--fault-config`, `--fault-profile`: same behavior as HLS.

When the proxy is active you will see `dash` log lines:

```
[dash] {"timestamp":"2025-11-03T13:36:11.048Z","event":"segment","status":200,"path":"/livesim2/test/segment_1.m4s","bytes":238944}
[dash] {"timestamp":"2025-11-03T13:36:18.432Z","event":"segment","status":403,"path":"/livesim2/test/segment_2.m4s","fault":"forbidden"}
[dash] {"timestamp":"2025-11-03T13:36:20.006Z","event":"manifest","status":200,"path":"/livesim2/test/manifest.mpd","freeze":true}
```

If a container is already running without the proxy, the CLI restarts it automatically so the fault layer can bind.

### 4. HLS / DASH Fault Control UI

Start the control UI *before* (or alongside) the simulator so both point at the same fault config file. A typical workflow is:

```bash
# recompile after making changes
npm run build

# launch the UI first so it writes/owns .hls-dash-faults.json
node dist/cli.js fault-control --fault-config ./.hls-dash-faults.json

# start the simulator watching the same file
node dist/cli.js livesim --sim-type hls --detach --fault-config ./.hls-dash-faults.json
```

Remember that HLS/DASH players buffer aggressively. When you toggle a fault to `always`, existing buffered segments still play out; force a new request (seek/skip in the tester) to see the fault immediately.

Features:

- View and edit the live configuration (segment faults, manifest freeze, DRM errors, latency).
- Fire one-off injections (malformed/403/404 segments, license/key failures, latency spikes) with a single click while the stream is playing.
- Apply a profile name for quick identification.
- Built-in `curl` helper snippets if you prefer hitting the REST endpoints directly.

Visit `http://localhost:19090/` (or the host/port you specify). Every change you make is written back to the config file and immediately picked up by both simulators.

### 5. Workflow Tips

1. **Start simulators** with `--detach` when you intend to use fault injection.
2. **Tail the logs** in your terminal – successful requests (status `200`) stay visible so you can differentiate between normal playback and injected errors.
3. **Toggle scenarios** via the web UI or directly edit `.hls-dash-faults.json`. Changes are live without restarts.
4. **Document test runs** by saving the JSON payload from the log lines; they are machine-readable and easy to ingest into test reports.

With these utilities you can quickly simulate DRM, network, and segment-level edge cases for both HLS and DASH without touching production streams.
