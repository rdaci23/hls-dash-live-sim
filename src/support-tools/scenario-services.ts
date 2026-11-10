import { randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import type { LogicalMedia } from './scenario.js';
import type { RequestTrace,SessionDiagnostics } from './session-diagnostics.js';
export type ServiceKind='key-unavailable'|'wrong-key'|'token-expiry'|'utc-unavailable'|'utc-malformed'|'utc-skew'|'utc-drift'|'pdt-skew'|'license-unavailable'|'license-denied';
export const serviceKinds:readonly ServiceKind[]=['key-unavailable','wrong-key','token-expiry','utc-unavailable','utc-malformed','utc-skew','utc-drift','pdt-skew','license-unavailable','license-denied'];
/** The licence endpoint is classified as a key resource with this identity. */
export const LICENSE_KEY='owned:license';
export interface ServiceDefinition{kind:ServiceKind;afterMs:number;beforeMs:number;skewMs?:number;
 /** utc-drift: the clock error grows by this many ms for each second inside the window. */
 driftMsPerSecond?:number;}
export interface ServiceHooks{supports(kind:ServiceKind):boolean;start(id:string,definition:ServiceDefinition,elapsed:()=>number):void;cancel(id:string):void;classify(url:string):LogicalMedia|undefined;}
export function parseServices(value:unknown):ServiceDefinition{
 const v=value as ServiceDefinition,skewed=['utc-skew','pdt-skew'].includes(v?.kind),keys=['kind','afterMs','beforeMs',...(skewed?['skewMs']:[]),...(v?.kind==='utc-drift'?['driftMsPerSecond']:[])];
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||!serviceKinds.includes(v.kind)||!Number.isInteger(v.afterMs)||v.afterMs<0||v.afterMs>86400000||!Number.isInteger(v.beforeMs)||v.beforeMs<=v.afterMs||v.beforeMs-v.afterMs>60000)throw Error('Invalid scenario: service action needs a supported kind and a window of at most 60000 ms');
 if(skewed&&(!Number.isInteger(v.skewMs)||Math.abs(v.skewMs)>300000||Math.abs(v.skewMs)<1000))throw Error('Invalid scenario: UTC skew must be nonzero 1000–300000 ms');
 if(v.kind==='utc-drift'&&(!Number.isInteger(v.driftMsPerSecond)||v.driftMsPerSecond===0||Math.abs(v.driftMsPerSecond)>5000))throw Error('Invalid scenario: UTC drift must be a nonzero integer within ±5000 ms per second');
 return{kind:v.kind,afterMs:v.afterMs,beforeMs:v.beforeMs,...(skewed?{skewMs:v.skewMs}:{}),...(v.kind==='utc-drift'?{driftMsPerSecond:v.driftMsPerSecond}:{})};
}
/** Local services have no exported keys, tokens, URL signatures or secret hashes. */
export class ScenarioServices{
 private id=randomUUID();private closed=false;private token?:Buffer;private issued=0;private issuedAt=-1;private contexts=new WeakMap<RequestTrace,{active:boolean;phase:'before'|'fault'|'after'}>();
 private counts={healthyBefore:0,failures:0,restored:0,renewals:0,cancelled:0};
 constructor(readonly definition:ServiceDefinition,private hooks:ServiceHooks,private elapsed:()=>number,private diagnostics:SessionDiagnostics){if(!hooks?.supports(definition.kind))throw Error('Service fault is unsupported by this owned fixture/protocol');hooks.start(this.id,definition,elapsed);}
 private active(){const n=this.elapsed();return n>=this.definition.afterMs&&n<this.definition.beforeMs;}
 issue():{accessToken:string}{if(this.closed||this.definition.kind!=='token-expiry')throw Error('No local access-token scenario is active');this.token?.fill(0);this.token=randomBytes(32);this.issuedAt=this.elapsed();if(this.issued++)this.counts.renewals++;return{accessToken:this.token.toString('base64url')};}
 authorize(resource:LogicalMedia|undefined,headers:Record<string,unknown>,method:string):boolean{
  if(this.definition.kind!=='token-expiry'||resource?.kind!=='media'||method==='HEAD')return true;
  const supplied=typeof headers.authorization==='string'?headers.authorization.replace(/^Bearer /,''):'';let bytes:Buffer;try{bytes=Buffer.from(supplied,'base64url');}catch{return false;}
  return !!this.token&&bytes.length===this.token.length&&timingSafeEqual(bytes,this.token)&&!(this.issuedAt<this.definition.afterMs&&this.elapsed()>=this.definition.afterMs);
 }
 bind(resource:LogicalMedia|undefined,trace:RequestTrace,method:string,authorized=true){
  if(this.closed||!resource)return;const kind=this.definition.kind,license=kind.startsWith('license-'),target=kind.startsWith('utc-')?resource.kind==='utc':kind==='token-expiry'?resource.kind==='media':kind==='pdt-skew'?resource.kind==='manifest'&&resource.trackId!=='root':resource.kind==='key'&&(resource.key===LICENSE_KEY)===license;if(!target||method!=='GET'&&!(resource.kind==='utc'&&method==='HEAD')&&!(license&&method==='POST'))return;
  const elapsed=this.elapsed(),active=kind==='token-expiry'?!authorized&&elapsed>=this.definition.afterMs:this.active(),phase=elapsed<this.definition.afterMs?'before':active?'fault':'after';this.contexts.set(trace,{active,phase});
  if(kind==='token-expiry')trace.onOutcome(o=>{if(this.closed)return;if(o.outcome!=='completed'){this.counts.cancelled++;return;}if(active&&o.status===401)this.counts.failures++;else if(!active&&o.status===200){if(phase==='before')this.counts.healthyBefore++;else this.counts.restored++;}});
  if(active){trace.runEffect();const effect=trace.select({faultId:'fault_'+this.id,fault:'scenario.service',action:'response'});effect.prepare();}
 }
 observe(trace:RequestTrace,status:number,bytes:number){const c=this.contexts.get(trace);if(!c||this.closed||this.definition.kind==='token-expiry')return;trace.onOutcome(o=>{if(this.closed)return;if(o.outcome!=='completed'){this.counts.cancelled++;return;}if(o.status!==status||o.bodyBytes!==bytes)return;if(c.active){const expected=['key-unavailable','utc-unavailable','license-unavailable'].includes(this.definition.kind)?status===503:this.definition.kind==='license-denied'?status===403:status===200&&(this.definition.kind!=='wrong-key'||bytes===16);if(expected)this.counts.failures++;}else if(status===200){if(c.phase==='before')this.counts.healthyBefore++;else this.counts.restored++;}});}
 report(){const result=this.counts.healthyBefore>0&&this.counts.failures>0&&this.counts.restored>0;return{...this.definition,...this.counts,phase:this.elapsed()<this.definition.afterMs?'before':this.active()?'fault':'after',pendingTimers:0,result:result?'passed' as const:this.closed?'incomplete' as const:'pending' as const};}
 close(){if(this.closed)return;this.closed=true;this.hooks.cancel(this.id);this.token?.fill(0);this.token=undefined;}
}
