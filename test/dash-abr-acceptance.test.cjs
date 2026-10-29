const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, normalize, PROFILES } = require('../scripts/dash-abr/acceptance.cjs');
function input(test = 'bandwidth') {
  const epoch = 1000000;
  const phase = (name, at) => ({ name, requestMs: at, acknowledgedMs: at + 20, appliedEpochMs: epoch + at + 10, bandwidthKbps: PROFILES[name] });
  const phases = test === 'bandwidth' ? [phase('restricted', 31000), phase('restored', 68000)] : [];
  const m = { runId: 'run', startEpochMs: epoch, firstFrameMs: 1000, lastFrameMs: 136000, elapsedMs: 136010, firstMediaTime: 0, mediaTime: 135,
    frames: 3200, maxFrameGapMs: 100, levels: [{id:'0',width:320,height:180,bitrate:180000},{id:'1',width:640,height:360,bitrate:600000}],
    runs:[],fragments:[],failures:[],gaps:[],regressions:[],jumps:[],seeks:[],playerErrors:[],videoErrors:[],probeErrors:[],emergencyAborts:[],phases,
    complete:true,autoLevelEnabled:true,utcSettings:{enabled:true},utcCorsDate:new Date(epoch).toUTCString() };
  const events=[],audit=[{kind:'response',url:'http://localhost/static/time.txt',method:'HEAD',date:new Date(epoch).toUTCString(),status:200,epochMs:epoch}];
  function run(level,begin,end,rate) {
    const rendition=m.levels[level], r={level,width:rendition.width,height:rendition.height,startMs:begin,endMs:end,auto:true,confirmed:[]};
    for(let at=begin;at<end-500;at+=2000){
      const requestId='req-'+at,url='http://localhost/chunk-'+level+'-'+at+'.m4s',finish=Math.min(at+1900,end),start=(at-1000)/1000;
      const f={requestId,url,width:rendition.width,height:rendition.height,representationId:rendition.id,track:'video',bytes:10000,start,end:start+2,
        firstFrameMs:at,lastFrameMs:finish,firstMediaTime:start,mediaTime:start+(finish-at)/1000,frames:45};
      m.fragments.push({...f});r.confirmed.push(f);
      events.push({event:'request.started',requestId,timestamp:new Date(epoch+at-500).toISOString()}, {event:'request.completed',requestId,status:200,bodyBytes:10000,timestamp:new Date(epoch+at-100).toISOString()});
      if(rate) events.push({event:'fault.applied',requestId,fault:'response.bandwidth',bandwidthKbps:rate,faultId:'fault-'+at});
      audit.push({kind:'response',requestId,url,status:200,faultIds:rate?'fault-'+at:undefined,epochMs:epoch+at-100});
    }m.runs.push(r);
  }
  let scenario;
  if(test==='bandwidth'){run(1,4000,36000,1500);run(0,36000,75000,450);run(1,75000,136000,1500);}
  else{
    run(1,1000,63000,0);run(0,65000,136000,0);
    const url='http://localhost/high-failed.m4s';
    events.push({event:'scenario.started',timestamp:new Date(epoch).toISOString()}, {event:'request.completed',requestId:'failed',trackId:'video:1',status:503,timestamp:new Date(epoch+60000).toISOString()},
      {event:'fault.applied',requestId:'failed',fault:'scenario.status',faultId:'targeted'});
    audit.push({kind:'response',requestId:'failed',url,status:503,faultIds:'targeted',epochMs:epoch+60000});
    scenario={result:'passed',rules:[{kind:'outage',target:{track:'video:1'},beforeMs:150000}]};
  }
  return {test,metrics:m,events,audit,scenario,profiles:[{name:'baseline',bandwidthKbps:1500,appliedEpochMs:epoch},...phases.map(p=>({name:p.name,bandwidthKbps:p.bandwidthKbps,appliedEpochMs:p.appliedEpochMs}))]};
}
test('DASH adaptation requires rendered and served high/low/high plus normal local UTC',()=>{
  const result=evaluate(input());assert.equal(result.passed,true,result.failures.join('; '));
  for(const edit of [x=>{x.metrics.runs[1].confirmed=[];},x=>{x.metrics.runs[1].confirmed[0].representationId='1';},
    x=>{x.metrics.fragments=[];},x=>{x.metrics.utcSettings.enabled=false;},x=>{x.audit=x.audit.filter(e=>e.method!=='HEAD');},
    x=>{x.metrics.autoLevelEnabled=false;},x=>{x.metrics.playerErrors.push({code:27});},x=>{x.events=x.events.filter(e=>e.event!=='fault.applied');}]){
    const data=input();edit(data);assert.equal(evaluate(data).passed,false,edit.toString());
  }
});
test('only a single last-frame startup fragment is excluded from the measured sustained spans',()=>{
  const data=input(); const f={...data.metrics.runs[0].confirmed[0],frames:1,firstFrameMs:1000,lastFrameMs:1000,firstMediaTime:1.96,mediaTime:1.96,start:0,end:2};
  data.metrics.runs[0].confirmed.unshift(f); assert.equal(normalize(data.metrics).runs[0].confirmed.length,data.metrics.runs[0].confirmed.length-1);
  f.firstFrameMs=5000;f.lastFrameMs=5000;assert.equal(normalize(data.metrics).runs[0].confirmed.length,data.metrics.runs[0].confirmed.length);
});
test('HTTP fallback is a separate result and cannot pass from fault delivery alone',()=>{
  const data=input('fallback');const result=evaluate(data);assert.equal(result.passed,true,result.failures.join('; '));assert.equal(result.selectiveFaultDeliveryVerified,true);
  for(const edit of [x=>{x.metrics.complete=false;},x=>{x.metrics.runs.pop();},x=>{x.metrics.fragments=[];},x=>{x.metrics.runs[1].confirmed[0].bytes=1;},
    x=>{x.events.find(e=>e.requestId==='failed'&&e.event==='request.completed').trackId='video:0';},x=>{x.metrics.seeks.push({atMs:80000});},
    x=>{x.audit.push({kind:'console',level:'error',text:'unknown failure',epochMs:1080000});},x=>{x.metrics.maxFrameGapMs=5000;},
    x=>{x.scenario.result='incomplete';},x=>{x.metrics.utcSettings.enabled=false;}]){
    const changed=input('fallback');edit(changed);assert.equal(evaluate(changed).passed,false,edit.toString());
  }
  const failed=input('fallback');failed.metrics.runs.pop();const observed=evaluate(failed);assert.equal(observed.selectiveFaultDeliveryVerified,true);assert.equal(observed.passed,false);
  const missing=input('fallback');missing.metrics.levels=[];assert.equal(evaluate(missing).passed,false);
  const stationary=input('fallback');stationary.metrics.frames=0;assert.equal(evaluate(stationary).passed,false);
  assert.equal(evaluate({}).passed,false);
});
