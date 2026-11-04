function resourceUrl(value){
 try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol))return undefined;url.username='';url.password='';url.search='';url.hash='';return url.href;}catch{return undefined;}
}
function text(value,limit,onTruncate){
 if(value===undefined)return undefined;
 let result=String(value).replace(/https?:\/\/[^\s)]+/g,url=>resourceUrl(url)??'[redacted URL]');
 if(result.length>limit){onTruncate();result=result.slice(0,limit);}
 return result;
}
function create({limit=10000,now=Date.now,context=()=>({})}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw Error('Invalid browser audit limit');
 const events=[];let dropped=0;const lost=()=>{dropped++;};
 const record=entry=>{
  if(events.length>=limit){lost();return;}
  let state;try{state=context();}catch{lost();state={contextUnavailable:true};}
  const event={...entry,...state,epochMs:now()};
  for(const key of ['message','stack'])if(event[key]!==undefined)event[key]=text(event[key],key==='stack'?16384:4096,lost);
  if(event.url!==undefined)event.url=resourceUrl(event.url);
  if(event.location)event.location={...event.location,url:resourceUrl(event.location.url)};
  events.push(event);
  return event;
 };
 return{events,record,dropped:()=>dropped};
}
module.exports={create,resourceUrl};
