const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const config=require('../dist/support-tools/live-stream-fault-config.js');
const runtime=require('../dist/support-tools/fault-runtime.js');
const {startHlsim}=require('../dist/support-tools/hls-sim-runner.js');
const {startDashFaultProxy}=require('../dist/support-tools/dash-fault-proxy.js');
const {TrackFixturePublisher}=require('../dist/support-tools/track-fixture.js');
const {variantEntries,attributes}=require('../dist/support-tools/hls-playlist.js');
const TOKEN='boundary-tests-control-token',PREVIEW={'X-Sim-Manifest-Preview':'baseline-v1'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
async function bounded(promise,label,timeoutMs=5000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(label+' timed out')),timeoutMs))]);}finally{clearTimeout(timer);}}
function request(url,{method='GET',headers={},body}={}){
 return new Promise((resolve,reject)=>{
  let settled=false;const chunks=[];
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const req=http.request(url,{method,headers,agent:false},res=>{res.on('data',chunk=>chunks.push(chunk));res.once('end',()=>finish(undefined,{status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));res.once('error',error=>finish(error));res.once('close',()=>{if(!res.complete)finish(Error('Incomplete owned HTTP response'));});});
  const timer=setTimeout(()=>{req.destroy();finish(Error('Owned HTTP request timed out'));},5000);
  req.once('error',error=>finish(error));req.end(body);
 });
}
async function read(url,options){const response=await request(url,options);assert.equal(response.status,200,response.body.toString());return response;}
async function state(session){return JSON.parse((await read(new URL('/session-control',session.url))).body);}
async function change(session,current,action,body={}){
 const response=await request(new URL('/session-control/'+action,session.url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN,'X-Sim-Session-Id':current.sessionId},body:JSON.stringify({revision:current.revision,...body})});
 assert.equal(response.status,200,response.body.toString());return JSON.parse(response.body);
}
function drained(session){for(const name of ['networkOwnership','resourceOwnership'])if(session[name])assert.ok(Object.values(session[name]()).every(value=>value===0),name+' did not drain: '+JSON.stringify(session[name]()));}

test('HLS: an older healthy key response cannot rearm a later consumed Once mismatch',{timeout:15000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'scoped-key-boundary-'));
 const publisher=new TrackFixturePublisher('live',2,undefined,undefined,6,{protocol:'hls',aes:true}),origin=await publisher.start();
 let session,holdNext=false;const held=deferred(),released=deferred();
 const server=http.createServer(async(req,res)=>{
  try{
   if(req.url.startsWith('/keys/')&&holdNext){holdNext=false;held.resolve();await released.promise;}
   const remote=await request(new URL(req.url,origin.url),{method:req.method});
   res.writeHead(remote.status,remote.headers);res.end(req.method==='HEAD'?undefined:remote.body);
  }catch{res.destroy();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{released.resolve();try{await session?.close();if(session)drained(session);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await origin.close();await fs.rm(directory,{recursive:true,force:true});}});
 session=await startHlsim({port:await port(),faultConfigPath:path.join(directory,'faults.json'),manifestUrl:'http://127.0.0.1:'+server.address().port+'/hls/master.m3u8',controlToken:TOKEN});
 const master=await read(session.url,{headers:PREVIEW}),playlistUrl=new URL(variantEntries(master.body.toString())[0].uri,session.url),playlist=await read(playlistUrl,{headers:PREVIEW});
 const advertised=playlist.body.toString().split('\n').filter(line=>line.startsWith('#EXT-X-KEY:')).map(attributes).find(value=>value.METHOD==='AES-128');
 assert.ok(advertised?.URI,'owned fixture advertises a real encrypted-media key');
 const keyUrl=new URL(advertised.URI,playlistUrl),original=(await read(keyUrl)).body;assert.equal(original.length,16);assert.notDeepEqual(original,Buffer.alloc(16,0xff));
 let current=await change(session,await state(session),'mode',{mode:'manual'});
 holdNext=true;const older=request(keyUrl);await bounded(held.promise,'older key origin hold');
 current=await change(session,current,'inject',{type:'drm.keyRotationMismatch'});
 const corrupted=await read(keyUrl);assert.deepEqual(corrupted.body,Buffer.alloc(16,0xff));assert.ok(corrupted.headers['x-sim-fault-ids']);
 assert.deepEqual((await read(keyUrl)).body,original,'Once is consumed before the older request completes');
 released.resolve();assert.deepEqual((await older).body,original,'the request begun while faults were off remains healthy');
 assert.deepEqual((await read(keyUrl)).body,original,'late off-state completion must not rearm the consumed mismatch');
 const applied=()=>session.diagnostics.snapshot().events.filter(event=>event.event==='fault.applied'&&event.fault==='hls.keyMismatch');
 assert.equal(applied().length,1);assert.equal(applied()[0].requestId,corrupted.headers['x-sim-request-id']);
 current=await change(session,current,'inject',{type:'drm.keyRotationMismatch'});
 assert.deepEqual((await read(keyUrl)).body,Buffer.alloc(16,0xff),'explicit Inject still rearms the same key fault');
 assert.deepEqual((await read(keyUrl)).body,original);assert.equal(applied().length,2);assert.notEqual(applied()[0].faultId,applied()[1].faultId);
});

