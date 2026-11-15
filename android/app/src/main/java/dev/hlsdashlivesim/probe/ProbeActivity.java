package dev.hlsdashlivesim.probe;

import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.SurfaceView;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaLibraryInfo;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.Timeline;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.DecoderCounters;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.source.LoadEventInfo;
import androidx.media3.exoplayer.source.MediaLoadData;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Minimal Media3 ExoPlayer probe for hls-dash-live-sim. It plays one stream muted
 * and POSTs its state as JSON once a second to a harness.
 *
 * <pre>
 * adb shell am start -S -n dev.hlsdashlivesim.probe/.ProbeActivity \
 *   --es url http://10.0.2.2:PORT/live/master.m3u8 \
 *   --es name RUN_ID \
 *   --es report http://10.0.2.2:REPORT_PORT/report \
 *   [--el ms 60000]
 * </pre>
 */
@UnstableApi
public final class ProbeActivity extends Activity {
    private static final String TAG = "HlsDashProbe";
    private static final int MAX_EVENTS = 12;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final ArrayDeque<String> events = new ArrayDeque<>();

    private ExoPlayer player;
    private SurfaceView surface;
    private TextView overlay;
    private String name = "android";
    private String reportUrl;
    private long startedMs;
    private int stalls;
    private int loadErrors;
    private boolean hasBeenReady;
    private long droppedFromEvents;
    private PlaybackException lastError;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            report(false);
            handler.postDelayed(this, 1000);
        }
    };

    private final Runnable stop = () -> {
        report(true);
        finish();
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        surface = new SurfaceView(this);
        root.addView(surface, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER));
        overlay = new TextView(this);
        overlay.setTextColor(Color.GREEN);
        overlay.setTextSize(12);
        overlay.setPadding(16, 16, 16, 16);
        root.addView(overlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.START));
        setContentView(root);
        start(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        start(intent);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        release();
        network.shutdown();
        super.onDestroy();
    }

    private void start(Intent intent) {
        handler.removeCallbacksAndMessages(null);
        release();
        String url = intent.getStringExtra("url");
        if (url == null) {
            overlay.setText("Pass --es url <stream> --es name <run> --es report <harness url>");
            return;
        }
        String runName = intent.getStringExtra("name");
        name = runName != null ? runName : "android";
        reportUrl = intent.getStringExtra("report");
        long stopAfterMs = intent.getLongExtra("ms", 0);
        events.clear();
        stalls = 0;
        loadErrors = 0;
        hasBeenReady = false;
        droppedFromEvents = 0;
        lastError = null;
        startedMs = SystemClock.elapsedRealtime();

        player = new ExoPlayer.Builder(this).build();
        player.setVolume(0f);
        player.setVideoSurfaceView(surface);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                log("state " + stateName(state));
                if (state == Player.STATE_READY) hasBeenReady = true;
                if (state == Player.STATE_BUFFERING && hasBeenReady && player.getPlayWhenReady()) stalls++;
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                lastError = error;
                log("error " + error.getErrorCodeName() + " " + error.getMessage());
            }
        });
        player.addAnalyticsListener(new AnalyticsListener() {
            @Override
            public void onLoadError(EventTime eventTime, LoadEventInfo info,
                                    MediaLoadData data, IOException error, boolean wasCanceled) {
                loadErrors++;
                String status = error instanceof HttpDataSource.InvalidResponseCodeException
                        ? "HTTP " + ((HttpDataSource.InvalidResponseCodeException) error).responseCode
                        : error.getClass().getSimpleName();
                log("loadError " + status + " " + tail(info.uri));
            }

            @Override
            public void onDroppedVideoFrames(EventTime eventTime, int droppedFrames, long elapsedMs) {
                droppedFromEvents += droppedFrames;
            }

            @Override
            public void onVideoInputFormatChanged(EventTime eventTime, Format format,
                                                  androidx.media3.exoplayer.DecoderReuseEvaluation evaluation) {
                log("video " + format.width + "x" + format.height + " " + format.bitrate);
            }
        });

        MediaItem.Builder item = new MediaItem.Builder().setUri(Uri.parse(url));
        String mime = intent.getStringExtra("mime");
        if (mime != null) item.setMimeType(mime);
        else if (url.contains(".mpd")) item.setMimeType(MimeTypes.APPLICATION_MPD);
        else if (url.contains(".m3u8")) item.setMimeType(MimeTypes.APPLICATION_M3U8);
        player.setMediaItem(item.build());
        player.prepare();
        player.setPlayWhenReady(true);
        log("start " + url);
        Log.i(TAG, "run " + name + " url " + url + " report " + reportUrl);

        handler.postDelayed(tick, 1000);
        if (stopAfterMs > 0) handler.postDelayed(stop, stopAfterMs);
    }

    private void release() {
        if (player != null) {
            player.release();
            player = null;
        }
    }

    private void report(boolean complete) {
        if (player == null) return;
        JSONObject state = new JSONObject();
        try {
            Format video = player.getVideoFormat();
            DecoderCounters counters = player.getVideoDecoderCounters();
            long dropped = droppedFromEvents;
            if (counters != null) {
                counters.ensureUpdated();
                dropped = Math.max(dropped, counters.droppedBufferCount);
            }
            long liveOffset = player.getCurrentLiveOffset();
            PlaybackException error = player.getPlayerError() != null ? player.getPlayerError() : lastError;
            state.put("name", name);
            state.put("t", Math.round((SystemClock.elapsedRealtime() - startedMs) / 100.0) / 10.0);
            // A live window slides, so getCurrentPosition() stays near the live offset.
            // "position" adds the window's offset in its first period, and
            // "playheadEpochMs" uses the window's wall-clock start when the stream has one.
            long windowPosition = player.getCurrentPosition();
            long position = windowPosition;
            long playheadEpochMs = C.TIME_UNSET;
            Timeline timeline = player.getCurrentTimeline();
            if (!timeline.isEmpty()) {
                Timeline.Window window = timeline.getWindow(player.getCurrentMediaItemIndex(), new Timeline.Window());
                position += window.getPositionInFirstPeriodMs();
                if (window.windowStartTimeMs != C.TIME_UNSET) playheadEpochMs = window.windowStartTimeMs + windowPosition;
            }
            state.put("position", Math.round(position / 10.0) / 100.0);
            state.put("windowPosition", Math.round(windowPosition / 10.0) / 100.0);
            state.put("playheadEpochMs", playheadEpochMs != C.TIME_UNSET ? playheadEpochMs : JSONObject.NULL);
            state.put("bufferedMs", player.getTotalBufferedDuration());
            state.put("playbackState", stateName(player.getPlaybackState()));
            state.put("playWhenReady", player.getPlayWhenReady());
            state.put("isPlaying", player.isPlaying());
            state.put("errorCode", error != null ? error.errorCode : JSONObject.NULL);
            state.put("errorCodeName", error != null ? error.getErrorCodeName() : JSONObject.NULL);
            state.put("errorMessage", error != null ? describe(error) : JSONObject.NULL);
            state.put("videoWidth", video != null ? video.width : JSONObject.NULL);
            state.put("videoHeight", video != null ? video.height : JSONObject.NULL);
            state.put("videoBitrate", video != null && video.bitrate != Format.NO_VALUE ? video.bitrate : JSONObject.NULL);
            state.put("stalls", stalls);
            state.put("droppedFrames", dropped);
            state.put("loadErrors", loadErrors);
            state.put("liveOffsetMs", liveOffset != C.TIME_UNSET ? liveOffset : JSONObject.NULL);
            state.put("isLive", player.isCurrentMediaItemLive());
            state.put("log", new JSONArray(events));
            state.put("complete", complete);
            state.put("device", isTv() ? "tv" : "phone");
            state.put("ua", String.format(Locale.ROOT, "Android %s (API %d) %s, Media3 %s",
                    Build.VERSION.RELEASE, Build.VERSION.SDK_INT, Build.MODEL, MediaLibraryInfo.VERSION));
        } catch (JSONException e) {
            return;
        }
        overlay.setText(String.format(Locale.ROOT, "%s  %.1fs  %s  %s  stalls %d%s",
                name, player.getCurrentPosition() / 1000.0, stateName(player.getPlaybackState()),
                state.optString("videoHeight") + "p", stalls,
                lastError != null ? "\n" + lastError.getErrorCodeName() : ""));
        if (reportUrl == null) return;
        String body = state.toString();
        String target = reportUrl;
        network.execute(() -> post(target, body));
    }

    private static void post(String target, String body) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(target).openConnection();
            connection.setConnectTimeout(2000);
            connection.setReadTimeout(2000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", "application/json");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(bytes);
            }
            connection.getResponseCode();
        } catch (IOException e) {
            Log.w(TAG, "report failed: " + e);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void log(String event) {
        String line = String.format(Locale.ROOT, "%.1f %s",
                (SystemClock.elapsedRealtime() - startedMs) / 1000.0, event);
        events.addLast(line);
        while (events.size() > MAX_EVENTS) events.removeFirst();
        Log.i(TAG, line);
    }

    private boolean isTv() {
        UiModeManager modes = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
        return modes != null && modes.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
    }

    private static String describe(PlaybackException error) {
        StringBuilder text = new StringBuilder(String.valueOf(error.getMessage()));
        Throwable cause = error.getCause();
        for (int depth = 0; cause != null && depth < 3; depth++, cause = cause.getCause()) {
            text.append(" <- ").append(cause.getClass().getSimpleName());
            if (cause instanceof HttpDataSource.InvalidResponseCodeException)
                text.append(" HTTP ").append(((HttpDataSource.InvalidResponseCodeException) cause).responseCode);
            else if (cause.getMessage() != null) text.append(": ").append(cause.getMessage());
        }
        return text.toString();
    }

    private static String tail(Uri uri) {
        String path = uri.getPath();
        if (path == null) return uri.toString();
        String[] parts = path.split("/");
        return parts.length >= 2 ? parts[parts.length - 2] + "/" + parts[parts.length - 1] : path;
    }

    private static String stateName(int state) {
        switch (state) {
            case Player.STATE_IDLE: return "idle";
            case Player.STATE_BUFFERING: return "buffering";
            case Player.STATE_READY: return "ready";
            case Player.STATE_ENDED: return "ended";
            default: return "unknown";
        }
    }
}
