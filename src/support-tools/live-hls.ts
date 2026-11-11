import { HlsSegment } from "./hls-playlist.js";
export type StreamMode = "live" | "event" | "vod";
export class LiveHlsTimeline {
  private started: number;
  private frozen?: number;
  private cycleDuration: number;
  private initialOffset: number;
  private elapsed = 0;
  private retention: number;
  /** One cycle: the content loop, then an optional ad pod reusing its first segments. */
  readonly segments: HlsSegment[];
  private readonly contentLength: number;
  constructor(
    source: HlsSegment[],
    readonly mode: StreamMode = "live",
    readonly window = 6,
    private clock = () => performance.now(),
    startedAt?: number,
    private wallStartedAt = Date.now(),
    initialOffsetSeconds?: number,
    /** Segments in the ad pod inserted after every content loop; 0 for none. */
    readonly adSegments = 0,
  ) {
    if (!source.length) throw new Error("Sample contains no segments");
    if (!Number.isInteger(adSegments) || adSegments < 0 || adSegments > source.length)
      throw new Error(`ad-break-segments must be an integer from 1 to ${source.length}`);
    this.contentLength = source.length;
    const segments = this.segments = [...source, ...source.slice(0, adSegments)];
    if (!Number.isInteger(window) || window < 3 || window > 120)
      throw new Error("window-segments must be an integer from 3 to 120");
    this.started = startedAt ?? clock();
    this.cycleDuration = segments.reduce(
      (sum, segment) => sum + segment.duration,
      0,
    );
    this.initialOffset = initialOffsetSeconds ?? this.timeAt(window);
    this.retention = Math.max(
      ...segments.map((_, start) =>
        Array.from(
          { length: window },
          (_, offset) => segments[(start + offset) % segments.length].duration,
        ).reduce((a, b) => a + b, 0),
      ),
    );
  }
  private positionTime(): number {
    this.elapsed = Math.max(
      this.elapsed,
      (this.clock() - this.started) / 1000,
      0,
    );
    return this.elapsed;
  }
  setFrozen(frozen: boolean): void {
    if (frozen && this.frozen === undefined) this.frozen = this.positionTime();
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
    return this.boundsAt(this.positionTime());
  }
  private boundsAt(elapsed: number): { first: number; end: number } {
    if (this.mode === "vod") return { first: 0, end: this.segments.length };
    const position = this.initialOffset + elapsed;
    let end = Math.floor(position / this.cycleDuration) * this.segments.length;
    while (this.timeAt(end + 1) <= position + 0.000001) end++;
    return {
      first: this.mode === "event" ? 0 : Math.max(0, end - this.window),
      end,
    };
  }
  availableAtMs(sequence: number): number { return this.wallStartedAt-this.initialOffset*1000+this.timeAt(sequence+1)*1000; }
  available(sequence: number): boolean {
    const { first, end } = this.bounds();
    return Number.isInteger(sequence) && sequence >= first && sequence < end;
  }
  retained(sequence: number): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return false;
    const { first, end } = this.bounds();
    if (sequence >= end) return false;
    if (sequence >= first || this.mode !== "live") return true;
    const removedAt =
      this.timeAt(sequence + this.window + 1) - this.initialOffset;
    return (
      this.positionTime() <
      removedAt +
        this.segments[sequence % this.segments.length].duration +
        this.retention
    );
  }
  /** Seconds of stream published so far, counted from the start of sequence 0. */
  position(): number { return this.initialOffset + this.positionTime(); }
  /** Stream time in seconds at which a media sequence number starts. */
  startOf(sequence: number): number { return this.timeAt(sequence); }
  /** Wall-clock date of a stream time, as advertised in PROGRAM-DATE-TIME. */
  dateAt(seconds: number, offsetMs = 0): string {
    return new Date(this.wallStartedAt + offsetMs - this.initialOffset * 1000 + seconds * 1000).toISOString();
  }
  /** Whether this media sequence number belongs to an ad pod. */
  ad(sequence: number): boolean { return this.adSegments > 0 && sequence % this.segments.length >= this.contentLength; }
  /** prefix selects a redundant copy's URLs; pdtOffsetMs misreports the wall clock. */
  playlist(rendition: string, prefix = "", pdtOffsetMs = 0): string {
    const { first, end } = this.boundsAt(this.frozen ?? this.positionTime());
    const length = this.segments.length, content = this.contentLength;
    // Discontinuities sit before each cycle after the first and before each ad pod.
    const removed = first === 0 ? 0 : Math.floor((first - 1) / length) +
      (this.adSegments && first - 1 >= content ? Math.floor((first - 1 - content) / length) + 1 : 0);
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:6",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...this.segments.map((s) => s.duration)))}`,
      `#EXT-X-MEDIA-SEQUENCE:${first}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${removed}`,
    ];
    if (this.mode !== "live")
      lines.push(`#EXT-X-PLAYLIST-TYPE:${this.mode.toUpperCase()}`);
    const date = (sequence: number) => new Date(this.wallStartedAt + pdtOffsetMs - this.initialOffset * 1000 + this.timeAt(sequence) * 1000).toISOString();
    // A date range stays listed while any segment of its ad pod is in the playlist.
    if (this.adSegments && first < end)
      for (let cycle = Math.floor(first / length); cycle * length + content < end; cycle++) {
        const start = cycle * length + content;
        if (start + this.adSegments <= first) continue;
        lines.push(`#EXT-X-DATERANGE:ID="ad-${cycle}",CLASS="io.hls-dash-live-sim.ad-break",START-DATE="${date(start)}",DURATION=${(this.timeAt(start + this.adSegments) - this.timeAt(start)).toFixed(3)},X-AD-SEGMENTS="${this.adSegments}"`);
      }
    for (let sequence = first; sequence < end; sequence++) {
      const phase = sequence % length;
      if (sequence > 0 && phase === 0) {
        lines.push("#EXT-X-DISCONTINUITY");
        if (this.adSegments) lines.push("#EXT-X-CUE-IN");
      } else if (this.adSegments && phase === content)
        lines.push("#EXT-X-DISCONTINUITY", `#EXT-X-CUE-OUT:${(this.timeAt(sequence + this.adSegments) - this.timeAt(sequence)).toFixed(3)}`);
      const segment = this.segments[phase];
      const epoch =
        this.wallStartedAt + pdtOffsetMs -
        this.initialOffset * 1000 +
        this.timeAt(sequence) * 1000;
      lines.push(
        `#EXT-X-PROGRAM-DATE-TIME:${new Date(epoch).toISOString()}`,
        `#EXTINF:${segment.duration.toFixed(6)},`,
        `${prefix}/live/${rendition}/segment-${sequence}.ts`,
      );
    }
    if (this.mode === "vod") lines.push("#EXT-X-ENDLIST");
    return lines.join("\n") + "\n";
  }
}
