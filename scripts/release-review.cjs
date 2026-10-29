// An owned clean clone, local tarball review and full rendered browser checks.
// Requires Gitleaks on PATH (or GITLEAKS_BIN), Chrome and the pinned Docker image.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const root=path.resolve(__dirname,'..'),args=process.argv.slice(2);
const capture=(command,params,cwd=root)=>execFileSync(command,params,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const npm=process.platform==='win32'?'npm.cmd':'npm';
async function main(){
  if(args.length!==2||args[0]!=='--output'||!args[1])throw Error('Use npm run release:review -- --output NEW_DIRECTORY');
  if(capture('git',['status','--porcelain']))throw Error('Candidate review requires a clean committed source tree');
  const scanner=process.env.GITLEAKS_BIN?path.resolve(root,process.env.GITLEAKS_BIN):'gitleaks',scannerVersion=capture(scanner,['version']);
  const directory=path.resolve(args[1]);await fs.mkdir(path.dirname(directory),{recursive:true});await fs.mkdir(directory,{mode:0o700});
  const checkout=path.join(directory,'checkout'),commit=capture('git',['rev-parse','HEAD']);
  const report={schemaVersion:1,recordedAt:new Date().toISOString(),commit,sourceTreeClean:true,scannerVersion,steps:[],candidateChecksPassed:false,releaseReady:false,
    outstanding:['Project source licensing/ownership approval','Historical media provenance review','Security-reporting activation/contact confirmation','Public visibility approval']};
  let active,interrupted=false;
  const stop=()=>{interrupted=true;if(active){try{process.platform==='win32'?active.kill('SIGTERM'):process.kill(-active.pid,'SIGTERM');}catch{}}};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  async function step(name,command,params,cwd=checkout,stdoutFile){
    if(interrupted)throw Error('Review interrupted');
    console.log('Review: '+name);const file=path.join(directory,name+'.log'),handle=await fs.open(file,'wx',0o600),began=Date.now();
    const output=stdoutFile?await fs.open(stdoutFile,'wx',0o600):undefined;
    let code;
    try{code=await new Promise((resolve,reject)=>{const child=spawn(command,params,{cwd,detached:process.platform!=='win32',stdio:['ignore',output?.fd??handle.fd,handle.fd]});active=child;child.once('error',reject);child.once('exit',resolve);});}
    finally{active=undefined;await handle.close();await output?.close();}
    report.steps.push({name,exitCode:code,durationMs:Date.now()-began});
    if(code!==0)throw Error(name+' failed; inspect its private log');
  }
  try{
    await step('clone','git',['clone','--no-hardlinks',root,checkout],root);
    assert.equal(capture('git',['rev-parse','HEAD'],checkout),commit);
    assert.equal(capture('git',['status','--porcelain'],checkout),'');
    await step('history-secrets',scanner,['git',checkout,'--log-opts=--all --full-history','--redact=100','--ignore-gitleaks-allow','--no-banner','--no-color','--report-format=json','--report-path='+path.join(directory,'history-secrets.json')]);
    report.history={commits:Number(capture('git',['rev-list','--count','--all'],checkout)),findings:JSON.parse(await fs.readFile(path.join(directory,'history-secrets.json'),'utf8')).length};
    assert.equal(report.history.findings,0);
    await step('install',npm,['ci','--ignore-scripts']);
    await step('build',npm,['run','build']);
    await step('docs',npm,['run','docs:check']);
    await step('notices',npm,['run','notices:check']);
    await step('types',npm,['run','typecheck']);
    await step('unit-tests',npm,['test']);
    await step('control-ui',npm,['run','test:ui']);
    await step('package-install',npm,['run','test:package']);
    await step('pack',npm,['pack','--json','--ignore-scripts','--pack-destination',directory],checkout,path.join(directory,'pack.json'));
    const [packed]=JSON.parse(await fs.readFile(path.join(directory,'pack.json'),'utf8'));
    assert.equal(JSON.parse(await fs.readFile(path.join(checkout,'package.json'),'utf8')).private,true);
    const files=packed.files.map(f=>f.path);
    assert.ok(!files.some(f=>/(?:^|\/)(?:\.git(?:\/|$)|\.env(?:\.|$)|auth[^/]*\.json$|\.hls-dash-|node_modules\/|output\/|\.github\/)/.test(f)));
    const packageDirectory=path.join(directory,'package-content');await fs.mkdir(packageDirectory,{mode:0o700});
    await step('extract','tar',['-xzf',path.join(directory,packed.filename),'-C',packageDirectory]);
    await step('package-secrets',scanner,['dir',packageDirectory,'--redact=100','--ignore-gitleaks-allow','--no-banner','--no-color','--report-format=json','--report-path='+path.join(directory,'package-secrets.json')]);
    report.package={filename:packed.filename,files:files.length,sha256:createHash('sha256').update(await fs.readFile(path.join(directory,packed.filename))).digest('hex'),findings:JSON.parse(await fs.readFile(path.join(directory,'package-secrets.json'),'utf8')).length};
    assert.equal(report.package.findings,0);
    await fs.writeFile(path.join(directory,'package-files.json'),JSON.stringify(files,null,2)+'\n',{mode:0o600});
    await step('dependency-audit',npm,['audit','--json'],checkout,path.join(directory,'dependency-audit.json'));
    report.vulnerabilities=JSON.parse(await fs.readFile(path.join(directory,'dependency-audit.json'),'utf8')).metadata.vulnerabilities;
    assert.equal(report.vulnerabilities.total,0);
    await step('browser-playback',process.execPath,['scripts/verify-browser.cjs','--output',path.join(directory,'browser')]);
    const browser=JSON.parse(await fs.readFile(path.join(directory,'browser/report.json'),'utf8'));
    assert.equal(browser.commit,commit);assert.equal(browser.workingTreeModified,false);assert.equal(browser.smoke,false);assert.equal(browser.browserGatesPassed,true);
    report.browser={commit:browser.commit,clean:!browser.workingTreeModified,browserGatesPassed:browser.browserGatesPassed,cases:browser.reports.map(r=>({protocol:r.protocol,test:r.test,passed:r.passed,releaseQualified:r.releaseQualified}))};
    assert.equal(capture('git',['status','--porcelain'],checkout),'');report.candidateChecksPassed=true;
  }catch(error){report.error=String(error.message);process.exitCode=1;}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
  console.log('Review '+(report.candidateChecksPassed?'PASS':'FAIL')+': '+path.join(directory,'report.json'));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
