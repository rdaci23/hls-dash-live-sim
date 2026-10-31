# A three-minute local demonstration

Start with the [setup guide](getting-started.md): one healthy HLS server and its
control UI using the same `output/demo-faults.json` file. This demonstration needs
Node and a browser; no Docker, private media, credentials or physical device.

1. Open the control UI, paste the printed HLS URL and select **Load Manifest**.
   The connected-stream card shows protocol, mode, session and a playback URL.
   Select the low HLS child playlist under **Generated manifest**. Refresh it;
   the live sequence advances as media is published. This is a baseline preview: it
   leaves armed faults untouched and bypasses local freeze/cache behavior.
2. Select **Copy Playback URL** for your player. **Copy Manifest** or
   **Download Manifest** exports the currently displayed text. A downloaded
   playlist still needs the original server as its base for relative media URLs.
3. Select **Inject 404 Segment**. The saved fault is armed for one media GET.
   If you do not have a player connected, exercise that request from another
   terminal in the checkout:

   ```sh
   node examples/request-segment.cjs http://127.0.0.1:8899/proxy.m3u8
   ```

   It fetches the generated playlist and makes two requests for the same segment.
   With no other media clients consuming the one-shot, expect status 404 followed
   by 200 with nonempty media. It prints request/fault IDs for correlation.
4. Select **Refresh Stream Status**. The runtime one-shot shows consumed. The
   saved configuration still says `once`; that is arm mode, not a pending count.
   Reading status or using the manifest viewer leaves faults untouched. A real
   playback URL still exercises the configured scenario.
5. Set bandwidth to 450 kbps and jitter to 150 ms, then select **Apply Network
   Conditions**. Run the helper again or watch your own player. Select **Clear
   Network Conditions**, then **Reset (all off)** to restore the baseline.

The helper demonstrates actual HTTP fault delivery and retry; it does not render
video and cannot prove player recovery. The separate `npm run browser:verify`
checks rendered playback in Chrome. An already-buffered player may show no stall
from one missing segment; that is not evidence that the fault was absent.

![Connected stream and copyable playback URL](images/control-demo.png)

![Generated HLS baseline preview and export controls](images/manifest-demo.png)

Screenshots were captured from the real control page using a temporary healthy
sample session. Ports, session IDs and temporary paths vary per run.

For a deterministic test, move on to the [three scenario recipes](scenario-recipes.md).
