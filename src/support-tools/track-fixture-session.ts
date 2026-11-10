import { TrackFixturePublisher } from "./track-fixture.js";
import { startHlsim, type HlsSession, type HLSStartOptions } from "./hls-sim-runner.js";
import { startDashFaultProxy } from "./dash-fault-proxy.js";
import { loadScenario } from "./scenario.js";
import { setFaultConfigPath, applyConfigOverride } from "./live-stream-fault-config.js";
import { portNumber, bindHost, playerAccess } from "./safe-http.js";
import { validateScenarioStart } from "./scenario-runs.js";
import path from "node:path";
export interface TrackFixtureOptions extends HLSStartOptions {
  protocol: "hls" | "dash";
  videoRenditions?: number;
  hlsAes?:boolean;
}
/** Node-only ownership handle for independent source/proxy integrity checks. */
export interface OwnedTrackFixtureSession extends HlsSession {
  readonly fixtureManifestUrl: string;
}
/** Local fixture origin ownership is separate from the externally bound adapter. */
export async function startTrackFixture(options: TrackFixtureOptions): Promise<OwnedTrackFixtureSession> {
  const port = portNumber(options.port ?? (options.protocol === 'hls' ? 8899 : 8888)), host = bindHost(options.host ?? '127.0.0.1');
  validateScenarioStart(options.scenarioStart, options.controlToken);
  if (options.manifestUrl || options.source || options.vodroot || options.preserveManifest || options.proxy === false || options.authToken || options.authHeader || options.authFile || options.allowedOrigins?.length)
    throw Error('Owned track fixture cannot combine with external source or disabled proxy options');
  if (!['hls', 'dash'].includes(options.protocol))
    throw Error('Fixture protocol must be hls or dash');
  options.signal?.throwIfAborted();
  const definition = loadScenario(options.scenarioFile);
  if(options.hlsAes&&options.protocol!=='hls')throw Error('Local AES fixture requires HLS');
  if(options.hlsAes&&definition&&!['key-unavailable','wrong-key'].includes(definition.services?.kind))throw Error('AES fixture combinations require dedicated key presets; other compositions are unverified');
  if(definition?.services?.kind==='token-expiry'&&options.scenarioStart!=='manual')throw Error('Local access-token scenarios require authenticated manual controls');
  const publisher = new TrackFixturePublisher(options.mode ?? 'live', options.videoRenditions ?? 2, undefined, undefined, options.windowSegments ?? 6,{protocol:options.protocol,aes:options.hlsAes});
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
      session = await startHlsim({ ...options, port, host, lifecycleHooks:publisher.lifecycle.hooks(options.protocol),serviceHooks:publisher.services.hooks(),ownedFixture: true,ownedAes:options.hlsAes, ownedVideoTracks: options.videoRenditions ?? 2, manifestUrl: origin.url + '/hls/master.m3u8', dummyContent: false });
    else {
      setFaultConfigPath(options.faultConfigPath ?? process.env.HLS_FAULT_CONFIG ?? path.resolve(process.cwd(), '.hls-dash-faults.json'));
      if (options.faultProfile)
        applyConfigOverride({ profile: options.faultProfile });
      if (options.verbose !== undefined)
        applyConfigOverride({ logging: { verbose: options.verbose } });
      const proxy = await startDashFaultProxy({lifecycleHooks:publisher.lifecycle.hooks(options.protocol),serviceHooks:publisher.services.hooks(),redundantStreams:options.redundantStreams, listenPort: port, upstreamPort: origin.port, host, manifestPath: '/dash/manifest.mpd', diagnosticsFile: options.diagnosticsFile,diagnosticsRotateFiles:options.diagnosticsRotateFiles,diagnosticsMaxFileBytes:options.diagnosticsMaxFileBytes, scenario: definition, scenarioStart: options.scenarioStart, controlToken: options.controlToken, videoTracks: options.videoRenditions ?? 2, access: playerAccess(options.allowedHosts, options.allowedPlayerOrigins) });
      session = { url: `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(':') ? '[' + host + ']' : host}:${port}/dash/manifest.mpd`, diagnostics: proxy.diagnostics, networkOwnership: proxy.networkOwnership,resourceOwnership:proxy.resourceOwnership, get scenario() { return proxy.scenario; }, runs: proxy.runs, close: () => proxy.close() };
      console.info('Owned DASH track fixture ready: ' + session.url);
    }
    options.signal?.throwIfAborted();
    const owned: OwnedTrackFixtureSession = { url: session.url, fixtureManifestUrl: origin.url + (options.protocol === 'hls' ? '/hls/master.m3u8' : '/dash/manifest.mpd'),sourceOwnership:()=>publisher.ownership(), networkOwnership: session.networkOwnership,resourceOwnership:session.resourceOwnership, diagnostics: session.diagnostics, get scenario() { return session.scenario; }, get runs() { return session.runs; }, close };
    Object.defineProperty(owned, 'fixtureManifestUrl', { value: origin.url + (options.protocol === 'hls' ? '/hls/master.m3u8' : '/dash/manifest.mpd'), enumerable: false, writable: false });
    return owned;
  }
  catch (error) {
    await close();
    throw error;
  }
}
