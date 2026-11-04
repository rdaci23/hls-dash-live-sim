(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.OwnedAudioProbe=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 function create(video,{createContext=()=>new AudioContext()}={}){
  let context,analyser,source,silence,activation;
  async function enable(){
   context??=createContext();
   // Connecting an element to a suspended context stops its media clock even
   // when the stream is fully buffered. Keep muted playback on its existing
   // output until native context activation has actually completed.
   await context.resume();
   if(context.state!=='running')throw Error('Decoded-audio context did not activate');
   if(!analyser){
    source??=context.createMediaElementSource(video);
    analyser=context.createAnalyser();analyser.fftSize=4096;analyser.smoothingTimeConstant=0;
    silence=context.createGain();silence.gain.value=0;
    source.connect(analyser);analyser.connect(silence);silence.connect(context.destination);
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
 return{create};
});
