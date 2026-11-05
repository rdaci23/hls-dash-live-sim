// Bounded Node retention for the owned player's sequenced metric drains.
// A lost/timed-out drain cannot be replaced by a later successful snapshot.
const keys=Object.freeze(['heights','gaps','audio','captions','pulses','errors','events','dashCausality']);
function create(limit=5000){
 const history=Object.fromEntries(keys.map(k=>[k,[]])),batches=[];let protocol,epoch,lost=0;
 return{append(m,requestId){
  if(m===undefined)return m;
  const d=m.metricDelta,last=batches.at(-1);
  if(!d||d.schemaVersion!==1||d.requestId!==requestId||!Number.isSafeInteger(requestId)||requestId<1||d.batchId!==batches.length+1||last&&requestId!==last.requestId+1)throw Error('Metric drain identity is missing, duplicated or discontinuous');
  if(!['hls','dash'].includes(m.protocol)||!Number.isFinite(m.startEpochMs)||!Number.isFinite(m.elapsedMs)||!Number.isSafeInteger(m.dropped)||m.dropped<0||!Number.isSafeInteger(m.frames)||m.frames<0||last&&(m.protocol!==protocol||m.startEpochMs!==epoch||m.elapsedMs<last.elapsedMs||m.frames<last.frames))throw Error('Metric drain clock or stream identity changed');
  if(batches.length>=limit)throw Error('Metric drain ledger exceeds retention bound');
  protocol=m.protocol;epoch=m.startEpochMs;const counts={};
  for(const key of keys){if(!Array.isArray(m[key]))throw Error('Metric drain array missing: '+key);counts[key]=m[key].length;const room=limit-history[key].length;history[key].push(...m[key].slice(0,room));lost+=Math.max(0,m[key].length-room);}
  batches.push({batchId:d.batchId,requestId,elapsedMs:m.elapsedMs,frames:m.frames,counts,snapshotTiming:m.snapshotTiming});
  const result={...m,dropped:m.dropped+lost,metricHistory:{schemaVersion:1,limit,batches:batches.slice(),lost}};delete result.metricDelta;
  for(const key of keys)result[key]=history[key].slice();return result;
 }};
}
function validate(m){
 const p=m?.metricHistory,failures=[],fail=s=>failures.push(s);
 if(!Number.isFinite(m?.startEpochMs)||!['hls','dash'].includes(m?.protocol)||!p||p.schemaVersion!==1||p.limit!==5000||p.lost!==0||!Array.isArray(p.batches)||!p.batches.length||p.batches.length>5000)return{passed:false,failures:['Metric history proof missing or truncated']};
 const counts=Object.fromEntries(keys.map(k=>[k,0]));let prior;
 for(const [i,b]of p.batches.entries()){
  if(!b||typeof b!=='object'){fail('Metric history batch missing');continue;}
  if(b.batchId!==i+1||!Number.isSafeInteger(b.requestId)||b.requestId<1||!Number.isFinite(b.elapsedMs)||!Number.isSafeInteger(b.frames)||b.frames<0||prior&&(b.requestId!==prior.requestId+1||b.elapsedMs<prior.elapsedMs||b.frames<prior.frames))fail('Metric history sequence/clock is discontinuous');
  for(const k of keys){const n=b.counts?.[k];if(!Number.isSafeInteger(n)||n<0||n>5000)fail('Metric history count invalid');else counts[k]+=n;}
  const t=b.snapshotTiming;if(!t||t.probeTimeoutMs!==1000||![t.requestedEpochMs,t.completedEpochMs,t.elapsedMs].every(Number.isFinite)||t.elapsedMs<0||t.elapsedMs>1000||t.completedEpochMs<t.requestedEpochMs||Math.abs(t.completedEpochMs-t.requestedEpochMs-t.elapsedMs)>1||m.startEpochMs+b.elapsedMs<t.requestedEpochMs-10||m.startEpochMs+b.elapsedMs>t.completedEpochMs+10)fail('Metric history RPC timing missing, inconsistent or over budget');
  prior=b;
 }
 for(const k of keys)if(!Array.isArray(m[k])||m[k].length!==counts[k]||counts[k]>5000)fail('Metric history data is missing or exceeds retention');
 if(!prior||prior.elapsedMs!==m.elapsedMs||prior.frames!==m.frames||m.dropped!==0)fail('Metric history final observation mismatch');
 return{passed:!failures.length,failures};
}
module.exports={create,validate,keys};
