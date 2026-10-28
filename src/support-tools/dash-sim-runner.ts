import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import * as https from 'https';
import * as http from 'http';
import * as net from 'net';
import { startDashFaultProxy, type DashFaultProxy, type DashFaultProxyOptions, type DashAliasMapEntry } from './dash-fault-proxy.js';
import { setFaultConfigPath, applyConfigOverride, getFaultConfig } from './live-stream-fault-config.js';

function getDockerPath(): string {
  // Try common Docker installation paths
  const possiblePaths = [
    'docker', // In PATH
    '/usr/local/bin/docker', // macOS/Homebrew
    '/Applications/Docker.app/Contents/Resources/bin/docker', // macOS Docker Desktop
    '/opt/homebrew/bin/docker', // macOS Homebrew Apple Silicon
  ];

  for (const dockerPath of possiblePaths) {
    try {
      const result = spawnSync(dockerPath, ['--version'], { stdio: 'pipe' });
      if (result.status === 0) {
        return dockerPath;
      }
    } catch {
      // Continue to next path
    }
  }

  return 'docker'; // Fallback to PATH
}

export interface LivesimStartOptions {
  image?: string;
  port?: number;
  vodroot?: string;
  persistRepdata?: boolean;
  repdataDir?: string;
  detach?: boolean;
  name?: string;
  asset?: string;
  open?: boolean;
  noPull?: boolean;
  forcePull?: boolean;
  extraArgs?: string[];
  manifestUrl?: string;
  authToken?: string;
  authHeader?: string;
  authFile?: string;
  faultProxy?: boolean;
  faultConfigPath?: string;
  faultProfile?: string;
  preserveManifest?: boolean;
  mpdInfo?: MPDInfo; // Pre-analyzed MPD info to avoid re-analysis
  periodCount?: number; // Number of periods to generate (default: 1)
  periodDurations?: number[]; // Duration in seconds for each period
  periodStartTimes?: number[]; // Optional start times in seconds for each period
}

export interface LivesimStopOptions {
  name?: string;
}

export interface LivesimLogsOptions {
  name?: string;
}

export interface MPDInfo {
  url: string;
  duration?: number; // in seconds
  type: 'static' | 'dynamic';
  minBufferTime?: number;
  segmentDuration?: number;
  startNumber?: number;
  timescale?: number;
  representations: Array<{
    id: string;
    bandwidth: number;
    codecs?: string;
    width?: number;
    height?: number;
  }>;
  baseUrl?: string;
  availabilityTimeOffset?: number;
  timeShiftBufferDepth?: number;
  suggestedPresentationDelay?: number;
  minimumUpdatePeriod?: number;
  segmentTemplateType?: 'number' | 'time' | 'timeline';
  hasSCTE35?: boolean;
  utcTiming?: boolean;
  availabilityStartTimeEpoch?: number;
  periodCount?: number;
}

const DEFAULT_IMAGE = 'ghcr.io/dash-industry-forum/livesim2/livesim2:v1.7.0';
const DEFAULT_PORT = 8888;
const DEFAULT_NAME = 'hls-dash-livesim2';

const dashProxyRegistry = new Map<string, DashFaultProxy>();
const logStreamProcesses = new Map<string, ReturnType<typeof spawn>>();

async function findAvailablePort(start: number, attempts = 50): Promise<number> {
  let candidate = start;
  for (let i = 0; i < attempts; i++, candidate++) {
    // Skip negative or zero ports
    if (candidate <= 0 || candidate >= 65535) {
      continue;
    }
    const isFree = await new Promise<boolean>((resolve) => {
      const tester = net.createServer();
      tester.once('error', () => {
        resolve(false);
      });
      tester.listen(candidate, () => {
        tester.close(() => resolve(true));
      });
    });
    if (isFree) {
      return candidate;
    }
  }
  throw new Error(`Unable to find available port starting at ${start}`);
}

