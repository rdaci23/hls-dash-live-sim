import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import * as https from 'https';
import * as http from 'http';
import {
  getFaultConfig,
  onFaultConfigChange,
  setFaultConfigPath,
  applyConfigOverride,
  type FaultMode
} from './live-stream-fault-config.js';

function getDockerPath(): string {
  const possiblePaths = [
    'docker',
    '/usr/local/bin/docker',
    '/Applications/Docker.app/Contents/Resources/bin/docker',
    '/opt/homebrew/bin/docker',
  ];
  for (const dockerPath of possiblePaths) {
    try {
      const result = spawnSync(dockerPath, ['--version'], { stdio: 'pipe' });
      if (result.status === 0) return dockerPath;
    } catch { void 0; }
  }
  return 'docker';
}

export interface HLSStartOptions {
  image?: string;
  port?: number;
  vodroot?: string;
  source?: string;
  detach?: boolean;
  name?: string;
  open?: boolean;
  noPull?: boolean;
  forcePull?: boolean;
  manifestUrl?: string;
  proxy?: boolean;
  authToken?: string;
  authHeader?: string;
  authFile?: string;
  dummyContent?: boolean;
  preserveManifest?: boolean;
  faultConfigPath?: string;
  faultProfile?: string;
}

export interface HLSStopOptions { name?: string; }
export interface HLSLogsOptions { name?: string; }

interface HLSInfo {
  url: string;
  targetDuration?: number;
  mediaSequence?: number;
  hasEndList?: boolean;
  firstPdtEpoch?: number;
  scte35?: boolean;
  averageSegDur?: number;
}

interface HlsSampleAssets {
  master: string;
  variant: string;
  audio?: string;
  segments: Map<string, { buffer: Buffer; contentType: string }>;
}

interface ParsedMasterData {
  versionLine?: string;
  independentLine?: string;
  sessionKeys: string[];
  otherLines: string[];
  mediaEntries: Array<{ rawLine: string; groupId?: string }>;
  variantEntries: Array<{ infoLine: string; audioGroup?: string }>;
}

interface DummyManifestData {
  master: string;
  variantMap: Map<string, string>;
  mediaMap: Map<string, string>;
  segments: Map<string, { buffer: Buffer; contentType: string }>;
}

let cachedSampleAssets: HlsSampleAssets | null = null;

let faultConfig = getFaultConfig();
const randomDecisions = new Map<string, boolean>();
const onceTriggers = new Set<string>();

onFaultConfigChange(config => {
  faultConfig = config;
  randomDecisions.clear();
  onceTriggers.clear();
  logHlsEvent('config-update', {
    segment: config.segment,
    manifest: config.manifest,
    drm: config.drm,
    logging: config.logging
  });
});

const RANDOM_THRESHOLD = 0.4;

function shouldTriggerFault(mode: FaultMode | undefined, key: string): boolean {
  if (!mode || mode === 'off') return false;
  if (mode === 'always') return true;
  if (mode === 'once') {
    if (onceTriggers.has(key)) return false;
    onceTriggers.add(key);
    return true;
  }
  if (mode === 'random') {
    if (!randomDecisions.has(key)) {
      randomDecisions.set(key, Math.random() < RANDOM_THRESHOLD);
    }
    return randomDecisions.get(key) ?? false;
  }
  return false;
}

function delay(ms: number | undefined): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logHlsEvent(event: string, details: Record<string, unknown>): void {
  const payload = {
    timestamp: new Date().toISOString(),
    event,
    ...details
  };
  console.info(`[hls] ${JSON.stringify(payload)}`);
}

