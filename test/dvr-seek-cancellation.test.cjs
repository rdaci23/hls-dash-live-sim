const test=require('node:test'),assert=require('node:assert/strict'),Hls=require('hls.js');
const {observeSeeks=()=>({beginSeek(){},causeFor(){return null;},dropped(){return 0;}})}=require('../scripts/track-browser/cancellation.js');
const {expectedSeekCancellation=()=>false}=require('../scripts/browser/dvr-acceptance.cjs');
const noop=()=>{},logger=Object.fromEntries(['trace','debug','log','warn','info','error'].map(k=>[k,noop]));
function emitter(){const listeners=new Map();return{logger,config:{...Hls.DefaultConfig},on(event,fn,context){const a=listeners.get(event)??[];a.push([fn,context]);listeners.set(event,a);},off(){},trigger(event,data){for(const [fn,c]of listeners.get(event)??[])fn.call(c,event,data);return true;}};}
async function nativeSeek(type='main',options={}){
 const before=Object.getOwnPropertyDescriptor(globalThis,'self');globalThis.self=globalThis;
 try{
  const player=emitter(),tracker={removeFragmentsInRange:noop,removeFragment:noop},key={};
  const Class=Hls.DefaultConfig[type==='main'?'streamController':type==='subtitle'?'subtitleStreamController':'audioStreamController'];
  const controller=new Class(player,tracker,key),media=new EventTarget();Object.assign(media,{currentTime:0,seeking:true,buffered:{length:0},readyState:2});
  const loader=new Hls.DefaultConfig.loader({}),stats=loader.stats,pending=[];let abortCalls=0;
  const frag={type,sn:28,level:type==='main'?1:0,start:56,duration:2,url:'http://user:password@owned.test/media?token=secret#private',loader,abortRequests(){this.loader?.abort();}};
  loader.loader={readyState:1,abort(){abortCalls++;this.readyState=0;}};loader.context={url:frag.url};stats.aborted=false;
  let nativeError;loader.callbacks={onAbort(abortedStats){nativeError={kind:'hls',atMs:1003,fatal:false,type:'networkError',details:'aborted',message:'Aborted',status:0,frag,stats:options.wrongStats?{aborted:true}:abortedStats};loader.destroy();frag.loader=null;pending.push(Promise.resolve().then(()=>player.trigger(Hls.Events.ERROR,nativeError)));}};
  Object.assign(controller,{media,mediaBuffer:media,fragCurrent:frag,_state:'FRAG_LOADING',levels:[],fragmentTracker:tracker});
  controller.isFragmentNearlyDownloaded=()=>false;controller.resetLoadingState=noop;controller.getLevelDetails=()=>undefined;controller.shouldLoadParts=()=>false;
  player.hasEnoughToStart=true;player.networkControllers=[controller];const records=[];let clock=1000;
  const observer=observeSeeks(player,Hls.Events,media,e=>records.push(e),()=>clock);
  media.addEventListener('seeking',controller.onMediaSeeking);player.trigger(Hls.Events.FRAG_LOADING,{frag});
  const action={action:'seek-outside',actionId:2,to:0,atMs:999};if(options.arm!==false)observer.beginSeek(action);
  clock=1001;media.dispatchEvent(new Event('seeking'));if(options.reload){frag.loader={stats:{aborted:false},abort:noop};player.trigger(Hls.Events.FRAG_LOADING,{frag});}await Promise.all(pending);
  const proof=observer.causeFor(nativeError),error={...nativeError,atMs:1003,frag:{type,sn:28,level:frag.level,url:'http://owned.test/media'},seekCancellation:proof};
  return{observer,records,action,error,nativeError,abortCalls,stats,player,frag};
 }finally{if(before)Object.defineProperty(globalThis,'self',before);else delete globalThis.self;}
}
for(const type of ['main','subtitle','audio'])test('pinned '+type+' onMediaSeeking links the exact loader abort to its explicit user seek',async()=>{
 assert.equal(Hls.version,'1.7.3');const r=await nativeSeek(type);assert.ok(r.abortCalls>=1);assert.equal(r.stats.aborted,true);assert.ok(r.error.seekCancellation,'The native seek abort must retain its direct cause');assert.equal(r.observer.dropped(),0);
 assert.equal(expectedSeekCancellation(r.error,r.records,[r.action]),true);
 for(const secret of ['password','secret','token=','user:'])assert.equal(JSON.stringify(r.records).includes(secret),false);
 for(const edit of [e=>e.fatal=true,e=>e.frag.sn++,e=>e.frag.level++,e=>e.frag.url+='other',e=>e.seekCancellation.loadId++,e=>e.details='fragLoadError',e=>e.message='other',e=>e.seekCancellation=null]){const e=structuredClone(r.error);edit(e);assert.equal(expectedSeekCancellation(e,r.records,[r.action]),false,edit.toString());}
 assert.equal(expectedSeekCancellation(r.error,r.records,[]),false);assert.equal(expectedSeekCancellation(r.error,r.records.filter(e=>e.kind!=='user-seeking'),[r.action]),false);assert.equal(expectedSeekCancellation(r.error,r.records.filter(e=>e.kind!=='seek-handler'||e.phase!=='after'),[r.action]),false);
 assert.equal(r.observer.causeFor({...r.nativeError}),null,'Lookalike error objects have no proof');
});
test('an automatic native seek never gains explicit user-action proof',async()=>{const r=await nativeSeek('main',{arm:false});assert.ok(r.abortCalls>=1);assert.equal(r.error.seekCancellation,null);assert.equal(expectedSeekCancellation(r.error,r.records,[]),false);});

