import { attributes, variantEntries, mediaSegments } from "./hls-playlist.js";
import { HttpError } from "./safe-http.js";
import type { LogicalMedia, TrackType } from "./scenario.js";

/** Advertised playlists/init, and opt-in owned media; never guess resource identity. */
export class HlsScenarioIndex {
  private expirations = new Map<string,number>();
  private prune(): void { const now=performance.now();for(const [key,expires] of this.expirations)if(expires<now){this.entries.delete(key);this.expirations.delete(key);} }
  private entries = new Map<string, LogicalMedia>();
  private manifestCounts = new Map<string,number>();
  publicationAvailable(kind:string,track:string,count=1): boolean { if(kind === "rendition-lag")return this.advancing(track) && (this.manifestCounts.get(track) ?? 0) > count;this.prune();let found=false;for(const entry of this.entries.values())if(entry.kind === "media" && entry.trackId === track){found=true;if(!Number.isFinite(entry.availableAtMs))return false;}return this.mediaIndex && found; }
  private liveManifests = new Map<string,boolean>();
  advancing(track: string): boolean { return this.liveManifests.get(track) === true; }
  private tracks = new Map<string, string>();
  constructor(root: string, private initialization = false, private capacity = 10000, private mediaIndex = false) {
    const key = this.canonical(root);
    this.entries.set(key, { kind: "manifest", trackId: "root", trackType: "root", key: `hls:manifest:${key}` });
  }
  snapshot(){this.prune();return{indexEntries:this.entries.size,indexTracks:this.tracks.size};}
  close(){this.entries.clear();this.expirations.clear();this.tracks.clear();this.manifestCounts.clear();this.liveManifests.clear();}
  private canonical(value: string): string {
    const url = new URL(value); url.hash = ""; return url.href;
  }
  available(resource: string, track: string): boolean {
    this.prune();for (const entry of this.entries.values()) if (entry.kind === resource && [entry.trackId, entry.trackType, "any"].includes(track)) return true;
    return false;
  }
  resolve(value: string): LogicalMedia | undefined { this.prune();return this.entries.get(this.canonical(value)); }
  observe(text: string, base: string, owner: string): void {
    const parent = this.resolve(owner);
    if (parent?.kind !== "manifest") return;
    const expirations = new Map(this.expirations);
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
      entries.set(key, {...resource,...(this.mediaIndex?{sourceUrl:value}:{})});
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
    if(this.mediaIndex && parent.trackType !== "root"){
      const segments=mediaSegments(text),sequence=/^#EXT-X-MEDIA-SEQUENCE:(\d{1,20})\s*$/m.exec(text),starts=[...text.matchAll(/^#EXT-X-PROGRAM-DATE-TIME:(.+)$/gm)].map(match=>Date.parse(match[1]));
      if(!sequence && segments.length)throw new HttpError(422,"Owned media targeting needs advertised sequence metadata");
      const ttl=performance.now()+Math.max(60000,segments.reduce((sum,s)=>sum+s.duration,0)*2000);
      for(const [index,segment] of segments.entries()){
        const url=new URL(segment.uri,base).href,key=this.canonical(url),number=BigInt(sequence[1])+BigInt(index);
        if(number>0xffffffffffffffffn)throw new HttpError(422,"HLS media sequence exceeds supported bounds");
        put(url,{kind:"media",trackId:parent.trackId,trackType:parent.trackType,key:`hls:${parent.trackId}:media:${key}`,locator:{kind:"number",value:number.toString()},...(Number.isFinite(starts[index])?{availableAtMs:starts[index]+segment.duration*1000}:{})});expirations.set(key,ttl);
      }
    }
    this.entries = entries; this.tracks = tracks;this.expirations=expirations;
    this.manifestCounts.set(parent.trackId,mediaSegments(text).length);
    this.liveManifests.set(parent.trackId, /^#EXTINF:/m.test(text) && !/^#EXT-X-ENDLIST/m.test(text));
  }
}
