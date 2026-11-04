const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFile}=require('node:fs/promises');
const path=require('node:path');
for(const verifier of ['verify-track-browser.cjs','verify-lifecycle-browser.cjs'])for(const protocol of ['hls','dash'])test(verifier+' '+protocol+' serves every script required by its actual player page',async t=>{
 const {servePlayer}=require('../scripts/'+verifier),session={url:'http://127.0.0.1:12345/owned-manifest'},web=await servePlayer(session,protocol);
 t.after(async()=>{web.server.closeAllConnections();await new Promise(resolve=>web.server.close(resolve));});
 const response=await fetch(web.origin),html=await response.text();assert.equal(response.status,200);
 const scripts=[...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m=>m[1]);
 assert.ok(scripts.includes('/hls-causality.js')&&scripts.includes('/dash-causality.js'));
 for(const route of scripts){const asset=await fetch(web.origin+route);assert.equal(asset.status,200,route);assert.match(asset.headers.get('content-type'),/^text\/javascript/);const bytes=Buffer.from(await asset.arrayBuffer());assert.ok(bytes.length>0);if(route!=='/player.js')assert.deepEqual(bytes,await readFile(path.join(__dirname,'../scripts/track-browser',route.slice(1))));}
 const config=await(await fetch(web.origin+'/config')).json();assert.equal(config.protocol,protocol);assert.equal(config.url,session.url);
});
