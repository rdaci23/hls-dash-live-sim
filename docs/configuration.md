# Configuring sessions

The normal UI uses [session-scoped controls](session-controls.md): connect a
simulator URL, unlock with that simulator's token and explicitly choose a control
mode. Writes affect only that session, never the control server's fault file.
Connecting or inspecting a stream does not change delivery or take ownership.

The legacy shared-file tool remains available explicitly through Advanced →
**Open legacy shared-file controls** (`?legacy=1`). For that workflow, use separate
files for independent sessions and pass the same **absolute** `--fault-config`
path to a stream and its legacy controller. Relative paths resolve from each
command's working directory; inspecting a stream does not retarget that file.

Authenticated session control supports mutually exclusive manual faults and
interactive scenarios. [Manual scenario runs](scenario-controls.md) retain their
legacy arm/start/reset API until scoped takeover. Automatic scenario startup
remains the default and is externally managed/read-only in the new UI.

## Manual configuration versus scenario files

| File | Purpose | Editing during a session |
| --- | --- | --- |
| `--fault-config` JSON | Legacy watched manual settings and the initial settings before UI takeover. | Watched live outside scoped UI control; isolated sessions ignore later changes. |
| `--scenario` JSON | Immutable HTTP rules and/or scheduled network/freeze timeline. | Restart to load a new definition. |

Manual settings must be off when starting a scenario. Automatic timeline-owned
sessions continue rejecting conflicting manual settings after the final phase;
restart a normal session to return to legacy file control. Session-scoped UI
mode changes explicitly stop the previous test and clear manual delivery before
enabling another mode. [Scenario recipes](scenario-recipes.md).

Without `--fault-config`, a command uses `.hls-dash-faults.json` in its working
directory, creating defaults if needed. That local file is ignored by Git. For
reproducible work, explicitly select an isolated file under `output/` instead.

See [payload/transport actions](payload-transport-scenarios.md) for intentionally
invalid bodies, header delay, slow progress, HTTP/1.1 framing and supported
shared-network combinations. These are scenario actions, not watched manual fields.

See [HTTP policy and controlled response headers](http-policy-scenarios.md) for
conditional requests, range resumption and bounded status-header presets.

## Stream windows

Window sizing depends on the stream format. With `--fixture tracks`, owned HLS
live streams currently require `--window-segments 5–120`; the default remains six.
Invalid three-/four-segment live HLS windows fail at startup. DASH and EVENT/VOD
fixtures, and ordinary MPEG-TS HLS, retain 3–120. See
[fixture timing and window boundaries](track-fixtures.md) before changing it.

## Ready-to-copy legacy manual configurations

| Starting file | Behavior |
| --- | --- |
| [healthy.json](../examples/configurations/healthy.json) | Every fault and network control off; recommended baseline and scenario companion. |
| [slow-network.json](../examples/configurations/slow-network.json) | Shared 450 kbps media cap plus random 0–150 ms response jitter. |
| [frozen-manifest.json](../examples/configurations/frozen-manifest.json) | Holds observed live manifests until freeze is turned off. Publication/media expiry continue. |

Copy a sample before running, so legacy controls never edit a checked-in example:

```sh
mkdir -p output
cp examples/configurations/slow-network.json output/manual-faults.json
npm run hls -- --fault-config output/manual-faults.json
# In another terminal, from the same directory:
npm run fault-control -- --fault-config output/manual-faults.json
# Open the printed control URL with ?legacy=1 for this shared-file workflow.
```

Use **Reset (all off)** in the legacy control UI to restore a healthy baseline. Clearing
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
| `drm.licenseFailure` / `keyRotationMismatch` | Legacy names for HLS encrypted-origin key faults. Legacy files have no effect on clear samples/DASH; scoped controls reject unsupported non-off values. |
| `logging.verbose` | Boolean; emit redacted diagnostic events to stderr. |

Unknown fields and out-of-range settings are rejected. Manual `random` status
faults use unseeded 40% probability; manual jitter is also unseeded. Use a scenario
seed for repeatable choices. `once` means one matching GET, not one playback event;
Quick Inject rearms it. HEAD does not consume segment/key one-shots. The shared
cap is across concurrent requests, rather than a separate limit for each rendition.
[Precise network timing](network-conditions.md) and [fault semantics](fault-injection-guide.md).

