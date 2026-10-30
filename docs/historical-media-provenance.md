# Historical media: FFmpeg test-content evidence

Investigation: 29 October 2026. This concerns the four original prototype files
retained in Git history, rather than the current regenerated HLS/DASH fixtures.

**Finding:** the evidence strongly supports FFmpeg-generated test-pattern video
and synthesized tone. The exact original shell command was not recovered.

## Trace to the introducing commit

The original private tools project’s commit
`b1356697404887ca2e49a3ae3a55da0577f421d5`, dated 3 November 2025, introduced
`assets/hls-sample/segments/segment0.ts`, `segment1.ts`, `audio0.aac` and
`audio1.aac`. Its README describes the bundled content as color-bar video plus
tone, with 720p video and mono audio. All four files are byte-identical to the
copies extracted into this repository at `9ff737c`.

The original tree's scripts, simulator source and documentation were searched
for FFmpeg/testsrc/sine generation commands. None was found in that source tree;
the input command below is reconstructed from measured content, not quoted from
an original generation script. Personal configuration/auth files were excluded
from this investigation.

## Whole-video comparison

Both video segments decode as H.264, 1280×720, 24 fps. Compare their complete
288-frame sequence against freshly generated FFmpeg `testsrc`:

| Segment | Reference frame range | Frames compared | Mean SSIM | Lowest frame SSIM |
| --- | --- | --- | --- | --- |
| `segment0.ts` | 0–249 | 250 | 0.999376 | 0.999248 |
| `segment1.ts` | 250–287 | 38 | 0.999401 | 0.999215 |

SSIM near 1 establishes a very close decoded-image match; it is not byte equality
of encoded video. The small differences are consistent with the recorded lossy
H.264 encoding. This checks the whole video sequence, rather than identifying a
pattern from one screenshot.

The first H.264 stream's SEI contains the libx264 encoder signature: core 164,
r3108, CRF 23, keyint 250 and other normal encoder settings. AAC data contains
`Lavc61.19.101`, FFmpeg's libavcodec encoder marker. Those signatures establish
encoding-tool evidence; the generated-frame comparison establishes content-source
evidence.

## Audio and exact demux match

The audio is mono AAC at 48 kHz. Measured frequencies across all four media files
are approximately 1,000 Hz. Multiple half-second windows across each file were
checked after the initial 0.1 seconds and before the final 1,024 samples, avoiding
codec boundary/padding effects. The separate AAC files' minimum fitted 1,000 Hz
power fraction exceeds 0.9995 in those windows. Detailed measurements include
boundary variation in the short second TS segment.

There is also an exact relationship between the files: concatenating `audio0.aac`
and `audio1.aac` produces exactly the same 93,099 bytes as demuxing the first TS
segment's audio to ADTS with codec copy. Both hashes are:

```text
8c7bff17208a18f0315f45f5068c2514b06d11426710d8d06fea3251f1cac237
```

This ties the standalone AAC fixtures to the same synthetic-tone source.
[Machine-readable hashes and measurements](historical-media-provenance.json).

## Reconstructing the source content

These filter inputs reproduce the observed pattern and tone:

```sh
-f lavfi -i testsrc=size=1280x720:rate=24
-f lavfi -i sine=frequency=1000:sample_rate=48000
```

This is not presented as the exact original command or a promise of matching
encoded bytes. Encoder versions, thread counts, muxing options and segment cuts
can change those bytes.

To repeat the whole-video comparison, extract only the historical media into an
ignored private output directory. The first comparison uses reference frames
0–249; the second trims the reference to frames 250–287 and resets timestamps.
Both sides are converted to yuv420p before FFmpeg's `ssim` filter. Analysis used
FFmpeg 7.1.1. To repeat the exact audio relationship:

```sh
ffmpeg -i segment0.ts -map 0:a:0 -c:a copy -f adts demuxed.aac
cat audio0.aac audio1.aac > concatenated.aac
cmp demuxed.aac concatenated.aac
```

No source media, generation scripts or Git history were modified during this
investigation. The maintainer confirmed publication authority on 30 October 2026.
Project-owned code, documentation and generated media fixtures use the
[MIT License](../LICENSE), selected on the same date. This investigation resolves
the technical question of what the historical test media contains.
