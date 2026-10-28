import { XMLParser, XMLValidator } from "fast-xml-parser";
export interface MPDRepresentation {
  id: string;
  bandwidth: number;
  codecs?: string;
  width?: number;
  height?: number;
  contentType?: string;
  periodId?: string;
  timescale: number;
  durationTicks?: number;
  startNumber?: number;
}
export interface MPDInfo {
  url: string;
  type: "static" | "dynamic";
  duration?: number;
  minBufferTime?: number;
  /** Segment duration in media ticks; divide by timescale for seconds. */
  segmentDuration?: number;
  segmentDurationMs?: number;
  timescale?: number;
  startNumber?: number;
  representations: MPDRepresentation[];
  baseUrl?: string;
  availabilityTimeOffset?: number;
  timeShiftBufferDepth?: number;
  suggestedPresentationDelay?: number;
  minimumUpdatePeriod?: number;
  segmentTemplateType?: "number" | "time" | "timeline";
  hasSCTE35?: boolean;
  utcTiming?: boolean;
  availabilityStartTimeEpoch?: number;
  periodCount?: number;
}
const list = (value): any[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const attr = (node, name: string): string | undefined => node?.["@_" + name];
const numeric = (value): number | undefined =>
  value === undefined ? undefined : Number(value);
export function parseDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match =
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value,
    );
  if (!match || !match.slice(1).some(Boolean))
    throw new Error("Invalid ISO 8601 MPD duration");
  return (
    Number(match[1] ?? 0) * 86400 +
    Number(match[2] ?? 0) * 3600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0)
  );
}
export function parseMPD(text: string, url: string): MPDInfo {
  if (
    Buffer.byteLength(text) > 4 * 1024 * 1024 ||
    /<!DOCTYPE|<!ENTITY/i.test(text)
  )
    throw new Error("MPD exceeds supported XML limits");
  if (XMLValidator.validate(text) !== true)
    throw new Error("Malformed MPD XML");
  const root = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
  }).parse(text).MPD;
  if (!root) throw new Error("Expected an MPD document");
  const type = attr(root, "type") ?? "static";
  if (!["static", "dynamic"].includes(type))
    throw new Error("Invalid MPD type");
  const periods = list(root.Period);
  const info: MPDInfo = {
    url,
    type: type as "static" | "dynamic",
    duration: parseDuration(attr(root, "mediaPresentationDuration")),
    minBufferTime: parseDuration(attr(root, "minBufferTime")),
    timeShiftBufferDepth: parseDuration(attr(root, "timeShiftBufferDepth")),
    suggestedPresentationDelay: parseDuration(
      attr(root, "suggestedPresentationDelay"),
    ),
    minimumUpdatePeriod: parseDuration(attr(root, "minimumUpdatePeriod")),
    periodCount: periods.length,
    representations: [],
    utcTiming: !!root.UTCTiming,
    hasSCTE35: /scte35|SCTE-35/i.test(text),
    baseUrl:
      typeof root.BaseURL === "string" ? root.BaseURL : root.BaseURL?.["#text"],
  };
  const start = attr(root, "availabilityStartTime");
  if (start) {
    const date = Date.parse(start);
    if (!Number.isFinite(date))
      throw new Error("Invalid MPD availabilityStartTime");
    info.availabilityStartTimeEpoch = date / 1000;
  }
  for (const [index, period] of periods.entries())
    for (const adaptation of list(period.AdaptationSet)) {
      for (const representation of list(adaptation.Representation)) {
        const template = {
          ...root.SegmentTemplate,
          ...period.SegmentTemplate,
          ...adaptation.SegmentTemplate,
          ...representation.SegmentTemplate,
        };
        const timescale = numeric(attr(template, "timescale")) ?? 1;
        const firstS = list(template.SegmentTimeline?.S)[0];
        const ticks = numeric(attr(template, "duration") ?? attr(firstS, "d"));
        const bandwidth = numeric(attr(representation, "bandwidth"));
        if (
          !Number.isFinite(timescale) ||
          timescale <= 0 ||
          (ticks !== undefined && (!Number.isFinite(ticks) || ticks <= 0)) ||
          !Number.isFinite(bandwidth) ||
          bandwidth <= 0
        )
          throw new Error("Invalid MPD representation timing or bandwidth");
        const mime =
          attr(representation, "mimeType") ?? attr(adaptation, "mimeType");
        info.representations.push({
          id: String(attr(representation, "id") ?? info.representations.length),
          bandwidth,
          codecs: attr(representation, "codecs") ?? attr(adaptation, "codecs"),
          width: numeric(
            attr(representation, "width") ?? attr(adaptation, "width"),
          ),
          height: numeric(
            attr(representation, "height") ?? attr(adaptation, "height"),
          ),
          contentType: attr(adaptation, "contentType") ?? mime?.split("/")[0],
          periodId: attr(period, "id") ?? String(index),
          timescale,
          durationTicks: ticks,
          startNumber: numeric(attr(template, "startNumber")) ?? 1,
        });
        if (info.segmentDuration === undefined && ticks !== undefined) {
          info.segmentDuration = ticks;
          info.timescale = timescale;
          info.segmentDurationMs = (ticks / timescale) * 1000;
          info.startNumber = numeric(attr(template, "startNumber")) ?? 1;
          const media = attr(template, "media") ?? "";
          info.segmentTemplateType = template.SegmentTimeline
            ? "timeline"
            : media.includes("$Time$")
              ? "time"
              : "number";
          info.availabilityTimeOffset = numeric(
            attr(template, "availabilityTimeOffset"),
          );
        }
      }
    }
  if (!info.representations.length)
    throw new Error("MPD contains no supported representations");
  return info;
}
