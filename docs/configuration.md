# Configuring sessions

Use separate files for independent sessions. When a stream and its control UI
should share controls, pass the same **absolute** `--fault-config` path to both.
Relative paths resolve from each command's working directory. Inspecting a stream
in the UI does not retarget the control server's file.

Opt-in [manual scenario runs](scenario-controls.md) add authenticated per-stream
arm/start/reset and replay with retained outcomes. Automatic startup remains the
default; it is separate from the watched manual fault file.

## Manual configuration versus scenario files

| File | Purpose | Editing during a session |
| --- | --- | --- |
| `--fault-config` JSON | Current manual settings, shared with the control UI/API. | Watched and applied live. |
| `--scenario` JSON | Immutable HTTP rules and/or scheduled network/freeze timeline. | Restart to load a new definition. |

Manual settings must be off when starting a scenario. Timeline-owned sessions
continue rejecting conflicting manual settings after the final phase; restart a
normal session to return to manual control. [Scenario recipes](scenario-recipes.md).

Without `--fault-config`, a command uses `.hls-dash-faults.json` in its working
directory, creating defaults if needed. That local file is ignored by Git. For
reproducible work, explicitly select an isolated file under `output/` instead.

See [payload/transport actions](payload-transport-scenarios.md) for intentionally
invalid bodies, header delay, slow progress, HTTP/1.1 framing and supported
shared-network combinations. These are scenario actions, not watched manual fields.

See [HTTP policy and controlled response headers](http-policy-scenarios.md) for
conditional requests, range resumption and bounded status-header presets.

## Ready-to-copy manual configurations

| Starting file | Behavior |
| --- | --- |
| [healthy.json](../examples/configurations/healthy.json) | Every fault and network control off; recommended baseline and scenario companion. |
| [slow-network.json](../examples/configurations/slow-network.json) | Shared 450 kbps media cap plus random 0–150 ms response jitter. |
| [frozen-manifest.json](../examples/configurations/frozen-manifest.json) | Holds observed live manifests until freeze is turned off. Publication/media expiry continue. |

Copy a sample before running, so the UI never edits a checked-in example:

```sh
mkdir -p output
cp examples/configurations/slow-network.json output/manual-faults.json
npm run hls -- --fault-config output/manual-faults.json
# In another terminal, from the same directory:
npm run fault-control -- --fault-config output/manual-faults.json
```

Use **Reset (all off)** in the control UI to restore a healthy baseline. Clearing
only network conditions does not clear unrelated status or freeze faults.
The `profile` field is a human session label; it does not choose an encoding or
activate a preset. `_oneShot` is internal arm state maintained by the control API;
do not copy consumed arm IDs into reusable examples.

## Manual fields

| Field | Values and scope |
| --- | --- |
| `segment.missing` / `forbidden` | `off`, `once`, `always`, `random`; inject 404 / 403 on matching media. |
| `segment.malformed` | Same modes; deliberately damages media. |
| `segment.latencyMs` | Fixed response delay, 0–60,000 ms. |
| `network.bandwidthKbps` | Shared media/init GET body cap, integer 0–1,000,000 decimal kbps; 0 disables it. |
| `network.jitterMs` | Additional random response-start delay, integer 0–60,000 ms; 0 disables it. |
| `manifest.freeze` | `off` or `always`; snapshot dynamic manifests. |
| `drm.licenseFailure` / `keyRotationMismatch` | Legacy names for HLS encrypted-origin key faults; no effect on clear samples or DASH. |
| `logging.verbose` | Boolean; emit redacted diagnostic events to stderr. |

Unknown fields and out-of-range settings are rejected. Manual `random` status
faults use unseeded 40% probability; manual jitter is also unseeded. Use a scenario
seed for repeatable choices. `once` means one matching GET, not one playback event;
Quick Inject rearms it. HEAD does not consume segment/key one-shots. The shared
cap is across concurrent requests, rather than a separate limit for each rendition.
[Precise network timing](network-conditions.md) and [fault semantics](fault-injection-guide.md).

The UI and `POST /config` support partial patches. For file editing, keep a complete
validated configuration and replace it atomically; avoid leaving a half-written
JSON document. Cross-process updates use filesystem events with a polling fallback.
Example API patch for an unprotected local control server:

```sh
curl -fsS -X POST http://127.0.0.1:19090/config \
  -H 'Content-Type: application/json' \
  --data '{"network":{"bandwidthKbps":450,"jitterMs":150}}'
```

## Access and credentials

Default bindings are local. LAN stream access and LAN control access are separate.
Keep the control server on loopback when only playback needs LAN access. For
protected control, set a fresh token in the environment and launch the process:

```sh
export HLS_DASH_CONTROL_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
npm start -- fault-control --host 0.0.0.0 --fault-config output/manual-faults.json
```

Enter that token in the UI. Protected API calls need
`Authorization: Bearer $HLS_DASH_CONTROL_TOKEN`. Do not commit it or put it in a
playback URL. The token protects control mutations; it is not stream DRM.

HLS origin authorization is scoped to the manifest origin; use `--allow-origin`
for an explicitly permitted CDN. Keep auth files, private media and signed URLs
outside committed examples. Never use production credentials for demonstrations.
[Diagnostics redaction](diagnostics.md) and [security reporting](../SECURITY.md).

## Save evidence

Create a new diagnostics file for each session:

```sh
npm run hls -- --fault-config output/manual-faults.json --diagnostics-file output/manual-requests.jsonl
```

Existing diagnostic files are never overwritten. `/health` observes status;
`/scenario` reports an active scenario; `/diagnostics` exports recent redacted
events. Configuration files, scenario definitions and player results serve
different purposes: a delivered fault does not by itself prove player recovery.

[Cache scenarios](cache-scenarios.md) document bounded rollback/negative-cache
definitions and distinct origin/edge session configuration.

[Publication scenarios](publication-scenarios.md) specify rendition-lag and
segment-delay bounds, asset requirements and configuration examples.

[Owned track fixtures](track-fixtures.md) document `--fixture tracks`, the optional
third video rendition, alternate audio/captions and per-track timeline shaping.
