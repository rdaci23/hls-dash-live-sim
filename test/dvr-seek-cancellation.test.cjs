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
  clock=1001;media.dispatchEvent(new Event('seeking'));if(options.reload){frag.loader={stats:{aborted:false}};player.trigger(Hls.Events.FRAG_LOADING,{frag});}await Promise.all(pending);
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
