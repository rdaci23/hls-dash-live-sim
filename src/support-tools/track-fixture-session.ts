import { TrackFixturePublisher } from "./track-fixture.js";
import { startHlsim, type HlsSession, type HLSStartOptions } from "./hls-sim-runner.js";
import { startDashFaultProxy } from "./dash-fault-proxy.js";
import { loadScenario } from "./scenario.js";
import { setFaultConfigPath, applyConfigOverride } from "./live-stream-fault-config.js";
import { portNumber, bindHost } from "./safe-http.js";
import { validateScenarioStart } from "./scenario-runs.js";
import path from "node:path";
export interface TrackFixtureOptions extends HLSStartOptions {
  protocol: "hls" | "dash";
  videoRenditions?: number;
}
/** Local fixture origin ownership is separate from the externally bound adapter. */
export async function startTrackFixture(options: TrackFixtureOptions): Promise<HlsSession> {
  const port = portNumber(options.port ?? (options.protocol === 'hls' ? 8899 : 8888)), host = bindHost(options.host ?? '127.0.0.1');
  validateScenarioStart(options.scenarioStart, options.controlToken);
  if (options.manifestUrl || options.source || options.vodroot || options.preserveManifest || options.proxy === false || options.authToken || options.authHeader || options.authFile || options.allowedOrigins?.length)
    throw Error('Owned track fixture cannot combine with external source or disabled proxy options');
  if (!['hls', 'dash'].includes(options.protocol))
    throw Error('Fixture protocol must be hls or dash');
  options.signal?.throwIfAborted();
  const definition = loadScenario(options.scenarioFile), publisher = new TrackFixturePublisher(options.mode ?? 'live', options.videoRenditions ?? 2, undefined, undefined, options.windowSegments ?? 6);
  let origin: Awaited<ReturnType<typeof publisher.start>>, session: HlsSession, closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try {
      await session?.close();
    }
    finally {
      await origin?.close();
    }
  })();
  try {
    origin = await publisher.start();
    options.signal?.throwIfAborted();
    if (options.protocol === 'hls')
      session = await startHlsim({ ...options, port, host, ownedFixture: true, ownedVideoTracks: options.videoRenditions ?? 2, manifestUrl: origin.url + '/hls/master.m3u8', dummyContent: false });
    else {
      setFaultConfigPath(options.faultConfigPath ?? process.env.HLS_FAULT_CONFIG ?? path.resolve(process.cwd(), '.hls-dash-faults.json'));
      if (options.faultProfile)
        applyConfigOverride({ profile: options.faultProfile });
      if (options.verbose !== undefined)
        applyConfigOverride({ logging: { verbose: options.verbose } });
      const proxy = await startDashFaultProxy({ listenPort: port, upstreamPort: origin.port, host, manifestPath: '/dash/manifest.mpd', diagnosticsFile: options.diagnosticsFile, scenario: definition, scenarioStart: options.scenarioStart, controlToken: options.controlToken, videoTracks: options.videoRenditions ?? 2 });
      session = { url: `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(':') ? '[' + host + ']' : host}:${port}/dash/manifest.mpd`, diagnostics: proxy.diagnostics, networkOwnership: proxy.networkOwnership, get scenario() { return proxy.scenario; }, runs: proxy.runs, close: () => proxy.close() };
      console.info('Owned DASH track fixture ready: ' + session.url);
    }
    options.signal?.throwIfAborted();
    return { url: session.url, networkOwnership: session.networkOwnership, diagnostics: session.diagnostics, get scenario() { return session.scenario; }, get runs() { return session.runs; }, close };
  }
  catch (error) {
    await close();
    throw error;
  }
}
