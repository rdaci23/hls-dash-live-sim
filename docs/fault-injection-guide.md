# Fault controls

Start a simulator with a control token and open its URL in the control UI:

```sh
export HLS_DASH_CONTROL_TOKEN="$(node -p 'require("node:crypto").randomBytes(24).toString("hex")')"
printf 'Simulator control token: %s\n' "$HLS_DASH_CONTROL_TOKEN"
npm run hls
# Another terminal:
npm run fault-control
```

The default panel is `http://127.0.0.1:19090`. Connect the printed simulator URL
and unlock it with that simulator's token. Normal writes affect only that session
and do not need a matching controller file. Tokenless streams remain read-only
for playback/inspection. [Session API, modes and lifetime](session-controls.md). See
[network access](../README.md#network-access) before enabling LAN control.

| Control              | Supported effect                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Segment missing      | HTTP 404 before fetching or serving media.                                                                                               |
| Segment forbidden    | HTTP 403 before fetching or serving media.                                                                                               |
| Malformed segment    | Truncated media bytes in a completed full response; range responses instead corrupt bytes in place, preserving Content-Range and length. |
| Latency              | Fixed response delay from 0 to 60000 ms; cancelled on disconnect or session shutdown. This is not bandwidth throttling.                  |
| Bandwidth limit | Shared per-session ceiling for successful media/init GET bodies, 0–1,000,000 decimal kbps; 0 disables. |
| Jitter | Additional uniformly sampled 0–N ms before media/manifest GET responses, N = 0–60,000 ms. |
| Manifest freeze      | Holds live HLS timelines/child playlists or the latest observed DASH MPD. Unfreezing resumes current live time.                          |
| HLS key HTTP failure | HTTP 403 on a remote HLS key request.                                                                                                    |
| HLS key mismatch     | A mismatching 16-byte HLS key response. Requires actual encrypted origin content.                                                        |

For network units, scope, cancellation and timing examples, see
[bandwidth and jitter](network-conditions.md).

## Inspecting current state

The connection bar reports the observed protocol, control mode and active effects;
technical IDs and timestamps live under Advanced. **Copy Playback URL** copies the root manifest URL, which stays fixed
when an HLS child is selected. **Copy Displayed URL** copies the selected playlist
or MPD URL. A loopback URL is for this computer; use a deliberately LAN-bound
simulator URL on another device. The UI does not invent unverified LAN aliases.

**Active effects** shows the connected simulator's runtime state. Unsaved edits
do not change that summary. A configured `once` setting can remain configured
after consumption; runtime status distinguishes `armed` and `consumed`. Random
or always settings report `enabled`, which does not mean a particular request was
faulted. HLS key rules still require an encrypted origin. Scenario sessions show
the scenario result instead of claiming manual faults apply.

For retry scenarios, a delivered fault and a successful retry are separate
observations. **One video 404 and retry** requires the completed 404 to be
followed by a new GET that completes with nonempty 200/206 media for the same
resource, track and byte range. A different rendition's successful request does
not qualify. The player may continue playing through its buffer, switch
renditions or skip the failed fragment. The rule remains pending until retry
completion; if no matching retry occurs, **Stop test** retains an incomplete
result. A failed or cancelled retry can instead fail the assertion. The control
API establishes simulator delivery and matching requests; player traces are
needed to identify fallback or rendered recovery. Verifying one retry does not
complete other rules or timeline requirements in the same run.

Visible-page status polling observes health and scoped state without consuming
faults. Drafts remain intact; a conflicting revision requires explicit reload or
reapply. Session changes disable writes and never replay a previous test. Tabs
only navigate. Switching between Manual and Scenarios is explicit and stops the
current test while keeping its evidence, publication and UTC clocks.

**Copy original** and **Download original** export the original baseline text,
without refreshing the stream. Master/child HLS files use `.m3u8`; DASH uses
`.mpd`. Exports use the retained snapshot. Changing/disconnecting the stream or
detecting a new session clears it; changing the control token does not change
that baseline. Clipboard denial offers manual-copy guidance.
The snapshot is raw text, with its original relative URLs; opening it as a local
playback file is not guaranteed to work. Use the original simulator URL as the
base, and keep that simulator session running for its resources.

## Modes and API

Segment and key fault modes are `off`, `once`, `always` and `random`. Freeze accepts
only `off` and `always`; other values return HTTP 400. DASH freeze identifies a
stream by its path, so changing cache-busting or time query parameters does not
bypass it. Both proxies limit cached manifests to 128; requesting a new stream
beyond the frozen snapshot limit returns HTTP 503 until unfreezing. Generated
HLS follows the same latest-observed snapshot semantics as the proxies. Freeze
holds manifest bytes; media publication/expiry and local UTC continue. See the
[simulator freeze/resume verification](manifest-freeze.md) for repeatable checks.

A one-shot fault consumes one matching GET request across resources; HEAD requests
and requests cancelled during artificial latency do not consume it. Quick Inject
rearms the selected fault on each call. Resetting to `off` then `once` also works,
even when another process observes only the final configuration file. Generated
`_oneShot` identifiers make these arm changes durable; preserve them during unrelated
manual edits. These are arm identifiers, not an event queue: multiple injections
before consumption coalesce into the latest arm. Random uses 40 percent per matching request and is
not yet seeded. There is no DRM license simulator; key controls do not affect DASH
or the clear samples. The profile field is a session label, not a stored scenario.

## Separate legacy shared-file API

The Advanced legacy link (`?legacy=1`) retains the original file workflow. Only
this tool needs matching absolute fault-file paths. Its controller credential is
separate from the simulator token; inspecting a URL never retargets file writes.

The legacy JSON configuration is validated, saved atomically and watched through directory
changes. Invalid edits keep the last valid config. Unknown fields and negative or
excessive latency return HTTP 400; failed writes are reported rather than acknowledged
as saved. Partial API writes reread the latest valid file under an exclusive
`.lock` file; concurrent cooperating writers return HTTP 409 and should retry.
Manual file writers are outside this lock and can still race a save. If a process
crashes during a save, confirm that its PID in the lock file has exited before
removing that stale lock. Example configuration is in [examples/faults.json](../examples/faults.json).

The API exposes `GET /config`, `POST /config`, `POST /inject`, `POST /reset` and
`POST /profile`. Cross-origin control requests are rejected. A LAN control server
requires a bearer token of at least 16 characters, configured with
`HLS_DASH_CONTROL_TOKEN` or `--control-token`; enter the same token in the panel.
Tokens are not embedded in the page. Use a separate fault-config path for each
independent simulator process.

One-shot `POST /inject` responses include a `faultId`. It matches the affected
response's `X-Sim-Fault-Ids` header and the stream server's recorded fault events.
Use `X-Sim-Request-Id` to find the exact request. Both protocols support redacted
JSONL capture with `--diagnostics-file` and recent-history export at `/diagnostics`
on the stream port. See [event meanings, redaction and limits](diagnostics.md).

Export evidence promptly after a test and inspect its diagnostic drop counters.
The bounded event window can discard the original failure/retry details while
a retained scenario summary still records whether the assertion completed.

Players buffer ahead. A queued fault takes effect when the matching resource is
requested, not when previously buffered media plays. Freeze can expose this delay
as the player drains its buffer. Recorded consumption/application/cancellation
events show what the simulator did. Deterministic status rules and HTTP retry
assertions are available through [scenario rules](scenarios.md). The first
video-404/retry preset has full browser and one-model physical Roku coverage for
startup and established playback. The separate [sustained-outage checks](sustained-outages.md) retain browser
passes and native Roku failures for their exact profiles. Manifest freeze/resume
is [verified at the simulator HTTP boundary](manifest-freeze.md); player recovery
from a stale manifest and broader ABR behavior need separate client evidence. See [playback gates](playback-gates.md).
