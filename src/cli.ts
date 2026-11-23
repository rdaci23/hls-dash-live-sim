#!/usr/bin/env node
import { startTrackFixture } from "./support-tools/track-fixture-session.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { portNumber, bindHost, loadHttp2Tls } from "./support-tools/safe-http.js";
import { createLocalCerts, describeLocalCerts } from "./support-tools/local-certs.js";
import {
  startHlsim,
  stopHlsim,
  logsHlsim,
} from "./support-tools/hls-sim-runner.js";
import {
  startLivesim2,
  stopLivesim2,
  logsLivesim2,
} from "./support-tools/dash-sim-runner.js";
import {
  getTemplate,
  listTemplates,
  createTemplateFromUrl,
  saveTemplate,
} from "./support-tools/stream-templates.js";
import {
  SessionControlClient,
  validateSessionFileTarget,
  writeSessionFile,
  writeExclusiveOutputFile,
  parseSettingsFile,
  formatControlStatus,
  formatControlMutation,
  type ManualFlagsPatch,
  type MutationPinOptions,
} from "./support-tools/control-client.js";
import {
  readBundledSkill,
  installAgentSkill,
  type AgentSkillTarget,
} from "./support-tools/agent-skill.js";
import type { FaultMode } from "./support-tools/live-stream-fault-config.js";

function packageVersion(): string {
  return JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version;
}

async function starting<T extends { close(): Promise<void> }>(
  start: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => {
    process.exitCode = 130;
    controller.abort(new Error("Startup cancelled by SIGINT"));
  };
  const terminate = () => {
    process.exitCode = 143;
    controller.abort(new Error("Startup cancelled by SIGTERM"));
  };
  const hangup = () => {
    process.exitCode = 129;
    controller.abort(new Error("Startup cancelled by SIGHUP"));
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.on("SIGHUP", hangup);
  let session: T | undefined;
  try {
    session = await start(controller.signal);
    controller.signal.throwIfAborted();
    return session;
  } catch (error) {
    await session?.close();
    throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGHUP", hangup);
  }
}

function recordSessionMetadata(
  session: { url: string; diagnostics?: { sessionId: string } },
  protocol: "hls" | "dash",
  args: any,
): void {
  if (!args["session-file"]) return;
  if (!session.diagnostics?.sessionId) {
    throw new Error("--session-file requires an active diagnostic proxy session");
  }
  const token = args["control-token"] ?? process.env.HLS_DASH_CONTROL_TOKEN ?? "";
  const externallyManaged = Boolean(args.scenario && args["scenario-start"] !== "manual");
  writeSessionFile(args["session-file"], {
    sessionId: session.diagnostics.sessionId,
    protocol,
    url: session.url,
    sessionControlsAvailable: !externallyManaged && token.length >= 16,
  });
}

async function supervise(
  session: { url: string; diagnostics?: { sessionId: string }; close(): Promise<void> },
  show: boolean,
  protocol: "hls" | "dash",
  args: any,
) {
  try {
    recordSessionMetadata(session, protocol, args);
  } catch (error) {
    await session.close();
    throw error;
  }
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await session.close();
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  };
  // Stay subscribed: a repeated Ctrl+C or a closed terminal must not kill the
  // process before its owned container has been removed.
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, shutdown);
  if (show) {
    try {
      const response = await fetch(session.url, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok)
        throw new Error(`Manifest request failed: ${response.status}`);
      console.info(await response.text());
    } catch (error) {
      for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(name, shutdown);
      await session.close();
      throw error;
    }
  }
}
const authOptions = (builder) =>
  builder
    .option("auth-token", {
      type: "string",
      description: "Bearer token scoped to the source origin",
    })
    .option("auth-header", {
      type: "string",
      description: "One source authentication header",
    })
    .option("auth-file", {
      type: "string",
      description: "JSON file containing source authentication headers",
    })
    .option("allow-origin", {
      type: "array",
      string: true,
      description:
        "Additional permitted resource origin; source credentials are never sent there",
    });
const auth = (args) => ({
  authToken: args["auth-token"],
  authHeader: args["auth-header"],
  authFile: args["auth-file"],
  allowedOrigins: args["allow-origin"],
});
/** Opt-in HTTP/2 over TLS for player requests. Apple players use low-latency
 * HLS only over HTTP/2, and only over TLS; HTTP/1.1 remains on the same port. */
