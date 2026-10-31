import {FixtureServices} from "./fixture-services.js";
import { FixtureLifecycle, type FixtureGeneration } from "./fixture-lifecycle.js";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { LiveHlsTimeline, type StreamMode } from "./live-hls.js";
import { HttpError, send, sessionServer } from "./safe-http.js";
interface Segment {
  file: string;
  baseTime: string;
  duration: number;
  bytes: number;
}
export interface FixtureTrack {
  id: string;
  type: "video" | "audio" | "text";
  language?: string;
  toneHz?: number;
  codec: string;
  bandwidth: number;
  width?: number;
  height?: number;
  timescale: number;
  cycleTicks: number;
  init: string;
  segments: Segment[];
}
interface Box {
  type: string;
  start: number;
  body: number;
  end: number;
}
function boxes(bytes: Buffer, start = 0, end = bytes.length): Box[] {
  const result: Box[] = [];
  for (let at = start; at < end;) {
    if (at + 8 > end)
      throw Error('Truncated fixture box');
    const size = bytes.readUInt32BE(at);
    if (size < 8 || at + size > end)
      throw Error('Invalid fixture box size');
    result.push({ type: bytes.toString('ascii', at + 4, at + 8), start: at, body: at + 8, end: at + size });
    at += size;
  }
  return result;
}
function box(bytes: Buffer, type: string, parent?: Box): Box {
  const found = boxes(bytes, parent?.body, parent?.end).filter(b => b.type === type); if (found.length !== 1)
    throw Error('Fixture requires one ' + type); return found[0];
}
export function retimeFragment(input: Buffer, track: FixtureTrack, sequence: number, timestampSequence = sequence): Buffer {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= 0xffffffff)
    throw new HttpError(410, 'Fixture sequence exceeds supported lifetime');
  const bytes = Buffer.from(input), cycle = BigInt(Math.floor(timestampSequence / track.segments.length)), offset = cycle * BigInt(track.cycleTicks), moof = box(bytes, 'moof'), traf = box(bytes, 'traf', moof), tfdt = box(bytes, 'tfdt', traf), mfhd = box(bytes, 'mfhd', moof);
  const readTime = (b: Box, at: number) => bytes[b.body] === 1 ? bytes.readBigUInt64BE(at) : BigInt(bytes.readUInt32BE(at));
  const writeTime = (b: Box, at: number, value: bigint) => {
    if (bytes[b.body] === 1)
      bytes.writeBigUInt64BE(value, at);
    else {
      if (value > 0xffffffffn)
        throw new HttpError(410, 'Fixture timestamp exceeds source field');
      bytes.writeUInt32BE(Number(value), at);
    }
  };
  const expected = BigInt(track.segments[sequence % track.segments.length].baseTime);
  if (readTime(tfdt, tfdt.body + 4) !== expected)
    throw Error('Fixture timing metadata does not match bytes');
  writeTime(tfdt, tfdt.body + 4, expected + offset);
  bytes.writeUInt32BE(sequence + 1, mfhd.body + 4);
  for (const sidx of boxes(bytes).filter(b => b.type === 'sidx')) {
    if (bytes.readUInt32BE(sidx.body + 8) !== track.timescale)
      throw Error('Fixture sidx timescale mismatch');
    writeTime(sidx, sidx.body + 12, readTime(sidx, sidx.body + 12) + offset);
  }
  return bytes;
}
function vttTime(seconds: number): string { const ms = Math.round(seconds * 1000); return String(Math.floor(ms / 3600000)).padStart(2, '0') + ':' + String(Math.floor(ms / 60000) % 60).padStart(2, '0') + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0'); }
export function webVttSegment(track: FixtureTrack, sequence: number, generationStart = 0): string {
  const index = sequence % 4, start = sequence * 2, header = 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:'+vttTime(generationStart)+',MPEGTS:'+Math.round(generationStart*90000)+'\n\n';
  return index === 1 ? header : header + vttTime(start + 0.25) + ' --> ' + vttTime(start + 1.5) + '\n' + track.language.toUpperCase() + ' cue ' + (index + 1) + '\n\n';
}
/** Owned local origin. All resources come from bundled advertised metadata. */
export class TrackFixturePublisher {
  readonly tracks: readonly FixtureTrack[];
  readonly ast: number;
  private files = new Map<string, Buffer>();
  private timelines = new Map<string, LiveHlsTimeline>();
  private origin?: Awaited<ReturnType<typeof sessionServer>>;
  readonly lifecycle:FixtureLifecycle;
  readonly services:FixtureServices;
  private started:number;
  constructor(readonly mode: StreamMode = 'live', videoRenditions = 2, private clock = () => performance.now(), private wallStarted = Date.now(), private windowSegments = 6, servicesOptions:{protocol?:"hls"|"dash";aes?:boolean}={}) {
    if (!['live', 'event', 'vod'].includes(mode) || ![2, 3].includes(videoRenditions))
      throw Error('Fixture requires live/event/vod and two or three video renditions');
    const root = path.join(__dirname, 'assets/track-sample'), index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
    if (index.schemaVersion !== 1 || index.cycleSeconds !== 8 || !Array.isArray(index.tracks) || index.tracks.length !== 7 || ['video:0', 'video:1', 'video:2', 'audio:0', 'audio:1', 'text:0', 'text:1'].some(id => index.tracks.filter(t => t.id === id).length !== 1))
      throw Error('Unsupported owned fixture metadata');
    this.tracks = index.tracks.filter((t: FixtureTrack) => t.type !== 'video' || Number(t.id.split(':')[1]) < videoRenditions);
    const started = this.started = clock();
    this.services=new FixtureServices(servicesOptions.protocol??"hls",servicesOptions.aes??false);
    this.lifecycle=new FixtureLifecycle(mode,()=>this.positionSeconds());
    this.ast = wallStarted - windowSegments * 2000;
    for (const t of this.tracks) {
      if (!/^(video|audio|text):\d$/.test(t.id) || t.segments.length !== 4 || t.cycleTicks / t.timescale !== 8 || !Number.isSafeInteger(t.timescale) || t.timescale <= 0 || !Number.isSafeInteger(t.cycleTicks) || t.type !== t.id.split(":")[0])
        throw Error('Invalid fixture track timing');
      for (const file of [t.init, ...t.segments.map(s => s.file)]) {
        if (!/^[a-z0-9-]+\.m4s$/.test(file))
          throw Error('Invalid bundled fixture resource');
        const bytes = fs.readFileSync(path.join(root, file));
        if (bytes.length > 8 * 1024 * 1024)
          throw Error("Owned fixture object exceeds size bound");
        this.files.set(file, bytes);
      }
      let end = 0n;
      for (const s of t.segments) {
        if (!/^\d{1,20}$/.test(s.baseTime) || BigInt(s.baseTime) !== end || !Number.isSafeInteger(s.duration) || s.duration <= 0 || this.files.get(s.file).length !== s.bytes)
          throw Error("Owned fixture segment metadata mismatch");
        end += BigInt(s.duration);
      }
      if (end !== BigInt(t.cycleTicks))
        throw Error("Owned fixture cycle mismatch");
      const timeline = new LiveHlsTimeline(t.segments.map(s => ({ uri: s.file, duration: s.duration / t.timescale })), mode, windowSegments, clock, started, wallStarted, windowSegments * 2);
      this.timelines.set(t.id, timeline);
    }
  }
  private positionSeconds():number{return this.windowSegments*2+Math.max(0,this.clock()-this.started)/1000;}
  private prefix(t: FixtureTrack,generation=0): string { return (generation?'/generation-'+generation:'')+'/track/'+t.id.replace(':','/'); }
  private initUri(t: FixtureTrack,generation=0): string { return this.prefix(t,generation)+'/init.m4s'; }
  private mediaUri(t:FixtureTrack,n:number,hls=false):string{const generation=this.lifecycle.generationAt(n).id;return this.prefix(t,generation)+'/segment-'+n+(hls&&t.type==='text'?'.vtt':'.m4s');}
  private bound(t:FixtureTrack){const bounds=this.timelines.get(t.id).bounds(),endSeconds=this.lifecycle.endSeconds;if(this.lifecycle.ended&&endSeconds!==undefined)bounds.end=Math.min(bounds.end,endSeconds/8*4);return bounds;}
  hlsMaster(): string {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
    for (const t of this.tracks.filter(t => t.type !== 'video'))
      lines.push('#EXT-X-MEDIA:TYPE=' + (t.type === 'audio' ? 'AUDIO' : 'SUBTITLES') + ',GROUP-ID="' + t.type + '",NAME="' + (t.language === 'en' ? 'English' : 'Romanian') + '",LANGUAGE="' + t.language + '",DEFAULT=' + (t.language === 'en' ? 'YES' : 'NO') + ',AUTOSELECT=YES' + (t.type === 'text' ? ',FORCED=NO' : ',CHANNELS="2"') + ',URI="' + this.prefix(t) + '/stream.m3u8"');
    const audioPeak = Math.max(...this.tracks.filter(t => t.type === 'audio').flatMap(t => t.segments.map(s => s.bytes * 8 / (s.duration / t.timescale))));
    for (const t of this.tracks.filter(t => t.type === 'video')) {
      const peak = Math.max(...t.segments.map(s => s.bytes * 8 / (s.duration / t.timescale)));
      lines.push('#EXT-X-STREAM-INF:BANDWIDTH=' + Math.ceil(peak + audioPeak) + ',RESOLUTION=' + t.width + 'x' + t.height + ',CODECS="' + t.codec + ',mp4a.40.2",AUDIO="audio",SUBTITLES="text"', this.prefix(t) + '/stream.m3u8');
    }
    return lines.join('\n') + '\n';
  }
  hlsPlaylist(t:FixtureTrack,withFault=false):string{
    const {first,end}=this.bound(t),generations=this.lifecycle.allGenerations,discontinuities=generations.filter(g=>g.id&&g.startSeconds/2<first).length;
    const lines=['#EXTM3U','#EXT-X-VERSION:7','#EXT-X-TARGETDURATION:'+Math.ceil(Math.max(...t.segments.map(s=>s.duration/t.timescale))),'#EXT-X-MEDIA-SEQUENCE:'+(withFault&&this.lifecycle.activeFault()?.kind==='sequence-rollback'&&this.lifecycle.activeFault()?.track===t.id?Math.max(0,first-4):first),'#EXT-X-DISCONTINUITY-SEQUENCE:'+discontinuities];
    if(this.mode!=='live')lines.push('#EXT-X-PLAYLIST-TYPE:'+this.mode.toUpperCase());
    if(t.type!=='text'&&this.services.aes)lines.push('#EXT-X-KEY:METHOD=NONE');
    if(t.type!=='text')lines.push('#EXT-X-MAP:URI="'+this.initUri(t,this.lifecycle.generationAt(first).id)+'"');
    for(let n=first;n<end;n++){
      const g=generations.find(g=>g.id&&g.startSeconds/2===n);if(g){lines.push('#EXT-X-DISCONTINUITY');if(t.type!=='text'&&this.services.aes)lines.push('#EXT-X-KEY:METHOD=NONE');if(t.type!=='text')lines.push('#EXT-X-MAP:URI="'+this.initUri(t,g.id)+'"');}
      if(t.type!=='text'&&this.services.aes)lines.push(this.services.encrypted(n)?'#EXT-X-KEY:METHOD=AES-128,URI="'+this.services.keyUri(n)+'",IV=0x'+this.services.iv(n).toString('hex'):'#EXT-X-KEY:METHOD=NONE');
      const s=t.segments[n%4],at=Number(s.baseTime)/t.timescale+Math.floor(n/4)*8;
      lines.push('#EXT-X-PROGRAM-DATE-TIME:'+new Date(this.ast+at*1000).toISOString(),'#EXTINF:'+(s.duration/t.timescale).toFixed(9)+',',this.mediaUri(t,n,true));
    }
    if(this.mode==='vod'||this.lifecycle.ended)lines.push('#EXT-X-ENDLIST');return lines.join('\n')+'\n';
  }
  mpd(withFault=false):string{
    const dynamic=this.mode!=='vod'&&!this.lifecycle.ended,duration=this.mode==='vod'?8:this.lifecycle.endSeconds;
    const lines=['<?xml version="1.0" encoding="UTF-8"?>','<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="'+(dynamic?'dynamic':'static')+'" minBufferTime="PT2S"'+(dynamic?' availabilityStartTime="'+new Date(this.ast).toISOString()+'" publishTime="'+new Date().toISOString()+'" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT'+(this.windowSegments*2)+'S" suggestedPresentationDelay="PT'+Math.min(6,this.windowSegments*2-2)+'S"':' mediaPresentationDuration="PT'+duration+'S"')+'>'];
    if(dynamic)this.services.advertiseUtc();
    if(dynamic)lines.push('<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-head:2014" value="/utc"/>');
    const generations=this.lifecycle.allGenerations.filter(g=>g.startSeconds<=this.positionSeconds());
    for(const [index,g]of generations.entries()){
      const startSequence=g.startSeconds/2,next=generations[index+1],endSequence=next?next.startSeconds/2:Infinity;
      if(!this.tracks.every(t=>{const b=this.bound(t);return Math.max(b.first,startSequence)<Math.min(b.end,endSequence);}))continue;
      lines.push('<Period id="'+(g.id?'owned-'+g.id:'owned')+'" start="PT'+g.startSeconds+'S"'+(next?' duration="PT'+(next.startSeconds-g.startSeconds)+'S"':'')+'>');
      this.periodTracks(lines,g,startSequence,endSequence,withFault);lines.push('</Period>');
    }
    lines.push('</MPD>');return lines.join('\n')+'\n';
  }
  private periodTracks(lines:string[],g:FixtureGeneration,startSequence:number,endSequence:number,withFault=false):void{
    let adaptation=0;
    for(const group of [this.tracks.filter(t=>t.type==='video'),...this.tracks.filter(t=>t.type!=='video').map(t=>[t])]){
      const first=group[0];lines.push('<AdaptationSet id="'+adaptation+++'" contentType="'+first.type+'" segmentAlignment="true"'+(first.language?' lang="'+first.language+'"':'')+'>');
      if(first.type==='text')lines.push('<Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>');
      for(const t of group){const b=this.bound(t),start=Math.max(b.first,startSequence),end=Math.min(b.end,endSequence);if(start>=end)continue;
        lines.push('<Representation id="'+t.id.replace(':','-')+'" mimeType="'+(t.type==='text'?'application':t.type)+'/mp4" codecs="'+t.codec+'" bandwidth="'+t.bandwidth+'"'+(t.type==='video'?' width="'+t.width+'" height="'+t.height+'"':t.type==='audio'?' audioSamplingRate="48000"':'')+'>');
        if(t.type==='audio')lines.push('<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>');
        lines.push('<SegmentTemplate timescale="'+t.timescale+'" presentationTimeOffset="'+(g.startSeconds*t.timescale)+'" startNumber="'+(withFault&&this.lifecycle.activeFault()?.kind==='sequence-rollback'&&this.lifecycle.activeFault()?.track===t.id?Math.max(1,start-3):start+1)+'" initialization="'+this.initUri(t,g.id)+'" media="'+this.prefix(t,g.id)+'/number-$Number$.m4s"><SegmentTimeline>');
        for(let n=start;n<end;n++){const s=t.segments[n%4],time=BigInt(s.baseTime)+BigInt(Math.floor(n/4))*BigInt(t.cycleTicks);lines.push('<S t="'+time+'" d="'+s.duration+'"/>');}
        lines.push('</SegmentTimeline></SegmentTemplate></Representation>');
      }lines.push('</AdaptationSet>');
    }
  }
  private response(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/hls/master.m3u8') {
      send(res, 200, this.hlsMaster(), { 'Content-Type': 'application/vnd.apple.mpegurl' }, req.method);
      return;
    }
    if (url.pathname === '/dash/manifest.mpd') {
      send(res, 200, this.mpd(req.method==='GET'), { 'Content-Type': 'application/dash+xml' }, req.method);
      return;
    }
    if (url.pathname === '/utc') {
      const clock=this.services.utc(req.method);send(res,clock.status,clock.body,{'Content-Type':'text/plain',Date:clock.date,'Cache-Control':'no-store'},req.method);
      return;
    }
    const key=this.services.key(url.pathname,req.method);if(key){res.once('finish',()=>key.body.fill(0));res.once('close',()=>key.body.fill(0));send(res,key.status,key.body,{'Content-Type':'application/octet-stream','Cache-Control':'no-store'},req.method);return;}
    const generationMatch=/^\/generation-(\d{1,2})(\/.*)$/.exec(url.pathname),generation=generationMatch?Number(generationMatch[1]):0,pathname=generationMatch?generationMatch[2]:url.pathname;
    if(!this.lifecycle.allGenerations.some(g=>g.id===generation))throw new HttpError(404,'Unknown fixture generation');
    const match = /^\/track\/(video|audio|text)\/(\d)\/(init\.m4s|stream\.m3u8|(?:segment|number)-(\d+)\.(m4s|vtt))$/.exec(pathname), track = match ? this.tracks.find(t => t.id === match[1] + ':' + match[2]) : undefined;
    if (!track)
      throw new HttpError(404, 'Unknown owned fixture resource');
    if (match[3] === 'stream.m3u8') {
      send(res, 200, this.hlsPlaylist(track,req.method==='GET'), { 'Content-Type': 'application/vnd.apple.mpegurl' }, req.method);
      return;
    }
    let body: Buffer, contentType = track.type === 'text' ? 'application/mp4' : track.type + '/mp4';
    if (match[3] === 'init.m4s')
      body = this.files.get(track.init);
    else {
      const sequence = Number(match[4]) - (match[3].startsWith('number-') ? 1 : 0), timeline = this.timelines.get(track.id), { end } = this.bound(track);
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= end)
        throw new HttpError(404, 'Fixture segment is not available yet');
      if(this.lifecycle.generationAt(sequence).id!==generation)throw new HttpError(404,'Resource is not advertised in this generation');
      if (!timeline.retained(sequence))
        throw new HttpError(410, 'Fixture retention expired');
      if (match[5] === 'vtt') {
        if (track.type !== 'text')
          throw new HttpError(404, 'This track has no WebVTT resource');
        body = Buffer.from(webVttSegment(track, sequence, this.lifecycle.generationAt(sequence).startSeconds));
        contentType = 'text/vtt';
      }
      else {
        const fault=req.method==='GET'?this.lifecycle.activeFault():undefined;
        const donor=fault?.kind==='reused-url-incompatible-media'&&fault.track===track.id?this.tracks.find(t=>t.id==='video:1'):track;
        body = retimeFragment(this.files.get(donor.segments[sequence % 4].file), donor, sequence, fault?.kind==='unannounced-timestamp-reset'&&fault.track===track.id?sequence%4:sequence);
      }
    }
    if(this.services.aes&&track.type!=='text'&&match[3]!=='init.m4s'){
      const sequence=Number(match[4])-(match[3].startsWith('number-')?1:0);if(this.services.encrypted(sequence))body=this.services.encrypt(body,sequence);
    }
    let status = 200, headers: Record<string, string> = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', ETag: '"' + createHash('sha256').update(body).digest('hex') + '"' };
    if (req.method === 'GET' && req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!range || !range[1] && !range[2])
        throw new HttpError(416, 'Unsupported fixture range');
      const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2])), end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      if (!Number.isSafeInteger(start) || start > end || start >= body.length)
        throw new HttpError(416, 'Fixture range is unsatisfiable');
      headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
      body = body.subarray(start, end + 1);
      status = 206;
    }
    send(res, status, body, headers, req.method);
  }
  async start(): Promise<{
    port: number;
    url: string;
    close: () => Promise<void>;
  }> {
    if (this.origin)
      throw Error('Fixture already started');
    const transport = sessionServer(async (req, res) => {
      try {
        this.response(req, res);
      }
      catch (error) {
        send(res, error instanceof HttpError ? error.status : 500, error instanceof HttpError ? error.message : 'Owned fixture failed', {}, req.method);
      }
    });
    this.origin = transport;
    try {
      await new Promise<void>((resolve, reject) => { transport.server.once('error', reject); transport.server.listen(0, '127.0.0.1', () => { transport.server.off('error', reject); resolve(); }); });
    }
    catch (error) {
      await transport.close();
      throw error;
    }
    const port = (transport.server.address() as {
      port: number;
    }).port;
    return { port,url:'http://127.0.0.1:'+port,close:async()=>{this.lifecycle.close();this.services.close();await transport.close();} };
  }
}
