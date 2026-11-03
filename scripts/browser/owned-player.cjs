const path=require('node:path'),{serve}=require('./owned-server.cjs'),{create:createAudit}=require('./audit.cjs');const{chromium}=require('playwright');const root=path.resolve(__dirname,'../..'),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function open(session,protocol,signal,options={}){let browser,page,browserServer,browserProcess,closing=false;
 const capture=createAudit({context:()=>({closing,scenarioElapsedMs:session.scenario?.report().elapsedMs})}),audit=capture.events;
 const {server:web,origin}=await serve(session,protocol,options),allowed=[origin,new URL(session.url).origin];
 const close=async()=>{closing=true;try{await browser?.close();}finally{try{await browserServer?.close();}finally{web.closeAllConnections();await new Promise(r=>web.close(r));}}};
 try{if(options.captureProcess){browserServer=await chromium.launchServer({channel:'chrome',headless:true,chromiumSandbox:true,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false});browserProcess=browserServer.process();browser=await chromium.connect(browserServer.wsEndpoint());}else browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false});const context=await browser.newContext();page=await context.newPage();if(options.onResponse)page.on('response',options.onResponse);page.on('pageerror',e=>capture.record({kind:'pageerror',message:e.message,stack:e.stack}));page.on('crash',()=>capture.record({kind:'crash'}));page.on('console',e=>{if(e.type()==='error')capture.record({kind:'console',level:'error',message:e.text(),location:e.location()});});await context.route('**/*',async route=>{try{
 const sessionOrigin=new URL(route.request().url()).origin===new URL(session.url).origin;
 if(!allowed.includes(new URL(route.request().url()).origin)){capture.record({kind:'external',url:route.request().url()});await route.abort();return;}
 const headers=()=>({...route.request().headers(),...(sessionOrigin?options.requestHeaders?.():{})});
 if(sessionOrigin&&options.retryUnauthorized&&route.request().method()==='GET'){
  let response=await route.fetch({headers:headers(),timeout:6000,maxRedirects:0});
  if(response.status()===401){await options.retryUnauthorized({requestId:response.headers()['x-sim-request-id']});response=await route.fetch({headers:headers(),timeout:6000,maxRedirects:0});}
  await route.fulfill({response});
 }else await route.continue({headers:headers()});
 }catch(error){if(!closing)capture.record({kind:'route-error',message:error.message});try{await route.abort();}catch{}}});await page.goto(origin);
 const snapshot=()=>page.evaluate(()=>window.trackSnapshot?.()),wait=async(predicate,timeout,label)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){signal?.throwIfAborted();const m=await snapshot();if(m&&predicate(m))return m;await pause(100);}throw Error(label+' timed out');};
 return{page,audit,auditDropped:capture.dropped,browserVersion:browser.version(),playerVersion:require(path.join(root,'node_modules',protocol==='hls'?'hls.js/package.json':'dashjs/package.json')).version,snapshot,wait,close,processOwnership:()=>({pid:browserProcess?.pid,webServerClosed:!web.listening,exited:browserProcess?browserProcess.exitCode!==null||browserProcess.signalCode!==null:undefined})};}catch(e){await close();throw e;}}
module.exports={open};