const http2Option = (args) => {
  if (!args.http2) {
    if (args["tls-cert"] || args["tls-key"]) throw new Error("--tls-cert and --tls-key are used with --http2");
    return undefined;
  }
  return loadHttp2Tls(args["tls-cert"], args["tls-key"]);
};
const startOptions = (builder) =>
  authOptions(builder)
    .option("http2", { type: "boolean", description: "Serve players over HTTP/2 with TLS (off by default); HTTP/1.1 stays available on the same port. Needed for Safari and AVPlayer low-latency HLS" })
    .option("tls-cert", { type: "string", description: "PEM certificate chain for --http2, e.g. from npm run certs:local" })
    .option("tls-key", { type: "string", description: "PEM private key for --tls-cert" })
    .option("port", {
      type: "number",
      description: "Listen port (HLS 8899, DASH 8888)",
    })
    .option("host", {
      type: "string",
      default: "127.0.0.1",
      description: "Use 0.0.0.0 explicitly for LAN streaming",
    })
    .option("scenario", {
      alias: "scenario-file",
      type: "string",
      description:
        "Run immutable resource fault rules and network timelines from a scenario JSON file",
    })
    .option("scenario-start", { choices: ["auto", "manual"], default: "auto", description: "Auto-start a definition, or expose authenticated manual scenario controls" })
    .option("control-token", { type: "string", description: "Simulator session control token (or HLS_DASH_CONTROL_TOKEN); at least 16 characters for writes" })
    .option("session-file", {
      type: "string",
      description: "Write redacted session metadata (URL, protocol, sessionId; no secrets) to a new JSON file",
    })
    .option("diagnostics-rotate-files",{type:"number",description:"Opt-in append-only diagnostic rotation, 2–256 files, 10 MiB each; no eviction"})
    .option("diagnostics-file", {
      type: "string",
      description:
        "Write redacted JSONL diagnostics to a new file (10 MiB limit)",
    })
    .option("verbose", {
      type: "boolean",
      description: "Emit redacted request/fault diagnostic events to stderr",
    })
    .option("allow-host", { type: "array", string: true, description: "Extra Host name a player may use for this stream, e.g. 10.0.2.2 (Android emulator) or my-mac.local" })
    .option("allow-player-origin", { type: "array", string: true, description: "Extra browser origin allowed to load this stream, e.g. https://hlsjs.video-dev.org, or null for file:// pages" })
    .option("showManifest", {
      alias: "show-manifest",
      type: "boolean",
      default: false,
    });

const controlTargetOptions = (builder) =>
  builder
    .option("url", {
      type: "string",
      description: "Target simulator origin or manifest URL (or env HLS_DASH_SIM_URL)",
    })
    .option("session-file", {
      type: "string",
      description: "Session metadata file written by livesim --session-file",
    })
    .option("session-id", {
      type: "string",
      description: "Pin expected simulator session UUID",
    })
    .option("control-token", {
      type: "string",
      description: "Simulator session control token (or env HLS_DASH_CONTROL_TOKEN)",
    })
    .option("ca-cert", {
      type: "string",
      description: "CA certificate PEM for --http2 TLS sessions (or env HLS_DASH_CA_CERT)",
    })
    .option("timeout", {
      type: "number",
      description: "Request or wait timeout in milliseconds",
    })
    .option("json", {
      type: "boolean",
      default: false,
      description: "Emit structured JSON to stdout",
    });

const controlMutationOptions = (builder) =>
  controlTargetOptions(builder)
    .option("revision", {
      type: "number",
      description: "Pin expected session-control revision",
    })
    .option("run-id", {
      type: "string",
      description: "Pin expected scenario run UUID",
    });

function buildControlClient(args: any, defaultTimeoutMs?: number): SessionControlClient {
  if (args.timeout !== undefined && (!Number.isInteger(args.timeout) || Number(args.timeout) < 100)) {
    throw new Error("--timeout must be an integer of at least 100 milliseconds");
  }
  return new SessionControlClient({
    url: args.url,
    sessionFile: args["session-file"],
    sessionId: args["session-id"],
    token: args["control-token"],
    caCert: args["ca-cert"],
    timeoutMs: args.timeout ?? defaultTimeoutMs,
  });
}

function pinFromArgs(args: any): MutationPinOptions {
  if (args.revision !== undefined && (!Number.isSafeInteger(args.revision) || Number(args.revision) < 0)) {
    throw new Error("--revision must be a non-negative integer");
  }
  return {
    ...(args.revision !== undefined ? { revision: Number(args.revision) } : {}),
    ...(args["run-id"] !== undefined ? { runId: String(args["run-id"]) } : {}),
  };
}

/** Generated HLS defaults to the fMP4 ladder. The MPEG-TS sample is kept for
 * the options only it supports: rendition selection and ad breaks. */
function generatedHlsFormat(explicit: "ts" | "fmp4" | undefined, adBreakSegments?: number, rendition?: string, lowLatency?: boolean): "ts" | "fmp4" {
  return explicit ?? (!lowLatency && (adBreakSegments !== undefined || rendition && rendition !== "all") ? "ts" : "fmp4");
}