function resolveSampleAssetPath(fileName: string): string {
  const candidates = [
    path.resolve(__dirname, 'assets', 'hls-sample', fileName),
    path.resolve(__dirname, '../assets', 'hls-sample', fileName),
    path.resolve(__dirname, '../../assets/hls-sample', fileName),
    path.resolve(__dirname, '../../src/support-tools/assets/hls-sample', fileName),
    path.resolve(process.cwd(), 'assets/hls-sample', fileName),
    path.resolve(process.cwd(), 'src/support-tools/assets/hls-sample', fileName)
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function getSampleAssets(): HlsSampleAssets {
  if (cachedSampleAssets) {
    return cachedSampleAssets;
  }

  const masterPath = resolveSampleAssetPath('master.m3u8');
  const variantPath = resolveSampleAssetPath('variant.m3u8');
  const audioPath = resolveSampleAssetPath('audio.m3u8');

  if (!fs.existsSync(masterPath) || !fs.existsSync(variantPath)) {
    throw new Error('Bundled HLS sample assets missing. Expected master.m3u8 and variant.m3u8.');
  }

  const rootDir = path.dirname(masterPath);
  const segments = new Map<string, { buffer: Buffer; contentType: string }>();

  const collectSegments = (currentDir: string, relativePrefix = ''): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        collectSegments(fullPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.m3u8')) continue; // handled separately
      let contentType = 'application/octet-stream';
      if (lower.endsWith('.ts') || lower.endsWith('.m2t') || lower.endsWith('.m2ts')) {
        contentType = 'video/mp2t';
      } else if (lower.endsWith('.aac')) {
        contentType = 'audio/aac';
      } else if (lower.endsWith('.m4s') || lower.endsWith('.mp4')) {
        contentType = 'video/mp4';
      }
      const buffer = fs.readFileSync(fullPath);
      segments.set(relPath.replace(/\\/g, '/'), { buffer, contentType });
    }
  };

  collectSegments(rootDir);

  if (segments.size === 0) {
    throw new Error('Bundled HLS sample assets missing segment files.');
  }

  cachedSampleAssets = {
    master: fs.readFileSync(masterPath, 'utf8'),
    variant: fs.readFileSync(variantPath, 'utf8'),
    audio: fs.existsSync(audioPath) ? fs.readFileSync(audioPath, 'utf8') : undefined,
    segments
  };

  return cachedSampleAssets;
}

function extractAttribute(line: string, key: string): string | undefined {
  const regex = new RegExp(`${key}="([^"\\\\]*)"`);
  const match = line.match(regex);
  return match ? match[1] : undefined;
}

function setOrAppendAttribute(line: string, key: string, value: string): string {
  const attribute = `${key}="`;
  if (line.includes(attribute)) {
    const regex = new RegExp(`${key}="[^"\\\\]*"`);
    return line.replace(regex, `${key}="${value}"`);
  }
  if (!line.includes(':')) {
    return `${line}:${key}="${value}"`;
  }
  return `${line},${key}="${value}"`;
}

function parsePlaylistSegments(base: string): Array<{ duration: number; uri: string }> {
  const lines = base.split(/\r?\n/);
  const segments: Array<{ duration: number; uri: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.startsWith('#EXTINF')) continue;
    const durationPart = line.split(':')[1] ?? '0';
    const duration = Number.parseFloat(durationPart.replace(/,$/, ''));
    let uri = '';
    let j = i + 1;
    while (j < lines.length) {
      const candidate = lines[j].trim();
      if (candidate === '') {
        j++;
        continue;
      }
      if (!candidate.startsWith('#')) {
        uri = candidate;
      }
      break;
    }
    if (!uri) {
      uri = `segment_${segments.length}.ts`;
    }
    segments.push({ duration: Number.isFinite(duration) && duration > 0 ? duration : 6, uri });
    i = j;
  }
  return segments;
}

function buildLoopingPlaylist(base: string, loops = 30, segmentBase?: string): string {
  const segments = parsePlaylistSegments(base);
  if (segments.length === 0) {
    return base;
  }
  const maxDuration = Math.max(...segments.map(segment => segment.duration));
  const header = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-INDEPENDENT-SEGMENTS'
  ];
  const body: string[] = [];
  for (let loop = 0; loop < loops; loop++) {
    for (const segment of segments) {
      body.push(`#EXTINF:${segment.duration.toFixed(6)},`);
      let targetUri = segment.uri;
      if (segmentBase) {
        const cleanedBase = segmentBase.endsWith('/') ? segmentBase.slice(0, -1) : segmentBase;
        const fileName = segment.uri.split('/').pop() ?? segment.uri;
        targetUri = `${cleanedBase}/${fileName}`;
        if (!targetUri.startsWith('/')) {
          targetUri = `/${targetUri}`;
        }
      }
      body.push(targetUri);
    }
  }
  body.push('#EXT-X-ENDLIST');
  return [...header, ...body].join('\n');
}

function parseMasterManifest(content: string): ParsedMasterData {
  const lines = content.split(/\r?\n/);
  const parsed: ParsedMasterData = {
    sessionKeys: [],
    otherLines: [],
    mediaEntries: [],
    variantEntries: []
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (line === '#EXTM3U') continue;
    if (line.startsWith('#EXT-X-VERSION') && !parsed.versionLine) {
      parsed.versionLine = line;
      continue;
    }
    if (line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS')) {
      parsed.independentLine = line;
      continue;
    }
    if (line.startsWith('#EXT-X-SESSION-KEY')) {
      parsed.sessionKeys.push(line);
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA')) {
      parsed.mediaEntries.push({ rawLine: line, groupId: extractAttribute(line, 'GROUP-ID') });
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      parsed.variantEntries.push({ infoLine: line, audioGroup: extractAttribute(line, 'AUDIO') });
      // Skip following URI
      let j = i + 1;
      while (j < lines.length) {
        const candidate = lines[j].trim();
        if (candidate === '') {
          j++;
          continue;
        }
        if (!candidate.startsWith('#')) {
          i = j;
        }
        break;
      }
      continue;
    }
    if (line.startsWith('#')) {
      parsed.otherLines.push(line);
      continue;
    }
  }

  return parsed;
}

