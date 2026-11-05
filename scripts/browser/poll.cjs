const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function snapshot(evaluate,{now=Date.now,monotonic=()=>performance.now(),timeoutMs=1000}={}){
 const requestedEpochMs=now(),began=monotonic();let timer;
 try{
  const value=await Promise.race([evaluate(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Browser telemetry probe timed out')),timeoutMs);})]);
  const completedEpochMs=now(),elapsedMs=monotonic()-began;if(elapsedMs>timeoutMs)throw Error('Browser telemetry probe timed out');
  return value&&{...value,snapshotTiming:{requestedEpochMs,completedEpochMs,elapsedMs,probeTimeoutMs:timeoutMs}};
 }catch(error){if(error&&typeof error==='object')error.probeTiming={requestedEpochMs,completedEpochMs:now(),elapsedMs:monotonic()-began,probeTimeoutMs:timeoutMs};throw error;}finally{clearTimeout(timer);}
}
async function wait(read,predicate,{timeoutMs,label,signal,now=Date.now,monotonic=()=>performance.now(),sleep=pause,probeTimeoutMs=1000}={}){
 const startedEpochMs=now(),began=monotonic(),deadline=began+timeoutMs;let lastProbe;
 for(;;){
  signal?.throwIfAborted();const started=now(),probeBegan=monotonic();
  if(probeBegan>=deadline)break;
  const metrics=await read(),probeEnded=monotonic();
  lastProbe={startedEpochMs:started,endedEpochMs:now(),elapsedMs:probeEnded-probeBegan,startedAfterMs:probeBegan-began,endedAfterMs:probeEnded-began};
  if(probeEnded<=deadline&&metrics&&predicate(metrics)&&monotonic()<=deadline)return metrics;
  const remaining=deadline-monotonic();if(remaining>0)await sleep(Math.min(100,remaining));
 }
 const error=Error(label+' timed out');
 error.waitTiming={schemaVersion:2,label,timeoutMs,startedEpochMs,deadlineEpochMs:startedEpochMs+timeoutMs,endedEpochMs:now(),elapsedMs:monotonic()-began,lastProbe,pollIntervalMs:100,probeTimeoutMs};
 throw error;
}
module.exports={snapshot,wait};