async function runTemplate(name: string, args) {
  const template = getTemplate(name);
  if (!template)
    throw new Error("Unknown template; run list-manifest-templates");
  if (template.supported === false)
    throw new Error(
      "This template requires true low-latency media and transport, which are not supported yet",
    );
  if (args["session-file"]) validateSessionFileTarget(args["session-file"]);
  const type =
    args["sim-type"] ??
    template.protocol ??
    (template.sourceUrl &&
    new URL(template.sourceUrl).pathname.toLowerCase().endsWith(".mpd")
      ? "dash"
      : "hls");
  if (type === "dash") {
    await supervise(
      await starting((signal) =>
        startLivesim2({
          signal,
          diagnosticsFile: args["diagnostics-file"],diagnosticsRotateFiles:args["diagnostics-rotate-files"],
          scenarioFile: args.scenario,
        scenarioStart: args["scenario-start"],
        controlToken: args["control-token"],
          verbose: args.verbose,
          port: args.port,
          host: args.host,
          allowedHosts: args["allow-host"], allowedPlayerOrigins: args["allow-player-origin"], redundantStreams: args["redundant-streams"],
          asset: template.isDynamic ? undefined : template.asset,
          lowLatency: template.lowLatency,
          manifestUrl: template.sourceUrl,
          http2: http2Option(args),
          ...auth(args),
        }),
      ),
      args.showManifest,
      "dash",
      args,
    );
  } else {
    await supervise(
      await starting((signal) =>
        startHlsim({
          signal,
          diagnosticsFile: args["diagnostics-file"],diagnosticsRotateFiles:args["diagnostics-rotate-files"],
          scenarioFile: args.scenario,
        scenarioStart: args["scenario-start"],
        controlToken: args["control-token"],
          verbose: args.verbose,
          port: args.port,
          host: args.host,
          allowedHosts: args["allow-host"], allowedPlayerOrigins: args["allow-player-origin"], redundantStreams: args["redundant-streams"],
          mode: args.mode,
          windowSegments: template.windowSegments,
          rendition: template.rendition,
          segmentFormat: template.sourceUrl ? template.segmentFormat : generatedHlsFormat(template.segmentFormat, undefined, template.rendition, template.lowLatency),
          lowLatency: template.lowLatency,
          manifestUrl: template.sourceUrl,
          dummyContent: template.sourceUrl ? false : true,
          http2: http2Option(args),
          ...auth(args),
        }),
      ),
      args.showManifest,
      "hls",
      args,
    );
  }
}

