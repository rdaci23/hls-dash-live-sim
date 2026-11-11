const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LiveHlsTimeline } = require("../dist/support-tools/live-hls.js");
const { startHlsim } = require("../dist/support-tools/hls-sim-runner.js");
const freePort = require("./helpers/free-port.cjs");

const source = Array.from({ length: 6 }, (_, i) => ({ duration: 2, uri: `segment-${i}.ts` }));
function timeline(now, ads = 2, mode = "live") { return new LiveHlsTimeline(source, mode, 6, () => now.ms, 0, Date.UTC(2026, 0, 1), undefined, ads); }
const uris = text => text.split("\n").filter(line => line && !line.startsWith("#"));

test("an ad pod follows every content loop, bounded by discontinuities, cue tags and a date range", () => {
  const now = { ms: 0 }, live = timeline(now);
  assert.equal(live.segments.length, 8, "six content segments plus a two-segment pod");
  now.ms = 6000; // sequences 3..8: content 3,4,5 then ad 6,7 then content 8
  const text = live.playlist("main"), lines = text.split("\n");
  assert.deepEqual(uris(text), [3, 4, 5, 6, 7, 8].map(n => `/live/main/segment-${n}.ts`));
  const before = uri => lines.slice(0, lines.indexOf(uri)).reverse();
  const tagsBefore = n => { const all = before(`/live/main/segment-${n}.ts`); return all.slice(0, all.findIndex(line => line && !line.startsWith("#"))); };
  assert.ok(tagsBefore(6).includes("#EXT-X-DISCONTINUITY") && tagsBefore(6).includes("#EXT-X-CUE-OUT:4.000"));
  assert.ok(tagsBefore(8).includes("#EXT-X-DISCONTINUITY") && tagsBefore(8).includes("#EXT-X-CUE-IN"));
  assert.ok(!tagsBefore(7).includes("#EXT-X-DISCONTINUITY"));
  const range = lines.filter(line => line.startsWith("#EXT-X-DATERANGE"));
  assert.equal(range.length, 1);
  assert.match(range[0], /ID="ad-0",CLASS="io\.hls-dash-live-sim\.ad-break",START-DATE="[^"]+",DURATION=4\.000/);
  const pdt = lines[lines.indexOf("/live/main/segment-6.ts") - 2].slice("#EXT-X-PROGRAM-DATE-TIME:".length);
  assert.ok(range[0].includes(`START-DATE="${pdt}"`), "the range starts at the first ad segment's date");
  assert.equal(live.ad(6), true); assert.equal(live.ad(7), true); assert.equal(live.ad(8), false); assert.equal(live.ad(5), false);
});

test("the discontinuity sequence counts every removed boundary and the range outlives its first segment", () => {
  const now = { ms: 0 }, live = timeline(now);
  const sequenceOf = text => Number(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(text)[1]), first = text => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)[1]);
  let expected = 0, previousFirst = 0;
  for (let step = 0; step < 60; step++) {
    now.ms = step * 2000;
    const text = live.playlist("main"), start = first(text);
    // Boundaries precede sequences 6, 8, 14, 16, ...; one is removed with the segment it precedes.
    for (let n = previousFirst; n < start; n++) if (n > 0 && (n % 8 === 0 || n % 8 === 6)) expected++;
    previousFirst = start;
    assert.equal(sequenceOf(text), expected, "at media sequence " + start);
    const listed = uris(text).map(uri => Number(/segment-(\d+)/.exec(uri)[1]));
    const pods = new Set(listed.filter(n => live.ad(n)).map(n => Math.floor(n / 8)));
    assert.deepEqual(text.split("\n").filter(l => l.startsWith("#EXT-X-DATERANGE")).map(l => Number(/ID="ad-(\d+)"/.exec(l)[1])), [...pods].sort((a, b) => a - b));
  }
});

test("no ad pod leaves the playlist unchanged and invalid pod sizes are rejected", () => {
  const now = { ms: 30000 };
  const text = timeline(now, 0).playlist("main");
  assert.ok(!/DATERANGE|CUE-OUT|CUE-IN/.test(text));
  assert.equal(text, new LiveHlsTimeline(source, "live", 6, () => now.ms, 0, Date.UTC(2026, 0, 1)).playlist("main"));
  for (const bad of [-1, 7, 1.5]) assert.throws(() => timeline(now, bad), /ad-break-segments/);
});

test("a generated session serves ad segments from sample media and rejects ad breaks for a proxied origin", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hls-ads-"));
  const session = await startHlsim({ port: await freePort(), adBreakSegments: 2, mode: "event", faultConfigPath: path.join(directory, "faults.json") });
  try {
    const master = await (await fetch(session.url)).text();
    const child = new URL(uris(master)[0], session.url);
    let text;
    for (let i = 0; i < 80 && !/CUE-OUT/.test(text ?? ""); i++) { text = await (await fetch(child)).text(); if (!/CUE-OUT/.test(text)) await new Promise(r => setTimeout(r, 250)); }
    assert.match(text, /#EXT-X-DATERANGE:ID="ad-0"/);
    const lines = text.split("\n"), ad = lines[lines.findIndex(l => l.startsWith("#EXT-X-CUE-OUT")) + 3];
    const media = await fetch(new URL(ad, child));
    assert.equal(media.status, 200);
    assert.equal(Buffer.from(await media.arrayBuffer())[0], 0x47);
  } finally { await session.close(); await fs.rm(directory, { recursive: true, force: true }); }
  await assert.rejects(startHlsim({ port: await freePort(), adBreakSegments: 2, manifestUrl: "http://127.0.0.1:9/x.m3u8", dummyContent: false }), /generated sample stream/);
});
