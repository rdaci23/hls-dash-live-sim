# CLI Session Control and AI Coding Agents

`hls-dash-live-sim` includes a headless CLI session controller (`control`, aliased as `session`) and a bundled [Agent Skill](../assets/skill/SKILL.md) (`skill`) for **Claude Code**, **OpenAI Codex**, and **Google** (**Gemini CLI** and **Antigravity**).

Use these commands to automate player QA from scripts, CI runners or terminal-based coding agents without opening the browser UI on port `19090` or hand-crafting revisioned HTTP requests.

> **Simulator delivery versus player recovery:** A `passed` scenario or `retryVerified=true` rule proves only that the simulator delivered the planned HTTP/transport fault and observed a matching HTTP retry or timeline window. Always verify playback continuation, stalls, decoded A/V, captions and rendition switches in your player's own logs or telemetry. See [session controls](session-controls.md).

## Install the Bundled Skill (Claude, Codex, Google)

After installing `hls-dash-live-sim` (`npm install -g hls-dash-live-sim`, or `npm run build` in a source checkout), install the bundled `SKILL.md` into your player repository so your coding agent discovers the simulator workflow automatically:

```sh
# Install into the current workspace for Claude Code, Codex, or Google (Gemini CLI / Antigravity):
hls-dash-live-sim skill --install claude
hls-dash-live-sim skill --install codex
hls-dash-live-sim skill --install google

# Or install all workspace locations at once:
hls-dash-live-sim skill --install all
```

| Target | Workspace path (`--dir <repo>` or CWD) | Global path (`--global`) |
| --- | --- | --- |
| `claude` (Claude Code) | `.claude/skills/hls-dash-live-sim/SKILL.md` | `~/.claude/skills/hls-dash-live-sim/SKILL.md` |
| `codex` (OpenAI Codex) | `.agents/skills/hls-dash-live-sim/SKILL.md` | `~/.codex/skills/hls-dash-live-sim/SKILL.md` |
| `google` (Gemini CLI & Antigravity) | `.agents/skills/hls-dash-live-sim/SKILL.md` and `.gemini/skills/hls-dash-live-sim/SKILL.md` | `~/.gemini/skills/hls-dash-live-sim/SKILL.md` and `~/.gemini/config/skills/hls-dash-live-sim/SKILL.md` |

- Running `hls-dash-live-sim skill` with no flags prints `SKILL.md` to `stdout` without touching the filesystem.
- Existing files are **never** overwritten unless `--force` is passed.
- If your project keeps short instructions in `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, point the agent at the installed skill or tell it to run `hls-dash-live-sim control --help`.

## Headless Stream Startup (`--session-file`)

When an agent or script starts a background simulator, pass `--session-file <new-path>` alongside an isolated `--fault-config` and an in-memory `HLS_DASH_CONTROL_TOKEN` (at least 16 characters):

```sh
mkdir -p output/qa-run
export HLS_DASH_CONTROL_TOKEN="$(node -p 'require("node:crypto").randomBytes(24).toString("hex")')"

hls-dash-live-sim livesim start --sim-type hls \
  --port 8899 \
  --fault-config output/qa-run/faults.json \
  --session-file output/qa-run/session.json \
  --diagnostics-file output/qa-run/diagnostics.jsonl
```

`--session-file` creates a `0600` JSON file (refusing to overwrite an existing file) containing only non-secret session metadata:

```json
{
  "schemaVersion": 1,
  "sessionId": "00000000-0000-4000-8000-000000000000",
  "protocol": "hls",
  "url": "http://127.0.0.1:8899/proxy.m3u8",
  "origin": "http://127.0.0.1:8899",
  "http2": false,
  "sessionControlsAvailable": true,
  "recordedAt": "2026-11-23T12:00:00.000Z"
}
```

Tokens, origin auth headers and source URLs are never written to `--session-file`. Passing `--session-file` to subsequent `control` commands pins **both** the simulator `origin` and `sessionId`, preventing accidental mutations if the simulator restarted or another stream bound the port.

For Node-only DASH or multi-track audio/WebVTT/wvtt caption tests without Docker, add `--fixture tracks`:

```sh
hls-dash-live-sim livesim start --sim-type dash --fixture tracks \
  --port 8888 \
  --fault-config output/qa-run/dash-faults.json \
  --session-file output/qa-run/dash-session.json