// Fetch MPD content from URL with optional authentication
function fetchMPD(url: string, authOptions?: {
  token?: string;
  header?: string;
  file?: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    // Preprocess URL to handle common escaping issues
    let processedUrl = url;
    if (processedUrl.includes('\\')) {
      console.info('Detected escaped URL, attempting to unescape...');
      // Remove backslashes before common URL characters
      processedUrl = processedUrl.replace(/\\([()&?=])/g, '$1');
      console.info('Processed URL for fetching');
    }

    // First try with Node.js HTTP client
    const tryNodeJSRequest = () => {
      const client = processedUrl.startsWith('https:') ? https : http;

      // Build headers to mimic curl
      const headers: Record<string, string> = {
        'Accept': '*/*',
        'User-Agent': 'curl/7.88.1'
      };

      // Add authentication headers
      if (authOptions?.token) {
        headers['Authorization'] = `Bearer ${authOptions.token}`;
      } else if (authOptions?.header) {
        const [key, value] = authOptions.header.split(': ', 2);
        if (key && value) {
          headers[key.trim()] = value.trim();
        }
      } else if (authOptions?.file) {
        try {
          const authData = JSON.parse(fs.readFileSync(authOptions.file, 'utf8'));
          Object.assign(headers, authData);
        } catch (err) {
          reject(new Error(`Failed to read auth file: ${authOptions.file} - ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
      }

      const options = { headers };
      const req = client.get(processedUrl, options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(data);
          } else {
            console.info(`Node.js request failed with ${res.statusCode}, trying curl fallback...`);
            tryCurlFallback();
          }
        });
      });

      req.on('error', (err) => {
        console.info(`Node.js request failed with error: ${err.message}, trying curl fallback...`);
        tryCurlFallback();
      });

      req.setTimeout(10000, () => {
        req.abort();
        console.info('Node.js request timeout, trying curl fallback...');
        tryCurlFallback();
      });
    };

    // Fallback to curl if Node.js request fails
    const tryCurlFallback = () => {
      console.info('Using curl fallback to fetch MPD...');
      const curl = spawn('curl', ['-s', '--compressed', processedUrl], { stdio: ['pipe', 'pipe', 'pipe'] });

      let data = '';
      let errorOutput = '';

      curl.stdout.on('data', (chunk) => {
        data += chunk.toString();
      });

      curl.stderr.on('data', (chunk) => {
        errorOutput += chunk.toString();
      });

      curl.on('close', (code) => {
        if (code === 0 && data && data.includes('<?xml') && data.includes('<MPD')) {
          console.info('Curl fallback successful');
          resolve(data);
        } else {
          reject(new Error(`Both Node.js and curl failed to fetch MPD. Curl exit code: ${code}, Error: ${errorOutput}, Data length: ${data.length}`));
        }
      });

      curl.on('error', (err) => {
        reject(new Error(`Curl fallback failed: ${err.message}`));
      });
    };

    // Start with Node.js request, fallback to curl if needed
    tryNodeJSRequest();
  });
}

// Parse duration string (PT1H2M3S format) to seconds
function parseDuration(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1] || '0');
  const minutes = parseInt(match[2] || '0');
  const seconds = parseInt(match[3] || '0');

  return hours * 3600 + minutes * 60 + seconds;
}

// Basic XML parser for MPD (simplified - extracts key info)
function parseMPD(mpdContent: string, url: string): MPDInfo {
  const mpd: MPDInfo = {
    url,
    type: 'static',
    representations: []
  };

  // Extract MPD attributes
  const mpdMatch = mpdContent.match(/<MPD[^>]*type="([^"]*)"/);
  if (mpdMatch) {
    mpd.type = mpdMatch[1] as 'static' | 'dynamic';
  }

  // Extract timing parameters
  const timeShiftMatch = mpdContent.match(/timeShiftBufferDepth="([^"]*)"/);
  if (timeShiftMatch) {
    mpd.timeShiftBufferDepth = parseDuration(timeShiftMatch[1]);
  }

  const suggestedDelayMatch = mpdContent.match(/suggestedPresentationDelay="([^"]*)"/);
  if (suggestedDelayMatch) {
    mpd.suggestedPresentationDelay = parseDuration(suggestedDelayMatch[1]);
  }

  const minUpdateMatch = mpdContent.match(/minimumUpdatePeriod="([^"]*)"/);
  if (minUpdateMatch) {
    mpd.minimumUpdatePeriod = parseDuration(minUpdateMatch[1]);
  }

  // Extract duration (MPD uses mediaPresentationDuration)
  const mediaDurMatch = mpdContent.match(/mediaPresentationDuration="([^"]*)"/);
  if (mediaDurMatch) {
    mpd.duration = parseDuration(mediaDurMatch[1]);
  } else {
    const durationMatch = mpdContent.match(/duration="([^"]*)"/);
    if (durationMatch) {
      mpd.duration = parseDuration(durationMatch[1]);
    }
  }

  // Extract minBufferTime
  const bufferMatch = mpdContent.match(/minBufferTime="([^"]*)"/);
  if (bufferMatch) {
    mpd.minBufferTime = parseDuration(bufferMatch[1]);
  }

  // Extract BaseURL
  const baseUrlMatch = mpdContent.match(/<BaseURL[^>]*>([^<]*)<\/BaseURL>/);
  if (baseUrlMatch) {
    mpd.baseUrl = baseUrlMatch[1];
  }

  // UTCTiming presence and availabilityStartTime
  mpd.utcTiming = /<UTCTiming\b/i.test(mpdContent);
  const astMatch = mpdContent.match(/availabilityStartTime="([^"]+)"/);
  if (astMatch) {
    const dt = Date.parse(astMatch[1]);
    if (!Number.isNaN(dt)) mpd.availabilityStartTimeEpoch = Math.floor(dt / 1000);
  }

  // Period count
  const periodMatches = mpdContent.match(/<Period\b/gi);
  mpd.periodCount = periodMatches ? periodMatches.length : 1;

  // Helper matchers
  const matchTag = (content: string, tag: string): string | undefined => {
    const m = content.match(new RegExp(`<${tag}[^>]*>`));
    return m ? m[0] : undefined;
  };
  const matchAttr = (tag: string, name: string): string | undefined => {
    const m = tag.match(new RegExp(`${name}="([^"]+)"`));
    return m ? m[1] : undefined;
  };

  // Extract segment information and determine template type
  const segmentTemplateMatch = matchTag(mpdContent, 'SegmentTemplate');
  if (segmentTemplateMatch) {
    // Determine template variant
    if (mpdContent.includes('$Number$')) {
      mpd.segmentTemplateType = 'number';
    } else if (mpdContent.includes('$Time$')) {
      mpd.segmentTemplateType = 'time';
    } else if (mpdContent.includes('<SegmentTimeline>')) {
      mpd.segmentTemplateType = 'timeline';
    }

    // Extract attributes independently (order-agnostic)
    const dur = matchAttr(segmentTemplateMatch, 'duration');
    const ts = matchAttr(segmentTemplateMatch, 'timescale');
    const sn = matchAttr(segmentTemplateMatch, 'startNumber');
    if (dur) mpd.segmentDuration = parseInt(dur, 10);
    if (ts) mpd.timescale = parseInt(ts, 10);
    if (sn) mpd.startNumber = parseInt(sn, 10);
  }

  // If SegmentTimeline present, derive first S@d as segment duration ticks
  if (mpdContent.includes('<SegmentTimeline>')) {
    const sMatch = mpdContent.match(/<SegmentTimeline>[\s\S]*?<S[^>]*d="([^"]+)"/);
    if (sMatch) {
      const d = parseInt(sMatch[1], 10);
      if (!Number.isNaN(d)) {
        mpd.segmentDuration = d; // seconds will be computed as d/timescale
      }
    }
  }

  // Fallback: timescale from AdaptationSet/Period-level SegmentTemplate if missing
  if (!mpd.timescale) {
    const asTs = mpdContent.match(/<AdaptationSet[^>]*>[\s\S]*?<SegmentTemplate[^>]*timescale="([^"]+)"/);
    if (asTs) {
      mpd.timescale = parseInt(asTs[1], 10);
    } else {
      const periodTs = mpdContent.match(/<Period[^>]*>[\s\S]*?<SegmentTemplate[^>]*timescale="([^"]+)"/);
      if (periodTs) mpd.timescale = parseInt(periodTs[1], 10);
    }
  }

  // Fallback: Representation-level SegmentTemplate attributes if still missing
  if (!mpd.segmentDuration || !mpd.timescale || mpd.startNumber === undefined) {
    const repTpl = mpdContent.match(/<Representation[^>]*>[\s\S]*?<SegmentTemplate[^>]*>/);
    if (repTpl) {
      const tag = repTpl[0];
      const dur = tag.match(/duration="([^"]+)"/);
      const ts = tag.match(/timescale="([^"]+)"/);
      const sn = tag.match(/startNumber="([^"]+)"/);
      if (dur && !mpd.segmentDuration) mpd.segmentDuration = parseInt(dur[1], 10);
      if (ts && !mpd.timescale) mpd.timescale = parseInt(ts[1], 10);
      if (sn && mpd.startNumber === undefined) mpd.startNumber = parseInt(sn[1], 10);
    }
  }

  // Extract availabilityTimeOffset (for low latency)
  const atoMatch = mpdContent.match(/availabilityTimeOffset="([^"]*)"/);
  if (atoMatch) {
    mpd.availabilityTimeOffset = parseFloat(atoMatch[1]);
  }

  // Check for SCTE-35 signaling
  mpd.hasSCTE35 = mpdContent.includes('scte35') || mpdContent.includes('SCTE-35') ||
    mpdContent.includes('urn:scte:scte35');

  // Extract representations
  const representationRegex = /<Representation[^>]*id="([^"]*)"[^>]*bandwidth="([^"]*)"[^>]*(?:codecs="([^"]*)")?[^>]*(?:width="([^"]*)")?[^>]*(?:height="([^"]*)")?[^>]*>/g;
  let repMatch;
  while ((repMatch = representationRegex.exec(mpdContent)) !== null) {
    mpd.representations.push({
      id: repMatch[1],
      bandwidth: parseInt(repMatch[2]),
      codecs: repMatch[3],
      width: repMatch[4] ? parseInt(repMatch[4]) : undefined,
      height: repMatch[5] ? parseInt(repMatch[5]) : undefined
    });
  }

  return mpd;
}

// Analyze MPD and generate livesim2 URL
async function analyzeMPD(manifestUrl: string, authOptions?: {
  token?: string;
  header?: string;
  file?: string;
}): Promise<MPDInfo> {
  console.info(`Fetching MPD from: ${manifestUrl}`);
  const mpdContent = await fetchMPD(manifestUrl, authOptions);
  const mpdInfo = parseMPD(mpdContent, manifestUrl);

  console.info(`MPD Analysis:`);
  console.info(`  Type: ${mpdInfo.type}`);
  if (mpdInfo.duration) {
    console.info(`  Duration: ${mpdInfo.duration}s`);
  }
  if (mpdInfo.timeShiftBufferDepth) {
    console.info(`  Time Shift Buffer: ${mpdInfo.timeShiftBufferDepth}s`);
  }
  if (mpdInfo.suggestedPresentationDelay) {
    console.info(`  Suggested Presentation Delay: ${mpdInfo.suggestedPresentationDelay}s`);
  }
  if (mpdInfo.minimumUpdatePeriod) {
    console.info(`  Minimum Update Period: ${mpdInfo.minimumUpdatePeriod}s`);
  }
  if (mpdInfo.segmentDuration && mpdInfo.timescale) {
    const segmentSeconds = mpdInfo.segmentDuration / mpdInfo.timescale;
    console.info(`  Segment Duration: ${segmentSeconds}s`);
  }
  if (mpdInfo.segmentTemplateType) {
    console.info(`  Segment Template: ${mpdInfo.segmentTemplateType}`);
  }
  if (mpdInfo.availabilityTimeOffset !== undefined) {
    console.info(`  Availability Time Offset: ${mpdInfo.availabilityTimeOffset}s`);
  }
  if (mpdInfo.hasSCTE35) {
    console.info(`  SCTE-35: Present`);
  }
  console.info(`  Representations: ${mpdInfo.representations.length}`);
  mpdInfo.representations.forEach((rep, i) => {
    console.info(`    ${i + 1}. ${rep.id}: ${rep.bandwidth}bps${rep.width ? ` (${rep.width}x${rep.height})` : ''}`);
  });

  return mpdInfo;
}

