// Simulator HTTP/timing evidence, independently replayed. No player or device.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startLivesim2, DEFAULT_IMAGE } = require('../dist/support-tools/dash-sim-runner.js');
const { variantEntries } = require('../dist/support-tools/hls-playlist.js');
const { inspect } = require('./manifest-freeze/media.cjs');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function port() { const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p; }
const definition = {version:1,seed:42,rules:[],timeline:[
  {afterMs:0,beforeMs:6000,network:{bandwidthKbps:1000,jitterMs:100}},
  {afterMs:6000,beforeMs:12000,network:{bandwidthKbps:500,jitterMs:80},manifestFreeze:true},
  {afterMs:12000,beforeMs:18000,network:{bandwidthKbps:1000,jitterMs:100}}
]};
async function attempt(protocol, directory) {
  await fs.mkdir(directory,{mode:0o700});
  const scenarioFile=path.join(directory,'scenario.json'),faultConfigPath=path.join(directory,'faults.json'),diagnosticsFile=path.join(directory,'requests.jsonl');
  await fs.writeFile(scenarioFile,JSON.stringify(definition,null,2),{mode:0o600,flag:'wx'});
  await fs.writeFile(faultConfigPath,'{}',{mode:0o600,flag:'wx'});
  const abort=new AbortController(), stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  let session, result, error;
  const requests=[],controls=[],references=[];
  async function get(uri,label,options={}) {
    const began=performance.now();const response=await fetch(uri,{...options,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(5000)])});
    const body=Buffer.from(await response.arrayBuffer());
    const row={label,status:response.status,method:options.method||'GET',durationMs:performance.now()-began,bytes:body.length,
      length:Number(response.headers.get('content-length')),range:response.headers.get('content-range'),requestId:response.headers.get('x-sim-request-id'),faultIds:response.headers.get('x-sim-fault-ids'),sha256:hash(body)};
    if(row.method==='GET')assert.equal(row.length,row.bytes,'response Content-Length must match bytes');
    requests.push(row);return {body,text:body.toString('utf8'),row,response};
  }
  async function phase(index, offset=0) {
    for(let n=0;n<1000;n++) {
      const report=await(await fetch(new URL('/scenario',session.url),{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(1000)])})).json();
      if(report.elapsedMs>=definition.timeline[index].afterMs+offset && report.elapsedMs<definition.timeline[index].beforeMs-300) {
        assert.equal(report.profile.phaseId,'phase:'+index);controls.push({phaseId:report.profile.phaseId,elapsedMs:report.elapsedMs});return report;
      }
      if(report.elapsedMs>=definition.timeline[index].beforeMs-300)throw Error('Missed timeline phase '+index);
      await delay(20,undefined,{signal:abort.signal});
    }throw Error('Timed out waiting for phase');
  }
  async function manifest(uri,label) { const value=await get(uri,label);assert.equal(value.row.status,200);return {...value,info:inspect(protocol,value.text,uri)}; }
  async function shapedMedia(manifest,label) {
    for(const media of [...manifest.info.media,...(manifest.info.initializations ?? [])]) {
      const row=await get(media.url,label+'-'+media.track,{headers:{Range:'bytes=0-11999'}});
      assert.ok([200,206].includes(row.row.status));assert.ok(row.row.bytes>100);assert.ok(row.row.faultIds);
      references.push({uri:media.url,status:row.row.status,sha256:row.row.sha256,range:row.row.range});
      // Server range behavior is inherited: HLS returns 206, livesim2 may return 200.
      if(protocol==='hls'){assert.equal(row.row.status,206);assert.equal(row.row.bytes,12000);}
      const head=await get(media.url,label+'-'+media.track+'-head',{method:'HEAD'});
      assert.equal(head.row.status,200);assert.equal(head.row.bytes,0);assert.equal(head.row.faultIds,null);
    }
  }
  try {
    const options={port:await port(),faultConfigPath,scenarioFile,diagnosticsFile,signal:abort.signal};
    session=await(protocol==='hls'?startHlsim({...options,rendition:'all'}):startLivesim2({...options,noPull:true}));
    let url=new URL(session.url);
    if(protocol==='hls') {const master=await get(url,'master');url=new URL(variantEntries(master.text)[0].uri,url);}
    await phase(0);
    const warm=await manifest(url,'warm');await shapedMedia(warm,'baseline');
    // At 4.2s both protocols have published at least one new two-second segment.
    await phase(0,4200);const advanced=await manifest(url,'healthy-advanced');assert.ok(BigInt(advanced.info.edge)>BigInt(warm.info.edge));
    await phase(1,100);const frozen=await manifest(url,'frozen-first');assert.deepEqual(frozen.body,advanced.body);
    await shapedMedia(frozen,'restricted');
    await phase(1,3200);const held=await manifest(url,'frozen-held');assert.deepEqual(held.body,frozen.body);
    if(protocol==='dash'){
      const utc=await get(new URL('/static/time.txt',session.url),'utc',{method:'HEAD'});assert.equal(utc.row.status,200);assert.equal(utc.row.faultIds,null);assert.ok(Math.abs(Date.now()-Date.parse(utc.response.headers.get('date')))<2500);
    }
    await phase(2,100);const resumed=await manifest(url,'resumed');assert.ok(BigInt(resumed.info.edge)>BigInt(frozen.info.edge));await shapedMedia(resumed,'restored');
    await phase(2,4200);const continued=await manifest(url,'continued');assert.ok(BigInt(continued.info.edge)>BigInt(resumed.info.edge));
    let report;
    do {await delay(30,undefined,{signal:abort.signal});report=await(await fetch(new URL('/scenario',session.url),{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(1000)])})).json();}while(report.elapsedMs<18010);
    assert.deepEqual(report.profile,{bandwidthKbps:0,jitterMs:0,manifestFreeze:false});assert.equal(report.result,'passed',JSON.stringify(report.timeline));
    const normal=await manifest(url,'after-end');assert.equal(normal.row.faultIds,null);
    for(const reference of references){const unshaped=await get(reference.uri,'byte-reference',{headers:{Range:'bytes=0-11999'}});assert.equal(unshaped.row.faultIds,null);assert.equal(unshaped.row.status,reference.status);assert.equal(unshaped.row.range,reference.range);assert.equal(unshaped.row.sha256,reference.sha256,'shaping must preserve exact media/init bytes');}
    await session.close();session=undefined;
    const events=(await fs.readFile(diagnosticsFile,'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(!events.some(e=>['diagnostics.file_error','diagnostics.file_limit'].includes(e.event)));
    const applied=events.filter(e=>e.event==='fault.applied');
    for(const row of requests.filter(r=>r.faultIds)){
      const effects=applied.filter(e=>e.requestId===row.requestId);assert.ok(effects.length);
      assert.ok(effects.every(e=>row.faultIds.split(/,\s*/).includes(e.faultId)&&e.scenarioId===report.scenarioId&&e.phaseId));
      assert.ok(events.some(e=>e.event==='request.completed'&&e.requestId===row.requestId&&e.status===row.status&&e.bodyBytes===row.bytes));
      if(row.method==='GET'&&row.label.includes('restricted-')&&!row.label.endsWith('-head')){
        assert.ok(effects.some(e=>e.fault==='response.bandwidth'&&e.bandwidthKbps===500));
        const effect=effects.find(e=>e.fault==='response.jitter');assert.ok(effect&&effect.delayMs<=80);
        assert.ok(row.durationMs>=row.bytes/(500*125)*1000+effect.delayMs-100,'restricted body was not paced');
      }
    }
    const holds=applied.filter(e=>e.fault==='manifest.freeze'&&e.action==='hold_manifest');assert.equal(holds.length,2);
    for(const row of requests.filter(r=>['warm','healthy-advanced','resumed','continued','after-end'].includes(r.label))) assert.ok(!holds.some(e=>e.requestId===row.requestId));
    // One response per labelled request; metadata and HEAD never enter jitter lanes.
    const jitter=requests.flatMap(row=>applied.filter(e=>e.requestId===row.requestId&&e.fault==='response.jitter').map(e=>({label:row.label,phaseId:e.phaseId,delayMs:e.delayMs})));
    assert.ok(jitter.length>4);assert.ok(jitter.every(e=>!e.label.endsWith('-head')));
    result={passed:true,protocol,scenarioId:report.scenarioId,timeline:report.timeline,controls,requests,jitter};
  } catch(e) {error=String(e.message);result={passed:false,protocol,error,controls,requests,scenario:session?.scenario?.report()};}
  finally {if(session)await session.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(result,null,2)+'\n');
  if(error)throw Error(error);return result;
}
async function worker(protocol,directory) {
  await fs.mkdir(directory,{mode:0o700});const first=await attempt(protocol,path.join(directory,'first')),replay=await attempt(protocol,path.join(directory,'replay'));
  assert.equal(first.scenarioId,replay.scenarioId);assert.deepEqual(first.jitter,replay.jitter,'seeded jitter decisions did not replay');
  await fs.writeFile(path.join(directory,'report.json'),JSON.stringify({passed:true,protocol,replayVerified:true,scenarioId:first.scenarioId,jitter:first.jitter},null,2)+'\n');
  console.log(protocol+': timeline, byte preservation, rate restoration, freeze/resume and seeded replay PASS');
}
async function main() {
  if(args.includes('--worker'))return worker(option('--worker'),path.resolve(option('--output')));
  if(args.some((arg,i)=>i%2===0&&!['--output','--protocol'].includes(arg))||args.length%2)throw Error('Use --protocol hls|dash or --output NEW_DIRECTORY');
  const protocol=option('--protocol','both');if(!['hls','dash','both'].includes(protocol))throw Error('Unknown protocol');
  const directory=path.resolve(option('--output','output/network-scenarios-'+Date.now()));await fs.mkdir(path.dirname(directory),{recursive:true});await fs.mkdir(directory,{mode:0o700});
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim(),workingTreeModified=!!execFileSync('git',['status','--porcelain'],{cwd:root}).toString().trim();
  const protocols=protocol==='both'?['hls','dash']:[protocol],children=[];
  const stop=()=>children.forEach(c=>c.kill('SIGTERM'));process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const results=await Promise.all(protocols.map(p=>new Promise(resolve=>{const c=spawn(process.execPath,[__filename,'--worker',p,'--output',path.join(directory,p)],{cwd:root,stdio:'inherit'});children.push(c);c.once('error',()=>resolve({protocol:p,passed:false}));c.once('exit',code=>resolve({protocol:p,passed:code===0}));})));
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  const passed=results.every(r=>r.passed);await fs.writeFile(path.join(directory,'report.json'),JSON.stringify({schemaVersion:1,commit,workingTreeModified,recordedAt:new Date().toISOString(),passed,bothProtocolsVerified:passed&&protocols.length===2,releaseReady:false,engineImage:DEFAULT_IMAGE,results},null,2)+'\n');
  console.log('Evidence: '+path.join(directory,'report.json'));if(!passed)process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
