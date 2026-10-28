import { listen, closeServer } from './safe-http.js';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { getFaultConfig, onFaultConfigChange, type FaultMode } from './live-stream-fault-config.js';

export interface DashAliasMapEntry {
  type: 'video' | 'audio' | 'other';
  originalId: string;
  representationId: string;
  initializationPath: string;
  mediaTemplate: string;
  startNumber: number;
  originalStartNumber?: number;
  timescale?: number;
  segmentTimeline?: SegmentTimelineEntry[];
  replacements: Record<string, string>;
  periodId?: string; // Period ID (e.g., "P0", "P1")
  periodStartTime?: number; // Period start time in seconds
}

interface SegmentTimelineEntry {
  t?: number;
  d: number;
  r?: number;
}

export interface DashFaultProxyOptions {
  host?: string;
  listenPort: number;
  upstreamPort: number;
  preserve?: {
    manifest: string;
    aliasMap: Record<string, DashAliasMapEntry>;
  };
}

export interface DashFaultProxy {
  close: () => Promise<void>;
  upstreamBase: string;
}

let faultConfig = getFaultConfig();
const randomDecisions = new Map<string, boolean>();
const onceTriggers = new Set<string>();
let preserveConfig: DashFaultProxyOptions['preserve'] = undefined;

onFaultConfigChange(config => {
  faultConfig = config;
  randomDecisions.clear();
  onceTriggers.clear();
  logDashEvent('config-update', {
    segment: config.segment ?? null,
    manifest: config.manifest ?? null,
    drm: config.drm ?? null,
    logging: config.logging ?? null
  });
});

const RANDOM_THRESHOLD = 0.4;

function shouldTrigger(mode: FaultMode | undefined, scope: string): boolean {
  if (!mode || mode === 'off') return false;
  if (mode === 'always') return true;
  if (mode === 'once') {
    if (onceTriggers.has(scope)) return false;
    onceTriggers.add(scope);
    return true;
  }
  if (mode === 'random') {
    if (!randomDecisions.has(scope)) {
      randomDecisions.set(scope, Math.random() < RANDOM_THRESHOLD);
    }
    return randomDecisions.get(scope) ?? false;
  }
  return false;
}

function delay(ms: number | undefined): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logDashEvent(event: string, details: Record<string, unknown>): void {
  const payload = { timestamp: new Date().toISOString(), event, ...details };
  console.info(`[dash] ${JSON.stringify(payload)}`);
}

function classifyPath(pathname: string): 'manifest' | 'segment' | 'other' {
  if (pathname.endsWith('.mpd')) return 'manifest';
  if (pathname.endsWith('.m4s') || pathname.endsWith('.mp4') || pathname.includes('/Segment') || pathname.includes('chunk')) {
    return 'segment';
  }
  return 'other';
}

