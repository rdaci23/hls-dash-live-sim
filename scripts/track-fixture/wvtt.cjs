// Owned fragmented WebVTT builder. No external media or embedded credentials.
const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(n));return b;};
const box=(type,...parts)=>{const body=Buffer.concat(parts);return Buffer.concat([u32(body.length+8),Buffer.from(type),body]);};
const full=(type,version,flags,...parts)=>box(type,Buffer.from([version,(flags>>>16)&255,(flags>>>8)&255,flags&255]),...parts);
const identity=Buffer.concat([u32(0x10000),u32(0),u32(0),u32(0),u32(0x10000),u32(0),u32(0),u32(0),u32(0x40000000)]);
function initialization(language='eng',duration=8000){
 const lang=[...language].reduce((n,c)=>n*32+c.charCodeAt(0)-96,0),id=1;
 const mvhd=full('mvhd',0,0,u32(0),u32(0),u32(1000),u32(duration),u32(0x10000),u16(0x100),Buffer.alloc(10),identity,Buffer.alloc(24),u32(2));
 const tkhd=full('tkhd',0,7,u32(0),u32(0),u32(id),u32(0),u32(duration),Buffer.alloc(16),identity,u32(0),u32(0));
 const mdhd=full('mdhd',0,0,u32(0),u32(0),u32(1000),u32(duration),u16(lang),u16(0));
 const hdlr=full('hdlr',0,0,u32(0),Buffer.from('text'),Buffer.alloc(12),Buffer.from('Owned WebVTT\0'));
 const entry=box('wvtt',Buffer.alloc(6),u16(1),box('vttC',Buffer.from('WEBVTT\n\n')));
 const stbl=box('stbl',full('stsd',0,0,u32(1),entry),full('stts',0,0,u32(0)),full('stsc',0,0,u32(0)),full('stsz',0,0,u32(0),u32(0)),full('stco',0,0,u32(0)));
 const minf=box('minf',full('nmhd',0,0),box('dinf',full('dref',0,0,u32(1),full('url ',0,1))),stbl);
 return Buffer.concat([box('ftyp',Buffer.from('iso6'),u32(1),Buffer.from('iso6isomdash')),box('moov',mvhd,box('trak',tkhd,box('mdia',mdhd,hdlr,minf)),box('mvex',full('trex',0,0,u32(id),u32(1),u32(0),u32(0),u32(0))))]);
}
function fragment(sequence,baseTime,samples){
 const payloads=samples.map(s=>s.text?box('vttc',box('payl',Buffer.from(s.text))):box('vtte'));
 const makeMoof=offset=>box('moof',full('mfhd',0,0,u32(sequence)),box('traf',full('tfhd',0,0x020000,u32(1)),full('tfdt',1,0,u64(baseTime)),full('trun',0,0x000301,u32(samples.length),u32(offset),...samples.flatMap((s,i)=>[u32(s.duration),u32(payloads[i].length)]))));
 const moof=makeMoof(0);return Buffer.concat([makeMoof(moof.length+8),box('mdat',...payloads)]);
}
const schedule=(language,index)=>index===1?[{duration:2000,text:''}]:[{duration:250,text:''},{duration:1250,text:language.toUpperCase()+' cue '+(index+1)},{duration:500,text:''}];
module.exports={initialization,fragment,schedule};
