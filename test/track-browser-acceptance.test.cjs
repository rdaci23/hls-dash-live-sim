const{test}=require('node:test'),assert=require('node:assert/strict');
const{languageEvidence,expectedCancellation}=require('../scripts/track-browser/acceptance.cjs');
function metrics(){return{protocol:'dash',contextState:'running',elapsedMs:1450,audio:Array.from({length:5},(_,i)=>({atMs:1000+i*100,mediaTime:8+i*0.1,contextTime:1+i*0.1,selected:'en',toneHz:440,rms:0.05})),captions:[{atMs:2000,mediaTime:8.8,selected:'en',tracks:[{language:'en',mode:'showing',loadedCues:1,cues:[{text:'EN cue 1',start:8.25,end:9.5}]}]},{atMs:3000,mediaTime:10.8,selected:'en',tracks:[{language:'en',mode:'showing',loadedCues:1,cues:[]}]}]};}
test('caption schedule uses independently advertised HLS source timing after a delayed live join',()=>{
 const m=metrics();m.protocol='hls';
 m.captions[0].mediaTime=6.8;m.captions[0].tracks[0].cues[0]={text:'EN cue 1',start:6.25,end:7.5};
 m.captions[1].mediaTime=8.8;
 for(const [i,c]of m.captions.entries())c.captionClock={source:'hls-main-fragment',sn:8+i,cc:0,duration:2,start:6+i*2,programDateTime:1793697080892+i*2000,sourceEpochMs:1793697064892,initPTS:{baseTime:900000,timescale:90000}};
 assert.equal(languageEvidence(m,0,'en').verified,true);
 assert.equal(languageEvidence(m,0,'en').captionClock.active.offsetSeconds,10);
 for(const edit of [x=>delete x.captions[0].captionClock,x=>x.captions[0].captionClock.sn++,x=>x.captions[0].captionClock.initPTS.baseTime=0,x=>x.captions[0].captionClock.programDateTime+=2000,x=>x.captions[0].tracks[0].cues[0].start+=2,x=>x.captions[0].tracks[0].cues[0].end+=2,x=>x.captions[0].tracks[0].cues[0].text='EN cue 4',x=>x.captions[1].tracks[0].cues=[{text:'EN cue 3',start:8.25,end:9.5}]]){const changed=structuredClone(m);edit(changed);assert.equal(languageEvidence(changed,0,'en').verified,false);}
});
test('decoded audio and captions need progressing tone windows, scheduled active cues and a loaded empty interval',()=>{
 assert.equal(languageEvidence(metrics(),0,'en').verified,true);
 for(const edit of [m=>m.contextState='suspended',m=>m.elapsedMs=3000,m=>m.audio.forEach(a=>a.contextTime=1),m=>m.captions[0].tracks[0].cues[0].end=100,m=>m.audio.forEach(a=>a.toneHz=880),m=>m.audio.forEach(a=>a.mediaTime=8),m=>m.audio.forEach(a=>a.rms=0),m=>m.captions[0].mediaTime=10.8,m=>m.captions[0].tracks[0].mode='hidden',m=>m.captions[0].tracks[0].cues[0].text='RO cue 1',m=>m.captions[1].tracks[0].loadedCues=0,m=>m.captions[1].tracks[0].language='ro']){const m=metrics();edit(m);assert.equal(languageEvidence(m,0,'en').verified,false);}
});
test('manual subtitle cancellation requires the explicit selection and player switch',()=>{
 const error={kind:'hls',atMs:1000,fatal:false,type:'networkError',details:'aborted',message:'Aborted',frag:{type:'subtitle'}},events=[{kind:'selection',atMs:990,text:'ro'},{kind:'subtitle-switch',atMs:991,id:1}];assert.equal(expectedCancellation(error,events),true);
 for(const edit of [e=>e.fatal=true,e=>e.frag.type='audio',e=>e.details='bufferStalledError',e=>e.atMs=1700,e=>e.kind='video']){const e=structuredClone(error);edit(e);assert.equal(expectedCancellation(e,events),false);}
 assert.equal(expectedCancellation(error,[events[0]]),false);assert.equal(expectedCancellation(error,[events[1]]),false);
});

test('pinned automatic same-track subtitle switches explain their exact nonfatal abort without a manual action',()=>{
 const error={kind:'hls',atMs:102071,fatal:false,type:'networkError',details:'aborted',message:'Aborted',frag:{type:'subtitle',level:0}},events=[{kind:'subtitle-switch',atMs:102071,id:0}];
 assert.equal(expectedCancellation(error,events),true);
 for(const event of [{kind:'subtitle-switch',atMs:102071,id:1},{kind:'subtitle-switch',atMs:101000,id:0},{kind:'selection',atMs:102071,text:'en'}])assert.equal(expectedCancellation(error,[event]),false);
 for(const edit of [e=>e.fatal=true,e=>e.frag.type='video',e=>e.details='fragLoadError',e=>e.message='connection closed',e=>delete e.frag.level]){const e=structuredClone(error);edit(e);assert.equal(expectedCancellation(e,events),false);}
});
