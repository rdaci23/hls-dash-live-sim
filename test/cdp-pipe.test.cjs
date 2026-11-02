const {test}=require('node:test'),assert=require('node:assert/strict'),{PassThrough}=require('node:stream');
const {CdpPipe}=require('../scripts/browser/cdp-pipe.cjs');
function harness(t,options){const input=new PassThrough(),output=new PassThrough(),sent=[];output.on('data',data=>sent.push(JSON.parse(data.toString().slice(0,-1))));const pipe=new CdpPipe(input,output,options);t.after(()=>{pipe.close();input.destroy();output.destroy();});return{pipe,input,sent};}
test('CDP pipe joins UTF-8 fragments, separates coalesced events and matches out-of-order responses',async t=>{
 const {pipe,input,sent}=harness(t),events=[];pipe.on('event',event=>events.push(event));
 const a=pipe.send('Runtime.evaluate',{expression:'fixture'},'page'),b=pipe.send('Browser.getVersion');
 assert.equal(sent[0].sessionId,'page');assert.equal(sent[1].method,'Browser.getVersion');
 const bytes=Buffer.from(JSON.stringify({id:2,result:{name:'café ☃'}})+'\0'+JSON.stringify({method:'Runtime.exceptionThrown',sessionId:'page',params:{text:'probe'}})+'\0'+JSON.stringify({id:1,result:{value:17}})+'\0');
 const offset=bytes.indexOf(Buffer.from('☃'))+1;input.write(bytes.subarray(0,offset));input.write(bytes.subarray(offset));
 assert.deepEqual(await b,{name:'café ☃'});assert.deepEqual(await a,{value:17});assert.equal(events[0].method,'Runtime.exceptionThrown');assert.deepEqual(pipe.ownership(),{pendingCalls:0,pendingTimers:0,bufferedBytes:0});
});
test('CDP capacity, response errors and bounded deadlines settle ownership without consuming another call',async t=>{
 const {pipe,input}=harness(t,{maxPending:1,timeoutMs:10});const first=pipe.send('first');
 await assert.rejects(pipe.send('overflow'),/capacity/);input.write(JSON.stringify({id:1,error:{message:'deliberate fixture rejection'}})+'\0');await assert.rejects(first,/fixture rejection/);
 await assert.rejects(pipe.send('timeout'),/deadline/);input.write(JSON.stringify({id:2,result:{late:true}})+'\0');
 assert.deepEqual(pipe.ownership(),{pendingCalls:0,pendingTimers:0,bufferedBytes:0});
});
test('truncated shutdown and oversized messages reject pending work and drain buffers',async t=>{
 const {pipe,input}=harness(t,{maxBytes:128});const first=pipe.send('pending'),rejected=assert.rejects(first,/bound/);input.write(Buffer.alloc(129,0x61));await rejected;assert.equal(pipe.closed,true);assert.deepEqual(pipe.ownership(),{pendingCalls:0,pendingTimers:0,bufferedBytes:0});await assert.rejects(pipe.send('closed'),/closed/);
 const other=harness(t),pending=other.pipe.send('pending'),closed=assert.rejects(pending,/closed/);other.input.write('{"unfinished":');other.input.end();await closed;assert.deepEqual(other.pipe.ownership(),{pendingCalls:0,pendingTimers:0,bufferedBytes:0});
});
