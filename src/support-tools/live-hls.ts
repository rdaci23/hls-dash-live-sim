import { HlsSegment } from "./hls-playlist.js";
export type StreamMode = "live" | "event" | "vod";
export class LiveHlsTimeline {
  private started: number;
  private frozen?: number;
  private cycleDuration: number;
  private initialOffset: number;
  constructor(
    readonly segments: HlsSegment[],
    readonly mode: StreamMode = "live",
    readonly window = 6,
    private clock = () => Date.now(),
    startedAt?: number,
  ) {
    if (!segments.length) throw new Error("Sample contains no segments");
    if (!Number.isInteger(window) || window < 3 || window > 120)
      throw new Error("window-segments must be an integer from 3 to 120");
    this.started = startedAt ?? clock();
    this.cycleDuration = segments.reduce(
      (sum, segment) => sum + segment.duration,
      0,
    );
    this.initialOffset = this.timeAt(window);
  }
  setFrozen(frozen: boolean): void {
    if (frozen && this.frozen === undefined) this.frozen = this.clock();
    else if (!frozen) this.frozen = undefined;
  }
  private timeAt(sequence: number): number {
    const cycles = Math.floor(sequence / this.segments.length);
    return (
      cycles * this.cycleDuration +
      this.segments
        .slice(0, sequence % this.segments.length)
        .reduce((sum, segment) => sum + segment.duration, 0)
    );
  }
  bounds(): { first: number; end: number } {
    if (this.mode === "vod") return { first: 0, end: this.segments.length };
    const elapsed = Math.max(
      0,
      ((this.frozen ?? this.clock()) - this.started) / 1000,
    );
    const position = this.initialOffset + elapsed;
    let end = Math.floor(position / this.cycleDuration) * this.segments.length;
    while (this.timeAt(end + 1) <= position + 0.000001) end++;
    return {
      first: this.mode === "event" ? 0 : Math.max(0, end - this.window),
      end,
    };
  }
  available(sequence: number): boolean {
    const { first, end } = this.bounds();
    return Number.isInteger(sequence) && sequence >= first && sequence < end;
  }
  playlist(rendition: string): string {
    const { first, end } = this.bounds();
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:6",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...this.segments.map((s) => s.duration)))}`,
      `#EXT-X-MEDIA-SEQUENCE:${first}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${first === 0 ? 0 : Math.floor((first - 1) / this.segments.length)}`,
    ];
    if (this.mode !== "live")
      lines.push(`#EXT-X-PLAYLIST-TYPE:${this.mode.toUpperCase()}`);
    for (let sequence = first; sequence < end; sequence++) {
      if (sequence > 0 && sequence % this.segments.length === 0)
        lines.push("#EXT-X-DISCONTINUITY");
      const segment = this.segments[sequence % this.segments.length];
      const epoch =
        this.started - this.initialOffset * 1000 + this.timeAt(sequence) * 1000;
      lines.push(
        `#EXT-X-PROGRAM-DATE-TIME:${new Date(epoch).toISOString()}`,
        `#EXTINF:${segment.duration.toFixed(6)},`,
        `/live/${rendition}/segment-${sequence}.ts`,
      );
    }
    if (this.mode === "vod") lines.push("#EXT-X-ENDLIST");
    return lines.join("\n") + "\n";
  }
}
