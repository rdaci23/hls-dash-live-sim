const{test}=require('node:test'),assert=require('node:assert/strict');
const{create}=require('../scripts/track-browser/audio-probe.js');
function fixture(){
 const calls=[];let resolve,reject;
 const ready=new Promise((a,b)=>{resolve=a;reject=b;});
 const context={state:'suspended',destination:{},resume(){calls.push('resume');return ready;},createMediaElementSource(){calls.push('link:'+this.state);return{connect(){calls.push('source-connect');}};},createAnalyser(){return{connect(){}};},createGain(){return{gain:{value:1},connect(){}};}};
 const video={muted:true,play(){calls.push('play');return Promise.resolve();}};
 let creations=0;const probe=create(video,{createContext(){creations++;return context;}});
 return{calls,context,video,probe,creations:()=>creations,resolve(){context.state='running';resolve();},reject};
}
test('the actual audio probe leaves a playing video untouched until its suspended context activates',async()=>{
 const f=fixture(),work=f.probe.activate();assert.deepEqual(f.calls,['resume']);assert.equal(f.video.muted,true);assert.equal(f.probe.analyser,undefined);
 f.resolve();await work;assert.deepEqual(f.calls,['resume','link:running','source-connect','play']);assert.equal(f.video.muted,false);assert.equal(f.probe.analyser.fftSize,4096);assert.equal(f.probe.analyser.smoothingTimeConstant,0);
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
