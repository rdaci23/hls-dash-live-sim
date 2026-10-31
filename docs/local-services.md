# Offline keys, token renewal and UTC faults

These scenarios use the [owned tracks fixture](track-fixtures.md). There are no
external accounts, license servers or signed media URLs. Repository/npm stay
private; this adds AES-128 testing, not commercial DRM.

## HLS AES-128 and key rotation

```sh
npm run build
npm run hls -- --fixture tracks --hls-aes
npm run hls -- --fixture tracks --hls-aes --scenario examples/scenarios/local-key-unavailable.json
npm run hls -- --fixture tracks --hls-aes --scenario examples/scenarios/local-wrong-key.json
```

Video and audio alternate eight-second clear and encrypted cycles: clear,
encrypted key A, encrypted key B, then clear, followed by new encrypted keys.
Whole fragments use AES-128-CBC with PKCS#7 padding. Every encrypted segment has
an explicit sequence-derived 128-bit IV. Initialization stays plaintext, with
METHOD=NONE before its MAP; captions stay clear. These choices follow
[EXT-X-KEY](https://www.rfc-editor.org/rfc/rfc8216.html#section-4.3.2.4) and
[HLS IV rules](https://www.rfc-editor.org/rfc/rfc8216.html#section-5.2).

Keys derive from a random in-memory session secret. Only advertised local key
identities are available, with bounded bookkeeping; responses use no-store and
no key digest validator. Unavailable-key presets return 503; wrong-key presets
return a different 16-byte key. GET is targeted; key HEAD stays healthy. Media,
init and playlists remain HTTP controls. After the window, the same key URI
returns the correct original key and retained ciphertext stays unchanged.
The master secret is erased when the session closes.

Only HLS supports this fixture. Unverified combinations with other scenario
actions are rejected, including through manual catalog controls. Existing clear
MPEG-TS/engine defaults remain unchanged.

## Local media access and renewal

Use `local-token-expiry.json` with authenticated manual runs on either protocol.
Set HLS_DASH_CONTROL_TOKEN to a private value of at least 16 characters, then:

```sh
npm run hls -- --fixture tracks --scenario-start manual --scenario examples/scenarios/local-token-expiry.json
npm run dash -- --fixture tracks --scenario-start manual --scenario examples/scenarios/local-token-expiry.json
```

Start the connected run through the control UI/API. POST `/scenario/access` with
JSON `{ "runId": "CURRENT_RUN_ID" }`, the same control Bearer token and
X-Sim-Session-Id used by arm/start/reset. The response contains `accessToken` and
uses no-store. GET/HEAD cannot issue tokens. Wrong token/session/run or unsupported
fields reject. Keep the returned token in your player's memory and send
`Authorization: Bearer ACCESS_TOKEN` on media requests.

Manifests, initialization, UTC and media HEAD remain controls. The access token
issued before the expiry deadline stops authorizing media at `afterMs`, returning
401 with a local Bearer challenge. Issue a new token through the same authenticated
endpoint to restore the **same media URLs and bytes**; previous tokens stay
invalid. Early renewal does not bypass the expiry deadline. Reset destroys the
run's credentials. Legacy automatic-start scenarios retain their behavior; this
new token scenario explicitly requires manual authenticated controls.

Keys, control/access tokens and secret hashes never enter scenario reports or
exported diagnostics. Do not paste tokens into URLs, bug reports or public logs.
The browser verifier's explicit authentication client receives an actual HTTP
401, renews once and retries that same request before handing the response to the
player. It does not restart or seek. This verifies the authenticated client path;
it does not claim that a bare player's default 401 handling recovers. The earlier
bare-player HLS probe stopped on a fatal subtitle 401, retained as a compatibility
limit. Reports state whether the player itself saw the 401.

## Named local UTC faults

DASH continues to advertise its local UTC endpoint with normal player
synchronization enabled. Use one of:

```sh
npm run dash -- --fixture tracks --scenario examples/scenarios/local-utc-unavailable.json
npm run dash -- --fixture tracks --scenario examples/scenarios/local-utc-malformed.json
npm run dash -- --fixture tracks --scenario examples/scenarios/local-utc-skew.json
```

Unavailable UTC returns 503. Malformed UTC returns an invalid ISO body and Date
header. Skew adds an explicit bounded offset to both. These named clock faults
apply to UTC GET **and HEAD**, without changing media/manifest/init/key HEAD
exclusions. Publication/availability clocks keep advancing normally; the bad
clock is deliberate. Outside the named window, local UTC is healthy again.

Version-1 `services` accepts only a supported kind, afterMs/beforeMs and skewMs
for utc-skew. Windows are at most 60 seconds, scheduling at most one day ahead;
skew must be 1–300 seconds in either direction. Arbitrary URLs, headers, file paths
and compositions are rejected.

## Verification

```sh
npm run services:verify -- --output output/local-services
npm run browser:services -- --output output/service-playback
```

The seven HTTP cases verify statuses, repeated IDs, scope, HEAD behavior, correct
key restoration, same-media token renewal, clock values and credential-free
exports. Unit checks independently decrypt actual ciphertext and verify rotation,
clear transitions and plaintext initialization. Browser checks retain exact player
versions/retry settings: a three-minute rendered/decoded AES baseline across key
cycles, plus HLS/DASH token renewal after a verified healthy lead-in. HTTP success
alone does not establish player recovery from a wrong key or clock fault. Those
compatibility claims need their own observations; see the [roadmap](scenario-roadmap.md).
