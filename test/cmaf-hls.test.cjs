const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { CmafHlsSample, deltaPlaylist, retimeSegment } = require("../dist/support-tools/cmaf-hls.js");
const { startHlsim } = require("../dist/support-tools/hls-sim-runner.js");
const { buildLivesimPath } = require("../dist/support-tools/dash-sim-runner.js");
const { fragment } = require("../scripts/dash-abr/fixture.cjs");
const freePort = require("./helpers/free-port.cjs");

const uris = text => text.split("\n").filter(line => line && !line.startsWith("#"));
const sample = (now, lowLatency = true, mode = "live") => new CmafHlsSample(mode, 6, () => now.ms, 0, Date.UTC(2026, 0, 1), lowLatency);
function moofs(bytes) {
  const found = [];
  for (let at = 0; at < bytes.length;) {
    const size = bytes.readUInt32BE(at);
    if (bytes.toString("ascii", at + 4, at + 8) === "moof") found.push({ ...fragment(bytes.subarray(at)), sequence: bytes.readUInt32BE(at + 20) });
    at += size;
  }
  return found;
}

test("the fMP4 sample is an exact looping ladder with separate audio and four parts per segment", () => {
  const cmaf = sample({ ms: 0 }, false);
  assert.deepEqual(cmaf.tracks.map(t => t.name), ["v0", "v1", "v2", "a0"]);
  assert.deepEqual(cmaf.tracks.filter(t => t.type === "video").map(t => [t.width, t.height]), [[416, 234], [768, 432], [1280, 720]]);
  for (const t of cmaf.tracks) {
    assert.equal(t.cycleTicks / t.timescale, 8, t.id + " loops every eight seconds");
    for (const s of t.segments) assert.equal(s.parts.length, 4);
    if (t.type === "video") for (const s of t.segments) assert.deepEqual(s.parts.map(p => p.independent), [true, false, false, false]);
  }
  assert.equal(cmaf.targetDuration, 2);
  assert.equal(cmaf.partTarget, 0.512);
  const master = cmaf.master();
  assert.equal((master.match(/#EXT-X-STREAM-INF/g) ?? []).length, 3);
  assert.match(master, /#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",.*URI="\/live\/a0\/stream\.m3u8"/);
  assert.match(master, /RESOLUTION=1280x720,FRAME-RATE=24\.000,CODECS="avc1\.64001f,mp4a\.40\.2",AUDIO="audio"/);
  const bandwidths = [...master.matchAll(/BANDWIDTH=(\d+),AVERAGE-BANDWIDTH=(\d+)/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert.ok(bandwidths.every(([peak, average], i) => peak >= average && (!i || peak > bandwidths[i - 1][0])), "an ascending measured ladder");
  const backup = cmaf.master(true);
  assert.equal((backup.match(/#EXT-X-STREAM-INF/g) ?? []).length, 6);
  assert.match(backup, /GROUP-ID="audio-backup",.*URI="\/backup\/live\/a0\/stream\.m3u8"/);
});

test("segments keep one continuous timeline across loops and parts are exact slices of their segment", () => {
  const cmaf = sample({ ms: 0 });
  for (const t of cmaf.tracks) {
    let expected;
    for (let sequence = 0; sequence < 9; sequence++) {
      const bytes = cmaf.segment(t, sequence), fragments = moofs(bytes);
      expected ??= fragments[0].baseTime;
      for (const f of fragments) { assert.equal(f.baseTime, expected, `${t.id} segment ${sequence} continues the previous fragment`); expected += BigInt(f.duration); }
      assert.deepEqual(fragments.map(f => f.sequence), fragments.map((_, i) => sequence * 8 + i + 1), "fragment numbers are unique and increasing");
      const parts = Array.from({ length: cmaf.partCount(t, sequence) }, (_, i) => cmaf.part(t, sequence, i));
      assert.ok(Buffer.concat(parts).equals(bytes), "the parts concatenate to the whole segment");
      for (const part of parts) assert.ok(moofs(part).length >= 1, "every part holds a complete fragment");
    }
    assert.equal(expected, BigInt(t.cycleTicks) * 2n + BigInt(t.segments[0].duration));
  }
  assert.throws(() => retimeSegment(Buffer.alloc(16), cmaf.tracks[0], 0), /box|fragment/);
});

test("a low-latency playlist lists parts for the newest segments, the growing segment, a preload hint and rendition reports", () => {
  const now = { ms: 0 }, cmaf = sample(now), video = cmaf.track("v0");
  now.ms = 1100; // 1.1 s into segment 6: two half-second parts are complete
  const text = cmaf.playlist(video), lines = text.split("\n");
  assert.match(text, /#EXT-X-VERSION:9/);
  assert.match(text, /#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,CAN-SKIP-UNTIL=12\.000,PART-HOLD-BACK=1\.536/);
  assert.match(text, /#EXT-X-PART-INF:PART-TARGET=0\.512/);
  assert.match(text, /#EXT-X-MAP:URI="\/live\/v0\/init\.mp4"/);
  assert.deepEqual(uris(text), [0, 1, 2, 3, 4, 5].map(n => `/live/v0/segment-${n}.m4s`));
  const parts = lines.filter(l => l.startsWith("#EXT-X-PART:")).map(l => /URI="[^"]*part-(\d+)-(\d+)\.m4s"/.exec(l).slice(1).join("-"));
  assert.deepEqual(parts, ["4-0", "4-1", "4-2", "4-3", "5-0", "5-1", "5-2", "5-3", "6-0", "6-1"]);
  assert.equal(lines.filter(l => l.includes("INDEPENDENT=YES")).length, 3, "only the first part of each video segment is independent");
  assert.ok(text.includes('#EXT-X-PRELOAD-HINT:TYPE=PART,URI="/live/v0/part-6-2.m4s"'));
  assert.deepEqual(lines.filter(l => l.startsWith("#EXT-X-RENDITION-REPORT")), ["v1", "v2", "a0"].map(name => `#EXT-X-RENDITION-REPORT:URI="/live/${name}/stream.m3u8",LAST-MSN=6,LAST-PART=1`));
  assert.equal(lines.filter(l => l.startsWith("#EXT-X-PROGRAM-DATE-TIME")).length, 7, "one date per segment and one for the growing segment");
  // Exactly on a segment boundary no part of the next segment exists yet.
  now.ms = 2000;
  const boundary = cmaf.playlist(video);
  assert.ok(boundary.includes('#EXT-X-PRELOAD-HINT:TYPE=PART,URI="/live/v0/part-7-0.m4s"'));
  assert.ok(boundary.includes('LAST-MSN=6,LAST-PART=3'));
  assert.ok(cmaf.playlist(video, "/backup").includes('URI="/backup/live/v0/part-7-0.m4s"'));
});

test("blocking reload and part availability follow the stream clock", () => {
  const now = { ms: 1100 }, cmaf = sample(now), video = cmaf.track("v0"), audio = cmaf.track("a0");
  assert.equal(cmaf.reloadWaitMs(video, 5), 0, "a published segment needs no wait");
  assert.equal(cmaf.reloadWaitMs(video, 6, 1), 0, "a published part needs no wait");
  assert.equal(Math.round(cmaf.reloadWaitMs(video, 6, 2)), 400);
  assert.equal(Math.round(cmaf.reloadWaitMs(video, 6)), 900, "without a part the whole segment is awaited");
  assert.equal(Math.round(cmaf.reloadWaitMs(video, 6, 4)), 1400, "a part index past the segment means the next segment");
  assert.equal(cmaf.reloadWaitMs(video, 9), undefined, "more than two segments ahead is refused");
  assert.equal(cmaf.reloadWaitMs(video, -1), undefined);
  assert.equal(cmaf.reloadWaitMs(video, 6, 1.5), undefined);
  assert.equal(cmaf.partAvailable(video, 6, 1), true);
  assert.equal(cmaf.partAvailable(video, 6, 2), false);
  assert.equal(cmaf.partAvailable(video, 7, 0), false);
  assert.equal(cmaf.partAvailable(video, 5, 9), false);
  // Audio parts are 512 ms, so its third part completes later than video's.
  assert.equal(Math.round(cmaf.partWaitMs(audio, 6, 2)), 383, "audio segment 6 starts at 11.947 s; three 512 ms parts end at 13.483 s");
});

test("without low latency the fMP4 playlist has no parts, and low latency is live only", () => {
  const now = { ms: 1100 }, text = sample(now, false).playlist(sample(now, false).track("v1"));
  assert.match(text, /#EXT-X-VERSION:7/);
  assert.ok(!/EXT-X-PART|PRELOAD-HINT|SERVER-CONTROL|RENDITION-REPORT/.test(text));
  assert.match(sample(now, false, "vod").playlist(sample(now, false, "vod").track("v0")), /#EXT-X-PLAYLIST-TYPE:VOD[\s\S]*#EXT-X-ENDLIST/);
  assert.throws(() => sample(now, true, "event"), /live/);
});

test("low-latency DASH path options derive early availability from the segment duration", () => {
  assert.equal(buildLivesimPath("sample", undefined, undefined, "local", 2), "/livesim2/utc_head/segtimeline_1/tsbd_30/chunkdur_0.5/ato_1.5/sample/manifest.mpd");
  assert.match(buildLivesimPath("abr", undefined, 60, "local", 4), /\/periods_60\/continuous_1\/chunkdur_0\.5\/ato_3\.5\/abr\//);
  assert.throws(() => buildLivesimPath("sample", undefined, undefined, "local", 0.5), /longer than/);
  assert.doesNotMatch(buildLivesimPath("sample"), /chunkdur|ato_/);
});

async function session(options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hls-cmaf-"));
  const started = await startHlsim({ port: await freePort(), faultConfigPath: path.join(directory, "faults.json"), ...options });
  return { ...started, directory, close: async () => { await started.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
const get = async (base, pathname, init) => { const response = await fetch(new URL(pathname, base), init); return { status: response.status, type: response.headers.get("content-type"), body: Buffer.from(await response.arrayBuffer()), headers: response.headers }; };

test("a low-latency session serves init, segments, parts, a held preload hint and blocking reload", async () => {
  const live = await session({ lowLatency: true });
  try {
    const master = (await get(live.url, "/proxy.m3u8")).body.toString();
    assert.deepEqual(uris(master), ["/live/v0/stream.m3u8", "/live/v1/stream.m3u8", "/live/v2/stream.m3u8"]);
    const init = await get(live.url, "/live/v2/init.mp4");
    assert.equal(init.status, 200); assert.equal(init.type, "video/mp4"); assert.equal(init.body.toString("ascii", 4, 8), "ftyp");
    assert.equal((await get(live.url, "/live/a0/init.mp4")).type, "audio/mp4");
    const playlist = (await get(live.url, "/live/v2/stream.m3u8")).body.toString();
    const segment = uris(playlist).at(-1), whole = await get(live.url, segment);
    assert.equal(whole.status, 200); assert.equal(whole.type, "video/mp4");
    const sequence = Number(/segment-(\d+)/.exec(segment)[1]);
    const parts = [];
    for (let i = 0; i < 4; i++) { const part = await get(live.url, `/live/v2/part-${sequence}-${i}.m4s`); assert.equal(part.status, 200); parts.push(part.body); }
    assert.ok(Buffer.concat(parts).equals(whole.body));
    const ranged = await get(live.url, segment, { headers: { Range: "bytes=0-99" } });
    assert.equal(ranged.status, 206); assert.equal(ranged.body.length, 100);
    // The hinted part does not exist yet: the request is held, then answered.
    const hint = /#EXT-X-PRELOAD-HINT:TYPE=PART,URI="([^"]+)"/.exec((await get(live.url, "/live/v0/stream.m3u8")).body.toString())[1];
    const hinted = await get(live.url, hint);
    assert.equal(hinted.status, 200); assert.ok(moofs(hinted.body).length >= 1);
    // Blocking reload returns only once the requested part is in the playlist.
    const [, msn, part] = /part-(\d+)-(\d+)/.exec(hint).map(Number);
    const began = Date.now(), blocked = await get(live.url, `/live/v0/stream.m3u8?_HLS_msn=${msn + 1}&_HLS_part=0`);
    assert.equal(blocked.status, 200);
    assert.ok(blocked.body.toString().includes(`part-${msn + 1}-0.m4s"`), "the awaited part is listed");
    assert.ok(Date.now() - began >= 100, "the response was held");
    assert.equal((await get(live.url, `/live/v0/stream.m3u8?_HLS_msn=${msn + 9}`)).status, 400);
    assert.equal((await get(live.url, `/live/v0/part-${msn + 5}-0.m4s`)).status, 404, "a part far in the future is not held");
    assert.equal((await get(live.url, `/live/v0/part-${msn}-7.m4s`)).status, 404);
    assert.equal((await get(live.url, `/live/v0/segment-${sequence}.ts`)).status, 404);
    assert.equal((await get(live.url, "/live/low/stream.m3u8")).status, 404);
    const completed = live.diagnostics.snapshot().events.filter(e => e.event === "request.resource");
    assert.ok(completed.some(e => e.resourceKind === "init") && completed.some(e => e.resourceKind === "segment"), "init and media are classified");
  } finally { await live.close(); }
});

test("delta updates skip only complete segments older than CAN-SKIP-UNTIL and keep part-bearing segments", () => {
  const now = { ms: 120000 };
  const cmaf = new CmafHlsSample("live", 20, () => now.ms, 0, Date.UTC(2026, 0, 1), true);
  const track = cmaf.track("v0"), full = cmaf.playlist(track);
  assert.equal(cmaf.skipUntil, 12, "six target durations");
  assert.match(full, /#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,CAN-SKIP-UNTIL=12\.000,/);
  const delta = deltaPlaylist(full, cmaf.skipUntil);
  const skipped = Number(/#EXT-X-SKIP:SKIPPED-SEGMENTS=(\d+)/.exec(delta)[1]);
  const segments = text => uris(text).filter(u => u.includes("/segment-"));
  // Twenty two-second segments: everything ending at least 12 s before the end is skipped.
  assert.equal(segments(full).length, 20);
  assert.equal(skipped, 14);
  assert.deepEqual(segments(delta), segments(full).slice(skipped), "the remaining segments are unchanged");
  assert.equal(delta.match(/#EXT-X-PART:/g).length, full.match(/#EXT-X-PART:/g).length, "parts are never skipped");
  assert.equal(delta.split("\n").filter(l => l.startsWith("#EXT-X-MAP")).length, 1);
  assert.ok(delta.indexOf("#EXT-X-MEDIA-SEQUENCE:") < delta.indexOf("#EXT-X-SKIP"), "header tags precede the skip");
  assert.ok(delta.includes("#EXT-X-PRELOAD-HINT") && delta.includes("#EXT-X-RENDITION-REPORT"));
  // The default six-segment window is exactly CAN-SKIP-UNTIL long, so nothing can be skipped.
  const six = new CmafHlsSample("live", 6, () => now.ms, 0, Date.UTC(2026, 0, 1), true), short = six.playlist(six.track("v0"));
  assert.equal(deltaPlaylist(short, 12), short);
  assert.equal(deltaPlaylist("#EXTM3U\n#EXT-X-ENDLIST\n", 12), "#EXTM3U\n#EXT-X-ENDLIST\n");
});

test("a low-latency session answers _HLS_skip with a delta update and rejects unknown values", async () => {
  const live = await session({ lowLatency: true, windowSegments: 20 });
  try {
    const full = (await get(live.url, "/live/v1/stream.m3u8")).body.toString();
    assert.match(full, /CAN-SKIP-UNTIL=12\.000/);
    assert.ok(!full.includes("#EXT-X-SKIP"));
    for (const value of ["YES", "v2"]) {
      const delta = await get(live.url, `/live/v1/stream.m3u8?_HLS_skip=${value}`);
      assert.equal(delta.status, 200);
      const text = delta.body.toString(), first = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)[1]);
      const skipped = Number(/#EXT-X-SKIP:SKIPPED-SEGMENTS=(\d+)/.exec(text)?.[1] ?? 0);
      const listed = Number(/segment-(\d+)\.m4s/.exec(text)[1]);
      assert.ok(skipped > 0, "the twenty-segment window has segments to skip");
      assert.equal(listed, first + skipped, "the first listed segment follows the skipped ones");
    }
    // Skip combines with blocking reload.
    const msn = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(full)[1]) + uris(full).filter(u => u.includes("/segment-")).length;
    const both = await get(live.url, `/live/v1/stream.m3u8?_HLS_msn=${msn}&_HLS_skip=YES`);
    assert.equal(both.status, 200); assert.match(both.body.toString(), /#EXT-X-SKIP:SKIPPED-SEGMENTS=\d+/);
    assert.equal((await get(live.url, "/live/v1/stream.m3u8?_HLS_skip=NO")).status, 400);
  } finally { await live.close(); }
  const plain = await session({ segmentFormat: "fmp4", windowSegments: 20 });
  try {
    const text = (await get(plain.url, "/live/v1/stream.m3u8?_HLS_skip=YES")).body.toString();
    assert.ok(!text.includes("#EXT-X-SKIP") && !text.includes("CAN-SKIP-UNTIL"), "without low latency the full playlist is served");
  } finally { await plain.close(); }
});

test("the origin proxy relays LL-HLS: parts, preload hints, rendition reports and blocking reload", async () => {
  const origin = await session({ lowLatency: true });
  const proxy = await session({ manifestUrl: origin.url, dummyContent: false });
  try {
    const master = (await get(proxy.url, "/proxy.m3u8")).body.toString();
    const child = uris(master)[0];
    assert.match(child, /^\/r\/[a-f0-9]{32}\.m3u8$/);
    const playlist = (await get(proxy.url, child)).body.toString();
    assert.match(playlist, /#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1\.536/, "CAN-SKIP-UNTIL is withheld");
    const parts = [...playlist.matchAll(/#EXT-X-PART:[^\n]*URI="([^"]+)"/g)].map(m => m[1]);
    const hint = /#EXT-X-PRELOAD-HINT:TYPE=PART,URI="([^"]+)"/.exec(playlist)[1];
    const reports = [...playlist.matchAll(/#EXT-X-RENDITION-REPORT:URI="([^"]+)"/g)].map(m => m[1]);
    assert.ok(parts.length >= 8 && reports.length === 3);
    for (const uri of [...parts, hint, ...reports]) assert.match(uri, /^\/r\/[a-f0-9]{32}\./, "every LL URI is advertised by the proxy");
    assert.ok(!playlist.includes("/live/"), "no origin paths leak");
    const part = await get(proxy.url, parts.at(-1));
    assert.equal(part.status, 200); assert.ok(moofs(part.body).length >= 1);
    // The hinted part does not exist yet; the origin holds it and the proxy relays it.
    const hinted = await get(proxy.url, hint);
    assert.equal(hinted.status, 200); assert.ok(moofs(hinted.body).length >= 1);
    const msn = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(playlist)[1]) + uris(playlist).filter(u => u.endsWith(".bin")).length;
    const began = Date.now(), blocked = await get(proxy.url, `${child}?_HLS_msn=${msn + 1}&_HLS_part=0`);
    assert.equal(blocked.status, 200);
    assert.ok(Date.now() - began >= 100, "the origin held the blocking reload");
    const newest = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(blocked.body.toString())[1]) + uris(blocked.body.toString()).filter(u => u.endsWith(".bin")).length;
    assert.ok(newest >= msn + 1, "the awaited segment has started");
    assert.equal((await get(proxy.url, `${child}?_HLS_part=0`)).status, 400);
    assert.equal((await get(proxy.url, `${child}?_HLS_msn=-1`)).status, 400);
    const skip = (await get(proxy.url, `${child}?_HLS_skip=YES`)).body.toString();
    assert.ok(!skip.includes("#EXT-X-SKIP"), "skip requests get the whole playlist");
  } finally { await proxy.close(); await origin.close(); }
});

test("scenarios address fMP4 init, audio and individual parts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hls-cmaf-rules-"));
  const scenarioFile = path.join(directory, "scenario.json");
  await fs.writeFile(scenarioFile, JSON.stringify({ version: 1, seed: 3, rules: [
    { kind: "outage", target: { track: "audio", segment: "each" }, status: 503, afterMs: 0, beforeMs: 60000 },
    { kind: "outage", target: { resource: "init", track: "video:2", segment: "each" }, status: 404, afterMs: 0, beforeMs: 60000 },
  ] }));
  const live = await session({ lowLatency: true, scenarioFile });
  try {
    const audio = uris((await get(live.url, "/live/a0/stream.m3u8")).body.toString()).at(-1), sequence = /segment-(\d+)/.exec(audio)[1];
    assert.equal((await get(live.url, audio)).status, 503);
    assert.equal((await get(live.url, `/live/a0/part-${sequence}-1.m4s`)).status, 503, "a part of the same track is in the outage too");
    assert.equal((await get(live.url, `/live/v0/segment-${sequence}.m4s`)).status, 200, "video is unaffected");
    assert.equal((await get(live.url, "/live/v2/init.mp4")).status, 404);
    assert.equal((await get(live.url, "/live/v1/init.mp4")).status, 200);
    assert.equal(live.scenario.report().invalidReason, undefined);
  } finally { await live.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("fMP4 and low-latency options are validated at startup and the MPEG-TS default is unchanged", async () => {
  const port = await freePort();
  await assert.rejects(startHlsim({ port, lowLatency: true, mode: "event" }), /requires --mode live/);
  await assert.rejects(startHlsim({ port, lowLatency: true, segmentFormat: "ts" }), /fMP4 parts/);
  await assert.rejects(startHlsim({ port, segmentFormat: "fmp4", adBreakSegments: 2 }), /MPEG-TS sample/);
  await assert.rejects(startHlsim({ port, segmentFormat: "fmp4", rendition: "low" }), /MPEG-TS sample/);
  await assert.rejects(startHlsim({ port, segmentFormat: "fmp4", manifestUrl: "http://127.0.0.1:9/x.m3u8", dummyContent: false }), /generated sample stream/);
  await assert.rejects(startHlsim({ port, segmentFormat: "webm" }), /ts or fmp4/);
  const plain = await session({});
  try {
    assert.deepEqual(uris((await get(plain.url, "/proxy.m3u8")).body.toString()), ["/live/low/stream.m3u8", "/live/main/stream.m3u8"]);
    const playlist = (await get(plain.url, "/live/main/stream.m3u8")).body.toString();
    assert.ok(!/EXT-X-MAP|EXT-X-PART/.test(playlist));
    assert.equal((await get(plain.url, uris(playlist)[0])).type, "video/mp2t");
    assert.equal((await get(plain.url, "/live/main/init.mp4")).status, 404);
    assert.equal((await get(plain.url, "/live/main/part-1-0.m4s")).status, 404);
    assert.equal((await get(plain.url, "/live/v0/stream.m3u8")).status, 404);
  } finally { await plain.close(); }
  const ladder = await session({ segmentFormat: "fmp4", mode: "vod" });
  try {
    const playlist = (await get(ladder.url, "/live/v0/stream.m3u8")).body.toString();
    assert.match(playlist, /#EXT-X-ENDLIST/);
    assert.equal(uris(playlist).length, 4);
    assert.equal((await get(ladder.url, "/live/v0/part-0-0.m4s")).status, 404, "parts exist only in low-latency mode");
  } finally { await ladder.close(); }
});
