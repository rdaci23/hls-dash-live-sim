const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {timeline}=require('../scripts/endurance/workload.cjs'),{SharedBandwidthLimiter}=require('../dist/support-tools/bandwidth-limiter.js'),{read}=require('../scripts/transport-scenarios/verify.cjs');
// An in-flight response crosses the nominal measurement boundary while the
// coordinator is still closing viewers. A profile reset must not turn it into
// a complete unlimited response before the client's cancellation can execute.
test('endurance cap survives the measurement boundary until owned transfers close',async t=>{
 const duration=50,phases=timeline(duration),rateAt=now=>phases.find(p=>p.afterMs<=now&&now<p.beforeMs)?.network.bandwidthKbps??0;
 const limiter=new SharedBandwidthLimiter(rateAt(0)),bytes=Buffer.alloc(32768,7),controller=new AbortController();let release,entered;
 const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r),work=new Set();
 const server=http.createServer((req,res)=>{const action=(async()=>{entered();await gate;controller.signal.throwIfAborted();res.writeHead(200,{'Content-Length':bytes.length});await limiter.write(res,bytes,controller.signal);res.end();})();work.add(action);action.catch(()=>res.destroy()).finally(()=>work.delete(action));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{controller.abort();release();limiter.setRate(0);server.closeAllConnections();await Promise.allSettled(work);await new Promise(r=>server.close(r));});
 const request=read('http://127.0.0.1:'+server.address().port,{cancelAfterBytes:128,timeoutMs:3000});await ready;
 limiter.setRate(rateAt(duration+100));release();
 const result=await request;assert.equal(result.status,200);assert.equal(result.clientCancelled,true);assert.equal(result.complete,false,'pending cancellation must not become unlimited at measurement end');assert.ok(result.bytes.length<bytes.length);assert.equal(rateAt(duration+100),3000);
});
test('shutdown grace preserves smoke/release fairness windows and stays bounded',()=>{
 for(const duration of [30000,600000,14400000]){const phases=timeline(duration),restricted=phases.filter(p=>p.network.bandwidthKbps===1200);assert.equal(restricted.length,Array.from({length:24},(_,n)=>60000+n*600000).filter(at=>at<duration-15000).length);const end=phases.at(-1).beforeMs;assert.ok(end>duration+30000);assert.ok(end<=duration+120000);for(let n=1;n<phases.length;n++)assert.equal(phases[n-1].beforeMs,phases[n].afterMs);}
});
