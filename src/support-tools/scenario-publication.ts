import { createHash } from "node:crypto";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { HttpError } from "./safe-http.js";
import { removeOriginValidators } from "./http-response-policy.js";
import type { LogicalMedia } from "./scenario.js";
import type { RequestTrace } from "./session-diagnostics.js";
export interface PublicationDefinition {
  kind: "rendition-lag" | "segment-delay";
  track: string;
  afterMs: number;
  beforeMs: number;
  segments?: number;
  delayMs?: number;
}
export function parsePublication(input: unknown): PublicationDefinition {
  const v = input as PublicationDefinition, bad = (): never => { throw Error("Invalid scenario: publication requires an explicit track, bounded window and kind-specific lag/delay"); };
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["kind", "track", "afterMs", "beforeMs", "segments", "delayMs"].includes(k))) bad();
  if (!["rendition-lag", "segment-delay"].includes(v.kind) || typeof v.track !== "string" || !/^(?:video|audio|text):(?:0|[1-9]\d{0,2})$/.test(v.track)) bad();
  if (!Number.isInteger(v.afterMs) || v.afterMs < 0 || !Number.isInteger(v.beforeMs) || v.beforeMs <= v.afterMs || v.beforeMs > 86400000) bad();
  if (v.kind === 'rendition-lag' ? v.delayMs !== undefined || !Number.isInteger(v.segments) || v.segments < 1 || v.segments > 10 : v.segments !== undefined || !Number.isInteger(v.delayMs) || v.delayMs < 1 || v.delayMs > 60000) bad();
  return { kind: v.kind, track: v.track, afterMs: v.afterMs, beforeMs: v.beforeMs, ...(v.kind === 'rendition-lag' ? { segments: v.segments } : { delayMs: v.delayMs }) };
}
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const list = (v): any[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
export function lagHls(body: Buffer, count: number): Buffer {
  const lines = body.toString('utf8').split(/\r?\n/), ends: number[] = []; let duration = false;
  if (!lines[0]?.startsWith('#EXTM3U') || lines.some(line => line.startsWith('#EXT-X-ENDLIST'))) throw new HttpError(422, 'Rendition lag requires a live/event HLS media playlist');
  for (const [i, line] of lines.entries()) {
    if (line.startsWith('#EXTINF:')) duration = true;
    else if (line && !line.startsWith('#') && duration) { ends.push(i); duration = false; }
  }
  if (ends.length <= count) throw new HttpError(422, 'Rendition lag needs more complete segments than its lag');
  return Buffer.from(lines.slice(0, ends[ends.length - count - 1] + 1).join('\n') + '\n');
}
export function lagDash(body: Buffer, count: number, track: string, bindings: ReadonlyMap<string, string>): Buffer {
  const root = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false, processEntities: false }).parse(body.toString('utf8'));
  const mpd = root.MPD, periods = list(mpd?.Period);
  if (!mpd || mpd['@_type'] !== 'dynamic' || periods.length !== 1) throw new HttpError(422, 'DASH rendition lag currently requires one dynamic Period');
  const period = periods[0]; let selected = 0;
  for (const [index, a] of list(period.AdaptationSet).entries()) for (const r of list(a.Representation)) {
    const key = JSON.stringify([String(a['@_id'] ?? index), String(r['@_id'] ?? '')]);
    if (bindings.get(key) !== track) continue;
    const template = structuredClone({ ...mpd.SegmentTemplate, ...period.SegmentTemplate, ...a.SegmentTemplate, ...r.SegmentTemplate });
    const entries = list(template.SegmentTimeline?.S); let total = 0;
    for (const s of entries) { const repeat = Number(s['@_r'] ?? 0); if (!Number.isSafeInteger(repeat) || repeat < 0 || repeat > 10000) throw new HttpError(422, 'Lag requires finite nonnegative SegmentTimeline repeats'); total += repeat + 1; }
    if (total <= count) throw new HttpError(422, 'DASH lag needs more complete segments than its lag');
    let remove = count; while (remove) { const last = entries.at(-1), length = Number(last['@_r'] ?? 0) + 1; if (length <= remove) { entries.pop(); remove -= length; } else { last['@_r'] = String(length - remove - 1); remove = 0; } }
    template.SegmentTimeline.S = entries; r.SegmentTemplate = template; selected++;
  }
  if (selected !== 1) throw new HttpError(422, 'Lag target must identify exactly one advertised Representation');
  return Buffer.from(new XMLBuilder({ ignoreAttributes: false, format: true, suppressEmptyNode: false }).build(root));
}
interface Context { resource: LogicalMedia; bindings?: ReadonlyMap<string, string>; }
/** Publication uses advertised timing and aliases. It never changes stream/UTC clocks. */
export class ScenarioPublication {
  private contexts = new WeakMap<RequestTrace, Context>();
  private failures = new Set<string>();
  private counts = { healthyBefore: 0, applied: 0, restored: 0, availableAfterDelay: 0, cancelled: 0 };
  private closed = false;
  private faultId: string;
  constructor(readonly definition: PublicationDefinition, private protocol: 'hls' | 'dash', scenarioId: string, private wallClock = () => Date.now()) {
    this.faultId = 'fault_' + createHash('sha256').update(scenarioId + ':publication').digest('hex').slice(0, 32);
  }
  bind(resource: LogicalMedia, trace: RequestTrace, method: string): void {
    if (method !== 'GET') return;
    const def = this.definition, match = def.kind === 'segment-delay' ? resource.kind === 'media' && resource.trackId === def.track : resource.kind === 'manifest' && (this.protocol === 'dash' ? resource.trackId === 'root' : resource.trackId === def.track);
    if (!match) return; this.contexts.set(trace, { resource }); trace.runEffect(); trace.logical({ trackId: def.track, targetKind: resource.kind });
  }
  bindings(trace: RequestTrace, value: ReadonlyMap<string, string>): void { const c = this.contexts.get(trace); if (c) c.bindings = value; }
  private complete(trace: RequestTrace, status: number, bytes: number, success: () => void): void {
    trace.onOutcome(o => { if (this.closed) return; if (o.outcome === 'completed' && o.status === status && o.bodyBytes === bytes) success(); else if (o.outcome !== 'completed') this.counts.cancelled++; });
  }
  delay(trace: RequestTrace, elapsed: number): number {
    const c = this.contexts.get(trace), def = this.definition; if (!c || this.closed || def.kind !== 'segment-delay') return 0;
    if (!Number.isFinite(c.resource.availableAtMs)) throw new HttpError(422, 'Publication delay requires advertised, complete segment availability timing');
    const age = this.wallClock() - c.resource.availableAtMs;
    if (age < 0) return 0; // Not available at origin yet: never count natural unavailability as an injection.
    if (elapsed < def.afterMs || elapsed >= def.beforeMs || age >= def.delayMs) return 0;
    if (!this.failures.has(c.resource.key) && this.failures.size >= 1024) throw new HttpError(503, 'Publication-delay identity capacity reached; reset the run');
    const effect = trace.select({ faultId: this.faultId, fault: 'scenario.publication', mode: 'always', action: 'response', status: 404 }); effect.prepare();
    trace.record('publication.decision', { publicationAction: 'delay', delayMs: def.delayMs });
    trace.onOutcome(o => { if (!this.closed && o.outcome === 'completed' && o.status === 404 && o.bodyBytes > 0) { this.failures.add(c.resource.key); this.counts.applied++; } else if (o.outcome !== 'completed') this.counts.cancelled++; }); return 404;
  }
  transform(trace: RequestTrace, elapsed: number, status: number, value: Buffer | string, headers: Record<string, string>): { body: Buffer; headers: Record<string, string> } | undefined {
    const c = this.contexts.get(trace), def = this.definition; if (!c || this.closed || status !== 200) return;
    const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (def.kind === 'segment-delay') {
      this.complete(trace, status, body.length, () => { if (elapsed < def.afterMs) this.counts.healthyBefore++; else if (this.failures.has(c.resource.key)) { if (elapsed >= def.beforeMs) this.counts.restored++; else this.counts.availableAfterDelay++; } }); return;
    }
    if (elapsed < def.afterMs || elapsed >= def.beforeMs) { this.complete(trace, status, body.length, () => { if (elapsed < def.afterMs) this.counts.healthyBefore++; else this.counts.restored++; }); return; }
    const changed = this.protocol === 'hls' ? lagHls(body, def.segments) : lagDash(body, def.segments, def.track, c.bindings ?? new Map());
    const output = { ...headers }; removeOriginValidators(output); for (const key of Object.keys(output)) if (/^(content-length|content-range|cache-control)$/i.test(key)) delete output[key]; output['Cache-Control'] = 'no-store';
    const effect = trace.select({ faultId: this.faultId, fault: 'scenario.publication', mode: 'always', action: 'replace_payload', status: 200 }); effect.prepare();
    trace.record('publication.decision', { publicationAction: 'lag', bodyIdentity: hash(changed), originBodyIdentity: hash(body) });
    this.complete(trace, 200, changed.length, () => this.counts.applied++); return { body: changed, headers: output };
  }
  report() { return { ...this.definition, ...this.counts, trackedFailedDownloads: this.failures.size, result: this.counts.healthyBefore && this.counts.applied && this.counts.restored ? 'passed' as const : this.closed ? 'incomplete' as const : 'pending' as const }; }
  close() { this.closed = true; this.failures.clear(); }
}
