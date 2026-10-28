
import fs from 'fs';
import path from 'path';

export interface StreamTemplate {
  name: string;
  description: string;
  asset: string;        // DASH asset
  hlsSource?: string;   // HLS source file (defaults to samples/bbb.mp4)
  segmentDuration: number;
  timescale: number;
  startNumber: number;
  bitrateLadder: number[];
  hasSCTE35: boolean;
  contentType: 'video' | 'audio' | 'mixed';
  sourceUrl?: string;  // For dynamic templates
  isDynamic?: boolean; // True for generated templates
}

export interface TemplateGenerationOptions {
  url: string;
  name?: string;
  authToken?: string;
  authHeader?: string;
  authFile?: string;
}

// Predefined templates
export const PREDEFINED_TEMPLATES: Record<string, StreamTemplate> = {
  sports: {
    name: 'Live Sports',
    description: 'High-bitrate sports event with SCTE-35 cues',
    asset: 'WAVE/vectors/cfhd_sets/12.5_25_50/t3/2022-10-17',
    hlsSource: 'samples/bbb.mp4', // HLS uses dummy content from /assets/hls-sample
    segmentDuration: 2002,
    timescale: 1000,
    startNumber: 1,
    bitrateLadder: [150000, 250000, 400000, 600000, 950000, 1400000, 2200000, 3450000, 4750000, 6000000],
    hasSCTE35: true,
    contentType: 'video'
  },

  'low-latency': {
    name: 'Ultra Low Latency',
    description: 'Sub-second latency streaming for real-time applications',
    asset: 'WAVE/vectors/cfhd_sets/12.5_25_50/t3/2022-10-17',
    hlsSource: 'samples/bbb.mp4', // HLS uses dummy content from /assets/hls-sample
    segmentDuration: 200,
    timescale: 1000,
    startNumber: 1,
    bitrateLadder: [250000, 500000, 750000, 1000000],
    hasSCTE35: false,
    contentType: 'video'
  },

  ott: {
    name: 'OTT Premium',
    description: 'Premium OTT streaming with 4K support',
    asset: 'WAVE/vectors/cfhd_sets/12.5_25_50/t3/2022-10-17',
    hlsSource: 'samples/bbb.mp4', // HLS uses dummy content from /assets/hls-sample
    segmentDuration: 6000,
    timescale: 1000,
    startNumber: 1,
    bitrateLadder: [800000, 1200000, 2400000, 4800000, 7200000, 10800000],
    hasSCTE35: true,
    contentType: 'video'
  },

  news: {
    name: '24/7 News',
    description: 'Continuous news broadcast',
    asset: 'WAVE/vectors/cfhd_sets/12.5_25_50/t3/2022-10-17',
    hlsSource: 'samples/bbb.mp4', // HLS uses dummy content from /assets/hls-sample
    segmentDuration: 6000,
    timescale: 1000,
    startNumber: 1,
    bitrateLadder: [150000, 250000, 400000, 600000, 950000],
    hasSCTE35: false,
    contentType: 'mixed'
  },

  mobile: {
    name: 'Mobile Streaming',
    description: 'Mobile-optimized with battery efficiency',
    asset: 'WAVE/vectors/cfhd_sets/12.5_25_50/t3/2022-10-17',
    hlsSource: 'samples/bbb.mp4', // HLS uses dummy content from /assets/hls-sample
    segmentDuration: 4000,
    timescale: 1000,
    startNumber: 1,
    bitrateLadder: [80000, 120000, 250000, 500000, 800000],
    hasSCTE35: false,
    contentType: 'video'
  }
};

// Dynamic template generation
export async function createTemplateFromUrl(options: TemplateGenerationOptions): Promise<StreamTemplate> {
  const { url, name } = options;

  if (url.includes('.mpd') || url.includes('DASH') || url.includes('dash')) {
    return await createTemplateFromDash(url, name, options);
  } else if (url.includes('.m3u8') || url.includes('HLS') || url.includes('hls')) {
    return await createTemplateFromHls(url, name, options);
  } else {
    throw new Error('Unsupported manifest format. Use .mpd for DASH or .m3u8 for HLS');
  }
}

async function createTemplateFromDash(url: string, name?: string, options?: TemplateGenerationOptions): Promise<StreamTemplate> {
  // Import the analysis function dynamically to avoid circular dependencies
  const { analyzeMPD } = await import('./dash-sim-runner.js');

  try {
    // Analyze the real manifest to extract parameters
    const mpdInfo = await analyzeMPD(url, {
      token: options?.authToken,
      header: options?.authHeader,
      file: options?.authFile
    });

    // Extract real parameters from the manifest
    const bitrates = mpdInfo.representations
      .map(rep => rep.bandwidth)
      .sort((a, b) => a - b); // Sort ascending

    // Convert segment duration from seconds to milliseconds (default to 2000ms if not available)
    const segmentDuration = mpdInfo.segmentDuration ? Math.round(mpdInfo.segmentDuration * 1000) : 2000;

    const startNumber = mpdInfo.startNumber || 1;
    const timescale = mpdInfo.timescale || 1000;
    const hasSCTE35 = mpdInfo.hasSCTE35 || false;

    // Determine content type based on representations
    const contentType = determineContentType(mpdInfo.representations);

    const templateName = name || `Auto-DASH-${extractDomain(url)}-${contentType}`;

    console.info(`📊 Extracted from manifest:`);
    console.info(`   Bitrates: ${bitrates.join(', ')} bps`);
    console.info(`   Segment duration: ${segmentDuration}ms`);
    console.info(`   Timescale: ${timescale}`);
    console.info(`   Start number: ${startNumber}`);
    console.info(`   Content type: ${contentType}`);
    console.info(`   SCTE-35 cues: ${hasSCTE35 ? 'Present' : 'Not detected'}`);

    return {
      name: templateName,
      description: `Generated from ${url}`,
      asset: 'WAVE/vectors/cfhd_sets/12.5_25_50/t3/2022-10-17', // Keep default asset for now
      segmentDuration,
      timescale,
      startNumber,
      bitrateLadder: bitrates,
      hasSCTE35,
      contentType,
      sourceUrl: url,
      isDynamic: true
    };
  } catch (error) {
    console.warn(`⚠️  Failed to analyze manifest ${url}, falling back to basic template:`, error instanceof Error ? error.message : String(error));
    return createBasicTemplateFromDash(url, name);
  }
}

