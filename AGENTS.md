# Repository Agent Guidelines (`hls-dash-live-sim`)

Canonical instructions for coding agents (**OpenAI Codex**, **Claude Code**, **Google Gemini CLI**, **Google Antigravity**, and peers) working inside the `hls-dash-live-sim` repository.

If you are using an AI agent in an **external player repository** to test playback against `hls-dash-live-sim`, read [docs/ai-agents.md](docs/ai-agents.md) and [assets/skill/SKILL.md](assets/skill/SKILL.md) (`hls-dash-live-sim skill`) instead.

## 1. Non-Negotiable Repository Guardrails

1. **GitHub Actions stays disabled (local-only verification):**
   - Do **not** re-enable GitHub Actions, add hosted workflow dispatches, or run `gh workflow run` without explicit maintainer approval ([docs/development.md](docs/development.md#github-actions), [CONTRIBUTING.md](CONTRIBUTING.md)).
   - Run all verification locally and report any skipped integration checks honestly.
2. **Simulator HTTP delivery != player recovery:**
   - Never label HTTP fault delivery or a simulator retry assertion (`passed` / `retryVerified`) as proof that a player recovered visually or audibly. Keep HTTP boundary results and rendered player compatibility observations strictly separate ([docs/implementation.md](docs/implementation.md), [docs/device-fault-matrix.md](docs/device-fault-matrix.md)).
   - Never hide, swallow or filter real player exceptions to make a check pass.
3. **Process, port and container safety:**
   - Bind to `127.0.0.1` by default. Never kill unrelated processes or stop unowned Docker containers to resolve a port collision; use ephemeral/isolated ports in tests (`test/helpers/free-port.cjs`).
   - Preserve `SIGINT` / `SIGTERM` / `SIGHUP` supervision and container ownership labels (`src/support-tools/container-ownership.ts`).
4. **Credentials, diagnostics and redaction:**
   - Never log, export or commit control tokens, `Authorization` headers, cookies, signed origin URLs, `auth*.json`, `.certs/` keys, or raw exception messages in diagnostics ([docs/diagnostics.md](docs/diagnostics.md)).
   - Existing files passed to `--diagnostics-file`, `--session-file`, or CLI `--output` must never be silently overwritten (`wx`, mode `0600`).
5. **Dependencies and third-party notices:**
   - Runtime dependencies are intentionally minimal (`express`, `fast-xml-parser`, `yargs` on Node `>=22`). Avoid adding new dependencies unless explicitly requested; any lockfile change requires `npm run notices:generate` and maintainer license review ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## 2. Codebase Map

- `src/cli.ts` — CLI entrypoint (`livesim`, `control` / `session`, `skill`, `fault-control`, `certs`, templates).
- `src/index.ts` — Programmatic CommonJS/TypeScript package entrypoint (`dist/index.js`).
- `src/support-tools/hls-sim-runner.ts` & `cmaf-hls.ts` & `live-hls.ts` — Generated HLS (fMP4 ladder default in CLI; MPEG-TS option; LL-HLS parts/preload/delta) and HLS origin proxy.
- `src/support-tools/dash-sim-runner.ts` & `dash-fault-proxy.ts` — Pinned `livesim2` Docker runner and Node DASH fault/scenario proxy.
- `src/support-tools/track-fixture.ts` & `track-fixture-session.ts` — Node-only `--fixture tracks` publisher (HLS/DASH fMP4, alternate audio, WebVTT/wvtt captions, local AES/token/UTC services, lifecycle transitions).
- `src/support-tools/session-controls.ts` & `scenario-runs.ts` & `scenario.ts` — Revisioned `/session-control` API, preset catalog, deterministic rules, and timelines.
- `src/support-tools/control-client.ts` & `agent-skill.ts` — Headless CLI/programmatic session-control client, `--session-file` I/O, and `SKILL.md` installer.
- `assets/fault-control/` — Browser control UI (`control.js`, `index.html`, `legacy-control.js`).
- `assets/skill/SKILL.md` — Self-contained skill distributed in the npm package (avoid relative repo Markdown links inside `assets/skill/SKILL.md` because `scripts/copyStaticAssets.js` copies `assets/` into `dist/support-tools/assets/`).

## 3. Packaging & Documentation Rules

- `package.json` `"files"` controls the published npm archive. `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `android/`, `roku/`, `scripts/`, `test/`, and `.github/` are **repo-only** (not in `"files"`).
- **Important:** `scripts/verify-package.cjs` verifies that **every Markdown link inside packaged `.md` files** (`README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, `docs/**`, `assets/**`) resolves to another file **inside `"files"`**. In packaged docs, reference repo-only paths using inline code (for example `` `AGENTS.md` `` or `` `android/README.md` ``), never as `[link](AGENTS.md)`.
- When `src/` changes since the latest `v*` tag, update `## Unreleased` in [CHANGELOG.md](CHANGELOG.md) so `npm run changelog:check` passes.

## 4. Required Local Verification Before Finishing Changes

Run these fast local checks on every code or documentation change:

```sh
npm run build
npm run typecheck
npm run docs:check
npm run notices:check
npm run changelog:check
npm test
```

Run targeted integration suites when touching their area (see [docs/development.md](docs/development.md) for the full table):
- Control UI / session-control changes: `npm run test:ui` (needs local Google Chrome).
- Packaging / CLI / docs link changes: `npm run test:package` (when npm cache/registry is reachable).
- DASH Docker adapter changes: `npm run test:docker` (needs Docker + pinned `livesim2` image).
- Roku BrighterScript changes: `npm run roku:build`.
