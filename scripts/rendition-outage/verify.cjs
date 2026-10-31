const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { read } = require('../transport-scenarios/verify.cjs');
const { catalog } = require('../resource-scenarios/verify.cjs');
const { variantEntries, mediaSegments } = require('../../dist/support-tools/hls-playlist.js');
const { fragment, initialization } = require('../dash-abr/fixture.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function definition(protocol, track, presetTiming = false) {
  const name = `${protocol}-${track === 'video:1' ? 'high' : 'low'}-rendition-outage`;
  // The older DASH high preset has a longer observation window for its player probe.
  const data = structuredClone(require('../../examples/scenarios/' + name + '.json'));
  if (!presetTiming) Object.assign(data.rules[0], { afterMs: 5000, beforeMs: 15000 });
  return data;
}
function accept(evidence, events) {
  assert.deepEqual(evidence.samples.map(s => s.phase), ['baseline','outage','outage','outage','restored','restored']);
  const { afterMs, beforeMs } = evidence.window;
  const faults = evidence.requests.filter(r => r.expectedStatus === 503), applied = events.filter(e => e.event === 'fault.applied');
  assert.equal(faults.length, 12); assert.equal(applied.length, 12);
  assert.ok(!events.some(e => ['request.cancelled','request.aborted','request.error','diagnostics.file_error','diagnostics.file_limit'].includes(e.event)));
  for (const sample of evidence.samples) {
    assert.ok(sample.phase === 'baseline' ? sample.endMs < afterMs : sample.phase === 'outage' ? sample.startMs >= afterMs && sample.endMs < beforeMs : sample.startMs >= beforeMs);
    const rows = evidence.requests.filter(r => r.startMs >= sample.startMs && r.endMs <= sample.endMs);
    assert.ok(rows.some(r => r.kind === 'manifest' && r.method === 'GET' && r.status === 200));
    assert.ok(rows.some(r => r.track === evidence.target && r.method === 'HEAD' && r.status === 200));
    const alternate = evidence.target === 'video:1' ? 'video:0' : 'video:1';
    assert.ok(rows.some(r => r.track === alternate && r.kind === 'media' && r.method === 'GET' && r.status === 200 && r.bodyBytes > 100));
    if (evidence.protocol === 'dash') {
      assert.equal(rows.filter(r => r.kind === 'init' && r.status === 200).length, 3);
      assert.ok(rows.some(r => r.track === 'audio:0' && r.kind === 'media' && r.status === 200));
      assert.ok(rows.some(r => r.kind === 'utc' && r.status === 200 && r.clockSkewMs >= 0 && r.clockSkewMs < 2500));
    } else assert.equal(rows.filter(r => r.kind === 'manifest' && r.status === 200).length, 3);
  }
  for (const row of evidence.requests) {
    const done = events.find(e => e.requestId === row.requestId && e.event === 'request.completed');
    assert.ok(done); assert.equal(done.status, row.status); assert.equal(done.bodyBytes, row.bodyBytes);
    const effects = applied.filter(e => e.requestId === row.requestId);
    if (row.expectedStatus === 503) {
      assert.equal(row.status,503); assert.equal(row.track,evidence.target); assert.equal(row.kind,'media');
      assert.ok(row.startMs >= afterMs && row.endMs < beforeMs); assert.equal(effects.length,1);
      assert.equal(effects[0].fault,'scenario.status');assert.equal(effects[0].trackId,evidence.target); assert.equal(effects[0].faultId,row.faultIds); assert.equal(effects[0].targetKind,'media');
    } else { assert.ok([200,206].includes(row.status)); assert.equal(effects.length,0); assert.equal(row.faultIds,undefined); }
  }
  const held = evidence.samples.filter(s => s.phase === 'outage');
  for (const track of ['video:0','video:1']) assert.ok(BigInt(held.at(-1).positions[track]) > BigInt(held[0].positions[track]), 'publication must advance within outage');
  const resumed = evidence.samples.filter(s => s.phase === 'restored');
  assert.ok(BigInt(resumed[1].positions[evidence.target]) > BigInt(resumed[0].positions[evidence.target]));
  assert.ok(evidence.restorations.length >= 4);
  for (const link of evidence.restorations) {
    const failed = faults.find(r => r.requestId === link.failedRequestId), restored = evidence.requests.find(r => r.requestId === link.requestId);
    assert.ok(failed && restored && restored.startMs >= beforeMs && restored.bodyBytes > 0 && [200,206].includes(restored.status));
    assert.equal(restored.range,failed.range);
    const a = events.find(e => e.event === 'scenario.attempt' && e.requestId === failed.requestId), b = events.find(e => e.event === 'scenario.attempt' && e.requestId === restored.requestId);
    assert.ok(a && b && a.segmentId === b.segmentId && a.trackId === b.trackId && b.attempt > a.attempt);
  }
  assert.equal(evidence.scenario.result,'passed'); assert.equal(evidence.scenario.rules[0].selected,12); assert.equal(evidence.scenario.rules[0].applied,12);
}
async function verify(session, protocol, target, { signal, evidence = {}, onPhase = () => {} } = {}) {
  const { afterMs, beforeMs } = session.scenario.definition.rules[0];
  Object.assign(evidence,{ protocol,target,window:{afterMs,beforeMs},scope:'Simulator HTTP rendition isolation/restoration; player fallback and re-entry unverified',samples:[],requests:[],restorations:[],passed:false });
  const elapsed=()=>session.scenario.report().elapsedMs, wait=async t=>{for(;;){const remaining=t-elapsed();if(remaining<=0)break;await delay(Math.max(1,Math.min(250,remaining)),undefined,{signal});}signal?.throwIfAborted();};
  const failures=new Map(), inits=new Map(); let baseline;
  const get=async(url,label,{track,kind='media',method='GET',range,failure=false}={})=>{
    const startMs=elapsed(),r=await read(url,{method,range,signal}),endMs=elapsed();
    const row={label,track,kind,method,range,startMs,endMs,expectedStatus:failure?503:200,status:r.status,bodyBytes:r.bytes.length,sha256:hash(r.bytes),requestId:r.headers['x-sim-request-id'],faultIds:r.headers['x-sim-fault-ids'],contentRange:r.headers['content-range']};
    evidence.requests.push(row);assert.ok(r.complete);assert.ok(failure?r.status===503:range?[200,206].includes(r.status):r.status===200,label);
    assert.equal(r.bytes.length,method==='HEAD'?0:Number(r.headers['content-length']));
    if(failure){assert.ok(startMs>=afterMs&&endMs<beforeMs);const key=url.href+':'+(range||'full');if(!failures.has(key))failures.set(key,{url,range,row});}
    else assert.equal(row.faultIds,undefined);
    return {...r,row};
  };
  const sample=async phase=>{
    onPhase(phase);const startMs=elapsed(),root=await get(new URL(session.url),phase+'-root',{kind:'manifest'});let entries;
    if(protocol==='hls'){
      const variants=variantEntries(root.bytes.toString());assert.equal(variants.length,2);entries=[];
      for(const [n,v]of variants.entries()){
        const child=new URL(v.uri,session.url),playlist=await get(child,phase+'-playlist-'+n,{kind:'manifest',track:'video:'+n});
        const segment=mediaSegments(playlist.bytes.toString()).at(-1);assert.ok(segment);
        entries.push({track:'video:'+n,media:new URL(segment.uri,child),position:/segment-(\d+)\.ts/.exec(segment.uri)[1]});
      }
    }else{
      assert.match(root.bytes.toString(),/urn:mpeg:dash:utc:http-head:2014/);assert.match(root.bytes.toString(),/value="\/static\/time.txt"/);
      entries=await catalog(root.bytes.toString(),session.url,'dash');assert.deepEqual(entries.map(e=>e.track).sort(),['audio:0','video:0','video:1']);
      for(const entry of entries){const init=await get(entry.init,phase+'-init-'+entry.track,{track:entry.track,kind:'init'});initialization(init.bytes);const prior=inits.get(entry.track);if(prior)assert.equal(prior,init.row.sha256);else inits.set(entry.track,init.row.sha256);}
    }
    const positions={}, chosen=entries.find(e=>e.track===target);assert.ok(chosen);
    for(const entry of entries){
      if(entry.track===target&&phase==='outage')positions[entry.track]=entry.position||String(evidence.samples.length);
      else{
        const media=await get(entry.media,phase+'-'+entry.track,{track:entry.track});assert.ok(media.bytes.length>100);
        if(protocol==='hls'){assert.equal(media.bytes[0],0x47);positions[entry.track]=entry.position;}
        else positions[entry.track]=String(fragment(media.bytes).baseTime);
      }
    }
    // During a DASH outage the advertised locator, not a failed response body,
    // establishes that the targeted track continues publishing.
    if(protocol==='dash'&&phase==='outage'){
      const match=/(?:-|\/)(\d+)\.m4s$/.exec(chosen.media.pathname);assert.ok(match);positions[target]=match[1];
    }
    await get(chosen.media,phase+'-target-head',{track:target,method:'HEAD'});
    if(phase==='outage'){
      await get(chosen.media,phase+'-target-current',{track:target,failure:true});
      const query=new URL(chosen.media);query.searchParams.set('cb','retry');await get(query,phase+'-target-repeat',{track:target,failure:true});
      await get(baseline.url,phase+'-target-historical',{track:target,failure:true});
      await get(chosen.media,phase+'-target-range',{track:target,range:'bytes=0-99',failure:true});
    }else if(!baseline)baseline={url:chosen.media,sha256:evidence.requests.findLast(r=>r.track===target&&r.method==='GET'&&r.kind==='media').sha256};
    if(protocol==='dash'){
      const utc=await get(new URL('/static/time.txt',session.url),phase+'-utc',{kind:'utc',method:'HEAD'});utc.row.clockSkewMs=Math.abs(Date.parse(utc.headers.date)-Date.now());assert.ok(utc.row.clockSkewMs<2500);
    }
    await get(new URL('/health',session.url),phase+'-health',{kind:'health'});
    evidence.samples.push({phase,startMs,endMs:elapsed(),positions});
  };
  await wait(Math.max(0,afterMs-2000));await sample('baseline');assert.ok(elapsed()<afterMs);
  for(const t of [afterMs+300,(afterMs+beforeMs)/2,beforeMs-1000]){await wait(t);await sample('outage');}
  await wait(beforeMs+300);await sample('restored');
  for(const{url,range,row}of failures.values()){
    const restored=await get(url,'same-download-restored',{track:target,range});
    if(url.href===baseline.url.href&&!range)assert.equal(restored.row.sha256,baseline.sha256);
    if(range&&restored.status===206){assert.equal(restored.bytes.length,100);assert.match(restored.row.contentRange,/^bytes 0-99\//);}
    evidence.restorations.push({failedRequestId:row.requestId,requestId:restored.row.requestId,rangeHonored:range?restored.status===206:undefined});
  }
  await wait(beforeMs+2800);await sample('restored');evidence.scenario=session.scenario.report();accept(evidence,session.diagnostics.snapshot().events);evidence.passed=true;return evidence;
}
module.exports={definition,verify,accept};
