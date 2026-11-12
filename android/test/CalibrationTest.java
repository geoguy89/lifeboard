import com.lifeboard.tv.Calibration;

/**
 * The calibration maths, run on a desktop JVM against simulated touch frames.
 *
 *   android/test.sh
 *
 * WHY THIS EXISTS
 * ---------------
 * The calibration is the one part of this app with real logic in it, and it is
 * also the part nobody can check by reading: a least-squares fit either
 * recovers the mapping or it does not, and the difference is invisible until
 * somebody is standing at a TV poking at a screen that will not do what they
 * want. So the frames are simulated here instead - each one a fault that
 * actually happens to touch overlays.
 *
 * `fit()` and the solver touch no Android classes, so they run on a plain JVM
 * with android.jar only on the classpath for compilation.
 *
 * The tolerance is in pixels on a nominal 1920x1080 panel. A person aiming at
 * a crosshair on a TV is a good centimetre out, which is why the simulated
 * touches carry noise: a fit that only works on perfect input is a fit that
 * will not survive its first real user.
 */
public class CalibrationTest {

    private static int failures = 0;
    private static final float W = 1920, H = 1080;

    /** The five targets CalibrationActivity draws, 10% in from each corner. */
    private static final float[][] TARGETS = {
            {W * 0.10f, H * 0.10f},
            {W * 0.90f, H * 0.10f},
            {W * 0.90f, H * 0.90f},
            {W * 0.10f, H * 0.90f},
            {W * 0.50f, H * 0.50f},
    };

    public static void main(String[] args) {
        // A frame that is simply mounted a bit low and to the left.
        check("offset only", frame(1, 0, -40, 0, 1, 25), 0);

        // A frame whose active area is bigger than the picture - very common,
        // because the overlay is sold for a size range rather than a panel.
        check("scaled", frame(1.08f, 0, -60, 0, 1.05f, -20), 0);

        // Wired with Y inverted. Nothing works, and it looks like the driver
        // is broken rather than like a calibration problem.
        check("Y inverted", frame(1, 0, 0, 0, -1, H), 0);

        // X and Y swapped: the board fights you, diagonally.
        check("axes swapped", frame(0, W / H, 0, H / W, 0, 0), 0);

        // Mounted a couple of degrees out of true, which is what happens when
        // a frame is taped on rather than bracketed.
        double t = Math.toRadians(2.5);
        check("rotated 2.5 degrees",
                frame((float) Math.cos(t), (float) -Math.sin(t), 30,
                      (float) Math.sin(t), (float) Math.cos(t), -15), 0);

        // The realistic one: scale, offset, a little rotation, and a person
        // who cannot hit a crosshair exactly.
        check("everything at once, with a shaky finger",
                frame(1.06f, -0.03f, -55, 0.02f, 1.04f, 30), 12);

        // ---- things that must be refused -------------------------------
        refused("all five taps in the same place",
                new float[][] {{500, 500}, {500, 500}, {500, 500}, {500, 500}, {500, 500}});

        refused("all five taps in a straight line",
                new float[][] {{100, 100}, {200, 200}, {300, 300}, {400, 400}, {500, 500}});

        // A frame reporting in its own tiny coordinate space, mapped wrongly,
        // would scale the screen by 20x. Saving that makes the app
        // untouchable and the only way back is clearing app data.
        refused("an absurd scale",
                new float[][] {{0, 0}, {96, 0}, {96, 54}, {0, 54}, {48, 27}});

        // Fewer points than an affine fit needs.
        Calibration.Fit thin = Calibration.fit(
                new float[][] {{0, 0}, {10, 10}},
                new float[][] {{0, 0}, {10, 10}});
        expect("two points is refused", !thin.ok(), thin.problem);

        // ---- the identity case, which must not be "corrected" ----------
        Calibration.Fit perfect = Calibration.fit(TARGETS, TARGETS);
        expect("a frame that is already right fits the identity",
                perfect.ok() && perfect.meanErrorPx < 0.5,
                "mean error " + perfect.meanErrorPx);

        if (failures > 0) {
            System.out.println();
            System.out.println(failures + " problem(s)");
            System.exit(1);
        }
        System.out.println("calibration: every simulated frame is recovered, and "
                + "the degenerate ones are refused");
    }

