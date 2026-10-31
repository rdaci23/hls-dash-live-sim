# Owned audio and caption fixture research

Research checked 2026-10-31 against pinned player source and installed tools. This is an implementation recommendation, not a claim of ISO conformance or completed playback evidence. The complete ISO/IEC 14496-30 text was not available in the inspected primary sources; the box details below are cross-checked against primary encoder/parser implementations. No upstream media should be copied into the fixture.

## Findings and proposed fixture

Use a new, offline, static fixture: procedural H.264 video, two separately encoded AAC renditions with different continuous tones, and two authored language tracks. Reuse the same A/V fragments for HLS fMP4 and DASH where timings permit. Put explicit language identifiers and distinguishable payload markers in the text (for example `EN cue 1` / `RO cue 1`). Include an interval with no captions in both languages and return to a visible cue afterward. These are proposed test-design choices.

Local inspection: `scripts/generate-fixtures.cjs` currently generates 12 seconds of video and a 440 Hz tone; HLS includes audio inside MPEG-TS renditions, while DASH separates video and AAC. `assets/dash-sample/manifest.mpd` contains no text adaptation. `scripts/dash-abr/fixture.cjs` already inspects basic initialization/fragment timing. The new fixture therefore needs independent assets rather than assuming the baseline already proves alternate audio or captions.

## Small, structurally complete wvtt layout

