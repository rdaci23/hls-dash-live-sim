import fs from "node:fs";
import path from "node:path";
import { LiveHlsTimeline, type StreamMode } from "./live-hls.js";
import { HttpError } from "./safe-http.js";

/** One independently addressable fragment run inside a segment. */
interface CmafPart { offset: number; bytes: number; duration: number; independent: boolean }
interface CmafSegment { file: string; baseTime: string; duration: number; bytes: number; parts: CmafPart[] }
export interface CmafTrack {
  /** URL directory name: v0, v1, ... for video and a0 for audio. */
  name: string;
  id: string;
  type: "video" | "audio";
  codec: string;
  width?: number;
  height?: number;
  frameRate?: number;
  averageBandwidth: number;
  peakBandwidth: number;
  timescale: number;
  cycleTicks: number;
  init: string;
  segments: CmafSegment[];
}
interface Box { type: string; start: number; body: number; end: number }
function boxes(bytes: Buffer, start = 0, end = bytes.length): Box[] {
  const result: Box[] = [];
  for (let at = start; at < end;) {
    if (at + 8 > end) throw Error("Truncated sample box");
    const size = bytes.readUInt32BE(at);
    if (size < 8 || at + size > end) throw Error("Invalid sample box size");
    result.push({ type: bytes.toString("ascii", at + 4, at + 8), start: at, body: at + 8, end: at + size });
    at += size;
  }
  return result;
}
/** Each loop of the sample continues the previous one: shift every fragment's
 * decode time by whole loops and number the fragments uniquely. */
export function retimeSegment(input: Buffer, track: CmafTrack, sequence: number): Buffer {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= 0x0fffffff)
    throw new HttpError(410, "Sample sequence exceeds the supported lifetime");
  const bytes = Buffer.from(input);
  const offset = BigInt(Math.floor(sequence / track.segments.length)) * BigInt(track.cycleTicks);
  const shift = (box: Box, at: number) => {
    if (bytes[box.body] === 1) bytes.writeBigUInt64BE(bytes.readBigUInt64BE(at) + offset, at);
    else {
      const value = BigInt(bytes.readUInt32BE(at)) + offset;
      if (value > 0xffffffffn) throw new HttpError(410, "Sample timestamp exceeds its source field");
      bytes.writeUInt32BE(Number(value), at);
    }
  };
  let fragment = 0;
  for (const top of boxes(bytes)) {
    if (top.type === "sidx") shift(top, top.body + 12);
    if (top.type !== "moof") continue;
    for (const child of boxes(bytes, top.body, top.end)) {
      if (child.type === "mfhd") bytes.writeUInt32BE(sequence * 8 + ++fragment, child.body + 4);
      if (child.type === "traf")
        for (const inner of boxes(bytes, child.body, child.end)) if (inner.type === "tfdt") shift(inner, inner.body + 4);
    }
  }
  if (!fragment) throw Error("Sample segment has no movie fragment");
  return bytes;
}

/** Generated fMP4 HLS: a looping three-rendition ladder with separate audio.
 * In low-latency mode the playlists also advertise half-second parts, a
 * preload hint and blocking reload. */