const program = yargs(hideBin(process.argv))
  .fail((message, error) => {
    throw error ?? new Error(`${message}\nRun with --help to list commands and options.`);
  })
  .scriptName("hls-dash-live-sim")
  .usage("$0 <command> [options]")
  .version(packageVersion())
  .parserConfiguration({ "populate--": true })
  .command(
    "fault-control",
    "Start the fault control web UI",
    (builder) =>
      builder
        .option("port", { type: "number", default: 19090 })
        .option("host", { type: "string", default: "127.0.0.1" })
        .option("fault-config", { type: "string" })
        .option("fault-profile", { type: "string" })
        .option("control-token", {
          type: "string",
          description: "Required for LAN control (env HLS_DASH_CONTROL_TOKEN)",
        }),
    async (args: any) => {
      const { startFaultServer } =
        await import("./support-tools/live-stream-fault-server.js");
      await startFaultServer({
        port: args.port,
        host: args.host,
        configPath: args["fault-config"],
        profile: args["fault-profile"],
        controlToken: args["control-token"],
      });
    },
  )
  .command(
    ["control", "session"],
    "Inspect or control a running simulator session from the CLI",
    (sub) =>
      sub
        .command(
          "status",
          "Read simulator health, control mode, revision and current test state",
          controlTargetOptions,
          async (args: any) => {
            const client = buildControlClient(args);
            const snapshot = await client.status();
            console.info(args.json ? JSON.stringify(snapshot, null, 2) : formatControlStatus(snapshot));
          },
        )
        .command(
          "catalog",
          "List scenario presets compatible with the connected stream",
          (b) =>
            controlTargetOptions(b)
              .option("discover", {
                type: "boolean",
                default: true,
                description: "Perform inert baseline playlist discovery first",
              })
              .option("all", {
                type: "boolean",
                default: false,
                description: "Include unavailable presets and their prerequisite reasons",
              })
              .option("search", {
                type: "string",
                description: "Filter presets by ID, name or expected effect",
              }),
          async (args: any) => {
            const client = buildControlClient(args);
            const data = await client.catalog({ discover: args.discover });
            const query = args.search ? String(args.search).trim().toLowerCase() : "";
            const presets = (data.presets ?? []).filter(
              (p: any) =>
                (args.all || p.enabled) &&
                (!query || `${p.id} ${p.name} ${p.expectedEffect ?? ""}`.toLowerCase().includes(query)),
            );
            if (args.json) {
              console.info(JSON.stringify({ ...data, presets }, null, 2));
              return;
            }
            console.info(
              `${presets.length} shown (${(data.presets ?? []).filter((p: any) => p.enabled).length} compatible with ${data.manifestUrl})`,
            );
            for (const preset of presets) {
              console.info(
                `- ${preset.id}${preset.enabled ? "" : " [unavailable]"}: ${preset.name}\n  ${
                  preset.enabled ? preset.expectedEffect ?? "" : preset.reason ?? "Unavailable for this stream"
                }`,
              );
            }
          },
        )
        .command(
          "manifest",
          "Fetch an inert baseline manifest preview without consuming faults",
          (b) =>
            controlTargetOptions(b)
              .option("playlist", {
                type: "string",
                description: "Playlist selector (root, video:0, audio:0, text:0, or advertised URI)",
              })
              .option("output", {
                type: "string",
                description: "Save raw manifest text to a new file",
              }),
          async (args: any) => {
            const client = buildControlClient(args);
            const result = await client.manifest({ playlist: args.playlist });
            if (args.output) {
              const saved = writeExclusiveOutputFile(args.output, result.text);
              if (args.json) {
                console.info(JSON.stringify({ ...result, savedTo: saved }, null, 2));
              } else {
                console.info(`Baseline manifest preview (${result.url}) saved to ${saved}`);
              }
              return;
            }
            if (args.json) {
              console.info(JSON.stringify(result, null, 2));
            } else {
              process.stdout.write(result.text.endsWith("\n") ? result.text : result.text + "\n");
            }
          },
        )
        .command(
          "diagnostics",
          "Export recent redacted diagnostic JSONL events from the simulator",
          (b) =>
            controlTargetOptions(b).option("output", {
              type: "string",
              description: "Save JSONL diagnostics to a new file",
            }),
          async (args: any) => {
            const client = buildControlClient(args);
            const result = await client.diagnostics();
            if (args.output) {
              const saved = writeExclusiveOutputFile(args.output, result.jsonl);
              if (args.json) {
                console.info(JSON.stringify({ sessionId: result.sessionId, protocol: result.protocol, savedTo: saved }, null, 2));
              } else {
                console.info(`Diagnostics for session ${result.sessionId} saved to ${saved}`);
              }
              return;
            }
            if (args.json) {
              const lines = result.jsonl
                .split(/\r?\n/)
                .filter(Boolean)
                .map(line => JSON.parse(line));
              console.info(JSON.stringify({ sessionId: result.sessionId, protocol: result.protocol, events: lines }, null, 2));
            } else {
              process.stdout.write(result.jsonl.endsWith("\n") ? result.jsonl : result.jsonl + "\n");
            }
          },
        )
        .command(
          "evidence",
          "Export session-control test results and bounded redacted diagnostics",
          (b) =>
            controlTargetOptions(b).option("output", {
              type: "string",
              description: "Save session evidence JSON to a new file",
            }),
          async (args: any) => {
            const client = buildControlClient(args);
            const evidence = await client.evidence();
            const serialized = JSON.stringify(evidence, null, 2) + "\n";
            if (args.output) {
              const saved = writeExclusiveOutputFile(args.output, serialized);
              if (args.json) {
                console.info(JSON.stringify({ sessionId: evidence.sessionId, revision: evidence.revision, savedTo: saved }, null, 2));
              } else {
                console.info(`Session evidence saved to ${saved} (check playback recovery separately in your player)`);
              }
              return;
            }
            process.stdout.write(serialized);
          },
        )
        .command(
          "mode <mode>",
          "Take scoped session control and switch between manual and scenario modes",
          (b) =>
            controlMutationOptions(b).positional("mode", {
              choices: ["manual", "scenario"] as const,
              demandOption: true,
            }),
          async (args: any) => {
            const client = buildControlClient(args);
            const updated = await client.setMode(args.mode, pinFromArgs(args));
            console.info(args.json ? JSON.stringify(updated, null, 2) : formatControlMutation("Mode updated", updated));
          },
        )
        .command(
          "apply",
          "Apply manual fault or network shaping settings to the session",
          (b) =>
            controlMutationOptions(b)
              .option("file", {
                type: "string",
                description: "Portable manual settings export or fault config JSON file",
              })
              .option("ensure-mode", {
                type: "boolean",
                default: false,
                description: "Switch to manual mode automatically before applying",
              })
              .option("missing", {
                choices: ["off", "once", "random", "always"] as const,
                description: "Segment HTTP 404 mode",
              })
              .option("forbidden", {
                choices: ["off", "once", "random", "always"] as const,
                description: "Segment HTTP 403 mode",
              })
              .option("malformed", {
                choices: ["off", "once", "random", "always"] as const,
                description: "Malformed media response mode",
              })
              .option("latency-ms", {
                type: "number",
                description: "Fixed response delay in milliseconds (0–60000)",
              })
              .option("bandwidth-kbps", {
                type: "number",
                description: "Shared media/init bandwidth ceiling in kbps (0–1000000; 0 disables)",
              })
              .option("jitter-ms", {
                type: "number",
                description: "Additional random response delay in milliseconds (0–60000; 0 disables)",
              })
              .option("freeze", {
                choices: ["off", "always"] as const,
                description: "Hold dynamic manifests at the latest snapshot",
              })
              .option("key-failure", {
                choices: ["off", "once", "random", "always"] as const,
                description: "Encrypted HLS origin key HTTP 403 mode",
              })
              .option("key-mismatch", {
                choices: ["off", "once", "random", "always"] as const,
                description: "Encrypted HLS origin key mismatch mode",
              }),
          async (args: any) => {
            const patch: ManualFlagsPatch = {
              missing: args.missing as FaultMode | undefined,
              forbidden: args.forbidden as FaultMode | undefined,
              malformed: args.malformed as FaultMode | undefined,
              latencyMs: args["latency-ms"],
              bandwidthKbps: args["bandwidth-kbps"],
              jitterMs: args["jitter-ms"],
              freeze: args.freeze as "off" | "always" | undefined,
              keyFailure: args["key-failure"] as FaultMode | undefined,
              keyMismatch: args["key-mismatch"] as FaultMode | undefined,
            };
            const hasPatch = Object.values(patch).some(v => v !== undefined);
            if (!args.file && !hasPatch) {
              throw new Error(
                "Provide --file <settings.json> or at least one manual setting flag (e.g. --bandwidth-kbps, --missing, --freeze)",
              );
            }
            const fileSettings = args.file ? parseSettingsFile(args.file) : undefined;
            const client = buildControlClient(args);
            const updated = await client.apply(
              {
                settings: fileSettings,
                patch: hasPatch ? patch : undefined,
                ensureManualMode: Boolean(args["ensure-mode"]),
              },
              pinFromArgs(args),
            );
            console.info(args.json ? JSON.stringify(updated, null, 2) : formatControlMutation("Manual settings applied", updated));
          },
        )
        .command(
          "inject <type>",
          "Arm a one-shot manual fault or latency spike for the next matching request",
          (b) =>
            controlMutationOptions(b)
              .positional("type", {
                choices: [
                  "segment.missing",
                  "segment.forbidden",
                  "segment.malformed",
                  "segment.latencySpike",
                  "segment.latencyReset",
                  "drm.licenseFailure",
                  "drm.keyRotationMismatch",
                ] as const,
                demandOption: true,
              })
              .option("value", {
                type: "number",
                description: "Latency in milliseconds for segment.latencySpike (0–60000)",
              })
              .option("ensure-mode", {
                type: "boolean",
                default: false,
                description: "Switch to manual mode automatically before injecting",
              }),
          async (args: any) => {
            const client = buildControlClient(args);
            const updated = await client.inject(
              args.type,
              { value: args.value, ensureManualMode: Boolean(args["ensure-mode"]) },
              pinFromArgs(args),
            );
            console.info(args.json ? JSON.stringify(updated, null, 2) : formatControlMutation(`Injected ${args.type}`, updated));
          },
        )
        .command(
          "clear",
          "Clear manual faults back to healthy settings and retain the completed manual test",
          controlMutationOptions,
          async (args: any) => {
            const client = buildControlClient(args);
            const updated = await client.clear(pinFromArgs(args));
            console.info(args.json ? JSON.stringify(updated, null, 2) : formatControlMutation("Manual faults cleared", updated));
          },
        )
        .command(
          "arm <preset>",
          "Prepare an immutable scenario preset without starting fault delivery",
          (b) =>
            controlMutationOptions(b)
              .positional("preset", {
                type: "string",
                demandOption: true,
                description: "Catalog preset ID (or loaded for a --scenario-start manual file)",
              })
              .option("discover", {
                type: "boolean",
                default: true,
                description: "Perform inert baseline playlist discovery before arming",
              }),
          async (args: any) => {
            const client = buildControlClient(args);
            const updated = await client.arm(args.preset, { discover: args.discover }, pinFromArgs(args));
            console.info(args.json ? JSON.stringify(updated, null, 2) : formatControlMutation(`Prepared ${args.preset}`, updated));
          },
        )
        .command(
          "start",
          "Start the already prepared scenario run",
          controlMutationOptions,
          async (args: any) => {
            const client = buildControlClient(args);
            const updated = await client.start(pinFromArgs(args));
            console.info(args.json ? JSON.stringify(updated, null, 2) : formatControlMutation("Scenario started", updated));
          },
        )
        .command(
          "stop",
          "Stop and disarm the active scenario or manual test while retaining evidence",
          controlMutationOptions,
          async (args: any) => {
            const client = buildControlClient(args);
            const updated = await client.stop(pinFromArgs(args));
            console.info(args.json ? JSON.stringify(updated, null, 2) : formatControlMutation("Session test stopped", updated));
          },
        )
        .command(
          "run <preset>",
          "Switch to scenario mode, prepare and start a preset, and optionally wait for completion",
          (b) =>
            controlTargetOptions(b)
              .positional("preset", {
                type: "string",
                demandOption: true,
                description: "Catalog preset ID to prepare and start",
              })
              .option("wait", {
                type: "boolean",
                default: false,
                description: "Wait until the scenario reaches a terminal simulator outcome",
              })
              .option("poll-ms", {
                type: "number",
                default: 500,
                description: "Polling interval in milliseconds when --wait is set",
              })
              .option("discover", {
                type: "boolean",
                default: true,
                description: "Perform inert baseline playlist discovery before arming",
              }),
          async (args: any) => {
            const client = buildControlClient(args, 15000);
            const result = await client.run(args.preset, {
              wait: Boolean(args.wait),
              timeoutMs: args.timeout ?? 60000,
              pollIntervalMs: args["poll-ms"],
              discover: args.discover,
            });
            if (args.wait) {
              if (result.timedOut || result.outcome !== "passed") process.exitCode = 1;
              if (args.json) {
                console.info(JSON.stringify(result, null, 2));
              } else {
                console.info(
                  `Scenario ${args.preset}: ${result.timedOut ? `timed out (state=${result.outcome})` : `outcome=${result.outcome}`}\n${result.note}`,
                );
              }
            } else {
              console.info(args.json ? JSON.stringify(result, null, 2) : formatControlMutation(`Running ${args.preset}`, result));
            }
          },
        )
        .command(
          "wait",
          "Wait until an active interactive or startup scenario reaches a terminal outcome",
          (b) =>
            controlTargetOptions(b).option("poll-ms", {
              type: "number",
              default: 500,
              description: "Polling interval in milliseconds",
            }),
          async (args: any) => {
            const client = buildControlClient(args, 15000);
            const result = await client.wait({
              timeoutMs: args.timeout ?? 60000,
              pollIntervalMs: args["poll-ms"],
            });
            if (result.timedOut || result.outcome !== "passed") process.exitCode = 1;
            if (args.json) {
              console.info(JSON.stringify(result, null, 2));
            } else {
              console.info(
                `Scenario wait: ${result.timedOut ? `timed out (state=${result.outcome})` : `outcome=${result.outcome}`} (session ${result.sessionId})\n${result.note}`,
              );
            }
          },
        )
        .demandCommand(1, "Specify a control subcommand (e.g. status, catalog, manifest, run, apply, inject, clear, stop)"),
    () => {},
  )
  .command(
    "skill",
    "Print or install the bundled AI agent SKILL.md for Claude, Codex and Google",
    (builder) =>
      builder
        .option("install", {
          choices: ["claude", "codex", "google", "all"] as const,
          type: "string",
          description: "Install SKILL.md for Claude Code, OpenAI Codex, Google (Gemini CLI / Antigravity), or all",
        })
        .option("global", {
          type: "boolean",
          default: false,
          description: "Install into your user home skill directory instead of the current workspace",
        })
        .option("dir", {
          type: "string",
          description: "Target workspace directory when using --install (default: current directory)",
        })
        .option("force", {
          type: "boolean",
          default: false,
          description: "Overwrite existing SKILL.md files when installing",
        })
        .option("json", {
          type: "boolean",
          default: false,
          description: "Emit structured JSON output",
        }),
    (args: any) => {
      if (!args.install) {
        if (args.global || args.dir || args.force) {
          throw new Error("Pass --install <claude|codex|google|all> when using --global, --dir or --force");
        }
        const content = readBundledSkill();
        if (args.json) {
          console.info(JSON.stringify({ name: "hls-dash-live-sim", content }, null, 2));
        } else {
          process.stdout.write(content.endsWith("\n") ? content : content + "\n");
        }
        return;
      }
      const { written } = installAgentSkill({
        target: args.install as AgentSkillTarget,
        global: Boolean(args.global),
        dir: args.dir,
        force: Boolean(args.force),
      });
      if (args.json) {
        console.info(JSON.stringify({ target: args.install, global: Boolean(args.global), written }, null, 2));
      } else {
        console.info(`Installed hls-dash-live-sim skill (${args.install}):\n` + written.map(f => `  ${f}`).join("\n"));
      }
    },
  )
  .command(
    "livesim [action]",
    "Start a supervised HLS/DASH session, or manage an owned Docker container",
    (builder) =>
      startOptions(builder)
        .positional("action", {
          choices: ["start", "stop", "logs"],
          default: "start",
        })
        .option("sim-type", { choices: ["hls", "dash"] })
        .option("fixture", { choices: ["tracks"], description: "Owned local fMP4, alternate audio and caption fixture; no DASH container" })
        .option("hls-aes",{type:"boolean",default:false,description:"Local rotating AES-128 and clear transitions; requires HLS tracks fixture"})
        .option("video-renditions", { choices: [2,3], type: "number", description: "Video ladder size for --fixture tracks (default 2)" })
        .option("manifest-url", {
          alias: "manifestUrl",
          type: "string",
          description: "Source to proxy (HLS) or analyze (DASH)",
        })
        .option("mode", { choices: ["live", "event", "vod"], default: "live" })
        .option("window-segments", { type: "number", default: 6 })
        .option("dummy-content", {
          type: "boolean",
          description:
            "Use procedural sample media; defaults to true only without a source URL",
        })
        .option("preserve-manifest", {
          type: "boolean",
          default: false,
          description:
            "Legacy arbitrary substitution is unsupported; use a real HLS origin proxy",
        })
        .option("proxy", {
          type: "boolean",
          default: true,
          description: "Disable only for HLS MP4 VoD mode",
        })
        .option("fault-proxy", { type: "boolean", default: true })
        .option("redundant-streams", { type: "boolean", description: "Advertise a /backup copy of the stream (HLS redundant variants, DASH BaseURLs) for failover scenarios" })
        .option("low-latency", { type: "boolean", description: "Low-latency live: generated HLS serves fMP4 parts with preload hints and blocking playlist reload; DASH serves chunked segments with early availability" })
        .option("segment-format", { choices: ["ts", "fmp4"], description: "Generated HLS container: fMP4 (default; 234p/432p/720p ladder with separate audio) or MPEG-TS (two muxed renditions; chosen automatically with --ad-break-segments)" })
        .option("ad-break-segments", { type: "number", description: "Generated HLS: insert an ad pod of this many segments after each content loop, marked with EXT-X-DATERANGE, CUE-OUT/IN and discontinuities" })
        .option("legacy-url-routes", { type: "boolean", description: "Serve HLS origin /pl|/seg|/key?u= routes; default only on loopback hosts" })
        .option("fault-config", { type: "string" })
        .option("fault-profile", { type: "string" })
        .option("periods-per-hour", {
          type: "number",
          description: "DASH live period frequency, from 1 to 60",
        })
        .option("periods", {
          type: "number",
          description: "Legacy period count; requires equal period-durations",
        })
        .option("period-durations", {
          type: "string",
          description:
            "Equal durations of at least 60 seconds; must divide one hour",
        })
        .option("asset", {
          type: "string",
          description:
            "DASH asset: bundled sample (default), abr ladder, or a directory under --vodroot",
        })
        .option("vodroot", { type: "string" })
        .option("source", { type: "string" })
        .option("image", { type: "string" })
        .option("utc", {
          choices: ["local", "external"],
          default: "local",
          description: "DASH UTC synchronization source (external requires internet)",
        })
        .option("name", { type: "string" })
        .option("open", { type: "boolean", default: false })
        .option("pull", { type: "boolean", default: true })
        .option("force-pull", { type: "boolean", default: false })
        .option("detach", {
          type: "boolean",
          description:
            "Legacy flag: the Docker engine is detached; this session remains supervised in the foreground",
        }),
    async (args: any) => {
      const type =
        args["sim-type"] ??
        (args["manifest-url"] &&
        new URL(args["manifest-url"]).pathname.toLowerCase().endsWith(".mpd")
          ? "dash"
          : "hls");
      if (args.action !== "start") {
        if (!args.name)
          throw new Error(
            "Use Ctrl+C for foreground sessions, or provide --name for an owned Docker container",
          );
        if (type === "dash")
          await (args.action === "stop" ? stopLivesim2 : logsLivesim2)({
            name: args.name,
          });
        else
          await (args.action === "stop" ? stopHlsim : logsHlsim)({
            name: args.name,
          });
        return;
      }
      if (args["session-file"]) {
        if (args.proxy === false || args["fault-proxy"] === false) {
          throw new Error("--session-file requires the default Node/fault proxy");
        }
        validateSessionFileTarget(args["session-file"]);
      }
      const common = {
        port: args.port,
        host: args.host,
        allowedHosts: args["allow-host"], allowedPlayerOrigins: args["allow-player-origin"], redundantStreams: args["redundant-streams"],
        name: args.name,
        image: args.image,
        open: args.open,
        noPull: !args.pull,
        forcePull: args["force-pull"],
        vodroot: args.vodroot,
        source: args.source,
        manifestUrl: args["manifest-url"],
        preserveManifest: args["preserve-manifest"],
        faultConfigPath: args["fault-config"],
        faultProfile: args["fault-profile"],
        diagnosticsFile: args["diagnostics-file"],diagnosticsRotateFiles:args["diagnostics-rotate-files"],
        scenarioFile: args.scenario,
        scenarioStart: args["scenario-start"],
        controlToken: args["control-token"],
        verbose: args.verbose,
        http2: http2Option(args),
        ...auth(args),
      };
      if (args.fixture && (args.asset || args.image || args.name || args["force-pull"] || args["periods-per-hour"] || args.periods || args["period-durations"] || args.utc === "external" || args["fault-proxy"] === false)) throw new Error("Owned tracks cannot combine with engine assets, image/Period options, external UTC or disabled fault proxy");
      if(args["hls-aes"]&&(!args.fixture||type!=="hls"))throw new Error("hls-aes requires HLS --fixture tracks");
      if (args["ad-break-segments"] !== undefined && (type !== "hls" || args.fixture || args.proxy === false)) throw new Error("--ad-break-segments applies to the generated HLS sample stream; DASH uses --periods-per-hour for period transitions");
      if ((args["low-latency"] || args["segment-format"]) && (args.fixture || args.proxy === false)) throw new Error("--low-latency and --segment-format apply to the generated HLS sample or the DASH engine, not to --fixture tracks or MP4 VoD");
      if (args["segment-format"] && type !== "hls") throw new Error("--segment-format applies to generated HLS; DASH media is always fMP4");
      if (args["video-renditions"] && !args.fixture) throw new Error("video-renditions requires --fixture tracks");
      const session = await starting(async (signal) =>
        args.fixture ? await startTrackFixture({ ...common, signal, protocol: type, mode: args.mode, windowSegments: args["window-segments"], videoRenditions: args["video-renditions"],hlsAes:args["hls-aes"], proxy: args.proxy }) : type === "dash"
          ? await startLivesim2({
              ...common,
              signal,
              faultProxy: args["fault-proxy"],
              asset: args.asset,
              periodCount: args.periods,
              periodDurations: args["period-durations"]?.split(",").map(Number),
              periodsPerHour: args["periods-per-hour"],
              utc: args.utc,
              lowLatency: args["low-latency"],
              extraArgs: args["--"]?.map(String),
            })
          : await startHlsim({
              ...common,
              signal,
              mode: args.mode,
              windowSegments: args["window-segments"],
              proxy: args.proxy,
              legacyUrlRoutes: args["legacy-url-routes"],
              dummyContent: args["dummy-content"],
              adBreakSegments: args["ad-break-segments"],
              segmentFormat: (args["dummy-content"] ?? !args["manifest-url"]) ? generatedHlsFormat(args["segment-format"], args["ad-break-segments"], undefined, args["low-latency"]) : args["segment-format"],
              lowLatency: args["low-latency"],
            }),
      );
      await supervise(session, args.showManifest, type, args);
    },
  )
  .command(
    ["list-manifest-templates", "list-templates"],
    "List templates and their actual capabilities",
    () => {},
    () => {
      for (const { name, template } of listTemplates())
        console.info(
          `${name}${template.supported === false ? " [unsupported]" : ""}: ${template.description}\n  ${template.segmentDuration} ms; ${template.bitrateLadder.join(", ")} bps${template.sourceUrl ? "; imported source" : ""}`,
        );
    },
  )
  .command(
    "certs",
    "Create a local CA and a server certificate for --http2 (needs openssl)",
    (builder) =>
      builder
        .option("dir", { type: "string", default: ".certs", description: "Output directory; it ignores itself in Git" })
        .option("extra-host", { type: "array", string: true, description: "Extra host name or IP address to cover, e.g. my-mac.local or 10.0.2.2" })
        .option("lan", { type: "boolean", default: true, description: "Cover this computer's LAN IPv4 addresses; --no-lan leaves them out" }),
    (args: any) => {
      console.info(describeLocalCerts(createLocalCerts({ dir: args.dir, hosts: args["extra-host"], lan: args.lan })));
    },
  )
  .command(
    "create-manifest-template <url>",
    "Analyze and save a source manifest without storing authentication",
    (builder) =>
      authOptions(builder)
        .positional("url", { type: "string", demandOption: true })
        .option("name", { type: "string" }),
    async (args: any) => {
      const template = await createTemplateFromUrl({
        url: args.url,
        name: args.name,
        ...auth(args),
      });
      saveTemplate(args.name ?? template.name, template);
    },
  )
  .command(
    "dummy-stream <template>",
    "Start a validated sample or imported source",
    (builder) =>
      startOptions(builder)
        .positional("template", { type: "string", demandOption: true })
        .option("sim-type", { choices: ["hls", "dash"] })
        .option("mode", { choices: ["live", "event", "vod"], default: "live" })
        .option("detach", { type: "boolean" }),
    (args: any) => runTemplate(args.template, args),
  );
