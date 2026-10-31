const assert=require('node:assert/strict');
const{setTimeout:delay}=require('node:timers/promises');
const{createHash}=require('node:crypto');
const{read}=require('../transport-scenarios/verify.cjs');
const{catalog}=require('../resource-scenarios/verify.cjs');
const{variantEntries,mediaSegments}=require('../../dist/support-tools/hls-playlist.js');
const{fragment,initialization}=require('../dash-abr/fixture.cjs');
const hash=b=>createHash('sha256').update(b).digest('hex');
function definition(name,presetTiming=false){
 const data=structuredClone(require('../../examples/scenarios/bandwidth-'+name+'.json'));
 if(!presetTiming){let at=0;data.timeline=data.timeline.map((p,i)=>{const duration=name==='starvation'?(i===1?20000:4000):(i===0?3000:i%2?5000:3000);const result={...p,afterMs:at,beforeMs:at+duration};at+=duration;return result;});}
 return data;
}
function accept(r,events){
 assert.equal(r.phases.length,r.definition.timeline.length);assert.ok(r.measuredLowestKbps>50,'starvation cap must be below encoded requirement');
 assert.ok(!events.some(e=>['request.error','diagnostics.file_limit','diagnostics.file_error'].includes(e.event)));
 for(const phase of r.phases){
  assert.equal(phase.status,200);assert.ok(phase.bytes>100);assert.ok(phase.chunks>1);assert.equal(phase.sha256,phase.referenceSha256);
  const min=phase.bytes/(phase.kbps*125)*1000;assert.ok(phase.durationMs>=Math.max(0,min-100),'body was not paced');
  const applied=events.find(e=>e.event==='fault.applied'&&e.fault==='response.bandwidth'&&e.requestId===phase.requestId);
  assert.ok(applied&&applied.bandwidthKbps===phase.kbps&&applied.phaseId==='phase:'+phase.index);
 }
 for(let n=1;n<r.phases.length;n++)assert.ok(BigInt(r.phases[n].position)>BigInt(r.phases[n-1].position),'publication must advance across every phase');
 if(r.name==='starvation'){
  assert.equal(r.phases[1].kbps,50);assert.ok(r.cancellation&&!r.cancellation.complete);
  assert.ok(events.some(e=>e.event==='request.cancelled'&&e.requestId===r.cancellation.requestId));
  assert.ok(r.activeTransfer.startedBeforeBoundary&&r.activeTransfer.endedAfterBoundary&&r.activeTransfer.durationMs<2500,'restoration must accelerate an active transfer');
 }else assert.equal(r.phases.filter(p=>p.kbps===450).length,4);
 assert.ok(r.manifestsAdvanced);assert.equal(r.scenario.result,'passed');assert.deepEqual(r.scenario.profile,{bandwidthKbps:0,jitterMs:0,manifestFreeze:false});
}
async function verify(session,protocol,name,{signal,evidence={},onPhase=()=>{}}={}){
 const def=session.scenario.definition,last=def.timeline.at(-1).beforeMs,elapsed=()=>session.scenario.report().elapsedMs;
 const wait=async t=>{for(;;){const left=t-elapsed();if(left<=0)break;await delay(Math.max(1,Math.min(250,left)),undefined,{signal});}signal?.throwIfAborted();};
 Object.assign(evidence,{protocol,name,definition:def,phases:[],requests:[],passed:false,scope:'HTTP network pacing and restoration; browser buffering/ABR unverified'});
 const get=async(url,label,options={})=>{const start=elapsed(),v=await read(url,{timeoutMs:30000,...options,signal});const row={label,startMs:start,endMs:elapsed(),status:v.status,bytes:v.bytes.length,sha256:hash(v.bytes),durationMs:v.durationMs,chunks:v.chunks.length,requestId:v.headers['x-sim-request-id'],faultIds:v.headers['x-sim-fault-ids']};evidence.requests.push(row);return{...v,row};};
 let baselinePosition,latestPosition,reference;
 const discover=async label=>{
  const root=await get(new URL(session.url),label+'-root');assert.equal(root.status,200);let media,duration,init;
  if(protocol==='hls'){
   const uri=new URL(variantEntries(root.bytes.toString())[0].uri,session.url),pl=await get(uri,label+'-playlist'),seg=mediaSegments(pl.bytes.toString()).at(-1);
   media=new URL(seg.uri,uri);duration=seg.duration;latestPosition=BigInt(/segment-(\d+)/.exec(seg.uri)[1]);
  }else{
   const entries=await catalog(root.bytes.toString(),session.url,'dash'),entry=entries.find(e=>e.track==='video:0');media=entry.media;init=entry.init;
   const head=await get(new URL('/static/time.txt',session.url),label+'-utc',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(head.row.faultIds,undefined);assert.ok(Math.abs(Date.parse(head.headers.date)-Date.now())<2500);
  }
  const h=await get(new URL('/health',session.url),label+'-health');assert.equal(h.status,200);assert.equal(h.row.faultIds,undefined);
  const head=await get(media,label+'-head',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.row.faultIds,undefined);
  return{media,duration,init};
 };
 for(const[index,p]of def.timeline.entries()){
  await wait(p.afterMs+100);onPhase(index,p.network.bandwidthKbps);
  const source=await discover('phase-'+index);
  const response=await get(source.media,'phase-'+index+'-media');assert.ok(response.complete);assert.equal(response.status,200);
  if(protocol==='dash'){
   const init=await get(source.init,'phase-'+index+'-init'),scale=initialization(init.bytes).timescale,info=fragment(response.bytes);source.duration=info.duration/scale;latestPosition=info.baseTime;
  }
  baselinePosition??=latestPosition;
  const bitrate=response.bytes.length*8/source.duration/1000;if(index===0)evidence.measuredLowestKbps=bitrate;
  const row={...response.row,index,kbps:p.network.bandwidthKbps,position:String(latestPosition),referenceSha256:null};evidence.phases.push(row);
  assert.ok(elapsed()<p.beforeMs-200,'phase request overran the window');
  if(name==='starvation'&&index===1){
   reference={url:source.media,row};
   const cancelled=await get(source.media,'cancelled-starved-media',{cancelAfterBytes:1024});assert.equal(cancelled.complete,false);evidence.cancellation={complete:cancelled.complete,requestId:cancelled.row.requestId};
   await wait(p.beforeMs-500);const crossed=await get(source.media,'active-at-restoration');assert.ok(crossed.complete);assert.equal(crossed.row.sha256,row.sha256);
   evidence.activeTransfer={durationMs:crossed.durationMs,startedBeforeBoundary:crossed.row.startMs<p.beforeMs,endedAfterBoundary:crossed.row.endMs>=p.beforeMs};
  }else{
   // Repeat immediately under the same profile; final unshaped reference below
   // separately establishes byte identity without crediting a different segment.
   const same=await get(source.media,'phase-'+index+'-byte-reference');assert.ok(same.complete);row.referenceSha256=same.row.sha256;
  }
 }
 await wait(last+100);const current=await discover('after-end');const normal=await get(current.media,'after-end-media');assert.ok(normal.complete);assert.equal(normal.row.faultIds,undefined);
 if(reference){const plain=await get(reference.url,'unshaped-restricted-reference');assert.ok(plain.complete);reference.row.referenceSha256=plain.row.sha256;assert.equal(plain.row.faultIds,undefined);}
 evidence.manifestsAdvanced=latestPosition>baselinePosition;evidence.scenario=session.scenario.report();accept(evidence,session.diagnostics.snapshot().events);evidence.passed=true;return evidence;
}
module.exports={definition,verify,accept};
