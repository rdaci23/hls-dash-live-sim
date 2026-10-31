function languageEvidence(metrics,fromMs,language){
 const tone=language==='en'?440:880,audio=(metrics.audio??[]).filter(a=>a.atMs>fromMs+300&&a.selected===language),captions=(metrics.captions??[]).filter(c=>c.atMs>fromMs+300&&c.selected===language);
 const last=audio.slice(-5),toneVerified=metrics.contextState==='running'&&last.length===5&&metrics.elapsedMs-last.at(-1).atMs<500&&last.at(-1).contextTime-last[0].contextTime>0.25&&last.every(a=>a.toneHz===tone&&a.rms>=0.005)&&last.at(-1).mediaTime-last[0].mediaTime>0.25;
 const cue=captions.find(c=>{const position=((c.mediaTime%8)+8)%8,cycle=Math.floor(c.mediaTime/8)*8,index=position>0.45&&position<1.3?1:position>4.45&&position<5.3?3:position>6.45&&position<7.3?4:null;return index!==null&&c.tracks.some(t=>t.mode==='showing'&&t.language===language&&t.cues.some(cue=>cue.text===language.toUpperCase()+' cue '+index&&c.mediaTime>=cue.start&&c.mediaTime<cue.end&&Math.abs(cue.start-(cycle+(index===1?0.25:index===3?4.25:6.25)))<0.05&&Math.abs(cue.end-(cycle+(index===1?1.5:index===3?5.5:7.5)))<0.05));});
 const empty=captions.find(c=>{const position=((c.mediaTime%8)+8)%8;return position>2.25&&position<3.75&&c.tracks.some(t=>t.mode==='showing'&&t.language===language&&t.loadedCues>0&&t.cues.length===0);});
 return{verified:!!(toneVerified&&cue&&empty),expectedToneHz:tone,toneWindows:last,activeCue:cue,emptyInterval:empty};
}
function expectedCancellation(error,events){
 if(error.kind!=='hls'||error.fatal!==false||error.type!=='networkError'||error.details!=='aborted'||error.message!=='Aborted'||error.frag?.type!=='subtitle')return false;
 const near=e=>e.atMs<=error.atMs+1&&error.atMs-e.atMs<=500;
 return events.some(e=>e.kind==='subtitle-switch'&&near(e))&&events.some(e=>e.kind==='selection'&&e.text!==undefined&&near(e));
}
module.exports={languageEvidence,expectedCancellation};
