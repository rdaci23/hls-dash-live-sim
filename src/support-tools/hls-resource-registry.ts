import { createHash } from "node:crypto";
import { HttpError, OriginPolicy } from "./safe-http.js";
import { mediaSegments, rewritePlaylist } from "./hls-playlist.js";

type Kind = "playlist" | "segment" | "init" | "key";
interface Resource {
  url: string;
  kind: Kind;
  owners: Set<string>;
  expires: number;
}

/** Keep every advertised URI reachable; retire references only after a grace period. */
export class HlsResourceRegistry {
  private resources = new Map<string, Resource>();
  private playlists = new Map<
    string,
    { ids: Set<string>; retention: number }
  >();
  private prunedAt = -Infinity;
  constructor(
    private clock = () => performance.now(),
    private capacity = 100000,
  ) {}

  snapshot(){this.prune(true);return{registryResources:this.resources.size,registryPlaylists:this.playlists.size};}
  close(){this.resources.clear();this.playlists.clear();}
  private release(owner: string, now: number): void {
    const previous = this.playlists.get(owner);
    if (!previous) return;
    for (const id of previous.ids) {
      const resource = this.resources.get(id);
      if (resource?.owners.delete(owner))
        resource.expires = Math.max(resource.expires, now + previous.retention);
    }
    this.playlists.delete(owner);
  }
  private prune(force = false): void {
    const now = this.clock();
    if (!force && now - this.prunedAt < 1000) return;
    this.prunedAt = now;
    this.resources.forEach((resource,id)=>{
      if (!resource.owners.size && resource.expires <= now) {
        this.resources.delete(id);
        if (resource.kind === "playlist") this.release(resource.url, now);
      }
    });
  }
  get(id: string): { url: string; kind: Kind } | undefined {
    this.prune();
    return this.resources.get(id);
  }
  rewrite(
    text: string,
    base: string,
    owner: string,
    policy: OriginPolicy,
  ): string {
    this.prune();
    const next = new Map<string, { url: string; kind: Kind }>();
    const body = rewritePlaylist(text, base, (url, kind) => {
      policy.check(url);
      const id = createHash("sha256")
        .update(kind + ":" + url)
        .digest("hex")
        .slice(0, 32);
      next.set(id, { url, kind });
      return `/r/${id}${kind === "playlist" ? ".m3u8" : kind === "key" ? ".key" : ".bin"}`;
    });
    this.prune(true);
    const additions = [...next.keys()].filter(
      (id) => !this.resources.has(id),
    ).length;
    if (
      this.resources.size + additions > this.capacity ||
      (!this.playlists.has(owner) && this.playlists.size >= 128)
    )
      throw new HttpError(
        503,
        "HLS resource capacity reached; active playlist references were preserved",
      );
    const durations = mediaSegments(text).map((segment) => segment.duration);
    const previous = this.playlists.get(owner);
    const retention = Math.max(
      previous?.retention ?? 0,
      durations.length ? 0 : 30000,
      (durations.reduce((sum, value) => sum + value, 0) +
        Math.max(0, ...durations)) *
        1000,
    );
    const now = this.clock();
    this.release(owner, now);
    for (const [id, value] of next) {
      let resource = this.resources.get(id);
      if (!resource) {
        resource = { ...value, owners: new Set(), expires: 0 };
        this.resources.set(id, resource);
      }
      resource.owners.add(owner);
    }
    this.playlists.set(owner, { ids: new Set(next.keys()), retention });
    return body;
  }
}
