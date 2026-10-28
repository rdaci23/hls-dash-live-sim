# hls-dash-live-sim

A private HLS and DASH test tool with local sample streams, origin proxying and
live fault controls. Recovered from `original tools project` and now using corrected live
streaming paths. [Implementation and validation](docs/implementation.md) records
what works and what remains on the roadmap. The repository and npm package remain
private.

## Start a live stream

Node.js 20.3 or newer is required. HLS runs directly in Node. DASH requires a
running Docker daemon; its first start downloads the pinned livesim2 v1.7.0 image.

```sh
npm ci
npm run build
npm run hls
```

The HLS player URL is `http://127.0.0.1:8899/proxy.m3u8`. The procedural sample has
180p and 360p H.264/AAC renditions, two-second segments and a sliding live window.
Audio and video are multiplexed together. Sequence numbers advance; each loop has
an explicit discontinuity. Removed segments remain available for a retention grace
period (14 seconds after removal with the default window), then return 410. Future
segments return 404. Publication uses a monotonic clock, so system clock corrections
cannot move the window backwards.

```sh
npm run dash
```

DASH prints its actual live MPD URL when the engine is ready. The bundled DASH
fixture has separate H.264 video and AAC audio; livesim2 advances their timelines.
Ctrl+C stops the session, proxy and its owned container, including during startup.
An in-progress Docker creation is allowed to finish acknowledging its container
before cleanup; cancellation can wait for that Docker operation. `--detach` is a legacy
flag: the Node session always remains supervised in the foreground.

## Network access

All servers bind to `127.0.0.1` by default. Port conflicts fail without stopping
another process. Explicitly enable device access when needed:

```sh
npm start -- livesim --sim-type hls --host 0.0.0.0
```

Use this computer's LAN address in the printed player URL on a device. Browser
players must be hosted on localhost or this computer's network addresses; requests
from unrelated website origins are rejected. Native players do not need a browser
Origin header. Physical device validation is still pending.

## Fault controls

In another terminal, from the same directory:

```sh
npm run fault-control
```

Visit `http://127.0.0.1:19090`. Segment 403/404, malformed media, response delay and
manifest freeze apply live. Freeze includes HLS child playlists and captures the
latest DASH MPD per stream path, including requests with cache-busting queries.
Freeze supports `off` and `always`. Malformed-media responses complete with an
accurate Content-Length; ranged responses corrupt bytes without changing their
range length. Delayed requests are cancelled when the client disconnects or the
session closes.

Both processes must share `--fault-config /absolute/path/faults.json` when started
from different directories. Invalid settings fail validation. Atomic saves are
watched; malformed edits retain the last valid configuration. `once` consumes one
matching GET request across resources. Quick Inject always rearms it; resetting to
`off` then setting `once` also rearms it, even with back-to-back API calls. Partial
saves merge the latest valid file under a writer lock; simultaneous API writers
receive HTTP 409 and can retry. Manual editors do not participate in that lock.
Preserve the generated `_oneShot` identifiers when editing unrelated settings. Random
faults currently use a 40 percent probability per request; seeded scenarios come
in the next roadmap milestone.

For LAN control, supply a token of at least 16 characters using
`HLS_DASH_CONTROL_TOKEN` or `--control-token`, then enter it in the control page:

```sh
npm start -- fault-control --host 0.0.0.0
```

Keep the stream's LAN binding separate from the control server's binding. The
control API rejects cross-origin writes. HLS key-response faults require a remote
AES-encrypted stream; they do not implement commercial DRM or apply to clear
samples or DASH. [Fault details](docs/fault-injection-guide.md).

## Request and fault diagnostics

Record redacted events to a new file:

```sh
mkdir -p output
npm start -- livesim --sim-type hls --diagnostics-file output/requests.jsonl
# Use --sim-type dash for the same tracing on DASH.
```

Responses include session/request IDs and the IDs of selected faults. Quick Inject
returns a one-shot fault ID that matches the affected response and log events.
The log distinguishes selection, consumption, application and cancellation.
URLs, credentials and media/key bodies are omitted; resources have opaque IDs.
Use `--verbose` for structured stderr events, or download recent events from the
stream server's `/diagnostics` endpoint. History retains 2000 events; optional
files stop at 10 MiB with an explicit marker. [Format and limits](docs/diagnostics.md).

## Streaming commands

```sh
# Append-only EVENT playlist or finite VOD sample
npm start -- livesim --sim-type hls --mode event
npm start -- livesim --sim-type hls --mode vod

# Inspect the actual manifest selected by startup
npm start -- livesim --show-manifest

# Proxy the actual HLS origin, including signed child playlists and init resources
npm start -- livesim --manifest-url https://example.com/master.m3u8

# Permit a separate media CDN; source credentials stay on the source origin
npm start -- livesim --manifest-url https://example.com/master.m3u8 --allow-origin https://media.example.com

# DASH live periods every minute (the parameter is periods per hour)
npm start -- livesim --sim-type dash --periods-per-hour 60

# Manage only a container owned by this workspace
npm start -- livesim stop --sim-type dash --name NAME_PRINTED_AT_STARTUP
npm start -- livesim logs --sim-type dash --name NAME_PRINTED_AT_STARTUP

npm run templates
npm start -- mobile-stream
npm start -- create-manifest-template https://example.com/master.m3u8 --name my-source
npm start -- dummy-stream my-source
npm start -- livesim --help
```

HLS source URLs default to real origin proxying. Authentication can be supplied via
`--auth-token`, `--auth-header`, or `--auth-file`; only one method may be selected.
Redirects are checked against allowed origins and never carry source credentials
to a different origin. Source authentication is not stored in generated templates.
Source URLs may themselves contain secrets, so local templates remain ignored.

DASH source import analyzes supported timing metadata and uses validated local
media. It does not replicate arbitrary source encodings. Custom DASH assets require
`--vodroot` with an asset directory containing `manifest.mpd`. The current adapter
checks the livesim2 v1.7 input subset before starting Docker: a static MPD with one
source Period, AdaptationSet SegmentTemplates, plain `$Number$` without a timeline
or `$Time$` with a finite timeline, and local relative media paths. Representation
templates, BaseURL/Location, SegmentList/SegmentBase and formatted identifiers fail
with an actionable error. This structural check does not validate encoded media.

HLS variable substitution (`EXT-X-DEFINE`), LL-HLS parts, blocking reload and delta
updates fail explicitly with HTTP 422. The proxy keeps active child playlists,
keys, initialization resources and segment references reachable. It retains retired
references for a grace period and returns HTTP 503 if its bounded registry cannot
accept another playlist; it never silently evicts URLs still advertised.

Arbitrary MPD substitution, uneven period layouts and the old low-latency preset
fail explicitly. Sports, news, OTT and mobile presets describe their actual sample
renditions/windows; they no longer promise 4K, ads or low latency. Those capabilities
need real fixtures and remain later roadmap work.

## Development and validation

```sh
npm run typecheck
npm test
npm run test:docker
npm run fixtures
```

The regular suite uses local fixtures and does not require Docker. The Docker suite
requires the pinned image locally (`docker pull ghcr.io/dash-industry-forum/livesim2/livesim2:v1.7.0`).
Fixture regeneration requires FFmpeg and replaces only the procedural sample files.
It is not needed to use the tool. [Fixture provenance](assets/README.md).

Local configuration, templates, authentication files, dependencies, build output and
browser artifacts are ignored by Git. The original four saved templates remain in
this checkout's ignored file. The [initial review](docs/public-release-review.md)
and [recorded baseline](docs/research-evidence.json) describe the recovered prototype;
use [current status](docs/implementation.md) for present behavior.