function getMpdNameForAsset(asset: string): string {
  // Heuristic: WAVE vectors use stream.mpd, many others use manifest.mpd
  if (asset.startsWith('WAVE/')) return 'stream.mpd';
  return 'manifest.mpd';
}

// Build local livesim2 asset MPD URL
function buildAssetMpd(port: number, asset: string): string {
  const mpdName = getMpdNameForAsset(asset);
  return `http://localhost:${port}/livesim2/${asset}/${mpdName}`;
}

// Generate livesim2 stream URL using local asset with parameters extracted from remote MPD
function generateLivesimUrlForBase(mpdBaseUrl: string, mpdInfo: MPDInfo): string {
  // Append livesim parameters inferred from the remote MPD to the provided MPD base URL
  const params = new URLSearchParams();

  if (mpdInfo.type === 'dynamic') {
    const epoch = mpdInfo.availabilityStartTimeEpoch ?? Math.floor(Date.now() / 1000);
    params.set('start', String(epoch));
  }
  if (mpdInfo.minBufferTime) params.set('buf', mpdInfo.minBufferTime.toString());
  if (mpdInfo.timeShiftBufferDepth) params.set('tsbd', mpdInfo.timeShiftBufferDepth.toString());
  if (mpdInfo.segmentDuration && mpdInfo.timescale) {
    params.set('segdur', (mpdInfo.segmentDuration / mpdInfo.timescale).toString());
  }
  if (mpdInfo.startNumber !== undefined) params.set('snr', String(mpdInfo.startNumber));
  if (mpdInfo.segmentTemplateType) {
    params.set('stl', mpdInfo.segmentTemplateType === 'time' ? 'tlt' :
      mpdInfo.segmentTemplateType === 'timeline' ? 'tlnr' : 'nr');
  }
  if (mpdInfo.availabilityTimeOffset !== undefined) params.set('ato', String(mpdInfo.availabilityTimeOffset));
  if (mpdInfo.hasSCTE35) params.set('scte35', '1');

  const q = params.toString();
  return q ? `${mpdBaseUrl}?${q}` : mpdBaseUrl;
}

// Create preserved manifest - fetch original and convert to livesim2-compatible format
async function createPreservedManifest(manifestUrl: string, authOptions: { token?: string; header?: string; file?: string }, port: number): Promise<string> {
  try {
    // Fetch the original manifest
    const mpdContent = await fetchMPD(manifestUrl, authOptions);
    let modifiedManifest = mpdContent;

    // Remove all ContentProtection elements (DRM)
    modifiedManifest = modifiedManifest.replace(/<ContentProtection[\s\S]*?<\/ContentProtection>/g, '');

    // Replace time-based SegmentTemplate with number-based for video adaptation sets
    // Convert: <SegmentTemplate timescale="10000000" presentationTimeOffset="0" media="$RepresentationID$/Segment-$Time$.m4v" initialization="$RepresentationID$/init.m4i">
    // To: <SegmentTemplate media="$RepresentationID$/Segment-$Number$.m4v" initialization="$RepresentationID$/init.m4i" duration="40000000" startNumber="1" timescale="10000000">
    modifiedManifest = modifiedManifest.replace(
      /<SegmentTemplate[^>]*media="[^"]*\$Time\$[^"]*"[^>]*>/g,
      (match) => {
        // Extract timescale from the original
        const timescaleMatch = match.match(/timescale="(\d+)"/);
        const timescale = timescaleMatch ? timescaleMatch[1] : '10000000';

        // Extract representation ID pattern
        const mediaMatch = match.match(/media="([^"]*)"/);
        const mediaTemplate = mediaMatch ? mediaMatch[1].replace('$Time$', '$Number$') : '$RepresentationID$/Segment-$Number$.m4v';

        const initMatch = match.match(/initialization="([^"]*)"/);
        const initTemplate = initMatch ? initMatch[1] : '$RepresentationID$/init.m4i';

        return `<SegmentTemplate media="${mediaTemplate}" initialization="${initTemplate}" duration="40000000" startNumber="1" timescale="${timescale}">`;
      }
    );

    // Remove SegmentTimeline if present (since we're using $Number$ template)
    modifiedManifest = modifiedManifest.replace(/<SegmentTimeline[\s\S]*?<\/SegmentTimeline>/g, '');

    // Set BaseURL to point to proxy
    modifiedManifest = modifiedManifest.replace(
      /<BaseURL>.*?<\/BaseURL>/g,
      `<BaseURL>http://localhost:${port}/__dash__/</BaseURL>`
    );

    // Update ProgramInformation to reflect source
    const titleMatch = modifiedManifest.match(/<Title>(.*?)<\/Title>/);
    if (titleMatch) {
      modifiedManifest = modifiedManifest.replace(
        /<ProgramInformation>[\s\S]*?<\/ProgramInformation>/,
        `<ProgramInformation>
    <Title>FanDuel Sports Network</Title>
    <Source>Generated from ${manifestUrl}</Source>
  </ProgramInformation>`
      );
    }

    return modifiedManifest;
  } catch (error) {
    console.warn('Failed to create preserved manifest from original URL:', error);
  }

  // Fallback: return a basic manifest
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011,urn:mpeg:dash:profile:cmaf:2019,urn:cta:wave:test-content-media-profile:2022" type="dynamic" availabilityStartTime="1970-01-01T00:00:00Z" publishTime="1970-01-01T00:00:00Z" minimumUpdatePeriod="PT2S" minBufferTime="PT2S" timeShiftBufferDepth="PT1M" maxSegmentDuration="PT2S">
  <ProgramInformation>
    <Title>FanDuel Sports Network</Title>
    <Source>Generated from ${manifestUrl}</Source>
  </ProgramInformation>
  <Period id="P0" start="PT0S">
    <BaseURL>http://localhost:${port}/__dash__/</BaseURL>
    <AdaptationSet lang="und" contentType="video" par="16:9" maxWidth="1920" maxHeight="1080" maxFrameRate="25" segmentAlignment="true" containerProfiles="cmf2,cfhd" startWithSAP="1">
      <SegmentTemplate media="$RepresentationID$/Segment-$Number$.m4v" initialization="$RepresentationID$/init.m4i" duration="40000000" startNumber="1" timescale="10000000"></SegmentTemplate>
      <Representation id="1" bandwidth="4900000" width="1920" height="1080" sar="1:1" frameRate="25" mimeType="video/mp4" codecs="avc1.640028"></Representation>
    </AdaptationSet>
  </Period>
  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014" value="https://time.akamai.com/?iso&amp;ms"></UTCTiming>
</MPD>`;
}

// Generate multi-period MPD without manifestUrl
function createMultiPeriodManifest(
  periodCount: number,
  periodDurations: number[],
  periodStartTimes: number[] | undefined,
  port: number,
  asset: string
): string {
  // Calculate period start times if not provided
  const startTimes: number[] = periodStartTimes || [];
  if (startTimes.length === 0) {
    let cumulativeTime = 0;
    for (let i = 0; i < periodCount; i++) {
      startTimes.push(cumulativeTime);
      cumulativeTime += periodDurations[i] || 0;
    }
  }

  // Format duration as ISO 8601 (PT#S)
  const formatDuration = (seconds: number): string => {
    return `PT${seconds}S`;
  };

  // Generate periods XML
  const periodsXml = startTimes.map((startTime, index) => {
    const periodId = `P${index}`;
    const startAttr = formatDuration(startTime);
    return `  <Period id="${periodId}" start="${startAttr}">
    <BaseURL>http://localhost:${port}/__dash__/</BaseURL>
    <AdaptationSet lang="und" contentType="video" par="16:9" maxWidth="1920" maxHeight="1080" maxFrameRate="25" segmentAlignment="true" containerProfiles="cmf2,cfhd" startWithSAP="1">
      <SegmentTemplate media="1/$Number$.m4s" initialization="1/init.mp4" duration="25600" startNumber="1" timescale="12800"></SegmentTemplate>
      <Representation id="1" bandwidth="4900000" width="1920" height="1080" sar="1:1" frameRate="25" mimeType="video/mp4" codecs="avc1.640028"></Representation>
    </AdaptationSet>
  </Period>`;
  }).join('\n');

  // Calculate total duration
  const totalDuration = periodDurations.reduce((sum, d) => sum + d, 0);

  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011,urn:mpeg:dash:profile:cmaf:2019,urn:cta:wave:test-content-media-profile:2022" type="dynamic" availabilityStartTime="1970-01-01T00:00:00Z" publishTime="1970-01-01T00:00:00Z" minimumUpdatePeriod="PT2S" minBufferTime="PT2S" timeShiftBufferDepth="PT1M" maxSegmentDuration="PT2S">
  <ProgramInformation>
    <Title>Multi-Period DASH Stream</Title>
    <Source>Generated by Standalone Tools - ${periodCount} period(s), total duration: ${totalDuration}s</Source>
  </ProgramInformation>
${periodsXml}
  <UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-xsdate:2014" value="https://time.akamai.com/?iso&amp;ms"></UTCTiming>
</MPD>`;
}

