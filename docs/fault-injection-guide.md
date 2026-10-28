# Fault controls

Start a simulator and control UI from the same directory:

```sh
npm run hls
# Another terminal:
npm run fault-control
```

The default panel is `http://127.0.0.1:19090`. For distinct working directories,
pass the same absolute `--fault-config` path to both commands. See
[network access](../README.md#network-access) before enabling LAN control.

| Control              | Supported effect                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Segment missing      | HTTP 404 before fetching or serving media.                                                                                               |
| Segment forbidden    | HTTP 403 before fetching or serving media.                                                                                               |
| Malformed segment    | Truncated media bytes in a completed full response; range responses instead corrupt bytes in place, preserving Content-Range and length. |
| Latency              | Fixed response delay from 0 to 60000 ms; cancelled on disconnect or session shutdown. This is not bandwidth throttling.                  |
| Manifest freeze      | Holds live HLS timelines/child playlists or the latest observed DASH MPD. Unfreezing resumes current live time.                          |
| HLS key HTTP failure | HTTP 403 on a remote HLS key request.                                                                                                    |
| HLS key mismatch     | A mismatching 16-byte HLS key response. Requires actual encrypted origin content.                                                        |

Segment and key fault modes are `off`, `once`, `always` and `random`. Freeze accepts
only `off` and `always`; other values return HTTP 400. DASH freeze identifies a
stream by its path, so changing cache-busting or time query parameters does not
bypass it. Both proxies limit cached manifests to 128; requesting a new stream
beyond the frozen snapshot limit returns HTTP 503 until unfreezing.

A one-shot fault consumes one matching GET request across resources; HEAD requests
and requests cancelled during artificial latency do not consume it. Quick Inject
rearms the selected fault on each call. Resetting to `off` then `once` also works,
even when another process observes only the final configuration file. Generated
`_oneShot` identifiers make these arm changes durable; preserve them during unrelated
manual edits. These are arm identifiers, not an event queue: multiple injections
before consumption coalesce into the latest arm. Random uses 40 percent per matching request and is
not yet seeded. There is no DRM license simulator; key controls do not affect DASH
or the clear samples. The profile field is a session label, not a stored scenario.

The JSON configuration is validated, saved atomically and watched through directory
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

Players buffer ahead. A queued fault takes effect when the matching resource is
requested, not when previously buffered media plays. Freeze can expose this delay
as the player drains its buffer. Recorded consumption/application/cancellation
events show what the simulator did. Deterministic status rules and HTTP retry
assertions are available through [scenario rules](scenarios.md). The first
video-404/retry preset has a browser check; broader recovery and physical Roku
coverage remain release work.
