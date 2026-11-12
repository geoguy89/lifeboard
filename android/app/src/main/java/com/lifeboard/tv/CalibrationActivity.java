package com.lifeboard.tv;

import android.app.Activity;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.Bundle;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;

/**
 * Touch each cross in turn, and the board learns where your finger really is.
 *
 * TWO THINGS THIS SCREEN MUST NOT DO
 * -----------------------------------
 * 1. It must not apply the existing calibration. It is measuring RAW input;
 *    correcting it first would fit a transform on top of a transform and the
 *    second run would be worse than the first. So this activity reads
 *    onTouchEvent directly and BoardActivity's transform never touches it.
 *
 * 2. It must not trap somebody. A calibration bad enough to make the screen
 *    unusable is exactly the one you cannot tap your way out of - so every
 *    escape here works from a remote as well as a finger, there is a verify
 *    step before anything is saved, and a wildly wrong fit is refused rather
 *    than stored.
 *
 * The targets sit 10% in from each corner rather than in them. A touch frame
 * is least accurate at its extreme edges, and a fit anchored on its worst
 * readings is a worse fit everywhere else. The centre point is what catches a
 * frame whose axes are swapped, since the four corners alone are symmetric
 * enough to fit plausibly with X and Y exchanged.
 */
public class CalibrationActivity extends Activity {

    private static final float INSET = 0.10f;
    private static final int SETTLE_MS = 220;