The legacy UI and its `POST /config` support partial patches. For file editing, keep a complete
validated configuration and replace it atomically; avoid leaving a half-written
JSON document. Cross-process updates use filesystem events with a polling fallback.
Example legacy API patch for an unprotected local control server:

```sh
curl -fsS -X POST http://127.0.0.1:19090/config \
  -H 'Content-Type: application/json' \
  --data '{"network":{"bandwidthKbps":450,"jitterMs":150}}'
```

## Access and credentials

Default bindings are local. LAN stream access and LAN control access are separate.
Keep the control server on loopback when only playback needs LAN access. For
session-scoped UI writes, configure the simulator token; ordinary tokenless streams
still support playback and inspection. The streaming CLI accepts `--control-token`
or `HLS_DASH_CONTROL_TOKEN`. The page keeps that token only in memory, so a browser
refresh requires unlocking again while the simulator's current test continues.
The legacy controller's token protects its shared-file API independently.

For protected legacy LAN control, set a fresh token and launch the process:

```sh
export HLS_DASH_CONTROL_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
npm start -- fault-control --host 0.0.0.0 --fault-config output/manual-faults.json
```

Enter that controller token in the legacy UI. Protected legacy API calls need
`Authorization: Bearer $HLS_DASH_CONTROL_TOKEN`. Do not commit it or put it in a
playback URL. The token protects control mutations; it is not stream DRM.

In normal session control, settings survive reconnecting to the same simulator
UUID but are discarded on simulator restart. Export/import is explicit; imported
settings are drafts requiring Apply. No settings are silently replayed onto a
new session. See [session controls](session-controls.md) for the API and lifecycle.

HLS origin authorization is scoped to the manifest origin; use `--allow-origin`
for an explicitly permitted CDN. Keep auth files, private media and signed URLs
outside committed examples. Never use production credentials for demonstrations.
[Diagnostics redaction](diagnostics.md) and [security reporting](../SECURITY.md).

## HTTP/2 over TLS

