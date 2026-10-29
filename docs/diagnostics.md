# Request and fault diagnostics

Each HLS Node proxy and DASH fault proxy records a bounded event history. Capture
a new session to a JSONL file (one JSON object per line):

```sh
mkdir -p output
npm start -- livesim --sim-type hls --diagnostics-file output/hls-requests.jsonl
# Or:
npm start -- livesim --sim-type dash --diagnostics-file output/dash-requests.jsonl
```

The target must be a new file in an existing directory. Existing files are never
overwritten. Files are created with mode 0600. The option also works with template
commands, for example `mobile-stream --diagnostics-file output/mobile.jsonl`.
`--verbose` emits the same structured events to stderr; a live config update of
`logging.verbose` also enables or disables that output. Recording to a file does
not require verbose output.

While the session runs, download the recent history from the **stream server**:

```sh
curl http://127.0.0.1:8899/diagnostics -o output/recent-hls.jsonl
curl http://127.0.0.1:8888/diagnostics -o output/recent-dash.jsonl
```

Use the configured port if it differs. This endpoint uses the stream server's
existing local-origin checks, including its explicit LAN binding. It is separate
from the control UI on port 19090. Diagnostics require the Node/fault proxy and
cannot be enabled for HLS Docker MP4 VoD or DASH `--no-fault-proxy` mode.

## Correlating a fault

Every handled stream-server HTTP response includes `X-Sim-Session-Id` and `X-Sim-Request-Id`.
An affected response also includes `X-Sim-Fault-Ids`, containing the fault IDs
selected for that request. These headers are exposed to allowed browser players
through CORS. Client-supplied trace IDs are ignored.

One-shot `POST /inject` responses return a `faultId`, also displayed by Quick
Inject. That ID matches the affected response and diagnostic events, even when
the control UI and stream server are separate processes. Rearming generates a
different ID. Always/random faults, delay and freeze use activation IDs local to
the simulator session. Generated one-shot arm UUIDs support cross-process IDs;
legacy/custom arm labels instead receive an ID local to the simulator.
Shared config files use directory events with a 250 ms polling fallback, so a
missed filesystem notification does not leave the simulator on an old fault setting.

Use `requestId` to group events for a request and `faultId` to group requests
affected by the same activation. A one-shot missing segment normally produces:

```text
request.started
request.resource
fault.selected       segment.missing, once, faultId
fault.consumed       same faultId
fault.applied        same faultId
request.completed    status 404
```

These IDs identify observations and activations. With an active [scenario](scenarios.md),
recognized media also carries logical `trackId`, `segmentId`, `segmentOrdinal` and
`attempt` fields. Scenario selection/results add a `ruleId` and definition
fingerprint (`scenarioId`). `scenario.attempt`, `scenario.matched` and
`scenario.result` events connect that identity with the HTTP outcome.

[Network timelines](network-scenarios.md) add `scenario.profile` at phase
boundaries and `phaseId` on their fault events. Profile events report the effective
bandwidth, jitter and boolean freeze setting. The healthy profile outside a phase
has zero bandwidth/jitter, freeze false and no phase ID. Selected effects retain
the phase observed at selection even if the response crosses a boundary. Combine
profile events with request intervals to see rate changes affecting active bodies;
a response's initial bandwidth selection is not a promise of one rate throughout
its transfer. Timeline reports require successful in-window effect evidence and
keep cancellation separate from completion.

## Event meanings

