const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const directory=path.resolve(__dirname,'../scripts/browser'),file=path.join(directory,'owned-player.cjs');
async function player(options={}){
 const callbacks=new Map();let cacheDisabled=false,route;
 const page={on(){},goto:async()=>{},evaluate:async()=>({})},context={newPage:async()=>page,on:(name,fn)=>callbacks.set(name,fn),route:async(_pattern,fn)=>{cacheDisabled=true;route=fn;}};
 const browser={newContext:async()=>context,version:()=> '156.0.8078.80',close:async()=>{}},web={listening:true,closeAllConnections(){},close(callback){this.listening=false;callback();}};
 const realRequire=createRequire(file),module={exports:{}};
 const requireMock=name=>name==='playwright'?{chromium:{launch:async()=>browser}}:name==='./owned-server.cjs'?{serve:async()=>({server:web,origin:'http://127.0.0.1:18080'})}:realRequire(name);
 vm.runInNewContext(await fs.readFile(file,'utf8'),{require:requireMock,module,__dirname:directory,URL,Date,process,setTimeout,clearTimeout,performance});
 const ui=await module.exports.open({url:'http://127.0.0.1:18081/manifest.mpd'},'hls',undefined,options);
 return{ui,callbacks,route,cacheDisabled};
}
test('ordinary owned playback audits external requests without installing cache-disabling interception',async()=>{
 const p=await player();try{
  assert.equal(p.cacheDisabled,false,'Playwright routing disables the HTTP cache and would bypass edge-cache tests');
  p.callbacks.get('request')({url:()=> 'http://127.0.0.1:18081/media'});assert.equal(p.ui.audit.length,0);
  p.callbacks.get('request')({url:()=> 'https://unexpected.example/media?token=private'});
  assert.equal(p.ui.audit[0].kind,'external');assert.doesNotMatch(JSON.stringify(p.ui.audit),/private/);assert.equal(p.ui.auditDropped(),0);
 }finally{await p.ui.close();}
});
test('explicit authentication clients retain scoped interception rather than changing ordinary cache behavior',async()=>{
 const p=await player({requestHeaders:()=>({Authorization:'fixture-auth'})});try{assert.equal(p.cacheDisabled,true);assert.equal(typeof p.route,'function');}finally{await p.ui.close();}
});
test('routing failures retain a blocking event without exporting authentication details from API errors',async()=>{
 const p=await player({requestHeaders:()=>{throw Error('Authorization: Bearer sensitive-fixture');}});
 try{
  await p.route({request:()=>({url:()=> 'http://127.0.0.1:18081/media',method:()=> 'GET',headers:()=>({})}),continue:async()=>{},abort:async()=>{}});
  assert.equal(p.ui.audit[0].kind,'route-error');assert.doesNotMatch(JSON.stringify(p.ui.audit),/sensitive-fixture|Bearer/);
 }finally{await p.ui.close();}
});
