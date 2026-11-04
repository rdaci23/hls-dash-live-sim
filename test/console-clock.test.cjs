const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {create}=require('../scripts/browser/console-clock.cjs');
const location={url:'http://127.0.0.1/player.js',lineNumber:19746,columnNumber:18};
const native=(message,time=1234)=>({type:'error',timestamp:time,args:[{type:'string',value:message}],stackTrace:{callFrames:[location]}});
test('native console/audit joining tolerates both channel arrival orders and preserves identical-message order',()=>{
 for(const nativeFirst of [true,false]){const c=create(),a={},b={};if(nativeFirst){c.native(native('same',1234));c.native(native('same',1235));}c.audit(a,'same',location);c.audit(b,'same',location);if(!nativeFirst){c.native(native('same',1234));c.native(native('same',1235));}assert.equal(a.browserConsole.epochMs,1234);assert.equal(b.browserConsole.epochMs,1235);assert.equal(c.dropped(),0);}
});
test('console clocks require the same exact message/location and never export argument contents',()=>{
 const c=create(),a={message:'sanitized'};c.native(native('secret?token=private'));c.audit(a,'different',location);assert.equal(a.browserConsole,undefined);c.audit(a,'secret?token=private',{...location,lineNumber:1});assert.equal(a.browserConsole,undefined);c.audit(a,'secret?token=private',location);assert.equal(a.browserConsole.epochMs,1234);assert.doesNotMatch(JSON.stringify(a),/private|secret/);
});
test('console clock buffers are bounded and record overflow instead of silently qualifying loss',()=>{
 const c=create(1);c.native(native('one'));c.native(native('two'));assert.equal(c.dropped(),1);c.audit({},'unmatched',location);c.audit({},'unmatched2',location);assert.equal(c.dropped(),2);
 for(const event of [{...native('bad'),timestamp:NaN},{...native('bad'),stackTrace:undefined},{...native('bad'),args:[{type:'object',objectId:'secret'}]}]){const c=create(),a={};c.native(event);c.audit(a,'bad',location);assert.equal(a.browserConsole,undefined);}
});
test('the actual pinned DASH Debug prefix has its own initialization origin, independent of metrics',()=>{
 const bundle=fs.readFileSync(path.join(__dirname,'../node_modules/dashjs/dist/modern/umd/dash.all.debug.js'),'utf8'),begin=bundle.indexOf('function Debug('),end=bundle.indexOf('\nDebug.__dashjs_factory_name',begin);assert.ok(begin>0&&end>begin);
 let epoch=65008;const output=[],DateClock=class extends Date{constructor(){super(epoch);}};
 const Debug=vm.runInNewContext('('+bundle.slice(begin,end)+')',{Date:DateClock,LOG_LEVEL_FATAL:1,LOG_LEVEL_ERROR:2,LOG_LEVEL_WARNING:3,LOG_LEVEL_INFO:4,LOG_LEVEL_DEBUG:5,_EventBus_js__WEBPACK_IMPORTED_MODULE_0__:{default:()=>({getInstance:()=>({trigger(){}})})},window:{console:{error:m=>output.push({message:m,epochMs:epoch}),warn(){},info(){},debug(){},log(){}}}});
 const debug=Debug.call({context:{}},{settings:{get:()=>({debug:{logLevel:3,dispatchEvent:false}})}});epoch=65231;debug.getLogger({getClassName:()=> 'StreamController'}).error('example');assert.equal(output[0].message,'[223][StreamController] example ');assert.equal(output[0].epochMs-65000,231);
});
