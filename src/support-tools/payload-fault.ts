import { HttpError } from "./safe-http.js";
import type { LogicalMedia } from "./scenario.js";
export interface PayloadFault {
  kind: "malformed-manifest" | "damaged-media" | "wrong-track-init" | "stale-init";
  replacementTrack?: string;
}
/** Only advertised initialization bytes enter this bounded, per-run snapshot store. */
export class PayloadSnapshots {
  private inits = new Map<string, Buffer>();
  private bytes = 0;
  remember(resource: LogicalMedia, body: Buffer): void {
    if (resource.kind !== "init" || this.inits.has(resource.trackId)) return;
    if (this.inits.size >= 128 || this.bytes + body.length > 64 * 1024 * 1024)
      throw new HttpError(503, "Initialization snapshot capacity exceeded");
    this.inits.set(resource.trackId, Buffer.from(body)); this.bytes += body.length;
  }
  apply(fault: PayloadFault, resource: LogicalMedia, body: Buffer): Buffer {
    if (!body.length) throw new HttpError(422, "Payload faults require a nonempty valid control body");
    if (fault.kind === "malformed-manifest") {
      const text = body.toString("utf8");
      if (/^\s*#EXTM3U(?:\s|$)/.test(text)) return Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:invalid\n#EXTINF:invalid,\n');
      if (/<(?:\w+:)?MPD(?:\s|>)/.test(text)) return Buffer.from('<?xml version="1.0"?><MPD><Period');
      throw new HttpError(422, "Manifest control body is not HLS or DASH");
    }
    if (fault.kind === "damaged-media") {
      const bytes = Buffer.from(body); bytes.fill(0xff, 0, Math.min(4096, bytes.length));
      if (bytes.equals(body)) throw new HttpError(422, "Control media is already damaged");
      return bytes;
    }
    const snapshot = this.inits.get(fault.kind === "stale-init" ? resource.trackId : fault.replacementTrack!);
    if (!snapshot) throw new HttpError(422, "Fetch the advertised initialization control/donor before this payload action");
    if (snapshot.equals(body)) throw new HttpError(422, "Initialization payload requires different control and replacement bytes");
    return Buffer.from(snapshot);
  }
  snapshot() { return { initializationSnapshots: this.inits.size, bufferedBytes: this.bytes }; }
  close(): void { this.inits.clear(); this.bytes = 0; }
}
