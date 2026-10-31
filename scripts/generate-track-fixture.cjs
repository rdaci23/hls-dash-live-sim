// Procedural optional fixture. Existing TS and DASH baseline assets stay unchanged.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {XMLParser}=require('fast-xml-parser');
const {initialization,fragment}=require('./dash-abr/fixture.cjs');
const wvtt=require('./track-fixture/wvtt.cjs');
const root=path.resolve(__dirname,'../assets/track-sample');fs.mkdirSync(root,{recursive:true});
for(const name of fs.readdirSync(root))if(/^(?:init-\d+\.m4s|chunk-\d+-\d+\.m4s|manifest\.mpd|index\.json|text-.*)$/.test(name))fs.rmSync(path.join(root,name));
const args=['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=960x540:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-filter_complex','[0:v]split=3[low][main][high];[low]scale=320:180[v0];[main]scale=640:360[v1]','-map','[v0]','-map','[v1]','-map','[high]','-map','1:a','-map','2:a'];
for(let i=0;i<3;i++)args.push('-frames:v:'+i,'192');args.push('-af','atrim=end_sample=382976');
args.push('-c:v','libx264','-preset','veryfast','-profile:v','baseline','-level:v','3.1','-pix_fmt','yuv420p','-g','48','-keyint_min','48','-sc_threshold','0');
for(const [i,rate]of [180,600,1200].entries())args.push('-b:v:'+i,rate+'k','-maxrate:v:'+i,Math.ceil(rate*1.1)+'k','-bufsize:v:'+i,(rate*2)+'k');
args.push('-c:a','aac','-b:a','64k','-ar','48000','-ac','2','-metadata:s:a:0','language=eng','-metadata:s:a:1','language=ron','-f','dash','-seg_duration','2','-use_template','1','-use_timeline','1','-adaptation_sets','id=0,streams=0,1,2 id=1,streams=3 id=2,streams=4','-init_seg_name','init-$RepresentationID$.m4s','-media_seg_name','chunk-$RepresentationID$-$Number$.m4s',path.join(root,'manifest.mpd'));
execFileSync('ffmpeg',args,{stdio:'inherit'});
const list=v=>Array.isArray(v)?v:[v],doc=new XMLParser({ignoreAttributes:false,parseAttributeValue:false}).parse(fs.readFileSync(path.join(root,'manifest.mpd'),'utf8'));
const tracks=[];
// Fragment timestamps already describe an exact eight-second coded loop. FFmpeg's
// AAC priming edit shifts every loop's presented end by 1024 samples in HLS/MSE.
// Keep those coded samples (including initial silence), with no edit-list trim.
function withoutAudioEdits(buffer){
 const rewrite=(bytes,container)=>{const parts=[];for(let at=0;at<bytes.length;){const size=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8);if(size<8||at+size>bytes.length)throw Error('Invalid owned initialization box');let box=bytes.subarray(at,at+size);if(type==='edts'&&container==='trak'){at+=size;continue;}if(type==='moov'||type==='trak'){const body=rewrite(box.subarray(8),type);box=Buffer.alloc(8+body.length);box.writeUInt32BE(box.length);box.write(type,4);body.copy(box,8);}parts.push(box);at+=size;}return Buffer.concat(parts);};return rewrite(buffer,'root');
}
for(const a of list(doc.MPD.Period.AdaptationSet))for(const r of list(a.Representation)){
 const id=String(r['@_id']),init='init-'+id+'.m4s',type=a['@_contentType'];if(type==='audio')fs.writeFileSync(path.join(root,init),withoutAudioEdits(fs.readFileSync(path.join(root,init))));const timing=initialization(fs.readFileSync(path.join(root,init))),alias=type+':'+tracks.filter(t=>t.type===type).length;
 const files=fs.readdirSync(root).filter(name=>new RegExp('^chunk-'+id+'-\\d+\\.m4s$').test(name)).sort((a,b)=>Number(a.match(/-(\d+)\.m4s$/)[1])-Number(b.match(/-(\d+)\.m4s$/)[1]));
 const segments=files.map(file=>{const bytes=fs.readFileSync(path.join(root,file)),f=fragment(bytes);return{file,baseTime:String(f.baseTime),duration:f.duration,bytes:bytes.length};});
 const total=segments.reduce((n,s)=>n+s.duration,0);if(segments.length!==4||Math.abs(total/timing.timescale-8)>1e-6)throw Error(alias+' is not an exact eight-second loop: '+total/timing.timescale+'s');
 tracks.push({id:alias,type,language:type==='audio'?(alias==='audio:0'?'en':'ro'):undefined,toneHz:type==='audio'?(alias==='audio:0'?440:880):undefined,codec:r['@_codecs'],bandwidth:Number(r['@_bandwidth']),width:timing.width,height:timing.height,timescale:timing.timescale,cycleTicks:total,init,segments});
}
for(const [index,language]of ['en','ro'].entries()){
 const init='text-'+language+'-init.m4s';fs.writeFileSync(path.join(root,init),wvtt.initialization(index?'ron':'eng'));
 const segments=[];for(let i=0;i<4;i++){const file='text-'+language+'-'+(i+1)+'.m4s',body=wvtt.fragment(i+1,i*2000,wvtt.schedule(language,i));fs.writeFileSync(path.join(root,file),body);segments.push({file,baseTime:String(i*2000),duration:2000,bytes:body.length});}
 tracks.push({id:'text:'+index,type:'text',language,codec:'wvtt',bandwidth:2000,timescale:1000,cycleTicks:8000,init,segments});
}
fs.writeFileSync(path.join(root,'index.json'),JSON.stringify({schemaVersion:1,cycleSeconds:8,videoRenditions:[2,3],provenance:'Procedural FFmpeg testsrc2 and 440/880 Hz sine; authored EN/RO WebVTT, owned ISO BMFF builder',captionSchedule:[{from:0.25,to:1.5,cue:1},{from:2,to:4,empty:true},{from:4.25,to:5.5,cue:3},{from:6.25,to:7.5,cue:4}],tracks},null,2)+'\n');
console.log('Generated optional eight-second tracks: three H.264 renditions, two distinguishable AAC tones, two authored wvtt tracks.');
