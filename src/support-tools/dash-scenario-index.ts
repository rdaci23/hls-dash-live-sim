import { XMLParser } from "fast-xml-parser";
import { parseMPD } from "./mpd.js";
import { HttpError } from "./safe-http.js";
import type { LogicalMedia, TrackType } from "./scenario.js";
const list = (value): any[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const problem = (): never => {
  throw new HttpError(
    422,
    "DASH scenario indexing requires local SegmentTemplate media with a finite Number/Time SegmentTimeline",
  );
};
function uint(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) problem();
  const number = BigInt(value as string);
  if (number > 0xffffffffffffffffn) problem();
  return number;
}

/** Identify advertised media from the MPD, rather than guessing from file extensions. */
export class DashScenarioIndex {
  private dynamic = false;
  advancing(): boolean { return this.dynamic; }
  private entries = new Map<string, { media: LogicalMedia; expires: number }>();
  private tracks = new Map<string, string>();
  private scopes = new Map<string, number>();
  constructor(
    private clock = () => performance.now(),
    private capacity = 10000,
    private strictInitialization = false,
  ) {}
  private canonical(value: string): string {
    const url = new URL(value);
    return url.origin + url.pathname;
  }
  private prune(): void {
    const now = this.clock();
    for (const [key, value] of this.entries)
      if (value.expires < now) this.entries.delete(key);
  }
  available(resource: string, track: string): boolean {
    this.prune();
    for (const entry of this.entries.values()) if (entry.media.kind === resource && [entry.media.trackId, entry.media.trackType, "any"].includes(track)) return true;
    return false;
  }
  resolve(value: string): LogicalMedia | undefined {
    this.prune();
    return this.entries.get(this.canonical(value))?.media;
  }
  observe(text: string, base: string): void {
    const info = parseMPD(text, base);
    const root = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      parseTagValue: false,
      parseAttributeValue: false,
      processEntities: false,
    }).parse(text).MPD;
    this.prune();
    const next = new Map<string, LogicalMedia>();
    const tracks = new Map(this.tracks),
      scopes = new Map(this.scopes);
    const source = new URL(base);
    const expires =
      this.clock() + Math.max(60000, (info.timeShiftBufferDepth ?? 30) * 2000);
    function local(value: string): URL {
      const url = new URL(value, base);
      if (url.origin !== source.origin || url.username || url.password)
        problem();
      return url;
    }
    const put = (value: string, media: LogicalMedia) => {
      const key = this.canonical(local(value).href);
      const previous = next.get(key);
      if (
        previous &&
        previous.key !== media.key &&
        (previous.kind !== "init" || media.kind !== "init" ||
          (this.strictInitialization && previous.trackId !== media.trackId))
      )
        problem(); // Ambiguous media must never be targeted by guessing.
      next.set(key, media);
      if (next.size > this.capacity)
        throw new HttpError(
          503,
          "DASH scenario manifest index capacity reached",
        );
    };
    if (root.BaseURL !== undefined || root.Location !== undefined) problem();
    for (const period of list(root.Period)) {
      if (period.BaseURL !== undefined) problem();
      for (const [adaptationIndex, adaptation] of list(
        period.AdaptationSet,
      ).entries()) {
        if (adaptation.BaseURL !== undefined) problem();
        for (const representation of list(adaptation.Representation)) {
          if (representation.BaseURL !== undefined) problem();
          const type =
            adaptation["@_contentType"] ??
            (
              representation["@_mimeType"] ??
              adaptation["@_mimeType"] ??
              ""
            ).split("/")[0];
          if (!["video", "audio", "text"].includes(type)) continue;
          const trackType = type as TrackType;
          const rawId = String(representation["@_id"] ?? "");
          const trackKey =
            this.canonical(base) +
            ":" +
            trackType +
            ":" +
            String(adaptation["@_id"] ?? adaptationIndex) +
            ":" +
            rawId;
          let trackId = tracks.get(trackKey);
          if (!trackId) {
            trackId = `${trackType}:${[...tracks.values()].filter((value) => value.startsWith(trackType + ":")).length}`;
            tracks.set(trackKey, trackId);
          }
          if (tracks.size > 128)
            throw new HttpError(503, "DASH scenario track capacity reached");
          const template = {
            ...root.SegmentTemplate,
            ...period.SegmentTemplate,
            ...adaptation.SegmentTemplate,
            ...representation.SegmentTemplate,
          };
          const substitute = (value: unknown): string => {
            if (typeof value !== "string") problem();
            return (value as string)
              .replaceAll("$RepresentationID$", rawId)
              .replaceAll("$Bandwidth$", String(representation["@_bandwidth"]));
          };
          const init = substitute(template["@_initialization"]),
            pattern = substitute(template["@_media"]);
          if (/\$/.test(init)) problem();
          const addressing = pattern.includes("$Time$")
            ? "time"
            : pattern.includes("$Number$")
              ? "number"
              : undefined;
          if (
            !addressing ||
            /\$/.test(
              pattern.replaceAll("$Time$", "0").replaceAll("$Number$", "0"),
            ) ||
            (pattern.includes("$Time$") && pattern.includes("$Number$"))
          )
            problem();
          const scopeKey = this.canonical(local(pattern).href);
          let scope = scopes.get(scopeKey);
          if (scope === undefined) {
            scope = scopes.size;
            scopes.set(scopeKey, scope);
          }
          if (scopes.size > 256)
            throw new HttpError(503, "DASH scenario template capacity reached");
          put(init, {
            kind: "init",
            trackId,
            trackType,
            key: `dash:${trackId}:init:${this.canonical(local(init).href)}`,
          });
          if (!Object.hasOwn(template, "SegmentTimeline")) problem();
          const timeline = list(template.SegmentTimeline?.S);
          let time = 0n,
            number = uint(template["@_startNumber"] ?? "1");
          for (const entry of timeline) {
            if (entry["@_t"] !== undefined) time = uint(entry["@_t"]);
            const duration = uint(entry["@_d"]);
            const repeat = Number(entry["@_r"] ?? 0);
            if (
              !duration ||
              !Number.isSafeInteger(repeat) ||
              repeat < 0 ||
              repeat > this.capacity
            )
              problem();
            for (let offset = 0; offset <= repeat; offset++) {
              if (time > 0xffffffffffffffffn || number > 0xffffffffffffffffn)
                problem();
              const value = (addressing === "time" ? time : number).toString();
              put(
                pattern.replaceAll(
                  addressing === "time" ? "$Time$" : "$Number$",
                  value,
                ),
                {
                  kind: "media",
                  trackId,
                  trackType,
                  key: `dash:${trackId}:scope:${scope}:${addressing}:${value}`,
                  locator: { kind: addressing, value },
                },
              );
              time += duration;
              number++;
            }
          }
        }
      }
    }
    if (!next.size) problem();
    if (
      this.entries.size +
        [...next.keys()].filter((key) => !this.entries.has(key)).length >
      this.capacity
    )
      throw new HttpError(503, "DASH scenario retained index capacity reached");
    for (const [key, media] of next) this.entries.set(key, { media, expires });
    this.dynamic = root["@_type"] === "dynamic";
    this.tracks = tracks;
    this.scopes = scopes;
  }
}
