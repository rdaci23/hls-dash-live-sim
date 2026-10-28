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
an explicit discontinuity. Old segments return 410 and future segments return 404.

```sh
npm run dash
```

DASH prints its actual live MPD URL when the engine is ready. The bundled DASH
fixture has separate H.264 video and AAC audio; livesim2 advances their timelines.
Ctrl+C stops the session, proxy and its owned container. `--detach` is a legacy
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
latest DASH MPD. Malformed-media responses complete with an accurate Content-Length;
they are distinct from a network timeout.

Both processes must share `--fault-config /absolute/path/faults.json` when started
from different directories. Invalid settings fail validation. Atomic saves are
watched; malformed edits retain the last valid configuration. `once` consumes one
matching request across resources and is rearmed by resetting the mode. Random
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
supports the livesim2 v1.7 input subset: AdaptationSet SegmentTemplates and
unformatted `$Number$` or supported `$Time$` addressing.

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
