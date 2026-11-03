(function(root,factory){
 'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.OwnedCaptionClock=api;
})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 // This contract is specific to the owned fixture's advertised two-second main
 // fragments. Neither cue text nor observed cue times participate in the origin.
 function valid(clock){
  if(!clock||clock.source!=='hls-main-fragment'||!Number.isSafeInteger(clock.sn)||clock.sn<0||!Number.isSafeInteger(clock.cc)||clock.cc<0||
   !Number.isFinite(clock.duration)||Math.abs(clock.duration-2)>0.001||!Number.isFinite(clock.start)||!Number.isFinite(clock.programDateTime)||!Number.isFinite(clock.sourceEpochMs)||
   !Number.isFinite(clock.initPTS?.baseTime)||!Number.isFinite(clock.initPTS?.timescale)||clock.initPTS.timescale<=0)return false;
  const advertisedOffset=clock.sn*2-clock.start,decodedOffset=clock.initPTS.baseTime/clock.initPTS.timescale;
  return Number.isFinite(advertisedOffset)&&Math.abs(advertisedOffset-decodedOffset)<0.05&&Math.abs(clock.programDateTime-clock.sourceEpochMs-clock.sn*2000)<1;
 }
 function hlsClock(fragment,initPTS,sourceEpochMs){
  if(!fragment||fragment.type!=='main')return undefined;
  const clock={source:'hls-main-fragment',sn:fragment.sn,cc:fragment.cc,duration:fragment.duration,start:fragment.start,programDateTime:fragment.programDateTime,sourceEpochMs,
   initPTS:initPTS&&{baseTime:initPTS.baseTime,timescale:initPTS.timescale}};
  return valid(clock)?clock:undefined;
 }
 function sourceClock(sample,protocol){
  if(!Number.isFinite(sample?.mediaTime))return undefined;
  if(protocol==='dash')return{sourceTime:sample.mediaTime,offsetSeconds:0,source:'presentation-timeline'};
  if(protocol!=='hls')return undefined;
  const clock=sample.captionClock;if(!valid(clock)||sample.mediaTime<clock.start-0.25||sample.mediaTime>clock.start+clock.duration+0.25)return undefined;
  const offsetSeconds=clock.sn*2-clock.start;
  return{sourceTime:sample.mediaTime+offsetSeconds,offsetSeconds,source:clock.source,sn:clock.sn,cc:clock.cc,programDateTime:clock.programDateTime,sourceEpochMs:clock.sourceEpochMs,initPTS:clock.initPTS};
 }
 return{hlsClock,sourceClock};
});
