package com.lifeboard.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Unpack the board's web files and templates where the server can read them.
 *
 * The server serves `web/` off the filesystem and reads `templates/` as JSON.
 * Android assets are inside the APK and are not a filesystem, so they have to
 * come out once.
 *
 * KEYED ON THE APP VERSION, NOT ON "DOES IT EXIST"
 * -------------------------------------------------
 * The obvious check - extract if the directory is missing - means an update
 * ships a new renderer that never lands, because the old one is still sitting
 * there. That is the same stale-artefact failure the .img builds kept hitting,
 * and it is worse here: the server would be new, the page old, and the symptom
 * a widget that silently does nothing.
 *
 * So the extracted copy carries the versionCode it came from, and anything
 * else triggers a clean re-extract.
 */
final class AssetInstaller {

    private static final String TAG = "LifeBoardAssets";
    private static final String KEY_VERSION = "assets_version";

    static final class Layout {
        final String web;
        final String templates;
        Layout(String web, String templates) {
            this.web = web;
            this.templates = templates;
        }
    }

    private AssetInstaller() {}

    static Layout install(Context context) throws IOException {
        File root = new File(context.getFilesDir(), "board");
        File web = new File(root, "web");
        File templates = new File(root, "templates");

        long version = versionCode(context);
        SharedPreferences prefs = Kiosk.prefs(context);
        boolean current = prefs.getLong(KEY_VERSION, -1) == version
                && web.isDirectory() && templates.isDirectory();

        if (!current) {
            Log.i(TAG, "extracting board assets for version " + version);
            deleteTree(root);
            AssetManager assets = context.getAssets();
            copyTree(assets, "web", web);
            copyTree(assets, "templates", templates);
            prefs.edit().putLong(KEY_VERSION, version).apply();
            Log.i(TAG, "extracted to " + root);
        }
        return new Layout(web.getAbsolutePath(), templates.getAbsolutePath());
    }

    private static long versionCode(Context context) {
        try {
            return context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0).versionCode;
        } catch (Exception unknown) {
            // Cannot read our own version: re-extract every start rather than
            // risk serving a stale renderer. Slower, never wrong.
            return System.currentTimeMillis();
        }
    }

    private static void copyTree(AssetManager assets, String path, File target)
            throws IOException {
        String[] children = assets.list(path);
        if (children == null || children.length == 0) {
            // A leaf. AssetManager cannot tell a file from an empty directory,
            // so the only way to find out is to try opening it.
            copyFile(assets, path, target);
            return;
        }
        if (!target.isDirectory() && !target.mkdirs()) {
            throw new IOException("cannot create " + target);
        }
        for (String child : children) {
            copyTree(assets, path + "/" + child, new File(target, child));
        }
    }

    private static void copyFile(AssetManager assets, String path, File target)
            throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("cannot create " + parent);
        }
        byte[] buffer = new byte[32 * 1024];
        try (InputStream in = assets.open(path);
             OutputStream out = new FileOutputStream(target)) {
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
        }
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        // Ignored deliberately: a file that will not delete is replaced by the
        // copy that follows, and refusing to start over one stale file would
        // be worse than the stale file.
        file.delete();
    }
}