function fetchUpstream(url: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const timeout = 10000; // 10 second timeout
    const req = client.request(url, { headers, method: 'GET', timeout }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        resolve({ status: res.statusCode || 200, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeout}ms for ${url}`));
    });
    req.end();
  });
}

export async function startDashFaultProxy(options: DashFaultProxyOptions): Promise<DashFaultProxy> {
  preserveConfig = options.preserve;
  let cachedManifest: string | null = preserveConfig?.manifest ?? null;
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', `http://localhost:${options.listenPort}`);
      const cfg = faultConfig;
      const latencyMs = cfg.segment?.latencyMs ?? 0;

      if (preserveConfig && requestUrl.pathname === '/proxy.mpd') {
        await delay(latencyMs);
        res.writeHead(200, { 'Content-Type': 'application/dash+xml' });
        res.end(preserveConfig.manifest);
        logDashEvent('manifest', { status: 200, path: requestUrl.pathname, preserve: true });
        return;
      }

      if (preserveConfig && requestUrl.pathname.startsWith('/__dash__/')) {
        // Only handle preserved segments if we have alias mappings
        if (Object.keys(preserveConfig.aliasMap).length > 0) {
          await handlePreservedSegmentRequest(options.upstreamPort, requestUrl, res, latencyMs, cfg);
          return;
        }
        // If no alias mappings, fall through to normal proxying
      }

      const targetUrl = `http://127.0.0.1:${options.upstreamPort}${requestUrl.pathname}${requestUrl.search}`;
      const kind = classifyPath(requestUrl.pathname);
      if (cfg.logging?.verbose) {
        logDashEvent('config-active', {
          path: requestUrl.pathname,
          kind,
          segment: cfg.segment ?? null,
          manifest: cfg.manifest ?? null,
          drm: cfg.drm ?? null,
          latencyMs
        });
      }

      // Manifest freeze logic
      const freeze = kind === 'manifest' && shouldTrigger(cfg.manifest?.freeze, 'dash.manifest.freeze');

      if (kind === 'segment') {
        const scope = `dash.segment:${requestUrl.pathname}`;
        if (shouldTrigger(cfg.segment?.missing, `${scope}:missing`)) {
          await delay(latencyMs);
          res.writeHead(404);
          res.end('DASH segment missing (fault injection)');
          logDashEvent('segment', { status: 404, path: requestUrl.pathname, fault: 'missing' });
          return;
        }
        if (shouldTrigger(cfg.segment?.forbidden, `${scope}:forbidden`)) {
          await delay(latencyMs);
          res.writeHead(403);
          res.end('DASH segment forbidden (fault injection)');
          logDashEvent('segment', { status: 403, path: requestUrl.pathname, fault: 'forbidden' });
          return;
        }
      }

      if (!preserveConfig && kind === 'manifest' && freeze && cachedManifest) {
        await delay(latencyMs);
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(cachedManifest);
        logDashEvent('manifest', { status: 200, path: requestUrl.pathname, freeze: true });
        return;
      }

      const headers: Record<string, string> = {};
      if (req.headers['user-agent']) headers['User-Agent'] = String(req.headers['user-agent']);
      if (req.headers['range']) headers['Range'] = String(req.headers['range']);

      const upstream = await fetchUpstream(targetUrl, headers);

      await delay(latencyMs);

      if (!preserveConfig && kind === 'manifest' && !cachedManifest) {
        cachedManifest = upstream.body.toString('utf8');
      }

      let body = upstream.body;

      if (kind === 'segment' && shouldTrigger(cfg.segment?.malformed, `dash.segment:${requestUrl.pathname}:malformed`)) {
        body = body.subarray(0, Math.max(1, Math.floor(body.length / 4)));
        logDashEvent('segment', { status: upstream.status, path: requestUrl.pathname, fault: 'malformed', bytes: body.length });
      } else if (kind === 'manifest') {
        logDashEvent('manifest', { status: upstream.status, path: requestUrl.pathname, freeze });
      }

      res.writeHead(upstream.status, upstream.headers as Record<string, string>);
      res.end(body);

      if (kind === 'segment' && !shouldTrigger(cfg.segment?.malformed, `dash.segment:${requestUrl.pathname}:malformed`)) {
        logDashEvent('segment', { status: upstream.status, path: requestUrl.pathname, bytes: body.length });
      }
    } catch (err) {
      res.writeHead(500);
      res.end('Dash fault proxy error');
      logDashEvent('error', { status: 500, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    listen(server, options.listenPort, options.host).then(resolve, reject);
  });

  logDashEvent('proxy-start', { listenPort: options.listenPort, upstreamPort: options.upstreamPort, preserve: Boolean(preserveConfig) });

  return {
    upstreamBase: `http://127.0.0.1:${options.upstreamPort}`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })
  };
}

