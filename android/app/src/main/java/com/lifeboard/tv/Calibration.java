package com.lifeboard.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Matrix;

/**
 * Lining a touch overlay up with the picture underneath it.
 *
 * WHY THIS EXISTS
 * ---------------
 * A TV with a touch frame bolted to it is two devices that have never been
 * introduced. The frame reports coordinates in its own space, and unless
 * somebody has told Android how that space maps onto the panel, touches land
 * somewhere near where you meant - offset by an inch, scaled wrong because the
 * frame is a different aspect to the picture, or with an axis inverted so the
 * board fights you.
 *
 * The system-wide fix is an input device configuration file in /system, which
 * needs root and a reboot. An app cannot do that. What an app CAN do is
 * correct the coordinates on their way into its own window, which for a kiosk
 * is the same thing: everything the user touches belongs to us.
 *
 * WHY AN AFFINE TRANSFORM AND NOT AN OFFSET
 * ------------------------------------------
 * An offset alone fixes a frame that is mounted slightly low. It does nothing
 * for the two faults that are actually common: a frame whose active area is a
 * different size to the picture (needs scale), and one mounted rotated or
 * wired with X and Y swapped (needs the cross terms). A full affine covers
 * offset, scale, skew, rotation and axis inversion in six numbers, and it is
 * still cheap enough to apply to every touch event.
 *
 *     corrected.x = a * raw.x + b * raw.y + c
 *     corrected.y = d * raw.x + e * raw.y + f
 *
 * It cannot fix barrel distortion or a frame that is physically bowed. Nothing
 * short of a per-region mesh can, and a touch frame that far out is a mounting
 * problem rather than a software one.
 *
 * FITTING
 * -------
 * Least squares over however many points were collected, rather than solving
 * exactly from three. A person aiming at a crosshair on a TV is a couple of
 * centimetres out on a bad day, and three points means that error becomes the
 * transform. Five points let the errors average out, and the residual is
 * reported so a bad run can be rejected rather than saved.
 */
public final class Calibration {

    /** Identity: raw coordinates pass through untouched. */
    private static final float[] IDENTITY = {1f, 0f, 0f, 0f, 1f, 0f};

    private static final String PREFS = "lifeboard";
    private static final String KEY = "calibration";
    private static final String KEY_ENABLED = "calibration_enabled";

    private Calibration() {}

    /* ------------------------------------------------------------ storing */

