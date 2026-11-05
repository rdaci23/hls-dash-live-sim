const finite=Number.isFinite;
function validateCausalCompletion(metrics,{minimumAtMs=0,minimumEpochMs}={}){
 const failures=[],fail=message=>failures.push(message),completion=metrics?.causalCompletion,finish=completion?.snapshotTiming,snapshot=metrics?.snapshotTiming;
 if(!finite(minimumAtMs)||minimumAtMs<0||minimumEpochMs!==undefined&&(!finite(minimumEpochMs)||minimumEpochMs<0))fail('Invalid completion observation boundary');
 if(!['hls','dash'].includes(metrics?.protocol))fail('Invalid causal observer protocol');
 if(!metrics||metrics.causalProbe!==true||metrics.causalProbeCompleted!==true||metrics.causalityDropped!==0||metrics.dropped!==0)fail('Causal observer is missing, incomplete or truncated');
 const markers=Array.isArray(metrics?.events)?metrics.events.filter(e=>e.kind==='causal-probe-disposed'):[],marker=markers[0];
 if(markers.length!==1||marker.protocol!==metrics?.protocol||marker.dropped!==0||!finite(marker.atMs)||marker.atMs<minimumAtMs||!finite(metrics?.elapsedMs)||marker.atMs>metrics.elapsedMs)fail('Causal observer completion marker is missing or premature');
 function rpc(value,label){
  if(!value||![value.requestedEpochMs,value.completedEpochMs,value.elapsedMs].every(finite)||![1000,3000].includes(value.probeTimeoutMs)||value.completedEpochMs<value.requestedEpochMs||value.elapsedMs<0||value.elapsedMs>value.probeTimeoutMs||Math.abs(value.completedEpochMs-value.requestedEpochMs-value.elapsedMs)>1)fail(label+' RPC is missing, inconsistent or unbounded');
 }
 rpc(finish,'Observer disposal');rpc(snapshot,'Final snapshot');
 // Browser elapsed time and Node wall time each retain a strict boundary.
 // Only a fresh, request-bound disposal can bridge them without projecting
 // rounded Node milliseconds onto the browser's fractional monotonic clock.
 const modern=completion?.schemaVersion!==undefined||marker?.schemaVersion!==undefined;
 if(modern&&(completion?.schemaVersion!==2||marker?.schemaVersion!==2||completion?.fresh!==true||!Number.isSafeInteger(completion?.requestedCallId)||completion.requestedCallId<1||completion.callId!==completion.requestedCallId||marker?.callId!==completion.requestedCallId))fail('Causal completion is not a fresh request-bound disposal');
 if(minimumEpochMs!==undefined){
  if(modern){if(!finite(finish?.requestedEpochMs)||finish.requestedEpochMs<minimumEpochMs)fail('Observer disposal RPC precedes the Node observation boundary');}
  else if(!finite(metrics?.startEpochMs)||!finite(marker?.atMs)||marker.atMs<minimumEpochMs-metrics.startEpochMs)fail('Legacy completion precedes the projected observation boundary');
 }

 if(completion?.completed!==true||!finite(completion.atMs)||completion.atMs!==marker?.atMs||!finite(metrics?.startEpochMs))fail('Causal completion result does not match the native marker');
 if(finish&&snapshot&&marker&&finite(metrics?.startEpochMs)){
  const markerEpoch=metrics.startEpochMs+marker.atMs,sampleEpoch=metrics.startEpochMs+metrics.elapsedMs;
  if(finish.probeTimeoutMs!==snapshot.probeTimeoutMs||markerEpoch<finish.requestedEpochMs-10||markerEpoch>finish.completedEpochMs+10||snapshot.requestedEpochMs<finish.completedEpochMs||snapshot.requestedEpochMs>finish.completedEpochMs+250||sampleEpoch<snapshot.requestedEpochMs-10||sampleEpoch>snapshot.completedEpochMs+10)fail('Disposal and final snapshot do not form a measured observation boundary');
 }
 if(metrics?.protocol==='dash'){
  const events=metrics.dashCausality,installed=Array.isArray(events)?events.filter(e=>e.phase==='observer-installed'):[],disposed=Array.isArray(events)?events.filter(e=>e.phase==='observer-disposed'):[];
  if(installed.length!==1||disposed.length!==1||disposed[0].activeDispatches!==0||!finite(installed[0].atMs)||!finite(disposed[0].atMs)||installed[0].atMs>disposed[0].atMs||disposed[0].atMs>marker?.atMs)fail('DASH causal observer lifecycle is incomplete');
 }
 return{passed:failures.length===0,failures};
}
module.exports={validateCausalCompletion};
