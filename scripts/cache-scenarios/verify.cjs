const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {catalog}=require('../resource-scenarios/verify.cjs');
const {variantEntries,mediaSegments}=require('../../dist/support-tools/hls-playlist.js');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const hash=body=>createHash('sha256').update(body).digest('hex');
async function read(url,options){
 // Raw conditional probe keeps the requested cache policy exact: fetch adds
 // Pragma/no-cache for conditional requests, which correctly bypasses a cache.
 if(options?.headers?.['If-None-Match'])return new Promise((resolve,reject)=>{
  const request=require('node:http').request(url,{method:options.method??'GET',headers:options.headers},response=>{
   const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024)request.destroy(Error('Probe body limit exceeded'));else chunks.push(chunk);});
   response.on('aborted',()=>reject(Error('Probe response aborted')));response.on('error',reject);response.on('end',()=>{const body=Buffer.concat(chunks),headers=new Headers(Object.entries(response.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):v]));resolve({r:{status:response.statusCode,headers},body,sha256:hash(body),requestId:headers.get('x-sim-request-id')});});
  });request.setTimeout(5000,()=>request.destroy(Error('Probe timeout')));request.on('error',reject);request.end();
 });
 const r=await fetch(url,options);const body=Buffer.from(await r.arrayBuffer());return{r,body,sha256:hash(body),requestId:r.headers.get('x-sim-request-id')};
}
async function verifyNegative(source,edge,protocol,ttlMs=1600){
 const entries=await catalog((await read(edge.url)).body.toString(),edge.url,protocol),sourceEntries=await catalog((await read(source.url)).body.toString(),source.url,protocol);
 const target=entries.find(e=>e.track==='video:0').init, sourceTarget=sourceEntries.find(e=>e.track==='video:0').init, responses=[];
 const capture=async(label,options)=>{const result=await read(target,options);responses.push({label,status:result.r.status,bytes:result.body.length,sha256:result.sha256,requestId:result.requestId,faultIds:result.r.headers.get('x-sim-fault-ids'),age:result.r.headers.get('age')});return result;};
 const head=await capture('before-head',{method:'HEAD',headers:{Range:'bytes=0-31'}});assert.equal(head.r.status,200);assert.equal(head.body.length,0);assert.equal(edge.scenario.report().cache.entries,0);
 const first=await capture('origin-404-fill');assert.equal(first.r.status,404);assert.ok(first.body.length);assert.equal(edge.scenario.report().cache.entries,1);
 const originRestored=await read(sourceTarget);assert.equal(originRestored.r.status,200);assert.ok(originRestored.body.length);
 const count=()=>source.diagnostics.snapshot().events.filter(e=>e.event==='request.started').length,before=count();
 const hit=await capture('edge-hit-after-origin-restored');assert.equal(hit.r.status,404);assert.deepEqual(hit.body,first.body);assert.ok(hit.r.headers.get('x-sim-fault-ids'));assert.equal(count(),before,'actual edge hit must not fetch origin');
 const fresh=await capture('no-cache-bypass',{headers:{'Cache-Control':'no-cache'}});assert.equal(fresh.r.status,200);assert.deepEqual(fresh.body,originRestored.body);
 await pause(1050);
 const again=await capture('repeat-edge-hit');assert.equal(again.r.status,404);assert.ok(Number(again.r.headers.get('age'))>=1,'stored age advances');assert.deepEqual(again.body,first.body);assert.equal(again.r.headers.get('x-sim-fault-ids'),hit.r.headers.get('x-sim-fault-ids'));
 const healthy=[];for(const entry of entries)if(entry.track!=='video:0'){for(const resource of ['init','media']){const r=await read(entry[resource]);assert.equal(r.r.status,200);healthy.push({track:entry.track,resource,sha256:r.sha256,bytes:r.body.length});}}
 assert.equal((await read(edge.url)).r.status,200);if(protocol==='dash')assert.equal((await read(new URL('/static/time.txt',edge.url),{method:'HEAD'})).r.status,200);
 await pause(ttlMs+100);const restored=await capture('after-expiry');assert.equal(restored.r.status,200);assert.deepEqual(restored.body,originRestored.body);
 const events=edge.diagnostics.snapshot().events;for(const result of responses.filter(r=>r.label.includes('hit'))){const event=events.find(e=>e.event==='edge.decision'&&e.cacheDecision==='hit'&&e.requestId===result.requestId);assert.ok(event);assert.equal(event.bodyIdentity,result.sha256);assert.ok(!events.some(e=>e.event==='origin.completed'&&e.requestId===result.requestId));}
 assert.equal(edge.scenario.report().cache.result,'passed');return{protocol,kind:'negative',passed:true,simulatorBehaviorVerified:true,browserRecoveryVerified:false,responses,healthy,originRestoration:{status:originRestored.r.status,sha256:originRestored.sha256},cache:edge.scenario.report().cache};
}
async function verifyRollback(session,protocol,afterMs=5000,beforeMs=6500,signal){
 const root=await read(session.url);assert.equal(root.r.status,200);
 const target=protocol==='hls'?new URL(variantEntries(root.body.toString())[0].uri,session.url):new URL(session.url),other=protocol==='hls'?new URL(variantEntries(root.body.toString())[1].uri,session.url):null;
 const first=protocol==='hls'?await read(target):root,firstPosition=require('../../dist/support-tools/scenario-cache.js').publicationPosition(first.body,protocol),observations=[];
 let newer;while(session.scenario.report().elapsedMs<afterMs-250){signal?.throwIfAborted();await pause(150);const next=await read(target);assert.equal(next.r.status,200);const position=require('../../dist/support-tools/scenario-cache.js').publicationPosition(next.body,protocol);if(require('../../dist/support-tools/scenario-cache.js').isNewerPublication(firstPosition,position,protocol)){newer=next;break;}}
 assert.ok(newer,'a completed newer publication must be read before stale window');assert.notEqual(newer.sha256,first.sha256);
 while(session.scenario.report().elapsedMs<afterMs+50){signal?.throwIfAborted();await pause(30);}
 const get=async(label,options)=>{const r=await read(target,options);observations.push({label,status:r.r.status,bytes:r.body.length,sha256:r.sha256,requestId:r.requestId,faultIds:r.r.headers.get('x-sim-fault-ids')});return r;};
 const stale=await get('stale');assert.equal(stale.r.status,200);assert.deepEqual(stale.body,first.body);assert.ok(stale.r.headers.get('x-sim-fault-ids'));
 const repeated=await get('repeated-stale');assert.deepEqual(repeated.body,first.body);assert.equal(repeated.r.headers.get('x-sim-fault-ids'),stale.r.headers.get('x-sim-fault-ids'));
 const conditional=await get('stale-revalidation',{headers:{'If-None-Match':stale.r.headers.get('etag'),'Cache-Control':'max-age=100'}});assert.equal(conditional.r.status,304);assert.equal(conditional.body.length,0);assert.equal(conditional.r.headers.get('content-length'),null);
 const head=await get('head-bypass',{method:'HEAD'});assert.equal(head.r.status,200);assert.equal(head.body.length,0);assert.equal(head.r.headers.get('x-sim-fault-ids'),null);
 const fresh=await get('no-cache-origin-control',{headers:{'Cache-Control':'no-cache'}});assert.equal(fresh.r.status,200);assert.notEqual(fresh.sha256,first.sha256);
 if(other){const child=await read(other);assert.equal(child.r.status,200);assert.equal(child.r.headers.get('x-sim-fault-ids'),null);const media=new URL(mediaSegments(child.body.toString()).at(-1).uri,other);assert.equal((await read(media)).r.status,200);}else{const entries=await catalog(fresh.body.toString(),session.url,protocol);for(const entry of entries){assert.equal((await read(entry.init)).r.status,200);assert.equal((await read(entry.media)).r.status,200);}assert.equal((await read(new URL('/static/time.txt',session.url),{method:'HEAD'})).r.status,200);}
 while(session.scenario.report().elapsedMs<beforeMs+50){signal?.throwIfAborted();await pause(30);}
 const restored=await get('restored');assert.equal(restored.r.status,200);assert.notEqual(restored.sha256,first.sha256);assert.equal(restored.r.headers.get('x-sim-fault-ids'),null);assert.equal(session.scenario.report().cache.result,'passed');
 const events=session.diagnostics.snapshot().events;for(const o of observations.filter(o=>o.label==='stale'||o.label==='repeated-stale')){assert.ok(events.some(e=>e.event==='edge.decision'&&e.cacheDecision==='hit'&&e.requestId===o.requestId&&e.bodyIdentity===o.sha256));assert.ok(!events.some(e=>e.event==='origin.completed'&&e.requestId===o.requestId));}
 return{protocol,kind:'manifest-rollback',passed:true,simulatorBehaviorVerified:true,browserRecoveryVerified:false,first:{sha256:first.sha256},newer:{sha256:newer.sha256},observations,cache:session.scenario.report().cache};
}
module.exports={verifyNegative,verifyRollback};
