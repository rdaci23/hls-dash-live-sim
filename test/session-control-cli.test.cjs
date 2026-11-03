const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const value=server.address().port;await new Promise(r=>server.close(r));return value;}
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(r=>child.once('close',r));child.kill('SIGTERM');let timer;try{await Promise.race([done,new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Owned CLI failed to close'));},5000);})]);}finally{clearTimeout(timer);}}
async function ready(child,url){for(let n=0;n<150;n++){if(child.exitCode!==null)throw Error('Owned CLI exited early');try{const r=await fetch(url,{signal:AbortSignal.timeout(500)});if(r.ok)return await r.json();}catch{}await pause(30);}throw Error('Owned CLI did not become ready');}
for(const protocol of ['hls','dash'])test(`${protocol}: streaming CLI forwards its explicit simulator token without an environment token`,{timeout:20000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'session-cli-')),p=await port(),token='owned-cli-session-token-123456';
 const child=spawn(process.execPath,[path.join(root,'dist/cli.js'),'livesim','start','--sim-type',protocol,'--fixture','tracks','--port',String(p),'--fault-config',path.join(directory,'faults.json'),'--control-token',token],{cwd:directory,env:{...process.env,HLS_DASH_CONTROL_TOKEN:''},stdio:'ignore'});
 t.after(async()=>{await stop(child);await fs.rm(directory,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+p,status=await ready(child,origin+'/session-control');assert.equal(status.available,true);assert.equal(status.authenticated,false);assert.equal(status.controlled,false);
 const headers={'Content-Type':'application/json',Authorization:'Bearer '+token,'X-Sim-Session-Id':status.sessionId};
 const response=await fetch(origin+'/session-control/mode',{method:'POST',headers,body:JSON.stringify({revision:status.revision,mode:'manual'})});assert.equal(response.status,200);const controlled=await response.json();assert.equal(controlled.mode,'manual');assert.equal(controlled.controlled,true);
 const preview=await fetch(origin+(protocol==='hls'?'/proxy.m3u8':'/dash/manifest.mpd'),{headers:{'X-Sim-Manifest-Preview':'baseline-v1'}});assert.equal(preview.status,200);assert.equal(preview.headers.get('x-sim-manifest-preview'),'baseline-v1');assert.ok((await preview.text()).length);
 await stop(child);assert.equal(child.exitCode,0);
});
test('public UI bootstrap exposes only local host discovery; legacy controller APIs stay protected',{timeout:15000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'control-bootstrap-')),p=await port(),token='owned-legacy-control-token-123456';
 const child=spawn(process.execPath,[path.join(root,'dist/cli.js'),'fault-control','--port',String(p),'--fault-config',path.join(directory,'faults.json'),'--control-token',token],{cwd:directory,env:{...process.env,HLS_DASH_CONTROL_TOKEN:''},stdio:'ignore'});
 t.after(async()=>{await stop(child);await fs.rm(directory,{recursive:true,force:true});});const origin='http://127.0.0.1:'+p,bootstrap=await ready(child,origin+'/ui-info');
 assert.deepEqual(Object.keys(bootstrap),['manifestHosts']);assert.ok(bootstrap.manifestHosts.includes('127.0.0.1'));assert.ok(!JSON.stringify(bootstrap).includes(directory));assert.ok(!JSON.stringify(bootstrap).includes(token));
 assert.equal((await fetch(origin+'/config')).status,401);assert.equal((await fetch(origin+'/ui-info',{headers:{Origin:'https://example.invalid'}})).status,403);
 const legacy=await fetch(origin+'/config',{headers:{Authorization:'Bearer '+token}});assert.equal(legacy.status,200);assert.equal((await legacy.json()).path,path.join(directory,'faults.json'));
 assert.equal((await fetch(origin+'/legacy-control.js')).status,200);
});
