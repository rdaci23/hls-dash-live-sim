import { HttpError } from "./safe-http.js";

export interface HlsSegment {
  duration: number;
  uri: string;
}
export function validateSupportedHls(text: string): void {
  if (!text.trimStart().startsWith("#EXTM3U"))
    throw new HttpError(422, "Origin did not return an HLS playlist");
  if (/^#EXT-X-DEFINE[:\s]|\{\$[^}]+\}/m.test(text))
    throw new HttpError(
      422,
      "HLS variable substitution (EXT-X-DEFINE) is not supported yet",
    );
  if (
    /^#EXT-X-(PART|PART-INF|PRELOAD-HINT|RENDITION-REPORT|SKIP)(:|\s|$)|^#EXT-X-SERVER-CONTROL:.*(?:CAN-BLOCK-RELOAD=YES|CAN-SKIP-UNTIL=)/m.test(
      text,
    )
  )
    throw new HttpError(
      422,
      "Low-latency HLS parts, blocking reload and delta updates are not supported yet",
    );
}
export function attributes(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  const source = line.slice(line.indexOf(":") + 1);
  const pattern = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let match: RegExpExecArray;
  while ((match = pattern.exec(source)))
    result[match[1]] = match[2] ?? match[3];
  return result;
}
export function mediaSegments(text: string): HlsSegment[] {
  const segments: HlsSegment[] = [];
  let duration: number | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      duration = Number(line.slice(8).split(",")[0]);
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("Invalid HLS segment duration");
    } else if (line && !line.startsWith("#") && duration !== undefined) {
      segments.push({ duration, uri: line });
      duration = undefined;
    }
  }
  return segments;
}
export function variantEntries(
  text: string,
): Array<{ uri: string; attributes: Record<string, string> }> {
  const result: Array<{ uri: string; attributes: Record<string, string> }> = [];
  let pending: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) pending = attributes(line);
    else if (pending && line && !line.startsWith("#")) {
      result.push({ uri: line, attributes: pending });
      pending = undefined;
    }
  }
  return result;
}
export function rewritePlaylist(
  text: string,
  base: string,
  register: (url: string, kind: "playlist" | "segment" | "init" | "key") => string,
): string {
  validateSupportedHls(text);
  let variant = false;
  return text
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      if (!line) return raw;
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        variant = true;
        return line;
      }
      if (line.startsWith("#")) {
        const tag = line.split(":")[0];
        const kind = ["#EXT-X-KEY", "#EXT-X-SESSION-KEY"].includes(tag)
          ? "key"
          : tag === "#EXT-X-MAP" ? "init" : [
                "#EXT-X-MEDIA",
                "#EXT-X-I-FRAME-STREAM-INF",
                "#EXT-X-RENDITION-REPORT",
              ].includes(tag)
            ? "playlist"
            : "segment";
        return line.replace(/\bURI="([^"]+)"/g, (_all, uri) => {
          // Data keys carry no HTTP request; preserve them without forwarding credentials.
          if (kind === "key" && uri.startsWith("data:")) return `URI="${uri}"`;
          return `URI="${register(new URL(uri, base).href, kind)}"`;
        });
      }
      const url = new URL(line, base);
      const kind =
        variant
          ? "playlist"
          : "segment";
      variant = false;
      return register(url.href, kind);
    })
    .join("\n");
}
