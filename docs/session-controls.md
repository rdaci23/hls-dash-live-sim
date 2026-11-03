# Session-scoped testing controls

The normal control page connects to one running HLS/DASH simulator. Its writes
go directly to that simulator's authenticated `/session-control` API. It does not
write the control server's legacy fault file or retarget another stream.

Use your own player for playback. The UI configures test conditions and reports
simulator delivery; it does not establish that a player recovered.

## Start and connect

Start a healthy simulator with a private control token of at least 16 characters:

```sh
npm run build
mkdir -p output
cp examples/configurations/healthy.json output/session-base.json
export HLS_DASH_CONTROL_TOKEN="$(node -p 'require("node:crypto").randomBytes(24).toString("hex")')"
printf 'Simulator control token: %s\n' "$HLS_DASH_CONTROL_TOKEN"
npm run hls -- --fixture tracks --port 8899 --fault-config output/session-base.json
```

For DASH, use `npm run dash -- --fixture tracks --port 8888 --fault-config
output/session-base.json` instead. The owned tracks fixture needs no external
media or clock service. The streaming CLI also accepts `--control-token`; the
environment avoids placing the token in a command argument.

In another terminal, start `npm run fault-control`. Open its printed URL, paste
the simulator's manifest URL and select **Connect stream**. Under **Control
access**, enter the simulator token and select **Unlock controls**. The control
page's legacy server token is separate and need not match the simulator token.
Keep both out of playback URLs, screenshots and shared transcripts.

The three tabs are:

1. **Scenarios:** choose a compatible preset, **Prepare test**, review the exact
   target, then **Start test** when your external player is ready. Preparation
   binds an immutable definition; it does not begin fault delivery. **Stop test**
   ends the run, disarms it and retains its evidence.
2. **Manual faults:** select **Use manual controls**, edit settings and explicitly
   **Apply settings** or **Inject once**. **Clear faults** restores the healthy
   manual settings for this session. Mode changes stop the previous test first.
3. **Manifest:** inspect the clearly labeled baseline preview. Selecting a child
   playlist or Refresh changes the displayed snapshot. Status polling does not.
   Copy/download export the original text, including when Readable XML or line
   wrapping changes its display.

Tabs only navigate. They never switch control modes, start a fault, replay a run,
seek a player or reset publication/UTC clocks. Starting an automatic `--scenario`
definition retains its existing startup behavior and is shown as externally
managed/read-only. Use `--scenario-start manual` when that loaded definition
should be prepared and started interactively.

For **One video 404 and retry**, fault delivery and retry success are separate
observations in **Simulator results**. After the injected 404 completes,
a later GET must complete with nonempty 200/206 media for the same resource,
track and byte range. A successful request for another rendition does not
satisfy that assertion. For presets with several rules or a timeline, verifying
one retry does not complete the remaining requirements.

A player may keep playing through buffered media, switch renditions or skip a
failed fragment. The rule remains pending while awaiting successful retry
completion, including when a retry is in flight. If no matching retry occurs,
it stays pending; **Stop test** retains that incomplete result. An unsuccessful
or cancelled retry can instead fail the assertion. The control API reports
simulator requests and delivery, without establishing which player strategy
kept playback moving. Use the player's own trace to identify fallback or playback
recovery.

## Isolation, lifetime and conflicts

Connecting, unlocking, status reads and baseline previews do not take control.
The first explicit mode/control action isolates the session from watched-file
updates. Thereafter, scoped manual settings live in that simulator's memory and
cannot change another session, even if it uses the same original fault file.
Legacy sessions outside scoped control continue following their selected file.

Settings and running tests survive refreshing, closing or reconnecting the
browser. Closing the UI does not stop the simulator. A simulator restart creates
a new session ID and discards scoped settings; the browser never replays them.
Control tokens stay in page memory only, so a browser refresh requires unlocking
again before further writes. Tokenless sessions remain usable for playback and
inspection but cannot accept session-control writes.

Every scoped mutation checks the session ID and current revision. Scenario
mutations also check the current run ID. Stale settings, changed sessions and
concurrent transitions are rejected. Automatic status refresh preserves unsaved
manual drafts. If another window changes the session, choose whether to load its
settings or explicitly reapply your draft against the latest revision. A draft
bound to another session must be exported/imported explicitly before reuse.

An internal cancellation/cleanup failure can occur after settings have already
changed. That failed mutation advances the revision, reports
`recoveryRequired: true`, and marks a partially ended manual result incomplete.
Refresh, then explicitly stop, clear or reselect the mode before applying more
faults. The UI never retries a mutation automatically or labels partial cleanup a
successful test. Invalid input, credentials and stale revisions remain inert.