export class CmafHlsSample {
  readonly tracks: readonly CmafTrack[];
  readonly partTarget: number;
  readonly targetDuration: number;
  private files = new Map<string, Buffer>();
  private timelines = new Map<string, LiveHlsTimeline>();
  constructor(readonly mode: StreamMode = "live", window = 6, clock = () => performance.now(), startedAt?: number, wallStartedAt = Date.now(), readonly lowLatency = false,
    root = path.resolve(__dirname, "assets/hls-cmaf-sample")) {
    if (lowLatency && mode !== "live") throw new Error("Low-latency HLS requires --mode live");
    const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8"));
    if (index.schemaVersion !== 1 || !Array.isArray(index.tracks) || !index.tracks.some((t: CmafTrack) => t.type === "video") || index.tracks.filter((t: CmafTrack) => t.type === "audio").length !== 1)
      throw Error("Unsupported fMP4 sample metadata");
    const started = startedAt ?? clock();
    this.tracks = index.tracks.map((t: CmafTrack) => ({ ...t, name: (t.type === "video" ? "v" : "a") + t.id.split(":")[1] }));
    for (const t of this.tracks) {
      if (!/^(video|audio):\d$/.test(t.id) || !Number.isSafeInteger(t.timescale) || t.timescale <= 0 || t.segments.length !== this.tracks[0].segments.length)
        throw Error("Invalid fMP4 sample track");
      for (const file of [t.init, ...t.segments.map(s => s.file)]) {
        if (!/^[a-z0-9-]+\.m4s$/.test(file)) throw Error("Invalid fMP4 sample resource");
        this.files.set(file, fs.readFileSync(path.join(root, file)));
      }
      let end = 0n;
      for (const s of t.segments) {
        const whole = this.files.get(s.file);
        if (BigInt(s.baseTime) !== end || whole.length !== s.bytes || !s.parts.length) throw Error("fMP4 sample segment metadata mismatch");
        let at = 0, ticks = 0;
        for (const part of s.parts) {
          // Every part must begin on a box boundary so it is decodable by itself.
          if (part.offset !== at || part.bytes <= 0 || part.duration <= 0 || !boxes(whole, part.offset, part.offset + part.bytes).some(b => b.type === "moof"))
            throw Error("fMP4 sample part metadata mismatch");
          at += part.bytes; ticks += part.duration;
        }
        if (at !== whole.length || ticks !== s.duration) throw Error("fMP4 sample parts do not cover their segment");
        end += BigInt(s.duration);
      }
      if (end !== BigInt(t.cycleTicks)) throw Error("fMP4 sample cycle mismatch");
      // One shared start offset keeps every track's wall-clock mapping identical.
      this.timelines.set(t.name, new LiveHlsTimeline(t.segments.map(s => ({ uri: s.file, duration: s.duration / t.timescale })), mode, window, clock, started, wallStartedAt, window * index.segmentSeconds));
    }
    const durations = this.tracks.flatMap(t => t.segments.map(s => s.duration / t.timescale));
    this.targetDuration = Math.round(Math.max(...durations));
    this.partTarget = Math.max(...this.tracks.flatMap(t => t.segments.flatMap(s => s.parts.map(p => p.duration / t.timescale))));
  }
  track(name: string): CmafTrack | undefined { return this.tracks.find(t => t.name === name); }
  timeline(name: string): LiveHlsTimeline | undefined { return this.timelines.get(name); }
  get videoTracks(): number { return this.tracks.filter(t => t.type === "video").length; }
  init(track: CmafTrack): Buffer { return this.files.get(track.init); }
  segment(track: CmafTrack, sequence: number): Buffer {
    return retimeSegment(this.files.get(track.segments[sequence % track.segments.length].file), track, sequence);
  }
  private source(track: CmafTrack, sequence: number): CmafSegment { return track.segments[sequence % track.segments.length]; }
  /** Stream time at which part `index` of a segment is complete. */
  private partEnd(track: CmafTrack, sequence: number, index: number): number {
    const parts = this.source(track, sequence).parts;
    return this.timelines.get(track.name).startOf(sequence) + parts.slice(0, index + 1).reduce((n, p) => n + p.duration, 0) / track.timescale;
  }
  /** Parts of the segment still being produced that are already complete. */
  private openParts(track: CmafTrack): { sequence: number; count: number } {
    const timeline = this.timelines.get(track.name), sequence = timeline.bounds().end, position = timeline.position();
    let count = 0;
    while (count < this.source(track, sequence).parts.length && this.partEnd(track, sequence, count) <= position + 0.000001) count++;
    return { sequence, count };
  }
  part(track: CmafTrack, sequence: number, index: number): Buffer {
    const part = this.source(track, sequence).parts[index];
    if (!part) throw new HttpError(404, "Unknown part");
    return this.segment(track, sequence).subarray(part.offset, part.offset + part.bytes);
  }
  partCount(track: CmafTrack, sequence: number): number { return this.source(track, sequence).parts.length; }
  /** Milliseconds until a part exists; 0 when it already does. */
  partWaitMs(track: CmafTrack, sequence: number, index: number): number {
    const timeline = this.timelines.get(track.name);
    return Math.max(0, (this.partEnd(track, sequence, index) - timeline.position()) * 1000);
  }
  /** Milliseconds a blocking playlist request must wait for `msn` (and `part`).
   * undefined means the request is too far ahead to be honoured. */
  reloadWaitMs(track: CmafTrack, msn: number, part?: number): number | undefined {
    if (!Number.isSafeInteger(msn) || msn < 0 || part !== undefined && (!Number.isSafeInteger(part) || part < 0)) return undefined;
    const timeline = this.timelines.get(track.name), { end } = timeline.bounds();
    // A part index past the end of its segment means the following segment.
    while (part !== undefined && part >= this.partCount(track, msn)) { part -= this.partCount(track, msn); msn++; }
    if (msn > end + 2) return undefined;
    const ready = part === undefined ? timeline.startOf(msn + 1) : this.partEnd(track, msn, part);
    return Math.max(0, (ready - timeline.position()) * 1000);
  }
  master(redundant = false): string {
    const audio = this.tracks.find(t => t.type === "audio");
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
    const copies = redundant ? ["", "/backup"] : [""];
    for (const prefix of copies)
      lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio${prefix ? "-backup" : ""}",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="${prefix}/live/${audio.name}/stream.m3u8"`);
    for (const t of this.tracks.filter(t => t.type === "video"))
      // Redundant streams list each variant twice: the primary, then its backup.
      for (const prefix of copies)
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${t.peakBandwidth + audio.peakBandwidth},AVERAGE-BANDWIDTH=${t.averageBandwidth + audio.averageBandwidth},RESOLUTION=${t.width}x${t.height},FRAME-RATE=${t.frameRate.toFixed(3)},CODECS="${t.codec},${audio.codec}",AUDIO="audio${prefix ? "-backup" : ""}"`,
          `${prefix}/live/${t.name}/stream.m3u8`);
    return lines.join("\n") + "\n";
  }
  /** prefix selects a redundant copy's URLs; pdtOffsetMs misreports the wall clock. */
  playlist(track: CmafTrack, prefix = "", pdtOffsetMs = 0): string {
    const timeline = this.timelines.get(track.name), { first, end } = timeline.bounds(), base = `${prefix}/live/${track.name}`;
    const seconds = (ticks: number) => (ticks / track.timescale).toFixed(5);
    const lines = ["#EXTM3U", `#EXT-X-VERSION:${this.lowLatency ? 9 : 7}`, "#EXT-X-INDEPENDENT-SEGMENTS", `#EXT-X-TARGETDURATION:${this.targetDuration}`];
    if (this.lowLatency)
      lines.push(`#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=${(this.partTarget * 3).toFixed(3)}`, `#EXT-X-PART-INF:PART-TARGET=${this.partTarget.toFixed(3)}`);
    lines.push(`#EXT-X-MEDIA-SEQUENCE:${first}`);
    if (this.mode !== "live") lines.push(`#EXT-X-PLAYLIST-TYPE:${this.mode.toUpperCase()}`);
    lines.push(`#EXT-X-MAP:URI="${base}/init.mp4"`);
    const partLines = (sequence: number, count: number) => this.source(track, sequence).parts.slice(0, count).map((part, index) =>
      `#EXT-X-PART:DURATION=${seconds(part.duration)},URI="${base}/part-${sequence}-${index}.m4s"${part.independent ? ",INDEPENDENT=YES" : ""}`);
    for (let sequence = first; sequence < end; sequence++) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${timeline.dateAt(timeline.startOf(sequence), pdtOffsetMs)}`);
      // Parts stay listed for the two newest complete segments.
      if (this.lowLatency && sequence >= end - 2) lines.push(...partLines(sequence, this.partCount(track, sequence)));
      lines.push(`#EXTINF:${seconds(this.source(track, sequence).duration)},`, `${base}/segment-${sequence}.m4s`);
    }
    if (this.lowLatency) {
      const open = this.openParts(track);
      if (open.count) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${timeline.dateAt(timeline.startOf(open.sequence), pdtOffsetMs)}`, ...partLines(open.sequence, open.count));
      lines.push(`#EXT-X-PRELOAD-HINT:TYPE=PART,URI="${base}/part-${open.sequence}-${open.count}.m4s"`);
      for (const other of this.tracks) {
        if (other === track) continue;
        const state = this.openParts(other);
        const report = state.count ? { msn: state.sequence, part: state.count - 1 } : { msn: state.sequence - 1, part: this.partCount(other, state.sequence - 1) - 1 };
        lines.push(`#EXT-X-RENDITION-REPORT:URI="${prefix}/live/${other.name}/stream.m3u8",LAST-MSN=${report.msn},LAST-PART=${report.part}`);
      }
    }
    if (this.mode === "vod") lines.push("#EXT-X-ENDLIST");
    return lines.join("\n") + "\n";
  }
  /** Whether a part of the segment still being produced can be served now. */
  partAvailable(track: CmafTrack, sequence: number, index: number): boolean {
    const open = this.openParts(track);
    return index < this.partCount(track, sequence) && (sequence < open.sequence || sequence === open.sequence && index < open.count);
  }
}
