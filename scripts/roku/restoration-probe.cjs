// Host media probes are explicitly identified and never count as native retries.
const { XMLParser } = require('fast-xml-parser');
const { variantEntries, mediaSegments } = require('../../dist/support-tools/hls-playlist.js');
const list = v => v === undefined ? [] : Array.isArray(v) ? v : [v];
function dashMediaUrls(text, manifestUrl) {
  const root = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false }).parse(text).MPD;
  const tracks = new Map();
  for (const p of list(root?.Period)) for (const a of list(p.AdaptationSet)) {
    const t = a.SegmentTemplate, r = list(a.Representation)[0], type = a['@_contentType'];
    if (!t?.SegmentTimeline?.S || !r || !['video', 'audio'].includes(type)) continue;
    let time = 0n, number = BigInt(t['@_startNumber'] ?? 1);
    for (const s of list(t.SegmentTimeline.S)) {
      time = BigInt(s['@_t'] ?? time);
      const duration = BigInt(s['@_d']), repeat = BigInt(s['@_r'] ?? 0);
      if (duration <= 0n || repeat < 0n || repeat > 1000n) throw Error('Unsupported restoration probe timeline');
      for (let i = 0n; i <= repeat; i++) {
        const uri = String(t['@_media']).replaceAll('$RepresentationID$', String(r['@_id']))
          .replaceAll('$Time$', String(time)).replaceAll('$Number$', String(number));
        const candidates = tracks.get(type) || [];
        candidates.push(new URL(uri, manifestUrl));
        tracks.set(type, candidates.slice(-2));
        time += duration; number++;
      }
    }
  }
  if (!tracks.has('video') || !tracks.has('audio')) throw Error('Restoration probe needs both generated DASH tracks');
  // Prefer a segment behind the edge, including across a period boundary.
  return [...tracks].map(([kind, urls]) => ({ kind, url: urls[0] }));
}
async function probeRestoration(session, protocol) {
  const probes = [], origin = new URL(session.url).origin;
  async function request(url, kind) {
    if (new URL(url).origin !== origin) throw Error('Restoration probe refused an external resource');
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = Buffer.from(await response.arrayBuffer());
    probes.push({ kind, requestId: response.headers.get('x-sim-request-id'), status: response.status,
      bodyBytes: data.length, completedEpochMs: Date.now() });
    return data.toString('utf8');
  }
  const text = await request(session.url, 'manifest');
  let resources;
  if (protocol === 'hls') {
    const child = new URL(variantEntries(text)[0].uri, session.url);
    const playlist = await request(child, 'manifest');
    const segments = mediaSegments(playlist);
    resources = [{ kind: 'video', url: new URL(segments.at(-2)?.uri || segments.at(-1).uri, child) }];
  } else resources = dashMediaUrls(text, session.url);
  for (const resource of resources) await request(resource.url, resource.kind);
  return probes;
}
module.exports = { probeRestoration, dashMediaUrls };
