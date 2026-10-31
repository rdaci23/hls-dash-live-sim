# Selective rendition outages

Generated HLS now has separate high/low media outage presets. DASH adds a low
video outage alongside its existing high-only compatibility preset. The new
presets reject every selected rendition media GET during session time [60,80)
seconds. Other renditions, playlists, HEAD and (DASH) audio/init/local UTC remain
healthy. Publication continues and delivery restores without a server restart.

```sh
mkdir -p output
npm run hls -- --scenario examples/scenarios/hls-high-rendition-outage.json --fault-config output/rendition-faults.json
# Stop it before using the same config for another session:
npm run hls -- --scenario examples/scenarios/hls-low-rendition-outage.json --fault-config output/rendition-faults.json
npm run dash -- --asset abr --scenario examples/scenarios/dash-low-rendition-outage.json --fault-config output/rendition-faults.json
```

Manual faults must be off. Time starts with the scenario, not the player. HLS's
bundled two-rung TS sample has muxed A/V, so its rendition outage affects that
rendition's audio as well. DASH audio remains independently available.

```sh
npm run rendition:verify
npm run rendition:verify -- --case hls-high
npm run rendition:verify -- --case hls-low --preset-timing
npm run rendition:verify -- --output output/my-rendition-checks
```

The default three-case verifier uses an explicit [5,15) second schedule per case;
`--preset-timing` checks the shipped [60,80) second schedule. HLS requires only
Node; DASH uses the pinned local Docker engine and `abr` asset with local UTC.
The older DASH high-only preset and optional player probe retain their longer
window and existing meaning; this runner does not change that compatibility case.

Each case probes baseline, three outage points and two restored points. It checks
newly published media and retries, a recent historical download and a byte range,
12 injected responses, unaffected resources and HEAD, and the exact same logical
failed downloads/ranges after restoration. The healthy reference is captured
shortly before the outage so it stays in retention; expired resources are not
accepted as a proxy-restoration failure or substituted by another download.

Reports preserve commit/dirty-tree state, effective schedule, protocol/track,
media positions, body hashes/lengths, request/fault IDs, restoration links and
redacted JSONL. Output directories cannot be overwritten. Every response must
correlate with completion diagnostics; missing controls, cancellation, truncated
evidence, wrong-target effects and failed restoration cannot qualify. Only the
full three-case matrix sets `allCasesVerified`. `releaseReady` remains false.

An upstream can ignore Range and return full 200; range support is reported as
observed, with true 206 framing checked where supplied. Healthy HLS playlists and
both video timelines must advance within the outage, and the affected rendition
must continue advancing after restoration.

This is simulator HTTP evidence. It does not prove automatic client fallback,
rendered low quality, re-entry into high quality, audible continuity or native
recovery. Those observations remain separate from correct fault delivery. The
[core roadmap](scenario-roadmap.md) tracks the remaining work before publication.
