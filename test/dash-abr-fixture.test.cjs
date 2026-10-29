const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { XMLParser } = require('fast-xml-parser');
const { initialization, fragment } = require('../scripts/dash-abr/fixture.cjs');
const { validateDashAsset } = require('../dist/support-tools/dash-asset.js');
const root = path.resolve(__dirname, '../assets/dash-abr-sample');
test('DASH ladder contains genuinely coded 180p/360p, aligned 2-second random-access media and separate AAC', () => {
  const text = fs.readFileSync(path.join(root, 'manifest.mpd'), 'utf8'); validateDashAsset(text);
  const doc = new XMLParser({ ignoreAttributes: false }).parse(text).MPD;
  const video = doc.Period.AdaptationSet.find(a => a['@_contentType'] === 'video');
  const audio = doc.Period.AdaptationSet.find(a => a['@_contentType'] === 'audio');
  assert.equal(video.Representation.length, 2); assert.ok(!Array.isArray(audio.Representation));
  assert.equal(Number(video.Representation[0]['@_bandwidth']), 180000); assert.equal(Number(video.Representation[1]['@_bandwidth']), 600000);
  const init = [0, 1].map(id => initialization(fs.readFileSync(path.join(root, 'init-' + id + '.m4s'))));
  assert.deepEqual(init.map(x => [x.width, x.height]), [[320, 180], [640, 360]]);
  assert.equal(init[0].timescale, init[1].timescale);
  let next = 0n;
  for (let n = 1; n <= 6; n++) {
    const reps = [0, 1].map(id => fragment(fs.readFileSync(path.join(root, 'chunk-' + id + '-' + n + '.m4s'))));
    assert.equal(reps[0].baseTime, next); assert.equal(reps[1].baseTime, next);
    assert.equal(reps[0].duration, 2 * init[0].timescale); assert.equal(reps[1].duration, reps[0].duration);
    assert.ok(reps.every(r => r.randomAccess && r.samples === 48)); next += BigInt(reps[0].duration);
  }
  assert.equal(initialization(fs.readFileSync(path.join(root, 'init-2.m4s'))).timescale, 48000);
});