function buildManifestFromParsed(parsed: ParsedMasterData, variantLoop: string, audioLoop?: string): { master: string; variantMap: Map<string, string>; mediaMap: Map<string, string> } {
  const masterLines: string[] = ['#EXTM3U'];
  masterLines.push(parsed.versionLine ?? '#EXT-X-VERSION:6');
  masterLines.push(parsed.independentLine ?? '#EXT-X-INDEPENDENT-SEGMENTS');

  const skipDirectives = new Set(['#EXT-X-VERSION', '#EXT-X-INDEPENDENT-SEGMENTS']);
  for (const line of parsed.otherLines) {
    if (skipDirectives.has(line.split(':')[0])) continue;
    masterLines.push(line);
  }

  for (const session of parsed.sessionKeys) {
    masterLines.push(session);
  }

  const mediaMap = new Map<string, string>();
  const audioGroupUris = new Map<string, string>();

  if (audioLoop) {
    const mediaEntries = parsed.mediaEntries.length > 0 ? parsed.mediaEntries : [];
    const referencedGroups = new Set(parsed.variantEntries.map(entry => entry.audioGroup).filter((id): id is string => Boolean(id)));
    if (mediaEntries.length === 0 && referencedGroups.size > 0) {
      for (const groupId of referencedGroups) {
        mediaEntries.push({ rawLine: `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${groupId}",NAME="${groupId}",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en"`, groupId });
      }
    }
    if (mediaEntries.length === 0) {
      mediaEntries.push({ rawLine: '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-main",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en"', groupId: 'audio-main' });
    }
    mediaEntries.forEach((entry, index) => {
      const groupId = entry.groupId ?? `audio-${index}`;
      const isClosedCaption = /TYPE=CLOSED-CAPTIONS/.test(entry.rawLine);
      let updatedLine = setOrAppendAttribute(entry.rawLine, 'GROUP-ID', groupId);
      if (!isClosedCaption) {
        const uriRelative = `dummy/media/${groupId}.m3u8`;
        updatedLine = setOrAppendAttribute(updatedLine, 'URI', uriRelative);
        mediaMap.set(`/dummy/media/${groupId}.m3u8`, audioLoop);
        audioGroupUris.set(groupId, uriRelative);
      }
      masterLines.push(updatedLine);
    });
  }

  const variantMap = new Map<string, string>();
  const variantEntries = parsed.variantEntries.length > 0 ? parsed.variantEntries : [{ infoLine: '#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=24.000', audioGroup: audioLoop ? (parsed.mediaEntries[0]?.groupId ?? 'audio-main') : undefined }];

  variantEntries.forEach((entry, index) => {
    let streamLine = entry.infoLine;
    if (audioLoop) {
      const groups = Array.from(audioGroupUris.keys());
      const targetGroup = entry.audioGroup && audioGroupUris.has(entry.audioGroup)
        ? entry.audioGroup
        : (groups[index % (groups.length || 1)] ?? 'audio-main');
      streamLine = setOrAppendAttribute(streamLine.replace(/,?\s*AUDIO="[^"\\]*"/g, ''), 'AUDIO', targetGroup);
    } else {
      streamLine = streamLine.replace(/,?\s*AUDIO="[^"\\]*"/g, '');
    }
    masterLines.push(streamLine);
    const variantRelative = `dummy/variant/${index}.m3u8`;
    masterLines.push(variantRelative);
    variantMap.set(`/dummy/variant/${index}.m3u8`, variantLoop);
  });

  return {
    master: masterLines.join('\n'),
    variantMap,
    mediaMap
  };
}

async function buildDummyManifestData(sampleAssets: HlsSampleAssets, options: { manifestUrl?: string; auth?: { token?: string; header?: string; file?: string }; preserve: boolean }): Promise<DummyManifestData> {
  const targetSeconds = 10 * 60;
  const variantSegments = parsePlaylistSegments(sampleAssets.variant);
  const variantCycleDuration = variantSegments.reduce((sum, segment) => sum + segment.duration, 0);
  const audioSegments = sampleAssets.audio ? parsePlaylistSegments(sampleAssets.audio) : undefined;
  const audioCycleDuration = audioSegments?.reduce((sum, segment) => sum + segment.duration, 0) ?? 0;
  const longestCycle = Math.max(variantCycleDuration, audioCycleDuration, 0.1);
  const loops = Math.max(1, Math.ceil(targetSeconds / longestCycle));
  const segmentBase = 'dummy/segments';
  const variantLoop = buildLoopingPlaylist(sampleAssets.variant, loops, segmentBase);
  const audioLoop = sampleAssets.audio ? buildLoopingPlaylist(sampleAssets.audio, loops, segmentBase) : undefined;

  let parsed: ParsedMasterData | null = null;
  if (options.manifestUrl && options.preserve) {
    try {
      const source = await fetchHLS(options.manifestUrl, options.auth);
      parsed = parseMasterManifest(source);
    } catch (err) {
      console.info('Failed to preserve source manifest structure, falling back to bundled sample manifest.', err);
    }
  }

  if (!parsed) {
    parsed = parseMasterManifest(sampleAssets.master);
  }

  const manifestCore = buildManifestFromParsed(parsed, variantLoop, audioLoop);

  const segmentMap = new Map<string, { buffer: Buffer; contentType: string }>();
  sampleAssets.segments.forEach((value, key) => {
    const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
    const fullPath = `/dummy/${normalized}`;
    segmentMap.set(fullPath, value);
  });

  // Provide legacy aliases for sample access
  const firstVariant = manifestCore.variantMap.keys().next().value as string | undefined;
  if (firstVariant) {
    manifestCore.variantMap.set('/variant.m3u8', manifestCore.variantMap.get(firstVariant)!);
  }
  if (audioLoop) {
    const firstMedia = manifestCore.mediaMap.keys().next().value as string | undefined;
    if (firstMedia) {
      manifestCore.mediaMap.set('/audio.m3u8', manifestCore.mediaMap.get(firstMedia)!);
    }
  }

  return {
    master: manifestCore.master,
    variantMap: manifestCore.variantMap,
    mediaMap: manifestCore.mediaMap,
    segments: segmentMap
  };
}

function fetchHLS(url: string, authOptions?: { token?: string; header?: string; file?: string; }): Promise<string> {
  return new Promise((resolve, reject) => {
    let processedUrl = url;
    if (processedUrl.includes('\\')) {
      processedUrl = processedUrl.replace(/\\([()&?=])/g, '$1');
    }
    const client = processedUrl.startsWith('https:') ? https : http;
    const headers: Record<string, string> = { 'Accept': '*/*', 'User-Agent': 'curl/7.88.1' };
    if (authOptions?.token) headers['Authorization'] = `Bearer ${authOptions.token}`;
    else if (authOptions?.header) {
      const [key, value] = authOptions.header.split(': ', 2);
      if (key && value) headers[key.trim()] = value.trim();
    } else if (authOptions?.file) {
      try {
        const data = JSON.parse(fs.readFileSync(authOptions.file, 'utf8')) as Record<string, string>;
        Object.assign(headers, data);
      } catch {
        reject(new Error(`Failed to read auth file: ${authOptions.file}`));
        return;
      }
    }
    const req = client.get(processedUrl, { headers }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200 && data.startsWith('#EXTM3U')) resolve(data);
        else reject(new Error(`HLS fetch failed: ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
  });
}

function parseHLS(text: string, url: string): HLSInfo {
  const info: HLSInfo = { url };
  const lines = text.split(/\r?\n/);
  let segDurSum = 0; let segDurCount = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) info.targetDuration = parseFloat(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) info.mediaSequence = parseInt(line.split(':')[1], 10);
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const ts = Date.parse(line.substring(line.indexOf(':') + 1).trim());
      if (!Number.isNaN(ts) && info.firstPdtEpoch == null) info.firstPdtEpoch = Math.floor(ts / 1000);
    } else if (line.startsWith('#EXT-X-ENDLIST')) info.hasEndList = true;
    else if (line.startsWith('#EXT-X-DATERANGE:') || line.startsWith('#EXT-OATCLS-SCTE35')) info.scte35 = true;
    else if (line.startsWith('#EXTINF:')) {
      const dur = parseFloat(line.split(':')[1]);
      if (!Number.isNaN(dur)) { segDurSum += dur; segDurCount++; }
    }
  }
  if (segDurCount > 0) info.averageSegDur = segDurSum / segDurCount;
  return info;
}

function checkDocker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const docker = spawn(getDockerPath(), ['--version'], { stdio: 'pipe' });
    docker.on('close', code => { if (code === 0) resolve(); else reject(new Error('Docker not available')); });
  });
}

function checkImageExists(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    const docker = spawn(getDockerPath(), ['images', '-q', image], { stdio: 'pipe' });
    let out = '';
    docker.stdout.on('data', (c) => { out += String(c).trim(); });
    docker.on('close', (code) => { resolve(code === 0 && out.length > 0); });
    docker.on('error', () => resolve(false));
  });
}

function pullImageCached(image: string, forcePull = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const doPull = () => {
      const d = spawn(getDockerPath(), ['pull', image], { stdio: 'inherit' });
      d.on('close', code => { if (code === 0) resolve(); else reject(new Error(`Failed to pull ${image}`)); });
    };
    if (!forcePull) {
      checkImageExists(image).then(exists => { if (exists) { console.info(`Using cached Docker image: ${image}`); resolve(); } else doPull(); }).catch(() => doPull());
    } else doPull();
  });
}

function runDocker(args: string[], detached = false): Promise<string | void> {
  return new Promise((resolve, reject) => {
    const docker = spawn(getDockerPath(), args, { stdio: detached ? 'pipe' : 'inherit', detached });
    let id = ''; let err = '';
    if (detached) {
      docker.stdout?.on('data', c => { id += String(c).trim(); });
      docker.stderr?.on('data', c => { err += String(c); });
    }
    docker.on('close', code => { if (code === 0) resolve(detached ? id : undefined); else reject(new Error(err || 'Docker failed')); });
  });
}

function getLanRootUrl(port: number): string | undefined {
  const nets = os.networkInterfaces();
  const candidates: string[] = [];
  Object.values(nets).forEach(list => {
    (list || []).forEach(ni => {
      const fam = (ni as unknown as { family: string | number }).family;
      const famStr = typeof fam === 'number' ? String(fam) : fam;
      if ((famStr === 'IPv4' || famStr === '4') && !ni.internal && ni.address) candidates.push(ni.address);
    });
  });
  const ip = candidates.find(a => a.startsWith('192.168.')) || candidates.find(a => a.startsWith('10.')) || candidates.find(a => a.startsWith('172.')) || candidates[0];
  return ip ? `http://${ip}:${port}/` : undefined;
}

function buildVodM3u8(port: number, sourceRelPath: string): string {
  const cleaned = sourceRelPath.replace(/^\//, '');
  return `http://localhost:${port}/vod/${cleaned}/index.m3u8`;
}

function generateHlsUrlForBase(baseUrl: string, hls: HLSInfo): string {
  const params = new URLSearchParams();
  if (hls.averageSegDur) params.set('hls_time', String(hls.averageSegDur));
  if (!hls.hasEndList) {
    const now = Math.floor(Date.now() / 1000);
    const fallbackWindow = Math.max(30, Math.floor((hls.mediaSequence || 0) * (hls.targetDuration || 6)));
    const startEpoch = hls.firstPdtEpoch ?? (now - fallbackWindow);
    params.set('start', String(startEpoch));
  }
  const q = params.toString();
  return q ? `${baseUrl}?${q}` : baseUrl;
}

function logCopy(url: string): void {
  const b = '\x1b[1m', g = '\x1b[32m', c = '\x1b[36m', r = '\x1b[0m';
  console.info(`  ${b}${g}Copy into Roku:${r} ${b}${c}${url}${r}`);
}

function absUrl(base: string, ref: string): string {
  try { return new URL(ref, base).toString(); } catch { return ref; }
}

function rewriteM3U8(content: string, base: string): string {
  return content.split(/\r?\n/).map(line => {
    if (line.startsWith('#EXT-X-KEY:')) {
      return line.replace(/URI="([^"]+)"/, (_m, u) => `URI="/key?u=${encodeURIComponent(absUrl(base, u))}"`);
    }
    if (line.startsWith('#') || line.trim() === '') return line;
    const resolved = absUrl(base, line.trim());
    return resolved.toLowerCase().endsWith('.m3u8')
      ? `/pl?u=${encodeURIComponent(resolved)}`
      : `/seg?u=${encodeURIComponent(resolved)}`;
  }).join('\n');
}

function startHlsProxyServer(
  port: number,
  manifestUrl?: string,
  auth?: { token?: string; header?: string; file?: string; },
  options?: { dummyContent?: boolean; preserveManifest?: boolean }
): Promise<string> {
  const dummyMode = options?.dummyContent ?? false;
  const sampleAssets = dummyMode ? getSampleAssets() : undefined;
  let frozenManifest: string | null = null;
  let cachedRemoteManifest: string | null = null;

  return new Promise((resolve, reject) => {
    let manifestDataPromise: Promise<DummyManifestData | null> | null = null;
    if (dummyMode && sampleAssets) {
      manifestDataPromise = buildDummyManifestData(sampleAssets, {
        manifestUrl,
        auth,
        preserve: options?.preserveManifest ?? true
      }).catch(err => {
        console.error('Failed to build dummy manifest data:', err);
        return null;
      });
    }

    const server = http.createServer(async (req, res) => {
      try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
        const configSnapshot = faultConfig;
        const latencyMs = configSnapshot.segment?.latencyMs ?? 0;
        const pathName = reqUrl.pathname;
        if (configSnapshot.logging?.verbose) {
          logHlsEvent('config-active', {
            path: pathName,
            segment: configSnapshot.segment,
            manifest: configSnapshot.manifest,
            drm: configSnapshot.drm,
            latencyMs
          });
        }

        if (dummyMode && sampleAssets) {
          const manifestData = manifestDataPromise ? await manifestDataPromise : null;
          if (manifestData) {
            if (pathName === '/proxy.m3u8') {
              const freeze = shouldTriggerFault(configSnapshot.manifest?.freeze, 'manifest.freeze');
              const manifestBody = freeze ? (frozenManifest ?? manifestData.master) : manifestData.master;
              if (freeze && !frozenManifest) frozenManifest = manifestData.master;
              if (!freeze) frozenManifest = null;
              await delay(latencyMs);
              res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
              res.end(manifestBody);
              logHlsEvent('manifest', { status: 200, path: pathName, freeze, source: 'dummy' });
              return;
            }
            if (manifestData.variantMap.has(pathName)) {
              await delay(latencyMs);
              res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
              res.end(manifestData.variantMap.get(pathName));
              logHlsEvent('variant', { status: 200, path: pathName, source: 'dummy' });
              return;
            }
            if (manifestData.mediaMap.has(pathName)) {
              await delay(latencyMs);
              res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
              res.end(manifestData.mediaMap.get(pathName));
              logHlsEvent('media', { status: 200, path: pathName, source: 'dummy' });
              return;
            }
            const segmentEntry = manifestData.segments.get(pathName);
            if (segmentEntry) {
              const scopeBase = `dummy:${pathName}`;
              if (shouldTriggerFault(configSnapshot.segment?.missing, `${scopeBase}:missing`)) {
                await delay(latencyMs);
                res.writeHead(404);
                res.end('Segment missing (fault injection)');
                logHlsEvent('segment', { status: 404, path: pathName, fault: 'missing', source: 'dummy' });
                return;
              }
              if (shouldTriggerFault(configSnapshot.segment?.forbidden, `${scopeBase}:forbidden`)) {
                await delay(latencyMs);
                res.writeHead(403);
                res.end('Forbidden segment (fault injection)');
                logHlsEvent('segment', { status: 403, path: pathName, fault: 'forbidden', source: 'dummy' });
                return;
              }
              await delay(latencyMs);
              if (shouldTriggerFault(configSnapshot.segment?.malformed, `${scopeBase}:malformed`)) {
                const corrupted = segmentEntry.buffer.subarray(0, Math.max(1, Math.floor(segmentEntry.buffer.length / 3)));
                res.writeHead(200, { 'Content-Type': segmentEntry.contentType });
                res.end(corrupted);
                logHlsEvent('segment', { status: 200, path: pathName, fault: 'malformed', bytes: corrupted.length, source: 'dummy' });
                return;
              }
              res.writeHead(200, { 'Content-Type': segmentEntry.contentType });
              res.end(segmentEntry.buffer);
              logHlsEvent('segment', { status: 200, path: pathName, bytes: segmentEntry.buffer.length, source: 'dummy' });
              return;
            }
          } else {
            if (pathName === '/proxy.m3u8') {
              await delay(latencyMs);
              res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
              res.end(sampleAssets.master);
              logHlsEvent('manifest', { status: 200, path: pathName, source: 'dummy-fallback' });
              return;
            }
            if (pathName === '/variant.m3u8') {
              await delay(latencyMs);
              res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
              res.end(sampleAssets.variant);
              logHlsEvent('variant', { status: 200, path: pathName, source: 'dummy-fallback' });
              return;
            }
            const legacyKey = pathName.startsWith('/') ? pathName.slice(1) : pathName;
            if (legacyKey && sampleAssets.segments.has(legacyKey)) {
              const segment = sampleAssets.segments.get(legacyKey)!;
              await delay(latencyMs);
              res.writeHead(200, { 'Content-Type': segment.contentType });
              res.end(segment.buffer);
              logHlsEvent('segment', { status: 200, path: pathName, bytes: segment.buffer.length, source: 'dummy-fallback' });
              return;
            }
          }
        }

        if (!manifestUrl) {
          res.writeHead(404);
          res.end('No manifest configured');
          logHlsEvent('error', { status: 404, path: pathName, reason: 'no-manifest' });
          return;
        }

        if (pathName === '/proxy.m3u8') {
          const freeze = shouldTriggerFault(configSnapshot.manifest?.freeze, 'manifest.freeze');
          let upstream = cachedRemoteManifest;
          if (!freeze || !cachedRemoteManifest) {
            upstream = await fetchHLS(manifestUrl, auth);
            cachedRemoteManifest = upstream;
          }
          const rewritten = rewriteM3U8(upstream!, manifestUrl);
          await delay(latencyMs);
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
          res.end(rewritten);
          logHlsEvent('manifest', { status: 200, path: pathName, freeze, source: 'remote' });
          return;
        }
        if (pathName === '/pl') {
          const target = reqUrl.searchParams.get('u');
          if (!target) { res.writeHead(400); res.end('Missing u'); logHlsEvent('error', { status: 400, path: pathName, reason: 'missing-target' }); return; }
          const text = await fetchHLS(target, auth);
          const rewritten = rewriteM3U8(text, target);
          await delay(latencyMs);
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
          res.end(rewritten);
          logHlsEvent('playlist', { status: 200, path: pathName, target, source: 'remote' });
          return;
        }
        if (pathName === '/seg') {
          const target = reqUrl.searchParams.get('u');
          if (!target) { res.writeHead(400); res.end('Missing u'); logHlsEvent('error', { status: 400, path: pathName, reason: 'missing-target' }); return; }
          const client = target.startsWith('https:') ? https : http;
          const headers: Record<string, string> = {};
          const range = req.headers['range']; if (range) headers['Range'] = String(range);
          if (auth?.token) headers['Authorization'] = `Bearer ${auth.token}`;
          else if (auth?.header) {
            const [k, v] = auth.header.split(': ', 2); if (k && v) headers[k.trim()] = v.trim();
          } else if (auth?.file) {
            try { const data = JSON.parse(fs.readFileSync(auth.file, 'utf8')) as Record<string, string>; Object.assign(headers, data); } catch { void 0; }
          }
          const scopeBase = `segment:${target}`;
          if (shouldTriggerFault(configSnapshot.segment?.missing, `${scopeBase}:missing`)) {
            await delay(latencyMs);
            res.writeHead(404);
            res.end('Segment missing (fault injection)');
            logHlsEvent('segment', { status: 404, path: pathName, target, fault: 'missing', source: 'remote' });
            return;
          }
          if (shouldTriggerFault(configSnapshot.segment?.forbidden, `${scopeBase}:forbidden`)) {
            await delay(latencyMs);
            res.writeHead(403);
            res.end('Forbidden segment (fault injection)');
            logHlsEvent('segment', { status: 403, path: pathName, target, fault: 'forbidden', source: 'remote' });
            return;
          }
          client.get(target, { headers }, (prox) => {
            const statusCode = prox.statusCode || 200;
            const chunks: Buffer[] = [];
            res.writeHead(statusCode, prox.headers as Record<string, string>);
            prox.on('data', chunk => {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              chunks.push(buf);
            });
            prox.on('end', async () => {
              await delay(latencyMs);
              let payload = Buffer.concat(chunks);
              if (shouldTriggerFault(configSnapshot.segment?.malformed, `${scopeBase}:malformed`)) {
                payload = payload.subarray(0, Math.max(1, Math.floor(payload.length / 4)));
                logHlsEvent('segment', { status: statusCode, path: pathName, target, fault: 'malformed', bytes: payload.length, source: 'remote' });
              } else {
                logHlsEvent('segment', { status: statusCode, path: pathName, target, bytes: payload.length, source: 'remote' });
              }
              res.end(payload);
            });
          }).on('error', () => {
            res.writeHead(502);
            res.end('Bad Gateway');
            logHlsEvent('segment', { status: 502, path: pathName, target, fault: 'proxy-error', source: 'remote' });
          });
          return;
        }

        if (pathName === '/key') {
          const target = reqUrl.searchParams.get('u');
          if (!target) { res.writeHead(400); res.end('Missing u'); logHlsEvent('error', { status: 400, path: pathName, reason: 'missing-target' }); return; }
          if (shouldTriggerFault(configSnapshot.drm?.licenseFailure, `key:${target}:license`)) {
            await delay(latencyMs);
            res.writeHead(403);
            res.end('License failure (fault injection)');
            logHlsEvent('key', { status: 403, path: pathName, target, fault: 'licenseFailure' });
            return;
          }
          const client = target.startsWith('https:') ? https : http;
          const headers: Record<string, string> = {};
          if (auth?.token) headers['Authorization'] = `Bearer ${auth.token}`;
          else if (auth?.header) {
            const [k, v] = auth.header.split(': ', 2); if (k && v) headers[k.trim()] = v.trim();
          } else if (auth?.file) {
            try { const data = JSON.parse(fs.readFileSync(auth.file, 'utf8')) as Record<string, string>; Object.assign(headers, data); } catch { void 0; }
          }
          client.get(target, { headers }, (prox) => {
            const statusCode = prox.statusCode || 200;
            const chunks: Buffer[] = [];
            res.writeHead(statusCode, prox.headers as Record<string, string>);
            prox.on('data', chunk => {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              chunks.push(buf);
            });
            prox.on('end', async () => {
              await delay(latencyMs);
              let payload = Buffer.concat(chunks);
              if (shouldTriggerFault(configSnapshot.drm?.keyRotationMismatch, `key:${target}:mismatch`)) {
                payload = Buffer.alloc(16, 0xff);
                logHlsEvent('key', { status: statusCode, path: pathName, target, fault: 'keyRotationMismatch', bytes: payload.length });
              } else {
                logHlsEvent('key', { status: statusCode, path: pathName, target, bytes: payload.length });
              }
              res.end(payload);
            });
          }).on('error', () => {
            res.writeHead(502);
            res.end('Bad Gateway');
            logHlsEvent('key', { status: 502, path: pathName, target, fault: 'proxy-error' });
          });
          return;
        }

        res.writeHead(404);
        res.end('Not found');
        logHlsEvent('error', { status: 404, path: pathName, reason: 'not-found' });
      } catch (err) {
        res.writeHead(500);
        res.end(`Internal Error: ${(err as Error).message}`);
        logHlsEvent('error', { status: 500, path: req?.url ?? 'unknown', reason: (err as Error).message });
      }
    });
    server.listen(port, () => resolve(`http://localhost:${port}/proxy.m3u8`));
    server.on('error', reject);
  });
}

export async function startHlsim(options: HLSStartOptions = {}): Promise<void> {
  const {
    image = 'kaltura/nginx-vod-module:latest',
    port = 8899,
    vodroot,
    source,
    detach = false,
    name = 'hls-dash-hlsim',
    open = false,
    noPull = false,
    forcePull = false,
    manifestUrl,
    proxy = true,
    authToken,
    authHeader,
    authFile,
    dummyContent = true,
    preserveManifest = true,
    faultConfigPath,
    faultProfile
  } = options;

  const configPathOverride = faultConfigPath ?? process.env.HLS_FAULT_CONFIG;
  if (configPathOverride) {
    setFaultConfigPath(configPathOverride);
  }
  const profileOverride = faultProfile ?? process.env.HLS_FAULT_PROFILE;
  if (profileOverride) {
    applyConfigOverride({ profile: profileOverride });
  }

  if (proxy && !dummyContent && !manifestUrl) {
    throw new Error('Proxy mode with real origin requires --manifest-url when dummy-content is disabled.');
  }

  // Docker is only needed when running in VoD mode
  if (!proxy) {
    await checkDocker();
    if (!noPull) await pullImageCached(image, forcePull);
  }

  let hlsInfo: HLSInfo | undefined;
  if (manifestUrl) {
    const text = await fetchHLS(manifestUrl, { token: authToken, header: authHeader, file: authFile });
    hlsInfo = parseHLS(text, manifestUrl);
  }

  const args: string[] = ['run', '--name', name, '-p', `${port}:80`, '--rm'];
  if (detach) args.push('-d');
  if (vodroot) {
    const abs = path.resolve(vodroot);
    if (!fs.existsSync(abs)) throw new Error(`VoD root directory does not exist: ${abs}`);
    args.push('-v', `${abs}:/vod:ro`);
  }
  args.push(image);

  // Proxy mode branch
  if (proxy) {
    console.info(`Starting HLS proxy on port ${port}...`);
    if (dummyContent) {
      console.info('Serving bundled HLS sample assets (dummy media segments).');
    }
    const localManifest = await startHlsProxyServer(
      port,
      manifestUrl,
      { token: authToken, header: authHeader, file: authFile },
      { dummyContent, preserveManifest }
    );
    const lan = getLanRootUrl(port);
    const localhostUrl = hlsInfo ? generateHlsUrlForBase(localManifest, hlsInfo) : localManifest;
    console.info(`Stream URL (localhost): ${localhostUrl}`);
    if (lan) {
      const lanM3u8 = `${lan.replace(/\/$/, '')}/proxy.m3u8`;
      const lanUrl = hlsInfo ? generateHlsUrlForBase(lanM3u8, hlsInfo) : lanM3u8;
      console.info(`Stream URL (LAN, for Roku): ${lanUrl}`);
      logCopy(lanUrl);
    }
    if (hlsInfo) {
      console.info(`  Extracted from HLS:`);
      if (hlsInfo.targetDuration) console.info(`    targetDuration=${hlsInfo.targetDuration}`);
      if (hlsInfo.mediaSequence != null) console.info(`    mediaSequence=${hlsInfo.mediaSequence}`);
      if (hlsInfo.averageSegDur) console.info(`    avgSegDur=${hlsInfo.averageSegDur}`);
      if (hlsInfo.firstPdtEpoch) console.info(`    firstPDT=${hlsInfo.firstPdtEpoch}`);
      if (!hlsInfo.hasEndList) console.info(`    liveLike=true`);
      if (hlsInfo.scte35) console.info(`    scte35=1`);
    }
    if (open) {
      const opener = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'start' : 'xdg-open');
      spawn(opener, [localManifest], { stdio: 'ignore', detached: true });
    }
    return;
  }

  console.info(`Starting new HLS sim container: ${name}`);
  console.info(`URL: http://localhost:${port}/`);
  const lan = getLanRootUrl(port);
  if (lan) console.info(`LAN URL (use on Roku): ${lan}`);

  if (source) {
    const localhostBase = buildVodM3u8(port, source);
    const localhostUrl = hlsInfo ? generateHlsUrlForBase(localhostBase, hlsInfo) : localhostBase;
    console.info(`Stream URL (localhost): ${localhostUrl}`);
    if (lan) {
      const cleaned = source.replace(/^\//, '');
      const lanBase = `${lan}vod/${cleaned}/index.m3u8`;
      const lanUrl = hlsInfo ? generateHlsUrlForBase(lanBase, hlsInfo) : lanBase;
      console.info(`Stream URL (LAN, for Roku): ${lanUrl}`);
      logCopy(lanUrl);
    }
    if (hlsInfo) {
      console.info(`  Extracted from HLS:`);
      if (hlsInfo.targetDuration) console.info(`    targetDuration=${hlsInfo.targetDuration}`);
      if (hlsInfo.mediaSequence != null) console.info(`    mediaSequence=${hlsInfo.mediaSequence}`);
      if (hlsInfo.averageSegDur) console.info(`    avgSegDur=${hlsInfo.averageSegDur}`);
      if (hlsInfo.firstPdtEpoch) console.info(`    firstPDT=${hlsInfo.firstPdtEpoch}`);
      if (!hlsInfo.hasEndList) console.info(`    liveLike=true`);
      if (hlsInfo.scte35) console.info(`    scte35=1`);
    }
  } else {
    console.info(`Provide --source <relative-mp4-under-vodroot> to build a stream URL`);
  }

  const result = await runDocker(args, detach);
  if (detach && result) console.info(`Container started in background: ${result.trim()}`);
  if (open) {
    const opener = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'start' : 'xdg-open');
    spawn(opener, [`http://localhost:${port}/`], { stdio: 'ignore', detached: true });
  }
}

export async function stopHlsim(options: HLSStopOptions = {}): Promise<void> {
  const { name = 'hls-dash-hlsim' } = options;
  try {
    await runDocker(['stop', name]);
    console.info(`Container stopped: ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/No such container/i.test(message)) {
      console.info(`Container ${name} is not running (nothing to stop).`);
      return;
    }
    throw err;
  }
}

export async function logsHlsim(options: HLSLogsOptions = {}): Promise<void> {
  const { name = 'hls-dash-hlsim' } = options;
  await runDocker(['logs', '-f', name]);
}