    private CalibrationView view;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        Kiosk.goFullscreen(getWindow());
        view = new CalibrationView(this);
        setContentView(view);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) Kiosk.goFullscreen(getWindow());
    }

    /** The whole screen: targets, instructions, and the result. */
    private final class CalibrationView extends View {

        private static final int COLLECTING = 0, CHECKING = 1, DONE = 2;

        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final float[][] raw = new float[5][2];
        private final float[][] targets = new float[5][2];

        private int stage = COLLECTING;
        private int index = 0;
        private long lastTouchAt = 0;
        private Calibration.Fit fit;
        private float checkX = -1, checkY = -1, checkErr = -1;

        CalibrationView(Context context) {
            super(context);
            setFocusable(true);
            setFocusableInTouchMode(true);
        }

        @Override
        protected void onSizeChanged(int w, int h, int oldW, int oldH) {
            super.onSizeChanged(w, h, oldW, oldH);
            float left = w * INSET, right = w * (1 - INSET);
            float top = h * INSET, bottom = h * (1 - INSET);
            targets[0] = new float[] {left, top};
            targets[1] = new float[] {right, top};
            targets[2] = new float[] {right, bottom};
            targets[3] = new float[] {left, bottom};
            targets[4] = new float[] {w / 2f, h / 2f};
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            if (event.getActionMasked() != MotionEvent.ACTION_DOWN) return true;

            // A touch frame often reports a burst of contacts for one press,
            // and a stray second one would silently consume the next target -
            // so the user would be told to touch five crosses and only ever
            // see three.
            long now = System.currentTimeMillis();
            if (now - lastTouchAt < SETTLE_MS) return true;
            lastTouchAt = now;

            float x = event.getX(), y = event.getY();

            if (stage == COLLECTING) {
                raw[index][0] = x;
                raw[index][1] = y;
                index++;
                if (index >= targets.length) {
                    fit = Calibration.fit(raw, targets);
                    stage = fit.ok() ? CHECKING : DONE;
                }
                invalidate();
                return true;
            }

            if (stage == CHECKING) {
                // Show where the corrected touch lands against where they
                // actually pressed. A number in pixels means nothing to most
                // people; a cross that sits under their fingertip does.
                float[] c = fit.coefficients;
                checkX = c[0] * x + c[1] * y + c[2];
                checkY = c[3] * x + c[4] * y + c[5];
                checkErr = (float) Math.hypot(checkX - x, checkY - y);
                invalidate();
                return true;
            }
            return true;
        }

        /** Remote and keyboard, because a bad calibration cannot be tapped out of. */
        @Override
        public boolean onKeyDown(int keyCode, android.view.KeyEvent event) {
            switch (keyCode) {
                case android.view.KeyEvent.KEYCODE_DPAD_CENTER:
                case android.view.KeyEvent.KEYCODE_ENTER:
                case android.view.KeyEvent.KEYCODE_BUTTON_A:
                    if (stage == CHECKING && fit != null && fit.ok()) {
                        Calibration.save(getContext(), fit.coefficients);
                        finish();
                        return true;
                    }
                    restart();
                    return true;
                case android.view.KeyEvent.KEYCODE_BACK:
                case android.view.KeyEvent.KEYCODE_ESCAPE:
                    finish();
                    return true;
                case android.view.KeyEvent.KEYCODE_DEL:
                    Calibration.clear(getContext());
                    finish();
                    return true;
                default:
                    return super.onKeyDown(keyCode, event);
            }
        }

        private void restart() {
            stage = COLLECTING;
            index = 0;
            fit = null;
            checkX = checkY = -1;
            checkErr = -1;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            canvas.drawColor(Color.parseColor("#0b0d11"));
            float w = getWidth(), h = getHeight();
            float unit = Math.min(w, h) / 100f;

            if (stage == COLLECTING) {
                drawTarget(canvas, targets[index][0], targets[index][1], unit);
                // Ghosts of the ones already done, so somebody who looks away
                // can see how far through they are without counting.
                paint.setStyle(Paint.Style.FILL);
                paint.setColor(Color.parseColor("#3a4250"));
                for (int i = 0; i < index; i++) {
                    canvas.drawCircle(targets[i][0], targets[i][1], unit * 1.1f, paint);
                }
                text(canvas, w / 2, h / 2 - unit * 9,
                        "Touch the cross", unit * 4.2f, "#ffffff");
                text(canvas, w / 2, h / 2 - unit * 3.4f,
                        (index + 1) + " of " + targets.length, unit * 2.8f, "#8b93a1");
                text(canvas, w / 2, h - unit * 5,
                        "Use a fingertip, not a knuckle. Back to cancel.",
                        unit * 2.2f, "#666e7d");
                return;
            }

            if (stage == CHECKING) {
                text(canvas, w / 2, h * 0.30f, "Now check it", unit * 4.2f, "#ffffff");
                text(canvas, w / 2, h * 0.30f + unit * 5.2f,
                        "Touch anywhere. The circle should land under your finger.",
                        unit * 2.4f, "#8b93a1");

                if (checkX >= 0) {
                    paint.setStyle(Paint.Style.STROKE);
                    paint.setStrokeWidth(unit * 0.5f);
                    boolean close = checkErr < unit * 4;
                    paint.setColor(Color.parseColor(close ? "#7fb069" : "#d9a06b"));
                    canvas.drawCircle(checkX, checkY, unit * 3.2f, paint);
                    canvas.drawLine(checkX - unit * 5, checkY, checkX + unit * 5, checkY, paint);
                    canvas.drawLine(checkX, checkY - unit * 5, checkX, checkY + unit * 5, paint);
                }

                String quality = fit.meanErrorPx < unit * 2 ? "Good"
                        : fit.meanErrorPx < unit * 5 ? "Usable"
                        : "Poor - worth redoing";
                text(canvas, w / 2, h * 0.72f,
                        quality + "  (average " + Math.round(fit.meanErrorPx)
                        + "px out, worst " + Math.round(fit.worstErrorPx) + "px)",
                        unit * 2.6f, fit.meanErrorPx < unit * 5 ? "#7fb069" : "#d9a06b");
                text(canvas, w / 2, h * 0.72f + unit * 5f,
                        "OK / Enter on the remote to save · any other key to redo",
                        unit * 2.3f, "#8b93a1");
                text(canvas, w / 2, h - unit * 5,
                        "Back to leave it as it was",
                        unit * 2.2f, "#666e7d");
                return;
            }

            // Refused.
            text(canvas, w / 2, h * 0.42f, "That did not work", unit * 4f, "#d98b8b");
            wrapped(canvas, w / 2, h * 0.42f + unit * 6f, w * 0.7f,
                    fit == null ? "No usable points." : fit.problem, unit * 2.5f, "#c9ced8");
            text(canvas, w / 2, h - unit * 5,
                    "Any key to try again · Back to leave it as it was",
                    unit * 2.2f, "#666e7d");
        }

        private void drawTarget(Canvas canvas, float x, float y, float unit) {
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(unit * 0.45f);
            paint.setColor(Color.parseColor("#5b9dd9"));
            canvas.drawCircle(x, y, unit * 4f, paint);
            canvas.drawLine(x - unit * 7, y, x + unit * 7, y, paint);
            canvas.drawLine(x, y - unit * 7, x, y + unit * 7, paint);
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(Color.WHITE);
            canvas.drawCircle(x, y, unit * 0.9f, paint);
        }

        private void text(Canvas canvas, float cx, float cy, String s, float size, String colour) {
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(Color.parseColor(colour));
            paint.setTextSize(size);
            paint.setTextAlign(Paint.Align.CENTER);
            canvas.drawText(s, cx, cy, paint);
        }

        /** Crude word wrap - the failure message is the only thing long enough. */
        private void wrapped(Canvas canvas, float cx, float cy, float maxWidth,
                             String s, float size, String colour) {
            paint.setTextSize(size);
            String[] words = s.split(" ");
            StringBuilder line = new StringBuilder();
            float y = cy;
            for (String word : words) {
                String attempt = line.length() == 0 ? word : line + " " + word;
                if (paint.measureText(attempt) > maxWidth && line.length() > 0) {
                    text(canvas, cx, y, line.toString(), size, colour);
                    y += size * 1.35f;
                    line = new StringBuilder(word);
                } else {
                    line = new StringBuilder(attempt);
                }
            }
            if (line.length() > 0) text(canvas, cx, y, line.toString(), size, colour);
        }
    }
}
