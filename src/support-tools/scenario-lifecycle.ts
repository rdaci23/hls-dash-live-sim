import { randomUUID,createHash } from "node:crypto";
import type { LogicalMedia } from "./scenario.js";
import type { RequestTrace,SessionDiagnostics } from "./session-diagnostics.js";
export type LifecycleKind="encoder-restart"|"event-completion";
export interface LifecycleDefinition{kind:LifecycleKind;afterMs:number;}
export interface SourceLifecycleStatus{kind:LifecycleKind;state:"scheduled"|"active"|"completed";generation:number;boundarySeconds:number;}
export interface LifecycleHooks{
 supports(kind:LifecycleKind):boolean;
 schedule(id:string,definition:LifecycleDefinition):SourceLifecycleStatus;
 cancel(id:string):void;
 status(id:string):SourceLifecycleStatus|undefined;
 affects(id:string,resource:LogicalMedia):boolean;
}
export function parseLifecycle(input:unknown):LifecycleDefinition{
 const v=input as LifecycleDefinition;
 if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).some(k=>!["kind","afterMs"].includes(k))||!["encoder-restart","event-completion"].includes(v.kind)||!Number.isInteger(v.afterMs)||v.afterMs<0||v.afterMs>86400000||v.kind==='event-completion'&&v.afterMs>300000)throw Error('Invalid scenario: lifecycle needs a supported action and bounded afterMs; event completion is limited to five minutes');
 return{kind:v.kind,afterMs:v.afterMs};
}
/** An immutable run schedules source-owned transitions; evidence remains delivery-based. */
export class ScenarioLifecycle{
 private id=randomUUID();private timer?:ReturnType<typeof setTimeout>;private closed=false;private triggered=false;private last?:SourceLifecycleStatus;private failure?:string;
 private contexts=new WeakMap<RequestTrace,LogicalMedia>();
 private counts={healthyBefore:0,transitionManifests:0,initializationAfter:0,mediaAfter:0,cancelled:0};
 constructor(readonly definition:LifecycleDefinition,private hooks:LifecycleHooks,private diagnostics:SessionDiagnostics,private elapsed:()=>number){
  if(!hooks?.supports(definition.kind))throw Error('Lifecycle action is unsupported by this owned fixture/mode');
  this.timer=setTimeout(()=>{this.timer=undefined;if(this.closed)return;try{this.last=hooks.schedule(this.id,definition);this.triggered=true;this.event('scheduled');}catch{this.failure='source_action_rejected';}},Math.max(0,definition.afterMs-elapsed()));this.timer.unref();
 }
 private event(state:"scheduled"|"active"|"completed"){this.diagnostics.record('lifecycle.transition',{lifecycleKind:this.definition.kind,lifecycleState:state,generation:this.last?.generation,sourceMediaTimeMs:this.last?this.last.boundarySeconds*1000:undefined});}
 bind(resource:LogicalMedia,trace:RequestTrace,method:string):void{if(method!=='GET'||!['manifest','init','media'].includes(resource.kind))return;this.contexts.set(trace,resource);if(this.triggered&&this.hooks.affects(this.id,resource))trace.runEffect();}
 observe(trace:RequestTrace,method:string,status:number,value:Buffer|string):void{
  const resource=this.contexts.get(trace);if(!resource||this.closed||method!=='GET'||status!==200)return;
  const body=Buffer.isBuffer(value)?value:Buffer.from(value),source=this.hooks.status(this.id)??this.last;if(source)this.last=source;
  const active=source&&source.state!=='scheduled',affected=active&&this.hooks.affects(this.id,resource),text=resource.kind==='manifest'?body.toString('utf8'):'';
  const transition=affected&&resource.kind==='manifest'&&(this.definition.kind==='event-completion'?/^(?:#EXT-X-ENDLIST)\s*$/m.test(text)||/<MPD\b[^>]*\btype="static"/.test(text):/^#EXT-X-DISCONTINUITY\s*$|^#EXT-X-DISCONTINUITY-SEQUENCE:[1-9]\d*/m.test(text)||/<Period\b[^>]*\bid="owned-[1-9]\d*"/.test(text));
  if(affected){trace.runEffect();trace.record('lifecycle.response',{lifecycleKind:this.definition.kind,lifecycleState:source.state,generation:source.generation,bodyIdentity:createHash('sha256').update(body).digest('hex')});}
  trace.onOutcome(o=>{if(this.closed)return;if(o.outcome!=='completed'){this.counts.cancelled++;return;}if(o.status!==200||o.bodyBytes!==body.length||!body.length)return;
   if(!active)this.counts.healthyBefore++;if(transition)this.counts.transitionManifests++;if(active&&resource.kind==='media'&&(affected||this.definition.kind==='event-completion'))this.counts.mediaAfter++;if(affected&&resource.kind==='init')this.counts.initializationAfter++;
  });
 }
 report(){const source=this.hooks.status(this.id)??this.last;if(source)this.last=source;const qualified=this.triggered&&this.counts.healthyBefore>0&&this.counts.transitionManifests>0&&(this.definition.kind==='event-completion'?source?.state==='completed':this.counts.initializationAfter>0&&this.counts.mediaAfter>0);return{...this.definition,source:this.last,...this.counts,pendingTimers:this.timer?1:0,failure:this.failure,result:this.failure?'failed' as const:qualified?'passed' as const:this.closed?'incomplete' as const:'pending' as const};}
 close(){if(this.closed)return;this.last=this.hooks.status(this.id)??this.last;this.closed=true;clearTimeout(this.timer);this.timer=undefined;if(this.triggered)try{this.hooks.cancel(this.id);}catch{this.failure='source_cleanup_failed';}}
}
