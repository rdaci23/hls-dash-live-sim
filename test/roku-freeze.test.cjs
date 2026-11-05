const{test}=require('node:test'),assert=require('node:assert/strict'),{evaluate}=require('../scripts/roku/freeze-evidence.cjs');
// Synthetic source/native data for negative acceptance; not device evidence.
function fixture(){
 const epoch=1700000000000,records=[{event:'start',testerVersion:'1.1.0',protocol:'dash',schemaVersion:1,runId:'owned',atMs:0,receivedEpochMs:epoch}],report={protocol:'dash',kind:'long-manifest-freeze',runId:'owned',consoleErrors:[],cleanup:{network:{activeBodies:0,bufferedBytes:0,pendingGrants:0,pendingTimers:0},source:{lifecycleActions:0,serviceActions:0,sourceFiles:0,sourceTimelines:0,activeRequests:0,pendingWork:0}},http:{probes:[],advertised:[]}},events=[{event:'session.started',elapsedMs:0},{event:'scenario.started',elapsedMs:0,timestamp:new Date(epoch+2000).toISOString()},{event:'scenario.profile',elapsedMs:35000,phaseId:'phase:0',manifestFreeze:true},{event:'scenario.profile',elapsedMs:80000,phaseId:'phase:1',manifestFreeze:false}];
 for(let atMs=250;atMs<=185000;atMs+=250)records.push({schemaVersion:1,runId:'owned',event:'sample',atMs,receivedEpochMs:epoch+atMs,state:atMs>=40000&&atMs<82500?'buffering':'playing',epoch:0,videoPosition:atMs/1000,audioPosition:atMs/1000});records.push({schemaVersion:1,runId:'owned',event:'complete',atMs:185001,receivedEpochMs:epoch+185001});
 function request(label,track,resource,atMs,fault=false,hash='b'.repeat(64),method='GET'){
  const requestId='r'+events.length,requestResourceId=track+'/'+resource,bytes=method==='HEAD'?0:100,p={label,track,resource,atMs,requestId,requestResourceId,method,status:200,bytes,sha256:hash,faultIds:fault?'freeze':null};report.http.probes.push(p);report.http.advertised.push({track,resource,requestResourceId});events.push({event:'request.started',requestId,method,resourceId:requestResourceId,elapsedMs:atMs-1});if(fault)events.push({event:'fault.applied',requestId,method,trackId:track,targetKind:resource,fault:'manifest.freeze',faultId:'freeze',elapsedMs:atMs});events.push({event:'request.completed',requestId,method,trackId:track,targetKind:resource,status:200,bodyBytes:bytes,elapsedMs:atMs+1});
 }
 request('held-manifest','root','manifest',36000,true,'a'.repeat(64));request('held-manifest','root','manifest',38500,true,'a'.repeat(64));request('restored','root','manifest',80500);
 for(const track of ['video:0','video:1','audio:0','text:0'])request('restored',track,'media',80500);for(const track of ['video:0','video:1','audio:0'])request('restored',track,'init',80500);request('restored','root','utc',80500,false,'b'.repeat(64),'HEAD');events.push({event:'session.closed',elapsedMs:186000});
 return{report,records,diagnostics:{events,completeFile:{complete:true}}};
}
test('native freeze qualification separates HTTP proof and independent audio/video continuation',()=>{const r=evaluate(fixture());assert.equal(r.passed,true,r.failures.join('; '));assert.equal(r.simulatorBehaviorVerified,true);assert.equal(r.nativeRecoveryVerified,true);assert.equal(r.releaseQualified,false);});
test('native freezes cannot qualify lost telemetry, incomplete HTTP proof, stalled audio or cleanup leaks',()=>{
 for(const edit of [x=>x.records.pop(),x=>x.records[3].runId='different',x=>x.records.splice(100,5),x=>x.report.consoleErrors.push('runtime error'),x=>x.report.cleanup.network.activeBodies=1,x=>delete x.report.cleanup.source.pendingWork,x=>x.report.http.probes[1].sha256='c'.repeat(64),x=>x.report.http.probes.pop(),x=>x.diagnostics.completeFile.complete=false,x=>x.records.forEach(r=>{if(r.event==='sample'&&r.atMs>82000)r.audioPosition=82;})]){const x=fixture();edit(x);assert.equal(evaluate(x).passed,false,edit.toString());}
 const x=fixture();x.records.forEach(r=>{if(r.event==='sample'&&r.atMs>82000)r.audioPosition=82;});const r=evaluate(x);assert.equal(r.simulatorBehaviorVerified,true);assert.equal(r.nativeRecoveryVerified,false);
});
test('continuation without an observed freeze stall is not labeled recovery',()=>{const v=fixture();v.records.forEach(r=>{if(r.event==='sample')r.state='playing';});const r=evaluate(v);assert.equal(r.passed,true,r.failures.join('; '));assert.equal(r.nativeContinuationVerified,true);assert.equal(r.nativeRecoveryVerified,false);assert.equal(r.nativeOutcome,'continued-without-observed-stall');});
test('a track still stalled at the final sample is reported without inventing a resume',()=>{
 const x=fixture();x.records.forEach(r=>{if(r.event==='sample'){r.state=r.atMs<67000?'playing':'buffering';if(r.atMs>=67000){r.videoPosition=67;r.audioPosition=67;}}});
 const r=evaluate(x);assert.equal(r.simulatorBehaviorVerified,true);assert.equal(r.passed,false);assert.equal(r.nativeRecoveryVerified,false);
 for(const field of ['videoPosition','audioPosition']){const t=r.tracks[field];assert.equal(t.stallObserved,true);assert.equal(t.gaps.length,0);assert.equal(t.terminalStall.durationMs,118250);assert.equal(t.terminalStall.fromHostEpochMs,1700000066750);assert.equal(t.terminalStall.observedUntilHostEpochMs,1700000185000);assert.equal(t.resumedHostEpochMs,undefined);assert.equal(t.continuationMs,0);}
});
test('completion time cannot extend a terminal stall past the last native sample',()=>{
 const x=fixture();x.records.at(-1).atMs+=10000;x.records.at(-1).receivedEpochMs+=10000;
 const r=evaluate(x);for(const t of Object.values(r.tracks)){assert.equal(t.terminalStall,undefined);assert.equal(t.gaps.length,1);}
});
