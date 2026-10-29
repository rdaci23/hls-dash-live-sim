// Exercise a generated local HLS one-shot without requiring a video player.
// This makes two media GETs; HTTP success does not establish rendered recovery.
(async () => {
  const root = new URL(process.argv[2] || 'http://127.0.0.1:8899/proxy.m3u8');
  if (root.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(root.hostname) || root.username || root.password)
    throw Error('Use an uncredentialed loopback HTTP HLS URL');
  const request = async url => {
    if(url.origin !== root.origin)throw Error('Demo helper only follows same-origin local resources');
    return fetch(url,{redirect:'error',signal:AbortSignal.timeout(5000)});
  };
  const playlist = async url => { const r=await request(url);if(!r.ok)throw Error('Manifest HTTP '+r.status);return r.text(); };
  const uris = text => text.split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
  let url=root,text=await playlist(url);
  if(text.includes('#EXT-X-STREAM-INF:')){url=new URL(uris(text)[0],url);text=await playlist(url);}
  if(!text.startsWith('#EXTM3U')||!text.includes('#EXTINF:'))throw Error('Expected a generated HLS media playlist');
  const media=new URL(uris(text).at(-1),url);
  for(let attempt=1;attempt<=2;attempt++){
    const response=await request(media),bytes=(await response.arrayBuffer()).byteLength;
    console.log(JSON.stringify({attempt,status:response.status,bytes,requestId:response.headers.get('x-sim-request-id'),faultIds:response.headers.get('x-sim-fault-ids')}));
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
