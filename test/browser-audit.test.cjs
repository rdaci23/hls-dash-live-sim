const{test}=require('node:test'),assert=require('node:assert/strict'),{create}=require('../scripts/browser/audit.cjs');
test('browser audit retains timestamp, scenario context and full exception stack',()=>{
 const audit=create({now:()=>1234,context:()=>({scenarioElapsedMs:35000,closing:false})});
 audit.record({kind:'pageerror',message:'callback failed',stack:'TypeError: callback failed\n at onManifestUpdated (http://127.0.0.1/player.js:1422:1)'});
 assert.equal(audit.events[0].epochMs,1234);assert.equal(audit.events[0].scenarioElapsedMs,35000);assert.match(audit.events[0].stack,/onManifestUpdated/);assert.equal(audit.dropped(),0);
});
test('audit overflow or text truncation is explicit and cannot look like complete evidence',()=>{
 const audit=create({limit:1});audit.record({kind:'pageerror',stack:'x'.repeat(20000)});audit.record({kind:'external'});
 assert.equal(audit.events.length,1);assert.equal(audit.events[0].stack.length,16384);assert.equal(audit.dropped(),2);
 const missing=create({context:()=>{throw Error('closed');}});missing.record({kind:'pageerror'});assert.equal(missing.dropped(),1);assert.equal(missing.events[0].contextUnavailable,true);
});
test('audit removes URL credentials, query tokens and fragments from locations and messages',()=>{
 const audit=create();audit.record({kind:'console',url:'http://u:p@127.0.0.1/media?token=private#secret',location:{url:'http://127.0.0.1/player.js?key=private',lineNumber:4},message:'Failed at http://u:p@127.0.0.1/media?token=private',stack:'at callback (http://127.0.0.1/player.js?key=private)'});
 assert.doesNotMatch(JSON.stringify(audit.events),/private|secret|u:p/);assert.equal(audit.events[0].url,'http://127.0.0.1/media');assert.equal(audit.events[0].location.lineNumber,4);assert.equal(audit.dropped(),0);
});