| Event                                | Meaning                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.started` / `session.closed` | Proxy diagnostic recording opened / shut down after pending handlers drained. These do not cover Docker startup or manifest preflight.                                                                             |
| `request.started`                    | The proxy accepted an HTTP request and generated its ID.                                                                                                                                                           |
| `request.resource`                   | The proxy classified the target as manifest, segment, key or other, with an opaque resource ID and source kind.                                                                                                    |
| `origin.completed`                   | The full upstream response was buffered, with its status and body size.                                                                                                                                            |
| `fault.selected`                     | A fault matched the request. This alone does not prove an effect was applied.                                                                                                                                      |
| `fault.consumed`                     | A one-shot was consumed at selection. HEAD segment/key requests do not consume one-shots.                                                                                                                          |
| `fault.applied`                      | A fault response finished writing, or an artificial delay completed. The `action` distinguishes a response override, body/range corruption, delay, manifest capture or manifest hold.                              |
| `fault.cancelled`                    | A selected effect did not finish. For example, the client disconnected during artificial latency.                                                                                                                  |
| `request.completed`                  | The response finished writing locally; status, response body size and elapsed time are recorded. This is not a playback/recovery assertion or proof the client consumed the body. HEAD response body size is zero. |
| `request.cancelled`                  | The client disconnected or the session shut down before the response finished. A status is present only if headers had already been sent. No synthetic HTTP 499 is sent.                                           |
| `request.error`                      | A safe reason code identifies a rejected resource or failed origin request. Raw exception messages are omitted.                                                                                                    |

Cancellation during artificial delay leaves later one-shot faults unconsumed.
If a one-shot was already selected before a later cancellation, consumption remains
recorded; the cancellation does not rearm it. A completed delay can coexist with a
later cancelled request. Freeze records `capture_manifest` when a first snapshot
is captured and `hold_manifest` when an existing snapshot is returned. A static
generated HLS master is not reported as frozen merely because freeze is enabled.

Each event has `schemaVersion: 1`, `sessionId`, a session-local increasing `eventId`,
`protocol`, a UTC `timestamp` and monotonic `elapsedMs`. Request/fault metadata is
included only where applicable. Event IDs show ordering within one process; wall
timestamps do not establish ordering between processes.

## Redaction and limits

Exports and verbose diagnostic events omit URLs entirely, including hosts, paths,
queries and fragments. Authorization headers, cookies, media/key bodies, profile
labels, config paths and raw exception messages are omitted. A per-session keyed
hash identifies resources: the same target gets the same ID within a session,
and different sessions use different resource IDs. A changed signed URL gets a
different ID. Scenario logical segment IDs separately normalize the supported
track/template/sequence identity, including cache queries on local DASH media. Responses
and the normal `--show-manifest`/template/Docker console output are outside the
diagnostic export format.

The proxy keeps the latest **2000 events**. HTTP exports begin with a
`diagnostics.snapshot` metadata line containing `eventsRecorded`, `droppedEvents`,
`fileEnabled`, `fileLimitReached` and `fileWriteFailed`, followed by the retained
events in order. The export is a point-in-time snapshot: its own request and other
active requests may not yet have a terminal event.

Optional JSONL files stop at **10 MiB**, with room reserved for a
`diagnostics.file_limit` marker. They do not rotate or grow indefinitely. After
the limit, streaming and recent-history recording continue. A file write failure
also leaves streaming active and emits `diagnostics.file_error` to recent history
and a generic console message; a partial final line is rolled back when possible.
Neither an HTTP export with dropped events nor a capped/failed file is a complete
session trace. Start another session with a new file for a fresh full capture.

Embedded callers can inspect `session.diagnostics.snapshot()` or
`session.diagnostics.exportJsonl()`, including after `await session.close()`.
The standalone `SessionDiagnostics` class also accepts bounded `maxEvents` and
`maxFileBytes` options. It records no data outside this process or chosen local file.
File capture uses synchronous local writes; slow storage and verbose console
output can add timing overhead. Diagnostic duration measures the server's observed
request lifetime, rather than an isolated network-latency measurement.

## Network shaping events

`response.jitter` records configured `jitterMs` and the actual sampled extra
`delayMs`, with action `delay`. Fixed `response.latency` remains a separate effect.
Their combined wait is cancellable; `fault.applied` means that wait completed.

`response.bandwidth` uses action `throttle` and records the configured
`bandwidthKbps` when the response starts shaping. The shared session ceiling can
change during transfer; that initial field is not a measurement of average wire
throughput. Application is recorded on completed responses. Disconnect/shutdown
records cancellation instead, even if some bytes have already been sent. There
are no per-chunk diagnostic events. Existing byte limits/redaction remain in force.
