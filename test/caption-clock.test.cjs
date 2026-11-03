const{test}=require('node:test'),assert=require('node:assert/strict');
const{hlsClock,sourceClock}=require('../scripts/track-browser/caption-clock.js');
const epoch=1793697064892;
const fragment=(sn=8,cc=0,start=6)=>({type:'main',sn,cc,start,duration:2,programDateTime:epoch+sn*2000});
test('owned HLS clock independently correlates sequence/PDT with decoded initPTS',()=>{
 const frag=fragment(),pts={baseTime:900000,timescale:90000},clock=hlsClock(frag,pts,epoch);
 assert.equal(sourceClock({mediaTime:6.8,captionClock:clock},'hls').sourceTime,16.8);
 frag.sn=90;pts.baseTime=0;
 assert.equal(sourceClock({mediaTime:6.8,captionClock:clock},'hls').sourceTime,16.8,'captured samples do not change when player fragment objects change');
 for(const invalid of [{...fragment(),sn:9},{...fragment(),cc:-1},{...fragment(),duration:3},{...fragment(),programDateTime:epoch+18000},{...fragment(),type:'subtitle'}])assert.equal(hlsClock(invalid,{baseTime:900000,timescale:90000},epoch),undefined);
 for(const invalid of [undefined,{baseTime:0,timescale:90000},{baseTime:900000,timescale:0}])assert.equal(hlsClock(fragment(),invalid,epoch),undefined);
 assert.equal(hlsClock(fragment(),{baseTime:900000,timescale:90000}),undefined,'missing advertised epoch cannot qualify');
 assert.equal(sourceClock({mediaTime:9,captionClock:clock},'hls'),undefined,'a stale playing-fragment clock cannot qualify a later interval');
 assert.equal(sourceClock({mediaTime:6.8},'hls'),undefined,'older incomplete evidence cannot acquire a guessed origin');
 assert.equal(sourceClock({mediaTime:6.8}),undefined,'unknown protocols cannot qualify using an assumed presentation clock');
});
test('per-continuity-counter clocks preserve absolute owned source schedule across encoder restarts',()=>{
 const before=hlsClock(fragment(8,0,6),{baseTime:900000,timescale:90000},epoch);
 const after=hlsClock(fragment(12,1,14),{baseTime:900000,timescale:90000},epoch);
 assert.equal(sourceClock({mediaTime:6.8,captionClock:before},'hls').sourceTime,16.8);
 assert.equal(sourceClock({mediaTime:14.8,captionClock:after},'hls').sourceTime,24.8);
 assert.equal(sourceClock({mediaTime:14.8,captionClock:before},'hls'),undefined);
 assert.deepEqual(sourceClock({mediaTime:16.8},'dash'),{sourceTime:16.8,offsetSeconds:0,source:'presentation-timeline'});
});
