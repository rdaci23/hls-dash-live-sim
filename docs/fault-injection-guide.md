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

| Control | Supported effect |
| --- | --- |
| Segment missing | HTTP 404 before fetching or serving media. |
| Segment forbidden | HTTP 403 before fetching or serving media. |
| Malformed segment | Truncated media bytes in a completed HTTP response with accurate length. |
| Latency | Fixed response delay from 0 to 60000 ms; this is not bandwidth throttling. |
| Manifest freeze | Holds live HLS timelines/child playlists or the latest observed DASH MPD. Unfreezing resumes current live time. |
| HLS key HTTP failure | HTTP 403 on a remote HLS key request. |
| HLS key mismatch | A mismatching 16-byte HLS key response. Requires actual encrypted origin content. |

Fault modes are `off`, `once`, `always` and `random`. A one-shot fault consumes one
matching GET request across resources; HEAD requests do not consume it. Reset to
`off` before queuing it again. Random uses 40 percent per matching request and is
not yet seeded. There is no DRM license simulator; key controls do not affect DASH
or the clear samples. The profile field is a session label, not a stored scenario.

The JSON configuration is validated, saved atomically and watched through directory
changes. Invalid edits keep the last valid config. Unknown fields and negative or
excessive latency return HTTP 400; failed writes are reported rather than acknowledged
as saved. Example configuration is in [examples/faults.json](../examples/faults.json).

The API exposes `GET /config`, `POST /config`, `POST /inject`, `POST /reset` and
`POST /profile`. Cross-origin control requests are rejected. A LAN control server
requires a bearer token of at least 16 characters, configured with
`HLS_DASH_CONTROL_TOKEN` or `--control-token`; enter the same token in the panel.
Tokens are not embedded in the page. Use a separate fault-config path for each
independent simulator process.

Players buffer ahead. A queued fault takes effect when the matching resource is
requested, not when previously buffered media plays. Freeze can expose this delay
as the player drains its buffer. Deterministic timed rules, consumption events and
player recovery assertions are the next roadmap milestone.
