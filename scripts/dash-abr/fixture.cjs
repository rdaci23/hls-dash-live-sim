// Inspect source fMP4 timing and coded track dimensions without an FFmpeg runtime dependency.
const assert = require('node:assert/strict');
function boxes(bytes, start = 0, end = bytes.length) {
  const result = [];
  for (let at = start; at < end;) {
    assert.ok(at + 8 <= end, 'truncated box header');
    let size = bytes.readUInt32BE(at), header = 8;
    if (size === 1) { assert.ok(at + 16 <= end); size = Number(bytes.readBigUInt64BE(at + 8)); header = 16; }
    if (size === 0) size = end - at;
    assert.ok(Number.isSafeInteger(size) && size >= header && at + size <= end, 'invalid box size');
    result.push({ type: bytes.toString('ascii', at + 4, at + 8), start: at + header, end: at + size }); at += size;
  }
  return result;
}
function child(bytes, parent, type) { const b = boxes(bytes, parent?.start, parent?.end).find(b => b.type === type); assert.ok(b, 'missing ' + type); return b; }
function initialization(bytes) {
  const moov = child(bytes, null, 'moov'), trak = child(bytes, moov, 'trak'), tkhd = child(bytes, trak, 'tkhd');
  const mdhd = child(bytes, child(bytes, trak, 'mdia'), 'mdhd');
  const version = bytes[mdhd.start];
  return { width: bytes.readUInt32BE(tkhd.end - 8) / 65536, height: bytes.readUInt32BE(tkhd.end - 4) / 65536,
    timescale: bytes.readUInt32BE(mdhd.start + (version === 1 ? 20 : 12)) };
}
function fragment(bytes) {
  const traf = child(bytes, child(bytes, null, 'moof'), 'traf');
  const tfhd = child(bytes, traf, 'tfhd'), tfdt = child(bytes, traf, 'tfdt'), trun = child(bytes, traf, 'trun');
  const flags = bytes.readUInt32BE(tfhd.start) & 0xffffff;
  let p = tfhd.start + 8, defaultDuration = 0, defaultFlags = 0;
  if (flags & 1) p += 8; if (flags & 2) p += 4;
  if (flags & 8) { defaultDuration = bytes.readUInt32BE(p); p += 4; }
  if (flags & 16) p += 4; if (flags & 32) defaultFlags = bytes.readUInt32BE(p);
  const baseTime = bytes[tfdt.start] === 1 ? bytes.readBigUInt64BE(tfdt.start + 4) : BigInt(bytes.readUInt32BE(tfdt.start + 4));
  const runFlags = bytes.readUInt32BE(trun.start) & 0xffffff, count = bytes.readUInt32BE(trun.start + 4);
  p = trun.start + 8; if (runFlags & 1) p += 4;
  let firstFlags = defaultFlags; if (runFlags & 4) { firstFlags = bytes.readUInt32BE(p); p += 4; }
  let duration = 0;
  for (let i = 0; i < count; i++) {
    let d = defaultDuration; if (runFlags & 256) { d = bytes.readUInt32BE(p); p += 4; }
    if (runFlags & 512) p += 4;
    if (runFlags & 1024) { const f = bytes.readUInt32BE(p); if (!i) firstFlags = f; p += 4; }
    if (runFlags & 2048) p += 4;
    assert.ok(d > 0 && p <= trun.end, 'invalid sample timing'); duration += d;
  }
  return { baseTime, duration, samples: count, randomAccess: !(firstFlags & 0x10000) };
}
module.exports = { initialization, fragment };
