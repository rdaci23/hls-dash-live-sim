import {createCipheriv,createHmac,randomBytes} from 'node:crypto';
import { LICENSE_KEY } from './scenario-services.js';
import type { ServiceDefinition,ServiceHooks,ServiceKind } from './scenario-services.js';
import type { LogicalMedia } from './scenario.js';
/** Secrets stay process-local; advertised service identities are bounded metadata. */
export class FixtureServices{
 private master=randomBytes(32);private keys=new Map<string,number>();private utcAdvertised=false;
 private action?:{id:string;definition:ServiceDefinition;elapsed:()=>number};
 constructor(readonly protocol:'hls'|'dash',readonly aes:boolean){if(aes&&protocol!=='hls')throw Error('AES fixture requires HLS');}
 encrypted(sequence:number){return this.aes&&Math.floor(sequence/4)%3!==0;}
 keyUri(sequence:number){const cycle=Math.floor(sequence/4),uri='/keys/aes-'+cycle;this.keys.set(uri,performance.now()+60000);for(const [key,until]of this.keys)if(until<performance.now())this.keys.delete(key);if(this.keys.size>64)throw Error('Advertised key capacity exceeded');return uri;}
 iv(sequence:number){const bytes=Buffer.alloc(16);bytes.writeBigUInt64BE(BigInt(sequence),8);return bytes;}
 private derive(cycle:number){return createHmac('sha256',this.master).update('owned-hls-aes:'+cycle).digest().subarray(0,16);}
 encrypt(body:Buffer,sequence:number){const key=this.derive(Math.floor(sequence/4));try{const cipher=createCipheriv('aes-128-cbc',key,this.iv(sequence));return Buffer.concat([cipher.update(body),cipher.final()]);}finally{key.fill(0);}}
 advertiseUtc(){this.utcAdvertised=true;}
 private active(){const a=this.action;if(!a)return undefined;const t=a.elapsed();return t>=a.definition.afterMs&&t<a.definition.beforeMs?a.definition:undefined;}
 /** Clock error now: a fixed skew, or one that grows through the drift window. */
 private clockError(){const a=this.action,fault=this.active();if(!a||!fault)return 0;return fault.kind==='utc-skew'?fault.skewMs:fault.kind==='utc-drift'?Math.round(fault.driftMsPerSecond*(a.elapsed()-fault.afterMs)/1000):0;}
 /** A local licence endpoint. It returns a ClearKey-shaped body whose keys match no content:
  * it exercises a player's licence request and error path, not decryption. */
 license(method:string):{status:number;body:string;type:string}{const fault=method==='HEAD'?undefined:this.active();if(fault?.kind==='license-unavailable')return{status:503,body:'Local licence service temporarily unavailable',type:'text/plain'};if(fault?.kind==='license-denied')return{status:403,body:'Local licence request denied',type:'text/plain'};return{status:200,body:JSON.stringify({keys:[{kty:'oct',kid:randomBytes(16).toString('base64url'),k:randomBytes(16).toString('base64url')}],type:'temporary'}),type:'application/json'};}
 key(pathname:string,method:string):{status:number;body:Buffer}|undefined{
  if(!this.keys.has(pathname))return undefined;const cycle=Number(pathname.slice('/keys/aes-'.length)),key=this.derive(cycle),fault=method==='HEAD'?undefined:this.active();if(fault?.kind==='key-unavailable'){key.fill(0);return{status:503,body:Buffer.from('Local key temporarily unavailable')};}if(fault?.kind==='wrong-key')key[0]^=0xff;return{status:200,body:key};
 }
 utc(method:string){const fault=this.active(),unavailable=fault?.kind==='utc-unavailable',malformed=fault?.kind==='utc-malformed',now=Date.now()+this.clockError();return{status:unavailable?503:200,body:unavailable?'Local UTC temporarily unavailable':malformed?'invalid-local-clock':new Date(now).toISOString(),date:malformed?'invalid-local-clock':new Date(now).toUTCString()};}
 private supports(kind:ServiceKind){return kind==='token-expiry'&&!this.aes||kind.startsWith('utc-')&&this.protocol==='dash'||kind.startsWith('license-')&&this.protocol==='dash'||['key-unavailable','wrong-key'].includes(kind)&&this.aes;}
 hooks():ServiceHooks{return{supports:k=>this.supports(k),start:(id,definition,elapsed)=>{if(!this.supports(definition.kind)||this.action)throw Error('Service action unsupported or already active');this.action={id,definition,elapsed};},cancel:id=>{if(this.action?.id===id)this.action=undefined;},classify:url=>this.classify(url)};}
 private classify(url:string):LogicalMedia|undefined{const pathname=new URL(url).pathname;if(this.keys.has(pathname))return{kind:'key',trackId:'root',trackType:'root',key:'owned:key:'+pathname};if(pathname==='/utc'&&this.utcAdvertised)return{kind:'utc',trackId:'root',trackType:'root',key:'owned:utc'};if(pathname==='/license'&&this.protocol==='dash')return{kind:'key',trackId:'root',trackType:'root',key:LICENSE_KEY};}
 get pendingActions(){return this.action?1:0;}
 close(){this.action=undefined;this.keys.clear();this.master.fill(0);}
}
