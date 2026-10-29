# Verification history

Use [current implementation](implementation.md), [playback gates](playback-gates.md)
and the CI run for the candidate commit to assess present behavior. Older evidence
is retained for traceability; it does not override current tests or establish new
platform support. Reports are not rewritten to turn historical failures into passes.

| Report | What it records | Limits |
| --- | --- | --- |
| [Prototype review](public-release-review.md) and [observations](research-evidence.json) | Recovered prototype at `55952e9`, 28 October 2026. | Describes defects before the safety and streaming corrections. |
| [Follow-up verification](follow-up-verification.json) | Earlier safety/protocol regressions and browser smoke. | livesim2 v1.7.0 period exceptions remained; this is superseded for baseline playback. |
| [Diagnostics verification](diagnostics-verification.json) | Redaction, IDs, bounded history, file errors and cancellation. | Earlier suite count; not a complete playback gate. |
| [HTTP scenarios](scenario-verification.json) | Deterministic 404 and successful same-download retry. | Server response evidence alone cannot establish rendered player recovery. |
| [Early browser playback](playback-verification.json) | Long Chrome playback before stabilization. | DASH UTC synchronization was disabled; no physical Roku result. |
| [Early scenario browser check](scenario-browser-verification.json) | Browser recovery from the initial next-video-404 preset. | UTC disabled, older engine exceptions and narrower playback coverage. |
| [Stabilization](stabilization-verification.json) | Recorded strict browser gates and six physical Roku cases, 29 October 2026. | One identified Roku model/OS; native clock internals and internet-isolated Roku remain unverified. |

The [extraction record](extraction.md) documents repository provenance. The old
prototype observational script at `docs/archive/prototype-audit.cjs` is historical,
not the regression suite for the corrected tool.
