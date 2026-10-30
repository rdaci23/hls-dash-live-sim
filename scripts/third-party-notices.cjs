// Collect verbatim notices from locked npm packages. Never invent copyright text.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'third-party');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inventoryFile = path.join(target, 'npm-manifest.json');
const entries = Object.entries(lock.packages).filter(([location]) => location).sort(([a],[b])=>a.localeCompare(b));
function identity(location, pkg) { return { location, name: location.split('node_modules/').at(-1), version: pkg.version, license: pkg.license, integrity: pkg.integrity, scope: pkg.dev ? 'development' : 'runtime' }; }
const overrides = {
  '@nodable/entities@3.1.0': { path: 'sources/nodable-entities-3.1.0-LICENSE.txt', source: 'https://raw.githubusercontent.com/nodable/val-parsers/ac48e7ea591da372be023a481875c747535812b3/LICENSE', evidence: 'upstream-license-at-npm-gitHead' },
};
function listNotices(directory) {
  const found=[];
  for(const item of fs.readdirSync(directory,{withFileTypes:true})) {
    if (!/licen[sc]e|notice|copying|copyright/i.test(item.name)) continue;
    if(item.isSymbolicLink()) throw Error('Refusing a symlink notice');
    if(item.isFile()) found.push(item.name);
    else if(item.isDirectory()) for(const file of fs.readdirSync(path.join(directory,item.name),{withFileTypes:true})) if(file.isFile()) found.push(path.join(item.name,file.name));
  }
  return found.sort();
}
function generate() {
  fs.mkdirSync(path.join(target,'licenses'),{recursive:true});
  const previous=fs.existsSync(inventoryFile)?JSON.parse(fs.readFileSync(inventoryFile,'utf8')).packages:[];
  const packages=entries.map(([location,pkg])=>{
    const base=identity(location,pkg), directory=path.join(root,location), key=base.name+'@'+base.version;
    if(!fs.existsSync(path.join(directory,'package.json'))){
      const existing=previous.find(p=>p.location===location&&p.version===base.version&&p.integrity===base.integrity&&p.license===base.license&&p.scope===base.scope);
      if(!existing)throw Error('Missing optional package notices: '+key+'; collect them on its supported platform before regenerating');
      for(const item of existing.notices)assert.equal(hash(fs.readFileSync(path.join(root,item.path))),item.sha256);
      return existing;
    }
    const files=listNotices(directory);
    if(key==='pako@1.0.11')files.push('lib/zlib/README');
    let evidence='published-package-notice';const notices=[];
    const safe=base.name.replace(/[^a-zA-Z0-9_.-]/g,'_')+'-'+base.version+'-'+hash(location).slice(0,8);
    const destination=path.join(target,'licenses',safe);fs.mkdirSync(destination,{recursive:true});
    for(const relative of files){
      const bytes=fs.readFileSync(path.join(directory,relative));if(bytes.length>2*1024*1024)throw Error('Unexpectedly large notice: '+key);
      const name=relative.replace(/[^a-zA-Z0-9_.-]/g,'_')+'.txt';const out=path.join(destination,name);fs.writeFileSync(out,bytes);
      notices.push({path:path.relative(root,out).split(path.sep).join('/'),sha256:hash(bytes),source:relative});
    }
    if(!notices.length){
      const readmeName=fs.readdirSync(directory).find(f=>/^readme(?:\.md)?$/i.test(f));
      const readme=readmeName?fs.readFileSync(path.join(directory,readmeName),'utf8'):'';
      const start=readme.search(/^##?\s+Licen[sc]e\s*$/im);
      if(start>=0&&/Permission is hereby granted/i.test(readme.slice(start))){
        const text=readme.slice(start),out=path.join(destination,'README-license.txt');fs.writeFileSync(out,text);
        notices.push({path:path.relative(root,out).split(path.sep).join('/'),sha256:hash(text),source:readmeName+' license section'});evidence='published-readme-license';
      }else if(overrides[key]){
        const item=overrides[key],relative='third-party/'+item.path,bytes=fs.readFileSync(path.join(root,relative));
        notices.push({path:relative,sha256:hash(bytes),source:item.source});evidence=item.evidence;
      }else if(key==='require-relative@0.8.7'){
        const source=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
        const text=JSON.stringify({name:source.name,version:source.version,author:source.author,license:source.license,repository:source.repository},null,2)+'\n';
        const out=path.join(destination,'published-license-declaration.json');fs.writeFileSync(out,text);
        notices.push({path:path.relative(root,out).split(path.sep).join('/'),sha256:hash(text),source:'package.json'});
        const standard='third-party/sources/MIT-standard.txt';notices.push({path:standard,sha256:hash(fs.readFileSync(path.join(root,standard))),source:'https://raw.githubusercontent.com/spdx/license-list-data/617f1a78824394ada7525017d98c6fb215aad09b/text/MIT.txt'});
        evidence='metadata-only-with-standard-license-reference';
      }else throw Error('Missing license text: '+key);
    }
    return {...base,evidence,notices};
  });
  fs.writeFileSync(inventoryFile,JSON.stringify({schemaVersion:1,packages},null,2)+'\n');
  const rows=packages.map(p=>'| `'+p.name+'@'+p.version+'` | '+p.scope+' | `'+p.license+'` | '+p.notices.map(n=>'['+path.basename(n.path)+']('+n.path+')').join(', ')+' |');
  fs.writeFileSync(path.join(root,'THIRD_PARTY_NOTICES.md'),`# Third-party notices\n\nThis inventory covers all ${packages.length} locked npm dependency entries, including\ndevelopment tools. Project-owned code, documentation and generated fixtures use\nthe [MIT License](LICENSE); dependencies and external tools retain their own terms.\nVersions, integrity values, scope, provenance and notice hashes are recorded in\n[the machine-readable inventory](third-party/npm-manifest.json).\n\nThe files below preserve published license/NOTICE texts verbatim. Cookie-signature\nand isarray supply their full MIT terms in README license sections. The runtime\npackage \`@nodable/entities@3.1.0\` omits its license file from npm; its MIT text is\nretained from the exact Git commit identified by npm's gitHead.\n\nThe development-only \`require-relative@0.8.7\` declares MIT and names its author,\nbut supplies no full license or copyright notice in its npm archive or upstream\nrepository. Its published declaration is retained, with the canonical SPDX MIT\ntemplate as an explicitly labelled reference. The template placeholders are not\nan invented upstream copyright notice or a replacement for maintainer review.\nNo require-relative implementation is bundled in this project's package archive.\n\n## External tools and media\n\nDASH starts the upstream livesim2 v1.15.3 Docker image pinned in the adapter; this\nproject's npm archive does not embed or redistribute that image, its Alpine base,\nGo dependencies, or upstream sample media. The [upstream engine license](third-party/sources/livesim2-v1.15.3-LICENSE.md)\nis preserved for attribution. Redistribution of the image or an appliance needs\na separate inventory of its contents and notices.\n\nFFmpeg/libx264 are optional external fixture-generation tools; neither binaries\nnor libraries are bundled. The current media uses procedural patterns and a\nsynthesized tone; [provenance and historical limits](assets/README.md). Browser\nchecks use separately installed Chrome and pinned hls.js/dash.js development\npackages; Chrome binaries are not bundled.\n\n## Locked npm dependencies\n\n| Package | Scope | Declared license | Preserved notice/evidence |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\nRegenerate from a clean full development install with \`npm run notices:generate\`.\nRun \`npm run notices:check\` to detect lockfile drift, missing notices or altered\ntexts. Existing verified notice data supports optional packages absent on the\ncurrent platform; a new missing platform package fails explicitly.\n`);
}
function check(){
  const data=JSON.parse(fs.readFileSync(inventoryFile,'utf8'));assert.equal(data.schemaVersion,1);assert.equal(data.packages.length,entries.length);
  for(const [location,pkg]of entries){const wanted=identity(location,pkg),actual=data.packages.find(p=>p.location===location);assert.ok(actual,'Missing notice entry: '+location);
    for(const [key,value]of Object.entries(wanted))assert.deepEqual(actual[key],value,'Notice drift: '+location+' '+key);
    assert.ok(actual.notices.length);for(const n of actual.notices){assert.ok(n.path.startsWith('third-party/')&&!n.path.split('/').includes('..'));assert.equal(hash(fs.readFileSync(path.join(root,n.path))),n.sha256,'Notice changed: '+n.path);}}
  console.log('Verified '+data.packages.length+' locked dependency notice entries and content hashes.');
}
try {if(process.argv.includes('--write'))generate();check();}catch(error){console.error(error.message);process.exitCode=1;}
