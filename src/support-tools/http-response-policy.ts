import { createHash } from "node:crypto";
import type { LogicalMedia } from "./scenario.js";
import type { RequestTrace } from "./session-diagnostics.js";
export interface HttpResponsePolicyDefinition {
  target: { resource: "media" | "manifest" | "init"; track: string };
  validators: boolean;
  ranges: boolean;
}
export interface ConditionalHeaders { range?: string; "if-match"?: string; "if-unmodified-since"?: string; "if-none-match"?: string; "if-modified-since"?: string; "if-range"?: string; }
export function conditionalHeaders(input: Record<string, string | string[] | undefined> = {}): ConditionalHeaders {
  const result: ConditionalHeaders = {};
  for (const name of ["range", "if-match", "if-unmodified-since", "if-none-match", "if-modified-since", "if-range"])
    if (typeof input[name] === "string") result[name] = input[name];
  return result;
}
export function parseHttpPolicy(input: unknown): HttpResponsePolicyDefinition {
  const value = input as HttpResponsePolicyDefinition;
  const fail = (): never => { throw new Error("Invalid scenario: HTTP policy requires a supported resource/track, validators:true and a ranges boolean"); };
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["target", "validators", "ranges"].includes(key))) fail();
  if (!value.target || typeof value.target !== "object" || Array.isArray(value.target) || Object.keys(value.target).some(key => !["resource", "track"].includes(key))) fail();
  if (!["media", "manifest", "init"].includes(value.target.resource) || typeof value.target.track !== "string" ||
    !/^(any|root|video|audio|text|(?:video|audio|text):(?:0|[1-9]\d{0,2}))$/.test(value.target.track) ||
    value.target.track === "root" && value.target.resource !== "manifest") fail();
  if (value.validators !== true || typeof value.ranges !== "boolean" || value.ranges && value.target.resource === "manifest") fail();
  return { target: { ...value.target }, validators: value.validators, ranges: value.ranges };
}
function header(headers: Record<string, string>, name: string): string | undefined { return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]; }
function tags(input: string): string[] | undefined {
  if (input.trim() === "*") return ["*"];
  const result: string[] = []; let rest = input.trim();
  while (rest) {
    const match = /^(W\/)?"[\x21\x23-\x7e\x80-\xff]*"/.exec(rest);
    if (!match) return undefined;
    result.push(match[0]); rest = rest.slice(match[0].length).trimStart();
    if (!rest) break;
    if (!rest.startsWith(',')) return undefined;
    rest = rest.slice(1).trimStart(); if (!rest) return undefined;
  }
  return result.length ? result : undefined;
}
export function parseHttpDate(value: string | undefined, now = Date.now()): number {
  if (!value) return NaN;
  const short = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const long = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let weekday: string, day: number, month: number, year: number, hour: number, minute: number, second: number, obsolete = false;
  let match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (match) { [,weekday] = match; day=Number(match[2]);month=months.indexOf(match[3]);year=Number(match[4]);hour=Number(match[5]);minute=Number(match[6]);second=Number(match[7]); }
  else {
    match = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
    if (match) { weekday=short[long.indexOf(match[1])];day=Number(match[2]);month=months.indexOf(match[3]);year=Math.floor(new Date(now).getUTCFullYear()/100)*100+Number(match[4]);hour=Number(match[5]);minute=Number(match[6]);second=Number(match[7]);obsolete=true; }
    else {
      match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
      if (!match) return NaN;
      weekday=match[1];month=months.indexOf(match[2]);day=Number(match[3]);hour=Number(match[4]);minute=Number(match[5]);second=Number(match[6]);year=Number(match[7]);
    }
  }
  if (month<0 || day<1 || day>31 || hour>23 || minute>59 || second>60) return NaN;
  let date = new Date(Date.UTC(year,month,day,hour,minute,Math.min(second,59)));
  if (obsolete) {
    const limit = new Date(now);limit.setUTCFullYear(limit.getUTCFullYear()+50);
    if (date.getTime()>limit.getTime()) { year-=100;date=new Date(Date.UTC(year,month,day,hour,minute,Math.min(second,59))); }
  }
  if (year<1900 || date.getUTCFullYear()!==year || date.getUTCMonth()!==month || date.getUTCDate()!==day || short[date.getUTCDay()]!==weekday) return NaN;
  // Preserve HTTP whole-second ordering for :60 despite Date lacking leap
  // instants. Such values are never accepted as strong If-Range provenance.
  return date.getTime()+(second===60?999:0);
}
const httpDate = parseHttpDate;
export function preconditionStatus(etag: string | undefined, modified: number, conditions: ConditionalHeaders): 304 | 412 | undefined {
  const match = conditions['if-match'] === undefined ? undefined : tags(conditions['if-match']);
  if (match && !match.some(tag => tag === '*' || !!etag && !tag.startsWith('W/') && !etag.startsWith('W/') && tag === etag)) return 412;
  if (conditions['if-match'] === undefined && conditions['if-unmodified-since'] !== undefined && Number.isFinite(modified)) {
    const date = httpDate(conditions['if-unmodified-since']); if (Number.isFinite(date) && modified > date) return 412;
  }
  const none = conditions['if-none-match'] === undefined ? undefined : tags(conditions['if-none-match']);
  if (none?.some(tag => tag === '*' || !!etag && tag.replace(/^W\//, '') === etag.replace(/^W\//, ''))) return 304;
  if (conditions['if-none-match'] === undefined && conditions['if-modified-since'] !== undefined && Number.isFinite(modified)) {
    const date = httpDate(conditions['if-modified-since']); if (Number.isFinite(date) && modified <= date) return 304;
  }
  return undefined;
}
/** Preserve ordinary response headers; do not publish validators for transformed bytes. */
export function conditionalResponse(status: number, body: Buffer | string, input: Record<string,string>, method: string, conditions: ConditionalHeaders) {
  if (![200,206].includes(status) || !['GET','HEAD'].includes(method)) return {status,body,headers:input};
  const code = preconditionStatus(header(input,'etag'), httpDate(header(input,'last-modified')), conditions);
  if (!code) return {status,body,headers:input};
  const headers = Object.fromEntries(Object.entries(input).filter(([name]) => !/^(content-length|content-range)$/i.test(name)));
  return {status:code,body:Buffer.alloc(0),headers};
}
export function removeOriginValidators(headers: Record<string,string>): void {
  for (const name of Object.keys(headers)) if (/^(etag|last-modified)$/i.test(name)) delete headers[name];
}
/** Named valid HTTP behavior. Conditions are evaluated before single byte ranges. */
export class HttpResponsePolicy {
  private counts = { responses: 0, notModified: 0, preconditionFailed: 0, partial: 0, unsatisfiable: 0, ifRangeMisses: 0, cancelledResponses: 0 };
  private closed = false;
  constructor(readonly definition: HttpResponsePolicyDefinition) {}
  matches(resource: LogicalMedia): boolean {
    const { target } = this.definition;
    return target.resource === resource.kind && [resource.trackId, resource.trackType, "any"].includes(target.track);
  }
  apply(status: number, value: Buffer | string, input: Record<string, string>, method: string, conditions: ConditionalHeaders, trace?: RequestTrace) {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(value), headers = { ...input };
    if (status !== 200 || !["GET", "HEAD"].includes(method)) return { status, body, headers };
    const changes = { responses: 1, notModified: 0, preconditionFailed: 0, partial: 0, unsatisfiable: 0, ifRangeMisses: 0 };
    const etag = '"' + createHash('sha256').update(body).digest('hex') + '"';
    for (const key of Object.keys(headers)) if (/^(etag|content-length|content-range|cache-control|accept-ranges)$/i.test(key)) delete headers[key];
    if (this.definition.validators) { headers.ETag = etag; headers['Cache-Control'] = 'private, no-cache'; }
    const finish = (code: number, output = body) => {
      const delivered = method === 'HEAD' ? Buffer.alloc(0) : output;
      trace?.record("http.response", { status: code, bodyIdentity: createHash('sha256').update(delivered).digest('hex') });
      trace?.onOutcome(outcome => {
        if (outcome.outcome !== 'completed' || outcome.status !== code || outcome.bodyBytes !== delivered.length) { this.counts.cancelledResponses++; return; }
        for (const key of Object.keys(changes)) this.counts[key] += changes[key];
      });
      return { status: code, body: output, headers };
    };
    const modified = httpDate(header(headers, 'last-modified'));
    const condition = preconditionStatus(etag, modified, conditions);
    if (condition) { if (condition === 304) changes.notModified++; else changes.preconditionFailed++; return finish(condition, Buffer.alloc(0)); }
    if (!this.definition.ranges || method !== 'GET') return finish(200);
    headers['Accept-Ranges'] = 'bytes';
    if (!conditions.range || !body.length) return finish(200);
    const range = /^bytes=(\d*)-(\d*)$/.exec(conditions.range);
    // Unsupported units, multiple/invalid ranges use the permitted full response.
    if (!range || !range[1] && !range[2] || range[1] && range[2] && BigInt(range[2]) < BigInt(range[1])) return finish(200);
    const ifRange = conditions['if-range'];
    if (ifRange !== undefined) {
      const date = httpDate(ifRange), responseDate = httpDate(header(headers, 'date'));
      const strongDate = !/:60(?: GMT| \d{4})?$/.test(ifRange) && !/:60(?: GMT| \d{4})?$/.test(header(headers,'last-modified') || '') && Number.isFinite(date) && date === modified && Number.isFinite(responseDate) && responseDate - modified >= 60000;
      if (ifRange !== etag && !strongDate) { changes.ifRangeMisses++; return finish(200); }
    }
    const length = BigInt(body.length), start = range[1] ? BigInt(range[1]) : BigInt(range[2]) >= length ? 0n : length - BigInt(range[2]);
    const end = range[1] && range[2] ? BigInt(range[2]) < length ? BigInt(range[2]) : length - 1n : length - 1n;
    if (start >= length || start > end) { changes.unsatisfiable++; headers['Content-Range'] = `bytes */${length}`; return finish(416, Buffer.alloc(0)); }
    changes.partial++; headers['Content-Range'] = `bytes ${start}-${end}/${length}`;
    return finish(206, body.subarray(Number(start), Number(end + 1n)));
  }
  report() { return { target: { ...this.definition.target }, validators: this.definition.validators, ranges: this.definition.ranges, ...this.counts, result: (!this.definition.validators || this.counts.notModified > 0) && (!this.definition.ranges || this.counts.partial > 0) ? "passed" as const : this.closed ? "incomplete" as const : "pending" as const }; }
  close() { this.closed = true; }
}
