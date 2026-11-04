const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {serve}=require('../scripts/browser/owned-server.cjs');
function read(url){return new Promise((resolve,reject)=>{http.get(url,{agent:false},res=>{const parts=[];res.on('data',part=>parts.push(part));res.once('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts).toString()}));res.once('error',reject);}).once('error',reject);});}
async function owned(t,options){const web=await serve({url:'http://127.0.0.1:12345/live.m3u8'},'hls',options);t.after(async()=>{web.server.closeAllConnections();await new Promise(resolve=>web.server.close(resolve));});return web.origin;}
test('owned player server exposes only fixed assets and keeps redirect probes opt-in',async t=>{
 const origin=await owned(t),page=await read(origin);
 assert.equal(page.status,200);assert.equal(page.headers['cache-control'],'no-store');assert.match(page.headers['content-security-policy'],/connect-src 'self' http:\/\/127\.0\.0\.1:12345;/);
 const config=await read(origin+'/config');assert.deepEqual(JSON.parse(config.body),{protocol:'hls',url:'http://127.0.0.1:12345/live.m3u8',markerProbe:false,causalProbe:false,seekProbe:false});
 for(const route of ['/hls-causality.js','/dash-causality.js'])assert.equal((await read(origin+route)).status,200,route);
 for(const route of ['/redirect-probe','/constructor','/__proto__','/package.json','/%2e%2e/package.json'])assert.equal((await read(origin+route)).status,404,route);
});
test('owned redirect probe emits a real 302 without fetching its target and rejects non-loopback destinations',async t=>{
 let hits=0;const sentinel=http.createServer((req,res)=>{hits++;res.end('probe');});await new Promise(resolve=>sentinel.listen(0,'127.0.0.1',resolve));t.after(async()=>{sentinel.closeAllConnections();await new Promise(resolve=>sentinel.close(resolve));});
 const target='http://127.0.0.1:'+sentinel.address().port+'/owned',origin=await owned(t,{redirectProbe:target}),response=await read(origin+'/redirect-probe');
 assert.equal(response.status,302);assert.equal(response.headers.location,target);assert.equal(response.body,'');assert.equal(hits,0);
 for(const target of ['https://127.0.0.1/','http://example.invalid/','http://127.0.0.1.example.invalid/','http://user:secret@127.0.0.1/','file:///tmp/probe','http://127.0.0.1/'+ 'x'.repeat(2048)])await assert.rejects(serve({url:'http://127.0.0.1/'},'hls',{redirectProbe:target}),/owned loopback/);
 await assert.rejects(serve({url:'http://127.0.0.1/'},'unsupported'),/Unsupported/);
});

test('DVR seek observation is explicitly opt-in on the owned page',async t=>{
 const origin=await owned(t,{seekProbe:true});const config=JSON.parse((await read(origin+'/config')).body);assert.equal(config.seekProbe,true);assert.equal(config.causalProbe,false);
});
