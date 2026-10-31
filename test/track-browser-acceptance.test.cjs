const{test}=require('node:test'),assert=require('node:assert/strict');
const{languageEvidence,expectedCancellation}=require('../scripts/track-browser/acceptance.cjs');
function metrics(){return{contextState:'running',elapsedMs:1450,audio:Array.from({length:5},(_,i)=>({atMs:1000+i*100,mediaTime:8+i*0.1,contextTime:1+i*0.1,selected:'en',toneHz:440,rms:0.05})),captions:[{atMs:2000,mediaTime:8.8,selected:'en',tracks:[{language:'en',mode:'showing',loadedCues:1,cues:[{text:'EN cue 1',start:8.25,end:9.5}]}]},{atMs:3000,mediaTime:10.8,selected:'en',tracks:[{language:'en',mode:'showing',loadedCues:1,cues:[]}]}]};}
test('decoded audio and captions need progressing tone windows, scheduled active cues and a loaded empty interval',()=>{
 assert.equal(languageEvidence(metrics(),0,'en').verified,true);
 for(const edit of [m=>m.contextState='suspended',m=>m.elapsedMs=3000,m=>m.audio.forEach(a=>a.contextTime=1),m=>m.captions[0].tracks[0].cues[0].end=100,m=>m.audio.forEach(a=>a.toneHz=880),m=>m.audio.forEach(a=>a.mediaTime=8),m=>m.audio.forEach(a=>a.rms=0),m=>m.captions[0].mediaTime=10.8,m=>m.captions[0].tracks[0].mode='hidden',m=>m.captions[0].tracks[0].cues[0].text='RO cue 1',m=>m.captions[1].tracks[0].loadedCues=0,m=>m.captions[1].tracks[0].language='ro']){const m=metrics();edit(m);assert.equal(languageEvidence(m,0,'en').verified,false);}
});
test('only pinned nonfatal subtitle aborts correlated with an explicit selection and player switch are expected',()=>{
 const error={kind:'hls',atMs:1000,fatal:false,type:'networkError',details:'aborted',message:'Aborted',frag:{type:'subtitle'}},events=[{kind:'selection',atMs:990,text:'ro'},{kind:'subtitle-switch',atMs:991,id:1}];assert.equal(expectedCancellation(error,events),true);
 for(const edit of [e=>e.fatal=true,e=>e.frag.type='audio',e=>e.details='bufferStalledError',e=>e.atMs=1700,e=>e.kind='video']){const e=structuredClone(error);edit(e);assert.equal(expectedCancellation(e,events),false);}
 assert.equal(expectedCancellation(error,[events[0]]),false);assert.equal(expectedCancellation(error,[events[1]]),false);
});
