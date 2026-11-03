const {test}=require('node:test'),assert=require('node:assert/strict');
const config=require('../dist/support-tools/live-stream-fault-config.js');
const {FaultRuntime}=require('../dist/support-tools/fault-runtime.js');
const {ManifestSnapshots}=require('../dist/support-tools/manifest-snapshots.js');
const {SessionFaultConfigSource,createDefaultFaultConfig}=config;

test('private sources isolate same-process runtimes and preserve consumed one-shots until explicit rearm',t=>{
 const original=config.getFaultConfig(),input={segment:{missing:'once',latencyMs:3},network:{bandwidthKbps:80,jitterMs:7},logging:{verbose:true}};
 const a=new SessionFaultConfigSource(input),b=new SessionFaultConfigSource({});
 const ar=new FaultRuntime(()=>0,undefined,a),br=new FaultRuntime(()=>0,undefined,b);
 t.after(()=>{ar.close();br.close();a.close();b.close();});
 input.segment.missing='off';const detached=a.get();detached.network.bandwidthKbps=999;
 assert.equal(a.isolated,true);assert.equal(a.isVerbose(),true);assert.equal(a.hasManualConflict(),true);
 assert.deepEqual(ar.snapshot(),{rules:[{fault:'segment.missing',mode:'once',state:'armed'}],latencyMs:3,jitterMs:7,bandwidthKbps:80,manifestFreeze:false});
 assert.equal(ar.segmentStatus('video'),404);assert.equal(ar.segmentStatus('video'),0);assert.equal(br.segmentStatus('video'),0);
 a.update({network:{bandwidthKbps:160},logging:{verbose:false}});
 assert.equal(ar.snapshot().bandwidthKbps,160);assert.equal(br.snapshot().bandwidthKbps,0);assert.equal(a.isVerbose(),false);
 assert.equal(ar.segmentStatus('video'),0,'unrelated changes preserve consumed state');
 a.update({segment:{missing:'once'}});assert.equal(ar.segmentStatus('video'),0,'identical mode is not a new arm');
 a.update({segment:{missing:'once'}},{rearmOnce:true});assert.equal(ar.snapshot().rules[0].state,'armed');assert.equal(ar.segmentStatus('video'),404);
 assert.deepEqual(config.getFaultConfig(),original,'private changes never update global configuration');
 a.reset();assert.deepEqual(a.get(),createDefaultFaultConfig());assert.equal(a.hasManualConflict(),false);assert.equal(ar.snapshot().rules.length,0);
});

test('ordinary sources follow legacy settings until an explicit valid mutation and legacy fallback stays live',t=>{
 const original=config.getFaultConfig();config.applyConfigOverride(createDefaultFaultConfig());
 const a=new SessionFaultConfigSource(),b=new SessionFaultConfigSource(),legacy=new FaultRuntime(),ar=new FaultRuntime(()=>0,undefined,a),br=new FaultRuntime(()=>0,undefined,b);
 t.after(()=>{ar.close();br.close();legacy.close();a.close();b.close();config.applyConfigOverride(original);});
 assert.equal(a.isolated,false);a.get();a.isVerbose();a.hasManualConflict();ar.snapshot();assert.equal(a.isolated,false,'observations never take control');
 assert.throws(()=>a.update({network:{bandwidthKbps:-1}}),/between/);assert.equal(a.isolated,false,'rejected writes never take control');
 config.applyConfigOverride({segment:{missing:'once'}});
 assert.equal(ar.segmentStatus('a'),404);assert.equal(br.segmentStatus('b'),404);assert.equal(legacy.segmentStatus('legacy'),404);
 a.isolate();assert.equal(a.isolated,true);assert.equal(ar.segmentStatus('a'),0,'taking a snapshot alone does not rearm');
 config.applyConfigOverride({segment:{missing:'off'},network:{bandwidthKbps:300}});
 assert.equal(ar.snapshot().bandwidthKbps,0);assert.equal(br.snapshot().bandwidthKbps,300);assert.equal(legacy.snapshot().bandwidthKbps,300);
 config.applyConfigOverride({segment:{missing:'once'}});
 assert.equal(ar.segmentStatus('a'),0);assert.equal(br.segmentStatus('b'),404);assert.equal(legacy.segmentStatus('legacy'),404);
 b.update({network:{bandwidthKbps:500}});assert.equal(b.isolated,true);assert.equal(config.getFaultConfig().network.bandwidthKbps,300);
});

