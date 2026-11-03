const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function snapshot(evaluate,{now=Date.now,monotonic=()=>performance.now(),timeoutMs=1000}={}){
 const requestedEpochMs=now(),began=monotonic();let timer;
 try{
  const value=await Promise.race([evaluate(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Browser telemetry probe timed out')),timeoutMs);})]);
  const elapsedMs=monotonic()-began;if(elapsedMs>timeoutMs)throw Error('Browser telemetry probe timed out');
  return value&&{...value,snapshotTiming:{requestedEpochMs,completedEpochMs:now(),elapsedMs,probeTimeoutMs:timeoutMs}};
 }finally{clearTimeout(timer);}
}
async function wait(read,predicate,{timeoutMs,label,signal,now=Date.now,monotonic=()=>performance.now(),sleep=pause}={}){
 const startedEpochMs=now(),began=monotonic(),deadline=began+timeoutMs;let lastProbe;
 while(monotonic()<deadline){
  signal?.throwIfAborted();const started=now(),probeBegan=monotonic(),metrics=await read();
  lastProbe={startedEpochMs:started,endedEpochMs:now(),elapsedMs:monotonic()-probeBegan};
  if(monotonic()<=deadline&&metrics&&predicate(metrics))return metrics;
  const remaining=deadline-monotonic();if(remaining>0)await sleep(Math.min(100,remaining));
 }
 const error=Error(label+' timed out');
 error.waitTiming={schemaVersion:1,label,timeoutMs,startedEpochMs,deadlineEpochMs:startedEpochMs+timeoutMs,endedEpochMs:now(),elapsedMs:monotonic()-began,lastProbe,pollIntervalMs:100,probeTimeoutMs:1000};
 throw error;
}
module.exports={snapshot,wait};
