# Android playback probe

A minimal Media3 ExoPlayer app for checking the simulator's streams on Android
phones, Android TV and Google TV. It plays one HLS or DASH URL muted, with the
player's default settings, and POSTs its state as JSON once a second to a URL you
give it. It has no controls, retries or recovery logic of its own, so what it
reports is what ExoPlayer does by itself.

This app is a test tool. It is not part of the npm package, and its results are
exploratory observations, not release gates. Results from an emulator run on the host
computer and use its network, so they are not device evidence.

## Build

Requirements: JDK 17 and an Android SDK with platform 36 and build tools. Gradle
is not needed; the wrapper downloads Gradle 8.14.3 and checks its SHA-256.

```sh
cd android
export JAVA_HOME=/path/to/jdk-17          # e.g. /opt/homebrew/opt/openjdk@17
export ANDROID_HOME=/path/to/android-sdk   # or write sdk.dir to local.properties
./gradlew assembleDebug
```

The APK is `android/app/build/outputs/apk/debug/app-debug.apk`. It uses
Media3 1.11.1 (`media3-exoplayer`, `-hls` and `-dash`), `minSdk` 23 and
`targetSdk` 36. One APK runs on phones and TVs: it declares both the launcher and
the Leanback launcher, and does not require a touchscreen.

## Emulators

These are the two emulators the [device fault matrix](../docs/device-fault-matrix.md)
used. Install the system images with `sdkmanager` first.

```sh
avdmanager create avd -n hlsim_phone_api35 -d pixel_7 \
  -k "system-images;android-35;google_apis;arm64-v8a"
avdmanager create avd -n hlsim_tv_api36 -d tv_1080p \
  -k "system-images;android-36;android-tv;arm64-v8a"
emulator -avd hlsim_phone_api35 -port 5580 -no-snapshot-save &
emulator -avd hlsim_tv_api36 -port 5582 -no-snapshot-save &
adb -s emulator-5580 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5582 install -r app/build/outputs/apk/debug/app-debug.apk
```

An emulator reaches the host computer at `10.0.2.2`. Start the simulator with
`--allow-host 10.0.2.2` so it accepts that Host header:

```sh
npm run hls -- --allow-host 10.0.2.2   # prints http://127.0.0.1:8899/proxy.m3u8
```

Replace `127.0.0.1` in the printed URL with `10.0.2.2`. For a device on the LAN, start the simulator with `--host 0.0.0.0 --allow-host
COMPUTER_LAN_IP` and use the computer's LAN address in the URLs below.

## Run

```sh
adb shell am start -S -n dev.hlsdashlivesim.probe/.ProbeActivity \
  --es url http://10.0.2.2:8899/proxy.m3u8 \
  --es name run-1 \
  --es report http://10.0.2.2:38897/report \
  --el ms 60000
```

| Extra | Meaning |
| --- | --- |
| `url` | Stream URL. A URL containing `.mpd` plays as DASH and `.m3u8` as HLS. |
| `name` | Run name, copied into every report. |
| `report` | Optional. Receives one JSON POST per second. |
| `ms` | Optional. Stops playback and closes the app after this many milliseconds. |
| `mime` | Optional. Overrides the content type, for example `application/dash+xml`. |

`am start -S` stops any earlier run first. `adb shell am force-stop
dev.hlsdashlivesim.probe` stops a run. `adb logcat -s HlsDashProbe` shows the
same events the reports carry.

## Report

Each POST body is one JSON object:

| Field | Meaning |
| --- | --- |
| `name`, `t` | Run name and seconds since the run started. |
| `position` | Playback position in seconds, measured from the start of the stream's first period so that it keeps increasing in a live window. |
| `windowPosition` | ExoPlayer's `getCurrentPosition()`, relative to the live window. |
| `playheadEpochMs` | Wall-clock time of the playhead when the stream states one (DASH, or HLS with `EXT-X-PROGRAM-DATE-TIME`); `null` otherwise. |
| `playbackState`, `playWhenReady`, `isPlaying` | `idle`, `buffering`, `ready` or `ended`, and whether it is playing. |
| `errorCode`, `errorCodeName`, `errorMessage` | The player error, with up to three causes (HTTP status included); `null` without one. |
| `videoWidth`, `videoHeight`, `videoBitrate` | The selected video format. HLS bitrates are the variant's `BANDWIDTH`. |
| `stalls` | Times playback went back to buffering after it had been ready. |
| `droppedFrames` | Dropped video frames. |
| `loadErrors` | Failed loads, including ones ExoPlayer retried. |
| `liveOffsetMs` | Distance behind the live edge; `null` for VoD. |
| `bufferedMs`, `isLive` | Buffered duration ahead of the playhead, and whether the item is live. |
| `log` | The last twelve events: state changes, errors, load errors with their HTTP status, and video format changes. |
| `complete`, `device`, `ua` | `true` in the last report of a timed run; `phone` or `tv`; Android, model and Media3 versions. |