for(const protocol of ['hls','dash'])test(protocol+': occupied diagnostics output closes the newly subscribed config source',{timeout:10000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'scoped-constructor-boundary-')),file=path.join(directory,'faults.json'),occupied=path.join(directory,'occupied.jsonl');await fs.writeFile(occupied,'owned existing evidence\n');
 const Base=config.SessionFaultConfigSource,created=[],closed=new Set();
 config.SessionFaultConfigSource=class extends Base{constructor(...args){super(...args);created.push(this);}close(){closed.add(this);return super.close();}};
 try{
  config.setFaultConfigPath(file);
  const options={controlToken:TOKEN,diagnosticsFile:occupied};
  await assert.rejects(protocol==='hls'?startHlsim({...options,port:await port(),faultConfigPath:file}):startDashFaultProxy({...options,listenPort:await port(),upstreamPort:await port()}),/diagnostic/i);
  assert.equal(created.length,1,'the adapter created exactly one source');assert.equal(closed.size,1,'failed construction must unsubscribe the source');
  assert.equal(await fs.readFile(occupied,'utf8'),'owned existing evidence\n','existing diagnostics are never replaced');
 }finally{config.SessionFaultConfigSource=Base;for(const source of created)source.close();await fs.rm(directory,{recursive:true,force:true});}
});

for(const protocol of ['hls','dash'])test(protocol+': shutdown closes a runtime replaced by an already accepted control mutation',{timeout:10000},async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'scoped-shutdown-boundary-')),file=path.join(directory,'faults.json');
 const Base=runtime.FaultRuntime,created=[],closed=new Set();let session,shutdown,onClose,shutdownStartedAt;
 runtime.FaultRuntime=class extends Base{
  constructor(...args){super(...args);created.push(this);}
  close(){closed.add(this);super.close();if(onClose){const callback=onClose;onClose=undefined;callback();}}
 };
 try{
  config.setFaultConfigPath(file);const p=await port();
  session=protocol==='hls'?await startHlsim({port:p,faultConfigPath:file,controlToken:TOKEN}):await startDashFaultProxy({listenPort:p,upstreamPort:await port(),controlToken:TOKEN});
  if(!session.url)session.url='http://127.0.0.1:'+p+'/manifest.mpd';
  const current=await state(session);
  // Start shutdown inside the accepted mode change's retirement callback. Its
  // awaited cancellation then resumes while server shutdown drains that handler.
  onClose=()=>{shutdownStartedAt=created.length;shutdown=session.close();};
  const mutation=change(session,current,'mode',{mode:'manual'}).then(value=>({value}),error=>({error}));
  for(let i=0;i<100&&!shutdown;i++)await pause(5);
  assert.ok(shutdown,'the HTTP mutation entered its runtime retirement phase');
  await bounded(Promise.all([shutdown,mutation]),'concurrent mutation and shutdown');
  assert.ok(created.length>shutdownStartedAt,'the accepted action replaced a runtime after shutdown started');
  assert.equal(closed.size,created.length,'shutdown must close the final runtime as well as its predecessor');drained(session);
 }finally{onClose=undefined;await session?.close();for(const instance of created)instance.close();runtime.FaultRuntime=Base;await fs.rm(directory,{recursive:true,force:true});}
});
