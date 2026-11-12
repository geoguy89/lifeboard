package com.lifeboard.tv;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

/**
 * The LifeBoard server, running inside the app.
 *
 * WHY A FOREGROUND SERVICE AND NOT A THREAD IN THE ACTIVITY
 * ----------------------------------------------------------
 * A wall display is not always the thing on screen. A TV box shows its own
 * launcher when you press HOME, an OTA update dialog steals focus, somebody
 * switches to Netflix for an hour. A server living in the activity dies with
 * it, and the board comes back to an empty database connection and a port
 * nobody is listening on.
 *
 * A foreground service with a notification is the only arrangement Android
 * actually promises to keep alive. The notification is the price, and on a TV
 * nobody ever sees it.
 *
 * PYTHON STARTS ONCE PER PROCESS
 * -------------------------------
 * Chaquopy's interpreter cannot be started twice or stopped and restarted, so
 * this checks before starting and the service is sticky rather than being
 * torn down and recreated. Stopping the server means telling uvicorn to exit,
 * not unloading Python.
 */
public class ServerService extends Service {

    private static final String TAG = "LifeBoardServer";
    private static final String CHANNEL = "lifeboard-server";
    private static final int NOTIFICATION_ID = 1;

    public static final int PORT = 8080;

    private static volatile boolean starting = false;
    private static volatile boolean running = false;
    private static volatile String failure = null;

    private Thread worker;

    public static boolean isRunning() { return running; }
    public static String failureText() { return failure; }

    public static void start(Context context) {
        Intent intent = new Intent(context, ServerService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        startForeground(NOTIFICATION_ID, buildNotification("Starting the board…"));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!starting) {
            starting = true;
            worker = new Thread(this::runServer, "lifeboard-server");
            // Not a daemon: this thread IS the service's reason to exist, and
            // a daemon thread would be killed the moment everything else
            // finished, which on Android is any time at all.
            worker.start();
        }
        // START_STICKY: if Android reclaims the process under memory pressure,
        // bring it back. A board that vanishes at 3am and stays gone is the
        // failure this whole service exists to avoid.
        return START_STICKY;
    }

    private void runServer() {
        try {
            AssetInstaller.Layout layout = AssetInstaller.install(this);

            if (!Python.isStarted()) {
                Python.start(new AndroidPlatform(this));
            }
            Python python = Python.getInstance();
            PyObject module = python.getModule("lifeboard_android");

            notifyNow("The board is running on port " + PORT);
            running = true;

            Log.i(TAG, "starting uvicorn on " + PORT
                    + " (web=" + layout.web + ")");

            // Blocks until stop() is called or something throws.
            module.callAttr("start",
                    getFilesDir().getAbsolutePath(),
                    layout.web,
                    layout.templates,
                    PORT);

            Log.i(TAG, "server exited");
        } catch (Throwable problem) {
            // Everything, including Errors: an UnsatisfiedLinkError from a
            // missing ABI or an OutOfMemoryError during extraction both mean
            // "no board", and both have to reach the screen rather than
            // vanishing into logcat on a device with no logcat attached.
            failure = describe(problem);
            Log.e(TAG, "server failed", problem);
            notifyNow("The board could not start");
        } finally {
            running = false;
            starting = false;
        }
    }

    /** A message worth putting on a TV, not a stack trace. */
    private String describe(Throwable problem) {
        StringBuilder text = new StringBuilder();
        Throwable root = problem;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();
        text.append(root.getClass().getSimpleName());
        if (root.getMessage() != null) text.append(": ").append(root.getMessage());

        try {
            if (Python.isStarted()) {
                String pythonError = Python.getInstance()
                        .getModule("lifeboard_android")
                        .callAttr("last_error").toString();
                if (pythonError != null && !pythonError.isEmpty()) {
                    // The Python traceback is the useful half; the Java one is
                    // always the same two frames.
                    text.append("\n\n").append(tail(pythonError, 900));
                }
            }
        } catch (Throwable ignored) {
            // Reporting the failure must never fail.
        }
        return text.toString();
    }

    private static String tail(String text, int limit) {
        return text.length() <= limit ? text : text.substring(text.length() - limit);
    }

    /* --------------------------------------------------------- notification */

    private Notification buildNotification(String text) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL, "LifeBoard server", NotificationManager.IMPORTANCE_MIN);
            channel.setShowBadge(false);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }

        PendingIntent open = PendingIntent.getActivity(
                this, 0, new Intent(this, BoardActivity.class),
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        ? PendingIntent.FLAG_IMMUTABLE : 0);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return builder
                .setContentTitle("LifeBoard")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_upload)
                .setContentIntent(open)
                .setOngoing(true)
                .build();
    }

    private void notifyNow(String text) {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(text));
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
