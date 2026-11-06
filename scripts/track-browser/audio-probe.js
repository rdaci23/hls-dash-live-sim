(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.OwnedAudioProbe=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 async function waitForProcessing(context,{now=()=>performance.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const initial=context.currentTime,began=now();
  if(!Number.isFinite(initial)||initial<0)throw Error('Invalid decoded-audio processing clock');
  for(;;){
   const current=context.currentTime,elapsed=now()-began;
   if(context.state!=='running'||!Number.isFinite(current)||current<initial||!Number.isFinite(elapsed)||elapsed<0)throw Error('Decoded-audio processing stopped before routing');
   if(current>initial&&elapsed<=3000)return;
   if(elapsed>=3000)throw Error('Decoded-audio processing clock did not advance');
   await sleep(Math.min(10,3000-elapsed));
  }
 }
 function create(video,{createContext=()=>new AudioContext()}={}){
  let context,analyser,source,silence,activation;
  async function enable(){
   context??=createContext();
   // Connecting an element to a suspended context stops its media clock even
   // when the stream is fully buffered. Keep muted playback on its existing
   // output until native context activation has actually completed.
   // An idle native context may not pull its clock until it has an active
   // graph. Bootstrap only the probe, with exact silence, before readiness;
   // the media element keeps its original output throughout this wait.
   const bootstrap=!analyser?context.createConstantSource():undefined;
   let bootstrapStarted=false;
   try{
    if(bootstrap){bootstrap.offset.value=0;bootstrap.connect(context.destination);bootstrap.start();bootstrapStarted=true;}
    await context.resume();
    if(context.state!=='running')throw Error('Decoded-audio context did not activate');
    if(!analyser){
     await waitForProcessing(context);
     source??=context.createMediaElementSource(video);
     analyser=context.createAnalyser();analyser.fftSize=4096;analyser.smoothingTimeConstant=0;
     silence=context.createGain();silence.gain.value=0;
     source.connect(analyser);analyser.connect(silence);silence.connect(context.destination);
    }
   }finally{
    if(bootstrap){try{if(bootstrapStarted)bootstrap.stop();}finally{bootstrap.disconnect();}}
   }
   video.muted=false;await video.play();
  }
  return{
   get context(){return context;},get analyser(){return analyser;},
   activate(){
    if(activation)return activation;
    const work=enable();activation=work;
    work.then(()=>{activation=undefined;},()=>{activation=undefined;});
    return work;
   }
  };
 }
 return{create,waitForProcessing};
});
