import { invalidLifecycle } from "./scenario-lifecycle.js";
import { HttpError } from "./safe-http.js";
import type { LifecycleDefinition,LifecycleHooks,LifecycleKind,SourceLifecycleStatus } from "./scenario-lifecycle.js";
import type { LogicalMedia } from "./scenario.js";
export interface FixtureGeneration{id:number;startSeconds:number;owner?:string;}
interface Action{kind:LifecycleKind;generation:number;boundarySeconds:number;durationMs?:number;track?:"video:0";}
/** Bounded authoring state. Ending a run never rewinds an advertised generation. */
export class FixtureLifecycle{
 private generations:FixtureGeneration[]=[{id:0,startSeconds:0}];
 private actions=new Map<string,Action>();
 private next=1;
 private endAt?:number;
 constructor(private mode:'live'|'event'|'vod',private position:()=>number){}
 generationAt(sequence:number):FixtureGeneration{const seconds=sequence*2;return [...this.generations].reverse().find(g=>g.startSeconds<=seconds)??this.generations[0];}
 get allGenerations():readonly FixtureGeneration[]{return this.generations;}
 get ended():boolean{return this.endAt!==undefined&&this.position()>=this.endAt;}
 get endSeconds():number|undefined{return this.endAt;}
 get pendingActions():number{return this.actions.size;}
 private supports(kind:LifecycleKind):boolean{return this.mode!=='vod'&&!this.ended&&(invalidLifecycle(kind)?this.mode==='live':kind==='encoder-restart'?this.next<64:this.mode==='event');}
 hooks(protocol:'hls'|'dash'):LifecycleHooks{return{
  supports:kind=>this.supports(kind),
  schedule:(id,definition)=>this.schedule(id,definition),
  cancel:id=>this.cancel(id),status:id=>this.status(id),
  affects:(id,resource)=>this.affects(id,resource,protocol),
 };}
 private schedule(id:string,definition:LifecycleDefinition):SourceLifecycleStatus{
  if(!this.supports(definition.kind))throw new HttpError(422,'Owned fixture/mode cannot perform this lifecycle action');
  if(this.actions.size||this.actions.has(id))throw new HttpError(409,'A source lifecycle action is already active');
  const boundarySeconds=(Math.floor(this.position()/8)+1)*8;
  if(invalidLifecycle(definition.kind))this.actions.set(id,{kind:definition.kind,generation:0,boundarySeconds,durationMs:definition.durationMs,track:definition.track});
  else if(definition.kind==='encoder-restart'){const generation=this.next++;this.generations.push({id:generation,startSeconds:boundarySeconds,owner:id});this.actions.set(id,{kind:definition.kind,generation,boundarySeconds});}
  else{this.endAt=boundarySeconds;this.actions.set(id,{kind:definition.kind,generation:this.generations.at(-1).id,boundarySeconds});}
  return this.status(id);
 }
 private status(id:string):SourceLifecycleStatus|undefined{
  const a=this.actions.get(id);if(!a)return undefined;
  return{...a,state:this.position()<a.boundarySeconds?'scheduled':invalidLifecycle(a.kind)&&this.position()>=(a.boundarySeconds+a.durationMs/1000)?'restored':a.kind==='event-completion'?'completed':'active'};
 }
 private cancel(id:string):void{
  const a=this.actions.get(id);if(!a)return;
  if(a.kind==='encoder-restart'&&this.position()<a.boundarySeconds)this.generations=this.generations.filter(g=>g.owner!==id);
  if(a.kind==='event-completion'&&!this.ended)this.endAt=undefined;
  this.actions.delete(id);
 }
 private affects(id:string,resource:LogicalMedia,protocol:'hls'|'dash'):boolean{
  const state=this.status(id);if(!state||!['active','completed'].includes(state.state))return false;
  if(invalidLifecycle(state.kind))return state.kind==='sequence-rollback'?resource.kind==='manifest'&&(protocol==='dash'||resource.trackId===this.actions.get(id).track):resource.trackId===this.actions.get(id).track&&resource.kind==='media';
  if(resource.kind==='manifest')return protocol==='dash'||resource.trackType!=='root';
  if(state.kind==='event-completion')return false;
  if(!resource.sourceUrl)return false;
  return new URL(resource.sourceUrl).pathname.startsWith('/generation-'+state.generation+'/');
 }
 activeFault():Readonly<Action>|undefined{return [...this.actions].map(([id,a])=>({a,status:this.status(id)})).find(v=>invalidLifecycle(v.a.kind)&&v.status?.state==='active')?.a;}
 close(){for(const id of this.actions.keys())this.cancel(id);}
}
