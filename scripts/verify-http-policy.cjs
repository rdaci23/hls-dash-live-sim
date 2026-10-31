const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createOrigin } = require('./resource-scenarios/origin.cjs');
const { definition, verify } = require('./http-policy/verify.cjs');
const { startHlsim } = require('../dist/support-tools/hls-sim-runner.js');
const { startLivesim2, DEFAULT_IMAGE } = require('../dist/support-tools/dash-sim-runner.js');
const root = path.resolve(__dirname, '..');
async function port() { const s = http.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p; }
async function main() {
  const args = require('yargs/yargs')(process.argv.slice(2)).option('protocol', { choices: ['hls','dash','both'], default: 'both' }).option('output', { type: 'string', default: 'output/http-policy-' + Date.now() }).strict().parseSync();
  const directory = path.resolve(args.output); await fs.mkdir(path.dirname(directory), { recursive: true }); await fs.mkdir(directory, { mode: 0o700 });
  const report = { schemaVersion: 1, commit: execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(), workingTreeModified: !!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(), recordedAt: new Date().toISOString(), engineImage: DEFAULT_IMAGE, scope: 'HTTP policy simulator behavior; CDN actions and browser qualification are separate', passed:false, allCasesVerified:false, releaseReady:false, checks:[] };
  const abort = new AbortController(); let session, origin;
  const stop = () => { abort.abort(); session?.close().catch(()=>{}); origin?.close().catch(()=>{}); }; process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    for (const protocol of args.protocol === 'both' ? ['hls','dash'] : [args.protocol]) for (const resource of ['manifest','init','media']) {
      abort.signal.throwIfAborted(); const caseId=protocol+'-'+resource, caseDirectory=path.join(directory,caseId); await fs.mkdir(caseDirectory,{mode:0o700});
      const scenarioFile=path.join(caseDirectory,'scenario.json'); await fs.writeFile(scenarioFile,JSON.stringify(definition(resource),null,2)+'\n',{mode:0o600});
      try {
        const options={ port:await port(), scenarioFile, faultConfigPath:path.join(caseDirectory,'faults.json'), diagnosticsFile:path.join(caseDirectory,'requests.jsonl'),signal:abort.signal };
        if(protocol==='hls') { if(resource==='init')origin=await createOrigin(); session=await startHlsim({...options,...(origin?{manifestUrl:origin.url+'/master.m3u8',dummyContent:false}:{})}); }
        else session=await startLivesim2({...options,asset:'abr',noPull:true,periodsPerHour:1});
        const result=await verify(session,protocol,resource); report.checks.push(result); await fs.writeFile(path.join(caseDirectory,'report.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600}); console.log(caseId+' HTTP policy PASS');
      } finally { await session?.close(); session=undefined; await origin?.close(); origin=undefined; }
    }
    abort.signal.throwIfAborted();report.passed=true;report.allCasesVerified=args.protocol==='both';
  } catch(error) {report.error=error.message;process.exitCode=1;}
  finally { process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600}); }
  console.log('HTTP policy '+(report.passed?'PASS':'FAIL')+': '+path.join(directory,'report.json'));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
