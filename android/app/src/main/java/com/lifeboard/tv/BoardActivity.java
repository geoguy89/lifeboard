package com.lifeboard.tv;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.graphics.Matrix;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * The board, fullscreen, with corrected touch.
 *
 * The whole app is a WebView pointed at a LifeBoard server, which sounds
 * trivial and is not: a wall display has nobody in front of it to dismiss a
 * dialog, retry a failed load, swipe away the navigation bar, or tell it the
 * Wi-Fi came up thirty seconds after the TV did. Everything here is one of
 * those cases.
 */
public class BoardActivity extends Activity {

    /** Retry loading forever, but back off - the Pi may still be booting. */
    private static final int[] RETRY_MS = {1500, 2000, 3000, 5000, 8000, 15000, 30000};

    /** Long-press this corner to get at the settings from a wall. */
    private static final float CORNER = 0.10f;
    private static final long HOLD_MS = 1500;

    private WebView web;
    private TextView message;
    private Matrix touchMatrix;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private int retryIndex = 0;
    private boolean loadFailed = false;
    private long cornerDownAt = 0;
    private String lastConsoleError = null;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Kiosk.goFullscreen(getWindow());
        applyOrientation();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0b0d11"));

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // The board plays video without anyone touching it, which every
        // browser blocks by default. The Chromium kiosk on the Pi passes
        // --autoplay-policy=no-user-gesture-required for exactly this reason.
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);   // never inherit the TV's font scaling

        // No text selection, no callout, no long-press menu. The board handles
        // its own touches and a magnifier popping up over a task list is only
        // ever in the way.
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);
        web.setOnLongClickListener(v -> true);
        web.setBackgroundColor(Color.parseColor("#0b0d11"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        /* Console messages, onto the screen and into logcat.
         *
         * A wall display has no devtools and usually no adb attached, so a
         * JavaScript error is otherwise completely invisible - the symptom is
         * a black screen and nothing else. compat.js paints errors onto the
         * page itself; this is the second copy, for the case where the failure
         * stops the page painting anything at all. */
        web.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                String text = message.message()
                        + " (" + message.sourceId() + ":" + message.lineNumber() + ")";
                if (message.messageLevel() == android.webkit.ConsoleMessage
                        .MessageLevel.ERROR) {
                    android.util.Log.e("LifeBoardWeb", text);
                    lastConsoleError = text;
                } else {
                    android.util.Log.d("LifeBoardWeb", text);
                }
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                // Only the main document matters. A widget's failed fetch is
                // the board's problem and it already handles it.
                if (request != null && request.isForMainFrame()) showRetry();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!loadFailed) {
                    message.setVisibility(View.GONE);
                    retryIndex = 0;
                }
                // Recorded once so a bug report has the number in it. "The
                // WebView is too old" is not actionable; "WebView 68, needs
                // 86" tells somebody exactly what to update.
                android.util.Log.i("LifeBoardWeb", "loaded " + url
                        + " | engine: " + engineVersion());
            }
        });

        message = new TextView(this);
        message.setTextColor(Color.parseColor("#c9ced8"));
        message.setTextSize(18);
        message.setGravity(Gravity.CENTER);
        message.setPadding(48, 48, 48, 48);
        message.setVisibility(View.GONE);

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(message, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyOrientation();
        // Re-read every time: the calibration screen is another activity, so
        // coming back from it has to pick up what it saved.
        touchMatrix = Calibration.toMatrix(Calibration.load(this));

        // The server lives in this app, so starting it is this app's job. It
        // is a foreground service rather than a thread here, because the board
        // has to survive somebody pressing HOME - see ServerService.
        ServerService.start(this);

        String url = Kiosk.boardUrl(this);
        if (url.isEmpty()) {
            startActivity(new Intent(this, SettingsActivity.class));
            return;
        }
        loadFailed = false;
        web.loadUrl(url);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) Kiosk.goFullscreen(getWindow());
    }

    private void applyOrientation() {
        String want = Kiosk.orientation(this);
        if ("portrait".equals(want)) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        } else if ("landscape".equals(want)) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
    }

    /**
     * Correct the touch before anything sees it.
     *
     * Done here rather than in the WebView so that every child - the page, the
     * error message, the settings gesture - gets the same corrected
     * coordinates. MotionEvent.transform does the work; the identity matrix
     * when uncalibrated costs nothing measurable.
     */
    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        if (touchMatrix != null) event.transform(touchMatrix);
        watchForSettingsGesture(event);
        return super.dispatchTouchEvent(event);
    }

    /**
     * A long press in the top-left corner opens the settings.
     *
     * It has to be something nobody does by accident on a board full of
     * checkboxes, and something a person can be told over the phone. A hidden
     * multi-tap is neither. Note this runs on CORRECTED coordinates: if the
     * calibration is so far out that the corner is unreachable, the remote's
     * MENU key below is the way in.
     */
    private void watchForSettingsGesture(MotionEvent event) {
        float w = getWindow().getDecorView().getWidth();
        float h = getWindow().getDecorView().getHeight();
        boolean inCorner = event.getX() < w * CORNER && event.getY() < h * CORNER;

        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                cornerDownAt = inCorner ? System.currentTimeMillis() : 0;
                break;
            case MotionEvent.ACTION_MOVE:
                if (!inCorner) cornerDownAt = 0;
                else if (cornerDownAt > 0
                        && System.currentTimeMillis() - cornerDownAt > HOLD_MS) {
                    cornerDownAt = 0;
                    openSettings();
                }
                break;
            default:
                cornerDownAt = 0;
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_MENU:
            case KeyEvent.KEYCODE_SETTINGS:
                openSettings();
                return true;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_F5:
                web.reload();
                return true;
            case KeyEvent.KEYCODE_BACK:
                // Swallowed on purpose. Back on a kiosk means "leave the
                // board", and there is nothing behind it but the launcher.
                return true;
            default:
                return super.onKeyDown(keyCode, event);
        }
    }

    /** The WebView's Chrome version, which is what decides what the board can use. */
    private String engineVersion() {
        try {
            String agent = web.getSettings().getUserAgentString();
            java.util.regex.Matcher m =
                    java.util.regex.Pattern.compile("Chrome/(\\d+)").matcher(agent);
            return m.find() ? "Chrome/WebView " + m.group(1) : "unknown";
        } catch (Exception unknown) {
            return "unknown";
        }
    }

    private void openSettings() {
        startActivity(new Intent(this, SettingsActivity.class));
    }

    /**
     * Say what is actually wrong while waiting for it to fix itself.
     *
     * The embedded server takes a few seconds to come up on a cold ARMv7 box -
     * Python starts, packages import, the database opens - and during that
     * window the WebView cannot connect. That is normal and the message says
     * so, because "cannot reach the board" on a device that IS the board reads
     * like a broken install.
     *
     * A server that has actually failed is a different message with the Python
     * traceback in it, since on a TV there is no other way to see one.
     */
    private void showRetry() {
        loadFailed = true;
        int wait = RETRY_MS[Math.min(retryIndex, RETRY_MS.length - 1)];
        retryIndex++;

        String problem = ServerService.failureText();
        if (problem == null && lastConsoleError != null) {
            problem = "The page loaded but its scripts failed:\n\n"
                    + lastConsoleError
                    + "\n\nBrowser engine: " + engineVersion();
        }
        if (Kiosk.usesLocalBoard(this) && problem != null) {
            message.setText("The board could not start.\n\n" + problem
                    + "\n\nHold the top-left corner for two seconds to open "
                    + "the settings.");
        } else if (Kiosk.usesLocalBoard(this)) {
            message.setText("Starting the board…\n\n"
                    + "The first start after installing takes longer — Python "
                    + "and the board's data are being unpacked.");
        } else {
            message.setText("Cannot reach the board at\n" + Kiosk.boardUrl(this)
                    + "\n\nRetrying in " + (wait / 1000) + "s."
                    + "\n\nHold the top-left corner for two seconds,"
                    + "\nor press MENU on the remote, to change the address.");
        }
        message.setVisibility(View.VISIBLE);
        handler.postDelayed(() -> {
            loadFailed = false;
            web.loadUrl(Kiosk.boardUrl(this));
        }, wait);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
