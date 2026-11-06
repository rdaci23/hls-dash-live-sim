const{test}=require('node:test'),assert=require('node:assert/strict');
const{create,waitForProcessing}=require('../scripts/track-browser/audio-probe.js');
function fixture(){
 const calls=[];let resolve,reject;
 const ready=new Promise((a,b)=>{resolve=a;reject=b;});
 let time=0;const context={state:'suspended',get currentTime(){return time+=.003;},destination:{},resume(){calls.push('resume');return ready;},createMediaElementSource(){calls.push('link:'+this.state);return{connect(){calls.push('source-connect');}};},createAnalyser(){return{connect(){}};},createGain(){return{gain:{value:1},connect(){}};},createConstantSource(){return{offset:{value:1},connect(){},start(){},stop(){},disconnect(){}};}};
 const video={muted:true,play(){calls.push('play');return Promise.resolve();}};
 let creations=0;const probe=create(video,{createContext(){creations++;return context;}});
 return{calls,context,video,probe,creations:()=>creations,resolve(){context.state='running';resolve();},reject};
}
test('the actual audio probe leaves a playing video untouched until its suspended context activates',async()=>{
 const f=fixture(),work=f.probe.activate();assert.deepEqual(f.calls,['resume']);assert.equal(f.video.muted,true);assert.equal(f.probe.analyser,undefined);
 f.resolve();await work;assert.deepEqual(f.calls,['resume','link:running','source-connect','play']);assert.equal(f.video.muted,false);assert.equal(f.probe.analyser.fftSize,4096);assert.equal(f.probe.analyser.smoothingTimeConstant,0);
});
test('resolved running state cannot route video until the native processing clock advances',async()=>{
 const f=fixture();let clock=0;Object.defineProperty(f.context,'currentTime',{get:()=>clock});
 const work=f.probe.activate();f.resolve();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.probe.analyser,undefined,'A running state with a frozen clock is not processing readiness');assert.equal(f.video.muted,true);assert.deepEqual(f.calls,['resume']);
 clock=.003;await work;assert.equal(f.video.muted,false);assert.ok(f.probe.analyser);
});
test('concurrent and repeated clicks share the context and never route an element twice',async()=>{
 const f=fixture(),a=f.probe.activate(),b=f.probe.activate();assert.equal(a,b);f.resolve();await a;await f.probe.activate();assert.equal(f.creations(),1);assert.equal(f.calls.filter(c=>c.startsWith('link:')).length,1);assert.equal(f.calls.filter(c=>c==='play').length,2);
});
test('failed activation cannot attach, unmute or restart the video',async()=>{
 const f=fixture(),work=f.probe.activate();f.reject(Error('activation failed'));await assert.rejects(work,/activation failed/);assert.deepEqual(f.calls,['resume']);assert.equal(f.video.muted,true);assert.equal(f.probe.analyser,undefined);
});
test('a resolved resume promise without a running context still fails before routing',async()=>{
 const f=fixture();f.context.resume=async()=>{};
 await assert.rejects(f.probe.activate(),/did not activate/);assert.equal(f.video.muted,true);assert.equal(f.probe.analyser,undefined);assert.equal(f.calls.length,0);
});
test('processing readiness has a bounded lifetime and never accepts a frozen or invalid clock',async()=>{
 let time=0,clock=0;const context={state:'running',get currentTime(){return clock;}};
 await waitForProcessing(context,{now:()=>time,sleep:async ms=>{time+=ms;if(time>=1800)clock=.003;}});assert.equal(time,1800);
 time=0;clock=0;await assert.rejects(waitForProcessing(context,{now:()=>time,sleep:async ms=>{time+=ms;}}),/did not advance/);assert.equal(time,3000);
 for(const currentTime of [NaN,-1,Infinity])await assert.rejects(waitForProcessing({state:'running',currentTime}),/Invalid/);
 time=0;clock=1;await assert.rejects(waitForProcessing(context,{now:()=>time,sleep:async ms=>{time+=ms;clock=0;}}),/stopped before routing/);
});

test('an idle native processing graph is bootstrapped silently before readiness without routing video early',async()=>{
 const f=fixture();let active=false,time=0,stopped=0,disconnected=0;
 Object.defineProperty(f.context,'currentTime',{get(){return active?(time+=.003):0;}});
 f.context.createConstantSource=()=>{const source={offset:{value:1},connect(destination){assert.equal(destination,f.context.destination);f.calls.push('bootstrap-connect');},start(){assert.equal(source.offset.value,0,'Bootstrap must carry no tone');active=true;f.calls.push('bootstrap-start');},stop(){stopped++;active=false;},disconnect(){disconnected++;}};return source;};
 const work=f.probe.activate();assert.equal(f.video.muted,true);assert.equal(f.probe.analyser,undefined);f.resolve();await work;
 assert.equal(f.calls.indexOf('bootstrap-start')<f.calls.indexOf('link:running'),true);assert.equal(f.video.muted,false);assert.equal(stopped,1);assert.equal(disconnected,1);
 await f.probe.activate();assert.equal(stopped,1,'An existing analyser does not allocate another bootstrap');
});
test('failed native activation always stops and disconnects the probe-only bootstrap',async()=>{
 const f=fixture();let stopped=0,disconnected=0;
 f.context.createConstantSource=()=>({offset:{value:1},connect(){},start(){},stop(){stopped++;},disconnect(){disconnected++;}});
 const work=f.probe.activate();f.reject(Error('activation failed'));await assert.rejects(work,/activation failed/);
 assert.equal(stopped,1);assert.equal(disconnected,1);assert.equal(f.video.muted,true);assert.equal(f.probe.analyser,undefined);
});

test('bootstrap failures disconnect without stopping an unstarted source or changing video playback',async()=>{
 const f=fixture();let disconnected=0;
 f.context.createConstantSource=()=>({offset:{value:1},connect(){},start(){throw Error('bootstrap start failed');},stop(){assert.fail('Unstarted bootstrap cannot be stopped');},disconnect(){disconnected++;}});
 await assert.rejects(f.probe.activate(),/bootstrap start failed/);assert.equal(disconnected,1);assert.equal(f.video.muted,true);assert.equal(f.probe.analyser,undefined);assert.equal(f.calls.includes('play'),false);
});
test('a silent bootstrap cannot qualify a genuinely frozen clock and is closed at the unchanged deadline',async()=>{
 const f=fixture();let stopped=0,disconnected=0;Object.defineProperty(f.context,'currentTime',{get:()=>0});
 f.context.createConstantSource=()=>({offset:{value:1},connect(){},start(){},stop(){stopped++;},disconnect(){disconnected++;}});
 const work=f.probe.activate();f.resolve();await assert.rejects(work,/processing clock did not advance/);
 assert.equal(stopped,1);assert.equal(disconnected,1);assert.equal(f.video.muted,true);assert.equal(f.probe.analyser,undefined);assert.equal(f.calls.includes('play'),false);
});
