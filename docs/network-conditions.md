# Bandwidth limits and jitter

The generated HLS server, HLS origin proxy and DASH fault proxy support these
manual network settings. Defaults are zero, preserving ordinary playback. The
DASH `--no-fault-proxy` path and HLS Docker MP4 VoD do not provide these controls.

## Configure

In the control page, use **Network conditions**:

- **Bandwidth limit (kbps):** an integer from 0 to 1,000,000 decimal kilobits per
  second. 1,000 kbps = 1 Mbps = 125,000 bytes/s. Zero disables the ceiling.
- **Jitter (ms):** an integer from 0 to 60,000. Each eligible GET samples an
  independent uniform integer from zero through this value, inclusive. Zero
  disables jitter. Samples use unseeded randomness.

Select **Apply Network Conditions** or include them in **Save Config**.
**Clear Network Conditions** clears both settings; **Reset (all off)** also clears
fixed latency and other faults. Saved and runtime summaries show these values.
Use the same fault file for the control server and simulator.

Equivalent partial configuration, for example a 500 kbps cap and up to 150 ms of
extra response delay:

```json
{
  "network": {
    "bandwidthKbps": 500,
    "jitterMs": 150
  }
}
```

Submit it with `POST /config` or merge it into the shared file. Older configurations
without `network` keep both settings disabled. Invalid, fractional, negative or
out-of-range values return HTTP 400 without changing the saved configuration.
[Example complete config](../examples/faults.json).

## Scope

| Request | Bandwidth ceiling | Jitter |
| --- | --- | --- |
| Media/init GET returning 200 or 206 | Shared session cap on response body | Extra delay before response |
| Manifest GET | No | Extra delay before response |
| Injected/upstream media error | No body throttling | Eligible request can still incur its sampled pre-response delay |
| HEAD | No | No; the older fixed-latency control can still delay HEAD |
| HLS key | No | No; existing HLS key faults and fixed latency remain separate |
| Health, diagnostics, scenario reports, DASH UTC, control API | No | No |

The ceiling is shared across concurrent audio, video and initialization downloads
handled by one simulator process. Two concurrent 10 kB downloads share the same
80 kbps (10 kB/s) budget and take roughly two seconds together, allowing for normal
overhead and small pacing bursts. Separate simulator processes have independent
budgets, even if they share a configuration file.

Total start delay is **fixed latency + sampled jitter**. At both maximum settings,
that can be 120 seconds. Jitter changes when a response starts, not MPD availability,
media timestamps or the local UTC clock. It does not introduce per-chunk jitter.
The manifest viewer allows a longer timeout to accommodate deliberate delays.

## Transfers and live changes

Media is delivered progressively through a FIFO session token bucket. Idle credit
is capped at 50 ms and individual writes at 16 KiB. This is an application egress
ceiling with small bursts, not an exact instantaneous wire rate. Event-loop load,
client backpressure and upstream fetching can make transfers slower.

The proxy still buffers upstream responses before serving them, with the existing
per-resource limits. It does not shape upstream downloads, emulate packet loss,
change TCP, or provide low-latency media parts. Pending shaped bodies are limited
to 128 transfers and 64 MiB of payload retained for pacing per session; exceeding
either returns HTTP 503 rather than growing an unlimited queue. These limits do
not describe total process memory or upstream fetch buffers.

Rate changes affect already-throttled transfers. Clearing the cap releases queued
writers, still respecting backpressure. Enabling a cap cannot recall bytes already
queued by an unthrottled response; it applies to new responses. Fixed/jitter delay
is sampled once per request, so edits apply to new waits, not a wait already in
progress. Disconnect and session shutdown cancel both waits and paced transfers;
cancelled queue entries reserve no future credit.

Content-Length, Content-Range, status and bytes stay intact unless an explicit
corruption/status fault is enabled. Successful range responses consume only their
actual returned bytes. [Diagnostics](diagnostics.md#network-shaping-events) record
selected rates, sampled delays, completion and cancellation without media bodies.

## Scenarios and evidence

The current scenario format owns HTTP status faults and rejects enabled manual
network settings at startup or while a scenario is active. Seeded jitter, timed
rate changes and scenario-driven shaping are future work. Do not assume a scenario
silently incorporates the manual network profile.

Automated checks exercise generated HLS, origin HLS and DASH proxy responses:
shared concurrent throughput, progressive delivery, exact bytes/ranges, jitter
bounds and diagnostics, live clearing, cancellation, shutdown, capacity limits,
metadata/clock/key exclusions and UI/API validation. The real livesim2 integration
also fetches shaped initialization and media for audio/video around periods.

These HTTP checks establish server shaping behavior. The separate
[HLS automatic ABR check](hls-abr.md) and [DASH ladder check](dash-abr.md) measure
bandwidth-driven rendered adaptation and restoration for their two-rendition
fixtures. The default DASH sample remains single-rendition; select `--asset abr`
for its ladder. Broader player recovery remains unverified. In particular,
bandwidth downshift does not prove HTTP-error fallback; the DASH compatibility
probe retains a failed default dash.js result separately from verified server
fault isolation. Broader network profiles need separate evidence.
The [release checklist](release-checklist.md) retains those limits; the repository
and npm package remain private.