Streams use plain HTTP/1.1 unless you opt in. Apple's players (Safari and
AVPlayer) play [low-latency HLS](generated-streams.md#low-latency-hls) at low
latency only over HTTP/2, and they use HTTP/2 only over TLS; on HTTP/1.1 they
fall back to normal latency. `--http2` serves players over HTTP/2 with TLS.
HTTP/1.1 stays available on the same port: each client picks its protocol while
connecting (ALPN).

```sh
npm run certs:local
npm start -- livesim --sim-type hls --low-latency --http2 \
  --tls-cert .certs/server.pem --tls-key .certs/server.key
# HLS live ready: https://127.0.0.1:8899/proxy.m3u8 (HTTP/2 over TLS; HTTP/1.1 also offered)
```

| Option | Meaning |
| --- | --- |
| `--http2` | Serve players over HTTP/2 with TLS. Off by default. Needs both files below. |
| `--tls-cert <file>` | PEM server certificate (with any intermediate certificates). Used only with `--http2`. |
| `--tls-key <file>` | PEM private key for that certificate. Used only with `--http2`. |

The options apply to `livesim start` (HLS, DASH and `--fixture tracks`), to
`dummy-stream` and to the named `*-stream` templates. They are checked before a
port is bound. HLS MP4 VoD (`--no-proxy`) and DASH with `--no-fault-proxy` bypass
the Node server and reject `--http2`. The `fault-control` page stays on HTTP/1.1;
players never fetch it. The library takes the PEM contents:
`startHlsim({ lowLatency: true, http2: { cert, key } })`, and the same `http2`
option on `startLivesim2()` and `startDashFaultProxy()`.

### Local certificates

`npm run certs:local` in a checkout, or `hls-dash-live-sim certs` from the npm
package, creates a local certificate authority (CA) and a server certificate
signed by it in `.certs/` (in the working directory):

| File | Use |
| --- | --- |
| `ca.pem` | The CA certificate. Trust this on each simulator or device. |
| `server.pem`, `server.key` | Pass to `--tls-cert` and `--tls-key`. |
| `ca.key` | Signs new server certificates. Keep it private. |

The server certificate covers `localhost`, `127.0.0.1`, `::1` and this
computer's LAN IPv4 addresses at the time it is created. Add names with
`--extra-host`, for example
`npm run certs:local -- --extra-host my-mac.local --extra-host 10.0.2.2`.
`--no-lan` leaves out the LAN addresses, and `--dir` writes elsewhere. A rerun
issues a new server certificate and reuses the CA, so anything that already
trusts the CA keeps working; rerun after this computer's LAN address changes.
The server certificate is valid for 397 days and the CA for 825 days.

Keys are written with mode 0600. `.certs/` is ignored by Git, and the script also
writes a `.gitignore` into its directory, so another `--dir` inside a checkout is
ignored too. Do not copy `ca.key` to a device: a device only needs `ca.pem`. The
script needs `openssl` on `PATH`.

### Trusting the CA

Trust `ca.pem`, never the server certificate:

- **iOS and tvOS simulators**: `xcrun simctl keychain <udid> add-root-cert .certs/ca.pem`
  (`booted` works in place of a UDID). It takes effect without a restart.
  `xcrun simctl keychain <udid> reset` removes it along with everything else
  added to that simulator's keychain.
- **iPhone and iPad**: send `ca.pem` to the device (AirDrop, Mail, or a page that
  serves it) and open it, then install the downloaded profile in
  **Settings → General → VPN & Device Management**. Finally turn on full trust
  for it in **Settings → General → About → Certificate Trust Settings**. iOS does
  not trust an installed root for TLS until that switch is on.
- **Apple TV**: install `ca.pem` as a configuration profile with Apple
  Configurator or device management, then enable it in
  **Settings → General → About → Certificate Trust Settings**. This was not tried
  on a device here.
- **macOS (Safari, Chrome)**: add it to the login keychain and mark it trusted
  for SSL in Keychain Access, or run
  `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db .certs/ca.pem`
  (it asks for your password). Remove it from Keychain Access when you are done.
- **Android**: **Settings → Security → Encryption & credentials → Install a
  certificate → CA certificate**. Android apps trust user-installed CAs only when
  their network security configuration allows `<certificates src="user"/>`;
  Chrome on Android does.

For LAN players, start with `--host 0.0.0.0` and use the LAN address that the
certificate covers, for example `https://192.168.1.20:8899/proxy.m3u8`.
`--allow-host` is still needed for names this computer does not own, such as
`10.0.2.2`, and the certificate must list that name too.

To proxy an HTTPS origin that uses this CA (for example another simulator
started with `--http2`), start the proxy with `NODE_EXTRA_CA_CERTS=.certs/ca.pem`.
The proxy always fetches from origins over HTTP/1.1.

### Faults on HTTP/2

Statuses, payload faults, delays, stalls, slow bodies, bandwidth limits,
scenarios, session controls and diagnostics behave as on HTTP/1.1. HTTP/2 carries
many requests on one connection, so faults that end a connection on HTTP/1.1
end only the request's own stream (RST_STREAM) and leave the other requests,
such as a held playlist reload, running:

| Transport action | HTTP/1.1 | HTTP/2 |
| --- | --- | --- |
| `abort` | Closes the connection after the prefix. | Resets the stream with `INTERNAL_ERROR` after the prefix. |
| `reset` | TCP reset before any response. Over TLS, Node cannot send a TCP reset, so the connection is closed without a response. | Resets the stream with `INTERNAL_ERROR` before any response. |
| `no-response` | Holds the connection silent, then resets it. | Holds the stream silent, then resets it with `INTERNAL_ERROR`. |
| `framing`, `content-length` | Declares 16 more bytes than it sends, then closes. | Same headers and body, then resets the stream with `PROTOCOL_ERROR`. |
| `framing`, `chunked` | Sends an invalid chunk-size token. | HTTP/2 has no chunked coding: headers without a length, then `PROTOCOL_ERROR`. |

Ending a session or cancelling a scenario run also resets the affected streams
rather than closing their connections. HTTP/3 is not offered.

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

The optional tracks source accepts HLS-only `--hls-aes` for rotating local
AES-128 keys and clear transitions. [Local services](local-services.md) explains
the additive `services` scenario object, authenticated `/scenario/access` endpoint
and named UTC GET/HEAD exceptions. None is enabled in ordinary healthy streams.
