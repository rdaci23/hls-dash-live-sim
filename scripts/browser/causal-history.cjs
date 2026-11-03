// Retain diagnostic deltas in Node, avoiding repeated browser serialization of
// the complete causal log. Missing/duplicate/truncated records fail closed.
function create(limit=8192){
 let events=[],lastId=0,dropped=0;
 return{append(metrics){
  if(metrics===undefined)return metrics;
  if(!Array.isArray(metrics.dashCausality)||!Number.isSafeInteger(metrics.causalityDropped)||metrics.causalityDropped<0)throw Error('Causal history telemetry is missing');
  for(const event of metrics.dashCausality){
   if(!event||!Number.isSafeInteger(event.eventId)||event.eventId!==lastId+1){dropped++;continue;}
   lastId=event.eventId;if(events.length<limit)events.push(event);else dropped++;
  }
  return{...metrics,dashCausality:events.slice(),causalityDropped:metrics.causalityDropped+dropped};
 }};
}
module.exports={create};
