(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory();
 else root.OwnedCausalCompletion=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 // A later RPC must never present an already-disposed observer as fresh.
 function create({protocol,now,dispose,dropped,record}){
  let attempted=false,result;
  return{finish(callId){
   if(!Number.isSafeInteger(callId)||callId<1)throw Error('Invalid completion call identity');
   if(attempted)return result?{...result,fresh:false}:{completed:false,fresh:false};
   attempted=true;dispose();const atMs=now();
   if(!Number.isFinite(atMs)||atMs<0)throw Error('Invalid native completion clock');
   record({schemaVersion:2,kind:'causal-probe-disposed',protocol,callId,atMs,dropped:dropped()});
   result={schemaVersion:2,completed:true,fresh:true,callId,atMs};
   return{...result};
  }};
 }
 return{create};
});
