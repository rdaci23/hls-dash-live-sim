// Explain a native audio-gap repair only from the delivered outage, native call,
// loaded resources and independently retained encoded timestamp controls.
const {isDeepStrictEqual}=require('node:util');
const {assess}=require('./hls-audio-restoration.cjs');
const {validateCausalCompletion}=require('./causal-completion.cjs');
const {reviewedIdentity}=require('./reviewed-identity.cjs');
const finite=Number.isFinite,near=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<=.001;
function expectedRepair(error,input,primaryErrors){
 if(!error||typeof error!=='object')return;
 const {metrics:m,restored,faultWindowBrowser:window,audioRestoration:proof}=input;
 if(input.protocol!=='hls'||input.kind!=='audio-outage'||!reviewedIdentity('scenario',input)||error.kind!=='hls'||error.type!=='mediaError'||error.details!=='bufferSeekOverHole'||error.fatal!==false||!assess(proof).passed)return;
 const decoded=restored?.browser?.firstDecodedAtMs,continued=restored?.browser?.continuedToMs;
 if(!finite(window?.fromMs)||!finite(window?.toMs)||Math.abs(window.toMs-window.fromMs-15000)>.001||!finite(decoded)||!finite(continued)||continued-decoded<60000||!finite(error.atMs)||error.atMs<window?.toMs||error.atMs>=decoded||proof.files.some(r=>r.scenarioElapsedMs<50000)||!validateCausalCompletion(m,{minimumAtMs:continued}).passed)return;
 const cause=error.hlsCausality,id=error.nativeDispatchId;
 if(cause?.schemaVersion!==1||cause.cause!=='native-buffer-hole-repair'||!Number.isSafeInteger(id)||id<1||cause.errorDispatchId!==id||!Number.isSafeInteger(cause.gapCallId)||cause.gapCallId<1)return;
 if(primaryErrors.some(e=>e.signature==='hls-audio-outage-native-repair'&&e.gapCallId===cause.gapCallId))return;
 const events=m.events,select=predicate=>events.filter(predicate),calls=select(e=>e.kind==='hls-gap-repair'&&e.callId===cause.gapCallId),before=calls.find(e=>e.phase==='before'),after=calls.find(e=>e.phase==='after'),dispatch=select(e=>e.kind==='hls-error-dispatch'&&e.errorDispatchId===id),begin=dispatch.find(e=>e.phase==='before'),end=dispatch.find(e=>e.phase==='after');
 if(calls.length!==2||dispatch.length!==2||!before||!after||!begin||!end||after.returned!==true||!(events.indexOf(before)<events.indexOf(begin)&&events.indexOf(begin)<events.indexOf(end)&&events.indexOf(end)<events.indexOf(after)))return;
 if(![before.atMs,after.atMs,begin.atMs,end.atMs,before.beforeTime,after.targetTime,after.afterTime].every(finite)||before.atMs>begin.atMs||begin.atMs>error.atMs||error.atMs>end.atMs||end.atMs>after.atMs||before.maxBufferHole!==.1||before.padding!==.1||!near(error.mediaTime,after.targetTime)||!near(after.afterTime,after.targetTime))return;
 if(begin.type!==error.type||begin.details!==error.details||begin.fatal!==false||end.type!==error.type||end.details!==error.details||end.fatal!==false)return;
 const valid=r=>Array.isArray(r)&&r.length>0&&r.length<=32&&r.every((p,i)=>Array.isArray(p)&&p.length===2&&p.every(finite)&&p[0]>=0&&p[1]>p[0]&&(!i||p[0]>r[i-1][1]));
 if(!valid(before.audio)||!valid(before.video)||!valid(before.buffered))return;
 const next=before.audio.find(r=>r[0]>before.beforeTime),previous=before.audio.filter(r=>r[1]<=before.beforeTime).at(-1);
 if(!next||!previous||next[0]-previous[1]>15000/1000||!before.buffered.some(r=>near(r[0],next[0]))||!before.video.some(r=>r[0]<=before.beforeTime&&r[1]>=after.targetTime)||!near(after.targetTime,next[0]+before.padding))return;
 const message=/^fragment loaded with buffer holes, seeking from (\d+(?:\.\d+)?) to (\d+(?:\.\d+)?)$/.exec(error.message??'');
 if(!message||!near(Number(message[1]),before.beforeTime)||!near(Number(message[2]),after.targetTime)||error.reason!==error.message)return;
 const frag=before.fragment;if(frag?.type!=='main'||frag.level!==0||!Number.isSafeInteger(frag.cc)||!Number.isSafeInteger(frag.sn)||!finite(frag.start)||!finite(frag.end)||frag.end<=frag.start||frag.end<next[0]-.001||!isDeepStrictEqual(frag,begin.fragment)||frag.url!==error.frag?.url||frag.sn!==error.frag?.sn||error.frag?.type!=='main'||error.frag?.level!==0||!isDeepStrictEqual(begin.fragment,end.fragment))return;
 const pts=events.filter(e=>e.kind==='hls-init-pts'&&e.cc===frag.cc&&e.atMs<=before.atMs).at(-1);
 if(!pts||!finite(pts.baseTime)||!Number.isSafeInteger(pts.timescale)||pts.timescale<=0)return;
 const offset=pts.baseTime/pts.timescale,atMs=before.atMs;
 function loaded(track){
  return events.filter(e=>e.kind==='hls-frag-loaded'&&e.status===200&&e.bytes>0&&Number.isSafeInteger(e.loadId)&&e.loadId>0&&events.filter(x=>x.kind==='hls-frag-loaded'&&x.loadId===e.loadId).length===1&&typeof e.requestId==='string'&&e.atMs<=atMs&&e.fragment?.type===(track==='audio:0'?'audio':'main')&&e.fragment.level===0&&e.fragment.cc===frag.cc).flatMap(e=>{
   const file=proof.files.find(f=>f.track===track&&f.resource==='media'&&f.sequence===e.fragment.sn&&f.url===e.fragment.url&&f.bytes===e.bytes),timing=file&&proof.timings[track].segments.find(s=>s.sequence===file.sequence),scale=proof.timings[track].timescale;
   const responses=(input.browserResponses??[]).filter(r=>r.requestId===e.requestId),response=responses.length===1&&responses.find(r=>r.url===e.fragment.url&&r.method==='GET'&&r.status===200&&!r.faultIds&&finite(r.receivedEpochMs)&&r.receivedEpochMs<=m.startEpochMs+e.atMs+250);
   if(!file||!timing||!response)return[];
   const start=Number(BigInt(timing.baseTime))/scale-offset,finish=start+timing.duration/scale;
   if(Math.abs(start-next[0])>1024/proof.timings['audio:0'].timescale+.001||finish<=next[0]||!near(e.fragment.start,start))return[];
   return[{requestId:e.requestId,requestResourceId:response.requestResourceId,url:e.fragment.url,bytes:e.bytes,track,sourceSequence:file.sequence,start,atMs:e.atMs}];
  }).at(-1);
 }
 const audio=loaded('audio:0'),video=loaded('video:0');
 if(!audio||!video||audio.atMs<window.toMs||audio.sourceSequence!==video.sourceSequence||primaryErrors.some(e=>e.signature==='hls-audio-outage-native-repair'&&e.refillRequests?.some(r=>r.requestId===audio.requestId)))return;
 const primary=primaryErrors.find(p=>{
  if(p.trackKind!=='audio'||p.error?.kind!=='hls'||p.error.details!=='fragLoadError'||p.error.status!==503||p.error.atMs>=error.atMs||!Number.isSafeInteger(p.error.nativeDispatchId))return false;
  const pair=events.filter(e=>e.kind==='hls-error-dispatch'&&e.errorDispatchId===p.error.nativeDispatchId),e=pair.find(e=>e.phase==='before'),done=pair.find(e=>e.phase==='after'),f=e?.fragment;
  return pair.length===2&&e?.status===503&&done?.status===503&&e.type===p.error.type&&e.details===p.error.details&&isDeepStrictEqual(f,done.fragment)&&f?.type==='audio'&&f.level===0&&f.cc===frag.cc&&f.url===p.error.frag?.url&&f.sn===p.error.frag?.sn&&finite(f.start)&&finite(f.end)&&f.start<next[0]&&f.end>previous[1]&&f.start>=previous[1]-1024/proof.timings['audio:0'].timescale&&f.end<=next[0]+.001&&e.atMs<=p.error.atMs&&p.error.atMs<=done.atMs;
 });
 if(!primary)return;
 return{error,signature:'hls-audio-outage-native-repair',trackKind:'audio',faultRequestId:primary.faultRequestId,faultIds:primary.faultIds,gapCallId:cause.gapCallId,errorDispatchId:id,refillRequests:[audio,video],skippedSeconds:after.targetTime-before.beforeTime,bufferStart:next[0],sourceOffsetSeconds:offset};
}
module.exports={expectedRepair};
