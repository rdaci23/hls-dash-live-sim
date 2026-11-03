# Interactive scenario runs

The normal UI uses [session-scoped controls](session-controls.md). A developer or
QA tester connects a running simulator, opens its playback URL in an external
player, prepares a preset and chooses when fault delivery starts. Publication,
retention and local UTC keep advancing during Stop and mode changes. Repository
and npm publication remain separately controlled; these commands do not publish.

## Setup

Use an isolated healthy starting file and configure a simulator control token:

```sh
npm run build
mkdir -p output
cp examples/configurations/healthy.json output/session-base.json
export HLS_DASH_CONTROL_TOKEN="$(node -p 'require("node:crypto").randomBytes(24).toString("hex")')"
printf 'Simulator control token: %s\n' "$HLS_DASH_CONTROL_TOKEN"
npm run hls -- --fixture tracks --fault-config output/session-base.json
```

For the optional local DASH tracks source, use `npm run dash -- --fixture tracks
--fault-config output/session-base.json`. Start `npm run fault-control` in another
terminal and open its printed URL. The normal UI does not require its legacy
fault file or token to match the simulator's. Connect the manifest URL, then
enter the **simulator** token under Control access and unlock controls. Tokens
stay in page memory and must not appear in playback URLs or exported settings.

Ordinary tokenless simulators still allow playback/inspection, with read-only
controls and setup guidance. Supplying a token enables the new interactive
capability on ordinary sources without changing automatic startup. An automatic
`--scenario` definition remains externally managed/read-only. To expose a custom
startup definition for interactive preparation, also pass `--scenario-start
manual`; it appears as the `loaded` catalog item.

## Prepare, start and stop

**Scenarios** offers compatible presets first, search/categories and an optional
unavailable filter. Requirements and expected effects are part of each preset.
The connection step discovers advertised HLS child playlists through bounded
baseline previews; DASH discovers declared tracks from its MPD. This metadata
discovery does not download media/init/keys or establish cache/freeze/retry
prerequisites. Some effects still require ordinary requests from your player.

1. Choose a compatible preset and select **Prepare test**. If necessary, the
   explicitly labeled action first stops manual faults and changes control mode.
   Preparing binds an immutable definition and fresh run ID; no fault starts.
2. Review the prepared fault, target and timing. A new selection remains separate
   from the prepared definition and requires preparation again.
3. Select **Start test** when your external player is ready. Start revalidates
   advertised capabilities without fetching targets or consuming faults.
4. Observe automatically refreshed run state and active effects. **Stop test**
   cancels only that run's affected work, removes its timers/freeze state and
   disarms the definition. Prepare explicitly before another run.

Switching tabs never changes modes or starts/replays faults. Switching between
Manual faults and Scenarios is explicit and stops the prior test first. The UI
never seeks or restarts the external player. A cancelled response remains a
cancelled/incomplete observation, rather than becoming a delivered-fault pass.

The Manifest tab displays a stable [baseline preview](manifest-preview.md), not
the last faulted playback response. Refreshing or selecting another playlist is
inert; actual playback URLs still exercise frozen/malformed/status responses.
Copy/download use the original snapshot text even with display formatting.

Evidence includes current/previous scenario reports, bounded manual settings
changes/results and the existing redacted diagnostic window. Up to ten previous
scenario results and ten manual tests are retained. Manual changes are bounded
to 32 per test, with explicit drop counters. Export before those limits when a
complete sequence is needed; inspect diagnostic drop counters too. This snapshot
does not replace complete rotated-file endurance evidence. Simulator delivery
and player playback/recovery remain separate results.

## Scoped API

GET/HEAD `/session-control`, `/session-control/catalog` and
`/session-control/evidence` observe the connected session without taking control.
POST `/session-control/mode`, `/apply`, `/inject`, `/clear`, `/arm`, `/start` and
`/stop` use the same prefix and require its token, session ID and current revision.
Scenario mutations additionally require the current run ID. See the complete
[session-control API](session-controls.md#api-reference).

An initial `mode: "scenario"` claim on an existing healthy manual-start session
preserves an already prepared/active definition. A true mode change stops the old
test and clears manual delivery. Writes never persist scoped settings into a
shared file. Browser reconnection retains server state; simulator restart creates
a new identity and discards it. Settings are never silently replayed.

## Legacy scenario API

`--scenario-start manual` remains supported for existing clients. It requires the
default proxy and a token of at least 16 characters even on loopback. Set that
token with `HLS_DASH_CONTROL_TOKEN`, the streaming CLI's `--control-token`, or the
programmatic `controlToken` option. In this legacy workflow, all watched manual
faults must remain off; the normal scoped mode isolates its settings after an
explicit takeover.

GET/HEAD `/scenario`, `/scenario/catalog` and `/scenario/evidence` retain their
existing report shapes. Before scoped takeover, POST `/scenario/arm`,
`/scenario/start` and `/scenario/reset` require Authorization, `X-Sim-Session-Id`,
JSON Content-Type and the current `runId`; arm also requires a catalog `presetId`.
Old session/run IDs return 409 and wrong tokens return 401. The body limit is
64 KiB with a ten-second read deadline. No action accepts an arbitrary URL or
server path. Start does not perform discovery; custom definitions remain immutable.

Legacy Reset cancels affected run work, archives started results and leaves the
preset armed with a new ID. This differs from the new UI's Stop, which disarms.
After scoped takeover, legacy arm/start/reset POSTs return 409 so clients cannot
bypass revision checks. Legacy reads stay available.

The existing `/scenario/access` POST is a narrow service exception: only an active
local token-expiry scenario may issue/renew player access credentials. It retains
token/session/current-run validation, rejects manual/stopped/transitioning states
and does not change the control revision or scenario lifecycle. Credential bodies
are never part of reports or exported evidence. [Local-service scope](local-services.md).

## Verification

```sh
npm run controls:verify -- --output output/manual-controls
npm run test:ui
```

The legacy isolated verifier covers both adapters, token/session/run rejection,
unsupported inputs, inert reads, prepare/start/retry, affected-transfer cancellation,
healthy-transfer survival and retained results. DASH's engine verifier needs the
pinned local Docker image; `--protocol hls` is Node-only. Focused tests separately
exercise scoped authentication, revision conflicts, private source isolation,
one-shot preservation/rearm, mode transitions, bounded history and legacy-route
compatibility. Inspect the exact candidate's reports for executed browser checks;
the presence of a test or workflow is not qualification evidence.
