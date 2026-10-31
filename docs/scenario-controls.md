# Manual scenario runs

Automatic scenario startup remains the default. Manual mode lets you load a
player, arm a supported preset, and choose when its elapsed-time clock starts.
Publication, retention and local UTC keep their real-time clocks during resets.
The repository and npm package remain private.

## Setup

Use an isolated, healthy fault file. The token below is generated locally; use the
same value for the control page and the stream. Do not put tokens in URLs,
screenshots, commits or shared shell transcripts.

```sh
npm run build
export HLS_DASH_CONTROL_TOKEN="$(node -p 'require("node:crypto").randomBytes(24).toString("hex")')"
node dist/cli.js fault-control --fault-config ./output/manual-faults.json
```

In a second terminal, export that same token and run one of:

```sh
node dist/cli.js livesim --sim-type hls --scenario-start manual --fault-config ./output/manual-faults.json
node dist/cli.js livesim --sim-type dash --asset abr --scenario-start manual --fault-config ./output/manual-faults.json
```

Open the printed control URL, enter the token, and select **Connect**. Load the
stream's printed manifest URL. **Scenario runs** shows the preset catalog,
requirements, resource targets, expected effect, current run ID and outcome.
Arming binds the definition to a fresh run ID; another arm creates a new ID even
if the previous definition was never started. Unsupported presets explain why they cannot be armed; HLS TS has no separate
initialization object. Select **Arm Preset**, prepare your player, then **Start
Scenario**. **Refresh Run** updates progress without consuming a fault. Manifest
inspection can consume a manifest fault, so refresh run status when observing
without sending a matching GET.

**Reset Run** cancels only this run's affected in-flight responses, removes its
timers and freeze snapshots, archives its result and creates a new run ID. It
leaves the selected preset armed for replay. Healthy transfers and publication
continue. A cancelled response remains a cancelled/failed observation; reset does
not turn it into a pass. Up to ten previous results are retained; older-result
drops are counted explicitly. Download evidence before exceeding that limit.

**Download Run Evidence** includes current/previous results and the existing
redacted bounded diagnostic snapshot. It contains no control token or arbitrary
source path. Consult diagnostic drop counters before treating an export as
complete; this snapshot does not replace the later endurance evidence gate.
HTTP delivery and browser playback/recovery are separate results.

## API

GET/HEAD `/scenario`, `/scenario/catalog` and `/scenario/evidence` observe the
connected session. POST `/scenario/arm`, `/scenario/start` and `/scenario/reset`
require `Authorization: Bearer …`, `X-Sim-Session-Id`, JSON `Content-Type` and the
current `runId` in their body. Arm also requires a catalog `presetId`; start/reset
accept no other fields. Old session/run IDs return 409; missing/wrong tokens
return 401. The body limit is 64 KiB, with a ten-second read deadline.
The local host/origin policy still applies. No endpoint accepts a server file
path or fetch URL. Start with `--scenario` to expose a validated custom
startup definition as the `loaded` catalog item; run definitions are immutable.

All saved manual faults must be off before arm/start. Reset remains available to
clean up a run if the shared file was edited during playback. These endpoints do
not exist in automatic mode; its legacy `/scenario` result shape is unchanged.
The optional CLI/API `scenarioStart: "manual"` requires the default proxy and a
control token of at least 16 characters even on loopback.

## Verification

```sh
npm run controls:verify -- --output output/manual-controls
npm run test:ui
```

The isolated verifier covers both adapters, authentication/session/run rejection,
unsupported inputs, inert reads, armed-but-inactive delivery, start/retry,
affected-transfer cancellation, healthy-transfer survival, retained results and
secret-free export. DASH needs the pinned local Docker image. `--protocol hls`
is Node-only. Tests additionally cover bounded history, immutable definitions,
capability rejection and browser arm/start/reset/download flows for both protocols.
CI retains reports and diagnostics with the candidate commit and dirty-tree flag.