// Create alias map for segment translation
function createAliasMap(mpdInfo: MPDInfo): Record<string, DashAliasMapEntry> {
  const aliasMap: Record<string, DashAliasMapEntry> = {};

  // Map each representation to livesim2-compatible paths
  mpdInfo.representations.forEach(rep => {
    aliasMap[rep.id] = {
      type: 'video', // Assume video for now - could be improved to detect from codecs
      originalId: rep.id,
      representationId: '1', // Map all to livesim2's single representation
      initializationPath: '1/init.mp4',
      mediaTemplate: '1/$Number$.m4s',
      startNumber: 1,
      timescale: 10000000,
      replacements: {} // No additional replacements needed for number-based
    };
  });

  return aliasMap;
}

// Generate URL generator form URL using local asset with parameters extracted from remote MPD
function generateUrlGeneratorUrl(mpdInfo: MPDInfo, port: number, asset: string): string {
  const params = new URLSearchParams();
  params.set('mpd', buildAssetMpd(port, asset)); // point to livesim2 asset

  // Add timing parameters
  if (mpdInfo.duration) {
    params.set('dur', mpdInfo.duration.toString());
  }

  if (mpdInfo.timeShiftBufferDepth) {
    params.set('tsbd', mpdInfo.timeShiftBufferDepth.toString());
  }

  if (mpdInfo.suggestedPresentationDelay) {
    params.set('spd', mpdInfo.suggestedPresentationDelay.toString());
  }

  if (mpdInfo.minimumUpdatePeriod) {
    params.set('mup', mpdInfo.minimumUpdatePeriod.toString());
  }

  if (mpdInfo.type === 'dynamic') {
    const epoch = mpdInfo.availabilityStartTimeEpoch ?? Math.floor(Date.now() / 1000);
    params.set('start', String(epoch));
  }

  // Add segment information
  if (mpdInfo.segmentDuration && mpdInfo.timescale) {
    const segmentSeconds = mpdInfo.segmentDuration / mpdInfo.timescale;
    params.set('segdur', segmentSeconds.toString());
  }

  // Add start number
  if (mpdInfo.startNumber !== undefined) {
    params.set('snr', mpdInfo.startNumber.toString());
  }

  // Add buffer time
  if (mpdInfo.minBufferTime) {
    params.set('buf', mpdInfo.minBufferTime.toString());
  }

  // Set segment template variant
  if (mpdInfo.segmentTemplateType) {
    switch (mpdInfo.segmentTemplateType) {
      case 'number':
        params.set('stl', 'nr');
        break;
      case 'time':
        params.set('stl', 'tlt');
        break;
      case 'timeline':
        params.set('stl', 'tlnr');
        break;
    }
  }

  // Set availability time offset (low latency)
  if (mpdInfo.availabilityTimeOffset !== undefined) {
    params.set('ato', mpdInfo.availabilityTimeOffset.toString());
  }

  // Set SCTE-35 if present
  if (mpdInfo.hasSCTE35) {
    params.set('scte35', '1'); // Default to frequency 1
  }

  // Preserve UTCTiming and Annex I params when possible
  if (mpdInfo.utcTiming) {
    params.set('utc', 'keep');
  }
  if (mpdInfo.baseUrl && mpdInfo.baseUrl.includes('?')) {
    const usp = new URLSearchParams(mpdInfo.baseUrl.split('?')[1]);
    const pairs: string[] = [];
    usp.forEach((v, k) => pairs.push(`${k}=${v}`));
    if (pairs.length) params.set('annexI', pairs.join(','));
  }

  return `http://localhost:${port}/urlgen/?${params.toString()}`;
}

function checkDocker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const dockerPath = getDockerPath();
    const docker = spawn(dockerPath, ['--version'], { stdio: 'pipe' });
    let output = '';
    docker.stdout.on('data', (data) => output += data);
    docker.stderr.on('data', (data) => output += data);
    docker.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Docker not available: ${output.trim()}`));
      }
    });
  });
}

// Check if Docker image exists locally
function checkImageExists(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dockerPath = getDockerPath();
    const docker = spawn(dockerPath, ['images', '-q', image], { stdio: 'pipe' });

    let output = '';
    docker.stdout.on('data', (data) => {
      output += data.toString().trim();
    });

    docker.on('close', (code) => {
      // If we get output, the image exists
      resolve(code === 0 && output.length > 0);
    });

    docker.on('error', () => {
      resolve(false);
    });
  });
}

// Enhanced pullImage with caching
function pullImageCached(image: string, forcePull: boolean = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const doPull = () => {
      console.info(`${forcePull ? 'Force pulling' : 'Pulling'} Docker image: ${image}`);
      const dockerPath = getDockerPath();
      const docker = spawn(dockerPath, ['pull', image], { stdio: 'inherit' });
      docker.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Failed to pull Docker image: ${image}`));
        }
      });
    };

    // Check if image exists (unless force pull)
    if (!forcePull) {
      checkImageExists(image)
        .then((exists) => {
          if (exists) {
            console.info(`Using cached Docker image: ${image}`);
            resolve();
          } else {
            doPull();
          }
        })
        .catch(() => {
          // On error checking, just try to pull
          doPull();
        });
    } else {
      doPull();
    }
  });
}

function runDocker(args: string[], detached: boolean = false): Promise<string | void> {
  return new Promise((resolve, reject) => {
    const dockerPath = getDockerPath();
    const docker = spawn(dockerPath, args, {
      stdio: detached ? 'pipe' : 'inherit',
      detached: detached
    });

    let containerId = '';
    let errorOutput = '';

    if (detached) {
      docker.stdout?.on('data', (data) => {
        containerId += data.toString().trim();
      });
      docker.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });
    }

    docker.on('close', (code) => {
      if (code === 0) {
        resolve(detached ? containerId : undefined);
      } else {
        reject(new Error(`Docker command failed: ${errorOutput || 'Unknown error'}`));
      }
    });
  });
}

function openUrl(url: string): void {
  const command = process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(command, [url], { stdio: 'ignore', detached: true });
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(p => Number(p));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function getLanRootUrl(port: number): string | undefined {
  const nets = os.networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      const familyRaw = (ni as unknown as { family: string | number }).family;
      const familyStr = typeof familyRaw === 'number' ? String(familyRaw) : familyRaw;
      if ((familyStr === 'IPv4' || familyStr === '4') && !ni.internal && ni.address) {
        candidates.push(ni.address);
      }
    }
  }
  const chosen = candidates.find(isPrivateIPv4) || candidates[0];
  return chosen ? `http://${chosen}:${port}/` : undefined;
}

