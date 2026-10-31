const assert=require('node:assert/strict'),{createHash}=require('node:crypto');const{tracks}=require('./track-scenarios/verify.cjs');const pause=ms=>new Promise(r=>setTimeout(r,ms));async function read(url,method='GET'){const r=await fetch(url,{method,signal:AbortSignal.timeout(5000)}),body=Buffer.from(await r.arrayBuffer());return{status:r.status,hash:createHash('sha256').update(body).digest('hex'),fault:r.headers.get('x-sim-fault-ids')};}
const definitions={
 'dvr-retention':null,
 'join-during-outage':{version:1,rules:[{kind:'outage',target:{track:'video',segment:'each'},status:503,afterMs:1500,beforeMs:6000}]},
 'long-manifest-freeze':{version:1,rules:[],timeline:[{afterMs:1500,beforeMs:46500,manifestFreeze:true},{afterMs:46500,beforeMs:48000,manifestFreeze:false}]},
};
async function verify(session,protocol,kind,signal){const began=performance.now();const until=async ms=>{while(performance.now()-began<ms){signal.throwIfAborted();await pause(Math.min(100,ms-(performance.now()-began)));}};
 let current=await tracks(session,protocol),target=current.find(r=>r.track==='video:0'),before=await read(target.media);assert.equal(before.status,200);let during,restored,held;
 if(kind==='join-during-outage'){await until(1800);current=await tracks(session,protocol);target=current.find(r=>r.track==='video:0');during=await read(target.media);assert.equal(during.status,503);assert.ok(during.fault);assert.equal((await read(target.media,'HEAD')).status,200);await until(6200);restored=await read(target.media);assert.equal(restored.status,200);assert.ok(!restored.fault);}
 else{
  if(kind==='long-manifest-freeze'){await until(1800);current=await tracks(session,protocol);target=current.find(r=>r.track==='video:0');held=await read(target.manifest);assert.ok(held.fault);await until(40000);during=await read(target.manifest);assert.equal(during.hash,held.hash,'long freeze holds the exact published snapshot');assert.equal(during.fault,held.fault);}
  else await until(30000);
  const expired=await read(target.media);assert.equal(expired.status,410,'media beyond the retained DVR grace is unavailable');assert.ok(!expired.fault,'expiration is source retention, not a media fault');during={...during,expiredStatus:expired.status};if(kind==='long-manifest-freeze')await until(47000);const fresh=await tracks(session,protocol),latest=fresh.find(r=>r.track==='video:0');assert.notEqual(latest.media.href,target.media.href);restored=await read(latest.media);assert.equal(restored.status,200);assert.ok(!restored.fault);assert.equal((await read(latest.init)).status,200);
 }
 for(const r of await tracks(session,protocol)){assert.equal((await read(r.manifest)).status,200);if(r.init)assert.equal((await read(r.init,'HEAD')).status,200);}if(protocol==='dash')assert.equal((await read(new URL('/utc',session.url),'HEAD')).status,200);return{protocol,kind,passed:true,simulatorBehaviorVerified:true,userInteractionVerified:false,playerRecoveryVerified:false,elapsedMs:performance.now()-began,before,during,restored,scenario:session.scenario?.report()};
}
require('./owned-scenarios/runner.cjs').run('dvr-scenarios',Object.keys(definitions),(_,kind)=>definitions[kind],verify).catch(e=>{console.error(e.message);process.exitCode=1;});