test('same-URL copies, wrong loader stats and a superseding load attempt cannot acquire seek proof',async()=>{
 for(const options of [{wrongStats:true},{reload:true}]){const r=await nativeSeek('main',options);assert.equal(r.error.seekCancellation,null);}
 const r=await nativeSeek('main');const duplicate={...r.nativeError};r.player.trigger(Hls.Events.ERROR,duplicate);assert.equal(r.observer.causeFor(duplicate),null);
 const copy=r.observer.causeFor(r.nativeError);copy.loadId=-1;assert.ok(r.observer.causeFor(r.nativeError).loadId>0);
 for(const edit of [events=>events.filter(e=>e.kind!=='seek-cancel'),events=>[...events,events.find(e=>e.kind==='seek-cancel')],events=>events.map(e=>e.kind==='seek-handler'&&e.phase==='after'?{...e,returned:false}:e),events=>events.map(e=>e.kind==='user-seeking'?{...e,to:1}:e)])assert.equal(expectedSeekCancellation(r.error,edit(r.records),[r.action]),false);
});

// The DOM schedules a second seeking event after the pinned live-edge writer
// clamps an explicit out-of-window seek. The new subtitle load belongs to that
// second event, rather than the first user-seeking handler.
async function nativeClampedSeek(options={}){
 const before=Object.getOwnPropertyDescriptor(globalThis,'self');globalThis.self=globalThis;
 try{
  const player=emitter(),tracker={removeFragmentsInRange:noop,removeFragment:noop},key={};
  const main=new Hls.DefaultConfig.streamController(player,tracker,key),subtitle=new Hls.DefaultConfig.subtitleStreamController(player,tracker,key);
  class Media{
   constructor(){this.position=49;this.listeners=new Map();this.seeking=false;this.readyState=2;this.duration=Infinity;this.buffered={length:1,start:()=>48,end:()=>52};}
   get currentTime(){return this.position;}set currentTime(value){if(value===45&&options.positionError)throw options.positionError;this.position=value;this.seeking=true;}
   addEventListener(name,fn,capture){const rows=this.listeners.get(name)??[];rows.push({fn,capture:!!capture});this.listeners.set(name,rows);}
   removeEventListener(name,fn){this.listeners.set(name,(this.listeners.get(name)??[]).filter(r=>r.fn!==fn));}
   fire(name,trusted=true){const event={type:name,target:this,isTrusted:trusted};for(const {fn}of [...this.listeners.get(name)??[]].sort((a,b)=>Number(b.capture)-Number(a.capture)))fn.call(this,event);}
   getVideoPlaybackQuality(){if(options.qualityError)throw options.qualityError;return{totalVideoFrames:100};}
  }
  const media=new Media(),records=[],pending=[];let clock=1000,nativeError,abortCalls=0;
  for(const controller of [main,subtitle]){Object.assign(controller,{media,mediaBuffer:media,_state:'IDLE',levels:[],fragmentTracker:tracker});controller.isFragmentNearlyDownloaded=()=>false;controller.resetLoadingState=noop;controller.getLevelDetails=()=>undefined;controller.shouldLoadParts=()=>false;controller.tick=noop;}
  Object.assign(player,{streamController:main,networkControllers:[main,subtitle],hasEnoughToStart:true,liveSyncPosition:45});main._hasEnoughToStart=true;
  const api=require('../scripts/track-browser/cancellation.js'),record=e=>{if(options.recordError)throw options.recordError;records.push(e);},observer=api.observeDvrSeeks?api.observeDvrSeeks(Hls,player,media,record,()=>clock):api.observeSeeks(player,Hls.Events,media,record,()=>clock);
  const switches=options.subtitleObserver?api.observe(player,Hls.Events,record,()=>clock):undefined;
  for(const controller of player.networkControllers)media.addEventListener('seeking',controller.onMediaSeeking);
  const action={action:'seek-outside',actionId:2,to:0,atMs:999};
  if(options.explicit!==false){if(observer.seek)observer.seek(action);else{observer.beginSeek(action);media.currentTime=action.to;}}
  else media.currentTime=0;
  clock=1001;media.fire('seeking',options.rootTrusted!==false);
  if(options.settled){media.seeking=false;media.fire('seeked');}
  if(options.intervene){media.currentTime=options.intervene==='same'?0:1;media.fire('seeking');}
  if(options.supersede){const next={...action,action:'seek-inside-and-play',actionId:3};if(observer.seek)observer.seek(next);else{observer.beginSeek(next);media.currentTime=next.to;}media.fire('seeking');}
  const loader=new Hls.DefaultConfig.loader({}),stats=loader.stats;
  const frag={type:'subtitle',sn:21,level:0,start:42,duration:2,url:'http://owned.test/subtitle',loader,abortRequests(){this.loader?.abort();}},nativeAbortRequests=frag.abortRequests;
  const wrappers=[];if(options.subtitleObserver){let method=frag.abortRequests;Object.defineProperty(frag,'abortRequests',{configurable:true,get:()=>method,set:value=>{wrappers.push(value);method=value;}});}
  loader.loader={readyState:1,abort(){abortCalls++;this.readyState=0;}};loader.context={url:frag.url};stats.aborted=false;
  loader.callbacks={onAbort(abortedStats){nativeError={kind:'hls',atMs:1005,fatal:false,type:'networkError',details:'aborted',message:'Aborted',status:0,frag,stats:options.wrongStats?{aborted:true}:abortedStats};loader.destroy();frag.loader=null;pending.push(Promise.resolve().then(()=>player.trigger(Hls.Events.ERROR,nativeError)));}};
  if(options.load!==false){subtitle.fragCurrent=frag;subtitle._state='FRAG_LOADING';clock=1002;player.trigger(Hls.Events.FRAG_LOADING,{frag});}
  if(options.completed)stats.loading.end=1002;
  const from=media.currentTime;let writerResult,writerError;clock=1003;try{if(options.clamp!==false)writerResult=main.synchronizeToLiveEdge({fragmentStart:42,edge:54,targetduration:3});}catch(error){writerError=error;}
  clock=1004;if(media.currentTime!==from)media.fire('seeking',options.trusted!==false);
  if(options.reload){frag.loader={stats:{aborted:false},abort:noop};player.trigger(Hls.Events.FRAG_LOADING,{frag});}
  await Promise.all(pending);
  const error=nativeError&&{...nativeError,frag:{type:'subtitle',sn:21,level:0,url:frag.url},seekCancellation:observer.causeFor(nativeError)};
  return{observer,records,action,error,nativeError,abortCalls,media,player,main,subtitle,frag,writerResult,writerError,switches,wrappers,nativeAbortRequests};
 }finally{if(before)Object.defineProperty(globalThis,'self',before);else delete globalThis.self;}
}
test('pinned live-edge clamp preserves the explicit DVR seek cause through the second DOM event',async()=>{
 const r=await nativeClampedSeek();assert.equal(r.media.currentTime,45);assert.ok(r.abortCalls>=1);assert.equal(r.error.details,'aborted');
 assert.ok(r.error.seekCancellation,'The native clamp must retain the explicit user seek, native writer and exact subtitle load/abort chain');assert.equal(expectedSeekCancellation(r.error,r.records,[r.action]),true);r.observer.dispose();
});
test('the minimized native clamp needs a live load and the second native seek to produce an abort',async()=>{
 for(const options of [{load:false},{clamp:false}]){const r=await nativeClampedSeek(options);assert.equal(r.error,undefined);assert.equal(r.abortCalls,0);r.observer.dispose();}
 const r=await nativeClampedSeek({explicit:false});assert.ok(r.abortCalls>=1);assert.equal(r.error.seekCancellation,null,'An automatic clamp cannot borrow a missing user action');r.observer.dispose();
});
test('automatic, settled, intervened, untrusted and different-attempt clamps cannot borrow the user seek',async()=>{
 for(const options of [{explicit:false},{settled:true},{intervene:true},{intervene:'same'},{supersede:true},{trusted:false},{rootTrusted:false},{wrongStats:true},{reload:true},{completed:true}]){
  const r=await nativeClampedSeek(options);assert.ok(r.error,JSON.stringify(options));assert.equal(r.error.seekCancellation,null,JSON.stringify(options));assert.equal(expectedSeekCancellation(r.error,r.records,[r.action]),false);
  if(options.reload)assert.equal(r.observer.ownership().fragments,1,'An older error must not release a superseding active load');
  r.observer.dispose();assert.ok(Object.values(r.observer.ownership()).every(n=>n===0));
 }
});
test('native clamp proof rejects missing, duplicate, conflicting and reordered causal records',async()=>{
 const r=await nativeClampedSeek();assert.equal(expectedSeekCancellation(r.error,r.records,[r.action]),true);
 const find=(rows,kind,phase)=>rows.find(e=>e.kind===kind&&(!phase||e.phase===phase));
 const edits=[
  rows=>rows.filter(e=>e.kind!=='dvr-clamp-position'),rows=>[...rows,structuredClone(find(rows,'dvr-clamp-call','before'))],
  rows=>{find(rows,'dvr-clamp-call','before').from=5;return rows;},rows=>{find(rows,'dvr-clamp-call','before').liveSyncPosition=46;return rows;},
  rows=>{find(rows,'dvr-clamp-call','before').liveSyncMode='buffered';return rows;},rows=>{find(rows,'dvr-clamp-call','before').frames=0;return rows;},
  rows=>{find(rows,'dvr-clamp-call','before').fragmentStart=0;return rows;},rows=>{find(rows,'dvr-clamp-call','after').returned=false;return rows;},
  rows=>{find(rows,'dvr-clamp-call','after').writes=2;return rows;},rows=>{find(rows,'native-clamp-seeking').trusted=false;return rows;},
  rows=>{find(rows,'native-clamp-seeking').rootSeekId++;return rows;},rows=>{find(rows,'seek-fragment-loading').sn++;return rows;},
  rows=>{find(rows,'seek-fragment-ended').outcome='loaded';return rows;},rows=>{find(rows,'dvr-user-position').actualTo=1;return rows;},
  rows=>{const i=rows.findIndex(e=>e.kind==='native-clamp-seeking');rows.splice(i,0,{kind:'dvr-seek-finished',atMs:1003});return rows;},
  rows=>{const i=rows.findIndex(e=>e.kind==='native-clamp-seeking');rows.splice(i,0,{kind:'dvr-unowned-position',atMs:1003});return rows;},
  rows=>{const a=rows.findIndex(e=>e.kind==='dvr-clamp-position'),b=rows.findIndex(e=>e.kind==='dvr-clamp-call'&&e.phase==='after');[rows[a],rows[b]]=[rows[b],rows[a]];return rows;},
 ];
 for(const edit of edits){const rows=edit(structuredClone(r.records));assert.equal(expectedSeekCancellation(r.error,rows,[r.action]),false,edit.toString());}
 for(const key of ['clampCallId','rootSeekId','loadId']){const error=structuredClone(r.error);delete error.seekCancellation[key];assert.equal(expectedSeekCancellation(error,r.records,[r.action]),false);}
 assert.equal(r.observer.causeFor({...r.nativeError}),null);r.observer.dispose();
});
test('DVR observation preserves native returns, exceptions, position and owned cleanup',async()=>{
 const normal=await nativeClampedSeek();assert.equal(normal.writerResult,undefined);assert.equal(normal.writerError,undefined);assert.equal(normal.media.currentTime,45);assert.equal(normal.observer.dropped(),0);
 normal.observer.dispose();normal.observer.dispose();assert.equal(normal.main.synchronizeToLiveEdge,Hls.DefaultConfig.streamController.prototype.synchronizeToLiveEdge);assert.equal(Object.hasOwn(normal.media,'currentTime'),false);assert.ok(Object.values(normal.observer.ownership()).every(n=>n===0));assert.equal(normal.frag.abortRequests.toString().includes('wasActive'),false);
 const failure=Error('native setter failure'),thrown=await nativeClampedSeek({positionError:failure});assert.equal(thrown.writerError,failure);assert.equal(thrown.media.currentTime,0);assert.equal(thrown.error,undefined);thrown.observer.dispose();
 const measured=await nativeClampedSeek({qualityError:Error('unavailable metadata')});assert.equal(measured.media.currentTime,45);assert.equal(measured.writerError,undefined);assert.ok(measured.observer.dropped()>0);assert.equal(measured.error.seekCancellation,null);measured.observer.dispose();
 const lost=await nativeClampedSeek({recordError:Error('evidence sink failure')});assert.equal(lost.media.currentTime,45);assert.equal(lost.writerError,undefined);assert.ok(lost.observer.dropped()>0);assert.equal(expectedSeekCancellation(lost.error,lost.records,[lost.action]),false);lost.observer.dispose();
});
test('DVR and subtitle-switch observers compose without retaining a completed managed fragment wrapper',async()=>{
 const r=await nativeClampedSeek({subtitleObserver:true});assert.equal(expectedSeekCancellation(r.error,r.records,[r.action]),true);assert.equal(r.observer.dropped(),0);assert.equal(r.observer.ownership().fragments,0);
 assert.equal(r.wrappers.length,3,'subtitle wrapper, managed wrapper, then restored subtitle wrapper');assert.equal(r.wrappers[0],r.wrappers[2]);assert.notEqual(r.frag.abortRequests,r.nativeAbortRequests,'The other observer still owns its wrapper');assert.equal(r.switches.causeFor(r.nativeError),null,'A nearby user seek is not a subtitle track switch');
 const trigger=r.player.trigger;r.observer.dispose();assert.equal(r.player.trigger,trigger,'Disposal must not replace another observer');assert.equal(r.observer.causeFor(r.nativeError),null);assert.equal(r.player.trigger('unrelated',{}),true);assert.ok(Object.values(r.observer.ownership()).every(n=>n===0));
});
