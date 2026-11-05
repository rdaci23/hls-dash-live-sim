const {isDeepStrictEqual}=require('node:util');
const {reviewedIdentity}=require('./reviewed-identity.cjs');
const {resourceUrl}=require('./audit.cjs');
const finite=Number.isFinite,positive=n=>Number.isSafeInteger(n)&&n>0;
const kinds=new Set(['startup-observer-installed','startup-observer-disposed','startup-fragment-loading','startup-fragment-loaded','startup-position-call','startup-position','startup-seeking','startup-seeked','startup-seek-handler','startup-seek-cancel']);
function validateStartupProbe(input){
 const m=input.metrics,failures=[],need=(ok,message)=>{if(!ok)failures.push(message);},all=Array.isArray(m?.events)?m.events:[],events=all.filter(e=>typeof e?.kind==='string'&&e.kind.startsWith('startup-'));
 need(input.protocol==='hls'&&input.kind==='wrong-track-init'&&input.startup===true&&reviewedIdentity('causality',input),'Unreviewed native startup scope');
 need(m?.startupProbe===true&&m.startupProbeCompleted===true&&m.startupProbeDropped===0&&m.dropped===0,'Native startup observer missing, incomplete or truncated');
 need(Number.isSafeInteger(m?.frames)&&m.frames>=0&&(m.frames===0||finite(m.firstFrameMs)),'Native startup frame history missing');
 need(events.length>=2&&events.length<=512&&events.every((e,i)=>kinds.has(e.kind)&&e.eventId===i+1&&finite(e.atMs)&&e.atMs>=0&&(!i||e.atMs>=events[i-1].atMs)),'Native startup event history incomplete');
 need(events.every(e=>!['startup-seeking','startup-seeked'].includes(e.kind)||e.trusted===true),'Untrusted startup seek lifecycle event');
 const installed=events.filter(e=>e.kind==='startup-observer-installed'),disposed=events.filter(e=>e.kind==='startup-observer-disposed'),end=disposed[0];
 need(installed.length===1&&installed[0]===events[0]&&installed[0].playerVersion==='1.7.3'&&disposed.length===1&&end===events.at(-1)&&end.dropped===0&&isDeepStrictEqual(end.ownership,{handlers:0,fragments:0,positionHook:0,pendingSeek:0})&&end.atMs>=input.faultWindowBrowser?.toMs,'Native startup observer lifecycle or cleanup incomplete');
 need(Array.isArray(m?.events)&&!all.some(e=>['selection','user-seek'].includes(e?.kind)),'Native startup observation contains player intervention or lacks events');
 const completion=m?.startupCompletion,finish=completion?.snapshotTiming,snapshot=m?.snapshotTiming;
 const rpc=t=>t&&t.probeTimeoutMs===1000&&[t.requestedEpochMs,t.completedEpochMs,t.elapsedMs].every(finite)&&t.elapsedMs>=0&&t.elapsedMs<=1000&&t.completedEpochMs>=t.requestedEpochMs&&Math.abs(t.completedEpochMs-t.requestedEpochMs-t.elapsedMs)<=1;
 need(rpc(finish)&&rpc(snapshot),'Native startup disposal/snapshot RPC missing or outside the one-second bound');
 need(completion?.completed===true&&finite(completion.atMs)&&completion.atMs===end?.atMs&&finite(m?.startEpochMs)&&finite(m?.elapsedMs),'Native startup completion marker mismatch');
 if(rpc(finish)&&rpc(snapshot)&&end&&finite(m?.startEpochMs)){
  const endEpoch=m.startEpochMs+end.atMs,sampleEpoch=m.startEpochMs+m.elapsedMs;
  need(endEpoch>=finish.requestedEpochMs-10&&endEpoch<=finish.completedEpochMs+10&&snapshot.requestedEpochMs>=finish.completedEpochMs&&snapshot.requestedEpochMs<=finish.completedEpochMs+250&&sampleEpoch>=snapshot.requestedEpochMs-10&&sampleEpoch<=snapshot.completedEpochMs+10&&m.elapsedMs>=end.atMs,'Native startup disposal and final snapshot are not one measured boundary');
 }
 return{passed:!failures.length,failures,events};
}
function expectedStartupCancellation(error,input,primaryErrors,probe=validateStartupProbe(input)){
 const p=error.startupCancellation,m=input.metrics;
 if(!probe.passed||error.kind!=='hls'||error.fatal!==false||error.type!=='networkError'||error.details!=='aborted'||error.message!=='Aborted'||error.status!==0||error.frag?.type!=='audio'||!p||p.kind!=='startup-seek-cancel'||p.type!=='audio'||!['abortId','handlerId','seekId','actionId','loadId'].every(k=>positive(p[k]))||!Number.isSafeInteger(p.sn)||p.sn<0||!Number.isSafeInteger(p.level)||p.level<0||p.wasActive!==true||p.statsAborted!==true||!finite(p.atMs)||!finite(error.atMs)||p.atMs>error.atMs||error.atMs>input.faultWindowBrowser.toMs||p.sn!==error.frag.sn||p.level!==error.frag.level||typeof p.url!=='string'||resourceUrl(p.url)!==p.url||p.url!==error.frag.url)return;
 const events=probe.events,one=(kind,test)=>{const rows=events.filter(e=>e.kind===kind&&test(e));return rows.length===1?rows[0]:undefined;};
 const cancel=one('startup-seek-cancel',e=>e.abortId===p.abortId),load=one('startup-fragment-loading',e=>e.loadId===p.loadId),position=one('startup-position',e=>e.actionId===p.actionId),call=one('startup-position-call',e=>e.actionId===p.actionId&&e.phase==='before'),returned=one('startup-position-call',e=>e.actionId===p.actionId&&e.phase==='after'),seek=one('startup-seeking',e=>e.seekId===p.seekId),before=one('startup-seek-handler',e=>e.handlerId===p.handlerId&&e.phase==='before'),after=one('startup-seek-handler',e=>e.handlerId===p.handlerId&&e.phase==='after');
 if(!cancel||!load||!position||!call||!returned||!seek||!before||!after||!Object.keys(p).every(k=>cancel[k]===p[k])||!['type','sn','level','url','loadId'].every(k=>load[k]===p[k])||!finite(position.to)||position.to<=position.from||!finite(returned.to)||!finite(seek.to)||Math.abs(position.to-returned.to)>0.001||Math.abs(position.to-seek.to)>0.001||!finite(error.mediaTime)||Math.abs(position.to-error.mediaTime)>0.001||returned.returned!==true||seek.trusted!==true||seek.actionId!==p.actionId||![before,after].every(e=>e.track==='audio'&&e.seekId===p.seekId&&e.actionId===p.actionId)||after.returned!==true)return;
 const positions=events.filter(e=>e.kind==='startup-position'&&e.actionId<=p.actionId);
 if(!positions.length||positions[0].from!==0||positions.at(-1)!==position||positions.some((e,i)=>{
  const began=one('startup-position-call',c=>c.actionId===e.actionId&&c.phase==='before'),ended=one('startup-position-call',c=>c.actionId===e.actionId&&c.phase==='after');
  return !began||!ended||began.method!==e.method||ended.method!==e.method||began.frameCount!==0||!finite(e.from)||!finite(e.to)||!finite(ended.to)||began.from!==e.from||!['seekToStartPos','audio.doTickIdle'].includes(e.method)||e.to<=e.from||ended.returned!==true||Math.abs(ended.to-e.to)>0.001||!(began.atMs<=e.atMs&&e.atMs<=ended.atMs)||i===0&&began.seekingBefore!==false||i>0&&Math.abs(e.from-positions[i-1].to)>0.001||e.method==='audio.doTickIdle'&&(began.ptsKnown!==true||began.switchingTrack!==true||!finite(began.trackStart)||began.from>=began.trackStart||Math.abs(e.to-began.trackStart-.05)>0.001);
 }))return;
 if(!(load.atMs<=before.atMs&&call.atMs<=position.atMs&&position.atMs<=returned.atMs&&returned.atMs<=seek.atMs&&seek.atMs<=before.atMs&&before.atMs<=p.atMs&&p.atMs<=after.atMs&&after.atMs<=error.atMs)||finite(m.firstFrameMs)&&m.firstFrameMs<=position.atMs)return;
 if(events.some(e=>e.kind==='startup-fragment-loaded'&&e.loadId===p.loadId&&e.atMs<=p.atMs)||events.some(e=>e.kind==='startup-fragment-loading'&&e.loadId!==p.loadId&&['type','sn','level','url'].every(k=>e[k]===p[k])&&e.atMs>load.atMs&&e.atMs<=error.atMs))return;
 const primary=primaryErrors.find(e=>e.signature==='hls-wrong-track-init'&&e.trackKind==='video'&&e.error.atMs>=events[0].atMs&&e.error.atMs<=positions[0].atMs);
 if(!primary)return;
 return{error,signature:'hls-native-startup-seek-cancellation',faultRequestId:primary.faultRequestId,faultIds:primary.faultIds,primaryAtMs:primary.error.atMs,actionId:p.actionId,seekId:p.seekId,handlerId:p.handlerId,abortId:p.abortId,loadId:p.loadId};
}
module.exports={validateStartupProbe,expectedStartupCancellation};
