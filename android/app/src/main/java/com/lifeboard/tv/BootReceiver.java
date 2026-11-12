package com.lifeboard.tv;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Come back on its own after a power cut.
 *
 * A wall display that needs somebody to find the app and tap it after every
 * outage is a wall display nobody trusts. The TV and the board are usually on
 * the same socket, so this happens more often than it sounds.
 *
 * Not guaranteed: since Android 10 a background app cannot always start an
 * activity, and several TV boxes ship their own "auto start" whitelist that
 * this has to be added to. When it does not fire, making this app the box's
 * HOME launcher is the reliable answer - see the README.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) return;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)
                && !"com.htc.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }
        // The server first and unconditionally. Even if the activity is
        // blocked from starting - which Android 10+ often does - a running
        // server means the board is reachable from a phone or laptop on the
        // network, so the box is not simply dead until somebody walks over to
        // it with a remote.
        ServerService.start(context);

        Intent board = new Intent(context, BoardActivity.class);
        board.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(board);
        } catch (Exception blocked) {
            // Android 10+ background-start restriction, or an OEM whitelist.
            // Nothing useful to do from here; the README says what to do.
        }
    }
}