test('freeze snapshots subscribe to the chosen source and do not freeze sibling sessions',t=>{
 const a=new SessionFaultConfigSource({}),b=new SessionFaultConfigSource({}),first=new ManifestSnapshots(2,true,a),second=new ManifestSnapshots(2,true,b),disabled=new ManifestSnapshots(2,false,a);
 t.after(()=>{first.close();second.close();disabled.close();a.close();b.close();});
 first.observe('video','a1');second.observe('video','b1');disabled.observe('video','free');
 a.update({manifest:{freeze:'always'}});
 assert.equal(first.held('video'),'a1');assert.equal(second.held('video'),undefined);assert.equal(disabled.held('video'),undefined);
 assert.deepEqual(first.observe('video','a2'),{value:'a1',action:'hold'});assert.deepEqual(second.observe('video','b2'),{value:'b2'});
 a.update({manifest:{freeze:'off'}});assert.equal(first.held('video'),undefined);first.observe('video','a3');
 a.update({manifest:{freeze:'always'}});assert.equal(first.held('video'),'a3');
});

test('source subscribers get independent snapshots and parent subscriptions drain on isolation or close',()=>{
 let current=createDefaultFaultConfig();const upstream=new Set(),parent={get:()=>structuredClone(current),subscribe:listener=>{upstream.add(listener);return()=>upstream.delete(listener);},isVerbose:()=>!!current.logging.verbose,hasManualConflict:()=>config.faultConfigHasManualConflict(current)};
 const source=new SessionFaultConfigSource(undefined,parent),closed=new SessionFaultConfigSource(undefined,parent);
 assert.equal(upstream.size,2);let notices=0;
 const off=source.subscribe(next=>{notices++;next.segment.missing='off';next.network.bandwidthKbps=999;});
 source.subscribe(next=>{assert.equal(next.network.bandwidthKbps,200);assert.equal(source.hasManualConflict(),true);});
 current.network.bandwidthKbps=200;for(const listener of upstream)listener(structuredClone(current));
 assert.equal(source.get().network.bandwidthKbps,200);assert.equal(notices,1);
 source.isolate();assert.equal(upstream.size,1);source.isolate();assert.equal(upstream.size,1);
 off();closed.close();assert.equal(upstream.size,0);source.close();source.close();
 assert.throws(()=>source.update({network:{jitterMs:1}}),/closed/);assert.throws(()=>source.subscribe(()=>{}),/closed/);
});

test('retired runtimes cannot select faults, delay, corrupt or shape a late healthy response',{timeout:1000},async t=>{
 const source=new SessionFaultConfigSource({segment:{missing:'always',malformed:'always',latencyMs:60000},network:{bandwidthKbps:1,jitterMs:60000},manifest:{freeze:'always'}}),runtime=new FaultRuntime(()=>0,undefined,source);
 const controller=new AbortController();t.after(()=>{controller.abort();runtime.close();source.close();});runtime.close();
 const trace={select(){throw Error('Retired runtime selected a fault');}},body=Buffer.from('healthy-media'),signal=controller.signal;
 assert.equal(runtime.segmentStatus('late',trace),0);assert.equal(runtime.corrupt(body,'late',false,trace),body);runtime.frozen(trace);
 await runtime.delay(signal,trace);
 let status,headers,result;const response={writeHead(code,value){status=code;headers=value;},end(value){result=value;}};
 await runtime.sendMedia(response,200,body,{},'GET',signal,trace);
 assert.equal(status,200);assert.equal(headers['Content-Length'],String(body.length));assert.equal(result,body);
 assert.equal(await runtime.transportGrant(trace)(body.length,signal),body.length);
 assert.deepEqual(runtime.ownership(),{activeBodies:0,bufferedBytes:0,pendingGrants:0,pendingTimers:0});
});

test('a delay selected before retirement cannot apply a late effect after close',async t=>{
 const source=new SessionFaultConfigSource({segment:{latencyMs:10}}),runtime=new FaultRuntime(()=>0,undefined,source);let applied=0;
 t.after(()=>{runtime.close();source.close();});
 const pending=runtime.delay(new AbortController().signal,{select(){return{apply(){applied++;}};}});runtime.close();await pending;
 assert.equal(applied,0);
});

test('retired snapshot stores pass through late origin results without recreating freeze state',()=>{
 const source=new SessionFaultConfigSource({manifest:{freeze:'always'}}),cache=new ManifestSnapshots(1,true,source);
 cache.observe('video','before');cache.close();source.update({manifest:{freeze:'off'}});source.update({manifest:{freeze:'always'}});
 assert.equal(cache.held('video'),undefined);assert.deepEqual(cache.observe('video','after'),{value:'after'});
 cache.setFrozen(true);assert.equal(cache.held('video'),undefined);assert.deepEqual(cache.observe('other','healthy'),{value:'healthy'});
 source.close();cache.close();
});
