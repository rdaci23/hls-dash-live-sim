#!/usr/bin/env node
import { startTrackFixture } from "./support-tools/track-fixture-session.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { portNumber, bindHost } from "./support-tools/safe-http.js";
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

async function supervise(
  session: { url: string; close(): Promise<void> },
  show: boolean,
) {
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
const startOptions = (builder) =>
  authOptions(builder)
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

async function runTemplate(name: string, args) {
  const template = getTemplate(name);
  if (!template)
    throw new Error("Unknown template; run list-manifest-templates");
  if (template.supported === false)
    throw new Error(
      "This template requires true low-latency media and transport, which are not supported yet",
    );
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
          manifestUrl: template.sourceUrl,
          ...auth(args),
        }),
      ),
      args.showManifest,
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
          manifestUrl: template.sourceUrl,
          dummyContent: template.sourceUrl ? false : true,
          ...auth(args),
        }),
      ),
      args.showManifest,
    );
  }
}

const program = yargs(hideBin(process.argv))
  .fail((message, error) => {
    throw error ?? new Error(`${message}\nRun with --help to list commands and options.`);
  })
  .scriptName("hls-dash-live-sim")
  .usage("$0 <command> [options]")
  .version("0.2.0")
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
        ...auth(args),
      };
      if (args.fixture && (args.asset || args.image || args.name || args["force-pull"] || args["periods-per-hour"] || args.periods || args["period-durations"] || args.utc === "external" || args["fault-proxy"] === false)) throw new Error("Owned tracks cannot combine with engine assets, image/Period options, external UTC or disabled fault proxy");
      if(args["hls-aes"]&&(!args.fixture||type!=="hls"))throw new Error("hls-aes requires HLS --fixture tracks");
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
            }),
      );
      await supervise(session, args.showManifest);
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
for (const name of ["sports", "news", "ott", "mobile", "low-latency"])
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
