const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
// Observational audit of the recovered prototype; does not modify source files.
// Build first, then run: node scripts/research-audit.cjs
const root = path.resolve(__dirname, '..');
const children = [], servers = [], proxies = [];
const info = console.info;
console.info = () => {};
const results = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function port() { const s=net.createServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p; }
async function ready(url) { for(let i=0;i<100;i++){try{if((await fetch(url)).ok)return;}catch{} await sleep(50);} throw Error('startup failed '+url); }
async function origin(handler) {const s=http.createServer(handler);servers.push(s);await new Promise(r=>s.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${s.address().port}`;}
async function cli(cwd,args){const p=spawn(process.execPath,[path.join(root,'dist/cli.js'),...args],{cwd});children.push(p);p.stdout.resume();p.stderr.resume();return p;}
function uri(text,base){return new URL(text.split(/\r?\n/).find(l=>l&&!l.startsWith('#')),base).href;}
function duration(text){return [...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((n,m)=>n+Number(m[1]),0);}
function hash(s){return crypto.createHash('sha256').update(s).digest('hex');}
async function run(){
 const cwd=await fsp.mkdtemp(path.join(os.tmpdir(),'hls-dash-research-'));const old=process.cwd();process.chdir(cwd);
 try {
 const cfg=path.join(cwd,'faults.json');fs.writeFileSync(cfg,JSON.stringify({segment:{missing:'off'}}));
 const hp=await port(),hbase=`http://127.0.0.1:${hp}`;
 await cli(cwd,['livesim','--port',String(hp),'--fault-config',cfg]);await ready(hbase+'/proxy.m3u8');
 const master=await(await fetch(hbase+'/proxy.m3u8')).text();const vurl=uri(master,hbase+'/proxy.m3u8');
 const video=await(await fetch(vurl)).text();const audio=await(await fetch(hbase+'/audio.m3u8')).text();
 const segments=[...new Set(video.split(/\r?\n/).filter(l=>l&&!l.startsWith('#')))];
 results.hls_sample={endlist:video.includes('#EXT-X-ENDLIST'),mediaSequence:video.match(/MEDIA-SEQUENCE:(\d+)/)?.[1],entries:(video.match(/#EXTINF/g)||[]).length,uniqueSegments:segments.length,videoDurationSeconds:duration(video),audioDurationSeconds:duration(audio),discontinuityTags:(video.match(/#EXT-X-DISCONTINUITY/g)||[]).length};
 fs.writeFileSync(cfg,JSON.stringify({segment:{missing:'once'}}));await sleep(100);
 results.once_scope=[];for(const u of [segments[0],segments[1],segments[0]])results.once_scope.push((await fetch(new URL(u,vurl))).status);
 fs.writeFileSync(cfg,JSON.stringify({segment:{missing:'off'}}));await sleep(100);
 const pp=await port();await cli(cwd,['low-latency-stream','--port',String(pp)]);await ready(`http://127.0.0.1:${pp}/proxy.m3u8`);
 const lowMaster=await(await fetch(`http://127.0.0.1:${pp}/proxy.m3u8`)).text();const lowVideo=await(await fetch(uri(lowMaster,`http://127.0.0.1:${pp}/proxy.m3u8`))).text();
 results.low_latency_template={masterIdentical:master===lowMaster,videoIdentical:video===lowVideo,containsPartialSegments:lowVideo.includes('#EXT-X-PART:')};
 const templateModule=require(path.join(root,'dist/support-tools/stream-templates.js'));
 let templateHits=0;
 const mpd='<?xml version="1.0"?><MPD type="dynamic" minimumUpdatePeriod="PT0.5S"><Period><AdaptationSet><SegmentTemplate timescale="1000" duration="2000"/><Representation id="v" bandwidth="1000000" codecs="avc1.4d401f" width="1280" height="720"/></AdaptationSet></Period></MPD>';
 let version=0;
 const o=await origin((req,res)=>{if(req.url==='/template.m3u8'){templateHits++;res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\ns.ts\n');}else if(req.url==='/manifest.mpd'){res.end(mpd);}else if(req.url==='/master.m3u8'){res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="a",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="a"\nvariant.m3u8?sig=demo\n');}else if(req.url.startsWith('/variant.m3u8')){res.end(`#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${++version}\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\ns.ts\n`);}else {res.setHeader('Content-Length','1024');res.end(Buffer.alloc(1024,1));}});
 const ht=await templateModule.createTemplateFromUrl({url:o+'/template.m3u8',name:'test'});results.hls_import={originRequests:templateHits,reportedDurationMs:ht.segmentDuration};
 const dt=await templateModule.createTemplateFromUrl({url:o+'/manifest.mpd',name:'test'});results.dash_import={expectedDurationMs:2000,actualDurationMs:dt.segmentDuration,contentType:dt.contentType};
 const {parseMPD}=require(path.join(root,'dist/support-tools/dash-sim-runner.js'));
 results.mpd_parser={fractionalMinimumUpdatePeriod:parseMPD(mpd,o+'/manifest.mpd').minimumUpdatePeriod,reorderedRepresentations:parseMPD(mpd.replace('id="v" bandwidth="1000000"','bandwidth="1000000" id="v"'),o+'/manifest.mpd').representations.length,parsedCodecs:parseMPD(mpd,o+'/manifest.mpd').representations[0]?.codecs||null};
 const rp=await port(),rbase=`http://127.0.0.1:${rp}`;const rcfg=path.join(cwd,'remote-faults.json');
 await cli(cwd,['livesim','--port',String(rp),'--manifest-url',o+'/master.m3u8','--no-dummy-content','--fault-config',rcfg,'--auth-token','audit-test-only']);await ready(rbase+'/proxy.m3u8');
 const remoteMaster=await(await fetch(rbase+'/proxy.m3u8')).text();
 results.proxy_rewrite={signedPlaylistUsesSegmentEndpoint:remoteMaster.includes('/seg?u='),audioUriUnchanged:remoteMaster.includes('URI="audio.m3u8"')};
 const nested=`${rbase}/pl?u=${encodeURIComponent(o+'/variant.m3u8?sig=demo')}`;
 const beforeFreeze=await(await fetch(nested)).text();fs.writeFileSync(rcfg,JSON.stringify({manifest:{freeze:'always'}}));await sleep(100);const afterFreeze=await(await fetch(nested)).text();
 results.hls_freeze={childPlaylistStillAdvances:beforeFreeze!==afterFreeze,initializationUriUnchanged:afterFreeze.includes('URI="init.mp4"')};
 let receivedAuth;const other=await origin((req,res)=>{receivedAuth=req.headers.authorization;res.end('audit-only');});await fetch(`${rbase}/seg?u=${encodeURIComponent(other+'/segment.ts')}`);
 results.proxy_target_scope={differentOriginReceivedConfiguredTestToken:receivedAuth==='Bearer audit-test-only'};
 const {setFaultConfigPath,applyConfigOverride}=require(path.join(root,'dist/support-tools/live-stream-fault-config.js'));
 const {startDashFaultProxy}=require(path.join(root,'dist/support-tools/dash-fault-proxy.js'));
 setFaultConfigPath(path.join(cwd,'dash-faults.json'));let counter=0;
 const upstream=await origin((req,res)=>{if(req.url.endsWith('.mpd'))res.end(`<MPD id="${++counter}"/>`);else {res.setHeader('Content-Length','1024');res.end(Buffer.alloc(1024,1));}});
 const dp=await port();proxies.push(await startDashFaultProxy({listenPort:dp,upstreamPort:Number(new URL(upstream).port)}));const db=`http://127.0.0.1:${dp}`;
 const first=await(await fetch(db+'/stream.mpd')).text(),second=await(await fetch(db+'/stream.mpd')).text();applyConfigOverride({manifest:{freeze:'always'}});const frozen=await(await fetch(db+'/stream.mpd')).text();
 results.dash_freeze={first,second,frozen,freezesFirstInsteadOfLatest:frozen===first&&frozen!==second};
 results.dash_browser_headers={allowOrigin:(await fetch(db+'/seg.m4s')).headers.get('access-control-allow-origin'),preflightStatus:(await fetch(db+'/seg.m4s',{method:'OPTIONS'})).status};
 applyConfigOverride({manifest:{freeze:'off'},segment:{malformed:'always'}});
 try{const r=await fetch(db+'/seg.m4s',{signal:AbortSignal.timeout(1200)});await r.arrayBuffer();results.dash_corruption={completed:true};}catch(e){results.dash_corruption={completed:false,error:e.name,cause:e.cause?.code||null};}
 applyConfigOverride({segment:{malformed:'off'},drm:{licenseFailure:'always',keyRotationMismatch:'always'}});results.dash_drm={segmentStatus:(await fetch(db+'/seg.m4s')).status};
 const preservePort=await port();proxies.push(await startDashFaultProxy({listenPort:preservePort,upstreamPort:Number(new URL(upstream).port),preserve:{manifest:'<MPD/>',aliasMap:{'1':{type:'video',originalId:'1',representationId:'1',initializationPath:'/init.mp4',mediaTemplate:'/segment-$Number$.m4s',startNumber:1,replacements:{}}}}}));
 results.dash_preserved_paths={generatorStyleStatus:(await fetch(`http://127.0.0.1:${preservePort}/__dash__/1/1.m4s`)).status,handlerStyleStatus:(await fetch(`http://127.0.0.1:${preservePort}/__dash__/1/segment-1.m4s`)).status};
 const up=await port();await cli(cwd,['fault-control','--port',String(up),'--fault-config',path.join(cwd,'ui.json')]);await ready(`http://127.0.0.1:${up}/config`);const invalid=await fetch(`http://127.0.0.1:${up}/config`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({segment:{missing:'typo',latencyMs:-100},unexpected:true})});results.config_validation={invalidAcceptedStatus:invalid.status};
 // Wait longer than the generated target duration, without requiring a player.
 await sleep(11500);const later=await(await fetch(vurl)).text();results.hls_sample.unchangedAfterTargetDuration=hash(video)===hash(later);
 } finally { for(const p of children)if(p.exitCode===null){const closed=new Promise(r=>p.once('close',r));p.kill();await closed;}for(const p of proxies)await p.close();for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}process.chdir(old);await fsp.rm(cwd,{recursive:true,force:true}); }
 console.info=info;console.log(JSON.stringify(results,null,2));
}
run().catch(e=>{console.info=info;console.error(e);process.exitCode=1;});
