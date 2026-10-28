import { XMLParser } from "fast-xml-parser";
import { parseMPD } from "./mpd.js";

const list = (value): any[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Deliberately narrow input subset verified with the pinned livesim2 engine. */
export function validateDashAsset(text: string): void {
  const info = parseMPD(text, "fixture://manifest.mpd");
  const fail = (reason: string): never => {
    throw new Error(`Unsupported DASH asset for the pinned livesim2 adapter: ${reason}`);
  };
  if (info.type !== "static" || info.periodCount !== 1)
    fail("use a static MPD with exactly one source Period");
  const root = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
  }).parse(text).MPD;
  const inspect = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (["BaseURL", "Location", "SegmentList", "SegmentBase"].includes(key))
        fail(`${key} is outside the local SegmentTemplate asset subset`);
      if (key === "@_href") fail("external XML references are not supported");
      if (!key.startsWith("@_")) inspect(value);
    }
  };
  inspect(root);
  const period = list(root.Period)[0];
  if (
    Object.hasOwn(root, "SegmentTemplate") ||
    Object.hasOwn(period, "SegmentTemplate")
  )
    fail("put SegmentTemplate on each AdaptationSet");
  for (const adaptation of list(period.AdaptationSet)) {
    const template = adaptation.SegmentTemplate;
    if (!template || Array.isArray(template))
      fail("each AdaptationSet needs one SegmentTemplate");
    for (const representation of list(adaptation.Representation))
      if (Object.hasOwn(representation, "SegmentTemplate"))
        fail(
          "Representation-level SegmentTemplate is unsupported; move it to AdaptationSet",
        );
    const media = template["@_media"] ?? "";
    const initialization = template["@_initialization"] ?? "";
    for (const value of [media, initialization]) {
      if (
        !value ||
        /^[\/\\]|[:?#\\]/.test(value) ||
        value.split("/").includes("..")
      )
        fail("media and initialization must be local relative paths");
      if (/\$[^$]+%[^$]*\$/.test(value))
        fail(
          "formatted template identifiers are unsupported; use plain $Number$ or $Time$",
        );
    }
    if (media.includes("$Number$") && !media.includes("$Time$")) {
      if (Object.hasOwn(template, "SegmentTimeline"))
        fail("SegmentTimeline with $Number$ is unsupported; use $Time$");
    } else if (media.includes("$Time$") && !media.includes("$Number$")) {
      if (!template.SegmentTimeline) fail("$Time$ requires SegmentTimeline");
      const entries = list(template.SegmentTimeline.S);
      if (!entries.length)
        fail("SegmentTimeline must contain finite segment entries");
      for (const entry of entries) {
        const repeat = Number(entry["@_r"] ?? 0);
        if (repeat < 0)
          fail("open-ended SegmentTimeline repeats are unsupported");
        if (
          !Number.isSafeInteger(repeat) ||
          !Number.isFinite(Number(entry["@_d"])) ||
          Number(entry["@_d"]) <= 0 ||
          (entry["@_t"] !== undefined &&
            (!Number.isFinite(Number(entry["@_t"])) ||
              Number(entry["@_t"]) < 0))
        )
          fail(
            "SegmentTimeline requires positive durations, nonnegative times and finite integer repeats",
          );
      }
    } else fail("media must address segments using plain $Number$ or $Time$");
  }
}