for (const name of ["sports", "news", "ott", "mobile", "low-latency", "ladder"])
  program.command(
    `${name}-stream`,
    "Start the named template",
    (builder) =>
      startOptions(builder)
        .option("sim-type", { choices: ["hls", "dash"] })
        .option("detach", { type: "boolean" }),
    (args: any) => runTemplate(name, args),
  );
const report = (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode ??= 1;
};
// Usage errors are thrown synchronously, before any promise exists. Uncaught,
// Node prints the throwing line of yargs' minified bundle around the message.
try {
  program
  .check((args) => {
    if(args["diagnostics-rotate-files"]!==undefined&&(!args["diagnostics-file"]||!Number.isInteger(args["diagnostics-rotate-files"])||Number(args["diagnostics-rotate-files"])<2||Number(args["diagnostics-rotate-files"])>256))throw new Error("diagnostics-rotate-files requires diagnostics-file and an integer from 2 to 256");
    if (args.port !== undefined) portNumber(args.port as number);
    if (args.host !== undefined) bindHost(args.host as string);
    for (const key of ["periods", "periods-per-hour"])
      if (
        args[key] !== undefined &&
        (!Number.isInteger(args[key]) ||
          Number(args[key]) < 1 ||
          Number(args[key]) > 60)
      )
        throw new Error(`${key} must be an integer from 1 to 60`);
    return true;
  })
  .demandCommand(1)
  .strict()
  .help()
  .parseAsync()
  .catch(report);
} catch (error) {
  report(error);
}