function logTestScenarios(options: {
  periodCount?: number;
  periodDurations?: number[];
  periodStartTimes?: number[];
  mpdInfo?: MPDInfo;
  manifestUrl?: string;
  preserveManifest?: boolean;
  faultProxy?: boolean;
}): void {
  const { periodCount, periodDurations, periodStartTimes, mpdInfo, manifestUrl, preserveManifest, faultProxy } = options;

  console.info('');
  console.info('═══════════════════════════════════════════════════════════');
  console.info('🧪 TEST SCENARIOS & CONFIGURATION');
  console.info('═══════════════════════════════════════════════════════════');

  // Multi-Period Configuration
  if (periodCount !== undefined || periodDurations !== undefined) {
    const effectivePeriodCount = periodCount ?? (periodDurations?.length ?? 1);
    console.info('');
    console.info('📊 Multi-Period Configuration:');
    console.info(`   • Period Count: ${effectivePeriodCount}`);
    if (periodDurations && periodDurations.length > 0) {
      console.info(`   • Period Durations: ${periodDurations.map(d => `${d}s`).join(', ')}`);
      const totalDuration = periodDurations.reduce((sum, d) => sum + d, 0);
      console.info(`   • Total Duration: ${totalDuration}s`);
    }
    if (periodStartTimes && periodStartTimes.length > 0) {
      console.info(`   • Period Start Times: ${periodStartTimes.map(t => `${t}s`).join(', ')}`);
    }
    console.info(`   ✓ Testing: Multi-period DASH stream with ${effectivePeriodCount} period(s)`);
  } else {
    console.info('');
    console.info('📊 Period Configuration:');
    console.info('   • Period Count: 1 (default)');
    console.info('   ✓ Testing: Single-period DASH stream');
  }

  // Segment Configuration
  console.info('');
  console.info('🎬 Segment Configuration:');
  if (mpdInfo) {
    if (mpdInfo.segmentDuration && mpdInfo.timescale) {
      const segmentSeconds = mpdInfo.segmentDuration / mpdInfo.timescale;
      console.info(`   • Segment Duration: ${segmentSeconds}s`);
    }
    if (mpdInfo.startNumber !== undefined) {
      console.info(`   • Start Number: ${mpdInfo.startNumber}`);
    }
    if (mpdInfo.segmentTemplateType) {
      console.info(`   • Template Type: ${mpdInfo.segmentTemplateType} (${mpdInfo.segmentTemplateType === 'number' ? '$Number$' : mpdInfo.segmentTemplateType === 'time' ? '$Time$' : 'SegmentTimeline'})`);
    }
    if (mpdInfo.representations && mpdInfo.representations.length > 0) {
      console.info(`   • Representations: ${mpdInfo.representations.length}`);
      console.info(`   • Bitrates: ${mpdInfo.representations.map(r => `${Math.round(r.bandwidth / 1000)}kbps`).join(', ')}`);
    }
    console.info(`   ✓ Testing: Multi-segment DASH stream (${mpdInfo.segmentTemplateType || 'number'}-based addressing)`);
  } else {
    console.info('   • Using default livesim2 segment configuration');
    console.info('   ✓ Testing: Multi-segment DASH stream (number-based addressing)');
  }

  // Manifest Configuration
  console.info('');
  console.info('📄 Manifest Configuration:');
  if (manifestUrl) {
    console.info(`   • Source: ${manifestUrl}`);
    console.info(`   • Preservation: ${preserveManifest ? 'Enabled' : 'Disabled'}`);
    if (preserveManifest) {
      console.info('   ✓ Testing: Preserved manifest structure from remote source');
    } else {
      console.info('   ✓ Testing: Livesim2-generated manifest');
    }
  } else {
    console.info('   • Source: Livesim2 (no remote manifest)');
    console.info('   ✓ Testing: Livesim2-generated manifest');
  }

  // Fault Injection Configuration
  console.info('');
  console.info('🔧 Fault Injection Configuration:');
  if (faultProxy) {
    const faultConfig = getFaultConfig();
    const hasFaults =
      (faultConfig.segment?.missing && faultConfig.segment.missing !== 'off') ||
      (faultConfig.segment?.forbidden && faultConfig.segment.forbidden !== 'off') ||
      (faultConfig.segment?.malformed && faultConfig.segment.malformed !== 'off') ||
      (faultConfig.manifest?.freeze && faultConfig.manifest.freeze !== 'off') ||
      (faultConfig.drm?.licenseFailure && faultConfig.drm.licenseFailure !== 'off') ||
      (faultConfig.drm?.keyRotationMismatch && faultConfig.drm.keyRotationMismatch !== 'off');

    if (hasFaults) {
      console.info('   • Fault Proxy: Active');
      if (faultConfig.segment?.missing && faultConfig.segment.missing !== 'off') {
        console.info(`   • Segment Missing: ${faultConfig.segment.missing}`);
      }
      if (faultConfig.segment?.forbidden && faultConfig.segment.forbidden !== 'off') {
        console.info(`   • Segment Forbidden: ${faultConfig.segment.forbidden}`);
      }
      if (faultConfig.segment?.malformed && faultConfig.segment.malformed !== 'off') {
        console.info(`   • Segment Malformed: ${faultConfig.segment.malformed}`);
      }
      if (faultConfig.manifest?.freeze && faultConfig.manifest.freeze !== 'off') {
        console.info(`   • Manifest Freeze: ${faultConfig.manifest.freeze}`);
      }
      if (faultConfig.drm?.licenseFailure && faultConfig.drm.licenseFailure !== 'off') {
        console.info(`   • DRM License Failure: ${faultConfig.drm.licenseFailure}`);
      }
      if (faultConfig.drm?.keyRotationMismatch && faultConfig.drm.keyRotationMismatch !== 'off') {
        console.info(`   • DRM Key Rotation Mismatch: ${faultConfig.drm.keyRotationMismatch}`);
      }
      if (faultConfig.segment?.latencyMs && faultConfig.segment.latencyMs > 0) {
        console.info(`   • Segment Latency: ${faultConfig.segment.latencyMs}ms`);
      }
      console.info('   ✓ Testing: Fault injection scenarios enabled');
    } else {
      console.info('   • Fault Proxy: Active (no faults configured)');
      console.info('   ✓ Testing: Normal playback (no faults)');
    }
  } else {
    console.info('   • Fault Proxy: Disabled');
    console.info('   ✓ Testing: Normal playback (no fault injection)');
  }

  // Summary
  console.info('');
  console.info('📋 Test Summary:');
  const scenarios: string[] = [];
  if (periodCount !== undefined && periodCount > 1) {
    scenarios.push(`Multi-period (${periodCount} periods)`);
  }
  if (mpdInfo?.representations && mpdInfo.representations.length > 1) {
    scenarios.push(`Multi-representation (${mpdInfo.representations.length} bitrates)`);
  }
  scenarios.push('Multi-segment streaming');
  if (faultProxy) {
    scenarios.push('Fault injection');
  }
  if (preserveManifest && manifestUrl) {
    scenarios.push('Manifest preservation');
  }

  scenarios.forEach((scenario, index) => {
    console.info(`   ${index + 1}. ${scenario}`);
  });

  console.info('═══════════════════════════════════════════════════════════');
  console.info('');
}

function logRokuCopyUrl(url: string): void {
  const bold = '\x1b[1m';
  const green = '\x1b[32m';
  const reset = '\x1b[0m';
  console.info(`  ${bold}${green}Copy into Roku:${reset} ${bold}${url}${reset}`);
}

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m'
};

function bold(s: string): string { return `${COLORS.bold}${s}${COLORS.reset}`; }
function green(s: string): string { return `${COLORS.green}${s}${COLORS.reset}`; }
function cyan(s: string): string { return `${COLORS.cyan}${s}${COLORS.reset}`; }
function yellow(s: string): string { return `${COLORS.yellow}${s}${COLORS.reset}`; }

function logPrefilledUrl(url: string): void {
  console.info(`  ${bold(green('URL Generator (pre-filled):'))} ${bold(cyan(url))}`);
}

