const { XMLParser } = require('fast-xml-parser');
const { mediaSegments } = require('../../dist/support-tools/hls-playlist.js');
const list = v => v === undefined ? [] : Array.isArray(v) ? v : [v];
function inspect(protocol, text, url) {
  if (protocol === 'hls') {
    const segments = mediaSegments(text);
    if (!segments.length || !/^#EXT-X-MEDIA-SEQUENCE:\d+$/m.test(text)) throw Error('Invalid HLS live playlist');
    if (/^#EXT-X-ENDLIST/m.test(text)) throw Error('Live playlist unexpectedly ended');
    const first = Number(/^#EXT-X-MEDIA-SEQUENCE:(\d+)$/m.exec(text)[1]);
    const discontinuity = Number(/^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)$/m.exec(text)?.[1] || 0);
    return { first, edge: String(first + segments.length), discontinuity, periods: [],
      media: [{ track: 'video', url: new URL(segments.at(-2)?.uri || segments.at(-1).uri, url) }],
      oldest: new URL(segments[0].uri, url) };
  }
  const root = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false }).parse(text).MPD;
  if (!root || root['@_type'] !== 'dynamic') throw Error('Expected dynamic DASH MPD');
  const tracks = new Map(), initializations = new Map();
  for (const p of list(root.Period)) for (const a of list(p.AdaptationSet)) {
    const template = a.SegmentTemplate, r = list(a.Representation)[0], track = a['@_contentType'];
    if (!template?.SegmentTimeline?.S || !r || !['video', 'audio'].includes(track)) throw Error('Missing generated DASH timeline/track');
    initializations.set(track, { track: track + '-init', url: new URL(template['@_initialization'].replaceAll('$RepresentationID$', String(r['@_id'])), url) });
    let time = 0n, number = BigInt(template['@_startNumber'] || 1);
    const points = tracks.get(track) || [];
    for (const s of list(template.SegmentTimeline.S)) {
      time = BigInt(s['@_t'] ?? time);
      const duration = BigInt(s['@_d']), repeats = BigInt(s['@_r'] || 0);
      if (duration <= 0n || repeats < 0n || repeats > 1000n) throw Error('Unsupported timeline in generated DASH');
      for (let i = 0n; i <= repeats; i++) {
        const relative = template['@_media'].replaceAll('$RepresentationID$', String(r['@_id']))
          .replaceAll('$Time$', String(time)).replaceAll('$Number$', String(number));
        points.push({ track, time: String(time), duration: String(duration), period: String(p['@_id']), url: new URL(relative, url) });
        time += duration; number++;
      }
    }
    tracks.set(track, points.slice(-2));
  }
  if (!tracks.has('video') || !tracks.has('audio')) throw Error('DASH needs both tracks');
  const video = tracks.get('video');
  return { edge: video.at(-1).time, segmentTicks: video.at(-1).duration, initializations: [...initializations.values()], periods: list(root.Period).map(p => String(p['@_id'])),
    media: [...tracks.values()].map(points => points[0]), publishTime: root['@_publishTime'], utc: list(root.UTCTiming) };
}
module.exports = { inspect };