`once` still means one matching request, not one player or playback event. An
unchanged Apply or read does not rearm a consumed one-shot; **Inject once** does.
HEAD exclusions and existing fault/network semantics remain unchanged. HLS key
faults require advertised encrypted HLS support; clear HLS and DASH reject them.

## Portable settings and evidence

The [constrained-network example](../examples/session-settings/constrained-network.json)
is ready to import as a draft.

Export settings contains only a versioned portable configuration:

```json
{
  "type": "hls-dash-manual-settings",
  "version": 1,
  "settings": {
    "segment": { "missing": "once", "latencyMs": 0 },
    "network": { "bandwidthKbps": 450, "jitterMs": 150 },
    "manifest": { "freeze": "off" },
    "drm": { "licenseFailure": "off", "keyRotationMismatch": "off" }
  }
}
```

Import accepts at most 64 KiB, validates fields/ranges against the connected
stream, and loads an unsaved draft. Apply remains explicit. Credentials, URLs,
session/run IDs and one-shot activation/consumption state are excluded. Unknown
or unsupported settings are rejected rather than silently dropped.

Test evidence is separate from portable settings. It includes bounded diagnostics
and retained scenario/manual results. A manual test retains up to 32 settings
changes, including explicit restoration to all-off, with action/revision/time and
portable values. At most ten completed manual tests and ten scenario results are
retained; dropped changes/results are counted. Export before those bounds if the
complete sequence is needed. Export promptly after a test: the diagnostic event
window can discard older request details while a retained run summary still
shows its result. Check diagnostic drop counters before treating an export as a
complete request history. See [diagnostic capture](diagnostics.md).

The manifest view is a [baseline preview](manifest-preview.md), not a captured
fault-response body. HLS discovery follows only advertised child playlists using
the same inert preview handshake. It does not download media, initialization or
keys, consume faults, seed freeze snapshots or establish cache/retry prerequisites.
Some presets still need ordinary player requests before their effect can occur.

## API reference

GET/HEAD `/session-control`, `/session-control/catalog` and
`/session-control/evidence` are inert reads. Missing Authorization returns readable
state with `authenticated: false`; a wrong supplied token returns 401. Capability
(`available`) and authentication are separate. Reads return the session identity,
revision, mode, portable settings, supported capabilities and current run summary;
catalog additionally returns compatible presets and unavailable reasons.

Every POST requires `Authorization: Bearer …`, `X-Sim-Session-Id`, JSON
`Content-Type` and the current numeric `revision` in its body:

| Endpoint | Additional JSON fields | Meaning |
| --- | --- | --- |
| `/session-control/mode` | `mode`: `manual` or `scenario` | Explicit scoped takeover/mode selection. A true mode change stops the previous test. |
| `/session-control/apply` | `settings` | Validated partial manual patch; manual mode required. |
| `/session-control/inject` | `type`; latency spike also requires `value` | Explicit one-shot rearm or supported latency action; manual mode required. |
| `/session-control/clear` | None | Clear manual faults and retain the prior manual result. |
| `/session-control/arm` | `runId`, catalog `presetId` | Prepare an immutable definition with a fresh run ID. |
| `/session-control/start` | `runId` | Start the already prepared definition. |
| `/session-control/stop` | `runId` in scenario mode | Stop/disarm a scenario or clear manual faults; retain evidence. |

Use returned revisions/run IDs for subsequent writes. Wrong tokens return 401;
stale session/revision/run/mode or concurrent transitions return 409; unsupported
capabilities return 422. Bodies are limited to 64 KiB with a ten-second read
deadline. Existing local Host/Origin checks remain in force. No control endpoint
accepts an arbitrary fetch URL or server file path.

The legacy `/scenario` API remains compatible before scoped takeover on
`--scenario-start manual` sessions. After takeover, its arm/start/reset POSTs are
rejected so clients cannot bypass revision checks; its reads remain available.
The narrow `/scenario/access` credential-renewal route remains available only
for an active local token-expiry run in scenario mode, with its existing token,
session/run identity and transition checks. Issuance does not change control
revision or fault/run lifecycle, and token bodies never enter reports/exports. Legacy
shared-file `/config`, `/inject`, `/reset` and `/profile` remain separate on the
fault-control server. Open that tool explicitly with `?legacy=1` from Advanced.

See [configuration](configuration.md), [scenario controls](scenario-controls.md)
and the [coverage matrix](coverage-matrix.md) for precise scopes and player limits.