function logExtractedParams(mpdInfo: MPDInfo): void {
  console.info(bold(cyan('  Extracted parameters from manifest-url:')));
  let printed = false;
  if (mpdInfo.type === 'dynamic') {
    const startNow = new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
    console.info(`    ${yellow('start')}=${cyan(startNow)} ${COLORS.reset}(dynamic)`);
    printed = true;
  }
  if (mpdInfo.minBufferTime) {
    console.info(`    ${yellow('buf')}=${cyan(String(mpdInfo.minBufferTime))}  ${COLORS.reset}(minBufferTime)`);
    printed = true;
  }
  if (mpdInfo.timeShiftBufferDepth) {
    console.info(`    ${yellow('tsbd')}=${cyan(String(mpdInfo.timeShiftBufferDepth))}  ${COLORS.reset}(timeShiftBufferDepth)`);
    printed = true;
  }
  if (mpdInfo.segmentDuration && mpdInfo.timescale) {
    const segdur = mpdInfo.segmentDuration / mpdInfo.timescale;
    console.info(`    ${yellow('segdur')}=${cyan(String(segdur))}  ${COLORS.reset}(segmentDuration/timescale)`);
    printed = true;
  }
  if (mpdInfo.startNumber !== undefined) {
    console.info(`    ${yellow('snr')}=${cyan(String(mpdInfo.startNumber))}  ${COLORS.reset}(startNumber)`);
    printed = true;
  }
  if (mpdInfo.segmentTemplateType) {
    const stl = mpdInfo.segmentTemplateType === 'time' ? 'tlt' :
      mpdInfo.segmentTemplateType === 'timeline' ? 'tlnr' : 'nr';
    console.info(`    ${yellow('stl')}=${cyan(stl)}  ${COLORS.reset}(segmentTemplateType=${mpdInfo.segmentTemplateType})`);
    printed = true;
  }
  if (mpdInfo.availabilityTimeOffset !== undefined) {
    console.info(`    ${yellow('ato')}=${cyan(String(mpdInfo.availabilityTimeOffset))}  ${COLORS.reset}(availabilityTimeOffset)`);
    printed = true;
  }
  if (mpdInfo.hasSCTE35) {
    console.info(`    ${yellow('scte35')}=${cyan('1')}  ${COLORS.reset}(SCTE-35 present)`);
    printed = true;
  }
  if (!printed) {
    console.info(`    ${yellow('(none detected)')}`);
  }
}

