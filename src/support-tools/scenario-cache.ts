import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { mediaSegments } from "./hls-playlist.js";
import { HttpError } from "./safe-http.js";
import { conditionalResponse, parseHttpDate, removeOriginValidators, type ConditionalHeaders } from "./http-response-policy.js";
import type { LogicalMedia } from "./scenario.js";
import type { RequestTrace } from "./session-diagnostics.js";
export interface CacheDefinition {
  kind: "manifest-rollback" | "negative";
  target: { resource: "manifest" | "init" | "media"; track: string };
  afterMs: number;
  beforeMs: number;
  ttlMs?: number;
}
export function parseCache(input: unknown): CacheDefinition {
  const v = input as CacheDefinition, bad = (): never => { throw new Error("Invalid scenario: cache requires a supported kind, explicit single target and bounded time window"); };
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["kind","target","afterMs","beforeMs","ttlMs"].includes(k))) bad();
  if (!["manifest-rollback","negative"].includes(v.kind) || !v.target || typeof v.target !== "object" || Array.isArray(v.target) || Object.keys(v.target).some(k => !["resource","track"].includes(k))) bad();
  if (!["manifest","init","media"].includes(v.target.resource) || typeof v.target.track !== "string" || !/^(root|(?:video|audio|text):(?:0|[1-9]\d{0,2}))$/.test(v.target.track) || v.target.track === "root" && v.target.resource !== "manifest") bad();
  if (!Number.isInteger(v.afterMs) || v.afterMs < 0 || !Number.isInteger(v.beforeMs) || v.beforeMs <= v.afterMs || v.beforeMs > 86400000) bad();
  if (v.kind === "manifest-rollback" ? v.target.resource !== "manifest" || v.ttlMs !== undefined || !v.afterMs : !Number.isInteger(v.ttlMs) || v.ttlMs < 1 || v.ttlMs > 60000 || v.ttlMs > v.beforeMs-v.afterMs) bad();
  return { kind: v.kind, target: { ...v.target }, afterMs: v.afterMs, beforeMs: v.beforeMs, ...(v.ttlMs === undefined ? {} : { ttlMs: v.ttlMs }) };
}
const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const list = (v): any[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
/** A publication marker excludes publishTime: refreshing an MPD is not new media. */
export function publicationPosition(body: Buffer, protocol: "hls" | "dash"): string {
  const text = body.toString('utf8');
  if (protocol === 'hls') {
    const sequence = /^#EXT-X-MEDIA-SEQUENCE:(\d{1,20})\s*$/m.exec(text), segments = mediaSegments(text);
    if (!sequence || !segments.length || /^#EXT-X-ENDLIST/m.test(text)) throw new HttpError(422, "Rollback requires an advancing HLS media playlist");
    return String(BigInt(sequence[1])+BigInt(segments.length));
  }
  const root = new XMLParser({ignoreAttributes:false,parseTagValue:false,parseAttributeValue:false,removeNSPrefix:true,processEntities:false}).parse(text).MPD;
  if (!root || root['@_type'] !== 'dynamic') throw new HttpError(422, "Rollback requires a dynamic MPD with finite SegmentTimelines");
  const positions = [];
  for (const p of list(root.Period)) for (const a of list(p.AdaptationSet)) for (const r of list(a.Representation)) {
    const st = {...root.SegmentTemplate,...p.SegmentTemplate,...a.SegmentTemplate,...r.SegmentTemplate};
    let time=0n; const entries=list(st.SegmentTimeline?.S);
    if (!entries.length) throw new HttpError(422,"Rollback requires finite SegmentTimelines");
    for (const s of entries) {
      if (s['@_t'] !== undefined) { if (!/^\d{1,20}$/.test(s['@_t'])) throw new HttpError(422,"Unsupported timeline"); time=BigInt(s['@_t']); }
      const d=String(s['@_d'] ?? ''), repeat=Number(s['@_r'] ?? 0);
      if (!/^\d{1,20}$/.test(d) || !BigInt(d) || !Number.isSafeInteger(repeat) || repeat<0 || repeat>10000) throw new HttpError(422,"Unsupported timeline");
      time+=BigInt(d)*BigInt(repeat+1);
    }
    if (positions.length >= 128 || time > 0xffffffffffffffffn) throw new HttpError(422,"Rollback publication metadata exceeds supported bounds");
    positions.push([p['@_id'] ?? '',p['@_start'] ?? '',a['@_id'] ?? '',r['@_id'] ?? '',time.toString()]);
  }
  if (!positions.length) throw new HttpError(422,"Rollback requires advertised media");
  return JSON.stringify(positions);
}
export function isNewerPublication(first: string, next: string, protocol: "hls" | "dash", allowEqual = false): boolean {
  if (protocol === "hls") return allowEqual ? BigInt(next) >= BigInt(first) : BigInt(next) > BigInt(first);
  const previous = JSON.parse(first) as string[][], current = JSON.parse(next) as string[][];
  const map = new Map(current.map(v => [JSON.stringify(v.slice(0,4)), BigInt(v[4])]));
  let advanced = current.length > previous.length;
  for (const v of previous) { const end = map.get(JSON.stringify(v.slice(0,4))), old = BigInt(v[4]); if (end === undefined || end < old) return false; if (end > old) advanced = true; }
  return advanced || allowEqual;
}
interface Snapshot { key: string; body: Buffer; headers: Record<string,string>; status: number; identity: string; storedAt: number; initialAge: number; expires: number; position?: string; }
interface Context { resource: LogicalMedia; conditions: ConditionalHeaders; bypass: boolean; }
/** One owned entry, <=8 MiB, finite lifetime. Origin and edge decisions are separate. */
export class ScenarioCache {
  private entry?: Snapshot;
  private timer?: ReturnType<typeof setTimeout>;
  private contexts = new WeakMap<RequestTrace,Context>();
  private firstPosition?: string;
  private firstIdentity?: string;
  private newerPosition?: string;
  private newerIdentity?: string;
  private closed=false;
  private filled=false;
  private counts={originResponses:0,fills:0,hits:0,expirations:0,restorations:0,bypasses:0,cancelled:0};
  private faultId: string;
  constructor(readonly definition: CacheDefinition, private protocol: "hls"|"dash", scenarioId: string, private clock=()=>performance.now()) { this.faultId='fault_'+createHash('sha256').update(scenarioId+':edge').digest('hex').slice(0,32); }
  matches(r: LogicalMedia): boolean { return r.kind===this.definition.target.resource && r.trackId===this.definition.target.track; }
  bind(resource: LogicalMedia, conditions: ConditionalHeaders, requestHeaders: Record<string,string|string[]|undefined>, trace: RequestTrace, method: string): void {
    if (!this.matches(resource) || method!=='GET') return;
    const bypass=!!conditions.range || /(?:^|,)\s*(?:no-cache|no-store|max-age\s*=\s*0)\b/i.test(String(requestHeaders['cache-control'] ?? '')) || /no-cache/i.test(String(requestHeaders.pragma ?? ''));
    this.contexts.set(trace,{resource,conditions,bypass}); trace.runEffect();trace.logical({trackId:resource.trackId,targetKind:resource.kind});
  }
  private expire(expired = true): void { if(this.entry){this.entry=undefined;if(expired)this.counts.expirations++;} clearTimeout(this.timer);this.timer=undefined; }
  private record(trace: RequestTrace, decision: "origin"|"fill"|"hit"|"bypass"|"restore", body?: Buffer, origin?: Buffer): void {
    trace.record('edge.decision',{cacheDecision:decision,...(body?{bodyIdentity:digest(body)}:{}),...(origin?{originBodyIdentity:digest(origin)}:{})});
  }
  lookup(trace: RequestTrace, elapsed: number) {
    const c=this.contexts.get(trace); if(!c || this.closed) return undefined;
    const now=this.clock(), def=this.definition;
    if(this.entry && (now>=this.entry.expires || elapsed>=def.beforeMs))this.expire();
    if(c.bypass){this.counts.bypasses++;this.record(trace,'bypass');return undefined;}
    if(elapsed<def.afterMs || elapsed>=def.beforeMs)return undefined;
    if(def.kind==='manifest-rollback' && (!this.entry || !this.newerPosition))throw new HttpError(422,'Rollback needs two completed, distinct advertised publication generations before its window');
    const e=this.entry;if(!e || e.key!==c.resource.key)return undefined;
    const headers={...e.headers,Age:String(Math.floor(e.initialAge+(now-e.storedAt)/1000))};
    const response=conditionalResponse(e.status,e.body,headers,'GET',c.conditions);
    const effect=trace.select({faultId:this.faultId,fault:'scenario.cache',mode:'always',action:'response',status:response.status});effect.prepare();
    this.record(trace,'hit',response.body instanceof Buffer?response.body:Buffer.from(response.body));
    trace.onOutcome(o=>{if(o.outcome==='completed' && o.status===e.status && o.bodyBytes===e.body.length)this.counts.hits++;else if(o.outcome!=='completed')this.counts.cancelled++;});
    return response;
  }
  observe(trace: RequestTrace, elapsed: number, status: number, value: Buffer|string, headers: Record<string,string>): void {
    const c=this.contexts.get(trace);if(!c || this.closed)return;
    const body=Buffer.isBuffer(value)?value:Buffer.from(value), def=this.definition;
    this.record(trace,'origin',body,body);
    trace.onOutcome(o=>{if(o.outcome==='completed' && o.status===status && o.bodyBytes===body.length)this.counts.originResponses++;});
    if(c.bypass || body.length>8*1024*1024 || status!==200 && status!==404)return;
    const identity=digest(body), now=this.clock();
    if(def.kind==='manifest-rollback') {
      if(status!==200)return;
      const position=publicationPosition(body,this.protocol);
      trace.onOutcome(o=>{
        if(this.closed || o.outcome!=='completed' || o.status!==200 || o.bodyBytes!==body.length){if(o.outcome!=='completed')this.counts.cancelled++;return;}
        if(elapsed<def.afterMs && !this.filled) {
          this.filled=true;this.firstPosition=position;this.firstIdentity=identity;
          this.store({key:c.resource.key,body:Buffer.from(body),headers:{...headers},status,identity,storedAt:now,initialAge:0,expires:now+def.beforeMs-elapsed,position});this.counts.fills++;this.record(trace,'fill',body);
        } else if(elapsed<def.afterMs && isNewerPublication(this.firstPosition,position,this.protocol) && identity!==this.firstIdentity){this.newerPosition=position;this.newerIdentity=identity;}
        else if(elapsed>=def.beforeMs && this.firstPosition && this.newerPosition && isNewerPublication(this.newerPosition,position,this.protocol,true) && identity!==this.firstIdentity){this.counts.restorations++;this.record(trace,'restore',body);}
      });return;
    }
    if(this.filled){if(elapsed>=def.afterMs && (!this.entry || now>=this.entry.expires) && status===200 && this.firstPosition===c.resource.key)trace.onOutcome(o=>{if(!this.closed && o.outcome==='completed' && o.status===200 && o.bodyBytes===body.length){this.counts.restorations++;this.record(trace,'restore',body);}});return;}
    if(status!==404 || elapsed<def.afterMs || elapsed>=def.beforeMs)return;
    const lower=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v])), cache=lower['cache-control'] ?? '';
    const max=/^(?:public\s*,\s*max-age=(\d+)|max-age=(\d+)\s*,\s*public)$/i.exec(cache.trim());
    if(!max || lower.vary || lower['set-cookie'])return;
    const age=lower.age===undefined?0:/^\d+$/.test(lower.age)?Number(lower.age):Infinity, date=parseHttpDate(lower.date);
    if(!Number.isFinite(date))return;
    const initialAge=Math.max(age,Math.max(0,Date.now()-date)/1000), ttl=Math.min(def.ttlMs,def.beforeMs-elapsed,Number(max[1]??max[2])*1000-initialAge*1000);
    if(!Number.isFinite(ttl) || ttl<=0)return;
    trace.onOutcome(o=>{
      if(this.closed || this.filled || o.outcome!=='completed' || o.status!==404 || o.bodyBytes!==body.length || this.clock()-now>=ttl)return;
      this.filled=true;this.firstPosition=c.resource.key;this.firstIdentity=identity;
      this.store({key:c.resource.key,body:Buffer.from(body),headers:{...headers},status,identity,storedAt:now,initialAge,expires:now+ttl});this.counts.fills++;this.record(trace,'fill',body);
    });
  }
  private store(entry: Snapshot): void {
    const headers=entry.headers;removeOriginValidators(headers);headers.ETag='"'+entry.identity+'"';delete headers['content-length'];delete headers['content-range'];
    this.entry=entry;clearTimeout(this.timer);this.timer=setTimeout(()=>this.expire(),Math.max(1,entry.expires-this.clock()));this.timer.unref();
  }
  report(){return {kind:this.definition.kind,target:{...this.definition.target},afterMs:this.definition.afterMs,beforeMs:this.definition.beforeMs,ttlMs:this.definition.ttlMs,...this.counts,firstBodyIdentity:this.firstIdentity,newerBodyIdentity:this.newerIdentity,entries:this.entry?1:0,retainedBytes:this.entry?.body.length??0,pendingTimers:this.timer?1:0,result:this.counts.hits>0 && this.counts.restorations>0 && (this.definition.kind==='negative' || !!this.newerPosition)?'passed' as const:this.closed?'incomplete' as const:'pending' as const};}
  close(){this.closed=true;this.expire(false);}
}
