import {createCipheriv,createHmac,randomBytes} from 'node:crypto';
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
 key(pathname:string,method:string):{status:number;body:Buffer}|undefined{
  if(!this.keys.has(pathname))return undefined;const cycle=Number(pathname.slice('/keys/aes-'.length)),key=this.derive(cycle),fault=method==='HEAD'?undefined:this.active();if(fault?.kind==='key-unavailable'){key.fill(0);return{status:503,body:Buffer.from('Local key temporarily unavailable')};}if(fault?.kind==='wrong-key')key[0]^=0xff;return{status:200,body:key};
 }
 utc(method:string){const fault=this.active(),unavailable=fault?.kind==='utc-unavailable',malformed=fault?.kind==='utc-malformed',now=Date.now()+(fault?.kind==='utc-skew'?fault.skewMs:0);return{status:unavailable?503:200,body:unavailable?'Local UTC temporarily unavailable':malformed?'invalid-local-clock':new Date(now).toISOString(),date:malformed?'invalid-local-clock':new Date(now).toUTCString()};}
 private supports(kind:ServiceKind){return kind==='token-expiry'&&!this.aes||kind.startsWith('utc-')&&this.protocol==='dash'||['key-unavailable','wrong-key'].includes(kind)&&this.aes;}
 hooks():ServiceHooks{return{supports:k=>this.supports(k),start:(id,definition,elapsed)=>{if(!this.supports(definition.kind)||this.action)throw Error('Service action unsupported or already active');this.action={id,definition,elapsed};},cancel:id=>{if(this.action?.id===id)this.action=undefined;},classify:url=>this.classify(url)};}
 private classify(url:string):LogicalMedia|undefined{const pathname=new URL(url).pathname;if(this.keys.has(pathname))return{kind:'key',trackId:'root',trackType:'root',key:'owned:key:'+pathname};if(pathname==='/utc'&&this.utcAdvertised)return{kind:'utc',trackId:'root',trackType:'root',key:'owned:utc'};}
 get pendingActions(){return this.action?1:0;}
 close(){this.action=undefined;this.keys.clear();this.master.fill(0);}
}