    public static float[] load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_ENABLED, false)) return IDENTITY.clone();
        String stored = prefs.getString(KEY, null);
        if (stored == null) return IDENTITY.clone();
        String[] parts = stored.split(",");
        if (parts.length != 6) return IDENTITY.clone();
        float[] out = new float[6];
        try {
            for (int i = 0; i < 6; i++) out[i] = Float.parseFloat(parts[i]);
        } catch (NumberFormatException bad) {
            return IDENTITY.clone();
        }
        return out;
    }

    public static void save(Context context, float[] coefficients) {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < 6; i++) {
            if (i > 0) text.append(',');
            text.append(coefficients[i]);
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY, text.toString())
                .putBoolean(KEY_ENABLED, true)
                .apply();
    }

    /** Back to raw touch. Kept separate from save() so "undo" is one call. */
    public static void clear(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_ENABLED, false)
                .remove(KEY)
                .apply();
    }

    public static boolean isCalibrated(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_ENABLED, false);
    }

    /** The six coefficients as a Matrix, for MotionEvent.transform(). */
    public static Matrix toMatrix(float[] c) {
        Matrix matrix = new Matrix();
        matrix.setValues(new float[] {
                c[0], c[1], c[2],
                c[3], c[4], c[5],
                0f,   0f,   1f,
        });
        return matrix;
    }

    /* ------------------------------------------------------------ fitting */

    /** What came out of a calibration run: the transform, and how good it is. */
    public static final class Fit {
        public final float[] coefficients;
        /** Mean distance in pixels between where they touched and the target. */
        public final double meanErrorPx;
        public final double worstErrorPx;
        public final String problem;   // null when usable

        Fit(float[] coefficients, double mean, double worst, String problem) {
            this.coefficients = coefficients;
            this.meanErrorPx = mean;
            this.worstErrorPx = worst;
            this.problem = problem;
        }

        public boolean ok() { return problem == null; }
    }

    /**
     * Fit raw touches to the targets they were aiming at.
     *
     * @param raw     where the frame said the finger was
     * @param target  where the crosshair actually was
     */
    public static Fit fit(float[][] raw, float[][] target) {
        int n = Math.min(raw.length, target.length);
        if (n < 3) {
            return new Fit(IDENTITY.clone(), 0, 0,
                    "Not enough points - at least three are needed.");
        }

        // Normal equations for the least-squares solve. Both axes share the
        // same 3x3 left-hand side because both are fitted against the same raw
        // coordinates; only the right-hand side differs.
        double[][] s = new double[3][3];
        double[] bx = new double[3];
        double[] by = new double[3];

        for (int i = 0; i < n; i++) {
            double x = raw[i][0], y = raw[i][1];
            double tx = target[i][0], ty = target[i][1];
            double[] row = {x, y, 1};
            for (int r = 0; r < 3; r++) {
                for (int c = 0; c < 3; c++) s[r][c] += row[r] * row[c];
                bx[r] += row[r] * tx;
                by[r] += row[r] * ty;
            }
        }

        double[] first = solve3(s, bx);
        double[] second = solve3(s, by);
        if (first == null || second == null) {
            // Singular: every point landed on one spot or one straight line,
            // which happens when somebody taps the same place five times to
            // get through it. Saving that transform would collapse the whole
            // screen to a point.
            return new Fit(IDENTITY.clone(), 0, 0,
                    "Those touches were all in a line or on the same spot. "
                    + "Aim at each cross in turn and try again.");
        }

        float[] c = {
                (float) first[0], (float) first[1], (float) first[2],
                (float) second[0], (float) second[1], (float) second[2],
        };

        // How far off each point still is once the fit is applied. A good run
        // on a 55" screen lands inside about 20px; 100px means somebody missed
        // a cross or the frame is not linear.
        double total = 0, worst = 0;
        for (int i = 0; i < n; i++) {
            double fx = c[0] * raw[i][0] + c[1] * raw[i][1] + c[2];
            double fy = c[3] * raw[i][0] + c[4] * raw[i][1] + c[5];
            double d = Math.hypot(fx - target[i][0], fy - target[i][1]);
            total += d;
            if (d > worst) worst = d;
        }
        double mean = total / n;

        String problem = null;
        double scaleX = Math.hypot(c[0], c[3]);
        double scaleY = Math.hypot(c[1], c[4]);
        if (scaleX < 0.2 || scaleX > 5 || scaleY < 0.2 || scaleY > 5) {
            // A sane frame is within a factor of two of the panel. Five times
            // out means the points were entered in the wrong order, or the
            // frame reported something absurd - either way, saving it would
            // make the board untouchable and the only way back would be to
            // clear the app's data.
            problem = "That produced an impossible mapping (the screen would be "
                    + "scaled " + Math.round(scaleX * 100) + "%). Try again, "
                    + "touching each cross in the order it appears.";
        }
        return new Fit(c, mean, worst, problem);
    }

    /** Gaussian elimination with partial pivoting. Null when singular. */
    private static double[] solve3(double[][] matrix, double[] rhs) {
        double[][] m = new double[3][4];
        for (int r = 0; r < 3; r++) {
            System.arraycopy(matrix[r], 0, m[r], 0, 3);
            m[r][3] = rhs[r];
        }
        for (int col = 0; col < 3; col++) {
            int pivot = col;
            for (int r = col + 1; r < 3; r++) {
                if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
            }
            // Scaled against the largest entry, so this does not call a
            // legitimately small-but-well-conditioned system singular.
            if (Math.abs(m[pivot][col]) < 1e-9) return null;
            double[] swap = m[col]; m[col] = m[pivot]; m[pivot] = swap;

            for (int r = 0; r < 3; r++) {
                if (r == col) continue;
                double factor = m[r][col] / m[col][col];
                for (int c = col; c < 4; c++) m[r][c] -= factor * m[col][c];
            }
        }
        return new double[] {
                m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2],
        };
    }
}
