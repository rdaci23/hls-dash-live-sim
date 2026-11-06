const test=require('node:test'),assert=require('node:assert/strict');
const Hls=require('hls.js');
const createHlsCausality=process.env.HLS_CAUSALITY_CONTROL==='uninstrumented'
 ?()=>({forError:()=>null,dispose(){},dropped:()=>0})
 :require('../scripts/track-browser/hls-causality.js').createHlsCausality;
const events=Hls.Events,noop=()=>{},logger=Object.fromEntries(['trace','debug','log','warn','info','error'].map(k=>[k,noop]));
function emitter(){const listeners=new Map();return{config:{},on(event,fn,context){const a=listeners.get(event)??[];a.push([fn,context]);listeners.set(event,a);},off(event,fn,context){listeners.set(event,(listeners.get(event)??[]).filter(x=>x[0]!==fn||x[1]!==context));},trigger(event,data){for(const [fn,context]of listeners.get(event)??[])fn.call(context,event,data);return true;}};}
function observe(player,options={}){const records=[];let time=0;return{records,observer:createHlsCausality(Hls,player,{record:event=>records.push(event),now:()=>++time,publicUrl:value=>value,publicText:value=>value,...options})};}
// These are the pinned player's actual ErrorController, Hls.stopLoad,
// BaseStreamController.stopLoad and XhrLoader.abort implementations. The
// controlled controller/loader state replaces a browser and network only.
async function nativeFailure(status){
 const previousSelf=Object.getOwnPropertyDescriptor(globalThis,'self');globalThis.self=globalThis;
 try{
  const player=emitter(),level=()=>({fragmentError:0,loadError:0,loadErrorTime:0,audioGroups:['audio'],subtitleGroups:['text'],audioCodec:'mp4a.40.2',videoRange:'SDR',hasAudioGroup:g=>g==='audio',hasSubtitleGroup:g=>g==='text'});
  Object.assign(player,{logger,config:{...Hls.DefaultConfig},levels:[level(),level()],currentLevel:0,loadLevel:0,loadLevelObj:{details:{}},autoLevelEnabled:false,minAutoLevel:0,maxAutoLevel:1,started:true});
  const loader=new Hls.DefaultConfig.loader({}),stats=loader.stats;
  let xhrAborts=0,stopCalls=0;const pending=[];
  const frag={type:'audio',sn:23,level:0,url:'http://owned.test/audio.m4s',loader,abortRequests(){this.loader?.abort();}};
  loader.loader={readyState:1,abort(){xhrAborts++;this.readyState=0;}};loader.context={url:frag.url};stats.aborted=false;
  loader.callbacks={onAbort(abortedStats){const error={type:Hls.ErrorTypes.NETWORK_ERROR,details:Hls.ErrorDetails.INTERNAL_ABORTED,fatal:false,frag,stats:abortedStats,error:Error('Aborted')};loader.destroy();frag.loader=null;pending.push(Promise.resolve().then(()=>player.trigger(events.ERROR,error)));}};
  const audio={state:'FRAG_LOADING',fragmentLoader:{abort:()=>loader.abort()},initFragmentLoader:{abort:noop},keyLoader:{abort:noop},fragCurrent:frag,fragmentTracker:{removeFragment:noop},resetTransmuxer:noop,clearInterval:noop,clearNextTick:noop};
  audio.stopLoad=Hls.DefaultConfig.audioStreamController.prototype.stopLoad;
  player.streamController=audio;Object.defineProperty(player,'loadingEnabled',{get:Object.getOwnPropertyDescriptor(Hls.prototype,'loadingEnabled').get});
  const controller=new Hls.DefaultConfig.errorController(player);player.on(events.ERROR,controller.onErrorOut,controller);
  player.networkControllers=[audio,controller];player.stopLoad=function(){stopCalls++;return Hls.prototype.stopLoad.apply(this,arguments);};
  const {records,observer}=observe(player),seen=[];player.on(events.ERROR,(_,error)=>seen.push({error,proof:observer.forError(error)}));
  player.trigger(events.FRAG_LOADING,{frag});
  const error={type:Hls.ErrorTypes.NETWORK_ERROR,details:Hls.ErrorDetails.FRAG_LOAD_ERROR,fatal:false,frag:{type:'subtitle',sn:23,level:0,url:'http://owned.test/caption.vtt'},response:{code:status,url:'http://owned.test/caption.vtt'}};
  player.trigger(events.ERROR,error);await Promise.all(pending);
  const result={records,seen,error,stats,stopCalls,xhrAborts,loadingEnabled:player.loadingEnabled,observer};observer.dispose();controller.destroy();return result;
 }finally{if(previousSelf)Object.defineProperty(globalThis,'self',previousSelf);else delete globalThis.self;}
}
test('pinned native subtitle404 ties fatal escalation, stopLoad and async audio abort by exact identities',async()=>{
 assert.equal(Hls.version,'1.7.3');const r=await nativeFailure(404);
 assert.equal(r.error.fatal,true);assert.equal(r.stopCalls,1);assert.equal(r.loadingEnabled,false);assert.equal(r.stats.aborted,true);assert.equal(r.seen.length,2);
 const primary=r.seen[0].proof,secondary=r.seen[1].proof;
 assert.ok(primary,'The native fatal-stop cause must be observable');assert.equal(primary.schemaVersion,1);assert.equal(primary.cause,'fatal-error-stop-load');assert.equal(primary.fatalStop.fatal,true);assert.equal(primary.fatalStop.loadingEnabledBefore,true);assert.equal(primary.fatalStop.loadingEnabledAfter,false);
 assert.ok(secondary,'An async audio abort must retain its exact native stop cause');assert.equal(secondary.cause,'fatal-stop-loader-abort');assert.equal(secondary.fatalStop.stopId,primary.fatalStop.stopId);assert.equal(secondary.fatalStop.errorDispatchId,primary.errorDispatchId);assert.equal(secondary.loaderAbort.fragment.type,'audio');assert.equal(secondary.loaderAbort.fragment.sn,23);assert.equal(secondary.loaderAbort.statsAborted,true);assert.notEqual(secondary.errorDispatchId,primary.errorDispatchId);
 const dispatch=r.records.filter(e=>e.kind==='hls-error-dispatch'&&e.errorDispatchId===primary.errorDispatchId);assert.equal(dispatch[0].phase,'before');assert.equal(dispatch[0].fatal,false);assert.equal(dispatch.at(-1).phase,'after');assert.equal(dispatch.at(-1).fatal,true);assert.equal(r.observer.dropped(),0);
});
test('the same pinned native subtitle503 follows unchanged retry policy without stopping AV',async()=>{
 const r=await nativeFailure(503);assert.equal(r.error.fatal,false);assert.equal(r.error.errorAction.action,5);assert.equal(r.stopCalls,0);assert.equal(r.loadingEnabled,true);assert.equal(r.stats.aborted,false);assert.equal(r.seen.length,1);assert.equal(r.seen[0].proof,null);assert.equal(r.observer.dropped(),0);
});
function controlled(){const p=emitter();p.loadingEnabled=true;p.stopLoad=function(){this.fragment.loader?.abort();this.loadingEnabled=false;return'original-stop';};p.startLoad=function(){this.loadingEnabled=true;return'original-start';};p.on(events.ERROR,(_,e)=>{if(e.primary){e.fatal=true;p.stopLoad();}});return p;}
function fragment(){const stats={aborted:false},loader={stats,abort(){stats.aborted=true;return'original-abort';}};return{type:'audio',sn:23,level:0,url:'http://owned.test/audio.m4s?token=secret',loader};}
test('abort proof requires same fragment object, load attempt and retained stats reference',()=>{
 const p=controlled(),{observer}=observe(p),frag=fragment();p.fragment=frag;p.trigger(events.FRAG_LOADING,{frag});
 p.trigger(events.ERROR,{primary:true,fatal:false,details:'fragLoadError',frag:{type:'subtitle',sn:23,level:0}});
 const oldStats=frag.loader.stats,aborted={details:'aborted',frag,stats:oldStats};p.trigger(events.ERROR,aborted);assert.ok(observer.forError(aborted));
 const lookalike={details:'aborted',frag:{...frag},stats:oldStats};p.trigger(events.ERROR,lookalike);assert.equal(observer.forError(lookalike),null);
 const wrongStats={details:'aborted',frag,stats:{aborted:true}};p.trigger(events.ERROR,wrongStats);assert.equal(observer.forError(wrongStats),null);
 const wrongDetail={details:'fragLoadError',frag,stats:oldStats};p.trigger(events.ERROR,wrongDetail);assert.equal(observer.forError(wrongDetail),null);
 const copied=observer.forError(aborted);copied.fatalStop.stopId=-1;assert.ok(observer.forError(aborted).fatalStop.stopId>0);
 frag.loader=fragment().loader;p.trigger(events.FRAG_LOADING,{frag});const stale={details:'aborted',frag,stats:oldStats};p.trigger(events.ERROR,stale);assert.equal(observer.forError(stale),null);
 assert.equal(observer.forError({...aborted}),null);observer.dispose();
});
test('unrelated aborts and completed-loader callbacks cannot acquire a fatal cause',()=>{
 const p=controlled(),{observer}=observe(p),frag=fragment();p.fragment=frag;p.trigger(events.FRAG_LOADING,{frag});frag.loader.abort();const e={details:'aborted',frag,stats:frag.loader.stats};p.trigger(events.ERROR,e);assert.equal(observer.forError(e),null);
 const complete=fragment();complete.loader.abort=function(){return'completed-no-op';};p.fragment=complete;p.trigger(events.FRAG_LOADING,{frag:complete});p.trigger(events.ERROR,{primary:true,fatal:false,details:'fragLoadError'});const late={details:'aborted',frag:complete,stats:complete.loader.stats};p.trigger(events.ERROR,late);assert.equal(observer.forError(late),null);observer.dispose();
});
test('public methods preserve this, arguments, returns and original exceptions; inspection does not mutate config',()=>{
 const p=emitter(),calls=[],config={retry:{max:6}},failure=Error('original');p.config=config;
 for(const name of ['stopLoad','startLoad','recoverMediaError','destroy','loadSource'])p[name]=function(...args){calls.push({name,context:this,args});if(name==='recoverMediaError')throw failure;return name;};
 const originals=Object.fromEntries(['trigger','stopLoad','startLoad','recoverMediaError','destroy','loadSource'].map(name=>[name,p[name]]));const {observer}=observe(p);
 for(const name of ['stopLoad','startLoad','destroy','loadSource'])assert.equal(p[name](1,'two'),name);assert.throws(()=>p.recoverMediaError(3),error=>error===failure);
 assert.equal(calls.length,5);assert.ok(calls.every(c=>c.context===p));assert.deepEqual(calls[0].args,[1,'two']);assert.equal(p.config,config);assert.deepEqual(config,{retry:{max:6}});observer.dispose();for(const name of Object.keys(originals))assert.equal(p[name],originals[name]);
});
test('records omit credentials/query strings and observer errors never change player behavior',()=>{
 const p=controlled(),{records,observer}=observe(p),frag=fragment();p.fragment=frag;p.trigger(events.FRAG_LOADING,{frag});p.loadSource=function(){return'new-method';};p.trigger(events.ERROR,{primary:true,details:'fragLoadError',response:{code:404},frag:{type:'subtitle',sn:23,url:'http://user:password@owned.test/caption.vtt?token=secret#private'}});const serialized=JSON.stringify(records);for(const secret of ['secret','password','token=','user:'])assert.equal(serialized.includes(secret),false);observer.dispose();
 const q=emitter();q.stopLoad=function(){return 42;};const {observer:bad}=observe(q,{record(){throw Error('observer failed');},now(){throw Error('clock failed');}});assert.equal(q.stopLoad(),42);assert.ok(bad.dropped()>0);bad.dispose();
});
test('dispose restores only owned wrappers and prevents further observations from captured wrappers',()=>{
 const p=controlled(),frag=fragment();p.fragment=frag;const originalAbort=frag.loader.abort,{records,observer}=observe(p);p.trigger(events.FRAG_LOADING,{frag});const wrappedStop=p.stopLoad,wrappedTrigger=p.trigger,other=function(){return wrappedTrigger.apply(this,arguments);};p.trigger=other;observer.dispose();assert.equal(p.trigger,other);assert.equal(frag.loader.abort,originalAbort);const n=records.length;wrappedStop.call(p);p.trigger(events.ERROR,{primary:true});assert.equal(records.length,n);assert.equal(observer.forError({}),null);
});
test('throwing trigger and loader delegates retain the exact original exceptions',()=>{
 const triggerFailure=Error('trigger failed'),p=emitter();p.trigger=function(){throw triggerFailure;};const {observer}=observe(p);assert.throws(()=>p.trigger(events.ERROR,{details:'fragLoadError'}),error=>error===triggerFailure);observer.dispose();
 const q=controlled(),frag=fragment(),abortFailure=Error('abort failed');frag.loader.abort=function(){throw abortFailure;};q.fragment=frag;const {observer:other}=observe(q);q.trigger(events.FRAG_LOADING,{frag});assert.throws(()=>q.trigger(events.ERROR,{primary:true,details:'fragLoadError'}),error=>error===abortFailure);const aborted={details:'aborted',frag,stats:frag.loader.stats};q.trigger(events.ERROR,aborted);assert.equal(other.forError(aborted),null);other.dispose();
});
test('active loader ownership is finite and completion releases wrappers without changing delivery',()=>{
 const p=emitter(),{observer,records}=observe(p),fragments=Array.from({length:65},fragment),originals=fragments.map(f=>f.loader.abort);
 for(const frag of fragments)p.trigger(events.FRAG_LOADING,{frag});assert.equal(observer.dropped(),1);assert.equal(fragments[64].loader.abort,originals[64]);
 p.trigger(events.FRAG_LOADED,{frag:fragments[0]});assert.equal(fragments[0].loader.abort,originals[0]);assert.ok(records.some(e=>e.kind==='hls-frag-loaded'&&e.loadId===1));
 const next=fragment(),originalNext=next.loader.abort;p.trigger(events.FRAG_LOADING,{frag:next});assert.notEqual(next.loader.abort,originalNext);assert.equal(observer.dropped(),1);observer.dispose();assert.equal(next.loader.abort,originalNext);for(let i=0;i<fragments.length;i++)assert.equal(fragments[i].loader.abort,originals[i]);
});