function createBasicTemplateFromDash(url: string, name?: string): StreamTemplate {
  const contentType = 'video';
  const templateName = name || `Auto-DASH-${extractDomain(url)}-${contentType}`;

  return {
    name: templateName,
    description: `Generated from ${url} (fallback - analysis failed)`,
    asset: 'WAVE/vectors/cfhd_sets/12.5_25_50/t3/2022-10-17',
    segmentDuration: 2000,
    timescale: 1000,
    startNumber: 1,
    bitrateLadder: [150000, 250000, 400000, 600000, 950000],
    hasSCTE35: false,
    contentType: contentType,
    sourceUrl: url,
    isDynamic: true
  };
}

async function createTemplateFromHls(url: string, name?: string, options?: TemplateGenerationOptions): Promise<StreamTemplate> {
  // For now, create a basic HLS template - in a full implementation,
  // we'd need to import and use the HLS analyzer
  const contentType = 'mixed';
  const templateName = name || `Auto-HLS-${extractDomain(url)}-${contentType}`;

  return {
    name: templateName,
    description: `Generated from ${url}`,
    asset: 'WAVE/vectors/cfhd_sets/12.5_25_50/t3/2022-10-17', // Default HLS asset
    segmentDuration: 6000, // Default 6 seconds
    timescale: 1000,
    startNumber: 1,
    bitrateLadder: [150000, 250000, 400000, 600000, 950000],
    hasSCTE35: false,
    contentType: contentType,
    sourceUrl: url,
    isDynamic: true
  };
}

// Helper functions
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '').split('.')[0];
  } catch {
    return 'unknown';
  }
}

function determineContentType(representations: Array<{ codecs?: string }>): 'video' | 'audio' | 'mixed' {
  const hasVideo = representations.some(rep =>
    rep.codecs?.includes('avc1') ||
    rep.codecs?.includes('hev1') ||
    rep.codecs?.includes('hvc1') ||
    rep.codecs?.includes('vp9') ||
    rep.codecs?.includes('av01')
  );
  const hasAudio = representations.some(rep =>
    rep.codecs?.includes('mp4a') ||
    rep.codecs?.includes('ac-3') ||
    rep.codecs?.includes('ec-3') ||
    rep.codecs?.includes('opus')
  );

  if (hasVideo && hasAudio) return 'mixed';
  if (hasVideo) return 'video';
  if (hasAudio) return 'audio';
  return 'video'; // Default fallback
}

// Template storage - file-based persistence
const TEMPLATES_FILE = path.resolve(process.cwd(), '.hls-dash-manifest-templates.json');

// Cache for loaded templates
let loadedTemplates: Record<string, StreamTemplate> | null = null;

function loadTemplatesFromFile(): Record<string, StreamTemplate> {
  if (loadedTemplates !== null) {
    return loadedTemplates;
  }

  try {
    if (fs.existsSync(TEMPLATES_FILE)) {
      const content = fs.readFileSync(TEMPLATES_FILE, 'utf8');
      loadedTemplates = JSON.parse(content);
    } else {
      loadedTemplates = {};
    }
  } catch {
    console.warn(`Warning: Could not load templates from .hls-dash-manifest-templates.json, starting with empty templates`);
    loadedTemplates = {};
  }

  return loadedTemplates!;
}

function saveTemplatesToFile(templates: Record<string, StreamTemplate>): void {
  try {
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
    loadedTemplates = templates; // Update cache
  } catch (error) {
    console.error(`Error: Could not save templates to .hls-dash-manifest-templates.json:`, error);
  }
}

export function loadSavedTemplates(): Record<string, StreamTemplate> {
  return loadTemplatesFromFile();
}

export function saveTemplate(name: string, template: StreamTemplate): void {
  const templates = loadTemplatesFromFile();
  templates[name] = template;
  saveTemplatesToFile(templates);
  console.info(`💾 Template "${name}" saved`);
}

export function getTemplate(name: string): StreamTemplate | null {
  const savedTemplates = loadSavedTemplates();
  return PREDEFINED_TEMPLATES[name] || savedTemplates[name] || null;
}

export function listTemplates(): Array<{name: string, template: StreamTemplate}> {
  const savedTemplates = loadSavedTemplates();
  const allTemplates = { ...PREDEFINED_TEMPLATES, ...savedTemplates };
  return Object.entries(allTemplates).map(([name, template]) => ({ name, template }));
}

export function getTemplateNames(): string[] {
  const savedTemplates = loadSavedTemplates();
  const allTemplates = { ...PREDEFINED_TEMPLATES, ...savedTemplates };
  return Object.keys(allTemplates);
}
