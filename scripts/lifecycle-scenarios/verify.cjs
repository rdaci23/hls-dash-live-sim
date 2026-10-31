const assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const{tracks}=require('../track-scenarios/verify.cjs');const{XMLParser}=require('fast-xml-parser');const{fragment}=require('../dash-abr/fixture.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms)),hash=b=>createHash('sha256').update(b).digest('hex');
async function read(url,method='GET'){const r=await fetch(url,{method,signal:AbortSignal.timeout(5000)}),body=Buffer.from(await r.arrayBuffer());return{status:r.status,body,headers:r.headers,sha256:hash(body),requestId:r.headers.get('x-sim-request-id')};}
async function verify(session,protocol,kind,signal){
 const firstRoot=await read(session.url);assert.equal(firstRoot.status,200);const before=await tracks(session,protocol),controls=[];for(const r of before){const m=await read(r.media);assert.equal(m.status,200);controls.push({track:r.track,url:r.media,sha256:m.sha256});if(r.init)assert.equal((await read(r.init)).status,200);}
 const until=Date.now()+14000;let resources,transitionRoot,changed;
 while(Date.now()<until){signal?.throwIfAborted();await pause(100);transitionRoot=await read(session.url);assert.equal(transitionRoot.status,200);resources=await tracks(session,protocol);
  if(kind==='event-completion')changed=protocol==='hls'?await Promise.all(resources.map(async r=>/\n#EXT-X-ENDLIST\s*$/.test((await read(r.manifest)).body.toString()))).then(flags=>flags.every(Boolean)):/<MPD\b[^>]*type="static"/.test(transitionRoot.body.toString());
  else changed=resources.filter(r=>r.init).every(r=>r.init.href!==before.find(b=>b.track===r.track).init.href);
  if(changed)break;
 }
 assert.ok(changed,'source transition becomes advertised on a bounded aligned boundary');const after=[];
 for(const r of resources){const media=await read(r.media);assert.equal(media.status,200);assert.ok(media.body.length);if(r.init){const init=await read(r.init);assert.equal(init.status,200);const initial=await read(before.find(b=>b.track===r.track).init);assert.deepEqual(init.body,initial.body,'new initialization remains compatible with coded media');if(kind==='encoder-restart')assert.notEqual(r.init.href,before.find(b=>b.track===r.track).init.href);}
  if(r.init||protocol==='dash'){const timing=fragment(media.body);assert.ok(timing.duration>0);after.push({track:r.track,status:media.status,sha256:media.sha256,decodeTime:String(timing.baseTime),duration:timing.duration,requestId:media.requestId});}else after.push({track:r.track,status:media.status,sha256:media.sha256,webVtt:true,requestId:media.requestId});
 }
 for(const c of controls){const retained=await read(c.url);assert.equal(retained.status,200);assert.equal(retained.sha256,c.sha256,'retained old resources keep their bytes');}
 if(protocol==='dash'){const utc=await read(new URL('/utc',session.url),'HEAD');assert.equal(utc.status,200);assert.ok(Math.abs(Date.now()-Date.parse(utc.headers.get('date')))<2000);const doc=new XMLParser({ignoreAttributes:false}).parse(transitionRoot.body.toString()).MPD;
  if(kind==='encoder-restart'){const periods=Array.isArray(doc.Period)?doc.Period:[doc.Period],latest=periods.at(-1);assert.notEqual(latest['@_id'],'owned');assert.ok(Number(latest['@_start'].slice(2,-1))>0);}
  else{assert.equal(doc['@_type'],'static');assert.ok(doc['@_mediaPresentationDuration']);assert.ok(!transitionRoot.body.toString().includes('UTCTiming'));const repeat=await read(session.url);assert.equal(repeat.sha256,transitionRoot.sha256,'finite MPD stops changing');}
 }else if(kind==='encoder-restart')for(const r of resources){const text=(await read(r.manifest)).body.toString();assert.match(text,/#EXT-X-DISCONTINUITY/);assert.ok(Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m.exec(text)[1])>=0);}
 if(kind==='event-completion'&&protocol==='hls'){const rootAgain=await tracks(session,protocol);for(const r of rootAgain){const first=await read(r.manifest);await pause(20);assert.equal((await read(r.manifest)).sha256,first.sha256,'ENDLIST freezes the completed event publication');}}
 const scenario=session.scenario.report();assert.equal(scenario.lifecycle.result,'passed');return{protocol,kind,passed:true,simulatorBehaviorVerified:true,browserEndedVerified:false,browserTransitionVerified:false,before:controls.map(c=>({track:c.track,sha256:c.sha256})),after,scenario};
}
module.exports={verify};