The MSE ISO BMFF byte-stream note defines initialization as `ftyp` then `moov`, empty initialization sample tables and `mvex`; media segments contain optional `styp`, then `moof` and `mdat`. It requires `tfdt` and movie-fragment-relative addressing. This describes the generic fragmented-container envelope; it does not establish native browser support for `application/mp4; codecs="wvtt"`. [Container envelope](https://www.w3.org/TR/mse-byte-stream-format-isobmff/#initialization-segments), [fragment rules](https://www.w3.org/TR/mse-byte-stream-format-isobmff/#media-segments).

Recommended small builder profile, rather than an absolute byte-minimum claim:

```text
ftyp
moov
  mvhd
  trak
    tkhd                         track_ID consistent throughout
    mdia
      mdhd                       timescale = 1000; language per track
      hdlr                       handler_type = text
      minf
        nmhd
        dinf / dref / url         self-contained URL entry
        stbl
          stsd / wvtt             6 reserved bytes; data_reference_index = 1
            vttC                 UTF-8 WEBVTT header, e.g. WEBVTT followed by LF LF
          stts, stsc, stsz, stco  zero entries/samples
  mvex / trex                    matching track_ID; sample_description_index = 1

moof
  mfhd                           monotonically increasing sequence number
  traf
    tfhd                         track_ID; default-base-is-moof = 0x020000
    tfdt                         baseMediaDecodeTime in mdhd timescale
    trun                         flags = 0x000301: data_offset, duration, size
mdat
  vttc / payl                     a displayed sample: UTF-8 cue text only
  OR vtte                         a no-caption sample: 8-byte box, no payload
```

The upstream MP4 writer uses the eight-byte sample-entry prefix followed by `vttC`, with optional source label. Its cue writer requires `payl` inside `vttc`, makes identifiers/settings optional, and writes `vtte` as a header-only box. Text media uses `nmhd`. All sizes include their box headers; `payl`/`vttC` strings use their byte lengths without an invented full-box version/flags word or required NUL terminator. [Primary writer implementation](https://raw.githubusercontent.com/shaka-project/shaka-packager/v3.4.2/packager/media/formats/mp4/box_definitions.cc), [entry definitions](https://raw.githubusercontent.com/shaka-project/shaka-packager/v3.4.2/packager/media/formats/mp4/box_definitions.h).

For that profile, place one `traf` and one `trun` in each `moof`; set `trun.data_offset` to the byte length of `moof` plus the eight-byte `mdat` header. Write duration and size for every sample. Use no composition offsets, so CTS equals DTS. These choices simplify construction and avoid relying on player defaults.

A sample describes its entire display interval; it contains all cues active in that interval. Split a segment whenever the active set changes. For a 2-second segment, a practical pattern is `vtte` for 0–0.25 s, `vttc(payl)` for 0.25–1.5 s, and `vtte` for 1.5–2 s. A fully empty segment still has one timed `vtte` sample spanning the segment. This matches the primary conversion implementation, which partitions time at cue changes and emits empty samples between cues. [Interval construction](https://raw.githubusercontent.com/shaka-project/shaka-packager/v3.4.2/packager/media/formats/webvtt/webvtt_to_mp4_handler.cc).

## Pinned player parser and manifest contract

In dash.js v5.2.1, `TextSourceBuffer.append` dispatches fragmented text when the codec description includes `application/mp4`. Initialization reads `mdhd.timescale`; subsequent samples use CTS and sample duration. The WebVTT path parses sample bytes into boxes, extracts `payl`, skips `vtte`, and still records the empty sample's buffered interval. Caption times receive the buffer timestamp offset when added to text tracks. [Pinned TextSourceBuffer](https://raw.githubusercontent.com/Dash-Industry-Forum/dash.js/v5.2.1/src/streaming/text/TextSourceBuffer.js).

`BoxParser.getSamplesInfo` expects `mfhd`, `tfhd`, `tfdt` and `trun`. It computes the sample byte position from the `moof` offset plus `tfhd.base_data_offset` (or zero) plus `trun.data_offset`. Sample durations/sizes come from `trun` or `tfhd`, **not `trex`** in this path. `getMediaTimescaleFromMoov` takes the first `mdhd`; keep text-only initialization segments. [Pinned BoxParser](https://raw.githubusercontent.com/Dash-Industry-Forum/dash.js/v5.2.1/src/streaming/utils/BoxParser.js).

The dependency is codem-isoboxer 0.3.10 (also observed locally). Its parser recognizes `vttc` as a box container, reads `payl` as UTF-8 `cue_text`, and recognizes empty `vtte`. The application therefore parses wvtt itself rather than depending on native MSE text decoding. [Pinned ISOBoxer](https://raw.githubusercontent.com/madebyhiro/codem-isoboxer/v0.3.10/dist/iso_boxer.js), [player dependency declaration](https://raw.githubusercontent.com/Dash-Industry-Forum/dash.js/v5.2.1/package.json).

Proposed MPD: static MPD, one period starting at zero, separate text `AdaptationSet`s with distinct IDs and `lang="en"` / `lang="ro"`, `contentType="text"`, `Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"`, and one representation each with `mimeType="application/mp4"`, `codecs="wvtt"`, positive bandwidth, and owned initialization/media URLs. This MIME/codec/role combination matches the primary packager fixture. [Reference MPD](https://raw.githubusercontent.com/shaka-project/shaka-packager/v3.4.2/packager/app/test/testdata/segmented-webvtt-mp4/output.mpd).

Choose `mdhd.timescale=1000` and `SegmentTemplate@timescale=1000`. With 2-second segments, `tfdt=2000*n`; use `duration=2000` and `$Number$` beginning at 1, or a `SegmentTimeline` with `S t="0" d="2000" r="N-1"` (omit `duration` in that case). Keep PTO zero initially. Timeline mapping is `presentation = Period.start + (sampleTime - PTO) / timescale`; PTO is expressed in MPD timescale units, not seconds. If MPD and track timescales differ, convert their quantities independently before subtraction. This mapping and explicit-timeline restrictions come from the timing guidelines. [Timing model §§9.1,18.3](https://dashif.org/Guidelines-TimingModel/).

Select fragmented text using the public `player.setTextTrack(index)` after tracks are available; `-1` turns text off. Merely changing the native track mode is insufficient to request the fragmented-track switch. The controller hides the previous track and invalidates its cue window. Match language to the enumerated track index rather than assuming index equals language forever. [Public selector](https://raw.githubusercontent.com/Dash-Industry-Forum/dash.js/v5.2.1/src/streaming/MediaPlayer.js), [switch controller](https://raw.githubusercontent.com/Dash-Industry-Forum/dash.js/v5.2.1/src/streaming/text/TextController.js).

## HLS text and observable caption evidence

For HLS, use separate `TYPE=AUDIO` and `TYPE=SUBTITLES` rendition groups, attach both group IDs to each variant, and give audio renditions explicit URIs. WebVTT segments need a header or applicable map. Include every cue overlapping a segment, with its full cue timestamps; an empty segment legitimately has no cues. Add `X-TIMESTAMP-MAP` reflecting the actual A/V timestamp origin; zero mapping is only appropriate when the generated media origin is zero. [HLS §§3.5,4.3.4.1,4.3.4.2](https://www.rfc-editor.org/rfc/rfc8216.html).

Acceptance proposal: record `video.currentTime`, track language/mode and `activeCues` repeatedly while media time advances. Assert the language-specific payload inside its intended interval, then an empty active-cue list during a known gap, then the next cue. Exercise language A→B and captions off; evaluate only the selected showing track because a hidden track may still maintain active cues. `cues` proves loading; `activeCues` proves current activation. Disabled tracks can return null, so null alone does not establish an authored empty interval. Use a small boundary tolerance and require samples safely inside each interval. [Native text-track API and modes](https://html.spec.whatwg.org/multipage/media.html#text-track-api).

## FFmpeg and browser decoded audio

Local FFmpeg is 7.1.1 and includes AAC and WebVTT encoders. Two temporary one-cue conversions, with `-c:s webvtt` and with additional `-tag:s wvtt`, both failed to write fragmented MP4 (exit 234; codec unsupported in container). The temporary files were removed. The pinned MP4 muxer source contains no WebVTT muxing path. Use FFmpeg for owned A/V and an owned small box builder for wvtt; do not infer MP4 support from the presence of the WebVTT text encoder. [FFmpeg 7.1.1 MP4 muxer](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1.1/libavformat/movenc.c).

Audio evidence proposal: route the playing video through one `MediaElementAudioSourceNode → AnalyserNode → GainNode(0) → destination`; leave element audio enabled and silence after analysis. Generate well-separated tones such as 440 and 880 Hz. With `fftSize=4096` and zero smoothing, classify energy near each expected frequency using the actual context sample rate (`binHz = sampleRate/4096`), require adequate RMS and dominance over the other tone, and collect several fresh windows after switching. Record classification alongside advancing media time and selected rendition ID. Assert the decoded signal changes A→B→A; selection events/network traffic alone do not establish that.

The Web Audio specification provides FFT/time-domain analysis and reroutes media-element output through the graph. Cross-origin media without readable CORS access produces silence; a suspended context repeatedly returns unchanged analysis data. Resume via the browser's allowed interaction path and require `context.state === "running"`. FFT windows span time and are not sample-exact media-timeline observations. This establishes decoded media-element output in the tested browser, not physical speaker audibility, universal native track support, or precise A/V lip sync. [Analyser](https://www.w3.org/TR/webaudio-1.0/#AnalyserNode), [media source/CORS](https://www.w3.org/TR/webaudio-1.0/#MediaElementAudioSourceNode), [suspension behavior](https://www.w3.org/TR/webaudio-1.0/#dom-audiocontext-suspend).
