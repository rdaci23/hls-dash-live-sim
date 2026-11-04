// Join Chrome's timestamp at the console call to the ordinary Playwright audit.
// Arrival order on the two protocol channels is deliberately not a clock.
function create(limit=10000){
 if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw Error('Invalid console clock limit');
 const native=[],audit=[];let sequence=0,loss=0;
 const key=(message,location)=>JSON.stringify([message,location?.url,location?.lineNumber,location?.columnNumber]);
 function join(){for(let i=0;i<audit.length;){const at=native.findIndex(n=>n.key===audit[i].key);if(at<0){i++;continue;}const entry=native.splice(at,1)[0];audit.splice(i,1)[0].event.browserConsole=entry.clock;}}
 return{
  native(event){
   if(event.type!=='error')return;
   if(++sequence>limit){loss++;return;}
   const arg=event.args?.[0],location=event.stackTrace?.callFrames?.[0];
   if(event.args?.length!==1||arg?.type!=='string'||typeof arg.value!=='string'||arg.value.length>4096||!location||!Number.isFinite(event.timestamp))return;
   native.push({key:key(arg.value,location),clock:{schemaVersion:1,source:'Runtime.consoleAPICalled',eventId:sequence,epochMs:event.timestamp}});join();
  },
  audit(event,message,location){
   if(!event)return;
   if(audit.length>=limit){loss++;return;}
   audit.push({event,key:key(message,{url:location.url,lineNumber:location.lineNumber,columnNumber:location.columnNumber})});join();
  },
  dropped:()=>loss
 };
}
module.exports={create};