export async function startLivesim2(options: LivesimStartOptions = {}): Promise<void> {
  const {
    image = DEFAULT_IMAGE,
    port = DEFAULT_PORT,
    vodroot,
    persistRepdata = false,
    repdataDir,
    detach = false,
    name = DEFAULT_NAME,
    asset = 'WAVE/vectors/cfhd_sets/12.5_25_50/t3/2022-10-17',
    open = false,
    noPull = false,
    forcePull = false,
    extraArgs = [],
    manifestUrl,
    authToken,
    authHeader,
    authFile,
    faultProxy = true,
    faultConfigPath,
    faultProfile,
    preserveManifest = true,
    mpdInfo: providedMpdInfo,
    periodCount,
    periodDurations,
    periodStartTimes
  } = options;

  // Validate multi-period configuration
  if (periodCount !== undefined) {
    if (periodCount < 1) {
      throw new Error('periodCount must be at least 1');
    }
    if (periodDurations !== undefined) {
      if (periodDurations.length !== periodCount) {
        throw new Error(`periodDurations array length (${periodDurations.length}) must match periodCount (${periodCount})`);
      }
      // Validate all durations are positive
      for (let i = 0; i < periodDurations.length; i++) {
        if (periodDurations[i] <= 0) {
          throw new Error(`periodDurations[${i}] must be a positive number, got ${periodDurations[i]}`);
        }
      }
    }
    if (periodStartTimes !== undefined) {
      if (periodStartTimes.length !== periodCount) {
        throw new Error(`periodStartTimes array length (${periodStartTimes.length}) must match periodCount (${periodCount})`);
      }
    }
  } else if (periodDurations !== undefined) {
    // If durations provided without count, infer count from durations
    if (periodDurations.length === 0) {
      throw new Error('periodDurations cannot be an empty array');
    }
  }

  const mustUseProxy = Boolean(preserveManifest && manifestUrl);
  if (mustUseProxy && !detach) {
    throw new Error('Preserve manifest requires --detach so the DASH proxy can run in the background.');
  }

  const configPathOverride = faultConfigPath ?? process.env.DASH_FAULT_CONFIG ?? process.env.HLS_FAULT_CONFIG;
  if (configPathOverride) {
    setFaultConfigPath(configPathOverride);
  }
  const profileOverride = faultProfile ?? process.env.DASH_FAULT_PROFILE ?? process.env.HLS_FAULT_PROFILE;
  if (profileOverride) {
    applyConfigOverride({ profile: profileOverride });
  }

  // Check Docker availability
  await checkDocker();

  // Pull image if requested (with caching)
  if (!noPull) {
    await pullImageCached(image, forcePull);
  }

  // Analyze MPD if manifestUrl provided, or use provided mpdInfo
  let mpdInfo: MPDInfo | undefined = providedMpdInfo;
  if (manifestUrl && !mpdInfo) {
    mpdInfo = await analyzeMPD(manifestUrl, {
      token: authToken,
      header: authHeader,
      file: authFile
    });
  }

  const useFaultProxy = (faultProxy !== false || mustUseProxy) && detach;

  // Log test scenarios and configuration
  logTestScenarios({
    periodCount,
    periodDurations,
    periodStartTimes,
    mpdInfo,
    manifestUrl,
    preserveManifest,
    faultProxy: useFaultProxy
  });
  if (faultProxy !== false && !detach) {
    console.info('Fault proxy disabled because simulator is running in foreground (requires --detach).');
  }
  if (mustUseProxy && !useFaultProxy) {
    throw new Error('Preserve manifest requires the DASH proxy, but it could not be enabled.');
  }

  let hostPortForContainer = port;
  if (useFaultProxy) {
    hostPortForContainer = await findAvailablePort(port + 1);
  }

  // Check if container already exists and is running
  let containerExists = false;
  let containerRunning = false;
  let reuseContainer = false;

  try {
    const psResult = spawnSync(getDockerPath(), ['ps', '--filter', `name=${name}`, '--format', '{{.Status}}'], { stdio: 'pipe' });
    const output = psResult.stdout?.toString().trim() || '';
    if (output) {
      containerExists = true;
      containerRunning = output.includes('Up');
    }
  } catch {
    // Container might not exist, that's fine
  }

  if (containerExists && containerRunning) {
    console.info(`Reusing existing running container: ${name}`);

    // Get the container's port mapping
    try {
      const portResult = spawnSync(getDockerPath(), ['port', name, '8888/tcp'], { stdio: 'pipe' });
      if (portResult.status === 0 && portResult.stdout) {
        const portOutput = portResult.stdout.toString().trim();
        const portMatch = portOutput.match(/:(\d+)$/);
        if (portMatch) {
          hostPortForContainer = parseInt(portMatch[1], 10);
        }
      }
    } catch {
      // Use default if port detection fails
    }

    // If fault proxy is needed, we must restart it (can't reuse with different config)
    if (useFaultProxy) {
      // Skip container creation, just set up the proxy
      reuseContainer = true;
    } else {
    // No fault proxy needed, just return with URLs
      const lanRoot = getLanRootUrl(port);
      console.info(`URL: http://localhost:${port}/`);
      console.info(`URL Generator: http://localhost:${port}/urlgen/`);
      if (lanRoot) {
        console.info(`LAN URL (use on Roku): ${lanRoot}`);
        console.info(`LAN URL Generator: ${lanRoot}urlgen/`);
      }
      const localhostBase = buildAssetMpd(port, asset);
      const localhostStream = mpdInfo ? generateLivesimUrlForBase(localhostBase, mpdInfo) : localhostBase;
      console.info(`Stream URL (localhost): ${localhostStream}`);
      if (lanRoot) {
        const mpdName = getMpdNameForAsset(asset);
        const lanBase = `${lanRoot}livesim2/${asset}/${mpdName}`;
        const lanStream = mpdInfo ? generateLivesimUrlForBase(lanBase, mpdInfo) : lanBase;
        console.info(`Stream URL (LAN, for Roku): ${lanStream}`);
        logRokuCopyUrl(lanStream);
      }
      if (mpdInfo) {
        const urlGeneratorUrl = generateUrlGeneratorUrl(mpdInfo, port, asset);
        logPrefilledUrl(urlGeneratorUrl);
        logExtractedParams(mpdInfo);
      }
      if (open) {
        const urlToOpen = mpdInfo ? generateUrlGeneratorUrl(mpdInfo, port, asset) : `http://localhost:${port}/urlgen/`;
        openUrl(urlToOpen);
      }
      return;
    }
  }

  // Build docker run arguments
  const args: string[] = ['run'];

  // Name the container
  args.push('--name', name);

  // Port mapping
  args.push('-p', `${hostPortForContainer}:8888`);

  // Volume mounts
  if (vodroot) {
    const absVodroot = path.resolve(vodroot);
    if (!fs.existsSync(absVodroot)) {
      throw new Error(`VoD root directory does not exist: ${absVodroot}`);
    }
    args.push('-v', `${absVodroot}:/vod`);
    extraArgs.unshift('--vodroot=/vod');
  }

  if (persistRepdata) {
    const repDir = repdataDir || path.join(os.homedir(), '.hls-dash-live-sim', 'livesim2', 'repdata');
    if (!fs.existsSync(repDir)) {
      fs.mkdirSync(repDir, { recursive: true });
    }
    args.push('-v', `${repDir}:/repdata`);
    extraArgs.unshift('--repdataroot=/repdata');
  }

  // Remove container after exit
  args.push('--rm');

  // Detached mode
  if (detach) {
    args.push('-d');
  }

  // Image and command
  args.push(image);

  // Extra args to pass to livesim2
  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  // Container exists but is stopped - restart it
  if (containerExists && !containerRunning) {
    console.info(`Restarting stopped container: ${name}`);
    try {
      const startResult = spawnSync(getDockerPath(), ['start', name], { stdio: 'pipe' });
      if (startResult.status === 0) {
        console.info(`Container restarted: ${name}`);
        if (!useFaultProxy) {
          console.info(`URL: http://localhost:${port}/`);
          console.info(`URL Generator: http://localhost:${port}/urlgen/`);
          const lanRoot = getLanRootUrl(port);
          if (lanRoot) {
            console.info(`LAN URL (use on Roku): ${lanRoot}`);
            console.info(`LAN URL Generator: ${lanRoot}urlgen/`);
          }
          const localhostBase = buildAssetMpd(port, asset);
          const localhostStream = mpdInfo ? generateLivesimUrlForBase(localhostBase, mpdInfo) : localhostBase;
          console.info(`Stream URL (localhost): ${localhostStream}`);
          if (lanRoot) {
            const mpdName = getMpdNameForAsset(asset);
            const lanBase = `${lanRoot}livesim2/${asset}/${mpdName}`;
            const lanStream = mpdInfo ? generateLivesimUrlForBase(lanBase, mpdInfo) : lanBase;
            console.info(`Stream URL (LAN, for Roku): ${lanStream}`);
            logRokuCopyUrl(lanStream);
          }
          if (mpdInfo) {
            const urlGeneratorUrl = generateUrlGeneratorUrl(mpdInfo, port, asset);
            logPrefilledUrl(urlGeneratorUrl);
            logExtractedParams(mpdInfo);
          }
          if (open) {
            const urlToOpen = mpdInfo ? generateUrlGeneratorUrl(mpdInfo, port, asset) : `http://localhost:${port}/urlgen/`;
            openUrl(urlToOpen);
          }
          return;
        }
      }
    } catch {
      console.info(`Failed to restart container, will create new one`);
    }
  }

  // Stop and clean up existing fault proxy FIRST (before port cleanup)
  // This ensures the proxy releases the port before we try to kill other processes
  const existingProxy = dashProxyRegistry.get(name);
  if (existingProxy) {
    try {
      await existingProxy.close();
      dashProxyRegistry.delete(name);
      console.info(`Stopped existing fault proxy for ${name}`);
      // Wait a bit for port to be released by the proxy
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      console.warn(`Failed to stop existing proxy: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Also check for any process using the port and kill it (including orphaned proxy processes)
  try {
    const lsofResult = spawnSync('lsof', ['-ti', `:${port}`], { stdio: 'pipe' });
    if (lsofResult.stdout && lsofResult.stdout.toString().trim()) {
      const pids = lsofResult.stdout.toString().trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          spawnSync('kill', ['-9', pid], { stdio: 'pipe' });
          console.info(`Killed process ${pid} using port ${port}`);
        } catch {
          // Process might have already exited
        }
      }
      // Wait for OS to release the port after killing processes
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch {
    // lsof might not be available or port might be free
  }

  // Only create new container if we're not reusing an existing one
  if (!reuseContainer) {
    console.info(`Starting new livesim2 container: ${name}`);
    console.info(`URL: http://localhost:${port}/`);
    console.info(`URL Generator: http://localhost:${port}/urlgen/`);
    const lanRoot = getLanRootUrl(port);
    if (lanRoot) {
      console.info(`LAN URL (use on Roku): ${lanRoot}`);
      console.info(`LAN URL Generator: ${lanRoot}urlgen/`);
    }

    const result = await runDocker(args, detach);

    if (detach && result) {
      console.info(`Container started in background: ${result.trim()}`);

      // Start streaming logs in the background
      startLogStreaming(name);
      if (open) {
        const urlToOpen = mpdInfo ? generateUrlGeneratorUrl(mpdInfo, port, asset) : `http://localhost:${port}/urlgen/`;
        openUrl(urlToOpen);
      }
    } else if (open && !detach) {
      // For foreground mode, open after a short delay to let server start
      setTimeout(() => {
        const urlToOpen = mpdInfo ? generateUrlGeneratorUrl(mpdInfo, port, asset) : `http://localhost:${port}/urlgen/`;
        openUrl(urlToOpen);
      }, 2000);
    }
  } else {
    // Reusing existing container - just start log streaming if needed
    if (detach) {
      startLogStreaming(name);
    }
  }

  // Always extract MPD info when manifestUrl is provided (for URL generator enhancement)
  if (manifestUrl && !mpdInfo) {
    try {
      mpdInfo = await analyzeMPD(manifestUrl, { token: authToken, header: authHeader, file: authFile });
      logExtractedParams(mpdInfo);
    } catch (err) {
      console.error('Failed to analyze manifest URL:', err);
    }
  }

  // Generate stream URLs - use preserved manifest if available, otherwise livesim2 URLs
  const lan = getLanRootUrl(port);

  // Check if manifest preservation was enabled (either from remote manifest or multi-period generation)
  const preservationEnabled = useFaultProxy && preserveManifest && ((manifestUrl && mpdInfo) || (periodCount !== undefined || periodDurations !== undefined));

  const localStreamUrl = (() => {
    if (preservationEnabled) {
      // Use preserved manifest served by proxy
      return `http://localhost:${port}/proxy.mpd`;
    } else {
    // Use standard livesim2 URL
      const localhostBase = buildAssetMpd(port, asset);
      return mpdInfo ? generateLivesimUrlForBase(localhostBase, mpdInfo) : localhostBase;
    }
  })();

  console.info(`Stream URL (localhost): ${localStreamUrl}`);
  if (lan) {
    const lanStream = (() => {
      if (preservationEnabled) {
        // Use preserved manifest on LAN
        const cleanLan = lan.replace(/\/$/, ''); // Remove trailing slash
        return `${cleanLan}/proxy.mpd`;
      } else {
      // Use standard livesim2 URL on LAN
        const mpdName = getMpdNameForAsset(asset);
        const lanBase = `${lan}livesim2/${asset}/${mpdName}`;
        return mpdInfo ? generateLivesimUrlForBase(lanBase, mpdInfo) : lanBase;
      }
    })();
    console.info(`Stream URL (LAN, for Roku): ${lanStream}`);
    logRokuCopyUrl(lanStream);
  }
  if (mpdInfo) {
    const urlGeneratorUrl = generateUrlGeneratorUrl(mpdInfo, port, asset);
    logPrefilledUrl(urlGeneratorUrl);
  }
  if (open) {
    openUrl(mpdInfo ? generateUrlGeneratorUrl(mpdInfo, port, asset) : `http://localhost:${port}/urlgen/`);
  }

  if (useFaultProxy) {
    const existingProxy = dashProxyRegistry.get(name);
    if (existingProxy) {
      await existingProxy.close();
      dashProxyRegistry.delete(name);
    }

    // Enable manifest preservation if requested
    let preserve: DashFaultProxyOptions['preserve'] = undefined;

    // Generate multi-period manifest if no manifestUrl but periodCount is provided
    if (!manifestUrl && (periodCount !== undefined || periodDurations !== undefined)) {
      const effectivePeriodCount = periodCount ?? (periodDurations?.length ?? 1);
      const effectiveDurations = periodDurations || [];

      // If durations not provided, use default 60s per period
      if (effectiveDurations.length === 0) {
        for (let i = 0; i < effectivePeriodCount; i++) {
          effectiveDurations.push(60);
        }
      }

      try {
        const multiPeriodManifest = createMultiPeriodManifest(
          effectivePeriodCount,
          effectiveDurations,
          periodStartTimes,
          port,
          asset
        );

        // Create alias map for multi-period manifest
        // Create an alias entry for each period with period-specific information
        const aliasMap: Record<string, DashAliasMapEntry> = {};
        const calculatedStartTimes: number[] = periodStartTimes || [];
        if (calculatedStartTimes.length === 0) {
          let cumulativeTime = 0;
          for (let i = 0; i < effectivePeriodCount; i++) {
            calculatedStartTimes.push(cumulativeTime);
            cumulativeTime += effectiveDurations[i] || 0;
          }
        }

        // Create alias entries for each period
        // Use period-specific keys: "P0-rep1", "P1-rep1", etc.
        for (let i = 0; i < effectivePeriodCount; i++) {
          const periodId = `P${i}`;
          const periodKey = `${periodId}-1`; // Format: P0-1, P1-1, etc.
          aliasMap[periodKey] = {
            type: 'video',
            originalId: '1',
            representationId: '1',
            initializationPath: '1/init.mp4',
            mediaTemplate: '1/$Number$.m4s',
            startNumber: 1,
            timescale: 12800,
            replacements: {},
            periodId: periodId,
            periodStartTime: calculatedStartTimes[i]
          };
        }

        // Also create a default alias for backward compatibility
        aliasMap['1'] = {
          type: 'video',
          originalId: '1',
          representationId: '1',
          initializationPath: '1/init.mp4',
          mediaTemplate: '1/$Number$.m4s',
          startNumber: 1,
          timescale: 12800,
          replacements: {},
          periodId: 'P0',
          periodStartTime: calculatedStartTimes[0] || 0
        };

        preserve = {
          manifest: multiPeriodManifest,
          aliasMap
        };
        console.info(`📋 Multi-period manifest generated - ${effectivePeriodCount} period(s), total duration: ${effectiveDurations.reduce((sum, d) => sum + d, 0)}s`);
      } catch (error) {
        console.warn(`⚠️  Failed to create multi-period manifest:`, error instanceof Error ? error.message : String(error));
        console.info(`Falling back to standard livesim2 proxy mode`);
      }
    } else if (preserveManifest && manifestUrl && mpdInfo) {
      try {
        const preservedManifest = await createPreservedManifest(manifestUrl, {
          token: authToken,
          header: authHeader,
          file: authFile
        }, port);
        const aliasMap = createAliasMap(mpdInfo);
        preserve = {
          manifest: preservedManifest,
          aliasMap
        };
        console.info(`📋 Manifest preservation enabled - serving original structure with DRM removed`);
      } catch (error) {
        console.warn(`⚠️  Failed to create preserved manifest:`, error instanceof Error ? error.message : String(error));
        console.info(`Falling back to standard livesim2 proxy mode`);
      }
    }

    try {
      const proxy = await startDashFaultProxy({
        listenPort: port,
        upstreamPort: hostPortForContainer,
        preserve
      });
      dashProxyRegistry.set(name, proxy);
      console.info(`Fault proxy active: http://localhost:${port}/ → ${proxy.upstreamBase}/`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('EADDRINUSE') || errorMsg.includes('address already in use')) {
        // Port still in use - try one more time after aggressive cleanup
        console.warn(`⚠️  Port ${port} still in use, attempting aggressive cleanup and retry...`);
        try {
          // Kill all processes on the port again
          const lsofResult = spawnSync('lsof', ['-ti', `:${port}`], { stdio: 'pipe' });
          if (lsofResult.stdout && lsofResult.stdout.toString().trim()) {
            const pids = lsofResult.stdout.toString().trim().split('\n').filter(Boolean);
            for (const pid of pids) {
              try {
                spawnSync('kill', ['-9', pid], { stdio: 'pipe' });
                console.info(`Killed process ${pid} using port ${port} (retry)`);
              } catch {
                // Process might have already exited
              }
            }
          }
          // Wait longer for OS to release the port
          await new Promise(resolve => setTimeout(resolve, 1500));

          // Retry once
          const proxy = await startDashFaultProxy({
            listenPort: port,
            upstreamPort: hostPortForContainer,
            preserve
          });
          dashProxyRegistry.set(name, proxy);
          console.info(`Fault proxy active (after retry): http://localhost:${port}/ → ${proxy.upstreamBase}/`);
        } catch (retryError) {
          console.warn(`⚠️  Failed to start fault proxy on port ${port} after retry:`, retryError instanceof Error ? retryError.message : String(retryError));
          console.info(`Direct container access available on port ${hostPortForContainer}`);
          console.info(`Stream URL (direct): http://localhost:${hostPortForContainer}/livesim2/${asset}/${getMpdNameForAsset(asset)}`);
        }
      } else {
        console.warn(`⚠️  Failed to start fault proxy on port ${port}:`, errorMsg);
        console.info(`Direct container access available on port ${hostPortForContainer}`);
        console.info(`Stream URL (direct): http://localhost:${hostPortForContainer}/livesim2/${asset}/${getMpdNameForAsset(asset)}`);
      }
    }
  }
}

export async function stopLivesim2(options: LivesimStopOptions = {}): Promise<void> {
  const { name = DEFAULT_NAME } = options;

  console.info(`Stopping livesim2 container: ${name}`);

  try {
    await runDocker(['stop', name]);
    console.info(`Container stopped: ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/No such container/i.test(message) || /is not running/i.test(message)) {
      console.info(`Container ${name} is not running (nothing to stop).`);
    } else {
      throw err;
    }
  }

  const proxy = dashProxyRegistry.get(name);
  if (proxy) {
    await proxy.close();
    dashProxyRegistry.delete(name);
    console.info(`Fault proxy stopped: ${name}`);
  }

  // Stop log streaming
  const logProcess = logStreamProcesses.get(name);
  if (logProcess) {
    logProcess.kill();
    logStreamProcesses.delete(name);
    console.info(`Log streaming stopped: ${name}`);
  }
}

function startLogStreaming(name: string): void {
  // Stop any existing log stream for this container
  const existingProcess = logStreamProcesses.get(name);
  if (existingProcess) {
    existingProcess.kill();
    logStreamProcesses.delete(name);
  }

  // Wait a moment for container to be ready
  setTimeout(() => {
    try {
      const dockerPath = getDockerPath();
      const logProcess = spawn(dockerPath, ['logs', '-f', '--tail', '0', name], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      logProcess.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(line => line.trim());
        for (const line of lines) {
          // Parse JSON logs from livesim2 and format nicely
          try {
            const logEntry = JSON.parse(line);
            const msg = logEntry.msg || '';
            const level = logEntry.level || 'INFO';
            const time = logEntry.time ? new Date(logEntry.time).toLocaleTimeString() : '';

            // Format: [TIME] LEVEL: message
            console.info(`[${time}] ${level}: ${msg}`);
          } catch {
            // If not JSON, just print as-is
            console.info(`[livesim2] ${line}`);
          }
        }
      });

      logProcess.stderr?.on('data', (data: Buffer) => {
        console.error(`[livesim2] ${data.toString()}`);
      });

      logProcess.on('error', (err) => {
        console.warn(`Failed to stream logs for ${name}:`, err.message);
        logStreamProcesses.delete(name);
      });

      logProcess.on('exit', () => {
        logStreamProcesses.delete(name);
      });

      logStreamProcesses.set(name, logProcess);
      console.info(`📋 Streaming logs from container: ${name}`);
    } catch (err) {
      console.warn(`Failed to start log streaming for ${name}:`, err instanceof Error ? err.message : String(err));
    }
  }, 1000); // Wait 1 second for container to be ready
}

export async function logsLivesim2(options: LivesimLogsOptions = {}): Promise<void> {
  const { name = DEFAULT_NAME } = options;

  console.info(`Showing logs for livesim2 container: ${name}`);

  await runDocker(['logs', '-f', name]);
}

// Export manifest analysis functions for use by other modules
export { analyzeMPD, fetchMPD, parseMPD };
