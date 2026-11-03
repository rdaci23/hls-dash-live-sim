const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {snapshot}=require('../scripts/publication-scenarios/verify.cjs');
test('publication wire snapshots reject invalid XML before permissive timeline parsing',async t=>{
 let body='<MPD type="dynamic"><Period><AdaptationSet segmentAlignment></AdaptationSet></Period></MPD>';
 const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/dash+xml');res.end(body);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const session={url:'http://127.0.0.1:'+server.address().port+'/manifest.mpd'};
 await assert.rejects(snapshot(session,'dash'),/well-formed XML/);
 body=body.replace('segmentAlignment>','segmentAlignment="true">');
 const valid=await snapshot(session,'dash');assert.equal(valid.root.status,200);assert.equal(valid.root.body.toString(),body);
});