async function handlePreservedSegmentRequest(upstreamPort: number, requestUrl: URL, res: http.ServerResponse, latencyMs: number, cfg: ReturnType<typeof getFaultConfig>) {
  const pathName = requestUrl.pathname;
  const parts = pathName.split('/').filter(Boolean);

  // Handle multi-period paths: /__dash__/P0/1/segment-1.m4s or /__dash__/P0/1/init.mp4
  let alias: string;
  let file: string;
  let periodId: string | undefined;

  if (parts[1]?.match(/^P\d+$/)) {
    // Multi-period format: /__dash__/P0/1/segment-1.m4s
    periodId = parts[1]; // e.g., "P0"
    const repId = parts[2]; // e.g., "1"
    file = parts.slice(3).join('/'); // e.g., "segment-1.m4s" or "init.mp4"
    alias = `${periodId}-${repId}`; // e.g., "P0-1"
  } else {
    // Legacy format: /__dash__/1/segment-1.m4s
    alias = parts[1];
    file = parts.slice(2).join('/');
  }

  let aliasEntry = preserveConfig?.aliasMap[alias];
  if (!aliasEntry || !file) {
    // Try fallback to default alias if period-specific not found
    const fallbackAlias = preserveConfig?.aliasMap['1'];
    if (fallbackAlias && file) {
      // Use fallback but log the mismatch
      logDashEvent('segment', { status: 200, path: pathName, alias: '1', fallback: true, requestedAlias: alias });
      aliasEntry = fallbackAlias;
    } else {
      res.writeHead(404);
      res.end('Unknown preserved path');
      return;
    }
  }

  const scope = `dash.segment:${alias}:${file}`;
  const periodInfo = aliasEntry.periodId ? { periodId: aliasEntry.periodId, periodStartTime: aliasEntry.periodStartTime } : {};

  if (shouldTrigger(cfg.segment?.missing, `${scope}:missing`)) {
    await delay(latencyMs);
    res.writeHead(404);
    res.end('DASH segment missing (fault injection)');
    logDashEvent('segment', { status: 404, path: pathName, alias, fault: 'missing', ...periodInfo });
    return;
  }
  if (shouldTrigger(cfg.segment?.forbidden, `${scope}:forbidden`)) {
    await delay(latencyMs);
    res.writeHead(403);
    res.end('DASH segment forbidden (fault injection)');
    logDashEvent('segment', { status: 403, path: pathName, alias, fault: 'forbidden', ...periodInfo });
    return;
  }

  let targetPath: string | null = null;
  if (file === 'init.mp4') {
    targetPath = aliasEntry.initializationPath;
  } else {
    const match = file.match(/^segment-(\d+)\.m4s$/);
    if (!match) {
      res.writeHead(404);
      res.end('Unknown segment pattern');
      return;
    }
    const requestedNumber = Number(match[1]);
    const sourceStart = aliasEntry.startNumber ?? 1;
    const originalStart = aliasEntry.originalStartNumber ?? sourceStart;
    let actualNumber = requestedNumber - originalStart + sourceStart;
    if (!Number.isFinite(actualNumber)) {
      actualNumber = sourceStart;
    }
    if (actualNumber < sourceStart) {
      actualNumber = sourceStart;
    }
    const replacements = { ...aliasEntry.replacements };
    const mediaTemplate = aliasEntry.mediaTemplate;
    const timeValue = calculateSegmentTime(aliasEntry, actualNumber);
    const expanded = expandTemplate(mediaTemplate, replacements, {
      Number: actualNumber,
      Time: timeValue
    });
    targetPath = expanded;
  }

  if (!targetPath) {
    res.writeHead(404);
    res.end('Unable to resolve target path');
    return;
  }

  const upstreamUrl = `http://127.0.0.1:${upstreamPort}${targetPath}`;
  const upstream = await fetchUpstream(upstreamUrl, {});
  await delay(latencyMs);
  let body = upstream.body;
  if (shouldTrigger(cfg.segment?.malformed, `${scope}:malformed`)) {
    body = body.subarray(0, Math.max(1, Math.floor(body.length / 4)));
    logDashEvent('segment', { status: upstream.status, path: pathName, alias, fault: 'malformed', bytes: body.length, ...periodInfo });
  }
  res.writeHead(upstream.status, upstream.headers as Record<string, string>);
  res.end(body);
  if (!shouldTrigger(cfg.segment?.malformed, `${scope}:malformed`)) {
    logDashEvent('segment', { status: upstream.status, path: pathName, alias, bytes: body.length, ...periodInfo });
  }
}

function expandTemplate(template: string, replacements: Record<string, string>, values: { Number: number; Time?: number }): string {
  let result = template;
  Object.entries(replacements).forEach(([token, value]) => {
    if (!value) return;
    result = result.replace(new RegExp(`\\$${token}\\$`, 'g'), value);
  });
  result = result.replace(/\$Number(?:(%0(\d+)d))?\$/g, (_match, format, width) => {
    if (!format) return String(values.Number);
    const w = Number(width);
    return String(values.Number).padStart(Number.isFinite(w) ? w : 1, '0');
  });
  result = result.replace(/\$Time\$/g, values.Time !== undefined ? String(values.Time) : String(values.Number));
  return result;
}

function calculateSegmentTime(entry: DashAliasMapEntry, number: number): number {
  const timeline = entry.segmentTimeline;
  const startNumber = entry.startNumber ?? 1;
  if (!timeline || !timeline.length) {
    const duration = timeline && timeline.length ? timeline[0].d : 1;
    return (number - startNumber) * duration;
  }
  let currentNumber = startNumber;
  let currentTime = timeline[0].t ?? 0;
  for (const segment of timeline) {
    const duration = segment.d;
    const repeat = segment.r ?? 0;
    const startTime = segment.t ?? currentTime;
    for (let i = 0; i <= repeat; i++) {
      if (currentNumber === number) {
        return startTime + i * duration;
      }
      currentNumber++;
    }
    currentTime = startTime + (repeat + 1) * duration;
  }
  return currentTime;
}