```

## CLI Session-Control Reference (`control` / `session`)

Every `control` command requires an explicit target via `--session-file <path>` or `--url <http(s)://host:port[/manifest]>` (or `HLS_DASH_SIM_URL`). Add `--json` to any subcommand for structured output, and `--ca-cert .certs/ca.pem` (or `HLS_DASH_CA_CERT`) when controlling an `--http2` TLS session.

### Inert Reads (No Token Required)

```sh
# Health, session UUID, revision, control mode and active test summary:
hls-dash-live-sim control status --session-file output/qa-run/session.json --json

# Discover advertised playlists inertly and list compatible scenario presets:
hls-dash-live-sim control catalog --session-file output/qa-run/session.json
hls-dash-live-sim control catalog --session-file output/qa-run/session.json --all --search retry --json

# Fetch an inert baseline manifest preview (does not consume one-shots or seed freezes):
hls-dash-live-sim control manifest --session-file output/qa-run/session.json
hls-dash-live-sim control manifest --session-file output/qa-run/session.json --playlist video:0

# Save bounded redacted diagnostics or session-control evidence to a new file:
hls-dash-live-sim control diagnostics --session-file output/qa-run/session.json --output output/qa-run/recent.jsonl
hls-dash-live-sim control evidence --session-file output/qa-run/session.json --output output/qa-run/evidence.json
```

### Running Deterministic Scenarios

`control run <preset>` switches the session to `scenario` mode, prepares the preset, starts it, and with `--wait` polls until the simulator reaches a terminal outcome (`passed` exits `0`; `failed`, `incomplete` or timeout exits `1`):

```sh
hls-dash-live-sim control run next-video-retry \
  --session-file output/qa-run/session.json \
  --wait --timeout 45000 --json
```

When your test harness needs to prepare a scenario *before* launching the external player and trigger delivery on demand:

```sh
hls-dash-live-sim control mode scenario --session-file output/qa-run/session.json
hls-dash-live-sim control arm next-video-retry --session-file output/qa-run/session.json
# Launch player against the URL in session.json, then start fault delivery:
hls-dash-live-sim control start --session-file output/qa-run/session.json
hls-dash-live-sim control wait --session-file output/qa-run/session.json --timeout 45000 --json
# Or stop early while retaining evidence:
hls-dash-live-sim control stop --session-file output/qa-run/session.json
```

`control wait` also works with automatic startup scenarios (`livesim --scenario examples/scenarios/next-video-retry.json`).

### Manual Faults and Network Shaping

Manual settings and scenarios are exclusive; use `--ensure-mode` (or `control mode manual`) to take manual control:

```sh
# Apply shared bandwidth cap, random jitter, or fixed response latency:
hls-dash-live-sim control apply \
  --session-file output/qa-run/session.json \
  --ensure-mode \
  --bandwidth-kbps 450 \
  --jitter-ms 150 \
  --json

# Apply a portable manual settings export (e.g. examples/session-settings/constrained-network.json):
hls-dash-live-sim control apply \
  --session-file output/qa-run/session.json \
  --ensure-mode \
  --file examples/session-settings/constrained-network.json

# Arm a one-shot fault on the next matching GET:
hls-dash-live-sim control inject segment.missing --session-file output/qa-run/session.json --ensure-mode
hls-dash-live-sim control inject segment.latencySpike --value 2500 --session-file output/qa-run/session.json

# Restore all-off settings and cancel affected manual work for this session:
hls-dash-live-sim control clear --session-file output/qa-run/session.json
```

For strict optimistic concurrency across multi-step scripts, mutations also accept `--revision <n>` and `--run-id <uuid>`.

## Programmatic Node.js API

In addition to the CLI, `hls-dash-live-sim` exports its server runners and `SessionControlClient` from the package root (`dist/index.js` / `dist/index.d.ts`):

```js
const { startHlsim, SessionControlClient } = require("hls-dash-live-sim");
```

Note that `startHlsim()` keeps MPEG-TS as its library default for backward compatibility unless `segmentFormat: "fmp4"` is passed; the CLI `livesim` command defaults to the fMP4 ladder ([generated streams](generated-streams.md)).