test('the pinned native GapController records its actual edge repair without changing target, error or source buffers',()=>{
 const ranges=values=>({length:values.length,start:i=>values[i][0],end:i=>values[i][1]}),audio=ranges([[36.010666,46.015999],[54.016,58.005333]]),video=ranges([[36,60]]),media={currentTime:54,buffered:audio,readyState:2};
 const player=emitter();player.config={...Hls.DefaultConfig};player.bufferController={tracks:{audio:{buffer:{buffered:audio}},video:{buffer:{buffered:video}}}};const gap=Object.create(Hls.DefaultConfig.gapController.prototype);Object.assign(gap,{hls:player,media,fragmentTracker:{getAppendedFrag:()=>null,getPartialFragment:()=>null},skipRetry:0,warn:noop});player.gapController=gap;
 const native=gap._trySkipBufferHole,{records,observer}=observe(player);let seen;player.on(events.ERROR,(_,error)=>{seen={error,cause:observer.forError(error),id:observer.dispatchIdFor(error)};});const frag={type:'main',sn:27,level:0,start:54,end:56,url:'http://owned.test/video.m4s'};
 const target=gap._trySkipBufferHole(frag);assert.equal(target,54.116);assert.equal(media.currentTime,target);assert.equal(seen.error.details,Hls.ErrorDetails.BUFFER_SEEK_OVER_HOLE);assert.equal(seen.error.fatal,false);assert.equal(seen.cause.cause,'native-buffer-hole-repair');assert.equal(seen.cause.errorDispatchId,seen.id);
 const before=records.find(e=>e.kind==='hls-gap-repair'&&e.phase==='before'),after=records.find(e=>e.kind==='hls-gap-repair'&&e.phase==='after');assert.equal(before.beforeTime,54);assert.deepEqual(before.audio,[[36.010666,46.015999],[54.016,58.005333]]);assert.deepEqual(before.video,[[36,60]]);assert.equal(after.targetTime,target);assert.equal(after.returned,true);assert.equal(observer.dropped(),0);
 const unrelated={details:Hls.ErrorDetails.BUFFER_SEEK_OVER_HOLE,fatal:false};player.trigger(events.ERROR,unrelated);assert.equal(observer.forError(unrelated),null,'An error outside the native call cannot borrow a repair');observer.dispose();assert.equal(gap._trySkipBufferHole,native);assert.equal(observer.forError(seen.error),null);
});
test('gap observation metadata failures preserve the original native return and exception',()=>{
 for(const throws of [false,true]){const player=emitter(),failure=Error('native failure'),native=function(){if(throws)throw failure;return 17;};player.gapController={_trySkipBufferHole:native,get media(){throw Error('metadata failure');}};const {observer}=observe(player);if(throws)assert.throws(()=>player.gapController._trySkipBufferHole(),e=>e===failure);else assert.equal(player.gapController._trySkipBufferHole(),17);assert.ok(observer.dropped()>0);observer.dispose();assert.equal(player.gapController._trySkipBufferHole,native);}
});
