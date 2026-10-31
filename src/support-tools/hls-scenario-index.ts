import { attributes, variantEntries } from "./hls-playlist.js";
import { HttpError } from "./safe-http.js";
import type { LogicalMedia, TrackType } from "./scenario.js";

/** Only advertised playlists and EXT-X-MAP resources; never guess media identity. */
export class HlsScenarioIndex {
  private entries = new Map<string, LogicalMedia>();
  private tracks = new Map<string, string>();
  constructor(root: string, private initialization = false, private capacity = 10000) {
    const key = this.canonical(root);
    this.entries.set(key, { kind: "manifest", trackId: "root", trackType: "root", key: `hls:manifest:${key}` });
  }
  private canonical(value: string): string {
    const url = new URL(value); url.hash = ""; return url.href;
  }
  available(resource: string, track: string): boolean {
    for (const entry of this.entries.values()) if (entry.kind === resource && [entry.trackId, entry.trackType, "any"].includes(track)) return true;
    return false;
  }
  resolve(value: string): LogicalMedia | undefined { return this.entries.get(this.canonical(value)); }
  observe(text: string, base: string, owner: string): void {
    const parent = this.resolve(owner);
    if (parent?.kind !== "manifest") return;
    const entries = new Map(this.entries), tracks = new Map(this.tracks);
    const track = (value: string, type: TrackType) => {
      const key = `${type}:${this.canonical(value)}`;
      let id = tracks.get(key);
      if (!id) {
        id = `${type}:${[...tracks.values()].filter(id => id.startsWith(type + ":")).length}`;
        tracks.set(key, id);
      }
      if (tracks.size > 128) throw new HttpError(503, "HLS scenario track capacity reached");
      return { trackId: id, trackType: type };
    };
    const put = (value: string, resource: LogicalMedia) => {
      const key = this.canonical(value), previous = entries.get(key);
      if (previous && (previous.kind !== resource.kind || previous.trackId !== resource.trackId))
        throw new HttpError(422, "HLS scenario resource has ambiguous track or initialization ownership");
      entries.set(key, resource);
      if (entries.size > this.capacity) throw new HttpError(503, "HLS scenario resource capacity reached");
    };
    for (const variant of variantEntries(text)) {
      const url = new URL(variant.uri, base).href;
      put(url, { kind: "manifest", ...track(url, "video"), key: `hls:manifest:${this.canonical(url)}` });
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("#EXT-X-MEDIA:")) continue;
      const attr = attributes(line), type = attr.TYPE === "AUDIO" ? "audio" : attr.TYPE === "SUBTITLES" ? "text" : undefined;
      if (!type || !attr.URI) continue;
      const url = new URL(attr.URI, base).href;
      put(url, { kind: "manifest", ...track(url, type), key: `hls:manifest:${this.canonical(url)}` });
    }
    if (this.initialization) for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("#EXT-X-MAP:")) continue;
      const uri = attributes(line).URI;
      if (!uri) throw new HttpError(422, "HLS initialization map requires a URI");
      const url = new URL(uri, base).href;
      // A direct media playlist does not declare whether it is audio or video.
      // Keep root ownership instead of guessing a track from its filename.
      const owningTrack = { trackId: parent.trackId, trackType: parent.trackType };
      put(url, { kind: "init", ...owningTrack, key: `hls:init:${this.canonical(url)}` });
    }
    this.entries = entries; this.tracks = tracks;
  }
}