    /**
     * Simulate a touch frame with the given distortion, then check the fit
     * undoes it.
     *
     * @param noisePx how far the simulated finger misses each crosshair
     */
    private static void check(String name, float[][] raw, double noisePx) {
        if (noisePx > 0) raw = jitter(raw, noisePx);
        Calibration.Fit fit = Calibration.fit(raw, TARGETS);
        if (!fit.ok()) {
            fail(name + ": refused a valid frame - " + fit.problem);
            return;
        }

        // The fit is judged on points it has NEVER SEEN. Checking it against
        // its own calibration points only proves it can fit five points, which
        // any three-parameter model can do; what matters is whether a touch
        // somewhere else on the screen now lands correctly.
        double worst = 0;
        for (float fx = 0.05f; fx <= 0.95f; fx += 0.15f) {
            for (float fy = 0.05f; fy <= 0.95f; fy += 0.15f) {
                float wantX = W * fx, wantY = H * fy;
                float[] reported = distort(wantX, wantY, DISTORTION);
                float[] c = fit.coefficients;
                double gotX = c[0] * reported[0] + c[1] * reported[1] + c[2];
                double gotY = c[3] * reported[0] + c[4] * reported[1] + c[5];
                worst = Math.max(worst, Math.hypot(gotX - wantX, gotY - wantY));
            }
        }
        // Noise-free frames should be near exact; a shaky finger should still
        // land within a fingertip (~40px on a 1080p panel).
        double tolerance = noisePx > 0 ? 40 : 1.0;
        expect(name, worst <= tolerance,
                String.format("worst untouched-point error %.1fpx (allowed %.0f)",
                        worst, tolerance));
    }

    private static void refused(String name, float[][] raw) {
        Calibration.Fit fit = Calibration.fit(raw, TARGETS);
        expect(name + " is refused", !fit.ok(),
                fit.ok() ? "it was accepted" : fit.problem);
    }

    /* ---------------------------------------------------------- plumbing */

    private static float[] DISTORTION;

    /** Raw readings a frame with this distortion would report for the targets. */
    private static float[][] frame(float a, float b, float c, float d, float e, float f) {
        // The distortion maps TRUE position to what the frame REPORTS; the fit
        // has to recover its inverse. Storing it lets check() ask what the
        // frame would say about points that were never calibrated.
        DISTORTION = new float[] {a, b, c, d, e, f};
        float[][] raw = new float[TARGETS.length][2];
        for (int i = 0; i < TARGETS.length; i++) {
            raw[i] = distort(TARGETS[i][0], TARGETS[i][1], DISTORTION);
        }
        return raw;
    }

    private static float[] distort(float x, float y, float[] m) {
        return new float[] {
                m[0] * x + m[1] * y + m[2],
                m[3] * x + m[4] * y + m[5],
        };
    }

    /** A person aiming at a crosshair, repeatably. */
    private static float[][] jitter(float[][] points, double px) {
        java.util.Random random = new java.util.Random(20260908);
        float[][] out = new float[points.length][2];
        for (int i = 0; i < points.length; i++) {
            out[i][0] = points[i][0] + (float) ((random.nextDouble() - 0.5) * 2 * px);
            out[i][1] = points[i][1] + (float) ((random.nextDouble() - 0.5) * 2 * px);
        }
        return out;
    }

    private static void expect(String name, boolean ok, String detail) {
        if (ok) {
            System.out.println("  ok    " + name);
        } else {
            fail(name + " - " + detail);
        }
    }

    private static void fail(String message) {
        failures++;
        System.out.println("  FAIL  " + message);
    }
}
