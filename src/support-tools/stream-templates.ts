import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { httpUrl } from "./safe-http.js";
export interface StreamTemplate {
  name: string;
  description: string;
  asset: string;
  hlsSource?: string;
  segmentDuration: number;
  timescale: number;
  startNumber: number;
  bitrateLadder: number[];
  hasSCTE35: boolean;
  contentType: "video" | "audio" | "mixed";
  sourceUrl?: string;
  isDynamic?: boolean;
  protocol?: "hls" | "dash";
  supported?: boolean;
  windowSegments?: number;
  rendition?: "all" | "low" | "main";
  segmentFormat?: "ts" | "fmp4";
  lowLatency?: boolean;
}
export interface TemplateGenerationOptions {
  url: string;
  name?: string;
  authToken?: string;
  authHeader?: string;
  authFile?: string;
  allowedOrigins?: string[];
}
const base = {
  asset: "sample",
  segmentDuration: 2000,
  timescale: 1000,
  startNumber: 1,
  hasSCTE35: false,
  contentType: "mixed" as const,
  protocol: "hls" as const,
  supported: true,
};
export const PREDEFINED_TEMPLATES: Record<string, StreamTemplate> = {
  sports: {
    ...base,
    name: "Live motion sample",
    description:
      "360p moving test pattern and tone; 12-second live window; no ad signaling",
    bitrateLadder: [765536],
    rendition: "main",
    windowSegments: 6,
  },
  news: {
    ...base,
    name: "Long live window",
    description: "Two H.264/AAC renditions with a 60-second live window",
    bitrateLadder: [303056, 765536],
    windowSegments: 30,
  },
  ott: {
    ...base,
    name: "Two rendition sample",
    description: "180p and 360p H.264/AAC live sample for quality switching",
    bitrateLadder: [303056, 765536],
    windowSegments: 6,
  },
  mobile: {
    ...base,
    name: "Small rendition",
    description: "180p H.264/AAC sample with a 12-second live window",
    bitrateLadder: [303056],
    rendition: "low",
    windowSegments: 6,
  },
  "low-latency": {
    ...base,
    name: "Low latency",
    description:
      "Low-latency live: fMP4 parts, preload hints and blocking reload (HLS) or chunked segments (DASH with --sim-type dash)",
    bitrateLadder: [402349, 1004447, 2366949],
    windowSegments: 6,
    lowLatency: true,
  },
  ladder: {
    ...base,
    name: "fMP4 ladder",
    description: "234p, 432p and 720p H.264 in fMP4 with separate AAC audio; 12-second live window",
    bitrateLadder: [402349, 1004447, 2366949],
    windowSegments: 6,
    segmentFormat: "fmp4",
  },
};
export async function createTemplateFromUrl(
  options: TemplateGenerationOptions,
): Promise<StreamTemplate> {
  const url = httpUrl(options.url);
  const name = options.name ?? `Imported-${url.hostname}`;
  const auth = {
    token: options.authToken,
    header: options.authHeader,
    file: options.authFile,
  };
  if (url.pathname.toLowerCase().endsWith(".m3u8")) {
    const { analyzeHLS } = await import("./hls-sim-runner.js");
    const info = await analyzeHLS(options.url, auth, options.allowedOrigins);
    return {
      ...base,
      name,
      description: "Imported HLS source; startup proxies its actual media",
      sourceUrl: options.url,
      isDynamic: true,
      segmentDuration: info.segmentDurationMs,
      bitrateLadder: info.bitrateLadder,
      hasSCTE35: info.hasSCTE35,
    };
  }
  if (url.pathname.toLowerCase().endsWith(".mpd")) {
    const { analyzeMPD } = await import("./dash-sim-runner.js");
    const info = await analyzeMPD(options.url, auth, options.allowedOrigins);
    const video = info.representations.filter(
      (r) => r.contentType === "video" || (r.width ?? 0) > 0,
    );
    const duration = info.segmentDurationMs;
    if (!duration || !Number.isFinite(duration))
      throw new Error("Source MPD has no supported segment duration");
    return {
      ...base,
      name,
      description:
        "Imported DASH timing; startup uses validated local media, not a replica of the source",
      sourceUrl: options.url,
      isDynamic: true,
      protocol: "dash",
      segmentDuration: duration,
      timescale: info.timescale ?? 1,
      startNumber: info.startNumber ?? 1,
      bitrateLadder: (video.length ? video : info.representations)
        .map((r) => r.bandwidth)
        .sort((a, b) => a - b),
      hasSCTE35: info.hasSCTE35,
    };
  }
  throw new Error("Unsupported manifest path; use .m3u8 or .mpd");
}
const file = () =>
  path.resolve(process.cwd(), ".hls-dash-manifest-templates.json");
function validate(template: StreamTemplate): void {
  if (
    !template ||
    typeof template !== "object" ||
    typeof template.name !== "string" ||
    !template.name ||
    !Number.isFinite(template.segmentDuration) ||
    template.segmentDuration <= 0 ||
    !Array.isArray(template.bitrateLadder) ||
    template.bitrateLadder.some((n) => !Number.isFinite(n) || n <= 0)
  )
    throw new Error("Invalid template metadata");
  if (template.sourceUrl) httpUrl(template.sourceUrl);
}
export function loadSavedTemplates(): Record<string, StreamTemplate> {
  if (!fs.existsSync(file())) return {};
  const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
  if (!saved || typeof saved !== "object" || Array.isArray(saved))
    throw new Error("Saved templates must be a JSON object");
  for (const template of Object.values(saved))
    validate(template as StreamTemplate);
  return saved;
}
export function saveTemplate(name: string, template: StreamTemplate): void {
  if (
    !name ||
    name.length > 128 ||
    ["__proto__", "constructor", "prototype"].includes(name)
  )
    throw new Error("Invalid template name");
  validate(template);
  const templates = { ...loadSavedTemplates(), [name]: template };
  const temporary = file() + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(templates, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(temporary, file());
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  console.info(`Template "${name}" saved`);
}
export function getTemplate(name: string): StreamTemplate | undefined {
  return { ...PREDEFINED_TEMPLATES, ...loadSavedTemplates() }[name];
}
export function listTemplates(): Array<{
  name: string;
  template: StreamTemplate;
}> {
  return Object.entries({
    ...PREDEFINED_TEMPLATES,
    ...loadSavedTemplates(),
  }).map(([name, template]) => ({ name, template }));
}
export function getTemplateNames(): string[] {
  return listTemplates().map((t) => t.name);
}
