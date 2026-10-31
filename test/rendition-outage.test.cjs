const { test }=require('node:test');
const assert=require('node:assert/strict');
const {definition,accept}=require('../scripts/rendition-outage/verify.cjs');
const {parseScenario}=require('../dist/support-tools/scenario.js');
for(const [protocol,target] of [['hls','video:1'],['hls','video:0'],['dash','video:0']])test(protocol+' '+target+' preset targets exactly one rendition',()=>{
  const data=parseScenario(definition(protocol,target,true));assert.equal(data.rules.length,1);assert.deepEqual(data.rules[0].target,{track:target,segment:'each'});assert.equal(data.rules[0].afterMs,60000);assert.equal(data.rules[0].beforeMs,80000);assert.equal(data.rules[0].attempts,'all');assert.equal(definition(protocol,target).rules[0].beforeMs,15000);
});
function fixture(protocol='hls'){
  const evidence={protocol,target:'video:1',window:{afterMs:5000,beforeMs:15000},samples:[],requests:[],restorations:[],scenario:{result:'passed',rules:[{selected:12,applied:12}]}},events=[];let id=0;
  const add=(sample,kind,track,method='GET',fault=false)=>{const requestId='r'+ ++id,row={requestId,kind,track,method,startMs:sample.startMs+10,endMs:sample.startMs+20,bodyBytes:method==='HEAD'?0:1024,status:fault?503:200,expectedStatus:fault?503:200,faultIds:fault?'fault-one':undefined,clockSkewMs:kind==='utc'?500:undefined};evidence.requests.push(row);events.push({event:'request.completed',requestId,status:row.status,bodyBytes:row.bodyBytes});if(fault){events.push({event:'fault.applied',requestId,faultId:'fault-one',fault:'scenario.status',trackId:'video:1',targetKind:'media'});events.push({event:'scenario.attempt',requestId,segmentId:'segment-'+id,trackId:'video:1',attempt:1});}return row;};
  for(const [index,[phase,startMs]]of [['baseline',0],['outage',5300],['outage',10000],['outage',14000],['restored',15300],['restored',17800]].entries()){
    const sample={phase,startMs,endMs:startMs+100,positions:{'video:0':String(index*2),'video:1':String(index*2)}};evidence.samples.push(sample);add(sample,'manifest');
    if(protocol==='hls'){add(sample,'manifest','video:0');add(sample,'manifest','video:1');}else{for(const track of ['audio:0','video:0','video:1'])add(sample,'init',track);add(sample,'media','audio:0');add(sample,'utc',undefined,'HEAD');}
    add(sample,'media','video:0');add(sample,'media','video:1','HEAD');if(phase==='outage')for(let n=0;n<4;n++)add(sample,'media','video:1','GET',true);else add(sample,'media','video:1');
  }
  for(const failed of evidence.requests.filter(r=>r.expectedStatus===503).slice(0,4)){const row=add({startMs:16000},'media','video:1'),attempt=events.find(e=>e.event==='scenario.attempt'&&e.requestId===failed.requestId);events.push({event:'scenario.attempt',requestId:row.requestId,segmentId:attempt.segmentId,trackId:attempt.trackId,attempt:2});evidence.restorations.push({failedRequestId:failed.requestId,requestId:row.requestId});}
  return{evidence,events};
}
for(const protocol of ['hls','dash'])test(protocol+' complete outage/restoration evidence qualifies',()=>{const{evidence,events}=fixture(protocol);accept(evidence,events);});
const mutations={
  'wrong target':r=>{r.target='video:0';},
  'stale publication':r=>{for(const s of r.samples)s.positions['video:1']='0';},
  'no restoration':r=>{r.restorations=[];},
  'missing alternate':r=>{r.requests=r.requests.filter(v=>v.track!=='video:0'||v.kind!=='media');},
  'missing child playlist':r=>{r.requests.splice(r.requests.findIndex(v=>v.kind==='manifest'),1);},
  'missing init':r=>{r.requests.splice(r.requests.findIndex(v=>v.kind==='init'),1);},
  'bad clock':r=>{const row=r.requests.find(v=>v.kind==='utc');if(row)row.clockSkewMs=6000;else r.samples[0].endMs=5000;},
  'wrong fault id':(_r,e)=>{e.find(v=>v.event==='fault.applied').faultId='wrong';},
  'different restored segment':(r,e)=>{e.find(v=>v.event==='scenario.attempt'&&v.requestId===r.restorations[0].requestId).segmentId='wrong';},
  'cancelled request':(_r,e)=>{e.push({event:'request.cancelled'});},
  'truncation':(_r,e)=>{e.push({event:'diagnostics.file_limit'});},
  'unfinished scenario':r=>{r.scenario.result='pending';},
};
for(const[name,mutate]of Object.entries(mutations))test('rejects '+name,()=>{const{evidence,events}=fixture(name==='missing init'||name==='bad clock'?'dash':'hls');mutate(evidence,events);assert.throws(()=>accept(evidence,events));});
