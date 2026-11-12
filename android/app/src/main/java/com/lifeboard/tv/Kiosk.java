package com.lifeboard.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

/** Settings, and the fullscreen incantation, in one place. */
public final class Kiosk {

    private static final String PREFS = "lifeboard";
    public static final String KEY_URL = "board_url";
    public static final String KEY_ORIENTATION = "orientation";

    private Kiosk() {}

    public static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * The board this screen shows.
     *
     * Defaults to the server running inside this very app, because that is
     * what the app is for. Somebody who wants this to be a second screen for a
     * board on a Pi can point it there instead, and the embedded server keeps
     * running harmlessly - it is the same code either way, so nothing has to
     * be turned off.
     */
    public static String boardUrl(Context context) {
        return prefs(context).getString(KEY_URL, LOCAL_BOARD);
    }

    public static final String LOCAL_BOARD =
            "http://127.0.0.1:" + ServerService.PORT + "/render/";

    public static boolean usesLocalBoard(Context context) {
        return boardUrl(context).startsWith("http://127.0.0.1:")
                || boardUrl(context).startsWith("http://localhost:");
    }

    public static void setBoardUrl(Context context, String url) {
        prefs(context).edit().putString(KEY_URL, url.trim()).apply();
    }

    /** "auto" | "landscape" | "portrait" - a TV is landscape, a frame is not. */
    public static String orientation(Context context) {
        return prefs(context).getString(KEY_ORIENTATION, "landscape");
    }

    public static void setOrientation(Context context, String value) {
        prefs(context).edit().putString(KEY_ORIENTATION, value).apply();
    }

    /**
     * Hide everything the system would otherwise draw over the board.
     *
     * Re-applied on every focus change rather than once at startup, because
     * anything that steals focus - a notification, a USB dialog, the touch
     * frame being replugged - brings the navigation bar back with it and it
     * never leaves again on its own. On a wall display nobody is there to
     * swipe it away.
     */
    public static void goFullscreen(Window window) {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        View decor = window.getDecorView();
        int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
        decor.setSystemUiVisibility(flags);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Draw under a notch. A TV has none, but these boxes get flashed
            // onto tablets too and a black bar down one side looks broken.
            window.getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
    }
}
